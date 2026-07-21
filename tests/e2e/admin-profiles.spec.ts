/**
 * Assistant Profiles admin tab (SPEC-PORTABLE-VERSIONED-PROFILES P1 UI) — proves the console's new
 * Profiles surface actually LOADS from the live manage-profiles API (not just that the tab shell renders).
 */
import { test, expect, Page } from '@playwright/test';
import { signIn } from './helpers/agent-helpers';
import { getAdminUser } from './helpers/test-credentials';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

async function signInAsAdmin(page: Page): Promise<void> {
  const admin = await getAdminUser();
  await signIn(page, admin.email, admin.password);
}

test('Assistants → Profiles LOADS the profile list from the live manage-profiles API', async ({ page }) => {
  test.setTimeout(90000);
  page.on('requestfailed', (r) => {
    if (/\/admin\/profiles/.test(r.url())) console.log('[net] REQUESTFAILED', r.method(), r.url(), '::', r.failure()?.errorText);
  });
  page.on('response', (r) => { if (/\/admin\/profiles/.test(r.url())) console.log('[net] RESPONSE', r.status(), r.request().method(), r.url()); });

  await signInAsAdmin(page);
  await page.goto('/?admin=profiles');

  // The Assistants section renders the Profiles tab.
  await expect(page.locator('h3:has-text("Assistant Profiles")')).toBeVisible({ timeout: 20000 });

  // Wait for the async load to settle.
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 20000 });

  // If it failed, surface the error before asserting.
  const failed = page.locator('.admin-error');
  if (await failed.count()) console.log('[profiles] LOAD ERROR:', (await failed.first().innerText()).replace(/\s+/g, ' ').trim());

  // The seed created basic/standard/premium — the list must actually load them (not a blank shell).
  const rows = page.locator('.admin-content table tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 10000 });
  const text = (await page.locator('.admin-content table').innerText()).toLowerCase();
  expect(text, 'the profile list should include the seeded profiles').toMatch(/basic|standard|premium/);

  // Drill into a profile → its version list (active pointer visible).
  await rows.first().click();
  await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/Active version/i)).toBeVisible();
});
