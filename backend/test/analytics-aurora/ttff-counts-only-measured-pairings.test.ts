/**
 * A RECONSTRUCTED PAIRING DOES NOT GET A VOTE ON TIME-TO-FIRST-FEEDBACK.
 *
 * An exchange reaches the table by one of two pairers. The in-batch pairer sees the turn's own
 * analytics and records `delivery_option`. `createExchangesFromDatabase` is the fallback for a turn
 * whose user and bot messages landed in different Kinesis batches: it RECONSTRUCTS the pair by
 * searching for the earliest corr-marked bot CREATE after the user message, bounded only by
 * `INTERVAL '1 hour'`, and its INSERT omits `delivery_option` entirely. So a NULL delivery option is
 * the fallback's fingerprint, and the latency beside it is the gap to whatever reply that search
 * picked - not a time to a placeholder.
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
 * their `exchange_count` and are counted by name in `ttff_reconstructed_count`; what they lose is a
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

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: {
      authorizer: { claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } },
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the TTFF average is taken over measured pairings only', () => {
  it('filters the average to rows the fallback pairer did not mint', async () => {
    const { sql } = await latencyQuery();
    // The mutation this catches is the FILTER being dropped - which is exactly the state that
    // produced a 21.5-second headline from a 2.6-second product.
    expect(sql).toMatch(
      /AVG\(e\.response_latency_ms\)\s*FILTER\s*\(\s*WHERE\s+e\.delivery_option\s+IS\s+NOT\s+NULL\s*\)[\s\S]*?AS\s+avg_ttff_ms/,
    );
  });

  it('filters the P95 the same way, because a tail is where the fabrications live', async () => {
    const { sql } = await latencyQuery();
    // The p95 mattered MORE than the average here: 2,428,479 ms against an average of 487,360.
    // Filtering one and not the other would leave the worse number standing.
    expect(sql).toMatch(
      /PERCENTILE_CONT\(0\.95\)\s+WITHIN\s+GROUP\s*\(\s*ORDER\s+BY\s+e\.response_latency_ms\s*\)\s*FILTER\s*\(\s*WHERE\s+e\.delivery_option\s+IS\s+NOT\s+NULL\s*\)[\s\S]*?AS\s+p95_ttff_ms/,
    );
  });

  it('COUNTS the excluded rows rather than dropping them silently', async () => {
    const { sql } = await latencyQuery();
    // Partition, not suppression. A reader must be able to see that rows were held out, and how many
    // - the same contract `unclosed_count` and `direct_count` already keep.
    expect(sql).toMatch(/AS\s+ttff_measured_count/);
    expect(sql).toMatch(/AS\s+ttff_reconstructed_count/);
    expect(sql).toMatch(
      /COUNT\(\*\)\s*FILTER\s*\(\s*WHERE\s+e\.response_latency_ms\s+IS\s+NOT\s+NULL\s+AND\s+e\.delivery_option\s+IS\s+NULL\s*\)\s*AS\s+ttff_reconstructed_count/,
    );
  });

  it('the two counts partition the rows that carry a latency at all', async () => {
    // Non-vacuity of the pair: the measured half and the reconstructed half differ ONLY in the
    // null-ness of delivery_option, so between them they consume every row with a
    // response_latency_ms. If someone narrows one predicate without widening the other, rows fall
    // out of both and the split stops adding up - silently, which is the failure mode the
    // unclosed_* partition was built to prevent.
    const { sql } = await latencyQuery();
    const measured = /COUNT\(\*\)\s*FILTER\s*\(\s*WHERE\s+([^)]+?)\s*\)\s*AS\s+ttff_measured_count/.exec(sql);
    const reconstructed = /COUNT\(\*\)\s*FILTER\s*\(\s*WHERE\s+([^)]+?)\s*\)\s*AS\s+ttff_reconstructed_count/.exec(sql);
    expect(measured).not.toBeNull();
    expect(reconstructed).not.toBeNull();
    const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(normalise(measured![1])).toBe(
      normalise(reconstructed![1]).replace('e.delivery_option IS NULL', 'e.delivery_option IS NOT NULL'),
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

  it('leaves e2e and the compute metrics unfiltered, so this change is one decision', async () => {
    // Scope guard. e2e_ms rides the same possibly-reconstructed user_message_at and has the same
    // exposure, but widening the fix here would make one reviewable change into two. If e2e is
    // partitioned later this test is the place that records the decision changing.
    const { sql } = await latencyQuery();
    expect(sql).toMatch(/ROUND\(AVG\(e\.e2e_ms\)\)\s*AS\s+avg_e2e_ms/);
    expect(sql).toMatch(/ROUND\(AVG\(m\.total_ms\)\)\s*AS\s+avg_total_ms/);
  });
});
