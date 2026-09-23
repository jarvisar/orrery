/**
 * Virtual reality.
 *
 * In a headset the camera stops being something the app points. It is the
 * viewer's own head, so everything that used to move the camera moves a rig
 * the head stands in instead: a group with a position, a heading and a
 * uniform scale.
 *
 * The scale is what makes it work. The scene is measured in units where the
 * Earth is 48 across and a headset measures in metres, so there is no one right
 * size for a person in it. The rig is resized to suit whatever is being looked
 * at. Focus a planet and it becomes a globe a couple of metres away, a little
 * under two across. Ask for the whole system and it shrinks to a tabletop
 * orrery, with Neptune's orbit a step or two from the Sun. The eyes ride in the
 * rig too, so the stereo separation scales with it and the depth always reads
 * as a model of that size, never as a planet seen with the eyes of an ant.
 *
 * Nothing flies the viewer anywhere. A camera sweeping across the solar system
 * is exactly the kind of motion a headset turns into nausea: the eyes see
 * acceleration the inner ear never feels. Moving between bodies is a short fade
 * through black instead. The only continuous motion is what the viewer makes
 * with a thumbstick or their own hands.
 *
 * Controls, on any controller with the xr-standard mapping:
 *
 *   Trigger      point and select: a body, or a button on the panel
 *   Grip         grab the system and move it; both grips to scale and turn it
 *   Left stick   fly where the left controller points; click it to go faster
 *   Right stick  snap turn left and right; push forward or back to zoom
 *   A / B        play or pause / the whole system
 *   X / Y        previous / next body
 *
 * Hand tracking works too: a pinch is the trigger, and the panel covers the rest.
 */

import * as THREE from 'three';
import { SUN_ID } from '../data/bodies.js';
import { heliocentricDistance, sceneRadius } from '../scene/scaling.js';
import { daylightDirection } from '../camera/CameraDirector.js';
import { VRPanel } from './VRPanel.js';
import { VRLabels } from './VRLabels.js';

/** A focused body is framed with this radius, in metres, its centre this far from the eyes. */
const FOCUS_RADIUS_M = 0.85;
const FOCUS_DISTANCE_M = 2.4;

/**
 * The whole system as a tabletop: the framed radius in metres, and where the
 * Sun sits relative to the eyes - out in front and below, so the orbits are
 * looked down on like a model on a table.
 */
const TABLE_RADIUS_M = 1.3;
const TABLE_AHEAD_M = 1.6;
const TABLE_BELOW_M = 0.5;

/** How far the rig may be scaled, in scene units per metre. */
const MIN_SCALE = 0.25;
const MAX_SCALE = 500_000;

/** Near plane in metres: close enough for a controller held up to the face. */
const NEAR_M = 0.05;
/** Far plane ceiling in metres. The logarithmic depth buffer copes with the range. */
const MAX_FAR_M = 1e7;

const FADE_OUT_S = 0.15;
const FADE_IN_S = 0.3;

const DEAD_ZONE = 0.15;
/** Flying speed at full deflection, in metres per second at the current scale. */
const FLY_SPEED_M = 1.8;
const BOOST = 4;
/** Zoom rate at full deflection, in e-folds of scale per second. */
const ZOOM_RATE = 1.5;
/** One press of a panel zoom button. */
const ZOOM_STEP = 1.8;
const SNAP_TURN = THREE.MathUtils.degToRad(30);

/** A body this far off the ray, in radians, still counts as pointed at when it is small. */
const ASSIST_ANGLE = THREE.MathUtils.degToRad(2);
/** Laser length when it is not touching anything. */
const RAY_LENGTH_M = 6;

/** Framing for the whole system, in AU, matching the desktop overview. */
const OVERVIEW_AU = 33;

/** xr-standard gamepad buttons. */
const STICK_BUTTON = 3;
const FACE_LOWER = 4; // A or X
const FACE_UPPER = 5; // B or Y

const ACCENT = new THREE.Color('#f3bd6e');

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _localSpan = new THREE.Vector3();
const _worldSpan = new THREE.Vector3();

export class VRMode {
  /** True where an immersive VR session could be started: a headset, or a runtime for one. */
  static async isSupported() {
    if (!window.isSecureContext || !navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-vr');
    } catch {
      return false;
    }
  }

