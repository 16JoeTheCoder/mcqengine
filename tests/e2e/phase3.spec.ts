import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { importViaPaste, keyFor, startPaper, syntheticDoc } from './helpers';
import { markSchemePdf, questionPaperPdf } from '../fixtures/pdf';
import { bothThemes } from './a11y';

// Plain-app features (no backend): practice feedback, exam-mode answers, PDF mode sheet, edit set, search.

const grid = (page: Page) => page.getByRole('group', { name: 'Questions', exact: true });
const gridBtn = (page: Page, n: number) => grid(page).getByRole('button', { name: new RegExp(`^Question ${n}(,|$)`) });

test('practice mode marks each answer right or wrong and keeps a running accuracy', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await startPaper(page, 0, { practice: true });
  const wrong = keyFor(0) === 'a' ? 'b' : 'a';
  await page.keyboard.press(wrong); // Q1 wrong
  await expect(gridBtn(page, 1)).toHaveClass(/is-wrong/);
  await expect(page.getByRole('button', { name: /^Question 1, answered, wrong/ })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press(keyFor(1)); // Q2 right
  await expect(gridBtn(page, 2)).toHaveClass(/is-right/);
  await expect(page.getByRole('button', { name: /^Question 2, answered, right/ })).toBeVisible();
  await expect(page.getByText('50%', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'accuracy' })).toContainText('50% accuracy');
  await bothThemes(page, 'practice feedback');
});

test('exam mode: choosing the selected option again clears it; unanswered numbers jump back', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await startPaper(page);
  const first = page.getByRole('radio').first();
  await first.click();
  await expect(first).toHaveAttribute('aria-checked', 'true');
  await first.click();
  await expect(first).toHaveAttribute('aria-checked', 'false');
  await expect(gridBtn(page, 1)).not.toHaveClass(/answered/);

  // Answer Q1 and Q2, flag Q2; Q3 and Q4 stay blank.
  await page.getByRole('radio').nth(1).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('radio').nth(2).click();
  await page.getByRole('button', { name: /^Flag/ }).click();
  await expect(gridBtn(page, 2)).toHaveAttribute('aria-label', /flagged/);

  await page.getByRole('button', { name: 'End session' }).click();
  const dlg = page.getByRole('dialog');
  const blanks = dlg.getByRole('group', { name: 'Unanswered questions' });
  await expect(blanks.getByRole('button')).toHaveText(['3', '4']);
  await expect(blanks.getByRole('button', { name: '2', exact: true })).toHaveCount(0);
  await blanks.getByRole('button', { name: '3', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(grid(page).locator('button[aria-current="true"]')).toHaveAttribute('aria-label', /^Question 3/);
});

test('PDF mode answer sheet: follow toggle persists, bubbles clear, rows flag', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: /Import a paper-set file/ }).click();
  await page.getByRole('dialog').locator('input[type=file][accept*=pdf]').setInputFiles([
    { name: '9702_s23_qp_12.pdf', mimeType: 'application/pdf', buffer: Buffer.from(questionPaperPdf(4, 2)) },
    { name: '9702_s23_ms_12.pdf', mimeType: 'application/pdf', buffer: Buffer.from(markSchemePdf('BCDA')) },
  ]);
  const imp = page.getByRole('dialog', { name: 'Add PDF papers' });
  await expect(imp.getByLabel('Title of 9702_s23_qp_12.pdf')).toHaveValue('May/June 2023 Paper 12');
  await imp.getByRole('button', { name: /Add 1 paper/ }).click();
  await expect(page.getByRole('heading', { name: 'Physics 9702', level: 1 })).toBeVisible();

  await startPaper(page);
  const follow = page.getByRole('button', { name: /^Follow o(n|ff)$/ });
  await expect(follow).toBeVisible();
  await expect(follow).toHaveText('Follow off');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await follow.click();
  await expect(follow).toHaveText('Follow on');
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('dmc-sheet-follow'))).toBe('1');

  // A chosen bubble clears when pressed again.
  const row = page.getByRole('radiogroup', { name: 'Question 1', exact: true });
  await row.getByRole('radio', { name: 'B', exact: true }).click();
  await expect(row.getByRole('radio', { name: 'B', exact: true })).toHaveAttribute('aria-checked', 'true');
  await row.getByRole('radio', { name: 'B', exact: true }).click();
  await expect(row.getByRole('radio', { name: 'B', exact: true })).toHaveAttribute('aria-checked', 'false');

  const flag = page.getByRole('button', { name: 'Flag question 2' });
  await expect(flag).toHaveAttribute('aria-pressed', 'false');
  await flag.click();
  await expect(flag).toHaveAttribute('aria-pressed', 'true');
  await flag.click();
  await expect(flag).toHaveAttribute('aria-pressed', 'false');

  // The choice survives a reload: the saved session resumes with the sheet still following.
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('dmc-sheet-follow'))).toBe('1');
  const resume = page.getByRole('dialog', { name: 'Resume your session?' });
  if (await resume.isVisible().catch(() => false)) await resume.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Follow on' })).toHaveAttribute('aria-pressed', 'true');
});

test('edit set details from the home card and from the set page', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await page.goto('./');
  await page.getByRole('button', { name: 'More for Synthetic Physics' }).click();
  await page.getByRole('menuitem', { name: 'Edit details' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit paper set' });
  await dlg.getByLabel('Name').fill('');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dlg.getByRole('alert')).toBeVisible();
  await dlg.getByLabel('Name').fill('Renamed physics');
  await dlg.getByLabel('Description').fill('Mock paper set for revision.');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const card = page.locator('.pack-card').filter({ hasText: 'Renamed physics' });
  await expect(card).toBeVisible();

  await card.click();
  await expect(page.getByRole('heading', { name: 'Renamed physics', level: 1 })).toBeVisible();
  await expect(page.getByText('Mock paper set for revision.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit details' }).click();
  const again = page.getByRole('dialog', { name: 'Edit paper set' });
  await expect(again.getByLabel('Name')).toHaveValue('Renamed physics');
  await expect(again.getByLabel('Description')).toHaveValue('Mock paper set for revision.');
});

test('search everything finds questions and paper sets on this device', async ({ page }) => {
  await importViaPaste(page, syntheticDoc([{ id: 'p1', count: 4 }]));
  await page.goto('./');
  await expect(page.locator('.pack-card')).toHaveCount(1);
  await page.keyboard.press('Control+k');
  const dlg = page.getByRole('dialog', { name: 'Search' });
  await expect(dlg).toBeVisible();
  const input = dlg.getByRole('combobox', { name: 'Search everything' });
  await input.fill('moves');
  await expect(dlg.getByText('Questions', { exact: true })).toBeVisible();
  await expect(dlg.getByRole('option').first()).toContainText('moves');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/papers/);

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search everything' }).fill('Synthetic Physics');
  const sets = page.getByRole('dialog', { name: 'Search' });
  await expect(sets.getByText('Paper sets on this device', { exact: true })).toBeVisible();
  await expect(sets.getByRole('option', { name: /Synthetic Physics/ }).first()).toBeVisible();
});
