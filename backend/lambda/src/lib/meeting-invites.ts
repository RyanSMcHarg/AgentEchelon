/**
 * PEOPLE ADDED TO A MEETING, NEVER TO ITS ROOM (SPEC-ASSISTANT-MEETINGS FR42, FR51, FR52; DESIGN-ASSISTANT-MEETINGS C.7.4).
 *
 * An assistant in a conversation whose meeting is running may PROPOSE adding people to that meeting: the people a record
 * names for the work at hand (an account's team), each by their AppInstanceUser, never by a name the model read. The
 * proposal is the platform's one propose-and-confirm seam (ADR-061 decision 8, `add_to_meeting`, `lib/proposals.ts`):
 * the turn drafts it and executes nothing, the person who asked confirms it on a card, and the apply endpoint performs it.
 *
 * WHO MAY CONFIRM: the meeting's host (`meeting-host.ts`) or a moderator of its room or of the meeting's own conversation,
 * checked when the card is offered and again, live, when it is applied.
 *
 * WHAT IS ADDED: each person, to the meeting's own conversation alone, by the creator of its classification, which holds
 * the membership grant and admits only a person cleared for the conversation's classification. The room's membership is
 * never touched: a person added to the meeting reads the meeting and its chat, and nothing else (FR42). Each invitation is
 * recorded on the meeting conversation's row (`meetingInvites`): who confirmed it, the accounts it is for, and the brief
 * its assistant drafted, which that assistant says privately to the person when they join (the arrival brief, FR52).
 *
 * WHO SPEAKS (FR51): a person holding one of the room's `meetingSpeakers` roles joins with their microphone on, a role the
 * type gives every member by default counting for the room's members; everyone else joins muted and may unmute.
 */
import { CONVERSATION_TYPES, meetingSettingsOf } from '../../../lib/config/conversation-types';
import type { ChannelContext } from './channel-context-client.js';
import { parseHoldings } from './participant-roles.js';
import { participantRolesOf } from '../../../lib/config/participant-roles';
import { isRecordedHost } from './meeting-host.js';
import { proposalDraftRefusal } from './proposals.js';
import { isPersonOf } from './person-arn.js';
import { MESSAGE_VALUE_CAPS } from './message-template.js';

/** One person a proposal adds to a meeting, as its record and the meeting's row hold them. */
export interface MeetingInvite {
  /** The person, as their AppInstanceUser ARN, read from the record that names them. */
  person: string;
  /** How the card names them: the record's name for them, display only; nothing is decided from it. */
  name: string;
  /** What they are asked in for (the accounts that are theirs), as the record names them. */
  accounts: string[];
  /** What the assistant tells them privately when they join: the arrival brief. */
  brief: string;
}

/** The most people one proposal adds, the most labels one person carries, and how long each piece may be. */
export const MAX_MEETING_INVITES = 10;
export const MAX_INVITE_ACCOUNTS = 10;
export const MAX_INVITE_LABEL = 80;
export const MAX_INVITE_BRIEF = 700;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A label as a record or a card holds it: one line, trimmed, within its cap, with no link, handle or address. */
function label(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const one = v.replace(/\s+/g, ' ').trim();
  if (!one || one.length > max || proposalDraftRefusal(one)) return undefined;
  return one;
}

/**
 * THE INVITES A TURN PROPOSES, read strictly from the tool's input: one to {@link MAX_MEETING_INVITES} people, each a
 * person of this app instance by ARN, with a name, the accounts they are asked in for and the brief they are told. Every
 * piece of text is held to the rule for what reaches a person not reading the room (no link, no handle, no address). A
 * person named twice is one invite, their accounts merged and their first brief kept. Anything malformed refuses the
 * whole proposal, by reason, so the model can correct it.
 */
export function meetingInvitesFromInput(raw: unknown, appInstanceArn: string): { invites: MeetingInvite[] } | { refused: string } {
  const list = isObject(raw) ? raw.invites : undefined;
  if (!Array.isArray(list) || list.length === 0) return { refused: 'invites lists the people to add, each with person, name, accounts and brief' };
  const byPerson = new Map<string, MeetingInvite>();
  for (const [i, entry] of list.entries()) {
    if (!isObject(entry)) return { refused: `invites[${i}] is an object` };
    const person = typeof entry.person === 'string' ? entry.person.trim() : '';
    if (!person || !isPersonOf(person, appInstanceArn)) return { refused: `invites[${i}].person is the person's id as the record names it (an AppInstanceUser ARN of this deployment)` };
    const name = label(entry.name, MAX_INVITE_LABEL);
    if (!name) return { refused: `invites[${i}].name is the person's name as the record gives it, at most ${MAX_INVITE_LABEL} characters` };
    const accounts = Array.isArray(entry.accounts) ? entry.accounts.map((a) => label(a, MAX_INVITE_LABEL)) : [];
    if (!accounts.length || accounts.length > MAX_INVITE_ACCOUNTS || accounts.some((a) => !a)) {
      return { refused: `invites[${i}].accounts names 1 to ${MAX_INVITE_ACCOUNTS} accounts as the record names them` };
    }
    const brief = typeof entry.brief === 'string' ? entry.brief.trim() : '';
    if (!brief || brief.length > MAX_INVITE_BRIEF || proposalDraftRefusal(brief)) {
      return { refused: `invites[${i}].brief is what they are told when they join, at most ${MAX_INVITE_BRIEF} characters, with no link, handle or address` };
    }
    const seen = byPerson.get(person);
    if (seen) seen.accounts = [...new Set([...seen.accounts, ...(accounts as string[])])].slice(0, MAX_INVITE_ACCOUNTS);
    else byPerson.set(person, { person, name, accounts: [...new Set(accounts as string[])], brief });
  }
  if (byPerson.size > MAX_MEETING_INVITES) return { refused: `a proposal adds at most ${MAX_MEETING_INVITES} people` };
  const invites = [...byPerson.values()];
  // THE CARD SHOWS EVERY PERSON IT ADDS: its list is one long-text value, so a proposal whose list would not fit is refused
  // rather than shown in part, and the person never confirms adding someone the card did not name.
  if (inviteLines(invites).length > MESSAGE_VALUE_CAPS.longText) {
    return { refused: `the proposal's list of people and accounts is longer than the card holds (${MESSAGE_VALUE_CAPS.longText} characters); propose fewer people or accounts` };
  }
  return { invites };
}

