/**
 * Battle State & Config Helpers (SPEC-BATTLE.md)
 *
 * Two backing tables (provisioned in battle-stack.ts):
 *
 *   - `ChannelBattleConfig` — PK channelArn. Records whether a channel
 *     has /battle enabled and which experiment+slot is bound. Read by
 *     drift detection (suppression) and channel-flow-processor (gating).
 *
 *   - `BattleState` — PK battleId, SK botArn. Per-bot state-machine row
 *     for in-flight battles. State transitions are conditional writes;
 *     the orchestrator uses a sentinel SK '__orchestrator__' to fire
 *     round-2 exactly once.
 *
 * Read paths fail OPEN: if env vars are unset (battle feature not yet
 * enabled in this deployment) or DDB rejects the read, consumers get
 * "behave as if no battle is active" — drift suggestions may fire but
 * battles never start, which is the safe default.
 */

import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const CHANNEL_BATTLE_CONFIG_TABLE = process.env.CHANNEL_BATTLE_CONFIG_TABLE || '';
const BATTLE_STATE_TABLE = process.env.BATTLE_STATE_TABLE || '';
const CACHE_TTL_MS = 60_000;

/**
 * SENTINEL SORT KEYS - rows in a duel's partition that are not sides.
 *
 * Named here rather than written as literals at each use, because two of them are now read by code in
 * other files to answer "did this duel end, and how". A literal that appears in four places is a
 * rename waiting to break one of them silently: `botRowsOnly` would keep filtering it, and the reader
 * asking about it would simply never find it.
 */
export const COMPLETE_SENTINEL = '__complete__';
export const ABANDONED_SENTINEL = '__abandoned__';

// ---------------------------------------------------------------------------
// TWO CLOCKS (ADR-026)
// ---------------------------------------------------------------------------
//
// A side that is GENERATING and goes quiet has stalled. A side WAITING ON A HUMAN has not. Those are
// different measurements and they get different bounds; one deadline stamped at state entry cannot tell
// them apart, and resolved the ambiguity the wrong way on every clarification.
//
// What it cost: `markBotWaitingForUser` stamped `enteredStateAt = now`, and the orchestrator's
// `rowDeadlineMs` falls back to `enteredStateAt + BATTLE_ROUND1_DEADLINE_MS` (180s). So a user who took
// more than three minutes to answer a clarifying question was reported as an assistant that failed to
// finish, and the row itself was deleted by TTL ten minutes in. A task-shaped duel, which needs several
// exchanges with the user, could not complete at all.
//
// `rowDeadlineMs` already PREFERS an explicit `deadlineAt` and only falls back to that arithmetic. That
// field was never written by anything, so the preferred branch was dead code and every deadline came
// from the fallback. Writing it is the fix: the state layer owns which clock a transition starts, and
// the orchestrator reads the answer rather than recomputing it.
//
// Both bounds are configuration, not constants, for the reason ADR-023 gives for refusing a bare `X`:
// the arithmetic is per-deployment, and an implementer who has to edit a constant will pick one number
// and be wrong on some profiles.

/** A side that is generating. Matches the orchestrator's own env read so the two cannot disagree. */
const MACHINE_DEADLINE_MS = Number(process.env.BATTLE_ROUND1_DEADLINE_MS) || 180_000;

/**
 * A side blocked on a human. Generous by comparison and still BOUNDED: a duel the user walked away from
 * is closed rather than left open forever, but the bound is a person's answering time, not a Lambda's.
 */
const USER_WAIT_MS = Number(process.env.BATTLE_USER_WAIT_MS) || 3_600_000; // 1 hour

/** When a generating side is due. */
function machineDeadline(nowMs: number): number {
  return nowMs + MACHINE_DEADLINE_MS;
}

/** When a side waiting on the user is due. */
function userWaitDeadline(nowMs: number): number {
  return nowMs + USER_WAIT_MS;
}

/**
 * How long a whole duel may legitimately remain in flight.
 *
 * A single-turn duel is over in seconds; a task-shaped one runs as long as the work with the user takes,
 * across an unbounded number of legs that are each individually bounded. Anything that treats "a duel is
 * short" as an invariant needs this bound instead of the per-leg one - notably the single-active-battle
 * pointer, which released after ten minutes and would let a SECOND `/battle` start while the first was
 * still collecting requirements.
 *
 * Deliberately generous: the pointer is documented as a cheap pre-filter whose correctness rides on the
 * caller re-validating against live rows, so an over-long value is safe and an over-short one is the bug.
 */
const DUEL_MAX_LIFETIME_MS = Number(process.env.BATTLE_MAX_LIFETIME_MS) || 14_400_000; // 4 hours

/**
 * ROW TTL: a row outlives the DUEL, not the leg that wrote it.
 *
 * The requirement used to be stated per leg (a row must outlive its own deadline) and that is too
 * weak once the two clocks exist. Every row is read as a SET, not on its own: the orchestrator asks
 * whether all sides are terminal and pairs each side with its rival. A row deleted while a SIBLING is
 * still legitimately in flight does not lose one leg's evidence, it changes the answer to a question
 * about the whole duel. Side A finishes round 1 in seconds; side B blocks on the user for 45 minutes,
 * which the human clock permits. On a per-leg TTL A's row is already gone when B answers, so
 * `allBotsTerminal` sees only B and calls the duel done, A never gets round 2, and B is told its rival
 * did not finish - which is false.
 *
 * So every writer stamps the same bound, anchored at the instant of the write. Two properties follow,
 * and both are load-bearing:
 *
 *   - A row outlives ANY deadline it can carry, because the bound covers the longest clock a leg can
 *     start rather than the one this particular write started.
 *   - The value only moves forward with the clock, so no later transition can SHORTEN a row's TTL.
 *     That is what the terminal transition needed: it used to cut a waiting side's hours-long TTL down
 *     to ten minutes on the way past.
 */
const TTL_GRACE_SECONDS = 300;
const ROW_LIFETIME_MS = Math.max(DUEL_MAX_LIFETIME_MS, USER_WAIT_MS, MACHINE_DEADLINE_MS);

/**
 * The TTL (epoch SECONDS) for any `BattleState` row written at `nowMs`.
 *
 * Exported so the orchestrator's own sentinel writer takes the bound from here instead of keeping a
 * second copy of the number, which is how the two got to disagree in the first place.
 */
export function battleRowTtl(nowMs: number = Date.now()): number {
  return Math.floor((nowMs + ROW_LIFETIME_MS) / 1000) + TTL_GRACE_SECONDS;
}

// removeUndefinedValues: transitionBotState writes optional round1Reply /
// round1MessageId / correlationId straight into the Item — all undefined
// on the FAILED path (a bot that errored before replying). Without this
// the marshaller throws and the conditional transition is lost.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// ---------------------------------------------------------------------------
// battleId derivation (single source of truth — per spec)
// ---------------------------------------------------------------------------

