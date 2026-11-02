/**
 * A14 (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) — the analytics-query capability
 * partition, shared by the Lambda handlers (runtime enforcement) and the CDK
 * (per-capability API resources + role policies), so both read ONE map.
 *
 * A dependency-free data module (no `aws-cdk-lib`, no AWS SDK) so both the
 * bundled handler and the synth-time stack can import it.
 *
 * ## Why a partition
 *
 * The analytics API funnels ~30 `queryType`s through one `POST /`. To make a
 * capability IAM-enforceable per resource (so a persona role can be denied a
 * SPECIFIC data class at the gateway), each capability needs its own API
 * resource path, and the handler must reject a `queryType` that does not belong
 * to the capability whose resource it arrived on — otherwise a caller allowed
 * the low-sensitivity `view-analytics` resource could read A13 PII by naming a
 * user-activity `queryType` on it.
 *
 * ## The lossless split (SPEC section 4)
 *
 * `view-quality` (A6-A8, A10, A14, A15) and `view-analytics` (A9, A11, A12) have
 * the SAME persona column (Full / Scoped / Full / None), so bundling them on one
 * resource loses no persona distinction — they are one capability here,
 * `view-analytics`. The capabilities that DO differ get their own resource:
 *   - `view-events` (A3)          — Full / Full / Scoped / None
 *   - `view-user-activity` (A13)  — Full / Scoped / None / None   (PII)
 *   - `view-moderation-audit` (A5)— Full / Scoped / None / Scoped
 * `view-security` (A17) is the membership-audit + deployment routes, which are
 * already their own API resources (route-level, not a `queryType`).
 *
 * > **Deployer note:** this queryType→capability assignment is a REVIEWABLE
 * > default (SPEC section 2 implementer note). Moving a queryType to a finer
 * > capability only tightens access; adjust it for your roles.
 */

export type AnalyticsCapabilityKey =
  | 'view-events'
  | 'view-user-activity'
  | 'view-moderation-audit'
  | 'record-moderation'
  | 'triage-responses'
  | 'label-ground-truth'
  | 'view-analytics';

/**
 * Conversation CONTENT — a separable authorization from the aggregate bundle.
 *
 * `channel_events` is the complete raw event log (A3).
 *
 * `cross_conversation_context` is here because of what it RETURNS, not what it is named: the
 * conversation's summary and subject labels, for every conversation a named `userSub` has had. It was
 * never listed, so it fell to the default bundle - whose rule, three paragraphs down, is that its
 * reads "carry labels and counts, never message content". A query serving conversation content from
 * the low-sensitivity bundle is the accountability gap `view-messages` is exchange-vended to prevent,
 * arriving on a different plane.
 *
 * IT STAYS HERE AFTER MIGRATION 068, which removed the stored copy of the message: the row now holds
 * a classification and a message id, and the endpoint joins `conversation_summaries` for the text. A
 * model-written summary of a conversation is still that conversation's content, so the capability is
 * unchanged. What changed is that the content is read from the one place it lives rather than from a
 * duplicate nothing could redact.
 *
 * Moving a queryType to a finer capability only tightens access (the deployer note above), so this
 * cannot break a role that was correctly scoped.
 */
const VIEW_EVENTS_QUERIES = ['channel_events', 'cross_conversation_context'];

/** Identity / signup+signin funnels (A13, PII) — denied to AI dev + Manager. */
const VIEW_USER_ACTIVITY_QUERIES = [
  'user_activity',
  'active_users_daily',
  'active_messaging_users_daily',
  'messages_per_user',
  'messages_per_tier_daily',
  'signup_funnel_conversion',
  'signin_funnel_conversion',
  // The guest-to-customer funnel and the guest refusals (B12): who visited, registered and became a customer.
  'guest_to_customer_funnel',
  'guest_refusals',
];

/** Who redacted / deleted (A5). The attribution WRITE is its own capability, `record-moderation`. */
const VIEW_MODERATION_AUDIT_QUERIES = ['moderation_audit'];

/**
 * WRITES THAT RIDE A READ QUERY TYPE. A flag, a review verdict, a human label and a classifier
 * adjudication are each sent as the queryType of the read they belong to, with an `action` naming the
 * write. Each is its own capability on its own resource, so a role that may read quality data is not
 * thereby allowed to change it (SPEC-ADMIN-CONSOLE FR46).
 */
