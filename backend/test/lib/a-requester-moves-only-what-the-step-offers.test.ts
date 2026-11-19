/**
 * A REQUESTER MOVES A TASK ANOTHER PERSON HOLDS ONLY ON THE EDGES ITS STEP OFFERS THEM (ADR-067 G8, WT114).
 *
 * What it proves: a state that awaits the worker may declare `requesterMoves`, its own transitions, and nothing else may
 * (DENY: a state that awaits the requester, a move that is not its transition); the task service finds the person's own
 * request held by someone else in this conversation, in a step that declares moves, through the owner index, and nothing
 * else (DENY: a task the person holds, a task in another conversation, a step that offers nothing, a conversation of
 * another classification); the turn takes only those moves (DENY: any other move is refused before anything is written);
 * and the router looks it up only where the turn's machines declare any, and hands the moves to the turn.
 */
const mockSend = jest.fn();
const mockTags = jest.fn();
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
jest.mock('../../lambda/src/lib/default-agents', () => ({ liveAssistantsForClassification: jest.fn(async () => []) }));

process.env.TASKS_TABLE = 'tasks';
process.env.USER_TASKS_TABLE = 'user-tasks';
process.env.SERVICE_CLASSIFICATION = 'standard';

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  anyRequesterMoves, requesterMovesOf, validateTaskStateMachine, type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import { handleAdvanceTaskStateTool } from '../../lambda/src/lib/task-tools';
import type { Task } from '../../lambda/src/lib/task-tracking';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../../lambda/src/task-service');

const DISPATCH = {
  initial: 'scheduled',
  states: {
    scheduled: { transitions: ['rescheduled', 'cancelled', 'done'], awaits: { party: 'worker' }, requesterMoves: ['rescheduled', 'cancelled'] },
    rescheduled: { transitions: ['done'], awaits: { party: 'worker' } },
    cancelled: { transitions: [], terminal: 'failure' },
    done: { transitions: [], terminal: 'success' },
  },
} as unknown as TaskStateMachine;

const withState = (over: Record<string, unknown>) => ({ ...DISPATCH, states: { ...DISPATCH.states, scheduled: { ...DISPATCH.states.scheduled, ...over } } }) as unknown as TaskStateMachine;

describe('a step declares the moves its requester may ask for', () => {
  it('on a state that awaits the worker, among its own transitions', () => {
    expect(() => validateTaskStateMachine('dispatch', DISPATCH)).not.toThrow();
    expect(requesterMovesOf(DISPATCH, 'scheduled')).toEqual(['rescheduled', 'cancelled']);
    expect(requesterMovesOf(DISPATCH, 'rescheduled')).toEqual([]);
    expect(anyRequesterMoves({ dispatch: DISPATCH })).toBe(true);
    expect(anyRequesterMoves({ dispatch: withState({ requesterMoves: undefined }) })).toBe(false);
  });

  it.each([
    ['a state that awaits the requester', { awaits: { party: 'requester' } }, /does not await the worker/],
    ['a move that is not its transition', { requesterMoves: ['refunded'] }, /that are not its transitions/],
    ['an empty list', { requesterMoves: [] }, /not a non-empty list/],
  ])('DENY: %s is refused', (_label, over, message) => {
    expect(() => validateTaskStateMachine('dispatch', withState(over))).toThrow(message);
  });
});

