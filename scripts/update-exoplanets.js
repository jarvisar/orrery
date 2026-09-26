#!/usr/bin/env node
/**
 * Refreshes public/data/exoplanets.json from the NASA Exoplanet Archive, and
 * public/data/sky-hosts.json, the hosts bright enough to click in the sky.
 *
 * Atomic: the new copies replace the old only once the catalogue has been
 * normalized, validated, found no more than 5% smaller, and built into a finite
 * model for every system (with the current companion supplement), and the sky
 * list has been validated and found no more than 5% shorter. Any failure exits
 * non-zero and leaves both committed copies exactly as they were.
 *
 *   npm run exoplanets:update
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { QUERY_URL, SKY_QUERY_URL, catalogueFromArchive, validateCatalogue, skyHosts, validateSkyHosts } from '../src/data/exoplanets.js';
import { validateStellarCatalogue } from '../src/data/stellarSystems.js';
import { verifyModels } from './lib/exoplanet-checks.js';

const path = new URL('../public/data/exoplanets.json', import.meta.url);
const skyPath = new URL('../public/data/sky-hosts.json', import.meta.url);
const supplementPath = new URL('../public/data/stellar-systems.json', import.meta.url);

let previous, previousSky;
try { previous = validateCatalogue(JSON.parse(await readFile(path, 'utf8'))); } catch { /* first import, or an older format */ }
try { previousSky = validateSkyHosts(JSON.parse(await readFile(skyPath, 'utf8'))); } catch { /* likewise */ }
const supplement = validateStellarCatalogue(JSON.parse(await readFile(supplementPath, 'utf8')));

const raw = await fetchArchive(QUERY_URL);
if (raw.length < 1000 || (previous && raw.length < previous.rows.length * 0.95)) {
  throw new Error(`Catalogue unexpectedly small (${raw.length} rows); keeping the last successful import. Inspect the archive before replacing it.`);
}
const data = catalogueFromArchive(raw);
const systems = verifyModels(data, supplement);

const sky = skyHosts(await fetchArchive(SKY_QUERY_URL), data);
if (sky.hosts.length < 100 || (previousSky && sky.hosts.length < previousSky.hosts.length * 0.95)) {
  throw new Error(`Only ${sky.hosts.length} hosts in the sky; keeping the last successful import. Inspect the archive before replacing it.`);
}

const write = async (url, value) => {
  const temporary = new URL(`${url.href}.tmp`);
  await writeFile(temporary, JSON.stringify(value) + '\n');
  return temporary;
};
const staged = [[await write(path, data), path], [await write(skyPath, sky), skyPath]];
for (const [temporary, final] of staged) await rename(temporary, final);
const change = previous ? ` (${data.rows.length - previous.rows.length >= 0 ? '+' : ''}${data.rows.length - previous.rows.length})` : '';
console.log(`Imported ${data.rows.length} confirmed planets${change} around ${systems} hosts, ${sky.hosts.length} of them bright enough to see, ${data.fetchedAt}.`);

/** A whole table in one query, retried through brief archive outages. */
async function fetchArchive(url, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`NASA Archive returned HTTP ${response.status}`);
      const raw = await response.json();
      if (!Array.isArray(raw)) throw new Error('NASA Archive returned something other than a table');
      return raw;
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.warn(`Attempt ${attempt} failed (${error.message}); retrying.`);
      await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
    }
  }
}
