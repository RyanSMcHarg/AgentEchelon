import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Default 0 (a failure is a failure). Opt in to retries for live-system runs
  // where browser/WebSocket capture timing can flake a genuinely-passing test,
  // via PW_RETRIES=1. A retry only passes if the product actually works, so this
  // absorbs harness flake without masking a real, consistent failure.
  retries: process.env.PW_RETRIES ? Number(process.env.PW_RETRIES) : 0,
  workers: 1,
  reporter: 'list',
  preserveOutput: 'always',
  use: {
    // Defaults to the local dev server; set E2E_BASE_URL to run against a
    // deployed origin (e.g. the AgentEchelonFrontend CloudFront URL).
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on',
    video: {
      mode: 'on',
      size: { width: 1280, height: 720 },
    },
  },
  outputDir: './test-results',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 120000,
});
