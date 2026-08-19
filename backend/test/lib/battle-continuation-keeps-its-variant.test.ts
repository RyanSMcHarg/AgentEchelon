/**
 * A clarification-resumed battle side keeps its variant (tracker row 59).
 *
 * THE DEFECT THIS PINS. When a side asks a clarifying question and the user answers, the flow used to
 * invoke the async processor DIRECTLY with a payload that carried no `experimentId`, `variantId`,
 * `variantModelKey`, `variantProfile` or `selfDisplayName`. The resumed side therefore answered on the
 * profile's default model instead of its assigned arm, and archived with `experiment_id` NULL -
 * invisible to the battle rollup. The duel looked fine and the experiment was quietly wrong for it.
 *
 * It was the THIRD instance of one bug: round 1 was fixed, then round 2 ("half of every duel was
 * missing from the rollup"), and the continuation was never revisited. So this file asserts the
 * property at the seam rather than at the payload: **the continuation hands the turn to the handler**,
 * which is what makes the variant resolve on the ordinary turn path.
 *
 * The negative half matters as much: it must NOT invoke a processor, and it must NOT decide the
 * delivery option or which task chain to continue.
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
    getActiveTask: (...a: unknown[]) => mockGetActiveTask(...a),
    applyUserResponseToTask: (...a: unknown[]) => mockApplyUserResponseToTask(...a),
  };
}, { virtual: true });

const mockResolveActiveBattle = jest.fn();
const mockReadBattleRows = jest.fn();
const mockPlanContinuation = jest.fn();
const mockResumeFromWaiting = jest.fn();

jest.mock('../../lambda/src/lib/battle-state.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/battle-state.js');
  return {
    ...actual,
    // The continuation resolves the duel AND its owner in one read (the pointer carries both).
    resolveActiveBattle: (...a: unknown[]) => mockResolveActiveBattle(...a),
    readBattleRows: (...a: unknown[]) => mockReadBattleRows(...a),
    planBattleContinuation: (...a: unknown[]) => mockPlanContinuation(...a),
    resumeBotFromWaiting: (...a: unknown[]) => mockResumeFromWaiting(...a),
  };
}, { virtual: true });

/** A user's targeted answer to the bot that asked the clarifying question. */
const continuationEvent = () => ({
  CallbackId: 'cb-1',
  EventType: 'CHANNEL_MESSAGE',
  ChannelMessage: {
    MessageId: `m-${Math.random().toString(36).slice(2)}`,
    Content: 'the audience is engineering leadership',
    Metadata: undefined,
    Sender: { Arn: HUMAN, Name: 'Alice' },
    ChannelArn: CHANNEL,
    Target: [{ MemberArn: BOT_ALT }],
  },
});

const invokes = () => mockLambdaSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'Invoke')
  .map((c) => ({ fn: c.input.FunctionName as string, payload: JSON.parse(Buffer.from(c.input.Payload).toString()) }));

describe('the continuation hands the turn to the handler', () => {
  let handler: (e: any) => Promise<void>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';
    process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
    process.env.ALT_BOT_SLOTS_ROSTER_PARAM = '/agent-echelon/battle/alt-slots';

    mockResolveActiveBattle.mockResolvedValue({ battleId: BATTLE_ID, initiatorUserSub: principalIdOf(HUMAN) });
    mockReadBattleRows.mockResolvedValue([
      { battleId: BATTLE_ID, botArn: BOT_ALT, state: 'WAITING_FOR_USER', waitingMessageId: 'waiting-msg-1' },
      { battleId: BATTLE_ID, botArn: BOT_DEFAULT, state: 'COMPLETED' },
    ]);
    mockPlanContinuation.mockReturnValue({ resumeBotArns: [BOT_ALT] });
    mockResumeFromWaiting.mockResolvedValue(true);

    // Channel classification tag + the classification's own bot.
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return { MessageId: 'sent-1' };
    });
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT_DEFAULT } });
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ messages: [] })),
    });

    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  it('invokes the ROUTER, so the variant resolves on the turn path', async () => {
    await handler(continuationEvent());

    // THE FIX, asserted at the seam. Resolving the variant here instead would put turn logic back in
    // the flow, which is what the ratchet forbids - so "the handler was called" IS the property.
    const routerCalls = invokes().filter((i) => i.fn.includes('router'));
    expect(routerCalls).toHaveLength(1);
    expect(routerCalls[0].payload.aeTurn).toBeTruthy();
  });

  it('invokes NO processor directly', async () => {
    await handler(continuationEvent());

    // The direct worker invoke is what skipped variant resolution entirely.
    expect(invokes().filter((i) => i.fn.includes('processor'))).toHaveLength(0);
  });

  it('answers as the side that asked, not the classification\'s default bot', async () => {
    await handler(continuationEvent());

    const turn = invokes()[0].payload.aeTurn;
    expect(turn.botArn).toBe(BOT_ALT);
    expect(turn.battleContext.selfBotArn).toBe(BOT_ALT);
  });

  it('tells the turn which side of the experiment it is', async () => {
    await handler(continuationEvent());

    // Without altSlotArn the handler cannot tell control from treatment, so the variant it resolves
    // would be arbitrary even though it resolved one - a subtler version of the same defect.
    const turn = invokes()[0].payload.aeTurn;
    expect(turn.battleContext.altSlotArn).toBe(BOT_ALT);
  });

  // ADR-029: the resumed side does NOT answer onto the question message. It names that message so the
  // turn can clear its waiting marker, and posts its own placeholder for the answer like every other
  // turn. Answering onto the old message put the finished answer in the bubble from before the
  // question was asked - up to an hour earlier, above everything sent since.
  it('hands over the question message to UN-MARK, never a placeholder to answer onto', async () => {
    await handler(continuationEvent());

    const turn = invokes()[0].payload.aeTurn;
    expect(turn.battleContext.clearWaitingMarkerMessageId).toBe('waiting-msg-1');

    // The distinction is the point: a handed placeholder id is what this decision removed, and it is
    // the last one in the codebase. If it comes back, resolution has two sources again (ADR-022 §4).
    expect(turn.placeholderMessageId).toBeUndefined();

    // The flow still posts nothing itself: the turn posts its own acknowledgment (ADR-025).
    const posts = mockMessagingSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c?.__type === 'SendMessage');
    expect(posts).toHaveLength(0);
  });

  it('decides NO delivery option and NO task chain', async () => {
    await handler(continuationEvent());

    // Both were the flow answering turn questions. `planBattleResume` chose the delivery option and an
    // owner lookup chose the chain; the handler now does both.
    const turn = invokes()[0].payload.aeTurn;
    expect(turn.deliveryOption).toBeUndefined();
    expect(turn.taskId).toBeUndefined();
    expect(turn.taskType).toBeUndefined();
    expect(turn.intent).toBeUndefined();
  });

  it('DENIES the user answer, so the private Q and A never reaches the channel or Lex', async () => {
    await handler(continuationEvent());

    // Unchanged by this rework, and asserted because it is the one place a user message is dropped:
    // denial is also what stops Chime routing the targeted reply to Lex as a second responder.
    const callbacks = mockMessagingSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c?.__type === 'Callback');
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].input.DeleteResource).toBe(true);
  });
});

