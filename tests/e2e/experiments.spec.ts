/**
 * A/B experiment e2e (#39 / cluster E).
 *
 * PRODUCES REAL DATA: creates an active base_model experiment via the admin API,
 * drives a conversation on the targeted tier so the async processor assigns the
 * turn to a variant (writes experiment_id/variant_id onto the exchange), then
 * asserts the analytics `experiment_results` query returns a row for it. Cleans
 * up (status -> completed) so re-runs are idempotent.
 *
 * Gated by EXPERIMENTS_E2E=1 (a validate.mjs phase). Runs against the live
 * deployment; NOT part of the default unit run.
 *
 * NOTE: written offline (AWS token expired mid-session) — needs a live run to
 * confirm the assignment→experiment_results path end to end (part of #39 is
 * verifying that assignment actually lands, so a failure here IS the finding).
 *
 *   E2E_BASE_URL=<cf> EXPERIMENTS_E2E=1 VITE_EXPERIMENTS_API_URL=<url> \
 *   VITE_ANALYTICS_API_URL=<url> AWS_PROFILE=<p> \
 *     npx playwright test e2e/experiments.spec.ts --config=playwright.config.ts
 */
import { test, expect, request as pwRequest, type Page, type APIRequestContext } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { WebSocketMonitor } from './helpers/websocket-monitor';
import { guardBackendErrors, guardConsoleErrors, allowConsoleError } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


const RUN = process.env.EXPERIMENTS_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;

const EXPERIMENTS_API = process.env.VITE_EXPERIMENTS_API_URL || '';
const ANALYTICS_API = process.env.VITE_ANALYTICS_API_URL || '';

// A minimal, valid non-battle base_model experiment on the premium tier: two
// weighted variants naming a model each. (Battle experiments have extra rules —
// exactly 2 variants + an alt-bot slot + a bound tier — which this deliberately
// avoids; this is plain A/B traffic assignment.)
function draftExperiment() {
  const id = `e2e-ab-basemodel-${Date.now()}`;
  return {
    experimentId: id,
    name: `E2E A/B base model ${id}`,
    experimentType: 'base_model',
    status: 'active',
    tiers: ['premium'],
    // Variants carry `modelKey` (a short catalog key: haiku/sonnet/opus…), NOT a raw
    // Bedrock `modelId`. A wrong field left modelKey undefined → catalog[undefined] →
    // resolution returned null → the conversation was never assigned → 0 result rows.
    variants: [
      { variantId: 'control', displayName: 'A', weight: 50, modelKey: 'haiku' },
      { variantId: 'treatment', displayName: 'B', weight: 50, modelKey: 'sonnet' },
    ],
  };
}

