/**
 * Renderer, camera and the resolution policy.
 *
 * Adaptive resolution is the interesting part. The scene starts at the
 * display's native pixel density and a controller watches the real interval
 * between frames. When the GPU cannot keep up it steps down a fixed ladder of
 * render scales; when there is headroom it climbs back, one rung at a time. A
 * laptop on integrated graphics ends up rendering at 70% and holding 60fps
 * instead of rendering at native and delivering 30.
 *
 * Every change of scale reallocates the canvas and the post-processing targets,
 * which is itself a hitch - so the controller is built to change scale rarely.
 * A struggling device drops straight to the rung that fits rather than walking
 * down one step every couple of seconds, and a rung that has already proven too
 * slow is not retried for a while, so a borderline device settles instead of
 * see-sawing between two sizes forever.
 */

import * as THREE from 'three';
import { sceneRadius } from '../scene/scaling.js';

/**
 * Render scales, as fractions of native density. Each rung sheds roughly a
 * quarter to a third of the pixels of the one above it.
 */
const LADDER = [1, 0.85, 0.7, 0.6, 0.5, 0.4, 0.33];

/**
 * Densest a display is rendered at. Some phones report 3.5 or 4, where the
 * extra pixels are all cost and no visible gain.
 */
const MAX_DENSITY = 3;

/**
 * The ladder stops at whichever comes first: the page's own CSS resolution -
 * no sharper display is ever rendered blurrier than an ordinary web page - or,
 * on a display that is already 1x, just over half of it.
 */
const MIN_SCALE_AT_1X = 0.55;

/**
 * Frame-interval thresholds in milliseconds. These are compared against the
 * real gap between frames, which vsync pins near 16.7ms on a healthy 60Hz
 * display - so "fast" has to sit just above that, not below it.
 */
const TARGET_MS = 16.7;
const SLOW_MS = 22;
const FAST_MS = 17.5;

/** Frames are judged in windows of at least this long and this many frames. */
const WINDOW_MS = 1000;
const WINDOW_FRAMES = 10;

/** Minimum gap between two changes of scale. */
const SETTLE_MS = 1500;

/** How long a rung that proved too slow is left alone, doubling on each failure. */
const RETRY_MS = 15_000;
const MAX_RETRY_MS = 120_000;

