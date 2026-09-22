/**
 * The sky: the real stars, over a soft Milky Way.
 *
 * The old sky was one painted 4k panorama - galactic coordinates, unaligned,
 * with its stars baked in as blobs that smeared as soon as the camera zoomed.
 * Here the two jobs are split. The background is only the diffuse glow of the
 * galaxy, which has no fine detail to lose, reprojected into the scene's frame
 * (see scripts/build-sky.py). The stars are drawn on top as points, a fixed
 * number of pixels across whatever the zoom, so they stay pinpoint sharp.
 *
 * And they are the real ones: every star in the Yale Bright Star Catalogue, in
 * its true direction, brightness and colour. Orion is where Orion is.
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

    // Relative flux, 1 at magnitude 1. Size and brightness both follow it, but
    // compressed: a first-magnitude star is a hundred times a sixth, and drawn
    // at a hundred times the brightness it would erase everything else. This
    // halves the brightness every two magnitudes instead, the way a long
    // exposure flattens the sky.
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
      // Opaque, and drawn first: the planets then simply paint over it, which
      // is cheaper and cleaner than depth-testing points at infinity against
      // a logarithmic depth buffer.
      transparent: false,
    });
  }

  /** Starts both downloads. Neither blocks the loading screen for long. */
  load() {
    this.assets.texture('stars_milkyway', 'map', -1).then((texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.background = texture;
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

  setPixelRatio(ratio) {
    this.material.uniforms.uPixelRatio.value = ratio;
  }

  dispose() {
    this.stars?.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * A star's colour from its B-V index: B-V to temperature (Ballesteros 2012),
 * then temperature to an approximate blackbody RGB. Pulled most of the way to
 * white, because that is how stars look to the eye and to a camera - a hint of
 * blue in Rigel and orange in Betelgeuse, not a bag of sweets.
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
