/**
 * A star with planets, chosen in the sky: what is there, and a way to go.
 *
 * Travelling loads the page for that system, the same link the Star systems
 * atlas uses, so it waits for the button rather than happening on the click
 * that chose the star. The card is pinned to the star, and follows it as the
 * view turns.
 */

import * as THREE from 'three';
import { el, icon } from './dom.js';
import { systemUrl } from './SystemExplorer.js';
import { hostSummary } from '../core/SkyHosts.js';

/** From the star to the card, in pixels: clear of the ring round it. */
const OFFSET = 22;
/** How near the card may come to each edge: clear of the top bar and the time bar. */
const MARGIN = { side: 10, top: 64, bottom: 72 };

export class StarCard {
  /** @param {THREE.PerspectiveCamera} camera */
  constructor(camera) {
    this.camera = camera;
    /** @type {import('../core/SkyHosts.js').SkyHost|null} */
    this.host = null;

    this.title = el('h2', { class: 'starcard__title', id: 'starcard-title' });
    this.summary = el('p', { class: 'starcard__summary' });
    this.travel = el('a', { class: 'btn starcard__travel' }, [
      el('span', { text: 'Travel' }), el('span', { text: '→', 'aria-hidden': 'true' }),
    ]);
    this.plate = el('section', { class: 'starcard__plate panel', 'aria-labelledby': 'starcard-title' }, [
      el('div', { class: 'starcard__head' }, [
        el('p', { class: 'section-title', text: 'Star with planets' }),
        el('button', {
          class: 'btn btn--icon starcard__close', type: 'button', title: 'Close', 'aria-label': 'Close',
          onclick: () => this.close(),
        }, [icon('close', 16)]),
      ]),
      this.title, this.summary, this.travel,
    ]);
    this.ring = el('span', { class: 'starcard__ring', 'aria-hidden': 'true' });
    this.root = el('div', { class: 'starcard', hidden: true }, [this.ring, this.plate]);

    this._size = { width: 0, height: 0 };
    this._screen = { width: 0, height: 0 };
    this._shown = true;
    this._direction = new THREE.Vector3();
  }

  get isOpen() { return Boolean(this.host); }

  /** @param {import('../core/SkyHosts.js').SkyHost} host */
  open(host) {
    this.host = host;
    this.title.textContent = host.name;
    this.summary.textContent = hostSummary(host);
    this.travel.href = systemUrl(host.name);
    this.travel.setAttribute('aria-label', `Travel to ${host.name}`);
    this.root.hidden = false;
    this._show(true);
    // Measured once here, so placing it each frame reads no layout.
    this._size = { width: this.plate.offsetWidth, height: this.plate.offsetHeight };
    // Placed now, or it would spend a frame in the corner.
    this.update(this._screen.width, this._screen.height);
  }

  /** False if it was not open. */
  close() {
    if (!this.host) return false;
    this.host = null;
    this.root.hidden = true;
    return true;
  }

  /**
   * Keeps the card on its star; hidden while the star is off screen.
   * @param {number} width  CSS pixels
   * @param {number} height CSS pixels
   */
  update(width, height) {
    this._screen.width = width;
    this._screen.height = height;
    if (!this.host) return;
    const direction = this._direction.set(this.host.x, this.host.y, this.host.z)
      .transformDirection(this.camera.matrixWorldInverse);
    // The star is at infinity: only the camera's rotation matters, and behind it, it is not on screen.
    const ahead = direction.z < 0;
    if (ahead) direction.applyMatrix4(this.camera.projectionMatrix);
    const x = (direction.x * 0.5 + 0.5) * width;
    const y = (-direction.y * 0.5 + 0.5) * height;
    const visible = ahead && x >= 0 && x <= width && y >= 0 && y <= height;
    this._show(visible);
    if (!visible) return;

    const { width: w, height: h } = this._size;
    // Beside the star, on whichever side has room, and never off the screen.
    const left = x + OFFSET + w <= width - MARGIN.side ? x + OFFSET : Math.max(MARGIN.side, x - OFFSET - w);
    const top = Math.max(MARGIN.top, Math.min(y - h / 2, height - MARGIN.bottom - h));
    this.ring.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    this.plate.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  _show(shown) {
    if (shown === this._shown) return;
    this._shown = shown;
    this.ring.style.display = this.plate.style.display = shown ? '' : 'none';
  }
}
