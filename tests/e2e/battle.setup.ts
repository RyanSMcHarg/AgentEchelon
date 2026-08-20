/**
 * Battle E2E auth setup — the big harness-latency win.
 *
 * The nine /battle behavioral tests each used to pay TWO fresh Cognito sign-ins:
 * one on the chat origin (the duel) and one on the admin origin (arming the
 * experiment). The admin console is a SEPARATE app on a SEPARATE origin
 * (DESIGN-SEPARATE-ADMIN-APP.md), and Cognito tokens live in per-origin
 * localStorage, so a single sign-in never covered both.
 *
 * This Playwright setup project signs the `testAdmin` user into BOTH origins in
 * ONE browser context, then persists the combined localStorage to
 * BATTLE_AUTH_FILE. The `battle` project loads that storageState, so every
 * battle test starts already authenticated on both origins — no per-test login.
 *
 * Guard: it only runs against a live deploy (E2E_BASE_URL set). Off a live run
 * (localhost default) it skips, so `--list` and the default unit suite stay green.
 */
import { readFileSync } from 'node:fs';
import { test as setup, expect } from '@playwright/test';
import { getTestCredentials, getPremiumUser, getSecondPremiumUser } from './helpers/test-credentials';
import { initBattleExpIds } from './helpers/battle-setup';
// Single source of truth for the auth-file path lives in the config (a test file
// importing the config is safe; the config importing this setup file is not —
// that would run setup() outside a test context). Re-export for battle.spec.ts.
import {
  BATTLE_AUTH_FILE,
  BATTLE_PREMIUM_AUTH_FILE,
  BATTLE_SECOND_MEMBER_AUTH_FILE,
} from '../playwright.config';

export { BATTLE_AUTH_FILE, BATTLE_PREMIUM_AUTH_FILE, BATTLE_SECOND_MEMBER_AUTH_FILE };

const CHAT_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';

