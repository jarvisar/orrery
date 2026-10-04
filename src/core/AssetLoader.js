/**
 * Texture and model loading.
 *
 * 1. Priority. Only the Sun, the planets and the sky block the loading screen.
 *    Moons, dwarf planets and bump maps stream in afterwards. Focusing a body
 *    promotes its textures to the front of the queue.
 *
 * 2. Placeholders. Every optional map slot starts with a 1x1 texture, so the
 *    material compiles once with its final features and swapping in the real
 *    image is a plain upload, never a shader recompile.
 *
 * 3. Paced GPU uploads. Images are decoded off the main thread and uploaded a
 *    few rows at a time each frame. A material only gets its texture once all
 *    of it is on the GPU, so no draw call uploads (or decodes) mid-frame.
 *
 *    Images decode to ImageBitmaps, pre-flipped for WebGL. Uploading an <img>
 *    flips and converts every pixel on the main thread: 55-170ms for a 2k map
 *    in headless Chrome, against 5-13ms from an ImageBitmap. Even that drops
 *    frames on a phone. With the CPU slowed to phone speed, a whole 2k map held
 *    the main thread for 36ms, and 512KB strips of it took about 1ms each.
 *
 * 4. Released images. Once a map is on the GPU its decoded copy is freed: a 2k
 *    map is 8MB decoded, and all of them together hold on to over 250MB that a
 *    phone cannot spare. three would upload them again from that copy if the
 *    WebGL context were lost. They are fetched and decoded again instead.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TEXTURE_DIR = 'public/textures/';
const MODEL_DIR = 'public/models/';

/** Map slots whose contents are color and therefore need sRGB decoding. */
const COLOR_SLOTS = new Set(['map', 'emissiveMap']);

/**
 * Decoded as WebGL would upload an <img> with three's defaults: flipped, alpha
 * left straight, and no color-profile conversion (three asks for none either,
 * for color and data maps alike).
 */
const BITMAP_OPTIONS = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };

/**
 * Streamed uploads go in strips of about this many bytes, as many as fit in
 * UPLOAD_MS of a frame and always at least one. Past about 1MB a strip costs
 * more than its share, since the browser has to wait for its GPU process.
 */
const STRIP_BYTES = 512 * 1024;
const UPLOAD_MS = 2;

const _region = new THREE.Box2();
const _offset = new THREE.Vector2();

export class AssetLoader {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.textures = new Map();
    this.models = new Map();

    this._textureLoader = new THREE.TextureLoader();
    this._gltfLoader = new GLTFLoader();
    this._maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    /** @type {Array<{name:string,slot:string,priority:number,resolve:Function}>} */
    this._queue = [];
    /** @type {Map<string, Promise<THREE.Texture>>} */
    this._requests = new Map();
    this._inFlight = new Set();
    this._uploadQueue = [];
    this._draining = false;
    /** Uploaded textures whose decoded image has been freed. */
    this._released = new Set();

    this.placeholders = {
      white: makeSolidTexture(255, 255, 255),
      grey: makeSolidTexture(128, 128, 128),
      black: makeSolidTexture(0, 0, 0),
      clear: makeSolidTexture(0, 0, 0, 0),
    };

