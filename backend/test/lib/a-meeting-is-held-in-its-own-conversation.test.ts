/**
 * A MEETING IS HELD IN ITS OWN CONVERSATION (SPEC-ASSISTANT-MEETINGS FR27, FR42, FR43).
 *
 * The classification's creator opens a meeting's conversation and admits a person to one, asked by the Meetings stack's
 * meeting function, which checked the person first:
 *  - `open`: a `meeting` conversation at this classification only, owned by the primary of the conversation it was started
 *    from, whose row names that conversation before it is answered, for the person who started the meeting or for nobody;
 *    a meeting's conversation opens none of its own, and an archived conversation opens none;
 *    every person the parent conversation holds, cleared for the classification now, is its member from the moment it opens;
 *  - `admit`: one person, to a meeting's conversation at this classification, by the rule the meeting function applies
 *    (`meeting-admission.ts`), for the conversation whose membership that function proved, and to nothing else.
 */

const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockCreate = jest.fn();
const mockAdd = jest.fn();
const mockGetContext = jest.fn();
const mockRecordMeetingOf = jest.fn();
const mockRoomPrimary = jest.fn();
const mockClassificationPrimary = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListTags', input })),
  SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __type: 'SendMessage', input })),
  DescribeChannelMembershipCommand: jest.fn().mockImplementation((input) => ({ __type: 'DescribeMembership', input })),
  DescribeChannelCommand: jest.fn().mockImplementation((input) => ({ __type: 'DescribeChannel', input })),
  ListChannelMembershipsForAppInstanceUserCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListMemberships', input })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListChannelMemberships', input })),
  ListChannelModeratorsCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListChannelModerators', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetParameter', input })),
}));
jest.mock('../../lambda/src/lib/channel-creation', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-creation'),
  createConversationFromEvent: (...args: unknown[]) => mockCreate(...args),
  addInvitedMember: (...args: unknown[]) => mockAdd(...args),
}));
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  readChannelContext: (...args: unknown[]) => mockGetContext(...args),
  recordMeetingOf: (...args: unknown[]) => mockRecordMeetingOf(...args),
}));
jest.mock('../../lambda/src/lib/service-admin-bearer', () => ({
  resolveServiceAdminBearer: async () => `${APP_INSTANCE}/user/ae-admin`,
}));
jest.mock('../../lambda/src/lib/conversation-primary', () => ({
  ...jest.requireActual('../../lambda/src/lib/conversation-primary'),
  primaryAssignmentOf: (...a: unknown[]) => mockClassificationPrimary(...a),
  primaryAssistantOf: (...a: unknown[]) => mockRoomPrimary(...a),
}));
const mockClearance = jest.fn();
jest.mock('../../lambda/src/lib/membership-source', () => ({
  ...jest.requireActual('../../lambda/src/lib/membership-source'),
  defaultDirectory: () => ({ clearanceOf: (...a: unknown[]) => mockClearance(...a) }),
}));
const mockLiveAssistants = jest.fn();
jest.mock('../../lambda/src/lib/default-agents', () => ({
  ...jest.requireActual('../../lambda/src/lib/default-agents'),
  liveAssistantsByHandleOrThrow: (...a: unknown[]) => mockLiveAssistants(...a),
}));
jest.mock('../../lambda/src/lib/message-template-selection', () => ({
  ...jest.requireActual('../../lambda/src/lib/message-template-selection'),
  loadMessageTemplateSet: async () => undefined,
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
// A host-context conversation keeps the `_` its customer id carries: every conversation id the meeting function accepts
// is one the creator accepts.
const ROOM = `${APP_INSTANCE}/channel/ctx-basic-plan-cus_123.a`;
const MEETING = `${APP_INSTANCE}/channel/meet-1`;
const PERSON = `${APP_INSTANCE}/user/person-1`;
const CONCIERGE_BOT = `${APP_INSTANCE}/bot/concierge`;
const OPS_BOT = `${APP_INSTANCE}/bot/ops`;
const SENTINEL_BOT = `${APP_INSTANCE}/bot/sentinel`;
/** The assistants each conversation holds, as the membership read answers them. */
const assistantMembers: Record<string, string[]> = {};
/** The people who are NOT members of a conversation; every other person is. */
const notMembers: Record<string, string[]> = {};
/** The members each conversation lists, people and assistants, and its moderators. */
const listed: Record<string, string[]> = {};
const moderators: Record<string, string[]> = {};

process.env.APP_INSTANCE_ARN = APP_INSTANCE;
process.env.CLASSIFICATION = 'premium';
process.env.CHANNEL_FLOW_ARN_PARAM = '/test/flow-arn';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, watchesRefLive, resolvePrimary } = require('../../lambda/src/typed-conversation-from-event');

const tags: Record<string, Record<string, string>> = {};
const rows: Record<string, Record<string, unknown>> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(tags)) delete tags[k];
  for (const k of Object.keys(rows)) delete rows[k];
  tags[ROOM] = { classification: 'premium' };
  tags[MEETING] = { classification: 'premium' };
  rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING, at: 'x' } };
  rows[MEETING] = { conversationType: 'meeting', meetingOf: ROOM };
  for (const k of Object.keys(assistantMembers)) delete assistantMembers[k];
  for (const k of Object.keys(notMembers)) delete notMembers[k];
  for (const k of Object.keys(listed)) delete listed[k];
  for (const k of Object.keys(moderators)) delete moderators[k];
  assistantMembers[ROOM] = [CONCIERGE_BOT];
  mockClearance.mockResolvedValue({ state: 'held', token: 'premium' });
  mockSsmSend.mockResolvedValue({ Parameter: { Value: `${APP_INSTANCE}/channel-flow/flow` } });
  mockMessagingSend.mockImplementation(async (cmd: { __type: string; input: { ResourceARN: string; ChannelArn: string; MemberArn: string } }) => {
    if (cmd.__type === 'ListTags') return { Tags: Object.entries(tags[cmd.input.ResourceARN] ?? {}).map(([Key, Value]) => ({ Key, Value })) };
    if (cmd.__type === 'DescribeChannel') return { Channel: { Name: 'Report Latency' } };
    if (cmd.__type === 'ListChannelMemberships') return { ChannelMemberships: (listed[cmd.input.ChannelArn] ?? []).map((Arn) => ({ Member: { Arn } })) };
    if (cmd.__type === 'ListChannelModerators') return { ChannelModerators: (moderators[cmd.input.ChannelArn] ?? []).map((Arn) => ({ Moderator: { Arn } })) };
    if (cmd.__type === 'DescribeMembership' && cmd.input.MemberArn.includes('/bot/')) {
      if ((assistantMembers[cmd.input.ChannelArn] ?? []).includes(cmd.input.MemberArn)) return { ChannelMembership: { Member: { Arn: cmd.input.MemberArn } } };
      throw Object.assign(new Error('not a member'), { name: 'NotFoundException' });
    }
    if (cmd.__type === 'DescribeMembership' && (notMembers[cmd.input.ChannelArn] ?? []).includes(cmd.input.MemberArn)) {
      throw Object.assign(new Error('not a member'), { name: 'NotFoundException' });
    }
    return {};
  });
  mockLiveAssistants.mockResolvedValue(new Map([
    ['concierge', { handle: 'concierge', botArn: CONCIERGE_BOT, role: 'primary' }],
    ['ops-premium', { handle: 'ops-premium', botArn: OPS_BOT, role: 'ops' }],
    ['sentinel', { handle: 'sentinel', botArn: SENTINEL_BOT, role: 'ops' }],
  ]));
  mockGetContext.mockImplementation(async (arn: string) => rows[arn] ?? null);
  mockCreate.mockResolvedValue({ channelArn: MEETING, channelId: 'meet-1' });
  mockRecordMeetingOf.mockResolvedValue(true);
  mockAdd.mockResolvedValue(undefined);
  mockRoomPrimary.mockResolvedValue({ assistant: 'concierge', botArn: `${APP_INSTANCE}/bot/concierge`, classification: 'premium', source: 'tag' });
  mockClassificationPrimary.mockResolvedValue({ assistant: 'advisor', botArn: `${APP_INSTANCE}/bot/advisor` });
});

