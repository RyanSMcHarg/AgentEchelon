/**
 * AN INTAKE ANSWER IS STORED UNDER THE QUESTION THAT WAS ASKED.
 *
 * The welcome drops every field the deployment already asserts before asking (`intakeAfterChecking`),
 * but the answer path advanced the stored cursor against the FULL deployed field list. The two lists
 * agree only while nothing is asserted. With a middle field asserted, the welcome asked `company` then
 * `goal`, while the answer path read cursor 1 as `role`: the person's goal was saved as their role, and
 * `goal` was asked again as a third question. The profile guide carried a workaround for it (put
 * asserted fields last).
 *
 * The welcome now pins the keys it asked on the stored row, and every answer turn runs exactly those
 * (`intakeAsStarted`). These drive both paths through the real handler.
 *
 * Also pinned here, because they were wired on the same path and never matched on it:
 *   - `persona` resolves from the ACTIVE profile version, which the router can read. It used to check
 *     the handler's environment for the persona seam, which the stacks set only on the processor.
 *   - `profile` resolves from the stored facts the once-per-user gate already reads. It used to be
 *     passed as a literal null.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();
const mockGetChannelContext = jest.fn();
const mockPutChannelContext = jest.fn();
const mockAdvanceIntake = jest.fn();
const mockGetParticipantContext = jest.fn();
const mockOnboardingStatus = jest.fn();
const mockMarkOnboarded = jest.fn();
const mockResolveActiveProfile = jest.fn();

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
  onboardingStatus: (...a: unknown[]) => mockOnboardingStatus(...a),
  markOnboarded: (...a: unknown[]) => mockMarkOnboarded(...a),
}), { virtual: true });

jest.mock('../../lambda/src/lib/active-profile.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/active-profile.js'),
  resolveActiveProfile: (...a: unknown[]) => mockResolveActiveProfile(...a),
}), { virtual: true });

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${INSTANCE}/channel/c1`;
const BOT = `${INSTANCE}/bot/basic-bot`;
const ALICE = `${INSTANCE}/user/alice`;

/** The middle field is asserted, which is the shape the guide's workaround told deployers to avoid. */
const MIDDLE_ASSERTED = {
  greeting: 'Welcome!',
  fields: [
    { key: 'company', prompt: 'What company are you with?' },
    { key: 'role', prompt: 'What is your role?', assertedBy: ['classification'] },
    { key: 'goal', prompt: 'What are you hoping to do?' },
  ],
};

const welcomeEvent = {
  sessionState: { intent: { name: 'WelcomeIntent' }, sessionAttributes: {} },
  inputTranscript: '',
  requestAttributes: { 'CHIME.channel.arn': CHANNEL },
};

const answerEvent = (transcript: string) => ({
  sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
  inputTranscript: transcript,
  requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': ALICE },
});

type Handler = (e: unknown) => Promise<{ messages: Array<{ content: string }> }>;

async function loadHandler(intake: unknown): Promise<Handler> {
  jest.resetModules();
  process.env.ONBOARDING_INTAKE = JSON.stringify(intake);
  return ((await import('../../lambda/src/router-agent-handler.js')) as unknown as { handler: Handler }).handler;
}

/** The intake the welcome recorded, or undefined when it asked nothing. */
function recordedIntake(): Record<string, unknown> | undefined {
  const call = mockPutChannelContext.mock.calls.find((c) => (c[1] as { onboardingIntake?: unknown })?.onboardingIntake);
  return call ? (call[1] as { onboardingIntake: Record<string, unknown> }).onboardingIntake : undefined;
}

