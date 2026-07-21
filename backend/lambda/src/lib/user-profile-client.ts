/**
 * User Profile Client (SPEC-USER-PROFILE-AND-ONBOARDING.md)
 *
 * A durable per-END-USER record (onboarded flag + collected onboarding facts), keyed by Cognito sub.
 * "User profile" here is the per-user context record — NOT the assistant capability-"profile" of
 * SPEC-PER-PROFILE-OWNERSHIP.
 *
 * This is a REFERENCE STAND-IN, not a system of record. Two backends behind one interface:
 *   - Built-in (default): a DynamoDB table named by USER_PROFILE_TABLE.
 *   - Implementer's own: when USER_PROFILE_SERVICE_ARN is set, calls are delegated to that Lambda
 *     ({ operation, params } → { success, data }), so a deployment points AgentEchelon at its existing
 *     profile store without a code change. The built-in table then goes unused.
 *
 * The interface is intentionally tiny (read + mark-onboarded). The router uses it to make onboarding
 * fire ONCE per user: gate the intake on `onboardedAt`, and set it (plus facts) when the intake
 * completes. All reads FAIL OPEN (return null) so a store outage degrades to "start the intake"
 * rather than erroring the turn.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface UserProfile {
  /** Cognito sub (partition key). */
  userSub: string;
  /** ISO timestamp; PRESENCE means "already onboarded". Absent ⇒ never onboarded. */
  onboardedAt?: string;
  /** Collected onboarding answers, keyed by the intake field key (e.g. company, role). */
  facts?: Record<string, string>;
  updatedAt?: string;
}

const USER_PROFILE_TABLE = process.env.USER_PROFILE_TABLE || '';
const USER_PROFILE_SERVICE_ARN = process.env.USER_PROFILE_SERVICE_ARN || '';

let _ddb: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _ddb;
}

let _lambda: LambdaClient | null = null;
function lambda(): LambdaClient {
  if (!_lambda) _lambda = new LambdaClient({});
  return _lambda;
}

// Warm-life cache of subs known to be onboarded. Onboarding is monotonic (once true, always true), so
// caching only the POSITIVE result is safe and never goes stale in a way that matters: it can only skip
// a re-onboard, which is exactly the goal. A not-yet-onboarded sub is deliberately NOT cached (the user
// may complete onboarding during the Lambda's warm life).
const onboardedCache = new Set<string>();

/** Test hook: clear the warm onboarded cache. */
export function __clearUserProfileCache(): void {
  onboardedCache.clear();
}

/**
 * Delegate to an implementer's profile service when USER_PROFILE_SERVICE_ARN is set.
 * Returns `{ handled: false }` when no external service is configured, so the caller runs the built-in
 * DynamoDB path. Any delegation error is treated as fail-open by the caller.
 */
async function delegate<T>(operation: string, params: Record<string, unknown>): Promise<{ handled: boolean; data?: T }> {
  if (!USER_PROFILE_SERVICE_ARN) return { handled: false };
  const resp = await lambda().send(new InvokeCommand({
    FunctionName: USER_PROFILE_SERVICE_ARN,
    Payload: Buffer.from(JSON.stringify({ operation, params })),
  }));
  if (resp.FunctionError) {
    throw new Error(`user-profile-service ${operation} error: ${resp.FunctionError}`);
  }
  const raw = resp.Payload ? new TextDecoder().decode(resp.Payload) : '';
  const parsed = raw ? (JSON.parse(raw) as { success?: boolean; data?: T; error?: string }) : {};
  if (parsed.success === false) throw new Error(parsed.error || `user-profile-service ${operation} failed`);
  return { handled: true, data: parsed.data };
}

/**
 * Fetch a user's profile, or null when there is none / the store is unavailable.
 * Fail-open: any store error returns null (⇒ the caller treats the user as not-yet-onboarded).
 */
export async function getUserProfile(userSub: string): Promise<UserProfile | null> {
  if (!userSub) return null;
  try {
    const ext = await delegate<UserProfile | null>('getUserProfile', { userSub });
    if (ext.handled) return ext.data ?? null;

    if (!USER_PROFILE_TABLE) return null;
    const res = await ddb().send(new GetCommand({ TableName: USER_PROFILE_TABLE, Key: { userSub } }));
    return (res.Item as UserProfile | undefined) ?? null;
  } catch (err) {
    console.warn('[user-profile] getUserProfile failed (fail-open → null):', (err as Error).name);
    return null;
  }
}

/**
 * True iff the user has completed onboarding. Fail-open: on any store error returns false so the
 * onboarding intake still runs (today's behavior) rather than being wrongly skipped.
 */
export async function hasOnboarded(userSub: string): Promise<boolean> {
  if (!userSub) return false;
  if (onboardedCache.has(userSub)) return true;
  const profile = await getUserProfile(userSub);
  const done = !!profile?.onboardedAt;
  if (done) onboardedCache.add(userSub);
  return done;
}

/**
 * Record that a user finished onboarding, persisting the collected facts. Idempotent (last-write-wins).
 * Best-effort: a write failure is logged and swallowed — the intake already completed for THIS
 * conversation via sessionAttributes; the only cost of a lost write is a possible re-onboard next
 * conversation, which is strictly better than failing the user's turn.
 */
export async function markOnboarded(userSub: string, facts: Record<string, string> = {}): Promise<void> {
  if (!userSub) return;
  const now = new Date().toISOString();
  try {
    const ext = await delegate('markOnboarded', { userSub, facts, onboardedAt: now });
    if (!ext.handled) {
      if (!USER_PROFILE_TABLE) {
        console.warn('[user-profile] markOnboarded skipped: USER_PROFILE_TABLE unset and no service ARN');
        return;
      }
      await ddb().send(new UpdateCommand({
        TableName: USER_PROFILE_TABLE,
        Key: { userSub },
        UpdateExpression: 'SET onboardedAt = if_not_exists(onboardedAt, :now), facts = :facts, updatedAt = :now',
        ExpressionAttributeValues: { ':now': now, ':facts': facts },
      }));
    }
    onboardedCache.add(userSub);
  } catch (err) {
    console.warn('[user-profile] markOnboarded failed (non-fatal):', (err as Error).name);
  }
}
