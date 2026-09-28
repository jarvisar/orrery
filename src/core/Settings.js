/** User settings, persisted to localStorage. Defaults suit a mid-range laptop. */

import { SCALE_EXPONENT_RANGE } from '../scene/scaling.js';

const STORAGE_KEY = 'solar-system:settings:v2';

export const DEFAULTS = {
  showOrbits: true,
  showMoons: true,
  showDwarfs: true,
  showBelts: true,
  showLabels: true,

  // The single compression exponent every length goes through.
  scale: SCALE_EXPONENT_RANGE.default,

  // Off by default: a point light's cube shadow map has roughly ten texels
  // across a planet at Saturn's distance. Saturn's ring shadows are analytic
  // (src/scene/ringShadow.js) and always on.
  shadowQuality: 0,
  // See src/core/Post.js.
  effects: true,
  adaptiveResolution: true,
  beltDensity: 1,
  exposure: 1,

  // Whatever the system asks for, until changed here.
  reduceMotion: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  // Single-key shortcuts, which speech input can set off by accident (WCAG 2.1.4).
  keyShortcuts: true,

  // Pushing up looks up, as in most games. Inverted is the flight-sim way.
  padInvertY: false,
  padSensitivity: 1,
  padRumble: true,

  // The hand that points in a headset. The other holds the panel and flies.
  vrHand: 'right',
  vrVignette: true,
  vrSounds: true,
};

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...load() };
    this._listeners = new Map();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    save(this.values);
    for (const listener of this._listeners.get(key) ?? []) listener(value, key);
  }

  /** Subscribes to one key. Returns an unsubscribe function. */
  on(key, listener) {
    if (!this._listeners.has(key)) this._listeners.set(key, new Set());
    this._listeners.get(key).add(listener);
    return () => this._listeners.get(key)?.delete(listener);
  }

  reset() {
    for (const [key, value] of Object.entries(DEFAULTS)) this.set(key, value);
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Drop unknown keys left over from older builds.
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key in DEFAULTS)
    );
  } catch {
    return {};
  }
}

/** Only what differs from the defaults, so a default that follows the system keeps following it. */
function save(values) {
  try {
    const changed = Object.entries(values).filter(([key, value]) => value !== DEFAULTS[key]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(changed)));
  } catch {
    // Fails in private browsing or when storage is full or disabled. Saving is optional.
  }
}
