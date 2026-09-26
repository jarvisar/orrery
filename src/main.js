/**
 * Application entry point. Startup order matters:
 *
 *   1. Build the scene graph with placeholder textures in every map slot.
 *   2. Stream in the Sun, planets and sky - and only those - behind the loading
 *      screen.
 *   3. Compile every shader program with `compileAsync` before the first frame.
 *   4. Start rendering, then load moons, dwarf planets and detail maps in the
 *      background.
 *
 * Shader compilation blocks wherever it happens, so step 3 does it up front
 * rather than the first time each planet comes into view.
 */

import * as THREE from 'three';

import { BODY_BY_ID, EARTH_RADIUS_KM } from './data/bodies.js';
import { SOLAR_SYSTEM } from './data/systems.js';
import { makeSystem } from './data/exoplanets.js';
import { loadStellarCatalogue } from './data/stellarSystems.js';
import { ExoplanetCatalogue } from './core/ExoplanetCatalogue.js';
import { SystemExplorer } from './ui/SystemExplorer.js';
import { Viewport } from './core/Viewport.js';
import { AssetLoader } from './core/AssetLoader.js';
import { Settings } from './core/Settings.js';
import { Picker } from './core/Picker.js';
import { GamepadInput } from './core/Gamepads.js';
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
import { InstallToast } from './ui/InstallToast.js';
import { UpdateToast } from './ui/UpdateToast.js';
import { GamepadHud } from './ui/GamepadHud.js';
import { FocusNavigator } from './ui/FocusNavigator.js';
import { padName } from './ui/padGlyphs.js';
import { toggleFullscreen } from './ui/fullscreen.js';
import { VRMode } from './xr/VRMode.js';
import { el, icon } from './ui/dom.js';

/** Scene units to kilometres, using the body-size scale rather than the orbit scale. */
const KM_PER_UNIT = EARTH_RADIUS_KM / EARTH_RADIUS_UNITS;

/** The one thing in the scene that is not in the catalogue. */
const VISITOR_ID = 'visitor';

/** Keys flight mode takes over from the rest of the interface. */
const FLIGHT_KEYS = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
];

