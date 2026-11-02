/**
 * A PERSON COMPLETES THEIR TASK ON THE CARD, AND THE TASK SERVICE OPENS ONLY ITS OWN CLASSIFICATION'S WORK (ADR-063 slices
 * T2 and T3, decisions 1, 2, 3 and E1).
 *
 * What it proves: the task service opens a workflow step's task with its worker and its run on the row, and refuses an
 * assistant that is not a live assistant of its own classification (DENY, the second layer behind the router's choice);
 * a card press is taken only for the task's current assignee, in the state the card was drawn for, along a choice that
 * state declares, and every other press is refused with its reason (DENY: another member, a moved state, an undeclared
 * choice, a settled task); a settled task a run waits on is named to the service's own router as `settled`, with ids
 * only; the card's Metadata carries ids and declared names, never words.
 */
const mockSend = jest.fn();
const mockTags = jest.fn();
const mockLive = jest.fn();
const mockName = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  QueryCommand: class { __t = 'Query'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
  PutCommand: class { __t = 'Put'; constructor(public input: any) {} },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  DeleteCommand: class { __t = 'Delete'; constructor(public input: any) {} },
  ScanCommand: class { __t = 'Scan'; constructor(public input: any) {} },
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockTags(...a); },
  ListTagsForResourceCommand: class { constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/default-agents', () => ({ liveAssistantsForClassification: (...a: unknown[]) => mockLive(...a) }));
jest.mock('../../lambda/src/lib/say-through-router', () => ({
  ...jest.requireActual('../../lambda/src/lib/say-through-router'),
  nameTaskThroughRouter: (...a: unknown[]) => mockName(...a),
}));

process.env.TASKS_TABLE = 'tasks';
process.env.USER_TASKS_TABLE = 'user-tasks';
process.env.SERVICE_CLASSIFICATION = 'standard';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../../lambda/src/task-service');
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { assigneeAdvanceRefusal, settlementOutcome, taskCardOf, TASK_DEADLINE_ENDING } from '../../lambda/src/lib/workflow-task';

const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
let seq = 0;
const nextChannel = () => `${I}/channel/card${++seq}`;
const OWN_BOT = `${I}/bot/opsbot`;
const run = { runKey: 'assistant-joined#c#a', workflow: 'w', step: 'review', event: 'assistant-joined', botArn: OWN_BOT, deadlineAt: 2_000_000_000 };

const approvalTask = (over: Record<string, unknown> = {}) => ({
  taskId: 'evt-1', channelArn: 'x', userArn: `${I}/user/owner`, status: 'in_progress', taskType: 'approval', taskState: 'deciding',
  assigneeId: 'approver', assigneeType: 'user', workerId: 'approver', workerType: 'user', assistantId: 'opsbot',
  stateHistory: [], workflowRun: run, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', ...over,
});

beforeEach(() => {
  mockSend.mockReset();
  mockTags.mockReset().mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'standard' }] });
  mockLive.mockReset().mockResolvedValue([{ botArn: OWN_BOT, role: 'ops', handle: 'ops' }]);
  mockName.mockReset().mockResolvedValue(true);
});

const puts = () => mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__t === 'Put');
const updates = () => mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__t === 'Update');

describe('the task service opens a workflow step\'s task (T2)', () => {
  const open = (channelArn: string, over: Record<string, unknown> = {}) => svc.openWorkflowTask({
    channelArn, taskId: 'evt-1', machine: 'approval', requesterArn: `${I}/user/owner`,
    worker: { id: 'approver', type: 'user' }, assistantId: 'opsbot', visibility: 'private', priority: 'high', workflowRun: run, ...over,
  });

  it('writes the task with its owner, its worker, its priority and its run, held first by the worker', async () => {
    const CH = nextChannel();
    mockSend.mockResolvedValue({});
    const task = await open(CH);
    expect(task).toMatchObject({ taskType: 'approval', taskState: 'deciding', ownerPersonId: 'owner', workerId: 'approver', workerType: 'user', assigneeId: 'approver', assigneeType: 'user', priority: 'high', workflowRun: run });
    expect(puts().find((c: any) => c.input.TableName === 'tasks')).toBeDefined();
  });

  it('DENY: an assistant that is not a live assistant of this classification is refused, and nothing is written', async () => {
    const CH = nextChannel();
    mockSend.mockResolvedValue({});
    mockLive.mockResolvedValue([{ botArn: `${I}/bot/someone-else`, role: 'ops', handle: 'ops' }]);
    expect(await open(CH)).toBeNull();
    expect(await open(CH, { worker: { id: 'premiumbot', type: 'assistant' } })).toBeNull();
    expect(puts()).toEqual([]);
  });

  it('DENY: a conversation of another classification is refused, and nothing is written', async () => {
    const CH = nextChannel();
    mockTags.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'premium' }] });
    expect(await open(CH)).toBeNull();
    expect(puts()).toEqual([]);
  });

  it('DENY: the turn queue\'s own machines are never opened by a step', async () => {
    expect(await open(nextChannel(), { machine: 'queued_request' })).toBeNull();
    expect(puts()).toEqual([]);
  });

  it('a task the assistant works is named ready to the service\'s own router, ids only', async () => {
    const CH = nextChannel();
    let row: Record<string, unknown> | undefined;
    mockSend.mockImplementation(async (c: any) => {
      if (c.__t === 'Put' && c.input.TableName === 'tasks') row = c.input.Item;
      if (c.__t === 'Get') return { Item: row };
      return {};
    });
    await open(CH, { machine: 'incident_first_look', requesterArn: undefined, worker: { id: 'opsbot', type: 'assistant' } });
    expect(mockName).toHaveBeenCalledWith('standard', { kind: 'ready', channelArn: CH, taskId: 'evt-1' });
  });
});

