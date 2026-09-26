/**
 * What another star and its planets probably look like.
 *
 * Almost nothing about an exoplanet's appearance has been observed. What
 * usually has been measured is its size, often its mass, and how much light
 * reaches it from its star. That is enough to say what kind of world it
 * probably is: a giant too hot for clouds, a rock too close to its star to
 * keep an atmosphere, a small world cold enough to freeze over. This module
 * turns the measurements into a description that src/scene/worldTextures.js
 * paints from, with a note saying why each planet looks the way it does. The
 * few planets whose colour or brightness has been observed are in
 * appearances.js, which overrides these guesses.
 *
 * Everything here is plain data and deterministic: the same planet always gets
 * the same look, in the browser and in the tests.
 */

import { blackbodyLinear, glowIntensity, stellarColor } from './blackbody.js';
import { dwarfTemperature } from './stellarSystems.js';

const SOLAR_TEFF = 5772;
/** Earth's equilibrium temperature with no reflection, K: 278.6 × S^¼ × (1 − A)^¼ for any other. */
const EARTH_BLACKBODY_K = 278.6;
/** Silicate rock melts at roughly this temperature, K. */
const MELTING_K = 1400;
/** Chen & Kipping (2017): rocky below about 1.6 R⊕, gas-enveloped above. */
const ROCKY_RADIUS = 1.6;

/**
 * Habitable zone, as the flux (relative to Earth's) at its inner edge (runaway
 * greenhouse) and outer edge (maximum greenhouse) for an Earth-mass planet:
 * Kopparapu et al. (2014), ApJL 787 L29, Table 1. Valid for 2,600-7,200 K.
 */
const HZ = {
  inner: [1.107, 1.332e-4, 1.58e-8, -8.308e-12, -1.931e-15],
  outer: [0.356, 6.171e-5, 1.698e-9, -3.198e-12, -5.575e-16],
};
export function habitableZone(teff) {
  const t = Math.min(Math.max(teff ?? SOLAR_TEFF, 2600), 7200) - 5780;
  const flux = ([s, a, b, c, d]) => s + a * t + b * t ** 2 + c * t ** 3 + d * t ** 4;
  return { inner: flux(HZ.inner), outer: flux(HZ.outer) };
}

/* --- stars ------------------------------------------------------------------ */

/**
 * A star's kind and surface. `teff` may be an estimate; `teffNote` says so.
 *
 * Granules are convection cells, about ten pressure scale heights across, and
 * a scale height goes as T/g: relative to the star, d/R ≈ 0.0019 (T/5772)(R/M)
 * (Trampedach et al. 2013). The Sun's millions of granules are far too small
 * to draw, so the size is compressed; a giant's few thousand still come out
 * visibly coarser than a dwarf's.
 */
export function starLook({ name = '', teff = null, radiusSun = 1, massSun = null, logg = null, spectype = '' }) {
  const notes = [];
  let temperature = positive(teff) ? teff : null;
  const remnant = /^PSR\s/.test(name) || /pulsar|neutron/i.test(spectype ?? '') ? 'neutron'
    : /^(D[ABCOQXZ]|WD)/i.test(spectype ?? '') || (radiusSun < 0.03 && temperature > 3500) ? 'whiteDwarf'
    : null;
  if (!temperature && !remnant) {
    temperature = dwarfTemperature({ spectype, mass: massSun });
    if (temperature) {
      notes.push(`Temperature not reported: its colour assumes about ${round(temperature, 2)} K, typical of a main-sequence star of its ${/^[BAFGKM]/.test(spectype ?? '') ? 'spectral type' : 'mass'} (Pecaut & Mamajek 2013).`);
    }
  }
  const type = remnant
    ?? (temperature && temperature < 2400 ? 'brownDwarf'
      : (Number.isFinite(logg) && logg < 3.6) || radiusSun > 4 ? 'giant'
      : 'dwarf');
  if (type === 'neutron') temperature ??= 30000;
  if (type === 'whiteDwarf') temperature ??= 10000;
  temperature ??= SOLAR_TEFF;

  const seed = hash(name, 'star');
  const mass = positive(massSun) ? massSun : Number.isFinite(logg) ? 10 ** logg * radiusSun ** 2 / 27420 : 1;
  const cell = 0.0019 * (temperature / SOLAR_TEFF) * radiusSun / Math.max(mass, 0.05);
  // Hot stars have radiative envelopes and next to no visible granulation.
  const convective = 1 - smoothstep(6800, 8200, temperature);
  // Spots cover more of cooler, more active stars, and are darker against a
  // hotter photosphere: ~2000 K cooler on a G star, ~200 K on an M dwarf
  // (Berdyugina 2005, Living Reviews in Solar Physics 2, 8).
  const spots = type === 'dwarf' || type === 'giant'
    ? (temperature < 3900 ? 0.08 + 0.08 * seed : temperature < 5300 ? 0.06 : temperature < 6200 ? 0.03 : 0) * (type === 'giant' ? 0.5 : 1)
    : 0;
  const spotContrast = clamp(200 + (temperature - 3200) * 0.643, 200, 2000);

  return {
    type, teff: temperature, seed,
    color: stellarColor(temperature),
    // Cells per unit of radius on the painted map: about 125 round a Sun-like star.
    granules: type === 'dwarf' || type === 'giant' ? clamp(20 * (cell / 0.0019) ** -0.4, 4, 26) : 0,
    granuleContrast: (type === 'giant' ? 0.24 : 0.16) * convective,
    spots, spotTemperature: temperature - spotContrast,
    polarSpots: temperature < 3900,
    // A brown dwarf is painted like a young giant planet: cloud bands, glowing.
    banded: type === 'brownDwarf' ? { ...youngLook(temperature, (salt) => hash(name, salt)), seed } : null,
    notes: [...notes, ...STAR_NOTES[type]],
  };
}

