/**
 * Playback controls for the simulation clock.
 *
 * The old build had a single hidden behaviour here - pressing space froze
 * rotation - and no way to see or set where in time you were. Since every
 * position is now a function of the date, the clock is worth exposing: you can
 * run the system backwards, jump to today, and watch the date advance.
 */

import { el, icon } from './dom.js';
import { RATE_PRESETS, DEFAULT_RATE_INDEX } from '../sim/Clock.js';

export class TimeBar {
  /** @param {import('../sim/Clock.js').Clock} clock */
  constructor(clock, { onChange } = {}) {
    this.clock = clock;
    this.onChange = onChange;
    this._rateIndex = RATE_PRESETS.findIndex(
      (preset) => preset.daysPerSecond === clock.daysPerSecond
    );
    if (this._rateIndex < 0) this._rateIndex = DEFAULT_RATE_INDEX;

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

    this.slowButton = el(
      'button',
      {
        class: 'btn btn--icon',
        type: 'button',
        title: 'Slower (,)',
        'aria-label': 'Slower',
        onclick: () => this.stepRate(-1),
      },
      [icon('rewind')]
    );

    this.fastButton = el(
      'button',
      {
        class: 'btn btn--icon',
        type: 'button',
        title: 'Faster (.)',
        'aria-label': 'Faster',
        onclick: () => this.stepRate(1),
      },
      [icon('forward')]
    );

    this.reverseButton = el('button', {
      class: 'btn',
      type: 'button',
      title: 'Run time backwards',
      'aria-pressed': 'false',
      text: '−1×',
      onclick: () => this.toggleDirection(),
    });

    this.nowButton = el('button', {
      class: 'btn',
      type: 'button',
      title: 'Jump to the present',
      text: 'Now',
      onclick: () => { this.clock.jumpToNow(); this.refresh(); this.onChange?.(); },
    });

    this.root = el('div', { class: 'timebar panel', role: 'group', 'aria-label': 'Time controls' }, [
      el('div', { class: 'timebar__date' }, [this.dateMain, this.dateSub]),
      el('div', { class: 'timebar__divider' }),
      this.slowButton,
      this.playButton,
      this.fastButton,
      this.rateLabel,
      el('div', { class: 'timebar__divider' }),
      this.reverseButton,
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

  stepRate(delta) {
    this._rateIndex = Math.max(0, Math.min(RATE_PRESETS.length - 1, this._rateIndex + delta));
    this.clock.daysPerSecond = RATE_PRESETS[this._rateIndex].daysPerSecond;
    this.refresh();
  }

  /** Updates the icons and labels that only change on interaction. */
  refresh() {
    const paused = this.clock.paused;
    this.playIcon.replaceWith((this.playIcon = icon(paused ? 'play' : 'pause')));
    this.playButton.setAttribute('aria-label', paused ? 'Play' : 'Pause');

    const reversed = this.clock.direction < 0;
    this.reverseButton.setAttribute('aria-pressed', String(reversed));
    this.reverseButton.classList.toggle('is-active', reversed);

    this.slowButton.disabled = this._rateIndex === 0;
    this.fastButton.disabled = this._rateIndex === RATE_PRESETS.length - 1;
    this.rateLabel.textContent = this.clock.describeRate();

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
