/**
 * Content types for the files the app serves itself, by extension.
 *
 * The same idea as the table in scripts/serve.js, but the desktop app is
 * packaged without scripts/, so it keeps its own. `npm run desktop:check`
 * fails if a served file has an extension missing from here: module scripts in
 * particular refuse to run without a JavaScript type.
 *
 * Kept free of Electron imports so the checks can read it from plain Node.
 */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Files served with no extension, or a name that says what they are. */
export const MIME_BY_NAME = {
  LICENSE: 'text/plain; charset=utf-8',
  VERSION: 'text/plain; charset=utf-8',
};
