/**
 * WHETHER A CONVERSATION HOLDS A MESSAGE THE PERSON HAS NOT SEEN, from four facts on two clocks:
 *  - `lastMessageAt`, the channel's last message, and `lastReadAt`, the person's read marker: both the server's times,
 *    from the conversation list;
 *  - `arrivedAt`, when a message from someone else last arrived live, and `viewedAt`, when the person last had the
 *    conversation in front of them: both this device's times.
 * Each pair is compared on its own clock. The list's last message is unread when it is newer than the read marker and,
 * on this device's clock (`localTimeOf`), newer than the last view; a live arrival is unread when it came after the last
 * view. So a device clock that runs fast or slow neither marks a conversation the person just read as unread nor hides
 * one they have not.
 */
export interface UnreadFacts {
  lastMessageAt?: Date;
  lastReadAt?: Date;
  arrivedAt?: number;
  viewedAt?: number;
  /** A server time on this device's clock (`MessagingProvider`'s `localTimeOf`). Absent: the clocks are taken as one. */
  localTimeOf?: (serverTime: number) => number;
}

export function conversationIsUnread(f: UnreadFacts): boolean {
  const viewed = f.viewedAt || 0;
  if (f.arrivedAt && f.arrivedAt > viewed) return true;
  const last = f.lastMessageAt ? f.lastMessageAt.getTime() : 0;
  if (!last) return false;
  const marker = f.lastReadAt ? f.lastReadAt.getTime() : 0;
  if (last <= marker) return false;
  const lastHere = f.localTimeOf ? f.localTimeOf(last) : last;
  return lastHere > viewed;
}