  /**
   * Starts fetching the controller and hand model code, so the session does
   * not have to wait for it. Only worth calling once VR is known to be there.
   */
  static preload() {
    modelFactories ??= Promise.all([
      import('three/addons/webxr/XRControllerModelFactory.js'),
      import('three/addons/webxr/XRHandModelFactory.js'),
    ]).then(
      ([controllers, hands]) => ({
        controllers: new controllers.XRControllerModelFactory(),
        hands: new hands.XRHandModelFactory(),
      }),
      (error) => {
        console.warn('[vr] controller models unavailable', error);
        return null;
      }
    );
    return modelFactories;
  }

  /**
   * @param {object} options
   * @param {THREE.WebGLRenderer} options.renderer
   * @param {THREE.PerspectiveCamera} options.camera
   * @param {THREE.Scene} options.scene
   * @param {import('../scene/SolarSystem.js').SolarSystem} options.system
   * @param {import('../sim/Clock.js').Clock} options.clock
   * @param {import('../core/Picker.js').Picker} options.picker
   * @param {import('../core/Settings.js').Settings} options.settings
   * @param {object} options.actions What the controllers and the panel can ask for.
   * @param {() => void} [options.onStart]
   * @param {() => void} [options.onEnd]
   * @param {(width: number, height: number) => void} [options.onResolution] One eye's size, in pixels.
   */
  constructor({ renderer, camera, scene, system, clock, picker, settings, actions, onStart, onEnd, onResolution }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.system = system;
    this.clock = clock;
    this.picker = picker;
    this.settings = settings;
    this.actions = actions;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.onResolution = onResolution;

    /** Set from the moment a session is granted until it has ended. */
    this.active = false;
    this.session = null;
    /** @type {import('../scene/SolarSystem.js').BodyView|null} */
    this.focus = null;
    /** The viewer's eyes, in world space. Valid while presenting. */
    this.viewerPosition = new THREE.Vector3();

    this.rig = new THREE.Group();
    this.rig.name = 'vr-rig';
    this.yaw = 0;
    this.scale = 1;

    this.labels = new VRLabels(scene, system);
    this.labels.setEnabled(settings.get('showLabels'));
    settings.on('showLabels', (value) => {
      this.labels.setEnabled(value);
      this.panel.invalidate();
    });

    this.panel = new VRPanel();
    this._fade = buildFade();

    this.hands = [];
    this._hovered = new Set();
    this._headUp = new THREE.Vector3(0, 1, 0);
    this._lastFocus = new THREE.Vector3();
    this._transition = null;
    this._pending = null;
    this._ready = false;
    this._starting = false;
    this._saved = null;

    renderer.xr.addEventListener('sessionend', () => this._exit());
  }

  /** True while frames are going to the headset. */
  get presenting() {
    return this.active && this.renderer.xr.isPresenting;
  }

  async toggle() {
    if (this.active) this.end();
    else await this.start();
  }

  async start() {
    if (this.active || this._starting) return;
    this._starting = true;
    try {
      // Asked for first, while the click that started it still counts as one.
      const session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      });
      // Models before the session is handed over: controllers announce
      // themselves as soon as it is, and a model created after that never loads.
      const factories = await VRMode.preload();
      this._setupHands(factories);

      const floor = !session.enabledFeatures || session.enabledFeatures.includes('local-floor');
      this.renderer.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');

