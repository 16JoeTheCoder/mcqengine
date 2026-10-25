import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { syntheticDoc } from './helpers';

// Runs against the build that uses the in-browser mock backend (same rules as supabase/schema.sql).

async function signIn(page: Page, email: string, mode: 'school' | 'personal' = 'school') {
  const dlg = page.getByRole('dialog');
  if (!(await dlg.isVisible())) await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (mode === 'personal') await dlg.getByRole('button', { name: 'Personal' }).click();
  await dlg.getByLabel(/Email/).fill(email);
  await dlg.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: `Account: ${email}` })).toBeVisible();
}

async function signOut(page: Page, email: string) {
  await page.getByRole('button', { name: `Account: ${email}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
}

async function importPack(page: Page) {
  await page.getByRole('button', { name: /Import a pack file|Add pack/ }).first().click();
  await page.getByRole('dialog').locator('textarea').fill(JSON.stringify(syntheticDoc([{ id: 'p1', count: 4 }, { id: 'p2', count: 4 }])));
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Review import/ }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Physics', level: 1 })).toBeVisible();
}

test('first run leads with school sign-in and never blocks', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Sign in with school email' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a personal account' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await expect(page.getByRole('button', { name: /Import a pack file/ })).toBeVisible();
});

test('a personal account syncs nothing yet but sees the Library locked with one line on how to unlock it', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Create a personal account' }).click();
  await signIn(page, 'ana.home@gmail.com', 'personal');
  await page.goto('./#/library');
  await expect(page.getByText('The Library is locked for this account')).toBeVisible();
  await expect(page.getByText(/sign in with your @stjbs\.sch\.id address to unlock it/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Post a set' })).toHaveCount(0);
});

test('post a set from a pack, star it, download it as another student, re-share refused', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await importPack(page);
  await signIn(page, 'ana@stjbs.sch.id');
  await page.goto('./#/library');
  await expect(page.getByText('Nothing shared yet')).toBeVisible();
  await page.getByRole('button', { name: 'Post a set' }).click();
  const dlg = page.getByRole('dialog', { name: 'Post a set' });
  await dlg.getByLabel('A pack on this device').selectOption({ label: 'Synthetic Physics' });
  await expect(dlg.getByLabel('Name')).toHaveValue('Synthetic Physics');
  await expect(dlg.getByText('2 papers', { exact: true })).toBeVisible();
  await expect(dlg.getByText('all keyed', { exact: true })).toBeVisible();
  await dlg.getByLabel('Description').fill('Two synthetic papers for testing.');
  await dlg.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Posted' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  const card = page.locator('.set-card').filter({ hasText: 'Synthetic Physics' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Two synthetic papers for testing.')).toBeVisible();
  await card.getByRole('button', { name: /^Star Synthetic Physics, 0 stars/ }).click();
  await expect(card.getByRole('button', { name: /^Unstar Synthetic Physics, 1 star/ })).toBeVisible();
  await card.getByRole('button', { name: /^Unstar/ }).click();
  await expect(card.getByRole('button', { name: /^Star Synthetic Physics, 0 stars/ })).toBeVisible();

  await signOut(page, 'ana@stjbs.sch.id');
  await signIn(page, 'budi@stjbs.sch.id');
  await page.goto('./#/library');
  const card2 = page.locator('.set-card').filter({ hasText: 'Synthetic Physics' });
  await expect(card2.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await card2.getByRole('button', { name: 'Download' }).click();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Physics', level: 1 })).toBeVisible();
  expect(page.url()).toMatch(/#\/pack\/lib-/);
  await page.getByRole('link', { name: 'Data' }).click();
  await expect(page.getByText('This pack came from the school Library')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export pack', exact: true })).toHaveCount(0);
});

test('reporting: three reports hide a set from other students', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await importPack(page);
  await signIn(page, 'owner@stjbs.sch.id');
  await page.goto('./#/library');
  await page.getByRole('button', { name: 'Post a set' }).click();
  await page.getByRole('dialog').getByLabel('A pack on this device').selectOption({ label: 'Synthetic Physics' });
  await page.getByRole('dialog').getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  let current = 'owner@stjbs.sch.id';
  for (const who of ['a@stjbs.sch.id', 'b@stjbs.sch.id', 'c@stjbs.sch.id']) {
    await signOut(page, current);
    await signIn(page, who);
    current = who;
    await page.goto('./#/library');
    await page.locator('.set-card').first().getByRole('button', { name: 'Report' }).click();
    await page.getByRole('dialog').getByLabel('What is wrong?').fill('test report');
    await page.getByRole('dialog').getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.reload();
  await expect(page.getByText('Nothing shared yet')).toBeVisible();
  await signOut(page, 'c@stjbs.sch.id');
  await signIn(page, 'owner@stjbs.sch.id');
  await page.goto('./#/library');
  await expect(page.getByText('Hidden after reports')).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Hidden after reports')).toHaveCount(0);
});
