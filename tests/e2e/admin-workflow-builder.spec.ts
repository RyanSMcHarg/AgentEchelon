/**
 * THE VISUAL WORKFLOW BUILDER, END TO END (ADR-061 decision 7): a workflow made on the canvas, connected, dragged and saved, still
 * where it was put after a reload, valid on the server, and walked by Preview run.
 *
 * WHY AN E2E. The unit tests (`WorkflowBuilder.test.tsx`, `a-workflow-layout-rides-the-version.test.ts`,
 * `a-preview-run-says-nothing-and-writes-nothing.test.ts`) prove each half against fakes. What only a deployment shows is
 * that the layout the canvas sends is stored as the draft's own body in the real bucket and comes back on the next read,
 * that the server's Validate accepts the draft the builder saved, and that the preview route answers through the signed
 * console session.
 *
 * IT LEAVES THE ASSISTANT AS IT FOUND IT. It starts its own draft (and refuses to run over someone else's), removes the
 * workflow it added, checks the draft then differs from nothing that serves, and activates that draft, which publishes
 * the active body again, so no draft is left for the next run or person to inherit. A run that stops before that
 * activation discards the draft it started, through the signed `/admin/profiles/discard` route naming the draft's
 * current configId, so a failed run cannot block the next.
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

guardBackendErrors('admin-workflow-builder');
guardConsoleErrors();

const WORKFLOW = 'e2e-builder';

/** Set once this run has started a draft, and cleared once it has activated it: what the cleanup below discards. */
let startedDraftOf = '';

/**
 * DISCARD THE DRAFT THIS RUN STARTED, read by its current configId (a save gives it a new one), through the operator's
 * signed path. Only ever called for a draft this run made: the test refuses to start where a draft already exists.
 */
async function discardStartedDraft(profile: string): Promise<void> {
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
}

test.afterEach(async () => {
  if (!startedDraftOf) return;
  const profile = startedDraftOf;
  startedDraftOf = '';
  await discardStartedDraft(profile);
});

async function openAssistant(page: Page, profile: string): Promise<void> {
  await page.goto('/?admin=profiles');
  await expect(page.locator('h3:has-text("Assistants")')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 20000 });
  await page.locator('.admin-content table').first().locator('tbody tr', { hasText: profile }).first().click();
  await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });
}

/** Show the draft's Workflows section and open its event workflows on the builder, with the test's workflow selected. */
async function openWorkflow(page: Page): Promise<void> {
  await page.getByTestId('assistant-mode-draft').click();
  await page.getByTestId('assistant-nav-workflows').click();
  const events = page.getByTestId('draft-step-events');
  await expect(events.getByTestId('workflow-builder')).toBeVisible({ timeout: 20000 });
  await events.getByTestId('event-workflow-select').selectOption(WORKFLOW);
  await expect(events.getByTestId('wfb-canvas')).toBeVisible();
}

/** Where a step is drawn: the left and top of its box on the canvas's plane. */
async function pointOf(page: Page, step: string): Promise<{ x: number; y: number }> {
  return page.getByTestId(`wfb-node-${step}`).evaluate((el) => {
    const wrap = el.parentElement as HTMLElement;
    return { x: parseInt(wrap.style.left, 10), y: parseInt(wrap.style.top, 10) };
  });
}