describe('opening a meeting\'s conversation', () => {
  it('opens a `meeting` conversation at this classification, for the person, linked to the room, and records the room on it', async () => {
    const out = await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON });
    expect(out).toEqual({ ok: true, channelArn: MEETING });
    const input = mockCreate.mock.calls[0][0];
    expect(input).toMatchObject({ typeKey: 'meeting', classification: 'premium', userArn: PERSON, parentChannelArn: ROOM, additionalMemberArns: [] });
    expect(mockRecordMeetingOf).toHaveBeenCalledWith(MEETING, ROOM);
    // The parent conversation holds nobody else, so nobody else is added; nothing is added back in the parent conversation.
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('holds everyone in the parent conversation from the moment it opens, through the canonical write, as the service admin', async () => {
    const B = `${APP_INSTANCE}/user/person-2`;
    const C = `${APP_INSTANCE}/user/person-3`;
    listed[ROOM] = [PERSON, B, CONCIERGE_BOT, C];
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: true, channelArn: MEETING });
    const added = mockAdd.mock.calls.map((c) => c[0]);
    // The person it was opened for is its member already, and an assistant is never carried as a person.
    expect(added.map((a) => a.inviteeArn).sort()).toEqual([B, C].sort());
    for (const a of added) expect(a).toEqual({ channelArn: MEETING, inviteeArn: a.inviteeArn, bearerArn: `${APP_INSTANCE}/user/ae-admin` });
    expect(added.every((a) => a.channelArn === MEETING)).toBe(true);
  });

  it('DENY: never holds a person of the parent conversation whose clearance does not reach the classification now', async () => {
    const B = `${APP_INSTANCE}/user/person-2`;
    const UNCLEARED = `${APP_INSTANCE}/user/basic-only`;
    listed[ROOM] = [PERSON, B, UNCLEARED];
    mockClearance.mockImplementation(async (arn: string) => ({ state: 'held', token: arn === UNCLEARED ? 'basic' : 'premium' }));
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: true, channelArn: MEETING });
    expect(mockAdd.mock.calls.map((c) => c[0].inviteeArn)).toEqual([B]);
  });

  it("opens even where the parent conversation's people cannot be read: each enters by joining, as a person added to the parent conversation later does", async () => {
    mockMessagingSend.mockImplementation(async (cmd: { __type: string; input: { ResourceARN: string; MemberArn: string; ChannelArn: string } }) => {
      if (cmd.__type === 'ListTags') return { Tags: Object.entries(tags[cmd.input.ResourceARN] ?? {}).map(([Key, Value]) => ({ Key, Value })) };
      if (cmd.__type === 'ListChannelMemberships') throw Object.assign(new Error('throttled'), { name: 'ThrottledClientException' });
      if (cmd.__type === 'DescribeMembership' && cmd.input.MemberArn.includes('/bot/')) throw Object.assign(new Error('no'), { name: 'NotFoundException' });
      return {};
    });
    // The meeting function asks for the rest after the answer (`carry`).
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: true, channelArn: MEETING, carryLeft: true });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('answers that people were left when one could not be carried by the answer, so the rest is carried after it', async () => {
    const B = `${APP_INSTANCE}/user/person-2`;
    const C = `${APP_INSTANCE}/user/person-3`;
    listed[ROOM] = [PERSON, B, C];
    mockAdd.mockImplementation(async (a: { inviteeArn: string }) => { if (a.inviteeArn === C) throw Object.assign(new Error('the meeting conversation answers now'), { name: 'CarryDeadline' }); });
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: true, channelArn: MEETING, carryLeft: true });
  });

  it("holds everyone in the parent conversation for a workflow's start too, and answers the parent conversation's moderators, who host it", async () => {
    const B = `${APP_INSTANCE}/user/person-2`;
    listed[ROOM] = [PERSON, B];
    moderators[ROOM] = [B, CONCIERGE_BOT];
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM })).toEqual({ ok: true, channelArn: MEETING, roomModeratorIds: ['person-2'] });
    expect(mockAdd.mock.calls.map((c) => c[0].inviteeArn).sort()).toEqual([PERSON, B].sort());
  });

  it('is named for the room it was started from', async () => {
    await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON });
    expect(mockCreate.mock.calls[0][0].name).toBe('Meeting in Report Latency');
  });

  it("is named by its type where the room's name cannot be read", async () => {
    mockMessagingSend.mockImplementation(async (cmd: { __type: string; input: { ResourceARN: string } }) => {
      if (cmd.__type === 'ListTags') return { Tags: Object.entries(tags[cmd.input.ResourceARN] ?? {}).map(([Key, Value]) => ({ Key, Value })) };
      if (cmd.__type === 'DescribeChannel') throw Object.assign(new Error('x'), { name: 'ThrottledClientException' });
      return {};
    });
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: true, channelArn: MEETING });
    expect(mockCreate.mock.calls[0][0].name).toBe('Meeting Conversation');
  });

  it('is owned by the primary of the room it was started from, not the classification\'s default', async () => {
    await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON });
    expect(mockRoomPrimary).toHaveBeenCalledWith(ROOM, expect.anything(), expect.any(String));
    expect(mockCreate.mock.calls[0][0].botArn).toBe(`${APP_INSTANCE}/bot/concierge`);
  });

  it('holds no other assistant when the room has none besides its primary', async () => {
    await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON });
    expect(mockCreate.mock.calls[0][0].agents).toEqual([]);
  });

  it("holds the room's other assistants, and only the ones in the room: an incident's call has its ops assistant", async () => {
    assistantMembers[ROOM] = [CONCIERGE_BOT, OPS_BOT];
    await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON });
    const agents = mockCreate.mock.calls[0][0].agents as Array<{ handle: string; botArn: string }>;
    expect(agents.map((a) => a.botArn)).toEqual([OPS_BOT]);
    expect(mockLiveAssistants).toHaveBeenCalledWith('premium');
  });

  it('holds an assistant added to the room after it opened, as the room holds it now', async () => {
    assistantMembers[ROOM] = [CONCIERGE_BOT, OPS_BOT, SENTINEL_BOT];
    await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON });
    expect((mockCreate.mock.calls[0][0].agents as Array<{ botArn: string }>).map((a) => a.botArn).sort()).toEqual([OPS_BOT, SENTINEL_BOT].sort());
  });

  it("opens nothing when the room's assistants cannot be read, rather than a meeting without one of them", async () => {
    mockMessagingSend.mockImplementation(async (cmd: { __type: string; input: { ResourceARN: string } }) => {
      if (cmd.__type === 'ListTags') return { Tags: Object.entries(tags[cmd.input.ResourceARN] ?? {}).map(([Key, Value]) => ({ Key, Value })) };
      if (cmd.__type === 'DescribeMembership') throw Object.assign(new Error('throttled'), { name: 'ThrottledClientException' });
      return {};
    });
    const out = await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON });
    expect(out.ok).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('answers no conversation when the room\'s primary cannot be read, and asks again on the next start', async () => {
    mockRoomPrimary.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: false, code: 'NO_PRIMARY' });
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: true, channelArn: MEETING });
  });

  it('answers no conversation when its row cannot name the room, so no meeting is held where the room cannot find it', async () => {
    mockRecordMeetingOf.mockResolvedValue(false);
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: false, code: 'NOT_LINKED' });
  });

  it('DENY: opens nothing for a person who is not a member of the room, whoever asked', async () => {
    notMembers[ROOM] = [PERSON];
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: false, code: 'NOT_A_MEMBER' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('DENY: opens nothing for a member whose clearance does not reach the classification now', async () => {
    mockClearance.mockResolvedValue({ state: 'held', token: 'basic' });
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: false, code: 'NOT_CLEARED' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('opens one for nobody when a workflow started the meeting', async () => {
    await handler({ aeMeeting: 'open', parentChannelArn: ROOM });
    expect(mockCreate.mock.calls[0][0].userArn).toBe('');
  });

  it('refuses a room at another classification, and opens nothing', async () => {
    tags[ROOM] = { classification: 'basic' };
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: false, code: 'NOT_THIS_CLASSIFICATION' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses an archived room, and opens nothing', async () => {
    tags[ROOM] = { classification: 'premium', archived: 'true' };
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON })).toEqual({ ok: false, code: 'CONVERSATION_ARCHIVED' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('opens no meeting conversation from a meeting\'s own conversation', async () => {
    expect(await handler({ aeMeeting: 'open', parentChannelArn: MEETING, forUserArn: PERSON })).toEqual({ ok: false, code: 'NESTED' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a conversation or a person of another app instance', async () => {
    const other = 'arn:aws:chime:us-east-1:999:app-instance/x';
    expect(await handler({ aeMeeting: 'open', parentChannelArn: `${other}/channel/c`, forUserArn: PERSON })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await handler({ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: `${other}/user/p` })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('admitting a person to a meeting\'s conversation', () => {
  const admit = (over: Record<string, unknown> = {}) => handler({ aeMeeting: 'admit', meetingChannelArn: MEETING, personArn: PERSON, parentChannelArn: ROOM, ...over });

  it('adds the person to the meeting\'s conversation alone, as the service admin', async () => {
    expect(await admit()).toEqual({ ok: true, channelArn: MEETING });
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith({ channelArn: MEETING, inviteeArn: PERSON, bearerArn: `${APP_INSTANCE}/user/ae-admin` });
  });

  it('admits nobody to a conversation whose row does not say it is a meeting\'s', async () => {
    expect(await admit({ meetingChannelArn: ROOM })).toEqual({ ok: false, code: 'NOT_A_MEETING' });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('admits nobody for a conversation the meeting was not started from', async () => {
    const OTHER = `${APP_INSTANCE}/channel/other-room`;
    tags[OTHER] = { classification: 'premium' };
    expect(await admit({ parentChannelArn: OTHER })).toEqual({ ok: false, code: 'NOT_THE_ROOMS_MEETING' });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('admits nobody to an older meeting\'s conversation its room has moved on from', async () => {
    rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: `${APP_INSTANCE}/channel/meet-2`, at: 'x' } };
    expect(await admit()).toEqual({ ok: false, code: 'NOT_THE_ROOMS_MEETING' });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it.each([[MEETING], [ROOM]])('admits nobody while %s is archived', async (archived) => {
    tags[archived] = { classification: 'premium', archived: 'true' };
    expect(await admit()).toEqual({ ok: false, code: 'CONVERSATION_ARCHIVED' });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('DENY: admits a member of the room whose clearance does not reach the classification now to nothing', async () => {
    mockClearance.mockResolvedValue({ state: 'held', token: 'basic' });
    expect(await admit()).toEqual({ ok: false, code: 'NOT_CLEARED' });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('admits nobody at another classification', async () => {
    tags[MEETING] = { classification: 'basic' };
    expect(await admit()).toEqual({ ok: false, code: 'NOT_THIS_CLASSIFICATION' });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('admits nobody when a row cannot be read', async () => {
    mockGetContext.mockRejectedValue(Object.assign(new Error('x'), { name: 'ChannelContextUnreadable' }));
    expect(await admit()).toEqual({ ok: false, code: 'FAILED' });
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe('carrying the rest of the room after the open answered', () => {
  const carry = (over: Record<string, unknown> = {}) => handler({ aeMeeting: 'carry', meetingChannelArn: MEETING, parentChannelArn: ROOM, ...over });
  const B = `${APP_INSTANCE}/user/person-2`;
  const C = `${APP_INSTANCE}/user/person-3`;

  it('adds every person of the room not yet a member, as the service admin, and nobody already in it', async () => {
    listed[ROOM] = [PERSON, B, C, CONCIERGE_BOT];
    listed[MEETING] = [PERSON, B, CONCIERGE_BOT];
    expect(await carry()).toEqual({ ok: true, channelArn: MEETING });
    expect(mockAdd.mock.calls.map((c) => c[0])).toEqual([{ channelArn: MEETING, inviteeArn: C, bearerArn: `${APP_INSTANCE}/user/ae-admin` }]);
  });

  it('DENY: never carries a person whose clearance does not reach the classification now', async () => {
    listed[ROOM] = [PERSON, B, C];
    listed[MEETING] = [PERSON];
    mockClearance.mockImplementation(async (arn: string) => ({ state: 'held', token: arn === C ? 'basic' : 'premium' }));
    expect(await carry()).toEqual({ ok: true, channelArn: MEETING });
    expect(mockAdd.mock.calls.map((c) => c[0].inviteeArn)).toEqual([B]);
  });

  it("DENY: carries nobody into a conversation that is not that room's meeting, or while either is archived", async () => {
    listed[ROOM] = [PERSON, B];
    expect(await carry({ meetingChannelArn: ROOM })).toEqual({ ok: false, code: 'NOT_A_MEETING' });
    const OTHER = `${APP_INSTANCE}/channel/other-room`;
    tags[OTHER] = { classification: 'premium' };
    expect(await carry({ parentChannelArn: OTHER })).toEqual({ ok: false, code: 'NOT_THE_ROOMS_MEETING' });
    tags[ROOM] = { classification: 'premium', archived: 'true' };
    expect(await carry()).toEqual({ ok: false, code: 'CONVERSATION_ARCHIVED' });
    tags[ROOM] = { classification: 'basic' };
    expect(await carry()).toEqual({ ok: false, code: 'NOT_THIS_CLASSIFICATION' });
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe('the meeting type', () => {
  it('lets the members of the room a meeting was started from join it, and is the room\'s thread, which its turns read', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CONVERSATION_TYPES, meetingSettingsOf, relationOf } = require('../../lib/config/conversation-types');
    expect(meetingSettingsOf('meeting')).toEqual({ parentMembersJoin: true, addedPeople: true });
    expect(meetingSettingsOf('general')).toBeNull();
    expect(relationOf('meeting')).toBe('thread');
    expect(CONVERSATION_TYPES.meeting.classifications).toBeUndefined();
  });
});

describe('only a meeting opens a meeting conversation', () => {
  it('refuses an event or a step that names the meeting type', async () => {
    const out = await handler({ detail: { conversationType: 'meeting', concernedChannelArn: ROOM, forUserArn: PERSON } });
    expect(out.ok).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('a conversation that watches a key', () => {
  const KEY = 'ticket#7';
  it('is live while it stands at this classification and its row lists the key', async () => {
    rows[ROOM] = { watchedRefs: [KEY] };
    expect(await watchesRefLive(ROOM, KEY)).toBe('live');
  });

  it('has released the key once archived, gone, or no longer listing it', async () => {
    tags[ROOM] = { classification: 'premium', archived: 'true' };
    expect(await watchesRefLive(ROOM, KEY)).toBe('released');
    tags[ROOM] = { classification: 'premium' };
    rows[ROOM] = { watchedRefs: [] };
    expect(await watchesRefLive(ROOM, KEY)).toBe('released');
    mockMessagingSend.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NotFoundException' }));
    expect(await watchesRefLive(ROOM, KEY)).toBe('released');
  });

  it('is unknown, never released, when its tags or its row cannot be read', async () => {
    mockMessagingSend.mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
    expect(await watchesRefLive(ROOM, KEY)).toBe('unknown');
    mockGetContext.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ChannelContextUnreadable' }));
    expect(await watchesRefLive(ROOM, KEY)).toBe('unknown');
  });
});

describe("the classification's primary, for a room an event opens", () => {
  it('is asked again after a lookup that failed, and remembered once found', async () => {
    mockClassificationPrimary.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    expect((await resolvePrimary()).botArn).toBe('');
    expect((await resolvePrimary()).botArn).toBe(APP_INSTANCE + "/bot/advisor");
    await resolvePrimary();
    expect(mockClassificationPrimary).toHaveBeenCalledTimes(2);
    expect(mockClassificationPrimary).toHaveBeenCalledWith(expect.any(String), 'primary');
    expect(mockClassificationPrimary).not.toHaveBeenCalledWith(expect.any(String), 'ops');
  });

  it('is the classification\'s primary for every room, an ops room included', async () => {
    mockClassificationPrimary.mockReset();
    // EVERY ROOM, AN OPS ROOM INCLUDED, IS CREATED FOR THE CLASSIFICATION'S PRIMARY. Who runs a room's event workflows is
    // a separate rule (`workflowOwner`), so the ops assistant owns an ops room's events without being its primary.
    mockClassificationPrimary.mockImplementation(async (_c: string, role: string) => ({ assistant: role === 'primary' ? 'advisor' : 'ops-premium', botArn: `${APP_INSTANCE}/bot/${role === 'primary' ? 'advisor' : 'ops-premium'}` }));
    // resolvePrimary() takes no type, so no room can ask for the ops role; the lookup above is remembered.
    expect((await resolvePrimary()).assistant).toBe('advisor');
    expect(mockClassificationPrimary).not.toHaveBeenCalledWith(expect.any(String), 'ops');
  });
});

describe('a large room\'s meeting conversation answers in time', () => {
  it('carries the room until the open must answer, and the rest enter by joining', async () => {
    const { beforeDeadline, MEETING_OPEN_ANSWER_MS } = require('../../lambda/src/typed-conversation-from-event');
    const { carryRoomPeople } = require('../../lambda/src/lib/meeting-admission');
    expect(MEETING_OPEN_ANSWER_MS).toBeLessThan(10_000);
    let now = 0;
    const people = Array.from({ length: 300 }, (_, i) => `${APP_INSTANCE}/user/p${i}`);
    const added: string[] = [];
    const out = await carryRoomPeople('room', 'meeting', {
      peopleOf: async () => people,
      cleared: beforeDeadline(5, async () => true, () => now),
      add: beforeDeadline(5, async (_m: string, p: string) => { added.push(p); now += 1; }, () => now),
    });
    expect(added).toHaveLength(5);
    expect(out.failed).toHaveLength(295);
  });
});
