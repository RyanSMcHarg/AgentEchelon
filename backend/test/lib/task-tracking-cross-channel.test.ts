/**
 * Cross-channel task continuity (P2.4) — pins the new lookup paths
 * and the prompt-hint shape.
 *
 *   - getActiveTask(userSub, taskType, { channelArn }) — scoped resume
 *   - getActiveTasksForUser(userSub, opts?) — cross-channel discovery
 *   - buildCrossChannelTasksHint(currentChannelArn, allActive) — prompt fragment
 *
 * Mock + module-reset pattern matches battle-task.test.ts in this dir.
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

const USER_SUB = 'user-sub-1';
const CHANNEL_A = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/a';
const CHANNEL_B = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/b';

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  process.env.TASKS_TABLE = 'tasks-test';
});

describe('getActiveTask — channel scope option (P2.4)', () => {
  it('queries the GSI WITHOUT a channel filter by default (back-compat)', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { userSub: USER_SUB, taskId: 't-1', taskType: 'report_generation', channelArn: CHANNEL_A, status: 'in_progress' },
      ],
    });
    const { getActiveTask } = await import('../../lambda/src/lib/task-tracking');
    const result = await getActiveTask(USER_SUB, 'report_generation');
    expect(result?.taskId).toBe('t-1');

    const call = mockSend.mock.calls[0][0];
    expect(call.input.FilterExpression).toBe('#status IN (:pending, :inProgress)');
    expect(call.input.ExpressionAttributeValues[':channelArn']).toBeUndefined();
    expect(call.input.IndexName).toBe('userSub-taskType-index');
  });

  it('adds a channelArn FilterExpression when opts.channelArn is supplied', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { getActiveTask } = await import('../../lambda/src/lib/task-tracking');
    await getActiveTask(USER_SUB, 'report_generation', { channelArn: CHANNEL_B });

    const call = mockSend.mock.calls[0][0];
    expect(call.input.FilterExpression).toContain('channelArn = :channelArn');
    expect(call.input.ExpressionAttributeValues[':channelArn']).toBe(CHANNEL_B);
  });

  it('returns null when USER_TASKS_TABLE env is unset (no implicit DDB call)', async () => {
    delete process.env.USER_TASKS_TABLE;
    const { getActiveTask } = await import('../../lambda/src/lib/task-tracking');
    const result = await getActiveTask(USER_SUB, 'report_generation');
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns null and does not throw when the DDB query errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('connection blip'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { getActiveTask } = await import('../../lambda/src/lib/task-tracking');
    const result = await getActiveTask(USER_SUB, 'report_generation', { channelArn: CHANNEL_A });
    expect(result).toBeNull();
    errSpy.mockRestore();
  });
});

describe('getActiveTasksForUser — cross-channel discovery', () => {
  it('queries the table by PK userSub (NOT the GSI) and filters to active statuses', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { userSub: USER_SUB, taskId: 't-1', taskType: 'report_generation', channelArn: CHANNEL_A, status: 'in_progress', updatedAt: '2026-05-22T10:00:00Z' },
        { userSub: USER_SUB, taskId: 't-2', taskType: 'data_extraction', channelArn: CHANNEL_B, status: 'pending', updatedAt: '2026-05-22T11:00:00Z' },
      ],
    });
    const { getActiveTasksForUser } = await import('../../lambda/src/lib/task-tracking');
    const rows = await getActiveTasksForUser(USER_SUB);

    const call = mockSend.mock.calls[0][0];
    expect(call.input.IndexName).toBeUndefined();
    expect(call.input.KeyConditionExpression).toBe('userSub = :userSub');
    expect(call.input.FilterExpression).toBe('#status IN (:pending, :inProgress)');
    expect(rows).toHaveLength(2);
    // Sorted by updatedAt desc — t-2 is newer.
    expect(rows[0].taskId).toBe('t-2');
    expect(rows[1].taskId).toBe('t-1');
  });

  it('respects opts.limit (over-fetches 4× to compensate for FilterExpression)', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { getActiveTasksForUser } = await import('../../lambda/src/lib/task-tracking');
    await getActiveTasksForUser(USER_SUB, { limit: 3 });
    expect(mockSend.mock.calls[0][0].input.Limit).toBe(12);
  });

  it('clamps a too-small limit up to 1, and a too-large limit down to 25', async () => {
    // Each await import gets a fresh module instance because of resetModules in beforeEach;
    // but within a single test the module is loaded once. Reset manually between calls.
    mockSend.mockResolvedValue({ Items: [] });

    const mod1 = await import('../../lambda/src/lib/task-tracking');
    await mod1.getActiveTasksForUser(USER_SUB, { limit: -5 });
    expect(mockSend.mock.calls[0][0].input.Limit).toBe(4); // 1 × 4

    await mod1.getActiveTasksForUser(USER_SUB, { limit: 999 });
    expect(mockSend.mock.calls[1][0].input.Limit).toBe(100); // 25 × 4
  });

  it('returns [] when USER_TASKS_TABLE is unset (no implicit DDB call)', async () => {
    delete process.env.USER_TASKS_TABLE;
    const { getActiveTasksForUser } = await import('../../lambda/src/lib/task-tracking');
    const rows = await getActiveTasksForUser(USER_SUB);
    expect(rows).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns [] and does not throw when the DDB query errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('connection blip'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { getActiveTasksForUser } = await import('../../lambda/src/lib/task-tracking');
    const rows = await getActiveTasksForUser(USER_SUB);
    expect(rows).toEqual([]);
    errSpy.mockRestore();
  });
});

describe('buildCrossChannelTasksHint — prompt fragment shape', () => {
  it('returns empty string when no tasks are active anywhere', async () => {
    const { buildCrossChannelTasksHint } = await import('../../lambda/src/lib/task-tracking');
    expect(buildCrossChannelTasksHint(CHANNEL_A, [])).toBe('');
  });

  it('returns empty string when every active task is in the current channel', async () => {
    const { buildCrossChannelTasksHint } = await import('../../lambda/src/lib/task-tracking');
    const tasks = [
      { userSub: USER_SUB, taskId: 't-1', taskType: 'report_generation', channelArn: CHANNEL_A, status: 'in_progress' as const, createdAt: '', updatedAt: '', ttl: 0 },
    ];
    expect(buildCrossChannelTasksHint(CHANNEL_A, tasks)).toBe('');
  });

  it('produces an OTHER ACTIVE WORK section when tasks exist in other channels', async () => {
    const { buildCrossChannelTasksHint } = await import('../../lambda/src/lib/task-tracking');
    const tasks = [
      { userSub: USER_SUB, taskId: 't-1', taskType: 'report_generation', channelArn: CHANNEL_A, status: 'in_progress' as const, createdAt: '', updatedAt: '', ttl: 0 },
      { userSub: USER_SUB, taskId: 't-2', taskType: 'data_extraction', channelArn: CHANNEL_A, status: 'pending' as const, createdAt: '', updatedAt: '', ttl: 0 },
      { userSub: USER_SUB, taskId: 't-3', taskType: 'report_generation', channelArn: CHANNEL_B, status: 'in_progress' as const, createdAt: '', updatedAt: '', ttl: 0 },
    ];
    const hint = buildCrossChannelTasksHint(CHANNEL_B, tasks);
    expect(hint).toContain('## OTHER ACTIVE WORK');
    expect(hint).toContain('2 active tasks in other conversations');
    // Channel ARNs are NOT leaked into the prompt — we surface counts +
    // task-type labels only.
    expect(hint).not.toContain(CHANNEL_A);
    expect(hint).toContain('1 report_generation');
    expect(hint).toContain('1 data_extraction');
  });

  it('aggregates same-type tasks into a single line with the right count + plural', async () => {
    const { buildCrossChannelTasksHint } = await import('../../lambda/src/lib/task-tracking');
    const tasks = [
      { userSub: USER_SUB, taskId: 't-1', taskType: 'report_generation', channelArn: CHANNEL_A, status: 'in_progress' as const, createdAt: '', updatedAt: '', ttl: 0 },
      { userSub: USER_SUB, taskId: 't-2', taskType: 'report_generation', channelArn: 'other', status: 'in_progress' as const, createdAt: '', updatedAt: '', ttl: 0 },
      { userSub: USER_SUB, taskId: 't-3', taskType: 'report_generation', channelArn: 'other2', status: 'pending' as const, createdAt: '', updatedAt: '', ttl: 0 },
    ];
    const hint = buildCrossChannelTasksHint(CHANNEL_B, tasks);
    expect(hint).toContain('3 active tasks');
    expect(hint).toContain('3 report_generations');
  });

  it('falls back to "general" for tasks missing a taskType', async () => {
    const { buildCrossChannelTasksHint } = await import('../../lambda/src/lib/task-tracking');
    const tasks = [
      { userSub: USER_SUB, taskId: 't-1', taskType: '', channelArn: CHANNEL_A, status: 'in_progress' as const, createdAt: '', updatedAt: '', ttl: 0 },
    ];
    const hint = buildCrossChannelTasksHint(CHANNEL_B, tasks);
    expect(hint).toContain('1 general');
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
