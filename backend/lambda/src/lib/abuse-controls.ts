/**
 * Abuse controls (docs/specs/analytics-eval/SPEC-ABUSE-CONTROLS.md).
 *
 * One generic `pk`+`ttl` DynamoDB table (`ABUSE_CONTROLS_TABLE`) backs:
 *  - request dedup (`dedup#<correlationId>`) - collapse duplicate at-least-once deliveries so a
 *    message is processed once (removes the double Bedrock call + the task-status clobber).
 *  - model-spend budget (`budget#user#<personId>#<hour>`, `budget#global#<hour>`) - bound per-user and
 *    total hourly model calls, with the global limit protecting the account.
 *
 * Fail policy: every LIMIT FAILS CLOSED. The rate limit, the per-user budget and the global budget
 * each refuse when their store errors, and when the limit is set but the table name is not, because a
 * control-table outage or a missing wire must not become an unbounded-request or unbounded-spend path.
 * Synthesis refuses a deployment that wires the limits without the table (`abuseControlsWiring`). A
 * limit configured as 0 is off: that is policy, not a store failure. Dedup and the placeholder mapping
 * are idempotency, not limits: their worst case is one duplicate, so they FAIL OPEN. Admin exemption
 * is the caller's responsibility.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { noticeLine, type NoticeCopyKey } from './assistant-notice.js';
import type { AssistantCopy } from './active-profile.js';
import { BUDGET_TTL_SECONDS, hourKeyAt, userBudgetKey } from './abuse-control-keys.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE = process.env.ABUSE_CONTROLS_TABLE || '';
// THE PROCESSOR'S OWN RECORD, ON ITS OWN ROLE: bookkeeping about a turn,
// not something the assistant does, so it never goes out on the assistant's session.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER }));

// Circuit-trip SSM param (edge-shedding signal, matching CH). Flipped when the global model-call
// count crosses the circuit threshold; a frontend/API intake can read it to stop calling until it
// resets. Empty ⇒ the trip is disabled (the global budget still fails safe on its own).
const CIRCUIT_PARAM = process.env.ABUSE_CIRCUIT_PARAM || '';
const ssm = CIRCUIT_PARAM ? new SSMClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER }) : null;

const DEDUP_TTL_SECONDS = 300; // 5 min - long enough to cover a duplicate delivery burst
const RATE_LIMIT_TTL_SECONDS = 7200; // 2 h - same window+slack as budgets

const nowSec = (): number => Math.floor(Date.now() / 1000);
const hourKey = (): string => hourKeyAt(new Date());

/**
 * THE CLAIM KEY FOR ONE INBOUND MESSAGE'S TURN, named here because two components compete for it.
 *
 * The channel flow takes it before releasing a message it is about to dispatch a turn for. The task
 * answer repair takes it off the message stream, AFTER release, to find out whether the flow already
 * did - so the key has to mean the same thing on both sides. It lived as a private const in the flow
 * while the flow was the only holder; a second holder makes a shared definition the difference
 * between "the flow already answered this" and a message answered twice.
 */
export const flowDeliveryKey = (messageId: string): string => `flow-${messageId}`;

/**
 * Claim a correlationId for one-time processing. Returns `true` on the first claim (proceed),
 * `false` if it was already claimed within the dedup window (a duplicate - the caller should
 * no-op). Fails OPEN (returns `true`) when the table is unset or on any non-conditional error.
 */
export async function claimCorrelation(correlationId: string): Promise<boolean> {
  if (!TABLE || !correlationId) return true;
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: `dedup#${correlationId}`, ttl: nowSec() + DEDUP_TTL_SECONDS },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false; // already claimed -> duplicate
    console.warn('[abuse-controls] dedup claim failed (fail-open):', err?.message);
    return true;
  }
}

/**
 * Whether a claim EXISTS, without taking it. A read, not a write: the losing side of a dedup race
 * sometimes needs to know what the winner DID (e.g. "was the winning fulfillment gate-blocked?")
 * and probing by claiming would poison the very marker it is asking about. Fail-open to false - an
 * unreadable table means "assume the normal path", the same direction every other claim here fails.
 */
