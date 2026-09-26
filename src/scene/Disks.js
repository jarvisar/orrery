/**
 * Measured dust disks round other stars (src/data/disks.js), drawn as glowing
 * dust: a few thin annuli stacked vertically, so the disk has some thickness
 * and brightens edge-on, where the line of sight crosses the most dust. Dust
 * grains scatter light mostly forward, so a disk is brightest looking toward
 * its star through it (a Henyey-Greenstein phase function, g = 0.4).
 *
 * Radii stay in AU and are compressed in the vertex shader with the same law as
 * everything else (scaling.js), so the Scale setting is a uniform, not a rebuild.
 */

import * as THREE from 'three';
import { AU_KM, EARTH_RADIUS_KM } from '../data/bodies.js';
import { EARTH_RADIUS_UNITS } from './scaling.js';

const DUST = { red: 0xd9a27c, blue: 0xa4b6de, neutral: 0xcdbfae };
const LAYERS = [-1, -0.5, 0, 0.5, 1];

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aAU;
  attribute float aAngle;
  attribute float aLayer;
  uniform float uExponent;
  varying float vAU;
  varying float vAngle;
  varying float vLayer;
  varying vec3 vWorld;
  void main() {
    // scaling.js: units = EARTH_RADIUS_UNITS × (km / EARTH_RADIUS_KM) ^ exponent
    float r = ${EARTH_RADIUS_UNITS.toFixed(1)} * pow( aAU * ${(AU_KM / EARTH_RADIUS_KM).toFixed(3)}, uExponent );
    vec3 p = vec3( cos( aAngle ) * r, aLayer * 0.03 * r, -sin( aAngle ) * r );
    vAU = aAU; vAngle = aAngle; vLayer = aLayer;
    vec4 world = modelMatrix * vec4( p, 1.0 );
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec2 uBelt;
  uniform vec3 uColor;
  uniform vec3 uStar;
  uniform float uSeed;
  uniform float uSpin;
  varying float vAU;
  varying float vAngle;
  varying float vLayer;
  varying vec3 vWorld;

  float hash( vec3 p ) {
    p = fract( p * 0.3183099 + 0.1 );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
  }
  float valueNoise( vec3 p ) {
    vec3 i = floor( p ), f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( hash( i ), hash( i + vec3( 1, 0, 0 ) ), f.x ), mix( hash( i + vec3( 0, 1, 0 ) ), hash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
      mix( mix( hash( i + vec3( 0, 0, 1 ) ), hash( i + vec3( 1, 0, 1 ) ), f.x ), mix( hash( i + vec3( 0, 1, 1 ) ), hash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
  }

  void main() {
    #include <logdepthbuf_fragment>
    float width = uBelt.y - uBelt.x;
    float t = ( vAU - uBelt.x ) / width;
    float soft = 0.15;
    float density = smoothstep( -soft, soft, t ) * ( 1.0 - smoothstep( 1.0 - soft, 1.0 + soft, t ) );
    // Ringlets across the belt and clumps along it, turning with the dust.
    float a = vAngle + uSpin;
    vec3 q = vec3( cos( a ) * 3.0, sin( a ) * 3.0, t * 5.0 + uSeed );
    float grain = valueNoise( q * 2.0 ) * 0.5 + valueNoise( q * 5.0 + 7.0 ) * 0.3 + valueNoise( vec3( t * 24.0, uSeed, 1.0 ) ) * 0.4;
    density *= 0.45 + 0.75 * grain;
    density *= exp( -vLayer * vLayer * 2.2 );

    vec3 toStar = normalize( uStar - vWorld );
    vec3 toEye = normalize( cameraPosition - vWorld );
    float g = 0.4;
    float cosine = dot( -toStar, toEye );
    float phase = ( 1.0 - g * g ) / pow( 1.0 + g * g - 2.0 * g * cosine, 1.5 ) * 0.35;
    // Dust farther out is lit more weakly.
    float light = sqrt( uBelt.x / max( vAU, 1e-3 ) );

    gl_FragColor = vec4( uColor * density * phase * light * 0.12, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * @param {object} disk From src/data/disks.js, with `starId`.
 * @param {THREE.Color} light The disk's star light, adapted as the planets' is.
 * @returns {{root: THREE.Group, specs: object[], materials: THREE.Material[], setExponent(k: number): void, update(centre: THREE.Vector3, tDays: number): void, dispose(): void}}
 */
export function createDisk(disk, light, exponent) {
  const root = new THREE.Group();
  root.name = 'disk';
  const color = new THREE.Color(DUST[disk.dust] ?? DUST.neutral).multiply(light).multiplyScalar(disk.young ? 1.3 : 1);
  const materials = [];
  const geometries = [];
  for (const [i, [inner, outer]] of disk.belts.entries()) {
    const geometry = annulus(inner, outer);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uBelt: { value: new THREE.Vector2(inner, outer) },
        uColor: { value: color },
        uStar: { value: new THREE.Vector3() },
        uSeed: { value: i * 3.7 + 1.3 },
        uSpin: { value: 0 },
        uExponent: { value: exponent },
      },
      vertexShader, fragmentShader,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    root.add(mesh);
    materials.push(material);
    geometries.push(geometry);
  }

  // Specs for Belts' particle clouds: the rubble the dust comes from.
  const specs = disk.belts.map(([inner, outer], i) => ({
    id: `disk-${i}`, innerAU: inner, outerAU: outer, thicknessAU: (outer - inner) * 0.08 + inner * 0.05,
    count: Math.round(Math.min(6000, 1500 + (outer - inner) * 25)), color: color.getHex(), size: 1.2,
  }));

  return {
    root, specs, materials,
    setExponent(k) { for (const m of materials) m.uniforms.uExponent.value = k; },
    update(centre, tDays) {
      root.position.copy(centre);
      for (const m of materials) {
        m.uniforms.uStar.value.copy(centre);
        // Round at the orbital rate of the belt's middle (for a Sun-mass star).
        const mean = (m.uniforms.uBelt.value.x + m.uniforms.uBelt.value.y) / 2;
        m.uniforms.uSpin.value = (tDays / (365.25 * mean ** 1.5)) * Math.PI * 2;
      }
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      root.removeFromParent();
    },
  };
}

/** A grid in radius (AU) and angle, repeated for each layer; positions are made in the shader. */
function annulus(inner, outer) {
  const radial = 40, around = 160;
  const margin = (outer - inner) * 0.2;
  const au = [], angle = [], layer = [], index = [];
  for (const [l, height] of LAYERS.entries()) {
    const base = l * (radial + 1) * (around + 1);
    for (let i = 0; i <= radial; i++) {
      const r = Math.max(0.01, inner - margin + (outer - inner + 2 * margin) * (i / radial));
      for (let j = 0; j <= around; j++) {
        au.push(r); angle.push((j / around) * Math.PI * 2); layer.push(height);
      }
    }
    for (let i = 0; i < radial; i++) {
      for (let j = 0; j < around; j++) {
        const a = base + i * (around + 1) + j, b = a + around + 1;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(au.length * 3), 3));
  geometry.setAttribute('aAU', new THREE.Float32BufferAttribute(au, 1));
  geometry.setAttribute('aAngle', new THREE.Float32BufferAttribute(angle, 1));
  geometry.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
  geometry.setIndex(index);
  return geometry;
}
