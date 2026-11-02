/**
 * Analytics Query Lambda (Athena mode)
 *
 * Runs Athena queries against the Glue catalog and returns results
 * for the admin dashboard. Queries conversation archives and
 * evaluation results stored in S3 via the Kinesis/Firehose pipeline.
 *
 * Response shape:
 *   200 { data: [...], columns: [...] }                                  // served
 *   200 { data: [], columns: [], unsupported: true, reason: '...' }      // honest empty
 *   400 { error: '...' }                                                  // bad request / unknown queryType
 *   500 { error: '...' }                                                  // server error
 *
 * The "honest empty" 200 lets the admin dashboard distinguish a tab that
 * is dark for an architectural reason (Aurora-only feature deployed in
 * Athena mode) from a tab that is empty because no data was ingested or
 * because the Athena query genuinely returned zero rows. Without this,
 * tabs render as silently empty and users assume the pipeline is broken.
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { parseJsonBody, requireAdmin, isAdminIamEnforcedCall } from './lib/auth';
import { responder } from './lib/http-response';
import { queryTypeAllowedOnPath } from './lib/admin-capability-map';
import { scopeForRequest, scopeAnalyticsRows } from './lib/caller-scope';
import { RECORDED_FUNNEL_STAGES } from './lib/funnel-stages';
import { SIGNIN_FUNNEL, SIGNUP_FUNNEL, type SessionFunnel } from './lib/session-funnels';
import { loadProfileRegistry } from '../../lib/profile-registry';

const athena = new AthenaClient({});
const WORKGROUP = process.env.ATHENA_WORKGROUP || 'agent-echelon-analytics';
const DATABASE = process.env.ATHENA_DATABASE || 'agent_echelon';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
// A14 Scoped: the pool the caller's classification scope is resolved against.
const USER_POOL_ID = process.env.USER_POOL_ID || '';

// ---------------------------------------------------------------------------
// Query-type categorisation
// ---------------------------------------------------------------------------
// `SUPPORTED` queries have a buildQuery() case below and are runnable against
// the current Glue schema (`conversations` + `evaluation_results`).
//
// `AURORA_ONLY` queries are real features in Aurora mode but fundamentally
// require Postgres/pgvector/joins that Athena cannot serve from the flat S3
// archive. They return 200 + unsupported so the dashboard can show a clear
// "Aurora-only" banner instead of a silently-empty table.
//
// Any queryType not in either set is genuinely unknown and gets a 400 —
// surfaces typos and version skew between FE and BE.
//
// Future: queries that the contract requires Athena to serve but the current
// Glue schema can't satisfy without column work (model_usage→model_name,
// user_activity→person_id, latency_metrics→avg_total_ms) will move into a
// third "pending schema" set with its own honest-empty reason. They're left
// in SUPPORTED for now because the queries do execute and return a
// degraded-but-non-zero result — the dashboard shows a no-data banner
// instead of an unsupported banner, which is misleading but not silent.
// Tracked as a follow-up to brick 4 once the Glue table is reshaped.
// ---------------------------------------------------------------------------

const SUPPORTED_TYPES = new Set<string>([
  'conversation_volumes',
  'model_usage',
  'evaluation_scores',
  // A delivered document's own scores, by intent and task type (SPEC-EVALUATION FR22).
  'document_evaluation',
  'intent_distribution',
  'user_activity',
  'latency_metrics',
  // Client events — population requires the /events ingestion path + the
  // client_events Glue table. Until traffic flows the queries
  // return empty result sets which the dashboard renders honestly.
  'active_users_daily',
  'active_messaging_users_daily',
  'messages_per_user',
  'messages_per_tier_daily',
  'error_rate_daily',
  'signup_funnel_conversion',
  'signin_funnel_conversion',
  // The guest-to-customer funnel (B12): server stages the platform appends to the same table.
  'guest_to_customer_funnel',
  'guest_refusals',
  'page_load_metrics',
  'connection_health_daily',
]);

const AURORA_ONLY_TYPES = new Set<string>([
  'evaluation_exchanges',
  'evaluation_flows',
  'evaluation_flow_detail',
  'flagged_responses',
  'ground_truth',
  'task_metrics',
  'task_details',
  'task_timeline',
  'intent_effectiveness',
  'intent_exchanges',
  // An intent's step and model breakdown (ADR-064) reads the Aurora columns task_step and steps[]; not built for Athena.
  'intent_steps',
  // Per-turn evidence behind one row of the latency breakdown: exchanges joined to the turn ledger,
  // both Aurora-side.
  'latency_exchanges',
  // Thumbs live in DynamoDB but the reply they name lives in Aurora, so the join is Aurora-side.
  'user_ratings',
  'conversation_summaries',
  'drift_events',
  'cross_conversation_context',
  'model_effectiveness',
  'experiment_results',
  // ── THE LATENCY TAB'S THREE, WHICH WERE IN NEITHER SET (code review, 2026-09-09) ──────────────
  //
  // `latency_by_interaction`, `client_server_latency` and `router_steps` are served only by the
  // Aurora query registry, but they were never listed here - so in Athena mode they fell past this
  // check to the "genuinely unknown queryType" 400 below. The console rendered that raw error string
  // in a red `role="alert"`, on a tab whose own banner promises those cards "will stay empty - that
  // is the deployment mode, not a system with no traffic". An operator was told the opposite of what
  // the page above it said.
  //
  // Listing them makes the unsupported answer the honest one this file already had.
  'latency_by_interaction',
  'client_server_latency',
  'router_steps',
  // Same reason, one panel later: the turn-kind breakdown reads a column the Aurora projection owns,
  // so in Athena mode the honest answer is "this view requires Aurora" and not a raw unknown-type 400.
  'turn_kinds',
  // The derived-path-versus-ledger shadow diff compares two Aurora-side derivations of one turn, so
  // Athena mode has neither side to compare.
  'turn_latency_shadow_diff',
  // Reads exchanges, drift events and summary versions, all Aurora-side.
  'unserved_subjects',
]);

const AURORA_REASON =
  'This view requires analyticsMode=aurora (Postgres + pgvector). Currently running in Athena mode.';

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
// Dates are interpolated directly into Athena SQL (the AWS SDK has no
// parameterised-query API for StartQueryExecution). Without strict format
// validation a hostile caller could inject SQL via the dateRange fields.
// Cognito Authorizer gates the API but defense in depth: the admin tier
// trusts the *user* not the *payload*.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!ISO_DATE.test(value)) return null;
  // Reject impossible dates (2024-13-99) by round-tripping through Date.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const http = responder({ origin: { fixed: ALLOWED_ORIGIN }, methods: 'POST,OPTIONS' });

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return http.respond(statusCode, body);
}

function unsupportedResponse(reason: string): APIGatewayProxyResult {
  return respond(200, {
    data: [],
    columns: [],
    unsupported: true,
    reason,
  });
}

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------

/**
 * A SESSION-ORDERED FUNNEL (`lib/session-funnels.ts`), the Athena twin of the Aurora mode's
 * `getFunnelConversion`: each step counted among the sessions that recorded the entry step at or before
 * it, so every step is a subset of the entry step and a conversion read off it stays within 100% by
 * construction. A session that recorded a step with no entry step before it is returned apart as
 * `sessions_outside_funnel`. The event time is the ISO-8601 `timestamp` the ingestion stamps, which
 * orders as a string. The steps are a fixed internal list, never input.
 */
