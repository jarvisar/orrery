/**
 * Playback controls for the simulation clock.
 *
 * The old build had a single hidden behaviour here - pressing space froze
 * rotation - and no way to see or set where in time you were. Since every
 * position is now a function of the date, the clock is worth exposing: you can
 * run the system backwards, jump to today, and watch the date advance.
 *
 * The rate is a continuous slider on a log scale, since the useful range runs
 * from real time to ten years a second - eight orders of magnitude. The named
 * presets are detents on it, and the , and . keys step between them.
 *
 * The date itself opens a small panel for going somewhere in time: any date,
 * a short list of moments worth seeing, and a link back to this one.
 */

import { el, icon } from './dom.js';
import { RATE_PRESETS, MIN_RATE, MAX_RATE } from '../sim/Clock.js';
import { daysSinceJ2000 } from '../sim/kepler.js';
import { MOMENTS } from '../data/moments.js';

/** Slider resolution. Fine enough that the step between positions is invisible. */
const STEPS = 1000;
/** How close, in slider steps, a drag has to come to a preset to snap onto it. */
const DETENT = 14;

const LOG_MIN = Math.log(MIN_RATE);
const LOG_SPAN = Math.log(MAX_RATE) - LOG_MIN;

const toSlider = (rate) => Math.round(((Math.log(rate) - LOG_MIN) / LOG_SPAN) * STEPS);
const fromSlider = (position) => Math.exp(LOG_MIN + (position / STEPS) * LOG_SPAN);
const PRESET_POSITIONS = RATE_PRESETS.map((preset) => toSlider(preset.daysPerSecond));

export class TimeBar {
  /**
   * @param {import('../sim/Clock.js').Clock} clock
   * @param {object} [hooks]
   * @param {(days: number, moment?: import('../data/moments.js').Moment) => void} [hooks.onJump]
   * @param {() => void} [hooks.onNow]
   * @param {() => Promise<void>} [hooks.onCopyLink]
   */
  constructor(clock, hooks = {}) {
    this.clock = clock;
    this.hooks = hooks;
    this.isOpen = false;

    this.dateMain = el('span', { class: 'timebar__date-main' });
    this.dateSub = el('span', { class: 'timebar__date-sub' });
    this.rateLabel = el('span', { class: 'timebar__rate' });

    this.playIcon = icon('play');
    this.playButton = el(
      'button',
      {
        class: 'btn btn--icon',
        type: 'button',
        title: 'Play or pause (Space)',
        'aria-label': 'Play or pause',
        onclick: () => this.togglePause(),
      },
      [this.playIcon]
    );

    this.rateSlider = el('input', {
      class: 'timebar__slider',
      type: 'range',
      min: 0,
      max: STEPS,
      step: 1,
      title: 'Time rate (, and .)',
      'aria-label': 'Time rate',
      oninput: (event) => this._onSlide(Number(event.target.value)),
    });

    this.reverseButton = el(
      'button',
      {
        class: 'btn btn--icon',
        type: 'button',
        title: 'Run time backwards (R)',
        'aria-label': 'Run time backwards',
        'aria-pressed': 'false',
        onclick: () => this.toggleDirection(),
      },
      [icon('reverse')]
    );

    this.nowButton = el('button', {
      class: 'btn',
      type: 'button',
      title: 'Jump to the present (N)',
      text: 'Now',
      onclick: () => this.jumpToNow(),
    });

    this.dateButton = el(
      'button',
      {
        class: 'timebar__date',
        type: 'button',
        title: 'Go to a date',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        onclick: (event) => { event.stopPropagation(); this.toggle(); },
      },
      [this.dateMain, this.dateSub]
    );
    this.panel = this._buildPanel();

    this.root = el('div', { class: 'timebar panel', role: 'group', 'aria-label': 'Time controls' }, [
      this.panel,
      this.dateButton,
      el('div', { class: 'timebar__divider' }),
      this.playButton,
      this.rateSlider,
      this.rateLabel,
      this.reverseButton,
      el('div', { class: 'timebar__divider' }),
      this.nowButton,
    ]);

    this.refresh();

    this._onDocumentClick = (event) => {
      if (this.isOpen && !this.panel.contains(event.target)) this.close();
    };
    document.addEventListener('click', this._onDocumentClick);
  }

  /* --- going somewhere in time ------------------------------------------- */

