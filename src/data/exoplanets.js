/** NASA default published solutions; shared by the importer and browser. */
import { AU_KM, EARTH_RADIUS_KM } from './bodies.js';
import { stellarLayout } from './stellarSystems.js';
import { searchKey } from './starNames.js';
import { SCALE_EXPONENT_RANGE } from '../scene/scaling.js';

export const ARCHIVE = 'https://exoplanetarchive.ipac.caltech.edu';
export const CATALOGUE_PATH = 'public/data/exoplanets.json';
/** 2: compact rows, one shared citation table, and composite-table gap fillers. */
export const SCHEMA_VERSION = 2;
export const PARSEC_LY = 3.261563777;
const SOLAR_RADIUS_KM = 695700;
/** The Sun's surface gravity in cm/s², as log g is quoted (log g☉ = 4.438). */
const SOLAR_GRAVITY_CGS = 27420;
const PROJECTED = /Imaging|Microlensing/;
/** Every position of the Scale slider, which moves in steps of 0.01. */
const EXPONENTS = Array.from({ length: Math.round((SCALE_EXPONENT_RANGE.max - SCALE_EXPONENT_RANGE.min) / 0.01) + 1 },
  (_, i) => SCALE_EXPONENT_RANGE.min + i * 0.01);

/** Measurements kept with their uncertainties and limit flags. */
const MEASURED = ['pl_orbper', 'pl_orbsmax', 'pl_orbeccen', 'pl_rade', 'pl_masse', 'pl_msinie', 'st_rad', 'st_mass', 'st_teff', 'st_lum', 'st_logg'];
const TEXT = ['hostname', 'pl_name', 'discoverymethod', 'disc_facility', 'st_spectype', 'rowupdate'];
const COUNTS = ['sy_snum', 'sy_pnum', 'disc_year'];
/** Flags stored only when set. */
const FLAGS = ['cb_flag', 'pl_controv_flag'];
/** Archive citation HTML, stored as indices into one shared reference table. */
const CITATIONS = { pl_refname: 'pl_ref', st_refname: 'st_ref', sy_dist_reflink: 'dist_ref' };
/**
 * Composite-table (pscomppars) values that fill a gap in the default solution.
 * They can come from a different publication, so they are only ever used where
 * the default solution has nothing, and are labelled wherever they appear.
 */
const FILLERS = ['pl_orbper', 'pl_orbsmax', 'pl_orbeccen', 'st_mass', 'st_rad', 'st_teff'];

const SELECT = [
  ...[...TEXT, ...COUNTS, ...FLAGS, 'pl_refname', 'st_refname'].map((key) => `p.${key}`),
  // The composite table carries a distance for nearly every host.
  'c.sy_dist', 'c.sy_dist_reflink',
  ...MEASURED.flatMap((key) => [key, `${key}err1`, `${key}err2`, `${key}lim`].map((column) => `p.${column}`)),
  ...FILLERS.flatMap((key) => [`c.${key} as c_${key}`, `c.${key}lim as c_${key}lim`]),
  'c.st_spectype as c_st_spectype',
].join(',');
export const NAME_QUERY = 'select pl_name from ps where default_flag=1 order by pl_name';
const quote = (name) => name.replaceAll("'", "''");
/** One row if the archive has a host by this exact name: cheap, before a whole refresh. */
export function hostQuery(name) {
  return `select top 1 hostname from ps where default_flag=1 and hostname = '${quote(name)}'`;
}
export function archiveQuery({ first, last } = {}) {
  const range = first && last ? ` and p.pl_name >= '${quote(first)}' and p.pl_name <= '${quote(last)}'` : '';
  return `select ${SELECT} from ps p left outer join pscomppars c on p.pl_name=c.pl_name where p.default_flag=1${range} order by p.pl_name`;
}
export const QUERY = archiveQuery();
export const QUERY_URL = `${ARCHIVE}/TAP/sync?${new URLSearchParams({ query: QUERY, format: 'json' })}`;

/* --- the stored catalogue --------------------------------------------------- */

/**
 * Raw TAP rows to the stored form: nulls and zero flags dropped, citations
 * shared, gap fillers kept only where needed. The importer and the in-browser
 * refresh both go through this, so the two copies can never differ in shape.
 */
