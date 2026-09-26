/**
 * A one-time suggestion to install the app.
 *
 * Shown at most once per browser, after the first-visit hint, and it stays
 * until answered since it never comes back. After that, the settings panel
 * link is the way to install.
 */

import { el, icon } from './dom.js';
import { canInstall, install, markOffered, onInstallChange, wasOffered } from './install.js';

/** A beat after the scene appears, so it does not arrive with the loading screen. */
const DELAY_MS = 1500;

export class InstallToast {
  constructor() {
    this.isOpen = false;
    this._waiting = false;

    this.root = el(
      'div',
      { class: 'toast panel', role: 'region', 'aria-label': 'Install Orrery', hidden: true },
      [
        el('div', { class: 'toast__text' }, [
          el('div', { class: 'toast__title', text: 'Install Orrery' }),
          el('div', { class: 'toast__note', text: 'Its own window, and it works offline.' }),
        ]),
        el(
          'button',
          {
            class: 'btn toast__install',
            type: 'button',
            onclick: () => {
              this.hide();
              install();
            },
          },
          [icon('download', 15), el('span', { text: 'Install' })]
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

    // Installed from the settings panel, or the browser withdrew the offer.
    onInstallChange(() => {
      if (!canInstall()) this.hide();
    });
  }

  /** Shows the toast, once ever, whenever the browser offers installation. */
  offer() {
    if (this._waiting || wasOffered()) return;
    this._waiting = true;

    const stop = onInstallChange(() => {
      if (canInstall()) { stop(); this._show(); }
    });
    if (canInstall()) { stop(); this._show(); }
  }

  _show() {
    setTimeout(() => {
      if (!canInstall() || wasOffered()) return;
      markOffered();
      this.isOpen = true;
      this.root.hidden = false;
      requestAnimationFrame(() => this.root.classList.add('is-visible'));
    }, DELAY_MS);
  }

  hide() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('is-visible');
    setTimeout(() => { this.root.hidden = true; }, 400);
  }
}