const WRITE_ACTIONS: Record<string, { actions: string[]; capability: AnalyticsCapabilityKey }> = {
  flagged_responses: { actions: ['flag', 'unflag', 'review'], capability: 'triage-responses' },
  ground_truth: { actions: ['submit'], capability: 'label-ground-truth' },
  // Nominating, retiring and promoting a golden-set entry are the same act as a label: a person deciding
  // what a good answer is (SPEC-EVALUATION FR16).
  golden_set: { actions: ['nominate', 'retire', 'promote'], capability: 'label-ground-truth' },
};

/** Writes that are a queryType of their own. */
const WRITE_QUERIES: Record<string, AnalyticsCapabilityKey> = {
  record_moderation: 'record-moderation',
  classifier_replay_adjudicate: 'label-ground-truth',
};

/**
 * queryType → capability. Anything NOT listed falls to `view-analytics` (the
 * low-sensitivity aggregate bundle: volumes, models, evaluations, intents,
 * latency, drift, flags, tasks, experiments, perf/health). Default-to-bundle is
 * deliberate: a new low-sensitivity query needs no map change, and a new
 * SENSITIVE query is a conscious addition here.
 *
 * DECIDED, not defaulted: the classification shadow gate's queries (`classifier_replay*`) stay in
 * `view-analytics`. Its adjudication write is the same act as the ground-truth score already served
 * there — a human recording a judgement for evaluation, attributed from the JWT — and its reads
 * carry labels and counts, never message content. Starting a replay does spend real model calls, so
 * it is the one that could argue for its own capability; it is held to the same bundle as the
 * evaluation surfaces it belongs to, and the cap on that spend is the run's own message limit.
 */
export const ANALYTICS_QUERY_CAPABILITY: Record<string, AnalyticsCapabilityKey> = Object.fromEntries([
  ...VIEW_EVENTS_QUERIES.map((q) => [q, 'view-events'] as const),
  ...VIEW_USER_ACTIVITY_QUERIES.map((q) => [q, 'view-user-activity'] as const),
  ...VIEW_MODERATION_AUDIT_QUERIES.map((q) => [q, 'view-moderation-audit'] as const),
]);

export const DEFAULT_ANALYTICS_CAPABILITY: AnalyticsCapabilityKey = 'view-analytics';

/** The capability a `queryType` requires, given the `action` it carries when it is a write. */
export function capabilityForQueryType(queryType: string, action?: string): AnalyticsCapabilityKey {
  if (WRITE_QUERIES[queryType]) return WRITE_QUERIES[queryType];
  const write = WRITE_ACTIONS[queryType];
  if (write && action && write.actions.includes(action)) return write.capability;
  return ANALYTICS_QUERY_CAPABILITY[queryType] ?? DEFAULT_ANALYTICS_CAPABILITY;
}

/**
 * The API resource path (under the analytics API root) that a capability is
 * IAM-authorized on. `view-analytics` is the root `POST /` (empty path); the
 * others are dedicated sub-paths. The CDK builds a resource + AWS_IAM authorizer
 * per non-root path; the handler maps `event.path` back to the capability.
 */
export const ANALYTICS_CAPABILITY_PATH: Record<AnalyticsCapabilityKey, string> = {
  'view-analytics': '',
  'view-events': 'events-log',
  'view-user-activity': 'user-activity',
  'view-moderation-audit': 'moderation-audit',
  'record-moderation': 'moderation-record',
  'triage-responses': 'triage',
  'label-ground-truth': 'ground-truth',
};

/** All non-root capability paths (the resources the CDK must create). */
export const ANALYTICS_CAPABILITY_SUBPATHS: Array<{ capability: AnalyticsCapabilityKey; path: string }> =
  (Object.entries(ANALYTICS_CAPABILITY_PATH) as Array<[AnalyticsCapabilityKey, string]>)
    .filter(([, p]) => p !== '')
    .map(([capability, path]) => ({ capability, path }));

/**
 * Which capability an inbound analytics request is authorized as, from its path.
 * A path ending in a known sub-path is that capability; anything else (the root
 * `POST /`) is `view-analytics`.
 */
export function capabilityForPath(path: string): AnalyticsCapabilityKey {
  for (const { capability, path: sub } of ANALYTICS_CAPABILITY_SUBPATHS) {
    if (path === `/${sub}` || path.endsWith(`/${sub}`)) return capability;
  }
  return DEFAULT_ANALYTICS_CAPABILITY;
}

/**
 * A `queryType` may run on a resource ONLY if the resource's capability is the
 * one the queryType requires — so the gateway's per-resource IAM grant is the
 * real control. Every analytics route is IAM-authorized, so this always applies.
 */
export function queryTypeAllowedOnPath(queryType: string, path: string, action?: string): boolean {
  return capabilityForQueryType(queryType, action) === capabilityForPath(path);
}
