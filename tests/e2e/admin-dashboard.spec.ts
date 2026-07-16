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

let credentials: Awaited<ReturnType<typeof getTestCredentials>>;

test.beforeAll(async () => {
  credentials = await getTestCredentials();
});

test.describe('Admin Dashboard - Base Tabs', () => {
  test.beforeEach(async ({ page }) => {
    // Sign in as the ADMIN user, not a plain premium user. The admin console
    // BUTTON shows for any premium user, but the analytics API is gated on the
    // `admins` Cognito group: a premium-but-not-admin user gets 403 on every
    // query, which the dashboard surfaces as "Analytics API unavailable". Only
    // an actual admin exercises the rendered analytics. testAdmin is premium
    // tier AND in the admins group, so every base-tab assertion still holds.
    await signIn(page, credentials.testAdmin.email, credentials.testAdmin.password);

  });

  test('should show admin button for premium users', async ({ page }) => {
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await expect(adminButton).toBeVisible({ timeout: 10000 });
  });

  test('should open admin dashboard and show base sections', async ({ page }) => {
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

    // Two-level nav: the section rail holds the 6 top-level sections; the
    // former per-tab buttons (Models/Strategy/Evaluations/Latency/Manage Users)
    // are now sub-tabs within a section.
    const rail = page.locator('.admin-section-rail');
    await expect(rail.locator('button:has-text("Overview")')).toBeVisible();
    await expect(rail.locator('button:has-text("Conversations")')).toBeVisible();
    await expect(rail.locator('button:has-text("Quality")')).toBeVisible();
    await expect(rail.locator('button:has-text("Models")')).toBeVisible();
    await expect(rail.locator('button:has-text("Experiments")')).toBeVisible();
    await expect(rail.locator('button:has-text("Users")').first()).toBeVisible();
    await expect(rail.locator('button:has-text("Security")')).toBeVisible();
  });

  test('Security section (Membership Audit) renders', async ({ page }) => {
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

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
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

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

    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

    const rail = page.locator('.admin-section-rail');
    // Every top-level section must render without a broken-view banner
    // ("Analytics API unavailable", .admin-error). "Not implemented in this
    // mode" / "no data" notices are surfaced (logged) but allowed.
    for (const section of ['Overview', 'Conversations', 'Quality', 'Models', 'Experiments', 'Users']) {
      // Arm response waiters BEFORE the click that triggers the load, so we
      // deterministically wait for the section's analytics queries to SETTLE
      // instead of racing a fixed 2.5s timeout (one real query runs ~3.4s
      // server-side, which the fixed wait lost to — mis-flagging the banner).
      const waiters = section === 'Overview' ? overviewWaiters : armSettle(page, SECTION_QUERIES[section]);
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
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

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

    // Quality section → Evaluations is the (only, in Athena) sub-view
    await rail.locator('button:has-text("Quality")').click();
    await expect(page.locator('.admin-section-btn.active:has-text("Quality")')).toBeVisible();

    // Overview section → Latency sub-tab
    await rail.locator('button:has-text("Overview")').click();
    await page.locator('.admin-subtab-btn:has-text("Latency")').click();

    // Users section → Manage Users sub-tab
    await rail.locator('button:has-text("Users")').first().click();
    await expect(page.locator('.admin-section-btn.active:has-text("Users")')).toBeVisible();
    await page.locator('.admin-subtab-btn:has-text("Manage Users")').click();
  });

  test('should navigate back from admin dashboard', async ({ page }) => {
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

    // Click back button
    const backButton = page.locator('.admin-back-btn, button:has-text("Back")');
    await backButton.click();

    // Should be back in the main conversation view
    await expect(page.locator('.admin-dashboard')).not.toBeVisible();
  });

  test('should change date range and reload data', async ({ page }) => {
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

    // Click 30 days
    await page.locator('button:has-text("Last 30 days")').click();
    await expect(page.locator('.admin-date-btn.active:has-text("Last 30 days")')).toBeVisible();

    // Data should reload (loading indicator may flash)
    // We just verify the tab content still renders
    await expect(page.locator('.admin-content')).toBeVisible();
  });

  test('should display Experiments tab with create form', async ({ page }) => {
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

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
  // Quality sub-tabs (Flows/Flagged/Ground Truth/Tasks) are gated on the admins
  // Cognito group: analyticsMode is resolved by probing the analytics API, which
  // 403s for a premium-but-not-admin user and falls back to 'athena', hiding the
  // Aurora tabs. So we sign in as testAdmin (premium tier AND admins group).
  test.beforeEach(async ({ page }) => {
    await signIn(page, credentials.testAdmin.email, credentials.testAdmin.password);
  });

  // Open the console and confirm Aurora mode is live (the badge only renders when
  // analyticsMode === 'aurora'). The two-level nav groups the Aurora analytics
  // views as sub-tabs under the "Quality" section.
  async function openAdmin(page: import('@playwright/test').Page) {
    await page.locator('[data-testid="admin-button"], button:has-text("Admin")').click();
    await expect(page.locator('.status-badge--live')).toBeVisible({ timeout: 20000 });
  }
  async function openQuality(page: import('@playwright/test').Page) {
    await page.locator('.admin-section-btn:has-text("Quality")').click();
    await expect(page.locator('.admin-subtabs')).toBeVisible();
  }

  test('should show the Aurora Quality sub-tabs when Aurora is deployed', async ({ page }) => {
    await openAdmin(page);
    await openQuality(page);
    // Sub-tab buttons carry stable ids (admin-tab-<tabId>).
    await expect(page.locator('#admin-tab-flows')).toBeVisible();
    await expect(page.locator('#admin-tab-flagged')).toBeVisible();
    await expect(page.locator('#admin-tab-ground_truth')).toBeVisible();
    await expect(page.locator('#admin-tab-tasks')).toBeVisible();
  });

  test('should display Flows tab with multi-turn evaluation', async ({ page }) => {
    await openAdmin(page);
    await openQuality(page);
    await page.locator('#admin-tab-flows').click();
    await expect(page.locator('h3:has-text("Intent Flows")')).toBeVisible();
  });

  test('should display Flagged tab with review queue', async ({ page }) => {
    await openAdmin(page);
    await openQuality(page);
    await page.locator('#admin-tab-flagged').click();
    await expect(page.locator('h3:has-text("Flagged Responses")')).toBeVisible();

    // Filter buttons should be visible
    await expect(page.locator('.admin-filter-btn:has-text("Pending")')).toBeVisible();
    await expect(page.locator('.admin-filter-btn:has-text("Reviewed")')).toBeVisible();
  });

  test('should display Ground Truth tab with calibration metrics', async ({ page }) => {
    await openAdmin(page);
    await openQuality(page);
    await page.locator('#admin-tab-ground_truth').click();
    await expect(page.locator('h3:has-text("Ground Truth Calibration")')).toBeVisible();
  });

  test('should display Tasks tab with metrics and detail views', async ({ page }) => {
    await openAdmin(page);
    await openQuality(page);
    await page.locator('#admin-tab-tasks').click();
    await expect(page.locator('h3:has-text("Task Tracking")')).toBeVisible();

    // Toggle between metrics and detail views
    await expect(page.locator('.admin-filter-btn:has-text("Metrics")')).toBeVisible();
    await expect(page.locator('.admin-filter-btn:has-text("Task List")')).toBeVisible();
  });

  test('should display Conversations tab with live browser and drift analytics', async ({ page }) => {
    const adminButton = page.locator('[data-testid="admin-button"], button:has-text("Admin")');
    await adminButton.click();

    const convTab = page.locator('.admin-section-rail button:has-text("Conversations")');
    await convTab.click();
    await expect(page.locator('h3:has-text("Conversations")')).toBeVisible();

    // Toggle between browser and drift views
    await expect(page.locator('.admin-filter-btn:has-text("Browser")')).toBeVisible();
    await expect(page.locator('.admin-filter-btn:has-text("Drift Detection")')).toBeVisible();
    await expect(page.locator('button:has-text("Refresh")')).toBeVisible();
  });
});
