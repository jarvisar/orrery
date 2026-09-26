/**
 * The exoplanet model, importers and refresh. Named systems (Kepler-16,
 * Proxima Cen...) are checked against the committed catalogues, so CI is
 * repeatable; the weekly refresh is checked by the data-independent
 * `npm run exoplanets:verify` instead, which new discoveries cannot break.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateCatalogue, normalizeRows, catalogueFromArchive, groupSystems, makeSystem, orbitModel, radiusEstimate,
  stellarRadiusEstimate, stellarMass, stellarColor, measuredText, parseReference, reference, archiveQuery,
} from '../src/data/exoplanets.js';
import { searchKey } from '../src/data/starNames.js';
import { ExoplanetCatalogue } from '../src/core/ExoplanetCatalogue.js';
import { eccentricAnomaly } from '../src/sim/kepler.js';
import { validateStellarCatalogue, stellarLayout, stellarMassEstimate, starsShown } from '../src/data/stellarSystems.js';
import { stellarPositions } from '../src/sim/stellar.js';
import { heliocentricDistance, SCALE_EXPONENT_RANGE } from '../src/scene/scaling.js';
import { parseXml, convertSystems } from './update-stellar-systems.js';
import { verifyModels } from './lib/exoplanet-checks.js';

const data = validateCatalogue(JSON.parse(await readFile(new URL('../public/data/exoplanets.json', import.meta.url))));
const supplement = validateStellarCatalogue(JSON.parse(await readFile(new URL('../public/data/stellar-systems.json', import.meta.url))));
const entries = groupSystems(data);
const model = (name) => makeSystem(entries.find((s) => s.name === name), data, supplement);
const EXPONENTS = [SCALE_EXPONENT_RANGE.min, 0.5, SCALE_EXPONENT_RANGE.default, 0.6, SCALE_EXPONENT_RANGE.max];

/** An archive row as TAP returns it: every column present, nulls included. */
const raw = (fields) => ({ hostname: 'Test', pl_name: 'Test b', pl_refname: null, st_refname: null, sy_dist_reflink: null,
  pl_orbper: null, pl_orbperlim: null, st_mass: null, st_masslim: null, c_st_mass: null, c_st_masslim: null, ...fields });

test('every committed system builds a finite model that keeps all of its planets', () => {
  assert.equal(verifyModels(data, supplement), entries.length);
  // Almost every planet can be drawn from what the archive publishes.
  const omitted = entries.reduce((n, e) => n + makeSystem(e, data, supplement).omitted.length, 0);
  assert.ok(omitted < data.rows.length * 0.02, `${omitted} planets without an orbit`);
});

test('rows are stored compactly: no nulls or zero flags, shared citations, safe links only', () => {
  const { refs, rows } = normalizeRows([
    raw({ pl_orbper: 3, pl_orbperlim: 0, cb_flag: 0, pl_controv_flag: 0,
      pl_refname: '<a refstr=X href=https://example.org/?a=1&amp;b=2 target=ref>Paper &amp; co</a>',
      st_refname: '<a refstr=X href=https://example.org/?a=1&amp;b=2 target=ref>Paper &amp; co</a>' }),
    raw({ pl_name: 'Test c', pl_refname: '<a href="javascript:alert(1)">Unsafe</a>' }),
  ]);
  assert.deepEqual(rows[0], { hostname: 'Test', pl_name: 'Test b', pl_orbper: 3, pl_ref: 0, st_ref: 0 });
  assert.deepEqual(refs, [['Paper & co', 'https://example.org/?a=1&b=2'], ['Unsafe']]);
  assert.equal(reference({ refs }, 1).href, undefined);
  assert.equal(parseReference('<a href="https://example.org/paper">A citation</a>').label, 'A citation');
  assert.equal(parseReference('Plain citation').href, undefined);
});

test('composite values fill only the gaps the default solution leaves, never limits or duplicates', () => {
  const [filled, kept, bounded] = normalizeRows([
    raw({ c_st_mass: 1.3, c_st_masslim: 0 }),
    raw({ pl_name: 'Test c', st_mass: 0.9, c_st_mass: 1.3, c_st_masslim: 0 }),
    raw({ pl_name: 'Test d', c_st_mass: 1.3, c_st_masslim: 1 }),
  ]).rows;
  assert.equal(filled.c_st_mass, 1.3);
  assert.equal(kept.c_st_mass, undefined);
  assert.equal(bounded.c_st_mass, undefined);
  assert.match(stellarMass(filled).note, /composite table/);
  assert.equal(stellarMass(kept).note, null);
});

