/**
 * A TYPED CONVERSATION OPENED BY AN EVENT POSTS NOTHING INTO THE CONVERSATION THE EVENT CONCERNED.
 *
 * The concerned room has its own audience, and what an incident room holds is not that audience's to
 * read (DESIGN-CONVERSATION-TYPES §11). So the event path sends no message there, names no notice to a
 * router for it, and reads none of its members. It still refuses a concerned room at another
 * classification rather than linking across that boundary.
 */

const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockCreate = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __type: 'SendMessage', input })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListTags', input })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListMemberships', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetParameter', input })),
}));
// A notice named to any router would be invoked here: nothing may be.
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((input) => ({ __type: 'Invoke', input })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}));
jest.mock('../../lambda/src/lib/channel-creation', () => ({
  createConversationFromEvent: (...args: unknown[]) => mockCreate(...args),
}));
jest.mock('../../lambda/src/lib/service-admin-bearer', () => ({
  resolveServiceAdminBearer: async () => '',
}));
jest.mock('../../lambda/src/lib/default-agents', () => ({
  resolveDefaultAgents: async () => [],
}));
jest.mock('../../lambda/src/lib/conversation-primary', () => ({
  primaryAssignmentOf: async () => ({ botArn: `${APP_INSTANCE}/bot/advisor` }),
  primaryAssistantOf: jest.fn(async () => { throw new Error('the concerned room\'s assistant must not be resolved'); }),
}));
jest.mock('../../lambda/src/lib/membership-source', () => ({
  defaultDirectory: () => ({}),
  resolveAllowedSet: async () => ({ admitted: new Set([LEAD]), refused: [], undetermined: new Set() }),
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const LEAD = `${APP_INSTANCE}/user/on-call`;
const CONCERNED = `${APP_INSTANCE}/channel/conv-customer-room`;

process.env.APP_INSTANCE_ARN = APP_INSTANCE;
process.env.CLASSIFICATION = 'premium';
process.env.CHANNEL_FLOW_ARN_PARAM = '/test/flow-arn';
process.env.USER_POOL_ID = 'us-east-1_pool';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/typed-conversation-from-event');

let concernedClassification = 'premium';

beforeEach(() => {
  jest.clearAllMocks();
  concernedClassification = 'premium';
  mockSsmSend.mockResolvedValue({ Parameter: { Value: `${APP_INSTANCE}/channel-flow/flow` } });
  mockMessagingSend.mockImplementation(async (cmd: any) => {
    if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: concernedClassification }] };
    return {};
  });
  mockCreate.mockResolvedValue({ channelArn: `${APP_INSTANCE}/channel/conv-ops-new`, channelId: 'conv-ops-new' });
});

const event = {
  detail: {
    conversationType: 'ops',
    concernedChannelArn: CONCERNED,
    forUserArn: LEAD,
    topicLabel: 'Report latency',
    summary: 'Report generation is running slow.',
  },
};

describe('an event-opened conversation and the room the event concerned', () => {
  it('opens the conversation with the concerned room as its parent', async () => {
    const result = await handler(event);
    expect(result.ok).toBe(true);
    expect(mockCreate.mock.calls[0][0].parentChannelArn).toBe(CONCERNED);
  });

  it('posts nothing into the concerned room, names no notice for it, and reads none of its members', async () => {
    await handler(event);
    // The only call against the concerned room is the classification tag read.
    const concernedCalls = mockMessagingSend.mock.calls
      .map((c) => c[0] as any)
      .filter((cmd) => JSON.stringify(cmd.input ?? {}).includes(CONCERNED));
    expect(concernedCalls.map((cmd) => cmd.__type)).toEqual(['ListTags']);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('still refuses a concerned room at another classification, and creates nothing', async () => {
    concernedClassification = 'standard';
    const result = await handler(event);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/classified "standard"/);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});
