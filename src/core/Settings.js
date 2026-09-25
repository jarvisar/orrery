/**
 * User settings, persisted to localStorage and observable.
 *
 * Defaults are tuned for a mid-range laptop rather than a desktop GPU.
 */

import { SCALE_EXPONENT_RANGE } from '../scene/scaling.js';

const STORAGE_KEY = 'solar-system:settings:v2';

export const DEFAULTS = {
  // Visibility
  showOrbits: true,
  showMoons: true,
  showDwarfs: true,
  showBelts: true,
  showLabels: true,

  // Layout. The single compression exponent every length goes through.
  scale: SCALE_EXPONENT_RANGE.default,

  // Graphics.
  // Off by default: a point light's cube shadow map has roughly ten texels
  // across a planet at Saturn's distance, which buys shadow acne and little
  // else. The shadows that actually matter - Saturn's rings on Saturn, and
  // Saturn on its rings - are computed analytically in src/scene/ringShadow.js
  // and are always on.
  shadowQuality: 0,
  // Bloom, tone mapping over the whole frame, and dithering. See src/core/Post.js.
  effects: true,
  adaptiveResolution: true,
  beltDensity: 1,
  exposure: 1,

  // Interface
  reduceMotion: false,

  // Game controller. Pushing up looks up, as in most games; inverted is the
  // flight-simulator way round.
  padInvertY: false,
  padSensitivity: 1,
  padRumble: true,
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
    for (const listener of this._listeners.get('*') ?? []) listener(value, key);
  }

  /** Subscribes to one key, or to every key with '*'. Returns an unsubscribe function. */
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
    // Drop anything that is not a known key, so an old build's leftovers cannot
    // reintroduce a setting this version no longer validates.
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key in DEFAULTS)
    );
  } catch {
    return {};
  }
}

function save(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Private browsing, a full quota, or storage disabled entirely. The app
    // works fine without persistence, so this is not worth surfacing.
  }
}
