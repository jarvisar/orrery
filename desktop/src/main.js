/**
 * The desktop app: one window showing the web app, served from app://orrery/.
 *
 * The web app is not copied or changed for this. In development the window
 * serves the repository's working tree directly, so an edit to src/ shows up
 * on reload (Ctrl+R / Cmd+R); a packaged build carries a copy staged by
 * scripts/stage.js from the same list GitHub Pages deploys. See
 * desktop/README.md.
 *
 * Switches, in addition to Chromium's own:
 *   --fullscreen        start full screen (automatic in Steam Deck Game Mode)
 *   --debug             open ?debug, which puts the scene on window.orrery, and the dev tools
 *   --web-root=<dir>    serve a different copy of the site, e.g. the staged desktop/web
 *   --software-gl       render WebGL on the CPU (SwiftShader), for machines without a GPU;
 *                       chosen automatically when the GPU cannot provide WebGL
 *   --low-power-gpu     stay on the integrated GPU of a laptop that has two
 *   --self-test         load, check that everything came up, and exit 0 or 1 (see self-test.js)
 *   --screenshot=<png>  with --self-test, save what the window showed
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ID, BACKGROUND, PRODUCT_NAME, SOURCE_URL } from './identity.js';
import { handleShortcuts, installMenu } from './menu.js';
import { ORIGIN, registerScheme, serve } from './protocol.js';
import { selfTest } from './self-test.js';
import { loadWindowState, trackWindowState } from './window-state.js';

// Before anything else: schemes can only be registered before the app is ready.
registerScheme();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const flag = (name) => process.argv.includes(`--${name}`);
const option = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const SELF_TEST = flag('self-test');
const DEBUG = flag('debug');
const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
const WEB_URL = pkg.homepage;

/** Permissions the page may have; everything else is refused. */
const PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);

