/**
 * WHO HOSTS A CONVERSATION'S MEETING (SPEC-ASSISTANT-MEETINGS FR50). A host is a role, not a person: the room's type names
 * the participant roles that host its meetings (`participants.meetingHost`), and every person holding one of them is a
 * host (an incident's lead, its on-call and its secondary on-call). In a room whose type names none, or where none is
 * held, whoever starts the meeting hosts it. A meeting a workflow started takes the parent conversation's host roles; with none held, the
 * parent conversation's moderators at its start host it. A record that names no host (one made before hosts were recorded) is hosted by
 * the person who started it, else by the parent conversation's moderators, read live (`hostedMeetingLive`).
 *
 * The hosts are decided once, at the start, and recorded on the meeting (`activeMeeting.hosts`, `hostVia`). Starting
 * (and starting again after the meeting ended) is the room's host role holders' alone where the room has one held, so a
 * rotation of the on-call hands the next meeting to the new on-call. The holdings are read from the room's server-only
 * row (`participant-roles.ts`), never from member-writable Metadata.
 */
import { CONVERSATION_TYPES } from '../../../lib/config/conversation-types';
import type { ChannelContext } from './channel-context-client.js';
import { parseHoldings } from './participant-roles.js';
import { personModeratesChannel, type ModeratorReader } from './channel-moderator.js';

/** How the hosts were decided: the parent conversation's host roles, starting the meeting, or moderating the conversation a workflow started it in. */
export type HostVia = 'role' | 'starter' | 'moderators';

/** One host as recorded: the person, and the host role they hold (absent for the person who started it). */
export interface MeetingHost { personId: string; role?: string }

/** Every person holding one of the room's host roles, in the order its type declares the roles. Empty where none is held. */
export function roomHostsOf(roomRow: ChannelContext | null | undefined): MeetingHost[] {
  const typeKey = roomRow?.conversationType;
  const roles = (typeKey && CONVERSATION_TYPES[typeKey]?.participants?.meetingHost) || [];
  if (!roles.length) return [];
  const holdings = parseHoldings(roomRow?.participantRoles, typeKey);
  const hosts: MeetingHost[] = [];
  for (const role of roles) {
    for (const personId of Object.keys(holdings[role] ?? {})) {
      if (!hosts.some((h) => h.personId === personId)) hosts.push({ personId, role });
    }
  }
  return hosts;
}

/**
 * The hosts a start records: the parent conversation's host role holders, else a person who starts it, else (a workflow's start) the
 * parent conversation's moderators at its start, `roomModeratorIds`, else nobody.
 */
export function meetingHostsFor(
  roomRow: ChannelContext | null | undefined, start: { by: string; via: 'person' | 'workflow' }, roomModeratorIds: readonly string[] = [],
): { hosts?: MeetingHost[]; hostVia?: HostVia } {
  const byRole = roomHostsOf(roomRow);
  if (byRole.length) return { hosts: byRole, hostVia: 'role' };
  if (start.via === 'person') return { hosts: [{ personId: start.by }], hostVia: 'starter' };
  const moderators = [...new Set(roomModeratorIds.filter(Boolean))];
  return moderators.length ? { hosts: moderators.map((personId) => ({ personId })), hostVia: 'moderators' } : {};
}

/** Whether a person may start the room's meeting, or start it again: a holder of its host roles where one is held, else anyone. */
export function mayStartMeeting(roomRow: ChannelContext | null | undefined, personId: string): boolean {
  const byRole = roomHostsOf(roomRow);
  return !byRole.length || byRole.some((h) => h.personId === personId);
}

/**
 * Whether a meeting's record names this person a host: one of its `hosts`, or, for a record made before hosts were
 * recorded, the person who started it. An assistant that started it is never a host.
 */
