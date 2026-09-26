/**
 * Two-body orbital mechanics. Every position is a pure function of the
 * simulated date, so time can be paused, reversed or scrubbed without drift,
 * and eccentric or inclined orbits (Pluto, Eris, Triton) come out right.
 */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Milliseconds at the J2000.0 epoch: 2000-01-01 12:00 TT. */
export const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

export function daysSinceJ2000(date = new Date()) {
  return (date.getTime() - J2000_MS) / 86_400_000;
}

export function dateFromDays(days) {
  return new Date(J2000_MS + days * 86_400_000);
}

/**
 * Solves Kepler's equation `M = E - e·sin E` for the eccentric anomaly.
 *
 * Bracketed Newton iteration also handles highly eccentric exoplanets, including
 * negative dates and mean anomalies very close to periapsis.
 */
export function eccentricAnomaly(meanAnomaly, e) {
  const M = normalizeSigned(meanAnomaly);
  if (M === 0 || e === 0) return M;
  let low = -Math.PI, high = Math.PI;
  let E = e < 0.8 ? M : Math.sign(M) * Math.PI;
  for (let i = 0; i < 64; i++) {
    const residual = E - e * Math.sin(E) - M;
    if (residual > 0) high = E; else low = E;
    const next = E - residual / (1 - e * Math.cos(E));
    const candidate = next > low && next < high ? next : (low + high) / 2;
    if (Math.abs(residual) < 1e-14 || high - low < 1e-13) break;
    E = candidate;
  }
  return E;
}

/**
 * Position of a body on its orbit at `tDays`, in the same length unit as
 * `elements.a`, expressed in three.js axes (XZ is the reference plane, +Y is
 * its north pole).
 *
 * @param {{a:number, e:number, inc:number, meanLong:number, periLong:number,
 *          nodeLong:number, periodDays:number}} el Elements in degrees / days.
 * @param {number} tDays Days since the J2000 epoch.
 * @param {{x:number,y:number,z:number}} out Written in place to avoid garbage.
 */
export function orbitalPosition(el, tDays, out) {
  // Mean anomaly advances linearly; everything else is fixed for our purposes.
  const n = 360 / el.periodDays;
  const M = (el.meanLong - el.periLong + n * tDays) * DEG;
  const E = eccentricAnomaly(M, el.e);

  // Position in the orbital plane, perifocal frame.
  const px = el.a * (Math.cos(E) - el.e);
  const py = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);

  return perifocalToWorld(px, py, el, out);
}

/**
 * Rotates a perifocal (x, y) pair out to the reference frame and into three.js
 * axes. Shared by the body positions and the orbit-path geometry so the two can
 * never disagree about where an orbit is.
 */
export function perifocalToWorld(px, py, el, out) {
  const w = (el.periLong - el.nodeLong) * DEG; // argument of perihelion
  const O = el.nodeLong * DEG;
  const i = el.inc * DEG;

  const cw = Math.cos(w), sw = Math.sin(w);
  const cO = Math.cos(O), sO = Math.sin(O);
  const ci = Math.cos(i), si = Math.sin(i);

  const xEcl = (cw * cO - sw * sO * ci) * px + (-sw * cO - cw * sO * ci) * py;
  const yEcl = (cw * sO + sw * cO * ci) * px + (-sw * sO + cw * cO * ci) * py;
  const zEcl = sw * si * px + cw * si * py;

  // Ecliptic (+Z north) to three.js (+Y up), preserving handedness.
  out.x = xEcl;
  out.y = zEcl;
  out.z = -yEcl;
  return out;
}

/**
 * Samples one full revolution as perifocal coordinates, for drawing the path.
 * Sampling by eccentric anomaly rather than by angle spaces points evenly along
 * the arc, so eccentric orbits stay smooth at perihelion without wasting
 * vertices on the slow far side.
 */
export function sampleOrbitPath(el, segments, out) {
  const points = out ?? [];
  for (let s = 0; s <= segments; s++) {
    const E = (s / segments) * TAU;
    points.push({
      px: el.a * (Math.cos(E) - el.e),
      py: el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E),
    });
  }
  return points;
}

/** Wraps an angle in radians to (-π, π]. */
function normalizeSigned(radians) {
  const wrapped = radians % TAU;
  if (wrapped > Math.PI) return wrapped - TAU;
  if (wrapped <= -Math.PI) return wrapped + TAU;
  return wrapped;
}

/**
 * Rotation angle about a body's own axis at `tDays`.
 * Negative periods mean retrograde rotation, which is how Venus and Uranus are
 * stored in the catalogue.
 */
export function spinAngle(periodHours, tDays) {
  if (!periodHours) return 0;
  return ((tDays * 24) / periodHours) * TAU;
}

/**
 * Where a body's prime meridian points at `tDays`: the IAU's W = W0 + W'd,
 * measured east along the equator from where it crosses the Earth's. Taken
 * modulo one turn before scaling, so Earth - some ten thousand turns past
 * J2000 by now - keeps its precision.
 *
 * @param {{periodHours:number, meridianDeg?:number}} spin
 */
export function rotationAngle(spin, tDays) {
  if (!spin?.periodHours) return 0;
  const turns = (spin.meridianDeg ?? 0) / 360 + (tDays * 24) / spin.periodHours;
  return (turns - Math.floor(turns)) * TAU;
}
