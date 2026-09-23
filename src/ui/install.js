/**
 * Installing the app, where the browser offers it.
 *
 * Chromium offers installation through `beforeinstallprompt`, which can arrive
 * before any interface exists, so it is caught as soon as this module loads.
 * Other browsers never send it, and everything that offers installation simply
 * stays hidden there.
 *
 * Two things offer it: a one-off toast on the first visit where it is possible,
 * and a link in the settings panel for any time after.
 */

/** Set once the toast has been shown, so it is never shown again. */
const OFFERED_KEY = 'orrery:install-offered';

let installPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

window.addEventListener('beforeinstallprompt', (event) => {
  // Until the toast has had its one showing, it stands in for the browser's own
  // mini-infobar rather than stacking on top of it. After that the browser's
  // prompt shows as usual, and the settings link is a second way in.
  if (!wasOffered()) event.preventDefault();
  installPrompt = event;
  notify();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  notify();
});

/** True while the browser is offering installation. */
export function canInstall() {
  return Boolean(installPrompt);
}

/** Calls `listener` whenever that changes. Returns an unsubscribe function. */
export function onInstallChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows the browser's install dialog. */
export async function install() {
  const prompt = installPrompt;
  if (!prompt) return;
  // A prompt event can only be used once, whatever the answer.
  installPrompt = null;
  notify();
  await prompt.prompt();
}

export function wasOffered() {
  try { return localStorage.getItem(OFFERED_KEY) === '1'; } catch { return false; }
}

export function markOffered() {
  try { localStorage.setItem(OFFERED_KEY, '1'); } catch { /* storage blocked: it may offer again */ }
}
