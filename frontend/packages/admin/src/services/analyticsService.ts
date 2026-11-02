import i18n from '@ae/shared/i18n';
import { teamCanQuery, teamAssistant, TEAM_REASONED_QUERIES } from './teamScope';
import { adminApiConfigured, adminUrl } from './adminApi';
import { reasonFor } from './adminReason';
import type {
  AnalyticsDateRange,
  AnalyticsResult,
  ExperimentRecommendation,
  QueryType,
  AdminConversationEvent,
} from '@ae/shared';
import { consoleCredentials, sigv4GetJson, sigv4PostJson } from './sigv4Fetch';

/** Throws the named configuration error when `AdminApi` (and with it the analytics surface) is unconfigured. */
function requireAnalyticsApi(): void {
  if (!adminApiConfigured()) {
    throw new Error(i18n.t('admin.analyticsService.vite_analytics_api_urlNotConfigured'));
  }
}

/**
 * A14: the analytics API resource path a queryType is authorized on (mirrors the
 * backend `admin-capability-map.ts` partition — keep in sync). The sensitive
 * queryTypes post to their own IAM-authorized sub-path; everything else posts to
 * the root (the low-sensitivity view-analytics bundle). Under IAM enforcement the
 * gateway denies a persona role that lacks the capability's resource.
 */
const ANALYTICS_SUBPATH_FOR_QUERY: Record<string, string> = {
  channel_events: 'events-log',
  // Content, not an aggregate: it returns the first 100 characters of a person's message as `topic`
  // and the first 500 as `summary`. It used to be unlisted on both sides, which meant the root
  // resource - the low-sensitivity bundle - served message content. Posting it here now would 403
  // under IAM enforcement, which is the point.
  cross_conversation_context: 'events-log',
  user_activity: 'user-activity',
  active_users_daily: 'user-activity',
  active_messaging_users_daily: 'user-activity',
  messages_per_user: 'user-activity',
  messages_per_tier_daily: 'user-activity',
  signup_funnel_conversion: 'user-activity',
  signin_funnel_conversion: 'user-activity',
  // The guest-to-customer funnel and the guest refusals (B12): who visited and who became a customer.
  guest_to_customer_funnel: 'user-activity',
  guest_refusals: 'user-activity',
  moderation_audit: 'moderation-audit',
  // The audit WRITE has its own resource, apart from the audit read.
  record_moderation: 'moderation-record',
  // An adjudication is a human label, the same capability as a ground-truth submission.
  classifier_replay_adjudicate: 'ground-truth',
  // Not a capability split — a NETWORK one. Starting a classifier replay is `view-analytics` like
  // the rest of the gate, but the root resource is served by a VPC-attached function that cannot
  // invoke the replay Lambda (isolated subnets, no route to the Lambda control plane), so the start
  // has its own non-VPC function on its own resource. See classifier-replay-start.ts.
  classifier_replay_start: 'classifier-replay-start',
};

/**
 * WRITES THAT RIDE A READ QUERY TYPE, routed by their `action` (mirrors the backend partition). Reading
 * the flagged queue is the analytics bundle; flagging, unflagging or reviewing a response is triage, and
 * submitting a label is ground truth - each its own capability on its own resource.
 */
const ANALYTICS_SUBPATH_FOR_WRITE: Record<string, { actions: string[]; path: string }> = {
  flagged_responses: { actions: ['flag', 'unflag', 'review'], path: 'triage' },
  ground_truth: { actions: ['submit'], path: 'ground-truth' },
  // A golden-set nomination, retirement or promotion is the same act as a label (SPEC-EVALUATION FR16).
  golden_set: { actions: ['nominate', 'retire', 'promote'], path: 'ground-truth' },
};

