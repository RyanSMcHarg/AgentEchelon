/**
 * A resumed battle side's HANDED-BACK placeholder reaches the channel.
 *
 * THE DEFECT THIS PINS. The router contract is that a turn posts its own acknowledgment and returns an
 * empty `messages` array, and that when its own SendChannelMessage cannot run (no resolved identity, or
 * an Amazon Chime SDK throttle) it hands the unposted placeholder BACK for the caller to post. `@all`
 * and the round-1 battle fan-out honour that; the battle CONTINUATION discarded the response entirely.
 *
 * What that costs, in order: no placeholder is posted, so no `corr -> MessageId` mapping is ever
 * claimed by the duplicate-placeholder guard, so the worker's placeholder scan finds nothing and the
 * resumed side's answer cannot be delivered. The side's waiting marker is cleared by then, so the
 * person is shown neither a question nor an answer.
 *
 * The assertions are on the CHANNEL and on the MAPPING, not on which helper ran: the property is that
 * the turn's own text lands in the channel and is what claims the correlation.
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

// Both claims are real DynamoDB writes. Mocked so the continuation runs at all, and so the placeholder
// claim can be OBSERVED when the posted message re-enters the flow - the un-mocked calls fail on
// credentials and hide the behaviour under test.
const mockClaimPlaceholderMapping = jest.fn();
const mockClaimCorrelation = jest.fn();
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  claimPlaceholderMapping: (corr: string, messageId: string) => mockClaimPlaceholderMapping(corr, messageId),
  claimCorrelation: (key: string) => mockClaimCorrelation(key),
  // The flow's third import from this module. The mock replaces the WHOLE module, so an absent export
  // is a load-time failure rather than a quiet no-op.
  evaluateAbuseGate: jest.fn().mockResolvedValue({ allowed: true }),
}), { virtual: true });

const mockResolveActiveBattle = jest.fn();
const mockReadBattleRows = jest.fn();
const mockPlanContinuation = jest.fn();
const mockResumeFromWaiting = jest.fn();

jest.mock('../../lambda/src/lib/battle-state.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/battle-state.js');
  return {
    ...actual,
    resolveActiveBattle: (...a: unknown[]) => mockResolveActiveBattle(...a),
    readBattleRows: (...a: unknown[]) => mockReadBattleRows(...a),
    planBattleContinuation: (...a: unknown[]) => mockPlanContinuation(...a),
    resumeBotFromWaiting: (...a: unknown[]) => mockResumeFromWaiting(...a),
  };
}, { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_DEFAULT = `${APP}/bot/premium-bot`;
const BOT_ALT = `${APP}/bot/AltSlot0`;
const HUMAN = `${APP}/user/alice`;
const BATTLE_ID = 'battle-xyz';
const principalIdOf = (arn: string) => arn.split('/').pop() || arn;

/** The correlation id the resumed turn minted, as it travels inside the placeholder's own text. */
const CORR = 'battle-r1c-AltSlot0-1755000000000-ab12cd';
const HANDED_BACK = `Working on it... <!--corr:${CORR}-->`;
/** The id Amazon Chime SDK assigns to the placeholder the flow posts on the side's behalf. */
const POSTED_MESSAGE_ID = 'placeholder-msg-1';

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

/** The placeholder re-entering the flow, exactly as Amazon Chime SDK delivers a bot message. */
const postedBotMessageEvent = (content: string, messageId = POSTED_MESSAGE_ID) => ({
  CallbackId: 'cb-2',
  EventType: 'CHANNEL_MESSAGE',
  ChannelMessage: {
    MessageId: messageId,
    Content: content,
    Metadata: JSON.stringify({ botResponse: true }),
    Sender: { Arn: BOT_ALT, Name: 'Assistant-alt' },
    ChannelArn: CHANNEL,
  },
});

/** Every SendChannelMessage the flow issued, as {content, bearer, targets}. */
const posts = () => mockMessagingSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'SendMessage')
  .map((c) => ({
    content: c.input.Content as string,
    bearer: c.input.ChimeBearer as string,
    targets: (c.input.Target as Array<{ MemberArn: string }> | undefined)?.map((t) => t.MemberArn),
  }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: (e: any) => Promise<void>;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();

  process.env.ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';
  process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
  process.env.ALT_BOT_SLOTS_ROSTER_PARAM = '/agent-echelon/battle/alt-slots';
  // No pool wired, so clearance resolution short-circuits to the fail-closed floor instead of reaching
  // for Cognito. The abuse gate itself is mocked; this keeps the lookup in front of it offline too.
  delete process.env.USER_POOL_ID;

  mockClaimCorrelation.mockResolvedValue(true);
  // "you own the correlation" - the ordinary, non-duplicate case.
  mockClaimPlaceholderMapping.mockImplementation(async (_corr: string, messageId: string) => messageId);

  mockResolveActiveBattle.mockResolvedValue({ battleId: BATTLE_ID, initiatorUserSub: principalIdOf(HUMAN) });
  mockReadBattleRows.mockResolvedValue([
    { battleId: BATTLE_ID, botArn: BOT_ALT, state: 'WAITING_FOR_USER', waitingMessageId: 'waiting-msg-1' },
    { battleId: BATTLE_ID, botArn: BOT_DEFAULT, state: 'COMPLETED' },
  ]);
  mockPlanContinuation.mockReturnValue({ resumeBotArns: [BOT_ALT] });
  mockResumeFromWaiting.mockResolvedValue(true);

  mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT_DEFAULT } });
  mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
    if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
    return { MessageId: POSTED_MESSAGE_ID };
  });

  // THE CASE UNDER TEST: the resumed turn could not post its own placeholder and handed it back.
  mockLambdaSend.mockResolvedValue({
    Payload: Buffer.from(JSON.stringify({
      sessionState: { dialogAction: { type: 'Close' }, intent: { name: 'FallbackIntent', state: 'Fulfilled' } },
      messages: [{ contentType: 'PlainText', content: HANDED_BACK }],
    })),
  });

  ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
});

