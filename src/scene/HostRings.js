/**
 * A faint ring round each star in the sky that has planets, so the ones worth
 * clicking can be found. Shown only in the whole-system view (main.js decides),
 * fading in and out.
 *
 * Drawn the way Sky.js draws the stars: at infinity, a fixed size in pixels,
 * opaque and early, so the planets paint over any ring behind them.
 */

import * as THREE from 'three';

/** Ring diameter in CSS pixels, and how long a fade takes, in seconds. */
const SIZE = 17;
const FADE = 0.35;

const vertexShader = /* glsl */ `
  uniform float uSize;

  void main() {
    vec3 direction = mat3( viewMatrix ) * position;
    gl_Position = projectionMatrix * vec4( direction, 1.0 );
    gl_Position.z = gl_Position.w * 0.99999;
    gl_PointSize = uSize;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSize;

  void main() {
    // Distance from the centre in pixels, and a ring about a pixel wide on its edge.
    float r = length( gl_PointCoord - 0.5 ) * uSize;
    float ring = 1.0 - smoothstep( 0.0, 1.0, abs( r - uSize * 0.42 ) );
    if ( ring <= 0.0 ) discard;
    gl_FragColor = vec4( uColor * ring * uOpacity, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class HostRings {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: SIZE },
        uColor: { value: new THREE.Color('#f3bd6e').multiplyScalar(0.55) },
        uOpacity: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    // Empty until the hosts arrive, but in the scene now so its program is
    // compiled with the rest before the first frame.
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.name = 'host rings';
    this.points.frustumCulled = false;
    this.points.renderOrder = -999; // just after the stars
    scene.add(this.points);

    this.shown = false;
  }

  /** @param {Array<{x: number, y: number, z: number}>} hosts  SkyHosts.hosts */
  setHosts(hosts) {
    const positions = new Float32Array(hosts.flatMap((h) => [h.x, h.y, h.z]));
    this.points.geometry.dispose();
    this.points.geometry = new THREE.BufferGeometry();
    this.points.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  }

  setShown(shown) { this.shown = shown; }

  setPixelRatio(ratio) { this.material.uniforms.uSize.value = SIZE * ratio; }

  /** Eases toward shown or hidden; `instant` for reduced motion. */
  update(dt, { instant = false } = {}) {
    const opacity = this.material.uniforms.uOpacity;
    const target = this.shown ? 1 : 0;
    opacity.value = instant ? target
      : target > opacity.value ? Math.min(target, opacity.value + dt / FADE) : Math.max(target, opacity.value - dt / FADE);
    this.points.visible = opacity.value > 0;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
