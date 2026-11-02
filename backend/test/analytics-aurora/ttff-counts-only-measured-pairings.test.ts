/**
 * A RECONSTRUCTED PAIRING DOES NOT GET A VOTE ON TIME-TO-FIRST-FEEDBACK.
 *
 * CARRIED ACROSS THE REPOINT. The tab's TTFF now comes from the ledger (`v_turn_latency.ttff_ms`,
 * the ledger repoint) rather than from `exchanges.response_latency_ms`, and the exclusion below had to
 * come with it or the whole defect returns through the ledger's fallback anchor. Where the ledger has
 * its own `user_message` instant AND bound that message itself (`turn_id_source` is not `paired`) it
 * is unexposed. Where it does not, `v_turn_latency` borrows the exchange's `user_message_at`, and a
 * swept exchange hands it exactly the reconstructed start described below - as does a ledger anchor
 * whose binding the backfill derived from that same exchange. So the predicate is now "the ledger
 * anchored AND bound the turn itself, OR the exchange it came from was really paired", and these
 * tests pin both halves of that too.
 *
 * An exchange reaches the table by one of two pairers. `createExchangesFromDatabase` is the fallback
 * for a turn whose user and bot messages landed in different Kinesis batches: where the answer
 * declared nothing it RECONSTRUCTS the pair by searching for the earliest corr-marked bot CREATE
 * after the user message, bounded only by the reply window, so the latency beside it is the gap to
 * whatever reply that search picked and not a time to a placeholder.
 *
 * THE DISCRIMINATOR IS DECLARED, AND THAT IS WHAT THESE TESTS PIN. `exchanges.paired_by` says how
 * each pair was made: `declared` is the turn's own statement, `in_batch` is an inference bounded to
 * seconds by the Kinesis batch it was made in, `swept` is the reconstruction above. Only `swept` is
 * excluded, and it is excluded BY NAME.
 *
 * It used to be excluded by a missing `delivery_option`, which meant "the fallback minted this" only
 * because that pairer's INSERT omitted the column. Two facts were riding one absence: the moment the
 * sweep began recording a delivery option - which is what stops every late-paired answer landing in
 * the `unknown` bucket - every reconstructed row would have rejoined this average with nothing
 * failing. The old proxy is KEPT for rows written before the column existed, where it still means
 * what it always meant, and these tests pin both halves.
 *
 * WHAT THIS COST, MEASURED. 101 such rows on 2026-08-14 averaged 487,360 ms with a p95 of 2,428,479 ms
 * (just inside the hour cap) and produced 93% of a 7-day TTFF total over 2,719 exchanges. The headline
 * read 21,555 ms; the same window without them read 3,585 ms. Against a 1s SLO the difference is not
 * precision, it is whether the number describes the product at all.
 *
 * AND IT IS WORSE THE LESS TRAFFIC THERE IS. A fresh deployment's first run produces tens of
 * exchanges, so ONE reconstructed row puts its average into the minutes - with no history to tell the
 * reader it is wrong. That is the case these tests exist for, and it is why the fix could not wait for
 * the bad rows to age out of the window.
 *
 * THE SHAPE OF THE FIX IS THE FILE'S OWN RULE: partition, do not hide. The reconstructed rows keep
 * their `assistant_turn_count` and are counted by name in `ttff_reconstructed_count`; what they lose is a
 * vote on the average. Same rule as `unclosed_*` and as the compute/direct split.
 *
 * Mock + `latencyQuery` pattern follows `latency-unclosed-split.test.ts` in this directory.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
const mockEnsureSchema = jest.fn().mockResolvedValue(undefined);

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: mockEnsureSchema,
  getClient: jest.fn(),
}));

import { handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { edgeContext } from '../helpers/edge-context';

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: {
      authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }),
    },
  } as unknown as APIGatewayProxyEvent;
}

async function latencyQuery(rows: unknown[] = []): Promise<{ sql: string; body: any }> {
  mockDbQuery.mockResolvedValueOnce({ rows });
  const res = await handler(
    postEvent({ queryType: 'latency_metrics', dateRange: { start: '2026-08-01', end: '2026-08-21' } })
  );
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM messages m/.test(sql as string));
  expect(call).toBeDefined();
  return { sql: call![0] as string, body: JSON.parse(res.body) };
}

/**
 * Compare SQL by its tokens rather than by its indentation, so a reformat that changes nothing about
 * WHICH ROWS ARE COUNTED does not fail these, and cannot hide a dropped predicate either.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/**
 * The measured-pairing predicate, as the query writes it - now stated ONCE, in the `mp` lateral.
 *
 * Four clauses, and all four are load-bearing. The first says the ledger anchored the turn on its own
 * observed user message. The second says the ledger also BOUND that user message itself: a binding
 * recorded as `paired` was derived from an exchange (`turn-events-backfill.ts` reads the exchanges
 * table with no `paired_by` filter), so it inherits that exchange's provenance and must be decided by
 * the clauses below rather than trusted on its own - `a-backfilled-anchor-is-not-a-measured-one.test.ts`
 * owns that half. The third excludes the sweep's reconstructions by the name the pairer records for
 * itself. The fourth keeps the OLD proxy for rows written before `paired_by` existed, where a missing
 * delivery option did mean the sweep minted the row - so no historical row changes which side of the
 * partition it falls on, and no backfill is required.
 *
 * A fifth arm admits a placeholder the view anchored by its declared target (migration 080): a receipt or a
 * notice written into a placeholder, anchored on the moved answer's exchange and never on a swept one.
 *
 * COALESCE, so the value is a strict boolean. `measured` and `NOT measured` have to partition the
 * rows; a NULL would drop a row out of both counts and the split would stop adding up in silence.
 */
