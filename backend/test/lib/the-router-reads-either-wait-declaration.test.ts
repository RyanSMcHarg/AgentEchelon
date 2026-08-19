/**
 * The router's "does this person owe an answer" check reads BOTH accepted wait declarations
 * (SPEC-TASK-STATE-TRANSITIONS §12.6).
 *
 * This is the consumer with the widest blast radius and the quietest failure. The licence to read an
 * ordinary message as the answer to a step is the machine declaring that it cannot go further without
 * one; a router that reads only `awaitsUser` decides that a machine authored with `awaits` blocks on
 * nobody, so a person's answer to the assistant's own question becomes an unrelated turn. Nothing
 * errors. The workflow simply stops being continued, which looks like an assistant that forgot.
 *
 * A deployment's pack is the form that can differ from the platform's, since it is authored elsewhere
 * and may predate the declared form, so the machine under test comes through `ASSISTANT_INTENT_PACK`
 * and the same turn is driven against each spelling of it.
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

const mockGetActiveTaskForOwner = jest.fn();
const mockGetActiveTask = jest.fn();
const mockApplyUserResponseToTask = jest.fn();

jest.mock('../../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getActiveTaskForOwner: (...a: unknown[]) => mockGetActiveTaskForOwner(...a),
    getActiveTasksForOwnerInChannel: async (...a: unknown[]) => {
      const t = await mockGetActiveTaskForOwner(...a);
      return t ? [t] : [];
    },
    getOwnerChannelTasks: async (...a: unknown[]) => {
      const t = await mockGetActiveTaskForOwner(...a);
      return { live: t ? [t] : [], recentlyEnded: [] };
    },
    getActiveTask: (...a: unknown[]) => mockGetActiveTask(...a),
    applyUserResponseToTask: (...a: unknown[]) => mockApplyUserResponseToTask(...a),
  };
}, { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT = `${APP}/bot/premium-bot`;
const HUMAN = `${APP}/user/alice`;
const principalIdOf = (arn: string) => arn.split('/').pop() || arn;

/** A pack whose one machine spells its wait however the case under test wants it spelled. */
const packWith = (waiting: Record<string, unknown>) => JSON.stringify({
  intents: [{ key: 'reporting', description: 'a report request', keywords: ['report'] }],
  machines: {
    parity_flow: {
      initial: 'waiting',
      states: {
        waiting: { transitions: ['working'], ...waiting },
        working: { transitions: ['done'] },
        done: { transitions: [], terminal: 'success' },
      },
    },
  },
});

const FORMS: Array<[string, Record<string, unknown>]> = [
  ['the declared form', { awaits: { party: 'requester' } }],
  ['the deprecated boolean', { awaitsUser: true }],
];

const turn = (userMessage: string) => ({
  aeTurn: { channelArn: CHANNEL, senderArn: HUMAN, userMessage, botArn: BOT },
});

/** The assistant holds the chain; the person holds nothing, so the assistant's own chain is consulted. */
const assistantHolds = (taskState: string) =>
  mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
    ownerId === principalIdOf(BOT)
      ? { taskId: 't-parity', taskType: 'parity_flow', taskState, channelArn: CHANNEL }
      : null);

async function loadRouter(packMachineWait: Record<string, unknown>) {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.ASSISTANT_INTENT_PACK = packWith(packMachineWait);
  process.env.ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';
  process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
  mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT } });
  mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
    if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
    return { MessageId: 'sent-1' };
  });
  mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });
  mockGetActiveTaskForOwner.mockResolvedValue(null);
  mockGetActiveTask.mockResolvedValue(null);
  const { _resetIntentPackCache } = await import('../../lambda/src/lib/intent-pack.js');
  _resetIntentPackCache();
  const { handler } = await import('../../lambda/src/router-agent-handler.js');
  return handler as (e: unknown) => Promise<unknown>;
}

afterEach(() => {
  delete process.env.ASSISTANT_INTENT_PACK;
});

describe('a chain blocked on a person is resumed however the machine spelled the wait', () => {
  it.each(FORMS)('resumes the waiting step declared in %s', async (_label, waiting) => {
    const handler = await loadRouter(waiting);
    assistantHolds('waiting');

    await handler(turn('the audience is engineering leadership'));

    expect(mockApplyUserResponseToTask).toHaveBeenCalled();
    expect(mockApplyUserResponseToTask.mock.calls[0][0].taskId).toBe('t-parity');
  });

  it.each(FORMS)('does not annex an ordinary message into a step that awaits nobody, alongside %s', async (_label, waiting) => {
    // The negative half, and the reason the positive one is not satisfied by a branch that always
    // runs: a chain merely IN PROGRESS must leave a person's message alone.
    const handler = await loadRouter(waiting);
    assistantHolds('working');

    await handler(turn('unrelated: what is our leave policy?'));

    expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
  });
});
