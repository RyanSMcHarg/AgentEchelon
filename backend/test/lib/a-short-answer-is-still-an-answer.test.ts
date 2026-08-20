/**
 * A ONE-WORD ANSWER STILL RESUMES WHATEVER IS WAITING ON THE PERSON.
 *
 * "ok" is two characters and "thanks" is an exact token, so `fastPathIntent` settles both without a
 * model: GREETING and ACKNOWLEDGMENT. That label is right about the words and wrong about the turn
 * whenever an assistant has just asked the person a question, because that is how people answer one.
 *
 * The label used to decide, on its own, whether the router looked for waiting work at all - so a
 * person who answered a clarifying question with "ok" got a canned quick reply, the response was never
 * applied to the task, the duel side stayed in `WAITING_FOR_USER`, and the chain sat there until the
 * deadline reported an assistant that had in fact been answered as never having finished. A declared
 * battle context did not rescue it either: a flow-callback turn carries none.
 *
 * So the fast path is now a statement about the PERSON'S QUEUE and not about the message: it applies
 * when nothing is waiting on them. The negative half is load-bearing in the other direction - a bare
 * "thanks" with nothing open must still cost no model call and no requester-keyed lookups.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  UpdateChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
/** The assistant the message reaches: this classification's own bot. */
const BOT_SELF = `${APP}/bot/premium-bot`;
/** A sanctioned alt slot, so it can own a chain and be handed one. */
const BOT_OTHER = `${APP}/bot/AltSlot0`;
const HUMAN = `${APP}/user/alice`;
const principalIdOf = (arn: string) => arn.split('/').pop() || arn;

const ROSTER_PARAM = '/agent-echelon/alt-bot-slots/roster';
const SELF_FUNCTION = 'AgentEchelonClassification-Premium-AgentHandler';

/** What the deployment answers a bare acknowledgement with, when nothing is waiting. */
const CANNED_ACKNOWLEDGEMENT = 'Let me know if you have other questions.';

const mockGetActiveTaskForOwner = jest.fn();
const mockGetActiveTasksForOwnerInChannel = jest.fn();
const mockGetActiveTask = jest.fn();
const mockApplyUserResponseToTask = jest.fn();

jest.mock('../../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getActiveTaskForOwner: (...a: unknown[]) => mockGetActiveTaskForOwner(...a),
    // The router reads the person's held list ONCE per turn and answers every question about their
    // queue from it. A test that models one held chain sets the singular mock; the list wraps it.
    getActiveTasksForOwnerInChannel: async (...a: unknown[]) => {
      const list = await mockGetActiveTasksForOwnerInChannel(...a);
      if (list !== undefined) return list;
      const t = await mockGetActiveTaskForOwner(...a);
      return t ? [t] : [];
    },
    // The same one query, in the shape the router reads it: live work plus anything that ended here
    // recently. These tests model no finished work, so the second list is always empty.
    getOwnerChannelTasks: async (...a: unknown[]) => {
      const list = await mockGetActiveTasksForOwnerInChannel(...a);
      if (list !== undefined) return { live: list, recentlyEnded: [] };
      const t = await mockGetActiveTaskForOwner(...a);
      return { live: t ? [t] : [], recentlyEnded: [] };
    },
    getActiveTask: (...a: unknown[]) => mockGetActiveTask(...a),
    applyUserResponseToTask: (...a: unknown[]) => mockApplyUserResponseToTask(...a),
  };
}, { virtual: true });

const mockResolveActiveBattle = jest.fn();
const mockReadBattleRows = jest.fn();
const mockResumeFromWaiting = jest.fn();

jest.mock('../../lambda/src/lib/battle-state.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/battle-state.js');
  return {
    ...actual,
    resolveActiveBattle: (...a: unknown[]) => mockResolveActiveBattle(...a),
    readBattleRows: (...a: unknown[]) => mockReadBattleRows(...a),
    resumeBotFromWaiting: (...a: unknown[]) => mockResumeFromWaiting(...a),
  };
}, { virtual: true });

/** Every Lambda invoke this turn made, with its payload decoded. */
const invokes = () => mockLambdaSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'Invoke')
  .map((c) => JSON.parse(Buffer.from(c.input.Payload).toString()));

/** The async processor dispatch, or undefined when the turn dispatched no work. */
const worker = () => invokes().find((p) => !p?.aeTurn);

/** The turn handed to another assistant, or undefined when nothing was handed over. */
const handover = () => invokes().find((p) => p?.aeTurn?.handedOverFrom)?.aeTurn;

