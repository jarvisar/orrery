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
import {
  sleep, requireChrome, ensureServer, launch, waitForApp,
} from './lib/browser.js';

const STRICT = process.argv.includes('--strict');
const chrome = requireChrome('smoke', STRICT);
const { origin: ORIGIN, server } = await ensureServer();
const browser = await launch(chrome);

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

  await waitForApp(page);
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
