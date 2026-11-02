/**
 * A TURN RUNS ON THE PROFILE OF THE ASSISTANT IT WAS ADDRESSED TO, NOT ITS CLASSIFICATION'S PRIMARY.
 *
 * A profile belongs to an assistant, and a classification can have several: `premium` has `advisor`
 * (its primary) and `ops-premium` (the `ops` role, keyword-classified, 120 messages an hour). Every
 * per-assistant setting the router reads for a turn - classifier mode, classifier model, rate limit,
 * onboarding intake, welcome, persona fact, the copy the assistant speaks in its own voice, the
 * attribution - comes from ONE resolution of the assistant (`turnAssistantProfile`), so a turn to `ops-premium`
 * cannot be classified, metered or onboarded as `advisor`.
 *
 * AND A TURN WHOSE ASSISTANT CANNOT BE NAMED IS DECLINED (tenet P4, ADR-046), never answered on another
 * assistant's settings: an undeclared assistant, unreadable records in a classification that has
 * several, a non-primary bot with no record, or a handler with no classification.
 *
 * Three layers, because each catches what the others cannot:
 *   1. the decision itself, against the shipped registry;
 *   2. the router reads every per-assistant setting from that one value and from nothing else;
 *   3. through the real handler: the welcome and the later answer resolve the ASSISTANT's version, a turn the
 *      channel flow hands over resolves its assistant from `AE.bot.arn`, and the declines post nothing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { turnAssistantProfile, type TurnAssistantProfile } from '../lambda/src/lib/turn-assistant';
import { defaultProfileRegistry } from '../lib/profile-registry';

const ROUTER = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');

const resolve = (over: Partial<Parameters<typeof turnAssistantProfile>[0]> = {}): TurnAssistantProfile => turnAssistantProfile({
  classification: 'premium',
  assistantIndexLoaded: true,
  assignedAssistant: undefined,
  isAltAssistant: false,
  primaryBot: false,
  registry: defaultProfileRegistry,
  ...over,
});

/** The answering profile, failing the test if the decision declined. */
const answered = (resolved: TurnAssistantProfile) => {
  if (resolved.decision !== 'answer') throw new Error(`expected an answer, got a decline (${resolved.reason})`);
  return resolved;
};

