#!/usr/bin/env node
/**
 * Refreshes public/data/stellar-systems.json: the stellar hierarchies (which
 * star orbits which, and how) from the Open Exoplanet Catalogue. Only systems
 * with a <binary> are kept; NASA remains the authority on which planets exist.
 *
 * Atomic, like the NASA importer: the new copy replaces the old only once it
 * validates, is no more than 5% smaller, and every system still builds a finite
 * model with the current NASA catalogue.
 *
 *   npm run stars:update
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { validateCatalogue } from '../src/data/exoplanets.js';
import { validateStellarCatalogue } from '../src/data/stellarSystems.js';
import { verifyModels } from './lib/exoplanet-checks.js';

const URL_GZ = 'https://raw.githubusercontent.com/OpenExoplanetCatalogue/oec_gzip/master/systems.xml.gz';
/** OEC element to the archive's column name; units already agree (M☉, R☉, K, AU, days). */
const FIELDS = {
  mass: 'st_mass', radius: 'st_rad', temperature: 'st_teff',
  semimajoraxis: 'pl_orbsmax', period: 'pl_orbper', eccentricity: 'pl_orbeccen',
};

/**
 * Known slips in the catalogue, each applied only while the published value is
 * still the wrong one, so a fix upstream retires it. `components` names the
 * pair by its two members.
 */
const CORRECTIONS = [
  // A 42.15-year visual orbit (e = 0.58, i = 128°; Söderhjelm 1999) entered in days.
  { components: ['Gliese 667 A', 'Gliese 667 B'], key: 'pl_orbper', was: 42.15, now: 42.15 * 365.25 },
];

/**
 * Just enough XML for the catalogue's machine-written files: elements,
 * attributes, text and the five predefined entities plus character references.
 * Anything else (a DTD, a stray '<') is an error rather than a guess.
 */
export function parseXml(text) {
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
  const root = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  while (token.lastIndex < text.length) {
    const at = token.lastIndex;
    const match = token.exec(text);
    if (!match) throw new Error(`Unreadable XML at character ${at}`);
    const [, cdata, close, open, attributes, selfClosing, chars] = match;
    const parent = stack.at(-1);
    if (chars !== undefined || cdata !== undefined) {
      parent.text += cdata ?? decode(chars);
    } else if (close) {
      if (parent.tag !== close) throw new Error(`Mismatched </${close}> at character ${at}`);
      stack.pop();
    } else if (open) {
      const node = { tag: open, attrs: {}, children: [], text: '' };
      for (const [, name, double, single] of attributes.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        node.attrs[name] = decode(double ?? single);
      }
      parent.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${stack.at(-1).tag}>`);
  return root;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name) => {
    if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    if (!(name in ENTITIES)) throw new Error(`Unknown XML entity ${whole}`);
    return ENTITIES[name];
  });
}

const child = (node, tag) => node.children.find((c) => c.tag === tag);
const texts = (node, tag) => node.children.filter((c) => c.tag === tag).map((c) => c.text.trim()).filter(Boolean);
/** A plain decimal number, as the catalogue writes them; anything else is unusable. */
function decimal(text) {
  const trimmed = text?.trim() ?? '';
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed) ? Number(trimmed) : null;
}

/** One <star> or <binary>, with the measurements the hierarchy needs. */
function convert(element) {
  const node = {
    kind: element.tag, names: texts(element, 'name'), values: {},
    planets: element.children.filter((c) => c.tag === 'planet').map((p) => texts(p, 'name')),
  };
  // A pair's separation on the sky, often all that is known of a wide one.
  const separations = element.children.filter((c) => c.tag === 'separation');
  const fields = [
    ...Object.entries(FIELDS).map(([tag, key]) => [child(element, tag), key]),
    [separations.find((c) => c.attrs.unit === 'AU'), 'sep_au'],
    [separations.find((c) => c.attrs.unit === 'arcsec'), 'sep_arcsec'],
  ];
  for (const [field, key] of fields) {
    if (!field) continue;
    let value = decimal(field.text), limit = 0;
    // A bound in place of a value: kept, flagged, and never used as a measurement.
    if (value === null && !field.text.trim()) {
      for (const [attribute, sign] of [['upperlimit', 1], ['lowerlimit', -1]]) {
        if (attribute in field.attrs) { value = decimal(field.attrs[attribute]); limit = sign; break; }
      }
    }
    if (value === null || !Number.isFinite(value)) continue;
    node.values[key] = value;
    node.values[`${key}lim`] = limit;
    for (const [attribute, suffix, sign] of [['errorplus', 'err1', 1], ['errorminus', 'err2', -1]]) {
      const error = decimal(field.attrs[attribute]);
      if (error !== null && Number.isFinite(error)) node.values[key + suffix] = sign * Math.abs(error);
    }
  }
  const spectralType = child(element, 'spectraltype')?.text.trim();
  if (spectralType) node.values.st_spectype = spectralType;
  node.children = element.children.filter((c) => c.tag === 'star' || c.tag === 'binary').map(convert);
  if (node.kind === 'binary' && node.children.length !== 2) throw new Error('A binary must have two components');
  for (const fix of CORRECTIONS) {
    const members = node.children.map((c) => c.names[0]);
    if (fix.components.every((name) => members.includes(name)) && node.values[fix.key] === fix.was) node.values[fix.key] = fix.now;
  }
  return node;
}

/** Every system with a stellar hierarchy. A malformed one is skipped, not fatal. */
export function convertSystems(xml) {
  const catalogue = child(parseXml(xml), 'systems');
  if (!catalogue) throw new Error('No <systems> in the catalogue');
  const systems = [], skipped = [];
  for (const system of catalogue.children.filter((c) => c.tag === 'system')) {
    const binary = child(system, 'binary');
    if (!binary) continue;
    const name = texts(system, 'name')[0];
    try {
      if (!name) throw new Error('unnamed');
      const entry = { name, tree: convert(binary) };
      validateStellarCatalogue({ schemaVersion: 1, fetchedAt: new Date().toISOString(), systems: [entry] });
      systems.push(entry);
    } catch (error) {
      skipped.push(`${name ?? 'unnamed system'} (${error.message})`);
    }
  }
  return { systems, skipped };
}

async function main() {
  const dest = new URL('../public/data/stellar-systems.json', import.meta.url);
  const response = await fetch(URL_GZ, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Open Exoplanet Catalogue returned HTTP ${response.status}`);
  const { systems, skipped } = convertSystems(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8'));
  if (skipped.length) console.warn(`Skipped ${skipped.length} malformed: ${skipped.join('; ')}`);

  let previous = null;
  try { previous = JSON.parse(await readFile(dest, 'utf8')); } catch { /* first import */ }
  if (systems.length < 100 || (previous && systems.length < previous.systems.length * 0.95)) {
    throw new Error(`Incomplete companion catalogue (${systems.length} systems); keeping the previous copy.`);
  }
  const data = validateStellarCatalogue({
    schemaVersion: 1, fetchedAt: new Date().toISOString(),
    source: { name: 'Open Exoplanet Catalogue', url: URL_GZ, license: 'MIT; see open-exoplanet-catalogue-license.txt' },
    systems,
  });
  const exoplanets = validateCatalogue(JSON.parse(await readFile(new URL('../public/data/exoplanets.json', import.meta.url), 'utf8')));
  verifyModels(exoplanets, data);

  const temporary = new URL('../public/data/stellar-systems.json.tmp', import.meta.url);
  await writeFile(temporary, JSON.stringify(data) + '\n');
  await rename(temporary, dest);
  console.log(`Imported ${systems.length} stellar hierarchies, ${data.fetchedAt}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
