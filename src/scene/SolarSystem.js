/**
 * Builds and drives the scene graph from the catalogue.
 *
 * Every body follows the same three-node structure:
 *
 *   group  - positioned in world space each frame, never rotated
 *    └ tilt - axial tilt, set once so the pole keeps pointing the same way
 *       └ mesh - spins on its own Y axis
 *
 * Moons are not parented to their planet: a moon's world position is its
 * primary's position plus its own orbital offset, so nothing inherits anyone's
 * spin.
 */

import * as THREE from 'three';
import { periodDays } from '../data/bodies.js';
import { SOLAR_SYSTEM } from '../data/systems.js';
import { exoplanetSurface, stellarSurface, starDisplayColor } from './exoplanetSurface.js';
import { WorldPainter, paintRings } from './worldTextures.js';
import {
  bodyRadius, heliocentricDistance, satelliteDistance, ringRadius,
  SCALE_EXPONENT_RANGE,
} from './scaling.js';
import { orbitalPosition, spinAngle, rotationAngle } from '../sim/kepler.js';
import { stellarPositions } from '../sim/stellar.js';
import { equatorialToScene } from '../sim/frames.js';
import { receiveRingShadow, receivePlanetShadow, updateSunDirection } from './ringShadow.js';
import { nightSideEmissive, softTerminator, sunSurface } from './shading.js';
import { createAtmosphere } from './atmosphere.js';

const DEG = Math.PI / 180;
const _vec = new THREE.Vector3();
const _raw = { x: 0, y: 0, z: 0 };
const _inverseTilt = new THREE.Quaternion();

/** Point-light intensity of a star, set for visibility rather than photometry. */
const STAR_LIGHT = 3.2;
const SOLAR_RADIUS_KM = 695_700;

/** Corona sprite size, in solar radii. */
const CORONA_RADII = 6;

/** Scales the catalogue's bump scales down; at full strength crater rims cast hard black edges. */
const BUMP_SOFTENING = 0.65;

/** Sphere tessellation by on-screen size. */
function sphereSegments(radiusUnits) {
  if (radiusUnits >= 120) return [128, 64];
  if (radiusUnits >= 50) return [96, 48];
  if (radiusUnits >= 24) return [72, 36];
  if (radiusUnits >= 10) return [48, 24];
  return [32, 16];
}

