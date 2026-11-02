/**
 * A REPORT IS REVISABLE, AND A DELIVERED REPORT IS STILL NOT OPEN WORK.
 *
 * Delivery closes a report (`generating -> completed`), so a change is almost always asked for after
 * the task has ended. `completed` was terminal with nothing declared on it, so that change had no legal
 * edge: the live branch run recorded `generating -> completed` and the revision it asked for went
 * nowhere. Making `completed` non-terminal would leave every delivered report open in the person's
 * list, so the terminal state DECLARES a reopen instead (`reopens`, task-state-machines.ts).
 *
 * What this pins:
 *  - validation: a reopen is a terminal state's declaration, and its targets are declared non-terminal
 *    states of the same machine;
 *  - authorization: `completed -> revising` is legal only as a declared reopen, only for the model's
 *    call, and every other terminal stays final;
 *  - persistence: the reopen edge records its author, returns the status to running and mirrors it,
 *    and a reopened task no longer reads as ended;
 *  - resolution: a recently completed reopenable task is the subject of its requester's follow-up and
 *    of nobody else's, and a completed report is filtered out of the open-work read.
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

import {
  DEFAULT_TASK_STATE_MACHINES,
  assistantOwesTheStep,
  authorizeTransition,
  isReopenEdge,
  reopenTargetsFrom,
  validateTaskStateMachine,
  validateTaskStateMachines,
  type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import { reopenableFollowUpSubject } from '../../lambda/src/lib/task-continuity';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';
import type { Task } from '../../lambda/src/lib/task-tracking';

const M = DEFAULT_TASK_STATE_MACHINES;

const completedReport = (over: Partial<Task> = {}): Task => ({
  taskId: 't-report',
  channelArn: 'arn:chan',
  userArn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/alice',
  ownerPersonId: 'alice',
  assistantId: 'premium-bot',
  userMessage: 'write me a report',
  status: 'completed',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  taskType: 'report_generation',
  taskState: 'completed',
  details: {},
  createdAt: 'x',
  updatedAt: 'x',
  ttl: 0,
  ...over,
});

const machineWith = (completed: Record<string, unknown>): TaskStateMachine => ({
  initial: 'working',
  states: {
    working: { transitions: ['done'] },
    done: { transitions: [], terminal: 'success', ...completed },
  },
});

describe('a reopen is a declaration on a terminal state', () => {
  it('the shipped report machine declares it and validates', () => {
    expect(M.report_generation.states.completed.transitions).toEqual([]);
    expect(M.report_generation.states.completed.terminal).toBe('success');
    expect(M.report_generation.states.completed.reopens).toEqual(['revising']);
    expect(() => validateTaskStateMachines(M)).not.toThrow();
  });

  it('accepts a reopen into a declared non-terminal state', () => {
    expect(() => validateTaskStateMachine('ok', machineWith({ reopens: ['working'] }))).not.toThrow();
  });

  it('refuses a reopen declared on a state that still has transitions', () => {
    const m: TaskStateMachine = {
      initial: 'working',
      states: {
        working: { transitions: ['done'], reopens: ['working'] },
        done: { transitions: [], terminal: 'success' },
      },
    };
    expect(() => validateTaskStateMachine('bad', m)).toThrow(/declares reopens but is not terminal/);
  });

  it('refuses a reopen into an undeclared state', () => {
    expect(() => validateTaskStateMachine('bad', machineWith({ reopens: ['nowhere'] })))
      .toThrow(/reopens to undeclared state "nowhere"/);
  });

  it('refuses a reopen into a terminal state, which would reopen a task into an ending', () => {
    expect(() => validateTaskStateMachine('bad', machineWith({ reopens: ['done'] })))
      .toThrow(/reopens to terminal state "done"/);
  });

  it('refuses a reopen that is not a list', () => {
    expect(() => validateTaskStateMachine('bad', machineWith({ reopens: 'working' })))
      .toThrow(/not a list/);
  });
});

describe('completed -> revising is authorized only as a reopen', () => {
  it('is a reopen for the model\'s call', () => {
    expect(isReopenEdge('report_generation', 'completed', 'revising', M)).toBe(true);
    expect(authorizeTransition('report_generation', 'completed', 'revising', M))
      .toEqual({ ok: true, from: 'completed', to: 'revising', reopen: true });
  });

  it('is refused for a runtime writer, because a reopen is the person asking', () => {
    expect(authorizeTransition('report_generation', 'completed', 'revising', M, { by: 'system' }))
      .toEqual({ ok: false, error: 'illegal_transition', from: 'completed', legal: [] });
  });

  it('is the only move: a reopen does not open every edge out of the terminal', () => {
    expect(authorizeTransition('report_generation', 'completed', 'generating', M))
      .toEqual({ ok: false, error: 'illegal_transition', from: 'completed', legal: ['revising'] });
  });

  it('leaves every other terminal final', () => {
    for (const [type, machine] of Object.entries(M)) {
      for (const [state, def] of Object.entries(machine.states)) {
        if (def.transitions.length > 0) continue;
        if (type === 'report_generation' && state === 'completed') continue;
        if (type === 'image_generation' && state === 'done') continue;
        expect({ type, state, reopens: reopenTargetsFrom(type, state, M) }).toEqual({ type, state, reopens: [] });
      }
    }
    // A delivered image reopens into review, the way a finished report does, and its failure stays final.
    expect(reopenTargetsFrom('image_generation', 'done', M)).toEqual(['revise']);
    expect(reopenTargetsFrom('image_generation', 'failed', M)).toEqual([]);
    expect(authorizeTransition('guided_troubleshooting', 'resolved', 'diagnosing', M))
      .toMatchObject({ ok: false, error: 'illegal_transition', legal: [] });
    expect(authorizeTransition('code_delivery', 'completed', 'revising', M))
      .toMatchObject({ ok: false, error: 'illegal_transition' });
  });

  it('does not change the ordinary edges into revising', () => {
    expect(authorizeTransition('report_generation', 'generating', 'revising', M))
      .toEqual({ ok: true, from: 'generating', to: 'revising', terminal: undefined });
    expect(authorizeTransition('report_generation', 'revising', 'completed', M))
      .toEqual({ ok: true, from: 'revising', to: 'completed', terminal: 'success' });
  });

  it('a finished report is owed by nobody, so a follow-up is never declined as a second thread', () => {
    const worked = { correlationId: 'turn-1' };
    expect(assistantOwesTheStep(M, 'report_generation', 'completed', worked)).toBe(false);
    expect(assistantOwesTheStep(M, 'report_generation', 'completed', null)).toBe(false);
    expect(assistantOwesTheStep(M, 'report_generation', 'generating', worked)).toBe(true);
  });
});

describe('the reopen is persisted with its author and returns the task to running', () => {
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

  it('records reopen and by: tool on the edge, sets in_progress in the same write, and mirrors it', async () => {
    mockSend.mockResolvedValue({});
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');
    const task = completedReport({ assigneeId: 'premium-bot', assigneeType: 'assistant' } as Partial<Task>);

    const res = await advanceTaskStateTo({ task, toState: 'revising', by: 'tool', reason: 'they asked for a churn section' });

    expect(res).toEqual({ ok: true, from: 'completed', to: 'revising', terminal: undefined, reopened: true });
    const updates = mockSend.mock.calls.map((c) => c[0] as { __t?: string; input: Record<string, any> })
      .filter((c) => c.__t === 'Update');
    const edge = updates.find((u) => u.input.TableName === 'tasks-test')!.input;
    expect(edge.ConditionExpression).toBe('taskState = :from');
    expect(edge.UpdateExpression).toContain('#status = :inProgress');
    expect(edge.ExpressionAttributeValues[':inProgress']).toBe('in_progress');
    expect(edge.ExpressionAttributeValues[':entry'][0]).toMatchObject({
      from: 'completed', to: 'revising', by: 'tool', reopen: true,
    });
    const mirror = updates.find((u) => u.input.TableName === 'user-tasks-test')!.input;
    expect(mirror.ExpressionAttributeValues[':s']).toBe('in_progress');
    expect(task.status).toBe('in_progress');
    expect(task.taskState).toBe('revising');
  });

  it('writes nothing when a runtime writer asks for the reopen', async () => {
    mockSend.mockResolvedValue({});
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');

    const res = await advanceTaskStateTo({ task: completedReport(), toState: 'revising', by: 'system' });

    expect(res).toMatchObject({ ok: false, error: 'illegal_transition' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an ordinary edge carries no reopen mark and leaves the status alone', async () => {
    mockSend.mockResolvedValue({});
    const { advanceTaskStateTo } = await import('../../lambda/src/lib/task-tracking');

    await advanceTaskStateTo({ task: completedReport({ status: 'in_progress', taskState: 'generating' }), toState: 'revising' });

    const edge = (mockSend.mock.calls[0][0] as { input: Record<string, any> }).input;
    expect(edge.UpdateExpression).not.toContain('#status');
    expect(edge.ExpressionAttributeValues[':entry'][0].reopen).toBeUndefined();
  });

  it('a task reopened after its ending no longer reads as ended', async () => {
    const { taskEndedAt } = await import('../../lambda/src/lib/task-tracking');
    const ended = [
      { from: 'generating', to: 'completed', at: '2026-10-16T10:00:00Z', by: 'system' as const },
      { at: '2026-10-16T10:00:01Z', by: 'system' as const, terminal: 'success' as const },
    ];
    expect(taskEndedAt({ stateHistory: ended })).toBe('2026-10-16T10:00:01Z');

    const reopened = [...ended, { from: 'completed', to: 'revising', at: '2026-10-16T10:03:00Z', by: 'tool' as const, reopen: true as const }];
    expect(taskEndedAt({ stateHistory: reopened })).toBeUndefined();

    const finishedAgain = [
      ...reopened,
      { from: 'revising', to: 'completed', at: '2026-10-16T10:04:00Z', by: 'system' as const },
      { at: '2026-10-16T10:04:01Z', by: 'system' as const, terminal: 'success' as const },
    ];
    expect(taskEndedAt({ stateHistory: finishedAgain })).toBe('2026-10-16T10:04:01Z');
  });
});

describe('a recently completed report is the subject of its requester\'s follow-up', () => {
  const base = {
    endedWithinWindow: true,
    assistantId: 'premium-bot',
    senderSub: 'alice',
    reopenTargets: (type: string, state: string) => reopenTargetsFrom(type, state, M),
    turnOpensTaskType: undefined as string | undefined,
  };

  it('is resolved for a turn that would open the same workflow (a change asked as a report request)', () => {
    expect(reopenableFollowUpSubject({ ...base, turnOpensTaskType: 'report_generation', task: completedReport() }))
      .toBe(true);
  });

  it('is not resolved for a turn that opens a DIFFERENT workflow, which is new work of its own', () => {
    // "now extract the table from this PDF" after a delivered report: attaching the report would make
    // it the turn's active task, and the extraction would continue the report's chain.
    expect(reopenableFollowUpSubject({ ...base, turnOpensTaskType: 'data_extraction', task: completedReport() }))
      .toBe(false);
  });

  it('is resolved for the requester, to the assistant that did the work, within the window', () => {
    expect(reopenableFollowUpSubject({ ...base, task: completedReport() })).toBe(true);
  });

  it('falls back to the requester on the task record when the row predates ownerPersonId', () => {
    expect(reopenableFollowUpSubject({ ...base, task: completedReport({ ownerPersonId: undefined }) })).toBe(true);
  });

  it('is not resolved for somebody else in the conversation', () => {
    expect(reopenableFollowUpSubject({ ...base, senderSub: 'bob', task: completedReport() })).toBe(false);
  });

  it('is not resolved for another assistant', () => {
    expect(reopenableFollowUpSubject({ ...base, assistantId: 'other-bot', task: completedReport() })).toBe(false);
  });

  it('is not resolved outside the recently-ended window', () => {
    expect(reopenableFollowUpSubject({ ...base, endedWithinWindow: false, task: completedReport() })).toBe(false);
  });

  it('is not resolved for a task that failed or was cancelled', () => {
    expect(reopenableFollowUpSubject({ ...base, task: completedReport({ status: 'failed' }) })).toBe(false);
    expect(reopenableFollowUpSubject({ ...base, task: completedReport({ status: 'cancelled' }) })).toBe(false);
  });

  it('is not resolved for a terminal that declares no reopen', () => {
    expect(reopenableFollowUpSubject({ ...base, task: completedReport({ taskType: 'data_extraction' }) })).toBe(false);
  });
});

describe('a completed report is not open work', () => {
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

  /** A DynamoDB stand-in that applies the `#status IN (...)` filter to the rows it holds. */
  const applyStatusFilter = (rows: Array<Record<string, unknown>>) => async (cmd: { input: Record<string, any> }) => {
    const values = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
    const allowed = Object.entries(values)
      .filter(([k]) => k === ':pending' || k === ':inProgress')
      .map(([, v]) => v);
    expect(cmd.input.FilterExpression).toMatch(/IN \(:pending, :inProgress\)/);
    return { Items: rows.filter((r) => allowed.includes(r.status)) };
  };

  it('the conversation\'s open-work read lists a revising report and not a completed one', async () => {
    mockSend.mockImplementation(applyStatusFilter([
      { ...completedReport(), taskId: 't-done', updatedAt: '2026-10-16T10:00:00Z' },
      { ...completedReport({ status: 'in_progress', taskState: 'revising' }), taskId: 't-revising', updatedAt: '2026-10-16T10:01:00Z' },
    ]));
    const { getOpenTasksForConversation } = await import('../../lambda/src/lib/task-tracking');

    const open = await getOpenTasksForConversation('arn:chan', { viewerId: 'alice' });

    expect(open.map((t) => t.taskId)).toEqual(['t-revising']);
  });

  it('the owner\'s open-work read in the conversation does not list a completed report', async () => {
    mockSend.mockImplementation(applyStatusFilter([
      { ...completedReport(), personId: 'premium-bot' },
    ]));
    const { getConversationTasksForAssistant } = await import('../../lambda/src/lib/task-tracking');

    expect(await getConversationTasksForAssistant('arn:chan', 'premium-bot', 'alice')).toEqual([]);
  });
});
