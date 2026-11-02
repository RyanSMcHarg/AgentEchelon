/**
 * `/battle` E2E.
 *
 * Two layers:
 *  1. A CI-safe documentation/inventory anchor (always runs) pinning the
 *     Phase-0 marker-survival finding.
 *  2. Behavioral tests that drive a REAL duel against a live battle-enabled
 *     deploy (the classification's alt, the AgentEchelonBattle orchestrator +
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

import { test, expect, declareWait } from './helpers/fixtures';
import { type Page, type BrowserContext } from '@playwright/test';
import {
  requireBattleE2E,
  BATTLE_E2E_ENABLED,
  ensureBattleExperimentExists,
  activateBattleExperiment,
  altBotArnFor,
  newBattleChannel,
  newBattleChannelWithId,
  fireBattle,
  battleExpId,
  battleImageExpId,
  retireThisRunsBattleExperiments,
} from './helpers/battle-setup';
// No `missingUserReason` here any more: every user this suite needs is provisioned by
// `provision-test-users.mjs`, so a missing one is a broken harness and is asserted, not skipped.
import { getSecondPremiumUser, getStandardUser } from './helpers/test-credentials';
import {
  waitForActiveBattle,
  waitForNoActiveBattle,
  waitForWaitingSide,
  holdsWaiting,
  waitForSideMovedOn,
  messageCreatedAtMs,
  channelArnFor,
  sendTargetedAs,
  personArnForRecordedId,
  humanMembers,
  messageExistsForSender,
  publicMessages,
  readActiveBattle,
  readDuelSides,
  sendAs,
  holdsPointer,
  waitForPointerCleared,
  waitForSideState,
  answerEverySide,
  messageIdSentBy,
} from './helpers/battle-state-backend';
import { channelTasks, readTask, resolveTaskTable, historyOf, pollFor } from './helpers/task-backend';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { ChannelWireRecorder } from './helpers/channel-wire';
// From the config, NOT from e2e/battle.setup.ts: Playwright forbids one test file
// importing another (battle.setup.ts is a test file); the config is the shared home.
import { BATTLE_AUTH_FILE, BATTLE_SECOND_MEMBER_AUTH_FILE } from '../playwright.config';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { personArnFromIdToken } from './helpers/person';
import { assistantNameIn, assistantsIn } from './helpers/third-party-view';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

/**
 * THE PROMPT EVERY DUEL IN THIS FILE FIRES, and it has to be a question this assistant is actually
 * for.
 *
 * It used to be "Tabs or spaces for indentation?", which is nobody's use case here. The premium
 * assistant is Stratum Technologies' leadership assistant - financials, customer accounts,
 * competitive intelligence - so both sides correctly declined it, and the evaluator then scored both
 * refusals `irrelevant`. That verdict is not wrong about the answer: a decline IS irrelevant to the
 * question asked. It was wrong about what was being measured. Every duel this file ran fed the
 * evaluation corpus a pair of refusals, so the quality columns on the Experiments and Effectiveness
 * surfaces were scoring how politely two models say no.
 *
 * WHY THIS QUESTION. Three properties, and dropping any one brings the defect back:
 *
 *  1. IT IS IN THE TAXONOMY. `competitive_intel` in `backend/demo/intent-packs.ts` is exactly "why do
 *     we lose deals to Y", and the brief in `demo/context/premium/competitive-intel.json` records
 *     Zapier at a 38% win rate with three loss reasons. The assistant can answer it from context, so
 *     neither side has to decline and neither has to invent.
 *  2. IT IS SINGLE-TURN. That intent carries `delivery: 'PLACEHOLDER_UPDATE'`, not
 *     `TASK_MULTI_STEP`, so round 2 stays completion-gated on the round-1 pair the way the tests that
 *     fire this constant need.
 *
 *     THIS IS A TEST TIMING CHOICE, NOT A PRODUCT LIMIT, and the earlier wording here said the
 *     opposite ("a task-shaped prompt would change the flow, not just the text"), which is wrong and
 *     was worth correcting because it reads as a reason not to test the task path at all. A
 *     task-shaped duel is fully supported: ADR-026 dispatches it with everything a placeholder-shaped
 *     one gets, and `backend/test/task-shaped-battle-parity.test.ts` is the ratchet that keeps both
 *     dispatch paths at parity. What a task-shaped prompt changes is WHEN round 2 can be observed -
 *     a task chain with legs left parks on the person instead of completing - so it is the right
 *     shape where a test needs a side WAITING (B-E7, B-E9) and the wrong shape where a test needs
 *     round 1 to resolve on its own. See `TASK_BATTLE_PROMPT` below for the other default.
 *  3. IT HAS A JUDGMENT IN IT. A duel compares two models, so a prompt with one right answer is
 *     wasted on it: asked for a single figure, both sides return the same number and every duel is a
 *     draw. The brief lists three loss reasons and this asks which one dominates, which is a real
 *     question with defensible different answers - the thing a duel is for.
 *
 * Kept as ONE constant because it is fired from nine places in this file. It was nine string
 * literals, and that is why a prompt nobody would ask survived in all of them.
 */
const BATTLE_PROMPT = 'Why do we lose deals to Zapier? One short paragraph, and name the single biggest reason.';

/**
 * THE TASK-SHAPED DEFAULT, for the tests that need a side to PARK ON THE USER.
 *
 * B-E7 (only the duel's owner may answer a waiting side) and B-E9 (only the owner may end a duel)
 * both need a duel that is genuinely in flight and blocked on a person. A single-turn duel cannot
 * give them that: it races to completion, and "the side is waiting" becomes indistinguishable from
 * "the side has not answered yet". A task chain with legs left parks on the person by construction
 * (ADR-026, `reason: 'task-step'`), which is the state those tests are about.
 *
 * Same taxonomy rule as `BATTLE_PROMPT`, for the same reason: this is `report_generation` in the
 * premium pack (`backend/demo/intent-packs.ts`), which reaches financials, named accounts and the
 * competitive brief - so both sides can actually build it, and neither has to decline. It is also
 * one of the three headline prompts the demo's own welcome message advertises, so a duel fired here
 * exercises what the deployment tells people to ask for.
 *
 * Deliberately under-specified. A report request that already names its audience, period and
 * sections has nothing left to ask about, and a chain with nothing to ask does not park - which is
 * exactly the condition under which B-E7 and B-E9 assert nothing.
 */