const STAR_NOTES = {
  dwarf: ['Surface detail is illustrative: granulation, spots and limb darkening follow the star’s temperature and size, not an image of this star.'],
  giant: ['A giant star: its convection cells are far larger relative to its size than the Sun’s, so its surface is drawn coarser. Detail is illustrative.'],
  whiteDwarf: ['A white dwarf: the Earth-sized core of a star that has shed its outer layers. Its gravity is so strong that no surface detail would be visible.'],
  brownDwarf: ['A brown dwarf, too small to sustain fusion: at this temperature it is drawn with cloud bands, glowing a dull magenta-red as sodium and potassium absorb its green light.'],
  neutron: ['A pulsar: a neutron star about 20 km across. The two beams are illustrative; its real beams are radio waves, invisible to the eye, and sweep round many times a second.'],
};

/* --- planets ---------------------------------------------------------------- */

/**
 * The light a planet gets and the temperature it settles at.
 *
 * @param {{luminosity: number|null}} star Solar luminosities, all stars it circles.
 * @returns {{flux: number, teq: (albedo: number) => number}|null} Flux relative to Earth's.
 */
export function climate(star, aAU, e = 0) {
  if (!positive(star?.luminosity) || !positive(aAU)) return null;
  // Averaged over an eccentric orbit, the flux goes as 1/(a²√(1−e²)).
  const flux = star.luminosity / (aAU ** 2 * Math.sqrt(1 - Math.min(e ?? 0, 0.99) ** 2));
  return { flux, teq: (albedo) => EARTH_BLACKBODY_K * flux ** 0.25 * (1 - albedo) ** 0.25 };
}

/** Luminosity in L☉: from radius and temperature, else from mass as a main-sequence star. */
export function luminosity({ radiusSun, teff, massSun, type }) {
  if (type === 'neutron') return null;
  if (positive(radiusSun) && positive(teff)) return radiusSun ** 2 * (teff / SOLAR_TEFF) ** 4;
  if (!positive(massSun)) return null;
  return massSun < 0.43 ? 0.23 * massSun ** 2.3 : massSun < 2 ? massSun ** 4 : 1.4 * massSun ** 3.5;
}

/**
 * @param {object} planet
 * @param {string} planet.name
 * @param {number} planet.radius     R⊕, measured or estimated.
 * @param {number|null} planet.mass  M⊕, measured (or M sin i), else null.
 * @param {boolean} planet.radiusMeasured
 * @param {number} planet.aAU
 * @param {number} planet.e
 * @param {string} [planet.discovery]
 * @param {object} star  The light it gets: {luminosity, teff, massSun, type}.
 */
