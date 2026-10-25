// Renders PNG app icons from the SVG sources. Run: node scripts/icons.mjs (repo root, any terminal).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const browser = await chromium.launch();
const page = await browser.newPage();
const jobs = [
  ['public/icons/icon.svg', 'public/icons/icon-192.png', 192],
  ['public/icons/icon.svg', 'public/icons/icon-512.png', 512],
  ['public/icons/maskable.svg', 'public/icons/maskable-512.png', 512],
  ['public/icons/icon.svg', 'public/icons/apple-touch-icon.png', 180],
];
for (const [src, out, size] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${readFileSync(src).toString('base64')}" width="${size}" height="${size}">`);
  await page.screenshot({ path: out, omitBackground: true });
}
await browser.close();
console.log('ok icons written');
