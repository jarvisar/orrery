/**
 * Reference frames.
 *
 * The scene is the J2000 ecliptic in three.js axes: +X points at the March
 * equinox, +Y is ecliptic north, and ecliptic +Y becomes three's -Z (see
 * perifocalToWorld in kepler.js). Poles and star positions are published in
 * the J2000 equatorial frame instead - right ascension and declination - which
 * is the same frame tipped about the equinox direction by the obliquity of the
 * ecliptic. This is the one conversion between them.
 */

const DEG = Math.PI / 180;

/** Obliquity of the ecliptic at J2000, degrees. */
export const OBLIQUITY_J2000 = 23.4392911;

const COS_E = Math.cos(OBLIQUITY_J2000 * DEG);
const SIN_E = Math.sin(OBLIQUITY_J2000 * DEG);

/**
 * A direction given as J2000 right ascension and declination, as a unit vector
 * in scene axes.
 *
 * @param {number} raDeg
 * @param {number} decDeg
 * @param {{x:number,y:number,z:number}} [out]
 */
export function equatorialToScene(raDeg, decDeg, out = { x: 0, y: 0, z: 0 }) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const x = Math.cos(dec) * Math.cos(ra);
  const y = Math.cos(dec) * Math.sin(ra);
  const z = Math.sin(dec);

  // Equatorial to ecliptic: a rotation about the shared equinox axis.
  const yEcl = y * COS_E + z * SIN_E;
  const zEcl = -y * SIN_E + z * COS_E;

  out.x = x;
  out.y = zEcl;
  out.z = -yEcl;
  return out;
}