    // After three's own handler, which has by then forgotten every upload.
    renderer.domElement.addEventListener('webglcontextrestored', () => this._restore());
  }

  placeholderFor(slot) {
    if (slot === 'bumpMap' || slot === 'displacementMap') return this.placeholders.grey;
    // So an unloaded night side stays dark rather than flashing white.
    if (slot === 'emissiveMap') return this.placeholders.black;
    return this.placeholders.white;
  }

  /**
   * Requests a texture. Returns a promise that resolves with the texture, or
   * with a placeholder if it fails. It never rejects.
   *
   * @param {string} name   Manifest stem, e.g. 'europa_bump'.
   * @param {string} slot   Material slot it will occupy, which decides color space.
   * @param {number} priority Lower numbers load first.
   * @param {object} [options]
   * @param {boolean} [options.keepImage] Keep the decoded image once uploaded,
   *   for a texture that's read again later. The sky redraws its cube map from
   *   it after a lost context.
   */
  texture(name, slot = 'map', priority = 10, { keepImage = false } = {}) {
    const known = this._requests.get(name);
    if (known) {
      const queued = this._queue.find((t) => t.name === name);
      if (queued) queued.priority = Math.min(queued.priority, priority);
      return known;
    }

    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    this._requests.set(name, promise);
    this._queue.push({ name, slot, priority, keepImage, resolve });
    return promise;
  }

  /** Moves still-queued textures up the queue. Returns whether any changed. */
  promote(names, priority = -5) {
    let changed = false;
    for (const name of names) {
      const entry = this._queue.find((t) => t.name === name);
      if (entry && entry.priority > priority) {
        entry.priority = priority;
        changed = true;
      }
    }
    return changed;
  }

  /** Textures still queued, decoding or uploading. */
  get pending() {
    return this._queue.length + this._inFlight.size + this._uploadQueue.length;
  }

  /**
   * Works the queue until nothing eligible is left.
   *
   * @param {object} [options]
   * @param {number} [options.concurrency] How many decodes to keep in flight.
   * @param {number} [options.maxPriority] Only load jobs at or below this
   *   priority. The rest stay queued.
   * @param {(loaded:number, total:number, name:string) => void} [options.onProgress]
   */
  async drain({ concurrency = 6, maxPriority = Infinity, onProgress } = {}) {
    if (this._draining) return;
    this._draining = true;

    const eligible = () => this._queue.filter((job) => job.priority <= maxPriority);
    const total = eligible().length;
    let loaded = 0;

    try {
      while (eligible().length || this._inFlight.size) {
        while (this._inFlight.size < concurrency) {
          // Re-sort every time: a promote() during loading takes effect immediately.
          this._queue.sort((a, b) => a.priority - b.priority);
          const index = this._queue.findIndex((job) => job.priority <= maxPriority);
          if (index < 0) break;

          const [job] = this._queue.splice(index, 1);
          this._inFlight.add(job.name);

          this._loadTexture(job)
            .then(() => {
              loaded++;
              onProgress?.(loaded, Math.max(total, loaded), job.name);
            })
            .finally(() => this._inFlight.delete(job.name));
        }
        await frame();
      }
    } finally {
      this._draining = false;
    }
  }

  async _loadTexture(job) {
    const { name, slot, keepImage, resolve } = job;
    try {
      const url = `${TEXTURE_DIR}${await resolveFile(name)}`;
      const texture = await this._decode(url);

      texture.name = name;
      texture.userData = { url, slot, keepImage };
      texture.colorSpace = COLOR_SLOTS.has(slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = this._maxAnisotropy;

      if (name === 'saturn_rings') {
        // A 1-pixel-tall radial strip. Mipmaps stop the Cassini division
        // crawling when seen near edge-on. Clamping stops the outer edge
        // bleeding into the inner.
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
      } else {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
      }

      this.textures.set(name, texture);
      // Resolved by pumpUploads(), once the texture is on the GPU.
      this._uploadQueue.push({ texture, resolve, row: 0 });
    } catch (err) {
      console.warn(`[assets] texture "${name}" failed to load`, err);
      const fallback = this.placeholderFor(slot);
      this.textures.set(name, fallback);
      resolve(fallback);
    }
  }

  async _decode(url) {
    if (BITMAPS_WORK) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bitmap = await createImageBitmap(await response.blob(), BITMAP_OPTIONS);
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false; // done while decoding
      texture.needsUpdate = true;
      return texture;
    }
    const texture = await this._textureLoader.loadAsync(url);
    // Otherwise the browser decodes lazily inside texImage2D: tens of ms for a
    // 2k map on a phone. decode() does it ahead of time, off the main thread.
    await texture.image.decode?.().catch(() => {});
    return texture;
  }

  /** Loads a .glb. The promise is cached, so concurrent requests fetch once. */
  model(name) {
    if (!this.models.has(name)) {
      this.models.set(name, this._gltfLoader.loadAsync(`${MODEL_DIR}${name}.glb`).then((gltf) => {
        gltf.scene.traverse((child) => {
          if (!child.isMesh) return;
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.material?.map) child.material.map.anisotropy = this._maxAnisotropy;
        });
        return gltf.scene;
      }));
    }
    return this.models.get(name);
  }

  /**
   * Uploads decoded textures and resolves each request once its texture is
   * fully on the GPU. Called once per frame, to upload a strip or a few.
   * With `ms` set to Infinity it uploads everything queued in one go, which is
   * quicker overall and is what the loading screen uses. Returns whether it
   * uploaded anything.
   *
   * @param {number} [ms] How long to keep uploading strips for after the first.
   */
  pumpUploads(ms = UPLOAD_MS) {
    const start = performance.now();
    let uploaded = false;
    while (this._uploadQueue.length) {
      const job = this._uploadQueue[0];
      let done = true;
      try {
        done = ms === Infinity ? this._uploadWhole(job) : this._uploadStrip(job);
      } catch {
        // E.g. context loss. The first draw that uses it uploads it whole instead.
        job.texture.source.dataReady = true;
        job.texture.needsUpdate = true;
      }
      uploaded = true;
      if (done) {
        this._uploadQueue.shift();
        job.resolve(job.texture);
      }
      if (performance.now() - start >= ms) break;
    }
    return uploaded;
  }

  _uploadWhole({ texture }) {
    this.renderer.initTexture(texture);
    this._release(texture);
    return true;
  }

  /**
   * Uploads the next strip of a texture's rows. Returns true once it's all
   * there. The first call also sets aside empty storage, and three builds
   * (empty) mipmaps for it then. The last strip builds them again from the image.
   */
  _uploadStrip(job) {
    const { texture } = job;
    const { image } = texture;
    // Only an ImageBitmap can be read out in strips. A small one might as well go whole.
    if (typeof ImageBitmap === 'undefined' || !(image instanceof ImageBitmap) ||
        image.width * image.height * 4 <= STRIP_BYTES) return this._uploadWhole(job);

    if (job.row === 0) {
      texture.source.dataReady = false;
      this.renderer.initTexture(texture);
      texture.source.dataReady = true;
      // What the strips are read from. It's never uploaded, so three copies
      // from its image instead of from the GPU.
      job.source = new THREE.Texture(image);
      job.mipmaps = texture.generateMipmaps;
    }

    const { width, height } = image;
    const top = job.row;
    const bottom = Math.min(height, top + Math.max(1, Math.floor(STRIP_BYTES / (width * 4))));
    const last = bottom === height;
    // copyTextureToTexture rebuilds the mipmaps after every copy unless told not to.
    texture.generateMipmaps = last && job.mipmaps;
    _region.min.set(0, top);
    _region.max.set(width, bottom);
    this.renderer.copyTextureToTexture(job.source, texture, _region, _offset.set(0, top));
    texture.generateMipmaps = job.mipmaps;
    job.row = bottom;

    if (last) this._release(texture);
    return last;
  }

  /**
   * Frees an uploaded texture's decoded image. See the note at the top of this
   * file. Its size stays behind, which is all three reads of it from then on.
   */
  _release(texture) {
    const { image, userData } = texture;
    if (userData.keepImage || typeof ImageBitmap === 'undefined' || !(image instanceof ImageBitmap)) return;
    texture.image = { width: image.width, height: image.height };
    image.close();
    this._released.add(texture);
  }

  /**
   * A lost context has come back, and three will upload every texture again on
   * first use. A released one gets blank storage of its size (dataReady) until
   * its image is fetched and decoded again, and is then filled in place. The
   * HTTP or offline cache usually has the image.
   */
  _restore() {
    for (const texture of this._released) {
      texture.source.dataReady = false;
      texture.needsUpdate = true;
      this._decode(texture.userData.url).then((fresh) => {
        const { width, height } = texture.image;
        // Changed on the server meanwhile: three needs new storage for it.
        if (fresh.image.width !== width || fresh.image.height !== height) texture.dispose();
        texture.image = fresh.image;
        texture.source.dataReady = true;
        texture.needsUpdate = true;
        this._uploadQueue.push({ texture, resolve: () => {}, row: 0 });
      }).catch((err) => console.warn(`[assets] texture "${texture.name}" failed to reload`, err));
    }
    this._released.clear();
  }

  /**
   * Uploads every texture a material in the scene holds, shown or not: a
   * model's own, and those drawn on a canvas. Otherwise each uploads mid-frame
   * the first time its object comes into view. Already uploaded ones cost
   * nothing.
   */
  uploadSceneTextures(scene) {
    const textures = new Set();
    scene.traverse((object) => {
      for (const material of [object.material ?? []].flat()) {
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
        for (const uniform of Object.values(material.uniforms ?? {})) {
          if (uniform?.value?.isTexture) textures.add(uniform.value);
        }
      }
    });
    for (const texture of textures) {
      try {
        this.renderer.initTexture(texture);
      } catch {
        // Uploaded on first use instead, as it would have been.
      }
    }
  }

  dispose() {
    for (const texture of this.textures.values()) texture.dispose();
    for (const placeholder of Object.values(this.placeholders)) placeholder.dispose();
    this.textures.clear();
    this._requests.clear();
    this.models.clear();
  }
}