/**
 * The handler half: a duel side's chain is owned by the ASSISTANT, not the person.
 *
 * This is the riskiest line of the whole change, because it sits on the task-resolution path EVERY
 * turn takes. Under ADR-024 the mirror is partitioned by owner, and a battle side's task is owned by
 * the bot - so `getActiveTask(userSub, ...)` would search the human's tasks, find nothing, and a
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
        selfBotArn: BOT_DEFAULT, rivalBotArn: BOT_ALT, altSlotArn: BOT_ALT,
      },
    },
  });

  it('asks the OWNER lookup, keyed on the bot answering the turn', async () => {
    await routerHandler(battleTurn());

    expect(mockGetActiveTaskForOwner).toHaveBeenCalled();
    const [ownerId, channel] = mockGetActiveTaskForOwner.mock.calls[0];
    // The bot's principal id, not the human's sub.
    expect(ownerId).toBe(BOT_DEFAULT.split('/').pop());
    expect(ownerId).not.toBe(HUMAN.split('/').pop());
    expect(channel).toBe(CHANNEL);
  });

  it('does NOT fall back to the per-user task scan on a battle turn', async () => {
    await routerHandler(battleTurn());

    // The userSub loop is the ordinary path's lookup. Running it here would search the wrong owner and
    // could attach the duel to a person's unrelated task.
    expect(mockGetActiveTask).not.toHaveBeenCalled();
  });

  it('does NOT annex an ordinary message into a chain that is not blocked on a person', async () => {
    // THE HAZARD THIS GUARDS, unchanged: someone speaking in a channel where a duel side owns work
    // must not have their message swallowed into that work.
    //
    // What changed is the mechanism, not the rule. The assistant's own chain IS now consulted on an
    // ordinary turn - that is how a person's private answer resumes the side that asked, since the
    // channel flow never sees the `Target` that used to route it (tracker row 94). The licence is
    // narrow: the chain must be in a state the machine declares `awaitsUser`. This one is mid-flight,
    // so the message stays an ordinary turn.
    // Owner-aware, because the mirror is partitioned by owner: the PERSON owes nothing here, and the
    // chain in flight belongs to the assistant. A blanket mock would answer both lookups and the
    // person's own branch would claim the message before this one was reached.
    mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
      ownerId === principalIdOf(BOT_DEFAULT)
        ? { taskId: 't-mid-flight', taskType: 'report_generation', taskState: 'drafting', channelArn: CHANNEL }
        : null);

    await routerHandler({
      aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'unrelated: what is our leave policy?' },
    });

    expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
  });

  it('resumes the assistant\'s own chain when it IS blocked on a person', async () => {
    // The positive half, so the guard above cannot be satisfied by the branch never running at all.
    mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
      ownerId === principalIdOf(BOT_DEFAULT)
        ? { taskId: 't-waiting', taskType: 'report_generation', taskState: 'collecting_requirements', channelArn: CHANNEL }
        : null);

    await routerHandler({
      aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'audience is engineering leadership' },
    });

    expect(mockApplyUserResponseToTask).toHaveBeenCalled();
    expect(mockApplyUserResponseToTask.mock.calls[0][0].taskId).toBe('t-waiting');
  });

  it('asks what the PERSON owes before what the assistant holds', async () => {
    // The ordering half of the same rule. A task in an `awaitsUser` state is held by the person, and
    // their message is the response to it, so that lookup comes first and the assistant's own chain is
    // only consulted when it finds nothing. Asking the bot first would let a duel side's work claim a
    // message that answers the person's own outstanding item.
    mockGetActiveTaskForOwner.mockResolvedValue(null);

    await routerHandler({
      aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'compile a one-page overview' },
    });

    const ownersAsked = mockGetActiveTaskForOwner.mock.calls.map((c) => c[0]);
    expect(ownersAsked[0]).toBe(principalIdOf(HUMAN));
    expect(mockGetActiveTask).toHaveBeenCalled();
  });
});
