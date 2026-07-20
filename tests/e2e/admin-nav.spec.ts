/**
 * Admin console navigation (live deployment).
 *
 * Regression coverage for the tracker's nav fixes (#4, #44 + tab deep-linking):
 *   - `?admin=<tab>` deep-links straight to a sub-tab (on the standalone admin app);
 *   - changing tabs pushes browser history, so Back (browser AND the in-app "Back"
 *     button) step through the previously-viewed tabs;
 *   - the Overview/Latency sub-tab strip aligns with the content inset (not flush-left).
 *
 * Run:
 *   cd tests && npx playwright test e2e/admin-nav.spec.ts --reporter=list
 */
import { test, expect, Page } from '@playwright/test';
import { signIn } from './helpers/agent-helpers';
import { getAdminUser } from './helpers/test-credentials';

// The admin console is its own app on its own origin (SPEC-SEPARATE-ADMIN-APP.md).
// `?admin=<tab>` is now a TAB selector within that app (AdminDashboard reads it),
// not a "console open" toggle on the chat SPA. Point at the admin origin.
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

/** The `admin` query param on the current URL (the tab id), or null. */
const adminParam = (page: Page): string | null => new URL(page.url()).searchParams.get('admin');

/** Sign in as the admin user on the admin app; the dashboard then renders at root
 *  and `?admin=<tab>` deep-links select a tab. */
async function signInAsAdmin(page: Page): Promise<void> {
  const admin = await getAdminUser();
  await signIn(page, admin.email, admin.password);
}

test.describe('Admin console navigation', () => {
  test('deep-links to a sub-tab; browser Back and in-app Back walk the tab history', async ({ page }) => {
    test.setTimeout(120000);
    await signInAsAdmin(page);

    // Deep-link straight to the Latency sub-tab (#44 tab-level deep-linking).
    await page.goto('/?admin=latency');
    const rail = page.locator('.admin-section-rail');
    await expect(rail).toBeVisible({ timeout: 15000 });
    const activeSubTab = page.locator('.admin-subtab-btn.active');
    await expect(activeSubTab).toHaveText(/Latency/i);
    expect(adminParam(page)).toBe('latency');

    // Switch to the Overview sub-tab — this pushes a history entry.
    await page.locator('.admin-subtab-btn', { hasText: 'Overview' }).click();
    await expect(activeSubTab).toHaveText(/Overview/i);
    expect(adminParam(page)).toBe('overview');

    // Browser Back returns to the previously-viewed tab (Latency), staying in the console.
    await page.goBack();
    await expect(rail).toBeVisible();
    await expect(activeSubTab).toHaveText(/Latency/i);
    expect(adminParam(page)).toBe('latency');

    // The in-app "Back" button steps through the tab history the same way.
    await page.locator('.admin-subtab-btn', { hasText: 'Overview' }).click();
    await expect(activeSubTab).toHaveText(/Overview/i);
    await page.locator('.admin-back-btn').click();
    await expect(activeSubTab).toHaveText(/Latency/i);
    expect(adminParam(page)).toBe('latency');
  });

  // (Removed) "Back from the first admin tab returns to the app" tested the OLD
  // chat-embedded model where Back exited the `?admin` console back to the chat
  // SPA. In the standalone admin app there is no chat surface to return to
  // (AdminApp `onBack={logout}`), so that boundary no longer exists.

  test('the sub-tab strip aligns with the content inset, not flush-left (#4)', async ({ page }) => {
    test.setTimeout(120000);
    await signInAsAdmin(page);

    // Overview section has >1 sub-tab, so the sub-tab strip renders.
    await page.goto('/?admin=overview');
    await expect(page.locator('.admin-subtabs')).toBeVisible({ timeout: 15000 });

    const subtabsMarginLeft = await page
      .locator('.admin-subtabs')
      .evaluate((el) => getComputedStyle(el).marginLeft);
    const contentPadLeft = await page
      .locator('.admin-content')
      .evaluate((el) => getComputedStyle(el).paddingLeft);

    // The strip must not be flush-left (the earlier fix targeted a dead .admin-tabs
    // selector, leaving .admin-subtabs at 0px); it should share the content's inset.
    expect(subtabsMarginLeft).not.toBe('0px');
    expect(subtabsMarginLeft).toBe(contentPadLeft);
  });
});
