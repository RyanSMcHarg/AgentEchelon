/**
 * AN OPENER READS THE OPEN WORK OF THE CONVERSATIONS IT OPENED IN ONE QUERY, AND ARCHIVING A CONVERSATION SETTLES ITS OPEN
 * WORKFLOW TASKS (WT122, ADR-017).
 *
 * What it proves:
 *  - a task a workflow-opened conversation's run opens records the conversation that opened it (`openedFrom`), and only one
 *    of the same app instance this service serves (DENY: another instance, another classification, the task's own);
 *  - the opener's open incidents are one query on `openedFrom-taskType-index`, every page; a page that fails is null, never
 *    a short count (DENY), and a row held in a conversation this service does not serve is left out (DENY);
 *  - archiving settles each open workflow task of the conversation, its ending the archive's, and names the settlement so the
 *    run goes on; a conversation that is not archived has nothing settled (DENY), and a task already settled is left alone.
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
import { TASK_ARCHIVE_ENDING, settlementOutcome } from '../../lambda/src/lib/workflow-task';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
let seq = 0;
const next = (p: string) => `${I}/channel/${p}${++seq}`;
const OWN_BOT = `${I}/bot/opsbot`;
const run = { runKey: 'conversation-opened#c#ops', workflow: 'ops-room', step: 'lead-task', event: 'conversation-opened', botArn: OWN_BOT, deadlineAt: 2_000_000_000, holdsEnd: true };

/** Every conversation is standard unless named otherwise; a conversation named here carries the tags given. */
function tagsBy(over: Record<string, Array<{ Key: string; Value: string }>> = {}) {
  mockTags.mockImplementation(async (cmd: { input: { ResourceARN: string } }) => ({ Tags: over[cmd.input.ResourceARN] ?? [{ Key: 'classification', Value: 'standard' }] }));
}

beforeEach(() => {
  mockSend.mockReset();
  tagsBy();
  mockLive.mockReset().mockResolvedValue([{ botArn: OWN_BOT, role: 'ops', handle: 'ops' }]);
  mockName.mockReset().mockResolvedValue(true);
});

const calls = (t: string) => mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__t === t);

describe('a task in a conversation a workflow opened records its opener', () => {
  const open = (channelArn: string, openedFrom: string) => svc.openWorkflowTask({
    channelArn, taskId: 'evt-lead', machine: 'incident_ownership', worker: { id: 'oncall', type: 'user' }, assistantId: 'opsbot', workflowRun: run, openedFrom,
  });
  const written = () => (calls('Put').find((c: any) => c.input.TableName === 'tasks') as any)?.input.Item;

  it('writes the opener, the key of the index the opener reads', async () => {
    mockSend.mockResolvedValue({});
    const team = next('team');
    await open(next('ops'), team);
    expect(written()).toMatchObject({ openedFrom: team, taskType: 'incident_ownership', workflowRun: run });
  });

  it('DENY: an opener of another app instance, of another classification, or the task\'s own conversation is not written', async () => {
    const room = next('ops');
    const other = next('premium-room');
    for (const opener of ['arn:aws:chime:us-east-1:1:app-instance/x/channel/team', other, room]) {
      mockSend.mockReset().mockResolvedValue({});
      tagsBy({ [other]: [{ Key: 'classification', Value: 'premium' }] });
      await open(room, opener);
      expect(written()).toBeDefined();
      expect(written().openedFrom).toBeUndefined();
    }
  });
});

describe('the opener reads its open incidents in one query', () => {
  const row = (taskId: string, channelArn: string, openedFrom: string) => ({ taskId, channelArn, openedFrom, taskType: 'incident_ownership', status: 'pending', ttl: 4_000_000_000 });

  it('queries the opener\'s index for the machine, every page, and answers the rows whole', async () => {
    const team = next('team');
    const a = next('ops'); const b = next('ops');
    mockSend
      .mockResolvedValueOnce({ Items: [row('evt-1', a, team)], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [row('evt-2', b, team)] });
    const found = await svc.openTasksOpenedFrom({ openedFrom: team, taskType: 'incident_ownership' });
    expect(found.map((t: any) => t.taskId)).toEqual(['evt-1', 'evt-2']);
    const queries = calls('Query').map((c: any) => c.input);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ IndexName: 'openedFrom-taskType-index', KeyConditionExpression: 'openedFrom = :from AND taskType = :type', ExpressionAttributeValues: expect.objectContaining({ ':from': team, ':type': 'incident_ownership' }) });
    expect(queries[1].ExclusiveStartKey).toEqual({ k: 1 });
  });

  it('DENY: a page that cannot be read is null, never the rows read before it', async () => {
    const team = next('team');
    mockSend.mockResolvedValueOnce({ Items: [row('evt-1', next('ops'), team)], LastEvaluatedKey: { k: 1 } }).mockRejectedValueOnce(new Error('throttled'));
    expect(await svc.openTasksOpenedFrom({ openedFrom: team, taskType: 'incident_ownership' })).toBeNull();
  });

  it('DENY: an opener this service does not serve reads nothing, and a row in a conversation it does not serve is left out', async () => {
    const team = next('team');
    const foreign = next('ops');
    tagsBy({ [team]: [{ Key: 'classification', Value: 'premium' }] });
    expect(await svc.openTasksOpenedFrom({ openedFrom: team, taskType: 'incident_ownership' })).toBeNull();
    expect(calls('Query')).toEqual([]);
    tagsBy({ [foreign]: [{ Key: 'classification', Value: 'premium' }] });
    const served = next('team');
    const mine = next('ops');
    mockSend.mockResolvedValueOnce({ Items: [row('evt-1', mine, served), row('evt-2', foreign, served)] });
    expect((await svc.openTasksOpenedFrom({ openedFrom: served, taskType: 'incident_ownership' })).map((t: any) => t.taskId)).toEqual(['evt-1']);
  });

  it('a child counts as open only while the team holds a wait on it with no end, or the wait cannot be read', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { waitHoldsChildOpen } = require('../../lambda/src/router-agent-handler');
    expect(waitHoldsChildOpen({})).toBe(true);
    expect(waitHoldsChildOpen({ ended: '2026-11-14T00:00:00.000Z' })).toBe(false);
    // A child no run waits on (one opened before the team waited, or under another wait id) does not fill the room's cap.
    expect(waitHoldsChildOpen('none')).toBe(false);
    expect(waitHoldsChildOpen('unread')).toBe(true);
    // A WAIT ITS RUN WENT ON FROM (the resolve told it) holds the child open no longer; one whose going on is unread still does.
    expect(waitHoldsChildOpen({}, true)).toBe(false);
    expect(waitHoldsChildOpen({}, false)).toBe(true);
    expect(waitHoldsChildOpen({}, 'unread')).toBe(true);
  });

  it('the router counts the incidents its team conversation opened by their tasks, and by the conversations whose end is not recorded', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const fn = router.slice(router.indexOf('async function openIncidents('), router.indexOf('async function tellIncident('));
    expect(fn).toContain("openTasksOpenedFrom(channelArn, 'incident_ownership')");
    // A CONVERSATION WHOSE RUN OPENED NO INCIDENT TASK still counts, until its end is recorded under the team's wait for it.
    expect(fn).toContain('c.typeKey === type && Date.parse(c.openedAt) >= since');
    expect(fn).toContain("readRunWait({ waitId: childEndWaitId(child), channelArn })");
    expect(fn).toContain('if (!waitHoldsChildOpen(record, wentOn)) return;');
    // A ROW OR TASKS THAT CANNOT BE READ refuse the event rather than count short.
    expect(fn).toContain('if (row === undefined || !tasks) return null;');
  });
});

