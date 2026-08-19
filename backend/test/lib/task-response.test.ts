/**
 * `applyUserResponseToTask` — one shape that keeps ANY workflow going.
 *
 * The rule the whole design collapses to: a state that declares `awaits` is blocked on that party and is
 * held by them, so when they speak in that conversation the machine reads their message as the response
 * to that step, moves on, and hands the work back to the assistant - which is what triggers the next
 * action. A duel resumes its side, a report starts generating, an extraction starts pulling; none of
 * them needs a sentinel, a marker or a waiting flag of its own.
 *
 * What is deliberately NOT claimed: this does not read the answer, and since it cannot, it does not
 * move the machine either. It checks one structural thing - is this state waiting on a person - and
 * defers every transition to the model's own `advance_task_state`, on the turn that has the text.
 *
 * IT USED TO ADVANCE ONE CASE ITSELF: a state declaring `resolvedByOneResponse` with a single exit.
 * `place_item.confirming` is that state, and the check behind the flag is structural, so "actually,
 * make it 45 minutes" and "no, do not add it" both moved the task to `placed` - a SUCCESS terminal
 * that closes it. The plan recorded an approval nobody gave and the correction had nowhere to go.
 * Nothing structural separates those replies from a "yes", so the flag now speaks to the model
 * (rendered by `buildTaskContextForPrompt`) instead of acting on its behalf.
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
  it('does NOT place a proposal on a reply it cannot read, even at a one-answer step', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    // place_item.confirming declares resolvedByOneResponse AND has one exit - the exact shape that
    // used to advance here. The reply reaching this function might be "yes", "make it 45 minutes" or
    // "do not add it", and nothing here can tell them apart, so it must move nothing.
    withTask(task({ taskType: 'place_item', taskState: 'confirming' }));

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID,
    });

    expect(r).toMatchObject({ applied: false, reason: 'deferred_to_model', from: 'confirming' });
    // `placed` is the machine's SUCCESS terminal, so a write here is the task recording an approval
    // that may never have been given and closing itself on the strength of it.
    expect(stateWrites()).toHaveLength(0);
    // The hand-back still happens: it is the trigger that makes the turn act on their reply.
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

  it('works the same for every workflow — one shape, and no state is a special case', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    // Different features, one outcome. The last row is the one that used to differ, and the exception
    // it carried was the defect: a confirmation step advanced on whatever arrived. Every waiting step
    // now hands the work back and lets the model read what was actually said.
    for (const [taskType, from] of [
      ['report_generation', 'collecting_requirements'],
      ['report_generation', 'drafting_outline'],
      ['data_extraction', 'collecting_requirements'],
      ['guided_troubleshooting', 'awaiting_result'],
      ['place_item', 'confirming'],
      ['action_item', 'options_presented'],
    ] as const) {
      mockSend.mockReset();
      withTask(task({ taskType, taskState: from }));
      const r = await applyUserResponseToTask({
        taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID,
      });
      expect({ taskType, from, reason: r.reason }).toEqual({ taskType, from, reason: 'deferred_to_model' });
      expect({ taskType, from, stateWrites: stateWrites().length }).toEqual({ taskType, from, stateWrites: 0 });
      // Either way the assistant ends up holding the work, which is what fires the next action.
      expect(ownerWrites().length).toBeGreaterThan(0);
    }
  });

  it('leaves NO state in any shipped machine that this function would advance', async () => {
    // The family form of the rule, so a machine added later cannot reintroduce the exception by
    // declaring the flag and being forgotten. Every waiting step, in every declared machine, defers.
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    const { DEFAULT_TASK_STATE_MACHINES, awaitedPartyOf } = await import('../../lambda/src/lib/task-state-machines');

    for (const [taskType, machine] of Object.entries(DEFAULT_TASK_STATE_MACHINES)) {
      for (const [taskState, def] of Object.entries(machine.states)) {
        // Through the normalizer, or this loop skips every state in every shipped machine and the
        // family form of the rule checks nothing at all.
        if (!awaitedPartyOf(def)) continue;
        mockSend.mockReset();
        withTask(task({ taskType, taskState }));
        const r = await applyUserResponseToTask({
          taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID,
        });
        expect({ taskType, taskState, applied: r.applied }).toEqual({ taskType, taskState, applied: false });
        expect({ taskType, taskState, stateWrites: stateWrites().length })
          .toEqual({ taskType, taskState, stateWrites: 0 });
      }
    }
  });
});
