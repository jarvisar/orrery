/**
 * Menus and the few browser shortcuts worth keeping.
 *
 * macOS gets a standard menu bar, since that is where Quit, Hide, copy and
 * paste live there. Windows and Linux get none at all: the scene is edge to
 * edge, and a menu bar that appears on Alt would steal the arrow keys the app
 * uses. The same shortcuts are handled directly on those platforms instead.
 */
import { Menu, shell } from 'electron';

const ZOOM_STEP = 0.5;
const ZOOM_LIMIT = 3;

/** @param {{ webUrl: string, sourceUrl: string }} links */
export function installMenu({ webUrl, sourceUrl }) {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Orrery on the Web', click: () => shell.openExternal(webUrl) },
        { label: 'Source Code', click: () => shell.openExternal(sourceUrl) },
      ],
    },
  ]));
}

/**
 * Windows and Linux: F11 full screen, F5 / Ctrl+R reload, F12 /
 * Ctrl+Shift+I developer tools, Ctrl+plus / minus / 0 zoom. A handled key
 * never reaches the page; every other key does, untouched.
 *
 * @param {Electron.BrowserWindow} win
 * @param {() => void} onChange Called after anything worth saving changes.
 */
export function handleShortcuts(win, onChange) {
  if (process.platform === 'darwin') return;
  const contents = win.webContents;

  const zoom = (level) => {
    contents.setZoomLevel(Math.max(-ZOOM_LIMIT, Math.min(ZOOM_LIMIT, level)));
    onChange();
  };

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;

    let action = null;
    if (key === 'F11') action = () => win.setFullScreen(!win.isFullScreen());
    else if (key === 'F5' || (ctrl && key === 'r')) {
      action = input.shift ? () => contents.reloadIgnoringCache() : () => contents.reload();
    } else if (key === 'F12' || (ctrl && input.shift && key === 'i')) action = () => contents.toggleDevTools();
    else if (ctrl && (key === '=' || key === '+')) action = () => zoom(contents.getZoomLevel() + ZOOM_STEP);
    else if (ctrl && key === '-') action = () => zoom(contents.getZoomLevel() - ZOOM_STEP);
    else if (ctrl && key === '0') action = () => zoom(0);

    if (action) {
      event.preventDefault();
      action();
    }
  });
}
