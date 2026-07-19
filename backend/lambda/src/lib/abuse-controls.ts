/**
 * Abuse controls (docs/specs/analytics-eval/SPEC-ABUSE-CONTROLS.md).
 *
 * One generic `pk`+`ttl` DynamoDB table (`ABUSE_CONTROLS_TABLE`) backs:
 *  - request dedup (`dedup#<correlationId>`) - collapse duplicate at-least-once deliveries so a
 *    message is processed once (removes the double Bedrock call + the task-status clobber).
 *  - model-spend budget (`budget#user#<sub>#<hour>`, `budget#global#<hour>`) - bound per-user and
 *    total hourly model calls, with the global ceiling protecting the account.
 *
 * Fail policy: dedup and the per-user budget FAIL OPEN (a control-plane hiccup must not block
 * legitimate traffic - the worst case is one duplicate or one over-quota call). The GLOBAL spend
 * budget FAILS SAFE (an error becomes "over budget") because its whole purpose is to keep a
 * control-table outage from becoming an unbounded-spend path. Every control is a no-op until its
 * env is set, so partial rollout is safe. Admin exemption is the caller's responsibility.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE = process.env.ABUSE_CONTROLS_TABLE || '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));

// Circuit-trip SSM param (edge-shedding signal, matching CH). Flipped when the global model-call
// count crosses the circuit threshold; a frontend/API intake can read it to stop calling until it
// resets. Empty ⇒ the trip is disabled (the global budget still fails safe on its own).
const CIRCUIT_PARAM = process.env.ABUSE_CIRCUIT_PARAM || '';
const ssm = CIRCUIT_PARAM ? new SSMClient({ region: AWS_REGION }) : null;

const DEDUP_TTL_SECONDS = 300; // 5 min - long enough to cover a duplicate delivery burst
const BUDGET_TTL_SECONDS = 7200; // 2 h - covers the 1 h window plus slack before self-expiry
const RATE_LIMIT_TTL_SECONDS = 7200; // 2 h - same window+slack as budgets

const nowSec = (): number => Math.floor(Date.now() / 1000);
const hourKey = (): string => new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)

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

export interface BudgetDecision {
  allowed: boolean;
  reason?: 'user' | 'global';
}

/**
 * Increment the per-user and global hourly model-call counters and decide whether this call is
 * within budget. Admin-exempt via `opts.isAdmin`. A budget of <= 0 (or unset) disables that
 * ceiling. Fails OPEN on error when only a per-user budget is set; fails SAFE (over budget) when
 * a global budget is set, so a control-table outage cannot become unbounded spend.
 */
export async function checkAndConsumeBudget(
  userSub: string,
  opts: { isAdmin?: boolean } = {},
): Promise<BudgetDecision> {
  if (!TABLE || opts.isAdmin) return { allowed: true };
  const userBudget = parseInt(process.env.BEDROCK_USER_HOURLY_BUDGET || '0', 10);
  const globalBudget = parseInt(process.env.BEDROCK_GLOBAL_HOURLY_BUDGET || '0', 10);
  if (userBudget <= 0 && globalBudget <= 0) return { allowed: true }; // not configured -> off
  const hour = hourKey();
  const ttl = nowSec() + BUDGET_TTL_SECONDS;
  try {
    if (globalBudget > 0) {
      const globalCount = await bumpCounter(`budget#global#${hour}`, ttl);
      // Circuit trip (CH parity): once the global count crosses the trip threshold, flip the SSM
      // circuit param so an intake can shed load at the edge. Fire-and-forget (no hot-path
      // latency); the threshold defaults to the global budget when unset.
      const tripThreshold = parseInt(process.env.ABUSE_CIRCUIT_TRIP_THRESHOLD || String(globalBudget), 10);
      if (ssm && CIRCUIT_PARAM && globalCount > tripThreshold) tripCircuit(globalCount, tripThreshold);
      if (globalCount > globalBudget) return { allowed: false, reason: 'global' };
    }
    if (userSub && userBudget > 0) {
      const userCount = await bumpCounter(`budget#user#${userSub}#${hour}`, ttl);
      if (userCount > userBudget) return { allowed: false, reason: 'user' };
    }
    return { allowed: true };
  } catch (err: any) {
    console.warn('[abuse-controls] budget check failed:', err?.message);
    // Global budget fails SAFE; a per-user-only budget fails OPEN (one user's counter erroring
    // must not block everyone).
    return globalBudget > 0 ? { allowed: false, reason: 'global' } : { allowed: true };
  }
}

/** The canned reply served when a spend budget is exceeded (env-overridable). */
export function budgetCannedResponse(): string {
  return (
    process.env.BUDGET_CANNED_RESPONSE ||
    'We are experiencing unusually high demand right now. Please try again in a little while.'
  );
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
 * Atomically increments `ratelimit#<userSub>#<hour>` and blocks once the count exceeds the classification
 * ceiling. Fails OPEN on error (a control-plane hiccup must not lock a user out). The reset window
 * is the remainder of the current UTC hour.
 */
export async function checkRateLimit(
  userSub: string,
  limit: number,
  opts: { isAdmin?: boolean } = {},
): Promise<RateLimitDecision> {
  const resetInMinutes = 60 - new Date().getUTCMinutes();
  if (!TABLE || opts.isAdmin || !userSub || limit <= 0) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetInMinutes };
  }
  try {
    const count = await bumpCounter(`ratelimit#${userSub}#${hourKey()}`, nowSec() + RATE_LIMIT_TTL_SECONDS);
    if (count > limit) {
      console.warn(`[abuse-controls] rate limit exceeded for ${userSub}: ${count}/${limit}`);
      return { allowed: false, remaining: 0, resetInMinutes };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), resetInMinutes };
  } catch (err: any) {
    console.warn('[abuse-controls] rate-limit check failed (fail-open):', err?.message);
    return { allowed: true, remaining: limit, resetInMinutes };
  }
}

/** The reply served when a user hits their hourly rate limit. */
export function rateLimitMessage(resetInMinutes: number): string {
  return (
    process.env.RATE_LIMIT_MESSAGE ||
    `You've reached your message limit for this hour. It resets in about ${resetInMinutes} minute${resetInMinutes === 1 ? '' : 's'}.`
  );
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
