/**
 * The few exoplanets whose appearance has actually been observed, by NASA
 * archive name. Each replaces the guess from worlds.js with what was measured
 * (a colour, an albedo, a temperature, clouds, the lack of an atmosphere) and
 * says so, with the paper, in the info panel. Colours are chosen to match the
 * published description; only HD 189733 b's has been measured as a spectrum.
 */

import { youngLook } from './worlds.js';

const OBSERVED = {
  'HD 189733 b': {
    note: 'Its deep blue has been measured: the planet reflects blue light but absorbs green and red, likely scattering off high silicate haze while sodium absorbs the rest.',
    ref: ['Evans et al. 2013, ApJL 772, L16', 'https://doi.org/10.1088/2041-8205/772/2/L16'],
    look: { palette: ['#0c1b44', '#16306a', '#264991', '#4a6fb8'], label: 'Blue hot Jupiter' },
  },
  'Kepler-7 b': {
    note: 'Bright clouds have been mapped on its western, morning side, so it looks lopsided in visible light; the rest of its day side is dark.',
    ref: ['Demory et al. 2013, ApJL 776, L25', 'https://doi.org/10.1088/2041-8205/776/2/L25'],
    look: { bands: { westClouds: 1.4 } },
  },
  'TrES-2 b': {
    note: 'Darker than coal: it reflects around 1% of the light that falls on it, the least of any known planet.',
    ref: ['Kipping & Spiegel 2011, MNRAS 417, L88', 'https://arxiv.org/abs/1108.2297'],
    look: { palette: ['#060606', '#0b0a0a', '#131110', '#1d1714'] },
  },
  'WASP-12 b': {
    note: 'Near black: it reflects less than 6% of its starlight, and most of the light it gives off is its own heat. Its star is also pulling it apart.',
    ref: ['Bell et al. 2017, ApJL 847, L2', 'https://doi.org/10.3847/2041-8213/aa876c'],
    look: { palette: ['#0c0a09', '#15110f', '#221a16', '#34261e'] },
  },
  'LTT 9779 b': {
    note: 'An ultra-hot Neptune as reflective as Venus: bright metallic clouds on its day side reflect about 80% of its starlight.',
    ref: ['Hoyer et al. 2023, A&A 675, A81', 'https://doi.org/10.1051/0004-6361/202346117'],
    look: { type: 'haze', label: 'Mirror-bright hot Neptune', palette: ['#8e8c86', '#bdbbb4', '#e4e2dc', '#f6f5f0'], bands: { frequency: 5, contrast: 0.15, turbulence: 0.4, stretch: 5, storms: 0 } },
  },
  'KELT-9 b': {
    note: 'The hottest planet known: its day side is about 4,600 K, hotter than many stars, and even its night side, about 2,600 K, glows.',
    ref: ['Mansfield et al. 2020, ApJL 888, L15', 'https://doi.org/10.3847/2041-8213/ab5b09'],
    look: { heat: { low: 2556, high: 4566, shift: 18.7 * Math.PI / 180, uniform: false } },
  },
  'WASP-76 b': {
    note: 'Iron vaporises on its day side and condenses on the cooler night side: it rains iron.',
    ref: ['Ehrenreich et al. 2020, Nature 580, 597', 'https://doi.org/10.1038/s41586-020-2107-1'],
  },
  '55 Cnc e': {
    note: 'A lava world under a thin atmosphere of carbon monoxide or dioxide, probably breathed out by its magma ocean.',
    ref: ['Hu et al. 2024, Nature 630, 609', 'https://doi.org/10.1038/s41586-024-07432-x'],
    look: { glow: { color: '#ffb08a', intensity: 0.5, height: 0.03 } },
  },
  'K2-141 b': {
    note: 'A lava world: its day side is about 2,000 K, cooling steeply toward a night side too cold for any air to last.',
    ref: ['Zieba et al. 2022, A&A 664, A79', 'https://arxiv.org/abs/2203.00370'],
  },
  'LHS 3844 b': {
    note: 'Bare, dark rock: its day side is about 1,040 K and its night side near absolute zero, so it has no atmosphere to carry heat round.',
    ref: ['Kreidberg et al. 2019, Nature 573, 87', 'https://doi.org/10.1038/s41586-019-1497-4'],
    airless: true,
  },
  'TRAPPIST-1 b': {
    note: 'Probably bare rock: JWST measured a day side of about 500 K and no sign that an atmosphere carries heat to its night side.',
    ref: ['Greene et al. 2023, Nature 618, 39', 'https://doi.org/10.1038/s41586-023-05951-7'],
    airless: true,
  },
  'TRAPPIST-1 c': {
    note: 'JWST rules out a thick, Venus-like carbon dioxide atmosphere: it is bare rock or has only thin air.',
    ref: ['Zieba et al. 2023, Nature 620, 746', 'https://doi.org/10.1038/s41586-023-06232-z'],
    airless: true,
  },
  'GJ 1214 b': {
    note: 'Wrapped in bright haze or cloud that reflects about half its starlight, hiding everything below.',
    ref: ['Kempton et al. 2023, Nature 620, 67', 'https://doi.org/10.1038/s41586-023-06159-5'],
    look: { type: 'haze', palette: ['#a39e92', '#bdb8ac', '#d6d1c4', '#e8e4da'] },
  },
  'HR 8799 b': youngRed(900),
  'HR 8799 c': youngRed(1100),
  'HR 8799 d': youngRed(1100),
  'HR 8799 e': youngRed(1150),
  '51 Eri b': {
    note: 'A young Jupiter at about 700 K, cool enough for strong methane absorption: brown dwarfs this cool look a dull magenta.',
    ref: ['Macintosh et al. 2015, Science 350, 64', 'https://doi.org/10.1126/science.aac5891'],
    young: 700,
  },
  'bet Pic b': {
    note: 'A young giant at about 1,700 K with dusty clouds. Its day is only about 8 hours long, measured from the Doppler broadening of its spectrum.',
    ref: ['Snellen et al. 2014, Nature 509, 63', 'https://doi.org/10.1038/nature13253'],
    young: 1700, spinHours: 8.1,
  },
  'GJ 504 b': {
    note: 'About 510 K, still warm from its formation. NASA describes its colour as “dark cherry blossom, a dull magenta”.',
    ref: ['Kuzuhara et al. 2013, ApJ 774, 11', 'https://doi.org/10.1088/0004-637X/774/1/11'],
    young: 510,
  },
  'Kepler-51 b': superPuff(),
  'Kepler-51 c': superPuff(),
  'Kepler-51 d': superPuff(),
  'WASP-107 b': {
    note: 'Jupiter’s size but a tenth of its mass: its extended atmosphere holds high silicate clouds, and helium streams off it in a tail.',
    ref: ['Dyrek et al. 2024, Nature 625, 51', 'https://doi.org/10.1038/s41586-023-06849-0'],
    look: { type: 'haze', palette: ['#8a7a66', '#a8977e', '#c6b59a', '#ddd0b8'], glow: { color: '#e6d2a8', intensity: 1.2, height: 0.08 } },
  },
};

