/**
 * The waiting affordance on a duelling side's question, and the single place it is taken down.
 *
 * A side that stops to ask the user something posts its question carrying `<!--battlewaiting:...-->`,
 * which the frontend renders as a live "Replying to:" control (ADR-029). Something has to remove that
 * marker when the question stops being answerable, and for a long time exactly one thing did: the
 * RESUME, when the user answered.
 *
 * That was one caller too few. A duel can also END while a side is still waiting - the person changes
 * the subject, starts another duel, or a moderator turns Battle Mode off (DESIGN-BATTLE 2a-i) - and on
 * that path the marker was never cleared, so an ended duel went on inviting an answer that nothing was
 * listening for. The rule the second caller makes explicit: **a duel that ends removes every affordance
 * that invited the next input.**
 *
 * It lives in its own module so both callers share one implementation. The abandon path runs in an API
 * Lambda; importing the async processor for forty lines would have pulled the whole generation stack in
 * with them, and a copy would have been a second implementation to keep in step.
 */

import {
  ChimeSDKMessagingClient,
  GetChannelMessageCommand,
  UpdateChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';

const messagingClient = new ChimeSDKMessagingClient({});

/** `<!--battlewaiting:...-->`, the only marker this clear touches. */
const BATTLE_WAITING_MARKER = /<!--battlewaiting:[^>]*-->/g;

/**
 * End the waiting affordance on the message holding this side's clarifying question (ADR-029).
 *
 * The QUESTION TEXT STAYS: it is a real part of the duel and the transcript, and an answer lands on a
 * placeholder of its own rather than overwriting this message. Only the marker goes.
 *
 * Read-then-write, because only the channel knows what the question said - the battle row drops
 * `clarificationQuestion` on resume, deliberately, so this cannot reconstruct the content locally.
 *
 * BEST-EFFORT BY CONSTRUCTION. A failure here leaves a stale "Replying to:" affordance on one message,
 * which is cosmetic; throwing would cost the user the answer they are waiting for, or abort the end of a
 * duel. Logged so it is visible rather than silent.
 *
 * Returns whether a marker was actually removed, so a caller can report honestly. `false` covers both
 * "never carried one" and "already cleared", which are the same thing to a caller.
 */
export async function clearBattleWaitingMarker(
  channelArn: string,
  messageId: string,
  botArn: string,
): Promise<boolean> {
  try {
    const current = await messagingClient.send(new GetChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: messageId,
      ChimeBearer: botArn,
    }));
    const raw = current.ChannelMessage?.Content || '';
    const decoded = (() => {
      try { return decodeURIComponent(raw); } catch { return raw; }
    })();
    if (!BATTLE_WAITING_MARKER.test(decoded)) {
      BATTLE_WAITING_MARKER.lastIndex = 0;
      return false; // already cleared, or never carried one
    }
    BATTLE_WAITING_MARKER.lastIndex = 0;
    const cleared = decoded.replace(BATTLE_WAITING_MARKER, '').trimEnd();
    await messagingClient.send(new UpdateChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: messageId,
      Content: encodeURIComponent(cleared),
      ChimeBearer: botArn,
      Metadata: current.ChannelMessage?.Metadata,
    }));
    return true;
  } catch (err) {
    console.warn('[battle] could not clear the waiting marker (non-fatal):', err);
    return false;
  }
}