export function planetLook({ name, radius, mass = null, massLimit = null, radiusMeasured = true, aAU, e = 0, discovery = '' }, star) {
  const seed = hash(name, 'planet');
  const random = (salt) => hash(name, salt);
  const notes = [];
  const light = climate(star, aAU, e);
  const density = positive(mass) && radiusMeasured ? 5.51 * mass / radius ** 3 : null;
  const massEstimate = positive(mass) ? mass : massFromRadius(radius);
  const teff = star?.teff ?? SOLAR_TEFF;

  // Rock, a small gas-enveloped planet, an ice giant or a gas giant.
  let size = radius < ROCKY_RADIUS ? 'rock' : radius < 3.2 ? 'subneptune' : radius < 7 ? 'neptune' : 'giant';
  if (size === 'rock' && density !== null && density < 3) size = 'subneptune';
  if (size === 'subneptune' && radius < 2 && density !== null && density > 5) size = 'rock';
  if (size === 'neptune' && positive(mass) && mass > 80) size = 'giant';
  // With only a limit on its mass the drawn size is a placeholder; the limit
  // still says which kind of world it is.
  if (!positive(mass) && !radiusMeasured && positive(massLimit)) size = massLimit > 50 ? 'giant' : massLimit > 10 ? 'neptune' : size;
  const puffy = (size === 'giant' || size === 'neptune') && density !== null && density < 0.15;

  // Tides lock the spin of anything close enough to its star: Peale's (1977)
  // lock radius, 0.027 (P₀t/Q)^⅙ M^⅓ AU, for a 13.5 h initial day, 4.5 Gyr and
  // Q = 100 for rock or 10⁵ for gas (as in Kasting, Whitmire & Reynolds 1993).
  const q = size === 'rock' ? 100 : 1e5;
  const lockAU = 0.027 * ((13.5 * 4.5e9) / q) ** (1 / 6) * Math.cbrt(positive(star?.massSun) ? star.massSun : 1);
  const locked = star?.circumbinary ? false : aAU < lockAU;

  let look;
  if (!light) {
    // A pulsar, or a host with no usable size, temperature or mass: drawn
    // cold, with no temperature claimed.
    const pulsar = star?.type === 'neutron';
    look = size === 'rock' ? rockyLook({ kind: 'barren', temperature: null, random, notes: [], pulsar })
      : gasLook({ size, temperature: 100, random, puffy, notes: [] });
    look.temperature = null;
    notes.push(pulsar && size === 'rock'
      ? 'Drawn as bare, dark rock: a pulsar’s wind of particles and radiation would long since have stripped away any atmosphere.'
      : pulsar ? 'A pulsar gives off almost no visible light, so it is drawn as a cold world.'
        : 'Its star’s brightness is not known, so it is drawn as a cold world, as most planets this far from a star are.');
  } else if (size === 'rock') {
    look = rockyWorld({ light, radius, massEstimate, teff, locked, random, notes });
  } else if (/Imaging/.test(discovery) && size === 'giant' && aAU > 3) {
    look = youngGiant({ random, notes });
  } else {
    const temperature = light.teq(0.3);
    look = gasLook({ size, temperature, random, puffy, notes, locked });
  }

  const temperature = look.temperature ?? light?.teq(look.albedo ?? 0.3);
  look.seed = seed;
  look.teq = temperature ? Math.round(temperature) : null;
  look.flux = light?.flux ?? null;
  look.tidallyLocked = locked;

  // Rings. None has been seen round an exoplanet, but most of our own giants
  // have them, and rings of ice last only where it stays frozen.
  if ((size === 'giant' || size === 'neptune') && !locked && temperature < 200 && random('rings') < 0.4) {
    const inner = 1.2 + random('ring-inner') * 0.35;
    look.rings = {
      innerRadii: inner, outerRadii: Math.min(2.45, inner + 0.45 + random('ring-outer') * 0.75),
      opacity: 0.55 + random('ring-opacity') * 0.4,
      palette: random('ring-colour') < 0.6 ? ['#d8cdb8', '#b9a98f', '#efe6d6'] : ['#a9a7a4', '#8b8784', '#cfccc6'],
    };
    notes.push('The rings are illustrative: none has been detected. Cold giants like this one could keep rings of ice, as Saturn and Uranus do.');
  }

  if (locked) {
    notes.push('Drawn tidally locked, one side always facing its star: tides are expected to have stopped the spin of a planet this close (Kasting, Whitmire & Reynolds 1993).');
    look.spin = { tiltDeg: 0 };
  } else {
    const hours = size === 'giant' ? 9 + 7 * random('day') : size === 'neptune' ? 13 + 7 * random('day') : 14 + 30 * random('day');
    look.spin = { periodHours: hours, tiltDeg: (look.rings ? 12 : 3) + random('tilt') * (look.rings ? 20 : 22) };
  }

  look.color = look.palette[2];
  look.notes = notes;
  return look;
}

