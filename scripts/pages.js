#!/usr/bin/env node
/**
 * Writes a plain HTML page for each exoplanet system into a staged copy of the
 * site, plus an index at systems/, and adds them to its sitemap.xml. The app
 * itself is one WebGL canvas, so these are what search engines can actually
 * read. Each one links into the 3D view with ?system=.
 *
 * Runs in the deploy after the catalogue refresh, so the pages always match the
 * data that ships. Nothing is committed and the desktop app doesn't get them.
 *
 *   node scripts/stage.js _site && node scripts/pages.js _site
 *   node scripts/serve.js _site      # to preview
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PARSEC_LY, archiveLink, groupSystems, measurement, number } from '../src/data/exoplanets.js';
import { fullStarName } from '../src/data/starNames.js';

const SITE = 'https://orrery.jarvisar.com/';
const NEAR_LY = 50;

const out = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: node scripts/pages.js <staged site directory>');
  process.exit(1);
}

const readJson = async (path) => JSON.parse(await readFile(join(out, path), 'utf8'));
const data = await readJson('public/data/exoplanets.json');
const naked = new Set((await readJson('public/data/sky-hosts.json')).hosts.map(([name]) => name));

// Single-planet systems are mostly a name and a period, so only the ones people
// might actually look up get a page: nearby, or visible without a telescope.
// The rest are still in the app's search.
const systems = groupSystems(data)
  .map((system) => ({ ...system, ly: system.distance ? system.distance * PARSEC_LY : null }))
  .filter((s) => s.planets.length > 1 || (s.ly && s.ly < NEAR_LY) || naked.has(s.name))
  .map((s) => ({ ...s, slug: slug(s.name), spoken: fullStarName(s.name) }));

const seen = new Map();
for (const s of systems) {
  if (seen.has(s.slug)) throw new Error(`pages: ${s.name} and ${seen.get(s.slug)} both make systems/${s.slug}/`);
  seen.set(s.slug, s.name);
}

const asOf = new Date(data.fetchedAt).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });

for (const system of systems) {
  await mkdir(join(out, 'systems', system.slug), { recursive: true });
  await writeFile(join(out, 'systems', system.slug, 'index.html'), systemPage(system));
}
await writeFile(join(out, 'systems', 'index.html'), indexPage());

const sitemapPath = join(out, 'sitemap.xml');
const sitemap = await readFile(sitemapPath, 'utf8');
const urls = [
  `  <url>\n    <loc>${SITE}systems/</loc>\n    <lastmod>${data.fetchedAt.slice(0, 10)}</lastmod>\n  </url>`,
  ...systems.map((s) => `  <url>\n    <loc>${SITE}systems/${s.slug}/</loc>\n    <lastmod>${updated(s)}</lastmod>\n  </url>`),
];
await writeFile(sitemapPath, sitemap.replace('</urlset>', `${urls.join('\n')}\n</urlset>`));

console.log(`pages: ${systems.length} systems written to ${join(out, 'systems')}`);

/* --- pages ------------------------------------------------------------------- */

function systemPage(system) {
  const name = system.spoken ?? system.name;
  const rows = [...system.planets].sort((a, b) => (value(a, 'pl_orbper') ?? Infinity) - (value(b, 'pl_orbper') ?? Infinity));
  const intro = describe(system);
  const star = starFacts(system.planets[0]);
  const anyMinimum = rows.some((r) => measurement(r, 'pl_masse') === null && measurement(r, 'pl_msinie') !== null);

  return page({
    title: `${name} System in 3D | Orrery`,
    description: `${intro} See its planets and orbits in 3D in your browser.`,
    path: `systems/${system.slug}/`,
    root: '../../',
    body: `
<h1>${esc(name)}</h1>
${system.spoken ? `<p class="aka">Listed as ${esc(system.name)} in the NASA Exoplanet Archive.</p>` : ''}
<p>${esc(intro)}</p>
<a class="open" href="../../?system=${encodeURIComponent(system.name)}">Open in 3D</a>

<h2>Planets</h2>
<div class="table"><table>
<thead><tr><th>Planet</th><th>Orbital period</th><th>Distance from star</th><th>Radius (Earths)</th><th>Mass (Earths)</th><th>Found</th><th>Method</th></tr></thead>
<tbody>
${rows.map(planetRow).join('\n')}
</tbody>
</table></div>
${anyMinimum ? '<p class="note">"At least" is a minimum mass. Radial velocity can only measure mass times the sine of the orbit\'s tilt.</p>' : ''}

${star.length ? `<h2>Star</h2>\n<ul>\n${star.map((fact) => `<li>${fact}</li>`).join('\n')}\n</ul>` : ''}

<p class="note">Data from the <a href="${archiveLink(system.name)}">NASA Exoplanet Archive</a>, as of ${asOf}. In the 3D view sizes and distances are compressed and every orbit is drawn in the same plane. Where each planet sits along its orbit is made up.</p>`,
  });
}

