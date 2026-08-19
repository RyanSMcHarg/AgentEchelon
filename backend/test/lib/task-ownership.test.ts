/**
 * ADR-024: one owner for a task, and the reads that follow from it.
 *
 * Covers the invariants the migration exists to establish, and the two latent defects it fixes on
 * the way. Both were latent for one reason only - the single assignee-setting caller assigned to the
 * requester, so the two ids coincided and the divergence never showed.
 */

import { DeliveryOption } from '../../lambda/src/lib/delivery-options';

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

const REQUESTER = 'sub-requester';
const OTHER = 'fed_9f3c1e';
const EVENT = {
  inputTranscript: 'draft the Q3 report',
  requestAttributes: {
    'CHIME.channel.arn': 'arn:chan/c1',
    'CHIME.sender.arn': `arn:aws:chime:..:app-instance/i/user/${REQUESTER}`,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.TASKS_TABLE = 'tasks-test';
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  mockSend.mockResolvedValue({});
});

const puts = (table: string) =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.input.TableName === table);

describe('an owner is a principal id plus a stored type (D1)', () => {
  it('defaults to the requester, as a user owner', async () => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const task = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'report_generation');
    expect(task.ownerId).toBe(REQUESTER);
    expect(task.ownerType).toBe('user');
  });

  it('rejects a half-written owner rather than storing an id with no type', async () => {
    const { setTaskOwner } = await import('../../lambda/src/lib/task-tracking');
    expect(() => setTaskOwner({ id: '', type: 'user' })).toThrow();
    // The pair is written together or not at all: an unknown type cannot reach the row, where it
    // would decide "invoke or wait" for whatever read it later.
    expect(() => setTaskOwner({ id: 'x', type: 'nobody' as never })).toThrow();
  });

  it('reads the type from ownerType, never from the shape of the id', async () => {
    const { resolveTaskOwner } = await import('../../lambda/src/lib/task-tracking');
    // A federated human id and a bot id are both opaque strings; only the stored type separates them.
    expect(resolveTaskOwner({ ownerId: OTHER, ownerType: 'user' })).toEqual({ id: OTHER, type: 'user' });
    expect(resolveTaskOwner({ ownerId: OTHER, ownerType: 'assistant' })).toEqual({ id: OTHER, type: 'assistant' });
  });

  it('resolves a pre-migration row from whichever legacy field it carries', async () => {
    const { resolveTaskOwner } = await import('../../lambda/src/lib/task-tracking');
    expect(resolveTaskOwner({ assignedBotArn: 'arn:aws:chime:..:app-instance/i/bot/AltSlot0' }))
      .toEqual({ id: 'AltSlot0', type: 'assistant' });
    expect(resolveTaskOwner({ assigneeUserSub: OTHER })).toEqual({ id: OTHER, type: 'user' });
    expect(resolveTaskOwner({ userArn: `arn:aws:chime:..:app-instance/i/user/${REQUESTER}` }))
      .toEqual({ id: REQUESTER, type: 'user' });
    expect(resolveTaskOwner({})).toBeNull();
  });
});

describe('the mirror is partitioned by the owner (D2)', () => {
  it('creates the mirror row under the OWNER, not the requester', async () => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'action_item', 'corr-1', {
      owner: { id: OTHER, type: 'user' },
    });
    // FINDING 1: this used to key on the requester while every later writer keyed on the assignee,
    // so the row a status update touched was not the row create had written.
    const mirror = puts('user-tasks-test')[0];
    expect(mirror.input.Item.userSub).toBe(OTHER);
    expect(mirror.input.Item.ownerType).toBe('user');
  });

  it('a status mirror carries a whole row, so it can never leave a ttl-less orphan', async () => {
    const task = {
      taskId: 't-1',
      channelArn: 'arn:chan/c1',
      userArn: `arn:aws:chime:..:app-instance/i/user/${REQUESTER}`,
      userMessage: 'x',
      status: 'in_progress' as const,
      deliveryOption: DeliveryOption.TASK_MULTI_STEP,
      taskType: 'report_generation',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ttl: 1893456000,
      ownerId: OTHER,
      ownerType: 'user' as const,
    };
    mockSend.mockResolvedValueOnce({ Item: task }); // getTask
    const { pauseTask } = await import('../../lambda/src/lib/task-tracking');
    await pauseTask('t-1', 'arn:chan/c1');

    const update = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c.input.TableName === 'user-tasks-test');
    expect(update).toBeDefined();
    expect(update!.input.Key.userSub).toBe(OTHER);
    // FINDING 2: the upsert used to set status + updatedAt only. Landing in a partition with no row
    // it created one with no ttl (never expires), no taskType (invisible to the lookup GSI) and no
    // channelArn (dropped by the channel filter).
    const values = update!.input.ExpressionAttributeValues;
    expect(values[':ttl']).toBe(1893456000);
    expect(values[':tt']).toBe('report_generation');
    expect(values[':ch']).toBe('arn:chan/c1');
    expect(update!.input.UpdateExpression).toContain('if_not_exists');
  });
});

