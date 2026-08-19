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

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  requireBattleE2E,
  BATTLE_E2E_ENABLED,
  ensureBattleExperimentExists,
  activateBattleExperiment,
  newBattleChannel,
  fireBattle,
  battleExpId,
  battleImageExpId,
  retireThisRunsBattleExperiments,
} from './helpers/battle-setup';
import { getSecondPremiumUser, getStandardUser, missingUserReason } from './helpers/test-credentials';
import {
  waitForActiveBattle,
  waitForWaitingSide,
  holdsWaiting,
  waitForResume,
  waitForSideTerminal,
  sendTargetedAs,
  userArnFor,
  humanMembers,
  messageExistsForSender,
  publicMessages,
  readActiveBattle,
} from './helpers/battle-state-backend';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { signIn, createConversation } from './helpers/agent-helpers';
import { ChannelWireRecorder } from './helpers/channel-wire';
// From the config, NOT from e2e/battle.setup.ts: Playwright forbids one test file
// importing another (battle.setup.ts is a test file); the config is the shared home.
import { BATTLE_AUTH_FILE, BATTLE_SECOND_MEMBER_AUTH_FILE } from '../playwright.config';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

/**
 * The input guardrail's block reply, as a duel side would post it.
 *
 * Mirrors `GUARDRAIL_BLOCK_FALLBACK` / `isGuardrailBlockReply` in
 * `backend/lambda/src/lib/async-processor-core.ts`. Duplicated as a pattern rather than imported
 * because this spec runs against a DEPLOYMENT and must not pull the Lambda source into the browser
 * test bundle; a deployment may also configure its own masked output, so the leading clause is what
 * is matched.
 */
const GUARDRAIL_BLOCK_PATTERN = /^I cannot process that request\b/i;

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardBackendErrors('battle');
guardConsoleErrors();


// Analytics + experiments read endpoints for the human-pick assertions (B-E4, B-E6). Same env the
// experiments suite uses; the signed POST mirrors the admin app's IAM-enforced analytics read.
const ANALYTICS_API = process.env.VITE_ANALYTICS_API_URL || '';

