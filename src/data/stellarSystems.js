/** Companion hierarchy supplement. Planet admission always comes from NASA. */
export const STELLAR_PATH = 'public/data/stellar-systems.json';
export const OEC = 'https://github.com/OpenExoplanetCatalogue/open_exoplanet_catalogue';
const numericKeys = /^(st_(mass|rad|teff)|pl_(orbsmax|orbper|orbeccen)|sep_(au|arcsec))(err1|err2|lim)?$/;
const value = (row, key) => Number.isFinite(row[key]) && !row[`${key}lim`] ? row[key] : null;
const positive = (n) => Number.isFinite(n) && n > 0;
const round = (n) => Number(n.toPrecision(3)).toLocaleString('en-US');
// Preserve case: stellar component B and planet b are different objects.
const alias = (name) => name.trim().replace(/\s+/g, ' ').replace(/^Proxima Cen(?= |$)/, 'Proxima Centauri').replace(/^PH-1(?= |$)/, 'PH1');

/**
 * Typical main-sequence stars: spectral subtype (B0 = 1.0 through M9 = 6.9),
 * effective temperature (K) and mass (M☉). Pecaut & Mamajek (2013), table
 * version 2022.04.16: https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt
 */
const DWARFS = [
  [1.0, 31400, 17.7], [1.2, 20600, 7.3], [1.5, 15700, 4.7], [1.8, 12300, 3.38],
  [2.0, 9700, 2.18], [2.5, 8100, 1.88], [3.0, 7220, 1.61], [3.5, 6550, 1.33],
  [4.0, 5930, 1.06], [4.2, 5770, 1.0], [4.5, 5660, 0.98], [5.0, 5270, 0.88],
  [5.2, 5100, 0.82], [5.5, 4440, 0.70], [5.7, 4100, 0.64], [6.0, 3850, 0.57],
  [6.2, 3560, 0.44], [6.3, 3430, 0.37], [6.4, 3210, 0.23], [6.5, 3060, 0.162],
  [6.6, 2810, 0.102], [6.7, 2680, 0.090], [6.8, 2570, 0.085], [6.9, 2380, 0.079],
];

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

/** The supplement, fetched once per page and shared by the atlas and the scene. */
let loading = null;
export function loadStellarCatalogue(fetcher = (...args) => fetch(...args)) {
  loading ??= fetcher(STELLAR_PATH, { signal: AbortSignal.timeout(10000) })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(validateStellarCatalogue)
    .catch((error) => { loading = null; throw error; });
  return loading;
}

/**
 * A companion's mass: reported, else estimated from its temperature or
 * spectral type as a main-sequence star. Giants and subgiants are not
 * estimated; a white dwarf takes the typical 0.6 M☉.
 */
export function stellarMassEstimate(values) {
  const reported = value(values, 'st_mass');
  if (positive(reported)) return { mass: reported, note: null };
  const type = (values.st_spectype ?? '').trim();
  if (/^(D[ABCOQXZ]|WD)/i.test(type)) {
    return { mass: 0.6, note: 'Mass not reported: the typical white-dwarf mass of 0.6 M☉ is used.' };
  }
  const spectral = /^([BAFGKM])\s*(\d(?:\.\d+)?)?\s*(I{1,3}|IV|V)?/.exec(type);
  if (spectral?.[3] && spectral[3] !== 'V') return { mass: null, note: null };
  const temperature = value(values, 'st_teff');
  if (temperature >= DWARFS.at(-1)[1] && temperature <= DWARFS[0][1]) {
    const mass = interpolate(DWARFS.map(([, t, m]) => [-Math.log(t), m]), -Math.log(temperature));
    return { mass, note: `Mass not reported: estimated at ${round(mass)} M☉ from its temperature (${round(temperature)} K), assuming a main-sequence star (Pecaut & Mamajek 2013).` };
  }
  if (spectral?.[2]) {
    const subtype = 'BAFGKM'.indexOf(spectral[1]) + 1 + Number(spectral[2]) / 10;
    if (subtype >= DWARFS[0][0] && subtype <= DWARFS.at(-1)[0]) {
      const mass = interpolate(DWARFS.map(([s, , m]) => [s, m]), subtype);
      return { mass, note: `Mass not reported: estimated at ${round(mass)} M☉ from its spectral type (${type}), assuming a main-sequence star (Pecaut & Mamajek 2013).` };
    }
  }
  return { mass: null, note: null };
}
/** Log-linear interpolation through [x, mass] points sorted by x. */
function interpolate(points, x) {
  const i = Math.max(1, points.findIndex(([px]) => px >= x));
  const [x0, m0] = points[i - 1], [x1, m1] = points[i];
  const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  return Math.exp(Math.log(m0) + t * (Math.log(m1) - Math.log(m0)));
}

