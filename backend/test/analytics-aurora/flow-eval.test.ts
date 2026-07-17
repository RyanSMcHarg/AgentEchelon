/**
 * Flow-eval (Pass B) — multi-turn task-flow scoring into intent_flows.
 * Pins the weighted composite, the selection (unscored/grown flows), and the
 * idempotent upsert.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn((input) => ({ input })),
}));
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn() }));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { handler, flowComposite } from '../../lambda/src/analytics-aurora/evaluation-runner';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function bedrockJson(obj: unknown) {
  const payload = JSON.stringify({ content: [{ text: JSON.stringify(obj) }] });
  return { body: new TextEncoder().encode(payload) };
}

describe('flow-eval (Pass B)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('composite is the documented weighted sum (30/25/15/15/15)', () => {
    expect(flowComposite({ outcomeScore: 100, informationScore: 100, efficiencyScore: 100, contextRetentionScore: 100, uxScore: 100 })).toBe(100);
    expect(flowComposite({ outcomeScore: 0, informationScore: 0, efficiencyScore: 0, contextRetentionScore: 0, uxScore: 0 })).toBe(0);
    // Only outcome perfect → 30
    expect(flowComposite({ outcomeScore: 100, informationScore: 0, efficiencyScore: 0, contextRetentionScore: 0, uxScore: 0 })).toBe(30);
    // Only information perfect → 25
    expect(flowComposite({ outcomeScore: 0, informationScore: 100, efficiencyScore: 0, contextRetentionScore: 0, uxScore: 0 })).toBe(25);
  });

  it('selects unscored/grown flows, scores holistically, and upserts intent_flows', async () => {
    // 1) Pass A: no unscored exchanges. 2) Pass B: one flow to score. 3) its turns. 4) upsert.
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // getUnscoredExchanges (Pass A)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', channel_arn: 'c1', intent: 'general', user_type: 'human', agent_type: 'premium', exchange_count: 2, first_at: '2026-07-15T00:00:00Z', last_at: '2026-07-15T00:05:00Z' }], rowCount: 1 } as any) // getFlowsToScore
      .mockResolvedValueOnce({ rows: [{ user_message: 'build me a report', agent_response: 'starting…' }, { user_message: 'yes', agent_response: 'Done — report ready.' }], rowCount: 2 } as any) // getTaskExchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // upsert

    mockSend.mockResolvedValueOnce(bedrockJson({
      outcomeScore: 90, informationScore: 80, efficiencyScore: 70, contextRetentionScore: 85, uxScore: 75,
      outcome: 'report delivered', status: 'completed', reasoning: 'ok',
    }));

    const res = await handler({});
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.flowsScored).toBe(1);
    expect(body.flowErrors).toBe(0);

    // selection query filters unscored-or-grown
    const [selSql] = mockedQuery.mock.calls[1] as [string];
    expect(selSql).toMatch(/task_agg/);
    expect(selSql).toMatch(/f\.task_id IS NULL OR t\.exchange_count > COALESCE\(f\.exchange_count, 0\)/);

    // upsert is idempotent on task_id and writes all five dimension scores
    const [upSql, upParams] = mockedQuery.mock.calls[3] as [string, unknown[]];
    expect(upSql).toMatch(/INSERT INTO intent_flows/);
    expect(upSql).toMatch(/ON CONFLICT \(task_id\) DO UPDATE/);
    expect(upParams).toEqual(expect.arrayContaining(['task-1', 'c1', 'general', 'completed', 90, 70, 85, 75, 80]));
    // turn_count = messages ≈ 2 × exchanges (2 turns → 4)
    expect(upParams).toContain(4);
  });

  it('Pass A stamps the flow join keys (task_id + flow_id subquery) at write time [P1]', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1', channel_arn: 'c1', agent_type: 'premium', user_type: 'human', intent: 'report_generation', task_id: 'task-1', created_at: '2026-07-15T00:00:00Z', user_message: 'build me a report', agent_response: 'starting…' }], rowCount: 1 } as any) // getUnscoredExchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // getPriorTurns (context)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // INSERT evaluation_results
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // getFlowsToScore (Pass B: nothing)
    mockSend.mockResolvedValueOnce(bedrockJson({ relevanceScore: 88, classification: 'good', reasoning: 'on task' }));

    await handler({});

    const insert = mockedQuery.mock.calls.find(([sql]) => /INSERT INTO evaluation_results/.test(sql as string));
    expect(insert).toBeDefined();
    const [sql, params] = insert as [string, unknown[]];
    // task_id + flow_id columns present; flow_id resolved via the intent_flows subquery on task_id.
    expect(sql).toMatch(/task_id,\s*flow_id/);
    expect(sql).toMatch(/SELECT id FROM intent_flows WHERE task_id = \$9/);
    expect(params[8]).toBe('task-1'); // $9 = ex.task_id
  });

  it('Pass B backfills flow_id onto Pass A rows scored before the flow existed [P1]', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // Pass A: none
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', channel_arn: 'c1', intent: 'general', user_type: 'human', agent_type: 'premium', exchange_count: 2, first_at: '2026-07-15T00:00:00Z', last_at: '2026-07-15T00:05:00Z' }], rowCount: 1 } as any) // getFlowsToScore
      .mockResolvedValueOnce({ rows: [{ user_message: 'build me a report', agent_response: 'starting…' }, { user_message: 'yes', agent_response: 'done' }], rowCount: 2 } as any) // getTaskExchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // upsert intent_flows
      .mockResolvedValueOnce({ rows: [], rowCount: 3 } as any); // backfill UPDATE evaluation_results
    mockSend.mockResolvedValueOnce(bedrockJson({ outcomeScore: 90, informationScore: 80, efficiencyScore: 70, contextRetentionScore: 85, uxScore: 75, outcome: 'ok', status: 'completed', reasoning: 'ok' }));

    await handler({});

    const backfill = mockedQuery.mock.calls.find(([sql]) => /UPDATE evaluation_results/.test(sql as string));
    expect(backfill).toBeDefined();
    const [sql, params] = backfill as [string, unknown[]];
    expect(sql).toMatch(/SET flow_id = f\.id/);
    expect(sql).toMatch(/er\.flow_id IS NULL/);
    expect(params).toEqual(['task-1']);
  });

  it('invalid status from the judge falls back to completed', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 't2', channel_arn: 'c1', intent: null, user_type: null, agent_type: null, exchange_count: 1, first_at: '2026-07-15T00:00:00Z', last_at: '2026-07-15T00:00:10Z' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ user_message: 'hi', agent_response: 'hello' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    mockSend.mockResolvedValueOnce(bedrockJson({ outcomeScore: 50, informationScore: 50, efficiencyScore: 50, contextRetentionScore: 50, uxScore: 50, outcome: 'x', status: 'nonsense', reasoning: '' }));

    await handler({});
    const [, upParams] = mockedQuery.mock.calls[3] as [string, unknown[]];
    expect(upParams).toContain('completed'); // status coerced
    expect(upParams).toContain('unknown'); // null intent → 'unknown' (NOT NULL column)
  });
});
