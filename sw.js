/**
 * Service worker: makes the orrery installable and lets it run offline.
 *
 * Deployed, every file the site serves is precached as one versioned snapshot
 * and served cache-first, so an installed copy starts without the network and
 * never mixes modules from two releases. The deploy workflow fills in BUILD and
 * PRECACHE below (scripts/stamp-sw.js); a new release changes BUILD, which is
 * what tells the browser there is a new worker to install.
 *
 * Installing copies across any file whose revision has not changed from the
 * previous snapshot, so a release that touches one module does not re-download
 * ten megabytes of textures.
 *
 * In development PRECACHE is empty and everything goes to the network first,
 * falling back to whatever was cached on the way past. `npm run dev` therefore
 * always serves the working tree, and still works offline once it has loaded.
 */

const BUILD = 'dev';
/** [path, revision] for every file the deployed site serves. */
const PRECACHE = [];

const PREFIX = 'orrery-';
const CACHE = `${PREFIX}${BUILD}`;
const RUNTIME = `${PREFIX}runtime`;
/** Where each snapshot records the revisions it holds, for the next install to compare. */
const REVISIONS = new URL('__revisions.json', self.registration.scope).href;

const absolute = (path) => new URL(path, self.registration.scope).href;
const INDEX = absolute('index.html');

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE && name !== RUNTIME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(respond(request, url));
});

async function precache() {
  if (!PRECACHE.length) return;
  const cache = await caches.open(CACHE);
  const previous = await previousSnapshot();

  // Any failure rejects the install, and the worker already running stays in
  // charge until the next attempt: a half-filled snapshot is never served.
  await Promise.all(PRECACHE.map(async ([path, revision]) => {
    const url = absolute(path);
    if (previous && previous.revisions[path] === revision) {
      const kept = await previous.cache.match(url);
      if (kept) return cache.put(url, kept);
    }
    // 'no-cache' revalidates with the server, so the HTTP cache cannot hand
    // back a copy from before this release.
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`precache: ${path} answered ${response.status}`);
    await cache.put(url, response);
  }));

  await cache.put(REVISIONS, Response.json(Object.fromEntries(PRECACHE)));
}

/** The most recent other snapshot and what it holds, or null on a first install. */
async function previousSnapshot() {
  const names = (await caches.keys())
    .filter((name) => name.startsWith(PREFIX) && name !== CACHE && name !== RUNTIME);
  for (const name of names.reverse()) {
    const cache = await caches.open(name);
    const revisions = await cache.match(REVISIONS).then((r) => r?.json());
    if (revisions) return { cache, revisions };
  }
  return null;
}

async function respond(request, url) {
  const navigating = request.mode === 'navigate';

  if (PRECACHE.length) {
    // Query strings carry app state (?body=, ?t=), never a different file.
    let key = url.origin + url.pathname;
    if (navigating && key === self.registration.scope) key = INDEX;
    const hit = await caches.match(key, { cacheName: CACHE });
    if (hit) return hit;
  }

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(RUNTIME).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const hit = await caches.match(request, { ignoreSearch: navigating });
    if (hit) return hit;
    if (navigating) {
      const shell = await caches.match(INDEX);
      if (shell) return shell;
    }
    throw error;
  }
}
