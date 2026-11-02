/**
 * Battle Orchestrator Lambda
 *
 * Coordinates round-2 fan-out after both bots reach round-1 terminal state.
 * Invoked asynchronously by the async processor whose terminal-state write
 * was the last one (or by either writer concurrently — the
 * tryClaimOrchestratorFire sentinel makes the actual fan-out exactly-once).
 *
 * Per SPEC-BATTLE.md "Fan-Out — Round 2 (Rebuttals, Bot Opt-In)":
 *   1. Read the BattleStateTable partition for the battleId.
 *   2. Verify all bot rows are in a terminal state. (If not — e.g. one
 *      writer raced ahead — return; the late writer will fire when its
 *      transition lands.)
 *   3. tryClaimOrchestratorFire — exactly-one wins; the rest no-op.
 *   4. For each bot: hand the round to the duel classification's router, which
 *      posts the side's round-2 placeholder and dispatches its processor with
 *      battleContext.round=2 + the rival's round-1 reply.
 *   5. The async processor may emit NO_REBUTTAL to skip its rebuttal; on
 *      receipt the processor deletes its own placeholder.
 *
 * Failure modes:
 *  - Async processor failed in round 1 (state=FAILED on a row): we still
 *    fire round 2. The "rival reply" for that bot is the FAILED row's
 *    correlation log; the surviving bot's round 2 sees no rival content
 *    (the system prompt acknowledges this and asks them to respond
 *    independently).
 *  - Async processor crashes mid-round-1: the row never transitions. Rather
 *    than wait for the silent row TTL (B2 "fail loud"), the orchestrator
 *    gives round 1 a deadline: once a stalled (non-terminal) participant is
 *    past it, it stops deferring, names an explicit "<Name> didn't finish in
 *    time" notice to the router, and either runs a DEGRADED round 2 for the survivor(s) or —
 *    when nobody finished — closes the battle with a message. Either way it
 *    ends by writing a terminal 'battle complete' marker (B4) so consumers get
 *    an explicit done signal instead of inferring it from TTL absence.
 */

import { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  readBattleRows,
  allBotsTerminal,
  tryClaimOrchestratorFire,
  botRowsOnly,
  battleRowTtl,
  clearActiveBattle,
  isPastDeadline,
  COMPLETE_SENTINEL,
  loadChannelBattleConfig,
  type BattleStateRow,
} from './lib/battle-state.js';
import { resolveBattleSides } from './lib/experiment-manager.js';
import { duelChallengerOf } from './lib/alt-assignment.js';
import { battleCorrelationId } from './lib/correlation.js';
import { variantGrantOf } from './lib/assistant-grant.js';
import { primaryAssistantOf } from './lib/conversation-primary.js';
import { resolveRouterArn } from './lib/router-arn.js';
import { sayThroughRouter } from './lib/say-through-router.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import type { InteractionKind } from './lib/interaction-kinds.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

/**
 * THE ORCHESTRATOR SPEAKS AS NO ASSISTANT.
 *
 * Every line a duel puts in the conversation outside a turn is the router's to say: each side's round-2
 * placeholder is posted by the duel classification's router when it takes the round (`aeRebuttal`), a
 * side that did not finish and a duel that closes are notices it names (`sayThroughRouter`), and an ended
 * duel's waiting markers are taken down by the router too (`aeClearMarkers`, asked by `endBattle`). So this
 * role holds no vend, writes no routing record, and sends nothing bearing a bot.
 */
const lambdaClient = new LambdaClient({});
/** Reads a room's tags only, to find its primary (`roomPrimaryReadStatements`). This role sends nothing on it. */
const tagReader = chimeMessagingClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const BATTLE_STATE_TABLE = process.env.BATTLE_STATE_TABLE || '';
// Round-1 fail-loud deadline (B2): if a participant is still non-terminal past
// this many ms, the orchestrator stops waiting and drives a loud degraded
// resolution. Overridable; defaults well under the row TTL.
const ROUND1_DEADLINE_MS = Number(process.env.BATTLE_ROUND1_DEADLINE_MS) || 180_000;

