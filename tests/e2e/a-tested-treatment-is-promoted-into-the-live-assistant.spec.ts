/**
 * AN OPERATOR PROMOTES A TESTED TREATMENT (SPEC-BATTLE FR12, DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6, ADR-050).
 *
 * The promotion is driven from the admin console's Promote action, and every claim is read back from where it
 * lives rather than from the action's own answer:
 *   - the live assistant's active version: the `active` label on its definition parameter, and the console's
 *     profile listing (signed, as the admin app reads it);
 *   - the promoted version's `configId` and `promotedFrom`: the profile listing;
 *   - the experiment's status, `decision`, `promotion` and `transitions`: the experiments listing (signed);
 *   - the alt's release: its assignment record, and the candidate still in its history;
 *   - what serves: the archived turn, read through the signed analytics API. An experiment turn is read from the
 *     experiment drill-down (`experiment_exchanges`: `profile_name`, `profile_version`, `profile_config_id`);
 *     the turn after the promotion is outside the experiment and is read from `latency_exchanges`, which
 *     carries the answering assistant and `profile_version` but no configId. The live reply's metadata is the
 *     slim set the client receives, so it is used only to find each turn: its experiment, arm and conversation.
 *
 * THE TWO VERSIONS ARE MEASURED BEFORE ONE IS PROMOTED. The experiment is a `base_model` experiment on premium
 * whose treatment names a different model, so its candidate differs from the control. Premium conversations
 * are driven until each arm has served at least one turn, and each arm's turn is checked to have been served
 * by its pinned version: the control by the live assistant's active version, the treatment by the candidate in
 * the alt's history. What is promoted is therefore the configuration those turns measured.
 *
 * THE REFUSALS. A promotion is refused once the live version has moved since the experiment was armed: the
 * spec activates a clone of the live version (byte-identical behavior, a new version number), asks the console
 * to promote, and reads back that nothing was written. The second refusal, a caller holding only the
 * experiment capabilities, has no e2e user of that shape: `view-experiments`, `manage-experiments` and
 * `activate-profiles` are granted to the same roles (`admins`, `team-members`), so every provisioned admin or
 * team member holds all three. It is proven by `backend/test/admin-experiments.test.ts` ("is refused to a
 * caller who administers experiments but cannot activate profiles") and by the route sitting in the
 * `activate-profiles` capability in `backend/lib/config/admin-capabilities.ts`.
 *
 * WHY IT IS SAFE TO RUN ON A LIVE DEPLOYMENT. It records the live premium assistant's active version first and
 * `afterAll` rolls the assistant back to it and reads the label back, so the deployment serves what it served
 * before. Both experiments it arms are ended and deleted. What stays, by design: the clone and the promoted
 * copy in the live assistant's history (versions that served or were promoted), and the candidates in the
 * alt's history (the record of what was tried). The clone is made through `/version`, which replaces the live
 * assistant's draft with a copy of its active version, as `portable-profile-lifecycle` does.
 *
 * Gated by EXPERIMENTS_E2E=1, in its own validate phase (`experiment-promotion`). It needs premium to hold no
 * other live experiment (one per classification), so it retires stranded `e2e-` experiments on the way in and
 * fails naming any other one. Set PROMOTION_TREATMENT_MODEL_KEY when premium's base model is already `sonnet`.
 */
import { test, expect } from './helpers/fixtures';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf, WebSocketMonitor } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signedAdminContext, signedAdminGet, signedAnalyticsPost, type SignedAdminContext } from './helpers/signed-analytics';
import { retireStrandedE2eExperiments } from './helpers/experiment-sweep';
import { liveAssistantFor } from './helpers/battle-setup';
import { ConsoleMonitor } from './helpers/console-monitor';
import { activeProfileVersion, altAssignmentRecord, storedProfileVersion } from './helpers/profile-versions';
import { ADMIN_API_URL, adminApiServes, adminUrl, profileActionUrl } from './helpers/api-urls';

guardConsoleErrors();

const RUN = process.env.EXPERIMENTS_E2E === '1';
const suite = RUN ? test.describe.serial : test.describe.skip;

const EXPERIMENTS_API = adminApiServes('experiments') ? adminUrl('assistant-admin', '/admin/experiments') : '';
const PROFILES_API = ADMIN_API_URL ? adminUrl('assistant-admin', '/admin/profiles') : '';
const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';
const CHAT_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || CHAT_BASE_URL;

