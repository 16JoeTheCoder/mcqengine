// Optional end-to-end check with Playwright + Chromium. Skips cleanly when either is missing.
//   node tests/e2e.mjs [screenshot-dir]
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { zipSync } from '../vendor/fflate/fflate.js';
import { readDir } from './helpers.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = process.argv[2] || join(ROOT, 'build', 'e2e');
const PORT = 8000 + Math.floor(Math.random() * 1000);
const URL_ = `http://127.0.0.1:${PORT}/`;

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* try the global install */ }
  try { return createRequire(join(execSync('npm root -g').toString().trim(), 'x'))('playwright'); } catch { return null; }
}

const pw = await loadPlaywright();
if (!pw) { console.log('SKIP e2e: playwright is not installed'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP e2e: cannot launch Chromium (${e.message.split('\n')[0]})`); process.exit(0); }

mkdirSync(SHOTS, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };
// Serve every response with the production Content-Security-Policy from netlify.toml.
const CSP = readFileSync(join(ROOT, 'netlify.toml'), 'utf8').match(/Content-Security-Policy = "([^"]+)"/)[1];
const withCsp = (ctx) => ctx.route('**/*', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': CSP } });
});
const zipOf = (dir, prefix = '') => Buffer.from(zipSync(Object.fromEntries([...readDir(dir)].map(([p, b]) => [prefix + p, b]))));

try {
  for (let i = 0; i < 50; i++) { try { await fetch(URL_); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  await withCsp(context);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());

  await step('home lists the sample pack', async () => {
    await page.goto(URL_);
    await page.getByRole('button', { name: 'Start Synthetic Physics (sample)' }).waitFor();
    const before = problems.length;
    const inline = await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.inlineRan = true';
      document.head.append(s);
      return window.inlineRan === true;
    });
    assert.equal(inline, false, 'CSP blocks inline scripts');
    await page.waitForTimeout(100);
    problems.splice(before); // the violation report from this probe is expected
  });

  await step('exam mode: answer by keyboard, question 2 snapshot shows its diagram only', async () => {
    await page.check('input[value=exam]');
    await page.getByRole('button', { name: 'Start Synthetic Physics (sample)' }).click();
    await page.locator('#play').waitFor();
    await page.keyboard.press('c'); // q01 correct
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => { const i = document.querySelector('#q-area .clip img'); return i && i.complete && i.style.visibility === ''; });
    const geo = await page.evaluate(() => {
      const box = document.querySelector('#q-area .clip').getBoundingClientRect();
      const img = document.querySelector('#q-area .clip img');
      return { ratio: box.width / box.height, natural: img.naturalWidth, alt: img.alt };
    });
    assert.ok(Math.abs(geo.ratio - 818 / 443) < 0.02, `clip aspect ratio ${geo.ratio}`);
    assert.match(geo.alt, /Question 2/);
    await page.locator('#q-area').screenshot({ path: join(SHOTS, 'q2-snapshot.png') });
    assert.match(await page.textContent('#timer'), /left/);
    assert.equal(await page.locator('#palette button').count(), 8);
  });

  await step('exam mode: flag, change answer, end session; results list mistakes', async () => {
    await page.keyboard.press('2'); // q02 B (wrong; answer A)
    await page.keyboard.press('1'); // change to A (right)
    await page.click('#flag-btn');
    assert.equal(await page.getAttribute('#flag-btn', 'aria-pressed'), 'true');
    assert.match(await page.getAttribute('#palette button:nth-child(2)', 'aria-label'), /answered, flagged/);
    await page.keyboard.press('ArrowRight');
    await page.getByRole('button', { name: /^A\b/ }).first().click(); // q03 typed, wrong (answer B)
    await page.click('#end-btn');
    await page.locator('#results').waitFor();
    assert.match(await page.textContent('#score'), /^2 out of 8/);
    assert.equal(await page.locator('#mistakes > li').count(), 6);
    assert.ok(await page.isHidden('#board'), 'leaderboard hidden without a backend');
  });

  await step('explanation dialog opens from review, with cause tags and view original', async () => {
    await page.getByRole('button', { name: 'Explain the answer to Question 3' }).click();
    const dialog = page.locator('#explain');
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /average speed/);
    assert.ok(await dialog.locator('.katex').count() > 0, 'math rendered');
    await dialog.getByRole('button', { name: 'misread' }).click();
    assert.equal(await dialog.getByRole('button', { name: 'misread' }).getAttribute('aria-pressed'), 'true');
    await dialog.getByText('View original').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#explain .clip img')].every((i) => i.complete && i.style.visibility === ''));
    await page.screenshot({ path: join(SHOTS, 'dialog.png') });
    await dialog.getByRole('button', { name: 'Close' }).click();
    assert.ok(!(await dialog.evaluate((d) => d.open)));
    assert.ok(await page.getByText('No explanation yet.').count() > 0);
    await page.check('#alltime');
    assert.match(await page.textContent('#mistakes'), /tagged misread/);
  });

  await step('retry mistakes starts a practice session of stored mistakes', async () => {
    await page.click('#retry-btn');
    await page.locator('#play').waitFor();
    assert.match(await page.textContent('#play-h'), /of 6$/);
    assert.ok(await page.isHidden('#timer') || !(await page.textContent('#timer')).includes('left'));
    await page.click('#home-btn').catch(() => {});
  });

  await step('upload a zipped pack; it survives a reload', async () => {
    await page.goto(URL_);
    await page.setInputFiles('#up-zip', { name: 'fixture.zip', mimeType: 'application/zip', buffer: zipOf(join(ROOT, 'tests/fixtures/valid-typed'), 'valid-typed/') });
    await page.getByRole('button', { name: 'Start Fixture' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Start Fixture' }).click();
    await page.locator('#play').waitFor();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#q-area .fig img')?.naturalWidth > 0);
    assert.equal(await page.locator('#q-area .badge').textContent(), 'redrawn');
    assert.match(await page.locator('#q-area').textContent(), /Unsupported content/);
    await page.click('#end-btn');
    await page.locator('#results').waitFor();
  });

  await step('a bad pack is refused with readable errors', async () => {
    await page.goto(URL_);
    await page.setInputFiles('#up-zip', { name: 'bad.zip', mimeType: 'application/zip', buffer: zipOf(join(ROOT, 'tests/fixtures/invalid-answer')) });
    await page.getByText('This pack was refused').waitFor();
    assert.match(await page.textContent('#upload-msg'), /Question q1: answer "E" is not one of the option keys/);
  });

  await step('an unfinished session can be resumed after a reload', async () => {
    await page.check('input[value=exam]');
    await page.getByRole('button', { name: 'Start Synthetic Physics (sample)' }).click();
    await page.locator('#play').waitFor();
    await page.keyboard.press('d');
    await page.reload();
    await page.getByRole('button', { name: 'Resume' }).click();
    await page.locator('#play').waitFor();
    assert.equal(await page.getAttribute('#options button[value=D]', 'aria-pressed'), 'true');
    await page.click('#end-btn');
    await page.locator('#results').waitFor();
  });

  await step('phone width 360px: practice mode end to end without horizontal scrolling', async () => {
    const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    await withCsp(phone);
    const p = await phone.newPage();
    p.on('dialog', (d) => d.accept());
    p.on('pageerror', (e) => problems.push(`pageerror (phone): ${e.message}`));
    await p.goto(URL_);
    await p.check('input[value=practice]');
    await p.getByRole('button', { name: 'Start Synthetic Physics (sample)' }).tap();
    await p.locator('#play').waitFor();
    const keys = 'CABCBBDA'; // last one wrong
    for (let i = 0; i < keys.length; i++) {
      await p.locator(`#options button[value=${keys[i]}]`).tap();
      if (i < keys.length - 1) {
        await p.locator('#feedback .good, #feedback .bad').waitFor();
        if (i === 1) await p.screenshot({ path: join(SHOTS, 'phone-practice.png'), fullPage: true });
        const wide = await p.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(wide <= 360, `page is ${wide}px wide at question ${i + 1}`);
        await p.locator('#next-btn').tap();
      }
    }
    await p.locator('#results').waitFor();
    assert.match(await p.textContent('#score'), /^7 out of 8/);
    const small = await p.evaluate(() => [...document.querySelectorAll('button:not([hidden])')]
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent));
    assert.deepEqual(small, [], 'tap targets under 44px');
    await p.screenshot({ path: join(SHOTS, 'phone-results.png'), fullPage: true });
    await phone.close();
  });

  assert.deepEqual(problems, [], 'no page errors or CSP/console errors');
  console.log(`\n${steps.length} e2e steps passed. Screenshots in ${SHOTS}`);
} finally {
  await browser.close();
  server.kill();
}