/**
 * ROUND 2 ANSWERS AT THE DUEL'S CLASSIFICATION, through that classification's router (Phase 1c).
 *
 * It was once hardcoded to premium, an escalation: `battleEligible` is a per-profile flag an operator can
 * turn on for any classification, so a standard duel answered round 2 with premium's model, guardrail and
 * `context/` scope. The round now goes to the router of the duel's own classification, which dispatches
 * only its own processor and refuses a round naming another classification, so the rounds of one duel can
 * never answer at two classifications. An unpublished router means the round does not fire: there is no
 * fallback to another classification's router, upward or downward.
 */
/**
 * The classification this duel runs as.
 *
 * ONE function, used for BOTH the router chosen and the payload's `classification`, so the two can never
 * disagree. A round-2 rebuttal whose payload named a different classification from the router that
 * recorded it is refused there, and archiving half a duel under the wrong classification would break the
 * join key the battle rollup slices on.
 *
 * A classification is set or not (ADR-046). An absent value, or one this deployment does not declare,
 * resolves to `undefined` and the round does not fire; it never becomes some other classification.
 */
function classificationKeyFor(classification: string | undefined): string | undefined {
  return profiles.resolveClassification(classification);
}

export interface BattleOrchestratorEvent {
  battleId: string;
  channelArn: string;
  /** Original /battle user message text — fed to round-2 invocations so the
   *  rebuttal LLM call has the original prompt for grounding. */
  userMessage: string;
  /** Sender of the original /battle message — used for targeted replies. */
  senderArn?: string;
  /** Originating message id — referenced (never copied) in round-2 prompts. */
  originatingMessageId: string;
  /**
   * The CHANNEL's classification, carried from the side that fired the round. Round 2 answers at the
   * duel's own classification; absent or undeclared, round 2 does not fire.
   */
  classification?: string;
}

