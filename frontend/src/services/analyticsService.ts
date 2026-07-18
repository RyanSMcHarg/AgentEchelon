import type {
  AnalyticsDateRange,
  AnalyticsResult,
  ExperimentRecommendation,
  QueryType,
} from '../types/analytics';

function getAnalyticsApiUrl(): string {
  const url = import.meta.env.VITE_ANALYTICS_API_URL;
  if (!url) {
    throw new Error('VITE_ANALYTICS_API_URL not configured');
  }
  return url;
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

  // Probe the backend — Aurora mode has the /evaluation endpoint
  try {
    const idToken = localStorage.getItem('idToken');
    if (!idToken) return 'athena';

    const response = await fetch(`${getAnalyticsApiUrl()}/evaluation?days=1`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    });

    // Aurora analytics Lambda returns 200 with data; Athena mode returns 404
    cachedMode = response.ok ? 'aurora' : 'athena';
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
export async function listChannelEvents(channelArn: string): Promise<import('../types').AdminConversationEvent[]> {
  const res = await queryAnalytics('channel_events' as QueryType, { start: '', end: '' }, { channelArn });
  return ((res.data as unknown) as import('../types').AdminConversationEvent[]) || [];
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
  const idToken = localStorage.getItem('idToken');
  if (!idToken) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(getAnalyticsApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ queryType, dateRange, ...extra }),
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error('Access denied. Admin privileges required.');
    }
    throw new Error(`Analytics query failed: ${response.status}`);
  }

  return response.json();
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
