/**
 * Texture and model loading, with three things the old loader did not do.
 *
 * 1. Priority. Only the Sun, the eight planets and the sky block the loading
 *    screen. Moons, dwarf planets and every bump map stream in afterwards while
 *    the user is already flying around. Focusing a body promotes its textures to
 *    the front of the queue.
 *
 * 2. Placeholders that keep the shader stable. Every optional map slot starts
 *    life holding a 1x1 texture, so the material compiles once with its final
 *    set of features. Swapping in the real image later is a plain texture upload
 *    - it never triggers a shader recompile, which is what used to lock the tab
 *    for a second the first time you looked at a planet.
 *
 * 3. Paced GPU uploads. Images are decoded off the main thread, then pushed to
 *    the GPU one per frame via `renderer.initTexture`. A texture is only handed
 *    to the material that asked for it once it is uploaded, so no draw call
 *    ever finds itself uploading - and decoding - a texture mid-frame. That
 *    used to happen whenever a moon's maps arrived while it was on screen.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TEXTURE_DIR = 'public/textures/';
const MODEL_DIR = 'public/models/';

/** Map slots whose contents are colour and therefore need sRGB decoding. */
const COLOR_SLOTS = new Set(['map', 'emissiveMap']);

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

  /** A 1x1 stand-in with the right colour space for a given map slot. */
  placeholderFor(slot) {
    if (slot === 'bumpMap' || slot === 'displacementMap') return this.placeholders.grey;
    // Black stands in for an emissive map so an unloaded night side stays dark
    // rather than flashing white before the real texture lands.
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
    // Every request for a name shares one promise, whether the texture is
    // queued, decoding or already done.
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

  /**
   * Raises the priority of not-yet-loaded textures so they jump the queue.
   * Used when focusing a body whose detail maps are still streaming.
   */
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

  /** How many textures are still queued, decoding or uploading. Shown in the stats readout. */
  get pending() {
    return this._queue.length + this._inFlight.size + this._uploadQueue.length;
  }

  /**
   * Works the queue until nothing eligible is left.
   *
   * @param {object} [options]
   * @param {number} [options.concurrency] How many decodes to keep in flight.
   *   Browsers cap connections per origin anyway; 6 keeps the pipe full without
   *   starving the main thread of decode slots.
   * @param {number} [options.maxPriority] Only load jobs at or below this
   *   priority. This is what keeps moons and detail maps out of the initial
   *   load while still queueing them up front.
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
      const texture = await this._textureLoader.loadAsync(url);
      // Left to itself the browser decodes an image lazily, synchronously,
      // inside the texImage2D call that uploads it: tens of milliseconds for a
      // 2k map on a phone, charged to whichever frame did the upload. decode()
      // does it on another thread, ahead of time.
      await texture.image.decode?.().catch(() => {});

      texture.name = name;
      texture.colorSpace = COLOR_SLOTS.has(slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = this._maxAnisotropy;

      if (name === 'saturn_rings') {
        // A 1-pixel-tall radial strip. It needs mipmaps - seen near edge-on the
        // radial axis is minified hard, and without them the Cassini division
        // turns into crawling noise - but it must not wrap, or the outer edge
        // of the rings bleeds into the inner.
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

  /**
   * Loads a .glb and caches the parsed scene. The promise is what gets cached,
   * so a model the scene and the loading screen both ask for is fetched once.
   */
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
   * Pushes decoded textures to the GPU and hands them to whoever asked. Called
   * once per frame with a budget of one; uploading everything in one go is
   * exactly the stall we are avoiding.
   */
  pumpUploads(budget = 1) {
    for (let i = 0; i < budget && this._uploadQueue.length; i++) {
      const { texture, resolve } = this._uploadQueue.shift();
      try {
        this.renderer.initTexture(texture);
      } catch {
        // A context loss mid-upload is not worth taking the frame down for;
        // the first draw that uses the texture will upload it instead.
      }
      resolve(texture);
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

/**
 * The manifest maps a stem to its actual filename, because colour maps ended up
 * as .webp and single-channel data maps as .jpg.
 */
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

function makeSolidTexture(r, g, b, a = 255) {
  const data = new Uint8Array([r, g, b, a]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