export async function handler(event: BattleOrchestratorEvent): Promise<void> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const { battleId, channelArn, userMessage, originatingMessageId } = event;
  console.log('[BattleOrchestrator] Invoked', { battleId, channelArn });

  // Round 2 answers at the DUEL'S classification, through its router (see classificationKeyFor). Resolved
  // before anything is read or posted, so an unpublished router leaves no placeholder waiting on nothing.
  //
  // EITHER WAY THE DUEL IS ENDED, not left running. Both declines record the terminal state the other
  // degraded paths record (`emitBattleComplete`), which releases the channel's active-battle pointer, so
  // the room is not held by a duel that will never finish. No notice is named: with no declared
  // classification or no wired router there is no router to say one, and the closing line
  // (`battleNoneFinished`) would not be true of either case.
  const duelClassification = classificationKeyFor(event.classification);
  if (!duelClassification) {
    console.error('[BattleOrchestrator][SecurityEvent] the duel names no declared classification; round 2 will not fire and the duel is ended', {
      battleId,
      classification: event.classification ?? '(absent)',
    });
    await emitBattleComplete(battleId, 'closed:no-classification', channelArn);
    return;
  }
  const roundRouterArn = await resolveRouterArn(duelClassification);
  if (!roundRouterArn) {
    console.error('[BattleOrchestrator] no router published for this duel; round 2 will not fire and the duel is ended', {
      classification: duelClassification,
    });
    await emitBattleComplete(battleId, 'closed:no-router', channelArn);
    return;
  }

  // 1. Read the partition.
  const rows = await readBattleRows(battleId);
  const bots = botRowsOnly(rows);
  if (bots.length === 0) {
    console.warn('[BattleOrchestrator] no bot rows for battleId', battleId);
    return;
  }

  // 2. Terminal check with a fail-loud deadline (B2). Normally we proceed only
  //    once every bot row is terminal; a late writer fires us and we run round
  //    2. If not all bots are terminal AND a stalled (non-terminal) bot is past
  //    its round-1 deadline, stop deferring and drive a loud degraded resolution.
  //
  //    REACHABILITY - READ BEFORE RELYING ON THIS. The degraded branch below is
  //    currently UNREACHABLE and does not yet fix the case it describes. The only
  //    caller, `fireOrchestratorIfLast` (async-processor-core.ts), returns early
  //    unless `allBotsTerminal(rows)` is already true, so every invocation arrives
  //    with `terminal === true`. A bot that crashes or times out mid-round-1 never
  //    writes a terminal row, so nothing invokes us again and the battle still ends
  //    by stranding silently until the row TTL sweeps it.
  //
  //    Closing it needs a TIME-based trigger, not another event: the missing signal
  //    is the ABSENCE of a transition, which cannot be event-sourced (TENETS D6,
  //    which blesses a low-frequency reconcile sweep behind an event path for
  //    exactly this shape). That means a scheduled sweep over battles with a
  //    non-terminal row past deadline, firing this handler - new infrastructure the
  //    battle stack does not have today. The logic below is kept because it is the
  //    correct resolution once such a sweep exists; it is documented as inert so it
  //    is not mistaken for working protection.
  const terminal = allBotsTerminal(rows);
  const nonTerminalBots = bots.filter(
    (b) => b.state === 'INVOKED' || b.state === 'WAITING_FOR_USER',
  );
  if (!terminal) {
    const stalledPastDeadline = nonTerminalBots.filter(isPastDeadline);
    if (stalledPastDeadline.length === 0) {
      console.log('[BattleOrchestrator] Not all bots terminal yet (within deadline), deferring', {
        battleId,
        states: bots.map((r) => ({ bot: r.botArn, state: r.state })),
      });
      return;
    }
    console.warn('[BattleOrchestrator] round-1 deadline exceeded with non-terminal bot(s); failing loud', {
      battleId,
      stalled: stalledPastDeadline.map((r) => ({ bot: r.botArn, state: r.state })),
    });
  }

  // 3. Exactly-once claim. Whichever invocation wins drives the resolution
  //    (normal round 2, degraded round 2, or a loud close); the rest no-op.
  const claimed = await tryClaimOrchestratorFire(battleId);
  if (!claimed) {
    console.log('[BattleOrchestrator] Another invocation already claimed the fire', { battleId });
    return;
  }
  console.log('[BattleOrchestrator] Claimed orchestrator fire — proceeding', {
    battleId,
    bots: bots.length,
    terminal,
  });

  // Resolve-once (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "Battle delegates to the
  // normal engine"): resolve each side's experiment variant ONCE here and stamp
  // it into the round-2 battleContext, so the worker runs a normal request for
  // the variant with no second resolution. Also used for the fail-loud display
  // names. The challenger is the duel classification's alt, named by assistant id and found by the bot
  // its assignment record names; the other row is the control side. control = variants[0];
  // treatment = variants[1]. Best-effort: a resolver hiccup leaves fields unset.
  const challenger = await duelChallengerOf(duelClassification).catch((err) => {
    console.warn('[BattleOrchestrator] the challenger\'s record could not be read; names stay unset', err);
    return null;
  });
  const challengerBotArn = challenger && bots.some((r) => r.botArn === challenger.botArn) ? challenger.botArn : '';
  // ONE READ OF THE EXPERIMENT for both sides, by the id the conversation's battle config bound at enable
  // (`resolveBattleSides`); the config read is the cached one, and a failed read leaves the names unset.
  const boundExperimentId = challenger && challengerBotArn
    ? (await loadChannelBattleConfig(channelArn).catch(() => null))?.experimentId
    : undefined;
  const { control: controlVariant, treatment: treatmentVariant } = challenger && challengerBotArn
    ? await resolveBattleSides(challenger.assistant, boundExperimentId ? { experimentId: boundExperimentId } : {})
      .catch((err) => {
        console.warn('[BattleOrchestrator] the duel\'s experiment could not be read; names stay unset', err);
        return { control: null, treatment: null };
      })
    : { control: null, treatment: null };
  const displayNameFor = (botArn: string): string | undefined =>
    (botArn === challengerBotArn ? treatmentVariant : controlVariant)?.displayName;

  // 4. Fail loud (B2): any bot that did NOT finish round 1 — FAILED, or still
  //    non-terminal past the deadline — gets an explicit "<Name> didn't finish
  //    in time" turn so the user is never left staring at a stalled placeholder.
  const completedBots = bots.filter((b) => b.state === 'COMPLETED');
  // ABANDONED IS NOT "DIDN'T FINISH IN TIME", and this filter was written before that state existed.
  //
  // `!== 'COMPLETED'` swept in every non-completed row, which now includes a side somebody deliberately
  // ended. Announcing "<Name> didn't finish in time" for it would blame the assistant for a decision the
  // person made - and it would say so in a duel they had just walked out of. An abandoned duel normally
  // never reaches here at all, because ending it claims the sentinel this handler needs; this covers the
  // narrow case where the claim was already lost and the abandon landed afterwards.
  const notFinishedBots = bots.filter((b) => b.state !== 'COMPLETED' && b.state !== 'ABANDONED');
  for (const b of notFinishedBots) {
    await postDidNotFinish(channelArn, b.botArn, duelClassification, displayNameFor(b.botArn));
  }

  // If nobody finished there is nothing to rebut — close the battle with a
  // message (never a silent TTL) and emit the terminal marker.
  if (completedBots.length === 0) {
    // A LINE ABOUT THE DUEL, SAID FOR THE ROOM, so the room's primary says it (§3.8), not whichever side's
    // row came first. Falls back to the first side only when the room has no resolvable primary, so the
    // duel still closes with a message.
    const closer = await primaryAssistantOf(channelArn, tagReader, '[BattleOrchestrator]')
      .then((p) => p.botArn, () => bots[0].botArn);
    await sayThroughRouter(duelClassification, { kind: 'battleNoneFinished', channelArn, botArn: closer, to: [] });
    await emitBattleComplete(battleId, 'closed:no-completion', channelArn);
    console.log('[BattleOrchestrator] Battle closed — no completed bots', { battleId });
    return;
  }

  const degraded = completedBots.length < bots.length;

  // THE INSTANT ROUND TWO WAS TRIGGERED, declared on every rebuttal of this duel. See
  // `roundTwoTriggeredAtMs`: it is what each rebuttal's end to end and acknowledgment are measured from.
  const roundTwoTriggeredAt = terminal ? roundTwoTriggeredAtMs(bots) : undefined;

  // 5. For each bot that FINISHED round 1, hand the round to the router, which posts the side's round-2
  //    placeholder and dispatches it with the rival's round-1 reply. In a degraded battle only the
  //    survivor(s) run round 2 (the "didn't finish" note above is the visible
  //    degradation signal); the survivor responds independently — its rival
  //    reply is '' and rivalDidNotFinish is set so the rebuttal can say so.
  await Promise.all(
    completedBots.map(async (selfRow) => {
      const rivalRow = bots.find((r) => r.botArn !== selfRow.botArn);
      const rivalReply = rivalRow?.round1Reply || '';
      const rivalReplyMsgId = rivalRow?.round1MessageId;
      const rivalCompleted =
        !!rivalRow && completedBots.some((r) => r.botArn === rivalRow.botArn);
      const isChallenger = selfRow.botArn === challengerBotArn;
      const selfVariant = isChallenger ? treatmentVariant : controlVariant;
      const rivalVariant = isChallenger ? controlVariant : treatmentVariant;

      const correlationId = battleCorrelationId({ botArn: selfRow.botArn, round: 'r2' });

      // ── THE ROUND IS THE CLASSIFICATION ROUTER'S (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1c; step 36) ──
      //
      // The router validates the side against the duel's state, posts the round's placeholder as that side
      // on a speak route of its own (markers from `battlePlaceholderContent`, built from this payload's
      // correlation id and battle context), then records the round and dispatches the processor. This
      // orchestrator speaks as no assistant, so no shared principal holds a speak session or a turn's.
      try {
        // HANDED TO THE ROUTER, which validates the side, posts its placeholder, records the round and
        // dispatches the processor with this payload unchanged (`aeRebuttal` in router-agent-handler.ts).
        // Synchronous, so a refused round is logged here rather than lost.
        const dispatch = await lambdaClient.send(
          new InvokeCommand({
            FunctionName: roundRouterArn,
            InvocationType: InvocationType.RequestResponse,
            Payload: Buffer.from(JSON.stringify({ aeRebuttal: {
              // This side's variant, so the vend narrows the round's session to what the side serves.
              routedVariant: variantGrantOf({ modelKey: selfVariant?.modelKey, imageModelKey: selfVariant?.imageGenModelKey, profile: selfVariant?.variantProfile }),
              channelArn,
              correlationId,
              userMessage,
              // Round 2 is fired by THIS orchestrator, not by a person: without the declaration the
              // rebuttal turn archives trigger_kind NULL and is read as user-caused, mis-charging
              // orchestrator-origin latency to user experience. This is the other producer the
              // 'orchestrator' enum value shipped without.
              // NAMED BY INTERACTION. 'orchestrator' named the dispatcher, which made a rebuttal and
              // a post-processing repair the same value - and they answer opposite questions about
              // whether a person is waiting. A rebuttal answers the RIVAL; nobody is watching for it,
              // so it must stay out of the perceived-latency SLO while still being measured.
              trigger: 'rebuttal' as InteractionKind,
              // THE INSTANT ROUND TWO WAS TRIGGERED is what this turn is measured from: its
              // acknowledgment and its end to end both start there (`roundTwoTriggeredAtMs`). The same
              // value for every side of the duel, because one event triggered the round for all of
              // them. Omitted when it cannot be read, and the metrics are then NULL for the turn.
              ...(roundTwoTriggeredAt !== undefined ? { triggerAtMs: roundTwoTriggeredAt } : {}),
              // The DUEL'S classification, resolved by the same function as the worker ARN above so
              // the attribution can never disagree with the processor that actually answered.
              classification: duelClassification,
              botArn: selfRow.botArn,
              senderArn: event.senderArn,
              // INHERITED FROM ROUND 1, never declared here. A duel's two rounds answer the same user
              // question, so they carry the same intent - but only round 1 runs a classifier, because
              // this dispatch goes straight to the worker. This was a hardcoded 'general', which is
              // the exact shape `channel-flow-processor.ts` records having REMOVED from the flow: "a
              // second implementation of decisions the router already makes, and a second
              // implementation diverges SILENTLY - the turn still answers, so nothing errors". It
              // split every duel across two intent buckets and reported one of them wrongly.
              //
              // OMITTED when round 1 recorded none, rather than falling back. A duel that predates
              // the stored intent archives nothing there, which is honest; a fallback would put a
              // value nobody derived back into the analytics and re-create the defect quietly.
              ...(selfRow.intent && { intent: selfRow.intent }),
              // ── A REBUTTAL OPENS NO WORK, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT ──
              //
              // Round 2 is commentary: the side reacts to what its rival produced. Nobody asked for
              // it and nobody is waiting on it (which is also why it has no TTFF - LATENCY-TARGETS
              // excludes it by construction), so there is nothing for a task to track and no person
              // to carry a multi-step chain for.
              //
              // WHY IT IS WRITTEN DOWN HERE. The workflow selection gates what may be OPENED, and it
              // is applied at the two doors that open work: the ordinary intent path and the round-1
              // duel side (ADR-047). Round 2 needs no gate only because this literal means it can
              // never reach a door - it carries a fixed non-task delivery and calls no `createTask`.
              // Resolving a delivery option here instead, or forwarding round 1's, would make this a
              // THIRD door, ungated, reachable by a duel - and it would still answer, so nothing
              // would error. `a-rebuttal-opens-no-work.test.ts` refuses that change rather than
              // leaving the next reader to notice.
              deliveryOption: 'PLACEHOLDER_UPDATE',
              // EXPERIMENT ATTRIBUTION — the same fields, for the same reason, as the round-1 fan-out
              // (channel-flow-processor). `buildAnalyticsMetadata` stamps `experiment_id`/`variant_id`
              // from these TOP-LEVEL fields, so without them a round-2 rebuttal archives with
              // experiment_id NULL and is invisible to `fetchBattleEffectivenessRows`. Round 1 was
              // fixed and round 2 was not, so half of every duel was missing from the rollup: the
              // resolvers already return both ids, only the payload omitted them.
              ...(selfVariant?.experimentId && { experimentId: selfVariant.experimentId }),
              ...(selfVariant?.variantId && { variantId: selfVariant.variantId }),
              // SPEC-PORTABLE §6: this side's whole profile VERSION for a profileRef variant, so the
              // rebuttal round runs the same assistant round 1 did. Absent for a modelKey variant.
              ...(selfVariant?.variantProfile && { variantProfile: selfVariant.variantProfile }),
              // And its number, so the rebuttal is attributed to the version it is.
              ...(selfVariant?.variantProfile && selfVariant.variantVersion !== undefined && { variantVersion: selfVariant.variantVersion }),
              battleContext: {
                battleId,
                round: 2,
                totalRounds: 2,
                selfBotArn: selfRow.botArn,
                rivalBotArn: rivalRow?.botArn || '',
                rivalReply,
                rivalReplyMsgId,
                originatingMessageId,
                // Fail-loud: tell the worker the rival didn't finish so the
                // rebuttal can acknowledge it rather than pretend there was one.
                ...(!rivalCompleted && { rivalDidNotFinish: true }),
                // NOTHING ABOUT THIS SIDE'S VARIANT RIDES HERE (DESIGN-SEPARATE-ASSISTANTS §3.7): the side
                // serves its pinned version, carried above as `variantProfile`. The rival's name is the one
                // fact about the OTHER side the rebuttal note needs, from its profile (`battleSideNames`).
                ...(rivalVariant?.displayName && { rivalName: rivalVariant.displayName }),
              },
            } })),
          }),
        );
        const answer = dispatch.Payload
          ? JSON.parse(Buffer.from(dispatch.Payload).toString() || '{}') as { dispatched?: boolean; reason?: string; placeholderMessageId?: string }
          : {};
        if (dispatch.FunctionError || !answer.dispatched) {
          console.error('[BattleOrchestrator] the router did not dispatch the rebuttal round', {
            botArn: selfRow.botArn, correlationId, reason: answer.reason, functionError: dispatch.FunctionError,
            placeholderMessageId: answer.placeholderMessageId,
          });
        }
      } catch (err) {
        console.error('[BattleOrchestrator] rebuttal round hand-off failed for', selfRow.botArn, err);
      }
    }),
  );

  // 6. Terminal marker (B4): round 2 is the final round, so once it is
  //    dispatched the battle has no further orchestrated phase. Emit an explicit
  //    'battle complete' signal (a '__complete__' sentinel row) so consumers
  //    (analytics, the tally UI, a future notification) get a done signal
  //    instead of inferring it from the state TTL aging out.
  await emitBattleComplete(battleId, degraded ? 'round2:degraded' : 'round2:full', channelArn);
  console.log('[BattleOrchestrator] Round 2 fan-out complete', { battleId, degraded });
}

