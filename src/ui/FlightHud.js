/**
 * Heads-up display for flight mode.
 *
 * The aim marker tracks the smoothed steering vector rather than the raw
 * pointer, so what you see is what the camera is actually acting on. The
 * throttle is a lever you can drag and a boost you can hold, which is all a
 * touch screen has to fly with; with a keyboard they just mirror W, S and Shift.
 *
 * The destination gets a bracket while it is in view and, when it is not, an
 * arrow on a ring round the reticle pointing the shortest way to turn.
 */

import * as THREE from 'three';
import { el, icon } from './dom.js';

const _local = new THREE.Vector3();
const _inverse = new THREE.Quaternion();

/** Beyond this apparent radius, in pixels, the destination fills the view and needs no bracket. */
const BRACKET_MAX = 160;

export class FlightHud {
  /**
   * @param {import('../camera/FlightControls.js').FlightControls} controls
   * @param {number} kmPerUnit Scene units to kilometres, for the readouts.
   * @param {THREE.PerspectiveCamera} camera
   * @param {{ onStep: (delta: number) => void, onAutopilot: () => void }} actions
   */
  constructor(controls, kmPerUnit, camera, { onStep, onAutopilot }) {
    this.controls = controls;
    this.kmPerUnit = kmPerUnit;
    this.camera = camera;

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

    // Buttons let go of focus once pressed, or Space would press them again.
    const button = (props, children, onClick) => {
      const node = el('button', { class: 'btn', type: 'button', ...props }, children);
      node.addEventListener('click', () => { node.blur(); onClick(); });
      return node;
    };
    this.destName = el('div', { class: 'hud__dest-name' });
    this.destDistance = el('div', { class: 'hud__dest-distance' });
    this.autopilot = button(
      { class: 'btn hud__autopilot', title: touch ? 'Autopilot' : 'Autopilot (F)', text: 'Autopilot' },
      [],
      onAutopilot
    );
    this.dest = el('div', { class: 'hud__dest panel' }, [
      el('div', { class: 'hud__speed-unit', text: 'DESTINATION' }),
      el('div', { class: 'hud__dest-row' }, [
        button({ class: 'btn btn--icon', title: 'Previous destination ([)', 'aria-label': 'Previous destination' },
          [icon('back', 16)], () => onStep(-1)),
        this.destName,
        button({ class: 'btn btn--icon', title: 'Next destination (])', 'aria-label': 'Next destination' },
          [icon('next', 16)], () => onStep(1)),
      ]),
      this.destDistance,
      this.autopilot,
    ]);
    this.emptyHint = touch ? 'Tap a label or the arrows' : 'Click a label, or [ and ]';

    this.bracketLabel = el('div', { class: 'hud__bracket-label' });
    this.bracket = el('div', { class: 'hud__bracket' }, [this.bracketLabel]);
    this.pointer = el('div', { class: 'hud__pointer' });
    this.notice = el('div', { class: 'hud__notice panel' });

    this.root = el('div', { class: 'hud', 'aria-hidden': 'true' }, [
      el('div', { class: 'hud__reticle' }),
      this.aim,
      this.bracket,
      this.pointer,
      this.stick,
      el('div', { class: 'hud__controls' }, [this.throttle, this.boost]),
      this.dest,
      el('div', { class: 'hud__near panel' }, [this.nearName, this.nearDistance]),
      this.prompt,
      this.notice,
      el('div', {
        class: 'hud__hint panel',
        text: touch
          ? 'Tap a planet’s label to fly there · Drag to steer · Slide the throttle'
          : 'Click a planet’s label to fly there · Mouse steers · W / S throttle · Shift boost',
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
    if (!active) {
      this.controls.setBoost(false);
      this.notice.classList.remove('is-visible');
    }
  }

  /** Flashes a line of text under the reticle for a few seconds. */
  notify(text) {
    this.notice.textContent = text;
    this.notice.classList.add('is-visible');
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => this.notice.classList.remove('is-visible'), 3500);
  }

  /**
   * @param {number} width  CSS pixels
   * @param {number} height CSS pixels
   */
  update(width, height) {
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

    const target = controls.target;
    this._set('dest', target?.name ?? '', (v) => {
      this.destName.textContent = v || 'None';
      this.dest.classList.toggle('is-empty', !v);
      this.autopilot.disabled = !v;
    });
    this._set('destDistance',
      target ? `${formatNumber(controls.targetAltitude * this.kmPerUnit)} km` : this.emptyHint,
      (v) => { this.destDistance.textContent = v; });
    this._set('autopilot', controls.autopilot, (v) => {
      this.autopilot.classList.toggle('is-active', v);
      this.autopilot.setAttribute('aria-pressed', String(v));
      this.root.classList.toggle('is-autopilot', v);
    });
    this._placeMarker(target, width, height);
  }

  /** The bracket round the destination, or the arrow that points the way to it. */
  _placeMarker(target, width, height) {
    let bracket = false;
    let pointer = false;

    if (target?.visible) {
      const { camera } = this;
      // The destination in the camera's frame: -z ahead, +x right, +y up.
      _local.copy(target.group.position).sub(camera.position)
        .applyQuaternion(_inverse.copy(camera.quaternion).invert());
      const depth = -_local.z;
      const pixelScale = height / 2 / Math.tan((camera.fov * Math.PI) / 360);
      const x = width / 2 + (_local.x / depth) * pixelScale;
      const y = height / 2 - (_local.y / depth) * pixelScale;

      if (depth > 0 && x > 0 && x < width && y > 0 && y < height) {
        const apparent = (target.radius / depth) * pixelScale;
        if (apparent < BRACKET_MAX) {
          const size = Math.round(Math.max(apparent * 2 + 16, 28));
          this.bracket.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
          this.bracket.style.width = this.bracket.style.height = `${size}px`;
          bracket = true;
        }
      } else {
        // Straight behind has no screen direction; call it "down".
        const angle = _local.x || _local.y ? Math.atan2(-_local.y, _local.x) : Math.PI / 2;
        const ring = Math.min(Math.min(width, height) * 0.3, 170);
        const px = width / 2 + Math.cos(angle) * ring;
        const py = height / 2 + Math.sin(angle) * ring;
        this.pointer.style.transform =
          `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${angle.toFixed(3)}rad)`;
        pointer = true;
      }
    }

    this._set('bracketName', bracket ? target.name : '', (v) => { this.bracketLabel.textContent = v; });
    this._set('bracket', bracket, (v) => this.bracket.classList.toggle('is-visible', v));
    this._set('pointer', pointer, (v) => this.pointer.classList.toggle('is-visible', v));
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
