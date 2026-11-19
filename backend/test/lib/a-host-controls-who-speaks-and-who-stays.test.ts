/**
 * A HOST'S CONTROLS OVER THE PEOPLE IN A RUNNING MEETING (SPEC-ASSISTANT-MEETINGS FR59), on the person API:
 *   - only a host recorded on the meeting stops or restores a person's audio, stops everyone's, or removes a person;
 *     a member who is not a host is refused and nothing in the meeting changes;
 *   - a mute is the service's: the attendee's audio capability is set to `Receive`, its video and content kept, and
 *     letting them speak sets `SendReceive` again;
 *   - muting everyone leaves every host's attendee out, the caller's included;
 *   - a removal is recorded on the meeting before the attendee is deleted, and the removed person's join is refused;
 *   - each control is filed as a meeting event keyed by the person acted on, with the host who acted;
 *   - a person who joins muted is created receive-only, a failed read included, and is granted on asking; a person a
 *     host holds is recorded as asking, not granted, keeps the hold on a rejoin, and speaks once a host allows them.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockMeetingsSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-meetings', () => {
  const cmd = (type: string) => jest.fn((input) => ({ __type: type, input }));
  return {
    ChimeSDKMeetingsClient: jest.fn(() => ({ send: mockMeetingsSend })),
    CreateMeetingCommand: cmd('CreateMeeting'),
    CreateAttendeeCommand: cmd('CreateAttendee'),
    DeleteMeetingCommand: cmd('DeleteMeeting'),
    GetMeetingCommand: cmd('GetMeeting'),
    GetAttendeeCommand: cmd('GetAttendee'),
    ListAttendeesCommand: cmd('ListAttendees'),
    UpdateAttendeeCapabilitiesCommand: cmd('UpdateAttendeeCapabilities'),
    BatchUpdateAttendeeCapabilitiesExceptCommand: cmd('BatchUpdateAttendeeCapabilitiesExcept'),
    DeleteAttendeeCommand: cmd('DeleteAttendee'),
  };
});

const mockFile = jest.fn();
jest.mock('../../lambda/src/lib/meeting-event-archive', () => ({ fileMeetingEvents: (...a: unknown[]) => mockFile(...a) }));
jest.mock('../../lambda/src/lib/event-archive', () => ({ ensureDataPlaneArn: async () => undefined }));

const mockReach = jest.fn();
jest.mock('../../lambda/src/lib/conversation-access', () => {
  const actual = jest.requireActual('../../lambda/src/lib/conversation-access');
  return { ...actual, callerReachesConversation: (...a: unknown[]) => mockReach(...a) };
});
const mockPersonId = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ callerPersonId: (...a: unknown[]) => mockPersonId(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));

// WHETHER A PERSON JOINS MUTED by the room's speaking roles (FR51), as a test sets it; a throw is a failed read.
const mockJoinsMuted = jest.fn();
jest.mock('../../lambda/src/lib/meeting-invites', () => ({
  ...jest.requireActual('../../lambda/src/lib/meeting-invites'),
  mutingReadsRoomMembership: () => false,
  joinsMuted: (...a: unknown[]) => mockJoinsMuted(...a),
}));

const mockGetContext = jest.fn();
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  // The meeting's sets are written by the actual module, on the store the test sets (`__setStore`).
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  readChannelContext: async (...a: unknown[]) => ({ conversationType: 'meeting', ...((await mockGetContext(...a)) ?? {}) }),
  MEETING_OPENING_HOLD_MS: 60_000,
  confirmMeetingConversation: jest.fn(),
  releaseMeetingConversation: jest.fn(),
  claimMeetingConversation: jest.fn(),
  settleMeetingConversation: jest.fn(),
  claimActiveMeeting: jest.fn(async () => 'claimed'),
  releaseActiveMeeting: jest.fn(async () => 'released'),
  recordMeetingFact: jest.fn(async () => true),
  recordMeetingAttendee: async () => true,
  chargeTranscriptChars: async () => 'charged',
  meetingRecordedAttendee: () => true,
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
process.env.APP_INSTANCE_ARN = APP_INSTANCE;
process.env.CHANNEL_CONTEXT_TABLE = 'context-table';

import { handler, __setClients } from '../../lambda/src/meeting-api';
import { __forgetAttendeeOwners } from '../../lambda/src/lib/meeting-host-controls';
import { __setStore } from '../../lambda/src/lib/meeting-host-controls';

const CHANNEL = `${APP_INSTANCE}/channel/c1`;
const HOST = 'host-1';
const GUEST = 'guest-1';
const OTHER = 'guest-2';
const MEETING_ID = '11111111-2222-3333-4444-555555555555';
const RECORD = {
  meetingId: MEETING_ID, meeting: { MeetingId: MEETING_ID }, classification: 'premium', createdAt: '2026-11-12T00:00:00.000Z',
  createdBy: HOST, hosts: [{ personId: HOST }], hostVia: 'starter',
};
const ATTENDEES = [
  { AttendeeId: 'a-host', ExternalUserId: HOST, Capabilities: { Audio: 'SendReceive', Video: 'SendReceive', Content: 'SendReceive' } },
  { AttendeeId: 'a-guest', ExternalUserId: GUEST, Capabilities: { Audio: 'SendReceive', Video: 'Receive', Content: 'None' } },
  { AttendeeId: 'a-guest-tab2', ExternalUserId: GUEST, Capabilities: { Audio: 'SendReceive', Video: 'SendReceive', Content: 'SendReceive' } },
  { AttendeeId: 'a-other', ExternalUserId: OTHER, Capabilities: { Audio: 'SendReceive', Video: 'SendReceive', Content: 'SendReceive' } },
];
const mockStore = jest.fn();

function event(path: string, body: Record<string, unknown>): APIGatewayProxyEvent {
  return { httpMethod: 'POST', path, resource: path, headers: { origin: 'http://localhost:5173' }, body: JSON.stringify({ conversationId: 'c1', ...body }) } as unknown as APIGatewayProxyEvent;
}
const sent = (type: string) => mockMeetingsSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === type);
const changes = () => [...sent('UpdateAttendeeCapabilities'), ...sent('BatchUpdateAttendeeCapabilitiesExcept'), ...sent('DeleteAttendee')];
const as = (personId: string) => mockPersonId.mockResolvedValue(personId);
const call = async (path: string, body: Record<string, unknown>) => {
  const res = await handler(event(path, body));
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
};

beforeEach(() => {
  __forgetAttendeeOwners();
  jest.clearAllMocks();
  mockReach.mockResolvedValue({ ok: true, channelArn: CHANNEL, classification: 'premium' });
  as(HOST);
  mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
  mockFile.mockResolvedValue({ archived: 1 });
  mockJoinsMuted.mockReturnValue(false);
  mockStore.mockResolvedValue({});
  __setStore({ send: mockStore } as never);
  // Nobody moderates: a moderator read answers not found.
  __setClients({ messaging: { send: async () => { throw Object.assign(new Error('x'), { name: 'NotFoundException' }); } } as never });
  mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
    if (cmd.__type === 'GetMeeting') return { Meeting: { MeetingId: MEETING_ID } };
    if (cmd.__type === 'ListAttendees') return { Attendees: ATTENDEES };
    if (cmd.__type === 'CreateAttendee') return { Attendee: { AttendeeId: 'a-new', ExternalUserId: 'x', JoinToken: 't' } };
    return {};
  });
});

describe('a host stops and restores one person\'s audio, on the service', () => {
  it('sets every attendee of theirs to receive only, keeping each one\'s video and content, and files it by id', async () => {
    const res = await call('/meetings/speaking', { personId: GUEST, allow: false });
    expect(res).toEqual({ status: 200, body: { allowed: false, people: [GUEST] } });
    expect(sent('UpdateAttendeeCapabilities').map((c) => c.input)).toEqual([
      { MeetingId: MEETING_ID, AttendeeId: 'a-guest', Capabilities: { Audio: 'Receive', Video: 'Receive', Content: 'None' } },
      { MeetingId: MEETING_ID, AttendeeId: 'a-guest-tab2', Capabilities: { Audio: 'Receive', Video: 'SendReceive', Content: 'SendReceive' } },
    ]);
    const filed = mockFile.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(filed.map((r) => [r.event_type, r.person_key, r.attendee_id, (r.detail as { by: string }).by, r.source])).toEqual([
      ['attendeeMutedByHost', GUEST, 'a-guest', HOST, 'platform'],
      ['attendeeMutedByHost', GUEST, 'a-guest-tab2', HOST, 'platform'],
    ]);
  });

  it('restores the capability to send and receive when the host lets them speak', async () => {
    await call('/meetings/speaking', { personId: GUEST, allow: true });
    expect(sent('UpdateAttendeeCapabilities').map((c) => c.input.Capabilities.Audio)).toEqual(['SendReceive', 'SendReceive']);
    expect((mockFile.mock.calls[0][0] as Array<{ event_type: string }>)[0].event_type).toBe('attendeeAllowedToSpeak');
  });

  it('DENY: a member who is not a host can neither mute nor let speak, and nothing changes', async () => {
    as(OTHER);
    for (const allow of [false, true]) {
      const res = await call('/meetings/speaking', { personId: GUEST, allow });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HOST_ONLY');
    }
    expect(changes()).toHaveLength(0);
    expect(mockFile).not.toHaveBeenCalled();
  });

  it('DENY: a caller who is not a member of the conversation is refused before the meeting is read', async () => {
    mockReach.mockResolvedValue({ ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false });
    const res = await call('/meetings/speaking', { personId: GUEST, allow: false });
    expect(res.status).toBe(403);
    expect(mockMeetingsSend).not.toHaveBeenCalled();
  });

  it('refuses a person who has no attendee in this meeting, and another host', async () => {
    expect((await call('/meetings/speaking', { personId: 'stranger', allow: false })).body.code).toBe('NOT_IN_MEETING');
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, hosts: [{ personId: HOST }, { personId: GUEST }] } });
    expect((await call('/meetings/speaking', { personId: GUEST, allow: false })).body.code).toBe('NOT_A_HOST');
    expect(changes()).toHaveLength(0);
  });
});

describe('a host stops everyone\'s audio but the hosts\'', () => {
  it('leaves every host\'s attendee out, the caller\'s included, and files each person muted', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, hosts: [{ personId: HOST }, { personId: OTHER }] } });
    const res = await call('/meetings/speaking', { personId: 'all', allow: false });
    expect(res.status).toBe(200);
    const [batch] = sent('BatchUpdateAttendeeCapabilitiesExcept');
    expect(batch.input.Capabilities.Audio).toBe('Receive');
    expect(batch.input.ExcludedAttendeeIds).toEqual([{ AttendeeId: 'a-host' }, { AttendeeId: 'a-other' }]);
    expect(res.body.people).toEqual([GUEST]);
    expect((mockFile.mock.calls[0][0] as Array<{ person_key: string }>).map((r) => r.person_key)).toEqual([GUEST, GUEST]);
  });

  it('DENY: a member who is not a host cannot mute everyone', async () => {
    as(GUEST);
    expect((await call('/meetings/speaking', { personId: 'all', allow: false })).status).toBe(403);
    expect(changes()).toHaveLength(0);
  });
});

describe('a host removes a person from the meeting', () => {
  it('records the removal on the meeting first, then deletes every attendee of theirs, and files it by id', async () => {
    const order: string[] = [];
    mockStore.mockImplementation(async () => { order.push('record'); return {}; });
    const base = mockMeetingsSend.getMockImplementation()!;
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => { if (cmd.__type === 'DeleteAttendee') order.push('delete'); return base(cmd); });
    const res = await call('/meetings/remove', { personId: GUEST });
    expect(res).toEqual({ status: 200, body: { removed: GUEST } });
    expect(order).toEqual(['record', 'delete', 'delete']);
    const update = mockStore.mock.calls[0][0].input;
    expect(update.Key).toEqual({ channelArn: CHANNEL });
    expect(update.ConditionExpression).toBe('#meeting.#meetingId = :meetingId');
    expect(update.ExpressionAttributeValues[':add_removedPersonIds']).toEqual(new Set([GUEST]));
    expect(sent('DeleteAttendee').map((c) => c.input.AttendeeId)).toEqual(['a-guest', 'a-guest-tab2']);
    expect((mockFile.mock.calls[0][0] as Array<Record<string, unknown>>).map((r) => [r.event_type, r.person_key, (r.detail as { by: string }).by]))
      .toEqual([['attendeeRemoved', GUEST, HOST], ['attendeeRemoved', GUEST, HOST]]);
  });

  it('deletes nobody when the removal cannot be recorded, so a removed person is never let back in by a lost record', async () => {
    mockStore.mockRejectedValue(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
    const res = await call('/meetings/remove', { personId: GUEST });
    expect(res.status).toBe(503);
    expect(sent('DeleteAttendee')).toHaveLength(0);
  });

  it('DENY: a member who is not a host cannot remove anyone, and nothing is recorded or deleted', async () => {
    as(OTHER);
    const res = await call('/meetings/remove', { personId: GUEST });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HOST_ONLY');
    expect(mockStore).not.toHaveBeenCalled();
    expect(sent('DeleteAttendee')).toHaveLength(0);
  });

  it('refuses removing the caller, another host, or a person not in this meeting', async () => {
    expect((await call('/meetings/remove', { personId: HOST })).body.code).toBe('NOT_YOURSELF');
    expect((await call('/meetings/remove', { personId: 'stranger' })).body.code).toBe('NOT_IN_MEETING');
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, hosts: [{ personId: HOST }, { personId: GUEST }] } });
    expect((await call('/meetings/remove', { personId: GUEST })).body.code).toBe('NOT_A_HOST');
    expect(mockStore).not.toHaveBeenCalled();
  });
});

describe('a removed person stays out of the meeting', () => {
  it('DENY: refuses their join while the meeting names them removed, and creates no attendee', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, removedPersonIds: new Set([GUEST]) } });
    as(GUEST);
    const res = await call('/meetings/join', {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REMOVED_FROM_MEETING');
    expect(sent('CreateAttendee')).toHaveLength(0);
  });

  it('DENY: refuses their start, which would otherwise join the running meeting', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, removedPersonIds: [GUEST] } });
    as(GUEST);
    const res = await call('/meetings', {});
    expect(res.body.code).toBe('REMOVED_FROM_MEETING');
    expect(sent('CreateAttendee')).toHaveLength(0);
  });

  it('lets anyone else join, and tells them who was removed', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, removedPersonIds: new Set([GUEST]) } });
    as(OTHER);
    const res = await call('/meetings/join', {});
    expect(res.status).toBe(200);
    expect(res.body.removedIds).toEqual([GUEST]);
    expect(res.body.mutedByHost).toBe(false);
  });

});

const RECEIVE_ONLY = { Audio: 'Receive', Video: 'SendReceive', Content: 'SendReceive' };
const created = () => sent('CreateAttendee')[0].input;
const answerAttendee = (capabilities: Record<string, string>) => {
  const base = mockMeetingsSend.getMockImplementation()!;
  mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => (cmd.__type === 'CreateAttendee'
    ? { Attendee: { AttendeeId: 'a-guest', ExternalUserId: GUEST, JoinToken: 't', Capabilities: capabilities } }
    : base(cmd)));
};

describe('a person who joins muted is muted by the service (FR51)', () => {
  it('creates the attendee of a person the room\'s speaking roles leave out with receive-only audio, video and content open', async () => {
    mockJoinsMuted.mockReturnValue(true);
    as(GUEST);
    answerAttendee(RECEIVE_ONLY);
    const res = await call('/meetings/join', {});
    expect(created().Capabilities).toEqual(RECEIVE_ONLY);
    expect(res.body).toMatchObject({ startMuted: true, receiveOnly: true, mutedByHost: false });
  });

  it('creates a speaker\'s attendee with the service\'s own default', async () => {
    as(GUEST);
    await call('/meetings/join', {});
    expect(created().Capabilities).toBeUndefined();
  });

  it('FAILS CLOSED: a read of whether they join muted that fails joins them receive-only', async () => {
    mockJoinsMuted.mockImplementation(() => { throw new Error('row unreadable'); });
    as(GUEST);
    await call('/meetings/join', {});
    expect(created().Capabilities).toEqual(RECEIVE_ONLY);
  });

  it('a rejoin keeps a host\'s hold: the attendee the service answers with audio open is set receive-only again', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, heldPersonIds: new Set([GUEST]) } });
    as(GUEST);
    answerAttendee({ Audio: 'SendReceive', Video: 'SendReceive', Content: 'SendReceive' });
    const res = await call('/meetings/join', {});
    expect(created().Capabilities).toEqual(RECEIVE_ONLY);
    expect(sent('UpdateAttendeeCapabilities').map((c) => [c.input.AttendeeId, c.input.Capabilities.Audio])).toEqual([['a-guest', 'Receive']]);
    expect(res.body).toMatchObject({ mutedByHost: true, receiveOnly: true });
  });

  it('tells a host who is asking to speak when they join', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, speakRequestIds: new Set([GUEST]) } });
    expect((await call('/meetings/join', {})).body.speakRequests).toEqual([GUEST]);
    as(OTHER);
    expect((await call('/meetings/join', {})).body.speakRequests).toBeUndefined();
  });
});

describe('a muted person asks to speak, for themselves only', () => {
  const receiveOnlyGuest = () => {
    const base = mockMeetingsSend.getMockImplementation()!;
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string; input: { AttendeeId?: string } }) => {
      if (cmd.__type === 'ListAttendees') {
        return { Attendees: [ATTENDEES[0], { ...ATTENDEES[1], Capabilities: { Audio: 'Receive', Video: 'Receive', Content: 'None' } }, ATTENDEES[3]] };
      }
      if (cmd.__type === 'GetAttendee') return { Attendee: ATTENDEES.find((a) => a.AttendeeId === cmd.input.AttendeeId) };
      return base(cmd);
    });
  };

  it('one the room\'s roles muted is granted at once: their audio opens on the service, and it is filed by id', async () => {
    receiveOnlyGuest();
    as(GUEST);
    const res = await call('/meetings/unmute-request', {});
    expect(res).toEqual({ status: 200, body: { granted: true } });
    expect(sent('UpdateAttendeeCapabilities').map((c) => c.input)).toEqual([
      { MeetingId: MEETING_ID, AttendeeId: 'a-guest', Capabilities: { Audio: 'SendReceive', Video: 'Receive', Content: 'None' } },
    ]);
    const filed = mockFile.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(filed.map((r) => [r.event_type, r.person_key])).toEqual([['speakGranted', GUEST]]);
  });

  it("a host's hold that lands while a grant is made wins: the audio goes back to receive only and the request waits for a host", async () => {
    receiveOnlyGuest();
    // The record read when the request came in says nothing of a hold; the host's hold is recorded before the grant ends.
    mockStore.mockImplementation(async (cmd: { constructor: { name: string } }) => (cmd.constructor.name === 'GetCommand'
      ? { Item: { activeMeeting: { ...RECORD, heldPersonIds: new Set([GUEST]) } } }
      : {}));
    as(GUEST);
    const res = await call('/meetings/unmute-request', {});
    expect(res).toEqual({ status: 202, body: { granted: false, requested: true } });
    expect(sent('UpdateAttendeeCapabilities').map((c) => c.input.Capabilities.Audio)).toEqual(['SendReceive', 'Receive']);
    expect((mockFile.mock.calls[0][0] as Array<Record<string, unknown>>).map((r) => r.event_type)).toEqual(['speakRequested']);
  });

  it('FAILS CLOSED: a hold that cannot be read after a grant leaves the audio receive only, and asks them to try again', async () => {
    receiveOnlyGuest();
    mockStore.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetCommand') throw Object.assign(new Error('down'), { name: 'ServiceUnavailable' });
      return {};
    });
    as(GUEST);
    const res = await call('/meetings/unmute-request', {});
    expect(res.status).toBe(503);
    expect(sent('UpdateAttendeeCapabilities').map((c) => c.input.Capabilities.Audio)).toEqual(['SendReceive', 'Receive']);
  });

  it('a service that cannot say whose attendee it is answers retryably, and changes nothing', async () => {
    receiveOnlyGuest();
    const base = mockMeetingsSend.getMockImplementation()!;
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'GetAttendee') throw Object.assign(new Error('slow'), { name: 'ThrottlingException' });
      return base(cmd);
    });
    as(GUEST);
    const res = await call('/meetings/unmute-request', { attendeeId: 'a-guest' });
    expect(res.status).toBe(503);
    expect(changes()).toHaveLength(0);
  });

  it('one a host holds is NOT granted: the request is recorded for the hosts, and filed by id', async () => {
    receiveOnlyGuest();
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, heldPersonIds: new Set([GUEST]) } });
    as(GUEST);
    const res = await call('/meetings/unmute-request', {});
    expect(res).toEqual({ status: 202, body: { granted: false, requested: true } });
    expect(sent('UpdateAttendeeCapabilities')).toHaveLength(0);
    expect(mockStore.mock.calls[0][0].input.ExpressionAttributeValues[':add_speakRequestIds']).toEqual(new Set([GUEST]));
    expect((mockFile.mock.calls[0][0] as Array<Record<string, unknown>>).map((r) => [r.event_type, r.person_key])).toEqual([['speakRequested', GUEST]]);
  });

  it('a host\'s allow opens their audio and ends the hold and the request', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, heldPersonIds: new Set([GUEST]), speakRequestIds: new Set([GUEST]) } });
    await call('/meetings/speaking', { personId: GUEST, allow: true });
    expect(sent('UpdateAttendeeCapabilities').every((c) => c.input.Capabilities.Audio === 'SendReceive')).toBe(true);
    const update = mockStore.mock.calls[0][0].input;
    expect(update.UpdateExpression).toContain('DELETE');
    expect(update.ExpressionAttributeValues[':del_heldPersonIds']).toEqual(new Set([GUEST]));
    expect(update.ExpressionAttributeValues[':del_speakRequestIds']).toEqual(new Set([GUEST]));
  });

  it("a host's allow, one person or everyone, whose hold cannot be cleared changes no audio and is refused, so the person is never re-muted on rejoin", async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, heldPersonIds: new Set([GUEST]), speakRequestIds: new Set([GUEST]) } });
    mockStore.mockRejectedValue(Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' }));
    for (const personId of [GUEST, 'all']) {
      const res = await call('/meetings/speaking', { personId, allow: true });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CONTROL_FAILED');
    }
    expect(sent('UpdateAttendeeCapabilities')).toHaveLength(0);
    expect(sent('BatchUpdateAttendeeCapabilitiesExcept')).toHaveLength(0);
  });

  it('a host\'s mute records the hold before the capability changes, and changes nothing when it cannot', async () => {
    mockStore.mockRejectedValue(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
    const res = await call('/meetings/speaking', { personId: GUEST, allow: false });
    expect(res.status).toBe(503);
    expect(sent('UpdateAttendeeCapabilities')).toHaveLength(0);
  });

  it('DENY: a request for another person, or naming another\'s attendee, is refused and changes nothing', async () => {
    receiveOnlyGuest();
    as(GUEST);
    const forOther = await call('/meetings/unmute-request', { personId: OTHER });
    expect(forOther.status).toBe(403);
    expect(forOther.body.code).toBe('NOT_YOUR_ATTENDEE');
    const othersAttendee = await call('/meetings/unmute-request', { attendeeId: 'a-other' });
    expect(othersAttendee.status).toBe(403);
    expect(sent('UpdateAttendeeCapabilities')).toHaveLength(0);
    expect(mockStore).not.toHaveBeenCalled();
  });

  it('DENY: a caller who is not a member of the conversation is refused before the meeting is read', async () => {
    mockReach.mockResolvedValue({ ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false });
    expect((await call('/meetings/unmute-request', {})).status).toBe(403);
    expect(mockMeetingsSend).not.toHaveBeenCalled();
  });

  it('refuses a person with no attendee in the meeting', async () => {
    as('stranger');
    expect((await call('/meetings/unmute-request', {})).body.code).toBe('NOT_IN_MEETING');
  });
});
