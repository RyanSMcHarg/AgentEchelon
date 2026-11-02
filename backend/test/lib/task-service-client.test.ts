/**
 * THE SEAM'S TWO RULES, and the difference between them is the whole boundary.
 *
 *   NOT WIRED  -> the caller keeps its direct read. A deployment that has not enabled this must not
 *                 lose task context for a change nobody turned on.
 *   WIRED      -> the service decides. A failure or a refusal returns the EMPTY answer and never
 *                 reaches around to the table, because reading around a refusal makes the boundary a
 *                 suggestion rather than a boundary.
 *
 * Conflating those two is the way this ships looking finished and enforcing nothing: a client that
 * fell back on error would answer every refusal with the very data the refusal withheld.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = (...a: unknown[]) => mockSend(...a); },
  InvokeCommand: class { constructor(public input: any) {} },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require('../../lambda/src/lib/task-service-client');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const EMPTY = { current: null, here: [], elsewhere: [] };

/** A service reply, as Lambda returns it. */
const replies = (body: unknown) =>
  mockSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify(body)) });

beforeEach(() => {
  mockSend.mockReset();
  process.env.TASK_SERVICE_ARN = 'arn:aws:lambda:us-east-1:1:function:TaskService';
});

describe('whether this deployment routes through the service', () => {
  it('says no when the ARN is unset', () => {
    delete process.env.TASK_SERVICE_ARN;
    expect(client.hasTaskService()).toBe(false);
  });

  it('says yes when it is set', () => {
    expect(client.hasTaskService()).toBe(true);
  });

  it('reads the ARN at CALL time, not at import', () => {
    // A capture at module load would make the answer depend on import order, which is how a wired
    // deployment silently behaves as an unwired one.
    delete process.env.TASK_SERVICE_ARN;
    expect(client.hasTaskService()).toBe(false);
    process.env.TASK_SERVICE_ARN = 'arn:aws:lambda:us-east-1:1:function:TaskService';
    expect(client.hasTaskService()).toBe(true);
  });
});

describe('when the service answers', () => {
  it('returns what it said', async () => {
    replies({ current: { taskId: 't1' }, here: [{ taskId: 't2' }], elsewhere: [] });
    const out = await client.tasksForTurn({ channelArn: CHANNEL });
    expect(out.current.taskId).toBe('t1');
    expect(out.here).toHaveLength(1);
  });

  it('sends the op and the input the service expects', async () => {
    replies(EMPTY);
    await client.tasksForTurn({ channelArn: CHANNEL, senderArn: 'u', taskId: 't1' });
    const payload = JSON.parse(mockSend.mock.calls[0][0].input.Payload.toString());
    expect(payload.op).toBe('tasksForTurn');
    expect(payload.input).toEqual({ channelArn: CHANNEL, senderArn: 'u', taskId: 't1' });
  });

  it('does NOT send a classification, because there is nothing to send', async () => {
    // The service takes its classification from its own environment. A field here would be a claim,
    // and a claim is what the per-classification invoke grant exists to replace.
    replies(EMPTY);
    await client.tasksForTurn({ channelArn: CHANNEL });
    const payload = JSON.parse(mockSend.mock.calls[0][0].input.Payload.toString());
    expect(Object.keys(payload.input)).toEqual(['channelArn']);
  });
});

