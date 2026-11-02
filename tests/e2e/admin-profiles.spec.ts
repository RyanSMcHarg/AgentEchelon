/**
 * Assistant Profiles admin tab (SPEC-PORTABLE-PROFILES P1 UI) — proves the console's new
 * Profiles surface actually LOADS from the live manage-profiles API (not just that the tab shell renders).
 */
import { test, expect } from './helpers/fixtures';
import { signInAsAdmin } from './helpers/agent-helpers';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { assistantServing } from './helpers/assistant-identity';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardBackendErrors('admin-profiles');
guardConsoleErrors();


test('Assistants → Profiles LOADS the profile list from the live manage-profiles API', async ({ page }) => {
  test.setTimeout(90000);
  page.on('requestfailed', (r) => {
    if (/\/admin\/profiles/.test(r.url())) console.log('[net] REQUESTFAILED', r.method(), r.url(), '::', r.failure()?.errorText);
  });
  page.on('response', (r) => { if (/\/admin\/profiles/.test(r.url())) console.log('[net] RESPONSE', r.status(), r.request().method(), r.url()); });

  await signInAsAdmin(page);
  await page.goto('/?admin=profiles');

  // The Assistants section renders the Profiles tab.
  await expect(page.locator('h3:has-text("Assistants")')).toBeVisible({ timeout: 20000 });

  // Wait for the async load to settle.
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 20000 });

  // If it failed, surface the error before asserting.
  const failed = page.locator('.admin-error');
  if (await failed.count()) console.log('[profiles] LOAD ERROR:', (await failed.first().innerText()).replace(/\s+/g, ' ').trim());

  // The list must load this deployment's assistants, not a blank shell.
  //
  // THE ASSISTANT IS RESOLVED, NOT NAMED HERE. This asserted /basic|standard|premium/ - the
  // CLASSIFICATION list - which passed only while every profile happened to be named after the
  // classification it serves. An assistant is named for what it does now (DESIGN-SEPARATE-ASSISTANTS
  // 3.0), so that assertion failed against a list of concierge/analyst/advisor and would have failed
  // again on any future rename. Asking the deployment which assistant serves a classification keeps
  // the check about whether the list LOADED.
  // The Assistants list is the tab's one table: every assistant, however it was created.
  const profileTable = page.locator('.admin-content table').first();
  const rows = profileTable.locator('tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 10000 });
  const text = (await profileTable.innerText()).toLowerCase();
  expect(text, 'the profile list should include the assistant serving standard')
    .toContain(assistantServing('standard').toLowerCase());

  // Drill into a profile → its version list (active pointer visible).
  await rows.first().click();
  await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });
  // The version view renders "Active version" in more than one place (label + the active row), so scope
  // to the first match — the assertion is "the version detail loaded", not "exactly one such string".
  await expect(page.getByText(/Active version/i).first()).toBeVisible();
});

/**
 * RENAMING AN ASSISTANT THROUGH THE CONSOLE, end to end, including the half that leaves the profile
 * store: activating a version applies its `displayName` to the assistant's Amazon Chime SDK identity,
 * which is the name a person reads beside its messages.
 *
 * WHY THIS IS AN E2E AND NOT A UNIT TEST. Every piece of this was unit-tested and green while the
 * feature did not work: the version carried the name, the applier renamed the identity, and no screen
 * displayed either. What only a run through the console can show is that the field saves, the
 * activation reports what happened to the identity, and the panel reads the name back.
 *
 * IT RESTORES THE NAME IT CHANGED. This drives the live deployment, so leaving an assistant called
 * "E2E Renamed" would be visible to the next person in a room. The restore is asserted, not assumed.
 */
