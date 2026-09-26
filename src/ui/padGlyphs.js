/**
 * Controller buttons, drawn the way the controller in your hands prints them.
 *
 * Bindings are by position (src/core/Gamepads.js), and every make labels the
 * same positions differently: the bottom face button is A on an Xbox pad, a
 * cross on a PlayStation one and B on a Nintendo one.
 */

import { el } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Face buttons by position: bottom (a), right (b), left (x), top (y). */
const FACE = {
  generic: { a: 'A', b: 'B', x: 'X', y: 'Y' },
  xbox: { a: 'A', b: 'B', x: 'X', y: 'Y' },
  nintendo: { a: 'B', b: 'A', x: 'Y', y: 'X' },
  playstation: { a: 'Cross', b: 'Circle', x: 'Square', y: 'Triangle' },
};

/** PlayStation's shapes, on a 16-unit grid. */
const SHAPES = {
  a: ['M4.6 4.6l6.8 6.8', 'M11.4 4.6l-6.8 6.8'],
  b: ['M8 3.7a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6z'],
  x: ['M4.4 4.4h7.2v7.2H4.4z'],
  y: ['M8 3.5l4.7 8.1H3.3z'],
};

const SHOULDER = {
  generic: { lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT' },
  xbox: { lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT' },
  playstation: { lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2' },
  nintendo: { lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR' },
};

/** The two small buttons in the middle. */
const SYSTEM = {
  generic: { view: 'Select', menu: 'Start' },
  xbox: { view: 'View', menu: 'Menu' },
  playstation: { view: 'Create', menu: 'Options' },
  nintendo: { view: '−', menu: '+' },
};

/** Pressing a stick in. */
const CLICK = {
  generic: { l3: 'LS', r3: 'RS' },
  xbox: { l3: 'LS', r3: 'RS' },
  playstation: { l3: 'L3', r3: 'R3' },
  nintendo: { l3: 'LS', r3: 'RS' },
};

/** Which arms of the D-pad glyph are lit. */
const DPAD = {
  dpad: ['up', 'down', 'left', 'right'],
  'dpad-x': ['left', 'right'],
  'dpad-y': ['up', 'down'],
  up: ['up'],
  down: ['down'],
  left: ['left'],
  right: ['right'],
};
const DPAD_CENTRE = 'M6 6h4v4H6z';
const DPAD_ARMS = {
  up: 'M6 1h4v4.6H6z',
  down: 'M6 10.4h4V15H6z',
  left: 'M1 6h4.6v4H1z',
  right: 'M10.4 6H15v4h-4.6z',
};
const DPAD_NAMES = {
  dpad: 'D-pad', 'dpad-x': 'D-pad left or right', 'dpad-y': 'D-pad up or down',
  up: 'D-pad up', down: 'D-pad down', left: 'D-pad left', right: 'D-pad right',
};

/**
 * @param {string} button A position: a b x y, lb rb lt rt, view menu, ls rs
 *   (moving a stick), l3 r3 (pressing one), or dpad, dpad-x, dpad-y, up, down, left, right.
 * @param {string} [family] From src/core/Gamepads.js.
 */
export function padGlyph(button, family = 'generic') {
  const f = FACE[family] ? family : 'generic';

  if (button in FACE.generic) {
    if (f === 'playstation') {
      return el('kbd', { class: 'pad pad--face' }, [shape(SHAPES[button]), hidden(FACE[f][button])]);
    }
    return el('kbd', { class: 'pad pad--face', text: FACE[f][button] });
  }
  if (button in SHOULDER.generic) return el('kbd', { class: 'pad', text: SHOULDER[f][button] });
  if (button in SYSTEM.generic) return el('kbd', { class: 'pad', text: SYSTEM[f][button] });
  if (button in CLICK.generic) return el('kbd', { class: 'pad', text: CLICK[f][button] });
  if (button === 'ls' || button === 'rs') {
    return el('kbd', { class: 'pad pad--stick' }, [
      el('span', { text: button === 'ls' ? 'L' : 'R', 'aria-hidden': 'true' }),
      hidden(button === 'ls' ? 'left stick' : 'right stick'),
    ]);
  }
  if (DPAD[button]) {
    // The arms that matter lit and the rest dimmed, so up and down read as
    // different buttons at a glance.
    const lit = DPAD[button];
    const arms = Object.keys(DPAD_ARMS);
    const svg = shape([DPAD_CENTRE, ...arms.map((arm) => DPAD_ARMS[arm])]);
    [...svg.children].forEach((path, i) => {
      const on = i === 0 ? lit.length === arms.length : lit.includes(arms[i - 1]);
      if (on) path.setAttribute('class', 'pad__lit');
    });
    return el('kbd', { class: 'pad pad--dpad' }, [svg, hidden(DPAD_NAMES[button])]);
  }
  throw new Error(`unknown controller button "${button}"`);
}

export function padGlyphs(buttons, family) {
  return el('span', { class: 'pad-group' }, buttons.map((button) => padGlyph(button, family)));
}

export function padName(family) {
  return {
    xbox: 'Xbox controller',
    playstation: 'PlayStation controller',
    nintendo: 'Nintendo controller',
  }[family] ?? 'Controller';
}

function shape(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-linecap', 'round');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Text for a screen reader where the glyph is a picture. */
function hidden(text) {
  return el('span', { class: 'sr-only', text });
}
