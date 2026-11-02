/**
 * A THROTTLE RETRY DOES NOT ADVANCE A TASK TWICE.
 *
 * `invokeBedrockWithFallback` retries a throttle by running `invokeBedrock` again from the top with the
 * same task context. The tool loop is not resumable, so the model asks for the transitions the first
 * attempt already wrote. Those were authorized against the moved state: refused as illegal (the model
 * was told a transition that happened had failed) or, where the moved state had an edge of that name,
 * written again.
 */

const mockBedrockSend = jest.fn();
const mockDdbSend = jest.fn();

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
  GetChannelMessageCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: class { __t = 'Scan'; constructor(public input: any) {} },
  PutCommand: class { __t = 'Put'; constructor(public input: any) {} },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
  QueryCommand: class { __t = 'Query'; constructor(public input: any) {} },
  DeleteCommand: class { __t = 'Delete'; constructor(public input: any) {} },
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

process.env.TASKS_TABLE = 'tasks';
delete process.env.TASK_SERVICE_FUNCTION_NAME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { invokeBedrockWithFallback } = require('../../lambda/src/lib/bedrock-resilience');

/** Three steps and nothing awaiting a person, so no hand-over write muddies the count. */
const MACHINES = {
  work: {
    initial: 'a',
    states: {
      a: { transitions: ['b'] },
      b: { transitions: ['c', 'b2'] },
      b2: { transitions: ['c'] },
      c: { transitions: [], terminal: 'success' },
    },
  },
};

const config = { model: 'anthropic.claude-3-haiku-20240307-v1:0', maxTokens: 512, userType: 'basic' as const };

const advance = (id: string, to: string) => ({
  stopReason: 'tool_use',
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: id, name: 'advance_task_state', input: { to_state: to } } }] } },
  usage: { inputTokens: 1, outputTokens: 1 },
});
const endTurn = (text: string) => ({
  stopReason: 'end_turn',
  output: { message: { role: 'assistant', content: [{ text }] } },
  usage: { inputTokens: 1, outputTokens: 1 },
});
const throttle = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } });

function context(): any {
  return {
    task: { taskId: 't1', channelArn: 'ch', taskType: 'work', taskState: 'a', status: 'in_progress', userArn: 'x/user/alice' },
    machines: MACHINES,
    initialState: 'a',
    messageId: 'm1',
    assistantId: 'bot',
  };
}

const stateWrites = () => mockDdbSend.mock.calls
  .map((c) => c[0])
  .filter((cmd) => cmd.__t === 'Update' && /taskState = :to/.test(cmd.input.UpdateExpression ?? ''))
  .map((cmd) => `${cmd.input.ExpressionAttributeValues[':from']}->${cmd.input.ExpressionAttributeValues[':to']}`);

/** The tool results the model was sent back, in order. */
const toolResults = () => mockBedrockSend.mock.calls
  .flatMap((c) => (c[0].input.messages as any[]))
  .filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.toolResult)
  .map((m) => m.content[0].toolResult.content[0].json);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CONTEXT_BUCKET;
  mockDdbSend.mockResolvedValue({});
});

describe('a retried attempt replays advances already written', () => {
  it('writes a -> b once when the throttle retry asks for it again, and tells the model it succeeded', async () => {
    mockBedrockSend
      .mockResolvedValueOnce(advance('u1', 'b'))
      .mockRejectedValueOnce(throttle())
      .mockResolvedValueOnce(advance('u2', 'b'))
      .mockResolvedValueOnce(endTurn('done'));
    const ctx = context();

    const r = await invokeBedrockWithFallback('sys', [{ role: 'user', content: 'go' }], config, null, { taskContext: ctx, baseDelayMs: 1 });

    expect(r.retryCount).toBe(1);
    expect(stateWrites()).toEqual(['a->b']);
    expect(ctx.transitions).toEqual([{ from: 'a', to: 'b' }]);
    expect(ctx.task.taskState).toBe('b');
    // The retry's own tool result is the last one sent; it must not be an illegal-transition refusal.
    const last = toolResults().pop();
    expect(last).toMatchObject({ ok: true, from: 'a', to: 'b' });
  });

  it('writes the next edge once the replay has caught up, so real progress is not swallowed', async () => {
    // Non-vacuity: a guard that ignored every request after a retry would pass the test above.
    mockBedrockSend
      .mockResolvedValueOnce(advance('u1', 'b'))
      .mockRejectedValueOnce(throttle())
      .mockResolvedValueOnce(advance('u2', 'b'))
      .mockResolvedValueOnce(advance('u3', 'c'))
      .mockResolvedValueOnce(endTurn('done'));
    const ctx = context();

    await invokeBedrockWithFallback('sys', [{ role: 'user', content: 'go' }], config, null, { taskContext: ctx, baseDelayMs: 1 });

    expect(stateWrites()).toEqual(['a->b', 'b->c']);
    expect(ctx.transitions).toEqual([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
  });

  it('does not treat a revisited state as a replay once the attempt has diverged', async () => {
    // b -> b2 -> ... and a later request naming b again is new work, not the earlier edge replayed.
    mockBedrockSend
      .mockResolvedValueOnce(advance('u1', 'b'))
      .mockRejectedValueOnce(throttle())
      .mockResolvedValueOnce(advance('u2', 'b2'))
      .mockResolvedValueOnce(advance('u3', 'b'))
      .mockResolvedValueOnce(endTurn('done'));
    const ctx = context();

    await invokeBedrockWithFallback('sys', [{ role: 'user', content: 'go' }], config, null, { taskContext: ctx, baseDelayMs: 1 });

    // b2 -> b is not an edge, so the third request is refused by the machine rather than answered
    // from the replay.
    expect(stateWrites()).toEqual(['a->b', 'b->b2']);
    expect(toolResults().pop()).toMatchObject({ ok: false });
  });
});