function sessionFunnelSql(funnel: SessionFunnel, startDate: string, endDate: string): string {
  const inList = funnel.steps.map((st) => `'${st}'`).join(', ');
  const orderCase = funnel.steps.map((st, i) => `WHEN '${st}' THEN ${i + 1}`).join(' ');
  return `
        WITH ev AS (
          SELECT session_id, event_type, "timestamp" as at
          FROM client_events
          WHERE event_type IN (${inList})
            AND session_id IS NOT NULL
            AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        ),
        entered AS (
          SELECT session_id, MIN(at) as entered_at
          FROM ev
          WHERE event_type = '${funnel.entryStep}'
          GROUP BY session_id
        )
        SELECT
          ev.event_type as step,
          COUNT_IF(ev.at >= entered.entered_at) as event_count,
          COUNT(DISTINCT CASE WHEN ev.at >= entered.entered_at THEN ev.session_id END) as session_count,
          COUNT(DISTINCT ev.session_id)
            - COUNT(DISTINCT CASE WHEN ev.at >= entered.entered_at THEN ev.session_id END) as sessions_outside_funnel
        FROM ev
        LEFT JOIN entered ON entered.session_id = ev.session_id
        GROUP BY ev.event_type
        ORDER BY CASE ev.event_type ${orderCase} ELSE 99 END
      `;
}

