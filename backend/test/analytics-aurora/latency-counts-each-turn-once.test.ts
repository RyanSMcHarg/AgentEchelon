/**
 * ONE TURN IS ONE ROW IN THE LATENCY QUERY.
 *
 * A bot reply is stored TWICE: the canonical `CREATE_CHANNEL_MESSAGE` row, and a `<id>-UPD` audit row
 * holding the finalized text for the conversation browser. The audit row carries `total_ms`, so
 * `getLatencyMetrics` counted every turn's compute twice - and since the exchange join is on the
 * CREATE id, the duplicates could not be attributed and fell into an `unknown`/`unknown` bucket.
 *
 * Live: 564 phantom rows against ~570 real ones, all inside the traffic-weighted P95 latency ALERT
 * population, where at that ratio they outweigh the turns they are doubling. TTFF was unaffected
 * (`response_latency_ms` is null on those rows and `AVG` skips nulls), which is exactly why it went
 * unnoticed: the headline number looked fine while the alert was reading a doubled distribution.
 *
 * `getModelUsage` documented this trap and excluded the row. This query never learned - which is the
 * general lesson worth a test rather than a comment: **a guard that lives beside ONE call site does
 * not protect the others.**
 *
 * EXCLUDING THE ROW IS NOT EXCLUDING THE UPDATE, and the distinction is the whole point. The update is
 * the moment the person receives their answer, and it is fully measured: archival folds its timestamp
 * onto the canonical row as `agent_final_at`, which is what `e2e_ms` is derived from. The `-UPD` row
 * carries no timing the canonical row lacks. It is a STEP to be measured, not a turn to be counted.
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

/** The SQL the latency query issued. */
async function latencySql(): Promise<string> {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
  await handler(postEvent({ queryType: 'latency_metrics', dateRange: { start: '2026-05-13', end: '2026-05-20' } }));
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM messages m/.test(sql as string));
  expect(call).toBeDefined();
  return call![0] as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureSchema.mockResolvedValue(undefined);
});

describe('the latency query counts a turn once', () => {
  it('excludes the -UPD audit row', async () => {
    // The whole fix, and the mutation that turns this red is deleting one line from the WHERE clause.
    expect(await latencySql()).toMatch(/m\.event_type\s*=\s*'CREATE_CHANNEL_MESSAGE'/);
  });

  it('still measures the update, via the canonical row', async () => {
    // Guards against the wrong reading of the fix: dropping `e2e_ms` along with the duplicate row
    // would remove the one metric that describes the wait the person actually experienced.
    const sql = await latencySql();
    expect(sql).toMatch(/AVG\(e\.e2e_ms\)/);
    expect(sql).toMatch(/PERCENTILE_CONT\(0\.95\)[\s\S]*e\.e2e_ms/);
  });

  it('keeps TTFF measured from the exchange, not from the audit row', async () => {
    const sql = await latencySql();
    expect(sql).toMatch(/AVG\(e\.response_latency_ms\)/);
  });

  it('REPORTS the compute denominator instead of filtering it away', async () => {
    // `total_ms > 0` used to sit in the WHERE, so responses that ran no measurable compute were
    // silently absent and every average was over a population nobody could state. The averages are
    // unchanged - a null contributes nothing to AVG either way - but the counts beside them now say
    // what was averaged over and what was not.
    const sql = await latencySql();
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE m\.total_ms IS NOT NULL AND m\.total_ms > 0\) AS compute_count/);
    expect(sql).toMatch(/AS direct_count/);
    // The mutation that must turn this red: putting the predicate back in the main WHERE. Scoped to
    // the clause between FROM and GROUP BY - a naive whole-string match also hits the legitimate
    // `FILTER (WHERE m.total_ms ...)` above, which is the opposite of what this is guarding.
    const whereClause = sql.slice(sql.indexOf('FROM messages m'), sql.indexOf('GROUP BY'));
    expect(whereClause).not.toMatch(/AND m\.total_ms/);
  });

  it('COUNTS the turns that never closed', async () => {
    // A turn whose answer never landed has a null e2e_ms, and AVG skips nulls without complaint - so
    // it leaves the average rather than being reported as incomplete.
    //
    // This matters more since finality became declared: an errored turn now correctly does NOT close,
    // because only respPhase='final' sets agent_final_at. Correct semantics, and invisible without
    // this count - which is the regression the count exists to prevent.
    const sql = await latencySql();
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE e\.e2e_ms IS NOT NULL\) AS closed_count/);
    expect(sql).toMatch(/AS unclosed_count/);
  });

  it('appends the new columns rather than reordering the contract', async () => {
    // LatencyTab, alerts.ts and metricTargets.ts read the `columns` contract by name. An addition is
    // safe; a rename or a reorder is not, and this is the boundary that would hide it.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(postEvent({ queryType: 'latency_metrics', dateRange: { start: '2026-05-13', end: '2026-05-20' } }));
    const cols = JSON.parse(res.body).columns as string[];
    expect(cols.slice(0, 4)).toEqual(['date', 'agent_type', 'delivery_option', 'exchange_count']);
    expect(cols).toEqual(expect.arrayContaining(['compute_count', 'direct_count', 'closed_count', 'unclosed_count']));
  });

  it('matches the exclusion `getModelUsage` already applies', async () => {
    // The two queries read the same table and must share one idea of what a turn is. They disagreed
    // for months because only one of them wrote the rule down.
    mockDbQuery.mockResolvedValue({ rows: [] });
    await handler(postEvent({ queryType: 'model_usage', dateRange: { start: '2026-05-13', end: '2026-05-20' } }));
    const usageSql = mockDbQuery.mock.calls.map(([sql]) => sql as string).find((s) => /FROM messages m/.test(s));
    expect(usageSql).toMatch(/m\.event_type\s*=\s*'CREATE_CHANNEL_MESSAGE'/);
  });
});
