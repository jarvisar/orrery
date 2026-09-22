/**
 * Application entry point.
 *
 * Startup order matters here, and is the main reason the first few seconds feel
 * different from the previous build:
 *
 *   1. Build the scene graph with placeholder textures in every map slot.
 *   2. Stream in the Sun, planets and sky - and only those - behind the loading
 *      screen.
 *   3. Compile every shader program with `compileAsync` before the first frame
 *      is ever drawn.
 *   4. Start rendering, then keep loading moons, dwarf planets and detail maps
 *      in the background while the user is already flying around.
 *
 * Step 3 is what removes the multi-second lock-up that used to happen the first
 * time a given planet came into view. Shader compilation is synchronous and
 * blocking wherever it happens; doing it up front, off the critical frame, is
 * the only place it does not hurt.
 */

import * as THREE from 'three';

import { BODIES, BODY_BY_ID, EARTH_RADIUS_KM } from './data/bodies.js';
import { Viewport } from './core/Viewport.js';
import { AssetLoader } from './core/AssetLoader.js';
import { Settings } from './core/Settings.js';
import { Picker } from './core/Picker.js';
import { SolarSystem } from './scene/SolarSystem.js';
import { Orbits } from './scene/Orbits.js';
import { Belts } from './scene/Belts.js';
import { EARTH_RADIUS_UNITS } from './scene/scaling.js';
import { CameraDirector } from './camera/CameraDirector.js';
import { FlightControls } from './camera/FlightControls.js';
import { Clock } from './sim/Clock.js';
import { LoadingScreen } from './ui/LoadingScreen.js';
import { BodyPicker } from './ui/BodyPicker.js';
import { InfoPanel } from './ui/InfoPanel.js';
import { TimeBar } from './ui/TimeBar.js';
import { FlightHud } from './ui/FlightHud.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { HelpOverlay } from './ui/HelpOverlay.js';
import { Markers } from './ui/Markers.js';
import { el, icon } from './ui/dom.js';

/** Scene units to kilometres, using the body-size scale rather than the orbit scale. */
const KM_PER_UNIT = EARTH_RADIUS_KM / EARTH_RADIUS_UNITS;

boot().catch((error) => {
  console.error('[orrery] startup failed', error);
  document.getElementById('loading-status').textContent =
    'Something went wrong while starting up. Check the console for details.';
});

