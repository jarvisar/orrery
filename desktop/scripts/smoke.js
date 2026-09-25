#!/usr/bin/env node
/**
 * Launches the desktop app with --self-test (src/self-test.js) and exits with
 * its result.
 *
 *   npm run smoke                      # development: Electron on the working tree
 *   npm run smoke -- --packaged        # the build in dist/ for this platform (npm run pack first)
 *   npm run smoke -- --software-gl     # no GPU (CI, VMs): WebGL on the CPU
 *   npm run smoke -- --screenshot=shot.png
 *
 * On Linux without a display it runs under xvfb-run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const packaged = args.includes('--packaged');
// A relative path is relative to where the command was typed: npm runs this
// from desktop/, even for `npm run desktop:smoke` at the root.
const here = process.env.INIT_CWD ?? process.cwd();
const passThrough = args.filter((arg) => arg !== '--packaged')
  .map((arg) => arg.startsWith('--screenshot=') ? `--screenshot=${resolve(here, arg.slice(13))}` : arg);

let command;
let commandArgs;
if (packaged) {
  command = findPackaged();
  commandArgs = ['--self-test', ...passThrough];
} else {
  command = electron;
  commandArgs = [DESKTOP, '--self-test', ...passThrough];
}

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  if (spawnSync('which', ['xvfb-run']).status !== 0) {
    console.error('smoke: no display, and xvfb-run is not installed (apt install xvfb)');
    process.exit(1);
  }
  commandArgs = ['-a', '--server-args=-screen 0 1920x1080x24', command, ...commandArgs];
  command = 'xvfb-run';
}

console.log(`smoke: ${command} ${commandArgs.join(' ')}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // see scripts/electron.js

const child = spawn(command, commandArgs, { stdio: 'inherit', env });
// The app has its own three-minute limit; this only catches a hang before it starts.
const guard = setTimeout(() => {
  console.error('smoke: the app did not exit within 4 minutes');
  child.kill();
  process.exit(1);
}, 240_000);
child.on('close', (code, signal) => {
  clearTimeout(guard);
  if (signal) console.error(`smoke: the app was killed (${signal})`);
  process.exit(code ?? 1);
});

/** The executable electron-builder left in dist/ for this platform. */
function findPackaged() {
  const dist = join(DESKTOP, 'dist');
  const dirs = existsSync(dist) ? readdirSync(dist, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  const candidates = {
    win32: dirs.filter((d) => d.name.startsWith('win')).map((d) => join(dist, d.name, 'Orrery.exe')),
    linux: dirs.filter((d) => d.name.startsWith('linux')).map((d) => join(dist, d.name, 'orrery')),
    // mac-arm64/ or mac/ (Intel); prefer the one this machine runs natively.
    darwin: dirs.filter((d) => d.name.startsWith('mac'))
      .sort((a) => (a.name.includes(process.arch) ? -1 : 1))
      .map((d) => join(dist, d.name, 'Orrery.app/Contents/MacOS/Orrery')),
  }[process.platform] ?? [];

  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    console.error('smoke: no packaged app in desktop/dist for this platform; run "npm run pack" first');
    process.exit(1);
  }
  return found;
}
