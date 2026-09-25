/**
 * The controller legend: which buttons do what, for whatever you are doing.
 *
 * It comes up when a controller connects and whenever what the buttons do
 * changes - taking off, starting a tour - then fades, the way the first-visit
 * hint does. While the controller is moving round the interface it stays up,
 * since that is exactly when the way back out is easy to forget; once a menu
 * or panel is open it steps aside, as those explain themselves.
 *
 * A short line above it carries news: a controller connecting or going, or a
 * full-screen request waiting on a key press.
 */

import { el } from './dom.js';
import { padGlyph, padName } from './padGlyphs.js';

/** Seconds the legend stays before fading, when it is not being held up. */
const LINGER_MS = 7000;

/** Keep in step with the bindings in src/main.js and the list in HelpOverlay.js. */
const LEGENDS = {
  orbit: [
    { buttons: ['ls'], text: 'Orbit' },
    { buttons: ['lt', 'rt'], text: 'Zoom' },
    { buttons: ['dpad-x'], text: 'Previous or next body' },
    { buttons: ['a'], text: 'Play or pause' },
    { buttons: ['x'], text: 'Fly' },
    { buttons: ['menu'], text: 'Menus' },
    { buttons: ['view'], text: 'Full screen' },
  ],
  tour: [
    { buttons: ['dpad-x'], text: 'Previous or next stop' },
    { buttons: ['ls'], text: 'Look around' },
    { buttons: ['b'], text: 'End the tour' },
    { buttons: ['menu'], text: 'Menus' },
    { buttons: ['view'], text: 'Full screen' },
  ],
  // Extras step aside where there is room for one line only (style.css).
  flight: [
    { buttons: ['ls'], text: 'Steer' },
    { buttons: ['rs'], text: 'Roll', extra: true },
    { buttons: ['lt', 'rt'], text: 'Throttle' },
    { buttons: ['a'], text: 'Boost' },
    { buttons: ['dpad-x'], text: 'Destination', extra: true },
    { buttons: ['y'], text: 'Autopilot' },
    { buttons: ['x'], text: 'Leave flight' },
  ],
  interface: [
    { buttons: ['dpad'], text: 'Move' },
    { buttons: ['a'], text: 'Press' },
    { buttons: ['b'], text: 'Back' },
    { buttons: ['menu'], text: 'Done' },
  ],
};

export class GamepadHud {
  constructor() {
    this.family = 'generic';
    this.context = null;
    this._rendered = null;
    this._noticeUntil = 0;

    this.title = el('div', { class: 'padbar__title', role: 'status' });
    this.list = el('div', { class: 'padbar__list' });
    this.root = el('div', { class: 'padbar', hidden: true }, [this.title, this.list]);
  }

  /** Redraws the glyphs for another make of controller. */
  setFamily(family) {
    if (family === this.family) return;
    this.family = family;
    if (!this._noticeActive) this.title.textContent = padName(family);
    this._render();
  }

  /**
   * Shows the legend for a context: 'orbit', 'tour', 'flight' or
   * 'interface', or with null puts it away. Sticky holds it up until the
   * next call; otherwise it fades after a few seconds.
   */
  show(context, { sticky = false } = {}) {
    this.context = context;
    this._render();
    if (context) this._reveal(sticky ? Infinity : LINGER_MS);
    else if (!this._noticeActive) this.hide();
  }

  /** A line of news over the legend for a few seconds; the legend comes too. */
  notice(text, ms = 4000) {
    this.title.textContent = text;
    this.title.classList.add('is-news');
    this._noticeUntil = performance.now() + ms;
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => {
      this.title.classList.remove('is-news');
      this.title.textContent = padName(this.family);
    }, ms);
    this._reveal(Math.max(ms, this._lingerLeft()));
  }

  /** Takes the news line down early, once what it was waiting on has happened. */
  clearNotice() {
    if (!this._noticeActive) return;
    clearTimeout(this._noticeTimer);
    this._noticeUntil = 0;
    this.title.classList.remove('is-news');
    this.title.textContent = padName(this.family);
    if (!this.context) this.hide();
  }

  hide() {
    clearTimeout(this._hideTimer);
    this._lingerUntil = 0;
    this.root.classList.remove('is-visible');
    this._hideTimer = setTimeout(() => { this.root.hidden = true; }, 400);
  }

  get _noticeActive() {
    return performance.now() < this._noticeUntil;
  }

  _lingerLeft() {
    return Math.max(0, (this._lingerUntil ?? 0) - performance.now());
  }

  _reveal(ms) {
    clearTimeout(this._hideTimer);
    this.root.hidden = false;
    this._lingerUntil = performance.now() + ms;
    requestAnimationFrame(() => this.root.classList.add('is-visible'));
    if (Number.isFinite(ms)) this._hideTimer = setTimeout(() => this.hide(), ms);
  }

  _render() {
    const key = `${this.context}/${this.family}`;
    if (key === this._rendered) return;
    this._rendered = key;
    if (!this.context) {
      this.list.replaceChildren();
      return;
    }
    this.root.classList.toggle('is-flight', this.context === 'flight');
    this.list.replaceChildren(
      ...LEGENDS[this.context].map(({ buttons, text, extra }) =>
        el('div', { class: extra ? 'padbar__row is-extra' : 'padbar__row' }, [
          el('span', { class: 'padbar__text', text }),
          el('span', { class: 'pad-group' }, buttons.map((button) => padGlyph(button, this.family))),
        ]))
    );
  }
}
