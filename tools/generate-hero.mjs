// Regenerate the README hero image (screenshot.png): the app rendered in both themes, composited
// with an almost-vertical diagonal split down the middle, over stacks of every material.
//
// Usage:
//   npm run dev                       # in one terminal (serves http://localhost:5173)
//   npx playwright install chromium   # once
//   npm run hero                      # or: node tools/generate-hero.mjs [url]
//
// Requires WebGPU; the flags below enable it in headless Chromium on macOS.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || process.env.HERO_URL || 'http://localhost:5173/';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshot.png');

// seam geometry: fractions of width for the top and bottom of the split (near-vertical, slight lean)
const SEAM_TOP = 0.52;
const SEAM_BOTTOM = 0.48;

const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => localStorage.clear());
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(2500);

// a stack (tower) of every material, in palette order, laid out in a grid
await page.evaluate(() => {
  const { world, rig, camera } = window.__draft;
  world.clear();
  const ids = [...world.meshes.keys()];
  const COLS = 5, H = 4, GAP = 2;
  ids.forEach((id, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    for (let y = 0; y < H; y++) world.set(col * GAP, y, row * GAP, id);
  });
  const cx = ((COLS - 1) * GAP) / 2, cz = (Math.ceil(ids.length / COLS - 1) * GAP) / 2;
  rig.orbit.target.set(cx, 1.5, cz);
  camera.position.set(cx + 11, 11, cz + 15);
  camera.lookAt(cx, 1.5, cz);
  rig.orbit.update();
  document.getElementById('tb-count').textContent = world.size;
});
await page.waitForTimeout(500);

const light = await page.screenshot();
await page.click('#btn-theme'); // -> blueprint
await page.waitForTimeout(500);
const dark = await page.screenshot();

const toURL = (b) => 'data:image/png;base64,' + b.toString('base64');
const outURL = await page.evaluate(async ([a, b, top, bottom]) => {
  const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const c = document.createElement('canvas'); c.width = ia.naturalWidth; c.height = ia.naturalHeight;
  const x = c.getContext('2d'); const W = c.width, Hh = c.height;
  const xt = top * W, xb = bottom * W;
  x.drawImage(ia, 0, 0);                          // light (paper) on the left
  x.save();                                       // dark (blueprint) on the right of the seam
  x.beginPath(); x.moveTo(xt, 0); x.lineTo(W, 0); x.lineTo(W, Hh); x.lineTo(xb, Hh); x.closePath(); x.clip();
  x.drawImage(ib, 0, 0); x.restore();
  x.strokeStyle = 'rgba(120,120,120,0.7)'; x.lineWidth = 3;
  x.beginPath(); x.moveTo(xt, 0); x.lineTo(xb, Hh); x.stroke();
  return c.toDataURL('image/png');
}, [toURL(light), toURL(dark), SEAM_TOP, SEAM_BOTTOM]);

fs.writeFileSync(OUT, Buffer.from(outURL.split(',')[1], 'base64'));
console.log('wrote', OUT);
await browser.close();
