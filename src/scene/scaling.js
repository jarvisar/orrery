/**
 * The one place where real measurements become scene units.
 *
 * A true-to-scale solar system is unwatchable: at Earth-radius = 24 units the
 * Sun would be 2,600 units across and Neptune would sit 720,000 units out, so
 * every planet is a sub-pixel speck. So every length is compressed - but by a
 * single power law, applied the same way to everything:
 *
 *   units = EARTH_RADIUS_UNITS × (km / EARTH_RADIUS_KM) ^ exponent
 *
 * Radii, heliocentric distances, moon distances and ring radii all go through
 * that one function. Nothing is tuned per category, so any ratio of two lengths
 * - Jupiter to Earth, Io's orbit to Io, Neptune's orbit to Mercury's - is
 * compressed by exactly the same rule, and the ordering of every size and every
 * gap survives. Earlier builds compressed sizes harder than distances, which
 * inflated small moons relative to the space around them; that is the clutter
 * this avoids.
 *
 * The exponent is the only free parameter, and it is the Scale setting. Raising
 * it moves everything towards true proportions: bodies shrink relative to their
 * orbits and the system spreads out.
 *
 * Because the compression is applied to the instantaneous distance rather than
 * baked into a fixed orbit radius, genuinely interesting behaviour survives it:
 * Pluto still ducks inside Neptune's orbit near perihelion.
 */

import { AU_KM, EARTH_RADIUS_KM } from '../data/bodies.js';

/** Earth's on-screen radius: the unit everything else is measured against. */
export const EARTH_RADIUS_UNITS = 24;

/** Smallest a body may render, so Phobos and Deimos stay visible and clickable. */
const MIN_RADIUS_UNITS = 3;

/**
 * The compression exponent. 1 would be true scale; 0.5 is a square root. The
 * range stops where the whole system still fits comfortably in one view
 * (the top) and where moons still sit visibly clear of their planets (the bottom).
 */
export const SCALE_EXPONENT_RANGE = { min: 0.45, max: 0.65, default: 0.55 };

/** Heliocentric distance, in AU, that comfortably encloses every orbit (Eris peaks near 98). */
const SYSTEM_EDGE_AU = 100;

/** Any real length, in kilometres, to scene units. */
export function toUnits(km, exponent = SCALE_EXPONENT_RANGE.default) {
  return EARTH_RADIUS_UNITS * (Math.max(km, 1e-6) / EARTH_RADIUS_KM) ** exponent;
}

/** On-screen radius of a body, in scene units. */
export function bodyRadius(body, exponent) {
  return Math.max(MIN_RADIUS_UNITS, toUnits(body.radiusKm, exponent));
}

/**
 * A distance from the Sun. Takes the *instantaneous* distance, not the
 * semi-major axis, so eccentricity survives the transform.
 */
export function heliocentricDistance(distanceAU, exponent) {
  return toUnits(distanceAU * AU_KM, exponent);
}

/** A moon's distance from the centre of its primary. */
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

/** Far plane for the camera: room to see the whole system from outside it, at any Scale. */
export function sceneRadius(exponent = SCALE_EXPONENT_RANGE.max) {
  return systemRadius(exponent) * 3;
}
