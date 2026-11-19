/**
 * THE RUN THAT ASKED FOR A ROOM GOES ON AS SOON AS THE ROOM STANDS (`typed-conversation-from-event.ts`).
 *
 * An `open` step (an incident from a team room) waits for the creator to hand its run back with the new room's link,
 * and the run's next step tells the team room where the room is. The room appears in its members' lists the moment they
 * are added, so the link follows at once: the hand-back comes before the room's own `conversation-opened` run and its
 * welcomes, never after them. A failure after the hand-back hands nothing back a second time.
 */

const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockCreate = jest.fn();
const mockCalls: string[] = [];
const mockContinue = jest.fn();
const mockNameEvent = jest.fn();
const mockPersonJoined = jest.fn();
const mockFindByAddress = jest.fn();
const mockResolveAllowedSet = jest.fn();

// THE CONCERNED ROOM'S ROW, as the nesting rule reads it (`openIsNestedBy`): a top-level room, which may open a child.
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  readChannelContext: async () => null,
}));
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
jest.mock('../../lambda/src/lib/router-arn', () => ({ resolveRouterArn: async () => 'arn:aws:lambda:us-east-1:111:function:router' }));
jest.mock('../../lambda/src/lib/say-through-router', () => ({
  sayThroughRouter: async () => ({ posted: true }),
  continueEventRunThroughRouter: (...args: unknown[]) => mockContinue(...args),
  nameEventThroughRouter: (...args: unknown[]) => mockNameEvent(...args),
  personJoinedThroughRouter: (...args: unknown[]) => mockPersonJoined(...args),
}));
jest.mock('../../lambda/src/lib/membership-source', () => ({
  defaultDirectory: () => ({
    findByAddress: (...args: unknown[]) => mockFindByAddress(...args),
    personOf: async (entry: string) => (entry.includes('/user/') ? entry : null),
    displayNameFor: async () => 'Jordan Reyes',
  }),
  resolveAllowedSet: (...args: unknown[]) => mockResolveAllowedSet(...args),
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const BOT = `${APP_INSTANCE}/bot/advisor`;
const LEAD = `${APP_INSTANCE}/user/on-call`;
const CONCERNED = `${APP_INSTANCE}/channel/team-ops-team-premium`;
const NEW_ROOM = `${APP_INSTANCE}/channel/conv-ops-new`;

process.env.APP_INSTANCE_ARN = APP_INSTANCE;
process.env.CLASSIFICATION = 'premium';
process.env.CHANNEL_FLOW_ARN_PARAM = '/test/flow-arn';
process.env.USER_POOL_ID = 'us-east-1_pool';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/typed-conversation-from-event');

const continueRun = {
  runKey: 'event-received#rule-1#advisor', workflow: 'incident-triage', step: 'open', event: 'event-received',
  channelArn: CONCERNED, botArn: BOT, values: {},
};
beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockSsmSend.mockResolvedValue({ Parameter: { Value: `${APP_INSTANCE}/channel-flow/flow` } });
  mockMessagingSend.mockImplementation(async (cmd: any) => (cmd.__type === 'ListTags' ? { Tags: [{ Key: 'classification', Value: 'premium' }] } : {}));
  mockResolveAllowedSet.mockResolvedValue({ admitted: new Set([LEAD]), refused: [], undetermined: new Set() });
  mockCreate.mockResolvedValue({ channelArn: NEW_ROOM, channelId: 'conv-ops-new' });
  mockFindByAddress.mockResolvedValue(LEAD);
  mockContinue.mockImplementation(async (_router: string, run: { outcome: string }) => { mockCalls.push(`continue:${run.outcome}`); return true; });
  mockNameEvent.mockImplementation(async () => { mockCalls.push('opening'); return { ran: true, people: [LEAD] }; });
  mockPersonJoined.mockImplementation(async () => { mockCalls.push('joined'); return new Set<string>(); });
});

describe('the run that asked for a room goes on as soon as the room stands', () => {
  it('hands the run back with the room\'s link before the room\'s own opening and welcomes run', async () => {
    const result = await handler({ conversationType: 'ops', forUserArn: LEAD, concernedChannelArn: CONCERNED, topicLabel: 'Report latency', continueRun });
    expect(result).toMatchObject({ ok: true, channelArn: NEW_ROOM });
    expect(mockCalls[0]).toBe('continue:opened');
    expect(mockCalls.indexOf('continue:opened')).toBeLessThan(mockCalls.indexOf('opening'));
    const [, run] = mockContinue.mock.calls[0];
    expect(run.values).toMatchObject({ conversation_link: '?conversation=conv-ops-new' });
  });

  it('hands the run back once, even when the room\'s opening throws afterwards', async () => {
    mockNameEvent.mockImplementation(() => { throw new Error('router unreachable'); });
    mockPersonJoined.mockImplementation(() => { throw new Error('router unreachable'); });
    await handler({ conversationType: 'ops', forUserArn: LEAD, concernedChannelArn: CONCERNED, topicLabel: 'Report latency', continueRun });
    expect(mockContinue).toHaveBeenCalledTimes(1);
    expect(mockContinue.mock.calls[0][1].outcome).toBe('opened');
  });

  it('a room that is not created hands the run back as failed', async () => {
    mockCreate.mockRejectedValue(new Error('CreateChannel refused'));
    // As EventBridge or the router delivers it: the run rides the envelope's detail.
    const result = await handler({ detail: { conversationType: 'ops', forUserArn: LEAD, concernedChannelArn: CONCERNED, topicLabel: 'Report latency', continueRun } });
    expect(result.ok).toBe(false);
    expect(mockCalls).toEqual(['continue:failed']);
  });
});
