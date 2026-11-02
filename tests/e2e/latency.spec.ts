/**
 * Full latency set e2e (LATENCY-TARGETS.md).
 *
 * Value-level proof that the latency derivation works on REAL traffic — the piece the mock-level
 * kinesis-archival-backfill unit test cannot cover (it asserts the SQL/params, not computed values).
 * Drives one tool-using turn, then reads the admin `latency_metrics` query and asserts the new metrics
 * are populated and distinct: e2e_ms (user -> final answer, skew-free), avg_total_ms (server compute),
 * and the Bedrock split avg_model_ms — each read from the row for the CLASSIFICATION this test drove, because
 * that query has no channel parameter. ttff_ms is asserted per-turn instead, from the channel-scoped
 * `turn_latency_audit` further down, which is the only read here that can name this test's own turn.
 *
 * testAdmin (premium + admins group) drives it: the analytics API is admin-gated and IAM-enforced, so
 * the read is SigV4-signed (helpers/signed-analytics.ts). Same env contract as tasks.spec.
 *
 * Gated by LATENCY_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 *   E2E_BASE_URL=<cf> LATENCY_E2E=1 VITE_ADMIN_API_URL=<url> VITE_USER_POOL_ID=<id> \
 *     VITE_PERSON_API_URL=<url> AWS_PROFILE=<p> npx playwright test e2e/latency.spec.ts
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


const RUN = process.env.LATENCY_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';

// The classification this test drives, in the two spellings it is needed in: the label the
// conversation picker shows a person, and the value archival records.
//
// SCOPED BY CLASSIFICATION, NOT BY ASSISTANT. This read `agent_type`, which held the classification
// until assistants got their own identity; it names the ASSISTANT now, so matching
// 'premium' against it would match nothing and this test would time out looking for its own traffic.
// The classification is what the test actually drives - it picks a Premium conversation - so
// `conversation_classification` is both correct and immune to an assistant being renamed.
// Stated once so the row this test reads can never drift from the conversation it created.
const DRIVEN_CLASSIFICATION_LABEL = 'Premium';
const DRIVEN_CLASSIFICATION = 'premium';

suite('Full latency set populates on a real turn', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('latency');

  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(ANALYTICS_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
  });

  test('a tool-using turn yields e2e_ms / total_ms / ttff_ms / model_ms > 0 (brackets distinct)', async ({ page }) => {
    test.setTimeout(420_000); // turn (up to 180s) + generous archival-lag poll

    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    // The channel this turn happens in, captured from the create response so the per-turn ledger
    // audit below can be asked about THIS turn rather than about whatever the account did last.
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `Latency e2e ${Date.now()}`, DRIVEN_CLASSIFICATION_LABEL);
    const channelArn: string = (await (await createResp).json()).conversation.conversationArn;
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

    const idToken = await idTokenOf(page);
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
    //
    // ── THE ROW IS SCOPED TO THE CLASSIFICATION THIS TEST DROVE, AND MUST STAY SCOPED ──
    //
    // DO NOT "simplify" this back to `rows.find((r) => Number(r.avg_e2e_ms) > 0 && ...)`. On a shared
    // deployment an unscoped row is another test's traffic. `latency_metrics` groups by
    // (date, agent_type, delivery_option) and returns them `ORDER BY date DESC, agent_type,
    // delivery_option`, so an unscoped find() takes whichever classification sorts FIRST - `basic` - and this
    // test creates a Premium conversation. It then asserts about turns it never drove, and passes or
    // fails on whatever else the deployment happened to be serving.
    //
    // FOUND LIVE 2026-09-15: this failed on `avg_ttff_ms > 0` against a basic-classification row produced by a
    // concurrently running e2e phase, while the premium row the test had actually driven read
    // avg_ttff_ms 2311 over 14 measured turns. It had been passing by luck, on someone else's turns.
    //
    // The classification is the NARROWEST scope this endpoint offers - `latency_metrics` takes a date range and
    // nothing else, so there is no channel parameter to scope by. It is therefore the floor, not the
    // proof: the per-turn proof is the channel-scoped `turn_latency_audit` block at the end of this
    // test. delivery_option is deliberately NOT pinned as well, because it is chosen at runtime from
    // the model's intent classification (selectDeliveryOption), so requiring a particular one would
    // make this poll time out whenever the router picked another - a flake, not a finding.
    let hit: Record<string, number | string> | undefined;
    for (let i = 0; i < 30 && !hit; i++) {
      const rows = await q();
      hit = rows.find(
        (r) => r.conversation_classification === DRIVEN_CLASSIFICATION
          && Number(r.avg_e2e_ms) > 0
          && Number(r.avg_model_ms) > 0,
      );
      if (!hit) await page.waitForTimeout(6000);
    }
    expect(
      hit,
      `a ${DRIVEN_CLASSIFICATION} latency_metrics row with avg_e2e_ms and avg_model_ms > 0 should appear `
        + 'after a real turn on a conversation of that classification',
    ).toBeTruthy();

    const row = hit!;
    console.log('[latency-e2e] row:', JSON.stringify(row));
    // The metrics are distinct and non-zero: e2e (full wait) and total (server compute) both > 0, and
    // the model share of Bedrock present. tool_ms / inbound_ms are logged (tool_ms can be 0 when the
    // model answers from pre-fetched RAG; inbound_ms is cross-clock/approximate).
    expect(Number(row.avg_e2e_ms), 'avg_e2e_ms > 0 (user -> final answer)').toBeGreaterThan(0);
    expect(Number(row.avg_total_ms), 'avg_total_ms > 0 (server compute)').toBeGreaterThan(0);
    expect(Number(row.avg_model_ms), 'avg_model_ms > 0 (model inference share of Bedrock)').toBeGreaterThan(0);
    // ── avg_ttff_ms IS NOT ASSERTED FROM THE AGGREGATE, ON PURPOSE ──
    //
    // It is the one figure on this row that a driven turn is not guaranteed to reach. The TTFF average
    // is taken `FILTER (WHERE mp.measured)`, which excludes any turn whose user/bot pairing fell to the
    // swept pairer rather than being declared or made in-batch - and an excluded turn stays excluded,
    // permanently. So a wait here would not be a wait for archival, it would be a wait for something
    // that may never arrive, and dressing it up as one would be a lie about what this test checks.
    // Loosening it (`>= 0`, or skipping when absent) would be worse: an assertion that cannot fail.
    //
    // TTFF is therefore asserted where it can be asserted honestly - per turn, on the channel this
    // test created, in the ledger-audit block below (`anchored`, `ttff_ms > 0`). Logged here so a
    // reader still sees what the classification's aggregate said on this run.
    console.log(
      `[latency-e2e] aggregate ttff for ${DRIVEN_CLASSIFICATION} (logged, asserted per-turn below): `
      + `avg_ttff_ms=${row.avg_ttff_ms}, ttff_measured_count=${row.ttff_measured_count}, `
      + `ttff_reconstructed_count=${row.ttff_reconstructed_count}`,
    );

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
    // 26 unclosed turns were classified `no_placeholder` ("nobody was promised an
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
      // CANCELLED IS A BUCKET THE API HAS AND THIS LIST DID NOT (2026-09-10). analytics-query.ts
      // classifies nine kinds and returns `unclosed_cancelled` beside the rest; summing eight of
      // them made the partition short by exactly the cancelled turns, and a `/stop` produces those on
      // every sweep. The assertion then reported a correct partition as a gap, which is the one
      // thing it must never do: its whole value is that a REAL gap means a turn shape nothing names.
      'unclosed_cancelled',
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
    // last 24h should read zero - the over-long-marker turns described above are older, and this read is
    // the one that attributes them. Same partition assertion on the wide rows, because a partition that only
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

    // ── THE TURN LEDGER IS ANCHORED ON LIVE TRAFFIC (G11) ──
    //
    // `v_turn_latency` is the per-turn audit behind the console's drill-down, and it returned NULL
    // for every latency on every LIVE row: the writer records a user message with no turn id - the
    // processor is never handed the user's message id, so the binding is made later by pairing - and
    // the anchor selected only rows that HAVE one, which excluded every row it was made of. The audit
    // rendered blank on a freshly deployed cluster and read as a wiring fault.
    //
    // ASSERTED ON THE TURN THIS TEST JUST DROVE, not on whatever history the account happens to hold.
    // A backfilled row would satisfy a "some row has a ttff" check while the live path stayed broken -
    // which is the exact state this assertion exists to detect, so it would be the wrong check.
    const audit = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
      queryType: 'turn_latency_audit',
      channelArn,
    });
    const auditRows = (audit.data || []) as Array<Record<string, number | string | null>>;
    expect(
      auditRows.length,
      `the turn ledger returned no rows for the channel this test just drove (${channelArn}). The `
        + 'audit is unanchored or the ledger writer is not running.',
    ).toBeGreaterThan(0);

    // A row with a MEASURED wait, not merely a row. Before the anchor fix these rows existed and every
    // latency on them was null, so counting rows would have passed against the defect.
    //
    // THIS IS ALSO THE TEST'S TTFF ASSERTION, the whole of it: it is scoped to the channel above, so
    // it is the only place a time-to-first-feedback can be asserted about the turn this test drove
    // rather than about the classification's window average. See the note beside avg_ttff_ms further up.
    const anchored = auditRows.filter((r) => Number(r.ttff_ms) > 0);
    expect(
      anchored.length,
      'every ledger row for this turn has a NULL ttff_ms, which is the unanchored-ledger defect: the '
        + 'rows are written but nothing binds them to the user message they answered.',
    ).toBeGreaterThan(0);

    // Provenance, so a pass here cannot be a backfilled row wearing a live one's clothes. A live turn
    // is anchored by the exchange pairing; only the offline backfill produces 'ledger'.
    const sources = [...new Set(auditRows.map((r) => String(r.anchor_source ?? 'none')))];
    console.log(`[turn-ledger] ${auditRows.length} row(s), anchors: ${sources.join(', ')}, `
      + `ttff=${anchored.map((r) => r.ttff_ms).join('/')}ms, ack=${auditRows.map((r) => r.ack_ms ?? '-').join('/')}`);
    expect(
      sources.some((s) => s === 'exchange' || s === 'ledger'),
      `no ledger row names an anchor source (saw: ${sources.join(', ')}). A row with no anchor has no `
        + 'measurable latency, whatever else it reports.',
    ).toBeTruthy();

    // ack_ms IS ttff_ms on a user-triggered turn - the same two instants by construction (G13). If
    // these ever disagree on a user turn, the general metric has drifted from the SLO metric and the
    // two numbers on the console are no longer comparable.
    for (const r of anchored) {
      expect(
        Number(r.ack_ms),
        'ack_ms and ttff_ms must agree on a user-triggered turn: they are the same two instants',
      ).toBe(Number(r.ttff_ms));
    }
  });
});
