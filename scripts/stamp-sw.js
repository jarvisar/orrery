#!/usr/bin/env node
/**
 * Fills in the service worker's precache list for a staged copy of the site.
 *
 * The committed sw.js ships with an empty list, which is what development
 * wants. The deploy workflow runs this against _site/ once the served files
 * have been copied there, so the list is exactly what Pages will serve, each
 * with a content hash for a revision. BUILD becomes a hash of all of them, so
 * any change to any file is a new worker, and no change at all is not.
 *
 *   node scripts/stamp-sw.js _site
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';

const site = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: node scripts/stamp-sw.js <staged site directory>');
  process.exit(1);
}

/** Served, but never needed offline: the worker itself, and the install-prompt art. */
const SKIP = [/^sw\.js$/, /^\.nojekyll$/, /^public\/screenshots\//];

async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}

const hash = (data) => createHash('sha256').update(data).digest('hex').slice(0, 12);

const entries = [];
for (const file of await files(site)) {
  const path = relative(site, file).split(sep).join('/');
  if (SKIP.some((pattern) => pattern.test(path))) continue;
  entries.push([path, hash(await readFile(file))]);
}
entries.sort(([a], [b]) => (a < b ? -1 : 1));

const build = hash(entries.map((entry) => entry.join(' ')).join('\n'));

const target = join(site, 'sw.js');
let source = await readFile(target, 'utf8');
const replace = (pattern, value, what) => {
  if (!pattern.test(source)) {
    console.error(`stamp-sw: could not find ${what} in sw.js`);
    process.exit(1);
  }
  source = source.replace(pattern, value);
};
replace(/^const BUILD = .*;$/m, `const BUILD = '${build}';`, 'the BUILD constant');
replace(/^const PRECACHE = \[\];$/m, `const PRECACHE = ${JSON.stringify(entries)};`, 'the empty PRECACHE list');
await writeFile(target, source);

const bytes = (await Promise.all(entries.map(([path]) => readFile(join(site, path)))))
  .reduce((sum, data) => sum + data.length, 0);
console.log(`stamp-sw: build ${build}, ${entries.length} files, ${(bytes / 1e6).toFixed(1)} MB precached`);