export async function hasCorrelationClaim(correlationId: string): Promise<boolean> {
  if (!TABLE || !correlationId) return false;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `dedup#${correlationId}` },
    }));
    return !!res.Item;
  } catch (err: any) {
    console.warn('[abuse-controls] dedup probe failed (fail-open):', err?.message);
    return false;
  }
}

/**
 * How long a placeholder mapping lives. Sized for the gap between the router dispatching and the
 * processor resolving, not for a conversation - see TURN_CORRELATION_WINDOW_SECONDS.
 */
const CORR_MAP_TTL_SECONDS = 300;

/**
 * Record which message carries a correlation id, so the async processor can resolve its placeholder
 * with a point read instead of scanning recent messages (ADR-022).
 *
 * WRITE-ONCE, and the return value is the point. `true` means this is the first message seen for the
 * correlation id. `false` means one is already recorded, which makes THIS message a duplicate
 * placeholder for a turn already in flight - the caller denies it so it never reaches the channel.
 * That is what keeps a retried Lex fulfillment from leaving a second "One moment..." stranded.
 *
 * Write-once also matters without any duplicate: an updated message re-invokes the channel flow, so
 * the flow sees the same marker again when the processor writes the real answer over the placeholder.
 * That second sighting must not be treated as new.
 *
 * Fails OPEN (`true`) when the table is unset or on a non-conditional error: losing the mapping costs
 * a fallback scan, while wrongly denying a placeholder would drop the reply.
 */
export async function claimPlaceholderMapping(correlationId: string, messageId: string): Promise<string> {
  if (!TABLE || !correlationId || !messageId) return messageId;
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: `corr#${correlationId}`, messageId, ttl: nowSec() + CORR_MAP_TTL_SECONDS },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return messageId;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[abuse-controls] placeholder mapping write failed (fail-open):', err?.message);
      return messageId;
    }
    // Already mapped. Return the OWNER so the caller can tell a duplicate placeholder (a different
    // message) from this same message being seen again, which happens on every update: the processor
    // writes the answer over the placeholder, and an updated message re-invokes the channel flow.
    // Treating that second sighting as a duplicate would delete the answer.
    const owner = await readPlaceholderMapping(correlationId);
    return owner || messageId;
  }
}

/** The message carrying `correlationId`, or null if it is not recorded (yet, or at all). */
export async function readPlaceholderMapping(correlationId: string): Promise<string | null> {
  if (!TABLE || !correlationId) return null;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `corr#${correlationId}` },
    }));
    return (res.Item?.messageId as string) || null;
  } catch (err: any) {
    console.warn('[abuse-controls] placeholder mapping read failed:', err?.message);
    return null;
  }
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: 'user' | 'global';
}

/**
 * Increment the per-user and global hourly model-call counters and decide whether this call is
 * within budget. Admin-exempt (the per-user budget only) via `opts.isAdmin`. A budget of <= 0 (or
 * unset) disables that limit. FAILS CLOSED: when a budget applies to this call and its table is
 * unset, or the store errors, the call is over budget, so a control-table outage cannot become
 * unbounded spend.
 */