describe('the turn assistant profile', () => {
  it('a turn addressed to ops-premium uses keyword classification and ops-premium\'s limit of 120', () => {
    const assistant = answered(resolve({ assignedAssistant: 'ops-premium' }));
    expect(assistant.source).toBe('assigned');
    expect(assistant.profile.name).toBe('ops-premium');
    expect(assistant.profile.classifierMode).toBe('keyword');
    expect(assistant.profile.rateLimitPerHour).toBe(120);
  });

  it('a turn addressed to advisor uses advisor\'s own settings', () => {
    const assistant = answered(resolve({ assignedAssistant: 'advisor' }));
    const advisor = defaultProfileRegistry.profileByName('advisor')!;
    expect(assistant.profile.name).toBe('advisor');
    expect(assistant.profile.classifierMode).toBe('llm');
    expect(assistant.profile.rateLimitPerHour).toBe(advisor.rateLimitPerHour);
    // Not vacuous: the two assistants of one classification really differ on both settings.
    expect(advisor.rateLimitPerHour).not.toBe(120);
  });

  it('the classification\'s own bot with no record answers as its primary', () => {
    expect(resolve({ primaryBot: true })).toEqual({
      decision: 'answer', profile: defaultProfileRegistry.requireProfileFor('premium'), source: 'primary',
    });
  });

  it('an alt runs on its own profile, named for its role (ADR-050)', () => {
    const assistant = answered(resolve({ assignedAssistant: 'alt-primary-premium', isAltAssistant: true, altRole: 'primary' }));
    expect(assistant.profile.name).toBe('alt-primary-premium');
    expect(assistant.source).toBe('alt');
    // Its deploy-time descriptor is its role's live assistant's, declared rather than substituted.
    expect(assistant.profile.rateLimitPerHour).toBe(defaultProfileRegistry.profileByName('advisor')!.rateLimitPerHour);
    const ops = answered(resolve({ assignedAssistant: 'alt-ops-premium', isAltAssistant: true, altRole: 'ops' }));
    expect(ops.profile.name).toBe('alt-ops-premium');
  });

  it('an alt whose role the deployment does not declare is DECLINED, never answered as the primary', () => {
    expect(resolve({ isAltAssistant: true, altRole: 'nonexistent' })).toEqual({ decision: 'decline', reason: 'undeclared-assistant' });
    expect(resolve({ isAltAssistant: true })).toEqual({ decision: 'decline', reason: 'undeclared-assistant' });
  });

  it('a record naming an assistant the deployment does not declare is DECLINED', () => {
    expect(resolve({ assignedAssistant: 'nobody-declared-this' })).toEqual({ decision: 'decline', reason: 'undeclared-assistant' });
  });

  it('a bot with no record that is not the classification\'s own is DECLINED', () => {
    expect(resolve({ assignedAssistant: undefined, primaryBot: false })).toEqual({ decision: 'decline', reason: 'no-assignment-record' });
  });

  it('unreadable records in a classification with several assistants are DECLINED, even for its own bot', () => {
    expect(defaultProfileRegistry.rolesFor('premium').length).toBeGreaterThan(1);
    expect(resolve({ assistantIndexLoaded: false, primaryBot: true })).toEqual({ decision: 'decline', reason: 'assistant-index-unreadable' });
  });

  it('unreadable records in a classification with ONE assistant answer, because the primary IS it', () => {
    expect(defaultProfileRegistry.rolesFor('basic')).toEqual(['primary']);
    const assistant = answered(resolve({ classification: 'basic', assistantIndexLoaded: false }));
    expect(assistant.profile.name).toBe(defaultProfileRegistry.requireProfileFor('basic').name);
  });

  it('no classification, or an undeclared one, is DECLINED', () => {
    expect(resolve({ classification: '', primaryBot: true })).toEqual({ decision: 'decline', reason: 'no-classification' });
    expect(resolve({ classification: 'legal', primaryBot: true })).toEqual({ decision: 'decline', reason: 'no-classification' });
  });
});