/* --- rocky worlds ----------------------------------------------------------- */

/**
 * Whether a rocky planet keeps an atmosphere: Zahnle & Catling's (2017)
 * "cosmic shoreline", the line I ∝ v_esc⁴ that divides the Solar System's
 * bodies with air from those without. Fit to them it runs through about
 * 8.5×10⁻⁴ (v/km s⁻¹)⁴ times Earth's flux. Red and orange dwarfs pour out far
 * more of their light as atmosphere-stripping X-rays and ultraviolet, and for
 * longer, so their shoreline is drawn ten and three times lower.
 */
function keepsAtmosphere(flux, massEstimate, radius, teff) {
  const escape = 11.19 * Math.sqrt(massEstimate / radius);
  const activity = teff < 3900 ? 10 : teff < 5300 ? 3 : 1;
  return flux < 8.5e-4 * escape ** 4 / activity;
}

function rockyWorld({ light, radius, massEstimate, teff, locked, random, notes }) {
  const substellar = light.teq(0.1) * Math.SQRT2;
  if (substellar > 1500) {
    notes.push(`Drawn as a lava world: the point facing its star is estimated at about ${round(substellar, 2)} K, hot enough to melt rock.`);
    return rockyLook({ kind: 'lava', temperature: light.teq(0.1), substellar, random, notes });
  }
  const zone = habitableZone(teff);
  if (!keepsAtmosphere(light.flux, massEstimate, radius, teff)) {
    notes.push(`Drawn without an atmosphere: it gets ${fluxText(light.flux)} Earth’s sunlight, and bodies this small in that much light have lost theirs (Zahnle & Catling’s 2017 “cosmic shoreline”${teff < 5300 ? ', lowered for its active star' : ''}). Whether it has one is not known.`);
    return rockyLook({ kind: 'barren', temperature: light.teq(0.1), random, notes });
  }
  if (light.flux > zone.inner) {
    notes.push(`Drawn under thick cloud, like Venus: it gets ${fluxText(light.flux)} Earth’s sunlight, past the point where oceans would boil away in a runaway greenhouse (Kopparapu et al. 2014). Its real atmosphere is not known.`);
    return rockyLook({ kind: 'cloudy', temperature: light.teq(0.75), albedo: 0.75, random, notes });
  }
  if (light.flux >= zone.outer) {
    const eyeball = locked && teff < 4000;
    notes.push(`In the habitable zone: it gets ${fluxText(light.flux)} Earth’s sunlight, the range where liquid water could last on the surface (Kopparapu et al. 2014). ` +
      (eyeball
        ? 'Drawn as an “eyeball” world, frozen except for an open sea under its star, one possibility for a tidally locked planet (Pierrehumbert 2011). '
        : 'Seas, land and clouds are drawn as one possibility. ') +
      'Whether it has water or air at all is not known.');
    return rockyLook({ kind: eyeball ? 'eyeball' : 'temperate', temperature: light.teq(0.3), flux: light.flux, zone, random, notes });
  }
  notes.push(`Drawn frozen over: it gets ${fluxText(light.flux)} Earth’s sunlight, less than the outer edge of the habitable zone (Kopparapu et al. 2014).`);
  return rockyLook({ kind: 'ice', temperature: light.teq(0.5), albedo: 0.5, random, notes });
}

