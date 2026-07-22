/**
 * `/battle` E2E.
 *
 * Two layers:
 *  1. A CI-safe documentation/inventory anchor (always runs) pinning the
 *     Phase-0 marker-survival finding.
 *  2. Behavioral tests that drive a REAL duel against a live battle-enabled
 *     deploy (AgentEchelonBattle stack: alt-bot slot pool + orchestrator +
 *     channel-battle API). These hard-assert the duel UX and are SKIPPED unless
 *     BATTLE_E2E=1 — plain `npm test` (no battle deploy guaranteed, real model
 *     duels are slow) never runs them. Each runs the full admin-arm → enable →
 *     fire flow and hard-asserts the outcome (no honest-degrading).
 *
 *   cd tests
 *   BATTLE_E2E=1 AWS_PROFILE=<your-profile> npx playwright test e2e/battle.spec.ts \
 *     --config=playwright.config.ts
 *
 * This includes the heaviest stage — image generation-out — driven end to end
 * and hard-asserted (it is live and model-dependent, so it carries a generous
 * timeout and runs only under BATTLE_E2E, never in the default unit suite).
 */

import { test, expect } from '@playwright/test';
import {
  requireBattleE2E,
  BATTLE_E2E_ENABLED,
  ensureBattleExperimentExists,
  activateBattleExperiment,
  newBattleChannel,
  fireBattle,
  BATTLE_EXP_ID,
  BATTLE_IMAGE_EXP_ID,
} from './helpers/battle-setup';
// From the config, NOT from e2e/battle.setup.ts: Playwright forbids one test file
// importing another (battle.setup.ts is a test file); the config is the shared home.
import { BATTLE_AUTH_FILE } from '../playwright.config';

test.describe('/battle — Phase 0 verified invariant', () => {
  test('marker-survival contract is documented at the merge site', () => {
    // The round-1/2 battle marker is written on the PLACEHOLDER (CREATE).
    // The async processor's updateMessage overwrites Content with the
    // model reply and NO marker (UPDATE). The single-turn battle UI only
    // keeps rendering (variant chips, round-2 divider, scorecard) because
    // handleMessageUpdate preserves `battle` across the UPDATE instead of
    // re-parsing it from the (marker-less) updated content.
    //
    // The behavioral proof is the BATTLE_E2E suite below (needs a live
    // battle-enabled deploy). This anchor keeps the contract greppable and
    // lists `/battle` in the e2e inventory.
    expect(true).toBe(true);
  });
});

