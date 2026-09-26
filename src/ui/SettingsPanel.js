/** Settings drawer. */

import { el, icon, trapFocus } from './dom.js';
import { SCALE_EXPONENT_RANGE } from '../scene/scaling.js';
import { canInstall, install, onInstallChange } from './install.js';

export class SettingsPanel {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {object} [options]
   * @param {string[]} [options.omit] Settings with nothing to act on in this view
   *   (moons and belts around another star). Hidden, but kept.
   */
  constructor(settings, { omit = [] } = {}) {
    this.settings = settings;
    this.omit = new Set(omit);
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
        'effects',
        'Bloom and film finish',
        'Glow around bright light, and smoother gradients. Costs a little speed.'
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

      // Shown only while a controller is connected.
      (this.controller = el('div', { class: 'drawer__section', hidden: true }, [
        el('h3', { class: 'section-title', text: 'Controller' }),
        this._toggle('padInvertY', 'Invert up and down', 'Push up to look down, as a flight stick does.'),
        this._slider(
          'padSensitivity',
          'Stick speed',
          0.5,
          2,
          0.05,
          (value) => `${Math.round(value * 100)}%`
        ),
        this._toggle('padRumble', 'Vibration'),
      ])),

      el('div', { class: 'field' }, [
        el('button', {
          class: 'btn btn--text',
          type: 'button',
          text: 'Reset to defaults',
          onclick: () => this.settings.reset(),
        }),
        this._install(),
      ])
    );
  }

  /** "Install app", shown only while the browser is offering installation. */
  _install() {
    const field = el('div', { class: 'install', hidden: true }, [
      el(
        'button',
        {
          class: 'btn btn--text install__button',
          type: 'button',
          onclick: () => install(),
        },
        [icon('download', 15), el('span', { text: 'Install app' })]
      ),
      el('p', { class: 'field__hint', text: 'Opens in its own window and works offline.' }),
    ]);

    const update = () => { field.hidden = !canInstall(); };
    onInstallChange(update);
    update();
    return field;
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

    return el('div', { class: 'field', hidden: this.omit.has(key) }, [
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

    return el('div', { class: 'field', hidden: this.omit.has(key) }, [
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

    return el('div', { class: 'field', hidden: this.omit.has(key) }, [
      el('div', { class: 'field__row' }, [
        el('span', { class: 'field__label', text: label }),
        el('div', { class: 'segmented', role: 'group', 'aria-label': label }, buttons),
      ]),
      hint ? el('p', { class: 'field__hint', text: hint }) : null,
    ]);
  }

  setControllerConnected(connected) {
    this.controller.hidden = !connected;
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
