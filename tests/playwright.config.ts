import { defineConfig, devices } from '@playwright/test';

/**
 * Combined chat+admin storageState the `battle` project reuses (written by the
 * setup-battle project). Defined HERE (not in e2e/battle.setup.ts) so the config
 * can reference it WITHOUT importing that file — importing battle.setup.ts would
 * execute its top-level `setup(...)` call outside a test context, which Playwright
 * rejects. battle.setup.ts and battle.spec.ts import this constant from the config.
 */
export const BATTLE_AUTH_FILE = 'playwright/.auth/battle-admin.json';

/**
 * The RUN's battle experiment ids, minted once by the setup project and read by battle.spec.ts.
 *
 * They must be fresh per run. The suite used to arm a single fixed id ('e2e-battle-sonnet-vs-opus'),
 * which works exactly until something completes that experiment - and `completed` is TERMINAL by design
 * (`admin-experiments.ts`: "'completed' and 'deleted' are terminal - re-run with a new experiment id").
 * A terminal row cannot be resumed, so `activateBattleExperiment` could never restore it and every
 * behavioral battle test failed in beforeAll. Worse, the arming POST still returned 2xx, so the failure
 * surfaced four lines later as a missing admin-table row and read like a UI timeout.
 *
 * Same file-handoff shape as BATTLE_AUTH_FILE, and defined HERE for the same reason: the config cannot
 * import a test file.
 */
export const BATTLE_EXP_FILE = 'playwright/.auth/battle-exp.json';

/**
 * The PREMIUM (non-moderator) member's storageState, for the two battle tests that need a SECOND
 * participant: B-E1 (the briefing must reach a non-moderator) and B-E6 (two members pick opposite
 * sides).
 *
 * They previously built a bare `browser.newContext()` and ran the interactive sign-in inside it. That
 * is the only place in the suite that logs in by hand, and it failed two ways: the login form never
 * rendered (so `waitForSelector('input[type=email]')` timed out), and spawning that extra context
 * intermittently killed the worker outright with STATUS_DLL_INIT_FAILED. Pre-authenticating the
 * premium user once, exactly as BATTLE_AUTH_FILE does for the admin, removes the login step and the
 * second browser launch it needed.
 */
export const BATTLE_PREMIUM_AUTH_FILE = 'playwright/.auth/battle-premium.json';

/**
 * A second member who is genuinely a DIFFERENT PERSON from the moderator.
 *
 * `testAdmin` and `premiumUser` in the credentials secret are the same account
 * (premium@stratum.example.com), so BATTLE_PREMIUM_AUTH_FILE holds the same Cognito identity the
 * `battle` project already runs as. Anything that turns on two distinct users is therefore not
 * actually testing two users:
 *
 *   - B-E6 asserts per-user picks are RETAINED, not last-write-wins. Battle outcomes are keyed by the
 *     chooser's sub (`SET votes.<sub>`), so one identity picking twice overwrites its own vote and
 *     only ever credits one variant. The assertion could not pass however correct the product was.
 *   - B-E1 calls its second participant a NON-moderator, but the shared account created the channel
 *     and is its moderator, so the test could not see what a non-moderator sees.
 *
 * The second member must be PREMIUM. Sharing is tier-gated on the invitee's own access level, not
 * only on the channel's: adding the standard user to a premium conversation is refused with "Their
 * access level (standard) does not meet the conversation's premium tier". So the second identity has
 * to be a premium account that is not the one the suite already runs as.
 */
export const BATTLE_SECOND_MEMBER_AUTH_FILE = 'playwright/.auth/battle-second-member.json';

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
  // ONE TEST, OR ONE SLICE, PER INVOCATION. A live turn-queue test waits on a real assistant and can
  // run for minutes, so a whole phase is long enough that a backgrounded run on this machine is
  // killed before it reports - which costs every verdict, not the one it was on. `E2E_GREP` is the
  // same answer the backend suite already takes with `--only=N`: make a kill cost one test.
  // Absent, everything in the selected specs runs, so this changes no existing invocation.
  ...(process.env.E2E_GREP ? { grep: new RegExp(process.env.E2E_GREP) } : {}),
  // 'list' for the live view; skip-visibility for what the live view cannot tell you - which tests did
  // NOT run, and why. Most of this suite is gated on provisioned credentials, so a run without them
  // silently no-ops a large fraction of it and still prints green. See e2e/reporters/skip-visibility.ts.
  reporter: [['list'], ['./e2e/reporters/skip-visibility.ts']],
  preserveOutput: 'always',
  use: {
    // Defaults to the local dev server; set E2E_BASE_URL to run against a
    // deployed origin (e.g. the AgentEchelonChatApp CloudFront URL).
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    // KEPT FOR A FAILURE ONLY. A passing test's trace is deleted when it ends, which also keeps a long
    // run's memory and disk down. A trace never holds a password whatever the mode: every password is
    // typed with `fillSecret` (e2e/helpers/unrecorded-secret.ts), and trace-holds-no-password.spec.ts
    // reads a produced trace back to prove it.
    trace: 'retain-on-failure',
    video: {
      mode: 'on',
      size: { width: 1280, height: 720 },
    },
  },
  // PER PHASE when validate.mjs names one (E2E_OUTPUT_DIR). Playwright clears its output folder at the
  // start of every run, and validate runs one invocation per phase, so a single shared folder let each
  // phase wipe the previous phase's traces, videos and snapshots - three failures in one sweep
  // (2026-10-05) could only be diagnosed from a log line because of it. Unset, it is the usual folder.
  outputDir: process.env.E2E_OUTPUT_DIR || './test-results',
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
      testIgnore: [/admin-.*\.spec\.ts/, /battle\.spec\.ts/, /queue-demo\.spec\.ts/],
    },
    {
      name: 'admin',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /admin-.*\.spec\.ts/,
    },
    // THE DEMO NEEDS A PROJECT OF ITS OWN (code review, 2026-09-09). It is kept out of `chat` above
    // so an unattended sweep never runs a spec that ends by handing you the browser and waiting -
    // which is right - but no other project matched it either, so `--project=chat` (what
    // `validate.mjs --only=queue-demo` passed) matched ZERO tests and Playwright exited non-zero.
    // The documented invocation reported a failure for a spec it never ran.
    //
    // Reached only when it is named: `validate.mjs` marks the phase `manualOnly`, and no other
    // phase names this project.
    {
      name: 'queue-demo',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /queue-demo.spec.ts/,
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
