/**
 * Keyboard reference.
 *
 * The old build documented its controls only in the repository README, and what
 * it documented had drifted from what the code did - W and S were described as
 * forward and back when they actually moved the camera up and down. Keeping the
 * reference in the app at least puts it next to the thing it describes; the
 * handlers themselves live in `src/main.js`.
 */

import { el, icon, trapFocus } from './dom.js';

/** Display order for the controls dialog. */
export const SHORTCUTS = [
  {
    group: 'Getting around',
    items: [
      { keys: ['Drag'], desc: 'Orbit the camera' },
      { keys: ['Scroll'], desc: 'Zoom in and out' },
      { keys: ['Right-drag'], desc: 'Pan' },
      { keys: ['Click'], desc: 'Focus a body' },
      { keys: ['Esc'], desc: 'Free view, or exit flight' },
      { keys: ['['], desc: 'Previous body' },
      { keys: [']'], desc: 'Next body' },
      { keys: ['F'], desc: 'Re-frame current body' },
    ],
  },
  {
    group: 'Time',
    items: [
      { keys: ['Space'], desc: 'Play or pause' },
      { keys: [','], desc: 'Slower' },
      { keys: ['.'], desc: 'Faster' },
      { keys: ['R'], desc: 'Reverse direction' },
      { keys: ['N'], desc: 'Jump to now' },
    ],
  },
  {
    group: 'Flight mode',
    items: [
      { keys: ['G'], desc: 'Enter or leave flight' },
      { keys: ['W', 'S'], desc: 'Throttle up and down' },
      { keys: ['A', 'D'], desc: 'Roll' },
      { keys: ['Shift'], desc: 'Boost' },
      { keys: ['Space'], desc: 'Full stop' },
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

export class HelpOverlay {
  constructor() {
    this.isOpen = false;
    this._releaseFocus = null;

    const body = el(
      'div',
      { class: 'help__body' },
      SHORTCUTS.map((section) =>
        el('div', {}, [
          el('h3', { class: 'section-title', text: section.group }),
          ...section.items.map((item) =>
            el('div', { class: 'keyrow' }, [
              el('span', { class: 'keyrow__desc', text: item.desc }),
              el(
                'span',
                { class: 'keyrow__keys' },
                item.keys.map((key) => el('kbd', { text: key }))
              ),
            ])
          ),
        ])
      )
    );

    const footer = el('div', { class: 'help__footer' }, [
      el('span', {
        class: 'help__note',
        text: 'Positions come from J2000 orbital elements; sizes and distances are compressed.',
      }),
      el(
        'a',
        {
          class: 'btn help__source',
          href: 'https://github.com/jarvisar/solar-system',
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
        'aria-label': 'Keyboard controls',
        onclick: (event) => { if (event.target === this.root) this.close(); },
      },
      [this.card]
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
