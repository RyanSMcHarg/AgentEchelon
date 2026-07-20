/**
 * Analytics Query Lambda (Aurora Mode)
 *
 * HTTP API handler for dashboard analytics from Aurora PostgreSQL.
 *
 * Endpoints:
 * - GET /analytics/evaluation              - Daily evaluation metrics
 * - GET /analytics/evaluation/exchanges    - Detailed exchange list with scores
 * - GET /analytics/evaluation/flows        - Multi-turn flow summaries
 * - GET /analytics/conversations           - Conversation list with summaries
 * - GET /analytics/drift                   - Drift detection events
 * - GET /analytics/context?userSub=X       - Cross-conversation context for a user
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { stripMessageMarkers } from '../lib/message-markers.js';
import { query, ensureSchema } from './db-client.js';
import { estimateStepCostUsd, bedrockModelIdToKey } from '../lib/model-rate-table.js';
import { callerIsAdmin, callerCanReadArchive, isAdminIamEnforcedCall } from '../lib/auth.js';
import { queryTypeAllowedOnPath } from '../lib/admin-capability-map.js';
import { recordModerationAction, adminListEvents } from './admin-conversations-aurora.js';
import {
  aggregateVariantFeedback,
  aggregateBattleWins,
  feedbackColumnsFor,
  battleColumnsFor,
  feedbackKey,
  type FeedbackItem,
  type VariantFeedback,
  type BattleOutcomeItem,
} from './variant-feedback.js';

// Minimum exchanges per variant before a result is treated as decision-grade.
// Below this the variant is flagged needs_more_data and the recommendation
// endpoint returns an inconclusive verdict without spending a model call.
const MIN_SAMPLE_PER_VARIANT = 30;

// Cheapest model that is everywhere; we only summarise a small metrics table.
// NOTE: the analytics-query Lambda role must grant bedrock:InvokeModel on this
// model for getExperimentRecommendation to work.
const RECOMMENDATION_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

// UserFeedback table (DynamoDB, owned by the CognitoAuth stack) for the thumbs
// per-variant join. Reached over the VPC's
// DynamoDB gateway endpoint. Unset (feature not wired in this deployment) =>
// the join is skipped and results render without a thumbs column.
const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE || '';
// BattleOutcome table (DynamoDB, owned by the opt-in AgentEchelonBattle stack) for
// the per-variant battle-wins join.
// Resolved at DEPLOY time via a CloudFormation SSM dynamic reference (not a
// runtime SSM read — the VPC has no SSM endpoint), so this is just a baked-in
// table name. Empty when /battle is off => the battle join is skipped.
const BATTLE_OUTCOME_TABLE = process.env.BATTLE_OUTCOME_TABLE || '';
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// CORS configuration
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .filter(Boolean);

let corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] || '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
};

function initCors(event: APIGatewayProxyEvent): void {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0] || '';
  corsHeaders = {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

function success(data: any): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Cache-Control': 'private, max-age=60' },
    body: JSON.stringify(data),
  };
}

function error(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify({ error: message }),
  };
}

// In-memory response cache
interface CacheEntry {
  data: any;
  expiresAt: number;
}
const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(key: string): any | null {
  const entry = responseCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.data;
  }
  responseCache.delete(key);
  return null;
}

const MAX_CACHE_SIZE = 100;

function setCache(key: string, data: any): void {
  // Evict expired entries first
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (v.expiresAt <= now) responseCache.delete(k);
    }
  }
  // If still at capacity, evict oldest entries
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Lambda handler
 */
export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  console.log('Analytics query:', event.path, event.queryStringParameters);
  initCors(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // Lambda-side defense in depth: the gateway authorizer is wired
  // (analytics-stack-aurora.ts), but every analytics endpoint additionally
  // requires the admin group. /context could leak a cross-tenant userSub —
  // allow self-lookup OR admin, never an arbitrary userSub from a non-admin.
  const claims = (event.requestContext?.authorizer?.claims || {}) as Record<string, unknown>;
  const callerSub = (claims.sub as string) || (claims['cognito:username'] as string) || '';
  // Shared, IdP-agnostic admin gate (honors ADMIN_GROUP_NAMES + service mode).
  const isAdmin = callerIsAdmin(event);
  // A non-admin must present a Cognito identity (for the /context self-lookup
  // below). A service-mode admin call has no JWT sub and is allowed through —
  // it enforced admin upstream.
  if (!callerSub && !isAdmin) {
    return error(401, 'Unauthorized');
  }

  try {
    await ensureSchema();

    // POST { queryType, dateRange, ...extra } — the Athena analytics contract
    // the frontend's queryAnalytics() uses for BOTH modes. Aurora's native API is
    // GET /analytics/<resource>, so bridge queryType -> the same query fns and
    // normalize each result to the frontend's { data: [...] } shape. Without this
    // the admin console shows "Analytics API unavailable" in Aurora mode (the
    // POST hit no method on the API root). Admin-gated like every other endpoint.
    if (event.httpMethod === 'POST') {
      if (!isAdmin) return error(403, 'Admin access required');
      // A14: under per-resource IAM enforcement the gateway authorized this
      // request as the capability of THIS resource path; reject a queryType that
      // belongs to a different capability, so a caller allowed the low-sensitivity
      // analytics resource cannot read A13 PII (or the event log / moderation
      // audit) by naming its queryType on the wrong path.
      if (isAdminIamEnforcedCall(event)) {
        const qt = parsePostQueryType(event.body);
        if (!queryTypeAllowedOnPath(qt, event.path || '')) {
          return error(403, 'queryType not permitted on this resource');
        }
      }
      // Moderation audit: the actor is the SERVER-VERIFIED admin (callerSub + claims), never
      // the client body — so attribution can't be spoofed. Intercepted before query dispatch.
      const mod = await maybeRecordModeration(event.body, callerSub, claims);
      if (mod) return mod;
      // The complete raw event log reads conversation ARCHIVE content — a SEPARABLE authorization
      // from base admin (a future role can be denied it). Interim group gate; IAM-enforceable
      // capability is the tracked follow-up. See callerCanReadArchive.
      if (isArchiveReadBody(event.body) && !callerCanReadArchive(event)) {
        return error(403, 'Archive-view permission required');
      }
      return handlePostQuery(event.body);
    }

    const path = event.path || '';
    const params = event.queryStringParameters || {};

    // /context is the only endpoint that allows non-admin self-lookup.
    // Every other endpoint requires admin.
    if (path.endsWith('/context')) {
      const requestedSub = params.userSub;
      if (!isAdmin && requestedSub !== callerSub) {
        return error(403, 'Cannot read another user\'s context');
      }
      return getConversationContext(params);
    }

    if (!isAdmin) {
      console.warn('[analytics-aurora] non-admin denied', { sub: callerSub, path });
      return error(403, 'Admin access required');
    }

    // Route requests (all admin-only below)
    if (path.endsWith('/evaluation/exchanges')) {
      return getExchanges(params);
    }
    if (path.endsWith('/execution-steps')) {
      return getExecutionSteps(params);
    }
    if (path.endsWith('/evaluation/flows')) {
      return getFlows(params);
    }
    if (path.endsWith('/evaluation')) {
      return getEvaluationMetrics(params);
    }
    if (path.endsWith('/conversations')) {
      return getConversations(params);
    }
    if (path.endsWith('/drift')) {
      return getDriftEvents(params);
    }
    if (path.endsWith('/latency')) {
      return getLatencyMetrics(params);
    }
    if (path.endsWith('/model-effectiveness')) {
      return getModelEffectiveness(params);
    }
    if (path.endsWith('/experiments/recommendation')) {
      return getExperimentRecommendation(params);
    }
    if (path.endsWith('/experiments')) {
      return getExperimentResults(params);
    }

    return error(404, `Unknown endpoint: ${path}`);
  } catch (err) {
    console.error('Analytics query error:', err);
    return error(500, 'Internal server error');
  }
}

/**
 * Aurora POST-{queryType} shim. The frontend's queryAnalytics()
 * POSTs { queryType, dateRange, ...extra } — the Athena contract — for BOTH
 * modes, but Aurora's native API is GET /analytics/<resource> returning bespoke
 * keys ({conversations}, {events}, {dailyBreakdown}, ...). This maps queryType
 * to the same query fns and normalizes the result to the frontend's
 * { data: [...] } shape (extra fields like stats/pagination/totals pass through).
 *
 * Superset parity (#33/#35): flagged_responses, ground_truth, and the task_*
 * queryTypes are served natively below so Aurora NEVER returns `unsupported` for
 * them (that misrendered as "not available in Aurora mode"). They return real
 * data or an honest empty state — never the unsupported banner.
 */

/**
 * Quality > Flagged. Derived from the evaluation store: an exchange is flagged
 * when the judge scored it low, marked it non-compliant, or attached flags. No
 * separate table/pipeline needed. (Review persistence — approve/reject + notes —
 * needs a schema column and is a follow-up; schema-init is one-time so it can't
 * ship in a normal deploy.)
 */
