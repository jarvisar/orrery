import { orbitalPosition } from './kepler.js';

/** Compress relative separation once, then split by mass: the barycentre stays fixed. */
export function stellarPositions(nodes, tDays, distanceScale, positions = new Map()) {
  const raw = {};
  for (const node of nodes) {
    const out = positions.get(node.id) ?? { x: 0, y: 0, z: 0 };
    const parent = positions.get(node.parent);
    out.x = parent?.x ?? 0; out.y = parent?.y ?? 0; out.z = parent?.z ?? 0;
    if (node.orbit) {
      orbitalPosition({ ...node.orbit, a: node.orbit.aAU }, tDays, raw);
      const distance = Math.hypot(raw.x, raw.y, raw.z);
      const factor = distanceScale(distance) / distance * node.fraction;
      out.x += raw.x * factor; out.y += raw.y * factor; out.z += raw.z * factor;
    }
    positions.set(node.id, out);
  }
  return positions;
}