describe('what a task stores of the message that opened it (D5)', () => {
  const LONG = 'x'.repeat(5000);

  it('stores a bounded excerpt, not the transcript', async () => {
    const { createTask, TASK_EXCERPT_MAX_CHARS } = await import('../../lambda/src/lib/task-tracking');
    const task = await createTask(
      { ...EVENT, inputTranscript: LONG },
      DeliveryOption.TASK_MULTI_STEP,
      'report_generation',
    );
    expect(task.requestExcerpt).toHaveLength(TASK_EXCERPT_MAX_CHARS);
    expect(task.userMessage).toBeUndefined();
  });

  it('builds the same prompt it built from the full transcript', async () => {
    const { createTask, buildTaskContextForPrompt } = await import('../../lambda/src/lib/task-tracking');
    const bounded = await createTask(
      { ...EVENT, inputTranscript: LONG },
      DeliveryOption.TASK_MULTI_STEP,
      'report_generation',
    );
    // The one consumer already truncated to this length, so the reduction trades nothing away. If
    // the stored bound and the read bound ever drift, this is what notices.
    expect(buildTaskContextForPrompt(bounded))
      .toBe(buildTaskContextForPrompt({ ...bounded, requestExcerpt: undefined, userMessage: LONG }));
  });

  it('separates the correlation key from the user message id', async () => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const withId = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'corr-1', {
      userMessageId: 'chime-msg-77',
    });
    expect(withId.correlationId).toBe('corr-1');
    expect(withId.userMessageId).toBe('chime-msg-77');

    // And where no resolvable id can be had - the Lex path, which Chime gives three request
    // attributes and no message id - it is ABSENT rather than filled with the correlation key. That
    // substitution is what made the old field misleading.
    const withoutId = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'corr-2');
    expect(withoutId.correlationId).toBe('corr-2');
    expect(withoutId.userMessageId).toBeUndefined();
  });
});

describe('the owner lookup: the active task owned by this actor here', () => {
  it('queries the OWNER partition, scoped to the channel and to active statuses', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { getActiveTaskForOwner } = await import('../../lambda/src/lib/task-tracking');
    await getActiveTaskForOwner('AltSlot0', 'arn:chan/c1');

    const q = mockSend.mock.calls[0][0];
    expect(q.__t).toBe('Query');
    expect(q.input.KeyConditionExpression).toBe('userSub = :owner');
    expect(q.input.ExpressionAttributeValues[':owner']).toBe('AltSlot0');
    expect(q.input.FilterExpression).toContain('channelArn = :ch');
    expect(q.input.ExpressionAttributeValues[':ch']).toBe('arn:chan/c1');
    // Strongly consistent, and on the BASE TABLE. This is the read that stops a rapid follow-up turn
    // starting a second expensive task, and a GSI can never serve it (ADR-024 D2) — so a lookup that
    // quietly acquired an IndexName would lose the guard without failing anything else.
    expect(q.input.ConsistentRead).toBe(true);
    expect(q.input.IndexName).toBeUndefined();
  });

  it('asks the same question for an assistant and for a person', async () => {
    const { getActiveTaskForOwner } = await import('../../lambda/src/lib/task-tracking');
    mockSend.mockResolvedValueOnce({ Items: [{ taskId: 'bot-task' }] });
    expect((await getActiveTaskForOwner('AltSlot0', 'arn:chan/c1'))!.taskId).toBe('bot-task');
    mockSend.mockResolvedValueOnce({ Items: [{ taskId: 'human-task' }] });
    expect((await getActiveTaskForOwner(REQUESTER, 'arn:chan/c1'))!.taskId).toBe('human-task');
    // One query, differing only in the owner passed — which is what lets the battle state row stop
    // carrying a taskId to answer a battle question out of task state.
    const [first, second] = mockSend.mock.calls.map((c) => c[0].input);
    expect(first.KeyConditionExpression).toBe(second.KeyConditionExpression);
    expect(first.FilterExpression).toBe(second.FilterExpression);
  });

  it('returns the most recently updated match, not an arbitrary one', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { taskId: 'older', updatedAt: '2026-01-01T00:00:00.000Z' },
        { taskId: 'newest', updatedAt: '2026-03-01T00:00:00.000Z' },
        { taskId: 'middle', updatedAt: '2026-02-01T00:00:00.000Z' },
      ],
    });
    const { getActiveTaskForOwner } = await import('../../lambda/src/lib/task-tracking');
    // The filter runs after the read, so the query cannot order or Limit for us.
    expect((await getActiveTaskForOwner('AltSlot0', 'arn:chan/c1'))!.taskId).toBe('newest');
  });

  it('is null rather than throwing when the query fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('DDB down'));
    const { getActiveTaskForOwner } = await import('../../lambda/src/lib/task-tracking');
    expect(await getActiveTaskForOwner('AltSlot0', 'arn:chan/c1')).toBeNull();
  });
});

