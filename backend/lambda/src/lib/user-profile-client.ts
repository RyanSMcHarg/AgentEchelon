/**
 * User Profile Client (SPEC-USER-PROFILE-AND-ONBOARDING.md)
 *
 * A durable per-END-USER record (onboarded flag + collected onboarding facts), keyed by the person id
 * (their AppInstanceUser id, never a token `sub`).
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
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient, sessionDocumentClient } from './assistant-session.js';

export interface UserProfile {
  /** The person id: their AppInstanceUser id (partition key). */
  personId: string;
  /** ISO timestamp; PRESENCE means "already onboarded". Absent ⇒ never onboarded. */
  onboardedAt?: string;
  /** Collected onboarding answers, keyed by the intake field key (e.g. company, role). */
  facts?: Record<string, string>;
  /**
   * What the person asked for about how they are answered, as REGISTRY VALUE KEYS
   * (`lib/config/reply-preferences.ts`), never as their own words. Applied to every reply.
   */
  preferences?: Record<string, string>;
  updatedAt?: string;
}

const USER_PROFILE_TABLE = process.env.USER_PROFILE_TABLE || '';
const USER_PROFILE_SERVICE_ARN = process.env.USER_PROFILE_SERVICE_ARN || '';

let _ddb: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) _ddb = sessionDocumentClient({ requestHandler: BOUNDED_REQUEST_HANDLER });
  return _ddb;
}

let _lambda: LambdaClient | null = null;
function lambda(): LambdaClient {
  if (!_lambda) _lambda = sessionClient(LambdaClient, {});
  return _lambda;
}

// Cache of person ids known to be onboarded, held for a BOUNDED time rather than for the container's whole
// warm life. Only the POSITIVE result is cached; a not-yet-onboarded person is deliberately not, since the
// user may complete onboarding during that life.
//
// The original reasoning was that onboarding is monotonic - once true, always true - so a positive entry
// could never go stale in a way that matters. That holds only while nothing ever un-onboards a user, and
// things do: an operator resetting a profile, an erasure request, or a test restoring its precondition.
// This store is explicitly a stand-in for an implementer's own (SPEC-USER-PROFILE-AND-ONBOARDING), and a
// real one has deletion. With an unbounded entry the deletion is invisible for hours: the user is never
// re-onboarded, and nothing in the logs explains why - the handler simply reports "already onboarded"
// about a profile that no longer exists. That was observed directly, as a re-onboarding e2e that could
// only pass against a cold container.
//
// A TTL keeps the point of the cache (no repeat reads inside a burst of turns) while bounding how long
// a deletion can go unseen.
const ONBOARDED_CACHE_TTL_MS = 5 * 60_000;
/** person id -> epoch ms when the cached "onboarded" fact expires. */
const onboardedCache = new Map<string, number>();

