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
 *   4. For each bot: send a round-2 placeholder, invoke the premium async
 *      processor with battleContext.round=2 + the rival's round-1 reply.
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
 *    past it, it stops deferring, posts an explicit "<Name> didn't finish in
 *    time" turn, and either runs a DEGRADED round 2 for the survivor(s) or —
 *    when nobody finished — closes the battle with a message. Either way it
 *    ends by writing a terminal 'battle complete' marker (B4) so consumers get
 *    an explicit done signal instead of inferring it from TTL absence.
 */

import {
  ChimeSDKMessagingClient,
  SendChannelMessageCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
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
  type BattleStateRow,
} from './lib/battle-state.js';
import {
  resolveBattleVariantBySlotArn,
  resolveBattleControlVariantByAltSlotArn,
} from './lib/experiment-manager.js';
import { battleCorrelationId } from './lib/correlation.js';

const messagingClient = new ChimeSDKMessagingClient({});
const lambdaClient = new LambdaClient({});
const ssmClient = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const BATTLE_STATE_TABLE = process.env.BATTLE_STATE_TABLE || '';
// Round-1 fail-loud deadline (B2): if a participant is still non-terminal past
// this many ms, the orchestrator stops waiting and drives a loud degraded
// resolution. Overridable; defaults well under the row TTL.
const ROUND1_DEADLINE_MS = Number(process.env.BATTLE_ROUND1_DEADLINE_MS) || 180_000;

// The premium classification processor ARN is resolved at RUNTIME from SSM (the
// AgentEchelonClassification-Premium stack publishes it). Resolving here — not at deploy via
// valueForStringParameter — keeps this orchestrator decoupled from the premium
// classification stack at deploy time (no fresh-deploy ordering cycle). A literal env
// override is honored first for tests / special wiring.
const PROCESSOR_ARN_PARAMS: Record<string, string | undefined> = {
  premium: process.env.PREMIUM_PROCESSOR_ARN_PARAM,
  standard: process.env.STANDARD_PROCESSOR_ARN_PARAM,
  basic: process.env.BASIC_PROCESSOR_ARN_PARAM,
};
const PROCESSOR_ARN_ENVS: Record<string, string | undefined> = {
  premium: process.env.PREMIUM_ASYNC_PROCESSOR_ARN,
  standard: process.env.ASYNC_PROCESSOR_ARN,
  basic: process.env.BASIC_ASYNC_PROCESSOR_ARN,
};
const cachedArns: Record<string, string> = {};

/**
 * The processor for a ROUND-2 rebuttal, resolved from the duel's classification.
 *
 * IT USED TO BE HARDCODED TO PREMIUM, and that was an escalation rather than a simplification.
 * `battleEligible` is a per-profile flag an operator can turn on for any classification (the admin
 * console edits it), so premium-only is a DEFAULT and not a guarantee. Flip it on standard and round
 * 1 answered on the standard processor while round 2 answered on the premium one - the premium model,
 * the premium guardrail and the premium `context/` S3 scope, which are IAM-enforced classification
 * boundaries. That is precisely the cross-classification leak the round-1 routing fix exists to
 * prevent, and half of every duel still had it.
 *
 * Fail-safe rules are IDENTICAL to the channel flow's on purpose: `basic` NEVER falls back up (that
 * is the leak), `premium` may fall back DOWN to standard (a downgrade, safe), anything else is
 * standard. Two routing tables that disagreed would put the two rounds of one duel on two
 * classifications, which is the defect this replaces.
 */
/**
 * The classification this duel runs as.
 *
 * ONE function, used for BOTH the worker ARN and the analytics attribution, so the two can never
 * disagree. They did: `c8552bb` routed the worker from the duel's classification and left the payload's
 * `userType` hardcoded to `'premium'` one line below, so a round-2 rebuttal archived as premium
 * whatever it actually ran as - including on an ordinary premium duel whose SENDER was downgraded,
 * since round 1 archives `min(user, channel)`. Half a duel attributed to the wrong classification is
 * not cosmetic: it is the join key the battle rollup slices on.
 *
 * Absent resolves to standard, which is a downgrade for a premium duel and never an escalation.
 */
