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
import { systemRadius, heliocentricDistance } from '../scene/scaling.js';

/** How many body radii of empty space to leave around a framed body. */
const FRAMING = 2.6;

/** Seconds a focus change takes. */
const TRANSITION_SECONDS = 1.4;

/** Elevation of the overview shot above the ecliptic, radians. */
const OVERVIEW_ELEVATION = 0.62;

/** Full stick deflection: radians of orbit a second, and screen heights of pan a second. */
const STICK_ORBIT_RATE = 1.7;
const STICK_PAN_RATE = 0.9;
/** Full trigger: zooms by e to this power a second, about sixfold. */
const STICK_ZOOM_RATE = 1.8;

const _delta = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _sunward = new THREE.Vector3();
const _side = new THREE.Vector3();
const _lit = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

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
    this.setScaleExponent(system.scaleExponent);

    /** @type {import('../scene/SolarSystem.js').BodyView|null} */
    this.focus = null;
    this._lastFocusPosition = new THREE.Vector3();
    this._transition = null;
    this._scaleExponent = system.scaleExponent;
  }

  /**
   * Caps zoom a little past the point where the whole system fits in view.
   * Further out there is nothing left to see but a dot, which reads as a bug
   * rather than a limit.
   */
  setScaleExponent(exponent) {
    this._scaleExponent = exponent;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    this.controls.maxDistance = (systemRadius(exponent) / Math.tan(halfFov)) * 1.1;
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
  focusOn(view, { instant = false, duration = TRANSITION_SECONDS } = {}) {
    const previous = this.focus;
    this.focus = view;

    if (!view) {
      this._transition = null;
      this.controls.enabled = true;
      return;
    }

    const distance = this.framingDistance(view);
    this.controls.minDistance = view.radius * 1.15;

    // Approach along the current viewing direction where that is meaningful, so
    // the camera does not swing wildly around the system on every selection -
    // but not so faithfully that it arrives looking at the night side.
    _offset.copy(this.camera.position).sub(this.controls.target);
    const litView = daylightDirection(view, _lit);
    if (_offset.lengthSq() < 1e-6) {
      _offset.copy(litView ?? _offset.set(0.45, 0.32, 1));
    } else if (litView && view !== previous && _offset.normalize().dot(_sunward) < 0) {
      _offset.lerp(litView, 0.65);
    }
    _offset.normalize().multiplyScalar(distance);

    if (instant) {
      this.controls.target.copy(view.group.position);
      this.camera.position.copy(view.group.position).add(_offset);
      this._transition = null;
    } else {
      this._transition = {
        elapsed: 0,
        duration,
        fromTarget: this.controls.target.clone(),
        fromPosition: this.camera.position.clone(),
        offset: _offset.clone(),
        toTarget: null,
      };
    }

    this._lastFocusPosition.copy(view.group.position);
  }

  /**
   * The whole system at a three-quarter angle, framed to `radiusAU`. Keeps the
   * camera's current bearing round the Sun, so it rises and pulls back rather
   * than swinging round to some fixed side.
   */
  overview(radiusAU = 33, { instant = false, duration = 2.2 } = {}) {
    const radius = heliocentricDistance(radiusAU, this._scaleExponent);
    const halfHeight = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfWidth = Math.atan(Math.tan(halfHeight) * this.camera.aspect);
    // Fit the sphere that holds the disc, not the disc as seen head-on: from
    // an angle, perspective swells its near edge well past the far one. The
    // disc is foreshortened, so a little inside the sphere still clears it.
    const distance = (0.9 * radius) / Math.sin(Math.min(halfHeight, halfWidth));

    const bearing = Math.atan2(this.camera.position.x, this.camera.position.z);
    _offset.set(
      Math.sin(bearing) * Math.cos(OVERVIEW_ELEVATION),
      Math.sin(OVERVIEW_ELEVATION),
      Math.cos(bearing) * Math.cos(OVERVIEW_ELEVATION)
    ).multiplyScalar(Math.min(distance, this.controls.maxDistance * 0.98));

    this.focus = null;
    this.controls.minDistance = 0;
    const target = new THREE.Vector3();
    if (instant) {
      this.controls.target.copy(target);
      this.camera.position.copy(_offset);
      this._transition = null;
      return;
    }
    this._transition = {
      elapsed: 0,
      duration,
      fromTarget: this.controls.target.clone(),
      fromPosition: this.camera.position.clone(),
      offset: _offset.clone(),
      toTarget: target,
    };
  }

  /**
   * Orbits, pans and zooms from analog input - a controller's sticks and
   * triggers - as rates, so how it feels does not depend on the frame rate.
   * Each value runs -1 to 1; the sticks move the camera the way dragging does,
   * and positive zoom goes in. Goes through the same accumulators as the mouse,
   * so damping and the zoom limits apply alike.
   *
   * The underscored methods are three's internals, pinned by the vendored
   * copy (see scripts/check.js). The public rotateLeft() and friends each run
   * a whole update() as well, which on top of the one in update() below would
   * step the damping twice a frame.
   */
  drive({ orbitX = 0, orbitY = 0, panX = 0, panY = 0, zoom = 0 }, dt) {
    const { controls } = this;
    if (!controls.enabled) return;
    if (orbitX || orbitY) {
      controls._rotateLeft(orbitX * STICK_ORBIT_RATE * dt);
      controls._rotateUp(orbitY * STICK_ORBIT_RATE * dt);
    }
    if (panX || panY) {
      const pixels = controls.domElement.clientHeight * STICK_PAN_RATE * dt;
      controls._pan(-panX * pixels, -panY * pixels);
    }
    if (zoom) controls._dollyIn(Math.exp(-zoom * STICK_ZOOM_RATE * dt));
  }

  /** A slow drift round whatever is in view, for tours and idle moments. */
  setAutoRotate(enabled, speed = 0.35) {
    this.controls.autoRotate = enabled;
    this.controls.autoRotateSpeed = speed;
  }

  /** True while a focus transition is still playing. */
  get isTransitioning() {
    return this._transition !== null;
  }

  update(dt) {
    if (this._transition) this._advanceTransition(dt);
    else if (this.focus) this._follow();

    this.controls.update(dt);
    this._updateClipping();
  }

  _advanceTransition(dt) {
    const t = this._transition;
    t.elapsed += dt;
    const k = easeInOutCubic(Math.min(1, t.elapsed / t.duration));

    _desired.copy(t.toTarget ?? this.focus.group.position);
    this.controls.target.lerpVectors(t.fromTarget, _desired, k);
    this.camera.position.lerpVectors(t.fromPosition, _desired.add(t.offset), k);

    if (t.elapsed >= t.duration) {
      this._transition = null;
      if (this.focus) this._lastFocusPosition.copy(this.focus.group.position);
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
    this._setNear(this.camera.position.distanceTo(this.controls.target) * 0.002);
  }

  /**
   * The flight-mode equivalent. There is no orbit target to measure against, so
   * this clips against the closest surface instead - otherwise a near plane left
   * over from a wide shot slices straight through a moon you fly up to.
   */
  fitClippingToSurroundings() {
    let nearest = Infinity;
    for (const view of this.system.bodies.values()) {
      if (!view.visible) continue;
      const gap = this.camera.position.distanceTo(view.group.position) - view.boundingRadius;
      nearest = Math.min(nearest, gap);
    }
    this._setNear(Math.max(nearest, 0) * 0.05);
  }

  _setNear(value) {
    const near = THREE.MathUtils.clamp(value, 0.02, 50);
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.15) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Re-seats the orbit target straight ahead of the camera. Flight mode moves
   * the camera without touching the target, so without this, leaving flight
   * snaps the view back towards wherever you were looking before you took off.
   */
  syncTargetToView(distance) {
    this.camera.getWorldDirection(_delta);
    this.controls.target.copy(this.camera.position).addScaledVector(_delta, distance);
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

/**
 * A viewing direction that shows a body mostly lit: the Sun about fifty degrees
 * off to one side and a little above, like a three-quarter portrait. Also
 * leaves the direction toward the Sun in `_sunward`. Null for the Sun itself.
 */
export function daylightDirection(view, out) {
  if (view.group.position.lengthSq() < 1e-6) return null;
  _sunward.copy(view.group.position).negate().normalize();
  _side.crossVectors(_sunward, UP).normalize();
  return out.copy(_sunward).multiplyScalar(0.6)
    .addScaledVector(_side, 0.72)
    .addScaledVector(UP, 0.34)
    .normalize();
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
