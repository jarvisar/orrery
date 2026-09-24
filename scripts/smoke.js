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

  // ?debug exposes the internals the resolution check below drives.
  await page.goto(`${ORIGIN}/?debug&body=saturn`, { waitUntil: 'load', timeout: 60_000 });

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

  // The adaptive resolution controller, fed made-up frame timings on a made-up
  // clock: it has to step down for a slow GPU and stay down, but give the
  // pixels back when frames are late for some other reason.
  const adaptive = await page.evaluate(() => {
    const { viewport, renderer } = window.orrery;
    renderer.setAnimationLoop(null);
    const realNow = performance.now;
    let now = realNow.call(performance) + 1e6;
    performance.now = () => now;
    const reset = () => {
      viewport.setAdaptiveResolution(false);
      viewport.setAdaptiveResolution(true);
      Object.assign(viewport, {
        _lastAdjust: 0, _ceiling: Infinity, _ceilingUntil: 0, _trial: null, _holdUntil: 0, _retryMs: 15_000, _holdMs: 30_000,
      });
      viewport._frameTimes.length = 0;
    };
    const run = (seconds, interval) => {
      for (let t = 0; t < seconds * 1000;) {
        const ms = interval();
        now += ms;
        t += ms;
        viewport.sample(ms);
      }
    };
    const rung = () => `${viewport.renderScale}${viewport.multisample ? '+msaa' : ''}`;
    const out = {};
    try {
      // Held at 30fps whatever the resolution, as iOS does in Low Power Mode.
      reset();
      run(20, () => 1000 / 30);
      out.capped = rung();
      out.cappedConstrained = viewport.constrained;
      // A GPU that needs 30ms for a full-quality frame, less for fewer pixels.
      reset();
      const top = viewport.ladder[0];
      const cost = (r) => r.scale ** 2 * (r.multisample ? 1.3 : 1);
      run(20, () => Math.max(1000 / 60, 30 * cost({ scale: viewport.renderScale, multisample: viewport.multisample }) / cost(top)));
      out.gpuBound = rung();
      // A healthy GPU, with every other frame held up by a texture upload.
      reset();
      let upload = false;
      run(20, () => {
        upload = !upload;
        if (upload) viewport.discardNextSample();
        return upload ? 1000 / 60 : 120;
      });
      out.uploads = rung();
    } finally {
      performance.now = realNow;
      reset();
    }
    return out;
  });
  assert(adaptive.capped === '1+msaa' && !adaptive.cappedConstrained,
    `a frame rate capped by the browser cost resolution: ended at ${adaptive.capped}`);
  assert(!['1+msaa', '1'].includes(adaptive.gpuBound),
    `a slow GPU did not get a lower resolution: stayed at ${adaptive.gpuBound}`);
  assert(adaptive.uploads === '1+msaa', `texture uploads were counted against the GPU: ended at ${adaptive.uploads}`);

  // The service worker registers once background loading is done, and has to
  // take control of the page for the site to be installable and work offline.
  const controlled = await page
    .waitForFunction(() => Boolean(navigator.serviceWorker?.controller), { timeout: 120_000 })
    .then(() => true, () => false);
  assert(controlled, 'the service worker never took control of the page');

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
