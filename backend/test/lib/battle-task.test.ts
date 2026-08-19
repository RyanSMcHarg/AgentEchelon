/**
 * A duel's task — an ordinary task whose OWNER is an assistant (ADR-024 D1/D2).
 *
 * Each side gets its OWN taskId, owned by that side as `{ ownerId: <AppInstanceBotId>, ownerType:
 * 'assistant' }`, with the state machine's initial state.
 *
 * IT IS MIRRORED NOW, and that reversal is the point of the change these tests moved with. The
 * mirror used to be skipped because it was partitioned by the USER, where two bots on one user and
 * one task type collided. Partitioned by the OWNER each side is its own partition, so a duelling
 * assistant is found by the same lookup that finds a person's work item - which is what lets the
 * battle state row stop carrying a `taskId`.
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

/**
 * A duel's task is created by the ONE creation path (ADR-026).
 *
 * These used to call `createBattleTask`, a near-duplicate of `createTask` that differed only in taking
 * its channel/user explicitly, stamping `battleId`, and forcing an assistant owner. ADR-024 made
 * "the owner may be an assistant" first-class, which left the second door buying nothing - and costing
 * something real, because being a separate branch is why it was tested BEFORE the ordinary active-task
 * branch, so a resumed side created a fresh task every turn instead of continuing its own chain.
 *
 * Every property below is the same property; only the door changed.
 */
const EVENT = {
  // Percent-encoded, as a bypass entry delivers it. `requestExcerpt` carries the decoded text, which is
  // what the excerpt assertion below checks: reading the transcript directly stored `Produce%20a...`.
  inputTranscript: encodeURIComponent(ARGS.userMessage),
  requestAttributes: {
    'CHIME.channel.arn': ARGS.channelArn,
    'CHIME.sender.arn': ARGS.userArn,
  },
};

/** The person's principal id, derived exactly as the code does: the last segment of their ARN. */
const principalIdOfUser = ARGS.userArn.split('/user/').pop()!;

/** The options a battle turn passes: an assistant owner, the duel id, and the decoded excerpt. */
async function createSideTask(assignedBotArn = ARGS.assignedBotArn, taskType = ARGS.taskType) {
  const { createTask, principalIdFromArn } = await import('../../lambda/src/lib/task-tracking');
  return createTask(EVENT, ARGS.deliveryOption, taskType, undefined, {
    owner: { id: principalIdFromArn(assignedBotArn), type: 'assistant' as const },
    battleId: ARGS.battleId,
    requestExcerpt: ARGS.userMessage,
  });
}

