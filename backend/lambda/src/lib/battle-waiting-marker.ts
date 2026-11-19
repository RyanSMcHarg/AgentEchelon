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
import { sessionClient } from './assistant-session.js';

const messagingClient = sessionClient(ChimeSDKMessagingClient, {});

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
/**
 * A DUEL SIDE'S MESSAGE DECLARES THAT ITS TASK ENDED WITH THE DUEL. The task the message carries (`activeTask`) is
 * stated `cancelled` with the ending `battle-ended`, which the archive records as the task's ending
 * (`task_terminal`) and the evaluation reads as abandoned work. Only a task this end actually closed is declared;
 * metadata that cannot be read, or that would outgrow the Amazon Chime SDK cap, is left as it was.
 */
export function declareDuelEnded(current: string | undefined, closedTaskIds: ReadonlySet<string>): string | undefined {
  if (!current) return current;
  try {
    const meta = JSON.parse(current) as Record<string, any>;
    const holder = meta?.analytics && typeof meta.analytics === 'object' ? meta.analytics : meta;
    const taskId = holder?.activeTask?.taskId;
    if (typeof taskId !== 'string' || !closedTaskIds.has(taskId)) return current;
    holder.activeTask = { ...holder.activeTask, status: 'cancelled' };
    holder.taskEnding = 'battle-ended';
    const next = JSON.stringify(meta);
    return next.length <= 1024 ? next : current;
  } catch {
    return current;
  }
}

export async function clearBattleWaitingMarker(
  channelArn: string,
  messageId: string,
  botArn: string,
  /** The assistant's own client, when the caller speaks for it on a session of its own (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b). */
  client: Pick<ChimeSDKMessagingClient, 'send'> = messagingClient,
  /** What the edit writes as the message's Metadata, given what it holds now. Default: unchanged. */
  metadataFor: (current: string | undefined) => string | undefined = (current) => current,
): Promise<boolean> {
  try {
    const current = await client.send(new GetChannelMessageCommand({
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
    await client.send(new UpdateChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: messageId,
      Content: encodeURIComponent(cleared),
      ChimeBearer: botArn,
      Metadata: metadataFor(current.ChannelMessage?.Metadata),
    }));
    return true;
  } catch (err) {
    console.warn('[battle] could not clear the waiting marker (non-fatal):', err);
    return false;
  }
}
