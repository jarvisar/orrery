/**
 * The page's interface in VR. No DOM reaches a headset, so it is drawn on a
 * canvas on a plane that floats above the off-hand controller like a palette,
 * always upright and turned to the eyes. With bare hands it is summoned by
 * turning a palm to the eyes: it comes to that hand, and then holds still
 * where the other hand can press it, rather than trembling with the wrist.
 *
 * Buttons are six centimetres by three, twelve millimetres apart: Meta's
 * minimum for anything meant to be touched is 22 by 22 millimetres with 12
 * millimetre gaps. Text is sized with the same guide's legibility floor in
 * mind, about 24 millimetres tall a metre away.
 *
 * Under the buttons, a few lines of text: the controls when a session starts,
 * then whatever is in focus. Options swaps the buttons for a page of
 * settings, since the page's own can't be reached from inside a headset.
 *
 * The header (the date, and what is being pointed at) changes several times
 * a second while time runs, and the buttons hardly ever. So the header is a
 * strip of its own over the top of the panel, and a running clock uploads
 * only that strip rather than the whole panel.
 */

import * as THREE from 'three';
import { BODY_BY_ID } from '../data/bodies.js';
import { KIND_LABEL } from '../ui/InfoPanel.js';

/** Canvas pixels, and the plane's size in metres: about 3.4 pixels to the millimetre. */
const WIDTH = 1024;
const HEIGHT = 900;
/** The header strip's height, in the same pixels: everything above the buttons. */
const HEADER_HEIGHT = 232;
const WIDTH_M = 0.3;
const HEIGHT_M = WIDTH_M * (HEIGHT / WIDTH);