describe('a card press is taken for the task\'s assignee alone (T3, every deny case)', () => {
  const press = (channelArn: string, over: Record<string, unknown> = {}) => svc.advanceAsAssignee({
    taskId: 'evt-1', channelArn, callerPersonId: 'approver', state: 'deciding', choice: 'approved', ...over,
  });

  it('the assignee\'s choice moves the task along that declared edge, from the state the card showed', async () => {
    const CH = nextChannel();
    mockSend.mockResolvedValue({ Item: approvalTask({ channelArn: CH }) });
    expect(await press(CH)).toEqual({ ok: true, to: 'approved' });
    const edge = updates().find((c: any) => String(c.input.UpdateExpression).includes('taskState = :to'));
    expect(edge.input.ConditionExpression).toBe('taskState = :from');
    expect(edge.input.ExpressionAttributeValues[':to']).toBe('approved');
  });

  it('DENY: another member, a moved state, an undeclared choice and a settled task are each refused, and nothing moves', async () => {
    const CH = nextChannel();
    mockSend.mockResolvedValue({ Item: approvalTask({ channelArn: CH }) });
    expect(await press(CH, { callerPersonId: 'someone-else' })).toEqual({ ok: false, error: 'NOT_ASSIGNEE' });
    expect(await press(CH, { state: 'asked' })).toEqual({ ok: false, error: 'STATE_MOVED' });
    expect(await press(CH, { choice: 'shrugged' })).toEqual({ ok: false, error: 'NOT_A_CHOICE' });
    mockSend.mockResolvedValue({ Item: approvalTask({ channelArn: CH, taskState: 'approved', status: 'completed' }) });
    expect(await press(CH)).toEqual({ ok: false, error: 'SETTLED' });
    expect(updates()).toEqual([]);
  });

  it('DENY: an assistant is never a card\'s presser, and a conversation of another classification answers nothing', async () => {
    const CH = nextChannel();
    mockSend.mockResolvedValue({ Item: approvalTask({ channelArn: CH, assigneeId: 'opsbot', assigneeType: 'assistant' }) });
    expect(await press(CH, { callerPersonId: 'opsbot' })).toEqual({ ok: false, error: 'NOT_ASSIGNEE' });
    const OTHER = nextChannel();
    mockTags.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'premium' }] });
    expect(await press(OTHER)).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});

describe('how a task ended, and what its card carries (pure)', () => {
  const M = DEFAULT_TASK_STATE_MACHINES;
  it('a settlement is read from the row: terminal state and kind, the deadline\'s cancel, or any other ending', () => {
    expect(settlementOutcome({ taskType: 'approval', taskState: 'declined', status: 'completed' }, M)).toBe('task:success:declined');
    expect(settlementOutcome({ taskType: 'approval', taskState: 'deciding', status: 'cancelled', error: TASK_DEADLINE_ENDING }, M)).toBe('task:deadline');
    expect(settlementOutcome({ taskType: 'approval', taskState: 'deciding', status: 'cancelled', error: 'cancelled by an operator' }, M)).toBe('task:failure:deciding');
    expect(settlementOutcome({ taskType: 'approval', taskState: 'deciding', status: 'in_progress' }, M)).toBeUndefined();
  });

  it('the card carries the task\'s id, the state, its declared choices and when it ends, and no words', () => {
    expect(taskCardOf(approvalTask() as never, M)).toEqual({ id: 'evt-1', state: 'deciding', choices: ['approved', 'declined'], expiresAt: 2_000_000_000 });
    expect(taskCardOf({ ...approvalTask(), taskType: 'guided_troubleshooting', taskState: 'collecting_symptoms' } as never, M)).toBeUndefined();
    expect(JSON.stringify(taskCardOf(approvalTask() as never, M)).length).toBeLessThan(200);
  });

  it('the refusal reads only the row and the press', () => {
    expect(assigneeAdvanceRefusal(null, M, { callerPersonId: 'a', state: 's', choice: 'c' })).toBe('NOT_FOUND');
    expect(assigneeAdvanceRefusal(approvalTask() as never, M, { callerPersonId: '', state: 'deciding', choice: 'approved' })).toBe('NOT_ASSIGNEE');
    expect(assigneeAdvanceRefusal(approvalTask() as never, M, { callerPersonId: 'approver', state: 'deciding', choice: 'approved' })).toBeUndefined();
  });
});