function rockyLook({ kind, temperature, substellar = 0, flux = 1, zone = null, random, notes, albedo = 0.1, pulsar = false }) {
  const pick = (options) => options[Math.floor(random('palette') * options.length)];
  switch (kind) {
    case 'lava': {
      // The molten region is where the local temperature, T_ss cos^¼ψ, is
      // above the melting point.
      const sea = Math.acos(Math.min(1, (MELTING_K / substellar) ** 4));
      return {
        type: 'lava', label: 'Lava world', temperature, albedo,
        palette: jitter(['#141110', '#241e1a', '#372c25', '#4d3e33'], random),
        terrain: { craters: 0.2, roughness: 0.7, lavaSea: sea, cracks: 0.6 + 0.3 * random('cracks') },
        heat: heat(substellar, 900), bump: 0.02, terminator: 0,
      };
    }
    case 'barren': {
      const hot = temperature !== null && temperature > 450;
      const palette = pulsar ? ['#1d1c1f', '#2f2d31', '#4a4649', '#686164']
        : hot ? pick([['#2e2a27', '#4a433d', '#6c6259', '#8f8276'], ['#3a2c24', '#5c4536', '#81644f', '#a4866c']])
          : pick([['#3f3d3b', '#63605c', '#8b8781', '#b3aea6'], ['#4d3226', '#7a4f3a', '#a4704f', '#c69a74'], ['#45403a', '#6d655a', '#978b7b', '#bdb1a0']]);
      return {
        type: 'barren', label: pulsar ? 'Pulsar planet' : 'Airless rocky planet', temperature, albedo,
        palette: jitter(palette, random),
        terrain: { craters: 0.7 + 0.3 * random('craters'), roughness: 0.6 },
        bump: 0.022, terminator: 0,
      };
    }
    case 'cloudy':
      return {
        type: 'cloudy', label: 'Venus-like world', temperature, albedo,
        palette: jitter(pick([['#a8884e', '#c9ab70', '#e2cb98', '#f2e6c4'], ['#9c8a6a', '#bcab88', '#d8cbaa', '#eee6d0']]), random),
        bands: { frequency: 5, contrast: 0.35, turbulence: 0.9, stretch: 2.2, storms: 0, chevron: 0.6 },
        glow: { color: '#f3dcae', intensity: 0.9, height: 0.045 }, terminator: 0.22,
      };
    case 'temperate':
    case 'eyeball': {
      // Warmer planets in the zone get more open sea and smaller ice caps.
      const warmth = clamp((flux - zone.outer) / (zone.inner - zone.outer), 0, 1);
      return {
        type: kind, label: kind === 'eyeball' ? 'Eyeball world' : 'Temperate rocky planet', temperature, albedo: 0.3,
        palette: jitter(pick([['#4a3c30', '#6e5c47', '#94806a', '#e9eef2'], ['#3c3a34', '#5e5a4e', '#857e6c', '#e6ecf0'], ['#553628', '#7c5039', '#a0765a', '#eceff1']]), random),
        ocean: ['#0b2140', '#1a4a6e'],
        terrain: {
          craters: 0.05, roughness: 0.55,
          sea: kind === 'eyeball' ? 0.8 : 0.4 + 0.35 * random('sea'),
          ice: kind === 'eyeball' ? 0.3 + 0.9 * warmth : 1.25 - 0.55 * warmth,
        },
        clouds: { coverage: 0.35 + 0.25 * random('clouds'), color: '#ffffff' },
        glow: { color: '#6a9dff', intensity: 1.0, height: 0.035 }, terminator: 0.06,
        bump: 0.014, specular: true,
      };
    }
    case 'ice':
      return {
        type: 'ice', label: 'Frozen rocky planet', temperature, albedo,
        palette: jitter(pick([['#8d9fb2', '#b8c7d6', '#dde7ef', '#8a6c58'], ['#9ea4ab', '#c5cbd0', '#e8ecee', '#7d6a5c']]), random),
        terrain: { craters: 0.25, roughness: 0.3, cracks: 0.7 },
        clouds: { coverage: 0.15 + 0.15 * random('clouds'), color: '#f2f6ff' },
        glow: { color: '#a8c4ff', intensity: 0.45, height: 0.025 }, terminator: 0.03,
        bump: 0.01, specular: true,
      };
    default:
      throw new Error(`Unknown rocky world ${kind}`);
  }
}

/* --- gas and ice giants ----------------------------------------------------- */

/**
 * Giant planets by temperature, after Sudarsky, Burrows & Hubeny (2003):
 * ammonia clouds below ~150 K (class I), water clouds to ~350 K (II), clear
 * blue skies to ~800 K (III), dark alkali-metal absorption to ~1,400 K (IV),
 * then silicate clouds and a glowing night side (V). Neptune-sized planets
 * follow Uranus and Neptune when cold, and turn hazy as they warm.
 */
