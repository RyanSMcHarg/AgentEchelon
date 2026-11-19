/**
 * A TASK TURN IS OFFERED ITS MOVE ON THE LIVE PATH, AND IS ASKED FOR IT WHEN IT ENDS OWING ONE.
 *
 * Measured on dev 2026-11-18T04:54Z (premium `account_brief`): the turn read the record and wrote the brief, the task row
 * held `actionRuns: ["tool:load_company_context:researching#0"]` and no `stateHistory`, and no continuation ran. The
 * turn's tools are the profile's allowlist narrowed by the intent's own (`toolsForIntent`), and `account_brief` declares
 * `tools: ['load_company_context']`, so the narrowing removed `advance_task_state`: the model could not move the task at
 * all, and a turn that is not offered the move is not asked for it.
 *
 * What it proves, on the path a deployment runs (the task service records the required tool and writes the move; the
 * row carries no `stateHistory`; the turn's tools come from `toolsForIntent` over the premium pack and every tool):
 *  - the workflow's own tools stay on an intent that narrows its tools, where the profile allows them;
 *  - the turn that read the record, wrote the brief and took no move is asked for it once and reaches `completed`;
 *  - DENY: an intent's narrowing still removes every other tool, and a profile that does not allow the move does not
 *    get it from the intent.
 */
const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ListChannelMessagesCommand: jest.fn(), UpdateChannelMessageCommand: jest.fn(), SendChannelMessageCommand: jest.fn(), DeleteChannelMessageCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })), InvokeCommand: jest.fn(), InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('../../lambda/src/lib/company-context', () => ({
  loadCompanyContext: jest.fn(async () => ({ documentCount: 1, documents: [{ name: 'customer-accounts.json', content: '{}' }] })),
  loadPlatformInfo: jest.fn(async () => ({ documentCount: 0, documents: [] })),
  loadContextDigest: jest.fn(async () => null),
  buildDigestHint: jest.fn(() => ''),
}));
jest.mock('../../lambda/src/lib/assistant-session', () => ({
  ...jest.requireActual('../../lambda/src/lib/assistant-session'),
  vendAssistantSession: jest.fn(async () => ({
    assistant: 'advisor', role: 'primary', botArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/a/bot/advisor',
    credentials: { accessKeyId: 'AKIAROLE', secretAccessKey: 's', sessionToken: 't' },
  })),
}));
// THE TASK SERVICE, as deployed: it re-reads the row (which has no `stateHistory`), claims the required tool's run on
// it with the platform's own claim, and writes a move along a declared edge. The turn's copy hears back only the key.
const mockRow: { current: Record<string, any> } = { current: {} };
jest.mock('../../lambda/src/lib/task-service-client', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-service-client');
  const tracking = jest.requireActual('../../lambda/src/lib/task-tracking');
  return {
    ...actual,
    hasTaskService: () => true,
    claimStateAction: jest.fn(async (input: { state: string; toolRun?: string }) =>
      tracking.claimStateAction({ task: mockRow.current, state: input.state, ...(input.toolRun ? { toolRun: input.toolRun } : {}) })),
    advanceTaskState: jest.fn(async (input: { toState: string; machines: Record<string, any> }) => {
      const row = mockRow.current;
      const from = row.taskState;
      if (!input.machines[row.taskType]?.states?.[from]?.transitions.includes(input.toState)) return { ok: false, error: 'illegal_transition', from };
      row.stateHistory = [...(row.stateHistory ?? []), { from, to: input.toState, at: new Date().toISOString() }];
      row.taskState = input.toState;
      const terminal = input.machines[row.taskType]?.states?.[input.toState]?.terminal;
      if (terminal) row.status = 'completed';
      return { ok: true, from, to: input.toState, ...(terminal ? { terminal } : {}) };
    }),
    noTransitionTurn: jest.fn(async () => 0),
  };
});

import { invokeBedrock, actAsAssistant, releaseAssistantIdentity } from '../../lambda/src/lib/async-processor-core';
import type { TaskLoopContext } from '../../lambda/src/lib/task-tools';
import type { Task } from '../../lambda/src/lib/task-tracking';
import { resolveStoredPack, taskStateMachines, toolsForIntent } from '../../lambda/src/lib/intent-pack';
import { ALL_TOOL_NAMES } from '../../lambda/src/lib/tool-registry';
import { ACCOUNT_BRIEF_INTENT, stratumIntentPack } from '../../../demo/stratum-company/intent-packs';

