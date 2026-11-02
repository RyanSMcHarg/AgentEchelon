/**
 * A DETERMINISTIC WORKFLOW RUNS IN THE TURN WITH NO MODEL CALL AFTER ITS REQUIREMENTS
 * (SPEC-TASK-STATE-TRANSITIONS FR28, FR29; SPEC-DOCUMENT-TEMPLATES FR9).
 *
 * Driven through `invokeBedrock`, the real tool loop, with the model mocked. The model's only move is the
 * advance out of the requirements step; the platform then runs the search the workflow declares, fills the
 * quote template from the recorded result, declares it as the document and closes the task, and the
 * model's next call writes the reply to the person. Beside it: a step's declared tools narrow what the
 * turn is offered and refuse a call outside them, and a task resting in an action step is run before the
 * model is called.
 */
const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ListChannelMessagesCommand: jest.fn(),
  UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn(),
  DeleteChannelMessageCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('../../lambda/src/lib/company-context', () => ({ loadCompanyContext: jest.fn(async () => ({ documents: [] })) }));

import { invokeBedrock } from '../../lambda/src/lib/async-processor-core';
import type { TaskLoopContext } from '../../lambda/src/lib/task-tools';
import type { Task } from '../../lambda/src/lib/task-tracking';
import { TRAVEL_QUOTE, TRAVEL_QUOTE_TEMPLATES, TRAVEL_QUOTE_COLLECTED } from './deterministic-workflow.fixture';

const config = { model: 'anthropic.claude-3-haiku-20240307-v1:0', maxTokens: 1024, userType: 'basic' as const };

const advance = (input: Record<string, unknown>) => ({
  stopReason: 'tool_use',
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: 'advance_task_state', input } }] } },
  usage: { inputTokens: 10, outputTokens: 5 },
});
const callTool = (name: string) => ({
  stopReason: 'tool_use',
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'u2', name, input: {} } }] } },
  usage: { inputTokens: 10, outputTokens: 5 },
});
const endTurn = (text: string) => ({
  stopReason: 'end_turn',
  output: { message: { role: 'assistant', content: [{ text }] } },
  usage: { inputTokens: 10, outputTokens: 5 },
});

const sourced = (value: string) => ({ value, source: 'message', evidence: value });

const ctxAt = (state: string, details: Record<string, unknown> = {}): TaskLoopContext => {
  const task = {
    taskId: 't1', channelArn: 'arn:c', userArn: 'arn:u', taskType: 'travel_quote', taskState: state,
    status: 'in_progress', details, stateHistory: [], createdAt: 'now', updatedAt: 'now',
  } as unknown as Task;
  return { task, machines: { travel_quote: TRAVEL_QUOTE }, initialState: state, transitions: [], templates: TRAVEL_QUOTE_TEMPLATES };
};

/** The JSON tool result the model was handed back in the call after the one that used a tool. */
const toolResultOf = (callIndex: number): Record<string, unknown> => {
  const msgs = mockBedrockSend.mock.calls[callIndex][0].input.messages as Array<{ content: Array<{ toolResult?: { content: Array<{ json: Record<string, unknown> }> } }> }>;
  const last = msgs[msgs.length - 1];
  return last.content[0].toolResult!.content[0].json;
};

const offeredNames = (callIndex: number): string[] =>
  ((mockBedrockSend.mock.calls[callIndex][0].input.toolConfig?.tools ?? []) as Array<{ toolSpec: { name: string } }>).map((t) => t.toolSpec.name);

beforeEach(() => {
  mockBedrockSend.mockReset();
  process.env.ENABLE_TRAVEL_TOOL = 'true';
  process.env.CONTEXT_BUCKET = 'test-context-bucket';
});
afterEach(() => {
  delete process.env.ENABLE_TRAVEL_TOOL;
  delete process.env.CONTEXT_BUCKET;
});

