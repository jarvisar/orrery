/**
 * Headless Chrome and a dev server, shared by the checks that load the real
 * page (smoke.js, responsive.js).
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVE = fileURLToPath(new URL('../serve.js', import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where Chrome lives, in the places worth looking. */
export function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  return candidates.find((path) => path && existsSync(path));
}

/**
 * The Chrome to use, or exits: cleanly if none is installed, as a failure
 * under --strict (which CI passes, so a missing browser never passes silently).
 */
export function requireChrome(name, strict) {
  const chrome = findChrome();
  if (chrome) return chrome;
  const message = `${name}: no Chrome found; set CHROME_PATH to run this check.`;
  if (strict) {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} Skipping.`);
  process.exit(0);
}

/**
 * Where to load the site from, and the server started to provide it (null when
 * SMOKE_URL points at one already running).
 *
 * Without SMOKE_URL this always starts a fresh server from this checkout on a
 * free port. Reusing whatever answers on a well-known port would test some
 * other project's dev server, or a stale build of this one.
 */
export async function ensureServer() {
  if (process.env.SMOKE_URL) return { origin: process.env.SMOKE_URL, server: null };

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const server = spawn(process.execPath, [SERVE], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await fetch(origin, { method: 'HEAD' }).then((r) => r.ok, () => false)) {
      return { origin, server };
    }
  }
  server.kill();
  throw new Error(`the dev server never answered at ${origin}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function launch(executablePath) {
  const { default: puppeteer } = await import('puppeteer-core');
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      // CI runners have no GPU, so WebGL has to come from SwiftShader.
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
}

/** Resolves once the loading screen has been removed from the page. */
export function waitForApp(page) {
  // Software rendering on a CI runner is slow; the timeout is generous on
  // purpose, and only a genuine hang should hit it.
  return page.waitForFunction(() => !document.getElementById('loading'), { timeout: 180_000 });
}