/** Maps a stem to its filename: color maps are .webp, single-channel data maps .jpg. */
let manifestPromise = null;
async function loadManifest() {
  manifestPromise ??= fetch(`${TEXTURE_DIR}manifest.json`).then((r) => r.json());
  return manifestPromise;
}

async function resolveFile(name) {
  const manifest = await loadManifest();
  const entry = manifest[name];
  if (!entry) throw new Error(`"${name}" is not in the texture manifest`);
  return entry.file;
}

/**
 * Whether createImageBitmap honors the options above (the same test as three's
 * GLTFLoader): Safari < 17 and Firefox < 98 lack it or ignore the flip.
 */
const BITMAPS_WORK = (() => {
  if (typeof createImageBitmap === 'undefined') return false;
  const agent = navigator.userAgent;
  const safari = /^((?!chrome|android).)*safari/i.test(agent);
  const safariVersion = Number(agent.match(/Version\/(\d+)/)?.[1] ?? -1);
  const firefoxVersion = Number(agent.match(/Firefox\/(\d+)\./)?.[1] ?? -1);
  if (safari && safariVersion < 17) return false;
  if (agent.includes('Firefox') && firefoxVersion < 98) return false;
  return true;
})();

function makeSolidTexture(r, g, b, a = 255) {
  const data = new Uint8Array([r, g, b, a]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