async function getFlaggedResponses(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  if (params.action === 'review') {
    // Review persistence is not yet wired (needs a review_status column; the
    // one-time schema-init can't add it on Update). Acknowledge without 500ing.
    return success({ reviewed: false, note: 'Flagged review persistence is a pending follow-up.' });
  }
  const days = parseInt(params.days || '7', 10);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const result = await query(
    `SELECT e.id AS exchange_id, e.channel_arn,
            -- Legacy exchanges (DIRECT/pre-attribution) archived with a null agent_type; fall back
            -- to the conversation's tier at query time so the 'assistant' column is not empty. New
            -- rows already carry it (kinesis-archival COALESCE). Intent is per-turn and cannot be
            -- backfilled this way, so it stays as stored.
            COALESCE(e.agent_type, c.agent_type) AS agent_type, e.intent,
            er.relevance_score, er.classification, er.reasoning,
            er.is_compliant, er.compliance_categories AS compliance, er.flags,
            er.evaluated_at AS flagged_at,
            'pending' AS review_status,
            um.content AS user_message,
            COALESCE(am.updated_content, am.content) AS agent_response
       FROM evaluation_results er
       JOIN exchanges e ON er.exchange_id = e.id
       LEFT JOIN conversations c ON e.conversation_id = c.id
       LEFT JOIN messages um ON e.user_message_id = um.id
       LEFT JOIN messages am ON e.agent_message_id = am.id
      WHERE er.evaluation_type = 'exchange'
        AND er.evaluated_at >= NOW() - INTERVAL '1 day' * $1
        AND (er.relevance_score < 50
             OR er.is_compliant = false
             OR COALESCE(cardinality(er.flags), 0) > 0)
      ORDER BY er.relevance_score ASC NULLS LAST
      LIMIT $2`,
    [days, limit]
  );
  const data = result.rows.map((r: any) => ({
    ...r,
    user_message: stripMessageMarkers(r.user_message),
    agent_response: stripMessageMarkers(r.agent_response),
  }));
  return success({ data });
}

/**
 * Quality > Ground Truth. Read: human labels joined to the automated score for
 * calibration (the tab computes MAE/agreement client-side). Write (action=submit):
 * insert a human label into the existing `ground_truth_scores` table.
 */
async function getGroundTruth(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  if (params.action === 'submit') {
    const exchangeId = params.exchangeId;
    const score = params.score !== undefined ? Number(params.score) : NaN;
    if (!exchangeId || !Number.isFinite(score)) {
      return success({ submitted: false, error: 'exchangeId and numeric score required' });
    }
    await query(
      `INSERT INTO ground_truth_scores (exchange_id, human_score, classification, reasoning, scorer_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [exchangeId, Math.max(0, Math.min(100, score)), params.classification || null, params.reasoning || null, params.scorerId || 'admin-console']
    );
    return success({ submitted: true });
  }
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const result = await query(
    `SELECT gt.id, gt.exchange_id, e.channel_arn, gt.human_score, gt.classification, gt.reasoning,
            gt.scorer_id, gt.scored_at,
            er.relevance_score AS automated_score,
            (gt.human_score - er.relevance_score) AS score_delta,
            um.content AS user_message,
            COALESCE(am.updated_content, am.content) AS agent_response
       FROM ground_truth_scores gt
       JOIN exchanges e ON gt.exchange_id = e.id
       LEFT JOIN evaluation_results er ON er.exchange_id = e.id AND er.evaluation_type = 'exchange'
       LEFT JOIN messages um ON e.user_message_id = um.id
       LEFT JOIN messages am ON e.agent_message_id = am.id
      ORDER BY gt.scored_at DESC
      LIMIT $1`,
    [limit]
  );
  const data = result.rows.map((r: any) => ({
    ...r,
    user_message: stripMessageMarkers(r.user_message),
    agent_response: stripMessageMarkers(r.agent_response),
  }));
  return success({ data });
}

/** Quality > Tasks (metrics rollup). Over exchanges with a task_id; honest-empty
 *  until multi-step task traffic exists. */
async function getTaskMetrics(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT DATE(created_at) AS date,
            COALESCE(intent, 'unknown') AS type,
            COUNT(DISTINCT task_id) AS total,
            COUNT(DISTINCT task_id) FILTER (WHERE task_status = 'completed') AS completed,
            COUNT(DISTINCT task_id) FILTER (WHERE task_status = 'failed') AS failed
       FROM exchanges
      WHERE task_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY DATE(created_at), COALESCE(intent, 'unknown')
      ORDER BY date DESC`,
    [days]
  );
  return success({ data: result.rows });
}

/** Quality > Tasks (per-task detail). */
async function getTaskDetails(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  // Optional intent filter — this is also the Effectiveness L2 task list (drill from an intent to its
  // tasks). `$3 IS NULL` keeps the unfiltered Quality>Tasks behavior; set it for the L2 drill.
  const intent = params.intent || null;
  const result = await query(
    `SELECT task_id,
            COALESCE(MAX(intent), 'unknown') AS type,
            MAX(task_status) AS status,
            -- Machine state as of the latest turn (SPEC-TASK-STATE-TRANSITIONS §6). Distinct from
            -- status (the lifecycle): the declared-graph state the task reached. Alphabetical MAX is
            -- meaningless for states, so take the most-recent turn's value.
            (ARRAY_AGG(task_state ORDER BY created_at DESC))[1] AS task_state,
            MIN(created_at) AS started_at,
            MAX(created_at) AS last_at,
            COUNT(*) AS exchange_count,
            -- How many turns actually advanced the machine (a transition was recorded).
            COUNT(task_transition) AS transition_count
       FROM exchanges
      WHERE task_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '1 day' * $1
        AND ($3::varchar IS NULL OR intent = $3)
      GROUP BY task_id
      ORDER BY MAX(created_at) DESC
      LIMIT $2`,
    [days, limit, intent]
  );
  return success({ data: result.rows });
}

/**
 * Effectiveness L3 (SPEC-ADMIN-CONSOLE-EFFECTIVENESS §5): the turn-by-turn machine-state timeline for
 * ONE task. Each row is a turn (exchange) in order, carrying the state it reached (`task_state`) and
 * the edge it traversed (`task_transition`) — the per-exchange projection of the agent-tasks
 * `stateHistory`. Latency + `agent_message_id` ride along so the drill can join per-turn score, tokens,
 * and the tool loop (steps) downstream. Empty (honest) when `taskId` is absent or the task has no turns.
 */
async function getTaskTimeline(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const taskId = params.taskId;
  if (!taskId) return success({ data: [] });
  const result = await query(
    `SELECT e.id AS exchange_id,
            e.agent_message_id,
            e.intent,
            e.task_status,
            e.task_state,
            e.task_transition,
            e.response_latency_ms,
            e.created_at,
            er.relevance_score,
            m.total_ms,
            m.input_tokens,
            m.output_tokens,
            m.bedrock_model,
            -- The turn's tool loop (L4, reached in context): the ConverseStep array carries per-step
            -- model/tokens/cost + the P2 tools[] outcomes, so a timeline row expands to its steps
            -- without a second query.
            COALESCE(m.metadata->'steps', '[]'::jsonb) AS steps
       FROM exchanges e
       LEFT JOIN messages m ON e.agent_message_id = m.id
       LEFT JOIN (
         SELECT exchange_id, AVG(relevance_score) AS relevance_score
           FROM evaluation_results
          WHERE evaluation_type = 'exchange'
          GROUP BY exchange_id
       ) er ON er.exchange_id = e.id
      WHERE e.task_id = $1
      ORDER BY e.created_at ASC`,
    [taskId]
  );
  return success({ data: result.rows });
}

const POST_DISPATCH: Record<
  string,
  { fn: (p: Record<string, string | undefined>) => Promise<APIGatewayProxyResult>; dataKey: string }
> = {
  conversation_volumes: { fn: getConversationVolumes, dataKey: 'data' },
  model_usage: { fn: getModelUsage, dataKey: 'data' },
  conversation_summaries: { fn: getConversations, dataKey: 'conversations' },
  drift_events: { fn: getDriftEvents, dataKey: 'events' },
  evaluation_scores: { fn: getEvaluationMetrics, dataKey: 'dailyBreakdown' },
  evaluation_exchanges: { fn: getExchanges, dataKey: 'exchanges' },
  execution_steps: { fn: getExecutionSteps, dataKey: 'data' },
  evaluation_flows: { fn: getFlows, dataKey: 'flows' },
  // Superset parity (#33/#35): served natively so Aurora never says "unsupported".
  flagged_responses: { fn: getFlaggedResponses, dataKey: 'data' },
  ground_truth: { fn: getGroundTruth, dataKey: 'data' },
  task_metrics: { fn: getTaskMetrics, dataKey: 'data' },
  task_details: { fn: getTaskDetails, dataKey: 'data' },
  task_timeline: { fn: getTaskTimeline, dataKey: 'data' },
  intent_effectiveness: { fn: getIntentEffectiveness, dataKey: 'data' },
  channel_events: { fn: getChannelEvents, dataKey: 'events' },
  intent_exchanges: { fn: getIntentExchanges, dataKey: 'data' },
  cross_conversation_context: { fn: getConversationContext, dataKey: 'contexts' },
  latency_metrics: { fn: getLatencyMetrics, dataKey: 'data' },
  model_effectiveness: { fn: getModelEffectiveness, dataKey: 'data' },
  experiment_results: { fn: getExperimentResults, dataKey: 'data' },
  // Recommendation returns { verdict, confidence, rationale, variants } at top
  // level; the shim mirrors `variants` into `data` and passes the rest through.
  experiment_recommendation: { fn: getExperimentRecommendation, dataKey: 'variants' },
  // Superset parity: every metric Athena serves, Aurora serves too (no
  // capability is Athena-only). intent/user-activity read the message tables;
  // the rest read client_events (populated once client-event ingestion lands).
  intent_distribution: { fn: getIntentDistribution, dataKey: 'data' },
  user_activity: { fn: getUserActivity, dataKey: 'data' },
  active_users_daily: { fn: getActiveUsersDaily, dataKey: 'data' },
  active_messaging_users_daily: { fn: getActiveMessagingUsersDaily, dataKey: 'data' },
  messages_per_user: { fn: getMessagesPerUser, dataKey: 'data' },
  messages_per_tier_daily: { fn: getMessagesPerTierDaily, dataKey: 'data' },
  error_rate_daily: { fn: getErrorRateDaily, dataKey: 'data' },
  signup_funnel_conversion: { fn: getSignupFunnel, dataKey: 'data' },
  signin_funnel_conversion: { fn: getSigninFunnel, dataKey: 'data' },
  page_load_metrics: { fn: getPageLoadMetrics, dataKey: 'data' },
  connection_health_daily: { fn: getConnectionHealthDaily, dataKey: 'data' },
};

/** Translate the POST body (dateRange + passthrough extras) into the
 *  query-string params the GET query fns already read. */
function buildParamsFromBody(body: Record<string, unknown>): Record<string, string | undefined> {
  const p: Record<string, string | undefined> = {};
  const dr = body.dateRange as { start?: string; end?: string } | undefined;
  if (dr?.start && dr?.end) {
    const ms = Date.parse(dr.end) - Date.parse(dr.start);
    if (Number.isFinite(ms) && ms > 0) p.days = String(Math.max(1, Math.ceil(ms / 86_400_000)));
  }
  for (const k of [
    'limit', 'offset', 'channelArn', 'userSub', 'experimentId', 'unresolved', 'agentType', 'includeBattle', 'taskId', 'intent',
    // Quality-tab write actions (ground_truth submit / flagged review) — #33/#35.
    'action', 'exchangeId', 'score', 'classification', 'reasoning', 'reviewAction', 'notes', 'scorerId',
  ]) {
    const v = body[k];
    if (v !== undefined && v !== null) p[k] = String(v);
  }
  return p;
}

/**
 * Moderation audit write: POST { queryType: 'record_moderation', channelArn, messageId, moderation }.
 * The actor is taken from the verified JWT (actorSub + claims), NEVER the body, so it can't be
 * spoofed. Returns null when the body isn't a record_moderation request (normal dispatch continues).
 */
async function maybeRecordModeration(
  rawBody: string | null,
  actorSub: string,
  claims: Record<string, unknown>,
): Promise<APIGatewayProxyResult | null> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return null;
  }
  if (body.queryType !== 'record_moderation') return null;
  const channelArn = String(body.channelArn || '');
  const messageId = String(body.messageId || '');
  const action = body.moderation === 'delete' ? 'delete' : 'redact';
  if (!channelArn || !messageId) return error(400, 'channelArn and messageId are required');
  const actorName =
    (claims.name as string) || (claims.email as string) || (claims['cognito:username'] as string) || undefined;
  try {
    await recordModerationAction({ channelArn, messageId, action, actorSub, actorName });
  } catch (e) {
    console.error('[analytics-aurora] record_moderation failed', e);
    return error(500, 'Failed to record moderation');
  }
  return success({ recorded: true });
}

