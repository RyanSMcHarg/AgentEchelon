import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // Pre-onboards the standard demo user (once-per-user onboarding, SPEC-USER-PROFILE-AND-ONBOARDING) so
  // the standard-tier direct-answer specs don't collide with a first-conversation intake. Best-effort +
  // no-op off a live deployment; see e2e/global-setup.ts.
  globalSetup: require.resolve('./e2e/global-setup.ts'),
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
  // Two ordered projects: the admin-console specs run AFTER the chat specs, because
  // the admin dashboard verifies data that the chat flows create (conversations,
  // events, tasks) and needs the admin app reachable. With workers:1 + fullyParallel
  // off, tests run in project-array order, so 'chat' drains before 'admin' starts.
  projects: [
    {
      name: 'chat',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /admin-.*\.spec\.ts/,
    },
    {
      name: 'admin',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /admin-.*\.spec\.ts/,
    },
  ],
  timeout: 120000,
});
