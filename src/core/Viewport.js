/**
 * Renderer, camera and adaptive resolution.
 *
 * A controller watches the real interval between frames and moves along a
 * ladder of render scales: down when the GPU cannot keep up, back up one rung
 * at a time when there is headroom. Where worth having, the top rung is full
 * resolution with multisampling, and the first step down drops only the MSAA.
 *
 * Each change reallocates the canvas and post targets (a hitch), so it changes
 * rarely: it drops straight to the rung expected to fit, and does not retry a
 * rung that proved too slow for a while, so a borderline device does not
 * see-saw. A step down is kept only if frames actually got quicker (a battery-
 * capped phone or CPU-bound frame is slow at any resolution), and frames that
 * uploaded a texture are not counted.
 */

import * as THREE from 'three';
import { sceneRadius } from '../scene/scaling.js';

/**
 * Render scales, as fractions of native density. Each rung sheds roughly a
 * quarter to a third of the pixels of the one above it.
 */
const LADDER = [1, 0.85, 0.7, 0.6, 0.5, 0.4, 0.33];

/**
 * Densest a display is rendered at. Phones report 2.6 to 4, and 3x costs 2.25
 * times the pixels of 2x for no visible difference at arm's length.
 */
const MAX_DENSITY = 2;

/**
 * Multisampling the HDR frame is the top rung only up to this density. 4x
 * half-float MSAA is the most bandwidth-hungry step on a phone GPU, and a denser
 * screen is drawn below its own density and upscaled, which softens edges anyway.
 */
const MULTISAMPLE_MAX_DENSITY = 2;
/** Roughly what multisampling adds to a whole frame, as measured; only used to judge how far to step down. */
const MULTISAMPLE_COST = 1.3;

/**
 * The ladder stops at the page's CSS resolution (1x) or, on a display that is
 * already 1x, at this fraction of it.
 */
const MIN_SCALE_AT_1X = 0.55;

/**
 * Frame-interval thresholds in ms. Vsync pins the real gap near 16.7ms on a
 * healthy 60Hz display, so "fast" sits just above that, not below it.
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

/** A step down that leaves frames at least this fraction as long did not help. */
const NO_GAIN = 0.85;
/** How long to leave the resolution alone after that, doubling each time. */
const HOLD_MS = 30_000;
const MAX_HOLD_MS = 240_000;

