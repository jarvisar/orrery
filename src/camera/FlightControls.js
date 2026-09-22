/**
 * Free-flight camera controls.
 *
 * A rewrite of the old vendored `FlyControls`, which had accumulated a few
 * problems: it defined `keyup` twice so the first definition was dead, it kept
 * its key and pointer listeners attached whether or not flight was active (so
 * pressing W while merely orbiting silently wound the throttle up), it wrote
 * directly into a specific DOM element by id, and the `enabled` flag callers set
 * on it was never a property it actually read.
 *
 * This version attaches its listeners only while enabled, keeps all state
 * internal, and exposes readings for the HUD rather than touching the document.
 */

import * as THREE from 'three';

const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/** Fraction of the half-screen around the centre that does not steer at all. */
const DEAD_ZONE = 0.06;

export class FlightControls {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} domElement
   */
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;

    this.enabled = false;

    /** Units per second at full throttle. */
    this.maxSpeed = 2600;
    /** Multiplier while boost is held. */
    this.boostFactor = 6;
    /** Radians per second at full deflection. */
    this.turnRate = 0.9;
    this.rollRate = 1.6;
    /** How quickly steering input catches up to the pointer, per second. */
    this.smoothing = 6;
    /** How quickly the throttle ramps, in units of full throttle per second. */
    this.throttleRate = 0.55;

    this.throttle = 0;
    this.speed = 0;

    this._keys = new Set();
    this._pointer = new THREE.Vector2();
    this._steer = new THREE.Vector2();
    this._boost = false;
    this._pointerActive = false;

    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerLeave = () => { this._pointerActive = false; this._pointer.set(0, 0); };
    this._onBlur = () => this._releaseAll();
    this._onContextMenu = (e) => e.preventDefault();
  }

  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this._connect();
    else this._disconnect();
  }

  _connect() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this.domElement.addEventListener('pointermove', this._onPointerMove);
    this.domElement.addEventListener('pointerleave', this._onPointerLeave);
    this.domElement.addEventListener('contextmenu', this._onContextMenu);
  }

  _disconnect() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.domElement.removeEventListener('pointermove', this._onPointerMove);
    this.domElement.removeEventListener('pointerleave', this._onPointerLeave);
    this.domElement.removeEventListener('contextmenu', this._onContextMenu);
    this._releaseAll();
  }

  _releaseAll() {
    this._keys.clear();
    this._boost = false;
    this._steer.set(0, 0);
    this._pointer.set(0, 0);
    this._pointerActive = false;
  }

  _handleKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTypingTarget(event.target)) return;

    this._keys.add(event.code);
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') this._boost = true;
    if (event.code === 'Space') {
      this.throttle = 0;
      event.preventDefault();
    }
  }

  _handleKeyUp(event) {
    this._keys.delete(event.code);
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') this._boost = false;
  }

  _handlePointerMove(event) {
    const rect = this.domElement.getBoundingClientRect();
    this._pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      ((event.clientY - rect.top) / rect.height) * 2 - 1
    );
    this._pointerActive = true;
  }

  /** Steering input for the HUD reticle, in normalised screen space. */
  get steering() {
    return this._steer;
  }

  update(dt) {
    if (!this.enabled) return;
    const step = Math.min(dt, 0.1); // a backgrounded tab must not teleport the camera

    if (this._keys.has('KeyW')) this.throttle += this.throttleRate * step;
    if (this._keys.has('KeyS')) this.throttle -= this.throttleRate * step;
    this.throttle = THREE.MathUtils.clamp(this.throttle, -0.3, 1);

    // Ease the raw pointer position into the steering vector so a flick of the
    // mouse does not snap the nose across the sky.
    const target = this._pointerActive ? this._pointer : ZERO;
    const blend = 1 - Math.exp(-this.smoothing * step);
    this._steer.x += (applyCurve(target.x) - this._steer.x) * blend;
    this._steer.y += (applyCurve(target.y) - this._steer.y) * blend;

    let roll = 0;
    if (this._keys.has('KeyA')) roll += 1;
    if (this._keys.has('KeyD')) roll -= 1;

    _euler.set(
      -this._steer.y * this.turnRate * step,
      -this._steer.x * this.turnRate * step,
      roll * this.rollRate * step,
      'YXZ'
    );
    _quaternion.setFromEuler(_euler);
    this.camera.quaternion.multiply(_quaternion);

    this.speed = this.throttle * this.maxSpeed * (this._boost ? this.boostFactor : 1);
    this.camera.translateZ(-this.speed * step);
  }

  /** Nudges the throttle, for the on-screen buttons. */
  adjustThrottle(amount) {
    this.throttle = THREE.MathUtils.clamp(this.throttle + amount, -0.3, 1);
  }

  reset() {
    this.throttle = 0;
    this.speed = 0;
    this._releaseAll();
  }

  dispose() {
    this._disconnect();
  }
}

const ZERO = new THREE.Vector2(0, 0);

/**
 * Dead zone plus a cubic response. Small deflections stay small, which is what
 * makes it possible to line up on a planet instead of wobbling past it.
 */
function applyCurve(value) {
  const magnitude = Math.abs(value);
  if (magnitude < DEAD_ZONE) return 0;
  const scaled = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
  return Math.sign(value) * scaled ** 2;
}

function isTypingTarget(target) {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}
