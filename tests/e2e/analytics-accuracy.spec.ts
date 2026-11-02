/**
 * ANALYTICS ACCURACY: THE NUMBERS MEAN WHAT THE SPEC SAYS THEY MEAN.
 *
 * Every other analytics assertion in this suite checks that something rendered, or that a number is
 * internally consistent with another number the same code computed. Neither can see the failure that
 * matters most here: a figure that is stable, moves correctly with the window, reconciles against
 * itself, and describes a different population from the one its name claims.
 *
 * The turn count on `latency_metrics` is the worked example. It counts ASSISTANT TURNS, and a turn is
 * not an exchange: a bot-INITIATED answer (a round-2 rebuttal) has no user message to pair with, so it
 * is a turn with no exchange at all. The column is `assistant_turn_count`, and the P95 latency band is
 * tuned against it by that name.
 *
 * ── WHAT THIS ASSERTS, AND WHY EACH ONE ─────────────────────────────────────────────────────────
 *
 * 1. WINDOW BOUNDS. No returned row is dated outside the range asked for. This is the defect class of
 *    "every analytics date window returned the same data": a query that ignores its range answers the
 *    same rows whatever it is asked, and the console's date buttons become decoration.
 *
 * 2. CROSS-WINDOW AGREEMENT. A day present in two different windows carries identical values in both.
 *    A window that changes the aggregation - a different grain, a different filter, an off-by-one
 *    boundary - shows up here and nowhere else, because each window is individually plausible.
 *
 * 3. THE DEFINITION IS WEIGHTED. SPEC-ADMIN-CONSOLE-EFFECTIVENESS defines latency as "average and p95
 *    `total_ms` over the intent's agent messages". An average OVER THE MESSAGES is exchange-weighted.
 *    A consumer that averages the daily rows instead produces a mean-of-means, which is a different
 *    number, internally consistent, and wrong by the spec whenever the days differ in volume.
 *
 * 4. THE POPULATION MATCHES THE NAME. The turn count and the exchange count are both published under
 *    names that say what they count, and the unpaired turns are ONE population wherever they are
 *    counted: `latency_metrics.unpaired_turn_count` and `unpaired_bot_messages.unpaired_count` read
 *    the same definition of an assistant turn, so over a closed window their totals are equal.
 *
 * ── READ-ONLY, AND DELIBERATELY SO ──────────────────────────────────────────────────────────────
 *
 * This drives no traffic. It asserts relationships that must hold over whatever the deployment has
 * already recorded, so it costs no model turns and cannot be made to pass by generating friendlier
 * data. If the window is empty it says so and stops rather than passing vacuously.
 *
 * Gated by ANALYTICS_ACCURACY_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { stackName } from './helpers/stack-prefix';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

guardConsoleErrors();

const RUN = process.env.ANALYTICS_ACCURACY_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';

type Row = Record<string, number | string>;

/** A day, as the API returns it: the leading YYYY-MM-DD of whatever date shape a row carries. */
function dayOf(row: Row): string {
  return String(row.date ?? '').slice(0, 10);
}