describe('the router reads every per-assistant setting from the one assistant resolution', () => {
  it('resolves the assistant once, from the bot the turn was addressed as', () => {
    expect(ROUTER.match(/turnAssistantProfile\(\{/g)).toHaveLength(1);
    expect(ROUTER).toMatch(/const turnProfile = turnAssignment\.profile;/);
  });

  it('reads no per-assistant setting from the classification\'s primary', () => {
    expect(ROUTER).not.toMatch(/requireProfileFor\(effectiveClassification\)/);
    expect(ROUTER).not.toMatch(/requireProfileFor\(channelClassification\)/);
  });

  it('the welcome reads the resolved assistant, not the raw record', () => {
    expect(ROUTER).not.toMatch(/loadWelcomeFor\(\s*assistantByBotArn\.get/);
    expect(ROUTER).toMatch(/const welcomeRole = turnRole;/);
  });

  it('classifier mode and rate limit are the assistant\'s deployment-time fields', () => {
    expect(ROUTER).toMatch(/const usesLlmClassifier = turnProfile\.classifierMode === 'llm';/);
    expect(ROUTER).toMatch(/rateLimit: turnProfile\.rateLimitPerHour \?\? 0,/);
  });

  it('the classifier model, the pack and every copy line are the assistant\'s version', () => {
    // The classifier model, the intent pack and the persona fact read the version directly; every
    // line the router says reads it through `wordsOf`, which resolves the same version with its stored message
    // templates (ADR-062): reference-not-found, handover unavailable, stop, stop-left-cancelled, queue write
    // failed, queue notice, the capability refusal, and the rest.
    const assistantVersionReads = ROUTER.match(/resolveActiveProfile\(\s*turnProfile\.name,/g) ?? [];
    const lineReads = ROUTER.match(/turnWords\(\)/g) ?? [];
    expect(assistantVersionReads.length).toBeGreaterThanOrEqual(4);
    expect(lineReads.length).toBeGreaterThanOrEqual(7);
    expect(ROUTER).toMatch(/async function wordsOf\(profileName: string\)[\s\S]{0,120}resolveActiveProfile\(profileName,/);
  });

  it('a turn resolves its words once: every line of the turn reads the one set, and a failed read is not kept', () => {
    // One call resolves the version and its template set; every later line of the turn reads that same promise.
    expect(ROUTER.match(/wordsOf\(turnProfile\.name\)/g)).toHaveLength(1);
    expect(ROUTER).toMatch(/const turnWords = \(\): ReturnType<typeof wordsOf> => \(turnWordsRead \?\?= wordsOf\(turnProfile\.name\)\.catch\(\(err\) => \{ turnWordsRead = undefined; throw err; \}\)\);/);
    // Declared right after the turn's assistant is known, before any line reads it.
    expect(ROUTER.indexOf('const turnWords = ')).toBeGreaterThan(ROUTER.indexOf('const turnProfile = turnAssignment.profile;'));
    expect(ROUTER.indexOf('const turnWords = ')).toBeLessThan(ROUTER.indexOf('await turnWords()'));
  });

  it('both intake call sites pass the same assistant profile', () => {
    expect(ROUTER.match(/intakeForAssistant\(turnProfile\.name, channelClassification\)/g)).toHaveLength(2);
    expect(ROUTER).not.toMatch(/intakeForClassification/);
  });
});

// ── THROUGH THE HANDLER ─────────────────────────────────────────────────────────────────────────

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
const mockEvaluateAbuseGate = jest.fn();
const mockClassifyIntent = jest.fn();
const mockClassifyByKeyword = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetMessage', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

// The sender's display name and clearance are read from Cognito; the person here holds premium.
jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const actual = jest.requireActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'AdminListGroupsForUserCommand') return { Groups: [{ GroupName: 'premium' }] };
        return { UserAttributes: [{ Name: 'name', Value: 'Alice' }] };
      }),
    })),
  };
});

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

jest.mock('../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: (...a: unknown[]) => mockClassifyIntent(...a),
    classifyIntentByKeyword: (...a: unknown[]) => mockClassifyByKeyword(...a),
  };
}, { virtual: true });

// The gate refuses, so a full turn ends at the limit it was given and dispatches nothing.
jest.mock('../lambda/src/lib/abuse-controls.js', () => ({
  ...jest.requireActual('../lambda/src/lib/abuse-controls.js'),
  evaluateAbuseGate: (...a: unknown[]) => mockEvaluateAbuseGate(...a),
}), { virtual: true });

jest.mock('../lambda/src/lib/channel-context-client.js', () => ({
  getChannelContext: (...a: unknown[]) => mockGetChannelContext(...a),
  putChannelContext: (...a: unknown[]) => mockPutChannelContext(...a),
  advanceOnboardingIntake: (...a: unknown[]) => mockAdvanceIntake(...a),
  getParticipantContext: (...a: unknown[]) => mockGetParticipantContext(...a),
}), { virtual: true });

jest.mock('../lambda/src/lib/user-profile-client.js', () => ({
  ...jest.requireActual('../lambda/src/lib/user-profile-client.js'),
  onboardingStatus: (...a: unknown[]) => mockOnboardingStatus(...a),
  markOnboarded: (...a: unknown[]) => mockMarkOnboarded(...a),
}), { virtual: true });

jest.mock('../lambda/src/lib/active-profile.js', () => ({
  ...jest.requireActual('../lambda/src/lib/active-profile.js'),
  resolveActiveProfile: (...a: unknown[]) => mockResolveActiveProfile(...a),
}), { virtual: true });

/**
 * Each assistant's OWN templates, as `npm run migrate-legacy-copy` would write them from these lines: selection answers
 * them for the assistant it names, and reads the store as usual otherwise.
 */
