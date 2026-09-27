/**
 * The star systems atlas: a searchable list of every exoplanet host in the NASA
 * catalogue. Each card links to that system, which opens as a page of its own.
 */

import { el, icon } from './dom.js';
import { ARCHIVE, stellarColor } from '../data/exoplanets.js';
import { searchKey } from '../data/starNames.js';
import { loadStellarCatalogue, starsShown } from '../data/stellarSystems.js';
import { hostSummary } from '../core/SkyHosts.js';

const FEATURED = [
  'tau Cet', 'Proxima Cen', 'TRAPPIST-1', 'eps Eri', 'Kepler-16', 'HR 8799', 'PDS 70', 'KOI-351', 'bet Pic', '55 Cnc',
  'KELT-9', 'HD 189733', '51 Peg', 'PSR B1257+12', "Barnard's star", 'TOI-700', 'Kepler-452', 'Kepler-47', 'Kepler-186', 'HD 219134',
];

/** Cards shown at first, and added by each "Show more". */
const CARDS_PER_PAGE = 24;

/** Catalogue order a person expects: Kepler-2 before Kepler-10. */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);
const byDistance = (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity);

/** How each choice in the list's menu orders it; 'stars' is sorted in render(). */
const ORDER = {
  featured: (a, b) => rank(a) - rank(b) || byDistance(a, b) || byName(a, b),
  nearest: (a, b) => byDistance(a, b) || byName(a, b),
  multiple: (a, b) => b.planets.length - a.planets.length || byName(a, b),
  recent: (a, b) => b.latest - a.latest || byName(a, b),
  name: byName,
};

function rank(system) {
  const i = FEATURED.indexOf(system.name);
  return i < 0 ? 1000 : i;
}

export class SystemExplorer {
  /**
   * @param {import('../core/ExoplanetCatalogue.js').ExoplanetCatalogue} catalogue
   * @param {object} current The catalogue on screen, which its card marks.
   * @param {{onOpen?: () => void}} [options] `onOpen` clears the way for the dialog.
   */
  constructor(catalogue, current, { onOpen = () => {} } = {}) {
    this.catalogue = catalogue;
    this.current = current;
    this.onOpen = onOpen;
    this.limit = CARDS_PER_PAGE;
    /** The companion supplement, once loaded: says how many of each system's stars can be drawn. */
    this.supplement = null;
    this._shown = new WeakMap();

    this.button = el(
      'button',
      {
        class: 'btn systems-button',
        type: 'button',
        title: 'Explore star systems',
        'aria-label': 'Explore star systems',
        'aria-haspopup': 'dialog',
        onclick: () => this.open(),
      },
      [icon('search'), el('span', { text: 'Star systems' })]
    );

    this.title = el('h2', { id: 'systems-title', text: 'Star systems' });
    this.count = el('p', { class: 'systems__count', text: 'Reading the NASA catalogue…' });
    this.search = el('input', {
      type: 'search',
      placeholder: 'Find a star or planet…',
      'aria-label': 'Search stars and planets',
      oninput: () => this._restart(),
    });
    this.sort = el(
      'select',
      { 'aria-label': 'Browse systems', onchange: () => this._restart() },
      [
        ['featured', 'Featured systems'],
        ['nearest', 'Nearest to Earth'],
        ['stars', 'Multiple stars'],
        ['multiple', 'Most planets'],
        ['recent', 'Newest discoveries'],
        ['name', 'A to Z'],
      ].map(([value, text]) => el('option', { value, text }))
    );
    this.list = el('div', { class: 'systems__list' });
    this.results = el('p', { class: 'systems__results', role: 'status' });
    this.status = el('p', { class: 'systems__status', role: 'status', 'aria-live': 'polite' });
    this.date = el('span');
    this.more = el('button', {
      class: 'btn',
      type: 'button',
      text: 'Show more systems',
      onclick: () => {
        this.limit += CARDS_PER_PAGE;
        this.render();
      },
    });
    this.refresh = el('button', {
      class: 'btn',
      type: 'button',
      text: 'Refresh from NASA',
      onclick: () => this.reload(),
    });

    this.panel = el(
      'dialog',
      {
        class: 'systems panel',
        'aria-labelledby': 'systems-title',
        oncancel: (event) => {
          event.preventDefault();
          this.close();
        },
        onkeydown: (event) => event.stopPropagation(),
        // A click on the backdrop, outside the dialog's own box, closes it.
        onclick: (event) => {
          if (event.target !== this.panel) return;
          const r = this.panel.getBoundingClientRect();
          if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) {
            this.close();
          }
        },
      },
      [
        // One block, so a short screen can pin the search and the way out together (style.css).
        el('div', { class: 'systems__top' }, [
          el('header', { class: 'systems__header' }, [
            el('div', {}, [el('p', { class: 'section-title', text: 'Exoplanets' }), this.title, this.count]),
            el(
              'button',
              { class: 'btn btn--icon', type: 'button', 'aria-label': 'Close star systems', onclick: () => this.close() },
              [icon('close')]
            ),
          ]),
          el('div', { class: 'systems__tools' }, [this.search, this.sort]),
        ]),
        el('div', { class: 'systems__scroll' }, [
          el('a', { class: 'systems__home', href: systemUrl(null) }, [
            el('span', { text: '☉', 'aria-hidden': 'true' }),
            el('span', {}, [el('strong', { text: 'Solar System' }), el('small', { text: 'Sun, planets and moons' })]),
            el('span', { text: current.isExoplanet ? 'Open →' : 'Current system' }),
          ]),
          this.results,
          this.list,
          this.more,
        ]),
        el('footer', { class: 'systems__footer' }, [
          el('div', {}, [
            el('a', {
              href: `${ARCHIVE}/docs/API_TD_columns.html`,
              target: '_blank',
              rel: 'noopener',
              text: 'NASA Exoplanet Archive',
            }),
            this.date,
          ]),
          this.refresh,
          this.status,
          el('p', {
            class: 'systems__note',
            text: 'Confirmed planets · published default solutions. Sizes and distances are compressed. ' +
              'Model estimates are labelled; orbital phases and appearances are illustrative.',
          }),
        ]),
      ]
    );

