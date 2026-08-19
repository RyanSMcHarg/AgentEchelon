/**
 * "Waiting on you" is ONE queue, keyed on who owes the step (tracker row 92, ADR-024 + ADR-029).
 *
 * The shape this pins, and why it is worth a test of its own: a person accumulates blocked items from
 * several assistants and several workflows at once - a duel side that asked a clarifying question, a
 * report chain waiting on scope, an extraction waiting on a column mapping, spread across
 * conversations. To that person they are one thing: something is blocked on me. The trap the design
 * avoided was inventing a second signal per workflow (a `<!--taskwaiting-->` marker beside
 * `<!--battlewaiting-->`), which is two things to keep in agreement and the same defect class as two
 * correlation-id derivations.
 *
 * So the queue reads ONE store, keyed by the OWNER of the current step:
 *   - a task whose machine starts blocked on the person is owned by the person from creation, which is
 *     what made a duel waiting on someone visible at all;
 *   - `maybeHandOver` moves ownership at every `awaitsUser` boundary afterwards;
 *   - `getActiveTasksForUser` answers "what do I owe" cross-channel from that one partition.
 *
 * The two cases named as this row's exit criteria are here: several sources in one list, and a
 * requester who is NOT the person who owes.
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
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const PRIYA = 'priya-sub';
const SAM = 'sam-sub';
const PLAN_CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/plan';
const DUEL_CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/duel';

/** A mirror row as the user-tasks table stores it: partitioned by whoever owes the step. */
const row = (over: Record<string, unknown> = {}) => ({
  userSub: PRIYA,
  taskId: 't1',
  channelArn: PLAN_CHANNEL,
  taskType: 'report_generation',
  status: 'in_progress',
  updatedAt: '2026-08-17T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  process.env.TASKS_TABLE = 'tasks-test';
});

describe('the queue is one list, whatever opened the item', () => {
  it('returns items from DIFFERENT workflows and DIFFERENT conversations together', async () => {
    // A duel side and a report chain are different features with different state machines. To the
    // person they are one queue, and this read is what has to make that true - without a per-workflow
    // signal to keep in agreement.
    mockSend.mockResolvedValueOnce({
      Items: [
        row({ taskId: 'report-1', taskType: 'report_generation', channelArn: PLAN_CHANNEL, updatedAt: '2026-08-17T10:00:00.000Z' }),
        row({ taskId: 'duel-1', taskType: 'guided_troubleshooting', channelArn: DUEL_CHANNEL, battleId: 'b1', updatedAt: '2026-08-17T11:00:00.000Z' }),
        row({ taskId: 'extract-1', taskType: 'data_extraction', channelArn: PLAN_CHANNEL, updatedAt: '2026-08-17T09:00:00.000Z' }),
      ],
    });
    const { getActiveTasksForUser } = await import('../../lambda/src/lib/task-tracking');

    const items = await getActiveTasksForUser(PRIYA);

    expect(items.map((t) => t.taskId).sort()).toEqual(['duel-1', 'extract-1', 'report-1']);
    // ONE partition read answers it - not one call per workflow, and not one per conversation.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input.ExpressionAttributeValues[':userSub']).toBe(PRIYA);
  });

  it('an item in a conversation the person is not looking at is still theirs', async () => {
    // The item someone has forgotten is by definition in the conversation they are not looking at, so
    // a queue derived from the LOADED channel's messages cannot show the one that matters most.
    mockSend.mockResolvedValueOnce({ Items: [row({ taskId: 'elsewhere', channelArn: DUEL_CHANNEL })] });
    const { getActiveTasksForUser } = await import('../../lambda/src/lib/task-tracking');

    const items = await getActiveTasksForUser(PRIYA);

    expect(items).toHaveLength(1);
    expect(items[0].channelArn).toBe(DUEL_CHANNEL);
  });
});

describe('the queue is keyed on WHO OWES IT, not who asked', () => {
  it('reads the assignee partition, so a task Sam requested and Priya owes is PRIYA\'s', async () => {
    // Requester and owner are routinely different people: a colleague asks for a report and the
    // assistant needs scope from whoever owns that plan. Keying the queue on the requester would show
    // the item to the person who is NOT blocked and hide it from the one who is - worse than having no
    // queue, because it looks like it works.
    mockSend.mockResolvedValueOnce({
      Items: [row({ taskId: 'sam-asked', userSub: PRIYA, requesterSub: SAM })],
    });
    const { getActiveTasksForUser } = await import('../../lambda/src/lib/task-tracking');

    const items = await getActiveTasksForUser(PRIYA);

    expect(items.map((t) => t.taskId)).toEqual(['sam-asked']);
    const values = mockSend.mock.calls[0][0].input.ExpressionAttributeValues;
    expect(values[':userSub']).toBe(PRIYA);
    expect(Object.values(values)).not.toContain(SAM);
  });

  it('the requester sees nothing of their own request while it is not their step', async () => {
    // The same task read as Sam: his partition is empty, because he owes nothing right now.
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { getActiveTasksForUser } = await import('../../lambda/src/lib/task-tracking');

    expect(await getActiveTasksForUser(SAM)).toEqual([]);
  });
});
