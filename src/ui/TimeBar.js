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
 */

import { el, icon } from './dom.js';
import { RATE_PRESETS, MIN_RATE, MAX_RATE } from '../sim/Clock.js';

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
  /** @param {import('../sim/Clock.js').Clock} clock */
  constructor(clock) {
    this.clock = clock;

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
      onclick: () => { this.clock.jumpToNow(); this.refresh(); },
    });

    this.root = el('div', { class: 'timebar panel', role: 'group', 'aria-label': 'Time controls' }, [
      el('div', { class: 'timebar__date' }, [this.dateMain, this.dateSub]),
      el('div', { class: 'timebar__divider' }),
      this.playButton,
      this.rateSlider,
      this.rateLabel,
      this.reverseButton,
      el('div', { class: 'timebar__divider' }),
      this.nowButton,
    ]);

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
