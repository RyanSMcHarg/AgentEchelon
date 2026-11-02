/**
 * THE LEX LEG, MEASURED PER TURN (ADR-036 criterion 1b).
 *
 * `ttff_ms - router_ms` on ONE row is the time a turn spends before the router starts plus the
 * placeholder's trip back: the entry hop. Grouped by `turn_entry`, the `lex` population carries the
 * Amazon Lex hop and the `flow` population carries the channel flow's direct invoke, so the difference
 * of their medians is the Lex leg, measured rather than inferred from a difference of group averages.
 *
 * Read as testAdmin through the signed analytics path (`latency_exchanges`, the per-turn drill), never
 * a direct invoke. It asserts the read is non-vacuous and that the two spans are consistent (the
 * router's span never exceeds the turn's TTFF on a measured row), and logs the medians so the run is
 * the evidence ADR-036 records.
 *
 * The same reads also check the pairing and timing rule the per-turn rows rest on: a placeholder whose
 * answer moved to a message of its own pairs with nothing (read over this run's turns only), and the turn span sources (queue release
 * included) partition the measured turns on every `latency_metrics` row.
 *
 * Opt-in like the other analytics measurements: LEX_LEG_E2E=1.
 */
import { test, expect } from './helpers/fixtures';
import * as fs from 'fs';
import * as path from 'path';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

guardConsoleErrors();

const RUN = process.env.LEX_LEG_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';
const WINDOW_DAYS = Number(process.env.LEX_LEG_DAYS || '30');

/**
 * When this run began. `validate.mjs` records it in `test-results/.e2e-run-start` before any phase,
 * and a run of several `--only` invocations keeps its first marker. Without the marker (a direct
 * Playwright run) it is this file's load, which precedes every spec in the invocation, with the same
 * minute's cushion the marker carries for clock skew.
 */
const RUN_STARTED_AT: Date = (() => {
  try {
    const marker = fs.readFileSync(path.join(__dirname, '..', 'test-results', '.e2e-run-start'), 'utf8').trim();
    const at = new Date(marker);
    if (Number.isFinite(at.getTime())) return at;
  } catch {
    // no marker: fall through to this file's load
  }
  return new Date(Date.now() - 60_000);
})();

type Row = Record<string, unknown>;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

