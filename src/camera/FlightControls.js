/**
 * Free-flight camera controls: arcade flying, not a simulator.
 *
 * Three ideas keep it easy to fly in a solar system this compressed:
 *
 *   - Speed follows altitude. Full throttle covers roughly your height above the
 *     nearest surface each second, so the same throttle crosses an inter-planet
 *     gap in seconds and still lets you creep up to a moon without overshooting.
 *   - Near a body you move with it, so a planet does not slide away from under
 *     you while time is running.
 *   - Surfaces are solid. Fly into one and you skim along it.
 *
 * On top of that there is an optional destination and an autopilot that turns
 * towards it, flies there and parks a few radii out. Touching the controls
 * takes over from it at once.
 *
 * Steering is a virtual stick. With a mouse the pointer is captured and moving
 * it pushes the stick, which drifts back to centre on its own, so it feels like
 * mouse-look with a little weight. With a finger (or a mouse where capture is
 * unavailable) the stick is wherever the drag started. A game controller's
 * left stick is a stick already, and adds straight in.
 *
 * Listeners are attached only while enabled.
 */

import * as THREE from 'three';
import { systemRadius } from '../scene/scaling.js';

const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _toCamera = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _toTarget = new THREE.Vector3();

/** Small stick deflections that do nothing at all. */
const DEAD_ZONE = 0.04;
/** Pixels of drag, from where the finger went down, for full deflection. */
const STICK_RADIUS = 70;
/** Pixels of captured mouse movement for full deflection. */
const MOUSE_TRAVEL = 220;
/** How fast a captured mouse's stick drifts back to centre, per second. */
const RECENTER = 3;
/** Full-throttle speed as a multiple of altitude, per second. */
const APPROACH = 0.9;
/** Slowest full-throttle speed, in units per second, right at a surface. */
const MIN_SPEED = 4;
/** Within this many radii of a body, you travel along with it. */
const ANCHOR_RADII = 12;
/** Closest you can get to a surface, as a fraction of its radius (clears the atmosphere). */
const CLEARANCE = 0.08;
/** Autopilot parks this many radii above the destination's surface. */
const ARRIVE_RADII = 3;
/** Autopilot opens the throttle only once the nose is within this angle of the destination. */
const ALIGNED = 0.35;

