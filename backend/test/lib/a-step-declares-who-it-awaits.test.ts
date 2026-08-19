/**
 * A STEP DECLARES WHO IT AWAITS, and the two accepted declarations mean one thing
 * (SPEC-TASK-STATE-TRANSITIONS §12.6).
 *
 * `awaits: { party: 'requester' }` is the declared form. `awaitsUser: true` is what a machine already
 * stored in a versioned profile, or carried through a profile export, still says, so it stays accepted
 * and normalizes to the same reference.
 *
 * WHY THE PARITY IS THE PROPERTY UNDER TEST. Every consumer of the wait - the first owner a task is
 * created with, the ownership boundary, the response hand-back, the router's "does this person owe an
 * answer", and the validator that refuses `requires` on a step awaiting nobody - used to read the
 * boolean directly. A consumer left on the boolean does not fail loudly when the shipped machines move
 * to the declared form: it silently decides that nothing awaits anybody, which reads as a workflow that
 * simply never blocks. So each consumer is exercised against BOTH forms of the same machine and the
 * outcomes are compared, rather than each being asserted once against whichever form it happens to see.
 *
 * The reference is deliberately the only one that ships. A party the runtime cannot resolve would leave
 * a step with no owner and nothing to say about it, so validation refuses one.
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

import {
  DEFAULT_TASK_STATE_MACHINES,
  awaitedPartyOf,
  validateTaskStateMachine,
  type TaskStateMachine,
  type TaskStateDef,
} from '../../lambda/src/lib/task-state-machines';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';
import type { Task } from '../../lambda/src/lib/task-tracking';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const REQUESTER = 'sub-requester';
const BOT_ID = 'AltSlot0';

type Cmd = { __type: string; input: Record<string, unknown> };
const cmds = (): Cmd[] => mockSend.mock.calls.map((c) => c[0] as Cmd);
const ownerWrites = () =>
  cmds()
    .filter((c) => c.__type === 'Update')
    .map((c) => String(c.input.UpdateExpression ?? ''))
    .filter((e) => e.includes('ownerId'));

/**
 * The same three-state workflow, said twice. `waiting` is the step blocked on the person; `working` is
 * the assistant getting on with it. Nothing else differs between the two machines, so any difference in
 * behaviour is the reading of the declaration and nothing else.
 */
const machineDeclaring = (waitingStateDef: TaskStateDef): Record<string, TaskStateMachine> => ({
  parity_flow: {
    initial: 'waiting',
    states: {
      waiting: waitingStateDef,
      working: { transitions: ['done'] },
      done: { transitions: [], terminal: 'success' },
    },
  },
});

const DECLARED = machineDeclaring({ transitions: ['working'], awaits: { party: 'requester' } });
const DEPRECATED = machineDeclaring({ transitions: ['working'], awaitsUser: true });
/** The control: the same graph with nobody waited on, so a passing parity check has an opposite. */
const AWAITS_NOBODY = machineDeclaring({ transitions: ['working'] });

const FORMS: Array<[string, Record<string, TaskStateMachine>]> = [
  ['the declared form', DECLARED],
  ['the deprecated boolean', DEPRECATED],
];

const EVENT = {
  inputTranscript: 'draft the Q3 report',
  requestAttributes: {
    'CHIME.channel.arn': CHANNEL,
    'CHIME.sender.arn': `arn:aws:chime:us-east-1:111:app-instance/i/user/${REQUESTER}`,
  },
};

