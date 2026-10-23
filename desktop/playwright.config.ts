import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  // several runs may share the machine (and the dev server): each keeps its own output folder
  outputDir: `test-results/run-${process.pid}`,
  fullyParallel: true,
  workers: 3,
  retries: 1, // the whole OS boots in every test: a loaded machine can miss a timeout
  expect: { timeout: 10_000 },
  timeout: 45_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', channel: 'chrome', trace: 'retain-on-failure', viewport: { width: 1280, height: 800 } },
  webServer: {
    // Vanilla is built first: Desktop serves its output at /os/
    command: 'pnpm --filter @tiny/kernel build && pnpm exec vite',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
