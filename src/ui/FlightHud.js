/**
 * Heads-up display for flight mode.
 *
 * The aim marker tracks the smoothed steering vector rather than the raw
 * pointer, so what you see is what the camera is actually acting on. The
 * throttle is a lever you can drag and a boost you can hold, which is all a
 * touch screen has to fly with; with a keyboard they just mirror W, S and Shift.
 */

import { el } from './dom.js';

export class FlightHud {
  /**
   * @param {import('../camera/FlightControls.js').FlightControls} controls
   * @param {number} kmPerUnit Scene units to kilometres, for the readouts.
   */
  constructor(controls, kmPerUnit) {
    this.controls = controls;
    this.kmPerUnit = kmPerUnit;

    this.aim = el('div', { class: 'hud__aim' });
    this.throttleFill = el('div', { class: 'hud__throttle-fill' });
    this.throttleTrack = el('div', { class: 'hud__throttle-track' }, [this.throttleFill]);
    this.speed = el('div', { class: 'hud__speed', text: '0' });
    this.nearName = el('div', { class: 'hud__near-name' });
    this.nearDistance = el('div', { class: 'hud__near-distance' });
    this.knob = el('div', { class: 'hud__stick-knob' });
    this.stick = el('div', { class: 'hud__stick' }, [this.knob]);
    this.prompt = el('div', { class: 'hud__prompt panel', text: 'Click to steer · Esc to leave flight' });

    this.boost = el('button', {
      class: 'btn panel hud__boost',
      type: 'button',
      text: 'Boost',
      'aria-label': 'Boost (hold)',
    });
    this.boost.addEventListener('pointerdown', (e) => {
      this.boost.setPointerCapture?.(e.pointerId);
      this.boost.classList.add('is-active');
      controls.setBoost(true);
    });
    const release = () => {
      this.boost.classList.remove('is-active');
      controls.setBoost(false);
    };
    this.boost.addEventListener('pointerup', release);
    this.boost.addEventListener('pointercancel', release);
    this.boost.addEventListener('contextmenu', (e) => e.preventDefault());

    this.throttle = el('div', { class: 'hud__throttle panel', title: 'Throttle: drag, or W / S' }, [
      el('div', { class: 'hud__speed-unit', text: 'THR' }),
      this.throttleTrack,
      this.speed,
      el('div', { class: 'hud__speed-unit', text: 'km/s' }),
    ]);
    this._bindLever();

    const touch = window.matchMedia('(pointer: coarse)').matches;
    this.root = el('div', { class: 'hud', 'aria-hidden': 'true' }, [
      el('div', { class: 'hud__reticle' }),
      this.aim,
      this.stick,
      el('div', { class: 'hud__controls' }, [this.throttle, this.boost]),
      el('div', { class: 'hud__near panel' }, [this.nearName, this.nearDistance]),
      this.prompt,
      el('div', {
        class: 'hud__hint panel',
        text: touch
          ? 'Drag anywhere to steer · Slide the throttle to fly · Hold Boost to go faster'
          : 'Mouse steers · W / S throttle · Shift boost · A / D roll · Space brake',
      }),
    ]);

    this._last = {};
  }

  /** Dragging anywhere on the throttle panel sets the throttle from the track. */
  _bindLever() {
    let dragging = null;
    const apply = (event) => {
      const rect = this.throttleTrack.getBoundingClientRect();
      this.controls.setThrottle(1 - (event.clientY - rect.top) / rect.height);
    };
    this.throttle.addEventListener('pointerdown', (event) => {
      dragging = event.pointerId;
      this.throttle.setPointerCapture?.(event.pointerId);
      apply(event);
    });
    this.throttle.addEventListener('pointermove', (event) => {
      if (event.pointerId === dragging) apply(event);
    });
    const end = (event) => { if (event.pointerId === dragging) dragging = null; };
    this.throttle.addEventListener('pointerup', end);
    this.throttle.addEventListener('pointercancel', end);
  }

  setActive(active) {
    this.root.classList.toggle('is-active', active);
    this.root.setAttribute('aria-hidden', String(!active));
    if (!active) this.controls.setBoost(false);
  }

  update() {
    const { controls } = this;
    const steer = controls.steering;
    this.aim.style.transform = `translate(${(steer.x * 40).toFixed(1)}px, ${(steer.y * 40).toFixed(1)}px)`;

    const origin = controls.stickOrigin;
    this.stick.classList.toggle('is-visible', Boolean(origin));
    if (origin) {
      const { x, y } = controls.stick;
      this.stick.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
      this.knob.style.transform = `translate(${(x * 70).toFixed(1)}px, ${(y * 70).toFixed(1)}px)`;
    }

    this.prompt.classList.toggle('is-visible', controls.usesCapture && !controls.captured);

    this._set('throttle', Math.round(Math.max(0, controls.throttle) * 100),
      (v) => { this.throttleFill.style.height = `${v}%`; });
    this._set('speed', formatNumber(Math.abs(controls.speed) * this.kmPerUnit),
      (v) => { this.speed.textContent = v; });
    this._set('near', controls.nearest?.name ?? '', (v) => { this.nearName.textContent = v; });
    this._set('distance', `${formatNumber(controls.altitude * this.kmPerUnit)} km`,
      (v) => { this.nearDistance.textContent = v; });
    this._set('boost', controls.boosting, (v) => this.root.classList.toggle('is-boosting', v));
  }

  /** Writes to the DOM only when a shown value actually changes. */
  _set(key, value, write) {
    if (this._last[key] === value) return;
    this._last[key] = value;
    write(value);
  }
}

/** 950, 9.5k, 12M: short enough for a narrow readout. */
function formatNumber(value) {
  if (!Number.isFinite(value)) return '–';
  if (value >= 1e6) return `${(value / 1e6).toFixed(value < 1e7 ? 1 : 0)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0)}k`;
  return value.toFixed(0);
}