const TASK_BATTLE_PROMPT = 'Compile a one-page report on our Q2 ARR performance for the leadership team.';

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
const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';

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
      // THE PREMIUM ALT, checked against its assignment record. These duels run in a PREMIUM
      // conversation and an alt belongs to one classification. See `challengerFor`.
      await ensureBattleExperimentExists(page, {}); // text; defaults to the premium alt
      // The image experiment (form-based create) is set up ONLY when the image path is opted in — it is
      // the slow/flaky part, and text-only runs never touch it (the generation-out test self-skips too).
      if (RUN_IMAGE_BATTLE) {
        await ensureBattleExperimentExists(page, {
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
    await newBattleChannel(page, 'E2E competitive-intel battle');

    // A single-turn opinion prompt (not a TASK_*) so round-2 is completion-
    // gated on the round-1 pair, which resolves deterministically here.
    const cardsBefore = await scorecardCount(page);
    const count = await fireBattle(
      page,
      `/battle ${BATTLE_PROMPT}`,
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
    const card = await newScorecard(page, cardsBefore);
    await expect(card).toBeVisible();
    const pickB = card.locator('[data-pick="B"]');
    await pickB.click();
    await expect(pickB).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  });

  // USER APPROVAL, END TO END. The duel's owner rates one side's reply up and the other's down through the
  // reply's own thumbs, and each vote reaches the approval_rate of the variant that served that reply, read
  // through the same experiment_results query the Experiments and Battles views read (includeBattle). The
  // vote travels: the reply's Metadata attribution -> handleFeedback -> UserFeedback -> the experiment
  // feedback join (`feedbackColumnsFor`) onto the variant's Aurora row.
  test('user approval: a thumbs vote on each side reaches that variant\'s approval_rate', async ({ page }) => {
    test.setTimeout(9 * 60_000);
    const wire = new ChannelWireRecorder();
    wire.attach(page);
    const experimentId = battleExpId();
    await activateBattleExperiment(page, experimentId);
    await newBattleChannel(page, 'E2E battle user approval');
    const idToken = await idTokenOf(page);
    // What the window already holds for this experiment, so the assertion is on THIS test's two votes.
    const before = await readApproval(idToken, experimentId);

    await fireBattle(page, `/battle ${BATTLE_PROMPT}`);

    // Each side's round-1 reply, by the attribution its own Metadata carries.
    const replyOf = (variant: string): string | undefined => wire.all
      .filter((m) => m.isBot && m.metadata?.experimentId === experimentId && m.metadata?.variantId === variant
        && String(m.metadata?.battleRound ?? '1') === '1')
      .map((m) => m.messageId)
      .pop();
    await expect.poll(() => [replyOf('control'), replyOf('treatment')].every(Boolean), { timeout: 120_000 }).toBe(true);
    const replies = { control: replyOf('control')!, treatment: replyOf('treatment')! };

    // The vote, through the reply's own button, and the request it sends.
    const vote = async (variant: 'control' | 'treatment', feedback: 'up' | 'down') => {
      const messageId = replies[variant];
      const button = page.locator(`[data-message-id="${messageId}"] .message-feedback-btn`).nth(feedback === 'up' ? 0 : 1);
      await expect(button, `the ${variant} reply shows its thumbs`).toBeVisible({ timeout: 30_000 });
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && (r.request().postData() ?? '').includes(messageId), { timeout: 20_000 }),
        button.click(),
      ]);
      expect(resp.ok(), `the ${variant} vote was refused: ${resp.status()}`).toBeTruthy();
      expect(JSON.parse(resp.request().postData() || '{}'), 'the vote carries the variant that served the reply')
        .toMatchObject({ messageId, feedback, experimentId, variantId: variant, assignmentMode: 'battle' });
      await expect(button).toHaveClass(/active/, { timeout: 10_000 });
    };
    await vote('control', 'up');
    await vote('treatment', 'down');

    // Each vote is recorded against its own variant, read from the vote store under the same predicate the rate uses.
    const drill = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'experiment_feedback', experimentId, includeBattle: 'true', ...todayRange(),
    });
    const recorded = ((drill?.data ?? []) as any[]).filter((r) => r.message_id === replies.control || r.message_id === replies.treatment);
    expect(recorded.map((r) => `${r.variant_id}:${r.feedback}:${r.assignment_mode}`).sort())
      .toEqual(['control:up:battle', 'treatment:down:battle']);

    // The variant rows the votes attach to are the duel's exchanges, which reach Aurora through archival. The read is
    // of an archive projection with no event the runner can subscribe to, so it is a declared wait read by `pollFor`.
    declareWait('the duel replies archiving into the experiment rows', Date.now() + 3 * 60_000);
    const after = await pollFor(
      () => readApproval(idToken, experimentId),
      (a) => a.control.up >= before.control.up + 1 && a.treatment.down >= before.treatment.down + 1,
      { timeoutMs: 3 * 60_000, intervalMs: 10_000 },
    );
    expect(after.control.up - before.control.up, 'the control reply\'s thumbs up counts for control').toBe(1);
    expect(after.control.down - before.control.down, 'and nothing else moved on control').toBe(0);
    expect(after.treatment.down - before.treatment.down, 'the treatment reply\'s thumbs down counts for treatment').toBe(1);
    expect(after.treatment.up - before.treatment.up, 'and nothing else moved on treatment').toBe(0);
    // approval_rate is thumbs_up over the votes on each row that carries them.
    for (const r of after.rows) {
      if (!Number(r.feedback_count)) continue;
      expect(Number(r.approval_rate)).toBeCloseTo(Math.round((Number(r.thumbs_up) / Number(r.feedback_count)) * 1000) / 10, 1);
    }
    expect(after.control.rate, 'control\'s approval includes the up vote').toBeGreaterThan(0);
    expect(after.treatment.rate, 'treatment\'s approval includes the down vote').toBeLessThan(100);
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
    const channelId = await newBattleChannelWithId(page, 'E2E round-2 battle');

    // Its own prompt rather than `BATTLE_PROMPT`, so a run's transcript shows this duel apart from
    // the others - but the same two properties the constant documents: `competitive_intel` in the
    // premium pack, so neither side declines, and a judgment call rather than a lookup, so the two
    // sides have something to disagree about. Single-turn, which is what the paragraph below depends on.
    await fireBattle(page, '/battle Zapier or Make - which is the bigger threat to our enterprise pipeline? One paragraph.');
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
    // THIS CONVERSATION'S FRAMES ONLY. The session receives every channel the person is in, and the
    // previous test's duel can still be landing its round 2 while this one runs: on dev 2026-10-28 the
    // prior test's two rebuttals (01149e3f29ba, 202d03ab3b93, in its own conversation) arrived 25 s
    // into this test and were counted here as duplicates of this duel's. Its own conversation held
    // exactly one reply per assistant per round.
    for (const m of wire.botMessagesFor(channelArnFor(channelId))) {
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
    // its own duel (distinct battleId), reusing the same channel + alt
    // member. This guards that a second battle turn works after the first (no
    // stale battle-state / sentinel reuse across turns). Two duels → budget high.
    //
    // NOTE: a plain (non-/battle, non-mention) follow-up in a battle channel does
    // NOT re-engage the bots — that's the multi-user "stay silent without a
    // mention" rule, not a bug. Each new duel needs its own /battle turn.
    test.setTimeout(14 * 60_000);

    await activateBattleExperiment(page, battleExpId());
    const channelId = await newBattleChannelWithId(page, 'E2E multi-turn battle');

    await fireBattle(page, `/battle ${BATTLE_PROMPT}`);
    // Exactly one duel so far → one scorecard.
    await expect(page.locator('.battle-scorecard')).toHaveCount(1, { timeout: 10_000 });

    // A SECOND battle turn produces a fresh duel → a SECOND scorecard. (Can't
    // reuse fireBattle's readiness wait here — duel-1's bubbles + scorecard
    // already satisfy it; the new scorecard is the unambiguous second-duel signal.)
    // A DIFFERENT question from the first duel's, on purpose. This test is about a SECOND duel being
    // fresh rather than stale state replayed, and two duels carrying the same text would make a
    // transcript in which the stale outcome is the hard one to spot. Single-turn (`account_status`),
    // so neither duel parks on the user while the other is being started.
    await page.locator('.message-textarea').fill(
      '/battle Greenfield Energy renews in November with usage down 30%. Renegotiate or hold the price? '
      + 'One short paragraph with a clear pick.',
      { timeout: 30_000 },
    );
    await page.keyboard.press('Enter');

    // ── A DUEL IS NOT OVER AT THE SCORECARD ─────────────────────────────────
    //
    // This expected a second scorecard straight away and timed out on one. The flow was right to
    // refuse: DESIGN-BATTLE sequences a duel as "round 2, the scorecard, the pick", WAITING_FOR_USER
    // is explicitly non-terminal, and a second /battle on top of a live duel is answered
    // "A battle is already running in this conversation. Send /battle end to end it and start this
    // one instead." 2a-i designs that refusal in detail, because a duel any member could restart
    // would leave the assistants taking competing instructions from several people at once.
    //
    // So the duel is ENDED first, the way the product tells its initiator to. That is the multi-turn
    // guarantee this test is actually for - no stale battle-state or sentinel reuse across turns -
    // and it was never the claim that a duel can be interrupted by starting another.
    //
    // ── WHY THE REFUSAL IS NOT ASSERTED, AND MUST NOT BE (2026-09-21) ───────────────────────────
    //
    // It was, and the assertion was unsound. Seeing that refusal requires duel 1 to still be LIVE at
    // the moment the second /battle lands, and nothing here establishes that: a duel that has
    // finished its rounds legitimately stops being live, and `activateBattleExperiment` - called by
    // this very test - COMPLETES other active experiments to free the classification (decision-loop
    // §3.2.1), which can retire the experiment this duel depends on while the test is still running.
    // The harness has a "recorded experiment id was terminal; re-minted once per run" recovery for
    // exactly that, which is how long it has been true.
    //
    // So the test failed or passed on timing - it failed in isolation and passed inside a full run,
    // at DIFFERENT lines - while the product did the right thing either way. B-E3 covers the refusal
    // directly, with a duel it has just started and therefore knows is live; asserting it a second
    // time here bought nothing and cost a flake.
    //
    // The second /battle is still SENT, because sending it is what makes the end-then-restart
    // sequence below realistic. Its outcome is simply not asserted: whether it is refused (duel
    // still live) or accepted (duel already over) is a race this test has no business pinning.
    await sendAndWaitForResponse(page, '/battle end', 120_000);

    // ENDING IS NOT INSTANT, AND THE RESTART USED TO RACE IT. `/battle end` replies as soon as the
    // command is accepted; releasing the channel pointer, abandoning the sides and clearing the
    // waiting markers settle after that. Firing the next `/battle` on the strength of the reply got
    // it refused for a duel that was still live, nothing further rendered, and the failure read as
    // "a second duel never started" - which is what this test is about, so it looked like a real
    // finding rather than a race.
    expect(
      await waitForNoActiveBattle(channelId, 120_000),
      'ending a duel releases the channel pointer, which is what lets the next /battle start',
    ).toBe(true);

    await fireBattle(
      page,
      '/battle Greenfield Energy renews in November with usage down 30%. Renegotiate or hold the price? '
      + 'One short paragraph with a clear pick.',
    );

    // AT LEAST TWO, NOT EXACTLY TWO. The guarantee is that a repeated /battle produces a FRESH duel
    // rather than reusing stale battle state - so more duels than expected is this test's claim
    // holding, not failing. Pinning the exact count re-imports the timing this test just stopped
    // depending on: whether the un-asserted second /battle above opened a duel of its own decides
    // whether the total is two or three, and neither answer says anything about staleness.
    await expect
      .poll(() => page.locator('.battle-scorecard').count(), { timeout: 260_000 })
      .toBeGreaterThanOrEqual(2);

    // AND THEY ARE DIFFERENT DUELS. The count alone would be satisfied by one scorecard rendered
    // twice; distinct battle ids are what says the second /battle started something new, which is
    // the sentinel-reuse defect this test is named for.
    const battleIds = await page.locator('.battle-scorecard').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-battle-id') || el.id || ''));
    expect(new Set(battleIds.filter(Boolean)).size,
      `each /battle should open its own duel; saw ids ${JSON.stringify(battleIds)}`)
      .toBeGreaterThanOrEqual(2);
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

    const cardsBefore = await scorecardCount(page);
    await fireBattle(page, `/battle ${BATTLE_PROMPT}`);

    const card = await newScorecard(page, cardsBefore);
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
    const idTokenForRead = await idTokenOf(page);
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
    await createConversation(page, 'E2E Battle', 'Premium');
    await page.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15_000 });

    // The shared constant, because the prompt never reaches a model here: the not-enabled gate answers
    // the command before any fan-out. It is still a real Stratum question rather than a placeholder,
    // for the reason `BATTLE_PROMPT` records - a `/battle` that IS accepted by a future change to this
    // gate must not start feeding the evaluation corpus a pair of refusals.
    await page.locator('.message-textarea').fill(`/battle ${BATTLE_PROMPT}`);
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
    await createConversation(page, 'E2E Battle', 'Premium');
    await page.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15_000 });

    const before = await page.locator('.message').count();
    // "/battle" mid-sentence must NOT trigger a battle (detection is ^\s*\/battle\b).
    //
    // A REAL QUESTION WRAPPED AROUND THE TOKEN, not a question about the token. The point of this
    // test is that the turn is answered as ORDINARY conversation, so whatever is sent here is a real
    // turn that lands in the evaluation corpus - and "what about /battle mode" is not something this
    // assistant is for, so it was answered with a decline and scored as one. The financial_metric
    // question in front of the token is answerable from context, and the token still sits
    // mid-sentence, which is the only property the detection regex cares about.
    await page.locator('.message-textarea').fill(
      'What is our current net revenue retention, and can I /battle that question to compare two answers?',
    );
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
    const channelId = await newBattleChannelWithId(page, 'E2E image battle', battleImageExpId());

    const count = await fireBattle(page, '/battle Generate an oil painting of a serene mountain lake at sunrise, wide landscape framing, no people. Show me the brief before you draw it.');
    expect(count).toBeGreaterThanOrEqual(2); // two variant bubbles

    // THE SIDE THAT CONFIRMS. A complete brief is drawn in its first turn (ADR-064 decision G), and this one asks to see
    // the brief first, so each side records it, puts it to the person at `confirm` and parks (ADR-026). The person who
    // started the duel confirms each side with a reply targeted at it, and that confirming turn runs the side's
    // `generate` step. The image duel spec covers the complete brief drawn with no confirmation.
    const confirmed = await answerEverySide(channelId, 'Yes, that is exactly it. Go ahead.');
    expect(confirmed, 'both sides park on the person at the confirm step').toHaveLength(2);

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
    // asserts today's behavior AND names its cause, so if a future prompt reinstates clarification the
    // failure points at the prompt rather than at "clarification routing is gone".
    // AMBIGUOUS ON PURPOSE, and Stratum-shaped on purpose. "Which one is better?" named nothing at
    // all, so the only thing either side could say was that it does not answer questions outside
    // Stratum - an ambiguity test whose result was a decline, which proves nothing about ambiguity.
    // This names no accounts either, so it is just as under-specified, but it sits squarely in
    // `account_status` and the churn-risk list gives both sides something to pick from. What is
    // asserted is unchanged: both sides answer, and neither parks on the user.
    const count = await fireBattle(page, '/battle Which account is more at risk?');
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
  await page.locator('form:has(#share-email) button[type="submit"]').click();
  await expect(page.locator('.alert-success')).toBeVisible({ timeout: 30_000 });
  await page.locator('.modal-close-btn').click().catch(() => {});
  await page.locator('.modal-content').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

