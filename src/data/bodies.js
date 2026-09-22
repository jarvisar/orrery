/**
 * The catalogue every part of the app is built from.
 *
 * Nothing here is a scene unit. These are real measurements - kilometres,
 * days, degrees - and `src/scene/scaling.js` is the single place that turns
 * them into something you can actually look at. Adding a body means adding an
 * entry here and a texture; no other file needs to change.
 *
 * Planetary orbits use the J2000 osculating elements from JPL's "Keplerian
 * Elements for Approximate Positions of the Major Planets" (valid 1800-2050).
 * Dwarf-planet and satellite elements are mean values rounded from the JPL
 * Small-Body Database and the Planetary Satellite Mean Elements tables; they
 * are good enough to place a body on the right side of its primary, not to
 * navigate by.
 */

/** Astronomical unit, kilometres. */
export const AU_KM = 149_597_870.7;

/** Earth's volumetric mean radius - the yardstick for relative sizes. */
export const EARTH_RADIUS_KM = 6371;

/** Days in a sidereal year, used to derive heliocentric periods via Kepler III. */
export const SIDEREAL_YEAR_DAYS = 365.256363;

/** Bodies orbit the Sun unless `parent` names something else. */
export const SUN_ID = 'sun';

/**
 * @typedef {'star'|'planet'|'dwarf'|'moon'} BodyKind
 *
 * @typedef {object} OrbitElements
 * @property {number} [aAU]        Semi-major axis in AU (heliocentric orbits).
 * @property {number} [aKm]        Semi-major axis in km (satellite orbits).
 * @property {number} e            Eccentricity.
 * @property {number} inc          Inclination to the reference plane, degrees.
 * @property {number} meanLong     Mean longitude at J2000, degrees.
 * @property {number} periLong     Longitude of perihelion, degrees.
 * @property {number} nodeLong     Longitude of the ascending node, degrees.
 * @property {number} [periodDays] Orbital period; derived from `aAU` when absent.
 */

