/**
 * Mouse and touch picking.
 *
 * - Body meshes are tested, never the sky sphere, orbit paths or belts. Where
 *   none is hit, a fallback may offer something else (stars with planets; see
 *   setFallback), found by the pointer's direction alone.
 * - A drag is not a click, so releasing after rotating the camera does not
 *   change focus.
 * - Hover is tested at most once per frame, and not at all for touch or
 *   mid-drag. The view moving under a still pointer (easing to a stop, a
 *   transition) re-tests it too, a few times a second.
 */

import * as THREE from 'three';

/** Pointer travel, in pixels, past which a press is a drag rather than a click. */
const DRAG_THRESHOLD = 6;

/** How often, in ms, hover is re-tested while the view moves under a still pointer. */
const VIEW_RETEST_MS = 100;

/** How near, in pixels, the pointer must come to what the fallback offers. A finger is less exact. */
const FALLBACK_REACH = { mouse: 8, pen: 8, touch: 16 };

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
    /** Pickable things that are not catalogue bodies, by id. */
    this._extras = new Map();
    this._onSelect = null;
    this._onHover = null;
    this._fallback = null;
    this._pointerType = 'mouse';
    this._viewHeight = 1;
    /** A mouse or pen over the canvas, which is what hover is for. */
    this._hovering = false;
    this._lastView = new THREE.Matrix4();
    this._lastViewTest = 0;

    this._bind();
  }

  onSelect(callback) { this._onSelect = callback; }

  /** Makes something outside the catalogue clickable. Its meshes carry `userData.bodyId`. */
  addSelectable(id, meshes) {
    this._extras.set(id, meshes);
  }
  onHover(callback) { this._onHover = callback; }

  /**
   * What to offer where no body is hit: `(direction, tolerance) => id|null`,
   * given the pointer's world-space unit direction and the angle, in radians,
   * that a few pixels span at the centre of the view.
   */
  setFallback(fallback) { this._fallback = fallback; }

  /** Tests hover again next frame: what can be picked has changed, though the pointer has not moved. */
  refreshHover() { if (this._hovering) this._hoverDirty = true; }

  _bind() {
    this._handlers = {
      pointerdown: (event) => {
        if (!event.isPrimary) return;
        this._pressed = true;
        this._moved = false;
        this._pressPosition.set(event.clientX, event.clientY);
      },
      pointermove: (event) => {
        if (this._pressed && !this._moved &&
            this._pressPosition.distanceTo(TEMP.set(event.clientX, event.clientY)) > DRAG_THRESHOLD) {
          this._moved = true;
          this._setHover(null);
        }
        this._updatePointer(event);
        this._hovering = event.pointerType !== 'touch';
        if (this._hovering && !this._moved) this._hoverDirty = true;
      },
      pointerup: (event) => {
        if (!event.isPrimary) return;
        const wasClick = this._pressed && !this._moved;
        // The drag, if it was one, is over: hover resumes with the next move.
        this._pressed = false;
        this._moved = false;
        if (event.pointerType !== 'touch') this._hoverDirty = true;
        if (!wasClick || !this.enabled || event.button !== 0) return;

        this._updatePointer(event);
        const hit = this._pick();
        if (hit) this._onSelect?.(hit);
      },
      pointerleave: () => {
        this._pressed = false;
        this._moved = false;
        this._hovering = false;
        this._setHover(null);
      },
      pointercancel: () => { this._pressed = false; this._moved = false; },
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
    this._pointerType = event.pointerType;
    this._viewHeight = rect.height;
  }

  _pick() {
    this.raycaster.setFromCamera(this._pointer, this.camera);
    const hit = this._firstHit()?.id;
    if (hit || !this._fallback) return hit ?? null;
    const pixel = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this._viewHeight;
    return this._fallback(this.raycaster.ray.direction, (FALLBACK_REACH[this._pointerType] ?? 8) * pixel);
  }

  /** Frontmost visible body along a world-space ray (for VR controllers), as {id, distance} or null. */
  pickRay(origin, direction) {
    this.raycaster.set(origin, direction);
    return this._firstHit();
  }

  _firstHit() {
    const targets = this.system.pickables.filter((mesh) => isRenderable(mesh));
    for (const meshes of this._extras.values()) {
      for (const mesh of meshes) if (isRenderable(mesh)) targets.push(mesh);
    }
    const hits = this.raycaster.intersectObjects(targets, false);

    for (const hit of hits) {
      const id = hit.object.userData.bodyId;
      if (id && (this.system.isVisible(id) || this._extras.has(id))) return { id, distance: hit.distance };
    }
    return null;
  }

  /** Called once per frame; a no-op unless the pointer moved. */
  update() {
    if (!this.enabled) return;
    if (this._hovering && !this._pressed && !this.camera.matrixWorld.equals(this._lastView)) {
      const now = performance.now();
      if (now - this._lastViewTest >= VIEW_RETEST_MS) this._hoverDirty = true;
    }
    if (!this._hoverDirty) return;
    this._hoverDirty = false;
    this._lastView.copy(this.camera.matrixWorld);
    this._lastViewTest = performance.now();
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

function isRenderable(object) {
  let node = object;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}
