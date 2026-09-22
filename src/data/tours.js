/**
 * Guided tours: a sequence of stops, each a body and a caption.
 *
 * The captions are deliberately not the catalogue blurbs. A tour is a walk
 * through the system with an argument to it, so each stop says one thing and
 * leads to the next. Everything stated here is checkable; where a number is
 * rounded, it is rounded down.
 */

/**
 * @typedef {object} TourStop
 * @property {string} body     Catalogue id to fly to.
 * @property {string} text     One to three sentences.
 * @property {number} [hold]   Seconds to stay after arriving. Defaults to reading time.
 *
 * @typedef {object} Tour
 * @property {string} id
 * @property {string} title
 * @property {string} summary  One line, shown in the tour menu.
 * @property {TourStop[]} stops
 */

/** @type {Tour[]} */
export const TOURS = [
  {
    id: 'grand-tour',
    title: 'The Grand Tour',
    summary: 'Sun to Pluto, one stop per world.',
    stops: [
      {
        body: 'sun',
        text:
          'Start at the centre. The Sun is 99.86% of everything in this model by mass. ' +
          'The planets, their moons and both belts are what was left over.',
      },
      {
        body: 'mercury',
        text:
          'With almost no air to hold heat, the same ground on Mercury swings from 427 °C at ' +
          'noon to −173 °C at night. One day there, sunrise to sunrise, lasts two of its years.',
      },
      {
        body: 'venus',
        text:
          'Nearly Earth’s size, and a warning about what an atmosphere can do: Venus is hotter ' +
          'than Mercury at almost twice the distance from the Sun. It also turns backwards.',
      },
      {
        body: 'earth',
        text:
          'Home. The lit half is the real one for the date and time below - watch the city ' +
          'lights come on as the night side turns into view.',
      },
      {
        body: 'mars',
        text:
          'Mars had rivers once. Its air is now under 1% as thick as Earth’s, and the water ' +
          'that is left is frozen into the polar caps and the ground.',
      },
      {
        body: 'jupiter',
        text:
          'Jupiter is more than twice as massive as all the other planets put together. Its four ' +
          'large moons were the first things anyone saw orbiting another world: Galileo, 1610.',
      },
      {
        body: 'saturn',
        text:
          'The rings are 280,000 km across and in most places about ten metres thick. Made as ' +
          'thin as a sheet of paper, they would be nearly three kilometres wide.',
      },
      {
        body: 'uranus',
        text:
          'Knocked onto its side, probably by a collision early on, Uranus rolls around the Sun ' +
          'rather than spinning like a top. Each pole gets 42 years of daylight, then 42 of night.',
      },
      {
        body: 'neptune',
        text:
          'Found with a pencil before a telescope. In 1846 Urbain Le Verrier worked out where an ' +
          'unseen planet had to be to tug Uranus off course, and it was there, within a degree.',
      },
      {
        body: 'pluto',
        text:
          'Pluto spent 1979 to 1999 closer to the Sun than Neptune. They can never collide: ' +
          'Pluto goes round twice for every three Neptune orbits, and is always far away when it crosses.',
      },
    ],
  },
  {
    id: 'ocean-worlds',
    title: 'Ocean Worlds',
    summary: 'Where the water is. Most of it is under ice.',
    stops: [
      {
        body: 'earth',
        text:
          'The one ocean you can see from space. It holds about 1.3 billion cubic kilometres of ' +
          'water - and it may not be the largest ocean in the solar system.',
      },
      {
        body: 'europa',
        text:
          'Under 15 to 25 km of ice, Europa probably has a salty ocean around 100 km deep: about ' +
          'twice the water in all of Earth’s. Jupiter’s tides flex the moon and keep it liquid.',
      },
      {
        body: 'ganymede',
        text:
          'The largest moon of all likely hides an ocean between layers of ice. Hubble found it ' +
          'indirectly, from the way the ocean damps the rocking of Ganymede’s aurorae.',
      },
      {
        body: 'enceladus',
        text:
          'Only 500 km across, and it sprays its ocean into space from cracks at its south pole. ' +
          'Cassini flew through the plumes and tasted salt, silica and organic molecules.',
      },
      {
        body: 'titan',
        text:
          'Titan has seas on its surface - of liquid methane and ethane - and very likely water ' +
          'far below. NASA’s Dragonfly rotorcraft is due to arrive in 2034 to fly over the dunes.',
      },
      {
        body: 'triton',
        text:
          'Voyager 2 saw plumes erupting from Triton in 1989, on a surface at −235 °C. It may hold ' +
          'an ocean of its own, kept liquid by the heat of its capture by Neptune.',
      },
    ],
  },
  {
    id: 'odd-ones-out',
    title: 'Odd Ones Out',
    summary: 'Backwards spins, sideways planets and doomed moons.',
    stops: [
      {
        body: 'venus',
        text:
          'Venus takes 243 days to turn once and 225 to go round the Sun, so its day is longer ' +
          'than its year. It turns the opposite way to almost everything else, too.',
      },
      {
        body: 'uranus',
        text:
          'Tipped 98°, Uranus has its poles where other planets have their equators. Its moons ' +
          'and rings are tipped with it, which suggests whatever did it happened very early.',
      },
      {
        body: 'triton',
        text:
          'The only large moon that orbits backwards, against its planet’s spin. That means ' +
          'Neptune caught it rather than made it - and the same tides are slowly dragging it down.',
      },
      {
        body: 'phobos',
        text:
          'Phobos goes round Mars three times a day, so from the ground it rises in the west. It ' +
          'is spiralling inward by about two metres a century and will not survive the trip.',
      },
      {
        body: 'iapetus',
        text:
          'One side as dark as coal, the other as bright as snow, with a ridge 13 km high running ' +
          'almost exactly round its equator. The ridge is still not fully explained.',
      },
      {
        body: 'eris',
        text:
          'Eris is 27% more massive than Pluto. Finding it in 2005 forced astronomers to decide what ' +
          'a planet is, and Pluto did not make the cut.',
      },
    ],
  },
];

export const TOUR_BY_ID = new Map(TOURS.map((tour) => [tour.id, tour]));
