/**
 * Measured dust around other stars: debris belts (rubble left over from
 * forming planets, ground to dust by collisions) and the gapped disks of stars
 * still forming them. Only disks whose edges have been resolved, mostly by
 * ALMA, by NASA archive host name. Radii are in AU as published; where a paper
 * used a slightly different distance to the star, its radii are kept as given.
 *
 * Each belt: [inner AU, outer AU]. `dust` is the scattered-light colour where
 * it has been measured (β Pic's dust is red, AU Mic's blue); otherwise neutral.
 */
const DISKS = {
  'bet Pic': {
    belts: [[50, 150]], dust: 'red',
    note: 'A debris belt from about 50 to 150 AU, seen edge-on from Earth; its dust is redder farther out.',
    ref: ['Matrà et al. 2019, AJ 157, 135', 'https://doi.org/10.3847/1538-3881/ab06c0'],
  },
  'eps Eri': {
    belts: [[63, 75]],
    note: 'A narrow ring of icy debris about 69 AU from the star, with sharp edges.',
    ref: ['Booth et al. 2017, MNRAS 469, 3200', 'https://arxiv.org/abs/1705.01560'],
  },
  'tau Cet': {
    belts: [[6.2, 52]],
    note: 'A broad debris belt from about 6 to 52 AU; its inner edge is poorly constrained.',
    ref: ['MacGregor et al. 2016, ApJ 828, 113', 'https://doi.org/10.3847/0004-637X/828/2/113'],
  },
  'HR 8799': {
    belts: [[135, 360]],
    note: 'A broad, cold debris belt beyond the four planets, from about 135 AU outward, brightest near 170–200 AU.',
    ref: ['Faramaz et al. 2021, AJ 161, 271', 'https://doi.org/10.3847/1538-3881/abf4e0'],
  },
  'AU Mic': {
    belts: [[8.8, 40]], dust: 'blue',
    note: 'An edge-on debris belt out to about 40 AU, where dust ground from colliding planetesimals is blown outward; its dust scatters blue light.',
    ref: ['MacGregor et al. 2013, ApJL 762, L21', 'https://doi.org/10.1088/2041-8205/762/2/L21'],
  },
  'HD 95086': {
    belts: [[106, 320]],
    note: 'A broad debris belt from about 106 to 320 AU, well outside its planet.',
    ref: ['Su et al. 2017, AJ 154, 225', 'https://doi.org/10.3847/1538-3881/aa906b'],
  },
  'HD 206893': {
    belts: [[30, 60], [88, 180]],
    note: 'A debris belt from about 30 to 180 AU with a 27 AU wide gap at 74 AU, which suggests a third, unseen planet.',
    ref: ['Marino et al. 2020, MNRAS 498, 1319', 'https://arxiv.org/abs/2010.12582'],
  },
  '61 Vir': {
    belts: [[30, 150]],
    note: 'A cold debris belt from about 30 to at least 150 AU.',
    ref: ['Marino et al. 2017, MNRAS 469, 3518', 'https://doi.org/10.1093/mnras/stx1102'],
  },
  'HD 10647': {
    belts: [[34, 134]],
    note: 'A debris belt from about 34 to 134 AU, brightest near 82 AU and lopsided, perhaps pulled by its eccentric giant planet.',
    ref: ['Lovell et al. 2021, MNRAS 506, 1978', 'https://doi.org/10.1093/mnras/stab1678'],
  },
  'HD 106906': {
    belts: [[50, 100]],
    note: 'A lopsided debris disk from about 50 to 100 AU around the central pair of stars. Its planet orbits far outside it, probably on a tilted orbit.',
    ref: ['Fehr et al. 2022, ApJ 939, 56', 'https://doi.org/10.3847/1538-4357/ac9235'],
  },
  'TWA 7': {
    belts: [[20, 36], [49, 55], [73, 113]],
    note: 'Three dust rings, at about 28, 52 and 93 AU. The planet, imaged by JWST, sits in a gap it has cleared in the middle ring.',
    ref: ['Lagrange et al. 2025, Nature 642, 905', 'https://doi.org/10.1038/s41586-025-09150-4'],
  },
  'PDS 70': {
    belts: [[59, 87]], young: true,
    note: 'A young star still forming planets: its two planets orbit in a wide gap they have carved in its disk, inside a ring of dust peaking near 74 AU.',
    ref: ['Keppler et al. 2019, A&A 625, A118', 'https://arxiv.org/abs/1902.07639'],
  },
  'HD 169142': {
    belts: [[21, 31], [56.5, 58], [63.3, 65], [74.3, 77.7]], young: true,
    note: 'A young disk: an inner ring near 26 AU, a wide gap where its planet orbits, then three narrow rings between 57 and 76 AU.',
    ref: ['Pérez et al. 2019, AJ 158, 15', 'https://doi.org/10.3847/1538-3881/ab1f88'],
  },
  'HD 100546': {
    belts: [[20, 40], [150, 250]], young: true,
    note: 'A young disk with a ring from about 20 to 40 AU and a faint outer ring from 150 to 250 AU; its planet orbits in the gap between them.',
    ref: ['Fedele et al. 2021, A&A 651, A90', 'https://doi.org/10.1051/0004-6361/202141278'],
  },
};

/** The measured disk around a system's host star, or null. */
export function diskFor(hostname) {
  const disk = DISKS[hostname];
  return disk ? { ...disk, reference: { label: disk.ref[0], href: disk.ref[1] } } : null;
}
