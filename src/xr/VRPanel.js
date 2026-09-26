/**
 * The page's interface in VR. No DOM reaches a headset, so it is drawn on a
 * canvas on a plane that floats above the left controller like a palette,
 * always upright and turned to the eyes. With bare hands it is summoned by
 * turning the left palm to the eyes, and stays put when the hand drops.
 *
 * Buttons are six centimetres by three, a centimetre apart, over the 22 by 22
 * millimetres and 12 millimetre gaps Meta asks of anything meant to be
 * touched. Text is sized with the same guide's legibility floor in mind, about
 * 24 millimetres tall a metre away.
 */

import * as THREE from 'three';
import { BODY_BY_ID } from '../data/bodies.js';
import { KIND_LABEL } from '../ui/InfoPanel.js';

/** Canvas pixels, and the plane's size in metres: about 3.4 pixels to the millimetre. */
const WIDTH = 1024;
const HEIGHT = 728;
const WIDTH_M = 0.3;
const HEIGHT_M = WIDTH_M * (HEIGHT / WIDTH);

const PAD = 36;
const GRID_TOP = 236;
const GRID_GAP = 36;
const COLUMNS = 4;
const BUTTON_HEIGHT = 100;
const BUTTON_WIDTH = (WIDTH - PAD * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS;

/** Redraws are cheap but not free; the date only changes this often anyway. */
const REDRAW_MS = 200;
/** How long a pressed button stays lit: a fingertip gets no click, so this is the click. */
const FLASH_MS = 180;

const COLORS = {
  plate: 'rgba(9, 10, 14, 0.94)',
  line: 'rgba(255, 255, 255, 0.16)',
  button: 'rgba(255, 255, 255, 0.06)',
  hover: 'rgba(243, 189, 110, 0.2)',
  pressed: 'rgba(243, 189, 110, 0.45)',
  text: '#eeece6',
  dim: 'rgba(238, 236, 230, 0.62)',
  faint: 'rgba(238, 236, 230, 0.5)',
  accent: '#f3bd6e',
};

/** Row by row. `label` may be a function of the panel's state. */
const BUTTONS = [
  { id: 'prev', label: '‹  Previous' },
  { id: 'overview', label: 'Whole system' },
  { id: 'next', label: 'Next  ›' },
  { id: 'reframe', label: 'Re-frame', enabled: (s) => Boolean(s.body) },
  { id: 'slower', label: 'Slower' },
  { id: 'pause', label: (s) => (s.paused ? 'Play' : 'Pause'), active: (s) => s.paused },
  { id: 'faster', label: 'Faster' },
  { id: 'now', label: 'Now' },
  { id: 'zoom-out', label: 'Zoom out' },
  { id: 'zoom-in', label: 'Zoom in' },
  { id: 'labels', label: 'Labels', active: (s) => s.labels },
  { id: 'exit', label: 'Exit VR' },
].map((button, index) => ({
  ...button,
  x: PAD + (index % COLUMNS) * (BUTTON_WIDTH + GRID_GAP),
  y: GRID_TOP + Math.floor(index / COLUMNS) * (BUTTON_HEIGHT + GRID_GAP),
  w: BUTTON_WIDTH,
  h: BUTTON_HEIGHT,
}));

const LEGEND_Y = GRID_TOP + 3 * BUTTON_HEIGHT + 2 * GRID_GAP + 44;

const LEGEND = {
  controllers: [
    'Trigger: select · Grip: grab and move · Both grips: scale and turn',
    'Left stick: fly · Right stick: turn and zoom',
  ],
  hands: [
    'Pinch: select · Pinch and drag: move · Pinch with both hands: scale and turn',
    'Touch a button with a fingertip · Turn your left palm to you to bring this back',
  ],
};

/** Held: how far above the controller the panel's centre floats, in metres. */
const HOLD_ABOVE_M = 0.05 + HEIGHT_M / 2;
/** Summoned by a hand: how far to the side of the palm its near edge floats. */
const BESIDE_PALM_M = 0.05;

const UP = new THREE.Vector3(0, 1, 0);
const _toEyes = new THREE.Vector3();
const _side = new THREE.Vector3();
const _local = new THREE.Vector3();

export class VRPanel {
  constructor(systemName = 'Solar System') {
    this.systemName = systemName;
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.context = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH_M, HEIGHT_M),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        // Always readable: never cut into by a planet the hand has wandered into.
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this.mesh.name = 'vr-panel';
    this.mesh.renderOrder = 1e8;

    /** The hand holding it, which is then not allowed to point at it. */
    this.holder = null;

    this._raycaster = new THREE.Raycaster();
    this._hover = null;
    this._flash = null;
    this._flashUntil = 0;
    this._state = null;
    this._signature = '';
    this._lastDraw = 0;
    this._fonts = null;
  }

  /** Floats it above a controller; see {@link VRPanel#follow}. */
  attach(rig, holder) {
    rig.add(this.mesh);
    this.holder = holder;
  }

  /**
   * Keeps a held panel over its controller and facing the eyes. Everything
   * here is in the rig's own space, in metres, and the rig is always upright.
   */
  follow(camera) {
    const grip = this.holder?.grip;
    if (!grip?.visible) return;
    this.mesh.position.setFromMatrixPosition(grip.matrix);
    this.mesh.position.y += HOLD_ABOVE_M;
    this._faceEyes(camera);
  }

  /**
   * Keeps the panel beside an open palm, on the side towards the middle of
   * the body, where the other hand can reach it without crossing the first.
   * `palm` and `camera` are in the rig's space, in metres.
   */
  besidePalm(rig, palm, handedness, camera) {
    if (this.mesh.parent !== rig) rig.add(this.mesh);
    _toEyes.copy(camera.position).sub(palm).setY(0);
    if (_toEyes.lengthSq() < 1e-6) _toEyes.set(0, 0, 1);
    // To the viewer's right of a left hand, and to the left of a right one.
    _side.crossVectors(UP, _toEyes).normalize();
    if (handedness !== 'left') _side.negate();
    this.mesh.position.copy(palm).addScaledVector(_side, BESIDE_PALM_M + WIDTH_M / 2);
    this._faceEyes(camera);
  }

  _faceEyes(camera) {
    _toEyes.copy(camera.position).sub(this.mesh.position);
    this.mesh.rotation.set(
      -Math.atan2(_toEyes.y, Math.hypot(_toEyes.x, _toEyes.z)),
      Math.atan2(_toEyes.x, _toEyes.z),
      0,
      'YXZ'
    );
  }

  /** Leaves it floating half a metre ahead of the viewer and below their eye line. */
  float(rig, camera) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    rig.add(this.mesh);
    this.mesh.position.copy(camera.position).addScaledVector(forward, 0.5);
    this.mesh.position.y -= 0.42;
    // Face back up at the eyes.
    this.mesh.rotation.set(-0.7, Math.atan2(-forward.x, -forward.z), 0, 'YXZ');
    this.holder = null;
  }

  detach() {
    this.mesh.removeFromParent();
    this.holder = null;
    this._hover = null;
  }

  /**
   * Where a world-space ray meets the panel: the button under it (or null
   * between buttons) and the distance, in world units. Null if it misses.
   */
  hit(origin, direction) {
    if (!this.mesh.parent) return null;
    this._raycaster.set(origin, direction);
    const hit = this._raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.uv) return null;
    return { button: this._buttonAt(hit.uv.x * WIDTH, (1 - hit.uv.y) * HEIGHT), distance: hit.distance };
  }

  /**
   * A world-space point in the panel's own frame, in metres: x to the right
   * and y up from its centre, z out of its face towards the viewer. Null
   * while it is not shown.
   */
  toLocal(world, out = _local) {
    if (!this.mesh.parent) return null;
    return this.mesh.worldToLocal(out.copy(world));
  }

  /** The button at a point in the panel's frame (see toLocal), or null. */
  buttonAtLocal(local) {
    return this._buttonAt((local.x / WIDTH_M + 0.5) * WIDTH, (0.5 - local.y / HEIGHT_M) * HEIGHT);
  }

  /** Whether a point in the panel's frame is over its face, give or take `margin` metres. */
  covers(local, margin = 0) {
    return Math.abs(local.x) <= WIDTH_M / 2 + margin && Math.abs(local.y) <= HEIGHT_M / 2 + margin;
  }

  /** A button's centre in world space. */
  buttonPosition(id, out = new THREE.Vector3()) {
    const button = BUTTONS.find((b) => b.id === id);
    if (!button) return null;
    out.set(
      ((button.x + button.w / 2) / WIDTH - 0.5) * WIDTH_M,
      (0.5 - (button.y + button.h / 2) / HEIGHT) * HEIGHT_M,
      0
    );
    this.mesh.updateWorldMatrix(true, false);
    return this.mesh.localToWorld(out);
  }

  _buttonAt(x, y) {
    const button = BUTTONS.find((b) =>
      x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && this._enabled(b));
    return button?.id ?? null;
  }

  setHover(id) {
    if (id === this._hover) return;
    this._hover = id;
    this.invalidate();
  }

  flash(id) {
    this._flash = id;
    this._flashUntil = performance.now() + FLASH_MS;
    this.invalidate();
  }

  /** Forces a redraw on the next update. */
  invalidate() {
    this._signature = '';
  }

  /** Redraws if anything shown has changed. */
  update(state) {
    if (!this.mesh.parent) return;
    const now = performance.now();
    if (this._flash && now > this._flashUntil) {
      this._flash = null;
      this.invalidate();
    }
    if (this._signature && now - this._lastDraw < REDRAW_MS) return;

    const signature = [
      state.body?.id, state.date, state.time, state.rate, state.paused,
      state.pointing, state.pointingAtFocus, state.labels, state.hands, this._hover, this._flash,
    ].join('|');
    if (signature === this._signature) return;
    this._signature = signature;
    this._lastDraw = now;
    this._state = state;
    this._draw(state);
    this.texture.needsUpdate = true;
  }

  _enabled(button) {
    return !button.enabled || !this._state || button.enabled(this._state);
  }

  _draw(state) {
    const ctx = this.context;
    const { sans, display } = this._fontFamilies();

    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    roundRect(ctx, 2, 2, WIDTH - 4, HEIGHT - 4, 28);
    ctx.fillStyle = COLORS.plate;
    ctx.fill();
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 3;
    ctx.stroke();

    // What is in focus, and what it is.
    const body = state.body;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = `500 64px ${display}`;
    ctx.fillText(body?.name ?? this.systemName, PAD, 104, WIDTH * 0.56);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `400 30px ${sans}`;
    ctx.fillText(describeKind(body), PAD, 148, WIDTH * 0.56);

    // When.
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.text;
    ctx.font = `500 44px ${display}`;
    ctx.fillText(state.date, WIDTH - PAD, 92);
    ctx.fillStyle = state.paused ? COLORS.accent : COLORS.dim;
    ctx.font = `400 29px ${sans}`;
    ctx.fillText(state.paused ? `${state.time} UTC · Paused` : `${state.time} UTC · ${state.rate}`, WIDTH - PAD, 136);

    // What the pointer is on.
    ctx.textAlign = 'left';
    ctx.font = `500 30px ${sans}`;
    if (state.pointing) {
      ctx.fillStyle = COLORS.accent;
      const action = state.hands ? 'pinch' : 'pull the trigger';
      const hint = state.pointingAtFocus ? `${action} to re-frame` : `${action} to go there`;
      ctx.fillText(`${state.pointing} · ${hint}`, PAD, 204, WIDTH - PAD * 2);
    } else {
      ctx.fillStyle = COLORS.faint;
      ctx.fillText('Point at anything to see what it is', PAD, 204, WIDTH - PAD * 2);
    }

    for (const button of BUTTONS) this._drawButton(ctx, button, state, sans);

    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.dim;
    ctx.font = `400 26px ${sans}`;
    // fillText squeezes anything wider than its last argument rather than overrunning.
    const legend = state.hands ? LEGEND.hands : LEGEND.controllers;
    legend.forEach((line, i) => ctx.fillText(line, WIDTH / 2, LEGEND_Y + i * 36, WIDTH - PAD * 2));
  }

  _drawButton(ctx, button, state, sans) {
    const enabled = !button.enabled || button.enabled(state);
    const hovered = enabled && this._hover === button.id;
    const pressed = enabled && this._flash === button.id;
    const active = button.active?.(state);

    roundRect(ctx, button.x, button.y, button.w, button.h, 14);
    ctx.fillStyle = pressed ? COLORS.pressed : hovered ? COLORS.hover : COLORS.button;
    ctx.fill();
    if (hovered) {
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    const label = typeof button.label === 'function' ? button.label(state) : button.label;
    ctx.globalAlpha = enabled ? 1 : 0.3;
    ctx.fillStyle = active || hovered ? COLORS.accent : COLORS.text;
    ctx.font = `500 32px ${sans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, button.x + button.w / 2, button.y + button.h / 2 + 1, button.w - 20);
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;

    // Toggles carry the page's "on" mark: a small dot beneath the label.
    if (active) {
      ctx.beginPath();
      ctx.arc(button.x + button.w / 2, button.y + button.h - 14, 4, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.accent;
      ctx.fill();
    }
  }

  /** The page's own faces, read from the stylesheet so the two never drift apart. */
  _fontFamilies() {
    if (!this._fonts) {
      const style = getComputedStyle(document.documentElement);
      const sans = style.getPropertyValue('--font').trim() || 'sans-serif';
      const display = style.getPropertyValue('--display').trim().replace('var(--font)', sans) || sans;
      this._fonts = { sans, display };
    }
    return this._fonts;
  }
}

function describeKind(body) {
  if (!body) return 'Everything, as a model on a table';
  if (body.kind === 'moon' && body.parent) return `Moon of ${BODY_BY_ID.get(body.parent)?.name ?? body.parent}`;
  if (body.exoplanet && body.kind === 'planet') return 'Exoplanet';
  return KIND_LABEL[body.kind] ?? body.kind;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