suite('A/B experiment produces experiment_results', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('experiments');

  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(EXPERIMENTS_API, 'VITE_EXPERIMENTS_API_URL must be set').toBeTruthy();
    expect(ANALYTICS_API, 'VITE_ANALYTICS_API_URL must be set').toBeTruthy();
  });

  test('create experiment, run a conversation, see a result row', async ({ page }) => {
    test.setTimeout(180_000);

    // 1. Admin auth (get an idToken) + create the experiment via the admin API.
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'admin idToken in localStorage').toBeTruthy();

    const api = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${idToken}` } });
    const draft = draftExperiment();
    const created = await api.post(EXPERIMENTS_API, { data: draft });
    expect(created.ok(), `create experiment: ${created.status()} ${await created.text()}`).toBeTruthy();

    try {
      // 2. Drive a premium-tier conversation so a turn is assigned to a variant. The
      //    experiment targets tiers:['premium'], so the conversation MUST be the Premium
      //    classification — createConversation defaults to 'Open' (basic), which the premium
      //    experiment never assigns, so pass 'Premium' explicitly.
      await createConversation(page, `Exp e2e ${Date.now()}`, 'Premium');
      const resp = await sendAndWaitForResponse(page, 'In one sentence, what is a feature flag?');
      expect(resp.text && resp.text.length).toBeTruthy();

      // 3. The exchange should now carry this experiment_id. Poll experiment_results.
      const end = new Date();
      const start = new Date(end.getTime() - 1 * 86_400_000);
      let row: unknown | undefined;
      // Archival (Chime -> Kinesis -> Firehose -> Aurora) buffers, so a single exchange can take
      // up to ~60-90s to land. Poll generously within the 180s test budget.
      for (let i = 0; i < 20 && !row; i++) {
        // The analytics API is IAM-enforced (adminIamEnforcement) — sign the request with the
        // admin's Identity-Pool creds; a Bearer JWT is rejected (403).
        const j = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
          queryType: 'experiment_results', dateRange: { start: start.toISOString(), end: end.toISOString() },
        });
        row = (j.data || []).find((x: any) => x.experiment_id === draft.experimentId || x.experimentId === draft.experimentId);
        if (!row) await page.waitForTimeout(6000); // archival + pairing lag
      }
      expect(row, `experiment_results should include ${draft.experimentId} after a conversation`).toBeTruthy();
    } finally {
      // 4. Cleanup — mark completed so it stops assigning traffic.
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(draft.experimentId)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });

  // The FULL A/B lifecycle end to end (the "smoke" test above only proves ONE row
  // lands). Drives enough premium turns that BOTH weighted variants get assigned,
  // asserts the head-to-head `experiment_results` carries both arms, exercises the
  // LLM ship-recommendation, then completes the experiment and confirms the
  // lifecycle transition. This is the "run an A/B test to completion" coverage.
  test('drives both variants, reads head-to-head results + recommendation, and completes', async ({ page }) => {
    // ~8 premium turns (haiku/sonnet variants) + archival + LLM recommendation.
    test.setTimeout(12 * 60_000);

    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'admin idToken in localStorage').toBeTruthy();
    const api = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${idToken}` } });

    const draft = draftExperiment();
    const created = await api.post(EXPERIMENTS_API, { data: draft });
    expect(created.ok(), `create experiment: ${created.status()} ${await created.text()}`).toBeTruthy();

    try {
      // 1. Drive enough premium traffic that BOTH 50/50 variants are assigned.
      // 8 independent turns → P(a variant is never picked) = 0.5^8 ≈ 0.4%.
      // A fresh premium conversation per turn keeps each an independent assignment.
      const prompts = [
        'In one sentence, what is a feature flag?',
        'One sentence: what is a canary deploy?',
        'One sentence: what is a blue-green deploy?',
        'One sentence: what is a rollback?',
        'One sentence: what is idempotency?',
        'One sentence: what is a circuit breaker?',
        'One sentence: what is exponential backoff?',
        'One sentence: what is a p95 latency?',
      ];
      for (let i = 0; i < prompts.length; i++) {
        await createConversation(page, `AB full ${i} ${Date.now()}`, 'Premium');
        const resp = await sendAndWaitForResponse(page, prompts[i], 120_000);
        expect(resp.text && resp.text.length, `turn ${i} produced a reply`).toBeTruthy();
      }

      // 2. Poll experiment_results until BOTH variants (control + treatment) have a row.
      const end = new Date();
      const start = new Date(end.getTime() - 1 * 86_400_000);
      const variantOf = (x: any): string => x.variant_id ?? x.variantId ?? '';
      let variants = new Set<string>();
      // 40 x 6s = 240s. The row is written by kinesis archival (exchanges JOIN messages), not on the
      // request path: Firehose buffers up to ~90s and the exchange pairs on the bot's UPDATE row, so
      // the tail turn's row can trail the answer by minutes. 150s lost this race intermittently -
      // with 8 independent assignments, a genuinely unassigned variant is a 0.4% event, so a missing
      // one here is nearly always lag, and the poll must outlast the pipeline rather than the model.
      for (let i = 0; i < 40 && variants.size < 2; i++) {
        const j = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
          queryType: 'experiment_results', dateRange: { start: start.toISOString(), end: end.toISOString() },
        });
        variants = new Set(
          (j.data || [])
            .filter((x: any) => (x.experiment_id ?? x.experimentId) === draft.experimentId)
            .map(variantOf)
            .filter(Boolean),
        );
        if (variants.size < 2) await page.waitForTimeout(6000); // archival + pairing lag
      }
      expect(
        Array.from(variants).sort(),
        `both variants should appear in experiment_results for ${draft.experimentId}`
          + ` (saw: ${Array.from(variants).sort().join(', ') || 'none'})`,
      ).toEqual(['control', 'treatment']);

      // 3. Ship recommendation — the LLM verdict over the collapsed per-variant rows.
      // It is advisory + descriptive (never reroutes); assert it returns a structured
      // recommendation, not a specific verdict (which is non-deterministic / may be
      // "needs more data" at this sample size).
      const recJson = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
        queryType: 'experiment_recommendation',
        experimentId: draft.experimentId,
        dateRange: { start: start.toISOString(), end: end.toISOString() },
      });
      // Tolerant: the recommendation payload shape varies (a per-variant `variants`
      // breakdown plus a verdict, or a needs-more-data signal at this sample size).
      // Assert it returns a structured, non-empty payload rather than a specific verdict.
      expect(
        recJson && typeof recJson === 'object' && Object.keys(recJson).length > 0,
        `recommendation returns a structured payload (got ${JSON.stringify(recJson).slice(0, 200)})`,
      ).toBeTruthy();

      // 4. Complete the lifecycle and confirm the transition (a completed experiment
      // stops assigning traffic).
      const done = await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(draft.experimentId)}/status`, { data: { status: 'completed' } });
      expect(done.ok(), `complete experiment: ${done.status()}`).toBeTruthy();
      const listed = await api.get(EXPERIMENTS_API);
      expect(listed.ok(), `list experiments: ${listed.status()}`).toBeTruthy();
      // GET /admin/experiments returns { experiments: [...] } (admin-experiments.ts).
      // Read that first; tolerate a bare array or a `data` envelope too. (Read the
      // body ONCE — Playwright's APIResponse.json() must not be double-awaited.)
      const listBody = await listed.json();
      const experiments = listBody.experiments ?? listBody.data ?? listBody;
      const mine = (Array.isArray(experiments) ? experiments : []).find(
        (e: any) => (e.experimentId ?? e.experiment_id ?? e.id) === draft.experimentId,
      );
      expect(mine?.status, `experiment ${draft.experimentId} is completed`).toBe('completed');
    } finally {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(draft.experimentId)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });

  /**
   * The drill-down RECONCILES with the aggregate it explains — against real data.
   *
   * This is the acceptance criterion for the evidence view (DESIGN §4.3): an operator must be able
   * to recompute the number they are about to ship on from the rows the console shows them. The
   * single assertion that covers it is that the drill-down's own totals equal `experiment_results`
   * for the same variant, because every way of getting the predicate wrong — a looser filter, a
   * different battle split, a join that multiplies rows — changes one of them and not the other.
   *
   * Deliberately checked against the LIVE pipeline rather than a fixture: the two readings are
   * assembled by different SQL over the same tables, and only real rows exercise the disagreement.
   */
  test('the drill-down reproduces the aggregate: same count, same mean, per variant', async ({ page }) => {
    test.setTimeout(8 * 60_000);

    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'admin idToken in localStorage').toBeTruthy();
    const api = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${idToken}` } });

    const draft = draftExperiment();
    const created = await api.post(EXPERIMENTS_API, { data: draft });
    expect(created.ok(), `create experiment: ${created.status()} ${await created.text()}`).toBeTruthy();

    try {
      // Four independent premium turns. Reconciliation needs real rows, not both variants: whichever
      // variants took traffic are the ones checked.
      const prompts = [
        'One sentence: what is a feature flag?',
        'One sentence: what is a canary deploy?',
        'One sentence: what is a rollback?',
        'One sentence: what is idempotency?',
      ];
      for (let i = 0; i < prompts.length; i++) {
        await createConversation(page, `Drill recon ${i} ${Date.now()}`, 'Premium');
        const resp = await sendAndWaitForResponse(page, prompts[i], 120_000);
        expect(resp.text && resp.text.length, `turn ${i} produced a reply`).toBeTruthy();
      }

      const end = new Date();
      const start = new Date(end.getTime() - 1 * 86_400_000);
      const dateRange = { start: start.toISOString(), end: end.toISOString() };

      // Wait for archival + pairing to land at least one row for this experiment.
      let rows: any[] = [];
      for (let i = 0; i < 30 && rows.length === 0; i++) {
        const j = await signedAnalyticsPost(ANALYTICS_API, idToken!, { queryType: 'experiment_results', dateRange });
        rows = (j.data || []).filter((x: any) => (x.experiment_id ?? x.experimentId) === draft.experimentId);
        if (rows.length === 0) await page.waitForTimeout(5000);
      }
      expect(rows.length, `experiment_results has rows for ${draft.experimentId}`).toBeGreaterThan(0);

      // Collapse to the per-variant aggregate the console displays: exchange-count-weighted, exactly
      // as ExperimentsTab.aggregateVariant does. Reconciling against a differently-computed number
      // would test this test, not the pipeline.
      const byVariant = new Map<string, { count: number; weighted: number }>();
      for (const r of rows) {
        const v = String(r.variant_id ?? r.variantId ?? '');
        const n = Number(r.exchange_count) || 0;
        const acc = byVariant.get(v) ?? { count: 0, weighted: 0 };
        acc.count += n;
        if (r.avg_score != null) acc.weighted += Number(r.avg_score) * n;
        byVariant.set(v, acc);
      }
      expect(byVariant.size, 'at least one variant took traffic').toBeGreaterThan(0);

      for (const [variantId, agg] of byVariant) {
        const drill = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
          queryType: 'experiment_exchanges',
          experimentId: draft.experimentId,
          variantId,
          axis: 'metrics',
          dateRange,
          limit: 25,
        });

        // 1. The COUNT must be identical. A drill-down filtered more loosely than the aggregate
        //    shows evidence that did not count toward the number beside it.
        expect(
          Number(drill.total),
          `drill-down count for ${variantId} matches the aggregate (drill=${drill.total}, aggregate=${agg.count})`,
        ).toBe(agg.count);

        // 2. The MEAN must match to rounding. The aggregate rounds each row to 1dp before weighting,
        //    so the tolerance covers that and nothing else.
        const aggregateMean = agg.count > 0 ? agg.weighted / agg.count : null;
        const drillMean = drill.stats?.avg_score == null ? null : Number(drill.stats.avg_score);
        if (aggregateMean != null && drillMean != null) {
          expect(
            Math.abs(drillMean - aggregateMean),
            `drill-down mean for ${variantId} matches the aggregate (drill=${drillMean}, aggregate=${aggregateMean})`,
          ).toBeLessThanOrEqual(0.15);
        }

        // 3. The rows must be the ones claimed: this variant, and never a battle turn (the metrics
        //    axis is the probabilistic population).
        for (const row of drill.data || []) {
          expect(String(row.variant_id), 'every row belongs to the drilled variant').toBe(variantId);
          expect(String(row.assignment_mode ?? 'probabilistic'), 'no battle turn in the metrics axis').not.toBe('battle');
        }

        // 4. Each row carries the conversation it came from, or the pipeline cannot link evidence.
        for (const row of drill.data || []) {
          expect(row.channel_arn, 'each exchange names its conversation').toBeTruthy();
        }
      }

      // An unscoped drill-down returns NOTHING rather than every experiment's exchanges.
      const unscoped = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
        queryType: 'experiment_exchanges',
        dateRange,
      });
      expect((unscoped.data || []).length, 'no experimentId returns an empty set').toBe(0);
    } finally {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(draft.experimentId)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });

  // L5 auto-complete (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.2): an `active`
  // experiment whose `endDate` has passed is lazily reconciled to `completed` on
  // the next GET (reconcileExpiredExperiments), with an `auto:endDate` system
  // transition — no scheduler, no manual status call. Create one that expires in
  // a few seconds, let it lapse, then read the list and assert the auto-flip.
  test('a past-endDate active experiment auto-completes on read (L5 lazy reconcile)', async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'admin idToken in localStorage').toBeTruthy();
    const api = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${idToken}` } });

    // Active now, but expiring ~6s out (valid at create; lapsed by the time we read).
    const draft = { ...draftExperiment(), endDate: new Date(Date.now() + 6_000).toISOString() };
    const created = await api.post(EXPERIMENTS_API, { data: draft });
    expect(created.ok(), `create expiring experiment: ${created.status()} ${await created.text()}`).toBeTruthy();

    try {
      // Poll the list past endDate: each GET performs the reconcile, so the status
      // flips to completed on the first read after the deadline (no scheduler).
      const reconciled = await waitForExperimentStatus(api, draft.experimentId, 'completed', 20_000);
      expect(reconciled, `experiment ${draft.experimentId} present in list`).toBeTruthy();
      expect(reconciled?.status, `past-endDate active experiment is auto-completed on read (got ${reconciled?.status})`).toBe('completed');
      const autoTransition = (reconciled?.transitions ?? []).find(
        (t: { to?: string; by?: string; reason?: string }) => t.to === 'completed' && t.reason === 'auto:endDate',
      );
      expect(autoTransition, `an auto:endDate system transition was appended: ${JSON.stringify(reconciled?.transitions)}`).toBeTruthy();
      expect(autoTransition?.by, 'the auto-completion is attributed to the system').toBe('system');
    } finally {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(draft.experimentId)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });
});

// ============================================================================
// Experiments — written objective, lifecycle conflict-resolution, and the
// decision loop (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md). The E1-E7 labels are defined HERE, not
// in that document - it carries no acceptance-test list, so do not cite a section for them.
//
// These extend the A/B smoke suite above with the design's ADDITIVE
// capabilities: a required objective STATEMENT + guardrails (§1); the
// End / Pause / Delete conflict-resolution flow, all confirmed (§3.2.1);
// decision-on-close incl. "No decision" as the default (§3.2.1 / §4.4);
// significance-aware results (§4.2); and recommended-vs-chosen (§4.4). Each
// test is written "As a <role>…" so it doubles as the acceptance check for the
// use case it validates.
//
// Origins: the admin CONSOLE flows drive E2E_ADMIN_BASE_URL (the standalone
// admin app, DESIGN-SEPARATE-ADMIN-APP.md); the data-producing checks drive a
// chat conversation on E2E_BASE_URL and SigV4-sign the analytics read via
// helpers/signed-analytics.ts, exactly as the smoke tests do. All go through
// the admin experiments API (VITE_EXPERIMENTS_API_URL, Bearer id token) for
// fast setup + audit verification.
//
// SOME of these are the design's NOT-YET-BUILT acceptance criteria (the
// objective statement field, the conflict panel, the decision picker, the
// computed-statistics recommendation contract). The assertions ARE the
// contract, so a failure here IS the finding — same posture as the
// "written offline / a failure here IS the finding" note on the smoke test.
// Gated behind EXPERIMENTS_E2E=1 so the default unit run never touches them.
// ============================================================================

const ADMIN_BASE_URL =
  process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';

let adminCreds: TestCredentials;

/** Deep-link to the admin Experiments tab, signing into the admin ORIGIN if its login shows. */
async function openAdminExperiments(page: Page): Promise<void> {
  await page.goto(new URL('/?admin=experiments', ADMIN_BASE_URL).toString());
  const needsLogin = await page
    .locator('input[type="password"]')
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (needsLogin) {
    // Auth is per-origin (localStorage); sign in against the form already on screen — do NOT
    // delegate to the shared signIn(), which navigates to the CHAT baseURL.
    await page.locator('input[type="email"]').fill(adminCreds.testAdmin.email);
    await page.locator('input[type="password"]').fill(adminCreds.testAdmin.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForSelector('.admin-dashboard, .admin-section-rail', { timeout: 30_000 });
    await page.goto(new URL('/?admin=experiments', ADMIN_BASE_URL).toString());
  }
  await page.waitForSelector('.admin-section-rail', { timeout: 15_000 });
  await expect(page.locator('h3:has-text("A/B Experiments")')).toBeVisible({ timeout: 15_000 });
}

/** The admin id token from the (admin-origin) localStorage — usable as a Bearer for the experiments API. */
async function adminIdToken(page: Page): Promise<string> {
  const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
  expect(idToken, 'admin idToken in localStorage (admin origin)').toBeTruthy();
  return idToken!;
}

/** A Bearer-authed request context for the admin experiments API. */
async function bearerApi(idToken: string): Promise<APIRequestContext> {
  return pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${idToken}` } });
}

