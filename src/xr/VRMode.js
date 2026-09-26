/**
 * Virtual reality.
 *
 * In a headset the camera is the viewer's head, so the app moves a rig the
 * head stands in instead: a group with a position, a heading and a uniform
 * scale. The scene is in units where the Earth is 48 across and a headset
 * measures in metres, so the rig is rescaled to suit what is being looked at:
 * a focused planet becomes a globe a little under two metres across, a couple
 * of metres away; the whole system becomes a tabletop orrery. The eyes ride in
 * the rig too, so stereo separation scales with it and depth reads as a model
 * of that size.
 *
 * Nothing flies the viewer anywhere, since a camera sweep is motion the eyes
 * see and the inner ear never feels. Moving between bodies is a short fade
 * through black. The only continuous motion comes from a thumbstick or the
 * viewer's hands, and a thumbstick narrows the view a little while it moves
 * them.
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
 * With bare hands, the gestures follow Quest's own interface:
 *
 *   Pinch             point and select, as the trigger does
 *   Pinch and drag    grab the system and move it, as the grip does; both
 *                     hands to scale and turn it
 *   Fingertip         press the panel's buttons by touching them
 *   Left palm up      bring the panel to hand; it stays put when the hand drops
 *
 * A pinch has to do the grip's job too: Quest reserves the palm-up pinch for
 * its own menu and sends no squeeze for a hand. So a pinch that stays put is a
 * click, and one that moves a few centimetres becomes a grab. A click selects
 * whatever the ray was on when the fingers met, since pinching tugs the ray
 * off its target.
 */

import * as THREE from 'three';
import { heliocentricDistance } from '../scene/scaling.js';
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

/**
 * Most the frame is ever scaled up over the runtime's default size. A Quest's
 * default is roughly 0.7x its panels, which is what makes stars and text soft;
 * its native size is well inside this.
 */
const MAX_FRAMEBUFFER_SCALE = 1.5;

const FADE_OUT_S = 0.15;
const FADE_IN_S = 0.3;

const DEAD_ZONE = 0.15;
/** Flying speed at full deflection, in metres per second at the current scale. */
const FLY_SPEED_M = 1.8;
const BOOST = 4;
/** Within this many metres of a surface, flying eases off, so you arrive rather than hit. */
const EASE_M = 0.6;
/** Closest the viewer may get to a surface, as a fraction of its radius. */
const CLEARANCE = 0.08;
/** Zoom rate at full deflection, in e-folds of scale per second. */
const ZOOM_RATE = 1.5;
/** One press of a panel zoom button. */
const ZOOM_STEP = 1.8;
const SNAP_TURN = THREE.MathUtils.degToRad(30);

/** A body this far off the ray, in radians, still counts as pointed at when it is small. */
const ASSIST_ANGLE = THREE.MathUtils.degToRad(2);
/** Laser length when it is not touching anything. */
const RAY_LENGTH_M = 6;

/** A pinch that travels this far, in metres, is a grab rather than a click. */
const DRAG_START_M = 0.03;
/**
 * Pressing the panel with a fingertip, in metres from its face: close enough
 * to hide that hand's ray, close enough to light a button up, touching it
 * (the tip joint sits about this far inside the pad of the finger), and far
 * enough back out to let go.
 */
const POKE_NEAR_M = 0.08;
const POKE_HOVER_M = 0.04;
const POKE_PRESS_M = 0.008;
const POKE_RELEASE_M = 0.025;
/** Cosines: how squarely a palm must face the eyes to bring the panel, and to let it go. */
const PALM_SHOW = 0.7;
const PALM_HIDE = 0.35;
/** ...and how near the middle of the view the hand must be. */
const PALM_IN_VIEW = 0.6;

/** Controllers and hands, plus room for momentary pointers such as a gaze-and-pinch. */
const INPUT_SLOTS = 4;

/** The comfort vignette's easing rate, per second. */
const VIGNETTE_RATE = 8;

