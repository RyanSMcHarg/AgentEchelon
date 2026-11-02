/**
 * IF THE ASSISTANT DID NOT MOVE IT, THE BALL GOES BACK (maintainer, 2026-09-03).
 *
 * `maybeHandOver` gives a task to the ASSISTANT when a person replies at a step that awaits them, so
 * the turn that follows can act on it. That is meant to be momentary - hold it for the turn, advance
 * the machine, let the machine decide who holds it next.
 *
 * Nothing returned it when the turn advanced NOTHING. The state still declared that a person was
 * being waited on while `assigneeId` said the assistant held it, which is the one thing the ownership
 * model claims cannot happen: `awaits` and the owner disagreeing.
 *
 * MEASURED, not theorised. On the deployment, 56 tasks sat owned by the assistant in a state that
 * declares `awaits` - 50 `report_generation` in `collecting_requirements`, 6 `queued_request` in
 * `proposed`. Every one was invisible in its own requester's open-work list, because that list reads
 * the OWNER's partition. It is why a person could not see work that was waiting on them.
 *
 * It matters more now that a drain is a task (ADR-033): a drain hands over at `clarifying`, and
 * without this it would strand the same way the first time a reply parsed as nothing.
 *
 * ── WHY THIS ASSERTS ON THE WRITE ──────────────────────────────────────────────────────────────
 *
 * `recordNoTransitionTurn` calls `reassignTask` as an intra-module reference, so mocking the module
 * under test does not intercept it - the first version of this file did exactly that and four of its
 * assertions passed because the spy could never fire. Asserting on the DynamoDB write is what the
 * neighbouring ownership tests do, and it cannot pass vacuously: no write, no assertion.
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

import type { Task } from '../../lambda/src/lib/task-tracking';

// THE TABLE NAME IS READ AT MODULE LOAD, and an `import` hoists above any assignment beside it - so
// with the env set afterwards the module sees no table, `reassignTask` returns early, and every
// assertion here passes for the wrong reason. Set first, require second.
process.env.TASKS_TABLE = 'tasks-test';
process.env.USER_TASKS_TABLE = 'user-tasks-test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordNoTransitionTurn } = require('../../lambda/src/lib/task-tracking') as
  typeof import('../../lambda/src/lib/task-tracking');

const REQUESTER = '44581468-f091-704d-3f8e-4d41f866a0b4';
const ASSISTANT = 'ed31ac66-21f5-41d0-9fdf-faf1da43869c';
const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1';

const taskOf = (over: Partial<Task>): Task => ({
  taskId: 't1',
  channelArn: CHANNEL,
  userArn: `arn:aws:chime:us-east-1:123456789012:app-instance/i/user/${REQUESTER}`,
  requestExcerpt: 'a report please',
  status: 'pending',
  taskType: 'report_generation',
  taskState: 'collecting_requirements',
  details: {},
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
  ttl: 0,
  ...over,
} as Task);

/** The ownership writes this turn made, as {assigneeId, assigneeType} pairs. */
function ownershipWrites(): Array<{ id: unknown; type: unknown }> {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c?.__t === 'Update')
    .map((c) => c.input?.ExpressionAttributeValues ?? {})
    .filter((v) => v[':oid'] !== undefined && v[':otype'] !== undefined)
    .map((v) => ({ id: v[':oid'], type: v[':otype'] }));
}