function indexPage() {
  const sorted = [...systems].sort((a, b) => b.planets.length - a.planets.length || (a.ly ?? Infinity) - (b.ly ?? Infinity));
  return page({
    title: 'Exoplanet Systems in 3D | Orrery',
    description: `${systems.length.toLocaleString('en-US')} planetary systems around other stars, from the NASA Exoplanet Archive. Open any of them in 3D in your browser.`,
    path: 'systems/',
    root: '../',
    body: `
<h1>Exoplanet Systems</h1>
<p>Every known system with more than one planet, plus the single-planet ones within ${NEAR_LY} light years or bright enough to see without a telescope. That's ${systems.length.toLocaleString('en-US')} of the ${groupSystems(data).length.toLocaleString('en-US')} systems in the <a href="https://exoplanetarchive.ipac.caltech.edu/">NASA Exoplanet Archive</a>. All of them can be found under <code>Star systems</code> in the <a href="../">3D view</a>.</p>
<div class="table"><table>
<thead><tr><th>System</th><th>Planets</th><th>Distance (light years)</th><th>Star</th></tr></thead>
<tbody>
${sorted.map((s) => `<tr><td><a href="${s.slug}/">${esc(s.spoken ?? s.name)}</a></td><td>${s.planets.length}</td><td>${s.ly ? lightYears(s.ly) : ''}</td><td>${esc(spectralType(s.planets[0]) ?? '')}</td></tr>`).join('\n')}
</tbody>
</table></div>`,
  });
}

function page({ title, description, path, root, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
<meta name="theme-color" content="#05070f">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Orrery">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}public/screenshots/trappist-1.webp">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="${root}public/icon/orrery.svg">
<link rel="stylesheet" href="${root}public/pages.css">
</head>
<body>
<nav class="nav"><a class="brand" href="${root}">Orrery</a><a href="${root}systems/">Exoplanet systems</a><a href="${root}about/">About</a></nav>
<main>${body}
</main>
</body>
</html>
`;
}

/* --- text -------------------------------------------------------------------- */

function describe(system) {
  const name = system.spoken ?? system.name;
  const type = spectralType(system.planets[0]);
  const count = system.planets.length;
  const what = type ? `${/^[AEFHILMNORSX]/.test(type) ? 'an' : 'a'} ${type} star` : 'a star';
  const where = system.ly ? ` ${lightYears(system.ly)} light years away` : '';
  let text = `${name} is ${what}${where} with ${count} known planet${count === 1 ? '' : 's'}.`;

  const years = system.planets.map((r) => r.disc_year).filter(Boolean);
  const first = Math.min(...years), last = Math.max(...years);
  if (count === 1 && years.length) text += ` It was found in ${first}.`;
  else if (years.length && first === last) text += ` They were all found in ${first}.`;
  else if (years.length) text += ` The first was found in ${first} and the latest in ${last}.`;

  if (system.stars === 2) text += ' It has a companion star.';
  else if (system.stars > 2) text += ` It has ${system.stars - 1} companion stars.`;
  return text;
}

function planetRow(row) {
  const period = value(row, 'pl_orbper');
  const axis = value(row, 'pl_orbsmax');
  const radius = measurement(row, 'pl_rade');
  const mass = measurement(row, 'pl_masse');
  const minimum = measurement(row, 'pl_msinie');
  const cells = [
    esc(row.pl_name) + (row.pl_controv_flag ? ' (disputed)' : ''),
    period ? (period < 730 ? `${number(period)} days` : `${number(period / 365.25)} years`) : '',
    axis ? `${number(axis)} AU` : '',
    radius ? number(radius) : '',
    mass ? number(mass) : minimum ? `at least ${number(minimum)}` : '',
    row.disc_year ?? '',
    esc(row.discoverymethod ?? ''),
  ];
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

function starFacts(row) {
  const facts = [];
  const type = spectralType(row);
  const temperature = value(row, 'st_teff');
  const mass = value(row, 'st_mass');
  const radius = value(row, 'st_rad');
  if (type) facts.push(`Spectral type ${esc(type)}`);
  if (temperature) facts.push(`${Math.round(temperature).toLocaleString('en-US')} K surface temperature`);
  if (mass) facts.push(`${number(mass)} times the mass of the Sun`);
  if (radius) facts.push(`${number(radius)} times the radius of the Sun`);
  return facts;
}

/* --- helpers ----------------------------------------------------------------- */

/** The default solution's value, else the composite table's (same as the info panel). */
function value(row, key) {
  const own = measurement(row, key);
  if (own > 0) return own;
  return row[`c_${key}`] > 0 ? row[`c_${key}`] : null;
}

function spectralType(row) {
  return (row.st_spectype ?? row.c_st_spectype ?? '').trim() || null;
}

function lightYears(ly) {
  return ly < 100 ? ly.toFixed(1) : Math.round(ly).toLocaleString('en-US');
}

/** Latest change to any of the system's planets, for the sitemap. */
function updated(system) {
  const dates = system.planets.map((r) => r.rowupdate).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return dates.at(-1) ?? data.fetchedAt.slice(0, 10);
}

function slug(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
