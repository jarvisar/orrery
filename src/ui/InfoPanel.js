/**
 * Facts about whatever is currently in focus.
 *
 * A static block from the catalogue, and a live block recomputed a few times a
 * second from the same Keplerian state that positions the body, so the panel
 * and the scene cannot disagree.
 *
 * The orbit map is a top-down plan of the body's orbit and its nearest
 * neighbours', to scale. The bright arc is the ground covered since periapsis.
 */

import { el, icon, formatKm } from './dom.js';
import { AU_KM } from '../data/bodies.js';
import { SOLAR_SYSTEM } from '../data/systems.js';
import { orbitalPosition, eccentricAnomaly, perifocalToWorld } from '../sim/kepler.js';

export const KIND_LABEL = {
  star: 'Star',
  planet: 'Planet',
  dwarf: 'Dwarf planet',
  moon: 'Moon',
  visitor: 'Uncatalogued',
};

const LIGHT_KM_S = 299_792.458;

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP = { width: 256, height: 132, pad: 9, samples: 128 };

const _now = { x: 0, y: 0, z: 0 };
const _soon = { x: 0, y: 0, z: 0 };
const _earth = { x: 0, y: 0, z: 0 };
const _parent = { x: 0, y: 0, z: 0 };
const _point = { x: 0, y: 0, z: 0 };

export class InfoPanel {
  /**
   * @param {object} options
   * @param {boolean} [options.collapsed]
   * @param {(id: string) => void} [options.onSelect] Called from the system links.
   * @param {(id: string) => boolean} [options.isVisible] Hides links to hidden bodies.
   * @param {(id: string) => object|undefined} [options.elementsOf] Scene elements
   *   by id, for the map and for where Earth is.
   */
  constructor({
    catalogue = SOLAR_SYSTEM, collapsed = false, onSelect = () => {}, isVisible = () => true, elementsOf = () => undefined,
  } = {}) {
    this.catalogue = catalogue;
    this.onSelect = onSelect;
    this.isVisible = isVisible;
    this.elementsOf = elementsOf;

    this.title = el('h2', { class: 'info__title', text: 'Sun' });
    this.kind = el('div', { class: 'info__kind' });
    this.toggleIcon = el('span', { class: 'info__toggle' }, [icon('chevron', 16)]);

    this.blurb = el('p', { class: 'info__blurb' });
    this.diagram = el('div', { class: 'info__diagram', 'aria-hidden': 'true' });
    this.live = el('div', { class: 'info__live' });
    this.facts = el('dl', { class: 'info__facts' });
    this.system = el('div', { class: 'info__system' });
    this.provenance = el('div', { class: 'info__provenance' });
    this.body = el('div', { class: 'info__body' }, [
      this.blurb, this.diagram, this.live, this.facts, this.system, this.provenance,
    ]);

    this.header = el(
      'button',
      {
        class: 'info__header',
        type: 'button',
        'aria-expanded': String(!collapsed),
        onclick: () => this.setCollapsed(!this.collapsed),
      },
      [el('div', { class: 'info__heading' }, [this.title]), this.toggleIcon]
    );

    this.root = el('aside', { class: 'info panel', 'aria-label': 'Body information' }, [
      this.header,
      this.kind,
      this.body,
    ]);

    this.collapsed = false;
    this.setCollapsed(collapsed);
    this._view = null;
    this._diagramParts = null;
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.root.classList.toggle('is-collapsed', collapsed);
    this.header.setAttribute('aria-expanded', String(!collapsed));
  }

  /** @param {import('../scene/SolarSystem.js').BodyView|null} view */
  show(view) {
    this._view = view;
    if (!view) {
      this.root.hidden = true;
      return;
    }

    this.root.hidden = false;
    const body = view.body;

    this.title.textContent = body.name;
    this.root.style.setProperty('--body-color', body.color ?? '#ffffff');
    this.kind.replaceChildren(...this._describeKind(body));
    this.blurb.textContent = body.blurb ?? '';

    this.facts.replaceChildren(
      ...Object.entries(body.facts ?? {}).map(([term, value]) =>
        el('div', { class: 'info__fact' }, [
          el('dt', { text: term }),
          el('dd', {}, withSuperscripts(value)),
        ])
      )
    );

    this._buildDiagram(view);
    this._buildSystem(body);
    this._buildProvenance(body);
    this.live.replaceChildren();
    this._liveRows = null;
    this.body.scrollTop = 0;
  }