async function boot() {
  const canvas = document.getElementById('viewport');
  const loading = new LoadingScreen();

  if (!hasWebGL()) {
    document.getElementById('loading').remove();
    document.getElementById('unsupported').hidden = false;
    return;
  }

  const settings = new Settings();
  const clock = new Clock();
  const viewport = new Viewport(canvas);
  const { renderer, camera } = viewport;

  const scene = new THREE.Scene();
  const assets = new AssetLoader(renderer);
  const system = new SolarSystem(scene, assets);

  system.orbitExponent = settings.get('orbitSpacing');
  viewport.setAdaptiveResolution(settings.get('adaptiveResolution'));
  renderer.toneMappingExposure = settings.get('exposure');

  // --- scene ---------------------------------------------------------------
  loading.begin('catalogue', 'Reading the catalogue…');
  await system.build();
  system.setShadowQuality(settings.get('shadowQuality'));
  viewport.setShadowsEnabled(settings.get('shadowQuality') > 0);

  loading.begin('textures', 'Loading the Sun and planets…');
  assets.texture('stars_milkyway', 'map', -1).then((texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;
    scene.backgroundIntensity = 0.42;
  });

  await assets.drain({
    concurrency: 6,
    maxPriority: 5, // the star, the planets, and their own detail maps
    onProgress: (loaded, total, name) =>
      loading.progress(loaded / total, `Loading ${prettyName(name)}…`),
  });

  loading.begin('models', 'Loading models…');
  await Promise.allSettled([assets.model('phobos'), assets.model('deimos'), assets.model('ufo')]);

  // --- everything that depends on a finished body list ---------------------
  loading.begin('scene', 'Plotting orbits…');
  const orbits = new Orbits(scene, system);
  orbits.build();
  orbits.setVisible(settings.get('showOrbits'));

  const belts = new Belts(scene, system);
  belts.build(settings.get('beltDensity'));
  belts.setVisible(settings.get('showBelts'));

  const ship = await buildShip(assets, scene);

  system.setCategoryVisible('moon', settings.get('showMoons'));
  system.setCategoryVisible('dwarf', settings.get('showDwarfs'));
  orbits.syncVisibility();

  system.update(clock.days);
  orbits.update(camera.position);
  belts.update(clock.days);

  const director = new CameraDirector(camera, canvas, system);
  const flight = new FlightControls(camera, canvas);
  flight.maxSpeed = 450;
  flight.boostFactor = 12;

  const picker = new Picker(canvas, camera, system);

  viewport.onResize((size) => orbits.setResolution(size.x, size.y));

  // --- warm the pipeline ---------------------------------------------------
  loading.begin('shaders', 'Compiling shaders…');
  director.focusOn(system.bodies.get(initialBodyId()), { instant: true });
  await renderer.compileAsync(scene, camera);
  assets.pumpUploads(999);

  // --- interface -----------------------------------------------------------
  const ui = buildInterface({
    settings, clock, scene, assets, system, orbits, belts,
    director, flight, picker, viewport, ship,
  });
  ui.selectBody(initialBodyId(), { instant: true });
  ui.markers.update(viewport.width, viewport.height);

  // Draw and start animating *underneath* the loading screen, so the fade
  // uncovers a live scene rather than a black canvas.
  renderer.render(scene, camera);
  startLoop({
    viewport, scene, system, orbits, belts,
    director, flight, picker, clock, assets, ui, ship,
  });

  document.getElementById('ui').hidden = false;
  await loading.finish();

  // Everything still queued is a moon or a dwarf planet; it streams in while
  // the user is already looking around.
  await assets.drain({ concurrency: 4 });
  // One more compile pass, in case a streamed model brought its own materials.
  await renderer.compileAsync(scene, camera).catch(() => {});
}

/* ========================================================================== */
/*  Interface wiring                                                           */
/* ========================================================================== */

