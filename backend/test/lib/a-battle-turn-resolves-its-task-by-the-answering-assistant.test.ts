/**
 * A battle turn resolves its task by the ANSWERING ASSISTANT, and a person's answer resumes the side that asked.
 *
 * A reply to a duel side that asked a clarifying question reaches that side's Lex as an ordinary turn:
 * the channel flow callback carries no `Target`, so the flow cannot recognize it (ADR-029, ADR-030).
 * The handler is therefore the whole continuation mechanism, and this file pins the task-resolution
 * half of it.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
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
  // The assignment records the router resolves the turn's assistant from.
  GetParametersByPathCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetByPath', input: args })),
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_DEFAULT = `${APP}/bot/premium-bot`;
const BOT_ALT = `${APP}/bot/AltSlot0`;
/** The principal id the owner lookup keys on: the ARN's last segment. */
const principalIdOf = (arn: string) => arn.split('/').pop() || arn;
const HUMAN = `${APP}/user/alice`;
const BATTLE_ID = 'battle-xyz';

const mockGetActiveTaskForOwner = jest.fn();
const mockGetActiveTask = jest.fn();
const mockApplyUserResponseToTask = jest.fn();

jest.mock('../../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getActiveTaskForOwner: (...a: unknown[]) => mockGetActiveTaskForOwner(...a),
    // The router fetches the person's held LIST once per turn; these tests model at most one held
    // task, so the list wraps the singular mock and every call-order assertion keeps observing it.
    getActiveTasksForOwnerInChannel: async (...a: unknown[]) => {
      const t = await mockGetActiveTaskForOwner(...a);
      return t ? [t] : [];
    },
    // The same one query, in the shape the router reads it: live work plus anything that ended here
    // recently. These tests model no finished work, so the second list is always empty.
    getAssigneeChannelTasks: async (...a: unknown[]) => {
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

/**
 * A duel side's chain is owned by the ASSISTANT, not the person.
 *
 * This is the riskiest line of the whole change, because it sits on the task-resolution path EVERY
 * turn takes. Under ADR-024 the mirror is partitioned by owner, and a battle side's task is owned by
 * the bot - so `getActiveTask(personId, ...)` would search the human's tasks, find nothing, and a
 * resumed side would silently start a NEW chain instead of continuing its own. Nothing visible breaks;
 * the duel just answers from the wrong state.
 *
 * Written after a mutation survived: swapping the owner to the human passed every other test in the
 * repo.
 */
describe('a battle turn resolves its task by the ANSWERING ASSISTANT', () => {
  let routerHandler: (e: any) => Promise<unknown>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    // THE ROUTER IS DEPLOYED AS A CLASSIFICATION; a handler with none declines the turn (ADR-046).
    process.env.CLASSIFICATION = 'premium';
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT_DEFAULT } });
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return { MessageId: 'sent-1' };
    });
    mockGetActiveTaskForOwner.mockResolvedValue(null);
    mockGetActiveTask.mockResolvedValue(null);
    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  const battleTurn = () => ({
    aeTurn: {
      channelArn: CHANNEL,
      senderArn: HUMAN,
      userMessage: 'compile a one-page overview of the product',
      botArn: BOT_DEFAULT,
      correlationId: 'battle-r1c-x',
      placeholderMessageId: 'waiting-msg-1',
      battleContext: {
        battleId: BATTLE_ID, round: 1, totalRounds: 2,
        selfBotArn: BOT_DEFAULT, rivalBotArn: BOT_ALT,
      },
    },
  });

  it('asks the OWNER lookup, keyed on the bot answering the turn', async () => {
    await routerHandler(battleTurn());

    expect(mockGetActiveTaskForOwner).toHaveBeenCalled();
    const [assigneeId, channel] = mockGetActiveTaskForOwner.mock.calls[0];
    // The bot's principal id, not the human's sub.
    expect(assigneeId).toBe(BOT_DEFAULT.split('/').pop());
    expect(assigneeId).not.toBe(HUMAN.split('/').pop());
    expect(channel).toBe(CHANNEL);
  });

  it('does NOT fall back to the per-user task scan on a battle turn', async () => {
    await routerHandler(battleTurn());

    // The personId loop is the ordinary path's lookup. Running it here would search the wrong owner and
    // could attach the duel to a person's unrelated task.
    expect(mockGetActiveTask).not.toHaveBeenCalled();
  });

  it('does NOT annex an ordinary message into a chain that is not blocked on a person', async () => {
    // THE HAZARD THIS GUARDS, unchanged: someone speaking in a channel where a duel side owns work
    // must not have their message swallowed into that work.
    //
    // What changed is the mechanism, not the rule. The assistant's own chain IS now consulted on an
    // ordinary turn - that is how a person's private answer resumes the side that asked, since the
    // channel flow never sees the `Target` that used to route it. The license is
    // narrow: the chain must be in a state the machine declares `awaits` on. This one is mid-flight,
    // so the message stays an ordinary turn.
    // Owner-aware, because the mirror is partitioned by owner: the PERSON owes nothing here, and the
    // chain in flight belongs to the assistant. A blanket mock would answer both lookups and the
    // person's own branch would claim the message before this one was reached.
    mockGetActiveTaskForOwner.mockImplementation(async (assigneeId: string) =>
      assigneeId === principalIdOf(BOT_DEFAULT)
        ? { taskId: 't-mid-flight', taskType: 'report_generation', taskState: 'drafting', channelArn: CHANNEL }
        : null);

    await routerHandler({
      aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'unrelated: what is our leave policy?' },
    });

    expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
  });

  it('resumes the assistant\'s own chain when it IS blocked on a person', async () => {
    // The positive half, so the guard above cannot be satisfied by the branch never running at all.
    mockGetActiveTaskForOwner.mockImplementation(async (assigneeId: string) =>
      assigneeId === principalIdOf(BOT_DEFAULT)
        ? { taskId: 't-waiting', taskType: 'report_generation', taskState: 'collecting_requirements', channelArn: CHANNEL }
        : null);

    await routerHandler({
      aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'audience is engineering leadership' },
    });

    expect(mockApplyUserResponseToTask).toHaveBeenCalled();
    expect(mockApplyUserResponseToTask.mock.calls[0][0].taskId).toBe('t-waiting');
  });

  it('asks what the PERSON owes before what the assistant holds', async () => {
    // The ordering half of the same rule. A task in an `awaits` state is held by the person, and
    // their message is the response to it, so that lookup comes first and the assistant's own chain is
    // only consulted when it finds nothing. Asking the bot first would let a duel side's work claim a
    // message that answers the person's own outstanding item.
    mockGetActiveTaskForOwner.mockResolvedValue(null);

    await routerHandler({
      aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'compile a one-page overview' },
    });

    const ownersAsked = mockGetActiveTaskForOwner.mock.calls.map((c) => c[0]);
    expect(ownersAsked[0]).toBe(principalIdOf(HUMAN));
    // NON-VACUITY: the assistant's partition IS consulted, second. Without this the ordering
    // assertion above would pass on a turn that asked one owner and stopped. This used to be pinned
    // on the per-type fallback running afterwards, which is no longer a fact about a channel turn -
    // it repeated the person read this turn had already made (`one-read-answers-the-owner-partition`).
    expect(ownersAsked).toEqual([principalIdOf(HUMAN), principalIdOf(BOT_DEFAULT)]);
  });
});

afterAll(() => { delete process.env.CLASSIFICATION; });
