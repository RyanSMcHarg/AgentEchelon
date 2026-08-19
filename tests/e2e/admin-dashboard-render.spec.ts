/**
 * Admin Dashboard RENDER validation (live deployment)
 *
 * Purpose: prove the admin analytics FRONTEND actually renders real data
 * against the live backend, and diagnose the "Analytics API unavailable"
 * banner that e2e/admin-dashboard.spec.ts flags. Instead of a fixed timeout,
 * this spec waits for the per-section analytics POSTs to SETTLE deterministically
 * (page.waitForResponse per expected queryType), then:
 *   - records every analytics response (status + rows + unsupported + body snippet)
 *   - reports the banner state (error / notice / none) after settling
 *   - reads the actual rendered metric widgets (MetricCard title=value pairs,
 *     section headings, table row counts)
 *
 * Run:
 *   cd tests && npx playwright test e2e/admin-dashboard-render.spec.ts \
 *     --config=playwright.config.ts --reporter=list
 */
import { test, expect, Page, Response } from '@playwright/test';
import { signIn } from './helpers/agent-helpers';
import { getAdminUser } from './helpers/test-credentials';
import { collectBanners } from './helpers/banner-check';
import { ANALYTICS_HOST, SECTION_QUERIES, isAnalyticsPost } from './helpers/analytics-settle';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// The admin console is its own app on its own origin (DESIGN-SEPARATE-ADMIN-APP.md).
// Point at it via E2E_ADMIN_BASE_URL (admin CloudFront URL, or the admin dev server).
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardBackendErrors('admin-dashboard-render');
guardConsoleErrors();

// Host resolution + the queryType map live in helpers/analytics-settle. They were duplicated here,
// and both copies carried the same scrubbed `<analytics-api-id>` placeholder, so fixing one would
// have left this spec still matching nothing. One definition, one place to fix.

interface Captured {
  queryType: string;
  status: number;
  rows: number; // -1 when body has no data array
  unsupported: boolean;
  reason?: string;
  bodySnippet: string;
}

function reqQueryType(r: Response): string {
  try {
    return JSON.parse(r.request().postData() || '{}').queryType || '';
  } catch {
    return '';
  }
}

/** Build waiters for each expected queryType BEFORE triggering the load. */
function settleWaiters(page: Page, queries: string[]): Promise<Response | null>[] {
  return queries.map((q) =>
    page
      .waitForResponse((r) => isAnalyticsPost(r) && reqQueryType(r) === q, { timeout: 25000 })
      .catch(() => null),
  );
}

/** Read the rendered MetricCard widgets (title -> value) currently on screen. */
async function readMetricCards(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const card of await page.locator('.metric-card').all()) {
    if (!(await card.isVisible().catch(() => false))) continue;
    const title = ((await card.locator('.metric-card-title').textContent().catch(() => '')) || '').trim();
    const value = ((await card.locator('.metric-card-value').textContent().catch(() => '')) || '').trim();
    if (title) out[title] = value;
  }
  return out;
}

/** Read visible section headings + the data-row count under each. */
async function readSections(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const h of await page.locator('.admin-content h3').all()) {
    if (!(await h.isVisible().catch(() => false))) continue;
    const label = ((await h.textContent().catch(() => '')) || '').trim();
    if (label) out.push(label);
  }
  return out;
}

/** Count rendered data-table body rows across the visible content. */
async function countTableRows(page: Page): Promise<number> {
  return page.locator('.admin-content table tbody tr').count().catch(() => 0);
}

