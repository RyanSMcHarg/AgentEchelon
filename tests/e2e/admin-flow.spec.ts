/**
 * Admin console — operator flows, end to end (live deployment).
 *
 * Where admin-dashboard.spec.ts checks that individual elements render, this spec validates the
 * OPERATOR JOURNEY as connected flows — the way the console is actually used:
 *
 *   1. Triage loop — land, read the Alerts surface, and confirm EVERY alert drills to its own target
 *      (a latency alert opens Latency, a quality alert Effectiveness, a runtime error-response Flagged,
 *      the error-rate alert Overview). This is the whole point of Alerts: each is a link to its drill.
 *   2. Investigate effectiveness — drill an intent all the way down (L0 intents -> L1 metrics -> L2 task
 *      list -> L3 turn timeline + flow score), proving Tasks/Flows/Steps are folded into the drill, not
 *      standalone tabs.
 *   3. Latency health — the perceived-latency headline (TTFF primary, P95 tail) renders real values and
 *      P95 is single-reply latency (task-excluded, traffic-weighted), not the task-inflated old number.
 *   4. Mobile triage — on a narrow viewport the whole row is a tap target.
 *
 * Data-tolerant: structural steps always run; steps that need live rows (the drill, the alert loop when
 * the window is clean) note-skip. In the validate.mjs admin phase (which runs after the user+tasks e2e)
 * the data is present, so they exercise fully.
 *
 * Run:
 *   cd tests && AWS_PROFILE=<your-profile> \
 *     E2E_ADMIN_BASE_URL=https://<admin-dist>.cloudfront.net \
 *     npx playwright test e2e/admin-flow.spec.ts --reporter=list
 */
import { test, expect, Page } from '@playwright/test';
import { signIn } from './helpers/agent-helpers';
import { getAdminUser } from './helpers/test-credentials';
import { assertNoErrorBanners } from './helpers/banner-check';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

/** The active tab id per the `?admin=<tab>` URL param (how selectTab reflects navigation). */
const adminParam = (page: Page): string | null => new URL(page.url()).searchParams.get('admin');

/** Parse a rendered latency value ("1.8s", "812ms", "20.4s", "1,234ms") to milliseconds, or NaN. */
function msOf(s: string): number {
  const m = (s || '').replace(/,/g, '').match(/([\d.]+)\s*(ms|s)\b/i);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  return m[2].toLowerCase() === 's' ? v * 1000 : v;
}

/** The value shown on the MetricCard with the given title. */
async function cardValue(page: Page, title: string): Promise<string> {
  const card = page.locator('.metric-card', { has: page.locator('.metric-card-title', { hasText: title }) }).first();
  if (!(await card.count())) return '';
  return (await card.locator('.metric-card-value').first().innerText()).trim();
}

async function signInAsAdmin(page: Page): Promise<void> {
  const admin = await getAdminUser();
  await signIn(page, admin.email, admin.password);
  await expect(page.locator('.admin-section-rail')).toBeVisible({ timeout: 15000 });
  // The Aurora badge gates the analytics drills; confirm the mode is live before the journey.
  await expect(page.locator('.status-badge--live')).toBeVisible({ timeout: 20000 });
}

