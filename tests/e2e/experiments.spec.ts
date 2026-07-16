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
      // 2. Drive a premium-tier conversation so a turn is assigned to a variant.
      await createConversation(page, `Exp e2e ${Date.now()}`);
      const resp = await sendAndWaitForResponse(page, 'In one sentence, what is a feature flag?');
      expect(resp.text && resp.text.length).toBeTruthy();

      // 3. The exchange should now carry this experiment_id. Poll experiment_results.
      const end = new Date();
      const start = new Date(end.getTime() - 1 * 86_400_000);
      let row: unknown | undefined;
      for (let i = 0; i < 8 && !row; i++) {
        const r = await api.post(ANALYTICS_API, {
          data: { queryType: 'experiment_results', dateRange: { start: start.toISOString(), end: end.toISOString() } },
        });
        const j = await r.json();
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
});