describe('an intake answer is stored under the question that was asked', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    mockGetChannelContext.mockResolvedValue({ channelArn: CHANNEL });
    mockPutChannelContext.mockResolvedValue(true);
    mockAdvanceIntake.mockResolvedValue('advanced');
    mockGetParticipantContext.mockResolvedValue({ focus: 'single', humans: ['alice'], subject: 'alice' });
    mockOnboardingStatus.mockResolvedValue({ onboarded: false, facts: null });
    mockMarkOnboarded.mockResolvedValue(undefined);
    mockResolveActiveProfile.mockResolvedValue({ persona: undefined });
  });

  afterEach(() => {
    delete process.env.ONBOARDING_INTAKE;
  });

  it('files each answer under its own key when a middle field is asserted', async () => {
    const handler = await loadHandler(MIDDLE_ASSERTED);

    const welcome = await handler(welcomeEvent);
    expect(welcome.messages[0].content).toContain('What company are you with?');
    const started = recordedIntake();
    expect(started).toEqual(expect.objectContaining({ subject: 'alice', cursor: 0, asked: ['company', 'goal'] }));

    // First answer: the row the welcome wrote, read back.
    mockGetChannelContext.mockResolvedValue({ channelArn: CHANNEL, onboardingIntake: started });
    const first = await handler(answerEvent('Acme Corp'));
    expect(first.messages[0].content).toContain('What are you hoping to do?');
    const afterFirst = mockAdvanceIntake.mock.calls[0][2] as Record<string, unknown>;
    expect(afterFirst).toEqual(expect.objectContaining({ cursor: 1, collected: { company: 'Acme Corp' } }));

    // Second answer: cursor 1 is `goal` in the list that was asked. Against the full list it was `role`.
    mockGetChannelContext.mockResolvedValue({ channelArn: CHANNEL, onboardingIntake: afterFirst });
    const second = await handler(answerEvent('Ship the launch'));
    const afterSecond = mockAdvanceIntake.mock.calls[1][2] as Record<string, unknown>;
    expect(afterSecond).toEqual(expect.objectContaining({
      phase: 'confirming',
      collected: { company: 'Acme Corp', goal: 'Ship the launch' },
    }));
    expect(second.messages[0].content).not.toContain('What is your role?');

    // Confirmed: the once-per-user record carries the same keys.
    mockGetChannelContext.mockResolvedValue({ channelArn: CHANNEL, onboardingIntake: afterSecond });
    await handler(answerEvent('yes'));
    expect(mockMarkOnboarded).toHaveBeenCalledWith('alice', { company: 'Acme Corp', goal: 'Ship the launch' }, {});
  });

  it('an intake stored before the keys were pinned resumes on the list its welcome asked', async () => {
    // Its welcome could match only `classification`, so the same check rebuilds [company, goal].
    const handler = await loadHandler(MIDDLE_ASSERTED);
    mockGetChannelContext.mockResolvedValue({
      channelArn: CHANNEL,
      onboardingIntake: { subject: 'alice', cursor: 1, collected: { company: 'Acme' }, phase: 'collecting' },
    });

    await handler(answerEvent('Ship the launch'));

    expect(mockAdvanceIntake.mock.calls[0][2]).toEqual(expect.objectContaining({
      phase: 'confirming', collected: { company: 'Acme', goal: 'Ship the launch' },
    }));
  });

  it('does not read a turn as an answer once the deployed intake no longer has a field it asked', async () => {
    const handler = await loadHandler({ greeting: 'hi', fields: [{ key: 'company', prompt: 'What company are you with?' }] });
    mockGetChannelContext.mockResolvedValue({
      channelArn: CHANNEL,
      onboardingIntake: { subject: 'alice', cursor: 1, collected: { company: 'Acme' }, phase: 'collecting', asked: ['company', 'goal'] },
    });

    await handler(answerEvent('what is the billing policy?'));

    expect(mockAdvanceIntake).not.toHaveBeenCalled();
  });

  it('a `persona` assertion matches when the active profile version carries a persona', async () => {
    const intake = {
      greeting: 'Welcome!',
      fields: [
        { key: 'company', prompt: 'What company are you with?', assertedBy: ['persona'] },
        { key: 'goal', prompt: 'What are you hoping to do?' },
      ],
    };
    mockResolveActiveProfile.mockResolvedValue({ persona: 'You are the internal assistant for Stratum Technologies.' });
    let handler = await loadHandler(intake);
    const withPersona = await handler(welcomeEvent);
    expect(withPersona.messages[0].content).toContain('What are you hoping to do?');
    expect(recordedIntake()?.asked).toEqual(['goal']);

    // No persona on the active version: nothing asserts the field, so it is asked.
    jest.clearAllMocks();
    mockPutChannelContext.mockResolvedValue(true);
    mockResolveActiveProfile.mockResolvedValue({ persona: undefined });
    handler = await loadHandler(intake);
    const without = await handler(welcomeEvent);
    expect(without.messages[0].content).toContain('What company are you with?');
    expect(recordedIntake()?.asked).toEqual(['company', 'goal']);
  });

  it('a `profile` assertion matches a value in the stored facts the gate read', async () => {
    const intake = {
      greeting: 'Welcome!',
      fields: [
        { key: 'company', prompt: 'What company are you with?', assertedBy: ['profile'] },
        { key: 'goal', prompt: 'What are you hoping to do?' },
      ],
    };
    mockOnboardingStatus.mockResolvedValue({ onboarded: false, facts: { company: 'Acme' } });
    const handler = await loadHandler(intake);

    const res = await handler(welcomeEvent);

    expect(res.messages[0].content).toContain('What are you hoping to do?');
    expect(recordedIntake()?.asked).toEqual(['goal']);
    // One read serves the gate and the check.
    expect(mockOnboardingStatus).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when the stored facts answer every remaining field', async () => {
    const intake = {
      greeting: 'Welcome!',
      fields: [{ key: 'company', prompt: 'What company are you with?', assertedBy: ['profile'] }],
    };
    mockOnboardingStatus.mockResolvedValue({ onboarded: false, facts: { company: 'Acme' } });
    const handler = await loadHandler(intake);

    const res = await handler(welcomeEvent);

    expect(recordedIntake()).toBeUndefined();
    expect(res.messages[0]?.content ?? '').not.toContain('What company are you with?');
  });
});

export {};

afterAll(() => { delete process.env.CLASSIFICATION; });