function gasLook({ size, temperature, random, puffy, notes, locked = false }) {
  const pick = (options) => options[Math.floor(random('palette') * options.length)];
  const t = round(temperature, 2);
  const hot = heatFor(temperature, locked);
  let look;
  if (puffy) {
    look = { type: 'haze', label: 'Super-puff', albedo: 0.3,
      palette: ['#8c7a64', '#a8957a', '#c6b394', '#ddd0b6'],
      bands: { frequency: 4, contrast: 0.12, turbulence: 0.3, stretch: 5, storms: 0 },
      glow: { color: '#e6d2a8', intensity: 1.2, height: 0.08 }, terminator: 0.3 };
    notes.push('Drawn as a haze-wrapped “super-puff”: its density is far below Saturn’s, which suggests a deep, extended atmosphere hidden under high haze.');
  } else if (size === 'giant') {
    if (temperature < 150) {
      look = { type: 'gas', label: 'Class I gas giant', albedo: 0.34,
        palette: pick([['#7d5237', '#b88d63', '#e7d6b8', '#b0503a'], ['#a88c5e', '#cdb384', '#ecdfc0', '#c09a62'], ['#6e5a48', '#a48c70', '#d9ccb2', '#9a6040']]),
        bands: { frequency: 14 + 8 * random('bands'), contrast: 0.9, turbulence: 1, stretch: 5, storms: 1 + Math.floor(random('storms') * 3) },
        glow: { color: '#f1e0b4', intensity: 0.45, height: 0.02 }, terminator: 0.14 };
      notes.push(`Drawn with ammonia-cloud bands like Jupiter’s: at about ${t} K, a giant this cold is expected to have ammonia clouds (Sudarsky et al. 2003, class I).`);
    } else if (temperature < 350) {
      look = { type: 'gas', label: 'Class II gas giant', albedo: 0.8,
        palette: ['#b3b8bb', '#d3d6d5', '#f2f0ea', '#c7b89c'],
        bands: { frequency: 12 + 6 * random('bands'), contrast: 0.45, turbulence: 0.8, stretch: 6, storms: Math.floor(random('storms') * 2) },
        glow: { color: '#e4ecf6', intensity: 0.55, height: 0.022 }, terminator: 0.14 };
      notes.push(`Drawn bright white: at about ${t} K, a giant is expected to be covered in water clouds and reflect most of its light (Sudarsky et al. 2003, class II).`);
    } else if (temperature < 800) {
      look = { type: 'gas', label: 'Class III gas giant', albedo: 0.12,
        palette: ['#173a73', '#2d5ea6', '#5f8ecf', '#a4c2ea'],
        bands: { frequency: 10 + 6 * random('bands'), contrast: 0.5, turbulence: 0.7, stretch: 6, storms: Math.floor(random('storms') * 2) },
        glow: { color: '#79aaff', intensity: 0.8, height: 0.025 }, terminator: 0.14 };
      notes.push(`Drawn azure: at about ${t} K, a giant is too warm for clouds, and its clear air scatters blue light while methane absorbs red (Sudarsky et al. 2003, class III).`);
    } else if (temperature < 1400) {
      look = { type: 'gas', label: 'Class IV hot Jupiter', albedo: 0.05,
        palette: ['#141319', '#221f29', '#3a323c', '#5a4034'],
        bands: { frequency: 8, contrast: 0.45, turbulence: 0.6, stretch: 7, storms: 0 },
        glow: { color: '#8c6a7a', intensity: 0.35, height: 0.03 }, terminator: 0.14 };
      notes.push(`Drawn very dark: at about ${t} K, sodium and potassium in a giant’s air absorb most visible light, and hot Jupiters are observed to reflect only a few per cent of it (Sudarsky et al. 2003, class IV).`);
    } else {
      const ultra = hot?.high > 2200;
      look = { type: 'gas', label: ultra ? 'Ultra-hot Jupiter' : 'Class V hot Jupiter', albedo: 0.1,
        palette: ultra ? ['#2c1a12', '#4a2a18', '#6e4228', '#9a6a44'] : ['#231a19', '#3d2c28', '#6a5a50', '#9a8e84'],
        bands: { frequency: 7, contrast: 0.35, turbulence: 0.5, stretch: 7, storms: 0, westClouds: ultra ? 0.4 : 0.8 },
        glow: { color: ultra ? '#ffb070' : '#c98a5a', intensity: 0.5, height: 0.035 }, terminator: 0.14 };
      notes.push(ultra
        ? `Drawn glowing: its day side is estimated at about ${round(hot.high, 2)} K, hot enough to shine like a dim star. Winds carry the heat east, so the hottest point sits east of noon, and clouds form only on the cooler morning side.`
        : `Drawn dark with a glowing night side: at about ${t} K, silicate clouds can form, but the planet is hot enough to glow a dull red (Sudarsky et al. 2003, class V).`);
    }
  } else {
    // Neptunes and sub-Neptunes.
    const small = size === 'subneptune';
    const noun = small ? 'sub-Neptune' : 'Neptune-sized planet';
    if (temperature < 200) {
      look = { type: 'gas', label: small ? 'Cold sub-Neptune' : 'Ice giant', albedo: 0.3,
        // Uranus and Neptune are both a pale greenish blue (Irwin et al. 2024).
        palette: pick([['#4d7f9c', '#6e9fb8', '#9cc3d2', '#e6f0f4'], ['#5fa6b8', '#84c1ce', '#b6dfe4', '#eef8f8'], ['#2f5a98', '#4a78b4', '#7fa3d0', '#e4ecf6']]),
        bands: { frequency: 8, contrast: 0.3, turbulence: 0.6, stretch: 6, storms: Math.floor(random('storms') * 2), dark: true },
        glow: { color: '#86b8ff', intensity: 0.75, height: 0.03 }, terminator: 0.16 };
      notes.push(`Drawn blue like Uranus and Neptune: at about ${t} K, methane in its air would absorb red light.`);
    } else if (temperature < 500) {
      look = { type: 'gas', label: small ? 'Temperate sub-Neptune' : 'Warm Neptune', albedo: 0.35,
        palette: ['#34666f', '#548790', '#8fb3b4', '#e8eeea'],
        bands: { frequency: 7, contrast: 0.35, turbulence: 0.9, stretch: 5, storms: 0 },
        glow: { color: '#9fd4d6', intensity: 0.8, height: 0.03 }, terminator: 0.16 };
      notes.push(`Drawn blue-green with pale water clouds: at about ${t} K, water can condense high in a ${noun}’s air.`);
    } else if (temperature < 1000) {
      look = { type: 'haze', label: small ? 'Hazy sub-Neptune' : 'Hazy warm Neptune', albedo: 0.4,
        palette: ['#8e877a', '#aba496', '#c8c2b4', '#e0dbcf'],
        bands: { frequency: 5, contrast: 0.18, turbulence: 0.5, stretch: 5, storms: 0 },
        glow: { color: '#e0c89a', intensity: 1.0, height: 0.05 }, terminator: 0.22 };
      notes.push(`Drawn under pale haze: at about ${t} K, starlight can break down methane high in a ${noun}’s air into a bright smog, as on GJ 1214 b (Kempton et al. 2023).`);
    } else {
      look = { type: 'gas', label: small ? 'Hot sub-Neptune' : 'Hot Neptune', albedo: 0.1,
        palette: ['#241f1e', '#393130', '#57493f', '#7a6552'],
        bands: { frequency: 6, contrast: 0.3, turbulence: 0.5, stretch: 6, storms: 0 },
        glow: { color: '#d69a6a', intensity: 0.5, height: 0.04 }, terminator: 0.16 };
      notes.push(`Drawn dark and glowing: at about ${t} K, a ${noun}’s air is hot enough to glow.`);
    }
  }
  look.palette = jitter(look.palette, random);
  look.bump = 0;
  // The temperature the class was chosen by, so the two always agree.
  look.temperature = temperature;
  if (hot) look.heat = hot;
  return look;
}