test('Assistants → Profiles RENAMES an assistant and applies it to the identity', async ({ page }) => {
  test.setTimeout(180_000);
  const profile = assistantServing('standard');

  await signInAsAdmin(page);
  await page.goto('/?admin=profiles');
  await expect(page.locator('h3:has-text("Assistants")')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 20000 });

  // Open the assistant this deployment declares for `standard`.
  await page.locator('.admin-content table').first().locator('tbody tr', { hasText: profile }).first().click();
  await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });

  // The read-only panel names it, beside its identifier. Both, deliberately: they were one field
  // until they had to be two, and showing only the label would reintroduce that confusion.
  // SCOPED TO THE FIRST: the page renders more than one `.admin-config-list` (the resolved
  // configuration and the assistant-infrastructure panel), and an unscoped locator is a strict-mode
  // violation rather than a useful assertion.
  const configPanel = page.locator('.admin-config-list').first();
  await expect(configPanel).toContainText('Assistant name', { timeout: 20000 });
  const originalPanelText = (await configPanel.innerText()).trim();

  // A draft is where an edit lives until it is activated, and THIS TEST STARTS ITS OWN. A draft already
  // pending is someone else's unactivated work, or a leftover from another run, and activating it would
  // publish content this test never read. That is how a fixture persona from profile-config.spec.ts
  // reached the live assistant through this test's rename. Refused, so it is resolved by a person.
  const newVersion = page.getByTestId('new-version');
  await expect(
    newVersion,
    `'${profile}' already has an unactivated draft. This test will not activate content it did not author; `
      + 'activate or replace that draft in the console, then re-run.',
  ).toBeVisible({ timeout: 20000 });
  await newVersion.click();

  // The draft opens on its Behavioral section, with the name and persona edited inline.
  await expect(page.getByTestId('draft-step-identity')).toBeVisible({ timeout: 30000 });
  const nameField = page.locator('label:has-text("Assistant name") input');
  await expect(nameField).toBeVisible({ timeout: 20000 });
  const originalName = (await nameField.inputValue()).trim();

  const RENAMED = 'E2E Renamed';
  await nameField.fill(RENAMED);
  await page.getByRole('button', { name: /Save draft edits/i }).click();
  await page.getByRole('button', { name: /^Validate$/i }).click();
  await expect(page.getByText(/Draft is valid/i)).toBeVisible({ timeout: 30000 });

  await page.getByRole('button', { name: /Activate draft/i }).click();

  // THE ASSERTION THIS TEST EXISTS FOR. Not that the console changed - that the console SAYS whether
  // the room changed with it. A rename that reached the profile store and not the identity is
  // invisible without this line, which is how the feature shipped looking complete once already.
  await expect(
    page.getByText(/messaging identity was renamed|already read that way|renaming the messaging identity failed|no rename path/i),
  ).toBeVisible({ timeout: 60000 });
  await expect(page.getByText(/renaming the messaging identity failed/i)).toHaveCount(0);

  // Read it back where an operator would look: the active version's Assistant name row, which shows only once the page
  // is back on the active version (the draft's sections list classification and owner first, without the name).
  const nameRow = page.getByTestId('field-displayName');
  await expect(nameRow).toContainText(RENAMED, { timeout: 30000 });

  // ── RESTORE, asserted ────────────────────────────────────────────────────────────────────────
  // Activation consumed the rename draft, so the restore starts from a fresh clone of what is serving.
  // Asserted rather than tolerated: a draft surviving its activation is the defect that let one test's
  // content become the next test's edit.
  const restoreVersion = page.getByTestId('new-version');
  await expect(restoreVersion, 'activation must consume the draft it promoted').toBeVisible({ timeout: 30000 });
  await restoreVersion.click();
  await expect(page.getByTestId('draft-step-identity')).toBeVisible({ timeout: 30000 });
  const restoreField = page.locator('label:has-text("Assistant name") input');
  await expect(restoreField).toBeVisible({ timeout: 20000 });
  // Filling '' is a real instruction, not a no-op: a cleared field sends `null`, which removes the
  // version's name and returns the identity to what the assistant was provisioned as. That is exactly
  // the restore an inheriting profile needs.
  await restoreField.fill(originalName);
  await page.getByRole('button', { name: /Save draft edits/i }).click();
  await page.getByRole('button', { name: /^Validate$/i }).click();
  await expect(page.getByText(/Draft is valid/i)).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: /Activate draft/i }).click();
  // Wait for the restore's activation to consume its draft (Edit is offered again) and the page to be back on the
  // active version. Until then the page may still be on the draft, whose sections hold no name row, and a check of
  // the first config list there could not tell a restore from no restore.
  await expect(page.getByTestId('new-version')).toBeVisible({ timeout: 60000 });
  await expect(page.getByText(/renaming the messaging identity failed/i)).toHaveCount(0);

  // THE RESTORE ASSERTION MUST NOT BE VACUOUS. `originalName` is empty on a profile that never set a
  // version-level name (it inherits), and `toContainText('')` passes against anything - the exact
  // shape of dead guard this repo has been bitten by before. So the check that always runs is the
  // NEGATIVE one: the test name is gone. The positive check runs only when there was a name to
  // restore, and the panel is asserted non-empty so "gone" cannot mean "the panel failed to render".
  await expect(nameRow).toBeVisible({ timeout: 30000 });
  await expect(nameRow).not.toContainText(RENAMED, { timeout: 30000 });
  const restoredPanel = (await nameRow.innerText()).trim();
  expect(restoredPanel.length, 'the config panel must render for its contents to mean anything').toBeGreaterThan(0);
  if (originalName) {
    await expect(nameRow).toContainText(originalName, { timeout: 30000 });
  } else {
    // It inherited before this test and must inherit again - the panel says so in words rather than
    // by showing a name, so assert the words.
    await expect(nameRow).toContainText(/Uses the provisioned name/i, { timeout: 30000 });
  }
  expect(originalPanelText.length, 'the config panel rendered before the test began').toBeGreaterThan(0);
  // And the restore left no draft behind for the next person to inherit.
  await expect(page.getByTestId('new-version')).toBeVisible({ timeout: 30000 });
});