  _buildPanel() {
    this.dateInput = el('input', {
      class: 'when__input',
      type: 'date',
      min: '1800-01-01',
      max: '2050-12-31',
      'aria-label': 'Date',
      required: true,
    });
    this.timeInput = el('input', {
      class: 'when__input when__input--time',
      type: 'time',
      step: 60,
      'aria-label': 'Time, UTC',
    });

    const form = el(
      'form',
      {
        class: 'when__form',
        onsubmit: (event) => {
          event.preventDefault();
          const [year, month, day] = this.dateInput.value.split('-').map(Number);
          if (!year) return;
          const [hours, minutes] = (this.timeInput.value || '12:00').split(':').map(Number);
          const date = new Date(Date.UTC(2000, month - 1, day, hours, minutes));
          date.setUTCFullYear(year);
          this.close();
          this.hooks.onJump?.(daysSinceJ2000(date));
        },
      },
      [
        this.dateInput,
        this.timeInput,
        el('button', { class: 'btn when__go', type: 'submit', text: 'Go' }),
      ]
    );

    const moments = MOMENTS.map((moment) => {
      const date = new Date(moment.date);
      return el(
        'button',
        {
          class: 'moment',
          type: 'button',
          onclick: () => {
            this.close();
            this.hooks.onJump?.(daysSinceJ2000(date), moment);
          },
        },
        [
          el('span', {
            class: 'moment__date',
            text: date.toLocaleDateString(undefined, {
              day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
            }),
          }),
          el('span', { class: 'moment__title', text: moment.title }),
          el('span', { class: 'moment__note', text: moment.note }),
        ]
      );
    });

    this.copyStatus = el('span', { class: 'when__status', 'aria-live': 'polite' });
    const copy = el(
      'button',
      {
        class: 'btn btn--text when__copy',
        type: 'button',
        onclick: async () => {
          try {
            await this.hooks.onCopyLink?.();
            this.copyStatus.textContent = 'Copied';
          } catch {
            this.copyStatus.textContent = 'Could not copy';
          }
          clearTimeout(this._statusTimer);
          this._statusTimer = setTimeout(() => { this.copyStatus.textContent = ''; }, 2200);
        },
      },
      [icon('link', 15), el('span', { text: 'Copy a link to this moment' })]
    );

    return el(
      'div',
      { class: 'when', role: 'dialog', 'aria-label': 'Go to a date', hidden: true },
      [
        el('h3', { class: 'section-title', text: 'Go to' }),
        form,
        el('p', { class: 'when__hint', text: 'Times are UTC. Positions are most accurate between 1800 and 2050.' }),
        el('h3', { class: 'section-title', text: 'Moments' }),
        el('div', { class: 'when__moments' }, moments),
        el('div', { class: 'when__footer' }, [copy, this.copyStatus]),
      ]
    );
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    const date = this.clock.date;
    const iso = Number.isNaN(date.getTime()) ? '' : date.toISOString();
    // Years outside 0000-9999 come back as +YYYYYY, which a date input rejects.
    if (/^\d{4}-/.test(iso)) {
      this.dateInput.value = iso.slice(0, 10);
      this.timeInput.value = iso.slice(11, 16);
    }
    this.isOpen = true;
    this.panel.hidden = false;
    this.dateButton.setAttribute('aria-expanded', 'true');
    this.root.classList.add('is-open');
  }

  close({ restoreFocus = false } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panel.hidden = true;
    this.dateButton.setAttribute('aria-expanded', 'false');
    this.root.classList.remove('is-open');
    if (restoreFocus) this.dateButton.focus();
  }

  jumpToNow() {
    if (this.hooks.onNow) this.hooks.onNow();
    else this.clock.jumpToNow();
    this.refresh();
  }

  togglePause() {
    this.clock.paused = !this.clock.paused;
    this.refresh();
  }

  toggleDirection() {
    this.clock.direction *= -1;
    this.refresh();
  }

  /** Moves to the next preset faster (+1) or slower (-1) than the current rate. */
  stepRate(delta) {
    const current = this.clock.daysPerSecond;
    const presets = delta > 0 ? RATE_PRESETS : [...RATE_PRESETS].reverse();
    // A small tolerance, so sitting on a preset steps past it rather than to it.
    const next = presets.find((preset) =>
      delta > 0 ? preset.daysPerSecond > current * 1.001 : preset.daysPerSecond < current / 1.001
    );
    if (!next) return;
    this.clock.setRate(next.daysPerSecond);
    this.refresh();
  }

  _onSlide(position) {
    const nearest = PRESET_POSITIONS.reduce((best, p, i) =>
      Math.abs(p - position) < Math.abs(PRESET_POSITIONS[best] - position) ? i : best, 0);
    const snapped = Math.abs(PRESET_POSITIONS[nearest] - position) <= DETENT;

    this.clock.setRate(snapped ? RATE_PRESETS[nearest].daysPerSecond : fromSlider(position));
    this.refresh({ fromSlider: true });
  }

  /** Updates the icons and labels that only change on interaction. */
  refresh({ fromSlider = false } = {}) {
    const paused = this.clock.paused;
    this.playIcon.replaceWith((this.playIcon = icon(paused ? 'play' : 'pause')));
    this.playButton.setAttribute('aria-label', paused ? 'Play' : 'Pause');

    const reversed = this.clock.direction < 0;
    this.reverseButton.setAttribute('aria-pressed', String(reversed));
    this.reverseButton.classList.toggle('is-active', reversed);

    const description = this.clock.describeRate();
    this.rateLabel.textContent = description;
    this.rateSlider.setAttribute('aria-valuetext', description);
    // Leave the thumb where the pointer is mid-drag; only snap it for detents
    // and keyboard steps, where there is no pointer to fight.
    const position = toSlider(this.clock.daysPerSecond);
    if (!fromSlider || PRESET_POSITIONS.includes(position)) this.rateSlider.value = position;

    this.tick();
  }

  /** Refreshes the date readout. Cheap enough to call a few times a second. */
  tick() {
    const date = this.clock.formatDate();
    if (this.dateMain.textContent !== date) this.dateMain.textContent = date;
    const time = `${this.clock.formatTime()} UTC`;
    if (this.dateSub.textContent !== time) this.dateSub.textContent = time;
  }
}
