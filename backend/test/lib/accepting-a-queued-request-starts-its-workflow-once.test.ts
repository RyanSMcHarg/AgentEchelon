/**
 * ACCEPTING A QUEUED REQUEST STARTS ITS INTENT'S WORKFLOW, ONCE (ADR-067 Appendix A, G9; WT115).
 *
 * What it proves: a queued request the person accepts is named to the router as `request` when it holds the message and
 * the intent it was classified with, and not otherwise; the task service records the run on it only while it is an
 * accepted `queued_request` with no run (DENY: a proposed one, another type, one that already has a run, another
 * classification's conversation), in one conditional write, so a redelivered naming writes nothing; the router starts the
 * intent's workflow on the version the assistant serves, keyed by the queued message's own id, and its own task step
 * takes the queued request rather than opening another.
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

import { readFileSync } from 'fs';
import { resolve } from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../../lambda/src/task-service');
import { intentRunKey } from '../../lambda/src/lib/intent-workflow';

const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
let seq = 0;
const nextChannel = () => `${I}/channel/queued${++seq}`;
const run = { runKey: 'intent#msg-7#advisor', workflow: 'support_request', step: 'work', event: 'intent', botArn: `${I}/bot/advisor`, values: {} };

const queued = (over: Record<string, unknown> = {}) => ({
  taskId: 'q-1', channelArn: 'x', userArn: `${I}/user/asker`, status: 'in_progress', taskType: 'queued_request', taskState: 'proposed',
  assigneeId: 'asker', assigneeType: 'user', assistantId: 'advisor', openingIntent: 'support_request', userMessageId: 'msg-7',
  stateHistory: [], createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', ...over,
});

beforeEach(() => {
  mockSend.mockReset();
  mockTags.mockReset().mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'standard' }] });
  mockLive.mockReset().mockResolvedValue([]);
  mockName.mockReset().mockResolvedValue(true);
});

const updates = () => mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__t === 'Update');
const named = (kind: string) => mockName.mock.calls.filter((c) => c[1]?.kind === kind);

/** A table that holds one row and applies a state move to it. */
function tableWith(row: Record<string, unknown>) {
  let current = { ...row };
  mockSend.mockImplementation(async (cmd: any) => {
    if (cmd.__t === 'Get') return { Item: current };
    if (cmd.__t === 'Update' && cmd.input.TableName === 'tasks' && cmd.input.ExpressionAttributeValues?.[':state']) {
      current = { ...current, taskState: cmd.input.ExpressionAttributeValues[':state'] };
    }
    return {};
  });
}

describe('the task service names an accepted queued request', () => {
  it('names `accepted` when the person accepts a queued request that holds its message and intent', async () => {
    const CH = nextChannel();
    tableWith(queued({ channelArn: CH }));
    const out = await svc.advanceTask({ taskId: 'q-1', channelArn: CH, toState: 'accepted', by: 'tool' });
    expect(out.ok).toBe(true);
    expect(named('request')).toEqual([['standard', { kind: 'request', channelArn: CH, taskId: 'q-1' }]]);
  });

  it('names nothing for one with no recorded intent, or one that already has its run', async () => {
    const CH = nextChannel();
    tableWith(queued({ channelArn: CH, openingIntent: undefined }));
    await svc.advanceTask({ taskId: 'q-1', channelArn: CH, toState: 'accepted', by: 'tool' });
    const CH2 = nextChannel();
    tableWith(queued({ channelArn: CH2, workflowRun: run }));
    await svc.advanceTask({ taskId: 'q-1', channelArn: CH2, toState: 'accepted', by: 'tool' });
    expect(named('request')).toEqual([]);
  });
});