/**
 * DISCARDING A DRAFT, end to end (SPEC-PORTABLE-PROFILES FR18): an edit saved to a fresh draft is thrown away from the
 * draft banner, behind a confirm that names what is lost, and nothing serving changes. The test leaves no draft behind.
 */
test('Assistants → Profiles DISCARDS a draft without activating it', async ({ page }) => {
  test.setTimeout(120_000);
  const profile = assistantServing('standard');

  await signInAsAdmin(page);
  await page.goto('/?admin=profiles');
  await expect(page.locator('h3:has-text("Assistants")')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 20000 });
  await page.locator('.admin-content table').first().locator('tbody tr', { hasText: profile }).first().click();
  await expect(page.locator('.admin-breadcrumb')).toBeVisible({ timeout: 10000 });

  // What is serving before, read where an operator reads it.
  const activeLine = page.locator('p.admin-tab-description', { hasText: 'Active version' }).locator('strong');
  await expect(activeLine).toBeVisible({ timeout: 20000 });
  const activeBefore = (await activeLine.innerText()).trim();

  // THIS TEST STARTS ITS OWN DRAFT; one already pending is someone else's work and is not thrown away here.
  const newVersion = page.getByTestId('new-version');
  await expect(newVersion, `'${profile}' already has an unactivated draft; resolve it in the console, then re-run.`).toBeVisible({ timeout: 20000 });
  await newVersion.click();

  const DISCARDED = 'E2E Discarded';
  await expect(page.getByTestId('draft-step-identity')).toBeVisible({ timeout: 30000 });
  const nameField = page.locator('label:has-text("Assistant name") input');
  await expect(nameField).toBeVisible({ timeout: 20000 });
  await nameField.fill(DISCARDED);
  await page.getByRole('button', { name: /Save draft edits/i }).click();
  await expect(page.getByTestId('assistant-nav-behavioral-changed')).toBeVisible({ timeout: 30000 });

  // The confirm names what is lost, and nothing is sent until it is confirmed.
  await page.getByTestId('draft-discard').click();
  await expect(page.getByTestId('draft-discard-lost')).toContainText('Name and persona');
  await page.getByTestId('draft-discard-confirm-button').click();

  await expect(page.getByTestId('draft-discarded')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('assistant-draft')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('new-version'), 'a discarded draft offers New version again').toBeVisible({ timeout: 30000 });
  // Nothing serving changed: the same active version, and the discarded name is nowhere on the panel.
  await expect(activeLine).toHaveText(activeBefore);
  await expect(page.locator('.admin-config-list').first()).not.toContainText(DISCARDED);
});