function buildInterface(ctx) {
  const { settings, clock, scene, assets, system, orbits, belts,
          director, flight, picker, viewport, ship } = ctx;
  const root = document.getElementById('ui');
  const camera = viewport.camera;

  const bodyPicker = new BodyPicker((id) => selectBody(id));
  const infoPanel = new InfoPanel();
  const timeBar = new TimeBar(clock);
  const flightHud = new FlightHud(flight);
  const settingsPanel = new SettingsPanel(settings);
  const helpOverlay = new HelpOverlay();
  const markers = new Markers(system, camera, (id) => selectBody(id));
  markers.setEnabled(settings.get('showLabels'));

  const tooltip = el('div', { class: 'tooltip panel' });
  const stats = el('div', { class: 'stats panel', hidden: true });

  const flightButton = el(
    'button',
    {
      class: 'btn btn--icon',
      type: 'button',
      title: 'Flight mode (G)',
      'aria-label': 'Flight mode',
      'aria-pressed': 'false',
      onclick: () => setFlight(!state.flying),
    },
    [icon('rocket')]
  );

  const topbar = el('div', { class: 'topbar' }, [
    el('div', { class: 'topbar__group' }, [
      el('div', { class: 'brand' }, [
        el('span', { class: 'brand__name', text: 'Orrery' }),
        el('span', { class: 'brand__tag', text: 'Solar system explorer' }),
      ]),
    ]),
    bodyPicker.root,
    el('div', { class: 'topbar__group' }, [
      flightButton,
      el(
        'button',
        {
          class: 'btn btn--icon',
          type: 'button',
          title: 'Controls (?)',
          'aria-label': 'Controls',
          onclick: () => helpOverlay.toggle(),
        },
        [icon('help')]
      ),
      el(
        'button',
        {
          class: 'btn btn--icon',
          type: 'button',
          title: 'Settings',
          'aria-label': 'Settings',
          onclick: () => settingsPanel.toggle(),
        },
        [icon('settings')]
      ),
    ]),
  ]);

  root.append(topbar, infoPanel.root, timeBar.root);
  document.body.append(
    markers.root, flightHud.root, tooltip, stats, settingsPanel.root, helpOverlay.root
  );

  const state = { flying: false, focusedId: null, showStats: false };

  /* --- focus ------------------------------------------------------------- */

  function selectBody(id, { instant = false } = {}) {
    if (state.flying) setFlight(false, { refocus: false });

    const view = id ? system.bodies.get(id) : null;
    if (id && !view) return;

    state.focusedId = id;
    director.focusOn(view, { instant: instant || settings.get('reduceMotion') });
    bodyPicker.select(id);
    infoPanel.show(view);
    orbits.setFocus(id);
    markers.setFocus(id);
    system.focusShadows(view);

    // Anything still queued for this body jumps the line, so focusing a moon
    // that has not streamed in yet fetches it next rather than in catalogue order.
    if (view) assets.promote(collectTextureNames(view.body));

    const url = new URL(window.location.href);
    if (id) url.searchParams.set('body', id);
    else url.searchParams.delete('body');
    url.searchParams.delete('planet');
    window.history.replaceState(null, '', url);
  }

  function stepBody(delta) {
    const available = BODIES.filter((body) => system.isVisible(body.id));
    if (available.length === 0) return;
    const index = available.findIndex((body) => body.id === state.focusedId);
    const next = available[(index + delta + available.length) % available.length];
    selectBody(next.id);
  }

  /* --- flight ------------------------------------------------------------ */

  function setFlight(enabled, { refocus = true } = {}) {
    if (enabled === state.flying) return;
    state.flying = enabled;

    flight.setEnabled(enabled);
    flight.reset();
    director.setEnabled(!enabled);
    picker.setEnabled(!enabled);
    flightHud.setActive(enabled);
    markers.setFocus(null);
    flightButton.setAttribute('aria-pressed', String(enabled));
    flightButton.classList.toggle('is-active', enabled);
    ship.group.visible = !enabled;

    if (enabled) {
      director.focusOn(null);
      bodyPicker.select(null);
      infoPanel.show(null);
      orbits.setFocus(null);
      state.focusedId = null;
      hideTooltip();
    } else if (refocus) {
      const nearest = director.nearestBody(camera.position);
      if (nearest) selectBody(nearest.id);
    }
  }

  /* --- hover tooltip ----------------------------------------------------- */

  picker.onSelect((id) => selectBody(id));
  picker.onHover((id, x, y) => {
    if (!id || !settings.get('showLabels')) return hideTooltip();
    tooltip.textContent = BODY_BY_ID.get(id)?.name ?? '';
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.classList.add('is-visible');
  });

  function hideTooltip() { tooltip.classList.remove('is-visible'); }

  /* --- settings ---------------------------------------------------------- */

  settings.on('showOrbits', (value) => orbits.setVisible(value));
  settings.on('showBelts', (value) => belts.setVisible(value));
  settings.on('showLabels', (value) => {
    markers.setEnabled(value);
    if (!value) hideTooltip();
  });
  settings.on('adaptiveResolution', (value) => viewport.setAdaptiveResolution(value));
  settings.on('exposure', (value) => { viewport.renderer.toneMappingExposure = value; });
  settings.on('reduceMotion', (value) => document.body.classList.toggle('reduce-motion', value));
  document.body.classList.toggle('reduce-motion', settings.get('reduceMotion'));

  settings.on('showMoons', (value) => {
    system.setCategoryVisible('moon', value);
    orbits.syncVisibility();
    bodyPicker.setCategoryVisible('moon', value);
    if (!value && isKind(state.focusedId, 'moon')) {
      selectBody(BODY_BY_ID.get(state.focusedId)?.parent ?? 'sun');
    }
  });

  settings.on('showDwarfs', (value) => {
    system.setCategoryVisible('dwarf', value);
    orbits.syncVisibility();
    bodyPicker.setCategoryVisible('dwarf', value);
    if (!value && isKind(state.focusedId, 'dwarf')) selectBody('sun');
  });

  settings.on('orbitSpacing', debounce((value) => {
    system.orbitExponent = value;
    system.update(clock.days);
    orbits.rescale();
    belts.rescale();
    if (state.focusedId) director.focusOn(system.bodies.get(state.focusedId), { instant: true });
  }, 120));

  settings.on('beltDensity', debounce((value) => belts.build(value), 200));

  settings.on('shadowQuality', (value) => {
    system.setShadowQuality(value);
    viewport.setShadowsEnabled(value > 0);
    // Turning shadows on or off changes every material's program. Recompiling
    // here, off the critical frame, keeps it from surfacing as a stall later.
    viewport.renderer.compileAsync(scene, camera).catch(() => {});
  });

  /* --- keyboard ---------------------------------------------------------- */

  window.addEventListener('keydown', (event) => {
    if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

    // Flight mode owns WASD, Shift and Space while it is active.
    const flightOwns = state.flying &&
      ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code);
    if (flightOwns) return;

    switch (event.code) {
      case 'Escape':
        if (settingsPanel.isOpen) settingsPanel.close();
        else if (helpOverlay.isOpen) helpOverlay.close();
        else if (state.flying) setFlight(false);
        else selectBody(null);
        break;
      case 'Space': event.preventDefault(); timeBar.togglePause(); break;
      case 'Comma': timeBar.stepRate(-1); break;
      case 'Period': timeBar.stepRate(1); break;
      case 'KeyR': timeBar.toggleDirection(); break;
      case 'KeyN': clock.jumpToNow(); timeBar.refresh(); break;
      case 'KeyG': setFlight(!state.flying); break;
      case 'BracketLeft': stepBody(-1); break;
      case 'BracketRight': stepBody(1); break;
      case 'KeyF':
        if (state.focusedId) director.focusOn(system.bodies.get(state.focusedId));
        break;
      case 'KeyO': settings.set('showOrbits', !settings.get('showOrbits')); break;
      case 'KeyI': infoPanel.setCollapsed(!infoPanel.collapsed); break;
      case 'KeyP':
        state.showStats = !state.showStats;
        stats.hidden = !state.showStats;
        break;
      case 'Slash':
        if (event.shiftKey) { event.preventDefault(); helpOverlay.toggle(); }
        break;
      default: break;
    }
  });

  installKonamiCode();

  return {
    state, stats, tooltip, timeBar, infoPanel, flightHud, bodyPicker, markers,
    selectBody, setFlight, hideTooltip,
  };
}