export function normalizeRows(raw) {
  if (!Array.isArray(raw)) throw new Error('Invalid archive response');
  const refs = [], index = new Map();
  const cite = (html) => {
    const ref = parseReference(html);
    if (!ref) return undefined;
    const key = `${ref.label}\n${ref.href ?? ''}`;
    if (!index.has(key)) { index.set(key, refs.length); refs.push(ref.href ? [ref.label, ref.href] : [ref.label]); }
    return index.get(key);
  };
  const finite = Number.isFinite;
  const rows = raw.map((source) => {
    if (!source || typeof source !== 'object') throw new Error('Invalid archive row');
    const row = {};
    for (const key of TEXT) if (typeof source[key] === 'string' && source[key].trim()) row[key] = source[key];
    for (const key of ['sy_dist', ...COUNTS]) if (finite(source[key])) row[key] = source[key];
    for (const key of FLAGS) if (finite(source[key]) && source[key] !== 0) row[key] = source[key];
    for (const key of MEASURED) {
      if (!finite(source[key])) continue;
      row[key] = source[key];
      for (const suffix of ['err1', 'err2']) if (finite(source[key + suffix])) row[key + suffix] = source[key + suffix];
      if (finite(source[`${key}lim`]) && source[`${key}lim`] !== 0) row[`${key}lim`] = source[`${key}lim`];
    }
    for (const [column, key] of Object.entries(CITATIONS)) {
      const ref = cite(source[column]);
      if (ref !== undefined) row[key] = ref;
    }
    for (const key of FILLERS) {
      const value = source[`c_${key}`];
      if (own(row, key) === null && finite(value) && !source[`c_${key}lim`] && plausible(key, value)) row[`c_${key}`] = value;
    }
    if (!row.st_spectype && typeof source.c_st_spectype === 'string' && source.c_st_spectype.trim()) row.c_st_spectype = source.c_st_spectype;
    return row;
  });
  return { refs, rows };
}

/** A validated catalogue from a complete archive response. */
export function catalogueFromArchive(raw, fetchedAt = new Date().toISOString()) {
  const { refs, rows } = normalizeRows(raw);
  return validateCatalogue({
    schemaVersion: SCHEMA_VERSION, fetchedAt,
    source: { name: 'NASA Exoplanet Archive', table: 'ps', query: QUERY, url: QUERY_URL },
    refs, rows,
  });
}

const TEXT_KEYS = new Set([...TEXT, 'c_st_spectype']);
const REF_KEYS = new Set(Object.values(CITATIONS));
const NUMERIC_KEYS = new Set([
  'sy_dist', ...COUNTS, ...FLAGS, ...FILLERS.map((key) => `c_${key}`),
  ...MEASURED.flatMap((key) => [key, `${key}err1`, `${key}err2`, `${key}lim`]),
]);

export function validateCatalogue(data) {
  if (data?.schemaVersion !== SCHEMA_VERSION || !Number.isFinite(Date.parse(data.fetchedAt)) ||
      data.source?.table !== 'ps' || !Array.isArray(data.refs) || !Array.isArray(data.rows) || !data.rows.length) {
    throw new Error('Unrecognized exoplanet catalogue.');
  }
  for (const ref of data.refs) {
    if (!Array.isArray(ref) || typeof ref[0] !== 'string' || ref.length > 2 || (ref.length === 2 && !safeHref(ref[1]))) {
      throw new Error('Invalid citation in the exoplanet catalogue.');
    }
  }
  const names = new Set();
  for (const row of data.rows) {
    if (!row || typeof row.hostname !== 'string' || !row.hostname.trim() ||
        typeof row.pl_name !== 'string' || !row.pl_name.trim() || names.has(row.pl_name)) {
      throw new Error('Invalid or duplicate planet in the exoplanet catalogue.');
    }
    names.add(row.pl_name);
    for (const [key, value] of Object.entries(row)) {
      const valid = TEXT_KEYS.has(key) ? typeof value === 'string'
        : REF_KEYS.has(key) ? Number.isInteger(value) && value >= 0 && value < data.refs.length
        : NUMERIC_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value);
      if (!valid) throw new Error(`Invalid ${key} for ${row.pl_name}.`);
    }
  }
  return data;
}