describe('a continuation posts the placeholder the resumed turn handed back', () => {
  it('posts the TURN\'S text, so the side is not left with no placeholder at all', async () => {
    await handler(continuationEvent());

    expect(posts().map((p) => p.content)).toEqual([HANDED_BACK]);
  });

  it('posts it as the side that was resumed, and broadcast', async () => {
    // The resumed answer rejoins the VISIBLE battle: round 2 and the scorecard need both sides'
    // answers in the channel, so only the clarifying question was a private side-channel.
    await handler(continuationEvent());

    expect(posts()[0].bearer).toBe(BOT_ALT);
    expect(posts()[0].targets).toBeUndefined();
  });

  it('carries the turn\'s correlation marker, so the mapping is claimed when it re-enters the flow', async () => {
    // THE CONSEQUENCE, asserted end to end. The `corr -> MessageId` mapping is what the worker resolves
    // the placeholder by, and the only thing that writes it is the duplicate-placeholder guard seeing
    // this message come back. No post, no mapping, and the answer has nowhere to land.
    await handler(continuationEvent());

    const posted = posts()[0].content;
    await handler(postedBotMessageEvent(posted));

    expect(mockClaimPlaceholderMapping).toHaveBeenCalledWith(CORR, POSTED_MESSAGE_ID);
  });

  it('composes NOTHING of its own: the text posted is the turn\'s, marker and all', async () => {
    // Composing a message here would mint a placeholder carrying no correlation id the worker is
    // listening for - a bubble that can never be updated.
    await handler(continuationEvent());

    expect(posts()[0].content).toContain(`<!--corr:${CORR}-->`);
  });
});

describe('a continuation posts nothing when the turn already spoke', () => {
  it('posts nothing on an empty messages array', async () => {
    // The NORMAL outcome (ADR-025): the resumed side posted its own placeholder. An empty array means
    // POST NOTHING (ADR-022), and it also covers a silent turn that lost its correlation claim.
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({
        sessionState: { dialogAction: { type: 'Close' }, intent: { name: 'FallbackIntent', state: 'Fulfilled' } },
        messages: [],
      })),
    });

    await handler(continuationEvent());

    expect(posts()).toEqual([]);
  });

  it('posts nothing when the turn invoke FAILED', async () => {
    // A handler that threw returns HTTP 200 with an error payload. Posting that unchecked would put a
    // stack trace in the channel as the answer.
    mockLambdaSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify({ errorMessage: 'boom', errorType: 'Error' })),
    });

    await handler(continuationEvent());

    expect(posts()).toEqual([]);
  });
});

describe('one side\'s failed post does not take the duel down', () => {
  it('still posts for the sibling side, and the flow settles', async () => {
    // Both sides asked a clarifying question and both are resumed by one answer. A throttled send for
    // the first must not reject the fan-out and strand the second.
    mockReadBattleRows.mockResolvedValue([
      { battleId: BATTLE_ID, botArn: BOT_ALT, state: 'WAITING_FOR_USER', waitingMessageId: 'waiting-alt' },
      { battleId: BATTLE_ID, botArn: BOT_DEFAULT, state: 'WAITING_FOR_USER', waitingMessageId: 'waiting-default' },
    ]);
    mockPlanContinuation.mockReturnValue({ resumeBotArns: [BOT_ALT, BOT_DEFAULT] });

    let sendAttempts = 0;
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      if (cmd?.__type === 'SendMessage') {
        sendAttempts += 1;
        if (sendAttempts === 1) throw new Error('Throttled');
        return { MessageId: POSTED_MESSAGE_ID };
      }
      return { MessageId: POSTED_MESSAGE_ID };
    });

    await expect(handler(continuationEvent())).resolves.toBeUndefined();

    // Both sides were attempted, and the failure is a warning rather than a rejection.
    expect(posts().map((p) => p.bearer).sort()).toEqual([BOT_ALT, BOT_DEFAULT].sort());
  });
});