export class Viewport {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // The scene spans a 3-unit moon to a 78,000-unit orbit; only a
      // logarithmic depth buffer avoids z-fighting at that range.
      logarithmicDepthBuffer: true,
      stencil: false,
    });

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // AgX rolls bright colour off toward white; ACES pushes it toward saturated
    // orange, which turns the Sun into a ball of cheese.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // The frame is several passes; count the whole frame, not the last pass.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, sceneRadius());

    this.renderScale = LADDER[0];
    /** Whether the post-processing target is multisampled. See {@link Viewport#ladder}. */
    this.multisample = this.multisampleAvailable;
    this.adaptiveResolution = true;
    /** Set for good once even the lowest rung is too slow. */
    this.constrained = false;

    this._frameTimes = [];
    this._windowStart = 0;
    this._lastAdjust = 0;
    /** Cost of the cheapest rung that has proven too slow, and until when to believe it. */
    this._ceiling = Infinity;
    this._ceilingUntil = 0;
    this._retryMs = RETRY_MS;
    /** The last step down, until the frames after it show whether it helped. */
    this._trial = null;
    this._holdUntil = 0;
    this._holdMs = HOLD_MS;
    this._discard = false;

    this._applied = { width: 0, height: 0, pixelRatio: 0, multisample: null };
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

  get multisampleAvailable() {
    return (window.devicePixelRatio || 1) <= MULTISAMPLE_MAX_DENSITY;
  }

  /** The rungs this display can use, highest first, as {scale, multisample}. */
  get ladder() {
    const native = this.nativePixelRatio;
    const floor = Math.min(1, native * MIN_SCALE_AT_1X);
    // A hair of tolerance, so 2x at 0.5 still counts as reaching 1x.
    const rungs = LADDER
      .filter((scale) => native * scale >= floor * 0.98)
      .map((scale) => ({ scale, multisample: false }));
    if (this.multisampleAvailable) rungs.unshift({ scale: 1, multisample: true });
    return rungs;
  }

  resize() {
    // While a headset is presenting, three owns the drawing buffer and puts the
    // page's size back itself when the session ends.
    if (this.renderer.xr.isPresenting) return;

    const width = this.width;
    const height = this.height;
    const pixelRatio = this.nativePixelRatio * this.renderScale;
    // Moved to a denser screen, where the top rung has no multisampling.
    if (this.multisample && !this.multisampleAvailable) this.multisample = false;

    // Resize events arrive in pairs and for changes that do not alter the
    // canvas. Setting the canvas size, even to the same value, throws away the
    // drawing buffer and makes every listener reallocate, so skip no-ops.
    const applied = this._applied;
    if (applied.width === width && applied.height === height && applied.pixelRatio === pixelRatio &&
        applied.multisample === this.multisample) return;
    applied.width = width;
    applied.height = height;
    applied.pixelRatio = pixelRatio;
    applied.multisample = this.multisample;

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

  /** Leaves the next frame interval out of the count, e.g. after a texture upload. */
  discardNextSample() {
    this._discard = true;
  }

  /**
   * Feeds the interval that has just ended into the resolution controller.
   * Judges the median of about a second of frames, so a single hitch (GC, a
   * shader compiling) does not force a step down.
   */
  sample(frameMs) {
    if (!this.adaptiveResolution || this.renderer.xr.isPresenting) return;
    if (this._discard) {
      this._discard = false;
      return;
    }

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

    // A step down that bought no frame time means something other than pixels
    // sets the pace: undo it and leave the resolution alone for a while.
    const trial = this._trial;
    this._trial = null;
    if (trial && median > trial.median * NO_GAIN) {
      this._ceiling = Infinity;
      this._holdUntil = now + this._holdMs;
      this._holdMs = Math.min(this._holdMs * 2, MAX_HOLD_MS);
      this._apply(trial.from, now);
      return;
    }

    let next = index;
    if (median > SLOW_MS) {
      if (now < this._holdUntil) return;
      // Pixel cost goes with the square of the scale. Drop to the highest rung
      // expected to fit, and always at least one.
      const cost = rungCost(ladder[index]);
      next = Math.min(index + 1, ladder.length - 1);
      while (next < ladder.length - 1 && median * (rungCost(ladder[next]) / cost) > TARGET_MS) next++;

      if (next === index) {
        this._constrain();
      } else {
        this._ceiling = cost;
        this._ceilingUntil = now + this._retryMs;
        this._retryMs = Math.min(this._retryMs * 2, MAX_RETRY_MS);
        this._trial = { from: ladder[index], median };
      }
    } else if (median < FAST_MS && index > 0) {
      const blocked = rungCost(ladder[index - 1]) >= this._ceiling && now < this._ceilingUntil;
      if (!blocked) next = index - 1;
    }

    if (next !== index) this._apply(ladder[next], now);
  }

  _apply(rung, now) {
    this.renderScale = rung.scale;
    this.multisample = rung.multisample;
    this._lastAdjust = now;
    this.resize();
  }

  /** Where the current settings sit on the ladder: that rung, or the nearest one below. */
  _rungIndex(ladder) {
    const exact = ladder.findIndex((rung) =>
      Math.abs(rung.scale - this.renderScale) < 1e-6 && rung.multisample === this.multisample);
    if (exact >= 0) return exact;
    const below = ladder.findIndex((rung) => rung.scale <= this.renderScale + 1e-6 && !rung.multisample);
    return below < 0 ? ladder.length - 1 : below;
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
    this._trial = null;
    if (!enabled) {
      this.renderScale = LADDER[0];
      this.multisample = this.multisampleAvailable;
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

/** A rung's cost relative to full resolution without multisampling. */
function rungCost(rung) {
  return rung.scale ** 2 * (rung.multisample ? MULTISAMPLE_COST : 1);
}