/** Complete archived event log for one channel (dev-persona view). POST { queryType:
 *  'channel_events', channelArn }. Admin-gated like every POST here. */
/** True when the POST body requests the complete raw event log (archive-read gated). */
function isArchiveReadBody(rawBody: string | null): boolean {
  try {
    return JSON.parse(rawBody || '{}').queryType === 'channel_events';
  } catch {
    return false;
  }
}

/** The queryType named in a POST body (empty if absent/malformed) — for the A14
 *  per-resource capability check. */
function parsePostQueryType(rawBody: string | null): string {
  try {
    return String(JSON.parse(rawBody || '{}').queryType || '');
  } catch {
    return '';
  }
}

async function getChannelEvents(
  params: Record<string, string | undefined>,
): Promise<APIGatewayProxyResult> {
  const channelArn = params.channelArn || '';
  if (!channelArn) return error(400, 'channelArn is required');
  const events = await adminListEvents(channelArn);
  return success({ events });
}

async function handlePostQuery(rawBody: string | null): Promise<APIGatewayProxyResult> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return error(400, 'Invalid JSON body');
  }
  const queryType = String(body.queryType || '');
  const entry = POST_DISPATCH[queryType];
  if (!entry) {
    return success({
      data: [],
      unsupported: true,
      reason: `Query "${queryType || '(none)'}" is not available in Aurora analytics mode.`,
    });
  }
  const res = await entry.fn(buildParamsFromBody(body));
  if (res.statusCode !== 200) return res;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    return error(500, 'Malformed analytics result');
  }
  const arr = Array.isArray(parsed[entry.dataKey]) ? parsed[entry.dataKey] : [];
  // Normalize to { data: [...] }; keep the rest (stats/pagination/totals) at top level.
  return success({ ...parsed, data: arr });
}

/**
 * GET /analytics/evaluation - Daily evaluation metrics
 */
async function getEvaluationMetrics(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const cacheKey = `eval-metrics-${days}`;
  const cached = getCached(cacheKey);
  if (cached) return success(cached);

  const result = await query(
    `SELECT
       COUNT(*) AS total_exchanges,
       COUNT(er.id) AS evaluated_exchanges,
       ROUND(AVG(er.relevance_score)::numeric, 1) AS avg_relevance_score,
       ROUND(
         (COUNT(*) FILTER (WHERE er.is_compliant) * 100.0 /
          NULLIF(COUNT(er.id), 0))::numeric, 1
       ) AS compliance_rate,
       COUNT(*) FILTER (WHERE er.classification = 'excellent') AS excellent_count,
       COUNT(*) FILTER (WHERE er.classification = 'good') AS good_count,
       COUNT(*) FILTER (WHERE er.classification = 'partial') AS partial_count,
       COUNT(*) FILTER (WHERE er.classification IN ('poor', 'irrelevant')) AS poor_count
     FROM exchanges e
     LEFT JOIN evaluation_results er ON er.exchange_id = e.id
     WHERE e.created_at >= NOW() - INTERVAL '1 day' * $1`,
    [days]
  );

  // Daily breakdown. Column aliases MUST match the frontend EvaluationScoreData
  // contract ({ date, agent_type, intent_type, avg_relevance_score, count }) —
  // the same shape Athena mode returns — so EvaluationsTab renders in both
  // modes. Emitting avg_score/exchange_count here (the earlier names) made the
  // UI read undefined and render NaN for every row.
  const dailyResult = await query(
    `SELECT
       TO_CHAR(DATE(e.created_at), 'YYYY-MM-DD') AS date,
       e.agent_type,
       COALESCE(e.intent, 'unknown') AS intent_type,
       COUNT(*) AS count,
       ROUND(AVG(er.relevance_score)::numeric, 1) AS avg_relevance_score,
       COUNT(*) FILTER (WHERE NOT COALESCE(er.is_compliant, true)) AS violation_count
     FROM exchanges e
     LEFT JOIN evaluation_results er ON er.exchange_id = e.id
     WHERE e.created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY DATE(e.created_at), e.agent_type, COALESCE(e.intent, 'unknown')
     ORDER BY date DESC`,
    [days]
  );

  const row = result.rows[0] || {};
  const data = {
    totalExchanges: parseInt(row.total_exchanges || '0', 10),
    evaluatedExchanges: parseInt(row.evaluated_exchanges || '0', 10),
    avgRelevanceScore: parseFloat(row.avg_relevance_score || '0'),
    complianceRate: parseFloat(row.compliance_rate || '0'),
    scoreDistribution: {
      excellent: parseInt(row.excellent_count || '0', 10),
      good: parseInt(row.good_count || '0', 10),
      partial: parseInt(row.partial_count || '0', 10),
      poor: parseInt(row.poor_count || '0', 10),
    },
    dailyBreakdown: dailyResult.rows,
  };

  setCache(cacheKey, data);
  return success(data);
}

/**
 * GET /analytics/evaluation/exchanges - Detailed exchange list
 */
async function getExchanges(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const offset = parseInt(params.offset || '0', 10);
  const agentType = params.agentType;

  let whereClause = 'WHERE e.created_at >= NOW() - INTERVAL \'1 day\' * $1';
  const queryParams: any[] = [days, limit, offset];

  if (agentType) {
    queryParams.push(agentType);
    whereClause += ` AND e.agent_type = $${queryParams.length}`;
  }

  const result = await query(
    `SELECT
       e.id,
       e.channel_arn,
       e.user_type,
       e.agent_type,
       e.intent,
       e.task_id,
       e.response_latency_ms,
       e.user_message_at,
       e.agent_response_at,
       um.content AS user_message,
       COALESCE(am.updated_content, am.content) AS agent_response,
       er.relevance_score,
       er.classification,
       er.reasoning,
       er.is_compliant,
       er.flags
     FROM exchanges e
     LEFT JOIN messages um ON e.user_message_id = um.id
     LEFT JOIN messages am ON e.agent_message_id = am.id
     LEFT JOIN evaluation_results er ON er.exchange_id = e.id
     ${whereClause}
     ORDER BY e.created_at DESC
     LIMIT $2 OFFSET $3`,
    queryParams
  );

  // Strip internal markers so the admin console (and the eval it feeds) shows the
  // human-visible text, exactly what the SPA renders — never a raw NAVIGATE_CHANNEL
  // or <!--…--> marker.
  const exchanges = result.rows.map((r) => ({
    ...r,
    user_message: stripMessageMarkers(r.user_message),
    agent_response: stripMessageMarkers(r.agent_response),
  }));
  return success({
    exchanges,
    pagination: { limit, offset, hasMore: result.rows.length === limit },
  });
}

const EXECUTION_STEPS_COLUMNS = [
  'message_id', 'timestamp', 'intent', 'bedrock_model', 'total_ms', 'step_count', 'steps',
];

