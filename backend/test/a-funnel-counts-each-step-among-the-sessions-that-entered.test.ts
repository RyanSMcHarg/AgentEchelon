/**
 * A FUNNEL COUNTS EACH STEP AMONG THE SESSIONS THAT ENTERED IT, in both analytics modes.
 *
 * The sign-in funnel counted each step's distinct sessions on its own, so a session that signed in with no
 * form view recorded before it raised the success step and not the entry step. On dev that read "Sign-in
 * success: 105.6%" (19 sessions signed in, 18 viewed the form). The funnel is now session-ordered: a step
 * counts for a session only at or after that session's first entry step, so every step is a subset of the
 * entry step and a conversion read off it cannot pass 100%. A session outside the funnel is returned apart,
 * as `sessions_outside_funnel`, rather than dropped.
 *
 * Neither SQL engine runs here, so this proves the shape both modes share: the same steps and entry step
 * from one definition (`lib/session-funnels.ts`), the same columns, the entry step anchored per session,
 * and each count gated on the event time against that anchor.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn().mockRejectedValue(new Error('no model in tests')) })),
  InvokeModelCommand: jest.fn((input: unknown) => input),
}));

import { handler as auroraHandler } from '../lambda/src/analytics-aurora/analytics-query';
import { __testing as athena } from '../lambda/src/analytics-query';
import { SIGNIN_FUNNEL, SIGNUP_FUNNEL, SESSION_FUNNEL_COLUMNS, type SessionFunnel } from '../lambda/src/lib/session-funnels';
import { analyticsPathFor } from './helpers/analytics-path';
import { edgeContext } from './helpers/edge-context';

const FUNNELS: Array<[string, SessionFunnel]> = [
  ['signin_funnel_conversion', SIGNIN_FUNNEL],
  ['signup_funnel_conversion', SIGNUP_FUNNEL],
];

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: analyticsPathFor(body),
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}

/** The SQL and bound parameters the Aurora mode runs for a funnel. */
async function auroraSql(queryType: string): Promise<{ sql: string; params: unknown[] }> {
  mockDbQuery.mockReset().mockResolvedValue({ rows: [] });
  const res = await auroraHandler(postEvent({ queryType, dateRange: { start: '2026-10-01', end: '2026-10-30' } }));
  expect(res.statusCode).toBe(200);
  const [sql, params] = mockDbQuery.mock.calls[0];
  return { sql: String(sql), params: params as unknown[] };
}

const athenaSql = (queryType: string): string => {
  const sql = athena.buildQuery(queryType, '2026-10-01', '2026-10-30');
  if (!sql) throw new Error(`Athena serves no ${queryType}`);
  return sql;
};

/** The column aliases a SELECT list names, in order. */
const selectedColumns = (sql: string): string[] => {
  const select = sql.slice(sql.lastIndexOf('SELECT'), sql.lastIndexOf('FROM ev'));
  return [...select.matchAll(/\bAS\s+([a-z_]+)/gi)].map((m) => m[1]);
};

describe('the funnel definition', () => {
  it.each(FUNNELS)('%s enters at its first step and succeeds at one of its steps', (_q, funnel) => {
    expect(funnel.steps[0]).toBe(funnel.entryStep);
    expect(funnel.steps).toContain(funnel.successStep);
  });
});

describe.each(FUNNELS)('%s in the Aurora mode', (queryType, funnel) => {
  it('binds the steps and the entry step, never interpolating them', async () => {
    const { sql, params } = await auroraSql(queryType);
    expect(params[1]).toEqual([...funnel.steps]);
    expect(params[2]).toBe(funnel.entryStep);
    for (const st of funnel.steps) expect(sql).not.toContain(`'${st}'`);
  });

  it('anchors each session at its first entry step and counts a step only at or after it', async () => {
    const { sql } = await auroraSql(queryType);
    expect(sql).toMatch(/entered AS \(\s*SELECT session_id, MIN\(created_at\) AS entered_at\s+FROM ev\s+WHERE event_type = \$3\s+GROUP BY session_id/);
    expect(sql).toMatch(/LEFT JOIN entered ON entered\.session_id = ev\.session_id/);
    expect(sql).toMatch(/COUNT\(DISTINCT ev\.session_id\) FILTER \(WHERE ev\.created_at >= entered\.entered_at\) AS session_count/);
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE ev\.created_at >= entered\.entered_at\) AS event_count/);
    // Never the old shape, which counted every step's sessions independently of the entry step.
    expect(sql).not.toMatch(/COUNT\(DISTINCT session_id\) AS session_count/);
  });

  it('returns the sessions outside the funnel apart, and in funnel order', async () => {
    const { sql } = await auroraSql(queryType);
    expect(selectedColumns(sql)).toEqual([...SESSION_FUNNEL_COLUMNS]);
    expect(sql).toMatch(/ORDER BY array_position\(\$2::text\[\], ev\.event_type\)/);
  });
});

describe.each(FUNNELS)('%s in the Athena mode', (queryType, funnel) => {
  it('anchors each session at its first entry step and counts a step only at or after it', () => {
    const sql = athenaSql(queryType);
    expect(sql).toMatch(new RegExp(`entered AS \\(\\s*SELECT session_id, MIN\\(at\\) as entered_at\\s+FROM ev\\s+WHERE event_type = '${funnel.entryStep}'\\s+GROUP BY session_id`));
    expect(sql).toMatch(/LEFT JOIN entered ON entered\.session_id = ev\.session_id/);
    expect(sql).toMatch(/COUNT\(DISTINCT CASE WHEN ev\.at >= entered\.entered_at THEN ev\.session_id END\) as session_count/);
    expect(sql).toMatch(/COUNT_IF\(ev\.at >= entered\.entered_at\) as event_count/);
    expect(sql).toContain('"timestamp" as at');
  });

  it('reads exactly the funnel steps, in funnel order', () => {
    const sql = athenaSql(queryType);
    expect(sql).toContain(`event_type IN (${funnel.steps.map((st) => `'${st}'`).join(', ')})`);
    expect(sql).toContain(`CASE ev.event_type ${funnel.steps.map((st, i) => `WHEN '${st}' THEN ${i + 1}`).join(' ')} ELSE 99 END`);
  });
});

describe.each(FUNNELS)('%s answers the same columns in both modes', (queryType) => {
  it('so the console reads one shape whichever mode the deployment runs', async () => {
    const { sql } = await auroraSql(queryType);
    expect(selectedColumns(athenaSql(queryType))).toEqual(selectedColumns(sql));
    expect(selectedColumns(athenaSql(queryType))).toEqual([...SESSION_FUNNEL_COLUMNS]);
  });
});