/**
 * The instant round two was triggered, epoch ms, or undefined when it cannot be read.
 *
 * WHAT TRIGGERS ROUND TWO. Each side records its round-1 terminal state as it finishes, and the side
 * whose write makes every row terminal is the one that fires this orchestrator
 * (`recordBattleTerminalAndFireOrchestrator`). So the trigger is that last terminal transition: the
 * latest `enteredStateAt` across the duel's rows, which every transition stamps. It is the same
 * instant for every side, because one event started the round for all of them.
 *
 * WHY NOT THE RIVAL'S COMPLETION. For the side that finished first the two coincide. For the side that
 * finished second the rival's completion is earlier than its own, so measuring from it counts that
 * side's own round-1 generation as round-2 time.
 *
 * WHY NOT NOW. The dispatch happens after the async invoke, the read of the duel's rows and the claim,
 * and anchoring there would hide that coordination gap inside a figure that reads as instant.
 *
 * CALLED ONLY WHEN EVERY ROW IS TERMINAL. On the deadline path the round is triggered by a deadline
 * passing rather than by a transition, and no row records that instant, so the caller declares none.
 *
 * ALL ROWS OR NOTHING. If any row has no readable stamp, the latest readable one may be earlier than
 * the real trigger, so the answer is undefined rather than a partial maximum. The metric is then NULL
 * for the turn, which is honest; an earlier instant would report a slower round than ran.
 */
