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
import { test, expect, request as pwRequest } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';

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
      for (let i = 0; i < 8 && !row; i++) {
        // The analytics API is IAM-enforced (adminIamEnforcement) — sign the request with the
        // admin's Identity-Pool creds; a Bearer JWT is rejected (403).
        const j = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
          queryType: 'experiment_results', dateRange: { start: start.toISOString(), end: end.toISOString() },
        });
        row = (j.data || []).find((x: any) => x.experiment_id === draft.experimentId || x.experimentId === draft.experimentId);
        if (!row) await page.waitForTimeout(4000); // archival + pairing lag
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
      for (let i = 0; i < 12 && variants.size < 2; i++) {
        const j = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
          queryType: 'experiment_results', dateRange: { start: start.toISOString(), end: end.toISOString() },
        });
        variants = new Set(
          (j.data || [])
            .filter((x: any) => (x.experiment_id ?? x.experimentId) === draft.experimentId)
            .map(variantOf)
            .filter(Boolean),
        );
        if (variants.size < 2) await page.waitForTimeout(5000); // archival + pairing lag
      }
      expect(
        Array.from(variants).sort(),
        `both variants should appear in experiment_results for ${draft.experimentId}`,
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
});