/** Create an experiment straight through the admin API (fast setup for the UI flows). */
async function createExperimentApi(api: APIRequestContext, body: Record<string, unknown>) {
  const resp = await api.post(EXPERIMENTS_API, { data: body });
  return resp;
}

/**
 * Complete any lingering active/paused experiments so a lifecycle test starts from a clean
 * classification slot. Prior failed runs and battle arming leave active experiments that would
 * otherwise spuriously conflict (the type-exclusion rule) and cascade failures between tests.
 */
async function clearActiveExperiments(api: APIRequestContext): Promise<void> {
  const listed = await api.get(EXPERIMENTS_API);
  if (!listed.ok()) return;
  const body = await listed.json();
  const experiments = body.experiments ?? body.data ?? body;
  for (const e of (Array.isArray(experiments) ? experiments : [])) {
    const id = e.experimentId ?? e.experiment_id ?? e.id;
    if (id && (e.status === 'active' || e.status === 'paused')) {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
    }
  }
}

/** GET the experiments list and find one by id (tolerant of the {experiments}/{data}/bare-array shapes). */
async function getExperimentApi(api: APIRequestContext, id: string): Promise<any | undefined> {
  const listed = await api.get(EXPERIMENTS_API);
  if (!listed.ok()) return undefined;
  const body = await listed.json();
  const experiments = body.experiments ?? body.data ?? body;
  return (Array.isArray(experiments) ? experiments : []).find(
    (e: any) => (e.experimentId ?? e.experiment_id ?? e.id) === id,
  );
}

