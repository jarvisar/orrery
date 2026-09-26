/**
 * "Update available", in the desktop app only.
 *
 * The desktop app (desktop/src/updates.js) updates itself where it can. Where
 * it cannot - the portable Windows build, macOS, the Linux .deb and .tar.gz -
 * it says so here, once per new version, and the button opens the release
 * page. In a browser window.orreryDesktop is undefined and this never shows.
 *
 * Shares the install toast's styling and corner; the two never coexist.
 */

import { el, icon } from './dom.js';

export class UpdateToast {
  constructor() {
    this.isOpen = false;
    /** The version last shown, so a dismissed one does not come back. */
    this.version = null;

    this.note = el('div', { class: 'toast__note' });
    this.root = el(
      'div',
      { class: 'toast panel', role: 'region', 'aria-label': 'Update available', hidden: true },
      [
        el('div', { class: 'toast__text' }, [
          el('div', { class: 'toast__title', text: 'Update available' }),
          this.note,
        ]),
        el(
          'button',
          {
            class: 'btn toast__install',
            type: 'button',
            onclick: () => {
              this.hide();
              window.orreryDesktop?.openReleasePage?.();
            },
          },
          [icon('download', 15), el('span', { text: 'Download' })]
        ),
        el(
          'button',
          {
            class: 'btn btn--icon toast__close',
            type: 'button',
            title: 'Not now',
            'aria-label': 'Not now',
            onclick: () => this.hide(),
          },
          [icon('close', 16)]
        ),
      ]
    );

    window.orreryDesktop?.onUpdateAvailable?.((info) => this.show(info));
  }

  show({ version }) {
    if (!version || version === this.version) return;
    this.version = version;
    this.note.textContent = `Orrery ${version} is out.`;
    this.isOpen = true;
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('is-visible'));
  }

  hide() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('is-visible');
    setTimeout(() => { this.root.hidden = true; }, 400);
  }
}
