/**
 * Serves the web app to the window from app://orrery/, straight off disk.
 *
 * Not file://. The page is ES modules behind an import map, and fetches its
 * textures and star catalogue; Chromium treats every file:// URL as its own
 * opaque origin, which breaks the modules, the fetches and localStorage alike.
 * A privileged standard scheme behaves like an https:// site instead: a real,
 * stable, secure origin, so WebXR, the clipboard and pointer lock are all
 * available, and settings survive a restart.
 */
import { protocol } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, normalize, sep } from 'node:path';
import { CSP } from './csp.js';
import { MIME, MIME_BY_NAME } from './mime.js';

export const SCHEME = 'app';
export const HOST = 'orrery';
export const ORIGIN = `${SCHEME}://${HOST}`;

/** Must run before the app is ready. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

/**
 * Answers app://orrery/ requests from files under `root`.
 *
 * @param {object} options
 * @param {string} options.root The web app: the repository in development,
 *   or the staged copy packaged into the app.
 * @param {string[]} [options.only] Top-level entries that may be served. In
 *   development this is scripts/lib/served.js, so a file the page needs but
 *   that would not be shipped fails here first.
 * @param {(path: string, reason: string) => void} [options.onMissing]
 */
export function serve({ root, only, onMissing }) {
  const base = normalize(root);

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return respond(400, 'Bad request');
    }
    if (url.host !== HOST) return missing(url.pathname, 'unknown host');

    const top = path.split('/').find(Boolean) ?? 'index.html';
    if (only && !only.includes(top)) {
      return missing(path, 'not in scripts/lib/served.js, so it would not be shipped');
    }

    let file = normalize(join(base, path));
    if (file !== base && !file.startsWith(base + sep)) return missing(path, 'outside the web root');

    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] ?? MIME_BY_NAME[basename(file)];
      if (!type) console.warn(`[orrery] no content type for ${path}; add it to desktop/src/mime.js`);

      const headers = {
        'Content-Type': type ?? 'application/octet-stream',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-cache',
      };
      if (type?.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
      return new Response(body, { status: 200, headers });
    } catch {
      return missing(path, 'no such file');
    }
  });

  function missing(path, reason) {
    onMissing?.(path, reason);
    return respond(404, 'Not found');
  }
}

function respond(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
