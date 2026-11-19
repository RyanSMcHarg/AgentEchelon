/**
 * A PERSON IS SHOWN THE MEETINGS THEY ARE IN NOW (`POST /meetings/mine`, SPEC-ASSISTANT-MEETINGS FR37).
 *
 * What it proves: the caller's conversations are listed bearing the caller, so only their own memberships answer; a running
 * meeting is listed only from a meeting conversation they are a member of, never from its room's membership, so a person
 * added to the meeting alone is listed and a member of the room who never joined is not; each is kept only where that
 * conversation is reached now (member, cleared) and the service says it still runs; a room that moved on to a newer meeting
 * and a meeting the service ended are left out; ids, the name the person's membership lists and times only are answered; and
 * a read that cannot be completed answers 503, never a shorter list.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { meetingCandidates, meetingRoomsOf, meetingRunsFor } from '../../lambda/src/lib/my-meetings';
import type { ChannelContext } from '../../lambda/src/lib/channel-context-client';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
process.env.APP_INSTANCE_ARN = APP;
const ch = (id: string) => `${APP}/channel/${id}`;
const PERSON = 'person-1';
const ROOM = ch('room-1');
const MEET = ch('meet-1');
const ADDED_MEET = ch('meet-2');
const ROOM_ONLY = ch('room-3');
const ROOM_ONLY_MEET = ch('meet-3');

const running = (meetingId: string, createdAt = '2026-11-13T19:00:00.000Z') => ({
  meetingId, meeting: { MeetingId: meetingId }, classification: 'premium', createdAt, createdBy: 'host-1', hosts: [{ personId: 'host-1' }],
});

const mockPersonId = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ callerPersonId: (...a: unknown[]) => mockPersonId(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
const reached = new Map<string, boolean>();
const unreadable = new Set<string>();
const reachAsked: string[] = [];
jest.mock('../../lambda/src/lib/conversation-access', () => ({
  ...jest.requireActual('../../lambda/src/lib/conversation-access'),
  listReach: () => ({
    reaches: async (arns: string[]) => {
      reachAsked.push(...arns);
      return new Map(arns.map((a) => [a, unreadable.has(a) ? { ok: false, code: 'UNAVAILABLE' } : reached.get(a) === false ? { ok: false, code: 'NOT_CLEARED' } : { ok: true, classification: 'premium' }]));
    },
  }),
}));
let rows: Record<string, Partial<ChannelContext> | null> = {};
let rowsFail = false;
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  readChannelContexts: async (arns: string[]) => {
    if (rowsFail) throw Object.assign(new Error('x'), { name: 'ChannelContextUnreadable' });
    return new Map(arns.map((a) => [a, rows[a] ?? null]));
  },
  releaseActiveMeeting: async () => 'released',
  recordMeetingFact: async () => true,
}));

import { handler, __setClients } from '../../lambda/src/meeting-api';

const messagingSent: Array<Record<string, unknown>> = [];
let memberships: Array<{ ChannelArn: string; Name?: string }> = [];
let listFails = false;
const endedMeetings = new Set<string>();

beforeEach(() => {
  mockPersonId.mockResolvedValue(PERSON);
  reached.clear();
  unreadable.clear();
  reachAsked.length = 0;
  rowsFail = false;
  listFails = false;
  endedMeetings.clear();
  messagingSent.length = 0;
  // In the room and its meeting; added to another meeting alone; in a third room whose meeting they never joined.
  memberships = [
    { ChannelArn: ROOM, Name: 'AgentEchelon Demo Incident' }, { ChannelArn: MEET, Name: 'Meeting in AgentEchelon Demo Incident' },
    { ChannelArn: ADDED_MEET, Name: 'Meeting in Customer API outage' }, { ChannelArn: ROOM_ONLY, Name: 'Ops Team Room' },
  ];
  rows = {
    [ROOM]: { conversationType: 'ops', meetingConversation: { channelArn: MEET, at: 'x' } },
    [MEET]: { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: running('m-1') as never },
    [ADDED_MEET]: { conversationType: 'meeting', meetingOf: ch('room-x'), activeMeeting: running('m-2', '2026-11-13T19:30:00.000Z') as never },
    [ROOM_ONLY]: { conversationType: 'ops-team', meetingConversation: { channelArn: ROOM_ONLY_MEET, at: 'x' } },
    [ROOM_ONLY_MEET]: { conversationType: 'meeting', meetingOf: ROOM_ONLY, activeMeeting: running('m-3') as never },
  };
  __setClients({
    messaging: {
      send: async (cmd: { input: Record<string, unknown> }) => {
        messagingSent.push(cmd.input);
        if (listFails) throw Object.assign(new Error('x'), { name: 'ThrottledClientException' });
        return { ChannelMemberships: memberships.map((m) => ({ ChannelSummary: m })) };
      },
    } as never,
    meetings: {
      send: async (cmd: { input: { MeetingId: string } }) => {
        if (endedMeetings.has(cmd.input.MeetingId)) throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
        return { Meeting: { MeetingId: cmd.input.MeetingId } };
      },
    } as never,
  });
});

const mine = async () => {
  const res = await handler({ httpMethod: 'POST', path: '/meetings/mine', resource: '/meetings/mine', headers: {}, body: '{}' } as unknown as APIGatewayProxyEvent);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

describe('the meetings a person is in now', () => {
  it('lists their conversations bearing them, and answers the meetings whose conversation they are in, newest first', async () => {
    const out = await mine();
    expect(out.status).toBe(200);
    expect(messagingSent[0]).toMatchObject({ AppInstanceUserArn: `${APP}/user/${PERSON}`, ChimeBearer: `${APP}/user/${PERSON}` });
    expect(out.body.meetings).toEqual([
      { conversationId: 'meet-2', roomConversationId: 'room-x', name: 'Meeting in Customer API outage', startedAt: '2026-11-13T19:30:00.000Z', isHost: false },
      { conversationId: 'meet-1', roomConversationId: 'room-1', name: 'Meeting in AgentEchelon Demo Incident', startedAt: '2026-11-13T19:00:00.000Z', isHost: false },
    ]);
  });

  it('lists a meeting a person was added to alone, and none from a room\'s membership the person never joined from', async () => {
    const ids = (await mine()).body.meetings.map((m: { conversationId: string }) => m.conversationId);
    expect(ids).toContain('meet-2');
    expect(ids).not.toContain('meet-3');
    // The meeting conversation itself is what is checked, never its room.
    expect(reachAsked).toEqual(expect.arrayContaining([MEET, ADDED_MEET]));
    expect(reachAsked).not.toContain(ROOM);
  });

  it('DENY: leaves out a meeting whose conversation the person no longer reaches', async () => {
    reached.set(MEET, false);
    expect((await mine()).body.meetings.map((m: { conversationId: string }) => m.conversationId)).toEqual(['meet-2']);
  });

  it('leaves out a meeting the service has ended, and one whose room has moved on to a newer meeting', async () => {
    endedMeetings.add('m-2');
    rows[ROOM] = { conversationType: 'ops', meetingConversation: { channelArn: ch('meet-newer'), at: 'x' } };
    expect((await mine()).body.meetings).toEqual([]);
  });

  it('DENY: leaves out a meeting a host removed the person from, which its join would refuse', async () => {
    rows[MEET] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: { ...running('m-1'), removedPersonIds: [PERSON] } as never };
    expect((await mine()).body.meetings.map((m: { conversationId: string }) => m.conversationId)).toEqual(['meet-2']);
  });

  it('answers 503, never a shorter list, when the reach of a meeting conversation cannot be read', async () => {
    unreadable.add(MEET);
    expect((await mine()).status).toBe(503);
  });

  it('answers 503, never a shorter list, when the conversations or their rows cannot be read', async () => {
    listFails = true;
    expect((await mine()).status).toBe(503);
    listFails = false;
    rowsFail = true;
    expect((await mine()).status).toBe(503);
  });

  it('answers the room of each of their meeting conversations, running or ended, from the server-written link', async () => {
    // The meeting in the room has ended: its row keeps the link it was opened with, and holds no meeting.
    rows[MEET] = { conversationType: 'meeting', meetingOf: ROOM };
    const out = await mine();
    expect(out.body.meetings.map((m: { conversationId: string }) => m.conversationId)).toEqual(['meet-2']);
    expect(out.body.rooms).toEqual([{ conversationId: 'meet-1', roomConversationId: 'room-1' }]);
  });

  it('DENY: answers no room for a conversation that is not a meeting conversation, or a meeting whose room the person is not in', async () => {
    // An ordinary conversation whose row carries a link (never written for one) is no meeting conversation.
    rows[ROOM_ONLY] = { conversationType: 'ops-team', meetingOf: ROOM };
    const rooms = (await mine()).body.rooms as Array<{ conversationId: string }>;
    expect(rooms.map((r) => r.conversationId)).toEqual(['meet-1']);
  });

  it('DENY: refuses a caller with no person session', async () => {
    mockPersonId.mockResolvedValue('');
    expect((await mine()).status).toBe(403);
  });
});

describe('the meeting candidates (pure)', () => {
  it('takes meeting conversations the person is in, with the name they are listed under, and never a room\'s meeting', () => {
    const m = new Map(Object.entries(rows)) as Map<string, ChannelContext | null>;
    expect(meetingCandidates([{ channelArn: ROOM, name: 'R' }, { channelArn: MEET, name: 'Meeting in R' }, { channelArn: ROOM_ONLY }], m)).toEqual([
      { meetingArn: MEET, roomArn: ROOM, name: 'Meeting in R' },
    ]);
  });

  it('a meeting conversation belongs to the room its row names only where the person is in both', () => {
    const m = new Map(Object.entries(rows)) as Map<string, ChannelContext | null>;
    expect(meetingRoomsOf([{ channelArn: ROOM }, { channelArn: MEET }, { channelArn: ADDED_MEET }], m)).toEqual([{ meetingArn: MEET, roomArn: ROOM }]);
    expect(meetingRoomsOf([{ channelArn: MEET }], m)).toEqual([]);
  });

  it('a meeting runs for its room only while the room still names it', () => {
    const c = { meetingArn: MEET, roomArn: ROOM };
    expect(meetingRunsFor(c, rows[MEET] as ChannelContext, rows[ROOM] as ChannelContext)).toBe(true);
    expect(meetingRunsFor(c, rows[MEET] as ChannelContext, { channelArn: ROOM, meetingConversation: { channelArn: ROOM_ONLY_MEET, at: 'x' } } as ChannelContext)).toBe(false);
    expect(meetingRunsFor(c, { ...rows[MEET], activeMeeting: undefined } as ChannelContext, rows[ROOM] as ChannelContext)).toBe(false);
  });
});