/* ========================================================================== */
/*  Frame loop                                                                 */
/* ========================================================================== */

function startLoop(ctx) {
  const { viewport, scene, system, orbits, belts, director, flight, picker, clock, assets, ui, ship } = ctx;
  const { renderer, camera } = viewport;

  let lastFrame = performance.now();
  let sinceUiUpdate = 0;
  let sinceStats = 0;
  let frames = 0;

  renderer.setAnimationLoop(() => {
    // Clamp so returning to a backgrounded tab does not jump the simulation
    // forward by however long it was hidden.
    const now = performance.now();
    const rawDelta = (now - lastFrame) / 1000;
    lastFrame = now;
    const dt = Math.min(rawDelta, 0.1);

    clock.advance(dt);
    system.update(clock.days);
    orbits.update(camera.position);
    belts.update(clock.days);

    if (ui.state.flying) {
      flight.update(dt);
      ui.flightHud.update(Math.abs(flight.speed) * KM_PER_UNIT / 1000);
    } else {
      director.update(dt);
      picker.update();
      ship.update(dt, director.focus);
    }

    ui.markers.update(viewport.width, viewport.height);
    assets.pumpUploads(2);
    renderer.render(scene, camera);

    // Interface readouts change slowly; four times a second is plenty and keeps
    // text layout off the critical path.
    frames++;
    sinceUiUpdate += dt;
    sinceStats += dt;
    if (sinceUiUpdate > 0.25) {
      ui.timeBar.tick();
      ui.infoPanel.updateLive(clock.days);
      if (director.focus && !director.isTransitioning) system.focusShadows(director.focus);
      sinceUiUpdate = 0;
    }
    if (ui.state.showStats && sinceStats > 0.5) {
      const info = renderer.info.render;
      ui.stats.textContent =
        `${Math.round(frames / sinceStats)} fps · ${info.calls} draws · ` +
        `${(info.triangles / 1000).toFixed(0)}k tris · ${(viewport.renderScale * 100).toFixed(0)}% scale` +
        (assets.pending ? ` · ${assets.pending} loading` : '');
      sinceStats = 0;
      frames = 0;
    } else if (sinceStats > 0.5) {
      sinceStats = 0;
      frames = 0;
    }

    viewport.sample(rawDelta * 1000);
  });
}