/** Invites as a record holds them, read back strictly: anything malformed is left out. */
export function storedInvites(raw: unknown, appInstanceArn: string): MeetingInvite[] {
  const read = meetingInvitesFromInput({ invites: Array.isArray(raw) ? raw : [] }, appInstanceArn);
  return 'invites' in read ? read.invites : [];
}

/**
 * WHERE A CONVERSATION'S MEETING IS: the conversation itself when it is a meeting's own, else the newest meeting
 * conversation its row names; and the room it was started from. Undefined when it names none.
 */
export function meetingPlaceOf(channelArn: string, row: ChannelContext | null | undefined): { meetingArn: string; roomArn: string } | undefined {
  if (meetingSettingsOf(row?.conversationType)) return row?.meetingOf ? { meetingArn: channelArn, roomArn: row.meetingOf } : undefined;
  const named = row?.meetingConversation?.channelArn;
  return named ? { meetingArn: named, roomArn: channelArn } : undefined;
}

/** Whether the meeting's settings let people from outside its room be added (FR43). */
export function meetingAdmitsAddedPeople(meetingRow: ChannelContext | null | undefined): boolean {
  return meetingSettingsOf(meetingRow?.conversationType)?.addedPeople === true;
}

/**
 * WHETHER A PERSON MAY ADD PEOPLE TO A RUNNING MEETING: its host, or a moderator of its room or of its own conversation.
 * Moderation is asked live by the caller (`moderates`), which denies on any failure.
 */
export async function mayAddPeople(
  meeting: Pick<NonNullable<ChannelContext['activeMeeting']>, 'hosts' | 'createdBy' | 'startedVia'> | undefined,
  personId: string,
  moderates: () => Promise<boolean>,
): Promise<boolean> {
  if (!meeting || !personId) return false;
  if (isRecordedHost(meeting, personId)) return true;
  return moderates().catch(() => false);
}

/**
 * WHETHER A PERSON HOLDS A ROOM ROLE THAT CONFERS MODERATION (a lead, an on-call), read from the room's server-side row.
 * What a turn reads before it offers a card; the apply endpoint asks Amazon Chime SDK live before anything is added.
 */
export function holdsModeratingRole(roomRow: ChannelContext | null | undefined, personId: string): boolean {
  const typeKey = roomRow?.conversationType;
  const holdings = parseHoldings(roomRow?.participantRoles, typeKey);
  return Object.entries(participantRolesOf(typeKey)).some(([role, decl]) => decl.confers?.moderator === true && !!holdings[role]?.[personId]);
}

/**
 * WHETHER A PERSON JOINS THE ROOM'S MEETING MUTED (FR51): the room's type names its speaking roles (`meetingSpeakers`); a
 * person holding one of them, by the room's server-side holdings or as a member of the room where the role is the type's
 * default, speaks. Everyone else joins muted. A type that names none mutes nobody.
 */
export function joinsMuted(roomRow: ChannelContext | null | undefined, personId: string, isRoomMember: boolean): boolean {
  const typeKey = roomRow?.conversationType;
  const participants = typeKey ? CONVERSATION_TYPES[typeKey]?.participants : undefined;
  const speakers = participants?.meetingSpeakers ?? [];
  if (!speakers.length) return false;
  const holdings = parseHoldings(roomRow?.participantRoles, typeKey);
  if (speakers.some((role) => !!holdings[role]?.[personId])) return false;
  if (isRoomMember && participants?.defaultRole && speakers.includes(participants.defaultRole)) return false;
  return true;
}

/** Whether deciding {@link joinsMuted} needs the person's room membership read: only where a default role would let them speak. */
export function mutingReadsRoomMembership(roomRow: ChannelContext | null | undefined, personId: string): boolean {
  const typeKey = roomRow?.conversationType;
  const participants = typeKey ? CONVERSATION_TYPES[typeKey]?.participants : undefined;
  const speakers = participants?.meetingSpeakers ?? [];
  if (!speakers.length || !participants?.defaultRole || !speakers.includes(participants.defaultRole)) return false;
  const holdings = parseHoldings(roomRow?.participantRoles, typeKey);
  return !speakers.some((role) => !!holdings[role]?.[personId]);
}

/** The card's list of who is added and for which accounts: one line per person, as markdown, in no one language's grammar. */
export function inviteLines(invites: readonly MeetingInvite[]): string {
  return invites.map((i) => `- ${i.name}: ${i.accounts.join(', ')}`).join('\n');
}
