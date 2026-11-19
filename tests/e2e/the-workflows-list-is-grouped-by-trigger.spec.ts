/**
 * THE CONSOLE'S ONE WORKFLOWS LIST, END TO END (ADR-067 stage 1, SPEC-WORKFLOWS-AND-TASKS WT98 and WT112).
 *
 * What only a deployment shows: the list is drawn from the live catalog and the active version, grouped by what starts
 * each workflow (Welcome, then each event, then When someone asks, then Platform); the Platform section explains what
 * the platform's workflows are for and offers nothing but View steps; and the welcome's Edit opens its own form on the
 * mode it runs today, where switching to A workflow shows the builder and switching away hides it.
 *
 * IT LEAVES THE ASSISTANT AS IT FOUND IT. The Edit starts a draft; nothing is saved from it, and the draft is discarded
 * through the signed `/admin/profiles/discard` route, so the next run or person inherits nothing.
 */
import { test, expect } from './helpers/fixtures';
import { type Page } from '@playwright/test';
import { signInAsAdmin } from './helpers/agent-helpers';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { assistantServing } from './helpers/assistant-identity';
import { exchange, signedCall } from './helpers/admin-api';
import { adminUrl } from './helpers/api-urls';
import { idTokenFor } from './helpers/person';
import { getAdminUser, getTestCredentials } from './helpers/test-credentials';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

guardBackendErrors('the-workflows-list-is-grouped-by-trigger');
guardConsoleErrors();

let startedDraftOf = '';

test.afterEach(async () => {
  if (!startedDraftOf) return;
  const profile = startedDraftOf;
  startedDraftOf = '';
  const adminUser = await getAdminUser();
  const creds = await getTestCredentials();
  const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
  expect(session.status, 'the cleanup could not open a console session').toBe(200);
  const admin = session.body.credentials;
  const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin);
  const configId = (listing.body?.profiles ?? []).find((p: any) => p.profileName === profile)?.draftConfigId;
  if (!configId) return;
  const discarded = await signedCall(adminUrl('assistant-admin', '/admin/profiles/discard'), admin, 'POST', { profileName: profile, configId });
  expect(discarded.status, `the draft this run started was not discarded: ${JSON.stringify(discarded.body).slice(0, 300)}`).toBe(200);
});

async function openWorkflows(page: Page, profile: string): Promise<void> {
  await page.goto('/?admin=profiles');
  await expect(page.locator('h2:has-text("Assistants")')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 20000 });
  await page.locator('.admin-content table').first().locator('tbody tr', { hasText: profile }).first().click();
  await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('assistant-nav-workflows').click();
  await expect(page.getByTestId('workflows-group-welcome')).toBeVisible({ timeout: 20000 });
}

const follows = (page: Page, a: string, b: string) => page.evaluate(([x, y]) => {
  const ex = document.querySelector(`[data-testid="${x}"]`)!;
  const ey = document.querySelector(`[data-testid="${y}"]`)!;
  return !!(ex.compareDocumentPosition(ey) & Node.DOCUMENT_POSITION_FOLLOWING);
}, [a, b]);

test('the Workflows list is grouped by trigger and the Platform section is read-only', async ({ page }) => {
  test.setTimeout(120_000);
  const profile = assistantServing('premium');
  await signInAsAdmin(page);
  await openWorkflows(page, profile);

  expect(await follows(page, 'workflows-group-welcome', 'field-event-workflows'), 'the welcome comes first').toBe(true);
  expect(await follows(page, 'field-event-workflows', 'workflows-group-intents'), 'events come before requests').toBe(true);
  expect(await follows(page, 'workflows-group-intents', 'workflows-platform-section'), 'the platform section comes last').toBe(true);

  // A request's workflows: every multi-step intent, with its steps to view and a reason, never an edit of the run level.
  const intents = page.getByTestId('field-machines');
  await expect(intents.locator('li[data-testid^="workflow-intent-"]').first()).toBeVisible();
  await expect(intents.locator('[data-testid$="-reason"]').first()).not.toBeEmpty();

  // The platform's workflows: closed until asked for; what they are for, and nothing but View steps.
  await page.getByTestId('workflows-platform-details').locator('summary').click();
  const platform = page.getByTestId('workflows-platform-section');
  await expect(platform).toContainText('queue management');
  await expect(platform.getByTestId('assistant-machine-row-queue_drain')).toBeVisible();
  const buttons = platform.getByRole('button');
  const count = await buttons.count();
  expect(count, 'the platform section offers View steps').toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await expect(buttons.nth(i)).toHaveText(/View steps/);
});

test('the welcome\'s Edit opens its own form, and the builder shows only for A workflow', async ({ page }) => {
  test.setTimeout(180_000);
  const profile = assistantServing('premium');
  await signInAsAdmin(page);
  await openWorkflows(page, profile);

  const own = page.getByTestId('field-welcome').locator('[data-testid^="assistant-edit-workflow-"]').first();
  await expect(own, `${profile}'s active version has a welcome of its own to edit`).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('new-version'), `'${profile}' already has an unactivated draft; resolve it, then re-run.`).toBeVisible({ timeout: 20000 });
  startedDraftOf = profile;
  await own.click();

  const form = page.getByTestId('welcome-mode-editor');
  await expect(form).toBeVisible({ timeout: 20000 });
  await expect(form).toContainText('When this assistant is added to a conversation, it greets members with');
  const checked = await form.locator('input[type="radio"]:checked').getAttribute('value');
  expect(['template', 'prompt', 'workflow']).toContain(checked);

  await form.getByTestId('welcome-mode-workflow').check();
  await expect(form.getByTestId('workflow-builder')).toBeVisible();
  await form.getByTestId('welcome-mode-template').check();
  await expect(form.getByTestId('workflow-builder')).toHaveCount(0);
  await expect(form.getByTestId('welcome-mode-steps-template')).toBeVisible();
});