describe("a duel side's task, through the one creation path", () => {
  it('writes the task held by the PERSON who owes the first step, and stamped with the assistant whose work it is', async () => {
    const task = await createSideTask();

    const put = mockSend.mock.calls.find((c) => c[0].input.TableName === 'tasks-test')![0];
    expect(put.__t).toBe('Put');
    expect(put.input.Item.taskId).toBe(task.taskId);
    // TWO FIELDS, TWO QUESTIONS (owner, 2026-08-14). The OWNER is who must act next, and
    // `report_generation` starts at `collecting_requirements`, which the machine declares
    // `awaitsUser` - so the chain is blocked on the person from its first moment and they hold it.
    // Owning it is what puts it in their queue; the caller's assistant owner is honoured only for a
    // first step the assistant actually owes.
    expect(put.input.Item.ownerId).toBe(principalIdOfUser);
    expect(put.input.Item.ownerType).toBe('user');
    // The ASSISTANT whose work it is, which never moves. This is what tells two duel sides apart now
    // that both wait on the same person - previously the owner did that job, and it could not do both.
    expect(put.input.Item.assistantId).toBe('AltSlot0');
    expect(put.input.Item.assistantId).not.toContain('arn:');
    expect(put.input.Item.battleId).toBe(ARGS.battleId);
    expect(put.input.Item.taskType).toBe('report_generation');
    expect(put.input.Item.status).toBe('pending');
    // initial state from the report_generation state machine
    expect(put.input.Item.taskState).toBe('collecting_requirements');
    // The excerpt is the DECODED message, not the percent-encoded transcript an operator cannot read.
    expect(put.input.Item.requestExcerpt).toBe(ARGS.userMessage);
    expect(put.input.Item.requestExcerpt).not.toContain('%20');
  });

  it('IS mirrored, under the holder, carrying the assistant it belongs to', async () => {
    await createSideTask();

    const mirror = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c.input.TableName === 'user-tasks-test');
    expect(mirror).toBeDefined();
    // The partition is the OWNER. The attribute is still called `userSub` because DynamoDB cannot
    // rename a key attribute (ADR-024 D2); what it holds is the bot's principal id.
    expect(mirror!.input.Item.userSub).toBe(principalIdOfUser);
    expect(mirror!.input.Item.ownerType).toBe('user');
    // Carried onto the mirror so the assistant can find its own chain inside the person's partition
    // without reading every candidate's full row.
    expect(mirror!.input.Item.assistantId).toBe('AltSlot0');
    expect(mirror!.input.Item.channelArn).toBe(ARGS.channelArn);
    expect(mirror!.input.Item.taskType).toBe('report_generation');
    expect(mirror!.input.Item.ttl).toBeGreaterThan(0);
  });

  it('two sides of one duel stay DISTINGUISHABLE, by assistant rather than by partition', async () => {
    const a = await createSideTask('arn:bot/default');
    const b = await createSideTask('arn:bot/AltSlot0');
    expect(a.taskId).not.toBe(b.taskId);
    expect(a.battleId).toBe(b.battleId);

    // THE PROPERTY, RESTATED WHERE IT NOW LIVES. Both sides are blocked on the same person, so both
    // are held by that person and the partition no longer separates them - it cannot, because putting
    // work in someone's queue means putting it where their other work is. `assistantId` is what keeps
    // a side from resuming its rival's chain, so that is what this asserts.
    expect(a.assistantId).toBe('default');
    expect(b.assistantId).toBe('AltSlot0');
    expect(a.ownerId).toBe(principalIdOfUser);
    expect(b.ownerId).toBe(principalIdOfUser);

    const mirrored = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.input.TableName === 'user-tasks-test')
      .map((c) => ({ partition: c.input.Item.userSub, assistant: c.input.Item.assistantId }));
    expect(mirrored).toEqual([
      { partition: principalIdOfUser, assistant: 'default' },
      { partition: principalIdOfUser, assistant: 'AltSlot0' },
    ]);
  });

  it('is resilient: a tasks-table failure does not throw (returns the task object)', async () => {
    mockSend.mockRejectedValueOnce(new Error('DDB down'));
    const task = await createSideTask();
    expect(task.ownerId).toBe(principalIdOfUser);
    expect(task.assistantId).toBe('AltSlot0');
  });

  it('no taskState when the taskType has no state machine', async () => {
    const task = await createSideTask(ARGS.assignedBotArn, 'general');
    expect(task.taskState).toBeUndefined();
  });

  it('there is no second creation door left to drift from this one', async () => {
    // The collapse is the point. A reintroduced `createBattleTask` would be a second branch, and being a
    // second branch is what put it ahead of the ordinary continue check in the first place.
    const mod = await import('../../lambda/src/lib/task-tracking');
    expect('createBattleTask' in mod).toBe(false);
  });
});

/**
 * WHICH CHAIN A REPLY ANSWERS, when one person holds two.
 *
 * This is the case the owner field used to answer and no longer can. Both duel sides wait on the same
 * person, so both of their tasks sit in that person's partition - which is the point, it is how they
 * reach the queue - and "the active task in this channel" now names two rows. Picking the newest would
 * hand a side its rival's work: the same class of silent wrongness as a duel answering with the wrong
 * variant, and just as invisible, because the turn still produces a plausible answer.
 */
describe('a side resolves ITS OWN chain out of the holder\'s partition', () => {
  const HOLDER = 'user-alice';
  const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';

  const rows = [
    { userSub: HOLDER, taskId: 't-rival', assistantId: 'AltSlot0', taskType: 'report_generation', channelArn: CHANNEL, status: 'in_progress', updatedAt: '2026-08-14T00:00:02Z' },
    { userSub: HOLDER, taskId: 't-mine', assistantId: 'default', taskType: 'report_generation', channelArn: CHANNEL, status: 'in_progress', updatedAt: '2026-08-14T00:00:01Z' },
  ];

  beforeEach(() => {
    mockSend.mockImplementation(async (cmd: any) =>
      cmd?.input?.TableName === 'user-tasks-test' ? { Items: rows } : {});
  });

  it('picks the chain belonging to the ASSISTANT asking, not the most recent one', async () => {
    const { getActiveTaskForAssistant } = await import('../../lambda/src/lib/task-tracking');

    // 't-rival' is newer, so a "current task" lookup returns it. This one must not.
    expect((await getActiveTaskForAssistant('default', HOLDER, CHANNEL))?.taskId).toBe('t-mine');
    expect((await getActiveTaskForAssistant('AltSlot0', HOLDER, CHANNEL))?.taskId).toBe('t-rival');
  });

  it('returns nothing for an assistant holding no chain here, rather than someone else\'s', async () => {
    const { getActiveTaskForAssistant } = await import('../../lambda/src/lib/task-tracking');
    expect(await getActiveTaskForAssistant('Uninvolved', HOLDER, CHANNEL)).toBeNull();
  });
});
