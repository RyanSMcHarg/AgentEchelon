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
const STATE_TTL_SECONDS = 600; // 10 min — matches spec's BattleStateTable TTL

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
}): Promise<void> {
  if (!CHANNEL_BATTLE_CONFIG_TABLE) return;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: CHANNEL_BATTLE_CONFIG_TABLE,
        Key: { channelArn: args.channelArn },
        UpdateExpression: 'SET activeBattleId = :b, activeBattleStartedAt = :now',
        ConditionExpression: 'attribute_exists(channelArn)',
        ExpressionAttributeValues: {
          ':b': args.battleId,
          ':now': new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    console.warn('[battle-state] setActiveBattle failed (continuation may degrade):', err);
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
  const cfg = await loadChannelBattleConfig(channelArn);
  if (!cfg?.activeBattleId) return null;
  const startedMs = cfg.activeBattleStartedAt ? Date.parse(cfg.activeBattleStartedAt) : NaN;
  if (Number.isNaN(startedMs)) return cfg.activeBattleId; // no/invalid timestamp → let rows arbitrate
  if (Date.now() - startedMs > STATE_TTL_SECONDS * 1000) return null; // battle aged out
  return cfg.activeBattleId;
}

// ---------------------------------------------------------------------------
// BattleState — per-bot state-machine rows
// ---------------------------------------------------------------------------

export type BattleBotStatus = 'INVOKED' | 'WAITING_FOR_USER' | 'COMPLETED' | 'FAILED';

export interface BattleStateRow {
  battleId: string;
  botArn: string;
  state: BattleBotStatus;
  round1Reply?: string;
  round1MessageId?: string;
  correlationId?: string;
  enteredStateAt?: string;
  ttl?: number;
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
  /**
   * For a `TASK_*` battle, the per-bot task this row's bot is running
   * (one Task per bot, assigned to it — see createBattleTask). Stamped
   * at fan-out. Absent ⇒ a PLACEHOLDER/DIRECT battle. Lets the
   * continuation router tell the two apart without re-deriving anything:
   * present ⇒ resume that task chain (brick 2B-x-c); absent ⇒ plain
   * re-invoke (brick 2B-x-b).
   */
  taskId?: string;
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
  /** Set for a TASK_* battle so the row records the bot's task (2B-x-c). */
  taskId?: string;
}): Promise<void> {
  if (!BATTLE_STATE_TABLE) return;
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  try {
    await ddb.send(
      new PutCommand({
        TableName: BATTLE_STATE_TABLE,
        Item: {
          battleId: args.battleId,
          botArn: args.botArn,
          state: 'INVOKED',
          correlationId: args.correlationId,
          enteredStateAt: now,
          ttl,
          ...(args.taskId && { taskId: args.taskId }),
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
 */
export async function transitionBotState(args: {
  battleId: string;
  botArn: string;
  state: 'COMPLETED' | 'FAILED';
  round1Reply?: string;
  round1MessageId?: string;
  correlationId?: string;
}): Promise<boolean> {
  if (!BATTLE_STATE_TABLE) return false;
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  try {
    await ddb.send(
      new PutCommand({
        TableName: BATTLE_STATE_TABLE,
        Item: {
          battleId: args.battleId,
          botArn: args.botArn,
          state: args.state,
          round1Reply: args.round1Reply,
          round1MessageId: args.round1MessageId,
          correlationId: args.correlationId,
          enteredStateAt: now,
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(botArn) OR #state IN (:invoked, :waiting)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':invoked': 'INVOKED', ':waiting': 'WAITING_FOR_USER' },
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
   * The channel placeholder message id that was turned into the "waiting"
   * state. Persisted so the resume path reuses THAT message (one clean
   * lifecycle, no orphan stale "waiting" message) instead of creating a
   * new placeholder.
   */
  waitingMessageId?: string;
}): Promise<boolean> {
  if (!BATTLE_STATE_TABLE) return false;
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: BATTLE_STATE_TABLE,
        Key: { battleId: args.battleId, botArn: args.botArn },
        UpdateExpression:
          'SET #state = :waiting, enteredStateAt = :now, waitingSince = :now, ' +
          'clarificationQuestion = :q, correlationId = :corr, ' +
          'waitingMessageId = :wmid, #ttl = :ttl ' +
          'ADD clarificationCount :one',
        ConditionExpression: 'attribute_exists(botArn) AND #state = :invoked',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':waiting': 'WAITING_FOR_USER',
          ':invoked': 'INVOKED',
          ':now': now,
          ':q': args.question ?? null,
          ':corr': args.correlationId ?? null,
          ':wmid': args.waitingMessageId ?? null,
          ':ttl': ttl,
          ':one': 1,
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

  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: BATTLE_STATE_TABLE,
        Key: { battleId: args.battleId, botArn: args.botArn },
        UpdateExpression:
          'SET #state = :invoked, enteredStateAt = :now, correlationId = :corr, #ttl = :ttl ' +
          'ADD waitedMs :delta ' +
          'REMOVE waitingSince, clarificationQuestion',
        ConditionExpression: 'attribute_exists(botArn) AND #state = :waiting',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':invoked': 'INVOKED',
          ':waiting': 'WAITING_FOR_USER',
          ':now': now,
          ':corr': args.correlationId ?? null,
          ':ttl': ttl,
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
  const ttl = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
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

/** Returns rows excluding the orchestrator sentinel. Useful for "all bots done?" checks. */
export function botRowsOnly(rows: BattleStateRow[]): BattleStateRow[] {
  return rows.filter((r) => r.botArn !== '__orchestrator__');
}

/** True iff every bot row is in a terminal state (COMPLETED or FAILED). */
export function allBotsTerminal(rows: BattleStateRow[]): boolean {
  const bots = botRowsOnly(rows);
  if (bots.length === 0) return false;
  return bots.every((r) => r.state === 'COMPLETED' || r.state === 'FAILED');
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
): BattleContinuationPlan {
  const waiting = new Set(
    botRowsOnly(rows)
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

export interface BattleResumePlan {
  deliveryOption: 'PLACEHOLDER_UPDATE' | 'TASK_UPDATE_IN_PLACE' | 'TASK_MULTI_STEP';
  taskType?: string;
  taskId?: string;
}

/**
 * Pure. SPEC-BATTLE.md "Per-bot reply UX" — how a resumed bot's invoke
 * should be shaped. Primitives only (the literal-union mirrors the
 * `DeliveryOption` string enum) so it carries no domain coupling and is
 * unit-testable.
 *
 *  - No `rowTaskId` ⇒ a PLACEHOLDER/DIRECT battle → plain re-invoke
 *    (the user's answer becomes the prompt).
 *  - `rowTaskId` set but the task is gone or already terminal ⇒ can't
 *    continue a chain → degrade to a plain re-invoke so the bot still
 *    answers rather than stranding (a missing/finished task must not
 *    leave the bot dead).
 *  - `rowTaskId` set and the task is live ⇒ resume THAT task chain
 *    (carry its deliveryOption + taskType + id; the premium async
 *    processor's existing TASK_* path advances the state machine with
 *    the user's answer as the next turn).
 */
export function planBattleResume(args: {
  rowTaskId?: string;
  task?: { status?: string; deliveryOption?: string; taskType?: string; taskId?: string } | null;
}): BattleResumePlan {
  if (!args.rowTaskId) return { deliveryOption: 'PLACEHOLDER_UPDATE' };
  const t = args.task;
  if (!t || t.status === 'completed' || t.status === 'failed') {
    return { deliveryOption: 'PLACEHOLDER_UPDATE' };
  }
  // Only resume the chain when the task really is a TASK_* one. Task
  // fields are returned ONLY with a TASK_* deliveryOption — handing a
  // taskId to a PLACEHOLDER invoke would be incoherent.
  const d = t.deliveryOption;
  if (d === 'TASK_UPDATE_IN_PLACE' || d === 'TASK_MULTI_STEP') {
    return { deliveryOption: d, taskType: t.taskType, taskId: t.taskId ?? args.rowTaskId };
  }
  return { deliveryOption: 'PLACEHOLDER_UPDATE' };
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
