/**
 * Settings drawer.
 *
 * Replaces the lil-gui panel, which came from a CDN, looked like a debug
 * overlay, and exposed controls that destroyed and rebuilt the entire system on
 * change. Everything here is either free or applies incrementally, and the two
 * settings that do cost a rebuild say so.
 */

import { el, icon, trapFocus } from './dom.js';
import { SCALE_EXPONENT_RANGE } from '../scene/scaling.js';

export class SettingsPanel {
  /** @param {import('../core/Settings.js').Settings} settings */
  constructor(settings) {
    this.settings = settings;
    this.isOpen = false;
    this._releaseFocus = null;

    this.body = el('div', { class: 'drawer__body' });
    this.root = el(
      'div',
      { class: 'drawer panel', role: 'dialog', 'aria-label': 'Settings', 'aria-modal': 'false' },
      [
        el('div', { class: 'drawer__header' }, [
          el('h2', { class: 'drawer__title', text: 'Settings' }),
          el(
            'button',
            {
              class: 'btn btn--icon drawer__close',
              type: 'button',
              'aria-label': 'Close settings',
              onclick: () => this.close(),
            },
            [icon('close')]
          ),
        ]),
        this.body,
      ]
    );

    this._build();
  }

  _build() {
    this.body.append(
      el('h3', { class: 'section-title', text: 'Show' }),
      this._toggle('showOrbits', 'Orbit paths'),
      this._toggle('showMoons', 'Moons'),
      this._toggle('showDwarfs', 'Dwarf planets'),
      this._toggle('showBelts', 'Belts'),
      this._toggle('showLabels', 'Labels'),

      el('h3', { class: 'section-title', text: 'Layout' }),
      this._slider(
        'scale',
        'Scale',
        SCALE_EXPONENT_RANGE.min,
        SCALE_EXPONENT_RANGE.max,
        0.01,
        (value) => (value <= 0.5 ? 'Compact' : value >= 0.6 ? 'Spacious' : 'Balanced'),
        'Higher is closer to true proportions: smaller bodies, wider orbits.'
      ),
      this._slider(
        'beltDensity',
        'Belt density',
        0,
        1.5,
        0.05,
        (value) => `${Math.round(value * 100)}%`
      ),

      el('h3', { class: 'section-title', text: 'Graphics' }),
      this._segmented(
        'shadowQuality',
        'Shadows',
        [
          { value: 0, label: 'Off' },
          { value: 1024, label: 'Low' },
          { value: 2048, label: 'High' },
        ],
        'Lets moons shadow their planet. Saturn’s ring shadows are always on.'
      ),
      this._toggle(
        'adaptiveResolution',
        'Adaptive resolution',
        'Trades sharpness for frame rate when needed.'
      ),
      this._slider(
        'exposure',
        'Exposure',
        0.5,
        1.8,
        0.05,
        (value) => `${value.toFixed(2)}×`
      ),

      el('h3', { class: 'section-title', text: 'Accessibility' }),
      this._toggle(
        'reduceMotion',
        'Reduce motion',
        'Skips camera fly-throughs and transitions.'
      ),

      el('div', { class: 'field' }, [
        el('button', {
          class: 'btn btn--text',
          type: 'button',
          text: 'Reset to defaults',
          onclick: () => this.settings.reset(),
        }),
      ])
    );
  }

  _toggle(key, label, hint) {
    const control = el('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-checked': String(this.settings.get(key)),
      'aria-label': label,
      onclick: () => this.settings.set(key, !this.settings.get(key)),
    });

    this.settings.on(key, (value) => control.setAttribute('aria-checked', String(value)));

    return el('div', { class: 'field' }, [
      el('div', { class: 'field__row' }, [el('span', { class: 'field__label', text: label }), control]),
      hint ? el('p', { class: 'field__hint', text: hint }) : null,
    ]);
  }

  _slider(key, label, min, max, step, format, hint) {
    const value = el('span', { class: 'field__value', text: format(this.settings.get(key)) });
    const input = el('input', {
      type: 'range',
      min,
      max,
      step,
      value: this.settings.get(key),
      'aria-label': label,
      oninput: (event) => this.settings.set(key, Number(event.target.value)),
    });

    this.settings.on(key, (next) => {
      if (Number(input.value) !== next) input.value = next;
      value.textContent = format(next);
    });

    return el('div', { class: 'field' }, [
      el('div', { class: 'field__row' }, [el('span', { class: 'field__label', text: label }), value]),
      input,
      hint ? el('p', { class: 'field__hint', text: hint }) : null,
    ]);
  }

  _segmented(key, label, options, hint) {
    const buttons = options.map((option) =>
      el('button', {
        type: 'button',
        text: option.label,
        'aria-pressed': String(this.settings.get(key) === option.value),
        onclick: () => this.settings.set(key, option.value),
      })
    );

    this.settings.on(key, (next) => {
      options.forEach((option, i) =>
        buttons[i].setAttribute('aria-pressed', String(option.value === next))
      );
    });

    return el('div', { class: 'field' }, [
      el('div', { class: 'field__row' }, [
        el('span', { class: 'field__label', text: label }),
        el('div', { class: 'segmented', role: 'group', 'aria-label': label }, buttons),
      ]),
      hint ? el('p', { class: 'field__hint', text: hint }) : null,
    ]);
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.isOpen = true;
    this.root.classList.add('is-open');
    this._releaseFocus = trapFocus(this.root);
    this.root.querySelector('button')?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('is-open');
    this._releaseFocus?.();
    this._releaseFocus = null;
  }
}
