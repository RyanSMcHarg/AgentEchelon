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
import { parseJsonBody, requireAdmin } from './lib/auth';

const athena = new AthenaClient({});
const WORKGROUP = process.env.ATHENA_WORKGROUP || 'agent-echelon-analytics';
const DATABASE = process.env.ATHENA_DATABASE || 'agent_echelon';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

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
// user_activity→user_id, latency_metrics→avg_total_ms) will move into a
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
  'conversation_summaries',
  'drift_events',
  'cross_conversation_context',
  'model_effectiveness',
  'experiment_results',
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

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    },
    body: JSON.stringify(body),
  };
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

function buildQuery(queryType: string, startDate: string, endDate: string): string | null {
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
          agentType as agent_type,
          intentType as intent_type,
          AVG(CAST(relevanceScore AS DOUBLE)) as avg_relevance_score,
          COUNT(*) as count
        FROM evaluation_results
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY year, month, day, agentType, intentType
        ORDER BY year, month, day, agent_type
      `;

    case 'intent_distribution':
      return `
        SELECT user_type as intent, COUNT(*) as count
        FROM conversations
        WHERE CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY user_type
      `;

    case 'user_activity':
      // NOTE: no user_id column in the current Glue schema; aggregates by
      // user_type partition only. Real per-user activity blocked on Glue
      // schema work.
      return `
        SELECT user_type, COUNT(*) as messages,
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
      // Session DAU — distinct user_id that auth-resolved at least once per
      // day. Includes signed-in-and-bounced users; not the right signal for
      // "actually engaged with messaging" (see active_messaging_users_daily).
      return `
        SELECT
          CONCAT(year,'-',month,'-',day) as date,
          user_tier,
          COUNT(DISTINCT user_id) as active_users
        FROM client_events
        WHERE event_type = 'session_started'
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY year, month, day, user_tier
        ORDER BY year, month, day, user_tier
      `;

    case 'active_messaging_users_daily':
      // Engaged-messaging DAU — distinct user_id that did at least one of:
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
          COUNT(DISTINCT user_id) as active_messaging_users
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
          user_id,
          user_email,
          user_tier,
          COUNT(*) as message_count
        FROM client_events
        WHERE event_type = 'message_sent'
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY user_id, user_email, user_tier
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
      // Each funnel step's count + distinct-sessions, ordered by the
      // canonical sequence so the dashboard can render a left-to-right
      // bar with step names as-is.
      return `
        SELECT
          event_type as step,
          COUNT(*) as event_count,
          COUNT(DISTINCT session_id) as session_count
        FROM client_events
        WHERE event_type IN (
          'signup_form_viewed',
          'signup_submitted',
          'signup_confirmation_required',
          'signup_confirmation_completed',
          'signup_failed'
        )
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY event_type
        ORDER BY
          CASE event_type
            WHEN 'signup_form_viewed' THEN 1
            WHEN 'signup_submitted' THEN 2
            WHEN 'signup_confirmation_required' THEN 3
            WHEN 'signup_confirmation_completed' THEN 4
            WHEN 'signup_failed' THEN 5
            ELSE 99
          END
      `;

    case 'signin_funnel_conversion':
      return `
        SELECT
          event_type as step,
          COUNT(*) as event_count,
          COUNT(DISTINCT session_id) as session_count
        FROM client_events
        WHERE event_type IN (
          'signin_form_viewed',
          'signin_submitted',
          'signin_succeeded',
          'signin_failed',
          'signin_password_reset_initiated'
        )
          AND CONCAT(year,'-',month,'-',day) BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY event_type
        ORDER BY
          CASE event_type
            WHEN 'signin_form_viewed' THEN 1
            WHEN 'signin_submitted' THEN 2
            WHEN 'signin_succeeded' THEN 3
            WHEN 'signin_failed' THEN 4
            WHEN 'signin_password_reset_initiated' THEN 5
            ELSE 99
          END
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
  console.log('[AnalyticsQuery]', event.httpMethod, event.path);

  // Lambda-side admin check is defense-in-depth on top of the API Gateway
  // Cognito authorizer. Without this, any signed-in basic-tier user could query
  // analytics.
  const auth = requireAdmin(event);
  if ('statusCode' in auth) return auth;

  // parseJsonBody returns a 400 with the generic "Invalid JSON body" message
  // instead of letting JSON.parse throw into the outer catch (which would
  // surface a 500 + leak SyntaxError text).
  const parsed = parseJsonBody<{ queryType?: unknown; dateRange?: { start?: unknown; end?: unknown } }>(event);
  if ('statusCode' in parsed) return parsed;

  try {
    const { queryType, dateRange } = parsed.body;

    if (typeof queryType !== 'string' || !queryType) {
      return respond(400, { error: 'queryType (string) required' });
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

    const sql = buildQuery(queryType, start, end);
    if (!sql) {
      // SUPPORTED_TYPES claimed support but no SQL - bug, not user error.
      return respond(500, { error: `Internal: no SQL for supported queryType ${queryType}` });
    }

    const result = await runQuery(sql);
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
