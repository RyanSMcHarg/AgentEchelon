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
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn(), ensureSchema: jest.fn() }));

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
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', channel_arn: 'c1', intent: 'general', assistant: 'premium', exchange_count: 2, first_at: '2026-07-15T00:00:00Z', last_at: '2026-07-15T00:05:00Z' }], rowCount: 1 } as any) // getFlowsToScore
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
    // `intent_flows.user_type` is deprecated (migration 050) and no longer written.
    expect(upSql).not.toMatch(/user_type/);
    expect(selSql).not.toMatch(/user_type/);
    expect(upParams).toEqual(expect.arrayContaining(['task-1', 'c1', 'general', 'completed', 90, 70, 85, 75, 80]));
    // turn_count = messages ≈ 2 × exchanges (2 turns → 4)
    expect(upParams).toContain(4);
  });

  it('Pass A stamps the flow join keys (task_id + flow_id subquery) at write time [P1]', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1', channel_arn: 'c1', assistant: 'premium', conversation_classification: 'premium', intent: 'report_generation', task_id: 'task-1', created_at: '2026-07-15T00:00:00Z', user_message: 'build me a report', agent_response: 'starting…' }], rowCount: 1 } as any) // getUnscoredExchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // getPriorMessages (context)
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
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', channel_arn: 'c1', intent: 'general', assistant: 'premium', exchange_count: 2, first_at: '2026-07-15T00:00:00Z', last_at: '2026-07-15T00:05:00Z' }], rowCount: 1 } as any) // getFlowsToScore
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
      .mockResolvedValueOnce({ rows: [{ task_id: 't2', channel_arn: 'c1', intent: null, assistant: null, exchange_count: 1, first_at: '2026-07-15T00:00:00Z', last_at: '2026-07-15T00:00:10Z' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ user_message: 'hi', agent_response: 'hello' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    mockSend.mockResolvedValueOnce(bedrockJson({ outcomeScore: 50, informationScore: 50, efficiencyScore: 50, contextRetentionScore: 50, uxScore: 50, outcome: 'x', status: 'nonsense', reasoning: '' }));

    await handler({});
    const [, upParams] = mockedQuery.mock.calls[3] as [string, unknown[]];
    expect(upParams).toContain('completed'); // status coerced
    expect(upParams).toContain('unknown'); // null intent → 'unknown' (NOT NULL column)
  });

  /**
   * Pass D: the flows that stopped rather than finished.
   *
   * A FLOW'S STATUS IS A VERDICT ON A MOMENT AND NOTHING REVISITED IT. The judge may answer
   * `in_progress`, which is correct at the time; if the conversation then goes quiet the flow gains
   * no turns, so it is never re-scored, so that verdict stands forever. Measured on the reference
   * deployment: 32 of 50 flows over a fortnight, 64%, in a state with no exit.
   */
  describe('the stale-flow sweep (Pass D)', () => {
    const sweepCall = () => mockedQuery.mock.calls.find(([sql]) => /UPDATE intent_flows/.test(sql as string)
      && /status = 'abandoned'/.test(sql as string));

    /** Pass A empty, Pass B empty, Pass C empty - so only the sweep does anything. */
    function onlyTheSweep(sweptRows: { id: string }[]) {
      mockedQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)  // Pass A
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)  // Pass B
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)  // Pass E
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)  // Pass C
        .mockResolvedValueOnce({ rows: sweptRows, rowCount: sweptRows.length } as any);
    }

    it('closes in_progress flows nothing has touched, and reports how many', async () => {
      onlyTheSweep([{ id: 'f1' }, { id: 'f2' }]);
      const res = await handler({});
      expect(JSON.parse(res.body).staleFlowsClosed).toBe(2);
      expect(sweepCall()).toBeDefined();
    });

    it('reaches only in_progress rows, is bounded, and calls no model', async () => {
      onlyTheSweep([]);
      await handler({});

      const [sql, params] = sweepCall() as [string, unknown[]];
      // ONLY `in_progress`. A completed or failed flow has an answer already, and a sweep that
      // overwrote one would replace a judged verdict with a clerical one.
      expect(sql).toMatch(/WHERE status = 'in_progress'/);
      // Idle measured from the last TURN, falling back to creation for a flow that never got one.
      expect(sql).toMatch(/COALESCE\(last_exchange_at, created_at\)/);
      expect(sql).toContain('LIMIT $3');
      // THE HOURS ARE PASSED TWICE, AS INT AND AS TEXT, AND THAT IS DELIBERATE. Postgres deduces a
      // parameter's type independently at each use, so one placeholder read as `::int` in the jsonb
      // and as text inside `($n || ' hours')` fails the whole statement - the trap already recorded
      // against $9 in the Pass A insert.
      expect(params).toEqual([48, '48', 200]);
      // A CLEANUP, NOT A RE-SCORE: no Bedrock call, and no dimension score in the statement. An
      // abandoned flow has no outcome to score, and stamping one puts a number on work nobody did.
      expect(mockSend).not.toHaveBeenCalled();
      expect(sql).not.toMatch(/outcome_score/);
    });

    it('records what closed the row, so a swept flow is distinguishable from a judged one', async () => {
      onlyTheSweep([]);
      await handler({});
      expect((sweepCall() as [string, unknown[]])[0]).toContain('stale-flow-sweep');
    });

    it('does not fail the run when the sweep errors', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockRejectedValueOnce(new Error('deadlock detected (simulated)'));

      const res = await handler({});
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).staleFlowsClosed).toBe(0);
    });
  });
});