const PAD = 36;
const GRID_TOP = 236;
const GRID_GAP = 40;
const COLUMNS = 4;
const BUTTON_HEIGHT = 100;
const BUTTON_WIDTH = (WIDTH - PAD * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS;
const GRID_BOTTOM = GRID_TOP + BUTTON_HEIGHT * 3 + GRID_GAP * 2;

/** Below the grid: the text on the left, two buttons stacked in the last column. */
const FOOT_TOP = GRID_BOTTOM + GRID_GAP;
const FOOT_HEIGHT = HEIGHT - PAD - FOOT_TOP;
const SIDE_HEIGHT = (FOOT_HEIGHT - GRID_GAP) / 2;
const TEXT_WIDTH = BUTTON_WIDTH * 3 + GRID_GAP * 2;

/** Redraws are cheap but not free. The date only changes this often anyway. */
const REDRAW_MS = 200;
/** How long a pressed button stays lit: a fingertip gets no click, so this is the click. */
const FLASH_MS = 180;
/** How long a press that needs confirming waits for the second one. */
const ARM_MS = 3000;

const COLORS = {
  plate: 'rgba(9, 10, 14, 0.94)',
  line: 'rgba(255, 255, 255, 0.16)',
  button: 'rgba(255, 255, 255, 0.06)',
  hover: 'rgba(243, 189, 110, 0.2)',
  pressed: 'rgba(243, 189, 110, 0.45)',
  text: '#eeece6',
  dim: 'rgba(238, 236, 230, 0.72)',
  faint: 'rgba(238, 236, 230, 0.55)',
  accent: '#f3bd6e',
};

/** Row by row. `label`, `enabled` and `active` may be functions of the panel's state. */
const GRID = [
  { id: 'prev', label: '‹  Previous' },
  { id: 'overview', label: 'Whole system' },
  { id: 'next', label: 'Next  ›' },
  { id: 'reframe', label: 'Re-frame', enabled: (s) => Boolean(s.body) },
  { id: 'slower', label: 'Slower', enabled: (s) => !s.slowest },
  { id: 'pause', label: (s) => (s.paused ? 'Play' : 'Pause'), active: (s) => s.paused },
  { id: 'faster', label: 'Faster', enabled: (s) => !s.fastest },
  { id: 'now', label: 'Now' },
  { id: 'zoom-out', label: 'Zoom out' },
  { id: 'zoom-in', label: 'Zoom in' },
  { id: 'options', label: 'Options' },
  { id: 'reverse', label: 'Reverse', active: (s) => s.reversed },
].map(inGrid);

/** Options swaps into the grid in place of the buttons, and Back sits where Options was. */
const BACK_INDEX = GRID.findIndex((button) => button.id === 'options');

/**
 * The settings worth changing without taking the headset off. Each is a
 * setting's key, and `on` is the value that lights the button up.
 */
export const OPTIONS = [
  { key: 'showLabels', label: 'Labels', about: 'Names on everything, and on whatever you point at.' },
  { key: 'showOrbits', label: 'Orbits', about: 'The path each body follows.' },
  { key: 'showMoons', label: 'Moons', about: 'Moons, and their names when their planet is chosen.' },
  { key: 'showDwarfs', label: 'Dwarf planets', about: 'Pluto, Ceres and the rest.' },
  { key: 'showBelts', label: 'Belts', about: 'The asteroid belt and the Kuiper belt, or a star’s dust disk.' },
  { key: 'vrVignette', label: 'Vignette', about: 'Darkens the edges of the view while a stick moves you, which helps with motion sickness.' },
  { key: 'vrSounds', label: 'Sounds', about: 'A click for every press, since a bare hand feels nothing.' },
  { key: 'vrHand', label: 'Left-handed', on: 'left', about: 'Point with your left hand, and hold the panel and fly with your right.' },
];

/** Beside the text. */
const SIDE = [
  { id: 'controls', label: 'Controls', active: (s) => s.help },
  { id: 'exit', label: (s, armed) => (armed ? 'Press again' : 'Exit VR'), confirm: true },
].map((button, i) => ({
  ...button,
  x: PAD + 3 * (BUTTON_WIDTH + GRID_GAP),
  y: FOOT_TOP + i * (SIDE_HEIGHT + GRID_GAP),
  w: BUTTON_WIDTH,
  h: SIDE_HEIGHT,
}));

function inGrid(button, index) {
  return {
    ...button,
    x: PAD + (index % COLUMNS) * (BUTTON_WIDTH + GRID_GAP),
    y: GRID_TOP + Math.floor(index / COLUMNS) * (BUTTON_HEIGHT + GRID_GAP),
    w: BUTTON_WIDTH,
    h: BUTTON_HEIGHT,
  };
}

/** The options page's grid: one toggle per option, in order, and Back. */
function optionsGrid(options) {
  const cells = [inGrid({ id: 'back', label: 'Back' }, BACK_INDEX)];
  let index = 0;
  for (const option of options) {
    if (index === BACK_INDEX) index++;
    if (index >= COLUMNS * 3) break;
    cells.push(inGrid({
      id: `option:${option.key}`,
      label: option.label,
      about: option.about,
      active: (s) => s.options?.[option.key] === (option.on ?? true),
    }, index++));
  }
  return cells;
}

/** Held: how far above the controller the panel's centre floats, in metres. */
const HOLD_ABOVE_M = 0.05 + HEIGHT_M / 2;
/** Summoned by a hand: how far to the side of the palm its near edge floats. */
const BESIDE_PALM_M = 0.05;
/**
 * How far the summoning hand can wander before the panel follows it, and how
 * quickly it then glides over, per second. Within that it holds still, so the
 * hand's tremor does not shake the panel.
 */
const PALM_SLACK_M = 0.1;
const GLIDE_RATE = 14;
/**
 * Floating on its own: ahead of the eyes and below them, within easy reach of
 * a fingertip. Meta puts touch panels 42 to 46 centimetres from the body.
 */
const FLOAT_AHEAD_M = 0.42;
const FLOAT_BELOW_M = 0.36;

/** The fingertip cursor's radius, in metres, from well clear of the panel to touching it. */
const CURSOR_FAR_M = 0.011;
const CURSOR_NEAR_M = 0.0035;

const UP = new THREE.Vector3(0, 1, 0);
const ACCENT = new THREE.Color(COLORS.accent);
const _toEyes = new THREE.Vector3();
const _side = new THREE.Vector3();
const _local = new THREE.Vector3();
const _target = new THREE.Vector3();

export class VRPanel {
  /**
   * @param {string} [systemName]
   * @param {object} [options]
   * @param {typeof OPTIONS} [options.options] The options page's toggles, for what this system has.
   */
  constructor(systemName = 'Solar System', { options = OPTIONS } = {}) {
    this.systemName = systemName;
    this._pages = { main: [...GRID, ...SIDE], options: [...optionsGrid(options), ...SIDE] };
    /** Which buttons fill the grid: 'main', or 'options'. */
    this.page = 'main';
    const plate = layer(HEIGHT);
    this.canvas = plate.canvas;
    this.context = plate.context;
    this.texture = plate.texture;
    this.mesh = plate.mesh;
    this.mesh.name = 'vr-panel';
    this.mesh.renderOrder = 1e8;

    // Just in front of the plate's top edge, and drawn after it.
    this.header = layer(HEADER_HEIGHT);
    this.header.mesh.name = 'vr-panel-header';
    this.header.mesh.renderOrder = 1e8 + 0.5;
    this.header.mesh.position.set(0, (HEIGHT_M * (1 - HEADER_HEIGHT / HEIGHT)) / 2, 0.0005);
    this.mesh.add(this.header.mesh);

    /** The hand holding it, which is then not allowed to point at it. */
    this.holder = null;

    this._raycaster = new THREE.Raycaster();
    this._hover = null;
    this._flash = null;
    this._flashUntil = 0;
    this._armed = null;
    this._armedUntil = 0;
    this._settled = true;
    this._cursors = [];
    this._state = null;
    this._signatures = { plate: '', header: '' };
    this._dirty = true;
    this._lastCheck = -Infinity;
    this._fonts = null;
  }

  /** Floats it above a controller. See {@link VRPanel#follow}. */
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

  /** A palm has just asked for it: it comes over, wherever it was. */
  summon() {
    this._settled = false;
  }

  /**
   * Keeps the panel beside an open palm, on the side towards the middle of
   * the body, where the other hand can reach it without crossing the first.
   * It glides there, then stays put until the hand moves well away.
   * `palm` and `camera` are in the rig's space, in metres.
   */
  besidePalm(rig, palm, handedness, camera, dt, { instant = false } = {}) {
    let arriving = false;
    if (this.mesh.parent !== rig) {
      rig.add(this.mesh);
      arriving = true;
    }
    _toEyes.copy(camera.position).sub(palm).setY(0);
    if (_toEyes.lengthSq() < 1e-6) _toEyes.set(0, 0, 1);
    // To the viewer's right of a left hand, and to the left of a right one.
    _side.crossVectors(UP, _toEyes).normalize();
    if (handedness !== 'left') _side.negate();
    _target.copy(palm).addScaledVector(_side, BESIDE_PALM_M + WIDTH_M / 2);

    const position = this.mesh.position;
    if (this._settled && position.distanceTo(_target) > PALM_SLACK_M) this._settled = false;
    if (arriving || instant) {
      position.copy(_target);
      this._settled = true;
    } else if (!this._settled) {
      position.lerp(_target, 1 - Math.exp(-GLIDE_RATE * dt));
      if (position.distanceTo(_target) < 0.004) this._settled = true;
    }
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

  /** Leaves it floating ahead of the viewer and below their eye line, within reach of a fingertip. */
  float(rig, camera) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    rig.add(this.mesh);
    this.mesh.position.copy(camera.position).addScaledVector(forward, FLOAT_AHEAD_M);
    this.mesh.position.y -= FLOAT_BELOW_M;
    this._faceEyes(camera);
    this.holder = null;
    this._settled = true;
  }

  detach() {
    this.mesh.removeFromParent();
    this.holder = null;
    this.page = 'main';
    this._hover = null;
    this._armed = null;
    // Indexed by input slot, so there can be gaps. forEach skips them.
    this._cursors.forEach((cursor) => { cursor.visible = false; });
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

  /** A button's centre in world space, on the page showing now. */
  buttonPosition(id, out = new THREE.Vector3()) {
    const button = this._buttons().find((b) => b.id === id);
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
    const button = this._buttons().find((b) =>
      x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && this._enabled(b));
    return button?.id ?? null;
  }

  _buttons() {
    return this._pages[this.page];
  }

  setPage(page) {
    if (page === this.page) return;
    this.page = page;
    this._hover = null;
    this.invalidate();
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

  /** The first press of a button that needs two: it waits a few seconds for the second. Null lets it go. */
  arm(id) {
    this._armed = id;
    this._armedUntil = performance.now() + ARM_MS;
    this.invalidate();
  }

  isArmed(id) {
    return this._armed === id && performance.now() < this._armedUntil;
  }

  /**
   * The ring under a fingertip as it comes in to press: it closes up as the
   * finger nears the face, and fills once it touches. `local` is in the
   * panel's frame (see toLocal), or null to hide it. `approach` runs from 1
   * (just come into range) to 0 (touching).
   */
  setCursor(slot, local, approach = 1, touching = false) {
    let cursor = this._cursors[slot];
    if (!local) {
      if (cursor) cursor.visible = false;
      return;
    }
    cursor ??= this._cursors[slot] = buildCursor(this.mesh);
    const { ring, dot } = cursor.userData;
    const t = THREE.MathUtils.clamp(approach, 0, 1);
    cursor.visible = true;
    cursor.position.set(local.x, local.y, 0.001);
    ring.scale.setScalar(CURSOR_NEAR_M + (CURSOR_FAR_M - CURSOR_NEAR_M) * t);
    ring.material.opacity = 0.35 + 0.65 * (1 - t);
    dot.visible = touching;
  }

  /** Has the next update look at the state at once, rather than when it is next due. */
  invalidate() {
    this._dirty = true;
  }

  /**
   * Whether update() would look at the state now: a few times a second, or
   * straight away after something that changes what is shown.
   */
  due() {
    if (!this.mesh.parent) return false;
    const now = performance.now();
    if (this._flash && now > this._flashUntil) {
      this._flash = null;
      this._dirty = true;
    }
    if (this._armed && now > this._armedUntil) {
      this._armed = null;
      this._dirty = true;
    }
    return this._dirty || now - this._lastCheck >= REDRAW_MS;
  }

  /** Redraws whichever part has changed. */
  update(state) {
    if (!this.due()) return;
    this._dirty = false;
    this._lastCheck = performance.now();
    this._state = state;

    const plate = [
      state.body?.id, state.paused, state.reversed, state.slowest, state.fastest, state.hands, state.gaze,
      state.offHand, state.help, JSON.stringify(state.options), this.page, this._hover, this._flash, this._armed,
    ].join('|');
    if (plate !== this._signatures.plate) {
      this._signatures.plate = plate;
      this._drawPlate(state);
      this.texture.needsUpdate = true;
    }

    const header = [
      state.body?.id, state.anchor, state.date, state.time, state.rate, state.paused,
      state.pointing, state.pointingAtFocus, state.hands, state.gaze,
    ].join('|');
    if (header !== this._signatures.header) {
      this._signatures.header = header;
      this._drawHeader(state);
      this.header.texture.needsUpdate = true;
    }
  }

  _enabled(button) {
    return !button.enabled || !this._state || button.enabled(this._state);
  }

  _drawPlate(state) {
    const ctx = this.context;
    const { sans, display } = this._fontFamilies();

    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    roundRect(ctx, 2, 2, WIDTH - 4, HEIGHT - 4, 28);
    ctx.fillStyle = COLORS.plate;
    ctx.fill();
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 3;
    ctx.stroke();

    for (const button of this._buttons()) this._drawButton(ctx, button, state, sans);
    this._drawText(ctx, this._text(state), sans, display);
  }

  /**
   * What the lines under the buttons say, most pressing first: a second press
   * waiting, what an option does, the controls when asked for, then whatever
   * is in focus.
   */
  _text(state) {
    if (this._armed === 'exit') {
      return { eyebrow: 'Leave VR', body: 'Press Exit VR again to go back to the page. Anything else keeps you here.' };
    }
    if (this.page === 'options') {
      const option = this._buttons().find((button) => button.id === this._hover && button.about);
      if (option) return { eyebrow: option.label, body: option.about };
      if (!state.help) return { eyebrow: 'Options', body: 'Point at one to see what it does. They are saved, and the page uses them too.' };
    }
    if (state.help) return { eyebrow: 'Controls', lines: legend(state) };
    if (state.body?.blurb) return { body: state.body.blurb };
    return { body: 'Sizes and distances are compressed so everything fits on the table. Point at anything to see what it is.' };
  }

  /** Left of the side buttons: a small heading, then as much as fits, set as large as it can be. */
  _drawText(ctx, { eyebrow, body, lines }, sans, display) {
    const x = PAD + 4;
    let top = FOOT_TOP;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (eyebrow) {
      ctx.fillStyle = COLORS.accent;
      ctx.font = `500 22px ${display}`;
      ctx.letterSpacing = '3px';
      ctx.fillText(eyebrow.toUpperCase(), x, top + 22, TEXT_WIDTH);
      ctx.letterSpacing = '0px';
      top += 40;
    }
    const bottom = FOOT_TOP + FOOT_HEIGHT;
    for (const size of [28, 26, 24]) {
      const lineHeight = Math.round(size * 1.36);
      const room = Math.floor((bottom - top - size * 0.3) / lineHeight);
      ctx.font = `400 ${size}px ${sans}`;
      const wrapped = lines ?? wrap(ctx, body, TEXT_WIDTH);
      if (wrapped.length > room && size > 24) continue;
      ctx.fillStyle = lines ? COLORS.text : COLORS.dim;
      wrapped.slice(0, room).forEach((line, i) => {
        const last = i === room - 1 && wrapped.length > room;
        ctx.fillText(last ? `${line.replace(/\W*\s*\S*$/, '')}…` : line, x, top + size + i * lineHeight, TEXT_WIDTH);
      });
      return;
    }
  }

  /** On a clear strip: the plate underneath shows through. */
  _drawHeader(state) {
    const ctx = this.header.context;
    const { sans, display } = this._fontFamilies();
    ctx.clearRect(0, 0, WIDTH, HEADER_HEIGHT);

    // What is in focus, and what it is.
    const body = state.body;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = `500 64px ${display}`;
    ctx.fillText(body?.name ?? state.anchor ?? this.systemName, PAD, 104, WIDTH * 0.56);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `400 30px ${sans}`;
    ctx.fillText(describeKind(body, state.anchor), PAD, 148, WIDTH * 0.56);

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
      // Gaze is private to the headset, so nothing can be named before the pinch.
      ctx.fillStyle = COLORS.faint;
      ctx.fillText(state.gaze ? 'Look at anything and pinch to go there' : 'Point at anything to see what it is',
        PAD, 204, WIDTH - PAD * 2);
    }
  }

  _drawButton(ctx, button, state, sans) {
    const enabled = !button.enabled || button.enabled(state);
    const armed = button.confirm && this._armed === button.id;
    const hovered = enabled && this._hover === button.id;
    const pressed = enabled && this._flash === button.id;
    const active = button.active?.(state);

    roundRect(ctx, button.x, button.y, button.w, button.h, 14);
    ctx.fillStyle = pressed ? COLORS.pressed : hovered || armed ? COLORS.hover : COLORS.button;
    ctx.fill();
    if (hovered || armed) {
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    const label = typeof button.label === 'function' ? button.label(state, armed) : button.label;
    ctx.globalAlpha = enabled ? 1 : 0.3;
    ctx.fillStyle = active || hovered || armed ? COLORS.accent : COLORS.text;
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

/**
 * The controls, for whichever is in use. The off hand holds the panel and
 * flies. Its face buttons step between bodies, the other's pause and zoom out.
 * Short enough to set at full size: squeezed text is hard to read in a headset.
 */
function legend({ hands, gaze, offHand }) {
  // Vision Pro: no controllers, and the eyes do the pointing.
  if (gaze) {
    return [
      'Look at something and pinch to select it',
      'Pinch and drag to move · both hands to resize',
      'Look at a button and pinch to press it',
    ];
  }
  if (hands) {
    return [
      'Point, and pinch to select',
      'Pinch and drag to move · both hands to resize',
      'Touch a button with a fingertip',
      'Turn a palm to you to bring this panel back',
    ];
  }
  const off = offHand === 'right' ? { side: 'Right', buttons: 'A and B' } : { side: 'Left', buttons: 'X and Y' };
  const main = offHand === 'right' ? { side: 'Left', buttons: ['X', 'Y'] } : { side: 'Right', buttons: ['A', 'B'] };
  return [
    'Trigger: select · grip: grab and move',
    `${off.side} stick: fly · ${main.side.toLowerCase()} stick: turn, zoom`,
    `${main.buttons[0]}: play or pause · ${main.buttons[1]}: whole system`,
    `${off.buttons}: previous, next · both grips: resize`,
  ];
}

/** Breaks text into lines no wider than `width` in the context's current font. */
function wrap(ctx, text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** A canvas `height` pixels tall, and a plane the panel's width across to show it on. */
function layer(height) {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(WIDTH_M, WIDTH_M * (height / WIDTH)),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      // Always readable: never cut into by a planet the hand has wandered into.
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
  );
  return { canvas, context: canvas.getContext('2d'), texture, mesh };
}

/** A ring and the dot inside it, a unit across, on the panel's face and over its text. */
function buildCursor(panel) {
  const material = () => new THREE.MeshBasicMaterial({
    color: ACCENT, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 32), material());
  const dot = new THREE.Mesh(new THREE.CircleGeometry(CURSOR_NEAR_M * 0.8, 16), material());
  const group = new THREE.Group();
  group.name = 'vr-poke-cursor';
  group.add(ring, dot);
  group.userData = { ring, dot };
  for (const mesh of [ring, dot]) {
    mesh.renderOrder = 1e8 + 1;
    mesh.frustumCulled = false;
  }
  panel.add(group);
  return group;
}

function describeKind(body, anchor) {
  if (!body) return anchor ? 'Its planets, as a model on a table' : 'Everything, as a model on a table';
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
