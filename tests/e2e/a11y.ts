import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Serious or critical axe violations (WCAG 2.2 AA), in the current colour scheme. */
export async function axe(page: Page, name: string) {
  await page.waitForTimeout(400);
  const r = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${name}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
}

export async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: 'light' });
  await axe(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await axe(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: 'light' });
}
