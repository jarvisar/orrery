/**
 * Builds and drives the scene graph from the catalogue.
 *
 * Every body follows the same three-node structure:
 *
 *   group  - positioned in world space each frame, never rotated
 *    └ tilt - axial tilt, set once so the pole keeps pointing the same way
 *       └ mesh - spins on its own Y axis
 *
 * Keeping the orbit out of the rotation chain is deliberate. The old version
 * parented moons to the planet mesh, so the planet's spin dragged its moons
 * around with it and the two motions could not be told apart. Here a moon's
 * world position is its primary's position plus its own orbital offset, and
 * nothing inherits anyone's rotation.
 */

import * as THREE from 'three';
import { BODIES, BODY_BY_ID, SUN_ID, periodDays } from '../data/bodies.js';
import {
  bodyRadius, heliocentricDistance, satelliteDistance, ringRadius,
  ORBIT_EXPONENT_RANGE,
} from './scaling.js';
import { orbitalPosition, spinAngle } from '../sim/kepler.js';
import { receiveRingShadow, receivePlanetShadow, updateSunDirection } from './ringShadow.js';

const DEG = Math.PI / 180;
const _vec = new THREE.Vector3();
const _raw = { x: 0, y: 0, z: 0 };

/** Sphere tessellation by on-screen size. The old code used 128x128 for everything. */
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
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;

    /** @type {Map<string, BodyView>} */
    this.bodies = new Map();
    /** Meshes the raycaster is allowed to hit. */
    this.pickables = [];
    /** Everything this class owns, for disposal. */
    this._disposables = [];

    this.orbitExponent = ORBIT_EXPONENT_RANGE.default;

    this.root = new THREE.Group();
    this.root.name = 'solar-system';
    scene.add(this.root);

    this.sunLight = null;
    /** Bodies with analytic ring shadows that need a per-frame Sun direction. */
    this._shadowCasters = [];
    this._sunWorld = new THREE.Vector3();
  }

  /**
   * Creates every mesh. Textures may still be streaming; each material starts
   * with 1x1 placeholders in the slots it will eventually use, so the shader
   * compiles once and arriving textures are pure uploads.
   */
  async build() {
    this._buildLighting();

    // Parents before children, so a moon can read its primary's scaled radius.
    const ordered = [...BODIES].sort((a, b) => depth(a) - depth(b));
    for (const body of ordered) this._buildBody(body);

    this._buildCorona();
  }

  _buildLighting() {
    // decay: 0 because the real inverse-square falloff over a compressed solar
    // system leaves Neptune in total darkness. The trade is intentional.
    this.sunLight = new THREE.PointLight(0xfff4e0, 3.2, 0, 0);
    this.sunLight.name = 'sunlight';
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.bias = -0.0008;
    this.sunLight.shadow.normalBias = 1;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 40_000;
    this.root.add(this.sunLight);

    // Just enough fill that the night side is a silhouette rather than a hole.
    this.ambient = new THREE.AmbientLight(0x2a3450, 0.55);
    this.root.add(this.ambient);
  }

  _buildBody(body) {
    const radius = bodyRadius(body);
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

    view.tilt.rotation.z = (body.spin?.tiltDeg ?? 0) * DEG;
    view.elements = this._scaleElements(body, view);

    this.bodies.set(body.id, view);
    return view;
  }

  _attachSphere(view, body, radius) {
    const [widthSeg, heightSeg] = sphereSegments(radius);
    const geometry = new THREE.SphereGeometry(radius, widthSeg, heightSeg);
    this._disposables.push(geometry);

    const isStar = body.kind === 'star';
    const material = isStar
      ? new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
      : new THREE.MeshPhongMaterial({
          color: 0xffffff,
          shininess: body.textures?.specularMap ? 18 : 4,
          specular: body.textures?.specularMap ? 0x444444 : 0x111111,
        });

    // Claim every map slot up front with a placeholder so the program that gets
    // compiled now is the same one used once the real textures arrive.
    this._claimSlots(material, body, isStar, radius);
    if (body.nightLights) applyNightSideEmissive(material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${body.id}-mesh`;
    mesh.castShadow = !isStar;
    mesh.receiveShadow = !isStar;
    mesh.userData.bodyId = body.id;

    view.tilt.add(mesh);
    view.mesh = mesh;
    view.spinNode = mesh;
    view.material = material;
    this._disposables.push(material);
    this.pickables.push(mesh);

    this._streamTextures(material, body);
  }

  /** Points every declared map slot at a placeholder of the right colour space. */
  _claimSlots(material, body, isStar, radius) {
    const slots = body.textures ?? {};
    material.map = this.assets.placeholderFor('map');
    material.color.set(body.color ?? '#ffffff');

    if (isStar) return;
    if (slots.bumpMap) {
      material.bumpMap = this.assets.placeholderFor('bumpMap');
      material.bumpScale = (body.bumpScale ?? 0.01) * radius;
    }
    if (slots.specularMap) material.specularMap = this.assets.placeholderFor('specularMap');
    if (slots.emissiveMap) {
      material.emissiveMap = this.assets.placeholderFor('emissiveMap');
      material.emissive = new THREE.Color(0xffffff);
      material.emissiveIntensity = 0.85;
    }
  }

  /** Kicks off the actual downloads and swaps each one in as it lands. */
  _streamTextures(material, body) {
    const priority = body.kind === 'star' || body.kind === 'planet' ? 0 : 20;
    for (const [slot, name] of Object.entries(body.textures ?? {})) {
      this.assets.texture(name, slot, priority).then((texture) => {
        material[slot] = texture;
        // The real map carries the detail; the catalogue colour was only ever a
        // stand-in for the seconds before it arrived.
        if (slot === 'map') material.color.set(0xffffff);
      });
    }
  }

  async _attachModel(view, body) {
    // Irregular moons ship as glTF. Until it arrives, stand in a sphere of the
    // right size so the body is still selectable and the layout does not shift.
    const radius = bodyRadius(body);
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
    const inner = ringRadius(body.rings.innerRadii, radius);
    const outer = ringRadius(body.rings.outerRadii, radius);
    const clear = this.assets.placeholders.clear;
    const geometry = createRadialRingGeometry(inner, outer, 256);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.assets.placeholderFor('map'),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: body.rings.opacity ?? 1,
      depthWrite: false,
    });

    const rings = new THREE.Mesh(geometry, material);
    rings.rotation.x = Math.PI / 2;
    rings.receiveShadow = true;
    rings.castShadow = true;
    rings.userData.bodyId = body.id;
    rings.renderOrder = 1;

    view.tilt.add(rings);
    view.rings = rings;
    this._disposables.push(geometry, material);
    this.pickables.push(rings);

    // Analytic shadows, both ways. See src/scene/ringShadow.js for why these
    // are not done with a shadow map.
    const onPlanet = receiveRingShadow(view.material, { innerRadius: inner, outerRadius: outer });
    onPlanet.uniforms.uRingMap.value = clear;
    const onRings = receivePlanetShadow(material, { planetRadius: radius });
    this._shadowCasters.push({ view, onPlanet, onRings });

    this.assets.texture(body.rings.map, 'map', 0).then((texture) => {
      material.map = texture;
      onPlanet.uniforms.uRingMap.value = texture;
    });
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

    view.tilt.add(shell);
    view.shells.push({ mesh: shell, spinPeriodHours: spec.spinPeriodHours ?? 0 });
    this._disposables.push(geometry, material);
    this.pickables.push(shell);
  }

  /** A billboarded glow so the Sun reads as a light source rather than a lit ball. */
  _buildCorona() {
    const sun = this.bodies.get(SUN_ID);
    if (!sun) return;

    const texture = makeCoronaTexture();
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: 0xffd9a0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(sun.radius * 7);
    sprite.renderOrder = -1;
    sun.group.add(sprite);
    this._disposables.push(material, texture);
  }

  /**
   * Converts catalogue elements into scene units.
   *
   * `a` is kept in its natural unit (AU for planets, km for moons) and the
   * compression is applied per-frame to the instantaneous radius instead. That
   * is what lets Pluto genuinely cross inside Neptune's orbit.
   */
  _scaleElements(body, view) {
    if (!body.orbit) return null;
    const parent = body.parent ? BODY_BY_ID.get(body.parent) : null;
    return {
      a: body.orbit.aAU ?? body.orbit.aKm,
      e: body.orbit.e,
      inc: body.orbit.inc,
      meanLong: body.orbit.meanLong,
      periLong: body.orbit.periLong,
      nodeLong: body.orbit.nodeLong,
      periodDays: periodDays(body),
      heliocentric: body.parent === SUN_ID,
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
      const scaled = heliocentricDistance(distance, this.orbitExponent);
      target.set(_raw.x, _raw.y, _raw.z).multiplyScalar(scaled / distance);
    } else {
      const parentView = this.bodies.get(el.parentId);
      const scaled = satelliteDistance(distance, el.parentBody, parentView.radius);
      target.set(_raw.x, _raw.y, _raw.z).multiplyScalar(scaled / distance);
      target.add(parentView.group.position);
    }
    return target;
  }

  /** Advances every body to the given simulated day. */
  update(tDays) {
    for (const view of this.bodies.values()) {
      if (!view.visible) continue;

      if (view.elements) this.positionAt(view, tDays, view.group.position);

      const spin = view.body.spin;
      if (spin?.periodHours && view.spinNode) {
        view.spinNode.rotation.y = spinAngle(spin.periodHours, tDays);
      }

      for (const shell of view.shells) {
        if (shell.spinPeriodHours) shell.mesh.rotation.y = spinAngle(shell.spinPeriodHours, tDays);
      }
    }

    this._updateRingShadows();
  }

  /**
   * Re-aims the analytic ring shadows. The planet spins, so the Sun's direction
   * in its object space changes every frame; the subtree matrices have to be
   * current before that can be read off, which is why this forces an update
   * rather than waiting for the renderer to do it.
   */
  _updateRingShadows() {
    if (this._shadowCasters.length === 0) return;

    const sun = this.bodies.get(SUN_ID);
    sun?.group.updateMatrixWorld(true);
    this._sunWorld.setFromMatrixPosition(sun ? sun.group.matrixWorld : this.root.matrixWorld);

    for (const caster of this._shadowCasters) {
      caster.view.group.updateMatrixWorld(true);
      updateSunDirection(caster.onPlanet, caster.view.mesh, this._sunWorld);
      updateSunDirection(caster.onRings, caster.view.rings, this._sunWorld);
    }
  }

  /** Shows or hides a whole class of bodies without destroying anything. */
  setCategoryVisible(kind, visible) {
    for (const view of this.bodies.values()) {
      if (view.body.kind !== kind) continue;
      view.visible = visible;
      view.group.visible = visible;
    }
  }

  /** True if the body exists and its category is currently shown. */
  isVisible(id) {
    const view = this.bodies.get(id);
    return Boolean(view?.visible);
  }

  /**
   * Narrows the shadow camera to the system you are looking at.
   *
   * A single cube shadow map cannot span from the Sun to Eris with any useful
   * precision. Bracketing near/far around the focused body spends the entire
   * depth range where it is actually visible, which is what makes moon-on-planet
   * shadows resolve at all.
   */
  focusShadows(view) {
    if (!this.sunLight?.castShadow || !view) return;

    const distance = view.group.position.length();
    const margin = Math.max(view.radius * 30, 600);
    const shadow = this.sunLight.shadow;
    shadow.camera.near = Math.max(1, distance - margin);
    shadow.camera.far = distance + margin;
    shadow.camera.updateProjectionMatrix();

    // One cube face spans 2 x distance at 90 degrees, so a texel is that wide
    // over the map size. The normal offset has to clear a texel or the lit face
    // shadows itself; it is capped so it cannot detach a shadow from a small
    // body entirely.
    const texel = (2 * distance) / shadow.mapSize.width;
    shadow.normalBias = Math.min(texel * 1.5, view.radius * 0.25);
  }

  setShadowQuality(size) {
    if (!this.sunLight) return;
    this.sunLight.castShadow = size > 0;
    if (size > 0) {
      this.sunLight.shadow.mapSize.set(size, size);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
  }

  dispose() {
    for (const item of this._disposables) item.dispose?.();
    this._disposables.length = 0;
    this.root.removeFromParent();
    this.bodies.clear();
    this.pickables.length = 0;
  }
}

/** One body's nodes plus the derived numbers the rest of the app reads. */
class BodyView {
  constructor(body, radius) {
    this.body = body;
    this.id = body.id;
    this.name = body.name;
    this.kind = body.kind;
    this.radius = radius;
    this.visible = true;

    this.group = new THREE.Group();
    this.tilt = new THREE.Group();
    this.group.add(this.tilt);

    this.mesh = null;
    this.spinNode = null;
    this.material = null;
    this.rings = null;
    this.shells = [];
    this.elements = null;
  }

  /** Outermost extent, so the camera knows how far back to sit. */
  get boundingRadius() {
    return this.rings ? this.rings.geometry.boundingSphere?.radius ?? this.radius * 2 : this.radius;
  }
}

function depth(body) {
  let d = 0;
  let current = body;
  while (current?.parent) {
    d++;
    current = BODY_BY_ID.get(current.parent);
  }
  return d;
}

/**
 * A ring whose U coordinate runs radially.
 *
 * three's own RingGeometry projects a square UV across the ring's bounding box,
 * which forces you to ship a full 2048x2048 image of a shape that only varies
 * with radius. With a radial U the same rings are described by a 921x1 strip.
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
 * Restricts an emissive map to the night side.
 *
 * Earth's city lights are an emissive texture, and emissive ignores lighting by
 * definition, so out of the box the lights glow straight through local noon.
 * This gates them on the dot product between the surface normal and the Sun,
 * both of which Phong already has in view space at this point in the shader.
 */
function applyNightSideEmissive(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      /* glsl */ `
      #include <emissivemap_fragment>
      #if NUM_POINT_LIGHTS > 0
        vec3 sunDirection = normalize( pointLights[ 0 ].position + vViewPosition );
        float dayness = dot( normal, sunDirection );
        totalEmissiveRadiance *= smoothstep( 0.15, -0.10, dayness );
      #endif
      `
    );
  };
  material.customProgramCacheKey = () => 'night-side-emissive';
}

/** Radial falloff painted once into a canvas; cheaper and softer than a sprite sheet. */
function makeCoronaTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, 'rgba(255,245,220,0.95)');
  gradient.addColorStop(0.12, 'rgba(255,214,150,0.55)');
  gradient.addColorStop(0.32, 'rgba(255,170,90,0.16)');
  gradient.addColorStop(0.65, 'rgba(255,140,60,0.04)');
  gradient.addColorStop(1.0, 'rgba(255,120,40,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Uniformly scales a loaded model so its longest half-extent equals `radius`. */
function fitToRadius(object, radius) {
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) / 2 || 1;
  object.scale.setScalar(radius / longest);

  // Re-centre on the origin so it spins about itself rather than about an offset.
  const centre = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  object.position.sub(centre);
}
