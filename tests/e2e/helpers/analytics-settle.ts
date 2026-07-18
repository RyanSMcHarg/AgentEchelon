import { Page, Response } from '@playwright/test';

/**
 * Deterministic settle for the admin analytics dashboard.
 *
 * The admin console fans out one POST per queryType to the analytics API when a
 * section is opened. The slowest real query runs ~3.4s server-side, so a fixed
 * `waitForTimeout(2500)` races the load: the banner block reads results before
 * they arrive and mis-renders "Analytics API unavailable". Waiting for the
 * actual responses (per expected queryType) removes the race and makes the test
 * validate the *rendered* frontend rather than a timing window.
 */

// The analytics API the built frontend POSTs every queryType to. Match by host
// so the tests don't couple to the trailing stage/path.
export const ANALYTICS_HOST = 'h1bu974mq6.execute-api.us-east-1.amazonaws.com';

// queryTypes each top-level SECTION fires on its default (first) sub-tab.
// Mirrors QUERIES_BY_TAB in AdminDashboard.tsx for each section's default tab.
export const SECTION_QUERIES: Record<string, string[]> = {
  Overview: [
    'conversation_volumes',
    'intent_distribution',
    'active_users_daily',
    'active_messaging_users_daily',
    'error_rate_daily',
  ],
  Conversations: ['conversation_summaries', 'drift_events'],
  // The Effectiveness section opens on its default 'effectiveness' tab, which fires
  // intent_effectiveness (not evaluation_scores — that's the Evaluations sub-tab).
  Effectiveness: ['intent_effectiveness'],
  Models: ['model_usage', 'model_effectiveness'],
  Experiments: ['experiment_results'],
  Users: [
    'user_activity',
    'active_users_daily',
    'active_messaging_users_daily',
    'messages_per_user',
    'signup_funnel_conversion',
    'signin_funnel_conversion',
  ],
};

function reqQueryType(r: Response): string {
  try {
    return JSON.parse(r.request().postData() || '{}').queryType || '';
  } catch {
    return '';
  }
}

export function isAnalyticsPost(r: Response): boolean {
  return r.url().includes(ANALYTICS_HOST) && r.request().method() === 'POST';
}

/**
 * Build response waiters for each expected queryType. Arm these BEFORE the click
 * that triggers the load, then `await Promise.all(...)` after clicking. Each
 * waiter resolves to the Response or null (on timeout) so one slow/absent query
 * can't hang the whole settle.
 */
export function armSettle(page: Page, queries: string[], timeout = 25000): Promise<Response | null>[] {
  return queries.map((q) =>
    page
      .waitForResponse((r) => isAnalyticsPost(r) && reqQueryType(r) === q, { timeout })
      .catch(() => null),
  );
}
