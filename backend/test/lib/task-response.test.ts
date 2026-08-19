/**
 * `applyUserResponseToTask` — one shape that keeps ANY workflow going.
 *
 * The rule the whole design collapses to: a state declared `awaitsUser` is blocked on the person and is
 * held by them, so when they speak in that conversation the machine reads their message as the response
 * to that step, moves on, and hands the work back to the assistant - which is what triggers the next
 * action. A duel resumes its side, a report starts generating, an extraction starts pulling; none of
 * them needs a sentinel, a marker or a waiting flag of its own.
 *
 * What is deliberately NOT claimed: this does not read the answer. It checks the structure - is the
 * machine waiting on a person, and is there exactly one way out - and defers anything the CONTENT has
 * to settle to the model's own `advance_task_state`, on the turn that has the text.
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  GetCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Get'; } },
  PutCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Put'; } },
  UpdateCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Update'; } },
  DeleteCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Delete'; } },
  QueryCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Query'; } },
  ScanCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Scan'; } },
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));

import { DeliveryOption } from '../../lambda/src/lib/delivery-options';
import type { Task } from '../../lambda/src/lib/task-tracking';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const USER_SUB = 'user-1';
const BOT_ID = 'Assistant';

type Cmd = { __type: string; input: Record<string, unknown> };
const cmds = (): Cmd[] => mockSend.mock.calls.map((c) => c[0] as Cmd);
const stateWrites = () =>
  cmds().filter((c) => c.__type === 'Update')
    .map((c) => String(c.input.UpdateExpression ?? ''))
    .filter((e) => e.includes('taskState'));
const ownerWrites = () =>
  cmds().filter((c) => c.__type === 'Update')
    .map((c) => String(c.input.UpdateExpression ?? ''))
    .filter((e) => e.includes('ownerId'));

function task(over: Partial<Task> = {}): Task {
  return {
    taskId: 't1',
    channelArn: CHANNEL,
    taskType: 'data_extraction',
    taskState: 'collecting_requirements',
    status: 'in_progress',
    userArn: `arn:aws:chime:us-east-1:111:app-instance/i/user/${USER_SUB}`,
    ownerId: USER_SUB,
    ownerType: 'user',
    deliveryOption: DeliveryOption.TASK_MULTI_STEP,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ttl: 0,
    ...over,
  } as Task;
}

function withTask(t: Task) {
  mockSend.mockImplementation((cmd: Cmd) =>
    cmd.__type === 'Get' ? Promise.resolve({ Item: t }) : Promise.resolve({}),
  );
}

beforeEach(() => {
  jest.resetModules();
  mockSend.mockReset();
  process.env.TASKS_TABLE = 'tasks';
  process.env.USER_TASKS_TABLE = 'user-tasks';
});

describe('applyUserResponseToTask', () => {
  it('advances a step the answer COMPLETES, and hands the work back so the next action fires', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    // place_item.confirming declares resolvedByOneResponse: a confirmation IS the step.
    withTask(task({ taskType: 'place_item', taskState: 'confirming' }));

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID,
    });


    expect(r).toMatchObject({ applied: true, from: 'confirming', to: 'placed' });
    expect(stateWrites().length).toBeGreaterThan(0);
    // The hand-back is the trigger: the assistant owns the work again and the turn proceeds.
    expect(ownerWrites().length).toBeGreaterThan(0);
  });

  it('does NOT move a machine that is not waiting on the person', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    // `extracting` is the assistant's own work. A remark while it runs is conversation, not a response,
    // and advancing on it would skip a step nobody completed.
    withTask(task({ taskState: 'extracting', ownerId: BOT_ID, ownerType: 'assistant' }));

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID,
    });

    expect(r).toMatchObject({ applied: false, reason: 'not_awaiting' });
    expect(stateWrites()).toHaveLength(0);
  });

  it('defers to the model when the answer may not COMPLETE the step, but still hands the work back', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    // guided_troubleshooting `awaiting_result` awaits the user and has three exits (worked / did not /
    // give up). Which one is a question about what they SAID, which this cannot read.
    withTask(task({ taskType: 'guided_troubleshooting', taskState: 'awaiting_result' }));

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID,
    });

    expect(r).toMatchObject({ applied: false, reason: 'deferred_to_model', from: 'awaiting_result' });
    expect(stateWrites()).toHaveLength(0);
    // Ownership still moves: the item stops being owed by the user, and the model picks the exit.
    expect(ownerWrites().length).toBeGreaterThan(0);
  });

  it('is a no-op for a task type with no machine', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    withTask(task({ taskType: 'not_a_machine' }));

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID,
    });

    expect(r).toMatchObject({ applied: false, reason: 'no_machine' });
    expect(stateWrites()).toHaveLength(0);
  });

  it('works the same for every workflow — the machine supplies the steps, not the caller', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    // Different features, one shape - and the SAME rule produces different outcomes because the
    // machines declare different things. Gathering requirements takes as many turns as it takes, so a
    // reply hands the work back and the model decides; a confirmation IS the step, so it advances.
    for (const [taskType, from, applied] of [
      ['report_generation', 'collecting_requirements', false],
      ['data_extraction', 'collecting_requirements', false],
      ['place_item', 'confirming', true],
    ] as const) {
      mockSend.mockReset();
      withTask(task({ taskType, taskState: from }));
      const r = await applyUserResponseToTask({
        taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID,
      });
      expect({ taskType, applied: r.applied }).toEqual({ taskType, applied });
      // Either way the assistant ends up holding the work, which is what fires the next action.
      expect(ownerWrites().length).toBeGreaterThan(0);
    }
  });
});
