import { defineConfig, devices } from '@playwright/test';

// Run from the repo root in any terminal: npm run e2e.
// Two production builds are served: the plain app (no backend, port 4173) and the same app built
// against the in-browser mock backend (port 4174) for the Library, sign-in and sync flows.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  projects: [
    { name: 'app', testIgnore: /library\.spec\.ts/, use: { baseURL: 'http://localhost:4173/' } },
    { name: 'mock-backend', testMatch: /library\.spec\.ts/, use: { baseURL: 'http://localhost:4174/' } },
  ],
  webServer: [
    { command: 'npm run build && npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true, timeout: 120_000 },
    { command: 'VITE_BACKEND=mock npx vite build --outDir dist-mock && npx vite preview --outDir dist-mock --port 4174 --strictPort', port: 4174, reuseExistingServer: true, timeout: 120_000 },
  ],
});
