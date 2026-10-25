import { expect, test } from './fixtures';
import { importViaPaste, keyFor, syntheticDoc } from './helpers';
import { markSchemePdf, questionPaperPdf } from '../fixtures/pdf';
import { bothThemes } from './a11y';

test('submit without a key, then attach one: the session is regraded', async ({ page }) => {
  const d = syntheticDoc([{ id: 'p1', count: 4 }]);
  for (const q of d.papers[0]!.questions) (q as { answer: unknown }).answer = null;
  await importViaPaste(page, d);
  await page.locator('.paper-card').first().click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('button', { name: 'Practice' })).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.qcard')).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(keyFor(i));
    if (i < 3) await page.keyboard.press('ArrowRight');
  }
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Awaiting key', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add the key' }).click();
  const kd = page.getByRole('dialog', { name: 'Synthetic Paper 1: key and details' });
  await kd.getByLabel('Type or paste the key').fill('BCDB'); // q4 wrong on purpose
  await kd.getByRole('button', { name: 'Fill grid' }).click();
  await kd.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('3/4')).toBeVisible();
  await expect(page.getByText('Awaiting key', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Counts toward your trend')).toBeVisible();
});

test('PDF papers: mark scheme read into a grid, practised from the PDF, snipped', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: /Import a pack file/ }).click();
  await page.getByRole('dialog').locator('input[type=file][accept*=pdf]').setInputFiles([
    { name: '9702_s23_qp_12.pdf', mimeType: 'application/pdf', buffer: Buffer.from(questionPaperPdf(4, 2)) },
    { name: '9702_s23_ms_12.pdf', mimeType: 'application/pdf', buffer: Buffer.from(markSchemePdf('BCDA')) },
  ]);
  const dlg = page.getByRole('dialog', { name: 'Add PDF papers' });
  await expect(dlg.getByLabel('Title of 9702_s23_qp_12.pdf')).toHaveValue('May/June 2023 Paper 12');
  await expect(dlg.getByLabel('Questions')).toHaveValue('4');
  await expect(dlg.getByLabel('Minutes')).toHaveValue('75');
  await expect(dlg.getByText('Read, not confirmed')).toBeVisible();
  await dlg.getByRole('button', { name: 'Check key' }).click();
  const key = page.getByRole('dialog', { name: /Key for/ });
  await expect(key.getByRole('radiogroup', { name: 'Question 1' }).getByRole('radio', { name: 'B' })).toHaveAttribute('aria-checked', 'true');
  await key.getByRole('button', { name: 'Confirm key' }).click();
  await expect(dlg.getByText('Key confirmed')).toBeVisible();
  await dlg.getByRole('button', { name: /Add 1 paper/ }).click();
  await expect(page.getByRole('heading', { name: 'Physics 9702', level: 1 })).toBeVisible();

  await page.locator('.paper-card').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Practice' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start', exact: true }).click();
  const canvas = page.locator('.pdf-pane canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(200);
  await page.keyboard.press('b');
  await expect(page.getByText('Correct', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'End session' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Save for later/ }).click();

  await page.getByRole('button', { name: 'Discard' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.locator('.paper-card').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Snip questions' }).click();
  const snip = page.getByRole('dialog', { name: /Snip questions/ });
  await expect(snip.locator('canvas')).toBeVisible();
  await snip.getByRole('button', { name: 'Top half' }).click();
  await snip.getByRole('button', { name: 'Save as question 1' }).click();
  await expect(snip.getByText('1 of 4 snipped', { exact: false })).toBeVisible();
  await expect(snip.getByLabel('Question number')).toHaveValue('2');
});

test('third attempt with a new best: personal best moment and a result card PNG', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  for (const right of [2, 3, 4]) {
    await page.locator('.paper-card').first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('.qcard')).toBeVisible();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press(i < right ? keyFor(i) : 'a' === keyFor(i) ? 'b' : 'a');
      if (i < 3) await page.keyboard.press('ArrowRight');
    }
    await page.getByRole('button', { name: 'Finish' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText(`${right}/4`)).toBeVisible();
    if (right < 4) await page.getByRole('button', { name: /Back to pack/ }).click();
  }
  await expect(page.getByText('Personal best', { exact: true })).toBeVisible();
  await expect(page.getByText('up from 75%', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Result card' }).click();
  const img = page.getByRole('dialog').locator('img.share-preview');
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(2400);
  await expect(img).toHaveAttribute('alt', /75% average/);
});

test('Daily 10 clears a mistake with two correct answers in one day (controlled clock)', async ({ page }) => {
  const day0 = new Date('2026-10-20T09:00:00');
  await page.clock.install({ time: day0 });
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await page.locator('.paper-card').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.qcard')).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(i === 0 ? (keyFor(0) === 'a' ? 'b' : 'a') : keyFor(i));
    if (i < 3) await page.keyboard.press('ArrowRight');
  }
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('3/4')).toBeVisible();
  await page.goto('./');
  await expect(page.getByText('Nothing due', { exact: true })).toBeVisible();

  await page.clock.setSystemTime(new Date('2026-10-21T08:00:00'));
  await page.reload();
  await expect(page.getByText('mistake due today')).toBeVisible();
  await page.getByRole('button', { name: 'Start Daily 10' }).click();
  await expect(page.locator('.qs-title .t')).toHaveText('Daily 10');
  await page.keyboard.press(keyFor(0));
  await expect(page.getByText('Correct', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Daily 10 · Practice', { exact: false })).toBeVisible();
  await expect(page.getByText('Counts toward your trend')).toHaveCount(0);
  await page.goto('./');
  await expect(page.getByText('Done for today', { exact: true })).toBeVisible();

  await page.locator('.pack-card').first().click();
  await expect(page.getByRole('button', { name: /1 in bank/ })).toBeVisible();
  await page.getByRole('button', { name: /1 in bank/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Practice' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.qcard')).toBeVisible();
  await page.keyboard.press(keyFor(0));
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByRole('button', { name: /Back to pack/ }).click();
  await expect(page.getByRole('button', { name: /0 in bank/ })).toBeVisible();
  await page.getByRole('link', { name: 'Mistakes notebook' }).click();
  await expect(page.getByText('Your mistakes bank is empty')).toBeVisible();
});

test('no serious accessibility violations on the v2 screens, light and dark', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await page.goto('./');
  await bothThemes(page, 'home with Daily 10');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Go to' })).toBeVisible();
  await bothThemes(page, 'command palette');
  await page.keyboard.press('Escape');
  await page.locator('.pack-card').first().click();
  await page.locator('.paper-card').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Answer key and grade boundaries' }).click();
  await bothThemes(page, 'key dialog');
  await page.getByRole('dialog', { name: 'Synthetic Paper 1: key and details' }).getByRole('button', { name: 'Grade boundaries' }).click();
  await bothThemes(page, 'boundaries');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.goto(page.url().replace(/\?.*$/, '') + '/notebook');
  await expect(page.getByRole('heading', { name: /notebook/ })).toBeVisible();
  await bothThemes(page, 'notebook');
});