/** Loaded only when opening the atlas or following an exoplanet link. */
const exoplanets = new ExoplanetCatalogue();

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

  let catalogue = SOLAR_SYSTEM;
  let catalogueError = '';
  const requestedSystem = new URLSearchParams(location.search).get('system');
  if (requestedSystem) {
    loading.begin('catalogue', 'Finding this star system…');
    try {
      await exoplanets.load();
      let entry = exoplanets.systems.find((s) => s.name === requestedSystem);
      // Newer than the saved copy? Only a host the archive really has is worth a refresh.
      if (!entry && await exoplanets.hasHost(requestedSystem) && await exoplanets.refresh()) {
        entry = exoplanets.systems.find((s) => s.name === requestedSystem);
      }
      if (!entry) throw new Error(`“${requestedSystem}” is not in the available catalogue. Choose a system from the atlas.`);
      // Host-only view still works when the supplement is unavailable.
      const companions = entry.stars > 1 ? await loadStellarCatalogue().catch(() => null) : null;
      catalogue = makeSystem(entry, exoplanets.data, companions);
    } catch (error) { catalogueError = error.message; }
  }
  if (catalogueError) {
    const url = new URL(location.href); url.searchParams.delete('system');
    url.searchParams.delete('body'); window.history.replaceState(null, '', url);
  }
  if (catalogue.isExoplanet) {
    document.title = `${catalogue.name} · Orrery`;
    canvas.setAttribute('aria-label', `Interactive 3D model of the ${catalogue.name} system`);
  }
  const settings = new Settings();
  const clock = new Clock();
  const startDays = initialDays();
  if (startDays !== null) clock.travelTo(startDays, { instant: true });

  const viewport = new Viewport(canvas);
  const { renderer, camera } = viewport;

  const scene = new THREE.Scene();
  const assets = new AssetLoader(renderer);
  const system = new SolarSystem(scene, assets, catalogue);

  system.scaleExponent = settings.get('scale');
  viewport.setAdaptiveResolution(settings.get('adaptiveResolution'));
  // If even the lowest render scale cannot hold the frame rate, drop the frosted
  // glass too: backdrop blur re-reads the canvas every frame. See style.css.
  viewport.onConstrained(() => document.documentElement.classList.add('is-constrained'));
  renderer.toneMappingExposure = settings.get('exposure');

  loading.begin('catalogue', 'Reading the catalogue…');
  // Another star's worlds are painted on the GPU as they are built.
  await system.build({ onPaint: (fraction, name) => loading.progress(fraction, `Painting ${name}…`) });
  system.setShadowQuality(settings.get('shadowQuality'));
  viewport.setShadowsEnabled(system.sunLight.castShadow);

  loading.begin('textures', catalogue.isExoplanet ? 'Loading the star and planets…' : 'Loading the Sun and planets…');
  const sky = new Sky(scene, assets);
  const starsLoaded = sky.load();

  await assets.drain({
    concurrency: 6,
    maxPriority: 5, // the star, the planets, and their own detail maps
    onProgress: (loaded, total, name) =>
      loading.progress(loaded / total, `Loading ${prettyName(name)}…`),
  });

  loading.begin('models', 'Loading models…');
  if (!catalogue.isExoplanet) await Promise.allSettled([assets.model('phobos'), assets.model('deimos'), assets.model('ufo')]);

  loading.begin('scene', 'Plotting orbits…');
  const orbits = new Orbits(scene, system);
  orbits.build();
  orbits.setVisible(settings.get('showOrbits'));

  const belts = new Belts(scene, system);
  belts.build(settings.get('beltDensity'));
  belts.setVisible(settings.get('showBelts'));

  const visitor = catalogue.isExoplanet ? { view: null, meshes: [], update() {} } : await buildVisitor(assets, scene, system);

  system.setCategoryVisible('moon', settings.get('showMoons'));
  system.setCategoryVisible('dwarf', settings.get('showDwarfs'));
  orbits.syncVisibility();

  system.update(clock.days);
  orbits.update(camera.position, clock.days);
  belts.update(clock.days);

  const director = new CameraDirector(camera, canvas, system);
  const flight = new FlightControls(camera, canvas, system);

  const picker = new Picker(canvas, camera, system);
  picker.addSelectable(VISITOR_ID, visitor.meshes);

  const post = new Post(renderer, scene, camera);
  post.setEnabled(settings.get('effects'));
  viewport.onResize((size, view) => {
    orbits.setResolution(size.x, size.y);
    post.setSize(view.width, view.height, view.pixelRatio, view.multisample);
    orbits.setSmoothing(post.enabled && !view.multisample);
    sky.setPixelRatio(view.pixelRatio);
  });

  loading.begin('shaders', 'Compiling shaders…');
  director.focusOn(system.bodies.get(initialBodyId(catalogue)), { instant: true });
  await starsLoaded;
  await post.compileAsync();
  assets.pumpUploads(999);
  assets.uploadSceneTextures(scene);

  const ui = buildInterface({
    settings, clock, scene, assets, system, orbits, belts, sky,
    director, flight, picker, viewport, visitor, post,
  });
  // Another star opens on the planets: its own, where they would be lost in a
  // wide stellar orbit (catalogue.home), else the whole system.
  if (catalogue.isExoplanet && !new URLSearchParams(location.search).get('body')) {
    ui.showOverview(catalogue.home?.radiusAU, { instant: true, centreId: catalogue.home?.centreId });
  } else ui.selectBody(initialBodyId(catalogue), { instant: true });
  ui.markers.update(viewport.width, viewport.height);

  // Draw and start animating *underneath* the loading screen, so the fade
  // uncovers a live scene rather than a black canvas.
  post.render(0);
  startLoop({
    viewport, system, orbits, belts, director, flight, picker, clock, assets, ui, visitor, post,
  });

  if (new URLSearchParams(window.location.search).has('debug')) {
    window.orrery = { THREE, scene, camera, renderer, viewport, assets, system, orbits, belts, sky, post, director, clock, settings, ui };
  }

  document.getElementById('ui').hidden = false;
  await loading.finish();
  ui.welcome();
  if (catalogue.isExoplanet) exoplanets.refreshIfStale();
  if (catalogueError) { await ui.explorer.open(); ui.explorer.status.textContent = catalogueError; }

  // Everything still queued (moons, dwarf planets) streams in after first paint.
  await assets.drain({ concurrency: 4 });
  // One more compile pass, in case a streamed model brought its own materials.
  await post.compileAsync().catch(() => {});
  // A headset draws with the screen's variants; have them ready before it starts.
  if (post.enabled && await VRMode.isSupported()) await post.compileAsync({ screen: true }).catch(() => {});

  // Last, so filling the offline copy never competes with the first load, and
  // mostly revalidates what the HTTP cache already holds.
  registerServiceWorker();
}

