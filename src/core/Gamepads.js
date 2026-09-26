/**
 * Game controllers, through the Gamepad API. The API only offers a snapshot, so
 * this is polled from the frame loop and turns it into presses, auto-repeat and
 * dead-zoned sticks.
 *
 * Connections are found by diffing snapshots, since some browsers fire
 * `gamepadconnected` late or not at all. Browsers also hide a controller until
 * a button is pressed, so "connected" means "connected and touched". With
 * several connected, only the last one used is read (summing them would add up
 * every stick's drift).
 *
 * Names are positions in the standard mapping (w3c.github.io/gamepad/#remapping);
 * src/ui/padGlyphs.js has what each make prints on them.
 */

/** Standard-mapping button indices, by position. `a` is the bottom face button. */
export const BUTTONS = {
  a: 0, b: 1, x: 2, y: 3,
  lb: 4, rb: 5, lt: 6, rt: 7,
  view: 8, menu: 9, ls: 10, rs: 11,
  up: 12, down: 13, left: 14, right: 15,
};

/** The left stick, read as four more direction buttons for moving round menus. */
const STICK_DIRECTIONS = ['stickUp', 'stickDown', 'stickLeft', 'stickRight'];

/** Stick travel ignored at rest; worn sticks drift to about a tenth. */
const STICK_DEAD_ZONE = 0.16;
const TRIGGER_DEAD_ZONE = 0.06;
/** How far a trigger has to go down to count as a press. */
const TRIGGER_PRESS = 0.5;
/** Stick deflection that counts as a direction press, and the lower one that releases it. */
const STICK_PRESS = 0.6;
const STICK_RELEASE = 0.4;
/** Auto-repeat for a held button, in seconds, as a keyboard does it. */
const REPEAT_DELAY = 0.4;
const REPEAT_INTERVAL = 0.11;
/** Input firm enough to mean someone picked the controller up, not that a stick drifted. */
const DELIBERATE = 0.5;

export class GamepadInput {
  constructor() {
    /** @type {Gamepad|null} The controller being listened to. */
    this.pad = null;
    /** 'xbox', 'playstation', 'nintendo' or 'generic'; decides the glyphs. */
    this.family = 'generic';
    /** Sticks, -1 to 1, with the dead zone taken out. +y is down, as the API reports it. */
    this.left = { x: 0, y: 0 };
    this.right = { x: 0, y: 0 };
    /** Triggers, 0 to 1. */
    this.lt = 0;
    this.rt = 0;
    /** True on a frame the controller was deliberately used. */
    this.used = false;

    /** @type {((pad: Gamepad, family: string) => void)|null} */
    this.onConnect = null;
    /** @type {((pad: Gamepad) => void)|null} */
    this.onDisconnect = null;

    this._known = new Map();
    this._buttons = new Map(
      [...Object.keys(BUTTONS), ...STICK_DIRECTIONS].map((name) => [name, blankState()])
    );
    this._supported = typeof navigator.getGamepads === 'function';
  }

  get connected() {
    return this.pad !== null;
  }

  /** Reads every controller. Called once per frame, before anything asks about input. */
  poll(dt) {
    const pads = this._read();
    this._diff(pads);

    const previous = this.pad;
    const pressing = pads.find((pad) => pad.index !== previous?.index && pad.buttons.some((b) => b.pressed));
    this.pad = pressing ?? pads.find((pad) => pad.index === previous?.index) ?? pads[0] ?? null;
    // A newly revealed controller starts with its waking press already down,
    // so that press does not also trigger the button's action.
    const fresh = this.pad?.index !== previous?.index;
    if (fresh) {
      this._reset();
      if (this.pad) this.family = familyOf(this.pad.id);
    }

    this.used = false;
    if (!this.pad) return;

    const { buttons, axes } = this.pad;
    radial(axes[0] ?? 0, axes[1] ?? 0, this.left);
    radial(axes[2] ?? 0, axes[3] ?? 0, this.right);
    this.lt = trigger(buttons[BUTTONS.lt]?.value ?? 0);
    this.rt = trigger(buttons[BUTTONS.rt]?.value ?? 0);

    for (const [name, index] of Object.entries(BUTTONS)) {
      const button = buttons[index];
      const down = name === 'lt' || name === 'rt'
        ? (button?.value ?? 0) > TRIGGER_PRESS
        : Boolean(button?.pressed);
      this._update(name, down, dt, fresh);
    }

    // The stick as a D-pad: hysteresis stops chatter near the threshold, and
    // only the stronger axis counts so a diagonal is not two presses.
    const { x, y } = this.left;
    const horizontal = Math.abs(x) >= Math.abs(y);
    const beyond = (name, value) =>
      value > (this._buttons.get(name).down ? STICK_RELEASE : STICK_PRESS);
    this._update('stickUp', !horizontal && beyond('stickUp', -y), dt, fresh);
    this._update('stickDown', !horizontal && beyond('stickDown', y), dt, fresh);
    this._update('stickLeft', horizontal && beyond('stickLeft', -x), dt, fresh);
    this._update('stickRight', horizontal && beyond('stickRight', x), dt, fresh);

    this.used = (fresh && buttons.some((button) => button.pressed)) ||
      [...this._buttons.values()].some((state) => state.pressed) ||
      Math.hypot(this.left.x, this.left.y) > DELIBERATE ||
      Math.hypot(this.right.x, this.right.y) > DELIBERATE ||
      this.lt > DELIBERATE || this.rt > DELIBERATE;
  }

