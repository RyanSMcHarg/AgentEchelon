/**
 * Battle E2E auth setup — the big harness-latency win.
 *
 * The nine /battle behavioral tests each used to pay TWO fresh Cognito sign-ins:
 * one on the chat origin (the duel) and one on the admin origin (arming the
 * experiment). The admin console is a SEPARATE app on a SEPARATE origin
 * (SPEC-SEPARATE-ADMIN-APP.md), and Cognito tokens live in per-origin
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
import { test as setup, expect } from '@playwright/test';
import { getTestCredentials } from './helpers/test-credentials';
// Single source of truth for the auth-file path lives in the config (a test file
// importing the config is safe; the config importing this setup file is not —
// that would run setup() outside a test context). Re-export for battle.spec.ts.
import { BATTLE_AUTH_FILE } from '../playwright.config';

export { BATTLE_AUTH_FILE };

const CHAT_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';

setup('authenticate admin on both origins', async ({ page }) => {
  setup.setTimeout(120_000);
  // Only meaningful against a live deploy; off a live run the battle tests are
  // all skipped (requireBattleE2E), so there is nothing to pre-authenticate.
  setup.skip(!process.env.E2E_BASE_URL, 'Battle auth setup — set E2E_BASE_URL to a live deploy');

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
  expect(true).toBe(true);
});
