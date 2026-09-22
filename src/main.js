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
import { Post } from './core/Post.js';
import { SolarSystem } from './scene/SolarSystem.js';
import { Orbits } from './scene/Orbits.js';
import { Belts } from './scene/Belts.js';
import { Sky } from './scene/Sky.js';
import { EARTH_RADIUS_UNITS } from './scene/scaling.js';
import { CameraDirector } from './camera/CameraDirector.js';
import { FlightControls } from './camera/FlightControls.js';
import { Clock } from './sim/Clock.js';
import { daysSinceJ2000, dateFromDays } from './sim/kepler.js';
import { LoadingScreen } from './ui/LoadingScreen.js';
import { BodyPicker } from './ui/BodyPicker.js';
import { InfoPanel } from './ui/InfoPanel.js';
import { TimeBar } from './ui/TimeBar.js';
import { FlightHud } from './ui/FlightHud.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { HelpOverlay } from './ui/HelpOverlay.js';
import { Markers } from './ui/Markers.js';
import { TourGuide } from './ui/TourGuide.js';
import { el, icon } from './ui/dom.js';

/** Scene units to kilometres, using the body-size scale rather than the orbit scale. */
const KM_PER_UNIT = EARTH_RADIUS_KM / EARTH_RADIUS_UNITS;

/** The one thing in the scene that is not in the catalogue. */
const VISITOR_ID = 'visitor';