/**
 * GET /analytics/execution-steps - per-message step telemetry
 * (SPEC-MESSAGE-METADATA-CODEBOOK.md; ADR-016). Each bot turn's self-hosted
 * tool loop records a step per Converse iteration; persisted out-of-band and
 * merged by archival into `messages.metadata->'steps'`. This surfaces them for
 * the admin steps table: one row per bot message that carries steps, with the
 * step array for the expandable per-step breakdown. Aurora-only (the steps live
 * in the messages JSONB column; Athena's partition-only table has none).
 */
async function getExecutionSteps(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const queryParams: any[] = [days, limit];

  let where = `WHERE m.is_bot = true
       AND m.metadata ? 'steps'
       AND jsonb_array_length(m.metadata->'steps') > 0
       AND m.created_at >= NOW() - INTERVAL '1 day' * $1`;
  if (params.channelArn) {
    queryParams.push(params.channelArn);
    where += ` AND m.channel_arn = $${queryParams.length}`;
  }

  const result = await query(
    `SELECT
       m.message_id,
       m.created_at AS timestamp,
       m.metadata->>'intent' AS intent,
       m.bedrock_model,
       m.total_ms,
       jsonb_array_length(m.metadata->'steps') AS step_count,
       m.metadata->'steps' AS steps
     FROM messages m
     ${where}
     ORDER BY m.created_at DESC
     LIMIT $2`,
    queryParams
  );

  return success({ data: result.rows, columns: EXECUTION_STEPS_COLUMNS });
}

/**
 * GET /analytics/evaluation/flows - Multi-turn flow summaries
 */
async function getFlows(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const offset = parseInt(params.offset || '0', 10);

  const result = await query(
    `SELECT
       f.id,
       f.task_id,
       f.channel_arn,
       f.intent,
       f.agent_type,
       f.status,
       f.exchange_count,
       f.turn_count,
       f.duration_seconds,
       f.outcome,
       f.outcome_score,
       f.efficiency_score,
       f.context_retention_score,
       f.ux_score,
       f.information_score,
       f.first_exchange_at,
       f.last_exchange_at,
       f.created_at
     FROM intent_flows f
     WHERE f.created_at >= NOW() - INTERVAL '1 day' * $1
     ORDER BY f.created_at DESC
     LIMIT $2 OFFSET $3`,
    [days, limit, offset]
  );

  return success({
    flows: result.rows,
    pagination: { limit, offset, hasMore: result.rows.length === limit },
  });
}

/**
 * GET /analytics/conversations - Conversation list with summaries
 */
async function getConversations(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const limit = Math.min(parseInt(params.limit || '20', 10), 100);
  const offset = parseInt(params.offset || '0', 10);
  const channelArn = params.channelArn;

  // Single conversation detail
  if (channelArn) {
    const messagesResult = await query(
      `SELECT
         m.message_id,
         COALESCE(m.updated_content, m.content) AS content,
         m.created_at AS timestamp,
         m.sender_name AS sender,
         m.sender_arn,
         m.event_type,
         m.is_bot,
         m.latency_ms,
         m.total_ms,
         m.input_tokens,
         m.output_tokens,
         m.bedrock_model
       FROM messages m
       WHERE m.channel_arn = $1
         AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
       ORDER BY m.created_at ASC
       LIMIT $2 OFFSET $3`,
      [channelArn, limit, offset]
    );

    return success({
      channelArn,
      messages: messagesResult.rows.map((m: any) => ({ ...m, content: stripMessageMarkers(m.content) })),
      pagination: {
        limit,
        offset,
        hasMore: messagesResult.rows.length === limit,
      },
    });
  }

  // Conversation list
  const result = await query(
    `SELECT
       c.channel_arn,
       c.user_type,
       c.agent_type,
       c.message_count,
       c.first_message_at,
       c.last_message_at,
       cs.name AS conversation_name,
       cs.purpose,
       cs.summary,
       cs.topics
     FROM conversations c
     LEFT JOIN conversation_summaries cs ON cs.channel_arn = c.channel_arn
       AND cs.version = (
         SELECT MAX(version) FROM conversation_summaries
         WHERE channel_arn = c.channel_arn
       )
     WHERE c.last_message_at >= NOW() - INTERVAL '1 day' * $1
     ORDER BY c.last_message_at DESC
     LIMIT $2 OFFSET $3`,
    [days, limit, offset]
  );

  return success({
    conversations: result.rows,
    pagination: { limit, offset, hasMore: result.rows.length === limit },
  });
}

/**
 * Overview "Message Volume by Date". The frontend POSTs queryType
 * `conversation_volumes` (the Athena analytics contract) for BOTH modes; in
 * Aurora we serve it natively from the `messages` table so the Overview tab's
 * headline metric works instead of honest-emptying as "Aurora-only". Returns
 * one row per day: { date, message_count, conversation_count } to match the
 * OverviewTab volume table and its message-trend sparkline.
 */
async function getConversationVolumes(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '7', 10), 180);

  const result = await query(
    `SELECT
       TO_CHAR(DATE(m.created_at), 'YYYY-MM-DD') AS date,
       COUNT(*) FILTER (WHERE m.event_type = 'CREATE_CHANNEL_MESSAGE') AS message_count,
       COUNT(DISTINCT m.channel_arn) AS conversation_count
     FROM messages m
     WHERE m.created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY DATE(m.created_at)
     ORDER BY date DESC`,
    [days]
  );

  return success({ data: result.rows });
}

/**
 * GET /analytics/drift - Drift detection events
 */
async function getDriftEvents(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  // The by-reference drift model (migration 006, drift_events) records an
  // OUTCOME per drift, not a resolved flag. 'abandoned' is the one that reads
  // as unresolved/needs-review; everything else is a settled outcome.
  const unresolvedOnly = params.unresolved === 'true';
  const outcomeFilter = unresolvedOnly ? " AND d.outcome = 'abandoned'" : '';

  const result = await query(
    `SELECT
       d.event_id AS id,
       d.parent_channel_arn AS channel_arn,
       d.new_channel_arn,
       d.rival_conversation_arn,
       d.cosine_distance AS drift_score,
       d.outcome,
       d.intent,
       d.confidence,
       d.occurred_at AS detected_at,
       d.user_sub,
       d.originating_message_id,
       d.signal_disagreement,
       d.created_via_explicit_intent
     FROM drift_events d
     WHERE d.occurred_at >= NOW() - INTERVAL '1 day' * $1${outcomeFilter}
     ORDER BY d.occurred_at DESC
     LIMIT $2`,
    [days, limit]
  );

  // Summary stats
  const statsResult = await query(
    `SELECT
       COUNT(*) AS total_events,
       COUNT(*) FILTER (WHERE outcome = 'abandoned') AS unresolved_count,
       ROUND(AVG(cosine_distance)::numeric, 4) AS avg_drift_score
     FROM drift_events
     WHERE occurred_at >= NOW() - INTERVAL '1 day' * $1`,
    [days]
  );

  return success({
    events: result.rows,
    stats: statsResult.rows[0] || {},
  });
}

// ---------------------------------------------------------------------------
// Superset parity: query fns for the metrics that Athena serves so that Aurora
// (the more expensive mode) never degrades the admin experience. intent and
// user-activity read the message/conversation tables (real data, richer than
// Athena's partition-only version); the client-event rollups read the
// `client_events` table. See docs/SPEC-ADMIN-CONSOLE.md (Aurora is a strict
// superset) and the client-events -> Aurora ingestion note in the impl design.
// ---------------------------------------------------------------------------

/** Intent distribution over real exchange intents (Aurora enhancement: Athena
 *  only had the tier partition). */
async function getIntentDistribution(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT COALESCE(e.intent, 'unknown') AS intent, COUNT(*) AS count
     FROM exchanges e
     WHERE e.created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY COALESCE(e.intent, 'unknown')
     ORDER BY count DESC`,
    [days]
  );
  return success({ data: result.rows });
}

/** Per-tier message activity from the conversation rollup. */
async function getUserActivity(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT
       c.user_type,
       COALESCE(SUM(c.message_count), 0) AS messages,
       COUNT(DISTINCT DATE(c.last_message_at)) AS active_days
     FROM conversations c
     WHERE c.last_message_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY c.user_type
     ORDER BY messages DESC`,
    [days]
  );
  return success({ data: result.rows });
}

/** Session DAU (auth-resolved at least once/day), from client_events. */
async function getActiveUsersDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       event_data->>'user_tier' AS user_tier,
       COUNT(DISTINCT user_sub) AS active_users
     FROM client_events
     WHERE event_type = 'session_started'
       AND created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [days]
  );
  return success({ data: result.rows });
}

/** Engaged-messaging DAU (connected / sent / listed), from client_events. */
async function getActiveMessagingUsersDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       event_data->>'user_tier' AS user_tier,
       COUNT(DISTINCT user_sub) AS active_messaging_users
     FROM client_events
     WHERE event_type IN ('websocket_connected', 'message_sent', 'channel_messages_listed')
       AND created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [days]
  );
  return success({ data: result.rows });
}