export class FlightControls {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} domElement
   * @param {import('../scene/SolarSystem.js').SolarSystem} system
   */
  constructor(camera, domElement, system) {
    this.camera = camera;
    this.domElement = domElement;
    this.system = system;

    this.enabled = false;

    /** Multiplier while boost is held. */
    this.boostFactor = 4;
    /** Radians per second at full deflection. */
    this.turnRate = 1.5;
    this.rollRate = 1.4;
    /** Full throttle per second while W or S is held. */
    this.throttleRate = 0.8;

    /** -0.3 (gentle reverse) to 1. */
    this.throttle = 0;
    /** Current speed, in scene units per second. */
    this.speed = 0;
    /** Height above the nearest surface, in scene units. */
    this.altitude = Infinity;
    /** The body you are closest to, or null. */
    this.nearest = null;
    /** The body you are flying to, or null. */
    this.target = null;
    /** True while the autopilot is flying to {@link target}. */
    this.autopilot = false;
    /** Called with the destination when the autopilot gets there. */
    this.onArrive = null;
    /** True on a frame the camera was pushed back out of a surface. */
    this.grazing = false;

    this._keys = new Set();
    this._stick = new THREE.Vector2();
    this._steer = new THREE.Vector2();
    this._drag = null;
    this._touchBoost = false;
    this._pad = { x: 0, y: 0, roll: 0, throttle: 0, boost: false };
    this._anchor = null;
    this._anchorLast = new THREE.Vector3();

    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    // Proportional, so a trackpad's stream of small deltas does not slam it.
    this._onWheel = (e) => this.adjustThrottle(THREE.MathUtils.clamp(-e.deltaY * 0.001, -0.1, 0.1));
    this._onLockChange = () => { if (!this.captured) this._stick.set(0, 0); };
    this._onBlur = () => this._releaseAll();
    this._onContextMenu = (e) => e.preventDefault();
  }

  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this._connect();
    else this._disconnect();
  }

  /** True while the mouse is captured for steering. */
  get captured() {
    return document.pointerLockElement === this.domElement;
  }

  /** Whether this device steers by capturing the mouse. */
  get usesCapture() {
    return 'requestPointerLock' in this.domElement && window.matchMedia('(pointer: fine)').matches;
  }

  /** Captures the mouse for steering. Needs a user gesture to succeed. */
  capture() {
    if (!this.enabled || this.captured || !this.usesCapture) return;
    try {
      // Newer browsers return a promise that rejects, e.g. when asked again
      // too soon after the user pressed Esc; that is not an error worth logging.
      this.domElement.requestPointerLock()?.catch?.(() => {});
    } catch { /* unsupported: steering falls back to dragging */ }
  }

  _connect() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.domElement.addEventListener('pointerdown', this._onPointerDown);
    this.domElement.addEventListener('pointermove', this._onPointerMove);
    this.domElement.addEventListener('pointerup', this._onPointerUp);
    this.domElement.addEventListener('pointercancel', this._onPointerUp);
    this.domElement.addEventListener('wheel', this._onWheel, { passive: true });
    this.domElement.addEventListener('contextmenu', this._onContextMenu);
  }

  _disconnect() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
    this.domElement.removeEventListener('pointermove', this._onPointerMove);
    this.domElement.removeEventListener('pointerup', this._onPointerUp);
    this.domElement.removeEventListener('pointercancel', this._onPointerUp);
    this.domElement.removeEventListener('wheel', this._onWheel);
    this.domElement.removeEventListener('contextmenu', this._onContextMenu);
    if (this.captured) document.exitPointerLock();
    this._releaseAll();
  }

  _releaseAll() {
    this._keys.clear();
    this._touchBoost = false;
    this.setPadInput(null);
    this._drag = null;
    this._stick.set(0, 0);
    this._steer.set(0, 0);
  }

  /**
   * This frame's input from a game controller, or null for none. Steering and
   * roll run -1 to 1 (right and down positive, as the sticks report them);
   * throttle -1 to 1 moves the lever down or up at the rate W and S do.
   */
  setPadInput(input) {
    const pad = this._pad;
    pad.x = input?.x ?? 0;
    pad.y = input?.y ?? 0;
    pad.roll = input?.roll ?? 0;
    pad.throttle = input?.throttle ?? 0;
    pad.boost = Boolean(input?.boost);
  }

  _handleKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTypingTarget(event.target)) return;

    this._keys.add(event.code);
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
  }

  _handleKeyUp(event) {
    this._keys.delete(event.code);
  }

  _handlePointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this.captured) return;
    if (event.pointerType === 'mouse' && this.usesCapture) {
      this.capture();
      return;
    }
    // One steering finger at a time; the others are free for the throttle.
    if (this._drag) return;
    this._drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.domElement.setPointerCapture?.(event.pointerId);
  }

  _handlePointerMove(event) {
    if (this.captured) {
      this._stick.x += event.movementX / MOUSE_TRAVEL;
      this._stick.y += event.movementY / MOUSE_TRAVEL;
      if (this._stick.lengthSq() > 1) this._stick.normalize();
    } else if (this._drag?.id === event.pointerId) {
      this._stick.set(
        (event.clientX - this._drag.x) / STICK_RADIUS,
        (event.clientY - this._drag.y) / STICK_RADIUS
      );
      if (this._stick.lengthSq() > 1) this._stick.normalize();
    }
  }

  _handlePointerUp(event) {
    if (this._drag?.id !== event.pointerId) return;
    this._drag = null;
    this._stick.set(0, 0);
  }

  /** Smoothed steering, -1 to 1 on each axis, for the HUD's aim marker. */
  get steering() {
    return this._steer;
  }

  /** Raw stick deflection, -1 to 1 on each axis. */
  get stick() {
    return this._stick;
  }

  /** Where a drag-to-steer began, in client pixels, or null. */
  get stickOrigin() {
    return this._drag;
  }

  get boosting() {
    return this._touchBoost || this._pad.boost ||
      this._keys.has('ShiftLeft') || this._keys.has('ShiftRight');
  }

  update(dt) {
    if (!this.enabled) return;
    const step = Math.min(dt, 0.1); // a backgrounded tab must not teleport the camera

    // --- throttle ---------------------------------------------------------
    if (this._keys.has('KeyW')) this.adjustThrottle(this.throttleRate * step);
    if (this._keys.has('KeyS')) this.adjustThrottle(-this.throttleRate * step);
    if (this._pad.throttle) this.adjustThrottle(this.throttleRate * this._pad.throttle * step);
    if (this._keys.has('Space')) {
      this.autopilot = false;
      this.throttle *= Math.exp(-6 * step);
    }

    // --- steering ---------------------------------------------------------
    if (this.captured) this._stick.multiplyScalar(Math.exp(-RECENTER * step));
    let x = this._stick.x + this._pad.x;
    let y = this._stick.y + this._pad.y;
    if (this._keys.has('ArrowLeft')) x -= 1;
    if (this._keys.has('ArrowRight')) x += 1;
    if (this._keys.has('ArrowUp')) y -= 1;
    if (this._keys.has('ArrowDown')) y += 1;
    x = applyCurve(THREE.MathUtils.clamp(x, -1, 1));
    y = applyCurve(THREE.MathUtils.clamp(y, -1, 1));

    // Any real stick input is the pilot taking over.
    if (this.autopilot && (x !== 0 || y !== 0)) this.autopilot = false;
    if (this.autopilot && !this.target?.visible) this.autopilot = false;
    if (this.autopilot) [x, y] = this._flyToTarget(step);

    const blend = 1 - Math.exp(-8 * step);
    this._steer.x += (x - this._steer.x) * blend;
    this._steer.y += (y - this._steer.y) * blend;

    let roll = 0;
    if (this._keys.has('KeyA') || this._keys.has('KeyQ')) roll += 1;
    if (this._keys.has('KeyD') || this._keys.has('KeyE')) roll -= 1;
    roll = THREE.MathUtils.clamp(roll - this._pad.roll, -1, 1);

    _euler.set(
      -this._steer.y * this.turnRate * step,
      -this._steer.x * this.turnRate * step,
      roll * this.rollRate * step,
      'YXZ'
    );
    _quaternion.setFromEuler(_euler);
    this.camera.quaternion.multiply(_quaternion);

    // --- surroundings -----------------------------------------------------
    this._findNearest();
    this._carryAlong();

    // --- speed ------------------------------------------------------------
    const maxSpeed = systemRadius(this.system.scaleExponent) * 0.05;
    const cruise = THREE.MathUtils.clamp(this.altitude * APPROACH, MIN_SPEED, maxSpeed);
    const target = this.throttle * cruise * (this.boosting ? this.boostFactor : 1);
    // Speeding up takes a moment; slowing down near a planet should not.
    const rate = Math.abs(target) < Math.abs(this.speed) ? 4 : 2;
    this.speed += (target - this.speed) * (1 - Math.exp(-rate * step));
    this.camera.translateZ(-this.speed * step);

    this._keepOutside();
  }

  /**
   * One frame of autopilot: returns the steering that turns the nose towards
   * the destination, opens the throttle once it is lined up, and stops on arrival.
   */
  _flyToTarget(step) {
    const view = this.target;
    _toTarget.copy(view.group.position).sub(this.camera.position);
    const altitude = _toTarget.length() - view.radius;
    if (altitude < view.radius * ARRIVE_RADII) {
      this.autopilot = false;
      this.throttle = 0;
      this.onArrive?.(view);
      return [0, 0];
    }

    // The destination in the camera's own frame: -z ahead, +x right, +y up.
    _toTarget.applyQuaternion(_quaternion.copy(this.camera.quaternion).invert());
    const yaw = Math.atan2(_toTarget.x, -_toTarget.z);
    const pitch = Math.atan2(_toTarget.y, Math.hypot(_toTarget.x, _toTarget.z));
    // Proportional, and firm enough to hold a moving planet dead ahead.
    const x = THREE.MathUtils.clamp(yaw * 2.5, -1, 1);
    const y = THREE.MathUtils.clamp(-pitch * 2.5, -1, 1);

    const aligned = Math.hypot(yaw, pitch) < ALIGNED;
    const wanted = aligned ? 1 : 0.1;
    const change = this.throttleRate * step;
    this.throttle += THREE.MathUtils.clamp(wanted - this.throttle, -change * 2, change);
    return [x, y];
  }

  /** Sets {@link nearest} and {@link altitude} from the visible bodies. */
  _findNearest() {
    this.nearest = null;
    this.altitude = Infinity;
    for (const view of this.system.bodies.values()) {
      if (!view.visible) continue;
      const altitude = this.camera.position.distanceTo(view.group.position) - view.radius;
      if (altitude < this.altitude) {
        this.altitude = altitude;
        this.nearest = view;
      }
    }
    this.altitude = Math.max(this.altitude, 0);
  }

  /**
   * Moves the camera by however far the body it is near has moved. Close to
   * the destination that body is the destination, so a small moon whipping
   * past cannot drag you off round the planet you came to see.
   */
  _carryAlong() {
    const target = this.target?.visible && this.targetAltitude < this.target.radius * ANCHOR_RADII
      ? this.target : null;
    const near = target ?? (this.nearest && this.altitude < this.nearest.radius * ANCHOR_RADII
      ? this.nearest : null);
    if (near && near === this._anchor) {
      _delta.copy(near.group.position).sub(this._anchorLast);
      this.camera.position.add(_delta);
    }
    this._anchor = near;
    if (near) this._anchorLast.copy(near.group.position);
  }

  /** Planets are solid: anything closer than the clearance is pushed back out. */
  _keepOutside() {
    this.grazing = false;
    const view = this.nearest;
    if (!view) return;
    const minimum = view.radius * (1 + CLEARANCE);
    _toCamera.copy(this.camera.position).sub(view.group.position);
    const distance = _toCamera.length();
    if (distance >= minimum || distance === 0) return;
    this.grazing = true;
    this.camera.position.copy(view.group.position).addScaledVector(_toCamera, minimum / distance);
  }

  /** Nudges the throttle, for the wheel and the keys. */
  adjustThrottle(amount) {
    this.setThrottle(this.throttle + amount);
  }

  /** Sets the throttle outright, for the on-screen lever. Takes over from the autopilot. */
  setThrottle(value) {
    this.autopilot = false;
    this.throttle = THREE.MathUtils.clamp(value, -0.3, 1);
  }

  /** Sets (or with null, clears) the destination. A new one drops the autopilot. */
  setTarget(view) {
    if (view !== this.target) this.autopilot = false;
    this.target = view;
  }

  /** Engages or drops the autopilot. Needs a destination to engage. */
  setAutopilot(on) {
    this.autopilot = Boolean(on && this.target);
  }

  /** Distance from the camera to the destination's surface, or Infinity. */
  get targetAltitude() {
    if (!this.target) return Infinity;
    return Math.max(0, this.camera.position.distanceTo(this.target.group.position) - this.target.radius);
  }

  /** Held boost from the on-screen button. */
  setBoost(held) {
    this._touchBoost = held;
  }

  reset() {
    this.throttle = 0;
    this.speed = 0;
    this.autopilot = false;
    this._anchor = null;
    this._releaseAll();
  }

  dispose() {
    this._disconnect();
  }
}

/**
 * Dead zone plus a squared response. Small deflections stay small, which is
 * what makes it possible to line up on a planet instead of wobbling past it.
 */
function applyCurve(value) {
  const magnitude = Math.abs(value);
  if (magnitude < DEAD_ZONE) return 0;
  const scaled = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
  return Math.sign(value) * scaled ** 2;
}

/** True where a key press is text entry. Sliders and switches do not count. */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(target.type);
}
