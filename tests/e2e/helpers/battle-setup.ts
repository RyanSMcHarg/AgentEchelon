/**
 * Battle E2E setup helpers.
 *
 * The /battle behavioral specs require a live battle-enabled deploy: the
 * AgentEchelonBattle stack (alt-bot slot pool + orchestrator + channel-battle API)
 * and a premium/admin test user. Plain `cd tests && npm test` must NOT run them
 * (no battle deploy guaranteed, real model duels are slow), so every battle
 * behavioral test calls `requireBattleE2E()` and is SKIPPED unless BATTLE_E2E=1.
 *
 * Run them against a provisioned stack (frontend dev server up + backend
 * deployed with enableBattle):
 *   cd tests
 *   BATTLE_E2E=1 AWS_PROFILE=<your-profile> npx playwright test e2e/battle.spec.ts \
 *     --config=playwright.config.ts
 *
 * These arm an experiment on the admin origin, enable Battle Mode on a premium
 * channel, and fire a real duel — hard-asserting the UX. The selectors are the
 * real frontend ones.
 */
import { Page, expect, test } from '@playwright/test';
import { signIn } from './agent-helpers';
import { getTestCredentials } from './test-credentials';

export const BATTLE_E2E_ENABLED = process.env.BATTLE_E2E === '1' || process.env.BATTLE_E2E === 'true';

/** Skip the calling test/suite unless BATTLE_E2E=1. */
export function requireBattleE2E(): void {
  test.skip(
    !BATTLE_E2E_ENABLED,
    'Battle E2E — set BATTLE_E2E=1 and point at a deployed battle-enabled stack (frontend running)',
  );
}

/** A stable battle experiment id the suite arms once and reuses. */
export const BATTLE_EXP_ID = 'e2e-battle-sonnet-vs-opus';
/** A separate experiment for the image generation-out duel (both variants carry an image-gen model). */
export const BATTLE_IMAGE_EXP_ID = 'e2e-battle-image-genout';

/** Sign in as the admin test user (admin tab for arming + premium for the duel). */
export async function signInAdmin(page: Page): Promise<void> {
  const creds = await getTestCredentials();
  await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
}

// The admin console is its own app on its own origin (SPEC-SEPARATE-ADMIN-APP.md).
// Experiment SETUP happens on the admin origin; the battle DUEL runs on the chat
// origin. That makes this a CROSS-ORIGIN flow with per-origin auth.
// >>> DEPLOY-VERIFY REQUIRED: this cross-origin path (admin-origin setup + chat-origin
//     duel + a sign-in on each origin) has not been run end-to-end; confirm on a
//     battle-enabled deploy with BATTLE_E2E=1. The old-structure selectors
//     (admin-button, admin-back-btn) are removed; the two-origin handling below is
//     the intended shape, pending that verification.
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
const CHAT_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';

async function openAdminExperiments(page: Page): Promise<void> {
  // Deep-link straight to the Experiments tab on the admin app; auth is per-origin,
  // so sign in here if the login screen shows (the section rail is the mounted proof).
  await page.goto(new URL('/?admin=experiments', ADMIN_BASE_URL).toString());
  const needsLogin = await page
    .locator('input[type="password"]')
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (needsLogin) {
    const creds = await getTestCredentials();
    // Sign in ON THE ADMIN ORIGIN — the login form is already on screen (we just
    // navigated here and detected it). Do NOT delegate to the shared signIn(),
    // which navigates via page.goto('/') → the CHAT baseURL: that origin is
    // already authenticated (the duel-side sign-in ran first), so its login form
    // never renders and the helper times out waiting for the email field. Auth is
    // per-origin (localStorage), so the admin origin must be signed into here,
    // directly against the form in front of us.
    await page.locator('input[type="email"]').fill(creds.testAdmin.email);
    await page.locator('input[type="password"]').fill(creds.testAdmin.password);
    await page.locator('button[type="submit"]').click();
    // Admin auth lands on the dashboard shell; then re-deep-link to Experiments.
    await page.waitForSelector('.admin-dashboard, .admin-section-rail', { timeout: 30_000 });
    await page.goto(new URL('/?admin=experiments', ADMIN_BASE_URL).toString());
  }
  await page.waitForSelector('.admin-section-rail', { timeout: 15_000 });
  await expect(page.locator('h3:has-text("A/B Experiments")')).toBeVisible({ timeout: 15_000 });
}

async function leaveAdmin(page: Page): Promise<void> {
  // The standalone admin app has no "close console"; the duel runs on the chat
  // origin, so navigate there (a chat-origin sign-in happens in the duel flow).
  await page.goto(CHAT_BASE_URL);
}

/**
 * Ensure a battle-enabled premium experiment exists + is active, bound to an
 * alt-bot slot. Idempotent: if BATTLE_EXP_ID already shows in the list, reuse it.
 * Returns with the admin dashboard closed.
 */
