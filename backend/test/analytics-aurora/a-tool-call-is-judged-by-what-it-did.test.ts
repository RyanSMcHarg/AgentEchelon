/**
 * Tool use, scored by what it changed (SPEC-EVALUATION Appendix C3, FR11): every call is recorded with its
 * arguments and a capped result, an errored call needs no judge, a state-changing call is scored from its
 * recorded effect, the judge decides the rest in one call, and every finding names one owner.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { toolCallRecord, TOOL_ARGS_MAX_CHARS, TOOL_RESULT_MAX_CHARS, type ToolCallRecord } from '../../lambda/src/lib/analytics-metadata';
import { TOOL_REGISTRY, toolOwnerOf } from '../../lambda/src/lib/tool-registry';
import { decideWithoutJudge, parseToolJudgement, ownerFor, runToolPass, NO_TOOL } from '../../lambda/src/analytics-aurora/tool-judge';
import { handler, TOOL_OUTCOME_COLUMNS } from '../../lambda/src/analytics-aurora/analytics-query';

const call = (name: string, over: Partial<ToolCallRecord> = {}): ToolCallRecord =>
  ({ name, args: '{}', result: '{}', ok: true, ...over });

describe('a call is recorded with what it asked for and what came back', () => {
  it('keeps the arguments and a capped result beside the outcome', () => {
    const r = toolCallRecord('load_company_context', { topic: 'travel' }, { content: 'x'.repeat(5000) });
    expect(r.args).toBe('{"topic":"travel"}');
    expect(r.result.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 1);
    expect(r.ok).toBe(true);
    expect(toolCallRecord('x', { a: 'y'.repeat(5000) }, {}).args.length).toBeLessThanOrEqual(TOOL_ARGS_MAX_CHARS + 1);
  });

  it('carries the error class and the refusal the step records', () => {
    expect(toolCallRecord('advance_task_state', {}, { error: 'illegal', refusal: 'illegal_transition' }))
      .toMatchObject({ ok: false, errorClass: 'workflow_refusal', refusal: 'illegal_transition' });
  });

  it('rides the out-of-band record with the tools the turn held, never the Chime metadata', () => {
    const core = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');
    expect(core).toMatch(/\.\.\.\(params\.toolCalls\?\.length \? \{ toolCalls: params\.toolCalls \} : \{\}\)/);
    expect(core).toMatch(/toolsOffered: offeredToolSpecs\.map\(toolSpecName\)/);
  });
});

describe('every tool names who fixes it', () => {
  it('has an owner on every registry entry', () => {
    for (const t of TOOL_REGISTRY) expect(t.owner).toMatch(/^(platform|connector:.+|context:.+)$/);
  });

  it('routes a failed or empty result to the tool\'s owner, and everything else to the assistant\'s team', () => {
    expect(ownerFor('errored', 'search_corporate_travel')).toBe('connector:corporate-travel');
    expect(ownerFor('empty', 'load_company_context')).toBe(toolOwnerOf('load_company_context'));
    expect(ownerFor('wrong_arguments', 'search_corporate_travel')).toBe('assistant');
    expect(ownerFor('not_called', 'load_company_context')).toBe('assistant');
  });
});

describe('decided the cheapest way the record allows', () => {
  it('scores an errored call from the recorded error and a state-changing call from its effect, with no judge', () => {
    const { decided, forJudge } = decideWithoutJudge([
      call('load_company_context', { ok: false, errorClass: 'timeout' }),
      call('advance_task_state'),
      call('load_platform_info'),
      call('advance_task_state', { ok: false, errorClass: 'workflow_refusal', refusal: 'illegal_transition' }),
    ]);
    expect(decided).toEqual([
      expect.objectContaining({ callIndex: 0, outcome: 'errored', decidedBy: 'deterministic' }),
      expect.objectContaining({ callIndex: 1, outcome: 'used_correctly', decidedBy: 'effect' }),
    ]);
    // The refused call is the workflow working: neither decided nor judged.
    expect(forJudge).toEqual([2]);
  });

  it('keeps only judge answers that name a call it was shown or a tool the turn held', () => {
    const calls = [call('load_company_context'), call('load_platform_info')];
    const verdicts = parseToolJudgement({
      calls: [
        { index: 1, outcome: 'wrong_arguments', reason: 'asked about the wrong office' },
        { index: 7, outcome: 'empty' },
        { index: 2, outcome: 'errored' },
      ],
      notCalled: [{ tool: 'search_corporate_travel', reason: 'it was a booking question' }, { tool: 'made_up_tool' }],
    }, calls, [0, 1], ['load_company_context', 'load_platform_info', 'search_corporate_travel']);
    expect(verdicts).toEqual([
      expect.objectContaining({ callIndex: 0, outcome: 'wrong_arguments', owner: 'assistant', decidedBy: 'judge' }),
      expect.objectContaining({ callIndex: -1, toolName: 'search_corporate_travel', outcome: 'not_called' }),
    ]);
  });
});

describe('the tool pass', () => {
  beforeEach(() => mockDbQuery.mockReset());

  it('draws only judged exchanges, so it inherits the relevance pass\'s sample, and writes one row per call', async () => {
    const send = jest.fn();
    mockDbQuery.mockImplementation(async (sql: string) => (String(sql).includes('FROM exchanges e')
      ? { rows: [{ id: 'ex-1', assistant: 'a', conversation_classification: 'standard', intent: 'general', user_message: 'q', agent_response: 'r',
          agent_metadata: { toolCalls: [call('load_company_context', { ok: false, errorClass: 'not_found' })] } }] }
      : { rows: [] }));
    const res = await runToolPass({ client: { send } as never, model: 'judge', runId: 'r', limit: 10 });
    expect(res).toEqual({ scored: 1, errors: 0 });
    // An errored call with nothing held to judge calls no model.
    expect(send).not.toHaveBeenCalled();
    const select = String(mockDbQuery.mock.calls[0][0]);
    expect(select).toMatch(/EXISTS \(SELECT 1 FROM evaluation_results er WHERE er\.exchange_id = e\.id AND er\.evaluation_type = 'exchange'\)/);
    const insert = mockDbQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO tool_call_verdicts'))!;
    expect(insert[1]).toEqual(expect.arrayContaining(['ex-1', 0, 'load_company_context', 'errored', 'context:company-context', 'deterministic']));
  });

  it('records that no held tool was needed, so the exchange is not judged again', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ content: [{ text: '{"calls": [], "notCalled": []}' }] }));
    const send = jest.fn().mockResolvedValue({ body });
    mockDbQuery.mockImplementation(async (sql: string) => (String(sql).includes('FROM exchanges e')
      ? { rows: [{ id: 'ex-2', assistant: 'a', conversation_classification: 'standard', intent: 'general', user_message: 'q', agent_response: 'r',
          agent_metadata: { toolsOffered: ['load_company_context'] } }] }
      : { rows: [] }));
    await runToolPass({ client: { send } as never, model: 'judge', runId: 'r', limit: 10 });
    expect(send).toHaveBeenCalledTimes(1);
    const insert = mockDbQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO tool_call_verdicts'))!;
    expect(insert[1]).toEqual(expect.arrayContaining(['ex-2', -1, NO_TOOL, 'used_correctly']));
  });

  it('leaves an exchange unscored when the judge fails, never records a verdict for it', async () => {
    const send = jest.fn().mockRejectedValue(new Error('throttled'));
    mockDbQuery.mockImplementation(async (sql: string) => (String(sql).includes('FROM exchanges e')
      ? { rows: [{ id: 'ex-3', assistant: 'a', conversation_classification: 'standard', intent: 'general', user_message: 'q', agent_response: 'r',
          agent_metadata: { toolCalls: [call('load_platform_info')], toolsOffered: ['load_platform_info'] } }] }
      : { rows: [] }));
    const res = await runToolPass({ client: { send } as never, model: 'judge', runId: 'r', limit: 10 });
    expect(res).toEqual({ scored: 0, errors: 1 });
    expect(mockDbQuery.mock.calls.some(([s]) => String(s).includes('INSERT INTO tool_call_verdicts'))).toBe(false);
  });
});

const SUB = '11111111-2222-3333-4444-555555555555';
const teamPost = (assistant: string, body: Record<string, unknown>): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-10-01', end: '2026-10-26' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
} as unknown as APIGatewayProxyEvent);

describe('the tool outcomes reading', () => {
  beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));

  it('names each tool\'s owner and is bound to the team\'s assistant', async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ assistant: 'analyst', conversation_classification: 'standard', tool_name: 'search_corporate_travel', verdicts: 3 }] });
    const body = JSON.parse((await handler(teamPost('analyst', { queryType: 'tool_outcomes', agentType: 'advisor' }))).body);
    expect(body.data[0].owner).toBe('connector:corporate-travel');
    const [, params] = mockDbQuery.mock.calls.find(([s]) => String(s).includes('tool_call_verdicts'))!;
    expect(params).toContain('analyst');
    expect(params).not.toContain('advisor');
    expect(TOOL_OUTCOME_COLUMNS).toContain('owner');
  });
});