export function roundTwoTriggeredAtMs(rows: ReadonlyArray<Pick<BattleStateRow, 'enteredStateAt'>>): number | undefined {
  if (rows.length === 0) return undefined;
  let latest = -Infinity;
  for (const row of rows) {
    const at = row.enteredStateAt ? Date.parse(row.enteredStateAt) : NaN;
    if (!Number.isFinite(at)) return undefined;
    if (at > latest) latest = at;
  }
  return latest;
}

/**
 * Deadline (ms epoch) for a bot's turn. Reads the `deadlineAt` the state layer wrote.
 *
 * WHICH CLOCK IT IS depends on the state the row is in, and only the writer knows: `battle-state.ts`
 * stamps the MACHINE deadline on a generating side and the far longer USER-WAIT deadline on a side
 * blocked on a person (ADR-026, the two clocks). This function must not second-guess that.
 *
 * The `enteredStateAt + ROUND1_DEADLINE_MS` fallback below is now only for rows written BEFORE
 * `deadlineAt` existed, and it is exactly the arithmetic that made a thinking user indistinguishable
 * from a stalled assistant - while nothing wrote `deadlineAt`, every deadline came from it. Kept so an
 * in-flight duel spanning the deploy still resolves, rather than being treated as never due.
 *
 * Tolerated as an ISO string or an epoch number in seconds or ms, because a value this load-bearing
 * should not fail loud over its own encoding. Final fallback is "not yet due" (never fail loud without
 * cause).
 */
