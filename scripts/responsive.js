#!/usr/bin/env node
/**
 * Loads the real page at the screen sizes people actually use and fails on
 * layout that would get in their way, or on an accessibility violation.
 *
 * For every size, in the resting state and with each panel open:
 *   - nothing the interface draws runs off the screen;
 *   - the top bar, info panel and time bar never overlap one another;
 *   - an open menu or panel is not covered by anything else;
 *   - no panel scrolls sideways, no label wraps or is cut short, and no text is
 *     set below 10px;
 *   - text on the solid plates has at least 4.5:1 contrast (WCAG 1.4.3);
 *   - every control is at least 24px square (WCAG 2.5.8), and on touch
 *     screens the primary controls are the full 44px (WCAG 2.5.5);
 *   - Tab reaches the controls in order and every stop shows a focus ring.
 * At one phone and one desktop size it also runs axe-core against WCAG 2.2 AA
 * with each panel open.
 *
 *   npm run responsive                 # skips cleanly if no Chrome is installed
 *   npm run responsive -- --strict     # missing Chrome is a failure (used by CI)
 *   npm run responsive -- --shots=dir  # also saves a screenshot per size and state
 *   npm run responsive -- --only=phone,desktop
 */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { sleep, requireChrome, ensureServer, launch, waitForApp } from './lib/browser.js';

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const SHOTS = args.find((a) => a.startsWith('--shots='))?.slice(8);
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
/** SwiftShader is single-threaded per page; a few pages at once is the sweet spot. */
const CONCURRENCY = Number(process.env.RESPONSIVE_CONCURRENCY) || 3;

const touch = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** Common viewports, smallest first. 320 is the WCAG 1.4.10 reflow width. */
const SIZES = [
  { name: 'phone-small', width: 320, height: 568, ...touch },
  { name: 'phone', width: 375, height: 667, ...touch },
  { name: 'phone-large', width: 390, height: 844, ...touch, axe: true },
  { name: 'android', width: 412, height: 915, ...touch },
  { name: 'phone-landscape', width: 844, height: 390, ...touch },
  { name: 'tablet', width: 768, height: 1024, ...touch },
  { name: 'tablet-landscape', width: 1024, height: 768, ...touch },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1440, height: 900, axe: true },
  { name: 'full-hd', width: 1920, height: 1080 },
].filter((size) => !ONLY || ONLY.includes(size.name));

/**
 * The states worth checking. Each opens something from rest, names the
 * surface that should then be on screen, and is closed again with Escape.
 */
const STATES = [
  { name: 'rest' },
  { name: 'info', open: '.info__header', surface: '.info', when: (s) => s.isMobile },
  { name: 'picker', open: '.picker__button', surface: '.picker__menu' },
  { name: 'tours', open: '.tours__button', surface: '.tours__menu' },
  { name: 'date', open: '.timebar__date', surface: '.when' },
  { name: 'settings', open: '[aria-label="Settings"]', surface: '.drawer' },
  { name: 'help', open: '[aria-label="Controls"]', surface: '.help__card' },
];

const chrome = requireChrome('responsive', STRICT);
const { origin: ORIGIN, server } = await ensureServer();
if (SHOTS) await mkdir(SHOTS, { recursive: true });

const report = new Map();
let exitCode = 0;

try {
  const queue = [...SIZES];
  // One browser per worker: Chrome stops animation frames in background tabs,
  // so pages sharing a window would stall behind whichever is in front.
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      const browser = await launch(chrome);
      try {
        while (queue.length) {
          const size = queue.shift();
          report.set(size.name, await checkSize(browser, size).catch((e) => [`crashed: ${e.message}`]));
        }
      } finally {
        await browser.close();
      }
    })
  );
} finally {
  server?.kill();
}

for (const size of SIZES) {
  const problems = [...new Set(report.get(size.name))];
  const label = `${size.name} (${size.width}×${size.height})`.padEnd(30);
  if (problems.length === 0) {
    console.log(`  ok    ${label}`);
  } else {
    exitCode = 1;
    console.log(`  FAIL  ${label} ${problems.length} problem(s)`);
    for (const problem of problems) console.log(`          - ${problem}`);
  }
}
console.log(exitCode ? '\nresponsive: failed' : `\nresponsive: ok — ${SIZES.length} sizes`);
process.exit(exitCode);

/* ------------------------------------------------------------------------ */

