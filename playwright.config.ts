import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } } }],
  webServer: { command: 'npm run dev -- --port 4179 --strictPort', url: 'http://127.0.0.1:4179', reuseExistingServer: !process.env.CI },
});