/** Framing, in AU, for the whole-system view: Neptune with a little room. */
const OVERVIEW_AU = 33;

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
  const startDays = initialDays();
  if (startDays !== null) clock.travelTo(startDays, { instant: true });

  const viewport = new Viewport(canvas);
  const { renderer, camera } = viewport;

  const scene = new THREE.Scene();
  const assets = new AssetLoader(renderer);
  const system = new SolarSystem(scene, assets);

  system.scaleExponent = settings.get('scale');
  viewport.setAdaptiveResolution(settings.get('adaptiveResolution'));
  renderer.toneMappingExposure = settings.get('exposure');

  // --- scene ---------------------------------------------------------------
  loading.begin('catalogue', 'Reading the catalogue…');
  await system.build();
  system.setShadowQuality(settings.get('shadowQuality'));
  viewport.setShadowsEnabled(settings.get('shadowQuality') > 0);

  loading.begin('textures', 'Loading the Sun and planets…');
  const sky = new Sky(scene, assets);
  const starsLoaded = sky.load();

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

  const visitor = await buildVisitor(assets, scene, system);

  system.setCategoryVisible('moon', settings.get('showMoons'));
  system.setCategoryVisible('dwarf', settings.get('showDwarfs'));
  orbits.syncVisibility();

  system.update(clock.days);
  orbits.update(camera.position, clock.days);
  belts.update(clock.days);

  const director = new CameraDirector(camera, canvas, system);
  const flight = new FlightControls(camera, canvas);
  flight.maxSpeed = 450;
  flight.boostFactor = 12;

  const picker = new Picker(canvas, camera, system);
  picker.addSelectable(VISITOR_ID, visitor.meshes);

  const post = new Post(renderer, scene, camera);
  post.setEnabled(settings.get('effects'));
  viewport.onResize((size, view) => {
    orbits.setResolution(size.x, size.y);
    post.setSize(view.width, view.height, view.pixelRatio);
    sky.setPixelRatio(view.pixelRatio);
  });

  // --- warm the pipeline ---------------------------------------------------
  loading.begin('shaders', 'Compiling shaders…');
  director.focusOn(system.bodies.get(initialBodyId()), { instant: true });
  await starsLoaded;
  await renderer.compileAsync(scene, camera);
  assets.pumpUploads(999);

  // --- interface -----------------------------------------------------------
  const ui = buildInterface({
    settings, clock, scene, assets, system, orbits, belts,
    director, flight, picker, viewport, visitor, post,
  });
  ui.selectBody(initialBodyId(), { instant: true });
  ui.markers.update(viewport.width, viewport.height);

  // Draw and start animating *underneath* the loading screen, so the fade
  // uncovers a live scene rather than a black canvas.
  post.render(0);
  startLoop({
    viewport, system, orbits, belts, director, flight, picker, clock, assets, ui, visitor, post,
  });

  // For poking at the scene from the console: ?debug exposes the internals.
  if (new URLSearchParams(window.location.search).has('debug')) {
    window.orrery = { THREE, scene, camera, renderer, system, orbits, belts, sky, post, director, clock, ui };
  }

  document.getElementById('ui').hidden = false;
  await loading.finish();
  ui.welcome();

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
          director, flight, picker, viewport, visitor, post } = ctx;
  const root = document.getElementById('ui');
  const camera = viewport.camera;
  const reduceMotion = () => settings.get('reduceMotion');

  const state = { flying: false, focusedId: null, showStats: false, touring: false };

  /** A catalogue body's view, or the one visitor that is not in the catalogue. */
  const lookup = (id) => (id === VISITOR_ID ? visitor.view : system.bodies.get(id));

  const bodyPicker = new BodyPicker({
    onSelect: (id) => selectBody(id),
    onOverview: () => showOverview(),
  });
  // On a phone the panel would cover the body it describes; start it folded.
  const infoPanel = new InfoPanel({
    collapsed: window.matchMedia('(max-width: 720px)').matches,
    onSelect: (id) => selectBody(id),
    isVisible: (id) => system.isVisible(id),
    elementsOf: (id) => system.bodies.get(id)?.elements,
  });
  const timeBar = new TimeBar(clock, {
    onJump: (days, moment) => travelTo(days, moment),
    onNow: () => {
      clock.jumpToNow({ instant: reduceMotion() });
      setUrlTime(null);
    },
    onCopyLink: () => copyLink(),
  });
  const flightHud = new FlightHud(flight);
  const settingsPanel = new SettingsPanel(settings);
  const helpOverlay = new HelpOverlay();
  const markers = new Markers(system, camera, (id) => selectBody(id));
  markers.setEnabled(settings.get('showLabels'));

  const tours = new TourGuide({
    visit: (id, { duration, instant }) => selectBody(id, { fromTour: true, duration, instant }),
    onChange: (touring) => {
      state.touring = touring;
      root.classList.toggle('is-touring', touring);
      director.setAutoRotate(touring && !reduceMotion());
      if (!touring) infoPanel.show(lookup(state.focusedId) ?? null);
    },
    reduceMotion,
    canVisit: (id) => system.isVisible(id),
  });

  const tooltip = el('div', { class: 'tooltip panel' });
  const stats = el('div', { class: 'stats panel', hidden: true });
  const hint = el('div', { class: 'hint panel', hidden: true });

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

  const brand = el(
    'button',
    {
      class: 'brand',
      type: 'button',
      title: 'The whole system (H)',
      'aria-label': 'Orrery - show the whole system',
      onclick: () => showOverview(),
    },
    [brandMark(), el('span', { class: 'brand__word', text: 'Orrery' })]
  );

  const topbar = el('div', { class: 'topbar' }, [
    brand,
    bodyPicker.root,
    el('div', { class: 'topbar__end' }, [
      el('div', { class: 'topbar__group topbar__actions panel' }, [
        tours.root,
        el('span', { class: 'topbar__divider', 'aria-hidden': 'true' }),
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
    ]),
  ]);

  root.append(topbar, infoPanel.root, tours.caption, timeBar.root);
  document.body.append(
    markers.root, flightHud.root, tooltip, stats, hint, settingsPanel.root, helpOverlay.root
  );

  /* --- focus ------------------------------------------------------------- */

  function selectBody(id, { instant = false, fromTour = false, duration } = {}) {
    if (state.flying) setFlight(false, { refocus: false });
    if (!fromTour) tours.stop();

    const view = id ? lookup(id) : null;
    if (id && !view) return;

    state.focusedId = id;
    director.focusOn(view, { instant: instant || reduceMotion(), duration });
    bodyPicker.select(id, view?.body);
    if (!state.touring) infoPanel.show(view);
    orbits.setFocus(id);
    markers.setFocus(id);
    system.focusShadows(view);
    dismissHint();

    // Anything still queued for this body jumps the line, so focusing a moon
    // that has not streamed in yet fetches it next rather than in catalogue order.
    if (view) assets.promote(collectTextureNames(view.body));

    // The visitor is not something to link to. It has to be found.
    if (id !== VISITOR_ID) setUrlBody(id);
  }

  function showOverview(radiusAU = OVERVIEW_AU, { instant = false } = {}) {
    if (state.flying) setFlight(false, { refocus: false });
    tours.stop();
    state.focusedId = null;
    director.overview(radiusAU, { instant: instant || reduceMotion() });
    bodyPicker.select(null, { name: 'Whole system' });
    infoPanel.show(null);
    orbits.setFocus(null);
    markers.setFocus(null);
    setUrlBody(null);
  }

  function stepBody(delta) {
    const available = BODIES.filter((body) => system.isVisible(body.id));
    if (available.length === 0) return;
    const index = available.findIndex((body) => body.id === state.focusedId);
    // From free view, [ and ] start at either end of the list.
    const start = index < 0 ? (delta > 0 ? -1 : 0) : index;
    const next = available[(start + delta + available.length) % available.length];
    selectBody(next.id);
  }

  /* --- time -------------------------------------------------------------- */

  function travelTo(days, moment) {
    clock.travelTo(days, { instant: reduceMotion() });
    setUrlTime(days);
    if (moment?.view.body) selectBody(moment.view.body);
    else if (moment?.view.overview) showOverview(moment.view.overview);
    timeBar.refresh();
  }

  /** The current view as a link: body and simulated time, to the minute. */
  async function copyLink() {
    const url = new URL(window.location.href);
    url.searchParams.set('t', isoMinute(dateFromDays(clock.days)));
    if (state.focusedId && state.focusedId !== VISITOR_ID) url.searchParams.set('body', state.focusedId);
    await navigator.clipboard.writeText(url.toString());
  }

  /* --- flight ------------------------------------------------------------ */

  function setFlight(enabled, { refocus = true } = {}) {
    if (enabled === state.flying) return;
    state.flying = enabled;
    if (enabled) tours.stop();

    flight.setEnabled(enabled);
    flight.reset();
    director.setEnabled(!enabled);
    picker.setEnabled(!enabled);
    flightHud.setActive(enabled);
    markers.setFocus(null);
    flightButton.setAttribute('aria-pressed', String(enabled));
    flightButton.classList.toggle('is-active', enabled);

    if (!enabled) {
      const nearest = director.nearestBody(camera.position);
      director.syncTargetToView(nearest ? camera.position.distanceTo(nearest.group.position) : 100);
    }

    if (enabled) {
      director.focusOn(null);
      bodyPicker.select(null);
      infoPanel.show(null);
      orbits.setFocus(null);
      state.focusedId = null;
      hideTooltip();
      dismissHint();
    } else if (refocus) {
      const nearest = director.nearestBody(camera.position);
      if (nearest) selectBody(nearest.id);
    }
  }

  /* --- hover tooltip ----------------------------------------------------- */

  picker.onSelect((id) => selectBody(id));
  picker.onHover((id, x, y) => {
    if (!id || !settings.get('showLabels')) return hideTooltip();
    tooltip.textContent = lookup(id)?.body.name ?? '';
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.classList.add('is-visible');
  });

  function hideTooltip() { tooltip.classList.remove('is-visible'); }

  /* --- first visit ------------------------------------------------------- */

  let hintTimer = 0;
  function welcome() {
    if (readFlag('orrery:welcomed') || state.touring) return;
    writeFlag('orrery:welcomed');
    const touch = window.matchMedia('(pointer: coarse)').matches;
    hint.replaceChildren(
      el('span', { text: 'Drag to look around' }),
      el('span', { class: 'hint__dot', 'aria-hidden': 'true' }),
      el('span', { text: touch ? 'Pinch to zoom' : 'Scroll to zoom' }),
      el('span', { class: 'hint__dot', 'aria-hidden': 'true' }),
      el('span', { text: touch ? 'Tap a planet to visit it' : 'Click a planet to visit it' }),
    );
    hint.hidden = false;
    requestAnimationFrame(() => hint.classList.add('is-visible'));
    hintTimer = setTimeout(dismissHint, 9000);
    // Anything at all - a drag, a click on a panel, a key - means it has been read.
    window.addEventListener('pointerdown', dismissHint, { once: true, capture: true });
    window.addEventListener('keydown', dismissHint, { once: true, capture: true });
  }

  function dismissHint() {
    if (hint.hidden) return;
    clearTimeout(hintTimer);
    hint.classList.remove('is-visible');
    setTimeout(() => { hint.hidden = true; }, 400);
  }

  /* --- settings ---------------------------------------------------------- */

  settings.on('showOrbits', (value) => orbits.setVisible(value));
  settings.on('showBelts', (value) => belts.setVisible(value));
  settings.on('showLabels', (value) => {
    markers.setEnabled(value);
    if (!value) hideTooltip();
  });
  settings.on('adaptiveResolution', (value) => viewport.setAdaptiveResolution(value));
  settings.on('exposure', (value) => { viewport.renderer.toneMappingExposure = value; });
  settings.on('effects', (value) => post.setEnabled(value));
  settings.on('reduceMotion', (value) => {
    document.body.classList.toggle('reduce-motion', value);
    director.setAutoRotate(state.touring && !value);
  });
  document.body.classList.toggle('reduce-motion', settings.get('reduceMotion'));

  settings.on('showMoons', (value) => {
    system.setCategoryVisible('moon', value);
    orbits.syncVisibility();
    bodyPicker.setCategoryVisible('moon', value);
    infoPanel.refreshSystem();
    if (!value && (isKind(state.focusedId, 'moon') || state.focusedId === VISITOR_ID)) {
      selectBody(BODY_BY_ID.get(state.focusedId)?.parent ?? 'earth');
    }
  });

  settings.on('showDwarfs', (value) => {
    system.setCategoryVisible('dwarf', value);
    orbits.syncVisibility();
    bodyPicker.setCategoryVisible('dwarf', value);
    infoPanel.refreshSystem();
    if (!value && isKind(state.focusedId, 'dwarf')) selectBody('sun');
  });

  settings.on('scale', debounce((value) => {
    system.setScaleExponent(value);
    director.setScaleExponent(value);
    system.update(clock.days);
    orbits.rescale();
    belts.rescale();
    if (state.focusedId) director.focusOn(lookup(state.focusedId), { instant: true });
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
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // In a text field every key is typing - except Escape, which still closes things.
    if (isTypingTarget(event.target) && event.code !== 'Escape') return;

    // The controls dialog is modal: while it is up, only the keys that close it count.
    if (helpOverlay.isOpen && event.code !== 'Escape' && event.code !== 'Slash') return;

    // Flight mode owns WASD, Shift and Space while it is active.
    const flightOwns = state.flying &&
      ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code);
    if (flightOwns) return;

    switch (event.code) {
      // The one place Escape is handled, so closing a panel never also drops focus.
      case 'Escape':
        if (bodyPicker.isOpen) bodyPicker.close({ restoreFocus: true });
        else if (tours.isOpen) tours.closeMenu({ restoreFocus: true });
        else if (timeBar.isOpen) timeBar.close({ restoreFocus: true });
        else if (helpOverlay.isOpen) helpOverlay.close();
        else if (settingsPanel.isOpen) settingsPanel.close();
        else if (state.touring) tours.stop();
        else if (state.flying) setFlight(false);
        else selectBody(null);
        break;
      case 'Space': event.preventDefault(); timeBar.togglePause(); break;
      case 'Comma': timeBar.stepRate(-1); break;
      case 'Period': timeBar.stepRate(1); break;
      case 'KeyR': timeBar.toggleDirection(); break;
      case 'KeyN': timeBar.jumpToNow(); break;
      case 'KeyG': setFlight(!state.flying); break;
      case 'KeyH': showOverview(); break;
      case 'KeyT': tours.toggleMenu(); break;
      case 'ArrowLeft': if (state.touring) tours.step(-1); break;
      case 'ArrowRight': if (state.touring) tours.step(1); break;
      case 'BracketLeft': stepBody(-1); break;
      case 'BracketRight': stepBody(1); break;
      case 'KeyF':
        if (state.focusedId) director.focusOn(lookup(state.focusedId));
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
    state, stats, tooltip, timeBar, infoPanel, flightHud, bodyPicker, markers, tours,
    selectBody, setFlight, hideTooltip, welcome,
  };
}

/* ========================================================================== */
/*  Frame loop                                                                 */
/* ========================================================================== */

function startLoop(ctx) {
  const { viewport, system, orbits, belts, director, flight, picker, clock, assets, ui, visitor, post } = ctx;
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
    renderer.info.reset();

    clock.advance(dt);
    system.update(clock.days);
    orbits.update(camera.position, clock.days);
    belts.update(clock.days);
    visitor.update(dt);
    ui.tours.update(dt);

    if (ui.state.flying) {
      flight.update(dt);
      director.fitClippingToSurroundings();
      ui.flightHud.update(Math.abs(flight.speed) * KM_PER_UNIT / 1000);
    } else {
      director.update(dt);
      picker.update();
    }

    ui.markers.update(viewport.width, viewport.height);
    assets.pumpUploads(2);
    post.render(dt);

    // Interface readouts change slowly; four times a second is plenty and keeps
    // text layout off the critical path. A jump through time is the exception:
    // the date should visibly spin.
    frames++;
    sinceUiUpdate += dt;
    sinceStats += dt;
    if (clock.isTravelling) ui.timeBar.tick();
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
 * The UFO from the original build. It used to hover over whichever planet you
 * were looking at, which on a first visit read as a rendering bug. Now it keeps
 * to itself: a small, slow orbit around the Moon, there for anyone who looks
 * closely enough - and clickable, for anyone who wants to know what it is.
 */
async function buildVisitor(assets, scene, system) {
  const group = new THREE.Group();
  group.name = VISITOR_ID;
  scene.add(group);

  const meshes = [];
  try {
    const model = (await assets.model('ufo')).clone(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    model.position.sub(centre);
    const holder = new THREE.Group();
    holder.add(model);
    holder.scale.setScalar(3.2 / Math.max(size.x, size.y, size.z));
    model.traverse((child) => {
      if (!child.isMesh) return;
      child.userData.bodyId = VISITOR_ID;
      meshes.push(child);
    });
    group.add(holder);
  } catch (error) {
    console.warn('[orrery] the visitor failed to load', error);
  }

  const view = {
    id: VISITOR_ID,
    name: 'Unidentified',
    kind: 'visitor',
    group,
    radius: 1.6,
    get boundingRadius() { return 1.6; },
    elements: null,
    body: {
      id: VISITOR_ID,
      name: 'Unidentified',
      kind: 'visitor',
      color: '#8fe3b0',
      blurb:
        'Not in any catalogue. It has been in this model since the first version, and ' +
        'nobody has managed to explain it. Lately it has taken an interest in the Moon.',
      facts: {
        Designation: 'None',
        Origin: 'Unknown',
        'First seen': 'Version 1 of this site',
        Orbit: 'The Moon, for reasons of its own',
      },
    },
  };

  const moon = system.bodies.get('moon');
  const offset = new THREE.Vector3();
  let angle = 0;
  let clock = 0;

  return {
    view,
    meshes,
    // On the wall clock rather than simulated time, so it neither freezes when
    // time is paused nor turns into a strobe at ten years a second.
    update(dt) {
      group.visible = Boolean(moon?.visible);
      if (!moon || !group.visible) return;
      clock += dt;
      angle += dt * 0.16;
      const reach = moon.radius * 2.1;
      offset.set(Math.cos(angle) * reach, Math.sin(angle * 0.7) * reach * 0.35, Math.sin(angle) * reach);
      group.position.copy(moon.group.position).add(offset);
      group.rotation.set(Math.sin(clock * 0.9) * 0.12, clock * 0.8, Math.cos(clock * 0.7) * 0.1);
    },
  };
}

/** The wordmark's glyph: a Sun and one planet on its orbit. */
function brandMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('class', 'brand__mark');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<circle cx="10" cy="10" r="7.25" class="brand__orbit"/>' +
    '<circle cx="10" cy="10" r="2.4" class="brand__sun"/>' +
    '<circle cx="15.1" cy="4.9" r="1.6" class="brand__planet"/>';
  return svg;
}

function initialBodyId() {
  const params = new URLSearchParams(window.location.search);
  // ?planet= was the old parameter; keep old links working.
  const requested = params.get('body') ?? params.get('planet');
  return requested && BODY_BY_ID.has(requested) ? requested : 'earth';
}

/** A ?t= date from a shared link, as days since J2000, or null. */
function initialDays() {
  const raw = new URLSearchParams(window.location.search).get('t');
  if (!raw) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00Z` : raw);
  return Number.isFinite(ms) ? daysSinceJ2000(new Date(ms)) : null;
}

function setUrlBody(id) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('body', id);
  else url.searchParams.delete('body');
  url.searchParams.delete('planet');
  window.history.replaceState(null, '', url);
}

/** Records a deliberate jump in the URL, so a reload lands on the same date. */
function setUrlTime(days) {
  const url = new URL(window.location.href);
  if (days === null) url.searchParams.delete('t');
  else url.searchParams.set('t', isoMinute(dateFromDays(days)));
  window.history.replaceState(null, '', url);
}

function isoMinute(date) {
  return Number.isNaN(date.getTime()) ? '' : `${date.toISOString().slice(0, 16)}Z`;
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

function readFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeFlag(key) {
  try { localStorage.setItem(key, '1'); } catch { /* storage blocked: the hint just shows again */ }
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

/** True where a key press is text entry. Sliders and switches do not count. */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(target.type);
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