    catalogue.subscribe(() => {
      this.render();
      this.renderStatus();
    });
  }

  get isOpen() {
    return this.panel.open;
  }

  async open() {
    this.onOpen();
    this.panel.showModal();
    // On a touch screen, focusing the field would throw up the keyboard over the list.
    if (!window.matchMedia('(pointer: coarse)').matches) this.search.focus();
    loadStellarCatalogue().then((supplement) => {
      this.supplement = supplement;
      this._sorted = null;
      this.render();
    }).catch(() => { /* cards keep NASA's star count alone */ });
    try {
      await this.catalogue.load();
      this.render();
      this.renderStatus();
      this.catalogue.refreshIfStale();
    } catch (error) {
      this.count.textContent = 'Catalogue unavailable';
      this.status.textContent = error.message;
    }
  }

  close() {
    this.panel.close();
    this.button.focus();
  }

  async reload() {
    await this.catalogue.refresh();
  }

  /** A new search or order starts again from the first page of cards. */
  _restart() {
    this.limit = CARDS_PER_PAGE;
    this.render();
  }

  renderStatus() {
    const { data, status, refreshing } = this.catalogue;
    this.refresh.disabled = refreshing;
    this.refresh.textContent = refreshing ? 'Refreshing…' : 'Refresh from NASA';
    const stale = this.current.isExoplanet && data?.fetchedAt !== this.current.fetchedAt;
    this.status.textContent = status + (stale ? ' Reopen a system to apply the newer measurements.' : '');
    this.date.textContent = data
      ? ` · retrieved ${new Date(data.fetchedAt).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })} (UTC)`
      : '';
  }

  render() {
    const { systems, data } = this.catalogue;
    if (!data) return;
    const query = searchKey(this.search.value);
    // A search is read in name order, even from Featured.
    const sort = query && this.sort.value === 'featured' ? 'name' : this.sort.value;
    // Progress updates during a refresh re-render; the list only changes with these.
    const key = JSON.stringify([data.fetchedAt, query, sort, this.limit, Boolean(this.supplement)]);
    if (key === this._rendered) return;
    this._rendered = key;

    this.count.textContent = `${data.rows.length.toLocaleString()} planets · ${systems.length.toLocaleString()} hosts`;
    // Sorted once per catalogue and order; filtering keeps the order.
    if (this._sorted?.systems !== systems || this._sorted.sort !== sort) {
      // Multiple stars: the systems that can show them all come first.
      const order = sort === 'stars'
        ? (a, b) => (this.shown(b) ?? b.stars) - (this.shown(a) ?? a.stars) || b.stars - a.stars || byName(a, b)
        : ORDER[sort];
      this._sorted = { systems, sort, list: systems.filter((s) => sort !== 'stars' || s.stars > 1).sort(order) };
    }
    const matches = query ? this._sorted.list.filter((s) => s.searchable.includes(query)) : this._sorted.list;
    this.results.textContent = matches.length
      ? `${matches.length.toLocaleString()} systems${query ? ` matching “${this.search.value.trim()}”` : ''}`
      : 'No matching systems. Try a name such as TRAPPIST-1, Proxima Centauri or 51 Pegasi.';
    this.list.replaceChildren(...matches.slice(0, this.limit).map((s) => this.card(s)));
    this.more.hidden = matches.length <= this.limit;
  }

  card(system) {
    const diagram = el(
      'span',
      { class: 'systems__glyph', 'aria-hidden': 'true', style: { '--star-color': stellarColor(system.temperature) } },
      Array.from({ length: Math.min(system.planets.length, 5) }, (_, i) => el('i', { style: { '--orbit': i } }))
    );
    const notes = [
      this.starLabel(system),
      this.sort.value === 'recent' ? `Latest discovery ${system.latest || 'unknown'}` : '',
    ].filter(Boolean).join(' · ');
    return el(
      'a',
      {
        class: 'systems__card',
        href: systemUrl(system.name),
        'data-system': system.name,
        'aria-current': this.current.id === system.name ? 'location' : null,
      },
      [
        diagram,
        el('div', {}, [
          el('h3', { text: system.name }),
          el('p', { text: hostSummary({ planets: system.planets.length, distance: system.distance }) }),
          el('small', { text: notes || 'Explore system' }),
        ]),
        el('span', { class: 'systems__arrow', text: '→', 'aria-hidden': 'true' }),
      ]
    );
  }

  /** How many of a system's stars can be drawn, or null until the supplement arrives. */
  shown(system) {
    if (system.stars < 2) return 1;
    if (!this.supplement) return null;
    if (!this._shown.has(system)) this._shown.set(system, starsShown(system, this.catalogue.data, this.supplement));
    return this._shown.get(system);
  }

  /** NASA's count, and whether the view will show them all. */
  starLabel(system) {
    if (system.stars < 2) return '';
    const shown = this.shown(system);
    const label = `${system.stars}-star system`;
    if (shown === null || shown >= system.stars) return label;
    return shown === 1 ? `${label} · host star only` : `${label} · ${shown} shown`;
  }
}

/** A link to a system by its host's name, or to the Solar System with null. */
export function systemUrl(name) {
  const url = new URL(window.location.href);
  if (name) url.searchParams.set('system', name);
  else url.searchParams.delete('system');
  url.searchParams.delete('body');
  url.searchParams.delete('planet');
  return url.href;
}
