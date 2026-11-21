import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { signInDev, signOutAccount } from './auth-helpers';
import { markSchemePdf, questionPaperPdf } from '../fixtures/pdf';
import { bothThemes } from './a11y';

/**
 * Against the real Worker (wrangler dev, local D1 and R2), through the production client: post a
 * set of PDFs, download it as another student, practise in PDF mode, post version 2, see "Update
 * available" and update the same copy, run the admin panel and a backup. Sign-in uses the
 * development route, which exists only in the local environment.
 */
const OWNER = 'josef.yang@stjbs.sch.id';
const STUDENT = 'budi.santoso@stjbs.sch.id';
const pdfs = [
  { name: '9702_s24_qp_12.pdf', mimeType: 'application/pdf', buffer: Buffer.from(questionPaperPdf(4, 2)) },
  { name: '9702_s24_ms_12.pdf', mimeType: 'application/pdf', buffer: Buffer.from(markSchemePdf('BCDA')) },
];

async function library(page: Page) {
  await page.goto('./#/library');
  await expect(page.getByRole('heading', { name: /School\s*Library/, level: 1 })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('the Worker is healthy and serves the app', async ({ request }) => {
  const r = await request.get('./api/health');
  expect(await r.json()).toMatchObject({ ok: true, d1: true, r2: true, environment: 'local' });
});

test('a personal account is not a member', async ({ page }) => {
  await page.goto('./');
  await signInDev(page, 'ana.home@gmail.com');
  await library(page);
  await expect(page.getByText('The Library is locked for this account')).toBeVisible();
  await page.goto('./#/settings');
  await expect(page.getByRole('switch', { name: /Sync my progress/ })).not.toBeChecked();
  await signOutAccount(page, 'ana.home@gmail.com');
});

test('post, download, PDF mode, version 2, update in place, admin and backup', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('./');
  await signInDev(page, OWNER);
  await page.goto('./#/settings');
  await expect(page.getByRole('switch', { name: /Sync my progress/ })).toBeChecked();

  // Post question paper + mark scheme PDFs: the key is read from the file name.
  await library(page);
  await page.getByRole('button', { name: 'Post a set' }).click();
  const dlg = page.getByRole('dialog', { name: 'Post a set' });
  await expect(dlg.getByRole('button', { name: 'Post', exact: true })).toBeDisabled();
  await dlg.locator('input[type=file]').first().setInputFiles(pdfs);
  await expect(dlg.getByText('9702_s24_qp_12', { exact: true })).toBeVisible();
  await expect(dlg.getByText(/Found/)).toBeVisible();
  await dlg.getByLabel('Name').fill('Physics 9702 June 2024');
  await bothThemes(page, 'post dialog with the paper table');
  await dlg.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Posted' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  const card = page.locator('.set-card').filter({ hasText: 'Physics 9702 June 2024' });
  await expect(card.getByText(/version\s*1/)).toBeVisible();

  // The owner downloads their own set: it becomes their linked copy, not a second set.
  await card.getByRole('button', { name: 'Download' }).click();
  await expect(card.getByText('On this device')).toBeVisible({ timeout: 30_000 });
  await signOutAccount(page, OWNER);

  // Another student downloads and practises in PDF mode (the paper has no typed questions).
  await signInDev(page, STUDENT);
  await library(page);
  const theirs = page.locator('.set-card').filter({ hasText: 'Physics 9702 June 2024' });
  await theirs.getByRole('button', { name: 'Download' }).click();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Physics 9702 June 2024', level: 1 })).toBeVisible();
  await page.locator('.paper-card').first().click();
  const start = page.getByRole('dialog');
  await expect(start.getByRole('button', { name: 'PDF and answer sheet' })).toBeVisible();
  await expect(start.getByRole('button', { name: 'Typed questions' })).toHaveCount(0);
  await start.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.pdf-pane canvas')).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Question 1', exact: true }).getByRole('radio', { name: /^B/ }).click();
  await expect(page.getByRole('radiogroup', { name: 'Question 1', exact: true }).getByRole('radio', { name: /^B/ })).toHaveAttribute('aria-checked', 'true');
  await bothThemes(page, 'PDF mode');
  await page.getByRole('button', { name: 'End session' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page).toHaveURL(/#\/results\//);
  await signOutAccount(page, STUDENT);

  // The owner edits the name and posts again from their copy: version 2 of the same set.
  await signInDev(page, OWNER);
  await library(page);
  await page.getByRole('button', { name: 'Post a set' }).click();
  const again = page.getByRole('dialog', { name: 'Post a set' });
  await again.getByLabel('A paper set on this device').selectOption({ label: 'Physics 9702 June 2024' });
  await expect(again.getByText(/as version 2/)).toBeVisible();
  await again.getByLabel('Description').fill('Now with a description.');
  await again.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Posted' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.set-card')).toHaveCount(1);
  await expect(page.locator('.set-card').getByText(/version\s*2/)).toBeVisible();

  // Admin panel: storage, access lists, AI status, and a backup on demand.
  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: /Library\s*admin/, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
  await expect(page.getByText('stjbs.sch.id', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run backup now' }).click();
  await expect(page.getByText('Backup finished.')).toBeVisible({ timeout: 30_000 });
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  await expect(page.locator('section[aria-labelledby="a-backups"]').getByText(today)).toBeVisible();
  await bothThemes(page, 'admin panel');
  await signOutAccount(page, OWNER);

  // The student sees "Update available" and updates the same copy.
  await signInDev(page, STUDENT);
  await library(page);
  const updated = page.locator('.set-card').filter({ hasText: 'Physics 9702 June 2024' });
  await expect(updated.getByText('Update available')).toBeVisible();
  await updated.getByRole('button', { name: 'Update' }).click();
  await expect(updated.getByText('On this device')).toBeVisible({ timeout: 30_000 });
  await page.goto('./#/');
  await expect(page.locator('.pack-card')).toHaveCount(1);
});
