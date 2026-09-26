/**
 * Keeping the app up to date, from the project's GitHub Releases.
 *
 * Two ways, depending on how the app was installed:
 *
 *   install  The Windows installer and the Linux AppImage replace themselves:
 *            electron-updater downloads the new release in the background and
 *            installs it when the app quits. Nothing is shown.
 *   notify   Everything else cannot: the portable .exe (electron-updater would
 *            install a second copy), macOS (unsigned builds cannot self-update),
 *            and the .deb and .tar.gz. These only check for a newer version and
 *            hand it to the page, which shows a small "Update available" toast
 *            (src/ui/UpdateToast.js) whose button opens the release page.
 *
 * Only published releases count: a draft is invisible to both. Nothing runs
 * in development, in a self-test, or with --no-updates, and no failure here is
 * ever more than a line in the log.
 *
 * ORRERY_UPDATE_FEED=<url> points both at another feed (a directory holding
 * latest.yml and the files it names), for testing an update end to end.
 */
import { app, BrowserWindow, ipcMain, net, shell } from 'electron';
import { SOURCE_URL } from './identity.js';

const RELEASE_FEED = `${SOURCE_URL}/releases/latest/download/`;
/** Long enough that checking never competes with loading the scene. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const log = (message) => console.log(`[orrery] update: ${String(message).split('\n')[0]}`);
const reason = (error) => error?.message ?? error;

/** 'install', 'notify' or 'off'. */
export function updateMode({ selfTest, disabled }) {
  if (!app.isPackaged || selfTest || disabled) return 'off';
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'notify' : 'install';
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'install';
  return 'notify';
}

/** A newer release the page has been told about, if any. */
let available = null;

/**
 * Registers what the page can ask (preload.cjs) and, unless `mode` is 'off',
 * starts checking.
 *
 * @param {'install' | 'notify' | 'off'} mode
 */
export function startUpdates(mode) {
  // Registered in every mode, so the page's calls always have an answer.
  ipcMain.handle('orrery:update-available', () => available);
  ipcMain.handle('orrery:open-release-page', () => {
    if (available) shell.openExternal(available.url);
  });

  if (mode === 'off') return;
  const feed = process.env.ORRERY_UPDATE_FEED || null;
  log(`${mode === 'install' ? 'installing' : 'announcing'} new versions from ${feed ?? 'GitHub Releases'}`);

  const check = mode === 'install' ? installer(feed) : announcer(feed);
  const run = () => check().catch((error) => log(`check failed: ${reason(error)}`));
  setTimeout(run, FIRST_CHECK_MS).unref?.();
  setInterval(run, CHECK_EVERY_MS).unref?.();
}

/** electron-updater, downloading in the background and installing on quit. */
function installer(feed) {
  let updater = null;
  return async () => {
    if (!updater) {
      const { default: electronUpdater } = await import('electron-updater');
      updater = electronUpdater.autoUpdater;
      // Its own errors arrive through the 'error' event below; only warnings
      // (a fallback to a full download, say) are worth passing on.
      updater.logger = { info: () => {}, warn: (m) => log(m), error: () => {}, debug: () => {} };
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.allowPrerelease = false;
      updater.disableWebInstaller = true;
      if (feed) updater.setFeedURL({ provider: 'generic', url: feed });
      // Without an 'error' listener an EventEmitter throws, which would take
      // the app down over a failed download.
      updater.on('error', (error) => log(`failed: ${reason(error)}`));
      updater.on('update-available', (info) => log(`${info.version} is available; downloading`));
      updater.on('update-not-available', () => log(`${app.getVersion()} is the latest`));
      updater.on('update-downloaded', (info) => log(`${info.version} downloaded; it installs when the app quits`));
    }
    // A failed check or download has already been reported through 'error';
    // the download's promise would otherwise reject with nothing to catch it.
    const result = await updater.checkForUpdates().catch(() => null);
    result?.downloadPromise?.catch(() => {});
  };
}

/** Reads the version from the release's latest.yml, and tells the page if it is newer. */
function announcer(feed) {
  return async () => {
    const base = feed ?? RELEASE_FEED;
    const response = await net.fetch(new URL('latest.yml', base).href, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`latest.yml answered ${response.status}`);
    const version = (await response.text()).match(/^version:\s*['"]?([^'"\s]+)/m)?.[1];
    if (!version) throw new Error('latest.yml has no version');

    if (!isNewer(version, app.getVersion())) {
      log(`${app.getVersion()} is the latest`);
      return;
    }
    log(`${version} is available`);
    available = {
      version,
      // A test feed stands in for the release page too, so a test can see the button work.
      url: feed ?? `${SOURCE_URL}/releases/tag/v${version}`,
    };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('orrery:update-available', available);
    }
  };
}

/** True if `a` is a later x.y.z than `b`. Pre-release suffixes are never offered. */
export function isNewer(a, b) {
  if (/-/.test(a)) return false;
  const parse = (version) => version.split('-')[0].split('.').map((part) => Number(part) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}
