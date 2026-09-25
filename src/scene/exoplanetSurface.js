import { addPatch } from './shading.js';

/**
 * Procedural illustrative surfaces; no Earth continents borrowed for unknown
 * worlds. `body.surface` is the model's call (src/data/exoplanets.js): banded
 * cloud decks for anything large enough to hold on to a thick envelope, rock
 * below that, granulation on stars.
 */
export function exoplanetSurface(material, body) {
  const kind = body.kind === 'star' ? 'star' : body.surface === 'rock' ? 'rock' : 'clouds';
  let seed = 0;
  for (const char of body.name) seed = (seed * 31 + char.charCodeAt(0)) % 10007;
  addPatch(material, `exo-${kind}`, (shader) => {
    shader.uniforms.uExoSeed = { value: seed / 100 };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vExoPoint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvExoPoint = normalize(position);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vExoPoint;
      uniform float uExoSeed;
      float exoNoise(vec3 p) {
        return sin(p.x * 7.0 + sin(p.z * 8.0 + uExoSeed)) *
          sin(p.y * 11.0 + sin(p.x * 6.0 + uExoSeed));
      }`).replace('#include <map_fragment>', `#include <map_fragment>
      vec3 p = vExoPoint;
      float cloud = exoNoise(p * 2.0) + 0.4 * exoNoise(p * 5.0);
      float detail = ${{
        star: '0.94 + 0.06 * exoNoise(p * 15.0)',
        clouds: '0.79 + 0.12 * sin(p.y * 65.0 + cloud * 1.5) + 0.08 * cloud',
        rock: '0.70 + 0.20 * cloud + 0.08 * exoNoise(p * 18.0)',
      }[kind]};
      diffuseColor.rgb *= detail;
    `);
  });
}
