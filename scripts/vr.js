#!/usr/bin/env node
/**
 * Drives VR through IWER, Meta's WebXR emulator, standing in for a Quest 3:
 * pointing and selecting, grabbing, two-handed scaling, the sticks and face
 * buttons, the panel by ray and by fingertip, the palm gesture, and recentring.
 *
 * Requests to the CDN the controller and hand models come from are refused,
 * which keeps the run hermetic and exercises the offline stand-ins.
 *
 *   npm run vr               # skips cleanly if no Chrome is installed
 *   npm run vr -- --strict   # missing Chrome is a failure (used by CI)
 *   VR_SHOTS=dir npm run vr  # also saves a screenshot at each step
 */
import { mkdirSync } from 'node:fs';
import {
  sleep, requireChrome, ensureServer, launch, waitForApp,
} from './lib/browser.js';

const STRICT = process.argv.includes('--strict');
const SHOTS = process.env.VR_SHOTS;
const chrome = requireChrome('vr', STRICT);
const { origin: ORIGIN, server } = await ensureServer();
const browser = await launch(chrome);

const problems = [];
const assert = (ok, message) => { if (!ok) problems.push(message); };
let exitCode = 0;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    // The refused CDN requests below are expected; anything else is not.
    if (m.type() === 'error' && !/ERR_FAILED|ERR_BLOCKED/.test(m.text())) problems.push(`console.error: ${m.text()}`);
  });
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().startsWith('https://cdn.jsdelivr.net/') ? r.abort('blockedbyclient') : r.continue()));

  // The emulator has to be in place before the page asks whether VR is there.
  await page.evaluateOnNewDocument(() => {
    window.__xr = import('/node_modules/iwer/build/iwer.module.js').then((iwer) => {
      const device = new iwer.XRDevice(iwer.metaQuest3);
      device.installRuntime({ forceInstall: true });
      window.__device = device;
    });
  });

  await page.goto(`${ORIGIN}/?debug&body=saturn`, { waitUntil: 'load', timeout: 60_000 });
  await waitForApp(page);
  await page.evaluate(() => window.__xr);
  await installHelpers(page);

  let step = 0;
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, '0')}-${name}.png` });
  };
  const state = () => page.evaluate(() => T.state());
  // Software rendering manages a few frames a second, so waits count frames, not time.
  const frames = async (count = 3) => page.waitForFunction(
    (until) => window.__frames >= until,
    { timeout: 60_000, polling: 50 },
    (await page.evaluate(() => window.__frames)) + count
  );
  const press = async (fn, ...args) => {
    await page.evaluate(fn, 1, ...args);
    await frames(2);
    await page.evaluate(fn, 0, ...args);
    await frames(2);
  };

  /* --- entering ------------------------------------------------------------ */

  assert(await page.evaluate(() => !document.querySelector('.topbar__vr').hidden), 'no VR button with a headset present');
  await page.click('.topbar__vr');
  await page.waitForFunction(() => orrery.ui.vr.presenting && orrery.ui.vr.focus, { timeout: 30_000 });
  await frames(10);
  let s = await state();
  assert(s.focus === 'saturn', `entered VR looking at ${s.focus}, not Saturn`);
  assert(s.panelHolder === 'left', 'the panel is not on the left controller');
  assert(s.standIns === 2, `expected two stand-in controllers offline, saw ${s.standIns}`);
  assert(s.fade < 0.05, `still faded in after entering (${s.fade})`);
  await shot('entered');

  /* --- controllers --------------------------------------------------------- */

  // Point at a panel button and pull the trigger.
  await page.evaluate(() => T.aimAtButton('right', 'pause'));
  await frames();
  s = await state();
  assert(s.panelHover === 'pause', `ray on the Pause button hovered ${s.panelHover}`);
  const pausedBefore = s.paused;
  await press((v) => T.button('right', 'trigger', v));
  await frames();
  s = await state();
  assert(s.paused !== pausedBefore, 'pulling the trigger on Pause did not pause');
  await shot('panel-by-ray');

  // Grip and drag: the world moves with the hand.
  const before = s.rig;
  await page.evaluate(() => T.button('right', 'squeeze', 1));
  await frames(2);
  await page.evaluate(() => T.move('right', 0.2, 0, 0));
  await frames();
  await page.evaluate(() => T.button('right', 'squeeze', 0));
  await frames(2);
  s = await state();
  assert(distance(before, s.rig) > 1, 'gripping and moving did not move the world');

  // Both grips, hands pulled apart: the world grows.
  const scaleBefore = s.scale;
  await page.evaluate(() => { T.button('left', 'squeeze', 1); T.button('right', 'squeeze', 1); });
  await frames(2);
  await page.evaluate(() => { T.move('left', -0.15, 0, 0); T.move('right', 0.15, 0, 0); });
  await frames();
  await page.evaluate(() => { T.button('left', 'squeeze', 0); T.button('right', 'squeeze', 0); });
  await frames(2);
  s = await state();
  assert(s.scale < scaleBefore * 0.8, `pulling both grips apart left the scale at ${s.scale} (was ${scaleBefore})`);

  // Snap turn, and the vignette while the stick flies.
  const yaw = s.yaw;
  await page.evaluate(() => T.stick('right', 1, 0));
  await frames(2);
  await page.evaluate(() => T.stick('right', 0, 0));
  await frames(2);
  s = await state();
  assert(Math.abs(Math.abs(s.yaw - yaw) - Math.PI / 6) < 0.01, `snap turn turned by ${s.yaw - yaw}`);
  await page.evaluate(() => T.stick('left', 0, -1));
  await frames(6);
  s = await state();
  assert(s.vignette > 0.5, `no comfort vignette while flying (${s.vignette})`);
  await shot('flying');
  await page.evaluate(() => T.stick('left', 0, 0));
  await frames(5);
  s = await state();
  assert(s.vignette === 0, `the vignette stayed up after flying (${s.vignette})`);

  // B: the whole system. Then point at Jupiter and select it.
  await press((v) => T.button('right', 'b-button', v));
  await frames(10);
  s = await state();
  assert(s.focus === null && s.scale > 10_000, `B did not show the whole system (focus ${s.focus}, scale ${s.scale})`);
  await shot('overview');
  await page.evaluate(() => T.aimAtBody('right', 'jupiter'));
  await frames();
  s = await state();
  assert(s.hover.right === 'jupiter', `ray at Jupiter hovered ${s.hover.right}`);
  await press((v) => T.button('right', 'trigger', v));
  await frames(10);
  s = await state();
  assert(s.focus === 'jupiter', `selecting Jupiter focused ${s.focus}`);
  await shot('jupiter');

  // Recentring brings the view back in front.
  await page.evaluate(() => T.turnHead(Math.PI / 2));
  await frames(2);
  await page.evaluate(() => __device.recenter());
  await frames(10);
  s = await state();
  assert(s.focusAhead > 0.95, `after recentring Jupiter is off to the side (${s.focusAhead})`);

  /* --- hands --------------------------------------------------------------- */

  await page.evaluate(() => { __device.primaryInputMode = 'hand'; T.resetHands(); });
  await frames(5);
  s = await state();
  assert(s.handsMode, 'the panel does not know the hands are in use');
  assert(s.panelHolder === null && s.panelShown, 'with hands the panel should float on its own');
  await shot('hands');

  // A quick pinch on a body selects it: the whole system first, then Saturn.
  await page.evaluate(() => orrery.ui.vr._onPanel('overview'));
  await frames(10);
  await page.evaluate(() => T.aimAtBody('right', 'saturn'));
  await frames();
  await press((v) => T.pinch('right', v));
  await frames(10);
  s = await state();
  assert(s.focus === 'saturn', `pinching at Saturn focused ${s.focus}`);

  // Pinch and drag: a grab, not a click.
  await page.evaluate(() => T.aimAtBody('right', 'titan'));
  await frames();
  const rigBefore = (await state()).rig;
  await page.evaluate(() => T.pinch('right', 1));
  await frames(2);
  await page.evaluate(() => T.move('right', 0.15, 0, 0, 'hand'));
  await frames();
  s = await state();
  assert(s.dragging.includes('right'), 'a moving pinch did not become a grab');
  await page.evaluate(() => T.pinch('right', 0));
  await frames(5);
  s = await state();
  assert(distance(rigBefore, s.rig) > 0.5, 'dragging a pinch did not move the world');
  assert(s.focus === 'saturn', `a dragged pinch still selected ${s.focus}`);

  // Both hands pinching and pulling apart scale the world.
  await page.evaluate(() => { T.resetHands(); T.aimAway('left'); T.aimAway('right'); });
  await frames(3);
  const handScale = (await state()).scale;
  await page.evaluate(() => { T.pinch('left', 1); T.pinch('right', 1); });
  await frames(2);
  await page.evaluate(() => { T.move('left', -0.12, 0, 0, 'hand'); T.move('right', 0.12, 0, 0, 'hand'); });
  await frames();
  await page.evaluate(() => { T.pinch('left', 0); T.pinch('right', 0); });
  await frames(3);
  s = await state();
  assert(s.scale < handScale * 0.8, `two-handed pinch left the scale at ${s.scale} (was ${handScale})`);

  // The left palm turned to the eyes brings the panel over; lowering it leaves it there.
  await page.evaluate(() => T.resetHands());
  await frames(3);
  const summoned = await page.evaluate(() => T.showPalm('left'));
  await frames(3);
  s = await state();
  assert(summoned > 0.7 && s.panelHolder === 'left', `turning the left palm to the eyes (${summoned.toFixed(2)}) did not bring the panel`);
  await shot('palm');
  await page.evaluate(() => T.resetHands());
  await frames(3);
  s = await state();
  assert(s.panelHolder === null && s.panelShown, 'the panel did not stay put when the palm turned away');

  // A fingertip pressed into a button presses it, once.
  const pausedHands = s.paused;
  await page.evaluate(() => T.pokeButton('right', 'pause', 0.03));
  await frames();
  s = await state();
  assert(s.panelHover === 'pause', `a fingertip over Pause hovered ${s.panelHover}`);
  assert(!s.lasers.right, 'the ray stayed on with a fingertip at the panel');
  await page.evaluate(() => T.pokeButton('right', 'pause', -0.01));
  await frames();
  await shot('poke');
  await page.evaluate(() => T.pokeButton('right', 'pause', -0.015));
  await frames();
  s = await state();
  assert(s.paused !== pausedHands, 'touching Pause with a fingertip did not toggle it');
  await page.evaluate(() => T.pokeButton('right', 'pause', 0.06));
  await frames();
  s = await state();
  assert(s.paused !== pausedHands, 'a fingertip resting on Pause pressed it more than once');

  /* --- leaving ------------------------------------------------------------- */

  await page.evaluate(() => T.pokeButton('right', 'exit', 0.05));
  await frames();
  await page.evaluate(() => T.pokeButton('right', 'exit', -0.01));
  // Out of VR the headset's frames stop, and so does the count.
  await page.waitForFunction(() => !orrery.ui.vr.active, { timeout: 30_000 }).catch(() => {});
  await sleep(1500);
  const after = await page.evaluate(() => ({
    active: orrery.ui.vr.active,
    focus: document.querySelector('.picker__label')?.textContent,
    pressed: document.querySelector('.topbar__vr').getAttribute('aria-pressed'),
    canvas: document.getElementById('viewport').width,
  }));
  assert(!after.active, 'Exit VR did not end the session');
  assert(after.pressed === 'false', 'the VR button still reads as pressed');
  assert(after.focus === 'Saturn', `back on the page focused on ${after.focus}, not Saturn`);
  assert(after.canvas > 0, 'the page canvas was not restored');
  await shot('exited');

  /* --- another star -------------------------------------------------------- */

  // Proxima's planets are lost in its 13,000 AU orbit round Alpha Centauri, so
  // the table is set around Proxima itself, and follows it; Whole system
  // re-centres on the barycentre.
  await page.goto(`${ORIGIN}/?debug&system=Proxima%20Cen`, { waitUntil: 'load', timeout: 60_000 });
  await waitForApp(page);
  await page.evaluate(() => window.__xr);
  await installHelpers(page);
  await page.click('.topbar__vr');
  await page.waitForFunction(() => orrery.ui.vr.presenting, { timeout: 30_000 });
  await frames(10);
  const table = () => page.evaluate(() => {
    const vr = orrery.ui.vr;
    const centre = vr._anchor?.group.position ?? vr.system.root.position;
    return { anchor: vr._anchor?.id ?? null, focus: vr.focus?.id ?? null, metres: vr.viewerPosition.distanceTo(centre) / vr.scale };
  });
  let exo = await table();
  assert(exo.anchor === 'star:Proxima Cen' && !exo.focus, `entered Proxima's VR view anchored on ${exo.anchor}`);
  assert(exo.metres < 5, `Proxima is ${exo.metres.toFixed(1)} m away, not on the table`);
  await shot('proxima');
  await page.evaluate(() => T.aimAtButton('right', 'overview'));
  await frames();
  await press((v) => T.button('right', 'trigger', v));
  await frames(20);
  exo = await table();
  assert(exo.anchor === null && exo.metres < 5, `Whole system did not re-centre the table (${exo.anchor}, ${exo.metres.toFixed(1)} m)`);
  await page.evaluate(() => orrery.ui.vr.end());
  await page.waitForFunction(() => !orrery.ui.vr.active, { timeout: 30_000 }).catch(() => {});
  await sleep(1000);
  const label = await page.evaluate(() => document.querySelector('.picker__label')?.textContent);
  assert(label === 'Whole system', `back on the page showing ${label}, not the whole system`);

  if (problems.length === 0) {
    console.log('vr: ok — controllers, hands, panel, palm, poke, recentre, exit and another star all behaved');
  } else {
    exitCode = 1;
    console.error(`vr: ${problems.length} problem(s)`);
    for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`);
  }
} catch (error) {
  exitCode = 1;
  console.error(`vr: ${error.stack ?? error.message}`);
  for (const problem of problems) console.error(`  - ${problem}`);
} finally {
  await browser.close();
  server?.kill();
}

process.exit(exitCode);

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * window.T: the emulated headset's controls, in the terms the checks need.
 * Positions given to the emulator are in the rig's own space, in metres;
 * anything aimed at lives in the scene, and is converted.
 */
function installHelpers(page) {
  return page.evaluate(() => {
    const { THREE } = window.orrery;
    const vr = orrery.ui.vr;
    const device = window.__device;
    const input = (side) => (device.primaryInputMode === 'hand' ? device.hands[side] : device.controllers[side]);
    const slot = (side) => vr.hands.find((hand) => hand.source?.handedness === side);
    const HOME = { left: [-0.2, 1.3, -0.35], right: [0.2, 1.3, -0.35] };

    // Counts frames drawn in the headset, so the checks can wait on those rather than the clock.
    window.__frames = 0;
    const update = vr.update.bind(vr);
    vr.update = (dt) => {
      window.__frames++;
      update(dt);
    };
    const nextFrames = (count) => new Promise((resolve) => {
      const until = window.__frames + count;
      const poll = () => (window.__frames >= until ? resolve() : setTimeout(poll, 20));
      poll();
    });

    const aimFrom = (side, from, world) => {
      const local = vr.rig.worldToLocal(world.clone());
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...from), local, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      const target = input(side);
      target.position.set(...from);
      target.quaternion.set(q.x, q.y, q.z, q.w);
    };

    window.T = {
      state() {
        const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(vr.camera.getWorldQuaternion(new THREE.Quaternion()));
        const toFocus = vr.focus ? vr.focus.group.position.clone().sub(vr.viewerPosition).normalize() : null;
        const byside = (fn) => Object.fromEntries(vr.hands.filter((h) => h.source).map((h) => [h.side, fn(h)]));
        return {
          focus: vr.focus?.id ?? null,
          scale: vr.scale,
          yaw: vr.yaw,
          rig: vr.rig.position.toArray(),
          paused: orrery.clock.paused,
          fade: vr._fade.material.opacity,
          vignette: vr._vignette.visible ? vr._vignette.material.uniforms.strength.value : 0,
          panelHolder: vr.panel.holder?.side ?? null,
          panelShown: Boolean(vr.panel.mesh.parent),
          panelHover: vr.panel._hover,
          hover: byside((h) => h.hoverId),
          lasers: byside((h) => h.laser.visible),
          dragging: vr.hands.filter((h) => h.pinch?.dragging).map((h) => h.side),
          handsMode: vr._describe().hands,
          standIns: vr.hands.filter((h) => h.grip.getObjectByName('vr-controller-stand-in')?.visible).length,
          focusAhead: toFocus ? ahead.dot(toFocus) : null,
        };
      },
      button: (side, id, value) => device.controllers[side].updateButtonValue(id, value),
      stick: (side, x, y) => device.controllers[side].updateAxes('thumbstick', x, y),
      pinch: (side, value) => device.hands[side].updatePinchValue(value),
      move(side, x, y, z) {
        const p = input(side).position;
        p.set(p.x + x, p.y + y, p.z + z);
      },
      resetHands() {
        for (const side of ['left', 'right']) {
          const target = input(side);
          target.position.set(...HOME[side]);
          target.quaternion.set(0, 0, 0, 1);
        }
      },
      /** Up and out, at nothing in particular. */
      aimAway: (side) => aimFrom(side, HOME[side], vr.rig.localToWorld(new THREE.Vector3(HOME[side][0] * 4, 4, -2))),
      aimAtBody: (side, id) => aimFrom(side, HOME[side], orrery.system.bodies.get(id).group.position),
      aimAtButton: (side, id) => aimFrom(side, HOME[side], vr.panel.buttonPosition(id)),
      turnHead(angle) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        device.quaternion.set(q.x, q.y, q.z, q.w);
      },

      /** Tries a handful of wrist turns and keeps whichever faces the palm most squarely at the eyes. */
      async showPalm(side) {
        const target = device.hands[side];
        target.position.set(-0.12, 1.4, -0.3);
        let best = { facing: -2, q: null };
        for (const [x, y, z] of [[0, 0, -90], [0, 0, 90], [90, 0, 0], [-90, 0, 0], [0, 90, -90], [0, -90, 90], [60, 0, -90], [-60, 0, 90]]) {
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z)));
          target.quaternion.set(q.x, q.y, q.z, q.w);
          await nextFrames(2);
          const facing = vr._palmFacing(slot(side), new THREE.Vector3());
          if (facing > best.facing) best = { facing, q };
        }
        target.quaternion.set(best.q.x, best.q.y, best.q.z, best.q.w);
        return best.facing;
      },

      /**
       * Puts a fingertip `depth` metres in front of a panel button (negative:
       * through it), by moving the whole hand, which keeps its pose.
       */
      pokeButton(side, id, depth) {
        const hand = slot(side);
        const tip = hand.hand.joints['index-finger-tip'];
        const button = vr.panel.buttonPosition(id);
        const normal = new THREE.Vector3(0, 0, 1).transformDirection(vr.panel.mesh.matrixWorld);
        const goal = vr.rig.worldToLocal(button.addScaledVector(normal, depth * vr.scale));
        const target = input(side);
        const offset = tip.position.clone().sub(new THREE.Vector3(target.position.x, target.position.y, target.position.z));
        target.position.set(goal.x - offset.x, goal.y - offset.y, goal.z - offset.z);
      },
    };
  });
}
