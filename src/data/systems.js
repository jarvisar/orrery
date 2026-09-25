import { BODIES, BODY_BY_ID, SUN_ID } from './bodies.js';

export const SOLAR_SYSTEM = {
  id: null, name: 'Solar System', starId: SUN_ID, bodies: BODIES, allBodies: BODIES,
  byId: BODY_BY_ID, overviewAU: 33, edgeAU: 100, isExoplanet: false, omitted: [],
};
