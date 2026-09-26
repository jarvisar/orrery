import * as THREE from 'three';
import { addPatch } from './shading.js';
import { blackbodyLinear, glowIntensity } from '../data/blackbody.js';
import { heatRadiance } from '../data/worlds.js';

/**
 * Materials for other stars' worlds, painted by worldTextures.js from the
 * descriptions in src/data/worlds.js. Planets use the same Phong material as
 * the Solar System's, reading bump, shine and heat from one packed data map
 * (see worldTextures.js for the channels); stars get their own photosphere.
 */

/**
 * @param {THREE.MeshPhongMaterial} material
 * @param {object} look  From src/data/worlds.js.
 * @param {{map: THREE.Texture, data: THREE.Texture}} maps
 * @param {number} radius Scene units, for the bump scale.
 */
export function exoplanetSurface(material, look, maps, radius) {
  material.map = maps.map;
  material.color.set(0xffffff);
  if (look.bump) {
    material.bumpMap = maps.data;
    material.bumpScale = look.bump * radius * 0.65;
  }
  if (look.specular) {
    // Seas and ice glint; land and cloud stay matte.
    material.specularMap = maps.data;
    material.shininess = 32;
    material.specular.set(0x2a2a2a);
    addPatch(material, 'exo-shine', (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <specularmap_fragment>', /* glsl */ `
        float specularStrength = texture2D( specularMap, vSpecularMapUv ).a;
      `);
    });
  }
  if (look.heat) {
    // Thermal glow, day and night alike, interpolated in log space between
    // the coldest and hottest the map shows: brightness rises steeply with
    // temperature, and the colour reddens as it falls.
    const { low, high } = heatRadiance(look.heat);
    const floor = (rgb) => new THREE.Vector3(...rgb.map((c) => Math.max(c, 1e-4)));
    const uniforms = { uHeatLow: { value: floor(low) }, uHeatHigh: { value: floor(high) } };
    material.emissiveMap = maps.data;
    material.emissive.set(0xffffff);
    material.emissiveIntensity = 1;
    addPatch(material, 'exo-heat', (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uHeatLow;\nuniform vec3 uHeatHigh;')
        .replace('#include <emissivemap_fragment>', /* glsl */ `
          float heat = texture2D( emissiveMap, vEmissiveMapUv ).b;
          totalEmissiveRadiance = exp( mix( log( uHeatLow ), log( uHeatHigh ), heat ) );
        `);
    });
  }
}

/**
 * A star's colour as drawn, in linear light. The Sun is graded warmer than a
 * pure blackbody (see sunSurface in shading.js); a Sun-like star gets the same
 * grade so it matches, fading out toward hotter stars (pure blue-white) and
 * cooler ones (pure orange).
 */
const SUN_CENTRE = new THREE.Color(1.0, 0.74, 0.4);
export function starDisplayColor(teff) {
  const [r, g, b] = blackbodyLinear(teff);
  const [sr, sg, sb] = blackbodyLinear(5772);
  const grade = new THREE.Color(SUN_CENTRE.r / sr, SUN_CENTRE.g / sg, SUN_CENTRE.b / sb);
  const weight = teff >= 5772 ? 1 - smoothstep(5772, 8500, teff) : smoothstep(3200, 5772, teff);
  grade.lerp(WHITE, 1 - weight);
  return new THREE.Color(r, g, b).multiply(grade);
}
const WHITE = new THREE.Color(1, 1, 1);

/** A surface with nothing on it: white dwarfs, pulsars. */
const PLAIN = (() => {
  const texture = new THREE.DataTexture(new Uint8Array([140, 140, 0, 0]), 1, 1);
  texture.needsUpdate = true;
  return texture;
})();

/**
 * Another star's photosphere, on a MeshBasicMaterial.
 *
 * Limb darkening from the Eddington-Barbier relation: looking in at angle
 * θ (μ = cos θ) you see down to where T(μ)⁴ = ¾Teff⁴(μ + ⅔), so the edge shows
 * cooler gas. Taking Planck's law at red, green and blue wavelengths gives
 * both the darkening (about a third of the centre's brightness at the Sun's
 * limb, as observed) and the reddening, weaker for hotter stars. Granulation,
 * spots and faculae come from the baked data map; spots are darkened by the
 * blackbody ratio at their lower temperature.
 *
 * @param {object} look From starLook() in src/data/worlds.js.
 * @param {THREE.Texture|null} data Baked by WorldPainter.paintStar, or null for a smooth star.
 * @param {{map: THREE.Texture, data: THREE.Texture}|null} banded A brown dwarf's cloud maps.
 */
export function stellarSurface(material, look, data, banded = null) {
  const lambda = [610, 550, 465];
  const planck = (t) => lambda.map((l) => 1 / Math.expm1(1.4388e7 / (l * t)));
  const spot = planck(look.spotTemperature ?? look.teff).map((v, i) => v / planck(look.teff)[i]);
  const glow = banded ? look.banded.heat : null;
  const uniforms = {
    uTeff: { value: look.teff },
    uStarColor: { value: starDisplayColor(look.teff) },
    uIntensity: { value: look.type === 'brownDwarf' ? 1 : 1.4 },
    uGranules: { value: look.granuleContrast ?? 0 },
    uSpot: { value: new THREE.Vector3(...spot) },
    uData: { value: banded?.data ?? data ?? PLAIN },
    uHeat: { value: new THREE.Vector2(...(glow ? [glowIntensity(glow.low), glowIntensity(glow.high)].map((v) => Math.max(v, 0.04)) : [1, 1])) },
    uTime: { value: 0 },
  };
  material.map = banded?.map ?? PLAIN;
  material.color.set(0xffffff);
  addPatch(material, banded ? 'exo-star-banded' : 'exo-star', (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStarNormal;\nvarying vec3 vStarView;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvStarNormal = normalize( normalMatrix * normal );\nvStarView = -mvPosition.xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        varying vec3 vStarNormal;
        varying vec3 vStarView;
        uniform float uTeff;
        uniform vec3 uStarColor;
        uniform float uIntensity;
        uniform float uGranules;
        uniform vec3 uSpot;
        uniform sampler2D uData;
        uniform vec2 uHeat;
        uniform float uTime;
      `)
      .replace('#include <map_fragment>', /* glsl */ `
        #include <map_fragment>
        float mu = saturate( dot( normalize( vStarNormal ), normalize( vStarView ) ) );
        const vec3 LAMBDA = vec3( 610.0, 550.0, 465.0 );
        float tMu = uTeff * pow( 0.75 * ( mu + 2.0 / 3.0 ), 0.25 );
        float tCentre = uTeff * pow( 1.25, 0.25 );
        vec3 limb = ( exp( 1.4388e7 / ( LAMBDA * tCentre ) ) - 1.0 ) / ( exp( 1.4388e7 / ( LAMBDA * tMu ) ) - 1.0 );
        vec4 surface = texture2D( uData, vMapUv );
        ${banded ? /* glsl */ `
          // A brown dwarf: its own dull glow through its cloud bands.
          float glow = exp( mix( log( uHeat.x ), log( uHeat.y ), surface.b ) );
          diffuseColor.rgb = diffuseColor.rgb * glow * limb * 2.2;
        ` : /* glsl */ `
          // Granules slowly come and go: two fields, faded in and out of step.
          float churn = 0.5 + 0.5 * sin( uTime * 0.25 + surface.a * 7.0 + surface.r * 4.0 );
          float granule = mix( surface.r, surface.g, churn );
          float grain = 1.0 + ( granule - 0.55 ) * uGranules * 2.0;
          vec3 spots = mix( vec3( 1.0 ), mix( vec3( 1.0 ), uSpot, 0.55 ), smoothstep( 0.0, 0.5, surface.b ) );
          spots = mix( spots, uSpot, smoothstep( 0.5, 1.0, surface.b ) );
          float faculae = 1.0 + surface.a * 0.3 * pow( 1.0 - mu, 1.5 );
          diffuseColor.rgb = uStarColor * uIntensity * limb * grain * spots * faculae;
        `}
      `);
  });
  return { uniforms };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