function taskIn(taskState: string, over: Partial<Task> = {}): Task {
  return {
    taskId: 't1',
    channelArn: CHANNEL,
    taskType: 'parity_flow',
    taskState,
    status: 'in_progress' as const,
    userArn: `arn:aws:chime:us-east-1:111:app-instance/i/user/${REQUESTER}`,
    ownerId: BOT_ID,
    ownerType: 'assistant' as const,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    deliveryOption: DeliveryOption.TASK_MULTI_STEP,
    ttl: 0,
    ...over,
  } as Task;
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

describe('the two accepted declarations normalize to one reference', () => {
  it('reads the same party out of either form', () => {
    expect(awaitedPartyOf(DECLARED.parity_flow.states.waiting)).toEqual({ party: 'requester' });
    expect(awaitedPartyOf(DEPRECATED.parity_flow.states.waiting))
      .toEqual(awaitedPartyOf(DECLARED.parity_flow.states.waiting));
  });

  it('reads nobody out of a step that declares neither', () => {
    expect(awaitedPartyOf(AWAITS_NOBODY.parity_flow.states.waiting)).toBeNull();
    expect(awaitedPartyOf(DECLARED.parity_flow.states.working)).toBeNull();
    // An absent state (an unknown state name reaching a lookup) awaits nobody rather than throwing:
    // every caller resolves a state by name off a machine that may not declare it.
    expect(awaitedPartyOf(undefined)).toBeNull();
  });

  it('does not read a wait out of the boolean set false', () => {
    // `awaitsUser: false` is a step saying it awaits nobody, and it must not become a wait on the way
    // through the normalizer.
    expect(awaitedPartyOf({ transitions: ['working'], awaitsUser: false })).toBeNull();
  });

  it('refuses to invent a party nothing resolves', () => {
    // Only `requester` ships. A reference no resolver serves is refused rather than guessed at, and
    // every ingress validates before a machine gets this far.
    expect(awaitedPartyOf({ transitions: [], awaits: { party: 'manager-of-requester' } } as never)).toBeNull();
  });
});

describe('every shipped machine says who it awaits, in the declared form', () => {
  it('resolves a party for every waiting state in every shipped machine', () => {
    for (const [name, machine] of Object.entries(DEFAULT_TASK_STATE_MACHINES)) {
      const waiting = Object.entries(machine.states).filter(([, def]) => awaitedPartyOf(def));
      // These are the examples a deployment copies, so each has to have a wait to copy.
      expect({ machine: name, waiting: waiting.length > 0 }).toEqual({ machine: name, waiting: true });
      for (const [state, def] of waiting) {
        expect({ machine: name, state, party: awaitedPartyOf(def) })
          .toEqual({ machine: name, state, party: { party: 'requester' } });
      }
    }
  });

  it('leaves no shipped machine on the deprecated boolean', () => {
    // The shipped machines are the worked examples; one left on the old spelling teaches it.
    const stale = Object.entries(DEFAULT_TASK_STATE_MACHINES).flatMap(([name, machine]) =>
      Object.entries(machine.states)
        .filter(([, def]) => def.awaitsUser !== undefined)
        .map(([state]) => `${name}.${state}`));
    expect(stale).toEqual([]);
  });

  it('keeps every shipped machine valid under the party check', () => {
    for (const [name, machine] of Object.entries(DEFAULT_TASK_STATE_MACHINES)) {
      expect(() => validateTaskStateMachine(name, machine)).not.toThrow();
    }
  });
});

describe('a task is created with the same first owner from either form', () => {
  it.each(FORMS)('gives the requester the first step, declared in %s', async (_label, machines) => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    // A caller-supplied assistant owner is deliberately passed: a machine that starts blocked on a
    // person overrides it, which is what puts the item in that person's queue from its first moment.
    const task = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'parity_flow', undefined, {
      machines,
      owner: { id: BOT_ID, type: 'assistant' },
    });
    expect({ ownerId: task.ownerId, ownerType: task.ownerType })
      .toEqual({ ownerId: REQUESTER, ownerType: 'user' });
  });

  it('honours the caller\'s owner when the first step awaits nobody', async () => {
    // The opposite outcome, so the parity above is a decision rather than a constant.
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const task = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'parity_flow', undefined, {
      machines: AWAITS_NOBODY,
      owner: { id: BOT_ID, type: 'assistant' },
    });
    expect({ ownerId: task.ownerId, ownerType: task.ownerType })
      .toEqual({ ownerId: BOT_ID, ownerType: 'assistant' });
  });
});

