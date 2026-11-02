/**
 * THE CONSOLE REFLECTS WHAT THE SIGN-IN HOLDS (SPEC-ADMIN-CONSOLE FR0e, FR0f, FR44, FR48, FR53), live.
 *
 * The console opens on the capability set its console session carries, never on a group name. An
 * admin sees every section, and their reach on the Access log tab: what the console session holds, and
 * apart from it what the exchange grants only on request, one conversation at a time. A team member reaches only the assistants their team
 * owns: until it owns one they are told so and see Assistants alone, where they create one for their
 * team, and once it does, the console is scoped to that assistant - its profile, its experiments, its
 * conversations and its analytics, and no other section.
 *
 * Ownership is set for the run through the real ownership route as an admin, and the owner the
 * assistant had is put back afterwards.
 */
import { test, expect } from './helpers/fixtures';
import { type Page } from '@playwright/test';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import type { Browser } from '@playwright/test';
import { getTestCredentials, type TestUser } from './helpers/test-credentials';
import { signedAdminContext } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, adminUrl, personUrl } from './helpers/api-urls';
import { fillSecret } from './helpers/unrecorded-secret';

// THE CONSOLE IS ITS OWN ORIGIN (the AdminApp stack), as in admin-dashboard.spec.ts: without this the
// sign-in landed on the chat app, and every assertion looked for the console where it is not.
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

// Watch the server and the browser console: a refusal the console should have avoided asking for
// shows up in one of them before it shows up on screen.
guardBackendErrors('admin-console-reflects-role');
guardConsoleErrors();

const OWNED = 'analyst';
// The team this spec signs in as. Its ownership is this spec's fixture: what the team owns at the start
// of a test is whatever the last run, or a probe, left behind, so each test sets it rather than reads it.
const TEAM = 'ops';
const ALL_SECTIONS = ['Operations', 'Performance', 'Oversight', 'Models', 'Assistants', 'Experiments', 'Users'];
// Models is a team section because model usage and effectiveness are attributed per assistant (FR49).
const TEAM_SECTIONS = ['Performance', 'Oversight', 'Models', 'Assistants', 'Experiments'];

function ownershipUrl(): string {
  if (!ADMIN_API_URL) throw new Error('VITE_ADMIN_API_URL is needed to set ownership for this spec');
  return adminUrl('assistant-admin', '/admin/ownership');
}

/** An admin's signed context on the ownership route, from a sign-in on its own page. */
async function adminSession(browser: Browser): Promise<ReturnType<typeof signedAdminContext>> {
  const { testAdmin } = await getTestCredentials();
  const page = await browser.newPage();
  try {
    await signIn(page, testAdmin.email, testAdmin.password);
    return signedAdminContext(await idTokenOf(page));
  } finally {
    await page.close();
  }
}

/** Sign in on the login form without waiting for a dashboard, which a refused team member never gets. */
async function signInAsTeam(page: Page, user: TestUser): Promise<void> {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(user.email);
  await fillSecret(page.locator('input[type="password"]'), user.password);
  await page.locator('button[type="submit"]').click();
}