test.describe('Admin Dashboard - render validation (live)', () => {
  test('renders analytics for every section after deterministic settle', async ({ page }) => {
    test.setTimeout(180000);
    // Fail on the CAUSE, not on a downstream `undefined`. With no analytics host every waiter times
    // out, the ledger stays empty, and the assertion at the end reports "conversation_volumes should
    // be 200 / Received: undefined" - which reads like a broken API while the console is in fact
    // rendering fine. Say what is actually wrong.
    expect(
      ANALYTICS_HOST,
      'analytics host unresolved - set VITE_ANALYTICS_API_URL (validate.mjs reads it from '
        + 'packages/admin/.env) or E2E_ANALYTICS_HOST. Without it this spec captures no responses '
        + 'and cannot judge the dashboard.',
    ).toBeTruthy();
    const admin = await getAdminUser();
    console.log(`[render] admin user: ${admin.email} (tier=${admin.tier})`);

    const captured: Captured[] = [];
    page.on('response', async (r) => {
      if (!isAnalyticsPost(r)) return;
      const queryType = reqQueryType(r);
      let text = '';
      let body: unknown = null;
      try {
        text = await r.text();
        body = JSON.parse(text);
      } catch {
        /* non-JSON / body already consumed */
      }
      const b = body as { data?: unknown[]; unsupported?: boolean; reason?: string } | null;
      captured.push({
        queryType,
        status: r.status(),
        rows: Array.isArray(b?.data) ? (b!.data as unknown[]).length : -1,
        unsupported: !!b?.unsupported,
        reason: b?.reason,
        bodySnippet: text.slice(0, 900),
      });
    });

    // Overview is the default-active tab; its queries fire on dashboard mount.
    // Arm its waiters BEFORE opening the console so we don't miss them.
    const overviewWaiters = settleWaiters(page, SECTION_QUERIES.Overview);

    await signIn(page, admin.email, admin.password);
    // Admin app renders the dashboard at root for an admin (no Admin button since
    // the D split); the section rail is the proof the console mounted.
    const rail = page.locator('.admin-section-rail');
    await expect(rail).toBeVisible({ timeout: 15000 });
    // Report Aurora vs Athena mode (drives which queries return unsupported).
    const mode = (await page.locator('.status-badge--live:has-text("Aurora")').isVisible().catch(() => false))
      ? 'aurora'
      : 'athena';
    console.log(`[render] analytics mode (per badge): ${mode}`);

    const sections = ['Overview', 'Conversations', 'Effectiveness', 'Models', 'Experiments', 'Users'];
    const perSection: Record<string, { banners: { errors: string[]; notices: string[] }; metrics: Record<string, string>; headings: string[]; tableRows: number }> = {};

    for (const section of sections) {
      // Arm response waiters BEFORE clicking (Overview already armed above).
      const waiters =
        section === 'Overview' ? overviewWaiters : settleWaiters(page, SECTION_QUERIES[section]);

      await rail.locator(`button:has-text("${section}")`).first().click();
      await expect(page.locator(`.admin-section-btn.active:has-text("${section}")`)).toBeVisible();

      // Deterministic settle: wait for every expected analytics POST to return
      // (covers the slow ~3.4s query). allSettled so a single unsupported/slow
      // query can't hang the whole section.
      await Promise.all(waiters);
      // Let React flush the results into the DOM.
      await page.waitForTimeout(600);

      const banners = await collectBanners(page);
      const metrics = await readMetricCards(page);
      const headings = await readSections(page);
      const tableRows = await countTableRows(page);
      perSection[section] = { banners, metrics, headings, tableRows };

      console.log(`\n===== SECTION: ${section} =====`);
      console.log(`  banner.errors : ${banners.errors.length ? banners.errors.join(' | ') : '(none)'}`);
      console.log(`  banner.notices: ${banners.notices.length ? banners.notices.join(' | ') : '(none)'}`);
      console.log(`  headings      : ${headings.join(' | ') || '(none)'}`);
      console.log(`  table rows    : ${tableRows}`);
      console.log(`  metric cards  :`);
      for (const [k, v] of Object.entries(metrics)) console.log(`     - ${k} = ${v}`);
    }

    // Full analytics response ledger.
    console.log(`\n===== ANALYTICS RESPONSE LEDGER (${captured.length} responses) =====`);
    for (const c of captured) {
      const shape = c.status !== 200 ? `ERROR ${c.status}` : c.unsupported ? `200-unsupported (${c.reason || ''})` : c.rows > 0 ? `200-data(${c.rows})` : c.rows === 0 ? '200-empty' : '200-nondata';
      console.log(`  ${c.queryType.padEnd(30)} -> ${shape}`);
    }

    // Print the FULL bodies for Overview + Quality (metrics + evaluation) as
    // required by the diagnosis.
    const dumpFor = new Set(['conversation_volumes', 'intent_distribution', 'evaluation_scores']);
    console.log(`\n===== RAW BODIES (Overview volumes/intents + Quality evaluations) =====`);
    for (const c of captured) {
      if (dumpFor.has(c.queryType)) {
        console.log(`\n--- ${c.queryType} (status ${c.status}) ---\n${c.bodySnippet}`);
      }
    }

    // ---- Assertions ----
    // 1. No section shows a broken "Analytics API unavailable" / .admin-error banner.
    const sectionsWithErrors = Object.entries(perSection)
      .filter(([, v]) => v.banners.errors.length > 0)
      .map(([s, v]) => `${s}: ${v.banners.errors.join(' | ')}`);
    expect(sectionsWithErrors, `Sections with error banners: ${sectionsWithErrors.join(' ; ')}`).toEqual([]);

    // 2. Overview actually rendered real numbers (proves the frontend binds data,
    //    not just "no banner"). conversation_volumes is confirmed populated.
    const overviewVolumes = captured.find((c) => c.queryType === 'conversation_volumes');
    expect(overviewVolumes?.status, 'conversation_volumes should be 200').toBe(200);
    // Total Messages card should reflect the data (non-"0" when rows exist).
    if ((overviewVolumes?.rows ?? 0) > 0) {
      expect(perSection.Overview.metrics['Total Messages'], 'Overview Total Messages card should render').toBeTruthy();
    }
  });
});
