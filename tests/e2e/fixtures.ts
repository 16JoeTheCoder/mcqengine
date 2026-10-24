import { test as base } from '@playwright/test';

/** Every test records page errors, console errors and failed requests, printed if it fails. */
export const test = base.extend<{ logs: string[] }>({
  logs: [
    async ({ page }, use, info) => {
      const logs: string[] = [];
      page.on('console', (m) => m.type() === 'error' && logs.push(`console ${m.text()}`));
      page.on('pageerror', (e) => logs.push(`pageerror ${e.message}`));
      page.on('requestfailed', (r) => logs.push(`failed ${r.url()} ${r.failure()?.errorText}`));
      await use(logs);
      if (info.status !== info.expectedStatus && logs.length) console.log(`LOGS ${info.title}\n${logs.join('\n')}`);
    },
    { auto: true },
  ],
});
export { expect } from '@playwright/test';
