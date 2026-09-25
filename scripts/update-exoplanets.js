#!/usr/bin/env node
/**
 * Refreshes public/data/exoplanets.json from the NASA Exoplanet Archive.
 *
 * Atomic: the new copy replaces the old only once it has been normalized,
 * validated, found no more than 5% smaller, and built into a finite model for
 * every system (with the current companion supplement). Any failure exits
 * non-zero and leaves the committed copy exactly as it was.
 *
 *   npm run exoplanets:update
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { QUERY_URL, catalogueFromArchive, validateCatalogue } from '../src/data/exoplanets.js';
import { validateStellarCatalogue } from '../src/data/stellarSystems.js';
import { verifyModels } from './lib/exoplanet-checks.js';

const path = new URL('../public/data/exoplanets.json', import.meta.url);
const supplementPath = new URL('../public/data/stellar-systems.json', import.meta.url);

let previous;
try { previous = validateCatalogue(JSON.parse(await readFile(path, 'utf8'))); } catch { /* first import, or an older format */ }
const supplement = validateStellarCatalogue(JSON.parse(await readFile(supplementPath, 'utf8')));

const raw = await fetchArchive();
if (raw.length < 1000 || (previous && raw.length < previous.rows.length * 0.95)) {
  throw new Error(`Catalogue unexpectedly small (${raw.length} rows); keeping the last successful import. Inspect the archive before replacing it.`);
}
const data = catalogueFromArchive(raw);
const systems = verifyModels(data, supplement);

const temporary = new URL('../public/data/exoplanets.json.tmp', import.meta.url);
await writeFile(temporary, JSON.stringify(data) + '\n');
await rename(temporary, path);
const change = previous ? ` (${data.rows.length - previous.rows.length >= 0 ? '+' : ''}${data.rows.length - previous.rows.length})` : '';
console.log(`Imported ${data.rows.length} confirmed planets${change} around ${systems} hosts, ${data.fetchedAt}.`);

/** The whole table in one query, retried through brief archive outages. */
async function fetchArchive(attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(QUERY_URL, { signal: AbortSignal.timeout(180_000) });
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
