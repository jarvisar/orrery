/**
 * The body selector.
 *
 * Replaces a native `<select>` whose moons were hidden with the `hidden`
 * attribute - which browsers honour inconsistently, and which meant a moon
 * could be the selected value while being unreachable from the list. This
 * groups bodies by kind, shows moons under their primary, and hides a whole
 * group when that category is switched off rather than leaving dead entries in.
 */

import { el, icon } from './dom.js';
import { BODIES, BODY_BY_ID } from '../data/bodies.js';

const GROUP_ORDER = [
  { kind: 'star', label: 'Star' },
  { kind: 'planet', label: 'Planets' },
  { kind: 'moon', label: 'Moons' },
  { kind: 'dwarf', label: 'Dwarf planets' },
];

export class BodyPicker {
  /** @param {(id: string) => void} onSelect */
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.selectedId = null;
    this.isOpen = false;
    this._options = new Map();

    this.swatch = el('span', { class: 'picker__swatch' });
    this.label = el('span', { class: 'picker__label', text: 'Sun' });

    this.button = el(
      'button',
      {
        class: 'picker__button',
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        onclick: (e) => { e.stopPropagation(); this.toggle(); },
        onkeydown: (e) => this._onButtonKeyDown(e),
      },
      [this.swatch, this.label, el('span', { class: 'picker__chevron' }, [icon('chevron', 14)])]
    );

    this.menu = el('div', {
      class: 'picker__menu',
      role: 'listbox',
      hidden: true,
      onkeydown: (e) => this._onMenuKeyDown(e),
    });
    this.root = el('div', { class: 'picker' }, [this.button, this.menu]);

    this._buildOptions();

    this._onDocumentClick = (e) => { if (!this.root.contains(e.target)) this.close(); };
    document.addEventListener('click', this._onDocumentClick);
  }

  _buildOptions() {
    for (const group of GROUP_ORDER) {
      const members = BODIES.filter((b) => b.kind === group.kind);
      if (members.length === 0) continue;

      const heading = el('div', { class: 'picker__group', text: group.label });
      this.menu.append(heading);

      const nodes = [];
      for (const body of members) {
        const parent = body.parent ? BODY_BY_ID.get(body.parent) : null;
        const option = el(
          'button',
          {
            class: 'picker__option',
            type: 'button',
            role: 'option',
            'aria-selected': 'false',
            'data-id': body.id,
            onclick: () => { this.onSelect(body.id); this.close(); },
          },
          [
            el('span', {
              class: 'picker__swatch',
              style: { background: body.color ?? '#ffffff', color: body.color ?? '#ffffff' },
            }),
            el('span', { text: body.name }),
            group.kind === 'moon' && parent
              ? el('span', { class: 'picker__option-meta', text: parent.name })
              : null,
          ]
        );
        this.menu.append(option);
        this._options.set(body.id, option);
        nodes.push(option);
      }
      this._groups ??= [];
      this._groups.push({ kind: group.kind, heading, nodes });
    }
  }

  /** Hides a whole category, matching the moon / dwarf visibility settings. */
  setCategoryVisible(kind, visible) {
    for (const group of this._groups ?? []) {
      if (group.kind !== kind) continue;
      group.heading.hidden = !visible;
      for (const node of group.nodes) node.hidden = !visible;
    }
  }

  select(id) {
    if (this.selectedId === id) return;

    this._options.get(this.selectedId)?.setAttribute('aria-selected', 'false');
    this.selectedId = id;

    const body = id ? BODY_BY_ID.get(id) : null;
    this.label.textContent = body?.name ?? 'Free view';
    this.swatch.style.background = body?.color ?? '#8892a8';
    this.swatch.style.color = body?.color ?? '#8892a8';

    if (id) this._options.get(id)?.setAttribute('aria-selected', 'true');
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.isOpen = true;
    this.menu.hidden = false;
    this.root.classList.add('is-open');
    this.button.setAttribute('aria-expanded', 'true');
    this._options.get(this.selectedId)?.scrollIntoView({ block: 'nearest' });
  }

  /** Escape is routed here from src/main.js, which owns that key app-wide. */
  close({ restoreFocus = false } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.menu.hidden = true;
    this.root.classList.remove('is-open');
    this.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.button.focus();
  }

  _visibleOptions() {
    return [...this._options.values()].filter((node) => !node.hidden);
  }

  _onButtonKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.open();
      const visible = this._visibleOptions();
      visible[event.key === 'ArrowDown' ? 0 : visible.length - 1]?.focus();
    }
  }

  _onMenuKeyDown(event) {
    const visible = this._visibleOptions();
    const index = visible.indexOf(document.activeElement);
    const move = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: visible.length - 1,
    }[event.key];

    if (move !== undefined) {
      event.preventDefault();
      visible[(move + visible.length) % visible.length]?.focus();
    } else if (event.key === ' ' || event.key === 'Enter') {
      // Let the option activate natively instead of the app-wide Space
      // shortcut pausing time.
      event.stopPropagation();
    }
  }

  dispose() {
    document.removeEventListener('click', this._onDocumentClick);
    this.root.remove();
  }
}
