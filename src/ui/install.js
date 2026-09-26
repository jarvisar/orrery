/**
 * Installing the app, where the browser offers it.
 *
 * Chromium offers installation through `beforeinstallprompt`, which can arrive
 * before any interface exists, so it is caught as soon as this module loads.
 * Other browsers never send it, and the install UI stays hidden there.
 */

/** Set once the toast has been shown, so it is never shown again. */
const OFFERED_KEY = 'orrery:install-offered';

let installPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

window.addEventListener('beforeinstallprompt', (event) => {
  // Until the toast has had its one showing, it replaces the browser's own
  // mini-infobar rather than stacking on top of it.
  if (!wasOffered()) event.preventDefault();
  installPrompt = event;
  notify();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  notify();
});

export function canInstall() {
  return Boolean(installPrompt);
}

/** Calls `listener` whenever canInstall() changes. Returns an unsubscribe function. */
export function onInstallChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

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