      this.session = session;
      this._enter();
      try {
        await this.renderer.xr.setSession(session);
      } catch (error) {
        session.end().catch(() => {});
        this._exit();
        throw error;
      }
    } catch (error) {
      console.warn('[vr] could not start a session', error);
    } finally {
      this._starting = false;
    }
  }

  end() {
    this.session?.end().catch(() => {});
  }

  /* --- where the viewer is ------------------------------------------------ */

  /**
   * Brings a body up close, through a fade. Null lets go of the current one
   * without moving: the viewer stays where they are and stops following it.
   */
  focusOn(view, { instant = false } = {}) {
    if (!this.active) return;
    this._setFocus(view);
    if (view) this._goTo(() => this._frameBody(view), instant);
  }

  /** The whole system, as a model on a table. */
  overview(radiusAU = OVERVIEW_AU, { instant = false } = {}) {
    if (!this.active) return;
    this._setFocus(null);
    this._goTo(() => this._frameSystem(radiusAU), instant);
  }

  /** Back to the standard framing of whatever is focused. */
  reframe() {
    if (this.focus) this.focusOn(this.focus);
  }

  _setFocus(view) {
    this.focus = view;
    if (view) this._lastFocus.copy(view.group.position);
    this.labels.setFocus(view?.id ?? null);
    this.panel.invalidate();
  }

  _goTo(frame, instant) {
    if (!this._ready) {
      // No head pose until the first frame; frame then.
      this._pending = frame;
      return;
    }
    if (instant) {
      frame();
      this._regrab();
      return;
    }
    const current = this._transition;
    if (current?.phase === 'out') {
      current.frame = frame;
      return;
    }
    // Part way through fading back in, fade out again from wherever it got to.
    const opacity = this._fade.material.opacity;
    this._transition = { phase: 'out', t: opacity * FADE_OUT_S, frame };
  }

  _frameBody(view) {
    const centre = view.group.position;
    const scale = Math.max(view.boundingRadius, view.radius) / FOCUS_RADIUS_M;

    // From the lit side, three-quarters on, as on screen - but flatter, since
    // here it is the viewer's neck that has to look down at it.
    if (daylightDirection(view, _dir)) {
      _dir.y *= 0.5;
    } else {
      // The Sun is lit from every side: approach from wherever we already are.
      _dir.copy(this.viewerPosition).sub(centre).setY(0);
      if (_dir.lengthSq() < 1e-9) _dir.set(0, 0, 1);
    }
    _dir.normalize();

    _eye.copy(centre).addScaledVector(_dir, FOCUS_DISTANCE_M * scale);
    _look.copy(centre).sub(_eye);
    this._place(_eye, _look, scale);
  }

  _frameSystem(radiusAU) {
    const sun = this.system.bodies.get(SUN_ID).group.position;
    const scale = heliocentricDistance(radiusAU, this.system.scaleExponent) / TABLE_RADIUS_M;

    // Keep our bearing round the Sun, as the desktop overview does.
    _dir.copy(this.viewerPosition).sub(sun).setY(0);
    if (_dir.lengthSq() < 1e-9) _dir.set(0, 0, 1);
    _dir.normalize();

    _eye.copy(sun)
      .addScaledVector(_dir, TABLE_AHEAD_M * scale)
      .addScaledVector(UP, TABLE_BELOW_M * scale);
    _look.copy(_dir).negate();
    this._place(_eye, _look, scale);
  }

  /**
   * Moves the rig so the viewer's eyes land on `eye`, at `scale`, with
   * whichever way they happen to be facing turned towards `look`. Only ever a
   * heading: the rig never pitches or rolls, so the floor stays level.
   */
  _place(eye, look, scale) {
    this.scale = clampScale(scale);

    _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0);
    const facing = _v.lengthSq() > 1e-9 ? yawOf(_v) : Math.PI;
    _w.copy(look).setY(0);
    if (_w.lengthSq() > 1e-12) this.yaw = yawOf(_w) - facing;

    _v.copy(this.camera.position).multiplyScalar(this.scale).applyAxisAngle(UP, this.yaw);
    this.rig.position.copy(eye).sub(_v);
    this._applyRig();
  }

  _applyRig() {
    this.rig.quaternion.setFromAxisAngle(UP, this.yaw);
    this.rig.scale.setScalar(this.scale);
    this.rig.updateMatrixWorld(true);
  }

  /* --- session ------------------------------------------------------------ */

  _enter() {
    this.active = true;
    this._ready = false;
    this._transition = null;
    this.renderer.xr.enabled = true;
    this.renderer.xr.cameraAutoUpdate = false;

    const camera = this.camera;
    this._saved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      near: camera.near,
      far: camera.far,
      fov: camera.fov,
    };

    this.scene.add(this.rig);
    this.rig.add(camera);
    camera.add(this._fade);
    camera.near = NEAR_M;
    this._setFade(1);

    for (const hand of this.hands) this.rig.add(hand.ray, hand.grip, hand.hand);
    this.labels.setActive(true);
    this.onStart?.();
  }

  /** Runs once three has put the page's own canvas size and camera back. */
  _exit() {
    if (!this.active) return;
    this.active = false;
    this.session = null;
    this._ready = false;
    this._pending = null;
    this._transition = null;
    this.renderer.xr.enabled = false;
    this.renderer.xr.cameraAutoUpdate = true;

    for (const hand of this.hands) {
      hand.squeezing = false;
      hand.hoverType = null;
      hand.hoverId = null;
    }
    this._hovered.clear();
    this.labels.setActive(false);
    this.panel.detach();

    const camera = this.camera;
    camera.remove(this._fade);
    this.rig.remove(camera);
    this.scene.remove(this.rig);
    const saved = this._saved;
    camera.position.copy(saved.position);
    camera.quaternion.copy(saved.quaternion);
    camera.scale.set(1, 1, 1);
    camera.near = saved.near;
    camera.far = saved.far;
    camera.fov = saved.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    this.onEnd?.();
  }

  /* --- frame -------------------------------------------------------------- */

  update(dt) {
    if (!this.presenting) return;

    this._syncHead();
    if (!this._ready) this._firstFrame();

    this._follow();
    this._advanceTransition(dt);
    this._readInput(dt);
    this._syncHead();

    this.panel.follow(this.camera);
    this._updatePointers();
    this._headUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    this.labels.update(this.viewerPosition, this._headUp, this.scale, this._hovered);
    this.panel.update(this._describe());
    this._updateClipping();
  }

  /**
   * Reads this frame's head pose into the camera, and its position into
   * viewerPosition. The last call in a frame is what gets rendered: three's
   * own per-render update is switched off while presenting, see
   * {@link VRMode#_fixCullingFrustum}.
   */
  _syncHead() {
    this.rig.updateMatrixWorld(true);
    this.renderer.xr.updateCamera(this.camera);
    this._fixCullingFrustum();
    this.camera.getWorldPosition(this.viewerPosition);
  }

  /**
   * Both eyes are culled against one frustum wide enough to hold them both.
   * three builds it from the distance between the eyes, which it measures in
   * world units but then uses as if it were in the eyes' own view units. In a
   * scaled rig those are metres, and the two differ by the scale: on the
   * tabletop the shared near plane ends up hundreds of metres out and culls
   * every planet within reach. This is three's construction again, with the
   * separation in metres. The frustum's position was already right.
   */
  _fixCullingFrustum() {
    const xrCamera = this.renderer.xr.getCamera();
    const [left, right] = xrCamera.cameras;
    if (!right) return;
    const projL = left.projectionMatrix.elements;
    const projR = right.projectionMatrix.elements;
    // An infinite far plane: three used the left eye's projection as it is.
    if (projL[10] === -1) return;

    const ipd = _v.setFromMatrixPosition(left.matrixWorld)
      .distanceTo(_w.setFromMatrixPosition(right.matrixWorld)) / this.scale;
    const near = projL[14] / (projL[10] - 1);
    const far = projL[14] / (projL[10] + 1);
    const topFov = (projL[9] + 1) / projL[5];
    const bottomFov = (projL[9] - 1) / projL[5];
    const leftFov = (projL[8] - 1) / projL[0];
    const rightFov = (projR[8] + 1) / projR[0];
    const zOffset = ipd / (rightFov - leftFov);
    const xOffset = zOffset * -leftFov;
    const near2 = near + zOffset;
    const far2 = far + zOffset;

    xrCamera.projectionMatrix.makePerspective(
      near * leftFov - xOffset,
      near * rightFov + (ipd - xOffset),
      ((topFov * far) / far2) * near2,
      ((bottomFov * far) / far2) * near2,
      near2,
      far2
    );
    xrCamera.projectionMatrixInverse.copy(xrCamera.projectionMatrix).invert();
    this.camera.projectionMatrix.copy(xrCamera.projectionMatrix);
    this.camera.projectionMatrixInverse.copy(xrCamera.projectionMatrixInverse);
  }

  /**
   * Brings viewerPosition up to date after the rig has moved this frame - by
   * following a body, flying, or a grab - without asking the headset again.
   * Anything that pivots on the head needs it: a pivot a frame's travel out
   * of date swings the viewer sideways.
   */
  _refreshViewer() {
    this.rig.updateMatrixWorld(true);
    this.viewerPosition.copy(this.camera.position).applyMatrix4(this.rig.matrixWorld);
  }

  _firstFrame() {
    this._ready = true;

    const eye = this.renderer.xr.getCamera().cameras[0]?.viewport;
    if (eye && eye.z > 0) this.onResolution?.(eye.z, eye.w);

    const frame = this._pending ?? (() => this._frameSystem(OVERVIEW_AU));
    this._pending = null;
    frame();
    this._placePanel();
    this._syncHead();
    this._transition = { phase: 'in', t: 0 };
  }

  /**
   * Carries the viewer along with the body they are looking at, the way the
   * desktop camera follows. Anything held moves with it too.
   */
  _follow() {
    if (!this.focus) return;
    _v.copy(this.focus.group.position).sub(this._lastFocus);
    this._lastFocus.copy(this.focus.group.position);
    if (_v.lengthSq() === 0) return;
    this.rig.position.add(_v);
    for (const hand of this.hands) hand.anchor.add(_v);
  }

  _advanceTransition(dt) {
    const transition = this._transition;
    if (!transition) return;
    transition.t += dt;

    if (transition.phase === 'out') {
      const k = Math.min(1, transition.t / FADE_OUT_S);
      this._setFade(k);
      if (k < 1) return;
      this._refreshViewer();
      transition.frame();
      this._regrab();
      this._syncHead();
      this._transition = { phase: 'in', t: 0 };
    } else {
      const k = Math.min(1, transition.t / FADE_IN_S);
      this._setFade(1 - k * k);
      if (k >= 1) this._transition = null;
    }
  }

  _setFade(opacity) {
    this._fade.material.opacity = opacity;
    this._fade.visible = opacity > 0.001;
  }

  /** Near and far, in metres. The far plane moves out as the viewer shrinks. */
  _updateClipping() {
    const far = THREE.MathUtils.clamp((sceneRadius() * 2) / this.scale, 1000, MAX_FAR_M);
    // Only on a real change: each one is a render-state update for the session.
    if (Math.abs(Math.log(far / this.camera.far)) > 0.7) this.camera.far = far;
    this.camera.near = NEAR_M;
  }

  /* --- controllers -------------------------------------------------------- */

  _setupHands(factories) {
    if (this.hands.length) return;
    const xr = this.renderer.xr;
    if (factories) {
      factories.controllers.onLoad = brighten;
      factories.hands.onLoad = brighten;
    }

    for (let index = 0; index < 2; index++) {
      const hand = {
        index,
        ray: xr.getController(index),
        grip: xr.getControllerGrip(index),
        hand: xr.getHand(index),
        source: null,
        side: 'none',
        squeezing: false,
        /** The world point held by this hand's grip. */
        anchor: new THREE.Vector3(),
        was: [],
        turnArmed: true,
        hoverType: null,
        hoverId: null,
        hit: { type: null, id: null, distance: 0 },
        laser: buildLaser(),
      };
      hand.ray.add(hand.laser);

      if (factories) {
        hand.grip.add(factories.controllers.createControllerModel(hand.grip));
        hand.hand.add(factories.hands.createHandModel(hand.hand, 'mesh'));
      }

      hand.ray.addEventListener('connected', (event) => {
        hand.source = event.data;
        hand.side = event.data.handedness === 'left' ? 'left' : 'right';
        hand.was.length = 0;
        this._placePanel();
      });
      hand.ray.addEventListener('disconnected', () => {
        hand.source = null;
        hand.squeezing = false;
        hand.laser.visible = false;
        this._placePanel();
      });
      hand.ray.addEventListener('select', () => this._onSelect(hand));
      hand.ray.addEventListener('squeezestart', () => {
        hand.squeezing = true;
        this._regrab();
        pulse(hand.source, 0.35, 25);
      });
      hand.ray.addEventListener('squeezeend', () => {
        hand.squeezing = false;
        this._regrab();
      });

      this.hands.push(hand);
    }
  }

  /** Thumbsticks and face buttons, polled; the trigger and grip arrive as events. */
  _readInput(dt) {
    const fading = this._transition?.phase === 'out';

    for (const hand of this.hands) {
      const pad = hand.source?.gamepad;
      if (!pad) continue;
      // xr-standard puts the thumbstick on axes 2 and 3; controllers with only
      // a touchpad report it on 0 and 1.
      const axes = pad.axes;
      const x = axes.length >= 4 ? axes[2] : (axes[0] ?? 0);
      const y = axes.length >= 4 ? axes[3] : (axes[1] ?? 0);
      const pressed = (i) => Boolean(pad.buttons[i]?.pressed);
      const tapped = (i) => pressed(i) && !hand.was[i];

      if (hand.side === 'left') {
        if (!fading && Math.hypot(x, y) > DEAD_ZONE) {
          const step = FLY_SPEED_M * this.scale * (pressed(STICK_BUTTON) ? BOOST : 1) * dt;
          _v.set(0, 0, -1).transformDirection(hand.ray.matrixWorld);
          _w.set(1, 0, 0).transformDirection(hand.ray.matrixWorld);
          this.rig.position
            .addScaledVector(_v, response(-y) * step)
            .addScaledVector(_w, response(x) * step);
          // Flying moves the viewer, not whatever they are holding.
          this._regrab();
        }
        if (tapped(FACE_LOWER)) this.actions.step(-1);
        if (tapped(FACE_UPPER)) this.actions.step(1);
      } else {
        if (hand.turnArmed && Math.abs(x) > 0.7 && !fading) {
          this._turn(-Math.sign(x) * SNAP_TURN);
          hand.turnArmed = false;
          pulse(hand.source, 0.2, 15);
        } else if (Math.abs(x) < 0.3) {
          hand.turnArmed = true;
        }
        if (Math.abs(y) > DEAD_ZONE && Math.abs(y) > Math.abs(x) && !fading && !this._grabbing(2)) {
          this._zoom(Math.exp(response(y) * ZOOM_RATE * dt));
        }
        if (tapped(FACE_LOWER)) this.actions.togglePause();
        if (tapped(FACE_UPPER)) this.actions.overview();
        if (tapped(STICK_BUTTON)) this.reframe();
      }

      for (let i = 0; i < pad.buttons.length; i++) hand.was[i] = pad.buttons[i].pressed;
    }

    this._applyGrab();
  }

  /** Turns on the spot: about the viewer's head, not the rig's origin. */
  _turn(angle) {
    this._refreshViewer();
    const head = this.viewerPosition;
    this.rig.position.sub(head).applyAxisAngle(UP, angle).add(head);
    this.yaw += angle;
    this._applyRig();
    this._regrab();
  }

  /**
   * Scales the world about what is being looked at: the focused body, or the
   * Sun. Scaling about the head would change nothing visible; everything
   * would grow and recede in exact proportion.
   */
  _zoom(factor) {
    const pivot = this.focus?.group.position ?? this.system.bodies.get(SUN_ID).group.position;
    let k = clampScale(this.scale * factor) / this.scale;
    if (this.focus && k < 1) {
      // Stop at the surface, rather than zooming the viewer inside the body.
      this._refreshViewer();
      const distance = this.viewerPosition.distanceTo(pivot);
      k = Math.max(k, Math.min(1, (this.focus.radius * 1.2) / Math.max(distance, 1e-9)));
    }
    if (Math.abs(k - 1) < 1e-6) return;
    this.rig.position.sub(pivot).multiplyScalar(k).add(pivot);
    this.scale *= k;
    this._applyRig();
    this._regrab();
  }

  _grabbing(count) {
    let held = 0;
    for (const hand of this.hands) if (hand.squeezing && hand.source) held++;
    return held >= count;
  }

  /** Re-takes hold wherever each gripping hand is now. */
  _regrab() {
    this.rig.updateMatrixWorld(true);
    for (const hand of this.hands) {
      if (hand.squeezing) hand.anchor.setFromMatrixPosition(hand.ray.matrixWorld);
    }
  }

  /**
   * The world, held. One hand drags it: whatever point was under the hand when
   * the grip closed stays under it. Two hands also scale and turn it, keeping
   * both held points under their hands at once - pull them apart to zoom in,
   * twist them to turn it.
   */
  _applyGrab() {
    if (this._transition?.phase === 'out') return;
    let a = null;
    let b = null;
    for (const hand of this.hands) {
      if (!hand.squeezing || !hand.source) continue;
      if (!a) a = hand;
      else if (!b) b = hand;
    }
    if (!a) return;
    this.rig.updateMatrixWorld(true);

    if (!b) {
      _v.setFromMatrixPosition(a.ray.matrixWorld);
      this.rig.position.add(_w.copy(a.anchor).sub(_v));
      this._applyRig();
      return;
    }

    // Both hands' positions in the rig's own space, in metres.
    _v.setFromMatrixPosition(a.ray.matrix);
    _w.setFromMatrixPosition(b.ray.matrix);
    _localSpan.subVectors(_w, _v);
    _worldSpan.subVectors(b.anchor, a.anchor);
    const reach = _localSpan.length();
    if (reach < 0.02) return;

    this.scale = clampScale(_worldSpan.length() / reach);
    if (Math.hypot(_localSpan.x, _localSpan.z) > 0.02 && Math.hypot(_worldSpan.x, _worldSpan.z) > 1e-9) {
      this.yaw = yawOf(_worldSpan) - yawOf(_localSpan);
    }
    _mid.addVectors(_v, _w).multiplyScalar(0.5 * this.scale).applyAxisAngle(UP, this.yaw);
    this.rig.position.addVectors(a.anchor, b.anchor).multiplyScalar(0.5).sub(_mid);
    this._applyRig();
  }

  /* --- pointing ----------------------------------------------------------- */

  _updatePointers() {
    this._hovered.clear();
    let panelButton = null;

    for (const hand of this.hands) {
      const source = hand.source;
      const mode = source?.targetRayMode;
      const pointing = (mode === 'tracked-pointer' || mode === 'gaze') && !hand.squeezing;
      hand.laser.visible = pointing && mode === 'tracked-pointer';
      if (!pointing) {
        this._setHover(hand, null);
        continue;
      }

      const hit = this._hitTest(hand);
      this._setHover(hand, hit);
      if (hit?.type === 'body') this._hovered.add(hit.id);
      if (hit?.type === 'panel' && hit.id) panelButton = hit.id;

      const length = hit ? Math.max(hit.distance / this.scale, 0.02) : RAY_LENGTH_M;
      const { beam, cursor } = hand.laser.userData;
      beam.scale.z = length;
      cursor.visible = Boolean(hit);
      cursor.position.z = -length;
      // About a third of a degree across wherever it lands: findable on a
      // planet across the room, small enough not to cover a button's label.
      cursor.scale.setScalar(Math.max(length * 0.003, 0.0012));
    }

    this.panel.setHover(panelButton);
  }

  /** What a hand's ray touches: the panel, then any body, then any small body near it. */
  _hitTest(hand) {
    const hit = hand.hit;
    _origin.setFromMatrixPosition(hand.ray.matrixWorld);
    _direction.set(0, 0, -1).transformDirection(hand.ray.matrixWorld);

    // A hand cannot point at the panel it is holding.
    if (this.panel.holder !== hand) {
      const onPanel = this.panel.hit(_origin, _direction);
      if (onPanel) {
        hit.type = 'panel';
        hit.id = onPanel.button;
        hit.distance = onPanel.distance;
        return hit;
      }
    }

    const exact = this.picker.pickRay(_origin, _direction);
    if (exact) {
      hit.type = 'body';
      hit.id = exact.id;
      hit.distance = exact.distance;
      return hit;
    }
    return this._assist(_origin, _direction, hit);
  }

  /**
   * Aim assist. From across a tabletop solar system most bodies are a
   * millimetre or two across, and a hand-held ray wobbles by more than that.
   * Anything the labels are showing counts as hit if the ray passes within a
   * couple of degrees of it; the nearest to the ray wins.
   */
  _assist(origin, direction, hit) {
    let best = null;
    let bestScore = 1;
    let bestDistance = 0;
    for (const view of this.system.bodies.values()) {
      if (!this.labels.isListed(view)) continue;
      _v.copy(view.group.position).sub(origin);
      const distance = _v.length();
      const along = _v.dot(direction);
      if (along <= 0) continue;
      const angle = Math.acos(Math.min(1, along / distance));
      const reach = Math.max(ASSIST_ANGLE, Math.atan(view.radius / distance) * 1.25);
      const score = angle / reach;
      if (score < bestScore) {
        bestScore = score;
        best = view;
        bestDistance = Math.max(distance - view.radius, 0);
      }
    }
    if (!best) return null;
    hit.type = 'body';
    hit.id = best.id;
    hit.distance = bestDistance;
    return hit;
  }

  /** A light tick in the hand whenever the ray moves onto something new. */
  _setHover(hand, hit) {
    const type = hit?.type ?? null;
    const id = hit?.id ?? null;
    if (type === hand.hoverType && id === hand.hoverId) return;
    hand.hoverType = type;
    hand.hoverId = id;
    if (id) pulse(hand.source, 0.15, 10);
  }

  _onSelect(hand) {
    if (!this.presenting || !this._ready) return;
    // Hit-test afresh: a tap on a screen or a gaze click may be the only
    // frame that input source is ever seen in.
    this.rig.updateMatrixWorld(true);
    const hit = this._hitTest(hand);
    if (!hit) return;
    if (hit.type === 'panel') {
      if (!hit.id) return;
      pulse(hand.source, 0.4, 20);
      this._onPanel(hit.id);
      return;
    }
    pulse(hand.source, 0.6, 35);
    this.actions.select(hit.id);
  }

  /* --- panel -------------------------------------------------------------- */

  /**
   * On the left controller, like a palette, when there is one. With bare
   * hands or a single controller it floats in front of the viewer instead,
   * low enough to look over.
   */
  _placePanel() {
    if (!this.active) return;
    const left = this.hands.find((hand) =>
      hand.source?.handedness === 'left' && hand.source.gamepad && !hand.source.hand);
    if (left) this.panel.attach(this.rig, left);
    else this.panel.float(this.rig, this.camera);
  }

  _onPanel(id) {
    const { actions } = this;
    switch (id) {
      case 'prev': actions.step(-1); break;
      case 'next': actions.step(1); break;
      case 'overview': actions.overview(); break;
      case 'reframe': this.reframe(); break;
      case 'slower': actions.stepRate(-1); break;
      case 'pause': actions.togglePause(); break;
      case 'faster': actions.stepRate(1); break;
      case 'now': actions.now(); break;
      case 'zoom-in': this._zoom(1 / ZOOM_STEP); break;
      case 'zoom-out': this._zoom(ZOOM_STEP); break;
      case 'labels': this.settings.set('showLabels', !this.settings.get('showLabels')); break;
      case 'exit': this.end(); break;
      default: break;
    }
    this.panel.invalidate();
  }

  /** The body some hand's ray is on, if any. */
  _pointedId() {
    for (const hand of this.hands) if (hand.hoverType === 'body') return hand.hoverId;
    return null;
  }

  _describe() {
    const pointedId = this._pointedId();
    // The visitor is not in the catalogue, and is not about to introduce itself.
    const pointing = pointedId && (this.system.bodies.get(pointedId)?.name ?? 'Something');
    return {
      body: this.focus?.body ?? null,
      date: this.clock.formatDate(),
      time: this.clock.formatTime(),
      rate: this.clock.describeRate(),
      paused: this.clock.paused,
      pointing,
      pointingAtFocus: Boolean(pointing) && this._pointedId() === this.focus?.id,
      labels: this.settings.get('showLabels'),
    };
  }
}

