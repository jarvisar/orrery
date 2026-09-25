#!/usr/bin/env node
/**
 * Copies the root package.json's version into desktop/package.json and its
 * lockfile. The site and the app are released together, under one version.
 *
 * Runs by itself as part of `npm version <patch|minor|major>` at the root
 * (the "version" script there), which then commits both and tags the release.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(DESKTOP, '../package.json'), 'utf8'));

for (const file of ['package.json', 'package-lock.json']) {
  const path = join(DESKTOP, file);
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}
console.log(`sync-version: desktop is now ${version}`);