const CLASSIFICATION = 'premium';
/** The treatment's base model. It must differ from premium's live base model, or there is nothing to promote. */
const TREATMENT_MODEL_KEY = process.env.PROMOTION_TREATMENT_MODEL_KEY || 'sonnet';
/**
 * Conversations driven before both arms must have served. Each new conversation is enrolled in an arm at
 * 50/50, so ten leave about a 1-in-500 chance that one arm never comes up.
 */
const MAX_ENROLLMENTS = 10;
const PROMPTS = [
  'One sentence: what is a feature flag?',
  'One sentence: what is a canary deploy?',
  'One sentence: what is a rollback?',
  'One sentence: what is idempotency?',
  'One sentence: what is a circuit breaker?',
];

interface Pin { profileName: string; version: number; configId?: string }
interface VersionSummary {
  version: number;
  configId: string;
  active: boolean;
  promotedFrom?: { profileName: string; version: number; experimentId: string };
}

suite('an operator promotes a tested treatment into the live assistant (SPEC-BATTLE FR12)', () => {
  guardBackendErrors('experiment-promotion');

  let creds: TestCredentials;
  let idToken = '';
  let api: SignedAdminContext;
  /** The live premium assistant, by profile name, read from its assignment record. */
  let live = '';
  /** The live assistant's active version before this suite touched anything: the rollback target. */
  let originalVersion: number | null = null;
  /** Every experiment this suite created, so `afterAll` ends and deletes each whatever failed. */
  const createdIds: string[] = [];

  test.beforeAll(async ({ browser }) => {
    creds = await getTestCredentials();
    expect(EXPERIMENTS_API, 'VITE_ADMIN_API_CAPABILITIES must name experiments').toBeTruthy();
    expect(PROFILES_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
    expect(ANALYTICS_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
    const page = await browser.newPage();
    try {
      await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
      idToken = await idTokenOf(page);
      expect(idToken, 'admin idToken').toBeTruthy();
    } finally {
      await page.close().catch(() => undefined);
    }
    api = signedAdminContext(idToken);
    await retireStrandedE2eExperiments(api, EXPERIMENTS_API, { label: 'promotion' });

    live = liveAssistantFor(CLASSIFICATION);
    originalVersion = activeProfileVersion(live);
    expect(originalVersion, `${live} has no active version to measure against or roll back to`).toBeTruthy();
    // The console's listing and the label agree before anything moves, so a later disagreement is the product's.
    expect((await profileRow(live)).activeVersion, 'the profile listing names the labelled active version').toBe(originalVersion);
    console.log(`--- ${live} serves v${originalVersion} before the suite ---`);
  });

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────────

  /** The console's listing row for one assistant: its active version and every version's summary. */
  async function profileRow(name: string): Promise<{ activeVersion: number | null; versions: VersionSummary[] }> {
    const listed = await signedAdminGet(PROFILES_API, idToken);
    expect(listed.status, `read the profile listing (HTTP ${listed.status})`).toBe(200);
    const rows = listed.body?.profiles ?? listed.body?.data ?? listed.body;
    const row = (Array.isArray(rows) ? rows : []).find((p: any) => p?.profileName === name);
    expect(row, `the profile listing has no row for ${name}`).toBeTruthy();
    return { activeVersion: row.activeVersion ?? null, versions: Array.isArray(row.versions) ? row.versions : [] };
  }

  /** One experiment's row, from the signed experiments listing. */
  async function experimentRow(id: string): Promise<any | undefined> {
    const listed = await api.get(EXPERIMENTS_API);
    expect(listed.ok(), `list experiments: ${listed.status()}`).toBeTruthy();
    const body = await listed.json();
    const rows = body.experiments ?? body.data ?? body;
    return (Array.isArray(rows) ? rows : []).find((e: any) => e?.experimentId === id);
  }

  /** Poll the experiments listing (an eventually consistent scan) until the row satisfies `holds`. */
  async function experimentWhere(id: string, holds: (row: any) => boolean, what: string): Promise<any> {
    let last: any;
    for (let i = 0; i < 12; i++) {
      last = await experimentRow(id);
      if (last && holds(last)) return last;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(`${id}: never ${what}; last read ${JSON.stringify(last ?? null).slice(0, 600)}`);
  }

  /**
   * One conversation's archived turn, from a signed analytics query that returns per-turn rows with their
   * conversation. Waited for up to 300s, as experiment-results-trust waits: archival and pairing lag the
   * reply, and the wait is the honest response to that (nothing here triggers archival).
   */
  async function archivedTurn(body: Record<string, unknown>, channelArn: string, what: string): Promise<Record<string, any>> {
    let seen = 0;
    for (let i = 0; i < 60; i++) {
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken, body);
      const rows = Array.isArray(j?.data) ? j.data : [];
      seen = rows.length;
      const row = rows.find((r: any) => r?.channel_arn === channelArn);
      if (row) return row;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(
      `${what}: no archived row for ${channelArn} after 300s from ${String(body.queryType)} (${seen} other row(s) matched). `
      + 'Either archival and pairing had not caught up, or the turn was served by something the query filters out.',
    );
  }

  // ── writes ─────────────────────────────────────────────────────────────────────────────────────────

  /** A profile action through the signed console route; a refusal is returned as data. */
  async function profileAction(action: string, body: Record<string, unknown>): Promise<any> {
    return signedAnalyticsPost(profileActionUrl(action), idToken, body);
  }

  /**
   * Arm a `base_model` experiment on premium and read back both pins: the control is the live assistant's
   * active version, the treatment a candidate in the alt's history that differs from it.
   */
  async function arm(id: string, expectedControl: number): Promise<{ control: Pin; candidate: Pin; controlConfigId: string }> {
    createdIds.push(id);
    const created = await api.post(EXPERIMENTS_API, {
      data: {
        experimentId: id,
        name: `Promotion ${id}`,
        experimentType: 'base_model',
        status: 'active',
        tiers: [CLASSIFICATION],
        variants: [
          { variantId: 'control', weight: 50 },
          { variantId: 'treatment', weight: 50, modelKey: TREATMENT_MODEL_KEY },
        ],
      },
    });
    expect(
      created.ok(),
      `arm ${id}: ${created.status()} ${await created.text()} (a 409 naming another experiment means premium is held by one this suite does not own)`,
    ).toBeTruthy();
    const row = await experimentWhere(id, (r) => r.status === 'active' && r.servesVersions === true, 'armed with both versions pinned');
    const control = row.variants?.[0]?.controlPin as Pin | undefined;
    const candidate = row.variants?.[1]?.altPin as Pin | undefined;
    expect(control?.profileName, 'the control pins the live assistant').toBe(live);
    expect(control?.version, "the control pins the live assistant's active version by number").toBe(expectedControl);
    expect(candidate?.profileName, "the treatment pins a version in the alt's history").toMatch(/^alt-/);
    expect(Number.isInteger(candidate?.version), 'the candidate is pinned by number').toBe(true);
    expect(candidate?.configId, "the candidate's configId is recorded on the experiment row").toBeTruthy();
    const controlConfigId = (await profileRow(live)).versions.find((v) => v.version === expectedControl)?.configId ?? '';
    expect(controlConfigId, `the listing names v${expectedControl}'s configId`).toBeTruthy();
    expect(
      candidate!.configId,
      `the treatment's candidate is the control; premium's base model may already be '${TREATMENT_MODEL_KEY}' (set PROMOTION_TREATMENT_MODEL_KEY)`,
    ).not.toBe(controlConfigId);
    console.log(`--- ${id}: control ${live}@${control!.version}, candidate ${candidate!.profileName}@${candidate!.version} (${candidate!.configId}) ---`);
    return { control: control!, candidate: candidate!, controlConfigId };
  }

  /** Open the console's Experiments section on the admin origin, filtered to running experiments. */
  async function openConsole(browser: Browser): Promise<{ ctx: BrowserContext; console: Page; monitor: ConsoleMonitor }> {
    // signIn navigates to the CONTEXT's baseURL, so the context carries the admin origin.
    const ctx = await browser.newContext({ baseURL: ADMIN_BASE_URL });
    const consolePage = await ctx.newPage();
    // The suite-wide console guard watches the chat page; the console page gets its own monitor.
    const monitor = new ConsoleMonitor();
    await signIn(consolePage, creds.testAdmin.email, creds.testAdmin.password, undefined, monitor);
    await consolePage.locator('.admin-section-rail button:has-text("Experiments")').click();
    await consolePage.locator('.experiments-status-filter button', { hasText: /^Active/ }).click();
    return { ctx, console: consolePage, monitor };
  }

  /** Click Promote on the experiment's row and confirm it; returns the confirmation dialog. */
  async function promoteInConsole(consolePage: Page, id: string) {
    const row = consolePage.locator('tr', { hasText: id }).first();
    await expect(row, `the console lists ${id} among running experiments`).toBeVisible({ timeout: 60_000 });
    await row.getByRole('button', { name: 'Promote', exact: true }).click();
    const dialog = consolePage.locator('[role="dialog"]', { hasText: id });
    await expect(dialog, 'Promote asks for confirmation, naming the experiment').toBeVisible();
    await dialog.getByRole('button', { name: 'Promote', exact: true }).click();
    return { row, dialog };
  }

  /** No console error on the admin page other than the ones the caller expects. */
  function expectCleanConsole(monitor: ConsoleMonitor, allowed: (text: string) => boolean = () => false) {
    const errors = monitor.all
      .filter((e) => e.severity === 'error' || e.severity === 'pageerror')
      .map((e) => (e.url ? `${e.text} [${e.url}]` : e.text))
      .filter((t) => !allowed(t));
    expect(errors, 'the admin console logged errors').toEqual([]);
  }

  // ── the refusal ────────────────────────────────────────────────────────────────────────────────────

  test('promotion is refused once the live version has moved since the experiment was armed', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    expect(activeProfileVersion(live), 'the suite starts from the recorded version').toBe(originalVersion);
    const id = `e2e-promote-moved-${Date.now()}`;
    const { candidate } = await arm(id, originalVersion!);

    // MOVE THE LIVE VERSION: activate a clone of the active version. Same behavior, a new version number.
    await profileAction('/version', { profileName: live });
    const activated = await profileAction('/activate', { profileName: live });
    expect(typeof activated?.version, `activate a clone of ${live}: ${JSON.stringify(activated).slice(0, 300)}`).toBe('number');
    const moved = activated.version as number;
    expect(moved, 'the clone is a new version').toBeGreaterThan(originalVersion!);
    expect(activeProfileVersion(live), 'the active label follows the clone').toBe(moved);

    const { ctx, console: consolePage, monitor } = await openConsole(browser);
    try {
      const { dialog } = await promoteInConsole(consolePage, id);
      // The server's reason, shown as given: the live assistant serves another version than the control.
      const alert = dialog.locator('[role="alert"]');
      await expect(alert, 'the console shows the refusal').toBeVisible({ timeout: 60_000 });
      await expect(alert).toContainText(`version ${moved}`);
      await expect(alert).toContainText(`control version ${originalVersion}`);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      expectCleanConsole(monitor, (t) => /\b409\b/.test(t) && t.includes('/promote'));
    } finally {
      await ctx.close().catch(() => undefined);
    }

    // NOTHING WAS WRITTEN: the label stays on the clone, no version records a promotion from this experiment,
    // and the experiment is still running with no decision.
    expect(activeProfileVersion(live), 'a refused promotion moves nothing').toBe(moved);
    const listing = await profileRow(live);
    expect(listing.activeVersion, 'the listing still names the clone').toBe(moved);
    expect(
      listing.versions.filter((v) => v.promotedFrom?.experimentId === id),
      'a refused promotion publishes no version',
    ).toEqual([]);
    expect(
      listing.versions.some((v) => v.configId === candidate.configId && v.version > originalVersion!),
      "no version of the live assistant carries the refused candidate's configId",
    ).toBe(false);
    const row = await experimentRow(id);
    expect(row?.status, 'a refused promotion leaves the experiment running').toBe('active');
    expect(row?.decision, 'a refused promotion records no decision').toBeUndefined();
    expect(row?.promotion, 'a refused promotion records no promotion').toBeUndefined();

    // Put the live version back, and end this experiment, before the next test arms one on premium.
    const rolled = await profileAction('/rollback', { profileName: live, version: originalVersion });
    expect(JSON.stringify(rolled), 'roll back to the recorded version').not.toMatch(/"error"/);
    expect(activeProfileVersion(live), `${live} is back on v${originalVersion}`).toBe(originalVersion);
    const ended = await api.post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}/status`), {
      data: { status: 'completed', decision: { outcome: 'no_decision', note: 'e2e: promotion refused after the live version moved' } },
    });
    expect(ended.ok(), `end ${id}: ${ended.status()} ${await ended.text()}`).toBeTruthy();
    await experimentWhere(id, (r) => r.status === 'completed', 'completed');
  });

  // ── the promotion ──────────────────────────────────────────────────────────────────────────────────

  test('a promoted treatment becomes a new live version carrying what was measured, and serves the next turn', async ({ browser, page }) => {
    test.setTimeout(25 * 60_000);
    expect(activeProfileVersion(live), 'the suite starts from the recorded version').toBe(originalVersion);
    const id = `e2e-promote-${Date.now()}`;
    const { candidate, controlConfigId } = await arm(id, originalVersion!);

    // MEASURED TRAFFIC ON BOTH ARMS. A conversation is enrolled once, when it is created during the experiment,
    // and each reply names the experiment and the arm; the conversation it arrived in finds its archived turn.
    const wsMonitor = new WebSocketMonitor();
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password, wsMonitor);
    const served = new Map<string, string>();
    for (let i = 0; i < MAX_ENROLLMENTS && served.size < 2; i++) {
      await createConversation(page, `Promote ${id} ${i}`, 'Premium');
      const reply = await sendAndWaitForResponse(page, PROMPTS[i % PROMPTS.length], 180_000, wsMonitor);
      expect(reply.text?.length, `turn ${i} produced a reply`).toBeTruthy();
      const md = wsMonitor.lastBotMetadata ?? {};
      const arm = typeof md.variantId === 'string' ? md.variantId : '';
      const channelArn = wsMonitor.lastBotChannelArn ?? '';
      if (md.experimentId === id && arm && channelArn && !served.has(arm)) served.set(arm, channelArn);
    }
    expect([...served.keys()].sort(), `each arm served a turn within ${MAX_ENROLLMENTS} conversations`).toEqual(['control', 'treatment']);
    // WHAT SERVED EACH ARM, from the archive: the drill-down an operator promotes from.
    const control = await archivedTurn(
      { queryType: 'experiment_exchanges', experimentId: id, variantId: 'control', limit: 500 },
      served.get('control')!, 'the control turn',
    );
    expect(control.profile_name, 'the control turn is served by the live assistant').toBe(live);
    expect(control.profile_version, "the control turn is served by the live assistant's active version").toBe(originalVersion);
    expect(control.profile_config_id, "the control turn carries the live version's configId").toBe(controlConfigId);
    const treatment = await archivedTurn(
      { queryType: 'experiment_exchanges', experimentId: id, variantId: 'treatment', limit: 500 },
      served.get('treatment')!, 'the treatment turn',
    );
    expect(treatment.profile_name, 'the treatment turn is served by the candidate in the alt').toBe(candidate.profileName);
    expect(treatment.profile_version, 'the treatment turn is served by the pinned candidate version').toBe(candidate.version);
    expect(treatment.profile_config_id, "the treatment turn carries the candidate's configId: what is promoted is what was measured").toBe(candidate.configId);

    // PROMOTE FROM THE CONSOLE.
    const { ctx, console: consolePage, monitor } = await openConsole(browser);
    try {
      const { row, dialog } = await promoteInConsole(consolePage, id);
      await expect(dialog, 'the dialog closes when the promotion is accepted').toBeHidden({ timeout: 90_000 });
      // The list re-reads: a completed experiment leaves the running filter.
      await expect(row, 'the promoted experiment leaves the running experiments').toBeHidden({ timeout: 60_000 });
      expectCleanConsole(monitor);
    } finally {
      await ctx.close().catch(() => undefined);
    }

    // THE EXPERIMENT: completed as promoted_treatment, the promotion recorded with the candidate's configId.
    const done = await experimentWhere(id, (r) => r.status === 'completed', 'completed by the promotion');
    expect(done.decision?.outcome, 'the decision is promoted_treatment').toBe('promoted_treatment');
    expect(done.promotion?.profileName, 'the promotion names the live assistant').toBe(live);
    expect(done.promotion?.configId, "the promotion records the measured candidate's configId").toBe(candidate.configId);
    const promoted = done.promotion?.version as number;
    expect(Number.isInteger(promoted) && promoted > originalVersion!, `the promotion is a new version (got ${promoted})`).toBe(true);
    const lastTransition = (done.transitions ?? []).at(-1);
    expect(lastTransition?.to, 'the last transition completes the experiment').toBe('completed');
    expect(lastTransition?.reason, 'and says it was a promotion').toBe('promote');

    // THE LIVE ASSISTANT: the label is on the promoted version, which carries the candidate's configId and
    // names the candidate, its version and the experiment as its source.
    expect(activeProfileVersion(live), `the active label is on the promoted v${promoted}`).toBe(promoted);
    const listing = await profileRow(live);
    expect(listing.activeVersion, 'the console lists the promoted version as active').toBe(promoted);
    const version = listing.versions.find((v) => v.version === promoted);
    expect(version, `the listing has v${promoted}`).toBeTruthy();
    expect(version!.active, 'the promoted version is the active one').toBe(true);
    expect(version!.configId, "the copy hashes to the measured candidate's configId").toBe(candidate.configId);
    expect(version!.promotedFrom, 'the promoted version records where it came from').toEqual({
      profileName: candidate.profileName, version: candidate.version, experimentId: id,
    });

    // THE ALT: released (no experiment holds it, premium has no other live one), and the candidate is still in
    // its history as the record of what was tried.
    const alt = altAssignmentRecord(CLASSIFICATION);
    expect(alt.experimentId ?? null, 'the alt is not held by the promoted experiment').not.toBe(id);
    expect(alt.assistant ?? null, 'no experiment holds the alt after the promotion').toBeNull();
    const kept = storedProfileVersion(candidate.profileName, candidate.version);
    expect(kept?.derivedFrom?.experimentId, "the candidate stays in the alt's history, derived for this experiment").toBe(id);

    // THE NEXT TURN: a conversation created after the promotion is served the promoted version, outside the
    // experiment. The handler caches the active version (30s) and the experiment list (60s) per container, so
    // the turn is taken once both have expired.
    await page.waitForTimeout(65_000);
    await createConversation(page, `Promoted ${id}`, 'Premium');
    const reply = await sendAndWaitForResponse(page, PROMPTS[0], 180_000, wsMonitor);
    expect(reply.text?.length, 'the turn after the promotion produced a reply').toBeTruthy();
    expect(wsMonitor.lastBotMetadata?.experimentId ?? null, 'a conversation created after the promotion is not in the experiment').not.toBe(id);
    const nextChannel = wsMonitor.lastBotChannelArn ?? '';
    expect(nextChannel, 'the reply names its conversation').toBeTruthy();
    // A turn outside any experiment is not in the drill-down, so it is read from the per-turn latency rows,
    // filtered to the live assistant at the promoted version. Those rows carry no configId; the promoted
    // version's configId is the candidate's by the listing above.
    const next = await archivedTurn(
      { queryType: 'latency_exchanges', agentType: live, profileVersion: String(promoted), limit: 500 },
      nextChannel, `the turn after the promotion, at v${promoted}`,
    );
    expect(next.assistant, 'the next turn is answered by the live assistant').toBe(live);
    expect(Number(next.profile_version), `the next turn is served by the promoted v${promoted}`).toBe(promoted);
  });

  // ── cleanup, asserted ──────────────────────────────────────────────────────────────────────────────

  test.afterAll(async () => {
    if (!idToken) return;
    // Every step runs whatever an earlier one did, and every failure is reported together: a cleanup that
    // stops at its first error leaves the rest of the deployment changed.
    const problems: string[] = [];

    for (const id of createdIds) {
      try {
        const row = await experimentRow(id);
        if (row && (row.status === 'active' || row.status === 'paused')) {
          const ended = await api.post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}/status`), {
            data: { status: 'completed', decision: { outcome: 'no_decision', note: 'e2e cleanup' } },
          });
          if (!ended.ok()) problems.push(`end ${id}: ${ended.status()} ${await ended.text()}`);
        }
        const deleted = await api.delete(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}`));
        if (!deleted.ok()) problems.push(`delete ${id}: ${deleted.status()} ${await deleted.text()}`);
        const after = await experimentRow(id);
        if (after && after.status !== 'deleted') problems.push(`${id} is still '${after.status}' after delete`);
      } catch (err) {
        problems.push(`clean up ${id}: ${(err as Error).message}`);
      }
    }

    if (live && originalVersion !== null) {
      try {
        if (activeProfileVersion(live) !== originalVersion) {
          await profileAction('/rollback', { profileName: live, version: originalVersion });
        }
        const now = activeProfileVersion(live);
        if (now !== originalVersion) {
          problems.push(
            `ROLLBACK DID NOT RESTORE ${live}: it serves v${now}, not the v${originalVersion} this suite started from. Roll it back by hand.`,
          );
        } else {
          console.log(`--- ${live} restored to v${originalVersion} ---`);
        }
      } catch (err) {
        problems.push(`roll ${live} back to v${originalVersion}: ${(err as Error).message}`);
      }
    }
    await api?.dispose().catch(() => undefined);
    expect(problems, 'CLEANUP - the deployment is not as this suite found it').toEqual([]);
  });
});
