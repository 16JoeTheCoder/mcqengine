import { expect, type Page } from '@playwright/test';

export function syntheticDoc(papers: { id: string; count: number; minutes?: number }[], title = 'Synthetic Physics') {
  return {
    format: 'dmc-pack/1',
    pack: { title, subject: 'Physics' },
    papers: papers.map((p, k) => ({
      id: p.id,
      title: `Synthetic Paper ${k + 1}`,
      group: ['2025', 'May/June'],
      questionCount: p.count,
      timeLimitMinutes: p.minutes ?? 10,
      questions: Array.from({ length: p.count }, (_, i) => ({
        n: i + 1,
        stem: `Synthetic ${p.id} question ${i + 1}: a mass of ${i + 1}.0 kg moves at ${i + 2} m s^{-1}.`,
        options: ['one', 'two', 'three', 'four'].map((w) => `${w} ${i + 1}`),
        answer: 'ABCD'[(i + 1) % 4],
      })),
    })),
  };
}

/** Correct option letter for question index i (0-based) in the synthetic doc. */
export const keyFor = (i: number) => 'abcd'[(i + 1) % 4]!;

export async function importViaPaste(page: Page, doc: unknown) {
  await page.goto('./');
  const btn = page.getByRole('button', { name: /Import a pack file|Add pack/ }).first();
  await btn.click();
  await page.getByRole('dialog').locator('textarea').fill('Here is the JSON:\n```json\n' + JSON.stringify(doc) + '\n```');
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Review import/ }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Physics', level: 1 })).toBeVisible();
}

export async function startPaper(page: Page, index = 0, opts: { practice?: boolean; total?: number } = {}) {
  await page.locator('.paper-card').nth(index).click();
  const dlg = page.getByRole('dialog');
  if (opts.practice) await dlg.getByRole('button', { name: 'Practice' }).click();
  if (opts.total) {
    await dlg.getByRole('button', { name: 'Total', exact: true }).click();
    await dlg.getByLabel('Minutes').fill(String(opts.total));
    await dlg.getByLabel('Minutes').press('Tab');
  }
  await dlg.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.qcard')).toBeVisible();
}
