/**
 * The one thing the page learns about being inside the desktop app:
 * `window.orreryDesktop`. The web app checks for it in the few places it
 * behaves differently (search src/ for orreryDesktop); in a browser it is
 * simply undefined.
 *
 * CommonJS because preload scripts in a sandboxed renderer cannot be modules.
 * The values arrive as command-line switches, set in main.js.
 */
const { contextBridge, ipcRenderer } = require('electron');

function argument(name) {
  const prefix = `--orrery-${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

contextBridge.exposeInMainWorld('orreryDesktop', Object.freeze({
  /** The app's version, e.g. "2.1.0". */
  version: argument('version'),
  /** 'win32', 'linux' or 'darwin'. */
  platform: process.platform,
  /** The public site, for links meant for other people. */
  webUrl: argument('web-url'),
  /**
   * Full screen with no click or key press needed first, as a browser would
   * insist (src/ui/fullscreen.js uses it for the controller's View button).
   * Resolves to whether it worked.
   */
  requestFullscreen: () => ipcRenderer.invoke('orrery:request-fullscreen'),
}));
