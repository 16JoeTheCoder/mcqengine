import { expect, type Page } from '@playwright/test';

/** Exercise the email-code UI, including the document restart between account workspaces. */
export async function signInByCode(page: Page, email: string, mode: 'school' | 'personal' = 'school') {
  const dialog = page.getByRole('dialog', { name: 'Sign in by email' });
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (mode === 'personal') await dialog.getByRole('button', { name: 'Personal', exact: true }).click();
  await dialog.getByLabel('Email', { exact: true }).fill(email);
  await dialog.getByRole('button', { name: 'Send verification code', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Resend in/ })).toBeDisabled();
  await dialog.getByLabel('Verification code', { exact: true }).fill('123456');
  await dialog.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: `Account: ${email}`, exact: true })).toBeVisible();
}

export async function signOutAccount(page: Page, email: string) {
  await page.getByRole('button', { name: `Account: ${email}`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Account', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
}

export async function importGuestProgress(page: Page, email: string, accept = true) {
  await page.getByRole('button', { name: `Account: ${email}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Account', exact: true });
  page.once('dialog', (confirmation) => accept ? confirmation.accept() : confirmation.dismiss());
  await dialog.getByRole('button', { name: 'Import guest progress', exact: true }).click();
  if (accept) await expect(page.getByText(/^Imported \d+ guest records\./)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}
