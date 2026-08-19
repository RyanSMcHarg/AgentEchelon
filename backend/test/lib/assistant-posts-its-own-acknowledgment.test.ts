/**
 * The assistant posts its own acknowledgment on a bypass (ADR-025).
 *
 * THE PROPERTY. The turn resolves what the acknowledgment SAYS from its profile version
 * (`getQuickResponse` / `getTaskPlaceholder`), so the turn is what should say it. Before this the
 * words were authored in the handler and the ACT was performed elsewhere - by Amazon Chime SDK on the
 * Lex path, by the channel flow on a bypass - which is one profile-resolved behaviour reaching the
 * channel by two routes.
 *
 * WHAT IS NOT CLAIMED, and is asserted here so it is not re-argued as a cleanup: this buys nothing for
 * placeholder resolution. The flow still claims `corr# -> MessageId` and the processor still reads it.
 * The case is ownership.
 *
 * The Lex path must be UNCHANGED - it has no other way to produce a message than the fulfillment
 * return - so the first block is as load-bearing as the second.
 */

const mockChimeSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockChimeSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
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

// Stub only the billed model call, exactly as `all-mention-single-path.test.ts` does. Replacing the
// whole module makes `IntentType` undefined, every turn dies in the catch-all, and the assertions
// below pass on the ERROR path while proving nothing.
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: jest.fn(async (msg: string) =>
      actual.fastPathIntent(msg) ?? { intent: 'general', confidence: 'high' }),
  };
}, { virtual: true });

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/basic-bot';
const HUMAN = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/alice';

/** Every SendChannelMessage the turn made. */
const sends = () => mockChimeSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'SendMessage')
  .map((c) => c.input);

describe('a bypass turn posts its own message', () => {
  let handler: (e: any) => Promise<{ messages?: { content: string }[] }>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT } });
    mockChimeSend.mockResolvedValue({ MessageId: 'posted-1' });
    ({ handler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  const bypass = (userMessage: string) => ({
    aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage },
  });

  it('sends the acknowledgment itself, as its own bot', async () => {
    await handler(bypass('what is the billing policy?'));

    const posted = sends();
    expect(posted).toHaveLength(1);
    expect(posted[0].ChannelArn).toBe(CHANNEL);
    expect(posted[0].ChimeBearer).toBe(BOT);
    expect(posted[0].Content).toBeTruthy();
  });

  it('returns an EMPTY messages array, so the caller posts nothing', async () => {
    const res = await handler(bypass('what is the billing policy?'));

    // The caller's contract is unchanged (ADR-022): empty means post nothing. What changed is that
    // this is now the normal outcome rather than the duplicate-fulfillment exception.
    expect(res.messages).toEqual([]);
  });

  it('posts UNTARGETED, because a bypass reply is visible to every member', async () => {
    await handler(bypass('what is the billing policy?'));

    // The flow does no targeting and neither does the turn. A Target here would make an @all reply
    // visible to one member, which is the over-targeting failure the placeholder contract exists to
    // prevent.
    expect(sends()[0].Target).toBeUndefined();
  });

  it('stamps botResponse, so the surface cannot tell which component sent it', async () => {
    await handler(bypass('what is the billing policy?'));

    expect(JSON.parse(sends()[0].Metadata)).toMatchObject({ botResponse: true });
  });

  it('posts as the classification\'s OWN bot when the caller asks for an unsanctioned identity', async () => {
    // THE SANCTION CHECK IS NOW LOAD-BEARING FOR AUTHORSHIP, not just for a label. Before this the
    // channel flow posted as a bot it had found in the channel's own membership list; now the turn
    // posts as whatever it resolved, so an unvalidated caller-supplied ARN would become the SENDER of
    // a real message. `isSanctionedBattleBot` rejects it and the turn falls back to its own bot.
    const IMPOSTOR = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/not-mine';
    mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) => {
      // The alt-slot roster is what sanctions an alternate identity; an empty roster sanctions none.
      if ((cmd?.input?.Name || '').includes('alt-bot-slots')) return { Parameter: { Value: '[]' } };
      return { Parameter: { Value: BOT } };
    });

    await handler({
      aeTurn: {
        channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'what is the billing policy?',
        botArn: IMPOSTOR,
      },
    });

    const posted = sends();
    expect(posted).toHaveLength(1);
    expect(posted[0].ChimeBearer).toBe(BOT);
    expect(posted[0].ChimeBearer).not.toBe(IMPOSTOR);
  });

  it('does NOT post when the caller handed over an existing message', async () => {
    // A battle continuation reuses the side's "waiting" message. Posting here would strand it and
    // leave the processor two candidates, so the turn stays quiet and answers onto the one it was
    // told about (ADR-025 / tracker row 59).
    const res = await handler({
      aeTurn: {
        channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'the audience is engineering leadership',
        placeholderMessageId: 'waiting-msg-1',
      },
    });

    expect(sends()).toHaveLength(0);
    expect(res.messages).toEqual([]);
  });

  it('hands the message BACK when its own send fails, rather than going silent', async () => {
    mockChimeSend.mockRejectedValue(new Error('Chime unavailable'));

    const res = await handler(bypass('what is the billing policy?'));

    // A send failure must not become a turn that answered and showed nothing. The caller can still
    // post it the old way.
    expect(res.messages?.[0]?.content).toBeTruthy();
  });
});

describe('the Lex path is untouched', () => {
  let handler: (e: any) => Promise<{ messages?: { content: string }[] }>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT } });
    mockChimeSend.mockResolvedValue({ MessageId: 'posted-1' });
    ({ handler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  const lex = (transcript: string) => ({
    sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
    inputTranscript: transcript,
    requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': HUMAN },
  });

  it('returns the message for Chime to materialise, and sends nothing itself', async () => {
    // THE HALF MOST LIKELY TO BREAK. Nothing else can produce the Lex path's message: if the turn
    // posted here too, Chime would materialise a SECOND message from the same return.
    const res = await handler(lex('what is the billing policy?'));

    expect(res.messages?.[0]?.content).toBeTruthy();
    expect(sends()).toHaveLength(0);
  });
});