/**
 * Planets found by direct imaging are young, a few to a few hundred million
 * years old, and still hot from forming: they glow in the infrared, which is
 * how they are seen at all. Most imaged giants are L-type, around 1,000-1,800 K,
 * with dusty clouds.
 */
function youngGiant({ random, notes }) {
  notes.push('Drawn glowing through dusty clouds: planets found by direct imaging are young, still hot from their formation (typically 1,000–1,800 K), and glow in the infrared. Its temperature is not in the archive, so 1,300 K is assumed.');
  return youngLook(1300, random);
}

/**
 * A self-luminous giant or brown dwarf by temperature. Sodium and potassium
 * absorb green light, so dusty L types look red to purple (Burrows et al.
 * 2001 give an L5 as R:G:B ≈ 1 : 0.3 : 0.42); below the L/T transition
 * (~1,300 K) the dust clears and methane turns them a dull magenta.
 */
export function youngLook(temperature, random = () => 0.5) {
  const methane = temperature < 1300;
  return {
    type: 'gas', label: methane ? 'Young methane giant' : 'Young dusty giant', temperature, albedo: 0.1,
    palette: jitter(methane ? ['#26121f', '#452038', '#723a5e', '#9c5c84'] : ['#2e0f16', '#521c28', '#80323f', '#b0555e'], random),
    bands: { frequency: 10 + 6 * random('bands'), contrast: 0.55, turbulence: 0.8, stretch: 6, storms: Math.floor(random('storms') * 2) },
    heat: { low: temperature * 0.85, high: temperature, shift: 0, uniform: true },
    glow: { color: methane ? '#a060a8' : '#d0506a', intensity: 0.5, height: 0.03 }, terminator: 0.14, bump: 0,
  };
}