/** True iff this person is cached as onboarded AND that entry has not expired. */
function cachedAsOnboarded(personId: string, now: number): boolean {
  const expiresAt = onboardedCache.get(personId);
  if (expiresAt === undefined) return false;
  if (expiresAt > now) return true;
  onboardedCache.delete(personId); // expired — re-read the store rather than trusting a stale yes
  return false;
}

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
export async function getUserProfile(personId: string): Promise<UserProfile | null> {
  if (!personId) return null;
  try {
    const ext = await delegate<UserProfile | null>('getUserProfile', { personId });
    if (ext.handled) return ext.data ?? null;

    if (!USER_PROFILE_TABLE) return null;
    const res = await ddb().send(new GetCommand({ TableName: USER_PROFILE_TABLE, Key: { personId } }));
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
export async function hasOnboarded(personId: string): Promise<boolean> {
  return (await onboardingStatus(personId)).onboarded;
}

/**
 * The once-per-user gate's answer, plus the stored facts the same read already returned.
 *
 * The welcome needs both: whether to run an intake at all, and - when it does - which fields the
 * person's stored profile already answers (`assertedBy: ['profile']`). One read serves both, so the
 * profile check costs nothing the gate was not already paying. `facts` is null whenever the answer
 * came from the positive cache, because an onboarded person is asked nothing and needs none.
 */
export async function onboardingStatus(
  personId: string,
): Promise<{ onboarded: boolean; facts: Record<string, string> | null; preferences?: Record<string, string> | null }> {
  if (!personId) return { onboarded: false, facts: null };
  const now = Date.now();
  if (cachedAsOnboarded(personId, now)) return { onboarded: true, facts: null };
  const profile = await getUserProfile(personId);
  const done = !!profile?.onboardedAt;
  if (done) onboardedCache.set(personId, now + ONBOARDED_CACHE_TTL_MS);
  else onboardedCache.delete(personId); // the store says no — drop any entry that says otherwise
  const facts = profile?.facts && typeof profile.facts === 'object' ? profile.facts : null;
  // The same read answers which preferences are already chosen, so a welcome does not offer one again.
  const preferences = profile?.preferences && typeof profile.preferences === 'object' ? profile.preferences : null;
  return { onboarded: done, facts, preferences };
}

/**
 * Record that a user finished onboarding, persisting the collected facts. Idempotent (last-write-wins).
 * Best-effort: a write failure is logged and swallowed — the intake already completed for THIS
 * conversation via sessionAttributes; the only cost of a lost write is a possible re-onboard next
 * conversation, which is strictly better than failing the user's turn.
 */
export async function markOnboarded(
  personId: string,
  facts: Record<string, string> = {},
  preferences: Record<string, string> = {},
): Promise<void> {
  if (!personId) return;
  const now = new Date().toISOString();
  try {
    const ext = await delegate('markOnboarded', { personId, facts, preferences, onboardedAt: now });
    if (!ext.handled) {
      if (!USER_PROFILE_TABLE) {
        console.warn('[user-profile] markOnboarded skipped: USER_PROFILE_TABLE unset and no service ARN');
        return;
      }
      // FACTS ONLY WHEN THERE ARE SOME. An onboarding that collected only a preference must not replace
      // the facts an earlier intake stored with an empty map.
      const hasFacts = Object.keys(facts).length > 0;
      await ddb().send(new UpdateCommand({
        TableName: USER_PROFILE_TABLE,
        Key: { personId },
        UpdateExpression: hasFacts
          ? 'SET onboardedAt = if_not_exists(onboardedAt, :now), facts = :facts, updatedAt = :now'
          : 'SET onboardedAt = if_not_exists(onboardedAt, :now), updatedAt = :now',
        ExpressionAttributeValues: hasFacts ? { ':now': now, ':facts': facts } : { ':now': now },
      }));
      // Preferences are MERGED, one key at a time, never replaced as a map: a person may have set one
      // with the update tool before this intake completed, and a whole-map write would erase it.
      for (const [key, value] of Object.entries(preferences)) {
        await writePreference(personId, key, value, now);
      }
    }
    onboardedCache.set(personId, Date.now() + ONBOARDED_CACHE_TTL_MS);
    if (Object.keys(preferences).length) preferencesCache.delete(personId);
  } catch (err) {
    console.warn('[user-profile] markOnboarded failed (non-fatal):', (err as Error).name);
  }
}

// ── REPLY PREFERENCES ──────────────────────────────────────────────────────────────────────────────
//
// Read on EVERY turn (the router attaches them to the dispatch), so a short cache keeps a burst of turns
// to one read. Short, because a person who changes a preference expects the next reply to follow it; the
// writer below clears this container's entry, and another container's entry ages out within the TTL.
const PREFERENCES_CACHE_TTL_MS = 30_000;
const preferencesCache = new Map<string, { at: number; value: Record<string, string> }>();

/** Test hook. */
export function __clearPreferencesCache(): void {
  preferencesCache.clear();
}

/**
 * The person's stored reply preferences, as stored (registry keys). Fail-open: a store error answers
 * `{}`, so a reply is never refused for want of a preference.
 */
export async function getReplyPreferences(personId: string): Promise<Record<string, string>> {
  if (!personId) return {};
  const hit = preferencesCache.get(personId);
  if (hit && Date.now() - hit.at < PREFERENCES_CACHE_TTL_MS) return hit.value;
  const profile = await getUserProfile(personId);
  const value = profile?.preferences && typeof profile.preferences === 'object' ? { ...profile.preferences } : {};
  preferencesCache.set(personId, { at: Date.now(), value });
  return value;
}

/** One preference, written as a nested map path so the rest of the record is never touched. */
async function writePreference(personId: string, key: string, value: string, now: string): Promise<void> {
  // Two writes because DynamoDB cannot SET a path under a map that does not exist yet: the first creates
  // the map only when absent, the second sets the one key. Both name only `preferences` and `updatedAt`,
  // which is all the assistant's write grant allows (`dynamodb:Attributes`).
  await ddb().send(new UpdateCommand({
    TableName: USER_PROFILE_TABLE,
    Key: { personId },
    UpdateExpression: 'SET preferences = if_not_exists(preferences, :empty), updatedAt = :now',
    ExpressionAttributeValues: { ':empty': {}, ':now': now },
  }));
  await ddb().send(new UpdateCommand({
    TableName: USER_PROFILE_TABLE,
    Key: { personId },
    UpdateExpression: 'SET preferences.#k = :v, updatedAt = :now',
    ExpressionAttributeNames: { '#k': key },
    ExpressionAttributeValues: { ':v': value, ':now': now },
  }));
}

/**
 * Set one reply preference for the person, as asked for in a conversation. The CALLER validates the key
 * and value against the registry; this writes what it is given. Returns false on failure so the caller
 * can say the change did not take rather than claim it did.
 */
export async function setReplyPreference(personId: string, key: string, value: string): Promise<boolean> {
  if (!personId || !key || !value) return false;
  try {
    const ext = await delegate('setReplyPreference', { personId, key, value });
    if (!ext.handled) {
      if (!USER_PROFILE_TABLE) return false;
      await writePreference(personId, key, value, new Date().toISOString());
    }
    preferencesCache.delete(personId);
    return true;
  } catch (err) {
    console.warn('[user-profile] setReplyPreference failed:', (err as Error).name);
    return false;
  }
}
