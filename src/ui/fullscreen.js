/**
 * Full screen, for the controller's View button.
 *
 * Browsers only grant full screen in answer to a click, a tap or a key press:
 * a controller's buttons do not count (Firefox bug 1740573, and Chrome is the
 * same). So a request from the controller goes straight through if there was
 * a click or key press in the last few seconds, and otherwise waits for the
 * next one - which the caller says on screen. Leaving full screen needs no
 * such permission.
 */

const root = document.documentElement;

/** How long a waiting request lasts before it is dropped, in milliseconds. */
const PENDING_MS = 10_000;

let pending = null;

/** False on iPhone, which only lets video go full screen. */
export function fullscreenSupported() {
  return Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
}

export function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

/** True while a request is waiting for a click or key press. */
export function fullscreenPending() {
  return pending !== null;
}

/**
 * Enters or leaves full screen. Resolves to what happened: 'entered',
 * 'exited', 'pending' (waiting for a click or key press), 'cancelled' (a
 * second press while waiting) or 'unsupported'.
 *
 * @param {object} [hooks]
 * @param {(entered: boolean) => void} [hooks.onPendingEnd] Called when a
 *   waiting request is answered, times out, or is cancelled.
 */
export async function toggleFullscreen({ onPendingEnd } = {}) {
  if (!fullscreenSupported()) return 'unsupported';
  if (pending) {
    pending.end(false);
    return 'cancelled';
  }
  if (isFullscreen()) {
    await exitFullscreen();
    return 'exited';
  }
  // Only ask when the browser would say yes; asking without a gesture logs a
  // warning in some browsers and throws in others. Where there is no way to
  // tell, ask and see.
  if (navigator.userActivation?.isActive !== false) {
    try {
      await requestFullscreen();
      return 'entered';
    } catch { /* no gesture after all */ }
  }
  waitForGesture(onPendingEnd);
  return 'pending';
}

function waitForGesture(onPendingEnd) {
  const options = { capture: true };
  let done = false;

  const stopWaiting = () => {
    clearTimeout(timer);
    window.removeEventListener('keydown', answer, options);
    window.removeEventListener('click', answer, options);
    pending = null;
  };
  const end = (entered) => {
    if (done) return;
    done = true;
    stopWaiting();
    onPendingEnd?.(entered);
  };

  function answer(event) {
    // Escape means no; and the key that answers is spent on this, rather than
    // also pausing time or whatever else it would do.
    if (event.type === 'keydown') {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') return end(false);
    }
    // Asked while this event's gesture is still fresh; answered once it settles.
    stopWaiting();
    requestFullscreen().then(() => end(true), () => end(false));
  }

  const timer = setTimeout(() => end(false), PENDING_MS);
  window.addEventListener('keydown', answer, options);
  window.addEventListener('click', answer, options);
  pending = { end };
}

function requestFullscreen() {
  if (root.requestFullscreen) return root.requestFullscreen({ navigationUI: 'hide' });
  // Safari on iPad before 16.4.
  root.webkitRequestFullscreen?.();
  return Promise.resolve();
}

function exitFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen().catch(() => {});
  document.webkitExitFullscreen?.();
  return Promise.resolve();
}
