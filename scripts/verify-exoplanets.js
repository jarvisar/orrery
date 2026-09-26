#!/usr/bin/env node
/**
 * Checks the shipped exoplanet and companion catalogues, whatever systems they
 * hold: both validate, and every system builds a finite model that keeps all
 * of its planets. The sky's list of hosts validates too, and names only
 * systems the catalogue has, so every star offered in the sky can be visited.
 * The deploy runs this after the weekly refresh.
 *
 *   npm run exoplanets:verify
 */
import { readFile } from 'node:fs/promises';
import { validateCatalogue, validateSkyHosts, groupSystems } from '../src/data/exoplanets.js';
import { validateStellarCatalogue } from '../src/data/stellarSystems.js';
import { verifyModels } from './lib/exoplanet-checks.js';

const read = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
const data = validateCatalogue(await read('exoplanets.json'));
const supplement = validateStellarCatalogue(await read('stellar-systems.json'));
const systems = verifyModels(data, supplement);
const sky = validateSkyHosts(await read('sky-hosts.json'));
const hosts = new Set(groupSystems(data).map((system) => system.name));
const stray = sky.hosts.filter(([name]) => !hosts.has(name)).map(([name]) => name);
if (stray.length) throw new Error(`sky-hosts.json names systems the catalogue does not have: ${stray.join(', ')}`);
console.log(`exoplanets ${data.rows.length} planets, ${systems} systems, ${sky.hosts.length} in the sky, ${supplement.systems.length} stellar hierarchies; ` +
  `NASA ${data.fetchedAt.slice(0, 10)}, OEC ${supplement.fetchedAt.slice(0, 10)}`);