  _buildProvenance(body) {
    this.provenance.replaceChildren();
    if (!body.exoplanet) return;
    const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', text });
    this.provenance.append(...[
      el('h3', { class: 'section-title', text: 'About this model' }),
      ...body.modelNotes.map((text) => el('p', { text })),
      el('p', { text: 'Orbits share an illustrative plane; their orientation and phase do not predict transits or the positions on the date shown. The background sky is the view from Earth.' }),
      link(body.source, `${body.sourceName ?? 'NASA archive & published measurements'} ↗`),
      body.reference ? el('p', {}, [body.reference.href ? link(body.reference.href, body.reference.label) : body.reference.label])
        : el('p', { text: body.sourceName ? 'Publication references are recorded in the source file history.' : 'Reference available in the archive.' }),
      body.distanceReference?.href && el('p', {}, [link(body.distanceReference.href, `Distance: ${body.distanceReference.label}`)]),
      body.appearanceReference && el('p', {}, [link(body.appearanceReference.href, `Appearance: ${body.appearanceReference.label}`)]),
      body.diskReference && el('p', {}, [link(body.diskReference.href, `Disk: ${body.diskReference.label}`)]),
      body.companionSource && el('p', {}, [link(body.companionSource, 'Stellar hierarchy: Open Exoplanet Catalogue ↗')]),
      el('p', { text: `${body.sourceName ?? 'NASA default solution'} · retrieved ${(body.sourceDate ?? this.catalogue.fetchedAt).slice(0, 10)} (UTC). Quoted errors and limits are from the source.` }),
    ].filter(Boolean));
  }

  _buildExoplanetLinks(body) {
    // Stars NASA lists that cannot be placed: named where the supplement knows them.
    const { hidden = 0, names = [] } = this.catalogue.companions ?? {};
    const others = hidden - names.length;
    const missing = [...names, ...(others ? [`${others} ${names.length ? 'other ' : ''}companion ${others === 1 ? 'star' : 'stars'}`] : [])];
    this.system.replaceChildren(...[
      el('h3', { class: 'section-title', text: `${this.catalogue.name} system` }),
      el('div', { class: 'chips' }, this.catalogue.bodies.map((member) => el('button', {
        class: 'chip', type: 'button', 'aria-current': member.id === body.id ? 'true' : null,
        text: member.name, onclick: () => this.onSelect(member.id),
      }))),
      hidden && el('p', { class: 'info__hidden-stars', text: `Not shown: ${missing.join(', ')}, ${hidden === 1 ? 'orbit' : 'orbits'} unknown.` }),
      ...this.catalogue.omitted.map((member) => el('details', { class: 'info__unmodeled' }, [
        el('summary', { text: `${member.name} · orbit unavailable` }),
        el('p', { text: member.unmodeled }),
        el('p', { text: member.blurb }),
        el('dl', { class: 'info__facts' }, Object.entries(member.facts).map(([key, value]) =>
          el('div', { class: 'info__fact' }, [el('dt', { text: key }), el('dd', { text: value })]))),
        el('a', { href: member.source, target: '_blank', rel: 'noopener', text: 'Published measurements ↗' }),
      ])),
    ].filter(Boolean));
  }

  /** Re-checks which links and neighbours to show, after a visibility setting changes. */
  refreshSystem() {
    if (!this._view) return;
    this._buildSystem(this._view.body);
    this._buildDiagram(this._view);
  }

  _describeKind(body) {
    if (body.kind === 'moon' && body.parent) {
      const parent = this.catalogue.byId.get(body.parent);
      return [
        'Moon of ',
        el('button', {
          class: 'info__link',
          type: 'button',
          text: parent?.name ?? '',
          onclick: () => this.onSelect(body.parent),
        }),
      ];
    }
    if (body.exoplanet && body.kind === 'planet') {
      const host = this.catalogue.byId.get(body.parent);
      if (!host) return ['Circumbinary exoplanet'];
      return ['Exoplanet of ', el('button', {
        class: 'info__link', type: 'button', text: host.name, onclick: () => this.onSelect(host.id),
      })];
    }
    return [KIND_LABEL[body.kind] ?? body.kind];
  }