describe('archiving a conversation settles its open workflow tasks', () => {
  const ARCHIVED = (ch: string) => ({ [ch]: [{ Key: 'classification', Value: 'standard' }, { Key: 'archived', Value: 'true' }] });
  const open = (taskId: string, channelArn: string, over: Record<string, unknown> = {}) => ({
    taskId, channelArn, status: 'pending', taskType: 'incident_ownership', taskState: 'open', workflowRun: run, stateHistory: [], ...over,
  });

  it('cancels each open workflow task, its ending the archive\'s, and names each settlement so its run goes on', async () => {
    const room = next('ops');
    tagsBy(ARCHIVED(room));
    const lead = open('evt-lead', room);
    mockSend.mockImplementation(async (cmd: any) => {
      if (cmd.__t === 'Query') return { Items: [lead, open('evt-done', room, { taskState: 'resolved' })] };
      if (cmd.__t === 'Get') return { Item: { ...lead, status: 'cancelled', error: TASK_ARCHIVE_ENDING } };
      return {};
    });
    expect(await svc.settleArchivedTasks({ channelArn: room })).toEqual({ settled: ['evt-lead'] });
    const query = calls('Query')[0] as any;
    expect(query.input).toMatchObject({ IndexName: 'channelArn-updatedAt-index', ExpressionAttributeValues: expect.objectContaining({ ':ch': room }) });
    const cancel = calls('Update').find((c: any) => c.input.Key?.taskId === 'evt-lead') as any;
    expect(JSON.stringify(cancel.input.ExpressionAttributeValues)).toContain('"cancelled"');
    expect(JSON.stringify(cancel.input.ExpressionAttributeValues)).toContain(`"${TASK_ARCHIVE_ENDING}"`);
    expect(mockName).toHaveBeenCalledWith('standard', { kind: 'settled', channelArn: room, taskId: 'evt-lead' });
    // THE ARCHIVE'S ENDING IS READ BACK AS AN ENDING THAT IS NOT A SUCCESS: the run takes its failure edge.
    expect(settlementOutcome({ taskType: 'incident_ownership', taskState: 'open', status: 'cancelled', error: TASK_ARCHIVE_ENDING }, DEFAULT_TASK_STATE_MACHINES)).toBe('task:failure:open');
  });

  it('DENY: a conversation that is not archived has nothing settled, and nothing is read or written', async () => {
    const room = next('ops');
    expect(await svc.settleArchivedTasks({ channelArn: room })).toEqual({ failed: true });
    expect(calls('Query')).toEqual([]);
    expect(calls('Update')).toEqual([]);
    expect(mockName).not.toHaveBeenCalled();
  });

  it('DENY: a read of the conversation\'s tasks that fails settles nothing', async () => {
    const room = next('ops');
    tagsBy(ARCHIVED(room));
    mockSend.mockRejectedValue(new Error('throttled'));
    expect(await svc.settleArchivedTasks({ channelArn: room })).toEqual({ failed: true });
    expect(calls('Update')).toEqual([]);
  });

  it('the router asks for the settlement when the conversation is archived, and deletes the deadlines by name only where it could not', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const fn = router.slice(router.indexOf('export async function handleDeadlineCancel('), router.indexOf('/** How many people\'s `person-joined` runs'));
    expect(fn).toContain('const settled = await (deps.settle ?? settleArchivedTasks)(cancel.channelArn)');
    // A SETTLEMENT THAT FAILED THROWS once the deadlines are deleted, so the archive is tried again.
    expect(fn.indexOf('if (unsettled.length) throw')).toBeGreaterThan(fn.indexOf('workflowTasksOf(cancel.channelArn)'));
    expect(fn.indexOf('if (!settled)')).toBeLessThan(fn.indexOf('workflowTasksOf(cancel.channelArn)'));
  });
});
