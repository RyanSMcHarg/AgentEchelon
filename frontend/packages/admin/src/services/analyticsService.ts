import type {
  AnalyticsDateRange,
  AnalyticsResult,
  ExperimentRecommendation,
  QueryType,
  AdminConversationEvent,
} from '@ae/shared';
import { apiCall, ADMIN_IAM_ENFORCEMENT } from '@ae/shared';
import { identityPoolCredentials, sigv4GetJson, sigv4PostJson } from './sigv4Fetch';

function getAnalyticsApiUrl(): string {
  const url = import.meta.env.VITE_ANALYTICS_API_URL;
  if (!url) {
    throw new Error('VITE_ANALYTICS_API_URL not configured');
  }
  return url;
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
  user_activity: 'user-activity',
  active_users_daily: 'user-activity',
  active_messaging_users_daily: 'user-activity',
  messages_per_user: 'user-activity',
  messages_per_tier_daily: 'user-activity',
  signup_funnel_conversion: 'user-activity',
  signin_funnel_conversion: 'user-activity',
  record_moderation: 'moderation-audit',
  moderation_audit: 'moderation-audit',
};

function analyticsPathForQuery(queryType: string): string {
  const sub = ANALYTICS_SUBPATH_FOR_QUERY[queryType];
  const base = getAnalyticsApiUrl().replace(/\/$/, '');
  return sub ? `${base}/${sub}` : base;
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

  // Probe the backend — Aurora mode has the /evaluation endpoint. Raw fetch
  // (not apiCall) so a missing token or a network failure both fall back to
  // 'athena' instead of throwing — this must never throw.
  try {
    const idToken = localStorage.getItem('idToken');
    if (!idToken) return 'athena';

    const probeUrl = `${getAnalyticsApiUrl().replace(/\/$/, '')}/evaluation`;
    if (ADMIN_IAM_ENFORCEMENT) {
      // The evaluation GET is IAM-authorized under enforcement — a JWT would 403.
      // Sign the probe with the operator's sign-on creds. (Setting VITE_ANALYTICS_MODE
      // skips this entirely, and is recommended under enforcement.)
      const creds = await identityPoolCredentials();
      await sigv4GetJson(probeUrl, { days: 1 }, creds);
      cachedMode = 'aurora'; // a 2xx (no throw) means the Aurora evaluation route answered
    } else {
      const response = await fetch(`${probeUrl}?days=1`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${idToken}` },
      });
      // Aurora analytics Lambda returns 200 with data; Athena mode returns 404
      cachedMode = response.ok ? 'aurora' : 'athena';
    }
  } catch {
    cachedMode = 'athena';
  }

  return cachedMode;
}

/**
 * Record a moderation action for attribution. The analytics Lambda stamps the SERVER-VERIFIED
 * admin identity (from the JWT) into moderation_actions — the client only names the target, never
 * the actor. Best-effort: the Chime redact/delete already succeeded, so callers ignore failures.
 */
/** The COMPLETE archived event log for a channel (every event_type) — the dev-persona view.
 *  Served by the analytics API's channel_events query. */
export async function listChannelEvents(channelArn: string): Promise<AdminConversationEvent[]> {
  const res = await queryAnalytics('channel_events' as QueryType, { start: '', end: '' }, { channelArn });
  return ((res.data as unknown) as AdminConversationEvent[]) || [];
}

export async function recordModeration(
  channelArn: string,
  messageId: string,
  moderation: 'redact' | 'delete'
): Promise<void> {
  await queryAnalytics('record_moderation' as QueryType, { start: '', end: '' }, {
    channelArn,
    messageId,
    moderation,
  });
}

export async function queryAnalytics(
  queryType: QueryType,
  dateRange: AnalyticsDateRange,
  extra?: Record<string, unknown>
): Promise<AnalyticsResult> {
  const body = { queryType, dateRange, ...extra };
  if (ADMIN_IAM_ENFORCEMENT) {
    // Sign-on plane: SigV4-sign with the operator's Identity-Pool creds and post to
    // the queryType's capability resource. The gateway denies a role that lacks it.
    const creds = await identityPoolCredentials();
    return sigv4PostJson<AnalyticsResult>(analyticsPathForQuery(String(queryType)), body, creds);
  }
  return apiCall<AnalyticsResult>(getAnalyticsApiUrl(), '', {
    body,
    mapError: (status) => (status === 403 ? 'Access denied. Admin privileges required.' : `Analytics query failed: ${status}`),
  });
}

/**
 * Fetch the LLM-generated recommendation for an experiment's outcome.
 * Returns the verdict, confidence, rationale, and the per-variant summary.
 * Descriptive guidance only; it never changes routing.
 */
export async function getExperimentRecommendation(
  experimentId: string,
  dateRange: AnalyticsDateRange,
): Promise<ExperimentRecommendation> {
  const res = await queryAnalytics('experiment_recommendation', dateRange, { experimentId });
  return res as unknown as ExperimentRecommendation;
}