/**
 * Stable 16-hex-char ID for a single /battle invocation. The user's
 * `/battle` message id + channel ARN are the inputs; retries land on the
 * same battleId so state-machine writes are idempotent.
 */
export function deriveBattleId(channelArn: string, userMessageId: string): string {
  return createHash('sha256')
    .update(`${channelArn}:${userMessageId}`)
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// ChannelBattleConfig — is /battle enabled on this channel?
// ---------------------------------------------------------------------------

export interface ChannelBattleConfig {
  channelArn: string;
  enabled: boolean;
  experimentId?: string;
  altBotSlotArn?: string;
  enabledBy?: string;
  enabledAt?: string;
  /**
   * Pointer to the channel's in-flight battle (SPEC-BATTLE.md "max 1
   * active battle per channel"). Stamped at fan-out so a later
   * continuation reply — a NEW message whose id can't re-derive the
   * original `battleId` — can resolve its battle from this row, which
   * is already read & 60s-cached on every message via
   * `loadChannelBattleConfig`. Authoritative validation still happens
   * against live `BattleState` rows (a stale pointer simply yields no
   * waiting bots → safe fall-through), so `activeBattleStartedAt` is
   * only a cheap staleness guard.
   */
  activeBattleId?: string;
  activeBattleStartedAt?: string;
  /**
   * WHO OWNS THE IN-FLIGHT DUEL — the person who ran `/battle`, and the only one whose reply resumes a
   * waiting side. It lives HERE, on the pointer, because this row has a single writer (`setActiveBattle`
   * at fan-out) and is not rewritten by the duel's own progress. The per-bot rows are: they are
   * transitioned by several writers across two Lambdas, and the terminal transition used to rewrite the
   * whole item, so an owner recorded there was erased by the side's own completion.
   */
  activeBattleInitiator?: string;
}

interface ConfigCacheEntry {
  config: ChannelBattleConfig | null;
  expires: number;
}

const configCache = new Map<string, ConfigCacheEntry>();

export async function isBattleEnabled(channelArn: string): Promise<boolean> {
  const cfg = await loadChannelBattleConfig(channelArn);
  return cfg?.enabled === true;
}

/**
 * Can this channel still run a duel? Pure, so the rule is testable without the processor.
 *
 * `ChannelBattleConfig` is a SNAPSHOT written at enable time (slot arn, experiment id, briefing), and
 * nothing re-checked the experiment afterwards. A channel enabled while an experiment was active
 * therefore kept fanning out duels forever after that experiment ended, recording human picks against
 * a completed experiment where they can never reach a recommendation - while enabling a NEW channel
 * correctly refused, because enable auto-resolves the single ACTIVE battle experiment. The two paths
 * disagreed about whether battle was available.
 *
 * Ending an experiment is how an operator stops a comparison; it has to stop the duels too.
 *
 * A config with NO bound experiment id is treated as runnable: that shape predates the binding and
 * has no experiment to have ended. Enable has written the id since, so this only covers legacy rows.
 */
export function battleIsRunnable(
  config: ChannelBattleConfig | null,
  experiments: Array<{ experimentId: string; status?: string }>,
): boolean {
  if (config?.enabled !== true) return false;
  if (!config.experimentId) return true;
  return experiments.some((e) => e.experimentId === config.experimentId && e.status === 'active');
}

export async function loadChannelBattleConfig(channelArn: string): Promise<ChannelBattleConfig | null> {
  if (!CHANNEL_BATTLE_CONFIG_TABLE || !channelArn) return null;

  const cached = configCache.get(channelArn);
  if (cached && cached.expires > Date.now()) return cached.config;

  try {
    const result = await ddb.send(
      new GetCommand({ TableName: CHANNEL_BATTLE_CONFIG_TABLE, Key: { channelArn } }),
    );
    const config = (result.Item as ChannelBattleConfig | undefined) ?? null;
    // Cache asymmetrically: positive entries (battle enabled) live the
    // full TTL since toggle-off is rare; NEGATIVE entries (channel never
    // enabled / not yet enabled) get a much shorter TTL so a user who
    // just flipped the toggle ON via a different Lambda's write doesn't
    // hit a stale "not enabled" cached for 60s. Without this, the
    // ChannelFlowProcessor reader and the toggle writer (different
    // Lambdas) couldn't reconcile in-memory state until cache expiry.
    const ttl = config ? CACHE_TTL_MS : 2_000;
    configCache.set(channelArn, { config, expires: Date.now() + ttl });
    return config;
  } catch (err) {
    console.warn('[battle-state] loadChannelBattleConfig failed (failing open):', err);
    // Don't cache failures either - same staleness rationale.
    configCache.set(channelArn, { config: null, expires: Date.now() + 2_000 });
    return null;
  }
}

/** Test/admin-API helper: bust the cache for a channel after toggling. */
export function invalidateChannelBattleConfigCache(channelArn: string): void {
  configCache.delete(channelArn);
}

/**
 * Stamp the channel's in-flight battle pointer at fan-out time. The
 * config row already exists (a battle can only fan out when
 * `isBattleEnabled` is true), so this is a conditional SET. Non-fatal:
 * if it fails the battle still runs — only continuation resolution
 * degrades (the user re-prompts), so it must never block the fan-out.
 * Busts the 60s config cache so the continuation reply (often within
 * that window) reads the fresh pointer rather than a pre-battle copy.
 */
export async function setActiveBattle(args: {
  channelArn: string;
  battleId: string;
  /**
   * The duel owner, kept on the pointer so it survives the per-bot rows aging out.
   *
   * REQUIRED. A battle has an initiator the way a task has an owner (ADR-024): it is the person a
   * waiting side is waiting on, the only one whose reply resumes it, and the only one who may end it.
   * A duel without one is a comparison nobody is running - every ownership rule downstream degrades to
   * "anyone", which is how a member who never started a duel could answer a question they were never
   * asked. The fan-out refuses to start a duel it cannot attribute, so this is never absent by design.
   */
  initiatorUserSub: string;
}): Promise<void> {
  if (!CHANNEL_BATTLE_CONFIG_TABLE) return;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: CHANNEL_BATTLE_CONFIG_TABLE,
        Key: { channelArn: args.channelArn },
        // ALWAYS SET THE OWNER, because a duel always has one.
        //
        // This used to branch, REMOVEing the field when no owner was known - a real hazard while the
        // initiator was optional, since this is ONE row reused by every battle in the channel and a
        // carried-over value would hand the new duel the PREVIOUS initiator, locking its real owner out
        // and letting a stranger resume it. The branch is gone because its precondition is: the
        // initiator is required and the fan-out refuses a duel it cannot attribute, so the SET always
        // overwrites and nothing can be inherited.
        UpdateExpression:
          'SET activeBattleId = :b, activeBattleStartedAt = :now, activeBattleInitiator = :i',
        ConditionExpression: 'attribute_exists(channelArn)',
        ExpressionAttributeValues: {
          ':b': args.battleId,
          ':now': new Date().toISOString(),
          ':i': args.initiatorUserSub,
        },
      }),
    );
  } catch (err) {
    console.warn('[battle-state] setActiveBattle failed (continuation may degrade):', err);
  }
  invalidateChannelBattleConfigCache(args.channelArn);
}

