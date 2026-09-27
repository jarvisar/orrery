/** Small numeric helpers shared by the scene, the interface and the exoplanet data. */

/**
 * GLSL's smoothstep: 0 at `edge0`, 1 at `edge1`, and an S-curve between. The
 * edges may be either way round, so a fade out is just the edges swapped.
 */
export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
