/**
 * Admin Console E2E Tests
 *
 * Tests all 13 admin console tabs (9 base + 4 Aurora-mode).
 * Requires a premium user to access the admin console.
 *
 * Base tabs (always available):
 * - Overview: conversation volumes, intent distribution
 * - Models: model usage metrics
 * - Model Strategy: provider posture, routing guidance, fallback models
 * - Experiments: A/B model testing management and results
 * - Conversations: live browser, moderation, admin join controls
 * - Evaluations: evaluation scores
 * - Latency: response timing breakdown
 * - Users: user activity
 * - Manage Users: approval and tier operations
 *
 * Aurora-mode tabs (only when analyticsMode=aurora):
 * - Flows: multi-turn intent flow evaluation
 * - Flagged: flagged response review queue
 * - Ground Truth: human evaluation calibration
 * - Tasks: task completion tracking
 * - Conversations: drift detection analytics alongside the live browser
 */

import { test, expect } from '@playwright/test';
import { signIn } from './helpers/agent-helpers';
import { getTestCredentials } from './helpers/test-credentials';
import { assertNoErrorBanners } from './helpers/banner-check';
import { armSettle, SECTION_QUERIES } from './helpers/analytics-settle';

// Post D-split (SPEC-SEPARATE-ADMIN-APP.md): the admin console is its OWN app on
// its OWN origin. Point these specs at it via E2E_ADMIN_BASE_URL (the admin
// CloudFront URL when running against a deployment, or the admin dev server
// locally). The admin app renders the dashboard at root for an authenticated
// admin — there is no "Admin" button and no `?admin` presence toggle anymore
// (that was the old chat-embedded model).
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

let credentials: Awaited<ReturnType<typeof getTestCredentials>>;

test.beforeAll(async () => {
  credentials = await getTestCredentials();
});

