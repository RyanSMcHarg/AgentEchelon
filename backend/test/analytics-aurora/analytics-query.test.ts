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

// The recommendation's rationale is NARRATION over an already-computed verdict, and the model call
// that renders it falls back to the deterministic template on any failure. Mocked as a failure so the
// recommendation tests read that template, which is the prose an operator sees when the model is
// unavailable, and so no test reaches the network.
const mockBedrockSend = jest.fn().mockRejectedValue(new Error('no model in tests'));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn((input: unknown) => input),
}));

import { handler, resolveReplyCostUsd, battlePickAxis, approvalAxis } from '../../lambda/src/analytics-aurora/analytics-query';

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

describe('Aurora analytics-query: experiment_results carries a battle-scoped effectiveness view (SPEC-BATTLE)', () => {
  it('returns the A/B rollup in `data` AND a separate, battle-only `battleEffectiveness` section (image-aware cost)', async () => {
    // Call 1: the probabilistic A/B rollup (fetchExperimentRows).
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          experiment_id: 'exp-battle', variant_id: 'control', model_name: 'anthropic.claude-sonnet-4-6',
          intent: 'general_qa', agent_type: 'premium', exchange_count: '40', avg_score: '82',
          avg_total_ms: '1200', p95_total_ms: '1800', avg_input_tokens: '1000', avg_output_tokens: '500',
          avg_tokens: '1500', avg_image_count: null, compliance_rate: '100', fallback_count: '0',
          task_count: '0', task_completed_count: '0',
        },
      ],
    });
    // Call 2: the battle-scoped rows (fetchBattleEffectivenessRows): a text variant + an image variant.
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          experiment_id: 'exp-battle', variant_id: 'control', model_name: 'anthropic.claude-sonnet-4-6',
          turn_count: '6', avg_score: '84', avg_input_tokens: '1000', avg_output_tokens: '500', avg_image_count: null,
        },
        {
          experiment_id: 'exp-battle', variant_id: 'treatment', model_name: 'gpt-image-1',
          turn_count: '4', avg_score: null, avg_input_tokens: '0', avg_output_tokens: '0', avg_image_count: '2',
        },
      ],
    });

    const res = await handler(postEvent({ queryType: 'experiment_results', dateRange: VALID_RANGE }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // The probabilistic A/B rollup is unchanged and stays in `data`.
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ experiment_id: 'exp-battle', variant_id: 'control' });

    // Two DB queries: the A/B rollup (battle EXCLUDED), then the battle-scoped one (filter INVERTED),
    // keyed by (experiment, variant) with the variant's dominant model via MODE().
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const abSql = String(mockDbQuery.mock.calls[0][0]);
    const battleSql = String(mockDbQuery.mock.calls[1][0]);
    expect(abSql).toMatch(/= 'probabilistic'/);
    expect(battleSql).toMatch(/= 'battle'/);
    expect(battleSql).not.toMatch(/= 'probabilistic'/);
    expect(battleSql).toMatch(/GROUP BY m\.experiment_id, m\.variant_id/);
    expect(battleSql).toMatch(/MODE\(\) WITHIN GROUP/);

    // The battle-scoped section rides ALONGSIDE `data`, never folded into it.
    const be = body.battleEffectiveness;
    expect(Array.isArray(be.data)).toBe(true);
    expect(be.data).toHaveLength(2);
    const ctrl = be.data.find((r: { variant_id: string }) => r.variant_id === 'control');
    const trt = be.data.find((r: { variant_id: string }) => r.variant_id === 'treatment');
    // Text variant: priced on tokens (non-null, positive); relevance passes through.
    expect(ctrl).toMatchObject({ turn_count: 6, avg_score: 84 });
    expect(ctrl.avg_cost_usd).toBeGreaterThan(0);
    // Image variant: PER-IMAGE cost from avg_image_count (gpt-image-1 @ $0.04 × 2 = $0.08, 0 tokens),
    // and an unscored variant reports a null quality (honesty contract), not 0.
    expect(trt.avg_score).toBeNull();
    expect(trt.avg_cost_usd).toBeCloseTo(0.08, 6);
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