async function checkSize(browser, size) {
  const problems = [];
  const page = await browser.newPage();
  await page.setViewport(size);
  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
  // The first-visit hint is timed and would make runs differ.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('orrery:welcomed', '1'); } catch { /* ignore */ }
  });

  await page.goto(`${ORIGIN}/?body=saturn`, { waitUntil: 'load', timeout: 60_000 });
  await waitForApp(page);
  await sleep(1500);
  if (size.axe) await page.addScriptTag({ path: AXE });

  for (const state of STATES) {
    if (state.when && !state.when(size)) continue;

    if (state.open) {
      await page.$eval(state.open, (node) => node.click());
      await settle(page);
    }

    const found = await page.evaluate(inspect, {
      surface: state.surface ?? null,
      coarse: Boolean(size.hasTouch),
    });
    problems.push(...found.map((p) => `[${state.name}] ${p}`));

    if (state.name === 'rest') {
      problems.push(...(await checkKeyboard(page)).map((p) => `[keyboard] ${p}`));
    }

    if (size.axe) {
      const violations = await page.evaluate(runAxe);
      problems.push(...violations.map((v) => `[${state.name}] axe: ${v}`));
    }

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${size.name}-${state.name}.png` });

    if (state.open) {
      // The info panel toggles; everything else closes on Escape.
      if (state.name === 'info') await page.$eval(state.open, (node) => node.click());
      else await page.keyboard.press('Escape');
      await settle(page);
    }
  }

  await page.close();
  return problems;
}

/**
 * Waits for the interface's fades and slides to finish. Software WebGL can take
 * hundreds of milliseconds a frame, so a fixed delay would sometimes catch a
 * panel still on the first frame of its entrance.
 */
async function settle(page) {
  await sleep(100);
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
      .map((a) => a.finished.catch(() => {}))
  ));
}

/** Runs in the page: layout, overlap, overflow, type, contrast and target size. */
function inspect({ surface, coarse }) {
  const problems = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const SLACK = 1;

  const visible = (node) => {
    if (!node || node.closest('[hidden]')) return false;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    // Faded out by itself or by any ancestor (the flight HUD rests at 0).
    for (let n = node; n; n = n.parentElement) {
      if (Number(getComputedStyle(n).opacity) === 0) return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const describe = (node) => {
    const name = node.getAttribute('aria-label') || node.textContent.trim().slice(0, 24);
    return `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}${name ? ` "${name}"` : ''}`;
  };
  const offscreen = (rect) =>
    rect.left < -SLACK || rect.top < -SLACK || rect.right > vw + SLACK || rect.bottom > vh + SLACK;
  const overlap = (a, b) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > SLACK &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SLACK;

  // 1. Everything the interface draws stays on screen.
  const drawn = document.querySelectorAll(
    '.ui button, .ui input, .info, .timebar, .topbar > *, .tour, .drawer, .help__card, ' +
    '.picker__menu, .tours__menu, .when'
  );
  for (const node of drawn) {
    if (!visible(node)) continue;
    // Items inside a scrolling list may legitimately sit below the fold.
    if (node.closest('.picker__menu, .when, .drawer__body, .help__body, .info__body, .tours__menu') &&
        !node.matches('.picker__menu, .when, .tours__menu')) continue;
    const rect = node.getBoundingClientRect();
    if (offscreen(rect)) {
      problems.push(`${describe(node)} runs off screen at ` +
        `${Math.round(rect.left)},${Math.round(rect.top)}–${Math.round(rect.right)},${Math.round(rect.bottom)}`);
    }
  }

  if (surface) {
    const node = document.querySelector(surface);
    if (!visible(node)) problems.push(`${surface} did not open`);
    else {
      // Nothing else draws over it: a toast or a hint on top of a menu.
      const rect = node.getBoundingClientRect();
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, vh);
      for (const fx of [0.1, 0.5, 0.9]) {
        for (const fy of [0.1, 0.5, 0.9]) {
          const hit = document.elementFromPoint(rect.left + rect.width * fx, top + (bottom - top) * fy);
          if (hit && !node.contains(hit) && !hit.contains(node)) {
            problems.push(`${describe(hit.closest('[class]') ?? hit)} covers ${surface}`);
          }
        }
      }
    }
  }

  // 2. The fixed regions never collide. Floating surfaces (menus, drawers) are
  //    meant to sit over things, so only the resting furniture is compared.
  const regions = ['.brand', '.picker', '.topbar__end', '.info', '.tour', '.timebar']
    .map((selector) => document.querySelector(selector))
    .filter(visible);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (overlap(regions[i].getBoundingClientRect(), regions[j].getBoundingClientRect())) {
        problems.push(`${describe(regions[i])} overlaps ${describe(regions[j])}`);
      }
    }
  }

  // 3. Nothing scrolls or clips sideways.
  if (document.documentElement.scrollWidth > vw + SLACK) {
    problems.push(`the page is ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport`);
  }
  for (const node of document.querySelectorAll(
    '.info__body, .drawer__body, .help__body, .picker__menu, .tours__menu, .when, .timebar, .topbar'
  )) {
    if (visible(node) && node.scrollWidth > node.clientWidth + SLACK) {
      problems.push(`${describe(node)} overflows sideways by ${node.scrollWidth - node.clientWidth}px`);
    }
  }

  // 4. Labels that are meant to be one line stay on one line.
  for (const node of document.querySelectorAll(
    '.timebar__date-main, .timebar__rate, .picker__label, .brand__word, .tours__label, .info__title, .btn'
  )) {
    if (!visible(node)) continue;
    // A text node that wraps is laid out as more than one line box.
    const words = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (words.nextNode()) {
      if (!words.currentNode.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(words.currentNode);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      if (lines.size > 1) {
        problems.push(`${describe(node)} wraps onto ${lines.size} lines`);
        break;
      }
    }
  }

  // The current body's name is the one label that says where you are.
  const name = document.querySelector('.picker__label');
  if (visible(name) && name.scrollWidth > name.clientWidth + SLACK) {
    problems.push(`the body name "${name.textContent}" is cut short`);
  }

  // 5. Type stays readable.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const small = new Set();
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (!walker.currentNode.textContent.trim() || !parent || !visible(parent)) continue;
    if (parent.closest('svg, sup, .stats, #loading')) continue;
    const px = parseFloat(getComputedStyle(parent).fontSize);
    if (px < 10) small.add(`${describe(parent)} is set at ${px}px`);
  }
  problems.push(...small);

  // 6. Text on the solid plates meets WCAG 1.4.3 contrast. (Over the scene
  //    itself there is no fixed background to measure against.)
  const rgba = (css) => (css.match(/[\d.]+/g) ?? []).map(Number);
  const over = ([r, g, b, a = 1], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const page = rgba(getComputedStyle(document.body).backgroundColor);
  const plates = '.drawer, .help__card, .picker__menu, .when, .tours__menu';
  const faint = new Set();
  const texts = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (texts.nextNode()) {
    const parent = texts.currentNode.parentElement;
    const plate = parent?.closest(plates);
    if (!plate || !texts.currentNode.textContent.trim() || !visible(parent)) continue;
    if (parent.closest(':disabled, button:hover')) continue;
    const style = getComputedStyle(parent);
    // The nearest painted background between the text and its plate.
    let bg = over(rgba(getComputedStyle(plate).backgroundColor), page);
    for (let n = parent; n && n !== plate; n = n.parentElement) {
      const fill = rgba(getComputedStyle(n).backgroundColor);
      if (fill.length && (fill[3] ?? 1) > 0) { bg = over(fill, bg); break; }
    }
    const fg = over(rgba(style.color), bg);
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const px = parseFloat(style.fontSize);
    const large = px >= 24 || (px >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) faint.add(`${describe(parent)} has ${ratio.toFixed(2)}:1 contrast`);
  }
  problems.push(...faint);

  // 7. Targets are big enough to hit. Inline text links are exempt under
  //    WCAG 2.5.8; the switch draws small but widens its hit area with ::before.
  const controls = document.querySelectorAll('button, input, select, a[href], [role="option"]');
  for (const node of controls) {
    if (!visible(node) || node.disabled) continue;
    if (node.matches('.info__link, .switch, .marker')) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 24 - SLACK || rect.height < 24 - SLACK) {
      problems.push(`${describe(node)} is only ${Math.round(rect.width)}×${Math.round(rect.height)}px`);
    }
    if (coarse && node.matches('.btn--icon, .tours__button, .picker__button') &&
        (rect.width < 44 - SLACK || rect.height < 44 - SLACK)) {
      problems.push(`${describe(node)} is ${Math.round(rect.width)}×${Math.round(rect.height)}px on a touch screen`);
    }
  }
  const switchHit = document.querySelector('.switch');
  if (switchHit && visible(switchHit)) {
    const hit = getComputedStyle(switchHit, '::before');
    if (hit.content === 'none' || hit.position !== 'absolute') {
      problems.push('.switch lost the ::before that widens its hit area');
    }
  }

  return problems;
}

/** Tabs through the resting interface: every stop must be on screen and show a ring. */
async function checkKeyboard(page) {
  const problems = [];
  await page.evaluate(() => document.activeElement?.blur());
  const seen = new Set();

  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const node = document.activeElement;
      if (!node || node === document.body) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        key: node.className + (node.getAttribute('aria-label') ?? node.textContent.trim().slice(0, 20)),
        name: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 24) || node.tagName,
        ring: (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
              style.boxShadow !== 'none',
        onScreen: rect.right > 0 && rect.bottom > 0 &&
                  rect.left < window.innerWidth && rect.top < window.innerHeight,
      };
    });
    if (!stop) continue;
    if (seen.has(stop.key)) break; // wrapped round
    seen.add(stop.key);
    if (!stop.ring) problems.push(`"${stop.name}" shows no focus ring`);
    if (!stop.onScreen) problems.push(`"${stop.name}" takes focus while off screen`);
  }

  if (seen.size < 6) problems.push(`Tab only reached ${seen.size} controls`);
  await page.evaluate(() => document.activeElement?.blur());
  return problems;
}

/** Runs in the page: axe-core against WCAG 2.2 A and AA. */
async function runAxe() {
  const result = await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    // A 3D scene has no background colour axe can read, so it cannot judge
    // contrast over it; the plates' own contrast is set in style.css.
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.flatMap((v) =>
    v.nodes.slice(0, 3).map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${v.help}`));
}