test('malformed catalogues are rejected', () => {
  assert.throws(() => validateCatalogue({ ...data, rows: [data.rows[0], data.rows[0]] }));
  assert.throws(() => validateCatalogue({ ...data, rows: [{ ...data.rows[0], pl_rade: '12' }] }));
  assert.throws(() => validateCatalogue({ ...data, rows: [{ ...data.rows[0], pl_ref: data.refs.length }] }));
  assert.throws(() => validateCatalogue({ ...data, rows: [{ ...data.rows[0], unexpected: 1 }] }));
  assert.throws(() => validateCatalogue({ ...data, refs: [['Label', 'javascript:alert(1)']] }));
  assert.throws(() => validateCatalogue({ ...data, schemaVersion: 1 }), 'an older format is replaced, not misread');
});

test('Kepler estimates use stellar mass, and limits are never treated as measured orbits', () => {
  const earth = orbitModel({ pl_orbper: 365.25, st_mass: 1 });
  assert.equal(earth.a, 1);
  assert.equal(earth.e, 0);
  assert.equal(earth.notes.length, 2);
  assert.equal(orbitModel({ pl_orbsmax: 1, st_mass: 1 }).period, 365.25);
  assert.ok(orbitModel({ pl_orbsmax: 1, pl_orbsmaxlim: 1, st_mass: 1 }).reason);
  assert.ok(orbitModel({ pl_orbper: 1e300, st_mass: 1e300 }).reason);
  assert.ok(orbitModel({ pl_orbper: 10 }).reason, 'no period without the mass to go with it');
});

test('projected separations, gravity masses and composite periods are used, and always labelled', () => {
  const imaged = orbitModel({ discoverymethod: 'Imaging', pl_orbsmax: 50, st_mass: 1 });
  assert.equal(imaged.a, 50);
  assert.match(imaged.notes.join(' '), /projected on the sky/);
  // With a period, an imaged planet's semi-major axis came from an orbit fit and is used as is.
  const fitted = orbitModel({ discoverymethod: 'Imaging', pl_orbsmax: 10.4, pl_orbper: 9100, st_mass: 1.75 });
  assert.equal(fitted.a, 10.4);
  assert.ok(!fitted.notes.some((n) => /projected/.test(n)));
  assert.match(orbitModel({ discoverymethod: 'Microlensing', pl_orbsmax: 3 }).reason, /stellar mass is unknown/);

  const gravity = orbitModel({ pl_orbper: 365.25, st_logg: Math.log10(27420), st_rad: 1 });
  assert.ok(Math.abs(gravity.a - 1) < 1e-9);
  assert.match(gravity.notes.join(' '), /surface gravity/);
  assert.ok(!orbitModel({ pl_orbper: 365.25, st_logg: 9, st_rad: 50 }).a, 'implausible gravity masses are refused');

  const composite = orbitModel({ c_pl_orbper: 365.25, st_mass: 1 });
  assert.equal(composite.period, 365.25);
  assert.match(composite.notes[0], /composite table/);
});

test('circumbinary orbits use the pair’s total mass, or a reported orbit when the pair is unknown', () => {
  assert.ok(orbitModel({ cb_flag: 1, pl_orbper: 365.25 }, { binaryMass: 2 }).a > 1.25);
  assert.match(orbitModel({ cb_flag: 1, pl_orbper: 100 }).reason, /cannot be reconstructed/);
  const reported = orbitModel({ cb_flag: 1, pl_orbper: 100, pl_orbsmax: 0.5 });
  assert.equal(reported.a, 0.5);
  assert.match(reported.notes.join(' '), /centre of mass/);
});

