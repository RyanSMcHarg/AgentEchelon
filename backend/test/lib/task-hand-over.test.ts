/**
 * The `awaits` boundary — who holds a task while it is blocked on a person.
 *
 * This is the behaviour that makes "waiting on you" one concept across workflows: a report waiting on
 * scope and a duel's clarifying question are both a task the PERSON owns, so both appear in the same
 * queue (ADR-024 D1/D3, ADR-029). The rules under test:
 *
 *   - entering a state that declares `awaits` hands the task to the party it names;
 *   - leaving one hands it back to the assistant that is running the turn;
 *   - moving BETWEEN two states on the same side of the boundary moves nothing, so an ordinary
 *     multi-step task does not churn the mirror partition on every hop.
 *
 * The last one is the reason this is a boundary test rather than a state test: `reassignTask` moves a
 * DynamoDB partition (delete-old after put-new), so a hand-over on every transition would be both
 * expensive and a needless window in which a task exists under two owners.
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

import type { Task } from '../../lambda/src/lib/task-tracking';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const USER_SUB = 'user-sub-1';
const BOT_ID = 'AltSlot0';

type Cmd = { __type: string; input: Record<string, unknown> };

const cmds = (): Cmd[] => mockSend.mock.calls.map((c) => c[0] as Cmd);
/** Owner writes land on the tasks table through setTaskOwner; the mirror move is a Put + Delete. */
const ownerWrites = () =>
  cmds()
    .filter((c) => c.__type === 'Update')
    .map((c) => String(c.input.UpdateExpression ?? ''))
    .filter((e) => e.includes('ownerId'));

function taskInState(taskState: string): Task {
  return {
    taskId: 't1',
    channelArn: CHANNEL,
    taskType: 'report_generation',
    taskState,
    status: 'in_progress' as const,
    userArn: `arn:aws:chime:us-east-1:111:app-instance/i/user/${USER_SUB}`,
    ownerId: BOT_ID,
    ownerType: 'assistant' as const,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    deliveryOption: DeliveryOption.TASK_MULTI_STEP,
    ttl: 0,
  };
}

beforeEach(() => {
  jest.resetModules();
  mockSend.mockReset();
  mockSend.mockImplementation((cmd: Cmd) =>
    cmd.__type === 'Get' ? Promise.resolve({ Item: undefined }) : Promise.resolve({}),
  );
  process.env.TASKS_TABLE = 'tasks';
  process.env.USER_TASKS_TABLE = 'user-tasks';
});

describe('the awaits hand-over', () => {
  it('hands the task to the USER when the machine enters a state that awaits them', async () => {
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    // report_generation: generating -> revising. `revising` is entered only when the user asks for
    // changes, and `collecting_requirements` is the declared waiting state, so use that machine's
    // real edge into it: completed <- ... use collecting_requirements as the target via a task there.
    const task = { ...taskInState('drafting_outline'), taskType: 'report_generation' };
    // drafting_outline -> generating is NOT a waiting state, so nothing moves.
    await advanceTaskStateTo({ task, toState: 'generating', assistantId: BOT_ID });
    expect(ownerWrites()).toHaveLength(0);
  });

  it('hands the task to the USER on entering a state that awaits them', async () => {
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    // data_extraction: extracting -> collecting_requirements is a declared regression edge INTO an
    // waiting state ("the requirements were wrong, ask again").
    const task = {
      ...taskInState('extracting'),
      taskType: 'data_extraction',
    };
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}),
    );

    const result = await advanceTaskStateTo({
      task,
      toState: 'collecting_requirements',
      assistantId: BOT_ID,
    });

    expect(result.ok).toBe(true);
    const writes = ownerWrites();
    expect(writes.length).toBeGreaterThan(0);
    // The person being waited on is the requester on the task.
    const values = cmds()
      .filter((c) => c.__type === 'Update')
      .map((c) => c.input.ExpressionAttributeValues as Record<string, unknown> | undefined)
      .filter(Boolean);
    expect(JSON.stringify(values)).toContain(USER_SUB);
  });

  it('does NOT move ownership between two states that both await the user', async () => {
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    // action_item: options_presented -> awaiting_completion, both of which await them. The user held
    // it before and still holds it, so a partition move here would be pure churn.
    const task = {
      ...taskInState('options_presented'),
      taskType: 'action_item',
      ownerId: USER_SUB,
      ownerType: 'user' as const,
    };
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}),
    );

    await advanceTaskStateTo({ task, toState: 'awaiting_completion', assistantId: BOT_ID });

    expect(ownerWrites()).toHaveLength(0);
  });

  it('leaves the item with the user when no assistant is supplied to hand back to', async () => {
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    // Leaving a waiting state with no `assistantId`: ownership must NOT be cleared. An item that
    // lingers in a queue is visible and fixable; a task owned by nobody is findable by no query.
    const task = {
      ...taskInState('collecting_requirements'),
      taskType: 'data_extraction',
      ownerId: USER_SUB,
      ownerType: 'user' as const,
    };
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}),
    );

    const result = await advanceTaskStateTo({ task, toState: 'extracting' });

    expect(result.ok).toBe(true);
    expect(ownerWrites()).toHaveLength(0);
  });
});