describe('when the service refuses or fails', () => {
  it('returns EMPTY on a FunctionError rather than throwing', async () => {
    // Task hints are best-effort at every call site: a failure must not cost the turn.
    mockSend.mockResolvedValue({ FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"x"}') });
    expect(await client.tasksForTurn({ channelArn: CHANNEL })).toEqual(EMPTY);
  });

  it('returns EMPTY on an invoke error', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));
    expect(await client.tasksForTurn({ channelArn: CHANNEL })).toEqual(EMPTY);
  });

  it('returns EMPTY on an empty payload', async () => {
    mockSend.mockResolvedValue({ Payload: undefined });
    expect(await client.tasksForTurn({ channelArn: CHANNEL })).toEqual(EMPTY);
  });

  it('NEVER reaches around to the table on a refusal', async () => {
    // THE ONE THAT MATTERS. A refusal returns the empty answer, which is indistinguishable from "no
    // tasks" - and that is correct. A client that treated it as "service unavailable, read directly"
    // would answer every refusal with exactly the data the refusal withheld.
    replies(EMPTY);
    const out = await client.tasksForTurn({ channelArn: CHANNEL });
    expect(out).toEqual(EMPTY);
    // One call, to the service. No second attempt anywhere.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('throws to nobody when the ARN is unset', async () => {
    // The caller decides to fall back by asking `hasTaskService()` FIRST. If it calls anyway, it gets
    // the empty answer rather than an exception, because a missing ARN must not fail a turn either.
    delete process.env.TASK_SERVICE_ARN;
    expect(await client.tasksForTurn({ channelArn: CHANNEL })).toEqual(EMPTY);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('reading one task', () => {
  it('returns the task', async () => {
    replies({ taskId: 't1' });
    expect((await client.getTask({ taskId: 't1', channelArn: CHANNEL })).taskId).toBe('t1');
  });

  it('returns null on refusal and on failure alike', async () => {
    replies(null);
    expect(await client.getTask({ taskId: 't1', channelArn: CHANNEL })).toBeNull();
    mockSend.mockRejectedValue(new Error('boom'));
    expect(await client.getTask({ taskId: 't1', channelArn: CHANNEL })).toBeNull();
  });
});

/**
 * THE WRITES, and the one thing that distinguishes them: whether anybody reads the answer.
 *
 * `updateTaskStatus` returns void and no call site uses its result, so waiting for the write buys a
 * person's patience nothing and it goes fire-and-forget. `advanceTaskState` is branched on by the
 * tool loop, so it cannot. Getting that backwards is silent in both directions: an unwaited advance
 * would let the model be told a transition succeeded before it did, and a waited status write would
 * put a DynamoDB round trip inside a person's wait for a value nobody looks at.
 */
describe('the writes choose their invocation type by what is read back', () => {
  it('records a status WITHOUT waiting for the write', async () => {
    mockSend.mockResolvedValue({});
    await client.updateTaskStatus({ taskId: 't1', channelArn: CHANNEL, status: 'completed' });
    expect(mockSend.mock.calls[0][0].input.InvocationType).toBe('Event');
  });

  it('WAITS for an advance, because the tool loop branches on it', async () => {
    replies({ ok: true, from: 'a', to: 'b' });
    await client.advanceTaskState({ taskId: 't1', channelArn: CHANNEL, toState: 'b' });
    expect(mockSend.mock.calls[0][0].input.InvocationType).toBe('RequestResponse');
  });

  it('waits for a create, because the caller uses the task it returns', async () => {
    replies({ taskId: 't1' });
    await client.createTask({ event: {}, deliveryOption: 'DIRECT' });
    expect(mockSend.mock.calls[0][0].input.InvocationType).toBe('RequestResponse');
  });
});

describe('a write that cannot be delivered', () => {
  it('reports a failed advance rather than throwing', async () => {
    // So the caller's existing `ok: false` branch covers a transport fault the same way it covers a
    // rejected transition. From the caller's side the state did not change, which is what
    // `persist_failed` says.
    mockSend.mockRejectedValue(new Error('throttled'));
    expect(await client.advanceTaskState({ taskId: 't1', channelArn: CHANNEL, toState: 'b' }))
      .toEqual({ ok: false, error: 'persist_failed' });
  });

  it('never reports an advance as SUCCESSFUL when the service returned nothing', async () => {
    // The dangerous direction. An empty payload treated as success would tell the model a task moved
    // when no row changed, and the next turn would reason from a state that does not exist.
    mockSend.mockResolvedValue({ Payload: undefined });
    const out = await client.advanceTaskState({ taskId: 't1', channelArn: CHANNEL, toState: 'b' });
    expect(out.ok).toBe(false);
  });

  it('does not fail the turn when a status write cannot be dispatched', async () => {
    // Matching the direct call it replaces, which logs and returns rather than throwing.
    mockSend.mockRejectedValue(new Error('throttled'));
    await expect(
      client.updateTaskStatus({ taskId: 't1', channelArn: CHANNEL, status: 'failed' }),
    ).resolves.toBeUndefined();
  });

  it('returns null when a create is refused', async () => {
    replies(null);
    expect(await client.createTask({ event: {}, deliveryOption: 'DIRECT' })).toBeNull();
  });
});
