/**
 * Saturn's ring shadows, computed analytically instead of with a shadow map.
 *
 * A point-light cube shadow map cannot resolve anything useful here. At
 * Saturn's distance a 1024px cube face spans some 10,000 scene units, which
 * puts roughly ten texels across the whole planet - enough to produce shadow
 * acne across the lit face and nothing else. Raising the resolution far enough
 * to help costs six full depth passes per frame.
 *
 * Both shadows that matter for a ringed planet are exactly solvable, though:
 *
 *   Rings onto planet - march from the surface point toward the Sun, find where
 *     that ray crosses the ring plane, and look up the ring's own opacity at
 *     that radius.
 *   Planet onto rings - a ray/sphere test from the ring point toward the Sun.
 *
 * Both are a few instructions, exact at any zoom, and free of artefacts.
 */

import * as THREE from 'three';

/**
 * Makes a planet's surface receive the shadow of its rings.
 *
 * @param {THREE.Material} material The planet's material.
 * @param {object} options
 * @param {number} options.innerRadius Ring inner radius, scene units.
 * @param {number} options.outerRadius Ring outer radius, scene units.
 * @returns {{uniforms: object}} Handle whose `uSunDirection` must be kept
 *   pointing at the Sun in the planet mesh's own object space.
 */
export function receiveRingShadow(material, { innerRadius, outerRadius }) {
  const uniforms = {
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uRingMap: { value: null },
    uRingInner: { value: innerRadius },
    uRingOuter: { value: outerRadius },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjectPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjectPosition = transformed;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vObjectPosition;
        uniform vec3 uSunDirection;
        uniform sampler2D uRingMap;
        uniform float uRingInner;
        uniform float uRingOuter;

        // The rings lie in the planet's own XZ plane, so the crossing point is
        // a single division. t < 0 means the Sun is on this side of the plane
        // and nothing can be in the way.
        float ringShadow() {
          if ( abs( uSunDirection.y ) < 1e-5 ) return 1.0;
          float t = -vObjectPosition.y / uSunDirection.y;
          if ( t <= 0.0 ) return 1.0;

          vec3 hit = vObjectPosition + uSunDirection * t;
          float radius = length( hit.xz );
          if ( radius < uRingInner || radius > uRingOuter ) return 1.0;

          float u = ( radius - uRingInner ) / ( uRingOuter - uRingInner );
          float opacity = texture2D( uRingMap, vec2( u, 0.5 ) ).a;
          // Ring particles scatter rather than block outright, so even the
          // densest bands leave the surface dimly lit.
          return 1.0 - 0.82 * opacity;
        }
        `
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        float ringShade = ringShadow();
        reflectedLight.directDiffuse *= ringShade;
        reflectedLight.directSpecular *= ringShade;
        `
      );
  };

  material.customProgramCacheKey = () => 'receive-ring-shadow';
  return { uniforms };
}

/**
 * Makes a ring plane fall dark where its planet eclipses the Sun.
 *
 * @param {THREE.Material} material The ring material.
 * @param {object} options
 * @param {number} options.planetRadius Scene units.
 */
export function receivePlanetShadow(material, { planetRadius }) {
  const uniforms = {
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uPlanetRadius: { value: planetRadius },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjectPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjectPosition = transformed;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vObjectPosition;
        uniform vec3 uSunDirection;
        uniform float uPlanetRadius;

        // Ray/sphere test from the ring particle toward the Sun. The planet is
        // centred on this mesh's own origin, which makes the closest-approach
        // distance a single dot product.
        float planetShadow() {
          float along = dot( -vObjectPosition, uSunDirection );
          if ( along <= 0.0 ) return 1.0;
          float missBy = length( vObjectPosition + uSunDirection * along );
          // A soft edge stands in for the penumbra and hides the terminator seam.
          return mix( 0.16, 1.0, smoothstep( uPlanetRadius * 0.96, uPlanetRadius * 1.06, missBy ) );
        }
        `
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        outgoingLight *= planetShadow();
        #include <opaque_fragment>
        `
      );
  };

  material.customProgramCacheKey = () => 'receive-planet-shadow';
  return { uniforms };
}

/**
 * Points a shadow handle's `uSunDirection` at the Sun, expressed in the given
 * object's local space. Call once per frame, after world matrices are current.
 */
const _inverse = new THREE.Matrix4();
export function updateSunDirection(handle, object, sunWorldPosition) {
  if (!handle) return;
  const direction = handle.uniforms.uSunDirection.value;
  direction.copy(sunWorldPosition).sub(getWorldPosition(object));
  _inverse.copy(object.matrixWorld).invert();
  direction.transformDirection(_inverse);
}

const _world = new THREE.Vector3();
function getWorldPosition(object) {
  return _world.setFromMatrixPosition(object.matrixWorld);
}
