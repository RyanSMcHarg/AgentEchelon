/**
 * Task transitions are OPTIMISTICALLY CONCURRENT (SPEC-TASK-STATE-TRANSITIONS §3, persistence half).
 *
 * `advanceTaskStateTo` authorizes the requested edge against `task.taskState`, which the caller read at
 * the START of the turn. Persisting that decision UNCONDITIONALLY meant the state graph was checked
 * against a value never re-verified at write time: if another turn advanced the task in between, the
 * write took an edge that is not legal from the state the task actually occupies, landing it somewhere
 * the machine forbids while reporting success to the model.
 *
 * Overlapping turns on one task are a real condition, not a theoretical one - `getActiveTask` already
 * carries a mitigation for a rapid follow-up turn arriving ~2s after a clarify, and
 * `deliverOnGeneration` walks several hops as separate writes.
 *
 * Mock + module-reset pattern matches task-tracking-cross-channel.test.ts in this dir.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

import { DeliveryOption } from '../lambda/src/lib/delivery-options.js';
import type { Task } from '../lambda/src/lib/task-tracking.js';

const baseTask = (over: Partial<Task> = {}): Task => ({
  taskId: 't1',
  channelArn: 'arn:chan',
  userArn: 'arn:user',
  userMessage: 'help',
  status: 'in_progress',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  taskType: 'guided_troubleshooting',
  taskState: 'collecting_symptoms',
  details: {},
  createdAt: 'x',
  updatedAt: 'x',
  ttl: 0,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.TASKS_TABLE = 'tasks-test';
});

describe('advanceTaskStateTo — optimistic concurrency on the persisted transition', () => {
  it('pins the write to the state it authorized FROM', async () => {
    mockSend.mockResolvedValueOnce({});
    const { advanceTaskStateTo } = await import('../lambda/src/lib/task-tracking');
    const res = await advanceTaskStateTo({ task: baseTask(), toState: 'diagnosing' });

    expect(res.ok).toBe(true);
    const upd = mockSend.mock.calls.find((c) => (c[0] as { __t?: string }).__t === 'Update');
    expect(upd).toBeDefined();
    const input = (upd![0] as { input: Record<string, any> }).input;
    // Without this condition the graph check is advisory: it is evaluated against a stale read and
    // never re-checked against the row being written.
    expect(input.ConditionExpression).toBe('taskState = :from');
    expect(input.ExpressionAttributeValues[':from']).toBe('collecting_symptoms');
    expect(input.ExpressionAttributeValues[':to']).toBe('diagnosing');
  });

  it('a lost race reports state_changed and NEVER reports success', async () => {
    // The task moved between the turn-start read and this write, so the edge we authorized is no
    // longer legal from where the task actually is. Telling the model the state advanced would leave
    // it reasoning about a task position that does not exist.
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }),
    );
    const { advanceTaskStateTo } = await import('../lambda/src/lib/task-tracking');
    const res = await advanceTaskStateTo({ task: baseTask(), toState: 'diagnosing' });

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ error: 'state_changed', from: 'collecting_symptoms' });
  });

  it('distinguishes a lost race from an infrastructure failure (different recovery)', async () => {
    // persist_failed is a retry candidate; state_changed is not - it needs a re-read and a fresh
    // decision. Collapsing them would send the caller down the wrong recovery path.
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' }),
    );
    const { advanceTaskStateTo } = await import('../lambda/src/lib/task-tracking');
    const res = await advanceTaskStateTo({ task: baseTask(), toState: 'diagnosing' });

    expect(res).toMatchObject({ ok: false, error: 'persist_failed' });
  });

  it('an illegal edge is still rejected before any write is attempted', async () => {
    // `resolved` IS a declared state of this machine, just not reachable from `collecting_symptoms`,
    // so this exercises the illegal-edge branch rather than the unknown-state one. The condition
    // added above must not become the only line of defence: authorization still short-circuits first.
    const { advanceTaskStateTo } = await import('../lambda/src/lib/task-tracking');
    const res = await advanceTaskStateTo({ task: baseTask(), toState: 'resolved' });

    expect(res).toMatchObject({ ok: false, error: 'illegal_transition' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