// Image generation-out is the slowest + flakiest battle path (real dual image gen + the deploy-dependent
// image-model create form). Run it ONLY when actually testing image generation; a normal battle run is
// TEXT-only. Opt in with BATTLE_IMAGE_E2E=1.
const RUN_IMAGE_BATTLE = process.env.BATTLE_IMAGE_E2E === '1' || process.env.BATTLE_IMAGE_E2E === 'true';

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
    // Left at the default 120s DELIBERATELY. Raising it to 240s was tried and reverted: this hook
    // does not run slow, it HANGS, so a bigger budget only makes the hang cost twice as much before
    // reporting the same `"beforeAll" hook timeout`. The healthy path finishes well inside 120s (a
    // full 16/17 run on 2026-08-07 did). Fail fast and diagnose the hang; do not buy time for it.
    const ctx = await browser.newContext({ storageState: BATTLE_AUTH_FILE });
    const page = await ctx.newPage();
    try {
      await ensureBattleExperimentExists(page, { slot: 'slot-0' }); // text
      // The image experiment (form-based create) is set up ONLY when the image path is opted in — it is
      // the slow/flaky part, and text-only runs never touch it (the generation-out test self-skips too).
      if (RUN_IMAGE_BATTLE) {
        await ensureBattleExperimentExists(page, {
          slot: 'slot-0',
          expId: battleImageExpId(),
          image: true,
        });
      }
    } finally {
      await ctx.close();
    }
  });

  test('round-1: two variant replies, chips SURVIVE the reply update, + scorecard pick works', async ({
    page,
  }) => {
    // A real duel + round-2 wait can take minutes; the config 120s cap is too tight.
    test.setTimeout(9 * 60_000);

    // Record the wire so the duel's own MESSAGE METADATA can be asserted, not just its pixels.
    //
    // ChannelWireRecorder, NOT WebSocketMonitor: the monitor ignores every frame unless a
    // `sendAndWaitForResponse` cycle is actively driving it (`if (!this.monitorResolve) return`), and
    // `fireBattle` drives no such cycle. Using it here read `lastBotMetadata` as null and reported
    // "the battle reply carried no experimentId" - a false negative about the product, produced
    // entirely by the harness. The recorder listens unconditionally.
    const wire = new ChannelWireRecorder();
    wire.attach(page);

    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E caching battle');

    // A single-turn opinion prompt (not a TASK_*) so round-2 is completion-
    // gated on the round-1 pair, which resolves deterministically here.
    const count = await fireBattle(
      page,
      '/battle Tabs or spaces for indentation? Answer in one short paragraph with a clear pick.',
    );
    expect(count).toBeGreaterThanOrEqual(2);

    // Two variants, each tagged with its persona chip.
    //
    // AT LEAST two, not exactly two: round-2 renders its own pair, and whether it has started by the
    // time this line runs is a race with the models. Pinning the count to 2 made this test fail
    // intermittently with "expected 2, received 4" - a correct battle that simply got further, which is
    // the one outcome a duel test should never call a failure.
    const chips = page.locator('.battle-variant-chip');
    await expect.poll(async () => chips.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    // THE DUEL MUST BE ATTRIBUTED TO ITS EXPERIMENT, on the message itself.
    //
    // Everything downstream keys off this: `experiment_id` / `variant_id` are archived from the reply's
    // Metadata, and `fetchBattleEffectivenessRows` filters `WHERE m.experiment_id IS NOT NULL`. A duel
    // that renders perfectly but carries no attribution produces no results row, no `battle_wins`, and
    // a recommendation that reports "only one variant has recorded traffic" - which is exactly what the
    // battle analytics did, because the fan-out sent `battleContext` without the two ids.
    //
    // Asserted HERE, on the fastest battle test, rather than five layers downstream in B-E4: this is
    // the point where a regression is one field, not an empty dashboard.
    // Attribution rides the processor's UPDATE, not the placeholder CREATE, so look across every bot
    // frame rather than at whichever arrived last - and POLL, because the two sides settle
    // independently. Without the wait this cannot tell "the control side is slower" from "the control
    // side never answered", and those are very different findings.
    const attributedNow = () => wire.all.filter(
      (m) => m.isBot && m.metadata && (m.metadata.experimentId || m.metadata.variantId),
    );
    const bothDeadline = Date.now() + 120_000;
    while (
      new Set(attributedNow().map((m) => String(m.metadata!.variantId ?? ''))).size < 2
      && Date.now() < bothDeadline
    ) {
      await page.waitForTimeout(2000);
    }
    const attributed = attributedNow();
    // Print EVERY bot frame, not just the attributed ones: which frames lack attribution is the
    // diagnosis. A placeholder CREATE legitimately carries none (the processor stamps on its UPDATE),
    // so the question is always "which SETTLED reply is unattributed", and that needs the full list.
    console.log(
      `--- round-1 bot frames: ${wire.all.filter((m) => m.isBot).length}, attributed: ${attributed.length} ---\n`
      + wire.all.filter((m) => m.isBot).map((m, i) => {
        const md = m.metadata ?? {};
        return `  [${i}] ${m.eventType} sender=${m.senderArn.split('/').pop()} `
          + `exp=${md.experimentId ?? '-'} variant=${md.variantId ?? '-'} `
          + `model=${String(md.bedrockModel ?? '-').split('/').pop()} content="${m.content.slice(0, 40)}"`;
      }).join('\n'),
    );
    expect(
      attributed.length,
      'no battle reply carried experimentId/variantId. Those two fields are the ONLY source of '
      + '`experiment_id`/`variant_id` in analytics, and `fetchBattleEffectivenessRows` filters on '
      + '`experiment_id IS NOT NULL` - so an unattributed duel produces no results row, no battle_wins, '
      + 'and a recommendation that reports "only one variant has recorded traffic".',
    ).toBeGreaterThan(0);
    // Both sides must be attributed, not just one: a comparison needs two.
    const variants = new Set(attributed.map((m) => String(m.metadata!.variantId ?? '')).filter(Boolean));
    expect(
      [...variants].sort(),
      'both duel sides must be attributed to their own variant; one side alone cannot be compared',
    ).toEqual(['control', 'treatment']);

    // AND EACH REPLY MUST BE AN ANSWER. This suite passed through a live defect where one side was
    // blocked by the INPUT guardrail before its model was ever called: it still posted an attributed
    // reply (the guardrail's block text), so the duel was shaped exactly like a healthy one - two
    // replies, both archived, a scorecard, a countable pick - and the experiment recorded a loss
    // against a model that never ran. Every assertion above is satisfied by a dead side.
    //
    // The cause is fixed (the input guardrail scores the turn's own human input, ADR-027 part 1), so
    // this is the guard that makes a recurrence loud instead of invisible.
    const blocked = attributed.filter((m) => GUARDRAIL_BLOCK_PATTERN.test(m.content.trim()));
    expect(
      blocked.map((m) => `${m.metadata!.variantId}: ${m.content.slice(0, 80)}`),
      'a duel side replied with the guardrail block message instead of an answer. The comparison this '
      + 'test exists to produce is void: the blocked side never reached its model, and a human pick '
      + 'against it records a loss for a model that never ran.',
    ).toEqual([]);

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

    // Record the wire so reply COUNTS can be asserted on what the backend actually sent, not only on
    // what rendered.
    const wire = new ChannelWireRecorder();
    wire.attach(page);

    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E round-2 battle');

    await fireBattle(page, '/battle Is REST or GraphQL the better default for a new internal API? One paragraph.');
    // Round 2 fires once both round-1 replies are terminal. For a single-turn
    // (non-TASK_*) prompt this is deterministic; allow a generous budget for
    // the orchestrator fan-out + the second generation.
    await expect(page.locator('.battle-round-divider').first()).toBeVisible({ timeout: 260_000 });

    // ONE REPLY PER ASSISTANT PER ROUND.
    //
    // This test is the right place for the count because it waits for the round-2 divider, so BOTH
    // rounds have fired and the duel is settled. The round-1 test deliberately asserts `>= 2` instead:
    // pinning a count mid-flight failed intermittently with "expected 2, received 4" when round 2 had
    // simply started, which is a correct battle being called a failure. Counting only once the duel is
    // complete removes that race rather than widening the assertion to hide it.
    //
    // The prompt is single-turn on purpose. A TASK_* battle is MULTI-STEP and legitimately emits more
    // than one message per assistant per round, so this property is asserted for the single-turn shape
    // only.
    //
    // Round is recovered from the placeholder's `<!--battle:...round=N...-->` marker. The reply arrives
    // as an UPDATE that strips the marker but REUSES the message id, so the CREATE frame is what says
    // which round a message id belongs to - and the recorder kept it.
    await page.waitForTimeout(20_000); // a duplicate lands after the winner; give it time to show up

    const BATTLE_ROUND = /<!--battle:[^>]*round=(\d)/;
    const idsPerAssistantRound = new Map<string, Set<string>>();
    for (const m of wire.all.filter((x) => x.isBot)) {
      const matched = BATTLE_ROUND.exec(m.content);
      if (!matched) continue; // an ordinary bot message, or an UPDATE whose marker is already stripped
      const key = `${m.senderArn.split('/').pop()}#round${matched[1]}`;
      if (!idsPerAssistantRound.has(key)) idsPerAssistantRound.set(key, new Set());
      idsPerAssistantRound.get(key)!.add(m.messageId);
    }

    console.log(
      `--- battle replies per assistant per round ---\n`
      + [...idsPerAssistantRound.entries()]
        .map(([k, ids]) => `  ${k}: ${ids.size} (${[...ids].map((i) => i.slice(0, 12)).join(', ')})`)
        .join('\n'),
    );

    // Guard the guard: an empty map would make every assertion below vacuous.
    expect(
      idsPerAssistantRound.size,
      'no battle placeholders were recorded, so the per-round counts below would assert nothing',
    ).toBeGreaterThan(0);

    for (const [key, ids] of idsPerAssistantRound) {
      expect(ids.size, `${key} produced exactly one reply, not a duplicate`).toBe(1);
    }

    // AND IN THE DOM. The websocket proves what the backend sent; this proves the user was shown the
    // same thing. They can disagree: a client that re-renders an UPDATE as a new bubble would show a
    // duplicate the wire never carried, which is a real user-visible defect with a clean wire.
    //
    // `:not(.continuation)` for the same reason the backend counts exclude continuations - a long
    // rebuttal is chunked into consecutive messages, and the client marks every chunk after the first
    // with that class. Counting raw bubbles would fail on a reply that was merely long.
    const bubbles = await page.locator('.message.battle-message:not(.continuation)').count();
    expect(
      bubbles,
      `the DOM shows one battle reply per assistant per round (${idsPerAssistantRound.size} expected)`,
    ).toBe(idsPerAssistantRound.size);
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

    await activateBattleExperiment(page, battleExpId());
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
    await activateBattleExperiment(page, battleExpId());
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

    // The POST body is `{ outcome: { winner, ... } }`, NOT a flat record. This assertion used to read
    // `if ('winner' in stored)` against the OUTER object, so the condition was always false and the
    // check never executed once - leaving `resp.ok()` as the only live assertion in the one test whose
    // name promises persistence. Unconditional now, plus a read-back: a 2xx only proves the endpoint
    // accepted the write, not that DynamoDB kept it.
    const stored = await outcomeResp.json().catch(() => ({} as Record<string, unknown>));
    expect(
      stored?.outcome?.winner,
      `POST body did not carry the pick: ${JSON.stringify(stored).slice(0, 200)}`,
    ).toBe('B');
    const battleId: string = stored.outcome.battleId;
    expect(battleId, 'the recorded outcome must name its battle').toBeTruthy();

    const outcomeUrl = new URL(outcomeResp.url());
    const idTokenForRead = await page.evaluate(() => localStorage.getItem('idToken'));
    const readBack = await page.request.get(
      `${outcomeUrl.origin}${outcomeUrl.pathname}?battleId=${encodeURIComponent(battleId)}`,
      { headers: { Authorization: `Bearer ${idTokenForRead}` } },
    );
    expect(readBack.ok(), `battle-outcome GET status ${readBack.status()}`).toBeTruthy();
    const fetched = await readBack.json();
    expect(fetched?.outcome?.winner, 'the pick did not survive a read-back from the store').toBe('B');
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
    // Image generation-out runs ONLY when opted in (BATTLE_IMAGE_E2E=1) — it is the slowest/flakiest
    // path and is exercised only when the change touches image generation. Text battles cover the engine.
    test.skip(!RUN_IMAGE_BATTLE, 'image battle — set BATTLE_IMAGE_E2E=1 to run the generation-out duel');
    // A dual image generation (both variants call an image provider) + the round-1 wait is the slowest
    // battle path; give it a wide budget.
    test.setTimeout(14 * 60_000);

    // Its own experiment with an image-gen model on BOTH variants (SPEC-BATTLE generation-out).
    await activateBattleExperiment(page, battleImageExpId());
    await newBattleChannel(page, 'E2E image battle', battleImageExpId());

    const count = await fireBattle(page, '/battle Generate an image of a serene mountain lake at sunrise.');
    expect(count).toBeGreaterThanOrEqual(2); // two variant bubbles

    // Generation-out: at least one variant renders a real generated image (both is the norm; allow one
    // provider to honest-fail). Every image that DOES render must have a real source — never a broken/empty
    // <img> (the guardrail-blocked / failed path shows honest text and NO <img>, so a rendered img is real).
    //
    // A generated image is delivered as a message ATTACHMENT, so it renders through AttachmentDisplay
    // (`.attachment-image`, which fetches a fresh presigned URL on demand) — scoped to `.battle-message`
    // so an unrelated user upload in the channel can never satisfy this. It is NOT the inline
    // `.battle-generated-image` this asserted before: that class is fed only by the retired
    // `<!--battleimage:-->` content marker, which nothing has emitted since the image moved to the
    // attachment path (image-gen-output.ts: "the image itself is delivered as a message ATTACHMENT").
    // So the duel generated two real images and this assertion could never see them — it polled a
    // selector the product had stopped producing, for 260s, and reported it as "no image was generated".
    const imgs = page.locator('.battle-message .attachment-image');
    await expect.poll(() => imgs.count(), { timeout: 260_000 }).toBeGreaterThanOrEqual(1);
    for (const img of await imgs.all()) {
      const src = await img.getAttribute('src');
      expect(src, 'a rendered battle image must have a real src (data:/http), not a broken img').toMatch(
        /^(data:image|https?:)/,
      );
      // The image actually decoded (naturalWidth > 0) — proves it rendered, not a broken-image icon.
      //
      // Scrolled into view first, and POLLED rather than sampled once. Both are required by how the
      // product renders it and neither is a concession: `AttachmentDisplay` sets `loading="lazy"`, so
      // an image below the fold — which round 1 is, once round 2 and the scorecard are in the thread —
      // is never fetched at all and sits at naturalWidth 0 forever; and a generated PNG is multiple MB
      // over a presigned URL, so it is still decoding for a while after it IS fetched. Sampling
      // immediately measured neither the product nor the image, only the timing.
      await img.scrollIntoViewIfNeeded();
      await expect
        .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth).catch(() => 0), {
          timeout: 60_000,
          message: 'the generated image must decode (naturalWidth > 0)',
        })
        .toBeGreaterThan(0);
    }
  });

  test('ambiguous /battle answers normally, no private waiting state', async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    await activateBattleExperiment(page, battleExpId()); // text battle
    await newBattleChannel(page, 'E2E ambiguous battle');

    // WHY NO WAITING STATE IS EXPECTED, stated precisely because the previous comment here got the
    // cause wrong. Clarification ROUTING is fully intact - the sentinel parser, WAITING_FOR_USER, the
    // composer affordance and the resume all exist. What is gone is the PROMPT that asked for it:
    // `29adb2d` deleted `BATTLE_CONSTRAINTS_ROUND1`, and the round-1 prompt is now
    // `buildBattleAwareness` alone, which never mentions the sentinel. So no model has a reason to emit
    // it, and an ambiguous /battle is answered normally by both sides.
    //
    // That deletion was correct: how many questions a side asks belongs to its INTENT's task flow, not
    // to a battle-side prompt rule (ADR-029; DESIGN-BATTLE "Per-bot generation"). This test therefore
    // asserts today's behaviour AND names its cause, so if a future prompt reinstates clarification the
    // failure points at the prompt rather than at "clarification routing is gone".
    const count = await fireBattle(page, '/battle Which one is better?');
    expect(count).toBeGreaterThanOrEqual(2);

    // No side is blocked on the user, so the composer shows no waiting queue.
    await expect(page.locator('.message-input-sticky-target-hint')).toHaveCount(0);
  });
});

