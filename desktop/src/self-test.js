/**
 * `--self-test`: loads the app, checks it came up, and exits 0 or 1.
 *
 * The desktop counterpart of scripts/smoke.js, run against the real,
 * packaged app rather than a browser, so it also proves the packaging: every
 * file the page asks for is in the build, the protocol serves it with the
 * right type, the preload ran and the policy lets everything through. CI runs
 * it on all three platforms (desktop/scripts/smoke.js); on a Steam Deck it is
 * a quick way to see what GPU WebGL landed on.
 *
 * Fails on any console error (which includes uncaught exceptions and CSP
 * violations), any request the protocol could not answer, a renderer crash,
 * the "WebGL unavailable" screen, or a loading screen that never lifts.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ORIGIN } from './protocol.js';

const TIMEOUT_MS = 180_000;
/** After the loading screen lifts: long enough for the moons to stream in. */
const SETTLE_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Electron.BrowserWindow} win Not yet loaded.
 * @param {{ problems: string[] }} report Shared with the protocol handler,
 *   which adds any request it could not answer.
 * @param {string} startUrl
 * @param {string} [screenshot] Where to save a PNG of the settled scene.
 */
export async function selfTest(win, report, startUrl, screenshot) {
  const { problems } = report;
  const contents = win.webContents;
  const log = (line) => console.log(`self-test: ${line}`);

  contents.on('console-message', (event) => {
    if (event.level === 'error') problems.push(`console.error: ${event.message}`);
    else if (event.level === 'warning') log(`(warning) ${event.message}`);
  });
  contents.on('preload-error', (_event, path, error) => problems.push(`preload ${path}: ${error.message}`));
  contents.on('did-fail-load', (_event, code, description, url) => {
    if (code !== -3) problems.push(`failed to load ${url}: ${description} (${code})`);
  });
  contents.on('render-process-gone', (_event, details) => {
    problems.push(`renderer gone: ${details.reason}`);
  });

  const timeout = setTimeout(() => finish(['timed out after 180 s']), TIMEOUT_MS);

  try {
    log(`Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform}-${process.arch}`);
    await contents.loadURL(startUrl);

    // The loading screen removes itself once the first scene is drawn.
    let state;
    for (;;) {
      state = await contents.executeJavaScript(PROBE);
      if (state.unsupported) break;
      if (!state.loading) break;
      if (problems.some((problem) => problem.startsWith('renderer gone'))) break;
      await sleep(500);
    }
    await sleep(SETTLE_MS);
    state = await contents.executeJavaScript(PROBE);

    log(`WebGL: ${state.gpu} (${app.getGPUFeatureStatus().webgl})`);
    if (screenshot) {
      const image = await contents.capturePage();
      await writeFile(screenshot, image.toPNG());
      log(`screenshot: ${screenshot}`);
    }

    const expect = (ok, message) => { if (!ok) problems.push(message); };
    expect(!state.unsupported, 'the page says WebGL is unavailable');
    expect(!state.loading, 'the loading screen never lifted');
    expect(state.ui, 'the interface never became visible');
    expect(state.canvas, 'the WebGL canvas has no drawing buffer');
    expect(state.bodies >= 20, `the body picker lists ${state.bodies} bodies`);
    expect(Boolean(state.focus), 'nothing is focused');
    expect(state.desktop?.webUrl?.startsWith('https://'), 'window.orreryDesktop.webUrl is missing');
    expect(state.desktop?.fullscreen === 'function', 'window.orreryDesktop.requestFullscreen is missing');
    expect(state.desktop?.updates === 'function', 'window.orreryDesktop.onUpdateAvailable is missing');
    expect(state.updateToast, 'the page has no "Update available" toast (src/ui/UpdateToast.js)');
    expect(state.workers === 0, `${state.workers} service worker(s) registered; the desktop app should skip it`);
    log(`focused ${state.focus}, ${state.bodies} bodies listed, version ${state.desktop?.version}`);

    // A packaged build has to carry the updater and its feed, or installed
    // copies would never hear of the next release (updates.js).
    if (app.isPackaged) {
      const updater = await import('electron-updater').then(() => true, () => false);
      expect(updater, 'electron-updater is not in the packaged app; it must be a dependency, not a devDependency');
      const feed = existsSync(join(process.resourcesPath, 'app-update.yml'));
      expect(feed, 'the packaged app has no app-update.yml; is "publish" set in builder.config.js?');
      log(`updater: ${updater ? 'packaged' : 'MISSING'}, feed: ${feed ? 'app-update.yml' : 'MISSING'}`);
    }

    // The other page, reached from the Konami code: loads, and links back.
    await contents.loadURL(`${ORIGIN}/tetris.html`);
    await sleep(1000);
    const tetris = await contents.executeJavaScript(
      `Boolean(document.querySelector('canvas') && document.querySelector('a.back'))`
    );
    expect(tetris, 'tetris.html did not render');

    finish([]);
  } catch (error) {
    finish([`self-test crashed: ${error.stack ?? error}`]);
  }

  function finish(extra) {
    clearTimeout(timeout);
    const all = [...problems, ...extra];
    if (all.length) {
      console.error(`self-test: FAILED, ${all.length} problem${all.length === 1 ? '' : 's'}:`);
      for (const problem of all) console.error(`  - ${problem}`);
    } else {
      log('passed');
    }
    app.exit(all.length ? 1 : 0);
  }
}

/** Read from the page; kept to plain DOM so it survives most refactors. */
const PROBE = `(async () => {
  const shown = (id) => { const el = document.getElementById(id); return Boolean(el && !el.hidden); };
  const canvas = document.getElementById('viewport');
  let gpu = 'none';
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl ? 'available' : 'none';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {}
  return {
    loading: Boolean(document.getElementById('loading')),
    unsupported: shown('unsupported'),
    ui: shown('ui'),
    canvas: Boolean(canvas && canvas.width > 0 && canvas.height > 0),
    bodies: document.querySelectorAll('.picker__option').length,
    focus: document.querySelector('.picker__label')?.textContent ?? null,
    desktop: window.orreryDesktop && {
      version: window.orreryDesktop.version,
      webUrl: window.orreryDesktop.webUrl,
      fullscreen: typeof window.orreryDesktop.requestFullscreen,
      updates: typeof window.orreryDesktop.onUpdateAvailable,
    },
    updateToast: Boolean(document.querySelector('[aria-label="Update available"]')),
    workers: await navigator.serviceWorker.getRegistrations().then((list) => list.length, () => 0),
    gpu,
  };
})()`;