/**
 * RELEASE the channel's active-battle pointer, because the duel it points at has ENDED - finished,
 * closed loud, or abandoned. All three release it the same way; only `reason` differs.
 *
 * This is the write whose absence made the clock load-bearing. `setActiveBattle` was the pointer's only
 * writer, so a duel that reached `COMPLETED` on both sides still left the pointer standing and the only
 * thing that ever took it down was `DUEL_MAX_LIFETIME_MS` expiring. The rows knew the duel was over; the
 * pointer did not, and the readers that consult the pointer went on believing a battle was running.
 *
 * CONDITIONAL on the battleId, and that condition is not decoration. A straggler from an ended duel - a
 * late orchestrator invocation, a retried abandon - arriving after the channel has started a NEW battle
 * would otherwise clear the new duel's pointer and strand it exactly as an overwrite would have. The
 * condition makes a late release a no-op instead.
 *
 * Non-fatal, like `setActiveBattle`: a failure here degrades to the old behaviour (the pointer stands
 * until the backstop clock releases it) and must never take down the path that is ending the duel.
 */
export async function clearActiveBattle(args: {
  channelArn: string;
  battleId: string;
  /** `round2:full` | `round2:degraded` | `closed:no-completion` | `abandoned:*` - kept for the audit. */
  reason: string;
  /** WHO ended it, when a person did. Absent when the duel ended on its own. */
  endedBy?: string;
}): Promise<void> {
  if (!CHANNEL_BATTLE_CONFIG_TABLE) return;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: CHANNEL_BATTLE_CONFIG_TABLE,
        Key: { channelArn: args.channelArn },
        UpdateExpression:
          'SET activeBattleEndedAt = :now, activeBattleEndReason = :r'
          + (args.endedBy ? ', activeBattleEndedBy = :by' : '')
          + ' REMOVE activeBattleId, activeBattleStartedAt, activeBattleInitiator',
        ConditionExpression: 'activeBattleId = :b',
        ExpressionAttributeValues: {
          ':b': args.battleId,
          ':now': new Date().toISOString(),
          ':r': args.reason,
          ...(args.endedBy ? { ':by': args.endedBy } : {}),
        },
      }),
    );
    console.log('[battle-state] active battle released', {
      channelArn: args.channelArn,
      battleId: args.battleId,
      reason: args.reason,
    });
  } catch (err) {
    // ConditionalCheckFailed is the EXPECTED outcome for a late release and is not a problem: it means
    // the pointer already moved on. Anything else degrades to the backstop clock.
    const name = (err as { name?: string }).name;
    if (name === 'ConditionalCheckFailedException') {
      console.log('[battle-state] active battle already released or superseded; nothing to clear', {
        channelArn: args.channelArn,
        battleId: args.battleId,
      });
    } else {
      console.warn('[battle-state] clearActiveBattle failed (pointer falls back to the backstop):', err);
    }
  }
  invalidateChannelBattleConfigCache(args.channelArn);
}

/**
 * Resolve the channel's active battleId for a continuation reply. Reads
 * the (cached) config; returns the pointer only if it is fresher than
 * the BattleState TTL — older than that and the battle's rows have aged
 * out, so the pointer is stale. This is a cheap pre-filter only:
 * correctness rides on the caller re-validating against live
 * `BattleState` rows (a stale/again-resolved pointer with no
 * `WAITING_FOR_USER` rows yields no resume → safe fall-through).
 */
export async function resolveActiveBattleId(channelArn: string): Promise<string | null> {
  return (await resolveActiveBattle(channelArn))?.battleId ?? null;
}

/**
 * The same resolution, WITH THE DUEL'S OWNER. Continuation is the caller that needs both, because
 * "which battle is this reply about" and "whose reply counts" are answered by the same row.
 *
 * The owner is read HERE rather than off the per-bot rows. The rows were the original source and it
 * was inert: they are rewritten by the duel's own progress (the terminal transition replaced the whole
 * item), so the enforcement compared the speaker against `undefined` and passed for everybody. The
 * pointer has one writer, at fan-out, from the `/battle` sender.
 *
 * `initiatorUserSub` undefined ⇒ this duel predates the field, or `setActiveBattle`'s non-fatal write
 * lost the sender. The caller falls back to the rows and, failing that, resumes for anyone: an
 * unanswerable duel is worse than an over-answerable one.
 */
export async function resolveActiveBattle(
  channelArn: string,
): Promise<{ battleId: string; initiatorUserSub?: string } | null> {
  const cfg = await loadChannelBattleConfig(channelArn);
  if (!cfg?.activeBattleId) return null;
  const active = { battleId: cfg.activeBattleId, initiatorUserSub: cfg.activeBattleInitiator };
  const startedMs = cfg.activeBattleStartedAt ? Date.parse(cfg.activeBattleStartedAt) : NaN;
  if (Number.isNaN(startedMs)) return active; // no/invalid timestamp → let rows arbitrate
  // A BACKSTOP, NOT THE MECHANISM (DESIGN-BATTLE 2a-i). A duel now ends by a recorded release -
  // `clearActiveBattle`, called when it finishes, closes loud, or is abandoned - and this clock only
  // covers a release that never landed, since that write is deliberately non-fatal. It must stay long
  // enough not to fire under a task-shaped duel that is legitimately still working with the user; ten
  // minutes was not, and released the pointer mid-duel so a second `/battle` could start alongside the
  // first (ADR-026). It is no longer how an ordinary duel ends, and nothing should read it as intent.
  if (Date.now() - startedMs > DUEL_MAX_LIFETIME_MS) return null; // backstop: release never landed
  return active;
}

// ---------------------------------------------------------------------------
// BattleState — per-bot state-machine rows
// ---------------------------------------------------------------------------

/**
 * `ABANDONED` is an END, not a FAILURE, and the distinction is the whole point of it existing.
 *
 * A duel the person walked out of - by changing the subject, by starting another one, or by a moderator
 * turning Battle Mode off - stops here (DESIGN-BATTLE 2a-i). `FAILED` would be a lie: nothing went wrong,
 * somebody left. And `COMPLETED` would be worse, because it would feed a comparison that never happened.
 *
 * It is deliberately ABSENT from `allBotsTerminal`. See that function and `duelInFlight`.
 */
