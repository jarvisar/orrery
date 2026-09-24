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
 * The top rung, on displays where it is worth having, is full resolution with
 * multisampling; the first step down keeps every pixel and drops the
 * multisampling, which costs less to look at than any cut in resolution.
 *
 * Every change of scale reallocates the canvas and the post-processing targets,
 * which is itself a hitch - so the controller is built to change scale rarely.
 * A struggling device drops straight to the rung that fits rather than walking
 * down one step every couple of seconds, and a rung that has already proven too
 * slow is not retried for a while, so a borderline device settles instead of
 * see-sawing between two sizes forever.
 *
 * It also has to tell a slow GPU from everything else that makes frames late.
 * A step down is kept only if frames actually got quicker: a phone holding the
 * page to 30fps to save battery, or a frame rate set by work on the CPU, looks
 * slow at any resolution, and blurring the scene would buy nothing. And frames
 * that uploaded a texture are left out of the count altogether, or the
 * streaming that follows the loading screen would read as a weak GPU.
 */

import * as THREE from 'three';
import { sceneRadius } from '../scene/scaling.js';

/**
 * Render scales, as fractions of native density. Each rung sheds roughly a
 * quarter to a third of the pixels of the one above it.
 */
const LADDER = [1, 0.85, 0.7, 0.6, 0.5, 0.4, 0.33];

/**
 * Densest a display is rendered at. Phones report anything from 2.6 to 4, and
 * rendering a 3x phone at 3x costs 2.25 times the pixels of 2x for a
 * difference nobody sees at arm's length - which is why capping at 2 is the
 * standard advice for three.js on mobile.
 */
const MAX_DENSITY = 2;

/**
 * Multisampling the HDR frame is the top rung only on displays up to this
 * density. Each pixel then carries four half-float colours and depths, which
 * a phone's GPU writes out to memory and reads back to resolve: the most
 * bandwidth-hungry step in the frame. On a denser screen the scene is drawn
 * below the display's own density and scaled up, which softens the edges
 * anyway.
 */
const MULTISAMPLE_MAX_DENSITY = 2;
/** Roughly what multisampling adds to a whole frame, as measured; only used to judge how far to step down. */
const MULTISAMPLE_COST = 1.3;

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
    /** Whether the post-processing target is multisampled. See {@link Viewport#ladder}. */
    this.multisample = this.multisampleAvailable;
    this.adaptiveResolution = true;
    /**
     * Set, for good, once the lowest rung is still too slow. Whatever else can
     * be shed has to come from somewhere other than resolution.
     */
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

  /** Whether this display gets a multisampled top rung. */
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

    // Resize events arrive in pairs (resize and orientationchange) and for
    // changes that do not alter the canvas at all. Setting the canvas size -
    // even to what it already is - throws away the drawing buffer, and every
    // listener reallocates its render targets, so do nothing unless something
    // actually changed.
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

  /**
   * Leaves the next frame interval out of the count. For frames that did
   * something expensive that is not drawing, such as uploading a texture:
   * their lateness says nothing about the resolution.
   */
  discardNextSample() {
    this._discard = true;
  }

  /**
   * Feeds the interval that has just ended into the resolution controller.
   * Judges the median of about a second of frames, so a single hitch - a GC
   * pause, a shader compiling - does not drag the whole scene down a notch.
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

    // Keep the last step down only if it bought frame time. If it did not,
    // something other than pixels is setting the pace; put them back, and
    // leave the resolution alone for a while.
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
