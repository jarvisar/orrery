/**
 * Remembers the window between runs: where it was, how big, whether it was
 * maximised or full screen, and the zoom level.
 */
import { app, screen } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = { width: 1280, height: 800, maximized: false, fullscreen: false, zoom: 0 };

const file = () => join(app.getPath('userData'), 'window-state.json');

export function loadWindowState() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(file(), 'utf8'));
  } catch { /* first run, or unreadable: start from the defaults */ }

  const state = { ...DEFAULTS };
  for (const key of ['width', 'height', 'x', 'y', 'zoom']) {
    if (Number.isFinite(saved[key])) state[key] = saved[key];
  }
  state.maximized = saved.maximized === true;
  state.fullscreen = saved.fullscreen === true;

  // A monitor that has since been unplugged would put the window off screen.
  if (state.x !== undefined && state.y !== undefined && !onSomeDisplay(state)) {
    delete state.x;
    delete state.y;
  }
  return state;
}

/** Saves the window's state whenever it settles, and when it closes. */
export function trackWindowState(win) {
  let timer = 0;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    const state = {
      ...bounds,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      zoom: win.webContents.getZoomLevel(),
    };
    try {
      writeFileSync(file(), JSON.stringify(state));
    } catch (error) {
      console.warn('[orrery] could not save the window state', error);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 1000);
  };

  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, later);
  }
  win.webContents.on('zoom-changed', later);
  win.on('close', save);
  /** `save` soon, after a burst of changes; `flush` now. */
  return { save: later, flush: save };
}

function onSomeDisplay({ x, y, width, height }) {
  return screen.getAllDisplays().some(({ workArea: area }) => {
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    // Enough of the title bar showing to grab it.
    return overlapX >= 100 && overlapY >= 40;
  });
}
