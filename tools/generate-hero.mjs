// Regenerate the README hero image (screenshot.png): the app rendered in all four sheet styles,
// composited as near-vertical diagonal slices over one continuous stack of every material. All four
// shots share one camera, so the build lines up across the seams and reads as a single model
// recoloured band by band.
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

// three internal seams (fractions of width) between the four slices, each leaning slightly
const SEAMS = [{ t: 0.27, b: 0.23 }, { t: 0.52, b: 0.48 }, { t: 0.77, b: 0.73 }];

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
  camera.position.set(cx + 6, 6.5, cz + 8.5); // close 3/4 view so the build fills all four slices
  camera.lookAt(cx, 1.5, cz);
  rig.orbit.update();
  document.getElementById('tb-count').textContent = world.size;
});
await page.waitForTimeout(500);

// one shot per sheet style; V cycles paper -> blueprint -> console -> cga
const shots = [await page.screenshot()];
for (let k = 1; k < 4; k++) {
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(500);
  shots.push(await page.screenshot());
}

const toURL = (b) => 'data:image/png;base64,' + b.toString('base64');
const outURL = await page.evaluate(async ([imgs, seams]) => {
  const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  const els = await Promise.all(imgs.map(load));
  const c = document.createElement('canvas');
  c.width = els[0].naturalWidth; c.height = els[0].naturalHeight;
  const x = c.getContext('2d'); const W = c.width, H = c.height;
  const X = (f) => f * W;
  const bounds = [{ t: 0, b: 0 }, ...seams, { t: 1, b: 1 }]; // slice edges, left to right
  els.forEach((img, k) => {
    const L = bounds[k], R = bounds[k + 1];
    x.save();
    x.beginPath();
    x.moveTo(X(L.t), 0); x.lineTo(X(R.t), 0); x.lineTo(X(R.b), H); x.lineTo(X(L.b), H); x.closePath();
    x.clip();
    x.drawImage(img, 0, 0);
    x.restore();
  });
  x.strokeStyle = 'rgba(120,120,120,0.7)'; x.lineWidth = 3;
  for (const s of seams) { x.beginPath(); x.moveTo(X(s.t), 0); x.lineTo(X(s.b), H); x.stroke(); }
  return c.toDataURL('image/png');
}, [shots.map(toURL), SEAMS]);

fs.writeFileSync(OUT, Buffer.from(outURL.split(',')[1], 'base64'));
console.log('wrote', OUT);
await browser.close();