//  and  used to live here as a private copy. They are now imported
// from battle-state, because a second implementation of "is this side past due" had drifted from the
// first: for a present-but-unparseable deadline this copy fell through to `enteredStateAt` and reported
// the row stalled, while the shared rule returned "not yet due". The same row got opposite answers from
// the orchestrator and from the single-active-battle guard.

/**
 * Fail-loud (B2): an explicit "<Name> didn't finish in time" line, said by the stalled or failed side, so
 * the user is never left staring at a silent placeholder. A notice the router says in that side's own words
 * (`battleSideDidNotFinish`, or `battleSideDidNotFinishUnnamed` when the duel carries no display name for
 * it). Best-effort: `sayThroughRouter` never throws, and a refused notice must not abort the resolution.
 */
async function postDidNotFinish(
  channelArn: string,
  botArn: string,
  classification: string,
  displayName?: string,
): Promise<void> {
  await sayThroughRouter(classification, displayName
    ? { kind: 'battleSideDidNotFinish', channelArn, botArn, to: [], vars: { name: displayName } }
    : { kind: 'battleSideDidNotFinishUnnamed', channelArn, botArn, to: [] });
}

/**
 * Terminal marker (B4): write a '__complete__' sentinel row so consumers get an
 * explicit "battle done" signal instead of inferring it from the state TTL.
 * Idempotent (attribute_not_exists) and best-effort. `botRowsOnly()` excludes
 * '__'-prefixed SKs, so this sentinel never affects the "all bots terminal"
 * checks. Fails open when the state table isn't provisioned.
 *
 * The TTL comes from `battleRowTtl`, the same bound every other row uses. It was a local 600s copy,
 * which meant the "battle done" marker could expire while a task-shaped duel was still running - and a
 * marker that is gone is indistinguishable from one that was never written.
 */