const TOOL = 'load_company_context';
const PACK = resolveStoredPack(stratumIntentPack('premium'));
const MACHINES = taskStateMachines(PACK);
const BRIEF = 'Got everything I need. Drafting the brief now.\n\n# Coastal Health Systems\n\n---\n\n*Source: customer-accounts.json*';
const usage = { inputTokens: 100, outputTokens: 10 };
const callTool = (name: string, input: Record<string, unknown>) => ({
  stopReason: 'tool_use', usage,
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: `t-${name}-${Math.random()}`, name, input } }] } },
});
const ends = (text: string) => ({ stopReason: 'end_turn', usage, output: { message: { role: 'assistant', content: text ? [{ text }] : [] } } });
const offered = (i = 0): string[] => mockBedrockSend.mock.calls[i][0].input.toolConfig?.tools?.map((t: any) => t.toolSpec.name) ?? [];

beforeAll(async () => {
  process.env.CONTEXT_BUCKET = 'test-context-bucket';
  await actAsAssistant('corr-live-path');
});
afterAll(() => {
  delete process.env.CONTEXT_BUCKET;
  releaseAssistantIdentity();
});
beforeEach(() => mockBedrockSend.mockReset());

describe('an intent that narrows its tools keeps its workflow\'s', () => {
  it('account_brief over every tool is its lookup and the workflow\'s tools, and nothing else', () => {
    const tools = toolsForIntent(ACCOUNT_BRIEF_INTENT, ALL_TOOL_NAMES, PACK)!;
    expect(tools).toEqual([TOOL, 'advance_task_state', 'deliver_document', 'open_new_request']);
    // An unconfigured profile allows every registered tool, so the workflow's tools stay there too.
    expect(toolsForIntent(ACCOUNT_BRIEF_INTENT, undefined, PACK)).toEqual(tools);
  });

  it('DENY: a profile that does not allow the move does not get it from the intent', () => {
    expect(toolsForIntent(ACCOUNT_BRIEF_INTENT, [TOOL, 'load_platform_info'], PACK)).toEqual([TOOL]);
  });
});

describe('the 04:54 turn, on the task service with a row that has no stateHistory', () => {
  it('is offered the move, is asked for it once when it ends owing it, and the task completes', async () => {
    mockRow.current = {
      taskId: 'req-7f70cfa33320', channelArn: 'arn:c', userArn: '', taskType: ACCOUNT_BRIEF_INTENT, taskState: 'researching',
      status: 'in_progress', assigneeId: 'advisor', assigneeType: 'assistant', details: {}, createdAt: 'now', updatedAt: 'now',
    };
    const ctx: TaskLoopContext = {
      task: { ...mockRow.current } as unknown as Task,
      machines: MACHINES, initialState: 'researching', transitions: [], assistantId: 'advisor',
    };
    mockBedrockSend
      .mockResolvedValueOnce(callTool(TOOL, { documents: ['customer-accounts.json'] }))
      .mockResolvedValueOnce(ends(BRIEF))
      .mockResolvedValueOnce(callTool('advance_task_state', { to_state: 'drafting', reason: 'read' }))
      .mockResolvedValueOnce(callTool('advance_task_state', { to_state: 'completed', reason: 'written' }))
      .mockResolvedValueOnce(ends(''));
    const config = {
      model: 'anthropic.claude-sonnet', maxTokens: 4096, userType: 'premium' as const,
      tools: toolsForIntent(ACCOUNT_BRIEF_INTENT, ALL_TOOL_NAMES, PACK),
    };
    const r = await invokeBedrock('sys', [{ role: 'user', content: 'Prepare an account brief on Coastal Health Systems.' }], config, undefined, true, false, undefined, undefined, ctx);

    expect(offered()).toEqual(expect.arrayContaining([TOOL, 'advance_task_state']));
    expect(mockRow.current.actionRuns).toEqual([`tool:${TOOL}:researching#0`]);
    expect(ctx.transitions).toEqual([{ from: 'researching', to: 'drafting' }, { from: 'drafting', to: 'completed' }]);
    expect(mockRow.current.taskState).toBe('completed');
    expect(r.response).toBe(BRIEF);
    expect(r.steps.map((s) => s.stepLabel)).toContain('generate:owed-move');
  });
});