/** Per-user message leaderboard from message_sent client events. */
async function getMessagesPerUser(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT
       user_sub AS user_id,
       event_data->>'user_email' AS user_email,
       event_data->>'user_tier' AS user_tier,
       COUNT(*) AS message_count
     FROM client_events
     WHERE event_type = 'message_sent'
       AND created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY user_sub, event_data->>'user_email', event_data->>'user_tier'
     ORDER BY message_count DESC`,
    [days]
  );
  return success({ data: result.rows });
}

/** Per-tier daily message counts from message_sent client events. */
async function getMessagesPerTierDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       event_data->>'user_tier' AS user_tier,
       COUNT(*) AS message_count
     FROM client_events
     WHERE event_type = 'message_sent'
       AND created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [days]
  );
  return success({ data: result.rows });
}

/** Daily error count + total events (denominator is all events). */
async function getErrorRateDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) AS error_count,
       COUNT(*) AS total_events
     FROM client_events
     WHERE created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY 1
     ORDER BY 1`,
    [days]
  );
  return success({ data: result.rows });
}

/** Ordered funnel step counts + distinct sessions. */
async function getFunnelConversion(
  steps: string[],
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  // steps is a fixed internal allow-list (never user input); build the ordered
  // CASE + IN list from it so the canonical step order drives the funnel.
  const inList = steps.map((_, i) => `$${i + 2}`).join(', ');
  const orderCase = steps.map((s, i) => `WHEN $${i + 2} THEN ${i + 1}`).join(' ');
  const result = await query(
    `SELECT
       event_type AS step,
       COUNT(*) AS event_count,
       COUNT(DISTINCT session_id) AS session_count
     FROM client_events
     WHERE event_type IN (${inList})
       AND created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY event_type
     ORDER BY CASE event_type ${orderCase} ELSE 99 END`,
    [days, ...steps]
  );
  return success({ data: result.rows });
}

const SIGNUP_STEPS = [
  'signup_form_viewed',
  'signup_submitted',
  'signup_confirmation_required',
  'signup_confirmation_completed',
  'signup_failed',
];
const SIGNIN_STEPS = [
  'signin_form_viewed',
  'signin_submitted',
  'signin_succeeded',
  'signin_failed',
  'signin_password_reset_initiated',
];

async function getSignupFunnel(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  return getFunnelConversion(SIGNUP_STEPS, params);
}

async function getSigninFunnel(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  return getFunnelConversion(SIGNIN_STEPS, params);
}

/** Web-vital / timer percentiles from performance client events. */
async function getPageLoadMetrics(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT
       event_type AS metric,
       COUNT(*) AS sample_count,
       ROUND(AVG((event_data->>'perf_value')::numeric), 2) AS avg_ms,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY (event_data->>'perf_value')::numeric)::numeric, 2) AS p50_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (event_data->>'perf_value')::numeric)::numeric, 2) AS p95_ms,
       ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY (event_data->>'perf_value')::numeric)::numeric, 2) AS p99_ms
     FROM client_events
     WHERE event_data->>'record_type' = 'performance'
       AND created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY event_type
     ORDER BY event_type`,
    [days]
  );
  return success({ data: result.rows });
}

/** WebSocket lifecycle counts per day (reconnect spikes = instability). */
async function getConnectionHealthDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = parseInt(params.days || '7', 10);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       SUM(CASE WHEN event_type = 'websocket_connected' THEN 1 ELSE 0 END) AS connected,
       SUM(CASE WHEN event_type = 'websocket_disconnected' THEN 1 ELSE 0 END) AS disconnected,
       SUM(CASE WHEN event_type = 'websocket_reconnected' THEN 1 ELSE 0 END) AS reconnected
     FROM client_events
     WHERE event_type IN ('websocket_connected', 'websocket_disconnected', 'websocket_reconnected')
       AND created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY 1
     ORDER BY 1`,
    [days]
  );
  return success({ data: result.rows });
}

/**
 * GET /analytics/context?userSub=X - Cross-conversation context for a user
 */
async function getConversationContext(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const userSub = params.userSub;
  if (!userSub) {
    return error(400, 'userSub parameter is required');
  }

  const limit = Math.min(parseInt(params.limit || '10', 10), 50);

  const result = await query(
    `SELECT
       ccc.channel_arn,
       ccc.topic,
       ccc.summary,
       ccc.relevance_score,
       ccc.updated_at AS last_activity,
       c.message_count,
       c.agent_type,
       cs.purpose
     FROM cross_conversation_context ccc
     LEFT JOIN conversations c ON c.channel_arn = ccc.channel_arn
     LEFT JOIN conversation_summaries cs ON cs.channel_arn = ccc.channel_arn
       AND cs.version = (
         SELECT MAX(version) FROM conversation_summaries
         WHERE channel_arn = ccc.channel_arn
       )
     WHERE ccc.user_sub = $1
     ORDER BY ccc.updated_at DESC
     LIMIT $2`,
    [userSub, limit]
  );

  return success({
    userSub,
    contexts: result.rows,
  });
}

/**
 * GET /analytics/latency - Response latency breakdown by agent type and delivery option
 *
 * Returns avg/p95 latency metrics broken down by date, agent_type, and delivery_option.
 * Latency components: total_ms (full round trip), latency_ms (Bedrock inference), poll_ms (placeholder polling).
 */
async function getLatencyMetrics(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '7', 10), 90);

  const result = await query(
    `SELECT
       DATE(m.created_at) AS date,
       -- Fall back to the conversation tier so legacy/DIRECT exchanges do not group as 'unknown'.
       COALESCE(e.agent_type, c.agent_type, 'unknown') AS agent_type,
       COALESCE(e.delivery_option, 'unknown') AS delivery_option,
       COUNT(*) AS exchange_count,
       ROUND(AVG(m.total_ms)) AS avg_total_ms,
       ROUND(AVG(m.latency_ms)) AS avg_bedrock_ms,
       ROUND(AVG(m.poll_ms)) AS avg_poll_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.total_ms)) AS p95_total_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.latency_ms)) AS p95_bedrock_ms,
       ROUND(MIN(m.total_ms)) AS min_total_ms,
       ROUND(MAX(m.total_ms)) AS max_total_ms,
       -- TTFF = time to first feedback: the delay from the user's message to the
       -- assistant's "One moment…" placeholder appearing (there is no token
       -- streaming, so this acknowledgment latency is the only pre-answer signal
       -- distinct from total_ms). response_latency_ms already records
       -- placeholder_created_at - user_message_at; null on unpaired/DIRECT rows.
       ROUND(AVG(e.response_latency_ms)) AS avg_ttff_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.response_latency_ms)) AS p95_ttff_ms
     FROM messages m
     LEFT JOIN exchanges e ON e.agent_message_id = m.id
     LEFT JOIN conversations c ON e.conversation_id = c.id
     WHERE m.is_bot = true
       AND m.total_ms IS NOT NULL
       AND m.total_ms > 0
       AND m.created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY DATE(m.created_at), COALESCE(e.agent_type, c.agent_type, 'unknown'), e.delivery_option
     ORDER BY date DESC, agent_type, delivery_option`,
    [days]
  );

  return success({
    data: result.rows,
    columns: [
      'date', 'agent_type', 'delivery_option', 'exchange_count',
      'avg_total_ms', 'avg_bedrock_ms', 'avg_poll_ms',
      'p95_total_ms', 'p95_bedrock_ms',
      'min_total_ms', 'max_total_ms',
      'avg_ttff_ms', 'p95_ttff_ms',
    ],
  });
}

/**
 * Models tab "Model Usage" table. The frontend POSTs queryType `model_usage`
 * (the Athena contract) for BOTH modes; in Aurora we serve it natively from the
 * `messages` table so the primary model list populates instead of showing
 * "No model usage data available". Columns match ModelsTab's table:
 * { model_name, message_count, avg_latency_ms, total_tokens }.
 *
 * Counts only CREATE rows (the canonical message). Archival folds the final
 * model + tokens from the placeholder->final edit onto the CREATE row, so the
 * separate `-UPD` audit row must be excluded or every turn is counted twice.
 */
async function getModelUsage(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '7', 10), 180);

  const result = await query(
    `SELECT
       COALESCE(m.bedrock_model, 'unknown') AS model_name,
       COUNT(*) AS message_count,
       ROUND(AVG(m.latency_ms)) AS avg_latency_ms,
       SUM(COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0)) AS total_tokens
     FROM messages m
     WHERE m.is_bot = true
       AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
       -- Only messages that actually invoked a model. Non-inference bot messages
       -- (welcomes, drift notices, "Battle Mode isn't enabled", placeholders) have
       -- no model and would otherwise pile into a misleading "unknown" bucket that
       -- dwarfs the real models (BUG #36). The Models tab is about which models RAN.
       AND m.bedrock_model IS NOT NULL
       AND m.created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY m.bedrock_model
     ORDER BY message_count DESC`,
    [days]
  );

  return success({ data: result.rows });
}

/**
 * GET /analytics/model-effectiveness - Compare deployed models by intent
 */
async function getModelEffectiveness(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '30', 10), 180);

  const result = await query(
    `SELECT
       COALESCE(m.bedrock_model, 'unknown') AS model_name,
       COALESCE(e.intent, 'unknown') AS intent,
       COUNT(*) AS exchange_count,
       ROUND(AVG(COALESCE(er.relevance_score, 0))::numeric, 1) AS avg_score,
       ROUND(AVG(COALESCE(m.total_ms, e.response_latency_ms, 0))::numeric, 0) AS avg_total_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY COALESCE(m.total_ms, e.response_latency_ms, 0))::numeric, 0) AS p95_total_ms,
       ROUND(
         (COUNT(*) FILTER (WHERE COALESCE(er.is_compliant, true)) * 100.0 / NULLIF(COUNT(*), 0))::numeric,
         1
       ) AS compliance_rate,
       COUNT(*) FILTER (WHERE er.classification = 'excellent') AS excellent_count,
       COUNT(*) FILTER (WHERE er.classification IN ('poor', 'irrelevant', 'error_response')) AS poor_count
     FROM exchanges e
     LEFT JOIN messages m ON e.agent_message_id = m.id
     LEFT JOIN evaluation_results er ON er.exchange_id = e.id
     WHERE e.created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY COALESCE(m.bedrock_model, 'unknown'), COALESCE(e.intent, 'unknown')
     ORDER BY exchange_count DESC, avg_score DESC`,
    [days]
  );

  return success({
    data: result.rows,
    columns: [
      'model_name',
      'intent',
      'exchange_count',
      'avg_score',
      'avg_total_ms',
      'p95_total_ms',
      'compliance_rate',
      'excellent_count',
      'poor_count',
    ],
  });
}

