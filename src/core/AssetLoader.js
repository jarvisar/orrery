/**
 * Texture and model loading.
 *
 * 1. Priority. Only the Sun, the planets and the sky block the loading screen;
 *    moons, dwarf planets and bump maps stream in afterwards. Focusing a body
 *    promotes its textures to the front of the queue.
 *
 * 2. Placeholders. Every optional map slot starts with a 1x1 texture, so the
 *    material compiles once with its final features and swapping in the real
 *    image is a plain upload, never a shader recompile.
 *
 * 3. Paced GPU uploads. Images are decoded off the main thread and uploaded one
 *    per frame via `renderer.initTexture`; a material only gets its texture once
 *    uploaded, so no draw call uploads (or decodes) mid-frame.
 *
 *    Images decode to ImageBitmaps, pre-flipped for WebGL. Uploading an <img>
 *    flips and converts every pixel on the main thread: 55-170ms for a 2k map
 *    in headless Chrome, against 5-13ms from an ImageBitmap.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TEXTURE_DIR = 'public/textures/';
const MODEL_DIR = 'public/models/';

/** Map slots whose contents are colour and therefore need sRGB decoding. */
const COLOR_SLOTS = new Set(['map', 'emissiveMap']);

/**
 * Decoded as WebGL would upload an <img> with three's defaults: flipped, alpha
 * left straight, and no colour-profile conversion (three asks for none either,
 * for colour and data maps alike).
 */
const BITMAP_OPTIONS = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };

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

    this.placeholders = {
      white: makeSolidTexture(255, 255, 255),
      grey: makeSolidTexture(128, 128, 128),
      black: makeSolidTexture(0, 0, 0),
      clear: makeSolidTexture(0, 0, 0, 0),
    };
  }

  placeholderFor(slot) {
    if (slot === 'bumpMap' || slot === 'displacementMap') return this.placeholders.grey;
    // So an unloaded night side stays dark rather than flashing white.
    if (slot === 'emissiveMap') return this.placeholders.black;
    return this.placeholders.white;
  }

  /**
   * Requests a texture. Returns a promise that resolves with the texture, or
   * with a placeholder if it fails - it never rejects.
   *
   * @param {string} name   Manifest stem, e.g. 'europa_bump'.
   * @param {string} slot   Material slot it will occupy, which decides colour space.
   * @param {number} priority Lower numbers load first.
   */
  texture(name, slot = 'map', priority = 10) {
    const known = this._requests.get(name);
    if (known) {
      const queued = this._queue.find((t) => t.name === name);
      if (queued) queued.priority = Math.min(queued.priority, priority);
      return known;
    }

    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    this._requests.set(name, promise);
    this._queue.push({ name, slot, priority, resolve });
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
   *   priority; the rest stay queued.
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
    const { name, slot, resolve } = job;
    try {
      const url = `${TEXTURE_DIR}${await resolveFile(name)}`;
      const texture = await this._decode(url);

      texture.name = name;
      texture.colorSpace = COLOR_SLOTS.has(slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = this._maxAnisotropy;

      if (name === 'saturn_rings') {
        // A 1-pixel-tall radial strip. Mipmaps stop the Cassini division
        // crawling when seen near edge-on; clamping stops the outer edge
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
      this._uploadQueue.push({ texture, resolve });
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

  /** Loads a .glb; the promise is cached, so concurrent requests fetch once. */
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
   * Uploads up to `budget` decoded textures and resolves their requests.
   * Called once per frame with a budget of one. Returns how many it uploaded.
   */
  pumpUploads(budget = 1) {
    let uploaded = 0;
    for (let i = 0; i < budget && this._uploadQueue.length; i++, uploaded++) {
      const { texture, resolve } = this._uploadQueue.shift();
      try {
        this.renderer.initTexture(texture);
      } catch {
        // E.g. context loss; the first draw that uses it will upload it instead.
      }
      resolve(texture);
    }
    return uploaded;
  }

  dispose() {
    for (const texture of this.textures.values()) texture.dispose();
    for (const placeholder of Object.values(this.placeholders)) placeholder.dispose();
    this.textures.clear();
    this._requests.clear();
    this.models.clear();
  }
}

/** Maps a stem to its filename: colour maps are .webp, single-channel data maps .jpg. */
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
 * Whether createImageBitmap honours the options above (the same test as three's
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
