import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { requireChrome, ensureServer, launch, waitForApp, sleep } from './lib/browser.js';
import { groupSystems, makeSystem } from '../src/data/exoplanets.js';

const require = createRequire(import.meta.url);
const { origin, server } = await ensureServer();
const browser = await launch(requireChrome('exoplanets', process.argv.includes('--strict')));
const errors = [];
const LIVE = process.argv.includes('--live');
const snapshot = JSON.parse(await readFile(new URL('../public/data/exoplanets.json', import.meta.url)));
const expectedBodies = makeSystem(groupSystems(snapshot).find((s) => s.name === 'TRAPPIST-1'), snapshot).bodies.length;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Offline, repeatable test; live proxy integration is checked separately.
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (!LIVE && r.url().includes('cors-proxy-phi.vercel.app')) return r.respond({ status: 503, contentType: 'application/json', body: '{}' });
    r.continue();
  });
  await page.goto(`${origin}/?debug&system=TRAPPIST-1&t=2026-09-25`, { waitUntil: 'load' });
  await waitForApp(page);
  assert.equal(await page.evaluate(() => window.orrery.system.bodies.size), expectedBodies);
  assert.equal(await page.evaluate(() => window.orrery.belts.clouds.length), 0);
  assert.equal(await page.evaluate(() => window.orrery.system.catalogue.name), 'TRAPPIST-1');
  // No moons or rings to shadow: the six-face shadow pass is skipped entirely.
  assert.deepEqual(await page.evaluate(() => [window.orrery.system.sunLight.castShadow, window.orrery.renderer.shadowMap.enabled]), [false, false]);
  await page.evaluate(() => window.orrery.ui.selectBody('planet:TRAPPIST-1 e', { instant: true }));
  await sleep(600);
  assert.match(await page.$eval('.info__provenance', (el) => el.textContent), /illustrative/);
  assert.equal(await page.$eval('.info__title', (el) => el.textContent), 'TRAPPIST-1 e');
  await page.evaluate(() => window.orrery.settings.set('scale', 0.65));
  await sleep(300);
  assert.ok(await page.evaluate(() => [...window.orrery.system.bodies.values()].every((v) => v.group.position.toArray().every(Number.isFinite))));
  await page.click('.systems-button');
  await page.waitForSelector('.systems__card');
  await page.type('.systems__tools input', 'Proxima Centauri');
  assert.ok(await page.$('[data-system="Proxima Cen"]'));
  await page.$eval('.systems__tools input', (el) => { el.value = 'Tau Ceti'; el.dispatchEvent(new Event('input')); });
  assert.ok(await page.$('[data-system="tau Cet"]'), 'full Bayer names find the archive’s abbreviations');
  // Cards say when only some of a system's stars can be drawn, once the supplement is in.
  await page.$eval('.systems__tools input', (el) => { el.value = 'Kepler-444'; el.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => document.querySelector('[data-system="Kepler-444"] small')?.textContent.includes('host star only'), { timeout: 10_000 });
  await page.$eval('.systems__tools input', (el) => { el.value = 'Proxima'; el.dispatchEvent(new Event('input')); });
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => (await axe.run(document.querySelector('.systems'), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
  })).violations.map((v) => `${v.id}: ${v.description}`));
  assert.deepEqual(violations, []);
  await page.$eval('.systems__tools input', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
  await mkdir('node_modules/.cache/exoplanets', { recursive: true });
  await page.screenshot({ path: 'node_modules/.cache/exoplanets/atlas.png' });
  for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
    await page.setViewport({ width, height });
    assert.ok(await page.$eval('.systems', (el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1;
    }), `${width}×${height} atlas fits`);
  }
  await page.setViewport({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.systems', (el) => el.open), false);
  await page.evaluate(() => window.orrery.ui.showOverview(undefined, { instant: true }));
  await sleep(500);
  await page.screenshot({ path: 'node_modules/.cache/exoplanets/trappist.png' });
  await page.reload({ waitUntil: 'load' });
  await waitForApp(page);
  assert.equal(await page.evaluate(() => window.orrery.system.bodies.size), expectedBodies);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'load' });
  await waitForApp(page);
  assert.equal(await page.evaluate(() => window.orrery.system.bodies.size), expectedBodies);
  await page.setOfflineMode(false);
  if (LIVE) {
    const result = await page.evaluate(async () => {
      const catalogue = window.orrery.ui.explorer.catalogue;
      const ok = await catalogue.refresh();
      return { ok, count: catalogue.data.rows.length, status: catalogue.status };
    });
    assert.ok(result.ok, result.status);
    console.log(`Live browser CORS refresh: ${result.count} planets. ${result.status}`);
  }
  for (const [name, stars, planet] of [
    ['Kepler-16', 2, 'Kepler-16 b'], ['Kepler-47', 2, 'Kepler-47 d'],
    ['Proxima Cen', 3, 'Proxima Cen b'], ['PH1', 2, 'PH1 b'],
    ['Kepler-444', 1, 'Kepler-444 b'], ['HD 133131 A', 2, 'HD 133131 B b'],
    ['PSR B1257+12', 1, 'PSR B1257+12 b'], ['HR 8799', 1, 'HR 8799 b'], ['GJ 414 A', 2, 'GJ 414 A b'], ['16 Cyg B', 3, '16 Cyg B b'],
  ]) {
    await page.goto(`${origin}/?debug&system=${encodeURIComponent(name)}`, { waitUntil: 'load' });
    await waitForApp(page);
    assert.equal(await page.evaluate(() => [...window.orrery.system.bodies.values()].filter((v) => v.kind === 'star').length), stars, name);
    // Each star lights only the planets around it, or around a pair it belongs to.
    const lights = await page.evaluate(() => [...window.orrery.system.starLights.values()].map((l) => ({ distance: l.distance, intensity: l.intensity })));
    assert.ok(lights.length === 1 || lights.every((l) => l.distance > 0 && l.intensity > 0), `${name}: starlight fades past its own planets`);
    if (name === 'Proxima Cen') {
      // Proxima's planets would be invisible in the 13,000 AU stellar orbit: it opens on them.
      const home = await page.evaluate(() => {
        const { system, director } = window.orrery;
        const star = system.bodies.get(system.catalogue.starId);
        return { label: document.querySelector('.picker__label').textContent, lights: system.starLights.size,
          gap: director.controls.target.distanceTo(star.group.position), anchored: director.anchor === star };
      });
      assert.equal(home.label, 'Planets of Proxima Centauri');
      assert.ok(home.anchored && home.gap < 1, 'the view follows Proxima');
      assert.equal(home.lights, 1, 'Alpha Centauri A and B light no planet here');
      await page.screenshot({ path: 'node_modules/.cache/exoplanets/Proxima-home.png' });
    }
    const finite = await page.evaluate(() => {
      const { system, orbits } = window.orrery;
      for (const exponent of [0.45, 0.65]) {
        system.setScaleExponent(exponent);
        orbits.rescale();
        for (const day of [-10000, 0, 10000]) {
          system.update(day);
          orbits.update(window.orrery.camera.position, day);
          for (const view of system.bodies.values()) {
            if (!view.group.position.toArray().every(Number.isFinite)) return false;
            const anchor = system.stellarPositions.get(view.id);
            if (anchor && Math.hypot(view.group.position.x - anchor.x, view.group.position.y - anchor.y, view.group.position.z - anchor.z) > 1e-6) return false;
          }
          for (const [id, light] of system.starLights) if (!light.position.equals(system.bodies.get(id).group.position)) return false;
        }
      }
      return true;
    });
    assert.ok(finite, `${name}: positions, mass fractions, lights and paths`);
    if (planet) {
      await page.evaluate((id) => window.orrery.ui.selectBody(id, { instant: true }), `planet:${planet}`);
      await sleep(300);
      assert.equal(await page.$eval('.info__title', (el) => el.textContent), planet);
      assert.ok(!await page.$eval('.info', (el) => /NaN|Infinity/.test(el.textContent)));
      // Stars NASA lists that cannot be drawn are named, or counted, next to the ones that are.
      const note = await page.$eval('.info', (el) => el.querySelector('.info__hidden-stars')?.textContent ?? null);
      if (name === 'Kepler-444') assert.equal(note, 'Not shown: Kepler-444 B, Kepler-444 C, orbits unknown.');
      if (stars === 3 && name !== 'Kepler-444') assert.equal(note, null, `${name} draws all its stars`);
    }
    if (name === 'Kepler-16' || name === 'Proxima Cen' || name === 'GJ 414 A') {
      await page.evaluate(() => window.orrery.ui.showOverview(undefined, { instant: true }));
      await sleep(300);
      await page.screenshot({ path: `node_modules/.cache/exoplanets/${name.replaceAll(' ', '-')}.png` });
    }
  }
  // Follow the home navigation and ensure ordinary Solar System behavior returns.
  await page.click('.systems-button');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('.systems__home')]);
  await waitForApp(page);
  assert.equal(await page.evaluate(() => window.orrery.system.catalogue.isExoplanet), false);
  assert.equal(await page.$eval('.picker__label', (el) => el.textContent), 'Earth');
  assert.deepEqual(errors, []);
  console.log('Exoplanets: binary/triple/partial quadruple systems, compact hosts, incomplete orbits, scale, search, navigation, offline reload, accessibility and mobile atlas passed.');
} finally { await browser.close(); server?.kill(); }