async function emitBattleComplete(battleId: string, reason: string, channelArn?: string): Promise<void> {
  // RELEASE THE CHANNEL, and do it here because this is already the place that knows the duel is over.
  //
  // The `__complete__` sentinel below was written so consumers would get a done signal "instead of
  // inferring it from the state TTL aging out" - and then the one consumer that most needed it, the
  // channel's active-battle pointer, went on inferring exactly that. Nothing cleared the pointer, so a
  // finished duel kept its channel locked until `DUEL_MAX_LIFETIME_MS` expired and every reader that
  // consults the pointer kept answering "a battle is running" for hours after the last answer landed.
  //
  // Before the sentinel write, deliberately: the sentinel is conditional on not already existing, so a
  // redelivered invocation would skip straight past a release that had not happened yet.
  if (channelArn) {
    await clearActiveBattle({ channelArn, battleId, reason });
  }
  if (!BATTLE_STATE_TABLE) return;
  const ttl = battleRowTtl();
  try {
    await ddb.send(
      new PutCommand({
        TableName: BATTLE_STATE_TABLE,
        Item: {
          battleId,
          botArn: COMPLETE_SENTINEL,
          state: 'COMPLETED',
          completeReason: reason,
          enteredStateAt: new Date().toISOString(),
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(botArn)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      console.warn('[BattleOrchestrator] emitBattleComplete failed (non-fatal):', err);
    }
  }
}

// Export for the unit tests so they can call orchestrator pieces in isolation.
export type { BattleStateRow };