function classificationKeyFor(classification: string | undefined): 'premium' | 'standard' | 'basic' {
  return classification === 'premium' || classification === 'basic' ? classification : 'standard';
}

async function getProcessorArnForClassification(classification: string | undefined): Promise<string> {
  const key = classificationKeyFor(classification);
  if (cachedArns[key]) return cachedArns[key];

  const resolve = async (k: string): Promise<string> => {
    const literal = PROCESSOR_ARN_ENVS[k];
    if (literal) return literal;
    const param = PROCESSOR_ARN_PARAMS[k];
    if (!param) return '';
    try {
      const resp = await ssmClient.send(new GetParameterCommand({ Name: param }));
      return resp.Parameter?.Value || '';
    } catch (err) {
      console.error('[BattleOrchestrator] failed to resolve processor ARN from SSM', { classification: k, err });
      return '';
    }
  };

  let arn = await resolve(key);
  // premium may degrade to standard; basic must not degrade UP, so it stays empty and the caller
  // declines to dispatch rather than answering above the channel's clearance.
  if (!arn && key === 'premium') arn = await resolve('standard');
  if (arn) cachedArns[key] = arn;
  return arn;
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
   * duel's own classification; absent (an in-flight invoke from before this field existed) resolves
   * to standard, which is a downgrade for a premium duel and never an escalation for a premium one.
   */
  classification?: string;
}

