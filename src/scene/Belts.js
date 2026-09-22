/**
 * The asteroid and Kuiper belts, as point clouds.
 *
 * Each particle keeps its orbit in AU alongside its unit direction, so changing
 * the Scale setting is a cheap rescale of existing buffers rather than a
 * full regeneration. The whole cloud rotates at the mean orbital rate for its
 * distance, driven by the same simulation clock as the planets, so the belts
 * stay in step when time is paused or reversed.
 */

import * as THREE from 'three';
import { BELTS, SIDEREAL_YEAR_DAYS } from '../data/bodies.js';
import { heliocentricDistance } from './scaling.js';

export class Belts {
  /** @param {THREE.Scene} scene */
  constructor(scene, system) {
    this.system = system;
    this.root = new THREE.Group();
    this.root.name = 'belts';
    scene.add(this.root);

    this.clouds = [];
    this.density = 1;
    this._sprite = makeParticleTexture();
  }

  build(density = this.density) {
    this.clear();
    this.density = density;
    for (const spec of BELTS) this.clouds.push(this._createCloud(spec, density));
  }

  _createCloud(spec, density) {
    const count = Math.max(0, Math.round(spec.count * density));
    const au = new Float32Array(count);
    const direction = new Float32Array(count * 3);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    const base = new THREE.Color(spec.color);
    const tint = new THREE.Color();

    for (let i = 0; i < count; i++) {
      // sqrt keeps the area density even instead of crowding the inner edge.
      const t = Math.sqrt(Math.random());
      const radiusAU = spec.innerAU + (spec.outerAU - spec.innerAU) * t;
      const theta = Math.random() * Math.PI * 2;
      // Two samples summed gives a soft centre-weighted spread without a
      // hard cutoff at the rim of the torus.
      const heightAU = (Math.random() + Math.random() - 1) * spec.thicknessAU * 0.5;

      const r = Math.hypot(radiusAU, heightAU);
      au[i] = r;
      direction[i * 3] = (Math.cos(theta) * radiusAU) / r;
      direction[i * 3 + 1] = heightAU / r;
      direction[i * 3 + 2] = (Math.sin(theta) * radiusAU) / r;

      tint.copy(base).offsetHSL(
        (Math.random() - 0.5) * 0.04,
        (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.35
      );
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: spec.size,
      map: this._sprite,
      vertexColors: true,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      alphaTest: 0.04,
    });

    const points = new THREE.Points(geometry, material);
    points.name = spec.id;
    points.frustumCulled = false;
    this.root.add(points);

    const cloud = { spec, points, geometry, material, au, direction, count };
    this._writePositions(cloud);
    return cloud;
  }

  /** Recomputes scene-space positions from the stored AU radii. */
  _writePositions(cloud) {
    const positions = cloud.geometry.attributes.position.array;
    const exponent = this.system.scaleExponent;

    for (let i = 0; i < cloud.count; i++) {
      const scale = heliocentricDistance(cloud.au[i], exponent);
      positions[i * 3] = cloud.direction[i * 3] * scale;
      positions[i * 3 + 1] = cloud.direction[i * 3 + 1] * scale;
      positions[i * 3 + 2] = cloud.direction[i * 3 + 2] * scale;
    }
    cloud.geometry.attributes.position.needsUpdate = true;
    cloud.geometry.computeBoundingSphere();
  }

  /** Spins each belt at the circular orbital rate for its mean radius. */
  update(tDays) {
    for (const cloud of this.clouds) {
      const meanAU = (cloud.spec.innerAU + cloud.spec.outerAU) / 2;
      const periodDays = SIDEREAL_YEAR_DAYS * meanAU ** 1.5;
      cloud.points.rotation.y = -(tDays / periodDays) * Math.PI * 2;
    }
  }

  rescale() {
    for (const cloud of this.clouds) this._writePositions(cloud);
  }

  setVisible(visible) {
    this.root.visible = visible;
  }

  clear() {
    for (const cloud of this.clouds) {
      cloud.points.removeFromParent();
      cloud.geometry.dispose();
      cloud.material.dispose();
    }
    this.clouds.length = 0;
  }

  dispose() {
    this.clear();
    this._sprite.dispose();
    this.root.removeFromParent();
  }
}

/** A soft round dot; square points read as pixel noise at these sizes. */
function makeParticleTexture(size = 32) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
