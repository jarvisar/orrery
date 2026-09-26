#!/usr/bin/env node
/**
 * Drives every controller binding through a fake standard-mapping pad that
 * replaces navigator.getGamepads(): camera, time, flight, menus and settings,
 * full screen, vibration, and a second make of controller relabelling the
 * buttons. Then checks the legend sits clear of the interface at phone,
 * landscape phone and laptop sizes.
 *
 *   npm run gamepad                # skips cleanly if no Chrome is installed
 *   npm run gamepad -- --strict    # missing Chrome is a failure (used by CI)
 *   GAMEPAD_SHOTS=dir npm run gamepad   # also saves a screenshot at each step
 */
import { mkdirSync } from 'node:fs';
import {
  sleep, requireChrome, ensureServer, launch, waitForApp,
} from './lib/browser.js';

const STRICT = process.argv.includes('--strict');
const SHOTS = process.env.GAMEPAD_SHOTS;
const chrome = requireChrome('gamepad', STRICT);
const { origin: ORIGIN, server } = await ensureServer();
const browser = await launch(chrome);

const problems = [];
const assert = (ok, message) => { if (!ok) problems.push(message); };
let exitCode = 0;

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument(installFakePad);
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('orrery:welcomed', '1'); } catch { /* ignore */ }
  });

  let step = 0;
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, '0')}-${name}.png` });
  };
  const ev = (fn, ...args) => page.evaluate(fn, ...args);
  // Software rendering manages a few frames a second, so waits count frames, not time.
  const frames = async (count = 3) => page.waitForFunction(
    (until) => window.__frames >= until,
    { timeout: 60_000, polling: 50 },
    (await ev(() => window.__frames)) + count
  );
  const press = async (name) => {
    await ev((n) => __pad.button(n, true), name);
    await frames(2);
    await ev((n) => __pad.button(n, false), name);
    await frames(2);
  };
  const hold = async (set, clear, count) => {
    await ev(set);
    await frames(count);
    await ev(clear);
    await frames(2);
  };
  const boot = async (viewport, query = '?debug&body=saturn') => {
    await page.setViewport(viewport);
    await page.goto(`${ORIGIN}/${query}`, { waitUntil: 'load', timeout: 60_000 });
    await waitForApp(page);
    await ev(countFrames);
    await frames(2);
  };
  const state = () => ev(() => {
    const { ui, clock, director, camera } = orrery;
    const offset = camera.position.clone().sub(director.controls.target);
    const padbar = document.querySelector('.padbar');
    const active = document.activeElement;
    return {
      focus: document.querySelector('.picker__label').textContent,
      paused: clock.paused,
      rate: clock.daysPerSecond,
      direction: clock.direction,
      theta: Math.atan2(offset.x, offset.z),
      distance: offset.length(),
      flying: ui.state.flying,
      padMenus: ui.state.padMenus,
      gamepadClass: document.documentElement.classList.contains('is-gamepad'),
      padbar: !padbar.hidden && padbar.classList.contains('is-visible'),
      padbarTitle: padbar.querySelector('.padbar__title').textContent,
      padbarRows: [...padbar.querySelectorAll('.padbar__text')].map((n) => n.textContent),
      padbarFlight: padbar.classList.contains('is-flight'),
      settingsSection: !document.querySelector('.drawer__section').hidden,
      active: active === document.body ? null : {
        cls: active.className,
        id: active.dataset?.id ?? null,
        type: active.type ?? null,
        ring: parseFloat(getComputedStyle(active).outlineWidth) || 0,
      },
      pickerOpen: ui.bodyPicker.isOpen,
      fullscreen: Boolean(document.fullscreenElement),
      rumbles: window.__rumbles.length,
    };
  });

  /* --- connecting ---------------------------------------------------------- */

  await boot({ width: 1280, height: 800 });
  let s = await state();
  assert(!s.padbar, 'the controller legend is showing with no controller');
  assert(!s.settingsSection, 'controller settings are showing with no controller');

  // Browsers reveal a controller once a button on it is pressed. That press
  // wakes it, and should not also do what the button does.
  await ev(() => { __pad.plug(true, 'XBOX'); __pad.button('a', true); });
  await frames(3);
  await ev(() => __pad.button('a', false));
  await frames(2);
  s = await state();
  assert(!s.paused, 'the press that connected the controller also paused time');
  assert(s.padbar, 'no legend when the controller connected');
  assert(/Xbox controller connected/.test(s.padbarTitle), `legend title read "${s.padbarTitle}"`);
  assert(s.padbarRows.includes('Orbit'), `the legend does not describe orbiting: ${s.padbarRows}`);
  assert(s.gamepadClass, 'the page did not switch to controller mode');
  assert(s.settingsSection, 'controller settings did not appear');
  await shot('connected');

  /* --- the camera ---------------------------------------------------------- */

  let before = await state();
  await hold(() => __pad.stick('left', 1, 0), () => __pad.stick('left', 0, 0), 6);
  await frames(6);
  s = await state();
  assert(angle(before.theta, s.theta) > 0.2, `the left stick orbited by only ${angle(before.theta, s.theta).toFixed(3)} rad`);

  before = s;
  await hold(() => __pad.trigger('rt', 1), () => __pad.trigger('rt', 0), 6);
  s = await state();
  assert(s.distance < before.distance * 0.85, `RT did not zoom in (${before.distance.toFixed(1)} → ${s.distance.toFixed(1)})`);
  before = s;
  await hold(() => __pad.trigger('lt', 1), () => __pad.trigger('lt', 0), 6);
  s = await state();
  assert(s.distance > before.distance * 1.15, `LT did not zoom out (${before.distance.toFixed(1)} → ${s.distance.toFixed(1)})`);

  await press('right');
  s = await state();
  assert(s.focus !== 'Saturn', 'D-pad right did not move on from Saturn');
  const next = s.focus;
  await press('left');
  s = await state();
  assert(s.focus === 'Saturn', `D-pad left went from ${next} to ${s.focus}, not back to Saturn`);

  /* --- time ---------------------------------------------------------------- */

  before = s;
  await press('a');
  s = await state();
  assert(s.paused !== before.paused, 'A did not pause time');
  await press('a');
  await press('rb');
  s = await state();
  assert(s.rate > before.rate, `RB did not speed time up (${before.rate} → ${s.rate})`);
  await press('lb');
  await press('down');
  s = await state();
  assert(s.direction === -before.direction, 'D-pad down did not reverse time');
  await press('down');

  await press('y');
  s = await state();
  assert(s.focus === 'Whole system', `Y went to "${s.focus}", not the whole system`);
  await shot('overview');

  /* --- flight -------------------------------------------------------------- */

  await press('x');
  await frames(4);
  s = await state();
  assert(s.flying, 'X did not start flight');
  assert(s.padbarFlight && s.padbarRows.includes('Throttle'), `the legend did not switch to flight: ${s.padbarRows}`);
  assert(!(await ev(() => document.pointerLockElement)), 'flight captured the mouse for a controller');
  await shot('flight');

  const heading = () => ev(() => orrery.camera.quaternion.toArray());
  const q0 = await heading();
  await hold(() => __pad.stick('left', 0.8, -0.6), () => __pad.stick('left', 0, 0), 5);
  const q1 = await heading();
  assert(q0.some((v, i) => Math.abs(v - q1[i]) > 0.02), 'the left stick did not steer');

  // The lever moves at a rate per second, so hold it for time, not a count of
  // frames: five fast frames are well under a tenth of a second.
  await ev(() => __pad.trigger('rt', 1));
  await page.waitForFunction(() => orrery.ui.flightHud.controls.throttle > 0.2, { timeout: 10_000, polling: 50 }).catch(() => {});
  await ev(() => __pad.trigger('rt', 0));
  await frames(2);
  let flight = await ev(() => ({ throttle: orrery.ui.flightHud.controls.throttle }));
  assert(flight.throttle > 0.2, `RT only opened the throttle to ${flight.throttle.toFixed(2)}`);

  const rumbles = (await state()).rumbles;
  await ev(() => __pad.button('a', true));
  await frames(3);
  flight = await ev(() => ({ boosting: orrery.ui.flightHud.controls.boosting }));
  await ev(() => __pad.button('a', false));
  await frames(2);
  assert(flight.boosting, 'holding A did not boost');
  assert((await state()).rumbles > rumbles, 'boosting did not buzz the controller');
  await ev(() => orrery.settings.set('padRumble', false));
  const buzzes = (await state()).rumbles;
  await press('a');
  assert((await state()).rumbles === buzzes, 'the controller buzzed with vibration switched off');
  await ev(() => orrery.settings.set('padRumble', true));

  await press('right');
  flight = await ev(() => ({ target: orrery.ui.flightHud.controls.target?.id ?? null }));
  assert(flight.target, 'D-pad right chose no destination');
  await press('y');
  flight = await ev(() => ({ autopilot: orrery.ui.flightHud.controls.autopilot }));
  assert(flight.autopilot, 'Y did not engage the autopilot');
  await hold(() => __pad.trigger('lt', 1), () => __pad.trigger('lt', 0), 3);
  flight = await ev(() => ({ autopilot: orrery.ui.flightHud.controls.autopilot }));
  assert(!flight.autopilot, 'the throttle did not take over from the autopilot');

  await press('b');
  s = await state();
  assert(!s.flying, 'B did not leave flight');

  /* --- the menus ----------------------------------------------------------- */

  await press('menu');
  s = await state();
  assert(s.padMenus, 'Menu did not hand the controller to the interface');
  assert(s.active?.cls.includes('picker__button'), `Menu focused ${s.active?.cls}, not the body picker`);
  assert(s.active?.ring >= 2, `the focused control shows a ${s.active?.ring}px ring`);
  assert(s.padbarRows.includes('Back'), `the legend did not switch to the menus: ${s.padbarRows}`);
  await shot('menus');

  await press('right');
  s = await state();
  assert(s.active && !s.active.cls.includes('picker__button'), 'D-pad right did not move focus');
  await press('left');
  s = await state();
  assert(s.active?.cls.includes('picker__button'), `D-pad left came back to ${s.active?.cls}`);

  await press('a');
  s = await state();
  assert(s.pickerOpen, 'A did not open the body picker');
  assert(s.active?.cls.includes('picker__option'), `opening the picker left focus on ${s.active?.cls}`);
  await press('down');
  await press('down');
  s = await state();
  const chosen = s.active?.id;
  assert(chosen, 'D-pad down did not reach a body in the list');
  await shot('picker');
  await press('a');
  s = await state();
  const chosenName = await ev((id) => orrery.system.bodies.get(id)?.name, chosen);
  assert(!s.pickerOpen && s.focus === chosenName, `choosing ${chosen} with A left "${s.focus}" focused`);
  assert(s.active?.cls.includes('picker__button'), 'focus did not come back to the picker button');

  // The time-rate dial steps between its named rates.
  await ev(() => document.querySelector('.timebar__slider').focus());
  before = await state();
  await press('right');
  s = await state();
  assert(s.rate > before.rate && s.active?.type === 'range', `D-pad right on the rate dial went ${before.rate} → ${s.rate}`);
  await press('left');

  await press('b');
  s = await state();
  assert(!s.padMenus && !s.active, 'B with nothing open did not give the controller back to the camera');

  // A panel opened by mouse is still the controller's to work and close.
  await page.click('[aria-label="Settings"]');
  await frames(2);
  let found = null;
  for (let i = 0; i < 40 && !found; i++) {
    await press('down');
    const a = (await state()).active;
    if (a?.type === 'range') found = a;
  }
  assert(found, 'the D-pad never reached a slider in Settings');
  const slider = () => ev(() => Number(document.activeElement.value));
  const value = await slider();
  await press('right');
  assert((await slider()) !== value, 'D-pad right did not move a Settings slider');
  await press('left');
  await shot('settings');
  await press('b');
  assert(!(await ev(() => document.querySelector('.drawer.is-open'))), 'B did not close Settings');
  await press('b');

  await page.click('[aria-label="Controls"]');
  await frames(2);
  const help = await ev(() => ({
    first: document.querySelector('.help__body .section-title').textContent,
    faces: [...new Set([...document.querySelectorAll('.help__body .pad--face')].map((n) => n.textContent))],
  }));
  assert(help.first === 'Controller', `with a controller connected, the list starts at "${help.first}"`);
  assert(help.faces.sort().join() === 'A,B,X,Y', `the list draws the Xbox face buttons as ${help.faces}`);
  await hold(() => __pad.stick('right', 0, 1), () => __pad.stick('right', 0, 0), 5);
  const scrolled = await ev(() => document.querySelector('.help__body').scrollTop);
  assert(scrolled > 0, 'the right stick did not scroll the controls list');
  await shot('help');
  await press('b');
  assert(!(await ev(() => document.querySelector('.help.is-open'))), 'B did not close the controls list');
  await press('b');
  assert(!(await ev(() => orrery.ui.state.padMenus)), 'a second B did not leave the menus');

  /* --- full screen --------------------------------------------------------- */

  // Straight after a key press the browser allows it...
  await page.keyboard.press('Shift');
  await press('view');
  await frames(2);
  s = await state();
  assert(s.fullscreen, 'View did not go full screen straight after a key press');
  await press('view');
  await frames(2);
  assert(!(await state()).fullscreen, 'View did not leave full screen');

  // ...and otherwise waits for one, and says so. Puppeteer's evaluate() counts
  // as a user gesture, so these presses go in through the protocol instead.
  const cdp = await page.createCDPSession();
  const quiet = (expression) =>
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, userGesture: false });
  const quietFrames = (count) => quiet(`new Promise((resolve) => {
    const until = window.__frames + ${count};
    const poll = () => (window.__frames >= until ? resolve() : setTimeout(poll, 20));
    poll();
  })`);
  // Waiting with waitForFunction() would itself count, as it tidies up.
  await quiet(`new Promise((resolve) => {
    const poll = () => (navigator.userActivation.isActive ? setTimeout(poll, 100) : resolve());
    poll();
  })`);
  await quiet(`__pad.button('view', true)`);
  await quietFrames(2);
  await quiet(`__pad.button('view', false)`);
  await quietFrames(2);
  s = await state();
  assert(!s.fullscreen && /press any key/i.test(s.padbarTitle), `with no key press to go on, the legend read "${s.padbarTitle}"`);
  await shot('fullscreen-waiting');
  const pausedBefore = s.paused;
  await page.keyboard.press('Space');
  await frames(3);
  s = await state();
  assert(s.fullscreen, 'the key press after View did not go full screen');
  assert(s.paused === pausedBefore, 'the key that answered the full-screen request also paused time');
  await press('view');
  await frames(2);

  /* --- another make, and going away ---------------------------------------- */

  await ev(() => __pad.plug(false));
  await frames(3);
  s = await state();
  assert(/disconnected/.test(s.padbarTitle), `unplugging read "${s.padbarTitle}"`);
  assert(!s.settingsSection && !s.gamepadClass, 'the page stayed in controller mode with none connected');

  await ev(() => { __pad.plug(true, 'DUALSENSE'); __pad.button('b', true); });
  await frames(3);
  await ev(() => __pad.button('b', false));
  await frames(2);
  s = await state();
  assert(/PlayStation controller connected/.test(s.padbarTitle), `a DualSense connected as "${s.padbarTitle}"`);
  const cross = await ev(() => document.querySelector('.padbar .pad--face .sr-only, .help__body .pad--face .sr-only')?.textContent);
  assert(['Cross', 'Circle', 'Square', 'Triangle'].includes(cross), `a DualSense's buttons are labelled "${cross}"`);
  await shot('dualsense');

  /* --- where the legend sits ----------------------------------------------- */

  const touch = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 844, height: 390, ...touch },
    { width: 390, height: 844, ...touch },
  ]) {
    await boot(viewport);
    await ev(() => { __pad.plug(true, 'XBOX'); __pad.button('b', true); });
    await frames(3);
    await ev(() => __pad.button('b', false));
    await frames(4);
    const size = `${viewport.width}×${viewport.height}`;
    problems.push(...(await ev(overlaps, 'orbit')).map((p) => `${size} orbit: ${p}`));
    await shot(`layout-${size}-orbit`);
    await press('x');
    await frames(4);
    problems.push(...(await ev(overlaps, 'flight')).map((p) => `${size} flight: ${p}`));
    await shot(`layout-${size}-flight`);
    await press('x');
    await press('menu');
    problems.push(...(await ev(overlaps, 'menus')).map((p) => `${size} menus: ${p}`));
    await shot(`layout-${size}-menus`);
  }

  if (problems.length === 0) {
    console.log('gamepad: ok — camera, time, flight, menus, settings, full screen, vibration, and the legend at 3 sizes');
  } else {
    exitCode = 1;
    console.error(`gamepad: ${problems.length} problem(s)`);
    for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`);
  }
} catch (error) {
  exitCode = 1;
  console.error(`gamepad: ${error.stack ?? error.message}`);
  for (const problem of problems) console.error(`  - ${problem}`);
} finally {
  await browser.close();
  server?.kill();
}

process.exit(exitCode);

/* ------------------------------------------------------------------------ */

function angle(a, b) {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/**
 * Runs in the page before anything else: a standard-mapping controller that
 * the browser reports through getGamepads(), unplugged until this script
 * plugs it in.
 */
function installFakePad() {
  const IDS = {
    XBOX: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    DUALSENSE: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
  };
  const INDEX = {
    a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7,
    view: 8, menu: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15, home: 16,
  };
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const axes = [0, 0, 0, 0];
  const pad = {
    id: IDS.XBOX, index: 0, connected: true, mapping: 'standard', timestamp: 0, axes, buttons,
    vibrationActuator: {
      type: 'dual-rumble',
      playEffect(type, params) {
        window.__rumbles.push(params);
        return Promise.resolve('complete');
      },
    },
  };
  let plugged = false;
  window.__rumbles = [];
  Object.defineProperty(Navigator.prototype, 'getGamepads', {
    configurable: true,
    value: () => [plugged ? pad : null, null, null, null],
  });
  const touch = () => { pad.timestamp = performance.now(); };
  window.__pad = {
    plug(on, make = 'XBOX') {
      plugged = on;
      pad.id = IDS[make];
      for (const b of buttons) Object.assign(b, { pressed: false, touched: false, value: 0 });
      axes.fill(0);
      touch();
    },
    button(name, down) {
      Object.assign(buttons[INDEX[name]], { pressed: down, touched: down, value: down ? 1 : 0 });
      touch();
    },
    trigger(name, value) {
      Object.assign(buttons[INDEX[name]], { pressed: value > 0.5, touched: value > 0, value });
      touch();
    },
    stick(side, x, y) {
      const i = side === 'left' ? 0 : 2;
      axes[i] = x;
      axes[i + 1] = y;
      touch();
    },
  };
}

/** Counts controller polls, which happen once a frame, so waits can count frames. */
function countFrames() {
  window.__frames = 0;
  const { gamepad } = orrery.ui;
  const poll = gamepad.poll.bind(gamepad);
  gamepad.poll = (dt) => {
    window.__frames++;
    poll(dt);
  };
}

/** Runs in the page: the legend is on screen and clear of everything it could cover. */
function overlaps(context) {
  const problems = [];
  const bar = document.querySelector('.padbar');
  if (bar.hidden || !bar.classList.contains('is-visible')) return [`the legend is not showing for ${context}`];
  const rect = bar.getBoundingClientRect();
  if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) {
    problems.push(`the legend runs off screen at ${Math.round(rect.left)},${Math.round(rect.top)}–${Math.round(rect.right)},${Math.round(rect.bottom)}`);
  }
  const shown = (node) => {
    if (!node || node.closest('[hidden]')) return false;
    // The flight HUD fades out when flight ends; mid-fade is not a collision.
    if (node.closest('.hud') && !node.closest('.hud.is-active')) return false;
    for (let n = node; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const selectors = [
    '.brand', '.picker', '.topbar__end', '.info', '.tour', '.timebar',
    '.hud__controls', '.hud__dest', '.hud__near', '.hud__reticle',
  ];
  // Only the legend's own text and glyphs count, not the box round them.
  const parts = [...bar.querySelectorAll('.padbar__title, .padbar__row')]
    .filter((n) => n.textContent.trim())
    .map((n) => n.getBoundingClientRect());
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (!shown(node)) continue;
    const r = node.getBoundingClientRect();
    const hit = parts.some((p) =>
      Math.min(p.right, r.right) - Math.max(p.left, r.left) > 1 &&
      Math.min(p.bottom, r.bottom) - Math.max(p.top, r.top) > 1);
    if (hit) problems.push(`the legend overlaps ${selector}`);
  }
  return problems;
}
