/**
 * Aurora analytics-query POST shim (the Athena-contract bridge).
 *
 * The frontend POSTs { queryType, dateRange } for BOTH analytics modes. In
 * Aurora mode this handler maps each supported queryType to a native Postgres
 * query and normalizes the result to { data: [...] }. Anything with no Aurora
 * mapping returns 200 { unsupported: true, reason } so the dashboard banners
 * honestly instead of silently emptying.
 *
 * Regression guard: `conversation_volumes` (the Overview headline metric) MUST
 * be served in Aurora, not reported unsupported — an Aurora deployment
 * otherwise mis-tells the operator to "redeploy with analyticsMode=aurora".
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

const VALID_RANGE = { start: '2026-05-13', end: '2026-05-20' };

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureSchema.mockResolvedValue(undefined);
});

describe('Aurora analytics-query — conversation_volumes is served natively', () => {
  it('conversation_volumes → 200 with data, NOT unsupported', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ date: '2026-05-20', message_count: '5', conversation_count: '2' }],
    });

    const res = await handler(postEvent({ queryType: 'conversation_volumes', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.unsupported).toBeUndefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ message_count: '5', conversation_count: '2' });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it('a queryType with no Aurora mapping → 200 { unsupported: true }', async () => {
    const res = await handler(postEvent({ queryType: 'totally_made_up', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.unsupported).toBe(true);
    expect(typeof body.reason).toBe('string');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe('Aurora is a strict superset — no metric is Athena-only', () => {
  // Every query type Athena serves must be served in Aurora too (never
  // unsupported). These read the message tables or client_events.
  const SUPERSET_TYPES = [
    'intent_distribution',
    'user_activity',
    'active_users_daily',
    'active_messaging_users_daily',
    'messages_per_user',
    'messages_per_tier_daily',
    'error_rate_daily',
    'signup_funnel_conversion',
    'signin_funnel_conversion',
    'page_load_metrics',
    'connection_health_daily',
  ];

  it.each(SUPERSET_TYPES)('%s → 200 with data, NEVER unsupported', async (queryType) => {
    mockDbQuery.mockResolvedValue({ rows: [{ some: 'row' }] });

    const res = await handler(postEvent({ queryType, dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.unsupported).toBeUndefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(mockDbQuery).toHaveBeenCalled();
  });

  it('signup_funnel_conversion passes the canonical step allow-list as bound params', async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    await handler(postEvent({ queryType: 'signup_funnel_conversion', dateRange: VALID_RANGE }));

    const [, params] = mockDbQuery.mock.calls[0];
    // days + the 5 signup steps, bound (never interpolated).
    expect(params).toEqual(expect.arrayContaining(['signup_form_viewed', 'signup_confirmation_completed']));
  });
});

describe('drift_events reads the by-reference table (migration 006), not the dropped one', () => {
  it('getDriftEvents queries drift_events, never the dropped drift_detection', async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });

    const res = await handler(postEvent({ queryType: 'drift_events', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const sql = mockDbQuery.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toContain('drift_events');
    expect(sql).not.toContain('FROM drift_detection');
    // by-reference columns, not the removed topic/resolved columns
    expect(sql).toContain('cosine_distance');
    expect(sql).not.toContain('original_topic');
  });
});