/** Type + send a /battle prompt with NO readiness wait (for the guard's back-to-back fire). */
/** How many scorecards the page shows now. Read BEFORE firing a duel, to find that duel's own card. */
async function scorecardCount(page: Page): Promise<number> {
  return page.locator('.battle-scorecard').count();
}

/**
 * THE DUEL'S OWN SCORECARD: the first one rendered after `before`, a count taken before the duel was fired.
 *
 * `.battle-scorecard').last()` re-resolved on every assertion and could name an EARLIER duel's card. Seen
 * live 2026-10-08 in B-E4, which fires several duels in one room: the test clicked a card while the last
 * duel's card had not rendered yet, so the pick landed on an earlier duel ("You picked Atlas" on that
 * card), the last duel's card then appeared beneath it unpicked, and `aria-pressed` read the new card and
 * failed. Waiting for the count to pass `before` and taking index `before` names the card this duel
 * produced, because a later card is appended after it, never before.
 */
async function newScorecard(page: Page, before: number, timeout = 260_000) {
  const all = page.locator('.battle-scorecard');
  await expect.poll(() => all.count(), { timeout }).toBeGreaterThan(before);
  return all.nth(before);
}

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

/** The last day as the analytics API's date range: the window every read in one test shares. */
function todayRange(): { dateRange: { start: string; end: string } } {
  const end = new Date();
  const start = new Date(end.getTime() - 86_400_000);
  return { dateRange: { start: start.toISOString(), end: end.toISOString() } };
}