/** Where three looks for controller and hand models; see VRMode.preload. */
const PROFILES_URL = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles';

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
    // The models themselves come from a CDN, one per make of controller. An
    // installed copy used offline cannot reach it, and three would then show
    // nothing at all: no controllers, and no hands. Asking first means falling
    // back to shapes that need no download.
    modelFactories ??= Promise.all([
      import('three/addons/webxr/XRControllerModelFactory.js'),
      import('three/addons/webxr/XRHandModelFactory.js'),
      canReach(`${PROFILES_URL}/generic-hand/left.glb`),
    ]).then(
      ([controllers, hands, online]) => ({
        controllers: online ? new controllers.XRControllerModelFactory() : null,
        hands: new hands.XRHandModelFactory(),
        handProfile: online ? 'mesh' : 'spheres',
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
    /** What the overview is centred on and follows, when not the system's centre. */
    this._anchor = null;
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

    this.panel = new VRPanel(this.system.catalogue.name);
    this._fade = buildFade();
    this._vignette = buildVignette();
    this._motion = 0;
    this._overviewAU = this.system.catalogue.overviewAU;
    /** The hand whose open palm is holding the panel up, if one is, and where that palm is. */
    this._summoner = null;
    this._palm = new THREE.Vector3();
    this._recentred = false;

    this.hands = [];
    this._hovered = new Set();
    this._headUp = new THREE.Vector3(0, 1, 0);
    this._headRight = new THREE.Vector3(1, 0, 0);
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
      // Draw at the panels' own resolution rather than the runtime's
      // cheaper default.
      this.renderer.xr.setFramebufferScaleFactor(nativeScale(session));
      // three turns fixed foveation all the way up unless told otherwise,
      // which smears everything outside the middle of the view.
      this.renderer.xr.setFoveation(0);

      this.session = session;
      this._enter();
      try {
        await this.renderer.xr.setSession(session);
        // Recentring (holding the Meta button) swings the world round the
        // viewer. Whatever they were looking at is then off to one side.
        this.renderer.xr.getReferenceSpace()?.addEventListener('reset', () => {
          this._recentred = true;
        });
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

  /** The whole system, as a model on a table; or, with `centre`, one body's surroundings. */
  overview(radiusAU = this.system.catalogue.overviewAU, { instant = false, centre = null } = {}) {
    if (!this.active) return;
    this._overviewAU = radiusAU;
    this._setFocus(null);
    this._anchor = centre;
    if (centre) this._lastFocus.copy(centre.group.position);
    this._goTo(() => this._frameSystem(radiusAU), instant);
  }

  reframe() {
    if (this.focus) this.focusOn(this.focus);
  }

  _setFocus(view) {
    this.focus = view;
    this._anchor = null;
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
    const sun = this._anchor?.group.position ?? this.system.root.position;
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
    camera.add(this._fade, this._vignette);
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

    for (const hand of this.hands) this._release(hand);
    this._summoner = null;
    this._recentred = false;
    this._motion = 0;
    this._setVignette(0);
    this._hovered.clear();
    this.labels.setActive(false);
    this.panel.detach();

    const camera = this.camera;
    camera.remove(this._fade, this._vignette);
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
    if (this._recentred) this._recentre();
    this._advanceTransition(dt);
    this._updatePinches();
    this._readInput(dt);
    this._syncHead();

    this._updatePalm();
    if (this._summoner) this.panel.besidePalm(this.rig, this._palm, 'left', this.camera);
    else this.panel.follow(this.camera);
    this._updatePoke();
    this._updatePointers();
    this._headUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    this._headRight.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    this.labels.update(this.viewerPosition, this._headUp, this._headRight, this.scale, this._hovered);
    // The panel redraws a few times a second at most; only then is its text worth working out.
    if (this.panel.due()) this.panel.update(this._describe());
    this._updateClipping();
    this._updateVignette(dt);
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

    const frame = this._pending ?? (() => this._frameSystem(this._overviewAU));
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
    const followed = this.focus ?? this._anchor;
    if (!followed) return;
    _v.copy(followed.group.position).sub(this._lastFocus);
    this._lastFocus.copy(followed.group.position);
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

  /**
   * After a recentre: the same view again, straight ahead. A floating panel
   * comes back in front too; one in a hand is already wherever the hand is.
   */
  _recentre() {
    this._recentred = false;
    if (this.focus) this._goTo(() => this._frameBody(this.focus), false);
    else this._goTo(() => this._frameSystem(this._overviewAU), false);
    if (!this.panel.holder) this.panel.float(this.rig, this.camera);
  }

  /**
   * Closes the view in from the edges while a thumbstick is moving the
   * viewer: peripheral motion is most of what makes artificial locomotion
   * uncomfortable. A grab never triggers it, since the body is making that
   * motion itself.
   */
  _updateVignette(dt) {
    const target = this._motion;
    this._motion = 0;
    const current = this._vignette.material.uniforms.strength.value;
    this._setVignette(current + (target - current) * Math.min(1, dt * VIGNETTE_RATE));
  }

  _setVignette(strength) {
    this._vignette.material.uniforms.strength.value = strength;
    this._vignette.visible = strength > 0.01;
  }

  /** Near and far, in metres. The far plane moves out as the viewer shrinks. */
  _updateClipping() {
    const far = THREE.MathUtils.clamp((heliocentricDistance(this.system.catalogue.edgeAU, this.system.scaleExponent) * 6) / this.scale, 1000, MAX_FAR_M);
    // Only on a real change: each one is a render-state update for the session.
    if (Math.abs(Math.log(far / this.camera.far)) > 0.7) this.camera.far = far;
    this.camera.near = NEAR_M;
  }

  /* --- controllers -------------------------------------------------------- */

  _setupHands(factories) {
    if (this.hands.length) return;
    const xr = this.renderer.xr;
    if (factories?.controllers) factories.controllers.onLoad = brighten;
    if (factories) factories.hands.onLoad = brighten;

    for (let index = 0; index < INPUT_SLOTS; index++) {
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
        /** A hand's pinch in progress: where it started, what it was on, and whether it became a grab. */
        pinch: null,
        lastPinch: null,
        /** Fingertip on the panel: near enough to hide the ray, the button under it, and pressed. */
        pokeNear: false,
        pokeHover: null,
        poked: false,
        pokeZ: NaN,
      };
      hand.ray.add(hand.laser);

      const standIn = factories?.controllers ? null : buildControllerStandIn();
      if (factories?.controllers) hand.grip.add(factories.controllers.createControllerModel(hand.grip));
      if (standIn) hand.grip.add(standIn);
      if (factories) {
        const model = factories.hands.createHandModel(hand.hand, factories.handProfile);
        hand.hand.add(model);
        // The primitive hand is lit for a room too. Its spheres exist once it has connected.
        if (factories.handProfile !== 'mesh') hand.hand.addEventListener('connected', () => brighten(model));
      }

      hand.ray.addEventListener('connected', (event) => {
        const source = event.data;
        hand.source = source;
        hand.side = source.handedness === 'left' ? 'left' : 'right';
        hand.was.length = 0;
        if (standIn) standIn.visible = source.targetRayMode === 'tracked-pointer' && !source.hand;
        // A momentary pointer comes and goes with every pinch; the panel stays where it is.
        if (source.targetRayMode !== 'transient-pointer') this._placePanel();
      });
      hand.ray.addEventListener('disconnected', () => {
        const transient = hand.source?.targetRayMode === 'transient-pointer';
        this._release(hand);
        hand.source = null;
        hand.laser.visible = false;
        if (!transient) this._placePanel();
      });
      hand.ray.addEventListener('selectstart', () => this._onPinchStart(hand));
      hand.ray.addEventListener('selectend', () => this._onPinchEnd(hand));
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
      // A tracked hand has a gamepad too, but only to report its pinch.
      if (!pad || hand.source.hand) continue;
      // xr-standard puts the thumbstick on axes 2 and 3; controllers with only
      // a touchpad report it on 0 and 1.
      const axes = pad.axes;
      const x = axes.length >= 4 ? axes[2] : (axes[0] ?? 0);
      const y = axes.length >= 4 ? axes[3] : (axes[1] ?? 0);
      const pressed = (i) => Boolean(pad.buttons[i]?.pressed);
      const tapped = (i) => pressed(i) && !hand.was[i];

      if (hand.side === 'left') {
        if (!fading && Math.hypot(x, y) > DEAD_ZONE) {
          const step = FLY_SPEED_M * this.scale * (pressed(STICK_BUTTON) ? BOOST : 1) *
            this._easeNearSurface() * dt;
          _v.set(0, 0, -1).transformDirection(hand.ray.matrixWorld);
          _w.set(1, 0, 0).transformDirection(hand.ray.matrixWorld);
          this.rig.position
            .addScaledVector(_v, response(-y) * step)
            .addScaledVector(_w, response(x) * step);
          this._keepOutside();
          this._motion = Math.max(this._motion, Math.min(1, Math.hypot(response(x), response(y))));
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
          this._motion = Math.max(this._motion, Math.abs(response(y)));
        }
        if (tapped(FACE_LOWER)) this.actions.togglePause();
        if (tapped(FACE_UPPER)) this.actions.overview();
        if (tapped(STICK_BUTTON)) this.reframe();
      }

      for (let i = 0; i < pad.buttons.length; i++) hand.was[i] = pad.buttons[i].pressed;
    }

    this._applyGrab();
  }

  /** 1 in open space, down to a quarter close to a surface. */
  _easeNearSurface() {
    this._refreshViewer();
    let altitude = Infinity;
    for (const view of this.system.bodies.values()) {
      if (!view.visible) continue;
      altitude = Math.min(altitude, this.viewerPosition.distanceTo(view.group.position) - view.radius);
    }
    return THREE.MathUtils.clamp(altitude / this.scale / EASE_M, 0.25, 1);
  }

  /**
   * Surfaces are solid, as they are in desktop flight: from inside, a planet's
   * surface is culled away and the viewer is suddenly nowhere.
   */
  _keepOutside() {
    this._refreshViewer();
    for (const view of this.system.bodies.values()) {
      if (!view.visible) continue;
      const minimum = view.radius * (1 + CLEARANCE);
      _v.copy(this.viewerPosition).sub(view.group.position);
      const distance = _v.length();
      if (distance >= minimum || distance === 0) continue;
      this.rig.position.addScaledVector(_v, minimum / distance - 1);
      this._refreshViewer();
    }
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
    const body = this.focus ?? this._anchor ?? this.system.bodies.get(this.system.catalogue.starId);
    const pivot = body.group.position;
    let k = clampScale(this.scale * factor) / this.scale;
    if (k < 1) {
      // Stop at the surface, rather than zooming the viewer inside the body.
      this._refreshViewer();
      const distance = this.viewerPosition.distanceTo(pivot);
      k = Math.max(k, Math.min(1, (body.radius * 1.2) / Math.max(distance, 1e-9)));
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
      if (hand.squeezing) this._handPoint(hand, hand.anchor).applyMatrix4(this.rig.matrixWorld);
    }
  }

  /**
   * The point a hand holds things by, in the rig's own space, in metres: a
   * controller's tip, or the meeting point of a pinch. A hand's pointing ray
   * starts back near the wrist and swings as the fingers close, so it would
   * make a shaky handle.
   */
  _handPoint(hand, out) {
    const joints = hand.source?.hand ? hand.hand.joints : null;
    const thumb = joints?.['thumb-tip'];
    const index = joints?.['index-finger-tip'];
    if (thumb?.visible && index?.visible) return out.addVectors(thumb.position, index.position).multiplyScalar(0.5);
    return out.setFromMatrixPosition(hand.ray.matrix);
  }

  _release(hand) {
    hand.squeezing = false;
    hand.pinch = null;
    hand.lastPinch = null;
    hand.hoverType = null;
    hand.hoverId = null;
    hand.pokeNear = false;
    hand.pokeHover = null;
    hand.poked = false;
    hand.pokeZ = NaN;
    if (this._summoner === hand) {
      this._summoner = null;
      this.panel.holder = null;
    }
  }

  /**
   * One hand drags the world: the point under the hand when the grip closed
   * stays under it. Two hands also scale and turn it, keeping both held points
   * under their hands.
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
      this._handPoint(a, _v).applyMatrix4(this.rig.matrixWorld);
      this.rig.position.add(_w.copy(a.anchor).sub(_v));
      this._applyRig();
      return;
    }

    // Both hands' positions in the rig's own space, in metres.
    this._handPoint(a, _v);
    this._handPoint(b, _w);
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
      // A fingertip at the panel is about to touch it, not point at it; and
      // a palm turned up to hold the panel is not pointing anywhere, which is
      // also when Quest hides its own pointer.
      const pointing = (mode === 'tracked-pointer' || mode === 'gaze') &&
        !hand.squeezing && !hand.pokeNear && hand !== this._summoner;
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
      // A hand gets no click to feel, so the dot closes up as the fingers do,
      // as Quest's own cursor does.
      cursor.scale.setScalar(Math.max(length * 0.003, 0.0012) * (0.45 + 0.55 * this._pinchOpenness(hand)));
    }

    // A fingertip beats a ray: it is the closer and more deliberate of the two.
    const poked = this.hands.find((hand) => hand.pokeHover)?.pokeHover;
    this.panel.setHover(poked ?? panelButton);
  }

  /** 1 for a hand held open, falling to 0 as the thumb and forefinger meet. Always 1 for a controller. */
  _pinchOpenness(hand) {
    const joints = hand.source?.hand ? hand.hand.joints : null;
    const thumb = joints?.['thumb-tip'];
    const index = joints?.['index-finger-tip'];
    if (!thumb?.visible || !index?.visible) return 1;
    return THREE.MathUtils.clamp((thumb.position.distanceTo(index.position) - 0.01) / 0.04, 0, 1);
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
    // The panel names what is pointed at; say so now, not at its next redraw.
    this.panel.invalidate();
    if (id) pulse(hand.source, 0.15, 10);
  }

  _onSelect(hand) {
    if (!this.presenting || !this._ready) return;
    const pinch = hand.pinch ?? hand.lastPinch;
    hand.lastPinch = null;
    let hit = pinch?.target;
    if (pinch && (pinch.blocked || pinch.dragging)) return;
    if (!pinch) {
      // Hit-test afresh: a tap on a screen or a gaze click may be the only
      // frame that input source is ever seen in.
      this.rig.updateMatrixWorld(true);
      hit = this._hitTest(hand);
    }
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

  /* --- hands ------------------------------------------------------------- */

  /**
   * A pinch begins. What the ray is on now is what a click will select: the
   * fingers closing pull the ray down and in, and by the time they part again
   * it can be pointing at something else entirely.
   */
  _onPinchStart(hand) {
    hand.lastPinch = null;
    if (!hand.source?.hand || !this.presenting || !this._ready) return;
    // A finger at the panel is pressing it, and a pinch there is incidental.
    // A pinch with the palm turned up is Quest's own menu gesture.
    if (hand.pokeNear || hand === this._summoner) {
      hand.pinch = { blocked: true };
      return;
    }
    this.rig.updateMatrixWorld(true);
    const hit = this._hitTest(hand);
    hand.pinch = {
      start: this._handPoint(hand, new THREE.Vector3()),
      target: hit ? { type: hit.type, id: hit.id } : null,
      dragging: false,
    };
    // With the other hand already holding on, this is the second half of a
    // two-handed grab: no need to wait for it to move.
    if (hand.pinch.target?.type !== 'panel' && this._grabbing(1)) this._startDrag(hand);
  }

  _onPinchEnd(hand) {
    if (hand.pinch?.dragging) {
      hand.squeezing = false;
      this._regrab();
    }
    // 'select' normally arrives first, but in case it comes after.
    hand.lastPinch = hand.pinch;
    hand.pinch = null;
  }

  /** A pinch that has moved far enough becomes a grab, held from where the fingers are now. */
  _updatePinches() {
    for (const hand of this.hands) {
      const pinch = hand.pinch;
      if (!pinch || pinch.blocked || pinch.dragging || pinch.target?.type === 'panel') continue;
      if (this._handPoint(hand, _v).distanceTo(pinch.start) > DRAG_START_M) this._startDrag(hand);
    }
  }

  _startDrag(hand) {
    hand.pinch.dragging = true;
    hand.squeezing = true;
    this._regrab();
  }

  /**
   * Pressing the panel with a fingertip. A press needs the finger to arrive
   * from in front and cross the face; it lets go once the finger is back out,
   * so resting a finger on a button presses it once, not once a frame.
   */
  _updatePoke() {
    for (const hand of this.hands) {
      hand.pokeNear = false;
      hand.pokeHover = null;
      const tip = hand.source?.hand && hand !== this.panel.holder ? hand.hand.joints['index-finger-tip'] : null;
      const local = tip?.visible ? this.panel.toLocal(tip.getWorldPosition(_v)) : null;
      if (!local) {
        hand.poked = false;
        hand.pokeZ = NaN;
        continue;
      }

      const z = local.z;
      hand.pokeNear = this.panel.covers(local, 0.02) && z > -0.04 && z < POKE_NEAR_M;
      const button = hand.pokeNear ? this.panel.buttonAtLocal(local) : null;
      if (z < POKE_HOVER_M) hand.pokeHover = button;

      if (hand.poked) {
        if (z > POKE_RELEASE_M || !hand.pokeNear) hand.poked = false;
      } else if (button && z < POKE_PRESS_M && hand.pokeZ >= POKE_PRESS_M) {
        hand.poked = true;
        this._onPanel(button);
      }
      hand.pokeZ = z;
    }
  }

  /**
   * Turn the left palm to the eyes and the panel comes to it, beside the
   * hand, where the other hand can reach it; lower the hand and the panel
   * stays where it was left. The same gesture as Quest's own menus, but with
   * no pinch, since that one belongs to the system.
   */
  _updatePalm() {
    if (this.panel.holder && this.panel.holder !== this._summoner) return; // on a controller
    const hand = this.hands.find((h) => h.source?.hand && h.source.handedness === 'left');
    if (!hand) {
      if (this._summoner) this._release(this._summoner);
      return;
    }
    const facing = this._palmFacing(hand, this._palm);
    if (this._summoner === hand) {
      if (facing < PALM_HIDE) {
        this._summoner = null;
        this.panel.holder = null;
      }
    } else if (facing > PALM_SHOW && !hand.pinch && !hand.squeezing) {
      this._summoner = hand;
      this.panel.holder = hand;
    }
  }

  /**
   * How squarely a hand's palm faces the eyes, as a cosine, with the palm's
   * centre left in `centre`; -1 when the hand is not tracked or not in view.
   * The palm's normal comes from the knuckles either side of it rather than a
   * joint's orientation, which leaves nothing to get wrong about axes.
   */
  _palmFacing(hand, centre) {
    const joints = hand.hand.joints;
    const wrist = joints.wrist;
    const index = joints['index-finger-metacarpal'];
    const pinky = joints['pinky-finger-metacarpal'];
    const middle = joints['middle-finger-metacarpal'];
    if (!wrist?.visible || !index?.visible || !pinky?.visible || !middle?.visible) return -1;

    _v.subVectors(index.position, wrist.position);
    _w.subVectors(pinky.position, wrist.position);
    // Out of the palm, not the back of the hand: the knuckles run the other
    // way round on a left hand.
    const normal = _dir.crossVectors(_v, _w).normalize();
    if (hand.source.handedness === 'left') normal.negate();

    centre.copy(middle.position);
    const toEyes = _v.copy(this.camera.position).sub(centre).normalize();
    const ahead = _w.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    if (-toEyes.dot(ahead) < PALM_IN_VIEW) return -1;
    return normal.dot(toEyes);
  }

  /* --- panel -------------------------------------------------------------- */

  /**
   * On the left controller, like a palette, when there is one. With bare
   * hands or a single controller it floats in front of the viewer instead,
   * low enough to look over.
   */
  _placePanel() {
    // Controllers announce themselves before the first head pose arrives, and
    // a panel floated then would be placed from where the page's camera was.
    // The first frame places it instead.
    if (!this.active || !this._ready) return;
    const left = this.hands.find((hand) =>
      hand.source?.handedness === 'left' && hand.source.gamepad && !hand.source.hand);
    const onController = this.panel.holder && this.panel.holder !== this._summoner;
    if (left) {
      this._summoner = null;
      this.panel.attach(this.rig, left);
    } else if (!this.panel.mesh.parent || onController) {
      // Put down in front, unless it is already floating somewhere.
      this._summoner = null;
      this.panel.float(this.rig, this.camera);
    }
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
    this.panel.flash(id);
  }

  _pointedId() {
    for (const hand of this.hands) if (hand.hoverType === 'body') return hand.hoverId;
    return null;
  }

  _describe() {
    const pointedId = this._pointedId();
    // The visitor has no catalogue entry, hence no name.
    const pointing = pointedId && (this.system.bodies.get(pointedId)?.name ?? 'Something');
    // Hands, when there are no controllers: the panel's hints then talk about pinching.
    const controllers = this.hands.some((hand) =>
      hand.source && !hand.source.hand && hand.source.targetRayMode === 'tracked-pointer');
    return {
      hands: !controllers && this.hands.some((hand) => hand.source?.hand),
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

async function canReach(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

function clampScale(scale) {
  return THREE.MathUtils.clamp(scale, MIN_SCALE, MAX_SCALE);
}

/** How far the frame has to be scaled over the runtime's default to match the panels. */
function nativeScale(session) {
  let native = 1;
  try {
    native = XRWebGLLayer.getNativeFramebufferScaleFactor(session) || 1;
  } catch {
    // Not every runtime says; its default will have to do.
  }
  return THREE.MathUtils.clamp(native, 1, MAX_FRAMEBUFFER_SCALE);
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
 * The comfort vignette: another sphere round the eyes, clear straight ahead
 * and darkening towards the edges of the view. `strength` runs from 0, where
 * the dark begins behind the viewer and nothing shows, to 1, where only the
 * middle forty degrees or so stay clear.
 */
function buildVignette() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: { strength: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float strength;
        varying vec3 vDirection;
        void main() {
          float angle = acos(clamp(-normalize(vDirection).z, -1.0, 1.0));
          float inner = mix(1.9, 0.38, strength);
          float alpha = smoothstep(inner, inner + 0.5, angle) * min(1.0, strength * 2.0) * 0.92;
          gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
        }`,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
  );
  mesh.name = 'vr-vignette';
  mesh.renderOrder = 1e9 - 1;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

/**
 * A plain controller, for when the real model cannot be fetched: something
 * to see where the hand is, and where the ray comes from.
 */
function buildControllerStandIn() {
  const group = new THREE.Group();
  group.name = 'vr-controller-stand-in';
  group.visible = false;
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.016, 0.07, 4, 12),
    new THREE.MeshBasicMaterial({ color: 0x55585f, toneMapped: false })
  );
  // Along the grip, tipped forward the way a hand holds one.
  body.rotation.x = Math.PI / 2 - 0.35;
  body.position.set(0, -0.005, 0.02);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.028, 0.004, 8, 32),
    new THREE.MeshBasicMaterial({ color: ACCENT, toneMapped: false })
  );
  ring.position.set(0, 0.01, -0.035);
  ring.rotation.x = -0.35;
  group.add(body, ring);
  return group;
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
 * the Sun, so on a planet's night side they would be black. A little emission
 * keeps them visible.
 *
 * They are also drawn after the panel, so a fingertip pressing a button is
 * seen touching it rather than vanishing behind it. Only the transparent pass
 * is ordered that way, hence the flag; at full opacity it changes nothing
 * else.
 */
function brighten(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = false;
    child.renderOrder = 1e8 + 3;
    for (const material of [child.material].flat()) {
      if (!material?.isMeshStandardMaterial) continue;
      material.emissive.copy(material.color).multiplyScalar(0.45);
      material.emissiveMap = material.map;
      material.transparent = true;
      material.needsUpdate = true;
    }
  });
}