const MEASURED_SQL =
  "(COALESCE(vl.anchor_source = 'ledger' AND vl.turn_id_source IS DISTINCT FROM 'paired', FALSE)"
  + " OR COALESCE(vl.anchor_source = 'declared_target', FALSE)"
  + " OR (e.paired_by IS DISTINCT FROM 'swept'"
  + ' AND (e.paired_by IS NOT NULL OR e.delivery_option IS NOT NULL)))';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the TTFF average is taken over measured pairings only', () => {
  it('states the predicate ONCE, and asks the ledger anchor before it trusts the exchange', async () => {
    const { sql } = await latencyQuery();
    // The whole discriminator, in the one lateral that computes it. Written out per FILTER it was
    // five hand-copies of a compound expression, which is how two halves of a partition drift.
    // The ledger clause is part of it, and that is what makes the exclusion NARROW: a turn the ledger
    // anchored on its own user_message never borrowed a swept start, so excluding it would throw away
    // a real measurement to guard against an exposure it does not have.
    expect(flat(sql)).toContain(`SELECT ${MEASURED_SQL} AS measured`);
    // Exactly one place computes it. A second copy is how the two halves of the partition drift.
    expect(flat(sql).match(/AS measured\b/g)).toHaveLength(1);
  });

  it('filters the average to rows the fallback pairer did not mint', async () => {
    const { sql } = await latencyQuery();
    // The mutation this catches is the FILTER being dropped - which is exactly the state that
    // produced a 21.5-second headline from a 2.6-second product.
    expect(flat(sql)).toContain('AVG(vl.ttff_ms) FILTER (WHERE mp.measured)) AS avg_ttff_ms');
  });

  it('filters the P95 the same way, because a tail is where the fabrications live', async () => {
    const { sql } = await latencyQuery();
    // The p95 mattered MORE than the average here: 2,428,479 ms against an average of 487,360.
    // Filtering one and not the other would leave the worse number standing.
    expect(flat(sql)).toContain(
      'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vl.ttff_ms) FILTER (WHERE mp.measured)) AS p95_ttff_ms',
    );
  });

  it('carries the filter onto the WARM average too, or the two stop being comparable', async () => {
    // avg_ttff_warm_ms exists to be compared with avg_ttff_ms: if they are close, cold start was not
    // the story. Filtering one population and not the other makes that comparison meaningless, and
    // the unfiltered side would be the one carrying the fabricated rows.
    const { sql } = await latencyQuery();
    expect(flat(sql)).toContain(
      'AVG(vl.ttff_ms) FILTER (WHERE mp.measured AND NOT COALESCE(m.cold_start, false))) AS avg_ttff_warm_ms',
    );
  });

  it('COUNTS the excluded rows rather than dropping them silently', async () => {
    const { sql } = await latencyQuery();
    // Partition, not suppression. A reader must be able to see that rows were held out, and how many
    // - the same contract `unclosed_count` and `direct_count` already keep.
    expect(sql).toMatch(/AS\s+ttff_measured_count/);
    expect(sql).toMatch(/AS\s+ttff_reconstructed_count/);
    expect(flat(sql)).toContain(
      'COUNT(*) FILTER (WHERE vl.ttff_ms IS NOT NULL AND NOT mp.measured) AS ttff_reconstructed_count',
    );
  });

  it('the two counts partition the rows the ledger produced a TTFF for', async () => {
    // Non-vacuity of the pair: the two halves are EXACT COMPLEMENTS over the rows that carry a
    // latency at all, so between them they consume every one. If someone narrows one predicate
    // without widening the other, rows fall out of both and the split stops adding up - silently,
    // which is the failure mode the unclosed_* partition was built to prevent.
    //
    // It is a partition only because `mp.measured` is a strict boolean - hence the COALESCE in
    // MEASURED_SQL above, which the first test in this file pins.
    const { sql } = await latencyQuery();
    expect(flat(sql)).toContain(
      'COUNT(*) FILTER (WHERE vl.ttff_ms IS NOT NULL AND mp.measured) AS ttff_measured_count',
    );
    expect(flat(sql)).toContain(
      'COUNT(*) FILTER (WHERE vl.ttff_ms IS NOT NULL AND NOT mp.measured) AS ttff_reconstructed_count',
    );
  });

  it('declares both counts in the column contract, appended so the old contract is intact', async () => {
    const { body } = await latencyQuery();
    expect(body.columns).toEqual(expect.arrayContaining(['ttff_measured_count', 'ttff_reconstructed_count']));
    // APPENDED, not inserted: LatencyTab, alerts.ts and metricTargets.ts read by name, and the
    // existing order is a contract other readers rely on.
    const cols: string[] = body.columns;
    expect(cols.indexOf('ttff_measured_count')).toBeGreaterThan(cols.indexOf('avg_ttff_ms'));
    expect(cols.indexOf('avg_total_ms')).toBeLessThan(cols.indexOf('avg_ttff_ms'));
  });

  it('still excludes a genuine sweep, because the repair is upstream of this query', async () => {
    // THE BOUNDARY THAT MUST NOT MOVE. A turn whose time to first feedback exceeds the five second
    // Kinesis batching window is paired by the sweep, and until the declaration reached the CREATE
    // row (the placeholder now names what it answers) or the update fold promoted the label
    // (`backfillFromUpdateEvents`), that turn was labelled `swept` and dropped from this average -
    // so the slowest turns, the ones the SLO exists to catch, were the censored ones.
    //
    // NEITHER REPAIR TOUCHES THIS PREDICATE, and that is deliberate. A pairing the sweep genuinely
    // reconstructed - no declaration anywhere, a search bounded only by the reply window - is not a
    // measurement, and admitting it here to raise the coverage would trade a censored average for a
    // fabricated one. What changed is which rows honestly carry the label, never what the label
    // means.
    const { sql } = await latencyQuery();
    expect(flat(sql)).toContain("e.paired_by IS DISTINCT FROM 'swept'");
    expect(flat(sql)).toContain(`SELECT ${MEASURED_SQL} AS measured`);
    // No exemption was added beside it: `swept` is excluded whatever else the row carries.
    expect(flat(sql)).not.toContain("e.paired_by = 'swept' AND");
  });

  it('leaves e2e and the compute metrics unfiltered, so this change is one decision', async () => {
    // Scope guard, and it survived the repoint deliberately. The ledger's e2e_ms rides the same
    // possibly-reconstructed anchor and has the same exposure, but partitioning it here would make
    // one reviewable change into two. If e2e is partitioned later this test is the place that
    // records the decision changing.
    //
    // The one filter E2E does carry is the battle round (migration 071): round two's end to end is its
    // own round's, not a person's wait. That is a population decision about which turns are a person's
    // wait, not the measured-pairing partition, so this guard still refuses mp.measured on E2E.
    const { sql } = await latencyQuery();
    expect(sql).toMatch(/ROUND\(AVG\(vl\.e2e_ms\) FILTER \(WHERE COALESCE\(vl\.battle_round, 1\) <= 1\)\)\s*AS\s+avg_e2e_ms/);
    expect(sql).not.toMatch(/AVG\(vl\.e2e_ms\) FILTER \(WHERE[^)]*mp\.measured/);
    expect(sql).toMatch(/ROUND\(AVG\(m\.total_ms\)\)\s*AS\s+avg_total_ms/);
  });
});