  /** Held down right now. */
  down(name) { return this._buttons.get(name).down; }

  /** Went down this frame. */
  pressed(name) { return this._buttons.get(name).pressed; }

  /** Went down this frame, or is being held long enough to repeat. */
  repeat(name) { return this._buttons.get(name).repeat; }

  /** A direction for moving round the interface: the D-pad or the left stick, with repeat. */
  nav(direction) {
    const stick = `stick${direction[0].toUpperCase()}${direction.slice(1)}`;
    return this.repeat(direction) || this.repeat(stick);
  }

  /** A short buzz, where the controller can. Magnitudes 0 to 1. */
  rumble(strong, weak, ms) {
    const actuator = this.pad?.vibrationActuator;
    if (!actuator?.playEffect) return;
    try {
      actuator.playEffect('dual-rumble', {
        duration: ms, strongMagnitude: strong, weakMagnitude: weak,
      })?.catch?.(() => {});
    } catch { /* not every controller has motors */ }
  }

  _read() {
    if (!this._supported) return [];
    try {
      // A sparse array with nulls in it, and not always a real Array.
      return [...(navigator.getGamepads() ?? [])].filter((pad) => pad?.connected);
    } catch {
      // Blocked by a permissions policy, or an insecure context.
      return [];
    }
  }

  _diff(pads) {
    const seen = new Set();
    for (const pad of pads) {
      seen.add(pad.index);
      if (this._known.get(pad.index) === pad.id) continue;
      this._known.set(pad.index, pad.id);
      this.onConnect?.(pad, familyOf(pad.id));
    }
    for (const [index, id] of this._known) {
      if (seen.has(index)) continue;
      this._known.delete(index);
      this.onDisconnect?.({ index, id });
    }
  }

  _update(name, down, dt, fresh = false) {
    const state = this._buttons.get(name);
    if (fresh) {
      // Held from before: no press, and no repeat until it is let go.
      Object.assign(state, blankState(), { down, next: Infinity });
      return;
    }
    state.pressed = down && !state.down;
    state.repeat = state.pressed;
    if (state.pressed) {
      state.held = 0;
      state.next = REPEAT_DELAY;
    } else if (down) {
      state.held += dt;
      if (state.held >= state.next) {
        state.repeat = true;
        state.next += REPEAT_INTERVAL;
      }
    }
    state.down = down;
  }

  _reset() {
    for (const state of this._buttons.values()) Object.assign(state, blankState());
    this.left.x = this.left.y = this.right.x = this.right.y = 0;
    this.lt = this.rt = 0;
  }
}

function blankState() {
  return { down: false, pressed: false, repeat: false, held: 0, next: 0 };
}

/**
 * A radial dead zone, rescaled so that just past it reads as nearly zero
 * rather than jumping straight to the threshold.
 */
function radial(x, y, out) {
  const magnitude = Math.hypot(x, y);
  if (magnitude < STICK_DEAD_ZONE) {
    out.x = out.y = 0;
    return;
  }
  const scale = Math.min(1, (magnitude - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE)) / magnitude;
  out.x = x * scale;
  out.y = y * scale;
}

function trigger(value) {
  return value < TRIGGER_DEAD_ZONE ? 0 : (value - TRIGGER_DEAD_ZONE) / (1 - TRIGGER_DEAD_ZONE);
}

/** Which make of controller, from the id string the browser reports: name, then vendor id. */
export function familyOf(id = '') {
  if (/xbox|xinput|microsoft|vendor: 045e|^045e-/i.test(id)) return 'xbox';
  if (/playstation|dualshock|dualsense|sony|vendor: 054c|^054c-/i.test(id)) return 'playstation';
  if (/nintendo|switch|joy-con|pro controller|vendor: 057e|^057e-/i.test(id)) return 'nintendo';
  return 'generic';
}