export async function handler(event: BattleOrchestratorEvent): Promise<void> {
  const { battleId, channelArn, userMessage, originatingMessageId } = event;
  console.log('[BattleOrchestrator] Invoked', { battleId, channelArn });

  // Round 2 answers at the DUEL'S classification, not a hardwired premium one (see the resolver).
  const roundProcessorArn = await getProcessorArnForClassification(event.classification);
  if (!roundProcessorArn) {
    console.error('[BattleOrchestrator] no processor resolved for this duel; round 2 will not fire', {
      classification: event.classification ?? '(absent, treated as standard)',
    });
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
  //    is the ABSENCE of a transition, which cannot be event-sourced (TENETS 7,
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
  // names. The alt-slot bot is whichever row resolves via the slot-keyed
  // resolver; the other row is the default/control side. control = variants[0];
  // treatment = variants[1]. Best-effort: a resolver hiccup leaves fields unset.
  let altSlotArn = '';
  for (const row of bots) {
    if (await resolveBattleVariantBySlotArn(row.botArn)) {
      altSlotArn = row.botArn;
      break;
    }
  }
  const [controlVariant, treatmentVariant] = altSlotArn
    ? await Promise.all([
        resolveBattleControlVariantByAltSlotArn(altSlotArn),
        resolveBattleVariantBySlotArn(altSlotArn),
      ])
    : [null, null];
  const displayNameFor = (botArn: string): string | undefined =>
    (botArn === altSlotArn ? treatmentVariant : controlVariant)?.displayName;

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
    await postDidNotFinish(channelArn, b.botArn, displayNameFor(b.botArn));
  }

  // If nobody finished there is nothing to rebut — close the battle with a
  // message (never a silent TTL) and emit the terminal marker.
  if (completedBots.length === 0) {
    await postBattleMessage(
      channelArn,
      bots[0].botArn,
      "This battle couldn't be completed. No assistant finished in time. Try /battle again.",
    );
    await emitBattleComplete(battleId, 'closed:no-completion', channelArn);
    console.log('[BattleOrchestrator] Battle closed — no completed bots', { battleId });
    return;
  }

  const degraded = completedBots.length < bots.length;

  // 5. For each bot that FINISHED round 1, send a round-2 placeholder + invoke
  //    async with the rival's round-1 reply. In a degraded battle only the
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
      const isAltSlot = selfRow.botArn === altSlotArn;
      const selfVariant = isAltSlot ? treatmentVariant : controlVariant;
      const rivalVariant = isAltSlot ? controlVariant : treatmentVariant;

      const correlationId = battleCorrelationId({ botArn: selfRow.botArn, round: 'r2' });

      try {
        await sendPlaceholder({
          channelArn,
          botArn: selfRow.botArn,
          correlationId,
          battleId,
          rivalArn: rivalRow?.botArn || '',
          rivalReplyMsgId,
        });
      } catch (err) {
        console.warn('[BattleOrchestrator] placeholder send failed for', selfRow.botArn, err);
        return;
      }

      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: roundProcessorArn,
            InvocationType: InvocationType.Event,
            Payload: Buffer.from(JSON.stringify({
              channelArn,
              correlationId,
              userMessage,
              // Round 2 is fired by THIS orchestrator, not by a person: without the declaration the
              // rebuttal turn archives trigger_kind NULL and is read as user-caused, mis-charging
              // orchestrator-origin latency to user experience. This is the other producer the
              // 'orchestrator' enum value shipped without.
              trigger: 'orchestrator',
              // The DUEL'S classification, resolved by the same function as the worker ARN above so
              // the attribution can never disagree with the processor that actually answered.
              userType: classificationKeyFor(event.classification),
              botArn: selfRow.botArn,
              senderArn: event.senderArn,
              intent: 'general',
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
                // Resolve-once: this side's variant + the rival's display name
                // (woven into the rebuttal note). Unset fields fall back to the
                // worker's normal resolution.
                ...(selfVariant?.modelKey && { variantModelKey: selfVariant.modelKey }),
                ...(selfVariant?.systemPromptAddendum && { variantAddendum: selfVariant.systemPromptAddendum }),
                ...(selfVariant?.displayName && { selfDisplayName: selfVariant.displayName }),
                // Phase-2: this side's image model, so the round-2 rebuttal also runs the normal image
                // path for an image battle (each side does its normal thing). Unset for a text battle.
                ...(selfVariant?.imageGenModelKey && { variantImageModelKey: selfVariant.imageGenModelKey }),
                ...(rivalVariant?.displayName && { rivalDisplayName: rivalVariant.displayName }),
              },
            })),
          }),
        );
      } catch (err) {
        console.error('[BattleOrchestrator] async-processor invoke failed for', selfRow.botArn, err);
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
 * Fail-loud (B2): post an explicit "<Name> didn't finish in time" turn
 * attributed to the stalled/failed bot, so the user is never left staring at a
 * silent placeholder. Best-effort — a send failure must not abort the rest of
 * the resolution.
 */
async function postDidNotFinish(
  channelArn: string,
  botArn: string,
  displayName?: string,
): Promise<void> {
  const name = displayName || 'One assistant';
  try {
    await messagingClient.send(
      new SendChannelMessageCommand({
        ChannelArn: channelArn,
        Content: `${name} didn't finish in time.`,
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: botArn,
      }),
    );
  } catch (err) {
    console.warn('[BattleOrchestrator] postDidNotFinish failed for', botArn, err);
  }
}

/** Post a plain battle-level message (e.g. the close notice) as a bot. Best-effort. */
async function postBattleMessage(
  channelArn: string,
  botArn: string,
  content: string,
): Promise<void> {
  try {
    await messagingClient.send(
      new SendChannelMessageCommand({
        ChannelArn: channelArn,
        Content: content,
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: botArn,
      }),
    );
  } catch (err) {
    console.warn('[BattleOrchestrator] postBattleMessage failed for', botArn, err);
  }
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

async function sendPlaceholder(args: {
  channelArn: string;
  botArn: string;
  correlationId: string;
  battleId: string;
  rivalArn: string;
  rivalReplyMsgId?: string;
}): Promise<void> {
  const rivalRef = args.rivalReplyMsgId ? `,rivalReplyMsgId=${args.rivalReplyMsgId}` : '';
  await messagingClient.send(
    new SendChannelMessageCommand({
      ChannelArn: args.channelArn,
      Content: `One moment... <!--corr:${args.correlationId}--><!--battle:battleId=${args.battleId},round=2,total=2,rivalArn=${args.rivalArn}${rivalRef}-->`,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: args.botArn,
    }),
  );
}

// Export for the unit tests so they can call orchestrator pieces in isolation.
export type { BattleStateRow };
