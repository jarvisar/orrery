/**
 * Guided tours.
 *
 * A tour flies from body to body and holds on each long enough to read one
 * caption, with the camera drifting slowly round it. It is a slideshow with
 * the real scene as the slides: time keeps running, and everything can still
 * be dragged and zoomed while it plays. Clicking some other body, or Escape,
 * ends it.
 *
 * Two elements: the menu that lives in the top bar, and the caption card that
 * takes the info panel's place while a tour is running.
 */

import { el, icon } from './dom.js';
import { TOURS, TOUR_BY_ID } from '../data/tours.js';
import { BODY_BY_ID } from '../data/bodies.js';

/** Seconds a flight between stops takes. */
const FLIGHT_SECONDS = 2.6;

export class TourGuide {
  /**
   * @param {object} hooks
   * @param {(id: string, options: {duration: number, instant: boolean}) => void} hooks.visit
   * @param {(touring: boolean) => void} hooks.onChange
   * @param {() => boolean} hooks.reduceMotion
   * @param {(id: string) => boolean} hooks.canVisit False for bodies switched off in Settings.
   */
  constructor({ visit, onChange, reduceMotion, canVisit }) {
    this.visit = visit;
    this.onChange = onChange;
    this.reduceMotion = reduceMotion;
    this.canVisit = canVisit;

    this.tour = null;
    /** The tour's stops, less any whose body is hidden right now. */
    this.stops = [];
    this.index = 0;
    this.playing = true;
    this.isOpen = false;
    this._elapsed = 0;
    this._flight = 0;
    this._hold = 0;

    this._buildMenu();
    this._buildCaption();

    this._onDocumentClick = (event) => { if (!this.root.contains(event.target)) this.closeMenu(); };
    document.addEventListener('click', this._onDocumentClick);
  }

  /* --- menu -------------------------------------------------------------- */

  _buildMenu() {
    this.button = el(
      'button',
      {
        class: 'btn tours__button',
        type: 'button',
        title: 'Guided tours (T)',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        onclick: (event) => { event.stopPropagation(); this.toggleMenu(); },
      },
      [icon('route', 16), el('span', { class: 'tours__label', text: 'Tours' })]
    );

    this.menu = el(
      'div',
      { class: 'tours__menu', role: 'menu', hidden: true },
      [
        el('div', { class: 'tours__heading', text: 'Guided tours' }),
        ...TOURS.map((tour) =>
          el(
            'button',
            {
              class: 'tours__item',
              type: 'button',
              role: 'menuitem',
              onclick: () => { this.closeMenu(); this.start(tour.id); },
            },
            [
              el('span', { class: 'tours__item-title', text: tour.title }),
              el('span', { class: 'tours__item-summary', text: tour.summary }),
              el('span', { class: 'tours__item-meta', text: `${tour.stops.length} stops` }),
            ]
          )
        ),
      ]
    );

    this.root = el('div', { class: 'tours' }, [this.button, this.menu]);
  }

  toggleMenu() {
    this.isOpen ? this.closeMenu() : this.openMenu();
  }

  openMenu() {
    this.isOpen = true;
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.menu.querySelector('button')?.focus({ preventScroll: true });
  }

  closeMenu({ restoreFocus = false } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.button.focus();
  }

  /* --- caption ----------------------------------------------------------- */