/**
 * Resolve a per-reply USD cost estimate from a row's average token counts + its dominant model
 * (SPEC-ADMIN-CONSOLE-EFFECTIVENESS L0 "Cost" column, decision D4: derived from tokens × the model
 * rate, not billing). Exported + pure so it's unit-testable without a database. `null` (never 0) when
 * the rate table can't price the model — the honesty contract from model-rate-table.ts. pg returns
 * numeric aggregates as strings, so coerce.
 */
export function resolveReplyCostUsd(row: {
  dominant_model?: string | null;
  avg_input_tokens?: string | number | null;
  avg_output_tokens?: string | number | null;
}): number | null {
  const modelId = row.dominant_model || undefined;
  if (!modelId) return null;
  const toNum = (v: string | number | null | undefined): number | undefined =>
    v === null || v === undefined ? undefined : Number(v);
  return estimateStepCostUsd({
    modelId,
    tokensIn: toNum(row.avg_input_tokens),
    tokensOut: toNum(row.avg_output_tokens),
  });
}

/**
 * Effectiveness L0 dashboard (SPEC-ADMIN-CONSOLE-EFFECTIVENESS §5): one row per intent, the two-stage
 * quality split plus latency, cost, and the tool lens — the "how effective is each capability" question
 * the artifact-type tabs cannot answer. Columns:
 *  - Classification: `avg_confidence` (high/medium/low → 100/50/0) + `reroute_rate` (was_rerouted share).
 *  - Execution: DIRECT → `direct_relevance` (Pass A); Task → `task_completion_rate` × `flow_composite`
 *    (the documented 30/25/15/15/15 weighting over intent_flows).
 *  - Latency: `avg_total_ms`, `p95_total_ms`.
 *  - Cost: token averages + `dominant_model`; `cost_per_reply_usd` resolved in JS (D4).
 *  - Tools (P2): `tool_calls`, `tool_errors`, `tool_error_rate` from steps[].tools[] in message metadata.
 *
 * Ranking (worst-first) and status colors are the frontend's job via metricTargets; this returns the
 * raw metrics. Eval scores are pre-aggregated to ONE relevance per exchange so multiple Pass-A runs
 * never multiply the exchange counts.
 *
 * Serves BOTH L0 and L1 (§5): with no `intent` param it returns every intent (the dashboard); with
 * `intent` set it returns that one intent's row (the drill). `$2` is the intent-or-NULL filter — the
 * `$2 IS NULL OR col = $2` idiom keeps it one query with a fixed param list, no dynamic SQL.
 */
async function getIntentEffectiveness(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const intent = params.intent || null; // null => L0 (all intents); set => L1 (one intent)

  const result = await query(
    `WITH ex_agg AS (
       SELECT e.intent,
              COUNT(DISTINCT e.id) AS exchange_count,
              COUNT(DISTINCT e.id) FILTER (WHERE e.task_id IS NULL) AS direct_count,
              COUNT(DISTINCT e.task_id) AS task_count,
              ROUND(AVG(CASE e.intent_confidence
                          WHEN 'high' THEN 100 WHEN 'medium' THEN 50 WHEN 'low' THEN 0 END)::numeric, 1)
                AS avg_confidence,
              ROUND((COUNT(DISTINCT e.id) FILTER (WHERE e.was_rerouted) * 100.0
                     / NULLIF(COUNT(DISTINCT e.id), 0))::numeric, 1) AS reroute_rate,
              ROUND(AVG(er.relevance_score) FILTER (WHERE e.task_id IS NULL)::numeric, 1) AS direct_relevance,
              ROUND(AVG(m.total_ms)::numeric, 0) AS avg_total_ms,
              ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.total_ms)::numeric, 0) AS p95_total_ms,
              ROUND(AVG(m.input_tokens)::numeric, 0) AS avg_input_tokens,
              ROUND(AVG(m.output_tokens)::numeric, 0) AS avg_output_tokens,
              MODE() WITHIN GROUP (ORDER BY m.bedrock_model) AS dominant_model
         FROM exchanges e
         LEFT JOIN messages m ON e.agent_message_id = m.id
         -- One relevance per exchange (a re-scored exchange has multiple evaluation_results rows;
         -- averaging them here keeps the LEFT JOIN 1:1 so exchange_count is not inflated).
         LEFT JOIN (
           SELECT exchange_id, AVG(relevance_score) AS relevance_score
             FROM evaluation_results
            WHERE evaluation_type = 'exchange'
            GROUP BY exchange_id
         ) er ON er.exchange_id = e.id
        WHERE e.created_at >= NOW() - INTERVAL '1 day' * $1
          AND e.intent IS NOT NULL
          AND ($2::varchar IS NULL OR e.intent = $2)
        GROUP BY e.intent
     ),
     flow_agg AS (
       SELECT f.intent,
              ROUND((COUNT(*) FILTER (WHERE f.status = 'completed') * 100.0
                     / NULLIF(COUNT(*), 0))::numeric, 1) AS task_completion_rate,
              ROUND(AVG( COALESCE(f.outcome_score,0) * 0.30
                       + COALESCE(f.information_score,0) * 0.25
                       + COALESCE(f.efficiency_score,0) * 0.15
                       + COALESCE(f.context_retention_score,0) * 0.15
                       + COALESCE(f.ux_score,0) * 0.15 )::numeric, 1) AS flow_composite
         FROM intent_flows f
        WHERE f.created_at >= NOW() - INTERVAL '1 day' * $1
          AND ($2::varchar IS NULL OR f.intent = $2)
        GROUP BY f.intent
     ),
     tool_agg AS (
       SELECT e.intent,
              COUNT(*) AS tool_calls,
              COUNT(*) FILTER (WHERE (t->>'ok') = 'false') AS tool_errors
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         -- jsonb_typeof guards a non-array 'steps'/'tools' (COALESCE only catches SQL NULL, not a JSON
         -- null/scalar) - one such row would otherwise error the WHOLE dashboard query, not just itself.
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(m.metadata->'steps') = 'array' THEN m.metadata->'steps' ELSE '[]'::jsonb END
         ) s
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(s->'tools') = 'array' THEN s->'tools' ELSE '[]'::jsonb END
         ) t
        WHERE e.created_at >= NOW() - INTERVAL '1 day' * $1
          AND e.intent IS NOT NULL
          AND ($2::varchar IS NULL OR e.intent = $2)
        GROUP BY e.intent
     )
     SELECT ex_agg.intent,
            ex_agg.exchange_count,
            ex_agg.direct_count,
            ex_agg.task_count,
            ex_agg.avg_confidence,
            ex_agg.reroute_rate,
            ex_agg.direct_relevance,
            -- NULL (not 0) when the flow evaluator has not scored this intent's tasks yet, so the UI
            -- renders "—" rather than a misleading red 0%. A genuine 0% (flows exist, none completed)
            -- still comes through as 0 from flow_agg. Distinguishes "no data yet" from "actually failing".
            fa.task_completion_rate,
            fa.flow_composite,
            ex_agg.avg_total_ms,
            ex_agg.p95_total_ms,
            ex_agg.avg_input_tokens,
            ex_agg.avg_output_tokens,
            ex_agg.dominant_model,
            COALESCE(ta.tool_calls, 0) AS tool_calls,
            COALESCE(ta.tool_errors, 0) AS tool_errors,
            ROUND(COALESCE(ta.tool_errors * 100.0 / NULLIF(ta.tool_calls, 0), 0)::numeric, 1) AS tool_error_rate
       FROM ex_agg
       LEFT JOIN flow_agg fa ON fa.intent = ex_agg.intent
       LEFT JOIN tool_agg ta ON ta.intent = ex_agg.intent
      ORDER BY ex_agg.exchange_count DESC`,
    [days, intent]
  );

  // Cost column (D4): resolve tokens × model rate to a per-reply USD estimate in JS (the rate table is
  // TS), keeping the null-honesty contract. The raw token averages + dominant_model stay on the row.
  const rows = (result.rows as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    cost_per_reply_usd: resolveReplyCostUsd(r as Parameters<typeof resolveReplyCostUsd>[0]),
  }));

  return success({
    data: rows,
    columns: [
      'intent', 'exchange_count', 'direct_count', 'task_count',
      'avg_confidence', 'reroute_rate',
      'direct_relevance', 'task_completion_rate', 'flow_composite',
      'avg_total_ms', 'p95_total_ms',
      'avg_input_tokens', 'avg_output_tokens', 'dominant_model', 'cost_per_reply_usd',
      'tool_calls', 'tool_errors', 'tool_error_rate',
    ],
  });
}

/**
 * Effectiveness L2 for a DIRECT intent (§5): the exchange list for one intent — each single-turn
 * exchange with its Pass A relevance, latency, tokens, and model, so the drill goes L1 → the exchanges
 * that made up its numbers. One relevance per exchange (same 1:1 pre-aggregation as L0). Ordered newest
 * first, bounded. Honest-empty without an `intent`. (Task intents drill to the task list via
 * `task_details?intent=`; a task's turns then open via `task_timeline`.)
 */