test('reported radii win; missing radii use the published mass fit and identify minimum-mass proxies', () => {
  assert.equal(radiusEstimate({ pl_rade: 2, pl_masse: 1 }).radius, 2);
  assert.ok(Math.abs(radiusEstimate({ pl_masse: 1 }).radius - 1.008) < 0.001);
  // NASA's coefficients: R = 10^C · M^S by regime (docs/pscp_calc.html).
  assert.ok(Math.abs(radiusEstimate({ pl_masse: 10 }).radius - 10 ** -0.0925 * 10 ** 0.589) < 1e-9);
  assert.ok(Math.abs(radiusEstimate({ pl_masse: 318 }).radius - 10 ** 1.25 * 318 ** -0.044) < 1e-9);
  assert.match(radiusEstimate({ pl_msinie: 1 }).note, /minimum mass/);
  assert.match(radiusEstimate({ pl_rade: 3, pl_radelim: 1 }).note, /placeholder/);
  assert.match(measuredText({ pl_masse: 3, pl_masselim: 1 }, 'pl_masse'), /^< /);
  assert.match(measuredText({ pl_orbper: 2.421937, pl_orbpererr1: 1e-7, pl_orbpererr2: -1e-7 }, 'pl_orbper'), /2\.421937.*1\.00e-7/);
});

test('stellar estimates use luminosity or gravity; compact hosts are handled', () => {
  assert.equal(stellarRadiusEstimate({ st_lum: 0, st_teff: 5772 }).radius, 1);
  assert.ok(Math.abs(stellarRadiusEstimate({ st_mass: 1, st_logg: Math.log10(27420) }).radius - 1) < 1e-10);
  assert.ok(Number.isFinite(stellarRadiusEstimate({ st_lum: 1000, st_teff: 1 }).radius));
  assert.ok(Math.abs(stellarRadiusEstimate({ hostname: 'PSR B1257+12' }).radius * 695700 - 12) < 1e-10);
  assert.equal(model('WD 1856+534').bodies[0].radiusKm, 0.0131 * 695700);
});

test('star colours follow the blackbody at each temperature', () => {
  const rgb = (t) => stellarColor(t).match(/\w\w/g).map((h) => parseInt(h, 16));
  const [cool, sun, hot] = [rgb(3000), rgb(5772), rgb(10000)];
  assert.ok(cool[0] === 255 && cool[2] < 130, 'an M dwarf is orange');
  assert.ok(sun.every((c) => c > 225), 'the Sun is nearly white');
  assert.ok(hot[2] === 255 && hot[0] < 225, 'an A star is blue-white');
  assert.equal(stellarColor(NaN), stellarColor(undefined));
});

