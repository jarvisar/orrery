#!/usr/bin/env node
/**
 * Checks that the desktop app is still in step with the web app.
 *
 * The desktop app serves the web app as it is, so most changes to the site
 * need nothing here. These are the few that do, each of which would otherwise
 * work in the browser and fail only in the desktop app:
 *
 *   version   desktop/package.json matches the root package.json
 *   icons     desktop/build/ was drawn from the current public/icon/orrery.svg
 *   types     every served file has a content type in desktop/src/mime.js
 *   origins   every https:// origin the source uses is allowed by desktop/src/csp.js
 *   hooks     the web app still consults window.orreryDesktop where it has to
 *   syntax    the desktop sources parse
 *
 *   npm run desktop:check        (from the root; needs no install)
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SERVED } from '../../scripts/lib/served.js';
import { LINK_ORIGINS, REMOTE_ORIGINS } from '../src/csp.js';
import { MIME, MIME_BY_NAME } from '../src/mime.js';

const run = promisify(execFile);
const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(DESKTOP, '..');

const failures = [];
const fail = (message) => failures.push(message);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

const served = [];
for (const entry of SERVED) {
  const path = join(ROOT, entry);
  served.push(...(entry.includes('.') ? [path] : await walk(path)));
}
const rel = (path) => relative(ROOT, path).split('\\').join('/');

// --------------------------------------------------------------- 1. version
const rootVersion = (await readJson(join(ROOT, 'package.json'))).version;
const desktopVersion = (await readJson(join(DESKTOP, 'package.json'))).version;
if (rootVersion !== desktopVersion) {
  fail(
    `desktop/package.json is at ${desktopVersion} but the site is at ${rootVersion}; ` +
      'run "node desktop/scripts/sync-version.js" (npm version does this for you)'
  );
}
console.log(`version   ${rootVersion}`);

// ----------------------------------------------------------------- 2. icons
// Line endings normalised: a Windows checkout has CRLF, and that is not a change.
const svg = (await readFile(join(ROOT, 'public/icon/orrery.svg'), 'utf8')).replace(/\r\n/g, '\n');
const drawnFrom = await readJson(join(DESKTOP, 'build/icons.json')).then((data) => data.source, () => null);
const svgHash = createHash('sha256').update(svg).digest('hex').slice(0, 16);
if (drawnFrom !== svgHash) {
  fail('public/icon/orrery.svg has changed since the desktop icons were drawn; run "npm run icons" in desktop/');
}
console.log(`icons     drawn from orrery.svg ${svgHash}`);

// ----------------------------------------------------------------- 3. types
const untyped = new Map();
for (const file of served) {
  const known = MIME[extname(file).toLowerCase()] ?? MIME_BY_NAME[basename(file)];
  if (!known) untyped.set(extname(file) || basename(file), rel(file));
}
for (const [kind, example] of untyped) {
  fail(`no content type for ${kind} files (e.g. ${example}); add one to desktop/src/mime.js`);
}
console.log(`types     ${served.length} served files, all with a content type`);

// --------------------------------------------------------------- 4. origins
// Only quoted URLs count: a URL in a comment is not something the page loads.
// XML namespaces look like URLs but are never fetched.
const NAMESPACES = ['http://www.w3.org'];
const allowed = new Set([...REMOTE_ORIGINS, ...LINK_ORIGINS, ...NAMESPACES]);
const code = served.filter((file) => /\.(js|html|css)$/.test(file) && !rel(file).startsWith('vendor/'));
const origins = new Map();
for (const file of code) {
  const text = await readFile(file, 'utf8');
  for (const [, origin] of text.matchAll(/['"`(]\s*(https?:\/\/[a-z0-9.-]+(?::\d+)?)/gi)) {
    if (!allowed.has(origin.toLowerCase())) origins.set(origin, rel(file));
  }
}
for (const [origin, file] of origins) {
  fail(
    `${file} uses ${origin}, which the desktop app's Content-Security-Policy does not know about. ` +
      'If the page loads anything from it, add it to REMOTE_ORIGINS in desktop/src/csp.js; ' +
      'if it is only a link for the user to follow, add it to LINK_ORIGINS there'
  );
}
console.log(`origins   ${REMOTE_ORIGINS.length} fetched from, ${LINK_ORIGINS.length} linked to`);

// ----------------------------------------------------------------- 5. hooks
// The places the web app has to behave differently inside the desktop app.
// Each is a line or two (search src/ for orreryDesktop); this catches one
// being lost in a refactor.
// A file matching every pattern of a hook has to mention orreryDesktop.
const HOOKS = [
  {
    patterns: [/serviceWorker\.register\(/],
    why: 'registers the service worker without skipping it in the desktop app (window.orreryDesktop)',
  },
  {
    patterns: [/clipboard\.writeText\(/, /location\.href/],
    why: 'copies the page address, which is app:// in the desktop app; use window.orreryDesktop.webUrl there',
  },
  {
    patterns: [/requestFullscreen\(/, /userActivation/],
    why: 'waits for a click or key before full screen without trying window.orreryDesktop.requestFullscreen() first',
  },
];
let hooked = 0;
for (const file of served.filter((path) => rel(path).startsWith('src/') && path.endsWith('.js'))) {
  const text = await readFile(file, 'utf8');
  for (const hook of HOOKS) {
    if (!hook.patterns.every((pattern) => pattern.test(text))) continue;
    if (text.includes('orreryDesktop')) hooked++;
    else fail(`${rel(file)} ${hook.why}`);
  }
}
console.log(`hooks     ${hooked} places in src/ that consult window.orreryDesktop`);

// ---------------------------------------------------------------- 6. syntax
const sources = [
  ...(await walk(join(DESKTOP, 'src'))),
  ...(await walk(join(DESKTOP, 'scripts'))),
  join(DESKTOP, 'builder.config.js'),
].filter((file) => /\.(c?js)$/.test(file));
for (const file of sources) {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (error) {
    fail(`${rel(file)}: ${String(error.stderr || error.message).split('\n')[0]}`);
  }
}
console.log(`syntax    ${sources.length} desktop files`);

// ---------------------------------------------------------------- report
if (failures.length) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('\ndesktop is in step with the site');