describe('the task service records the run on the accepted queued request, once', () => {
  const attach = (channelArn: string) => svc.attachRequestRunOp({ taskId: 'q-1', channelArn, workflowRun: run });

  it('writes the run in one conditional write that only a queued request with no run passes', async () => {
    const CH = nextChannel();
    // THE WRITE HANDS BACK THE ROW IT WROTE (ReturnValues ALL_NEW), so no later read can miss it.
    mockSend.mockImplementation(async (cmd: any) => (cmd.__t === 'Get' ? { Item: queued({ channelArn: CH, taskState: 'accepted' }) }
      : cmd.__t === 'Update' && cmd.input.TableName === 'tasks' ? { Attributes: { ...queued({ channelArn: CH, taskState: 'accepted' }), workflowRun: run } } : {}));
    expect(await attach(CH)).not.toBeNull();
    const write = updates().find((u: any) => u.input.TableName === 'tasks');
    expect(write.input.UpdateExpression).toMatch(/SET workflowRun = :run/);
    expect(write.input.ConditionExpression).toBe('attribute_exists(taskId) AND attribute_not_exists(workflowRun) AND ((taskType = :queued AND taskState = :accepted) OR awaitsIntentRun = :yes)');
    expect(write.input.ExpressionAttributeValues[':run']).toEqual(run);
  });

  it('a redelivered naming loses the condition and writes nothing more', async () => {
    const CH = nextChannel();
    mockSend.mockImplementation(async (cmd: any) => {
      if (cmd.__t === 'Get') return { Item: queued({ channelArn: CH, taskState: 'accepted' }) };
      if (cmd.__t === 'Update') throw Object.assign(new Error('lost'), { name: 'ConditionalCheckFailedException' });
      return {};
    });
    expect(await attach(CH)).toBeNull();
  });

  it.each([
    ['a proposed request', { taskState: 'proposed' }],
    ['another type', { taskType: 'support_request', taskState: 'working' }],
    ['one that already has a run', { taskState: 'accepted', workflowRun: run }],
    ['one that holds no message', { taskState: 'accepted', userMessageId: undefined }],
  ])('DENY: %s takes no run', async (_label, over) => {
    const CH = nextChannel();
    mockSend.mockImplementation(async (cmd: any) => (cmd.__t === 'Get' ? { Item: queued({ channelArn: CH, ...over }) } : {}));
    expect(await attach(CH)).toBeNull();
    expect(updates()).toEqual([]);
  });

  it('DENY: another classification\'s conversation takes no run', async () => {
    const CH = nextChannel();
    mockTags.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'premium' }] });
    mockSend.mockImplementation(async (cmd: any) => (cmd.__t === 'Get' ? { Item: queued({ channelArn: CH, taskState: 'accepted' }) } : {}));
    expect(await attach(CH)).toBeNull();
    expect(updates()).toEqual([]);
  });
});

describe('the router starts the intent\'s workflow on acceptance', () => {
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const fn = router.slice(router.indexOf('async function handleRequestAwaitingRun('), router.indexOf('async function startIntentRun('));

  it('takes the naming, reads the served version\'s workflow for the intent, and keys the run by the queued message', () => {
    expect(router).toMatch(/if \(r\.kind === 'request'\) return handleRequestAwaitingRun\(task\);/);
    expect(fn).toMatch(/served\?\.version\.intentWorkflows\?\.\[task\.openingIntent\]/);
    expect(fn).toMatch(/requesterArn: task\.userArn, correlationId: task\.userMessageId/);
    expect(intentRunKey('msg-7', 'advisor')).toBe(run.runKey);
  });

  it('its own task step takes the queued request rather than opening another, and a settled one continues', () => {
    expect(fn).toMatch(/attachRequestRun\(\{ taskId: task\.taskId, channelArn: task\.channelArn, workflowRun: run/);
    expect(fn).not.toMatch(/createTask\(/);
    expect(fn).toMatch(/if \(settlementOutcome\(taken, machinesForTask\(taken\)\)\) \{\s*return handleTaskNaming\(\{ kind: 'settled'/);
  });
});