test('binary, triple and partial quadruple hierarchies preserve the correct planet hosts', () => {
  const binary = model('Kepler-16');
  assert.equal(binary.bodies.filter((b) => b.kind === 'star').length, 2);
  assert.equal(binary.omitted.length, 0);
  assert.match(binary.byId.get('planet:Kepler-16 b').parent, /^barycentre:/);
  assert.match(binary.byId.get(binary.starId).blurb, /^1 confirmed planet\./);
  const triple = model('Proxima Cen');
  assert.equal(triple.bodies.filter((b) => b.kind === 'star').length, 3);
  assert.equal(triple.byId.get('planet:Proxima Cen b').parent, triple.starId);
  assert.equal(triple.byId.get('planet:Proxima Cen d').parent, triple.starId);
  assert.ok(!triple.allBodies.some((b) => /Centauri B b|Proxima.* c$/.test(b.name)), 'OEC cannot admit planets absent from NASA');
  // The planets' own host keeps NASA's measurements and citation.
  assert.equal(triple.byId.get(triple.starId).source, 'https://exoplanetarchive.ipac.caltech.edu/overview/Proxima%20Cen');
  assert.match(triple.byId.get(triple.starId).facts['Stellar mass'], /\(\+/);
  const quadruple = model('PH1');
  assert.equal(quadruple.bodies.filter((b) => b.kind === 'star').length, 2);
  assert.match(quadruple.bodies[0].blurb, /PH-1 Ba and PH-1 Bb aren’t shown because their orbits aren’t known/);
  assert.match(quadruple.byId.get('planet:PH1 b').parent, /^barycentre:/);
  const incomplete = model('Kepler-444');
  assert.equal(incomplete.bodies.filter((b) => b.kind === 'star').length, 1, 'an upper bound is not a measured stellar orbit');
  assert.match(incomplete.bodies[0].blurb, /Kepler-444 B/);
});

test('wide pairs with only a separation on the sky are drawn at that separation, and say so', () => {
  const cygnus = model('16 Cyg B');
  assert.equal(cygnus.bodies.filter((b) => b.kind === 'star').length, 3);
  assert.equal(cygnus.companions.hidden, 0);
  assert.match(cygnus.byId.get(cygnus.starId).modelNotes.join(' '), /separation on the sky is known \(837 AU\)/);
  // Arcseconds become AU at NASA's distance: 1″ at 1 pc is 1 AU.
  const entry = { name: 'Pair A', stars: 2, distance: 20, planets: [{ pl_name: 'Pair A b', hostname: 'Pair A', st_mass: 1 }] };
  const supplement = { fetchedAt: '2026-01-01T00:00:00Z', systems: [{ name: 'Pair', tree: { kind: 'binary', names: [], planets: [], values: { sep_arcsec: 3, sep_arcseclim: 0 }, children: [
    { kind: 'star', names: ['Pair A'], planets: [['Pair A b']], values: {}, children: [] },
    { kind: 'star', names: ['Pair B'], planets: [], values: { st_spectype: 'M3V' }, children: [] },
  ] } }] };
  const layout = stellarLayout(entry, { rows: entry.planets }, supplement);
  const orbit = layout.nodes.find((n) => n.name === 'Pair B').orbit;
  assert.equal(orbit.aAU, 60);
  assert.ok(Math.abs(orbit.periodDays / 365.25 - Math.sqrt(60 ** 3 / 1.37)) < 1e-6, 'Kepler with NASA’s host mass and the estimated companion');
  assert.match(layout.nodes.find((n) => n.name === 'Pair B').massNote, /spectral type \(M3V\)/);
});

test('companion masses are estimated only for main-sequence stars and white dwarfs', () => {
  assert.deepEqual(stellarMassEstimate({ st_mass: 0.8 }), { mass: 0.8, note: null });
  assert.ok(Math.abs(stellarMassEstimate({ st_teff: 5770 }).mass - 1) < 1e-9);
  assert.ok(Math.abs(stellarMassEstimate({ st_spectype: 'M3V' }).mass - 0.37) < 1e-9);
  // K8 is a third of the way from K7 (0.64 M☉) to M0 (0.57 M☉), interpolated in log mass.
  assert.ok(Math.abs(stellarMassEstimate({ st_spectype: 'K8' }).mass - 0.64 ** (2 / 3) * 0.57 ** (1 / 3)) < 1e-9);
  assert.equal(stellarMassEstimate({ st_spectype: 'DA', st_teff: 9000 }).mass, 0.6);
  assert.equal(stellarMassEstimate({ st_spectype: 'K0 III', st_teff: 4800 }).mass, null, 'giants are not guessed');
  assert.equal(stellarMassEstimate({ st_teff: 1500 }).mass, null, 'nor brown dwarfs');
});

test('NASA decides what is a star; a supplement listing fewer is drawn with the rest counted', () => {
  // OEC counts HD 41004 B b, a brown dwarf the archive lists as a planet, as a star.
  const extra = model('HD 41004 A');
  assert.equal(extra.bodies.filter((b) => b.kind === 'star').length, 1);
  // OEC knows two of WASP-14's three stars.
  const fewer = model('WASP-14');
  assert.deepEqual([fewer.companions.shown, fewer.companions.listed, fewer.companions.names.length], [2, 3, 0]);
  assert.match(fewer.bodies[0].blurb, /1 companion star isn’t shown because its orbit isn’t known/);
  assert.equal(fewer.bodies[0].facts['Stars shown'], '2 of 3');
  const hostOnly = model('Kepler-444');
  assert.equal(hostOnly.bodies[0].facts['Stars shown'], '1 of 3');
  assert.equal(starsShown(entries.find((e) => e.name === 'Kepler-444'), data, supplement), 1);
  assert.equal(starsShown(entries.find((e) => e.name === '16 Cyg B'), data, supplement), 3);
});

test('stellar orbits trust the period when the catalogue’s size disagrees with it', () => {
  // OEC gives one star's orbit about the centre of mass as the pair's; Welsh et al. (2012) give 0.2288 AU.
  const kepler34 = model('Kepler-34');
  const a = kepler34.bodies.find((b) => b.kind === 'star' && b.orbit).orbit.aAU;
  assert.ok(Math.abs(a - 0.2288) < 0.001, `${a}`);
  // Gliese 667 AB's 42.15-year orbit, entered in days, is corrected on import while the slip stands.
  const gliese = model('GJ 667 C').bodies.find((b) => b.name === 'Gliese 667 A');
  assert.ok(Math.abs(gliese.orbit.periodDays / 365.25 - 42.15) < 0.01);
});

test('planets around different stars stay attached to their own host, which leads its own system', () => {
  for (const [name, own] of [['HD 133131 A', 'HD 133131 A b'], ['HD 133131 B', 'HD 133131 B b']]) {
    const system = model(name);
    assert.equal(system.byId.get(`planet:${own}`).parent, system.starId, `${name} is centred on its own star`);
    assert.equal(system.bodies[0].id, system.starId);
    assert.notEqual(system.byId.get('planet:HD 133131 A b').parent, system.byId.get('planet:HD 133131 B b').parent);
    assert.equal(system.allBodies.filter((b) => b.kind === 'planet').length, 3);
  }
  assert.equal(model('Kepler-47').bodies.filter((b) => b.kind === 'planet').length, 3);
});

test('a host whose planets are lost in a wide stellar orbit opens on its own planets', () => {
  const proxima = model('Proxima Cen');
  assert.equal(proxima.home.centreId, proxima.starId);
  assert.ok(proxima.home.radiusAU < 1 && proxima.overviewAU > 1000);
  assert.equal(model('Kepler-16').home, null, 'circumbinary planets are framed from the barycentre');
  assert.equal(model('TRAPPIST-1').home, null);
});

test('binary mass fractions keep every nested centre of mass fixed, inside the overview at every Scale', () => {
  for (const name of ['Kepler-16', 'Proxima Cen', 'PH1', 'GJ 414 A']) {
    const system = model(name);
    for (const exponent of EXPONENTS) for (const day of [-100000, 0, 100000]) {
      const positions = stellarPositions(system.stellarNodes, day, (a) => heliocentricDistance(a, exponent));
      for (const node of system.stellarNodes.filter((n) => n.kind === 'binary')) {
        const children = system.stellarNodes.filter((n) => n.parent === node.id);
        assert.equal(children.length, 2);
        for (const axis of ['x', 'y', 'z']) {
          const centre = children.reduce((sum, n) => sum + positions.get(n.id)[axis] * n.mass, 0) / node.mass;
          assert.ok(Math.abs(centre - positions.get(node.id)[axis]) < 1e-7, `${name} ${axis}`);
        }
      }
      // No companion may leave the frame, even at the largest Scale.
      const bound = heliocentricDistance(system.overviewAU, exponent);
      for (const point of positions.values()) assert.ok(Math.hypot(point.x, point.y, point.z) < bound, `${name} at ${exponent}`);
    }
  }
});

test('high eccentricities satisfy Kepler’s equation on both sides of periapsis and in reverse time', () => {
  for (const e of [0, 0.8, 0.95, 0.999, 0.999999]) {
    for (const m of [-Math.PI, -2, -0.1, -1e-8, 0, 1e-8, 0.1, 2, Math.PI]) {
      const E = eccentricAnomaly(m, e);
      const expected = m === -Math.PI ? Math.PI : m;
      assert.ok(Math.abs(E - e * Math.sin(E) - expected) < 1e-12, `${m}, ${e}`);
    }
  }
});

test('search finds stars by their full names as well as the archive’s abbreviations', () => {
  const find = (text) => entries.filter((s) => s.searchable.includes(searchKey(text))).map((s) => s.name);
  assert.equal(searchKey('Tau Ceti'), 'tau cet');
  assert.equal(searchKey('Epsilon  Eridani'), 'eps eri');
  assert.equal(searchKey('Upsilon Andromedae'), 'ups and');
  assert.equal(searchKey('Rho Coronae Borealis'), 'rho crb');
  assert.equal(searchKey('Alpha Boötis'), 'alf boo');
  assert.equal(searchKey('Kepler-16'), 'kepler-16');
  assert.ok(find('Proxima Centauri').includes('Proxima Cen'));
  assert.ok(find('51 Pegasi').includes('51 Peg'));
  assert.ok(find('tau cet').includes('tau Cet'));
});

test('the companion importer reads the catalogue’s XML strictly', () => {
  const tree = parseXml('<?xml version="1.0"?><a x="1 &amp; 2"><!-- note --><b>T &lt; 5</b><c/></a>');
  assert.equal(tree.children[0].attrs.x, '1 & 2');
  assert.equal(tree.children[0].children[0].text, 'T < 5');
  assert.equal(tree.children[0].children[1].tag, 'c');
  assert.throws(() => parseXml('<a><b></a></b>'), /Mismatched/);
  assert.throws(() => parseXml('<a>&nbsp;</a>'), /entity/);
  assert.throws(() => parseXml('<a><b>'), /Unclosed/);

  const { systems, skipped } = convertSystems(`<systems>
    <system><name>Pair</name><binary>
      <semimajoraxis errorplus="0.1" errorminus="0.2">20</semimajoraxis><period>notanumber</period>
      <star><name>Pair A</name><mass>1.1</mass><temperature upperlimit="6000"/><planet><name>Pair A b</name></planet></star>
      <star><name>Pair B</name><mass>0.5</mass><spectraltype> M2 V </spectraltype></star>
    </binary></system>
    <system><name>Broken</name><binary><star><name>Only one</name></star></binary></system>
    <system><name>Single</name><star><name>Single</name></star></system>
  </systems>`);
  assert.deepEqual(skipped.map((s) => s.split(' ')[0]), ['Broken']);
  assert.equal(systems.length, 1);
  const [a, b] = systems[0].tree.children;
  assert.deepEqual(systems[0].tree.values, { pl_orbsmax: 20, pl_orbsmaxlim: 0, pl_orbsmaxerr1: 0.1, pl_orbsmaxerr2: -0.2 });
  assert.deepEqual(a.values, { st_mass: 1.1, st_masslim: 0, st_teff: 6000, st_tefflim: 1 });
  assert.deepEqual(a.planets, [['Pair A b']]);
  assert.equal(b.values.st_spectype, 'M2 V');
  assert.throws(() => validateStellarCatalogue({ ...supplement, systems: [{ name: 'bad', tree: { kind: 'binary' } }] }));

  // Separations are kept by unit, and a known slip is fixed only while it stands.
  const gliese = (period) => convertSystems(`<systems><system><name>Gliese 667</name><binary>
    <separation unit="arcsec">32.70</separation><separation errorplus="3" errorminus="3" unit="AU">228</separation>
    <binary><period>${period}</period><star><name>Gliese 667 A</name></star><star><name>Gliese 667 B</name></star></binary>
    <star><name>Gliese 667 C</name></star></binary></system></systems>`).systems[0].tree;
  const outer = gliese(42.15);
  assert.deepEqual(outer.values, { sep_au: 228, sep_aulim: 0, sep_auerr1: 3, sep_auerr2: -3, sep_arcsec: 32.7, sep_arcseclim: 0 });
  assert.equal(outer.children[0].values.pl_orbper, 42.15 * 365.25);
  assert.equal(gliese(15395).children[0].values.pl_orbper, 15395, 'an upstream fix is left alone');
});

test('TAP range cursors escape names', () => {
  assert.match(archiveQuery({ first: "Test's planet", last: 'Z' }), /Test''s planet/);
  assert.match(archiveQuery(), /c\.st_mass as c_st_mass/);
  const trappist = entries.find((s) => s.name === 'TRAPPIST-1');
  assert.ok(trappist.distance > 10 && trappist.distance < 15, 'composite host distance is available');
});

/* --- the in-browser catalogue ---------------------------------------------- */

/** Stored rows back into the shape the archive sends, citations and all. */
const archiveRows = data.rows.map(({ pl_ref, st_ref, dist_ref, ...row }) => ({ ...row,
  pl_refname: pl_ref === undefined ? null : `<a href=${data.refs[pl_ref][1] ?? ''}>${data.refs[pl_ref][0]}</a>` }));

test('initial load cannot overwrite a newer in-flight refresh result', async () => {
  let finish;
  const service = new ExoplanetCatalogue({ storage: { read: () => new Promise((resolve) => { finish = resolve; }) },
    fetcher: async () => { throw new Error('offline'); } });
  const loading = service.load();
  const newer = { ...data, fetchedAt: '2030-01-01T00:00:00Z' };
  service.accept(newer);
  finish(data);
  await loading;
  assert.equal(service.data, newer);
});

test('a saved copy the shipped one has overtaken, or in an older format, is cleared', async () => {
  for (const saved of [{ ...data, fetchedAt: '2001-01-01T00:00:00Z' }, { schemaVersion: 1, fetchedAt: data.fetchedAt, rows: [] }]) {
    let cleared = false;
    const service = new ExoplanetCatalogue({
      storage: { read: async () => saved, clear: async () => { cleared = true; } },
      fetcher: async () => ({ ok: true, json: async () => data }),
    });
    await service.load();
    assert.equal(service.data, data);
    assert.ok(cleared);
  }
});

test('only a catalogue older than a week is refreshed on its own', async () => {
  const service = new ExoplanetCatalogue({ storage: { read: async () => null } });
  service.accept({ ...data, fetchedAt: new Date(Date.now() - 3 * 86400e3).toISOString() });
  assert.equal(service.stale, false);
  service.accept({ ...data, fetchedAt: new Date(Date.now() - 8 * 86400e3).toISOString() });
  assert.equal(service.stale, true);
});

test('cached data stays available when a live refresh fails, and failed refreshes can be retried', async () => {
  let calls = 0;
  const service = new ExoplanetCatalogue({ storage: { read: async () => data, write: async () => {} },
    fetcher: async () => { calls++; throw new Error('offline'); } });
  await service.load();
  assert.equal(service.data.fetchedAt, data.fetchedAt);
  assert.equal(await service.refresh(), false);
  assert.equal(await service.refresh(), false);
  assert.equal(calls, 3);
  assert.equal(service.data, data);
  assert.match(service.status, /keeping the saved/);
});

test('live pages are normalized, validated and committed only after the complete refresh; duplicate calls share one request', async () => {
  let saved, calls = 0;
  const service = new ExoplanetCatalogue({ storage: { write: async (value) => { saved = value; } },
    fetcher: async (_url, options) => {
      assert.ok(options.headers['Target-URL'].startsWith('https://exoplanetarchive.ipac.caltech.edu/'));
      if (!new URL(options.headers['Target-URL']).searchParams.get('query').includes('join')) {
        return { ok: true, json: async () => archiveRows.map((r) => ({ pl_name: r.pl_name })) };
      }
      const batch = archiveRows.slice(calls * 700, ++calls * 700);
      return { ok: true, json: async () => batch };
    } });
  const first = service.refresh(), second = service.refresh();
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.equal(saved.rows.length, data.rows.length);
  assert.equal(calls, Math.ceil(data.rows.length / 700));
  // The same shape as the importer writes.
  assert.deepEqual(saved.rows[0], catalogueFromArchive(archiveRows).rows[0]);
  assert.ok(saved.refs.length > 100);
});

test('a link to an unknown system costs one small query, not a whole refresh', async () => {
  const queries = [];
  const service = new ExoplanetCatalogue({ fetcher: async (_url, options) => {
    const query = new URL(options.headers['Target-URL']).searchParams.get('query');
    queries.push(query);
    return { ok: true, json: async () => (query.includes("'New Star'") ? [{ hostname: 'New Star' }] : []) };
  } });
  assert.equal(await service.hasHost('New Star'), true);
  assert.equal(await service.hasHost("Typo's star"), false);
  assert.equal(await service.hasHost('x'.repeat(500)), false);
  assert.equal(queries.length, 2);
  assert.match(queries[1], /'Typo''s star'/);
  const offline = new ExoplanetCatalogue({ fetcher: async () => { throw new Error('offline'); } });
  assert.equal(await offline.hasHost('New Star'), false);
});

test('partial or malformed refreshes cannot overwrite the previous good copy', async () => {
  const service = new ExoplanetCatalogue({ storage: { write: async () => assert.fail('must not write') },
    fetcher: async () => ({ ok: true, json: async () => archiveRows.slice(0, 15) }) });
  service.accept(data);
  assert.equal(await service.refresh(), false);
  assert.equal(service.data, data);
});

test('a missing planet in a range aborts the entire refresh', async () => {
  const service = new ExoplanetCatalogue({ storage: { write: async () => assert.fail('must not write') },
    fetcher: async (_url, options) => ({ ok: true, json: async () =>
      new URL(options.headers['Target-URL']).searchParams.get('query').includes('join')
        ? archiveRows.slice(0, 699) : archiveRows.map((r) => ({ pl_name: r.pl_name })) }) });
  service.accept(data);
  assert.equal(await service.refresh(), false);
  assert.match(service.lastError.message, /Archive changed/);
  assert.equal(service.data, data);
});