test.describe('the console reflects the role', () => {
  test('an admin sees every section, and their access on the Access log tab rather than the header', async ({ page }) => {
    const { testAdmin } = await getTestCredentials();
    await signIn(page, testAdmin.email, testAdmin.password);
    for (const section of ALL_SECTIONS) {
      await expect(page.locator('.admin-section-btn', { hasText: section }).first()).toBeVisible({ timeout: 20000 });
    }
    // The dashboard header carries no capability list (FR0e).
    await expect(page.getByTestId('admin-role-summary')).toHaveCount(0);
    await expect(page.getByTestId('admin-role-capabilities')).toHaveCount(0);
    await expect(page.locator('.admin-dashboard code', { hasText: 'manage-ownership' })).toHaveCount(0);
    await expect(page.getByTestId('admin-team-scope')).toHaveCount(0);

    // The Access log tab states the reach in the two forms the exchange enforces.
    await page.locator('.admin-section-btn', { hasText: 'Oversight' }).first().click();
    await page.locator('.admin-subtab-btn', { hasText: 'Access Log' }).first().click();
    const yours = page.getByTestId('access-log-your-access');
    await expect(yours).toContainText('Signed in as an administrator.', { timeout: 20000 });
    const held = page.getByTestId('access-log-held');
    const onRequest = page.getByTestId('access-log-on-request');
    await expect(held).toContainText('manage-ownership');
    await expect(held).toContainText('view-access-log');
    await expect(onRequest).toContainText('delete-conversation');
    await expect(onRequest).toContainText('redact');
    // Vended on request is never listed as held.
    await expect(held.locator('code', { hasText: /^delete-conversation$/ })).toHaveCount(0);
    await expect(held.locator('code', { hasText: /^redact$/ })).toHaveCount(0);
    // The minutes are the exchange's vend lifetime, stated with the list.
    await expect(yours).toContainText(/Granted on request \(\d+\).*for \d+ minutes/);
  });

  test('a team member whose team owns nothing is told so, and sees Assistants alone, where they create one', async ({ page, browser }) => {
    const { teamOpsUser } = await getTestCredentials();
    test.skip(!teamOpsUser?.password, 'teamOpsUser is not provisioned: run scripts/provision-test-users.mjs');
    // The precondition is set, not assumed: a run cut short after the block below assigned OWNED leaves
    // the team owning it, and every later run would then read a console here. OWNED held by the team is
    // that leftover and is cleared for good; any other assistant the team owns is a deployment's own
    // assignment, cleared for this test and put back after it.
    const admin = await adminSession(browser);
    const before = await (await admin.get(ownershipUrl())).json();
    const owned: string[] = before.assistants
      .filter((a: { ownerTeam: string | null }) => a.ownerTeam === TEAM)
      .map((a: { assistant: string }) => a.assistant);
    for (const assistant of owned) {
      const cleared = await admin.post(ownershipUrl(), { data: { assistant, team: null, reason: `e2e: the ${TEAM} team owns nothing for this test` } });
      expect(cleared.status(), await cleared.text()).toBe(200);
    }
    try {
      // A team that owns nothing gets a console naming only its team's routes: Assistants alone, the
      // empty state saying so, and the create flow for its own team.
      await signInAsTeam(page, teamOpsUser!);
      await expect(page.getByTestId('admin-team-scope')).toContainText('Your team owns no assistants yet', { timeout: 30000 });
      for (const section of ALL_SECTIONS.filter((s) => s !== 'Assistants')) {
        await expect(page.locator('.admin-section-btn', { hasText: section })).toHaveCount(0);
      }
      await expect(page.getByTestId('assistants-empty')).toContainText('Your team owns no assistants yet.', { timeout: 30000 });
      await page.getByTestId('create-assistant-open').click();
      // The wizard's first step, Classification and name, is where the assistant runs and where the owner is set.
      // The owner is the person's own team, shown fixed rather than offered.
      await expect(page.getByTestId('create-owner-team')).toContainText('Ops team');
      await expect(page.getByTestId('create-owner-team').locator('select')).toHaveCount(0);
    } finally {
      for (const assistant of owned.filter((a) => a !== OWNED)) {
        await admin.post(ownershipUrl(), { data: { assistant, team: TEAM, reason: 'e2e: restoring the owner it had before the test' } });
      }
    }
  });
});

