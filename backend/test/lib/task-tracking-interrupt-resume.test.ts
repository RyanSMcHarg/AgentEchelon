/**
 * Interrupt + resume for multi-step tasks.
 *
 * A user must be able to BREAK OUT of a task sequence mid-flow and later GET BACK IN, picking up
 * exactly where they left off:
 *   - pauseTask  — INTERRUPT: mark the task `abandoned` in BOTH the agent-tasks (source of truth)
 *                  and user-tasks (mirror) tables, so getActiveTask (pending|in_progress) stops
 *                  force-resuming it and the next turns flow normally.
 *   - resumeTask — RESUME: flip the status back to `in_progress` WITHOUT touching taskState, so the
 *                  flow continues from the exact step it was paused at.
 *
 * Mock + module-reset pattern matches task-tracking-cross-channel.test.ts in this dir.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  DeleteCommand: jest.fn().mockImplementation((a) => ({ __t: 'Delete', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const USER_SUB = 'user-sub-1';
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/a';
const TASK_ID = 't-1';

// A multi-step report task paused mid-flow at the `generating` step.
const taskAt = (status: string) => ({
  taskId: TASK_ID,
  channelArn: CHANNEL,
  taskType: 'report_generation',
  taskState: 'generating',
  status,
  userArn: `arn:aws:chime:us-east-1:1:app-instance/i/user/${USER_SUB}`,
});

const updates = () => mockSend.mock.calls.map((c) => c[0]).filter((cmd) => cmd.__t === 'Update');

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  process.env.TASKS_TABLE = 'tasks-test';
});

describe('pauseTask — interrupt (break out of the sequence)', () => {
  it('marks the task abandoned in BOTH the source table and the user-tasks mirror', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: taskAt('in_progress') }) // getTask
      .mockResolvedValue({}); // the two status updates
    const { pauseTask } = await import('../../lambda/src/lib/task-tracking');

    const ok = await pauseTask(TASK_ID, CHANNEL);
    expect(ok).toBe(true);

    const u = updates();
    const sourceUpdate = u.find((c) => c.input.TableName === 'tasks-test');
    const mirrorUpdate = u.find((c) => c.input.TableName === 'user-tasks-test');
    expect(sourceUpdate.input.ExpressionAttributeValues[':status']).toBe('abandoned');
    expect(mirrorUpdate.input.Key).toEqual({ userSub: USER_SUB, taskId: TASK_ID });
    expect(mirrorUpdate.input.ExpressionAttributeValues[':s']).toBe('abandoned');
  });

  it('is a no-op for an already-closed task (never re-opens completed work)', async () => {
    mockSend.mockResolvedValueOnce({ Item: taskAt('completed') }); // getTask
    const { pauseTask } = await import('../../lambda/src/lib/task-tracking');

    const ok = await pauseTask(TASK_ID, CHANNEL);
    expect(ok).toBe(false);
    expect(updates()).toHaveLength(0);
  });

  it('after an interrupt, getActiveTask no longer returns the task (the user is free to do other things)', async () => {
    // The mirror now filters out abandoned rows, so the channel-scoped resume lookup yields nothing.
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { getActiveTask } = await import('../../lambda/src/lib/task-tracking');
    const result = await getActiveTask(USER_SUB, 'report_generation', { channelArn: CHANNEL });
    expect(result).toBeNull();
  });
});

describe('resumeTask — resume (pick up where you left off)', () => {
  it('reactivates an abandoned task to in_progress WITHOUT changing its saved state', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: taskAt('abandoned') }) // getTask
      .mockResolvedValue({}); // the two status updates
    const { resumeTask } = await import('../../lambda/src/lib/task-tracking');

    const resumed = await resumeTask(TASK_ID, CHANNEL);
    // Picks up at the EXACT step it was paused at.
    expect(resumed?.taskState).toBe('generating');
    expect(resumed?.status).toBe('in_progress');

    const u = updates();
    const sourceUpdate = u.find((c) => c.input.TableName === 'tasks-test');
    const mirrorUpdate = u.find((c) => c.input.TableName === 'user-tasks-test');
    expect(sourceUpdate.input.ExpressionAttributeValues[':status']).toBe('in_progress');
    expect(mirrorUpdate.input.ExpressionAttributeValues[':s']).toBe('in_progress');
    // taskState is never part of the resume write — it is preserved as-is.
    expect(JSON.stringify(sourceUpdate.input)).not.toContain('taskState');
  });

  it('refuses to resurrect a completed task', async () => {
    mockSend.mockResolvedValueOnce({ Item: taskAt('completed') }); // getTask
    const { resumeTask } = await import('../../lambda/src/lib/task-tracking');

    const resumed = await resumeTask(TASK_ID, CHANNEL);
    expect(resumed).toBeNull();
    expect(updates()).toHaveLength(0);
  });

  it('returns null when the task no longer exists', async () => {
    mockSend.mockResolvedValueOnce({}); // getTask → no Item
    const { resumeTask } = await import('../../lambda/src/lib/task-tracking');
    expect(await resumeTask(TASK_ID, CHANNEL)).toBeNull();
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
