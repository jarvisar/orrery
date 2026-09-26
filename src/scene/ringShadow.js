/**
 * Ring shadows, computed analytically instead of with a shadow map.
 *
 * At Saturn's distance a 1024px point-light cube face spans ~10,000 scene
 * units, roughly ten texels across the planet: shadow acne and nothing else.
 * Both shadows are exactly solvable instead:
 *
 *   Rings onto planet - intersect the ray to the Sun with the ring plane and
 *     look up the ring's opacity at that radius.
 *   Planet onto rings - a ray/sphere test from the ring point toward the Sun.
 */

import * as THREE from 'three';
import { addPatch } from './shading.js';

/**
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

  addPatch(material, 'receive-ring-shadow', (shader) => {
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
  });

  return { uniforms };
}

/**
 * Darkens a ring plane where its planet eclipses the Sun, and lights it by the
 * Sun's elevation above it: near equinox the rings all but vanish. From the
 * unlit side only transmitted light shows, so dense bands go dark and sparse
 * ones glow.
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

  addPatch(material, 'receive-planet-shadow', (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vObjectPosition;\nvarying float vViewSide;'
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vObjectPosition = transformed;
        // Which face of the ring plane the camera is on, in the ring's own space.
        vViewSide = ( inverse( modelMatrix ) * vec4( cameraPosition, 1.0 ) ).z;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vObjectPosition;
        varying float vViewSide;
        uniform vec3 uSunDirection;
        uniform float uPlanetRadius;

        float ringIllumination( float density ) {
          float elevation = abs( uSunDirection.z );
          float lit = mix( 0.1, 1.0, smoothstep( 0.0, 0.2, elevation ) );
          bool sunlitFace = sign( vViewSide ) == sign( uSunDirection.z );
          return sunlitFace ? lit : lit * mix( 0.6, 0.14, density );
        }

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
        outgoingLight *= planetShadow() * ringIllumination( diffuseColor.a );
        #include <opaque_fragment>
        `
      );
  });

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