export const BODIES = [
  {
    id: 'sun',
    name: 'Sun',
    kind: 'star',
    parent: null,
    radiusKm: 696_340,
    spin: { periodHours: 609.12, tiltDeg: 7.25 },
    textures: { map: 'sun' },
    color: '#ffcc55',
    blurb:
      'A G-type main-sequence star holding 99.86% of the mass of the solar system. ' +
      'Every other object here orbits it because of that one fact.',
    facts: {
      'Mean radius': '696,340 km',
      Mass: '1.989 × 10³⁰ kg',
      'Surface temperature': '5,505 °C',
      'Core temperature': '≈ 15 million °C',
      'Rotation period': '25.4 days (equator)',
      Composition: '73% hydrogen, 25% helium',
      Age: '≈ 4.6 billion years',
    },
  },

  // ---------------------------------------------------------------- planets
  {
    id: 'mercury',
    name: 'Mercury',
    kind: 'planet',
    parent: SUN_ID,
    radiusKm: 2439.7,
    orbit: {
      aAU: 0.38709927, e: 0.20563593, inc: 7.00497902,
      meanLong: 252.25032350, periLong: 77.45779628, nodeLong: 48.33076593,
    },
    spin: { periodHours: 1407.6, tiltDeg: 0.034 },
    textures: { map: 'mercury', bumpMap: 'mercury_bump' },
    bumpScale: 0.012,
    color: '#a8a19a',
    blurb:
      'The smallest planet and the fastest, rounding the Sun every 88 days. It has almost ' +
      'no atmosphere, so its surface swings between 427 °C in daylight and −173 °C at night.',
    facts: {
      'Mean radius': '2,439.7 km',
      Mass: '3.285 × 10²³ kg (0.055 Earths)',
      'Surface gravity': '3.70 m/s²',
      'Day length': '176 Earth days (solar)',
      'Year length': '88.0 Earth days',
      'Surface temperature': '−173 to 427 °C',
      Moons: 'None',
    },
  },
  {
    id: 'venus',
    name: 'Venus',
    kind: 'planet',
    parent: SUN_ID,
    radiusKm: 6051.8,
    orbit: {
      aAU: 0.72333566, e: 0.00677672, inc: 3.39467605,
      meanLong: 181.97909950, periLong: 131.60246718, nodeLong: 76.67984255,
    },
    spin: { periodHours: -5832.5, tiltDeg: 177.36 },
    textures: { map: 'venus', bumpMap: 'venus_bump' },
    bumpScale: 0.02,
    atmosphere: { map: 'venus_atmosphere', opacity: 0.78, scale: 1.012, spinPeriodHours: -96 },
    color: '#d9b982',
    blurb:
      'Almost Earth’s twin in size, and nothing like it otherwise. A runaway greenhouse ' +
      'effect keeps the surface at 464 °C under 92 atmospheres of carbon dioxide. It also ' +
      'spins backwards, and slower than it orbits.',
    facts: {
      'Mean radius': '6,051.8 km',
      Mass: '4.867 × 10²⁴ kg (0.815 Earths)',
      'Surface gravity': '8.87 m/s²',
      'Day length': '243 Earth days (retrograde)',
      'Year length': '224.7 Earth days',
      'Surface temperature': '464 °C (mean)',
      'Surface pressure': '92 × Earth',
      Moons: 'None',
    },
  },
  {
    id: 'earth',
    name: 'Earth',
    kind: 'planet',
    parent: SUN_ID,
    radiusKm: 6371,
    orbit: {
      aAU: 1.00000261, e: 0.01671123, inc: -0.00001531,
      meanLong: 100.46457166, periLong: 102.93768193, nodeLong: 0,
    },
    spin: { periodHours: 23.9345, tiltDeg: 23.44 },
    textures: {
      map: 'earth',
      bumpMap: 'earth_bump',
      specularMap: 'earth_specular',
      emissiveMap: 'earth_night',
    },
    bumpScale: 0.02,
    nightLights: true,
    clouds: { alphaMap: 'earth_clouds', opacity: 0.85, scale: 1.006, spinPeriodHours: 190 },
    color: '#4b8fd6',
    blurb:
      'The only place in the catalogue with liquid water on its surface, plate tectonics, ' +
      'and an oxygen atmosphere. Its unusually large moon stabilises its axial tilt, which ' +
      'keeps the seasons from wandering.',
    facts: {
      'Mean radius': '6,371 km',
      Mass: '5.972 × 10²⁴ kg',
      'Surface gravity': '9.81 m/s²',
      'Day length': '23h 56m (sidereal)',
      'Year length': '365.26 days',
      'Surface temperature': '15 °C (mean)',
      'Axial tilt': '23.44°',
      Moons: '1',
    },
  },
  {
    id: 'moon',
    name: 'The Moon',
    kind: 'moon',
    parent: 'earth',
    radiusKm: 1737.4,
    orbit: {
      aKm: 384_400, e: 0.0549, inc: 5.145,
      meanLong: 218.32, periLong: 83.35, nodeLong: 125.08, periodDays: 27.321661,
    },
    spin: { periodHours: 655.72, tiltDeg: 6.68 },
    tidallyLocked: true,
    textures: { map: 'moon', bumpMap: 'moon_bump' },
    bumpScale: 0.015,
    color: '#b9b4ad',
    blurb:
      'Large enough relative to Earth that the pair is nearly a double planet. It is tidally ' +
      'locked, so the same hemisphere has faced us for billions of years, and it drifts ' +
      'about 3.8 cm further away each year.',
    facts: {
      'Mean radius': '1,737.4 km',
      Mass: '7.342 × 10²² kg',
      'Surface gravity': '1.62 m/s²',
      'Orbital period': '27.3 days',
      'Distance from Earth': '384,400 km (mean)',
      'Surface temperature': '−173 to 127 °C',
      Rotation: 'Tidally locked',
    },
  },
  {
    id: 'mars',
    name: 'Mars',
    kind: 'planet',
    parent: SUN_ID,
    radiusKm: 3389.5,
    orbit: {
      aAU: 1.52371034, e: 0.09339410, inc: 1.84969142,
      meanLong: -4.55343205, periLong: -23.94362959, nodeLong: 49.55953891,
    },
    spin: { periodHours: 24.6229, tiltDeg: 25.19 },
    textures: { map: 'mars', bumpMap: 'mars_bump' },
    bumpScale: 0.025,
    color: '#c1603f',
    blurb:
      'Half Earth’s diameter, with a day only 40 minutes longer. It carries the tallest ' +
      'volcano in the solar system, Olympus Mons, and a canyon system that would span the ' +
      'continental United States.',
    facts: {
      'Mean radius': '3,389.5 km',
      Mass: '6.417 × 10²³ kg (0.107 Earths)',
      'Surface gravity': '3.72 m/s²',
      'Day length': '24h 37m',
      'Year length': '687 Earth days',
      'Surface temperature': '−63 °C (mean)',
      Moons: '2 (Phobos, Deimos)',
    },
  },
  {
    id: 'phobos',
    name: 'Phobos',
    kind: 'moon',
    parent: 'mars',
    radiusKm: 11.267,
    orbit: { aKm: 9376, e: 0.0151, inc: 1.093, meanLong: 0, periLong: 0, nodeLong: 0, periodDays: 0.318910 },
    spin: { periodHours: 7.6538, tiltDeg: 0 },
    tidallyLocked: true,
    model: 'phobos',
    color: '#8c8177',
    blurb:
      'A 22-kilometre rubble pile orbiting closer to its planet than any other moon in the ' +
      'solar system. Tidal forces are dragging it inward; in roughly 50 million years it ' +
      'will either strike Mars or be torn into a ring.',
    facts: {
      'Mean radius': '11.3 km',
      Mass: '1.066 × 10¹⁶ kg',
      'Surface gravity': '0.0057 m/s²',
      'Orbital period': '7h 39m',
      'Distance from Mars': '9,376 km',
      Note: 'Orbits faster than Mars rotates',
    },
  },
  {
    id: 'deimos',
    name: 'Deimos',
    kind: 'moon',
    parent: 'mars',
    radiusKm: 6.2,
    orbit: { aKm: 23_463, e: 0.00033, inc: 0.93, meanLong: 90, periLong: 0, nodeLong: 0, periodDays: 1.263 },
    spin: { periodHours: 30.312, tiltDeg: 0 },
    tidallyLocked: true,
    model: 'deimos',
    color: '#9a8f83',
    blurb:
      'The smaller and more distant of Mars’s two moons, barely 12 km across. Its escape ' +
      'velocity is about 5.6 m/s - a determined person could jump off it.',
    facts: {
      'Mean radius': '6.2 km',
      Mass: '1.476 × 10¹⁵ kg',
      'Surface gravity': '0.003 m/s²',
      'Orbital period': '1.26 days',
      'Distance from Mars': '23,463 km',
      'Escape velocity': '5.6 m/s',
    },
  },

  // ------------------------------------------------------------ gas giants
  {
    id: 'jupiter',
    name: 'Jupiter',
    kind: 'planet',
    parent: SUN_ID,
    radiusKm: 69_911,
    orbit: {
      aAU: 5.20288700, e: 0.04838624, inc: 1.30439695,
      meanLong: 34.39644051, periLong: 14.72847983, nodeLong: 100.47390909,
    },
    spin: { periodHours: 9.9250, tiltDeg: 3.13 },
    textures: { map: 'jupiter' },
    color: '#c8a07a',
    blurb:
      'More massive than every other planet combined. It has no surface to land on - the ' +
      'atmosphere simply gets denser until it becomes a metallic hydrogen ocean. A day ' +
      'lasts under ten hours.',
    facts: {
      'Mean radius': '69,911 km (11.2 Earths)',
      Mass: '1.898 × 10²⁷ kg (318 Earths)',
      'Surface gravity': '24.79 m/s²',
      'Day length': '9h 56m',
      'Year length': '11.86 Earth years',
      'Cloud-top temperature': '−108 °C',
      Moons: '95 confirmed',
    },
  },
  {
    id: 'io',
    name: 'Io',
    kind: 'moon',
    parent: 'jupiter',
    radiusKm: 1821.6,
    orbit: { aKm: 421_700, e: 0.0041, inc: 0.05, meanLong: 0, periLong: 0, nodeLong: 0, periodDays: 1.769138 },
    spin: { periodHours: 42.459, tiltDeg: 0 },
    tidallyLocked: true,
    textures: { map: 'io', bumpMap: 'io_bump' },
    bumpScale: 0.015,
    color: '#d8c56a',
    blurb:
      'The most volcanically active world known. Jupiter’s tides knead its interior hard ' +
      'enough to keep hundreds of volcanoes erupting, resurfacing it faster than craters ' +
      'can accumulate.',
    facts: {
      'Mean radius': '1,821.6 km',
      Mass: '8.932 × 10²² kg',
      'Surface gravity': '1.80 m/s²',
      'Orbital period': '1.77 days',
      'Distance from Jupiter': '421,700 km',
      Volcanoes: '400+ active',
    },
  },
  {
    id: 'europa',
    name: 'Europa',
    kind: 'moon',
    parent: 'jupiter',
    radiusKm: 1560.8,
    orbit: { aKm: 671_034, e: 0.009, inc: 0.47, meanLong: 90, periLong: 0, nodeLong: 0, periodDays: 3.551181 },
    spin: { periodHours: 85.228, tiltDeg: 0.1 },
    tidallyLocked: true,
    textures: { map: 'europa', bumpMap: 'europa_bump' },
    bumpScale: 0.008,
    color: '#cbb89b',
    blurb:
      'A shell of water ice over a saltwater ocean that probably holds twice as much water ' +
      'as all of Earth’s. That ocean makes it one of the best places in the solar system ' +
      'to look for life.',
    facts: {
      'Mean radius': '1,560.8 km',
      Mass: '4.800 × 10²² kg',
      'Surface gravity': '1.31 m/s²',
      'Orbital period': '3.55 days',
      'Distance from Jupiter': '671,034 km',
      'Ice shell': '15–25 km thick',
    },
  },
  {
    id: 'ganymede',
    name: 'Ganymede',
    kind: 'moon',
    parent: 'jupiter',
    radiusKm: 2634.1,
    orbit: { aKm: 1_070_412, e: 0.0013, inc: 0.20, meanLong: 270, periLong: 0, nodeLong: 0, periodDays: 7.154553 },
    spin: { periodHours: 171.709, tiltDeg: 0.33 },
    tidallyLocked: true,
    textures: { map: 'ganymede', bumpMap: 'ganymede_bump' },
    bumpScale: 0.015,
    color: '#9c8e7d',
    blurb:
      'The largest moon in the solar system - bigger than Mercury - and the only one with ' +
      'its own magnetic field, generated by a liquid iron core.',
    facts: {
      'Mean radius': '2,634.1 km',
      Mass: '1.482 × 10²³ kg',
      'Surface gravity': '1.43 m/s²',
      'Orbital period': '7.15 days',
      'Distance from Jupiter': '1,070,412 km',
      Note: 'Larger than Mercury',
    },
  },
  {
    id: 'callisto',
    name: 'Callisto',
    kind: 'moon',
    parent: 'jupiter',
    radiusKm: 2410.3,
    orbit: { aKm: 1_882_709, e: 0.0074, inc: 0.192, meanLong: 45, periLong: 0, nodeLong: 0, periodDays: 16.689018 },
    spin: { periodHours: 400.536, tiltDeg: 0 },
    tidallyLocked: true,
    textures: { map: 'callisto', bumpMap: 'callisto_bump' },
    bumpScale: 0.018,
    color: '#7d7167',
    blurb:
      'The most heavily cratered object known - its surface has gone essentially unchanged ' +
      'for four billion years. It orbits far enough out to sit outside Jupiter’s worst ' +
      'radiation belts.',
    facts: {
      'Mean radius': '2,410.3 km',
      Mass: '1.076 × 10²³ kg',
      'Surface gravity': '1.24 m/s²',
      'Orbital period': '16.7 days',
      'Distance from Jupiter': '1,882,709 km',
      'Surface age': '≈ 4 billion years',
    },
  },
  {
    id: 'saturn',
    name: 'Saturn',
    kind: 'planet',
    parent: SUN_ID,
    radiusKm: 58_232,
    orbit: {
      aAU: 9.53667594, e: 0.05386179, inc: 2.48599187,
      meanLong: 49.95424423, periLong: 92.59887831, nodeLong: 113.66242448,
    },
    spin: { periodHours: 10.656, tiltDeg: 26.73 },
    textures: { map: 'saturn' },
    // Ring radii are expressed as multiples of the planet's own radius so the
    // scaling layer can compress them exactly like everything else.
    rings: { innerRadii: 1.18, outerRadii: 2.0, map: 'saturn_rings', opacity: 0.95 },
    color: '#e0c48c',
    blurb:
      'Less dense than water, and circled by a ring system only about ten metres thick but ' +
      '280,000 km wide. The rings are almost pure water ice, and may be younger than the ' +
      'dinosaurs.',
    facts: {
      'Mean radius': '58,232 km (9.1 Earths)',
      Mass: '5.683 × 10²⁶ kg (95 Earths)',
      'Surface gravity': '10.44 m/s²',
      'Day length': '10h 39m',
      'Year length': '29.5 Earth years',
      'Cloud-top temperature': '−138 °C',
      'Ring span': '≈ 282,000 km',
      Moons: '146 confirmed',
    },
  },
  {
    id: 'titan',
    name: 'Titan',
    kind: 'moon',
    parent: 'saturn',
    radiusKm: 2574.7,
    orbit: { aKm: 1_221_870, e: 0.0288, inc: 0.35, meanLong: 0, periLong: 0, nodeLong: 0, periodDays: 15.945 },
    spin: { periodHours: 382.68, tiltDeg: 0 },
    tidallyLocked: true,
    textures: { map: 'titan', bumpMap: 'titan_bump' },
    bumpScale: 0.01,
    color: '#d9a968',
    blurb:
      'The only moon with a substantial atmosphere - denser at the surface than Earth’s - ' +
      'and the only other body known to have standing liquid on its surface, in the form of ' +
      'methane lakes near its poles.',
    facts: {
      'Mean radius': '2,574.7 km',
      Mass: '1.345 × 10²³ kg',
      'Surface gravity': '1.35 m/s²',
      'Orbital period': '15.95 days',
      'Distance from Saturn': '1,221,870 km',
      'Surface pressure': '1.45 × Earth',
      Surface: 'Liquid methane lakes',
    },
  },
  {
    id: 'enceladus',
    name: 'Enceladus',
    kind: 'moon',
    parent: 'saturn',
    radiusKm: 252.1,
    orbit: { aKm: 237_948, e: 0.0047, inc: 0.009, meanLong: 120, periLong: 0, nodeLong: 0, periodDays: 1.370218 },
    spin: { periodHours: 32.885, tiltDeg: 0 },
    tidallyLocked: true,
    textures: { map: 'enceladus', bumpMap: 'enceladus_bump' },
    bumpScale: 0.006,
    color: '#e8eef0',
    blurb:
      'A 500-kilometre ice moon venting plumes of salty water from its south pole straight ' +
      'into space. Those plumes supply Saturn’s E ring, and they come from a global ocean ' +
      'under the ice.',
    facts: {
      'Mean radius': '252.1 km',
      Mass: '1.080 × 10²⁰ kg',
      'Surface gravity': '0.113 m/s²',
      'Orbital period': '1.37 days',
      'Distance from Saturn': '237,948 km',
      Albedo: '0.81 — brightest in the solar system',
    },
  },
  {
    id: 'iapetus',
    name: 'Iapetus',
    kind: 'moon',
    parent: 'saturn',
    radiusKm: 734.5,
    orbit: { aKm: 3_560_820, e: 0.0286, inc: 15.47, meanLong: 250, periLong: 0, nodeLong: 0, periodDays: 79.3215 },
    spin: { periodHours: 1903.72, tiltDeg: 0 },
    tidallyLocked: true,
    textures: { map: 'iapetus', bumpMap: 'iapetus_bump' },
    bumpScale: 0.02,
    color: '#8f8171',
    blurb:
      'Two-toned: one hemisphere is as bright as snow, the other as dark as coal. It also ' +
      'has a 13-kilometre-high ridge running almost exactly along its equator, and nobody ' +
      'is certain why.',
    facts: {
      'Mean radius': '734.5 km',
      Mass: '1.806 × 10²¹ kg',
      'Surface gravity': '0.223 m/s²',
      'Orbital period': '79.3 days',
      'Distance from Saturn': '3,560,820 km',
      Feature: 'Equatorial ridge, 13 km high',
    },
  },

  // ---------------------------------------------------------- ice giants
  {
    id: 'uranus',
    name: 'Uranus',
    kind: 'planet',
    parent: SUN_ID,
    radiusKm: 25_362,
    orbit: {
      aAU: 19.18916464, e: 0.04725744, inc: 0.77263783,
      meanLong: 313.23810451, periLong: 170.95427630, nodeLong: 74.01692503,
    },
    spin: { periodHours: -17.24, tiltDeg: 97.77 },
    textures: { map: 'uranus' },
    color: '#9fd8e0',
    blurb:
      'Tipped over on its side, almost certainly by an ancient collision. Each pole spends ' +
      '42 years in continuous sunlight and then 42 years in darkness. Methane in the upper ' +
      'atmosphere gives it its colour.',
    facts: {
      'Mean radius': '25,362 km (4.0 Earths)',
      Mass: '8.681 × 10²⁵ kg (14.5 Earths)',
      'Surface gravity': '8.87 m/s²',
      'Day length': '17h 14m (retrograde)',
      'Year length': '84.0 Earth years',
      'Axial tilt': '97.8°',
      'Cloud-top temperature': '−195 °C',
      Moons: '28 confirmed',
    },
  },
  {
    id: 'neptune',
    name: 'Neptune',
    kind: 'planet',
    parent: SUN_ID,
    radiusKm: 24_622,
    orbit: {
      aAU: 30.06992276, e: 0.00859048, inc: 1.77004347,
      meanLong: -55.12002969, periLong: 44.96476227, nodeLong: 131.78422574,
    },
    spin: { periodHours: 16.11, tiltDeg: 28.32 },
    textures: { map: 'neptune' },
    color: '#4a6fd4',
    blurb:
      'The windiest planet, with storms clocked above 2,000 km/h. It was the first planet ' +
      'found by mathematics rather than observation - its position was predicted from ' +
      'irregularities in Uranus’s orbit.',
    facts: {
      'Mean radius': '24,622 km (3.9 Earths)',
      Mass: '1.024 × 10²⁶ kg (17.1 Earths)',
      'Surface gravity': '11.15 m/s²',
      'Day length': '16h 07m',
      'Year length': '164.8 Earth years',
      'Wind speed': 'up to 2,100 km/h',
      Discovered: '1846, by prediction',
      Moons: '16 confirmed',
    },
  },
  {
    id: 'triton',
    name: 'Triton',
    kind: 'moon',
    parent: 'neptune',
    radiusKm: 1353.4,
    orbit: { aKm: 354_759, e: 0.000016, inc: 156.885, meanLong: 0, periLong: 0, nodeLong: 0, periodDays: -5.876854 },
    spin: { periodHours: -141.044, tiltDeg: 0 },
    tidallyLocked: true,
    textures: { map: 'triton', bumpMap: 'triton_bump' },
    bumpScale: 0.012,
    color: '#c7bdb4',
    blurb:
      'The only large moon that orbits backwards, which means Neptune captured it rather ' +
      'than forming it. That orbit is decaying, and in a few billion years Neptune will ' +
      'tear it into a ring system.',
    facts: {
      'Mean radius': '1,353.4 km',
      Mass: '2.139 × 10²² kg',
      'Surface gravity': '0.779 m/s²',
      'Orbital period': '5.88 days (retrograde)',
      'Distance from Neptune': '354,759 km',
      'Surface temperature': '−235 °C',
      Origin: 'Captured Kuiper belt object',
    },
  },

  // -------------------------------------------------------- dwarf planets
  {
    id: 'ceres',
    name: 'Ceres',
    kind: 'dwarf',
    parent: SUN_ID,
    radiusKm: 473,
    orbit: {
      aAU: 2.7658, e: 0.0785, inc: 10.593,
      meanLong: 249.98, periLong: 153.99, nodeLong: 80.393,
    },
    spin: { periodHours: 9.074, tiltDeg: 4 },
    textures: { map: 'ceres', bumpMap: 'ceres_bump' },
    bumpScale: 0.01,
    color: '#94897d',
    blurb:
      'The largest object in the asteroid belt and the only dwarf planet inside Neptune’s ' +
      'orbit. It holds about a quarter of the belt’s total mass, and bright salt deposits ' +
      'in Occator crater suggest briny water reached the surface recently.',
    facts: {
      'Mean radius': '473 km',
      Mass: '9.39 × 10²⁰ kg',
      'Surface gravity': '0.28 m/s²',
      'Day length': '9h 04m',
      'Year length': '4.60 Earth years',
      Discovered: '1801, by Giuseppe Piazzi',
      Note: 'Holds ~25% of the asteroid belt’s mass',
    },
  },
  {
    id: 'pluto',
    name: 'Pluto',
    kind: 'dwarf',
    parent: SUN_ID,
    radiusKm: 1188.3,
    orbit: {
      aAU: 39.48211675, e: 0.24882730, inc: 17.14001206,
      meanLong: 238.92903833, periLong: 224.06891629, nodeLong: 110.30393684,
    },
    spin: { periodHours: -153.2928, tiltDeg: 122.53 },
    textures: { map: 'pluto', bumpMap: 'pluto_bump', specularMap: 'pluto_specular' },
    bumpScale: 0.012,
    color: '#c9a98c',
    blurb:
      'Its orbit is eccentric and steeply inclined enough that for twenty years of each ' +
      '248-year circuit it is closer to the Sun than Neptune - as it was from 1979 to 1999. ' +
      'A 3:2 resonance with Neptune keeps the two from ever meeting.',
    facts: {
      'Mean radius': '1,188.3 km',
      Mass: '1.303 × 10²² kg',
      'Surface gravity': '0.62 m/s²',
      'Day length': '6.4 Earth days (retrograde)',
      'Year length': '248 Earth years',
      'Surface temperature': '−229 °C',
      'Orbital inclination': '17.1°',
      Moons: '5 (Charon, Nix, Hydra, Kerberos, Styx)',
    },
  },
  {
    id: 'makemake',
    name: 'Makemake',
    kind: 'dwarf',
    parent: SUN_ID,
    radiusKm: 715,
    orbit: {
      aAU: 45.43, e: 0.159, inc: 29.01,
      meanLong: 172.6, periLong: 15.62, nodeLong: 79.62,
    },
    spin: { periodHours: 22.826, tiltDeg: 0 },
    textures: { map: 'makemake' },
    color: '#b08a72',
    blurb:
      'A Kuiper belt dwarf planet named for the creator deity of Rapa Nui, discovered just ' +
      'after Easter 2005. Its surface is covered in methane and ethane ice.',
    facts: {
      'Mean radius': '715 km',
      Mass: '≈ 3.1 × 10²¹ kg',
      'Surface gravity': '≈ 0.5 m/s²',
      'Day length': '22.8 hours',
      'Year length': '306 Earth years',
      'Surface temperature': '−239 °C',
      Discovered: '2005',
      Moons: '1 (S/2015 (136472) 1)',
    },
  },
  {
    id: 'eris',
    name: 'Eris',
    kind: 'dwarf',
    parent: SUN_ID,
    radiusKm: 1163,
    orbit: {
      aAU: 67.78, e: 0.4407, inc: 44.04,
      meanLong: 31.75, periLong: 187.59, nodeLong: 35.95,
    },
    spin: { periodHours: 378.0, tiltDeg: 0 },
    textures: { map: 'eris', bumpMap: 'eris_bump' },
    bumpScale: 0.01,
    color: '#cfc9c0',
    blurb:
      'Slightly smaller than Pluto but about 27% more massive. Its discovery in 2005 is ' +
      'what forced astronomers to define "planet" precisely - and what reclassified Pluto ' +
      'in the process.',
    facts: {
      'Mean radius': '1,163 km',
      Mass: '1.64 × 10²² kg',
      'Surface gravity': '0.82 m/s²',
      'Day length': '15.8 Earth days',
      'Year length': '558 Earth years',
      'Surface temperature': '−243 °C',
      'Orbital inclination': '44.0°',
      Moons: '1 (Dysnomia)',
    },
  },
];