  /**
   * Links to a planet's moons, or a moon's planet and siblings. The catalogue
   * only carries the notable few, so the heading does not claim a full list.
   */
  _buildSystem(body) {
    if (body.exoplanet) return this._buildExoplanetLinks(body);
    const primaryId = body.kind === 'moon' ? body.parent : body.id;
    const primary = this.catalogue.byId.get(primaryId);
    const moons = primaryId && primaryId !== this.catalogue.starId
      ? this.catalogue.bodies.filter((b) => b.parent === primaryId).filter((moon) => this.isVisible(moon.id))
      : [];

    if (moons.length === 0) {
      this.system.replaceChildren();
      return;
    }

    const members = body.kind === 'moon' ? [primary, ...moons] : moons;
    this.system.replaceChildren(
      el('h3', { class: 'section-title', text: body.kind === 'moon' ? `${primary.name} system` : 'Moons' }),
      el(
        'div',
        { class: 'chips' },
        members.map((member) =>
          el(
            'button',
            {
              class: 'chip',
              type: 'button',
              'aria-current': member.id === body.id ? 'true' : null,
              onclick: () => this.onSelect(member.id),
            },
            [
              el('span', { class: 'chip__dot', style: { background: member.color ?? '#fff' } }),
              member.name,
            ]
          )
        )
      )
    );
  }

  /** The body and its nearest sibling in and out - or two on one side, at either end. */
  _neighbours(body) {
    const size = (b) => b.orbit.aAU ?? b.orbit.aKm;
    const siblings = this.catalogue.bodies
      .filter((b) => b.parent === body.parent && b.orbit && (b.id === body.id || this.isVisible(b.id)))
      .sort((a, b) => size(a) - size(b));
    const i = siblings.findIndex((b) => b.id === body.id);
    let from = i - 1;
    let to = i + 1;
    if (from < 0) to = i + 2;
    if (to >= siblings.length) from = Math.min(from, i - 2);
    return siblings.slice(Math.max(0, from), Math.min(siblings.length, to + 1));
  }

  _buildDiagram(view) {
    const own = diagramElements(view.elements);
    if (!own) {
      this.diagram.replaceChildren();
      this._diagramParts = null;
      return;
    }

    const members = this._neighbours(view.body)
      .map((body) => ({ body, el: body.id === view.id ? own : diagramElements(this.elementsOf(body.id)) }))
      .filter((member) => member.el);

    const { width, height, pad, samples } = MAP;
    const reach = Math.max(...members.map(({ el }) => el.a * (1 + el.e)));
    const scale = (height / 2 - pad) / reach;
    const cx = width / 2;
    const cy = height / 2;
    // Seen from above: scene x to the right, scene z down the page, so motion
    // that is anticlockwise from the north stays anticlockwise here.
    const project = (p) => [cx + p.x * scale, cy + p.z * scale];

    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%' });
    const parts = { members: [], project, scale, own };

    for (const member of members) {
      const isOwn = member.body.id === view.id;
      svg.append(svgEl('path', {
        class: isOwn ? 'orbit-path is-own' : 'orbit-path',
        d: orbitPath(member.el, 0, Math.PI * 2, samples, project),
      }));
    }

    // Another star's own colour; a pair's centre of mass takes the host's, as a ring.
    const primaryColor = view.body.exoplanet
      ? (own.parentBody ?? this.catalogue.byId.get(this.catalogue.starId))?.color ?? '#ffd9a0'
      : own.heliocentric ? '#ffd9a0' : (own.parentBody?.color ?? '#ffffff');
    const barycentre = view.body.parent?.startsWith('barycentre:');
    svg.append(svgEl('circle', {
      class: 'orbit-primary', cx, cy, r: own.heliocentric ? 3.5 : 3,
      fill: barycentre ? 'none' : primaryColor, stroke: barycentre ? primaryColor : 'none',
    }));

    parts.travelled = svgEl('path', { class: 'orbit-travelled' });
    svg.append(parts.travelled);

    for (const member of members) {
      if (member.body.id === view.id) continue;
      const dot = svgEl('circle', { class: 'orbit-neighbour', r: 2.2, fill: member.body.color ?? '#fff' });
      const label = svgEl('text', { class: 'orbit-label' });
      label.textContent = member.body.name.replace(/^The /, '');
      svg.append(dot, label);
      parts.members.push({ ...member, dot, label });
    }

    parts.halo = svgEl('circle', { class: 'orbit-halo', r: 7 });
    parts.dot = svgEl('circle', { class: 'orbit-body', r: 3.4 });
    svg.append(parts.halo, parts.dot);

    this.diagram.replaceChildren(svg);
    this._diagramParts = parts;
  }