export type BattleBotStatus = 'INVOKED' | 'WAITING_FOR_USER' | 'COMPLETED' | 'FAILED' | 'ABANDONED';

export interface BattleStateRow {
  battleId: string;
  botArn: string;
  state: BattleBotStatus;
  /**
   * The person who ran /battle. A duel HAS AN OWNER (owner, 2026-08-13): they are who a waiting side
   * is waiting on, who its task is assigned to, and the only person whose reply resumes it.
   *
   * Without it the continuation matched on the mentioned BOT alone, so any member could answer a
   * question they were not asked and steer a comparison they did not start.
   */
  initiatorUserSub?: string;
  round1Reply?: string;
  round1MessageId?: string;
  /**
   * The intent round 1 was CLASSIFIED as, so round 2 can inherit it.
   *
   * Only round 1 runs a classifier - round 2 is dispatched straight to the worker by the
   * orchestrator - so without this the rebuttal has no derived intent to declare. Absent rather
   * than defaulted: a duel whose round 1 predates this field records nothing, which is honest,
   * where a fallback would put a value nobody derived back into the analytics.
   */
  intent?: string;
  correlationId?: string;
  enteredStateAt?: string;
  ttl?: number;
  /**
   * When this side is DUE, as an epoch-ms number (ADR-026, the two clocks).
   *
   * Which clock it came from depends on the state the row is in: a generating side gets the machine
   * deadline, a side blocked on a human gets the far longer user-wait one. The orchestrator reads this
   * rather than recomputing from `enteredStateAt`, because only the writer knows which clock applies -
   * and while nothing wrote it, every deadline fell back to the machine arithmetic and a thinking user
   * was reported as a stalled assistant.
   */
  deadlineAt?: number;
  /**
   * Clarification metrics — a *measured* battle dimension (see
   * project-battle-clarification-measured-dimension): how often each
   * model asks vs. wrongly forges ahead. `clarificationCount` is an
   * atomic counter incremented once per INVOKED→WAITING_FOR_USER entry
   * (idempotent — a retry that finds the row already WAITING fails the
   * conditional and does not double-count). `clarificationQuestion` is
   * the single question put to the user; `waitingSince` anchors the
   * activeResponseMs accounting; `waitedMs` is the cumulative time the
   * bot spent blocked on the user across all clarification round-trips
   * (banked on each resume — `activeResponseMs = elapsed − waitedMs`,
   * computed in brick 2B-xi).
   */
  clarificationCount?: number;
  clarificationQuestion?: string;
  waitingSince?: string;
  waitedMs?: number;
  /**
   * The placeholder message id turned into the "waiting" state — the
   * resume path reuses THIS message (no orphan stale waiting message,
   * and the cleared battlewaiting marker is the frontend's "waiting
   * ended" signal). Set by markBotWaitingForUser.
   */
  waitingMessageId?: string;
  // NO `taskId`. A battle is not a task (DESIGN-BATTLE §2a): the row used to carry one so the
  // continuation path could resume a side's chain, which is battle state reaching into task state to
  // answer a battle question. The chain is found by asking who owns it - "the active task owned by
  // this assistant in this conversation" (ADR-024) - so nothing about tasks belongs on this row, and
  // the ordering problem it created (the row is written BEFORE the invoke, the task id only exists
  // AFTER it) disappears with it rather than needing a second write.
}

/**
 * Initial INVOKED-row write at fan-out time, before the per-bot async
 * processor invocations. Uses attribute_not_exists so we don't clobber a
 * row from a retry that already started a state machine.
 */
export async function initBotState(args: {
  battleId: string;
  botArn: string;
  correlationId: string;
  /** Who ran /battle. REQUIRED - see `setActiveBattle`. Recorded on every side so the duel keeps its owner. */
  initiatorUserSub: string;
}): Promise<void> {
  if (!BATTLE_STATE_TABLE) return;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // A freshly invoked side is GENERATING, so it starts on the machine clock.
  const deadlineAt = machineDeadline(nowMs);
  try {
    await ddb.send(
      new PutCommand({
        TableName: BATTLE_STATE_TABLE,
        Item: {
          battleId: args.battleId,
          botArn: args.botArn,
          state: 'INVOKED',
          correlationId: args.correlationId,
          ...(args.initiatorUserSub ? { initiatorUserSub: args.initiatorUserSub } : {}),
          enteredStateAt: now,
          deadlineAt,
          ttl: battleRowTtl(nowMs),
        },
        ConditionExpression: 'attribute_not_exists(botArn)',
      }),
    );
  } catch (err) {
    // ConditionalCheckFailedException is expected on retry — the row
    // already exists. Anything else is logged but non-fatal so a state-
    // table outage doesn't block the user's message from being processed.
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      console.warn('[battle-state] initBotState failed:', err);
    }
  }
}

/**
 * Transition a bot's row to a terminal state (COMPLETED or FAILED).
 * Conditional on the current state being non-terminal so retries are
 * idempotent. Returns true iff the write succeeded (i.e., this caller
 * is the one that transitioned the row — useful for "I'm last writer,
 * should I fire the orchestrator?" coordination).
 *
 * AN UPDATE, NOT A PUT. This wrote a whole item built from its own arguments, which silently deleted
 * every attribute the row had accumulated that the caller does not pass: `initiatorUserSub` (the duel's
 * owner), `clarificationCount`, `waitedMs`, `waitingSince`, `waitingMessageId`. So a side that recorded
 * its owner at fan-out, then asked a clarifying question, then finished, ended terminal with none of
 * it — which is why live rows read `owner=(none)` on duels started after ownership shipped, and why the
 * owner now lives on the channel pointer as well. A state transition transitions the state; the rest of
 * the row is not its to forget.
 */