app.setName(PRODUCT_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (flag('software-gl')) {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
} else if (!flag('low-power-gpu')) {
  // The renderer asks for powerPreference: 'high-performance' (Viewport.js),
  // which browsers on Windows mostly ignore: on a laptop with two GPUs the
  // scene stays on the integrated one. Here the whole app can be put on the
  // discrete GPU, which is what the page was asking for.
  app.commandLine.appendSwitch('force_high_performance_gpu');
}

if (SELF_TEST) {
  // A fresh profile every time, so nothing from an earlier run (a dismissed
  // hint, saved settings) changes what the test sees.
  const profile = join(tmpdir(), 'orrery-self-test');
  rmSync(profile, { recursive: true, force: true });
  app.setPath('userData', profile);
} else if (!app.isPackaged) {
  // Keep development runs from sharing settings with an installed copy.
  app.setPath('userData', `${app.getPath('userData')} (development)`);
}

const webRoot = resolve(option('web-root') ?? (app.isPackaged ? join(app.getAppPath(), 'web') : REPO));

// In development, serve only what would be shipped, so a missing entry in
// scripts/lib/served.js shows up here rather than in a release.
const only = webRoot === REPO
  ? (await import(pathToFileURL(join(REPO, 'scripts/lib/served.js')).href)).SERVED
  : undefined;

const report = { problems: [] };
/** The main window's saved state (window-state.js); unset in a self-test. */
let windowState = null;

if (!SELF_TEST && !app.requestSingleInstanceLock()) {
  // Already running: that copy brings its window forward (see below).
  app.quit();
} else {
  start();
}

async function start() {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || SELF_TEST) app.quit();
  });
  app.on('web-contents-created', (_event, contents) => lockDown(contents));

  await app.whenReady();

  if (!existsSync(join(webRoot, 'index.html'))) {
    const message = `There is no index.html in ${webRoot}.` +
      (app.isPackaged ? '' : '\n\nTo run a staged copy, use npm run stage in desktop/ first.');
    if (SELF_TEST) console.error(`self-test: ${message}`);
    else dialog.showErrorBox(`${PRODUCT_NAME} could not start`, message);
    app.exit(1);
    return;
  }

  serve({
    root: webRoot,
    only,
    onMissing(path, reason) {
      console.warn(`[orrery] 404 ${path} (${reason})`);
      report.problems.push(`404 ${path} (${reason})`);
    },
  });

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(PERMISSIONS.has(permission) && isOwn(details.requestingUrl ?? ''));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) =>
    PERMISSIONS.has(permission) && origin?.replace(/\/$/, '') === ORIGIN);

  // window.orreryDesktop.requestFullscreen() (preload.cjs). A browser only
  // goes full screen in answer to a click or a key, never a controller button,
  // so the web app has to ask for one first; here the request can simply be
  // run as though the user had clicked.
  ipcMain.handle('orrery:request-fullscreen', (event) => {
    if (!isOwn(event.senderFrame?.url ?? '')) return false;
    return event.sender.executeJavaScript(
      "document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => true, () => false)",
      true
    );
  });

  installMenu({ webUrl: WEB_URL, sourceUrl: SOURCE_URL });
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
    website: WEB_URL,
    copyright: 'Adam Jarvis',
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  const state = SELF_TEST ? { width: 1280, height: 800, zoom: 0 } : loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 360,
    minHeight: 400,
    fullscreen: !SELF_TEST && (flag('fullscreen') || state.fullscreen || inGameMode()),
    title: PRODUCT_NAME,
    backgroundColor: BACKGROUND,
    show: false,
    // Windows takes the icon from the .exe once packaged; Linux has to be told.
    icon: process.platform === 'darwin' || (app.isPackaged && process.platform === 'win32')
      ? undefined
      : join(app.getAppPath(), 'build/icon.png'),
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--orrery-version=${app.getVersion()}`, `--orrery-web-url=${WEB_URL}`],
    },
  });

  // The page's <title> is written for a browser tab.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize();
    win.show();
  });

  const startUrl = `${ORIGIN}/${DEBUG ? '?debug' : ''}`;
  if (SELF_TEST) {
    selfTest(win, report, startUrl, option('screenshot'));
    return win;
  }

  windowState = trackWindowState(win);
  handleShortcuts(win, windowState.save);
  win.webContents.once('did-finish-load', () => win.webContents.setZoomLevel(state.zoom ?? 0));
  recoverFromCrashes(win);
  fallBackToSoftwareGl(win);
  if (DEBUG) win.webContents.openDevTools({ mode: 'detach' });

  win.loadURL(startUrl);
  return win;
}

/** Links out of the app open in the system browser; nothing else leaves it. */
function lockDown(contents) {
  contents.on('will-navigate', (event, url) => {
    if (isOwn(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function openExternal(url) {
  try {
    if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) shell.openExternal(url);
  } catch { /* not a URL */ }
}

function isOwn(url) {
  return url === ORIGIN || url.startsWith(`${ORIGIN}/`);
}

/**
 * A renderer crash (usually the GPU driver) reloads the page. A third within
 * a minute restarts the app on software rendering, and if it still happens
 * there, the page is left alone rather than reloaded forever.
 */
function recoverFromCrashes(win) {
  let recent = [];
  win.webContents.on('render-process-gone', (_event, { reason }) => {
    if (reason === 'clean-exit') return;
    const now = Date.now();
    recent = recent.filter((time) => now - time < 60_000).concat(now);
    if (recent.length < 3) {
      console.error(`[orrery] the page stopped (${reason}); reloading`);
      win.webContents.reload();
    } else if (!flag('software-gl')) {
      console.error(`[orrery] the page stopped (${reason}) again; restarting with software rendering`);
      restartWithSoftwareGl();
    } else {
      console.error(`[orrery] the page stopped (${reason}) again; giving up`);
    }
  });
}

/**
 * Where the GPU cannot give the page WebGL (a blocklisted driver, a remote
 * desktop, a GPU process that kept crashing), a browser can only show the
 * "WebGL unavailable" screen. The app can restart itself on SwiftShader
 * instead: slower, but it runs.
 */
function fallBackToSoftwareGl(win) {
  if (flag('software-gl')) return;
  win.webContents.on('did-finish-load', async () => {
    // main.js shows #unsupported synchronously, before the load event.
    const failed = await win.webContents
      .executeJavaScript("document.getElementById('unsupported')?.hidden === false")
      .catch(() => false);
    if (!failed) return;
    console.warn('[orrery] WebGL is unavailable on the GPU; restarting with software rendering');
    restartWithSoftwareGl();
  });
}

function restartWithSoftwareGl() {
  // Save the window's place first: app.exit() skips the close handlers.
  windowState?.flush();
  app.relaunch({ args: [...process.argv.slice(1), '--software-gl'] });
  app.exit(0);
}

/**
 * Steam Deck Game Mode (and Big Picture on other Linux machines) runs the app
 * under gamescope, where a window should fill the screen.
 */
function inGameMode() {
  const env = process.env;
  return Boolean(env.GAMESCOPE_WAYLAND_DISPLAY) || env.XDG_CURRENT_DESKTOP === 'gamescope' ||
    env.SteamGamepadUI === '1';
}
