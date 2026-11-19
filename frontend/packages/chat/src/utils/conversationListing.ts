/**
 * WHICH CONVERSATIONS THE LIST SHOWS. A meeting's own conversation, running or ended, belongs to its room: it is reached
 * from the room's meeting banner and cards and from the meeting window, so it is left out of the list beside ordinary
 * conversations, and what is new in it shows on its room's row.
 *
 * WHICH ROOM A MEETING BELONGS TO IS THE SERVER'S ANSWER (`meetingRooms`, from `POST /meetings/mine`: its `rooms`, read
 * from each meeting conversation's server-written record, and its running meetings), never the channel's Metadata:
 * Metadata is member-writable, so a moderator could otherwise file any shared conversation under another and hide it from
 * every member's list. A conversation the server names no room for is listed like any other.
 *
 * It is listed on its own where it is the one open, so the person sees where they are, or where its room is not in the
 * list, so it is never out of reach.
 */
import type { Conversation } from '@ae/shared';

/**
 * EACH MEETING CONVERSATION'S ROOM, by the meeting's own conversation id: the server's `rooms` (running or ended), and
 * each running meeting it listed or a card announced since.
 */
export function meetingRoomsFrom(
  rooms: ReadonlyArray<{ conversationId: string; roomConversationId: string }>,
  running: ReadonlyArray<{ conversationId: string; roomConversationId: string }>,
): Map<string, string> {
  return new Map([...rooms, ...running].map((m) => [m.conversationId, m.roomConversationId]));
}

export interface ConversationListing {
  /** The conversations the list shows, in the order given. */
  listed: Conversation[];
  /** Each listed room's meeting conversations, by the room's conversation id. */
  meetingsOf: Map<string, Conversation[]>;
}

export function conversationListing(
  conversations: readonly Conversation[],
  activeId?: string,
  /** Each meeting conversation's room, by the meeting's own conversation id, as the server answered it (`meetingRoomsFrom`). */
  meetingRooms: ReadonlyMap<string, string> = new Map(),
): ConversationListing {
  const ids = new Set(conversations.map((c) => c.id));
  const meetingsOf = new Map<string, Conversation[]>();
  const listed: Conversation[] = [];
  for (const c of conversations) {
    const room = meetingRooms.get(c.id);
    if (room && room !== c.id && ids.has(room)) {
      meetingsOf.set(room, [...(meetingsOf.get(room) ?? []), c]);
      if (c.id !== activeId) continue;
    }
    listed.push(c);
  }
  return { listed, meetingsOf };
}