async function getIntentExchanges(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const intent = params.intent;
  if (!intent) return success({ data: [] });
  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);

  const result = await query(
    `SELECT e.id AS exchange_id,
            e.agent_message_id,
            e.task_id,
            e.intent_confidence,
            e.was_rerouted,
            e.delivery_option,
            er.relevance_score,
            m.total_ms,
            m.input_tokens,
            m.output_tokens,
            m.bedrock_model,
            e.created_at
       FROM exchanges e
       LEFT JOIN messages m ON e.agent_message_id = m.id
       LEFT JOIN (
         SELECT exchange_id, AVG(relevance_score) AS relevance_score
           FROM evaluation_results
          WHERE evaluation_type = 'exchange'
          GROUP BY exchange_id
       ) er ON er.exchange_id = e.id
      WHERE e.intent = $1
        AND e.created_at >= NOW() - INTERVAL '1 day' * $2
      ORDER BY e.created_at DESC
      LIMIT $3`,
    [intent, days, limit]
  );
  return success({ data: result.rows });
}

/**
 * Shared per-variant result builder for the Experiments tab and the
 * recommendation endpoint.
 *
 * Reads experiment_id / variant_id / was_fallback from the joined `messages`
 * row (m), NOT from `exchanges` (e): the exchange-pairing inserts in
 * kinesis-archival do not populate those exchange columns, so reading them
 * from `exchanges` returns nothing. `messages` is populated at archival time.
 *
 * Battle traffic is excluded by default (SPEC-BATTLE rollup-safety invariant):
 * a battle response carries an experiment_id but assignmentMode='battle', so
 * it must not be counted into the probabilistic variant comparison. There is
 * no assignment_mode column yet, so we read it from the message metadata JSON
 * (it lives at metadata.analytics.assignmentMode or metadata.assignmentMode).
 * Pass includeBattle=true to fold battle traffic back in.
 *
 * Task completion is computed directly from the exchange columns
 * (task_id / task_status), which the pairing DOES populate.
 */
/**
 * Scan the UserFeedback table for thumbs on experiment-served replies and
 * bucket them per (variant, intent) for the join. Paginated; projects only the
 * join + filter fields. Fails OPEN — if the table is unset or the scan errors,
 * the results still render, just without the thumbs column (logged server-side).
 */
