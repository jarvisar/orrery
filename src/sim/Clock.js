/**
 * The simulation clock.
 *
 * Everything in the scene is a pure function of `days` - the simulated time in
 * days since J2000. Nothing accumulates rotation frame by frame, so pausing,
 * reversing or jumping to a date all work without the system drifting out of
 * alignment, and the same date always produces the same sky.
 */

import { daysSinceJ2000, dateFromDays } from './kepler.js';

/**
 * Simulated days per real-world second at the named stops. The rate itself is
 * continuous - the time bar's slider covers everything between the first and
 * last of these - but these are where the slider detents and what the , and .
 * keys step between.
 */
export const RATE_PRESETS = [
  { label: 'Real time', daysPerSecond: 1 / 86_400 },
  { label: '1 min/s', daysPerSecond: 1 / 1440 },
  { label: '10 min/s', daysPerSecond: 1 / 144 },
  { label: '1 hour/s', daysPerSecond: 1 / 24 },
  { label: '6 hours/s', daysPerSecond: 0.25 },
  { label: '1 day/s', daysPerSecond: 1 },
  { label: '1 week/s', daysPerSecond: 7 },
  { label: '1 month/s', daysPerSecond: 30.44 },
  { label: '1 year/s', daysPerSecond: 365.25 },
  { label: '10 years/s', daysPerSecond: 3652.5 },
];

export const MIN_RATE = RATE_PRESETS[0].daysPerSecond;
export const MAX_RATE = RATE_PRESETS[RATE_PRESETS.length - 1].daysPerSecond;

/**
 * One simulated hour per second. Earth turns once every 24 seconds and the
 * Moon visibly creeps along its orbit, so the scene is alive without anything
 * spinning faster than the eye can follow. Faster rates are for watching
 * orbits, and there the planets' own rotation turns into a blur regardless.
 */
export const DEFAULT_RATE_INDEX = 3;

/** Units for the rate readout, largest first. */
const RATE_UNITS = [
  { days: 365.25, singular: 'year', plural: 'years' },
  { days: 30.44, singular: 'month', plural: 'months' },
  { days: 7, singular: 'week', plural: 'weeks' },
  { days: 1, singular: 'day', plural: 'days' },
  { days: 1 / 24, singular: 'hour', plural: 'hours' },
  { days: 1 / 1440, singular: 'min', plural: 'min' },
  { days: 1 / 86_400, singular: 'sec', plural: 'sec' },
];

export class Clock {
  constructor() {
    this.days = daysSinceJ2000(new Date());
    this.daysPerSecond = RATE_PRESETS[DEFAULT_RATE_INDEX].daysPerSecond;
    this.direction = 1;
    this.paused = false;
    /** Set while an animated jump is under way; see travelTo(). */
    this._travel = null;
  }

  advance(deltaSeconds) {
    if (this._travel) {
      const travel = this._travel;
      travel.elapsed += deltaSeconds;
      const t = Math.min(1, travel.elapsed / travel.seconds);
      // Smootherstep: starts and lands gently, so the jump reads as a sweep
      // through time rather than a cut.
      const k = t * t * t * (t * (t * 6 - 15) + 10);
      this.days = travel.from + (travel.to - travel.from) * k;
      if (t >= 1) this._travel = null;
      return;
    }
    if (this.paused) return;
    this.days += deltaSeconds * this.daysPerSecond * this.direction;
  }

  /**
   * Moves to another moment over a second or two instead of cutting to it, so
   * the planets visibly sweep round to where they were. A jump of a day takes
   * under a second; a century takes a little over two.
   */
  travelTo(days, { instant = false } = {}) {
    if (instant || !Number.isFinite(days)) {
      this._travel = null;
      if (Number.isFinite(days)) this.days = days;
      return;
    }
    const span = Math.abs(days - this.days);
    const seconds = Math.min(2.4, 0.55 + 0.36 * Math.log10(1 + span));
    this._travel = { from: this.days, to: days, elapsed: 0, seconds };
  }

  /** True while an animated jump is still playing. */
  get isTravelling() {
    return this._travel !== null;
  }

  /** The simulated instant, as a real Date. */
  get date() {
    return dateFromDays(this.days);
  }

  set date(value) {
    this.days = daysSinceJ2000(value);
  }

  /** Sets the speed, keeping the current direction. Clamped to the preset range. */
  setRate(daysPerSecond) {
    this.daysPerSecond = Math.min(MAX_RATE, Math.max(MIN_RATE, daysPerSecond));
  }

  jumpToNow(options) {
    this.travelTo(daysSinceJ2000(new Date()), options);
  }

  /** Signed rate, for display. */
  get signedRate() {
    return this.daysPerSecond * this.direction;
  }

  /**
   * A human-readable version of the current rate. Uses the preset's own label
   * when the rate sits on one, so the readout says "1 month/s" rather than the
   * arithmetically equal but unfamiliar "4.3 weeks/s"; anything in between is
   * given in the largest unit that keeps it at or above one.
   */
  describeRate() {
    const perSecond = Math.abs(this.daysPerSecond);
    const sign = this.direction < 0 ? '−' : '';

    const preset = RATE_PRESETS.find((p) => Math.abs(p.daysPerSecond / perSecond - 1) < 1e-9);
    if (preset) return `${sign}${preset.label}`;

    const unit = RATE_UNITS.find((u) => perSecond >= u.days * 0.995) ?? RATE_UNITS.at(-1);
    const amount = perSecond / unit.days;
    const shown = amount < 9.95 ? amount.toFixed(1).replace(/\.0$/, '') : amount.toFixed(0);
    return `${sign}${shown} ${shown === '1' ? unit.singular : unit.plural}/s`;
  }

  /** Formats the simulated date the way the time bar shows it. */
  formatDate() {
    const date = this.date;
    // Dates beyond the Gregorian range the formatter handles gracefully are
    // reachable at 10 years/s within a couple of minutes of scrubbing.
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  formatTime() {
    const date = this.date;
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      hour12: false,
    });
  }
}
