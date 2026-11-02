/**
 * WHAT A CONVERSATION IS CALLED ON SCREEN.
 *
 * A room not yet named carries the platform's own marker as its name, which the server writes when a conversation is
 * asked for with no title and which only the room's first message replaces (`backend/lambda/src/lib/conversation-name.ts`,
 * `PLACEHOLDER_TITLE`). The marker is data, not copy: the client never sends it, and never decides anything from text a
 * person reads. So an unnamed room is shown in the reader's own language, and every other name is shown as it is.
 */

/** The platform's marker for an unnamed room. Must equal `PLACEHOLDER_TITLE` on the server. */
export const UNNAMED_CONVERSATION_MARKER = 'New conversation';

/** Whether a room still carries the platform's marker, so its first message names it. */
export function isUnnamedConversation(title: string | null | undefined): boolean {
  return !title?.trim() || title === UNNAMED_CONVERSATION_MARKER;
}

/** The name to show: the room's own, or the translated label for a room not yet named. */
export function conversationTitleFor(title: string | null | undefined, unnamedLabel: string): string {
  return isUnnamedConversation(title) ? unnamedLabel : (title as string);
}
