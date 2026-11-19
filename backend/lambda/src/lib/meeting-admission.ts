/**
 * WHO MAY ENTER A MEETING'S CONVERSATION WITHOUT BEING ITS MEMBER (SPEC-ASSISTANT-MEETINGS FR27, DESIGN-ASSISTANT-MEETINGS
 * C.7.2): one rule, applied by the meeting function before it asks for an admission and by the creator that holds the
 * membership grant before it adds anyone (`typed-conversation-from-event.ts`, `aeMeeting: 'admit'`).
 *
 * A member of the conversation a meeting was started from enters the meeting's conversation, and nothing else, when:
 *  - the meeting conversation's server-side row says it is a meeting's (`conversationType`), names the conversation it was
 *    started from (`meetingOf`), and its settings let that conversation's members join (`parentMembersJoin`);
 *  - that conversation still names this one as its meeting's (`meetingConversation.channelArn`), so an older meeting's
 *    conversation, reached from an old card's link, admits nobody new;
 *  - neither conversation is archived.
 * The person's membership of the conversation it was started from is proven as the person, with their own AppInstanceUser
 * as bearer (`callerReachesConversation`), by the function they called; the creator acts only for the conversation that
 * proof was made against.
 */
import { meetingSettingsOf } from '../../../lib/config/conversation-types';
import type { ChannelContext } from './channel-context-client.js';

/** Why a person may not enter a meeting's conversation from the conversation it was started from. */
export type MeetingEntryRefusal = 'NOT_A_MEETING' | 'NOT_JOINABLE_FROM_ROOM' | 'NOT_THE_ROOMS_MEETING' | 'CONVERSATION_ARCHIVED';

export { isArchived } from './channel-classification.js';

/**
 * THE RULE. `meetingArchived` is the meeting conversation's own tag, where the caller has read it; the creator always has.
 * Answers the conversation it was started from, whose membership the person must hold.
 */
export function roomMemberMayEnter(input: {
  meetingArn: string;
  meetingRow: ChannelContext | null;
  meetingArchived?: boolean;
  parentRow: ChannelContext | null;
  parentArchived: boolean;
}): { ok: true; parentArn: string } | { ok: false; code: MeetingEntryRefusal } {
  const { meetingArn, meetingRow, parentRow } = input;
  const settings = meetingSettingsOf(meetingRow?.conversationType);
  if (!settings || !meetingRow?.meetingOf) return { ok: false, code: 'NOT_A_MEETING' };
  if (!settings.parentMembersJoin) return { ok: false, code: 'NOT_JOINABLE_FROM_ROOM' };
  if (input.meetingArchived || input.parentArchived) return { ok: false, code: 'CONVERSATION_ARCHIVED' };
  if (parentRow?.meetingConversation?.channelArn !== meetingArn) return { ok: false, code: 'NOT_THE_ROOMS_MEETING' };
  return { ok: true, parentArn: meetingRow.meetingOf };
}

/** What carrying a parent conversation's people into its meeting's conversation reads and writes, as the creator holds it. */
export interface RoomPeopleDeps {
  /** The parent conversation's people (AppInstanceUser ARNs), read live; assistants are not among them. Throws where it cannot be read. */
  peopleOf(roomArn: string): Promise<string[]>;
  /** Whether a person's clearance reaches the meeting's classification now, as a join checks it. */
  cleared(personArn: string): Promise<boolean>;
  /** The canonical membership write (`addInvitedMember`): a DEFAULT member, idempotently. */
  add(meetingArn: string, personArn: string): Promise<void>;
}

/** Who a meeting's conversation took from its parent conversation when it opened, and who it did not. */
export interface RoomPeopleOutcome {
  added: string[];
  /** People whose clearance does not reach the meeting's classification now: never added. */
  notCleared: string[];
  /** People whose clearance or membership write failed: they enter by the join's own admission. */
  failed: string[];
  /** The parent conversation's people could not be read: nobody was carried, and each enters by the join's own admission. */
  unread?: true;
}

/** How many people are carried at once, so a large parent conversation opens inside the meeting function's wait for the creator. */
export const ROOM_PEOPLE_CONCURRENCY = 8;

/**
 * EVERYONE IN THE ROOM IS A MEMBER OF ITS MEETING'S CONVERSATION FROM THE MOMENT IT OPENS (SPEC-ASSISTANT-MEETINGS FR27):
 * each person the parent conversation holds now, checked for clearance exactly as a join is, is added through the canonical membership
 * write, so they chat in the meeting's conversation, hear its ring and see its cards before or without joining. `skip`
 * names people already added (the person it was opened for). A person who is not cleared is never added; one whose add
 * fails, and anyone added to the parent conversation later, enters by the join's own admission (`roomMemberMayEnter`). Never throws.
 */
export async function carryRoomPeople(
  roomArn: string, meetingArn: string, deps: RoomPeopleDeps, skip: readonly string[] = [],
): Promise<RoomPeopleOutcome> {
  const out: RoomPeopleOutcome = { added: [], notCleared: [], failed: [] };
  let people: string[];
  try {
    people = [...new Set(await deps.peopleOf(roomArn))].filter((arn) => arn.includes('/user/') && !skip.includes(arn));
  } catch (err) {
    console.warn('[meeting-admission] the parent conversation\'s people could not be read; each enters the meeting by joining', { err: (err as Error)?.name });
    return { ...out, unread: true };
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < people.length) {
      const personArn = people[next++];
      try {
        if (!(await deps.cleared(personArn))) { out.notCleared.push(personArn); continue; }
        await deps.add(meetingArn, personArn);
        out.added.push(personArn);
      } catch (err) {
        console.warn('[meeting-admission] a person of the parent conversation could not be carried; they enter by joining', { err: (err as Error)?.name });
        out.failed.push(personArn);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ROOM_PEOPLE_CONCURRENCY, people.length) }, worker));
  return out;
}