describe('the ownership boundary falls in the same place for either form', () => {
  it.each(FORMS)('hands the task to the person on entering the wait, declared in %s', async (_label, machines) => {
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    // The regression edge back into the waiting step, from the assistant's own working state.
    const task = taskIn('working');
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}),
    );
    const withRegression = {
      parity_flow: {
        ...machines.parity_flow,
        states: {
          ...machines.parity_flow.states,
          working: { transitions: ['done', 'waiting'] },
        },
      },
    };

    const result = await advanceTaskStateTo({
      task, toState: 'waiting', assistantId: BOT_ID, machines: withRegression,
    });

    expect(result.ok).toBe(true);
    expect(ownerWrites().length).toBeGreaterThan(0);
    // Resolved against the task record, at the boundary: the reference is never stored as a principal.
    const values = cmds()
      .filter((c) => c.__type === 'Update')
      .map((c) => c.input.ExpressionAttributeValues as Record<string, unknown> | undefined)
      .filter(Boolean);
    expect(JSON.stringify(values)).toContain(REQUESTER);
  });

  it.each(FORMS)('hands it back to the assistant on leaving the wait, declared in %s', async (_label, machines) => {
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    const task = taskIn('waiting', { ownerId: REQUESTER, ownerType: 'user' });
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}),
    );

    await advanceTaskStateTo({ task, toState: 'working', assistantId: BOT_ID, machines });

    const values = cmds()
      .filter((c) => c.__type === 'Update')
      .map((c) => c.input.ExpressionAttributeValues as Record<string, unknown> | undefined)
      .filter(Boolean);
    expect(ownerWrites().length).toBeGreaterThan(0);
    expect(JSON.stringify(values)).toContain(BOT_ID);
  });

  it('moves nothing when the step it enters awaits nobody', async () => {
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    const task = taskIn('waiting');
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}),
    );

    await advanceTaskStateTo({ task, toState: 'working', assistantId: BOT_ID, machines: AWAITS_NOBODY });

    // The assistant held it and still does, so a partition move here would be pure churn.
    expect(ownerWrites()).toHaveLength(0);
  });
});

describe('a reply is read as the answer to the step under either form', () => {
  it.each(FORMS)('hands the work back and moves no state, declared in %s', async (_label, machines) => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    const task = taskIn('waiting', { ownerId: REQUESTER, ownerType: 'user' });
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}),
    );

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID, machines,
    });

    expect(r).toEqual({ applied: false, reason: 'deferred_to_model', from: 'waiting' });
    expect(ownerWrites().length).toBeGreaterThan(0);
  });

  it('treats the message as ordinary conversation when the step awaits nobody', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    const task = taskIn('waiting', { ownerId: REQUESTER, ownerType: 'user' });
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}),
    );

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID, machines: AWAITS_NOBODY,
    });

    expect(r.reason).toBe('not_awaiting');
  });
});

describe('a deployment pack carries the wait through in either form', () => {
  const packWith = (waiting: Record<string, unknown>) => JSON.stringify({
    intents: [{ key: 'reporting', description: 'a report request', keywords: ['report'] }],
    machines: {
      parity_flow: {
        initial: 'waiting',
        states: {
          waiting: { transitions: ['working'], ...waiting },
          working: { transitions: ['done'] },
          done: { transitions: [], terminal: 'success' },
        },
      },
    },
  });

  afterEach(() => {
    delete process.env.ASSISTANT_INTENT_PACK;
  });

  it.each([
    ['the declared form', { awaits: { party: 'requester' } }],
    ['the deprecated boolean', { awaitsUser: true }],
  ])('resolves the party the pack declared in %s', async (_label, waiting) => {
    // THE PACK PATH COERCES FIELD BY FIELD, so a declaration it does not name is dropped in silence and
    // the step reaches the runtime awaiting nobody. This is the predicate the router's "does this
    // person owe an answer" check evaluates, over exactly this merged view.
    process.env.ASSISTANT_INTENT_PACK = packWith(waiting);
    const { taskStateMachines, _resetIntentPackCache } = await import('../../lambda/src/lib/intent-pack');
    _resetIntentPackCache();

    const merged = taskStateMachines();
    expect(awaitedPartyOf(merged.parity_flow?.states?.waiting)).toEqual({ party: 'requester' });
    expect(awaitedPartyOf(merged.parity_flow?.states?.working)).toBeNull();
    // The platform defaults are still merged under it, in the declared form.
    expect(awaitedPartyOf(merged.report_generation?.states?.drafting_outline))
      .toEqual({ party: 'requester' });
  });

  it('refuses a pack machine that awaits a party nothing resolves', async () => {
    // Falling back to the defaults is the declared behaviour for a malformed machines block: better a
    // deployment runs the reference workflows than one whose steps can never find an owner.
    process.env.ASSISTANT_INTENT_PACK = packWith({ awaits: { party: 'whoever-is-around' } });
    const { taskStateMachines, _resetIntentPackCache } = await import('../../lambda/src/lib/intent-pack');
    _resetIntentPackCache();

    expect(taskStateMachines().parity_flow).toBeUndefined();
  });
});
