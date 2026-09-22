/**
 * The one place where real measurements become scene units.
 *
 * A true-to-scale solar system is unwatchable: at Earth-diameter = 24 units the
 * Sun would be 2,600 units across and Neptune would sit 720,000 units out, so
 * every planet is a sub-pixel speck. Instead both sizes and distances are run
 * through power-law compression, which keeps the *ordering* and the *feel* of
 * the real proportions (Jupiter still dwarfs Earth, Neptune is still far) while
 * fitting everything into a space you can fly across.
 *
 * Because the compression is applied to the instantaneous distance rather than
 * baked into a fixed orbit radius, genuinely interesting behaviour survives it:
 * Pluto still ducks inside Neptune's orbit near perihelion.
 */

import { EARTH_RADIUS_KM } from '../data/bodies.js';

/** Earth's on-screen radius. Everything else is relative to this. */
export const EARTH_RADIUS_UNITS = 24;

/** Earth's on-screen orbital distance at the default spacing. */
export const EARTH_ORBIT_UNITS = 2400;

/**
 * Compression exponent for body radii. 0.4 maps the real 109:1 Sun-to-Earth
 * ratio down to 6.5:1 — still unmistakably the largest thing in the scene,
 * without swallowing Mercury's orbit.
 */
const RADIUS_EXPONENT = 0.4;

/** Smallest a body may render, so Phobos and Deimos stay visible and clickable. */
const MIN_RADIUS_UNITS = 3;

/** Compression exponent for satellite distances, relative to the primary. */
const SATELLITE_EXPONENT = 0.55;

/**
 * Heliocentric spacing runs from tight to near-realistic. 0.5 is the true
 * square-root compression; lower values pull the outer planets in so the whole
 * system fits on screen at once.
 */
export const ORBIT_EXPONENT_RANGE = { min: 0.2, max: 0.5, default: 0.35 };

/** On-screen radius of a body, in scene units. */
export function bodyRadius(body) {
  const relative = body.radiusKm / EARTH_RADIUS_KM;
  return Math.max(MIN_RADIUS_UNITS, EARTH_RADIUS_UNITS * relative ** RADIUS_EXPONENT);
}

/**
 * Compresses a heliocentric distance. Takes the *instantaneous* distance, not
 * the semi-major axis, so eccentricity survives the transform.
 */
export function heliocentricDistance(distanceAU, exponent = ORBIT_EXPONENT_RANGE.default) {
  return EARTH_ORBIT_UNITS * Math.max(distanceAU, 1e-6) ** exponent;
}

/**
 * Compresses a satellite's distance from its primary. Expressed as a multiple
 * of the primary's on-screen radius so moons always clear the surface they
 * orbit no matter how the size curve is tuned.
 */
export function satelliteDistance(distanceKm, parent, parentRadiusUnits) {
  const relative = Math.max(distanceKm / parent.radiusKm, 1.05);
  return parentRadiusUnits * relative ** SATELLITE_EXPONENT;
}

/** Same compression as {@link satelliteDistance}, for ring radii given in primary radii. */
export function ringRadius(multipleOfPrimaryRadius, parentRadiusUnits) {
  return parentRadiusUnits * multipleOfPrimaryRadius ** SATELLITE_EXPONENT;
}

/** Scene units for a distance in AU, at a given spacing exponent. Used by the belts. */
export function auToUnits(au, exponent = ORBIT_EXPONENT_RANGE.default) {
  return heliocentricDistance(au, exponent);
}

/**
 * Far plane for the camera. The skybox sits just inside it, and the outermost
 * orbit needs headroom at the loosest spacing setting.
 */
export function sceneRadius(exponent = ORBIT_EXPONENT_RANGE.max) {
  return heliocentricDistance(120, exponent) * 3;
}
