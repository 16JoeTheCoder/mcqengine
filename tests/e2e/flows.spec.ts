import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { importViaPaste, keyFor, startPaper, syntheticDoc } from './helpers';

test('import via paste, full exam, results', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await startPaper(page);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(keyFor(i));
    if (i < 3) await page.keyboard.press('ArrowRight');
  }
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('4/4')).toBeVisible();
  await expect(page.getByText('Counts toward your trend')).toBeVisible();
});

test('timer auto-submits at zero (controlled clock)', async ({ page }) => {
  await page.clock.install();
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4, minutes: 2 }]));
  await startPaper(page);
  await page.keyboard.press(keyFor(0));
  await expect(page.locator('.clock')).toHaveText(/^[12]:\d\d$/);
  await page.clock.fastForward('01:00');
  await expect(page.locator('.clock')).toHaveText(/^[01]:\d\d$/);
  await page.clock.fastForward('01:05');
  await expect(page.getByText('Submitted at time zero')).toBeVisible();
  await expect(page.getByText('1/4')).toBeVisible();
});

test('save, reload, resume keeps answers and frozen time', async ({ page }) => {
  await page.clock.install();
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4, minutes: 10 }]));
  await startPaper(page);
  await page.keyboard.press('c');
  await page.clock.fastForward('02:00');
  const before = await page.locator('.clock').textContent();
  await page.getByRole('button', { name: 'End session' }).click();
  await page.getByRole('button', { name: /Save for later/ }).click();
  await expect(page).toHaveURL(/#\/pack\//);
  await page.clock.fastForward('30:00');
  await page.reload();
  const dlg = page.getByRole('dialog', { name: 'Resume your session?' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText('1 of 4 answered', { exact: false })).toBeVisible();
  await dlg.getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('.clock')).toHaveText(before!.trim());
  await expect(page.getByRole('radio', { name: /Option C/ })).toHaveAttribute('aria-checked', 'true');
});

test('submit partial grades only answered questions', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await startPaper(page);
  await page.getByRole('radio', { name: /Option B/ }).click();
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('Partial', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText(/Partial: 3 unanswered not graded/)).toBeVisible();
  await expect(page.getByText('100%')).toBeVisible();
});

test('random exhausts unseen questions, then a mistakes drill', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }, { id: 'p2', count: 4 }]));
  const seen = new Set<string>();
  for (let round = 0; round < 2; round++) {
    await page.getByRole('button', { name: /unseen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Practice' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('.qcard')).toBeVisible();
    for (let i = 0; i < 4; i++) {
      await expect(page.locator('#qhead')).toHaveText(`Question ${i + 1}`);
      const stem = (await page.locator('.qtext').textContent())!;
      expect(seen.has(stem)).toBe(false);
      seen.add(stem);
      await page.keyboard.press('a'); // practice: answers lock on choice; A is wrong for most
      if (i < 3) await page.keyboard.press('ArrowRight');
    }
    await page.getByRole('button', { name: 'Finish' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
    await page.getByRole('button', { name: /Back to pack/ }).click();
  }
  expect(seen.size).toBe(8);
  await expect(page.getByRole('button', { name: /0% unseen/ })).toBeVisible();
  await page.getByRole('button', { name: /in bank/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.qs-title .t')).toHaveText('Mistakes drill');
});

test('works offline after first load', async ({ page, context }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Synthetic Physics', level: 1 })).toBeVisible();
  await startPaper(page);
  await context.setOffline(false);
});

test('export everything, wipe, import restores', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await page.goto('./#/settings');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export everything' }).click();
  const file = await (await dl).path();
  await page.getByRole('button', { name: /Erase all data/ }).click();
  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase everything' }).click();
  await expect(page.getByRole('button', { name: 'Make a pack with AI' })).toBeVisible();
  await page.getByRole('button', { name: 'Import a pack file' }).click();
  await page.getByRole('dialog').locator('input[type=file]').first().setInputFiles({ name: 'dmc-everything.zip', mimeType: 'application/zip', buffer: readFileSync(file!) });
  await expect(page.getByText('Checksum verified')).toBeVisible();
  await page.getByRole('button', { name: 'Import backup' }).click();
  await expect(page.getByText('Backup imported.')).toBeVisible();
  await page.goto('./');
  await expect(page.getByText('Synthetic Physics')).toBeVisible();
});

test('validation errors produce a fix prompt', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Import a pack file' }).click();
  const doc = syntheticDoc([{ id: 'p1', count: 3 }]);
  (doc.papers[0]!.questions[1] as { options: string[] }).options = ['a', 'b', 'c'];
  await page.getByRole('dialog').locator('textarea').fill(JSON.stringify(doc));
  await expect(page.getByText('papers[0].questions[1].options')).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: /Copy fix prompt/ }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('Expected 4 options, found 3');
});

test('no serious accessibility violations on main screens', async ({ page }) => {
  const check = async (name: string) => {
    await page.waitForTimeout(500);
    const r = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${name}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
  };
  await page.goto('./');
  await check('onboarding');
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await check('pack');
  await startPaper(page);
  await check('question');
  await page.keyboard.press('b');
  await page.getByRole('button', { name: 'End session' }).click();
  await check('end modal');
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Review', { exact: true })).toBeVisible();
  await check('results');
  await page.goto('./#/settings');
  await check('settings');
});
