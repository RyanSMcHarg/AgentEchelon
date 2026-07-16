import { Page, expect } from '@playwright/test';

/**
 * Banner capture for admin/analytics views.
 *
 * `ConsoleMonitor` catches console + page errors (CORS, failed fetches). But a
 * broken admin view often renders an on-screen banner with NO console error
 * (e.g. "Analytics API unavailable", a hard `.admin-error`). Those must be
 * picked up too, or a test passes green over a visibly-broken screen.
 *
 * Severity model:
 *  - ERROR  → `.admin-error`, or any `.admin-info-banner` / `.error-message`
 *             whose text says the API/backend is "unavailable". These mean the
 *             view is broken; tests should fail.
 *  - NOTICE → an "isn't served by the current analytics mode" (queryType not
 *             implemented in this mode) or "no data" banner. Expected/empty, not
 *             broken — surfaced (logged) but does not fail by default.
 */

const ERROR_SELECTORS = ['.admin-error', '.error-message'];
const INFO_SELECTOR = '.admin-info-banner';

export interface BannerReport {
  errors: string[];
  notices: string[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Collect all visible admin banners on the current view, classified. */
export async function collectBanners(page: Page): Promise<BannerReport> {
  const errors: string[] = [];
  const notices: string[] = [];

  for (const sel of ERROR_SELECTORS) {
    for (const el of await page.locator(sel).all()) {
      if (await el.isVisible().catch(() => false)) {
        errors.push(norm((await el.innerText().catch(() => '')) || sel));
      }
    }
  }

  for (const el of await page.locator(INFO_SELECTOR).all()) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = norm((await el.innerText().catch(() => '')) || '');
    // "unavailable" => the backend/API is broken (e.g. wrong contract, 5xx).
    if (/unavailable/i.test(text)) errors.push(text);
    else notices.push(text); // unsupported-in-this-mode / no-data: expected
  }

  return { errors, notices };
}

/**
 * Fail if any ERROR-class banner is visible. NOTICE banners (unsupported
 * queryType, no-data) are logged but allowed unless `strict` is set.
 */
export async function assertNoErrorBanners(
  page: Page,
  context = 'view',
  opts: { strict?: boolean } = {},
): Promise<void> {
  const { errors, notices } = await collectBanners(page);
  if (notices.length) {
    console.log(`[banner-check] ${context}: ${notices.length} notice(s): ${notices.join(' | ')}`);
  }
  const failing = opts.strict ? [...errors, ...notices] : errors;
  expect(failing, `Error banner(s) visible on ${context}: ${failing.join(' | ')}`).toEqual([]);
}