// Built once per catalogue: which supplement systems name a planet, and where
// each archive planet is, so a lookup only visits the systems that matter.
const supplementIndexes = new WeakMap();
function systemsByPlanet(supplement) {
  let index = supplementIndexes.get(supplement);
  if (!index) {
    index = new Map();
    for (const system of supplement.systems) {
      const visit = (node) => {
        for (const names of node.planets) for (const name of names) {
          const key = alias(name);
          if (!index.has(key)) index.set(key, new Set());
          index.get(key).add(system);
        }
        node.children.forEach(visit);
      };
      visit(system.tree);
    }
    supplementIndexes.set(supplement, index);
  }
  return index;
}
const rowIndexes = new WeakMap();
function rowsByPlanet(data) {
  let index = rowIndexes.get(data);
  if (!index) {
    index = new Map(data.rows.map((row, order) => [alias(row.pl_name), { row, order }]));
    rowIndexes.set(data, index);
  }
  return index;
}

/**
 * Largest reconstructable subtree containing this host's planets. A stellar
 * orbit comes from its reported size or period, else from the pair's
 * separation on the sky; a companion's position is never guessed.
 */
export function stellarLayout(entry, data, supplement) {
  if (!supplement || entry.stars < 2) return null;
  const index = systemsByPlanet(supplement), rows = rowsByPlanet(data);
  const candidates = new Set(entry.planets.flatMap((row) => [...(index.get(alias(row.pl_name)) ?? [])]));
  // The host's own mass as NASA gives it, so the barycentre matches the panel.
  const nasaMass = entry.planets.map((r) => value(r, 'st_mass') ?? r.c_st_mass).find(positive) ?? null;
  const matches = [];
  for (const system of candidates) {
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
    // NASA is the authority on what is a star. A supplement that lists more
    // (usually a brown dwarf the archive counts as a planet) is not used; one
    // that lists fewer is drawn with the rest reported missing.
    const stars = nodes.filter((n) => n.kind === 'star');
    if (stars.length > entry.stars || stars.some((n) => n.names.some((name) => rows.has(alias(name))))) continue;
    const distinct = [...new Set(hostBindings)];
    const hostNode = distinct.length === 1 && distinct[0].kind === 'star' ? distinct[0] : null;
    const assignments = new Map();
    const assign = (row, node) => {
      if (node && Boolean(row.cb_flag) === (node.kind === 'binary')) assignments.set(row.pl_name, node);
    };
    for (const [key, node] of bindings) if (rows.has(key)) assign(rows.get(key).row, node);
    // A newly discovered planet can use the established host of its siblings.
    for (const row of entry.planets) if (!bindings.get(alias(row.pl_name)) && distinct.length === 1) assign(row, distinct[0]);
    if (entry.planets.some((r) => !assignments.has(r.pl_name))) continue;

    const resolve = (node) => {
      if (node.kind === 'star') {
        const own = node === hostNode && positive(nasaMass) ? { mass: nasaMass, note: null } : stellarMassEstimate(node.values);
        node.mass = own.mass;
        node.massNote = own.note;
        return true;
      }
      const resolved = node.children.map(resolve);
      node.mass = node.children.every((n) => positive(n.mass)) ? node.children.reduce((sum, n) => sum + n.mass, 0) : null;
      const v = node.values, notes = [];
      let a = value(v, 'pl_orbsmax'), period = value(v, 'pl_orbper');
      if (!positive(a) && !positive(period)) {
        // Most wide pairs only have a separation on the sky, which is on
        // average a little smaller than their true orbit.
        const au = value(v, 'sep_au'), arcsec = value(v, 'sep_arcsec');
        if (positive(au)) {
          a = au;
          notes.push(`Only the pair’s separation on the sky is known (${round(au)} AU). It is used as the orbit size; the true orbit is usually somewhat larger.`);
        } else if (positive(arcsec) && positive(entry.distance)) {
          a = arcsec * entry.distance;
          notes.push(`Only the pair’s separation on the sky is known (${round(arcsec)}″, about ${round(a)} AU at this distance). It is used as the orbit size; the true orbit is usually somewhat larger.`);
        }
      }
      // A size that disagrees with the period and masses is usually one star's
      // orbit about the centre of mass entered as the pair's; the period is
      // almost always the better measured of the two.
      if (positive(a) && positive(period) && node.mass) {
        const kepler = Math.cbrt(node.mass * (period / 365.25) ** 2);
        if (a / kepler < 2 / 3 || a / kepler > 1.5) {
          notes.push(`The catalogue’s orbit size (${round(a)} AU) disagrees with the period and masses; ${round(kepler)} AU, from the period, is used.`);
          a = kepler;
        }
      }
      if (!positive(a) && positive(period) && node.mass) { a = Math.cbrt(node.mass * (period / 365.25) ** 2); notes.push('Stellar orbit size derived from period and total stellar mass.'); }
      if (!positive(period) && positive(a) && node.mass) { period = 365.25 * Math.sqrt(a ** 3 / node.mass); notes.push('Stellar period derived from orbit size and total stellar mass.'); }
      const e = value(v, 'pl_orbeccen');
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
    const primary = hostNode ?? (selected.kind === 'star' ? selected : included.find((n) => n.kind === 'star'));
    const id = (n) => n === primary ? `star:${entry.name}` : `${n.kind === 'star' ? 'star' : 'barycentre'}:${system.name}:${n.index}`;
    const layoutNodes = included.map((n) => ({ id: id(n), name: n.names[0] ?? `${system.name} pair ${n.index + 1}`,
      kind: n.kind, values: n.values, mass: n.mass, massNote: n.massNote ?? null,
      parent: n === selected ? null : id(n.parent),
      orbit: n === selected ? null : n.parent.orbit,
      fraction: n === selected ? 1 : (n.parent.children[0] === n ? -n.parent.children[1].mass : n.parent.children[0].mass) / n.parent.mass,
      notes: n.parent?.notes ?? [],
    }));
    const parents = new Map();
    for (const [planet, n] of assignments) if (included.includes(n)) parents.set(planet, id(n));
    matches.push({ nodes: layoutNodes, parents, primaryId: id(primary), hostIsStar: Boolean(hostNode),
      rows: [...parents.keys()].map((name) => rows.get(alias(name))).sort((a, b) => a.order - b.order).map((r) => r.row),
      // Stars the supplement names but cannot place, and how many it knows of.
      missing: stars.filter((n) => !included.includes(n)).map((n) => n.names[0] ?? 'Unnamed companion'),
      catalogued: stars.length,
      source: `${OEC}/blob/master/systems/${encodeURIComponent(system.name)}.xml`, fetchedAt: supplement.fetchedAt });
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * How many of a host's stars can be drawn, and how many NASA lists, without
 * building the whole scene. The atlas uses it to say "host star only".
 */
export function starsShown(entry, data, supplement) {
  if (entry.stars < 2) return 1;
  const layout = stellarLayout(entry, data, supplement);
  return layout ? layout.nodes.filter((n) => n.kind === 'star').length : 1;
}
