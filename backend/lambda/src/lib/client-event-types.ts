/**
 * Source of truth for the client-events allow-list.
 *
 * Imported by:
 *   - `backend/lambda/src/client-events.ts` (runtime gate — rejects
 *     unknown event types so the partition key cannot be polluted)
 *   - `backend/lib/stacks/analytics-stack.ts` (Glue table projection
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
 *   2. Add the matching `emit('...')` call in
 *      `frontend/src/services/eventTrackingService.ts` (the EventName
 *      union — TypeScript will surface any mismatch).
 *   3. `cdk deploy AgentEchelonAnalytics` to refresh the Glue projection.
 *
 * Steps 1+2 stay in sync via TypeScript; step 3 is the only thing a
 * deployer can forget — and forgetting now produces a query-time "no
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
  // Operational
  'error',
] as const;

export type ClientEventType = (typeof VALID_EVENT_TYPES)[number];

/**
 * Additional Firehose partitions that are NOT in the allow-list but
 * must appear in the Glue projection enum so Athena can query them:
 *
 *   - `performance`: web-vital records (TTFB/FCP/LCP/INP/CLS + arbitrary
 *     timer labels) land under this partition; their `metric` column
 *     carries the free-form name.
 *   - `unknown`: Firehose MetadataExtraction's `// "unknown"` fallback
 *     for any record without a partitionKey. Unreachable via the
 *     Lambda allow-list (every accepted event sets `partitionKey`); but
 *     if a record arrives via direct-Kinesis-IAM access or a future
 *     ingestion path, it lands here. A 7-day S3 lifecycle on this
 *     partition (audit L1) bounds cost.
 */
export const PARTITION_FALLBACKS = ['performance', 'unknown'] as const;

/** Combined values for the Athena Glue partition projection. */
export const ALL_PARTITION_VALUES: readonly string[] = [
  ...VALID_EVENT_TYPES,
  ...PARTITION_FALLBACKS,
];