export async function transitionBotState(args: {
  battleId: string;
  botArn: string;
  /**
   * The three states a side can STOP in. `ABANDONED` joins them because ending a duel is a transition
   * like any other, and this function's existing condition is already the rule it needs: only a side
   * that is `INVOKED` or `WAITING_FOR_USER` may move, so a side that genuinely completed keeps its
   * answer and a second abandon claims nothing.
   */
  state: 'COMPLETED' | 'FAILED' | 'ABANDONED';
  round1Reply?: string;
  round1MessageId?: string;
  /** Round 1's classified intent, so the orchestrator can hand round 2 an intent nobody invented. */
  intent?: string;
  correlationId?: string;
}): Promise<boolean> {
  if (!BATTLE_STATE_TABLE) return false;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // THE DUEL'S BOUND, NOT THIS LEG'S. This stamped a flat 600s, which is a whole-duel lifetime only
  // if a duel is short - and the human clock is an hour, so it is not. A side that finished round 1
  // early had its row deleted while its rival was still legitimately waiting on the user, and the
  // duel then read as a one-sided battle whose missing half "did not finish". Because
  // `battleRowTtl` only moves forward, this write also cannot shorten the far longer TTL a waiting
  // side is already carrying.
  const ttl = battleRowTtl(nowMs);

  // Only what this caller actually knows is written. A round-2 or opt-out transition carries no round-1
  // reply, and writing a null for it would erase the answer round 1 recorded — the same forgetting in a
  // smaller shape. (DynamoDB rejects an unused `:value`, so the pairs are built together.)
  const sets = ['#state = :state', 'correlationId = :corr', 'enteredStateAt = :now', '#ttl = :ttl'];
  const values: Record<string, unknown> = {
    ':state': args.state,
    ':corr': args.correlationId ?? null,
    ':now': now,
    ':ttl': ttl,
    ':invoked': 'INVOKED',
    ':waiting': 'WAITING_FOR_USER',
  };
  if (args.round1Reply !== undefined) {
    sets.push('round1Reply = :r1');
    values[':r1'] = args.round1Reply;
  }
  if (args.round1MessageId !== undefined) {
    sets.push('round1MessageId = :r1mid');
    values[':r1mid'] = args.round1MessageId;
  }
  // Written only when the caller HAS one, so a round-1 completion that carried no classification
  // leaves the attribute absent rather than writing a placeholder into it.
  if (args.intent !== undefined) {
    sets.push('intent = :intent');
    values[':intent'] = args.intent;
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: BATTLE_STATE_TABLE,
        Key: { battleId: args.battleId, botArn: args.botArn },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_not_exists(botArn) OR #state IN (:invoked, :waiting)',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Already terminal — another writer (retry, race) got there first.
      return false;
    }
    console.warn('[battle-state] transitionBotState failed:', err);
    return false;
  }
}

/**
 * Transition a bot's row INVOKED → WAITING_FOR_USER (SPEC-BATTLE.md
 * "Clarification Routing in Multi-Bot Channels"). Used when a battle
 * round-1 reply is a clarifying question rather than a complete answer:
 * the bot is NOT terminal, so the round-2 orchestrator must NOT fire
 * until this bot later completes. The user's directed reply (per-bot
 * `CHIME.mentions` routing — a later brick) is what moves it back to
 * INVOKED and ultimately COMPLETED.
 *
 * Conditional on `#state = INVOKED` only, so it is idempotent under
 * retry: a re-delivery that finds the row already WAITING_FOR_USER
 * fails the condition and returns false — which keeps `clarificationCount`
 * (an `ADD` atomic counter) incremented exactly once per real
 * clarification. Returns true iff THIS caller performed the transition,
 * mirroring transitionBotState's last-writer contract. Fails open
 * (returns false) when BATTLE_STATE_TABLE is unset.
 */
export async function markBotWaitingForUser(args: {
  battleId: string;
  botArn: string;
  question?: string;
  correlationId?: string;
  /**
   * WHY this side is waiting. Both suspend round 2; only one is a clarification.
   *
   * `clarification` (the default) is the side asking a question of its own accord, and it is a MEASURED
   * dimension - how often each model asks rather than wrongly forging ahead - so it increments
   * `clarificationCount`.
   *
   * `task-step` is a task-shaped duel between the legs of its own state machine (ADR-026). The side is
   * equally blocked on the user, but it did not choose to ask: the machine's next state requires input.
   * Counting those as clarifications would inflate the measurement by however many steps the task
   * happens to have, and make a `report_generation` duel look like a model that cannot stop asking
   * questions. Same transition, same suspension, no counter.
   */
  reason?: 'clarification' | 'task-step';
  /**
   * The channel placeholder message id that was turned into the "waiting"
   * state. Persisted so the resume path reuses THAT message (one clean
   * lifecycle, no orphan stale "waiting" message) instead of creating a
   * new placeholder.
   */
  waitingMessageId?: string;
}): Promise<boolean> {
  if (!BATTLE_STATE_TABLE) return false;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // THE CLOCK CHANGES HERE (ADR-026). This side is no longer generating, it is blocked on a person, so
  // it moves off the machine deadline and onto the human one. Writing `deadlineAt` explicitly is what
  // stops the orchestrator falling back to `enteredStateAt + MACHINE_DEADLINE_MS` and reporting a
  // thinking user as a stalled assistant. The TTL covers the whole DUEL (`battleRowTtl`), so neither
  // this row nor the rival's is deleted out from under a wait this long.
  const deadlineAt = userWaitDeadline(nowMs);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: BATTLE_STATE_TABLE,
        Key: { battleId: args.battleId, botArn: args.botArn },
        UpdateExpression:
          'SET #state = :waiting, enteredStateAt = :now, waitingSince = :now, ' +
          'clarificationQuestion = :q, correlationId = :corr, ' +
          'waitingMessageId = :wmid, deadlineAt = :deadline, #ttl = :ttl'
          // Only a real clarification moves the counter (see `reason`).
          + (args.reason === 'task-step' ? '' : ' ADD clarificationCount :one'),
        ConditionExpression: 'attribute_exists(botArn) AND #state = :invoked',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':waiting': 'WAITING_FOR_USER',
          ':invoked': 'INVOKED',
          ':now': now,
          ':q': args.question ?? null,
          ':corr': args.correlationId ?? null,
          ':wmid': args.waitingMessageId ?? null,
          ':deadline': deadlineAt,
          ':ttl': battleRowTtl(nowMs),
          ...(args.reason === 'task-step' ? {} : { ':one': 1 }),
        },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Row already left INVOKED (retry, or a terminal write won the
      // race). Not this caller's transition → no double-count.
      return false;
    }
    console.warn('[battle-state] markBotWaitingForUser failed:', err);
    return false;
  }
}

/**
 * Transition a bot's row WAITING_FOR_USER → INVOKED when the user's
 * directed reply arrives (SPEC-BATTLE.md "Per-bot reply UX"). Returns
 * the bot to active generation so its resumed turn can complete and
 * `transitionBotState` later moves it to COMPLETED (whose conditional
 * already accepts `WAITING_FOR_USER`/`INVOKED`).
 *
 * Banks the time spent blocked on the user: `waitedMs += now −
 * waitingSince`, accumulated (a TASK_* battle may clarify more than
 * once) so brick 2B-xi can report `activeResponseMs = elapsed −
 * waitedMs`. The conditional `#state = WAITING_FOR_USER` makes banking
 * exactly-once under retry/concurrency — a second resume call finds the
 * row already INVOKED, fails the condition, returns false, and does not
 * double-bank. `waitingSince` + `clarificationQuestion` are cleared so a
 * subsequent clarification in the same turn starts a fresh interval;
 * `clarificationCount` is cumulative and deliberately NOT reset.
 *
 * Telemetry is best-effort, the transition is not: if the
 * `waitingSince` read fails we resume with a 0 delta rather than strand
 * the bot (a missing wait interval skews one metric; a bot stuck in
 * WAITING_FOR_USER never finishes its battle). Fails open (false) when
 * BATTLE_STATE_TABLE is unset.
 */