setup('authenticate admin on both origins', async ({ page }) => {
  setup.setTimeout(120_000);
  // Only meaningful against a live deploy; off a live run the battle tests are
  // all skipped (requireBattleE2E), so there is nothing to pre-authenticate.
  setup.skip(!process.env.E2E_BASE_URL, 'Battle auth setup — set E2E_BASE_URL to a live deploy');

  // Mint this run's battle experiment ids BEFORE any test reads them, so every test in the run agrees
  // on one pair. They are fresh per run on purpose: a fixed id dies permanently the first time any run
  // completes it, because `completed` is terminal and `activateBattleExperiment` works by resuming.
  const expIds = initBattleExpIds();
  console.log(`[battle-setup] experiment ids for this run: ${expIds.text} / ${expIds.image}`);

  const creds = await getTestCredentials();

  // (a) Chat origin.
  await page.goto(CHAT_BASE_URL);
  await page.waitForSelector('input[type="email"]', { timeout: 15_000 });
  await page.locator('input[type="email"]').fill(creds.testAdmin.email);
  await page.locator('input[type="password"]').fill(creds.testAdmin.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.app-header', { timeout: 30_000 });

  // (b) Admin origin — only if it is a DIFFERENT origin (else chat auth covers it).
  if (new URL(ADMIN_BASE_URL).origin !== new URL(CHAT_BASE_URL).origin) {
    await page.goto(new URL('/?admin=experiments', ADMIN_BASE_URL).toString());
    const needsLogin = await page
      .locator('input[type="password"]')
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    if (needsLogin) {
      await page.locator('input[type="email"]').fill(creds.testAdmin.email);
      await page.locator('input[type="password"]').fill(creds.testAdmin.password);
      await page.locator('button[type="submit"]').click();
      await page.waitForSelector('.admin-dashboard, .admin-section-rail', { timeout: 30_000 });
    }
  }

  await page.context().storageState({ path: BATTLE_AUTH_FILE });

  // (c) The PREMIUM non-moderator, in its own context, persisted separately. B-E1 and B-E6 need a
  //     SECOND participant; pre-authenticating here means those tests open a context from
  //     storageState instead of running the suite's only interactive sign-in inside a bare context.
  const premium = await getPremiumUser();
  if (premium.password) {
    const premiumCtx = await page.context().browser()!.newContext();
    const premiumPage = await premiumCtx.newPage();
    try {
      await premiumPage.goto(CHAT_BASE_URL);
      await premiumPage.waitForSelector('input[type="email"]', { timeout: 15_000 });
      await premiumPage.locator('input[type="email"]').fill(premium.email);
      await premiumPage.locator('input[type="password"]').fill(premium.password);
      await premiumPage.locator('button[type="submit"]').click();
      await premiumPage.waitForSelector('.app-header', { timeout: 30_000 });
      await premiumCtx.storageState({ path: BATTLE_PREMIUM_AUTH_FILE });
    } finally {
      await premiumCtx.close();
    }
  }

  // (d) A second member who is a DIFFERENT IDENTITY from the moderator. testAdmin and premiumUser are
  //     the same account, so (c) alone cannot exercise anything that turns on two distinct users -
  //     see BATTLE_SECOND_MEMBER_AUTH_FILE in playwright.config for what that silently defeated.
  //
  //     A FAILURE HERE MUST BE LOUD, and it used to be silent. The whole block was wrapped in
  //     `if (second?.password)`, so anything that stopped the second member being prepared - the key
  //     absent from the secret, or a sign-in that simply did not complete - left the storage file
  //     unwritten and the setup passing. The tests that need it then reported `test.skip`, and a skip
  //     reads as a pass in the summary line everyone actually looks at. Two claims the product makes
  //     about DIFFERENT PEOPLE (per-user picks are keyed by the chooser's sub; a briefing must reach a
  //     non-moderator) would have gone unverified with nothing on screen saying so.
  //
  //     The credential is provisioned by `provision-test-users.mjs`, so on a live run its absence is a
  //     broken harness rather than an unsupported deployment - and this suite is skipped wholesale off
  //     a live deploy, which is the only case where "not available" is a legitimate answer.
  const second = await getSecondPremiumUser();
  if (!second?.password) {
    throw new Error(
      'battle e2e: `secondPremiumUser` is missing from the test-credentials secret, so B-E1 and B-E6 '
      + 'cannot verify anything about two distinct people. Provision it with '
      + '`node backend/scripts/provision-test-users.mjs` rather than letting those tests skip.',
    );
  }
  const secondCtx = await page.context().browser()!.newContext();
  const secondPage = await secondCtx.newPage();
  try {
    await secondPage.goto(CHAT_BASE_URL);
    await secondPage.waitForSelector('input[type="email"]', { timeout: 15_000 });
    await secondPage.locator('input[type="email"]').fill(second.email);
    await secondPage.locator('input[type="password"]').fill(second.password);
    await secondPage.locator('button[type="submit"]').click();
    // Fails the SETUP if this member cannot actually sign in, which is the point: the alternative is
    // writing a storage file for a session that never authenticated, and every test that loads it then
    // fails somewhere further downstream with a symptom that looks like a product defect.
    await secondPage.waitForSelector('.app-header', { timeout: 30_000 });
    await secondCtx.storageState({ path: BATTLE_SECOND_MEMBER_AUTH_FILE });
  } finally {
    await secondCtx.close();
  }

  // The setup's real assertion: every storage file a test will load exists and carries a session. An
  // `expect(true).toBe(true)` stood here, which asserts that this file was reached and nothing else.
  for (const [label, file] of [
    ['admin', BATTLE_AUTH_FILE],
    ['premium', BATTLE_PREMIUM_AUTH_FILE],
    ['second member', BATTLE_SECOND_MEMBER_AUTH_FILE],
  ] as const) {
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      cookies?: unknown[]; origins?: Array<{ localStorage?: unknown[] }>;
    };
    const hasSession = (state.origins ?? []).some((o) => (o.localStorage ?? []).length > 0)
      || (state.cookies ?? []).length > 0;
    expect(hasSession, `${label} storageState (${file}) has no session - the sign-in did not stick`).toBe(true);
  }
});
