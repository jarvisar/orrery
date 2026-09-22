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
  SCALE_EXPONENT_RANGE,
} from './scaling.js';
import { orbitalPosition, spinAngle, rotationAngle } from '../sim/kepler.js';
import { equatorialToScene } from '../sim/frames.js';
import { receiveRingShadow, receivePlanetShadow, updateSunDirection } from './ringShadow.js';
import { nightSideEmissive, softTerminator, sunSurface } from './shading.js';
import { createAtmosphere } from './atmosphere.js';

const DEG = Math.PI / 180;
const _vec = new THREE.Vector3();
const _raw = { x: 0, y: 0, z: 0 };
const _inverseTilt = new THREE.Quaternion();

/** Corona sprite size, in solar radii. */
const CORONA_RADII = 6;

/**
 * The catalogue's bump scales were tuned for a much harsher look: at full
 * strength every crater rim casts a hard black edge and the terminator turns to
 * gravel. Two-thirds keeps the relief and loses the grit.
 */
const BUMP_SOFTENING = 0.65;

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

    /** The Scale setting; see src/scene/scaling.js. Set before build(). */
    this.scaleExponent = SCALE_EXPONENT_RANGE.default;

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

    // Just enough fill that the night side is a silhouette rather than a hole -
    // roughly what starlight and a little camera exposure would show.
    this.ambient = new THREE.AmbientLight(0x6c7894, 0.1);
    this.root.add(this.ambient);
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
    if (body.glow) {
      const air = createAtmosphere(radius, body.glow);
      air.userData.bodyId = body.id;
      view.tilt.add(air);
      this._disposables.push(air.geometry, air.material);
    }

    orientBody(view.tilt.quaternion, body);
    view.elements = this._scaleElements(body, view);

    this.bodies.set(body.id, view);
    return view;
  }

  _attachSphere(view, body, radius) {
    const [widthSeg, heightSeg] = sphereSegments(radius);
    const geometry = new THREE.SphereGeometry(radius, widthSeg, heightSeg);
    this._disposables.push(geometry);

    const isStar = body.kind === 'star';
    // Rock and cloud are close to perfectly matte. A broad Phong highlight on
    // them is what makes a planet look like a plastic ball; only a body with a
    // specular map - oceans, Pluto's nitrogen ice - gets a glint, and a tight one.
    const material = isStar
      ? new THREE.MeshBasicMaterial({ color: 0xffffff })
      : new THREE.MeshPhongMaterial({
          color: 0xffffff,
          shininess: body.textures?.specularMap ? 32 : 1,
          specular: body.textures?.specularMap ? 0x2a2a2a : 0x000000,
        });

    // Claim every map slot up front with a placeholder so the program that gets
    // compiled now is the same one used once the real textures arrive.
    this._claimSlots(material, body, isStar, radius);
    if (isStar) this._sunSurface = sunSurface(material);
    if (body.nightLights) nightSideEmissive(material);
    if (body.terminator) softTerminator(material, body.terminator);

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
      material.bumpScale = (body.bumpScale ?? 0.01) * radius * BUMP_SOFTENING;
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

    // Analytic shadows, both ways. See src/scene/ringShadow.js for why these
    // are not done with a shadow map.
    const onPlanet = receiveRingShadow(view.material, { innerRadius: 0, outerRadius: 0 });
    onPlanet.uniforms.uRingMap.value = clear;
    const onRings = receivePlanetShadow(material, { planetRadius: radius });
    view.ringShadow = onPlanet;
    this._shadowCasters.push({ view, onPlanet, onRings });
    this._shapeRings(view);

    this.assets.texture(body.rings.map, 'map', 0).then((texture) => {
      material.map = texture;
      onPlanet.uniforms.uRingMap.value = texture;
    });
  }

  /**
   * (Re)builds the ring geometry for the current Scale. Everything else about a
   * body scales uniformly with its tilt node, but the ring-to-planet ratio is
   * itself compressed by the exponent, so the rings need their own radii.
   * Radii are in the tilt node's local space, where the planet has its build-time
   * radius - the node's scale takes care of the rest.
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
   * Applies a new Scale exponent in place. Positions follow on the next
   * update(); sizes change here, by scaling each body's tilt node rather than
   * rebuilding meshes, so textures, materials and compiled shaders are all kept.
   */
  setScaleExponent(exponent) {
    this.scaleExponent = exponent;
    for (const view of this.bodies.values()) {
      view.radius = bodyRadius(view.body, exponent);
      view.tilt.scale.setScalar(view.radius / view.baseRadius);
      if (view.rings) this._shapeRings(view);
    }
    const sun = this.bodies.get(SUN_ID);
    this._corona?.scale.setScalar(sun.radius * CORONA_RADII);
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
    view.shells.push({
      mesh: shell,
      spinPeriodHours: spec.spinPeriodHours ?? 0,
      // Weather moves with the ground beneath it. A cloud deck on its own
      // period, as Earth's used to be, slides across the continents at
      // hundreds of degrees a day; this one drifts slowly relative to them.
      corotating: Boolean(spec.corotating),
    });
    this._disposables.push(geometry, material);
    this.pickables.push(shell);
  }

  /**
   * The Sun's glow, in two layers.
   *
   * The corona is a few solar radii across, so it scales with the Sun and
   * frames it close up. The glare is a fixed size on screen, so from Neptune -
   * where the Sun is a couple of pixels wide - it still reads as the brightest
   * thing in the sky rather than one more star. Both sit at the Sun's centre and
   * are depth tested, so the disc hides them where it covers them and a planet
   * crossing in front cuts a clean silhouette out of the light.
   */
  _buildCorona() {
    const sun = this.bodies.get(SUN_ID);
    if (!sun) return;

    const coronaTexture = makeGlowTexture(256, [
      [0.0, 1.0], [0.1, 0.62], [0.2, 0.3], [0.35, 0.11], [0.55, 0.035], [0.8, 0.008], [1.0, 0],
    ]);
    const coronaMaterial = new THREE.SpriteMaterial({
      map: coronaTexture,
      color: new THREE.Color(1.0, 0.7, 0.42).multiplyScalar(0.55),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const corona = new THREE.Sprite(coronaMaterial);
    corona.scale.setScalar(sun.radius * CORONA_RADII);
    corona.renderOrder = -1;
    sun.group.add(corona);
    this._corona = corona;

    const glareTexture = makeGlowTexture(128, [
      [0.0, 1.0], [0.04, 0.55], [0.12, 0.16], [0.3, 0.04], [0.6, 0.008], [1.0, 0],
    ]);
    const glareMaterial = new THREE.SpriteMaterial({
      map: glareTexture,
      color: new THREE.Color(1.0, 0.84, 0.64).multiplyScalar(0.5),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const glare = new THREE.Sprite(glareMaterial);
    glare.scale.setScalar(0.18);
    glare.renderOrder = -1;
    sun.group.add(glare);

    this._disposables.push(coronaMaterial, coronaTexture, glareMaterial, glareTexture);
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
      // Measured from the primary's equator, so the orbit tilts with it.
      equatorial: body.parent !== SUN_ID && body.orbit.plane !== 'ecliptic',
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
      target.set(_raw.x, _raw.y, _raw.z).multiplyScalar(scaled / distance);
    } else {
      const parentView = this.bodies.get(el.parentId);
      const scaled = satelliteDistance(distance, this.scaleExponent);
      target.set(_raw.x, _raw.y, _raw.z).multiplyScalar(scaled / distance);
      if (el.equatorial) target.applyQuaternion(parentView.tilt.quaternion);
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

    this._updateRingShadows();
  }

  /**
   * Turns a tidally locked moon so its prime meridian faces its primary.
   *
   * A free spin at the catalogue period would lock too, but only in rate - the
   * phase would be arbitrary, and the Moon would show Earth its far side.
   * Parents update before children (the map is built in depth order), so the
   * primary's position is already current here.
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
    for (const view of this.bodies.values()) view.rings?.geometry.dispose();
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

  /** Outermost extent, so the camera knows how far back to sit. */
  get boundingRadius() {
    return Math.max(this.radius, this.ringOuter * this.tilt.scale.x);
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
function orientBody(target, body) {
  let pole = body.spin?.pole;
  for (let parent = BODY_BY_ID.get(body.parent); !pole && parent; parent = BODY_BY_ID.get(parent.parent)) {
    if (parent.id !== SUN_ID) pole = parent.spin?.pole;
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

/**
 * Radial falloff painted once into a canvas; cheaper and softer than a sprite
 * sheet. Stops are [radius, intensity] pairs, both 0..1, painted white so the
 * material colour does the tinting.
 */
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

/** Uniformly scales a loaded model so its longest half-extent equals `radius`. */
function fitToRadius(object, radius) {
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) / 2 || 1;
  object.scale.setScalar(radius / longest);

  // Re-centre on the origin so it spins about itself rather than about an offset.
  const centre = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  object.position.sub(centre);
}
