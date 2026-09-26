/**
 * Draws the app icons in desktop/build/ from the site's own icon,
 * public/icon/orrery.svg, so the desktop app always matches the web app.
 *
 *   npm run icons      (in desktop/; runs under Electron, which does the drawing)
 *
 *   build/icon.png      1024², the SVG as it is: Windows and Linux
 *   build/icon-mac.png  1024², inset on Apple's icon grid with its soft shadow,
 *                       since macOS draws icons as they are rather than masking them
 *
 * electron-builder turns these into .ico and .icns. build/icons.json records
 * which SVG they were drawn from, so `npm run desktop:check` fails once the
 * SVG changes and they have not been redrawn.
 */
import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(DESKTOP, '../public/icon/orrery.svg');
const OUT = join(DESKTOP, 'build');
const SIZE = 1024;

const svg = readFileSync(SOURCE);

const ICONS = [
  { file: 'icon.png', inset: 0, shadow: false },
  // Apple's grid: an 824 px body centred on 1024, with a shadow below it.
  { file: 'icon-mac.png', inset: 100, shadow: true },
];

app.dock?.hide();

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  for (const icon of ICONS) {
    const png = await win.webContents.executeJavaScript(draw(icon));
    writeFileSync(join(OUT, icon.file), Buffer.from(png.split(',')[1], 'base64'));
    console.log(`icons: build/${icon.file}`);
  }
  // Line endings normalised, as desktop/scripts/check.js does: a Windows
  // checkout has CRLF, and that is not a change.
  const source = hash(svg.toString('utf8').replace(/\r\n/g, '\n'));
  writeFileSync(join(OUT, 'icons.json'), `${JSON.stringify({ source }, null, 2)}\n`);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

/** Page script: the SVG drawn onto a transparent canvas, as a PNG data URL. */
function draw({ inset, shadow }) {
  const body = SIZE - inset * 2;
  return `(async () => {
    const img = new Image(${body}, ${body});
    img.src = 'data:image/svg+xml;base64,${svg.toString('base64')}';
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ${SIZE};
    const ctx = canvas.getContext('2d');
    ${shadow ? "ctx.filter = 'drop-shadow(0 10px 14px rgba(0, 0, 0, 0.32))';" : ''}
    ctx.drawImage(img, ${inset}, ${inset}, ${body}, ${body});
    return canvas.toDataURL('image/png');
  })()`;
}

function hash(data) {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}