function buildQuery(queryType: string, startDate: string, endDate: string, journey?: string): string | null {
  switch (queryType) {
    case 'conversation_volumes':
      return `
        SELECT year, month, day, user_type, COUNT(*) as message_count
        FROM conversations
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY year, month, day, user_type
        ORDER BY year, month, day
      `;

    case 'model_usage':
      // NOTE: aggregates by partition key only; the underlying line column
      // is unparsed. Real model breakdown blocked on Glue schema work.
      return `
        SELECT user_type, COUNT(*) as message_count
        FROM conversations
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY user_type
        ORDER BY message_count DESC
      `;

    case 'evaluation_scores':
      // Aliases match EvaluationScoreData in frontend/src/types/analytics.ts
      // so the EvaluationsTab can render without a translation layer. The
      // evaluation_results table is JsonSerDe with proper columns, so the
      // camelCase refs resolve (Athena lowercases the SerDe field map but
      // the projection keeps the alias names intact).
      return `
        SELECT
          CONCAT(year,'-',month,'-',day) as date,
          agentType as assistant,
          intentType as intent_type,
          AVG(CAST(relevanceScore AS DOUBLE)) as avg_relevance_score,
          COUNT(*) as count
        FROM evaluation_results
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
          -- REPLIES ONLY. A delivered document is graded in a row of its own (SPEC-EVALUATION FR22)
          -- and read by document_evaluation; NULL is a row written before the column, which was a reply.
          AND COALESCE(evaluationType, 'exchange') = 'exchange'
        GROUP BY year, month, day, agentType, intentType
        ORDER BY year, month, day, assistant
      `;

    case 'document_evaluation':
      // A DELIVERED DOCUMENT'S OWN SCORES (SPEC-EVALUATION FR22), by intent and by task type, the same
      // two dimensions and column names Aurora mode returns, as far as this mode records them: the
      // relevance score and whether it was graded. Groundedness and compliance are not judged in Athena
      // mode, for documents or replies, so their columns are absent rather than zero. The reply's
      // relevance on the same exchanges travels beside the document's and is never averaged with it.
      return `
        WITH docs AS (
          SELECT exchangeId, intentType,
                 COALESCE(NULLIF(documentKind, ''), 'document') AS task_type,
                 evaluationType, skipReason, relevanceScore
          FROM evaluation_results
          WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
            AND evaluationType IN ('document', 'document_skipped')
        ),
        replies AS (
          SELECT exchangeId, MAX(relevanceScore) AS reply_relevance
          FROM evaluation_results
          WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
            AND COALESCE(evaluationType, 'exchange') = 'exchange'
          GROUP BY exchangeId
        ),
        joined AS (
          SELECT d.*, r.reply_relevance FROM docs d LEFT JOIN replies r ON r.exchangeId = d.exchangeId
        )
        SELECT 'intent' AS dimension, intentType AS group_key,
               COUNT(*) AS documents_delivered,
               COUNT_IF(evaluationType = 'document') AS documents_scored,
               COUNT_IF(evaluationType = 'document_skipped') AS documents_skipped,
               COUNT_IF(skipReason = 'private') AS skipped_private,
               COUNT_IF(skipReason = 'not-archived') AS skipped_not_archived,
               COUNT_IF(skipReason = 'hash-mismatch') AS skipped_hash_mismatch,
               COUNT_IF(skipReason = 'too-long') AS skipped_too_long,
               COUNT_IF(skipReason = 'empty') AS skipped_empty,
               COUNT_IF(skipReason = 'unreadable') AS skipped_unreadable,
               ROUND(AVG(CASE WHEN evaluationType = 'document' THEN CAST(relevanceScore AS DOUBLE) END), 1) AS doc_avg_relevance,
               ROUND(AVG(CAST(reply_relevance AS DOUBLE)), 1) AS reply_avg_relevance,
               COUNT(reply_relevance) AS reply_scored_count
        FROM joined GROUP BY intentType
        UNION ALL
        SELECT 'task_type' AS dimension, task_type AS group_key,
               COUNT(*) AS documents_delivered,
               COUNT_IF(evaluationType = 'document') AS documents_scored,
               COUNT_IF(evaluationType = 'document_skipped') AS documents_skipped,
               COUNT_IF(skipReason = 'private') AS skipped_private,
               COUNT_IF(skipReason = 'not-archived') AS skipped_not_archived,
               COUNT_IF(skipReason = 'hash-mismatch') AS skipped_hash_mismatch,
               COUNT_IF(skipReason = 'too-long') AS skipped_too_long,
               COUNT_IF(skipReason = 'empty') AS skipped_empty,
               COUNT_IF(skipReason = 'unreadable') AS skipped_unreadable,
               ROUND(AVG(CASE WHEN evaluationType = 'document' THEN CAST(relevanceScore AS DOUBLE) END), 1) AS doc_avg_relevance,
               ROUND(AVG(CAST(reply_relevance AS DOUBLE)), 1) AS reply_avg_relevance,
               COUNT(reply_relevance) AS reply_scored_count
        FROM joined GROUP BY task_type
        ORDER BY dimension, documents_delivered DESC
      `;

    case 'intent_distribution':
      return `
        SELECT user_type as intent, COUNT(*) as count
        FROM conversations
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY user_type
      `;

    case 'user_activity':
      // NOTE: the conversations Glue table has no person_id column; aggregates by
      // user_type partition only, which holds the conversation's
      // classification. Real per-user activity blocked on Glue schema work.
      return `
        SELECT user_type AS classification, COUNT(*) as messages,
               COUNT(DISTINCT day) as active_days
        FROM conversations
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY user_type
      `;

    case 'latency_metrics':
      // NOTE: no latency columns in the current Glue schema; returns
      // request counts only. Real latency breakdown blocked on either
      // client-events ingestion or json_extract_scalar over
      // the line column. Until then the LatencyTab will render with
      // zeroed cards and an empty data table - the dashboard banner
      // pulls users back to the same conclusion.
      return `
        SELECT user_type, COUNT(*) as request_count
        FROM conversations
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY user_type
      `;

    // ----------------------------------------------------------------
    // Client-events rollups
    // ----------------------------------------------------------------
    // All of these read from the `client_events` Glue table. They
    // return empty result sets until the /events Lambda starts writing,
    // which is the honest contract — better than fake numbers.

    case 'active_users_daily':
      // Session DAU — distinct person_id that auth-resolved at least once per
      // day. Includes signed-in-and-bounced users; not the right signal for
      // "actually engaged with messaging" (see active_messaging_users_daily).
      return `
        SELECT
          CONCAT(year,'-',month,'-',day) as date,
          user_tier,
          COUNT(DISTINCT person_id) as active_users
        FROM client_events
        WHERE event_type = 'session_started'
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY year, month, day, user_tier
        ORDER BY year, month, day, user_tier
      `;

    case 'active_messaging_users_daily':
      // Engaged-messaging DAU — distinct person_id that did at least one of:
      //   - connected to the Chime messaging WebSocket
      //   - sent a message
      //   - listed channel messages (read intent without typing)
      // Differs from active_users_daily (session DAU) by excluding users who
      // signed in but never touched messaging. See active-user-definition
      // memory.
      return `
        SELECT
          CONCAT(year,'-',month,'-',day) as date,
          user_tier,
          COUNT(DISTINCT person_id) as active_messaging_users
        FROM client_events
        WHERE event_type IN ('websocket_connected', 'message_sent', 'channel_messages_listed')
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY year, month, day, user_tier
        ORDER BY year, month, day, user_tier
      `;

    case 'messages_per_user':
      // Per-user message counts over the window. Pulled from message_sent
      // events (user-originated), not message_received (bot-originated).
      return `
        SELECT
          person_id,
          user_tier,
          COUNT(*) as message_count
        FROM client_events
        WHERE event_type = 'message_sent'
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY person_id, user_tier
        ORDER BY message_count DESC
      `;

    case 'messages_per_tier_daily':
      return `
        SELECT
          CONCAT(year,'-',month,'-',day) as date,
          user_tier,
          COUNT(*) as message_count
        FROM client_events
        WHERE event_type = 'message_sent'
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY year, month, day, user_tier
        ORDER BY year, month, day, user_tier
      `;

    case 'error_rate_daily':
      // Error count + total events per day so the dashboard can render
      // a rate. The "rate" denominator is intentionally all events, not
      // just messages — gives a useful global health signal even when
      // message volume is low.
      return `
        SELECT
          CONCAT(year,'-',month,'-',day) as date,
          SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) as error_count,
          COUNT(*) as total_events
        FROM client_events
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY year, month, day
        ORDER BY year, month, day
      `;

    case 'signup_funnel_conversion':
      return sessionFunnelSql(SIGNUP_FUNNEL, startDate, endDate);

    case 'signin_funnel_conversion':
      return sessionFunnelSql(SIGNIN_FUNNEL, startDate, endDate);

    case 'guest_to_customer_funnel':
      // THE GUEST-TO-CUSTOMER FUNNEL (B12): per recorded stage, the distinct journeys that reached it. A
      // journey is the visitor's conversation, carried on every stage, so path B is joined by conversation
      // and never by an address. The stage names are a fixed internal list, never input.
      return `
        SELECT
          event_type as step,
          COUNT(DISTINCT json_extract_scalar(properties, '$.journey')) as journeys,
          COUNT(*) as event_count
        FROM client_events
        WHERE event_type IN (${RECORDED_FUNNEL_STAGES.map((st) => `'${st}'`).join(', ')})
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
          ${journey ? `AND json_extract_scalar(properties, '$.journey') = '${journey}'` : ''}
        GROUP BY event_type
      `;

    case 'guest_refusals':
      // Guest starts refused, by the reason code the widget was shown (B12, L16).
      return `
        SELECT
          json_extract_scalar(properties, '$.reason') as reason,
          COUNT(*) as refusals
        FROM client_events
        WHERE event_type = 'guest_refused'
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY json_extract_scalar(properties, '$.reason')
        ORDER BY refusals DESC
      `;

    case 'page_load_metrics':
      // Percentile-style rollup over web-vitals + any explicit timer
      // labels. record_type='performance' means perf_value is set.
      return `
        SELECT
          event_type as metric,
          COUNT(*) as sample_count,
          AVG(perf_value) as avg_ms,
          APPROX_PERCENTILE(perf_value, 0.50) as p50_ms,
          APPROX_PERCENTILE(perf_value, 0.95) as p95_ms,
          APPROX_PERCENTILE(perf_value, 0.99) as p99_ms
        FROM client_events
        WHERE record_type = 'performance'
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY event_type
        ORDER BY metric
      `;

    case 'connection_health_daily':
      // WebSocket lifecycle counts per day. Reconnect spikes are the
      // early-warning signal for Chime/network instability.
      return `
        SELECT
          CONCAT(year,'-',month,'-',day) as date,
          SUM(CASE WHEN event_type = 'websocket_connected' THEN 1 ELSE 0 END) as connected,
          SUM(CASE WHEN event_type = 'websocket_disconnected' THEN 1 ELSE 0 END) as disconnected,
          SUM(CASE WHEN event_type = 'websocket_reconnected' THEN 1 ELSE 0 END) as reconnected
        FROM client_events
        WHERE event_type IN (
          'websocket_connected', 'websocket_disconnected', 'websocket_reconnected'
        )
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY year, month, day
        ORDER BY year, month, day
      `;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Athena execution
// ---------------------------------------------------------------------------

async function runQuery(sql: string): Promise<{ data: Record<string, string>[]; columns: string[] }> {
  const start = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: WORKGROUP,
    QueryExecutionContext: { Database: DATABASE },
  }));

  const queryId = start.QueryExecutionId!;

  // Poll for completion (max 30s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const status = await athena.send(new GetQueryExecutionCommand({
      QueryExecutionId: queryId,
    }));
    const state = status.QueryExecution?.Status?.State;

    if (state === QueryExecutionState.SUCCEEDED) {
      const results = await athena.send(new GetQueryResultsCommand({
        QueryExecutionId: queryId,
        MaxResults: 1000,
      }));

      const rows = results.ResultSet?.Rows || [];
      if (rows.length === 0) return { data: [], columns: [] };

      const columns = rows[0].Data?.map(d => d.VarCharValue || '') || [];
      const data = rows.slice(1).map(row => {
        const record: Record<string, string> = {};
        row.Data?.forEach((d, i) => { record[columns[i]] = d.VarCharValue || ''; });
        return record;
      });

      return { data, columns };
    }

    if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
      const reason = status.QueryExecution?.Status?.StateChangeReason || 'Unknown error';
      throw new Error(`Query ${state}: ${reason}`);
    }
  }

  throw new Error('Query timed out');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  console.log('[AnalyticsQuery]', event.httpMethod, event.path);

  // Lambda-side admin check is defense-in-depth on top of the API Gateway
  // Cognito authorizer. Without this, any signed-in basic-tier user could query
  // analytics.
  const auth = await requireAdmin(event);
  if ('statusCode' in auth) return auth;

  // parseJsonBody returns a 400 with the generic "Invalid JSON body" message
  // instead of letting JSON.parse throw into the outer catch (which would
  // surface a 500 + leak SyntaxError text).
  const parsed = parseJsonBody<{ queryType?: unknown; action?: unknown; dateRange?: { start?: unknown; end?: unknown }; journey?: unknown }>(event);
  if ('statusCode' in parsed) return parsed;

  try {
    const { queryType, dateRange } = parsed.body;

    if (typeof queryType !== 'string' || !queryType) {
      return respond(400, { error: 'queryType (string) required' });
    }

    // Every analytics route is IAM-authorized, and the resource the gateway admitted the caller to names
    // one capability, so the body must ask for that capability's work. A write is decided by its
    // `action` as well as its queryType (admin-capability-map.ts).
    const action = typeof parsed.body.action === 'string' ? parsed.body.action : undefined;
    if (!queryTypeAllowedOnPath(queryType, event.path || '', action)) {
      return respond(403, { error: 'queryType not permitted on this resource' });
    }

    const start = validateDate(dateRange?.start);
    const end = validateDate(dateRange?.end);
    if (!start || !end) {
      return respond(400, { error: 'dateRange.start and dateRange.end must be ISO date strings (YYYY-MM-DD)' });
    }
    if (start > end) {
      return respond(400, { error: 'dateRange.start must be <= dateRange.end' });
    }
    // Cap range to 365 days. Without this, an admin caller could request a
    // 5+ year window forcing Athena to
    // scan the entire partition projection — cost amplification + a
    // potential workgroup-quota DoS.
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    const MAX_RANGE_DAYS = 365;
    if ((endMs - startMs) / 86_400_000 > MAX_RANGE_DAYS) {
      return respond(400, {
        error: `dateRange exceeds maximum window of ${MAX_RANGE_DAYS} days`,
        code: 'RANGE_TOO_WIDE',
      });
    }

    // Honest empty: known query type that this mode can't serve.
    if (AURORA_ONLY_TYPES.has(queryType)) {
      return unsupportedResponse(AURORA_REASON);
    }

    // Real query path.
    if (!SUPPORTED_TYPES.has(queryType)) {
      // Genuinely unknown queryType - surface as 400 rather than silent empty.
      return respond(400, { error: `Unknown queryType: ${queryType}` });
    }

    // ONE JOURNEY of the guest funnel, when asked (B12): a channel id, validated before it is interpolated,
    // since Athena's StartQueryExecution takes no parameters.
    const journey = parsed.body.journey;
    if (journey !== undefined && (typeof journey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(journey))) {
      return respond(400, { error: 'journey is a conversation id' });
    }
    const sql = buildQuery(queryType, start, end, journey as string | undefined);
    if (!sql) {
      // SUPPORTED_TYPES claimed support but no SQL - bug, not user error.
      return respond(500, { error: `Internal: no SQL for supported queryType ${queryType}` });
    }

    const result = await runQuery(sql);
    // A14 Scoped: narrow rows to the caller's classification scope (rows with a
    // tier dimension; global aggregates pass through). Full on a Cognito-JWT call;
    // an enforced call fails closed to the floor if the caller is unidentifiable.
    if (isAdminIamEnforcedCall(event)) {
      const callerScope = await scopeForRequest(event, USER_POOL_ID);
      result.data = scopeAnalyticsRows(result.data, callerScope);
    }
    return respond(200, result);

  } catch (error) {
    console.error('[AnalyticsQuery] Error:', error);
    // Do NOT echo internal error text to the client - it can leak SQL,
    // Athena query IDs, and partition-key structure. Log server-side, return
    // a generic message.
    return respond(500, { error: 'Analytics query failed. Check server logs.' });
  }
};

// Exported for unit tests only.
export const __testing = {
  SUPPORTED_TYPES,
  AURORA_ONLY_TYPES,
  validateDate,
  buildQuery,
};
