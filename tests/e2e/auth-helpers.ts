import { expect, type Page } from '@playwright/test';

/** Development sign-in (Google in production), including the document restart between account workspaces. */
export async function signInDev(page: Page, email: string) {
  const dialog = page.getByRole('dialog', { name: /^Sign in/ });
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await dialog.getByLabel('Development sign-in').fill(email);
  await dialog.getByRole('button', { name: 'Sign in with this email', exact: true }).click();
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