export class SolarSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/AssetLoader.js').AssetLoader} assets
   */
  constructor(scene, assets, catalogue = SOLAR_SYSTEM) {
    this.catalogue = catalogue;
    this.scene = scene;
    this.assets = assets;

    /** @type {Map<string, BodyView>} */
    this.bodies = new Map();
    /** Meshes the raycaster is allowed to hit. */
    this.pickables = [];
    this._disposables = [];

    /** The Scale setting; see src/scene/scaling.js. Set before build(). */
    this.scaleExponent = SCALE_EXPONENT_RANGE.default;

    this.root = new THREE.Group();
    this.root.name = 'solar-system';
    scene.add(this.root);

    this.sunLight = null;
    this.stellarPositions = new Map();
    this.starLights = new Map();
    /** Bodies with analytic ring shadows that need a per-frame Sun direction. */
    this._shadowCasters = [];
    this._sunWorld = new THREE.Vector3();
  }

  /**
   * Creates every mesh. Textures may still be streaming; each material starts
   * with 1x1 placeholders in the slots it will eventually use, so the shader
   * compiles once and arriving textures are pure uploads.
   */
  async build({ onPaint } = {}) {
    this._buildLighting();
    if (this.catalogue.isExoplanet) await this._paintWorlds(onPaint);

    // Parents before children, so a moon can read its primary's scaled radius.
    const ordered = [...this.catalogue.bodies].sort((a, b) => depth(a, this.catalogue.byId) - depth(b, this.catalogue.byId));
    for (const body of ordered) this._buildBody(body);

    for (const view of this.bodies.values()) {
      const primary = (this.catalogue.isExoplanet ? this.bodies.get(view.body.parent) : null) ?? this.bodies.get(this.catalogue.starId);
      view.lightPosition = primary?.group.position;
    }

    for (const view of this.bodies.values()) if (view.kind === 'star') this._buildCorona(view);
  }

  /**
   * Another star's worlds have no image textures: each is painted once, on the
   * GPU, from its description in src/data/worlds.js (see worldTextures.js).
   */
  async _paintWorlds(onPaint) {
    this.painter = new WorldPainter(this.assets.renderer);
    this._maps = new Map();
    const bodies = this.catalogue.bodies.filter((b) => b.look);
    for (const [i, body] of bodies.entries()) {
      onPaint?.(i / bodies.length, body.name);
      const { look } = body;
      if (body.kind !== 'star') this._maps.set(body.id, await this.painter.paintPlanet(look));
      else if (look.banded) this._maps.set(body.id, await this.painter.paintPlanet(look.banded));
      else if (look.granules) this._maps.set(body.id, await this.painter.paintStar(look));
    }
  }

  _buildLighting() {
    const { catalogue } = this;
    // decay: 0 because real inverse-square falloff over a compressed solar
    // system leaves Neptune in total darkness.
    this.sunLight = new THREE.PointLight(0xfff4e0, STAR_LIGHT, 0, 0);
    if (catalogue.isExoplanet) this.sunLight.color.copy(adaptedLight(catalogue.byId.get(catalogue.starId).color));
    this.sunLight.name = 'sunlight';
    // Shadows are for moons crossing planets and rings; an exoplanet system has
    // neither, and a point light's shadow is six extra renders of the scene.
    this.sunLight.castShadow = !catalogue.isExoplanet;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.bias = -0.0008;
    this.sunLight.shadow.normalBias = 1;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 40_000;
    this.root.add(this.sunLight);
    this.starLights.set(catalogue.starId, this.sunLight);

    // A companion gets a light only if some planet orbits it, or orbits a pair
    // it is part of: every light is a cost in every lit material.
    this._starlight = new Map();
    const nodes = new Map((catalogue.stellarNodes ?? []).map((n) => [n.id, n]));
    const planets = catalogue.bodies.filter((b) => b.kind === 'planet' && b.orbit);
    for (const star of catalogue.bodies.filter((b) => b.kind === 'star')) {
      const path = [];
      for (let node = nodes.get(star.id); node?.parent; node = nodes.get(node.parent)) path.push(node);
      const pairs = new Set(path.map((node) => node.parent));
      const lit = planets.filter((p) => p.parent === star.id || pairs.has(p.parent));
      this._starlight.set(star.id, { star, path, lit });
      if (star.id === catalogue.starId || !lit.length) continue;
      const light = new THREE.PointLight(adaptedLight(star.color), STAR_LIGHT, 0, 0);
      this.root.add(light);
      this.starLights.set(star.id, light);
    }
    this._fitStarlight();

    // Just enough fill that the night side is a silhouette rather than a hole.
    this.ambient = new THREE.AmbientLight(0x6c7894, 0.1);
    this.root.add(this.ambient);
  }

  /**
   * With more than one star, each light fades out just past the farthest planet
   * it lights. Without falloff (decay 0, above), a companion hundreds of AU off
   * would otherwise light a planet as brightly as the star it circles. Where
   * two stars share planets they share the light by luminosity. Distances
   * follow the Scale setting, so this runs again when it changes.
   */
  _fitStarlight() {
    if (this.starLights.size < 2) return;
    const exponent = this.scaleExponent;
    const luminosity = (star) => (star.radiusKm / SOLAR_RADIUS_KM) ** 2 * ((star.temperature ?? 5772) / 5772) ** 4;
    const lighters = new Map();
    for (const [id, { lit }] of this._starlight) {
      if (!this.starLights.has(id)) continue;
      for (const planet of lit) lighters.set(planet.id, [...(lighters.get(planet.id) ?? []), id]);
    }
    for (const [id, light] of this.starLights) {
      const { star, path, lit } = this._starlight.get(id);
      // The host always has a light; with nothing of its own to light, it goes dark.
      if (!lit.length) { light.intensity = 0; continue; }
      // How far this star can stray from each pair it belongs to.
      const offsets = new Map([[id, 0]]);
      let offset = 0;
      for (const node of path) {
        if (node.orbit) offset += heliocentricDistance(node.orbit.aAU * (1 + node.orbit.e), exponent) * Math.abs(node.fraction);
        offsets.set(node.parent, offset);
      }
      const reach = Math.max(...lit.map((p) => offsets.get(p.parent) + heliocentricDistance(p.orbit.aAU * (1 + p.orbit.e), exponent)));
      // At half the cutoff, three.js's window still passes 88% of the light.
      light.distance = reach * 2;
      const brightest = Math.max(...lit.flatMap((p) => lighters.get(p.id).map((other) => luminosity(this._starlight.get(other).star))));
      light.intensity = STAR_LIGHT * THREE.MathUtils.clamp(luminosity(star) / brightest, 0.15, 1);
    }
  }

  _buildBody(body) {
    const radius = bodyRadius(body, this.scaleExponent);
    const view = new BodyView(body, radius);

    view.group.name = body.id;
    this.root.add(view.group);

    if (body.model) {
      this._attachModel(view, body);
    } else {
      this._attachSphere(view, body, radius);
    }

    if (body.rings) this._attachRings(view, body, radius);
    if (body.clouds) this._attachShell(view, body.clouds, radius, 'clouds');
    if (body.atmosphere) this._attachShell(view, body.atmosphere, radius, 'atmosphere');
    if (body.look?.clouds) this._attachExoClouds(view, body.look, radius);
    if (body.glow) {
      const air = createAtmosphere(radius, body.glow);
      // Scattered starlight takes the star's colour.
      if (body.look) air.material.uniforms.uColor.value.multiply((this.starLights.get(body.parent) ?? this.sunLight).color);
      air.userData.bodyId = body.id;
      view.tilt.add(air);
      view.air = air;
      this._disposables.push(air.geometry, air.material);
    }

    orientBody(view.tilt.quaternion, body, this.catalogue);
    view.elements = this._scaleElements(body, view);

    this.bodies.set(body.id, view);
    return view;
  }

  _attachSphere(view, body, radius) {
    const [widthSeg, heightSeg] = sphereSegments(radius);
    const geometry = new THREE.SphereGeometry(radius, widthSeg, heightSeg);
    this._disposables.push(geometry);

    const isStar = body.kind === 'star';
    // Rock and cloud are near-matte; a broad Phong highlight looks like plastic.
    // Only a body with a specular map (oceans, Pluto's ice) gets a tight glint.
    const material = isStar
      ? new THREE.MeshBasicMaterial({ color: 0xffffff })
      : new THREE.MeshPhongMaterial({
          color: 0xffffff,
          shininess: body.textures?.specularMap ? 32 : 1,
          specular: body.textures?.specularMap ? 0x2a2a2a : 0x000000,
        });

    this._claimSlots(material, body, isStar, radius);
    const maps = this._maps?.get(body.id);
    if (isStar && body.look) {
      const surface = stellarSurface(material, body.look, maps?.data ?? null, body.look.banded ? maps : null);
      // Granules come and go on a clock of their own, not the simulation's.
      view.onFrame = () => { surface.uniforms.uTime.value = performance.now() / 1000; };
    } else if (isStar) {
      sunSurface(material, 1.4);
    } else if (body.look) {
      exoplanetSurface(material, body.look, maps, radius);
    }
    if (body.nightLights) nightSideEmissive(material);
    if (body.terminator) softTerminator(material, body.terminator);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${body.id}-mesh`;
    mesh.castShadow = !isStar;
    mesh.receiveShadow = !isStar;
    mesh.userData.bodyId = body.id;
    mesh.raycast = raycastSphere;

    view.tilt.add(mesh);
    view.mesh = mesh;
    view.spinNode = mesh;
    view.material = material;
    this._disposables.push(material);
    this.pickables.push(mesh);

    this._streamTextures(material, body);
  }

  /**
   * Points every declared map slot at a placeholder of the right colour space,
   * so the program compiled now is the one used once real textures arrive.
   */
  _claimSlots(material, body, isStar, radius) {
    const slots = body.textures ?? {};
    material.map = this.assets.placeholderFor('map');
    material.color.set(body.color ?? '#ffffff');

    if (isStar) return;
    if (slots.bumpMap) {
      material.bumpMap = this.assets.placeholderFor('bumpMap');
      material.bumpScale = (body.bumpScale ?? 0.01) * radius * BUMP_SOFTENING;
    }
    if (slots.specularMap) material.specularMap = this.assets.placeholderFor('specularMap');
    if (slots.emissiveMap) {
      material.emissiveMap = this.assets.placeholderFor('emissiveMap');
      material.emissive = new THREE.Color(0xffffff);
      material.emissiveIntensity = 0.85;
    }
  }

  _streamTextures(material, body) {
    const priority = body.kind === 'star' || body.kind === 'planet' ? 0 : 20;
    for (const [slot, name] of Object.entries(body.textures ?? {})) {
      this.assets.texture(name, slot, priority).then((texture) => {
        material[slot] = texture;
        // The catalogue colour only stands in until the map arrives.
        if (slot === 'map') material.color.set(0xffffff);
      });
    }
  }

  async _attachModel(view, body) {
    // Irregular moons ship as glTF; until it arrives a same-sized placeholder
    // keeps the body selectable.
    const radius = view.baseRadius;
    const placeholderGeo = new THREE.IcosahedronGeometry(radius, 2);
    const placeholderMat = new THREE.MeshPhongMaterial({ color: body.color ?? 0x999999, flatShading: true });
    const placeholder = new THREE.Mesh(placeholderGeo, placeholderMat);
    placeholder.userData.bodyId = body.id;
    placeholder.castShadow = placeholder.receiveShadow = true;
    view.tilt.add(placeholder);
    view.mesh = view.spinNode = placeholder;
    this._disposables.push(placeholderGeo, placeholderMat);
    this.pickables.push(placeholder);

    try {
      const source = await this.assets.model(body.model);
      const model = source.clone(true);
      fitToRadius(model, radius);
      model.traverse((child) => {
        if (child.isMesh) child.userData.bodyId = body.id;
      });

      view.tilt.remove(placeholder);
      this.pickables.splice(this.pickables.indexOf(placeholder), 1);
      model.rotation.y = placeholder.rotation.y;
      view.tilt.add(model);
      view.mesh = view.spinNode = model;
      model.traverse((child) => { if (child.isMesh) this.pickables.push(child); });
    } catch (err) {
      console.warn(`[scene] model "${body.model}" failed; keeping placeholder`, err);
    }
  }

  _attachRings(view, body, radius) {
    const clear = this.assets.placeholders.clear;
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.assets.placeholderFor('map'),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: body.rings.opacity ?? 1,
      depthWrite: false,
    });

    const rings = new THREE.Mesh(undefined, material);
    rings.rotation.x = Math.PI / 2;
    rings.receiveShadow = true;
    rings.castShadow = true;
    rings.userData.bodyId = body.id;
    rings.renderOrder = 1;

    view.tilt.add(rings);
    view.rings = rings;
    this._disposables.push(material);
    this.pickables.push(rings);

    // Analytic shadows both ways; see ringShadow.js for why not a shadow map.
    const onPlanet = receiveRingShadow(view.material, { innerRadius: 0, outerRadius: 0 });
    onPlanet.uniforms.uRingMap.value = clear;
    const onRings = receivePlanetShadow(material, { planetRadius: radius });
    view.ringShadow = onPlanet;
    this._shadowCasters.push({ view, onPlanet, onRings });
    this._shapeRings(view);

    // Another star's giant has rings painted from a profile (worldTextures.js),
    // in its own star's light: ring particles are unlit here.
    let texture;
    if (body.rings.palette) {
      const painted = paintRings(body.rings, body.look?.seed);
      this._disposables.push(painted);
      material.color.copy((this.starLights.get(body.parent) ?? this.sunLight).color);
      texture = Promise.resolve(painted);
    } else {
      texture = this.assets.texture(body.rings.map, 'map', 0);
    }
    texture.then((texture) => {
      material.map = texture;
      onPlanet.uniforms.uRingMap.value = texture;
    });
  }

  /**
   * (Re)builds the ring geometry for the current Scale. The ring-to-planet ratio
   * is itself compressed by the exponent, so it can't just follow the tilt
   * node's scale. Radii are in the tilt node's local space (build-time radius).
   */
  _shapeRings(view) {
    const { innerRadii, outerRadii } = view.body.rings;
    const inner = ringRadius(innerRadii, view.baseRadius, this.scaleExponent);
    const outer = ringRadius(outerRadii, view.baseRadius, this.scaleExponent);

    view.rings.geometry.dispose();
    view.rings.geometry = createRadialRingGeometry(inner, outer, 256);
    view.ringOuter = outer;
    view.ringShadow.uniforms.uRingInner.value = inner;
    view.ringShadow.uniforms.uRingOuter.value = outer;
  }

  /**
   * Applies a new Scale exponent in place by scaling each tilt node rather than
   * rebuilding meshes. Positions follow on the next update().
   */
  setScaleExponent(exponent) {
    this.scaleExponent = exponent;
    for (const view of this.bodies.values()) {
      view.radius = bodyRadius(view.body, exponent);
      view.tilt.scale.setScalar(view.radius / view.baseRadius);
      if (view.rings) this._shapeRings(view);
    }
    for (const view of this.bodies.values()) view.corona?.scale.setScalar(view.radius * CORONA_RADII);
    this._fitStarlight();
  }

  /**
   * Another world's clouds: the cloud cover baked into its data map's green
   * channel, which is what an alphaMap reads. They turn with the planet and
   * drift slowly on top, like Earth's.
   */
  _attachExoClouds(view, look, radius) {
    const maps = this._maps?.get(view.id);
    if (!maps) return;
    const [w, h] = sphereSegments(radius);
    const geometry = new THREE.SphereGeometry(radius * 1.008, w, h);
    const material = new THREE.MeshPhongMaterial({
      color: look.clouds.color, alphaMap: maps.data, transparent: true, opacity: 0.92, depthWrite: false, shininess: 0,
    });
    if (look.terminator) softTerminator(material, look.terminator);
    const shell = new THREE.Mesh(geometry, material);
    shell.name = `${view.id}-clouds`;
    shell.renderOrder = 2;
    shell.userData.bodyId = view.id;
    shell.raycast = raycastSphere;
    view.tilt.add(shell);
    view.shells.push({ mesh: shell, spinPeriodHours: 2400, corotating: true });
    this._disposables.push(geometry, material);
    this.pickables.push(shell);
  }

  /** Cloud deck or atmospheric haze: a thin transparent shell just above the surface. */
  _attachShell(view, spec, radius, kind) {
    const [w, h] = sphereSegments(radius);
    const geometry = new THREE.SphereGeometry(radius * spec.scale, w, h);
    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: spec.opacity ?? 0.8,
      depthWrite: false,
      shininess: 0,
    });

    if (spec.alphaMap) {
      material.alphaMap = this.assets.placeholderFor('alphaMap');
      this.assets.texture(spec.alphaMap, 'alphaMap', 5).then((t) => { material.alphaMap = t; });
    }
    if (spec.map) {
      material.map = this.assets.placeholderFor('map');
      this.assets.texture(spec.map, 'map', 5).then((t) => { material.map = t; });
    }

    const shell = new THREE.Mesh(geometry, material);
    shell.name = `${view.id}-${kind}`;
    shell.castShadow = false;
    shell.receiveShadow = true;
    shell.renderOrder = 2;
    shell.userData.bodyId = view.id;
    shell.raycast = raycastSphere;

    view.tilt.add(shell);
    view.shells.push({
      mesh: shell,
      spinPeriodHours: spec.spinPeriodHours ?? 0,
      // Corotating shells add their own slow drift on top of the surface's
      // spin, rather than sliding across the continents on a separate period.
      corotating: Boolean(spec.corotating),
    });
    this._disposables.push(geometry, material);
    this.pickables.push(shell);
  }

  /**
   * The Sun's glow, in two layers: a corona a few solar radii across that
   * scales with the Sun, and a fixed-screen-size glare so it still stands out
   * from Neptune. Both are depth tested, so planets in front cut silhouettes.
   */
  _buildCorona(sun) {
    if (!sun) return;

    const coronaTexture = makeGlowTexture(256, [
      [0.0, 1.0], [0.1, 0.62], [0.2, 0.3], [0.35, 0.11], [0.55, 0.035], [0.8, 0.008], [1.0, 0],
    ]);
    // Another star's glow takes its own colour, scaled as the Sun's is.
    const look = sun.body.look;
    const tint = look ? starDisplayColor(look.teff) : null;
    if (tint) tint.multiplyScalar(1 / Math.max(tint.r, tint.g, tint.b));
    const coronaMaterial = new THREE.SpriteMaterial({
      map: coronaTexture,
      color: (tint?.clone() ?? new THREE.Color(1.0, 0.7, 0.42)).multiplyScalar(0.55 * (look?.type === 'brownDwarf' ? 0.25 : 1)),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const corona = new THREE.Sprite(coronaMaterial);
    corona.scale.setScalar(sun.radius * CORONA_RADII);
    corona.renderOrder = -1;
    // A sprite's size is in view units, not world units. In a headset the view
    // is scaled down to metres, so size it against the camera's own scale.
    corona.onBeforeRender = (renderer, scene, camera) => {
      const viewScale = _vec.setFromMatrixColumn(camera.matrixWorldInverse, 0).length();
      corona.scale.setScalar(sun.radius * CORONA_RADII * viewScale);
      corona.updateMatrixWorld();
    };
    sun.group.add(corona);
    sun.corona = corona;

    const glareTexture = makeGlowTexture(128, [
      [0.0, 1.0], [0.04, 0.55], [0.12, 0.16], [0.3, 0.04], [0.6, 0.008], [1.0, 0],
    ]);
    const glareMaterial = new THREE.SpriteMaterial({
      map: glareTexture,
      color: (tint ? tint.clone().lerp(WHITE, 0.35) : new THREE.Color(1.0, 0.84, 0.64)).multiplyScalar(0.5 * (look?.type === 'brownDwarf' ? 0.3 : 1)),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const glare = new THREE.Sprite(glareMaterial);
    glare.scale.setScalar(0.18);
    glare.renderOrder = -1;
    sun.group.add(glare);
    if (look?.type === 'neutron') this._buildBeams(sun, tint);

    this._disposables.push(coronaMaterial, coronaTexture, glareMaterial, glareTexture);
  }

  /**
   * A pulsar's two beams: faint cones along a magnetic axis tilted from its
   * spin axis, sweeping round. Illustrative, and said so in the info panel:
   * the real beams are radio waves and turn many times a second.
   */
  _buildBeams(star, tint) {
    const length = star.baseRadius * 60;
    const geometry = new THREE.ConeGeometry(length * 0.09, length, 48, 1, true);
    geometry.translate(0, -length / 2, 0);
    const material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: tint.clone().lerp(WHITE, 0.4).multiplyScalar(0.9) }, uLength: { value: length } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform float uLength;
        varying float vAlong;
        varying float vFacing;
        void main() {
          vAlong = -position.y / uLength;
          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          vFacing = abs( dot( normalize( normalMatrix * normal ), normalize( -mvPosition.xyz ) ) );
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        varying float vAlong;
        varying float vFacing;
        void main() {
          #include <logdepthbuf_fragment>
          float fade = pow( 1.0 - vAlong, 2.2 ) * smoothstep( 0.0, 0.04, vAlong );
          gl_FragColor = vec4( uColor * fade * pow( vFacing, 1.5 ) * 0.6, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const spin = new THREE.Group();
    const axis = new THREE.Group();
    axis.rotation.z = 35 * DEG;
    for (const flip of [0, Math.PI]) {
      const beam = new THREE.Mesh(geometry, material);
      beam.rotation.x = flip;
      beam.renderOrder = -1;
      axis.add(beam);
    }
    spin.add(axis);
    // In the tilt node, so the beams scale with the star.
    star.tilt.add(spin);
    const surface = star.onFrame;
    star.onFrame = () => {
      surface?.();
      spin.rotation.y = (performance.now() / 3000) * Math.PI * 2;
    };
    this._disposables.push(geometry, material);
  }

  /**
   * `a` stays in its natural unit (AU for planets, km for moons); compression
   * is applied per frame to the instantaneous radius (see scaling.js).
   */
  _scaleElements(body, view) {
    if (!body.orbit) return null;
    const parent = body.parent ? this.catalogue.byId.get(body.parent) : null;
    return {
      a: body.orbit.aAU ?? body.orbit.aKm,
      e: body.orbit.e,
      inc: body.orbit.inc,
      meanLong: body.orbit.meanLong,
      periLong: body.orbit.periLong,
      nodeLong: body.orbit.nodeLong,
      periodDays: periodDays(body),
      heliocentric: this.catalogue.isExoplanet || body.parent === this.catalogue.starId,
      fraction: body.orbit.fraction ?? 1,
      // Measured from the primary's equator, so the orbit tilts with it.
      equatorial: !this.catalogue.isExoplanet && body.parent !== this.catalogue.starId && body.orbit.plane !== 'ecliptic',
      parentId: body.parent,
      parentBody: parent,
    };
  }

  /** Scene-space position for a body at `tDays`, written into `target`. */
  positionAt(view, tDays, target) {
    const el = view.elements;
    if (!el) return target.set(0, 0, 0);

    orbitalPosition(el, tDays, _raw);
    const distance = Math.hypot(_raw.x, _raw.y, _raw.z) || 1e-9;

    if (el.heliocentric) {
      const scaled = heliocentricDistance(distance, this.scaleExponent);
      target.set(_raw.x, _raw.y, _raw.z).multiplyScalar(scaled / distance * el.fraction);
      if (this.catalogue.isExoplanet) {
        const parent = this.stellarPositions.get(el.parentId);
        if (parent) { target.x += parent.x; target.y += parent.y; target.z += parent.z; }
      }
    } else {
      const parentView = this.bodies.get(el.parentId);
      const scaled = satelliteDistance(distance, this.scaleExponent);
      target.set(_raw.x, _raw.y, _raw.z).multiplyScalar(scaled / distance);
      if (el.equatorial) target.applyQuaternion(parentView.tilt.quaternion);
      target.add(parentView.group.position);
    }
    return target;
  }

  update(tDays) {
    if (this.catalogue.stellarNodes?.length) {
      stellarPositions(this.catalogue.stellarNodes, tDays, (au) => heliocentricDistance(au, this.scaleExponent), this.stellarPositions);
    }
    for (const view of this.bodies.values()) {
      if (!view.visible) continue;

      if (view.elements) this.positionAt(view, tDays, view.group.position);

      const spin = view.body.spin;
      if (view.body.tidallyLocked && view.spinNode) {
        this._faceParent(view);
      } else if (spin?.periodHours && view.spinNode) {
        view.spinNode.rotation.y = rotationAngle(spin, tDays);
      }

      for (const shell of view.shells) {
        if (!shell.spinPeriodHours) continue;
        const own = spinAngle(shell.spinPeriodHours, tDays);
        shell.mesh.rotation.y = shell.corotating ? view.spinNode.rotation.y + own : own;
      }
    }

    for (const [id, light] of this.starLights) light.position.copy(this.bodies.get(id).group.position);

    if (this.catalogue.isExoplanet) {
      for (const view of this.bodies.values()) {
        view.onFrame?.();
        // The Sun sits at the origin; other stars' planets are lit from wherever theirs is.
        if (view.air && view.lightPosition) view.air.material.uniforms.uStarPosition.value.copy(view.lightPosition);
      }
    }

    this._updateRingShadows();
  }

  /**
   * Turns a tidally locked moon so its prime meridian faces its primary (a free
   * spin would match the rate but not the phase). Relies on parents updating
   * first: the map is built in depth order.
   */
  _faceParent(view) {
    const parent = this.bodies.get(view.body.parent);
    if (!parent) return;

    _vec.copy(parent.group.position).sub(view.group.position);
    _vec.applyQuaternion(_inverseTilt.copy(view.tilt.quaternion).invert());
    // SphereGeometry puts the middle of an equirectangular map - longitude 0 -
    // on local +X, and a Y rotation of `a` carries +X to (cos a, 0, -sin a).
    view.spinNode.rotation.y = Math.atan2(-_vec.z, _vec.x);
  }

  /**
   * Re-aims the analytic ring shadows. Forces a matrix update because the Sun's
   * direction in the spinning planet's object space is needed before render.
   */
  _updateRingShadows() {
    if (this._shadowCasters.length === 0) return;

    const sun = this.bodies.get(this.catalogue.starId);
    sun?.group.updateMatrixWorld(true);
    this._sunWorld.setFromMatrixPosition(sun ? sun.group.matrixWorld : this.root.matrixWorld);

    for (const caster of this._shadowCasters) {
      caster.view.group.updateMatrixWorld(true);
      const star = this.catalogue.isExoplanet ? caster.view.lightPosition ?? this._sunWorld : this._sunWorld;
      updateSunDirection(caster.onPlanet, caster.view.mesh, star);
      updateSunDirection(caster.onRings, caster.view.rings, star);
    }
  }

  setCategoryVisible(kind, visible) {
    for (const view of this.bodies.values()) {
      if (view.body.kind !== kind) continue;
      view.visible = visible;
      view.group.visible = visible;
    }
  }

  isVisible(id) {
    const view = this.bodies.get(id);
    return Boolean(view?.visible);
  }

  /**
   * Brackets the shadow camera's near/far around the focused body; one cube map
   * can't span the Sun to Eris with enough precision for moon-on-planet shadows.
   */
  focusShadows(view) {
    if (!this.sunLight?.castShadow || !view) return;

    const distance = view.group.position.distanceTo(this.sunLight.position);
    const margin = Math.max(view.radius * 30, 600);
    const shadow = this.sunLight.shadow;
    shadow.camera.near = Math.max(1, distance - margin);
    shadow.camera.far = distance + margin;
    shadow.camera.updateProjectionMatrix();

    // A cube face spans 2 x distance at 90 degrees. The normal offset must clear
    // a texel or the lit face shadows itself, but is capped so it can't detach
    // a small body's shadow entirely.
    const texel = (2 * distance) / shadow.mapSize.width;
    shadow.normalBias = Math.min(texel * 1.5, view.radius * 0.25);
  }

  setShadowQuality(size) {
    if (!this.sunLight) return;
    this.sunLight.castShadow = size > 0 && !this.catalogue.isExoplanet;
    if (size > 0) {
      this.sunLight.shadow.mapSize.set(size, size);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
  }

  dispose() {
    this.painter?.dispose();
    for (const item of this._disposables) item.dispose?.();
    for (const view of this.bodies.values()) view.rings?.geometry.dispose();
    this._disposables.length = 0;
    this.root.removeFromParent();
    this.bodies.clear();
    this.pickables.length = 0;
  }
}

class BodyView {
  constructor(body, radius) {
    this.body = body;
    this.id = body.id;
    this.name = body.name;
    this.kind = body.kind;
    /** Current on-screen radius. Follows the Scale setting. */
    this.radius = radius;
    /** Radius the meshes were built at; the tilt node scales them to `radius`. */
    this.baseRadius = radius;
    this.visible = true;

    this.group = new THREE.Group();
    this.tilt = new THREE.Group();
    this.group.add(this.tilt);

    this.mesh = null;
    this.spinNode = null;
    this.material = null;
    this.rings = null;
    this.ringOuter = 0;
    this.ringShadow = null;
    this.shells = [];
    this.elements = null;
  }

  /** Outermost extent including rings, for camera framing. */
  get boundingRadius() {
    return Math.max(this.radius, this.ringOuter * this.tilt.scale.x);
  }
}

function depth(body, byId) {
  let d = 0;
  let current = body;
  while (current?.parent) {
    d++;
    current = byId.get(current.parent);
  }
  return d;
}

/**
 * A ring whose U coordinate runs radially, so ring textures can be a 1px-high
 * strip; three's RingGeometry projects a square UV across the bounding box.
 */
function createRadialRingGeometry(inner, outer, segments) {
  const positions = [];
  const uvs = [];
  const normals = [];
  const indices = [];

  for (let s = 0; s <= segments; s++) {
    const theta = (s / segments) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (const [radius, u] of [[inner, 0], [outer, 1]]) {
      positions.push(cos * radius, sin * radius, 0);
      normals.push(0, 0, 1);
      uvs.push(u, 0.5);
    }
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Points a body's tilt node so that local +Y is its north pole and local +X is
 * where its equator crosses Earth's - the IAU's reference for the prime
 * meridian, so that spinning local +X by the meridian angle W lands longitude 0
 * where it really is. Moons with no pole of their own share their planet's; a
 * body with no measured pole at all is simply tilted by its obliquity.
 */
const _pole = new THREE.Vector3();
const _node = new THREE.Vector3();
const _third = new THREE.Vector3();
const _basis = new THREE.Matrix4();
function orientBody(target, body, catalogue) {
  let pole = body.spin?.pole;
  for (let parent = catalogue.byId.get(body.parent); !pole && parent; parent = catalogue.byId.get(parent.parent)) {
    if (parent.id !== catalogue.starId) pole = parent.spin?.pole;
  }

  if (!pole) {
    return target.setFromAxisAngle(_third.set(0, 0, 1), (body.spin?.tiltDeg ?? 0) * DEG);
  }

  const p = equatorialToScene(pole.ra, pole.dec);
  const n = equatorialToScene(pole.ra + 90, 0);
  _pole.set(p.x, p.y, p.z);
  _node.set(n.x, n.y, n.z);
  _third.crossVectors(_node, _pole);
  return target.setFromRotationMatrix(_basis.makeBasis(_node, _pole, _third));
}

const WHITE = new THREE.Color(1, 1, 1);

/**
 * Another star's light, about halfway to white. Eyes adapt to the light they
 * are in, as they do to a warm room, so under a red dwarf ice still looks
 * white-ish rather than the orange a daylight-balanced camera would record;
 * enough of the star's colour is kept that its planets are visibly lit by it.
 */
function adaptedLight(color) {
  return new THREE.Color(color).lerp(WHITE, 0.5);
}

/** Stops are [radius, intensity] pairs, both 0..1, painted white for the material to tint. */
function makeGlowTexture(size, stops) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, value] of stops) gradient.addColorStop(at, `rgba(255,255,255,${value})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Assign as a sphere mesh's `raycast`: picks against the true sphere instead
 * of testing every triangle (16,000 for the Sun) on each mouse move.
 */
const _sphere = new THREE.Sphere();
const _hit = new THREE.Vector3();
function raycastSphere(raycaster, intersects) {
  const { ray } = raycaster;
  _sphere.center.setFromMatrixPosition(this.matrixWorld);
  _sphere.radius = this.geometry.parameters.radius * this.matrixWorld.getMaxScaleOnAxis();
  // Only front faces are drawn, so from inside there is nothing to hit.
  if (_sphere.containsPoint(ray.origin) || !ray.intersectSphere(_sphere, _hit)) return;

  const distance = ray.origin.distanceTo(_hit);
  if (distance < raycaster.near || distance > raycaster.far) return;
  intersects.push({ distance, point: _hit.clone(), object: this });
}

/** Uniformly scales a loaded model so its longest half-extent equals `radius`. */
function fitToRadius(object, radius) {
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) / 2 || 1;
  object.scale.setScalar(radius / longest);

  // Re-centre so it spins about itself.
  const centre = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  object.position.sub(centre);
}
