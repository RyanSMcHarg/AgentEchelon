/**
 * Source of truth for the client-events allow-list.
 *
 * Imported by:
 *   - `backend/lambda/src/client-events.ts` (runtime gate — rejects
 *     unknown event types so the partition key cannot be polluted)
 *   - `backend/lib/stacks/archive-stack.ts` (Glue table projection
 *     enum values — Athena partition projection must enumerate the same
 *     set; otherwise queries that legitimately span all event_types
 *     would miss new partitions silently)
 *
 * This module is the single source of truth for the event-type list, so the
 * Lambda allow-list and the CDK partition projection can't drift apart.
 * Adding an event type to the Lambda allow-list without a parallel CDK
 * redeploy = the new event_type lands in S3 under a partition the Glue
 * projection doesn't enumerate = the rows exist but never appear in any
 * Athena query result. Silent analytics data loss. The shared module
 * eliminates the drift mode entirely.
 *
 * Adding a new event type:
 *   1. Add its name (snake_case) to VALID_EVENT_TYPES below.
 *   2. Add it to the EventName union in
 *      `frontend/packages/shared/src/services/eventTrackingService.ts`.
 *   3. `cd backend && npm run deploy:stack -- <prefix>Archive` to refresh the Glue projection.
 *
 * Steps 1+2 are held in sync by `backend/test/every-client-event-is-accepted.test.ts`, which also
 * checks every literal `trackEvent('...')` the frontend sends: `trackEvent` takes any string, so
 * TypeScript does not. Step 3 is the only thing a deployer can forget — and forgetting now produces a query-time "no
 * data" instead of a silent partition-drop, because the projection list
 * is the same constant in both places.
 */

/** All accepted client-event types. */
export const VALID_EVENT_TYPES = [
  // Auth funnel — signup
  'signup_form_viewed',
  'signup_field_validation_error',
  'signup_submitted',
  'signup_confirmation_required',
  'signup_confirmation_completed',
  'signup_failed',
  // Auth funnel — signin
  'signin_form_viewed',
  'signin_submitted',
  'signin_succeeded',
  'signin_failed',
  'signin_password_reset_initiated',
  // Auth lifecycle
  'login',
  'logout',
  'session_started',
  // Connection
  'websocket_connected',
  'websocket_disconnected',
  'websocket_reconnected',
  // Usage
  'conversation_created',
  'message_sent',
  'message_received',
  'channel_messages_listed',
  'file_uploaded',
  'tab_switched',
  'admin_tab_viewed',
  // Admin actions (emitted client-side by the admin console, adminChime.ts)
  'admin_message_redacted',
  'admin_message_deleted',
  'admin_member_added',
  'admin_member_removed',
  'admin_conversation_deleted',
  // Operational
  'error',
] as const;

export type ClientEventType = (typeof VALID_EVENT_TYPES)[number];

/**
 * All accepted client PERFORMANCE metric names - the `metric` on a record in the `performance` array.
 *
 * WHY THIS IS A CLOSED SET. A timing's name becomes the `event_type` of its row and the GROUP BY key of
 * the page-load panel, and `client_ttff_ms` is joined to the server's own TTFF for the same turn. With
 * the name free-form, any signed-in client could invent rows under any name (unbounded cardinality in
 * a panel an operator reads) or post `client_ttff_ms` rows of its own choosing and skew the
 * client/server latency comparison. So a name not declared here is rejected, and counted.
 *
 * MIRRORED, NOT IMPORTED, by the `PerfMetricName` union in
 * `frontend/packages/shared/src/services/eventTrackingService.ts`: a browser bundle cannot import
 * backend source. `test/client-perf-metrics-match-the-emitter.test.ts` fails when the two disagree.
 *
 * Adding a metric: add it here, add it to that union, and declare its properties below (none is a
 * valid declaration). Perf records all share the `performance` partition, so no CDK change is needed.
 */
export const VALID_PERF_METRICS = [
  // Web vitals (web-vitals library, captured once per page load)
  'web_vital_lcp',
  'web_vital_inp',
  'web_vital_cls', // CLS x 1000, so the column stays numeric
  'web_vital_fcp',
  'web_vital_ttfb',
  // Perceived latency, measured in the browser (messageLatencyTracker.ts)
  'message_round_trip_ms',
  'client_ttff_ms',
] as const;

export type ClientPerfMetric = (typeof VALID_PERF_METRICS)[number];

/** The shape one declared property value must have to be kept. */
export interface PerfPropertyRule {
  type: 'string';
  /** Whole-value match. Bounds length as well as alphabet, so a property cannot carry a payload. */
  pattern: RegExp;
}

/**
 * The properties each metric may carry, and nothing else. A key not declared for the metric, or a value
 * that does not match its rule, is DROPPED (the timing itself is kept) and counted.
 *
 * `correlationId` is the turn id a placeholder declares, so it takes exactly the bounded character
 * class the placeholder marker grammar uses (`<!--corr:([A-Za-z0-9._-]{1,64})-->`). Anything wider
 * could not have come from a real placeholder.
 */
export const PERF_METRIC_PROPERTIES: Readonly<Record<ClientPerfMetric, Readonly<Record<string, PerfPropertyRule>>>> = {
  web_vital_lcp: {},
  web_vital_inp: {},
  web_vital_cls: {},
  web_vital_fcp: {},
  web_vital_ttfb: {},
  message_round_trip_ms: {},
  client_ttff_ms: {
    correlationId: { type: 'string', pattern: /^[A-Za-z0-9._-]{1,64}$/ },
  },
};

/**
 * The largest perf value accepted, in the metric's unit (milliseconds; CLS x 1000). An hour is far past
 * any real wait or paint, and a single absurd value would otherwise move every average it lands in.
 */
export const PERF_VALUE_MAX = 60 * 60 * 1000;

/**
 * Additional Firehose partitions that are NOT in the allow-list but
 * must appear in the Glue projection enum so Athena can query them:
 *
 *   - `performance`: web-vital and perceived-latency records land under
 *     this partition; their `metric` column carries a name from
 *     VALID_PERF_METRICS.
 *   - `unknown`: Firehose MetadataExtraction's `// "unknown"` fallback
 *     for any record without a partitionKey. Unreachable via the
 *     Lambda allow-list (every accepted event sets `partitionKey`); but
 *     if a record arrives via direct-Kinesis-IAM access or a future
 *     ingestion path, it lands here. A 7-day S3 lifecycle on this
 *     partition (audit L1) bounds cost.
 */
export const PARTITION_FALLBACKS = ['performance', 'unknown'] as const;

/**
 * Event types THE PLATFORM writes to the same archive, never accepted from a client: the client-events
 * allow-list above does not hold them, so no browser can forge one. `offboarding` is the record of one
 * completed offboarding (`lib/offboarding.ts`).
 */
//
// `export` is the record of one completed export of a person's records (`lib/person-export.ts`), and the rest
// are the guest-to-customer funnel's server stages (`RECORDED_FUNNEL_STAGES`, `lib/funnel.ts`).
export const SERVER_EVENT_TYPES = ['offboarding', 'export', 'guest_started', 'guest_refused', 'claim_sent', 'claim_redeemed', 'guest_bound'] as const;
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

/** Combined values for the Athena Glue partition projection. */
export const ALL_PARTITION_VALUES: readonly string[] = [
  ...VALID_EVENT_TYPES,
  ...SERVER_EVENT_TYPES,
  ...PARTITION_FALLBACKS,
];
