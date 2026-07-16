/**
 * analytics-query categorisation + input validation.
 *
 * Covers the "honest empty" contract added in the conv-UX silent-gap fix:
 *   - Aurora-only queryTypes return 200 with { unsupported: true, reason }
 *     so the admin dashboard can render a clear banner instead of a
 *     silently-empty table.
 *   - Genuinely unknown queryTypes still return 400 (surfaces typos
 *     and FE/BE version skew).
 *   - dateRange.start/end are strictly validated to prevent SQL
 *     injection into the Athena query string (Athena has no
 *     parameterised query API; dates are interpolated).
 *
 * The Athena execution path is not exercised here - that's covered by
 * the deployment validation step.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Stub the AWS SDK before importing the handler. Any test that reached
// the Athena path would fail loud rather than silently no-op.
jest.mock('@aws-sdk/client-athena', () => ({
  AthenaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockRejectedValue(new Error('test: athena should not be called')),
  })),
  StartQueryExecutionCommand: jest.fn(),
  GetQueryExecutionCommand: jest.fn(),
  GetQueryResultsCommand: jest.fn(),
  QueryExecutionState: { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' },
}));

import { handler, __testing } from '../lambda/src/analytics-query';

function event(body: unknown): APIGatewayProxyEvent {
  // The handler requires admin claims.
  // Default test event is admin-authed so the existing test cases keep
  // covering query-shape logic. Tests that specifically exercise the
  // authz boundary should pass a custom event without the admins group.
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' },
      },
    },
  } as unknown as APIGatewayProxyEvent;
}

const VALID_RANGE = { start: '2026-05-13', end: '2026-05-20' };

describe('analytics-query — Aurora-only queryTypes return honest-empty 200', () => {
  it.each([
    'evaluation_exchanges',
    'evaluation_flows',
    'flagged_responses',
    'ground_truth',
    'task_metrics',
    'task_details',
    'conversation_summaries',
    'drift_events',
    'cross_conversation_context',
    'model_effectiveness',
    'experiment_results',
  ])('%s → 200 with unsupported: true', async (queryType) => {
    const res = await handler(event({ queryType, dateRange: VALID_RANGE }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      data: [],
      columns: [],
      unsupported: true,
    });
    expect(typeof body.reason).toBe('string');
    expect(body.reason.toLowerCase()).toContain('aurora');
  });
});

describe('analytics-query — input validation', () => {
  it('rejects unknown queryType with 400 (not silent empty)', async () => {
    const res = await handler(event({ queryType: 'totally_made_up', dateRange: VALID_RANGE }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Unknown queryType');
  });

  it('rejects missing queryType with 400', async () => {
    const res = await handler(event({ dateRange: VALID_RANGE }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-ISO dateRange with 400 (SQL-injection guard)', async () => {
    const malicious = "2026-05-20'; DROP TABLE conversations;--";
    const res = await handler(event({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-05-13', end: malicious },
    }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects impossible dates (2026-13-99) with 400', async () => {
    const res = await handler(event({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-13-99', end: '2026-05-20' },
    }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects reversed dateRange (start > end) with 400', async () => {
    const res = await handler(event({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-05-20', end: '2026-05-13' },
    }));
    expect(res.statusCode).toBe(400);
  });

  it('accepts valid ISO dateRange with equal start and end', async () => {
    // Use an Aurora-only queryType so we don't hit the Athena client.
    const res = await handler(event({
      queryType: 'flagged_responses',
      dateRange: { start: '2026-05-20', end: '2026-05-20' },
    }));
    expect(res.statusCode).toBe(200);
  });
});

describe('validateDate — pure', () => {
  const { validateDate } = __testing;

  it('accepts a well-formed ISO date', () => {
    expect(validateDate('2026-05-20')).toBe('2026-05-20');
  });

  it.each([
    '2026/05/20',          // wrong separator
    '20-05-2026',          // wrong order
    '2026-5-20',           // unpadded month
    "2026-05-20'--",       // injection attempt
    '2026-05-20T00:00:00', // timestamp not date
    42,                    // non-string
    null,
    undefined,
    {},
  ])('rejects %p', (v) => {
    expect(validateDate(v as unknown)).toBeNull();
  });
});

describe('buildQuery — evaluation_scores aliases match EvaluationScoreData', () => {
  it('emits the columns the EvaluationsTab consumes', () => {
    const sql = __testing.buildQuery('evaluation_scores', '2026-05-13', '2026-05-20');
    expect(sql).toBeTruthy();
    // EvaluationScoreData fields: date, agent_type, intent_type,
    // avg_relevance_score, count. The frontend tab keys off these.
    expect(sql).toMatch(/as\s+date/i);
    expect(sql).toMatch(/as\s+agent_type/i);
    expect(sql).toMatch(/as\s+intent_type/i);
    expect(sql).toMatch(/as\s+avg_relevance_score/i);
    expect(sql).toMatch(/as\s+count/i);
  });

  it('returns null for queryTypes not in SUPPORTED_TYPES (defensive: caller already guards)', () => {
    expect(__testing.buildQuery('flagged_responses', '2026-05-13', '2026-05-20')).toBeNull();
  });
});

describe('SUPPORTED_TYPES / AURORA_ONLY_TYPES — disjoint', () => {
  it('a queryType is in at most one set', () => {
    const supported = Array.from(__testing.SUPPORTED_TYPES);
    const aurora = Array.from(__testing.AURORA_ONLY_TYPES);
    const overlap = supported.filter(t => aurora.includes(t));
    expect(overlap).toEqual([]);
  });
});

describe('buildQuery — client-events rollups', () => {
  // The dashboard reads specific column names; pin them so a SQL edit can't
  // silently break the renderer.
  const range: [string, string] = ['2026-05-13', '2026-05-21'];

  it('active_users_daily exposes date, user_tier, active_users', () => {
    const sql = __testing.buildQuery('active_users_daily', ...range);
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/from\s+client_events/i);
    expect(sql).toMatch(/event_type\s*=\s*'session_started'/);
    expect(sql).toMatch(/COUNT\(DISTINCT\s+user_id\)/i);
    expect(sql).toMatch(/as\s+active_users/i);
  });

  it('active_messaging_users_daily unions ws-connect, message_sent, list-messages', () => {
    const sql = __testing.buildQuery('active_messaging_users_daily', ...range);
    expect(sql).toBeTruthy();
    // Engagement signals — distinct from session DAU above.
    expect(sql).toMatch(/websocket_connected/);
    expect(sql).toMatch(/message_sent/);
    expect(sql).toMatch(/channel_messages_listed/);
    // Must NOT collapse to session_started — that's the wrong signal here.
    expect(sql).not.toMatch(/session_started/);
    expect(sql).toMatch(/COUNT\(DISTINCT\s+user_id\)/i);
    expect(sql).toMatch(/as\s+active_messaging_users/i);
  });

  it('messages_per_user ranks users by message_count', () => {
    const sql = __testing.buildQuery('messages_per_user', ...range);
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/event_type\s*=\s*'message_sent'/);
    expect(sql).toMatch(/as\s+message_count/i);
    expect(sql).toMatch(/order\s+by\s+message_count\s+desc/i);
  });

  it('messages_per_tier_daily groups by date + tier', () => {
    const sql = __testing.buildQuery('messages_per_tier_daily', ...range);
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/user_tier/);
    expect(sql).toMatch(/as\s+date/i);
  });

  it('error_rate_daily emits error_count and total_events', () => {
    const sql = __testing.buildQuery('error_rate_daily', ...range);
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/as\s+error_count/i);
    expect(sql).toMatch(/as\s+total_events/i);
  });

  it('signup_funnel_conversion orders steps by canonical sequence', () => {
    const sql = __testing.buildQuery('signup_funnel_conversion', ...range);
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/signup_form_viewed/);
    expect(sql).toMatch(/signup_confirmation_completed/);
    expect(sql).toMatch(/order\s+by[\s\S]*case/i);
  });

  it('signin_funnel_conversion is shaped like signup', () => {
    const sql = __testing.buildQuery('signin_funnel_conversion', ...range);
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/signin_form_viewed/);
    expect(sql).toMatch(/signin_succeeded/);
  });

  it('page_load_metrics returns p50/p95/p99 over perf_value', () => {
    const sql = __testing.buildQuery('page_load_metrics', ...range);
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/record_type\s*=\s*'performance'/);
    expect(sql).toMatch(/APPROX_PERCENTILE\(perf_value,\s*0\.50\)/i);
    expect(sql).toMatch(/APPROX_PERCENTILE\(perf_value,\s*0\.95\)/i);
    expect(sql).toMatch(/APPROX_PERCENTILE\(perf_value,\s*0\.99\)/i);
  });

  it('connection_health_daily counts connect / disconnect / reconnect per day', () => {
    const sql = __testing.buildQuery('connection_health_daily', ...range);
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/websocket_connected/);
    expect(sql).toMatch(/websocket_disconnected/);
    expect(sql).toMatch(/websocket_reconnected/);
  });
});