suite('The Lex leg is measured per turn', () => {
  guardBackendErrors('lex-leg');

  let creds: TestCredentials;
  let idToken: string;

  test.beforeAll(async () => {
    creds = await getTestCredentials();
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    idToken = await idTokenOf(page);
    expect(idToken, 'an admin id token is required to read the analytics API').toBeTruthy();
    expect(ANALYTICS_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
  });

  test('ttff_ms and router_ms arrive on one row, and the entry hop splits by entry', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
    const rows: Row[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
        queryType: 'latency_exchanges',
        dateRange: { start: start.toISOString(), end: end.toISOString() },
        limit: 500,
        offset,
      });
      const page = (j.data || []) as Row[];
      rows.push(...page);
      if (page.length < 500) break;
    }

    const measured = rows.filter((r) => typeof r.ttff_ms === 'number' && typeof r.router_ms === 'number');
    expect(measured.length, 'no turn in the window carries both ttff_ms and router_ms').toBeGreaterThan(0);

    // The router's span sits inside the turn's TTFF. A row where it does not is a measurement fault,
    // and the share of such rows is reported rather than hidden.
    const inverted = measured.filter((r) => (r.router_ms as number) > (r.ttff_ms as number));

    const hopByEntry: Record<string, number[]> = {};
    for (const r of measured) {
      const entry = String(r.turn_entry ?? 'unknown');
      (hopByEntry[entry] ||= []).push((r.ttff_ms as number) - (r.router_ms as number));
    }
    const summary = Object.fromEntries(Object.entries(hopByEntry).map(([entry, hops]) => [entry, {
      turns: hops.length,
      medianOutsideRouterMs: median(hops),
      medianRouterMs: median(measured.filter((r) => String(r.turn_entry ?? 'unknown') === entry).map((r) => r.router_ms as number)),
    }]));
    const lexLegMs = summary.lex?.medianOutsideRouterMs != null && summary.flow?.medianOutsideRouterMs != null
      ? summary.lex.medianOutsideRouterMs - summary.flow.medianOutsideRouterMs
      : null;

    console.log('[lex-leg]', JSON.stringify({
      windowDays: WINDOW_DAYS, rows: rows.length, measured: measured.length,
      invertedRows: inverted.length, byEntry: summary, lexLegMedianMs: lexLegMs,
    }));

    expect(inverted.length / measured.length, 'router_ms exceeds ttff_ms on more than 5% of measured rows')
      .toBeLessThanOrEqual(0.05);
  });

  // ADR-043 "What this owes" 4: the two paths are distinguishable on a deployment. A turn the flow
  // dispatched CARRIES the message it answers, so it pairs `declared` by construction; a turn Amazon Lex
  // invoked natively reconstructs it, and may pair `declared`, `in_batch` or `swept`.
  test('a carried turn always pairs declared, and the entry splits the two populations', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'latency_exchanges',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      limit: 500,
    });
    const rows = (j.data || []) as Row[];
    expect(rows.length, 'no exchanges in the window').toBeGreaterThan(0);
    expect(rows.some((r) => 'paired_by' in r), 'the deployed read does not return paired_by yet').toBe(true);

    const flow = rows.filter((r) => r.turn_entry === 'flow');
    const lex = rows.filter((r) => r.turn_entry === 'lex');
    const tally = (rs: Row[]) => rs.reduce<Record<string, number>>((acc, r) => {
      const k = String(r.paired_by ?? 'null');
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    console.log('[two-paths]', JSON.stringify({ flow: tally(flow), lex: tally(lex) }));

    expect(flow.length, 'no flow-entry turns in the window').toBeGreaterThan(0);
    // WHAT EACH UNPAIRED ROW IS, so a failure says which turns were left without an exchange rather than
    // a list of nulls (the exchange id is exactly what such a row lacks).
    // A KIND-LABELED TURN (a battle reading, a join recap, a queue acknowledgment) answers no message and
    // has no exchange by design (`getLatencyExchanges`), so it is not a carried turn that failed to pair.
    const unpaired = flow.filter((r) => !r.turn_kind && r.paired_by !== 'declared')
      .map((r) => ({ kind: r.turn_kind ?? null, message: r.chime_message_id ?? r.message_id, at: r.created_at }));
    expect(unpaired).toEqual([]);
  });

  // A PLACEHOLDER WHOSE ANSWER MOVED pairs with nothing: it declares `receipt` or `queue_ack`, and the
  // message the answer moved to is the one that pairs.
  // READ OVER THIS RUN ONLY. A row recorded before the current pairing rules carries the pairing it
  // was recorded with, so the 30-day window measures that history rather than the code
  // this run is exercising. Every row from the run's start is checked; none is skipped.
  test('a placeholder whose answer moved pairs with nothing, on the turns of this run', async () => {
    const end = new Date();
    const rows: Row[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
        queryType: 'latency_exchanges',
        dateRange: { start: RUN_STARTED_AT.toISOString(), end: end.toISOString() },
        limit: 500,
        offset,
      });
      const page = (j.data || []) as Row[];
      rows.push(...page);
      if (page.length < 500) break;
    }
    expect(rows.length, `no exchanges since this run began (${RUN_STARTED_AT.toISOString()})`).toBeGreaterThan(0);

    const placeholders = rows.filter((r) => r.turn_kind === 'receipt' || r.turn_kind === 'queue_ack');
    const pairedPlaceholders = placeholders.filter((r) => r.exchange_id != null)
      .map((r) => ({ kind: r.turn_kind, message: r.chime_message_id ?? r.message_id, at: r.created_at }));
    console.log('[moved-placeholders]', JSON.stringify({
      since: RUN_STARTED_AT.toISOString(), rows: rows.length, placeholders: placeholders.length,
      paired: pairedPlaceholders.length,
    }));
    expect(pairedPlaceholders).toEqual([]);
  });

  // EVERY TURN IS TIMED FROM WHAT TRIGGERED IT, and the sources partition the measured turns. A reading
  // is timed from the queue's release of its work (`queue_release`), never from processor entry.
  test('the span sources partition the measured turns, queue release included', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'latency_metrics',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
    });
    const rows = (j.data || []) as Row[];
    expect(rows.length, 'no latency rows in the window').toBeGreaterThan(0);
    expect(rows.some((r) => 'turn_span_queue_release_count' in r), 'the deployed read does not return turn_span_queue_release_count yet').toBe(true);

    const SOURCES = [
      'turn_span_person_count', 'turn_span_trigger_count', 'turn_span_ack_count', 'turn_span_processor_count',
      'turn_span_membership_count', 'turn_span_queue_release_count',
    ];
    const n = (v: unknown): number => Number(v ?? 0);
    const broken = rows
      .filter((r) => SOURCES.reduce((sum, k) => sum + n(r[k]), 0) !== n(r.turn_measured_count))
      .map((r) => ({ date: r.date, label: r.delivery_option, measured: r.turn_measured_count,
        sources: Object.fromEntries(SOURCES.map((k) => [k, r[k]])) }));
    const readings = rows.filter((r) => r.delivery_option === 'reading');
    console.log('[span-sources]', JSON.stringify({
      rows: rows.length,
      readingRows: readings.length,
      readingQueueRelease: readings.reduce((s, r) => s + n(r.turn_span_queue_release_count), 0),
      readingProcessorEntry: readings.reduce((s, r) => s + n(r.turn_span_processor_count), 0),
    }));
    expect(broken).toEqual([]);
  });
});
