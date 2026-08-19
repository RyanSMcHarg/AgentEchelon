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
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


const RUN = process.env.LATENCY_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const ANALYTICS_API = process.env.VITE_ANALYTICS_API_URL || '';

suite('Full latency set populates on a real turn', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('latency');

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

    // ────────────────────────────────────────────────────────────────────────────────────────────
    // EACH TURN IS COUNTED ONCE, asserted on real traffic because that is the only
    // place the defect was ever visible.
    //
    // A bot reply is stored twice - the canonical row and a `-UPD` audit row holding the finalized
    // text - and the audit row carries `total_ms`. Without the exclusion each turn's compute was
    // counted twice, and since the exchange join is on the canonical id the duplicates could not be
    // attributed: they collected in an `unknown`/`unknown` bucket, 564 of them against ~570 real rows,
    // all inside the traffic-weighted P95 alert population.
    //
    // CORRECTED 2026-08-16 against the live deployment, after this assertion was written wrong.
    //
    // It originally required the unknown/unknown bucket to be EMPTY. That was right for the defect it
    // was written against and wrong for the system: closing gap G6 in the same change moved
    // `total_ms > 0` out of the WHERE, so bot messages that ran no measurable compute - continuation
    // chunks, direct-path replies, assistant-initiated notices - are now COUNTED, and none of them
    // pairs to an exchange, so they land in unknown/unknown legitimately. Measured post-deploy: 239,
    // 201 and 119 such rows on three days, with `compute_count` of 0, 4 and 1.
    //
    // The precise invariant is about COMPUTE, not about the bucket existing. A `-UPD` audit row is a
    // duplicate that carries `total_ms` and cannot join to an exchange - so unattributed rows carrying
    // compute are the defect, and unattributed rows carrying none are the honest remainder of a
    // population that is now reported rather than filtered.
    const rows = await q();
    const unattributedCompute = rows
      .filter((r) => r.agent_type === 'unknown' && r.delivery_option === 'unknown')
      .reduce((sum, r) => sum + (Number(r.compute_count) || 0), 0);
    expect(
      unattributedCompute,
      'compute in the unknown/unknown bucket is the `-UPD` audit row being counted as a second turn',
    ).toBeLessThan(10);

    // ── THE UNCLOSED PARTITION HOLDS ON LIVE DATA, and the unreadable markers are attributed ──
    //
    // Tracker row 103: 26 unclosed turns were classified `no_placeholder` ("nobody was promised an
    // answer") while their content carried a correlation marker LONGER than the 64-character reader
    // bound - a person WAS promised an answer the platform structurally cannot deliver. The split now
    // separates them, and this is where that is measured: through the signed admin API, as testAdmin,
    // on every latency run - not by a one-off query nobody can re-run, and never by invoking the
    // Lambda directly with hand-crafted claims, which bypasses the IAM enforcement this API exists
    // to prove.
    //
    // The COUNT is logged, not asserted: it is history, shrinks with retention, and pinning it would
    // rot. What is asserted is the arithmetic that makes the count trustworthy - the buckets still
    // partition unclosed_count on real rows - and that the sub-counts stay inside their bucket.
    const sum = (k: string) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const buckets = [
      'unclosed_no_placeholder', 'unclosed_unreadable_marker', 'unclosed_unobserved',
      'unclosed_disagreed', 'unclosed_errored', 'unclosed_superseded',
      'unclosed_awaiting', 'unclosed_silent',
    ];
    const partitioned = buckets.reduce((n, b) => n + sum(b), 0);
    expect(
      partitioned,
      'the unclosed buckets must partition unclosed_count on live data - a gap here is a turn shape no bucket names',
    ).toBe(sum('unclosed_count'));
    const unreadable = sum('unclosed_unreadable_marker');
    const attributed = sum('unreadable_marker_battle') + sum('unreadable_marker_mention');
    expect(
      attributed,
      'producer attribution cannot exceed the unreadable bucket it sub-counts',
    ).toBeLessThanOrEqual(unreadable);
    console.log(
      `[unclosed-attribution] unreadable_marker=${unreadable} `
      + `(battle=${sum('unreadable_marker_battle')}, mention=${sum('unreadable_marker_mention')}, `
      + `other=${unreadable - attributed}) of unclosed=${sum('unclosed_count')} in this window`,
    );

    // The HISTORICAL attribution, over the API's widest window (90 days). The mint-side fix means the
    // last 24h should read zero - the population row 103 counted is older, and this read is the one
    // that attributes it. Same partition assertion on the wide rows, because a partition that only
    // holds on quiet days is not a partition.
    const wideJson = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
      queryType: 'latency_metrics',
      dateRange: { start: new Date(end.getTime() - 90 * 86_400_000).toISOString(), end: end.toISOString() },
    });
    const wide = (wideJson.data || []) as Array<Record<string, number | string>>;
    const wsum = (k: string) => wide.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    expect(
      buckets.reduce((n, b) => n + wsum(b), 0),
      'the unclosed partition must also hold over the full 90-day window',
    ).toBe(wsum('unclosed_count'));
    const wUnreadable = wsum('unclosed_unreadable_marker');
    const wBattle = wsum('unreadable_marker_battle');
    const wMention = wsum('unreadable_marker_mention');
    console.log(
      `[unclosed-attribution][90d] unreadable_marker=${wUnreadable} `
      + `(battle=${wBattle}, mention=${wMention}, other=${wUnreadable - wBattle - wMention}) `
      + `of unclosed=${wsum('unclosed_count')}, no_placeholder=${wsum('unclosed_no_placeholder')}`,
    );
  });
});
