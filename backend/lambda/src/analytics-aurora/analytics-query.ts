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
import { imageGenModelIdToKey } from '../lib/image-gen-models.js';
import { callerIsAdmin, callerCanReadArchive, isAdminIamEnforcedCall } from '../lib/auth.js';
import { queryTypeAllowedOnPath } from '../lib/admin-capability-map.js';
import { ceilingForRequest, scopeAnalyticsRows, type ClassificationCeiling } from '../lib/caller-scope.js';

// A14 Scoped: the pool the caller's classification ceiling is resolved against.
const USER_POOL_ID = process.env.USER_POOL_ID || '';
import { recordModerationAction, adminListEvents } from './admin-conversations-aurora.js';
import {
  aggregateVariantFeedback,
  aggregateBattleWinsByVariant,
  flattenBattleOutcomeItem,
  feedbackColumnsFor,
  feedbackKey,
  battleWinKey,
  selectVariantFeedbackRecords,
  selectBattlePicks,
  type FeedbackRecord,
  type VariantFeedback,
  type BattleOutcomeItem,
} from './variant-feedback.js';
import {
  welchTTest,
  poolGroups,
  requiredSampleForMean,
  humanPickTest,
  twoProportionTest,
  decideVerdict,
  evaluateExperimentOutcome,
  type GroupStat,
  type PrimaryEval,
  type GuardrailEval,
  type Verdict,
  type Confidence,
  type OutcomeObjective,
} from '../lib/experiment-stats.js';
import type {
  ExperimentObjective,
  ObjectiveGuardrail,
  ExperimentObjectiveMetric,
  ExperimentDecision,
} from '../lib/experiment-manager.js';
// The classification shadow gate (DESIGN §5). The replay itself runs in its own batch Lambda, which
// also OPENS the run (it is the only side that can reach the database); what happens here is the
// read side — list runs, read a run's labels, record an adjudication, and compute the gate verdict
// from whatever has been ruled on so far.
import {
  listReplayRuns,
  listReplayLabels,
  getReplayRun,
  adjudicateReplayLabel,
} from './classifier-replay.js';
import { evaluateClassifierGate } from '../lib/classifier-gate.js';

// Minimum exchanges per variant before a result is treated as decision-grade.
// Below this the variant is flagged needs_more_data and the recommendation
// endpoint returns an inconclusive verdict without spending a model call.
//
// The default is 5, chosen so the experiment LIFECYCLE is visible on a fresh deployment. Most people
// meeting this feature want to watch a variant get created, take traffic, and produce a verdict - and
// at a statistically respectable floor (30+ per variant, and a battle turn is two live model calls)
// that first verdict is tens of minutes of duelling away. A floor of 30 makes the honest choice and
// the demonstrable one mutually exclusive.
//
// FIVE IS A DEMONSTRATION FLOOR, NOT A DECISION FLOOR. A verdict over five exchanges per variant is
// real arithmetic on real traffic, but it is underpowered: the confidence it reports will usually be
// 'low' and the interval wide, which is the honest reading and not a defect.
//
// RAISING IT IS RECOMMENDED once a deployment is past that first look, and before anyone routes
// traffic or retires a variant on a verdict - 30 per variant is the usual starting point, higher for
// a noisy metric or a small effect. The recommendation is advisory in any case and never
// auto-applies (INV-1), but "advisory" is not a licence to read an underpowered verdict as a result.
//
// Per VARIANT, so the SMALLEST arm gates the result. Set via the `minSamplePerVariant` context key.
const MIN_SAMPLE_PER_VARIANT = Math.max(
  1,
  Number(process.env.MIN_SAMPLE_PER_VARIANT) || 5,
);

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
      // A14 Scoped: resolve the caller's classification ceiling and narrow the
      // result rows. Full (null) only on a Cognito-JWT call; an enforced call fails
      // closed to the floor if the caller cannot be identified (ceilingForRequest).
      const ceiling: ClassificationCeiling = isAdminIamEnforcedCall(event)
        ? await ceilingForRequest(event, USER_POOL_ID)
        : null;
      return handlePostQuery(event.body, ceiling, callerSub);
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
 * separate table/pipeline needed. The reviewer's verdict IS persisted, in its own
 * `flagged_review` table (migration 014) — the flagged list stays derived, and
 * re-evaluating an exchange never discards a human review.
 */