export async function resumeBotFromWaiting(args: {
  battleId: string;
  botArn: string;
  correlationId?: string;
}): Promise<boolean> {
  if (!BATTLE_STATE_TABLE) return false;

  // Best-effort read of waitingSince to bank the waited interval. A read
  // failure must not block the resume — fall back to a 0 delta.
  let waitedMs = 0;
  try {
    const cur = await ddb.send(
      new GetCommand({
        TableName: BATTLE_STATE_TABLE,
        Key: { battleId: args.battleId, botArn: args.botArn },
      }),
    );
    const since = (cur.Item as BattleStateRow | undefined)?.waitingSince;
    const sinceMs = since ? Date.parse(since) : NaN;
    if (!Number.isNaN(sinceMs)) {
      waitedMs = Math.max(0, Date.now() - sinceMs);
    }
  } catch (err) {
    console.warn('[battle-state] resumeBotFromWaiting waitingSince read failed (banking 0):', err);
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // BACK ON THE MACHINE CLOCK. The user has answered, so this side is generating again and a stall from
  // here IS the assistant's. The deadline restarts from now rather than carrying the wait forward, which
  // is the whole point of separating the two: waited time is banked into `waitedMs` (so
  // `computeActiveResponseMs` can subtract it) and does not count against the side's own responsiveness.
  //
  // A chain with more exchanges to come will pass through here repeatedly, each leg getting a fresh
  // machine deadline and each wait its own human one.
  const deadlineAt = machineDeadline(nowMs);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: BATTLE_STATE_TABLE,
        Key: { battleId: args.battleId, botArn: args.botArn },
        UpdateExpression:
          'SET #state = :invoked, enteredStateAt = :now, correlationId = :corr, ' +
          'deadlineAt = :deadline, #ttl = :ttl ' +
          'ADD waitedMs :delta ' +
          'REMOVE waitingSince, clarificationQuestion',
        ConditionExpression: 'attribute_exists(botArn) AND #state = :waiting',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':invoked': 'INVOKED',
          ':waiting': 'WAITING_FOR_USER',
          ':now': now,
          ':corr': args.correlationId ?? null,
          ':deadline': deadlineAt,
          ':ttl': battleRowTtl(nowMs),
          ':delta': waitedMs,
        },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Row not WAITING_FOR_USER (retry, or a terminal/other write won
      // the race). Not this caller's transition → no double-bank.
      return false;
    }
    console.warn('[battle-state] resumeBotFromWaiting failed:', err);
    return false;
  }
}

/** Read all bot rows for a battle. Used by the orchestrator's "all terminal?" check. */
export async function readBattleRows(battleId: string): Promise<BattleStateRow[]> {
  if (!BATTLE_STATE_TABLE) return [];
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: BATTLE_STATE_TABLE,
        KeyConditionExpression: 'battleId = :id',
        ExpressionAttributeValues: { ':id': battleId },
      }),
    );
    return (result.Items as BattleStateRow[]) ?? [];
  } catch (err) {
    console.warn('[battle-state] readBattleRows failed:', err);
    return [];
  }
}

/**
 * Single-item read of one bot's row (PK battleId + SK botArn). Cheaper
 * than `readBattleRows` when only the caller's own row is needed — e.g.
 * the finalize tail reading `clarificationCount`/`waitedMs` to surface
 * the clarification measured dimension into analytics (2B-xi). Fails
 * open (null) so a telemetry read can never block the bot's reply.
 */
export async function getBotRow(
  battleId: string,
  botArn: string,
): Promise<BattleStateRow | null> {
  if (!BATTLE_STATE_TABLE) return null;
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: BATTLE_STATE_TABLE,
        Key: { battleId, botArn },
      }),
    );
    return (result.Item as BattleStateRow | undefined) ?? null;
  } catch (err) {
    console.warn('[battle-state] getBotRow failed:', err);
    return null;
  }
}

/**
 * Exactly-once orchestrator-fire guard. Writes a sentinel row (SK
 * '__orchestrator__') with attribute_not_exists; the conditional-put
 * succeeds for exactly one caller and fails for the rest.
 *
 * Call site flow:
 *   1. Bot's async processor finishes round-1 → transitionBotState(...)
 *   2. readBattleRows(battleId) → check all rows terminal
 *   3. If yes: tryClaimOrchestratorFire(battleId) → only the winner
 *      actually invokes the orchestrator
 */
