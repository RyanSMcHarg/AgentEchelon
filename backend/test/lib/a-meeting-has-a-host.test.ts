/**
 * A MEETING HAS HOSTS (SPEC-ASSISTANT-MEETINGS FR50): every holder of the room's host roles (an incident's lead, its
 * on-call and its secondary on-call), else the person who starts it; a workflow's meeting takes the room's host roles.
 * Where a host role is held, only its holders start the meeting.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { isHostOrModerator, isRecordedHost, mayStartMeeting, meetingHostsFor, recordedHostIds, roomHostsOf } from '../../lambda/src/lib/meeting-host';
import { participantRoleDeclarationErrors } from '../../lib/config/participant-roles';
import { CONVERSATION_TYPES, type ConversationTypeConfig } from '../../lib/config/conversation-types';

const room = (type: string, roles: Record<string, Record<string, { origin: string }>>) => ({ conversationType: type, participantRoles: roles }) as never;
const INCIDENT = room('ops', {
  lead: { lead1: { origin: 'event' } },
  'on-call:ops': { oncall: { origin: 'group' } },
  'secondary:ops': { second: { origin: 'group' } },
  responder: { member: { origin: 'group' } },
});

describe('the hosts of a meeting', () => {
  it("are an incident's lead, its on-call and its secondary on-call, in the order its type declares", () => {
    expect(roomHostsOf(INCIDENT)).toEqual([
      { personId: 'lead1', role: 'lead' }, { personId: 'oncall', role: 'on-call:ops' }, { personId: 'second', role: 'secondary:ops' },
    ]);
  });

  it("are the team room's on-call and secondary on-call", () => {
    const team = room('ops-team', { 'on-call:ops': { oncall: { origin: 'group' } }, 'secondary:ops': { second: { origin: 'group' } } });
    expect(roomHostsOf(team).map((h) => h.personId)).toEqual(['oncall', 'second']);
  });

  it('name a person once where they hold two host roles', () => {
    expect(roomHostsOf(room('ops', { lead: { p: { origin: 'event' } }, 'on-call:ops': { p: { origin: 'group' } } }))).toEqual([{ personId: 'p', role: 'lead' }]);
  });

  it('are decided from the roles for a person and for a workflow, and recorded as the roles', () => {
    expect(meetingHostsFor(INCIDENT, { by: 'member', via: 'person' })).toEqual({ hosts: roomHostsOf(INCIDENT), hostVia: 'role' });
    expect(meetingHostsFor(INCIDENT, { by: 'ops-bot', via: 'workflow' })).toEqual({ hosts: roomHostsOf(INCIDENT), hostVia: 'role' });
  });

  it("are whoever starts it in a parent conversation with no host role held, and the parent conversation's moderators for a workflow there", () => {
    const general = { conversationType: 'general' } as never;
    expect(meetingHostsFor(general, { by: 'p1', via: 'person' })).toEqual({ hosts: [{ personId: 'p1' }], hostVia: 'starter' });
    expect(meetingHostsFor(general, { by: 'ops-bot', via: 'workflow' }, ['m1', 'm2', 'm1'])).toEqual({ hosts: [{ personId: 'm1' }, { personId: 'm2' }], hostVia: 'moderators' });
    // The starter hosts a person's start; the parent conversation's moderators are not added to it.
    expect(meetingHostsFor(general, { by: 'p1', via: 'person' }, ['m1'])).toEqual({ hosts: [{ personId: 'p1' }], hostVia: 'starter' });
    // A held host role decides before the moderators do.
    expect(meetingHostsFor(INCIDENT, { by: 'ops-bot', via: 'workflow' }, ['m1'])).toEqual({ hosts: roomHostsOf(INCIDENT), hostVia: 'role' });
    // With no moderator readable, nobody: the parent conversation's moderators still end it, asked live.
    expect(meetingHostsFor(general, { by: 'ops-bot', via: 'workflow' })).toEqual({});
    expect(meetingHostsFor(room('ops', {}), { by: 'p1', via: 'person' })).toEqual({ hosts: [{ personId: 'p1' }], hostVia: 'starter' });
  });

  it("ignore a holding the room's type does not declare, and one a host application asserted", () => {
    expect(roomHostsOf(room('ops', { lead: { x: { origin: 'host' } } }))).toEqual([]);
    expect(roomHostsOf(room('general', { lead: { x: { origin: 'event' } } }))).toEqual([]);
  });
});

describe("who may start the room's meeting", () => {
  it('is every host role holder, and no responder, where one is held', () => {
    expect(mayStartMeeting(INCIDENT, 'oncall')).toBe(true);
    expect(mayStartMeeting(INCIDENT, 'second')).toBe(true);
    expect(mayStartMeeting(INCIDENT, 'lead1')).toBe(true);
    expect(mayStartMeeting(INCIDENT, 'member')).toBe(false);
  });

  it('is anyone in a room with no host role held', () => {
    expect(mayStartMeeting({ conversationType: 'general' } as never, 'member')).toBe(true);
    expect(mayStartMeeting(room('ops', {}), 'member')).toBe(true);
  });
});

describe('the hosts a record names', () => {
  it('are its hosts, else the person who started a record made before hosts were recorded, never an assistant', () => {
    expect(isRecordedHost({ hosts: [{ personId: 'h' }, { personId: 'i' }], createdBy: 'p', startedVia: 'person' }, 'i')).toBe(true);
    expect(isRecordedHost({ hosts: [{ personId: 'h' }], createdBy: 'p', startedVia: 'person' }, 'p')).toBe(false);
    expect(isRecordedHost({ createdBy: 'p', startedVia: 'person' }, 'p')).toBe(true);
    expect(isRecordedHost({ createdBy: 'ops-bot', startedVia: 'workflow' }, 'ops-bot')).toBe(false);
  });

  it('are listed by person for the room to mark each one', () => {
    expect(recordedHostIds({ hosts: [{ personId: 'h', role: 'on-call:ops' }, { personId: 'i', role: 'secondary:ops' }] })).toEqual(['h', 'i']);
    expect(recordedHostIds({ createdBy: 'p', startedVia: 'person' })).toEqual(['p']);
    expect(recordedHostIds({ createdBy: 'ops-bot', startedVia: 'workflow' })).toEqual([]);
  });
});

describe('a type names only its own one-holder roles as hosts', () => {
  it('accepts the shipped types', () => {
    expect(participantRoleDeclarationErrors(CONVERSATION_TYPES).filter((e) => e.includes('meetingHost'))).toEqual([]);
  });

  it('refuses an undeclared role and a role many hold', () => {
    const types: Record<string, ConversationTypeConfig> = {
      t: {
        ...CONVERSATION_TYPES.ops,
        participants: {
          participantRoles: { lead: { from: [{ event: 'forPerson' }], holders: 'one' }, crew: { from: [{ group: 'ops' }] } },
          meetingHost: ['nobody', 'crew'],
        },
      },
    };
    expect(participantRoleDeclarationErrors(types).filter((e) => e.includes('meetingHost'))).toEqual([
      "type 't': meetingHost 'nobody' is not one of its participant roles",
      "type 't': meetingHost 'crew' must be held by one person",
    ]);
  });
});

describe('one rule decides who acts on a running meeting for everyone (ending it, adding people to it)', () => {
  const MEETING = { hosts: [{ personId: 'host' }] };
  const CONVERSATIONS = { roomArn: 'arn:room', meetingArn: 'arn:meeting' };
  /** Moderators by conversation; a read of anything else answers as the service does for a person who is not one. */
  const reader = (moderators: Record<string, string[]>, fail?: string) => ({
    send: async (cmd: unknown) => {
      const { ChannelArn, ChannelModeratorArn, ChimeBearer } = (cmd as { input: Record<string, string> }).input;
      if (fail) throw Object.assign(new Error('x'), { name: fail });
      if (ChimeBearer !== ChannelModeratorArn || !(moderators[ChannelArn] ?? []).includes(ChannelModeratorArn)) throw Object.assign(new Error('no'), { name: 'NotFoundException' });
      return {};
    },
  });

  it('a host, or a moderator of the room or of the meeting conversation, read live as themselves', async () => {
    expect(await isHostOrModerator(MEETING, { personId: 'host', personArn: 'arn:host' }, CONVERSATIONS, reader({}))).toBe(true);
    expect(await isHostOrModerator(MEETING, { personId: 'm', personArn: 'arn:m' }, CONVERSATIONS, reader({ 'arn:room': ['arn:m'] }))).toBe(true);
    expect(await isHostOrModerator(MEETING, { personId: 'm', personArn: 'arn:m' }, CONVERSATIONS, reader({ 'arn:meeting': ['arn:m'] }))).toBe(true);
  });

  it('DENY: anyone else, and every read that fails', async () => {
    expect(await isHostOrModerator(MEETING, { personId: 'm', personArn: 'arn:m' }, CONVERSATIONS, reader({}))).toBe(false);
    expect(await isHostOrModerator(MEETING, { personId: 'm', personArn: 'arn:m' }, CONVERSATIONS, reader({ 'arn:room': ['arn:m'] }, 'ThrottlingException'))).toBe(false);
    expect(await isHostOrModerator(undefined, { personId: 'host', personArn: 'arn:host' }, CONVERSATIONS, reader({}))).toBe(false);
  });

  it('the meetings function and the proposals apply both decide by it, with no copy of their own', () => {
    for (const file of ['meeting-api.ts', 'proposals-api.ts']) {
      const source = readFileSync(join(__dirname, '../../lambda/src', file), 'utf8');
      expect(source).toMatch(/isHostOrModerator\(/);
      expect(source).not.toMatch(/DescribeChannelModeratorCommand/);
    }
  });
});
