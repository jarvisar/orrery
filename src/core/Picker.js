/**
 * Mouse and touch picking.
 *
 * Three fixes over the previous implementation, which raycast the entire scene
 * graph on every click:
 *
 * - It only tests a curated list of body meshes, so the skybox, the orbit paths
 *   and the belts are not candidates. Previously a click on empty space struck
 *   the 300,000-unit sky sphere and resolved to nothing after walking a
 *   twenty-branch if/else chain.
 * - A drag no longer counts as a click, so releasing the mouse after rotating
 *   the camera does not snap focus to whatever happened to be under the cursor.
 * - Hover testing is throttled to animation frames rather than running on every
 *   pointermove event.
 */

import * as THREE from 'three';

/** Pointer travel, in pixels, past which a press is a drag rather than a click. */
const DRAG_THRESHOLD = 6;

export class Picker {
  /**
   * @param {HTMLElement} domElement
   * @param {THREE.Camera} camera
   * @param {import('../scene/SolarSystem.js').SolarSystem} system
   */
  constructor(domElement, camera, system) {
    this.domElement = domElement;
    this.camera = camera;
    this.system = system;
    this.enabled = true;

    this.raycaster = new THREE.Raycaster();
    // Points are drawn at a constant pixel size, so a proportional threshold is
    // meaningless for them; the belts are not pickable anyway.
    this.raycaster.params.Line.threshold = 0;

    this._pointer = new THREE.Vector2();
    this._pressPosition = new THREE.Vector2();
    this._pressed = false;
    this._moved = false;
    this._hoverDirty = false;

    /** @type {string|null} */
    this.hoveredId = null;
    this._onSelect = null;
    this._onHover = null;

    this._bind();
  }

  onSelect(callback) { this._onSelect = callback; }
  onHover(callback) { this._onHover = callback; }

  _bind() {
    this._handlers = {
      pointerdown: (event) => {
        if (!event.isPrimary) return;
        this._pressed = true;
        this._moved = false;
        this._pressPosition.set(event.clientX, event.clientY);
      },
      pointermove: (event) => {
        if (this._pressed &&
            this._pressPosition.distanceTo(TEMP.set(event.clientX, event.clientY)) > DRAG_THRESHOLD) {
          this._moved = true;
        }
        this._updatePointer(event);
        this._hoverDirty = true;
      },
      pointerup: (event) => {
        if (!event.isPrimary) return;
        const wasClick = this._pressed && !this._moved;
        this._pressed = false;
        if (!wasClick || !this.enabled || event.button !== 0) return;

        this._updatePointer(event);
        const hit = this._pick();
        if (hit) this._onSelect?.(hit);
      },
      pointerleave: () => {
        this._pressed = false;
        this._setHover(null);
      },
      pointercancel: () => { this._pressed = false; },
    };

    for (const [type, handler] of Object.entries(this._handlers)) {
      this.domElement.addEventListener(type, handler);
    }
  }

  _updatePointer(event) {
    const rect = this.domElement.getBoundingClientRect();
    this._pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
  }

  /** Returns the id of the frontmost visible body under the pointer, or null. */
  _pick() {
    this.raycaster.setFromCamera(this._pointer, this.camera);
    const targets = this.system.pickables.filter((mesh) => isRenderable(mesh));
    const hits = this.raycaster.intersectObjects(targets, false);

    for (const hit of hits) {
      const id = hit.object.userData.bodyId;
      if (id && this.system.isVisible(id)) return id;
    }
    return null;
  }

  /** Called once per frame; does nothing unless the pointer actually moved. */
  update() {
    if (!this._hoverDirty || !this.enabled) return;
    this._hoverDirty = false;
    this._setHover(this._pick());
  }

  _setHover(id) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.domElement.style.cursor = id ? 'pointer' : 'default';
    this._onHover?.(id, this.lastClientX, this.lastClientY);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this._setHover(null);
  }

  dispose() {
    for (const [type, handler] of Object.entries(this._handlers)) {
      this.domElement.removeEventListener(type, handler);
    }
  }
}

const TEMP = new THREE.Vector2();

/** An object is only pickable if it and every ancestor is visible. */
function isRenderable(object) {
  let node = object;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}
