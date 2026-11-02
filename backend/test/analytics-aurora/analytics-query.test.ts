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

import { handler, resolveReplyCostUsd, battlePickAxis, approvalAxis, successTerminalStates } from '../../lambda/src/analytics-aurora/analytics-query';
import { clusterMomentsOf } from '../../lambda/src/lib/experiment-stats';
import { analyticsPathFor } from '../helpers/analytics-path';
import { DEFAULT_COMPLIANCE_RULES } from '../../lib/config/compliance-rules';
import { edgeContext } from '../helpers/edge-context';

/** The blocking rule ids the effectiveness query is handed, derived the same way the query derives
 *  them. Listing them literally here would let a rule's severity change in the config and not in the
 *  test, which is the drift the config exists to prevent. */
const BLOCKING_IDS = DEFAULT_COMPLIANCE_RULES.filter((r) => r.severity === 'blocking').map((r) => r.id);

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    // Posted where the console posts it: the queryType's own capability resource.
    path: analyticsPathFor(body),
    body: JSON.stringify(body),
    requestContext: {
      authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }),
    },
  } as unknown as APIGatewayProxyEvent;
}

const VALID_RANGE = { start: '2026-05-13', end: '2026-05-20' };
/** The range VALID_RANGE runs as: both named days included, so the upper bound is the day after the end. */
const VALID_WINDOW = '[2026-05-13T00:00:00.000Z,2026-05-21T00:00:00.000Z)';

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
          intent: 'general', assistant: 'premium', exchange_count: '40', avg_score: '82',
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

    // THREE DB queries: the A/B rollup (battle EXCLUDED), the battle-scoped one (filter INVERTED),
    // and the duel-dimension lookup that credits each win to the row that earned it.
    //
    // FOUND BY CONTENT, NOT BY INDEX. This asserted `calls[1]` was the battle SQL, which is true only
    // while the count and the order both hold - so adding a third query failed it for a reason that
    // had nothing to do with what it is about. Two of these issue concurrently; pinning their order
    // pins a scheduling detail.
    // A FOURTH read, the per-conversation units (§4.2), states each variant's sample in conversations
    // beside its exchanges; it fails open in this view, so the unmocked call here leaves the table intact.
    const sqls = mockDbQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls).toHaveLength(4);
    expect(sqls.some((s: string) => /GROUP BY experiment_id, variant_id, conversation/.test(s))).toBe(true);
    const abSql = sqls.find((s: string) => /= 'probabilistic'/.test(s) && !/per_conversation/.test(s))!;
    const battleSql = sqls.find((s: string) => /= 'battle'/.test(s))!;
    const dimsSql = sqls.find((s: string) => /SELECT DISTINCT e\.battle_id/.test(s))!;
    expect(abSql).toBeDefined();
    expect(battleSql).toBeDefined();
    expect(dimsSql).toBeDefined();
    expect(battleSql).not.toMatch(/= 'probabilistic'/);
    // ONE ROW PER TURN. The probabilistic sibling has excluded queued turns since the column existed
    // and this query did not, so a turn answered out of the queue was counted by its own exchange AND
    // its queued one - inflating turn_count and double-weighting that turn in the average a duel is
    // entirely made of.
    expect(battleSql).toMatch(/e\.queued_as IS NULL/);
    // The dimensions are GROUPED, not merely filtered: a reviewer who cannot see which rooms a
    // variant was tried in cannot tell a real win from one that only ever ran in the easy room.
    expect(battleSql).toMatch(/GROUP BY m\.experiment_id, m\.variant_id,/);
    for (const dim of ['e.conversation_classification', 'e.assistant', 'e.assistant_role', 'e.profile_version']) {
      expect(battleSql).toContain(dim);
    }
    // A VERSION IS GROUPED BY ITS FINGERPRINT (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5): a candidate is
    // served under the live identity, so (assistant, profile_version) alone cannot tell it from the live
    // assistant's own version, and the duel-dimension lookup keys on the same tuple.
    expect(battleSql).toMatch(/GROUP BY m\.experiment_id, m\.variant_id,[^`]*e\.profile_config_id\n/);
    expect(dimsSql).toContain('e.profile_config_id');
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

describe('Aurora analytics-query — battle_results: one row per DUEL', () => {
  const duelRow = {
    battle_id: 'b-1',
    fought_at: '2026-05-14T10:00:00.000Z',
    channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c',
    conversation_classification: 'premium',
    experiment_id: 'exp-1',
    rounds: '2',
    sides: '2',
    turn_count: '4',
    contenders: [
      { variant_id: 'control', assistant: 'advisor', assistant_role: 'primary', profile_version: 7, profile_config_id: 'cfg-live', model_name: 'm1', turn_count: '2', avg_score: '80' },
      { variant_id: 'treatment', assistant: 'advisor', assistant_role: 'primary', profile_version: 9, profile_config_id: 'cfg-cand', model_name: 'm2', turn_count: '2', avg_score: null },
    ],
  };

  it('nests the sides under the duel, so nothing has to re-pair them', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [duelRow] });

    const res = await handler(postEvent({ queryType: 'battle_results', dateRange: VALID_RANGE }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.data).toHaveLength(1);
    const d = body.data[0];
    expect(d).toMatchObject({ battle_id: 'b-1', rounds: 2, sides: 2, turn_count: 4 });
    // Each side keeps its OWN version. That the two differ is frequently the whole experiment, and a
    // per-variant rollup cannot show it against a specific duel.
    expect(d.contenders.map((c: any) => c.profile_version)).toEqual([7, 9]);
    // And its fingerprint, which is what tells a candidate from the live version it was derived from.
    expect(d.contenders.map((c: any) => c.profile_config_id)).toEqual(['cfg-live', 'cfg-cand']);
    // An unscored side reports null, never 0 — the honesty contract the rollup holds too.
    expect(d.contenders[1].avg_score).toBeNull();
  });

  it('NOT JUDGED is not a tie, and an unjudged duel still renders', async () => {
    // A duel nobody voted on has no pick at all. Reporting that as a tie would turn every unwatched
    // duel into evidence of parity, which is a conclusion nobody drew.
    mockDbQuery.mockResolvedValueOnce({ rows: [duelRow] });

    const res = await handler(postEvent({ queryType: 'battle_results', dateRange: VALID_RANGE }));
    const body = JSON.parse(res.body);
    expect(body.data[0].winner_variant_id).toBeNull();
    expect(body.data[0].decided_at).toBeNull();
  });

  it('SCOPES BY DUEL, not by row, so a filter cannot return half a comparison', async () => {
    // THE DEFECT THIS SHAPE AVOIDS. Filtering the turn rows directly would return the side that
    // matched and drop its rival — so asking for version 9 would show a duel with one contender and
    // no comparison, which is the only reason the row exists. The filter therefore selects BATTLE
    // IDS and the body loads every side of the battles that matched.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await handler(postEvent({
      queryType: 'battle_results',
      dateRange: VALID_RANGE,
      profileVersion: '9',
      conversationClassification: 'premium',
      assistantRole: 'primary',
      agentType: 'advisor',
    }));

    const sql = String(mockDbQuery.mock.calls[0][0]);
    const params = mockDbQuery.mock.calls[0][1] as unknown[];
    // The scope lands inside the id-selecting CTE...
    expect(sql).toMatch(/WITH matched AS \(\s*SELECT DISTINCT e\.battle_id/);
    // ...and the body joins back to it, rather than repeating the predicates.
    expect(sql).toMatch(/JOIN matched ON matched\.battle_id = e\.battle_id/);
    // Every filter is a bound parameter with a fixed SQL text — no value is concatenated in.
    expect(params).toEqual(expect.arrayContaining(['premium', 'advisor', 'primary', 9]));
    expect(sql).not.toContain("'premium'");
    // One row per turn here too: a queued duplicate would double a side's turn_count.
    expect(sql).toMatch(/e\.queued_as IS NULL/);
  });

  it('names the /battle message that started the duel, by its Amazon Chime SDK MessageId and its own time', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await handler(postEvent({ queryType: 'battle_results', dateRange: VALID_RANGE }));
    const sql = String(mockDbQuery.mock.calls[0][0]);

    // Read through a round-one exchange's user_message_id: that is the person's /battle message.
    expect(sql).toMatch(/JOIN messages um ON um\.id = se\.user_message_id/);
    expect(sql).toMatch(/se\.battle_id = b\.battle_id/);
    expect(sql).toMatch(/COALESCE\(se\.battle_round, 1\) = 1/);
    // message_id is the Chime id the viewer matches; created_at is the message's own time.
    expect(sql).toMatch(/um\.message_id AS start_message_id/);
    expect(sql).toMatch(/um\.created_at AS started_at/);
    // A LEFT lookup, so a duel with no start message is still listed, and fought_at stands in.
    expect(sql).toMatch(/LEFT JOIN LATERAL \(\s*SELECT um\.created_at/);
    expect(sql).toMatch(/COALESCE\(s\.started_at, b\.fought_at\) AS started_at/);
    // The population and its order are the duel's, unchanged.
    expect(sql).toMatch(/ORDER BY b\.fought_at DESC\s+LIMIT \$8 OFFSET \$9/);
  });

  it('returns started_at and start_message_id per duel, and fought_at when no message was found', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { ...duelRow, started_at: '2026-05-14T09:59:58.000Z', start_message_id: 'chime-msg-1' },
        { ...duelRow, battle_id: 'b-2', started_at: undefined, start_message_id: null },
      ],
    });
    const res = await handler(postEvent({ queryType: 'battle_results', dateRange: VALID_RANGE }));
    const body = JSON.parse(res.body);
    expect(body.data[0]).toMatchObject({ started_at: '2026-05-14T09:59:58.000Z', start_message_id: 'chime-msg-1' });
    expect(body.data[1]).toMatchObject({ started_at: duelRow.fought_at, start_message_id: null });
    expect(body.columns).toEqual(expect.arrayContaining(['started_at', 'start_message_id']));
  });

  it('a non-numeric version is EVERY version, not a cast that errors the review', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await handler(postEvent({ queryType: 'battle_results', dateRange: VALID_RANGE, profileVersion: 'latest' }));
    const params = mockDbQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain(null);
    expect(params).not.toContain('latest');
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
    // The vote-scope read: which agent messages are in THIS page's filtered population, so the
    // thumbs fold counts only votes left on them. It is a second query by necessity - the thumbs
    // live in DynamoDB and can only be narrowed from Aurora.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

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
    expect(sql).toMatch(/e\.created_at >= lower\(\$1::tstzrange\) AND e\.created_at < upper\(\$1::tstzrange\)/);
    // $1 is VALID_RANGE with both days included. L0 = no intent filter → $2 is NULL; $3 agentType NULL (unscoped).
    // $4 is the BLOCKING rule ids, read off the rule set rather than listed here - a second list of
    // 'the important ones' in a test is how a rule gets downgraded in one place and not the other.
    // $5 is the ROOM's classification, which became its own filter when $3 (agent_type) stopped
    // carrying the classification and started naming the assistant that answered.
    expect(args).toEqual([VALID_WINDOW, null, null, BLOCKING_IDS, null, null, null, null, null, null, null]);
  });

  it('filters the ROOM CLASSIFICATION separately from the ASSISTANT that answered', async () => {
    // These were the same filter while `agent_type` carried the classification, and the console sent
    // its classification dropdown as `agentType`. That column names the ASSISTANT now,
    // so a classification sent there would filter by an assistant nobody is called and return an empty
    // dashboard. The two are separate parameters against separate columns.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // the vote-scope read

    const res = await handler(postEvent({
      queryType: 'intent_effectiveness',
      conversationClassification: 'premium',
      agentType: 'advisor',
      dateRange: VALID_RANGE,
    }));

    expect(res.statusCode).toBe(200);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/\$3::varchar IS NULL OR e\.assistant = \$3/);
    expect(sql).toMatch(/\$5::varchar IS NULL OR e\.conversation_classification = \$5/);
    // The assistant lands in $3 and the room's classification in $5 - never the same slot.
    expect(args).toEqual([VALID_WINDOW, null, 'advisor', BLOCKING_IDS, 'premium', null, null, null, null, null, null]);

    // AND THE VOTE SCOPE CARRIES THE SAME FILTERS. This is the whole point of the second read: the
    // thumbs scan cannot filter on an assistant, so if this query does not narrow, every user-signal
    // column on the page is somebody else's.
    const [scopeSql, scopeArgs] = mockDbQuery.mock.calls[1];
    expect(scopeSql).toMatch(/\$3::varchar IS NULL OR e\.assistant = \$3/);
    expect(scopeSql).toMatch(/\$4::varchar IS NULL OR e\.conversation_classification = \$4/);
    expect(scopeArgs).toEqual([VALID_WINDOW, null, 'advisor', 'premium', null, null, null, null, null, null]);
  });

  it('L1: an intent param drills to one intent via the $2 IS NULL OR filter', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ intent: 'report_generation', exchange_count: '12', dominant_model: null }] });

    const res = await handler(postEvent({ queryType: 'intent_effectiveness', intent: 'report_generation', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/\$2::varchar IS NULL OR COALESCE\(e\.task_type, e\.intent\) = \$2/);
    expect(args).toEqual([VALID_WINDOW, 'report_generation', null, BLOCKING_IDS, null, null, null, null, null, null, null]);
    expect(JSON.parse(res.body).data[0]).toHaveProperty('cost_per_reply_usd', null);
  });

  it('a WORKFLOW REFUSAL is counted on its own and is not a tool error', async () => {
    // The task workflow refusing a move it forbids (`illegal_transition`, `requirement_unsourced`...)
    // is recorded on the step as `errorClass: 'workflow_refusal'`. The model corrects it in the same
    // loop and nothing failed, so an intent whose workflow holds the model to its steps must not read
    // as a broken tool.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ intent: 'data_extraction', exchange_count: '4', dominant_model: null, tool_calls: '6', tool_errors: '0', workflow_refusals: '2', tool_error_rate: '0.0' }],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // the vote-scope read

    const res = await handler(postEvent({ queryType: 'intent_effectiveness', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const sql = String(mockDbQuery.mock.calls[0][0]);
    const toolAgg = sql.slice(sql.indexOf('tool_agg AS'), sql.indexOf('FROM exchanges e', sql.indexOf('tool_agg AS')));
    // Errors are the failed calls that are NOT refusals; a step with no class (written before the
    // class existed) stays an error, which is why the predicate is IS DISTINCT FROM and not <>.
    expect(toolAgg).toMatch(/FILTER \(WHERE \(t->>'ok'\) = 'false'\s+AND \(t->>'errorClass'\) IS DISTINCT FROM 'workflow_refusal'\) AS tool_errors/);
    expect(toolAgg).toMatch(/FILTER \(WHERE \(t->>'ok'\) = 'false'\s+AND \(t->>'errorClass'\) = 'workflow_refusal'\) AS workflow_refusals/);
    // The rate is still failures over every call, so a refusal neither raises it nor hides the call.
    expect(sql).toMatch(/ROUND\(\(ta\.tool_errors \* 100\.0 \/ NULLIF\(ta\.tool_calls, 0\)\)::numeric, 1\) AS tool_error_rate/);
    expect(sql).toMatch(/COALESCE\(ta\.workflow_refusals, 0\) AS workflow_refusals/);

    const body = JSON.parse(res.body);
    expect(body.columns).toEqual(expect.arrayContaining(['tool_errors', 'tool_error_rate', 'workflow_refusals']));
    expect(body.data[0]).toMatchObject({ tool_errors: '0', workflow_refusals: '2' });
  });

  it('a PLATFORM ACTION is counted per intent from steps[].action, apart from the model\'s tool calls', async () => {
    // A declared step action (SPEC-TASK-STATE-TRANSITIONS FR29) is recorded as its own step carrying an
    // `action` object and no `tools`, so it can never land in tool_calls; it is counted on its own.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ intent: 'report_generation', exchange_count: '3', dominant_model: null, tool_calls: '2', tool_errors: '0', workflow_refusals: '0', platform_actions: '4' }],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // the vote-scope read

    const res = await handler(postEvent({ queryType: 'intent_effectiveness', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    const sql = String(mockDbQuery.mock.calls[0][0]);
    const actionAgg = sql.slice(sql.indexOf('action_agg AS'), sql.indexOf('GROUP BY COALESCE(e.task_type, e.intent)', sql.indexOf('action_agg AS')));
    expect(actionAgg).toMatch(/COUNT\(\*\) AS platform_actions/);
    // Read from the steps array of the answer's sibling row, one row per step that carries an action.
    expect(actionAgg).toMatch(/jsonb_array_elements\(/);
    expect(actionAgg).toMatch(/jsonb_typeof\(s->'action'\) = 'object'/);
    // The same population as tool_agg: one row per turn, the folded queue rows excluded.
    expect(actionAgg).toMatch(/e\.queued_as IS NULL/);
    expect(actionAgg).not.toMatch(/s->'tools'/);
    expect(sql).toMatch(/COALESCE\(aa\.platform_actions, 0\) AS platform_actions/);
    expect(sql).toMatch(/LEFT JOIN action_agg aa ON aa\.intent = ex_agg\.intent/);

    const body = JSON.parse(res.body);
    expect(body.columns).toEqual(expect.arrayContaining(['platform_actions']));
    expect(body.data[0]).toMatchObject({ tool_calls: '2', platform_actions: '4' });
  });
});

describe('Aurora analytics-query — L2 drills (intent_exchanges + task_details filter)', () => {
  it('intent_exchanges with an intent → 200 with the per-exchange list, scoped + bounded', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ exchange_id: 'ex-1', relevance_score: '88', total_ms: '1200' }] });

    const res = await handler(postEvent({ queryType: 'intent_exchanges', intent: 'general_query', dateRange: VALID_RANGE }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(1);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE COALESCE\(e\.task_type, e\.intent\) = \$1/);
    expect(sql).toMatch(/ORDER BY e\.created_at DESC/);
    expect(sql).toMatch(/LIMIT \$3 OFFSET \$5/);
    // intent, window, default limit, agentType (unscoped), offset (page 0)
    expect(args).toEqual(['general_query', VALID_WINDOW, 100, null, 0]);
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
    expect(sql).toMatch(/\$3::varchar IS NULL OR COALESCE\(task_type, intent\) = \$3/);
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
    // the window, the 5 signup steps and the entry step, bound (never interpolated).
    expect(params[1]).toEqual(expect.arrayContaining(['signup_form_viewed', 'signup_confirmation_completed']));
    expect(params[2]).toBe('signup_form_viewed');
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
    // ROUTE KEY ('general'). Matching on the string would silently return nothing.
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

  it('reads the served definition from the archived columns first, the metadata after', async () => {
    // The row an exchange joins to is the placeholder's CREATE, whose metadata carries none of the three;
    // archival folds them onto it as columns, so a read of the metadata alone is null on an answered turn.
    const { sql } = await call({ experimentId: 'exp1' });
    expect(sql).toContain("COALESCE(e.profile_name, m.profile_name, m.metadata->>'profileName') AS profile_name");
    expect(sql).toContain("COALESCE(e.profile_version, m.profile_version, NULLIF(m.metadata->>'profileVersion', '')::int) AS profile_version");
    expect(sql).toContain("COALESCE(e.profile_config_id, m.profile_config_id, m.metadata->>'profileConfigId') AS profile_config_id");
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
    // Every archival suffix, a per-event update id (migration 084) among them, strips to the base id.
    expect(sql).toContain("regexp_replace(m.message_id, '-(UPD(-[0-9a-f]{12})?|RED|DEL)$', '') || '-RED'");
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
    intent: 'general',
    assistant: 'premium',
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

/**
 * A row of the per-conversation units read (fetchExperimentUnits), built from per-conversation value lists
 * the way the SQL builds it, so a test states its data as conversations rather than as moments. The same
 * values stand for the score, the latency and the tokens.
 */
function unitsRowFromClusters(variantId: string, clusters: number[][], experimentId = 'exp-1') {
  const m = clusterMomentsOf(clusters);
  return {
    experiment_id: experimentId,
    variant_id: variantId,
    conversation_count: String(m.clusters),
    exchange_count: String(m.n),
    n_sq: String(m.clusterSizeSq),
    lat_sum: m.sum, lat_sumsq: m.sumSq, lat_tot_sq: m.clusterTotalSq, lat_tot_n: m.clusterTotalTimesSize,
    tok_sum: m.sum, tok_sumsq: m.sumSq, tok_tot_sq: m.clusterTotalSq, tok_tot_n: m.clusterTotalTimesSize,
    scored_conversation_count: String(m.clusters),
    scored_count: String(m.n),
    sn_sq: String(m.clusterSizeSq),
    sc_sum: m.sum, sc_sumsq: m.sumSq, sc_tot_sq: m.clusterTotalSq, sc_tot_n: m.clusterTotalTimesSize,
  };
}

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
    intent: 'general',
    assistant: 'premium',
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

  /** The per-conversation units read for a variant whose every conversation holds ONE exchange (design
   *  effect 1), so the per-exchange figures above are also the per-conversation ones. */
  const singletonUnits = (variantId: string, n = 40) => unitsRowFromClusters(
    variantId,
    Array.from({ length: n }, (_, i) => [80 + ((i % 5) - 2) * 4]),
  );

  const recommend = async (rows: unknown[], body: Record<string, unknown> = {}, units?: unknown[]) => {
    mockDbQuery.mockResolvedValueOnce({ rows });
    mockDbQuery.mockResolvedValueOnce({
      rows: units ?? (rows as Array<{ variant_id: string }>).map((r) => singletonUnits(r.variant_id)),
    });
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

  // ── THE UNIT OF ANALYSIS (§4.2) ─────────────────────────────────────────────────────────────────
  //
  // Two hundred exchanges a side, five quality points apart. Counted per exchange that is significant.
  // If those exchanges are ten conversations of twenty turns, each conversation consistent within itself
  // and conversations far apart, it is ten observations a side and not significant.
  const LEVELS = [50, 58, 66, 74, 82, 90, 98, 106, 114, 122];
  const arm = (shift: number) => LEVELS.map((l) => Array.from({ length: 20 }, (_, j) => l + shift + ((j % 3) - 1) * 0.5));
  const correlatedRows = [
    variantRow('control', { exchange_count: '200', scored_count: '200', avg_score: '86', score_sd: '23.04' }),
    variantRow('treatment', { exchange_count: '200', scored_count: '200', avg_score: '91', score_sd: '23.04' }),
  ];

  it('counted as two hundred independent conversations, the five points would promote the treatment', async () => {
    const body = await recommend(correlatedRows, {}, [singletonUnits('control', 200), singletonUnits('treatment', 200)]);
    expect(body.primary.significant).toBe(true);
    expect(body.verdict).toBe('promote_treatment');
  });

  it('as the ten conversations a side they are, the same five points are not significant', async () => {
    const body = await recommend(correlatedRows, {}, [
      unitsRowFromClusters('control', arm(0)),
      unitsRowFromClusters('treatment', arm(5)),
    ]);
    expect(body.primary.significant).toBe(false);
    expect(body.verdict).not.toBe('promote_treatment');
    expect(body.primary.deltaPct).toBeCloseTo(5.8, 1); // the point estimate is the per-exchange one
  });

  it('reports the unit and both counts, so an operator sees conversations beside exchanges', async () => {
    const body = await recommend(correlatedRows, {}, [
      unitsRowFromClusters('control', arm(0)),
      unitsRowFromClusters('treatment', arm(5)),
    ]);
    expect(body.unit).toBe('conversation');
    const control = body.variants.find((v: any) => v.variant_id === 'control');
    expect(control).toMatchObject({ unit: 'conversation', conversation_count: 10, exchange_count: 200, scored_conversation_count: 10 });
    expect(String(body.rationale)).toMatch(/Tested per conversation: control 10 conversations \(200 exchanges\)/);
  });

  it('the sample floor counts conversations: thirty exchanges in three conversations is below a floor of five', async () => {
    const three = Array.from({ length: 3 }, () => Array.from({ length: 10 }, () => 80));
    const body = await recommend(
      [variantRow('control', { exchange_count: '30' }), variantRow('treatment', { exchange_count: '30' })],
      {},
      [unitsRowFromClusters('control', three), unitsRowFromClusters('treatment', three)],
    );
    expect(body.verdict).toBe('inconclusive');
    expect(String(body.rationale)).toMatch(/3 conversations, below the 5-conversation floor/);
  });

  it('the units read counts the population the rollup counts, grouped by conversation, with no intent clause', async () => {
    // An `intent` experiment counts only turns of its intent because the router stamps only those
    // (`countsTowardExperiment`); the reader relies on that stamp and adds no intent predicate of its own,
    // which would miss the route-key/intent renaming the stamp already resolved.
    await recommend([variantRow('control'), variantRow('treatment')]);
    const [rowsSql, rowsParams] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    const [unitsSql, unitsParams] = mockDbQuery.mock.calls[1] as [string, unknown[]];
    expect(unitsSql).toMatch(/GROUP BY experiment_id, variant_id, conversation/);
    expect(unitsSql).toContain('COALESCE(e.channel_arn, e.id::text) AS conversation');
    // The same population parameters; the rollup binds one more, the success states its completion count reads.
    expect(rowsParams.slice(0, unitsParams.length)).toEqual(unitsParams);
    expect(rowsParams.slice(unitsParams.length)).toEqual([successTerminalStates()]);
    const start = rowsSql.indexOf('WHERE m.experiment_id IS NOT NULL');
    const rowsWhere = rowsSql.slice(start, rowsSql.indexOf('GROUP BY', start)).trim();
    expect(unitsSql).toContain(rowsWhere);
    expect(rowsWhere).toContain('m.experiment_id = $2');
    expect(rowsWhere).not.toMatch(/e\.intent/);
  });
});

describe('Aurora analytics-query — unserved_subjects: candidates for new intents', () => {
  it('counts general and off-topic turns, offer turns included, against their conversation subjects', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ subject: 'vendor contracts', intent: 'general', turns: '14', conversations: '6' }] });
    const res = await handler(postEvent({ queryType: 'unserved_subjects', dateRange: VALID_RANGE }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data[0]).toMatchObject({ subject: 'vendor contracts', turns: '14' });
    const [sql] = mockDbQuery.mock.calls[0] as [string];
    // Answered turns from exchanges, and the turns a drift offer answered, which are never exchanges.
    expect(sql).toContain("e.intent IN ('general', 'off_topic')");
    expect(sql).toContain('FROM drift_events d');
    expect(sql).toContain("COALESCE(d.source, 'live') = 'live'");
    // Against the conversation's latest subjects.
    expect(sql).toContain('DISTINCT ON (channel_arn) channel_arn, topics');
  });
});
