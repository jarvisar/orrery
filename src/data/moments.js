/**
 * Dates worth jumping to.
 *
 * Each is defined by where the planets are, not by a spacecraft or an eclipse,
 * which the Keplerian elements here are not precise enough to reproduce. `view`
 * is a body to focus, or an overview framed to a radius in AU.
 */

/**
 * @typedef {object} Moment
 * @property {string} date   ISO 8601, UTC.
 * @property {string} title
 * @property {string} note   One sentence.
 * @property {{body?: string, overview?: number}} view
 */

/** @type {Moment[]} */
export const MOMENTS = [
  {
    date: '1846-09-23T22:00:00Z',
    title: 'Neptune found',
    note: 'Seen in Berlin within a degree of where Le Verrier’s arithmetic said it would be.',
    view: { body: 'neptune' },
  },
  {
    date: '1930-02-18T12:00:00Z',
    title: 'Pluto discovered',
    note: 'Clyde Tombaugh spots it by blinking between two photographic plates.',
    view: { body: 'pluto' },
  },
  {
    date: '1989-09-05T12:00:00Z',
    title: 'Pluto at perihelion',
    note: 'Closer to the Sun than Neptune, as it was from 1979 to 1999.',
    view: { overview: 42 },
  },
  {
    date: '2000-01-01T12:00:00Z',
    title: 'J2000',
    note: 'The instant every orbit in this model is measured from.',
    view: { overview: 33 },
  },
  {
    date: '2003-08-27T09:51:00Z',
    title: 'Mars at its closest',
    note: '55.76 million km from Earth, nearer than at any time in almost 60,000 years.',
    view: { overview: 1.9 },
  },
  {
    date: '2011-07-12T12:00:00Z',
    title: 'Neptune’s first lap',
    note: 'One full orbit since it was discovered.',
    view: { body: 'neptune' },
  },
  {
    date: '2012-06-06T01:29:00Z',
    title: 'Transit of Venus',
    note: 'Venus crosses the face of the Sun. The next is in 2117.',
    view: { overview: 1.4 },
  },
  {
    date: '2020-12-21T18:00:00Z',
    title: 'Great conjunction',
    note: 'Jupiter and Saturn line up with Earth, closer in the sky than since 1623.',
    view: { overview: 10.5 },
  },
  {
    date: '2025-05-06T12:00:00Z',
    title: 'Equinox on Saturn',
    note: 'Sunlight skims the rings edge-on, and they all but go dark.',
    view: { body: 'saturn' },
  },
  {
    date: '2027-02-19T12:00:00Z',
    title: 'Mars opposition',
    note: 'Earth passes between Mars and the Sun.',
    view: { overview: 1.9 },
  },
];