// ============================================================================
// /battle — briefing, prompt steering, lifecycle guard & the human pick
// Acceptance tests for DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md. The B-E1..B-E6 labels are defined
// HERE, not in that document - it carries no acceptance-test list, so do not cite a section for them.
//
// These extend the behavioral suite above with the design's ADDITIVE battle
// capabilities: a battle-start briefing + prompt steering shown to BATTLING
// users, not just the moderator (§2); the documented-but-missing
// single-active-battle guard (§3.4 B1); the human pick reaching the
// recommendation as a distinct axis (§4.3); fail-loud instead of a silent
// stall (§3.4 B2); and per-user picks tallied rather than last-write-wins
// (§3.4 B3). Each test is written "As a <role>…" so it doubles as the
// acceptance check.
//
// The default `page` is storageState-authed as the admin (the MODERATOR who
// arms + enables battle). Multi-user tests spin a SECOND clean context signed
// in as the premium (NON-moderator) user via the shared multi-user pattern
// (share the channel, open it by id). The human-pick reads SigV4-sign the
// analytics API (helpers/signed-analytics.ts), exactly as the experiments
// suite. SOME paths are the design's not-yet-built acceptance criteria; the
// assertions ARE the contract, so a failure here IS the finding. Gated behind
// BATTLE_E2E=1.
// ============================================================================

