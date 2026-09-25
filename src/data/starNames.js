/**
 * Search keys for star names.
 *
 * The NASA archive writes Bayer and Flamsteed names the IAU way: a three-letter
 * Greek abbreviation and constellation ("tau Cet", "eps Eri", "51 Peg"). People
 * type them in full ("Tau Ceti", "Epsilon Eridani", "51 Pegasi"). Both the index
 * and the query go through searchKey(), so either spelling finds the star.
 */

const GREEK = {
  alpha: 'alf', beta: 'bet', gamma: 'gam', delta: 'del', epsilon: 'eps', zeta: 'zet',
  theta: 'tet', iota: 'iot', kappa: 'kap', lambda: 'lam', omicron: 'omi', sigma: 'sig',
  upsilon: 'ups', omega: 'ome',
};

/** Constellation genitives, as they follow a star's letter or number, to IAU abbreviations. */
const GENITIVES = {
  andromedae: 'and', antliae: 'ant', apodis: 'aps', aquarii: 'aqr', aquilae: 'aql', arae: 'ara',
  arietis: 'ari', aurigae: 'aur', bootis: 'boo', caeli: 'cae', camelopardalis: 'cam', cancri: 'cnc',
  'canum venaticorum': 'cvn', 'canis majoris': 'cma', 'canis minoris': 'cmi', capricorni: 'cap',
  carinae: 'car', cassiopeiae: 'cas', centauri: 'cen', cephei: 'cep', ceti: 'cet',
  chamaeleontis: 'cha', circini: 'cir', columbae: 'col', 'comae berenices': 'com',
  'coronae australis': 'cra', 'coronae borealis': 'crb', corvi: 'crv', crateris: 'crt',
  crucis: 'cru', cygni: 'cyg', delphini: 'del', doradus: 'dor', draconis: 'dra', equulei: 'equ',
  eridani: 'eri', fornacis: 'for', geminorum: 'gem', gruis: 'gru', herculis: 'her',
  horologii: 'hor', hydrae: 'hya', hydri: 'hyi', indi: 'ind', lacertae: 'lac', leonis: 'leo',
  'leonis minoris': 'lmi', leporis: 'lep', librae: 'lib', lupi: 'lup', lyncis: 'lyn', lyrae: 'lyr',
  mensae: 'men', microscopii: 'mic', monocerotis: 'mon', muscae: 'mus', normae: 'nor',
  octantis: 'oct', ophiuchi: 'oph', orionis: 'ori', pavonis: 'pav', pegasi: 'peg', persei: 'per',
  phoenicis: 'phe', pictoris: 'pic', 'piscis austrini': 'psa', piscium: 'psc', puppis: 'pup',
  pyxidis: 'pyx', reticuli: 'ret', sagittae: 'sge', sagittarii: 'sgr', scorpii: 'sco',
  sculptoris: 'scl', scuti: 'sct', serpentis: 'ser', sextantis: 'sex', tauri: 'tau',
  telescopii: 'tel', trianguli: 'tri', 'trianguli australis': 'tra', tucanae: 'tuc',
  'ursae majoris': 'uma', 'ursae minoris': 'umi', velorum: 'vel', virginis: 'vir',
  volantis: 'vol', vulpeculae: 'vul',
};

// Longest first, so "leonis minoris" is not read as "leonis" and a stray "minoris".
const WORDS = { ...GREEK, ...GENITIVES };
const PATTERN = new RegExp(
  `\\b(${Object.keys(WORDS).sort((a, b) => b.length - a.length).map((w) => w.replace(' ', '\\s+')).join('|')})\\b`,
  'g'
);

/** Lower case, accents dropped, whitespace collapsed, and full names abbreviated as NASA writes them. */
export function searchKey(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\s+/g, ' ').trim()
    .replace(PATTERN, (word) => WORDS[word.replace(/\s+/g, ' ')]);
}