export async function tryClaimOrchestratorFire(battleId: string): Promise<boolean> {
  if (!BATTLE_STATE_TABLE) return false;
  // Outlives the duel, like every other row. This claim is the only thing stopping a redelivered
  // orchestrator invocation fanning round 2 out a second time, so a claim that expires while the duel
  // is still in flight is a claim that stopped claiming.
  const ttl = battleRowTtl();
  try {
    await ddb.send(
      new PutCommand({
        TableName: BATTLE_STATE_TABLE,
        Item: {
          battleId,
          botArn: '__orchestrator__',
          state: 'COMPLETED',
          enteredStateAt: new Date().toISOString(),
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(botArn)',
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return false;
    }
    console.warn('[battle-state] tryClaimOrchestratorFire failed:', err);
    return false;
  }
}

/**
 * Claim the round-1 fan-out for a battleId exactly once, so a Chime channel-flow
 * REDELIVERY of the same /battle message cannot fan out (placeholders + worker
 * invokes) a second time and produce duplicate replies. Mirrors
 * tryClaimOrchestratorFire: a conditional-write sentinel row; only the first
 * caller returns true. deriveBattleId keys this on channelArn+userMessageId, so
 * the same message always claims the same battleId.
 */
export async function tryClaimRound1Fanout(battleId: string): Promise<boolean> {
  if (!BATTLE_STATE_TABLE) return true; // no state table: cannot dedupe, fan out (dev/athena)
  // Outlives the DUEL, not one leg. This sentinel is the only thing stopping a redelivered `/battle`
  // fanning out twice, and a duel that now legitimately runs for an hour would otherwise outlive its own
  // dedup claim and could be fanned out again on top of itself.
  const ttl = battleRowTtl();
  try {
    await ddb.send(
      new PutCommand({
        TableName: BATTLE_STATE_TABLE,
        Item: {
          battleId,
          botArn: '__round1__',
          state: 'COMPLETED',
          enteredStateAt: new Date().toISOString(),
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(botArn)',
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return false; // a prior delivery already fanned out round 1
    }
    console.warn('[battle-state] tryClaimRound1Fanout failed:', err);
    return true; // fail-open: a state-table blip should not swallow the battle
  }
}

/** Returns rows excluding the sentinel rows (`__orchestrator__`, `__round1__`, ...).
 *  Useful for "all bots done?" checks. Sentinels are the `__`-prefixed SKs. */
export function botRowsOnly(rows: BattleStateRow[]): BattleStateRow[] {
  return rows.filter((r) => !r.botArn.startsWith('__'));
}

/**
 * True iff every bot row is in a terminal state (COMPLETED or FAILED).
 *
 * NO EXPECTED-SIDE COUNT, DELIBERATELY. This trusts whatever rows survive, which is exactly how a
 * vanished row used to be read as a finished duel: one side's row aged out, the survivor was the only
 * row left, and "all of them are terminal" was true of a set with a hole in it. The fix for that is
 * the row TTL above - a row now outlives the duel, so the set cannot lose a member while the duel is
 * live - and NOT a count check here.
 *
 * A count check is the tempting second belt and it is not fail-safe. The count would have to come from
 * the fan-out, whose `initBotState` write is deliberately non-fatal: a state-table blip there must not
 * stop the user's turn being answered. So an expected count can legitimately exceed the rows that
 * exist, and gating on it would make round 2 defer forever. Nothing would rescue it: the orchestrator's
 * degraded resolution needs a time-based sweep the battle stack does not have yet, so today a deferral
 * is a hang. A duel that is genuinely missing a side already resolves LOUDLY (the orchestrator posts
 * "did not finish" for every non-completed side), which is the better failure of the two.
 */
export function allBotsTerminal(rows: BattleStateRow[]): boolean {
  const bots = botRowsOnly(rows);
  if (bots.length === 0) return false;
  return bots.every((r) => r.state === 'COMPLETED' || r.state === 'FAILED');
}

/**
 * Is a duel still RUNNING - a different question from `allBotsTerminal`, and the reason there are now two.
 *
 * `allBotsTerminal` answers "may round 2 fire", and it counts only `COMPLETED|FAILED`. `ABANDONED` is
 * absent from that list ON PURPOSE (DESIGN-BATTLE 2a-i): a duel somebody walked out of can then never
 * satisfy the round-2 trigger, so the suppression is STRUCTURAL rather than a check every future call
 * site has to remember. The cost of that choice is that "not terminal" no longer means "still going",
 * which is what this predicate is for.
 *
 * Running means a side is still `INVOKED` (generating) or `WAITING_FOR_USER` (blocked on a person).
 * `ABANDONED` fails both, so an abandoned duel is neither running nor comparable - which is exactly what
 * it is.
 */
export function duelInFlight(rows: BattleStateRow[]): boolean {
  return botRowsOnly(rows).some((r) => r.state === 'INVOKED' || r.state === 'WAITING_FOR_USER');
}

/** Has the orchestrator RESOLVED this duel - round 2 dispatched, or closed loud? The `__complete__` row. */
export function duelIsResolved(rows: BattleStateRow[]): boolean {
  return rows.some((r) => r.botArn === COMPLETE_SENTINEL);
}

/**
 * Is this duel still ALIVE - is anything about it still going to happen?
 *
 * A THIRD question, and the reason `duelInFlight` must not be asked in its place. `duelInFlight` means
 * "is a side working right now", and it is FALSE for the whole of round 2: round 1 ends by moving both
 * sides to `COMPLETED` and nothing moves them back while the rebuttal generates. So a caller asking "is
 * a battle running here" and reading `duelInFlight` gets `false` in the middle of a live duel - which
 * would let a topic change split the conversation out from under a rebuttal about to land in it, and
 * would let `/battle end` report a duel as already finished while killing the rebuttal it had not
 * noticed was coming.
 *
 * Alive means: sides exist, not every one of them has been abandoned, and the orchestrator has not yet
 * written the resolution marker. That marker is the only durable record of "there is no further
 * orchestrated phase", which is exactly the question being asked.
 */
export function duelIsLive(rows: BattleStateRow[]): boolean {
  const bots = botRowsOnly(rows);
  if (bots.length === 0) return false;
  if (bots.every((r) => r.state === 'ABANDONED')) return false;
  return !duelIsResolved(rows);
}

/**
 * Was this duel ABANDONED - ended by a person rather than finished?
 *
 * Reads the sentinel FIRST and the per-side rows second, because the sentinel is the claim that cannot
 * be lost to a race. `endBattle` takes the orchestrator's exactly-once claim before it transitions the
 * sides, so a side that reaches `COMPLETED` in between fails its abandon transition - leaving a duel
 * that was genuinely ended by a person with no `ABANDONED` row on it at all. A reader keying only on the
 * rows would then accept a pick on a comparison whose rebuttal was suppressed.
 */
export function duelWasAbandoned(rows: BattleStateRow[]): boolean {
  if (rows.some((r) => r.botArn === ABANDONED_SENTINEL)) return true;
  return botRowsOnly(rows).some((r) => r.state === 'ABANDONED');
}

/**
 * Record that this duel was abandoned, as a row of its own.
 *
 * The mirror of the orchestrator's `__complete__` marker, and it exists for the same reason: a duel's
 * END must be a durable fact rather than something inferred from whatever the per-side rows happen to
 * say. Conditional, so a second end claims nothing. Non-fatal.
 */
export async function markBattleAbandoned(battleId: string, reason: string): Promise<void> {
  if (!BATTLE_STATE_TABLE) return;
  try {
    await ddb.send(
      new PutCommand({
        TableName: BATTLE_STATE_TABLE,
        Item: {
          battleId,
          botArn: ABANDONED_SENTINEL,
          state: 'ABANDONED',
          completeReason: reason,
          enteredStateAt: new Date().toISOString(),
          ttl: battleRowTtl(),
        },
        ConditionExpression: 'attribute_not_exists(botArn)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      console.warn('[battle-state] markBattleAbandoned failed (non-fatal):', err);
    }
  }
}

/**
 * Is this side past the moment it was DUE? Moved here from the orchestrator so the in-flight guard and
 * the degraded-resolution path share one rule.
 *
 * WHICH CLOCK depends on the state the row is in, and only the writer knows: a generating side carries
 * the machine deadline, a side blocked on a human the far longer user-wait one (ADR-026, the two clocks).
 * This must not second-guess that, so it reads `deadlineAt` and nothing else.
 *
 * WHY NOT THE ROW'S TTL, which the single-active-battle guard used to read. Expiry is a fact about
 * DynamoDB's janitor; being past deadline is a fact about the duel. Reading the first as the second made
 * one number carry two meanings, and when the row lifetime was lengthened so a finished side could
 * outlive its rival's think time, a stalled duel silently went from holding its channel for ten minutes
 * to holding it for four hours. A deadline says the same thing at any TTL.
 *
 * Tolerates ISO, epoch seconds or epoch ms, because a value this load-bearing should not fail loud over
 * its own encoding. The `enteredStateAt + MACHINE_DEADLINE_MS` fallback is for rows written BEFORE
 * `deadlineAt` existed, and it is exactly the arithmetic that made a thinking user indistinguishable
 * from a stalled assistant - kept only so an in-flight duel spanning a deploy still resolves. Final
 * fallback is "not yet due": never fail loud without cause.
 */
export function isPastDeadline(row: BattleStateRow, nowMs: number = Date.now()): boolean {
  const raw: unknown = row.deadlineAt;
  let ms = NaN;
  if (typeof raw === 'number') {
    ms = raw < 1e12 ? raw * 1000 : raw; // seconds vs milliseconds
  } else if (typeof raw === 'string' && raw !== '') {
    const n = Number(raw);
    ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(raw);
  }
  // THE FALLBACK IS A SEPARATE STATEMENT, not another arm of the chain above.
  //
  // As an `else if` it was unreachable for the case that needs it most: a `deadlineAt` that is present
  // but unparseable took the string arm, produced NaN, and returned "not yet due" - so a row with a
  // corrupt deadline could never be past due here, while the orchestrator's own copy of this rule fell
  // through to `enteredStateAt` and called the same row stalled. One row, two answers, and the duel
  // held its channel until the backstop while the orchestrator closed it loud.
  if (!Number.isFinite(ms) && row.enteredStateAt) {
    const entered = Date.parse(row.enteredStateAt);
    ms = Number.isFinite(entered) ? entered + MACHINE_DEADLINE_MS : NaN;
  }
  if (!Number.isFinite(ms)) return false;
  return nowMs > ms;
}

/**
 * Pure. The bot ARNs a message is `Target`-addressed to (Chime
 * targeted delivery). Filters to AppInstanceBot ARNs (`/bot/`) so a
 * reply that also targets a human can't be mistaken for a bot
 * continuation. Deduped, order preserved. Feeds `planBattleContinuation`
 * as the addressed-bots set (it is source-agnostic — `CHIME.mentions`
 * vs. `Target` is the caller's concern). Pure → unit-test.
 */
export function extractTargetedBotArns(
  target: { MemberArn?: string }[] | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of target ?? []) {
    const arn = t?.MemberArn;
    if (arn && arn.includes('/bot/') && !seen.has(arn)) {
      seen.add(arn);
      out.push(arn);
    }
  }
  return out;
}

export interface BattleContinuationPlan {
  /**
   * Bots whose `WAITING_FOR_USER` turn this reply resumes, in the order
   * they were addressed. **Empty ⇒ this is NOT a battle continuation**
   * — the caller (brick 2B-x, channel-flow-processor) falls through to
   * normal routing and the message is ordinary channel chatter.
   */
  resumeBotArns: string[];
}

/**
 * Pure. SPEC-BATTLE.md "Per-bot reply UX": given a user reply's
 * `CHIME.mentions` set and the current battle rows, decide which bot(s)
 * this reply resumes. Strict per-bot isolation
 * (project-battle-clarification-measured-dimension): a reply resumes
 * ONLY bots that are BOTH explicitly addressed AND currently
 * `WAITING_FOR_USER`.
 *
 *  - A waiting bot the user did NOT address stays waiting — it must not
 *    free-ride on a rival's clarification (that would contaminate the
 *    measured "asks vs. forges ahead" signal).
 *  - An addressed bot that already finished round 1 (not waiting) is
 *    ignored — it has nothing to resume.
 *  - The user MAY deliberately address several waiting bots ("all" in
 *    the composer). That is an explicit human choice, not system
 *    broadcast, so the full intersection is returned (mention order
 *    preserved, deduped).
 *
 * The `__orchestrator__` sentinel is excluded via `botRowsOnly`; the
 * `WAITING_FOR_USER` definition is encapsulated here so the caller just
 * passes `readBattleRows(...)` output. Pure → unit-test.
 */
export function planBattleContinuation(
  rows: BattleStateRow[],
  mentions: string[] | undefined,
  /**
   * Who is speaking. A DUEL HAS ONE OWNER (owner, 2026-08-13): the person who ran `/battle` is who a
   * waiting side is waiting on, and the only one whose reply resumes it.
   *
   * This used to match on the mentioned BOT alone, so any member of the channel could answer a
   * question they were never asked and steer a comparison they did not start - and the initiator, who
   * did start it, would find their duel already moved on. A non-owner's message is not refused here,
   * it simply does not resume anything: it falls through and is answered as an ordinary turn.
   *
   * Omitted, or a battle recorded before owners existed, resumes as before rather than blocking - an
   * old duel with no recorded owner must not become unanswerable by anyone.
   */
  speakerUserSub?: string,
  /**
   * The owner as the CALLER resolved it — from the channel pointer (`resolveActiveBattle`), which is
   * where a duel's owner durably lives.
   *
   * This parameter is the fix for an enforcement that shipped inert. The owner used to be read from the
   * rows below and only from there, and the rows do not keep it: the terminal transition rewrote the
   * whole item, so a duel's owner was erased by its own completion and the comparison below ran against
   * `undefined` — passing for every member, which is the hole it exists to close.
   *
   * The row scan stays as a fallback, for an in-flight duel whose pointer predates the field.
   */
  ownerUserSub?: string,
): BattleContinuationPlan {
  const botRows = botRowsOnly(rows);
  const owner = ownerUserSub ?? botRows.find((r) => r.initiatorUserSub)?.initiatorUserSub;
  if (owner && speakerUserSub && owner !== speakerUserSub) {
    return { resumeBotArns: [] };
  }

  const waiting = new Set(
    botRows
      .filter((r) => r.state === 'WAITING_FOR_USER')
      .map((r) => r.botArn),
  );
  const seen = new Set<string>();
  const resumeBotArns: string[] = [];
  for (const arn of mentions ?? []) {
    if (waiting.has(arn) && !seen.has(arn)) {
      seen.add(arn);
      resumeBotArns.push(arn);
    }
  }
  return { resumeBotArns };
}

/**
 * Pure. `activeResponseMs` (project-battle-clarification-measured-
 * dimension): the bot's response time with time spent blocked on the
 * user removed — `elapsed − waitedMs`. Clamped ≥ 0 (clock skew, or a
 * banked wait exceeding the measured elapsed on a partial turn, must
 * never yield a negative metric). Undefined `waitedMs` (no
 * clarification this battle) ⇒ active time == elapsed. Pure → unit-test.
 */
export function computeActiveResponseMs(elapsedMs: number, waitedMs?: number): number {
  return Math.max(0, elapsedMs - (waitedMs ?? 0));
}
