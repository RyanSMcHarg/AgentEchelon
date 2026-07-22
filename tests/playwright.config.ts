import { defineConfig, devices } from '@playwright/test';

/**
 * Combined chat+admin storageState the `battle` project reuses (written by the
 * setup-battle project). Defined HERE (not in e2e/battle.setup.ts) so the config
 * can reference it WITHOUT importing that file — importing battle.setup.ts would
 * execute its top-level `setup(...)` call outside a test context, which Playwright
 * rejects. battle.setup.ts and battle.spec.ts import this constant from the config.
 */
export const BATTLE_AUTH_FILE = 'playwright/.auth/battle-admin.json';

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
      // Battle runs under its own `battle` project (storageState-authed on both
      // origins). Other chat specs sign in as DIFFERENT demo users, so battle's
      // admin storageState must NOT leak onto them — keep battle.spec out of chat.
      testIgnore: [/admin-.*\.spec\.ts/, /battle\.spec\.ts/],
    },
    {
      name: 'admin',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /admin-.*\.spec\.ts/,
    },
    // Signs the admin user into BOTH origins once and persists the combined
    // storageState (BATTLE_AUTH_FILE); the `battle` project depends on it.
    {
      name: 'setup-battle',
      testMatch: /battle\.setup\.ts$/,
    },
    {
      name: 'battle',
      testMatch: /battle\.spec\.ts$/,
      dependencies: ['setup-battle'],
      use: { ...devices['Desktop Chrome'], storageState: BATTLE_AUTH_FILE },
    },
  ],
  timeout: 120000,
});
