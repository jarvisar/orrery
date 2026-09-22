#!/usr/bin/env node
/**
 * Pre-deploy checks.
 *
 * There is no bundler to catch mistakes here, so this stands in for one. It is
 * deliberately narrow: it only checks the things that would break the live site
 * silently, where the first sign of trouble is a 404 in someone's console.
 *
 *   npm run check
 */
import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const fail = (message) => failures.push(message);

/** Every .js file under a directory, recursively. */
async function jsFiles(dir) {
  const found = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await jsFiles(path)));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

const exists = (path) =>
  access(join(ROOT, path)).then(() => true, () => false);

// ---------------------------------------------------------------- 1. syntax
const sources = [...(await jsFiles('src')), ...(await jsFiles('scripts'))];
for (const file of sources) {
  try {
    await run(process.execPath, ['--check', join(ROOT, file)]);
  } catch (error) {
    fail(`${file}: ${String(error.stderr || error.message).split('\n')[0]}`);
  }
}
console.log(`syntax    ${sources.length} files checked`);

// ------------------------------------------- 2. vendored three is up to date
const declared = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  .dependencies.three.replace(/^[^\d]*/, '');
const vendored = (await readFile(join(ROOT, 'vendor/three/VERSION'), 'utf8'))
  .match(/three@([\d.]+)/)?.[1];

if (vendored !== declared) {
  fail(
    `vendor/three holds three@${vendored} but package.json asks for ${declared}. ` +
      'Run "npm install && npm run vendor".'
  );
}
console.log(`vendor    three@${vendored}`);

// ------------------------------------- 3. the import map resolves to real files
const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const importMap = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
for (const [specifier, target] of Object.entries(importMap.imports)) {
  // Directory mappings end in a slash; spot-check the directory itself.
  const path = target.replace(/^\.\//, '');
  if (!(await exists(path))) fail(`import map: "${specifier}" -> ${target} does not exist`);
}
console.log(`importmap ${Object.keys(importMap.imports).length} entries resolve`);

// ------------------------------- 4. every texture the catalogue names is shipped
const manifest = JSON.parse(await readFile(join(ROOT, 'public/textures/manifest.json'), 'utf8'));
const catalogue = await readFile(join(ROOT, 'src/data/bodies.js'), 'utf8');

// The catalogue is data, so the texture stems can be read straight out of it.
const referenced = new Set(
  [...catalogue.matchAll(/\b(?:map|bumpMap|specularMap|emissiveMap|alphaMap):\s*'([a-z0-9_]+)'/g)]
    .map((match) => match[1])
);
referenced.add('stars_milkyway');

for (const stem of referenced) {
  if (!manifest[stem]) fail(`texture "${stem}" is referenced but missing from the manifest`);
}
for (const [stem, entry] of Object.entries(manifest)) {
  if (!(await exists(join('public/textures', entry.file)))) {
    fail(`manifest lists ${entry.file} for "${stem}", but that file is not on disk`);
  }
}
const orphans = Object.keys(manifest).filter((stem) => !referenced.has(stem));
console.log(
  `textures  ${referenced.size} referenced, ${Object.keys(manifest).length} shipped` +
    (orphans.length ? ` (${orphans.length} unused: ${orphans.join(', ')})` : '')
);

// ----------------------------------------------- 5. models the app asks for
const models = new Set(
  [...catalogue.matchAll(/\bmodel:\s*'([a-z0-9_]+)'/g)].map((match) => match[1])
);
models.add('ufo'); // referenced from main.js, not the catalogue
for (const name of models) {
  if (!(await exists(`public/models/${name}.glb`))) fail(`public/models/${name}.glb is missing`);
}
console.log(`models    ${models.size} present`);

// ------------------------------------------------------------------- report
if (failures.length) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('\nall checks passed');