/** Resolved once, on the first call to VRMode.preload(). */
let modelFactories = null;

function clampScale(scale) {
  return THREE.MathUtils.clamp(scale, MIN_SCALE, MAX_SCALE);
}

/**
 * Heading of a direction round the vertical axis. Rotating about +Y by θ adds
 * θ to it, so the turn that takes one direction to another is the difference.
 */
function yawOf(v) {
  return Math.atan2(v.x, v.z);
}

/** Dead zone plus a squared response, so small deflections allow fine control. */
function response(value) {
  const magnitude = Math.abs(value);
  if (magnitude < DEAD_ZONE) return 0;
  return Math.sign(value) * ((magnitude - DEAD_ZONE) / (1 - DEAD_ZONE)) ** 2;
}

/** A haptic tick, on whichever vibration API the controller offers. */
function pulse(source, intensity, ms) {
  const pad = source?.gamepad;
  if (!pad) return;
  try {
    const actuator = pad.hapticActuators?.[0];
    if (actuator?.pulse) actuator.pulse(intensity, ms)?.catch?.(() => {});
    else pad.vibrationActuator?.playEffect?.('dual-rumble', {
      duration: ms, strongMagnitude: intensity, weakMagnitude: intensity,
    })?.catch?.(() => {});
  } catch {
    // No haptics is no loss.
  }
}

