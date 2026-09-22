/**
 * Small, composable edits to three's built-in materials.
 *
 * three.js gives a material a single `onBeforeCompile` hook, and several things
 * here want one: Earth's night lights, Saturn's ring shadow, the soft
 * terminator on anything with an atmosphere, the Sun's limb darkening. Each
 * registers a named patch; the material runs them in order, and its program
 * cache key names them all, so every material with the same set of patches
 * still shares one compiled program. Anything that differs between bodies is
 * a uniform, never a constant baked into the source.
 */

import * as THREE from 'three';

/**
 * Registers a shader edit on a material.
 *
 * @param {THREE.Material} material
 * @param {string} key  Names the patch in the program cache key.
 * @param {(shader: THREE.WebGLProgramParametersWithUniforms) => void} patch
 */
export function addPatch(material, key, patch) {
  const patches = (material.userData.patches ??= []);
  patches.push({ key, patch });

  const cacheKey = patches.map((p) => p.key).join('+');
  material.onBeforeCompile = (shader) => {
    for (const entry of patches) entry.patch(shader);
  };
  material.customProgramCacheKey = () => cacheKey;
}

/**
 * Softens the day/night line on bodies with thick atmospheres.
 *
 * Lambert shading ends light abruptly at 90 degrees from the Sun, which is right
 * for the Moon and wrong for Jupiter: a deep atmosphere scatters light round
 * the terminator into a long twilight. Wrapping the cosine by `wrap` moves the
 * edge a few degrees past the geometric one and lets it fade instead of cut.
 */
export function softTerminator(material, wrap) {
  const uniforms = { uTerminatorWrap: { value: wrap } };
  addPatch(material, 'soft-terminator', (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTerminatorWrap;')
      .replace(
        '#include <lights_phong_pars_fragment>',
        THREE.ShaderChunk.lights_phong_pars_fragment.replace(
          'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );',
          /* glsl */ `float dotNL = saturate(
            ( dot( geometryNormal, directLight.direction ) + uTerminatorWrap ) / ( 1.0 + uTerminatorWrap ) );`
        )
      );
  });
}

/**
 * Restricts an emissive map to the night side.
 *
 * Earth's city lights are an emissive texture, and emissive ignores lighting by
 * definition, so out of the box the lights glow straight through local noon.
 * This gates them on the angle between the surface and the Sun, both of which
 * Phong already has in view space at this point in the shader. The fade starts
 * just before sunset, the way lights come on at dusk.
 */
export function nightSideEmissive(material) {
  addPatch(material, 'night-side-emissive', (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      /* glsl */ `
      #include <emissivemap_fragment>
      #if NUM_POINT_LIGHTS > 0
        vec3 sunDirection = normalize( pointLights[ 0 ].position + vViewPosition );
        float dayness = dot( normal, sunDirection );
        totalEmissiveRadiance *= smoothstep( 0.12, -0.14, dayness );
      #endif
      `
    );
  });
}

/**
 * The visible surface of the Sun.
 *
 * A texture on an unlit sphere reads as an orange ball. Two things make it read
 * as a star instead. Limb darkening: looking at the edge of the disc you see
 * cooler, shallower gas, so it is dimmer and redder than the centre - the
 * visible-light law is roughly I = 0.4 + 0.6 cos(theta). And real brightness:
 * the surface is written in HDR, several times brighter than white, so tone
 * mapping rolls the centre off toward white and the bloom pass has something
 * to bloom.
 *
 * @returns {{uniforms: {uIntensity: {value: number}}}}
 */
export function sunSurface(material, intensity = 1.4) {
  const uniforms = { uIntensity: { value: intensity } };
  addPatch(material, 'sun-surface', (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSunNormal;\nvarying vec3 vSunView;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvSunNormal = normalize( normalMatrix * normal );\nvSunView = -mvPosition.xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vSunNormal;\nvarying vec3 vSunView;\nuniform float uIntensity;'
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        float mu = saturate( dot( normalize( vSunNormal ), normalize( vSunView ) ) );
        // Colour and brightness come from depth - the centre of the disc shows
        // deeper, hotter gas than the limb. The texture only supplies grain,
        // and only its fine grain: the source art has broad bright blotches
        // the real, remarkably even photosphere does not, so a heavily blurred
        // sample of the same map is subtracted out.
        vec3 luma = vec3( 0.2126, 0.7152, 0.0722 );
        float granule = dot( diffuseColor.rgb, luma );
        float broad = dot( texture2D( map, vMapUv, 6.0 ).rgb * diffuse, luma );
        float mottle = clamp( 1.0 + ( granule - broad ) * 0.9, 0.82, 1.12 );
        vec3 limbColor = vec3( 1.0, 0.34, 0.06 );
        vec3 centreColor = vec3( 1.0, 0.74, 0.4 );
        vec3 photosphere = mix( limbColor, centreColor, smoothstep( 0.0, 0.9, mu ) );
        float limb = 0.3 + 0.7 * pow( mu, 0.6 );
        diffuseColor.rgb = photosphere * limb * mottle * uIntensity;
        `
      );
  });
  return { uniforms };
}