test.describe('Admin Dashboard - Base Tabs', () => {
  test.beforeEach(async ({ page }) => {
    // Sign in as the ADMIN user on the admin app. The admin app renders the
    // dashboard ONLY for a user in the `admins` group (AdminApp.tsx); the analytics
    // API is independently gated on the same group. testAdmin is premium tier AND
    // in admins, so every base-tab assertion holds. After sign-in the dashboard is
    // at root — no button click.
    await signIn(page, credentials.testAdmin.email, credentials.testAdmin.password);
  });

  test('admin app renders the dashboard for an admin (no button, separate app)', async ({ page }) => {
    // The console renders directly for an authenticated admin — the section rail is
    // the proof the dashboard mounted (replaces the old chat-app "Admin button" test).
    await expect(page.locator('.admin-section-rail')).toBeVisible({ timeout: 15000 });
  });

  test('should open admin dashboard and show base sections', async ({ page }) => {
    // Two-level nav: the section rail holds the 6 top-level sections; the
    // former per-tab buttons (Models/Strategy/Evaluations/Latency/Manage Users)
    // are now sub-tabs within a section.
    const rail = page.locator('.admin-section-rail');
    await expect(rail.locator('button:has-text("Overview")')).toBeVisible();
    await expect(rail.locator('button:has-text("Conversations")')).toBeVisible();
    await expect(rail.locator('button:has-text("Effectiveness")')).toBeVisible();
    await expect(rail.locator('button:has-text("Models")')).toBeVisible();
    await expect(rail.locator('button:has-text("Experiments")')).toBeVisible();
    await expect(rail.locator('button:has-text("Users")').first()).toBeVisible();
    await expect(rail.locator('button:has-text("Security")')).toBeVisible();
  });

  test('Security section (Membership Audit) renders', async ({ page }) => {
    // Admin app: the dashboard is at root after sign-in (no Admin button).

    const rail = page.locator('.admin-section-rail');
    await rail.locator('button:has-text("Security")').click();
    await expect(page.locator('.admin-section-btn.active:has-text("Security")')).toBeVisible();
    // The Membership Audit surface loads: either the findings table + the
    // report-only/auto-revoke enforce control (audit enabled), or an honest
    // "not enabled on this deployment" notice. Both are acceptable; a broken
    // API-unavailable banner is not.
    await page.waitForTimeout(2000);
    await assertNoErrorBanners(page, 'admin section "Security"');
  });

  test('should display Overview tab with date range selector', async ({ page }) => {
    // Admin app: the dashboard is at root after sign-in (no Admin button).

    // Overview section is active by default
    await expect(page.locator('.admin-section-btn.active:has-text("Overview")')).toBeVisible();

    // Date range selector should be present
    await expect(page.locator('button:has-text("Last 7 days")')).toBeVisible();
    await expect(page.locator('button:has-text("Last 30 days")')).toBeVisible();
    await expect(page.locator('button:has-text("Last 90 days")')).toBeVisible();
  });

  test('no error banners on any section (banners are picked up)', async ({ page }) => {
    // Overview is the default-active tab; its analytics POSTs fire on dashboard
    // mount. Arm its response waiters BEFORE opening the console so the first
    // section's settle isn't missed (clicking an already-active section does
    // not re-fire the queries).
    const overviewWaiters = armSettle(page, SECTION_QUERIES.Overview);

    // Admin app: the dashboard is at root after sign-in (no Admin button).

    const rail = page.locator('.admin-section-rail');
    // Every top-level section must render without a broken-view banner
    // ("Analytics API unavailable", .admin-error). "Not implemented in this
    // mode" / "no data" notices are surfaced (logged) but allowed.
    for (const section of ['Overview', 'Conversations', 'Effectiveness', 'Models', 'Experiments', 'Users']) {
      // Arm response waiters BEFORE the click that triggers the load, so we
      // deterministically wait for the section's analytics queries to SETTLE
      // instead of racing a fixed 2.5s timeout (one real query runs ~3.4s
      // server-side, which the fixed wait lost to — mis-flagging the banner).
      // Cap the per-section settle at 10s: the dashboard serves section data from
      // cache on switch (the analytics POST does not always re-fire), so a hard
      // 25s wait per section would sum past the test timeout. 10s still lets a real
      // query (~3.4s) settle; the banner check below is what actually validates.
      const waiters = section === 'Overview' ? overviewWaiters : armSettle(page, SECTION_QUERIES[section], 10000);
      await rail.locator(`button:has-text("${section}")`).first().click();
      await expect(page.locator(`.admin-section-btn.active:has-text("${section}")`)).toBeVisible();
      // Wait for every expected analytics response, then let React flush the
      // results into the DOM before inspecting banners.
      await Promise.all(waiters);
      await page.waitForTimeout(300);
      await assertNoErrorBanners(page, `admin section "${section}"`);
    }
  });

  test('should switch between sections and sub-tabs', async ({ page }) => {
    // Admin app: the dashboard is at root after sign-in (no Admin button).

    const rail = page.locator('.admin-section-rail');

    // Models section → Models sub-view active by default
    await rail.locator('button:has-text("Models")').click();
    await expect(page.locator('.admin-section-btn.active:has-text("Models")')).toBeVisible();
    // Model Strategy is a sub-tab within the Models section
    await page.locator('.admin-subtab-btn:has-text("Model Strategy")').click();
    await expect(page.locator('h3:has-text("Intent Routing")')).toBeVisible();

    // Experiments section (single sub-view → renders directly)
    await rail.locator('button:has-text("Experiments")').click();
    await expect(page.locator('.admin-section-btn.active:has-text("Experiments")')).toBeVisible();
    await expect(page.locator('h3:has-text("A/B Experiments")')).toBeVisible();
    await expect(page.locator('button:has-text("New Experiment")')).toBeVisible();

    // Conversations section
    await rail.locator('button:has-text("Conversations")').click();
    await expect(page.locator('.admin-section-btn.active:has-text("Conversations")')).toBeVisible();
    await expect(page.locator('h3:has-text("Conversations")')).toBeVisible();
    await expect(page.locator('.admin-filter-btn:has-text("Browser")')).toBeVisible();
    await expect(page.locator('.admin-filter-btn:has-text("Drift Detection")')).toBeVisible();

    // Effectiveness section → Evaluations is the (only, in Athena) sub-view
    await rail.locator('button:has-text("Effectiveness")').click();
    await expect(page.locator('.admin-section-btn.active:has-text("Effectiveness")')).toBeVisible();

    // Overview section → Latency sub-tab
    await rail.locator('button:has-text("Overview")').click();
    await page.locator('.admin-subtab-btn:has-text("Latency")').click();

    // Users section → Manage Users sub-tab
    await rail.locator('button:has-text("Users")').first().click();
    await expect(page.locator('.admin-section-btn.active:has-text("Users")')).toBeVisible();
    await page.locator('.admin-subtab-btn:has-text("Manage Users")').click();
  });

  test('in-app Back from the dashboard root signs the operator out (standalone app)', async ({ page }) => {
    // The standalone admin app has no chat surface to return to (AdminApp
    // `onBack={logout}`); from the root (no tab history to walk) the in-app Back
    // signs out, so the dashboard unmounts.
    await page.locator('.admin-back-btn, button:has-text("Back")').click();
    await expect(page.locator('.admin-dashboard')).not.toBeVisible();
  });

  test('should change date range and reload data', async ({ page }) => {
    // Admin app: the dashboard is at root after sign-in (no Admin button).

    // Click 30 days
    await page.locator('button:has-text("Last 30 days")').click();
    await expect(page.locator('.admin-date-btn.active:has-text("Last 30 days")')).toBeVisible();

    // Data should reload (loading indicator may flash)
    // We just verify the tab content still renders
    await expect(page.locator('.admin-content')).toBeVisible();
  });

  test('should display Experiments tab with create form', async ({ page }) => {
    // Admin app: the dashboard is at root after sign-in (no Admin button).

    // Navigate to the Experiments section
    await page.locator('.admin-section-rail button:has-text("Experiments")').click();
    await expect(page.locator('.admin-section-btn.active:has-text("Experiments")')).toBeVisible();
    await expect(page.locator('h3:has-text("A/B Experiments")')).toBeVisible();

    // Should have New Experiment and Refresh buttons
    await expect(page.locator('button:has-text("New Experiment")')).toBeVisible();
    await expect(page.locator('button:has-text("Refresh")')).toBeVisible();

    // Should show experiments table (may be empty)
    await expect(page.locator('h4:has-text("Active Experiments")')).toBeVisible();

    // Toggle create form
    await page.locator('button:has-text("New Experiment")').click();
    await expect(page.locator('h4:has-text("Create Experiment")')).toBeVisible();

    // Cancel create form
    await page.locator('button:has-text("Cancel")').click();
    await expect(page.locator('h4:has-text("Create Experiment")')).not.toBeVisible();
  });
});

