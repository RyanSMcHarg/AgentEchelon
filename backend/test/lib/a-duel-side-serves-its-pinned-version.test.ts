/**
 * A DUEL SIDE SERVES ITS PINNED VERSION, AND NOTHING ABOUT ITS VARIANT RIDES THE TURN BESIDE IT.
 *
 * Both sides of a battle are pinned versions derived at arm (DESIGN-SEPARATE-ASSISTANTS §3.7): the
 * control's under the live assistant, the treatment's under the alt. A side's turn reads its version the
 * way any turn reads the version it serves: the router classifies with it and hands it to the worker as
 * `variantProfile`, and no model is forced beside it: the worker answers through the version's own routes
 * and base model (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5), exactly as an enrolled experiment arm's
 * version reaches a turn. The battle context names the duel and the rival, and carries no variant field:
 * the model, persona addendum, image model and name were injected per turn once, and are not now.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('../../lambda/src/lib/assistant-session', () => {
  const actual = jest.requireActual('../../lambda/src/lib/assistant-session');
  const session = (botArn: string) => ({
    assistant: 'test-assistant', role: 'primary', botArn,
    credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test', sessionToken: 'test' },
  });
  return {
    ...actual,
    speakAsRoutedAssistant: jest.fn(async (input: { botArn: string }) => session(input.botArn)),
    sessionForRoutedAssistant: jest.fn(async (input: { botArn: string }) => session(input.botArn)),
  };
});
jest.mock('../../lambda/src/lib/turn-routing', () => ({
  ...jest.requireActual('../../lambda/src/lib/turn-routing'),
  recordTurnRouting: jest.fn(async () => undefined),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  UpdateChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
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

const mockGetActiveTaskForOwner = jest.fn();
jest.mock('../../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getActiveTaskForOwner: (...a: unknown[]) => mockGetActiveTaskForOwner(...a),
    getActiveTasksForOwnerInChannel: async () => [],
    getAssigneeChannelTasks: async () => ({ live: [], recentlyEnded: [] }),
    getActiveTask: async () => null,
  };
}, { virtual: true });

// THE TWO SIDES, as their pinned versions say. Every field a side serves is on its version.
const mockControlSide = jest.fn();
const mockTreatmentSide = jest.fn();
const mockClassificationExperiment = jest.fn();
jest.mock('../../lambda/src/lib/experiment-manager.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/experiment-manager.js');
  return {
    ...actual,
    resolveBattleTreatment: (...a: unknown[]) => mockTreatmentSide(...a),
    // ONE READ answers both sides and whether the duel's experiment is active. It is active in these cases;
    // an ended one is covered in an-ended-experiment-releases-its-conversations.
    resolveBattleSides: async (...a: unknown[]) => ({
      active: true, control: await mockControlSide(...a), treatment: await mockTreatmentSide(...a),
    }),
    resolveClassificationExperiment: (...a: unknown[]) => mockClassificationExperiment(...a),
    resolveExperimentModel: jest.fn(async () => null),
  };
}, { virtual: true });

/** When set, the intent every turn classifies as; otherwise the real classifier runs. */
const mockClassified: { intent?: string } = {};
jest.mock('../../lambda/src/lib/intent-classifier.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier.js');
  return {
    ...actual,
    classifyIntent: jest.fn(async (...a: unknown[]) => (mockClassified.intent
      ? { intent: mockClassified.intent, confidence: 'high' }
      : actual.classifyIntent(...a))),
  };
}, { virtual: true });


const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_DEFAULT = `${APP}/bot/premium-bot`;
const BOT_ALT = `${APP}/bot/AltSlot0`;
const HUMAN = `${APP}/user/alice`;

const version = (profileName: string, body: Record<string, unknown>) => ({ schemaVersion: 1, profileName, configId: `${profileName}-cfg`, ...body });
const CONTROL_VERSION = version('advisor', {
  modelKey: 'sonnet', models: { default: 'sonnet', classifier: 'haiku' }, displayName: 'Atlas', systemPromptAddendum: 'be rigorous',
});
const TREATMENT_VERSION = version('alt-primary-premium', {
  modelKey: 'opus', models: { default: 'opus', image: 'nova_canvas' }, displayName: 'Echo', systemPromptAddendum: 'be terse',
});

const VARIANT_FIELDS = ['variantModelKey', 'variantAddendum', 'variantImageModelKey', 'selfDisplayName', 'rivalDisplayName', 'imageGenModelId'];