/**
 * Thermal glow for a hot giant. A tidally locked one has a day side hotter
 * than its night side: with ε the fraction of heat carried round (0 none, 1
 * all), T_day = T₀(⅔ − 5ε/12)^¼ and T_night = T₀(ε/4)^¼, where T₀ = √2·Teq
 * (Cowan & Agol 2011). The hottest planets carry the least round (Komacek &
 * Showman 2016); observed night sides cluster near 1,100 K (Keating et al.
 * 2019). Winds push the hottest point 10-20° east of noon on hot Jupiters
 * (Knutson et al. 2007), and only a few degrees on ultra-hot ones.
 */
function heatFor(teq, locked) {
  if (teq < 900) return null;
  if (!locked) return { low: teq * 0.9, high: teq, shift: 0, uniform: true };
  const ultra = teq > 1900;
  const epsilon = ultra ? 0.1 : teq > 1000 ? 0.4 : 0.6;
  const t0 = teq * Math.SQRT2;
  return {
    low: t0 * (epsilon / 4) ** 0.25, high: t0 * (2 / 3 - 5 * epsilon / 12) ** 0.25,
    shift: (ultra ? 4 : 15) * Math.PI / 180, uniform: false,
  };
}

function heat(high, low) {
  return { low, high, shift: 0, uniform: false };
}

/** The glow colours at either end of a heat map, as linear RGB radiance. */
export function heatRadiance({ low, high }) {
  const at = (t) => blackbodyLinear(t).map((c) => c * glowIntensity(t));
  return { low: at(low), high: at(high) };
}

/* --- helpers ---------------------------------------------------------------- */

/** Chen & Kipping (2017), inverted: a mass for a planet with only a radius. */
function massFromRadius(radius) {
  return radius <= 1.23 ? (radius / 1.008) ** (1 / 0.279) : (radius / 0.808) ** (1 / 0.589);
}

/** Small, repeatable shifts in hue and lightness, so neighbours differ. */
function jitter(palette, random) {
  const hueShift = (random('hue') - 0.5) * 0.05;
  const light = 1 + (random('light') - 0.5) * 0.16;
  return palette.map((hex) => {
    const [h, s, l] = hexToHsl(hex);
    return hslToHex((h + hueShift + 1) % 1, s, clamp(l * light, 0, 1));
  });
}

function hexToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (t) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(h + 1 / 3)}${channel(h)}${channel(h - 1 / 3)}`;
}

/** A repeatable number in [0, 1) for a name and a purpose. */
export function hash(text, salt = '') {
  let n = 2166136261;
  for (const char of `${salt}:${text}`) n = Math.imul(n ^ char.charCodeAt(0), 16777619);
  n = Math.imul(n ^ (n >>> 15), 2246822507);
  n = Math.imul(n ^ (n >>> 13), 3266489909);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fluxText(flux) {
  if (flux >= 1.5) return `about ${round(flux, 2)} times`;
  if (flux > 0.75) return 'about the same as';
  return `about ${round(flux * 100, 2)}% of`;
}

function round(value, digits) {
  return Number(value.toPrecision(digits)).toLocaleString('en-US');
}
function positive(value) { return Number.isFinite(value) && value > 0; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
