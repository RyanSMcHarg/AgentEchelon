/**
 * WAIT ON A ROOM BY ITS MESSAGE EVENTS, NOT A TIMER.
 *
 * A spec that drives the platform through its API used to re-list a channel every five seconds until a
 * predicate held. That costs a CLI round-trip per tick, answers up to five seconds late, and says nothing
 * while it waits. This opens the runner's messaging session as the member (`chime-session.ts`) and reads
 * the room again only when the room changes: a message created, updated, redacted or deleted. A reconnect
 * reads once more, for anything that landed while the socket was down.
 *
 * The read is the caller's own (`roomMessagesSeenBy`, `messagesSeenBy`), so the member's view and every
 * predicate written against it are unchanged; only what wakes the read is.
 */
import { noteProgress, trackConversation } from './current';
import { operatorCredentials } from './aws-signing';
import { sessionAs } from './chime-session';

/**
 * Read `read()` now, then again on every message event in `channelArn` seen by `memberArn`, until `done`
 * accepts the answer. Returns the last answer when `timeoutMs` passes, as `pollFor` does, so the caller's
 * assertion reports what was actually seen.
 */
export async function untilRoomChanges<T>(
  channelArn: string,
  memberArn: string,
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  trackConversation(channelArn);
  const session = await sessionAs(memberArn, operatorCredentials, (s) => console.log(`[wire-wait] ${s}`));

  let last = await read();
  if (done(last)) return last;

  return new Promise<T>((resolve, reject) => {
    let reading = false;
    let again = false;
    let finished = false;
    const finish = (v: T) => {
      if (finished) return;
      finished = true;
      offEvent();
      offConnected();
      clearTimeout(timer);
      resolve(v);
    };
    const reread = async () => {
      if (finished) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          last = await read();
          if (done(last)) {
            finish(last);
            return;
          }
        } while (again && !finished);
      } catch (err) {
        finished = true;
        offEvent();
        offConnected();
        clearTimeout(timer);
        reject(err);
      } finally {
        reading = false;
      }
    };
    const offEvent = session.onEvent((e) => {
      if (e.channelArn !== channelArn) return;
      noteProgress('backend', `${e.eventType} ${e.messageId.slice(0, 12)} in ${channelArn.split('/').pop()}`);
      void reread();
    });
    // A reconnect is the one moment an event could have been missed.
    const offConnected = session.onConnected(() => void reread());
    const timer = setTimeout(() => finish(last), timeoutMs);
    // A message may have landed between the first read and the subscription: read once more now it is in place.
    void reread();
  });
}
