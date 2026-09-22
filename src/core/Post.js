/**
 * The finishing pipeline: HDR render, bloom, then a film-like final pass.
 *
 * Rendering straight to the canvas clips every value at white and tone maps
 * each material separately, which is a large part of why a raw three.js scene
 * looks like a tech demo: highlights are hard-edged, the Sun is a flat disc,
 * and dark gradients band. Here the scene renders into a half-float target, so
 * the Sun can be several times brighter than white. Bloom spreads the
 * brightest light the way a lens does. One final pass then tone maps the whole
 * frame at once, adds a slight vignette, and dithers to kill banding in the
 * glows and the Milky Way.
 *
 * It costs a few full-screen passes, so it can be switched off in Settings; the
 * scene looks the same without it, minus the glow.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class Post {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      // The canvas's own antialiasing does not apply to an offscreen target.
      samples: 4,
    });

    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    // Threshold just above white, so only genuinely bright light blooms: the
    // Sun, the lit limb of an atmosphere, the brightest stars.
    this.bloom = new UnrealBloomPass(size.clone(), 0.5, 0.45, 0.9);
    this.composer.addPass(this.bloom);

    this.finish = new FinishPass();
    this.composer.addPass(this.finish);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /** Follows the canvas. `pixelRatio` is the renderer's, render scale included. */
  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(deltaSeconds) {
    if (this.enabled) this.composer.render(deltaSeconds);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.composer.dispose();
    this.bloom.dispose();
    this.finish.dispose();
  }
}

/**
 * Tone mapping and colour-space conversion, as three's OutputPass does, plus
 * the two things that make a render look photographed rather than drawn.
 */
class FinishPass extends Pass {
  constructor() {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      toneMappingExposure: { value: 1 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uSeed: { value: 0 },
    };
    this.material = new THREE.RawShaderMaterial({
      name: 'FinishPass',
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        precision highp float;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        attribute vec3 position;
        attribute vec2 uv;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        uniform float uSeed;
        varying vec2 vUv;

        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>

        float hash( vec2 p ) {
          p = fract( p * vec2( 443.897, 441.423 ) + uSeed );
          p += dot( p, p.yx + 19.19 );
          return fract( ( p.x + p.y ) * p.x );
        }

        void main() {
          vec4 color = texture2D( tDiffuse, vUv );

          #if defined( ACES_FILMIC_TONE_MAPPING )
            color.rgb = ACESFilmicToneMapping( color.rgb );
          #elif defined( AGX_TONE_MAPPING )
            color.rgb = AgXToneMapping( color.rgb );
          #elif defined( NEUTRAL_TONE_MAPPING )
            color.rgb = NeutralToneMapping( color.rgb );
          #elif defined( LINEAR_TONE_MAPPING )
            color.rgb = LinearToneMapping( color.rgb );
          #endif

          // A lens darkens toward its corners. Barely: enough to hold the eye
          // in the middle of the frame, not enough to notice as an effect.
          vec2 centred = ( vUv - 0.5 ) * vec2( uResolution.x / uResolution.y, 1.0 );
          color.rgb *= 1.0 - 0.22 * smoothstep( 0.45, 1.15, length( centred ) );

          color = sRGBTransferOETF( color );

          // Triangular dither of about one 8-bit step. The glows and the Milky
          // Way are long, faint gradients, which is exactly where banding shows.
          vec2 pixel = gl_FragCoord.xy;
          float noise = hash( pixel ) + hash( pixel + 71.3 ) - 1.0;
          color.rgb += noise / 255.0;

          gl_FragColor = color;
        }
      `,
    });
    this._quad = new FullScreenQuad(this.material);
    this._toneMapping = null;
  }

  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    this.uniforms.uSeed.value = (this.uniforms.uSeed.value + 0.618) % 1;

    if (this._toneMapping !== renderer.toneMapping) {
      this._toneMapping = renderer.toneMapping;
      const define = {
        [THREE.ACESFilmicToneMapping]: 'ACES_FILMIC_TONE_MAPPING',
        [THREE.AgXToneMapping]: 'AGX_TONE_MAPPING',
        [THREE.NeutralToneMapping]: 'NEUTRAL_TONE_MAPPING',
        [THREE.LinearToneMapping]: 'LINEAR_TONE_MAPPING',
      }[renderer.toneMapping];
      this.material.defines = define ? { [define]: '' } : {};
      this.material.needsUpdate = true;
    }

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this._quad.dispose();
  }
}
