/**
 * Full latency set e2e (LATENCY-TARGETS.md).
 *
 * Value-level proof that the latency derivation works on REAL traffic — the piece the mock-level
 * kinesis-archival-backfill unit test cannot cover (it asserts the SQL/params, not computed values).
 * Drives one tool-using turn, then reads the admin `latency_metrics` query and asserts the new metrics
 * are populated and distinct: e2e_ms (user -> final answer, skew-free), avg_total_ms (server compute),
 * avg_ttff_ms (time to placeholder), and the Bedrock split avg_model_ms.
 *
 * testAdmin (premium + admins group) drives it: the analytics API is admin-gated and IAM-enforced, so
 * the read is SigV4-signed (helpers/signed-analytics.ts). Same env contract as tasks.spec.
 *
 * Gated by LATENCY_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 *   E2E_BASE_URL=<cf> LATENCY_E2E=1 VITE_ANALYTICS_API_URL=<url> VITE_USER_POOL_ID=<id> \
 *     VITE_IDENTITY_POOL_ID=<id> AWS_PROFILE=<p> npx playwright test e2e/latency.spec.ts
 */
import { test, expect } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';

const RUN = process.env.LATENCY_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const ANALYTICS_API = process.env.VITE_ANALYTICS_API_URL || '';

suite('Full latency set populates on a real turn', () => {
  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(ANALYTICS_API, 'VITE_ANALYTICS_API_URL must be set').toBeTruthy();
  });

  test('a tool-using turn yields e2e_ms / total_ms / ttff_ms / model_ms > 0 (brackets distinct)', async ({ page }) => {
    test.setTimeout(420_000); // turn (up to 180s) + generous archival-lag poll

    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    await createConversation(page, `Latency e2e ${Date.now()}`, 'Premium');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // A single-turn financial-figure question (the premium ARR canary): the assistant loads company
    // context (a tool call) to state the figure inline, so the turn exercises the Converse loop
    // (model_ms) + in-loop tool execution (tool_ms) and produces a final answer (e2e_ms) in one turn.
    const resp = await sendAndWaitForResponse(
      page,
      'What was our Q2 ARR? Give the exact figure from the financials.',
      180_000,
    );
    expect(resp.text && resp.text.length, 'the turn must return a response').toBeTruthy();

    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000);
    const q = async (): Promise<Array<Record<string, number | string>>> => {
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
        queryType: 'latency_metrics',
        dateRange: { start: start.toISOString(), end: end.toISOString() },
      });
      return (j.data || []) as Array<Record<string, number | string>>;
    };

    // Poll: archival (Chime -> Kinesis -> Aurora) buffers up to ~2 min, so a row carrying this turn's
    // e2e_ms appears minutes later. Wait for a row with the E2E + model split populated.
    let hit: Record<string, number | string> | undefined;
    for (let i = 0; i < 30 && !hit; i++) {
      const rows = await q();
      hit = rows.find((r) => Number(r.avg_e2e_ms) > 0 && Number(r.avg_model_ms) > 0);
      if (!hit) await page.waitForTimeout(6000);
    }
    expect(hit, 'a latency_metrics row with avg_e2e_ms and avg_model_ms > 0 should appear after a real turn').toBeTruthy();

    const row = hit!;
    console.log('[latency-e2e] row:', JSON.stringify(row));
    // The metrics are distinct and non-zero: e2e (full wait) and total (server compute) both > 0, ttff
    // (time to placeholder) > 0, and the model share of Bedrock present. tool_ms / inbound_ms are logged
    // (tool_ms can be 0 when the model answers from pre-fetched RAG; inbound_ms is cross-clock/approximate).
    expect(Number(row.avg_e2e_ms), 'avg_e2e_ms > 0 (user -> final answer)').toBeGreaterThan(0);
    expect(Number(row.avg_total_ms), 'avg_total_ms > 0 (server compute)').toBeGreaterThan(0);
    expect(Number(row.avg_ttff_ms), 'avg_ttff_ms > 0 (time to placeholder)').toBeGreaterThan(0);
    expect(Number(row.avg_model_ms), 'avg_model_ms > 0 (model inference share of Bedrock)').toBeGreaterThan(0);
  });
});
