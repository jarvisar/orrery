/**
 * Moving round the interface with a controller's D-pad.
 *
 * Spatial rather than in Tab order: pressing right goes to whatever is to the
 * right on screen, as on a television.
 *
 * Movement stays inside a scope - the whole page, or whichever menu, drawer or
 * dialog is open - so the D-pad cannot wander into the controls underneath.
 * The scope is re-read on every call.
 *
 * Nothing here listens to the controller; src/main.js calls in.
 */

const FOCUSABLE = [
  'button:not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  'input[type="range"]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Pixels one D-pad press scrolls a region with nothing further to move to. */
const SCROLL_STEP = 120;

export class FocusNavigator {
  /**
   * @param {object} options
   * @param {() => Element|null} options.scope The open surface, or null for the whole page.
   * @param {() => Element|null} [options.home] Where to start on the whole page.
   */
  constructor({ scope, home = () => null }) {
    this._scope = scope;
    this._home = home;
    this._last = null;
    this._scroller = { scope: null, from: null, node: null };
  }

  get scope() {
    return this._scope() ?? document.body;
  }

  /** The focused control, if it is one that can be navigated from. */
  get current() {
    const node = document.activeElement;
    return node && node !== document.body && this.scope.contains(node) && isNavigable(node) ? node : null;
  }

  /**
   * Moves focus into the scope if it is not there already: to the selected
   * item in a list, where it last was on the page, or the first control.
   * Returns the focused control.
   */
  ensure() {
    const current = this.current;
    if (current) {
      if (!this._scope()) this._last = current;
      return current;
    }
    const scope = this.scope;
    const candidates = this.candidates(scope);
    const target = scope === document.body
      ? [this._last, this._home()].find((node) => node && candidates.includes(node)) ?? candidates[0]
      : candidates.find((node) => node.matches('[aria-selected="true"], [aria-current="true"]')) ??
        candidates[0];
    if (target) focus(target);
    return target ?? null;
  }

  candidates(scope = this.scope) {
    return [...scope.querySelectorAll(FOCUSABLE)].filter(isNavigable);
  }

  /** @param {'up'|'down'|'left'|'right'} direction */
  move(direction) {
    const from = this.ensure();
    if (!from) return false;

    const vertical = direction === 'up' || direction === 'down';
    const sign = direction === 'down' || direction === 'right' ? 1 : -1;

    // A focused scrolling region scrolls to its end before focus leaves it.
    if (vertical && isScrollable(from) && canScroll(from, sign)) {
      from.scrollBy({ top: sign * SCROLL_STEP, behavior: 'smooth' });
      return true;
    }

    const origin = from.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    for (const node of this.candidates()) {
      if (node === from || node.contains(from) || from.contains(node)) continue;
      const score = distance(origin, node.getBoundingClientRect(), direction);
      if (score < bestScore) {
        best = node;
        bestScore = score;
      }
    }

    // Menus wrap round, as a native list does.
    if (!best && vertical && this.scope.matches('[role="listbox"], [role="menu"]')) {
      const all = this.candidates();
      best = sign > 0 ? all[0] : all[all.length - 1];
    }
    if (!best || best === from) return false;
    focus(best);
    if (!this._scope()) this._last = best;
    return true;
  }

  activate() {
    const node = this.ensure();
    if (!node || isRange(node)) return;
    node.click();
    // Some buttons let go of focus once pressed (the flight HUD's, so Space
    // does not press them again); a controller still needs somewhere to be.
    if (document.activeElement === document.body && isNavigable(node)) focus(node);
  }

  /** True when left and right should change the focused control's value rather than move. */
  get adjusting() {
    const node = this.current;
    return Boolean(node && isRange(node));
  }

  /**
   * Steps the focused slider by one notch. A slider can override this by
   * cancelling the `gamepadadjust` event, as the time-rate slider does.
   */
  adjust(delta) {
    const input = this.current;
    if (!input || !isRange(input)) return;
    const custom = new CustomEvent('gamepadadjust', { detail: delta, cancelable: true });
    if (!input.dispatchEvent(custom)) return;

    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const step = Number(input.step) || 1;
    // About twenty notches end to end, each a whole number of the slider's own steps.
    const notch = step * Math.max(1, Math.round((max - min) / 20 / step));
    const next = Math.min(max, Math.max(min, Number(input.value) + delta * notch));
    if (next === Number(input.value)) return;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Scrolls whatever region holds focus, or the scope's own, by `pixels`. */
  scroll(pixels) {
    const node = this._scrollerFor(this.current);
    node?.scrollBy({ top: pixels });
  }

  /** Lets go of focus, for when the controller goes back to flying the camera. */
  release() {
    const node = document.activeElement;
    if (node && node !== document.body) node.blur();
  }

  /** Cached per scope and focus, not looked up every frame the stick is held. */
  _scrollerFor(from) {
    const scope = this.scope;
    const cache = this._scroller;
    if (cache.scope === scope && cache.from === from && cache.node?.isConnected) return cache.node;

    let node = null;
    for (let n = from; n && n !== scope.parentElement; n = n.parentElement) {
      if (isScrollable(n)) { node = n; break; }
    }
    if (!node) node = [scope, ...scope.querySelectorAll('*')].find(isScrollable) ?? null;
    Object.assign(cache, { scope, from, node });
    return node;
  }
}

/**
 * How far `to` is from `from` in a direction, or Infinity if it is not that
 * way. Being out of line weighs three times the gap, so right prefers the
 * same row over a nearer diagonal.
 */
function distance(from, to, direction) {
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'right' || direction === 'down' ? 1 : -1;
  const along = horizontal
    ? (to.left + to.right - from.left - from.right) / 2
    : (to.top + to.bottom - from.top - from.bottom) / 2;
  if (along * sign <= 1) return Infinity;

  const gap = Math.max(0, horizontal
    ? (sign > 0 ? to.left - from.right : from.left - to.right)
    : (sign > 0 ? to.top - from.bottom : from.top - to.bottom));
  // Zero when the two overlap across the direction of travel.
  const offset = horizontal
    ? Math.max(0, Math.max(from.top, to.top) - Math.min(from.bottom, to.bottom))
    : Math.max(0, Math.max(from.left, to.left) - Math.min(from.right, to.right));
  const centreOffset = horizontal
    ? Math.abs((to.top + to.bottom - from.top - from.bottom) / 2)
    : Math.abs((to.left + to.right - from.left - from.right) / 2);
  return gap + offset * 3 + centreOffset * 0.1;
}

/** On screen, enabled, and not inside anything hidden, faded out or switched off. */
export function isNavigable(node) {
  if (node.disabled) return false;
  if (node.closest('[hidden], [inert], [aria-hidden="true"], [data-gamepad-skip]')) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) {
    // Off screen is fine inside a scrolling list; focusing it scrolls it in.
    if (!node.parentElement?.closest('[role="listbox"], [role="menu"], .drawer__body, .help__body, .info__body, .when, .systems__scroll')) {
      return false;
    }
  }
  for (let n = node; n; n = n.parentElement) {
    const style = getComputedStyle(n);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
  }
  return true;
}

function isRange(node) {
  return node.tagName === 'INPUT' && node.type === 'range';
}

function isScrollable(node) {
  if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight + 1) return false;
  const overflow = getComputedStyle(node).overflowY;
  return overflow === 'auto' || overflow === 'scroll';
}

function canScroll(node, sign) {
  return sign > 0
    ? node.scrollTop + node.clientHeight < node.scrollHeight - 1
    : node.scrollTop > 0;
}

/** Focusing scrolls a list to bring the control into view; focusVisible asks for the ring. */
function focus(node) {
  node.focus({ focusVisible: true });
}