// ---------------------------------------------------------------------------
// The human battle-pick axis (§4.3).
//
// It is a SEPARATE axis from the metric verdict, measured on a DIFFERENT population: the metric read
// counts probabilistic traffic, which deliberately EXCLUDES battle turns, while every pick comes FROM
// a battle. It therefore must NOT be gated behind the metric sample floor — doing so withheld the
// human signal exactly when battles were the evidence being gathered, so a battle-led evaluation could
// collect any number of picks and still report no human block at all.
// ---------------------------------------------------------------------------
describe('battlePickAxis', () => {
  const v = (control: number | null, treatment: number | null) => ([
    { variant_id: 'control', battle_wins: control },
    { variant_id: 'treatment', battle_wins: treatment },
  ]);

  it('returns null when no pick has been recorded, so "no battles" differs from "split 50/50"', () => {
    // A zero-filled axis would render as a real 0% result and read as evidence. Absence is not a tie.
    expect(battlePickAxis(v(0, 0))).toBeNull();
    expect(battlePickAxis(v(null, null))).toBeNull();
  });

  it('returns null for a single-variant experiment (nothing head-to-head to compare)', () => {
    expect(battlePickAxis([{ variant_id: 'control', battle_wins: 3 }])).toBeNull();
  });

  it('reports TREATMENT share of decisive picks, oriented like the metric delta', () => {
    // 5 of 6 for treatment. Same orientation as the metric axis so >50% and a positive delta agree.
    const r = battlePickAxis(v(1, 5))!;
    expect(r.picks).toBe(6);
    expect(r.winRate).toBeCloseTo(5 / 6, 5);
    expect(r.ci[0]).toBeLessThan(r.winRate);
    expect(r.ci[1]).toBeGreaterThan(r.winRate);
  });

  it('a lopsided but TINY sample is not called decisive', () => {
    // 2-0 looks unanimous and is not evidence: the Wilson interval still spans 50%.
    const r = battlePickAxis(v(0, 2))!;
    expect(r.picks).toBe(2);
    expect(r.significant).toBe(false);
  });

  it('a large, one-sided sample IS decisive (the interval clears 50%)', () => {
    const r = battlePickAxis(v(3, 30))!;
    expect(r.significant).toBe(true);
    expect(r.ci[0]).toBeGreaterThan(0.5);
  });

  it('counts only DECISIVE picks — a tie credits neither side and never reaches battle_wins', () => {
    // Ties carry no variantId upstream, so `picks` is the decisive count, not every battle fought.
    expect(battlePickAxis(v(2, 2))!.picks).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// User approval (thumbs) as a TESTED rate.
//
// `GUIDE-AB-TESTING-AND-BATTLES` listed approval among the rate metrics that "each use the appropriate
// test, and the difference is reported with a confidence interval". That was untrue: approval is not
// in ExperimentObjectiveMetric (cost|accuracy|quality|latency), so it could be neither a primary
// metric nor a guardrail, and experiment-stats.ts referenced it nowhere. It was collected, displayed,
// and never evaluated. These pin the claim to real arithmetic.
// ---------------------------------------------------------------------------
describe('approvalAxis', () => {
  const v = (cUp: number, cN: number, tUp: number, tN: number) => ([
    { variant_id: 'control', thumbs_up: cUp, feedback_count: cN },
    { variant_id: 'treatment', thumbs_up: tUp, feedback_count: tN },
  ]);

  it('returns null when nobody has voted, so "no votes" never renders as "0% approval"', () => {
    expect(approvalAxis(v(0, 0, 0, 0))).toBeNull();
    expect(approvalAxis([{ variant_id: 'control', thumbs_up: 1, feedback_count: 1 }])).toBeNull();
  });

  it('reports both rates and a treatment-minus-control delta, matching the metric orientation', () => {
    const r = approvalAxis(v(5, 10, 9, 10))!;
    expect(r.controlRate).toBeCloseTo(0.5, 5);
    expect(r.treatmentRate).toBeCloseTo(0.9, 5);
    expect(r.delta).toBeCloseTo(0.4, 5);   // treatment - control, positive = treatment better
    expect(r.votes).toBe(20);
  });

  it('carries a CI on the DIFFERENCE and only calls it significant when that CI excludes zero', () => {
    // A tiny, lopsided sample must NOT read as decisive — the interval still spans zero.
    const small = approvalAxis(v(1, 2, 2, 2))!;
    expect(small.significant).toBe(false);
    expect(small.ci[0]).toBeLessThan(0);
    // A large, clearly separated sample does.
    const big = approvalAxis(v(20, 100, 80, 100))!;
    expect(big.significant).toBe(true);
    expect(big.ci[0]).toBeGreaterThan(0);
  });

  it('an equal split is reported, not suppressed — zero delta is a real finding', () => {
    const r = approvalAxis(v(5, 10, 5, 10))!;
    expect(r.delta).toBeCloseTo(0, 5);
    expect(r.significant).toBe(false);
    expect(r.votes).toBe(20);
  });

  it('votes on only ONE side still produce an axis (a real asymmetry, not missing data)', () => {
    const r = approvalAxis(v(0, 0, 4, 5))!;
    expect(r.votes).toBe(5);
    expect(r.treatmentRate).toBeCloseTo(0.8, 5);
  });
});

// ---------------------------------------------------------------------------
// experiment_exchanges — the drill-down behind a result (DESIGN §4.3).
//
// The correctness requirement is the PREDICATE: this must resolve to exactly the set the aggregate
// scored. A drill-down filtered more loosely surfaces exchanges that did not count toward the number
// beside it, which is worse than no drill-down. These assert the predicate, not the rendering.
// ---------------------------------------------------------------------------
describe('experiment_exchanges', () => {
  const call = async (body: Record<string, unknown>) => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(postEvent({ queryType: 'experiment_exchanges', ...body }) as any);
    return { res, sql: (mockDbQuery.mock.calls.at(-1)?.[0] ?? '') as string, params: mockDbQuery.mock.calls.at(-1)?.[1] };
  };

  beforeEach(() => mockDbQuery.mockReset());

  it('without an experimentId returns EMPTY and never queries — an unscoped drill-down is the bug', () => {
    // Returning every experiment's exchanges would be exactly the "wrong set" failure.
    return handler(postEvent({ queryType: 'experiment_exchanges' }) as any).then((res: any) => {
      expect(JSON.parse(res.body).data).toEqual([]);
      expect(mockDbQuery).not.toHaveBeenCalled();
    });
  });

  it('scopes on experiment_id, NOT on the intent string', async () => {
    // The stored exchange intent is the CLASSIFIER intent ('general'); the experiment stores the
    // ROUTE KEY ('general_qa'). Matching on the string would silently return nothing.
    const { sql, params } = await call({ experimentId: 'exp1' });
    expect(sql).toContain('m.experiment_id = $2');
    expect(params).toContain('exp1');
  });

  it("axis 'metrics' EXCLUDES battle turns — the same population the A/B rollup scores", async () => {
    const { sql } = await call({ experimentId: 'exp1' });
    expect(sql).toMatch(/assignmentMode[\s\S]*<>\s*'battle'/);
  });

  it("axis 'battle' is the complement: battle turns ONLY, where the picks come from", async () => {
    const { sql } = await call({ experimentId: 'exp1', axis: 'battle' });
    expect(sql).toMatch(/assignmentMode[\s\S]*=\s*'battle'/);
    expect(sql).not.toMatch(/assignmentMode[\s\S]*<>\s*'battle'/);
  });

  it('returns the values that ROLL UP, so the aggregate can be recomputed', async () => {
    // A list of links cannot be recalculated from; these are the columns the mean is built out of.
    const { sql } = await call({ experimentId: 'exp1' });
    for (const col of ['relevance_score', 'total_ms', 'input_tokens', 'output_tokens', 'variant_id']) {
      expect(sql).toContain(col);
    }
  });

  it('carries redaction flags but KEEPS the row — it still counted toward the score', async () => {
    // Dropping redacted rows would break reconciliation and misrepresent what the verdict used.
    const { sql } = await call({ experimentId: 'exp1' });
    expect(sql).toContain('redacted');
    expect(sql).toContain('deleted');
    expect(sql).not.toMatch(/WHERE[\s\S]*red\.id IS NULL/);
  });

  it('derives retraction from the -RED/-DEL SIBLING ROW, not from moderation_actions', async () => {
    // Two different failures hide behind this, and neither can surface in a suite that mocks the
    // database. `moderation_actions.message_id` holds the Chime message id while `messages.id` is a
    // UUID, so joining them is a Postgres type error that only appears against a real DB. And that
    // table is an ATTRIBUTION record, not the moderation record: it is written only for moderations
    // performed through the admin console, by a follow-up call whose failure the console swallows on
    // purpose. The moderation itself is a Chime SDK call, so the event stream carries every one and
    // archival writes the -RED/-DEL sibling row — the authority the admin conversation read uses.
    const { sql } = await call({ experimentId: 'exp1' });
    expect(sql).toContain('REDACT_CHANNEL_MESSAGE');
    expect(sql).toContain('DELETE_CHANNEL_MESSAGE');
    expect(sql).toMatch(/regexp_replace\(m\.message_id, '-\(UPD\|RED\|DEL\)\$', ''\) \|\| '-RED'/);
    expect(sql).not.toMatch(/JOIN\s+moderation_actions/i);
  });

  it('reports the FULL match count, not the page size', async () => {
    // A page without a total cannot be reconciled, and a silent sample reads as a complete set.
    const { sql } = await call({ experimentId: 'exp1' });
    expect(sql).toContain('COUNT(*) OVER()');
  });
});

// ---------------------------------------------------------------------------
// The experiment rollup that feeds the ship recommendation.
//
// Two things about this read are correctness requirements rather than style. It must resolve ONE
// relevance per exchange, because a second evaluation row fans the join out and inflates the sample
// size behind the Welch tests, and it must report how many exchanges were actually SCORED, because a
// mean built from unscored placeholder zeros is not evidence about quality.
// ---------------------------------------------------------------------------
describe('experiment_results — the rollup resolves one evaluation per exchange', () => {
  const experimentRow = (over: Record<string, unknown> = {}) => ({
    experiment_id: 'exp-1',
    variant_id: 'control',
    model_name: 'anthropic.claude-sonnet-4-6',
    intent: 'general_qa',
    agent_type: 'premium',
    exchange_count: '40',
    scored_count: '40',
    avg_score: '80',
    score_sd: '10',
    avg_total_ms: '1200',
    latency_sd: '300',
    p95_total_ms: '1800',
    avg_input_tokens: '1000',
    avg_output_tokens: '500',
    avg_tokens: '1500',
    tokens_sd: '200',
    avg_image_count: null,
    compliance_rate: '100',
    fallback_count: '0',
    task_count: '0',
    task_completed_count: '0',
    ...over,
  });

  beforeEach(() => mockDbQuery.mockReset());

  it('pre-aggregates evaluation_results per exchange, so a duplicate row cannot inflate n', async () => {
    // A duplicate exchange-type evaluation is reachable: overlapping evaluation-runner invocations
    // race the unscored select and both insert. Joined raw, that exchange is counted twice by
    // COUNT(*) and double-weighted in AVG/STDDEV, and the inflated n reaches the Welch tests behind
    // the recommendation while the drill-down beside it, which pre-aggregates, reports the true count.
    mockDbQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    await handler(postEvent({ queryType: 'experiment_results', dateRange: VALID_RANGE }));

    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toMatch(/FROM evaluation_results\s+WHERE evaluation_type = 'exchange'\s+GROUP BY exchange_id/);
    // And never the raw join, which is what fanned out.
    expect(sql).not.toMatch(/JOIN evaluation_results er ON/);
  });

  it('reports scored_count alongside exchange_count — traffic and evidence are different numbers', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [experimentRow({ scored_count: '12' })] }).mockResolvedValueOnce({ rows: [] });

    const res = await handler(postEvent({ queryType: 'experiment_results', dateRange: VALID_RANGE }));

    expect(String(mockDbQuery.mock.calls[0][0])).toMatch(/COUNT\(er\.relevance_score\) AS scored_count/);
    const body = JSON.parse(res.body);
    expect(body.data[0]).toMatchObject({ exchange_count: '40', scored_count: 12 });
  });
});