export async function checkAndConsumeBudget(
  personId: string,
  opts: { isAdmin?: boolean } = {},
): Promise<BudgetDecision> {
  const userBudget = parseInt(process.env.BEDROCK_USER_HOURLY_BUDGET || '0', 10);
  const globalBudget = parseInt(process.env.BEDROCK_GLOBAL_HOURLY_BUDGET || '0', 10);
  // An empty `personId` is a turn no person asked for (`evaluateAbuseGate`'s `machineWritten`): the
  // global limit is the only one it meets. An exempt admin meets only the global limit as well.
  const userApplies = !!personId && userBudget > 0 && !opts.isAdmin;
  const globalApplies = globalBudget > 0;
  if (!userApplies && !globalApplies) return { allowed: true }; // no limit applies -> off
  const refused: BudgetDecision = { allowed: false, reason: globalApplies ? 'global' : 'user' };
  if (!TABLE) {
    console.error('[abuse-controls] a spend budget is set but ABUSE_CONTROLS_TABLE is not; refusing');
    return refused;
  }
  const hour = hourKey();
  const ttl = nowSec() + BUDGET_TTL_SECONDS;
  try {
    // The GLOBAL limit applies to EVERYONE, admins included - it protects the account, so an exempt
    // admin is never a bypass for unbounded spend (the exemption below is per-user only).
    if (globalApplies) {
      const globalCount = await bumpCounter(`budget#global#${hour}`, ttl);
      // Circuit trip (CH parity): once the global count crosses the trip threshold, flip the SSM
      // circuit param so an intake can shed load at the edge. Fire-and-forget (no hot-path
      // latency); the threshold defaults to the global budget when unset.
      const tripThreshold = parseInt(process.env.ABUSE_CIRCUIT_TRIP_THRESHOLD || String(globalBudget), 10);
      if (ssm && CIRCUIT_PARAM && globalCount > tripThreshold) tripCircuit(globalCount, tripThreshold);
      if (globalCount > globalBudget) return { allowed: false, reason: 'global' };
    }
    // Admin exemption (opt-in, forwarded by the router): skip ONLY the per-user budget. The global
    // limit above still counted this call and can still block it.
    if (userApplies) {
      const userCount = await bumpCounter(userBudgetKey(personId, hour), ttl);
      if (userCount > userBudget) return { allowed: false, reason: 'user' };
    }
    return { allowed: true };
  } catch (err: any) {
    console.error('[abuse-controls] budget check failed; refusing:', err?.message);
    return refused;
  }
}

/**
 * The reply served when a spend budget is exceeded: the assistant's `budgetExhausted` line, else the
 * deployment's `budgetCannedResponse` context (`BUDGET_CANNED_RESPONSE`), else the shipped English.
 */
export function budgetCannedResponse(copy?: AssistantCopy): string {
  return noticeLine(copy, 'budgetExhausted', {}, process.env.BUDGET_CANNED_RESPONSE);
}

/** Atomically increment a counter row and return the new value; sets a self-expiry TTL once. */
async function bumpCounter(pk: string, ttl: number): Promise<number> {
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk },
    UpdateExpression: 'ADD #c :one SET #ttl = if_not_exists(#ttl, :ttl)',
    ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
    ReturnValues: 'UPDATED_NEW',
  }));
  return Number((res.Attributes as { count?: number })?.count ?? 0);
}

/** Fire-and-forget flip of the circuit SSM param (best-effort; never blocks the turn). */
function tripCircuit(count: number, threshold: number): void {
  console.warn(`[abuse-controls] circuit trip threshold reached (${count}/${threshold}); flipping circuit`);
  ssm!
    .send(new PutParameterCommand({
      Name: CIRCUIT_PARAM,
      Value: JSON.stringify({ tripped: true, at: new Date().toISOString(), count }),
      Type: 'String',
      Overwrite: true,
    }))
    .catch((e) => console.error('[abuse-controls] failed to trip circuit:', e?.message));
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetInMinutes: number;
}

/**
 * Per-user hourly rate limit (CH parity). Admin-exempt. `limit <= 0` (or unset) disables it.
 * Atomically increments `ratelimit#<personId>#<hour>` and blocks once the count exceeds the
 * limit. FAILS CLOSED: when the limit is set and its table is unset, or the store errors, the call
 * is refused, so a control-table outage cannot become an unbounded-request path. The reset window is
 * the remainder of the current UTC hour.
 */
export async function checkRateLimit(
  personId: string,
  limit: number,
  opts: { isAdmin?: boolean } = {},
): Promise<RateLimitDecision> {
  const resetInMinutes = 60 - new Date().getUTCMinutes();
  if (opts.isAdmin || !personId || limit <= 0) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetInMinutes };
  }
  if (!TABLE) {
    console.error('[abuse-controls] a rate limit is set but ABUSE_CONTROLS_TABLE is not; refusing');
    return { allowed: false, remaining: 0, resetInMinutes };
  }
  try {
    const count = await bumpCounter(`ratelimit#${personId}#${hourKey()}`, nowSec() + RATE_LIMIT_TTL_SECONDS);
    if (count > limit) {
      console.warn(`[abuse-controls] rate limit exceeded for ${personId}: ${count}/${limit}`);
      return { allowed: false, remaining: 0, resetInMinutes };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), resetInMinutes };
  } catch (err: any) {
    console.error('[abuse-controls] rate-limit check failed; refusing:', err?.message);
    return { allowed: false, remaining: 0, resetInMinutes };
  }
}