/** Offline support and installability; see sw.js. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // The desktop app (desktop/) ships every file on disk already; an offline
  // cache would only be a second copy of it.
  if (window.orreryDesktop) return;
  navigator.serviceWorker.register('sw.js').catch((error) => {
    console.warn('[orrery] offline support unavailable', error);
  });
}

function buildInterface(ctx) {
  const { settings, clock, scene, assets, system, orbits, belts, sky,
          director, flight, picker, viewport, visitor, post } = ctx;
  const catalogue = system.catalogue;
  const root = document.getElementById('ui');
  root.classList.toggle('is-exoplanet', catalogue.isExoplanet);
  const camera = viewport.camera;
  const reduceMotion = () => settings.get('reduceMotion');

  const state = {
    flying: false, focusedId: null, showStats: false, touring: false,
    // The overview last shown, so a headset opens on the same one.
    overview: { radiusAU: catalogue.overviewAU, centre: null },
    // The controller is the input in use, and whether it is driving the menus.
    padActive: false, padMenus: false,
  };

  const lookup = (id) => (id === VISITOR_ID ? visitor.view : system.bodies.get(id));

  const bodyPicker = new BodyPicker({
    catalogue,
    onSelect: (id) => selectBody(id),
    onOverview: () => showOverview(),
  });
  // On a phone the panel would cover the body it describes; start it folded.
  const infoPanel = new InfoPanel({
    catalogue,
    collapsed: window.matchMedia('(max-width: 720px)').matches,
    onSelect: (id) => selectBody(id),
    isVisible: (id) => system.isVisible(id),
    elementsOf: (id) => system.bodies.get(id)?.elements,
  });
  const timeBar = new TimeBar(clock, {
    exoplanet: catalogue.isExoplanet,
    onJump: (days, moment) => travelTo(days, moment),
    onNow: () => {
      clock.jumpToNow({ instant: reduceMotion() });
      setUrlTime(null);
    },
    onCopyLink: () => copyLink(),
  });
  const flightHud = new FlightHud(flight, KM_PER_UNIT, camera, {
    onStep: (delta) => stepBody(delta),
    onAutopilot: () => toggleAutopilot(),
  });
  flight.onArrive = (view) => {
    flightHud.notify(`Arrived at ${view.name}`);
    rumble(0.4, 0.6, 180);
  };
  const settingsPanel = new SettingsPanel(settings, {
    // Around another star there are no moons, dwarf planets, belts or shadows to show.
    // Another star's only belts are a measured dust disk, if it has one.
    omit: catalogue.isExoplanet ? ['showMoons', 'showDwarfs', ...(catalogue.disk ? [] : ['showBelts', 'beltDensity']), 'shadowQuality'] : [],
  });
  const helpOverlay = new HelpOverlay({ exoplanet: catalogue.isExoplanet });
  const markers = new Markers(system, camera, (id) => selectBody(id));
  const installToast = new InstallToast();
  const updateToast = new UpdateToast(); // desktop app only; see desktop/src/updates.js
  const gamepad = new GamepadInput();
  const padHud = new GamepadHud();
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

  const vr = new VRMode({
    renderer: viewport.renderer, camera, scene, system, clock, picker, settings,
    actions: {
      select: (id) => selectBody(id),
      overview: () => showOverview(),
      step: (delta) => stepBody(delta),
      togglePause: () => timeBar.togglePause(),
      stepRate: (delta) => timeBar.stepRate(delta),
      now: () => timeBar.jumpToNow(),
    },
    onStart: () => {
      tours.stop();
      setFlight(false, { refocus: false });
      helpOverlay.close();
      settingsPanel.close();
      director.setEnabled(false);
      picker.setEnabled(false);
      hideTooltip();
      dismissHint();
      setPressed(vrButton, true);
      // Star sizes are in pixels, and a headset's pixels are about as far
      // apart, by angle, as a monitor's at 1x.
      sky.setPixelRatio(1);
      // The headset's own frame is multisampled.
      orbits.setSmoothing(false);
      const view = state.focusedId ? lookup(state.focusedId) : null;
      if (view) vr.focusOn(view, { instant: true });
      else vr.overview(state.overview.radiusAU, { instant: true, centre: state.overview.centre });
    },
    onEnd: () => {
      director.setEnabled(true);
      picker.setEnabled(true);
      setPressed(vrButton, false);
      const size = viewport.drawingBufferSize();
      orbits.setResolution(size.x, size.y);
      orbits.setSmoothing(post.enabled && !viewport.multisample);
      sky.setPixelRatio(viewport.pixelRatio);
      if (state.focusedId) director.focusOn(lookup(state.focusedId), { instant: true });
      else director.overview(state.overview.radiusAU, { instant: true, centre: state.overview.centre });
    },
    onResolution: (width, height) => orbits.setResolution(width, height),
  });

  // Shown only when a headset (or a runtime for one) is present; rechecked on devicechange.
  const vrButton = el(
    'button',
    {
      class: 'btn btn--icon topbar__vr',
      type: 'button',
      title: 'View in VR',
      'aria-label': 'View in VR',
      'aria-pressed': 'false',
      hidden: true,
      onclick: () => vr.toggle(),
    },
    [icon('vr')]
  );
  const detectVR = async () => {
    const supported = await VRMode.isSupported();
    vrButton.hidden = !supported;
    if (supported) VRMode.preload();
  };
  detectVR();
  navigator.xr?.addEventListener?.('devicechange', detectVR);

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

  const explorer = new SystemExplorer(exoplanets, catalogue, { onOpen: () => {
    tours.stop(); bodyPicker.close(); timeBar.close(); settingsPanel.close();
    if (state.flying) setFlight(false);
    dismissHint();
  } });
  const topbar = el('div', { class: 'topbar' }, [
    brand,
    bodyPicker.root,
    el('div', { class: 'topbar__end' }, [
      el('div', { class: 'topbar__group topbar__actions panel' }, [
        explorer.button,
        catalogue.isExoplanet ? null : tours.root,
        el('span', { class: 'topbar__divider', 'aria-hidden': 'true' }),
        flightButton,
        vrButton,
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
    markers.root, flightHud.root, tooltip, stats, hint, installToast.root, updateToast.root,
    padHud.root, settingsPanel.root, helpOverlay.root, explorer.panel
  );

  /* --- focus ------------------------------------------------------------- */

  function selectBody(id, { instant = false, fromTour = false, duration } = {}) {
    // Choosing a body mid-flight means "fly me there", not "stop flying".
    if (state.flying && id && !fromTour) {
      setDestination(id, { engage: true });
      return;
    }
    if (state.flying) setFlight(false, { refocus: false });
    if (!fromTour) tours.stop();

    const view = id ? lookup(id) : null;
    if (id && !view) return;

    state.focusedId = id;
    if (vr.active) vr.focusOn(view, { instant });
    else director.focusOn(view, { instant: instant || reduceMotion(), duration });
    bodyPicker.select(id, view?.body);
    if (!state.touring) infoPanel.show(view);
    orbits.setFocus(id);
    markers.setFocus(id);
    system.focusShadows(view);
    dismissHint();

    // Fetch this body's still-queued textures next rather than in catalogue order.
    if (view) assets.promote(collectTextureNames(view.body));

    // The visitor is never linked to; it is meant to be found.
    if (id !== VISITOR_ID) setUrlBody(id);
  }

  /** The whole system; or, with `centreId`, one body and what orbits it, followed as it moves. */
  function showOverview(radiusAU = catalogue.overviewAU, { instant = false, centreId = null } = {}) {
    if (state.flying) setFlight(false, { refocus: false });
    tours.stop();
    state.focusedId = null;
    const centre = centreId ? lookup(centreId) ?? null : null;
    state.overview = { radiusAU, centre };
    if (vr.active) vr.overview(radiusAU, { instant, centre });
    else director.overview(radiusAU, { instant: instant || reduceMotion(), centre });
    bodyPicker.select(null, { name: centre ? `Planets of ${centre.name}` : 'Whole system' });
    infoPanel.show(catalogue.isExoplanet ? centre ?? system.bodies.get(catalogue.starId) : null);
    orbits.setFocus(null);
    markers.setFocus(null);
    setUrlBody(null);
  }

  function stepBody(delta) {
    const available = catalogue.bodies.filter((body) => system.isVisible(body.id));
    if (available.length === 0) return;
    // In flight, [ and ] choose the destination instead, starting from wherever you are.
    const current = state.flying ? (flight.target ?? flight.nearest)?.id : state.focusedId;
    const index = available.findIndex((body) => body.id === current);
    // From free view, [ and ] start at either end of the list.
    const start = index < 0 ? (delta > 0 ? -1 : 0) : index;
    const next = available[(start + delta + available.length) % available.length];
    if (state.flying) setDestination(next.id);
    else selectBody(next.id);
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
    // In the desktop app this page's own address is app://, which would mean
    // nothing to whoever it is sent to; the link goes to the public site instead.
    const url = new URL(window.orreryDesktop?.webUrl ?? window.location.href);
    if (catalogue.id) url.searchParams.set('system', catalogue.id);
    else url.searchParams.delete('system');
    url.searchParams.delete('body');
    url.searchParams.set('t', isoMinute(dateFromDays(clock.days)));
    if (state.focusedId && state.focusedId !== VISITOR_ID) url.searchParams.set('body', state.focusedId);
    await navigator.clipboard.writeText(url.toString());
  }

  /* --- flight ------------------------------------------------------------ */

  function setFlight(enabled, { refocus = true } = {}) {
    // A headset has its own way of flying.
    if (enabled === state.flying || (enabled && vr.active)) return;
    state.flying = enabled;
    if (enabled) tours.stop();

    flight.setEnabled(enabled);
    flight.reset();
    director.setEnabled(!enabled);
    picker.setEnabled(!enabled);
    flightHud.setActive(enabled);
    markers.setFocus(null);
    setPressed(flightButton, enabled);

    if (!enabled) {
      const nearest = director.nearestBody(camera.position);
      director.syncTargetToView(nearest ? camera.position.distanceTo(nearest.group.position) : 100);
    }

    if (enabled) {
      flight.setTarget(null);
      // Pressing G or the button counts as the gesture capturing the mouse
      // needs. A controller's buttons do not, and it steers without the mouse.
      if (!state.padActive) flight.capture();
      director.focusOn(null);
      bodyPicker.select(null);
      infoPanel.show(null);
      orbits.setFocus(null);
      state.focusedId = null;
      hideTooltip();
      dismissHint();
    } else if (refocus) {
      // Land on whatever you were flying round; out in deep space, stay put.
      const nearest = director.nearestBody(camera.position);
      if (nearest && camera.position.distanceTo(nearest.group.position) < nearest.radius * 40) {
        selectBody(nearest.id);
      }
    }
  }

  /** Sets where flight is headed; `engage` also hands the controls to the autopilot. */
  function setDestination(id, { engage = false } = {}) {
    const view = lookup(id);
    if (!view) return;
    flight.setTarget(view);
    // Its moons are only marked while their system is the one in focus.
    markers.setFocus(id);
    if (engage) {
      flight.setAutopilot(true);
      flightHud.notify(`Autopilot: flying to ${view.name} · steer to take over`);
    }
  }

  function toggleAutopilot() {
    if (!flight.target) {
      flightHud.notify('Choose a destination first');
      return;
    }
    flight.setAutopilot(!flight.autopilot);
    if (flight.autopilot) flightHud.notify(`Autopilot: flying to ${flight.target.name}`);
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

  function setPressed(button, pressed) {
    button.setAttribute('aria-pressed', String(pressed));
    button.classList.toggle('is-active', pressed);
  }

  /** Back to the standard framing of the focused body. */
  function reframe({ instant = false } = {}) {
    const view = state.focusedId ? lookup(state.focusedId) : null;
    if (!view) return;
    if (vr.active) vr.focusOn(view, { instant });
    else director.focusOn(view, { instant });
  }

  /* --- first visit ------------------------------------------------------- */

  // The hint goes first; the install toast waits until it has gone, since on a
  // phone the two would share the same spot.
  let hintTimer = 0;
  function welcome() {
    if (readFlag('orrery:welcomed') || state.touring) return installToast.offer();
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
    window.addEventListener('pointerdown', dismissHint, { once: true, capture: true });
    window.addEventListener('keydown', dismissHint, { once: true, capture: true });
  }

  function dismissHint() {
    if (hint.hidden) return;
    clearTimeout(hintTimer);
    hint.classList.remove('is-visible');
    setTimeout(() => {
      hint.hidden = true;
      installToast.offer();
    }, 400);
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
  settings.on('effects', (value) => {
    post.setEnabled(value);
    // With effects off the frame goes straight to the canvas, which is always multisampled.
    orbits.setSmoothing(value && !viewport.multisample);
    // Every material now draws with its other variant; compile the rest now
    // rather than each the first time it comes into view.
    post.compileAsync().catch(() => {});
  });
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
    reframe({ instant: true });
  }, 120));

  settings.on('beltDensity', debounce((value) => belts.build(value), 200));

  settings.on('shadowQuality', (value) => {
    system.setShadowQuality(value);
    viewport.setShadowsEnabled(system.sunLight.castShadow);
    // Toggling shadows changes every material's program; recompile now rather
    // than stall on the next frame.
    post.compileAsync().catch(() => {});
  });

  /* --- menus, drawers and dialogs ---------------------------------------- */

  /** The innermost menu, drawer or dialog that is open, or null. */
  function openSurface() {
    if (explorer.isOpen) return explorer.panel;
    if (helpOverlay.isOpen) return helpOverlay.card;
    if (bodyPicker.isOpen) return bodyPicker.menu;
    if (tours.isOpen) return tours.menu;
    if (timeBar.isOpen) return timeBar.panel;
    if (settingsPanel.isOpen) return settingsPanel.root;
    return null;
  }

  /** Closes the innermost one, handing focus back to what opened it. False if none was open. */
  function closeSurface() {
    if (explorer.isOpen) explorer.close();
    else if (helpOverlay.isOpen) helpOverlay.close();
    else if (bodyPicker.isOpen) bodyPicker.close({ restoreFocus: true });
    else if (tours.isOpen) tours.closeMenu({ restoreFocus: true });
    else if (timeBar.isOpen) timeBar.close({ restoreFocus: true });
    else if (settingsPanel.isOpen) settingsPanel.close();
    else return false;
    return true;
  }

  /* --- game controller --------------------------------------------------- */

  // Bound by position, so the same thumb does the same thing on any make; the
  // glyphs show each make's own labels. Keep in step with the legend in
  // src/ui/GamepadHud.js and the list in src/ui/HelpOverlay.js.
  // Three modes: orbiting a body, flight, and menus (after Menu, or whenever a
  // panel is open: D-pad moves focus, A presses, B goes back).

  const focusNav = new FocusNavigator({
    scope: () => openSurface(),
    home: () => bodyPicker.button,
  });
  let padWasConnected = false;
  let padNews = null;
  let legendContext;
  let sinceRumble = 0;

  gamepad.onConnect = (pad, family) => { padNews = `${padName(family)} connected`; };
  gamepad.onDisconnect = () => { padNews = 'Controller disconnected'; };

  /** Called every frame, before the camera and flight controls read their input. */
  function updateGamepad(dt) {
    gamepad.poll(dt);
    if (gamepad.connected !== padWasConnected) {
      padWasConnected = gamepad.connected;
      padConnectionChanged(gamepad.connected);
    }
    if (gamepad.connected && gamepad.family !== padHud.family) {
      padHud.setFamily(gamepad.family);
      helpOverlay.setController(gamepad.family);
    }
    if (padNews) {
      padHud.notice(padNews);
      padNews = null;
    }

    // A headset has controllers of its own.
    if (!gamepad.connected || vr.presenting) {
      flight.setPadInput(null);
      return;
    }
    if (gamepad.used) setPadActive(true);
    if (gamepad.pressed('view')) padFullscreen();

    // Anything open takes the controller until it is closed.
    if (openSurface() && gamepad.used) state.padMenus = true;
    if (state.padMenus) {
      flight.setPadInput(null);
      padMenusInput(dt);
    } else if (state.flying) {
      padFlightInput(dt);
    } else {
      flight.setPadInput(null);
      padOrbitInput(dt);
    }
    if (state.padActive) showPadLegend();
  }

  function padConnectionChanged(connected) {
    settingsPanel.setControllerConnected(connected);
    if (connected) {
      padHud.setFamily(gamepad.family);
      helpOverlay.setController(gamepad.family);
      return;
    }
    if (state.padMenus) leavePadMenus();
    setPadActive(false);
    helpOverlay.setController(null);
    flight.setPadInput(null);
    padHud.show(null);
  }

  function padOrbitInput(dt) {
    const speed = settings.get('padSensitivity');
    const invert = settings.get('padInvertY') ? -1 : 1;
    // Not mid-flight to a body: input would pile up and be spent at once on arrival.
    if (!director.isTransitioning) {
      director.drive({
        orbitX: gamepad.left.x * speed,
        orbitY: gamepad.left.y * speed * invert,
        panX: gamepad.right.x * speed,
        panY: gamepad.right.y * speed,
        zoom: gamepad.rt - gamepad.lt,
      }, dt);
    }

    if (gamepad.pressed('menu')) return enterPadMenus();
    if (gamepad.pressed('a')) timeBar.togglePause();
    if (gamepad.pressed('b')) {
      if (state.touring) tours.stop();
      else if (state.focusedId) selectBody(null);
    }
    if (gamepad.pressed('x')) setFlight(true);
    if (gamepad.pressed('y')) showOverview();
    if (gamepad.pressed('rs')) reframe();
    if (gamepad.pressed('ls')) infoPanel.setCollapsed(!infoPanel.collapsed);
    for (const [button, delta] of [['left', -1], ['right', 1]]) {
      if (!gamepad.pressed(button)) continue;
      if (state.touring) tours.step(delta);
      else stepBody(delta);
    }
    padTimeInput();
  }

  function padFlightInput(dt) {
    const speed = settings.get('padSensitivity');
    const invert = settings.get('padInvertY') ? -1 : 1;
    flight.setPadInput({
      x: gamepad.left.x * speed,
      y: gamepad.left.y * speed * invert,
      roll: gamepad.right.x,
      throttle: gamepad.rt - gamepad.lt,
      boost: gamepad.down('a'),
    });

    if (gamepad.pressed('menu')) return enterPadMenus();
    if (gamepad.pressed('a')) rumble(0, 0.35, 90);
    if (gamepad.pressed('y')) toggleAutopilot();
    if (gamepad.pressed('x') || gamepad.pressed('b')) return setFlight(false);
    if (gamepad.pressed('left')) stepBody(-1);
    if (gamepad.pressed('right')) stepBody(1);
    padTimeInput();

    // Rumble while scraping along the surface.
    sinceRumble += dt;
    if (flight.grazing && flight.throttle > 0.05 && sinceRumble > 0.12) {
      rumble(0.15, 0.35, 110);
      sinceRumble = 0;
    }
  }

  function padTimeInput() {
    if (gamepad.repeat('lb')) timeBar.stepRate(-1);
    if (gamepad.repeat('rb')) timeBar.stepRate(1);
    if (gamepad.pressed('up')) timeBar.jumpToNow();
    if (gamepad.pressed('down')) timeBar.toggleDirection();
  }

  function padMenusInput(dt) {
    if (gamepad.pressed('menu')) return leavePadMenus();
    if (gamepad.pressed('b')) {
      if (!closeSurface()) leavePadMenus();
      return;
    }
    focusNav.ensure();
    for (const direction of ['up', 'down', 'left', 'right']) {
      if (!gamepad.nav(direction)) continue;
      const horizontal = direction === 'left' || direction === 'right';
      if (horizontal && focusNav.adjusting) focusNav.adjust(direction === 'right' ? 1 : -1);
      else focusNav.move(direction);
    }
    if (gamepad.pressed('a')) focusNav.activate();
    if (gamepad.right.y) focusNav.scroll(gamepad.right.y * 900 * dt);
  }

  function enterPadMenus() {
    state.padMenus = true;
    focusNav.ensure();
  }

  function leavePadMenus() {
    state.padMenus = false;
    while (closeSurface());
    focusNav.release();
  }

  /** Controller vs mouse/keyboard/touch; the controller adds its legend and a heavier focus ring (style.css). */
  function setPadActive(active) {
    if (active === state.padActive) return;
    state.padActive = active;
    document.documentElement.classList.toggle('is-gamepad', active);
    flightHud.setGamepad(active);
    if (active) {
      dismissHint();
      hideTooltip();
      legendContext = undefined;
    } else {
      padHud.hide();
    }
  }
  const pointerUsed = (event) => {
    // Layout shifting under a still mouse fires a move without movement.
    if (event.type === 'pointermove' && !event.movementX && !event.movementY) return;
    if (event.type === 'pointerdown') state.padMenus = false;
    setPadActive(false);
  };
  for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
    window.addEventListener(type, pointerUsed, { capture: true, passive: true });
  }

  /** The legend for what the controller is doing now; it only changes when that does. */
  function showPadLegend() {
    let context = state.flying ? 'flight' : state.touring ? 'tour' : 'orbit';
    // An open menu or panel explains itself.
    if (state.padMenus) context = openSurface() ? null : 'interface';
    if (context === legendContext) return;
    legendContext = context;
    padHud.show(context, { sticky: context === 'interface' });
  }

  async function padFullscreen() {
    const result = await toggleFullscreen({ onPendingEnd: () => padHud.clearNotice() });
    // A controller's press is not enough for the browser; a key or a click is.
    if (result === 'pending') padHud.notice('Press any key or click to go full screen', 10_000);
    else if (result === 'unsupported') padHud.notice('Full screen is not available in this browser');
  }

  function rumble(strong, weak, ms) {
    if (state.padActive && settings.get('padRumble')) gamepad.rumble(strong, weak, ms);
  }

  /* --- keyboard ---------------------------------------------------------- */

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // In a text field every key is typing - except Escape, which still closes things.
    if (isTypingTarget(event.target) && event.code !== 'Escape') return;

    // The controls dialog is modal: while it is up, only the keys that close it count.
    if (helpOverlay.isOpen && event.code !== 'Escape' && event.code !== 'Slash') return;

    const flightOwns = state.flying && FLIGHT_KEYS.includes(event.code);
    if (flightOwns) return;

    switch (event.code) {
      // The one place Escape is handled, so closing a panel never also drops focus.
      case 'Escape':
        if (closeSurface()) break;
        if (state.touring) tours.stop();
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
      case 'KeyT': if (!catalogue.isExoplanet) tours.toggleMenu(); break;
      case 'ArrowLeft': if (state.touring) tours.step(-1); break;
      case 'ArrowRight': if (state.touring) tours.step(1); break;
      case 'BracketLeft': stepBody(-1); break;
      case 'BracketRight': stepBody(1); break;
      case 'KeyF':
        if (state.flying) toggleAutopilot();
        else reframe();
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
    state, stats, tooltip, timeBar, infoPanel, flightHud, bodyPicker, markers, tours, vr, gamepad,
    selectBody, showOverview, explorer, setFlight, hideTooltip, welcome, updateGamepad,
  };
}