export function groupSystems(data) {
  const groups = new Map();
  for (const row of data.rows) {
    if (!groups.has(row.hostname)) groups.set(row.hostname, { name: row.hostname, planets: [] });
    groups.get(row.hostname).planets.push(row);
  }
  return [...groups.values()].map((system) => ({
    ...system,
    distance: system.planets.find((r) => positive(r.sy_dist))?.sy_dist ?? null,
    stars: Math.max(...system.planets.map((r) => r.sy_snum ?? 1)),
    latest: Math.max(...system.planets.map((r) => r.disc_year ?? 0)),
    temperature: system.planets.map((r) => sourced(r, 'st_teff').value).find(positive) ?? null,
    searchable: searchKey(`${system.name} ${system.planets.map((r) => r.pl_name).join(' ')}`),
  }));
}

/* --- measurements and estimates -------------------------------------------- */

export function positive(value) { return Number.isFinite(value) && value > 0; }
/** A reported central value: never an upper or lower limit. */
export function measurement(row, key) {
  return Number.isFinite(row[key]) && !row[`${key}lim`] ? row[key] : null;
}
function usable(row, key) { const n = measurement(row, key); return positive(n) ? n : null; }
function plausible(key, value) { return key === 'pl_orbeccen' ? value >= 0 && value < 1 : value > 0; }
/** The default solution's own usable value, or null. */
function own(row, key) { const n = measurement(row, key); return n !== null && plausible(key, n) ? n : null; }
/** The default solution's value, else the composite table's gap filler, and which it was. */
function sourced(row, key) {
  const value = own(row, key);
  if (value !== null) return { value, composite: false };
  return Number.isFinite(row[`c_${key}`]) ? { value: row[`c_${key}`], composite: true } : { value: null, composite: false };
}
const COMPOSITE = 'from the NASA composite table, which may cite a different publication than the default solution';

/** Central mass–radius fit used by the archive (Chen & Kipping 2017).
 * A population estimate, not a measurement or a composition determination.
 * https://exoplanetarchive.ipac.caltech.edu/docs/pscp_calc.html
 */
export function radiusEstimate(row) {
  const reported = usable(row, 'pl_rade');
  if (reported) return { radius: reported, note: null };
  const mass = usable(row, 'pl_masse') ?? usable(row, 'pl_msinie');
  if (!mass) return { radius: 1, note: 'No usable radius or mass: a one-Earth-radius display placeholder is used.' };
  const [c, slope] = mass < 2.04 ? [0.00346, 0.279] : mass < 132 ? [-0.0925, 0.589]
    : mass < 26600 ? [1.25, -0.044] : [-2.85, 0.881];
  const radius = 10 ** c * mass ** slope;
  return { radius, note: `Display radius estimated at ${number(radius)} R⊕ from ${usable(row, 'pl_masse') ? 'mass' : 'minimum mass (M sin i, treated as a mass proxy)'} using Chen & Kipping (2017). Composition, inclination and intrinsic scatter can change the true radius substantially.` };
}

/** Host mass for Kepler's third law: reported, composite, or from surface gravity and radius. */
export function stellarMass(row) {
  const { value, composite } = sourced(row, 'st_mass');
  if (value) return { mass: value, note: composite ? `Stellar mass (${number(value)} M☉) ${COMPOSITE}.` : null };
  const logG = measurement(row, 'st_logg'), radius = usable(row, 'st_rad');
  const mass = logG !== null && radius ? 10 ** logG * radius ** 2 / SOLAR_GRAVITY_CGS : null;
  // Outside this range the inputs are more likely wrong than the star is extraordinary.
  if (mass > 0.01 && mass < 300) {
    return { mass, note: `Stellar mass estimated at ${number(mass)} M☉ from surface gravity and radius (M = gR²/G).` };
  }
  return { mass: null, note: null };
}