test('a workflow made on the canvas keeps where its steps were put, validates and previews', async ({ page }) => {
  test.setTimeout(240_000);
  const profile = assistantServing('basic');
  await signInAsAdmin(page);
  await openAssistant(page, profile);

  const newVersion = page.getByTestId('new-version');
  await expect(
    newVersion,
    `'${profile}' already has an unactivated draft. This test will not save over work it did not author; activate or replace that draft, then re-run.`,
  ).toBeVisible({ timeout: 20000 });
  startedDraftOf = profile;
  await newVersion.click();

  // ── CREATE on the canvas: a new workflow, run on invitation-sent, which a version declares at most once.
  await page.getByTestId('assistant-nav-workflows').click();
  await expect(page.getByTestId('draft-step-events').getByTestId('workflow-builder')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('event-workflow-new-name').fill(WORKFLOW);
  await page.getByTestId('event-workflow-add').click();
  await page.getByTestId('event-workflow-on').selectOption('invitation-sent');
  await expect(page.getByTestId('wfb-trigger')).toContainText('invitation-sent');
  await expect(page.getByTestId('wfb-node-opening')).toBeVisible();
  await expect(page.getByTestId('wfb-node-done')).toBeVisible();

  // ── EDIT in the inspector: the first step says the shipped `workflow-opening`.
  await page.getByTestId('wfb-node-opening').click();
  await page.getByTestId('wfb-step-template').selectOption('workflow-opening');

  // ── ADD after the first step, from the palette: it sits on the first step's path.
  await page.getByTestId('wfb-palette-send').click();
  await expect(page.getByTestId('wfb-announce')).toContainText(/Added step-3/);
  await expect(page.getByTestId('wfb-edge-opening-onSuccess-step-3')).toHaveCount(1);
  await expect(page.getByTestId('wfb-edge-step-3-onSuccess-done')).toHaveCount(1);
  await page.getByTestId('wfb-step-template').selectOption('workflow-opening');

  // ── CONNECT the first step's failure edge to the end, with the port and then the target.
  await page.getByTestId('wfb-node-opening').click();
  await page.getByTestId('wfb-port-opening-onFailure').click();
  await page.getByTestId('wfb-node-done').click();
  await expect(page.getByTestId('wfb-edge-opening-onFailure-done')).toHaveCount(1);

  // ── DRAG the end step with the mouse, and MOVE the new step with the keyboard.
  const before = await pointOf(page, 'done');
  // The mouse acts only inside the viewport, and the canvas sits below the assistant page's sections.
  await page.getByTestId('wfb-node-done').scrollIntoViewIfNeeded();
  const box = (await page.getByTestId('wfb-node-done').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 96, { steps: 8 });
  await page.mouse.up();
  const dragged = await pointOf(page, 'done');
  expect(dragged.x, 'the drag moved the step to the right').toBeGreaterThan(before.x + 100);
  await page.getByTestId('wfb-node-step-3').focus();
  const keyed = await pointOf(page, 'step-3');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await pointOf(page, 'step-3')).x).toBe(keyed.x + 40);
  const moved = await pointOf(page, 'step-3');
  await expect(page.getByTestId('wfb-status')).toContainText("Meets the server's rules");

  // ── SAVE, then RELOAD: the steps are where they were put.
  await page.getByTestId('draft-step-events').getByTestId('draft-step-save').click();
  await expect(page.getByTestId('assistant-nav-workflows-changed')).toBeVisible({ timeout: 30000 });
  await page.reload();
  await openAssistant(page, profile);
  await openWorkflow(page);
  expect(await pointOf(page, 'done')).toEqual(dragged);
  expect(await pointOf(page, 'step-3')).toEqual(moved);
  await expect(page.getByTestId('wfb-edge-opening-onFailure-done')).toHaveCount(1);

  // ── PREVIEW RUN on the server: the walk reaches the end and says each send to whom it reaches.
  await page.getByTestId('wfb-preview').click();
  await expect(page.getByTestId('wfb-preview-result')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('wfb-preview-end')).toContainText(/The run ends \(success\)/);
  await expect(page.getByTestId('wfb-node-step-3')).toHaveClass(/admin-wfb-node-visited/);

  // ── VALIDATE on the server: the draft the builder saved is valid.
  await page.getByRole('button', { name: /^Validate$/i }).click();
  await expect(page.getByText(/Draft is valid/i)).toBeVisible({ timeout: 30000 });

  // ── RESTORE, asserted: the workflow removed (its layout goes with it), nothing left changed, and the draft activated.
  await openWorkflow(page);
  await expect(page.getByTestId('assistant-nav-workflows-changed')).toBeVisible();
  await page.getByTestId('event-workflow-remove').click();
  await page.getByTestId('draft-step-events').getByTestId('draft-step-save').click();
  await expect(page.getByTestId('assistant-draft')).toBeVisible();
  await expect(page.getByTestId('assistant-nav-workflows-changed')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: /^Validate$/i }).click();
  await expect(page.getByText(/Draft is valid/i)).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: /Activate draft/i }).click();
  await expect(page.getByTestId('new-version')).toBeVisible({ timeout: 60000 });
  startedDraftOf = '';
});