export class Viewport {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // The scene spans six orders of magnitude, from a 3-unit moon to a
      // 78,000-unit orbit. A logarithmic depth buffer is the only thing that
      // keeps near geometry from z-fighting at that range.
      logarithmicDepthBuffer: true,
      stencil: false,
    });

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // AgX rolls bright colour off toward white the way film does, where ACES
    // pushes it toward saturated orange - which is what used to turn the Sun
    // into a ball of cheese.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // The frame is several passes now; count the whole frame, not the last pass.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, sceneRadius());

    this.renderScale = LADDER[0];
    this.adaptiveResolution = true;
    /**
     * Set, for good, once the lowest rung is still too slow. Whatever else can
     * be shed has to come from somewhere other than resolution.
     */
    this.constrained = false;

    this._frameTimes = [];
    this._windowStart = 0;
    this._lastAdjust = 0;
    /** Lowest rung that has proven too slow, and until when to believe it. */
    this._ceiling = Infinity;
    this._ceilingUntil = 0;
    this._retryMs = RETRY_MS;

    this._applied = { width: 0, height: 0, pixelRatio: 0 };
    this._resizeListeners = [];
    this._constrainedListeners = [];
    this._onResize = () => this.resize();

    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    this.resize();
  }

  get width() { return this.canvas.clientWidth || window.innerWidth; }
  get height() { return this.canvas.clientHeight || window.innerHeight; }

  /** The display's own density, capped. Read live: browser zoom changes it. */
  get nativePixelRatio() {
    return Math.min(window.devicePixelRatio || 1, MAX_DENSITY);
  }

  /** The rungs this display can use, highest first. */
  get ladder() {
    const native = this.nativePixelRatio;
    const floor = Math.min(1, native * MIN_SCALE_AT_1X);
    // A hair of tolerance, so 3x at 0.33 still counts as reaching 1x.
    return LADDER.filter((scale) => native * scale >= floor * 0.98);
  }

  resize() {
    const width = this.width;
    const height = this.height;
    const pixelRatio = this.nativePixelRatio * this.renderScale;

    // Resize events arrive in pairs (resize and orientationchange) and for
    // changes that do not alter the canvas at all. Setting the canvas size -
    // even to what it already is - throws away the drawing buffer, and every
    // listener reallocates its render targets, so do nothing unless something
    // actually changed.
    const applied = this._applied;
    if (applied.width === width && applied.height === height && applied.pixelRatio === pixelRatio) return;
    applied.width = width;
    applied.height = height;
    applied.pixelRatio = pixelRatio;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    const buffer = this.drawingBufferSize();
    for (const listener of this._resizeListeners) listener(buffer, this);
  }

  /**
   * Calls back now and on every resize or render-scale change, with the
   * drawing-buffer size and this viewport.
   */
  onResize(callback) {
    this._resizeListeners.push(callback);
    callback(this.drawingBufferSize(), this);
  }

  /** Calls back once, if the lowest rung turns out to be too slow as well. */
  onConstrained(callback) {
    if (this.constrained) callback();
    else this._constrainedListeners.push(callback);
  }

  get pixelRatio() {
    return this.renderer.getPixelRatio();
  }

  drawingBufferSize() {
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    return size;
  }

  /**
   * Feeds a frame interval into the resolution controller. Judges the median
   * of about a second of frames, so a single hitch - a texture upload, a GC
   * pause - does not drag the whole scene down a notch.
   */
  sample(frameMs) {
    if (!this.adaptiveResolution) return;

    const now = performance.now();
    if (this._frameTimes.length === 0) this._windowStart = now;
    this._frameTimes.push(frameMs);
    if (this._frameTimes.length < WINDOW_FRAMES || now - this._windowStart < WINDOW_MS) return;

    const sorted = this._frameTimes.sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this._frameTimes.length = 0;

    if (now - this._lastAdjust < SETTLE_MS) return;

    const ladder = this.ladder;
    const index = this._rungIndex(ladder);
    let next = index;

    if (median > SLOW_MS) {
      // Pixel cost goes with the square of the scale. Drop to the highest rung
      // expected to fit, and always at least one.
      const current = ladder[index];
      next = Math.min(index + 1, ladder.length - 1);
      while (next < ladder.length - 1 && median * (ladder[next] / current) ** 2 > TARGET_MS) next++;

      if (next === index) {
        this._constrain();
      } else {
        this._ceiling = current;
        this._ceilingUntil = now + this._retryMs;
        this._retryMs = Math.min(this._retryMs * 2, MAX_RETRY_MS);
      }
    } else if (median < FAST_MS && index > 0) {
      const above = ladder[index - 1];
      const blocked = above >= this._ceiling && now < this._ceilingUntil;
      if (!blocked) next = index - 1;
    }

    if (next !== index) {
      this.renderScale = ladder[next];
      this._lastAdjust = now;
      this.resize();
    }
  }

  /** Where the current scale sits on the ladder: the nearest rung at or below it. */
  _rungIndex(ladder) {
    const index = ladder.findIndex((scale) => scale <= this.renderScale + 1e-6);
    return index < 0 ? ladder.length - 1 : index;
  }

  _constrain() {
    if (this.constrained) return;
    this.constrained = true;
    for (const listener of this._constrainedListeners) listener();
    this._constrainedListeners.length = 0;
  }

  setAdaptiveResolution(enabled) {
    this.adaptiveResolution = enabled;
    this._frameTimes.length = 0;
    if (!enabled) {
      this.renderScale = LADDER[0];
      this.resize();
    }
  }

  setShadowsEnabled(enabled) {
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.needsUpdate = true;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this.renderer.dispose();
  }
}