describe('the whole deterministic path through the real tool loop', () => {
  it('takes one model move for the requirements and runs the rest as the platform', async () => {
    const ctx = ctxAt('collecting');
    mockBedrockSend
      .mockResolvedValueOnce(advance({ to_state: 'searching', reason: 'the person gave all three', collected: TRAVEL_QUOTE_COLLECTED }))
      .mockResolvedValueOnce(endTurn('Here is your quote.'));

    const r = await invokeBedrock('sys', [{ role: 'user', content: 'SEA to JFK on Nov 3' }], config, undefined, false, false, undefined, undefined, ctx);

    // Two model calls: the advance, and the reply. Nothing in between was a model's.
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
    expect(r.response).toBe('Here is your quote.');
    expect(ctx.task.taskState).toBe('completed');
    expect(ctx.transitions).toEqual([
      { from: 'collecting', to: 'searching' },
      { from: 'searching', to: 'quoting' },
      { from: 'quoting', to: 'completed' },
    ]);
    // The document is the template, filled from the recorded needs and the search's recorded result.
    expect(ctx.declaredTemplate).toMatchObject({ filled: true, state: 'quoting' });
    expect(ctx.declaredDocument).toContain('| SEA | JFK | 2026-11-03 |');
    expect(ctx.declaredDocument).toMatch(/SEA.*JFK.*\d+ USD\./);
    expect((ctx.task.details?.actions as Record<string, { ok: boolean }>).searching.ok).toBe(true);

    // The model is told where the workflow went, and that it is finished.
    const told = toolResultOf(1);
    expect(told).toMatchObject({ ok: true, to: 'searching', now_at: 'completed', finished: true, terminal: 'success', document_filled_by_platform: true });
    expect(told.platform_actions).toEqual([
      expect.objectContaining({ state: 'searching', tool: 'search_corporate_travel', ok: true, moved_to: 'quoting' }),
      expect.objectContaining({ state: 'quoting', tool: 'deliver_document', ok: true, moved_to: 'completed' }),
    ]);

    // Two platform steps, after the model step that caused them, and neither is a model tool call.
    const labels = r.steps.map((s) => s.stepLabel);
    expect(labels).toEqual(['tool:advance_task_state', 'platform-action:search_corporate_travel', 'platform-action:deliver_document', 'generate']);
    const platformSteps = r.steps.filter((s) => s.stepLabel.startsWith('platform-action:'));
    expect(platformSteps.every((s) => s.modelId === 'platform' && s.tools === undefined && s.action?.ok === true)).toBe(true);
  });

  it('does not run an action whose tool the profile does not allow, and takes onFailure', async () => {
    const ctx = ctxAt('collecting');
    mockBedrockSend
      .mockResolvedValueOnce(advance({ to_state: 'searching', reason: 'ready', collected: TRAVEL_QUOTE_COLLECTED }))
      .mockResolvedValueOnce(endTurn('That could not be searched.'));

    await invokeBedrock('sys', [{ role: 'user', content: 'go' }], { ...config, tools: ['advance_task_state'] }, undefined, false, false, undefined, undefined, ctx);

    expect(ctx.task.taskState).toBe('failed');
    expect(toolResultOf(1).platform_actions).toEqual([
      expect.objectContaining({ tool: 'search_corporate_travel', ok: false, refusal: 'action_tool_not_allowed', moved_to: 'failed' }),
    ]);
  });
});

describe('a task resting in an action step is run before the model is called', () => {
  it('runs the unclaimed entry first, and the model writes for where the workflow reached', async () => {
    const ctx = ctxAt('searching', {
      collectedRequirements: { origin: sourced('SEA'), destination: sourced('JFK'), 'departure date': sourced('2026-11-03') },
    });
    mockBedrockSend.mockResolvedValueOnce(endTurn('Your quote is ready.'));

    const r = await invokeBedrock('sys', [{ role: 'user', content: 'any news?' }], config, undefined, false, false, undefined, undefined, ctx);

    expect(ctx.task.taskState).toBe('completed');
    const system = JSON.stringify(mockBedrockSend.mock.calls[0][0].input.system);
    expect(system).toContain('THE PLATFORM RAN THIS STEP');
    expect(system).toContain('The task is now at \\"completed\\"');
    expect(r.steps.map((s) => s.stepLabel)).toEqual(['platform-action:search_corporate_travel', 'platform-action:deliver_document', 'generate']);
  });

  it('does not run an entry already claimed on an earlier attempt', async () => {
    const ctx = ctxAt('searching', {
      collectedRequirements: { origin: sourced('SEA'), destination: sourced('JFK'), 'departure date': sourced('2026-11-03') },
    });
    ctx.task.actionRuns = ['searching#0'];
    mockBedrockSend.mockResolvedValueOnce(endTurn('Still working on it.'));

    await invokeBedrock('sys', [{ role: 'user', content: 'any news?' }], config, undefined, false, false, undefined, undefined, ctx);

    expect(ctx.task.taskState).toBe('searching');
    expect(ctx.transitions).toEqual([]);
  });
});

describe('a step\'s declared tools narrow the turn and refuse a call outside them (FR28)', () => {
  it('offers only the task tools on a step that declares `tools: []`, though the turn enables company context', async () => {
    const ctx = ctxAt('collecting');
    mockBedrockSend.mockResolvedValueOnce(endTurn('What is the departure date?'));

    await invokeBedrock('sys', [{ role: 'user', content: 'a trip' }], config, undefined, true, false, undefined, undefined, ctx);

    expect(offeredNames(0)).toEqual(['advance_task_state']);
  });

  it('refuses a call to a tool the current step does not declare, as a workflow refusal', async () => {
    const ctx = ctxAt('collecting');
    mockBedrockSend
      .mockResolvedValueOnce(callTool('load_company_context'))
      .mockResolvedValueOnce(endTurn('What is the departure date?'));

    const r = await invokeBedrock('sys', [{ role: 'user', content: 'a trip' }], config, undefined, true, false, undefined, undefined, ctx);

    expect(toolResultOf(1)).toMatchObject({ ok: false, error: 'tool_not_in_step', refusal: 'tool_not_in_step' });
    expect(r.steps[0].tools).toEqual([{ name: 'load_company_context', ok: false, errorClass: 'workflow_refusal', refusal: 'tool_not_in_step' }]);
  });

  it('leaves a step that declares no tools exactly as it was', async () => {
    const ctx = ctxAt('collecting');
    ctx.machines = { travel_quote: { ...TRAVEL_QUOTE, states: { ...TRAVEL_QUOTE.states, collecting: { ...TRAVEL_QUOTE.states.collecting, tools: undefined } } } };
    mockBedrockSend.mockResolvedValueOnce(endTurn('ok'));

    await invokeBedrock('sys', [{ role: 'user', content: 'a trip' }], config, undefined, true, false, undefined, undefined, ctx);

    expect(offeredNames(0)).toEqual(expect.arrayContaining(['load_platform_info', 'search_corporate_travel', 'advance_task_state']));
  });
});