/** Everything this turn posted to the channel. */
const posts = () => mockMessagingSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'SendMessage')
  .map((c) => c.input as { Content: string; Target?: Array<{ MemberArn: string }> });

/** A chain the PERSON holds, blocked on them, belonging to `assistantId`. */
const heldTask = (assistantId: string, taskId = 't-waiting') => ({
  taskId,
  taskType: 'report_generation',
  taskState: 'collecting_requirements',
  channelArn: CHANNEL,
  status: 'in_progress',
  userSub: principalIdOf(HUMAN),
  assistantId,
});

/** The person speaks in the channel, addressing nobody. */
const turn = (userMessage: string) => ({
  aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage, userMessageId: 'm-1' },
});

/**
 * THE ENVIRONMENT THIS FILE RUNS THE ROUTER IN, DECLARED RATHER THAN INHERITED. `undefined` means
 * "unset for this file", which is as much a dependency as a value is.
 */
const ROUTER_ENV: Record<string, string | undefined> = {
  AWS_LAMBDA_FUNCTION_NAME: SELF_FUNCTION,
  ALT_BOT_SLOTS_ROSTER_PARAM: ROSTER_PARAM,
  // No dedup table, so every claim in the turn fails open and none of these assertions depends on
  // one. Cleared rather than assumed absent: the table name is read at import time, and an ambient
  // value would otherwise put a real DynamoDB call on this turn's path.
  ABUSE_CONTROLS_TABLE: undefined,
  // Off, because the data plane adds Lambda invokes to the turn: drift detection, retrieval and the
  // running summary each issue one, and `worker()` below reads the turn's invokes to find the
  // dispatch. With drift on, it finds a data-plane call and reports it as the worker.
  ENABLE_LIVE_DRIFT: undefined,
};

const applyEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