  /**
   * Called on a timer rather than every frame: these numbers change slowly and
   * re-laying out text every frame is wasteful.
   *
   * @param {number} tDays
   */
  updateLive(tDays) {
    const view = this._view;
    const elementsOf = this.elementsOf;
    if (!view || this.collapsed) return;

    const rows = [];
    const body = view.body;
    if (body.exoplanet) {
      if (view.elements) {
        const elements = diagramElements(view.elements);
        orbitalPosition(elements, tDays, _now);
        this._renderLive([[body.parent?.startsWith('barycentre:') ? 'Model distance to barycentre' : 'Model distance to star',
          `${Math.hypot(_now.x, _now.y, _now.z).toPrecision(4)} AU`]]);
        this._updateDiagram(elements, tDays);
      }
      return;
    }
    const earthEl = elementsOf('earth');
    orbitalPosition(earthEl, tDays, _earth);

    if (!view.elements) {
      if (body.kind !== 'star') {
        this.live.replaceChildren();
        this._liveRows = null;
        return;
      }
      // The Sun: no orbit, but the distance to Earth is live.
      const au = Math.hypot(_earth.x, _earth.y, _earth.z);
      rows.push(['From Earth', `${au.toFixed(3)} AU`]);
      rows.push(['Light to Earth', formatDuration((au * AU_KM) / LIGHT_KM_S)]);
      this._renderLive(rows);
      return;
    }

    const el_ = view.elements;
    orbitalPosition(el_, tDays, _now);
    const distance = Math.hypot(_now.x, _now.y, _now.z);

    // Speed from a one-minute finite difference: exact enough at these scales
    // and far simpler than differentiating the anomaly analytically.
    const dt = 1 / 1440;
    orbitalPosition(el_, tDays + dt, _soon);
    const travelled = Math.hypot(_soon.x - _now.x, _soon.y - _now.y, _soon.z - _now.z);
    const speedKmS = (el_.heliocentric ? travelled * AU_KM : travelled) / (dt * 86_400);

    // Fraction of the period elapsed since periapsis.
    const turns = (el_.meanLong - el_.periLong) / 360 + tDays / el_.periodDays;
    const sincePeriapsis = turns - Math.floor(turns);
    const parent = body.parent ? this.catalogue.byId.get(body.parent) : null;

    if (el_.heliocentric) {
      rows.push(['From the Sun', `${distance.toFixed(3)} AU`]);
      if (body.id !== 'earth') {
        const fromEarth = Math.hypot(_now.x - _earth.x, _now.y - _earth.y, _now.z - _earth.z);
        rows.push(['From Earth', `${fromEarth.toFixed(3)} AU`]);
      }
      rows.push(['Sunlight takes', formatDuration((distance * AU_KM) / LIGHT_KM_S)]);
    } else {
      rows.push([`From ${parent?.name ?? 'primary'}`, formatKm(distance)]);
      if (body.parent !== 'earth') {
        // A moon's distance from its planet is a rounding error at this range.
        orbitalPosition(elementsOf(body.parent), tDays, _parent);
        const au = Math.hypot(_parent.x - _earth.x, _parent.y - _earth.y, _parent.z - _earth.z);
        rows.push(['From Earth', `${au.toFixed(3)} AU`]);
      } else {
        rows.push(['Light to Earth', formatDuration(distance / LIGHT_KM_S)]);
      }
    }
    rows.push(['Orbital speed', `${speedKmS.toFixed(2)} km/s`]);
    rows.push([
      el_.heliocentric ? 'Since perihelion' : 'Since periapsis',
      `${(sincePeriapsis * 100).toFixed(1)}% of orbit`,
    ]);

    this._renderLive(rows);
    this._updateDiagram(el_, tDays);
  }