const invokes = () => mockLambdaSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'Invoke')
  .map((c) => JSON.parse(Buffer.from(c.input.Payload).toString()));
/** The worker dispatch: the invoke that carries the duel's battle context. */
const workerPayload = () => invokes().find((p) => p?.battleContext?.battleId === 'battle-xyz');

describe('a duel side serves its pinned version', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let routerHandler: (e: any) => Promise<unknown>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.CLASSIFICATION = 'premium';
    process.env.ASSISTANT_ROLE = 'primary';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'AgentEchelonAssistants-premium-AgentHandler';
    mockSsmSend.mockImplementation(async (cmd: { __type?: string }) => (cmd?.__type === 'GetByPath'
      ? { Parameters: [{ Value: JSON.stringify({ botArn: BOT_ALT, role: 'primary', occupancy: 'alt', assistant: 'alt-primary-premium' }) }] }
      : { Parameter: { Value: BOT_DEFAULT } }));
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      if (cmd?.__type === 'ListMessages') return { ChannelMessages: [] };
      return { MessageId: 'sent-1' };
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });
    mockGetActiveTaskForOwner.mockResolvedValue(null);
    mockClassificationExperiment.mockResolvedValue(null);
    mockControlSide.mockResolvedValue({
      experimentId: 'exp-1', variantId: 'control', modelKey: 'sonnet', displayName: 'Atlas', variantProfile: CONTROL_VERSION, variantVersion: 3,
    });
    mockTreatmentSide.mockResolvedValue({
      experimentId: 'exp-1', variantId: 'treatment', modelKey: 'opus', displayName: 'Echo', imageGenModelKey: 'nova_canvas', variantProfile: TREATMENT_VERSION, variantVersion: 4,
    });
    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  const duelTurn = (selfBotArn: string) => ({
    aeTurn: {
      channelArn: CHANNEL,
      senderArn: HUMAN,
      userMessage: 'Which database should we pick for the events pipeline?',
      botArn: selfBotArn,
      correlationId: `battle-r1-${selfBotArn.split('/').pop()}`,
      battleContext: {
        battleId: 'battle-xyz', round: 1, totalRounds: 2,
        selfBotArn, rivalBotArn: selfBotArn === BOT_ALT ? BOT_DEFAULT : BOT_ALT,
      },
    },
  });

  it('the control side hands the worker its pinned version, forces no model, and carries no variant field', async () => {
    await routerHandler(duelTurn(BOT_DEFAULT));
    const payload = workerPayload();
    expect(payload).toBeDefined();
    expect(payload.variantProfile).toMatchObject({ profileName: 'advisor', systemPromptAddendum: 'be rigorous', displayName: 'Atlas' });
    // SERVED THROUGH ITS ROUTES: no model rides beside the version.
    expect(payload).not.toHaveProperty('resolvedModel');
    expect(payload).toMatchObject({ experimentId: 'exp-1', variantId: 'control' });
    // AND ITS NUMBER, so the processor attributes the turn to the version it serves.
    expect(payload.variantVersion).toBe(3);
    expect(payload.battleContext.rivalName).toBe('Echo');
    for (const field of VARIANT_FIELDS) expect(payload.battleContext).not.toHaveProperty(field);
  });

  it('the alt side hands the worker ITS version, never the control\'s', async () => {
    await routerHandler(duelTurn(BOT_ALT));
    const payload = workerPayload();
    expect(payload).toBeDefined();
    expect(payload.variantProfile).toMatchObject({ profileName: 'alt-primary-premium', systemPromptAddendum: 'be terse', displayName: 'Echo' });
    expect(payload).not.toHaveProperty('resolvedModel');
    expect(payload.resolvedImageModelKey).toBe('nova_canvas');
    expect(payload.variantVersion).toBe(4);
    expect(payload.battleContext.rivalName).toBe('Atlas');
    for (const field of VARIANT_FIELDS) expect(payload.battleContext).not.toHaveProperty(field);
  });

  it('a side whose pin names no number carries none: the attribution leaves it out rather than guess', async () => {
    mockControlSide.mockResolvedValue({
      experimentId: 'exp-1', variantId: 'control', modelKey: 'sonnet', displayName: 'Atlas', variantProfile: CONTROL_VERSION,
    });
    await routerHandler(duelTurn(BOT_DEFAULT));
    const payload = workerPayload();
    expect(payload.variantProfile).toMatchObject({ profileName: 'advisor' });
    expect(payload).not.toHaveProperty('variantVersion');
  });

  it('each scorecard column carries its OWN side name, the challenger marked when both versions share the live name', async () => {
    // Both pinned versions are versions of the live assistant, so both carry its name; `battleSideNames` marks
    // the challenger's. The scorecard column is titled by the battlestats `name=`, which the processor takes
    // from `battleContext.selfName` alone.
    mockControlSide.mockResolvedValue({
      experimentId: 'exp-1', variantId: 'control', modelKey: 'sonnet', displayName: 'Advisor',
      variantProfile: { ...CONTROL_VERSION, displayName: 'Advisor' },
    });
    mockTreatmentSide.mockResolvedValue({
      experimentId: 'exp-1', variantId: 'treatment', modelKey: 'opus', displayName: 'Advisor (alt)',
      variantProfile: { ...TREATMENT_VERSION, displayName: 'Advisor' },
    });
    await routerHandler(duelTurn(BOT_DEFAULT));
    expect(workerPayload().battleContext).toMatchObject({ selfName: 'Advisor', rivalName: 'Advisor (alt)' });
    mockLambdaSend.mockClear();
    await routerHandler(duelTurn(BOT_ALT));
    expect(workerPayload().battleContext).toMatchObject({ selfName: 'Advisor (alt)', rivalName: 'Advisor' });
  });

  it('the processor names its scorecard column from the side name the turn carries, never from the served version', () => {
    // The marker's `name=` overrides the client's label, and the served version's own name is unmarked, so it
    // would title both columns alike.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src: string = require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    const assignment = src.match(/const battleSelfDisplayName = ([^;]+);/);
    expect(assignment?.[1]).toBe('battleOn ? event.battleContext?.selfName : undefined');
  });

  it('a duel side does not draw a classification experiment: it classifies with its own version', async () => {
    await routerHandler(duelTurn(BOT_DEFAULT));
    expect(mockClassificationExperiment).not.toHaveBeenCalled();
  });
});

