/**
 * THE RE-DISPATCHERS DECLINE RATHER THAN BORROW A ROUTER (ADR-046).
 *
 * Queue triage, the stop evaluation and the handover backstop each hand a turn back to a router. A
 * classification with no router of its own declines the dispatch; none of them picks another
 * classification's router. The flow's `@all` path and task-answer repair are pinned in
 * `all-mention-single-path.test.ts` and `task-answer-repair.test.ts`, the battle round in
 * `battle-orchestrator.test.ts`, and the table itself in `router-arn.test.ts`.
 */
const mockSsmSend = jest.fn();
const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
let mockCapturedDeps: { dispatch: (turn: unknown) => Promise<boolean> } | undefined;

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
}), { virtual: true });

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ...jest.requireActual('@aws-sdk/client-chime-sdk-messaging'),
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}), { virtual: true });

// The backstop's routing decision is tested on its own; here only the dispatch it is handed matters.
jest.mock('../../lambda/src/lib/handover-routing', () => ({
  routeHandover: jest.fn(async (_input: unknown, deps: { dispatch: (turn: unknown) => Promise<boolean> }) => {
    mockCapturedDeps = deps;
  }),
}));
jest.mock('../../lambda/src/lib/assistant-handover', () => ({
  ...jest.requireActual('../../lambda/src/lib/assistant-handover'),
  parseHandover: () => ({}),
}));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const OWN_ROUTER = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium-from-parameter';
const STANDARD_ROUTER = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';

const saved = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockCapturedDeps = undefined;
  for (const k of Object.keys(process.env)) if (k.endsWith('_ROUTER_ARN')) delete process.env[k];
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...saved };
});

describe('resolveRouterArn (queue triage, amendments, the stop evaluation)', () => {
  const load = () => require('../../lambda/src/lib/turn-triage') as typeof import('../../lambda/src/lib/turn-triage');

  beforeEach(() => {
    // A premium processor: it holds the parameter naming PREMIUM's router and no router variables.
    process.env.CLASSIFICATION = 'premium';
    process.env.ROUTER_ARN_PARAM = '/agent-echelon/assistant/premium/router-arn';
    mockSsmSend.mockResolvedValue({ Parameter: { Value: OWN_ROUTER } });
  });

  it('reads the parameter for a turn of its own classification', async () => {
    expect(await load().resolveRouterArn('premium')).toBe(OWN_ROUTER);
  });

  it('never answers another classification with its own router', async () => {
    const { resolveRouterArn } = load();
    expect(await resolveRouterArn('basic')).toBeUndefined();
    expect(await resolveRouterArn('standard')).toBeUndefined();
    expect(mockSsmSend).not.toHaveBeenCalled();
  });

  it('a cross-stack caller with only STANDARD wired declines a premium turn', async () => {
    delete process.env.CLASSIFICATION;
    delete process.env.ROUTER_ARN_PARAM;
    process.env.STANDARD_ROUTER_ARN = STANDARD_ROUTER;
    expect(await load().resolveRouterArn('premium')).toBeUndefined();
  });

  it('an unreadable parameter declines rather than reaching for another router', async () => {
    mockSsmSend.mockRejectedValue(new Error('AccessDenied'));
    process.env.STANDARD_ROUTER_ARN = STANDARD_ROUTER;
    expect(await load().resolveRouterArn('premium')).toBeUndefined();
  });
});

describe('the handover backstop', () => {
  const dispatchFor = async (tag: string | undefined) => {
    mockMessagingSend.mockResolvedValue({ Tags: tag === undefined ? [] : [{ Key: 'classification', Value: tag }] });
    const { deliverMissedHandover } = require('../../lambda/src/lib/handover-backstop');
    await deliverMissedHandover({
      EventType: 'CREATE_CHANNEL_MESSAGE',
      Payload: { MessageId: 'h-1', ChannelArn: CHANNEL, Content: '', Metadata: '{}', Sender: { Arn: `${APP}/bot/a` } },
    });
    expect(mockCapturedDeps).toBeDefined();
    return mockCapturedDeps!.dispatch({
      channelArn: CHANNEL,
      marker: { personSenderArn: `${APP}/user/alice`, personMessageId: 'p-1' },
      receiverBotArn: `${APP}/bot/b`,
      privateToPerson: true,
      handoverMessageId: 'h-1',
    });
  };
  const invoked = () => mockLambdaSend.mock.calls.map((c) => c[0]?.input?.FunctionName);

  it('dispatches to the conversation classification\'s own router (positive control)', async () => {
    process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
    mockLambdaSend.mockResolvedValue({});
    expect(await dispatchFor('premium')).toBe(true);
    expect(invoked()).toEqual(['arn:aws:lambda:us-east-1:111122223333:function:router-premium']);
  });

  it('declines a premium conversation whose router is unset, with standard\'s wired', async () => {
    process.env.STANDARD_ROUTER_ARN = STANDARD_ROUTER;
    expect(await dispatchFor('premium')).toBe(false);
    expect(invoked()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Handover] no router'), expect.objectContaining({ classification: 'premium' }));
  });

  it('declines a conversation with no readable classification', async () => {
    process.env.STANDARD_ROUTER_ARN = STANDARD_ROUTER;
    expect(await dispatchFor(undefined)).toBe(false);
    expect(invoked()).toEqual([]);
  });
});
