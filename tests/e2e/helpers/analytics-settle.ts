import { Page, Response } from '@playwright/test';
import { ADMIN_API_URL, adminUrl } from './api-urls';

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
 * Derived from VITE_ADMIN_API_URL instead, which `validate.mjs` already resolves from
 * packages/admin/.env. No private host in the tree, and it works without hand-exported env.
 */
function resolveAnalyticsHost(): string {
  if (process.env.E2E_ANALYTICS_HOST) return process.env.E2E_ANALYTICS_HOST;
  if (ADMIN_API_URL) {
    try {
      return new URL(ADMIN_API_URL).host;
    } catch {
      console.warn(`[analytics-settle] VITE_ADMIN_API_URL is not a URL: ${ADMIN_API_URL}`);
    }
  }
  return '';
}

export const ANALYTICS_HOST = resolveAnalyticsHost();

/**
 * The analytics surface's root on `AdminApi` (`/query`). Every admin route shares the host, so a POST is
 * an analytics query only when it is under this root; '' when the admin API is unset.
 */
const ANALYTICS_ROOT = ADMIN_API_URL ? adminUrl('analytics', '/') : '';

// queryTypes each top-level SECTION fires on its default (first) sub-tab.
// Mirrors QUERIES_BY_TAB in AdminDashboard.tsx for each section's default tab.
/**
 * The queries each TOP-LEVEL SECTION fires when it opens, keyed by the section's visible label.
 *
 * Keyed by section, not by tab: a section opens on its first tab, and these are the requests whose
 * settling a banner check has to wait for. Four of the old keys here (Overview, Conversations,
 * Effectiveness) named surfaces that are now SUB-TABS, so they matched no rail button at all - and
 * a `for` loop over names that no longer exist fails on the click, long before it can check a
 * banner. See `SECTIONS` in AdminDashboard.tsx, which is the source of truth for this shape.
 */
export const SECTION_QUERIES: Record<string, string[]> = {
  // Opens on its 'overview' tab — the operational dashboard.
  Operations: [
    'conversation_volumes',
    'intent_distribution',
    'active_users_daily',
    'active_messaging_users_daily',
    'error_rate_daily',
  ],
  // Opens on its 'effectiveness' tab, which fires intent_effectiveness alongside the latency
  // metrics it now shares a filter bar with (not evaluation_scores — that is the Evaluations tab).
  Performance: ['intent_effectiveness', 'latency_metrics'],
  // Opens on 'conversations'.
  Oversight: ['conversation_summaries', 'drift_events'],
  Models: ['model_usage', 'model_effectiveness'],
  // Opens on 'profiles', which is served by its own API rather than an analytics queryType.
  Assistants: [],
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
        '[analytics-settle] analytics host UNRESOLVED - set VITE_ADMIN_API_URL (validate.mjs '
          + 'reads it from packages/admin/.env) or E2E_ANALYTICS_HOST. Section settles will time out '
          + 'and any ledger built from them will be EMPTY.',
      );
    }
    return false;
  }
  return r.url().includes(ANALYTICS_HOST)
    && (!ANALYTICS_ROOT || r.url().startsWith(ANALYTICS_ROOT))
    && r.request().method() === 'POST';
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
