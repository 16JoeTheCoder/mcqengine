import { defineConfig, devices } from '@playwright/test';

// Run from the repo root in any terminal: npm run e2e (builds, then serves dist on port 4173).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173/', viewport: { width: 1440, height: 900 } },
  webServer: { command: 'npm run build && npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true, timeout: 120_000 },
});
