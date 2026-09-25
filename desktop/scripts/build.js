#!/usr/bin/env node
/**
 * Builds the desktop app: stages the web app, then packages it.
 *
 *   npm run build                # this machine's platform
 *   npm run build -- --win       # --win, --linux, --mac; several at once where the host allows
 *   npm run pack                 # unpacked only (dist/*-unpacked), for a quick look or a smoke test
 *
 * Windows builds on Windows, macOS on a Mac, Linux on Linux (or macOS). The
 * GitHub workflow (.github/workflows/desktop.yml) builds all three.
 *
 * The version is the root package.json's: the site and the app are released
 * together. Output lands in desktop/dist/.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch, Platform, build } from 'electron-builder';
import config from '../builder.config.js';
import { stage } from '../../scripts/stage.js';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(DESKTOP, '..');

const args = process.argv.slice(2);
const dirOnly = args.includes('--dir');
const PLATFORMS = { win: Platform.WINDOWS, linux: Platform.LINUX, mac: Platform.MAC };
const HOST = { win32: 'win', linux: 'linux', darwin: 'mac' }[process.platform];

let platforms = Object.keys(PLATFORMS).filter((name) => args.includes(`--${name}`));
if (!platforms.length) platforms = [HOST];

const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

// CI passes signing secrets that are not set as empty strings, and
// electron-builder reads an empty CSC_LINK as a path (the current directory).
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
  if (process.env[name] === '') delete process.env[name];
}
const macSigning = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

const entries = await stage(join(DESKTOP, 'web'));
console.log(`build: staged ${entries} entries of the web app into desktop/web`);
console.log(`build: Orrery ${version} for ${platforms.join(', ')}${dirOnly ? ' (unpacked)' : ''}`);

// An unpacked build is for this machine, so it is this machine's architecture.
const hostArch = Arch[process.arch] ?? Arch.x64;
const targets = new Map();
for (const name of platforms) {
  const platform = PLATFORMS[name];
  const perPlatform = dirOnly ? platform.createTarget('dir', hostArch) : platform.createTarget();
  for (const [key, value] of perPlatform) targets.set(key, value);
}

const artifacts = await build({
  projectDir: DESKTOP,
  targets,
  config: config({ version, macSigning }),
  publish: 'never',
});

for (const file of artifacts.filter((path) => !path.endsWith('.blockmap'))) {
  console.log(`build: ${file}`);
}