  _buildCaption() {
    this.eyebrow = el('div', { class: 'tour__eyebrow' });
    this.heading = el('h2', { class: 'tour__title' });
    this.text = el('p', { class: 'tour__text' });
    this.progress = el('div', { class: 'tour__progress' });

    this.prevButton = el(
      'button',
      { class: 'btn btn--icon', type: 'button', 'aria-label': 'Previous stop', onclick: () => this.step(-1) },
      [icon('back')]
    );
    this.playIcon = icon('pause');
    this.playButton = el(
      'button',
      { class: 'btn btn--icon', type: 'button', 'aria-label': 'Pause the tour', onclick: () => this.togglePlaying() },
      [this.playIcon]
    );
    this.nextButton = el(
      'button',
      { class: 'btn btn--icon', type: 'button', 'aria-label': 'Next stop', onclick: () => this.step(1) },
      [icon('next')]
    );

    this.caption = el(
      'section',
      { class: 'tour panel', 'aria-live': 'polite', 'aria-label': 'Tour', hidden: true },
      [
        el('div', { class: 'tour__top' }, [
          this.eyebrow,
          el(
            'button',
            { class: 'btn btn--icon tour__close', type: 'button', 'aria-label': 'End the tour', onclick: () => this.stop() },
            [icon('close', 16)]
          ),
        ]),
        this.heading,
        this.text,
        el('div', { class: 'tour__controls' }, [
          this.prevButton, this.playButton, this.nextButton,
          el('div', { class: 'tour__track' }, [this.progress]),
        ]),
      ]
    );
  }

  /* --- playback ---------------------------------------------------------- */

  start(tourId) {
    const tour = TOUR_BY_ID.get(tourId);
    if (!tour) return;
    this.stops = tour.stops.filter((stop) => this.canVisit(stop.body));
    if (this.stops.length === 0) return;
    this.tour = tour;
    this.playing = true;
    this.caption.hidden = false;
    this.onChange(true);
    this._go(0);
  }

  stop() {
    if (!this.tour) return;
    this.tour = null;
    this.caption.hidden = true;
    this.onChange(false);
  }

  step(delta) {
    if (!this.tour) return;
    const next = this.index + delta;
    if (next < 0) return;
    if (next >= this.stops.length) {
      this.stop();
      return;
    }
    this._go(next);
  }

  togglePlaying() {
    this.playing = !this.playing;
    this._syncControls();
  }

  _go(index) {
    this.index = index;
    const stop = this.stops[index];
    const body = BODY_BY_ID.get(stop.body);
    const instant = this.reduceMotion();

    this._flight = instant ? 0 : FLIGHT_SECONDS;
    this._hold = stop.hold ?? readingTime(stop.text);
    this._elapsed = 0;
    this.visit(stop.body, { duration: FLIGHT_SECONDS, instant });

    this.eyebrow.replaceChildren(
      el('span', { text: this.tour.title }),
      el('span', { class: 'tour__count', text: `${index + 1} / ${this.stops.length}` })
    );
    this.heading.textContent = body?.name ?? stop.body;
    this.caption.style.setProperty('--body-color', body?.color ?? '#ffffff');
    this.text.textContent = stop.text;

    // Restart the entrance animation for the new text.
    this.caption.classList.remove('is-entering');
    void this.caption.offsetWidth;
    this.caption.classList.add('is-entering');

    this._syncControls();
  }

  _syncControls() {
    const last = this.index === this.stops.length - 1;
    this.prevButton.disabled = this.index === 0;
    this.nextButton.replaceChildren(icon(last ? 'check' : 'next'));
    this.nextButton.setAttribute('aria-label', last ? 'Finish the tour' : 'Next stop');
    this.playIcon.replaceWith((this.playIcon = icon(this.playing ? 'pause' : 'play')));
    this.playButton.setAttribute('aria-label', this.playing ? 'Pause the tour' : 'Resume the tour');
    this.caption.classList.toggle('is-paused', !this.playing);
  }

  /** Called every frame. Holds count from arrival, not from departure. */
  update(dt) {
    if (!this.tour) return;
    if (this.playing) this._elapsed += dt;

    const held = Math.max(0, this._elapsed - this._flight);
    const fraction = Math.min(1, held / this._hold);
    this.progress.style.transform = `scaleX(${fraction.toFixed(4)})`;

    // The last stop waits to be dismissed rather than vanishing on its own.
    const last = this.index === this.stops.length - 1;
    if (this.playing && fraction >= 1 && !last) this._go(this.index + 1);
  }

  dispose() {
    document.removeEventListener('click', this._onDocumentClick);
  }
}

/** Long enough to read the caption twice at a relaxed pace, within bounds. */
function readingTime(text) {
  const words = text.split(/\s+/).length;
  return Math.min(18, Math.max(8, 3 + words * 0.3));
}
