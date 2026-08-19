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

/**
 * The analytics API host the built frontend POSTs every queryType to. Matched by host so the tests
 * don't couple to the trailing stage/path.
 *
 * This used to default to the literal string `<analytics-api-id>.execute-api.us-east-1.amazonaws.com`
 * - a placeholder left behind when the real host was scrubbed for the public repo. Nothing re-derived
 * it, so unless E2E_ANALYTICS_HOST happened to be exported by hand, `isAnalyticsPost` matched NOTHING:
 * every waiter below burned its full 25s timeout and resolved null, and the "deterministic settle"
 * this file exists to provide silently reverted to racing the page load. The admin phase kept passing,
 * because its assertions tolerate a slow render - which is why it went unnoticed.
 *
 * Derived from VITE_ANALYTICS_API_URL instead, which `validate.mjs` already resolves from
 * packages/admin/.env. No private host in the tree, and it works without hand-exported env.
 */
function resolveAnalyticsHost(): string {
  if (process.env.E2E_ANALYTICS_HOST) return process.env.E2E_ANALYTICS_HOST;
  const url = process.env.VITE_ANALYTICS_API_URL;
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      console.warn(`[analytics-settle] VITE_ANALYTICS_API_URL is not a URL: ${url}`);
    }
  }
  return '';
}

export const ANALYTICS_HOST = resolveAnalyticsHost();

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

let warnedNoHost = false;

export function isAnalyticsPost(r: Response): boolean {
  // An unresolved host must not silently match everything (`''.includes` is true for every URL) NOR
  // silently match nothing. Say which, once, and match nothing - a settle that captures every POST
  // on the page is worse than one that captures none.
  if (!ANALYTICS_HOST) {
    if (!warnedNoHost) {
      warnedNoHost = true;
      console.warn(
        '[analytics-settle] analytics host UNRESOLVED - set VITE_ANALYTICS_API_URL (validate.mjs '
          + 'reads it from packages/admin/.env) or E2E_ANALYTICS_HOST. Section settles will time out '
          + 'and any ledger built from them will be EMPTY.',
      );
    }
    return false;
  }
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
