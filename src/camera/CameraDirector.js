/**
 * Camera behaviour: what it is looking at, and how it gets there.
 *
 * Following translates the camera by the same delta as the focused body, so
 * the body stays still in view while the rest of the system moves round it.
 * Framing distance comes from the body's radius and the field of view.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { heliocentricDistance } from '../scene/scaling.js';

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

/**
 * OrbitControls' gesture states (its _STATE, not exported): none, and the ones
 * that zoom - the wheel (which starts with no pointer down), the middle button,
 * and a pinch with either two-finger pan or rotate.
 */
const NO_GESTURE = -1;
const ZOOM_GESTURES = new Set([NO_GESTURE, 1, 5, 6]);

const _delta = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _pathTarget = new THREE.Vector3();
const _pathPosition = new THREE.Vector3();
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
    /** What an overview is centred on and follows, when not the system's centre. */
    this.anchor = null;
    this._lastFocusPosition = new THREE.Vector3();
    this._transition = null;
    this._scaleExponent = system.scaleExponent;
    // The wheel and a pinch spend their zoom inside the event, before update()
    // could see it, so they claim it here instead.
    this.controls.addEventListener('start', () => {
      if (ZOOM_GESTURES.has(this.controls.state)) this._claim('zoom');
    });
  }

  /**
   * Caps zoom a little past the point where the whole system fits in view.
   * Further out there is nothing left to see but a dot, which reads as a bug
   * rather than a limit.
   */
  setScaleExponent(exponent) {
    this._scaleExponent = exponent;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    this.camera.far = Math.max(this.camera.far, heliocentricDistance(this.system.catalogue.edgeAU, exponent) * 8);
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = (heliocentricDistance(this.system.catalogue.edgeAU, exponent) / Math.tan(halfFov)) * 1.1;
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
    this.anchor = null;

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
      this._beginTransition({
        duration,
        fromTarget: this.controls.target.clone(),
        fromPosition: this.camera.position.clone(),
        offset: _offset.clone(),
        toTarget: null,
      });
    }

    this._lastFocusPosition.copy(view.group.position);
  }

  /**
   * The whole system at a three-quarter angle, framed to `radiusAU`. Keeps the
   * camera's current bearing round the Sun, so it rises and pulls back rather
   * than swinging round to some fixed side. `centre`, a body, frames its
   * surroundings instead - a star's planets, in a system of several stars -
   * and is followed as it moves.
   */
  overview(radiusAU = 33, { instant = false, duration = 2.2, centre = null } = {}) {
    const radius = heliocentricDistance(radiusAU, this._scaleExponent);
    const halfHeight = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfWidth = Math.atan(Math.tan(halfHeight) * this.camera.aspect);
    // Fit the sphere that holds the disc, not the disc as seen head-on: from
    // an angle, perspective swells its near edge well past the far one. The
    // disc is foreshortened, so a little inside the sphere still clears it.
    const distance = (0.9 * radius) / Math.sin(Math.min(halfHeight, halfWidth));

    const target = centre ? centre.group.position.clone() : new THREE.Vector3();
    const bearing = Math.atan2(this.camera.position.x - target.x, this.camera.position.z - target.z);
    _offset.set(
      Math.sin(bearing) * Math.cos(OVERVIEW_ELEVATION),
      Math.sin(OVERVIEW_ELEVATION),
      Math.cos(bearing) * Math.cos(OVERVIEW_ELEVATION)
    ).multiplyScalar(Math.min(distance, this.controls.maxDistance * 0.98));

    this.focus = null;
    this.anchor = centre;
    this._lastFocusPosition.copy(target);
    this.controls.minDistance = 0;
    if (instant) {
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(_offset);
      this._transition = null;
      return;
    }
    this._beginTransition({
      duration,
      fromTarget: this.controls.target.clone(),
      fromPosition: this.camera.position.clone(),
      offset: _offset.clone(),
      // A moving centre is tracked all the way there, like a focused body.
      toTarget: centre ? null : target,
    });
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
    // Mid-transition, what the sticks move is theirs; see _claim().
    if (orbitX || orbitY) this._claim('rotate');
    if (panX || panY) this._claim('pan');
    if (zoom) this._claim('zoom');
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

  get isTransitioning() {
    return this._transition !== null;
  }

  update(dt) {
    // Input can end a transition, and following then takes over this same frame.
    if (this._transition) this._claimFromInput();
    if (this._transition) this._advanceTransition(dt);
    else if (this.focus ?? this.anchor) this._follow();

    this.controls.update(dt);
    this._updateClipping();
  }

  /**
   * A transition has three parts: where the camera looks (pan), the angle it
   * looks from (rotate) and how far away it is (zoom). Whatever the user moves
   * mid-transition is theirs from then on, and the rest carries on without it,
   * so a drag on the way to a planet turns the view instead of being undone
   * the next frame.
   */
  _claim(part) {
    const t = this._transition;
    if (!t) return;
    t.claimed[part] = true;
    if (t.claimed.pan && t.claimed.rotate && t.claimed.zoom) this._endTransition();
  }

  /** Dragging, read from OrbitControls' accumulators, which damping keeps for a while after. */
  _claimFromInput() {
    const { controls } = this;
    if (controls._panOffset.lengthSq() > 0) this._claim('pan');
    // Auto-rotate feeds the same accumulator, but only while no pointer is down.
    if (controls.state !== NO_GESTURE && (controls._sphericalDelta.theta || controls._sphericalDelta.phi)) this._claim('rotate');
  }

  _beginTransition(transition) {
    // Drift left over from an earlier drag is not a claim on this one.
    this.controls._sphericalDelta.set(0, 0, 0);
    this.controls._panOffset.set(0, 0, 0);
    this._transition = { ...transition, elapsed: 0, claimed: { pan: false, rotate: false, zoom: false } };
  }

  /** Following picks up from the last frame's position, which the transition keeps current. */
  _endTransition() {
    this._transition = null;
  }

  _advanceTransition(dt) {
    const t = this._transition;
    t.elapsed += dt;
    const k = easeInOutCubic(Math.min(1, t.elapsed / t.duration));

    const followed = this.focus ?? this.anchor;
    const { target } = this.controls;
    _desired.copy(t.toTarget ?? followed.group.position);
    _pathTarget.lerpVectors(t.fromTarget, _desired, k);
    _pathPosition.lerpVectors(t.fromPosition, _desired.add(t.offset), k);

    const { claimed } = t;
    if (!claimed.pan && !claimed.rotate && !claimed.zoom) {
      target.copy(_pathTarget);
      this.camera.position.copy(_pathPosition);
    } else {
      // Keep what the user has taken, and take the rest from the path.
      _offset.copy(this.camera.position).sub(target);
      _pathPosition.sub(_pathTarget);
      if (claimed.pan) {
        // Where they panned to, carried along as a followed body moves.
        if (followed) target.add(_delta.copy(followed.group.position).sub(this._lastFocusPosition));
      } else target.copy(_pathTarget);
      const distance = claimed.zoom ? _offset.length() : _pathPosition.length();
      (claimed.rotate ? _offset : _offset.copy(_pathPosition)).normalize();
      this.camera.position.copy(target).addScaledVector(_offset, distance);
    }
    if (followed) this._lastFocusPosition.copy(followed.group.position);

    if (t.elapsed >= t.duration) this._endTransition();
  }

  /** Carries the camera along with the body it is watching. */
  _follow() {
    const followed = this.focus ?? this.anchor;
    _delta.copy(followed.group.position).sub(this._lastFocusPosition);
    this.camera.position.add(_delta);
    this.controls.target.add(_delta);
    this._lastFocusPosition.copy(followed.group.position);
  }

  /**
   * Scales the near plane with distance to the target: a fixed one either
   * clips the surface you approach or wastes depth precision everywhere else.
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
  if (view.kind === 'star') return null;
  _sunward.copy(view.lightPosition ?? _sunward.set(0, 0, 0)).sub(view.group.position);
  if (_sunward.lengthSq() < 1e-6) return null;
  _sunward.normalize();
  _side.crossVectors(_sunward, UP).normalize();
  return out.copy(_sunward).multiplyScalar(0.6)
    .addScaledVector(_side, 0.72)
    .addScaledVector(UP, 0.34)
    .normalize();
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