describe('the task service finds the requester\'s task another person holds', () => {
  const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
  let seq = 0;
  const nextChannel = () => `${I}/channel/req${++seq}`;
  const task = (channelArn: string, over: Record<string, unknown> = {}) => ({
    taskId: 'evt-1', channelArn, userArn: `${I}/user/customer`, status: 'in_progress', taskType: 'dispatch', taskState: 'scheduled',
    assigneeId: 'driver', assigneeType: 'user', workerId: 'driver', workerType: 'user', stateHistory: [], updatedAt: '2026-11-06T00:00:00Z', ...over,
  });
  const table = (rows: Array<Record<string, unknown>>, full: Record<string, unknown>) => mockSend.mockImplementation(async (cmd: any) => {
    if (cmd.__t === 'Query') return { Items: rows };
    if (cmd.__t === 'Get') return { Item: full };
    return {};
  });
  const find = (channelArn: string) => svc.requesterMovableTask({ channelArn, personId: 'customer', machines: { dispatch: DISPATCH } });

  beforeEach(() => {
    mockSend.mockReset();
    mockTags.mockReset().mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'standard' }] });
  });

  it('reads the person\'s requests through the owner index, and returns the one held by another with its moves', async () => {
    const CH = nextChannel();
    table([{ principalId: 'driver', taskId: 'evt-1', channelArn: CH, ownerPersonId: 'customer', updatedAt: 'x' }], task(CH));
    const found = await find(CH);
    expect(found).toMatchObject({ task: { taskId: 'evt-1' }, moves: ['rescheduled', 'cancelled'] });
    const query = mockSend.mock.calls.map((c) => c[0]).find((c: any) => c.__t === 'Query');
    expect(query.input.IndexName).toBe('ownerPersonId-index');
  });

  it.each([
    ['a task the person holds', (CH: string) => [[{ principalId: 'customer', taskId: 'evt-1', channelArn: CH }], task(CH, { assigneeId: 'customer' })]],
    ['a task in another conversation', (CH: string) => [[{ principalId: 'driver', taskId: 'evt-1', channelArn: `${CH}-other` }], task(CH)]],
    ['a step that offers the requester nothing', (CH: string) => [[{ principalId: 'driver', taskId: 'evt-1', channelArn: CH }], task(CH, { taskState: 'rescheduled' })]],
    ['a task someone else asked for', (CH: string) => [[{ principalId: 'driver', taskId: 'evt-1', channelArn: CH }], task(CH, { userArn: `${I}/user/someone` })]],
  ])('DENY: %s is not found', async (_label, setup) => {
    const CH = nextChannel();
    const [rows, full] = (setup as unknown as (c: string) => [Array<Record<string, unknown>>, Record<string, unknown>])(CH);
    table(rows, full);
    expect(await find(CH)).toBeNull();
  });

  it('reads a task whose step offers a move first, so ten newer tasks never crowd it out', async () => {
    const CH = nextChannel();
    const newer = Array.from({ length: 12 }, (_, i) => ({ principalId: 'driver', taskId: `n-${i}`, channelArn: CH, taskType: 'dispatch', taskState: 'rescheduled', updatedAt: `2026-11-06T0${i % 10}:00:00Z` }));
    const held = { principalId: 'driver', taskId: 'evt-1', channelArn: CH, taskType: 'dispatch', taskState: 'scheduled', updatedAt: '2026-01-01T00:00:00Z' };
    mockSend.mockImplementation(async (cmd: any) => {
      if (cmd.__t === 'Query') return { Items: [...newer, held] };
      if (cmd.__t === 'Get') return { Item: cmd.input.Key.taskId === 'evt-1' ? task(CH) : task(CH, { taskId: cmd.input.Key.taskId, taskState: 'rescheduled' }) };
      return {};
    });
    expect(await find(CH)).toMatchObject({ task: { taskId: 'evt-1' } });
  });

  it('DENY: a conversation of another classification is refused before any read', async () => {
    const CH = nextChannel();
    mockTags.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'premium' }] });
    table([{ principalId: 'driver', taskId: 'evt-1', channelArn: CH }], task(CH));
    expect(await find(CH)).toBeNull();
    expect(mockSend.mock.calls.filter((c) => c[0].__t === 'Query')).toEqual([]);
  });
});

describe('the requester\'s turn takes only those moves', () => {
  const t = { taskId: 'evt-1', channelArn: 'arn:c', taskType: 'dispatch', taskState: 'scheduled', status: 'in_progress', stateHistory: [], details: {} } as unknown as Task;

  it('DENY: a move the step leaves to the worker is refused before anything is written', async () => {
    mockSend.mockReset().mockResolvedValue({});
    const out = await handleAdvanceTaskStateTool({ task: t, input: { to_state: 'done', reason: 'they say it is done' }, machines: { dispatch: DISPATCH }, requesterMoves: ['rescheduled', 'cancelled'] });
    expect(out.result).toMatchObject({ ok: false, error: 'illegal_transition' });
    expect(String(out.payload.message)).toContain('rescheduled, cancelled');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a declared move passes the requester\'s limit', async () => {
    mockSend.mockReset().mockResolvedValue({ Attributes: {} });
    const out = await handleAdvanceTaskStateTool({ task: t, input: { to_state: 'cancelled', reason: 'they asked to cancel' }, machines: { dispatch: DISPATCH }, requesterMoves: ['rescheduled', 'cancelled'] });
    expect(out.payload.message ?? '').not.toContain('held by someone else');
  });
});

describe('the router binds the requester\'s message only where moves are declared', () => {
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const processor = readFileSync(resolve(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
  it('looks it up only when nothing else took the message and the turn\'s machines declare moves, and hands them to the turn', () => {
    expect(router).toMatch(/if \(!activeTask && channelArn && personId && !isMachineWrittenTurn\(event\) && anyRequesterMoves\(turnMachines\)\) \{\s*const movable = await requesterMovableTask\(\{ channelArn, personId, machines: turnMachines \}\)/);
    expect(router).toMatch(/\.\.\.\(requesterMoves && activeTask && taskId === activeTask\.taskId \? \{ requesterMoves \} : \{\}\)/);
    expect(processor).toMatch(/\.\.\.\(event\.requesterMoves\?\.length \? \{ requesterMoves: event\.requesterMoves \} : \{\}\)/);
  });
});