function analyticsPathForQuery(queryType: string, action?: unknown): string {
  const write = ANALYTICS_SUBPATH_FOR_WRITE[queryType];
  const sub = write && typeof action === 'string' && write.actions.includes(action)
    ? write.path
    : ANALYTICS_SUBPATH_FOR_QUERY[queryType];
  requireAnalyticsApi();
  // A team member's queries and writes go to their assistant's routes, which bind each to that assistant.
  // The team routes are the query and the two quality writes; a team never asks for another
  // (`teamCanQuery`), and an unscoped route a team session does not hold is refused at the gateway.
  const team = teamAssistant();
  if (team) {
    const a = encodeURIComponent(team);
    if (!sub) return adminUrl('analytics', `/analytics/assistants/${a}/query`);
    if (sub === 'triage') return adminUrl('analytics', `/analytics/assistants/${a}/triage`);
    if (sub === 'ground-truth') return adminUrl('analytics', `/analytics/assistants/${a}/ground-truth`);
  }
  // Each capability resource, written out so the route the console calls is readable at the call.
  switch (sub) {
    case undefined: return adminUrl('analytics', '/');
    case 'events-log': return adminUrl('analytics', '/events-log');
    case 'user-activity': return adminUrl('analytics', '/user-activity');
    case 'moderation-audit': return adminUrl('analytics', '/moderation-audit');
    case 'moderation-record': return adminUrl('analytics', '/moderation-record');
    case 'ground-truth': return adminUrl('analytics', '/ground-truth');
    case 'triage': return adminUrl('analytics', '/triage');
    case 'classifier-replay-start': return adminUrl('analytics', '/classifier-replay-start');
    default: throw new Error(`No analytics route is declared for ${sub}`);
  }
}

/**
 * Detect whether the backend is running in Aurora mode.
 * Checks via VITE_ANALYTICS_MODE env var first, then probes the backend.
 * Caches the result for the session.
 */
let cachedMode: 'athena' | 'aurora' | null = null;

export async function detectAnalyticsMode(): Promise<'athena' | 'aurora'> {
  // Check env var first (fastest, no network)
  const envMode = import.meta.env.VITE_ANALYTICS_MODE;
  if (envMode === 'aurora' || envMode === 'athena') {
    return envMode;
  }

  // Return cached result
  if (cachedMode) return cachedMode;

  // Probe the backend — Aurora mode has the /analytics/evaluation endpoint. Raw fetch
  // (not apiCall) so a missing token or a network failure both fall back to
  // 'athena' instead of throwing — this must never throw.
  try {
    const idToken = localStorage.getItem('idToken');
    if (!idToken) return 'athena';

    requireAnalyticsApi();
    const probeUrl = adminUrl('analytics', '/analytics/evaluation');
    // The evaluation GET is IAM-authorized, so the probe is signed with the operator's sign-on creds.
    // (Setting VITE_ANALYTICS_MODE skips this entirely.)
    const creds = await consoleCredentials();
    await sigv4GetJson(probeUrl, { days: 1 }, creds);
    cachedMode = 'aurora'; // a 2xx (no throw) means the Aurora evaluation route answered
  } catch {
    cachedMode = 'athena';
  }

  return cachedMode;
}

/** The COMPLETE archived event log for a channel (every event_type) — the dev-persona view.
 *  Served by the analytics API's channel_events query. */
export async function listChannelEvents(channelArn: string): Promise<AdminConversationEvent[]> {
  const res = await queryAnalytics('channel_events', undefined, { channelArn });
  return ((res.data as unknown) as AdminConversationEvent[]) || [];
}

/**
 * A WRITE through the analytics API, WHERE A REFUSAL ARRIVES AS HTTP 200.
 *
 * The write actions answer `{ submitted | flagged | reviewed | unflagged: false, error: '...' }` with a
 * 200 status, because the request was well-formed and authorized — what failed is the write's own
 * precondition: a label that cannot be attributed to a caller, a missing reason, an unknown verdict.
 * `apiCall` and `sigv4PostJson` only throw on a non-2xx, so a caller that awaits and moves on reports
 * SUCCESS for a write that did not happen: the console refreshes, no error appears, and the row is
 * simply absent. That is the same "it succeeds and then counts" failure the server-side guards exist to
 * prevent, arriving one layer up.
 *
 * A non-empty `error` on a write envelope means the write did not happen, whatever the verb. Reads
 * never carry one, which is why this can be verb-agnostic rather than knowing each action's flag.
 */
