#!/usr/bin/env node
/**
 * Checks the shipped exoplanet and companion catalogues, whatever systems they
 * hold: both validate, and every system builds a finite model that keeps all
 * of its planets. The deploy runs this after the weekly refresh.
 *
 *   npm run exoplanets:verify
 */
import { readFile } from 'node:fs/promises';
import { validateCatalogue } from '../src/data/exoplanets.js';
import { validateStellarCatalogue } from '../src/data/stellarSystems.js';
import { verifyModels } from './lib/exoplanet-checks.js';

const read = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
const data = validateCatalogue(await read('exoplanets.json'));
const supplement = validateStellarCatalogue(await read('stellar-systems.json'));
const systems = verifyModels(data, supplement);
console.log(`exoplanets ${data.rows.length} planets, ${systems} systems, ${supplement.systems.length} stellar hierarchies; ` +
  `NASA ${data.fetchedAt.slice(0, 10)}, OEC ${supplement.fetchedAt.slice(0, 10)}`);