/* ========================================================================== */
/*  Odds and ends                                                              */
/* ========================================================================== */

/**
 * The UFO from the original build, kept as a landmark. It parks above whatever
 * body you are looking at instead of being teleported inside the Sun to hide it.
 */
async function buildShip(assets, scene) {
  const group = new THREE.Group();
  group.name = 'ship';
  scene.add(group);

  const light = new THREE.PointLight(0x3cd070, 6, 260, 2);
  light.position.set(0, -14, 0);
  group.add(light);

  try {
    const model = (await assets.model('ufo')).clone(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(26 / Math.max(size.x, size.y, size.z));
    model.traverse((child) => { if (child.isMesh) child.userData.bodyId = null; });
    group.add(model);
  } catch (error) {
    console.warn('[orrery] the ship model failed to load', error);
  }

  const offset = new THREE.Vector3();
  return {
    group,
    // Spun on the wall clock rather than simulated time, so it does not turn
    // into a strobe when the time rate is wound up.
    update(dt, focus) {
      group.rotation.y += dt * 0.5;
      if (!focus) return;
      offset.set(0, focus.radius * 1.9 + 26, 0);
      group.position.lerp(offset.add(focus.group.position), 1 - Math.exp(-4 * dt));
    },
  };
}

function initialBodyId() {
  const params = new URLSearchParams(window.location.search);
  // ?planet= was the old parameter; keep old links working.
  const requested = params.get('body') ?? params.get('planet');
  return requested && BODY_BY_ID.has(requested) ? requested : 'earth';
}

function prettyName(textureName) {
  const base = textureName.replace(/_(bump|specular|night|clouds|atmosphere|rings)$/, '');
  return BODY_BY_ID.get(base)?.name ?? base.replace(/_/g, ' ');
}

/** Every texture a body will eventually need, across all of its map slots. */
function collectTextureNames(body) {
  return [
    ...Object.values(body.textures ?? {}),
    body.clouds?.alphaMap, body.clouds?.map,
    body.atmosphere?.map, body.atmosphere?.alphaMap,
    body.rings?.map,
  ].filter(Boolean);
}

function isKind(id, kind) {
  return Boolean(id && BODY_BY_ID.get(id)?.kind === kind);
}

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    // Browsers cap how many live contexts a page may hold, and this probe runs
    // before the real one is created. Hand it straight back.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(gl);
  } catch {
    return false;
  }
}

function isTypingTarget(target) {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Inherited from the original. Still here, still undocumented. */
function installKonamiCode() {
  const sequence = [
    'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA',
  ];
  let index = 0;
  window.addEventListener('keydown', (event) => {
    index = event.code === sequence[index] ? index + 1 : 0;
    if (index === sequence.length) window.location.href = 'tetris.html';
  });
}
