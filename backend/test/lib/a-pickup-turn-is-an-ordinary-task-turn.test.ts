/**
 * A PICKUP TURN IS AN ORDINARY TASK TURN (ADR-063 decision 5; one turn path).
 *
 * An idle assistant's pickup is dispatched as the task-continuation turn is, and the processor runs it through its
 * ordinary pipeline (`an-idle-assistant-takes-up-its-own-work` pins the dispatch and that the processor has no branch of
 * its own). Driven here through `invokeBedrock`, the real tool loop that pipeline calls, with the model mocked and the
 * turn's one message the shipped `task-pickup` line rather than anybody's words: the assistant, as the task's worker,
 * advances the step it holds; the move enters a state with a declared action, which the platform runs; the next state
 * delivers a document, filled and declared by the platform; and the task ends. The answer's metadata is the ordinary
 * turn's builder with the kind it declares (`declaredTurnKind`).
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
jest.mock('../../lambda/src/lib/company-context', () => ({ loadCompanyContext: jest.fn(async () => ({ documents: [] })) }));

import { invokeBedrock, declaredTurnKind } from '../../lambda/src/lib/async-processor-core';
import type { TaskLoopContext } from '../../lambda/src/lib/task-tools';
import type { Task } from '../../lambda/src/lib/task-tracking';
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { pickupReadiness } from '../../lambda/src/lib/workflow-task';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { renderPromptTemplate } from '../../lambda/src/lib/message-template';
import { TRAVEL_QUOTE, TRAVEL_QUOTE_TEMPLATES, TRAVEL_QUOTE_COLLECTED } from './deterministic-workflow.fixture';

const config = { model: 'anthropic.claude-3-haiku-20240307-v1:0', maxTokens: 1024, userType: 'basic' as const };
const BOT = 'opsbot';
/** The quote workflow with its requirements step the worker's, and the worker this assistant: work it takes up itself. */
const QUOTE_FOR_WORKER: TaskStateMachine = {
  ...TRAVEL_QUOTE,
  states: { ...TRAVEL_QUOTE.states, collecting: { ...TRAVEL_QUOTE.states.collecting, awaits: { party: 'worker' } } },
};

const pickupContext = (): TaskLoopContext => {
  const task = {
    taskId: 'evt-q', channelArn: 'arn:c', userArn: '', taskType: 'travel_quote', taskState: 'collecting', status: 'pending',
    assigneeId: BOT, assigneeType: 'assistant', workerId: BOT, workerType: 'assistant', assistantId: BOT,
    details: {}, stateHistory: [], createdAt: 'now', updatedAt: 'now',
  } as unknown as Task;
  return { task, machines: { travel_quote: QUOTE_FOR_WORKER }, initialState: 'collecting', transitions: [], templates: TRAVEL_QUOTE_TEMPLATES, assistantId: BOT };
};

const advance = (input: Record<string, unknown>) => ({
  stopReason: 'tool_use',
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: 'advance_task_state', input } }] } },
  usage: { inputTokens: 10, outputTokens: 5 },
});
const endTurn = (text: string) => ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text }] } }, usage: { inputTokens: 10, outputTokens: 5 } });

beforeEach(() => {
  mockBedrockSend.mockReset();
  process.env.ENABLE_TRAVEL_TOOL = 'true';
  process.env.CONTEXT_BUCKET = 'test-context-bucket';
});
afterEach(() => {
  delete process.env.ENABLE_TRAVEL_TOOL;
  delete process.env.CONTEXT_BUCKET;
});

describe('a pickup turn runs through the ordinary tool loop', () => {
  const startLine = (() => {
    const t = shippedMessageTemplates().get('task-pickup')!.template;
    const r = renderPromptTemplate(t, {});
    if (!r.ok) throw new Error('task-pickup did not render');
    return r.prompt;
  })();

  it('the step it holds is ready for it: the worker is this assistant', () => {
    expect(pickupReadiness(pickupContext().task, { travel_quote: QUOTE_FOR_WORKER }, BOT)).toEqual({ ready: true });
  });

  it('its move enters a state with a declared action, the platform runs it, and the next step delivers a document', async () => {
    const ctx = pickupContext();
    mockBedrockSend
      .mockResolvedValueOnce(advance({ to_state: 'searching', reason: 'the trip is recorded', collected: TRAVEL_QUOTE_COLLECTED }))
      .mockResolvedValueOnce(endTurn('Your quote is ready.'));
    const r = await invokeBedrock('sys', [{ role: 'user', content: startLine }], config, undefined, false, false, undefined, undefined, ctx);
    // The one message the turn was given is the platform's line, not anybody's words.
    expect(mockBedrockSend.mock.calls[0][0].input.messages[0].content[0].text).toBe(startLine);
    expect(r.response).toBe('Your quote is ready.');
    // The declared action ran on entry, and its outcome edge was taken.
    expect((ctx.task.details?.actions as Record<string, { ok: boolean }>).searching.ok).toBe(true);
    expect(r.steps.map((s) => s.stepLabel)).toEqual(['tool:advance_task_state', 'platform-action:search_corporate_travel', 'platform-action:deliver_document', 'generate']);
    // The delivering step's document was filled and declared, which the ordinary delivery packages as the file.
    expect(ctx.declaredTemplate).toMatchObject({ filled: true, state: 'quoting' });
    expect(ctx.declaredDocument).toContain('| SEA | JFK | 2026-11-03 |');
    expect(ctx.task.taskState).toBe('completed');
  });

  it('the answer declares task_step on the ordinary turn\'s metadata, and nothing else differs', () => {
    expect(declaredTurnKind({ taskPickup: { taskId: 'evt-q', state: 'collecting' }, taskType: 'travel_quote' }))
      .toEqual({ turnKind: 'task_step', taskStep: { taskType: 'travel_quote', state: 'collecting' } });
    // An ordinary turn declares no kind: every other field comes from the one builder both share.
    expect(declaredTurnKind({ taskType: 'travel_quote' })).toEqual({});
  });
});