async function getFlaggedResponses(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  if (params.action === 'review') {
    const exchangeId = params.exchangeId;
    // `reviewAction` / `notes` are the names the admin console already sends (AdminDashboard
    // handleReviewResponse); the backend matches the deployed client rather than the other way round.
    // Only these two verdicts are storable: 'pending' is the ABSENCE of a row, not a value, so a
    // reviewer can never write the state that means "nobody has looked at this".
    const status =
      params.reviewAction === 'approved' || params.reviewAction === 'rejected' ? params.reviewAction : null;
    if (!exchangeId || !status) {
      return success({ reviewed: false, error: "exchangeId and reviewAction ('approved'|'rejected') required" });
    }
    // Re-reviewing replaces the verdict rather than accumulating rows: the list shows one current
    // state per exchange, and an admin correcting a mis-click should not leave the old verdict behind.
    await query(
      `INSERT INTO flagged_review (exchange_id, review_status, reviewer_sub, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (exchange_id) DO UPDATE SET
         review_status = EXCLUDED.review_status,
         reviewer_sub  = EXCLUDED.reviewer_sub,
         note          = EXCLUDED.note,
         reviewed_at   = NOW()`,
      [exchangeId, status, params.callerSub || null, params.notes || null],
    );
    return success({ reviewed: true, exchangeId, reviewStatus: status });
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
            -- No review row means nobody has looked at it yet. 'pending' is the absence of a
            -- verdict, which is why it is derived here rather than stored.
            COALESCE(fr.review_status, 'pending') AS review_status,
            fr.reviewer_sub AS reviewed_by,
            fr.note AS review_note,
            fr.reviewed_at,
            um.content AS user_message,
            COALESCE(am.updated_content, am.content) AS agent_response
       FROM evaluation_results er
       JOIN exchanges e ON er.exchange_id = e.id
       LEFT JOIN conversations c ON e.conversation_id = c.id
       LEFT JOIN messages um ON e.user_message_id = um.id
       LEFT JOIN messages am ON e.agent_message_id = am.id
       LEFT JOIN flagged_review fr ON fr.exchange_id = e.id
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
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  // Optional intent filter — this is also the Effectiveness L2 task list (drill from an intent to its
  // tasks). `$3 IS NULL` keeps the unfiltered Quality>Tasks behavior; set it for the L2 drill.
  const intent = params.intent || null;
  const agentType = params.agentType || null; // Effectiveness "one assistant" scope (agent_type = responder).
  // total = number of DISTINCT tasks matching (COUNT(*) OVER() runs over the grouped result set), so the
  // console can page server-side. LIMIT/OFFSET apply after grouping (the page is a page of tasks).
  const result = await query(
    `SELECT task_id,
            -- One task lives in one channel, so MAX picks that channel_arn for the "view conversation"
            -- deep-link (the Effectiveness drill jumps from a task to its raw conversation log).
            MAX(channel_arn) AS channel_arn,
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
            COUNT(task_transition) AS transition_count,
            COUNT(*) OVER() AS total_count
       FROM exchanges
      WHERE task_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '1 day' * $1
        AND ($3::varchar IS NULL OR intent = $3)
        AND ($4::varchar IS NULL OR agent_type = $4)
      GROUP BY task_id
      ORDER BY MAX(created_at) DESC
      LIMIT $2 OFFSET $5`,
    [days, limit, intent, agentType, offset]
  );
  const total = result.rows[0]?.total_count != null ? Number(result.rows[0].total_count) : result.rows.length;
  return success({ data: result.rows, total, limit, offset });
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
            e.channel_arn,
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
  // THE AUDIT OF ONE TURN, from the ledger. `latency_metrics` aggregates; this shows the
  // calculation for a single channel so a human can check it against the stream, which is the whole
  // point of the ledger existing. Unlisted queryTypes default to the `view-analytics` capability.
  turn_latency_audit: { fn: getTurnLatencyAudit, dataKey: 'data' },
  // Task resolution, measured SEPARATELY from turn latency and deliberately never mixed into it: a
  // four-hour task with twenty seconds of assistant time is healthy, and only a different denominator
  // can say so.
  task_resolution: { fn: getTaskResolution, dataKey: 'data' },
  model_effectiveness: { fn: getModelEffectiveness, dataKey: 'data' },
  experiment_results: { fn: getExperimentResults, dataKey: 'data' },
  // The per-exchange drill-down behind one axis of one experiment (DESIGN §4.3). A COMPANION query:
  // the aggregate rows stay aggregate, and this serves detail only when a caller asks for it.
  //
  // THREE queries, not one, because the verdict rests on three different populations (§4.3 C3):
  // exchanges (metric averages, split by axis into probabilistic and battle turns), votes
  // (approval), and picks (the human axis). One drill-down serving all of them would be filtered
  // wrongly for at least two.
  experiment_exchanges: { fn: getExperimentExchanges, dataKey: 'data' },
  experiment_feedback: { fn: getExperimentFeedback, dataKey: 'data' },
  experiment_picks: { fn: getExperimentPicks, dataKey: 'data' },
  // Classification shadow gate (DESIGN §5). The measurement a `classification` experiment needs, so
  // the decision rests on labelling rather than on the evaluator's opinion of the answer downstream.
  classifier_replays: { fn: getClassifierReplays, dataKey: 'data' },
  classifier_replay: { fn: getClassifierReplayDetail, dataKey: 'data' },
  classifier_replay_labels: { fn: getClassifierReplayLabels, dataKey: 'data' },
  classifier_replay_start: { fn: postClassifierReplayStart, dataKey: 'data' },
  classifier_replay_adjudicate: { fn: postClassifierAdjudication, dataKey: 'data' },
  // Recommendation returns { verdict, confidence, rationale, variants } at top
  // level; the shim mirrors `variants` into `data` and passes the rest through.
  experiment_recommendation: { fn: getExperimentRecommendation, dataKey: 'variants' },
  // Superset parity: every metric Athena serves, Aurora serves too (no
  // capability is Athena-only). intent/user-activity read the message tables;
  // the rest read client_events, which IS populated: the /events handler writes straight to
  // Aurora through the data-plane Lambda (client-events.ts -> ingestClientEvents), because the
  // Firehose->S3->Glue pipeline is Athena-mode only. Empty here means no client traffic, not no writer.
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
    // experiment_exchanges: which axis (metrics/battle) and an optional per-variant narrowing.
    'axis', 'variantId',
    // Classification shadow gate (DESIGN §5): replay lifecycle + adjudication.
    'runId', 'labelId', 'trueLabel', 'note', 'incumbentModel', 'challengerModel', 'windowDays',
    'marginPct', 'pendingOnly',
    // Quality-tab write actions (ground_truth submit / flagged review) — #33/#35.
    'action', 'exchangeId', 'score', 'classification', 'reasoning', 'reviewAction', 'notes', 'scorerId',
  ]) {
    const v = body[k];
    if (v !== undefined && v !== null) p[k] = String(v);
  }
  // Experiment recommendation (§4): the caller (which already holds the experiment
  // record client-side) may pass the pre-registered objective so the verdict reads
  // the primary metric + guardrails + humanPickWeight, and the operator's recorded
  // decision so the response can show recommended-vs-chosen (§4.4). Both optional
  // (absent ⇒ a quality-primary default with no guardrails — additive, INV-2); sent
  // as JSON so the whole sub-object rides one param.
  for (const k of ['objective', 'decision']) {
    const v = body[k];
    if (v !== undefined && v !== null) p[k] = typeof v === 'string' ? v : JSON.stringify(v);
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

async function handlePostQuery(
  rawBody: string | null,
  ceiling: ClassificationCeiling = null,
  /** Server-verified caller sub from the JWT. Overwrites any body-supplied value (see below). */
  callerSub?: string,
): Promise<APIGatewayProxyResult> {
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
  const params = buildParamsFromBody(body);
  // Identity comes from the verified JWT, never the request body, and is written AFTER the body is
  // unpacked so a caller cannot attribute a write to someone else by sending their own `callerSub`.
  // Same rule as maybeRecordModeration: the actor is server-verified or absent.
  if (callerSub) params.callerSub = callerSub;
  const res = await entry.fn(params);
  if (res.statusCode !== 200) return res;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    return error(500, 'Malformed analytics result');
  }
  const arr = Array.isArray(parsed[entry.dataKey]) ? parsed[entry.dataKey] : [];
  // A14 Scoped: narrow rows with a tier dimension to the caller's ceiling.
  const scoped = scopeAnalyticsRows(arr as unknown[], ceiling);
  // Normalize to { data: [...] }; keep the rest (stats/pagination/totals) at top level.
  return success({ ...parsed, data: scoped });
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

  // Conversation list.
  //
  // The name lookups are LEFT JOIN LATERAL, per page row - NOT CTEs. As `WITH names/first_msg`
  // (SELECT DISTINCT ON (channel_arn) ... FROM messages) each scanned and sorted the ENTIRE messages
  // table - first_msg additionally regexp_replacing every first human message in the archive - to
  // title a page bounded by LIMIT ≤ 100, because the join key cannot be pushed below DISTINCT ON.
  // A lateral runs once per returned conversation and walks the (channel_arn, created_at) index.
  const result = await query(
    `SELECT
       c.channel_arn,
       c.user_type,
       c.agent_type,
       c.message_count,
       c.first_message_at,
       c.last_message_at,
       COALESCE(n.name, fm.name) AS conversation_name,
       -- Purpose/summary/topics DO come from the summary: they are the artifact it produced,
       -- not channel state (ADR-020).
       cs.purpose,
       cs.summary,
       cs.topics
     FROM conversations c
     LEFT JOIN conversation_summaries cs ON cs.channel_arn = c.channel_arn
       AND cs.version = (
         SELECT MAX(version) FROM conversation_summaries
         WHERE channel_arn = c.channel_arn
       )
     -- The conversation NAME is derived from the ARCHIVED channel events, not from the summary
     -- row (migration 015 drops that column) and not from channel_registry. channel_registry is
     -- written only from CREATE_CHANNEL (kinesis-archival.ts, syncChannelRegistryRecords), so it
     -- freezes the name at CREATION - which is the placeholder 'New conversation'
     -- (channel-title.ts) for any conversation that is auto-titled on its first turn rather than
     -- named by hand. Taking the LATEST channel event instead picks up the auto-derive and any
     -- later user rename. This is the same resolution admin-conversations-aurora.ts uses for the
     -- Conversations list, so both surfaces answer "what is this conversation called" from one
     -- source (tenet 8).
     LEFT JOIN LATERAL (
       SELECT content AS name
         FROM messages m
        WHERE m.channel_arn = c.channel_arn
          AND m.event_type IN ('CREATE_CHANNEL','UPDATE_CHANNEL')
          AND m.content IS NOT NULL AND m.content <> ''
          -- The CREATE row always carries the client's placeholder title, which made the
          -- first-message fallback below unreachable in exactly the lost-rename case it exists
          -- for: COALESCE took 'New conversation' and fm was never consulted. The placeholder is
          -- not a name; only a real (derived or user-set) title wins here.
          AND m.content <> 'New conversation'
        ORDER BY m.created_at DESC
        LIMIT 1
     ) n ON TRUE
     -- Fallback title: the first human message. The first-turn auto-derive renames the live
     -- Amazon Chime SDK channel, and that UpdateChannel event does not reliably reach Kinesis, so
     -- without this fallback rows show the placeholder or nothing at all.
     LEFT JOIN LATERAL (
       SELECT LEFT(REGEXP_REPLACE(m.content, '<!--.*?-->', '', 'g'), 60) AS name
         FROM messages m
        WHERE m.channel_arn = c.channel_arn
          AND m.event_type = 'CREATE_CHANNEL_MESSAGE' AND m.is_bot = false
          AND m.content IS NOT NULL AND m.content <> ''
        ORDER BY m.created_at ASC
        LIMIT 1
     ) fm ON TRUE
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

  // Summary stats.
  //
  // The headline for this feature is two questions about an OFFER that was made: was it accurate
  // (judged after the fact by evaluation), and did the user accept it. Drift VOLUME is neither -
  // how often users change topic is a fact about users, so a high number is not a failure and a low
  // one is not success, and it must never be presented as health.
  //
  // Accuracy comes from the evaluation runner's post-hoc judgement (`evaluated_correct`), NOT from
  // the user's reaction: someone can decline a correct suggestion and accept a bad one, so deriving
  // accuracy from acceptance would measure the wrong thing. Acceptance is reported separately.
  //
  // `source = 'live'` is load-bearing (migration 016). The archival pass scores historical messages
  // and writes drift_events rows too, but nothing was shown to anyone on that path: counting them
  // would inflate the denominator with offers that have nobody to accept them and never settle.
  // Rows written before 016 have source NULL (provenance genuinely unknown) and are excluded rather
  // than guessed, so this window reports on offers made since that migration.
  //
  // Counts are returned raw and the rates derived client-side, so a zero denominator renders as
  // "No data" instead of a fabricated 0%. `pending_count` (outcome IS NULL) is the honest caveat:
  // a just-made offer has no response yet but is already in the denominator, so acceptance reads as
  // a floor while offers are in flight.
  const statsResult = await query(
    `SELECT
       COUNT(*) FILTER (WHERE source = 'live') AS total_events,
       -- source = 'live' HERE TOO: every sibling stat filters to the live population, and a count
       -- over a different population beside them cannot be ratioed. Pre-migration-016 rows have
       -- source NULL but can be outcome = 'abandoned', so without this filter a window covering
       -- them returns unresolved_count > total_events and a client-side rate over 100%.
       COUNT(*) FILTER (WHERE source = 'live' AND outcome = 'abandoned') AS unresolved_count,
       ROUND(AVG(cosine_distance)::numeric, 4) AS avg_drift_score,
       COUNT(*) FILTER (WHERE source = 'live' AND outcome = 'accepted') AS accepted_count,
       COUNT(*) FILTER (WHERE source = 'live' AND outcome IS NULL) AS pending_count,
       COUNT(*) FILTER (WHERE source = 'live' AND evaluated_at IS NOT NULL) AS evaluated_count,
       COUNT(*) FILTER (WHERE source = 'live' AND evaluated_correct IS TRUE) AS evaluated_correct_count
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
 *
 * ALWAYS EMPTY TODAY, and that is not a data problem. `cross_conversation_context` has no writer:
 * `cross-conversation-context.ts` owns the only INSERT and neither of its exports has a caller (see
 * that module's header). No admin-console surface calls this queryType either, so it is a registered
 * endpoint over an unpopulated table on both ends. Left in place because the table and the query are
 * the intended shape for the drift decision-flow's "already discussed in another conversation" check;
 * do not read an empty result as a broken pipeline or start debugging the join.
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
/**
 * THE AUDIT OF ONE TURN.
 *
 * `latency_metrics` aggregates; this returns the CALCULATION, one row per (turn_id, response_id), so
 * a human can check it against the message stream. That is the whole reason the ledger exists - an
 * aggregate cannot be audited, and until this endpoint existed the ledger's views had no reader at all.
 *
 * The reconciliation residuals are the point of interest: a NEGATIVE `unattributed_ms` means compute
 * was attributed to the wrong turn, which is exactly the bug class this design was built to expose.
 * They are returned rather than judged here - the caller decides what a breach means.
 *
 * Scoped to a channel deliberately. An unbounded read of the ledger is a table scan, and the auditing
 * workflow always starts from a conversation someone is looking at.
 */
async function getTurnLatencyAudit(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const channelArn = params.channelArn;
  if (!channelArn) {
    return success({ data: [], error: 'channelArn is required to audit a turn' });
  }
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const result = await query(
    `SELECT turn_id, response_id, channel_arn, turn_id_source, trigger_kind, battle_round, responder,
            t0_user_at, t2_placeholder_at, t3_final_at,
            ttff_ms, e2e_ms, answer_ms, unattributed_ms, overhead_ms,
            status, progress_update_count, task_id
       FROM v_turn_latency
      WHERE channel_arn = $1
      ORDER BY t0_user_at DESC NULLS LAST
      LIMIT $2`,
    [channelArn, limit],
  );
  return success({
    data: result.rows,
    columns: [
      'turn_id', 'response_id', 'channel_arn', 'turn_id_source', 'trigger_kind', 'battle_round',
      'responder', 't0_user_at', 't2_placeholder_at', 't3_final_at',
      'ttff_ms', 'e2e_ms', 'answer_ms', 'unattributed_ms', 'overhead_ms',
      'status', 'progress_update_count', 'task_id',
    ],
  });
}

/**
 * TASK RESOLUTION, WHICH IS NOT LATENCY.
 *
 * `resolve_ms` decomposes into `agent_ms` - the part the system is accountable for - and the human
 * think time that makes up the rest. A task open for four hours with twenty seconds of assistant time
 * is HEALTHY, and this is the table that says so on its face.
 *
 * It never enters `getLatencyMetrics` or the alert computation, and that separation is the design
 * rather than an oversight: one number would either flatter the turn latency or damn the workflow.
 */
async function getTaskResolution(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '7', 10), 90);
  const result = await query(
    `SELECT task_id, channel_arn, opened_at, terminal_at, terminal_kind,
            is_resolved, resolve_ms, agent_ms, transitions, turns
       FROM v_task_resolution
      WHERE opened_at >= NOW() - INTERVAL '1 day' * $1
      ORDER BY opened_at DESC
      LIMIT 200`,
    [days],
  );
  return success({
    data: result.rows,
    columns: [
      'task_id', 'channel_arn', 'opened_at', 'terminal_at', 'terminal_kind',
      'is_resolved', 'resolve_ms', 'agent_ms', 'transitions', 'turns',
    ],
  });
}

async function getLatencyMetrics(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '7', 10), 90);

  const result = await query(
    `WITH resp_ledger AS (
       -- WHY THE CLASSIFICATION LIVES HERE AND NOT IN SIX FILTER CLAUSES.
       --
       -- unclosed_count said 172 turns never recorded a final answer and could not say why, so the
       -- number carried every reading from "test litter" to "answers were lost" at once. Splitting it
       -- with six independent predicates would have re-created that ambiguity in a new form: overlapping
       -- predicates double-count and a missing one drops a turn silently, and neither shows up as an
       -- error - the split would just fail to add up to the count it explains, quietly.
       --
       -- One CASE per response makes the buckets DISJOINT BY CONSTRUCTION (a response gets exactly one
       -- outcome) and EXHAUSTIVE (the ELSE, plus the IS NULL of the LEFT JOIN). The split therefore sums
       -- to unclosed_count as an arithmetic fact rather than as something to be checked.
       --
       -- PRECEDENCE, and why this order. A ledger-declared final outranks everything because it means
       -- the two derivations DISAGREE - that is a shadow-diff finding, not a lost answer, and reading it
       -- as one would send an investigation after the wrong thing. Then the explained non-closures in
       -- descending strength of explanation: the producer said error; the answer was removed after the
       -- fact; the turn is still moving. What is left is a placeholder with nothing after it, which is
       -- the only bucket that means an answer went missing.
       SELECT response_id,
              channel_arn,
              CASE
                WHEN bool_or(kind = 'final_response')                                     THEN 'ledger_final'
                WHEN bool_or(kind = 'error_response')                                     THEN 'errored'
                WHEN bool_or(kind IN ('content_redacted','message_deleted','content_edited'))
                                                                                          THEN 'superseded'
                WHEN bool_or(kind IN ('progress_update','notice_posted'))                 THEN 'awaiting'
                ELSE 'silent'
              END AS outcome
         FROM turn_events
        WHERE response_id IS NOT NULL
          AND occurred_at >= NOW() - INTERVAL '1 day' * $1
        GROUP BY response_id, channel_arn
     )
     SELECT
       DATE(m.created_at) AS date,
       -- Fall back to the conversation tier so legacy/DIRECT exchanges do not group as 'unknown'.
       COALESCE(e.agent_type, c.agent_type, 'unknown') AS agent_type,
       COALESCE(e.delivery_option, 'unknown') AS delivery_option,
       -- MISNAMED, AND KEPT ONLY BECAUSE THE COLUMN CONTRACT IS READ BY LatencyTab, alerts.ts AND
       -- metricTargets.ts. This has never been a count of EXCHANGES. There is a real exchanges table
       -- - one row per agent reply, carrying user_message_id - and this count does not come from it.
       --
       -- What it actually counts, once the -UPD exclusion below applies: BOT MESSAGE ROWS THAT CARRIED
       -- COMPUTE TELEMETRY. That is close to "assistant responses that ran a model", and it still is not
       -- exchanges: a bot-INITIATED message (a welcome, a round-2 rebuttal, a drift notice) has no user
       -- message to pair with, so it is counted here and has no exchange at all.
       --
       -- Before that exclusion it was not even this - every turn contributed TWO rows, so the figure was
       -- double a population it was already mislabelling. Anything tuned against it, the P95 latency band
       -- in particular, was tuned against a number nobody could name.
       COUNT(*) AS exchange_count,
       ROUND(AVG(m.total_ms)) AS avg_total_ms,
       ROUND(AVG(m.latency_ms)) AS avg_bedrock_ms,
       -- ── LOCATING THE PLACEHOLDER: THE COST, AND HOW OFTEN IT GOES THE SLOW WAY ──
       --
       -- Three figures because there are three questions, and one column was answering none of them.
       -- Before migration 030, poll_ms spanned processor entry to placeholder resolved, so it billed
       -- the dedup claim and the task-status write to "polling" and could never read 0 however well
       -- the channel flow's handoff worked. Task turns ran ~100ms above every other delivery option
       -- on every day measured; that was updateTaskStatus, not a scan.
       --
       --   avg_placeholder_resolve_ms  what LOCATING cost - the mapping read, plus the scan when
       --                               there was one. The latency the turn actually paid before it
       --                               knew which message to answer on.
       --   poll_fallback_count         how often the handoff did NOT supply a target, so a scan ran.
       --                               This is the number to read: it sits on a hard floor of zero,
       --                               so a regression is a step off it rather than a drift within
       --                               noise, and it is what makes an alert here mean one thing.
       --   avg_poll_ms                 what a scan costs WHEN it happens.
       --
       -- avg_poll_ms IS CONDITIONAL BY CONSTRUCTION, not by a FILTER: poll_ms is NULL on turns that
       -- did not scan (030), and AVG skips nulls. Written as 0 instead, the mean would land between
       -- a common 0 and a rare few thousand and describe no turn on the system - the same defect as
       -- averaging a reconstructed pairing into TTFF, in the other direction.
       --
       -- ── THE PROCESSOR LEG, STEP BY STEP, AND IT RECONCILES ──
       --
       -- The point is not four more numbers, it is that they ADD UP. A turn between the placeholder
       -- and the final answer spends its time in exactly four places, and each is now named:
       --
       --   guard_ms                the dedup claim + the task-status write (admission)
       --   placeholder_resolve_ms  locating the message to answer on
       --   latency_ms              the model loop, itself split into model_ms + tool_ms
       --   avg_processor_tail_ms   what is LEFT of total_ms - the finalize, the message update and
       --                           the archival dispatch. Derived, not stamped, so it cannot drift
       --                           from the total it is defined against.
       --
       -- The tail is the honest residual, and it is reported rather than assumed to be zero for the
       -- same reason v_turn_latency returns unattributed_ms: a residual that will not close is a
       -- measurement bug, and one that is never computed is a measurement bug nobody can see. If it
       -- goes NEGATIVE, compute has been attributed to the wrong turn - the bug class this ledger
       -- exists to expose - so it is not clamped at zero.
       -- ── THE TTFF LEG'S LARGEST CONTROLLABLE STEP ──
       --
       -- The classifier is a Bedrock call, and it runs BEFORE the placeholder is minted - so it is
       -- inside the number the 1s SLO is about, and it was the one step of the whole path that had
       -- no column. It was measurable only from CloudWatch, where it read 444 ms avg / 1,410 ms p95
       -- / 1,723 ms max on premium traffic over three days: between a sixth and a third of a TTFF
       -- that was missing its target by 1.6 s. A step that large deciding an SLO from outside the
       -- ledger is how an optimisation gets argued about instead of measured.
       --
       -- CONDITIONAL BY NULL, like poll_ms and for the same reason: a turn settled by the pre-LLM
       -- fast path, or a rebuttal dispatched by the orchestrator, never asked a model for a label.
       -- Those turns did not pay this, and averaging a 0 into the cost of classifying would report a
       -- cheaper classifier rather than a rarer one. So AVG is the cost WHEN a model is asked, and
       -- the count beside it is how often that happens.
       -- ── THE ROUTER LEG, AND WHY inbound_ms COULD NOT ANSWER THIS ──
       --
       -- avg_inbound_ms is the user message to ASYNC PROCESSOR ENTRY: the channel flow, Lex, this
       -- router and the dispatch, as one cross-clock figure clamped at zero. It tracks TTFF almost
       -- exactly (2,591 against 2,653 ms on 2026-08-21) because the processor is dispatched at
       -- roughly the instant the placeholder is returned - so it is a near-DUPLICATE of TTFF, not a
       -- component of it, and it can never say which of the three hops to fix.
       --
       -- router_ms is the router's own compute on ONE clock, so the leg finally divides:
       --
       --   avg_router_ms         this handler, entry to hand-off
       --   avg_classifier_ms     its largest single step - a SUB-STEP of router_ms, not a sibling
       --   avg_router_other_ms   the rest of the handler: the task lookups, the SSM reads, the
       --                         classification tag read, delivery selection. Derived, for the same
       --                         reason the processor tail is.
       --   (ttff - router_ms)    what is left is the pre-router hop plus the placeholder's trip back
       --                         to Chime. Deliberately NOT computed here: those endpoints are on
       --                         different clocks, and a residual across a clock boundary is an
       --                         estimate wearing a column's clothes. inbound_ms already bounds it.
       ROUND(AVG(m.router_ms)) AS avg_router_ms,
       ROUND(AVG(m.classifier_ms)) AS avg_classifier_ms,
       COUNT(m.classifier_ms) AS classified_by_model_count,
       -- The router MINUS the classification it may or may not have bought. COALESCE on the
       -- classifier only: a turn that took a fast path spent none of its router time classifying, so
       -- its whole router span is "other" - whereas a NULL router_ms means the turn was never
       -- measured, and subtracting from it would invent a number.
       ROUND(AVG(m.router_ms - COALESCE(m.classifier_ms, 0))) AS avg_router_other_ms,
       ROUND(AVG(m.guard_ms)) AS avg_guard_ms,
       ROUND(AVG(m.placeholder_resolve_ms)) AS avg_placeholder_resolve_ms,
       --
       -- ── EVERY FIGURE BELOW IS GATED ON A ROW HAVING BEEN MEASURED THE NEW WAY ──
       --
       -- A NOT NULL placeholder_resolve_ms is the discriminator, and it is a DECLARED fact rather
       -- than an inference: only the step-latency code writes that column, so its presence says "this
       -- row's poll_ms means the scan alone" and its absence says "this row predates the split".
       --
       -- FOUND IN LIVE VERIFICATION, NOT IN REVIEW. Ungated, the first read after deploy reported
       -- poll_fallback_count equal to the row count on every historical group - a 100% fallback rate -
       -- because the OLD poll_ms was stamped on every turn (it timed from handler entry and could
       -- never be null). The rate metric would have read as a total outage of the placeholder handoff
       -- until the history aged out, which is a worse failure than the one it was built to expose.
       --
       -- The tail had the same contamination in the other direction: derived from total_ms less
       -- COALESCE(...,0) of columns a pre-split row does not carry, it reported that row's unmeasured
       -- admission and lookup time AS tail, silently inflating one bucket with two others.
       ROUND(AVG(m.total_ms - COALESCE(m.guard_ms, 0) - COALESCE(m.placeholder_resolve_ms, 0)
                            - COALESCE(m.latency_ms, 0))
             FILTER (WHERE m.placeholder_resolve_ms IS NOT NULL)) AS avg_processor_tail_ms,
       -- The denominator the rate is OVER, so "N fallbacks" is readable as a proportion rather than
       -- against a row count that includes turns this split never measured.
       COUNT(m.placeholder_resolve_ms) AS placeholder_measured_count,
       COUNT(m.poll_ms) FILTER (WHERE m.placeholder_resolve_ms IS NOT NULL) AS poll_fallback_count,
       ROUND(AVG(m.poll_ms) FILTER (WHERE m.placeholder_resolve_ms IS NOT NULL)) AS avg_poll_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.total_ms)) AS p95_total_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.latency_ms)) AS p95_bedrock_ms,
       ROUND(MIN(m.total_ms)) AS min_total_ms,
       ROUND(MAX(m.total_ms)) AS max_total_ms,
       -- TTFF = time to first feedback: the delay from the user's message to the
       -- assistant's "One moment…" placeholder appearing (there is no token
       -- streaming, so this acknowledgment latency is the only pre-answer signal
       -- distinct from total_ms). response_latency_ms already records
       -- placeholder_created_at - user_message_at; null on unpaired/DIRECT rows.
       --
       -- ── MEASURED PAIRINGS ONLY, AND THE REST MADE COUNTABLE ──
       --
       -- An exchange reaches this table by one of two pairers, and only one of them measures a
       -- placeholder. The in-batch pairer sees the turn's own analytics and records what the delivery
       -- actually was. createExchangesFromDatabase is the fallback for a turn whose user and bot
       -- messages landed in different Kinesis batches: it RECONSTRUCTS the pair by looking for the
       -- earliest corr-marked bot CREATE after the user message, and its only bound on that search is
       -- one hour. So its response_latency_ms is not a time-to-placeholder at all - it is the gap to
       -- whatever reply that search decided belonged to the prompt, and it can be up to an hour.
       --
       -- MEASURED: 101 such rows on 2026-08-14 averaged 487,360 ms with a p95 of 2,428,479 ms - just
       -- inside the hour cap - and produced 93% of a 7-day TTFF total across 2,719 exchanges. The
       -- headline read 21,555 ms; without them it read 3,585 ms. Against a 1s SLO that is not a
       -- degraded measurement, it is a fabricated one, and it describes a system that was actually
       -- answering in about two and a half seconds.
       --
       -- THE DAMAGE SCALES INVERSELY WITH TRAFFIC, which is why this could not be left to age out of
       -- the window. A fresh deployment's first run produces tens of exchanges, not thousands, so ONE
       -- reconstructed row puts its average TTFF into the minutes - and a first-time reader has no
       -- history telling them the number is wrong.
       --
       -- PARTITIONED, NOT HIDDEN - the same rule as the unclosed_* buckets below and the
       -- compute/direct split above. The reconstructed rows keep their exchange_count and are counted
       -- here by name; what they lose is a vote on a latency nobody experienced.
       --
       -- THE DISCRIMINATOR IS INFERRED, AND THAT IS THIS FIX'S ONE WEAKNESS. delivery_option is NULL
       -- exactly because the fallback pairer's INSERT omits the column, so NULL means "the fallback
       -- minted this" - today. A turn whose analytics genuinely lacked a delivery option would also
       -- be NULL and would be excluded with them. That is the safe direction (a real row lost from an
       -- average is recoverable; a fabricated one poisoning it is not) and the count makes any such
       -- loss visible. A declared provenance column on the pairer would make this a read of a fact
       -- rather than of an absence, and is the better end state.
       --
       -- E2E IS NOT PARTITIONED HERE and carries the same exposure: it is anchored on the same
       -- possibly-reconstructed user_message_at. Left alone deliberately, so this change is one
       -- decision rather than two - see the tracker row.
       ROUND(AVG(e.response_latency_ms) FILTER (WHERE e.delivery_option IS NOT NULL)) AS avg_ttff_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.response_latency_ms)
             FILTER (WHERE e.delivery_option IS NOT NULL)) AS p95_ttff_ms,
       -- The population the two figures above are taken over, and the one they are not. Reported so
       -- "avg over N" means something here as well.
       COUNT(*) FILTER (WHERE e.response_latency_ms IS NOT NULL AND e.delivery_option IS NOT NULL)
         AS ttff_measured_count,
       COUNT(*) FILTER (WHERE e.response_latency_ms IS NOT NULL AND e.delivery_option IS NULL)
         AS ttff_reconstructed_count,
       -- E2E = user message -> FINAL answer (exchanges.e2e_ms = agent_final_at - user_message_at),
       -- the full user-perceived wait. Distinct from total_ms (server compute from processor entry)
       -- and from TTFF (time to the placeholder). Null on rows whose final-answer update has not been
       -- folded yet, and on DIRECT/unpaired rows. LATENCY-TARGETS.md.
       ROUND(AVG(e.e2e_ms)) AS avg_e2e_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.e2e_ms)) AS p95_e2e_ms,
       -- Bedrock (latency_ms) split into model inference (model_ms) vs in-loop tool execution (tool_ms),
       -- plus the inbound hop (user message -> processor entry; cross-clock, approximate). Null until
       -- the completion update is folded. LATENCY-TARGETS.md.
       ROUND(AVG(m.model_ms)) AS avg_model_ms,
       ROUND(AVG(m.tool_ms)) AS avg_tool_ms,
       ROUND(AVG(e.inbound_ms)) AS avg_inbound_ms,
       -- ── THE DENOMINATOR, REPORTED RATHER THAN PERFORMED ──
       --
       -- total_ms > 0 used to sit in the WHERE, so responses that ran no measurable compute were
       -- silently absent and every average was over a population nobody could state. Reporting the
       -- split makes "avg over N" mean something: compute_count is the population the compute averages
       -- are actually taken over, direct_count is what the old WHERE was discarding.
       COUNT(*) FILTER (WHERE m.total_ms IS NOT NULL AND m.total_ms > 0) AS compute_count,
       COUNT(*) FILTER (WHERE m.total_ms IS NULL OR m.total_ms <= 0)     AS direct_count,
       -- ── THE MEASUREMENT GAP, MADE COUNTABLE ──
       --
       -- A turn whose answer never landed has a null e2e_ms, and AVG skips nulls without complaint, so
       -- it leaves the average rather than being reported as incomplete. That is the failure this row
       -- names: an excluded turn should be VISIBLE, not filtered away.
       --
       -- It matters more since finality became declared: an errored turn now correctly does NOT close
       -- (only respPhase='final' sets agent_final_at), so it lands here instead of being miscounted as
       -- a completion. Correct semantics, and invisible without this count.
       COUNT(*) FILTER (WHERE e.e2e_ms IS NOT NULL) AS closed_count,
       COUNT(*) FILTER (WHERE e.id IS NOT NULL AND e.e2e_ms IS NULL) AS unclosed_count,
       -- ── AND WHY IT DID NOT CLOSE ──
       --
       -- These six partition unclosed_count. They differ enormously in seriousness and only one of them
       -- is a defect, which is the entire reason the total was not actionable:
       --
       --   no_placeholder  the bot message never carried a correlation marker, so it was never a
       --               placeholder and there is no answer pending. STRUCTURALLY UNCLOSABLE, and checked
       --               FIRST because it is a property of the message rather than of the ledger - it
       --               therefore answers for all history, including turns older than the live writer.
       --               Only a placeholder is ever edited into a final answer (backfillFromUpdateEvents
       --               is the sole writer of agent_final_at), so a marker-less bot message cannot close
       --               however long it is waited for. These reach the population at all because
       --               createExchangesFromDatabase pairs ANY bot CREATE that follows a user message -
       --               a welcome, a drift notice, a continuation chunk, a DIRECT quick reply.
       --   unobserved  the ledger holds nothing for this response. NOT an explanation - it is the
       --               honest absence of one. A real placeholder, older than the live writer or missed
       --               by it. It must never be read as "fine"; it is "cannot say".
       --   disagreed   the ledger declared a final answer and exchanges.e2e_ms is still null. The two
       --               derivations disagree - the shadow diff of rollout step 4, arriving early.
       --   errored     the producer declared phase 'error'. A CORRECT non-closure: the wait ended and no
       --               answer was produced, and folding that duration into time-to-answer would make a
       --               broken turn read as a fast one.
       --   superseded  the answer was redacted, deleted or edited afterwards.
       --   awaiting    a progress update or a notice and nothing terminal - the turn is still moving, or
       --               it handed back to the person.
       --   silent      a placeholder, and then nothing. THE DEFECT POPULATION: someone was told to wait
       --               and no answer, no error and no update ever followed. This is the number the whole
       --               ledger was built to expose, and the only one of the seven worth an alert.
       --
       -- The buckets consume ONE per-row classification (b.unclosed_bucket, defined in the lateral
       -- below with the marker grammar stated once). They used to repeat the full marker predicate
       -- ten times, which made the partition property depend on ten hand-copied strings agreeing;
       -- CASE arms are mutually exclusive by construction, so it now cannot stop being a partition.
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'no_placeholder')    AS unclosed_no_placeholder,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'unreadable_marker') AS unclosed_unreadable_marker,
       -- Attribution of the unreadable markers by producer, because the two mints that could overflow
       -- are known: the battle template (fixed part 31 chars + a service-assigned ARN segment) and the
       -- mention mint (a service MessageId up to 128 chars). A count outside both names a third mint.
       -- SUB-counts of the unreadable bucket, not partition members.
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'unreadable_marker' AND m.content LIKE '%<!--corr:battle-%')   AS unreadable_marker_battle,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'unreadable_marker' AND m.content LIKE '%<!--corr:mention-%')  AS unreadable_marker_mention,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'unobserved')  AS unclosed_unobserved,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'disagreed')   AS unclosed_disagreed,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'errored')     AS unclosed_errored,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'superseded')  AS unclosed_superseded,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'awaiting')    AS unclosed_awaiting,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'silent')      AS unclosed_silent
     FROM messages m
     LEFT JOIN exchanges e ON e.agent_message_id = m.id
     LEFT JOIN conversations c ON e.conversation_id = c.id
     -- GROUPED before it is joined, so it cannot multiply a row. resp_ledger is unique on
     -- (response_id, channel_arn); a plain join to turn_events would emit one row per EVENT and
     -- multiply every average in this query by the number of events the turn happened to record - the
     -- same fan-out hazard v_turn_latency documents against exchanges, arriving from the other side.
     LEFT JOIN resp_ledger l ON l.response_id = m.message_id AND l.channel_arn = m.channel_arn
     -- ── THE MARKER GRAMMAR, ONCE ──
     -- CHARACTER-FOR-CHARACTER the predicate turn-events-backfill.ts uses to decide what a
     -- placeholder is, deliberately: two disagreeing definitions of "response" is the defect this
     -- whole ledger exists to remove, and it would be a poor place to introduce a third.
     --
     -- IT MUST BE THE FULL PATTERN, NOT A LIKE ON THE OPENING TOKEN, and this was learned the
     -- expensive way. A first cut tested only for the literal marker opening; against live data it
     -- classified 26 rows as "a real placeholder the ledger has not observed" that the backfill had
     -- declined to record, because the backfill also requires the id to match the bounded character
     -- class AND the marker to be closed.
     LEFT JOIN LATERAL (
       SELECT substring(m.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->') AS marker_id
     ) mk ON TRUE
     -- ── ONE CLASSIFICATION PER ROW ──
     -- NULL for any closed (or unpaired) row; otherwise exactly one bucket. The first two arms
     -- answer WITHOUT the ledger - they are properties of the MESSAGE, so they hold for all
     -- history, including turns older than the live writer.
     --
     -- no_placeholder REQUIRES the literal marker to be absent, not merely unreadable. The bounded
     -- substring is NULL in two OPPOSITE situations: the message never carried a
     -- marker (benign - nobody was promised an answer), and the message carries a marker LONGER
     -- than the 64-character bound (the defect - a person WAS told to wait and no reader can ever
     -- close the turn). One predicate served both and 26 turns were counted as the benign kind.
     LEFT JOIN LATERAL (
       SELECT CASE
         WHEN e.id IS NULL OR e.e2e_ms IS NOT NULL          THEN NULL
         WHEN mk.marker_id IS NULL
              AND m.content NOT LIKE '%<!--corr:%'          THEN 'no_placeholder'
         WHEN mk.marker_id IS NULL                          THEN 'unreadable_marker'
         WHEN l.outcome IS NULL                             THEN 'unobserved'
         WHEN l.outcome = 'ledger_final'                    THEN 'disagreed'
         WHEN l.outcome = 'errored'                         THEN 'errored'
         WHEN l.outcome = 'superseded'                      THEN 'superseded'
         WHEN l.outcome = 'awaiting'                        THEN 'awaiting'
         WHEN l.outcome = 'silent'                          THEN 'silent'
       END AS unclosed_bucket
     ) b ON TRUE
     WHERE m.is_bot = true
       -- ONE TURN IS ONE ROW HERE. A bot reply is stored twice: the canonical CREATE
       -- row, and a -UPD audit row holding the finalized text for the conversation browser. The audit
       -- row carries total_ms, so without this filter every turn's compute was counted TWICE - and
       -- because the exchange join is on the CREATE id, the duplicates could not be attributed and
       -- landed in an unknown/unknown bucket. Live, that was 564 phantom rows against ~570 real ones,
       -- all inside the traffic-weighted P95 alert population, where at that ratio they outweigh the
       -- turns they were doubling.
       --
       -- getModelUsage documented this trap and excluded the row; this query never learned. A guard
       -- that lives in a comment beside ONE call site does not protect the others.
       --
       -- EXCLUDING THE ROW IS NOT EXCLUDING THE UPDATE. The update is the moment the person gets their
       -- answer and it is fully measured: archival folds its timestamp onto the CANONICAL row as
       -- agent_final_at, which is what e2e_ms is derived from. The -UPD row carries no timing the
       -- canonical row lacks. It is a STEP to be measured, not a turn to be counted.
       AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
       -- total_ms is NO LONGER filtered here. It moved into FILTER clauses on the compute aggregates
       -- above, so a response that ran no measurable compute is COUNTED and attributed rather than
       -- vanishing from the population. The compute averages are unchanged - a null contributes
       -- nothing to AVG or PERCENTILE_CONT either way - but the counts beside them are now honest
       -- about what they are averaging over.
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
      // New columns are APPENDED so the existing contract is byte-for-byte intact: LatencyTab,
      // alerts.ts and metricTargets.ts read by name and are unaffected by additions.
      'compute_count', 'direct_count', 'closed_count', 'unclosed_count',
      // The buckets that partition unclosed_count. Appended, like their parent.
      // `unreadable_marker` split from `no_placeholder`: a marker the reader cannot see is
      // a promised answer that can never close, not the benign absence of a promise. The two
      // `unreadable_marker_*` columns attribute it by producer and are SUB-counts of the bucket, not
      // partition members.
      'unclosed_no_placeholder', 'unclosed_unreadable_marker',
      'unreadable_marker_battle', 'unreadable_marker_mention',
      'unclosed_unobserved', 'unclosed_disagreed', 'unclosed_errored',
      'unclosed_superseded', 'unclosed_awaiting', 'unclosed_silent',
      'avg_ttff_ms', 'p95_ttff_ms',
      // The TTFF population, split by whether the pairing was MEASURED or RECONSTRUCTED by the
      // cross-batch fallback. Appended, so the existing contract is untouched: LatencyTab already
      // skips a null avg_ttff_ms when it traffic-weights, which is what a reconstructed-only group
      // now returns.
      'ttff_measured_count', 'ttff_reconstructed_count',
      // Locating the placeholder, split into the cost and the rate (migration 030). `avg_poll_ms`
      // keeps its name and its position in the contract above; what changed is that it now means
      // the SCAN alone and is conditional on one having happened.
      'avg_router_ms', 'avg_classifier_ms', 'classified_by_model_count', 'avg_router_other_ms',
      'avg_guard_ms', 'avg_placeholder_resolve_ms', 'avg_processor_tail_ms',
      'placeholder_measured_count', 'poll_fallback_count',
      'avg_e2e_ms', 'p95_e2e_ms',
      'avg_model_ms', 'avg_tool_ms', 'avg_inbound_ms',
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
  avg_image_count?: string | number | null;
}): number | null {
  const modelId = row.dominant_model || undefined;
  if (!modelId) return null;
  const toNum = (v: string | number | null | undefined): number | undefined =>
    v === null || v === undefined ? undefined : Number(v);
  // Image (generation-out) turns price per-image, not per-token: an image model
  // reports 0 tokens, so estimateStepCostUsd routes on imageCount when it is
  // present and > 0 (per-image rate). Only forward imageCount when the DOMINANT
  // model is itself an image model — otherwise a text intent with a stray image
  // turn (imageCount averaged from the image rows) would route a text model into
  // the image path and return null instead of its real token cost.
  const isImageModel = imageGenModelIdToKey(modelId) != null;
  return estimateStepCostUsd({
    modelId,
    tokensIn: toNum(row.avg_input_tokens),
    tokensOut: toNum(row.avg_output_tokens),
    imageCount: isImageModel ? toNum(row.avg_image_count) : undefined,
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
  // Optional ASSISTANT filter ($3) — scope the whole view to the exchanges/flows a SPECIFIC ASSISTANT
  // answered, via `agent_type` (the responder's identity), NOT `user_type` (the conversation's tier). They
  // coincide today (agent_type is written as the classification, AgentType = basic|standard|premium), but
  // agent_type is the correct, future-proof handle for "this assistant" once multiple assistants serve one
  // classification. Null ⇒ all assistants. Used by the "view this assistant's effectiveness" link.
  const agentType = params.agentType || null;

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
              -- Image (generation-out) turns: the per-reply image count, averaged over the
              -- turns that carry it, so cost can be priced per-image (an image model reports 0
              -- tokens). The ~ regex guard casts only well-formed integer values so a malformed
              -- metadata value can never error the whole dashboard query (a scalar/non-int is
              -- treated as absent). NULL on token-only intents → resolveReplyCostUsd stays on
              -- the token path.
              ROUND(AVG(CASE WHEN m.metadata->>'imageCount' ~ '^[0-9]+$'
                             THEN (m.metadata->>'imageCount')::int END)::numeric, 2) AS avg_image_count,
              MODE() WITHIN GROUP (ORDER BY m.bedrock_model) AS dominant_model,
              -- Portable-profile attribution (which assistant + version served this intent's traffic),
              -- read from the per-turn metadata stamped by the async processor. NULL on pre-attribution rows.
              MODE() WITHIN GROUP (ORDER BY m.metadata->>'profileName') AS assistant,
              MODE() WITHIN GROUP (ORDER BY m.metadata->>'profileVersion') AS profile_version,
              MODE() WITHIN GROUP (ORDER BY m.metadata->>'profileConfigId') AS profile_config_id
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
          AND ($3::varchar IS NULL OR e.agent_type = $3)
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
          AND ($3::varchar IS NULL OR f.agent_type = $3)
          -- Completion measures MULTI-STEP tasks. A one-shot request that opened a flow but was
          -- answered in a single exchange (and so never reached 'completed') is a direct answer, not a
          -- failed task; counting it dragged the rate to a misleading red 0%. Count a flow only when it
          -- is genuinely multi-step (exchange_count > 1) OR it actually completed (a legitimately
          -- one-turn-completed task still counts). An intent with only single-exchange, non-completed
          -- flows then yields NO row here → task_completion_rate is NULL → the UI renders "—".
          AND (f.exchange_count > 1 OR f.status = 'completed')
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
          AND ($3::varchar IS NULL OR e.agent_type = $3)
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
            ex_agg.avg_image_count,
            ex_agg.dominant_model,
            ex_agg.assistant,
            ex_agg.profile_version,
            ex_agg.profile_config_id,
            COALESCE(ta.tool_calls, 0) AS tool_calls,
            COALESCE(ta.tool_errors, 0) AS tool_errors,
            ROUND(COALESCE(ta.tool_errors * 100.0 / NULLIF(ta.tool_calls, 0), 0)::numeric, 1) AS tool_error_rate
       FROM ex_agg
       LEFT JOIN flow_agg fa ON fa.intent = ex_agg.intent
       LEFT JOIN tool_agg ta ON ta.intent = ex_agg.intent
      ORDER BY ex_agg.exchange_count DESC`,
    [days, intent, agentType]
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
  if (!intent) return success({ data: [], total: 0 });
  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  const agentType = params.agentType || null; // Effectiveness "one assistant" scope (agent_type = responder).

  // COUNT(*) OVER() returns the full match count alongside the page, so the admin console can render
  // "Page X of N" and page server-side without a second round-trip (SPEC-ADMIN-CONSOLE pagination).
  const result = await query(
    `SELECT e.id AS exchange_id,
            e.agent_message_id,
            e.task_id,
            e.channel_arn,
            e.intent_confidence,
            e.was_rerouted,
            e.delivery_option,
            er.relevance_score,
            m.total_ms,
            m.input_tokens,
            m.output_tokens,
            m.bedrock_model,
            e.created_at,
            COUNT(*) OVER() AS total_count
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
        AND ($4::varchar IS NULL OR e.agent_type = $4)
      ORDER BY e.created_at DESC
      LIMIT $3 OFFSET $5`,
    [intent, days, limit, agentType, offset]
  );
  const total = result.rows[0]?.total_count != null ? Number(result.rows[0].total_count) : result.rows.length;
  return success({ data: result.rows, total, limit, offset });
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
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return aggregateVariantFeedback(await scanFeedbackRecords(experimentId), sinceMs, includeBattle);
}

