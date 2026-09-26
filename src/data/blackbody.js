/**
 * Colours of hot things: stars, and the night sides of planets hot enough to
 * glow. Shared by the importer, the browser and the renderer.
 */

/**
 * The sRGB colour of a blackbody at `temperature` kelvin, brightest channel at
 * full: Planck's law through the CIE 1931 observer (Wyman, Sloan & Shirley 2013
 * fit) into sRGB. Stars are not perfect blackbodies, but at a glance this is
 * the colour their temperature gives them.
 */
export function stellarColor(temperature) {
  if (!(Number.isFinite(temperature) && temperature > 0)) return '#fff1e0';
  const key = Math.round(Math.min(Math.max(temperature, 1000), 40000) / 50) * 50;
  let hex = COLOR_CACHE.get(key);
  if (!hex) COLOR_CACHE.set(key, hex = blackbodyHex(key));
  return hex;
}
const COLOR_CACHE = new Map();

/** Linear-light RGB of a blackbody, brightest channel 1: what a shader multiplies. */
export function blackbodyLinear(temperature) {
  const hex = stellarColor(temperature);
  return [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
}

function blackbodyHex(temperature) {
  const lobe = (x, mu, s1, s2) => Math.exp(-0.5 * ((x - mu) / (x < mu ? s1 : s2)) ** 2);
  let X = 0, Y = 0, Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const planck = nm ** -5 / Math.expm1(1.4387769e7 / (nm * temperature));
    X += planck * (1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2));
    Y += planck * (0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1));
    Z += planck * (1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8));
  }
  const linear = [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  ].map((c) => Math.max(c, 0));
  const peak = Math.max(...linear);
  return `#${linear.map((c) => {
    const v = c / peak;
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

/**
 * How brightly a surface at `temperature` glows on screen, 0 below about 800 K.
 * Set for visibility rather than photometry, like the star lights: true
 * thermal glow spans many orders of magnitude between a dull 1,000 K night
 * side and a 3,000 K day side, and no single exposure shows both.
 */
export function glowIntensity(temperature) {
  if (!(temperature > 800)) return 0;
  return Math.min(2.5, ((temperature - 800) / 1700) ** 2.2);
}
