/**
 * AN AVERAGE IS NEVER PUBLISHED WITHOUT ITS POPULATION, AND A COUNT IS NAMED FOR WHAT IT COUNTS.
 *
 * `latency_metrics` averages each path step over the turns that stamped it, and AVG skips the NULLs,
 * so every step average is over its own subset of the turns. `avg_ttff_ms` publishes
 * `ttff_measured_count`; the router, router-other and guard averages need the same, or subtracting one
 * group average from another (TTFF minus router, to size "outside the handler") produces a number that
 * describes no turn. The counts make the populations readable, and no column computes that
 * cross-population, cross-clock residual.
 *
 * The turn count is `assistant_turn_count`: one row per assistant turn, which is not one row per
 * exchange. And the unpaired figure in `latency_metrics` and in `unpaired_bot_messages` read one
 * definition of an assistant turn, so the two cannot disagree by construction.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
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

const RANGE = { start: '2026-08-01', end: '2026-08-21' };

async function run(queryType: string): Promise<{ sql: string; body: any }> {
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ rows: [] });
  const res = await handler(postEvent({ queryType, dateRange: RANGE }));
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM messages m/.test(sql as string));
  expect(call).toBeDefined();
  return { sql: call![0] as string, body: JSON.parse(res.body) };
}

/** The body of the WHERE clause that defines the population, up to the window predicate. */
function populationClause(sql: string): string {
  const where = sql.lastIndexOf('WHERE m.is_bot = true');
  expect(where).toBeGreaterThan(-1);
  return sql.slice(where, sql.indexOf('m.created_at >= lower(', where));
}

describe('each step average publishes the population it is taken over', () => {
  it('counts the turns that stamped each step, with the same column the average reads', async () => {
    const { sql } = await run('latency_metrics');
    expect(sql).toMatch(/COUNT\(m\.router_ms\)\s+AS\s+router_measured_count/);
    expect(sql).toMatch(/COUNT\(m\.guard_ms\)\s+AS\s+guard_measured_count/);
    // Already published, and the population of avg_placeholder_resolve_ms and avg_classifier_ms.
    expect(sql).toMatch(/COUNT\(m\.placeholder_resolve_ms\)\s+AS\s+placeholder_measured_count/);
    expect(sql).toMatch(/COUNT\(m\.classifier_ms\)\s+AS\s+classified_by_model_count/);
  });

  it('declares the counts in the column contract', async () => {
    const { body } = await run('latency_metrics');
    expect(body.columns).toEqual(expect.arrayContaining([
      'router_measured_count', 'guard_measured_count', 'placeholder_measured_count', 'classified_by_model_count',
      'ttff_measured_count',
    ]));
  });

  it('computes no residual of TTFF against the router, which spans two populations and two clocks', async () => {
    const { sql } = await run('latency_metrics');
    expect(sql).not.toMatch(/response_latency_ms\s*-\s*[\w.(]*router_ms/);
    expect(sql).not.toMatch(/avg_ttff_ms\s*-\s*avg_router_ms/);
  });
});

describe('the turn count is named for what it counts', () => {
  it('is assistant_turn_count, and exchange_count is not a latency_metrics column', async () => {
    const { sql, body } = await run('latency_metrics');
    expect(body.columns).toContain('assistant_turn_count');
    expect(body.columns).not.toContain('exchange_count');
    expect(sql).toMatch(/COUNT\(\*\)\s+AS\s+assistant_turn_count/);
    expect(sql).not.toMatch(/AS\s+exchange_count\b/);
  });
});

describe('the unpaired turns are one population in both queries', () => {
  it('latency_metrics and unpaired_bot_messages read the same assistant-turn predicate', async () => {
    const latency = populationClause((await run('latency_metrics')).sql);
    const unpaired = populationClause((await run('unpaired_bot_messages')).sql);
    const predicate = "(e.id IS NOT NULL OR m.total_ms IS NOT NULL OR m.content LIKE '%<!--corr:%')";
    expect(latency).toContain(predicate);
    expect(unpaired).toContain(predicate);
    // unpaired_bot_messages narrows to compute telemetry nowhere else: a marker-carrying turn with no
    // compute and no exchange is counted by both or by neither.
    expect(unpaired).not.toMatch(/AND m\.total_ms IS NOT NULL/);
  });

  it('latency_metrics publishes the unpaired share of its turn count', async () => {
    const { sql, body } = await run('latency_metrics');
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE e\.id IS NULL\) AS unpaired_turn_count/);
    expect(body.columns).toContain('unpaired_turn_count');
  });
});
