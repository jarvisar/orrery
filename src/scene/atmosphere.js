/**
 * Atmospheric limb glow: air is invisible face-on and bright edge-on.
 *
 * One transparent shell, slightly larger than the planet. Its back faces show
 * only between the planet's edge and the shell's, drawing the halo off the
 * limb; its front faces cover the disc, drawing haze that thickens toward the
 * edge. Both fade across the terminator, with some forward-scattered light
 * carried onto the night side (a crescent Earth's blue rim).
 *
 * Additive and HDR: the rim peaks just above white so the bloom pass softens it.
 */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec4 world = modelMatrix * vec4( position, 1.0 );
    vWorldPosition = world.xyz;
    vWorldNormal = normalize( mat3( modelMatrix ) * normal );
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uColor;
  uniform float uIntensity;
  // Where the light comes from: the origin for the Sun, anywhere for another star.
  uniform vec3 uStarPosition;
  // cos of the angle, seen from the shell's own centre, at which the planet's
  // limb sits - where the shell's back faces stop being hidden behind it.
  uniform float uLimb;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    #include <logdepthbuf_fragment>

    vec3 normal = normalize( vWorldNormal );
    vec3 toCamera = normalize( cameraPosition - vWorldPosition );
    vec3 toSun = normalize( uStarPosition - vWorldPosition );

    float facing = dot( normal, toCamera );
    float sunward = dot( normal, toSun );

    float glow;
    if ( gl_FrontFacing ) {
      // Over the disc: nothing face-on, thickening toward the limb.
      float t = saturate( ( facing - uLimb ) / ( 1.0 - uLimb ) );
      glow = pow( 1.0 - t, 4.0 ) * step( uLimb, facing ) * 0.55;
    } else {
      // Beyond the disc: brightest against the limb, gone at the shell's edge.
      float t = saturate( -facing / uLimb );
      glow = pow( t, 2.2 );
    }

    float day = smoothstep( -0.28, 0.45, sunward );
    // Light scattered forward through the limb when the Sun is behind the planet.
    float backlit = pow( saturate( dot( -toCamera, toSun ) ), 6.0 ) * 0.6;
    float light = max( day, backlit * smoothstep( -0.6, 0.0, sunward ) );

    gl_FragColor = vec4( uColor * glow * light * uIntensity, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * @param {number} radius Planet radius, in the tilt node's local units.
 * @param {{color: string, intensity?: number, height?: number}} spec
 */
export function createAtmosphere(radius, spec) {
  const height = spec.height ?? 0.03;
  const shellRadius = radius * (1 + height);
  // A little inside the true limb so the halo overlaps the edge rather than
  // leaving a hairline gap along it.
  const limb = Math.sqrt(1 - (1 / (1 + height * 0.92)) ** 2);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(spec.color) },
      uIntensity: { value: 1.6 * (spec.intensity ?? 1) },
      uLimb: { value: limb },
      uStarPosition: { value: new THREE.Vector3() },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(shellRadius, 96, 48), material);
  mesh.name = 'atmosphere';
  mesh.renderOrder = 3;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