/**
 * A sphere round the eyes, for fading through black. Well inside the near
 * plane of anything else and drawn last, over everything.
 */
function buildFade() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 16, 8),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
  );
  mesh.name = 'vr-fade';
  mesh.renderOrder = 1e9;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

/**
 * The pointer: a beam that fades out along its length, and a dot where it
 * touches something. Drawn over everything, since the only thing it can meet
 * is what it is pointing at.
 */
function buildLaser() {
  const group = new THREE.Group();
  group.name = 'vr-laser';
  group.visible = false;

  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const { r, g, b } = ACCENT;
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([r, g, b, 0.9, r, g, b, 0.15], 4));
  const beam = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  }));
  beam.renderOrder = 1e8 + 1;
  beam.frustumCulled = false;

  const cursor = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, depthWrite: false, transparent: true, toneMapped: false })
  );
  cursor.renderOrder = 1e8 + 2;
  cursor.frustumCulled = false;

  group.add(beam, cursor);
  group.userData = { beam, cursor };
  return group;
}

/**
 * Controller and hand models are lit for a room, and the only light here is
 * the Sun - on the night side of a planet they would be black. A little
 * emission of their own keeps them visible anywhere.
 */
function brighten(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = false;
    for (const material of [child.material].flat()) {
      if (!material?.isMeshStandardMaterial) continue;
      material.emissive.copy(material.color).multiplyScalar(0.45);
      material.emissiveMap = material.map;
      material.needsUpdate = true;
    }
  });
}
