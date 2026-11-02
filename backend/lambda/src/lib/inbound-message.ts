/**
 * WHICH MESSAGE A TURN IS ANSWERING, when nothing told the turn.
 *
 * Amazon Chime SDK sends Lex three request attributes and the inbound `MessageId` is not among them,
 * so a component that needs the id - to anchor a task row, to name the work a queue is waiting
 * behind - has to recover it by reading the channel and matching the exact text it was handed.
 *
 * ITS OWN MODULE because two components need it and they must not each grow a copy: the router
 * resolves it for a task row, and the processor resolves it to record what the running turn is
 * answering. A second implementation of a content match is a second set of rules about which message
 * counts, and the two would drift silently - the failure would read as "the wrong message was
 * linked", which is indistinguishable from a bad match.
 */

import { ChimeSDKMessagingClient, ListChannelMessagesCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';
import { recentChannelMessages, decodeContent } from './chime/history.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const messagingClient = sessionClient(ChimeSDKMessagingClient, { region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });

/** The message, and whether it was addressed privately. `targeted` absent means nobody found out. */
export interface InboundMessage {
  messageId: string;
  targeted?: boolean;
  /** When Amazon Chime SDK recorded the message (ISO 8601), when the lookup read it. */
  createdAt?: string;
}

/**
 * Find the message by its exact text, newest first.
 *
 * ONE READ ANSWERS BOTH, which is the whole reason they are resolved together. `ChannelMessageSummary`
 * carries `Target`, so the listing that identifies the message is already holding its addressing, and
 * asking again with `GetChannelMessage` would pay a second round trip for a field that was in hand and
 * thrown away. The caller needs both at one instant - a task row is written with an id and a visibility
 * at the same moment - so splitting them into two questions is also two chances to answer only half.
 *
 * `targeted` IS UNDEFINED WHEN NOTHING ESTABLISHED IT, never `false`. Those are different claims:
 * `false` says the message was sent to the room, `undefined` says nobody found out. A caller that
 * writes conversation-visible from the second publishes the existence of a request somebody addressed
 * privately - so absence stays absence here, for the caller to decline to act on, rather than being
 * folded into a default that reads like knowledge.
 *
 * HOW FAR BACK TO LOOK IS THE CALLER'S, because it depends on WHEN the caller reads. A component
 * reading before its own first frame has at most the person's own message above the one it wants; one
 * reading after the placeholder is posted has that, a possible deferral notice, and whatever queued
 * behind the running turn. A message that falls outside the window is simply not found, and the
 * caller then anchors to nothing - so a later reader asks for a wider window.
 *
 * HOW FAR FORWARD IS THE CALLER'S TOO, and for the same reason (ADR-038). Newest-first is exact for a
 * caller reading the instant the message arrives, because nothing later exists yet. It is not exact
 * for one reading after its own turn started: under the turn queue a person who repeats themselves
 * has an identical message sitting ABOVE the one being handled, and the newest match is then the
 * queued one. A caller that knows when its turn started says so with `notAfter`, and the match is
 * taken from the messages that already existed at that instant.
 *
 * Returns an empty id on any failure. An absent id costs an anchor, never a turn.
 */
export async function findInboundMessage(args: {
  channelArn: string;
  senderArn: string;
  botArn: string;
  /** The exact text of the message being handled. This is what makes the match identifying. */
  userMessage: string;
  /** How many recent messages to look through. Amazon Chime SDK caps this at 50. */
  maxResults?: number;
  /**
   * THE LATEST INSTANT A CANDIDATE MAY HAVE BEEN CREATED AT (epoch milliseconds).
   *
   * A message created after the caller's turn began is, by construction, not the message that turn is
   * answering. Absent leaves the newest-first rule untouched, which is what a caller reading at
   * arrival wants.
   *
   * A candidate whose creation instant Amazon Chime SDK did not report is NOT taken when this is set:
   * it cannot be shown to have preceded the bound, and a wrong anchor here is worse than none.
   */
  notAfter?: number;
}): Promise<InboundMessage> {
  if (!args.channelArn || !args.senderArn || !args.botArn || !args.userMessage.trim()) {
    return { messageId: '' };
  }

  const wanted = args.userMessage.trim();
  try {
    const listed = await recentChannelMessages(messagingClient, args.channelArn, args.botArn, args.maxResults ?? 20);
    // Newest first, so the first CONTENT match is the message being handled even if the same text was sent
    // more than once. Chime may store content URI-encoded, so compare both forms.
    // With `notAfter`, the first match AT OR BEFORE that instant: messages created after the caller's
    // turn started are skipped, so repeated text queued behind a running turn cannot be taken for the
    // message that started it.
    //
    // The skipped matches are counted so the two reasons for finding nothing stay distinguishable in
    // the log below.
    let matchedButLater = 0;
    // Counted apart from a late match so the log can tell "the message is not in this window" from "a
    // message with exactly this text is addressed to somebody else", which are different findings and
    // want different responses.
    let matchedButAddressedElsewhere = 0;
    for (const m of listed) {
      if (m.Sender?.Arn !== args.senderArn) continue;
      const raw = (m.Content || '').trim();
      const decoded = decodeContent(raw).trim();
      if (raw === wanted || decoded === wanted) {
        if (args.notAfter !== undefined) {
          const createdAt = m.CreatedTimestamp ? new Date(m.CreatedTimestamp).getTime() : NaN;
          if (!Number.isFinite(createdAt) || createdAt > args.notAfter) {
            matchedButLater += 1;
            continue;
          }
        }
        // BOTH SPELLINGS, the same way triage reads them: being wrong in the direction of "not
        // targeted" is the expensive error, because it publishes a request somebody sent privately.
        const target = m.Target ?? (m as { Targets?: unknown[] }).Targets;
        const targetArns = Array.isArray(target)
          ? (target as Array<{ MemberArn?: string }>).map((t) => t?.MemberArn).filter((a): a is string => !!a)
          : [];
        // ── THE TARGET MUST NAME THIS ASSISTANT, NOT MERELY EXIST ─────────────────────────────────
        //
        // This read `target.length > 0` and called that "targeted", which answers "was this private
        // to somebody" when the only useful question is "was this private TO ME". Amazon Lex is sent
        // no inbound message id, so this content match is how the turn finds the message it is
        // answering - and a candidate addressed to a DIFFERENT member is not that message, however
        // exactly its text matches.
        //
        // SKIPPED RATHER THAN RETURNED AS UNTARGETED, and the direction is the whole point. Returning
        // it with `targeted: false` would tell the caller a privately-sent message was public, which
        // is the error this function's own comment calls expensive. Skipping keeps looking, and
        // finding nothing degrades to exactly what this path did before an id could be recovered.
        //
        // Amazon Chime SDK very likely never hands us such a candidate: a targeted message is readable
        // only by its sender or its target, measured 2026-09-16. This is the second layer, which is
        // the one that still holds if that rule is ever narrower than believed.
        if (targetArns.length > 0 && !targetArns.includes(args.botArn)) {
          matchedButAddressedElsewhere += 1;
          continue;
        }
        return {
          messageId: m.MessageId || '',
          targeted: targetArns.length > 0,
          ...(m.CreatedTimestamp ? { createdAt: new Date(m.CreatedTimestamp).toISOString() } : {}),
        };
      }
    }
    // No usable content match: the message is not in the window, its stored form differs from the
    // transcript, or every copy of the text was sent after the caller's turn had already started.
    // Return nothing rather than the newest message from this sender - anchoring to the WRONG message is
    // worse than not anchoring, because the link still looks live.
    //
    // THE TWO READ DIFFERENTLY TO AN OPERATOR. A message outside the window is a window that is too
    // narrow; text that exists only after the turn began is the person repeating themselves while the
    // assistant works, which is ordinary and is exactly what the bound is for.
    if (matchedButAddressedElsewhere > 0) {
      // NAMED, because the alternative is a turn that anchors to nothing for a reason nobody can see.
      // A message with this exact text, from this sender, inside the window, addressed to a member
      // that is not this assistant, is not an ordinary miss: either somebody is addressing a different
      // assistant in the same words, or a client set a `Target` that disagrees with what it wrote.
      console.warn('[InboundMessage] a matching message is addressed to another member; not anchoring '
        + 'to it', { matchedButAddressedElsewhere, matchedButLater });
    } else if (matchedButLater > 0) {
      console.warn('[InboundMessage] every copy of this text was sent after the turn started; '
        + 'the turn declares nothing', { matchedButLater });
    } else {
      console.warn('[InboundMessage] the message being answered was not found in the recent window');
    }
    return { messageId: '' };
  } catch (err) {
    console.warn('[InboundMessage] could not resolve the inbound MessageId:', (err as Error).name);
    return { messageId: '' };
  }
}
