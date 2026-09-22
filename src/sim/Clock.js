/**
 * The simulation clock.
 *
 * Everything in the scene is a pure function of `days` - the simulated time in
 * days since J2000. Nothing accumulates rotation frame by frame, so pausing,
 * reversing or jumping to a date all work without the system drifting out of
 * alignment, and the same date always produces the same sky.
 */

import { daysSinceJ2000, dateFromDays } from './kepler.js';

/** Simulated days per real-world second, for the rate presets. */
export const RATE_PRESETS = [
  { label: 'Real time', daysPerSecond: 1 / 86_400 },
  { label: '1 min/s', daysPerSecond: 1 / 1440 },
  { label: '1 hour/s', daysPerSecond: 1 / 24 },
  { label: '6 hours/s', daysPerSecond: 0.25 },
  { label: '1 day/s', daysPerSecond: 1 },
  { label: '1 week/s', daysPerSecond: 7 },
  { label: '1 month/s', daysPerSecond: 30.44 },
  { label: '1 year/s', daysPerSecond: 365.25 },
  { label: '10 years/s', daysPerSecond: 3652.5 },
];

/**
 * One simulated day per second. Faster than this and a planet's own rotation
 * aliases into a strobe - Earth turns seven times a second at "1 week/s" -
 * while slower makes orbital motion too gradual to read.
 */
export const DEFAULT_RATE_INDEX = 4;

export class Clock {
  constructor() {
    this.days = daysSinceJ2000(new Date());
    this.daysPerSecond = RATE_PRESETS[DEFAULT_RATE_INDEX].daysPerSecond;
    this.direction = 1;
    this.paused = false;
  }

  advance(deltaSeconds) {
    if (this.paused) return;
    this.days += deltaSeconds * this.daysPerSecond * this.direction;
  }

  /** The simulated instant, as a real Date. */
  get date() {
    return dateFromDays(this.days);
  }

  set date(value) {
    this.days = daysSinceJ2000(value);
  }

  jumpToNow() {
    this.days = daysSinceJ2000(new Date());
  }

  /** Signed rate, for display. */
  get signedRate() {
    return this.daysPerSecond * this.direction;
  }

  /** A human-readable version of the current rate. */
  describeRate() {
    const perSecond = Math.abs(this.daysPerSecond);
    const sign = this.direction < 0 ? '−' : '';

    if (perSecond < 1 / 1400) return `${sign}${(perSecond * 86_400).toFixed(0)} sec/s`;
    if (perSecond < 1 / 20) return `${sign}${(perSecond * 24).toFixed(1)} hours/s`;
    if (perSecond < 6) return `${sign}${perSecond.toFixed(perSecond < 1 ? 2 : 1)} days/s`;
    if (perSecond < 300) return `${sign}${(perSecond / 7).toFixed(1)} weeks/s`;
    if (perSecond < 3000) return `${sign}${(perSecond / 365.25).toFixed(2)} years/s`;
    return `${sign}${(perSecond / 365.25).toFixed(0)} years/s`;
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
