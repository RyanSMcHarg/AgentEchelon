/**
 * A TASK MUST SAY WHEN IT ENDED, AND THE QUEUE MUST LEARN IT (tracker rows 49/50, ADR-024).
 *
 * Two halves of one defect, and neither errored:
 *
 * 1. **Nothing recorded the ending.** `stateHistory` is the append-only record of a task's life and
 *    every graph transition landed in it - except the last one. `updateTaskStatus` set
 *    `status='completed'` and appended nothing, so the row said the task was finished and nothing said
 *    WHEN, HOW it went, or by whom. The only timestamp left was `updatedAt`, which every write moves.
 *    Task resolution is measured separately from turn latency precisely so a four-hour task with
 *    twenty seconds of assistant time reads as healthy - and that measurement needs a stamped ending
 *    or every finished task is a silent gap in the population.
 *
 * 2. **The queue never let go.** `/tasks/mine` reads the MIRROR row, and only pause and resume ever
 *    mirrored a status. A completed task therefore sat at `in_progress` in the person's queue for the
 *    whole of its TTL. Observed on the deployment: one test user holding nine "open" items, finished
 *    ones among them.
 *
 * The second half is not cosmetic. The composer addresses a person's next message at the assistant
 * holding their open item (ADR-032), so a queue that never releases would point a reply at work that
 * is already done - a wrong answer, arriving for a right-looking reason.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  DeleteCommand: jest.fn().mockImplementation((a) => ({ __t: 'Delete', input: a })),
  ScanCommand: jest.fn().mockImplementation((a) => ({ __t: 'Scan', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const CHANNEL = 'arn:chan/c1';
const OWNER = 'sub-alice';

/** The source-of-truth row `updateTaskStatus` reads back before mirroring the ending. */
const TASK_ROW = {
  taskId: 't-1',
  channelArn: CHANNEL,
  status: 'completed',
  taskType: 'report_generation',
  ownerId: OWNER,
  ownerType: 'user',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.TASKS_TABLE = 'tasks-test';
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  mockSend.mockImplementation(async (cmd: { __t: string }) =>
    cmd.__t === 'Get' ? { Item: TASK_ROW } : {});
});

/** Every write aimed at a table, by command kind. */
const writes = (table: string, kind = 'Update') =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.__t === kind && c.input.TableName === table);

/** The terminal entry the source-of-truth update appends, decoded from the UpdateCommand. */
const appendedEntry = () => {
  const [cmd] = writes('tasks-test');
  return cmd?.input?.ExpressionAttributeValues?.[':terminalEntry']?.[0];
};

describe('a task records its own ending', () => {
  it('appends a terminal entry to the history, with the outcome', async () => {
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'completed', 'the report is attached');

    const entry = appendedEntry();
    expect(entry).toBeDefined();
    // `success`, not merely "completed": the outcome is what a resolution measurement reports on, and
    // a status string alone cannot distinguish finishing from giving up.
    expect(entry.terminal).toBe('success');
    expect(entry.by).toBe('system');
    expect(typeof entry.at).toBe('string');
    // NOT a graph edge. A lightweight task has no state machine and still ends; reading an ending as
    // an edge is the confusion the ownership entries in this same log already avoid.
    expect(entry.from).toBeUndefined();
    expect(entry.to).toBeUndefined();
  });

  it('distinguishes how it ended', async () => {
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'failed', undefined, 'the tool timed out');
    expect(appendedEntry().terminal).toBe('failure');
    expect(appendedEntry().reason).toContain('the tool timed out');

    mockSend.mockClear();
    await updateTaskStatus('t-1', CHANNEL, 'cancelled');
    expect(appendedEntry().terminal).toBe('handoff');
  });

  it('appends onto a task that never had a history', async () => {
    // A lightweight single-turn task has no machine and so no transitions. Without `if_not_exists` the
    // ending would be dropped for want of a list to append to - which is precisely the task shape most
    // likely to end without ceremony.
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'completed');
    const [cmd] = writes('tasks-test');
    expect(cmd.input.UpdateExpression).toContain('list_append(if_not_exists(#stateHistory, :empty)');
  });

  it('does NOT end a task that is merely progressing', async () => {
    // `in_progress` is written on every task turn. An ending appended there would make every turn look
    // like a conclusion, and would put a read and a write on the per-turn path.
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'in_progress');
    expect(appendedEntry()).toBeUndefined();
  });

  it('does NOT end an abandoned task', async () => {
    // The person dropped out and may come back, so it stays active and a nudge can offer to resume it.
    // Ending it here would delete the thing the nudge exists to offer.
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'abandoned');
    expect(appendedEntry()).toBeUndefined();
  });

  it('keeps ONE record of the ending, not a column beside it', async () => {
    // A `resolvedAt` scalar would be a second source for one fact, free to disagree with the entry
    // describing it. The log already holds per-transition instants.
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'completed');
    const [cmd] = writes('tasks-test');
    expect(cmd.input.UpdateExpression).not.toMatch(/resolvedAt|terminalAt/);
  });
});

describe('the queue lets go when the work ends', () => {
  it('mirrors the ending, so the item leaves `/tasks/mine`', async () => {
    // The queue reads the mirror and filters to pending/in_progress. Without this write the row stays
    // `in_progress` for its whole TTL and the person is told they still owe finished work.
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'completed', 'done');

    const mirrored = writes('user-tasks-test');
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].input.Key).toEqual({ userSub: OWNER, taskId: 't-1' });
    expect(mirrored[0].input.ExpressionAttributeValues[':s']).toBe('completed');
  });

  it('mirrors a failure and a cancellation too', async () => {
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'failed', undefined, 'nope');
    expect(writes('user-tasks-test')).toHaveLength(1);

    mockSend.mockClear();
    await updateTaskStatus('t-1', CHANNEL, 'cancelled');
    expect(writes('user-tasks-test')).toHaveLength(1);
  });

  it('does not touch the mirror on a per-turn progress write', async () => {
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await updateTaskStatus('t-1', CHANNEL, 'in_progress');
    expect(writes('user-tasks-test')).toHaveLength(0);
    // And it does not spend a read to find out it had nothing to do.
    expect(mockSend.mock.calls.map((c) => c[0].__t)).not.toContain('Get');
  });

  it('survives a source row it cannot read back', async () => {
    // The ending is already durable on the source row at this point. A mirror miss must not throw and
    // undo that - the queue is a convenience index, and the next write corrects it.
    mockSend.mockImplementation(async (cmd: { __t: string }) => (cmd.__t === 'Get' ? {} : {}));
    const { updateTaskStatus } = await import('../../lambda/src/lib/task-tracking');
    await expect(updateTaskStatus('t-1', CHANNEL, 'completed')).resolves.toBeUndefined();
    expect(writes('user-tasks-test')).toHaveLength(0);
  });
});
