/**
 * Camera behaviour: what it is looking at, and how it gets there.
 *
 * Two things the previous version got wrong are fixed here.
 *
 * Following. It lerped the orbit target toward the planet but left the camera
 * where it was, so a moving planet slid away from the centre of the screen and
 * the camera had to chase it forever. Here the camera is translated by the same
 * delta the body moved, which makes a focused body genuinely stationary in view
 * while the rest of the system moves around it.
 *
 * Framing. Distance was a hardcoded constant, so the Sun and Deimos were
 * approached from the same range. Framing distance now falls out of the body's
 * own radius and the camera's field of view.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** How many body radii of empty space to leave around a framed body. */
const FRAMING = 2.6;

/** Seconds a focus change takes. */
const TRANSITION_SECONDS = 1.4;

const _delta = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _offset = new THREE.Vector3();

export class CameraDirector {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   * @param {import('../scene/SolarSystem.js').SolarSystem} system
   */
  constructor(camera, domElement, system) {
    this.camera = camera;
    this.system = system;

    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.7;
    this.controls.screenSpacePanning = true;
    this.controls.maxDistance = 2_000_000;

    /** @type {import('../scene/SolarSystem.js').BodyView|null} */
    this.focus = null;
    this._lastFocusPosition = new THREE.Vector3();
    this._transition = null;
  }

  /** Distance at which a body of this size fills a comfortable share of the frame. */
  framingDistance(view) {
    const extent = Math.max(view.boundingRadius, view.radius);
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    return (extent * FRAMING) / Math.tan(halfFov);
  }

  /**
   * Points the camera at a body, flying there over {@link TRANSITION_SECONDS}.
   * Passing `null` releases the camera into free view without moving it.
   */
  focusOn(view, { instant = false } = {}) {
    this.focus = view;

    if (!view) {
      this._transition = null;
      this.controls.enabled = true;
      return;
    }

    const distance = this.framingDistance(view);
    this.controls.minDistance = view.radius * 1.15;

    // Approach along the current viewing direction where that is meaningful, so
    // the camera does not swing wildly around the system on every selection.
    _offset.copy(this.camera.position).sub(this.controls.target);
    if (_offset.lengthSq() < 1e-6) _offset.set(0.45, 0.32, 1).normalize();
    _offset.normalize().multiplyScalar(distance);

    if (instant) {
      this.controls.target.copy(view.group.position);
      this.camera.position.copy(view.group.position).add(_offset);
      this._transition = null;
    } else {
      this._transition = {
        elapsed: 0,
        duration: TRANSITION_SECONDS,
        fromTarget: this.controls.target.clone(),
        fromPosition: this.camera.position.clone(),
        offset: _offset.clone(),
      };
    }

    this._lastFocusPosition.copy(view.group.position);
  }

  /** True while a focus transition is still playing. */
  get isTransitioning() {
    return this._transition !== null;
  }

  update(dt) {
    if (this.focus) {
      if (this._transition) this._advanceTransition(dt);
      else this._follow();
    }

    this.controls.update();
    this._updateClipping();
  }

  _advanceTransition(dt) {
    const t = this._transition;
    t.elapsed += dt;
    const k = easeInOutCubic(Math.min(1, t.elapsed / t.duration));

    _desired.copy(this.focus.group.position);
    this.controls.target.lerpVectors(t.fromTarget, _desired, k);
    this.camera.position.lerpVectors(t.fromPosition, _desired.clone().add(t.offset), k);

    if (t.elapsed >= t.duration) {
      this._transition = null;
      this._lastFocusPosition.copy(this.focus.group.position);
    }
  }

  /**
   * Carries the camera along with the body it is watching. Without this the
   * body drifts out of frame at any non-trivial time rate.
   */
  _follow() {
    _delta.copy(this.focus.group.position).sub(this._lastFocusPosition);
    this.camera.position.add(_delta);
    this.controls.target.add(_delta);
    this._lastFocusPosition.copy(this.focus.group.position);
  }

  /**
   * Pulls the near plane in as you approach a surface.
   *
   * A fixed near plane either clips the surface you are trying to land on or
   * throws away depth precision everywhere else. Scaling it with the distance
   * to whatever you are looking at gets both.
   */
  _updateClipping() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = THREE.MathUtils.clamp(distance * 0.002, 0.02, 50);
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.15) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Nearest body to a world position; used when leaving flight mode. */
  nearestBody(position) {
    let best = null;
    let bestDistance = Infinity;
    for (const view of this.system.bodies.values()) {
      if (!view.visible) continue;
      const distance = position.distanceTo(view.group.position);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = view;
      }
    }
    return best;
  }

  setEnabled(enabled) {
    this.controls.enabled = enabled;
  }

  dispose() {
    this.controls.dispose();
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
