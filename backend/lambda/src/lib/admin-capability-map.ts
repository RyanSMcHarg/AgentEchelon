/**
 * A14 (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md) — the analytics-query capability
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
  | 'view-analytics';

/** The complete raw event log (A3) — its own capability. */
const VIEW_EVENTS_QUERIES = ['channel_events'];

/** Identity / signup+signin funnels (A13, PII) — denied to AI dev + Manager. */
const VIEW_USER_ACTIVITY_QUERIES = [
  'user_activity',
  'active_users_daily',
  'active_messaging_users_daily',
  'messages_per_user',
  'messages_per_tier_daily',
  'signup_funnel_conversion',
  'signin_funnel_conversion',
];

/** Who redacted / deleted, and the moderation-attribution write (A5). */
const VIEW_MODERATION_AUDIT_QUERIES = ['record_moderation', 'moderation_audit'];

/**
 * queryType → capability. Anything NOT listed falls to `view-analytics` (the
 * low-sensitivity aggregate bundle: volumes, models, evaluations, intents,
 * latency, drift, flags, tasks, experiments, perf/health). Default-to-bundle is
 * deliberate: a new low-sensitivity query needs no map change, and a new
 * SENSITIVE query is a conscious addition here.
 */
export const ANALYTICS_QUERY_CAPABILITY: Record<string, AnalyticsCapabilityKey> = Object.fromEntries([
  ...VIEW_EVENTS_QUERIES.map((q) => [q, 'view-events'] as const),
  ...VIEW_USER_ACTIVITY_QUERIES.map((q) => [q, 'view-user-activity'] as const),
  ...VIEW_MODERATION_AUDIT_QUERIES.map((q) => [q, 'view-moderation-audit'] as const),
]);

export const DEFAULT_ANALYTICS_CAPABILITY: AnalyticsCapabilityKey = 'view-analytics';

/** The capability a `queryType` requires. */
export function capabilityForQueryType(queryType: string): AnalyticsCapabilityKey {
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
 * real control. Enforce this only under IAM enforcement (single-plane Cognito
 * mode keeps the queryType free on the one root resource, gated by the group).
 */
export function queryTypeAllowedOnPath(queryType: string, path: string): boolean {
  return capabilityForQueryType(queryType) === capabilityForPath(path);
}