/**
 * Poll until `id` reaches `status`. The list endpoint is an eventually-consistent DynamoDB scan,
 * so a single read right after a lifecycle write (End/Pause/Resume) can return the pre-write state.
 * Returns the matching row, or the last-seen row if the deadline passes (so the caller's assertion
 * still reports the actual observed status).
 */
async function waitForExperimentStatus(
  api: APIRequestContext,
  id: string,
  status: string,
  timeoutMs = 15_000,
): Promise<any | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  do {
    last = await getExperimentApi(api, id);
    if (last?.status === status) return last;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < deadline);
  return last;
}

/** A minimal active base_model experiment on premium — the "blocker" the conflict flow must free. */
function premiumBlocker(id: string) {
  return {
    experimentId: id,
    status: 'active',
    experimentType: 'base_model',
    tiers: ['premium'],
    variants: [
      { variantId: 'control', displayName: 'A', weight: 50, modelKey: 'haiku' },
      { variantId: 'treatment', displayName: 'B', weight: 50, modelKey: 'sonnet' },
    ],
    startDate: new Date().toISOString(),
    // Written objective (§1) — a base_model quality objective with a statement.
    objective: { metric: 'quality', target: 8, statement: 'Blocker: decide the premium base model.' },
  };
}

/**
 * A CLASSIFICATION-type blocker on premium. The type-exclusion rule (§3.2.1,
 * experiment-manager.findTypeExclusionConflicts) fires only when EXACTLY ONE side
 * is a `classification` experiment — so a classification blocker vs the `intent`
 * experiment the create form produces is a genuine conflict (two same-family
 * types, e.g. base_model + intent, intentionally do NOT conflict). Classification
 * tests the classifier's accuracy, so its objective metric is `accuracy`.
 */
function premiumClassificationBlocker(id: string) {
  return {
    ...premiumBlocker(id),
    experimentType: 'classification',
    intent: '',
    objective: { metric: 'accuracy', target: 8, statement: 'Blocker: decide the premium classifier accuracy.' },
  };
}

/** Set the create-form tier toggles to exactly `tiers` (the form defaults to ['standard']). */
async function setCreateFormTiers(page: Page, tiers: string[]): Promise<void> {
  const btn = (t: string) => page.locator(`.admin-filter-group button:has-text("${t}")`).first();
  const isActive = async (t: string) =>
    /\bactive\b/.test((await btn(t).getAttribute('class').catch(() => '')) ?? '');
  for (const t of ['basic', 'standard', 'premium']) {
    const want = tiers.includes(t);
    // A single toggle click can be dropped mid-render / under load, silently leaving the tier in
    // the wrong state — the flaky root of the conflict-panel tests (a new experiment landed on the
    // default tier, so it never conflicted with the premium blocker). Click-then-verify with retries.
    for (let i = 0; i < 4 && (await isActive(t)) !== want; i++) {
      await btn(t).click();
      await page.waitForTimeout(150);
    }
    // Fail loudly if the toggle never took, rather than proceeding to create on the wrong tier.
    expect(await isActive(t), `create-form tier "${t}" should be ${want ? 'on' : 'off'}`).toBe(want);
  }
}

/** The new required objective-statement field (§1.4). Tolerant of the exact selector the build lands on. */
function objectiveStatementField(page: Page) {
  return page
    .getByLabel(/what decision will this test inform/i)
    .or(page.locator('textarea[name="objectiveStatement"]'))
    .or(page.locator('.experiment-objective-statement'));
}

/**
 * The objective TARGET (%) - REQUIRED since CR-13, and the fix is why: a blank target became
 * `Number('') === 0`, which experiment-stats documents as ABSENT, so the operator believed they set a
 * quantitative criterion and had set none. Every FORM create must fill it; the API-create tests are
 * unaffected. E1-E3 failed on exactly this after the requirement landed: the create never left the
 * client, so E1 saw no row and E2/E3 saw no 409 conflict panel.
 */
function objectiveTargetField(page: Page) {
  return page.getByLabel(/target \(%\)/i);
}