function youngRed(temperature) {
  return {
    note: `A young super-Jupiter at about ${temperature.toLocaleString('en-US')} K, still glowing from its formation. Thick, patchy mineral clouds make the HR 8799 planets redder than brown dwarfs of the same temperature.`,
    ref: ['Marois et al. 2008, Science 322, 1348', 'https://doi.org/10.1126/science.1166585'],
    young: temperature, dusty: true,
  };
}

function superPuff() {
  return {
    note: 'A “super-puff”: about Saturn’s size but only a few Earth masses, with a density below 0.1 g/cm³ and a flat, hazy spectrum.',
    ref: ['Libby-Roberts et al. 2020, AJ 159, 57', 'https://doi.org/10.3847/1538-3881/ab5d36'],
    look: { type: 'haze', label: 'Super-puff', palette: ['#9c8c72', '#b7a68a', '#cdbfa3', '#e0d5bf'], bands: { frequency: 4, contrast: 0.12, turbulence: 0.3, stretch: 5, storms: 0 }, glow: { color: '#e6d2a8', intensity: 1.2, height: 0.08 } },
  };
}

/** Every planet with an observed appearance, by archive name. */
export const OBSERVED_PLANETS = Object.keys(OBSERVED);

/**
 * A planet's look with anything observed applied, and the observation's note
 * in place of the guess's. Returns the look unchanged if nothing is known.
 */
export function observedLook(look, name) {
  const observed = OBSERVED[name];
  if (!observed) return look;
  let next = { ...look };
  if (observed.young) {
    const young = youngLook(observed.young);
    if (observed.dusty) Object.assign(young, { palette: youngLook(1400).palette, label: 'Young dusty giant', glow: youngLook(1400).glow });
    next = { ...next, ...young, seed: look.seed, teq: observed.young };
    next.color = next.palette[2];
  }
  if (observed.airless) {
    next = { ...next, type: 'barren', label: 'Airless rocky planet', glow: null, clouds: null, terminator: 0, specular: false, bump: 0.022,
      palette: ['#2f2c2a', '#4a4541', '#6a635c', '#8a8178'], terrain: { craters: 0.8, roughness: 0.6 } };
    next.color = next.palette[2];
  }
  if (observed.look) {
    next = { ...next, ...observed.look, bands: { ...look.bands, ...observed.look.bands } };
    if (observed.look.palette) next.color = observed.look.palette[2];
  }
  if (observed.spinHours && next.spin?.periodHours) next.spin = { ...next.spin, periodHours: observed.spinHours };
  // The guess's reasoning (always the first note) gives way to the observation,
  // and nothing invented is added to a planet that has been observed.
  next.rings = null;
  next.notes = [observed.note, ...look.notes.slice(1).filter((note) => !note.startsWith('The rings are illustrative'))];
  next.reference = { label: observed.ref[0], href: observed.ref[1] };
  return next;
}