/**
 * The raw experiment-attributed feedback records, unfiltered.
 *
 * ONE scan serves both the rollup and the per-vote drill-down, so the two can never read different
 * sets of votes: the difference between them is which PURE function is applied afterwards
 * (`aggregateVariantFeedback` vs `selectVariantFeedbackRecords`), and both start from
 * `latestVotePerVoter`. Fails OPEN — an unset table or a scan error yields no records, and every
 * caller renders without thumbs (logged server-side).
 */
async function scanFeedbackRecords(experimentId: string | undefined): Promise<FeedbackRecord[]> {
  if (!FEEDBACK_TABLE) return [];
  const items: FeedbackRecord[] = [];
  try {
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const res: any = await ddbDocClient.send(
        new ScanCommand({
          TableName: FEEDBACK_TABLE,
          // Alias every name: experimentId/variantId/intent etc. avoid any
          // reserved-word surprises and document the projection intent.
          // userSub + messageId are the VOTE's identity, not the record's: the table appends every
          // revision, so without them `latestVotePerVoter` cannot collapse a decision trail and the
          // rollup counts a switched vote on both sides.
          ProjectionExpression: '#eid, #vid, #intent, #fb, #am, #ca, #us, #mid, #carn, #fid',
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
            '#us': 'userSub',
            '#mid': 'messageId',
            // The drill-down's link target: the conversation the rated reply lives in.
            '#carn': 'channelArn',
            '#fid': 'feedbackId',
          },
          ExpressionAttributeValues: experimentId ? { ':eid': experimentId } : { ':null': null },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const it of res.Items || []) items.push(it as FeedbackRecord);
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
  } catch (err) {
    console.warn('[experiment-feedback] thumbs scan failed (rendering without thumbs):', err);
    return [];
  }
  return items;
}

/**
 * Scan the BattleOutcome table for head-to-head picks, FLATTENED to one
 * BattleOutcomeItem per user pick (see flattenBattleOutcomeItem). Optionally
 * filtered to one experiment (applied per-pick, since attribution is now nested
 * in the votes map). Paginated; fails OPEN: an unset table (/battle off) or a
 * scan error yields an empty list and every caller renders without battle picks.
 * Shared by the probabilistic (variant,intent) rollup and the battle-scoped
 * effectiveness view, which bucket the same picks on different keys.
 */
async function scanBattleOutcomeItems(experimentId: string | undefined): Promise<BattleOutcomeItem[]> {
  if (!BATTLE_OUTCOME_TABLE) return [];
  const picks: BattleOutcomeItem[] = [];
  try {
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const res: any = await ddbDocClient.send(
        new ScanCommand({
          TableName: BATTLE_OUTCOME_TABLE,
          ProjectionExpression: '#bid, #votes, #eid, #vid, #intent, #winner, #ca, #cbu',
          ExpressionAttributeNames: {
            // The PK. Carried so the pick drill-down can match a pick to the battle turns that
            // produced it and, through them, to the conversation.
            '#bid': 'battleId',
            '#votes': 'votes',
            '#eid': 'experimentId',
            '#vid': 'variantId',
            '#intent': 'intent',
            '#winner': 'winner',
            '#ca': 'chosenAt',
            '#cbu': 'chosenByUserSub',
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const it of res.Items || []) {
        for (const pick of flattenBattleOutcomeItem(it)) {
          if (experimentId && (pick.experimentId ?? '') !== experimentId) continue;
          picks.push(pick);
        }
      }
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
  } catch (err) {
    console.warn('[experiment-feedback] battle-outcome scan failed (rendering without battle picks):', err);
    return [];
  }
  return picks;
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
    // Battle turns are intentionally excluded from the probabilistic experiment-variant
    // rollup (SPEC-BATTLE rollup-safety invariant): folding a hand-picked battle prompt into
    // the A/B averages would bias them. Their metrics are surfaced separately, with the filter
    // INVERTED, by fetchBattleEffectivenessRows (the battle-scoped effectiveness view).
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
       -- How many of those exchanges an evaluator actually SCORED. exchange_count measures traffic;
       -- this measures evidence, and they are not interchangeable, because an unscored exchange still
       -- counts toward the mean below as a zero. The recommendation gates a quality/accuracy objective
       -- on this, so a variant with nothing scored reports "not enough evidence" instead of a mean of
       -- placeholder zeros read as a real result.
       COUNT(er.relevance_score) AS scored_count,
       ROUND(AVG(COALESCE(er.relevance_score, 0))::numeric, 1) AS avg_score,
       -- Per-variant dispersion for the statistical tests (§4.2-B/A.6): sample
       -- SD of each continuous metric so getExperimentRecommendation can run a
       -- Welch t-test on (mean, sd, n). Sample SD is NULL for a single-row group;
       -- surfaced as null and pooled/guarded downstream.
       ROUND(STDDEV_SAMP(COALESCE(er.relevance_score, 0))::numeric, 2) AS score_sd,
       ROUND(AVG(COALESCE(m.total_ms, e.response_latency_ms, 0))::numeric, 0) AS avg_total_ms,
       ROUND(STDDEV_SAMP(COALESCE(m.total_ms, e.response_latency_ms, 0))::numeric, 1) AS latency_sd,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY COALESCE(m.total_ms, e.response_latency_ms, 0))::numeric, 0) AS p95_total_ms,
       ROUND(AVG(COALESCE(m.input_tokens, 0))::numeric, 0) AS avg_input_tokens,
       ROUND(AVG(COALESCE(m.output_tokens, 0))::numeric, 0) AS avg_output_tokens,
       ROUND(AVG(COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0))::numeric, 0) AS avg_tokens,
       ROUND(STDDEV_SAMP(COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0))::numeric, 1) AS tokens_sd,
       -- Image (generation-out) variants: per-reply image count so cost prices per-image (an
       -- image model reports 0 tokens). Regex-guarded cast so a malformed value never errors
       -- the whole query; NULL on token-only variants.
       ROUND(AVG(CASE WHEN m.metadata->>'imageCount' ~ '^[0-9]+$'
                      THEN (m.metadata->>'imageCount')::int END)::numeric, 2) AS avg_image_count,
       ROUND(
         (COUNT(*) FILTER (WHERE COALESCE(er.is_compliant, true)) * 100.0 / NULLIF(COUNT(*), 0))::numeric,
         1
       ) AS compliance_rate,
       COUNT(*) FILTER (WHERE m.was_fallback = true) AS fallback_count,
       COUNT(DISTINCT e.task_id) FILTER (WHERE e.task_id IS NOT NULL) AS task_count,
       COUNT(DISTINCT e.task_id) FILTER (WHERE e.task_status = 'completed') AS task_completed_count
     FROM exchanges e
     JOIN messages m ON e.agent_message_id = m.id
     -- ONE relevance per exchange, exactly as the drill-down resolves it (getExperimentExchanges) and
     -- as every other read of this table does. Joining the raw rows fanned the join out whenever an
     -- exchange carried two evaluation rows, which is reachable: overlapping evaluation-runner
     -- invocations race the unscored select and then insert. A fan-out double-counts COUNT(*) and
     -- mis-weights the AVG/STDDEV feeding the Welch tests, so the inflated n reached the ship
     -- recommendation while the drill-down beside it, which pre-aggregates, disagreed silently.
     LEFT JOIN (
       SELECT exchange_id, AVG(relevance_score) AS relevance_score,
              BOOL_AND(COALESCE(is_compliant, true)) AS is_compliant
         FROM evaluation_results
        WHERE evaluation_type = 'exchange'
        GROUP BY exchange_id
     ) er ON er.exchange_id = e.id
     ${where}
     GROUP BY m.experiment_id, m.variant_id, COALESCE(m.bedrock_model, 'unknown'), COALESCE(e.intent, 'unknown'), e.agent_type
     ORDER BY m.experiment_id, m.variant_id`,
    queryParams
  );

  // Human-signal joins: bucket the DynamoDB thumbs + battle picks once, then
  // attach per (variant, intent) row. Both are
  // separate signals alongside the evaluator's avg_score — never blended into it.
  // (Battle wins are not gated by includeBattle: a pick only exists from a battle.)
  // Battle picks bucket per VARIANT, not per (variant, intent). A pick records no intent - nothing
  // in the write path has one to record, since the judgement is of the whole reply rather than of an
  // intent bucket - so an intent-keyed lookup resolved every pick to `variant::unknown` while the
  // rows carried real intents, and the advertised battle_wins column could never populate.
  const [feedbackByVariantIntent, battleWinsByVariant] = await Promise.all([
    scanVariantFeedback(days, experimentId, includeBattle),
    (async () =>
      aggregateBattleWinsByVariant(
        await scanBattleOutcomeItems(experimentId),
        Date.now() - days * 24 * 60 * 60 * 1000,
      ))(),
  ]);

  // A (variant, intent) can span more than one row when a fallback produced a
  // different bedrock_model for some exchanges. Thumbs live at the (variant,
  // intent) grain, so attach the full tally to the FIRST row of each key and
  // zero the rest — otherwise the per-variant sum (frontend + recommendation)
  // would double-count the same thumbs.
  const thumbsAttached = new Set<string>();
  // Same double-count guard as thumbs, one grain up: a variant's wins attach to its FIRST row and
  // the rest read null, so the per-variant sum stays the true tally however many rows it spans.
  const winsAttached = new Set<string>();

  // Derive cost, rates, and the needs-more-data flag in code (the rate table
  // and the sample threshold are not SQL concerns).
  return result.rows.map((r: any) => {
    const n = Number(r.exchange_count) || 0;
    const taskCount = Number(r.task_count) || 0;
    const taskCompleted = Number(r.task_completed_count) || 0;
    // Pass modelId too (not just modelKey): image-gen models are excluded from the text
    // catalog so bedrockModelIdToKey() is null for them, but estimateStepCostUsd routes on
    // imageCount → imageGenModelIdToKey(modelId) for the per-image rate. Only forward
    // imageCount when the model IS an image model, so a text variant with a stray image row
    // never routes a text model into the null-returning image path.
    const isImageModel = imageGenModelIdToKey(r.model_name) != null;
    const avgCostUsd = estimateStepCostUsd({
      modelId: r.model_name,
      modelKey: bedrockModelIdToKey(r.model_name),
      tokensIn: Number(r.avg_input_tokens) || 0,
      tokensOut: Number(r.avg_output_tokens) || 0,
      imageCount: isImageModel ? Number(r.avg_image_count) || 0 : 0,
    });
    // The EXPERIMENT is part of both the dedup key and the lookup. Without it, two experiments sharing
    // a variant id and intent shared one bucket: the first row seen attached the combined thumbs and
    // every later row was zeroed as a "duplicate". Single-experiment reads hid this because the scan
    // filters to one experiment; the all-experiments view did not.
    const dedupKey = feedbackKey(r.experiment_id, r.variant_id, r.intent);
    const firstForKey = !thumbsAttached.has(dedupKey);
    const thumbs = firstForKey
      ? feedbackColumnsFor(feedbackByVariantIntent, r.experiment_id, r.variant_id, r.intent)
      : { thumbs_up: 0, thumbs_down: 0, feedback_count: 0, approval_rate: null };
    const winsKey = battleWinKey(r.experiment_id, r.variant_id);
    const wins = winsAttached.has(winsKey)
      ? 0
      : battleWinsByVariant.get(winsKey) || 0;
    const battle = { battle_wins: wins > 0 ? wins : null };
    winsAttached.add(winsKey);
    thumbsAttached.add(dedupKey);
    // Cost has no stored per-exchange column (it is MODELED from tokens via the
    // rate table), so there is no SQL STDDEV for it. Approximate its dispersion by
    // carrying the tokens coefficient-of-variation onto the modeled cost
    // (cost ≈ k·tokens for a given model). null when it can't be derived — the
    // Welch guard then reads no variance and claims no significance (honest).
    const avgTokens = Number(r.avg_tokens) || 0;
    const tokensSd = r.tokens_sd == null ? null : Number(r.tokens_sd);
    const costSd =
      avgCostUsd != null && tokensSd != null && avgTokens > 0
        ? Math.round(avgCostUsd * (tokensSd / avgTokens) * 1e6) / 1e6
        : null;
    return {
      ...r,
      avg_cost_usd: avgCostUsd, // null when the model/usage can't be priced (honesty contract)
      // Continuous-metric dispersion + explicit n for the §4.2-B tests. score_sd/
      // latency_sd/tokens_sd are the SQL sample SDs (null for a single-row group);
      // cost_sd is derived (see above); n mirrors exchange_count for the stats layer.
      n,
      // Scoring coverage, coerced (pg returns counts as strings). The recommendation's sufficiency
      // gate for a score-backed objective counts THIS, not n.
      scored_count: Number(r.scored_count) || 0,
      score_sd: r.score_sd == null ? null : Number(r.score_sd),
      latency_sd: r.latency_sd == null ? null : Number(r.latency_sd),
      tokens_sd: tokensSd,
      cost_sd: costSd,
      fallback_rate: n > 0 ? Math.round((Number(r.fallback_count) / n) * 1000) / 10 : 0,
      task_completion_rate: taskCount > 0 ? Math.round((taskCompleted / taskCount) * 1000) / 10 : null,
      ...thumbs, // thumbs_up, thumbs_down, feedback_count, approval_rate (null = no signal)
      ...battle, // battle_wins (null = no picks credit this variant/intent)
      needs_more_data: n < MIN_SAMPLE_PER_VARIANT,
    };
  });
}

/** One battle-scoped effectiveness row: a variant's metrics from its BATTLE turns only. */
interface BattleEffectivenessRow {
  experiment_id: string;
  variant_id: string;
  model_name: string;
  turn_count: number;
  avg_score: number | null; // avg relevance where scored; null when no battle turn is scored yet
  avg_cost_usd: number | null; // image-aware; null when the model/usage can't be priced
  battle_wins: number | null; // head-to-head picks this variant won; null when none
}

const BATTLE_EFFECTIVENESS_COLUMNS = [
  'experiment_id', 'variant_id', 'model_name', 'turn_count', 'avg_score', 'avg_cost_usd', 'battle_wins',
];

/**
 * Battle-scoped effectiveness view (SPEC-BATTLE): per-variant metrics from the BATTLE turns ONLY,
 * kept OUT of the probabilistic A/B rollup (fetchExperimentRows) so a hand-picked battle prompt never
 * biases the A/B averages. Mirrors the fetchExperimentRows SQL shape but with the assignmentMode filter
 * INVERTED (battle turns only) and keyed by (experiment, variant): one row per variant, its dominant
 * model via MODE(), so the view answers "how is each battle contender doing" at a glance.
 *
 * Cost is image-aware, resolved by the SAME estimateStepCostUsd path the probabilistic + L0 views use
 * (via resolveReplyCostUsd) so an image turn prices per-image, not as 0-token text. No schema change:
 * the battle discriminator + imageCount ride messages.metadata JSONB, exactly like the image-cost fix.
 *
 * turn_count is COUNT(DISTINCT e.id) and relevance is pre-aggregated to one score per exchange, so a
 * re-scored exchange (multiple evaluation_results rows) can neither inflate the count nor double-weight
 * the average. avg_score is NULL (not 0) when no battle turn has been scored yet (the honesty contract).
 * The per-variant win tally is joined from the same BattleOutcome scan the A/B rollup reads, bucketed by
 * (experiment, variant). Fails OPEN: no BattleOutcome table => battle_wins is null, metrics still render.
 */
async function fetchBattleEffectivenessRows(
  days: number,
  experimentId: string | undefined,
): Promise<BattleEffectivenessRow[]> {
  const queryParams: any[] = [days];
  let where = `WHERE m.experiment_id IS NOT NULL
       AND e.created_at >= NOW() - INTERVAL '1 day' * $1
       AND COALESCE(m.metadata->'analytics'->>'assignmentMode', m.metadata->>'assignmentMode', 'probabilistic') = 'battle'`;
  if (experimentId) {
    queryParams.push(experimentId);
    where += ` AND m.experiment_id = $${queryParams.length}`;
  }

  const result = await query(
    `SELECT
       m.experiment_id,
       m.variant_id,
       COALESCE(MODE() WITHIN GROUP (ORDER BY m.bedrock_model), 'unknown') AS model_name,
       COUNT(DISTINCT e.id) AS turn_count,
       ROUND(AVG(er.relevance_score)::numeric, 1) AS avg_score,
       ROUND(AVG(COALESCE(m.input_tokens, 0))::numeric, 0) AS avg_input_tokens,
       ROUND(AVG(COALESCE(m.output_tokens, 0))::numeric, 0) AS avg_output_tokens,
       -- Image (generation-out) turns: per-turn image count so cost prices per-image (an image model
       -- reports 0 tokens). Regex-guarded cast so a malformed value never errors the whole query.
       ROUND(AVG(CASE WHEN m.metadata->>'imageCount' ~ '^[0-9]+$'
                      THEN (m.metadata->>'imageCount')::int END)::numeric, 2) AS avg_image_count
     FROM exchanges e
     JOIN messages m ON e.agent_message_id = m.id
     -- One relevance per exchange (a re-scored exchange has multiple evaluation_results rows; averaging
     -- them here keeps the LEFT JOIN 1:1 so turn_count is not inflated). NULL when never scored.
     LEFT JOIN (
       SELECT exchange_id, AVG(relevance_score) AS relevance_score
         FROM evaluation_results
        WHERE evaluation_type = 'exchange'
        GROUP BY exchange_id
     ) er ON er.exchange_id = e.id
     ${where}
     GROUP BY m.experiment_id, m.variant_id
     ORDER BY m.experiment_id, m.variant_id`,
    queryParams
  );

  // Per-variant win tally from the BattleOutcome table, bucketed by (experiment, variant)
  // (wins summed across intents). Fails OPEN: no table => empty map => battle_wins null.
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const winsByVariant = aggregateBattleWinsByVariant(await scanBattleOutcomeItems(experimentId), sinceMs);

  return result.rows.map((r: any): BattleEffectivenessRow => {
    const avgScore = r.avg_score == null ? null : Number(r.avg_score);
    const wins = winsByVariant.get(battleWinKey(r.experiment_id, r.variant_id));
    return {
      experiment_id: r.experiment_id,
      variant_id: r.variant_id,
      model_name: r.model_name || 'unknown',
      turn_count: Number(r.turn_count) || 0,
      avg_score: avgScore,
      // Image-aware cost via the shared resolver (never a duplicated rate table): an image variant
      // prices per-image from avg_image_count; a text variant prices on tokens. null when unpriceable.
      avg_cost_usd: resolveReplyCostUsd({
        dominant_model: r.model_name,
        avg_input_tokens: r.avg_input_tokens,
        avg_output_tokens: r.avg_output_tokens,
        avg_image_count: r.avg_image_count,
      }),
      battle_wins: wins == null ? null : wins,
    };
  });
}

const EXPERIMENT_COLUMNS = [
  'experiment_id', 'variant_id', 'model_name', 'intent', 'agent_type',
  'exchange_count', 'n', 'scored_count', 'avg_score', 'score_sd', 'avg_total_ms', 'latency_sd', 'p95_total_ms',
  'avg_tokens', 'tokens_sd', 'avg_cost_usd', 'cost_sd', 'compliance_rate', 'fallback_count', 'fallback_rate',
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
/** Columns the per-exchange drill-down returns. Deliberately the values that ROLL UP, so the caller
 *  can recompute the aggregate rather than take it on trust. */
const EXPERIMENT_EXCHANGE_COLUMNS = [
  'exchange_id', 'channel_arn', 'agent_message_id', 'created_at',
  'variant_id', 'intent', 'assignment_mode',
  'relevance_score', 'total_ms', 'input_tokens', 'output_tokens', 'bedrock_model', 'is_compliant',
  'redacted', 'deleted',
  'total_count',
];

/**
 * The exchanges behind ONE axis of ONE experiment (DESIGN §4.3, "not built" -> built).
 *
 * The point of this query is that an operator can RECOMPUTE the number they are about to ship on, so
 * it returns the per-exchange values that roll up, not a list of links. Row count and the mean of
 * `relevance_score` must reconcile with `experiment_results` for the same axis; if they do not, the
 * rollup is wrong and the console should say so rather than render a quiet contradiction.
 *
 * **THE PREDICATE IS THE SAME ONE THE SCORING USES.** That is the whole correctness requirement: a
 * drill-down filtered more loosely surfaces exchanges that did not count toward the number beside it,
 * which is worse than no drill-down at all. Hence:
 *  - `axis='metrics'` mirrors `fetchExperimentRows(..., includeBattle=false)`: probabilistic turns only.
 *  - `axis='battle'` is the complement: battle turns only, the population the picks come from.
 * Intent scoping needs no clause - an intent experiment only ever binds its own intent's turns, so
 * only those carry its `experiment_id`. Matching on the intent STRING would find nothing, because the
 * stored value is the classifier intent (`general`) while the experiment stores the route key
 * (`general_qa`).
 *
 * **Redaction.** A redacted exchange STAYS in the set: it contributed to the score, and dropping it
 * would break the reconciliation above and misrepresent what the verdict was computed from. Its
 * `redacted`/`deleted` flags ride along so the caller can withhold the TRANSCRIPT while still counting
 * the row. See DESIGN §4.3 for the unresolved questions here; this returns flags, it does not decide
 * policy.
 */
async function getExperimentExchanges(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const experimentId = (params.experimentId || '').trim();
  // No experiment id means no scoped set. Return empty rather than every experiment's exchanges:
  // an unscoped drill-down is precisely the "wrong set" failure this query exists to avoid.
  if (!experimentId) return success({ data: [], columns: EXPERIMENT_EXCHANGE_COLUMNS, total: 0 });

  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  const variantId = (params.variantId || '').trim() || null;
  // 'metrics' (default) = probabilistic turns, the A/B population. 'battle' = battle turns only.
  const axis = params.axis === 'battle' ? 'battle' : 'metrics';

  const mode = `COALESCE(m.metadata->'analytics'->>'assignmentMode', m.metadata->>'assignmentMode', 'probabilistic')`;
  const sqlParams: any[] = [days, experimentId];
  let where = `WHERE m.experiment_id = $2
                 AND e.created_at >= NOW() - INTERVAL '1 day' * $1
                 AND ${mode} ${axis === 'battle' ? '=' : '<>'} 'battle'`;
  if (variantId) {
    sqlParams.push(variantId);
    where += ` AND m.variant_id = $${sqlParams.length}`;
  }
  sqlParams.push(limit, offset);

  const result = await query(
    `SELECT e.id AS exchange_id,
            e.channel_arn,
            e.agent_message_id,
            e.created_at,
            m.variant_id,
            COALESCE(e.intent, 'unknown') AS intent,
            ${mode} AS assignment_mode,
            er.relevance_score,
            er.is_compliant,
            m.total_ms,
            m.input_tokens,
            m.output_tokens,
            m.bedrock_model,
            -- RETRACTION COMES FROM THE -RED/-DEL SIBLING ROW, not from the moderation audit table.
            --
            -- The moderation ITSELF is complete: it is a Chime SDK API call, so every redaction and
            -- deletion reaches the event stream and archival writes the sibling row. That is the
            -- authority, and the admin conversation read already uses it.
            --
            -- What moderation_actions adds is ATTRIBUTION (who acted), and only for moderations
            -- performed through the admin console: it is a SECOND client call made after the Chime
            -- call returns, and the console deliberately swallows its failure so a bookkeeping error
            -- can never fail a moderation (ConversationsTab.handleRedact). A redaction issued any
            -- other way writes no row there at all. It is also keyed on the Chime message id, not the
            -- messages PK, so joining it on m.id compares a varchar to a UUID.
            EXISTS (
              SELECT 1 FROM messages x
               WHERE x.channel_arn = m.channel_arn
                 AND x.event_type = 'REDACT_CHANNEL_MESSAGE'
                 AND x.message_id = regexp_replace(m.message_id, '-(UPD|RED|DEL)$', '') || '-RED'
            ) AS redacted,
            EXISTS (
              SELECT 1 FROM messages x
               WHERE x.channel_arn = m.channel_arn
                 AND x.event_type = 'DELETE_CHANNEL_MESSAGE'
                 AND x.message_id = regexp_replace(m.message_id, '-(UPD|RED|DEL)$', '') || '-DEL'
            ) AS deleted,
            COUNT(*) OVER() AS total_count,
            -- FULL-MATCH aggregates, computed over every matching exchange rather than the page.
            -- Window functions run before LIMIT, so these hold on page 3 of 40 exactly as on page 1;
            -- without them the mean could only be recomputed by pulling every row, and a paginated
            -- view could never satisfy the reconciliation it exists to make possible.
            --
            -- UNSCORED COUNTS AS ZERO, because that is what the aggregate this reconciles against
            -- does (fetchExperimentRows: AVG(COALESCE(er.relevance_score, 0))). Reproducing the
            -- number means reproducing that convention, and scored_count is returned alongside so
            -- the operator can see how much of the mean is scoring coverage rather than quality.
            AVG(COALESCE(er.relevance_score, 0)) OVER() AS avg_score_all,
            COUNT(er.relevance_score) OVER() AS scored_count,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM messages x
                 WHERE x.channel_arn = m.channel_arn
                   AND x.event_type IN ('REDACT_CHANNEL_MESSAGE','DELETE_CHANNEL_MESSAGE')
                   AND x.message_id IN (
                         regexp_replace(m.message_id, '-(UPD|RED|DEL)$', '') || '-RED',
                         regexp_replace(m.message_id, '-(UPD|RED|DEL)$', '') || '-DEL')
              )
            ) OVER() AS withheld_count
       FROM exchanges e
       JOIN messages m ON e.agent_message_id = m.id
       LEFT JOIN (
         SELECT exchange_id, AVG(relevance_score) AS relevance_score,
                BOOL_AND(COALESCE(is_compliant, true)) AS is_compliant
           FROM evaluation_results
          WHERE evaluation_type = 'exchange'
          GROUP BY exchange_id
       ) er ON er.exchange_id = e.id
       ${where}
       ORDER BY e.created_at DESC
       LIMIT $${sqlParams.length - 1} OFFSET $${sqlParams.length}`,
    sqlParams,
  );

  const rows = result.rows || [];
  const first = rows[0];
  return success({
    data: rows,
    columns: EXPERIMENT_EXCHANGE_COLUMNS,
    // The FULL match count, not the page size. A view that shows a page without the total cannot be
    // reconciled against the aggregate, and a silent sample reads as a complete set.
    total: rows.length ? Number(first.total_count) || rows.length : 0,
    limit,
    offset,
    axis,
    experimentId,
    variantId,
    // The reconciliation targets: what the aggregate SHOULD equal if the rollup is right. Returned
    // as numbers over the full match so the console can state the check on any page.
    stats: {
      total: rows.length ? Number(first.total_count) || rows.length : 0,
      avg_score: rows.length && first.avg_score_all != null ? Number(first.avg_score_all) : null,
      scored_count: rows.length ? Number(first.scored_count) || 0 : 0,
      withheld_count: rows.length ? Number(first.withheld_count) || 0 : 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Classification shadow gate (DESIGN §5)
// ---------------------------------------------------------------------------

/** Replay runs, newest first, optionally for one experiment. */
async function getClassifierReplays(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const runs = await listReplayRuns((params.experimentId || '').trim() || undefined);
  return success({ data: runs, columns: [] });
}

/**
 * One run, with the gate's verdict computed from its labels.
 *
 * The verdict is derived here rather than stored, so it always reflects the adjudication as it
 * stands: a queue worked further since the last read moves the answer, and a cached verdict would
 * quietly disagree with the rows beneath it.
 */
async function getClassifierReplayDetail(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const runId = (params.runId || '').trim();
  if (!runId) return error(400, 'runId is required');
  const { run, labels } = await getReplayRun(runId);
  if (!run) return error(404, 'No such replay run');
  const marginPct = Number(params.marginPct);
  const gate = evaluateClassifierGate(labels, {
    marginPct: Number.isFinite(marginPct) && marginPct > 0 ? marginPct : undefined,
  });
  // A run that did not finish cannot be read as a measurement of its window, whatever its labels say.
  return success({ data: [], run, gate, incomplete: run.status !== 'complete' });
}

/** The adjudication queue (discordant + unruled) or a run's whole label set. */
async function getClassifierReplayLabels(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const runId = (params.runId || '').trim();
  if (!runId) return error(400, 'runId is required');
  const { rows, total } = await listReplayLabels(runId, {
    pendingOnly: params.pendingOnly === 'true',
    limit: Number(params.limit) || undefined,
    offset: Number(params.offset) || undefined,
  });
  return success({ data: rows, columns: [], total });
}

/**
 * Starting a replay does NOT happen here, and cannot.
 *
 * This function is VPC-attached (the database is in the VPC), and the isolated subnets it runs in
 * have no NAT, no internet gateway and no `lambda` interface endpoint. A `lambda:Invoke` from here
 * therefore has no route: it hangs until this function's own timeout and the caller gets a 504, with
 * the batch function never invoked and the run row left `running` forever. That is not a bug to
 * retry - it is the network shape. IAM permission was granted and reachability never existed, which
 * is exactly why a template review and 14 mocked unit tests all passed.
 *
 * The start therefore lives OUTSIDE the VPC, in `classifier-replay-start.ts`, on its own
 * `POST /classifier-replay-start` resource. That function mints the run id, returns it, and invokes
 * the batch Lambda, which opens the row from inside the VPC. Same shape as `ClientEventsFunction`,
 * the other Lambda-to-Lambda hop in this stack, which is non-VPC for the same reason.
 *
 * Kept as an explicit refusal rather than deleted: a caller that still posts the old queryType here
 * (an older console bundle, a script) should be told where the route went, not left reading a
 * generic "unknown queryType" while the operation it asked for silently never happens.
 */
async function postClassifierReplayStart(): Promise<APIGatewayProxyResult> {
  return error(
    400,
    'classifier_replay_start does not run on this route. POST to /classifier-replay-start, which is ' +
      'outside the VPC and is the only place that can invoke the replay function.',
  );
}

/** Record one human ruling. The actor comes from the JWT, never the body. */
async function postClassifierAdjudication(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const adjudicatedBy = (params.callerSub || '').trim();
  if (!adjudicatedBy) return error(401, 'An adjudication must be attributable to a caller');
  try {
    const res = await adjudicateReplayLabel({
      labelId: (params.labelId || '').trim(),
      trueLabel: (params.trueLabel || '').trim(),
      adjudicatedBy,
      note: params.note,
    });
    // `updated: false` means the row was concordant or absent — a ruling that changes no number.
    return success({ data: [], ...res });
  } catch (e) {
    return error(400, e instanceof Error ? e.message : 'Could not record the adjudication');
  }
}

/** Columns the per-vote approval drill-down returns. One row per COUNTED vote. */
const EXPERIMENT_FEEDBACK_COLUMNS = [
  'created_at', 'variant_id', 'intent', 'feedback', 'assignment_mode', 'channel_arn', 'message_id',
];

/**
 * The individual thumbs behind an approval rate (the THIRD axis, DESIGN §4.3).
 *
 * A separate query from `experiment_exchanges` because it is a separate POPULATION: thumbs are
 * self-selected votes on ordinary traffic, held in DynamoDB, and only a fraction of exchanges carry
 * one. Serving them from the exchange drill-down would show an operator hundreds of unrated rows as
 * the evidence for a rate computed from twelve votes.
 *
 * Reconciles exactly: `stats.votes` is the denominator of `approval_rate` and `stats.thumbs_up` its
 * numerator, both from the same `latestVotePerVoter` collapse the rollup applies.
 */
async function getExperimentFeedback(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const experimentId = (params.experimentId || '').trim();
  if (!experimentId) return success({ data: [], columns: EXPERIMENT_FEEDBACK_COLUMNS, total: 0 });

  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  const variantId = (params.variantId || '').trim() || null;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const records = selectVariantFeedbackRecords(
    await scanFeedbackRecords(experimentId),
    sinceMs,
    params.includeBattle === 'true',
    variantId,
  );
  const page = records.slice(offset, offset + limit);
  const up = records.filter((r) => r.feedback === 'up').length;

  return success({
    data: page.map((r) => ({
      created_at: r.createdAt ?? null,
      variant_id: r.variantId ?? null,
      intent: r.intent ?? null,
      feedback: r.feedback ?? null,
      assignment_mode: r.assignmentMode ?? null,
      channel_arn: r.channelArn ?? null,
      message_id: r.messageId ?? null,
    })),
    columns: EXPERIMENT_FEEDBACK_COLUMNS,
    total: records.length,
    limit,
    offset,
    axis: 'approval',
    experimentId,
    variantId,
    stats: {
      total: records.length,
      votes: records.length,
      thumbs_up: up,
      thumbs_down: records.length - up,
      // The rate the console shows, recomputed from the rows it is about to display.
      approval_rate: records.length ? Math.round((up / records.length) * 1000) / 10 : null,
    },
  });
}

/** Columns the per-pick battle drill-down returns. One row per COUNTED pick (ties excluded). */
const EXPERIMENT_PICK_COLUMNS = [
  'chosen_at', 'variant_id', 'winner', 'intent', 'battle_id', 'channel_arn',
];

/**
 * The individual head-to-head picks behind `battle_wins` (the human axis, DESIGN §4.3).
 *
 * A FOURTH population, and the one most easily conflated with the third: `experiment_exchanges`
 * with `axis='battle'` returns the battle TURNS (what the models produced), while this returns the
 * PICKS (what people chose between them). They reconcile against different numbers — turn metrics
 * versus the win count and its CI — so the console must not offer one link for both.
 *
 * The conversation is resolved, not decoded: `battleId` is `sha256(channelArn:userMessageId)`, so the
 * only way back is to match it against the battle turns that carry it in their metadata. A pick whose
 * battle has no archived turn keeps its row and reports no conversation, rather than being dropped —
 * it still counted toward the win.
 */
async function getExperimentPicks(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const experimentId = (params.experimentId || '').trim();
  if (!experimentId) return success({ data: [], columns: EXPERIMENT_PICK_COLUMNS, total: 0 });

  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  const variantId = (params.variantId || '').trim() || null;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const picks = selectBattlePicks(await scanBattleOutcomeItems(experimentId), sinceMs, variantId);
  const page = picks.slice(offset, offset + limit);
  const channelByBattle = await resolveBattleChannels(
    experimentId,
    days,
    page.map((p) => (p.battleId ?? '').trim()).filter(Boolean),
  );

  return success({
    data: page.map((p) => ({
      chosen_at: p.chosenAt ?? null,
      variant_id: p.variantId ?? null,
      winner: p.winner ?? null,
      intent: p.intent ?? null,
      battle_id: p.battleId ?? null,
      channel_arn: channelByBattle.get((p.battleId ?? '').trim()) ?? null,
    })),
    columns: EXPERIMENT_PICK_COLUMNS,
    total: picks.length,
    limit,
    offset,
    axis: 'picks',
    experimentId,
    variantId,
    stats: {
      total: picks.length,
      picks: picks.length,
      treatment_wins: picks.filter((p) => p.variantId === 'treatment').length,
      control_wins: picks.filter((p) => p.variantId === 'control').length,
      // How many of the shown picks cannot be traced to a conversation. Stated rather than hidden:
      // a missing link is a gap in the evidence, and an operator reconciling should see its size.
      unresolved_conversations: page.filter((p) => !channelByBattle.get((p.battleId ?? '').trim())).length,
    },
  });
}

/**
 * Map battleId -> channel_arn by looking up the archived battle TURNS that carry it.
 *
 * The id is a one-way hash, so this is the only path back to the conversation. Reads the same
 * metadata shape the assignment-mode predicate does (`analytics` nesting first, then top level), and
 * returns an empty map on any failure — an unlinkable pick still renders.
 */
async function resolveBattleChannels(
  experimentId: string,
  days: number,
  battleIds: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(battleIds));
  if (!unique.length) return new Map();
  try {
    const result = await query(
      `SELECT DISTINCT
              COALESCE(m.metadata->'analytics'->'battleContext'->>'battleId',
                       m.metadata->'battleContext'->>'battleId') AS battle_id,
              e.channel_arn
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
        WHERE m.experiment_id = $2
          AND e.created_at >= NOW() - INTERVAL '1 day' * $1
          AND COALESCE(m.metadata->'analytics'->'battleContext'->>'battleId',
                       m.metadata->'battleContext'->>'battleId') = ANY($3::text[])`,
      [days, experimentId, unique],
    );
    const map = new Map<string, string>();
    for (const r of result.rows || []) {
      const id = String((r as any).battle_id || '');
      const arn = String((r as any).channel_arn || '');
      if (id && arn && !map.has(id)) map.set(id, arn);
    }
    return map;
  } catch (err) {
    console.warn('[experiment-picks] battle->channel resolution failed (rendering without links):', err);
    return new Map();
  }
}

async function getExperimentResults(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '30', 10), 180);
  // The probabilistic A/B rows (battle EXCLUDED unless includeBattle) plus the battle-scoped
  // effectiveness rows (battle ONLY) ride the SAME response, so the ExperimentsTab renders both and
  // the battle contenders' metrics are visible without folding them into the A/B rollup. The extra
  // field passes through handlePostQuery's { ...parsed } normalization; no new endpoint/stack wiring.
  const [rows, battleEffectiveness] = await Promise.all([
    fetchExperimentRows(days, params.experimentId, params.includeBattle === 'true'),
    fetchBattleEffectivenessRows(days, params.experimentId),
  ]);
  return success({
    data: rows,
    columns: EXPERIMENT_COLUMNS,
    battleEffectiveness: { data: battleEffectiveness, columns: BATTLE_EFFECTIVENESS_COLUMNS },
  });
}

/**
 * The recommendation contract (DESIGN §4 / A.6). Confidence is DERIVED FROM THE
 * STATISTIC (§4.2-E), not an LLM's self-assessment; the LLM/template only narrates
 * the numbers in `rationale`. The human battle pick is a DISTINCT axis (`human`),
 * never blended into the metric verdict (INV-3/INV-4). Advisory only — nothing
 * here routes traffic (INV-1).
 */
export interface ExperimentRecommendation {
  verdict: Verdict; // 'promote_treatment'|'keep_control'|'keep_running'|'equivalent'|'inconclusive'
  confidence: Confidence; // derived from the stat, not the LLM
  rationale: string; // prose narration only
  primary: {
    metric: string;
    deltaPct: number; // treatment relative to control, %
    ci: [number, number]; // CI on the RAW mean difference (metric units)
    pValue: number;
    significant: boolean;
    powered: boolean;
  };
  /**
   * One entry per pre-registered guardrail. THREE states, not two: `held` (proven within the margin),
   * `breached` (proven past it, a ship veto), and neither, which is "not established" and is the state
   * a caller must not render as a breach. Both flags ride the payload because a caller cannot derive
   * the third state from `held` alone, and reading `!held` as breached reports a wide interval as a
   * demonstrated regression.
   */
  guardrails: Array<{ metric: string; deltaPct: number; bound: number; held: boolean; breached: boolean }>;
  human?: { picks: number; winRate: number; ci: [number, number]; significant: boolean };
  /**
   * User approval (thumbs) as a TESTED rate: the difference between variants with a Newcombe CI, not
   * a bare percentage. Absent when nobody has voted, so "no votes" never renders as "0% approval".
   *
   * A THIRD axis, kept separate from both the metric verdict and the battle pick. Thumbs are
   * self-selected feedback on ordinary traffic; battle picks are a forced choice in a duel; the
   * primary metric is a randomised measurement. Folding them together would average away exactly the
   * disagreement an operator needs to see.
   */
  approval?: {
    controlRate: number; treatmentRate: number; delta: number; ci: [number, number];
    pValue: number; significant: boolean; votes: number;
  };
  recommendedVsChosen?: { recommended: string; chosen?: ExperimentDecision['outcome'] };
  /** Exchanges per variant this deployment requires before a verdict is decision-grade. Configurable,
   *  so a caller must read it rather than assume one. */
  minSamplePerVariant?: number;
}

/** Per-variant continuous stats (mean, sd, n) pooled across the variant's intent rows. */
interface VariantContinuousStats {
  score: GroupStat;
  latency: GroupStat;
  cost: GroupStat;
  tokens: GroupStat;
  /** Exchanges an evaluator scored, summed across the variant's rows. Traffic is `score.n`; this is
   *  the evidence behind a quality/accuracy read, and the two diverge whenever scoring lags. */
  scoredCount: number;
}

/** Safe JSON-string param → typed object (null on absent/malformed). */
function parseJsonParam<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GET /analytics/experiments/recommendation - statistically-grounded, ADVISORY
 * recommendation from the actual test outcome (DESIGN §4). It never reroutes
 * traffic (INV-1). Confidence is computed from the statistic (§4.2-E), not an
 * LLM opinion; the human battle pick is surfaced as a distinct axis, never
 * blended (INV-3/INV-4). Returns the A.6 ExperimentRecommendation plus `variants`.
 *
 * Optional params (the caller holds the experiment record client-side): `objective`
 * (JSON ExperimentObjective — primary metric, guardrails, humanPickWeight) and
 * `decision` (JSON ExperimentDecision — the operator's recorded outcome, for the
 * recommended-vs-chosen meta-signal). Absent ⇒ a quality-primary default with no
 * guardrails (additive, INV-2).
 */
async function getExperimentRecommendation(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const days = Math.min(parseInt(params.days || '30', 10), 180);
  const experimentId = params.experimentId;
  if (!experimentId) {
    return error(400, 'experimentId is required');
  }
  const objective = parseJsonParam<ExperimentObjective>(params.objective);
  const decision = parseJsonParam<ExperimentDecision>(params.decision);

  // `includeBattle: false` keeps battle TURNS out of the probabilistic averages (rollup-safety), but
  // the rows still carry each variant's battle WINS, which is what feeds the human axis below. The
  // two are deliberately different populations: metrics exclude the duel, the human pick is the duel.
  const rows = await fetchExperimentRows(days, experimentId, false);
  // Collapse to one row per variant (sum across intents/tiers) for the summary,
  // and collect per-intent (mean, sd, n) so the continuous stats can be pooled
  // to a single variant-level (mean, sd, n) for the §4.2-B Welch tests.
  const byVariant = new Map<string, any>();
  const statsByVariant = new Map<
    string,
    { score: GroupStat[]; latency: GroupStat[]; cost: GroupStat[]; tokens: GroupStat[]; scored: number }
  >();
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

    // Per-intent dispersion groups for pooling. A null sd (single-row group)
    // pools as 0 variance for that group; a null cost drops the cost group.
    const grp = statsByVariant.get(key) || { score: [], latency: [], cost: [], tokens: [], scored: 0 };
    // Scoring coverage sums straight across the variant's rows: it is a count of scored exchanges,
    // not a mean, so it is never exchange-count weighted.
    grp.scored += Number(r.scored_count) || 0;
    grp.score.push({ n, mean: Number(r.avg_score) || 0, sd: r.score_sd == null ? 0 : Number(r.score_sd) });
    grp.latency.push({ n, mean: Number(r.avg_total_ms) || 0, sd: r.latency_sd == null ? 0 : Number(r.latency_sd) });
    grp.tokens.push({ n, mean: Number(r.avg_tokens) || 0, sd: r.tokens_sd == null ? 0 : Number(r.tokens_sd) });
    if (r.avg_cost_usd != null) {
      grp.cost.push({ n, mean: Number(r.avg_cost_usd), sd: r.cost_sd == null ? 0 : Number(r.cost_sd) });
    }
    statsByVariant.set(key, grp);
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
      // Carried on the rows by fetchExperimentRows, which joins the picks per variant regardless of
      // includeBattle: a pick only ever exists from a battle, so excluding battle TURNS from the
      // metric averages (rollup-safety) must not also hide the human signal.
      battle_wins: v.battle_wins > 0 ? v.battle_wins : null,
    };
  });

  const minN = variants.length ? Math.min(...variants.map((v) => v.exchange_count)) : 0;

  // Short-circuit: not enough data, or not a 2-variant comparison. No stats/model
  // call. Emits the full A.6 shape so the console renders one contract everywhere.
  //
  // THE HUMAN AXIS IS NOT GATED BY THIS FLOOR (§4.3). It is a SEPARATE axis - "never folded into" the
  // metric verdict - and it is measured on a DIFFERENT population: the metric floor counts
  // probabilistic traffic, which deliberately EXCLUDES battle turns (`includeBattle: false`, see
  // fetchExperimentRows), while every pick comes FROM a battle. Gating the picks behind the
  // probabilistic floor therefore withheld the human signal precisely when battles were the evidence
  // being collected - a battle-driven evaluation could accrue any number of picks and still report no
  // human block at all. Battle picks are part of the evaluation, so they are reported whenever they
  // exist, alongside (never merged into) the metric read.
  const humanAxis = battlePickAxis(variants);
  // Approval is the other human signal, on ordinary traffic rather than duels. Same reasoning as the
  // battle axis: it is not gated by the probabilistic floor, because it is a separate measurement
  // reported alongside rather than an input to the metric verdict.
  const approval = approvalAxis(variants);

  if (variants.length < 2 || minN < MIN_SAMPLE_PER_VARIANT) {
    const metricNote = variants.length < 2
      ? 'Only one variant has recorded traffic, so there is nothing to compare on metrics yet.'
      : `The smallest variant has ${minN} exchanges, below the ${MIN_SAMPLE_PER_VARIANT}-exchange floor for a reliable metric read.`;
    // Say what the human signal shows even though the metric half is not ready, so an operator
    // running a battle-led evaluation sees their picks rather than a bare "keep it running".
    const humanNote = humanAxis
      ? ` Human picks so far: ${Math.round(humanAxis.winRate * 100)}% for treatment across ${humanAxis.picks} `
        + `pick${humanAxis.picks === 1 ? '' : 's'} (95% CI ${Math.round(humanAxis.ci[0] * 100)}-${Math.round(humanAxis.ci[1] * 100)}%), `
        + `which ${humanAxis.significant ? 'excludes' : 'includes'} 50%. That is the human axis only; it does not `
        + 'settle the metric comparison.'
      : ' No battle picks recorded yet either.';
    const approvalNote = approval
      ? ` User approval: ${Math.round(approval.treatmentRate * 100)}% treatment vs `
        + `${Math.round(approval.controlRate * 100)}% control across ${approval.votes} vote`
        + `${approval.votes === 1 ? '' : 's'} (95% CI on the difference `
        + `${(approval.ci[0] * 100).toFixed(1)} to ${(approval.ci[1] * 100).toFixed(1)} points), `
        + `which ${approval.significant ? 'excludes' : 'includes'} zero.`
      : '';
    const rec = inconclusiveRecommendation(`${metricNote}${humanNote}${approvalNote}`, objective, decision);
    return success({
      ...rec,
      ...(humanAxis ? { human: humanAxis } : {}),
      ...(approval ? { approval } : {}),
      variants,
      experimentId,
    });
  }

  // Pool each variant's per-intent groups into one (mean, sd, n) per metric.
  const pooled = new Map<string, VariantContinuousStats>();
  for (const [key, grp] of statsByVariant) {
    pooled.set(key, {
      score: poolGroups(grp.score),
      latency: poolGroups(grp.latency),
      cost: poolGroups(grp.cost),
      tokens: poolGroups(grp.tokens),
      scoredCount: grp.scored,
    });
  }

  const rec = await computeRecommendation(variants, pooled, objective, decision);
  return success({ ...rec, variants, experimentId });
}

/** The A.6 shape for the not-enough-data / single-variant case (honest, INV-3). */
/**
 * The human battle-pick axis, derived from the variants' `battle_wins`.
 *
 * Returns null when no pick has been recorded, so "no battles yet" stays visibly different from
 * "battles ran and split 50/50" - a zero-filled axis would read as the latter.
 *
 * Orientation matches the metric axis: the rate is TREATMENT's share of decisive picks, so a >50%
 * human rate and a positive metric delta point the same way and can be compared without re-reading
 * which side the number describes. Ties carry no variantId and never reach `battle_wins`, so
 * `picks` is the count of DECISIVE picks.
 */
export function battlePickAxis(
  variants: Array<{ variant_id: string; battle_wins: number | null }>,
): { picks: number; winRate: number; ci: [number, number]; significant: boolean } | null {
  if (variants.length < 2) return null;
  const control = variants.find((v) => v.variant_id === 'control') || variants[0];
  const treatment = variants.find((v) => v.variant_id === 'treatment') || variants.find((v) => v !== control) || variants[1];
  const tWins = Number(treatment?.battle_wins) || 0;
  const cWins = Number(control?.battle_wins) || 0;
  const decisive = tWins + cWins;
  if (decisive <= 0) return null;
  const r = humanPickTest(tWins, decisive);
  return { picks: r.picks, winRate: r.winRate, ci: r.ci as [number, number], significant: r.significant };
}

/**
 * The USER-APPROVAL axis: thumbs up/down collected on ordinary (non-duel) experiment traffic.
 *
 * Reported as a TESTED rate with a confidence interval, not a bare percentage. `GUIDE-AB-TESTING`
 * listed approval among the rate metrics that "each use the appropriate test, and the difference is
 * reported with a confidence interval" - which was untrue: approval is not in `ExperimentObjectiveMetric`
 * (`cost|accuracy|quality|latency`), so it could be neither a primary metric nor a guardrail, and
 * `experiment-stats.ts` had no reference to it. It was collected, displayed, and never evaluated.
 *
 * This is the SECOND human signal and the higher-volume one: a battle pick needs a duel, whereas any
 * exchange can carry a thumb. Like the battle axis it stays SEPARATE from the metric verdict - it is
 * self-selected feedback, not a randomised measurement, so it informs a decision rather than settling it.
 *
 * delta is treatment minus control, matching the orientation of the metric delta and the battle axis,
 * so all three point the same way. Returns null when neither side has a vote, so "nobody voted" stays
 * distinct from "both sides scored 0%".
 */
export function approvalAxis(
  variants: Array<{ variant_id: string; thumbs_up?: number; feedback_count?: number }>,
): {
  controlRate: number; treatmentRate: number; delta: number; ci: [number, number];
  pValue: number; significant: boolean; votes: number;
} | null {
  if (variants.length < 2) return null;
  const control = variants.find((v) => v.variant_id === 'control') || variants[0];
  const treatment = variants.find((v) => v.variant_id === 'treatment') || variants.find((v) => v !== control) || variants[1];
  const cN = Number(control?.feedback_count) || 0;
  const tN = Number(treatment?.feedback_count) || 0;
  if (cN + tN <= 0) return null;
  const cUp = Number(control?.thumbs_up) || 0;
  const tUp = Number(treatment?.thumbs_up) || 0;
  const r = twoProportionTest(tUp, tN, cUp, cN);
  return {
    controlRate: r.pB,
    treatmentRate: r.pA,
    delta: r.delta,
    ci: r.ci,
    pValue: r.pValue,
    // Significant when the CI on the DIFFERENCE excludes zero, the same bar the metric axis uses.
    significant: r.ci[0] > 0 || r.ci[1] < 0,
    votes: cN + tN,
  };
}

function inconclusiveRecommendation(
  rationale: string,
  objective?: ExperimentObjective,
  decision?: ExperimentDecision,
): ExperimentRecommendation {
  const metric = objective?.metric ?? 'quality';
  return {
    verdict: 'inconclusive',
    confidence: 'low',
    rationale,
    primary: { metric, deltaPct: 0, ci: [0, 0], pValue: 1, significant: false, powered: false },
    guardrails: [],
    recommendedVsChosen: { recommended: 'inconclusive', chosen: decision?.outcome },
  };
}

/**
 * Compute the statistically-grounded recommendation (DESIGN §4.2-4.4) from the
 * pooled per-variant stats. The verdict is a pre-registered decision RULE, the
 * confidence is DERIVED from the primary p-value/power/guardrails (§4.2-E), and
 * the human battle pick is a distinct axis. Nothing is auto-judged (INV-4).
 */
async function computeRecommendation(
  variants: any[],
  pooled: Map<string, VariantContinuousStats>,
  objective?: ExperimentObjective,
  decision?: ExperimentDecision,
): Promise<ExperimentRecommendation> {
  // Orient control vs treatment (fall back to first/second when unlabeled).
  const control = variants.find((v) => v.variant_id === 'control') || variants[0];
  const treatment = variants.find((v) => v.variant_id === 'treatment') || variants.find((v) => v !== control) || variants[1];
  const cStats = pooled.get(control.variant_id) || zeroStats();
  const tStats = pooled.get(treatment.variant_id) || zeroStats();

  const primaryMetric: ExperimentObjectiveMetric = objective?.metric ?? 'quality';

  // Objective-DRIVEN evaluation (§4.2-4.4, experiment-stats.evaluateExperimentOutcome): the
  // recommendation reads the objective's primary metric + good-direction, ties the power check
  // to its target, applies its guardrails, and folds the weighted human battle pick as a
  // distinct axis — so the verdict HONORS THE GOALS of the test, not a fixed metric. Pure +
  // unit-tested; here we only orient the variants, then narrate the result.
  // Computed once; referenced in the payload below.
  const approvalOnPoweredPath = approvalAxis(variants);

  const { primary, guardrails, human: hp, humanPickWeight, verdict, confidence, humanAgrees, humanConflicts } =
    evaluateExperimentOutcome({
      control: cStats,
      treatment: tStats,
      objective: objective as OutcomeObjective | undefined,
      battleWins: { treatment: Number(treatment.battle_wins) || 0, control: Number(control.battle_wins) || 0 },
    });

  const template = buildRationale({
    verdict,
    confidence,
    control,
    treatment,
    primary,
    guardrails,
    hp,
    humanPickWeight,
    humanAgrees,
    humanConflicts,
    objectiveMetric: primaryMetric,
  });
  // The LLM (or the template fallback) narrates the numbers ONLY — it never sources
  // the verdict or confidence (§4.2-E). A failed/odd model call keeps the template.
  const rationale = await narrateRationale(template);

  return {
    verdict,
    confidence,
    rationale,
    primary: {
      metric: primary.metric,
      deltaPct: primary.deltaPct,
      ci: primary.ci,
      pValue: primary.pValue,
      significant: primary.significant,
      powered: primary.powered,
    },
    guardrails: guardrails.map((g) => ({
      metric: g.metric, deltaPct: g.deltaPct, bound: g.bound, held: g.held, breached: g.breached,
    })),
    human: hp
      ? { picks: hp.picks, winRate: round4(hp.winRate), ci: [round4(hp.ci[0]), round4(hp.ci[1])], significant: hp.significant }
      : undefined,
    // User approval (thumbs) as a TESTED rate, alongside and separate from the metric verdict. It is
    // self-selected feedback rather than a randomised measurement, so like the battle pick it informs
    // the decision and never silently moves it.
    ...(approvalOnPoweredPath ? { approval: approvalOnPoweredPath } : {}),
    recommendedVsChosen: { recommended: verdict, chosen: decision?.outcome },
    // The floor THIS deployment applies. It is configurable, so a console that hardcodes a number
    // will eventually contradict the verdict it is rendering next to - banner a variant as "below N
    // exchanges" while the backend has already returned a real verdict, or prescribe "need ~N more"
    // against a threshold the backend does not use. Reported so the console can state the truth
    // rather than infer it.
    minSamplePerVariant: MIN_SAMPLE_PER_VARIANT,
  };
}

function zeroStats(): VariantContinuousStats {
  const z: GroupStat = { n: 0, mean: 0, sd: 0 };
  // scoredCount 0 is the truth for a variant with no rows at all, and it keeps the sufficiency gate
  // engaged rather than leaving it unknown for the one case that has the least evidence of all.
  return { score: { ...z }, latency: { ...z }, cost: { ...z }, tokens: { ...z }, scoredCount: 0 };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Deterministic prose narrating the computed numbers (the honest default). */
function buildRationale(a: {
  verdict: Verdict;
  confidence: Confidence;
  control: any;
  treatment: any;
  primary: PrimaryEval;
  guardrails: GuardrailEval[];
  hp: ReturnType<typeof humanPickTest> | null;
  humanPickWeight: number;
  humanAgrees: boolean;
  humanConflicts: boolean;
  objectiveMetric: ExperimentObjectiveMetric;
}): string {
  const sigTxt = a.primary.significant
    ? `p=${a.primary.pValue}`
    : a.primary.powered
      ? `not significant (p=${a.primary.pValue})`
      : 'underpowered for the target effect';
  const parts: string[] = [];
  parts.push(
    `Primary metric ${a.primary.metric}: treatment ${a.primary.deltaPct >= 0 ? '+' : ''}${a.primary.deltaPct}% vs control (CI [${a.primary.ci[0]}, ${a.primary.ci[1]}], ${sigTxt}).`,
  );
  // Each guardrail is narrated as the state it is actually in. Three things were wrong with saying
  // "breach ... (significant)" or otherwise "guardrails held": the significance behind a breach is now
  // against the BOUND rather than against zero, so "significant" no longer names what was tested; an
  // `at_least` breach is a required improvement MISSED, not a regression past a ceiling, and calling a
  // proven +3% improvement "past its 5% bound" reported a win as a loss; and a guardrail that is
  // merely indeterminate was swept into "Guardrails held", claiming the one thing the interval was too
  // wide to establish, next to a verdict that had already declined to ship because of it.
  const breached = a.guardrails.filter((g) => g.breached);
  const indeterminate = a.guardrails.filter((g) => g.indeterminate);
  const held = a.guardrails.filter((g) => g.held);
  const signedPct = (n: number): string => `${n >= 0 ? '+' : ''}${n}%`;
  if (a.guardrails.length) {
    const clauses: string[] = [];
    if (breached.length) {
      clauses.push(
        `Guardrail breach: ${breached
          .map((g) =>
            g.direction === 'at_least'
              ? `${g.metric} ${signedPct(g.deltaPct)} falls short of its ${g.bound}% floor, with the whole confidence interval below it`
              : `${g.metric} ${signedPct(g.deltaPct)} past its ${g.bound}% bound, with the whole confidence interval beyond it`,
          )
          .join('; ')}. A ship is vetoed.`,
      );
    }
    if (indeterminate.length) {
      clauses.push(
        `Guardrails not established: ${indeterminate
          .map((g) => `${g.metric} ${signedPct(g.deltaPct)} against a ${g.bound}% bound, on an interval too wide to place either side of it`)
          .join('; ')}. That is too little evidence to ship on, not a pass.`,
      );
    }
    if (held.length) {
      clauses.push(`Guardrails held: ${held.map((g) => `${g.metric} ${signedPct(g.deltaPct)} within ${g.bound}%`).join('; ')}.`);
    }
    parts.push(clauses.join(' '));
  }
  if (a.hp) {
    const pct = Math.round(a.hp.winRate * 100);
    const lo = Math.round(a.hp.ci[0] * 100);
    const hi = Math.round(a.hp.ci[1] * 100);
    const human = `Humans: ${a.hp.wins}/${a.hp.picks} picked treatment (${pct}% [${lo}-${hi}%]${a.hp.significant ? ', excludes 50%' : ', not significant'}).`;
    // The human axis is shown ALWAYS but folded into the rule only when weighted;
    // agreement reinforces, disagreement is surfaced — never averaged (INV-3).
    if (a.humanConflicts) {
      parts.push(`${human} This CONTRADICTS the metric verdict — reconcile it yourself; the signals are not averaged.`);
    } else if (a.humanAgrees) {
      parts.push(`${human} This agrees with the metric verdict, reinforcing it.`);
    } else {
      parts.push(human);
    }
  }
  const verdictTxt: Record<Verdict, string> = {
    promote_treatment: 'Recommendation: promote treatment',
    keep_control: 'Recommendation: keep control',
    keep_running: 'Recommendation: keep running — not enough data yet',
    equivalent: `Recommendation: variants are equivalent on ${a.primary.metric}`,
    inconclusive: 'Recommendation: inconclusive',
  };
  let tail = `${verdictTxt[a.verdict]} (confidence: ${a.confidence}).`;
  if (a.verdict === 'equivalent' && (a.objectiveMetric === 'cost' || a.objectiveMetric === 'latency')) {
    tail += ` As the objective is ${a.objectiveMetric}, prefer the cheaper/faster side as a tiebreak.`;
  }
  parts.push(`${tail} Advisory only — not auto-applied.`);
  return parts.join(' ');
}

/**
 * Prose-only narration. Given the already-computed, verdict-bearing template, ask
 * the model to render a cleaner one-paragraph narration WITHOUT changing the
 * decision — it no longer sources the verdict/confidence (§4.2-E). Any failure or
 * empty output falls back to the deterministic template, so a recommendation is
 * always available.
 */
async function narrateRationale(template: string): Promise<string> {
  try {
    const resp = await bedrockClient.send(new InvokeModelCommand({
      modelId: RECOMMENDATION_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 300,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: `Rewrite the following A/B-test recommendation as one clear, neutral paragraph for an operator. Keep EVERY number, the verdict, and the confidence EXACTLY as given — do not add, change, or infer any conclusion. Return only the paragraph, no preamble.\n\n${template}`,
        }],
      }),
    }));
    const body = JSON.parse(new TextDecoder().decode(resp.body));
    const text: string = (body?.content?.[0]?.text || '').trim();
    if (text.length >= 20) return text;
    console.warn('[experiment-recommendation] narration too short, using template');
  } catch (err) {
    console.warn('[experiment-recommendation] narration model call failed, using template:', err);
  }
  return template;
}
