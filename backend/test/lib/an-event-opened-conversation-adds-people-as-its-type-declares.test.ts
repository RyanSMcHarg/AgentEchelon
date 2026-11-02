/**
 * An event-opened conversation takes its PEOPLE from its type's membership source (DESIGN-CONVERSATION-TYPES
 * §6), never from the conversation the event happened to concern.
 *
 * `ops` and `ops-team` source their people from the `ops` group: the creator adds the group's members the
 * classification admits, and the reconcile keeps it that way. The lead the event names must be among them,
 * or the first reconcile would remove the person the room was opened for - so that is a refusal. A type that
 * declares no source is manual and adds only the lead.
 */

const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockCreate = jest.fn();
const mockResolveAllowedSet = jest.fn();

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
jest.mock('../../lambda/src/lib/channel-creation', () => ({
  createConversationFromEvent: (...args: unknown[]) => mockCreate(...args),
}));
jest.mock('../../lambda/src/lib/service-admin-bearer', () => ({
  resolveServiceAdminBearer: async () => '',
}));
jest.mock('../../lambda/src/lib/default-agents', () => ({
  resolveDefaultAgents: async () => [],
}));
jest.mock('../../lambda/src/lib/membership-source', () => ({
  defaultDirectory: () => ({}),
  resolveAllowedSet: (...args: unknown[]) => mockResolveAllowedSet(...args),
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const BOT = `${APP_INSTANCE}/bot/advisor`;
const LEAD = `${APP_INSTANCE}/user/on-call`;
const TEAMMATE = `${APP_INSTANCE}/user/platform-engineer`;
const CONCERNED = `${APP_INSTANCE}/channel/conv-platform-on-call`;
// In the concerned room and NOT in the ops group: never added to the new room.
const BYSTANDER = `${APP_INSTANCE}/user/engineering-manager`;

process.env.APP_INSTANCE_ARN = APP_INSTANCE;
process.env.CLASSIFICATION = 'premium';
process.env.BOT_ARN_PARAM = '/test/bot-arn';
process.env.CHANNEL_FLOW_ARN_PARAM = '/test/flow-arn';
process.env.USER_POOL_ID = 'us-east-1_pool';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/typed-conversation-from-event');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CONVERSATION_TYPES } = require('../../lib/config/conversation-types');

beforeEach(() => {
  mockMessagingSend.mockReset();
  mockSsmSend.mockReset();
  mockCreate.mockReset();
  mockResolveAllowedSet.mockReset();
  mockSsmSend.mockImplementation(async (cmd: any) => ({
    Parameter: { Value: cmd.input.Name === '/test/bot-arn' ? BOT : `${APP_INSTANCE}/channel-flow/flow` },
  }));
  mockMessagingSend.mockImplementation(async (cmd: any) => {
    if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
    if (cmd.__type === 'ListMemberships') {
      return { ChannelMemberships: [
        { Member: { Arn: LEAD, Name: 'Riley Oncall' } },
        { Member: { Arn: BYSTANDER, Name: 'Dana Manager' } },
        { Member: { Arn: BOT, Name: 'Advisor' } },
      ] };
    }
    return {};
  });
  mockResolveAllowedSet.mockResolvedValue({
    admitted: new Set([LEAD, TEAMMATE]), refused: [], undetermined: new Set(),
  });
  mockCreate.mockResolvedValue({ channelArn: `${APP_INSTANCE}/channel/conv-ops-new`, channelId: 'conv-ops-new' });
});

const event = (conversationType: string, concerned: string | null = CONCERNED) => ({
  detail: {
    conversationType,
    ...(concerned ? { concernedChannelArn: concerned } : {}),
    forUserArn: LEAD,
    topicLabel: 'Report latency',
    summary: 'Report generation is running slow.',
  },
});

describe('an event-opened conversation adds people as its type\'s membership source declares', () => {
  it('ops adds the ops group\'s admitted members, resolved against premium', async () => {
    const result = await handler(event('ops'));
    expect(result.ok).toBe(true);
    expect(mockResolveAllowedSet).toHaveBeenCalledWith({ group: 'ops' }, 'premium', APP_INSTANCE, expect.anything(), 'ops');
    expect(mockCreate.mock.calls[0][0].additionalMemberArns.sort()).toEqual([LEAD, TEAMMATE].sort());
  });

  it('adds nobody from the concerned conversation\'s roster', async () => {
    await handler(event('ops'));
    expect(mockCreate.mock.calls[0][0].additionalMemberArns).not.toContain(BYSTANDER);
  });

  it('refuses when the lead is not admitted by the source, rather than opening a room they would be removed from', async () => {
    mockResolveAllowedSet.mockResolvedValue({ admitted: new Set([TEAMMATE]), refused: [], undetermined: new Set() });
    const result = await handler(event('ops'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/membership source/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a manual type adds only the person the event named, and resolves no group', async () => {
    CONVERSATION_TYPES['tmp-manual-alert'] = { classifications: ['premium'], driftEnabled: false, initiation: 'alert' };
    try {
      const result = await handler(event('tmp-manual-alert'));
      expect(result.ok).toBe(true);
      expect(mockResolveAllowedSet).not.toHaveBeenCalled();
      expect(mockCreate.mock.calls[0][0].additionalMemberArns).toEqual([]);
      expect(mockCreate.mock.calls[0][0].userArn).toBe(LEAD);
    } finally {
      delete CONVERSATION_TYPES['tmp-manual-alert'];
    }
  });

  it('the ops team room opens with no concerned conversation, because the platform opens it', async () => {
    const result = await handler(event('ops-team', null));
    expect(result.ok).toBe(true);
    expect(mockCreate.mock.calls[0][0].parentChannelArn).toBeUndefined();
    // Nothing to post a link back into.
    expect(mockMessagingSend.mock.calls.map((c) => c[0].__type)).not.toContain('SendMessage');
  });

  it('a type a person or an event must open is refused without a concerned conversation', async () => {
    const result = await handler(event('ops', null));
    expect(result.ok).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
