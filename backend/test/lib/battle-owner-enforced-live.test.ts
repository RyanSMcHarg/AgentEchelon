/**
 * ONLY THE OWNER RESUMES A DUEL — asserted at the seam, with the REAL decision function (tracker 93).
 *
 * The enforcement shipped INERT. `planBattleContinuation` compared the speaker against an owner it
 * read off the battle ROWS, and the rows do not keep one: the terminal write rewrote the whole item,
 * so a duel's owner was erased by its own completion, and a row that never carried it compares against
 * `undefined` — which passes for everyone. Live duels 32 minutes after the deploy read `owner=(none)`
 * while the channel POINTER for those same duels carried the initiator correctly.
 *
 * `battle-state.test.ts` covers the decision in isolation. This file covers the thing that was
 * actually broken: what the FLOW hands it. So `planBattleContinuation` is deliberately NOT mocked —
 * mocking it is how a rewired caller passes a test while resuming for strangers in production.
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
const OWNER_ARN = `${APP}/user/alice`;
const OTHER_ARN = `${APP}/user/bob`;
const OWNER_SUB = 'alice';
const BATTLE_ID = 'battle-owner-1';

const mockResolveActiveBattle = jest.fn();
const mockReadBattleRows = jest.fn();
const mockResumeFromWaiting = jest.fn();

jest.mock('../../lambda/src/lib/battle-state.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/battle-state.js');
  return {
    ...actual,
    // The two DDB reads are stubbed. The DECISION (planBattleContinuation) is the real one.
    resolveActiveBattle: (...a: unknown[]) => mockResolveActiveBattle(...a),
    readBattleRows: (...a: unknown[]) => mockReadBattleRows(...a),
    resumeBotFromWaiting: (...a: unknown[]) => mockResumeFromWaiting(...a),
  };
}, { virtual: true });

const replyFrom = (senderArn: string) => ({
  CallbackId: 'cb-1',
  EventType: 'CHANNEL_MESSAGE',
  ChannelMessage: {
    MessageId: `m-${Math.random().toString(36).slice(2)}`,
    Content: 'the audience is engineering leadership',
    Metadata: undefined,
    Sender: { Arn: senderArn, Name: senderArn.split('/').pop() },
    ChannelArn: CHANNEL,
    Target: [{ MemberArn: BOT_ALT }],
  },
});

const invokes = () => mockLambdaSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'Invoke')
  .map((c) => ({ fn: c.input.FunctionName as string, payload: JSON.parse(Buffer.from(c.input.Payload).toString()) }));

const callbacks = () => mockMessagingSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'Callback');

describe('a duel is resumed by its owner and nobody else', () => {
  let handler: (e: any) => Promise<void>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';
    process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';

    // THE LIVE SHAPE: the owner is on the pointer, and the rows have none.
    mockResolveActiveBattle.mockResolvedValue({ battleId: BATTLE_ID, initiatorUserSub: OWNER_SUB });
    mockReadBattleRows.mockResolvedValue([
      { battleId: BATTLE_ID, botArn: BOT_ALT, state: 'WAITING_FOR_USER', waitingMessageId: 'waiting-msg-1' },
      { battleId: BATTLE_ID, botArn: BOT_DEFAULT, state: 'COMPLETED' },
    ]);
    mockResumeFromWaiting.mockResolvedValue(true);

    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return { MessageId: 'sent-1' };
    });
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT_DEFAULT } });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });

    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  it('resumes the waiting side for the person who started the duel', async () => {
    await handler(replyFrom(OWNER_ARN));

    const turn = invokes().find((i) => i.fn.includes('router'))?.payload?.aeTurn;
    expect(turn?.battleContext?.battleId).toBe(BATTLE_ID);
    expect(turn?.botArn).toBe(BOT_ALT);
    // Their answer is private: denied, so it reaches neither the channel nor Lex.
    expect(callbacks()[0].input.DeleteResource).toBe(true);
  });

  it('resumes NOTHING for another member — the defect this whole row is about', async () => {
    await handler(replyFrom(OTHER_ARN));

    // No side resumed...
    expect(invokes().filter((i) => i.payload?.aeTurn?.battleContext)).toHaveLength(0);
    expect(mockResumeFromWaiting).not.toHaveBeenCalled();
    // ...and their message is NOT swallowed. A non-owner is not refused, they are simply not
    // answering a duel: the message is released and handled as ordinary channel traffic.
    expect(callbacks()[0].input.DeleteResource).toBeFalsy();
  });

  it('falls back to the row owner when the pointer predates the field', async () => {
    mockResolveActiveBattle.mockResolvedValue({ battleId: BATTLE_ID, initiatorUserSub: undefined });
    mockReadBattleRows.mockResolvedValue([
      {
        battleId: BATTLE_ID, botArn: BOT_ALT, state: 'WAITING_FOR_USER',
        waitingMessageId: 'waiting-msg-1', initiatorUserSub: OWNER_SUB,
      },
    ]);

    await handler(replyFrom(OTHER_ARN));
    expect(mockResumeFromWaiting).not.toHaveBeenCalled();
  });

  it('resumes for anyone when NEITHER source knows the owner, rather than stranding the duel', async () => {
    // An in-flight duel that spans the deploy has no recorded owner anywhere. Blocking it would leave
    // a side waiting on a question nobody can answer, which is worse than the openness being closed.
    mockResolveActiveBattle.mockResolvedValue({ battleId: BATTLE_ID, initiatorUserSub: undefined });

    await handler(replyFrom(OTHER_ARN));
    expect(mockResumeFromWaiting).toHaveBeenCalled();
  });
});