export function isRecordedHost(
  meeting: { hosts?: MeetingHost[]; createdBy?: string; startedVia?: 'person' | 'workflow' } | undefined, personId: string,
): boolean {
  if (!meeting || !personId) return false;
  if (meeting.hosts) return meeting.hosts.some((h) => h.personId === personId);
  return meeting.startedVia !== 'workflow' && meeting.createdBy === personId;
}

/**
 * WHETHER A PERSON HOSTED A MEETING OF THIS CONVERSATION, by the meeting's own record on the conversation's row: its running
 * meeting or its last one, whichever is that meeting. A meeting's transcript and recording are signed for its hosts alone
 * (SPEC-ASSISTANT-MEETINGS FR28, FR70). A meeting the row does not hold hosted nobody.
 */
export function hostedMeeting(
  row: { activeMeeting?: { meetingId?: string; hosts?: MeetingHost[]; createdBy?: string; startedVia?: 'person' | 'workflow' }; lastMeeting?: { meetingId?: string; hosts?: MeetingHost[]; createdBy?: string; startedVia?: 'person' | 'workflow' } } | null | undefined,
  meetingId: string,
  personId: string,
): boolean {
  if (!meetingId || !personId) return false;
  const meeting = [row?.activeMeeting, row?.lastMeeting].find((m) => m?.meetingId === meetingId);
  return isRecordedHost(meeting, personId);
}

/**
 * WHETHER A PERSON HOSTED A MEETING, for its transcript and recording (FR28, FR70): a host its record names
 * (`hostedMeeting`); and, for a record that names no host at all (a workflow's meeting recorded before its hosts were),
 * a moderator of the conversation it was started from (`meetingOf`, else the conversation itself), asked live with the person as
 * bearer. A meeting the row does not hold hosted nobody, and an unreadable answer denies.
 */
export async function hostedMeetingLive(
  row: (Parameters<typeof hostedMeeting>[0] & { meetingOf?: string }) | null | undefined,
  meetingArn: string,
  meetingId: string,
  person: { personId: string; personArn: string },
  messaging: ModeratorReader,
): Promise<boolean> {
  if (hostedMeeting(row, meetingId, person.personId)) return true;
  const meeting = [row?.activeMeeting, row?.lastMeeting].find((m) => m?.meetingId === meetingId);
  if (!meeting || recordedHostIds(meeting).length || !person.personArn) return false;
  return moderatesLive(messaging, row?.meetingOf || meetingArn, person.personArn);
}

/** The person ids a meeting's record names as its hosts, for the room to mark each one. */
export function recordedHostIds(
  meeting: { hosts?: MeetingHost[]; createdBy?: string; startedVia?: 'person' | 'workflow' } | undefined,
): string[] {
  if (!meeting) return [];
  if (meeting.hosts) return meeting.hosts.map((h) => h.personId);
  return meeting.startedVia !== 'workflow' && meeting.createdBy ? [meeting.createdBy] : [];
}

export type { ModeratorReader };

/** WHETHER A PERSON MODERATES A CONVERSATION, read live by the one per-person check (`channel-moderator.ts`). */
export const moderatesLive = personModeratesChannel;

/**
 * THE ONE RULE FOR WHO ACTS ON A RUNNING MEETING FOR EVERYONE (ending it, adding people to it): one of its recorded hosts,
 * or a moderator of its room or of its own conversation, read live. An unreadable answer denies.
 */
export async function isHostOrModerator(
  meeting: { hosts?: MeetingHost[]; createdBy?: string; startedVia?: 'person' | 'workflow' } | undefined,
  person: { personId: string; personArn: string },
  conversations: { roomArn: string; meetingArn: string },
  messaging: ModeratorReader,
): Promise<boolean> {
  if (!meeting || !person.personId) return false;
  if (isRecordedHost(meeting, person.personId)) return true;
  if (!person.personArn) return false;
  const arns = [...new Set([conversations.roomArn, conversations.meetingArn].filter(Boolean))];
  const answers = await Promise.all(arns.map((arn) => moderatesLive(messaging, arn, person.personArn)));
  return answers.some(Boolean);
}