suite('Experiments — objective, lifecycle conflict-resolution & decision loop (§8 E1–E7)', () => {
  test.beforeAll(async () => {
    adminCreds = await getTestCredentials();
    expect(EXPERIMENTS_API, 'VITE_EXPERIMENTS_API_URL must be set').toBeTruthy();
    expect(ANALYTICS_API, 'VITE_ANALYTICS_API_URL must be set').toBeTruthy();
  });

  // E1 — As an operator, I want to author the objective (the decision this test
  // informs + a guardrail) and be BLOCKED from creating a test with an empty
  // objective, so the hypothesis and ship-rule are explicit, not tribal (§1).
  test('E1: author an objective — empty statement is blocked; statement + guardrail persist', async ({ page }) => {
    test.setTimeout(120_000);
    await openAdminExperiments(page);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const id = `e2e-obj-${Date.now()}`;

    try {
      await page.locator('button:has-text("New Experiment")').click();
      await expect(page.locator('h4:has-text("Create Experiment")')).toBeVisible();
      await page.locator('label:has-text("Experiment ID") input').fill(id);

      // (a) Empty objective statement must BLOCK create (statement required in the form, §1.2/§1.4).
      await page.locator('button:has-text("Create & Activate")').click();
      // Blocked = an inline validation names the missing objective/decision AND no row is created.
      await expect(page.locator('.admin-error')).toContainText(/objective|decision|statement/i, {
        timeout: 10_000,
      });
      expect(await getExperimentApi(api, id), 'no experiment created while the statement was empty').toBeFalsy();

      // (b) Fill the statement + one guardrail, then create.
      const statement = 'Decide whether to ship the treatment model for this intent.';
      await objectiveStatementField(page).first().fill(statement);
      await objectiveTargetField(page).first().fill('8');
      // Guardrail repeater (§1.2/§1.4): a metric that must NOT regress for a ship.
      await page.getByRole('button', { name: /add guardrail/i }).click();
      const gr = page.locator('.experiment-guardrail-row, .experiment-guardrail').last();
      await gr.locator('select').first().selectOption('cost').catch(() => {});
      await gr.locator('input[type="number"]').first().fill('25');
      await page.locator('.admin-error button:has-text("Dismiss")').click().catch(() => {});
      await page.locator('button:has-text("Create & Activate")').click();
      await expect(page.locator(`text=${id}`).first()).toBeVisible({ timeout: 15_000 });

      // Persistence (INV-2 additive): the record carries the statement + guardrail. (The
      // ObjectiveBanner render over live data is exercised by E6, which drives traffic.)
      const rec = await getExperimentApi(api, id);
      expect(rec?.objective?.statement, 'objective.statement persisted').toBe(statement);
      expect(
        Array.isArray(rec?.objective?.guardrails) && rec.objective.guardrails.length >= 1,
        'at least one guardrail persisted',
      ).toBeTruthy();
      expect(rec.objective.guardrails[0].metric, 'guardrail metric persisted').toBe('cost');
    } finally {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });

  // E2 — As an operator, when a classification is occupied I want to END the
  // blocker inline (confirmed), then have my create AUTO-RETRY and succeed, so I
  // can start my new test without hunting through the console (§3.2.1, L1/L2).
  test('E2: conflict → End the blocker (confirmed) → original create auto-retries and succeeds', async ({ page }) => {
    test.setTimeout(180_000);
    // The 409 IS the test: the conflict panel exists because a blocked create answers 409 with the
    // blockers in the body. Declared, so the console guard stays strict for every other test.
    allowConsoleError(/status of 409/i);
    await openAdminExperiments(page);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const blockerId = `e2e-blocker-end-${Date.now()}`;
    const newId = `e2e-new-end-${Date.now()}`;

    try {
      await clearActiveExperiments(api); // start from a clean premium slot
      // Occupy premium with an active CLASSIFICATION experiment (the blocker), so the intent
      // experiment the create form makes below is a genuine type-exclusion conflict.
      const b = await createExperimentApi(api, premiumClassificationBlocker(blockerId));
      expect(b.ok(), `create blocker: ${b.status()} ${await b.text()}`).toBeTruthy();
      await page.reload();
      await openAdminExperiments(page);

      // Author a CONFLICTING intent experiment on premium → the create is blocked (type-exclusion, 409).
      await page.locator('button:has-text("New Experiment")').click();
      await expect(page.locator('h4:has-text("Create Experiment")')).toBeVisible();
      await page.locator('label:has-text("Experiment ID") input').fill(newId);
      await setCreateFormTiers(page, ['premium']);
      await objectiveStatementField(page).first().fill('Decide the premium intent model.').catch(() => {});
      await objectiveTargetField(page).first().fill('8').catch(() => {});
      await page.locator('button:has-text("Create & Activate")').click();

      // The console surfaces the conflict as a RESOLUTION panel listing the blocker + three actions.
      const conflict = page.locator('[data-testid="experiment-conflict"], .experiment-conflict-panel, .admin-conflict');
      await expect(conflict).toBeVisible({ timeout: 15_000 });
      await expect(conflict).toContainText(blockerId);

      // End the blocker → a confirm dialog stating the consequence (terminal, results kept).
      await conflict.getByRole('button', { name: /^End/i }).click();
      const dialog = page.locator('.admin-confirm, [role="dialog"]').last();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText(/can(?:no|')t be resumed|results stay|No decision/i);
      await dialog.getByRole('button', { name: /End|Confirm/i }).click();

      // After the classification is free, the original create AUTO-RETRIES and activates.
      //
      // Two lessons from a race this assertion lost. `text=${newId}` matched the CONFLICT PANEL's own
      // '"<id>" can't start' line, so it passed while the retry was still in flight - the row locator
      // cannot. And the retry is a client-side chain (end -> list scan -> re-derive conflicts ->
      // create), so a single GET after it outran the create: the experiment existed seconds later,
      // created by the very retry the assertion said never ran. Poll, like the blocker check does.
      await expect(page.locator(`tr:has-text("${newId}")`).first()).toBeVisible({ timeout: 30_000 });

      // Blocker is terminal (completed) with an audit entry; the new experiment is active.
      const blockerRec = await waitForExperimentStatus(api, blockerId, 'completed');
      expect(blockerRec?.status, 'blocker ended (completed, terminal)').toBe('completed');
      expect(
        Array.isArray(blockerRec?.transitions) && blockerRec.transitions.some((t: any) => t.to === 'completed'),
        'a transition audit entry was written for the End (L7)',
      ).toBeTruthy();
      const newRec = await waitForExperimentStatus(api, newId, 'active', 30_000);
      expect(newRec?.status, 'the new experiment activated after auto-retry').toBe('active');
    } finally {
      for (const id of [blockerId, newId]) {
        await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      }
      await api.dispose();
    }
  });

  // E3 — As an operator, I want to PAUSE the blocker (confirmed, data preserved),
  // let my create proceed, and RESUME the paused one later with its data intact (§3.2.1).
  test('E3: conflict → Pause the blocker (confirmed) → create proceeds → Resume restores it to active', async ({ page }) => {
    test.setTimeout(180_000);
    // The 409 IS the test: the conflict panel exists because a blocked create answers 409 with the
    // blockers in the body. Declared, so the console guard stays strict for every other test.
    allowConsoleError(/status of 409/i);
    await openAdminExperiments(page);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const blockerId = `e2e-blocker-pause-${Date.now()}`;
    const newId = `e2e-new-pause-${Date.now()}`;

    try {
      await clearActiveExperiments(api); // start from a clean premium slot
      const b = await createExperimentApi(api, premiumClassificationBlocker(blockerId));
      expect(b.ok(), `create blocker: ${b.status()}`).toBeTruthy();
      await page.reload();
      await openAdminExperiments(page);

      await page.locator('button:has-text("New Experiment")').click();
      await expect(page.locator('h4:has-text("Create Experiment")')).toBeVisible();
      await page.locator('label:has-text("Experiment ID") input').fill(newId);
      await setCreateFormTiers(page, ['premium']);
      await objectiveStatementField(page).first().fill('Decide the premium intent model.').catch(() => {});
      await objectiveTargetField(page).first().fill('8').catch(() => {});
      await page.locator('button:has-text("Create & Activate")').click();

      const conflict = page.locator('[data-testid="experiment-conflict"], .experiment-conflict-panel, .admin-conflict');
      await expect(conflict).toBeVisible({ timeout: 15_000 });

      // Pause is reversible but still confirmed (it changes a running test's data collection).
      await conflict.getByRole('button', { name: /^Pause/i }).click();
      const dialog = page.locator('.admin-confirm, [role="dialog"]').last();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText(/preserved|Resume it later|stop being assigned/i);
      await dialog.getByRole('button', { name: /Pause|Confirm/i }).click();

      // Create proceeds; blocker is paused (data preserved, not terminal).
      await expect(page.locator(`text=${newId}`).first()).toBeVisible({ timeout: 20_000 });
      expect((await waitForExperimentStatus(api, blockerId, 'paused'))?.status, 'blocker paused').toBe('paused');

      // Later: Resume the paused blocker → back to active with its data intact. (Complete the
      // conflicting one first so premium is free for the resume.)
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(newId)}/status`, { data: { status: 'completed' } });
      await api.get(EXPERIMENTS_API); // best-effort: let the pause settle before the UI reads it
      await page.reload();
      await openAdminExperiments(page);
      // The admin list read is an eventually-consistent scan, so a reload right after the pause can
      // still render the blocker in its pre-pause (active) state. Reload until the paused row — with
      // its Resume button — appears, then resume it.
      const row = page.locator(`tr:has-text("${blockerId}")`).first();
      const resumeBtn = () => row.getByRole('button', { name: /Resume/i });
      for (let i = 0; i < 4 && !(await resumeBtn().isVisible({ timeout: 3000 }).catch(() => false)); i++) {
        await page.reload();
        await openAdminExperiments(page);
      }
      await expect(resumeBtn()).toBeVisible({ timeout: 5_000 });
      await resumeBtn().click();
      await expect(row).toContainText('active', { timeout: 10_000 }).catch(() => {}); // API check below is authoritative
      expect((await waitForExperimentStatus(api, blockerId, 'active'))?.status, 'blocker resumed to active').toBe('active');
    } finally {
      for (const id of [blockerId, newId]) {
        await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      }
      await api.dispose();
    }
  });

  // E4 — As an operator, I want DELETE to hard-remove a never-started draft but
  // leave a tombstone for a test that ran, the hard/soft choice decided
  // server-side, both freeing the classification (§3.2.1, L8). The console Delete
  // button drives the same DELETE endpoint asserted here.
  test('E4: Delete both modes — draft hard-deletes; a test that ran tombstones (server decides)', async ({ page }) => {
    test.setTimeout(120_000);
    await openAdminExperiments(page);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const draftId = `e2e-del-draft-${Date.now()}`;
    const ranId = `e2e-del-ran-${Date.now()}`;

    try {
      await clearActiveExperiments(api); // start from a clean premium slot
      // (a) A never-started DRAFT → hard delete: the row is gone and the id is reusable.
      const d = await createExperimentApi(api, { ...premiumBlocker(draftId), status: 'draft' });
      expect(d.ok(), `create draft: ${d.status()} ${await d.text()}`).toBeTruthy();
      const delDraft = await api.delete(`${EXPERIMENTS_API}/${encodeURIComponent(draftId)}`);
      expect(delDraft.ok(), `DELETE draft: ${delDraft.status()}`).toBeTruthy();
      expect(await getExperimentApi(api, draftId), 'draft is hard-gone from the list').toBeFalsy();
      // Hard-gone ⇒ the id is free to reuse (a soft tombstone would remain terminal under the same id).
      const reuse = await createExperimentApi(api, { ...premiumBlocker(draftId), status: 'draft' });
      expect(reuse.ok(), 'the hard-deleted id is reusable').toBeTruthy();
      await api.delete(`${EXPERIMENTS_API}/${encodeURIComponent(draftId)}`).catch(() => {});

      // (b) A test that RAN (was active) → soft-delete tombstone: hidden from the default list,
      // but NOT a hard remove — the record survives so historical exchanges keep their variant
      // labels in analytics. The DELETE response reports the mode (soft) and the freed classification.
      const r = await createExperimentApi(api, premiumBlocker(ranId));
      expect(r.ok(), `create ran experiment: ${r.status()}`).toBeTruthy();
      const delRan = await api.delete(`${EXPERIMENTS_API}/${encodeURIComponent(ranId)}`);
      expect(delRan.ok(), `DELETE ran experiment: ${delRan.status()}`).toBeTruthy();
      const delBody = await delRan.json().catch(() => ({} as Record<string, unknown>));
      // Soft-delete signal (server-side hard/soft choice) + the classification is freed for auto-retry.
      const softSignal =
        /soft/i.test(JSON.stringify(delBody)) || delBody.deleted === 'soft' || delBody.mode === 'soft';
      const reuseRan = await createExperimentApi(api, premiumBlocker(ranId));
      // Either the DELETE explicitly reports a soft-delete, OR the id is NOT reusable (a terminal
      // tombstone persists) — both prove it did not hard-remove a test that ran.
      expect(
        softSignal || !reuseRan.ok(),
        `a test that ran left a tombstone (soft), not a hard delete (delBody=${JSON.stringify(delBody).slice(0, 200)}, reuse=${reuseRan.status()})`,
      ).toBeTruthy();
    } finally {
      for (const id of [draftId, ranId]) {
        await api.delete(`${EXPERIMENTS_API}/${encodeURIComponent(id)}`).catch(() => {});
        await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      }
      await api.dispose();
    }
  });

  // E5 — As an operator, ending a test that ran prompts me to record the outcome
  // and NEVER forces me to declare a winner: "No decision" is selectable and the
  // DEFAULT, so an inconclusive test closes honestly (§3.2.1, §4.4, INV-1/INV-3).
  test('E5: End with No decision — the decision picker defaults to "No decision" and persists', async ({ page }) => {
    test.setTimeout(120_000);
    await openAdminExperiments(page);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const id = `e2e-decision-${Date.now()}`;

    try {
      const c = await createExperimentApi(api, premiumBlocker(id));
      expect(c.ok(), `create experiment: ${c.status()}`).toBeTruthy();
      await page.reload();
      await openAdminExperiments(page);

      const row = page.locator(`tr:has-text("${id}")`).first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      // Completing a test that RAN opens the decision picker (not a silent transition).
      await row.getByRole('button', { name: /Complete|End/i }).click();
      // The confirm dialog (role="dialog") CONTAINS both the decision <select> and the End button.
      // Target the dialog itself — NOT the nested `.experiment-decision-picker` div, which holds the
      // select but not the sibling End button (a `.last()` match on the picker div would make the
      // End click below hang).
      const picker = page.locator('[role="dialog"]').last();
      await expect(picker).toBeVisible({ timeout: 10_000 });
      // "No decision" is present AND the default — the operator is not forced to pick a winner.
      const select = picker.locator('select').first();
      await expect(select).toBeVisible({ timeout: 5_000 });
      await expect(select.locator('option')).toContainText([/no decision/i]);
      const defaultVal = await select.inputValue();
      const defaultLabel = await select.locator(`option[value="${defaultVal}"]`).innerText().catch(() => '');
      expect(
        /no_decision/i.test(defaultVal) || /no decision/i.test(defaultLabel),
        `decision picker defaults to "No decision" (got value=${defaultVal}, label=${defaultLabel})`,
      ).toBeTruthy();
      await picker.getByRole('button', { name: /Complete|End|Confirm/i }).click();

      // Recorded decision + actor persist on the completed experiment (feeds the audit, L7).
      await expect(row).toContainText('completed', { timeout: 15_000 }).catch(() => {});
      const rec = await getExperimentApi(api, id);
      expect(rec?.status, 'experiment completed').toBe('completed');
      expect(rec?.decision?.outcome, 'recorded decision is "no_decision"').toBe('no_decision');
      expect(rec?.decision?.by, 'the deciding admin (actor) is recorded').toBeTruthy();
    } finally {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });

  // E6 — As an operator, I want results that show statistical SIGNIFICANCE and
  // confidence, not raw averages, so I don't ship on noise (§4.2). Drives real
  // premium traffic, then reads the recommendation contract (computed p-value /
  // powered / derived confidence).
  test('E6: significance-aware results — the recommendation carries computed statistics, not a bare winner', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    // Traffic is driven on the CHAT origin; the analytics + experiments APIs take the same id token.
    await signIn(page, adminCreds.testAdmin.email, adminCreds.testAdmin.password);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const id = `e2e-sig-${Date.now()}`;

    try {
      const c = await createExperimentApi(api, premiumBlocker(id));
      expect(c.ok(), `create experiment: ${c.status()}`).toBeTruthy();

      // Drive premium turns so both variants accrue exchanges (mirrors the full-lifecycle smoke test).
      const prompts = [
        'In one sentence, what is a feature flag?',
        'One sentence: what is a canary deploy?',
        'One sentence: what is a blue-green deploy?',
        'One sentence: what is a rollback?',
        'One sentence: what is idempotency?',
        'One sentence: what is a circuit breaker?',
      ];
      for (let i = 0; i < prompts.length; i++) {
        await createConversation(page, `Sig ${i} ${Date.now()}`, 'Premium');
        const resp = await sendAndWaitForResponse(page, prompts[i], 120_000);
        expect(resp.text && resp.text.length, `turn ${i} produced a reply`).toBeTruthy();
      }

      const end = new Date();
      const start = new Date(end.getTime() - 86_400_000);
      let rec: any;
      for (let i = 0; i < 10 && !rec?.primary; i++) {
        rec = await signedAnalyticsPost(ANALYTICS_API, idToken, {
          queryType: 'experiment_recommendation',
          experimentId: id,
          dateRange: { start: start.toISOString(), end: end.toISOString() },
        });
        if (!rec?.primary) await page.waitForTimeout(5000); // archival + pairing lag
      }

      // The recommendation reports a COMPUTED statistic on the primary metric (§4.2-C/E), not a
      // self-assessed LLM confidence: a p-value + significance flag + powered flag, and a derived
      // confidence label. An underpowered/thin sample must read as "not significant" / "underpowered",
      // never as a bare winner — honesty preserved (INV-3).
      expect(rec && typeof rec === 'object' && rec.primary, `recommendation carries a computed primary block (got ${JSON.stringify(rec).slice(0, 200)})`).toBeTruthy();
      expect(
        typeof rec.primary.pValue === 'number' || 'significant' in rec.primary,
        'primary block carries a p-value / significance (computed, not opinion)',
      ).toBeTruthy();
      expect('powered' in rec.primary, 'primary block reports whether the test is powered (§4.2-D)').toBeTruthy();
      expect(['low', 'medium', 'high']).toContain(rec.confidence);
    } finally {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });

  // E7 — As an AI developer/operator, I want the completed experiment to show the
  // computed RECOMMENDATION and the operator's recorded DECISION side by side —
  // they may differ (recommended vs chosen), a cheap meta-signal that never lets
  // the recommendation act on its own (§4.4, INV-1).
  test('E7: recommended vs chosen — both the computed verdict and the recorded decision are shown', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    await signIn(page, adminCreds.testAdmin.email, adminCreds.testAdmin.password);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const id = `e2e-recvschosen-${Date.now()}`;

    try {
      const c = await createExperimentApi(api, premiumBlocker(id));
      expect(c.ok(), `create experiment: ${c.status()}`).toBeTruthy();

      // A little traffic so a recommendation is computable.
      for (let i = 0; i < 4; i++) {
        await createConversation(page, `RvC ${i} ${Date.now()}`, 'Premium');
        await sendAndWaitForResponse(page, `One sentence: define concept ${i}.`, 120_000);
      }

      // Record the operator's decision on close — explicitly "no_decision" (may DIFFER from the
      // computed verdict). The picker default (§3.2.1) is exercised by E5; here we drive the API to
      // pin a known chosen value for the recommended-vs-chosen comparison.
      const done = await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, {
        data: { status: 'completed', decision: { outcome: 'no_decision', note: 'e2e recommended-vs-chosen' } },
      });
      expect(done.ok(), `complete with decision: ${done.status()}`).toBeTruthy();

      // Chosen: persisted on the record.
      const rec = await getExperimentApi(api, id);
      expect(rec?.decision?.outcome, 'the chosen decision is recorded').toBe('no_decision');

      // Recommended: the computed verdict from the recommendation endpoint, kept SEPARATE from the
      // chosen decision (recommendedVsChosen, A.6) — both observable, and they may differ.
      const end = new Date();
      const start = new Date(end.getTime() - 86_400_000);
      const reco = await signedAnalyticsPost(ANALYTICS_API, idToken, {
        queryType: 'experiment_recommendation',
        experimentId: id,
        dateRange: { start: start.toISOString(), end: end.toISOString() },
      });
      expect(reco?.verdict, `a computed recommendation verdict is returned (got ${JSON.stringify(reco).slice(0, 200)})`).toBeTruthy();
      const rvc = reco?.recommendedVsChosen;
      expect(
        (rvc && 'recommended' in rvc) || (reco.verdict && rec?.decision?.outcome),
        'recommended AND chosen are both observable side by side (may differ)',
      ).toBeTruthy();
      if (rvc?.chosen) expect(rvc.chosen).toBe('no_decision');
    } finally {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });

  // ==========================================================================
  // E8 / E9 — the two experiment TYPES that had no e2e at any level.
  //
  // Four types exist (`intent`, `base_model`, `classification`, `profile`) and the suite drove two of
  // them. The two it missed are the ones that matter most to read about: `intent` is the DEFAULT type
  // (an experiment created without a type IS an intent experiment), and `profile` is Profile vs
  // Profile - the comparison that swaps a whole versioned assistant rather than one model key, and the
  // point where the experiments and portable-profiles stories meet.
  // ==========================================================================

  // E8 — As an operator, an INTENT experiment scopes to one intent, and the API refuses one that
  // names no intent (the only type with that requirement; base_model/classification/profile apply
  // across intents).
  test('E8: an intent experiment requires an intent, and persists the one it scopes to', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, adminCreds.testAdmin.email, adminCreds.testAdmin.password);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const okId = `e2e-intent-${Date.now()}`;
    const badId = `e2e-intent-bad-${Date.now()}`;

    try {
      await clearActiveExperiments(api);

      // (a) REFUSED with no intent. A type whose whole purpose is to scope to one intent must not
      //     store a row that scopes to nothing - it would resolve for no traffic and look merely idle.
      const refused = await createExperimentApi(api, {
        experimentId: badId,
        status: 'active',
        experimentType: 'intent',
        tiers: ['premium'],
        variants: [
          { variantId: 'control', modelKey: 'haiku', weight: 50 },
          { variantId: 'treatment', modelKey: 'sonnet', weight: 50 },
        ],
        objective: { metric: 'quality', target: 8, statement: 'E8: intent scoping.' },
      });
      expect(refused.ok(), 'an intent experiment with no intent was accepted').toBeFalsy();
      expect(await getExperimentApi(api, badId), 'no row may be stored for the refused create').toBeFalsy();

      // (b) ACCEPTED with one, and the intent is what round-trips.
      const created = await createExperimentApi(api, {
        experimentId: okId,
        status: 'active',
        experimentType: 'intent',
        intent: 'general_qa',
        tiers: ['premium'],
        variants: [
          { variantId: 'control', modelKey: 'haiku', weight: 50 },
          { variantId: 'treatment', modelKey: 'sonnet', weight: 50 },
        ],
        objective: { metric: 'quality', target: 8, statement: 'E8: decide the general_qa model.' },
      });
      expect(created.ok(), `create intent experiment: ${created.status()} ${await created.text()}`).toBeTruthy();

      const rec = await getExperimentApi(api, okId);
      expect(rec?.experimentType, 'the stored type is intent').toBe('intent');
      expect(rec?.intent, 'the stored row keeps the intent it scopes to').toBe('general_qa');
    } finally {
      for (const id of [okId, badId]) {
        await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      }
      await api.dispose();
    }
  });

  // E9 — As an operator, a PROFILE experiment compares two whole assistant VERSIONS. Its variants
  // carry a `profileRef` instead of a `modelKey`, and a live turn is served by one of them.
  test('E9: a Profile vs Profile experiment persists profileRef variants and serves a live turn', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, adminCreds.testAdmin.email, adminCreds.testAdmin.password);
    const idToken = await adminIdToken(page);
    const api = await bearerApi(idToken);
    const id = `e2e-profilevs-${Date.now()}`;

    try {
      await clearActiveExperiments(api);

      // Both variants name the SAME profile at (potentially) different versions - the realistic shape:
      // "does the version I just built beat the one that is live?". `version` omitted means "active".
      const created = await createExperimentApi(api, {
        experimentId: id,
        status: 'active',
        experimentType: 'profile',
        tiers: ['premium'],
        variants: [
          { variantId: 'control', profileRef: { profileName: 'premium' }, weight: 50, displayName: 'Live' },
          { variantId: 'treatment', profileRef: { profileName: 'premium' }, weight: 50, displayName: 'Candidate' },
        ],
        objective: { metric: 'quality', target: 8, statement: 'E9: decide the premium profile version.' },
      });
      expect(created.ok(), `create profile experiment: ${created.status()} ${await created.text()}`).toBeTruthy();

      // The profileRef must SURVIVE the write. If validation dropped it, resolveVariantForProfile
      // would find nothing to resolve and the experiment would quietly serve the default assistant -
      // an experiment that appears to run and compares nothing.
      const rec = await getExperimentApi(api, id);
      expect(rec?.experimentType, 'the stored type is profile').toBe('profile');
      const refs = (rec?.variants ?? []).map((v: any) => v.profileRef?.profileName);
      expect(refs, 'both variants kept their profileRef through the write').toEqual(['premium', 'premium']);

      // A live premium turn must still be SERVED while a profile experiment is active. The assertion
      // is model attribution from the turn's own metadata, not the prose: a reply that reads fine
      // proves nothing about which assistant produced it.
      const wsMonitor = new WebSocketMonitor();
      await signIn(page, adminCreds.testAdmin.email, adminCreds.testAdmin.password, wsMonitor).catch(() => {});
      await createConversation(page, `E9 profile-vs ${Date.now()}`, 'Premium');
      const reply = await sendAndWaitForResponse(page, 'In one sentence, what is a feature flag?', 180_000, wsMonitor);
      expect(reply.text.trim().length, 'a profile experiment must not stop the turn being answered')
        .toBeGreaterThan(0);
      const servedBy = String(wsMonitor.lastBotMetadata?.bedrockModel ?? wsMonitor.lastBotMetadata?.model ?? '');
      console.log(`--- E9 served by: ${servedBy || '(no attribution)'} ---`);
      expect(
        servedBy,
        'the turn carried no model attribution, so this cannot show a profile-resolved variant ran',
      ).not.toBe('');
    } finally {
      await api.post(`${EXPERIMENTS_API}/${encodeURIComponent(id)}/status`, { data: { status: 'completed' } }).catch(() => {});
      await api.dispose();
    }
  });
});