// ---------------------------------------------------------------------------
// experiment_recommendation — what the verdict is allowed to claim.
//
// This is the end an operator reads a ship or no-ship decision off, so the cases pinned here are the
// ones where the number and the sentence beside it could disagree.
// ---------------------------------------------------------------------------
describe('experiment_recommendation', () => {
  const variantRow = (variantId: string, over: Record<string, unknown> = {}) => ({
    experiment_id: 'exp-1',
    variant_id: variantId,
    model_name: 'anthropic.claude-sonnet-4-6',
    intent: 'general_qa',
    agent_type: 'premium',
    exchange_count: '40',
    scored_count: '40',
    avg_score: '80',
    score_sd: '10',
    avg_total_ms: '1200',
    latency_sd: '300',
    p95_total_ms: '1800',
    avg_input_tokens: '1000',
    avg_output_tokens: '500',
    avg_tokens: '1500',
    tokens_sd: '200',
    avg_image_count: null,
    compliance_rate: '100',
    fallback_count: '0',
    task_count: '0',
    task_completed_count: '0',
    ...over,
  });

  const recommend = async (rows: unknown[], body: Record<string, unknown> = {}) => {
    mockDbQuery.mockResolvedValueOnce({ rows });
    const res = await handler(
      postEvent({ queryType: 'experiment_recommendation', experimentId: 'exp-1', dateRange: VALID_RANGE, ...body }),
    );
    return JSON.parse(res.body);
  };

  beforeEach(() => mockDbQuery.mockReset());

  it('an experiment with NOTHING scored reports not-enough-evidence, never "equivalent"', async () => {
    // Unscored exchanges count as zero in the mean, so both variants read mean 0 / sd 0, Welch takes
    // its degenerate branch, and the sample floor is satisfied by traffic alone. That combination
    // narrated two entirely unmeasured variants as "equivalent on quality".
    const unscored = { scored_count: '0', avg_score: '0', score_sd: null };
    const body = await recommend([variantRow('control', unscored), variantRow('treatment', unscored)]);

    expect(body.verdict).toBe('keep_running');
    expect(body.verdict).not.toBe('equivalent');
    expect(body.primary.powered).toBe(false);
    expect(String(body.rationale)).not.toMatch(/equivalent/i);
  });

  it('the same experiment WITH scores can still reach a real equivalence verdict', async () => {
    // The gate must block the unmeasured case only. With the scoring done, "no difference" stands as
    // an answer rather than being downgraded to "keep running".
    const body = await recommend([variantRow('control'), variantRow('treatment')]);

    expect(body.verdict).toBe('equivalent');
    expect(body.primary.powered).toBe(true);
  });

  it('narrates a guardrail that is merely NOT ESTABLISHED as such, never as held', async () => {
    // Latency +7.5% against a 10% bound, on an interval running from -3.8% to +18.8%. It is neither
    // proven within the bound nor proven past it, and calling that "Guardrails held" claims the one
    // thing the interval is too wide to support, next to a verdict that has already declined to ship.
    const body = await recommend(
      [variantRow('control'), variantRow('treatment', { avg_total_ms: '1290' })],
      { objective: { metric: 'quality', guardrails: [{ metric: 'latency', direction: 'no_worse_than', bound: 10 }] } },
    );

    expect(body.guardrails).toHaveLength(1);
    expect(body.guardrails[0]).toMatchObject({ metric: 'latency', bound: 10, held: false, breached: false });
    expect(String(body.rationale)).toMatch(/not established/i);
    expect(String(body.rationale)).not.toMatch(/Guardrails held/);
  });
});