describe('a short message is read as an answer when something is waiting on the person', () => {
  let routerHandler: (e: any) => Promise<any>;
  /** What the environment held before this file touched it, put back when the file is done. */
  const envBefore: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of Object.keys(ROUTER_ENV)) envBefore[key] = process.env[key];
  });

  afterAll(() => applyEnv(envBefore));

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    applyEnv(ROUTER_ENV);

    mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) =>
      cmd?.input?.Name === ROSTER_PARAM
        ? { Parameter: { Value: JSON.stringify([{ slotId: 'AltSlot0', botArn: BOT_OTHER }]) } }
        : { Parameter: { Value: BOT_SELF } });

    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return { MessageId: 'sent-1' };
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });

    mockResolveActiveBattle.mockResolvedValue(null);
    mockReadBattleRows.mockResolvedValue([]);
    mockResumeFromWaiting.mockResolvedValue(false);
    mockGetActiveTaskForOwner.mockResolvedValue(null);
    mockGetActiveTasksForOwnerInChannel.mockResolvedValue(undefined);
    mockGetActiveTask.mockResolvedValue(null);
    mockApplyUserResponseToTask.mockResolvedValue({ applied: true });

    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  describe('answering this assistant\'s own waiting chain', () => {
    beforeEach(() => {
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_SELF)) : null);
    });

    it('applies "ok" to the task that was waiting on them', async () => {
      await routerHandler(turn('ok'));

      // The chain asked a question and this is the answer to it. Skipped, the task stays in the state
      // it was in and the workflow never moves - while the person is told their answer was received.
      expect(mockApplyUserResponseToTask).toHaveBeenCalledTimes(1);
      expect(mockApplyUserResponseToTask.mock.calls[0][0].taskId).toBe('t-waiting');
    });

    it('runs the turn instead of returning the canned acknowledgement', async () => {
      await routerHandler(turn('thanks'));

      // The quick reply ends the turn: no worker, so nothing acts on the answer just applied. The
      // person sees a plausible sentence and the chain goes quiet.
      const dispatched = worker();
      expect(dispatched).toBeTruthy();
      expect(dispatched.taskId).toBe('t-waiting');
      expect(dispatched.isTaskContinuation).toBe(true);
      expect(posts().map((p) => p.Content).join(' ')).not.toContain(CANNED_ACKNOWLEDGEMENT);
    });

    it('is attributed as a continuation, not as a pleasantry', async () => {
      await routerHandler(turn('ok'));

      // One correction, where the work is found. The intent rides the exchange into the analytics
      // record, so leaving it GREETING files a task step under the label used to exclude trivia.
      expect(worker()?.intent).not.toBe('greeting');
      expect(worker()?.intent).not.toBe('acknowledgment');
    });
  });

  describe('answering a chain a DIFFERENT assistant owns', () => {
    it('hands "ok" to the assistant whose question it answers', async () => {
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_OTHER)) : null);

      await routerHandler(turn('ok'));

      // Routing follows the task on a two-character message exactly as it does on a paragraph. The
      // quick reply answered here would leave the owning assistant's chain blocked forever.
      expect(handover()?.botArn).toBe(BOT_OTHER);
      expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
    });
  });

  describe('answering a duel side that is waiting with no task row yet', () => {
    beforeEach(() => {
      // A round-1 clarification asked before any chain exists: the wait lives on the battle row alone,
      // so no task lookup can find it and only the taskless resume reaches it.
      mockResolveActiveBattle.mockResolvedValue({ battleId: 'b-1', initiatorUserSub: principalIdOf(HUMAN) });
      mockReadBattleRows.mockResolvedValue([
        { battleId: 'b-1', botArn: BOT_SELF, state: 'WAITING_FOR_USER' },
        { battleId: 'b-1', botArn: BOT_OTHER, state: 'WAITING_FOR_USER' },
      ]);
      mockResumeFromWaiting.mockResolvedValue(true);
    });

    it('takes this side out of WAITING_FOR_USER on a two-character answer', async () => {
      await routerHandler(turn('ok'));

      // Measured shape of the stall: the side stays WAITING_FOR_USER, round 2 stays suspended, and the
      // duel closes reporting a side that answered instantly as never having finished.
      expect(mockResumeFromWaiting).toHaveBeenCalledTimes(1);
      expect(mockResumeFromWaiting.mock.calls[0][0]).toEqual({ battleId: 'b-1', botArn: BOT_SELF });
    });

    it('dispatches the resumed side rather than answering it from the handler', async () => {
      await routerHandler(turn('ok'));

      // DIRECT dispatches no worker, so a resumed side that took it would never reach a terminal
      // battle state however promptly it was resumed.
      expect(worker()).toBeTruthy();
      expect(posts().map((p) => p.Content).join(' ')).not.toContain(CANNED_ACKNOWLEDGEMENT);
    });
  });

  // HOLDING WORK IS NOT THE SAME AS OWING AN ANSWER. The person can hold a task whose CURRENT state
  // awaits nobody - `applyUserResponseToTask` refuses it with `not_awaiting` and hands nothing back -
  // so a "thanks" arriving there resumed nothing. Counting it as a continuation anyway suppresses the
  // canned reply and spends a full worker turn at the classification floor, because the model tier
  // now reads the same continuation fact.
  describe('when the person holds work that is not waiting on them', () => {
    beforeEach(() => {
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_SELF)) : null);
      mockApplyUserResponseToTask.mockResolvedValue({ applied: false, reason: 'not_awaiting', from: 'collecting' });
    });

    it('answers "thanks" from the fast path instead of resuming nothing', async () => {
      await routerHandler(turn('thanks'));

      expect(worker()).toBeUndefined();
      expect(posts().map((p) => p.Content).join(' ')).toContain('Happy to help');
    });

    // The one-answer path refuses to ADVANCE and still hands the work back, so it IS a continuation.
    // Same shape of refusal, opposite meaning: the distinction is what the reason names.
    it('still resumes when the refusal is `deferred_to_model`', async () => {
      mockApplyUserResponseToTask.mockResolvedValue({ applied: false, reason: 'deferred_to_model', from: 'confirming' });

      await routerHandler(turn('ok'));

      expect(worker()).toBeTruthy();
      expect(worker()?.isTaskContinuation).toBe(true);
    });
  });

  describe('when nothing is waiting on the person', () => {
    it('answers "thanks" from the fast path, with no model call and no dispatch', async () => {
      await routerHandler(turn('thanks'));

      // The other direction, and it is the reason the fast path exists: a pleasantry costs one queue
      // read and nothing else.
      expect(worker()).toBeUndefined();
      expect(posts().map((p) => p.Content).join(' ')).toContain('Happy to help');
      expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
    });

    it('does not go looking for work the person merely opened', async () => {
      await routerHandler(turn('ok'));

      // The requester-keyed fallback asks what this person has OPEN, not what is blocked on them, and
      // costs a read per declared task type. A bare "ok" absorbed by one of those is a message annexed
      // by work it was not about.
      expect(mockGetActiveTask).not.toHaveBeenCalled();
    });
  });
});
