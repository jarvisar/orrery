/**
 * Orbit paths drawn as screen-space lines.
 *
 * The old implementation faked line width with a `RingGeometry` whose inner and
 * outer radii were recomputed from the camera height - which meant tearing down
 * and rebuilding twenty-odd 1024-segment ring meshes mid-frame, every time the
 * camera moved far enough, without ever disposing the old ones. That is what
 * produced the stutter on approach and the steadily climbing GPU memory.
 *
 * `Line2` solves the actual problem properly: it expands each segment into a
 * quad in the vertex shader, so a path is a fixed number of pixels wide at any
 * zoom, and the geometry is built once and never touched again.
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { BODY_BY_ID, SUN_ID } from '../data/bodies.js';
import { heliocentricDistance, satelliteDistance } from './scaling.js';
import { sampleOrbitPath, perifocalToWorld } from '../sim/kepler.js';

const HELIOCENTRIC_SEGMENTS = 512;
const SATELLITE_SEGMENTS = 192;

const BASE_WIDTH = 1.1;
const FOCUS_WIDTH = 1.8;
const BASE_OPACITY = 0.2;
const FOCUS_OPACITY = 0.55;

/**
 * Two reasons to fade a path out, both of which a close-up of Earth used to hit
 * at once - the first build's screenshots are sliced apart by every orbit in
 * the system at once.
 *
 * Span: the orbit's radius over the camera's distance to its centre, roughly
 * how many screens wide the path is. Past SPAN_OUT it is bigger than anything
 * you can take in and reads as a stray line.
 *
 * Proximity: how far the camera sits from the path itself, as a fraction of the
 * orbit's radius. Sitting *on* an orbit - which is exactly where you are
 * whenever a planet is focused - projects it straight through the viewport.
 */
const SPAN_IN = 1.0;
const SPAN_OUT = 3.2;
const NEAR_PATH = 0.05;
const CLEAR_OF_PATH = 0.3;

const _point = { x: 0, y: 0, z: 0 };
const _centre = new THREE.Vector3();

export class Orbits {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./SolarSystem.js').SolarSystem} system
   */
  constructor(scene, system) {
    this.system = system;
    this.root = new THREE.Group();
    this.root.name = 'orbits';
    scene.add(this.root);

    /** @type {Map<string, {line: Line2, material: LineMaterial, parentId: string|null}>} */
    this.lines = new Map();
    this._resolution = new THREE.Vector2(1, 1);
    this._focusedId = null;
  }

  build() {
    this.clear();
    for (const view of this.system.bodies.values()) {
      if (!view.elements) continue;
      this.lines.set(view.id, this._createLine(view));
    }
    this._applyVisibility();
  }

  _createLine(view) {
    const heliocentric = view.body.parent === SUN_ID;
    const segments = heliocentric ? HELIOCENTRIC_SEGMENTS : SATELLITE_SEGMENTS;
    const positions = this._pathPositions(view, segments);

    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    const material = new LineMaterial({
      // Tinted towards the body's own colour, so a dense system reads as
      // separate orbits rather than a ball of white wire.
      color: new THREE.Color(view.body.color ?? '#ffffff').lerp(new THREE.Color(0xffffff), 0.2),
      linewidth: heliocentric ? BASE_WIDTH : BASE_WIDTH * 0.75,
      worldUnits: false,
      transparent: true,
      opacity: heliocentric ? BASE_OPACITY : BASE_OPACITY * 0.75,
      depthWrite: false,
      dashed: false,
      resolution: this._resolution,
    });

    const line = new Line2(geometry, material);
    line.name = `${view.id}-orbit`;
    line.frustumCulled = false; // the bounding sphere of an orbit is unhelpfully huge
    line.renderOrder = -2;
    // The same frame SolarSystem.positionAt uses. Axial tilt is fixed, so once is enough.
    if (view.elements.equatorial) {
      line.quaternion.copy(this.system.bodies.get(view.body.parent).tilt.quaternion);
    }
    this.root.add(line);

    const base = heliocentric ? BASE_OPACITY : BASE_OPACITY * 0.8;
    return {
      line,
      material,
      view,
      parentId: heliocentric ? null : view.body.parent,
      radius: meanRadius(positions),
      targetOpacity: base,
      allowed: true,
    };
  }

