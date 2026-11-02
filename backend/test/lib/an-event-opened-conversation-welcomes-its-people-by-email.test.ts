/**
 * A DECLARED EVENT OPENS THE TYPE ITS DECLARATION NAMES, AT THE DEPLOYED CLASSIFICATION, AND THE PEOPLE IT
 * WAS OPENED FOR ARE WELCOMED BY EMAIL FROM THE ROOM'S ASSISTANT.
 *
 * The rule hands the creator `{ aeOpener, event }` (`lib/constructs/event-opened-conversations.ts`). The type
 * is the declaration's and the classification the deployment's, whatever the event says; the person may be
 * named by address and is found in the deployment's own pool. Once the room exists, the lead and each person
 * the type admitted are welcomed into it privately with `memberWelcome`, named to the router of the room's
 * classification as the room's primary, carrying the email directive the notification bridge sends. Nothing
 * is named for the concerned room, and a welcome that is not said leaves the creation standing.
 */

const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockCreate = jest.fn();
const mockSay = jest.fn();
const mockFindByAddress = jest.fn();
const mockDisplayName = jest.fn();
const mockResolveAllowedSet = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListTags', input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetParameter', input })),
}));
jest.mock('../../lambda/src/lib/channel-creation', () => ({
  createConversationFromEvent: (...args: unknown[]) => mockCreate(...args),
}));
jest.mock('../../lambda/src/lib/service-admin-bearer', () => ({ resolveServiceAdminBearer: async () => '' }));
jest.mock('../../lambda/src/lib/default-agents', () => ({ resolveDefaultAgents: async () => [] }));
jest.mock('../../lambda/src/lib/conversation-primary', () => ({
  primaryAssignmentOf: async () => ({ botArn: BOT }),
}));
jest.mock('../../lambda/src/lib/say-through-router', () => ({
  sayThroughRouter: (...args: unknown[]) => mockSay(...args),
}));
jest.mock('../../lambda/src/lib/membership-source', () => ({
  defaultDirectory: () => ({
    findByAddress: (...args: unknown[]) => mockFindByAddress(...args),
    personOf: async (entry: string) => (entry.includes('/user/') ? entry : null),
    displayNameFor: (...args: unknown[]) => mockDisplayName(...args),
  }),
  resolveAllowedSet: (...args: unknown[]) => mockResolveAllowedSet(...args),
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const BOT = `${APP_INSTANCE}/bot/advisor`;
const LEAD = `${APP_INSTANCE}/user/on-call`;
const TEAMMATE = `${APP_INSTANCE}/user/platform-engineer`;
const CONCERNED = `${APP_INSTANCE}/channel/conv-platform-on-call`;
const NEW_ROOM = `${APP_INSTANCE}/channel/conv-ops-new`;

process.env.APP_INSTANCE_ARN = APP_INSTANCE;
process.env.CLASSIFICATION = 'premium';
process.env.CHANNEL_FLOW_ARN_PARAM = '/test/flow-arn';
process.env.USER_POOL_ID = 'us-east-1_pool';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/typed-conversation-from-event');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { welcomeIntoOpenedConversation, MAX_WELCOMED } = require('../../lambda/src/lib/typed-conversation-notice');

beforeEach(() => {
  jest.clearAllMocks();
  mockSsmSend.mockResolvedValue({ Parameter: { Value: `${APP_INSTANCE}/channel-flow/flow` } });
  mockMessagingSend.mockImplementation(async (cmd: any) => (cmd.__type === 'ListTags' ? { Tags: [{ Key: 'classification', Value: 'premium' }] } : {}));
  mockResolveAllowedSet.mockResolvedValue({ admitted: new Set([LEAD, TEAMMATE]), refused: [], undetermined: new Set() });
  mockCreate.mockResolvedValue({ channelArn: NEW_ROOM, channelId: 'conv-ops-new' });
  mockSay.mockResolvedValue({ posted: true });
  mockFindByAddress.mockImplementation(async (issuer: string, address: string) => (issuer === 'deployment' && address === 'demo-oncall@example.com' ? LEAD : null));
  mockDisplayName.mockImplementation(async (arn: string) => (arn === LEAD ? 'Jordan Reyes' : 'Priya Raman'));
});

/** The ops event as EventBridge delivers it, wrapped as the rule hands it over. */
const fromRule = (detail: Record<string, unknown>, aeOpener = 'ops#0') => ({
  aeOpener,
  event: { version: '0', source: 'ae.ops', 'detail-type': 'Incident opened', detail: { instance: 'agent-echelon', ...detail } },
});
const opsDetail = {
  forPerson: 'demo-oncall@example.com', concernedChannelArn: CONCERNED, topicLabel: 'Report latency', summary: 'Report generation is running slow.',
};

describe('a declared event opens the declaration\'s type at the deployed classification', () => {
  it('opens ops at premium for the person the address names, whatever type or classification the event claims', async () => {
    const result = await handler(fromRule({ ...opsDetail, conversationType: 'general', classification: 'basic' }));
    expect(result).toMatchObject({ ok: true, conversationType: 'ops', channelArn: NEW_ROOM });
    const input = mockCreate.mock.calls[0][0];
    expect(input).toMatchObject({ typeKey: 'ops', classification: 'premium', userArn: LEAD, parentChannelArn: CONCERNED, topicLabel: 'Report latency', issue: 'Report generation is running slow.' });
    expect(mockFindByAddress).toHaveBeenCalledWith('deployment', 'demo-oncall@example.com');
  });

  it('refuses an opener no type declares, and creates and welcomes nothing', async () => {
    const result = await handler(fromRule(opsDetail, 'general#0'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no conversation type declares the opener/);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSay).not.toHaveBeenCalled();
  });

  it('refuses a person the address finds nobody for, rather than opening a room for no one', async () => {
    const result = await handler(fromRule({ ...opsDetail, forPerson: 'stranger@example.com' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/resolves to nobody/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses an event without the concerned conversation an ops room needs', async () => {
    const { concernedChannelArn, ...rest } = opsDetail;
    expect(concernedChannelArn).toBeTruthy();
    const result = await handler(fromRule(rest));
    expect(result.ok).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('the people it was opened for are welcomed by email, by the room\'s assistant', () => {
  it('the lead and every admitted person get memberWelcome in the NEW room, privately, with an email directive', async () => {
    await handler(fromRule(opsDetail));
    expect(mockSay).toHaveBeenCalledTimes(2);
    const notices = mockSay.mock.calls.map(([classification, notice]) => ({ classification, ...notice }));
    for (const n of notices) {
      expect(n).toMatchObject({ classification: 'premium', kind: 'memberWelcome', channelArn: NEW_ROOM, botArn: BOT });
      expect(n.to).toEqual([n.vars.notifyPerson]);
      expect(n.vars).toMatchObject({ recap: 'Report latency', notifySubject: 'Report latency' });
    }
    expect(notices.map((n) => n.vars.notifyPerson)).toEqual([LEAD, TEAMMATE]);
    expect(notices[0].vars.name).toBe('Jordan Reyes');
    expect(JSON.stringify(mockSay.mock.calls)).not.toContain(CONCERNED);
  });

  it('a welcome that is not said, or throws, leaves the creation standing', async () => {
    mockSay.mockResolvedValueOnce({ posted: false, reason: 'no router wired' }).mockRejectedValueOnce(new Error('boom'));
    const result = await handler(fromRule(opsDetail));
    expect(result.ok).toBe(true);
  });

  it('a refused creation welcomes nobody', async () => {
    mockResolveAllowedSet.mockResolvedValue({ admitted: new Set([TEAMMATE]), refused: [], undetermined: new Set() });
    const result = await handler(fromRule(opsDetail));
    expect(result.ok).toBe(false);
    expect(mockSay).not.toHaveBeenCalled();
  });

  it('welcomes each person once, the lead first, and at most a bounded number', async () => {
    const people = Array.from({ length: MAX_WELCOMED + 5 }, (_, i) => `${APP_INSTANCE}/user/p${i}`);
    const say = jest.fn(async () => ({ posted: true }));
    const out = await welcomeIntoOpenedConversation(
      { classification: 'premium', channelArn: NEW_ROOM, botArn: BOT, leadArn: LEAD, people: [LEAD, ...people, BOT], topicLabel: 'x' },
      { say },
    );
    expect(say).toHaveBeenCalledTimes(MAX_WELCOMED);
    expect((say.mock.calls[0] as unknown[])[1]).toMatchObject({ to: [LEAD] });
    expect(out).toEqual({ said: MAX_WELCOMED, notSaid: 6 });
  });
});
