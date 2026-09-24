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
import { sampleOrbitPath, perifocalToWorld, eccentricAnomaly } from '../sim/kepler.js';

/**
 * Samples per revolution. Enough that the chords never show: at 256, the
 * largest orbit on screen - Pluto's, up to 2,500 pixels in radius - strays
 * from the true curve by a fifth of a pixel between samples. Every
 * sample is a quad the line shader expands, every frame, so twice that buys
 * nothing but vertex work.
 */
const HELIOCENTRIC_SEGMENTS = 256;
const SATELLITE_SEGMENTS = 192;

const BASE_WIDTH = 1.1;
const FOCUS_WIDTH = 1.8;
const BASE_OPACITY = 0.42;
const FOCUS_OPACITY = 0.85;

/**
 * Each path is brightest just behind its body and fades back round the orbit
 * to this fraction, like a long exposure of something moving. It says which way
 * everything is going without an arrow in sight, and keeps a busy system from
 * reading as a tangle of identical rings.
 */
const TRAIL_FLOOR = 0.14;
const TRAIL_FALLOFF = 1.6;

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
    /** Shared by every path's shader: 1 while the lines smooth their own edges. See setSmoothing(). */
    this._smooth = { value: 0 };
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
    geometry.setColors(pathPhases(segments));

    const width = heliocentric ? BASE_WIDTH : BASE_WIDTH * 0.75;
    const material = new LineMaterial({
      // Tinted towards the body's own colour, so a dense system reads as
      // separate orbits rather than a ball of white wire.
      color: new THREE.Color(view.body.color ?? '#ffffff').lerp(new THREE.Color(0xffffff), 0.2),
      linewidth: width + this._smooth.value,
      worldUnits: false,
      transparent: true,
      opacity: heliocentric ? BASE_OPACITY : BASE_OPACITY * 0.75,
      depthWrite: false,
      dashed: false,
      vertexColors: true,
      resolution: this._resolution,
    });
    const head = { value: 0 };
    applyTrail(material, head, this._smooth);

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
      width,
      radius: meanRadius(positions),
      targetOpacity: base,
      allowed: true,
      head,
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
   * @param {number} tDays Simulated time, for where each trail's head is.
   */
  update(cameraPosition, tDays) {
    for (const entry of this.lines.values()) {
      entry.head.value = orbitPhase(entry.view.elements, tDays);

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

      entry.width = BASE_WIDTH + (FOCUS_WIDTH - BASE_WIDTH) * emphasis;
      entry.material.linewidth = entry.width + this._smooth.value;
      entry.targetOpacity = BASE_OPACITY + (FOCUS_OPACITY - BASE_OPACITY) * emphasis;
    }
  }

  /**
   * Whether the lines antialias their own edges, for a frame drawn without
   * multisampling. A path a pixel or so wide otherwise comes out as a
   * staircase. Each line is drawn one pixel wider, and its shader fades the
   * margin by how much of each pixel the true line covers.
   */
  setSmoothing(enabled) {
    const margin = enabled ? 1 : 0;
    if (this._smooth.value === margin) return;
    this._smooth.value = margin;
    for (const entry of this.lines.values()) entry.material.linewidth = entry.width + margin;
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

/**
 * Where each vertex sits round the orbit, 0..1, smuggled to the shader in the
 * red channel of the line's colour attribute. The path is sampled evenly in
 * eccentric anomaly, so vertex i of n is simply at i/n.
 */
function pathPhases(segments) {
  const phases = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) phases[i * 3] = i / segments;
  return phases;
}

/** How far round its orbit a body is at `tDays`, in the same 0..1 measure. */
function orbitPhase(el, tDays) {
  const meanAnomaly = (el.meanLong - el.periLong + (360 / el.periodDays) * tDays) * (Math.PI / 180);
  const E = eccentricAnomaly(meanAnomaly, el.e) / (Math.PI * 2);
  return E - Math.floor(E);
}

/**
 * Replaces LineMaterial's colour multiply with the trail's fade, and adds the
 * optional edge smoothing (see Orbits#setSmoothing).
 */
function applyTrail(material, head, smooth) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHead = head;
    shader.uniforms.uSmooth = smooth;
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uHead;\nuniform float uSmooth;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        float behind = fract( uHead - vColor.r );
        alpha *= mix( ${TRAIL_FLOOR.toFixed(3)}, 1.0, pow( 1.0 - behind, ${TRAIL_FALLOFF.toFixed(2)} ) );
        // vUv.x runs -1 to 1 across the drawn width, which is the line's own
        // width plus the one-pixel margin. How much of this pixel the true
        // line covers is then its half-width in pixels less the distance out.
        float halfWidth = linewidth * 0.5;
        float coverage = clamp( halfWidth * ( 1.0 - abs( vUv.x ) ), 0.0, 1.0 );
        alpha *= mix( 1.0, coverage, uSmooth );
        `
      );
  };
  material.customProgramCacheKey = () => 'orbit-trail';
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