export async function writeAnalytics(
  queryType: string,
  extra: Record<string, unknown>,
  dateRange?: AnalyticsDateRange,
): Promise<void> {
  const res = (await queryAnalytics(queryType as QueryType, dateRange, extra)) as unknown as { error?: unknown };
  const refusal = typeof res?.error === 'string' ? res.error.trim() : '';
  if (refusal) throw new Error(refusal);
}

/**
 * Record a moderation action for attribution. The analytics Lambda stamps the SERVER-VERIFIED
 * admin identity (from the JWT) into moderation_actions — the client only names the target, never
 * the actor. Best-effort: the Chime redact/delete already succeeded, so callers ignore failures.
 *
 * DELIBERATELY NOT `writeAnalytics`: its contract is that it cannot fail the operation it audits, and
 * the redact or delete has already happened by the time it runs. Raising here would turn a completed
 * moderation into a visible error with nothing for the operator to do about it.
 */
export async function recordModeration(
  channelArn: string,
  messageId: string,
  moderation: 'redact' | 'delete'
): Promise<void> {
  await queryAnalytics('record_moderation', undefined, {
    channelArn,
    messageId,
    moderation,
  });
}

/**
 * Raise a flag on a response from Oversight, so a moderator's judgement lands somewhere.
 *
 * NOT a moderation action, and deliberately not routed through `recordModeration`: redact and
 * delete remove content, this records an opinion about quality, and folding a quality verdict into
 * the removal audit would make "was this message redacted" a question you have to filter to answer.
 * It rides the `flagged_responses` queryType as an action, the way review and ground-truth submit
 * already do, so it inherits their capability path rather than needing a new one.
 *
 * The actor is stamped server-side from the JWT; the client names only the target and the reason.
 */
export async function flagResponse(
  channelArn: string,
  messageId: string,
  reason: 'wrong_assistant' | 'poor_answer' | 'asked_again',
  notes?: string
): Promise<void> {
  await writeAnalytics('flagged_responses', {
    action: 'flag',
    channelArn,
    messageId,
    reason,
    notes,
  });
}

/** Withdraw a flag. Deletes it rather than recording a 'cleared' state: an unflagged response is
 *  the ABSENCE of a flag, the same way an unreviewed one is the absence of a review. */
export async function unflagResponse(channelArn: string, messageId: string): Promise<void> {
  await writeAnalytics('flagged_responses', {
    action: 'unflag',
    channelArn,
    messageId,
  });
}

