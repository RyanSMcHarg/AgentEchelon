/**
 * AN ONBOARDING INTAKE IS READ FROM THE CONVERSATION, NOT FROM THE AMAZON LEX SESSION.
 *
 * The intake's cursor and answers used to ride Lex `sessionAttributes`, and the handler read an EMPTY
 * session as "this is the answer to the first question". A turn without Lex's session - the channel
 * flow's entry, a handover, a reading, a stop evaluation - always has an empty one, so a person who had
 * not yet been onboarded had every such message filed under question one, and the state written back
 * was discarded, so the intake could never move. Lex also dropped its session after five idle minutes,
 * which did the same to anyone who paused.
 *
 * The state now lives on the conversation's channel context row and names the person it belongs to.
 * These pin the three rules that follow, at the handler, where the decision is made:
 *   - a stored intake advances when its subject answers, and the new state is stored;
 *   - no stored intake means no intake: the message is answered normally;
 *   - an intake is advanced only by its subject.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();
const mockGetChannelContext = jest.fn();
const mockPutChannelContext = jest.fn();
const mockAdvanceIntake = jest.fn();
const mockGetParticipantContext = jest.fn();
const mockHasOnboarded = jest.fn();
const mockMarkOnboarded = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetMessage', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
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
  GetParametersByPathCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetByPath', input: args })),
}), { virtual: true });

// Only the billed model call is stubbed, mirroring the real keyword fast path, so a turn that is NOT
// intercepted runs the ordinary path rather than dying in the handler's catch-all.
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: jest.fn(async (msg: string) =>
      actual.fastPathIntent(msg) ?? { intent: 'general', confidence: 'high' }),
  };
}, { virtual: true });

jest.mock('../../lambda/src/lib/channel-context-client.js', () => ({
  getChannelContext: (...a: unknown[]) => mockGetChannelContext(...a),
  putChannelContext: (...a: unknown[]) => mockPutChannelContext(...a),
  advanceOnboardingIntake: (...a: unknown[]) => mockAdvanceIntake(...a),
  getParticipantContext: (...a: unknown[]) => mockGetParticipantContext(...a),
}), { virtual: true });

jest.mock('../../lambda/src/lib/user-profile-client.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/user-profile-client.js'),
  onboardingStatus: async (...a: unknown[]) => ({ onboarded: await mockHasOnboarded(...a), facts: null }),
  markOnboarded: (...a: unknown[]) => mockMarkOnboarded(...a),
}), { virtual: true });

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${INSTANCE}/channel/c1`;
const BOT = `${INSTANCE}/bot/basic-bot`;
const ALICE = `${INSTANCE}/user/alice`;
const BOB = `${INSTANCE}/user/bob`;

const INTAKE = {
  greeting: 'Welcome!',
  fields: [
    { key: 'company', prompt: 'What company are you with?' },
    { key: 'goal', prompt: 'What are you hoping to do?' },
  ],
};

const lexEvent = (transcript: string, sender = ALICE) => ({
  sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
  inputTranscript: transcript,
  requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': sender },
});

describe('an onboarding intake lives on the conversation and belongs to one person', () => {
  let handler: (e: unknown) => Promise<{ messages: Array<{ content: string }>; sessionState: { sessionAttributes?: Record<string, string> } }>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ONBOARDING_INTAKE = JSON.stringify(INTAKE);
    process.env.CLASSIFICATION = 'basic';
    // The bot parameter, and the assignment record naming the assistant on that bot: the router
    // resolves the turn's assistant from it and declines a turn whose assistant it cannot name.
    mockSsmSend.mockResolvedValue({
      Parameter: { Value: BOT },
      Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: 'concierge', role: 'primary', occupancy: 'live' }) }],
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({})) });
    mockMessagingSend.mockImplementation((cmd: { __type?: string }) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: [] });
      if (cmd.__type === 'ListMessages') return Promise.resolve({ ChannelMessages: [] });
      return Promise.resolve({ ChannelMessage: { MessageId: 'm-1' }, MessageId: 'm-1' });
    });
    mockPutChannelContext.mockResolvedValue(true);
    mockAdvanceIntake.mockResolvedValue('advanced');
    mockGetParticipantContext.mockResolvedValue(null);
    mockHasOnboarded.mockResolvedValue(false);
    mockMarkOnboarded.mockResolvedValue(undefined);
    ({ handler } = await import('../../lambda/src/router-agent-handler.js') as never);
  });

  afterEach(() => {
    delete process.env.ONBOARDING_INTAKE;
  });

  it('advances a stored intake when its subject answers, and stores the new state', async () => {
    mockGetChannelContext.mockResolvedValue({
      channelArn: CHANNEL,
      onboardingIntake: { subject: 'alice', cursor: 0, collected: {}, phase: 'collecting' },
    });

    const res = await handler(lexEvent('Acme Corp'));

    expect(res.messages[0].content).toContain('What are you hoping to do?');
    // Conditional on the state this turn read, so a duplicate cannot advance it a second time.
    expect(mockAdvanceIntake).toHaveBeenCalledWith(
      CHANNEL,
      { cursor: 0, phase: 'collecting', subject: 'alice' },
      expect.objectContaining({ subject: 'alice', cursor: 1, collected: { company: 'Acme Corp' }, phase: 'collecting' }),
    );
    // Nothing is written to the Lex session: it is echoed, never used as a store.
    expect(res.sessionState.sessionAttributes).toEqual({});
  });

  it('answers normally when no intake is stored, rather than filing the message under question one', async () => {
    // THE DEFECT. An empty Lex session read as "first answer", so every turn without one - and every
    // turn after a five-minute pause - took a not-yet-onboarded person's message as their company name.
    mockGetChannelContext.mockResolvedValue({ channelArn: CHANNEL });

    const res = await handler(lexEvent('what is the billing policy?'));

    expect(mockAdvanceIntake).not.toHaveBeenCalled();
    expect(res.messages[0]?.content ?? '').not.toContain('What are you hoping to do?');
  });

  it('is advanced only by its subject, so nobody else in the conversation answers it', async () => {
    mockGetChannelContext.mockResolvedValue({
      channelArn: CHANNEL,
      onboardingIntake: { subject: 'alice', cursor: 0, collected: {}, phase: 'collecting' },
    });

    const res = await handler(lexEvent('Globex', BOB));

    expect(mockAdvanceIntake).not.toHaveBeenCalled();
    expect(res.messages[0]?.content ?? '').not.toContain('What are you hoping to do?');
  });

  it('a finished intake stays finished, even if the once-per-user flag failed to write', async () => {
    mockGetChannelContext.mockResolvedValue({
      channelArn: CHANNEL,
      onboardingIntake: { subject: 'alice', cursor: 2, collected: { company: 'Acme', goal: 'x' }, phase: 'done' },
    });

    await handler(lexEvent('what is the billing policy?'));

    expect(mockAdvanceIntake).not.toHaveBeenCalled();
  });

  it('a duplicate that loses the race replies with the same step and records nothing', async () => {
    // Two deliveries of the last answer read the same state. The one that loses the conditional write
    // must not mark the person onboarded a second time, and replies exactly as the winner did.
    mockGetChannelContext.mockResolvedValue({
      channelArn: CHANNEL,
      onboardingIntake: { subject: 'alice', cursor: 2, collected: { company: 'Acme', goal: 'x' }, phase: 'confirming' },
    });
    mockAdvanceIntake.mockResolvedValue('lost');

    const res = await handler(lexEvent('yes'));

    expect(mockMarkOnboarded).not.toHaveBeenCalled();
    expect(res.messages[0].content).toMatch(/all set/i);
  });

  it('the winning final answer marks the person onboarded', async () => {
    mockGetChannelContext.mockResolvedValue({
      channelArn: CHANNEL,
      onboardingIntake: { subject: 'alice', cursor: 2, collected: { company: 'Acme', goal: 'x' }, phase: 'confirming' },
    });

    await handler(lexEvent('yes'));

    expect(mockMarkOnboarded).toHaveBeenCalledWith('alice', { company: 'Acme', goal: 'x' }, {});
  });

  it('asks the first question only if the intake was recorded', async () => {
    // THE DEFECT (code review). The answers are intercepted from the stored row, so a question sent
    // without one is a question whose answer nothing reads.
    mockGetParticipantContext.mockResolvedValue({ focus: 'single', humans: ['alice'], subject: 'alice' });
    mockGetChannelContext.mockResolvedValue({ channelArn: CHANNEL });
    mockPutChannelContext.mockResolvedValue(false);
    const welcome = {
      sessionState: { intent: { name: 'WelcomeIntent' }, sessionAttributes: {} },
      inputTranscript: '',
      requestAttributes: { 'CHIME.channel.arn': CHANNEL },
    };

    const failed = await handler(welcome);
    expect(failed.messages[0]?.content ?? '').not.toContain('What company are you with?');

    mockPutChannelContext.mockResolvedValue(true);
    const recorded = await handler(welcome);
    expect(recorded.messages[0]?.content ?? '').toContain('What company are you with?');
  });
});

export {};

afterAll(() => { delete process.env.CLASSIFICATION; });
