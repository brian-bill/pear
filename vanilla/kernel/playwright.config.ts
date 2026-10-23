import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    // Use the Chrome already installed on the machine; no browser download.
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node build.mjs && node serve.mjs',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
})