describe('a turn that moved nothing returns an awaiting task to its person', () => {
  /**
   * Run a no-transition turn against one task, with the store answering consistently for it.
   *
   * ONE FIXTURE FOR BOTH THE ARGUMENT AND THE READ. `reassignTask` re-reads the row and returns early
   * when the current owner already equals the target, so a read reporting a DIFFERENT owner than the
   * task under test makes the write silently not happen - which is how this file failed twice while
   * the code under it was correct.
   */
  const unmoved = (over: Partial<Task>, opts: { writesFail?: boolean } = {}) => {
    const task = taskOf(over);
    mockSend.mockImplementation((cmd: { __t?: string }) => {
      if (cmd?.__t === 'Get') return Promise.resolve({ Item: task });
      if (opts.writesFail) return Promise.reject(new Error('throttled'));
      return Promise.resolve({ Attributes: { turnsInState: 1 } });
    });
    return recordNoTransitionTurn(task);
  };

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('hands back the two shapes actually found stranded on the deployment', async () => {
    await unmoved(({
      taskType: 'report_generation', taskState: 'collecting_requirements',
      assigneeId: ASSISTANT, assigneeType: 'assistant',
    }));
    expect(ownershipWrites()).toEqual([{ id: REQUESTER, type: 'user' }]);

    mockSend.mockClear();
    await unmoved(({
      taskType: 'queued_request', taskState: 'proposed',
      assigneeId: ASSISTANT, assigneeType: 'assistant',
    }));
    expect(ownershipWrites()).toEqual([{ id: REQUESTER, type: 'user' }]);
  });

  it('but NOT a drain, which never waits on anybody', async () => {
    // This asserted the opposite for a few hours, and the inversion is the rule rather than a
    // detail. A drain that hands over is a QUEUE that lives until somebody answers, and every
    // message in it is somebody else's wait too - so the drain reads, records and clears on the
    // assistant's timescale, and `clarifying` declares no `awaits`.
    //
    // The question is not dropped by not being held: each queued message that became work has its
    // own `queued_request`, opened in `proposed`, which DOES await the requester. The follow-up is
    // owned and visible there, on the task it is actually about.
    await unmoved(({
      taskType: 'queue_drain', taskState: 'clarifying',
      assigneeId: ASSISTANT, assigneeType: 'assistant',
    }));
    expect(ownershipWrites()).toEqual([]);
  });

  it('and the drain machine awaits nobody, at any step', () => {
    // The guard for the rule rather than for one state. `clarifying` is where it was declared and
    // where it would be reinstated, but the rule is about the machine: nothing in a drain may make
    // the queue wait on a person.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_TASK_STATE_MACHINES } = require('../../lambda/src/lib/task-state-machines');
    const states = DEFAULT_TASK_STATE_MACHINES.queue_drain.states as Record<string, { awaits?: unknown }>;

    expect(Object.entries(states).filter(([, def]) => def.awaits).map(([name]) => name)).toEqual([]);
  });

  it('leaves a state that awaits NOBODY with the assistant - it is still their work', async () => {
    await unmoved(({
      taskType: 'report_generation', taskState: 'extracting',
      assigneeId: ASSISTANT, assigneeType: 'assistant',
    }));
    expect(ownershipWrites()).toEqual([]);
  });

  it('writes nothing when the person already holds it', async () => {
    // No disagreement to correct, and a needless write on every unmoved turn is churn on a common path.
    await unmoved(({ assigneeId: REQUESTER, assigneeType: 'user' }));
    expect(ownershipWrites()).toEqual([]);
  });

  it('does not guess a requester it cannot resolve', async () => {
    // A userArn with no /user/ segment names nobody. Handing the task to an empty id would lose it
    // more thoroughly than leaving it with the assistant.
    await unmoved(({
      userArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i',
      assigneeId: ASSISTANT, assigneeType: 'assistant',
    }));
    expect(ownershipWrites()).toEqual([]);
  });

  it('still returns the stall count, because that is the caller\'s contract', async () => {
    const turns = await unmoved(({
      turnsInState: 2, assigneeId: ASSISTANT, assigneeType: 'assistant',
    }));
    expect(typeof turns).toBe('number');
  });

  it('a failed hand-back does not cost the turn', async () => {
    // Best effort by design: this improves which partition a row is listed under, and the turn that
    // just ran must not fail because a follow-up write did.
    await expect(
      unmoved({ assigneeId: ASSISTANT, assigneeType: 'assistant' }, { writesFail: true }),
    ).resolves.toBeDefined();
  });
});

/**
 * AND IT HANDS BACK THE DEPLOYMENT'S OWN TASK TYPES (code review, 2026-09-04).
 *
 * Task CREATION resolves its state machines through the intent pack, so a deployment that declares
 * its own types gets rows in states this module has never heard of. The hand-back read the PLATFORM
 * defaults, so for exactly those types `machines[task.taskType]` was undefined, nothing appeared to
 * be awaited, and the hand-back declined to run.
 *
 * The result is the stranding above, reintroduced for every type the platform does not ship: an
 * implementer's own task sits owned by the assistant in a state that declares it is waiting on its
 * requester, invisible in that person's open-work list. Worse than the original, because a deployment
 * defining its own machines is one whose types this file's fixtures will never mention.
 */
describe('a task type the deployment defined, not the platform', () => {
  const PACK = JSON.stringify({
    // A REAL INTENT, because a pack declaring none is invalid and falls back to the DEFAULT pack -
    // machines and all. An empty list here made the fixture assert against the platform defaults
    // while appearing to install its own.
    intents: [{ key: 'permit_application', description: 'Applying for a permit', keywords: ['permit'] }],
    machines: {
      permit_application: {
        initial: 'gathering',
        states: {
          gathering: { transitions: ['filed'], awaits: { party: 'requester' } },
          filed: { transitions: [], terminal: 'success' },
        },
      },
    },
  });

  beforeEach(() => {
    mockSend.mockReset();
    process.env.ASSISTANT_INTENT_PACK = PACK;
  });
  afterEach(() => {
    delete process.env.ASSISTANT_INTENT_PACK;
  });

  const unmovedPackTask = () => {
    const task = taskOf({ taskType: 'permit_application', taskState: 'gathering', assigneeId: ASSISTANT, assigneeType: 'assistant' });
    mockSend.mockImplementation((cmd: { __t?: string }) => {
      if (cmd?.__t === 'Get') return Promise.resolve({ Item: task });
      return Promise.resolve({ Attributes: { turnsInState: 1 } });
    });
    return recordNoTransitionTurn(task);
  };

  it('goes back to the requester, the same as a platform type', async () => {
    await unmovedPackTask();
    expect(ownershipWrites()).toEqual([{ id: REQUESTER, type: 'user' }]);
  });

  it('and a pack that declares no machines still gets the platform ones', async () => {
    // The resolver merges over the defaults, so declaring one machine must not cost a deployment
    // every other. Asserted through the platform type, with the pack above still installed.
    const task = taskOf({ assigneeId: ASSISTANT, assigneeType: 'assistant' });
    mockSend.mockImplementation((cmd: { __t?: string }) => {
      if (cmd?.__t === 'Get') return Promise.resolve({ Item: task });
      return Promise.resolve({ Attributes: { turnsInState: 1 } });
    });
    await recordNoTransitionTurn(task);
    expect(ownershipWrites()).toEqual([{ id: REQUESTER, type: 'user' }]);
  });
});
