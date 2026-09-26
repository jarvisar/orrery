/**
 * The Content-Security-Policy every page is served with.
 *
 * The page is all local files; the exceptions are REMOTE_ORIGINS. A new one
 * would work in the browser and fail here, so `npm run desktop:check` compares
 * this list against the https:// origins the source mentions.
 *
 * Kept free of Electron imports so the checks can read it from plain Node.
 */

/** Origins the page fetches from at runtime, beyond its own files. */
export const REMOTE_ORIGINS = [
  // VR only: the 3D model of each make of controller (src/xr/VRMode.js).
  'https://cdn.jsdelivr.net',
  // Live NASA catalogue refresh through the owner's CORS proxy.
  'https://cors-proxy-phi.vercel.app',
];

/**
 * Origins the source mentions only as links for the user to follow. Those
 * open in the system browser (see openExternal in main.js), so the policy does
 * not need them.
 */
export const LINK_ORIGINS = [
  'https://github.com',
  'https://exoplanetarchive.ipac.caltech.edu',
  // Papers behind the observed exoplanet appearances and dust disks.
  'https://doi.org',
  'https://arxiv.org',
];

const remote = REMOTE_ORIGINS.join(' ');

export const CSP = [
  "default-src 'self'",
  // Inline: the preload block and import map in index.html, and tetris.html.
  // wasm-unsafe-eval: in case a decoder (meshopt, Draco, Basis) is ever added.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // blob: is how GLTFLoader hands over the textures embedded in a .glb.
  `img-src 'self' data: blob: ${remote}`,
  "font-src 'self' data:",
  `connect-src 'self' data: blob: ${remote}`,
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
