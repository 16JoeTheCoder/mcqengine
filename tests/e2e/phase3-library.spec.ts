import { expect, test } from './fixtures';
import { signInDev, signOutAccount } from './auth-helpers';
import { bothThemes } from './a11y';

// Mock-backend project: profiles, people search and the admin drawer.

const ANA = 'ana.lim@stjbs.sch.id';
const BUDI = 'budi.santoso@stjbs.sch.id';
const ADMIN = 'josef.yang@stjbs.sch.id';

test('profiles: edit, see them, find a person, report, then go private', async ({ page }) => {
  await page.goto('./');
  await signInDev(page, ANA);
  // Known mock gap: backend.account() has no handle, so the Account dialog's "View profile" button
  // does not render in the mock build (the Worker's /me includes it). Open the profile by address.
  await page.goto('./#/u/ana.lim');
  await expect(page.getByRole('heading', { name: 'Ana Lim', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Edit profile' }).click();
  const ed = page.getByRole('dialog', { name: 'Edit profile' });
  await ed.getByLabel('Headline').fill('Year 12, physics and maths');
  await ed.getByLabel('Bio').fill('I like worked solutions.');
  await ed.getByLabel('Subjects').fill('Physics, Mathematics');
  await ed.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Year 12, physics and maths')).toBeVisible();
  await expect(page.getByText('I like worked solutions.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Subjects' }).getByText('Mathematics')).toBeVisible();
  await bothThemes(page, 'profile page');
  await signOutAccount(page, ANA);

  await signInDev(page, BUDI);
  await page.getByRole('button', { name: 'Search everything' }).click();
  const search = page.getByRole('dialog', { name: 'Search' });
  await search.getByRole('combobox', { name: 'Search everything' }).fill('Ana Lim');
  await expect(search.getByText('People', { exact: true })).toBeVisible();
  await search.getByRole('option', { name: /Ana Lim/ }).click();
  await expect(page.getByRole('heading', { name: 'Ana Lim', level: 1 })).toBeVisible();
  await expect(page.getByText('Year 12, physics and maths')).toBeVisible();
  await page.getByRole('button', { name: 'Report', exact: true }).click();
  const report = page.getByRole('dialog', { name: 'Report profile' });
  await expect(report).toBeVisible();
  await report.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const profileUrl = page.url();
  await signOutAccount(page, BUDI);

  await signInDev(page, ANA);
  await page.goto(profileUrl);
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.getByRole('dialog', { name: 'Edit profile' }).getByRole('button', { name: 'Only me' }).click();
  await page.getByRole('dialog', { name: 'Edit profile' }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await signOutAccount(page, ANA);

  await signInDev(page, BUDI);
  await page.goto(profileUrl);
  await expect(page.getByRole('heading', { name: 'Profile not found' })).toBeVisible();
});

test('admin drawer: tabs switch panels, Escape closes', async ({ page }) => {
  await page.goto('./');
  await signInDev(page, ADMIN);
  await page.goto('./#/admin');
  const drawer = page.getByRole('dialog', { name: 'Library admin' });
  await expect(drawer).toBeVisible();
  for (const name of ['Overview', 'Users', 'Content', 'Access', 'Operations', 'Audit log']) {
    const tab = drawer.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(drawer.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await tab.getAttribute('id') as string);
  }
  await drawer.getByRole('tab', { name: 'Access', exact: true }).click();
  await expect(drawer.getByRole('heading', { name: 'Who can use the Library' })).toBeVisible();
  await bothThemes(page, 'admin drawer');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Library admin' })).toHaveCount(0);
});