/** Fast lookup by id. */
export const BODY_BY_ID = new Map(BODIES.map((b) => [b.id, b]));

/** Children of a given body, in catalogue order. */
export function childrenOf(id) {
  return BODIES.filter((b) => b.parent === id);
}

/**
 * Orbital period in days. Heliocentric orbits get it from Kepler's third law
 * rather than a hardcoded number, so `aAU` stays the only source of truth.
 */
export function periodDays(body) {
  if (body.orbit?.periodDays !== undefined) return body.orbit.periodDays;
  if (body.orbit?.aAU !== undefined) return SIDEREAL_YEAR_DAYS * body.orbit.aAU ** 1.5;
  return Infinity;
}

/**
 * The two debris fields, in AU. Rendered as point clouds rather than catalogued
 * bodies because there are a few hundred thousand of them and none is worth
 * clicking on.
 */
export const BELTS = [
  {
    id: 'asteroid-belt',
    name: 'Asteroid Belt',
    innerAU: 2.06,
    outerAU: 3.27,
    count: 5200,
    thicknessAU: 0.28,
    color: 0xb9ac97,
    size: 1.4,
  },
  {
    id: 'kuiper-belt',
    name: 'Kuiper Belt',
    innerAU: 30,
    outerAU: 50,
    count: 7000,
    thicknessAU: 6,
    color: 0x9aa8c4,
    size: 1.2,
  },
];
