/**
 * Small DOM helpers. The interface is built here rather than in index.html so
 * each panel owns its markup, and index.html stays small enough to paint the
 * loading screen at once.
 */

/**
 * @param {string} tag
 * @param {object} [props] Attributes; `class`, `text`, `html` and `on*` handlers
 *   are treated specially, everything else is set as an attribute.
 * @param {Array<Node|string|null|undefined>} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') {
      // Custom properties are only reachable through setProperty.
      for (const [name, v] of Object.entries(value)) {
        if (name.startsWith('--')) node.style.setProperty(name, v);
        else node.style[name] = v;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG element, with each of `attributes` set as an attribute. */
export function svgEl(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/** Inline SVG icon. Paths are stroked with `currentColor` by the stylesheet. */
export function icon(name, size = 18) {
  const paths = ICONS[name];
  if (!paths) throw new Error(`unknown icon "${name}"`);

  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    'aria-hidden': 'true',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  for (const d of paths) svg.append(svgEl('path', { d }));
  return svg;
}

const ICONS = {
  play: ['M8 5.5v13l11-6.5z'],
  pause: ['M9.5 5v14', 'M14.5 5v14'],
  reverse: ['M3 12a9 9 0 1 0 2.64-6.36L3 8.3', 'M3 3.5v4.8h4.8'],
  settings: [
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z',
    'M19.4 14.4a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.46v.17a1.94 1.94 0 1 1-3.88 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-1H2.4a1.94 1.94 0 1 1 0-3.88h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06A1.94 1.94 0 1 1 6.32 3.1l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 1-1.46V2.4a1.94 1.94 0 1 1 3.88 0v.09a1.6 1.6 0 0 0 1 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.46 1h.17a1.94 1.94 0 1 1 0 3.88h-.09a1.6 1.6 0 0 0-1.45 1z',
  ],
  help: ['M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  search: ['M10.5 3a7.5 7.5 0 1 0 0 15a7.5 7.5 0 0 0 0-15', 'M16 16l5 5'],
  chevron: ['M6 9l6 6 6-6'],
  back: ['M15 6l-6 6 6 6'],
  next: ['M9 6l6 6-6 6'],
  link: [
    'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  ],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  rocket: [
    'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z',
    'M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z',
    'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0',
    'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  ],
  vr: [
    'M5.5 6.5h13A2.5 2.5 0 0 1 21 9v6a2.5 2.5 0 0 1-2.5 2.5h-3.3a2 2 0 0 1-1.6-.8l-.8-1.07a1 1 0 0 0-1.6 0l-.8 1.07a2 2 0 0 1-1.6.8H5.5A2.5 2.5 0 0 1 3 15V9a2.5 2.5 0 0 1 2.5-2.5z',
    'M9.5 12a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z',
    'M18 12a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z',
  ],
  github: [
    'M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22',
  ],
};

export function formatKm(km) {
  if (km >= 1e8) return `${(km / 1e6).toFixed(1)} million km`;
  if (km >= 1e6) return `${(km / 1e6).toFixed(2)} million km`;
  if (km >= 1000) return `${Math.round(km).toLocaleString()} km`;
  return `${km.toFixed(1)} km`;
}

/**
 * Says something to a screen reader without showing it: what a shortcut, a
 * controller or the scene just did, which otherwise happens silently.
 */
export function announce(text) {
  if (!announcer) {
    announcer = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    document.body.append(announcer);
  }
  // Cleared first, so the same words twice in a row are read twice.
  announcer.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { announcer.textContent = text; }, 60);
}

let announcer = null;
let announceTimer = 0;

/** True where a key press is text entry. Sliders and switches do not count. */
export function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(target.type);
}

/** Traps Tab within `container` while it is open, and restores focus on close. */
export function trapFocus(container) {
  const previous = document.activeElement;
  const selector =
    'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function onKeyDown(event) {
    if (event.key !== 'Tab') return;
    const items = [...container.querySelectorAll(selector)].filter((n) => n.offsetParent !== null);
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  container.addEventListener('keydown', onKeyDown);
  return () => {
    container.removeEventListener('keydown', onKeyDown);
    previous?.focus?.();
  };
}
