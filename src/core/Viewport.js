/**
 * Renderer, camera and the resolution policy.
 *
 * Adaptive resolution is the interesting part: rather than picking a fixed
 * pixel ratio and hoping, it watches a rolling median frame time and walks the
 * render scale down when the GPU is struggling and back up when it is not. A
 * laptop on integrated graphics ends up rendering at 70% scale and holding 60fps
 * instead of rendering at native and delivering 30.
 */

import * as THREE from 'three';
import { sceneRadius } from '../scene/scaling.js';

/** Render scale is never allowed outside this range. */
const MIN_SCALE = 0.55;
const MAX_SCALE = 1;

/**
 * Frame-interval thresholds in milliseconds. These are compared against the
 * real gap between frames, which vsync pins near 16.7ms on a healthy 60Hz
 * display - so "fast" has to sit just above that, not below it.
 */
const SLOW_MS = 22;
const FAST_MS = 17.5;

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

    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderScale = MAX_SCALE;
    this.adaptiveResolution = true;

    this._frameTimes = [];
    this._lastAdjust = 0;
    this._resizeListeners = [];
    this._onResize = () => this.resize();

    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    this.resize();
  }

  get width() { return this.canvas.clientWidth || window.innerWidth; }
  get height() { return this.canvas.clientHeight || window.innerHeight; }

  resize() {
    const width = this.width;
    const height = this.height;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(this.maxPixelRatio * this.renderScale);
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

  get pixelRatio() {
    return this.renderer.getPixelRatio();
  }

  drawingBufferSize() {
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    return size;
  }

  /**
   * Feeds a frame interval into the resolution controller. Uses the median of
   * the last 60 frames so a single hitch - a texture upload, a GC pause - does
   * not drag the whole scene down a notch.
   */
  sample(frameMs) {
    if (!this.adaptiveResolution) return;

    this._frameTimes.push(frameMs);
    if (this._frameTimes.length < 60) return;

    const median = [...this._frameTimes].sort((a, b) => a - b)[30];
    this._frameTimes.length = 0;

    const now = performance.now();
    if (now - this._lastAdjust < 1500) return;

    let next = this.renderScale;
    if (median > SLOW_MS) next = Math.max(MIN_SCALE, this.renderScale - 0.1);
    else if (median < FAST_MS) next = Math.min(MAX_SCALE, this.renderScale + 0.05);

    if (Math.abs(next - this.renderScale) > 0.001) {
      this.renderScale = next;
      this._lastAdjust = now;
      this.resize();
    }
  }

  setAdaptiveResolution(enabled) {
    this.adaptiveResolution = enabled;
    if (!enabled) {
      this.renderScale = MAX_SCALE;
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
