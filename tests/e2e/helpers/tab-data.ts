/**
 * Assert an admin tab reached a DETERMINATE state — not just that its shell rendered.
 *
 * THE FAILURE THIS EXISTS FOR. Most admin-tab tests asserted a heading and a couple of filter
 * buttons: `expect(page.locator('h3:has-text("Flagged Responses")')).toBeVisible()`. That passes
 * when the tab renders its chrome and the data never arrives - a dead analytics endpoint, an empty
 * result from a broken query, a silently-caught fetch. The tab looks identical to a healthy tab
 * belonging to a quiet deployment, so the test reports green over a screen that shows the operator
 * nothing. A prior audit flagged four tabs as "would pass returning zero rows"; this is the
 * mechanism behind that.
 *
 * WHAT DETERMINATE MEANS. `DataTable` renders exactly one of two things once its data settles:
 * rows (`table.data-table tbody tr`), or an explicit empty state (`.data-table-empty`, default copy
 * "No data available"). Both are ANSWERS. What is not an answer is neither - a tab still spinning,
 * or one whose content area rendered nothing at all. That third state is what these tests used to
 * accept silently, and it is the only state this helper fails on by default.
 *
 * WHY EMPTY IS ALLOWED. A deployment can legitimately have no flagged responses. Requiring rows
 * would make the suite fail on a healthy quiet environment, and a test that fails when nothing is
 * wrong gets weakened until it means nothing. Callers that KNOW data must exist - because the test
 * just produced some - pass `requireRows` and get the stronger assertion.
 */
import { Page, expect } from '@playwright/test';
import { assertNoErrorBanners } from './banner-check';

export interface TabState {
  rows: number;
  empty: boolean;
  emptyText: string | null;
}

const ROW = 'table.data-table tbody tr';
const EMPTY = '.data-table-empty';
const LOADING = '.admin-tab-loading';

export interface DetermineOptions {
  /** Fail unless at least one row rendered. For tabs whose data this test just created. */
  requireRows?: boolean;
  /** How long to allow the tab's own loading state to clear. */
  timeoutMs?: number;
  /** Extra selectors that also count as an explicit empty/answered state for this tab. */
  emptySelectors?: string[];
}

/**
 * Wait for a tab to settle, then require it to be showing either data or an explicit empty state.
 * Returns what it found so a caller can log or assert further.
 */
export async function assertTabIsDeterminate(
  page: Page,
  label: string,
  opts: DetermineOptions = {},
): Promise<TabState> {
  const timeout = opts.timeoutMs ?? 25_000;

  // 1. The tab must stop loading. A spinner that never clears is the most common way a tab is
  //    "broken but not erroring", and every assertion after this would race it.
  await expect(
    page.locator(LOADING),
    `${label}: still showing a loading state after ${timeout}ms. The tab never settled, so anything `
    + 'asserted about its contents would be racing the spinner.',
  ).toHaveCount(0, { timeout });

  // 2. A visible error banner means the view is broken even if something rendered. Banners are
  //    separate from console errors: a broken admin view frequently renders one with a clean console.
  await assertNoErrorBanners(page, label);

  // 3. Determinate or not.
  const rows = await page.locator(ROW).count();
  const emptySelectors = [EMPTY, ...(opts.emptySelectors ?? [])];
  let empty = false;
  let emptyText: string | null = null;
  for (const sel of emptySelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      empty = true;
      emptyText = ((await el.innerText().catch(() => '')) || sel).replace(/\s+/g, ' ').trim();
      break;
    }
  }

  if (opts.requireRows) {
    expect(
      rows,
      `${label}: expected data rows, found none${empty ? ` (empty state: "${emptyText}")` : ''}. `
      + 'This test produced the data it is reading back, so an empty tab means the write did not '
      + 'reach the store the tab reads, or the tab is querying something else.',
    ).toBeGreaterThan(0);
    return { rows, empty, emptyText };
  }

  expect(
    rows > 0 || empty,
    `${label}: rendered its shell but neither data rows nor an explicit empty state. That is not a `
    + 'quiet deployment - it is a tab that answered nothing, which is exactly what a dead query, a '
    + 'silently-caught fetch, or a contract mismatch looks like from the DOM.',
  ).toBe(true);

  console.log(`[tab-data] ${label}: ${rows} row(s)${empty ? `, empty state "${emptyText}"` : ''}`);
  return { rows, empty, emptyText };
}
