/**
 * Invariants every catalogue must satisfy before it replaces the shipped copy:
 * whatever NASA or the Open Exoplanet Catalogue publish next, each system still
 * builds into a finite, drawable model that keeps every planet. These hold for
 * any data, so a weekly refresh can be checked by them without depending on
 * which systems happen to be in it (the named-system tests are for the
 * committed copy; see scripts/exoplanets.test.js).
 */
import { groupSystems, makeSystem } from '../../src/data/exoplanets.js';
import { orbitalPosition } from '../../src/sim/kepler.js';
import { stellarPositions } from '../../src/sim/stellar.js';
import { heliocentricDistance, SCALE_EXPONENT_RANGE } from '../../src/scene/scaling.js';

const DAYS = [-100000, 0, 9750, 100000];

/** Throws with the first system that fails; returns how many were checked. */
export function verifyModels(data, supplement) {
  const entries = groupSystems(data);
  for (const entry of entries) {
    const fail = (why) => { throw new Error(`${entry.name}: ${why}`); };
    const system = makeSystem(entry, data, supplement);
    const ids = new Set(system.allBodies.map((b) => b.id));
    if (ids.size !== system.allBodies.length) fail('duplicate body ids');
    for (const planet of entry.planets) {
      if (!system.allBodies.some((b) => b.name === planet.pl_name)) fail(`${planet.pl_name} was dropped`);
    }
    if (!(system.overviewAU > 0 && Number.isFinite(system.overviewAU))) fail('no finite overview');
    if (system.home && !(system.byId.has(system.home.centreId) && system.home.radiusAU > 0 && system.home.radiusAU < system.overviewAU)) {
      fail('invalid home view');
    }
    const anchors = new Set([...system.byId.keys(), ...system.stellarNodes.map((n) => n.id)]);
    for (const body of system.bodies) {
      if (!(body.radiusKm > 0 && Number.isFinite(body.radiusKm))) fail(`${body.name} has no finite radius`);
      if (body.parent && !anchors.has(body.parent)) fail(`${body.name} orbits a missing ${body.parent}`);
      if (!body.orbit) continue;
      const elements = { ...body.orbit, a: body.orbit.aAU };
      for (const day of DAYS) {
        if (!Object.values(orbitalPosition(elements, day, {})).every(Number.isFinite)) fail(`${body.name} leaves its orbit`);
      }
    }
    if (!system.stellarNodes.length) continue;
    for (const exponent of [SCALE_EXPONENT_RANGE.min, SCALE_EXPONENT_RANGE.default, SCALE_EXPONENT_RANGE.max]) {
      const bound = heliocentricDistance(system.overviewAU, exponent);
      for (const day of DAYS) {
        const positions = stellarPositions(system.stellarNodes, day, (au) => heliocentricDistance(au, exponent));
        for (const [id, p] of positions) {
          if (![p.x, p.y, p.z].every(Number.isFinite)) fail(`${id} is not finite`);
          if (Math.hypot(p.x, p.y, p.z) > bound) fail(`${id} leaves the overview`);
        }
      }
    }
  }
  return entries.length;
}
