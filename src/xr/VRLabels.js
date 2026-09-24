/**
 * Name labels in VR: the headset's version of src/ui/Markers.js.
 *
 * On a tabletop solar system most planets are a millimetre or two across, so
 * the same rule applies as on screen: a label fades in as its body shrinks out
 * of sight and fades out as it grows into view. Here the measure is the angle
 * the body subtends rather than its size in pixels, and each label is a sprite
 * sitting on its body, kept the same apparent size at any distance.
 */

import * as THREE from 'three';

/** Apparent radius, in radians, at which a label is fully faded out / in. */
const HIDE_ABOVE = 0.03;
const SHOW_BELOW = 0.01;

/** Label height as an angle: about the size of the page's marker text at arm's length. */
const LABEL_ANGLE = 0.034;

/** Canvas geometry for one label, in pixels. */
const LABEL_HEIGHT = 64;
const DOT_X = 16;
const DOT_RADIUS = 9;
const TEXT_X = 40;
const FONT_PX = 34;

export class VRLabels {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../scene/SolarSystem.js').SolarSystem} system
   */
  constructor(scene, system) {
    this.system = system;
    this.group = new THREE.Group();
    this.group.name = 'vr-labels';
    this.group.visible = false;
    scene.add(this.group);

    this.entries = [];
    this.active = false;
    this.enabled = true;
    this._focusedId = null;
    this._systemId = null;
  }

  /** Shown only while a session is running. Built on first use, once the fonts are in. */
  setActive(active) {
    if (active && this.entries.length === 0) this._build();
    this.active = active;
    this.group.visible = active && this.enabled;
  }

  /** The Labels setting. */
  setEnabled(enabled) {
    this.enabled = enabled;
    this.group.visible = this.active && enabled;
  }

  /** As Markers.setFocus: dims the focused body's label and switches on its system's moons. */
  setFocus(bodyId) {
    this._focusedId = bodyId;
    const view = bodyId ? this.system.bodies.get(bodyId) : null;
    this._systemId = view?.kind === 'moon' ? view.body.parent : bodyId;
  }

  /**
   * Whether a body is one that gets a label. The same rule as on screen: a moon
   * only while its own system is the one being looked at.
   */
  isListed(view) {
    return view.visible && (view.kind !== 'moon' || view.body.parent === this._systemId);
  }

  /**
   * @param {THREE.Vector3} viewer The eyes, in world space.
   * @param {THREE.Vector3} up The head's up direction, in world space.
   * @param {number} unitsPerMetre The rig's scale.
   * @param {Set<string>} pointed Bodies a controller is pointing at: always labelled, in full.
   */
  update(viewer, up, unitsPerMetre, pointed) {
    if (!this.group.visible) return;

    for (const entry of this.entries) {
      const { view, sprite } = entry;
      const hot = pointed.has(view.id);
      if (!view.visible || (!hot && !this.isListed(view))) {
        sprite.visible = false;
        continue;
      }

      const distance = Math.max(viewer.distanceTo(view.group.position), 1e-6);
      let opacity = hot ? 1 : smoothstep(HIDE_ABOVE, SHOW_BELOW, view.radius / distance);
      if (!hot && view.id === this._focusedId) opacity *= 0.35;
      if (opacity < 0.02) {
        sprite.visible = false;
        continue;
      }

      sprite.visible = true;
      sprite.material.opacity = opacity;
      // On the body's upper limb, so a large body pointed at is named, not covered.
      sprite.position.copy(view.group.position).addScaledVector(up, view.radius);
      // A sprite's size is in view units - metres, here - not world units.
      const height = (distance / unitsPerMetre) * LABEL_ANGLE;
      sprite.scale.set(height * entry.aspect, height, 1);
    }
  }

  _build() {
    const font = `500 ${FONT_PX}px ${getComputedStyle(document.body).fontFamily}`;
    for (const view of this.system.bodies.values()) {
      const { texture, aspect } = labelTexture(view.name, view.body.color ?? '#ffffff', font);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }));
      // Anchored on the dot, so the dot sits on the body and the name trails off to the right.
      sprite.center.set(DOT_X / (aspect * LABEL_HEIGHT), 0.5);
      sprite.renderOrder = 1e7;
      sprite.visible = false;
      this.group.add(sprite);
      this.entries.push({ view, sprite, aspect });
    }
  }
}

function labelTexture(name, color, font) {
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const width = Math.ceil(TEXT_X + measure.measureText(name).width + 16);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = LABEL_HEIGHT;
  const ctx = canvas.getContext('2d');

  ctx.beginPath();
  ctx.arc(DOT_X, LABEL_HEIGHT / 2, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.stroke();

  // A soft shadow keeps the name readable across the Sun or a lit limb.
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#eeece6';
  ctx.fillText(name, TEXT_X, LABEL_HEIGHT / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: width / LABEL_HEIGHT };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
