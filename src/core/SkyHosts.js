/**
 * The stars in the sky that have planets, so a click on one can offer a visit.
 *
 * public/data/sky-hosts.json lists the exoplanet hosts bright enough to see
 * (the importer writes it; see skyHosts() in src/data/exoplanets.js). Each is
 * tied to the star the sky actually draws for it, and one the sky does not
 * draw is left out, so every target is a point you can see.
 *
 * Stars are drawn at infinity, where a raycast cannot reach them, so they are
 * picked by angle: the host nearest the pointer's direction, within a few
 * pixels. There are under two hundred, so a scan per pick costs nothing.
 */

import { SKY_HOSTS_PATH, PARSEC_LY, number, validateSkyHosts } from '../data/exoplanets.js';
import { equatorialToScene } from '../sim/frames.js';

/**
 * How far a host's archive position may sit from the star drawn for it, in
 * radians: 3′. The two catalogues' epochs differ by up to a few decades of
 * proper motion, which for these stars is at most about a minute of arc.
 */
const MATCH_ANGLE = (3 / 60) * (Math.PI / 180);
/** How far their magnitudes may differ: the drawn one can be a blended pair. */
const MATCH_MAGNITUDES = 1;

const PREFIX = 'sky:';

export class SkyHosts {
  constructor() {
    /** @type {SkyHost[]} */
    this.hosts = [];
    this._byId = new Map();
  }

  /**
   * @param {{ positions: ArrayLike<number>, magnitudes: ArrayLike<number> }|null} drawn
   *   The sky's own stars (Sky.drawn). Without them nothing is offered.
   * @param {{ except?: string|null, fetcher?: typeof fetch }} [options]
   *   `except` is the system already on screen.
   */
  async load(drawn, { except = null, fetcher = (...args) => fetch(...args) } = {}) {
    const response = await fetcher(SKY_HOSTS_PATH, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { hosts } = validateSkyHosts(await response.json());
    this.hosts = drawn ? matchDrawnStars(hosts, drawn).filter((host) => host.name !== except) : [];
    this._byId = new Map(this.hosts.map((host) => [host.id, host]));
    return this;
  }

  /** @returns {SkyHost|undefined} */
  get(id) { return this._byId.get(id); }

  /**
   * The host nearest a world-space unit direction, within `tolerance` radians.
   * @returns {SkyHost|null}
   */
  nearest(direction, tolerance) {
    // Chord lengths rather than dot products: near 1, a cosine has no precision left.
    let best = null;
    let bestChord = tolerance * tolerance;
    for (const host of this.hosts) {
      const dx = host.x - direction.x, dy = host.y - direction.y, dz = host.z - direction.z;
      const chord = dx * dx + dy * dy + dz * dz;
      if (chord < bestChord) { bestChord = chord; best = host; }
    }
    return best;
  }
}

/**
 * @typedef {object} SkyHost
 * @property {string} id  Distinct from every body id, so the picker can return either.
 * @property {string} name  The archive's host name, which is also the system's.
 * @property {number} planets
 * @property {number|null} distance  Parsecs.
 * @property {number} magnitude
 * @property {number} x  The drawn star's direction, x, y and z.
 * @property {number} y
 * @property {number} z
 */

/** "3 planets · 11.75 ly", as the atlas words it. Made when shown: formatting numbers is slow. */
export function hostSummary({ planets, distance }) {
  return `${planets} ${planets === 1 ? 'planet' : 'planets'} · ${distance ? `${number(distance * PARSEC_LY)} ly` : 'distance unknown'}`;
}

/**
 * Each host placed on the drawn star it corresponds to: the nearest one of a
 * similar magnitude within MATCH_ANGLE. Hosts with none are dropped.
 *
 * @param {Array} hosts  sky-hosts.json rows
 * @param {{ positions: ArrayLike<number>, magnitudes: ArrayLike<number> }} drawn
 * @returns {SkyHost[]}
 */
export function matchDrawnStars(hosts, { positions, magnitudes }) {
  // Slices of equal height in y are also equal in area, so each holds about
  // the same share of the sky's stars; a host need only search its own.
  const bands = Array.from({ length: BANDS }, () => []);
  for (let i = 0; i < magnitudes.length; i++) bands[band(positions[i * 3 + 1])].push(i);

  const matched = [];
  const place = { x: 0, y: 0, z: 0 };
  // Stored directions are quantized, so a little off unit length; this margin covers it.
  const reach = 2 * MATCH_ANGLE;
  for (const [name, ra, dec, magnitude, planets, distance] of hosts) {
    equatorialToScene(ra, dec, place);
    let best = -1;
    let bestChord = MATCH_ANGLE * MATCH_ANGLE;
    for (let b = band(place.y - reach); b <= band(place.y + reach); b++) {
      for (const i of bands[b]) {
        if (Math.abs(magnitudes[i] - magnitude) > MATCH_MAGNITUDES) continue;
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        if (Math.abs(x - place.x) > reach || Math.abs(z - place.z) > reach) continue;
        const length = Math.hypot(x, y, z);
        const dx = x / length - place.x, dy = y / length - place.y, dz = z / length - place.z;
        const chord = dx * dx + dy * dy + dz * dz;
        if (chord < bestChord) { bestChord = chord; best = i; }
      }
    }
    if (best < 0) continue;

    const x = positions[best * 3], y = positions[best * 3 + 1], z = positions[best * 3 + 2];
    const length = Math.hypot(x, y, z);
    matched.push({
      id: PREFIX + name, name, planets, distance, magnitude,
      x: x / length, y: y / length, z: z / length,
    });
  }
  return matched;
}

const BANDS = 256;
function band(y) { return Math.min(BANDS - 1, Math.max(0, Math.floor(((y + 1) / 2) * BANDS))); }
