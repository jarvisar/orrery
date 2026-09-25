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
import { SERVED, NOT_SERVED } from './lib/served.js';

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
const sources = [...(await jsFiles('src')), ...(await jsFiles('scripts')), 'sw.js'];
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

// ---------------------------- 6. files the stylesheet and page point at directly
const css = await readFile(join(ROOT, 'style.css'), 'utf8');
const linked = [
  ...[...css.matchAll(/url\("?([^")]+)"?\)/g)].map((match) => match[1]),
  ...[...html.matchAll(/\b(?:href|src)="((?:public|vendor|src)\/[^"]+)"/g)].map((match) => match[1]),
];
for (const path of new Set(linked)) {
  if (!(await exists(path))) fail(`${path} is linked from the page or stylesheet but missing`);
}
console.log(`links     ${new Set(linked).size} files the page and stylesheet name`);

// ------------------------------------------ 7. what installing the app needs
// Browsers do not report a broken manifest; the install option just never
// appears. These are the parts of it that decide whether it does.
const webManifest = JSON.parse(await readFile(join(ROOT, 'site.webmanifest'), 'utf8'));
for (const key of ['name', 'short_name', 'start_url', 'display', 'icons']) {
  if (!webManifest[key]) fail(`site.webmanifest has no "${key}"`);
}
const images = [...(webManifest.icons ?? []), ...(webManifest.screenshots ?? [])];
for (const image of images) {
  if (!(await exists(image.src))) fail(`site.webmanifest names ${image.src}, which is missing`);
}
const iconSizes = new Set((webManifest.icons ?? []).map((icon) => icon.sizes));
for (const size of ['192x192', '512x512']) {
  if (!iconSizes.has(size)) fail(`site.webmanifest needs a ${size} PNG icon to be installable`);
}
if (!(webManifest.icons ?? []).some((icon) => icon.purpose?.includes('maskable'))) {
  fail('site.webmanifest has no maskable icon, so Android will shrink the icon onto a white disc');
}
const worker = await readFile(join(ROOT, 'sw.js'), 'utf8');
if (!/^const BUILD = .*;$/m.test(worker) || !/^const PRECACHE = \[\];$/m.test(worker)) {
  fail('sw.js no longer has the BUILD and empty PRECACHE lines that scripts/stamp-sw.js fills in');
}
console.log(`install   ${images.length} manifest images, service worker ready to stamp`);

// ------------------------------------------------------------ 8. the star field
const stars = await readFile(join(ROOT, 'public/data/stars.bin')).catch(() => null);
if (!stars) fail('public/data/stars.bin is missing - run scripts/build-sky.py');
else if (stars.length % 8 !== 0) fail(`public/data/stars.bin is ${stars.length} bytes, not a whole number of stars`);
else console.log(`stars     ${stars.length / 8} in the catalogue`);

// ------------------------- 9. every top-level file is either shipped or not
// Pages and the desktop app are both staged from scripts/lib/served.js, so a
// new top-level file the page needs, but which is missing from that list,
// would work under `npm run dev` and 404 everywhere else.
const tracked = await run('git', ['ls-files'], { cwd: ROOT }).then(
  ({ stdout }) => new Set(stdout.split('\n').filter(Boolean).map((path) => path.split('/')[0])),
  () => null
);
if (tracked) {
  for (const entry of tracked) {
    if (!SERVED.includes(entry) && !NOT_SERVED.includes(entry)) {
      fail(
        `${entry} is new at the top level: add it to SERVED in scripts/lib/served.js if the ` +
          'site needs it, or to NOT_SERVED if it is only for development'
      );
    }
  }
  for (const entry of SERVED) {
    if (!(await exists(entry))) fail(`scripts/lib/served.js lists ${entry}, which does not exist`);
  }
  const kept = [...tracked].filter((entry) => NOT_SERVED.includes(entry)).length;
  console.log(`staging   ${SERVED.length} entries served, ${kept} kept back`);
} else {
  console.log('staging   skipped (not a git checkout)');
}

// ------------------------------------------------------------------- report
if (failures.length) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('\nall checks passed');
