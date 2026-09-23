import { sleep, requireChrome, ensureServer, launch, waitForApp } from '../lib/browser.js';
const out = process.argv[2];
const chrome = requireChrome('toast', true);
const { origin, server } = await ensureServer();
const browser = await launch(chrome);
const fire = () => {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = async () => { window.__prompted = true; };
  window.dispatchEvent(e);
  return e.defaultPrevented;
};
try {
  for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport(vp);
    await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 60000 });
    await waitForApp(page);
    const prevented = await page.evaluate(fire);
    // the hint auto-dismisses at 9s, then 0.4s fade, then 1.5s delay
    await sleep(3000);
    const early = await page.evaluate(() => !document.querySelector('.toast').hidden);
    await sleep(9500);
    const shown = await page.evaluate(() => !document.querySelector('.toast').hidden);
    await page.screenshot({ path: `${out}/${name}.png` });
    await page.click('.toast__install');
    await sleep(600);
    const after = await page.evaluate(() => ({ prompted: window.__prompted, hidden: document.querySelector('.toast').hidden, flag: localStorage.getItem('orrery:install-offered') }));
    await page.reload({ waitUntil: 'load' });
    await waitForApp(page);
    const prevented2 = await page.evaluate(fire);
    await sleep(12000);
    const again = await page.evaluate(() => !document.querySelector('.toast').hidden);
    const settingsLink = await page.evaluate(() => !document.querySelector('.install').hidden);
    console.log(name, { prevented, early, shown, after, prevented2, again, settingsLink, errors });
    await ctx.close();
  }
} finally { await browser.close(); server?.close?.(); }
