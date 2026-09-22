/**
 * Heads-up display for flight mode.
 *
 * The aim marker tracks the smoothed steering vector rather than the raw
 * pointer, so what you see is what the camera is actually acting on - which
 * makes the dead zone and the response curve legible instead of mysterious.
 */

import { el } from './dom.js';

export class FlightHud {
  /** @param {import('../camera/FlightControls.js').FlightControls} controls */
  constructor(controls) {
    this.controls = controls;

    this.aim = el('div', { class: 'hud__aim' });
    this.throttleFill = el('div', { class: 'hud__throttle-fill' });
    this.speed = el('div', { class: 'hud__speed', text: '0' });

    this.root = el('div', { class: 'hud', 'aria-hidden': 'true' }, [
      el('div', { class: 'hud__reticle' }),
      this.aim,
      el('div', { class: 'hud__throttle panel' }, [
        el('div', { class: 'hud__speed-unit', text: 'THR' }),
        el('div', { class: 'hud__throttle-track' }, [this.throttleFill]),
        this.speed,
        el('div', { class: 'hud__speed-unit', text: 'Mm/s' }),
      ]),
      el('div', {
        class: 'hud__hint panel',
        text: 'W / S throttle · A / D roll · Shift boost · Space stop · Esc exit',
      }),
    ]);

    this._lastThrottle = -1;
    this._lastSpeed = -1;
  }

  setActive(active) {
    this.root.classList.toggle('is-active', active);
    this.root.setAttribute('aria-hidden', String(!active));
  }

  /**
   * @param {number} megametersPerSecond Speed converted out of scene units via
   *   the body-size scale, so it means something relative to the planet you are
   *   manoeuvring around. Thousands of km/s is what it takes to cross a
   *   compressed solar system at a watchable rate.
   */
  update(megametersPerSecond) {
    const steer = this.controls.steering;
    this.aim.style.transform = `translate(${(steer.x * 40).toFixed(1)}px, ${(steer.y * 40).toFixed(1)}px)`;

    const throttle = Math.round(Math.max(0, this.controls.throttle) * 100);
    if (throttle !== this._lastThrottle) {
      this.throttleFill.style.height = `${throttle}%`;
      this._lastThrottle = throttle;
    }

    const shown = megametersPerSecond >= 1000
      ? `${(megametersPerSecond / 1000).toFixed(1)}k`
      : megametersPerSecond.toFixed(megametersPerSecond < 10 ? 1 : 0);
    if (shown !== this._lastSpeed) {
      this.speed.textContent = shown;
      this._lastSpeed = shown;
    }
  }
}
