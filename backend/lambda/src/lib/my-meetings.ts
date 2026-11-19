/**
 * THE MEETINGS A PERSON IS IN NOW (`POST /meetings/mine`, SPEC-ASSISTANT-MEETINGS FR37): every running meeting held in a
 * meeting conversation they are a member of, read from the server-side rows and never from channel Metadata, which members
 * can write. The meeting conversation's membership decides, never its room's: a person added to the meeting alone (an
 * account's team) is listed, and a member of the room who never joined is not (they join from the room's line). The chat app
 * lists them at the top of its navigation and rings the person on opening for one they are not connected to.
 *
 * What it guarantees:
 *  - A MEETING IS ITS CONVERSATION'S RECORD: a meeting conversation whose row holds a running meeting and names its room,
 *    while that room still names it as its meeting's.
 *  - ONE ENTRY PER MEETING CONVERSATION, with the name its membership lists it under.
 *  - IDS, NAMES THE PERSON CAN SEE AND TIMES ONLY. Every other word is the app's, in the reader's language.
 *
 * Pure: the route reads the memberships and the rows and checks access and the service (`meeting-api.ts`).
 */
import { meetingSettingsOf } from '../../../lib/config/conversation-types';
import type { ChannelContext } from './channel-context-client.js';

/** One conversation the person is a member of, as the membership read lists it. */
export interface Membership { channelArn: string; name?: string }

/** A meeting conversation the person is a member of, the room it was started from, and the name it is listed under. */
export interface MeetingCandidate { meetingArn: string; roomArn: string; name?: string }

/** The meeting conversations among the person's memberships whose rows hold a meeting, before access and the service decide. */
export function meetingCandidates(memberships: readonly Membership[], rows: ReadonlyMap<string, ChannelContext | null>): MeetingCandidate[] {
  const out = new Map<string, MeetingCandidate>();
  for (const m of memberships) {
    const row = rows.get(m.channelArn);
    // ONLY A MEETING'S OWN CONVERSATION: a room's membership lists none of its meetings.
    if (!row || !meetingSettingsOf(row.conversationType) || !row.meetingOf || !row.activeMeeting?.meetingId || out.has(m.channelArn)) continue;
    out.set(m.channelArn, { meetingArn: m.channelArn, roomArn: row.meetingOf, ...(m.name ? { name: m.name } : {}) });
  }
  return [...out.values()];
}

/** Whether a meeting conversation's row holds a running meeting that its room still names as its meeting's. */
export function meetingRunsFor(candidate: MeetingCandidate, meetingRow: ChannelContext | null | undefined, roomRow: ChannelContext | null | undefined): boolean {
  if (!meetingRow?.activeMeeting?.meetingId || meetingRow.meetingOf !== candidate.roomArn) return false;
  // A ROOM THAT MOVED ON to a newer meeting holds this one no more; a room whose row is gone holds nothing that says so.
  return !roomRow || roomRow.meetingConversation?.channelArn === candidate.meetingArn;
}

/** A meeting conversation the person is a member of and the room it was started from, running or ended. */
export interface MeetingRoom { meetingArn: string; roomArn: string }

/**
 * WHICH ROOM EACH OF THE PERSON'S MEETING CONVERSATIONS BELONGS TO, running or ended, from the server-written link on its
 * row (`meetingOf`, written when the meeting conversation is opened), so the app files a meeting's conversation under its
 * room by an answer no member can write. Only where the person is a member of both: the meeting conversation and its room.
 */
export function meetingRoomsOf(memberships: readonly Membership[], rows: ReadonlyMap<string, ChannelContext | null>): MeetingRoom[] {
  const member = new Set(memberships.map((m) => m.channelArn));
  const out = new Map<string, MeetingRoom>();
  for (const arn of member) {
    const row = rows.get(arn);
    if (!row || !meetingSettingsOf(row.conversationType) || !row.meetingOf || row.meetingOf === arn || !member.has(row.meetingOf)) continue;
    out.set(arn, { meetingArn: arn, roomArn: row.meetingOf });
  }
  return [...out.values()];
}
