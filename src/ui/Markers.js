/**
 * Screen-space markers for bodies that are too small to see.
 *
 * Zoomed out far enough to take in the whole system, every planet is well under
 * a pixel across - the old build's wide shot was an empty starfield with some
 * rings drawn on it, and the only way to reach Neptune was the dropdown. A
 * marker fades in as a body shrinks below a few pixels and fades out as you
 * approach it, so there is always something to aim at and never two
 * representations of the same body competing on screen.
 */

import * as THREE from 'three';
import { el } from './dom.js';

/** Apparent radius, in CSS pixels, at which a marker is fully faded out / in. */
const HIDE_ABOVE = 7;
const SHOW_BELOW = 2.5;

/** Markers closer to the screen edge than this are dropped rather than clipped. */
const EDGE_PADDING = 8;

/** Label box geometry, used for decluttering without touching the DOM. */
const LABEL_HEIGHT = 20;
const LABEL_LEAD = 16;   // dot plus the gap before the text
const LABEL_TRAIL = 8;

export class Markers {
  /**
   * @param {import('../scene/SolarSystem.js').SolarSystem} system
   * @param {THREE.PerspectiveCamera} camera
   * @param {(id: string) => void} onSelect
   */
  constructor(system, camera, onSelect) {
    this.system = system;
    this.camera = camera;
    this.enabled = true;

    this.root = el('div', { class: 'markers', 'aria-hidden': 'false' });
    this.entries = [];

    for (const view of system.bodies.values()) {
      // Moons would crowd the view at every zoom level; they are reachable
      // through their primary, the picker and the orbit paths instead.
      if (view.kind === 'moon') continue;

      const node = el(
        'button',
        {
          class: 'marker',
          type: 'button',
          'data-id': view.id,
          title: view.name,
          tabindex: -1,
          onclick: (event) => { event.stopPropagation(); onSelect(view.id); },
        },
        [
          el('span', {
            class: 'marker__dot',
            style: { background: view.body.color ?? '#ffffff' },
          }),
          el('span', { class: 'marker__label', text: view.name }),
        ]
      );

      // Hidden until the first update places it; otherwise every marker flashes
      // in the top-left corner for one frame.
      node.style.display = 'none';
      this.root.append(node);
      this.entries.push({
        view, node, shown: false, crowded: false,
        lastX: -1, lastY: -1, lastOpacity: -1,
        labelWidth: LABEL_LEAD + measureText(view.name) + LABEL_TRAIL,
      });
    }

    this._position = new THREE.Vector3();
    this._candidates = [];
    this._reserved = [];
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.root.style.display = enabled ? '' : 'none';
  }

  /** Dims the marker for whatever is focused, so it does not sit on top of the body. */
  setFocus(bodyId) {
    this._focusedId = bodyId;
  }

  /**
   * @param {number} width  CSS pixels
   * @param {number} height CSS pixels
   */
  update(width, height) {
    if (!this.enabled) return;

    // Pixels per scene unit at one unit of depth, from the vertical FOV.
    const halfFovTan = Math.tan((this.camera.fov * Math.PI) / 360);
    const pixelScale = height / 2 / halfFovTan;

    const candidates = this._candidates;
    candidates.length = 0;

    for (const entry of this.entries) {
      const { view } = entry;
      if (!view.visible) {
        this._hide(entry);
        continue;
      }

      this._position.copy(view.group.position).project(this.camera);

      // project() leaves z outside [-1, 1] beyond the clip planes, and mirrors
      // x and y for anything behind the camera.
      if (this._position.z < -1 || this._position.z > 1) {
        this._hide(entry);
        continue;
      }

      const x = (this._position.x * 0.5 + 0.5) * width;
      const y = (-this._position.y * 0.5 + 0.5) * height;
      if (x < -EDGE_PADDING || x > width + EDGE_PADDING ||
          y < -EDGE_PADDING || y > height + EDGE_PADDING) {
        this._hide(entry);
        continue;
      }

      const distance = this.camera.position.distanceTo(view.group.position);
      const apparent = (view.radius / Math.max(distance, 1e-3)) * pixelScale;
      let opacity = smoothstep(HIDE_ABOVE, SHOW_BELOW, apparent);
      if (view.id === this._focusedId) opacity *= 0.35;

      if (opacity < 0.02) {
        this._hide(entry);
        continue;
      }
      candidates.push({ entry, x, y, distance, opacity });
    }

    // Nearest first, so when the inner planets stack up on a wide shot the one
    // in front keeps its name and the ones behind it fall back to a bare dot.
    candidates.sort((a, b) => a.distance - b.distance);

    const reserved = this._reserved;
    reserved.length = 0;

    for (const candidate of candidates) {
      const { entry, x, y, opacity } = candidate;
      const top = y - LABEL_HEIGHT / 2;
      const full = { x: x - 9, y: top, w: entry.labelWidth, h: LABEL_HEIGHT };
      const crowded = reserved.some((rect) => overlaps(rect, full));

      reserved.push(crowded ? { x: x - 9, y: top, w: LABEL_LEAD, h: LABEL_HEIGHT } : full);
      this._place(entry, x, y, opacity, crowded);
    }
  }

  _place(entry, x, y, opacity, crowded) {
    const { node } = entry;
    const px = Math.round(x);
    const py = Math.round(y);

    if (px !== entry.lastX || py !== entry.lastY) {
      node.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      entry.lastX = px;
      entry.lastY = py;
    }

    const rounded = Math.round(opacity * 20) / 20;
    if (rounded !== entry.lastOpacity) {
      node.style.opacity = rounded;
      entry.lastOpacity = rounded;
    }
    if (crowded !== entry.crowded) {
      node.classList.toggle('is-crowded', crowded);
      entry.crowded = crowded;
    }
    if (!entry.shown) {
      node.style.display = '';
      entry.shown = true;
    }
  }

  _hide(entry) {
    if (!entry.shown) return;
    entry.node.style.display = 'none';
    entry.shown = false;
  }

  dispose() {
    this.root.remove();
  }
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Label widths, measured once on a 2D canvas rather than read back from layout.
 * Asking the DOM for offsetWidth every frame would force a synchronous reflow
 * in the middle of the render loop.
 */
let _measureContext = null;
function measureText(text) {
  if (!_measureContext) {
    _measureContext = document.createElement('canvas').getContext('2d');
    const style = getComputedStyle(document.body);
    _measureContext.font = `500 11.5px ${style.fontFamily}`;
  }
  return Math.ceil(_measureContext.measureText(text).width);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