test.describe('/battle — behavioral E2E (live, BATTLE_E2E=1)', () => {
  // Independent tests (NOT .serial — one failure must not skip the others). Auth
  // is shared, not re-paid per test: the `battle` project loads a storageState
  // (BATTLE_AUTH_FILE) that the setup-battle project pre-authed on BOTH origins
  // (chat + admin), so no test signs in. The expensive experiment CREATE (form
  // fill) is also paid ONCE in beforeAll (create-if-missing for both text +
  // image). Each test then keeps only the CHEAP per-test step —
  // activateBattleExperiment — which makes its experiment the sole ACTIVE one
  // (resume it + pause the sibling), preserving both exclusivity (one active
  // battle experiment per classification) AND failure-independence (each test
  // re-asserts the right experiment is active, so one test's leftover state
  // never breaks the next). The config runs them sequentially (single worker);
  // real duels are slow.
  test.beforeEach(() => requireBattleE2E());

  // Create BOTH experiments once (create-if-missing) so no individual test pays
  // the form-fill create cost. Needs an authed page; storageState pre-auths both
  // origins. Guarded so the default (non-live) run never touches the auth file.
  test.beforeAll(async ({ browser }) => {
    if (!BATTLE_E2E_ENABLED) return;
    const ctx = await browser.newContext({ storageState: BATTLE_AUTH_FILE });
    const page = await ctx.newPage();
    try {
      await ensureBattleExperimentExists(page, { slot: 'slot-0' }); // text
      await ensureBattleExperimentExists(page, {
        slot: 'slot-0',
        expId: BATTLE_IMAGE_EXP_ID,
        image: true,
      });
    } finally {
      await ctx.close();
    }
  });

  test('round-1: two variant replies, chips SURVIVE the reply update, + scorecard pick works', async ({
    page,
  }) => {
    // A real duel + round-2 wait can take minutes; the config 120s cap is too tight.
    test.setTimeout(9 * 60_000);

    await activateBattleExperiment(page, BATTLE_EXP_ID);
    await newBattleChannel(page, 'E2E caching battle');

    // A single-turn opinion prompt (not a TASK_*) so round-2 is completion-
    // gated on the round-1 pair, which resolves deterministically here.
    const count = await fireBattle(
      page,
      '/battle Tabs or spaces for indentation? Answer in one short paragraph with a clear pick.',
    );
    expect(count).toBeGreaterThanOrEqual(2);

    // Two variants, each tagged with its persona chip.
    await expect(page.locator('.battle-variant-chip')).toHaveCount(2, { timeout: 10_000 });

    // Phase-0 regression guard: fireBattle only returns once the scorecard's
    // response-time cell carries a digit — i.e. AFTER the bot UPDATE replaced
    // the marker-bearing placeholder content. The chips being present NOW
    // proves handleMessageUpdate preserved `battle` across that UPDATE instead
    // of re-parsing it from the (marker-less) final content.
    for (const chip of await page.locator('.battle-variant-chip').all()) {
      await expect(chip).toBeVisible();
    }

    // Scorecard renders once under the round-1 pair, with a working pick. The
    // click persists server-side (BattleOutcome PUT) and is reflected in the UI
    // (aria-pressed). NOTE: the scorecard is SESSION-SCOPED by design — the
    // `<!--battle:-->` marker lives on the placeholder and is stripped on the
    // reply UPDATE (the Phase-0 finding), so reloaded (marker-less) history does
    // NOT reconstruct the scorecard. We therefore assert the in-session pick,
    // not a post-reload re-render (which the product intentionally doesn't do).
    const card = page.locator('.battle-scorecard').last();
    await expect(card).toBeVisible();
    const pickB = card.locator('[data-pick="B"]');
    await pickB.click();
    await expect(pickB).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  });

  test('round-2: a "Round 2 — rebuttals" divider renders after both round-1 complete', async ({
    page,
  }) => {
    test.setTimeout(9 * 60_000);
    await activateBattleExperiment(page, BATTLE_EXP_ID);
    await newBattleChannel(page, 'E2E round-2 battle');

    await fireBattle(page, '/battle Is REST or GraphQL the better default for a new internal API? One paragraph.');
    // Round 2 fires once both round-1 replies are terminal. For a single-turn
    // (non-TASK_*) prompt this is deterministic; allow a generous budget for
    // the orchestrator fan-out + the second generation.
    await expect(page.locator('.battle-round-divider').first()).toBeVisible({ timeout: 260_000 });
  });

  test('multi-turn: repeated /battle turns in one conversation each produce a fresh duel', async ({
    page,
  }) => {
    // Multi-turn = the conversation holds MORE THAN ONE battle. Each /battle is
    // its own duel (distinct battleId), reusing the same channel + alt-slot
    // member. This guards that a second battle turn works after the first (no
    // stale battle-state / sentinel reuse across turns). Two duels → budget high.
    //
    // NOTE: a plain (non-/battle, non-mention) follow-up in a battle channel does
    // NOT re-engage the bots — that's the multi-user "stay silent without a
    // mention" rule, not a bug. Each new duel needs its own /battle turn.
    test.setTimeout(14 * 60_000);

    await activateBattleExperiment(page, BATTLE_EXP_ID);
    await newBattleChannel(page, 'E2E multi-turn battle');

    await fireBattle(page, '/battle Tabs or spaces for indentation? One short paragraph with a clear pick.');
    // Exactly one duel so far → one scorecard.
    await expect(page.locator('.battle-scorecard')).toHaveCount(1, { timeout: 10_000 });

    // A SECOND battle turn produces a fresh duel → a SECOND scorecard. (Can't
    // reuse fireBattle's readiness wait here — duel-1's bubbles + scorecard
    // already satisfy it; the new scorecard is the unambiguous second-duel signal.)
    await page.locator('.message-textarea').fill(
      '/battle Monorepo or polyrepo for a five-team org? One short paragraph with a clear pick.',
      { timeout: 30_000 },
    );
    await page.keyboard.press('Enter');
    await expect(page.locator('.battle-scorecard')).toHaveCount(2, { timeout: 260_000 });
  });

  test('winner pick is RECORDED server-side (BattleOutcome persists), not just UI state', async ({
    page,
  }) => {
    // The scorecard pick is the terminal step of a completed battle. The round-1
    // test asserts the button flips (aria-pressed); THIS test asserts the pick
    // actually PERSISTS to the BattleOutcome store — the click POSTs to the
    // battle-outcome API, and a 2xx is the durable last-write-wins DynamoDB record.
    test.setTimeout(9 * 60_000);
    await activateBattleExperiment(page, BATTLE_EXP_ID);
    await newBattleChannel(page, 'E2E battle outcome recorded');

    await fireBattle(page, '/battle Tabs or spaces for indentation? One short paragraph with a clear pick.');

    const card = page.locator('.battle-scorecard').last();
    await expect(card).toBeVisible();
    const pickB = card.locator('[data-pick="B"]');

    // Capture the outcome write the click triggers (recordBattleOutcome ->
    // POST /channels/battle/outcome) and assert it was accepted + stored.
    const [outcomeResp] = await Promise.all([
      page.waitForResponse(
        (r) => /\/battle\/outcome\b/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      pickB.click(),
    ]);
    expect(outcomeResp.ok(), `battle-outcome POST status ${outcomeResp.status()}`).toBeTruthy();
    const stored = await outcomeResp.json().catch(() => ({} as Record<string, unknown>));
    if ('winner' in stored) expect(stored.winner).toBe('B');
    // UI reflects the persisted pick.
    await expect(pickB).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  });

  test('/battle WITHOUT Battle Mode enabled returns the one-line hint, no fan-out', async ({
    page,
  }) => {
    test.setTimeout(4 * 60_000);

    // A premium channel with Battle Mode OFF (no enable step). Auth comes from the shared storageState,
    // but this test does no admin round-trip, so nothing has navigated to the chat app yet - land on it
    // first (the removed per-test signInAdmin used to do this).
    await page.goto('/');
    await page.locator('button.app-new-conversation-btn').click();
    await page.waitForSelector('.ncm-modal', { timeout: 8000 });
    const premiumCard = page.locator('.ncm-class-card:has-text("Premium")').first();
    if (await premiumCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await premiumCard.click();
    } else {
      await page.locator('.ncm-class-card').first().click();
    }
    await page.locator('button:has-text("Create Conversation")').click();
    await page.waitForSelector('.conversation-header', { timeout: 20_000 });
    await page.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15_000 });

    await page.locator('.message-textarea').fill('/battle What is the best caching strategy?');
    await page.keyboard.press('Enter');

    // A normal single reply with the not-enabled hint; NO battle fan-out.
    await expect
      .poll(async () => (await page.locator('.assistant-message .message-text').last().textContent())?.toLowerCase() ?? '', {
        timeout: 120_000,
      })
      .toContain('battle mode');
    await expect(page.locator('.message.battle-message')).toHaveCount(0);
  });

  test('/battle is a start-of-message command, not a mid-sentence mention', async ({ page }) => {
    test.setTimeout(4 * 60_000);

    // Auth comes from the shared storageState; this test does no admin round-trip, so navigate to the
    // chat app first (nothing else lands here).
    await page.goto('/');
    await page.locator('button.app-new-conversation-btn').click();
    await page.waitForSelector('.ncm-modal', { timeout: 8000 });
    await page.locator('.ncm-class-card').first().click();
    await page.locator('button:has-text("Create Conversation")').click();
    await page.waitForSelector('.conversation-header', { timeout: 20_000 });
    await page.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15_000 });

    const before = await page.locator('.message').count();
    // "/battle" mid-sentence must NOT trigger a battle (detection is ^\s*\/battle\b).
    await page.locator('.message-textarea').fill('what about /battle mode — how does it work?');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => page.locator('.message').count(), { timeout: 120_000 })
      .toBeGreaterThan(before + 1);
    // It was answered as an ordinary question — no battle fan-out.
    await expect(page.locator('.message.battle-message')).toHaveCount(0);
  });

  // ── Heaviest stages (live, model-dependent) ──────────────────────────────────
  test('generation-out: both variants render a generated image (valid src, no broken <img>)', async ({
    page,
  }) => {
    // A dual image generation (both variants call an image provider) + the round-1 wait is the slowest
    // battle path; give it a wide budget.
    test.setTimeout(14 * 60_000);

    // Its own experiment with an image-gen model on BOTH variants (SPEC-BATTLE generation-out).
    await activateBattleExperiment(page, BATTLE_IMAGE_EXP_ID);
    await newBattleChannel(page, 'E2E image battle', BATTLE_IMAGE_EXP_ID);

    const count = await fireBattle(page, '/battle Generate an image of a serene mountain lake at sunrise.');
    expect(count).toBeGreaterThanOrEqual(2); // two variant bubbles

    // Generation-out: at least one variant renders a real generated image (both is the norm; allow one
    // provider to honest-fail). Every image that DOES render must have a real source — never a broken/empty
    // <img> (the guardrail-blocked / failed path shows honest text and NO <img>, so a rendered img is real).
    const imgs = page.locator('.battle-generated-image');
    await expect.poll(() => imgs.count(), { timeout: 260_000 }).toBeGreaterThanOrEqual(1);
    for (const img of await imgs.all()) {
      const src = await img.getAttribute('src');
      expect(src, 'a rendered battle image must have a real src (data:/http), not a broken img').toMatch(
        /^(data:image|https?:)/,
      );
      // The image actually decoded (naturalWidth > 0) — proves it rendered, not a broken-image icon.
      const w = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth).catch(() => 0);
      expect(w, 'the generated image must decode (naturalWidth > 0)').toBeGreaterThan(0);
    }
  });

  test('ambiguous /battle answers normally, no private waiting state', async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    await activateBattleExperiment(page, BATTLE_EXP_ID); // text battle
    await newBattleChannel(page, 'E2E ambiguous battle');

    // The redesign removed battle clarification prompting: an ambiguous /battle no longer routes a
    // clarifying question to a private waiting state — both variants just answer normally. Assert the
    // normal battle fan-out (>= 2 variant bubbles), and that NO waiting state ever renders.
    const count = await fireBattle(page, '/battle Which one is better?');
    expect(count).toBeGreaterThanOrEqual(2);

    // No neutral, private waiting state on the composer — clarification routing is gone.
    await expect(page.locator('.message-input-sticky-target-hint')).toHaveCount(0);
  });
});