export function stellarRadiusEstimate(row) {
  const reported = sourced(row, 'st_rad');
  if (reported.value) return { radius: reported.value, note: reported.composite ? `Stellar radius ${COMPOSITE}.` : null };
  if (/^PSR\s/.test(row.hostname ?? '') || /pulsar|neutron/i.test(row.st_spectype ?? '')) {
    return { radius: 12 / SOLAR_RADIUS_KM,
      note: 'Pulsar radius not reported: a typical 12 km neutron-star radius is used as a display estimate. A minimum rendered size keeps it selectable.' };
  }
  const logL = measurement(row, 'st_lum'), temperature = sourced(row, 'st_teff').value;
  const luminosityRadius = logL !== null && temperature ? Math.sqrt(10 ** logL) * (5772 / temperature) ** 2 : null;
  if (positive(luminosityRadius)) {
    return { radius: luminosityRadius,
      note: 'Stellar display radius derived from luminosity and effective temperature using the Stefan–Boltzmann law.' };
  }
  const logG = measurement(row, 'st_logg'), mass = sourced(row, 'st_mass').value;
  const gravityRadius = logG !== null && mass ? Math.sqrt(mass * SOLAR_GRAVITY_CGS / 10 ** logG) : null;
  if (positive(gravityRadius)) {
    return { radius: gravityRadius,
      note: 'Stellar display radius derived from mass and surface gravity (g = GM/R²).' };
  }
  return { radius: 1, note: 'No usable stellar radius, luminosity or gravity: a one-solar-radius display placeholder is used.' };
}
export function number(value) {
  if (!Number.isFinite(value)) return 'Unknown';
  return value !== 0 && Math.abs(value) < 0.0001 ? value.toExponential(2)
    : Number(value.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}
export function measuredText(row, key, unit = '') {
  const value = row[key];
  if (!Number.isFinite(value)) return 'Not reported';
  const limit = row[`${key}lim`];
  const reported = value !== 0 && Math.abs(value) < 0.0001 ? number(value)
    : value.toLocaleString('en-US', { maximumSignificantDigits: 10 });
  let text = `${limit === 1 ? '< ' : limit === -1 ? '> ' : ''}${reported}`;
  const upper = row[`${key}err1`], lower = row[`${key}err2`];
  if (!limit && Number.isFinite(upper) && Number.isFinite(lower) && (upper || lower)) {
    text += ` (+${number(Math.abs(upper))} / −${number(Math.abs(lower))})`;
  }
  return text + (unit ? ` ${unit}` : '');
}
/** The default solution's value as reported, else a labelled composite gap filler. */
function factText(row, key, unit = '') {
  if (Number.isFinite(row[key])) return measuredText(row, key, unit);
  const filler = row[`c_${key}`];
  return Number.isFinite(filler) ? `${number(filler)}${unit ? ` ${unit}` : ''} (composite table)` : 'Not reported';
}

/**
 * Relative system-plane illustration, never a transit/position ephemeris.
 * `binaryMass` is the reconstructed pair's total mass for a circumbinary planet.
 */
export function orbitModel(row, { binaryMass = null } = {}) {
  const circumbinary = row.cb_flag === 1;
  const projected = PROJECTED.test(row.discoverymethod ?? '');
  const notes = [];
  const reportedPeriod = sourced(row, 'pl_orbper'), reportedSize = sourced(row, 'pl_orbsmax');
  let period = reportedPeriod.value, a = reportedSize.value;
  if (reportedPeriod.composite) notes.push(`Orbital period ${COMPOSITE}.`);
  if (reportedSize.composite) notes.push(`Orbit size ${COMPOSITE}.`);
  // Imaged and microlensed planets often have only a separation on the sky.
  // With a period it came from an orbit fit; without one it is still the best
  // size available, and on average a little smaller than the true orbit.
  if (projected && a && !period) {
    notes.push('Only the separation projected on the sky is reported. It is used as the orbit size; the true orbit is usually somewhat larger.');
  }

  let mass = null, massNote = null, massLabel = 'stellar mass';
  if (circumbinary) {
    massLabel = 'total mass of the stellar pair';
    if (positive(binaryMass)) mass = binaryMass;
    else if (a && period) notes.push('The stellar pair could not be reconstructed, so this orbit is drawn about the host’s position, which stands in for the pair’s centre of mass.');
    else return { reason: 'Circumbinary orbit: the stellar pair cannot be reconstructed, and the orbit size or period is missing.' };
  } else {
    ({ mass, note: massNote } = stellarMass(row));
  }
  if (!a && period && mass) {
    a = Math.cbrt(mass * (period / 365.25) ** 2);
    notes.push(`Orbit size derived from the period and ${massLabel} (Kepler’s third law, negligible planet mass).`);
    if (massNote) notes.push(massNote);
  } else if (!period && a && mass) {
    period = 365.25 * Math.sqrt(a ** 3 / mass);
    notes.push(`Period derived from the orbit size and ${massLabel} (Kepler’s third law, negligible planet mass).`);
    if (massNote) notes.push(massNote);
  }
  if (!positive(a) || !positive(period)) {
    return { reason: projected && a
      ? 'Only a projected separation is reported and the stellar mass is unknown, so no period can be derived.'
      : 'Insufficient orbit size, period or stellar mass to reconstruct this orbit.' };
  }
  const eccentricity = sourced(row, 'pl_orbeccen');
  const e = eccentricity.value ?? 0;
  if (eccentricity.value === null) notes.push('Unknown eccentricity: a circular orbit is shown.');
  else if (eccentricity.composite) notes.push(`Eccentricity ${COMPOSITE}.`);
  return { a, period, e, notes };
}

/* --- citations and links ---------------------------------------------------- */

/** Safe citation extraction: archive HTML is never inserted into the page. */
export function parseReference(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  const match = html.match(/href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/&amp;/g, '&');
  const label = html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
  return label ? { label, href: safeHref(raw) ? new URL(raw).href : undefined } : null;
}
/** A stored citation, by its index in the catalogue's reference table. */
export function reference(data, index) {
  const ref = Number.isInteger(index) ? data.refs[index] : null;
  return ref ? { label: ref[0], href: ref[1] } : null;
}
function safeHref(value) {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}

export function archiveLink(name) { return `${ARCHIVE}/overview/${encodeURIComponent(name)}`; }

/* --- colour ----------------------------------------------------------------- */

/**
 * The sRGB colour of a blackbody at `temperature` kelvin, brightest channel at
 * full: Planck's law through the CIE 1931 observer (Wyman, Sloan & Shirley 2013
 * fit) into sRGB. Stars are not perfect blackbodies, but at a glance this is
 * the colour their temperature gives them.
 */
export function stellarColor(temperature) {
  if (!positive(temperature)) return '#fff1e0';
  const key = Math.round(Math.min(Math.max(temperature, 1000), 40000) / 50) * 50;
  let hex = COLOR_CACHE.get(key);
  if (!hex) COLOR_CACHE.set(key, hex = blackbodyHex(key));
  return hex;
}
const COLOR_CACHE = new Map();
function blackbodyHex(temperature) {
  const lobe = (x, mu, s1, s2) => Math.exp(-0.5 * ((x - mu) / (x < mu ? s1 : s2)) ** 2);
  let X = 0, Y = 0, Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const planck = nm ** -5 / Math.expm1(1.4387769e7 / (nm * temperature));
    X += planck * (1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2));
    Y += planck * (0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1));
    Z += planck * (1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8));
  }
  const linear = [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  ].map((c) => Math.max(c, 0));
  const peak = Math.max(...linear);
  return `#${linear.map((c) => {
    const v = c / peak;
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

/** Rocky, cloud-wrapped sub-Neptune or giant: a colour and a procedural surface for the size. */
function planetLook(radiusEarths) {
  if (radiusEarths < 1.6) return { color: '#cdb095', surface: 'rock' };
  return { color: radiusEarths < 4 ? '#93bfcc' : '#d8bd91', surface: 'clouds' };
}

/* --- one system as the renderer's catalogue -------------------------------- */

export function makeSystem(entry, data, supplement = null) {
  const layout = stellarLayout(entry, data, supplement);
  // Use one planet's stellar solution, rather than silently mixing stellar properties.
  const host = [...entry.planets].sort((a, b) => stellarScore(b) - stellarScore(a))[0];
  const starId = `star:${entry.name}`;
  const hostStar = nasaStar(entry, host, data, starId);
  const stellarNodes = layout?.nodes ?? [];
  const nodesById = new Map(stellarNodes.map((n) => [n.id, n]));
  const starCount = stellarNodes.filter((n) => n.kind === 'star').length;
  const stars = layout ? stellarNodes.filter((n) => n.kind === 'star').map((node) => {
    const orbit = node.orbit ? { ...node.orbit, fraction: node.fraction } : undefined;
    const hierarchy = [...node.notes,
      `Stellar hierarchy and companion properties: Open Exoplanet Catalogue, retrieved ${layout.fetchedAt.slice(0, 10)}.`,
      'Stellar phases and mutual orbital orientations are illustrative. Hierarchical two-body orbits omit gravitational perturbations.'];
    const blurb = `${entry.stars}-star system. ${layout.missing.length ? `Companions without complete orbits: ${layout.missing.join(', ')}.` : ''}`.trim();
    const shown = { 'Stars shown': `${starCount} of ${entry.stars}` };
    // The planets' own host keeps NASA's measurements and citations.
    if (node.id === starId && layout.hostIsStar) {
      return { ...hostStar, name: node.name, parent: node.parent, orbit, blurb: `${planetCount(entry)} ${blurb}`,
        facts: { ...hostStar.facts, ...shown }, modelNotes: [...hostStar.modelNotes, ...hierarchy],
        companionSource: layout.source };
    }
    const radius = stellarRadiusEstimate({ ...node.values, hostname: node.name });
    const temperature = usable(node.values, 'st_teff');
    return { ...hostStar, id: node.id, name: node.name, parent: node.parent, orbit,
      radiusKm: radius.radius * SOLAR_RADIUS_KM, temperature, color: stellarColor(temperature),
      source: layout.source, sourceName: 'Open Exoplanet Catalogue', sourceDate: layout.fetchedAt,
      reference: null, blurb: node.id === starId ? `${planetCount(entry)} ${blurb}` : blurb,
      facts: { 'Distance from Earth': hostStar.facts['Distance from Earth'],
        'Spectral type': node.values.st_spectype ?? 'Not reported',
        'Stellar radius': measuredText(node.values, 'st_rad', 'R☉'), 'Stellar mass': measuredText(node.values, 'st_mass', 'M☉'),
        Temperature: measuredText(node.values, 'st_teff', 'K'), ...shown },
      modelNotes: [radius.note, ...hierarchy, 'Stellar colour is the colour of a blackbody at the star’s temperature; surface detail is illustrative.'].filter(Boolean),
    };
  }) : [hostStar];
  // The planets' host leads the lists; the rest keep their place in the hierarchy.
  stars.sort((a, b) => (b.id === starId) - (a.id === starId));

  const planets =(layout?.rows ?? entry.planets).map((row) => {
    const parentId = layout?.parents.get(row.pl_name) ?? starId;
    const parentNode = nodesById.get(parentId);
    const orbit = orbitModel(row, { binaryMass: parentNode?.kind === 'binary' ? parentNode.mass : null });
    const estimate = radiusEstimate(row);
    const projected = PROJECTED.test(row.discoverymethod ?? '');
    const body = {
      id: `planet:${row.pl_name}`, name: row.pl_name, kind: 'planet', parent: parentId,
      radiusKm: estimate.radius * EARTH_RADIUS_KM, ...planetLook(estimate.radius), exoplanet: true,
      source: archiveLink(row.pl_name), reference: reference(data, row.pl_ref),
      blurb: `Discovered${row.disc_year ? ` in ${row.disc_year}` : ''}${row.discoverymethod ? ` using ${row.discoverymethod.toLowerCase()}` : ''}. ` +
        (row.pl_controv_flag ? 'Its confirmation has been questioned in published literature. ' : '') +
        (row.disc_facility ? `Discovery facility: ${row.disc_facility}.` : ''),
      facts: {
        'Planet radius': measuredText(row, 'pl_rade', 'R⊕'),
        'Planet mass': measuredText(row, 'pl_masse', 'M⊕'),
        'Minimum mass (M sin i)': measuredText(row, 'pl_msinie', 'M⊕'),
        'Orbital period': factText(row, 'pl_orbper', 'days'),
        [projected ? 'Separation / semi-major axis' : 'Semi-major axis']: factText(row, 'pl_orbsmax', 'AU'),
        'Orbits': parentNode ? `${parentNode.name}${parentNode.kind === 'binary' ? ' barycentre' : ''}` : entry.name,
        Eccentricity: factText(row, 'pl_orbeccen'),
        'Archive row updated': row.rowupdate?.slice(0, 10) ?? 'Not reported',
      },
      modelNotes: [...(orbit.notes ?? []), ...(estimate.note ? [estimate.note] : []),
        ...(row.cb_flag === 1 && parentNode?.kind === 'binary' && !orbit.reason ? ['Circumbinary orbit about the stellar pair’s centre of mass. Two-body approximation; precession and stellar perturbations are omitted.'] : []),
        'Colours are illustrative. Orbital phase, orientation, rotation and surface appearance are not measured here.'],
      unmodeled: orbit.reason ?? null,
    };
    if (!orbit.reason) {
      body.orbit = { aAU: orbit.a, e: orbit.e, periodDays: orbit.period, inc: 0,
        nodeLong: 0, periLong: 0, meanLong: hash(row.pl_name) % 360 };
    }
    return body;
  });
  const omitted = planets.filter((b) => !b.orbit);
  const modeled = planets.filter((b) => b.orbit).sort((a, b) => a.orbit.aAU - b.orbit.aAU);
  const bodies = [...stars, ...modeled];

  // Framing radii. Every offset in the scene is a nested sum of compressed
  // distances, wᵢ·C·xᵢ^k (w a star's mass fraction, k the Scale exponent), so
  // a body at most Σ wᵢxᵢ^k from the centre fits in (Σ wᵢxᵢ^k)^(1/k) AU. That
  // is not monotonic in k when the weights are fractions, so it is taken at
  // every step of the Scale setting.
  const terms = new Map();
  for (const node of stellarNodes) terms.set(node.id, [...(terms.get(node.parent) ?? []),
    ...(node.orbit ? [[Math.abs(node.fraction), node.orbit.aAU * (1 + node.orbit.e)]] : [])]);
  const apoapsis = (b) => [1, b.orbit.aAU * (1 + b.orbit.e)];
  const fit = (bodyTerms, body) => Math.max(...EXPONENTS.map((k) =>
    [...bodyTerms, [1, body.radiusKm / AU_KM * 3]].reduce((sum, [w, x]) => sum + w * x ** k, 0) ** (1 / k))) * 1.25;
  const overviewAU = Math.max(...bodies.map((b) => fit(b.kind === 'star' ? terms.get(b.id) ?? []
    : [...(terms.get(b.parent) ?? []), apoapsis(b)], b)));
  // A host whose planets are lost in a wide stellar orbit opens on its own planets.
  const own = modeled.filter((p) => p.parent === starId);
  const hostAU = own.length ? Math.max(...own.map((p) => fit([apoapsis(p)], p))) : 0;
  const home = terms.get(starId)?.length && hostAU && (overviewAU / hostAU) ** SCALE_EXPONENT_RANGE.min > 3
    ? { centreId: starId, radiusAU: hostAU } : null;

  return { id: entry.name, name: entry.name, starId, bodies, allBodies: [...stars, ...planets], omitted, stellarNodes,
    byId: new Map(bodies.map((b) => [b.id, b])), overviewAU, edgeAU: overviewAU * 2, home,
    fetchedAt: data.fetchedAt, isExoplanet: true, entry };
}

/** The NASA host star, from one planet row's stellar solution. */
function nasaStar(entry, host, data, starId) {
  const radius = stellarRadiusEstimate(host);
  const temperature = sourced(host, 'st_teff').value;
  const multiple = entry.stars > 1;
  return {
    id: starId, name: entry.name, kind: 'star', parent: null, exoplanet: true,
    radiusKm: radius.radius * SOLAR_RADIUS_KM, temperature, color: stellarColor(temperature),
    source: archiveLink(entry.name), reference: reference(data, host.st_ref),
    distanceReference: reference(data, entry.planets.find((r) => positive(r.sy_dist))?.dist_ref),
    blurb: planetCount(entry) +
      (multiple ? ` ${entry.stars}-star system. Companion orbital data is incomplete; this view shows the host only.` : ''),
    facts: {
      'Distance from Earth': entry.distance ? `${number(entry.distance * PARSEC_LY)} light-years` : 'Not reported',
      'Spectral type': host.st_spectype ?? (host.c_st_spectype ? `${host.c_st_spectype} (composite table)` : 'Not reported'),
      'Stellar radius': factText(host, 'st_rad', 'R☉'),
      'Stellar mass': factText(host, 'st_mass', 'M☉'),
      'Temperature': factText(host, 'st_teff', 'K'),
    },
    modelNotes: [radius.note,
      'Distance is from the NASA composite table; stellar properties use one published default solution, with labelled composite values only where it has none.',
      'Stellar colour is the colour of a blackbody at the star’s temperature; surface detail is illustrative.'].filter(Boolean),
  };
}
function planetCount(entry) { return `${entry.planets.length} confirmed ${entry.planets.length === 1 ? 'planet' : 'planets'}.`; }
function stellarScore(row) { return ['st_rad', 'st_mass', 'st_teff'].filter((key) => usable(row, key)).length; }
function hash(text) { let n = 0; for (const char of text) n = (Math.imul(n, 31) + char.charCodeAt(0)) >>> 0; return n; }
