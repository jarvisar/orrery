/**
 * Composable edits to three's built-in materials.
 *
 * A material has a single `onBeforeCompile` hook, so each edit registers a
 * named patch; they run in order and the program cache key names them all, so
 * materials with the same set of patches share one compiled program. Anything
 * that differs between bodies must be a uniform, never a baked-in constant.
 */

import * as THREE from 'three';

/**
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
 * Softens the day/night line on bodies with thick atmospheres, which scatter
 * light round the terminator. Wrapping the Lambert cosine by `wrap` moves the
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
 * Restricts an emissive map (Earth's city lights) to the night side, since
 * emissive otherwise ignores lighting. Assumes the Sun is point light 0; the
 * fade starts just before sunset.
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
 * The Sun's visible surface: limb darkening (the edge shows cooler, shallower
 * gas, roughly I = 0.4 + 0.6 cos(theta)) written in HDR, several times brighter
 * than white, so tone mapping rolls the centre off and the bloom pass has
 * something to bloom.
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
        // Colour and brightness come from mu; the texture supplies only fine
        // grain. The source art has broad bright blotches the real photosphere
        // lacks, so a heavily blurred sample of the same map is subtracted out.
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
