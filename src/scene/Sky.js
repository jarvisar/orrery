/**
 * The sky: the Yale Bright Star Catalogue, in true direction, brightness and
 * colour, over a diffuse Milky Way background reprojected into the scene's
 * frame (see scripts/build-sky.py). Stars are drawn as fixed-pixel-size points
 * so they stay sharp at any zoom.
 */

import * as THREE from 'three';

const STARS_URL = 'public/data/stars.bin';

const vertexShader = /* glsl */ `
  attribute float aMagnitude;
  attribute vec3 aColor;

  uniform float uPixelRatio;
  uniform float uBrightness;

  varying vec3 vColor;

  void main() {
    // At infinity: only the camera's rotation applies, never its position.
    vec3 direction = mat3( viewMatrix ) * position;
    gl_Position = projectionMatrix * vec4( direction, 1.0 );
    // Pinned just inside the far plane. The near plane moves with the camera
    // and can sit well beyond one unit, which would clip every star.
    gl_Position.z = gl_Position.w * 0.99999;

    // Relative flux, 1 at magnitude 1. Size and brightness follow it but
    // compressed (roughly halving every two magnitudes), or first-magnitude
    // stars would erase everything else.
    float flux = pow( 10.0, -0.4 * ( aMagnitude - 1.0 ) );
    gl_PointSize = clamp( 2.3 + 2.4 * pow( flux, 0.42 ), 2.3, 10.0 ) * uPixelRatio;
    vColor = aColor * min( pow( flux, 0.38 ), 2.0 ) * uBrightness;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;

  void main() {
    vec2 offset = gl_PointCoord - 0.5;
    float r2 = dot( offset, offset ) * 4.0;
    // A tight core with a faint skirt, like a star through a lens.
    float profile = exp( -r2 * 9.0 ) + 0.08 * exp( -r2 * 2.5 );
    if ( profile < 0.004 ) discard;
    gl_FragColor = vec4( vColor * profile, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/AssetLoader.js').AssetLoader} assets
   */
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.stars = null;
    /** The Milky Way panorama and the cube map drawn from it. See _drawBackground(). */
    this._panorama = null;
    this._cube = null;
    // Runs after three's own handler. The cube was lost with the context.
    assets.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this._cube = null;
      this._drawBackground();
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: 1 },
        uBrightness: { value: 1 },
      },
      vertexShader,
      fragmentShader,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      // Opaque and drawn first so the planets paint over it, rather than
      // depth-testing points at infinity against a logarithmic depth buffer.
      transparent: false,
    });
  }

  load() {
    // Its image is kept, to draw the cube map again after a lost context.
    this.assets.texture('stars_milkyway', 'map', -1, { keepImage: true }).then((texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this._panorama = texture;
      this._drawBackground();
      this.scene.backgroundIntensity = 0.24;
    });

    return fetch(STARS_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.arrayBuffer();
      })
      .then((buffer) => this._build(buffer))
      .catch((error) => console.warn('[sky] star catalogue failed to load', error));
  }

  /**
   * The background as a cube map, like the one three would make from the
   * panorama itself, but smaller. three makes each face as tall as the
   * panorama. That's twice the detail it has, since a face only spans a
   * quarter of its width. three also gives each face a depth buffer that a
   * background never uses. With the panorama freed from the GPU once drawn,
   * this takes 8MB instead of 67MB and looks the same.
   */
  _drawBackground() {
    const panorama = this._panorama;
    if (!panorama?.image) return;
    this._cube = new THREE.WebGLCubeRenderTarget(panorama.image.width / 4, { depthBuffer: false });
    this._cube.fromEquirectangularTexture(this.assets.renderer, panorama);
    panorama.dispose();
    this.scene.background = this._cube.texture;
  }

  _build(buffer) {
    const view = new DataView(buffer);
    const count = Math.floor(buffer.byteLength / 8);
    const positions = new Float32Array(count * 3);
    const magnitudes = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const at = i * 8;
      positions[i * 3] = view.getInt16(at, true) / 32767;
      positions[i * 3 + 1] = view.getInt16(at + 2, true) / 32767;
      positions[i * 3 + 2] = view.getInt16(at + 4, true) / 32767;
      magnitudes[i] = view.getUint8(at + 6) / 25 - 1.5;
      starColor(view.getInt8(at + 7) / 60, color);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aMagnitude', new THREE.BufferAttribute(magnitudes, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    this.stars = new THREE.Points(geometry, this.material);
    this.stars.name = 'stars';
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1000;
    this.scene.add(this.stars);
  }

  /** The stars as drawn: directions (x, y, z per star) and magnitudes, brightest first. Null until loaded. */
  get drawn() {
    if (!this.stars) return null;
    const { position, aMagnitude } = this.stars.geometry.attributes;
    return { positions: position.array, magnitudes: aMagnitude.array };
  }

  setPixelRatio(ratio) {
    this.material.uniforms.uPixelRatio.value = ratio;
  }

  dispose() {
    this.stars?.geometry.dispose();
    this.material.dispose();
    this._cube?.dispose();
  }
}

/**
 * A star's colour from its B-V index: B-V to temperature (Ballesteros 2012),
 * then temperature to an approximate blackbody RGB, pulled most of the way to
 * white as stars look to the eye.
 */
function starColor(bv, out) {
  const kelvin = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = kelvin / 100;

  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * (t - 60) ** -0.1332;
    g = 288.12 * (t - 60) ** -0.0755;
    b = 255;
  }

  const clamp = (v) => Math.min(255, Math.max(0, v)) / 255;
  out.setRGB(clamp(r), clamp(g), clamp(b), THREE.SRGBColorSpace);
  return out.lerp(WHITE, 0.45);
}

const WHITE = new THREE.Color(1, 1, 1);