describe('the conversation read: what is open here, whoever owns it (D4)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    taskId: 't-9',
    channelArn: 'arn:chan/c1',
    status: 'in_progress',
    taskType: 'action_item',
    taskState: 'awaiting_completion',
    userMessage: 'SECRET: the original message text',
    details: { collected: 'SECRET: extracted values' },
    ownerId: OTHER,
    ownerType: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...over,
  });

  it('queries by CHANNEL and takes no owner at all', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { getOpenTasksForConversation } = await import('../../lambda/src/lib/task-tracking');
    await getOpenTasksForConversation('arn:chan/c1');

    const q = mockSend.mock.calls[0][0];
    expect(q.input.IndexName).toBe('channelArn-updatedAt-index');
    expect(q.input.KeyConditionExpression).toBe('channelArn = :ch');
    // Ownership decides who must ACT, never who can SEE: an owner in this key condition would be the
    // whole decision reversed.
    expect(JSON.stringify(q.input.ExpressionAttributeValues)).not.toContain(REQUESTER);
  });

  it('returns work owned by someone else', async () => {
    mockSend.mockResolvedValueOnce({ Items: [row({ ownerId: OTHER })] });
    const { getOpenTasksForConversation } = await import('../../lambda/src/lib/task-tracking');
    const [task] = await getOpenTasksForConversation('arn:chan/c1');
    expect(task.taskId).toBe('t-9');
    expect(task.ownerId).toBe(OTHER);
    expect(task.ownerType).toBe('user');
  });

  it('carries NO message text, which is what makes a redaction cascade unnecessary', async () => {
    mockSend.mockResolvedValueOnce({ Items: [row()] });
    const { getOpenTasksForConversation } = await import('../../lambda/src/lib/task-tracking');
    const [task] = await getOpenTasksForConversation('arn:chan/c1');
    // The row keeps a verbatim copy of the message that started it and nothing in the task path
    // participates in redaction. Widen this read to the whole conversation carrying that copy and it
    // surfaces text from a message the user watched disappear.
    expect(JSON.stringify(task)).not.toContain('SECRET');
    expect('userMessage' in task).toBe(false);
    expect('details' in task).toBe(false);
  });

  it('resolves the owner of a pre-migration row rather than dropping it', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [row({ ownerId: undefined, ownerType: undefined, assignedBotArn: 'arn:..:bot/AltSlot0' })],
    });
    const { getOpenTasksForConversation } = await import('../../lambda/src/lib/task-tracking');
    const [task] = await getOpenTasksForConversation('arn:chan/c1');
    expect(task.ownerId).toBe('AltSlot0');
    expect(task.ownerType).toBe('assistant');
  });
});