export async function queryAnalytics(
  queryType: QueryType,
  dateRange: AnalyticsDateRange | undefined,
  extra?: Record<string, unknown>
): Promise<AnalyticsResult> {
  /**
   * AN EMPTY WINDOW IS NOT A WINDOW, AND SENDING ONE IS REFUSED.
   *
   * The backend's rule is explicit: `dateRange` ABSENT means no window was named and the query's own
   * default stands for it, while `dateRange` PRESENT and unusable is REFUSED rather than answered with
   * a different window - the one thing it may not do is answer a named window with another. Its error
   * even says the fix: "omit dateRange to accept the default window"
   * (`analytics-aurora/analytics-query.ts`).
   *
   * Three call sites in this file passed `{ start: '', end: '' }` to mean "no window", which is PRESENT
   * and unusable, so every one of them took a 400. The conversation Events panel showed the operator
   * "Analytics query failed: 400" in place of the archived event log, and `record_moderation` - a
   * best-effort audit whose callers deliberately ignore failures - was failing silently every time.
   *
   * Normalized HERE rather than at the three call sites, because the seam is where the next caller will
   * also reach for an empty range to mean "all of it".
   */
  // A TEAM CONSOLE NEVER ASKS FOR WHAT ITS ROUTE DOES NOT ANSWER. The team route refuses any query not
  // bound to one assistant (`teamScope.ts`), and a view that asks for one gets an empty, explained result
  // here instead - the same shape a mode that cannot serve a query returns - rather than a refusal.
  if (!teamCanQuery(String(queryType))) {
    return { data: [], columns: [], unsupported: true, reason: i18n.t('admin.refusal.notAttributedPerAssistant') } as AnalyticsResult;
  }
  const named = dateRange?.start && dateRange?.end ? dateRange : undefined;
  const body: Record<string, unknown> = { queryType, ...(named ? { dateRange: named } : {}), ...extra };
  // A TEAM'S LIST OF ITS ASSISTANT'S RESPONSES returns what was said, so it carries a stated reason,
  // asked once per assistant for the session (a write names its own turn and needs none).
  const team = teamAssistant();
  if (team && TEAM_REASONED_QUERIES.has(String(queryType)) && !extra?.action) {
    body.accessReason = await reasonFor({ capability: 'view-analytics', kind: 'read', subject: 'responses', readKey: `responses:${team}` });
  }
  // SigV4-sign with the operator's console-session credentials and post to the capability resource the
  // queryType (and, for a write, its action) belongs to. The gateway refuses a role that lacks it.
  const creds = await consoleCredentials();
  return sigv4PostJson<AnalyticsResult>(analyticsPathForQuery(String(queryType), extra?.action), body, creds);
}

/**
 * Fetch the LLM-generated recommendation for an experiment's outcome.
 * Returns the verdict, confidence, rationale, and the per-variant summary.
 * Descriptive guidance only; it never changes routing.
 *
 * `objective` and `decision` come from the experiment record the CALLER already holds (the backend
 * does not re-read it) and are sent as JSON, which is the shape `getExperimentRecommendation` parses.
 * They are what make the evaluation the experiment's own rather than a generic one: without the
 * objective the backend falls back to a quality-primary default with NO guardrails and skips the
 * target-tied power check, so the guardrail veto and the underpowered→keep_running rule never fire
 * and `reco.guardrails` renders permanently empty. Omitting them was silently choosing that default.
 */
export async function getExperimentRecommendation(
  experimentId: string,
  dateRange: AnalyticsDateRange,
  opts?: { objective?: unknown; decision?: unknown },
): Promise<ExperimentRecommendation> {
  const res = await queryAnalytics('experiment_recommendation', dateRange, {
    experimentId,
    ...(opts?.objective ? { objective: JSON.stringify(opts.objective) } : {}),
    ...(opts?.decision ? { decision: JSON.stringify(opts.decision) } : {}),
  });
  return res as unknown as ExperimentRecommendation;
}

/**
 * QUEUE HEALTH: is the one-turn-at-a-time mechanism working, and what is it costing people (ADR-033).
 *
 * ITS OWN GET, NOT A `queryAnalytics` QUERY TYPE, and the reason is a network one rather than a
 * capability one - the same reason `classifier-replay-start` has its own resource. Every other panel
 * is served by a VPC-attached Lambda in isolated subnets, which has no route to the CloudWatch API;
 * a call from there would not fail fast, it would hang until the function timed out. These numbers
 * live in CloudWatch and need no database, so they are served by a non-VPC function on their own
 * route.
 */
export interface QueueHealthRow {
  metric: string;
  /** NULL means the metric has never been emitted, which is not the same as zero. */
  value: number | null;
  meaning: string;
}

export async function fetchQueueHealth(range: AnalyticsDateRange): Promise<QueueHealthRow[]> {
  // `adminUrl` strips the trailing slash the generated env value ends in, so the path never doubles
  // one (`.../query//analytics/queue-health` is a route API Gateway does not serve).
  requireAnalyticsApi();
  const url = adminUrl('analytics', '/analytics/queue-health');
  const params = { startDate: range.start, endDate: range.end };

  const creds = await consoleCredentials();
  const body = await sigv4GetJson(url, params, creds) as { data?: QueueHealthRow[] };
  return Array.isArray(body?.data) ? body.data : [];
}
