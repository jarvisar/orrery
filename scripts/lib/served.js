/**
 * The files that are actually served. The Pages deploy and the desktop app
 * both stage exactly these (scripts/stage.js), and the desktop app in
 * development refuses to serve anything else, so a file that was never shipped
 * 404s locally rather than after a release.
 *
 * Every tracked top-level entry must be in one list or the other;
 * `npm run check` fails on one that is in neither.
 */

/** Served to visitors, and packaged into the desktop app. */
export const SERVED = [
  'index.html',
  'style.css',
  'site.webmanifest',
  'favicon.ico',
  'tetris.html',
  'sw.js',
  'src',
  'vendor',
  'public',
];

/** Tracked, but only for developing the site: never served. */
export const NOT_SERVED = [
  '.claude',
  '.github',
  '.gitignore',
  'CLAUDE.md',
  'README.md',
  'desktop',
  'docs',
  'package-lock.json',
  'package.json',
  'scripts',
];