  _updateDiagram(own, tDays) {
    const parts = this._diagramParts;
    if (!parts) return;

    orbitalPosition(own, tDays, _point);
    const [x, y] = parts.project(_point);
    for (const node of [parts.dot, parts.halo]) {
      node.setAttribute('cx', x.toFixed(2));
      node.setAttribute('cy', y.toFixed(2));
    }

    const meanAnomaly = (own.meanLong - own.periLong + (360 / own.periodDays) * tDays) * (Math.PI / 180);
    let E = eccentricAnomaly(meanAnomaly, own.e);
    if (E < 0) E += Math.PI * 2;
    parts.travelled.setAttribute('d', orbitPath(own, 0, E, Math.max(2, Math.ceil(E * 12)), parts.project));

    const cx = MAP.width / 2;
    const cy = MAP.height / 2;
    for (const member of parts.members) {
      orbitalPosition(member.el, tDays, _point);
      const [nx, ny] = parts.project(_point);
      member.dot.setAttribute('cx', nx.toFixed(2));
      member.dot.setAttribute('cy', ny.toFixed(2));
      // The name sits just outside the dot, on the side away from the primary.
      const length = Math.hypot(nx - cx, ny - cy) || 1;
      const lx = nx + ((nx - cx) / length) * 6;
      const ly = ny + ((ny - cy) / length) * 6 + 3;
      member.label.setAttribute('x', lx.toFixed(1));
      member.label.setAttribute('y', ly.toFixed(1));
      member.label.setAttribute('text-anchor', nx >= cx ? 'start' : 'end');
    }
  }

  /** Rewrites only the values when the row set is unchanged, to avoid layout churn. */
  _renderLive(rows) {
    const sameShape = this._liveRows?.length === rows.length &&
      rows.every(([label], i) => this._liveRows[i].label === label);
    if (sameShape) {
      rows.forEach(([, value], i) => {
        if (this._liveRows[i].value.textContent !== value) this._liveRows[i].value.textContent = value;
      });
      return;
    }

    this._liveRows = rows.map(([label, value]) => {
      const valueNode = el('span', { text: value });
      const row = el('div', { class: 'info__live-row' }, [el('span', { text: label }), valueNode]);
      return { row, label, value: valueNode };
    });
    this.live.replaceChildren(...this._liveRows.map((r) => r.row));
  }
}

/**
 * Splits catalogue text like "5.972 × 10²⁴ kg" into text and <sup> nodes.
 * Unicode superscript digits fall back to whatever font has them, so one
 * number can mix three fonts.
 */
const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁻';
const PLAIN = '0123456789−';
function withSuperscripts(text) {
  const parts = [];
  let run = '';
  let raised = false;
  const flush = () => {
    if (!run) return;
    parts.push(raised ? el('sup', { text: run }) : run);
    run = '';
  };
  for (const char of text) {
    const index = SUPERSCRIPTS.indexOf(char);
    const isRaised = index >= 0;
    if (isRaised !== raised) flush();
    raised = isRaised;
    run += isRaised ? PLAIN[index] : char;
  }
  flush();
  return parts;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
  }
  const hours = Math.floor(seconds / 3600);
  return `${hours} h ${Math.round((seconds - hours * 3600) / 60)} min`;
}

/** An SVG path along an orbit from one eccentric anomaly to another, seen from above. */
function orbitPath(el, fromE, toE, steps, project) {
  const b = Math.sqrt(1 - el.e * el.e);
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const E = fromE + ((toE - fromE) * i) / steps;
    perifocalToWorld(el.a * (Math.cos(E) - el.e), el.a * b * Math.sin(E), el, _point);
    const [x, y] = project(_point);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

function svgEl(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function diagramElements(elements) {
  if (!elements || elements.fraction == null || elements.fraction === 1) return elements;
  const flip = elements.fraction < 0 ? 180 : 0;
  return { ...elements, a: elements.a * Math.abs(elements.fraction),
    meanLong: elements.meanLong + flip, periLong: elements.periLong + flip };
}
