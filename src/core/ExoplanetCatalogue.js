import { CATALOGUE_PATH, archiveQuery, hostQuery, NAME_QUERY, QUERY_URL, catalogueFromArchive, validateCatalogue, groupSystems } from '../data/exoplanets.js';

// jarvisar/cors-proxy accepts the full upstream URL in this header at /proxy.
export const PROXY_URL = 'https://cors-proxy-phi.vercel.app/proxy';
/** The archive adds planets about weekly, and the deploy refreshes the bundled copy as often. */
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 700; // Keep each response below serverless response-size limits.

export class ExoplanetCatalogue {
  constructor({ fetcher = (...args) => fetch(...args), storage = catalogueStorage } = {}) {
    this.fetcher = fetcher;
    this.storage = storage;
    this.data = null;
    this.systems = [];
    this.listeners = new Set();
    this.status = '';
    this.refreshing = false;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
  accept(data) { this.data = validateCatalogue(data); this.systems = groupSystems(data); }
  load() {
    return this._load ??= this._loadInitial().catch((error) => { this._load = null; throw error; });
  }
  async _loadInitial() {
    const [stored, bundled] = await Promise.allSettled([
      this.storage.read(),
      this.fetcher(CATALOGUE_PATH, { signal: AbortSignal.timeout(15000) }).then(async (r) => {
        if (!r.ok) throw new Error('Bundled catalogue unavailable.');
        return r.json();
      }),
    ]);
    const valid = (result) => {
      try { return result.status === 'fulfilled' && result.value ? validateCatalogue(result.value) : null; } catch { return null; }
    };
    const saved = valid(stored), shipped = valid(bundled);
    const newest = [saved, shipped].filter(Boolean).sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
    // A release has overtaken the saved refresh (or it is from an older format):
    // drop it, so later visits read one catalogue rather than two.
    if (stored.status === 'fulfilled' && stored.value && newest !== saved) this.storage.clear?.().catch(() => {});
    if (!newest) {
      if (!await this.refresh()) throw new Error('The catalogue could not be loaded. Reconnect and try again.');
    } else {
      if (!this.data || Date.parse(newest.fetchedAt) > Date.parse(this.data.fetchedAt)) this.accept(newest);
      if (!this.refreshing) this.status = 'Saved catalogue ready';
      this.emit();
    }
    return this.data;
  }
  get stale() { return Boolean(this.data) && Date.now() - Date.parse(this.data.fetchedAt) > MAX_AGE; }
  refreshIfStale() {
    if (this.stale) return this.refresh();
  }
  /** One small query, so a mistyped link does not cost a whole refresh to rule out. */
  async hasHost(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) return false;
    try { return (await this.request(hostQuery(name))).some((row) => row?.hostname === name); } catch { return false; }
  }
  refresh() { return this._refresh ??= this._refreshLive().finally(() => { this._refresh = null; }); }
  async _refreshLive() {
    this.refreshing = true;
    this.lastError = null;
    this.status = 'Checking NASA for discoveries…';
    this.emit();
    try {
      const rows = [];
      // NASA applies TOP before ORDER BY. First obtain its complete name order,
      // then request bounded ranges without TOP, checking each page's membership.
      const names = (await this.request(NAME_QUERY)).map((row) => row?.pl_name);
      if (names.length < 1000 || names.length > 70000 || names.some((n) => typeof n !== 'string' || !n) ||
          new Set(names).size !== names.length) throw new Error('Invalid archive name index');
      for (let offset = 0; offset < names.length; offset += PAGE_SIZE) {
        const expected = names.slice(offset, offset + PAGE_SIZE);
        const batch = await this.request(archiveQuery({ first: expected[0], last: expected.at(-1) }));
        const received = new Set(batch.map((r) => r?.pl_name));
        if (batch.length !== expected.length || expected.some((name) => !received.has(name))) throw new Error('Archive changed during refresh; retry');
        rows.push(...batch);
        this.status = `Checking NASA · ${rows.length.toLocaleString()} planets received`;
        this.emit();
      }
      if (rows.length < 1000 || (this.data && rows.length < this.data.rows.length * 0.95)) throw new Error('Incomplete catalogue');
      const data = catalogueFromArchive(rows);
      this.accept(data);
      const saved = await this.storage.write(data).then(() => true, () => false);
      this.status = saved ? 'Updated from NASA · saved for offline use' : 'Updated from NASA · offline storage unavailable';
      return true;
    } catch (error) {
      this.lastError = error;
      this.status = this.data ? 'NASA refresh unavailable · keeping the saved catalogue. Try again later.' : 'NASA is unavailable. Reconnect and try again.';
      return false;
    } finally {
      this.refreshing = false;
      this.emit();
    }
  }

  async request(query) {
    const upstream = new URL(QUERY_URL);
    upstream.searchParams.set('query', query);
    const response = await this.fetcher(PROXY_URL, {
      headers: { 'Target-URL': upstream.href }, credentials: 'omit',
      signal: AbortSignal.timeout(45000), cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('Invalid archive response');
    return batch;
  }
}

// IndexedDB avoids localStorage's small quota and blocking multi-megabyte writes.
export const catalogueStorage = {
  read: () => stored('readonly', (store) => store.get('latest')),
  write: (data) => stored('readwrite', (store) => store.put(data, 'latest')),
  clear: () => stored('readwrite', (store) => store.delete('latest')),
};
function stored(mode, operate) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('orrery-exoplanets', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('catalogue');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Catalogue storage is blocked'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('catalogue', mode);
      const operation = operate(tx.objectStore('catalogue'));
      tx.oncomplete = () => { db.close(); resolve(operation.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