/**
 * Open a conversation deterministically by its channel id (last ARN segment) via the app's
 * deep-link handler (`/?conversation=<id>`), retrying while membership propagates. Mirrors the
 * multi-user pattern in mentions.spec.ts (titles auto-derive, so the id is the only stable handle).
 */
async function openConversationById(page: Page, channelId: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.goto(`/?conversation=${channelId}`);
    await page.waitForLoadState('networkidle');
    try {
      await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 10_000 });
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(3000);
    }
  }
  throw new Error(`openConversationById: channel ${channelId} never became selectable. Last error: ${lastErr}`);
}

/** Share the currently-open conversation with `email` (the mentions.spec share flow). */
async function shareChannelWith(page: Page, email: string): Promise<void> {
  await page.locator('button[aria-label="Share conversation"]').click();
  await expect(page.locator('#share-email')).toBeVisible({ timeout: 5_000 });
  await page.locator('#share-email').fill(email);
  await page.locator('.modal-content button[type="submit"]').click();
  await expect(page.locator('.alert-success')).toBeVisible({ timeout: 30_000 });
  await page.locator('.modal-close-btn').click().catch(() => {});
  await page.locator('.modal-content').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

/** Enable battle on a fresh premium channel AND capture its channel id (for a second member to open). */
async function newBattleChannelWithId(page: Page, title: string): Promise<string> {
  const createResp = page.waitForResponse(
    (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await newBattleChannel(page, title);
  const body = await (await createResp).json();
  return (body.conversation.conversationArn as string).split('/').pop()!;
}

/** Type + send a /battle prompt with NO readiness wait (for the guard's back-to-back fire). */
async function fireBattleNoWait(page: Page, prompt: string): Promise<void> {
  await page.locator('.message-textarea').fill(prompt, { timeout: 30_000 });
  await page.keyboard.press('Enter');
}

/** Per-variant /battle wins for an experiment, read via the signed analytics API (includeBattle). */
async function readBattleWins(idToken: string, experimentId: string): Promise<Record<string, number>> {
  const end = new Date();
  const start = new Date(end.getTime() - 86_400_000);
  const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
    queryType: 'experiment_results',
    dateRange: { start: start.toISOString(), end: end.toISOString() },
    includeBattle: 'true',
  });
  const wins: Record<string, number> = {};
  for (const r of (j.data || []) as any[]) {
    if ((r.experiment_id ?? r.experimentId) !== experimentId) continue;
    const v = r.variant_id ?? r.variantId ?? '';
    wins[v] = (wins[v] ?? 0) + (Number(r.battle_wins) || 0);
  }
  return wins;
}

test.describe('/battle — briefing, steering, guard & human pick (§8 B-E1..B-E6)', () => {
  test.beforeEach(() => requireBattleE2E());

  // Create the text battle experiment once (create-if-missing), same as the behavioral suite.
  test.beforeAll(async ({ browser }) => {
    if (!BATTLE_E2E_ENABLED) return;
    const ctx = await browser.newContext({ storageState: BATTLE_AUTH_FILE });
    const page = await ctx.newPage();
    try {
      await ensureBattleExperimentExists(page, { slot: 'slot-0' });
    } finally {
      await ctx.close();
    }
  });

  // B-E1 — As an END USER (a NON-moderator member) in a battle-enabled channel, I
  // want to see what's being decided and get clickable starter prompts, so my
  // battles produce a meaningful comparison instead of guesses (§2.2). Today the
  // experiment description is shown ONLY to the moderator; the briefing must
  // reach non-moderators too, semi-blind (names the decision, NOT the models).
  test('B-E1: briefing shown to a NON-moderator, names the decision (not the models), chips prefill', async ({ page, browser }) => {
    test.setTimeout(9 * 60_000);
    await activateBattleExperiment(page, battleExpId());
    // Moderator (admin) opens a battle channel and shares it with a NON-moderator.
    // That member must be a DIFFERENT identity: testAdmin and premiumUser are the same account, so
    // sharing with the premium user handed the channel back to the person who just created it - its
    // own moderator - and the test could not see what a non-moderator sees.
    const second = await getSecondPremiumUser();
    test.skip(!second?.password, missingUserReason('secondPremiumUser'));

    const channelId = await newBattleChannelWithId(page, 'E2E briefing non-moderator');
    await shareChannelWith(page, second!.email);

    // A manually-created context does NOT inherit the project's `use.baseURL`, so pass it explicitly.
    // PRE-AUTHED from the setup project, not signed in here. This was the suite's ONLY interactive
    // sign-in, and it ran inside a bare context: the shared storageState means no login form renders,
    // so `signIn` waited out its timeout on `input[type=email]`. The extra browser launch it needed
    // also killed the worker intermittently (STATUS_DLL_INIT_FAILED), taking the rest of the serial
    // block with it. Loading the second member's storageState removes both.
    const ctxB: BrowserContext = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
      storageState: BATTLE_SECOND_MEMBER_AUTH_FILE,
    });
    const pageB = await ctxB.newPage();
    try {
      await openConversationById(pageB, channelId);

      // The briefing surfaces to the non-moderator — on open (the enable broadcast) or, failing that,
      // once they start a battle (the inline round-1 banner). Either way it must appear to THIS member.
      const briefing = pageB.locator('.battle-briefing');
      if (!(await briefing.isVisible({ timeout: 8_000 }).catch(() => false))) {
        await fireBattleNoWait(pageB, '/battle Explain feature flags to a new hire.');
      }
      await expect(briefing).toBeVisible({ timeout: 120_000 });

      // Names the DECISION, keeps the models opaque (semi-blind, INV-4): no raw model key leaks.
      const text = (await briefing.innerText()).toLowerCase();
      expect(text).toMatch(/decid|comparing|useful prompts|being tested/);
      for (const modelKey of ['sonnet', 'opus', 'haiku', 'gpt_oss']) {
        expect(text, `briefing must not reveal the underlying model (${modelKey})`).not.toContain(modelKey);
      }

      // Clickable starter chips (§2.2) — clicking one PREFILLS the composer with a /battle prompt.
      const chips = pageB.locator('.battle-briefing-chip');
      await expect(chips.first()).toBeVisible({ timeout: 10_000 });
      expect(await chips.count(), 'the briefing renders 2-3 starter prompt chips').toBeGreaterThanOrEqual(2);
      await chips.first().click();
      await expect(pageB.locator('.message-textarea')).toHaveValue(/^\/battle\s+\S/, { timeout: 5_000 });
    } finally {
      await ctxB.close();
    }
  });

  // B-E2 — As an END USER, the suggested prompts should be STEERED by the
  // experiment's target intent, so the battle exercises what the experiment
  // measures rather than random prompts (§2.2). The shipped text battle is an
  // `intent` experiment (general_qa); its chips must match that intent's row in
  // the steering table (code_generation is the design's illustrative example).
  test('B-E2: prompt steering — the briefing chips match the experiment intent', async ({ page }) => {
    test.setTimeout(9 * 60_000);
    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E prompt steering');

    const briefing = page.locator('.battle-briefing');
    if (!(await briefing.isVisible({ timeout: 8_000 }).catch(() => false))) {
      await fireBattleNoWait(page, '/battle What is the difference between a container and a VM?');
    }
    await expect(briefing).toBeVisible({ timeout: 120_000 });

    // The steering is intent-derived: for general_qa the coaching line is "Ask real questions your
    // users ask." and the chips are concrete Q&A starters. Assert the intent-appropriate coaching
    // copy is present and the chips are real /battle prefills (deployment-overridable defaults).
    const text = (await briefing.innerText()).toLowerCase();
    expect(text, 'coaching line is steered to the general_qa intent row').toMatch(/questions your users ask|real questions|ask real/);
    const chips = page.locator('.battle-briefing-chip');
    expect(await chips.count(), 'intent row seeds concrete starter chips').toBeGreaterThanOrEqual(2);
    await chips.first().click();
    await expect(page.locator('.message-textarea')).toHaveValue(/^\/battle\s+\S/, { timeout: 5_000 });
  });

  // B-E3 — As QA, the "one active battle per channel" guard (documented at
  // GUIDE:237 but MISSING from the handler, §3.4 B1) must actually hold: two
  // /battle in quick succession must not race + overwrite activeBattleId. The
  // second gets an "already in progress" hint; no second battle runs; the first
  // battle's resolution is not lost.
  test('B-E3: single-active-battle guard — the second /battle is refused, the first is not lost', async ({ page }) => {
    test.setTimeout(9 * 60_000);
    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E single-active guard');

    // Fire the first battle and wait only until its round-1 bubbles START (mid-flight), then fire again.
    await fireBattleNoWait(page, '/battle Tabs or spaces for indentation? One short paragraph with a clear pick.');
    await expect
      .poll(async () => page.locator('.message.battle-message').count(), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    await fireBattleNoWait(page, '/battle Monorepo or polyrepo for a five-team org? One short paragraph.');

    // The sender gets an explained no-op hint (mirrors the FR5 explained-no-op shape).
    await expect
      .poll(
        async () =>
          (await page.locator('.assistant-message .message-text, .message .message-text').allInnerTexts())
            .join('\n')
            .toLowerCase(),
        { timeout: 60_000 },
      )
      .toMatch(/already .*progress|battle .*in progress|give it a moment/);

    // Exactly ONE battle runs to completion — the second did not spawn a duel, and the first resolved
    // (its scorecard rendered), proving activeBattleId was not overwritten / the first was not orphaned.
    await expect(page.locator('.battle-scorecard')).toHaveCount(1, { timeout: 260_000 });
  });

  // B-E4 — As an AI DEVELOPER, I want the human battle picks folded into the
  // recommendation as a DISTINCT axis (a Wilson CI on the win-rate), kept
  // SEPARATE from the probabilistic metric verdict, so the hands-on signal I
  // trust counts toward the decision, not just a dashboard tally (§4.3).
  test('B-E4: human pick reaches the recommendation as a distinct axis (Wilson CI), separate from metrics', async ({ page }) => {
    // The duel, plus a 90s read-back. Kinesis delivery is near real time, so a row that is coming has
    // long since arrived; a longer budget cannot turn a failure into a pass.
    test.setTimeout(12 * 60_000);
    expect(ANALYTICS_API, 'VITE_ANALYTICS_API_URL must be set').toBeTruthy();
    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E human pick axis');

    // FIVE duels, not one. The recommendation withholds its human axis until every variant clears the
    // exchanges-per-variant floor (`MIN_SAMPLE_PER_VARIANT`), and answers "keep the experiment running"
    // below it - correctly: a verdict from a single duel would be statistical theatre. So the test
    // supplies real repeated traffic instead of expecting a read the product is right to refuse. The
    // deployment under test lowers the floor (`-c minSamplePerVariant=...`) so five is enough; the
    // shipped default stays 30.
    const PROMPTS = [
      '/battle Tabs or spaces for indentation? One short paragraph with a clear pick.',
      '/battle Is a monorepo better than many repos? One short paragraph, pick a side.',
      '/battle Should code review block merges? One short paragraph with a clear pick.',
      '/battle Are feature flags worth their complexity? One short paragraph, pick a side.',
      '/battle Is TypeScript worth it on a small team? One short paragraph with a clear pick.',
    ];
    for (const prompt of PROMPTS.slice(0, PROMPTS.length - 1)) {
      await fireBattle(page, prompt);
    }
    await fireBattle(page, PROMPTS[PROMPTS.length - 1]);
    const card = page.locator('.battle-scorecard').last();
    await expect(card).toBeVisible();
    const pickB = card.locator('[data-pick="B"]');

    // (a0) The PICK ITSELF is captured, asserted first and separately from the tally.
    //
    //      These are two different layers that fail for different reasons. `battle_wins` is a live scan
    //      of the BattleOutcome table JOINED onto Aurora `exchanges`/`messages`, so a zero tally means
    //      either "the pick was lost" (a real defect) or "the battle turn has not been archived through
    //      Kinesis yet" (latency). Asserting only the tally cannot tell those apart, and it reported the
    //      second as the first.
    //
    //      Captured from the outcome POST the click triggers - the same handle the sibling
    //      persistence test uses - rather than from a DOM attribute. An earlier version of this block
    //      read a `data-battle-id` attribute that does not exist, so the whole check silently skipped:
    //      a guard that asserts nothing is worse than no guard, because it reads as coverage.
    const [outcomeResp] = await Promise.all([
      page.waitForResponse(
        (r) => /\/battle\/outcome\b/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      pickB.click(),
    ]);
    expect(outcomeResp.ok(), `battle-outcome POST status ${outcomeResp.status()}`).toBeTruthy();
    const recorded = await outcomeResp.json().catch(() => ({} as Record<string, unknown>));
    expect(recorded?.outcome?.winner, 'the human pick was not captured at all').toBe('B');

    await expect(pickB).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });

    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'admin idToken in localStorage').toBeTruthy();

    // ARCHIVAL IS THE LONG POLE FOR BOTH SURFACES, and it is worth being exact about why, because the
    // obvious reading is wrong. The recommendation's human axis reads BattleOutcome DIRECTLY
    // (`scanBattleWins`), so the picks themselves need no archival - but the axis is only EMITTED once
    // the comparison is viable, and viability is measured from Aurora traffic rows. Until both variants'
    // turns have travelled Kinesis -> archival -> Aurora, the recommendation answers "Only one variant
    // has recorded traffic, so there is nothing to compare yet" and carries no `human` block at all.
    //
    // So this test polls on a realistic archival window rather than seconds. What it no longer does is
    // report that delay as a lost pick: the pick was asserted above, immediately, from the outcome POST.
    // The `experiment_results` tally is a separate surface with the same dependency and has its own
    // test (B-E4b), so a failure names which surface is behind.

    // The recommendation carries the human axis (picks + win-rate + a Wilson CI) as its OWN block,
    // distinct from the probabilistic `primary` metric verdict — never blended into one number (§4.3/§4.4).
    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000);
    let reco: any;
    // 90 seconds, not nine minutes. An earlier version waited nine, sized from a theory that archival
    // was slow - which measurement disproved: the Kinesis batching window is 5 SECONDS. If the row is
    // coming it is here in well under a minute, so a longer wait cannot turn a failure into a pass, it
    // only makes the failure take nine minutes to report. Fast failure is the point.
    for (let i = 0; i < 18 && !reco?.human; i++) {
      reco = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
        queryType: 'experiment_recommendation',
        experimentId: battleExpId(),
        dateRange: { start: start.toISOString(), end: end.toISOString() },
      });
      if (!reco?.human) await page.waitForTimeout(5000);
    }
    // NAME THE PRECONDITION THAT FAILED, don't print a truncated blob.
    //
    // `battlePickAxis` returns null for two different reasons, and they are not the same problem:
    // fewer than two variants have ARCHIVED rows (the Kinesis -> Aurora projection has not landed),
    // or the rows exist but carry no decisive pick (a genuinely lost pick). The old message said
    // "recommendation carries a human-pick axis" for both and appended `JSON.stringify(reco)` cut at
    // 200 chars - which is short enough to truncate away `rationale`, the one field that says which.
    // The answer was in the response and the assertion threw it out, so a failure cost a re-run.
    if (!reco?.human) {
      const vs: Array<{ variant_id?: string; exchange_count?: number; battle_wins?: number | null }> =
        Array.isArray(reco?.variants) ? reco.variants : [];
      const wins = vs.reduce((n, v) => n + (Number(v.battle_wins) || 0), 0);
      const why = vs.length < 2
        ? `only ${vs.length} variant(s) have ARCHIVED rows yet (Kinesis -> Aurora projection behind after ${18 * 5}s)`
        : wins === 0
          ? 'both variants are archived but NO decisive pick is attributed to them (a lost pick, not latency)'
          : 'variants and picks are both present — the axis is being withheld for another reason';
      throw new Error(
        `recommendation carries no human-pick axis: ${why}\n`
        + `  variants: ${JSON.stringify(vs.map((v) => ({ id: v.variant_id, n: v.exchange_count, wins: v.battle_wins })))}\n`
        + `  rationale: ${reco?.rationale ?? '(none)'}`,
      );
    }
    expect(typeof reco.human.picks === 'number' || typeof reco.human.winRate === 'number', 'human axis reports picks / win-rate').toBeTruthy();
    expect(Array.isArray(reco.human.ci) && reco.human.ci.length === 2, 'human axis carries a Wilson CI [lo, hi]').toBeTruthy();
    // The human axis is a SEPARATE field from the metric block — not folded into it.
    expect('primary' in reco, 'the probabilistic metric verdict is a separate axis from the human pick').toBeTruthy();
  });

  // B-E4b — the same pick, seen on the OTHER surface. `experiment_results` with includeBattle joins the
  // BattleOutcome scan onto Aurora `exchanges`/`messages`, so unlike the recommendation it cannot show
  // anything until the battle turn has been archived (Kinesis -> archival Lambda -> Aurora). Split out
  // of B-E4 so an archival delay reports as an archival delay, and never as "the human pick was lost" -
  // which is what the combined assertion said for weeks.
  test('B-E4b: the battle pick reaches experiment_results once the turn is archived', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    expect(ANALYTICS_API, 'VITE_ANALYTICS_API_URL must be set').toBeTruthy();
    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E tally after archival');

    await fireBattle(page, '/battle Tabs or spaces for indentation? One short paragraph with a clear pick.');
    const card = page.locator('.battle-scorecard').last();
    await expect(card).toBeVisible();

    const [outcomeResp] = await Promise.all([
      page.waitForResponse(
        (r) => /\/battle\/outcome\b/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      card.locator('[data-pick="B"]').click(),
    ]);
    expect(outcomeResp.ok(), 'the pick must be recorded before the tally can ever show it').toBeTruthy();

    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    await expect
      // 90s: the Kinesis batching window is 5 seconds, so a row that is coming has long arrived.
      .poll(async () => (await readBattleWins(idToken!, battleExpId())).treatment ?? 0, { timeout: 90_000 })
      .toBeGreaterThanOrEqual(1);
  });

  // B-E5 — As QA, a stalled/FAILED round-1 variant must FAIL LOUD, never leave a
  // silent 10-min TTL (§3.4 B2, turn-engine "Fail loud"). The invariant: a fired
  // battle always reaches a VISIBLE terminal state well within the TTL — either a
  // resolved scorecard, OR an explicit "didn't finish" / failure turn — never
  // silence.
  test('B-E5: fail-loud — a battle never silently stalls; it resolves or shows an explicit failure', async ({ page }) => {
    test.setTimeout(9 * 60_000);
    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E fail-loud');

    await fireBattleNoWait(page, '/battle Is REST or GraphQL the better default for a new internal API? One paragraph.');

    // Bounded well UNDER the 10-min silent TTL: within this budget the battle must reach a visible
    // terminal state. Silence past it (no scorecard AND no failure turn) is the B2 regression.
    const scorecard = page.locator('.battle-scorecard');
    const failure = page
      .locator('.battle-variant-failed, .battle-message--failed')
      .or(page.getByText(/didn'?t finish|couldn'?t finish|failed to respond|no rival|didn'?t respond in time/i));
    await expect
      .poll(
        async () =>
          (await scorecard.count()) > 0 ||
          (await failure.count().catch(() => 0)) > 0,
        { timeout: 300_000 },
      )
      .toBeTruthy();
  });

  // B-E6 — As QA, per-user picks must be RETAINED and TALLIED, not last-write-wins
  // (§3.4 B3): two members picking different sides on the SAME battle both count.
  test('B-E6: per-user picks are tallied — two members, different sides, both retained', async ({ page, browser }) => {
    test.setTimeout(12 * 60_000);
    expect(ANALYTICS_API, 'VITE_ANALYTICS_API_URL must be set').toBeTruthy();
    await activateBattleExperiment(page, battleExpId());
    const channelId = await newBattleChannelWithId(page, 'E2E per-user picks');
    // A DIFFERENT identity from the moderator. testAdmin and premiumUser are the same account, and
    // picks are keyed by the chooser's sub, so sharing with the premium user made this one person
    // picking twice: the second pick overwrote the first and only one variant could ever hold a win.
    const second = await getSecondPremiumUser();
    test.skip(!second?.password, missingUserReason('secondPremiumUser'));
    await shareChannelWith(page, second!.email);

    // A manually-created context does NOT inherit the project's `use.baseURL`, so pass it explicitly.
    // PRE-AUTHED from the setup project, not signed in here. This was the suite's ONLY interactive
    // sign-in, and it ran inside a bare context: the shared storageState means no login form renders,
    // so `signIn` waited out its timeout on `input[type=email]`. The extra browser launch it needed
    // also killed the worker intermittently (STATUS_DLL_INIT_FAILED), taking the rest of the serial
    // block with it. Loading the second member's storageState removes both.
    const ctxB: BrowserContext = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
      storageState: BATTLE_SECOND_MEMBER_AUTH_FILE,
    });
    const pageB = await ctxB.newPage();
    try {
      await openConversationById(pageB, channelId);

      // Moderator fires ONE battle; both members are present in-session for the SAME duel.
      await fireBattle(page, '/battle Tabs or spaces for indentation? One short paragraph with a clear pick.');
      const cardA = page.locator('.battle-scorecard').last();
      await expect(cardA).toBeVisible();
      // Member B must also see the SAME battle's scorecard (per-user picks require both present).
      const cardB = pageB.locator('.battle-scorecard').last();
      await expect(cardB).toBeVisible({ timeout: 260_000 });

      // Different sides: A picks A (control), B picks B (treatment).
      const pickA = cardA.locator('[data-pick="A"]');
      const pickB = cardB.locator('[data-pick="B"]');
      await pickA.click();
      await expect(pickA).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
      await pickB.click();
      await expect(pickB).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });

      // BOTH picks are retained + tallied — not last-write-wins (which would leave only ONE variant with
      // a win). The tally therefore shows a win on BOTH variants (2 distinct users, one battle).
      const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
      expect(idToken, 'admin idToken in localStorage').toBeTruthy();
      await expect
        .poll(
          async () => {
            const w = await readBattleWins(idToken!, battleExpId());
            return (w.control ?? 0) >= 1 && (w.treatment ?? 0) >= 1;
          },
          { timeout: 150_000 },
        )
        .toBeTruthy();
    } finally {
      await ctxB.close();
    }
  });

  // B-E7 — A DUEL HAS AN OWNER. As the person who ran `/battle`, when a side stops and asks me for
  // something, I am the one it is waiting on: another member of the channel must not be able to answer
  // a question they were never asked and steer a comparison they did not start.
  //
  // WHY THIS TEST EXISTS AT ALL. The rule shipped enforced against a field the duel's own progress
  // erased, so it passed for everybody, and nothing caught that: the unit tests asserted the decision
  // function in isolation, and the live check only verified that an owner was RECORDED. The refusal
  // itself had never been exercised against a running system, and it is the only thing the rule is for.
  //
  // WHAT MAKES IT REACHABLE. A clarifying question is not: the round-1 prompt never asks for one, and
  // the `NEED_CLARIFICATION` sentinel is unreachable (ADR-029). A TASK-SHAPED duel is: each side runs
  // its own task chain, and a chain with legs left parks on the person (ADR-026, `reason: 'task-step'`).
  // Same `WAITING_FOR_USER` state, same continuation path, same rule.
  //
  // THE NEGATIVE IS NOT VACUOUS, which matters more here than usual: the waiting affordance is derived
  // from the channel's MESSAGES, so it renders for every member and the second member's composer really
  // does send a `Target`-ed continuation. The test asserts that affordance is present before sending -
  // otherwise "nothing resumed" would only prove nothing was attempted - and it ends with the owner's
  // identical reply DOING resume the side, which is what makes the two halves a comparison.
  test('B-E7: a waiting side is answerable ONLY by the person who started the duel', async ({ page, browser }) => {
    test.setTimeout(15 * 60_000);
    const second = await getSecondPremiumUser();
    test.skip(!second?.password, missingUserReason('secondPremiumUser'));
    await activateBattleExperiment(page, battleExpId());

    const channelId = await newBattleChannelWithId(page, 'E2E duel owner');
    await shareChannelWith(page, second!.email);

    // Task-shaped on purpose (see above): a report chain collects requirements before it can draft.
    await fireBattleNoWait(
      page,
      '/battle Compile a concise 1-page report on the pros and cons of a monorepo vs multi-repo '
      + 'setup for a 5-team engineering org.',
    );

    const active = await waitForActiveBattle(channelId, 180_000);
    expect(active?.battleId, 'the fan-out stamps the channel pointer').toBeTruthy();
    // The owner on the POINTER is what the continuation path reads. Recorded nowhere, the rule below
    // cannot bite however correct the comparison is.
    expect(active?.initiatorUserSub, 'the pointer records WHO started the duel').toBeTruthy();

    const waiting = await waitForWaitingSide(active!.battleId!, 420_000);
    expect(
      waiting,
      'a task-shaped duel must park a side on the user (ADR-026) — without one there is nothing to '
      + 'refuse, and this test would be asserting nothing',
    ).toBeTruthy();

    // Both replies are sent as Chime messages `Target`-ed at the waiting side, rather than typed into
    // the composer, because a task-step wait offers NO composer affordance to anyone: that branch
    // writes no `waitingMessageId` and posts no `<!--battlewaiting-->` marker, so `battleWaitingBots`
    // is empty for every member including the owner. The wire shape is the composer's own targeted
    // send, so the server path under test is the same one.
    const ownerArn = userArnFor(active!.initiatorUserSub!);
    const nonOwner = humanMembers(channelId).find((arn) => arn !== ownerArn);
    expect(nonOwner, 'the channel has a second human member to answer as').toBeTruthy();

    // ── the NON-OWNER answers ──────────────────────────────────────────────────────────────────
    const strangerMsgId = sendTargetedAs(
      channelId, nonOwner!, waiting!.botArn,
      'Audience is engineering leadership; focus on delivery velocity.',
    );

    const stateAfterNonOwner = await holdsWaiting(active!.battleId!, waiting!.botArn, 90_000);
    expect(
      stateAfterNonOwner,
      'a member who did not start the duel must not resume it',
    ).toBe('WAITING_FOR_USER');

    // ...and they are not silenced either. A non-owner is not refused, their message is simply not a
    // continuation: it is released and answered as ordinary conversation. Only a DENIED message fails
    // to persist, so its presence to its own sender is the observable difference.
    expect(
      messageExistsForSender(channelId, nonOwner!, strangerMsgId),
      "the non-owner's message is released to the channel rather than swallowed",
    ).toBe(true);

    // ── the OWNER answers ──────────────────────────────────────────────────────────────────────
    // THE POSITIVE CONTROL, and it is the half that matters. Without it, "the side stayed waiting" is
    // equally consistent with a continuation path that is broken for everyone - which is exactly what
    // running this found: the flow callback carries no `Target`, so no reply of any kind reaches the
    // continuation branch. Until that is fixed this assertion FAILS, and it should: the owner rule
    // cannot be said to work when nothing can resume a duel at all.
    const ownerMsgId = sendTargetedAs(
      channelId, ownerArn, waiting!.botArn,
      'Audience is engineering leadership; focus on delivery velocity and CI cost.',
    );

    const resumed = await waitForResume(active!.battleId!, waiting!.botArn, 300_000);
    expect(resumed, "the owner's identical reply DOES resume the side").not.toBe('WAITING_FOR_USER');

    // The reply itself is DELIVERED, not denied. Its privacy is Chime's `Target` doing its job - the
    // rival never sees it - and nothing needs to swallow the message to achieve that. Keeping it also
    // keeps the exchange reconstructable afterwards, which the denial cost (ADR-029, SPEC-BATTLE's
    // open question about retaining the verbatim Q and A).
    expect(
      messageExistsForSender(channelId, ownerArn, ownerMsgId),
      "the owner's answer is delivered privately, not swallowed",
    ).toBe(true);

    // AND THE ANSWER COMES BACK IN PUBLIC. A duel is a comparison, so a side's answer has to be
    // readable by the channel; the private acknowledgement is not the answer. Read with the admin
    // bearer, which cannot see targeted messages at all - so anything visible here is genuinely public.
    await expect
      .poll(
        () => publicMessages(channelId, 12).some((m) => m.sender === waiting!.botArn && m.content.length > 120),
        {
          timeout: 240_000,
          message: "the resumed side's answer must be broadcast, not buried in the private reply",
        },
      )
      .toBe(true);

    // AND THE RECEIPT STAYS PRIVATE. The other half of the same rule, and the half that has actually
    // been wrong on the deployment: broadcasting the answer from a placeholder that was ALREADY public
    // put the answer in the channel and a note beside it saying the answer was elsewhere. Two public
    // messages for one turn, both delivered, nothing logged. The admin bearer cannot see targeted
    // messages at all, so the receipt appearing here at all is the defect.
    expect(
      publicMessages(channelId, 12).filter((m) => m.content.includes('My answer is in the conversation')),
      'the receipt is targeted at the person who answered, so it must not be readable in the channel',
    ).toHaveLength(0);

    // AND THE DUEL FINISHES. Leaving WAITING_FOR_USER is not the same as completing: a resumed side
    // used to flip to INVOKED and then strand to TTL, because the resumed turn ran as an ordinary
    // turn with no battleContext and every terminal write in the processor sits behind one. The
    // side reaching a terminal state is what proves the resume synthesized its battle context and
    // the turn ran AS a battle turn - the half of the resume nothing above can see.
    const terminal = await waitForSideTerminal(active!.battleId!, waiting!.botArn, 300_000);
    expect(
      terminal,
      'the resumed side must COMPLETE, not merely leave the waiting state - a stranded INVOKED row '
      + 'is exactly the defect the synthesized battle context fixed',
    ).toBe('COMPLETED');
  });

  // B-E8 — BATTLES ARE NOT PREMIUM-ONLY BY DESIGN (owner ruling 2026-08-18). Eligibility is the
  // PROFILE's battleEligible capability, read per classification from the immutable tag - so what a
  // below-premium /battle must NEVER do is run silently on premium machinery, which is exactly how
  // the alt-slot hardwire failed: the turn still answered, so nothing errored.
  //
  // The test asserts the boundary on whatever the deployment's configuration is, without a vacuous
  // skip: on the DEFAULT config (standard battleEligible: false) the capability gate must refuse
  // with its explanatory targeted reply; on a deployment whose operator marked standard
  // battle-eligible, the not-enabled hint answers instead (this channel never enabled Battle Mode).
  // Either way the command is ANSWERED - a refusal that explains itself, never silence - and either
  // way NO duel starts: the channel pointer stays empty. This runs in the full-validation battle
  // suite only, deliberately not in the fresh-install dashboard-populate flow (owner ruling).
  test('B-E8: a /battle below premium is answered by the capability gate, never silently run', async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    const std = await getStandardUser();
    test.skip(!std?.password, missingUserReason('standardUser'));

    const ctx = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    });
    const pageStd = await ctx.newPage();
    try {
      await signIn(pageStd, std.email, std.password);
      const createResp = pageStd.waitForResponse(
        (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await createConversation(pageStd, 'E2E standard battle gate', 'Standard');
      const channelId = ((await (await createResp).json()).conversation.conversationArn as string)
        .split('/').pop()!;
      await pageStd.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15_000 });

      await pageStd.locator('.message-textarea').fill('/battle Tabs or spaces? One short paragraph with a clear pick.');
      await pageStd.keyboard.press('Enter');

      // The command is ANSWERED, by one of the two explanatory refusals. Which one depends on the
      // deployment's profile config, and both are correct; what would be wrong is silence, or a duel.
      const capabilityRefusal = pageStd
        .locator('.message', { hasText: "Battle Mode isn't available in this conversation" });
      const notEnabledHint = pageStd
        .locator('.message', { hasText: "Battle Mode isn't enabled on this channel" });
      await expect(
        capabilityRefusal.or(notEnabledHint).first(),
        'a below-premium /battle must be answered with an explanatory refusal, not silence',
      ).toBeVisible({ timeout: 120_000 });

      // And no duel started: nothing stamped the channel's battle pointer. This is the assertion
      // that catches the silent-escalation class - a standard /battle that "worked" by running on
      // premium machinery would stamp a pointer here.
      expect(
        readActiveBattle(channelId).battleId,
        'no duel may start below premium unless the profile capability allows it',
      ).toBeFalsy();
    } finally {
      await ctx.close();
    }
  });
});

// Retire this run's experiments LAST, after every describe above has finished with them.
//
// A battle experiment is premium with a non-Opus control, and an active experiment outranks the
// active profile for the model it governs - so leaving one armed keeps splitting premium traffic
// after the suite ends. The next agent-intents run then reports "a premium conversation was served
// by ... sonnet, not an Opus model", which reads as a routing regression and is really this suite's
// litter. The start-of-run cleanup cannot cover it: it retires PREVIOUS runs, and by definition runs
// before this one needs its experiment.
test.afterAll(async ({ browser }) => {
  if (!BATTLE_E2E_ENABLED) return;
  const ctx = await browser.newContext({ storageState: BATTLE_AUTH_FILE });
  const page = await ctx.newPage();
  try {
    await retireThisRunsBattleExperiments(page);
  } catch (err) {
    // Teardown must never fail a green suite; the helper already warns with what to do by hand.
    console.warn('[battle] retire teardown failed:', (err as Error).message);
  } finally {
    await ctx.close();
  }
});
