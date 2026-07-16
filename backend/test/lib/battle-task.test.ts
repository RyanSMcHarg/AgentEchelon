/**
 * Phase-2 createBattleTask — per-assistant task ownership.
 *
 * Pins the owner decision ("a separate task per assistant, assigned to
 * it; no GSI migration"): each bot gets its OWN taskId, the task
 * carries assignedBotArn + battleId + the state-machine initial state,
 * it is written to the tasks table but NOT to the user-active GSI
 * table (the two-bot/one-user collision is thereby avoided).
 *
 * Mirrors battle-state.test.ts: mock the DDB doc client, reset modules
 * + set env per test, dynamic-import (module-load env capture).
 */

import { DeliveryOption } from '../../lambda/src/lib/delivery-options';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const ARGS = {
  channelArn: 'arn:chan/c1',
  userArn: 'arn:aws:chime:..:app-instance/i/user/sub-1',
  assignedBotArn: 'arn:aws:chime:..:app-instance/i/bot/AltSlot0',
  battleId: 'a1b2c3d4e5f60718',
  userMessage: 'Produce a Q3 readiness report',
  taskType: 'report_generation',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  messageId: 'msg-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.TASKS_TABLE = 'tasks-test';
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  mockSend.mockResolvedValue({});
});

describe('createBattleTask', () => {
  it('writes ONE task to the tasks table, assigned to the bot, NOT to the user-active table', async () => {
    const { createBattleTask } = await import('../../lambda/src/lib/task-tracking');
    const task = await createBattleTask(ARGS);

    expect(mockSend).toHaveBeenCalledTimes(1); // only AgentTasksTable, never UserTasksTable
    const put = mockSend.mock.calls[0][0];
    expect(put.__t).toBe('Put');
    expect(put.input.TableName).toBe('tasks-test');
    expect(put.input.Item.taskId).toBe(task.taskId);
    expect(put.input.Item.assignedBotArn).toBe(ARGS.assignedBotArn);
    expect(put.input.Item.battleId).toBe(ARGS.battleId);
    expect(put.input.Item.taskType).toBe('report_generation');
    expect(put.input.Item.status).toBe('pending');
    // initial state from the report_generation state machine
    expect(put.input.Item.taskState).toBe('collecting_requirements');
    // never the user-active GSI table
    const tables = mockSend.mock.calls.map((c) => c[0].input.TableName);
    expect(tables).not.toContain('user-tasks-test');
  });

  it('gives each assistant a DISTINCT taskId for the same user+battle', async () => {
    const { createBattleTask } = await import('../../lambda/src/lib/task-tracking');
    const a = await createBattleTask({ ...ARGS, assignedBotArn: 'arn:bot/default' });
    const b = await createBattleTask({ ...ARGS, assignedBotArn: 'arn:bot/AltSlot0' });
    expect(a.taskId).not.toBe(b.taskId);
    expect(a.assignedBotArn).toBe('arn:bot/default');
    expect(b.assignedBotArn).toBe('arn:bot/AltSlot0');
    expect(a.battleId).toBe(b.battleId);
  });

  it('is resilient: a tasks-table failure does not throw (returns the task object)', async () => {
    mockSend.mockRejectedValueOnce(new Error('DDB down'));
    const { createBattleTask } = await import('../../lambda/src/lib/task-tracking');
    const task = await createBattleTask(ARGS);
    expect(task.assignedBotArn).toBe(ARGS.assignedBotArn);
  });

  it('no taskState when the taskType has no state machine', async () => {
    const { createBattleTask } = await import('../../lambda/src/lib/task-tracking');
    const task = await createBattleTask({ ...ARGS, taskType: 'general' });
    expect(task.taskState).toBeUndefined();
  });
});