export async function ensureBattleExperiment(
  page: Page,
  opts: { slot?: string; control?: string; treatment?: string; expId?: string; image?: boolean } = {},
): Promise<void> {
  const slot = opts.slot ?? 'slot-0';
  const expId = opts.expId ?? BATTLE_EXP_ID;
  await openAdminExperiments(page);

  // Already armed from a prior run? Reuse it (avoids duplicate-id create error).
  const existing = page.locator(`text=${expId}`).first();
  if (await existing.isVisible({ timeout: 3000 }).catch(() => false)) {
    await leaveAdmin(page);
    return;
  }

  await page.locator('button:has-text("New Experiment")').click();
  await expect(page.locator('h4:has-text("Create Experiment")')).toBeVisible();
  await page.locator('label:has-text("Experiment ID") input').fill(expId);
  await page.locator('label:has-text("Control Model") select').selectOption({ value: opts.control ?? 'sonnet' }).catch(() => {});
  await page.locator('label:has-text("Treatment Model") select').selectOption({ value: opts.treatment ?? 'opus' }).catch(() => {});
  await page.locator('label:has-text("Description") input').fill('E2E battle: Sonnet (Atlas) vs Opus (Echo).');

  // A battle-enabled experiment must target EXACTLY ['premium'] (the backend
  // BATTLE_TIER_PREMIUM_ONLY guard). The form defaults tiers to ['standard'],
  // so deselect the non-premium tiers and ensure premium is the only one on.
  const tierBtn = (tier: string) =>
    page.locator(`.admin-filter-group button:has-text("${tier}")`).first();
  const isActive = async (tier: string) =>
    /\bactive\b/.test((await tierBtn(tier).getAttribute('class').catch(() => '')) ?? '');
  for (const t of ['basic', 'standard']) {
    if (await isActive(t)) await tierBtn(t).click();
  }
  if (!(await isActive('premium'))) await tierBtn('premium').click();

  await page.locator('.experiment-battle-toggle-row input[type="checkbox"]').check();
  await expect(page.locator('.experiment-battle-card')).toBeVisible({ timeout: 5000 });
  const names = page.locator('.experiment-battle-variant-name');
  await names.nth(0).fill('Atlas');
  await names.nth(1).fill('Echo');
  // Generation-out duel: set an image-gen model on BOTH variants (the form requires both-or-neither).
  // Pick the first real option (index 0 is "Text battle (no image generation)"), so this is robust to
  // whichever image models are active in the deploy.
  if (opts.image) {
    await page.locator('select[aria-label="Control image-gen model"]').selectOption({ index: 1 });
    await page.locator('select[aria-label="Treatment image-gen model"]').selectOption({ index: 1 });
  }
  await page.locator('#alt-bot-slot-select').selectOption(slot).catch(() => {});
  await page.locator('button:has-text("Create & Activate")').click();
  await expect(page.locator(`text=${expId}`).first()).toBeVisible({ timeout: 15_000 });

  await leaveAdmin(page);
}

/**
 * Create a premium conversation and enable Battle Mode on it for BATTLE_EXP_ID.
 * Throws (fails the test) if the alt-bot slot pool / battle API is unreachable —
 * that IS the regression signal for the AgentEchelonBattle relocation.
 */
export async function newBattleChannel(page: Page, title: string, expId: string = BATTLE_EXP_ID): Promise<void> {
  await page.locator('button.app-new-conversation-btn').click();
  await page.waitForSelector('.ncm-modal', { timeout: 8000 });
  const premiumCard = page.locator('.ncm-class-card:has-text("Premium")').first();
  if (await premiumCard.isVisible({ timeout: 3000 }).catch(() => false)) {
    await premiumCard.click();
  } else {
    await page.locator('.ncm-class-card').first().click();
  }
  void title;
  await page.locator('button:has-text("Create Conversation")').click();
  await page.waitForSelector('.conversation-header', { timeout: 20_000 });
  await page.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15_000 });

  await page.locator('button[aria-label="Show channel members"]').click();
  const section = page.locator('section.channel-members-panel-battle');
  await expect(section).toBeVisible({ timeout: 10_000 });
  const expSelect = section.locator('#battle-experiment-select');
  await expSelect.waitFor({ state: 'visible', timeout: 25_000 });
  await expSelect.selectOption(expId);
  await section.locator('.channel-members-panel-battle-btn--enable').click();

  const live = section.locator('.status-badge--live');
  const err = section.locator('.channel-members-panel-battle-error');
  await Promise.race([
    live.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
    err.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
  ]);
  if (await err.isVisible({ timeout: 500 }).catch(() => false)) {
    throw new Error(`Battle enable failed: ${await err.innerText().catch(() => 'unknown error')}`);
  }
  await expect(live).toBeVisible();
  // Close the members panel so it doesn't overlay the composer. The toggle
  // button's label flips to "Hide channel members" while the panel is OPEN —
  // clicking the "Show…" label here is a no-op that leaves the panel covering
  // the textarea (every subsequent composer action then hangs).
  await page.locator('button[aria-label="Hide channel members"]').first().click({ timeout: 5000 }).catch(() => {});
  await page.locator('section.channel-members-panel-battle').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/**
 * Fire a /battle prompt and wait for the dual reply to RESOLVE. Returns the
 * number of .battle-message bubbles. Resolution is signalled by the scorecard's
 * first response-time cell carrying a digit (the per-bot placeholders + an
 * empty-dash scorecard render immediately, so bubble count alone lies).
 */
/**
 * Type a /battle prompt into the composer and send it — no readiness wait. Use when the caller
 * asserts a NON-scorecard outcome first (e.g. the clarification waiting-state) rather than a resolved
 * duel. Explicit fill timeout so a blocked composer (an overlay) fails fast with a clear error.
 */
export async function fireBattleRaw(page: Page, prompt: string): Promise<void> {
  await page.locator('.message-textarea').fill(prompt, { timeout: 30_000 });
  await page.keyboard.press('Enter');
}

export async function fireBattle(page: Page, prompt: string, timeoutMs = 170_000): Promise<number> {
  await fireBattleRaw(page, prompt);
  await expect
    .poll(async () => page.locator('.message.battle-message').count(), { timeout: timeoutMs })
    .toBeGreaterThanOrEqual(2);
  const card = page.locator('.battle-scorecard').last();
  await card.waitFor({ state: 'visible', timeout: timeoutMs });
  await expect
    .poll(async () => card.locator('.battle-scorecard-cell').first().innerText().catch(() => ''), {
      timeout: timeoutMs,
    })
    .toMatch(/\d/);
  return page.locator('.message.battle-message').count();
}