test.describe('Admin console — operator flows (live)', () => {
  test('triage loop: land → read alerts → each alert drills to its own target', async ({ page }) => {
    test.setTimeout(150000);
    await signInAsAdmin(page);

    await page.goto('/?admin=alerts');
    await expect(page.locator('.admin-subtab-btn.active')).toHaveText(/Alerts/i);
    await page.locator('.admin-tab').first().waitFor({ timeout: 20000 });

    const rows = page.locator('.admin-alert-row');
    const count = await rows.count();
    if (count === 0) {
      // A genuinely clean window shows the all-clear banner; there is nothing to drill.
      await expect(page.getByText(/All clear|No active alerts/i)).toBeVisible();
      test.info().annotations.push({ type: 'note', description: 'No active alerts in window — drill-navigation loop skipped.' });
      return;
    }

    // The header summary must agree with what is rendered: "N errors and M warnings".
    const desc = (await page.locator('.admin-tab-description').first().innerText()).trim();
    const m = desc.match(/(\d+)\s+errors?\s+and\s+(\d+)\s+warnings?/i);
    expect(m, `alerts header should state the counts (got "${desc}")`).toBeTruthy();
    const headerTotal = Number(m![1]) + Number(m![2]);
    expect(headerTotal, 'header count must match the rendered alert rows').toBe(count);
    // Errors sort before warnings.
    const severities = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.severity || ''));
    expect(severities.indexOf('warn') === -1 || severities.lastIndexOf('error') < severities.indexOf('warn'),
      `errors must sort before warnings (got ${severities.join(',')})`).toBeTruthy();

    // Walk each alert (cap the loop for runtime) and confirm it navigates to its own drill target.
    const walk = Math.min(count, 8);
    for (let i = 0; i < walk; i++) {
      await page.goto('/?admin=alerts');
      const row = page.locator('.admin-alert-row').nth(i);
      const targetTab = await row.getAttribute('data-tab');
      const category = await row.getAttribute('data-category');
      const label = (await row.innerText()).replace(/\s+/g, ' ').trim();
      expect(targetTab, `alert ${i} exposes a drill target`).toBeTruthy();

      await row.click();
      // Navigation lands on the alert's encoded tab (selectTab reflects it in ?admin=<tab>).
      await expect.poll(() => adminParam(page), { timeout: 10000 }).toBe(targetTab);
      // The drill target actually rendered its panel, with no broken-view banner.
      await expect(page.locator('.admin-tab, .admin-content').first()).toBeVisible({ timeout: 10000 });
      await assertNoErrorBanners(page, `alert drill [${category}] "${label}" -> ${targetTab}`);
    }
  });

  test('investigate effectiveness: an intent drills to its tasks + flow detail (folded in, not tabs)', async ({ page }) => {
    test.setTimeout(120000);
    await signInAsAdmin(page);

    await page.goto('/?admin=effectiveness');
    await expect(page.locator('.admin-subtabs')).toBeVisible({ timeout: 15000 });
    // The merged sub-tab set — Tasks/Flows/Steps/Evaluations are NOT standalone tabs any more.
    for (const gone of ['flows', 'tasks', 'steps', 'evaluations']) {
      await expect(page.locator(`#admin-tab-${gone}`)).toHaveCount(0);
    }
    for (const present of ['effectiveness', 'flagged', 'ground_truth']) {
      await expect(page.locator(`#admin-tab-${present}`)).toBeVisible();
    }

    // Wait for the intent table to settle before probing; skip only on a genuinely empty window.
    await page.locator('.data-table-row--clickable, .data-table-empty').first().waitFor({ timeout: 20000 });
    if (await page.locator('.data-table-empty').first().isVisible().catch(() => false)) {
      test.info().annotations.push({ type: 'note', description: 'No effectiveness data in window — drill skipped.' });
      return;
    }

    // L0 -> L1: report_generation is the deterministic task-bearing intent the tasks e2e produces.
    const intentLink = page.locator('.data-table-row--clickable .admin-link-btn', { hasText: 'report_generation' }).first();
    await expect(intentLink).toBeVisible({ timeout: 10000 });
    await intentLink.click();
    await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });

    // L1 -> L2: the "Tasks (N)" drill opens the task list (formerly the Tasks tab).
    const tasksDrill = page.locator('.admin-filter-btn', { hasText: /Tasks \(/ }).first();
    await expect(tasksDrill).toBeVisible({ timeout: 10000 });
    await tasksDrill.click();
    await expect(page.locator('.admin-breadcrumb')).toContainText(/Tasks/i, { timeout: 15000 });
    const taskLink = page.locator('.data-table-row--clickable .admin-link-btn').first();
    await expect(taskLink).toBeVisible({ timeout: 20000 });

    // L2 -> L3: the turn timeline + (when scored) the multi-turn flow score fold in here. The flow score
    // depends on the evaluate phase, so accept it OR the deepened breadcrumb as proof we reached L3.
    await taskLink.click();
    await expect(
      page.getByText(/Flow score/i).or(page.locator('.admin-breadcrumb .admin-link-btn').nth(2)),
    ).toBeVisible({ timeout: 25000 });
  });

  test('latency health: perceived-latency (TTFF/P95) renders and P95 is single-reply, not task-inflated', async ({ page }) => {
    test.setTimeout(90000);
    await signInAsAdmin(page);

    await page.goto('/?admin=latency');
    await expect(page.locator('h3:has-text("Response Latency")')).toBeVisible({ timeout: 15000 });
    await page.locator('.admin-metrics-row').first().waitFor({ timeout: 20000 });

    // TTFF is the PRIMARY perceived-latency metric (the placeholder appearing); P95 is the tail.
    const ttff = await cardValue(page, 'TTFF');
    const p95 = await cardValue(page, 'P95 Total');
    expect(msOf(ttff), `TTFF renders a real time value (got "${ttff}")`).toBeGreaterThan(0);
    const p95ms = msOf(p95);
    expect(p95ms, `P95 renders a real time value (got "${p95}")`).toBeGreaterThan(0);
    // Regression guard for the P95 fix: the old aggregation was Math.max over per-group rows INCLUDING
    // multi-step tasks (which run 90s+), so P95 read in the minutes. Task-excluded + traffic-weighted
    // keeps the single-reply P95 sane. 120s ceiling catches a regression to the task-inflated number.
    expect(p95ms, `P95 must be single-reply latency, not task-inflated (got "${p95}")`).toBeLessThan(120000);
  });

  test('mobile triage: the whole effectiveness row is a tap target', async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 390, height: 800 });
    await signInAsAdmin(page);

    await page.goto('/?admin=effectiveness');
    await page.locator('.data-table-row--clickable, .data-table-empty').first().waitFor({ timeout: 20000 });
    const row = page.locator('.data-table-row--clickable').first();
    if (!(await row.count())) {
      test.info().annotations.push({ type: 'note', description: 'No intent rows in window — mobile tap skipped.' });
      return;
    }
    // The row itself carries the click handler + is keyboard-focusable (a pointer/touch convenience over
    // the inline link — it deliberately is NOT role=button, to avoid nesting an interactive role).
    await expect(row).toHaveAttribute('tabindex', '0');
    await row.click({ position: { x: 10, y: 10 } }); // tap the row body, not the inline link
    await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });
  });
});
