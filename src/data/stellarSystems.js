/** Companion hierarchy supplement. Planet admission always comes from NASA. */
export const STELLAR_PATH = 'public/data/stellar-systems.json';
export const OEC = 'https://github.com/OpenExoplanetCatalogue/open_exoplanet_catalogue';
const numericKeys = /^(st_(mass|rad|teff)|pl_(orbsmax|orbper|orbeccen))(err1|err2|lim)?$/;
const value = (row, key) => Number.isFinite(row[key]) && !row[`${key}lim`] ? row[key] : null;
const positive = (n) => Number.isFinite(n) && n > 0;
// Preserve case: stellar component B and planet b are different objects.
const alias = (name) => name.trim().replace(/\s+/g, ' ').replace(/^Proxima Cen(?= |$)/, 'Proxima Centauri').replace(/^PH-1(?= |$)/, 'PH1');

export function validateStellarCatalogue(data) {
  if (data?.schemaVersion !== 1 || !Number.isFinite(Date.parse(data.fetchedAt)) || !Array.isArray(data.systems)) {
    throw new Error('Invalid stellar companion catalogue');
  }
  for (const system of data.systems) {
    let count = 0;
    const visit = (node, depth = 0) => {
      if (++count > 64 || depth > 8 || !['star', 'binary'].includes(node?.kind) ||
          !Array.isArray(node.names) || node.names.some((n) => typeof n !== 'string' || !n.trim()) ||
          !Array.isArray(node.planets) || node.planets.some((p) => !Array.isArray(p) || p.some((n) => typeof n !== 'string')) ||
          !node.values || !Array.isArray(node.children) || node.children.length !== (node.kind === 'binary' ? 2 : 0)) {
        throw new Error('Invalid stellar hierarchy');
      }
      for (const [key, n] of Object.entries(node.values)) {
        if (key === 'st_spectype' ? typeof n !== 'string' : !numericKeys.test(key) || !Number.isFinite(n)) {
          throw new Error('Invalid companion measurement');
        }
      }
      node.children.forEach((child) => visit(child, depth + 1));
    };
    if (typeof system.name !== 'string' || !system.name) throw new Error('Missing stellar system name');
    visit(system.tree);
  }
  return data;
}

/** Largest reconstructable subtree containing this host's planets. No guessed separations. */
export function stellarLayout(entry, data, supplement) {
  if (!supplement || entry.stars < 2) return null;
  const matches = [];
  for (const system of supplement.systems) {
    const nodes = [], bindings = new Map();
    const visit = (node, parent = null) => {
      const copy = { ...node, parent, index: nodes.length };
      nodes.push(copy);
      for (const names of node.planets) for (const name of names) {
        const key = alias(name);
        bindings.set(key, bindings.has(key) && bindings.get(key) !== copy ? null : copy);
      }
      copy.children = node.children.map((child) => visit(child, copy));
      return copy;
    };
    const root = visit(system.tree);
    const hostBindings = entry.planets.map((row) => bindings.get(alias(row.pl_name))).filter(Boolean);
    if (!hostBindings.length) continue;
    // Conflicting multiplicities indicate stale or ambiguous supplementary data.
    if (nodes.filter((n) => n.kind === 'star').length !== entry.stars) continue;
    const distinct = [...new Set(hostBindings)];
    const assignments = new Map();
    for (const row of data.rows) {
      let node = bindings.get(alias(row.pl_name));
      // A newly discovered planet can use the established host of its siblings.
      if (!node && row.hostname === entry.name && distinct.length === 1) node = distinct[0];
      if (!node || Boolean(row.cb_flag) !== (node.kind === 'binary')) continue;
      assignments.set(row.pl_name, node);
    }
    if (entry.planets.some((r) => !assignments.has(r.pl_name))) continue;
    const resolve = (node) => {
      if (node.kind === 'star') { node.mass = value(node.values, 'st_mass'); return true; }
      const resolved = node.children.map(resolve);
      node.mass = node.children.every((n) => positive(n.mass)) ? node.children.reduce((sum, n) => sum + n.mass, 0) : null;
      let a = value(node.values, 'pl_orbsmax'), period = value(node.values, 'pl_orbper');
      const notes = [];
      if (!positive(a) && positive(period) && node.mass) { a = Math.cbrt(node.mass * (period / 365.25) ** 2); notes.push('Stellar orbit size derived from period and total stellar mass.'); }
      if (!positive(period) && positive(a) && node.mass) { period = 365.25 * Math.sqrt(a ** 3 / node.mass); notes.push('Stellar period derived from orbit size and total stellar mass.'); }
      const e = value(node.values, 'pl_orbeccen');
      if (e === null || e < 0 || e >= 1) notes.push('Unmeasured stellar eccentricity: a circular orbit is shown.');
      node.notes = notes;
      node.orbit = positive(a) && positive(period) ? { aAU: a, periodDays: period,
        e: e !== null && e >= 0 && e < 1 ? e : 0, inc: 0, nodeLong: 0, periLong: 0, meanLong: 37 * node.index } : null;
      node.resolved = resolved.every(Boolean) && Boolean(node.mass && node.orbit);
      return node.resolved;
    };
    resolve(root);
    const contains = (ancestor, node) => { for (let n = node; n; n = n.parent) if (n === ancestor) return true; return false; };
    const selected = nodes.find((n) => (n.kind === 'star' || n.resolved) && hostBindings.every((host) => contains(n, host)));
    if (!selected) continue;
    const included = nodes.filter((n) => contains(selected, n));
    // The primary carries the NASA host's id: the star this entry's planets
    // orbit, when they share one, else the first star of the pair they circle.
    const hostIsStar = distinct.length === 1 && distinct[0].kind === 'star';
    const primary = hostIsStar ? distinct[0] : selected.kind === 'star' ? selected : included.find((n) => n.kind === 'star');
    const id = (n) => n === primary ? `star:${entry.name}` : `${n.kind === 'star' ? 'star' : 'barycentre'}:${system.name}:${n.index}`;
    const layoutNodes = included.map((n) => ({ id: id(n), name: n.names[0] ?? `${system.name} pair ${n.index + 1}`,
      kind: n.kind, values: n.values, mass: n.mass,
      parent: n === selected ? null : id(n.parent),
      orbit: n === selected ? null : n.parent.orbit,
      fraction: n === selected ? 1 : (n.parent.children[0] === n ? -n.parent.children[1].mass : n.parent.children[0].mass) / n.parent.mass,
      notes: n.parent?.notes ?? [],
    }));
    const parents = new Map();
    for (const [planet, n] of assignments) if (included.includes(n)) parents.set(planet, id(n));
    matches.push({ nodes: layoutNodes, parents, primaryId: id(primary), hostIsStar,
      rows: data.rows.filter((r) => parents.has(r.pl_name)),
      missing: nodes.filter((n) => n.kind === 'star' && !included.includes(n)).map((n) => n.names[0] ?? 'Unnamed companion'),
      source: `${OEC}/blob/master/systems/${encodeURIComponent(system.name)}.xml`, fetchedAt: supplement.fetchedAt });
  }
  return matches.length === 1 ? matches[0] : null;
}
