/**
 * A TASK'S USER-TASKS COPY FOLLOWS ITS STEP.
 *
 * The copy is what the chat app's task list, `open_work_summary` and the Tasks console read, and each
 * names the step from it. Every edge `advanceTaskStateTo` takes is mirrored onto the copy, through the
 * same write a reopen uses, so the copy names the step the task is on.
 *
 * What this pins:
 *  - an ordinary edge updates the copy's `taskState` (and the details it merged), conditioned on the
 *    copy existing, and leaves the copy's status alone;
 *  - a task with no copy transitions cleanly and does not gain one;
 *  - a task with no resolvable holder writes no copy at all;
 *  - a reopen still returns the copy to running, and carries the step with it.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  DeleteCommand: jest.fn().mockImplementation((a) => ({ __t: 'Delete', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

import { DeliveryOption } from '../../lambda/src/lib/delivery-options';
import type { Task } from '../../lambda/src/lib/task-tracking';

const report = (over: Partial<Task> = {}): Task => ({
  taskId: 't-report',
  channelArn: 'arn:chan',
  userArn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/alice',
  ownerPersonId: 'alice',
  assistantId: 'premium-bot',
  userMessage: 'write me a report',
  status: 'in_progress',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  taskType: 'report_generation',
  taskState: 'generating',
  details: { topic: 'churn' },
  createdAt: 'x',
  updatedAt: 'x',
  ttl: 0,
  assigneeId: 'premium-bot',
  assigneeType: 'assistant',
  ...over,
} as Task);

type Sent = { __t?: string; input: Record<string, any> };
const sent = (): Sent[] => mockSend.mock.calls.map((c) => c[0] as Sent);
const copyWrites = (): Sent[] => sent().filter((c) => c.input.TableName === 'user-tasks-test');

describe('every edge is mirrored onto the user-tasks copy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.TASKS_TABLE = 'tasks-test';
    process.env.USER_TASKS_TABLE = 'user-tasks-test';
  });

  afterAll(() => {
    delete process.env.TASKS_TABLE;
    delete process.env.USER_TASKS_TABLE;
  });

  it('an ordinary edge sets the copy\'s state and details, only where the copy exists, and leaves its status alone', async () => {
    mockSend.mockResolvedValue({});
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    const task = report();

    const res = await advanceTaskStateTo({ task, toState: 'revising', details: { section: 'retention' } });

    expect(res).toMatchObject({ ok: true, from: 'generating', to: 'revising' });
    const [copy] = copyWrites();
    expect(copy.__t).toBe('Update');
    expect(copy.input.Key).toEqual({ principalId: 'premium-bot', taskId: 't-report' });
    expect(copy.input.ConditionExpression).toBe('attribute_exists(taskId)');
    expect(copy.input.UpdateExpression).toContain('taskState = :ts');
    expect(copy.input.ExpressionAttributeValues[':ts']).toBe('revising');
    expect(copy.input.ExpressionAttributeValues[':details']).toEqual({ topic: 'churn', section: 'retention' });
    expect(copy.input.UpdateExpression).not.toContain('#s = :s');
    expect(copy.input.ExpressionAttributeNames['#s']).toBeUndefined();
  });

  it('the copy is written after the task row, so it never names a step the row refused', async () => {
    mockSend.mockResolvedValue({});
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');

    await advanceTaskStateTo({ task: report(), toState: 'revising' });

    const tables = sent().map((c) => c.input.TableName);
    expect(tables.indexOf('tasks-test')).toBeLessThan(tables.indexOf('user-tasks-test'));
  });

  it('a lost race on the task row writes no copy', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('moved'), { name: 'ConditionalCheckFailedException' }));
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');

    const res = await advanceTaskStateTo({ task: report(), toState: 'revising' });

    expect(res).toMatchObject({ ok: false, error: 'state_changed' });
    expect(copyWrites()).toHaveLength(0);
  });

  it('a task with no copy transitions cleanly and does not gain one', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSend.mockImplementation(async (cmd: Sent) => {
      if (cmd.input.TableName === 'user-tasks-test') {
        throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      }
      return {};
    });
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    const task = report();

    const res = await advanceTaskStateTo({ task, toState: 'revising' });

    expect(res).toMatchObject({ ok: true, from: 'generating', to: 'revising' });
    expect(task.taskState).toBe('revising');
    const copies = copyWrites();
    expect(copies).toHaveLength(1);
    expect(copies[0].input.ConditionExpression).toBe('attribute_exists(taskId)');
    expect(sent().some((c) => c.__t === 'Put')).toBe(false);
    expect(warn.mock.calls.some((args) => String(args[0]).includes('mirror'))).toBe(false);
    warn.mockRestore();
  });

  it('a task no one holds, such as an event task with no requester, writes no copy', async () => {
    mockSend.mockResolvedValue({});
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    const task = report({ userArn: '', ownerPersonId: undefined, assigneeId: undefined, assigneeType: undefined });

    const res = await advanceTaskStateTo({ task, toState: 'revising' });

    expect(res).toMatchObject({ ok: true, to: 'revising' });
    expect(copyWrites()).toHaveLength(0);
  });

  it('a reopen returns the copy to running and carries the step, through the same write', async () => {
    mockSend.mockResolvedValue({});
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    const task = report({ status: 'completed', taskState: 'completed' });

    const res = await advanceTaskStateTo({ task, toState: 'revising', by: 'tool' });

    expect(res).toMatchObject({ ok: true, reopened: true });
    const copies = copyWrites();
    expect(copies).toHaveLength(1);
    expect(copies[0].input.ExpressionAttributeValues[':s']).toBe('in_progress');
    expect(copies[0].input.ExpressionAttributeValues[':ts']).toBe('revising');
  });
});