  /**
   * Samples one revolution and pushes each point through the same distance
   * compression the body itself uses, so the path and the planet on it can
   * never disagree.
   */
  _pathPositions(view, segments) {
    const el = view.elements;
    const heliocentric = view.body.parent === SUN_ID;
    const exponent = this.system.scaleExponent;

    const samples = sampleOrbitPath(el, segments, []);
    const positions = new Float32Array((segments + 1) * 3);

    for (let i = 0; i < samples.length; i++) {
      perifocalToWorld(samples[i].px, samples[i].py, el, _point);
      const distance = Math.hypot(_point.x, _point.y, _point.z) || 1e-9;
      const scaled = heliocentric
        ? heliocentricDistance(distance, exponent)
        : satelliteDistance(distance, exponent);
      const k = scaled / distance;

      positions[i * 3] = _point.x * k;
      positions[i * 3 + 1] = _point.y * k;
      positions[i * 3 + 2] = _point.z * k;
    }
    return positions;
  }

  /**
   * Keeps satellite paths pinned to their primary, and fades each path by how
   * much of the view it spans. Twenty-odd opacity assignments a frame costs
   * nothing; the draw calls it skips do not.
   *
   * @param {THREE.Vector3} cameraPosition
   */
  update(cameraPosition) {
    for (const entry of this.lines.values()) {
      if (entry.parentId) {
        const parent = this.system.bodies.get(entry.parentId);
        if (parent) entry.line.position.copy(parent.group.position);
        _centre.copy(entry.line.position);
      } else {
        _centre.set(0, 0, 0);
      }

      const distance = Math.max(cameraPosition.distanceTo(_centre), 1e-3);
      const span = smoothstep(SPAN_OUT, SPAN_IN, entry.radius / distance);
      const offPath = entry.radius > 0
        ? smoothstep(NEAR_PATH, CLEAR_OF_PATH, Math.abs(distance - entry.radius) / entry.radius)
        : 1;
      const opacity = entry.targetOpacity * span * offPath;

      entry.material.opacity = opacity;
      entry.line.visible = entry.allowed && opacity > 0.008;
    }
  }

  /** Line2 needs the drawing-buffer size to convert its pixel width. */
  setResolution(width, height) {
    this._resolution.set(width, height);
    for (const { material } of this.lines.values()) material.resolution.set(width, height);
  }

  /** Brightens the focused body's path, and its primary's, and dims the rest. */
  setFocus(bodyId) {
    if (this._focusedId === bodyId) return;
    this._focusedId = bodyId;

    const focusedBody = bodyId ? BODY_BY_ID.get(bodyId) : null;
    const parentId = focusedBody?.parent;

    for (const [id, entry] of this.lines) {
      const isFocus = id === bodyId;
      const isParent = id === parentId;
      const emphasis = isFocus ? 1 : isParent ? 0.5 : 0;

      entry.material.linewidth = BASE_WIDTH + (FOCUS_WIDTH - BASE_WIDTH) * emphasis;
      entry.targetOpacity = BASE_OPACITY + (FOCUS_OPACITY - BASE_OPACITY) * emphasis;
    }
  }

  setVisible(visible) {
    this.root.visible = visible;
  }


  /** Rebuilds paths after the Scale setting changes. */
  rescale() {
    for (const entry of this.lines.values()) {
      const segments = entry.parentId ? SATELLITE_SEGMENTS : HELIOCENTRIC_SEGMENTS;
      const positions = this._pathPositions(entry.view, segments);
      entry.line.geometry.setPositions(positions);
      entry.radius = meanRadius(positions);
    }
  }

  /** Mirrors the moon / dwarf-planet visibility toggles. */
  _applyVisibility() {
    for (const [id, entry] of this.lines) {
      entry.allowed = this.system.isVisible(id);
      if (!entry.allowed) entry.line.visible = false;
    }
  }

  syncVisibility() {
    this._applyVisibility();
  }

  clear() {
    for (const { line, material } of this.lines.values()) {
      line.removeFromParent();
      line.geometry.dispose();
      material.dispose();
    }
    this.lines.clear();
  }

  dispose() {
    this.clear();
    this.root.removeFromParent();
  }
}

/** Mean distance of a sampled path from its own centre, in scene units. */
function meanRadius(positions) {
  const count = positions.length / 3;
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  }
  return count ? total / count : 0;
}

/** GLSL-style smoothstep: 0 at `edge0`, 1 at `edge1`, in either order. */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
