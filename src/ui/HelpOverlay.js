/**
 * Keyboard and controller reference. The handlers live in `src/main.js`; keep
 * this list in step with them.
 *
 * Controller buttons are drawn as the connected controller labels them, and
 * while one is connected its sections come first.
 */

import { el, icon, trapFocus } from './dom.js';
import { padGlyph } from './padGlyphs.js';

export const SHORTCUTS = [
  {
    group: 'Getting around',
    items: [
      { keys: ['Drag'], desc: 'Orbit the camera' },
      { keys: ['Scroll'], desc: 'Zoom in and out' },
      { keys: ['Right-drag'], desc: 'Pan' },
      { keys: ['Click'], desc: 'Focus a body' },
      { keys: ['Click a ringed star'], desc: 'Travel there (whole system view)' },
      { keys: ['H'], desc: 'The whole system' },
      { keys: ['Esc'], desc: 'Free view, or exit flight' },
      { keys: ['[', ']'], desc: 'Previous or next body' },
      { keys: ['F'], desc: 'Re-frame current body' },
    ],
  },
  {
    group: 'Time',
    items: [
      { keys: ['Space'], desc: 'Play or pause' },
      { keys: [',', '.'], desc: 'Slower or faster' },
      { keys: ['R'], desc: 'Reverse direction' },
      { keys: ['N'], desc: 'Jump to now' },
      { keys: ['Click the date'], desc: 'Go to a date or moment' },
    ],
  },
  {
    group: 'Tours',
    items: [
      { keys: ['T'], desc: 'Choose a tour' },
      { keys: ['←', '→'], desc: 'Previous or next stop' },
      { keys: ['Esc'], desc: 'End the tour' },
    ],
  },
  {
    group: 'Flight mode',
    items: [
      { keys: ['G'], desc: 'Enter or leave flight' },
      { keys: ['Click a label'], desc: 'Fly there on autopilot' },
      { keys: ['[', ']'], desc: 'Previous or next destination' },
      { keys: ['F'], desc: 'Autopilot on or off' },
      { keys: ['Mouse'], desc: 'Steer (click to take the controls)' },
      { keys: ['W', 'S'], desc: 'Throttle up and down (or scroll)' },
      { keys: ['A', 'D'], desc: 'Roll' },
      { keys: ['Shift'], desc: 'Boost' },
      { keys: ['Space'], desc: 'Brake' },
      { keys: ['Esc'], desc: 'Free the mouse, then leave flight' },
    ],
  },
  {
    group: 'Virtual reality',
    items: [
      { keys: ['Trigger'], desc: 'Select a body or a button' },
      { keys: ['Grip'], desc: 'Grab and move the system' },
      { keys: ['Both grips'], desc: 'Scale and turn it' },
      { keys: ['Left stick'], desc: 'Fly (click to go faster)' },
      { keys: ['Right stick'], desc: 'Turn, and zoom' },
      { keys: ['A', 'B'], desc: 'Play or pause / whole system' },
      { keys: ['X', 'Y'], desc: 'Previous or next body' },
    ],
  },
  {
    group: 'Virtual reality, by hand',
    items: [
      { keys: ['Pinch'], desc: 'Select a body or a button' },
      { keys: ['Pinch and drag'], desc: 'Grab and move the system' },
      { keys: ['Both hands'], desc: 'Pinch and pull to scale and turn it' },
      { keys: ['Fingertip'], desc: 'Touch a panel button' },
      { keys: ['Left palm'], desc: 'Turn it to you to bring the panel' },
    ],
  },
  {
    group: 'Interface',
    items: [
      { keys: ['O'], desc: 'Toggle orbit paths' },
      { keys: ['I'], desc: 'Toggle the info panel' },
      { keys: ['P'], desc: 'Toggle the performance readout' },
      { keys: ['?'], desc: 'Open this list' },
    ],
  },
];

