/**
 * AN ENDED DUEL'S WORK ENDS WITH IT, AND REPORTS READ IT AS ABANDONED.
 *
 *  - the task service closes the tasks this duel's sides opened (`endDuelTasks`), as `cancelled` with the battle-ended
 *    reason, and keeps finished work and every other duel's tasks;
 *  - the side's message declares its task ended (`declareDuelEnded`), the one record the archive reads;
 *  - the evaluation closes those flows as abandoned, named for why (`DUEL_ENDED_FLOWS_SQL`);
 *  - the router closes them only after proving the duel ended in that conversation.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const cmd = (t: string) => class { __type = t; constructor(public input: any) {} };
  return {
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
    PutCommand: cmd('Put'), GetCommand: cmd('Get'), UpdateCommand: cmd('Update'),
    QueryCommand: cmd('Query'), ScanCommand: cmd('Scan'), DeleteCommand: cmd('Delete'),
  };
});

import * as fs from 'fs';
import * as path from 'path';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BATTLE = 'b1';

beforeEach(() => {
  jest.resetModules();
  mockSend.mockReset();
  process.env.TASKS_TABLE = 'agent-tasks';
  process.env.USER_TASKS_TABLE = 'user-tasks';
});

describe('the task service closes an ended duel\'s work', () => {
  const rows = [
    { taskId: 't-open', channelArn: CHANNEL, battleId: BATTLE, status: 'in_progress', assistantId: 'advisor', ownerPersonId: 'p1' },
    { taskId: 't-done', channelArn: CHANNEL, battleId: BATTLE, status: 'completed', assistantId: 'advisor' },
    { taskId: 't-paused', channelArn: CHANNEL, battleId: BATTLE, status: 'abandoned', assistantId: 'alt' },
  ];

  function answer() {
    mockSend.mockImplementation(async (c: { __type: string; input: any }) => {
      if (c.__type === 'Query') return { Items: rows };
      if (c.__type === 'Get') return { Item: rows.find((r) => r.taskId === c.input.Key.taskId) };
      return {};
    });
  }

  it('finds the duel by the conversation index and its own battleId', async () => {
    answer();
    const { endDuelTasks } = await import('../../lambda/src/lib/task-tracking');
    await endDuelTasks(CHANNEL, BATTLE);
    const q = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Query').input;
    expect(q).toMatchObject({ TableName: 'agent-tasks', IndexName: 'channelArn-updatedAt-index', FilterExpression: 'battleId = :b' });
    expect(q.ExpressionAttributeValues).toEqual({ ':c': CHANNEL, ':b': BATTLE });
  });

  it('closes open and paused work as cancelled with the battle-ended reason, and keeps finished work', async () => {
    answer();
    const { endDuelTasks } = await import('../../lambda/src/lib/task-tracking');
    const closed = await endDuelTasks(CHANNEL, BATTLE);
    expect(closed.map((t) => t.taskId).sort()).toEqual(['t-open', 't-paused']);
    const updates = mockSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'Update' && c.input.TableName === 'agent-tasks');
    expect(updates.map((u) => u.input.Key.taskId).sort()).toEqual(['t-open', 't-paused']);
    for (const u of updates) {
      expect(u.input.ExpressionAttributeValues[':status']).toBe('cancelled');
      expect(u.input.ExpressionAttributeValues[':terminalEntry'][0].reason).toBe('task cancelled: battle-ended');
      // An ending that is not an error records no error.
      expect(u.input.ExpressionAttributeValues[':error']).toBeUndefined();
    }
  });

  it('closes nothing without a conversation or a duel', async () => {
    answer();
    const { endDuelTasks } = await import('../../lambda/src/lib/task-tracking');
    expect(await endDuelTasks(CHANNEL, '')).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('the side\'s message declares its task ended', () => {
  const load = async () => (await import('../../lambda/src/lib/battle-waiting-marker')).declareDuelEnded;

  it('states the closed task cancelled, with the battle-ended ending, flat or under analytics', async () => {
    const declare = await load();
    const flat = JSON.parse(declare(JSON.stringify({ activeTask: { taskId: 't1', status: 'in_progress', type: 'report_generation' } }), new Set(['t1']))!);
    expect(flat.activeTask).toEqual({ taskId: 't1', status: 'cancelled', type: 'report_generation' });
    expect(flat.taskEnding).toBe('battle-ended');
    const nested = JSON.parse(declare(JSON.stringify({ analytics: { activeTask: { taskId: 't1', status: 'in_progress' } } }), new Set(['t1']))!);
    expect(nested.analytics.activeTask.status).toBe('cancelled');
    expect(nested.analytics.taskEnding).toBe('battle-ended');
  });

  it('declares nothing for a task this end did not close, or metadata it cannot read', async () => {
    const declare = await load();
    const other = JSON.stringify({ activeTask: { taskId: 't2', status: 'in_progress' } });
    expect(declare(other, new Set(['t1']))).toBe(other);
    expect(declare('not json', new Set(['t1']))).toBe('not json');
    expect(declare(undefined, new Set(['t1']))).toBeUndefined();
  });

  it('leaves metadata as it was rather than outgrow the Amazon Chime SDK cap', async () => {
    const declare = await load();
    const big = JSON.stringify({ activeTask: { taskId: 't1', status: 'in_progress' }, pad: 'x'.repeat(990) });
    expect(declare(big, new Set(['t1']))).toBe(big);
  });
});

describe('reports read an ended duel\'s work as abandoned', () => {
  it('closes only a running flow whose task a message declared ended with its duel, and names why', async () => {
    jest.doMock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn(), batchInsert: jest.fn() }), { virtual: false });
    const { DUEL_ENDED_FLOWS_SQL } = await import('../../lambda/src/analytics-aurora/evaluation-runner');
    expect(DUEL_ENDED_FLOWS_SQL).toContain("SET status = 'abandoned'");
    expect(DUEL_ENDED_FLOWS_SQL).toContain("outcome = 'abandoned - battle ended'");
    expect(DUEL_ENDED_FLOWS_SQL).toContain("WHERE f.status = 'in_progress'");
    expect(DUEL_ENDED_FLOWS_SQL).toContain("= 'battle-ended'");
    expect(DUEL_ENDED_FLOWS_SQL).not.toMatch(/outcome_score|information_score/);
  });

  it('runs before the stale sweep, so a duel is closed for its own reason', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/analytics-aurora/evaluation-runner.ts'), 'utf8');
    expect(src.indexOf('await closeDuelEndedFlows()')).toBeGreaterThan(-1);
    expect(src.indexOf('await closeDuelEndedFlows()')).toBeLessThan(src.indexOf('await sweepStaleFlows()'));
  });
});

describe('the router closes the work only for a duel proven ended in that conversation', () => {
  it('closes after every check, and declares the ending on the marker edit', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const at = src.indexOf('export async function clearDuelMarkers(');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    const close = body.indexOf('await endDuelTasks(channelArn, battleId)');
    expect(close).toBeGreaterThan(body.indexOf("refuse('the duel was not ended')"));
    expect(close).toBeGreaterThan(body.indexOf("refuse('the duel ran in another conversation')"));
    expect(close).toBeGreaterThan(body.indexOf("refuse('the conversation is not this classification')"));
    expect(body).toContain('declareDuelEnded(m, closedTaskIds)');
  });
});