test.describe('Admin Dashboard - Aurora Tabs', () => {
  // These tests run against a deployment with analyticsMode=aurora. The Aurora
  // Effectiveness sub-tabs (Flows/Flagged/Ground Truth/Tasks) are gated on the admins
  // Cognito group: analyticsMode is resolved by probing the analytics API, which
  // 403s for a premium-but-not-admin user and falls back to 'athena', hiding the
  // Aurora tabs. So we sign in as testAdmin (premium tier AND admins group).
  test.beforeEach(async ({ page }) => {
    await signIn(page, credentials.testAdmin.email, credentials.testAdmin.password);
  });

  // Open the console and confirm Aurora mode is live (the badge only renders when
  // analyticsMode === 'aurora'). The two-level nav groups the Aurora analytics
  // views as sub-tabs under the "Effectiveness" section.
  async function openAdmin(page: import('@playwright/test').Page) {
    // Admin app renders the dashboard at root; just confirm Aurora is live.
    await expect(page.locator('.status-badge--live')).toBeVisible({ timeout: 20000 });
  }
  async function openEffectiveness(page: import('@playwright/test').Page) {
    await page.locator('.admin-section-btn:has-text("Effectiveness")').click();
    await expect(page.locator('.admin-subtabs')).toBeVisible();
  }

  test('the Effectiveness section folds Tasks/Flows/Steps into the drill (merged sub-tabs)', async ({ page }) => {
    await openAdmin(page);
    await openEffectiveness(page);
    // The merged sub-tab set: Effectiveness | Flagged | Ground Truth. Sub-tab buttons carry stable
    // ids (admin-tab-<tabId>).
    await expect(page.locator('#admin-tab-effectiveness')).toBeVisible();
    await expect(page.locator('#admin-tab-flagged')).toBeVisible();
    await expect(page.locator('#admin-tab-ground_truth')).toBeVisible();
    // Tasks/Flows/Steps/Evaluations are no longer standalone sub-tabs — their detail is folded into the
    // Effectiveness drill (L2 task list, L3 turn timeline + flow score). Assert they are gone as tabs.
    await expect(page.locator('#admin-tab-flows')).toHaveCount(0);
    await expect(page.locator('#admin-tab-tasks')).toHaveCount(0);
    await expect(page.locator('#admin-tab-steps')).toHaveCount(0);
    await expect(page.locator('#admin-tab-evaluations')).toHaveCount(0);
  });

  test('flow + task detail is reachable via the Effectiveness drill (folded in, not standalone tabs)', async ({ page }) => {
    test.setTimeout(120000);
    await openAdmin(page);
    await openEffectiveness(page);
    await page.locator('#admin-tab-effectiveness').click();
    // Wait for the async analytics query to settle (the intent table or its empty state) before probing —
    // counting too early reads 0 and skips a populated window. Skip ONLY on a genuinely empty window.
    await page.locator('.data-table-row--clickable, .data-table-empty').first().waitFor({ timeout: 20000 });
    if (await page.locator('.data-table-empty').first().isVisible().catch(() => false)) {
      test.skip(true, 'no effectiveness data in window'); return;
    }

    // L0 -> L1: click report_generation — the deterministic task-bearing intent the tasks e2e produces,
    // so a "Tasks (N)" drill is guaranteed.
    const intentLink = page.locator('.data-table-row--clickable .admin-link-btn', { hasText: 'report_generation' }).first();
    await expect(intentLink).toBeVisible({ timeout: 10000 });
    await intentLink.click();
    await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });

    // L1 -> L2: the task intent exposes a "Tasks (N)" drill; clicking it opens the task list (formerly the
    // standalone Tasks tab, now drill detail). Reaching that list under the Tasks breadcrumb is the firm
    // proof the former tab is now folded into the drill.
    const tasksDrill = page.locator('.admin-filter-btn', { hasText: /Tasks \(/ }).first();
    await expect(tasksDrill).toBeVisible({ timeout: 10000 });
    await tasksDrill.click();
    await expect(page.locator('.admin-breadcrumb')).toContainText(/Tasks/i, { timeout: 15000 });
    const taskLink = page.locator('.data-table-row--clickable .admin-link-btn').first();
    await expect(taskLink).toBeVisible({ timeout: 20000 }); // wait for the L2 task list to render

    // L2 -> L3: the task timeline + (when the flow was scored) the multi-turn flow score fold in here.
    // The flow score depends on the evaluate phase, so accept it OR the deepened breadcrumb as proof of L3.
    await taskLink.click();
    await expect(
      page.getByText(/Flow score/i).or(page.locator('.admin-breadcrumb .admin-link-btn').nth(2)),
    ).toBeVisible({ timeout: 25000 });
  });

  test('should display Flagged tab with review queue', async ({ page }) => {
    await openAdmin(page);
    await openEffectiveness(page);
    await page.locator('#admin-tab-flagged').click();
    await expect(page.locator('h3:has-text("Flagged Responses")')).toBeVisible();

    // Filter buttons should be visible
    await expect(page.locator('.admin-filter-btn:has-text("Pending")')).toBeVisible();
    await expect(page.locator('.admin-filter-btn:has-text("Reviewed")')).toBeVisible();
  });

  test('should display Ground Truth tab with calibration metrics', async ({ page }) => {
    await openAdmin(page);
    await openEffectiveness(page);
    await page.locator('#admin-tab-ground_truth').click();
    await expect(page.locator('h3:has-text("Ground Truth Calibration")')).toBeVisible();
  });

  // (Removed) "should display Tasks tab" tested the OLD standalone Tasks sub-tab. Tasks are now drill
  // detail (L2 of the Effectiveness drill); coverage moved to "flow + task detail is reachable via the
  // Effectiveness drill" above and EffectivenessTab.test.tsx (deterministic L0->L3 unit drill).

  test('Conversations tab actually LOADS the conversation list (not just the shell)', async ({ page }) => {
    test.setTimeout(60000);
    // Capture why the list load fails (CORS vs dead endpoint vs 4xx) — the shell-only test saw nothing.
    page.on('requestfailed', (r) => {
      if (/execute-api|amazonaws/.test(r.url()) && /conversation/i.test(r.url())) {
        console.log('[net] REQUESTFAILED', r.method(), r.url(), '::', r.failure()?.errorText);
      }
    });
    page.on('response', (r) => {
      if (/conversation/i.test(r.url())) console.log('[net] RESPONSE', r.status(), r.request().method(), r.url());
    });
    const convTab = page.locator('.admin-section-rail button:has-text("Conversations")');
    await convTab.click();
    await expect(page.locator('h3:has-text("Conversations")')).toBeVisible();

    // Shell controls.
    await expect(page.locator('.admin-filter-btn:has-text("Browser")')).toBeVisible();
    await expect(page.locator('.admin-filter-btn:has-text("Drift Detection")')).toBeVisible();
    await expect(page.locator('button:has-text("Refresh")')).toBeVisible();

    // Wait for the list load to settle (the "Loading conversations…" spinner clears).
    await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 25000 });

    // If the list failed to load, surface the actual error (the reason, e.g. "Failed to fetch") before
    // asserting — a shell-only check would have missed this entirely (tracker C3).
    const failed = page.getByText(/Couldn't load conversations/i);
    if (await failed.count()) {
      console.log('[conversations] LOAD FAILED:', (await failed.first().innerText()).replace(/\s+/g, ' ').trim());
    }
    await expect(failed, 'the conversation list must load, not show the failure state').toHaveCount(0);

    // Real outcome: the list rendered actual rows, or the explicit empty state — not a blank shell.
    const rows = page.locator('.admin-content table tbody tr');
    const empty = page.getByText('No conversations available');
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 10000 });
    // The validate context creates conversations, so a populated window must show rows.
    expect(await rows.count(), 'the conversation list should have loaded rows in a populated window').toBeGreaterThan(0);

    // C1: opening a conversation must LOAD its detail (messages endpoint = exchange-vended creds, a
    // distinct path from the list). Assert the detail panel renders and there is no "failed to fetch".
    await rows.first().locator('.admin-inline-btn:has-text("View")').click();
    await expect(page.locator('.admin-conversation-panel')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/failed to fetch/i)).toHaveCount(0);
    // Messages either render or show the honest empty — not an error state.
    const msgRows = page.locator('.admin-conversation-panel table tbody tr');
    const noMsgs = page.getByText(/No messages loaded/i);
    await expect(msgRows.first().or(noMsgs)).toBeVisible({ timeout: 15000 });
  });
});