export type AbuseGateDecision =
  | { allowed: true }
  | {
    allowed: false;
    reason: 'rate' | 'budget';
    /** The refusal composed from the copy the caller passed, for a caller that replies itself. */
    message: string;
    /** The same refusal as a notice kind, for a caller that hands it to the assistant to say. */
    notice: { kind: NoticeCopyKey; vars: Record<string, string | number> };
  };

/**
 * The shared cost/abuse gate: the ORDER (per-user rate limit, then per-user+global spend budget) and
 * the reject-message selection, in one place. Every model-dispatch entry point runs it - the Lex
 * router (1:1 turn) and the channel-flow @all / battle paths - so a new control or a wording change
 * lands once, not per call site. Returns a decision; the CALLER emits it in its own transport (a Lex
 * response, or a targeted bot message). `rateLimit` is passed in (the profile registry that resolves
 * it lives above this lib); `isAdmin` forwards the opt-in per-user exemption (never the global budget).
 */
export async function evaluateAbuseGate(opts: {
  personId: string;
  rateLimit: number;
  isAdmin: boolean;
  /** The answering assistant's copy, so the refusal is in its own words. */
  copy?: AssistantCopy;
  /**
   * NOBODY ASKED FOR THIS TURN, so no person is metered for it. A join recap is the
   * room's assistant catching up a person who was just added: `personId` is who it is FOR, not who asked, so
   * charging their hourly rate limit or per-user budget would spend a new member's allowance before they had
   * said a word. The turn still calls a model, so the deployment's GLOBAL budget counts it and can refuse
   * it: that limit protects the account and nothing is exempt from it.
   */
  machineWritten?: boolean;
}): Promise<AbuseGateDecision> {
  if (opts.machineWritten) {
    const budget = await checkAndConsumeBudget('', {});
    return budget.allowed
      ? { allowed: true }
      : { allowed: false, reason: 'budget', message: budgetCannedResponse(opts.copy), notice: { kind: 'budgetExhausted', vars: {} } };
  }
  const rate = await checkRateLimit(opts.personId, opts.rateLimit, { isAdmin: opts.isAdmin });
  if (!rate.allowed) {
    const vars = { minutes: rate.resetInMinutes };
    return {
      allowed: false, reason: 'rate',
      message: rateLimitMessage(rate.resetInMinutes, opts.copy),
      notice: { kind: 'rateLimited', vars },
    };
  }
  const budget = await checkAndConsumeBudget(opts.personId, { isAdmin: opts.isAdmin });
  if (!budget.allowed) {
    return {
      allowed: false, reason: 'budget',
      message: budgetCannedResponse(opts.copy),
      notice: { kind: 'budgetExhausted', vars: {} },
    };
  }
  return { allowed: true };
}

/** The reply served when a user hits their hourly rate limit: the assistant's `rateLimited` line. */
export function rateLimitMessage(resetInMinutes: number, copy?: AssistantCopy): string {
  return noticeLine(copy, 'rateLimited', { minutes: resetInMinutes });
}

/**
 * Clamp an over-long user message before it reaches the model (CH parity). Truncates to
 * `MAX_USER_MESSAGE_LENGTH` chars (0/unset ⇒ no cap) and logs when it fires. Bounds token cost and
 * narrows the prompt-injection surface. Pure + synchronous; no table access.
 */
export function capUserMessage(text: string): string {
  const max = parseInt(process.env.MAX_USER_MESSAGE_LENGTH || '0', 10);
  if (max <= 0 || text.length <= max) return text;
  console.warn(`[abuse-controls] truncating user message from ${text.length} to ${max} chars`);
  return text.slice(0, max);
}