describe('the conversation hint: seeing is not advancing (D4)', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    taskId: 't-1',
    channelArn: 'arn:chan/c1',
    status: 'in_progress' as const,
    taskType: 'action_item',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('describes owners by their relation to the viewer, never by id', async () => {
    const { buildConversationTasksHint } = await import('../../lambda/src/lib/task-tracking');
    const hint = buildConversationTasksHint(
      [
        task({ taskId: 'a', ownerId: REQUESTER, ownerType: 'user' }),
        task({ taskId: 'b', ownerId: OTHER, ownerType: 'user' }),
        task({ taskId: 'c', ownerId: 'AltSlot0', ownerType: 'assistant' }),
      ],
      { id: REQUESTER },
    );
    // A principal id is opaque to the model and useless in a sentence; printing one into a prompt
    // puts an identifier in front of it for no gain.
    expect(hint).not.toContain(REQUESTER);
    expect(hint).not.toContain(OTHER);
    expect(hint).not.toContain('AltSlot0');
    expect(hint).toContain('held by the person you are talking to');
    expect(hint).toContain('held by another participant');
    expect(hint).toContain('held by an assistant');
  });

  it('tells the model that seeing is not advancing', async () => {
    const { buildConversationTasksHint } = await import('../../lambda/src/lib/task-tracking');
    const hint = buildConversationTasksHint([task({ ownerId: OTHER, ownerType: 'user' })], { id: REQUESTER });
    expect(hint).toContain('Only the holder can move one forward');
  });

  it('drops the task this turn is already resuming', async () => {
    const { buildConversationTasksHint } = await import('../../lambda/src/lib/task-tracking');
    // buildTaskContextForPrompt already describes that one in full; listing it twice invites the
    // model to treat it as two.
    expect(buildConversationTasksHint([task({ taskId: 'resuming' })], null, { excludeTaskId: 'resuming' }))
      .toBe('');
  });

  it('is empty when there is nothing open, rather than a section saying so', async () => {
    const { buildConversationTasksHint } = await import('../../lambda/src/lib/task-tracking');
    expect(buildConversationTasksHint([], { id: REQUESTER })).toBe('');
  });
});

describe('reassignment (D1) and its log entry (D3)', () => {
  const existing = {
    taskId: 't-2',
    channelArn: 'arn:chan/c1',
    userArn: `arn:aws:chime:..:app-instance/i/user/${REQUESTER}`,
    userMessage: 'x',
    status: 'in_progress' as const,
    deliveryOption: DeliveryOption.TASK_MULTI_STEP,
    taskType: 'action_item',
    taskState: 'awaiting_completion',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ttl: 1893456000,
    ownerId: REQUESTER,
    ownerType: 'user' as const,
  };

  it('moves the mirror row and leaves nothing behind', async () => {
    mockSend.mockResolvedValueOnce({ Item: existing }); // getTask
    const { reassignTask } = await import('../../lambda/src/lib/task-tracking');
    await reassignTask('t-2', 'arn:chan/c1', { id: OTHER, type: 'user' });

    const mirrorPut = puts('user-tasks-test')[0];
    expect(mirrorPut.input.Item.userSub).toBe(OTHER);
    // The new row is whole - a partial row here is finding 2 in a different disguise.
    expect(mirrorPut.input.Item.ttl).toBe(1893456000);
    expect(mirrorPut.input.Item.taskType).toBe('action_item');
    expect(mirrorPut.input.Item.channelArn).toBe('arn:chan/c1');

    const del = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__t === 'Delete');
    expect(del.input.Key).toEqual({ userSub: REQUESTER, taskId: 't-2' });
  });

  it('logs the change with ownerFrom/ownerTo and NO from/to, and does not touch the machine', async () => {
    mockSend.mockResolvedValueOnce({ Item: existing }); // getTask
    const { reassignTask } = await import('../../lambda/src/lib/task-tracking');
    await reassignTask('t-2', 'arn:chan/c1', { id: OTHER, type: 'user' });

    const update = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c.__t === 'Update' && c.input.TableName === 'tasks-test');
    const entry = update.input.ExpressionAttributeValues[':entry'][0];
    expect(entry.ownerFrom).toBe(`user:${REQUESTER}`);
    expect(entry.ownerTo).toBe(`user:${OTHER}`);
    // A reassignment is not a graph edge. A consumer reading `from` gets nothing rather than a
    // principal id in a field every other reader treats as a state name.
    expect(entry.from).toBeUndefined();
    expect(entry.to).toBeUndefined();
    // And it is not a transition: clearing turnsInState here would erase the stall signal on a task
    // that was handed over but never progressed.
    expect(update.input.UpdateExpression).not.toContain('turnsInState');
    expect(update.input.UpdateExpression).not.toContain('taskState');
  });

  it('is a no-op when the task already has that owner', async () => {
    mockSend.mockResolvedValueOnce({ Item: existing }); // getTask
    const { reassignTask } = await import('../../lambda/src/lib/task-tracking');
    await reassignTask('t-2', 'arn:chan/c1', { id: REQUESTER, type: 'user' });
    expect(mockSend.mock.calls.map((c) => c[0]).filter((c) => c.__t !== 'Get')).toEqual([]);
  });
});
