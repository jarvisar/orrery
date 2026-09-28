/**
 * Converts real measurements to scene units.
 *
 * True scale leaves every planet a sub-pixel speck (with Earth's radius at 24
 * units, Neptune would be 720,000 units out). So every length (radii, orbit
 * distances, ring radii) is compressed by the same power law:
 *
 *   units = EARTH_RADIUS_UNITS × (km / EARTH_RADIUS_KM) ^ exponent
 *
 * Nothing is tuned per category, so the ordering of every size and gap
 * survives, and small moons aren't inflated relative to the space around them.
 * The exponent is the Scale setting. Raising it moves towards true proportions.
 */

import { AU_KM, EARTH_RADIUS_KM } from '../data/bodies.js';

export const EARTH_RADIUS_UNITS = 24;

/** Smallest a body may render, so Phobos and Deimos stay visible and clickable. */
const MIN_RADIUS_UNITS = 3;

/**
 * The compression exponent. 1 is true scale and 0.5 is a square root. The max
 * is where the whole system still fits in one view, and the min is where moons
 * still sit visibly clear of their planets.
 */
export const SCALE_EXPONENT_RANGE = { min: 0.45, max: 0.65, default: 0.55 };

/** Heliocentric distance, in AU, that comfortably encloses every orbit (Eris peaks near 98). */
const SYSTEM_EDGE_AU = 100;

export function toUnits(km, exponent = SCALE_EXPONENT_RANGE.default) {
  return EARTH_RADIUS_UNITS * (Math.max(km, 1e-6) / EARTH_RADIUS_KM) ** exponent;
}

export function bodyRadius(body, exponent) {
  return Math.max(MIN_RADIUS_UNITS, toUnits(body.radiusKm, exponent));
}

/**
 * Takes the current distance, not the semi-major axis, so eccentric orbits keep
 * their shape (Pluto still dips inside Neptune's orbit).
 */
export function heliocentricDistance(distanceAU, exponent) {
  return toUnits(distanceAU * AU_KM, exponent);
}

export function satelliteDistance(distanceKm, exponent) {
  return toUnits(distanceKm, exponent);
}

/**
 * A ring radius given in primary radii, relative to the primary's on-screen
 * radius. The same law as {@link toUnits}: `toUnits(m·R) / toUnits(R)` is `m^exponent`.
 */
export function ringRadius(multipleOfPrimaryRadius, primaryRadiusUnits, exponent) {
  return primaryRadiusUnits * multipleOfPrimaryRadius ** exponent;
}

/** Radius that encloses every orbit, for zoom limits. */
export function systemRadius(exponent) {
  return heliocentricDistance(SYSTEM_EDGE_AU, exponent);
}

/** Camera far plane: room to see the whole system from outside, at any Scale. */
export function sceneRadius(exponent = SCALE_EXPONENT_RANGE.max) {
  return systemRadius(exponent) * 3;
}