async function scanVariantFeedback(
  days: number,
  experimentId: string | undefined,
  includeBattle: boolean,
): Promise<Map<string, VariantFeedback>> {
  if (!FEEDBACK_TABLE) return new Map();
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const items: FeedbackItem[] = [];
  try {
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const res: any = await ddbDocClient.send(
        new ScanCommand({
          TableName: FEEDBACK_TABLE,
          // Alias every name: experimentId/variantId/intent etc. avoid any
          // reserved-word surprises and document the projection intent.
          ProjectionExpression: '#eid, #vid, #intent, #fb, #am, #ca',
          FilterExpression: experimentId
            ? '#eid = :eid'
            : 'attribute_exists(#eid) AND #eid <> :null',
          ExpressionAttributeNames: {
            '#eid': 'experimentId',
            '#vid': 'variantId',
            '#intent': 'intent',
            '#fb': 'feedback',
            '#am': 'assignmentMode',
            '#ca': 'createdAt',
          },
          ExpressionAttributeValues: experimentId ? { ':eid': experimentId } : { ':null': null },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const it of res.Items || []) items.push(it as FeedbackItem);
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
  } catch (err) {
    console.warn('[experiment-feedback] thumbs scan failed (rendering without thumbs):', err);
    return new Map();
  }
  return aggregateVariantFeedback(items, sinceMs, includeBattle);
}

/**
 * Scan the BattleOutcome table for head-to-head picks and bucket wins per
 * (variant, intent). Paginated; fails OPEN — unset table (/battle off) or a
 * scan error yields an empty map and the results render without battle wins.
 */
async function scanBattleWins(
  days: number,
  experimentId: string | undefined,
): Promise<Map<string, number>> {
  if (!BATTLE_OUTCOME_TABLE) return new Map();
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const items: BattleOutcomeItem[] = [];
  try {
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const res: any = await ddbDocClient.send(
        new ScanCommand({
          TableName: BATTLE_OUTCOME_TABLE,
          ProjectionExpression: '#eid, #vid, #intent, #winner, #ca',
          FilterExpression: experimentId
            ? '#eid = :eid'
            : 'attribute_exists(#eid) AND #eid <> :null',
          ExpressionAttributeNames: {
            '#eid': 'experimentId',
            '#vid': 'variantId',
            '#intent': 'intent',
            '#winner': 'winner',
            '#ca': 'chosenAt',
          },
          ExpressionAttributeValues: experimentId ? { ':eid': experimentId } : { ':null': null },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const it of res.Items || []) items.push(it as BattleOutcomeItem);
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
  } catch (err) {
    console.warn('[experiment-feedback] battle-wins scan failed (rendering without battle wins):', err);
    return new Map();
  }
  return aggregateBattleWins(items, sinceMs);
}

async function fetchExperimentRows(
  days: number,
  experimentId: string | undefined,
  includeBattle: boolean
): Promise<any[]> {
  const queryParams: any[] = [days];
  let where = `WHERE m.experiment_id IS NOT NULL
       AND e.created_at >= NOW() - INTERVAL '1 day' * $1`;

  if (!includeBattle) {
    where += ` AND COALESCE(m.metadata->'analytics'->>'assignmentMode', m.metadata->>'assignmentMode', 'probabilistic') = 'probabilistic'`;
  }
  if (experimentId) {
    queryParams.push(experimentId);
    where += ` AND m.experiment_id = $${queryParams.length}`;
  }

  const result = await query(
    `SELECT
       m.experiment_id,
       m.variant_id,
       COALESCE(m.bedrock_model, 'unknown') AS model_name,
       COALESCE(e.intent, 'unknown') AS intent,
       e.agent_type,
       COUNT(*) AS exchange_count,
       ROUND(AVG(COALESCE(er.relevance_score, 0))::numeric, 1) AS avg_score,
       ROUND(AVG(COALESCE(m.total_ms, e.response_latency_ms, 0))::numeric, 0) AS avg_total_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY COALESCE(m.total_ms, e.response_latency_ms, 0))::numeric, 0) AS p95_total_ms,
       ROUND(AVG(COALESCE(m.input_tokens, 0))::numeric, 0) AS avg_input_tokens,
       ROUND(AVG(COALESCE(m.output_tokens, 0))::numeric, 0) AS avg_output_tokens,
       ROUND(AVG(COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0))::numeric, 0) AS avg_tokens,
       ROUND(
         (COUNT(*) FILTER (WHERE COALESCE(er.is_compliant, true)) * 100.0 / NULLIF(COUNT(*), 0))::numeric,
         1
       ) AS compliance_rate,
       COUNT(*) FILTER (WHERE m.was_fallback = true) AS fallback_count,
       COUNT(DISTINCT e.task_id) FILTER (WHERE e.task_id IS NOT NULL) AS task_count,
       COUNT(DISTINCT e.task_id) FILTER (WHERE e.task_status = 'completed') AS task_completed_count
     FROM exchanges e
     JOIN messages m ON e.agent_message_id = m.id
     LEFT JOIN evaluation_results er ON er.exchange_id = e.id
     ${where}
     GROUP BY m.experiment_id, m.variant_id, COALESCE(m.bedrock_model, 'unknown'), COALESCE(e.intent, 'unknown'), e.agent_type
     ORDER BY m.experiment_id, m.variant_id`,
    queryParams
  );

  // Human-signal joins: bucket the DynamoDB thumbs + battle picks once, then
  // attach per (variant, intent) row. Both are
  // separate signals alongside the evaluator's avg_score — never blended into it.
  // (Battle wins are not gated by includeBattle: a pick only exists from a battle.)
  const [feedbackByVariantIntent, battleWinsByVariantIntent] = await Promise.all([
    scanVariantFeedback(days, experimentId, includeBattle),
    scanBattleWins(days, experimentId),
  ]);

  // A (variant, intent) can span more than one row when a fallback produced a
  // different bedrock_model for some exchanges. Thumbs live at the (variant,
  // intent) grain, so attach the full tally to the FIRST row of each key and
  // zero the rest — otherwise the per-variant sum (frontend + recommendation)
  // would double-count the same thumbs.
  const thumbsAttached = new Set<string>();

  // Derive cost, rates, and the needs-more-data flag in code (the rate table
  // and the sample threshold are not SQL concerns).
  return result.rows.map((r: any) => {
    const n = Number(r.exchange_count) || 0;
    const taskCount = Number(r.task_count) || 0;
    const taskCompleted = Number(r.task_completed_count) || 0;
    const avgCostUsd = estimateStepCostUsd({
      modelKey: bedrockModelIdToKey(r.model_name),
      tokensIn: Number(r.avg_input_tokens) || 0,
      tokensOut: Number(r.avg_output_tokens) || 0,
    });
    const dedupKey = feedbackKey(r.variant_id, r.intent);
    const firstForKey = !thumbsAttached.has(dedupKey);
    const thumbs = firstForKey
      ? feedbackColumnsFor(feedbackByVariantIntent, r.variant_id, r.intent)
      : { thumbs_up: 0, thumbs_down: 0, feedback_count: 0, approval_rate: null };
    const battle = firstForKey
      ? battleColumnsFor(battleWinsByVariantIntent, r.variant_id, r.intent)
      : { battle_wins: null };
    thumbsAttached.add(dedupKey);
    return {
      ...r,
      avg_cost_usd: avgCostUsd, // null when the model/usage can't be priced (honesty contract)
      fallback_rate: n > 0 ? Math.round((Number(r.fallback_count) / n) * 1000) / 10 : 0,
      task_completion_rate: taskCount > 0 ? Math.round((taskCompleted / taskCount) * 1000) / 10 : null,
      ...thumbs, // thumbs_up, thumbs_down, feedback_count, approval_rate (null = no signal)
      ...battle, // battle_wins (null = no picks credit this variant/intent)
      needs_more_data: n < MIN_SAMPLE_PER_VARIANT,
    };
  });
}

const EXPERIMENT_COLUMNS = [
  'experiment_id', 'variant_id', 'model_name', 'intent', 'agent_type',
  'exchange_count', 'avg_score', 'avg_total_ms', 'p95_total_ms',
  'avg_tokens', 'avg_cost_usd', 'compliance_rate', 'fallback_count', 'fallback_rate',
  'task_count', 'task_completion_rate',
  // Human-signal joins — separate from avg_score.
  'thumbs_up', 'thumbs_down', 'feedback_count', 'approval_rate',
  'battle_wins',
  'needs_more_data',
];

/**
 * GET /analytics/experiments - A/B experiment results by variant.
 * Query params: days, experimentId, includeBattle ('true' folds battle traffic in).
 */
async function getExperimentResults(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const rows = await fetchExperimentRows(days, params.experimentId, params.includeBattle === 'true');
  return success({ data: rows, columns: EXPERIMENT_COLUMNS });
}

/**
 * GET /analytics/experiments/recommendation - LLM-generated recommendation
 * from the actual test outcome. Descriptive guidance only; it never reroutes
 * traffic. Returns { verdict, confidence, rationale, variants }.
 *
 * verdict: 'promote_control' | 'promote_treatment' | 'keep_running' | 'inconclusive'
 */
async function getExperimentRecommendation(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const experimentId = params.experimentId;
  if (!experimentId) {
    return error(400, 'experimentId is required');
  }

  const rows = await fetchExperimentRows(days, experimentId, false);
  // Collapse to one row per variant (sum across intents/tiers) for the summary.
  const byVariant = new Map<string, any>();
  for (const r of rows) {
    const key = r.variant_id || 'unknown';
    const acc = byVariant.get(key) || {
      variant_id: key, model_name: r.model_name, exchange_count: 0,
      avg_score: 0, avg_total_ms: 0, avg_cost_usd: 0, compliance_rate: 0,
      fallback_rate: 0, task_completion_rate: null,
      thumbs_up: 0, thumbs_down: 0, feedback_count: 0, battle_wins: 0,
      _scoreWeight: 0, _taskWeight: 0,
    };
    const n = Number(r.exchange_count) || 0;
    acc.exchange_count += n;
    acc.avg_score += (Number(r.avg_score) || 0) * n;
    acc.avg_total_ms += (Number(r.avg_total_ms) || 0) * n;
    acc.avg_cost_usd += (Number(r.avg_cost_usd) || 0) * n;
    acc.compliance_rate += (Number(r.compliance_rate) || 0) * n;
    acc.fallback_rate += (Number(r.fallback_rate) || 0) * n;
    acc._scoreWeight += n;
    // Thumbs are raw counts at the (variant,intent) grain — sum them straight
    // into the variant total (no exchange-count weighting).
    acc.thumbs_up += Number(r.thumbs_up) || 0;
    acc.thumbs_down += Number(r.thumbs_down) || 0;
    acc.feedback_count += Number(r.feedback_count) || 0;
    acc.battle_wins += Number(r.battle_wins) || 0;
    if (r.task_completion_rate != null) {
      acc.task_completion_rate = (acc.task_completion_rate || 0) + r.task_completion_rate * n;
      acc._taskWeight += n;
    }
    byVariant.set(key, acc);
  }
  const variants = Array.from(byVariant.values()).map((v) => {
    const w = v._scoreWeight || 1;
    return {
      variant_id: v.variant_id,
      model_name: v.model_name,
      exchange_count: v.exchange_count,
      avg_score: Math.round((v.avg_score / w) * 10) / 10,
      avg_total_ms: Math.round(v.avg_total_ms / w),
      avg_cost_usd: Math.round((v.avg_cost_usd / w) * 1e6) / 1e6,
      compliance_rate: Math.round((v.compliance_rate / w) * 10) / 10,
      fallback_rate: Math.round((v.fallback_rate / w) * 10) / 10,
      task_completion_rate: v._taskWeight ? Math.round((v.task_completion_rate / v._taskWeight) * 10) / 10 : null,
      thumbs_up: v.thumbs_up,
      thumbs_down: v.thumbs_down,
      feedback_count: v.feedback_count,
      // Human approval %, or null when no thumbs yet — a separate signal from avg_score.
      approval_rate: v.feedback_count > 0 ? Math.round((v.thumbs_up / v.feedback_count) * 1000) / 10 : null,
      // Head-to-head /battle picks this variant won (null when none) — the fast human signal.
      battle_wins: v.battle_wins > 0 ? v.battle_wins : null,
    };
  });

  const minN = variants.length ? Math.min(...variants.map((v) => v.exchange_count)) : 0;

  // Short-circuit: not enough data, or not a 2-variant comparison. No model call.
  if (variants.length < 2 || minN < MIN_SAMPLE_PER_VARIANT) {
    return success({
      verdict: 'inconclusive',
      confidence: 'low',
      rationale: variants.length < 2
        ? 'Only one variant has recorded traffic, so there is nothing to compare yet. Let both variants accumulate conversations.'
        : `The smallest variant has ${minN} exchanges, below the ${MIN_SAMPLE_PER_VARIANT}-exchange threshold for a reliable read. Keep the experiment running before deciding.`,
      variants,
      experimentId,
    });
  }

  const llm = await generateRecommendation(experimentId, variants);
  return success({ ...llm, variants, experimentId });
}

/**
 * Ask a model to turn the per-variant metrics into a verdict + rationale.
 * Falls back to a deterministic heuristic if the model call or parse fails,
 * so the endpoint always returns a usable recommendation.
 */
async function generateRecommendation(
  experimentId: string,
  variants: any[]
): Promise<{ verdict: string; confidence: string; rationale: string }> {
  const prompt = `You are an experimentation analyst for an enterprise AI platform. An operator ran an A/B test comparing model variants on the same intent. Recommend what to do, based ONLY on the numbers below.

Variants (control is the baseline, treatment is the challenger):
${JSON.stringify(variants, null, 2)}

Scoring guidance:
- "avg_score" is response quality 0-100 (higher better). "task_completion_rate" is the percent of multi-step tasks the variant actually completed (higher better) and is the most important agent metric when present.
- "compliance_rate" (higher better), "fallback_rate" (lower better), "avg_total_ms" latency (lower better), "avg_cost_usd" per response (lower better).
- "approval_rate" is the user thumbs-up percent over "feedback_count" ratings (higher better) — a direct HUMAN signal. Weigh it alongside avg_score, but treat it cautiously when feedback_count is small (single digits) and as null/ignore when it is null (no ratings yet).
- "battle_wins" is how many head-to-head /battle rounds this variant was explicitly picked to win (higher better) — the strongest direct HUMAN preference signal when present. Compare the two variants' battle_wins; ignore when null (no battles run).
- A winner should be clearly better on quality and/or task completion without a serious regression on compliance or fallback. A cheaper/faster variant that matches the other on quality and completion is a win for cost.

Respond with ONLY a JSON object, no preamble:
{"verdict": "promote_control" | "promote_treatment" | "keep_running" | "inconclusive", "confidence": "low" | "medium" | "high", "rationale": "one short paragraph citing the actual numbers"}`;

  try {
    const resp = await bedrockClient.send(new InvokeModelCommand({
      modelId: RECOMMENDATION_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 400,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
    }));
    const body = JSON.parse(new TextDecoder().decode(resp.body));
    const text: string = body?.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const validVerdicts = ['promote_control', 'promote_treatment', 'keep_running', 'inconclusive'];
      if (validVerdicts.includes(parsed.verdict) && typeof parsed.rationale === 'string') {
        return {
          verdict: parsed.verdict,
          confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'medium',
          rationale: parsed.rationale,
        };
      }
    }
    console.warn('[experiment-recommendation] model output not parseable, using heuristic');
  } catch (err) {
    console.warn('[experiment-recommendation] model call failed, using heuristic:', err);
  }

  return heuristicRecommendation(variants);
}

/** Deterministic fallback so a recommendation is always available. */
function heuristicRecommendation(variants: any[]): { verdict: string; confidence: string; rationale: string } {
  const score = (v: any) =>
    (v.task_completion_rate ?? v.avg_score ?? 0) - v.fallback_rate * 0.5;
  const sorted = [...variants].sort((a, b) => score(b) - score(a));
  const [best, next] = sorted;
  const margin = score(best) - score(next);
  if (margin < 3) {
    return {
      verdict: 'keep_running',
      confidence: 'low',
      rationale: `${best.variant_id} and ${next.variant_id} are within ${margin.toFixed(1)} points on the combined quality/completion signal; the difference is not yet decisive.`,
    };
  }
  return {
    verdict: best.variant_id === 'control' ? 'promote_control' : 'promote_treatment',
    confidence: margin > 10 ? 'high' : 'medium',
    rationale: `${best.variant_id} (${best.model_name}) leads on the combined quality/completion signal (${score(best).toFixed(1)} vs ${score(next).toFixed(1)}) with a ${best.fallback_rate}% fallback rate.`,
  };
}
