import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './.private/browser-results',
  reporter: [['list'], ['json', { outputFile: '.private/browser-report.json' }]],
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: { baseURL: 'http://127.0.0.1:8788/hopvium/', trace: 'retain-on-failure', screenshot: 'only-on-failure', acceptDownloads: true,
    launchOptions: { downloadsPath: path.resolve('.private/downloads') } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: { command: 'node scripts/dev.mjs', url: 'http://127.0.0.1:8788/hopvium/', reuseExistingServer: !process.env.CI, timeout: 60000 },
});