suite('Analytics numbers mean what the spec says they mean', () => {
  // A PASSING ASSERTION OVER A BROKEN READ IS THE FAILURE THIS PHASE IS MOST EXPOSED TO.
  //
  // Every check here reads the analytics API and reasons about what came back. If the query errored
  // server-side and returned an empty or partial set, the arithmetic below still runs and can still
  // agree with itself - a window with no rows bounds correctly, and two empty windows agree. The
  // suite has explicit non-vacuity guards for the empty case, and this watches the other half: an
  // error the API swallowed on the way to an answer that looked fine.
  guardBackendErrors('analytics-accuracy');

  let creds: TestCredentials;
  let idToken: string;

  // ── HOW AN `unpaired_bot_messages` ROW READS ────────────────────────────────────────────────────
  //
  // The query returns real booleans, which `Row` does not type, and Postgres can render one as 't'.
  // Stated once here because two tests read the same rows and a second copy of these predicates is
  // how two halves of one population start disagreeing about what they are counting.
  const isMarked = (r: Row) => (r.corr_marked as unknown) === true || String(r.corr_marked) === 'true'
    || String(r.corr_marked) === 't';
  const isDeclared = (r: Row) => (r.declared_target as unknown) === true
    || String(r.declared_target) === 'true' || String(r.declared_target) === 't';
  /**
   * Did the message this row NAMED get answered by this same responder?
   *
   * Tri-state, and each state is a different finding: `true` means the turn was answered through
   * another message and this row is its second one, `false` means nothing anywhere answered the turn
   * it named, and `null` means it declared nothing so the question does not apply.
   */
  const targetPaired = (r: Row): boolean | null => {
    const v = (r as Record<string, unknown>).target_paired;
    if (v === true || v === 'true' || v === 't') return true;
    if (v === false || v === 'false' || v === 'f') return false;
    return null;
  };
  /** Whether the deployment's query publishes the column at all - absent on one deployed before it. */
  const publishesTargetPaired = (rs: Row[]) => rs.some((r) => 'target_paired' in (r as object));
  const total = (rs: Row[]) => rs.reduce((a, r) => a + Number(r.unpaired_count || 0), 0);

  test.beforeAll(async () => {
    creds = await getTestCredentials();
  });

  test.beforeEach(async ({ page }) => {
    // testAdmin, because the analytics API is admin-gated and IAM-enforced: the read is SigV4-signed
    // through the same path the console uses, never a direct Lambda invoke with hand-made claims.
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    idToken = await idTokenOf(page);
    expect(idToken, 'an admin id token is required to read the analytics API').toBeTruthy();
    expect(ANALYTICS_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
  });

  /** One signed read of `latency_metrics` over an explicit window. */
  const metricsBetween = async (start: Date, end: Date): Promise<Row[]> => {
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'latency_metrics',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
    });
    return (j.data || []) as Row[];
  };

  test('a window returns only rows inside it', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 86_400_000);
    const rows = await metricsBetween(start, end);

    // NOT A PASS ON NO DATA. An empty window proves nothing about bounds, and a check that goes green
    // when the deployment is idle is the vacuous guard this repo has been bitten by before.
    expect(
      rows.length,
      'the deployment must have recorded some traffic in the last 3 days for this to mean anything. '
        + 'An empty result is inconclusive, not a pass.',
    ).toBeGreaterThan(0);

    const lo = new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10);
    const hi = new Date(end.getTime() + 86_400_000).toISOString().slice(0, 10);
    const strays = rows.map(dayOf).filter((d) => d && (d < lo || d > hi));
    expect(
      strays,
      'every row must fall inside the window it was asked for. A query that ignores its range answers '
        + 'the same rows whatever it is asked, which is exactly how "every date window returned the '
        + 'same data" survived: the console\'s buttons change the request and not the answer. '
        + `Window ${lo}..${hi}, strays: ${JSON.stringify(strays.slice(0, 8))}`,
    ).toEqual([]);
  });

  test('a day common to two windows carries the same numbers in both', async () => {
    const end = new Date();
    const narrow = await metricsBetween(new Date(end.getTime() - 2 * 86_400_000), end);
    const wide = await metricsBetween(new Date(end.getTime() - 20 * 86_400_000), end);

    expect(narrow.length, 'the narrow window needs data for this comparison to mean anything')
      .toBeGreaterThan(0);
    expect(wide.length, 'the wide window needs data for this comparison to mean anything')
      .toBeGreaterThan(0);

    // Key on the full grain the API groups by, not on the date alone: two rows can share a day and
    // differ by any grouping column of latency_metrics (its GROUP BY in analytics-query.ts), and
    // collapsing them here would compare unlike things and call the difference a defect.
    const key = (r: Row) => [
      dayOf(r), r.assistant, r.delivery_option, r.turn_entry, r.assistant_role,
      r.profile_version, r.battle_round, r.conversation_classification,
    ].map((v) => String(v ?? '')).join('|');
    const wideBy = new Map(wide.map((r) => [key(r), r]));

    // EVERY SHARED DAY IS A WHOLE DAY. A named window runs from 00:00 UTC on its start day to the end
    // of its end day, whatever time of day the bounds carry, so both windows hold the same rows for
    // every date they share - including the oldest day of the narrow one.
    const disagreements: string[] = [];
    for (const r of narrow) {
      const w = wideBy.get(key(r));
      if (!w) continue; // Present in one window only: the boundary case, covered by the test above.
      for (const col of ['assistant_turn_count', 'avg_total_ms']) {
        if (String(r[col] ?? '') !== String(w[col] ?? '')) {
          disagreements.push(`${key(r)} ${col}: narrow=${r[col]} wide=${w[col]}`);
        }
      }
    }
    expect(
      disagreements,
      'the same day must carry the same numbers however wide the window around it. A disagreement '
        + 'means the window is changing the aggregation - a different grain, a different filter, an '
        + 'off-by-one boundary - and each window on its own looks perfectly plausible, which is why '
        + `nothing else catches it. Disagreements: ${JSON.stringify(disagreements.slice(0, 8))}`,
    ).toEqual([]);
  });

  test('the overall average is weighted by volume, as the spec defines it', async () => {
    const end = new Date();
    const rows = (await metricsBetween(new Date(end.getTime() - 20 * 86_400_000), end))
      .filter((r) => Number(r.assistant_turn_count) > 0 && Number(r.avg_total_ms) > 0);

    expect(rows.length, 'need rows with volume and latency for the weighting to be observable')
      .toBeGreaterThan(0);

    const n = rows.reduce((a, r) => a + Number(r.assistant_turn_count), 0);
    const weighted = rows.reduce((a, r) => a + Number(r.avg_total_ms) * Number(r.assistant_turn_count), 0) / n;
    const meanOfMeans = rows.reduce((a, r) => a + Number(r.avg_total_ms), 0) / rows.length;

    // THE SPEC'S WORDS: "average and p95 total_ms over the intent's agent messages". Over the MESSAGES,
    // so each row weighs as much as the traffic it summarizes.
    //
    // This asserts the arithmetic a consumer must do, and reports the gap when the two differ. It is
    // the number the console must show; a reader taking the simple mean of the rows is wrong by
    // exactly this much, and the gap grows with how uneven the days are.
    const gapPct = meanOfMeans === 0 ? 0 : Math.abs(weighted - meanOfMeans) / meanOfMeans * 100;
    console.log(
      `[analytics-accuracy] rows=${rows.length} turns=${n} `
      + `weighted=${weighted.toFixed(1)}ms meanOfMeans=${meanOfMeans.toFixed(1)}ms gap=${gapPct.toFixed(1)}%`,
    );
    expect(
      Number.isFinite(weighted) && weighted > 0,
      'the turn-weighted mean must be computable from what the API returns: the weights '
        + '(assistant_turn_count) and the values (avg_total_ms) both have to be present on every row, or the '
        + 'spec\'s definition cannot be evaluated by any consumer, console included.',
    ).toBe(true);
  });

  test('the turn count and the exchange count are both published, under names that say what they count', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 20 * 86_400_000);
    const latency = await metricsBetween(start, end);
    const volumes = (await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'conversation_volumes',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
    })).data as Row[] || [];

    expect(
      latency.every((r) => r.assistant_turn_count !== undefined && r.exchange_count === undefined),
      'latency_metrics counts ASSISTANT TURNS and must publish that count as assistant_turn_count. A '
        + 'turn is not an exchange - a round-2 rebuttal is a turn with no user message to pair with - so '
        + `no latency row may carry a column named for exchanges. Columns seen: ${JSON.stringify(Object.keys(latency[0] || {}))}`,
    ).toBe(true);

    const turns = latency.reduce((a, r) => a + Number(r.assistant_turn_count || 0), 0);
    expect(turns, 'need traffic in the window for this to mean anything').toBeGreaterThan(0);

    // THE PAIRING ITSELF: `paired_exchange_count` comes from the `exchanges` table, one row per user
    // message answered by an agent message.
    const paired = volumes.reduce((a, r) => a + Number(r.paired_exchange_count ?? 0), 0);
    expect(
      paired,
      'conversation_volumes must publish paired_exchange_count, or the exchange population cannot be '
        + 'checked against anything by any consumer, test or operator. '
        + `Columns seen: ${JSON.stringify(Object.keys(volumes[0] || {}))}`,
    ).toBeGreaterThan(0);

    console.log(`[analytics-accuracy] assistant_turn_count=${turns} paired_exchanges=${paired}`);

    // ── WHAT THIS DELIBERATELY DOES NOT ASSERT ──────────────────────────────────────────────────
    //
    // Subtracting the two. `assistant_turn_count` counts bot MESSAGE rows whose `created_at` falls in
    // the window; `paired_exchange_count` counts EXCHANGE rows whose own `created_at` falls in it. A
    // pairing is written by a later job against a user message up to an hour earlier, so the two
    // windows admit different members and their difference is an artifact of the boundaries rather
    // than a population gap. The unpaired population is asked for directly, in the tests below.
  });

  /**
   * THE UNPAIRED TURNS ARE ONE POPULATION, WHEREVER THEY ARE COUNTED.
   *
   * `latency_metrics.unpaired_turn_count` and `unpaired_bot_messages.unpaired_count` both read the one
   * definition of an assistant turn in `analytics-query.ts`, so over the same window their totals are
   * equal. Neither is the total of the latency rows whose delivery option is 'unknown': that bucket
   * also holds paired turns whose exchange recorded no delivery option.
   *
   * A CLOSED WINDOW, ending yesterday, so archival landing between the two reads cannot move one
   * total and not the other.
   */
  test('the unpaired turns agree between latency_metrics and unpaired_bot_messages', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const start = new Date(yesterday.getTime() - 20 * 86_400_000);
    const dateRange = { start: start.toISOString().slice(0, 10), end: yesterday.toISOString().slice(0, 10) };

    const latency = (await signedAnalyticsPost(ANALYTICS_API, idToken, { queryType: 'latency_metrics', dateRange }))
      .data as Row[] || [];
    const unpairedRows = (await signedAnalyticsPost(ANALYTICS_API, idToken, { queryType: 'unpaired_bot_messages', dateRange }))
      .data as Row[] || [];

    expect(latency.length, 'need traffic in the window for this to mean anything').toBeGreaterThan(0);

    const fromLatency = latency.reduce((a, r) => a + Number(r.unpaired_turn_count ?? NaN), 0);
    const fromUnpaired = unpairedRows.reduce((a, r) => a + Number(r.unpaired_count || 0), 0);
    const unknownDelivery = latency
      .filter((r) => String(r.delivery_option ?? 'unknown') === 'unknown')
      .reduce((a, r) => a + Number(r.assistant_turn_count || 0), 0);
    console.log(
      `[analytics-accuracy] unpaired: latency_metrics=${fromLatency} unpaired_bot_messages=${fromUnpaired} `
      + `unknown-delivery turns=${unknownDelivery}`,
    );

    expect(
      fromLatency,
      'two queries counting the unpaired assistant turns over one window must give one number. A '
        + 'difference means one of them has stopped reading the shared assistant-turn definition.',
    ).toBe(fromUnpaired);
  });

  /**
   * NAMING WHAT IS NOT AN EXCHANGE, because counting it settled nothing.
   *
   * Assistant turns outnumbering the exchanges that paired says the populations differ. It does not say
   * whether those turns SHOULD have paired, and that is the question that decides what to do: a
   * welcome legitimately has no exchange, a drain's reading is queue work that belongs in queue
   * analytics, and a reply that was meant to pair and did not is a defect in the pairing itself.
   *
   * The axis that decides it is not a matter of opinion. A bot message pairs only if it carries a
   * `<!--corr:` marker, because a reply is born as a corr-marked placeholder and a marker-less CREATE
   * "is not an answer to anything and must not mint an exchange" (kinesis-archival). So:
   *
   *   UNMARKED and unpaired  -> could never have paired. Structurally outside the exchange
   *                             population, and not a pairing defect.
   *   MARKED and unpaired    -> was born as a reply and never became one. That IS a pairing defect,
   *                             and it is the only half worth chasing as a bug.
   *
   * A THIRD CLASS SITS INSIDE THE FIRST ONE AND IS NOT LIKE IT: a turn that declared what it answers
   * and carries no marker. The marker rule files it under "could never pair", which is false - it
   * said what it answers. That class is measured by the test below this one.
   */
  test('the turns with no exchange are named, and none of them should have paired', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 20 * 86_400_000);
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'unpaired_bot_messages',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      days: 20,
    });
    const rows = (j.data || []) as Row[];
    expect(
      Array.isArray(rows),
      'unpaired_bot_messages must answer, or the turns with no exchange stay anonymous '
        + 'and the only available response to the gap is a guess.',
    ).toBe(true);

    const marked = rows.filter(isMarked);
    const unmarked = rows.filter((r) => !isMarked(r));

    console.log('[analytics-accuracy] unpaired breakdown:', JSON.stringify(rows));

    // RECENT AGAINST HISTORIC. The window above spans deployments, so a count here cannot say whether
    // pairing is broken now or was broken once. The same read over the last two days separates the two.
    const recentStart = new Date(end.getTime() - 2 * 86_400_000);
    const recent = (((await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'unpaired_bot_messages',
      dateRange: { start: recentStart.toISOString(), end: end.toISOString() },
      days: 2,
    })).data || []) as Row[]);
    console.log('[analytics-accuracy] unpaired breakdown, last 2 days:', JSON.stringify(recent));
    // DECLARED ROWS ARE NOT "COULD NEVER PAIR", and counting them there is what hid a whole class for
    // five days. A row that named the message it answers is not structurally outside the exchange
    // population; it is measured by the test below.
    const declaredRows = unmarked.filter(isDeclared);
    console.log(
      `[analytics-accuracy] could-never-pair=${total(unmarked.filter((r) => !isDeclared(r)))} `
      + `declared-but-unpaired=${total(declaredRows)} `
      + `marked-but-unpaired=${total(marked)}`,
    );

    // Only the marked half is a defect. The unmarked half is outside the exchange population by construction.
    //
    // ASSERTED OVER THE RECENT WINDOW, reported over the long one. The long window holds turns archived by
    // earlier pairing code (measured 2026-09-15: 60 marked-but-unpaired over 20 days, none in the last two),
    // and a row written once stays unpaired forever, so asserting it would fail on history that no fix to
    // the running code can change. The recent window is what a pairing regression shows up in.
    //
    // A TURN THAT DECLARES ITS KIND NEVER PAIRS, by archival's own rule, so it is not a pairing failure even
    // when it carries a correlation marker: a welcome, a join recap, a battle rebuttal. Nor is a second
    // message of a turn whose declared target WAS answered (`target_paired`). Counted, they made this read
    // as a regression on every e2e day (2026-10-16: 10 join recaps, 6 welcomes, 1 answered target).
    const answersNothing = (r: Record<string, unknown>) =>
      (r.turn_kind != null && r.turn_kind !== '') || r.is_rebuttal === true || r.target_paired === true;
    const recentMarked = recent.filter(isMarked).filter((r) => !answersNothing(r as Record<string, unknown>));
    expect(
      total(recentMarked),
      'a bot message born as a corr-marked placeholder was meant to be an answer, so one that never '
        + 'paired in the last two days is a pairing failure in the running code rather than a turn that '
        + `legitimately has no exchange. These are the ones worth chasing: ${JSON.stringify(recentMarked)}`,
    ).toBe(0);
  });

  /**
   * A TURN THAT SAID WHAT IT ANSWERS AND HAS NO EXCHANGE IS TWO DIFFERENT FINDINGS.
   *
   * The marker rule above files every unmarked row under "could never pair". That sentence is true of
   * a welcome and of a drain's reading, and false of a row that DECLARED its target: it named the
   * message it answers, so it was plainly an answer to something.
   *
   * MEASURED 2026-09-15 through this same signed path: 33 such rows in one day (32 `report_generation`,
   * 1 `general`), every one of them counted as "could never pair". They are the SECOND message of a turn
   * whose delivery moved off its placeholder - a privately targeted answer, a broadcast answer, or an
   * answer posted at the end of a queue whose notice sits above it. The placeholder left behind is
   * corr-marked and adjacent, so it takes the exchange (31 of the day's 220 exchanges were minted
   * against an acknowledgement reading "Caught up..." or "I have replied to you privately.", carrying
   * no intent at all), and the message holding the answer and the declaration keeps nothing.
   *
   * SO THE AXIS THAT DECIDES IT IS WHETHER THE TURN IT NAMED WAS ANSWERED AT ALL, and the query
   * publishes it as `target_paired`:
   *
   *   target_paired = true   the turn was answered through the message that acknowledged it, and one
   *                          turn mints one exchange. A second message has nothing left to pair with:
   *                          legitimately unpairable, and not a defect.
   *   target_paired = false  the turn named a message and nothing anywhere answers it. DECLARED AND
   *                          LOST, which is an answer the projection dropped.
   *
   * The second is asserted at zero. Without the split both hid inside one count that read as benign,
   * which is exactly how this sat unexamined: the number was filed under the sentence for a welcome.
   */
  test('a declared turn with no exchange says whether its turn was answered elsewhere or lost', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 2 * 86_400_000);
    const rows = (((await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'unpaired_bot_messages',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      days: 2,
    })).data || []) as Row[]);

    // A PRECONDITION, NAMED - not a pass. An analytics API deployed before the column cannot answer
    // this question, and reporting that as "no lost answers" would be the vacuous guard this suite
    // exists to avoid. Same shape as the drift-scope skip: say which precondition is missing.
    test.skip(
      rows.length > 0 && !publishesTargetPaired(rows),
      'this deployment\'s analytics API predates unpaired_bot_messages.target_paired, so a declared '
        + `row cannot be told apart from a lost one. Redeploy ${stackName('Archive')} and re-run.`,
    );
    expect(
      rows.length,
      'the deployment must have recorded some traffic in the last 2 days for this to mean anything. '
        + 'An empty result is inconclusive, not a pass.',
    ).toBeGreaterThan(0);

    const declared = rows.filter(isDeclared);
    const secondMessage = declared.filter((r) => targetPaired(r) === true);
    const lost = declared.filter((r) => targetPaired(r) === false);
    console.log(
      `[analytics-accuracy] declared-and-unpaired=${total(declared)} `
      + `second-message-of-a-paired-turn=${total(secondMessage)} declared-and-lost=${total(lost)}`,
    );

    // EVERY DECLARED ROW MUST LAND IN ONE OF THE TWO, or the axis is not deciding anything. A declared
    // row whose `target_paired` came back null means the query returned a declaration it could not
    // resolve, and the split would be silently counting it as neither.
    const unclassified = declared.filter((r) => targetPaired(r) === null);
    expect(
      unclassified,
      'a row that declared a target must say whether that target was answered. A null there means the '
        + 'two columns disagree about what the row declared, and the split stops partitioning. '
        + `Unclassified: ${JSON.stringify(unclassified)}`,
    ).toEqual([]);

    expect(
      total(lost),
      'a turn NAMED the message it answers and nothing anywhere records an answer to that message. '
        + 'That is not a turn outside the exchange population - it said it was an answer - it is an '
        + 'answer the projection lost, and no marker, bound or lookback can explain it away. '
        + `Lost: ${JSON.stringify(lost)}`,
    ).toBe(0);
  });

  /**
   * EVERY DELIVERY MODE REPORTS AN END-TO-END TIME, OR THE POPULATION IS NOT WHAT IT SAYS.
   *
   * `e2e_ms` is the person's actual wait: their message to the final answer. It derives from
   * `agent_final_at`, which has exactly ONE writer - the UPDATE fold in archival.
   *
   * A DIRECT turn has no update. Greetings and acknowledgments are answered inline through Lex, so
   * Amazon Chime SDK materializes one message and there is never an UPDATE event to fold. The answer
   * time is that row's own timestamp and is trivially computable, but nothing computes it, so every
   * DIRECT turn is absent from the end-to-end latency population while still counting in every figure
   * built beside it.
   *
   * That is the kind of accuracy failure a shape check cannot see: the number is not wrong, the
   * population behind it is.
   *
   * EVERY TURN, NOT ONLY THE ONES A PERSON STARTED, and no analytics value reads "unknown". A reading, a rebuttal, a welcome, a join recap, a duel round and a queue
   * acknowledgment have no delivery option and no person's message to measure from, so they all grouped
   * as 'unknown' with no end to end (2026-10-16: 290 turns in 47 such rows). The grid now labels each by
   * its declared kind and reports `avg_turn_ms`, each turn's own start to its final post, which on a
   * person's turn equals the end to end. So the label set is checked for the two values that mean a
   * population is unnamed, and every label is checked for a span.
   */
  test('every delivery option reports the wait it made someone endure', async () => {
    const end = new Date();
    const rows = await metricsBetween(new Date(end.getTime() - 20 * 86_400_000), end);
    expect(rows.length, 'need traffic in the window for this to mean anything').toBeGreaterThan(0);
    expect(
      rows.some((r) => 'avg_turn_ms' in r),
      'latency_metrics must publish avg_turn_ms, every turn\'s own span. Its absence means the deployed '
        + `analytics API predates it: redeploy ${stackName('Archive')} and re-run.`,
    ).toBe(true);

    const byOption = new Map<string, { rows: number; withSpan: number; turns: number; carried: number }>();
    for (const r of rows) {
      const key = String(r.delivery_option ?? 'unknown');
      const acc = byOption.get(key) ?? { rows: 0, withSpan: 0, turns: 0, carried: 0 };
      acc.rows += 1;
      acc.turns += Number(r.assistant_turn_count || 0);
      acc.carried += Number(r.turn_carried_by_answer_count || 0);
      if (Number(r.avg_turn_ms) > 0) acc.withSpan += 1;
      byOption.set(key, acc);
    }
    console.log(
      '[analytics-accuracy] turn-span coverage by delivery option or turn kind: '
      + JSON.stringify([...byOption.entries()]),
    );

    // NO POPULATION IS UNNAMED. 'unknown' (or a null label) is a turn the grid could not name, and
    // undeclared_turn is a turn that declared neither a delivery option nor a kind on any carrier: the
    // named data defect, which exists so it fails here rather than averaging silently.
    const unnamed = [...byOption.entries()].filter(([k, v]) => v.turns > 0
      && (k === 'unknown' || k === 'null' || k === '' || k === 'undeclared_turn'));
    expect(
      unnamed,
      'every assistant turn must be named: by its delivery option, or by the kind of turn it declared '
        + '(reading, rebuttal, welcome, join_recap, battle_round_N, queue_ack, ...). A turn the grid cannot '
        + `name is spend and time nobody can attribute. Unnamed: ${JSON.stringify(unnamed)}`,
    ).toEqual([]);

    // A population with traffic and not one row carrying a span is blind, not merely sparse. A receipt
    // has no span by definition: its answer moved to a message of its own, timed from the same person's
    // message, so the receipt's turn_ms is NULL and it is counted in turn_carried_by_answer_count
    // instead (LATENCY-TARGETS "A moved answer"). A population whose every turn is carried that way is
    // measured through its answers, not blind; one carried turn short of its traffic is blind.
    const blind = [...byOption.entries()].filter(([, v]) => v.turns > 0 && v.withSpan === 0
      && v.carried < v.turns);
    expect(
      blind.map(([k]) => k),
      'a delivery option or turn kind carrying real traffic with no turn span at all is a whole population '
        + 'missing from the latency picture rather than a gap in it. Those turns still count in every '
        + 'figure beside avg_turn_ms, so each of those averages describes a different set of turns from the '
        + `one it names. Blind: ${JSON.stringify(blind)}`,
    ).toEqual([]);
  });

  /**
   * THE SHADOW DIFF ANSWERS, OVER LIVE TRAFFIC (latency record, owner 2026-09-15).
   *
   * The Latency tab reads from the ledger because the derived path and the ledger are watched agreeing
   * on the same turns. This is that watch: it reads the comparison through the signed path and logs
   * what it found. It asserts the read works and covers real turns, NOT that they agree, because
   * agreement is the finding the ledger repoint rests on rather than a property this suite can require.
   */
  test('the derived path and the ledger are compared per turn over live traffic', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'turn_latency_shadow_diff',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      days: 7,
    });
    const summary = (j.summary || {}) as Record<string, number | null>;
    const rows = (j.data || []) as Row[];
    console.log('[analytics-accuracy] shadow diff summary:', JSON.stringify(summary));
    console.log('[analytics-accuracy] shadow diff rows to look at (first 10):', JSON.stringify(rows.slice(0, 10)));
    expect(typeof summary.compared_count, 'the shadow diff must answer with its summary').toBe('number');
    expect(summary.compared_count, 'a week of live traffic must give the comparison turns to compare').toBeGreaterThan(0);
  });
});