function startLoop(ctx) {
  const { viewport, system, orbits, belts, director, flight, picker, clock, assets, ui, visitor, post } = ctx;
  const { renderer, camera } = viewport;
  const { vr } = ui;

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
    // The interval that just ended, which covers the previous frame's work.
    viewport.sample(rawDelta * 1000);

    clock.advance(dt);
    system.update(clock.days);
    belts.update(clock.days);
    visitor.update(dt);
    ui.tours.update(dt);
    ui.updateGamepad(dt);

    // In a headset the viewer's head is the camera, and it sits inside a rig
    // that the VR controls move; camera.position is then relative to that rig.
    const immersive = vr.presenting;
    if (immersive) {
      vr.update(dt);
    } else if (ui.state.flying) {
      flight.update(dt);
      director.fitClippingToSurroundings();
      ui.flightHud.update(viewport.width, viewport.height);
    } else {
      director.update(dt);
      picker.update();
    }

    orbits.update(immersive ? vr.viewerPosition : camera.position, clock.days);
    if (!immersive) ui.markers.update(viewport.width, viewport.height);
    // A headset is drawn in full detail throughout.
    system.updateDetail(immersive ? null : camera.position, pixelScale(viewport, camera));
    // An upload's cost lands in the next interval, and is not the resolution's fault.
    if (assets.pumpUploads()) viewport.discardNextSample();
    post.render(dt);

    // Readouts update four times a second to keep text layout off the critical
    // path, except during a jump through time, when the date should visibly spin.
    frames++;
    sinceUiUpdate += dt;
    sinceStats += dt;
    if (clock.isTravelling) ui.timeBar.tick();
    if (sinceUiUpdate > 0.25) {
      ui.timeBar.tick();
      ui.infoPanel.updateLive(clock.days);
      const settled = immersive ? vr.focus : !director.isTransitioning && director.focus;
      if (settled) system.focusShadows(settled);
      sinceUiUpdate = 0;
    }
    if (ui.state.showStats && sinceStats > 0.5) {
      const info = renderer.info.render;
      ui.stats.textContent =
        `${Math.round(frames / sinceStats)} fps · ${info.calls} draws · ` +
        `${(info.triangles / 1000).toFixed(0)}k tris · ${(viewport.renderScale * 100).toFixed(0)}% scale (${viewport.pixelRatio.toFixed(2)}x` +
        `${viewport.multisample && post.enabled ? ', MSAA' : ''})` +
        (assets.pending ? ` · ${assets.pending} loading` : '');
      sinceStats = 0;
      frames = 0;
    } else if (sinceStats > 0.5) {
      sinceStats = 0;
      frames = 0;
    }
  });
}

/** Drawing-buffer pixels per scene unit, one unit in front of the camera. */
function pixelScale(viewport, camera) {
  return (viewport.height * viewport.pixelRatio) / 2 / Math.tan((camera.fov * Math.PI) / 360);
}

/**
 * The UFO: a small, slow, clickable orbit round the Moon. It keeps away from the
 * focused planet, where on a first visit it would read as a rendering bug.
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

function initialBodyId(catalogue) {
  const params = new URLSearchParams(window.location.search);
  // ?planet= was the old parameter; keep old links working.
  const requested = params.get('body') ?? params.get('planet');
  return requested && catalogue.byId.has(requested) ? requested : catalogue.isExoplanet ? catalogue.starId : 'earth';
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

/** Undocumented easter egg. */
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
