import { defineConfig, devices } from '@playwright/test';

/**
 * Fixture store: https://app.openimport.test (override with BASE_URL; CI uses http://localhost). Self-signed
 * certificate locally, so HTTPS errors are ignored. Admin specs share one login (admin-setup) and run serially,
 * because they change the same store.
 */
export default defineConfig({
  testDir: './tests',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results.json' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'https://app.openimport.test',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'admin-setup', testMatch: /admin\/auth\.setup\.ts/ },
    {
      name: 'admin-chromium',
      testMatch: /admin\/.*\.spec\.ts/,
      dependencies: ['admin-setup'],
      fullyParallel: false,
      workers: 1,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: '.auth/admin.json' },
    },
  ],
});
