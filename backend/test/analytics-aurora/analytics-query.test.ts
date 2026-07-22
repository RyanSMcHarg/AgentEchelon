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

import { handler, resolveReplyCostUsd } from '../../lambda/src/analytics-aurora/analytics-query';

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

describe('Aurora analytics-query — task_timeline (Effectiveness L3, SPEC-TASK-STATE-TRANSITIONS §6)', () => {
  it('task_timeline with a taskId → 200 with the per-turn state timeline', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { task_state: 'collecting_requirements', task_transition: null },
        { task_state: 'generating', task_transition: { from: 'drafting_outline', to: 'generating' } },
      ],
    });

    const res = await handler(postEvent({ queryType: 'task_timeline', taskId: 'task-abc', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.unsupported).toBeUndefined();
    expect(body.data).toHaveLength(2);
    // Ordered by created_at, scoped to the requested task.
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE e\.task_id = \$1/);
    expect(sql).toMatch(/ORDER BY e\.created_at ASC/);
    expect(sql).toMatch(/metadata->'steps'/); // L4 steps ride the L3 row
    expect(args).toEqual(['task-abc']);
  });

  it('task_timeline without a taskId → honest empty, no DB call', async () => {
    const res = await handler(postEvent({ queryType: 'task_timeline', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toEqual([]);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe('resolveReplyCostUsd (L0 cost column, D4) — null-honesty + coercion', () => {
  it('returns null when there is no model to price against', () => {
    expect(resolveReplyCostUsd({ dominant_model: null, avg_input_tokens: '100', avg_output_tokens: '50' })).toBeNull();
    expect(resolveReplyCostUsd({ avg_input_tokens: 100, avg_output_tokens: 50 })).toBeNull();
  });

  it('returns null for a model the rate table cannot price (never a guessed 0)', () => {
    expect(resolveReplyCostUsd({ dominant_model: 'not-a-real-model', avg_input_tokens: '100', avg_output_tokens: '50' })).toBeNull();
  });

  it('prices an image-gen turn per-image (0 tokens) from avg_image_count', () => {
    // gpt-image-1 has no text-catalog rate; the image path prices it per image
    // (IMAGE_GEN_RATE_USD_PER_IMAGE.openai_gpt_image_1 = 0.04). avg 2 images => 0.08.
    expect(
      resolveReplyCostUsd({
        dominant_model: 'gpt-image-1',
        avg_input_tokens: '0',
        avg_output_tokens: '0',
        avg_image_count: '2',
      }),
    ).toBeCloseTo(0.08, 6);
  });

  it('ignores a stray avg_image_count when the dominant model is a text model (no image-path null)', () => {
    // A text intent that happened to record an imageCount on a stray row must still
    // price on tokens, not route the text model into the null-returning image path.
    const cost = resolveReplyCostUsd({
      dominant_model: 'anthropic.claude-sonnet-4-6',
      avg_input_tokens: '1000',
      avg_output_tokens: '500',
      avg_image_count: '1',
    });
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
});

describe('Aurora analytics-query — intent_effectiveness (Effectiveness L0)', () => {
  it('runs the per-intent rollup and stamps cost_per_reply_usd on every row', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { intent: 'report_generation', exchange_count: '12', dominant_model: null, avg_input_tokens: '800', avg_output_tokens: '400', tool_error_rate: '0.0' },
        { intent: 'general_query', exchange_count: '30', dominant_model: 'not-a-real-model', avg_input_tokens: '200', avg_output_tokens: '120', tool_error_rate: '5.0' },
      ],
    });

    const res = await handler(postEvent({ queryType: 'intent_effectiveness', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.unsupported).toBeUndefined();
    expect(body.data).toHaveLength(2);
    // Cost resolved (null-honest here since neither model is priceable) and present on every row.
    for (const row of body.data) expect(row).toHaveProperty('cost_per_reply_usd', null);

    // The query is the documented spine: exchange rollup + flow composite (30/25/15/15/15) + tool lens.
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/WITH ex_agg AS/);
    expect(sql).toMatch(/flow_agg AS/);
    expect(sql).toMatch(/tool_agg AS/);
    expect(sql).toMatch(/\* 0\.30/); // outcome weight in the flow composite
    expect(sql).toMatch(/WHEN 'high' THEN 100 WHEN 'medium' THEN 50 WHEN 'low' THEN 0/);
    expect(sql).toMatch(/NOW\(\) - INTERVAL '1 day' \* \$1/);
    // L0 = no intent filter → $2 is NULL (7-day window from VALID_RANGE); $3 agentType NULL (unscoped).
    expect(args).toEqual([7, null, null]);
  });

  it('L1: an intent param drills to one intent via the $2 IS NULL OR filter', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ intent: 'report_generation', exchange_count: '12', dominant_model: null }] });

    const res = await handler(postEvent({ queryType: 'intent_effectiveness', intent: 'report_generation', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/\$2::varchar IS NULL OR e\.intent = \$2/);
    expect(args).toEqual([7, 'report_generation', null]);
    expect(JSON.parse(res.body).data[0]).toHaveProperty('cost_per_reply_usd', null);
  });
});

describe('Aurora analytics-query — L2 drills (intent_exchanges + task_details filter)', () => {
  it('intent_exchanges with an intent → 200 with the per-exchange list, scoped + bounded', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ exchange_id: 'ex-1', relevance_score: '88', total_ms: '1200' }] });

    const res = await handler(postEvent({ queryType: 'intent_exchanges', intent: 'general_query', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(1);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE e\.intent = \$1/);
    expect(sql).toMatch(/ORDER BY e\.created_at DESC/);
    expect(sql).toMatch(/LIMIT \$3 OFFSET \$5/);
    // intent, window, default limit, agentType (unscoped), offset (page 0)
    expect(args).toEqual(['general_query', 7, 100, null, 0]);
  });

  it('intent_exchanges without an intent → honest empty, no DB call', async () => {
    const res = await handler(postEvent({ queryType: 'intent_exchanges', dateRange: VALID_RANGE }));
    expect(JSON.parse(res.body).data).toEqual([]);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('task_details accepts an intent filter (L2 task list) as $3', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ task_id: 'task-1', type: 'report_generation', task_state: 'generating' }] });

    const res = await handler(postEvent({ queryType: 'task_details', intent: 'report_generation', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/\$3::varchar IS NULL OR intent = \$3/);
    expect(args[2]).toBe('report_generation');
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
