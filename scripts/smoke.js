#!/usr/bin/env node
/**
 * Loads the real page in headless Chrome and fails on anything that would
 * greet a visitor as a broken site.
 *
 * A syntax check cannot tell you the app throws on startup, and with no bundler
 * there is nothing else that would. This is the backstop: it waits for the
 * loading screen to finish, then asserts that the interface is actually there
 * and that nothing logged an error or 404ed along the way.
 *
 *   npm run smoke            # skips cleanly if no Chrome is installed
 *   npm run smoke -- --strict  # missing Chrome is a failure (used by CI)
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const STRICT = process.argv.includes('--strict');
const ORIGIN = process.env.SMOKE_URL ?? 'http://localhost:5173';

/** Where Chrome lives, in the places worth looking. */
function findChrome() {
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

const chrome = findChrome();
if (!chrome) {
  const message = 'smoke: no Chrome found; set CHROME_PATH to run this check.';
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} Skipping.`);
  process.exit(0);
}

/** Starts the dev server unless something is already answering. */
async function ensureServer() {
  if (await reachable()) return null;

  const server = spawn(process.execPath, ['scripts/serve.js'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await reachable()) return server;
  }
  server.kill();
  throw new Error(`nothing answering at ${ORIGIN}`);
}

const reachable = () =>
  fetch(ORIGIN, { method: 'HEAD' }).then((r) => r.ok, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await ensureServer();
const { default: puppeteer } = await import('puppeteer-core');

const browser = await puppeteer.launch({
  executablePath: chrome,
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

const problems = [];
let exitCode = 0;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('requestfailed', (r) =>
    problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });

  await page.goto(`${ORIGIN}/?body=saturn`, { waitUntil: 'load', timeout: 60_000 });

  // Software rendering on a CI runner is slow; the timeout is generous on
  // purpose, and only a genuine hang should hit it.
  await page.waitForFunction(() => !document.getElementById('loading'), { timeout: 180_000 });
  await sleep(4000);

  const state = await page.evaluate(() => ({
    ui: document.getElementById('ui') && !document.getElementById('ui').hidden,
    focus: document.querySelector('.picker__label')?.textContent ?? null,
    facts: document.querySelectorAll('.info__fact').length,
    bodies: document.querySelectorAll('.picker__option').length,
    date: document.querySelector('.timebar__date-main')?.textContent ?? null,
    canvas: (() => {
      const c = document.getElementById('viewport');
      return Boolean(c && c.width > 0 && c.height > 0);
    })(),
  }));

  const assert = (ok, message) => { if (!ok) problems.push(message); };
  assert(state.canvas, 'the WebGL canvas has no drawing buffer');
  assert(state.ui, 'the interface never became visible');
  assert(state.focus === 'Saturn', `?body=saturn focused "${state.focus}"`);
  assert(state.facts > 0, 'the info panel rendered no facts');
  assert(state.bodies >= 20, `the picker only lists ${state.bodies} bodies`);
  assert(Boolean(state.date), 'the time bar shows no date');

  // Drive the parts with the most moving pieces: a tour, and a jump in time.
  await page.click('.tours__button');
  await page.click('.tours__item');
  await sleep(1500);
  const tour = await page.evaluate(() => ({
    shown: !document.querySelector('.tour').hidden,
    title: document.querySelector('.tour__title')?.textContent,
  }));
  assert(tour.shown && tour.title === 'Sun', `the Grand Tour did not start at the Sun ("${tour.title}")`);
  await page.keyboard.press('Escape');

  await page.click('.timebar__date');
  const moments = await page.$$('.moment');
  assert(moments.length > 0, 'the date panel lists no moments');
  await moments[0]?.click();
  await sleep(3500);
  const jumped = await page.evaluate(() => new URL(location.href).searchParams.get('t'));
  assert(jumped?.startsWith('1846-'), `jumping to the first moment left t=${jumped}`);

  if (problems.length === 0) {
    console.log(
      `smoke: ok — ${state.bodies} bodies, focused ${state.focus}, ${state.facts} facts, ${state.date}`
    );
  } else {
    exitCode = 1;
    console.error(`smoke: ${problems.length} problem(s)`);
    for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`);
  }
} catch (error) {
  exitCode = 1;
  console.error(`smoke: ${error.message}`);
} finally {
  await browser.close();
  server?.kill();
}

process.exit(exitCode);