/**
 * AN IMAGE REQUEST IN A CLASSIFICATION ALLOWED NO IMAGE MODEL IS REFUSED, IN A DUEL TOO.
 *
 * The catalog allows standard no image model, so neither side has one to use; the turn is refused where
 * any turn for something this classification cannot serve is refused, rather than dispatched to a worker
 * that resolves no image model and fails.
 */
describe('an image request in a classification allowed no image model is refused in a duel', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let routerHandler: (e: any) => Promise<unknown>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.CLASSIFICATION = 'standard';
    process.env.ASSISTANT_ROLE = 'primary';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'AgentEchelonAssistants-standard-AgentHandler';
    mockSsmSend.mockImplementation(async (cmd: { __type?: string }) => (cmd?.__type === 'GetByPath'
      ? { Parameters: [{ Value: JSON.stringify({ botArn: BOT_ALT, role: 'primary', occupancy: 'alt', assistant: 'alt-primary-standard' }) }] }
      : { Parameter: { Value: BOT_DEFAULT } }));
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'standard' }] };
      if (cmd?.__type === 'ListMessages') return { ChannelMessages: [] };
      return { MessageId: 'sent-1' };
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });
    mockGetActiveTaskForOwner.mockResolvedValue(null);
    mockClassificationExperiment.mockResolvedValue(null);
    mockControlSide.mockResolvedValue(null);
    mockTreatmentSide.mockResolvedValue(null);
    mockClassified.intent = 'image_generation';
    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  afterEach(() => { delete mockClassified.intent; });

  it('posts a refusal and dispatches no worker', async () => {
    await routerHandler({
      aeTurn: {
        channelArn: CHANNEL, senderArn: HUMAN, userMessage: 'Draw me a picture of a lighthouse at dusk',
        botArn: BOT_DEFAULT, correlationId: 'battle-r1-img',
        battleContext: { battleId: 'battle-img', round: 1, totalRounds: 2, selfBotArn: BOT_DEFAULT, rivalBotArn: BOT_ALT },
      },
    });
    const sent = mockMessagingSend.mock.calls.map((c) => c[0]).filter((c) => c?.__type === 'SendMessage');
    expect(sent.some((c) => decodeURIComponent(String(c.input.Content)).includes('REFUSED')
      || String(c.input.Metadata ?? '').includes('REFUSED'))).toBe(true);
    expect(invokes().some((p) => p?.battleContext?.battleId === 'battle-img')).toBe(false);
  });
});