const mockOwnLines: Record<string, Record<string, unknown>> = {};
jest.mock('../lambda/src/lib/message-template-selection.js', () => {
  const actual = jest.requireActual('../lambda/src/lib/message-template-selection.js');
  return {
    ...actual,
    selectMessageTemplate: async (input: { assistant?: string; name: string }, deps?: unknown) => {
      const lines = mockOwnLines[input.assistant ?? ''];
      const planned = lines && jest.requireActual('../lambda/src/lib/legacy-copy-migration.js').legacyCopyPlan(lines).templates
        .find((t: { name: string }) => t.name === input.name);
      if (planned) return { name: input.name, origin: 'assistant', template: jest.requireActual('../lambda/src/lib/document-template.js').parseTemplate(planned.source) };
      return actual.selectMessageTemplate(input, deps);
    },
  };
}, { virtual: true });

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${INSTANCE}/channel/c1`;
const ADVISOR_BOT = `${INSTANCE}/bot/advisor-bot`;
const OPS_BOT = `${INSTANCE}/bot/ops-bot`;
const ALICE = `${INSTANCE}/user/alice`;

/** Each assistant's own intake, on its own version. Distinct questions so the source is visible. */
const INTAKES: Record<string, unknown> = {
  'ops-premium': { greeting: 'Ops here.', fields: [
    { key: 'service', prompt: 'Which service are you on call for?' },
    { key: 'pager', prompt: 'Which pager rotation are you in?' },
  ] },
  advisor: { greeting: 'Advisor here.', fields: [
    { key: 'reports', prompt: 'What should reports default to covering?' },
  ] },
};

const ASSIGNMENTS = [
  { botArn: ADVISOR_BOT, assistant: 'advisor', role: 'primary', occupancy: 'live', lexBotId: 'lex-advisor' },
  { botArn: OPS_BOT, assistant: 'ops-premium', role: 'ops', occupancy: 'live', lexBotId: 'lex-ops' },
];

const welcomeEvent = (lexBotId: string) => ({
  bot: { id: lexBotId },
  sessionState: { intent: { name: 'WelcomeIntent' }, sessionAttributes: {} },
  inputTranscript: '',
  requestAttributes: { 'CHIME.channel.arn': CHANNEL },
});

const answerEvent = (lexBotId: string, transcript: string) => ({
  bot: { id: lexBotId },
  sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
  inputTranscript: transcript,
  requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': ALICE },
});

type Handler = (e: unknown) => Promise<{ messages: Array<{ content: string }> }>;

async function loadHandler(): Promise<Handler> {
  jest.resetModules();
  process.env.CLASSIFICATION = 'premium';
  process.env.USER_POOL_ID = 'us-east-1_test';
  return ((await import('../lambda/src/router-agent-handler.js')) as unknown as { handler: Handler }).handler;
}

function recordedIntake(): Record<string, unknown> | undefined {
  const call = mockPutChannelContext.mock.calls.find((c) => (c[1] as { onboardingIntake?: unknown })?.onboardingIntake);
  return call ? (call[1] as { onboardingIntake: Record<string, unknown> }).onboardingIntake : undefined;
}

/** Every profile name the handler resolved a version for. */
const resolvedNames = () => mockResolveActiveProfile.mock.calls.map((c) => c[0]);

describe('through the handler, a turn runs on its assistant\'s profile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSsmSend.mockImplementation((cmd: { __type?: string }) => {
      if (cmd.__type === 'GetByPath') return Promise.resolve({ Parameters: ASSIGNMENTS.map((a) => ({ Value: JSON.stringify(a) })) });
      return Promise.resolve({ Parameter: { Value: ADVISOR_BOT } });
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({})) });
    mockMessagingSend.mockImplementation((cmd: { __type?: string }) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'premium' }] });
      if (cmd.__type === 'DescribeChannel') return Promise.resolve({ Channel: { ChannelArn: CHANNEL, Metadata: '{}' } });
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
    mockResolveActiveProfile.mockImplementation(async (name: string) => ({ onboarding: INTAKES[name] }));
    mockEvaluateAbuseGate.mockResolvedValue({ allowed: false, reason: 'rate', message: 'RATE-LIMITED', notice: { kind: 'rateLimited', vars: { minutes: 5 } } });
    mockClassifyIntent.mockResolvedValue({ intent: 'general', confidence: 'high' });
    mockClassifyByKeyword.mockReturnValue({ intent: 'general', confidence: 'high' });
  });

  afterEach(() => {
    delete process.env.CLASSIFICATION;
    delete process.env.USER_POOL_ID;
  });

  it('a conversation with ops-premium is opened with its questions and its answers read against them', async () => {
    const handler = await loadHandler();

    const welcome = await handler(welcomeEvent('lex-ops'));
    expect(welcome.messages[0].content).toContain('Which service are you on call for?');
    expect(welcome.messages[0].content).not.toContain('What should reports default to covering?');
    const started = recordedIntake();
    expect(started).toEqual(expect.objectContaining({ subject: 'alice', cursor: 0, asked: ['service', 'pager'] }));
    expect(resolvedNames()).toContain('ops-premium');
    expect(resolvedNames()).not.toContain('advisor');

    // THE SECOND CALL SITE. Read against advisor's one-field intake, `intakeAsStarted` would refuse
    // the stored `asked` list and the answer would be dropped; read against the assistant's, it advances.
    mockResolveActiveProfile.mockClear();
    mockGetChannelContext.mockResolvedValue({ channelArn: CHANNEL, onboardingIntake: started });
    const answer = await handler(answerEvent('lex-ops', 'checkout-api'));
    expect(answer.messages[0].content).toContain('Which pager rotation are you in?');
    expect(mockAdvanceIntake.mock.calls[0][2]).toEqual(expect.objectContaining({ cursor: 1, collected: { service: 'checkout-api' } }));
    expect(resolvedNames()).toContain('ops-premium');
    expect(resolvedNames()).not.toContain('advisor');
  });

  it('a conversation with advisor is opened with advisor\'s questions', async () => {
    const handler = await loadHandler();

    const welcome = await handler(welcomeEvent('lex-advisor'));

    expect(welcome.messages[0].content).toContain('What should reports default to covering?');
    expect(recordedIntake()).toEqual(expect.objectContaining({ asked: ['reports'] }));
    expect(resolvedNames()).not.toContain('ops-premium');
  });

  it('a second assistant whose version carries no intake asks nothing, rather than the primary\'s deployment intake', async () => {
    process.env.ONBOARDING_INTAKE = JSON.stringify(INTAKES.advisor);
    mockResolveActiveProfile.mockImplementation(async () => ({}));
    try {
      const handler = await loadHandler();
      const welcome = await handler(welcomeEvent('lex-ops'));
      expect(welcome.messages[0]?.content ?? '').not.toContain('What should reports default to covering?');
      expect(recordedIntake()).toBeUndefined();
    } finally {
      delete process.env.ONBOARDING_INTAKE;
    }
  });

  it('a turn addressed to ops-premium is keyword-classified, metered at its limit of 120, and refused in its own words', async () => {
    // The refusal is said from the ADDRESSED assistant's own template, so ops-premium's line is said, not advisor's.
    mockResolveActiveProfile.mockImplementation(async () => ({}));
    mockOwnLines['ops-premium'] = { rateLimited: 'OPS LIMIT, back in {minutes}' };
    mockOwnLines.advisor = { rateLimited: 'ADVISOR LIMIT' };
    const handler = await loadHandler();

    const res = await handler(answerEvent('lex-ops', 'what is the error rate on checkout?'));

    expect(mockClassifyByKeyword).toHaveBeenCalled();
    expect(mockClassifyIntent).not.toHaveBeenCalled();
    expect(mockEvaluateAbuseGate).toHaveBeenCalledWith(expect.objectContaining({ rateLimit: 120 }));
    expect(res.messages[0].content).toBe('OPS LIMIT, back in 5');
    for (const k of Object.keys(mockOwnLines)) delete mockOwnLines[k];
  });

  it('a turn addressed to advisor is model-classified and metered at advisor\'s own limit', async () => {
    mockResolveActiveProfile.mockImplementation(async () => ({}));
    const handler = await loadHandler();

    await handler(answerEvent('lex-advisor', 'what is our ARR this quarter?'));

    expect(mockClassifyIntent).toHaveBeenCalled();
    expect(mockClassifyByKeyword).not.toHaveBeenCalled();
    expect(mockEvaluateAbuseGate).toHaveBeenCalledWith(expect.objectContaining({
      rateLimit: defaultProfileRegistry.profileByName('advisor')!.rateLimitPerHour,
    }));
  });
});

// ── A FLOW-HANDED TURN, AND THE DECLINES, THROUGH THE HANDLER ───────────────────────────────────

const BASIC_BOT = `${INSTANCE}/bot/basic-bot`;
const STRAY_BOT = `${INSTANCE}/bot/stray-bot`;

/** A turn the channel flow hands over: no Lex bot id, the bot it answers as named in the payload. */
const handedTurn = (botArn: string, userMessage: string) => ({
  aeTurn: { channelArn: CHANNEL, senderArn: ALICE, userMessage, botArn },
});

describe('through the handler, the assistant resolution decides who answers and who declines', () => {
  /** What the room's tags say, and which records and bot parameter the deployment publishes. */
  let room: { classification: string; records: Array<Record<string, unknown> | 'malformed'>; ownBot: string };
  let errorSpy: jest.SpyInstance;

  const securityEvents = () => errorSpy.mock.calls
    .filter(([m]) => String(m).includes('[SecurityEvent] the addressed assistant cannot be named'))
    .map(([, detail]) => (detail as { reason: string }).reason);

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    room = { classification: 'premium', records: ASSIGNMENTS, ownBot: ADVISOR_BOT };
    mockSsmSend.mockImplementation((cmd: { __type?: string }) => {
      if (cmd.__type === 'GetByPath') {
        return Promise.resolve({
          Parameters: room.records.map((r) => ({ Value: r === 'malformed' ? 'not json' : JSON.stringify(r) })),
        });
      }
      return Promise.resolve({ Parameter: { Value: room.ownBot } });
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({})) });
    mockMessagingSend.mockImplementation((cmd: { __type?: string }) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: room.classification }] });
      if (cmd.__type === 'DescribeChannel') return Promise.resolve({ Channel: { ChannelArn: CHANNEL, Metadata: '{}' } });
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: [] });
      if (cmd.__type === 'ListMessages') return Promise.resolve({ ChannelMessages: [] });
      return Promise.resolve({ ChannelMessage: { MessageId: 'm-1' }, MessageId: 'm-1' });
    });
    mockGetChannelContext.mockResolvedValue({ channelArn: CHANNEL });
    mockPutChannelContext.mockResolvedValue(true);
    mockGetParticipantContext.mockResolvedValue({ focus: 'single', humans: ['alice'], subject: 'alice' });
    mockOnboardingStatus.mockResolvedValue({ onboarded: true, facts: null });
    mockResolveActiveProfile.mockImplementation(async () => ({}));
    mockEvaluateAbuseGate.mockResolvedValue({ allowed: false, reason: 'rate', message: 'RATE-LIMITED', notice: { kind: 'rateLimited', vars: { minutes: 5 } } });
    mockClassifyIntent.mockResolvedValue({ intent: 'general', confidence: 'high' });
    mockClassifyByKeyword.mockReturnValue({ intent: 'general', confidence: 'high' });
  });

  afterEach(() => {
    errorSpy.mockRestore();
    delete process.env.CLASSIFICATION;
    delete process.env.USER_POOL_ID;
  });

  it('a turn the flow hands to ops-premium (no Lex bot id) runs on ops-premium\'s profile', async () => {
    const handler = await loadHandler();

    await handler(handedTurn(OPS_BOT, 'what is the error rate on checkout?'));

    expect(mockClassifyByKeyword).toHaveBeenCalled();
    expect(mockClassifyIntent).not.toHaveBeenCalled();
    expect(mockEvaluateAbuseGate).toHaveBeenCalledWith(expect.objectContaining({ rateLimit: 120 }));
    expect(securityEvents()).toEqual([]);
    // THE ATTRIBUTION, by behavior: what the turn posts says it is ops-premium, in the ops role.
    const posted = mockMessagingSend.mock.calls
      .map((c) => c[0] as { __type?: string; input?: { ChimeBearer?: string; Metadata?: string } })
      .filter((c) => c.__type === 'SendMessage' && c.input?.ChimeBearer === OPS_BOT);
    expect(posted.length).toBeGreaterThan(0);
    expect(JSON.parse(posted[0].input!.Metadata!)).toEqual(expect.objectContaining({
      agentType: 'ops-premium', assistantRole: 'ops', classification: 'premium',
    }));
  });

  it('DECLINES an assistant whose record names an assistant this deployment does not declare', async () => {
    room.records = [ASSIGNMENTS[0], { ...ASSIGNMENTS[1], assistant: 'nobody-declared-this' }];
    const handler = await loadHandler();

    const res = await handler(answerEvent('lex-ops', 'what is the error rate on checkout?'));

    expect(res.messages).toEqual([]);
    expect(mockEvaluateAbuseGate).not.toHaveBeenCalled();
    // The declined assistant's settings are never read. The only profile read is the classification's own
    // assistant's, for the "unavailable" notice it says to the person (`reportTurnNotStarted`).
    expect(mockResolveActiveProfile.mock.calls.map((c) => c[0])).not.toContain('nobody-declared-this');
    expect(mockResolveActiveProfile.mock.calls.map((c) => c[0]).every((name) => name === 'advisor')).toBe(true);
    expect(securityEvents()).toEqual(['undeclared-assistant']);
  });

  it('DECLINES when the records cannot be read in a classification with several assistants, even on its own bot', async () => {
    // A malformed record makes the router's index unreadable while the room-primary read (which skips
    // what it cannot parse) still resolves the room.
    room.records = [...ASSIGNMENTS, 'malformed'];
    const handler = await loadHandler();

    const res = await handler(answerEvent('lex-advisor', 'what is our ARR this quarter?'));

    expect(res.messages).toEqual([]);
    expect(mockEvaluateAbuseGate).not.toHaveBeenCalled();
    expect(securityEvents()).toEqual(['assistant-index-unreadable']);
  });

  it('ANSWERS when the records cannot be read in a classification with one assistant', async () => {
    room = {
      classification: 'basic',
      records: [{ botArn: BASIC_BOT, assistant: 'concierge', role: 'primary', occupancy: 'live' }, 'malformed'],
      ownBot: BASIC_BOT,
    };
    jest.resetModules();
    process.env.CLASSIFICATION = 'basic';
    process.env.USER_POOL_ID = 'us-east-1_test';
    const handler = ((await import('../lambda/src/router-agent-handler.js')) as unknown as { handler: Handler }).handler;

    await handler(answerEvent('lex-basic', 'what is the billing policy?'));

    expect(securityEvents()).toEqual([]);
    expect(mockEvaluateAbuseGate).toHaveBeenCalledWith(expect.objectContaining({
      rateLimit: defaultProfileRegistry.requireProfileFor('basic').rateLimitPerHour ?? 0,
    }));
  });

  it('DECLINES a bot with no assistant on its record that is not the classification\'s own', async () => {
    room.records = [...ASSIGNMENTS, { botArn: STRAY_BOT, role: 'ops', occupancy: 'live', lexBotId: 'lex-stray' }];
    const handler = await loadHandler();

    const res = await handler(answerEvent('lex-stray', 'hello?'));

    expect(res.messages).toEqual([]);
    expect(mockEvaluateAbuseGate).not.toHaveBeenCalled();
    expect(securityEvents()).toEqual(['no-assignment-record']);
  });

  it('DECLINES on a handler deployed with no classification', async () => {
    jest.resetModules();
    delete process.env.CLASSIFICATION;
    process.env.USER_POOL_ID = 'us-east-1_test';
    const handler = ((await import('../lambda/src/router-agent-handler.js')) as unknown as { handler: Handler }).handler;

    const res = await handler(answerEvent('lex-advisor', 'what is our ARR this quarter?'));

    expect(res.messages).toEqual([]);
    expect(mockEvaluateAbuseGate).not.toHaveBeenCalled();
    expect(securityEvents()).toEqual(['no-classification']);
  });
});
