/**
 * Post-processing: HDR render, bloom, then a final pass that tone maps the
 * whole frame at once, adds a slight vignette and dithers. The scene renders
 * into a half-float target so the Sun can be brighter than white. Can be
 * switched off in Settings.
 *
 * The bloom is added in the final pass rather than by the bloom pass itself.
 * UnrealBloomPass would blend into the 4x multisampled scene target, which then
 * needs a second resolve; folding the add into the final pass saves two
 * full-screen passes, which matters on bandwidth-limited phones.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const MULTISAMPLES = 4;

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
      // The canvas's antialiasing does not apply offscreen. Whether this target
      // is multisampled is the resolution controller's call; see setSize() and
      // src/core/Viewport.js.
      samples: MULTISAMPLES,
    });

    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    // Threshold just above white, so only the Sun, lit atmosphere limbs and the
    // brightest stars bloom.
    this.bloom = new Bloom(size.clone(), 0.5, 0.45, 0.9);
    this.composer.addPass(this.bloom);

    this.finish = new FinishPass(this.bloom);
    // This pass draws to the screen, so nothing needs swapping in. With the
    // default swap the scene would alternate between the composer's two
    // targets, keeping two multisampled HDR buffers allocated where one does.
    this.finish.needsSwap = false;
    this.composer.addPass(this.finish);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Follows the canvas. `pixelRatio` is the renderer's, render scale included;
   * `multisample` is whether the scene target is to be multisampled.
   */
  setSize(width, height, pixelRatio, multisample = true) {
    const samples = multisample ? MULTISAMPLES : 0;
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (target.samples === samples) continue;
      target.samples = samples;
      // Reallocated at the right sample count the next time it is drawn to.
      target.dispose();
    }
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(deltaSeconds) {
    // The composer cannot target a headset's own framebuffer, so VR renders
    // directly, tone mapped per material as with effects off.
    if (this.enabled && !this.renderer.xr.isPresenting) this.composer.render(deltaSeconds);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.composer.dispose();
    this.bloom.dispose();
    this.finish.dispose();
  }
}

/**
 * three's bloom without the final blend: the glow is left in
 * {@link Bloom#texture} for FinishPass to add. Otherwise mirrors
 * UnrealBloomPass.render in the vendored three.js - keep the two in step when
 * three is upgraded.
 */
class Bloom extends UnrealBloomPass {
  /** The finished glow, at half resolution. */
  get texture() {
    return this.renderTargetsHorizontal[0].texture;
  }

  render(renderer, writeBuffer, readBuffer) {
    renderer.getClearColor(this._oldClearColor);
    this._oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);

    // 1. Extract the bright areas.
    this.highPassUniforms.tDiffuse.value = readBuffer.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    this._fsQuad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this._fsQuad.render(renderer);

    // 2. Blur each mip, horizontally then vertically.
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const material = this.separableBlurMaterials[i];
      this._fsQuad.material = material;

      material.uniforms.colorTexture.value = input.texture;
      material.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this._fsQuad.render(renderer);

      material.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      material.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this._fsQuad.render(renderer);

      input = this.renderTargetsVertical[i];
    }

    // 3. Composite the mips into one glow. No blend back: FinishPass adds it.
    this._fsQuad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this._fsQuad.render(renderer);

    renderer.setClearColor(this._oldClearColor, this._oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

/** Tone mapping and colour-space conversion as in three's OutputPass, plus bloom, vignette and dither. */
class FinishPass extends Pass {
  /** @param {Bloom} bloom Whose glow to add; see the note at the top of this file. */
  constructor(bloom) {
    super();
    this.bloom = bloom;
    this.uniforms = {
      tDiffuse: { value: null },
      tBloom: { value: null },
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
        uniform sampler2D tBloom;
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
          color.rgb += texture2D( tBloom, vUv ).rgb;

          #if defined( ACES_FILMIC_TONE_MAPPING )
            color.rgb = ACESFilmicToneMapping( color.rgb );
          #elif defined( AGX_TONE_MAPPING )
            color.rgb = AgXToneMapping( color.rgb );
          #elif defined( NEUTRAL_TONE_MAPPING )
            color.rgb = NeutralToneMapping( color.rgb );
          #elif defined( LINEAR_TONE_MAPPING )
            color.rgb = LinearToneMapping( color.rgb );
          #endif

          // A barely noticeable vignette.
          vec2 centred = ( vUv - 0.5 ) * vec2( uResolution.x / uResolution.y, 1.0 );
          color.rgb *= 1.0 - 0.22 * smoothstep( 0.45, 1.15, length( centred ) );

          color = sRGBTransferOETF( color );

          // Triangular dither of about one 8-bit step, against banding in the
          // glows and the Milky Way.
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
    this.uniforms.tBloom.value = this.bloom.texture;
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