/** Controller buttons by position; see src/ui/padGlyphs.js. */
export const CONTROLLER = [
  {
    group: 'Controller',
    items: [
      { pad: ['ls'], desc: 'Orbit the camera' },
      { pad: ['rs'], desc: 'Pan' },
      { pad: ['lt', 'rt'], desc: 'Zoom out and in' },
      { pad: ['dpad-x'], desc: 'Previous or next body, or tour stop' },
      { pad: ['y'], desc: 'The whole system' },
      { pad: ['r3'], desc: 'Re-frame current body' },
      { pad: ['l3'], desc: 'Toggle the info panel' },
      { pad: ['b'], desc: 'Free view, or end the tour' },
      { pad: ['view'], desc: 'Full screen' },
    ],
  },
  {
    group: 'Controller: time',
    items: [
      { pad: ['a'], desc: 'Play or pause' },
      { pad: ['lb', 'rb'], desc: 'Slower or faster' },
      { pad: ['down'], desc: 'Reverse direction' },
      { pad: ['up'], desc: 'Jump to now' },
    ],
  },
  {
    group: 'Controller: flight',
    items: [
      { pad: ['x'], desc: 'Enter or leave flight' },
      { pad: ['ls'], desc: 'Steer' },
      { pad: ['rs'], desc: 'Roll' },
      { pad: ['lt', 'rt'], desc: 'Throttle down and up' },
      { pad: ['a'], desc: 'Boost (hold)' },
      { pad: ['dpad-x'], desc: 'Previous or next destination' },
      { pad: ['y'], desc: 'Autopilot on or off' },
    ],
  },
  {
    group: 'Controller: menus',
    items: [
      { pad: ['menu'], desc: 'Move round the interface' },
      { pad: ['dpad'], desc: 'Move between controls (or left stick)' },
      { pad: ['a'], desc: 'Press' },
      { pad: ['b'], desc: 'Back, or close' },
      { pad: ['rs'], desc: 'Scroll' },
    ],
  },
];

export class HelpOverlay {
  /** @param {{exoplanet?: boolean}} [options] Around another star: no tours, and its own sources. */
  constructor({ exoplanet = false } = {}) {
    this.exoplanet = exoplanet;
    this.isOpen = false;
    this._releaseFocus = null;
    /** The connected controller's make, or null with none connected. */
    this._family = null;

    // Focusable so the list can be scrolled from the keyboard when it overflows.
    const body = el('div', { class: 'help__body', tabindex: '0', role: 'region', 'aria-label': 'Controls' });
    this.body = body;
    this._render();

    const footer = el('div', { class: 'help__footer' }, [
      el('span', {
        class: 'help__note',
        text: exoplanet
          ? 'Planets and stars from the NASA Exoplanet Archive; orbital phases are illustrative, and ' +
            'sizes and distances are compressed. The sky is the view from Earth (Yale Bright Star Catalogue).'
          : 'Positions come from J2000 orbital elements and poles from the IAU; sizes and ' +
            'distances are compressed. Stars from the Yale Bright Star Catalogue.',
      }),
      el(
        'a',
        {
          class: 'btn help__source',
          href: 'https://github.com/jarvisar/orrery',
          target: '_blank',
          rel: 'noopener',
        },
        [icon('github', 16), el('span', { text: 'Source' })]
      ),
    ]);

    this.card = el('div', { class: 'help__card panel' }, [
      el('div', { class: 'drawer__header' }, [
        el('h2', { class: 'drawer__title', text: 'Controls' }),
        el(
          'button',
          {
            class: 'btn btn--icon drawer__close',
            type: 'button',
            'aria-label': 'Close',
            onclick: () => this.close(),
          },
          [icon('close')]
        ),
      ]),
      body,
      footer,
    ]);

    this.root = el(
      'div',
      {
        class: 'help',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Controls',
        onclick: (event) => { if (event.target === this.root) this.close(); },
      },
      [this.card]
    );
  }

  /** Draws controller sections for this make, first; null puts them after the keyboard's. */
  setController(family) {
    if (family === this._family) return;
    this._family = family;
    this._render();
  }

  _render() {
    const family = this._family ?? 'generic';
    const shortcuts = this.exoplanet ? SHORTCUTS.filter((section) => section.group !== 'Tours') : SHORTCUTS;
    const sections = this._family ? [...CONTROLLER, ...shortcuts] : [...shortcuts, ...CONTROLLER];
    this.body.replaceChildren(
      ...sections.map((section) =>
        el('div', {}, [
          el('h3', { class: 'section-title', text: section.group }),
          ...section.items.map((item) =>
            el('div', { class: 'keyrow' }, [
              el('span', { class: 'keyrow__desc', text: item.desc }),
              el(
                'span',
                { class: 'keyrow__keys' },
                item.pad
                  ? item.pad.map((button) => padGlyph(button, family))
                  : item.keys.map((key) => el('kbd', { text: key }))
              ),
            ])
          ),
        ])
      )
    );
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.isOpen = true;
    this.root.classList.add('is-open');
    this._releaseFocus = trapFocus(this.card);
    this.card.querySelector('button')?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('is-open');
    this._releaseFocus?.();
    this._releaseFocus = null;
  }
}
