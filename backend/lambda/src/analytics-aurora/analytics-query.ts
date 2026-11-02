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
 * - GET /analytics/context?personId=X       - Cross-conversation context for a user
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { RECORDED_FUNNEL_STAGES } from '../lib/funnel-stages.js';
import { SIGNIN_FUNNEL, SIGNUP_FUNNEL, type SessionFunnel } from '../lib/session-funnels.js';
import { TASK_STALL_TURNS } from '../lib/task-trajectory.js';
import { agreementOf } from '../lib/agreement.js';
import { toolOwnerOf } from '../lib/tool-registry.js';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { stripMessageMarkers } from '../lib/message-markers.js';
import { query, ensureSchema } from './db-client.js';
import { updateJoinSql, ARCHIVAL_SUFFIX_SQL } from './update-events.js';
import { goldenSourceOf, precedingTurnsOf, GOLDEN_PRECEDING_TURNS } from '../lib/golden-entry.js';
import { withReaderRole, withWriterRole } from './classification-boundary.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import { estimateStepCostUsd, bedrockModelIdToKey } from '../lib/model-rate-table.js';
import { imageGenModelIdToKey } from '../lib/image-gen-models.js';
import { successTerminalStates } from '../lib/task-state-machines.js';
import { callerIsAdmin, callerCanReadArchive, isAdminIamEnforcedCall, callerPerson, callerPersonId } from '../lib/auth.js';
import { queryTypeAllowedOnPath } from '../lib/admin-capability-map.js';
import { scopeForRequest, scopeAnalyticsRows, classificationAllowed, type ClassificationScope } from '../lib/caller-scope.js';

// A14 Scoped: the pool the caller's classification scope is resolved against.
const USER_POOL_ID = process.env.USER_POOL_ID || '';
import { recordModerationAction, adminListEvents } from './admin-conversations-aurora.js';
import { botIdSql, personIdSql } from '../lib/person-arn.js';
import {
  aggregateVariantFeedback,
  aggregateBattleWinsByVariant,
  flattenBattleOutcomeItem,
  feedbackColumnsFor,
  feedbackKey,
  battleWinKey,
  selectVariantFeedbackRecords,
  selectBattlePicks,
  approvalClustersByVariant,
  duelPickClusters,
  type FeedbackRecord,
  type VariantFeedback,
  type BattleOutcomeItem,
  type SignalCluster,
} from './variant-feedback.js';
import {
  welchTTest,
  poolGroups,
  requiredSampleForMean,
  humanPickTest,
  twoProportionTest,
  clusteredTwoProportionTest,
  clusteredHumanPickTest,
  clusterDesignEffect,
  clusterAdjust,
  type ClusterMoments,
  decideVerdict,
  evaluateExperimentOutcome,
  type GroupStat,
  type PrimaryEval,
  type GuardrailEval,
  type Verdict,
  type Confidence,
  type OutcomeObjective,
  minimumDetectableDifference,
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
import { DEFAULT_COMPLIANCE_RULES } from '../../../lib/config/compliance-rules.js';
import { INTERNAL_MARKER_FINDING_IDS } from '../../../lib/config/guardrail-masks.js';
import { UTILITY_MODEL_ID } from '../../../lib/config/model-strategy.js';
import { responder, originsFrom, requestOrigin } from '../lib/http-response.js';
import { loadProfileRegistry } from '../../../lib/profile-registry';

/**
 * The rule ids whose breach means somebody needs to know today.
 *
 * READ FROM THE RULE SET RATHER THAN LISTED HERE. `severity` is declared beside each rule's
 * statement, and a second list of "the important ones" in a query is how a rule gets downgraded in
 * one place and not the other. Handed to SQL as a text array, so adding a blocking rule to the config
 * changes what the console alerts on with no edit to this file.
 */
const BLOCKING_RULE_IDS = DEFAULT_COMPLIANCE_RULES.filter((r) => r.severity === 'blocking').map((r) => r.id);

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
// auto-applies (INV-1), but "advisory" is not a license to read an underpowered verdict as a result.
//
// Per VARIANT, so the SMALLEST arm gates the result. Set via the `minSamplePerVariant` context key.
const MIN_SAMPLE_PER_VARIANT = Math.max(
  1,
  Number(process.env.MIN_SAMPLE_PER_VARIANT) || 5,
);

// Cheapest model that is everywhere; we only summarize a small metrics table.
// NOTE: the analytics-query Lambda role must grant bedrock:InvokeModel on this
// model for getExperimentRecommendation to work.
const RECOMMENDATION_MODEL_ID = UTILITY_MODEL_ID;
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

// UserFeedback table (DynamoDB, owned by the Conversations stack) for the thumbs
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

// CORS: the request's origin when listed, else the first configured one. Set per request.
const http = responder({
  origin: { allow: originsFrom(process.env.ALLOWED_ORIGINS, '', { dropEmpty: true }), fallback: '' },
  methods: 'GET,OPTIONS',
});
let corsHeaders: Record<string, string> = http.headers();

function initCors(event: APIGatewayProxyEvent): void {
  corsHeaders = http.headers(requestOrigin(event));
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
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  console.log('Analytics query:', event.path, event.queryStringParameters);
  initCors(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // Lambda-side defense in depth: the gateway authorizer is wired
  // (archive-stack-aurora.ts), but every analytics endpoint additionally
  // requires an admin caller (`callerIsAdmin`). /context could leak a cross-tenant personId -
  // allow self-lookup OR admin, never an arbitrary personId from a non-admin.
  // THE CALLER IS THE PERSON THE ONE RESOLVER NAMES (`callerPersonId`).
  //
  // The analytics API is AWS_IAM authorized in every deployment: the admin console SigV4-signs with the
  // console session the credential exchange vends, and a Bearer JWT is rejected outright. There is no
  // authorizer, so the person appears only in the signed session.
  //
  // Nothing 401s on the way in, because a trusted IAM admin legitimately names no person and the gate
  // below allows it. Without the session's person the cost lands on the two things that ATTRIBUTE rather
  // than authorize: `classifier_replay_adjudicate` refuses outright ("an adjudication must be attributable to
  // a caller"), and the moderation audit records its actor as blank - a redaction with no name against
  // it, which is worse than the refusal because it succeeds.
  //
  // The resolver reads the person from the console session's role-session name, or resolves an
  // Identity-Pool call's subject, so it is a server-verified fact. It is not, and must not become, a
  // body-supplied value: `buildParamsFromBody` deliberately omits `callerSub` from its allowlist so a
  // caller cannot attribute a write to someone else.
  const callerSub = (await callerPersonId(event)) || '';
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
      // ALWAYS, because every analytics route is IAM-authorized: the resource the gateway admitted
      // the caller to names one capability, and the body must ask for that capability's work. A write
      // (a flag, a label, an adjudication) is decided by its `action` as well as its queryType.
      {
        const { queryType: qt, action } = parsePostQueryTypeAndAction(event.body);
        if (!queryTypeAllowedOnPath(qt, event.path || '', action)) {
          return error(403, 'queryType not permitted on this resource');
        }
      }
      // Moderation audit: the actor is the SERVER-VERIFIED admin (the resolved person), never
      // the client body — so attribution can't be spoofed. Intercepted before query dispatch.
      const mod = await maybeRecordModeration(event.body, callerSub, (await callerPerson(event))?.contact ?? { email: null, name: null });
      if (mod) return mod;
      // The complete raw event log reads conversation ARCHIVE content — a SEPARABLE authorization
      // from base admin (a future role can be denied it). Interim group gate; IAM-enforceable
      // capability is the tracked follow-up. See callerCanReadArchive.
      if (isArchiveReadBody(event.body) && !callerCanReadArchive(event)) {
        return error(403, 'Archive-view permission required');
      }
      // A14 Scoped: resolve the caller's classification scope and narrow the
      // result rows. Full (null) only on a Cognito-JWT call; an enforced call fails
      // closed to the floor if the caller cannot be identified (scopeForRequest).
      const callerScope: ClassificationScope = isAdminIamEnforcedCall(event)
        ? await scopeForRequest(event, USER_POOL_ID)
        : null;
      // A TEAM MEMBER'S ROUTE NAMES ONE ASSISTANT (`/analytics/assistants/{assistant}/query`). IAM admitted
      // the caller to that path only because the credential exchange named it in their session, after
      // checking their team owns the assistant and their clearance reaches it; this handler runs in a
      // VPC with no route to Cognito or the Amazon Chime SDK to read that again, so what it does instead
      // is bind every row it returns to the assistant in the path.
      const assistant = event.pathParameters?.assistant ? decodeURIComponent(event.pathParameters.assistant) : undefined;
      return handlePostQuery(event.body, callerScope, callerSub, assistant);
    }

    const path = event.path || '';
    const params = event.queryStringParameters || {};

    // /context is the only endpoint that allows non-admin self-lookup.
    // Every other endpoint requires admin.
    if (path.endsWith('/context')) {
      const requestedPersonId = params.personId;
      if (!isAdmin && requestedPersonId !== callerSub) {
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
 * Why a person said a response was bad. Closed, shared verbatim with the chat client
 * (`frontend/packages/shared/src/services/feedbackService.ts`) and with `human_flag.reason`
 * (migration 059), so a moderator's reason and an end user's reason count as the same thing.
 * Validated here rather than trusted: an unrecognized value would split a rollup silently.
 */
const FLAG_REASONS = ['wrong_assistant', 'poor_answer', 'asked_again'] as const;

function normalizeFlagReason(raw: string | undefined): string | null {
  return raw && (FLAG_REASONS as readonly string[]).includes(raw) ? raw : null;
}

/** One person's CURRENT verdict on one response, after the decision trail is collapsed. */
interface LatestVote {
  messageId: string;
  /** The intent the message was classified to, as recorded on the vote. 'unknown' on older records. */
  intent: string;
  /** 'up' | 'down' | 'clear'. Only 'down' is a flag; 'up' and 'clear' are counted as RATED, not flagged. */
  feedback: string;
  /** The closed reason, or `'unspecified'` when they voted without saying why (the common case). */
  reason: string;
  /** Prose the person left with the rating, when they left any. Null is the common case. */
  note: string | null;
  /** Where it was left, so a rating can be opened in the conversation it belongs to. */
  channelArn: string | null;
  createdAt: string;
  /** Who left it, as the vote recorded it. Read by the frustration reading, which never sums two people. */
  voter?: string;
}

/** One end user's `Needs work`, reduced to what the flagged list needs. */
interface PersonFlag {
  messageId: string;
  reason: string;
  createdAt: string;
}

/** Per-intent user signal, folded from the votes. Counts, not just a rate, because a rate over four
 *  votes and a rate over four hundred read identically and mean nothing alike. */
export interface UserSignal {
  rated: number;
  /**
   * UP AND DOWN COUNTED SEPARATELY.
   *
   * `flagged` counts a thumbs DOWN, which is a rating and not a flag - the word collided with the
   * Flagged surface, which counts something else entirely. Naming both directions lets the console
   * show a positive share instead of a negative count, which is the reading somebody actually wants,
   * and stops a down-vote being reported as if a flag had been raised.
   */
  up: number;
  down: number;
  flagged: number;
  wrongAssistant: number;
  poorAnswer: number;
  askedAgain: number;
  unspecified: number;
}

/**
 * Every `Needs work` in the window, newest vote per (voter, message).
 *
 * This is a SEPARATE scan from `scanFeedbackRecords`, which looks similar and is not: that one
 * filters to `attribute_exists(experimentId)` because it answers "how did this variant do", and it
 * would silently drop every vote on ordinary traffic — which is all of the traffic a moderator
 * cares about. Reusing it here would have produced a flagged list that only ever showed responses
 * served by a running experiment.
 *
 * The collapse to the latest vote per voter is the same rule `summarizeFeedback` applies, and for
 * the same reason: the table APPENDS every revision, so a person who voted down and then cleared it
 * must not still appear as having flagged the response.
 *
 * Fails OPEN — an unset table or a scan error yields no rows, and the list renders the other two
 * origins rather than erroring (logged server-side).
 */
async function scanLatestVotes(win: QueryWindow): Promise<LatestVote[]> {
  if (!FEEDBACK_TABLE) return [];
  const latest = new Map<string, { ts: number } & LatestVote>();
  try {
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const res: any = await ddbDocClient.send(
        new ScanCommand({
          TableName: FEEDBACK_TABLE,
          // #intent rides along so the same scan answers the per-intent rollup. Splitting it into a
          // second scan would double the read for one extra attribute, and the two could then
          // disagree about which votes were in the window.
          ProjectionExpression: '#us, #mid, #fb, #reason, #ca, #intent, #note, #chan',
          ExpressionAttributeNames: {
            '#us': 'userSub',
            '#mid': 'messageId',
            '#fb': 'feedback',
            '#reason': 'reason',
            '#ca': 'createdAt',
            '#intent': 'intent',
            // WHAT THE PERSON ACTUALLY WROTE. A rating can carry prose and this scan dropped it, so
            // the only thing an operator could see was a count - the least useful part of a signal
            // somebody took the trouble to leave.
            '#note': 'note',
            '#chan': 'channelArn',
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const it of res.Items || []) {
        const messageId = String(it.messageId || '');
        const createdAt = String(it.createdAt || '');
        const ts = Date.parse(createdAt);
        if (!messageId || !Number.isFinite(ts)) continue;
        // The stored attribute is still named userSub; what it holds is the voter's person key.
        const voter = String(it.userSub || '');
        const key = `${voter}#${messageId}`;
        const prev = latest.get(key);
        if (!prev || ts > prev.ts) {
          latest.set(key, {
            ts,
            feedback: String(it.feedback || ''),
            // A vote with no reason is still a flag — the reason is an optional refinement, so the
            // absence of one must not drop the vote. 'unspecified' keeps it countable and keeps the
            // console from rendering a blank chip.
            reason: normalizeFlagReason(it.reason ? String(it.reason) : undefined) || 'unspecified',
            // Stored on the vote by the client at the time it was cast. Older rows predate it, and
            // 'unknown' keeps them countable in the totals rather than silently dropping a real vote.
            intent: String(it.intent || 'unknown'),
            note: it.note ? String(it.note) : null,
            channelArn: it.channelArn ? String(it.channelArn) : null,
            messageId,
            createdAt,
            voter,
          });
        }
      }
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
  } catch (err) {
    console.warn('[user-signal] thumbs scan failed (rendering without person-raised signal):', err);
    return [];
  }
  const out: LatestVote[] = [];
  for (const v of latest.values()) {
    if (v.ts < win.startMs || v.ts >= win.endMs) continue;
    out.push({
      messageId: v.messageId, intent: v.intent, feedback: v.feedback, reason: v.reason,
      note: v.note ?? null, channelArn: v.channelArn ?? null, createdAt: v.createdAt,
      ...(v.voter ? { voter: v.voter } : {}),
    });
  }
  return out;
}

/** The flagged list wants only the flags. 'up' and 'clear' are votes, not flags. */
function downVotesOnly(votes: LatestVote[]): PersonFlag[] {
  return votes
    .filter((v) => v.feedback === 'down')
    .map((v) => ({ messageId: v.messageId, reason: v.reason, createdAt: v.createdAt }));
}

/**
 * USER SIGNAL PER INTENT, folded in memory from the votes.
 *
 * In Aurora rather than beside it deliberately: thumbs live in DynamoDB and this codebase joins them
 * in memory rather than replicating them (tenet D7, and `variant-feedback.ts` documents the choice).
 * A copy here would be a second answer to "how many people disliked this" that drifts from the first.
 *
 * BOTH NUMBERS TRAVEL. `flagged` alone invites reading the remainder as satisfaction, and it is not:
 * voting is voluntary and most turns get no vote at all, so `rated` is the population the rate is
 * actually over. Exported for the unit tests, which is where the fold's rules are pinned.
 *
 * ── IT FOLDS INTO THE ROW'S POPULATION, NOT INTO THE WHOLE WINDOW ────────────────────────────────
 *
 * `scope` maps an agent message id to the intent it was counted under, built from the SAME filtered
 * query the rows come from. Without it this fold keyed on the vote's own self-reported intent and
 * the thumbs scan filters on TIME ALONE - so every user-signal column spanned every assistant, role,
 * classification and profile version no matter what the filter bar said, and `user_rated_share`
 * divided that unfiltered numerator by a filtered `exchange_count` and could exceed 100%. The page
 * exists to answer "how is THIS assistant doing" and answered it with everyone else's thumbs.
 *
 * A vote whose message is not in scope is OUT OF POPULATION and is not counted. A vote whose message
 * IS in scope but whose intent was never recorded is UNATTRIBUTED: it is counted in `unattributed`
 * and reported as coverage loss rather than dropped, because a tally that quietly shrinks reads as
 * "fewer people complained".
 */
export function foldUserSignalByIntent(
  votes: LatestVote[],
  scope?: Map<string, string>,
): { byIntent: Map<string, UserSignal>; unattributed: number; outOfScope: number } {
  const by = new Map<string, UserSignal>();
  let unattributed = 0;
  let outOfScope = 0;
  for (const v of votes) {
    // A 'clear' is a withdrawn opinion, not an opinion. Counting it as rated would inflate the
    // denominator with people who decided they had nothing to say.
    if (v.feedback !== 'up' && v.feedback !== 'down') continue;

    // WHICH INTENT THIS VOTE BELONGS TO IS THE POPULATION'S ANSWER, NOT THE VOTE'S. The vote carries
    // an intent the client stamped when it was cast; the row carries the intent the exchange was
    // counted under. Where both exist they agree, and where they differ the row is the one the
    // reader is looking at.
    let intent = v.intent;
    if (scope) {
      const scoped = scope.get(v.messageId);
      if (scoped === undefined) { outOfScope += 1; continue; }
      if (scoped === 'unknown') { unattributed += 1; continue; }
      intent = scoped;
    } else if (intent === 'unknown') {
      unattributed += 1;
    }

    const cur = by.get(intent) || { rated: 0, up: 0, down: 0, flagged: 0, wrongAssistant: 0, poorAnswer: 0, askedAgain: 0, unspecified: 0 };
    cur.rated += 1;
    if (v.feedback === 'up') cur.up += 1;
    if (v.feedback === 'down') {
      cur.down += 1;
      cur.flagged += 1;
      if (v.reason === 'wrong_assistant') cur.wrongAssistant += 1;
      else if (v.reason === 'poor_answer') cur.poorAnswer += 1;
      else if (v.reason === 'asked_again') cur.askedAgain += 1;
      else cur.unspecified += 1;
    }
    by.set(intent, cur);
  }
  return { byIntent: by, unattributed, outOfScope };
}

/**
 * Quality > Flagged. THREE origins, and the list says which one raised each row:
 *
 *  - `judge`     - derived from `evaluation_results` (relevance below 50, non-compliant, or judge
 *                  flags attached). No stored row; re-evaluating an exchange re-derives it.
 *  - `moderator` - `human_flag` (migration 059), written from Oversight > Conversations.
 *  - `person`    - an end user's `Needs work` in the chat client.
 *
 * WHY THE THREE ARE NOT UNIFIED INTO ONE TABLE. Tenet D7: one source per question, and never treat
 * one store as a cache of another. The judge's verdict belongs to `evaluation_results` and migration
 * 014 exists precisely to keep human opinion out of it. End-user thumbs already have a home in
 * DynamoDB, and this codebase deliberately joins them in memory rather than replicating them into
 * Aurora (see `scanFeedbackRecords` and `variant-feedback.ts`) - copying them here would create a
 * second answer to "how many people disliked this" that drifts from the first.
 *
 * The reviewer's verdict stays in `flagged_review`, keyed by exchange, and now applies to whichever
 * origin raised the row.
 */
async function getFlaggedResponses(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  // A moderator raising a flag on a response they are reading. Keyed on (channelArn, messageId)
  // because that is what the transcript gives them; the exchange is resolved at read time below.
  if (params.action === 'flag') {
    const channelArn = params.channelArn;
    const messageId = params.messageId;
    const reason = normalizeFlagReason(params.reason);
    if (!channelArn || !messageId || !reason) {
      return success({
        flagged: false,
        error: `channelArn, messageId and a reason (${FLAG_REASONS.join(' | ')}) required`,
      });
    }
    // `callerSub` is the SERVER-VERIFIED admin sub threaded in by handlePostQuery, never the body.
    if (!params.callerSub) {
      return success({ flagged: false, error: 'Unable to attribute the flag to a caller' });
    }
    // ONLY ON AN ANSWER. The list below reaches a moderator flag through the exchange that claims the
    // message, so a flag on an assistant message no exchange claims (a welcome, a join notice, an
    // onboarding prompt) was stored, shown as flagged in the transcript, and never listed. It is
    // refused instead, so the write either reaches the Flagged list or says why it did not.
    const answer = await query(
      `SELECT 1 FROM messages m
         JOIN exchanges e ON e.agent_message_id = m.id
        WHERE m.message_id = $1 AND m.channel_arn = $2 AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
        LIMIT 1`,
      [messageId, channelArn],
    );
    if (answer.rows.length === 0) {
      return success({ flagged: false, error: 'Only an answer to a question can be flagged' });
    }
    // Re-flagging REPLACES: one current reason per response, so correcting a mis-click does not
    // leave the old reason behind. Same rule, and the same reason for it, as flagged_review.
    await query(
      `INSERT INTO human_flag (channel_arn, message_id, reason, note, flagged_by_sub)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_arn, message_id) DO UPDATE SET
         reason         = EXCLUDED.reason,
         note           = EXCLUDED.note,
         flagged_by_sub = EXCLUDED.flagged_by_sub,
         flagged_at     = NOW()`,
      [channelArn, messageId, reason, params.notes || null, params.callerSub],
    );
    return success({ flagged: true, messageId, reason });
  }
  // Clearing a flag a moderator raised. Deletes rather than writing a 'cleared' state: an
  // unflagged response is the ABSENCE of a flag, the same way 'pending' is the absence of a review.
  if (params.action === 'unflag') {
    const channelArn = params.channelArn;
    const messageId = params.messageId;
    if (!channelArn || !messageId) {
      return success({ unflagged: false, error: 'channelArn and messageId required' });
    }
    await query(`DELETE FROM human_flag WHERE channel_arn = $1 AND message_id = $2`, [channelArn, messageId]);
    return success({ unflagged: true, messageId });
  }
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
  const win = queryWindow(params, 7);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);

  // The person-raised origin. Read from DynamoDB and passed into the query as arrays rather than
  // replicated into Aurora — see the note on this function about why the thumbs store stays where
  // it is. Fails OPEN: an unset table or a scan error yields no person rows and the list still
  // renders the judge's and the moderator's, logged server-side.
  const personFlags = downVotesOnly(await scanLatestVotes(win));

  const result = await query(
    // Three origins raise a flag; one SELECT renders them, so a row looks the same however it was
    // raised and the reviewer's verdict applies to all three.
    `WITH person_flag AS (
       SELECT * FROM unnest($3::text[], $4::text[], $5::timestamptz[])
                     AS t(message_id, reason, flagged_at)
     ),
     raised AS (
       -- The judge. Still derived, still storing nothing: re-evaluating re-derives it.
       SELECT er.exchange_id,
              'judge'::text AS flag_source, NULL::text AS flag_reason, er.evaluated_at AS flagged_at
         FROM evaluation_results er
        WHERE er.evaluation_type = 'exchange'
          AND er.evaluated_at >= lower($1::tstzrange) AND er.evaluated_at < upper($1::tstzrange)
          AND (er.relevance_score < 50
               OR er.is_compliant = false
               OR COALESCE(cardinality(er.flags), 0) > 0)
       UNION ALL
       -- A moderator, from Oversight > Conversations. The exchange is resolved HERE rather than at
       -- write time: archival is asynchronous, so a flag raised on a fresh response would have
       -- pinned a NULL exchange and never appeared. Joining at read time means a late-arriving
       -- exchange row simply starts matching.
       --
       -- THROUGH "messages", BECAUSE THE TWO IDS ARE NOT THE SAME THING. A human flag records the
       -- CHIME MessageId (varchar) - the only id the transcript can hand a moderator - while
       -- "exchanges.agent_message_id" is a uuid foreign key to "messages.id", this database own
       -- key. Comparing them directly is not a missing cast, it is two different identifiers: it
       -- raised "operator does not exist: uuid = character varying" and 502d the whole tab.
       --
       -- The CREATE row is the one exchanges link to (see kinesis-archival), so an update row of the
       -- same message must not match here or one flag would raise the row more than once.
       SELECT e.id, 'moderator', hf.reason, hf.flagged_at
         FROM human_flag hf
         JOIN messages m ON m.message_id = hf.message_id
                        AND m.channel_arn = hf.channel_arn
                        AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
         JOIN exchanges e ON e.agent_message_id = m.id
        WHERE hf.flagged_at >= lower($1::tstzrange) AND hf.flagged_at < upper($1::tstzrange)
       UNION ALL
       -- An end user's 'Needs work'. Same read-time join, and the same two-step through "messages":
       -- the vote is stored against the Chime MessageId the client had. No channel narrows it here
       -- because the vote does not carry one, which is safe - a Chime MessageId is unique.
       SELECT e.id, 'person', pf.reason, pf.flagged_at
         FROM person_flag pf
         JOIN messages m ON m.message_id = pf.message_id
                        AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
         JOIN exchanges e ON e.agent_message_id = m.id
     ),
     -- ONE row per response, however many origins raised it. Three rows for the same answer would
     -- read as three bad answers; the fact worth surfacing is that all three agreed, which is what
     -- the aggregated source list says.
     raised_agg AS (
       SELECT exchange_id,
              array_agg(DISTINCT flag_source) AS flag_sources,
              array_remove(array_agg(DISTINCT flag_reason), NULL) AS flag_reasons,
              MIN(flagged_at) AS flagged_at
         FROM raised
        GROUP BY exchange_id
     )
     SELECT e.id AS exchange_id, e.channel_arn,
            -- Legacy exchanges (DIRECT/pre-attribution) archived with a null agent_type; fall back
            -- to the conversation's tier at query time so the 'assistant' column is not empty. New
            -- rows already carry it (kinesis-archival COALESCE). Intent is per-turn and cannot be
            -- backfilled this way, so it stays as stored.
            COALESCE(e.assistant, c.assistant) AS assistant, e.intent,
            -- LEFT now: a human can flag a response the judge never scored, and that row has no
            -- relevance score at all. NULL here means unscored, not zero.
            er.relevance_score, er.classification, er.reasoning,
            er.is_compliant, er.compliance_categories AS compliance, er.flags,
            ra.flagged_at,
            ra.flag_sources, ra.flag_reasons,
            -- No review row means nobody has looked at it yet. 'pending' is the absence of a
            -- verdict, which is why it is derived here rather than stored.
            COALESCE(fr.review_status, 'pending') AS review_status,
            fr.reviewer_sub AS reviewed_by,
            fr.note AS review_note,
            fr.reviewed_at,
            um.content AS user_message,
            COALESCE(am.updated_content, am.content) AS agent_response
       FROM raised_agg ra
       JOIN exchanges e ON e.id = ra.exchange_id
       LEFT JOIN evaluation_results er ON er.exchange_id = e.id AND er.evaluation_type = 'exchange'
       LEFT JOIN conversations c ON e.conversation_id = c.id
       LEFT JOIN messages um ON e.user_message_id = um.id
       LEFT JOIN messages am ON e.agent_message_id = am.id
       LEFT JOIN flagged_review fr ON fr.exchange_id = e.id
      -- A TEAM'S LIST: its assistant's turns in rooms its clearance reaches. Both are set server-side
      -- only (boundAssistant is no body key), and both are NULL for an admin.
      -- The exchange's own agent_type only: the conversation's single agent_type is not who answered
      -- this turn, so an exchange with none is attributable to nobody and stays with admins.
      WHERE ($6::text IS NULL OR e.assistant = $6)
        AND ($7::text[] IS NULL OR e.conversation_classification = ANY($7))
      -- Human-raised first. The old ordering was score-ascending with NULLS LAST, which would have
      -- buried every human flag under every machine one, since a human flag carries no score.
      ORDER BY ('moderator' = ANY(ra.flag_sources) OR 'person' = ANY(ra.flag_sources)) DESC,
               er.relevance_score ASC NULLS LAST
      LIMIT $2`,
    [
      win.range,
      limit,
      personFlags.map((f) => f.messageId),
      personFlags.map((f) => f.reason),
      personFlags.map((f) => f.createdAt),
      boundAssistantOf(params),
      boundClassificationsOf(params),
    ]
  );
  const data = result.rows.map((r: any) => ({
    ...r,
    user_message: stripMessageMarkers(r.user_message),
    agent_response: stripMessageMarkers(r.agent_response),
  }));
  return success({ data });
}

/**
 * PAIRWISE AGREEMENT: when a person preferred one reply to another, did the absolute scores agree?
 *
 * Every quality number on this platform is an ABSOLUTE score: a judge is shown one reply and asked
 * for 0-100. The consistent finding in the judging literature is that the same model comparing two
 * candidates is markedly more reliable than assigning a number to one, which is why the public
 * arenas are built on pairwise comparison. That is a claim about instruments, and until it is
 * measured HERE it is somebody else's finding rather than a fact about this deployment.
 *
 * NO NEW MODEL CALL, WHICH IS THE POINT. A duel already produces two replies to one request and a
 * person already picks between them, and both sides already carry a relevance score. So the
 * instrument can be checked against human preference using only what is stored: when the human
 * preferred side A, did A also score higher?
 *
 * Generating a second candidate for ordinary traffic would have been the other way to get pairwise
 * data, and it costs a model call per sampled exchange plus a change to the turn path. This reuses a
 * surface that exists (tenet D8) and spends nothing.
 *
 * WHAT A LOW RATE MEANS, and it is not "the humans are wrong": it means the absolute scores are a
 * poor proxy for what people actually prefer, and the dashboard's relevance column should be read
 * more cautiously. That is the finding this exists to make available.
 *
 * TIES ARE EXCLUDED. A tie is a real adjudication - both replies acceptable - but it expresses no
 * preference, so there is nothing for the scores to agree or disagree WITH. Counting it either way
 * would move the rate without evidence.
 */
async function getPairwiseAgreement(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30);

  // The human picks. DynamoDB, folded in memory rather than replicated into Aurora - the same
  // posture thumbs take, and for the same reason (tenet D7: one source per question).
  const picks = (await scanBattleOutcomeItems(undefined)).filter((pk) => {
    if (!pk.battleId || !pk.winner || pk.winner === 'tie') return false;
    const t = Date.parse(pk.chosenAt || '');
    return Number.isFinite(t) && t >= win.startMs && t < win.endMs;
  });

  if (!picks.length) {
    // NOT ZERO. Nobody having picked is not the scores disagreeing with nobody.
    return success({ data: [], agreementRate: null, comparedCount: 0, pickCount: 0 });
  }

  // Both sides of each duel, with the relevance each was given. One row per (battle, variant).
  const scored = await query(
    `SELECT e.battle_id,
            e.variant_id,
            ROUND(AVG(er.relevance_score)::numeric, 1) AS relevance
       FROM exchanges e
       JOIN evaluation_results er ON er.exchange_id = e.id AND er.evaluation_type = 'exchange'
      WHERE e.battle_id = ANY($1::text[])
        AND e.variant_id IS NOT NULL
        AND er.relevance_score IS NOT NULL
      GROUP BY e.battle_id, e.variant_id`,
    [picks.map((pk) => pk.battleId)],
  );

  // battle -> variant -> score
  const byBattle = new Map<string, Map<string, number>>();
  for (const r of scored.rows as Array<Record<string, unknown>>) {
    const b = String(r.battle_id);
    if (!byBattle.has(b)) byBattle.set(b, new Map());
    byBattle.get(b)!.set(String(r.variant_id), Number(r.relevance));
  }

  let compared = 0;
  let agreed = 0;
  for (const pk of picks) {
    const sides = byBattle.get(String(pk.battleId));
    // BOTH sides must be scored. One scored side cannot be compared to an unscored one, and
    // treating the missing side as zero would make the scored side win every time.
    if (!sides || sides.size < 2 || !pk.variantId) continue;
    const winnerScore = sides.get(pk.variantId);
    if (winnerScore === undefined) continue;
    const otherScores = [...sides.entries()].filter(([v]) => v !== pk.variantId).map(([, n]) => n);
    if (!otherScores.length) continue;
    compared += 1;
    // An EXACT TIE in the scores is not agreement: the instrument expressed no preference where the
    // person did, which is precisely the failure this measures.
    if (winnerScore > Math.max(...otherScores)) agreed += 1;
  }

  return success({
    data: [],
    agreementRate: compared > 0 ? Math.round((agreed / compared) * 1000) / 10 : null,
    comparedCount: compared,
    agreedCount: agreed,
    // How many picks existed at all, so the gap between this and comparedCount says how much of the
    // human signal the scores could not be checked against.
    pickCount: picks.length,
    columns: [],
  });
}

/**
 * ROUTING AGREEMENT: how often the live classifier picked the intent a person says was right.
 *
 * Intent selection is a classification problem, and the standard for one is a labeled set scored
 * against the prediction. This platform had the labels and never asked the question: the console
 * showed the classifier's own CONFIDENCE, which is the model grading itself, and nothing measured
 * whether it was correct.
 *
 * NOT SCHEDULED, DELIBERATELY, and this is a departure from how the gap was first written up. The
 * comparison is a join between two facts already stored - the human's `true_label` and the intent
 * the turn recorded - so it needs no model call and nothing to batch. Tenet D6: a timer that
 * recomputes what a query derives is duplicated logic with added latency and a second way to be
 * wrong. It is computed on read, so it is never stale.
 *
 * NULL UNTIL SOMEBODY LABELS. Labels come from adjudicating a classifier replay, and a deployment
 * that has run none has no labeled set. The rate is then null and the count is zero, which is the
 * honest answer and the same posture compliance agreement takes. A reader must not read "no
 * disagreement found" from "nothing was compared".
 *
 * ADJUDICATED ROWS ONLY. A replay row with no `true_label` has been produced but not judged, and
 * counting it as agreement would score the classifier against a prediction rather than against a
 * person.
 */
async function getRoutingAgreement(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30);
  const result = await query(
    `SELECT
        -- The population, stated rather than implied. A rate over eleven labels is not a measurement
        -- of a classifier, and the reader needs the denominator to know which they are looking at.
        COUNT(*) AS labeled_count,
        COUNT(*) FILTER (WHERE l.true_label = e.intent) AS agreed_count,
        ROUND((COUNT(*) FILTER (WHERE l.true_label = e.intent) * 100.0
               / NULLIF(COUNT(*), 0))::numeric, 1) AS agreement_rate
       FROM classifier_replay_labels l
       JOIN exchanges e ON e.id = l.exchange_id
      WHERE l.true_label IS NOT NULL
        AND l.adjudicated_at >= lower($1::tstzrange) AND l.adjudicated_at < upper($1::tstzrange)`,
    [win.range],
  );

  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const labeled = Number(row.labeled_count ?? 0);

  // Per-intent, so a low overall rate can be attributed rather than just observed. Only worth
  // running when there is something to break down.
  const byIntent = labeled > 0
    ? (await query(
        `SELECT COALESCE(l.true_label, 'unknown') AS true_intent,
                COUNT(*) AS labeled_count,
                COUNT(*) FILTER (WHERE l.true_label = e.intent) AS agreed_count,
                -- What it was MISTAKEN FOR, most often. A confusion pair is the actionable half of a
                -- low rate: it names the boundary to fix rather than reporting that one exists.
                MODE() WITHIN GROUP (ORDER BY e.intent) FILTER (WHERE l.true_label <> e.intent)
                  AS most_confused_with
           FROM classifier_replay_labels l
           JOIN exchanges e ON e.id = l.exchange_id
          WHERE l.true_label IS NOT NULL
            AND l.adjudicated_at >= lower($1::tstzrange) AND l.adjudicated_at < upper($1::tstzrange)
          GROUP BY l.true_label
          ORDER BY COUNT(*) DESC`,
        [win.range],
      )).rows
    : [];

  return success({
    data: byIntent,
    // NULL, not zero, when nothing is labeled: "no disagreement found" and "nothing was compared"
    // are different statements and the surface has to be able to tell them apart.
    agreementRate: labeled > 0 ? Number(row.agreement_rate) : null,
    labeledCount: labeled,
    agreedCount: Number(row.agreed_count ?? 0),
    columns: ['true_intent', 'labeled_count', 'agreed_count', 'most_confused_with'],
  });
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
    // THE AUTHOR OF A HUMAN LABEL IS THE VERIFIED CALLER, NEVER THE BODY.
    //
    // A label naming its own author makes the only human signal in the system unauditable, and makes
    // any inter-annotator agreement fabricable by one person submitting under two names - which is
    // the figure a judge would otherwise be certified against. `callerSub` is threaded in by
    // handlePostQuery from the JWT sub or the IAM caller identity, and `buildParamsFromBody` omits it
    // from the allowlist, so it cannot be supplied by the caller.
    //
    // Refuses rather than attributing to nobody, the same way the flag write and
    // `classifier_replay_adjudicate` do: a label with no author is worse than no label, because it
    // succeeds and then counts.
    if (!params.callerSub) {
      return success({ submitted: false, error: 'Unable to attribute the label to a caller' });
    }
    // THE COMPLIANCE AND GROUNDEDNESS HALVES ARE OPTIONAL AND THREE-STATE. Absent is "this label does
    // not say", stored NULL, never read as a pass. A breach names rule ids the rule set declares; an id
    // it does not declare is refused rather than stored, or the per-rule agreement would split on typos.
    const triState = (v: string | undefined): boolean | null => (v === 'true' ? true : v === 'false' ? false : null);
    const isCompliant = triState(params.isCompliant);
    const isGrounded = triState(params.isGrounded);
    const categories = (params.complianceCategories || '').split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = categories.filter((id) => !DEFAULT_COMPLIANCE_RULES.some((r) => r.id === id));
    if (unknown.length) {
      return success({ submitted: false, error: `Unknown compliance rule: ${unknown.join(', ')}` });
    }
    if (isCompliant === true && categories.length) {
      return success({ submitted: false, error: 'A compliant label names no breached rule' });
    }
    await query(
      `INSERT INTO ground_truth_scores
         (exchange_id, human_score, classification, reasoning, scorer_id,
          human_is_compliant, human_compliance_categories, human_is_grounded)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [exchangeId, Math.max(0, Math.min(100, score)), params.classification || null, params.reasoning || null, params.callerSub,
       isCompliant, isCompliant === null ? null : JSON.stringify(categories), isGrounded]
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
       -- ONE ROW PER EXCHANGE, MOST RECENT SCORING WINS.
       --
       -- A re-scored exchange has SEVERAL evaluation_results rows, so joining them raw multiplied
       -- every COUNT taken over this join and inflated the totals - and the two panels most likely
       -- to be re-scored are the ones an operator re-scores BECAUSE they looked wrong.
       --
       -- The latest evaluation rather than an average, because classification and compliance are
       -- CATEGORICAL: a relevance score can be averaged and a verdict cannot, and the latest is what
       -- a person reading a re-scored exchange means by "its" score. evaluated_at DESC is indexed
       -- (idx_evaluation_date), and the evaluation_type filter is the one line 467 already carried.
       LEFT JOIN (
         SELECT DISTINCT ON (exchange_id)
                exchange_id, id, relevance_score, classification, reasoning, is_compliant, flags
           FROM evaluation_results
          WHERE evaluation_type = 'exchange'
          ORDER BY exchange_id, evaluated_at DESC
       ) er ON er.exchange_id = e.id
       LEFT JOIN messages um ON e.user_message_id = um.id
       LEFT JOIN messages am ON e.agent_message_id = am.id
      WHERE ($2::text IS NULL OR e.assistant = $2)
        AND ($3::text[] IS NULL OR e.conversation_classification = ANY($3))
      ORDER BY gt.scored_at DESC
      LIMIT $1`,
    [limit, boundAssistantOf(params), boundClassificationsOf(params)]
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
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT DATE(created_at) AS date,
            COALESCE(intent, 'unknown') AS type,
            COUNT(DISTINCT task_id) AS total,
            -- A TASK THAT ENDED IN ITS MACHINE'S SUCCESS STATE IS COMPLETED (successTerminalStates), as the experiment
            -- rollup counts it: an image task that ended in done is a completion, not an unfinished task.
            COUNT(DISTINCT task_id) FILTER (WHERE ${taskCompletedSql('', 2)}) AS completed,
            COUNT(DISTINCT task_id) FILTER (WHERE task_status = 'failed') AS failed
       FROM exchanges
      WHERE task_id IS NOT NULL
        AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
      GROUP BY DATE(created_at), COALESCE(intent, 'unknown')
      ORDER BY date DESC`,
    [win.range, successTerminalStates()]
  );
  return success({ data: result.rows });
}

/** Quality > Tasks (per-task detail). */
async function getTaskDetails(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  // Optional intent filter — this is also the Effectiveness L2 task list (drill from an intent to its
  // tasks). `$3 IS NULL` keeps the unfiltered Quality>Tasks behavior; set it for the L2 drill.
  const intent = params.intent || null;
  const agentType = params.agentType || null; // Effectiveness "one assistant" scope (the responder).
  // total = number of DISTINCT tasks matching (COUNT(*) OVER() runs over the grouped result set), so the
  // console can page server-side. LIMIT/OFFSET apply after grouping (the page is a page of tasks).
  const result = await query(
    `SELECT task_id,
            -- One task lives in one channel, so MAX picks that channel_arn for the "view conversation"
            -- deep-link (the Effectiveness drill jumps from a task to its raw conversation log).
            MAX(channel_arn) AS channel_arn,
            -- THE INTENT THAT OPENED THE TASK, not the alphabetically greatest one its turns carried.
            -- A task's later turns classify on their own text, so a data_extraction task holding one
            -- general turn reported general under MAX ('g' > 'd'). The opening turn is the one that
            -- decided the task type, so it is the one that names the flow.
            COALESCE((ARRAY_AGG(task_type ORDER BY created_at ASC) FILTER (WHERE task_type IS NOT NULL))[1],
                     (ARRAY_AGG(intent ORDER BY created_at ASC))[1], 'unknown') AS type,
            -- THE LATEST lifecycle status, for the same reason the state below takes the latest.
            -- Alphabetical MAX is as meaningless here as it is for a state, and worse in effect: of
            -- pending, in_progress, completed, failed, cancelled, abandoned,
            -- in_progress sorts above every terminal value, so any task that was ever in progress
            -- reported in_progress for ever. Every multi-turn task is one, which made the column read
            -- "was this ever started" while being labelled a lifecycle.
            (ARRAY_AGG(task_status ORDER BY created_at DESC))[1] AS status,
            -- Machine state as of the latest turn (SPEC-TASK-STATE-TRANSITIONS §6). Distinct from
            -- status (the lifecycle): the declared-graph state the task reached.
            (ARRAY_AGG(task_state ORDER BY created_at DESC))[1] AS task_state,
            MIN(created_at) AS started_at,
            MAX(created_at) AS last_at,
            COUNT(*) AS exchange_count,
            -- How many turns actually advanced the machine (a transition was recorded).
            COUNT(task_transition) AS transition_count,
            COUNT(*) OVER() AS total_count
       FROM exchanges
      WHERE task_id IS NOT NULL
        AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
        -- The tasks the L1 row counts: a task turn under its task's type (ADR-064 decision I).
        AND ($3::varchar IS NULL OR COALESCE(task_type, intent) = $3)
        AND ($4::varchar IS NULL OR assistant = $4)
      GROUP BY task_id
      ORDER BY MAX(created_at) DESC
      LIMIT $2 OFFSET $5`,
    [win.range, limit, intent, agentType, offset]
  );
  const total = result.rows[0]?.total_count != null ? Number(result.rows[0].total_count) : result.rows.length;
  return success({ data: result.rows, total, limit, offset });
}

/**
 * Effectiveness L3 (SPEC-ADMIN-CONSOLE-EFFECTIVENESS, User Experience Description and Mocks): the
 * turn-by-turn machine-state timeline for
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
            -- What chose the turn's model (ADR-064 decision 4): the step it started in, the kind and the rule.
            e.task_type,
            e.task_step,
            e.model_kind,
            e.model_from,
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
  // RECURRING SUBJECTS NO INTENT SERVES, as candidates for new intents. See `getUnservedSubjects`.
  unserved_subjects: { fn: getUnservedSubjects, dataKey: 'data' },
  evaluation_scores: { fn: getEvaluationMetrics, dataKey: 'dailyBreakdown' },
  evaluation_exchanges: { fn: getExchanges, dataKey: 'exchanges' },
  execution_steps: { fn: getExecutionSteps, dataKey: 'data' },
  evaluation_flows: { fn: getFlows, dataKey: 'flows' },
  // Superset parity (#33/#35): served natively so Aurora never says "unsupported".
  flagged_responses: { fn: getFlaggedResponses, dataKey: 'data' },
  ground_truth: { fn: getGroundTruth, dataKey: 'data' },
  routing_agreement: { fn: getRoutingAgreement, dataKey: 'data' },
  pairwise_agreement: { fn: getPairwiseAgreement, dataKey: 'data' },
  task_metrics: { fn: getTaskMetrics, dataKey: 'data' },
  task_details: { fn: getTaskDetails, dataKey: 'data' },
  task_timeline: { fn: getTaskTimeline, dataKey: 'data' },
  intent_effectiveness: { fn: getIntentEffectiveness, dataKey: 'data' },
  channel_events: { fn: getChannelEvents, dataKey: 'events' },
  intent_exchanges: { fn: getIntentExchanges, dataKey: 'data' },
  // An intent's turns by the step they started in and by the model that served them (ADR-064). See `getIntentSteps`.
  intent_steps: { fn: getIntentSteps, dataKey: 'data' },
  // A delivered document's own scores, by intent and task type or per conversation (FR22). See
  // `getDocumentEvaluation`.
  document_evaluation: { fn: getDocumentEvaluation, dataKey: 'data' },
  latency_exchanges: { fn: getLatencyExchanges, dataKey: 'data' },
  user_ratings: { fn: getUserRatings, dataKey: 'data' },
  cross_conversation_context: { fn: getConversationContext, dataKey: 'contexts' },
  latency_metrics: { fn: getLatencyMetrics, dataKey: 'data' },
  // WHAT THE EXCHANGE COUNT IS COUNTING THAT IS NOT AN EXCHANGE. See `getUnpairedBotMessages`.
  unpaired_bot_messages: { fn: getUnpairedBotMessages, dataKey: 'data' },
  // THE TURNS THAT ARE NOT ANSWERS, COUNTED AS THEMSELVES. See `getTurnKinds`.
  turn_kinds: { fn: getTurnKinds, dataKey: 'data' },
  // ONE ASSISTANT HANDING A PERSON'S MESSAGE TO ANOTHER: sent, answered, and the gap. See `getHandovers`.
  handovers: { fn: getHandovers, dataKey: 'data' },
  // The same window split by WHAT KIND of interaction each turn was, so a person's wait, a rebuttal
  // and a repaired turn stop being averaged into one number that describes none of them.
  latency_by_interaction: { fn: getLatencyByInteraction, dataKey: 'data' },
  // The same turn measured from BOTH ends, joined by the correlation marker - the only identifier the
  // browser and the server both hold. The gap between them is delivery + render (G5).
  client_server_latency: { fn: getClientServerLatency, dataKey: 'data' },
  // THE AUDIT OF ONE TURN, from the ledger. `latency_metrics` aggregates; this shows the
  // calculation for a single channel so a human can check it against the stream, which is the whole
  // point of the ledger existing. Unlisted queryTypes default to the `view-analytics` capability.
  turn_latency_audit: { fn: getTurnLatencyAudit, dataKey: 'data' },
  // THE SHADOW DIFF of the one auditable latency record: the derived path and the ledger compared per
  // turn over the window, so the repoint of the tab's read onto the ledger is a watched change. Reads
  // nothing new into any figure on the tab.
  turn_latency_shadow_diff: { fn: getTurnLatencyShadowDiff, dataKey: 'data' },
  router_steps: { fn: getRouterSteps, dataKey: 'data' },
  // Task resolution, measured SEPARATELY from turn latency and deliberately never mixed into it: a
  // four-hour task with twenty seconds of assistant time is healthy, and only a different denominator
  // can say so.
  task_resolution: { fn: getTaskResolution, dataKey: 'data' },
  // HOW EACH WORKFLOW'S TASKS GOT WHERE THEY ARE, from the trajectory a task turn stamps. See `getWorkflowTrajectory`.
  workflow_trajectory: { fn: getWorkflowTrajectory, dataKey: 'data' },
  // Refusals, guardrail findings and rule breaches as counts with their populations. See `getSafetyReadings`.
  safety_readings: { fn: getSafetyReadings, dataKey: 'data' },
  // Whether a person had to work to be understood, per person per conversation. See `getFrustration`.
  frustration: { fn: getFrustration, dataKey: 'data' },
  // Which context sources retrieval brings back and whether answers use them. See `getRetrievalSources`.
  retrieval_sources: { fn: getRetrievalSources, dataKey: 'data' },
  // How far each judge agrees with people, per rubric and instance. See `getJudgeCalibration`.
  judge_calibration: { fn: getJudgeCalibration, dataKey: 'data' },
  // What each tool's calls came to and who fixes it. See `getToolOutcomes`.
  tool_outcomes: { fn: getToolOutcomes, dataKey: 'data' },
  // How each document template's deliveries went. See `getTemplateOutcomes`.
  template_outcomes: { fn: getTemplateOutcomes, dataKey: 'data' },
  // Answers waiting for a person's label, most useful first. See `getLabelQueue`.
  label_queue: { fn: getLabelQueue, dataKey: 'data' },
  // The golden set per classification, and its nominate / retire / promote writes. See `getGoldenSet`.
  golden_set: { fn: getGoldenSet, dataKey: 'data' },
  // The Performance overview's flow: path, intent and outcome, the turns behind a node, and one turn.
  message_flow: { fn: getMessageFlow, dataKey: 'data' },
  flow_turns: { fn: getFlowTurns, dataKey: 'data' },
  welcome_flow: { fn: getWelcomeFlow, dataKey: 'data' },
  flow_turn: { fn: getFlowTurn, dataKey: 'data' },
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
  // FULL RESULTS, ONE ROW PER DUEL. Separate from `experiment_results` rather than another field on
  // it: that response is the Experiments tab's per-variant rollup, and a per-duel list is paged, so
  // folding it in would make every experiment page load a page of battles nobody asked for.
  battle_results: { fn: getBattleResults, dataKey: 'data' },
  // Classification shadow gate (DESIGN §5). The measurement a `classification` experiment needs, so
  // the decision rests on labeling rather than on the evaluator's opinion of the answer downstream.
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
  guest_to_customer_funnel: { fn: getGuestToCustomerFunnel, dataKey: 'data' },
  guest_refusals: { fn: getGuestRefusals, dataKey: 'data' },
  page_load_metrics: { fn: getPageLoadMetrics, dataKey: 'data' },
  connection_health_daily: { fn: getConnectionHealthDaily, dataKey: 'data' },
};

const DAY_MS = 86_400_000;

/**
 * WHAT AN ASSISTANT TURN IS, stated once for every query that counts them. Over a bot CREATE row `m`
 * and its (possibly absent) exchange `e`: it answered a user message, it ran a model, or it carries
 * the correlation marker a turn claims its placeholder with. `latency_metrics` and
 * `unpaired_bot_messages` both interpolate this, so their unpaired figures cannot come from two
 * definitions of the population. The reasoning behind each arm is beside the `latency_metrics` WHERE.
 */
const ASSISTANT_TURN_SQL = `(e.id IS NOT NULL OR m.total_ms IS NOT NULL OR m.content LIKE '%<!--corr:%')`;

/**
 * A QUEUE NOTICE CLOSED OUT AS A RECEIPT, read from what the archive kept. FOR ROWS ARCHIVED BEFORE
 * MIGRATION 084.
 *
 * Every update of a message is its own row now, and the latest one (`updateJoinSql`, pick `latest`) of a
 * notice closed out as a receipt declares `receipt` itself, so `turnKindSql` names it from the
 * declaration and never reaches this test. Before 084 the archive kept one fixed `<id>-UPD` row per
 * message, the FIRST update, so on a placeholder that became the queue notice it carries the notice's
 * `queue_ack` and the receipt's own declaration was dropped. Only the fold onto the CREATE row kept
 * anything of it: `agent_final_at` and `answers_message_id`. Read alone, that looks like the answer
 * written into the notice. This keeps those rows named `receipt` on the console, identically, until
 * they are rebuilt from the S3 archive.
 *
 * The receipt is told apart by its answer: a DIFFERENT message declares the same answered message. An
 * answer written into the notice has no such sibling, because it is the answer. Every row of the same
 * message, its CREATE and each of its updates, shares its `base_message_id` and is excluded.
 */
const noticeClosedAsReceiptSql = (m: string): string => `(${m}.answers_message_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM messages moved
            WHERE moved.channel_arn = ${m}.channel_arn
              AND moved.answers_message_id = ${m}.answers_message_id
              AND moved.message_id <> ${m}.message_id
              AND COALESCE(moved.base_message_id, moved.message_id) <> ${m}.message_id))`;

/**
 * WHAT KIND OF TURN A ROW IS, NAMED FROM WHAT THE TURN DECLARED. Every turn carries a real name in the
 * analytics, never "unknown": every assistant turn spends tokens and time, so every one is named and
 * measured, including the turns no person's message anchors.
 *
 * NULL means an ordinary turn a person's message started, whose name is its delivery option. Every
 * other value is read off a fact a producer already wrote, in this order:
 *
 *   receipt         a declared receipt, first. It is the placeholder of a turn whose answer moved to a
 *                   message of its own, and the answer is the turn. A resumed duel side's placeholder
 *                   carries the round marker and is closed out as a receipt; named by its round it read
 *                   as the side's answer, and the turn was counted twice.
 *   battle_round_N  the round the placeholder's own battle marker carries (migration 057), because a
 *                   duel side is a duel side whatever else it declared.
 *   the turn kind   the declared kind (reading, welcome, join_recap, event_step, drift, notification, notice,
 *                   battle-notice, receipt, queue_ack), from the column first and the Metadata second,
 *                   the LATEST update and then the CREATE, exactly as getTurnKinds reads it. Archival does
 *                   not fold turn_kind onto the CREATE row, so the update is where a processor turn's
 *                   kind usually is, and the latest update is what the message declared last. A
 *                   placeholder whose answer moved to a message of its own declares receipt, and one
 *                   the queue notice was written into declares queue_ack (turn-declaration.ts).
 *   receipt         a declared queue_ack whose message reached a final while ANOTHER message declares
 *                   the same answer (noticeClosedAsReceiptSql): the answer moved to a message of its
 *                   own and this notice was closed out as its receipt.
 *   (no kind)       any other declared queue_ack whose message reached a final answer: a notice never
 *                   declares itself final, so that is the answer written into the notice when it could
 *                   not be posted at the end, and it is named as the answer it is.
 *   queue_ack       a deferral notice that declared no kind: respPhase notice on the CREATE's own
 *                   Metadata, for rows written before every notice declared queue_ack.
 *   handover        the aeHandover marker (handoverSql).
 *   the trigger     the declared interaction kind (interaction-kinds.ts) other than user: rebuttal,
 *                   handover, repair, recovery, join_recap. The ledger's copy first, then Metadata.
 *                   The retired dispatcher name orchestrator reads as rebuttal (normaliseLegacyTrigger).
 *
 * Aliases are parameters so the Latency tab's aggregate and its drill state one rule. `vl` must be a
 * v_turn_latency row joined on the CREATE's (message_id, channel_arn).
 */
function turnKindSql(a: { m: string; upd: string; vl: string }): string {
  const { m, upd, vl } = a;
  const round = `COALESCE(${m}.battle_round, ${vl}.battle_round)`;
  const declaredKind = `COALESCE(${upd}.turn_kind, ${m}.turn_kind, ${upd}.metadata->>'turnKind', ${m}.metadata->>'turnKind')`;
  const trigger = `COALESCE(${vl}.trigger_kind, ${upd}.metadata->>'trigger', ${m}.metadata->>'trigger')`;
  return `CASE
         WHEN ${declaredKind} = 'receipt' THEN 'receipt'
         WHEN ${round} IS NOT NULL THEN 'battle_round_' || ${round}::text
         WHEN ${declaredKind} = 'queue_ack' AND ${m}.agent_final_at IS NOT NULL AND ${noticeClosedAsReceiptSql(m)} THEN 'receipt'
         WHEN ${declaredKind} = 'queue_ack' AND ${m}.agent_final_at IS NOT NULL THEN NULL
         WHEN ${declaredKind} IS NOT NULL THEN ${declaredKind}
         WHEN ${m}.metadata->>'respPhase' = 'notice' THEN 'queue_ack'
         WHEN ${handoverSql(m)} THEN 'handover'
         WHEN ${trigger} = 'orchestrator' THEN 'rebuttal'
         WHEN ${trigger} <> 'user' THEN ${trigger}
       END`;
}

/**
 * THE KINDS A PERSON'S MESSAGE STARTED, so their own span is the person's wait (v_turn_latency.e2e_ms).
 * A round-1 duel side answers the person's battle prompt, and a handover, a repair and a recovery all
 * start from a message somebody sent and is still waiting on (`isHumanWaiting` in interaction-kinds.ts).
 * A receipt is NOT one of them: it is the placeholder of a turn whose answer moved to a message of its
 * own, and that answer carries the person's wait (turn_ms_source 'carried_by_answer').
 */
const PERSON_STARTED_KINDS_SQL = `('battle_round_1', 'handover', 'repair', 'recovery')`;

/**
 * THE LABEL A LATENCY ROW IS GROUPED UNDER: the delivery option where the turn has one, else the turn's
 * kind, never NULL and never 'unknown'.
 *
 * Upper case is a delivery option (delivery-options.ts), lower case is a turn kind (turnKindSql), so
 * the two vocabularies cannot collide. The exchange's delivery option first, because that is the
 * pairing the row is measured against; then the kind, so an unpaired reading is a reading rather than
 * whatever intent the processor stamped on it; then the message's own declaration, CREATE and latest
 * update, which is how an answer whose pairing failed still says how it was delivered.
 *
 * undeclared_turn IS A NAMED DATA DEFECT, NOT A BUCKET. A turn reaches it only when it declared no
 * delivery option, no kind, no round and no trigger, on every carrier. Every producer that runs a turn
 * declares at least one of those, so a row here is a producer that stopped declaring or a row older
 * than the declaration, and analytics-accuracy.spec.ts fails on it.
 */
function turnLabelSql(a: { e: string; m: string; upd: string; vl: string }): string {
  return `COALESCE(${a.e}.delivery_option, ${turnKindSql(a)}, ${a.m}.delivery_option, ${a.upd}.delivery_option, 'undeclared_turn')`;
}


/**
 * WHAT A HANDOVER IS, stated once for every query that counts messages (DESIGN-SEPARATE-ASSISTANTS-AND-
 * DELEGATION §3.4). One assistant hands a person's message to another by posting a message targeted at
 * it, marked `aeHandover` in its Metadata, which archival keeps in `messages.metadata`. It is a stored
 * assistant message, so it counts in message totals and is its own kind in Turn kinds (`handover`); it
 * is never an ANSWER, so it never pairs as one. Read from the MARKER, not inferred from `targeted_to`, so a
 * future assistant-to-assistant message of another kind is not miscounted as one.
 */
const handoverSql = (alias: string): string =>
  `(${alias}.is_bot = true AND COALESCE(${alias}.metadata, '{}'::jsonb) ? 'aeHandover')`;

/**
 * THE LATENCY TAB'S POPULATION, STATED ONCE FOR THE BREAKDOWN AND ITS DRILL.
 *
 * The breakdown (getLatencyMetrics) counts assistant turns: a bot CREATE that paired, ran a model or
 * carries a correlation marker, left-joined to its own exchange. Most kind-labeled turns (a reading, a
 * rebuttal, a queue acknowledgment, an undeclared_turn) have no exchange at all, so a drill that read
 * FROM exchanges returned nothing, or only the paired fraction, for those rows. The drill now reads
 * these same joins, this same WHERE and these same dimension expressions, so a drill's row count is the
 * breakdown's assistant_turn_count for the row that was clicked.
 *
 * The joins: the turn's own exchange (one row or none), its conversation, its ledger row, its latest
 * update row, and the label lateral (lbl). Callers alias messages as m.
 */
const LATENCY_TURN_JOINS_SQL = `
     -- LATERAL + LIMIT 1. exchanges is unique on the (user, agent) PAIR (migration 017), so one agent
     -- message can sit in more than one exchange row and a plain join emits this bot message once per
     -- row, which double-counts every COUNT(*) FILTER. THE WHOLE ROW, not a chosen column: the query
     -- reads e.id, e.e2e_ms, e.inbound_ms, e.paired_by and e.delivery_option.
     LEFT JOIN LATERAL (
       SELECT ex.*
         FROM exchanges ex
        WHERE ex.agent_message_id = m.id
        -- A QUEUED EXCHANGE IS NOT THIS TURN'S PAIRING (052), the same rule v_turn_latency's anchor
        -- lateral states. A folded answer carries one exchange per queued message it rolled in, all on
        -- this agent message; the turn's own exchange is minted against the acknowledgment it closes
        -- out and carries no label. Without this the ORDER BY below hands the earliest QUEUED row to
        -- every column read off e.
        AND ex.queued_as IS NULL
        -- ORDERED, so the one row is the SAME row every run.
        ORDER BY ex.created_at
        LIMIT 1
     ) e ON true
     LEFT JOIN conversations c ON e.conversation_id = c.id
     -- THE LEDGER: one row per response (the view groups on response_id, channel_arn), so a plain LEFT
     -- JOIN cannot fan out. NO SECOND WINDOW PREDICATE: the window is carried by the messages side and
     -- the join key is exact.
     LEFT JOIN v_turn_latency vl ON vl.response_id = m.message_id AND vl.channel_arn = m.channel_arn
     -- THE ANSWER'S LATEST UPDATE ROW, for what the turn declared on its update: turn_kind and
     -- delivery_option are not folded onto the CREATE row. Every update is its own row (migration 084),
     -- and the latest is what the message is now: a notice closed out as a receipt reads as the receipt.
     -- LIMIT 1, so one row or none.
     ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
     -- WHAT KIND OF TURN, AND THE LABEL IT IS GROUPED UNDER, STATED ONCE (turnKindSql, turnLabelSql).
     LEFT JOIN LATERAL (
       SELECT ${turnKindSql({ m: 'm', upd: 'upd', vl: 'vl' })} AS kind,
              ${turnLabelSql({ e: 'e', m: 'm', upd: 'upd', vl: 'vl' })} AS delivery_option
     ) lbl ON TRUE`;

/**
 * WHICH ROWS ARE ASSISTANT TURNS IN THE WINDOW ($1): the canonical CREATE (never one of its update rows,
 * which would count every turn more than once), of an assistant turn (ASSISTANT_TURN_SQL).
 */
const LATENCY_TURN_POPULATION_SQL =
  `m.is_bot = true
       AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
       AND ${ASSISTANT_TURN_SQL}
       AND m.created_at >= lower($1::tstzrange) AND m.created_at < upper($1::tstzrange)`;

/**
 * THE BREAKDOWN'S GROUPING EXPRESSIONS, which the drill filters on verbatim. A display 'unknown' or
 * 'none' is inside the expression, so a drill on that value matches the rows the breakdown put there.
 */
/**
 * WHICH DEFINITION SERVED A TURN, over `exchanges e` joined to its answering `messages m`: the exchange's
 * column, else the message's, else the metadata key a row written before migrations 056 and 091 (or by the
 * manual profile backfill) holds. Archival writes the columns from the turn's analytics record and folds
 * them onto the CREATE row an exchange joins to; that row's metadata is the placeholder's and carries none of the three.
 */
const SERVED_PROFILE_SQL = {
  name: `COALESCE(e.profile_name, m.profile_name, m.metadata->>'profileName')`,
  configId: `COALESCE(e.profile_config_id, m.profile_config_id, m.metadata->>'profileConfigId')`,
  version: `COALESCE(e.profile_version, m.profile_version, NULLIF(m.metadata->>'profileVersion', '')::int)`,
};

const LATENCY_DIM = {
  day: `DATE(m.created_at)`,
  assistant: `COALESCE(e.assistant, c.assistant, m.assistant, 'unknown')`,
  label: `lbl.delivery_option`,
  entry: `COALESCE(m.turn_entry, 'unknown')`,
  role: `COALESCE(e.assistant_role, m.assistant_role, 'unknown')`,
  version: `COALESCE(e.profile_version, m.profile_version)`,
  round: `COALESCE(m.battle_round::text, 'none')`,
  classification: `COALESCE(e.conversation_classification, c.conversation_classification, m.conversation_classification, 'unknown')`,
} as const;

/**
 * The window a query runs over: BOTH bounds, as one half-open `tstzrange` parameter.
 *
 * A NAMED WINDOW HAS AN END, AND EVERY PREDICATE READS IT. Every window predicate in this file is
 * written `col >= lower($n::tstzrange) AND col < upper($n::tstzrange)`. Reducing a range to a day
 * count and filtering `>= NOW() - N days` served a past window as the trailing one - "August" came back
 * as the last 31 days - while Athena mode, reading the same request, served August.
 *
 * ONE PARAMETER, NOT TWO, so the change is one uniform edit: each query keeps its placeholder numbering
 * and the window takes the position the day count held. The bounds are pulled out with lower() and
 * upper() rather than tested with `col <@ $n`, because a range-containment operator cannot use the btree
 * indexes on the timestamp columns and the two comparisons can.
 *
 * THE SAME DAYS ATHENA READS. Athena filters its date partitions with `BETWEEN start AND end`, which
 * includes the whole of both days, in UTC. So a named range here is [start 00:00Z, the day after end
 * 00:00Z): both modes answer one request with the same calendar days.
 *
 * NO NAMED RANGE (a GET with `days`, or a POST with no `dateRange`) is the trailing window it always
 * was, closed above by `infinity` rather than by an unbounded range - `upper()` of an unbounded range
 * is NULL, and `col < NULL` would exclude every row.
 *
 * `maxDays` keeps each query's existing span cap: a wider window keeps its end and loses its oldest days.
 */
interface QueryWindow {
  /** The `tstzrange` literal bound to the query, half-open: `[start,end)`. */
  range: string;
  startMs: number;
  /** Exclusive. `Infinity` for a trailing window. */
  endMs: number;
  /** Whole days spanned, for responses that report the span. */
  days: number;
  /** Stable for the same window, so a cached response is never served for a different one. */
  key: string;
}

function queryWindow(
  params: Record<string, string | undefined>,
  defaultDays: number,
  maxDays?: number,
): QueryWindow {
  const namedStart = params.windowStart ? Date.parse(params.windowStart) : NaN;
  const namedEnd = params.windowEnd ? Date.parse(params.windowEnd) : NaN;
  if (Number.isFinite(namedStart) && Number.isFinite(namedEnd)) {
    let startMs = namedStart;
    if (maxDays !== undefined && namedEnd - startMs > maxDays * DAY_MS) startMs = namedEnd - maxDays * DAY_MS;
    const lo = new Date(startMs).toISOString();
    const hi = new Date(namedEnd).toISOString();
    return {
      range: `[${lo},${hi})`,
      startMs,
      endMs: namedEnd,
      days: Math.round((namedEnd - startMs) / DAY_MS),
      key: `${lo}..${hi}`,
    };
  }
  const parsed = parseInt(params.days || String(defaultDays), 10);
  const days = maxDays !== undefined ? Math.min(parsed, maxDays) : parsed;
  const startMs = Date.now() - days * DAY_MS;
  return {
    range: `[${new Date(startMs).toISOString()},infinity)`,
    startMs,
    endMs: Infinity,
    days,
    key: `trailing-${days}`,
  };
}

/**
 * Translate the POST body (dateRange + passthrough extras) into the query-string params the GET
 * query fns already read.
 *
 * A WINDOW THAT CANNOT BE DERIVED IS AN ERROR, NOT A DEFAULT.
 *
 * A pull taken before teardown asked for 24h, 7d, 30d and 90d and got four byte-identical results
 * spanning eight days, because a range the derivation rejected fell through to each query fn's
 * 7-day default. An operator comparing today against last month is shown the same figure twice and
 * has no way to tell.
 *
 * So the rule is: `dateRange` ABSENT means no window was named, and the query fns' default stands
 * for it. `dateRange` PRESENT and unusable is REFUSED, naming what was wrong. The one thing that may
 * not happen is answering a named window with a different one.
 *
 * The bounds are calendar days, `YYYY-MM-DD`, which is the shared contract with Athena mode
 * (`analytics-query.ts` validates exactly that shape and reads `BETWEEN start AND end`). Both days are
 * included, so start == end is one whole day, exactly as it is in Athena. A bound carrying a time of
 * day is read as the UTC day it falls on. `queryWindow` turns the two into the range every query reads.
 */
type BodyParams = { params: Record<string, string | undefined> } | { error: string };

function buildParamsFromBody(body: Record<string, unknown>): BodyParams {
  const p: Record<string, string | undefined> = {};
  const dr = body.dateRange as { start?: string; end?: string } | undefined;
  if (dr !== undefined && dr !== null) {
    if (!dr.start || !dr.end) {
      return { error: 'dateRange needs both start and end (YYYY-MM-DD); omit dateRange to accept the default window' };
    }
    const startMs = Date.parse(dr.start);
    const endMs = Date.parse(dr.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return { error: 'dateRange.start and dateRange.end must be ISO dates (YYYY-MM-DD)' };
    }
    const startDay = Math.floor(startMs / DAY_MS) * DAY_MS;
    const endDay = Math.floor(endMs / DAY_MS) * DAY_MS;
    if (endDay < startDay) {
      return { error: 'dateRange.start must be on or before dateRange.end' };
    }
    p.windowStart = new Date(startDay).toISOString();
    p.windowEnd = new Date(endDay + DAY_MS).toISOString();
  }
  for (const k of [
    'limit', 'offset', 'channelArn', 'personId', 'experimentId', 'unresolved', 'agentType', 'includeBattle', 'taskId', 'intent',
    // The task state an Effectiveness breakdown is narrowed to (`?step=`, ADR-064).
    'step',
    // The ROOM's classification, which became a separate question when `agent_type` stopped carrying
    // it and started carrying the assistant that answered.
    'conversationClassification',
    // The role the answering assistant holds, and the profile version that produced the turn.
    'assistantRole', 'profileVersion',
    // experiment_exchanges: which axis (metrics/battle) and an optional per-variant narrowing.
    'axis', 'variantId',
    // Classification shadow gate (DESIGN §5): replay lifecycle + adjudication.
    'runId', 'labelId', 'trueLabel', 'note', 'incumbentModel', 'challengerModel', 'windowDays',
    'marginPct', 'pendingOnly',
    // Quality-tab write actions (ground_truth submit / flagged review) — #33/#35.
    // `scorerId` is NOT here, and must not return: the author of a human label is the verified
    // caller (`callerSub`, threaded in by handlePostQuery), not a name the body chooses for itself.
    'action', 'exchangeId', 'score', 'classification', 'reasoning', 'reviewAction', 'notes',
    // A label's compliance and groundedness halves (SPEC-EVALUATION Appendix C4), so every judged
    // reading has a human verdict to be measured against. Categories ride as a comma-separated list of
    // rule ids, validated against the rule set at the write.
    'isCompliant', 'complianceCategories', 'isGrounded',
    // The golden set's writes (SPEC-EVALUATION FR16): which tier a nomination enters, and which entry a
    // retire or promote names.
    'purpose', 'entryId',
    // The Performance overview's drill: a node of the flow, and the turn opened from it.
    'flowPath', 'flowIntent', 'flowOutcome',
    // The shared bar's Path and Battle filters, read by every Performance query.
    'turnEntry', 'duelRound', 'responseType',
    // Raising a flag from Oversight. `channelArn` and `messageId` are what the
    // transcript can address - no exchange id reaches that client, and the exchange row may not be
    // archived yet - and `reason` is the closed set validated in getFlaggedResponses.
    'messageId', 'reason',
    // The guest-to-customer funnel narrowed to one journey: a visitor's conversation, by its channel id (B12).
    'journey',
    // Why a team member is reading its assistant's responses (`accessReason`, not `reason`, which is a
    // flag's reason). Required on a team's flagged and ground-truth list reads.
    'accessReason',
    // latency_exchanges: the turns behind ONE breakdown row, so the drill needs every dimension that
    // row is grouped on. Omitting these silently widened the drill to a different population than the
    // row that was clicked - the exact failure the query's own header warns about.
    'day', 'deliveryOption', 'turnEntry',
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
  return { params: p };
}

/**
 * Moderation audit write: POST { queryType: 'record_moderation', channelArn, messageId, moderation }.
 * The actor is the resolved caller (actorSub, plus the token's display attributes), NEVER the body,
 * so it can't be spoofed. Returns null when the body isn't a record_moderation request (normal dispatch continues).
 */
async function maybeRecordModeration(
  rawBody: string | null,
  actorSub: string,
  contact: { email: string | null; name: string | null },
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
  const actorName = contact.name || contact.email || undefined;
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

/** The queryType and write `action` named in a POST body (empty if absent/malformed) — for the
 *  per-resource capability check. */
function parsePostQueryTypeAndAction(rawBody: string | null): { queryType: string; action?: string } {
  try {
    const body = JSON.parse(rawBody || '{}');
    const action = typeof body.action === 'string' ? body.action : undefined;
    return { queryType: String(body.queryType || ''), action };
  } catch {
    return { queryType: '' };
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
  callerScope: ClassificationScope = null,
  /** Server-verified caller sub from the JWT. Overwrites any body-supplied value (see below). */
  callerSub?: string,
  /** A team-scoped route's assistant: every row returned is that assistant's (SPEC-ADMIN-CONSOLE FR48). */
  assistant?: string,
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
  const built = buildParamsFromBody(body);
  // REFUSED RATHER THAN REINTERPRETED. A named window this surface cannot serve is a 400 that says
  // which part was wrong, because the alternative - the behavior this replaced - is a 200 carrying
  // numbers for some other window.
  if ('error' in built) return error(400, built.error);
  const params = built.params;
  // Identity comes from the verified JWT, never the request body, and is written AFTER the body is
  // unpacked so a caller cannot attribute a write to someone else by sending their own `callerSub`.
  // Same rule as maybeRecordModeration: the actor is server-verified or absent.
  if (callerSub) params.callerSub = callerSub;
  // The classifications a team session's clearance reaches, which bound every query it runs.
  const teamReach = assistant && callerScope !== null
    ? defaultProfileRegistry.classificationValues().filter((c) => classificationAllowed(c, callerScope))
    : null;
  if (assistant && ASSISTANT_BOUND_QUALITY.has(queryType)) {
    // A TEAM'S TRIAGE AND LABELS: its own assistant's responses, in rooms its clearance reaches.
    const reach = teamReach ?? [];
    (params as Record<string, unknown>).boundAssistant = assistant;
    (params as Record<string, unknown>).conversationClassifications = reach;
    if (params.action) {
      // A write lands only on a turn the path's assistant answered; anything else is refused, whether
      // or not it exists.
      if (!(await turnIsTheAssistants(queryType, params, assistant, reach))) {
        return error(403, `That response is not one of ${assistant}'s turns in your scope`);
      }
    } else {
      // A list returns what was said, so like a conversation read it requires a stated reason.
      const accessReason = (params.accessReason || '').trim().slice(0, 500);
      if (!accessReason) return error(400, 'a reason is required to read responses (REASON_REQUIRED)');
      console.log(JSON.stringify({
        _auditEvent: 'team_quality_read',
        timestamp: new Date().toISOString(),
        sub: callerSub || null,
        assistant,
        queryType,
        reason: accessReason,
      }));
    }
  } else if (assistant) {
    // Only a query that can be bound to one assistant AND to the holder's clearance runs here, and it is
    // bound to the path's assistant and that clearance whatever the body asked for. Anything else is
    // refused rather than answered across assistants or above the clearance.
    if (!ASSISTANT_FILTERED_QUERIES.has(queryType) && !ASSISTANT_ROW_QUERIES.has(queryType)) {
      return error(403, `"${queryType}" is not attributed per assistant, so a team cannot read it`);
    }
    params.agentType = assistant;
    // Set server-side only: `buildParamsFromBody` copies no such key, so a body cannot name it.
    (params as Record<string, unknown>).conversationClassifications = teamReach ?? [];
  }
  const res = await entry.fn(params);
  if (res.statusCode !== 200) return res;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    return error(500, 'Malformed analytics result');
  }
  const arr = Array.isArray(parsed[entry.dataKey]) ? parsed[entry.dataKey] : [];
  // A14 Scoped: narrow rows with a classification dimension to the caller's scope.
  const scoped = scopeAnalyticsRows(arr as unknown[], callerScope);

  // A row-attributed query is filtered to the assistant's rows and returned as rows alone: any total
  // beside them was computed across every assistant and is not this team's to read.
  // A row with no classification is not passed to a team: it cannot be shown to be within the clearance.
  if (assistant && ASSISTANT_ROW_QUERIES.has(queryType)) {
    const reach = new Set(teamReach ?? []);
    return success({
      data: (scoped as Array<{ assistant?: unknown; conversation_classification?: unknown }>)
        .filter((r) => r?.assistant === assistant && typeof r.conversation_classification === 'string' && reach.has(r.conversation_classification)),
    });
  }

  // ── EVERY ROW-BEARING FIELD IS SCOPED, NOT JUST `data` ────────────────────────────────────────
  //
  // `battleEffectiveness` rides alongside `data` on the experiment response and went out through the
  // spread below untouched. That was harmless while those rows carried no tier dimension - there was
  // nothing for a scope to narrow - and stopped being harmless the moment they gained
  // `conversation_classification`: an admin with a restricted scope would receive battle metrics,
  // costs and win counts for classifications above it.
  //
  // THE LESSON IS THE SHAPE, NOT THE FIELD. A response that carries rows anywhere except the one key
  // this function scopes is a response whose extra rows are unscoped, and adding a dimension to an
  // existing field is enough to turn a harmless omission into a leak with no code change at the
  // omission site. So the sibling is scoped BY NAME here rather than trusted to stay dimensionless,
  // and `caller-scope.test.ts` pins that any future sibling is added to this list.
  const sideChannels: Record<string, unknown> = {};
  for (const key of ROW_BEARING_SIBLING_KEYS) {
    const sibling = parsed[key] as { data?: unknown[] } | undefined;
    if (sibling && Array.isArray(sibling.data)) {
      sideChannels[key] = { ...sibling, data: scopeAnalyticsRows(sibling.data, callerScope) };
    }
  }

  // Normalize to { data: [...] }; keep the rest (stats/pagination/totals) at top level.
  return success({ ...parsed, ...sideChannels, data: scoped });
}

/**
 * Response fields OTHER than `data` that carry rows a classification scope must narrow.
 *
 * Kept as a named list rather than a structural sweep because a structural one would have to guess
 * which nested arrays are rows about a conversation and which are, say, column names - and guessing
 * wrong in the permissive direction is the failure this exists to prevent.
 */
const ROW_BEARING_SIBLING_KEYS = ['battleEffectiveness'] as const;

/**
 * The queries a team-scoped route may run, because their SQL takes `agentType` and filters on it, so
 * every figure they return - rows and totals alike - is computed over one assistant's turns.
 *
 * NO QUERY THAT RETURNS WHAT WAS SAID. `evaluation_exchanges` carries the user's message and the
 * assistant's answer, and `execution_steps` the raw tool steps; reading those is a per-conversation
 * read that needs a stated reason and a vend (SPEC-ADMIN-CONSOLE FR51), which a team does not have.
 */
export const ASSISTANT_FILTERED_QUERIES: ReadonlySet<string> = new Set([
  // Each takes `agentType` AND `conversationClassifications` in its SQL, so a team's figures cover its
  // own assistant's turns in rooms its holder's clearance reaches, and nothing else. A query that takes
  // the first and not the second is not here, however per-assistant its rows look.
  'intent_effectiveness',
  // The step and model breakdown of one intent's row, over the same filters.
  'intent_steps',
  'latency_exchanges',
  // Attributed per turn through `exchanges` (Phase 6), so a room with several assistants splits by
  // who answered, and a row no exchange claims - including one migration 055 could not backfill - is no
  // team's and is read by `admins` alone.
  'model_usage',
  'model_effectiveness',
  'turn_kinds',
  'drift_events',
  'workflow_trajectory',
  'safety_readings',
  'frustration',
  'retrieval_sources',
  'judge_calibration',
  'tool_outcomes',
  'template_outcomes',
  'message_flow',
  'flow_turns',
  'flow_turn',
  'welcome_flow',
]);

/**
 * A TEAM'S TRIAGE AND LABELS (`triage-responses`, `label-ground-truth`): the flagged and ground-truth
 * lists and their writes, bound to the path's assistant. The lists filter in SQL on the assistant and the
 * session's clearance and require a stated reason, because they return what was said; each write is
 * checked against the turn it lands on (`turnIsTheAssistants`). Adjudicating a classifier is not here: a
 * classifier serves a whole classification, never one team's assistant.
 */
export const ASSISTANT_BOUND_QUALITY: ReadonlySet<string> = new Set(['flagged_responses', 'ground_truth', 'label_queue', 'golden_set']);

/** The assistant a team route bound this query to, or null for an admin. Never read from a body. */
function boundAssistantOf(params: Record<string, string | undefined>): string | null {
  const a = (params as Record<string, unknown>).boundAssistant;
  return typeof a === 'string' && a ? a : null;
}

/** The classifications a team route bound this query to, or null for an admin. */
function boundClassificationsOf(params: Record<string, string | undefined>): string[] | null {
  if (!boundAssistantOf(params)) return null;
  const c = (params as Record<string, unknown>).conversationClassifications;
  return Array.isArray(c) ? (c as string[]) : [];
}

/**
 * Whether the turn a team's write names was answered by its assistant, in a room its clearance reaches.
 * A flag names the Amazon Chime SDK message; a review or a label names the exchange.
 */
async function turnIsTheAssistants(
  queryType: string,
  params: Record<string, string | undefined>,
  assistant: string,
  reach: string[],
): Promise<boolean> {
  const action = params.action;
  if (queryType === 'flagged_responses' && (action === 'flag' || action === 'unflag')) {
    if (!params.channelArn || !params.messageId) return false;
    const r = await query(
      `SELECT 1 FROM messages m
         JOIN exchanges e ON e.agent_message_id = m.id
        WHERE m.message_id = $1 AND m.channel_arn = $2 AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
          AND e.assistant = $3 AND e.conversation_classification = ANY($4)
        LIMIT 1`,
      [params.messageId, params.channelArn, assistant, reach],
    );
    return r.rows.length > 0;
  }
  if ((queryType === 'flagged_responses' && action === 'review') || (queryType === 'ground_truth' && action === 'submit')
    || (queryType === 'golden_set' && action === 'nominate')) {
    if (!params.exchangeId) return false;
    const r = await query(
      `SELECT 1 FROM exchanges e
        WHERE e.id::text = $1 AND e.assistant = $2 AND e.conversation_classification = ANY($3)
        LIMIT 1`,
      [params.exchangeId, assistant, reach],
    );
    return r.rows.length > 0;
  }
  return false;
}

/**
 * Queries whose rows each carry `agent_type` but whose SQL does not filter on it: answered for a team
 * by keeping that assistant's rows and nothing else from the response.
 */
export const ASSISTANT_ROW_QUERIES: ReadonlySet<string> = new Set(['latency_metrics']);

/**
 * GET /analytics/evaluation - Daily evaluation metrics
 */
async function getEvaluationMetrics(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const cacheKey = `eval-metrics-${win.key}`;
  const cached = getCached(cacheKey);
  if (cached) return success(cached);

  const result = await query(
    `SELECT
       COUNT(*) AS total_exchanges,
       COUNT(er.id) AS evaluated_exchanges,
       ROUND(AVG(er.relevance_score)::numeric, 1) AS avg_relevance_score,
       -- ── COMPLIANCE IS COUNTED OVER ASSESSED ROWS ONLY (DESIGN-EVALUATION, Pass C) ──
       --
       -- is_compliant is written by the evaluation runner's Pass C, and is NULL on every exchange it
       -- has not reached: those from before Pass C, and those where neither a guardrail finding nor a
       -- usable judgement could assess it. What a reader does with that NULL decides the number it
       -- reports. This one filtered on the raw column and said 0%; getModelEffectiveness and the
       -- experiment query coalesced it to true and said 100%; the daily breakdown counted violations
       -- as NOT-coalesced-true and said none. Same data, three answers, all of them artifacts.
       --
       -- NULL IS A THIRD STATE - not assessed - and it is never coalesced. A rate is taken over rows
       -- that carry a verdict; rows without one are excluded from BOTH halves and counted separately
       -- below. With no writer the denominator is zero and the rate is NULL, which is the truthful
       -- answer: nothing has been assessed. That is strictly better than a confident 0% or 100%.
       ROUND(
         (COUNT(*) FILTER (WHERE er.is_compliant IS TRUE) * 100.0 /
          NULLIF(COUNT(*) FILTER (WHERE er.is_compliant IS NOT NULL), 0))::numeric, 1
       ) AS compliance_rate,
       -- COVERAGE, BESIDE THE RATE, ALWAYS. A rate over an unscored population is the failure mode
       -- this change exists to end, and the only way a reader can tell "100% compliant" from "nothing
       -- was looked at" is to publish the denominator.
       COUNT(*) FILTER (WHERE er.is_compliant IS NOT NULL) AS compliance_assessed_count,
       -- ── EVERY VERDICT THE JUDGE CAN RETURN HAS A BUCKET ────────────────────────────────────────
       --
       -- The judge returns SIX classifications (evaluation-runner.ts, which holds the LIVE rubric -
       -- evaluation/relevance-prompt.ts is an unimported second copy and has drifted): excellent, good, partial,
       -- poor, irrelevant, appropriate_refusal - and the runner can also record error_response. These
       -- counters covered four of them, so two verdicts were counted nowhere and the buckets did not
       -- sum to the population. MEASURED 2026-09-14: 15 of 200 scored exchanges were
       -- appropriate_refusal, 7.5 percent of the sample, absent from every number on the tab.
       --
       -- AND IT LEANED THE WRONG WAY. An appropriate refusal is a GOOD outcome - the prompt scores it
       -- 85-100 for correctly declining - so dropping it UNDERSTATED quality, while a reader summing
       -- the four buckets got 93 percent of the population with nothing saying so.
       --
       -- Refusals stay their own bucket rather than folding into good. "The assistant answered
       -- well" and "the assistant was right to decline" are different facts about a deployment, and a
       -- rising refusal count is worth seeing on its own.
       COUNT(*) FILTER (WHERE er.classification = 'excellent') AS excellent_count,
       COUNT(*) FILTER (WHERE er.classification = 'good') AS good_count,
       COUNT(*) FILTER (WHERE er.classification = 'partial') AS partial_count,
       COUNT(*) FILTER (WHERE er.classification = 'appropriate_refusal') AS appropriate_refusal_count,
       COUNT(*) FILTER (WHERE er.classification IN ('poor', 'irrelevant', 'error_response')) AS poor_count,
       -- THE DENOMINATOR, so the buckets can be checked against it rather than trusted to sum. A
       -- verdict this deployment adds later lands here and nowhere else, and the discrepancy is then
       -- visible instead of silent.
       COUNT(*) FILTER (WHERE er.classification IS NOT NULL) AS scored_count,
       -- ── WHICH MODEL JUDGED, AND WHETHER THIS WINDOW HAS ONE ANSWER TO THAT ────────────────────
       --
       -- Tenet P3: the harness outlives the model, and a model is a replaceable function call, so
       -- swapping the judge is an expected event rather than an edge case. Every score re-baselines
       -- when it happens: a drop in relevance is either a regression in the assistant or a different
       -- judge, and the two are indistinguishable while the model is unreadable.
       --
       -- The rubric version already segregates rows scored under different PROMPT wording. The model
       -- is the other axis of the same problem, and the axis the runner records and every reader
       -- throws away. The count is what makes the average readable: more than one judge in a window
       -- means the average spans two instruments and is not one number.
       --
       -- Aurora mode only. The four-pass Aurora runner writes this column; the Athena runner scores
       -- relevance alone and carries no evaluator model, so this is absent there rather than null.
       COUNT(DISTINCT er.evaluator_model) AS evaluator_model_count,
       MAX(er.evaluator_model) AS evaluator_model
     FROM exchanges e
     -- ONE ROW PER EXCHANGE, MOST RECENT SCORING WINS.
     --
     -- A re-scored exchange has SEVERAL evaluation_results rows, so joining them raw multiplied
     -- every COUNT taken over this join and inflated the totals - and the two panels most likely
     -- to be re-scored are the ones an operator re-scores BECAUSE they looked wrong.
     --
     -- The latest evaluation rather than an average, because classification and compliance are
     -- CATEGORICAL: a relevance score can be averaged and a verdict cannot, and the latest is what
     -- a person reading a re-scored exchange means by "its" score. evaluated_at DESC is indexed
     -- (idx_evaluation_date), and the evaluation_type filter is the one line 467 already carried.
     LEFT JOIN (
       SELECT DISTINCT ON (exchange_id)
              exchange_id, id, relevance_score, classification, reasoning, is_compliant, flags,
              -- The model that produced the verdict on this row. Carried out of the subquery because a
              -- score that cannot name its judge cannot be compared across a judge swap.
              evaluator_model
         FROM evaluation_results
        WHERE evaluation_type = 'exchange'
        ORDER BY exchange_id, evaluated_at DESC
     ) er ON er.exchange_id = e.id
     WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
       -- ONE ROW PER TURN, NOT ONE PER QUEUED MESSAGE (review, 2026-09-17). A folded answer writes an
       -- exchange per message the queue held, all sharing one agent_message_id - so without this the
       -- join to messages repeats that turn N+1 times and every average over it, plus
       -- exchange_count itself, is weighted by how many messages the person happened to send while
       -- the assistant was busy. v_turn_latency anchors on the same predicate for the same reason.
       -- The folded rows are not lost: they are the queue-wait population, read on their own.
       AND e.queued_as IS NULL`,
    [win.range]
  );

  // Daily breakdown. Column aliases MUST match the frontend EvaluationScoreData
  // contract ({ date, agent_type, intent_type, avg_relevance_score, count }) —
  // the same shape Athena mode returns — so EvaluationsTab renders in both
  // modes. Emitting avg_score/exchange_count here (the earlier names) made the
  // UI read undefined and render NaN for every row.
  const dailyResult = await query(
    `SELECT
       TO_CHAR(DATE(e.created_at), 'YYYY-MM-DD') AS date,
       e.assistant,
       COALESCE(e.intent, 'unknown') AS intent_type,
       COUNT(*) AS count,
       ROUND(AVG(er.relevance_score)::numeric, 1) AS avg_relevance_score,
       -- A VIOLATION IS A RECORDED false, never an absent verdict. NOT COALESCE(..., true) read
       -- an unjudged row as compliant, which is the same invention as the 100% rate - it just happened
       -- to produce a number that looked harmless. IS FALSE counts only what was actually judged and
       -- found wanting; compliance_assessed_count beside it says how much was judged at all.
       COUNT(*) FILTER (WHERE er.is_compliant IS FALSE) AS violation_count,
       -- AND HOW MANY OF THOSE WERE BLOCKING. severity is declared on every rule and read by
       -- nothing, so a minor tone finding and a disclosed credit-card number counted the same and an
       -- operator had no way to tell a quiet week from an urgent one. The blocking ids come from the
       -- rule set ($2), and ?| asks whether the verdict's category array names any of them.
       COUNT(*) FILTER (WHERE er.compliance_categories ?| $2::text[]) AS blocking_violation_count,
       COUNT(*) FILTER (WHERE er.is_compliant IS NOT NULL) AS compliance_assessed_count,
       -- WHICH JUDGE PRODUCED THIS GROUP'S AVERAGE. A daily row is one (day, assistant, intent) group,
       -- and the count travels with the name for the same reason it does on the headline: a group that
       -- spans a judge swap has no single judge to print, and printing one of the two would be the
       -- confident wrong answer rather than the missing one.
       COUNT(DISTINCT er.evaluator_model) AS evaluator_model_count,
       MAX(er.evaluator_model) AS evaluator_model
     FROM exchanges e
     -- ONE ROW PER EXCHANGE, MOST RECENT SCORING WINS.
     --
     -- A re-scored exchange has SEVERAL evaluation_results rows, so joining them raw multiplied
     -- every COUNT taken over this join and inflated the totals - and the two panels most likely
     -- to be re-scored are the ones an operator re-scores BECAUSE they looked wrong.
     --
     -- The latest evaluation rather than an average, because classification and compliance are
     -- CATEGORICAL: a relevance score can be averaged and a verdict cannot, and the latest is what
     -- a person reading a re-scored exchange means by "its" score. evaluated_at DESC is indexed
     -- (idx_evaluation_date), and the evaluation_type filter is the one line 467 already carried.
     LEFT JOIN (
       SELECT DISTINCT ON (exchange_id)
              exchange_id, id, relevance_score, classification, reasoning, is_compliant,
              compliance_categories, flags,
              -- The judge behind this row's score, so the daily series can say where a re-baseline began.
              evaluator_model
         FROM evaluation_results
        WHERE evaluation_type = 'exchange'
        ORDER BY exchange_id, evaluated_at DESC
     ) er ON er.exchange_id = e.id
     WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
       -- THE SAME ONE-ROW-PER-TURN PREDICATE THE HEADLINE ABOVE USES. It was added there and not
       -- here, over the same window and the same join, so the tab showed a headline count smaller
       -- than the sum of its own daily chart and an average that did not match the series - with
       -- nothing to say which was right.
       AND e.queued_as IS NULL
     GROUP BY DATE(e.created_at), e.assistant, COALESCE(e.intent, 'unknown')
     ORDER BY date DESC`,
    [win.range, BLOCKING_RULE_IDS]
  );

  const row = result.rows[0] || {};
  const data = {
    totalExchanges: parseInt(row.total_exchanges || '0', 10),
    evaluatedExchanges: parseInt(row.evaluated_exchanges || '0', 10),
    avgRelevanceScore: parseFloat(row.avg_relevance_score || '0'),
    // NULL WHEN NOTHING WAS ASSESSED, not 0. parseFloat('' || '0') turned "no verdict exists" into
    // a confident zero - the surface then rendered 0% compliance for a population nobody had judged.
    // A rate with no denominator has no value, and the field says so rather than inventing one.
    complianceRate: row.compliance_rate === null || row.compliance_rate === undefined
      ? null
      : parseFloat(row.compliance_rate),
    /** How many exchanges carry a compliance verdict at all. Rendered beside the rate; a rate without
     *  it cannot be told apart from "nothing was looked at". */
    complianceAssessed: parseInt(row.compliance_assessed_count || '0', 10),
    scoreDistribution: {
      excellent: parseInt(row.excellent_count || '0', 10),
      good: parseInt(row.good_count || '0', 10),
      partial: parseInt(row.partial_count || '0', 10),
      poor: parseInt(row.poor_count || '0', 10),
      /** A correct decline, which the judge scores 85-100. Its own bucket because "answered well"
       *  and "was right to decline" are different facts, and a rising refusal count is worth
       *  seeing. Omitted entirely until 2026-09-14, when it was 7.5 percent of scored exchanges. */
      appropriateRefusal: parseInt(row.appropriate_refusal_count || '0', 10),
    },
    /** Every exchange carrying a verdict. The buckets above are checked against this rather than
     *  trusted to sum: a verdict a deployment adds later lands in the total and in no bucket, and
     *  the discrepancy is then visible instead of silently dropped. */
    scoredCount: parseInt(row.scored_count || '0', 10),
    /** The judge behind every score on this surface, null until something in the window is scored. A
     *  reader comparing this window against last month's has to be able to see that the instrument
     *  changed, and could not: the runner records the model on every row and nothing read it. */
    evaluatorModel: row.evaluator_model ?? null,
    /** How many DISTINCT judges scored this window. One is the ordinary case and says nothing worth
     *  printing; more than one means the average above spans two instruments, which is the warning. */
    evaluatorModelCount: parseInt(row.evaluator_model_count || '0', 10),
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
  const win = queryWindow(params, 7);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const offset = parseInt(params.offset || '0', 10);
  const agentType = params.agentType;

  let whereClause = 'WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)';
  const queryParams: any[] = [win.range, limit, offset];

  if (agentType) {
    queryParams.push(agentType);
    whereClause += ` AND e.assistant = $${queryParams.length}`;
  }

  const result = await query(
    `SELECT
       e.id,
       e.channel_arn,
       e.conversation_classification,
       -- Deprecated and no longer written (migration 050). Still selected, AFTER the column above,
       -- only so an exchange minted before 050 stays narrowed to the caller's callerScope.
       e.user_type,
       e.assistant,
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
       er.flags,
       -- THE MODEL THAT PRODUCED THIS VERDICT. The runner stamps it on every row it writes and no
       -- reader carried it, so a score and its judge parted company at the query. NULL on a row scored
       -- before the column existed, which a surface renders as a dash rather than as a model name.
       er.evaluator_model
     FROM exchanges e
     LEFT JOIN messages um ON e.user_message_id = um.id
     LEFT JOIN messages am ON e.agent_message_id = am.id
     -- ONE ROW PER EXCHANGE, MOST RECENT SCORING WINS.
     --
     -- A re-scored exchange has SEVERAL evaluation_results rows, so joining them raw multiplied
     -- every COUNT taken over this join and inflated the totals - and the two panels most likely
     -- to be re-scored are the ones an operator re-scores BECAUSE they looked wrong.
     --
     -- The latest evaluation rather than an average, because classification and compliance are
     -- CATEGORICAL: a relevance score can be averaged and a verdict cannot, and the latest is what
     -- a person reading a re-scored exchange means by "its" score. evaluated_at DESC is indexed
     -- (idx_evaluation_date), and the evaluation_type filter is the one line 467 already carried.
     LEFT JOIN (
       SELECT DISTINCT ON (exchange_id)
              exchange_id, id, relevance_score, classification, reasoning, is_compliant, flags,
              -- The judge that produced the verdict on this exchange, carried alongside it.
              evaluator_model
         FROM evaluation_results
        WHERE evaluation_type = 'exchange'
        ORDER BY exchange_id, evaluated_at DESC
     ) er ON er.exchange_id = e.id
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
  // channel_arn rides along so a tool FAILURE is navigable: the tool lens can hand a reader the
  // conversation the failing call happened in, instead of naming a message id they cannot open.
  'message_id', 'channel_arn', 'timestamp', 'intent', 'bedrock_model', 'total_ms', 'step_count', 'steps',
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
  const win = queryWindow(params, 7);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const queryParams: any[] = [win.range, limit];

  let where = `WHERE m.is_bot = true
       AND m.metadata ? 'steps'
       AND jsonb_array_length(m.metadata->'steps') > 0
       AND m.created_at >= lower($1::tstzrange) AND m.created_at < upper($1::tstzrange)`;
  if (params.channelArn) {
    queryParams.push(params.channelArn);
    where += ` AND m.channel_arn = $${queryParams.length}`;
  }
  // ── THE SAME POPULATION AS THE CARD THAT SENDS A READER HERE ──────────────
  //
  // The tool lens is built from these rows and sits beside a tool-error-rate card computed inside
  // intent_effectiveness, which IS filtered. Unfiltered here, the two described different populations:
  // reported live as a card reading 0.0% above a table showing 19 calls and a row at 27%. Both were
  // right about their own population and the surface said nothing about there being two.
  //
  // messages carries all four dimensions itself, so this needs no join - the same columns
  // getLatencyMetrics coalesces over.
  for (const [value, column] of [
    [params.agentType, 'm.assistant'],
    [params.conversationClassification, 'm.conversation_classification'],
    [params.assistantRole, 'm.assistant_role'],
  ] as Array<[string | undefined, string]>) {
    if (!value) continue;
    queryParams.push(value);
    where += ` AND ${column} = $${queryParams.length}`;
  }
  if (params.profileVersion) {
    queryParams.push(parseInt(params.profileVersion, 10));
    where += ` AND m.profile_version = $${queryParams.length}`;
  }

  const result = await query(
    `SELECT
       m.message_id,
       m.channel_arn,
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
  const win = queryWindow(params, 7);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const offset = parseInt(params.offset || '0', 10);

  const result = await query(
    `SELECT
       f.id,
       f.task_id,
       f.channel_arn,
       f.intent,
       f.assistant,
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
     WHERE f.created_at >= lower($1::tstzrange) AND f.created_at < upper($1::tstzrange)
     ORDER BY f.created_at DESC
     LIMIT $2 OFFSET $3`,
    [win.range, limit, offset]
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
  const win = queryWindow(params, 7);
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
       -- The deprecated user_type (migration 050) held this same value on a conversation, so it
       -- answers for one archived before the new column existed.
       COALESCE(c.conversation_classification, NULLIF(c.user_type, 'unknown')) AS conversation_classification,
       c.assistant,
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
     -- source (tenet D7).
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
     WHERE c.last_message_at >= lower($1::tstzrange) AND c.last_message_at < upper($1::tstzrange)
     ORDER BY c.last_message_at DESC
     LIMIT $2 OFFSET $3`,
    [win.range, limit, offset]
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
 * one row per day: { date, message_count, user_message_count, bot_message_count,
 * conversation_count, paired_exchange_count } to match the
 * OverviewTab volume table and its message-trend sparkline.
 */
async function getConversationVolumes(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 180);
  // ── THE POPULATIONS ARE NAMED SEPARATELY, SO A COUNT CAN BE CHECKED (2026-09-10) ──────────────
  //
  // This returned one undifferentiated `message_count`, and that absence had a cost well outside this
  // query. `latency_metrics.assistant_turn_count` counts assistant turns - which the
  // comment above it states plainly is NOT exchanges, since a bot-initiated message (a welcome, a
  // round-2 rebuttal, a drift notice) is counted there and has no exchange at all. Nothing in the API
  // exposed the pairing population, so that mislabelling could not be falsified from outside the
  // database by any consumer, test or operator. A figure nobody can check is how one came to be
  // described in its own comments as "a number nobody could name", with the P95 latency band tuned
  // against it.
  //
  // `paired_exchange_count` comes from the `exchanges` table, which is the pairing itself rather than
  // a proxy for it: one row per user message answered by an agent message. That is the denominator
  // a count of exchanges needs, and publishing it is what makes the two populations checkable.
  //
  // ADDITIVE. `message_count` and `conversation_count` keep their meaning and their names, so every
  // existing reader is unaffected; the new columns sit beside them.
  const result = await query(
    `WITH msg AS (
       SELECT DATE(created_at) AS d,
              -- A handover is a message (handoverSql): counted in the totals, and broken out as
              -- handover_count beside them.
              COUNT(*) FILTER (WHERE event_type = 'CREATE_CHANNEL_MESSAGE') AS message_count,
              COUNT(*) FILTER (WHERE event_type = 'CREATE_CHANNEL_MESSAGE' AND is_bot = false)
                AS user_message_count,
              COUNT(*) FILTER (WHERE event_type = 'CREATE_CHANNEL_MESSAGE' AND is_bot = true)
                AS bot_message_count,
              COUNT(*) FILTER (WHERE event_type = 'CREATE_CHANNEL_MESSAGE' AND ${handoverSql('messages')})
                AS handover_count,
              COUNT(DISTINCT channel_arn) AS conversation_count
         FROM messages
        WHERE created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
        GROUP BY DATE(created_at)
     ), ex AS (
       SELECT DATE(created_at) AS d, COUNT(*) AS paired_exchange_count
         FROM exchanges
        WHERE created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
        GROUP BY DATE(created_at)
     )
     SELECT TO_CHAR(msg.d, 'YYYY-MM-DD') AS date,
            msg.message_count,
            msg.user_message_count,
            msg.bot_message_count,
            msg.handover_count,
            msg.conversation_count,
            -- LEFT JOIN and COALESCE, because a day with messages and no completed pairing is a real
            -- state - archival lag, or a turn that never produced an agent reply - and reporting it
            -- as zero is the truth. An INNER JOIN would drop the day entirely and hide exactly the
            -- shortfall this column exists to make visible.
            COALESCE(ex.paired_exchange_count, 0) AS paired_exchange_count
       FROM msg
       LEFT JOIN ex ON ex.d = msg.d
      ORDER BY date DESC`,
    [win.range]
  );

  return success({ data: result.rows });
}

/**
 * The assistant turns that produced no exchange, named rather than counted.
 *
 * ONE POPULATION WITH `latency_metrics`. Both read `ASSISTANT_TURN_SQL`, so the total of
 * `unpaired_count` here equals the total of `latency_metrics.unpaired_turn_count` over the same window.
 * Neither equals the `latency_metrics` rows whose delivery_option is 'unknown': that bucket also holds
 * paired turns whose exchange recorded no delivery option, and it is a classification gap rather than
 * a pairing gap.
 *
 * WHY THIS EXISTS. `latency_metrics.assistant_turn_count` counts assistant turns,
 * which is not the same population as exchanges - the comment above that column says so, and measured
 * live on 2026-09-10 it was 1,393 against 597 that actually paired. Knowing the gap is 2.3x says
 * nothing about whether those turns SHOULD have paired, and that is the question that decides what to
 * do about it: a welcome legitimately has no exchange, a queued message's answer arguably belongs in
 * queue analytics, and a reply that was meant to pair and did not is a defect in the pairing.
 *
 * Counting them was the easy half. This is the half that says which they are.
 *
 * THE TWO AXES ARE THE TWO ANSWERS.
 *
 * `corr_marked` is decidable and not a matter of opinion: a bot message pairs only if it carries a
 * `<!--corr:` marker, because a reply is born as a corr-marked placeholder and a marker-less CREATE
 * "is not an answer to anything and must not mint an exchange" (kinesis-archival). So an UNMARKED row
 * could never have paired - it is structurally outside the exchange population - while a MARKED row
 * that did not pair is a genuine pairing failure and worth chasing.
 *
 * `intent` says what kind of turn it was, which is what decides where it belongs. A drain's reading
 * posts its proposal as a fresh unmarked message, so every drain contributes one; those are queue
 * work and belong in queue analytics rather than inflating a count named for exchanges.
 *
 * `target_paired` is the axis that finishes the declared half, and it was added because the declared
 * half could not be acted on without it. MEASURED 2026-09-15 on the deployment: 33 unpaired rows
 * (32 `report_generation`, 1 `general`) carried a declaration, and every one of them was the SECOND
 * message of a turn whose delivery moved off its placeholder - a broadcast answer, a privately
 * targeted answer, or an answer posted at the end of a queue the notice sits above. The placeholder
 * left behind is corr-marked and adjacent, so it takes the exchange; the message that carries the
 * answer AND the declaration is the one with nothing attached to it.
 *
 * So "declared and unpaired" is two different findings wearing one count:
 *
 *   target_paired = true    the turn WAS answered - through the message that acknowledged it - and
 *                           this row is its second message. One turn mints one exchange, so this row
 *                           has nothing left to pair with. Not a lost answer.
 *   target_paired = false   the turn named a message and NOTHING anywhere records an answer to it.
 *                           That is an answer the projection lost, and the only half worth chasing.
 *   target_paired = NULL    nothing was declared, so the question does not apply.
 *
 * ASKED OF THE SAME RESPONDER, because a duel's two sides answer one message as two identities and
 * "somebody answered it" would read a rival's reply as this one's pairing.
 *
 * Aurora-only, and read-only. It answers a question about the projection using the projection.
 */
async function getUnpairedBotMessages(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 180);
  const result = await query(
    `SELECT
       COALESCE(upd.metadata->>'intent', m.metadata->>'intent', 'unknown') AS intent,
       (m.content LIKE '%<!--corr:%') AS corr_marked,
       -- ── HOW THE TURN ENTERED, WHICH DECIDES WHETHER "UNDECLARED" IS A BUG ────────────────────
       --
       -- The two entries have different expectations, and without this column they are one
       -- undifferentiated count that cannot be acted on. A 'lex' turn CANNOT declare: Amazon Chime
       -- SDK sends Lex no message id (the three request attributes are the channel, the sender and
       -- the platform), so the router has nothing to name and the correlation id falls back to a
       -- hash. Undeclared there is the documented limit of that path.
       --
       -- A 'flow' turn is the opposite. The channel flow hands the router the inbound MessageId, the
       -- router writes it into the placeholder's own turn declaration, and archival folds it into
       -- answers_message_id. Undeclared THERE means that chain broke, on the path that carries
       -- every standard message.
       --
       -- So this one column separates "the entry has no id to give" from "the id was given and
       -- lost", which are the same row today and want opposite responses.
       COALESCE(upd.turn_entry, m.turn_entry,
                upd.metadata->>'entry', m.metadata->>'entry') AS turn_entry,
       -- WHICH PRODUCER WROTE THIS, identified without reading the conversation. Four call sites
       -- write a correlation marker and all of them also write a turn declaration, so a row with the
       -- first and not the second comes from a producer this codebase has not accounted for. The
       -- marker SHAPE says which: the mention form carries the inbound MessageId, and the
       -- hash form means it did not.
       --
       -- NO CONTENT LEAVES THROUGH HERE. A one-off diagnostic returned 40 stripped characters of the
       -- placeholder copy to name the producer, and it did its job and was removed: an analytics count
       -- is not a route to read conversations, however narrow the window looked.
       (substring(m.content from '<!--corr:(mention)-') IS NOT NULL) AS corr_is_mention,
       (m.content LIKE '%<!--turn:%') AS has_turn_marker,
       -- ── A REBUTTAL NEVER PAIRS, AND IT IS THE BULK OF THIS COUNT ────────────────────────────
       --
       -- Measured 2026-09-23: 84 of 95 rows here were round-2 duel placeholders. They declare
       -- nothing at all - no answers, no kind, no entry - and battle-turn.ts says why at the call
       -- site: naming the originating message would file the rebuttal as a declared answer to a
       -- question that was already answered, at a latency spanning both rounds. That is deliberate
       -- and correct.
       --
       -- SO THE ROWS WERE RIGHT AND THE COUNT WAS WRONG. This query reads as "answers that should
       -- have paired and did not", and a rebuttal is not an answer to anything. Without this column
       -- it dominated the total, which is how a healthy deployment read as 84 broken pairings and
       -- sent two separate investigations after a backfill that correctly did nothing.
       --
       -- SURFACED RATHER THAN EXCLUDED, the same choice every other population here makes: a reader
       -- segregates on a column they can see, instead of trusting a filter they cannot.
       (m.content LIKE '%rivalReplyMsgId=%') AS is_rebuttal,
       -- QUEUE WORK IS ITS OWN ANSWER TO "SHOULD THIS HAVE PAIRED", not a third guess.
       --
       -- A reading has compute telemetry and no exchange, so it lands in this population by
       -- definition - and without this column it reads as "could never pair", the same sentence
       -- used for a genuine answer the marker rule excluded. Those want opposite responses, so the
       -- turn that SAID what it is gets to say it here too.
       -- The COLUMN first, then the JSON (migration 042): the column is the archival fold of
       -- whichever carrier the turn had, and the JSON is what every row written before it has.
       COALESCE(upd.turn_kind, m.turn_kind,
                upd.metadata->>'turnKind', m.metadata->>'turnKind') AS turn_kind,
       -- WHETHER THE TURN NAMED A TARGET AT ALL. A row that declared one and still has no exchange
       -- is a pairing failure with the guesswork removed; a row that declared none is still being
       -- paired by inference, and its absence says less.
       (d.target IS NOT NULL) AS declared_target,
       -- AND WHETHER THE TURN IT NAMED WAS ANSWERED ANYWAY, which is the difference between a second
       -- message and a lost one. NULL where nothing was declared: the question does not apply, and a
       -- literal false there would read as "its turn went unanswered" on every welcome and reading.
       tp.target_paired,
       COUNT(*) AS unpaired_count
     FROM messages m
     -- The intent is folded from the UPDATE row, exactly as the exchange builder reads it: a
     -- placeholder is created before the turn knows what it was, so the CREATE row's metadata is
     -- the wrong place to ask and would report every row as 'unknown'.
     ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
     -- The declaration resolved ONCE, so the two columns that read it cannot disagree about what this
     -- row declared. The COLUMN first, then the JSON (migration 042), exactly as turn_kind above.
     LEFT JOIN LATERAL (
       SELECT COALESCE(upd.answers_message_id, m.answers_message_id,
                       upd.metadata->>'answersMessageId', m.metadata->>'answersMessageId') AS target
     ) d ON TRUE
     -- ── WAS THE TURN THIS ROW NAMED ANSWERED BY THIS RESPONDER? ──────────────────────────────────
     --
     -- EXISTS rather than a join, because one user message can hold several exchanges (a duel) and a
     -- join would emit this bot message once per one of them, multiplying unpaired_count by however
     -- many replies the turn happened to attract. Existence is the whole question here.
     --
     -- THE SAME RESPONDER, not any responder. A duel's two sides answer one message as two bot
     -- identities, so "somebody answered it" would let a rival's reply stand in for this one's.
     LEFT JOIN LATERAL (
       SELECT CASE WHEN d.target IS NULL THEN NULL ELSE EXISTS (
         SELECT 1
           FROM messages tgt
           JOIN exchanges tex ON tex.user_message_id = tgt.id
           JOIN messages tam ON tam.id = tex.agent_message_id
          WHERE tgt.channel_arn = m.channel_arn
            AND tgt.message_id = d.target
            AND tgt.event_type = 'CREATE_CHANNEL_MESSAGE'
            AND tam.sender_arn = m.sender_arn
       ) END AS target_paired
     ) tp ON TRUE
     -- THE SAME EXCHANGE latency_metrics TAKES (ex.queued_as IS NULL). A drain's reading that folds
     -- queued messages holds only queued_as = 'folded' exchanges, so without this it counted as paired
     -- here and unpaired there, and the two unpaired figures disagreed on every queue day.
     LEFT JOIN exchanges e ON e.agent_message_id = m.id AND e.queued_as IS NULL
     WHERE m.is_bot = true
       AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
       -- The same population latency_metrics.assistant_turn_count counts, so the two unpaired figures
       -- are one number: with e.id IS NULL the predicate is "ran a model, or carries a correlation marker".
       AND ${ASSISTANT_TURN_SQL}
       AND m.created_at >= lower($1::tstzrange) AND m.created_at < upper($1::tstzrange)
       AND e.id IS NULL
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
     ORDER BY unpaired_count DESC`,
    [win.range]
  );
  return success({ data: result.rows });
}

/**
 * THE TURNS THAT ARE NOT ANSWERS, COUNTED AS THEMSELVES RATHER THAN MISSING FROM EVERYTHING.
 *
 * Owner direction, 2026-09-11: "Drift can be excluded from normal responses, but should still be
 * tracked in analytics and filterable / separately viewable like readings."
 *
 * CHECKING THAT PRECEDENT FOUND IT DID NOT EXIST. A reading was excluded and diagnosable, which is
 * not the same as tracked and viewable: `turn_kind` was a JSON extraction, exactly one query
 * surfaced it (the `unpaired_bot_messages` diagnostic), and nothing in the console mentioned it. So
 * the work is not "do for drift what was done for readings" - it is "build the viewable half, for
 * both kinds at once", which is the right order anyway because a drift-only surface would be a
 * second thing to generalize later.
 *
 * ── WHAT EACH COLUMN IS FOR ─────────────────────────────────────────────────────────────────────
 *
 * `turn_kind` publishes the POPULATION, which is the whole point. A count that does not say what it
 * counts is read as whatever the reader had in mind. Every row here
 * names its kind, and `answer` is a value like any other rather than an unlabelled remainder.
 *
 * `exchange_count` on a declared kind should be ZERO, and a non-zero is a finding rather than a
 * curiosity: it means something paired a turn that said it was not an answer.
 *
 * `avg_reply_ms` is measured from the message the turn NAMED, not from an exchange - because a
 * declared kind has no exchange by design. It is the number the exclusion exists to keep out of the
 * answer average: a drift suggestion answers fast and deliberately does not do the work, so counted
 * as an answer it drags every latency figure down while representing a turn that answered nothing.
 * Here it is visible without being mixed in.
 *
 * Aurora-only, and read-only: it answers a question about the projection using the projection.
 */
async function getTurnKinds(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 180);
  const result = await query(
    `SELECT
       DATE(m.created_at) AS date,
       -- ABSENCE IS A VALUE HERE, AND IT IS NAMED. An ordinary answer declares no kind, so leaving
       -- it NULL would render the largest population as a blank row - the same "unlabelled
       -- remainder" that lets a count mean something other than its name.
       -- A HANDOVER is its own kind: an assistant message that is not an answer (handoverSql).
       CASE WHEN ${handoverSql('m')} THEN 'handover' ELSE COALESCE(d.kind, 'answer') END AS turn_kind,
       COUNT(*) AS message_count,
       COUNT(*) FILTER (WHERE d.target IS NOT NULL) AS declared_target_count,
       -- Should be 0 on every declared kind. A non-zero row is a pairing that ignored a declaration.
       COUNT(e.id) AS exchange_count,
       -- From the message the turn NAMED, because a declared kind has no exchange to measure from.
       ROUND(AVG(EXTRACT(EPOCH FROM (m.created_at - tgt.created_at)) * 1000)
             FILTER (WHERE tgt.created_at IS NOT NULL AND m.created_at >= tgt.created_at))
         AS avg_reply_ms,
       COUNT(*) FILTER (WHERE tgt.id IS NOT NULL) AS reply_measured_count
     FROM messages m
     -- The declaration is folded from the UPDATE row first, exactly as the exchange builder reads
     -- it: a placeholder is created before the turn knows what it was.
     ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
     -- The COLUMN first, then the JSON (migration 042), resolved once so the three readers below
     -- cannot disagree about what this row declared.
     LEFT JOIN LATERAL (
       SELECT
         -- A QUEUE NOTICE THAT REACHED A FINAL ANSWER IS THE ANSWER. A notice never declares itself
         -- final, so a final on a message whose first update declared queue_ack is the answer written
         -- into the notice when it could not be posted at the end (async-processor-core.ts).
         -- Unless another message declares the same answer: then the answer moved and this notice was
         -- closed out as its receipt (noticeClosedAsReceiptSql).
         CASE WHEN COALESCE(upd.turn_kind, m.turn_kind, upd.metadata->>'turnKind', m.metadata->>'turnKind') = 'queue_ack'
                   AND m.agent_final_at IS NOT NULL AND ${noticeClosedAsReceiptSql('m')} THEN 'receipt'
              WHEN COALESCE(upd.turn_kind, m.turn_kind, upd.metadata->>'turnKind', m.metadata->>'turnKind') = 'queue_ack'
                   AND m.agent_final_at IS NOT NULL THEN NULL
              ELSE COALESCE(upd.turn_kind, m.turn_kind,
                  upd.metadata->>'turnKind', m.metadata->>'turnKind') END AS kind,
         COALESCE(upd.answers_message_id, m.answers_message_id,
                  upd.metadata->>'answersMessageId', m.metadata->>'answersMessageId') AS target
     ) d ON true
     -- LATERAL + LIMIT 1, not a plain LEFT JOIN. exchanges is unique on the (user, agent) PAIR
     -- (migration 017), so one agent message can legitimately appear in more than one exchange row,
     -- and a plain join emits that bot message once PER ROW - inflating message_count and
     -- declared_target_count, double-weighting the message in avg_reply_ms, and making
     -- exchange_count read as several pairings where there is one. Migrations 019, 026, 027 and 031
     -- all carry this note over this same table; this query did not, and these are the counts an
     -- operator reads to decide whether a declaration was honoured.
     --
     -- Existence is the whole question here - the column is checked for zero versus non-zero - so one
     -- row is not a sample of the exchanges, it is the answer.
     LEFT JOIN LATERAL (
       SELECT ex.id, ex.assistant, ex.conversation_classification
         FROM exchanges ex
        WHERE ex.agent_message_id = m.id
        LIMIT 1
     ) e ON true
     LEFT JOIN messages tgt
       ON tgt.channel_arn = m.channel_arn
      AND tgt.message_id = d.target
      AND tgt.event_type = 'CREATE_CHANNEL_MESSAGE'
     WHERE m.is_bot = true
       AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
       AND m.created_at >= lower($1::tstzrange) AND m.created_at < upper($1::tstzrange)
       -- One assistant's turns, on a team route: a bot message no exchange claims is not attributable
       -- to an assistant, so a team never counts it.
       AND ($2::text IS NULL OR e.assistant = $2)
       AND ($3::text[] IS NULL OR e.conversation_classification = ANY($3))
     GROUP BY 1, 2
     ORDER BY date DESC, turn_kind`,
    [win.range, params.agentType ?? null, teamClassificationsOf(params)]
  );
  return success({ data: result.rows });
}

/**
 * HANDOVERS: how often one assistant passed a person's message to another, and how often the other answered.
 *
 * Read from the archive (tenet D7), not from a metric emitted beside it: a handover is a stored message, so
 * the record already holds every one. SENT is each handover message (`handoverSql`), by day, receiver and
 * kind (`capability` - a question the receiver advertises; `task` - an answer to work it owns). ANSWERED
 * is a sent handover whose receiver started a turn of interaction kind `handover` in the same
 * conversation within ten minutes, from the turn ledger (`v_turn_latency`). The gap is the handovers the
 * flow or the receiver refused, or that nothing delivered - a rising gap is a misroute or an outage, and is
 * the number to watch.
 *
 * NOT HERE: a primary that refused to choose between two roommates and asked the person, or found no owner.
 * Those are not handovers - no message is posted - and are **NOT BUILT** as a count.
 */
async function getHandovers(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 90);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(h.created_at), 'YYYY-MM-DD') AS date,
       COALESCE(${botIdSql('h.targeted_to')}, 'unknown') AS receiver,
       COALESCE(h.metadata->'aeHandover'->>'kind', 'unknown') AS kind,
       COUNT(*) AS sent_count,
       COUNT(*) FILTER (WHERE a.answered_at IS NOT NULL) AS answered_count,
       COUNT(*) FILTER (WHERE a.answered_at IS NULL) AS unanswered_count,
       -- From the handover posting to the receiver's first frame: the cost of the extra hop.
       ROUND(AVG(EXTRACT(EPOCH FROM (a.answered_at - h.created_at)) * 1000)
             FILTER (WHERE a.answered_at IS NOT NULL)) AS avg_handover_to_answer_ms
     FROM messages h
     LEFT JOIN LATERAL (
       SELECT t.t2_placeholder_at AS answered_at
         FROM v_turn_latency t
        WHERE t.channel_arn = h.channel_arn
          AND t.trigger_kind = 'handover'
          AND t.responder = h.targeted_to
          AND t.t2_placeholder_at >= h.created_at
          AND t.t2_placeholder_at < h.created_at + INTERVAL '10 minutes'
        ORDER BY t.t2_placeholder_at
        LIMIT 1
     ) a ON true
     WHERE h.event_type = 'CREATE_CHANNEL_MESSAGE'
       AND ${handoverSql('h')}
       AND h.created_at >= lower($1::tstzrange) AND h.created_at < upper($1::tstzrange)
     GROUP BY 1, 2, 3
     ORDER BY date DESC, sent_count DESC`,
    [win.range],
  );
  return success({
    data: result.rows,
    columns: ['date', 'receiver', 'kind', 'sent_count', 'answered_count', 'unanswered_count', 'avg_handover_to_answer_ms'],
  });
}

/**
 * GET /analytics/drift - Drift detection events
 */
/**
 * A DRIFT EVENT IS THE ASSISTANT'S THAT ANSWERED THE MESSAGE IT WAS DETECTED ON. Drift is detected on a
 * person's message, and the row records that message, not an assistant; it is attributed at read time
 * through the exchange that message opened. A drift on a message no assistant answered, or one recorded
 * before the message id was, is attributable to nobody, and a team route never sees it.
 */
const DRIFT_BY_ASSISTANT = (alias: string, nAgent: number, nClass: number) => `($${nAgent}::text IS NULL OR EXISTS (
         SELECT 1 FROM messages dm
           JOIN exchanges de ON de.user_message_id = dm.id
          WHERE dm.message_id = ${alias}.originating_message_id
            AND dm.channel_arn = ${alias}.parent_channel_arn
            AND de.assistant = $${nAgent}
            AND ($${nClass}::text[] IS NULL OR de.conversation_classification = ANY($${nClass}))))`;

/** The classifications a team route bound this query to, or null for an admin (no body can set it). */
function teamClassificationsOf(params: Record<string, string | undefined>): string[] | null {
  const c = (params as Record<string, unknown>).conversationClassifications;
  return Array.isArray(c) ? (c as string[]) : null;
}

/**
 * SUBJECTS THE ASSISTANTS DO NOT SERVE BY INTENT: the `general` and `off_topic` turns of
 * the window, counted against the subjects of the conversation each happened in, so a subject that keeps
 * drawing unserved turns stands out as a candidate for a new intent.
 *
 * Read from what is already recorded, nothing new on a turn: an answered turn is an `exchanges` row with its
 * intent, and a turn that drew a drift offer, which is never an exchange, is its `drift_events` row. The
 * subjects are the conversation's latest summary's `topics`. A turn counts toward every subject of its
 * conversation, so this ranks subjects by the unserved traffic around them rather than attributing each turn
 * to exactly one; `turns` is per subject, never a total.
 */
async function getUnservedSubjects(
  params: Record<string, string | undefined>,
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30);
  const limit = Math.min(parseInt(params.limit || '25', 10), 100);
  const result = await query(
    `WITH turns AS (
       SELECT e.channel_arn, e.intent
         FROM exchanges e
        WHERE e.intent IN ('general', 'off_topic')
          AND e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
       UNION ALL
       SELECT d.parent_channel_arn, lower(d.intent)
         FROM drift_events d
        WHERE COALESCE(d.source, 'live') = 'live'
          AND lower(d.intent) IN ('general', 'off_topic')
          AND d.occurred_at >= lower($1::tstzrange) AND d.occurred_at < upper($1::tstzrange)
     ),
     latest AS (
       SELECT DISTINCT ON (channel_arn) channel_arn, topics
         FROM conversation_summaries
        ORDER BY channel_arn, version DESC
     )
     SELECT lower(trim(topic)) AS subject,
            t.intent,
            COUNT(*) AS turns,
            COUNT(DISTINCT t.channel_arn) AS conversations
       FROM turns t
       JOIN latest l ON l.channel_arn = t.channel_arn
       CROSS JOIN LATERAL unnest(l.topics) AS topic
      WHERE trim(topic) <> ''
      GROUP BY 1, 2
      ORDER BY turns DESC, conversations DESC
      LIMIT $2`,
    [win.range, limit],
  );
  return success({ data: result.rows });
}

async function getDriftEvents(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
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
       d.person_id,
       d.originating_message_id,
       d.signal_disagreement,
       d.created_via_explicit_intent
     FROM drift_events d
     WHERE d.occurred_at >= lower($1::tstzrange) AND d.occurred_at < upper($1::tstzrange)${outcomeFilter}
       AND ${DRIFT_BY_ASSISTANT('d', 3, 4)}
     ORDER BY d.occurred_at DESC
     LIMIT $2`,
    [win.range, limit, params.agentType ?? null, teamClassificationsOf(params)]
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
       -- FILTERED TO live, like every count beside it. Unfiltered, this averaged over archival rows
       -- (processDriftDetection writes source='archival' in Aurora mode) and pre-migration-016 rows
       -- as well, so the console showed a small live total_events next to a mean drawn from hundreds
       -- of other events - the mismatched-population reading the filters above exist to prevent.
       ROUND(AVG(cosine_distance) FILTER (WHERE source = 'live')::numeric, 4) AS avg_drift_score,
       COUNT(*) FILTER (WHERE source = 'live' AND outcome = 'accepted') AS accepted_count,
       COUNT(*) FILTER (WHERE source = 'live' AND outcome IS NULL) AS pending_count,
       COUNT(*) FILTER (WHERE source = 'live' AND evaluated_at IS NOT NULL) AS evaluated_count,
       COUNT(*) FILTER (WHERE source = 'live' AND evaluated_correct IS TRUE) AS evaluated_correct_count
     FROM drift_events d
     WHERE occurred_at >= lower($1::tstzrange) AND occurred_at < upper($1::tstzrange)
       AND ${DRIFT_BY_ASSISTANT('d', 2, 3)}`,
    [win.range, params.agentType ?? null, teamClassificationsOf(params)]
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
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT COALESCE(e.intent, 'unknown') AS intent, COUNT(*) AS count
     FROM exchanges e
     WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
     GROUP BY COALESCE(e.intent, 'unknown')
     ORDER BY count DESC`,
    [win.range]
  );
  return success({ data: result.rows });
}

/** Per-tier message activity from the conversation rollup. */
async function getUserActivity(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT
       -- The conversation's classification; the deprecated user_type held the same value on a
       -- conversation archived before migration 050.
       COALESCE(c.conversation_classification, c.user_type) AS classification,
       COALESCE(SUM(c.message_count), 0) AS messages,
       COUNT(DISTINCT DATE(c.last_message_at)) AS active_days
     FROM conversations c
     WHERE c.last_message_at >= lower($1::tstzrange) AND c.last_message_at < upper($1::tstzrange)
     GROUP BY COALESCE(c.conversation_classification, c.user_type)
     ORDER BY messages DESC`,
    [win.range]
  );
  return success({ data: result.rows });
}

/** Session DAU (auth-resolved at least once/day), from client_events. */
async function getActiveUsersDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       event_data->>'user_tier' AS user_tier,
       COUNT(DISTINCT person_id) AS active_users
     FROM client_events
     WHERE event_type = 'session_started'
       AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [win.range]
  );
  return success({ data: result.rows });
}

/** Engaged-messaging DAU (connected / sent / listed), from client_events. */
async function getActiveMessagingUsersDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       event_data->>'user_tier' AS user_tier,
       COUNT(DISTINCT person_id) AS active_messaging_users
     FROM client_events
     WHERE event_type IN ('websocket_connected', 'message_sent', 'channel_messages_listed')
       AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [win.range]
  );
  return success({ data: result.rows });
}

/** Per-user message leaderboard from message_sent client events. */
async function getMessagesPerUser(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT
       person_id,
       event_data->>'user_tier' AS user_tier,
       COUNT(*) AS message_count
     FROM client_events
     WHERE event_type = 'message_sent'
       AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     GROUP BY person_id, event_data->>'user_tier'
     ORDER BY message_count DESC`,
    [win.range]
  );
  return success({ data: result.rows });
}

/** Per-tier daily message counts from message_sent client events. */
async function getMessagesPerTierDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       event_data->>'user_tier' AS user_tier,
       COUNT(*) AS message_count
     FROM client_events
     WHERE event_type = 'message_sent'
       AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [win.range]
  );
  return success({ data: result.rows });
}

/** Daily error count + total events (denominator is all events). */
async function getErrorRateDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) AS error_count,
       COUNT(*) AS total_events
     FROM client_events
     WHERE created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     GROUP BY 1
     ORDER BY 1`,
    [win.range]
  );
  return success({ data: result.rows });
}

/**
 * A SESSION-ORDERED FUNNEL (`lib/session-funnels.ts`): each step counted among the sessions that recorded
 * the entry step at or before it, so every step is a subset of the entry step and a conversion read off it
 * stays within 100% by construction. A session that recorded a step with no entry step before it is
 * returned apart as `sessions_outside_funnel`. The Athena mode answers the same columns from the same steps.
 */
async function getFunnelConversion(
  funnel: SessionFunnel,
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const result = await query(
    `WITH ev AS (
       SELECT session_id, event_type, created_at
       FROM client_events
       WHERE event_type = ANY($2::text[])
         AND session_id IS NOT NULL
         AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     ),
     entered AS (
       SELECT session_id, MIN(created_at) AS entered_at
       FROM ev
       WHERE event_type = $3
       GROUP BY session_id
     )
     SELECT
       ev.event_type AS step,
       COUNT(*) FILTER (WHERE ev.created_at >= entered.entered_at) AS event_count,
       COUNT(DISTINCT ev.session_id) FILTER (WHERE ev.created_at >= entered.entered_at) AS session_count,
       COUNT(DISTINCT ev.session_id)
         - COUNT(DISTINCT ev.session_id) FILTER (WHERE ev.created_at >= entered.entered_at) AS sessions_outside_funnel
     FROM ev
     LEFT JOIN entered ON entered.session_id = ev.session_id
     GROUP BY ev.event_type
     ORDER BY array_position($2::text[], ev.event_type)`,
    [win.range, [...funnel.steps], funnel.entryStep]
  );
  return success({ data: result.rows });
}

async function getSignupFunnel(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  return getFunnelConversion(SIGNUP_FUNNEL, params);
}

/**
 * THE GUEST-TO-CUSTOMER FUNNEL (B12): per recorded stage, the distinct journeys that reached it. A journey is
 * the visitor's conversation, carried on every stage, so path B is joined by conversation and never by an
 * address. The same figure the Athena mode answers, from the same events.
 */
async function getGuestToCustomerFunnel(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30);
  // ONE JOURNEY, when asked: its stages, each counted, so one upgrade reads as one row per stage. A journey
  // is a channel id, and anything else is refused rather than matched.
  const journey = params.journey;
  if (journey !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(journey)) return error(400, 'journey is a conversation id');
  const result = await query(
    `SELECT
       event_type AS step,
       COUNT(DISTINCT event_data->'properties'->>'journey') AS journeys,
       COUNT(*) AS event_count
     FROM client_events
     WHERE event_type = ANY($2::text[])
       AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
       AND ($3::text IS NULL OR event_data->'properties'->>'journey' = $3::text)
     GROUP BY event_type`,
    [win.range, [...RECORDED_FUNNEL_STAGES], journey ?? null]
  );
  return success({ data: result.rows });
}

/** Guest starts refused, by the reason code the widget was shown (B12, L16). */
async function getGuestRefusals(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30);
  const result = await query(
    `SELECT
       event_data->'properties'->>'reason' AS reason,
       COUNT(*) AS refusals
     FROM client_events
     WHERE event_type = 'guest_refused'
       AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     GROUP BY 1
     ORDER BY 2 DESC`,
    [win.range]
  );
  return success({ data: result.rows });
}

async function getSigninFunnel(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  return getFunnelConversion(SIGNIN_FUNNEL, params);
}

/** Web-vital / timer percentiles from performance client events. */
async function getPageLoadMetrics(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
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
       AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     GROUP BY event_type
     ORDER BY event_type`,
    [win.range]
  );
  return success({ data: result.rows });
}

/** WebSocket lifecycle counts per day (reconnect spikes = instability). */
async function getConnectionHealthDaily(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7);
  const result = await query(
    `SELECT
       TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
       SUM(CASE WHEN event_type = 'websocket_connected' THEN 1 ELSE 0 END) AS connected,
       SUM(CASE WHEN event_type = 'websocket_disconnected' THEN 1 ELSE 0 END) AS disconnected,
       SUM(CASE WHEN event_type = 'websocket_reconnected' THEN 1 ELSE 0 END) AS reconnected
     FROM client_events
     WHERE event_type IN ('websocket_connected', 'websocket_disconnected', 'websocket_reconnected')
       AND created_at >= lower($1::tstzrange) AND created_at < upper($1::tstzrange)
     GROUP BY 1
     ORDER BY 1`,
    [win.range]
  );
  return success({ data: result.rows });
}

/**
 * GET /analytics/context?personId=X - Cross-conversation context for a user
 *
 * THE ROWS CARRY NO MESSAGE TEXT (migration 068). `cross_conversation_context` used to store the
 * first 100 characters of a person's message as `topic` and the first 500 as `summary`; those columns
 * are dropped, and a row now records that the person has a conversation, its classification, and the
 * id of the message that last touched it. What this endpoint still serves as `summary` and `topics`
 * is the conversation's own summary, read from `conversation_summaries` at request time - so a
 * redaction or a rewrite is reflected the moment it lands rather than leaving a stale copy behind.
 *
 * IT STILL SERVES CONTENT, SO IT IS STILL NOT IN THE AGGREGATE BUNDLE. Unlisted queryTypes default to
 * `view-analytics`, whose rule is that its reads carry labels and counts and never message content.
 * This one was never listed, so it inherited that bundle by omission - the accountability gap
 * `view-messages` is exchange-vended to prevent, on a different plane. It requires `view-events`
 * (`lib/admin-capability-map.ts`), which is the content capability in this map, and joining a
 * model-written summary instead of a sliced message does not change that.
 *
 * ── IT READS ONCE PER CLASSIFICATION, AND THAT IS NOT AN OPTIMIZATION FAILURE ────────────────────
 *
 * The table is bounded under ADR-028 as of 068: FORCE ROW LEVEL SECURITY, and the read policy matches
 * a row only when its classification is in the CURRENT ROLE's ladder. The runtime login role has no
 * ladder, so this query issued the ordinary way returns zero rows - and would do so silently, which
 * is the failure mode worth spending a few round trips to avoid. So it runs under each declared
 * classification's reader role and merges, deduplicating by channel: an operator legitimately crosses
 * classifications under the audited-admin model, and `view-events` is what gates them, but the
 * crossing is now made of explicit per-classification reads rather than of one unbounded one.
 *
 * SCOPED BY `person_id` ALONE, which is correct HERE and not elsewhere. The in-conversation read is a
 * different question and is scoped by membership instead: see `findRelatedConversations`, which
 * cannot run without the assistant-and-humans intersection.
 */
async function getConversationContext(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const personId = params.personId;
  if (!personId) {
    return error(400, 'personId parameter is required');
  }

  const limit = Math.min(parseInt(params.limit || '10', 10), 50);

  const sql = `SELECT
       ccc.channel_arn,
       ccc.classification,
       ccc.last_message_id,
       cs.summary,
       cs.topics,
       ccc.relevance_score,
       ccc.updated_at AS last_activity,
       c.message_count,
       c.assistant,
       cs.purpose
     FROM cross_conversation_context ccc
     LEFT JOIN conversations c ON c.channel_arn = ccc.channel_arn
     LEFT JOIN conversation_summaries cs ON cs.channel_arn = ccc.channel_arn
       AND cs.version = (
         SELECT MAX(version) FROM conversation_summaries
         WHERE channel_arn = ccc.channel_arn
       )
     WHERE ccc.person_id = $1
     ORDER BY ccc.updated_at DESC
     LIMIT $2`;

  const perClassification = await Promise.all(
    defaultProfileRegistry.classificationValues().map(async (classification) => {
      try {
        const r = await withReaderRole(classification, (client) =>
          client.query<Record<string, unknown>>(sql, [personId, limit]));
        return r.rows;
      } catch (err) {
        // One classification's role failing must not turn the whole answer into an empty one that
        // looks like "this person has no other conversations". Name it and carry on with the rest.
        console.warn('[ConversationContext] could not read as one classification', {
          classification, err: (err as { name?: string })?.name,
        });
        return [] as Record<string, unknown>[];
      }
    }),
  );

  // A reader role's ladder can hold several classifications, so the same row comes back under more
  // than one role. Deduplicate on the channel, which is what the caller is looking at.
  const byChannel = new Map<string, Record<string, unknown>>();
  for (const row of perClassification.flat()) {
    const key = String(row.channel_arn ?? '');
    if (key && !byChannel.has(key)) byChannel.set(key, row);
  }
  const rows = [...byChannel.values()]
    .sort((a, b) => String(b.last_activity ?? '').localeCompare(String(a.last_activity ?? '')))
    .slice(0, limit);

  return success({
    personId,
    contexts: rows,
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
    // `anchor_source` (031) travels with the numbers it explains. A row whose ttff/e2e are NULL is
    // either a turn nothing anchored or a genuinely system-triggered response, and those are different
    // findings - without this column the reader cannot tell them apart and reads a measurement gap as
    // a latency one.
    `SELECT v.turn_id, v.response_id, v.channel_arn, v.turn_id_source, v.anchor_source, v.trigger_kind,
            v.battle_round, v.responder,
            v.t0_user_at, v.t2_placeholder_at, v.t3_final_at,
            v.ttff_ms, v.ack_ms, v.ack_source, v.e2e_ms, v.answer_ms, v.unattributed_ms, v.overhead_ms,
            v.status, v.progress_update_count, v.task_id,
            -- HOW THE TURN ENTERED (migration 054), joined here rather than appended to the view.
            -- v_turn_latency has been redefined ten times and its append-only column contract has held
            -- every time; the cheapest way to keep holding it is not to touch it. This is the one
            -- reader that reads the view alone, and the join it needs is the same one the view already
            -- makes internally, so the column costs a join here instead of a redefinition there.
            COALESCE(m.turn_entry, 'unknown') AS turn_entry
       FROM v_turn_latency v
       LEFT JOIN messages m
         ON m.message_id = v.response_id
        AND m.channel_arn = v.channel_arn
        AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
      WHERE v.channel_arn = $1
      ORDER BY v.t0_user_at DESC NULLS LAST
      LIMIT $2`,
    [channelArn, limit],
  );
  return success({
    data: result.rows,
    columns: [
      'turn_id', 'response_id', 'channel_arn', 'turn_id_source', 'anchor_source', 'trigger_kind',
      'battle_round', 'responder', 't0_user_at', 't2_placeholder_at', 't3_final_at',
      // `ack_ms` beside `ttff_ms` rather than instead of it (G13): on a user turn they are the same
      // two instants, and on a proactive one only ack_ms exists. Seeing both is what makes the
      // difference legible instead of looking like two competing latencies.
      'ttff_ms', 'ack_ms', 'ack_source', 'e2e_ms', 'answer_ms', 'unattributed_ms', 'overhead_ms',
      'status', 'progress_update_count', 'task_id',
      // Appended, like every column before it, so LatencyTab and TurnLatencyAudit read by name and
      // are unaffected by the addition.
      'turn_entry',
    ],
  });
}

/**
 * HOW FAR APART TWO FIGURES FOR ONE TURN MAY BE AND STILL AGREE, in milliseconds.
 *
 * Both paths subtract the SAME Amazon Chime SDK instants: the ledger's `placeholder_posted` is the
 * placeholder's CreatedTimestamp, which is `messages.created_at`; its `final_response` is the update's
 * LastUpdatedTimestamp, which is what `agent_final_at` is folded from. Both store the difference as an
 * integer, one by an implicit assignment cast and one by `::integer`. So on a turn both paths measured
 * the expected difference is ZERO, and the only legitimate non-zero is one millisecond of rounding
 * between those two casts.
 *
 * Anything wider is not noise. It means the two paths picked a DIFFERENT instant - a user message the
 * ledger bound to another turn, a second final stamp, a placeholder archived twice - which is exactly
 * the defect class the diff exists to find. It found none on the day the read was swapped onto the
 * ledger, and it is the thing that would find one afterwards. A tolerance of a few hundred
 * milliseconds would read those as agreement.
 */
export const SHADOW_DIFF_TOLERANCE_MS = 1;

/** The per-turn columns of `turn_latency_shadow_diff`, in the order they are returned. */
const SHADOW_DIFF_COLUMNS = [
  'response_id', 'channel_arn', 'turn_id', 'exchange_id', 'placeholder_at', 'assistant',
  'paired_by', 'anchor_source', 'trigger_kind',
  'derived_ttff_ms', 'ledger_ttff_ms', 'ttff_diff_ms',
  'derived_e2e_ms', 'ledger_e2e_ms', 'e2e_diff_ms',
  'classification', 'disagreed_on',
];

/** The summary fields, read off the first row and returned beside `data`. */
const SHADOW_DIFF_SUMMARY_FIELDS = [
  'compared_count', 'agree_count', 'disagree_count', 'derived_only_count', 'ledger_only_count',
  'ttff_diff_sample_count', 'p50_abs_ttff_diff_ms', 'p95_abs_ttff_diff_ms', 'max_abs_ttff_diff_ms',
  'e2e_diff_sample_count', 'p50_abs_e2e_diff_ms', 'p95_abs_e2e_diff_ms', 'max_abs_e2e_diff_ms',
  'exchange_anchored_count',
];

/**
 * THE LEDGER AND THE DERIVED PATH, PER TURN, SIDE BY SIDE.
 *
 * THE LEDGER IS AUTHORITATIVE. `getLatencyMetrics` reads the Latency tab's TTFF and E2E from
 * `v_turn_latency` (the ledger repoint); `exchanges.response_latency_ms` and `exchanges.e2e_ms` are the
 * second opinion. This comparison is KEPT rather than retired with the rollout: two derivations of one
 * number that were watched into agreement once can come apart again, and the day they do the only
 * thing that says so is a per-turn diff. It changes no figure anywhere.
 *
 * `derived_ttff_ms` and `derived_e2e_ms` are therefore the side the tab no longer uses, and
 * `ledger_ttff_ms` / `ledger_e2e_ms` are the side it does. The column names are kept as they were so a
 * saved query and the panel's own columns still line up; the panel states which side is authoritative
 * in its own text rather than leaving it to a naming convention.
 *
 * THE PAIRING: a ledger response is the placeholder whose MessageId and channel it carries, and that
 * placeholder's derived figures are on the exchange whose `agent_message_id` is its row. Nothing else is
 * shared by both sides. The exchange is taken through an ordered LATERAL, because one agent message can
 * sit in more than one exchange and a plain join would count it once per row.
 *
 * THE LATERAL CARRIES THE SAME `queued_as IS NULL` PREDICATE `v_turn_latency` ANCHORS ON (052), and
 * that is what makes the comparison mean anything. A folded answer carries one exchange per queued
 * message it rolled in, all on that same message, and a queued row's `response_latency_ms` is the
 * person's whole wait with the queue inside it. Unmatched, the derived side could take one of those
 * while the ledger took the turn's own exchange: two different spans, so every folded turn would class
 * `disagree` for a reason that is not a defect. A known, explained, systematic disagreement class still
 * drowns the signal this query exists to carry, and "read that one as expected" is a rule every future
 * reader has to remember. Comparing like for like is what makes a residual disagreement mean something.
 *
 * WHAT MATCHING GIVES UP, weighed and accepted. An unmatched predicate would have been the only thing
 * that surfaced a MIS-LABELED `queued_as` - a row wrongly marked, or wrongly not - because the two
 * sides would then disagree about it. That question is real and it is deliberately NOT watched here: it
 * belongs to the queued-exchange surface, not to a latency comparison (tenet D7, one source per
 * question). Where it would be checked: `v_queued_exchange` against `messages.answered_queued`, since
 * the label is folded at archival from the turn's own declaration and the two must agree row for row.
 *
 * A FOLDED ANSWER WITH NO UNLABELED EXCHANGE now falls out of `derived` entirely rather than pairing to
 * a queued row, so it classes `ledger_only` instead of `disagree`. That is the honest reading: the
 * derived path never paired the turn itself, which is exactly what `ledger_only` says.
 * See LATENCY-TARGETS.md, "The shadow diff".
 *
 * `compareLatencyDerivations` (turn-events-backfill.ts) is the backfill's go/no-go and a COARSER check
 * than this one, not the same pairing: a plain join with no ordering and no LIMIT 1, no `queued_as`
 * predicate, and `e2e_ms` alone. Its counts are not evidence about the pairing below.
 *
 * EACH TURN IS CLASSIFIED ONCE:
 *   agree         both paths measured it, and every figure present on one side is present on the
 *                 other and within SHADOW_DIFF_TOLERANCE_MS
 *   disagree      both measured it, and a figure differs or exists on only one side (the backfill's one
 *                 disagreement was that shape: ledger e2e 3315, derived NULL)
 *   derived_only  only the derived path has a figure - a turn the ledger did not record or could not
 *                 anchor, so the tab reports no TTFF for it (`ttff_ledger_unmeasured_count` counts it)
 *   ledger_only   only the ledger has one - a turn the derived path never paired, which the tab reports
 * A turn neither path has a figure for is not a measurement on either side and is not counted.
 *
 * `anchor_source = 'exchange'` IS WEAKER AGREEMENT, and is counted as such. Where the ledger holds no
 * `user_message` for a turn, `v_turn_latency` falls back to the exchange's user instant, so both TTFFs
 * then share their start and only the placeholder instant is independent. It is also the only door
 * through which a swept pairing can still reach the tab's TTFF, which is why `getLatencyMetrics` asks
 * `anchor_source` before it trusts a ledger figure.
 *
 * `paired_by` travels with the row because the tab's TTFF average excludes swept pairings: a disagreeing
 * swept row is a reconstruction the headline already ignores, not a regression in it.
 *
 * ONE STATEMENT, summary and detail together, so the counts and the rows come from one snapshot of the
 * ledger. The summary rides every row (and a single row with no detail when every turn agreed).
 */
async function getTurnLatencyShadowDiff(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 90);
  const limit = Math.min(Math.max(parseInt(params.limit || '200', 10) || 200, 1), 500);
  const result = await query(
    `WITH derived AS (
       -- The derived path's own figures, for every placeholder it paired in the window.
       SELECT m.message_id              AS response_id,
              m.channel_arn::text       AS channel_arn,
              m.created_at              AS placeholder_at,
              m.assistant,
              e.id                      AS exchange_id,
              e.paired_by,
              e.response_latency_ms     AS derived_ttff_ms,
              e.e2e_ms                  AS derived_e2e_ms
         FROM messages m
         JOIN LATERAL (
           SELECT ex.id, ex.paired_by, ex.response_latency_ms, ex.e2e_ms
             FROM exchanges ex
            WHERE ex.agent_message_id = m.id
              -- THE SAME PREDICATE v_turn_latency ANCHORS ON (052), so the two sides pair like for
              -- like. A folded answer carries one exchange per queued message it rolled in, on this
              -- same message, and a queued row's response_latency_ms is the person's whole wait
              -- INCLUDING the queue. Without this the derived side could take one of those while the
              -- ledger took the turn's own exchange, and every folded turn would class as a
              -- disagreement that means nothing. The queued population is read through
              -- v_queued_exchange; see the header comment.
              AND ex.queued_as IS NULL
            ORDER BY ex.created_at
            LIMIT 1
         ) e ON TRUE
        WHERE m.is_bot = TRUE
          AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
          AND m.created_at >= lower($1::tstzrange) AND m.created_at < upper($1::tstzrange)
     ),
     ledger AS (
       -- The ledger's figures for the same window. The placeholder instant is the one both sides
       -- window on, so a turn at the edge of the range is in both or in neither.
       SELECT v.response_id,
              v.channel_arn,
              v.t2_placeholder_at       AS placeholder_at,
              v.agent_type              AS assistant,  -- the view keeps agent_type until migration 075 step 2
              v.turn_id,
              v.anchor_source,
              v.trigger_kind,
              v.ttff_ms                 AS ledger_ttff_ms,
              v.e2e_ms                  AS ledger_e2e_ms
         FROM v_turn_latency v
        WHERE v.t2_placeholder_at >= lower($1::tstzrange) AND v.t2_placeholder_at < upper($1::tstzrange)
     ),
     joined AS (
       SELECT COALESCE(l.response_id, d.response_id)       AS response_id,
              COALESCE(l.channel_arn, d.channel_arn)       AS channel_arn,
              COALESCE(l.placeholder_at, d.placeholder_at) AS placeholder_at,
              COALESCE(d.assistant, l.assistant)         AS assistant,
              l.turn_id,
              d.exchange_id,
              d.paired_by,
              l.anchor_source,
              l.trigger_kind,
              d.derived_ttff_ms,
              l.ledger_ttff_ms,
              d.derived_e2e_ms,
              l.ledger_e2e_ms
         FROM ledger l
         FULL OUTER JOIN derived d
           ON d.response_id = l.response_id AND d.channel_arn = l.channel_arn
     ),
     classified AS (
       SELECT j.response_id, j.channel_arn, j.placeholder_at, j.assistant, j.turn_id, j.exchange_id,
              j.paired_by, j.anchor_source, j.trigger_kind,
              j.derived_ttff_ms, j.ledger_ttff_ms,
              (j.ledger_ttff_ms - j.derived_ttff_ms) AS ttff_diff_ms,
              j.derived_e2e_ms, j.ledger_e2e_ms,
              (j.ledger_e2e_ms - j.derived_e2e_ms)   AS e2e_diff_ms,
              f.ttff_mismatch,
              f.e2e_mismatch,
              -- ONE CASE, so the four classes are disjoint and exhaustive by construction.
              CASE
                WHEN j.ledger_ttff_ms IS NULL AND j.ledger_e2e_ms IS NULL   THEN 'derived_only'
                WHEN j.derived_ttff_ms IS NULL AND j.derived_e2e_ms IS NULL THEN 'ledger_only'
                WHEN f.ttff_mismatch OR f.e2e_mismatch                     THEN 'disagree'
                ELSE 'agree'
              END AS classification
         FROM joined j
         -- A figure present on one side and absent on the other is a mismatch, not a pass: that is the
         -- shape of the backfill's only disagreement, and AVG would hide it on either path.
         CROSS JOIN LATERAL (
           SELECT ((j.derived_ttff_ms IS NULL) <> (j.ledger_ttff_ms IS NULL)
                   OR COALESCE(ABS(j.ledger_ttff_ms - j.derived_ttff_ms) > $2::integer, FALSE)) AS ttff_mismatch,
                  ((j.derived_e2e_ms IS NULL) <> (j.ledger_e2e_ms IS NULL)
                   OR COALESCE(ABS(j.ledger_e2e_ms - j.derived_e2e_ms) > $2::integer, FALSE))   AS e2e_mismatch
         ) f
        WHERE COALESCE(j.derived_ttff_ms, j.derived_e2e_ms, j.ledger_ttff_ms, j.ledger_e2e_ms) IS NOT NULL
     ),
     summary AS (
       SELECT COUNT(*)                                                     AS compared_count,
              COUNT(*) FILTER (WHERE c.classification = 'agree')           AS agree_count,
              COUNT(*) FILTER (WHERE c.classification = 'disagree')        AS disagree_count,
              COUNT(*) FILTER (WHERE c.classification = 'derived_only')    AS derived_only_count,
              COUNT(*) FILTER (WHERE c.classification = 'ledger_only')     AS ledger_only_count,
              -- The distribution of the difference, over turns where BOTH sides produced the figure.
              COUNT(c.ttff_diff_ms)                                                        AS ttff_diff_sample_count,
              ROUND(percentile_cont(0.5)  WITHIN GROUP (ORDER BY ABS(c.ttff_diff_ms)))    AS p50_abs_ttff_diff_ms,
              ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY ABS(c.ttff_diff_ms)))    AS p95_abs_ttff_diff_ms,
              MAX(ABS(c.ttff_diff_ms))                                                     AS max_abs_ttff_diff_ms,
              COUNT(c.e2e_diff_ms)                                                         AS e2e_diff_sample_count,
              ROUND(percentile_cont(0.5)  WITHIN GROUP (ORDER BY ABS(c.e2e_diff_ms)))     AS p50_abs_e2e_diff_ms,
              ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY ABS(c.e2e_diff_ms)))     AS p95_abs_e2e_diff_ms,
              MAX(ABS(c.e2e_diff_ms))                                                      AS max_abs_e2e_diff_ms,
              -- Turns both paths measured whose ledger TTFF started from the exchange's user instant:
              -- their agreement shares a start with the derived path and is weaker evidence.
              COUNT(*) FILTER (WHERE c.anchor_source = 'exchange'
                                 AND c.classification IN ('agree', 'disagree'))           AS exchange_anchored_count
         FROM classified c
     ),
     detail AS (
       -- Only the rows an operator has to look at. Disagreements first, largest difference first.
       SELECT c.response_id, c.channel_arn, c.turn_id, c.exchange_id, c.placeholder_at, c.assistant,
              c.paired_by, c.anchor_source, c.trigger_kind,
              c.derived_ttff_ms, c.ledger_ttff_ms, c.ttff_diff_ms,
              c.derived_e2e_ms, c.ledger_e2e_ms, c.e2e_diff_ms,
              c.classification,
              CASE WHEN c.classification = 'disagree'
                   THEN concat_ws(',', CASE WHEN c.ttff_mismatch THEN 'ttff' END,
                                       CASE WHEN c.e2e_mismatch THEN 'e2e' END)
              END AS disagreed_on,
              ROW_NUMBER() OVER (
                ORDER BY CASE c.classification WHEN 'disagree' THEN 0 ELSE 1 END,
                         GREATEST(COALESCE(ABS(c.ttff_diff_ms), 0), COALESCE(ABS(c.e2e_diff_ms), 0)) DESC,
                         c.placeholder_at DESC
              ) AS row_rank
         FROM classified c
        WHERE c.classification <> 'agree'
     )
     SELECT s.compared_count, s.agree_count, s.disagree_count, s.derived_only_count, s.ledger_only_count,
            s.ttff_diff_sample_count, s.p50_abs_ttff_diff_ms, s.p95_abs_ttff_diff_ms, s.max_abs_ttff_diff_ms,
            s.e2e_diff_sample_count, s.p50_abs_e2e_diff_ms, s.p95_abs_e2e_diff_ms, s.max_abs_e2e_diff_ms,
            s.exchange_anchored_count,
            d.response_id, d.channel_arn, d.turn_id, d.exchange_id, d.placeholder_at, d.assistant,
            d.paired_by, d.anchor_source, d.trigger_kind,
            d.derived_ttff_ms, d.ledger_ttff_ms, d.ttff_diff_ms,
            d.derived_e2e_ms, d.ledger_e2e_ms, d.e2e_diff_ms,
            d.classification, d.disagreed_on
       FROM summary s
       LEFT JOIN detail d ON d.row_rank <= $3
      ORDER BY d.row_rank`,
    [win.range, SHADOW_DIFF_TOLERANCE_MS, limit],
  );

  const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
  const first = rows[0] ?? {};
  // Counts arrive as bigint strings; a percentile over no samples is NULL and stays null rather than 0,
  // because "no turn had both figures" and "every difference was zero" are different findings.
  const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const summary: Record<string, number | null> = { tolerance_ms: SHADOW_DIFF_TOLERANCE_MS };
  for (const k of SHADOW_DIFF_SUMMARY_FIELDS) {
    summary[k] = k.endsWith('_count') ? (toNum(first[k]) ?? 0) : toNum(first[k]);
  }
  const data = rows
    .filter((r) => r.response_id !== null && r.response_id !== undefined)
    .map((r) => Object.fromEntries(SHADOW_DIFF_COLUMNS.map((k) => [k, r[k] ?? null])));

  return success({
    data,
    columns: SHADOW_DIFF_COLUMNS,
    summary,
    // The window the counts describe, so a panel never presents them against a different one.
    window: { days: win.days },
  });
}

/**
 * WHERE THE ROUTER LEG GOES, STEP BY STEP.
 *
 * `avg_router_other_ms` on the Latency tab is a single derived residual: `router_ms` less whatever
 * classification cost, covering the channel reads, the SSM reads, the task lookup, the drift check,
 * the ADR-033 claim and the grounding fetch all at once. It is the largest undivided thing inside
 * TTFF, and when it moved there was no way to say which of those did it.
 *
 * This divides it, from the instants the router recorded (`v_router_steps`, migration 041) rather
 * than from stamped durations - so the numbers here can be recomputed from the ledger rows beneath
 * them, and the steps of one response sum to that response's `router_ms`.
 *
 * `entry` is excluded by `step_ms IS NOT NULL`: it is the origin the others are measured from, not
 * a step, and it has no predecessor to subtract.
 *
 * A COUNT PER STEP, BESIDE THE AVERAGE, because the router branches. A fast-path turn never
 * classifies, a triage turn never claims and only the placeholder path fetches grounding, so each
 * step has its OWN denominator - a step that ran on a tenth of the turns and a step that ran on all
 * of them render identically without it, and the cheap-looking one may be the expensive one.
 *
 * THE WINDOW IS APPLIED AFTER THE VIEW, and that is a property worth knowing rather than hiding.
 * `v_router_steps` derives each duration with a window function partitioned by response, and a
 * predicate on `occurred_at` is not in that partition, so Postgres cannot push it inside - the view's
 * rows are computed and then filtered. The bound on the cost is the ledger's own 90-day expiry and
 * the partial index behind `kind = 'router_step'`; at the volumes this deployment has seen that is a
 * few tens of thousands of rows for an on-demand admin query. If it ever stops being cheap, the fix
 * is a time-bounded variant of the view, not a filter that looks like it applies and does not.
 *
 * SCOPED BY THE MESSAGE'S OWN CLASSIFICATION, not by the coalesced chain `getLatencyMetrics` uses.
 * These rows hang off a bot message that always recorded its own `agent_type`, so the chain has
 * nothing to add here - and a JOIN through exchanges would drop exactly the unpaired turns whose
 * router cost is most worth seeing.
 */
async function getRouterSteps(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 90);
  const agentType = params.agentType;
  const result = await query(
    `SELECT rs.step_name,
            -- HOW THE TURN ENTERED (migration 054). This is the query that answers WHICH ROUTER STEP
            -- costs the extra time on one entry, which no figure could answer before: the router leg
            -- was aggregate-only and carried no entry, so a difference in time-to-first-feedback
            -- could not be attributed to the hop rather than to the handler.
            COALESCE(m.turn_entry, 'unknown')                                     AS turn_entry,
            COUNT(*)                                                              AS turns,
            ROUND(AVG(rs.step_ms))                                                AS avg_ms,
            ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY rs.step_ms))       AS p95_ms,
            MAX(rs.step_ms)                                                       AS max_ms
       FROM v_router_steps rs
       JOIN messages m
         ON m.message_id = rs.response_id
        AND m.channel_arn = rs.channel_arn
        AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
      WHERE rs.occurred_at >= lower($1::tstzrange) AND rs.occurred_at < upper($1::tstzrange)
        AND rs.step_ms IS NOT NULL
        AND ($2::text IS NULL OR m.assistant = $2)
      GROUP BY rs.step_name, COALESCE(m.turn_entry, 'unknown')
      -- Worst first: the reason to open this is to find the step to fix.
      ORDER BY avg_ms DESC NULLS LAST`,
    [win.range, agentType ?? null],
  );
  return success({
    data: result.rows,
    columns: ['step_name', 'turn_entry', 'turns', 'avg_ms', 'p95_ms', 'max_ms'],
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
/**
 * LATENCY PER KIND OF INTERACTION (G13).
 *
 * THE PROBLEM ONE TABLE CANNOT SOLVE. A person waiting on a reply, a rebuttal answering a rival, and
 * a turn re-driven after nobody routed it are three different questions wearing one number. Averaged
 * together the answer describes none of them: a duel-heavy day drags the headline toward turns nobody
 * was waiting for, and a quiet day hides a repair backlog inside a healthy-looking mean.
 *
 * SPLIT BY THE DECLARED KIND, not by a heuristic, with one declared fact ahead of it: a row whose
 * battle_round is past the first is the rebuttal row whatever kind it declared. Each row here is one
 * interaction, so an operator compares like with like and the denominators are visible rather than
 * implied.
 *
 * ack_ms IS THE COMMON METRIC and ttff_ms the user-triggered subset - which is why both are reported.
 * On the human-waiting kinds they agree; on a rebuttal only ack exists. Reporting ttff alone would
 * show a blank row for the interactions this split exists to make visible.
 *
 * A REBUTTAL'S END TO END IS ITS OWN ROUND'S. The `rebuttal` row is battle round 2, and its avg_e2e_ms
 * runs from the instant round two was triggered to the rebuttal's final answer (migration 071), the
 * same anchor its ack starts from. The headline E2E in getLatencyMetrics leaves round two out, so this
 * row is where it is read.
 *
 * READS THE VIEW, NOT THE MESSAGE TABLE. The view is where an instant becomes a duration, and where
 * the anchor and its provenance already live - deriving them a second time here is how two numbers
 * that should agree start to disagree.
 */
async function getLatencyByInteraction(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 90);
  const result = await query(
    `SELECT
       -- A LATER DUEL ROUND IS THE REBUTTAL ROW, whatever kind it declared or failed to declare, so
       -- the rebuttal row is exactly battle round 2 and no round-2 turn lands in the user row. The
       -- same round test the view applies to ttff_ms and e2e_ms (migration 071).
       --
       -- Otherwise an undeclared trigger is a user turn: that is what every path did before a kind was
       -- forwarded at all, so the default preserves how historical rows read.
       CASE WHEN COALESCE(battle_round, 1) > 1 THEN 'rebuttal'
            ELSE COALESCE(trigger_kind, 'user') END AS interaction,
       COUNT(*) AS turn_count,
       -- The population each average is over, stated rather than implied. A kind can have turns and
       -- no measurable latency - that is the finding, not an empty cell.
       COUNT(ack_ms) AS measured_count,
       ROUND(AVG(ack_ms)) AS avg_ack_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ack_ms)) AS p95_ack_ms,
       -- Kept beside ack so the two can be compared per kind: where a person is waiting they should
       -- agree, and a divergence means the anchor and the user message have come apart.
       ROUND(AVG(ttff_ms)) AS avg_ttff_ms,
       ROUND(AVG(e2e_ms)) AS avg_e2e_ms,
       ROUND(AVG(total_ms)) AS avg_total_ms,
       -- HOW THE ANCHOR WAS OBTAINED, per kind. A row whose latency is mostly derived is a weaker
       -- measurement than one that is mostly declared, and averaging them without saying so presents
       -- a reconstruction with the same confidence as an observation.
       COUNT(*) FILTER (WHERE ack_source = 'declared') AS declared_count,
       COUNT(*) FILTER (WHERE ack_source = 'derived')  AS derived_count,
       COUNT(*) FILTER (WHERE ack_source IS NULL)      AS unanchored_count
     FROM v_turn_latency
     WHERE t2_placeholder_at >= lower($1::tstzrange) AND t2_placeholder_at < upper($1::tstzrange)
     GROUP BY CASE WHEN COALESCE(battle_round, 1) > 1 THEN 'rebuttal'
                   ELSE COALESCE(trigger_kind, 'user') END
     ORDER BY turn_count DESC`,
    [win.range],
  );
  return success({
    data: result.rows,
    columns: [
      'interaction', 'turn_count', 'measured_count',
      'avg_ack_ms', 'p95_ack_ms', 'avg_ttff_ms', 'avg_e2e_ms', 'avg_total_ms',
      'declared_count', 'derived_count', 'unanchored_count',
    ],
  });
}

/**
 * THE SAME TURN, MEASURED FROM BOTH ENDS (G5).
 *
 * The server brackets time-to-first-feedback between two Chime message timestamps; the browser
 * brackets it between the person's click and the bubble painting. Neither can see the other's half -
 * the server never sees the click, the client never sees a MessageId for its own send - so a slow
 * reply had two candidate explanations and no way to choose. Comparing the two AVERAGES narrowed that
 * to a population; joining them per turn answers it for a specific one.
 *
 * THE JOIN KEY IS THE CORRELATION MARKER, which is the only identifier both sides hold: the client
 * reads it off the placeholder it just rendered, and the server wrote it into the message content.
 *
 * `delivery_gap_ms` IS THE POINT. It is what the browser waited MINUS what the server thinks it made
 * them wait: WebSocket delivery plus render. A NEGATIVE value is a finding rather than a glitch - the
 * two clocks disagree, or the client timed from a send the server paired to a different turn - so it
 * is returned rather than clamped, exactly as `unattributed_ms` is.
 */
async function getClientServerLatency(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 90);
  const result = await query(
    `WITH client AS (
       -- One row per correlated client timing. MIN, because a client retry can send the same entry
       -- twice and a duplicate must not weight one turn twice in the aggregate below.
       SELECT ce.event_data->'properties'->>'correlationId' AS corr,
              MIN((ce.event_data->>'perf_value')::numeric) AS client_ttff_ms
         FROM client_events ce
        WHERE ce.event_type = 'client_ttff_ms'
          AND ce.event_data->'properties'->>'correlationId' IS NOT NULL
          AND ce.created_at >= lower($1::tstzrange) AND ce.created_at < upper($1::tstzrange)
        GROUP BY 1
     )
     SELECT
       c.corr AS correlation_id,
       ROUND(c.client_ttff_ms) AS client_ttff_ms,
       e.response_latency_ms   AS server_ttff_ms,
       ROUND(c.client_ttff_ms - e.response_latency_ms) AS delivery_gap_ms,
       m.channel_arn,
       m.created_at
     FROM client c
     -- The placeholder that carries this correlation id. Bounded substring, the same grammar every
     -- other reader uses: a marker longer than the bound is not a marker, and matching loosely here
     -- would join a turn to whatever text happened to follow the token.
     JOIN messages m
       ON m.is_bot = TRUE
      AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
      AND m.created_at >= lower($1::tstzrange) AND m.created_at < upper($1::tstzrange)
      AND substring(m.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->') = c.corr
     -- LATERAL + LIMIT 1 for the same reason v_turn_latency uses one: exchanges is unique on the
     -- (user, agent) PAIR, so a plain join can emit the same turn twice and double-count it.
     LEFT JOIN LATERAL (
       SELECT ex.response_latency_ms
         FROM exchanges ex
        WHERE ex.agent_message_id = m.id
          -- A REAL TURN, the guard every other latency reader in this file already applies. A
          -- cross-batch fallback pairing is not a turn somebody waited for, and its server number
          -- belongs to a different moment entirely: subtracting it from this client measurement
          -- produced delivery gaps around MINUS EIGHT MINUTES, sorted to the top by recency.
          --
          -- ASKED OF paired_by, NOT OF delivery_option. A missing delivery option USED to imply a
          -- swept pairing, so it stood in for the question. The sweep now records the option like
          -- every other writer, which quietly made this test true for the very rows it exists to
          -- reject - and the minus-eight-minute gaps would have come straight back. The provenance
          -- is a stored fact now, so it is read as one. IS DISTINCT FROM keeps the pre-migration
          -- rows, whose paired_by is NULL and whose delivery option is the evidence they were real.
          AND ex.paired_by IS DISTINCT FROM 'swept'
          AND (ex.paired_by IS NOT NULL OR ex.delivery_option IS NOT NULL)
        ORDER BY ex.created_at
        LIMIT 1
     ) e ON TRUE
     WHERE e.response_latency_ms IS NOT NULL
     ORDER BY m.created_at DESC
     LIMIT 200`,
    [win.range],
  );
  return success({
    data: result.rows,
    columns: ['correlation_id', 'client_ttff_ms', 'server_ttff_ms', 'delivery_gap_ms', 'channel_arn', 'created_at'],
  });
}

async function getTaskResolution(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 90);
  const result = await query(
    `SELECT task_id, channel_arn, opened_at, terminal_at, terminal_kind,
            is_resolved, resolve_ms, agent_ms, transitions, turns
       FROM v_task_resolution
      WHERE opened_at >= lower($1::tstzrange) AND opened_at < upper($1::tstzrange)
      ORDER BY opened_at DESC
      LIMIT 200`,
    [win.range],
  );
  return success({
    data: result.rows,
    columns: [
      'task_id', 'channel_arn', 'opened_at', 'terminal_at', 'terminal_kind',
      'is_resolved', 'resolve_ms', 'agent_ms', 'transitions', 'turns',
    ],
  });
}

/**
 * HOW EACH WORKFLOW'S TASKS GOT WHERE THEY ARE (SPEC-EVALUATION Appendix C2, proposed FR23).
 *
 * Deterministic, no judge: every figure is read off the `taskTrajectory` the processor stamped on a task
 * turn from the task's own log and the machine that turn ran under (`lib/task-trajectory.ts`). The
 * latest stamp per task is the task's path so far. One row per (assistant, classification, task type).
 *
 *  - `success`, `failure`, `handoff`, `open`: where the task is, by the terminal kind of its state.
 *  - `path_ratio`: edges taken over the fewest edges to a success terminal, over the tasks that reached
 *    one. 1.0 is the direct path; a valid detour is a larger number, never a mismatch.
 *  - `tasks_regressed`: tasks with at least one edge back into a state they had already been in.
 *  - `stalled`: open tasks whose current state has gone `TASK_STALL_TURNS` turns without a move.
 *  - `platform_moves`: edges the platform took (a step action, an expiry, an admin action), apart from
 *    the model's.
 *  - `refused_moves`: calls the workflow refused by a declared rule, across the task's turns.
 *
 * The threshold is the processor's own (`TASK_STALL_TURNS`), passed in rather than restated.
 */
async function getWorkflowTrajectory(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const agentType = params.agentType || null;
  const conversationClassification = params.conversationClassification || null;
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const result = await query(
    `WITH stamped AS (
       SELECT DISTINCT ON (e.task_id)
              e.task_id, e.assistant, e.conversation_classification,
              COALESCE(upd.metadata, m.metadata)->'taskTrajectory' AS tr
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.task_id IS NOT NULL
          AND e.queued_as IS NULL
          AND jsonb_typeof(COALESCE(upd.metadata, m.metadata)->'taskTrajectory') = 'object'
          AND ($2::varchar IS NULL OR e.assistant = $2)
          AND ($3::varchar IS NULL OR e.conversation_classification = $3)
          AND ($4::text[] IS NULL OR e.conversation_classification = ANY($4))
        ORDER BY e.task_id, e.created_at DESC
     ),
     refused AS (
       SELECT e.task_id, COUNT(*) AS refused_moves
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(COALESCE(upd.metadata, m.metadata)->'steps') = 'array'
                THEN COALESCE(upd.metadata, m.metadata)->'steps' ELSE '[]'::jsonb END
         ) s
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(s->'tools') = 'array' THEN s->'tools' ELSE '[]'::jsonb END
         ) t
        WHERE e.task_id IN (SELECT task_id FROM stamped)
          AND (t->>'errorClass') = 'workflow_refusal'
        GROUP BY e.task_id
     )
     SELECT s.assistant,
            s.conversation_classification,
            s.tr->>'taskType' AS task_type,
            COUNT(*)::int AS tasks,
            COUNT(*) FILTER (WHERE s.tr->>'terminal' = 'success')::int AS success,
            COUNT(*) FILTER (WHERE s.tr->>'terminal' = 'failure')::int AS failure,
            COUNT(*) FILTER (WHERE s.tr->>'terminal' = 'handoff')::int AS handoff,
            COUNT(*) FILTER (WHERE s.tr->>'terminal' IS NULL)::int AS open,
            ROUND(AVG((s.tr->>'edges')::numeric / NULLIF((s.tr->>'shortestEdges')::numeric, 0))
                    FILTER (WHERE s.tr->>'terminal' = 'success'), 2) AS path_ratio,
            COUNT(*) FILTER (WHERE (s.tr->>'regressions')::int > 0)::int AS tasks_regressed,
            COUNT(*) FILTER (WHERE s.tr->>'terminal' IS NULL
                               AND (s.tr->>'turnsInState')::int >= $5)::int AS stalled,
            COALESCE(SUM((s.tr->>'platformMoves')::int), 0)::int AS platform_moves,
            COALESCE(SUM(r.refused_moves), 0)::int AS refused_moves
       FROM stamped s
       LEFT JOIN refused r ON r.task_id = s.task_id
      GROUP BY s.assistant, s.conversation_classification, s.tr->>'taskType'
      ORDER BY tasks DESC`,
    [win.range, agentType, conversationClassification, conversationClassifications, TASK_STALL_TURNS],
  );
  return success({ data: result.rows, columns: WORKFLOW_TRAJECTORY_COLUMNS });
}

export const WORKFLOW_TRAJECTORY_COLUMNS = [
  'assistant', 'conversation_classification', 'task_type', 'tasks', 'success', 'failure', 'handoff',
  'open', 'path_ratio', 'tasks_regressed', 'stalled', 'platform_moves', 'refused_moves',
] as const;

/**
 * SAFETY AND REFUSAL READINGS, FROM WHAT THE TURN RECORDED (SPEC-EVALUATION Appendix C5, proposed FR25).
 *
 * No judge is called. Three dimensions, one row per (dimension, assistant, classification, key):
 *
 *  - `refusal`: per intent, the turns this assistant refused because its classification does not offer
 *    the capability (`delivery_option = 'REFUSED'`, written by the router's refusal), over the intent's
 *    turns. A refusal is the classification boundary working, so it is reported as a count and never as
 *    a failure; `judged_appropriate` is how many of the judged ones the judge also called correct.
 *  - `guardrail`: per finding the guardrail recorded on the turn, the turns it fired on, over the
 *    group's turns. The platform's own internal-marker masks are not safety findings and are left out.
 *  - `rule`: per compliance rule, the turns whose latest verdict names it, over the turns assessed.
 *
 * Each row carries its population, so a reader never sees a rate without what it was taken over.
 */
async function getSafetyReadings(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const agentType = params.agentType || null;
  const conversationClassification = params.conversationClassification || null;
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const markerPatterns = INTERNAL_MARKER_FINDING_IDS.map((id) => `${id}%`);
  const result = await query(
    `WITH turns AS (
       SELECT e.id, e.assistant, e.conversation_classification, COALESCE(e.intent, 'unknown') AS intent,
              e.delivery_option,
              COALESCE(m.metadata, '{}'::jsonb) || COALESCE(upd.metadata, '{}'::jsonb) AS md
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.queued_as IS NULL
          AND ($2::varchar IS NULL OR e.assistant = $2)
          AND ($3::varchar IS NULL OR e.conversation_classification = $3)
          AND ($4::text[] IS NULL OR e.conversation_classification = ANY($4))
     ),
     verdict AS (
       SELECT DISTINCT ON (er.exchange_id)
              er.exchange_id, er.classification, er.is_compliant, er.compliance_categories
         FROM evaluation_results er
         JOIN turns t ON t.id = er.exchange_id
        WHERE er.evaluation_type = 'exchange'
        ORDER BY er.exchange_id, er.evaluated_at DESC
     ),
     groups AS (
       SELECT t.assistant, t.conversation_classification,
              COUNT(*) AS turns,
              COUNT(v.exchange_id) FILTER (WHERE v.is_compliant IS NOT NULL) AS assessed
         FROM turns t
         LEFT JOIN verdict v ON v.exchange_id = t.id
        GROUP BY t.assistant, t.conversation_classification
     ),
     refusal AS (
       SELECT 'refusal'::text AS dimension, t.assistant, t.conversation_classification, t.intent AS key,
              COUNT(*) FILTER (WHERE t.delivery_option = 'REFUSED') AS count,
              COUNT(*) AS population,
              COUNT(*) FILTER (WHERE t.delivery_option = 'REFUSED' AND v.classification IS NOT NULL) AS judged,
              COUNT(*) FILTER (WHERE t.delivery_option = 'REFUSED' AND v.classification = 'appropriate_refusal') AS judged_appropriate
         FROM turns t
         LEFT JOIN verdict v ON v.exchange_id = t.id
        GROUP BY t.assistant, t.conversation_classification, t.intent
       HAVING COUNT(*) FILTER (WHERE t.delivery_option = 'REFUSED') > 0
     ),
     guardrail AS (
       SELECT 'guardrail'::text AS dimension, t.assistant, t.conversation_classification, f.finding AS key,
              COUNT(DISTINCT t.id) AS count
         FROM turns t
         CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(t.md->'guardrailFindings') = 'array' THEN t.md->'guardrailFindings' ELSE '[]'::jsonb END
         ) AS f(finding)
        WHERE NOT (f.finding LIKE ANY($5::text[]))
        GROUP BY t.assistant, t.conversation_classification, f.finding
     ),
     rule AS (
       SELECT 'rule'::text AS dimension, t.assistant, t.conversation_classification, c.rule_id AS key,
              COUNT(DISTINCT t.id) AS count
         FROM turns t
         JOIN verdict v ON v.exchange_id = t.id
         CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(v.compliance_categories) = 'array' THEN v.compliance_categories ELSE '[]'::jsonb END
         ) AS c(rule_id)
        GROUP BY t.assistant, t.conversation_classification, c.rule_id
     )
     SELECT dimension, assistant, conversation_classification, key, count::int, population::int,
            judged::int, judged_appropriate::int
       FROM refusal
     UNION ALL
     SELECT g.dimension, g.assistant, g.conversation_classification, g.key, g.count::int, gr.turns::int,
            NULL::int, NULL::int
       FROM guardrail g
       JOIN groups gr ON gr.assistant IS NOT DISTINCT FROM g.assistant
                     AND gr.conversation_classification IS NOT DISTINCT FROM g.conversation_classification
     UNION ALL
     SELECT r.dimension, r.assistant, r.conversation_classification, r.key, r.count::int, gr.assessed::int,
            NULL::int, NULL::int
       FROM rule r
       JOIN groups gr ON gr.assistant IS NOT DISTINCT FROM r.assistant
                     AND gr.conversation_classification IS NOT DISTINCT FROM r.conversation_classification
     ORDER BY dimension, count DESC`,
    [win.range, agentType, conversationClassification, conversationClassifications, markerPatterns],
  );
  return success({ data: result.rows, columns: SAFETY_READING_COLUMNS });
}

/**
 * WHETHER A PERSON HAD TO WORK TO BE UNDERSTOOD, PER CONVERSATION (SPEC-EVALUATION Appendix C6,
 * proposed FR26).
 *
 * Every signal is a recorded event, never a phrase matched in what somebody wrote (tenet D11):
 *
 *  - `asked_again`: a thumbs-down the person marked "asked again", on this assistant's answer.
 *  - `declined_drift`: a drift offer the person declined, or accepted and then declined again.
 *  - `unanswered_handover`: a handover of the person's message that no assistant answered in ten minutes.
 *  - `stopped`: the person stopped open work (the `stopped` marker on the stop's acknowledgment).
 *
 * THE UNIT IS ONE PERSON IN ONE CONVERSATION, and two people's signals are never added together: a
 * conversation where two people each asked again once is two people with one signal, not one
 * conversation with two. The population is every (person, conversation) this assistant answered in the
 * window. A vote is this assistant's when it is on this assistant's answer; the other three belong to the
 * conversation, so they count for every assistant the person spoke with there, and the reading says so.
 *
 * Thumbs alone are given by too few people to stand as satisfaction (SPEC-ADMIN-CONSOLE-EFFECTIVENESS
 * FR20), which is why they are combined here with signals every conversation produces.
 */
async function getFrustration(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const agentType = params.agentType || null;
  const conversationClassification = params.conversationClassification || null;
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const askedAgain = (await scanLatestVotes(win))
    .filter((v) => v.feedback === 'down' && v.reason === 'asked_again' && v.voter && v.channelArn)
    .map((v) => ({ person: v.voter, channel: v.channelArn, messageId: v.messageId }));
  const result = await query(
    `WITH pc AS (
       SELECT DISTINCT e.person_id, e.channel_arn, e.assistant, e.conversation_classification
         FROM exchanges e
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.person_id IS NOT NULL
          AND e.queued_as IS NULL
          AND ($2::varchar IS NULL OR e.assistant = $2)
          AND ($3::varchar IS NULL OR e.conversation_classification = $3)
          AND ($4::text[] IS NULL OR e.conversation_classification = ANY($4))
     ),
     signals AS (
       SELECT v->>'person' AS person_id, v->>'channel' AS channel_arn, e.assistant, 'asked_again'::text AS kind
         FROM jsonb_array_elements($5::jsonb) v
         JOIN messages m ON m.message_id = v->>'messageId' AND m.channel_arn = v->>'channel'
                        AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
         JOIN exchanges e ON e.agent_message_id = m.id
       UNION ALL
       SELECT d.person_id, d.parent_channel_arn, NULL, 'declined_drift'
         FROM drift_events d
        WHERE d.outcome IN ('declined', 'rejected_in_new_channel')
          AND d.person_id IS NOT NULL
          AND d.occurred_at >= lower($1::tstzrange) AND d.occurred_at < upper($1::tstzrange)
       UNION ALL
       SELECT ${personIdSql("h.metadata->'aeHandover'->>'personSenderArn'")}, h.channel_arn, NULL, 'unanswered_handover'
         FROM messages h
        WHERE h.event_type = 'CREATE_CHANNEL_MESSAGE'
          AND ${handoverSql('h')}
          AND h.created_at >= lower($1::tstzrange) AND h.created_at < upper($1::tstzrange)
          AND NOT EXISTS (
            SELECT 1 FROM v_turn_latency t
             WHERE t.channel_arn = h.channel_arn
               AND t.trigger_kind = 'handover'
               AND t.responder = h.targeted_to
               AND t.t2_placeholder_at >= h.created_at
               AND t.t2_placeholder_at < h.created_at + INTERVAL '10 minutes')
       UNION ALL
       SELECT s.metadata->'stopped'->>'personId', s.channel_arn, NULL, 'stopped'
         FROM messages s
        WHERE s.event_type = 'CREATE_CHANNEL_MESSAGE'
          AND jsonb_typeof(s.metadata->'stopped') = 'object'
          AND s.created_at >= lower($1::tstzrange) AND s.created_at < upper($1::tstzrange)
     ),
     per_person AS (
       SELECT pc.assistant, pc.conversation_classification, pc.channel_arn, pc.person_id,
              COUNT(s.kind) AS signals,
              COUNT(s.kind) FILTER (WHERE s.kind = 'asked_again') AS asked_again,
              COUNT(s.kind) FILTER (WHERE s.kind = 'declined_drift') AS declined_drift,
              COUNT(s.kind) FILTER (WHERE s.kind = 'unanswered_handover') AS unanswered_handover,
              COUNT(s.kind) FILTER (WHERE s.kind = 'stopped') AS stopped
         FROM pc
         LEFT JOIN signals s ON s.person_id = pc.person_id AND s.channel_arn = pc.channel_arn
                            AND (s.assistant IS NULL OR s.assistant = pc.assistant)
        GROUP BY pc.assistant, pc.conversation_classification, pc.channel_arn, pc.person_id
     ),
     summary AS (
       SELECT 'summary'::text AS dimension, assistant, conversation_classification, NULL::varchar AS channel_arn,
              COUNT(*) AS population,
              COUNT(*) FILTER (WHERE signals > 0) AS with_signal,
              COUNT(*) FILTER (WHERE asked_again > 0) AS asked_again,
              COUNT(*) FILTER (WHERE declined_drift > 0) AS declined_drift,
              COUNT(*) FILTER (WHERE unanswered_handover > 0) AS unanswered_handover,
              COUNT(*) FILTER (WHERE stopped > 0) AS stopped,
              MAX(signals) AS most_signals
         FROM per_person
        GROUP BY assistant, conversation_classification
     ),
     conversation AS (
       SELECT 'conversation'::text AS dimension, assistant, conversation_classification, channel_arn,
              COUNT(*) AS population,
              COUNT(*) FILTER (WHERE signals > 0) AS with_signal,
              COUNT(*) FILTER (WHERE asked_again > 0) AS asked_again,
              COUNT(*) FILTER (WHERE declined_drift > 0) AS declined_drift,
              COUNT(*) FILTER (WHERE unanswered_handover > 0) AS unanswered_handover,
              COUNT(*) FILTER (WHERE stopped > 0) AS stopped,
              MAX(signals) AS most_signals
         FROM per_person
        GROUP BY assistant, conversation_classification, channel_arn
       HAVING COUNT(*) FILTER (WHERE signals > 0) > 0
        ORDER BY MAX(signals) DESC
        LIMIT 50
     )
     SELECT dimension, assistant, conversation_classification, channel_arn,
            population::int, with_signal::int, asked_again::int, declined_drift::int,
            unanswered_handover::int, stopped::int, most_signals::int
       FROM summary
     UNION ALL
     SELECT dimension, assistant, conversation_classification, channel_arn,
            population::int, with_signal::int, asked_again::int, declined_drift::int,
            unanswered_handover::int, stopped::int, most_signals::int
       FROM conversation`,
    [win.range, agentType, conversationClassification, conversationClassifications, JSON.stringify(askedAgain)],
  );
  return success({ data: result.rows, columns: FRUSTRATION_COLUMNS });
}

/**
 * WHICH CONTEXT SOURCES RETRIEVAL BRINGS BACK, AND WHETHER ANSWERS USE THEM (SPEC-EVALUATION
 * Appendix C7, proposed FR24).
 *
 * Read from `passage_sources`, which the groundedness judge fills in the same call that checks the
 * reply, on the latest exchange verdict. One row per (assistant, classification, source): how often a
 * passage from it was retrieved, and how often the reply rested on it. A source retrieved often and used
 * rarely is a retrieval finding for whoever curates it. Recall, whether the right passages were
 * retrieved at all, needs a reference answer and is not measured here.
 */
async function getRetrievalSources(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const agentType = params.agentType || null;
  const conversationClassification = params.conversationClassification || null;
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const result = await query(
    `WITH verdict AS (
       SELECT DISTINCT ON (er.exchange_id)
              er.exchange_id, er.passage_sources
         FROM evaluation_results er
        WHERE er.evaluation_type = 'exchange'
        ORDER BY er.exchange_id, er.evaluated_at DESC
     )
     SELECT e.assistant, e.conversation_classification,
            p->>'sourceId' AS source_id,
            MAX(p->>'title') AS title,
            COUNT(*)::int AS retrieved,
            COUNT(*) FILTER (WHERE (p->>'used')::boolean)::int AS used,
            COUNT(DISTINCT e.id)::int AS turns
       FROM exchanges e
       JOIN verdict v ON v.exchange_id = e.id
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(v.passage_sources) = 'array' THEN v.passage_sources ELSE '[]'::jsonb END
       ) p
      WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
        AND e.queued_as IS NULL
        AND ($2::varchar IS NULL OR e.assistant = $2)
        AND ($3::varchar IS NULL OR e.conversation_classification = $3)
        AND ($4::text[] IS NULL OR e.conversation_classification = ANY($4))
      GROUP BY e.assistant, e.conversation_classification, p->>'sourceId'
      ORDER BY retrieved DESC
      LIMIT 200`,
    [win.range, agentType, conversationClassification, conversationClassifications],
  );
  return success({ data: result.rows, columns: RETRIEVAL_SOURCE_COLUMNS });
}

/**
 * HOW FAR EACH JUDGE AGREES WITH PEOPLE (SPEC-EVALUATION Appendix C4, FR15).
 *
 * Three kinds of row, each per (rubric, assistant, classification):
 *
 *  - `judge`: the judge's latest verdict against a person's latest label on the same exchange, split by
 *    the evaluator model and the rubric version that judged it, so a change of either starts a new
 *    series rather than averaging two judges into one figure. Relevance, compliance and groundedness.
 *  - `people`: two different people's labels on the same exchange, the agreement people reach with each
 *    other on the same items, which is the most a judge can be expected to match.
 *  - `self`: verdicts where the judge was the model that wrote the answer, so self-preference is visible.
 *
 * "Positive" is the failure the rubric catches: relevance below 50, a breach, an unsupported claim. Kappa,
 * the true-positive and true-negative rates are computed from the counts in `agreementOf`. Battle picks
 * are the fourth source of human judgment and are read by `pairwise_agreement`, which this does not
 * duplicate. No rubric draws its examples from labels, so every label is held out.
 */
async function getJudgeCalibration(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 90, 365);
  const agentType = params.agentType || null;
  const conversationClassification = params.conversationClassification || null;
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const scope = `e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND ($2::varchar IS NULL OR e.assistant = $2)
          AND ($3::varchar IS NULL OR e.conversation_classification = $3)
          AND ($4::text[] IS NULL OR e.conversation_classification = ANY($4))`;
  const result = await query(
    `WITH verdict AS (
       SELECT DISTINCT ON (er.exchange_id)
              er.exchange_id, er.relevance_score, er.is_compliant, er.is_grounded,
              er.evaluator_model, er.rubric_version, er.rule_set_version, er.groundedness_rubric_version
         FROM evaluation_results er
        WHERE er.evaluation_type = 'exchange'
        ORDER BY er.exchange_id, er.evaluated_at DESC
     ),
     per_scorer AS (
       SELECT DISTINCT ON (g.exchange_id, g.scorer_id)
              g.exchange_id, g.scorer_id, g.human_score, g.human_is_compliant, g.human_is_grounded
         FROM ground_truth_scores g
        ORDER BY g.exchange_id, g.scorer_id, g.scored_at DESC
     ),
     label AS (
       SELECT DISTINCT ON (exchange_id) exchange_id, human_score, human_is_compliant, human_is_grounded
         FROM ground_truth_scores
        ORDER BY exchange_id, scored_at DESC
     ),
     judged AS (
       SELECT e.assistant, e.conversation_classification, v.*, l.human_score, l.human_is_compliant, l.human_is_grounded
         FROM exchanges e
         JOIN verdict v ON v.exchange_id = e.id
         JOIN label l ON l.exchange_id = e.id
        WHERE ${scope}
     ),
     judge_rows AS (
       SELECT 'judge'::text AS dimension, 'relevance'::text AS rubric, assistant, conversation_classification,
              evaluator_model, rubric_version AS version,
              COUNT(*) FILTER (WHERE relevance_score < 50 AND human_score < 50) AS tp,
              COUNT(*) FILTER (WHERE relevance_score < 50 AND human_score >= 50) AS fp,
              COUNT(*) FILTER (WHERE relevance_score >= 50 AND human_score < 50) AS fn,
              COUNT(*) FILTER (WHERE relevance_score >= 50 AND human_score >= 50) AS tn
         FROM judged WHERE relevance_score IS NOT NULL AND human_score IS NOT NULL
        GROUP BY assistant, conversation_classification, evaluator_model, rubric_version
       UNION ALL
       SELECT 'judge', 'compliance', assistant, conversation_classification,
              evaluator_model, rule_set_version,
              COUNT(*) FILTER (WHERE is_compliant IS FALSE AND human_is_compliant IS FALSE),
              COUNT(*) FILTER (WHERE is_compliant IS FALSE AND human_is_compliant IS TRUE),
              COUNT(*) FILTER (WHERE is_compliant IS TRUE AND human_is_compliant IS FALSE),
              COUNT(*) FILTER (WHERE is_compliant IS TRUE AND human_is_compliant IS TRUE)
         FROM judged WHERE is_compliant IS NOT NULL AND human_is_compliant IS NOT NULL
        GROUP BY assistant, conversation_classification, evaluator_model, rule_set_version
       UNION ALL
       SELECT 'judge', 'groundedness', assistant, conversation_classification,
              evaluator_model, groundedness_rubric_version,
              COUNT(*) FILTER (WHERE is_grounded IS FALSE AND human_is_grounded IS FALSE),
              COUNT(*) FILTER (WHERE is_grounded IS FALSE AND human_is_grounded IS TRUE),
              COUNT(*) FILTER (WHERE is_grounded IS TRUE AND human_is_grounded IS FALSE),
              COUNT(*) FILTER (WHERE is_grounded IS TRUE AND human_is_grounded IS TRUE)
         FROM judged WHERE is_grounded IS NOT NULL AND human_is_grounded IS NOT NULL
        GROUP BY assistant, conversation_classification, evaluator_model, groundedness_rubric_version
     ),
     two_people AS (
       SELECT e.assistant, e.conversation_classification,
              a.human_score AS a_score, b.human_score AS b_score,
              a.human_is_compliant AS a_comp, b.human_is_compliant AS b_comp,
              a.human_is_grounded AS a_gr, b.human_is_grounded AS b_gr
         FROM per_scorer a
         JOIN per_scorer b ON b.exchange_id = a.exchange_id AND b.scorer_id > a.scorer_id
         JOIN exchanges e ON e.id = a.exchange_id
        WHERE ${scope}
     ),
     people_rows AS (
       SELECT 'people'::text AS dimension, 'relevance'::text AS rubric, assistant, conversation_classification,
              NULL::varchar AS evaluator_model, NULL::varchar AS version,
              COUNT(*) FILTER (WHERE a_score < 50 AND b_score < 50) AS tp,
              COUNT(*) FILTER (WHERE a_score < 50 AND b_score >= 50) AS fp,
              COUNT(*) FILTER (WHERE a_score >= 50 AND b_score < 50) AS fn,
              COUNT(*) FILTER (WHERE a_score >= 50 AND b_score >= 50) AS tn
         FROM two_people WHERE a_score IS NOT NULL AND b_score IS NOT NULL
        GROUP BY assistant, conversation_classification
       UNION ALL
       SELECT 'people', 'compliance', assistant, conversation_classification, NULL, NULL,
              COUNT(*) FILTER (WHERE a_comp IS FALSE AND b_comp IS FALSE),
              COUNT(*) FILTER (WHERE a_comp IS FALSE AND b_comp IS TRUE),
              COUNT(*) FILTER (WHERE a_comp IS TRUE AND b_comp IS FALSE),
              COUNT(*) FILTER (WHERE a_comp IS TRUE AND b_comp IS TRUE)
         FROM two_people WHERE a_comp IS NOT NULL AND b_comp IS NOT NULL
        GROUP BY assistant, conversation_classification
       UNION ALL
       SELECT 'people', 'groundedness', assistant, conversation_classification, NULL, NULL,
              COUNT(*) FILTER (WHERE a_gr IS FALSE AND b_gr IS FALSE),
              COUNT(*) FILTER (WHERE a_gr IS FALSE AND b_gr IS TRUE),
              COUNT(*) FILTER (WHERE a_gr IS TRUE AND b_gr IS FALSE),
              COUNT(*) FILTER (WHERE a_gr IS TRUE AND b_gr IS TRUE)
         FROM two_people WHERE a_gr IS NOT NULL AND b_gr IS NOT NULL
        GROUP BY assistant, conversation_classification
     ),
     self_rows AS (
       SELECT 'self'::text AS dimension, NULL::text AS rubric, e.assistant, e.conversation_classification,
              v.evaluator_model, NULL::varchar AS version,
              COUNT(*) FILTER (WHERE regexp_replace(COALESCE(v.evaluator_model, ''), '^(us|eu|apac|global|us-gov)\\.', '')
                                   = regexp_replace(COALESCE(m.bedrock_model, ''), '^(us|eu|apac|global|us-gov)\\.', '')) AS tp,
              0::bigint AS fp, 0::bigint AS fn,
              COUNT(*) AS tn
         FROM exchanges e
         JOIN verdict v ON v.exchange_id = e.id
         JOIN messages m ON m.id = e.agent_message_id
        WHERE ${scope}
        GROUP BY e.assistant, e.conversation_classification, v.evaluator_model
     )
     SELECT * FROM judge_rows
     UNION ALL SELECT * FROM people_rows
     UNION ALL SELECT * FROM self_rows`,
    [win.range, agentType, conversationClassification, conversationClassifications],
  );
  const data = (result.rows as Array<Record<string, unknown>>).map((r) => {
    if (r.dimension === 'self') {
      // For a self row the two counts are the judged verdicts and the ones the answering model judged.
      return {
        dimension: 'self', rubric: null, assistant: r.assistant, conversation_classification: r.conversation_classification,
        evaluator_model: r.evaluator_model, version: null,
        judged: Number(r.tn), self_judged: Number(r.tp),
        n: null, kappa: null, tpr: null, tnr: null, tp: null, fp: null, fn: null, tn: null,
      };
    }
    const a = agreementOf({ tp: Number(r.tp), fp: Number(r.fp), fn: Number(r.fn), tn: Number(r.tn) });
    return {
      dimension: r.dimension, rubric: r.rubric, assistant: r.assistant, conversation_classification: r.conversation_classification,
      evaluator_model: r.evaluator_model ?? null, version: r.version ?? null,
      judged: null, self_judged: null,
      ...a,
    };
  });
  return success({ data, columns: JUDGE_CALIBRATION_COLUMNS });
}

export const JUDGE_CALIBRATION_COLUMNS = [
  'dimension', 'rubric', 'assistant', 'conversation_classification', 'evaluator_model', 'version',
  'judged', 'self_judged', 'n', 'kappa', 'tpr', 'tnr', 'tp', 'fp', 'fn', 'tn',
] as const;

/**
 * WHAT EACH TOOL'S CALLS CAME TO, AND WHO FIXES IT (SPEC-EVALUATION Appendix C3, FR11).
 *
 * One row per (assistant, classification, tool): its verdicts in `tool_call_verdicts` by outcome, and the
 * tool's owner from the registry. An errored or empty result is the owner's to fix; a wrong argument, a
 * contradiction or a tool left unused is the assistant's team's. `decided_by_judge` says how many of the
 * row's verdicts needed a judge at all, beside the ones decided from a recorded error or a recorded effect.
 */
async function getToolOutcomes(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const agentType = params.agentType || null;
  const conversationClassification = params.conversationClassification || null;
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const result = await query(
    `SELECT v.assistant, v.conversation_classification, v.tool_name,
            COUNT(*)::int AS verdicts,
            COUNT(*) FILTER (WHERE v.outcome = 'used_correctly')::int AS used_correctly,
            COUNT(*) FILTER (WHERE v.outcome = 'not_called')::int AS not_called,
            COUNT(*) FILTER (WHERE v.outcome = 'wrong_arguments')::int AS wrong_arguments,
            COUNT(*) FILTER (WHERE v.outcome = 'errored')::int AS errored,
            COUNT(*) FILTER (WHERE v.outcome = 'empty')::int AS empty,
            COUNT(*) FILTER (WHERE v.outcome = 'contradicted')::int AS contradicted,
            COUNT(*) FILTER (WHERE v.decided_by = 'judge')::int AS decided_by_judge
       FROM tool_call_verdicts v
      WHERE v.evaluated_at >= lower($1::tstzrange) AND v.evaluated_at < upper($1::tstzrange)
        AND v.tool_name <> '*'
        AND ($2::varchar IS NULL OR v.assistant = $2)
        AND ($3::varchar IS NULL OR v.conversation_classification = $3)
        AND ($4::text[] IS NULL OR v.conversation_classification = ANY($4))
      GROUP BY v.assistant, v.conversation_classification, v.tool_name
      ORDER BY verdicts DESC`,
    [win.range, agentType, conversationClassification, conversationClassifications],
  );
  const data = (result.rows as Array<Record<string, unknown>>).map((r) => ({ ...r, owner: toolOwnerOf(String(r.tool_name)) }));
  return success({ data, columns: TOOL_OUTCOME_COLUMNS });
}

export const TOOL_OUTCOME_COLUMNS = [
  'assistant', 'conversation_classification', 'tool_name', 'verdicts', 'used_correctly', 'not_called',
  'wrong_arguments', 'errored', 'empty', 'contradicted', 'decided_by_judge', 'owner',
] as const;

/**
 * HOW EACH DOCUMENT TEMPLATE'S DELIVERIES WENT (SPEC-DOCUMENT-TEMPLATES FR8, SPEC-EVALUATION Appendix C
 * housekeeping).
 *
 * A delivery records the template it was checked against and the result on the turn's `documentTemplate`,
 * and nothing read it. One row per (assistant, classification, template): the deliveries, and how many
 * passed first time, passed after a correction, were posted inline because they could not be made to
 * pass, or were filled by the platform. Template versions are counted, so a row spanning a template edit
 * says so.
 */
async function getTemplateOutcomes(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const agentType = params.agentType || null;
  const conversationClassification = params.conversationClassification || null;
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const result = await query(
    `WITH delivered AS (
       SELECT e.assistant, e.conversation_classification,
              (COALESCE(m.metadata, '{}'::jsonb) || COALESCE(upd.metadata, '{}'::jsonb)) -> 'documentTemplate' AS tpl
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.queued_as IS NULL
          AND ($2::varchar IS NULL OR e.assistant = $2)
          AND ($3::varchar IS NULL OR e.conversation_classification = $3)
          AND ($4::text[] IS NULL OR e.conversation_classification = ANY($4))
     )
     SELECT assistant, conversation_classification, tpl->>'name' AS template,
            COUNT(*)::int AS deliveries,
            COUNT(*) FILTER (WHERE tpl->>'outcome' = 'passed')::int AS passed,
            COUNT(*) FILTER (WHERE tpl->>'outcome' = 'passed_after_correction')::int AS passed_after_correction,
            COUNT(*) FILTER (WHERE tpl->>'outcome' = 'posted_inline')::int AS posted_inline,
            COUNT(*) FILTER (WHERE tpl->>'outcome' = 'filled_by_platform')::int AS filled_by_platform,
            COUNT(DISTINCT tpl->>'contentHash')::int AS template_versions
       FROM delivered
      WHERE jsonb_typeof(tpl) = 'object'
      GROUP BY assistant, conversation_classification, tpl->>'name'
      ORDER BY deliveries DESC`,
    [win.range, agentType, conversationClassification, conversationClassifications],
  );
  return success({ data: result.rows, columns: TEMPLATE_OUTCOME_COLUMNS });
}

/**
 * THE ANSWERS WAITING FOR A PERSON'S LABEL, MOST USEFUL FIRST (SPEC-EVALUATION FR14, Appendix C1 and C5).
 *
 * A label recorded from the exchange it is about, not from an identifier carried across tabs. The queue is
 * judged answers no person has labeled yet, ordered by what a label is worth: an answer the guardrail
 * found something on first (a judge is weakest on adversarial input), then one the classifier was unsure
 * of or a person flagged, then the rest by recency. `why` says which. It returns what was said, so a
 * team reads it with a stated reason, like the ground-truth list.
 */
async function getLabelQueue(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const markerPatterns = INTERNAL_MARKER_FINDING_IDS.map((id) => `${id}%`);
  const result = await query(
    `WITH candidates AS (
       SELECT e.id AS exchange_id, e.channel_arn, e.assistant, e.conversation_classification, e.intent, e.created_at,
              COALESCE(mu.updated_content, mu.content) AS user_message,
              COALESCE(ma.updated_content, ma.content) AS agent_response,
              v.relevance_score, v.is_compliant, v.is_grounded,
              EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof((COALESCE(ma.metadata, '{}'::jsonb) || COALESCE(ma_upd.metadata, '{}'::jsonb)) -> 'guardrailFindings') = 'array'
                       THEN (COALESCE(ma.metadata, '{}'::jsonb) || COALESCE(ma_upd.metadata, '{}'::jsonb)) -> 'guardrailFindings'
                       ELSE '[]'::jsonb END) AS f(finding)
                 WHERE NOT (f.finding LIKE ANY($5::text[]))
              ) AS has_safety_finding,
              (e.intent_confidence = 'low' OR hf.message_id IS NOT NULL) AS is_unsure_or_flagged
         FROM exchanges e
         JOIN messages mu ON e.user_message_id = mu.id
         JOIN messages ma ON e.agent_message_id = ma.id
         ${updateJoinSql({ alias: 'ma_upd', create: 'ma', pick: 'latest' })}
         JOIN LATERAL (
           SELECT relevance_score, is_compliant, is_grounded FROM evaluation_results er
            WHERE er.exchange_id = e.id AND er.evaluation_type = 'exchange'
            ORDER BY er.evaluated_at DESC LIMIT 1
         ) v ON TRUE
         LEFT JOIN human_flag hf ON hf.channel_arn = ma.channel_arn AND hf.message_id = ma.message_id
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.queued_as IS NULL
          AND NOT EXISTS (SELECT 1 FROM ground_truth_scores g WHERE g.exchange_id = e.id)
          AND ($2::text IS NULL OR e.assistant = $2)
          AND ($3::text[] IS NULL OR e.conversation_classification = ANY($3))
     )
     SELECT exchange_id, channel_arn, assistant, conversation_classification, intent, created_at,
            user_message, agent_response, relevance_score, is_compliant, is_grounded,
            CASE WHEN has_safety_finding THEN 'safety'
                 WHEN is_unsure_or_flagged THEN 'unsure_or_flagged'
                 ELSE 'sampled' END AS why
       FROM candidates
      ORDER BY has_safety_finding DESC, is_unsure_or_flagged DESC, created_at DESC
      LIMIT $4`,
    [win.range, boundAssistantOf(params), boundClassificationsOf(params), limit, markerPatterns],
  );
  const data = (result.rows as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    user_message: stripMessageMarkers(r.user_message as string),
    agent_response: stripMessageMarkers(r.agent_response as string),
  }));
  return success({ data });
}

/**
 * THE GOLDEN SET, PER CLASSIFICATION (SPEC-EVALUATION FR16, Appendix C1).
 *
 *  - list (no action): the live entries, read under EACH classification's own reader role, so the
 *    database refuses what that role's grant set does not cover whatever this query asks for.
 *  - `nominate` (exchangeId, tier): copies the exchange's de-identified request, and for a regression
 *    entry its de-identified answer, from the conversation's de-identified copy. A regression entry needs
 *    a person's label that passed (50 or more): it is a case the active version must keep passing. A
 *    capability entry may come from a failed answer and carries no reference. The copy must exist: an
 *    entry is never made from the raw exchange.
 *  - `retire` (entryId): the entry stops counting; the row stays, so a gate result that used it still
 *    names it.
 *  - `promote` (entryId): a capability entry the version now passes reliably becomes a regression entry.
 *
 * Every write runs as the write role, the only role the boundary lets write this table.
 */
async function getGoldenSet(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const action = params.action;
  if (action === 'nominate') {
    const purpose = params.purpose === 'capability' ? 'capability' : params.purpose === 'regression' ? 'regression' : null;
    if (!params.exchangeId || !purpose) return success({ submitted: false, error: 'exchangeId and purpose (regression or capability) are required' });
    if (!params.callerSub) return success({ submitted: false, error: 'Unable to attribute the nomination to a caller' });
    const ex = await query<{
      assistant: string | null; conversation_classification: string | null; intent: string | null; channel_arn: string;
      user_mid: string; agent_mid: string; human_score: number | null; agent_metadata: Record<string, unknown> | null;
    }>(
      `SELECT e.assistant, e.conversation_classification, e.intent, e.channel_arn,
              mu.message_id AS user_mid, ma.message_id AS agent_mid,
              (SELECT g.human_score FROM ground_truth_scores g WHERE g.exchange_id = e.id ORDER BY g.scored_at DESC LIMIT 1) AS human_score,
              COALESCE(ma.metadata, '{}'::jsonb) || COALESCE(ma_upd.metadata, '{}'::jsonb) AS agent_metadata
         FROM exchanges e
         JOIN messages mu ON e.user_message_id = mu.id
         JOIN messages ma ON e.agent_message_id = ma.id
         ${updateJoinSql({ alias: 'ma_upd', create: 'ma', pick: 'latest' })}
        WHERE e.id::text = $1`,
      [params.exchangeId],
    );
    const row = ex.rows[0];
    if (!row) return success({ submitted: false, error: 'No such exchange' });
    if (!row.conversation_classification) return success({ submitted: false, error: 'The exchange records no classification, so it cannot be placed in a classification\'s set' });
    if (row.human_score === null || row.human_score === undefined) {
      return success({ submitted: false, error: 'Label the answer first: an entry enters the set from a person\'s verdict' });
    }
    const passed = Number(row.human_score) >= 50;
    if (purpose === 'regression' && !passed) {
      return success({ submitted: false, error: 'A regression entry is a case that passes; this answer was labeled below 50, so nominate it as a capability entry' });
    }
    const clean = await query<{ source_message_id: string; text: string | null }>(
      `SELECT source_message_id, text FROM clean_conversation_rows
        WHERE channel_arn = $1 AND source_message_id = ANY($2::text[]) AND kind = 'message' AND state = 'present'`,
      [row.channel_arn, [row.user_mid, row.agent_mid]],
    );
    const request = clean.rows.find((r) => r.source_message_id === row.user_mid)?.text;
    const answer = clean.rows.find((r) => r.source_message_id === row.agent_mid)?.text;
    if (!request) {
      return success({ submitted: false, error: 'The de-identified copy of this conversation is not ready yet, so no entry can be made from it' });
    }
    // WHAT THE ANSWER WAS GIVEN, copied so the entry stands without the exchange (ADR-065): the tools it called, the
    // reply-preference keys it was answered under, and the turns before the request, from the same de-identified copy.
    const source = goldenSourceOf(row.agent_metadata);
    const before = await query<{ actor_kind: string; text: string | null }>(
      `SELECT actor_kind, text FROM clean_conversation_rows
        WHERE channel_arn = $1 AND kind = 'message' AND state = 'present'
          AND seq < (SELECT seq FROM clean_conversation_rows WHERE channel_arn = $1 AND source_message_id = $2 LIMIT 1)
        ORDER BY seq DESC
        LIMIT $3`,
      [row.channel_arn, row.user_mid, GOLDEN_PRECEDING_TURNS],
    );
    const precedingTurns = precedingTurnsOf(before.rows);
    await withWriterRole((client) => client.query(
      `INSERT INTO golden_set_entries
         (classification, purpose, assistant, intent, request_text, reference_text, human_score, source_exchange_id, nominated_by,
          used_tools, reply_preferences, preceding_turns)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source_exchange_id) WHERE retired_at IS NULL AND source_exchange_id IS NOT NULL DO NOTHING`,
      [row.conversation_classification, purpose, row.assistant, row.intent, request,
       passed ? (answer ?? null) : null, row.human_score, params.exchangeId, params.callerSub,
       source.usedTools.length ? source.usedTools : null,
       source.replyPreferences ? JSON.stringify(source.replyPreferences) : null,
       precedingTurns.length ? JSON.stringify(precedingTurns) : null],
    ));
    return success({ submitted: true });
  }
  if (action === 'retire' || action === 'promote') {
    if (!params.entryId) return success({ submitted: false, error: 'entryId is required' });
    if (!params.callerSub) return success({ submitted: false, error: 'Unable to attribute the change to a caller' });
    const res = await withWriterRole((client) => client.query(
      action === 'retire'
        ? `UPDATE golden_set_entries SET retired_at = NOW(), retired_by = $2 WHERE id::text = $1 AND retired_at IS NULL`
        : `UPDATE golden_set_entries SET purpose = 'regression' WHERE id::text = $1 AND retired_at IS NULL AND purpose = 'capability' AND $2::text IS NOT NULL`,
      [params.entryId, params.callerSub],
    ));
    return success({ submitted: (res.rowCount ?? 0) > 0 });
  }
  const bound = boundAssistantOf(params);
  const classifications = boundClassificationsOf(params)
    ?? defaultProfileRegistry.classificationValues().filter((c) => !defaultProfileRegistry.adminPlaneValues().includes(c));
  const rows: Array<Record<string, unknown>> = [];
  for (const classification of classifications) {
    const r = await withReaderRole(classification, (client) => client.query(
      `SELECT id, classification AS conversation_classification, purpose, assistant, intent, request_text, reference_text,
              human_score, source_exchange_id, nominated_by, nominated_at, used_tools, source, upload_id,
              (SELECT jsonb_build_object('runId', r.id, 'status', r.status, 'startedAt', r.started_at, 'outcome',
                        CASE WHEN bool_or(ga.not_exercised IS NOT NULL) THEN 'not_exercised'
                             WHEN bool_and(ga.ok AND NOT ga.empty AND NOT ga.blocked AND cardinality(ga.breaches) = 0) THEN 'passed'
                             ELSE 'failed' END)
                 FROM golden_run_attempts ga
                 JOIN golden_runs r ON r.id = ga.run_id
                WHERE ga.entry_id = golden_set_entries.id AND ga.side = 'draft'
                GROUP BY r.id, r.status, r.started_at
                ORDER BY r.started_at DESC LIMIT 1) AS last_run
         FROM golden_set_entries
        WHERE retired_at IS NULL AND classification = $1
          AND ($2::text IS NULL OR assistant = $2)
        ORDER BY nominated_at DESC`,
      [classification, bound],
    ));
    rows.push(...(r.rows as Array<Record<string, unknown>>));
  }
  return success({ data: rows });
}

/**
 * ── THE MESSAGE FLOW: PATH, INTENT, OUTCOME ──────────────────────────────────
 *
 * The Performance overview reads the same turns the Latency tab reads (`LATENCY_TURN_JOINS_SQL`,
 * `LATENCY_TURN_POPULATION_SQL`), so a count here reconciles with a count there, narrowed to the turns
 * that answered something: those with an exchange, those the router refused, and those a handover
 * started. Round two of a duel is held out, as the Latency headline holds it out.
 *
 *   path      how the turn arrived (`turn_entry`): `flow` (standard), `lex` (targeted), or `unknown`.
 *   intent    the exchange's intent, else the one the refusal recorded.
 *   outcome   one of, in this order of precedence:
 *               refused   the router's capability refusal (delivery option REFUSED)
 *               handed    a handover started the turn: another assistant passed the person's message
 *               stopped   the person stopped it while it ran (a `cancelled_response` on the ledger)
 *               task      it worked on a task
 *               answered  anything else that paired to an exchange
 */
/**
 * THE INTENT A TURN COUNTS UNDER IN EFFECTIVENESS (ADR-064 decision I): a turn bound to a task counts under the task's
 * type, whatever its message was classified as, and every other turn under its classified intent. `intent` keeps the
 * classifier's intent on every row; the grouping is decided here, at query time, so no column changes meaning.
 */
export const WORK_INTENT_SQL = (alias: string): string => `COALESCE(${alias}.task_type, ${alias}.intent)`;

const FLOW_INTENT_SQL = `COALESCE(e.intent, upd.metadata->>'intent', m.metadata->>'intent', 'unknown')`;
const FLOW_OUTCOME_SQL = `CASE
         WHEN lbl.delivery_option = 'REFUSED' THEN 'refused'
         WHEN lbl.kind = 'handover' THEN 'handed'
         WHEN EXISTS (SELECT 1 FROM turn_events tc
                       WHERE tc.response_id = m.message_id AND tc.channel_arn = m.channel_arn
                         AND tc.kind = 'cancelled_response') THEN 'stopped'
         WHEN e.task_id IS NOT NULL THEN 'task'
         ELSE 'answered'
       END`;
// A RECEIPT IS NOT A TURN OF THE FLOW: its answer moved to a message of its own, which is the turn and carries
// its path and its task. Excluded by its declared kind as well as by its missing exchange, so a receipt that
// paired before it said what it became (a narration landed first) is still counted once, as its answer.
const FLOW_POPULATION_SQL = `${LATENCY_TURN_POPULATION_SQL}
        AND (e.id IS NOT NULL OR lbl.delivery_option = 'REFUSED' OR lbl.kind = 'handover')
        AND lbl.kind IS DISTINCT FROM 'receipt'
        AND COALESCE(m.battle_round, 1) <= 1`;
/** The shared filters, as `getLatencyExchanges` applies them: $2 assistant, $3 role, $4 version, $5 classification, $6 team reach. */
/**
 * THE PATH AND BATTLE FILTERS OF THE SHARED BAR, as the server reads them. The bar offers both on every
 * Performance view, so every query behind those views has to honour them or a filter that is on screen
 * silently does nothing. `turnEntry` is a path (`flow`, `lex`, `unknown`); `duelRound` is `none` for
 * turns outside a battle, or a round number; `responseType` is a delivery option. On an exchange the
 * delivery option is the exchange's own, which is what Latency's label reads for any turn that paired.
 */
const perfEntryParam = (params: Record<string, string | undefined>): string | null =>
  (params.turnEntry === 'unrecorded' ? 'unknown' : params.turnEntry) || null;
const perfDuelParam = (params: Record<string, string | undefined>): string | null => params.duelRound || null;
/** The bar's Response type: a delivery option, as the Latency rows name it. Null is every type. */
const perfTypeParam = (params: Record<string, string | undefined>): string | null => params.responseType || null;
/** The same filters over an exchange, whose path and round live on its answer message. */
const exchangePathDuelSql = (e: string, n: number): string => {
  const answer = (col: string) => `(SELECT pm.${col} FROM messages pm WHERE pm.id = ${e}.agent_message_id)`;
  return `AND ($${n}::varchar IS NULL OR COALESCE(${answer('turn_entry')}, 'unknown') = $${n})
          AND ($${n + 1}::varchar IS NULL OR ($${n + 1} = 'none' AND ${answer('battle_round')} IS NULL)
               OR ${answer('battle_round')}::text = $${n + 1})
          AND ($${n + 2}::varchar IS NULL OR ${e}.delivery_option = $${n + 2})`;
};

const FLOW_FILTER_SQL = `
        AND ($2::varchar IS NULL OR ${LATENCY_DIM.assistant} = $2)
        AND ($3::varchar IS NULL OR ${LATENCY_DIM.role} = $3)
        AND ($4::int IS NULL OR ${LATENCY_DIM.version} = $4)
        AND ($5::varchar IS NULL OR ${LATENCY_DIM.classification} = $5)
        AND ($6::text[] IS NULL OR COALESCE(e.conversation_classification, c.conversation_classification, m.conversation_classification) = ANY($6))
        AND ($7::varchar IS NULL OR ${LATENCY_DIM.entry} = $7)
        AND ($8::varchar IS NULL OR ($8 = 'none' AND m.battle_round IS NULL) OR m.battle_round::text = $8)
        AND ($9::varchar IS NULL OR lbl.delivery_option = $9)`;
const flowFilterParams = (params: Record<string, string | undefined>): unknown[] => [
  params.agentType || null,
  params.assistantRole || null,
  params.profileVersion ? parseInt(params.profileVersion, 10) : null,
  params.conversationClassification || null,
  ((params as Record<string, unknown>).conversationClassifications as string[] | undefined) ?? null,
  perfEntryParam(params),
  perfDuelParam(params),
  perfTypeParam(params),
];

/**
 * One row per (path, intent, outcome): the turns, and every latency average WITH the count it was taken
 * over, so the console weights them into any grouping it draws (a path, an intent, the whole window)
 * rather than averaging averages. A conditional step (classifier, scan) counts only the turns that ran it.
 */
async function getMessageFlow(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const result = await query(
    `SELECT ${LATENCY_DIM.entry} AS path,
            ${FLOW_INTENT_SQL} AS intent,
            ${FLOW_OUTCOME_SQL} AS outcome,
            COUNT(*)::int AS turns,
            ROUND(AVG(vl.ttff_ms))::int AS avg_ttff_ms, COUNT(vl.ttff_ms)::int AS ttff_n,
            ROUND(AVG(vl.e2e_ms))::int AS avg_e2e_ms, COUNT(vl.e2e_ms)::int AS e2e_n,
            ROUND(AVG(e.inbound_ms))::int AS avg_inbound_ms, COUNT(e.inbound_ms)::int AS inbound_n,
            ROUND(AVG(m.router_ms))::int AS avg_router_ms, COUNT(m.router_ms)::int AS router_n,
            ROUND(AVG(m.classifier_ms))::int AS avg_classifier_ms, COUNT(m.classifier_ms)::int AS classifier_n,
            ROUND(AVG(m.total_ms))::int AS avg_total_ms, COUNT(m.total_ms)::int AS total_n,
            ROUND(AVG(m.guard_ms))::int AS avg_guard_ms, COUNT(m.guard_ms)::int AS guard_n,
            ROUND(AVG(m.placeholder_resolve_ms))::int AS avg_resolve_ms, COUNT(m.placeholder_resolve_ms)::int AS resolve_n,
            COUNT(m.poll_ms)::int AS poll_n,
            ROUND(AVG(m.latency_ms))::int AS avg_latency_ms, COUNT(m.latency_ms)::int AS latency_n,
            ROUND(AVG(m.model_ms))::int AS avg_model_ms, COUNT(m.model_ms)::int AS model_n,
            ROUND(AVG(m.tool_ms))::int AS avg_tool_ms, COUNT(m.tool_ms)::int AS tool_n,
            COUNT(*) FILTER (WHERE m.cold_start IS TRUE)::int AS cold_n
       FROM messages m
       ${LATENCY_TURN_JOINS_SQL}
      WHERE ${FLOW_POPULATION_SQL}
        ${FLOW_FILTER_SQL}
      GROUP BY 1, 2, 3
      ORDER BY turns DESC`,
    [win.range, ...flowFilterParams(params)],
  );
  return success({ data: result.rows, columns: MESSAGE_FLOW_COLUMNS });
}

/**
 * THE WELCOME LANE: how long an assistant took to greet a conversation it joined.
 *
 * A welcome answers nothing (it declares `turn_kind = 'welcome'`), so it is outside the turn
 * population and has no TTFF: there is no person's message to measure from. What a person sees is the
 * assistant joining and then its welcome appearing, and both are archived - the join as the
 * assistant's `CREATE_CHANNEL_MEMBERSHIP`, the welcome as its message - so the wait is the gap between
 * them. A join more than ten minutes before the welcome is not taken as its trigger; such a welcome is
 * counted and left unmeasured rather than given a time it did not have.
 *
 * Grouped by path, because a welcome that answers the question its conversation was spawned from
 * (drift) carries a correlation marker and runs the worker, and its time is not an ordinary greeting's.
 */
async function getWelcomeFlow(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const result = await query(
    `SELECT CASE WHEN m.content LIKE '%<!--corr:%' THEN 'answers' ELSE 'greeting' END AS kind,
            COUNT(*)::int AS welcomes,
            COUNT(j.joined_at)::int AS measured,
            ROUND(AVG(EXTRACT(EPOCH FROM (m.created_at - j.joined_at)) * 1000))::int AS avg_ms,
            ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (m.created_at - j.joined_at)) * 1000))::int AS p95_ms
       FROM messages m
       LEFT JOIN LATERAL (
         SELECT MAX(mm.created_at) AS joined_at
           FROM messages mm
          WHERE mm.channel_arn = m.channel_arn
            AND mm.event_type = 'CREATE_CHANNEL_MEMBERSHIP'
            AND mm.target_arn = m.sender_arn
            AND mm.created_at <= m.created_at
            AND mm.created_at > m.created_at - interval '10 minutes'
       ) j ON true
      WHERE m.is_bot = true
        AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
        AND m.turn_kind = 'welcome'
        AND m.created_at >= lower($1::tstzrange) AND m.created_at < upper($1::tstzrange)
        AND ($2::varchar IS NULL OR COALESCE(m.assistant, 'unknown') = $2)
        AND ($3::varchar IS NULL OR COALESCE(m.conversation_classification, 'unknown') = $3)
        AND ($4::text[] IS NULL OR m.conversation_classification = ANY($4))
      GROUP BY 1
      ORDER BY 1`,
    [
      win.range,
      params.agentType || null,
      params.conversationClassification || null,
      ((params as Record<string, unknown>).conversationClassifications as string[] | undefined) ?? null,
    ],
  );
  return success({ data: result.rows, columns: WELCOME_FLOW_COLUMNS });
}

export const WELCOME_FLOW_COLUMNS = ['kind', 'welcomes', 'measured', 'avg_ms', 'p95_ms'] as const;

export const MESSAGE_FLOW_COLUMNS = [
  'path', 'intent', 'outcome', 'turns',
  'avg_ttff_ms', 'ttff_n', 'avg_e2e_ms', 'e2e_n', 'avg_inbound_ms', 'inbound_n', 'avg_router_ms', 'router_n',
  'avg_classifier_ms', 'classifier_n', 'avg_total_ms', 'total_n', 'avg_guard_ms', 'guard_n', 'avg_resolve_ms',
  'resolve_n', 'poll_n', 'avg_latency_ms', 'latency_n', 'avg_model_ms', 'model_n', 'avg_tool_ms', 'tool_n', 'cold_n',
] as const;

/**
 * WHAT ONE TURN'S STEPS COST TOGETHER, over a turn read as `m` with its latest update row `upd`: the sum of each step's
 * `estCostUsd`, each priced on the model it ran on, and how many steps recorded none. A turn whose task entered a step
 * with a model of its own mid-turn ran on two models (ADR-064 decision B), so its tokens cannot be priced at the one
 * model the row names.
 */
const TURN_STEPS_COST_SQL = `(SELECT jsonb_build_object(
              'steps', COUNT(*),
              'usd', SUM((s.entry->>'estCostUsd')::numeric) FILTER (WHERE jsonb_typeof(s.entry->'estCostUsd') = 'number'),
              'unpriced', COUNT(*) FILTER (WHERE jsonb_typeof(s.entry->'estCostUsd') IS DISTINCT FROM 'number'))
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(COALESCE(upd.metadata, m.metadata)->'steps') = 'array'
                                           THEN COALESCE(upd.metadata, m.metadata)->'steps' ELSE '[]'::jsonb END) AS s(entry))`;

/**
 * A TURN'S COST: the sum of its steps where every step recorded one, else its tokens priced on the model the row names
 * (a turn recorded before its steps carried a cost). `steps_cost` is consumed here and not returned.
 */
export function flowTurnCost(row: Record<string, unknown>): Record<string, unknown> {
  const { steps_cost: stepsCost, ...rest } = row;
  const sc = (stepsCost && typeof stepsCost === 'object' ? stepsCost : {}) as { steps?: unknown; usd?: unknown; unpriced?: unknown };
  const fromSteps = Number(sc.steps) > 0 && Number(sc.unpriced) === 0 && sc.usd !== null && sc.usd !== undefined
    ? Math.round(Number(sc.usd) * 1e6) / 1e6
    : undefined;
  return {
    ...rest,
    cost_usd: fromSteps ?? estimateStepCostUsd({
      modelId: String(row.bedrock_model ?? ''),
      tokensIn: Number(row.input_tokens) || 0,
      tokensOut: Number(row.output_tokens) || 0,
    }),
  };
}

/**
 * The turns behind one node of the flow: a path, an intent or an outcome (`flowPath`, `flowIntent`,
 * `flowOutcome`, any combination), most recent first. Timings, the judge's relevance and the cost only:
 * no message text, so a list reads nothing anybody said. What was said is one step further, in the
 * conversation, whose read is audited there.
 */
async function getFlowTurns(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const result = await query(
    `SELECT m.id AS message_id, e.id AS exchange_id, m.channel_arn, m.created_at,
            ${LATENCY_DIM.entry} AS path, ${FLOW_INTENT_SQL} AS intent, ${FLOW_OUTCOME_SQL} AS outcome,
            ${LATENCY_DIM.assistant} AS assistant, ${LATENCY_DIM.classification} AS conversation_classification,
            vl.ttff_ms, vl.e2e_ms, m.total_ms, m.bedrock_model, m.input_tokens, m.output_tokens,
            e.task_type, e.task_step, e.task_state, e.model_kind, e.model_from,
            ${TURN_STEPS_COST_SQL} AS steps_cost,
            (SELECT er.relevance_score FROM evaluation_results er
              WHERE er.exchange_id = e.id AND er.evaluation_type = 'exchange'
              ORDER BY er.evaluated_at DESC LIMIT 1) AS relevance_score
       FROM messages m
       ${LATENCY_TURN_JOINS_SQL}
      WHERE ${FLOW_POPULATION_SQL}
        ${FLOW_FILTER_SQL}
        AND ($10::varchar IS NULL OR ${LATENCY_DIM.entry} = $10)
        AND ($11::varchar IS NULL OR ${FLOW_INTENT_SQL} = $11)
        AND ($12::varchar IS NULL OR ${FLOW_OUTCOME_SQL} = $12)
      ORDER BY m.created_at DESC
      LIMIT $13`,
    [win.range, ...flowFilterParams(params), params.flowPath || null, params.flowIntent || null, params.flowOutcome || null, limit],
  );
  const data = (result.rows as Array<Record<string, unknown>>).map(flowTurnCost);
  return success({ data });
}

/**
 * ONE TURN'S RECORD, in the order it happened: the router's steps from the ledger, then the worker's
 * stamps, then every verdict on it. Read by the turn's message id and bound by the same filters as the
 * list it was opened from, so a team reads only its own assistant's turns. No message text.
 */
async function getFlowTurn(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  if (!params.messageId) return success({ data: [] });
  const win = queryWindow(params, 180, 365);
  const head = await query(
    `SELECT m.id AS message_id, m.message_id AS chime_message_id, e.id AS exchange_id, m.channel_arn, m.created_at,
            ${LATENCY_DIM.entry} AS path, ${FLOW_INTENT_SQL} AS intent, ${FLOW_OUTCOME_SQL} AS outcome,
            ${LATENCY_DIM.assistant} AS assistant, ${LATENCY_DIM.classification} AS conversation_classification,
            ${LATENCY_DIM.version} AS profile_version,
            vl.ttff_ms, vl.e2e_ms, e.inbound_ms, m.router_ms, m.classifier_ms, m.guard_ms, m.placeholder_resolve_ms,
            m.poll_ms, m.latency_ms, m.model_ms, m.tool_ms, m.total_ms, m.cold_start,
            m.bedrock_model, m.input_tokens, m.output_tokens, e.task_id,
            ${TURN_STEPS_COST_SQL} AS steps_cost
       FROM messages m
       ${LATENCY_TURN_JOINS_SQL}
      WHERE m.id::text = $10
        AND ${FLOW_POPULATION_SQL}
        ${FLOW_FILTER_SQL}
      LIMIT 1`,
    [win.range, ...flowFilterParams(params), params.messageId],
  );
  const turn = head.rows[0] as Record<string, unknown> | undefined;
  if (!turn) return success({ data: [] });
  const steps = await query(
    `SELECT step_name, step_ms, occurred_at FROM v_router_steps
      WHERE response_id = $1 AND channel_arn = $2 AND step_ms IS NOT NULL
      ORDER BY occurred_at`,
    [turn.chime_message_id, turn.channel_arn],
  );
  const verdict = turn.exchange_id ? await query(
    `SELECT relevance_score, classification, is_grounded, retrieved_passage_count, used_passage_count,
            is_compliant, compliance_categories, evaluator_model, rubric_version
       FROM evaluation_results WHERE exchange_id = $1 AND evaluation_type = 'exchange'
      ORDER BY evaluated_at DESC LIMIT 1`,
    [turn.exchange_id],
  ) : { rows: [] };
  const tools = turn.exchange_id ? await query(
    `SELECT tool_name, outcome, owner FROM tool_call_verdicts WHERE exchange_id = $1 AND tool_name <> '*' ORDER BY call_index`,
    [turn.exchange_id],
  ) : { rows: [] };
  return success({
    data: [{
      ...flowTurnCost(turn),
      router_steps: steps.rows,
      verdict: verdict.rows[0] ?? null,
      tool_verdicts: tools.rows,
    }],
  });
}

export const TEMPLATE_OUTCOME_COLUMNS = [
  'assistant', 'conversation_classification', 'template', 'deliveries', 'passed', 'passed_after_correction',
  'posted_inline', 'filled_by_platform', 'template_versions',
] as const;

export const RETRIEVAL_SOURCE_COLUMNS = [
  'assistant', 'conversation_classification', 'source_id', 'title', 'retrieved', 'used', 'turns',
] as const;

export const FRUSTRATION_COLUMNS = [
  'dimension', 'assistant', 'conversation_classification', 'channel_arn', 'population', 'with_signal',
  'asked_again', 'declined_drift', 'unanswered_handover', 'stopped', 'most_signals',
] as const;

export const SAFETY_READING_COLUMNS = [
  'dimension', 'assistant', 'conversation_classification', 'key', 'count', 'population',
  'judged', 'judged_appropriate',
] as const;


/**
 * THE LATENCY TAB'S AGGREGATE, AND WHERE EACH FIGURE COMES FROM.
 *
 * ONE ROW PER (date, agent_type, delivery_option), over ASSISTANT TURNS - `ASSISTANT_TURN_SQL`
 * defines that population and every count on the row is a subset of `assistant_turn_count`.
 *
 * TWO SOURCES, AND THE SPLIT IS THE POINT:
 *
 *   the ledger      `v_turn_latency`, for the two figures a person actually feels - TTFF and E2E.
 *                   These are derived at READ from instants the ledger recorded, each carrying its
 *                   clock and whether it is provable against the message stream. This is the
 *                   AUTHORITATIVE side (the ledger repoint), and `turn_latency_shadow_diff` is what
 *                   keeps the retired derivation checkable rather than merely believed.
 *   `messages.*`    every server-clock stamp: worker compute, the model loop, the router leg, the
 *                   placeholder lookup, cold start. These were never on the derived path and did not
 *                   move.
 *
 * `exchanges` is still read, and for three things that are not latency: which conversation and tier a
 * turn belongs to, whether a turn paired at all (`unpaired_turn_count`, the unclosed buckets), and the
 * pairer's own account of how it paired, which is how a reconstructed pairing is kept out of TTFF.
 *
 * THE UNCLOSED SPLIT STAYS ON THE DERIVED PATH DELIBERATELY. `closed_count`, `unclosed_count` and the
 * buckets that partition it answer "did the EXCHANGE close, and if not why" - a question about the
 * pairing, not about latency - and one of the buckets (`disagreed`) exists precisely to compare the
 * ledger with the exchange. Repointing them would have that bucket compare the ledger with itself.
 */
async function getLatencyMetrics(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 90);

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
                -- STOPPED ON PURPOSE, which is an explanation and not a defect. Without this a
                -- cancellation fell to ELSE and every /stop was reported to operators as an answer
                -- that went missing - the one bucket that means something is wrong.
                WHEN bool_or(kind = 'cancelled_response')                                 THEN 'cancelled'
                WHEN bool_or(kind IN ('progress_update','notice_posted'))                 THEN 'awaiting'
                ELSE 'silent'
              END AS outcome,
              -- WHEN THE RESPONSE FIRST SHOWED A QUEUE NOTICE. On a notice posted on its own this is
              -- its CREATE; on a notice written into a running answer's placeholder it is that update,
              -- which is when the acknowledgment reached the person (the CREATE is the placeholder).
              MIN(occurred_at) FILTER (WHERE kind = 'notice_posted') AS notice_at,
              -- WHEN THE RESPONSE FIRST DELIVERED CONTENT INTO ITS MESSAGE: the first update, final or
              -- not. A reading's proposal and a receipt's close-out are each one update, and a reading
              -- declares its proposal interim, so its delivered instant is here and not in final_response.
              MIN(occurred_at) FILTER (WHERE kind IN ('progress_update','final_response')) AS delivered_at
         FROM turn_events
        WHERE response_id IS NOT NULL
          AND occurred_at >= lower($1::tstzrange) AND occurred_at < upper($1::tstzrange)
        GROUP BY response_id, channel_arn
     ),
     -- ── WHAT EACH GROUP SPENT, PER MODEL, AGGREGATED HERE ──
     --
     -- PRICED IN JS, NOT HERE (decision D4: the rate table stays in model-rate-table.ts), so the Lambda
     -- needs the tokens per model, per leg, per group. They are summed here over the same population
     -- and the same grain as the grid below (LATENCY_TURN_JOINS_SQL, LATENCY_TURN_POPULATION_SQL,
     -- LATENCY_DIM), so turn_models holds one entry per (leg, model) in the group - a handful - rather
     -- than one per turn. A turn adds one answer reply on its bedrock_model and one classifier reply on
     -- its classifier_model, each where the model is named.
     model_leg AS (
       SELECT ${LATENCY_DIM.day} AS date, ${LATENCY_DIM.assistant} AS assistant,
              ${LATENCY_DIM.label} AS delivery_option, ${LATENCY_DIM.entry} AS turn_entry,
              ${LATENCY_DIM.role} AS assistant_role, ${LATENCY_DIM.version} AS profile_version,
              ${LATENCY_DIM.round} AS battle_round, ${LATENCY_DIM.classification} AS conversation_classification,
              leg.leg, leg.model,
              COUNT(*) AS replies,
              COALESCE(SUM(leg.tokens_in), 0)  AS tokens_in,
              COALESCE(SUM(leg.tokens_out), 0) AS tokens_out
         FROM messages m
         ${LATENCY_TURN_JOINS_SQL}
         CROSS JOIN LATERAL (VALUES
           ('answer',     m.bedrock_model,    m.input_tokens,         m.output_tokens),
           ('classifier', m.classifier_model, m.classifier_tokens_in, m.classifier_tokens_out)
         ) AS leg(leg, model, tokens_in, tokens_out)
        WHERE ${LATENCY_TURN_POPULATION_SQL}
          AND leg.model IS NOT NULL AND leg.model <> ''
        GROUP BY ${LATENCY_DIM.day}, ${LATENCY_DIM.assistant}, ${LATENCY_DIM.label}, ${LATENCY_DIM.entry},
                 ${LATENCY_DIM.role}, ${LATENCY_DIM.version}, ${LATENCY_DIM.round}, ${LATENCY_DIM.classification},
                 leg.leg, leg.model
     ),
     model_mix AS (
       SELECT date, assistant, delivery_option, turn_entry, assistant_role, profile_version,
              battle_round, conversation_classification,
              jsonb_agg(jsonb_build_object(
                'leg', leg, 'model', model, 'replies', replies, 'tokensIn', tokens_in, 'tokensOut', tokens_out
              )) AS turn_models
         FROM model_leg
        GROUP BY date, assistant, delivery_option, turn_entry, assistant_role, profile_version,
                 battle_round, conversation_classification
     ),
     grid AS (
     SELECT
       ${LATENCY_DIM.day} AS date,
       -- THE TIER OF A TURN NOBODY ASKED FOR IS NOT UNKNOWN.
       --
       -- This read the exchange first and the conversation second, and a bot-INITIATED turn has
       -- neither: a welcome, a round-2 rebuttal and a drift notice all answer something other than a
       -- user message, so no exchange pairs them. They were therefore grouped as tier 'unknown' -
       -- while the message row beside them recorded the tier that actually served the turn.
       --
       -- The message's own value is now the LAST resort before 'unknown' rather than absent from the
       -- chain, which shrinks the unknown bucket to rows whose tier genuinely was not recorded. It is
       -- placed last, not first, deliberately: the exchange and the conversation describe the turn's
       -- CONTEXT, and where they disagree with a single message row they are the better answer for a
       -- population being grouped by conversation tier.
       --
       -- This does NOT close the unattributed-compute bucket, and is not meant to. That bucket is
       -- about delivery_option, which a bot-initiated turn genuinely does not have, and the fix
       -- there is to NAME the interaction rather than to widen a coalesce.
       -- (No backticks anywhere in this SQL: the whole statement is a JS template literal, so one
       --  would end the string mid-query - which is exactly how this comment broke the build once.)
       ${LATENCY_DIM.assistant} AS assistant,
       -- ROLE AND VERSION, GROUPED RATHER THAN FILTERED SERVER-SIDE. This endpoint takes no filter
       -- parameters and returns a daily grid the tab slices in the browser - the same way it already
       -- slices by assistant. Adding them as grouped columns therefore makes them filterable without
       -- inventing a second filtering idiom for one endpoint. 'unknown' rather than NULL for the same
       -- reason the assistant uses it: a GROUP BY drops NULL rows from the grid entirely, and a turn
       -- that declared no role is a row an operator needs to SEE, not one that quietly vanishes.
       ${LATENCY_DIM.role} AS assistant_role,
       ${LATENCY_DIM.version} AS profile_version,
       -- ── IS THIS A DUEL TURN, AND WHICH ROUND ──────────────────────────────────────────────
       --
       -- ROUND 1 OF A DUEL WAS INDISTINGUISHABLE FROM AN ORDINARY TURN IN EVERY POPULATION FIGURE
       -- ON THIS GRID. TTFF, E2E, the model/tool/router averages and the turn count all pooled duel
       -- traffic with production traffic, and there was no field to partition on: the only battle
       -- fact any latency query carried was the interaction kind, which names round 2 only. So a
       -- hand-picked battle prompt moved the headline numbers and nothing could show that it had.
       --
       -- DESIGN-BATTLE 5b says round-2 rows must not be pooled with round-1 rows. Nothing ever said
       -- round-1 rows may be pooled with PRODUCTION rows, and they were.
       --
       -- GROUPED, NOT FILTERED, and 'none' rather than NULL - the same two choices the role and
       -- version columns above make, for the same reasons: this endpoint takes no filter parameters
       -- and returns a grid the tab slices, and a GROUP BY drops NULL rows out of the grid entirely.
       -- Excluding duel turns here instead would hide them rather than let an operator see them.
       ${LATENCY_DIM.round} AS battle_round,
       -- THE ROOM'S CLASSIFICATION, which this grid needs for a reason beyond filtering: the per-tier
       -- latency BANDS are budgets per classification (a basic turn is one small call; a premium turn
       -- runs a larger model plus retrieval). They were looked up by agent_type while that column held
       -- the classification. Now that it names the ASSISTANT, a band lookup keyed on it would find
       -- nothing and silently fall back to the published band - the tab would still render, with every
       -- tier judged by one budget, which is the exact defect the per-tier bands exist to prevent.
       ${LATENCY_DIM.classification} AS conversation_classification,
       -- NAMED, NEVER 'unknown' (turnLabelSql). A turn no person's message anchors has no delivery
       -- option to group under - a reading, a rebuttal, a welcome, a join recap, a duel round, a queue
       -- acknowledgment - and every one of them used to land here as 'unknown', with no time to show
       -- for itself. It now carries its declared kind, and a row that declared nothing at all is the
       -- named defect undeclared_turn rather than a bucket.
       ${LATENCY_DIM.label} AS delivery_option,
       -- HOW THE TURN ENTERED (migration 054). A latency average that mixes the Amazon Lex entry with
       -- the channel-flow entry is not an average about either: the two do different work in front of
       -- the first frame. Grouping by it also puts ttff_measured_count and ttff_reconstructed_count
       -- side by side PER ENTRY, which matters because the exclusion is not neutral between them - a
       -- flow turn always declares and pairs measured, an ordinary Amazon Lex turn on a queue-off
       -- deployment is swept out whenever it is slow. Without the counts per entry the headline would
       -- compare a censored population against an uncensored one and look decisive.
       ${LATENCY_DIM.entry} AS turn_entry,
       -- ── ASSISTANT TURNS, NAMED FOR WHAT THEY ARE ──
       --
       -- One row per assistant turn: a bot CREATE (not one of its update rows) that paired to a user
       -- message, ran a model, or carries a correlation marker - the population the WHERE below
       -- defines. It is NOT a count of exchanges. The exchanges table holds one row per answered user
       -- message, and a bot-INITIATED answer with no user message to pair with (a round-2 rebuttal) is
       -- a turn counted here with no exchange row at all. conversation_volumes.paired_exchange_count is
       -- the count of exchanges.
       --
       -- Deferral notices, welcomes and drift notices are assistant OUTPUT but not assistant turns,
       -- and are outside this population.
       --
       -- Every other count on this row is a subset of this one, and it is the traffic weight the
       -- console uses to combine groups.
       COUNT(*) AS assistant_turn_count,
       -- The turns in this group with no exchange row. A group labeled by a turn kind holds these AND
       -- paired turns whose exchange recorded no delivery option, so a kind's total is not an unpaired
       -- total. Summed over the window this equals unpaired_bot_messages.unpaired_count,
       -- because both read the one assistant-turn predicate (ASSISTANT_TURN_SQL).
       COUNT(*) FILTER (WHERE e.id IS NULL) AS unpaired_turn_count,
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
       --   avg_processor_tail_ms   what is LEFT of total_ms - the conversation-history load (a billed
       --                           ListChannelMessages), prompt assembly, and long-response handling.
       --                           NOT the message update or the archival write: total_ms is stamped
       --                           BEFORE both of those, so neither can be inside this residual.
       --                           Derived, not stamped, so it cannot drift
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
       -- ── THE POPULATION EACH STEP AVERAGE IS TAKEN OVER ──
       --
       -- A step is stamped only on a turn that ran it, and AVG skips the NULLs, so each average is over
       -- its own subset of assistant_turn_count and the subsets differ. Two averages over different
       -- subsets cannot be subtracted or compared as if they shared one: the TTFF average is over
       -- ttff_measured_count, the router average over router_measured_count, and a difference of the two
       -- describes no turn. A figure comparing them is computed per row, over rows carrying both.
       --
       --   router_measured_count        avg_router_ms and avg_router_other_ms
       --   classified_by_model_count    avg_classifier_ms
       --   guard_measured_count         avg_guard_ms
       --   placeholder_measured_count   avg_placeholder_resolve_ms
       COUNT(m.router_ms) AS router_measured_count,
       ROUND(AVG(m.classifier_ms)) AS avg_classifier_ms,
       COUNT(m.classifier_ms) AS classified_by_model_count,
       -- The router MINUS the classification it may or may not have bought. COALESCE on the
       -- classifier only: a turn that took a fast path spent none of its router time classifying, so
       -- its whole router span is "other" - whereas a NULL router_ms means the turn was never
       -- measured, and subtracting from it would invent a number.
       ROUND(AVG(m.router_ms - COALESCE(m.classifier_ms, 0))) AS avg_router_other_ms,
       ROUND(AVG(m.guard_ms)) AS avg_guard_ms,
       COUNT(m.guard_ms) AS guard_measured_count,
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
       -- ── WHAT THE P95 IS A P95 OF (G9) ──
       --
       -- A percentile over a handful of rows is not a tail, it is one of the rows. At n=3 the "95th
       -- percentile" is the slowest observation and moves by seconds when a single turn does; at n=500
       -- it is a stable statistic. The number renders identically in both cases, so a first-run
       -- deployment reads its own noise as a performance characteristic - and this is exactly when a
       -- reader has no history to tell them otherwise.
       --
       -- Reported per percentile, not once, because the two do not share a population: worker compute
       -- is present on any turn that ran a model, while TTFF additionally requires a MEASURED pairing.
       -- One count standing for both would overstate whichever is smaller.
       COUNT(m.total_ms)   AS p95_total_sample_count,
       COUNT(m.latency_ms) AS p95_bedrock_sample_count,
       -- ── COLD START: THE SANCTIONED REASON TTFF AND WORKER COMPUTE DISAGREE (G9) ──
       --
       -- Container init happens BEFORE handler entry, so total_ms structurally cannot contain it while
       -- ttff_ms - Chime clock, from the user's message - necessarily does. Recorded by the processor
       -- (a module-scope flag: true on the first invocation of a container, false on every reuse), so
       -- this is the event itself rather than a threshold inferred from the divergence it explains.
       --
       -- A RATE, read against assistant_turn_count. A high share on a quiet window explains a slow TTFF; a
       -- high share on a BUSY window is a concurrency finding - containers are being created as fast
       -- as they are used - and that is a different problem with a different fix.
       COUNT(*) FILTER (WHERE m.cold_start) AS cold_start_count,
       -- The same TTFF average over warm turns only, so the divergence can be QUANTIFIED rather than
       -- asserted. If avg_ttff_ms and this are close, cold start was not the story.
       ROUND(AVG(vl.ttff_ms) FILTER (WHERE mp.measured AND NOT COALESCE(m.cold_start, false)))
         AS avg_ttff_warm_ms,
       ROUND(MIN(m.total_ms)) AS min_total_ms,
       ROUND(MAX(m.total_ms)) AS max_total_ms,
       -- TTFF = time to first feedback: the delay from the user's message to the
       -- assistant's "One moment…" placeholder appearing (there is no token
       -- streaming, so this acknowledgment latency is the only pre-answer signal
       -- distinct from total_ms).
       --
       -- ── READ FROM THE LEDGER (the Latency tab's repoint onto v_turn_latency) ──
       --
       -- v_turn_latency.ttff_ms is the placeholder instant less the turn's user instant, derived
       -- at read from rows that each say when they happened, on which clock, and whether they are
       -- provable against the message stream. exchanges.response_latency_ms computed the same
       -- subtraction at archival and is now the second opinion rather than the figure: the shadow
       -- diff above compares them and the panel says which side the tab uses.
       --
       -- ── A REBUTTAL HAS NO TTFF, AND NULL IS THE CORRECT READING ──
       --
       -- The view returns NULL for any turn whose DECLARED trigger is not a person waiting: a battle
       -- round-2 rebuttal answers a rival's answer, not a user message, so nobody was waiting on it
       -- and there is no time-to-first-feedback to report. That is the rule 019 wrote down when the
       -- ledger was created and 038 made reachable.
       --
       -- NULL IS EXCLUDED HERE, NEVER COUNTED AS ZERO. AVG and PERCENTILE_CONT skip a NULL, and both
       -- counts below require vl.ttff_ms IS NOT NULL, so a rebuttal leaves the distribution rather
       -- than dragging it toward zero. Nothing coalesces this column, and nothing may: a zero here
       -- would report instant feedback on a turn that gave none.
       --
       -- MEASURED (shadow diff, 7 days to 2026-09-15): six turns disagreed and all six were battle
       -- round-2 rebuttals from 09-10, derived TTFF present and ledger TTFF null. Those six are the
       -- whole behavior change in the TTFF distribution, and dropping them is the point rather than
       -- a cost.
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
       -- compute/direct split above. The reconstructed rows keep their assistant_turn_count and are counted
       -- here by name; what they lose is a vote on a latency nobody experienced.
       --
       -- THE DISCRIMINATOR IS NOW DECLARED, WHICH IS WHAT THIS COMMENT USED TO ASK FOR. It read
       -- delivery_option IS NOT NULL, and NULL meant "the fallback minted this" only because that
       -- pairer's INSERT omitted the column - so a turn whose analytics genuinely lacked a delivery
       -- option was excluded with them, and the moment the fallback started recording one the whole
       -- partition would have collapsed. paired_by (migration 042) states how the pair was made:
       -- declared is the turn's own statement, in_batch is an inference bounded to seconds by
       -- the Kinesis batch it was made in, and swept searched up to the reply bound for a
       -- plausible answer. Only the last is excluded, and it is excluded by name.
       --
       -- THE OLD PROXY IS KEPT FOR ROWS WRITTEN BEFORE THE COLUMN, where NULL still means what it
       -- always meant. So no historical row changes which side of the partition it falls on, and no
       -- backfill is required.
       --
       -- E2E IS NOT PARTITIONED HERE and carries the same exposure: it is anchored on the same
       -- possibly-reconstructed user instant. Left alone deliberately, so the repoint is one decision
       -- rather than two - see LATENCY-TARGETS.md G15.
       --
       -- The predicate itself now lives in the mp lateral below, stated once and asked of the
       -- ledger's anchor as well as of the exchange's pairer. It was written out five times here,
       -- which is how two halves of one partition drift apart.
       ROUND(AVG(vl.ttff_ms) FILTER (WHERE mp.measured)) AS avg_ttff_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vl.ttff_ms)
             FILTER (WHERE mp.measured)) AS p95_ttff_ms,
       -- The population the two figures above are taken over, and the one they are not. Reported so
       -- "avg over N" means something here as well. Exact complements over the turns the ledger
       -- produced a TTFF for, because mp.measured is a strict boolean.
       COUNT(*) FILTER (WHERE vl.ttff_ms IS NOT NULL AND mp.measured)
         AS ttff_measured_count,
       COUNT(*) FILTER (WHERE vl.ttff_ms IS NOT NULL AND NOT mp.measured)
         AS ttff_reconstructed_count,
       -- ── WHAT OF TTFF WAS SPENT OUTSIDE THE ROUTER, MEASURED PER ROW ──
       --
       -- The router leg is the only part of TTFF this codebase controls, and until this column the
       -- rest of TTFF had no figure at all. On the dashboard that read as "the majority of the
       -- headline number is unexplained", which is worse than a wide number: it invites the reader to
       -- distrust the whole measurement rather than the part that is genuinely uncertain.
       --
       -- WHY THIS IS ARITHMETIC AND NOT AN ESTIMATE. The objection to it was that the endpoints sit on
       -- different clocks. That is the right objection to an INTERVAL between two clocks and the wrong
       -- one here, because neither operand is such an interval: ttff_ms is Chime-clock at both ends
       -- and router_ms is server-clock at both ends, so each is a valid duration on a consistent
       -- clock, and the difference of two durations carries no clock offset. What it does carry is
       -- relative clock DRIFT, which over a span of seconds is far below the millisecond this rounds
       -- to.
       --
       -- PER ROW, WHICH IS THE PART THAT ACTUALLY MATTERED. Subtracting the two AVERAGES would have
       -- been wrong, and not slightly: they are taken over different populations (ttff_measured_count
       -- against router_measured_count), so their difference describes no turn that ever ran. This
       -- subtracts within a row and averages after, over the turns carrying BOTH - which is the rule
       -- stated for every other step average in this query.
       --
       -- WHAT IT STILL DOES NOT SPLIT. Inside this figure are two hops: the message reaching the
       -- router, and the placeholder travelling back to Chime. Separating them needs an instant
       -- nobody stamps yet - the router marks its own entry and its hand-off, but nothing marks the
       -- placeholder being posted on the SERVER clock. That is an instrumentation gap, not a property
       -- of the clocks, and the surfaces say so rather than implying the time is unknowable.
       --
       -- NOT CLAMPED AT ZERO. A negative here means the two clocks disagree by more than the router
       -- leg, which is a finding about the measurement and must stay visible; clamping would file it
       -- as a fast turn.
       ROUND(AVG(vl.ttff_ms - m.router_ms) FILTER (
         WHERE mp.measured AND vl.ttff_ms IS NOT NULL AND m.router_ms IS NOT NULL
       )) AS avg_ttff_outside_router_ms,
       COUNT(*) FILTER (
         WHERE mp.measured AND vl.ttff_ms IS NOT NULL AND m.router_ms IS NOT NULL
       ) AS ttff_router_paired_count,
       -- ── AND THAT REMAINDER, SPLIT WHERE THE FLOW RECORDED ITS RECEIPT (090) ──
       -- Three parts over ONE set of turns (each carries all four instants), so they add up to that
       -- set's time outside the router. Reaching the flow is cross-clock (Amazon Chime SDK send time to
       -- the flow's server clock), so it is approximate; flow to router is two server clocks. The
       -- placeholder's return is what is left. None is clamped: a negative is a finding.
       ROUND(AVG(EXTRACT(EPOCH FROM (fr.flow_at - e.user_message_at)) * 1000) FILTER (
         WHERE mp.measured AND vl.ttff_ms IS NOT NULL AND m.router_ms IS NOT NULL
           AND fr.flow_at IS NOT NULL AND fr.router_entry_at IS NOT NULL AND e.user_message_at IS NOT NULL
       )) AS avg_to_flow_ms,
       ROUND(AVG(EXTRACT(EPOCH FROM (fr.router_entry_at - fr.flow_at)) * 1000) FILTER (
         WHERE mp.measured AND vl.ttff_ms IS NOT NULL AND m.router_ms IS NOT NULL
           AND fr.flow_at IS NOT NULL AND fr.router_entry_at IS NOT NULL AND e.user_message_at IS NOT NULL
       )) AS avg_flow_to_router_ms,
       ROUND(AVG(vl.ttff_ms - m.router_ms - EXTRACT(EPOCH FROM (fr.router_entry_at - e.user_message_at)) * 1000) FILTER (
         WHERE mp.measured AND vl.ttff_ms IS NOT NULL AND m.router_ms IS NOT NULL
           AND fr.flow_at IS NOT NULL AND fr.router_entry_at IS NOT NULL AND e.user_message_at IS NOT NULL
       )) AS avg_placeholder_return_ms,
       COUNT(*) FILTER (
         WHERE mp.measured AND vl.ttff_ms IS NOT NULL AND m.router_ms IS NOT NULL
           AND fr.flow_at IS NOT NULL AND fr.router_entry_at IS NOT NULL AND e.user_message_at IS NOT NULL
       ) AS flow_split_count,
       -- ── WHAT THE REPOINT DROPPED, COUNTED RATHER THAN LOST ──
       --
       -- A turn the derived path had a TTFF for and the ledger does not. Without it the two
       -- populations differ by a number nobody can see, which is the failure ttff_reconstructed_count
       -- was added to prevent, re-appearing from the other side.
       --
       -- TWO CAUSES, BOTH MEASURED over the seven days to 2026-09-15: a rebuttal, where the null is
       -- the correct reading and there were six; and a turn the ledger never recorded or could not
       -- anchor, of which there were 127, all older than the live writer and none in the last day.
       -- A count that stops falling on current traffic is the second cause returning, and that is a
       -- defect in the ledger's writer rather than in this query.
       COUNT(*) FILTER (WHERE e.response_latency_ms IS NOT NULL AND vl.ttff_ms IS NULL)
         AS ttff_ledger_unmeasured_count,
       -- E2E = user message -> FINAL answer, the full user-perceived wait. Distinct from total_ms
       -- (server compute from processor entry) and from TTFF (time to the placeholder). Read from the
       -- ledger's own instants (v_turn_latency.e2e_ms = final_response - the turn anchor), which the
       -- shadow diff measured against exchanges.e2e_ms at a p95 difference of 0 ms. Null on a turn
       -- whose final answer the ledger has not recorded, and on a turn with no anchor.
       -- LATENCY-TARGETS.md.
       --
       -- ── ROUND TWO OF A DUEL IS NOT IN THIS FIGURE ──
       --
       -- A rebuttal has an end to end of its own, from the instant round two was triggered to its
       -- final answer (migration 071), and nobody was waiting on it. This figure is a person's wait,
       -- so a later round is filtered out of both aggregates here and reported as the rebuttal row of
       -- latency_by_interaction instead. The filter is on the round only; the measured-pairing
       -- partition TTFF carries is still not applied to E2E (G15).
       ROUND(AVG(vl.e2e_ms) FILTER (WHERE COALESCE(vl.battle_round, 1) <= 1)) AS avg_e2e_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vl.e2e_ms)
         FILTER (WHERE COALESCE(vl.battle_round, 1) <= 1)) AS p95_e2e_ms,
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
       --               derivations disagree - the shadow-diff finding, reaching this query from the
       --               other side. This bucket is why the unclosed split stays on the exchange: it is
       --               the ledger measured AGAINST the exchange, and would read zero for ever if both
       --               halves came from the same place.
       --   errored     the producer declared phase 'error'. A CORRECT non-closure: the wait ended and no
       --               answer was produced, and folding that duration into time-to-answer would make a
       --               broken turn read as a fast one.
       --   superseded  the answer was redacted, deleted or edited afterwards.
       --   awaiting    a progress update or a notice and nothing terminal - the turn is still moving, or
       --               it handed back to the person.
       --   cancelled   the person stopped it. An explanation, not a defect.
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
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'cancelled')   AS unclosed_cancelled,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'awaiting')    AS unclosed_awaiting,
       COUNT(*) FILTER (WHERE b.unclosed_bucket = 'silent')      AS unclosed_silent,
       -- ── EVERY TURN'S OWN SPAN, FROM ITS OWN START TO ITS OWN FINAL POST (turn_ms) ──
       --
       -- avg_e2e_ms is a person's wait and stays one: a turn nobody's message started has no e2e, and
       -- round two of a duel is filtered out of it. So a reading, a rebuttal or a join recap took real
       -- time and showed none on this grid. turn_ms is the span every turn has, from the instant that
       -- STARTED it to the instant it finished, by the rule ts.turn_ms_source picks per turn (see the
       -- lateral below). On an ordinary turn it is the person's wait, so for those rows it equals e2e.
       --
       -- The six counts partition turn_measured_count by where the start came from, so an average
       -- over mostly server-clock spans is not read with the confidence of a single-clock one.
       ROUND(AVG(ts.turn_ms)) AS avg_turn_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ts.turn_ms)) AS p95_turn_ms,
       COUNT(ts.turn_ms) AS turn_measured_count,
       COUNT(ts.turn_ms) FILTER (WHERE ts.turn_ms_source = 'person_message')       AS turn_span_person_count,
       COUNT(ts.turn_ms) FILTER (WHERE ts.turn_ms_source = 'declared_trigger')     AS turn_span_trigger_count,
       COUNT(ts.turn_ms) FILTER (WHERE ts.turn_ms_source = 'acknowledged_message') AS turn_span_ack_count,
       COUNT(ts.turn_ms) FILTER (WHERE ts.turn_ms_source = 'processor_entry')      AS turn_span_processor_count,
       COUNT(ts.turn_ms) FILTER (WHERE ts.turn_ms_source = 'membership_event')     AS turn_span_membership_count,
       COUNT(ts.turn_ms) FILTER (WHERE ts.turn_ms_source = 'queue_release')        AS turn_span_queue_release_count,
       -- NOT a span count and not part of the partition: the receipts whose person's wait their moved
       -- answer carries. assistant_turn_count less turn_measured_count less this is the real gap.
       COUNT(*) FILTER (WHERE tsrc.turn_ms_source = 'carried_by_answer')         AS turn_carried_by_answer_count,
       -- ── WHAT EACH GROUP SPENT ──
       --
       -- Tokens are on the CREATE row for every turn that ran a model (the update fold carries them),
       -- paired or not, so a reading or a rebuttal is counted here like any answer. The cost panels
       -- price the exchange population, which leaves out every turn no exchange pairs; this is where
       -- those turns' spend is read. Summed, never averaged, so a group with no model calls reads 0
       -- tokens against a token_measured_count of 0 rather than an average of nothing.
       COALESCE(SUM(m.input_tokens), 0)  AS tokens_in,
       COALESCE(SUM(m.output_tokens), 0) AS tokens_out,
       COALESCE(SUM(m.classifier_tokens_in), 0)  AS classifier_tokens_in,
       COALESCE(SUM(m.classifier_tokens_out), 0) AS classifier_tokens_out,
       COUNT(*) FILTER (WHERE m.input_tokens IS NOT NULL OR m.output_tokens IS NOT NULL) AS token_measured_count
       -- The per-model spend is model_mix above, joined on the grain below.
     FROM messages m
     ${LATENCY_TURN_JOINS_SQL}
     -- GROUPED before it is joined, so it cannot multiply a row. resp_ledger is unique on
     -- (response_id, channel_arn); a plain join to turn_events would emit one row per EVENT and
     -- multiply every average in this query by the number of events the turn happened to record - the
     -- same fan-out hazard v_turn_latency documents against exchanges, arriving from the other side.
     LEFT JOIN resp_ledger l ON l.response_id = m.message_id AND l.channel_arn = m.channel_arn
     -- ── THE LEDGER REPOINT: THE TAB'S TTFF AND E2E COME FROM THE LEDGER (the vl join, in LATENCY_TURN_JOINS_SQL) ──
     --
     -- WHAT MOVED, AND ONLY THAT. avg_ttff_ms, p95_ttff_ms, avg_ttff_warm_ms, avg_e2e_ms and
     -- p95_e2e_ms are read from v_turn_latency instead of from exchanges.response_latency_ms and
     -- exchanges.e2e_ms. Every other figure on this row is a messages.* stamp and was never on the
     -- derived path at all, so nothing else changes source.
     --
     -- MEASURED BEFORE IT MOVED, through turn_latency_shadow_diff on live traffic (the shadow diff,
     -- 2026-09-15): over one day, 239 turns compared, 239 agreed, none disagreed, none measured by
     -- only one side, p95 absolute difference 0 ms on both TTFF and E2E. Over seven days, 1,016
     -- compared and 883 agreed; the six disagreements were all battle round-2 rebuttals (see the
     -- TTFF comment below) and the 127 derived-only turns were all older than the live writer, with
     -- none in the last day. The two paths subtract the same Amazon Chime SDK instants, so agreement
     -- to the millisecond is the expected result rather than a lucky one.
     --
     -- ONE ROW PER RESPONSE, so a plain LEFT JOIN is safe here where a join to turn_events is not:
     -- the view already groups on (response_id, channel_arn). That is the same property resp_ledger
     -- has to construct for itself above.
     --
     -- NO SECOND WINDOW PREDICATE, deliberately. The window is carried by the messages side and the
     -- join key is the response id, which is exact - a turn is here if and only if its message row is
     -- in the window, so there is no edge a date filter on the view could catch. Adding one would
     -- also filter on t2_placeholder_at, which the view produces by AGGREGATION: Postgres cannot push
     -- that qualifier down, so it would materialize the whole ledger instead of letting the planner
     -- parameterize on the grouping columns.
     -- THE MESSAGE A QUEUE ACKNOWLEDGMENT ACKNOWLEDGES, named by the notice itself (turn-queue-notice.ts
     -- stamps acknowledges on every post). Unique on (message_id, channel_arn), so one row or none.
     -- Read off the CREATE for a notice posted on its own, and off the first update for one written into
     -- a running answer's placeholder, whose CREATE is the placeholder and names nothing.
     LEFT JOIN messages qm
       ON qm.channel_arn = m.channel_arn
      AND qm.event_type = 'CREATE_CHANNEL_MESSAGE'
      AND qm.message_id = COALESCE(m.metadata->>'acknowledges', upd.metadata->>'acknowledges')
     -- THE JOIN A JOIN RECAP ANSWERS: the latest membership event of the member the recap is targeted at,
     -- in this conversation, at or before the recap. What triggered the recap is the person being added,
     -- not the share's dispatch of it, so a join is timed from the membership event.
     -- The event's own instant (Payload.CreatedTimestamp) is its row's created_at; its member is target_arn.
     LEFT JOIN LATERAL (
       SELECT mj.created_at AS joined_at
         FROM messages mj
        WHERE mj.channel_arn = m.channel_arn
          AND mj.event_type = 'CREATE_CHANNEL_MEMBERSHIP'
          AND mj.target_arn = m.targeted_to
          AND mj.created_at <= m.created_at
        ORDER BY mj.created_at DESC
        LIMIT 1
     ) mj ON lbl.kind = 'join_recap' AND m.targeted_to IS NOT NULL
     -- ── EACH TURN'S OWN START, AND THEREFORE ITS OWN SPAN ──
     --
     -- A turn is timed from the instant that started it to its own final post, never only from a
     -- person's message. The start is decided by WHAT THE TURN IS, not by which column happens to be
     -- present, so one kind cannot quietly mix definitions:
     --
     --   declared_trigger      a later duel round (round two): the orchestrator's declared round-two
     --                         instant to the rebuttal's final answer, which is v_turn_latency.e2e_ms
     --                         for such a row (migration 071). Server clock to Amazon Chime SDK clock.
     --   acknowledged_message  a queue acknowledgment: the queued message it names to the moment the
     --                         acknowledgment reached the person (its own post, or the update that wrote
     --                         it into a running answer's placeholder), both Amazon Chime SDK instants.
     --                         The same interval v_queue_acknowledgement.ack_ms reports per queued
     --                         message. The exchange's user message stands in only when the notice
     --                         named none.
     --   queue_release         a reading: the instant the drain released the queued work to it, which the
     --                         drain declares as the reading's trigger when it dispatches it (turn-triage.ts),
     --                         to the delivered message: the final answer, else the update that delivered
     --                         the proposal (a reading declares its proposal interim). Server clock to
     --                         Amazon Chime SDK clock, as declared_trigger is.
     --   carried_by_answer     a receipt: the placeholder of a turn whose answer moved to a message of its
     --                         own. ONE WAIT, ONE SPAN. The moved answer pairs through its own declared
     --                         answersMessageId and is timed from the same person's message to its final
     --                         answer, so timing the receipt as well counted that wait twice. The receipt
     --                         is named and counted (turn_carried_by_answer_count); its turn_ms is NULL.
     --   person_message        an ordinary turn and every kind a person's message started
     --                         (PERSON_STARTED_KINDS_SQL, round one included): the ledger's e2e_ms, the
     --                         person's message to the final answer.
     --   declared_trigger      any other kind whose producer declared trigger_at - a join recap (its
     --                         dispatch instant, join-recap.ts) or a repair: that instant to the final
     --                         answer, the ledger's final_response first and agent_final_at second.
     --   person_message        any other kind the ledger anchored to a person's message anyway.
     --   processor_entry       what is left is a processor turn with no other start on record - a
     --                         drift-spawned welcome, or a reading archived before its trigger was
     --                         declared: total_ms, processor entry to the moment the final post is
     --                         issued, on the server clock. It ends before the post lands (LATENCY-TARGETS
     --                         "Worker compute"), so it understates the span by the one update call.
     --
     -- NULL where the turn's start is known and its end is not (the answer never posted, or no trigger
     -- was declared on an older rebuttal): such a turn is counted in assistant_turn_count and not in
     -- turn_measured_count, and the gap is visible as the difference rather than averaged as a zero.
     -- A receipt is NULL too, and counted apart, so it is never read as part of that gap.
     LEFT JOIN LATERAL (
       SELECT CASE
                WHEN COALESCE(m.battle_round, vl.battle_round, 1) > 1     THEN 'declared_trigger'
                WHEN lbl.kind = 'queue_ack'                               THEN 'acknowledged_message'
                WHEN lbl.kind = 'join_recap' AND mj.joined_at IS NOT NULL THEN 'membership_event'
                WHEN lbl.kind = 'reading' AND m.trigger_at IS NOT NULL    THEN 'queue_release'
                WHEN lbl.kind = 'receipt'                                 THEN 'carried_by_answer'
                WHEN lbl.kind IS NULL OR lbl.kind IN ${PERSON_STARTED_KINDS_SQL} THEN 'person_message'
                WHEN m.trigger_at IS NOT NULL                             THEN 'declared_trigger'
                WHEN vl.e2e_ms IS NOT NULL                                THEN 'person_message'
                WHEN m.total_ms IS NOT NULL                               THEN 'processor_entry'
              END AS turn_ms_source
     ) tsrc ON TRUE
     LEFT JOIN LATERAL (
       SELECT tsrc.turn_ms_source,
              CASE
                WHEN COALESCE(m.battle_round, vl.battle_round, 1) > 1 THEN vl.e2e_ms
                WHEN tsrc.turn_ms_source = 'acknowledged_message'
                     AND COALESCE(qm.created_at, e.user_message_at) IS NOT NULL
                     AND COALESCE(l.notice_at, m.created_at) >= COALESCE(qm.created_at, e.user_message_at)
                  THEN (EXTRACT(EPOCH FROM (COALESCE(l.notice_at, m.created_at) - COALESCE(qm.created_at, e.user_message_at))) * 1000)::integer
                WHEN tsrc.turn_ms_source = 'queue_release'
                     AND COALESCE(vl.t3_final_at, m.agent_final_at, l.delivered_at) >= m.trigger_at
                  THEN (EXTRACT(EPOCH FROM (COALESCE(vl.t3_final_at, m.agent_final_at, l.delivered_at) - m.trigger_at)) * 1000)::integer
                WHEN tsrc.turn_ms_source = 'person_message' THEN vl.e2e_ms
                WHEN tsrc.turn_ms_source = 'membership_event'
                     AND COALESCE(vl.t3_final_at, m.agent_final_at) >= mj.joined_at
                  THEN (EXTRACT(EPOCH FROM (COALESCE(vl.t3_final_at, m.agent_final_at) - mj.joined_at)) * 1000)::integer
                WHEN tsrc.turn_ms_source = 'declared_trigger'
                     AND COALESCE(vl.t3_final_at, m.agent_final_at) >= m.trigger_at
                  THEN (EXTRACT(EPOCH FROM (COALESCE(vl.t3_final_at, m.agent_final_at) - m.trigger_at)) * 1000)::integer
                WHEN tsrc.turn_ms_source = 'processor_entry' THEN m.total_ms
              END AS turn_ms
     ) ts ON TRUE
     -- ── THE SWEPT-PAIRING EXCLUSION, CARRIED ACROSS (684dc22) ──
     --
     -- The derived path excluded a pairing the cross-batch sweep RECONSTRUCTED, because its
     -- "latency" is the gap to whatever reply a bounded search decided belonged to the prompt: 101
     -- such rows on 2026-08-14 averaged 487,360 ms and produced 93% of a 7-day TTFF total. The
     -- ledger inherits that exposure through exactly one door, and it is the one named here.
     --
     -- WHERE THE LEDGER ANCHORED ITSELF *AND BOUND THE TURN ITSELF*, IT IS UNEXPOSED.
     -- anchor_source = 'ledger' says the view subtracted its OWN observed user_message instant. The
     -- INSTANT is observed either way; what the ledger may not have observed is WHICH user message
     -- is this turn's anchor, and turn_id_source says which. 'declared' means the binding came from
     -- the turn, so no sweep took part in it. 'paired' means the binding was derived FROM THE
     -- EXCHANGE - turn-events-backfill.ts reads the exchanges table with no paired_by filter and
     -- writes turn_id onto the user_message row - so a ledger anchor built that way inherits the
     -- exchange's provenance, including a swept one. Reading 'ledger' alone as "no sweep took part"
     -- was false for the whole backfilled population, and running the backfill over a window
     -- readmitted every swept pairing to the headline average.
     --
     -- SO THE LEDGER CLAUSE ASKS BOTH, and where the binding was paired the decision falls through
     -- to the exchange clauses below - which is the right answer rather than a conservative one,
     -- since that exchange IS where the binding came from. A declared pairing passes there anyway; a
     -- swept one is excluded there by the name it records for itself, and the old delivery-option
     -- proxy is kept for rows written before paired_by existed. Stated once here rather than copied
     -- into five FILTER clauses - that copying is what let the derived path's two halves drift.
     -- COALESCE so the value is a strict boolean: measured and NOT measured must partition the rows,
     -- and a NULL would fall out of both.
     --
     -- turn_id_source is already a column of v_turn_latency (migration 019 onward, carried by every
     -- redefinition since), so no view change is required.
     --
     -- AND A PLACEHOLDER ANCHORED BY ITS DECLARED TARGET IS MEASURED (080). A receipt or a notice
     -- written into a placeholder pairs with nothing; the view anchors it on the moved answer's exchange
     -- for the message it declared, and never through a swept one, so its first feedback is a measured
     -- one. Without this arm the turn's TTFF would be computed and then filtered out.
     LEFT JOIN LATERAL (
       SELECT (COALESCE(vl.anchor_source = 'ledger' AND vl.turn_id_source IS DISTINCT FROM 'paired', FALSE)
               OR COALESCE(vl.anchor_source = 'declared_target', FALSE)
               OR (e.paired_by IS DISTINCT FROM 'swept'
                   AND (e.paired_by IS NOT NULL OR e.delivery_option IS NOT NULL))) AS measured
     ) mp ON TRUE
     -- THE HOP IN FRONT OF THE ROUTER (090): when the channel flow received the message and when the
     -- router began, both server-clock ledger rows on this response. Standard path only.
     LEFT JOIN LATERAL (
       SELECT MIN(te.occurred_at) FILTER (WHERE te.kind = 'flow_received') AS flow_at,
              MIN(te.occurred_at) FILTER (WHERE te.kind = 'router_step' AND te.step_name = 'entry') AS router_entry_at
         FROM turn_events te
        WHERE te.response_id = m.message_id AND te.channel_arn = m.channel_arn
          AND te.kind IN ('flow_received', 'router_step')
     ) fr ON TRUE
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
         WHEN l.outcome = 'cancelled'                       THEN 'cancelled'
         WHEN l.outcome = 'awaiting'                        THEN 'awaiting'
         WHEN l.outcome = 'silent'                          THEN 'silent'
       END AS unclosed_bucket
     ) b ON TRUE
     -- ── THE POPULATION (LATENCY_TURN_POPULATION_SQL), shared with the drill ──
       -- ONE TURN IS ONE ROW HERE. A bot reply is stored twice: the canonical CREATE
       -- row, and one row per update event (migration 084), the latest holding the finalized text for
       -- the conversation browser. An update row carries total_ms, so without this filter every turn's compute was counted TWICE - and
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
       -- agent_final_at, which is what e2e_ms is derived from. An update row carries no timing the
       -- canonical row lacks. It is a STEP to be measured, not a turn to be counted.
       -- total_ms is NO LONGER filtered here. It moved into FILTER clauses on the compute aggregates
       -- above, so a response that ran no measurable compute is COUNTED and attributed rather than
       -- vanishing from the population. The compute averages are unchanged - a null contributes
       -- nothing to AVG or PERCENTILE_CONT either way - but the counts beside them are now honest
       -- about what they are averaging over.
       --
       -- ── THE POPULATION IS ASSISTANT TURNS, AND ONLY THOSE (owner direction, 2026-09-13) ────────
       --
       -- "All assistant exchanges must be caught and any non assistant exchanges should be excluded."
       -- Until this clause, the population was every bot-authored CREATE - so deferral notices,
       -- welcomes, drift notices and "I could not start on that" were counted as exchanges. MEASURED
       -- 2026-09-13: 73 of the day's 132 rows. They carry no telemetry of any kind (total_ms NULL,
       -- delivery_option NULL, no TTFF measured OR reconstructed) and no exchange row, so they moved
       -- no average - AVG and PERCENTILE_CONT skip a NULL either way - but they inflated every COUNT
       -- and they all landed in the 'unknown' classification bucket, which is why that bucket was the
       -- largest thing on the tab and meant nothing.
       --
       -- THREE WAYS TO BE A TURN, because the failures have to stay visible. Taking only the first
       -- would delete exactly the rows worth seeing: a turn whose pairing failed has no exchange, and
       -- unpaired_bot_messages shows that population is real answers - it reports intents like
       -- code_review and financial_metric, and most carry a correlation marker. Excluding them
       -- would hide a pairing defect by removing its evidence, which is the mistake the comment above
       -- records for total_ms.
       --
       --   e.id IS NOT NULL         it answered a user message - paired, by declaration or otherwise
       --   m.total_ms IS NOT NULL   it ran a model, so it was a turn even if nothing paired to it
       --   a correlation marker     it IS an answer: the marker is how a turn claims its placeholder,
       --                            and nothing that is not answering a person emits one
       --
       -- WHAT 'unknown' MEANS AFTER THIS, and it is now worth reading: a real assistant turn whose
       -- classification could not be resolved from the exchange, the conversation or the message.
       -- That is a defect to chase rather than a bucket of notices to ignore.
     WHERE ${LATENCY_TURN_POPULATION_SQL}
     -- ONE EXPRESSION PER DIMENSION (LATENCY_DIM), shared with the SELECT above and the drill's filters.
     -- Postgres groups by the expression, not by the alias, so the SELECT and the GROUP BY must state
     -- the same text, and stating it once is what keeps them the same.
     GROUP BY ${LATENCY_DIM.day}, ${LATENCY_DIM.assistant}, ${LATENCY_DIM.label}, ${LATENCY_DIM.entry},
              ${LATENCY_DIM.role}, ${LATENCY_DIM.version},
              ${LATENCY_DIM.round},
              ${LATENCY_DIM.classification}
     )
     SELECT grid.*, mm.turn_models
       FROM grid
       -- One model_mix row per grid row at most: both are grouped on the same eight expressions.
       -- profile_version is the one nullable key, so it is compared NULL-safe.
       LEFT JOIN model_mix mm
         ON mm.date = grid.date AND mm.assistant = grid.assistant
        AND mm.delivery_option = grid.delivery_option AND mm.turn_entry = grid.turn_entry
        AND mm.assistant_role = grid.assistant_role
        AND mm.profile_version IS NOT DISTINCT FROM grid.profile_version
        AND mm.battle_round = grid.battle_round
        AND mm.conversation_classification = grid.conversation_classification
     ORDER BY grid.date DESC, grid.assistant, grid.delivery_option, grid.turn_entry`,
    [win.range]
  );

  return success({
    data: (result.rows as Array<Record<string, unknown>>).map(priceLatencyRow),
    columns: [
      'date', 'assistant', 'delivery_option', 'assistant_turn_count',
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
      'unclosed_superseded', 'unclosed_cancelled', 'unclosed_awaiting', 'unclosed_silent',
      'avg_ttff_ms', 'p95_ttff_ms',
      // Appended, like every column before them, so the existing contract stays byte-for-byte intact.
      'assistant_role', 'profile_version', 'conversation_classification',
      // Which duel round a row belongs to, or 'none'. Appended for the same reason: it gives the
      // grid the field it needed to tell duel traffic from production traffic, which every figure
      // on this surface pooled until now.
      'battle_round',
      // The TTFF population, split by whether the pairing was MEASURED or RECONSTRUCTED by the
      // cross-batch fallback. Appended, so the existing contract is untouched: LatencyTab already
      // skips a null avg_ttff_ms when it traffic-weights, which is what a reconstructed-only group
      // now returns.
      'ttff_measured_count', 'ttff_reconstructed_count',
      'avg_ttff_outside_router_ms', 'ttff_router_paired_count',
      // The time outside the router, split where the channel flow recorded its receipt (090).
      'avg_to_flow_ms', 'avg_flow_to_router_ms', 'avg_placeholder_return_ms', 'flow_split_count',
      // Locating the placeholder, split into the cost and the rate (migration 030). `avg_poll_ms`
      // keeps its name and its position in the contract above; what changed is that it now means
      // the SCAN alone and is conditional on one having happened.
      'avg_router_ms', 'avg_classifier_ms', 'classified_by_model_count', 'avg_router_other_ms',
      'avg_guard_ms', 'avg_placeholder_resolve_ms', 'avg_processor_tail_ms',
      'placeholder_measured_count', 'poll_fallback_count',
      'avg_e2e_ms', 'p95_e2e_ms',
      'avg_model_ms', 'avg_tool_ms', 'avg_inbound_ms',
      // G9. The denominator each percentile is actually taken over, and the cold-start rate that is
      // the sanctioned explanation for a TTFF/worker-compute divergence. Appended, like every
      // addition before them, so the existing contract is untouched.
      'p95_total_sample_count', 'p95_bedrock_sample_count',
      'cold_start_count', 'avg_ttff_warm_ms',
      // The population behind each step average, and the unpaired share of the turn count.
      'router_measured_count', 'guard_measured_count', 'unpaired_turn_count',
      // The ledger repoint: the turns the derived path measured and the ledger read does not. Appended,
      // like every addition before it, so the existing contract is untouched.
      'ttff_ledger_unmeasured_count',
      // HOW THE TURN ENTERED (migration 054), a GROUPING key rather than a metric, and appended like
      // every addition before it so the existing contract is byte-for-byte intact. Its position in
      // this list is not its position in the GROUP BY: rows are objects keyed by name, and inserting
      // it beside the other grouping keys is what broke the contract this comment is about.
      'turn_entry',
      // EVERY TURN NAMED AND MEASURED. Each turn's own span from its own start
      // (turn_ms, with the partition of where each start came from), and what each group spent.
      // Appended, like every addition before them.
      'avg_turn_ms', 'p95_turn_ms', 'turn_measured_count',
      'turn_span_person_count', 'turn_span_trigger_count', 'turn_span_ack_count', 'turn_span_processor_count',
      'turn_span_membership_count',
      'tokens_in', 'tokens_out', 'classifier_tokens_in', 'classifier_tokens_out', 'token_measured_count',
      'cost_usd', 'cost_priced_turns',
      // A TURN THE QUEUE RELEASED is timed from that release, and counted apart so
      // the partition of turn_measured_count stays whole. Appended, like every addition before it.
      'turn_span_queue_release_count',
      // A RECEIPT IS NOT A SECOND SPAN of the wait its moved answer carries. Counted
      // apart from the partition so the gap stays readable. Appended.
      'turn_carried_by_answer_count',
    ],
  });
}

/**
 * WHAT ONE LATENCY GROUP COST, priced from the per-(leg, model) token sums the query aggregated
 * (`turn_models`, the model_mix CTE: `{ leg, model, replies, tokensIn, tokensOut }`, a handful per
 * group rather than one per turn), which this then removes from the row.
 *
 * The same pricing the Effectiveness cost column uses (`blendMixCostUsd`): every leg adds to the spend,
 * only the answer leg counts as a priced turn, and a slice the rate table cannot price is skipped and
 * left out of `cost_priced_turns`, so the cost and its denominator describe the same turns.
 * `cost_usd` is null when nothing in the group was priceable, never 0 - a group of readings that ran no
 * model and a group whose model has no rate are different findings.
 */
export function priceLatencyRow(row: Record<string, unknown>): Record<string, unknown> {
  const { turn_models: turnModels, ...rest } = row;
  const slices = new Map<string, ReplyModelSlice>();
  for (const t of Array.isArray(turnModels) ? turnModels as Array<Record<string, unknown>> : []) {
    const { model } = t;
    const leg = t.leg === 'classifier' ? 'classifier' : 'answer';
    if (typeof model !== 'string' || !model) continue;
    // Keyed again so a repeated (leg, model) entry still folds into one slice.
    const key = `${leg}|${model}`;
    const s = slices.get(key) ?? { model, leg, replies: 0, tokensIn: 0, tokensOut: 0 };
    s.replies = Number(s.replies) + (Number(t.replies) || 0);
    s.tokensIn = Number(s.tokensIn) + (Number(t.tokensIn) || 0);
    s.tokensOut = Number(s.tokensOut) + (Number(t.tokensOut) || 0);
    slices.set(key, s);
  }
  const { usd, replies } = blendMixCostUsd([...slices.values()]);
  const pricedAny = [...slices.values()].some((s) => estimateStepCostUsd({
    modelId: String(s.model), tokensIn: Number(s.tokensIn), tokensOut: Number(s.tokensOut),
  }) != null);
  return {
    ...rest,
    cost_usd: pricedAny ? Math.round(usd * 1e6) / 1e6 : null,
    cost_priced_turns: replies,
  };
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
 * separate update rows must be excluded or every turn is counted more than once.
 */
async function getModelUsage(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 7, 180);

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
       AND m.created_at >= lower($1::tstzrange) AND m.created_at < upper($1::tstzrange)
       -- ONE ASSISTANT'S SPEND, for a team route: the messages answering an exchange that assistant
       -- answered, in a room the session's clearance reaches. Attributed per turn, so a room with
       -- several assistants splits correctly; a message no exchange claims is nobody's, and stays out.
       AND ($2::text IS NULL OR EXISTS (
             SELECT 1 FROM exchanges ae
              WHERE ae.agent_message_id = m.id
                AND ($2::text IS NULL OR ae.assistant = $2)
       AND ($3::text[] IS NULL OR ae.conversation_classification = ANY($3))))
     GROUP BY m.bedrock_model
     ORDER BY message_count DESC`,
    [win.range, params.agentType ?? null, teamClassificationsOf(params)]
  );

  return success({ data: result.rows });
}

/**
 * GET /analytics/model-effectiveness - Compare deployed models by intent
 */
async function getModelEffectiveness(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);

  const result = await query(
    `SELECT
       CASE
         WHEN m.bedrock_model IS NOT NULL THEN m.bedrock_model
         -- A DIRECT ANSWER RAN NO MODEL BY DESIGN, AND IT IS STILL AN ANSWER.
         --
         -- MESSAGE-FLOW section 2.5 settles this: a direct answer "pairs into an exchange - yes, on
         -- the target it declares", and DeliveryOption.DIRECT is defined as "immediate response
         -- without Bedrock" for greetings and acknowledgments. So these rows belong in the population
         -- and always did; what was wrong was calling them 'unknown', which claimed an attribution
         -- defect where the deployment is working exactly as specified.
         --
         -- READ FROM THE DECLARED DELIVERY OPTION, not inferred from missing telemetry. An earlier
         -- version of this guessed - "bot-authored with no total_ms" - and that guess swept up four
         -- marker-carrying turns that HAD lost their attribution, hiding the real defect inside the
         -- bucket for the healthy one. The turn states how it was delivered; this reads what it said.
         WHEN e.delivery_option = 'DIRECT' THEN 'direct answer (no model by design)'
         -- A DECLARED KIND IN THE EXCHANGE POPULATION IS A PAIRING DEFECT, NOT A LABEL PROBLEM.
         --
         -- MESSAGE-FLOW section 2.5: a drift suggestion and a deferral notice each pair into an
         -- exchange - NO, and say so rather than being excluded by an absence. Both archival
         -- pairing paths already refuse a row that declared a kind, so one reaching here means the
         -- pairing let it through - historical rows from before the declaration shipped, or a
         -- producer that is not declaring. Naming it here does not fix that; it makes it COUNTABLE,
         -- so the size of the pairing defect is visible instead of being spread across model
         -- buckets or hidden under a label that sounds fine.
         WHEN COALESCE(m.turn_kind, m.metadata->>'turnKind') IS NOT NULL
           THEN 'NOT AN ANSWER: ' || COALESCE(m.turn_kind, m.metadata->>'turnKind') || ' (pairing defect)'
         -- Ran a model and lost the attribution. THIS is the defect, and it now has the word to
         -- itself instead of sharing one with a fifth of the traffic.
         ELSE 'unknown'
       END AS model_name,
       COALESCE(e.intent, 'unknown') AS intent,
       COUNT(*) AS exchange_count,
       -- AN UNJUDGED EXCHANGE IS NOT A ZERO, and coalescing it to one made this the only score in
       -- the console computed on a different convention from its own neighbors.
       --
       -- Judging is a SAMPLE and a backlog: evaluation-runner.ts draws EVAL_SAMPLE_PERCENT by
       -- hash and works a bounded batch per run, so at any moment most exchanges are unscored by
       -- design. Zero-filling that tail meant avg_score measured evaluation COVERAGE far more than
       -- it measured quality, fell as traffic grew, and rose when the backlog caught up. It is read
       -- as a verdict - alerts.ts raises "evaluated quality below target" from this column - so the
       -- alert fired on how much had been judged rather than on how good it was.
       --
       -- AVG already skips NULL, so the average is over scored exchanges and scored_count beside
       -- it says how many that was. This is the convention getEvaluationMetrics states ("NULL IS A
       -- THIRD STATE ... never coalesced") and the one the Effectiveness relevance column already
       -- follows; three conventions in one file is how they came apart.
       ROUND(AVG(er.relevance_score)::numeric, 1) AS avg_score,
       COUNT(*) FILTER (WHERE er.relevance_score IS NOT NULL) AS scored_count,
       -- THE SAME RULE FOR TIMING. A turn that recorded no duration entered as 0 ms and reported
       -- itself as instant, which flatters exactly the rows whose telemetry is broken.
       ROUND(AVG(COALESCE(m.total_ms, e.response_latency_ms))::numeric, 0) AS avg_total_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY COALESCE(m.total_ms, e.response_latency_ms))::numeric, 0) AS p95_total_ms,
       COUNT(*) FILTER (WHERE COALESCE(m.total_ms, e.response_latency_ms) IS NOT NULL) AS timed_count,
       ROUND(
         (COUNT(*) FILTER (WHERE er.is_compliant IS TRUE) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE er.is_compliant IS NOT NULL), 0))::numeric,
         1
       ) AS compliance_rate,
       COUNT(*) FILTER (WHERE er.classification = 'excellent') AS excellent_count,
       COUNT(*) FILTER (WHERE er.classification IN ('poor', 'irrelevant', 'error_response')) AS poor_count
     FROM exchanges e
     LEFT JOIN messages m ON e.agent_message_id = m.id
     -- ONE ROW PER EXCHANGE, MOST RECENT SCORING WINS.
     --
     -- A re-scored exchange has SEVERAL evaluation_results rows, so joining them raw multiplied
     -- every COUNT taken over this join and inflated the totals - and the two panels most likely
     -- to be re-scored are the ones an operator re-scores BECAUSE they looked wrong.
     --
     -- The latest evaluation rather than an average, because classification and compliance are
     -- CATEGORICAL: a relevance score can be averaged and a verdict cannot, and the latest is what
     -- a person reading a re-scored exchange means by "its" score. evaluated_at DESC is indexed
     -- (idx_evaluation_date), and the evaluation_type filter is the one line 467 already carried.
     LEFT JOIN (
       SELECT DISTINCT ON (exchange_id)
              exchange_id, id, relevance_score, classification, reasoning, is_compliant, flags
         FROM evaluation_results
        WHERE evaluation_type = 'exchange'
        ORDER BY exchange_id, evaluated_at DESC
     ) er ON er.exchange_id = e.id
     WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
       -- A QUEUED EXCHANGE IS NOT ITS OWN TURN (052). A folded answer mints one exchange per queued
       -- message it rolled in, all pointing at the same agent message, so without this every column
       -- here is weighted by HOW MANY MESSAGES SOMEBODY TYPED WHILE THE ASSISTANT WAS BUSY: one
       -- answer to an impatient person counts three times, and its model, score and compliance carry
       -- triple the weight of the same answer to a patient one.
       --
       -- Every sibling reader carries this and says why - intent effectiveness, evaluation metrics,
       -- experiment results and both battle queries. This query was the one that did not, which is
       -- the shape a convention fails in: not by being argued away, by being missed once.
       AND e.queued_as IS NULL
       -- ── THESE ROWS STAY IN. EXCLUDING THEM WAS THE MISTAKE (owner correction, 2026-09-14) ─────
       --
       -- 151 of 797 exchanges over 30 days grouped as model 'unknown' / intent 'unknown', and a
       -- population filter was added here to drop them - greetings, drift notices and split
       -- confirmations - on the reasoning that "no model ran". Both halves of that were wrong, and the
       -- filter was taken straight back out.
       --
       -- WHY "NO MODEL RAN" IS FALSE. The notice TEXT is a constant (drift-detection.ts, and
       -- delivery-options.ts for the quick response), but the turn is not free: drift detection runs
       -- an embedding call to decide the topic moved, and that is model work with a real cost. A
       -- canned sentence at the end of a model decision is not an absent model call.
       --
       -- WHY THE MARKER PROVED NOTHING. The filter leaned on "0 of 26 carried a correlation marker".
       -- a-deferral-is-a-measured-response.test.ts states that a notice carries no marker BY
       -- CONSTRUCTION - which is exactly why the acknowledged message id had to travel on the notice
       -- instead. An absent marker is a documented property of this message kind, not evidence that
       -- it was never a response.
       --
       -- AND THE DIRECTION IS THE WHOLE POINT. That same work records what excluding a population
       -- does: "It was not a bad number, it was an ABSENT one - queued turns left the latency
       -- population entirely, the averages stayed healthy, and the wait the platform deliberately
       -- imposes appeared nowhere." A filter here reproduces that failure precisely - it would make
       -- this panel's averages healthier by deleting the turns that drag them down.
       --
       -- SO THE BUCKET IS LABELLED, NOT DROPPED. A notice has no model to compare, and saying
       -- 'unknown' claimed an attribution defect where there is none. It is named for what it is, so
       -- the count stays visible and a genuine attribution failure - a turn that DID call a model and
       -- lost the record - is no longer hidden inside the same word. That residual is what
       -- model-backfill.ts exists to repair, from the out-of-band analytics store.
       -- One assistant's turns in rooms the session's clearance reaches, on a team route.
       AND ($2::text IS NULL OR e.assistant = $2)
       AND ($3::text[] IS NULL OR e.conversation_classification = ANY($3))
     -- MUST MATCH THE SELECT EXPRESSION EXACTLY: Postgres groups by the expression, not the alias,
     -- so an edit in one place and not the other is a hard error at query time - which on this path
     -- means the whole tab returns an error rather than a wrong number.
     GROUP BY CASE
         WHEN m.bedrock_model IS NOT NULL THEN m.bedrock_model
         -- A DIRECT ANSWER RAN NO MODEL BY DESIGN, AND IT IS STILL AN ANSWER.
         --
         -- MESSAGE-FLOW section 2.5 settles this: a direct answer "pairs into an exchange - yes, on
         -- the target it declares", and DeliveryOption.DIRECT is defined as "immediate response
         -- without Bedrock" for greetings and acknowledgments. So these rows belong in the population
         -- and always did; what was wrong was calling them 'unknown', which claimed an attribution
         -- defect where the deployment is working exactly as specified.
         --
         -- READ FROM THE DECLARED DELIVERY OPTION, not inferred from missing telemetry. An earlier
         -- version of this guessed - "bot-authored with no total_ms" - and that guess swept up four
         -- marker-carrying turns that HAD lost their attribution, hiding the real defect inside the
         -- bucket for the healthy one. The turn states how it was delivered; this reads what it said.
         WHEN e.delivery_option = 'DIRECT' THEN 'direct answer (no model by design)'
         -- A DECLARED KIND IN THE EXCHANGE POPULATION IS A PAIRING DEFECT, NOT A LABEL PROBLEM.
         --
         -- MESSAGE-FLOW section 2.5: a drift suggestion and a deferral notice each pair into an
         -- exchange - NO, and say so rather than being excluded by an absence. Both archival
         -- pairing paths already refuse a row that declared a kind, so one reaching here means the
         -- pairing let it through - historical rows from before the declaration shipped, or a
         -- producer that is not declaring. Naming it here does not fix that; it makes it COUNTABLE,
         -- so the size of the pairing defect is visible instead of being spread across model
         -- buckets or hidden under a label that sounds fine.
         WHEN COALESCE(m.turn_kind, m.metadata->>'turnKind') IS NOT NULL
           THEN 'NOT AN ANSWER: ' || COALESCE(m.turn_kind, m.metadata->>'turnKind') || ' (pairing defect)'
         -- Ran a model and lost the attribution. THIS is the defect, and it now has the word to
         -- itself instead of sharing one with a fifth of the traffic.
         ELSE 'unknown'
       END, COALESCE(e.intent, 'unknown')
     -- NULLS LAST, because avg_score is now genuinely absent for a group nothing has judged. The
     -- default for DESC puts NULLs FIRST, which would head the table with the groups carrying the
     -- least evidence.
     ORDER BY exchange_count DESC, avg_score DESC NULLS LAST`,
    [win.range, params.agentType ?? null, teamClassificationsOf(params)]
  );

  return success({
    data: result.rows,
    columns: [
      'model_name',
      'intent',
      'exchange_count',
      'avg_score',
      // THE DENOMINATOR TRAVELS WITH THE AVERAGE. A score with no population behind it cannot be
      // told apart from a score with a thousand, and this column is read as a quality verdict.
      'scored_count',
      'avg_total_ms',
      'p95_total_ms',
      'timed_count',
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
export interface ReplyModelSlice {
  model?: string | null;
  /**
   * WHICH LEG OF THE TURN this slice paid for: 'answer' or 'classifier'.
   *
   * A reply is ONE reply however many model calls it took, so only the answer legs count toward the
   * denominator - summing both would halve the rate on every turn that classified. Absent on a
   * deployment whose query predates migration 063, and treated as an answer so the old shape still
   * divides correctly.
   */
  leg?: string | null;
  replies?: string | number | null;
  tokensIn?: string | number | null;
  tokensOut?: string | number | null;
}

/**
 * Price a model mix, returning BOTH the total and the replies that total covers.
 *
 * ONE FUNCTION FOR BOTH NUMBERS, deliberately: `cost_per_reply_usd` and `cost_priced_replies` are a
 * rate and its denominator, and computing them separately is how a rate ends up describing a different
 * population than the count printed beside it.
 *
 * A SLICE THIS BUILD CANNOT PRICE IS SKIPPED, NOT FATAL, and this is a correction to the first version
 * of this change. Returning null for the whole intent was defensible - better than silently costing
 * part of it as the whole - but it blanked real information: measured live, report_generation lost its
 * figure entirely because one turn ran an old Haiku the rate table has no entry for, taking 39
 * priceable replies down with it. Skipping the slice and REPORTING THE DENOMINATOR is honest and
 * useful at once, which is the pattern every other rate on this surface already follows.
 */
function blendMixCostUsd(mix: ReplyModelSlice[]): { usd: number; replies: number } {
  let usd = 0;
  let replies = 0;
  for (const slice of mix) {
    const sliceReplies = Number(slice.replies) || 0;
    if (sliceReplies <= 0) continue;
    // EVERY LEG ADDS TO THE SPEND; ONLY THE ANSWER ADDS TO THE DENOMINATOR. A turn that classified on
    // Haiku and answered on Opus is one reply that cost two calls, and counting it twice below would
    // report half of what it actually cost.
    const isAnswerLeg = !slice.leg || slice.leg === 'answer';
    const sliceCost = estimateStepCostUsd({
      modelId: String(slice.model),
      tokensIn: slice.tokensIn === null || slice.tokensIn === undefined ? undefined : Number(slice.tokensIn),
      tokensOut: slice.tokensOut === null || slice.tokensOut === undefined ? undefined : Number(slice.tokensOut),
    });
    if (sliceCost === null || sliceCost === undefined) continue;
    usd += sliceCost;
    if (isAnswerLeg) replies += sliceReplies;
  }
  return { usd, replies };
}

/**
 * How many replies `cost_per_reply_usd` was actually averaged over.
 *
 * NOT `exchange_count`, and the difference is the point. A turn whose model was never recorded cannot
 * be priced, and neither can one whose model this build has no rate for - both are skipped, so the
 * rate describes a smaller population than the reply count beside it. Measured live: general 270 of
 * 273, report_generation 39 of 44. Small here, and it would not be on a deployment where model
 * attribution is failing, which is exactly when somebody needs to see it.
 *
 * Shares `blendMixCostUsd` with the cost itself so the two can never describe different populations.
 */
export function resolveCostPricedReplies(row: { model_mix?: ReplyModelSlice[] | null }): number | null {
  if (!Array.isArray(row.model_mix)) return null;
  return blendMixCostUsd(row.model_mix.filter((sl) => sl && sl.model)).replies;
}

export function resolveReplyCostUsd(row: {
  dominant_model?: string | null;
  avg_input_tokens?: string | number | null;
  avg_output_tokens?: string | number | null;
  avg_image_count?: string | number | null;
  model_mix?: ReplyModelSlice[] | null;
}): number | null {
  const toNum = (v: string | number | null | undefined): number | undefined =>
    v === null || v === undefined ? undefined : Number(v);

  // ── EVERY MODEL PRICED AT ITS OWN RATE, THEN DIVIDED ONCE ───────────────────────────────────────
  //
  // This used to price the intent's AVERAGE tokens at `dominant_model` - a MODE, the single
  // commonest model. Exact for an intent served by one model and silently wrong for any other, with
  // no way for a reader to tell which they were looking at. Measured live: `general` ran 57 replies
  // on Haiku, 30 on Sonnet and 170 on Opus, and the mode charged all 257 at the Opus rate, overstating
  // the intent by about 40%.
  //
  // A SLICE THIS BUILD CANNOT PRICE MAKES THE WHOLE FIGURE NULL rather than being dropped. Skipping
  // it would silently report the cost of the priceable part as the cost of the intent, which is the
  // same error one level down - and `model-rate-table` returns NULL for an unknown model precisely so
  // an unpriceable thing is visible rather than guessed at.
  // AN IMAGE INTENT KEEPS THE LEGACY PATH. An image model prices PER IMAGE and reports no tokens, so
  // there is nothing for the token blend to work with - it would price every slice at null and blank
  // the column. The mix carries no per-slice image count, so the dominant-model route is the only one
  // that can answer here. Checked before the blend, not after, because the blend would return first.
  const dominantIsImage = row.dominant_model ? imageGenModelIdToKey(row.dominant_model) != null : false;
  const mix = dominantIsImage || !Array.isArray(row.model_mix)
    ? []
    : row.model_mix.filter((sl) => sl && sl.model);
  if (mix.length > 0) {
    const blend = blendMixCostUsd(mix);
    // Null only when NOTHING in the mix could be priced. A partly-priceable intent returns the cost of
    // the part that could be, and `cost_priced_replies` beside it says how many replies that was.
    return blend.replies > 0 ? blend.usd / blend.replies : null;
  }

  // FALLBACK for a deployment whose query predates `model_mix`, and for the image path, which prices
  // per image rather than per token and has no slice shape.
  const modelId = row.dominant_model || undefined;
  if (!modelId) return null;
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
 * Effectiveness L0 dashboard (SPEC-ADMIN-CONSOLE-EFFECTIVENESS, User Experience Description and
 * Mocks): one row per intent, the two-stage
 * quality split plus latency, cost, and the tool lens — the "how effective is each capability" question
 * the artifact-type tabs cannot answer. Columns:
 *  - Classification: `avg_confidence` (high/medium/low → 100/50/0). NOT `reroute_rate`: removed
 *    2026-09-22 with its target retired in place, because nothing writes `was_rerouted` and the
 *    classifier does not reclassify a turn, so the share was structurally zero.
 *  - Execution: DIRECT → `direct_relevance` (Pass A); Task → `task_completion_rate` × `flow_composite`
 *    (the documented 30/25/15/15/15 weighting over intent_flows).
 *  - Latency: `avg_total_ms`, `p95_total_ms`.
 *  - Cost: token averages + `dominant_model`; `cost_per_reply_usd` resolved in JS (D4).
 *  - Tools (P2): `tool_calls`, `tool_errors`, `tool_error_rate` from steps[].tools[] in message metadata.
 *    `tool_errors` counts failures only. A call the task workflow refused by a declared rule
 *    (`errorClass: 'workflow_refusal'`) is in `tool_calls` and in `workflow_refusals`, not in the errors.
 *  - Platform actions: `platform_actions`, the declared step actions the platform ran (steps[].action),
 *    counted apart from the model's `tool_calls`.
 *
 * Ranking (worst-first) and status colors are the frontend's job via metricTargets; this returns the
 * raw metrics. Eval scores are pre-aggregated to ONE relevance per exchange so multiple Pass-A runs
 * never multiply the exchange counts.
 *
 * Serves BOTH L0 and L1 (§5): with no `intent` param it returns every intent (the dashboard); with
 * `intent` set it returns that one intent's row (the drill). `$2` is the intent-or-NULL filter — the
 * `$2 IS NULL OR col = $2` idiom keeps it one query with a fixed param list, no dynamic SQL.
 */
/**
 * The smallest gap between a row's direct relevance average and any target that its population can detect,
 * rounded to one place, or null when nothing was scored. Uses the experiment statistics' power math
 * over the CONVERSATIONS behind the average, the conservative reading of clustered turns.
 */
export function relevanceMdd(r: Record<string, unknown>): number | null {
  const n = Number(r.direct_relevance_conversations ?? 0);
  const sd = Number(r.direct_relevance_sd);
  if (!(n > 0) || !Number.isFinite(sd)) return null;
  const mdd = minimumDetectableDifference(sd, n);
  return Number.isFinite(mdd) ? Math.round(mdd * 10) / 10 : null;
}

async function getIntentEffectiveness(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const intent = params.intent || null; // null => L0 (all intents); set => L1 (one intent)
  // Optional ASSISTANT filter ($3) — scope the whole view to the exchanges/flows a SPECIFIC ASSISTANT
  // answered, via `agent_type` (the responder's identity), NOT `conversation_classification` (the room's).
  //
  // THEY NO LONGER COINCIDE, which is what this filter was always for. `agent_type` carried the
  // classification while every classification had one assistant named after it, so scoping "to this
  // assistant" separated nothing; it carries the assistant's own identifier now, so the
  // filter does what its name says and two assistants in one classification are two rows.
  // Null ⇒ all assistants. Used by the "view this assistant's effectiveness" link.
  const agentType = params.agentType || null;
  // Optional CLASSIFICATION filter ($4) — the ROOM's, which is a different question and now has to be
  // asked separately. It used to ride `agentType` because the two strings matched; a console that kept
  // doing that would silently filter by assistant while its dropdown said classification, and would
  // return nothing at all once an assistant was renamed. Null ⇒ every classification.
  const conversationClassification = params.conversationClassification || null;
  // A SET of rooms' classifications, for a team session: the classifications its holder's clearance
  // reaches. A turn whose room has no recorded classification matches nothing here, so it fails closed.
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  // Optional ROLE ($6) and PROFILE VERSION ($7). "Which assistant" is three questions once a
  // classification holds more than one: which assistant, in which role, running which version. Role
  // is constant today (one is declared), and the filter exists so the dimension is usable the day it
  // is not. Version answers "did v4 regress against v3" without re-reading a JSON key per row.
  const assistantRole = params.assistantRole || null;
  const profileVersionRaw = params.profileVersion;
  const profileVersion = profileVersionRaw !== undefined && profileVersionRaw !== ''
    && Number.isInteger(Number(profileVersionRaw))
    ? Number(profileVersionRaw)
    : null;

  const result = await query(
    `WITH ex_agg AS (
       SELECT ${WORK_INTENT_SQL('e')} AS intent,
              COUNT(DISTINCT e.id) AS exchange_count,
              COUNT(DISTINCT e.id) FILTER (WHERE e.task_id IS NULL) AS direct_count,
              COUNT(DISTINCT e.task_id) AS task_count,
              ROUND(AVG(CASE e.intent_confidence
                          WHEN 'high' THEN 100 WHEN 'medium' THEN 50 WHEN 'low' THEN 0 END)::numeric, 1)
                AS avg_confidence,
              -- NO reroute_rate. It was removed from the console on 2026-09-22 and its target retired
              -- in place, for a reason that applies here too: the classifier does not reclassify a turn
              -- at all, so this is not an uninstrumented behavior waiting for a writer (see
              -- metricTargets.ts). Nothing writes was_rerouted, so the share was structurally zero and
              -- always would be.
              --
              -- Removed rather than left computing, because a returned column is an answer: any other
              -- consumer of this API got the number the console deleted for being unreadable, with
              -- nothing saying it was dead. One fact, one source (tenet D7).
              --
              -- NO BACKTICKS IN HERE. This whole statement is a TypeScript template literal, so a
              -- backtick around an identifier ends the string it sits in - three parse errors, from a
              -- comment. The repo keeps a-backtick-in-sql-ends-the-string-it-sits-in.test.ts for this.
              -- ── RELEVANCE IS ABOUT A MESSAGE, SO IT COVERS EVERY MESSAGE ──
              --
              -- This was restricted to "task_id IS NULL" and named "direct_relevance", which made it
              -- the DIRECT half of an either/or: the console showed relevance OR completion depending
              -- on which shape a row's traffic happened to favour. The two answer different questions -
              -- was the answer any good, and did the work finish - so one column could not carry both,
              -- and two intents in it were not comparable.
              --
              -- Relevance applies to a turn inside a task exactly as it does to a one-shot reply. The
              -- unfiltered average is the one the column shows; the direct-only figure is kept beside
              -- it because the L2 drill still splits by delivery and would otherwise have no anchor.
              ROUND(AVG(er.relevance_score)::numeric, 1) AS avg_relevance,
              ROUND(AVG(er.relevance_score) FILTER (WHERE e.task_id IS NULL)::numeric, 1) AS direct_relevance,
              COUNT(*) FILTER (WHERE er.relevance_score IS NOT NULL) AS relevance_scored_count,
              -- THE SPREAD AND THE CONVERSATIONS BEHIND THE DIRECT AVERAGE (SPEC-EVALUATION Appendix C4),
              -- the population the console's relevance alert reads, so the smallest gap from target it can
              -- detect is computed rather than assumed. Conversations, not turns, is the effective
              -- population: turns in one conversation are not independent, and counting them as if they
              -- were would let one long thread raise an alert.
              STDDEV_SAMP(er.relevance_score) FILTER (WHERE e.task_id IS NULL) AS direct_relevance_sd,
              COUNT(DISTINCT e.channel_arn) FILTER (WHERE er.relevance_score IS NOT NULL AND e.task_id IS NULL) AS direct_relevance_conversations,
       -- Grounded share over the exchanges a judge COULD assess, never over all of them: a turn that
       -- retrieved nothing has no ground to check against, and counting it as ungrounded would report
       -- a retrieval failure where there was no retrieval.
       ROUND((COUNT(*) FILTER (WHERE er.is_grounded IS TRUE) * 100.0)
             / NULLIF(COUNT(*) FILTER (WHERE er.is_grounded IS NOT NULL), 0), 1) AS groundedness_rate,
       COUNT(*) FILTER (WHERE er.is_grounded IS NOT NULL) AS groundedness_assessed_count,
       ROUND(AVG(er.retrieved_passage_count) FILTER (WHERE er.retrieved_passage_count > 0), 1) AS avg_retrieved_passages,
       -- WHICH RETRIEVED PASSAGES THE ANSWER USED (SPEC-EVALUATION Appendix C7): the share of retrieved
       -- passages the groundedness judge said the reply rests on, over the exchanges that carry both
       -- counts. A low share is a retrieval finding, owned by whoever curates the context source.
       ROUND((SUM(er.used_passage_count) FILTER (WHERE er.used_passage_count IS NOT NULL AND er.retrieved_passage_count > 0) * 100.0)
             / NULLIF(SUM(er.retrieved_passage_count) FILTER (WHERE er.used_passage_count IS NOT NULL AND er.retrieved_passage_count > 0), 0), 1)
         AS passage_use_rate,
       COUNT(*) FILTER (WHERE er.used_passage_count IS NOT NULL AND er.retrieved_passage_count > 0) AS passage_use_assessed_count,
       -- The rubrics present in this window. More than one means the rows below were judged under
       -- different prompts and are not comparable - which is the only reason this column exists.
       COUNT(DISTINCT er.rubric_version) AS rubric_version_count,
       MAX(er.rubric_version) AS rubric_version,
       -- ── THE OTHER AXIS OF THE SAME PROBLEM: WHICH MODEL JUDGED ────────────────────────────────
       --
       -- The rubric version above segregates rows scored under different prompt WORDING. A judge swap
       -- re-baselines every score without touching a word of the prompt, and tenet P3 makes that an
       -- expected event: the harness outlives the model, and the model is a replaceable function call.
       -- So a fall in relevance is either a regression in the assistant or a different judge, and the
       -- reader can only tell which if the model is readable. It was recorded on every row and dropped
       -- at every query.
       --
       -- The count is the part that changes a reading: one judge is the ordinary case, and more than
       -- one means the average over these rows is not one number.
       COUNT(DISTINCT er.evaluator_model) AS evaluator_model_count,
       MAX(er.evaluator_model) AS evaluator_model,
       COUNT(*) FILTER (WHERE er.sample_stratum = 'always') AS sampled_always_count,
       COUNT(*) FILTER (WHERE er.sample_stratum = 'sampled') AS sampled_random_count,
              -- ── COMPLIANCE, ON THE SURFACE AURORA MODE ACTUALLY SHOWS ──────────────────────────
              --
              -- The aggregate rate and its coverage lived only on the Evaluations tab, which Aurora
              -- hides in favour of this drill - so the mode that WRITES compliance verdicts was the
              -- one with nowhere to read the rate. The per-exchange verdict was visible in the L2
              -- list; the rate was not visible anywhere.
              --
              -- Assessed rows only, and the denominator travels with the rate for the same reason it
              -- does everywhere else: a rate over an unjudged population is indistinguishable from a
              -- clean one. NULL when nothing in this intent has been assessed.
              ROUND((COUNT(*) FILTER (WHERE er.is_compliant IS TRUE) * 100.0
                     / NULLIF(COUNT(*) FILTER (WHERE er.is_compliant IS NOT NULL), 0))::numeric, 1)
                AS compliance_rate,
              COUNT(*) FILTER (WHERE er.is_compliant IS NOT NULL) AS compliance_assessed_count,
              COUNT(*) FILTER (WHERE er.is_compliant IS FALSE) AS violation_count,
              -- Graded by the rule set, not counted flat: blocking is the severity that means
              -- somebody needs to know today, and it is what the Alerts tab raises on.
              COUNT(*) FILTER (WHERE er.has_blocking_breach) AS blocking_violation_count,
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
              --
              -- THIS IS THE DEFINITION SERVED, NOT THE ASSISTANT THAT ANSWERED, and the two are different
              -- facts (migration 058). The filter this page is driven by selects on e.agent_type,
              -- the assistant; profileName is the profile that assistant was serving. They agree on ordinary
              -- traffic and come apart exactly on a cross-assistant variant, where an assistant serves a
              -- rival's definition - so a banner reading "Served by X" could name an assistant that
              -- did not answer the turns being counted.
              --
              -- The answering assistant travels beside it, and so does the NUMBER OF DEFINITIONS: MODE() collapses a
              -- mixed intent to whichever name won a plurality, and a count of one is the only case
              -- where printing that single name tells the whole story.
              -- Each read takes the archived column first and the metadata key after it (SERVED_PROFILE_SQL).
              MODE() WITHIN GROUP (ORDER BY ${SERVED_PROFILE_SQL.name}) AS assistant,
              COUNT(DISTINCT ${SERVED_PROFILE_SQL.name}) AS assistant_definition_count,
              MODE() WITHIN GROUP (ORDER BY e.assistant) AS answering_assistant,
              MODE() WITHIN GROUP (ORDER BY ${SERVED_PROFILE_SQL.version}::text) AS profile_version,
              MODE() WITHIN GROUP (ORDER BY ${SERVED_PROFILE_SQL.configId}) AS profile_config_id
         FROM exchanges e
         LEFT JOIN messages m ON e.agent_message_id = m.id
         -- One relevance per exchange (a re-scored exchange has multiple evaluation_results rows;
         -- averaging them here keeps the LEFT JOIN 1:1 so exchange_count is not inflated).
         LEFT JOIN (
           SELECT exchange_id, AVG(relevance_score) AS relevance_score,
                  -- The verdict is CATEGORICAL and cannot be averaged. BOOL_AND ignores NULLs, so a
                  -- re-scored exchange reads as compliant only if every verdict it carries said so,
                  -- and stays NULL when none of them assessed it.
                  BOOL_AND(is_compliant) AS is_compliant,
                  -- WHETHER ANY VERDICT ON THIS EXCHANGE CITED A BLOCKING RULE, resolved to a boolean
                  -- HERE rather than by unnesting the categories into the join.
                  --
                  -- Unnesting is the obvious way to write this and it is wrong: one row per cited
                  -- category fans the group out, and AVG(relevance_score) then weights each verdict by
                  -- how many rules it happened to breach. A partial unique index makes that
                  -- unreachable today, which is precisely why it would have been a silent defect the
                  -- day the index changed rather than a visible one now.
                  BOOL_OR(compliance_categories ?| $4::text[]) AS has_blocking_breach,
                  -- ── GROUNDEDNESS, WHICH WAS BEING COMPUTED AND READ BY NOTHING ──
                  --
                  -- Pass D judges whether the answer is supported by what the turn retrieved, and has
                  -- written this column on every scored exchange since migration 062. No query
                  -- returned it and no surface showed it, so the metric a retrieval system is normally
                  -- judged on was built, stored and invisible.
                  --
                  -- BOOL_AND for the same reason is_compliant uses it: the verdict is categorical, so
                  -- a re-scored exchange is grounded only if every verdict said so, and stays NULL when
                  -- none of them could assess it - which happens whenever the turn retrieved nothing,
                  -- and is a fact about coverage rather than a failure.
                  BOOL_AND(is_grounded) AS is_grounded,
                  MAX(retrieved_passage_count) AS retrieved_passage_count,
                  MAX(used_passage_count) AS used_passage_count,
                  -- WHICH RUBRIC PRODUCED THE SCORE. Derived from the prompt text, so a changed prompt
                  -- changes it. Surfaced because that is the whole point: a reader comparing scores
                  -- across a rubric change has to be able to refuse, and could not see the boundary.
                  MAX(rubric_version) AS rubric_version,
                  -- WHICH MODEL JUDGED. MAX for the same reason rubric_version uses it: the collapse
                  -- keeps this join 1:1 so exchange_count is not inflated, and a re-scored exchange
                  -- names one of its judges rather than fanning the group out. The window-level count
                  -- above is what a reader acts on.
                  MAX(evaluator_model) AS evaluator_model,
                  -- WHY THIS EXCHANGE WAS PICKED: always-taken (flagged or low confidence) or the
                  -- sampled remainder. A rate over a stratified sample means nothing without it.
                  MAX(sample_stratum) AS sample_stratum
             FROM evaluation_results
            WHERE evaluation_type = 'exchange'
            GROUP BY exchange_id
         ) er ON er.exchange_id = e.id
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.intent IS NOT NULL
          AND ($2::varchar IS NULL OR ${WORK_INTENT_SQL('e')} = $2)
          AND ($3::varchar IS NULL OR e.assistant = $3)
          AND ($5::varchar IS NULL OR e.conversation_classification = $5)
          AND ($8::text[] IS NULL OR e.conversation_classification = ANY($8))
          AND ($6::varchar IS NULL OR e.assistant_role = $6)
          ${exchangePathDuelSql('e', 9)}
          AND ($7::int IS NULL OR e.profile_version = $7)
          -- ONE ROW PER TURN, the predicate getEvaluationMetrics and v_turn_latency anchor on. A
          -- folded answer writes one exchange per message the queue held, all sharing one
          -- agent_message_id, so without this a single slow turn that folded three messages counts as
          -- four - weighting exchange_count, every duration and token average, the MODE() dominant
          -- model and the compliance denominator by how much the person typed while the assistant was
          -- working. The folded rows are the queue-wait population and are read on their own.
          AND e.queued_as IS NULL
        GROUP BY ${WORK_INTENT_SQL('e')}
     ),
     -- ── WHAT EACH MODEL ACTUALLY SERVED, SO A MIXED INTENT IS PRICED CORRECTLY ──────────────────
     --
     -- The cost column used to price the intent's AVERAGE tokens at MODE() - the single commonest
     -- model. That is exact only where an intent is served by one model, and silently wrong where it
     -- is not. Measured live: the general intent ran 57 replies on Haiku, 30 on Sonnet and 170 on
     -- Opus, so the mode priced all 257 at the Opus rate and overstated the intent by about 40%.
     --
     -- SUMS PER MODEL, so the reader can price each slice at its own rate and divide once at the end.
     -- The rate table deliberately stays in JS (decision D4): a second copy in SQL drifts, and the
     -- honesty contract there returns NULL for a model it cannot price rather than inventing a rate.
     --
     -- THE PREDICATES ARE THE SAME AS ex_agg ABOVE, deliberately duplicated rather than factored out:
     -- this has to describe the SAME population or the blended cost is over a different denominator
     -- than the reply count beside it. Any change above belongs here in the same edit.
     model_mix_agg AS (
       SELECT mm.intent,
              jsonb_agg(jsonb_build_object(
                'model', mm.bedrock_model,
                'leg', mm.leg,
                'replies', mm.replies,
                'tokensIn', mm.tokens_in,
                'tokensOut', mm.tokens_out
              )) AS model_mix
         FROM (
           -- ── THE ANSWER'S OWN MODEL ──
           SELECT ${WORK_INTENT_SQL('e2')} AS intent,
                  m2.bedrock_model AS bedrock_model,
                  'answer'::text AS leg,
                  COUNT(*) AS replies,
                  SUM(m2.input_tokens) AS tokens_in,
                  SUM(m2.output_tokens) AS tokens_out
             FROM exchanges e2
             JOIN messages m2 ON e2.agent_message_id = m2.id
            WHERE e2.created_at >= lower($1::tstzrange) AND e2.created_at < upper($1::tstzrange)
              AND e2.intent IS NOT NULL
              AND ($2::varchar IS NULL OR ${WORK_INTENT_SQL('e2')} = $2)
              AND ($3::varchar IS NULL OR e2.assistant = $3)
              AND ($5::varchar IS NULL OR e2.conversation_classification = $5)
              AND ($8::text[] IS NULL OR e2.conversation_classification = ANY($8))
              AND ($6::varchar IS NULL OR e2.assistant_role = $6)
              ${exchangePathDuelSql('e2', 9)}
              AND ($7::int IS NULL OR e2.profile_version = $7)
              AND e2.queued_as IS NULL
              AND m2.bedrock_model IS NOT NULL
            GROUP BY ${WORK_INTENT_SQL('e2')}, m2.bedrock_model
           -- ── AND THE CLASSIFIER'S, WHICH RUNS BEFORE IT (migration 063) ──
           --
           -- Most turns pay a model to decide where they are going, and that call was measured and
           -- discarded, so the cost column covered the answer and nothing else. It is a SEPARATE slice
           -- rather than folded into the answer's, because it is usually a different model at a
           -- different rate - a deployment routing on Haiku and answering on Opus pays two prices for
           -- one reply, and summing the tokens first would charge both at whichever model won the row.
           --
           -- UNION ALL, not UNION: two slices that happen to share a model and a token count are two
           -- real costs, and deduplicating them would drop one.
           UNION ALL
           SELECT ${WORK_INTENT_SQL('e2')} AS intent,
                  m2.classifier_model AS bedrock_model,
                  'classifier'::text AS leg,
                  COUNT(*) AS replies,
                  SUM(m2.classifier_tokens_in) AS tokens_in,
                  SUM(m2.classifier_tokens_out) AS tokens_out
             FROM exchanges e2
             JOIN messages m2 ON e2.agent_message_id = m2.id
            WHERE e2.created_at >= lower($1::tstzrange) AND e2.created_at < upper($1::tstzrange)
              AND e2.intent IS NOT NULL
              AND ($2::varchar IS NULL OR ${WORK_INTENT_SQL('e2')} = $2)
              AND ($3::varchar IS NULL OR e2.assistant = $3)
              AND ($5::varchar IS NULL OR e2.conversation_classification = $5)
              AND ($8::text[] IS NULL OR e2.conversation_classification = ANY($8))
              AND ($6::varchar IS NULL OR e2.assistant_role = $6)
              ${exchangePathDuelSql('e2', 9)}
              AND ($7::int IS NULL OR e2.profile_version = $7)
              AND e2.queued_as IS NULL
              AND m2.classifier_model IS NOT NULL
            GROUP BY ${WORK_INTENT_SQL('e2')}, m2.classifier_model
         ) mm
        GROUP BY mm.intent
     ),
     -- ── A RAISED FLAG IS NOT A THUMBS DOWN ──────────────────────────────────
     --
     -- The user_flag_count column counts a thumbs DOWN. The Flagged surface counts something else
     -- entirely: a flag somebody raised deliberately, with a reason, from the chat client or from
     -- Oversight, or one a judge raised. The two share a word and mean different things, so an intent
     -- reading "0 flagged" could have flags on it, and a reader following the number to that tab found
     -- rows the number never counted.
     --
     -- Counted per intent so the card can show BOTH signals and say which is which. Keyed through the
     -- response message, because a flag names the Chime MessageId it was raised on rather than an
     -- exchange - the same join the flagged list uses.
     flag_agg AS (
       SELECT ${WORK_INTENT_SQL('e')} AS intent,
              COUNT(DISTINCT hf.id) AS raised_flag_count
         FROM human_flag hf
         JOIN messages m ON m.message_id = hf.message_id AND m.channel_arn = hf.channel_arn
         JOIN exchanges e ON e.agent_message_id = m.id
        WHERE hf.flagged_at >= lower($1::tstzrange) AND hf.flagged_at < upper($1::tstzrange)
          AND e.intent IS NOT NULL
          AND ($2::varchar IS NULL OR ${WORK_INTENT_SQL('e')} = $2)
          AND ($3::varchar IS NULL OR e.assistant = $3)
          AND ($5::varchar IS NULL OR e.conversation_classification = $5)
          AND ($8::text[] IS NULL OR e.conversation_classification = ANY($8))
          AND ($6::varchar IS NULL OR e.assistant_role = $6)
          ${exchangePathDuelSql('e', 9)}
          AND ($7::int IS NULL OR e.profile_version = $7)
          AND e.queued_as IS NULL
        GROUP BY ${WORK_INTENT_SQL('e')}
     ),
     flow_agg AS (
       SELECT f.intent,
              ROUND((COUNT(*) FILTER (WHERE f.status = 'completed') * 100.0
                     / NULLIF(COUNT(*), 0))::numeric, 1) AS task_completion_rate,
              -- ── WHAT ACTUALLY HAPPENED, NOT JUST HOW OFTEN IT WENT RIGHT ────────────────────────
              -- A completion rate alone collapses every other ending into one "not completed"
              -- bucket, so an intent reading 0% cannot be read: nobody can tell work that BROKE from
              -- work a person WALKED AWAY FROM, and those have different owners and different fixes.
              --
              -- "intent_flows.status" is a judge verdict over a four-value set
              -- (completed | in_progress | abandoned | failed), which is the right source for this.
              -- Note it is NOT the task row's TaskStatus: there, "abandoned" is written only by
              -- pauseTask and means PAUSED, so counting it would report somebody who stepped out
              -- for two minutes as somebody who gave up (SPEC-TASK-STATE-TRANSITIONS section 6a).
              COUNT(*) AS task_flow_count,
              COUNT(*) FILTER (WHERE f.status = 'completed')   AS task_completed,
              COUNT(*) FILTER (WHERE f.status = 'failed')      AS task_failed,
              COUNT(*) FILTER (WHERE f.status = 'abandoned')   AS task_abandoned,
              COUNT(*) FILTER (WHERE f.status = 'in_progress') AS task_running,
              ROUND(AVG( COALESCE(f.outcome_score,0) * 0.30
                       + COALESCE(f.information_score,0) * 0.25
                       + COALESCE(f.efficiency_score,0) * 0.15
                       + COALESCE(f.context_retention_score,0) * 0.15
                       + COALESCE(f.ux_score,0) * 0.15 )::numeric, 1) AS flow_composite
         FROM intent_flows f
        WHERE f.created_at >= lower($1::tstzrange) AND f.created_at < upper($1::tstzrange)
          AND ($2::varchar IS NULL OR f.intent = $2)
          AND ($3::varchar IS NULL OR f.assistant = $3)
          AND ($5::varchar IS NULL OR f.conversation_classification = $5)
          AND ($8::text[] IS NULL OR f.conversation_classification = ANY($8))
          -- FLOWS ARE NOT FILTERED BY ROLE OR VERSION, deliberately. A flow spans many turns and can
          -- span a version activation, so it has no single version; attributing it to one would be a
          -- guess that reads like a fact. The exchange aggregate above carries both.
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
       SELECT ${WORK_INTENT_SQL('e')} AS intent,
              COUNT(*) AS tool_calls,
              -- A REFUSAL BY A DECLARED WORKFLOW RULE IS NOT A FAILURE. The workflow refused a move (an
              -- edge its graph does not hold, an unsourced need, a document not declared) and the model
              -- corrects it in the same loop; nothing broke. It is told apart by the class the step
              -- records from the handler's structured refusal marker, never by message text, and is
              -- counted on its own as a compliance signal. A step with no class is still an error.
              COUNT(*) FILTER (WHERE (t->>'ok') = 'false'
                                 AND (t->>'errorClass') IS DISTINCT FROM 'workflow_refusal') AS tool_errors,
              COUNT(*) FILTER (WHERE (t->>'ok') = 'false'
                                 AND (t->>'errorClass') = 'workflow_refusal') AS workflow_refusals
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         -- ── THE STEPS ARE ON THE SIBLING, WHICH IS WHY "Tools" WAS ALWAYS EMPTY
         --
         -- A reply is delivered placeholder-then-update: the CREATE row is the "One moment..."
         -- placeholder, and the answer arrives as a separate update row (one per update event, read here
         -- as the latest, migration 084). Exchanges link
         -- agent_message_id to the CREATE row, so this join lands on the placeholder - which was
         -- written before any tool ran and can never carry a step.
         --
         -- backfillFromUpdateEvents folds the UPDATE's telemetry onto the CREATE row (model, tokens,
         -- latency, the final content) but NOT its metadata, and steps[].tools[] live in metadata.
         -- So the tool lens read a row whose steps are structurally absent and reported no tool use -
         -- which is a legitimate outcome for an assistant that answered without tools, and therefore
         -- a plausible falsehood rather than an obvious gap. Measured over three days: 71
         -- "tool:<name>" step labels across the live processors while this column showed nothing.
         --
         -- Read the sibling, falling back to the CREATE row so a handler-answered turn that never
         -- produced an update still counts.
         ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
         -- jsonb_typeof guards a non-array 'steps'/'tools' (COALESCE only catches SQL NULL, not a JSON
         -- null/scalar) - one such row would otherwise error the WHOLE dashboard query, not just itself.
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(COALESCE(upd.metadata, m.metadata)->'steps') = 'array'
                THEN COALESCE(upd.metadata, m.metadata)->'steps' ELSE '[]'::jsonb END
         ) s
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(s->'tools') = 'array' THEN s->'tools' ELSE '[]'::jsonb END
         ) t
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.intent IS NOT NULL
          AND ($2::varchar IS NULL OR ${WORK_INTENT_SQL('e')} = $2)
          AND ($3::varchar IS NULL OR e.assistant = $3)
          AND ($5::varchar IS NULL OR e.conversation_classification = $5)
          AND ($8::text[] IS NULL OR e.conversation_classification = ANY($8))
          AND ($6::varchar IS NULL OR e.assistant_role = $6)
          ${exchangePathDuelSql('e', 9)}
          AND ($7::int IS NULL OR e.profile_version = $7)
          -- ONE ROW PER TURN, the predicate getEvaluationMetrics and v_turn_latency anchor on. A
          -- folded answer writes one exchange per message the queue held, all sharing one
          -- agent_message_id, so without this a single slow turn that folded three messages counts as
          -- four - weighting exchange_count, every duration and token average, the MODE() dominant
          -- model and the compliance denominator by how much the person typed while the assistant was
          -- working. The folded rows are the queue-wait population and are read on their own.
          AND e.queued_as IS NULL
        GROUP BY ${WORK_INTENT_SQL('e')}
     ),
     -- ── THE STEPS THE PLATFORM RAN, APART FROM THE MODEL'S TOOLS (SPEC-TASK-STATE-TRANSITIONS FR29) ──
     --
     -- A declared step action is recorded as its own step with an "action" object and no "tools", so
     -- tool_agg above never counts it as a model tool call. Counted here from the same sibling row and
     -- with the same predicates, so the two counts describe one population of turns.
     action_agg AS (
       SELECT ${WORK_INTENT_SQL('e')} AS intent,
              COUNT(*) AS platform_actions
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(COALESCE(upd.metadata, m.metadata)->'steps') = 'array'
                THEN COALESCE(upd.metadata, m.metadata)->'steps' ELSE '[]'::jsonb END
         ) s
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.intent IS NOT NULL
          AND jsonb_typeof(s->'action') = 'object'
          AND ($2::varchar IS NULL OR ${WORK_INTENT_SQL('e')} = $2)
          AND ($3::varchar IS NULL OR e.assistant = $3)
          AND ($5::varchar IS NULL OR e.conversation_classification = $5)
          AND ($8::text[] IS NULL OR e.conversation_classification = ANY($8))
          AND ($6::varchar IS NULL OR e.assistant_role = $6)
          ${exchangePathDuelSql('e', 9)}
          AND ($7::int IS NULL OR e.profile_version = $7)
          AND e.queued_as IS NULL
        GROUP BY ${WORK_INTENT_SQL('e')}
     )
     SELECT ex_agg.intent,
            ex_agg.exchange_count,
            ex_agg.direct_count,
            ex_agg.task_count,
            ex_agg.avg_confidence,
            -- RELEVANCE OVER EVERY SCORED TURN, task or not. "direct_relevance" stays beside it for
            -- the drill, but this is what the column reads: relevance is a judgement about a MESSAGE
            -- and applies inside a task exactly as it does to a one-shot reply, so restricting it to
            -- direct turns made two intents incomparable depending on which shape their traffic took.
            -- The count travels with it: an average over three scored turns and one over three
            -- hundred are not the same claim, and a reader cannot tell them apart from the number.
            ex_agg.avg_relevance,
            ex_agg.relevance_scored_count,
            ex_agg.direct_relevance_sd,
            ex_agg.direct_relevance_conversations,
            ex_agg.direct_relevance,
            -- The four signals Pass A and Pass D have been writing all along. Aggregating them in
            -- ex_agg and leaving them out HERE is the same defect one level down from the one this
            -- change exists to fix: computed, correct, and reaching no reader.
            ex_agg.groundedness_rate,
            ex_agg.groundedness_assessed_count,
            ex_agg.avg_retrieved_passages,
            ex_agg.passage_use_rate,
            ex_agg.passage_use_assessed_count,
            ex_agg.rubric_version_count,
            ex_agg.rubric_version,
            ex_agg.evaluator_model_count,
            ex_agg.evaluator_model,
            ex_agg.sampled_always_count,
            ex_agg.sampled_random_count,
            ex_agg.compliance_rate,
            ex_agg.compliance_assessed_count,
            ex_agg.violation_count,
            ex_agg.blocking_violation_count,
            -- NULL (not 0) when the flow evaluator has not scored this intent's tasks yet, so the UI
            -- renders "—" rather than a misleading red 0%. A genuine 0% (flows exist, none completed)
            -- still comes through as 0 from flow_agg. Distinguishes "no data yet" from "actually failing".
            fa.task_completion_rate,
            -- HOW THE TASKS ENDED, so "0% completion" can be read. Without these a reader cannot
            -- tell work that broke from work somebody walked away from. NULL for an intent with no
            -- task flows at all, which the UI renders as blank rather than as zeroes: an intent that
            -- never opens a task has no task execution to report, and zeroes would say it failed.
            fa.task_flow_count,
            fa.task_completed,
            fa.task_failed,
            fa.task_abandoned,
            fa.task_running,
            fa.flow_composite,
            ex_agg.avg_total_ms,
            ex_agg.p95_total_ms,
            ex_agg.avg_input_tokens,
            ex_agg.avg_output_tokens,
            ex_agg.avg_image_count,
            ex_agg.dominant_model,
            ex_agg.assistant,
            ex_agg.assistant_definition_count,
            ex_agg.answering_assistant,
            ex_agg.profile_version,
            ex_agg.profile_config_id,
            COALESCE(ta.tool_calls, 0) AS tool_calls,
            COALESCE(ta.tool_errors, 0) AS tool_errors,
            COALESCE(ta.workflow_refusals, 0) AS workflow_refusals,
            COALESCE(aa.platform_actions, 0) AS platform_actions,
            -- NULL WHEN NO TOOL RAN, not 0.0%. The inner NULLIF already yields NULL on a zero
            -- denominator; the outer COALESCE turned that back into a confident "0.0% of tool calls
            -- failed" for an intent that never called a tool. Three readers then disagreed about
            -- what the zero meant - the table guarded it and printed "-", Alerts guarded it, and the
            -- drill card did not and painted it GREEN against the error-rate target, so "nothing
            -- measured" and "everything worked" were the same pixel.
            ROUND((ta.tool_errors * 100.0 / NULLIF(ta.tool_calls, 0))::numeric, 1) AS tool_error_rate,
            -- Priced slice by slice in JS, because the rate table lives there.
            mx.model_mix,
            COALESCE(fg.raised_flag_count, 0) AS raised_flag_count
       FROM ex_agg
       LEFT JOIN flow_agg fa ON fa.intent = ex_agg.intent
       LEFT JOIN model_mix_agg mx ON mx.intent = ex_agg.intent
       LEFT JOIN flag_agg fg ON fg.intent = ex_agg.intent
       LEFT JOIN tool_agg ta ON ta.intent = ex_agg.intent
       LEFT JOIN action_agg aa ON aa.intent = ex_agg.intent
      ORDER BY ex_agg.exchange_count DESC`,
    [win.range, intent, agentType, BLOCKING_RULE_IDS, conversationClassification, assistantRole, profileVersion, conversationClassifications, perfEntryParam(params), perfDuelParam(params), perfTypeParam(params)]
  );

  // THE POPULATION THE VOTES ARE FOLDED INTO, resolved through the SAME filters the rows above were
  // built with. The thumbs scan can only filter on time - it is a DynamoDB scan over a store that
  // holds no assistant, role or version - so the narrowing has to come from Aurora, which knows
  // which agent message each vote was left on and what that message was counted as.
  //
  // Kept to two columns and one predicate set on purpose: this is a membership test, not a second
  // aggregate. A second aggregate here would be a second answer to "how many exchanges" that drifts
  // from the one the rows already carry.
  //
  // IT FAILS CLOSED, unlike the vote scan below it. An unreadable scope means every vote is of
  // unknown provenance, and the two ways to render that are "no signal measured" or "everyone's
  // thumbs" - the second is the defect this scope exists to end, so an empty scope is the safe
  // answer and the console shows the columns as unmeasured.
  const scopedMessages = await query(
    `SELECT e.agent_message_id::text AS message_id, COALESCE(e.task_type, e.intent, 'unknown') AS intent
       FROM exchanges e
      WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
        AND e.agent_message_id IS NOT NULL
        AND e.queued_as IS NULL
        AND ($2::varchar IS NULL OR ${WORK_INTENT_SQL('e')} = $2)
        AND ($3::varchar IS NULL OR e.assistant = $3)
        AND ($4::varchar IS NULL OR e.conversation_classification = $4)
        AND ($7::text[] IS NULL OR e.conversation_classification = ANY($7))
        AND ($5::varchar IS NULL OR e.assistant_role = $5)
        ${exchangePathDuelSql('e', 8)}
        AND ($6::int IS NULL OR e.profile_version = $6)`,
    [win.range, intent, agentType, conversationClassification, assistantRole, profileVersion, conversationClassifications, perfEntryParam(params), perfDuelParam(params), perfTypeParam(params)]
  );
  const voteScope = new Map<string, string>(
    ((scopedMessages?.rows ?? []) as Array<{ message_id: string; intent: string }>)
      .map((r) => [String(r.message_id), String(r.intent)] as [string, string])
  );

  // USER SIGNAL, folded in from DynamoDB rather than joined in SQL — the thumbs store is not in
  // Aurora and deliberately is not replicated there (see foldUserSignalByIntent). Fails OPEN: an
  // unset table or a scan error leaves every row's signal null, which the console renders as "not
  // measured" rather than as nobody having complained.
  const signal = foldUserSignalByIntent(await scanLatestVotes(win), voteScope);
  const signalByIntent = signal.byIntent;
  // COVERAGE LOSS IS REPORTED, NOT ABSORBED. A vote left on a turn whose intent was never recorded
  // used to disappear into a key no row can carry, so the console showed fewer votes and nothing
  // said any had gone missing.
  if (signal.unattributed > 0) {
    console.warn('[user-signal] votes in population with no recorded intent', {
      unattributed: signal.unattributed,
    });
  }

  // Cost column (D4): resolve tokens × model rate to a per-reply USD estimate in JS (the rate table is
  // TS), keeping the null-honesty contract. The raw token averages + dominant_model stay on the row.
  const rows = (result.rows as Array<Record<string, unknown>>).map((r) => {
    const sig = signalByIntent.get(String(r.intent ?? ''));
    return {
      ...r,
      cost_per_reply_usd: resolveReplyCostUsd(r as Parameters<typeof resolveReplyCostUsd>[0]),
      // THE SMALLEST GAP FROM TARGET THE RELEVANCE AVERAGE CAN DETECT (SPEC-EVALUATION Appendix C4), over
      // the conversations behind it. The console raises a judged-relevance alert only when the average
      // sits further from its target than this, so a thin population cannot page anybody.
      direct_relevance_mdd: relevanceMdd(r),
      // ── WHY A SLICE COULD NOT BE PRICED, DECIDED HERE RATHER THAN GUESSED AT IN THE CONSOLE ──
      //
      // The mix names the model that actually ran, image models included - an image_generation turn
      // shows stability.stable-image-core rather than some text default. But an image model reports no
      // tokens BY CONSTRUCTION: it is priced per image. Left unmarked, the console reported "no tokens
      // recorded", which is true of the row and wrong about the reason, and reads as a telemetry gap
      // on a turn where nothing is missing.
      //
      // Decided on the server because this is where the image-model registry lives. A console that
      // pattern-matched vendor prefixes would be a second copy of that registry, drifting.
      model_mix: Array.isArray((r as { model_mix?: unknown }).model_mix)
        ? ((r as { model_mix: Array<Record<string, unknown>> }).model_mix).map((sl) => ({
            ...sl,
            imageModel: sl && sl.model ? imageGenModelIdToKey(String(sl.model)) != null : false,
          }))
        : (r as { model_mix?: unknown }).model_mix ?? null,
      // ── THE DENOMINATOR THE COST WAS AVERAGED OVER, WHICH IS NOT ALWAYS exchange_count ──
      //
      // A turn whose model was never recorded cannot be priced, so it is excluded from the blend.
      // Measured live: the general intent showed 273 replies and 270 priced ones. Three turns is a
      // rounding error here and would not be on a deployment where attribution is failing - and the
      // whole point of this surface is that a rate says the population it was computed over. Without
      // it a reader divides the cost by the reply count beside it and gets a different total than
      // the one this figure came from.
      cost_priced_replies: resolveCostPricedReplies(r as Parameters<typeof resolveCostPricedReplies>[0]),
      // NULL, not 0, when nobody voted on this intent at all. Zero would claim a measurement -
      // "we asked and nobody objected" - where the truth is that nobody was asked. The console
      // renders the two differently on purpose.
      user_rated_count: sig ? sig.rated : null,
      user_up_count: sig ? sig.up : null,
      user_down_count: sig ? sig.down : null,
      // The reading somebody wants: what share of the people who said anything were happy. NULL when
      // nobody rated, never 0 - zero would claim a measurement where nobody was asked.
      user_positive_rate: sig && sig.rated > 0 ? Math.round((sig.up / sig.rated) * 1000) / 10 : null,
      user_flag_count: sig ? sig.flagged : null,
      user_flag_rate: sig && sig.rated > 0 ? Math.round((sig.flagged / sig.rated) * 1000) / 10 : null,
      // The share of this intent's exchanges that got any vote at all. A flag rate cannot be read
      // without it: 20% of five votes on five hundred exchanges is four people, not a crisis.
      user_rated_share:
        sig && Number(r.exchange_count) > 0
          ? Math.round((sig.rated / Number(r.exchange_count)) * 1000) / 10
          : null,
      user_flag_wrong_assistant: sig ? sig.wrongAssistant : null,
      user_flag_poor_answer: sig ? sig.poorAnswer : null,
      user_flag_asked_again: sig ? sig.askedAgain : null,
      user_flag_unspecified: sig ? sig.unspecified : null,
    };
  });

  return success({
    data: rows,
    // HOW MANY VOTES THIS PAGE COULD NOT PLACE. Not per row, because an unattributed vote by
    // definition has no row to sit on; it belongs to the page as a coverage figure, the way the
    // scored and assessed counts belong to the columns they qualify.
    userVotesUnattributed: signal.unattributed,
    columns: [
      'intent', 'exchange_count', 'direct_count', 'task_count',
      'avg_confidence',
      'avg_relevance', 'relevance_scored_count', 'direct_relevance_sd', 'direct_relevance_conversations', 'direct_relevance_mdd',
      'groundedness_rate', 'groundedness_assessed_count', 'avg_retrieved_passages',
      'passage_use_rate', 'passage_use_assessed_count',
      'rubric_version', 'rubric_version_count',
      'evaluator_model', 'evaluator_model_count',
      'sampled_always_count', 'sampled_random_count',
      'direct_relevance', 'task_completion_rate', 'flow_composite',
      'task_flow_count', 'task_completed', 'task_failed', 'task_abandoned', 'task_running',
      'compliance_rate', 'compliance_assessed_count', 'violation_count', 'blocking_violation_count',
      'avg_total_ms', 'p95_total_ms',
      'avg_input_tokens', 'avg_output_tokens', 'dominant_model', 'cost_per_reply_usd',
      'cost_priced_replies', 'model_mix',
      'tool_calls', 'tool_errors', 'tool_error_rate', 'workflow_refusals', 'platform_actions',
      'user_rated_count', 'user_up_count', 'user_down_count', 'user_positive_rate',
      'user_flag_count', 'user_flag_rate', 'user_rated_share',
      'raised_flag_count',
      'user_flag_wrong_assistant', 'user_flag_poor_answer', 'user_flag_asked_again', 'user_flag_unspecified',
      // The assistant that answered, the definition it served, and how many definitions there were. All
      // three, because one of them alone is what let a banner name an assistant that did not answer.
      'assistant', 'assistant_definition_count', 'answering_assistant',
    ],
  });
}

/**
 * Effectiveness L1, AN INTENT'S STEPS AND THE MODELS THAT SERVED THEM (ADR-064 decision 4, SPEC-ADMIN-CONSOLE-
 * EFFECTIVENESS FR39 to FR41). Three row sets over one population, the intent's turns as the L1
 * row counts them (`WORK_INTENT_SQL`: a task turn under its task's type) and narrowed by the same filters:
 *
 *  - `dimension = 'step'`: the turn's own recorded steps, for every intent. One row per task step the turn started in
 *    (`task_step`, NULL for a turn bound to no task) and per kind of `steps[]` entry: a model call by its model
 *    (`step_kind = 'model'`), a model call that called or proposed a tool by the tool's name (`'tool'`), a platform
 *    action by its tool (`'platform'`: a declared step action, an image the platform drew) and a correction by its label
 *    (`'correction'`). Each with the turns it appeared in, its calls, average and p95 time per call, its summed cost and
 *    the models it ran on. `group_key` is `<step_kind>:<step_key>`.
 *  - `dimension = 'task_step'`: one row per `task_step`, with its turn count, turn latency, the models that answered and
 *    the cost summed from each turn's `steps[]`, so a task step's turns reconcile with the L1 row.
 *  - `dimension = 'model'`: one row per model a step entry names (`steps[].modelId`; a text Converse iteration and an
 *    image the platform drew alike, the platform's own non-model actions left out), with the turns it served, its calls,
 *    its time per call and its summed cost.
 *
 * Cost is the sum of what each step recorded at write time, never a dominant model times an average, so a workflow that
 * asks on a text model and draws on an image model is priced per step. A step entry that recorded no cost is counted in
 * `unpriced_steps` rather than read as free. `?step=` narrows every set to one task step. Aurora only.
 */
async function getIntentSteps(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const intent = params.intent;
  if (!intent) return success({ data: [] });
  const win = queryWindow(params, 30, 180);
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const profileVersion = params.profileVersion !== undefined && params.profileVersion !== '' && Number.isInteger(Number(params.profileVersion))
    ? Number(params.profileVersion) : null;
  const result = await query(
    `WITH turns AS (
       SELECT e.id AS exchange_id,
              e.task_step,
              m.bedrock_model,
              m.total_ms,
              CASE WHEN jsonb_typeof(COALESCE(upd.metadata, m.metadata)->'steps') = 'array'
                   THEN COALESCE(upd.metadata, m.metadata)->'steps' ELSE '[]'::jsonb END AS steps
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         ${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND ${WORK_INTENT_SQL('e')} = $2
          AND ($3::varchar IS NULL OR e.assistant = $3)
          AND ($4::varchar IS NULL OR e.conversation_classification = $4)
          AND ($5::text[] IS NULL OR e.conversation_classification = ANY($5))
          AND ($6::varchar IS NULL OR e.assistant_role = $6)
          AND ($7::int IS NULL OR e.profile_version = $7)
          AND ($8::varchar IS NULL OR e.task_step = $8)
          ${exchangePathDuelSql('e', 9)}
          AND e.queued_as IS NULL
     ),
     entries AS (
       SELECT t.exchange_id, t.task_step, s.entry, k.step_kind,
              CASE k.step_kind
                WHEN 'correction' THEN split_part(s.entry->>'stepLabel', ':', 1)
                WHEN 'platform' THEN COALESCE(s.entry->'action'->>'tool', regexp_replace(s.entry->>'stepLabel', '^platform-action:', ''))
                WHEN 'tool' THEN COALESCE(
                  (SELECT string_agg(DISTINCT x.tool->>'name', '+' ORDER BY x.tool->>'name')
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.entry->'tools') = 'array' THEN s.entry->'tools' ELSE '[]'::jsonb END) AS x(tool)
                    WHERE x.tool->>'name' IS NOT NULL),
                  regexp_replace(s.entry->>'stepLabel', '^tool(-propose)?:', ''))
                ELSE COALESCE(s.entry->>'modelId', s.entry->>'stepLabel')
              END AS step_key,
              CASE WHEN s.entry->>'startedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' AND s.entry->>'endedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                   THEN EXTRACT(EPOCH FROM ((s.entry->>'endedAt')::timestamptz - (s.entry->>'startedAt')::timestamptz)) * 1000 END AS call_ms
         FROM turns t
         CROSS JOIN LATERAL jsonb_array_elements(t.steps) AS s(entry)
         -- WHAT EACH ENTRY IS: a correction the platform asked for, a platform action (a declared step action, an image
         -- the platform drew), a model call that called or proposed a tool, or a model call that answered.
         CROSS JOIN LATERAL (SELECT CASE
                WHEN s.entry->>'stepLabel' LIKE 'correction-%' THEN 'correction'
                WHEN jsonb_typeof(s.entry->'action') = 'object' OR s.entry->>'stepLabel' LIKE 'platform-action:%' THEN 'platform'
                WHEN (jsonb_typeof(s.entry->'tools') = 'array' AND s.entry->'tools' <> '[]'::jsonb)
                  OR s.entry->>'stepLabel' LIKE 'tool:%' OR s.entry->>'stepLabel' LIKE 'tool-propose:%' THEN 'tool'
                ELSE 'model'
              END AS step_kind) AS k
     ),
     turn_cost AS (
       SELECT exchange_id,
              SUM((entry->>'estCostUsd')::numeric) FILTER (WHERE jsonb_typeof(entry->'estCostUsd') = 'number') AS cost_usd,
              COUNT(*) FILTER (WHERE jsonb_typeof(entry->'estCostUsd') IS DISTINCT FROM 'number') AS unpriced_steps
         FROM entries
        GROUP BY exchange_id
     )
     SELECT 'task_step'::text AS dimension,
            t.task_step AS group_key,
            t.task_step,
            NULL::text AS step_kind,
            NULL::text AS step_key,
            COUNT(*) AS turns,
            NULL::bigint AS calls,
            ROUND(AVG(t.total_ms)::numeric, 0) AS avg_ms,
            ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.total_ms)::numeric, 0) AS p95_ms,
            SUM(tc.cost_usd) AS cost_usd,
            COALESCE(SUM(tc.unpriced_steps), 0) AS unpriced_steps,
            ARRAY_AGG(DISTINCT t.bedrock_model) FILTER (WHERE t.bedrock_model IS NOT NULL) AS models
       FROM turns t
       LEFT JOIN turn_cost tc ON tc.exchange_id = t.exchange_id
      GROUP BY t.task_step
     UNION ALL
     SELECT 'step'::text AS dimension,
            en.step_kind || ':' || en.step_key AS group_key,
            en.task_step,
            en.step_kind,
            en.step_key,
            COUNT(DISTINCT en.exchange_id) AS turns,
            COUNT(*) AS calls,
            ROUND(AVG(en.call_ms)::numeric, 0) AS avg_ms,
            ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY en.call_ms)::numeric, 0) AS p95_ms,
            SUM((en.entry->>'estCostUsd')::numeric) FILTER (WHERE jsonb_typeof(en.entry->'estCostUsd') = 'number') AS cost_usd,
            COUNT(*) FILTER (WHERE jsonb_typeof(en.entry->'estCostUsd') IS DISTINCT FROM 'number') AS unpriced_steps,
            ARRAY_AGG(DISTINCT en.entry->>'modelId') FILTER (WHERE en.entry->>'modelId' IS NOT NULL AND en.entry->>'modelId' <> 'platform') AS models
       FROM entries en
      GROUP BY en.task_step, en.step_kind, en.step_key
     UNION ALL
     SELECT 'model'::text AS dimension,
            en.entry->>'modelId' AS group_key,
            NULL::varchar AS task_step,
            NULL::text AS step_kind,
            NULL::text AS step_key,
            COUNT(DISTINCT en.exchange_id) AS turns,
            COUNT(*) AS calls,
            ROUND(AVG(en.call_ms)::numeric, 0) AS avg_ms,
            NULL::numeric AS p95_ms,
            SUM((en.entry->>'estCostUsd')::numeric) FILTER (WHERE jsonb_typeof(en.entry->'estCostUsd') = 'number') AS cost_usd,
            COUNT(*) FILTER (WHERE jsonb_typeof(en.entry->'estCostUsd') IS DISTINCT FROM 'number') AS unpriced_steps,
            ARRAY_AGG(DISTINCT en.task_step) FILTER (WHERE en.task_step IS NOT NULL) AS models
       FROM entries en
      WHERE en.entry->>'modelId' IS NOT NULL AND en.entry->>'modelId' <> 'platform'
      GROUP BY en.entry->>'modelId'
      ORDER BY dimension, task_step NULLS LAST, turns DESC, calls DESC NULLS LAST`,
    [
      win.range, intent, params.agentType || null, params.conversationClassification || null, conversationClassifications,
      params.assistantRole || null, profileVersion, params.step || null,
      perfEntryParam(params), perfDuelParam(params), perfTypeParam(params),
    ]
  );
  return success({ data: intentStepRows(result.rows as Array<Record<string, unknown>>) });
}

/**
 * The rows as the console reads them: a model row names whether it is an image model (decided here, where the
 * image-model registry is) and the task steps it served; a task-step row and a turn-step row the models that ran in it.
 */
export function intentStepRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const { models, ...rest } = r;
    const list = Array.isArray(models) ? (models as unknown[]).map(String) : [];
    if (r.dimension === 'model') {
      const { task_step: _taskStep, step_kind: _kind, step_key: _key, ...model } = rest;
      const id = String(r.group_key ?? '');
      return { ...model, model_kind: imageGenModelIdToKey(id) != null ? 'image' : 'text', steps: list };
    }
    if (r.dimension === 'task_step') {
      const { step_kind: _kind, step_key: _key, ...taskStep } = rest;
      return { ...taskStep, models: list };
    }
    return { ...rest, models: list };
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
  const win = queryWindow(params, 30, 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  const agentType = params.agentType || null; // Effectiveness "one assistant" scope (the responder).

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
            -- The judged detail that was being written and read by nothing: whether the answer was
            -- supported by what the turn retrieved, how many passages it had, which rubric produced
            -- the score, and why this exchange was picked for judging at all.
            er.is_grounded,
            er.retrieved_passage_count,
            er.rubric_version,
            -- WHICH MODEL JUDGED THIS TURN. The rubric names what the judge was ASKED; this names the
            -- judge. Both move a score without the assistant changing, and only one of them was
            -- readable: the runner has stamped the model on every row it writes and no query returned
            -- it, so nobody looking at two scores could tell whether the same instrument produced them.
            er.evaluator_model,
            er.sample_stratum,
            m.total_ms,
            m.input_tokens,
            m.output_tokens,
            m.bedrock_model,
            e.created_at,
            COUNT(*) OVER() AS total_count
       FROM exchanges e
       LEFT JOIN messages m ON e.agent_message_id = m.id
       LEFT JOIN (
         SELECT exchange_id, AVG(relevance_score) AS relevance_score,
                  BOOL_AND(is_grounded) AS is_grounded,
                  MAX(retrieved_passage_count) AS retrieved_passage_count,
                  MAX(rubric_version) AS rubric_version,
                  MAX(evaluator_model) AS evaluator_model,
                  MAX(sample_stratum) AS sample_stratum
           FROM evaluation_results
          WHERE evaluation_type = 'exchange'
          GROUP BY exchange_id
       ) er ON er.exchange_id = e.id
      WHERE ${WORK_INTENT_SQL('e')} = $1
        AND e.created_at >= lower($2::tstzrange) AND e.created_at < upper($2::tstzrange)
        AND ($4::varchar IS NULL OR e.assistant = $4)
      ORDER BY e.created_at DESC
      LIMIT $3 OFFSET $5`,
    [intent, win.range, limit, agentType, offset]
  );
  const total = result.rows[0]?.total_count != null ? Number(result.rows[0].total_count) : result.rows.length;
  return success({ data: result.rows, total, limit, offset });
}

/**
 * THE DELIVERED DOCUMENTS' OWN SCORES (SPEC-EVALUATION FR22; SPEC-ADMIN-CONSOLE-EFFECTIVENESS).
 *
 * A turn that delivers a file is graded twice: the chat reply in its `exchange` row and the file in its
 * `document` row. Every other reader filters to `exchange`, so the document scores reached no surface.
 * This is their reader, and it never pools the two: the document's relevance, groundedness and
 * compliance are columns of their own, and the reply's relevance over the SAME exchanges travels beside
 * them as `reply_avg_relevance`, so a reader can see a good reply beside a weak document and the reverse.
 *
 * TWO SHAPES, by whether a conversation is named:
 *  - no `channelArn`: one row per intent (`dimension = 'intent'`) and one per task type
 *    (`dimension = 'task_type'`, the reference's `kind`: the task type that produced the document, or
 *    `document` for an ad-hoc file), over the documents delivered in the window;
 *  - `channelArn`: one row per document delivered in that conversation, with its score and grading
 *    state, so the conversation drill-down can show the score next to the file. The window does not
 *    apply here: a conversation is opened for what it holds, whenever it was.
 *
 * EVERY DOCUMENT IS IN EXACTLY ONE STATE, so the counts sum to `documents_delivered`:
 *   scored     a `document` row exists
 *   skipped    a terminal reason is recorded (private, not archived, hash mismatch, too long, empty)
 *   retrying   a transient failure, to be tried again by the next run
 *   failed     stopped after the runner's bounded attempts (`exhausted`, migration 083)
 *   awaiting   none of those yet: the reply is not scored (still queued, or outside the sample)
 * Rates are over the documents that carry the verdict, and the denominator travels with each.
 *
 * ONE ROW PER TURN (`queued_as IS NULL`), the predicate every effectiveness reader anchors on. The
 * reference is read from the -UPD sibling first and the CREATE row second, which is the precedence the
 * runner's merge gives it.
 */
async function getDocumentEvaluation(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const conversationClassifications = (params as Record<string, unknown>).conversationClassifications as string[] | undefined ?? null;
  const agentType = params.agentType || null;
  const conversationClassification = params.conversationClassification || null;

  // The document, its latest score, the reply's latest score, and its grading state. Shared by both
  // shapes so the per-conversation rows and the aggregates describe the same thing.
  const docsFrom = `
       FROM exchanges e
       JOIN messages ma ON e.agent_message_id = ma.id
       -- The LATEST update, which is where the turn declared the document it delivered.
       ${updateJoinSql({ alias: 'ma_upd', create: 'ma', pick: 'latest' })}
       CROSS JOIN LATERAL (
         SELECT COALESCE(ma_upd.metadata->'deliveredDocument', ma.metadata->'deliveredDocument') AS ref
       ) md
       LEFT JOIN (
         SELECT DISTINCT ON (exchange_id)
                exchange_id, relevance_score, classification, reasoning, is_grounded, is_compliant,
                rubric_version, evaluator_model, evaluated_at, artifact_key
           FROM evaluation_results
          WHERE evaluation_type = 'document'
          ORDER BY exchange_id, evaluated_at DESC
       ) d ON d.exchange_id = e.id
       LEFT JOIN (
         SELECT DISTINCT ON (exchange_id) exchange_id, relevance_score
           FROM evaluation_results
          WHERE evaluation_type = 'exchange'
          ORDER BY exchange_id, evaluated_at DESC
       ) rr ON rr.exchange_id = e.id
       LEFT JOIN document_grading_attempts ga ON ga.exchange_id = e.id`;

  if (params.channelArn) {
    const result = await query(
      `SELECT e.id AS exchange_id,
              ma.message_id AS agent_message_id,
              e.channel_arn,
              e.conversation_classification,
              e.intent,
              e.created_at,
              md.ref->>'fileKey' AS file_key,
              md.ref->>'sha256' AS document_sha256,
              COALESCE(NULLIF(md.ref->>'kind', ''), 'document') AS task_type,
              d.relevance_score,
              d.classification,
              d.reasoning,
              d.is_grounded,
              d.is_compliant,
              d.rubric_version,
              d.evaluator_model,
              d.evaluated_at,
              d.artifact_key,
              rr.relevance_score AS reply_relevance_score,
              CASE WHEN d.exchange_id IS NOT NULL THEN 'scored'
                   WHEN ga.status = 'exhausted' THEN 'failed'
                   WHEN ga.status IN ('skipped', 'retrying') THEN ga.status
                   ELSE 'awaiting' END AS grading_status,
              ga.skip_reason,
              COALESCE(ga.attempts, 0) AS grading_attempts
         ${docsFrom}
        WHERE e.channel_arn = $1
          AND e.queued_as IS NULL
          AND jsonb_typeof(md.ref) = 'object'
          AND ($2::text[] IS NULL OR e.conversation_classification = ANY($2))
        ORDER BY e.created_at
        LIMIT 200`,
      [params.channelArn, conversationClassifications]
    );
    return success({ data: result.rows });
  }

  const win = queryWindow(params, 30, 180);
  const aggregates = `
              COUNT(*) AS documents_delivered,
              COUNT(*) FILTER (WHERE scored) AS documents_scored,
              COUNT(*) FILTER (WHERE NOT scored AND grading_status = 'skipped') AS documents_skipped,
              COUNT(*) FILTER (WHERE NOT scored AND grading_status = 'retrying') AS documents_retrying,
              COUNT(*) FILTER (WHERE NOT scored AND grading_status = 'exhausted') AS documents_failed,
              COUNT(*) FILTER (WHERE NOT scored AND grading_status IS NULL) AS documents_awaiting,
              -- WHY THE SKIPPED ONES WERE SKIPPED. Private is a rule working; not archived and a hash
              -- mismatch are faults in the copy; too long is a limit somebody may want to raise.
              COUNT(*) FILTER (WHERE NOT scored AND skip_reason = 'private') AS skipped_private,
              COUNT(*) FILTER (WHERE NOT scored AND skip_reason = 'not-archived') AS skipped_not_archived,
              COUNT(*) FILTER (WHERE NOT scored AND skip_reason = 'hash-mismatch') AS skipped_hash_mismatch,
              COUNT(*) FILTER (WHERE NOT scored AND skip_reason = 'too-long') AS skipped_too_long,
              COUNT(*) FILTER (WHERE NOT scored AND skip_reason = 'empty') AS skipped_empty,
              ROUND(AVG(doc_relevance)::numeric, 1) AS doc_avg_relevance,
              ROUND((COUNT(*) FILTER (WHERE doc_grounded IS TRUE) * 100.0
                     / NULLIF(COUNT(*) FILTER (WHERE doc_grounded IS NOT NULL), 0))::numeric, 1) AS doc_groundedness_rate,
              COUNT(*) FILTER (WHERE doc_grounded IS NOT NULL) AS doc_groundedness_assessed_count,
              ROUND((COUNT(*) FILTER (WHERE doc_compliant IS TRUE) * 100.0
                     / NULLIF(COUNT(*) FILTER (WHERE doc_compliant IS NOT NULL), 0))::numeric, 1) AS doc_compliance_rate,
              COUNT(*) FILTER (WHERE doc_compliant IS NOT NULL) AS doc_compliance_assessed_count,
              COUNT(*) FILTER (WHERE doc_compliant IS FALSE) AS doc_violation_count,
              -- The reply's relevance on the same turns, beside the document's and never averaged with it.
              ROUND(AVG(reply_relevance)::numeric, 1) AS reply_avg_relevance,
              COUNT(reply_relevance) AS reply_scored_count,
              COUNT(DISTINCT doc_rubric_version) AS doc_rubric_version_count,
              COUNT(DISTINCT doc_evaluator_model) AS doc_evaluator_model_count,
              MAX(doc_evaluator_model) AS doc_evaluator_model`;
  const result = await query(
    `WITH docs AS (
       SELECT COALESCE(e.intent, 'unknown') AS intent,
              COALESCE(NULLIF(md.ref->>'kind', ''), 'document') AS task_type,
              d.exchange_id IS NOT NULL AS scored,
              d.relevance_score AS doc_relevance,
              d.is_grounded AS doc_grounded,
              d.is_compliant AS doc_compliant,
              d.rubric_version AS doc_rubric_version,
              d.evaluator_model AS doc_evaluator_model,
              rr.relevance_score AS reply_relevance,
              ga.status AS grading_status,
              ga.skip_reason
         ${docsFrom}
        WHERE e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND e.queued_as IS NULL
          AND jsonb_typeof(md.ref) = 'object'
          AND ($2::varchar IS NULL OR e.assistant = $2)
          AND ($3::varchar IS NULL OR e.conversation_classification = $3)
          AND ($4::text[] IS NULL OR e.conversation_classification = ANY($4))
     )
     SELECT 'intent' AS dimension, intent AS group_key, ${aggregates}
       FROM docs GROUP BY intent
     UNION ALL
     SELECT 'task_type' AS dimension, task_type AS group_key, ${aggregates}
       FROM docs GROUP BY task_type
     ORDER BY dimension, documents_delivered DESC`,
    [win.range, agentType, conversationClassification, conversationClassifications]
  );
  return success({ data: result.rows });
}

/**
 * THE TURNS BEHIND ONE ROW OF THE LATENCY BREAKDOWN.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every headline on the Performance surfaces should reach the evidence under it. The latency
 * breakdown was the one table that visibly could not: it showed the groups the headline aggregates
 * from and stopped there, so an operator who distrusted a number had nowhere to go. A figure nobody
 * can check is a figure nobody should act on.
 *
 * THE GROUP IS THE KEY, and all of it. A breakdown row is one (day, assistant, delivery, entry, role,
 * version, tier, battle round) combination, so anything less than the whole tuple would return a
 * DIFFERENT population than the row that was clicked - which is worse than no drill, because the
 * numbers would nearly reconcile and the reader would not know why they did not.
 *
 * THE BATTLE ROUND IS PART OF THAT TUPLE, and it was the one dimension the drill left out while this
 * paragraph claimed otherwise. The breakdown groups on `COALESCE(m.battle_round::text, 'none')`, so
 * drilling a duel's round-1 row returned production traffic alongside it - the exact pooling the
 * `battle_round` column was added to make visible.
 *
 * SLOWEST FIRST. Somebody opening this is asking which turns made the average what it is, and the
 * answer is at the top of that ordering rather than at the top of a chronological one.
 *
 * The channel arn rides along so a row can hand off to the conversation it came from, which is the
 * last step of the same question: not just which turn was slow, but what was said in it.
 */
async function getLatencyExchanges(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  // A DAY, not a range, when the caller names one: the breakdown groups by DATE(created_at), so the
  // drill has to cut the same way or it returns a week of turns for a row describing one day.
  const day = params.day || null;
  const result = await query(
    `SELECT e.id AS exchange_id,
            -- THE TURN ITSELF, which every row has. exchange_id and the exchange's own columns are NULL on
            -- a turn no exchange pairs (a reading, a rebuttal, a queue acknowledgment, an undeclared_turn),
            -- and this is how such a row is still found and opened.
            m.id AS message_id,
            m.message_id AS chime_message_id,
            m.channel_arn,
            -- The breakdown's own dimension values, so a drill row says which group it belongs to.
            ${LATENCY_DIM.assistant} AS assistant,
            ${LATENCY_DIM.label} AS delivery_option,
            lbl.kind AS turn_kind,
            ${LATENCY_DIM.role} AS assistant_role,
            ${LATENCY_DIM.version} AS profile_version,
            ${LATENCY_DIM.classification} AS conversation_classification,
            e.intent,
            m.turn_entry,
            -- HOW THE PAIRING WAS ESTABLISHED (ADR-043): a carried turn (turn_entry flow) always pairs
            -- 'declared'; a natively invoked one may be 'declared', 'in_batch' or 'swept'. Beside the entry,
            -- so a reader can see which guarantee a row's timing carries. NULL on an unpaired turn.
            e.paired_by,
            m.total_ms,
            m.router_ms,
            m.classifier_ms,
            m.latency_ms,
            m.poll_ms,
            m.bedrock_model,
            vl.ttff_ms,
            vl.e2e_ms,
            -- ── THE BROWSER'S OWN NUMBER, BESIDE THE SERVER'S, PER TURN ──────
            --
            -- Folded in from a separate "Browser vs server" table, so the coverage is visible: a turn
            -- with no client timing renders a dash next to a real server figure. The browser figure is
            -- genuine client telemetry - a performance.now() span from send to placeholder paint,
            -- emitted by the chat bundle as client_ttff_ms and tagged with the correlation id.
            cl.client_ttff_ms,
            -- Delivery + render: the WebSocket hop and the paint the server cannot see. Deliberately
            -- NOT clamped at zero - a negative value means the two clocks disagree, and hiding that
            -- would turn a measurement fault into a plausible small number.
            (cl.client_ttff_ms - e.response_latency_ms)::integer AS delivery_gap_ms,
            COALESCE(e.created_at, m.created_at) AS created_at,
            COUNT(*) OVER() AS total_count
       -- ── THE BREAKDOWN'S POPULATION, NOT THE EXCHANGES TABLE ──
       --
       -- The breakdown counts assistant turns (messages), each left-joined to its own exchange, and
       -- most kind-labeled turns have no exchange. Reading FROM exchanges returned nothing for an
       -- unpaired row and only the paired fraction of a mixed one, so the drill and the row disagreed
       -- and an undeclared_turn could not be inspected at all. The joins, the population and every
       -- dimension expression below are the ones getLatencyMetrics groups by, so a drill's total is
       -- the clicked row's assistant_turn_count.
       FROM messages m
       ${LATENCY_TURN_JOINS_SQL}
       -- The client event keys on the correlation marker in the placeholder's own content, the same
       -- bounded grammar every other reader uses. MIN() because a client retry can emit twice.
       --
       -- THE SWEEP GUARD TRAVELS WITH THE JOIN. A cross-batch fallback pairing is not a turn anybody
       -- waited for and its server number belongs to a different moment, which is what produced
       -- delivery gaps around minus eight minutes in the standalone table.
       LEFT JOIN LATERAL (
         SELECT MIN((ce.event_data->>'perf_value')::numeric) AS client_ttff_ms
           FROM client_events ce
          WHERE ce.event_type = 'client_ttff_ms'
            AND ce.event_data->'properties'->>'correlationId'
                = substring(m.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->')
            AND e.paired_by IS DISTINCT FROM 'swept'
       ) cl ON TRUE
      WHERE ${LATENCY_TURN_POPULATION_SQL}
        -- A DAY, cut the way the breakdown groups: by the turn's own message, not its exchange.
        AND ($2::date IS NULL OR ${LATENCY_DIM.day} = $2::date)
        -- ── EACH FILTER IS THE BREAKDOWN'S GROUPING EXPRESSION, VERBATIM ──
        --
        -- The breakdown shows 'unknown' (and 'none' for the round) from inside its COALESCE, so the same
        -- expression compared to the clicked value matches exactly the rows the breakdown put there,
        -- display placeholder included. The delivery option is the label (turnLabelSql), never 'unknown'.
        AND ($3::varchar IS NULL OR ${LATENCY_DIM.assistant} = $3)
        AND ($4::varchar IS NULL OR ${LATENCY_DIM.label} = $4)
        AND ($5::varchar IS NULL OR ${LATENCY_DIM.role} = $5)
        AND ($6::int IS NULL OR ${LATENCY_DIM.version} = $6)
        AND ($7::varchar IS NULL OR ${LATENCY_DIM.classification} = $7)
        AND ($8::varchar IS NULL OR ${LATENCY_DIM.entry} = $8)
        AND ($11::varchar IS NULL OR ${LATENCY_DIM.round} = $11)
        -- A team session's clearance, as the set of rooms' classifications it reaches (fails closed on
        -- NULL): the turn's resolved classification, without the display placeholder.
        AND ($12::text[] IS NULL OR COALESCE(e.conversation_classification, c.conversation_classification, m.conversation_classification) = ANY($12))
      ORDER BY m.total_ms DESC NULLS LAST, m.created_at DESC
      LIMIT $9 OFFSET $10`,
    [
      win.range, day, params.agentType || null, params.deliveryOption || null,
      params.assistantRole || null,
      params.profileVersion ? parseInt(params.profileVersion, 10) : null,
      params.conversationClassification || null, params.turnEntry || null,
      limit, offset,
      // $11. Absent means "the caller did not name a round", which keeps an older console working
      // rather than silently narrowing its drill to production-only.
      params.battleRound || null,
      ((params as Record<string, unknown>).conversationClassifications as string[] | undefined) ?? null,
    ]
  );
  const rows = result.rows as Array<Record<string, unknown>>;
  return success({
    data: rows,
    total: rows.length ? Number(rows[0].total_count) || rows.length : 0,
  });
}

/**
 * THE RATINGS THEMSELVES: which reply, which way, and anything the person wrote.
 *
 * The user-signal card reported counts and led nowhere, so the one signal produced OUTSIDE the system
 * being measured - the only reading that can contradict a confident classifier and a self-scored
 * judge - was the least inspectable thing on the surface.
 *
 * A RATING IS NOT A FLAG, and this returns ratings. The Flagged surface lists flags: raised
 * deliberately, with a reason, by a person in the client or a moderator in Oversight, or by a judge.
 * A thumbs down is a rating that happens to be negative. Sending a reader from one to the other was
 * the dead end this fixes.
 *
 * Thumbs live in DynamoDB rather than Aurora, so this reads the same scan the rollup uses and filters
 * it, instead of inventing a second source that could disagree with the counts above it.
 */
async function getUserRatings(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const wantIntent = params.intent || null;
  const votes = await scanLatestVotes(win);
  const rated = votes
    .filter((v) => v.feedback === 'up' || v.feedback === 'down')
    .filter((v) => !wantIntent || v.intent === wantIntent)
    // Newest first: a rating is a moment, and the recent ones are the ones somebody is chasing.
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, Math.min(parseInt(params.limit || '200', 10), 500));
  if (rated.length === 0) return success({ data: [] });

  // THE REPLY THAT WAS RATED, so the row shows what the person was reacting to rather than an id.
  // Left-joined by Chime MessageId: a vote can outlive archival lag, and dropping those rows would
  // under-report the signal precisely when it is newest.
  const byId = new Map<string, Record<string, unknown>>();
  try {
    const rows = await query(
      `SELECT m.message_id,
              COALESCE(m.updated_content, m.content) AS agent_response,
              m.channel_arn,
              m.assistant,
              e.intent AS exchange_intent
         FROM messages m
         LEFT JOIN exchanges e ON e.agent_message_id = m.id
        WHERE m.message_id = ANY($1::varchar[])`,
      [rated.map((v) => v.messageId)]
    );
    for (const r of rows.rows as Array<Record<string, unknown>>) byId.set(String(r.message_id), r);
  } catch (err) {
    console.warn('[user-ratings] reply lookup failed; returning the ratings alone:', err);
  }

  return success({
    data: rated.map((v) => {
      const m = byId.get(v.messageId);
      return {
        message_id: v.messageId,
        rating: v.feedback,
        // 'unspecified' is the common case and is NOT a reason - the console renders the difference.
        reason: v.reason === 'unspecified' ? null : v.reason,
        note: v.note,
        intent: v.intent,
        created_at: v.createdAt,
        channel_arn: v.channelArn ?? (m ? m.channel_arn : null),
        agent_response: m ? m.agent_response : null,
        assistant: m ? m.assistant : null,
      };
    }),
  });
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
  win: QueryWindow,
  experimentId: string | undefined,
  includeBattle: boolean,
): Promise<Map<string, VariantFeedback>> {
  return aggregateVariantFeedback(await scanFeedbackRecords(experimentId), win.startMs, includeBattle, win.endMs);
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


/**
 * THE POPULATION AN EXPERIMENT IS MEASURED ON, written once for the per-row rollup and the per-conversation
 * units read, so the two cannot count different turns.
 *
 * It filters on the `experiment_id` stamped on the turn and on nothing else about the experiment. That is
 * what makes an `intent` experiment count only turns of its intent: the router stamps a turn only when
 * `countsTowardExperiment` says it counts (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5), so the other
 * turns of an enrolled conversation, served the same version, carry no `experiment_id` and never reach
 * this predicate. A conversation is counted when at least one of its turns counted.
 */
function experimentPopulationWhere(
  win: QueryWindow,
  experimentId: string | undefined,
  includeBattle: boolean,
): { where: string; params: any[] } {
  const queryParams: any[] = [win.range];
  let where = `WHERE m.experiment_id IS NOT NULL
       AND e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
       -- ONE ROW PER TURN (review, 2026-09-17). A folded answer carries one exchange per queued
       -- message on a single agent_message_id, so counting them all inflates n - and here that n
       -- feeds the Welch t-test and the MIN_SAMPLE_PER_VARIANT gate, so a variant could clear the
       -- sample floor on one person typing three times while the assistant was busy.
       AND e.queued_as IS NULL`;

  if (!includeBattle) {
    // Battle turns are intentionally excluded from the probabilistic experiment-variant
    // rollup (SPEC-BATTLE rollup-safety invariant): folding a hand-picked battle prompt into
    // the A/B averages would bias them. Their metrics are surfaced separately, with the filter
    // INVERTED, by fetchBattleEffectivenessRows (the battle-scoped effectiveness view).
    where += ` AND ${BATTLE_MODE_SQL} = 'probabilistic'`;
  }
  if (experimentId) {
    queryParams.push(experimentId);
    where += ` AND m.experiment_id = $${queryParams.length}`;
  }
  return { where, params: queryParams };
}

/**
 * The conversation an exchange belongs to: the unit of analysis (§4.2). An exchange with no channel
 * (none is expected) is its own conversation, which is the per-exchange convention for that row alone.
 */
const CONVERSATION_SQL = `COALESCE(e.channel_arn, e.id::text)`;

/** Votes and picks already scanned, so one read serves the rollup and the recommendation's clustered axes. */
interface PrefetchedSignals {
  feedback: FeedbackRecord[];
  picks: BattleOutcomeItem[];
}

/**
 * EVERY STATE A TASK ENDS IN SUCCESS, as `<task type>:<state>` (`successTerminalStates`, the one rule in
 * `task-state-machines.ts`). A task turn records the state its task ended the turn in as `task_status` (the machine's
 * state where it has one, the lifecycle status where it has none), and a machine names its own success states:
 * `image_generation` ends in `done`, a work item in `placed`. Re-exported so the readers here and their tests name one rule.
 *
 * THE PLATFORM MACHINES. This Lambda serves every classification and holds no deployment pack (a pack is per classification,
 * on the assistant stacks). A non-duel task turn already records a pack machine's success state as the lifecycle `completed`
 * (the processor reads the pack-merged machines, `shouldMarkTaskCompleted`), so it is counted here either way.
 */
export { successTerminalStates };

/** Whether a row (alias `a`) records its task ending in success: the lifecycle `completed`, or a machine's success state. */
const taskCompletedSql = (a: string, param: number): string =>
  `(${a}task_status = 'completed' OR (${a}task_type || ':' || ${a}task_status) = ANY($${param}::text[]))`;
/** The same test over exchange `e`. */
const TASK_COMPLETED_SQL = (param: number): string => taskCompletedSql('e.', param);

async function fetchExperimentRows(
  win: QueryWindow,
  experimentId: string | undefined,
  includeBattle: boolean,
  prefetched?: PrefetchedSignals,
): Promise<any[]> {
  const { where, params: queryParams } = experimentPopulationWhere(win, experimentId, includeBattle);
  queryParams.push(successTerminalStates());
  const completedParam = queryParams.length;

  const result = await query(
    `SELECT
       m.experiment_id,
       m.variant_id,
       COALESCE(m.bedrock_model, 'unknown') AS model_name,
       COALESCE(e.intent, 'unknown') AS intent,
       e.assistant,
       COUNT(*) AS exchange_count,
       -- THE UNIT OF ANALYSIS (§4.2): the conversations these exchanges came from. An experiment enrolls a
       -- conversation to one arm while it is active, so its turns are correlated and the tests count conversations. Summing
       -- this across rows overcounts a conversation that spans two intents or models; the per-variant
       -- figure is the units read (fetchExperimentUnits).
       COUNT(DISTINCT ${CONVERSATION_SQL}) AS conversation_count,
       -- How many of those exchanges an evaluator actually SCORED. exchange_count measures traffic;
       -- this measures evidence, and they are not interchangeable, because an unscored exchange still
       -- counts toward the mean below as a zero. The recommendation gates a quality/accuracy objective
       -- on this, so a variant with nothing scored reports "not enough evidence" instead of a mean of
       -- placeholder zeros read as a real result.
       COUNT(er.relevance_score) AS scored_count,
       -- OVER THE SCORED EXCHANGES, not over the traffic. Coalescing an unscored exchange to zero
       -- made this measure evaluation COVERAGE far more than quality: judging is a sample and a
       -- backlog, so the unjudged tail always entered as a zero, the mean fell as traffic grew, and
       -- it rose again when the backlog caught up. Two variants sampled at different rates were not
       -- comparable at all, which is the one thing an experiment exists to do.
       --
       -- THE SD FOLLOWS THE MEAN, and it has to. A sample SD taken over placeholder zeros describes
       -- the spread of the scoring coverage rather than of the scores, and that SD is what the Welch
       -- test uses - so the test's own denominator was built from rows it had no observation of.
       ROUND(AVG(er.relevance_score)::numeric, 1) AS avg_score,
       -- Per-variant dispersion for the statistical tests (§4.2-B/A.6): sample
       -- SD of each continuous metric so getExperimentRecommendation can run a
       -- Welch t-test on (mean, sd, n). Sample SD is NULL for a single-row group;
       -- surfaced as null and pooled/guarded downstream.
       ROUND(STDDEV_SAMP(er.relevance_score)::numeric, 2) AS score_sd,
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
         (COUNT(*) FILTER (WHERE er.is_compliant IS TRUE) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE er.is_compliant IS NOT NULL), 0))::numeric,
         1
       ) AS compliance_rate,
       COUNT(*) FILTER (WHERE m.was_fallback = true) AS fallback_count,
       COUNT(DISTINCT e.task_id) FILTER (WHERE e.task_id IS NOT NULL) AS task_count,
       COUNT(DISTINCT e.task_id) FILTER (WHERE ${TASK_COMPLETED_SQL(completedParam)}) AS task_completed_count
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
              BOOL_AND(is_compliant) AS is_compliant
         FROM evaluation_results
        WHERE evaluation_type = 'exchange'
        GROUP BY exchange_id
     ) er ON er.exchange_id = e.id
     ${where}
     GROUP BY m.experiment_id, m.variant_id, COALESCE(m.bedrock_model, 'unknown'), COALESCE(e.intent, 'unknown'), e.assistant
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
    prefetched
      ? aggregateVariantFeedback(prefetched.feedback, win.startMs, includeBattle, win.endMs)
      : scanVariantFeedback(win, experimentId, includeBattle),
    (async () =>
      aggregateBattleWinsByVariant(
        prefetched ? prefetched.picks : await scanBattleOutcomeItems(experimentId),
        win.startMs,
        win.endMs,
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
    const conversations = Number(r.conversation_count) || 0;
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
      conversation_count: conversations,
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
      // The floor counts the unit of analysis, conversations, as the recommendation does.
      needs_more_data: conversations < MIN_SAMPLE_PER_VARIANT,
    };
  });
}

/**
 * One variant's sample in both units, and the clustering of each continuous metric (§4.2, "the unit of
 * analysis"). Exchanges are what the means are taken over; conversations are what the tests count.
 */
export interface VariantUnits {
  experiment_id: string;
  variant_id: string;
  /** Always `conversation`: the unit every test of this variant counts. */
  unit: 'conversation';
  conversation_count: number;
  exchange_count: number;
  /** Conversations with at least one scored exchange: the unit a quality or accuracy test counts. */
  scored_conversation_count: number;
  scored_count: number;
  /** Per-metric cluster moments (score over scored exchanges; latency and tokens over every exchange). */
  moments: { score: ClusterMoments; latency: ClusterMoments; tokens: ClusterMoments };
}

const EXPERIMENT_UNIT_COLUMNS = [
  'experiment_id', 'variant_id', 'unit', 'conversation_count', 'exchange_count',
  'scored_conversation_count', 'scored_count',
];

/**
 * THE PER-CONVERSATION READ BEHIND EVERY TEST (§4.2). Same population as `fetchExperimentRows` (one
 * predicate, `experimentPopulationWhere`), grouped first by conversation and then by variant, returning
 * each metric's cluster moments so `clusterDesignEffect` can compute the cluster-robust variance without
 * shipping every conversation to the Lambda. One relevance per exchange, as in the rollup.
 */
async function fetchExperimentUnits(
  win: QueryWindow,
  experimentId: string | undefined,
  includeBattle: boolean,
): Promise<VariantUnits[]> {
  const { where, params } = experimentPopulationWhere(win, experimentId, includeBattle);
  const result = await query(
    `WITH turns AS (
       SELECT m.experiment_id, m.variant_id,
              ${CONVERSATION_SQL} AS conversation,
              er.relevance_score::float8 AS score,
              COALESCE(m.total_ms, e.response_latency_ms, 0)::float8 AS latency,
              (COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0))::float8 AS tokens
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
         LEFT JOIN (
           SELECT exchange_id, AVG(relevance_score) AS relevance_score
             FROM evaluation_results
            WHERE evaluation_type = 'exchange'
            GROUP BY exchange_id
         ) er ON er.exchange_id = e.id
         ${where}
     ),
     per_conversation AS (
       SELECT experiment_id, variant_id, conversation,
              COUNT(*)::float8 AS n,
              SUM(latency) AS lat_t, SUM(latency * latency) AS lat_ss,
              SUM(tokens) AS tok_t, SUM(tokens * tokens) AS tok_ss,
              COUNT(score)::float8 AS sn,
              COALESCE(SUM(score), 0) AS sc_t, COALESCE(SUM(score * score), 0) AS sc_ss
         FROM turns
        GROUP BY experiment_id, variant_id, conversation
     )
     SELECT experiment_id, variant_id,
            COUNT(*) AS conversation_count,
            SUM(n) AS exchange_count,
            SUM(n * n) AS n_sq,
            SUM(lat_t) AS lat_sum, SUM(lat_ss) AS lat_sumsq, SUM(lat_t * lat_t) AS lat_tot_sq, SUM(lat_t * n) AS lat_tot_n,
            SUM(tok_t) AS tok_sum, SUM(tok_ss) AS tok_sumsq, SUM(tok_t * tok_t) AS tok_tot_sq, SUM(tok_t * n) AS tok_tot_n,
            COUNT(*) FILTER (WHERE sn > 0) AS scored_conversation_count,
            SUM(sn) AS scored_count, SUM(sn * sn) AS sn_sq,
            SUM(sc_t) AS sc_sum, SUM(sc_ss) AS sc_sumsq, SUM(sc_t * sc_t) AS sc_tot_sq, SUM(sc_t * sn) AS sc_tot_n
       FROM per_conversation
      GROUP BY experiment_id, variant_id
      ORDER BY experiment_id, variant_id`,
    params,
  );
  const num = (v: unknown): number => Number(v) || 0;
  return (result.rows as any[]).map((r): VariantUnits => {
    const conversations = num(r.conversation_count);
    const exchanges = num(r.exchange_count);
    const scoredConversations = num(r.scored_conversation_count);
    const scored = num(r.scored_count);
    return {
      experiment_id: r.experiment_id,
      variant_id: r.variant_id,
      unit: 'conversation',
      conversation_count: conversations,
      exchange_count: exchanges,
      scored_conversation_count: scoredConversations,
      scored_count: scored,
      moments: {
        score: {
          clusters: scoredConversations, n: scored, sum: num(r.sc_sum), sumSq: num(r.sc_sumsq),
          clusterTotalSq: num(r.sc_tot_sq), clusterTotalTimesSize: num(r.sc_tot_n), clusterSizeSq: num(r.sn_sq),
        },
        latency: {
          clusters: conversations, n: exchanges, sum: num(r.lat_sum), sumSq: num(r.lat_sumsq),
          clusterTotalSq: num(r.lat_tot_sq), clusterTotalTimesSize: num(r.lat_tot_n), clusterSizeSq: num(r.n_sq),
        },
        tokens: {
          clusters: conversations, n: exchanges, sum: num(r.tok_sum), sumSq: num(r.tok_sumsq),
          clusterTotalSq: num(r.tok_tot_sq), clusterTotalTimesSize: num(r.tok_tot_n), clusterSizeSq: num(r.n_sq),
        },
      },
    };
  });
}

/** One battle-scoped effectiveness row: a variant's metrics from its BATTLE turns only. */
interface BattleEffectivenessRow {
  experiment_id: string;
  variant_id: string;
  // ── THE DIMENSIONS A DUEL IS REVIEWED ALONG ───────────────────────────────────────────────────
  //
  // GROUPED, not only filtered. A filter answers "show me premium" and a grouping answers "which
  // rooms did this run in at all" - and a reviewer who cannot see the second cannot tell a variant
  // that genuinely won from one that was only ever tried in the easy room. Each is a real indexed
  // column on `exchanges` (migrations 050, 055, 056); none of this reads JSONB.
  conversation_classification: string | null; // the ROOM the duel ran in
  assistant: string | null;                  // the ASSISTANT that answered (identifier, not a name)
  assistant_role: string | null;              // the role it holds; NULL on history, never defaulted
  profile_version: number | null;             // which version of its profile produced the turns
  /**
   * THE VERSION'S FINGERPRINT, and the key a version is grouped by. An experiment's candidate is served
   * under the live identity (and a duel's control is the live version), so `(assistant, profile_version)`
   * cannot tell a candidate from the live assistant's own version; the configId can, and a promoted
   * version keeps the candidate's configId, so its evidence carries across (DESIGN-EXPERIMENTS-BATTLE-
   * DECISION-LOOP §3.6). Appended, so the earlier columns are unchanged.
   */
  profile_config_id: string | null;
  model_name: string;
  turn_count: number;
  battle_count: number;    // DISTINCT duels these turns came from - turn_count alone cannot say
  avg_score: number | null; // avg relevance where scored; null when no battle turn is scored yet
  avg_cost_usd: number | null; // image-aware; null when the model/usage can't be priced
  battle_wins: number | null; // head-to-head picks this variant won; null when none
}

const BATTLE_EFFECTIVENESS_COLUMNS = [
  'experiment_id', 'variant_id',
  'conversation_classification', 'assistant', 'assistant_role', 'profile_version',
  'model_name', 'turn_count', 'battle_count', 'avg_score', 'avg_cost_usd', 'battle_wins',
  'profile_config_id',
];

/**
 * WHICH TURNS ARE DUEL TURNS, written once.
 *
 * This predicate existed verbatim in three places (the probabilistic rollup, the battle rollup and
 * the per-exchange drill), which is three chances for one of them to be edited and the others not.
 * The COALESCE chain is not decoration: the processor omits `assignmentMode` on a battle turn and
 * `buildAnalyticsMetadata` sets it, older rows carry it flat rather than under `analytics`, and an
 * absent key means an ordinary probabilistic turn.
 *
 * It reads JSONB because there is no `assignment_mode` column. `battle_id` (migration 057) is now a
 * real column and is the better discriminator for anything that needs an index - but it is NOT a
 * substitute here, because it is only as complete as the backfill, and this predicate decides what
 * goes INTO a rollup rather than what a person browses.
 */
const BATTLE_MODE_SQL =
  `COALESCE(m.metadata->'analytics'->>'assignmentMode', m.metadata->>'assignmentMode', 'probabilistic')`;

/** The dimensions a battle review is scoped by. Every field optional: absent means "every value". */
interface BattleScope {
  conversationClassification?: string | null;
  agentType?: string | null;
  assistantRole?: string | null;
  profileVersion?: number | null;
  /**
   * Restrict to turns with NO recorded version, which is a question and not a missing answer.
   * Role and version are NULL on everything archived before they were dimensions, so "which duels
   * predate the record" is exactly what a reviewer asks when the column is half empty.
   */
  profileVersionUnknown?: boolean;
}

/**
 * Read the review scope off the request, with the same tolerance the effectiveness view uses.
 *
 * `profileVersion` arrives as a string (everything in the body is stringified by the param
 * whitelist) and is only accepted as an integer: a non-numeric value becomes null - "every version" -
 * rather than reaching the query as a cast that would error the whole review. An empty string is a
 * cleared filter, not a value.
 */
function battleScopeFrom(params: Record<string, string | undefined>): BattleScope {
  const raw = params.profileVersion;
  // `unknown` is a VALUE here, not a failed parse. It used to fall through the integer check to
  // null - "every version" - so a reviewer asking for turns with no recorded version silently got
  // the whole population while the control showed itself as applied.
  const unknown = raw === 'unknown';
  const version = !unknown && raw !== undefined && raw !== '' && Number.isInteger(Number(raw)) ? Number(raw) : null;
  return {
    conversationClassification: params.conversationClassification || null,
    agentType: params.agentType || null,
    assistantRole: params.assistantRole || null,
    profileVersion: version,
    profileVersionUnknown: unknown,
  };
}

/**
 * The dimension tuple a rollup row is keyed by, rendered as one string for bucketing.
 *
 * `|#|` rather than a control character: every value here is an identifier (`[a-z0-9_-]`) or an
 * integer, so a printable separator cannot collide, and it stays greppable in a log line. A NUL
 * separator would be marginally safer in theory and is not worth a byte no editor renders.
 */
const dimsKey = (r: {
  conversation_classification?: unknown;
  assistant?: unknown;
  assistant_role?: unknown;
  profile_version?: unknown;
  profile_config_id?: unknown;
}): string => [
  r.conversation_classification ?? '',
  r.assistant ?? '',
  r.assistant_role ?? '',
  r.profile_version ?? '',
  r.profile_config_id ?? '',
].join('|#|');

/**
 * WHICH SIDE OF WHICH DUEL RAN UNDER WHICH DIMENSIONS.
 *
 * THE PROBLEM THIS SOLVES. A battle win is recorded per `(experiment, variant)` and carries no
 * classification, role or version - it is a person's pick, and the pick knows only which side won.
 * Once the rollup groups by those dimensions, one variant can legitimately produce several rows, and
 * attaching the variant's whole win tally to each of them would report the same wins two or three
 * times. Summing the column would then exceed the number of battles actually fought.
 *
 * A pick does carry its `battleId`, and `battle_id` is a real column now (migration 057) - so the
 * duel can be resolved to the dimensions its turns ran under, and the win credited to that row
 * alone. Keyed by `(battleId, variantId)` rather than by battle: the two SIDES of one duel can run
 * different profile versions, which is frequently the entire point of the experiment.
 *
 * Fails OPEN to an empty map, like every other best-effort join here: an unresolvable duel makes
 * `battle_wins` null rather than failing the review.
 */
async function battleDimensionsByDuelSide(
  win: QueryWindow,
  experimentId: string | undefined,
): Promise<Map<string, string>> {
  const params: any[] = [win.range, experimentId ?? null];
  try {
    const res = await query(
      `SELECT DISTINCT e.battle_id, e.variant_id,
              e.conversation_classification, e.assistant, e.assistant_role, e.profile_version, e.profile_config_id
         FROM exchanges e
        WHERE e.battle_id IS NOT NULL
          AND e.variant_id IS NOT NULL
          -- THE SAME POPULATION THE ROLLUP GROUPS. Without this, a duel side with both a real and a
          -- queued exchange can yield two dimension tuples, and the one this map keeps may be a
          -- tuple no rollup row has - so that side's wins render as a dash while unresolvedPicks
          -- stays zero, which is the one failure mode that reports nothing at all.
          AND e.queued_as IS NULL
          AND e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND ($2::varchar IS NULL OR e.experiment_id = $2)`,
      params,
    );
    const map = new Map<string, string>();
    for (const r of res.rows as any[]) map.set(`${r.battle_id}::${r.variant_id}`, dimsKey(r));
    return map;
  } catch (err) {
    console.warn('[analytics] could not resolve duel dimensions; battle wins stay unbucketed:', err);
    return new Map();
  }
}

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
  win: QueryWindow,
  experimentId: string | undefined,
  scope: BattleScope = {},
): Promise<BattleEffectivenessRow[]> {
  const queryParams: any[] = [win.range];
  let where = `WHERE m.experiment_id IS NOT NULL
       AND e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
       -- ONE ROW PER TURN. The probabilistic sibling has excluded queued turns since the column
       -- existed and this query never did, so a turn answered out of the queue was counted by both
       -- its own exchange and its queued one - inflating turn_count and double-weighting that turn's
       -- score in the average. A duel is exactly where that matters: the whole output is a
       -- comparison of two averages.
       AND e.queued_as IS NULL
       AND ${BATTLE_MODE_SQL} = 'battle'`;
  if (experimentId) {
    queryParams.push(experimentId);
    where += ` AND m.experiment_id = $${queryParams.length}`;
  }
  // THE REVIEW SCOPE. Each clause is `$n IS NULL OR col = $n` with the parameter always bound, the
  // same idiom `getIntentEffectiveness` uses - so the SQL text is fixed whatever the caller filters
  // on, and there is no string concatenation carrying a user value.
  for (const [value, column, cast] of [
    [scope.conversationClassification, 'e.conversation_classification', 'varchar'],
    [scope.agentType, 'e.assistant', 'varchar'],
    [scope.assistantRole, 'e.assistant_role', 'varchar'],
    [scope.profileVersion, 'e.profile_version', 'int'],
  ] as const) {
    queryParams.push(value ?? null);
    where += ` AND ($${queryParams.length}::${cast} IS NULL OR ${column} = $${queryParams.length})`;
  }
  // "NO RECORDED VERSION" as its own clause, independent of the one above: a bound integer and a
  // bound boolean, so the SQL text stays fixed and the two can never both narrow (the UI offers one
  // pill, and if both arrived the result would correctly be empty rather than wrong).
  queryParams.push(scope.profileVersionUnknown === true);
  where += ` AND ($${queryParams.length}::boolean IS NOT TRUE OR e.profile_version IS NULL)`;

  const result = await query(
    `SELECT
       m.experiment_id,
       m.variant_id,
       e.conversation_classification,
       e.assistant,
       e.assistant_role,
       e.profile_version,
       e.profile_config_id,
       COALESCE(MODE() WITHIN GROUP (ORDER BY m.bedrock_model), 'unknown') AS model_name,
       COUNT(DISTINCT e.id) AS turn_count,
       -- HOW MANY DUELS those turns came from (migration 057). turn_count cannot answer it: a duel
       -- is two rounds per side, so forty turns is ten battles, not forty. NULL battle_id rows are
       -- not counted, so this reads 0 on history the backfill could not reach rather than guessing.
       COUNT(DISTINCT e.battle_id) AS battle_count,
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
     GROUP BY m.experiment_id, m.variant_id,
              e.conversation_classification, e.assistant, e.assistant_role, e.profile_version, e.profile_config_id
     ORDER BY m.experiment_id, m.variant_id,
              e.conversation_classification, e.assistant, e.assistant_role, e.profile_version, e.profile_config_id`,
    queryParams
  );

  // ── WINS, CREDITED TO THE ROW THAT ACTUALLY EARNED THEM ─────────────────────────────────────
  //
  // Each pick is resolved through its own duel to the dimensions that side ran under, so a variant
  // split across two classifications gets its wins split too rather than doubled. A pick whose duel
  // cannot be resolved (archived outside this window, or predating the battle_id backfill) is
  // counted separately and reported: dropping it silently would make the column quietly low, which
  // is the failure this bucketing exists to avoid, wearing the other sign.
  const [outcomes, dimsByDuelSide] = await Promise.all([
    scanBattleOutcomeItems(experimentId),
    battleDimensionsByDuelSide(win, experimentId),
  ]);
  const picks = selectBattlePicks(outcomes, win.startMs, null, win.endMs);
  const winsByRow = new Map<string, number>();
  let unresolvedPicks = 0;
  for (const p of picks) {
    const dims = dimsByDuelSide.get(`${p.battleId}::${p.variantId}`);
    if (dims === undefined) { unresolvedPicks++; continue; }
    const key = `${battleWinKey(String(p.experimentId), String(p.variantId))}|#|${dims}`;
    winsByRow.set(key, (winsByRow.get(key) || 0) + 1);
  }
  if (unresolvedPicks > 0) {
    console.warn(
      '[analytics] battle picks could not be traced to a duel and are NOT counted in battle_wins; '
      + 'they predate the battle_id column or their duel archived outside this window.',
      { unresolvedPicks, totalPicks: picks.length },
    );
  }

  return result.rows.map((r: any): BattleEffectivenessRow => {
    const avgScore = r.avg_score == null ? null : Number(r.avg_score);
    const wins = winsByRow.get(
      `${battleWinKey(r.experiment_id, r.variant_id)}|#|${dimsKey(r)}`,
    );
    return {
      experiment_id: r.experiment_id,
      variant_id: r.variant_id,
      conversation_classification: r.conversation_classification ?? null,
      assistant: r.assistant ?? null,
      assistant_role: r.assistant_role ?? null,
      profile_version: r.profile_version == null ? null : Number(r.profile_version),
      profile_config_id: r.profile_config_id ?? null,
      model_name: r.model_name || 'unknown',
      turn_count: Number(r.turn_count) || 0,
      battle_count: Number(r.battle_count) || 0,
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
  'experiment_id', 'variant_id', 'model_name', 'intent', 'assistant',
  'exchange_count', 'n', 'conversation_count', 'scored_count', 'avg_score', 'score_sd', 'avg_total_ms', 'latency_sd', 'p95_total_ms',
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
  // THE DEFINITION THAT SERVED THE TURN: its profile's name, version and configId. An operator promotes
  // from this view, so each row names what it measured: on a treatment turn that is the candidate in the
  // alt's history, which carries the alt's name and its own version numbers, so the version alone
  // cannot tell it from a version of the live assistant.
  'profile_name', 'profile_version', 'profile_config_id',
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
 * only those carry its `experiment_id`, including the turns of an intent that answers through the `general`
 * route an experiment on `general` covers (`experimentIntentMatches`).
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

  const win = queryWindow(params, 30, 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  const variantId = (params.variantId || '').trim() || null;
  // 'metrics' (default) = probabilistic turns, the A/B population. 'battle' = battle turns only.
  const axis = params.axis === 'battle' ? 'battle' : 'metrics';

  const mode = BATTLE_MODE_SQL;
  const sqlParams: any[] = [win.range, experimentId];
  let where = `WHERE m.experiment_id = $2
                 AND e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
                 -- ONE ROW PER TURN, THE SAME POPULATION BOTH ROLLUPS AGGREGATE (§4.3).
                 --
                 -- This drill exists to let an operator RECOMPUTE the aggregate: "the row count
                 -- equals exchange_count and the mean of the shown scores equals avg_score", and the
                 -- spec calls that reconciliation the feature's own test. Both rollups exclude
                 -- queued exchanges - a queued message answered by the same turn mints a second row
                 -- for it - so a drill that kept them returned more rows than the count it is
                 -- checked against, and the surface would render a quiet contradiction.
                 --
                 -- The mismatch predates the battle axis: fetchExperimentRows has excluded them
                 -- since the column existed and this query never did.
                 AND e.queued_as IS NULL
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
            -- WHICH DEFINITION SERVED (SERVED_PROFILE_SQL): the exchange's column, else the answering
            -- message's, else the metadata key an older row holds. NULL on a turn archived without
            -- attribution.
            ${SERVED_PROFILE_SQL.name} AS profile_name,
            ${SERVED_PROFILE_SQL.version} AS profile_version,
            ${SERVED_PROFILE_SQL.configId} AS profile_config_id,
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
                 AND x.message_id = regexp_replace(m.message_id, ${ARCHIVAL_SUFFIX_SQL}, '') || '-RED'
            ) AS redacted,
            EXISTS (
              SELECT 1 FROM messages x
               WHERE x.channel_arn = m.channel_arn
                 AND x.event_type = 'DELETE_CHANNEL_MESSAGE'
                 AND x.message_id = regexp_replace(m.message_id, ${ARCHIVAL_SUFFIX_SQL}, '') || '-DEL'
            ) AS deleted,
            COUNT(*) OVER() AS total_count,
            -- FULL-MATCH aggregates, computed over every matching exchange rather than the page.
            -- Window functions run before LIMIT, so these hold on page 3 of 40 exactly as on page 1;
            -- without them the mean could only be recomputed by pulling every row, and a paginated
            -- view could never satisfy the reconciliation it exists to make possible.
            --
            -- OVER THE SCORED EXCHANGES, because that is what the aggregate this reconciles against
            -- does (fetchExperimentRows: AVG(er.relevance_score)). Reproducing the number means
            -- reproducing that convention, and scored_count is returned alongside so the operator
            -- can see how much of the population the mean was taken over.
            AVG(er.relevance_score) OVER() AS avg_score_all,
            COUNT(er.relevance_score) OVER() AS scored_count,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM messages x
                 WHERE x.channel_arn = m.channel_arn
                   AND x.event_type IN ('REDACT_CHANNEL_MESSAGE','DELETE_CHANNEL_MESSAGE')
                   AND x.message_id IN (
                         regexp_replace(m.message_id, ${ARCHIVAL_SUFFIX_SQL}, '') || '-RED',
                         regexp_replace(m.message_id, ${ARCHIVAL_SUFFIX_SQL}, '') || '-DEL')
              )
            ) OVER() AS withheld_count
       FROM exchanges e
       JOIN messages m ON e.agent_message_id = m.id
       LEFT JOIN (
         SELECT exchange_id, AVG(relevance_score) AS relevance_score,
                BOOL_AND(is_compliant) AS is_compliant
           FROM evaluation_results
          WHERE evaluation_type = 'exchange'
          GROUP BY exchange_id
       ) er ON er.exchange_id = e.id
       ${where}
       ORDER BY e.created_at DESC
       LIMIT $${sqlParams.length - 1} OFFSET $${sqlParams.length}`,
    sqlParams,
  );

  const rows = (result.rows || []) as Array<Record<string, unknown>>;
  const first = rows[0];
  return success({
    // Each row states its attribution, a missing one as null: the version is a number however the
    // driver returned it, so a reader compares it to the number the Profiles tab lists.
    data: rows.map((r) => ({
      ...r,
      profile_name: r.profile_name ?? null,
      profile_version: r.profile_version == null || r.profile_version === '' ? null : Number(r.profile_version),
      profile_config_id: r.profile_config_id ?? null,
    })),
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

  const win = queryWindow(params, 30, 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  const variantId = (params.variantId || '').trim() || null;

  const records = selectVariantFeedbackRecords(
    await scanFeedbackRecords(experimentId),
    win.startMs,
    params.includeBattle === 'true',
    variantId,
    win.endMs,
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

  const win = queryWindow(params, 30, 180);
  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);
  const variantId = (params.variantId || '').trim() || null;

  const picks = selectBattlePicks(await scanBattleOutcomeItems(experimentId), win.startMs, variantId, win.endMs);

  // WHICH TWO IDS THIS EXPERIMENT ACTUALLY USES, counted once over the whole result rather than the
  // page: a rollup that changed when someone paged would not be a rollup.
  const winsByVariant: Record<string, number> = {};
  for (const p of picks) {
    const v = (p.variantId ?? '').trim();
    if (v) winsByVariant[v] = (winsByVariant[v] || 0) + 1;
  }
  const observed = Object.keys(winsByVariant);
  // The conventional names win when present; otherwise the observed pair stands in, control first so
  // a two-variant experiment is reported consistently rather than by whichever pick landed first.
  const sorted = [...observed].sort();
  const controlId = observed.includes('control') ? 'control' : sorted.find((v) => v !== 'treatment') ?? '';
  const treatmentId = observed.includes('treatment')
    ? 'treatment'
    : sorted.find((v) => v !== controlId) ?? '';

  const page = picks.slice(offset, offset + limit);
  const channelByBattle = await resolveBattleChannels(
    experimentId,
    win,
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
      // RESOLVED FROM THE PICKS, not hardcoded. These two counts read the literal ids 'treatment'
      // and 'control', so an experiment whose variants are named anything else reported 0 and 0 -
      // the human axis of the decision loop, silently empty, on exactly the experiments a custom
      // name implies someone was paying attention to. Variant ids are caller-supplied
      // (`admin-experiments.ts:323` builds its map from whatever was submitted), so custom names are
      // reachable rather than hypothetical.
      //
      // The two names still WIN when present, which keeps every existing experiment reading
      // identically; the fallback only decides the naming for a pair that used neither. Same shape as
      // `decideVerdict`'s control/treatment resolution, so the two cannot disagree about which side
      // is which.
      treatment_wins: picks.filter((p) => p.variantId === treatmentId).length,
      control_wins: picks.filter((p) => p.variantId === controlId).length,
      // The full breakdown, so a three-way comparison is not silently flattened into two buckets.
      // Appended, so the two counts above stay the contract the console already reads.
      wins_by_variant: winsByVariant,
      // How many of the shown picks cannot be traced to a conversation. Stated rather than hidden:
      // a missing link is a gap in the evidence, and an operator reconciling should see its size.
      unresolved_conversations: page.filter((p) => !channelByBattle.get((p.battleId ?? '').trim())).length,
    },
  });
}

/**
 * Map battleId -> channel_arn by looking up the archived battle TURNS that carry it.
 *
 * The id is a one-way hash, so this is the only path back to the conversation. Reads the `battle_id`
 * columns (migrations 057, 073), which archival fills from every carrier the id rides, and returns an
 * empty map on any failure — an unlinkable pick still renders.
 */
async function resolveBattleChannels(
  experimentId: string,
  win: QueryWindow,
  battleIds: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(battleIds));
  if (!unique.length) return new Map();
  try {
    const result = await query(
      `SELECT DISTINCT
              COALESCE(e.battle_id, m.battle_id) AS battle_id,
              e.channel_arn
         FROM exchanges e
         JOIN messages m ON e.agent_message_id = m.id
        WHERE m.experiment_id = $2
          AND e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND COALESCE(e.battle_id, m.battle_id) = ANY($3::text[])`,
      [win.range, experimentId, unique],
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
  const win = queryWindow(params, 30, 180);
  // The probabilistic A/B rows (battle EXCLUDED unless includeBattle) plus the battle-scoped
  // effectiveness rows (battle ONLY) ride the SAME response, so the ExperimentsTab renders both and
  // the battle contenders' metrics are visible without folding them into the A/B rollup. The extra
  // field passes through handlePostQuery's { ...parsed } normalization; no new endpoint/stack wiring.
  const includeBattle = params.includeBattle === 'true';
  const [rows, battleEffectiveness, units] = await Promise.all([
    fetchExperimentRows(win, params.experimentId, includeBattle),
    fetchBattleEffectivenessRows(win, params.experimentId, battleScopeFrom(params)),
    // Fails open for this view only: the table still renders, without the conversation figures. The
    // recommendation reads the same units and fails rather than test without them.
    fetchExperimentUnits(win, params.experimentId, includeBattle).catch((err) => {
      console.warn('[analytics] experiment units unreadable; results render without conversation counts:', err);
      return [] as VariantUnits[];
    }),
  ]);
  return success({
    data: rows,
    columns: EXPERIMENT_COLUMNS,
    battleEffectiveness: { data: battleEffectiveness, columns: BATTLE_EFFECTIVENESS_COLUMNS },
    // Each variant's sample in the unit its tests count (conversations) beside the unit its means are
    // taken over (exchanges), so the console states both. The moments stay server-side.
    units: {
      data: units.map(({ moments: _moments, ...u }) => u),
      columns: EXPERIMENT_UNIT_COLUMNS,
    },
  });
}

/** One round one side of a duel fought, read from the messages it posted (`round_facts`). */
export interface BattleRoundFacts {
  round: number;
  turn_count: number;
  /** The turns whose own span the ledger recorded; `avg_turn_ms` is over these. */
  measured_count: number;
  /** Round one from the person's battle prompt, round two from its declared trigger, to the final answer. */
  avg_turn_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  /** Null when no model the round ran is priceable, never 0. */
  cost_usd: number | null;
}

/**
 * Fold `round_facts` (one row per side, round and model) into each side's rounds.
 *
 * Exported and pure so the attribution rule is testable without a database: a fact is credited to the
 * side it names and to no other, a fact naming no side is counted as unattributed, and the per-model
 * rows of one round are summed into that round, the cost priced per model first (`blendMixCostUsd`).
 */
export function battleRoundsBySide(facts: unknown): {
  bySide: Map<string, BattleRoundFacts[]>;
  unattributed: number;
} {
  const bySide = new Map<string, BattleRoundFacts[]>();
  let unattributed = 0;
  type Acc = BattleRoundFacts & { msSum: number; slices: ReplyModelSlice[] };
  const acc = new Map<string, Map<number, Acc>>();
  for (const f of Array.isArray(facts) ? facts as Array<Record<string, unknown>> : []) {
    const turns = Number(f.turn_count) || 0;
    const side = typeof f.variant_id === 'string' && f.variant_id ? f.variant_id : null;
    if (!side) { unattributed += turns; continue; }
    const round = Number(f.round) || 1;
    const rounds = acc.get(side) ?? new Map<number, Acc>();
    const r = rounds.get(round) ?? {
      round, turn_count: 0, measured_count: 0, avg_turn_ms: null,
      tokens_in: 0, tokens_out: 0, cost_usd: null, msSum: 0, slices: [],
    };
    r.turn_count += turns;
    r.measured_count += Number(f.measured_count) || 0;
    r.msSum += Number(f.turn_ms_sum) || 0;
    r.tokens_in += Number(f.tokens_in) || 0;
    r.tokens_out += Number(f.tokens_out) || 0;
    if (typeof f.model === 'string' && f.model) {
      r.slices.push({ model: f.model, leg: 'answer', replies: turns, tokensIn: Number(f.tokens_in) || 0, tokensOut: Number(f.tokens_out) || 0 });
    }
    rounds.set(round, r);
    acc.set(side, rounds);
  }
  for (const [side, rounds] of acc) {
    bySide.set(side, [...rounds.values()].sort((a, b) => a.round - b.round).map(({ msSum, slices, ...r }) => {
      const priced = blendMixCostUsd(slices);
      return {
        ...r,
        avg_turn_ms: r.measured_count > 0 ? Math.round(msSum / r.measured_count) : null,
        cost_usd: priced.replies > 0 ? Math.round(priced.usd * 1e6) / 1e6 : null,
      };
    }));
  }
  return { bySide, unattributed };
}

interface BattleResultRow {
  battle_id: string;
  fought_at: string;
  channel_arn: string | null;
  conversation_classification: string | null;
  experiment_id: string | null;
  /**
   * When the person sent the `/battle` message that started the duel: that message's own time, read
   * through a round-one exchange's `user_message_id`. Equals `fought_at` when the join finds no message.
   */
  started_at: string;
  /**
   * The `/battle` message's Amazon Chime SDK MessageId (`messages.message_id`), the id the console's
   * conversation viewer opens at. Null when the join finds no message.
   */
  start_message_id: string | null;
  rounds: number;
  sides: number;
  turn_count: number;
  /** One entry per side of the duel, control first where the variant ids allow it. */
  contenders: Array<{
    variant_id: string;
    assistant: string | null;
    assistant_role: string | null;
    profile_version: number | null;
    /** The version's fingerprint: what tells a side's candidate from the live version. */
    profile_config_id: string | null;
    model_name: string | null;
    /** The side's PAIRED turns, the population `avg_score` is scored over. `rounds` counts every turn. */
    turn_count: number;
    avg_score: number | null;
    /** Every round this side fought, paired or not, each with its own span, tokens and cost. */
    rounds: BattleRoundFacts[];
  }>;
  /**
   * Round turns that named no side, on the message or on its exchange. Counted rather than dropped, and
   * a non-zero is a producer that stopped declaring its variant.
   */
  unattributed_round_turns: number;
  /** The majority choice, `tie`, or null when nobody judged this duel. */
  winner_variant_id: string | null;
  /** How many people judged it. 1 and 3 are different confidences in the same word. */
  vote_count: number;
  decided_at: string | null;
}

const BATTLE_RESULT_COLUMNS = [
  'battle_id', 'fought_at', 'channel_arn', 'conversation_classification', 'experiment_id',
  'rounds', 'sides', 'turn_count', 'contenders', 'winner_variant_id', 'vote_count', 'decided_at',
  // Appended: round turns that named no side (battleRoundsBySide).
  'unattributed_round_turns',
  // Appended: the /battle message that started the duel, so a row can open the conversation at it.
  'started_at', 'start_message_id',
];

/**
 * FULL RESULTS, ONE ROW PER DUEL - the view `/battle` has never had.
 *
 * Everything else about battles is a per-VARIANT average across a window: control scored 4.2,
 * treatment 4.4. That answers "which arm is better overall" and cannot answer "how did this battle
 * go", because until `battle_id` became a column (migration 057) there was no key to group a duel's
 * turns by. A reviewer could see two averages and never the duel that produced them.
 *
 * THE ROW IS THE DUEL AND THE SIDES ARE NESTED, rather than two rows joined in the browser. A duel
 * is one thing that happened; splitting it across rows makes every consumer re-pair them, and the
 * pairing is exactly what was missing. `contenders` is built in SQL so the pairing is done once, by
 * the store that holds the facts.
 *
 * THE PICK IS JOINED FROM DYNAMODB, not from Aurora, because that is where a person's judgment is
 * recorded. A duel nobody judged has `winner_variant_id` null - which is not the same as a tie, and
 * the console must not render it as one. Fails OPEN: no outcome table means every duel reads
 * unjudged, and the turn-level facts still render.
 */
async function getBattleResults(
  params: Record<string, string | undefined>
): Promise<APIGatewayProxyResult> {
  const win = queryWindow(params, 30, 180);
  const scope = battleScopeFrom(params);
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 500);
  const offset = Math.max(Number(params.offset) || 0, 0);

  const queryParams: any[] = [
    win.range,
    params.experimentId ?? null,
    scope.conversationClassification ?? null,
    scope.agentType ?? null,
    scope.assistantRole ?? null,
    scope.profileVersion ?? null,
    scope.profileVersionUnknown === true,
    limit,
    offset,
  ];

  // ── THE SCOPE APPLIES TO THE DUEL, NOT TO THE SIDE ────────────────────────────────────────────
  //
  // Filtering the rows directly would return HALF A DUEL: ask for version 7 and a battle whose
  // treatment ran version 7 comes back with its control side missing, so the comparison - the only
  // reason the row exists - is gone. The filter therefore SELECTS BATTLE IDS, and the body then
  // loads every side of the battles that matched. A reviewer filtering on a version sees the duels
  // that version fought, whole.
  const result = await query(
    `WITH matched AS (
       SELECT DISTINCT e.battle_id
         FROM exchanges e
        WHERE e.battle_id IS NOT NULL
          AND e.created_at >= lower($1::tstzrange) AND e.created_at < upper($1::tstzrange)
          AND ($2::varchar IS NULL OR e.experiment_id = $2)
          AND ($3::varchar IS NULL OR e.conversation_classification = $3)
          AND ($4::varchar IS NULL OR e.assistant = $4)
          AND ($5::varchar IS NULL OR e.assistant_role = $5)
          AND ($6::int     IS NULL OR e.profile_version = $6)
          -- "No recorded version" is a question of its own; see the rollup's copy of this clause.
          AND ($7::boolean IS NOT TRUE OR e.profile_version IS NULL)
     ),
     turns AS (
       SELECT e.battle_id, e.variant_id, e.channel_arn, e.conversation_classification,
              e.experiment_id, e.assistant, e.assistant_role, e.profile_version, e.profile_config_id,
              e.battle_round, e.created_at, e.id,
              m.bedrock_model
         FROM exchanges e
         JOIN matched ON matched.battle_id = e.battle_id
         JOIN messages m ON e.agent_message_id = m.id
        WHERE e.queued_as IS NULL
     ),
     scored AS (
       SELECT t.*, er.relevance_score
         FROM turns t
         LEFT JOIN (
           SELECT exchange_id, AVG(relevance_score) AS relevance_score,
                  BOOL_AND(is_grounded) AS is_grounded,
                  MAX(retrieved_passage_count) AS retrieved_passage_count,
                  MAX(rubric_version) AS rubric_version,
                  MAX(sample_stratum) AS sample_stratum
             FROM evaluation_results
            WHERE evaluation_type = 'exchange'
            GROUP BY exchange_id
         ) er ON er.exchange_id = t.id
     ),
     per_side AS (
       SELECT battle_id, variant_id,
              MIN(assistant)      AS assistant,
              MIN(assistant_role)  AS assistant_role,
              MIN(profile_version) AS profile_version,
              MIN(profile_config_id) AS profile_config_id,
              COALESCE(MODE() WITHIN GROUP (ORDER BY bedrock_model), 'unknown') AS model_name,
              COUNT(*) AS turn_count,
              ROUND(AVG(relevance_score)::numeric, 1) AS avg_score
         FROM scored
        GROUP BY battle_id, variant_id
     ),
     -- ── EVERY ROUND EACH SIDE FOUGHT, FROM THE MESSAGES THE ROUND POSTED ──
     --
     -- per_side reads exchanges, so it scores what paired and nothing else. A round is a turn whether or
     -- not it paired: it burned tokens and took time, and the person watched it. So each side's rounds
     -- are read from the bot CREATE rows that carry the duel's id and a round (migration 057, through
     -- idx_messages_battle_id), never from the exchange population.
     --
     -- THE SIDE is the variant the turn declared (messages.variant_id, folded from its update), else the
     -- variant its own exchange carries. A round neither names is counted under a NULL side, which the
     -- row reports as unattributed_round_turns rather than dropping.
     --
     -- ITS SPAN is v_turn_latency.e2e_ms, which for each round is that round's own start to its final
     -- answer: round one from the person's battle prompt, round two from the orchestrator's declared
     -- round-two instant (migration 071). Grouped per model as well, so the cost is priced per model
     -- in JS (decision D4) and then summed per round.
     round_facts AS (
       SELECT bm.battle_id,
              COALESCE(bm.variant_id, bx.variant_id) AS variant_id,
              bm.battle_round AS round,
              bm.bedrock_model,
              COUNT(*) AS turn_count,
              COUNT(bvl.e2e_ms) AS measured_count,
              SUM(bvl.e2e_ms) AS turn_ms_sum,
              COALESCE(SUM(bm.input_tokens), 0) AS tokens_in,
              COALESCE(SUM(bm.output_tokens), 0) AS tokens_out
         FROM messages bm
         JOIN matched ON matched.battle_id = bm.battle_id
         LEFT JOIN LATERAL (
           SELECT ex.variant_id
             FROM exchanges ex
            WHERE ex.agent_message_id = bm.id AND ex.queued_as IS NULL
            ORDER BY ex.created_at
            LIMIT 1
         ) bx ON TRUE
         LEFT JOIN v_turn_latency bvl ON bvl.response_id = bm.message_id AND bvl.channel_arn = bm.channel_arn
        WHERE bm.is_bot = true
          AND bm.event_type = 'CREATE_CHANNEL_MESSAGE'
          AND bm.battle_round IS NOT NULL
        GROUP BY bm.battle_id, COALESCE(bm.variant_id, bx.variant_id), bm.battle_round, bm.bedrock_model
     )
     SELECT b.battle_id,
            b.fought_at,
            -- The /battle message's own time. fought_at is the first ANSWER's time, so it stands in
            -- only when the join below finds no message for the duel.
            COALESCE(s.started_at, b.fought_at) AS started_at,
            s.start_message_id,
            b.channel_arn,
            b.conversation_classification,
            b.experiment_id,
            b.rounds,
            b.turn_count,
            (SELECT COUNT(*) FROM per_side p WHERE p.battle_id = b.battle_id) AS sides,
            (SELECT json_agg(json_build_object(
                      'variant_id', p.variant_id,
                      'assistant', p.assistant,
                      'assistant_role', p.assistant_role,
                      'profile_version', p.profile_version,
                      'profile_config_id', p.profile_config_id,
                      'model_name', p.model_name,
                      'turn_count', p.turn_count,
                      'avg_score', p.avg_score
                    ) ORDER BY p.variant_id)
               FROM per_side p WHERE p.battle_id = b.battle_id) AS contenders,
            (SELECT json_agg(json_build_object(
                      'variant_id', rf.variant_id,
                      'round', rf.round,
                      'model', rf.bedrock_model,
                      'turn_count', rf.turn_count,
                      'measured_count', rf.measured_count,
                      'turn_ms_sum', rf.turn_ms_sum,
                      'tokens_in', rf.tokens_in,
                      'tokens_out', rf.tokens_out
                    ))
               FROM round_facts rf WHERE rf.battle_id = b.battle_id) AS round_facts
       FROM (
         SELECT battle_id,
                MIN(created_at) AS fought_at,
                MIN(channel_arn) AS channel_arn,
                MIN(conversation_classification) AS conversation_classification,
                MIN(experiment_id) AS experiment_id,
                COALESCE(MAX(battle_round), 1) AS rounds,
                COUNT(*) AS turn_count
           FROM scored
          GROUP BY battle_id
       ) b
       -- ── THE MESSAGE THAT STARTED THE DUEL ──
       --
       -- Every round-one exchange answers the person's /battle message, so its user_message_id names
       -- that message; the earliest is taken. A lookup per listed duel, after the population is chosen,
       -- so it adds no row and filters none. messages.message_id is the Amazon Chime SDK MessageId,
       -- the id the console's conversation viewer opens at.
       LEFT JOIN LATERAL (
         SELECT um.created_at AS started_at,
                um.message_id AS start_message_id
           FROM exchanges se
           JOIN messages um ON um.id = se.user_message_id
          WHERE se.battle_id = b.battle_id
            AND COALESCE(se.battle_round, 1) = 1
          ORDER BY um.created_at
          LIMIT 1
       ) s ON TRUE
      ORDER BY b.fought_at DESC
      LIMIT $8 OFFSET $9`,
    queryParams,
  );

  // WHO WON, from the store that holds a person's judgment. Keyed by battle so a duel shows its own
  // outcome rather than a window-wide tally.
  // ── A DUEL CAN BE JUDGED BY SEVERAL PEOPLE, AND THE VOTES ARE COUNTED ────────────────────────
  //
  // `scanBattleOutcomeItems` returns one row PER VOTER. Keying a map by battle and assigning would
  // therefore report whichever voter the scan happened to yield last as "the" winner, silently, with
  // a split vote indistinguishable from a unanimous one. Every other consumer of these items
  // (`selectBattlePicks`, `aggregateBattleWinsByVariant`) counts them all, and so does this.
  //
  // The reported winner is the variant with the most votes; an equal top count is a `tie`, which is
  // the same answer a single voter's explicit tie gives. `vote_count` rides alongside so a 2-1 is
  // legible as a 2-1 rather than as a win.
  const votesByBattle = new Map<string, { counts: Map<string, number>; latest: string | null }>();
  try {
    for (const p of await scanBattleOutcomeItems(params.experimentId)) {
      if (!p.battleId) continue;
      const key = String(p.battleId);
      const entry = votesByBattle.get(key) || { counts: new Map<string, number>(), latest: null };
      // An explicit tie credits no side but IS a judgment, so it is counted under its own label -
      // never dropped, which would make a duel everyone tied read as unjudged.
      const choice = (p.variantId ?? '').trim() || (p.winner === 'tie' ? 'tie' : '');
      if (choice) entry.counts.set(choice, (entry.counts.get(choice) || 0) + 1);
      const at = p.chosenAt ?? null;
      if (at && (!entry.latest || at > entry.latest)) entry.latest = at;
      votesByBattle.set(key, entry);
    }
  } catch (err) {
    console.warn('[analytics] battle outcomes unreadable; duels render unjudged:', err);
  }

  /** The majority choice, or `tie` when the top count is shared. Null when nobody judged. */
  const verdictOf = (battleId: string): { winner: string | null; votes: number; at: string | null } => {
    const entry = votesByBattle.get(battleId);
    if (!entry || entry.counts.size === 0) return { winner: null, votes: 0, at: null };
    let top = -1;
    let leaders: string[] = [];
    for (const [choice, n] of entry.counts) {
      if (n > top) { top = n; leaders = [choice]; } else if (n === top) { leaders.push(choice); }
    }
    const votes = [...entry.counts.values()].reduce((a, b) => a + b, 0);
    return { winner: leaders.length === 1 ? leaders[0] : 'tie', votes, at: entry.latest };
  };

  const data = (result.rows as any[]).map((r): BattleResultRow => {
    const verdict = verdictOf(String(r.battle_id));
    const { bySide, unattributed } = battleRoundsBySide(r.round_facts);
    // A SIDE THAT FOUGHT AND NEVER PAIRED IS STILL A SIDE. per_side lists the sides with an exchange;
    // a side whose every round went unpaired would vanish from its own duel, so it is added from its
    // rounds with no paired turns and no score.
    const scoredSides = new Set<string>((r.contenders || []).map((c: any) => String(c.variant_id)));
    const roundOnlySides = [...bySide.keys()].filter((v) => !scoredSides.has(v)).sort();
    return {
      battle_id: r.battle_id,
      fought_at: r.fought_at,
      channel_arn: r.channel_arn ?? null,
      conversation_classification: r.conversation_classification ?? null,
      experiment_id: r.experiment_id ?? null,
      // The SQL already stands fought_at in for a duel with no start message; kept here for a row without the column.
      started_at: r.started_at ?? r.fought_at,
      start_message_id: r.start_message_id ?? null,
      rounds: Number(r.rounds) || 1,
      // The sides listed below, so the count and the list cannot disagree.
      sides: (Number(r.sides) || 0) + roundOnlySides.length,
      turn_count: Number(r.turn_count) || 0,
      contenders: [
        ...(r.contenders || []).map((c: any) => ({
          variant_id: c.variant_id,
          assistant: c.assistant ?? null,
          assistant_role: c.assistant_role ?? null,
          profile_version: c.profile_version == null ? null : Number(c.profile_version),
          profile_config_id: c.profile_config_id ?? null,
          model_name: c.model_name ?? null,
          turn_count: Number(c.turn_count) || 0,
          avg_score: c.avg_score == null ? null : Number(c.avg_score),
          rounds: bySide.get(String(c.variant_id)) ?? [],
        })),
        ...roundOnlySides.map((v) => ({
          variant_id: v,
          assistant: null,
          assistant_role: null,
          profile_version: null,
          profile_config_id: null,
          model_name: null,
          turn_count: 0,
          avg_score: null,
          rounds: bySide.get(v) ?? [],
        })),
      ],
      unattributed_round_turns: unattributed,
      winner_variant_id: verdict.winner,
      vote_count: verdict.votes,
      decided_at: verdict.at,
    };
  });

  return success({ data, columns: BATTLE_RESULT_COLUMNS });
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
  /** `picks` are decisive picks; `duels` the duels they judged, the unit the interval is computed in. */
  human?: { picks: number; duels?: number; winRate: number; ci: [number, number]; significant: boolean };
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
    /** Conversations the votes came from: the unit the interval is computed in. */
    conversations: number;
  };
  recommendedVsChosen?: { recommended: string; chosen?: ExperimentDecision['outcome'] };
  /** CONVERSATIONS per variant this deployment requires before a verdict is decision-grade. Configurable,
   *  so a caller must read it rather than assume one. */
  minSamplePerVariant?: number;
  /**
   * The unit of analysis (§4.2): every metric test, guardrail and power figure counts `conversation`s, and
   * each variant reports `conversation_count` beside `exchange_count`. The battle pick counts duels.
   */
  unit?: 'conversation';
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
  /** The unit the stats are in; the recommendation always passes `conversation` (§4.2). */
  unit?: 'conversation' | 'exchange';
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
  const win = queryWindow(params, 30, 180);
  const experimentId = params.experimentId;
  if (!experimentId) {
    return error(400, 'experimentId is required');
  }
  const objective = parseJsonParam<ExperimentObjective>(params.objective);
  const decision = parseJsonParam<ExperimentDecision>(params.decision);

  // `includeBattle: false` keeps battle TURNS out of the probabilistic averages (rollup-safety), but
  // the rows still carry each variant's battle WINS, which is what feeds the human axis below. The
  // two are deliberately different populations: metrics exclude the duel, the human pick is the duel.
  //
  // ONE scan of the votes and the picks serves the rollup's columns and the clustered human axes below, so
  // the axes test exactly the votes and picks the columns count.
  const [feedback, picks] = await Promise.all([
    scanFeedbackRecords(experimentId),
    scanBattleOutcomeItems(experimentId),
  ]);
  const [rows, units] = await Promise.all([
    fetchExperimentRows(win, experimentId, false, { feedback, picks }),
    fetchExperimentUnits(win, experimentId, false),
  ]);
  const unitsByVariant = new Map(units.map((u) => [u.variant_id || 'unknown', u]));
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
      // ── THREE DENOMINATORS IN ONE ACCUMULATOR, ON PURPOSE ────────────────────────────────────
      //
      // `_scoreWeight` carries avg_score / avg_total_ms / avg_cost_usd / fallback_rate - measures that
      // exist for every exchange, so their denominator is simply the traffic.
      // `_taskWeight` and `_complianceWeight` carry the two that do NOT: a group with no tasks and a
      // group nothing has assessed contribute no opinion, and folding either onto `_scoreWeight`
      // averages a real number against rows that never had one.
      //
      // Stated here because the shapes look interchangeable and are not. Compliance was folded onto
      // `_scoreWeight` until an unassessed intent started arriving as a confident 0%.
      variant_id: key, model_name: r.model_name, exchange_count: 0,
      avg_score: 0, avg_total_ms: 0, avg_cost_usd: 0, compliance_rate: null,
      fallback_rate: 0, task_completion_rate: null,
      thumbs_up: 0, thumbs_down: 0, feedback_count: 0, battle_wins: 0,
      _scoreWeight: 0, _scoredWeight: 0, _taskWeight: 0, _complianceWeight: 0,
    };
    const n = Number(r.exchange_count) || 0;
    acc.exchange_count += n;
    // Weighted by SCORED exchanges, the population each row's avg_score is taken over, so the figure shown
    // is the mean the quality test runs on.
    acc.avg_score += (Number(r.avg_score) || 0) * (Number(r.scored_count) || 0);
    acc._scoredWeight += Number(r.scored_count) || 0;
    acc.avg_total_ms += (Number(r.avg_total_ms) || 0) * n;
    acc.avg_cost_usd += (Number(r.avg_cost_usd) || 0) * n;
    // COMPLIANCE CARRIES ITS OWN WEIGHT, because NULL here means "nothing in this group was
    // assessed" - not "this group scored zero". `|| 0` against the shared `_scoreWeight` folded an
    // unassessed intent in as a 0% compliant group at full exchange weight, so a variant with one
    // assessed intent out of four reported a quarter of its real rate and looked catastrophically
    // non-compliant to the ship recommendation. Weighted like task_completion_rate: only the groups
    // that have an answer contribute, and a variant with none stays NULL rather than becoming 0.
    if (r.compliance_rate != null) {
      acc.compliance_rate = (acc.compliance_rate || 0) + Number(r.compliance_rate) * n;
      acc._complianceWeight += n;
    }
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
    // THE SCORE IS POOLED OVER SCORED EXCHANGES, the population `avg_score` and `score_sd` are taken over
    // (`AVG(er.relevance_score)` skips an unscored exchange). Weighting it by every exchange counted
    // unscored traffic as evidence in the Welch test's n.
    grp.score.push({ n: Number(r.scored_count) || 0, mean: Number(r.avg_score) || 0, sd: r.score_sd == null ? 0 : Number(r.score_sd) });
    grp.latency.push({ n, mean: Number(r.avg_total_ms) || 0, sd: r.latency_sd == null ? 0 : Number(r.latency_sd) });
    grp.tokens.push({ n, mean: Number(r.avg_tokens) || 0, sd: r.tokens_sd == null ? 0 : Number(r.tokens_sd) });
    if (r.avg_cost_usd != null) {
      grp.cost.push({ n, mean: Number(r.avg_cost_usd), sd: r.cost_sd == null ? 0 : Number(r.cost_sd) });
    }
    statsByVariant.set(key, grp);
  }
  const variants = Array.from(byVariant.values()).map((v) => {
    const w = v._scoreWeight || 1;
    const u = unitsByVariant.get(v.variant_id);
    return {
      variant_id: v.variant_id,
      model_name: v.model_name,
      // BOTH UNITS (§4.2): the tests count conversations, the means are over exchanges.
      unit: 'conversation' as const,
      conversation_count: u?.conversation_count ?? 0,
      exchange_count: v.exchange_count,
      scored_conversation_count: u?.scored_conversation_count ?? 0,
      scored_count: statsByVariant.get(v.variant_id)?.scored ?? 0,
      avg_score: v._scoredWeight ? Math.round((v.avg_score / v._scoredWeight) * 10) / 10 : 0,
      avg_total_ms: Math.round(v.avg_total_ms / w),
      avg_cost_usd: Math.round((v.avg_cost_usd / w) * 1e6) / 1e6,
      compliance_rate: v._complianceWeight
        ? Math.round((v.compliance_rate / v._complianceWeight) * 10) / 10
        : null,
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

  // THE FLOOR COUNTS CONVERSATIONS, the unit every test below counts (§4.2). Forty turns of one person's
  // conversation are one conversation's worth of evidence, not forty.
  const minN = variants.length ? Math.min(...variants.map((v) => v.conversation_count)) : 0;

  // The two sides, oriented once for the clustered human axes.
  const controlId = (variants.find((v) => v.variant_id === 'control') || variants[0])?.variant_id ?? 'control';
  const treatmentId =
    (variants.find((v) => v.variant_id === 'treatment') || variants.find((v) => v.variant_id !== controlId) || variants[1])?.variant_id
    ?? 'treatment';
  // A pick is tested per DUEL; a vote per CONVERSATION. Each is grouped from the same scan its column counts.
  const duels = duelPickClusters(picks, experimentId, win.startMs, win.endMs, treatmentId, controlId);
  const votesByVariant = approvalClustersByVariant(feedback, win.startMs, false, win.endMs);
  const voteClusters = {
    treatment: votesByVariant.get(battleWinKey(experimentId, treatmentId)) ?? [],
    control: votesByVariant.get(battleWinKey(experimentId, controlId)) ?? [],
  };

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
  const humanAxis = battlePickAxis(variants, duels);
  // Approval is the other human signal, on ordinary traffic rather than duels. Same reasoning as the
  // battle axis: it is not gated by the probabilistic floor, because it is a separate measurement
  // reported alongside rather than an input to the metric verdict.
  const approval = approvalAxis(variants, voteClusters);

  if (variants.length < 2 || minN < MIN_SAMPLE_PER_VARIANT) {
    const metricNote = variants.length < 2
      ? 'Only one variant has recorded traffic, so there is nothing to compare on metrics yet.'
      : `The smallest variant has ${minN} conversation${minN === 1 ? '' : 's'}, below the ${MIN_SAMPLE_PER_VARIANT}-conversation floor for a reliable metric read.`;
    // Say what the human signal shows even though the metric half is not ready, so an operator
    // running a battle-led evaluation sees their picks rather than a bare "keep it running".
    const humanNote = humanAxis
      ? ` Human picks so far: ${Math.round(humanAxis.winRate * 100)}% for treatment across ${humanAxis.picks} `
        + `pick${humanAxis.picks === 1 ? '' : 's'} in ${humanAxis.duels} battle${humanAxis.duels === 1 ? '' : 's'} `
        + `(95% CI ${Math.round(humanAxis.ci[0] * 100)}-${Math.round(humanAxis.ci[1] * 100)}%), `
        + `which ${humanAxis.significant ? 'excludes' : 'includes'} 50%. That is the human axis only; it does not `
        + 'settle the metric comparison.'
      : ' No battle picks recorded yet either.';
    const approvalNote = approval
      ? ` User approval: ${Math.round(approval.treatmentRate * 100)}% treatment vs `
        + `${Math.round(approval.controlRate * 100)}% control across ${approval.votes} vote`
        + `${approval.votes === 1 ? '' : 's'} in ${approval.conversations} conversation`
        + `${approval.conversations === 1 ? '' : 's'} (95% CI on the difference `
        + `${(approval.ci[0] * 100).toFixed(1)} to ${(approval.ci[1] * 100).toFixed(1)} points), `
        + `which ${approval.significant ? 'excludes' : 'includes'} zero.`
      : '';
    const rec = inconclusiveRecommendation(`${metricNote}${humanNote}${approvalNote}`, objective, decision);
    return success({
      ...rec,
      ...(humanAxis ? { human: humanAxis } : {}),
      ...(approval ? { approval } : {}),
      unit: 'conversation',
      variants,
      experimentId,
    });
  }

  // Pool each variant's per-intent groups into one (mean, sd, n) per metric, then re-express each in
  // CONVERSATION units (§4.2): the mean stays the per-exchange mean, and the variance becomes the
  // cluster-robust one through the metric's design effect, so the Welch tests, the guardrails and the power
  // calculation all count conversations. Cost has no per-exchange column (it is priced from tokens per
  // model), so it takes the tokens' design effect over the conversations its priced rows came from.
  const pooled = new Map<string, VariantContinuousStats>();
  for (const [key, grp] of statsByVariant) {
    const u = unitsByVariant.get(key);
    const score = poolGroups(grp.score);
    const latency = poolGroups(grp.latency);
    const cost = poolGroups(grp.cost);
    const tokens = poolGroups(grp.tokens);
    const conversations = u?.conversation_count ?? 0;
    const tokensDeff = u ? clusterDesignEffect(u.moments.tokens) : 1;
    const exchanges = u?.exchange_count || tokens.n || 1;
    pooled.set(key, {
      score: clusterAdjust(score, u ? clusterDesignEffect(u.moments.score) : 1, u?.scored_conversation_count ?? 0),
      latency: clusterAdjust(latency, u ? clusterDesignEffect(u.moments.latency) : 1, conversations),
      cost: clusterAdjust(cost, tokensDeff, Math.round(conversations * Math.min(1, cost.n / exchanges))),
      tokens: clusterAdjust(tokens, tokensDeff, conversations),
      scoredCount: grp.scored,
      unit: 'conversation',
    });
  }

  const rec = await computeRecommendation(variants, pooled, objective, decision, { duels: duels.clusters, voteClusters });
  return success({
    ...rec,
    ...(humanAxis && rec.human ? { human: { ...rec.human, duels: humanAxis.duels } } : {}),
    unit: 'conversation',
    variants,
    experimentId,
  });
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
  duels?: { clusters: SignalCluster[]; picks: number; duels: number },
): { picks: number; duels: number; winRate: number; ci: [number, number]; significant: boolean } | null {
  if (variants.length < 2) return null;
  // A PICK IS PER DUEL (§4.2). With the picks grouped by the duel they judged, the interval is computed in
  // duels, so three people judging one duel are one duel's evidence. Without the grouping every pick is
  // taken as its own duel, which is exact when each duel has one judge.
  if (duels && duels.picks > 0) {
    const r = clusteredHumanPickTest(duels.clusters);
    return { picks: r.picks, duels: r.units, winRate: r.winRate, ci: r.ci as [number, number], significant: r.significant };
  }
  const control = variants.find((v) => v.variant_id === 'control') || variants[0];
  const treatment = variants.find((v) => v.variant_id === 'treatment') || variants.find((v) => v !== control) || variants[1];
  const tWins = Number(treatment?.battle_wins) || 0;
  const cWins = Number(control?.battle_wins) || 0;
  const decisive = tWins + cWins;
  if (decisive <= 0) return null;
  const r = humanPickTest(tWins, decisive);
  return { picks: r.picks, duels: r.picks, winRate: r.winRate, ci: r.ci as [number, number], significant: r.significant };
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
  clusters?: { treatment: SignalCluster[]; control: SignalCluster[] },
): {
  controlRate: number; treatmentRate: number; delta: number; ci: [number, number];
  pValue: number; significant: boolean; votes: number; conversations: number;
} | null {
  if (variants.length < 2) return null;
  // A VOTE IS TESTED PER CONVERSATION (§4.2): several votes in one conversation are one person's view of one
  // version, so the interval is computed with the votes grouped by the conversation they were cast in. The
  // rates are the per-vote rates. Without the grouping each vote is its own conversation.
  if (clusters) {
    const r = clusteredTwoProportionTest(clusters.treatment, clusters.control);
    if (r.nA + r.nB <= 0) return null;
    return {
      controlRate: r.pB,
      treatmentRate: r.pA,
      delta: r.delta,
      ci: r.ci,
      pValue: r.pValue,
      significant: r.ci[0] > 0 || r.ci[1] < 0,
      votes: r.nA + r.nB,
      conversations: r.unitsA + r.unitsB,
    };
  }
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
    conversations: cN + tN,
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
  grouped?: { duels: SignalCluster[]; voteClusters: { treatment: SignalCluster[]; control: SignalCluster[] } },
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
  const approvalOnPoweredPath = approvalAxis(variants, grouped?.voteClusters);

  const { primary, guardrails, human: hp, humanPickWeight, verdict, confidence, humanAgrees, humanConflicts } =
    evaluateExperimentOutcome({
      control: cStats,
      treatment: tStats,
      objective: objective as OutcomeObjective | undefined,
      battleWins: { treatment: Number(treatment.battle_wins) || 0, control: Number(control.battle_wins) || 0 },
      // Per duel when the picks are grouped (§4.2); otherwise each pick is its own duel.
      ...(grouped && grouped.duels.length > 0 ? { battleDuels: grouped.duels } : {}),
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
  // THE UNIT, stated first, so every figure after it is read in it (§4.2).
  if (a.control?.conversation_count != null && a.treatment?.conversation_count != null) {
    parts.push(
      `Tested per conversation: control ${a.control.conversation_count} conversations (${a.control.exchange_count} exchanges), `
      + `treatment ${a.treatment.conversation_count} conversations (${a.treatment.exchange_count} exchanges).`,
    );
  }
  parts.push(
    `Primary metric ${a.primary.metric}: treatment ${a.primary.deltaPct >= 0 ? '+' : ''}${a.primary.deltaPct}% vs control (CI [${a.primary.ci[0]}, ${a.primary.ci[1]}], ${sigTxt}).`,
  );
  // Each guardrail is narrated as the state it is actually in. Three things were wrong with saying
  // "breach ... (significant)" or otherwise "guardrails held": the significance behind a breach is now
  // against the BOUND rather than against zero, so "significant" no longer names what was tested; an
  // `at_least` breach is a required improvement MISSED, not a regression past a maximum, and calling a
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
    const units = (a.hp as { units?: number }).units;
    const inDuels = units != null ? ` in ${units} battle${units === 1 ? '' : 's'}` : '';
    const human = `Humans: ${a.hp.wins}/${a.hp.picks} picked treatment${inDuels} (${pct}% [${lo}-${hi}%]${a.hp.significant ? ', excludes 50%' : ', not significant'}).`;
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
