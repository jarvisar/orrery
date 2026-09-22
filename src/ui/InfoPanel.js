/**
 * Facts about whatever is currently in focus.
 *
 * Splits into two halves: a static block straight from the catalogue, and a
 * live block recomputed each frame from the simulation - current distance from
 * the Sun, orbital speed, how far through its year it is. The live figures are
 * derived from the same Keplerian state that positions the body, so the panel
 * and the scene can never disagree.
 */

import { el, icon, formatKm } from './dom.js';
import { AU_KM, BODY_BY_ID } from '../data/bodies.js';
import { orbitalPosition } from '../sim/kepler.js';

const KIND_LABEL = {
  star: 'Star',
  planet: 'Planet',
  dwarf: 'Dwarf planet',
  moon: 'Natural satellite',
};

const _now = { x: 0, y: 0, z: 0 };
const _soon = { x: 0, y: 0, z: 0 };

export class InfoPanel {
  constructor({ collapsed = false } = {}) {
    this.title = el('h2', { class: 'info__title', text: 'Sun' });
    this.kind = el('span', { class: 'info__kind', text: 'Star' });
    this.toggleIcon = el('span', { class: 'info__toggle' }, [icon('chevron', 16)]);

    this.blurb = el('p', { class: 'info__blurb' });
    this.facts = el('dl', { class: 'info__facts' });
    this.live = el('div', { class: 'info__live' });
    this.body = el('div', { class: 'info__body' }, [this.blurb, this.facts, this.live]);

    this.header = el(
      'button',
      {
        class: 'info__header',
        type: 'button',
        'aria-expanded': String(!collapsed),
        onclick: () => this.setCollapsed(!this.collapsed),
      },
      [el('div', {}, [this.title, el('div', {}, [this.kind])]), this.toggleIcon]
    );

    this.root = el('aside', { class: 'info panel', 'aria-label': 'Body information' }, [
      this.header,
      this.body,
    ]);

    this.collapsed = false;
    this.setCollapsed(collapsed);
    this._view = null;
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
    this.kind.textContent = describeKind(body);
    this.blurb.textContent = body.blurb ?? '';

    this.facts.replaceChildren(
      ...Object.entries(body.facts ?? {}).flatMap(([term, value]) =>
        el('div', { class: 'info__fact' }, [
          el('dt', { text: term }),
          el('dd', { text: value }),
        ])
      )
    );

    this.live.replaceChildren();
    this._liveRows = null;
  }

  /**
   * Refreshes the live readings. Called on a timer rather than every frame -
   * these numbers change slowly and re-laying out text 60 times a second is
   * pure waste.
   */
  updateLive(tDays) {
    const view = this._view;
    if (!view || this.collapsed || !view.elements) {
      if (view && !view.elements) this.live.replaceChildren();
      return;
    }

    const el_ = view.elements;
    const heliocentric = el_.heliocentric;

    orbitalPosition(el_, tDays, _now);
    const distance = Math.hypot(_now.x, _now.y, _now.z);

    // Speed from a one-minute finite difference: exact enough at these scales
    // and far simpler than differentiating the anomaly analytically.
    const dt = 1 / 1440;
    orbitalPosition(el_, tDays + dt, _soon);
    const travelled = Math.hypot(_soon.x - _now.x, _soon.y - _now.y, _soon.z - _now.z);
    const km = heliocentric ? travelled * AU_KM : travelled;
    const speedKmS = km / (dt * 86_400);

    // The mean anomaly, as a fraction of a turn: how far round the orbit the
    // body has come since it last passed closest to its primary.
    // Retrograde orbits (Triton) run the anomaly backwards.
    const turns = ((el_.meanLong - el_.periLong) / 360 + tDays / el_.periodDays) *
      Math.sign(el_.periodDays);
    const sincePeriapsis = ((turns % 1) + 1) % 1;
    const parent = view.body.parent ? BODY_BY_ID.get(view.body.parent) : null;

    const rows = [
      [heliocentric ? 'Distance from Sun' : `Distance from ${parent?.name ?? 'primary'}`,
       heliocentric ? `${(distance).toFixed(3)} AU` : formatKm(distance)],
      ['Orbital speed', `${speedKmS.toFixed(2)} km/s`],
      [heliocentric ? 'Since perihelion' : 'Since periapsis',
       `${(sincePeriapsis * 100).toFixed(1)}% of orbit`],
    ];

    this._renderLive(rows);
  }

  /** Rewrites only the values when the row set is unchanged, to avoid layout churn. */
  _renderLive(rows) {
    if (this._liveRows?.length === rows.length) {
      rows.forEach(([, value], i) => {
        if (this._liveRows[i].value.textContent !== value) {
          this._liveRows[i].value.textContent = value;
        }
      });
      return;
    }

    this._liveRows = rows.map(([label, value]) => {
      const valueNode = el('span', { text: value });
      const row = el('div', { class: 'info__live-row' }, [el('span', { text: label }), valueNode]);
      return { row, value: valueNode };
    });
    this.live.replaceChildren(...this._liveRows.map((r) => r.row));
  }
}

function describeKind(body) {
  const base = KIND_LABEL[body.kind] ?? body.kind;
  if (body.kind === 'moon' && body.parent) {
    return `${base} · ${BODY_BY_ID.get(body.parent)?.name ?? ''}`;
  }
  return base;
}
