import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { importGuestProgress, signInByCode, signOutAccount } from './auth-helpers';
import { keyFor, startPaper, syntheticDoc } from './helpers';

async function importNamedPack(page: Page, title: string) {
  await page.getByRole('button', { name: /Import a pack file|Add pack/ }).first().click();
  await page.getByRole('dialog').locator('textarea').fill(JSON.stringify(syntheticDoc([{ id: 'p1', count: 4 }], title)));
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Review import/ }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
}

async function completePaper(page: Page) {
  await startPaper(page);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(keyFor(i));
    if (i < 3) await page.keyboard.press('ArrowRight');
  }
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('4/4', { exact: true })).toBeVisible();
}

test('email codes isolate account A, guest and account B on the same browser', async ({ page }) => {
  await page.goto('./');
  await signInByCode(page, 'account-a@stjbs.sch.id');
  await importNamedPack(page, 'Private account A paper');
  await completePaper(page);
  await signOutAccount(page, 'account-a@stjbs.sch.id');
  await expect(page.locator('.pack-card')).toHaveCount(0);
  await expect(page.getByText('Private account A paper', { exact: true })).toHaveCount(0);

  await signInByCode(page, 'account-b@stjbs.sch.id');
  await expect(page.locator('.pack-card')).toHaveCount(0);
  await expect(page.getByText('Private account A paper', { exact: true })).toHaveCount(0);
  await importNamedPack(page, 'Private account B paper');
  await signOutAccount(page, 'account-b@stjbs.sch.id');
  await signInByCode(page, 'account-a@stjbs.sch.id');
  await expect(page.locator('.pack-card')).toHaveCount(1);
  await expect(page.getByText('Private account A paper', { exact: true })).toBeVisible();
  await expect(page.getByText('Private account B paper', { exact: true })).toHaveCount(0);
});

test('guest progress stays separate until an explicit confirmed import', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Continue without an account', exact: true }).click();
  await importNamedPack(page, 'Guest revision paper');
  await completePaper(page);
  await signInByCode(page, 'adopting@stjbs.sch.id');
  await expect(page.locator('.pack-card')).toHaveCount(0);
  await expect(page.getByText('Guest revision paper', { exact: true })).toHaveCount(0);
  await importGuestProgress(page, 'adopting@stjbs.sch.id', false);
  await expect(page.locator('.pack-card')).toHaveCount(0);
  await importGuestProgress(page, 'adopting@stjbs.sch.id');
  await expect(page.locator('.pack-card')).toHaveCount(1);
  await expect(page.getByText('Guest revision paper', { exact: true })).toBeVisible();
  await signOutAccount(page, 'adopting@stjbs.sch.id');
  await expect(page.getByText('Guest revision paper', { exact: true })).toBeVisible();
});

test('invalid email code reports an error and change-email returns to email entry', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in by email' });
  await dialog.getByLabel('Email', { exact: true }).fill('code@stjbs.sch.id');
  await dialog.getByRole('button', { name: 'Send verification code', exact: true }).click();
  await dialog.getByLabel('Verification code', { exact: true }).fill('000000');
  await dialog.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('invalid or expired');
  await dialog.getByRole('button', { name: 'Change email', exact: true }).click();
  await expect(dialog.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Verification code', { exact: true })).toHaveCount(0);
});


test('shared-device removal exports a backup and removes the signed-in cache before returning to guests', async ({ page }) => {
  await page.goto('./');
  const email = 'shared@stjbs.sch.id';
  await signInByCode(page, email);
  await importNamedPack(page, 'Shared-device private paper');
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('dmc-mock-account')!).id as string);
  await page.getByRole('button', { name:`Account: ${email}`, exact:true }).click();
  page.once('dialog', dialog => dialog.accept());
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name:'Back up, remove cache and sign out',exact:true}).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^dmc-everything-/);
  await expect(page.getByRole('button', {name:'Sign in',exact:true})).toBeVisible();
  expect(await page.evaluate(async name => (await indexedDB.databases()).some(db => db.name === name), `dmc-account-${encodeURIComponent(id)}`)).toBe(false);
  await expect(page.getByText('Shared-device private paper',{exact:true})).toHaveCount(0);
});