interface VariantApproval { up: number; down: number; rate: number | null }

/**
 * Each variant's thumbs on an experiment's battle replies, summed over its experiment_results rows (one per intent and
 * model), with the approval rate those sums give, and the rows themselves. Read the way the Experiments and Battles
 * views read it: the signed analytics API, `includeBattle`.
 */
async function readApproval(idToken: string, experimentId: string): Promise<{ control: VariantApproval; treatment: VariantApproval; rows: any[] }> {
  const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
    queryType: 'experiment_results', experimentId, includeBattle: 'true', ...todayRange(),
  });
  const rows = ((j?.data ?? []) as any[]).filter((r) => (r.experiment_id ?? r.experimentId) === experimentId);
  const of = (variant: string): VariantApproval => {
    const mine = rows.filter((r) => (r.variant_id ?? r.variantId) === variant);
    const up = mine.reduce((n, r) => n + (Number(r.thumbs_up) || 0), 0);
    const down = mine.reduce((n, r) => n + (Number(r.thumbs_down) || 0), 0);
    return { up, down, rate: up + down ? Math.round((up / (up + down)) * 1000) / 10 : null };
  };
  return { control: of('control'), treatment: of('treatment'), rows };
}

test.describe('/battle — briefing, steering, guard & human pick (§8 B-E1..B-E6)', () => {
  test.beforeEach(() => requireBattleE2E());

  // Create the text battle experiment once (create-if-missing), same as the behavioral suite.
  test.beforeAll(async ({ browser }) => {
    if (!BATTLE_E2E_ENABLED) return;
    const ctx = await browser.newContext({ storageState: BATTLE_AUTH_FILE });
    const page = await ctx.newPage();
    try {
      // The premium alt, for the reason given at the other call site: these duels are premium and an
      // alt serves exactly one classification.
      await ensureBattleExperimentExists(page, {});
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
    // That member is a DIFFERENT identity from the channel's creator and moderator, so the test sees what a
    // non-moderator sees.
    const second = await getSecondPremiumUser();
    // NOT a skip. `battle.setup` fails loudly when this credential is missing, so by the time a test
    // runs it is guaranteed - and a skip here would have reported a claim about two DISTINCT PEOPLE as
    // passed when nothing exercised it.
    expect(second?.password, 'secondPremiumUser must be provisioned - battle.setup guarantees it').toBeTruthy();

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
        // Only fired to force the inline round-1 banner when the enable broadcast did not carry the
        // briefing. Nothing here is asserted about the ANSWER - but a duel still runs, so it is a
        // `competitive_intel` question this assistant can answer rather than one it has to decline.
        await fireBattleNoWait(pageB, '/battle Where are we ahead of Zapier, and where are we behind? One short paragraph.');
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
  // `intent` experiment (general); its chips must match that intent's row in
  // the steering table (code_generation is the design's illustrative example).
  test('B-E2: prompt steering — the briefing chips match the experiment intent', async ({ page }) => {
    test.setTimeout(9 * 60_000);
    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E prompt steering');

    const briefing = page.locator('.battle-briefing');
    if (!(await briefing.isVisible({ timeout: 8_000 }).catch(() => false))) {
      // Same role as in B-E1: this only forces the briefing to render, and the chips - not the answer -
      // are what this test is about. It is still a duel that runs, so it asks a comparison the
      // competitive brief actually covers (Make's recorded weakness is enterprise features).
      await fireBattleNoWait(page, '/battle How do we compare to Make on enterprise security?');
    }
    await expect(briefing).toBeVisible({ timeout: 120_000 });

    // The steering is intent-derived: for general the coaching line is "Ask real questions your
    // users ask." and the chips are concrete Q&A starters. Assert the intent-appropriate coaching
    // copy is present and the chips are real /battle prefills (deployment-overridable defaults).
    const text = (await briefing.innerText()).toLowerCase();
    expect(text, 'coaching line is steered to the general intent row').toMatch(/questions your users ask|real questions|ask real/);
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
    await fireBattleNoWait(page, `/battle ${BATTLE_PROMPT}`);
    await expect
      .poll(async () => page.locator('.message.battle-message').count(), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    // The one that must be REFUSED. It never reaches a model if the guard holds - but it is written
    // as a real question anyway, because the day the guard regresses is the day this prompt runs, and
    // a regression that also poisons the evaluation corpus is two findings instead of one.
    await fireBattleNoWait(page, '/battle Which competitor costs us the most enterprise deals? One short paragraph.');

    // The sender gets an explained no-op hint (mirrors the FR5 explained-no-op shape).
    await expect
      .poll(
        async () =>
          (await page.locator('.assistant-message .message-text, .message .message-text').allInnerTexts())
            .join('\n')
            .toLowerCase(),
        { timeout: 60_000 },
      )
      // The second `/battle` is refused, and the wording now offers a way out rather than "try again"
      // (DESIGN-BATTLE 2a-i). Matched on the CLAIM - a battle is already running - not on the advice
      // that follows it, which differs for the duel's initiator and for anybody else.
      .toMatch(/already .*running|already .*progress/);

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
    expect(ANALYTICS_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E human pick axis');

    // FIVE duels, not one. The recommendation withholds its human axis until every variant clears the
    // exchanges-per-variant floor (`MIN_SAMPLE_PER_VARIANT`), and answers "keep the experiment running"
    // below it - correctly: a verdict from a single duel would be statistical theatre. So the test
    // supplies real repeated traffic instead of expecting a read the product is right to refuse. The
    // deployment under test lowers the floor (`-c minSamplePerVariant=...`) so five is enough; the
    // shipped default stays 30.
    //
    // FIVE DISTINCT QUESTIONS, and distinctness is the load-bearing part: this is the one test that
    // produces repeated traffic, so whatever is fired here is the largest single contribution this
    // suite makes to the evaluation corpus. Five copies of one prompt would measure one question five
    // times. Each is single-turn (`competitive_intel`, `account_status` or `financial_metric`, all
    // `PLACEHOLDER_UPDATE`) so every duel resolves to a scorecard without parking on the user, and
    // each asks for a PICK rather than a figure - two models that look up the same number produce a
    // draw, and a win-rate built out of draws is what the Wilson CI below would be computed from.
    const PROMPTS = [
      `/battle ${BATTLE_PROMPT}`,
      '/battle Coastal Health Systems is evaluating Zapier Enterprise. What is the strongest case for '
      + 'keeping them? One short paragraph.',
      // NOT a question about "our accounts": that reads as a lookup, and a side classified it
      // `data_extraction`, opened a task and parked on the user, so round 2 never fired (measured live
      // 2026-10-13). A pick between two named options needs no data and asks nothing back.
      '/battle Zapier just cut its Enterprise price by 20%. Should we match it or hold our price? One '
      + 'short paragraph with a clear pick.',
      '/battle Our NPS is 62 against a target of 65. What is the single thing to fix first? One short '
      + 'paragraph, pick one.',
      '/battle Do we grow faster by upgrading Professional customers to Enterprise, or by adding licenses '
      + 'in the accounts we already have? One short paragraph with a clear pick.',
    ];
    // EACH DUEL MUST REACH ROUND 2 BEFORE THE NEXT IS FIRED. The conversation holds one battle until its
    // rebuttals are dispatched (`round2:full`), and `fireBattle` returns when round 1's scorecard has
    // numbers - seconds earlier. Fired then, the next four were each refused as "a battle is already in
    // flight" (measured live 2026-10-13), so the room held one duel and the last card never came.
    for (const prompt of PROMPTS.slice(0, PROMPTS.length - 1)) {
      const dividersBefore = await page.locator('.battle-round-divider').count();
      await fireBattle(page, prompt);
      await expect.poll(() => page.locator('.battle-round-divider').count(), { timeout: 260_000 })
        .toBeGreaterThan(dividersBefore);
    }
    // THIS duel's card, not an earlier one: several duels share this room.
    const cardsBefore = await scorecardCount(page);
    await fireBattle(page, PROMPTS[PROMPTS.length - 1]);
    const card = await newScorecard(page, cardsBefore);
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

    const idToken = await idTokenOf(page);
    expect(idToken, 'admin idToken in localStorage').toBeTruthy();

    // ARCHIVAL IS THE LONG POLE FOR BOTH SURFACES, and it is worth being exact about why, because the
    // obvious reading is wrong. The recommendation's human axis reads BattleOutcome DIRECTLY
    // (`scanBattleWins`), so the picks themselves need no archival - but the axis is only EMITTED once
    // the comparison is viable, and viability is measured from Aurora traffic rows. Until both variants'
    // turns have traveled Kinesis -> archival -> Aurora, the recommendation answers "Only one variant
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
    // ── IT WAITS ON THE PROJECTION SETTLING, NOT ON A WALL CLOCK ─────────────────────────────────
    //
    // This polled for a fixed 90 seconds, on the stated reasoning that the Kinesis batching window is
    // five seconds so "if the row is coming it is here in well under a minute". MEASURED, and that is
    // not reliably true: a run that failed here with "only 1 variant(s) have ARCHIVED rows yet" had
    // BOTH variants in `experiment_results` when the table was read afterwards, one row each. The
    // evidence was not missing; it had not landed inside the budget.
    //
    // A longer budget is still the wrong fix, and for the reason the old comment gave: it turns a
    // fast failure into a slow one and settles nothing. So the loop asks a different question. It
    // keeps waiting while the projection is still ADVANCING - the archived-variant count rising is
    // proof that rows are still arriving - and gives up only once that count has been STILL for
    // several consecutive polls, which is the observable form of "this is as complete as it gets".
    //
    // A run where rows are flowing therefore waits exactly as long as it needs to, and a run where
    // nothing is coming fails in about half a minute instead of ninety seconds. The hard cap is a
    // safety net for a projection that never settles, not the thing the test is timing.
    const STILL_POLLS_BEFORE_SETTLED = 6; // ~30s of no movement
    const HARD_CAP_POLLS = 72; // ~6 minutes, only reachable while rows keep arriving
    let archivedVariants = -1;
    let stillFor = 0;
    for (let i = 0; i < HARD_CAP_POLLS && !reco?.human; i++) {
      reco = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
        queryType: 'experiment_recommendation',
        experimentId: battleExpId(),
        dateRange: { start: start.toISOString(), end: end.toISOString() },
      });
      if (reco?.human) break;
      const seen = Array.isArray(reco?.variants) ? reco.variants.length : 0;
      // ADVANCING RESETS THE PATIENCE, so the wait is bounded by the pipeline going quiet rather than
      // by a guess about how fast it should have been.
      stillFor = seen > archivedVariants ? 0 : stillFor + 1;
      archivedVariants = Math.max(archivedVariants, seen);
      if (stillFor >= STILL_POLLS_BEFORE_SETTLED) break;
      await page.waitForTimeout(5000);
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
        ? `only ${vs.length} variant(s) have ARCHIVED rows, and the count stopped rising for `
          + `${STILL_POLLS_BEFORE_SETTLED * 5}s before this gave up - so the projection has SETTLED `
          + 'incomplete rather than merely being behind. A duel that archived one side looks exactly '
          + 'like this, and so does a duel that never ran its second side.'
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
    expect(ANALYTICS_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
    await activateBattleExperiment(page, battleExpId());
    await newBattleChannel(page, 'E2E tally after archival');

    const cardsBefore = await scorecardCount(page);
    await fireBattle(page, `/battle ${BATTLE_PROMPT}`);
    const card = await newScorecard(page, cardsBefore);
    await expect(card).toBeVisible();

    const [outcomeResp] = await Promise.all([
      page.waitForResponse(
        (r) => /\/battle\/outcome\b/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      card.locator('[data-pick="B"]').click(),
    ]);
    expect(outcomeResp.ok(), 'the pick must be recorded before the tally can ever show it').toBeTruthy();

    const idToken = await idTokenOf(page);
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

    // Single-turn (`financial_metric` reasoned over, not looked up), because the terminal state this
    // test waits for is a scorecard or an explicit failure - and a task-shaped duel has a third,
    // legitimate resting place (parked on the user) that is neither, which would make the poll below
    // report a healthy duel as a silent stall.
    await fireBattleNoWait(
      page,
      '/battle Is our 118% net revenue retention better explained by expansion or by low churn? One paragraph.',
    );

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
    expect(ANALYTICS_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
    await activateBattleExperiment(page, battleExpId());
    const channelId = await newBattleChannelWithId(page, 'E2E per-user picks');
    // A DIFFERENT identity from the moderator: picks are keyed by the chooser, so two people's picks are two
    // picks, and each variant can hold a win.
    const second = await getSecondPremiumUser();
    // NOT a skip. `battle.setup` fails loudly when this credential is missing, so by the time a test
    // runs it is guaranteed - and a skip here would have reported a claim about two DISTINCT PEOPLE as
    // passed when nothing exercised it.
    expect(second?.password, 'secondPremiumUser must be provisioned - battle.setup guarantees it').toBeTruthy();
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
      const cardsBeforeA = await scorecardCount(page);
      const cardsBeforeB = await scorecardCount(pageB);
      await fireBattle(page, `/battle ${BATTLE_PROMPT}`);
      const cardA = await newScorecard(page, cardsBeforeA);
      await expect(cardA).toBeVisible();
      // Member B must also see the SAME battle's scorecard (per-user picks require both present).
      const cardB = await newScorecard(pageB, cardsBeforeB);
      await expect(cardB).toBeVisible();

      // Different sides: A picks A (control), B picks B (treatment).
      const pickA = cardA.locator('[data-pick="A"]');
      const pickB = cardB.locator('[data-pick="B"]');
      await pickA.click();
      await expect(pickA).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
      await pickB.click();
      await expect(pickB).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });

      // BOTH picks are retained + tallied — not last-write-wins (which would leave only ONE variant with
      // a win). The tally therefore shows a win on BOTH variants (2 distinct users, one battle).
      const idToken = await idTokenOf(page);
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
  // THE NEGATIVE IS NOT VACUOUS, which matters more here than usual. Both members send the SAME
  // `Target`-ed reply, so the only difference between the two halves is who sent it. The non-owner's
  // reply leaves the side waiting; the owner's identical reply is applied to the awaited task and moves
  // the side on, which is what makes the two halves a comparison rather than two unrelated observations.
  //
  // HOW THE REPLY REACHES THE SIDE. A `Target`-ed message invokes the targeted assistant's Amazon Lex
  // (`TargetedMessages: ALL`, ADR-041 Appendix A), and the handler resumes the side
  // (`resumeDuelSideIfWaiting`) only when the sender is the duel's initiator, read from the channel's
  // battle pointer. Measured on dev 2026-10-28 UTC (battle 8c9ef799c8503d0f): the owner's reply was
  // applied to the awaited task (`deferred_to_model` from `collecting_requirements`) and resumed the
  // side; the non-owner's ran as an ordinary turn and resumed nothing.
  test('B-E7: a waiting side is answerable ONLY by the person who started the duel', async ({ page, browser }) => {
    test.setTimeout(15 * 60_000);
    const second = await getSecondPremiumUser();
    // NOT a skip. `battle.setup` fails loudly when this credential is missing, so by the time a test
    // runs it is guaranteed - and a skip here would have reported a claim about two DISTINCT PEOPLE as
    // passed when nothing exercised it.
    expect(second?.password, 'secondPremiumUser must be provisioned - battle.setup guarantees it').toBeTruthy();
    await activateBattleExperiment(page, battleExpId());

    const channelId = await newBattleChannelWithId(page, 'E2E duel owner');
    await shareChannelWith(page, second!.email);

    // Task-shaped on purpose (see above): a report chain collects requirements before it can draft.
    // `TASK_BATTLE_PROMPT` is the shared definition of that shape, and it is under-specified on
    // purpose - a request that already states its audience, period and sections leaves nothing to ask
    // about, the chain never parks, and the `waitForWaitingSide` assertion below has nothing to find.
    await fireBattleNoWait(page, `/battle ${TASK_BATTLE_PROMPT}`);

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

    // THE OWNER ANSWERS THROUGH THE APP, the non-owner through a raw send. The side's message carries
    // its `<!--battlewaiting-->` marker naming the owner, and the chat app offers "Reply to this side" to
    // that person alone (DESIGN-BATTLE, "A side parked on the person"). A non-owner is offered no reply,
    // so their targeted message is sent as a Chime message with the composer's own wire shape: what is
    // under test there is the server's refusal, which no UI can stand in for.
    const ownerArn = personArnForRecordedId(active!.initiatorUserSub!);
    const nonOwner = humanMembers(channelId).find((arn) => arn !== ownerArn);
    expect(nonOwner, 'the channel has a second human member to answer as').toBeTruthy();

    // ── the NON-OWNER answers ──────────────────────────────────────────────────────────────────
    // THE SAME TEXT THE OWNER SENDS BELOW, so the sender is the only variable. It is a reply the
    // deployment's input guardrail passes today. Whether the guardrail is right to refuse other benign
    // requirement answers is a separate question, tracked on its own; this test is about who may answer.
    const REPLY = 'Audience is the leadership team; focus on ARR growth and plan mix.';
    const strangerMsgId = sendTargetedAs(channelId, nonOwner!, waiting!.botArn, REPLY);

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
    // THE POSITIVE CONTROL, and it is the half that matters: without it, "the side stayed waiting" is
    // equally consistent with a continuation path that is broken for everyone.
    // The side's own control, on the step it parked on. Choosing it puts the composer into a reply to
    // that side, labeled with its name; the send goes out targeted at the side, as the router expects.
    const sideControl = page.locator(`.battle-side-reply[data-side-arn="${waiting!.botArn}"]`);
    await expect(sideControl, "the owner is offered the waiting side's reply control").toBeVisible({ timeout: 60_000 });
    await sideControl.locator('.battle-side-reply-button').click();
    await expect(page.locator('.message-input-sticky-target--battle-side')).toBeVisible();
    await page.locator('.message-textarea').fill(REPLY);
    await page.locator('.send-button').click();
    const ownerMsgId = await messageIdSentBy(channelId, ownerArn, REPLY);
    expect(ownerMsgId, "the owner's reply reached the channel").toBeTruthy();
    // Answered, so the reply mode ends with the send.
    await expect(page.locator('.message-input-sticky-target--battle-side')).toHaveCount(0);
    // Chime's clock, not this machine's: every "after the reply" below compares backend timestamps.
    const ownerSentAtMs = messageCreatedAtMs(channelId, ownerArn, ownerMsgId!);
    expect(ownerSentAtMs, "the owner's reply has a creation time").toBeGreaterThan(0);

    // The reply itself is DELIVERED, not denied. Its privacy is Chime's `Target` doing its job - the
    // rival never sees it - and keeping it keeps the exchange reconstructable afterwards (ADR-029).
    expect(
      messageExistsForSender(channelId, ownerArn, ownerMsgId!),
      "the owner's answer is delivered privately, not swallowed",
    ).toBe(true);

    // THE SIDE MOVES ON, read from the row's own timestamp. A resumed task-shaped side is `INVOKED`
    // only while its turn runs (about three seconds on dev), so a state sample cannot see it; a state
    // entered after the reply can. What the design guarantees after the owner's answer: the side
    // either completes, or asks its next question and waits again. It never stays parked on the
    // question that was just answered.
    const movedOn = await waitForSideMovedOn(active!.battleId!, waiting!.botArn, ownerSentAtMs, 300_000);
    expect(
      movedOn,
      "the owner's reply must move the side on: a state entered after the reply, not the original wait",
    ).toBeTruthy();
    expect(['COMPLETED', 'WAITING_FOR_USER'], `the side settled as ${movedOn?.state}`).toContain(movedOn!.state);

    // THE ANSWER WAS APPLIED TO THE AWAITED TASK. Applying a reply hands the work back to the side's
    // assistant (`applyUserResponseToTask`), which the task's append-only history records as an
    // ownership entry after the reply; a turn that moved the machine records a graph edge instead.
    //
    // The side's task is found in the source-of-truth table, by this conversation and the side's
    // assistant: each side runs its own chain, so `assistantId` picks it out. Not from the reply's
    // Metadata, which sheds `activeTask` under the Chime cap when the reply also carries a document.
    const sideAssistantId = waiting!.botArn.split('/').pop()!;
    const agentTasks = resolveTaskTable('agent-tasks');
    expect(agentTasks, 'the agent-tasks table resolves for this deployment').toBeTruthy();
    const sideTasks = channelTasks(agentTasks!, channelArnFor(channelId))
      .filter((t) => t.assistantId === sideAssistantId);
    expect(sideTasks, "the waiting side runs exactly one task in this conversation").toHaveLength(1);
    const task = readTask(agentTasks!, String(sideTasks[0].taskId), channelArnFor(channelId));
    const afterReply = historyOf(task).filter((e) => Date.parse(e.at || '') >= ownerSentAtMs);
    expect(
      afterReply.some((e) => e.ownerTo === `assistant:${sideAssistantId}` || (e.from && e.to)),
      `the owner's reply is applied to the awaited task; history after the reply: ${JSON.stringify(afterReply)}`,
    ).toBe(true);

    // AND WHAT THE SIDE SAID COMES BACK IN PUBLIC, after the reply. A duel is a comparison, so a side's
    // answer (or its next question) has to be readable by the channel; the private receipt is not it.
    // Read with the admin bearer, which cannot see targeted messages at all, so anything visible here
    // is genuinely public. Newer than the reply, so the side's round-1 post cannot satisfy it.
    await expect
      .poll(
        () => publicMessages(channelId, 12).some((m) => m.sender === waiting!.botArn
          // `final` is an answer and `interim` is the next question; a `placeholder` is neither.
          && m.createdAtMs > ownerSentAtMs && ['final', 'interim'].includes(m.metadata?.respPhase)),
        {
          timeout: 240_000,
          message: "the resumed side's reply must be broadcast, not buried in the private receipt",
        },
      )
      .toBe(true);

    // AND THE RECEIPT STAYS PRIVATE. Broadcasting the answer from a placeholder that was ALREADY public
    // once put the answer in the channel and a note beside it saying the answer was elsewhere. The
    // admin bearer cannot see targeted messages at all, so the receipt appearing here is the defect.
    expect(
      publicMessages(channelId, 12).filter((m) => m.content.includes('My answer is in the conversation')
        || m.content.includes('I have asked you something in the conversation')),
      'the receipt is targeted at the person who answered, so it must not be readable in the channel',
    ).toHaveLength(0);
  });

  // B-E8 — BATTLES ARE NOT PREMIUM-ONLY BY DESIGN (owner ruling 2026-08-18), but they are not
  // ambient either. Whether a duel may run is the CLASSIFICATION's `battleCapable` plus a runtime
  // setting an operator turns on (ADR-049), read per classification from the immutable tag - so what
  // a below-premium /battle must NEVER do is run silently on premium machinery, which is exactly how
  // the hardwired premium alt failed: the turn still answered, so nothing errored.
  //
  // The test asserts the boundary on whatever the deployment's configuration is, without a vacuous
  // skip. On a default run this suite turns battle on for PREMIUM only, so `standard` is capable but
  // switched off and the gate must refuse with its explanatory targeted reply; on a deployment where
  // an operator has also turned standard on, the not-enabled hint answers instead (this channel never
  // enabled Battle Mode).
  // Either way the command is ANSWERED - a refusal that explains itself, never silence - and either
  // way NO duel starts: the channel pointer stays empty. This runs in the full-validation battle
  // suite only, deliberately not in the fresh-install dashboard-populate flow (owner ruling).
  test('B-E8: a /battle below premium is answered by the capability gate, never silently run', async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    const std = await getStandardUser();
    // NOT a skip, for the same reason as the second premium member above: `standardUser` is provisioned
    // by `provision-test-users.mjs`, so its absence is a broken harness. Skipping would report the
    // capability gate - the control that stops a below-premium `/battle` running at all - as passed
    // while nothing tested it.
    expect(std?.password, 'standardUser must be provisioned - see provision-test-users.mjs').toBeTruthy();

    const ctx = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
      // EXPLICITLY EMPTY, not omitted. `browser.newContext()` inside @playwright/test inherits the
      // project's `use` options, and this project's storageState is the pre-authed ADMIN state for
      // BOTH origins - so an "empty" context loaded the chat app already signed in, no login form
      // ever rendered, and the standard sign-in below timed out (measured live).
      storageState: { cookies: [], origins: [] },
    });
    const pageStd = await ctx.newPage();
    try {
      // Warm the SPA before the sign-in helper's fixed 10s login-form wait: this is the suite's only
      // fresh-context load, so it pays the full CloudFront + bundle cold cost that every other test
      // amortizes through the pre-authed storage state - and after an invalidation that cold load
      // alone can exceed the helper's window.
      await pageStd.goto('/', { timeout: 60_000 });
      await pageStd.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
      await signIn(pageStd, std.email, std.password);
      const createResp = pageStd.waitForResponse(
        (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await createConversation(pageStd, 'E2E standard battle gate', 'Standard');
      const channelId = ((await (await createResp).json()).conversation.conversationArn as string)
        .split('/').pop()!;
      await pageStd.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15_000 });

      await pageStd.locator('.message-textarea').fill(`/battle ${BATTLE_PROMPT}`);
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

  // B-E9 - As the person who STARTED a duel, I want to end it and get my conversation back, and as
  // anyone else I must not be able to end someone else's (DESIGN-BATTLE 2a-i).
  //
  // The claim has three parts and each is asserted on BACKEND STATE rather than on what the assistant
  // said. Wording is the least stable thing in the product and this suite has already been burned by
  // matching on it: a phrase list is what made a settled turn look unsettled, and the copy here differs
  // by speaker on purpose. The durable facts are the pointer and the per-side rows.
  //
  //   1. a non-initiator cannot end it        -> the pointer still names the duel, held over a window
  //   2. the initiator can                    -> the pointer is released and the waiting side is ABANDONED
  //   3. the channel is genuinely free again  -> the NEXT /battle starts a duel with a different id
  //
  // Part 3 is the one worth having. Before this change nothing ever cleared the pointer, so a channel
  // stayed locked to a finished-or-abandoned duel until a four-hour clock expired; "the rows say
  // abandoned" would be satisfied by a fix that still left the channel unusable.
  test('B-E9: only the person who started a duel can end it, and ending it frees the conversation', async ({ page }) => {
    test.setTimeout(15 * 60_000);
    const second = await getSecondPremiumUser();
    expect(second?.password, 'secondPremiumUser must be provisioned - battle.setup guarantees it').toBeTruthy();
    await activateBattleExperiment(page, battleExpId());

    const channelId = await newBattleChannelWithId(page, 'E2E battle end');
    await shareChannelWith(page, second!.email);

    // Task-shaped, so a side parks on the user and the duel stays genuinely IN FLIGHT for the whole
    // test. A plain duel would race to completion and then "the pointer cleared" could not be told
    // apart from an ordinary finish.
    await fireBattleNoWait(page, `/battle ${TASK_BATTLE_PROMPT}`);

    const active = await waitForActiveBattle(channelId, 180_000);
    expect(active?.battleId, 'the fan-out stamps the channel pointer').toBeTruthy();
    expect(active?.initiatorUserSub, 'a battle has an initiator, recorded on the pointer').toBeTruthy();

    const waiting = await waitForWaitingSide(active!.battleId!, 420_000);
    expect(
      waiting,
      'a task-shaped duel must park a side on the user (ADR-026) - with nothing in flight there is no '
      + 'duel to end, and this test would be asserting nothing',
    ).toBeTruthy();

    const ownerArn = personArnForRecordedId(active!.initiatorUserSub!);
    const nonOwner = humanMembers(channelId).find((arn) => arn !== ownerArn);
    expect(nonOwner, 'the channel has a second human member to try this as').toBeTruthy();

    // ── 1. the NON-OWNER tries to end it ───────────────────────────────────────────────────────
    sendAs(channelId, nonOwner!, '/battle end');
    expect(
      await holdsPointer(channelId, active!.battleId!, 60_000),
      "a member who did not start the duel must not be able to end it - the channel's duel is not "
      + 'theirs to take away',
    ).toBe(active!.battleId!);
    expect(
      readDuelSides(active!.battleId!).some((r) => r.state === 'WAITING_FOR_USER' || r.state === 'INVOKED'),
      'and the duel is still running: a refused end must leave every side exactly where it was',
    ).toBe(true);

    // ── 2. the OWNER ends it ───────────────────────────────────────────────────────────────────
    sendAs(channelId, ownerArn, '/battle end');
    expect(
      await waitForPointerCleared(channelId, 120_000),
      'the initiator ends their own duel, and the release is what frees the channel',
    ).toBe(true);
    expect(
      await waitForSideState(active!.battleId!, waiting!.botArn, 'ABANDONED', 120_000),
      'the side that was waiting is recorded ABANDONED - an END, not a completion, so nothing '
      + 'downstream can read it as a finished comparison',
    ).toBe('ABANDONED');

    // ── 3. the conversation is usable again ────────────────────────────────────────────────────
    //
    // TASK-SHAPED AGAIN, and not for symmetry. The pointer is now released the moment a duel resolves,
    // so a short duel sets and clears it within about a minute - and a poll that happens to look either
    // side of that window would report "no new battle started" for a duel that ran perfectly. A duel
    // that parks on the user holds its pointer until somebody ends it, which makes the observation
    // stable instead of a race this test would lose intermittently.
    //
    // A DIFFERENT task from the ended one, and `data_extraction` rather than `report_generation`, so
    // the transcript cannot be read as the ended duel still answering. It parks for the same reason:
    // which columns, and which definition of "flagged", are requirements this request does not carry.
    await fireBattleNoWait(
      page,
      '/battle Extract the enterprise accounts flagged as churn risk as a table.',
    );
    const next = await waitForActiveBattle(channelId, 180_000);
    expect(next?.battleId, 'a new /battle starts after the old duel was ended').toBeTruthy();
    expect(
      next!.battleId,
      'and it is a genuinely NEW duel, not the ended one still holding the channel',
    ).not.toBe(active!.battleId);
  });

  // B-E10 — ADDRESSING THE ALT REACHES THE ALT, NOT THE PRIMARY.
  //
  // A battle-enabled room is the only place two assistants of one classification are both members,
  // so it is the only place this can be exercised. Observed live 2026-09-21: `@Alt-premium-primary
  // answer here` was answered by Advisor, the primary. The mention resolved correctly and the ARN
  // stopped at the flow - `handOffTurnToRouter` invoked the classification's router, which resolved
  // its OWN identity. The flow's own comment recorded the limit ("it does not yet choose which
  // assistant runs the turn") and the seam to close it already existed: `TurnRequest.botArn` is
  // forwarded to the router and validated there against its assignment records.
  //
  // ASSERTED ON THE WIRE, not the pixels. Two assistants post into this room, so "an answer appeared"
  // proves nothing about WHO answered - which is the entire claim. The frame carries the sender ARN.
  test('B-E10: addressing the alt is answered BY the alt, not by the primary', async ({ page }) => {
    test.setTimeout(9 * 60_000);
    const wire = new ChannelWireRecorder();
    wire.attach(page);

    await activateBattleExperiment(page, battleExpId());
    const channelId = await newBattleChannelWithId(page, 'E2E mention the alt');

    // The alt that serves this room, read from its assignment record - never a hardcoded name, for
    // the same reason `challengerFor` exists.
    const altArn = await altBotArnFor('premium');
    expect(altArn, 'the premium alt must have an assignment record for this test to mean anything').toBeTruthy();

    // ITS NAME, FROM THE LIVE ROSTER, AND CHECKED AGAINST THE PROFILE RULE. A side is
    // named by its profile, never an alias: the challenger's pinned version is a copy of the live one
    // with no name of its own, so it carries the live assistant's name marked as the challenger
    // (`battleSideNames`, `battleAltName`). Both names change at runtime with their versions, so they
    // are read from the room's membership, which is what the composer resolves a mention against.
    const channelArn = `${altArn.split('/bot/')[0]}/channel/${channelId}`;
    const me = await personArnFromIdToken(await idTokenOf(page));
    let altName = '';
    await expect.poll(() => (altName = assistantNameIn(channelArn, me, altArn)), {
      message: 'the alt joins the room when Battle Mode turns on', timeout: 30_000,
    }).toBeTruthy();
    const liveName = assistantsIn(channelArn, me).find((a) => a.arn !== altArn)?.name || '';
    expect(liveName, 'the room has its live assistant beside the challenger').toBeTruthy();
    expect(altName, 'the room tells the challenger from the live assistant').not.toBe(liveName);
    expect(altName, "the challenger carries the live assistant's profile name, marked as the challenger")
      .toBe(`${liveName} (alt)`);

    // THE CLIENT'S LIVE ROSTER AGREES. The members panel is the app's own copy, refreshed on the
    // membership event the alt's join sent; a mention resolves against it, so it must show the name.
    await page.getByRole('button', { name: 'Show channel members' }).click();
    await expect(page.locator('.channel-members-panel-name', { hasText: altName }),
      "the members panel shows the challenger by its profile's name").toBeVisible({ timeout: 15_000 });
    // The panel's own close button: while it is open the header toggle carries the same label.
    await page.locator('.channel-members-panel-close').click();

    // A one-line `financial_metric` question, not a general-knowledge one. What is asserted is WHICH
    // assistant answered, so the content is free - but this is an ordinary (non-`/battle`) turn that
    // is archived and evaluated like any other, and a question outside the premium taxonomy is
    // answered with a decline that the evaluator then scores as irrelevant. Typed by name, the way a
    // person would: `@Advisor (alt)` also contains `@Advisor`, and the longer name must win.
    await sendAndWaitForResponse(page, `@${altName} In one sentence, what is our current net revenue retention?`, 240_000);

    // MATCHED ON THE ID SUFFIX, because `newBattleChannelWithId` returns the channel ID and the wire
    // records the full ARN. Passing the id to `botMessagesFor` matched nothing and the test failed
    // with "the addressed assistant must answer" against a room where it had answered - a harness
    // fault that reads exactly like the product defect this case is for.
    const botFrames = wire.all.filter(
      (m) => m.isBot && m.channelArn.endsWith(`/${channelId}`) && (m.content || '').trim().length > 0,
    );
    expect(botFrames.length, 'the addressed assistant must answer').toBeGreaterThan(0);

    // THE CLAIM. An answer from the primary here is the reported defect, and it looks identical to a
    // correct one in the transcript.
    const answeredByAlt = botFrames.some((m) => m.senderArn === altArn);
    expect(
      answeredByAlt,
      `addressing ${altName} must be answered by that assistant. Senders seen: `
      + `${[...new Set(botFrames.map((m) => m.senderArn))].join(', ')}`,
    ).toBe(true);
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
