/**
 * The controller legend: which buttons do what in the current context.
 *
 * It comes up when a controller connects or the bindings change (taking off,
 * starting a tour), then fades. While the controller is moving round the
 * interface it stays up, since that is when the way back out is easy to forget.
 *
 * A line above it carries news: a controller connecting or going, or a
 * full-screen request waiting on a key press.
 */

import { el } from './dom.js';
import { padGlyph, padName } from './padGlyphs.js';

/** How long the legend stays before fading, unless held up. */
const LINGER_MS = 7000;

/** Keep in step with the bindings in src/main.js and the list in HelpOverlay.js. */
const LEGENDS = {
  // Extras step aside on a short screen (style.css); the controls list has them all.
  orbit: [
    { buttons: ['ls'], text: 'Orbit' },
    { buttons: ['lt', 'rt'], text: 'Zoom' },
    { buttons: ['dpad-x'], text: 'Previous or next body' },
    { buttons: ['y'], text: 'Whole system', extra: true },
    { buttons: ['a'], text: 'Play or pause' },
    { buttons: ['lb', 'rb'], text: 'Time rate', extra: true },
    { buttons: ['x'], text: 'Fly' },
    { buttons: ['menu'], text: 'Menus' },
    { buttons: ['view'], text: 'Full screen', extra: true },
  ],
  tour: [
    { buttons: ['dpad-x'], text: 'Previous or next stop' },
    { buttons: ['ls'], text: 'Look around' },
    { buttons: ['b'], text: 'End the tour' },
    { buttons: ['menu'], text: 'Menus' },
    { buttons: ['view'], text: 'Full screen' },
  ],
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

  setFamily(family) {
    if (family === this.family) return;
    this.family = family;
    if (!this._noticeActive) this.title.textContent = padName(family);
    this._render();
  }

  /**
   * @param {'orbit'|'tour'|'flight'|'interface'|null} context Null puts it away.
   * @param {{sticky?: boolean}} [options] Sticky holds it up until the next call.
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

  /** Takes the news line down early. */
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