test.describe.serial('a team member whose team owns an assistant', () => {
  let admin: ReturnType<typeof signedAdminContext>;
  let priorOwner: string | null = null;

  test.beforeAll(async ({ browser }) => {
    const { teamOpsUser } = await getTestCredentials();
    test.skip(!teamOpsUser?.password, 'teamOpsUser is not provisioned: run scripts/provision-test-users.mjs');
    admin = await adminSession(browser);
    const before = await (await admin.get(ownershipUrl())).json();
    const prior = before.assistants.find((a: { assistant: string }) => a.assistant === OWNED)?.ownerTeam ?? null;
    // OWNED held by this spec's own team is a run's leftover, not an owner to put back.
    priorOwner = prior === TEAM ? null : prior;
    const set = await admin.post(ownershipUrl(), { data: { assistant: OWNED, team: TEAM, reason: `e2e: the ${TEAM} team owns one assistant for this run` } });
    expect(set.status(), await set.text()).toBe(200);
  });

  test.afterAll(async () => {
    if (!admin) return;
    await admin.post(ownershipUrl(), { data: { assistant: OWNED, team: priorOwner, reason: 'e2e: restoring the owner it had before the run' } });
  });

  test('sees only that assistant, in only the sections its routes serve', async ({ page }) => {
    const { teamOpsUser } = await getTestCredentials();
    await signInAsTeam(page, teamOpsUser!);
    await expect(page.getByTestId('admin-team-scope')).toContainText(OWNED, { timeout: 30000 });
    await expect(page.getByTestId('admin-role-summary')).toHaveCount(0);
    for (const section of TEAM_SECTIONS) {
      await expect(page.locator('.admin-section-btn', { hasText: section }).first()).toBeVisible();
    }
    for (const section of ALL_SECTIONS.filter((s) => !TEAM_SECTIONS.includes(s))) {
      await expect(page.locator('.admin-section-btn', { hasText: section })).toHaveCount(0);
    }
  });

  test('manages that assistant\'s profile and no other, and with one team cannot move its owner', async ({ page }) => {
    const { teamOpsUser } = await getTestCredentials();
    await signInAsTeam(page, teamOpsUser!);
    await page.locator('.admin-section-btn', { hasText: 'Assistants' }).first().click({ timeout: 30000 });
    const rows = page.locator(`tbody tr[data-assistant="${OWNED}"]`);
    await expect(rows.first()).toBeVisible({ timeout: 30000 });
    // The listing is the team's own assistants: no other profile name appears in the table.
    for (const other of ['advisor', 'concierge', 'admin-agent']) {
      await expect(page.locator(`tbody tr[data-assistant="${other}"]`)).toHaveCount(0);
    }
    // One team: the filter is a fixed label, and the owner inside the configuration is shown, not offered.
    await expect(page.getByTestId('assistants-team-filter')).toContainText('Ops team');
    await rows.first().locator('button.btn-link').click();
    const identity = page.getByTestId('assistant-config-identity');
    await expect(identity.getByTestId('assistant-owner')).toContainText('Ops team', { timeout: 30000 });
    await expect(identity.getByTestId('assistant-owner-select')).toHaveCount(0);
    // Classification and role are facts of the assistant, not settings with a warning beside them.
    await expect(identity.getByRole('note')).toHaveCount(0);
  });

  test('lists the conversations that assistant is in, and reads one only for while it was there', async ({ page }) => {
    const { teamOpsUser } = await getTestCredentials();
    await signInAsTeam(page, teamOpsUser!);
    await page.locator('.admin-section-btn', { hasText: 'Oversight' }).first().click({ timeout: 30000 });
    // Every conversation listed is one the assistant serves: its own classification and nothing else.
    // The column shows the classification's declared display name, so the expected text is read from
    // the same `GET /classifications` the console renders from, never written here.
    const listed = await page.request.get(personUrl('/classifications'), { headers: { Authorization: `Bearer ${await idTokenOf(page)}` } });
    expect(listed.status(), await listed.text()).toBe(200);
    const standard = ((await listed.json()).classifications ?? []).find((c: { value: string }) => c.value === 'standard');
    expect(standard?.displayName, 'the deployment declares the standard classification').toBeTruthy();
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 30000 });
    for (const shown of await rows.locator('td:nth-child(2)').allInnerTexts()) expect(shown.trim()).toBe(standard.displayName);
    await page.getByRole('button', { name: 'View' }).first().click();
    // Reading what was said asks for a reason first, as an admin's read does (FR51).
    await expect(page.getByTestId('admin-reason-dialog')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('admin-reason-input').fill('e2e: a team reads its own assistant');
    await page.getByTestId('admin-reason-confirm').click();
    // The read is the team's assistant route, bounded to the periods the assistant was a member, and
    // the view says so; nothing is refused.
    await expect(page.getByText(new RegExp(`Showing only what was said while ${OWNED} was in this conversation`))).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/does not hold view-messages/)).toHaveCount(0);
    await expect(page.locator('.admin-error')).toHaveCount(0);
  });

  test('opens the experiments of that assistant without error', async ({ page }) => {
    const { teamOpsUser } = await getTestCredentials();
    await signInAsTeam(page, teamOpsUser!);
    await page.locator('.admin-section-btn', { hasText: 'Experiments' }).first().click({ timeout: 30000 });
    await expect(page.getByRole('heading', { name: /A\/B Experiments/ })).toBeVisible({ timeout: 30000 });
    // The classifier gate acts on a whole classification, so it is not a team's.
    await expect(page.locator('#admin-tab-classifier_gate')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Classifier accuracy gate' })).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/not attributed per assistant|was refused|does not hold/)).toHaveCount(0);
    await expect(page.locator('.admin-error')).toHaveCount(0);
  });

  test('reads that assistant\'s analytics', async ({ page }) => {
    const { teamOpsUser } = await getTestCredentials();
    await signInAsTeam(page, teamOpsUser!);
    await page.locator('.admin-section-btn', { hasText: 'Performance' }).first().click({ timeout: 30000 });
    // The effectiveness rows are the assistant's own turns, bound server-side to the path's assistant.
    // They are the Performance view's quality drill, opened from a quality card.
    await page.getByRole('button', { name: /^Relevance .*open the detail/ }).click();
    await expect(page.locator('.data-table-row--clickable').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.admin-error')).toHaveCount(0);
    // Latency, a drill of the same Performance view: its own numbers, and no refusal for a query
    // that is not attributed per assistant (the console does not ask for those on a team's behalf).
    await page.getByRole('button', { name: 'Full flow and latency' }).click();
    await expect(page.locator('h3:has-text("Response Latency")')).toBeVisible({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/not attributed per assistant|was refused|does not hold/)).toHaveCount(0);
  });
});
