/**
 * A CONVERSATION READ IN ONE WINDOW IS READ IN EVERY WINDOW of this person's app in this browser: the window that marks
 * it read says so on a BroadcastChannel, and the others clear its unread mark at once. A meeting's chat read in the
 * meeting window therefore leaves no mark on the meeting or its room in the app beside it, without waiting for the
 * server's read marker to reach the next list read. Without BroadcastChannel each window learns at its next list read.
 */
const CHANNEL = 'ae-conversation-read';

/** Say that this window marked the conversation read. */
export function announceConversationRead(channelArn: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ channelArn });
    bc.close();
  } catch { /* the other windows learn at their next list read */ }
}

/** Hear the conversations another window of this browser marked read. Answers the stop. */
export function onConversationReadElsewhere(onRead: (channelArn: string) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e: MessageEvent<{ channelArn?: unknown }>) => {
      if (typeof e.data?.channelArn === 'string') onRead(e.data.channelArn);
    };
  } catch { bc = null; }
  return () => { bc?.close(); };
}
