/**
 * A FINISHED TASK LEAVES THE PERSON'S LIST, INCLUDING ONE WITH NO ASSISTANT.
 *
 * The mirror row is what `/tasks/mine` reads, so a terminal status that never reaches it leaves
 * finished work sitting in somebody's open list - and the composer addresses their next message at
 * the assistant holding an open item (ADR-032), so a queue that never lets go points a reply at work
 * that is already done. A wrong answer arriving for a right-looking reason.
 *
 * WHY THIS FILE EXISTS RATHER THAN A LINE IN AN EXISTING ONE. The fix it guards was a REGRESSION
 * introduced while fixing something else: making the mirror write a whole row (so a healed row stays
 * findable by the two indexes D8 added) meant writing `ownerPersonId` and `assistantId` - and both are
 * index KEYS. `ownerPersonId` is the hash key of `ownerPersonId-index` and `assistantId` the range key of
 * `channelArn-assistantId-index`, and DynamoDB refuses an empty string in either, failing the WHOLE
 * UpdateItem. The surrounding catch swallows it.
 *
 * So a task with no assistant - which is ordinary, not exotic - had its terminal status silently not
 * mirrored at all, reinstating the exact defect the whole-row change was made to fix. Nothing failed,
 * nothing logged above a warning, and the only symptom was in somebody's list.
 *
 * The fix was in and nothing guarded it. A fix is not finished until something would catch its
 * undoing.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  DeleteCommand: jest.fn().mockImplementation((a) => ({ __t: 'Delete', input: a })),
  ScanCommand: jest.fn().mockImplementation((a) => ({ __t: 'Scan', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

import type { Task } from '../../lambda/src/lib/task-tracking';

// Read at module load; an `import` hoists above an assignment beside it, so the env must be set
// before the require or the module sees no table and every assertion passes for the wrong reason.
process.env.TASKS_TABLE = 'tasks-test';
process.env.USER_TASKS_TABLE = 'user-tasks-test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pauseTask } = require('../../lambda/src/lib/task-tracking') as
  typeof import('../../lambda/src/lib/task-tracking');

const REQUESTER = '44581468-f091-704d-3f8e-4d41f866a0b4';
const ASSISTANT = 'ed31ac66-21f5-41d0-9fdf-faf1da43869c';
const APP = 'arn:aws:chime:us-east-1:123456789012:app-instance/i';
const CHANNEL = `${APP}/channel/c1`;

const taskOf = (over: Partial<Task> = {}): Task => ({
  taskId: 't1',
  channelArn: CHANNEL,
  userArn: `${APP}/user/${REQUESTER}`,
  requestExcerpt: 'a report please',
  status: 'in_progress',
  taskType: 'report_generation',
  taskState: 'collecting_requirements',
  details: {},
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  ttl: 1788600000,
  assigneeId: REQUESTER,
  assigneeType: 'user',
  ...over,
} as Task);

/** The mirror write is the UpdateCommand aimed at the user-tasks table. */
function mirrorWrite(): { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> } | undefined {
  const call = mockSend.mock.calls
    .map(([c]) => c)
    .find((c: any) => c?.__t === 'Update' && c?.input?.TableName === 'user-tasks-test');
  return call?.input;
}

describe('a terminal status reaches the mirror, whatever the task is missing', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  /** `pauseTask` reads the task, writes the status, then mirrors it. */
  function givenTask(task: Task): void {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd?.__t === 'Get') return Promise.resolve({ Item: task });
      return Promise.resolve({});
    });
  }

  it('writes no index key at all for a task with no assistant and no owner', async () => {
    // NO `assistantId` and a `userArn` that yields no sub either, so both index keys would be empty.
    givenTask(taskOf({ userArn: '' }));

    await pauseTask('t1', CHANNEL);

    const write = mirrorWrite();
    // A missing write is the same defect wearing a different face: the status never reached the list.
    expect(write).toBeTruthy();
    // NOT "writes an empty string" - the expression must not MENTION them. A `SET ownerPersonId = :os`
    // with `:os` absent is a malformed request, and one with `:os` empty is the refusal this guards.
    expect(write!.UpdateExpression).not.toMatch(/ownerPersonId/);
    expect(write!.UpdateExpression).not.toMatch(/assistantId/);
    // No value may be an empty string: an index key cannot be one, and the refusal fails the
    // whole UpdateItem into a swallowing catch.
    for (const value of Object.values(write!.ExpressionAttributeValues)) {
      expect(value).not.toBe('');
    }
  });

  it('still writes them when there is something to write, so the indexes stay findable', async () => {
    // The other half of the rule, and the reason it is conditional rather than simply omitted: a row
    // healed by this path has to stay visible to the owner listing and the referent read.
    givenTask(taskOf({ assistantId: ASSISTANT, ownerPersonId: REQUESTER }));

    await pauseTask('t1', CHANNEL);

    const write = mirrorWrite();
    expect(write!.UpdateExpression).toMatch(/ownerPersonId = if_not_exists\(ownerPersonId, :os\)/);
    expect(write!.UpdateExpression).toMatch(/assistantId = if_not_exists\(assistantId, :aid\)/);
    expect(write!.ExpressionAttributeValues[':os']).toBe(REQUESTER);
    expect(write!.ExpressionAttributeValues[':aid']).toBe(ASSISTANT);
  });

  it('falls back to the requester in the userArn when the task carries no ownerPersonId', async () => {
    // A row written before D8 has no `ownerPersonId`, and the requester in its `userArn` is who it belongs
    // to. Deriving it keeps those rows findable by the owner listing without a migration.
    givenTask(taskOf({ assistantId: ASSISTANT }));

    await pauseTask('t1', CHANNEL);

    expect(mirrorWrite()!.ExpressionAttributeValues[':os']).toBe(REQUESTER);
  });

  it('does not undo an owner handover, because a status mirror is not a reassignment', async () => {
    // `if_not_exists` on both, which is the point: an owner handover writes `ownerPersonId` directly, and
    // a later terminal status must not put the original owner back.
    givenTask(taskOf({ ownerPersonId: 'somebody-else', assistantId: ASSISTANT }));

    await pauseTask('t1', CHANNEL);

    expect(mirrorWrite()!.UpdateExpression).toMatch(/ownerPersonId = if_not_exists\(/);
  });
});
