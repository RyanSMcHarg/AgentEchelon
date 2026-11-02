/**
 * ONE NOTICE, UPDATED - NEVER ONE PER MESSAGE (ADR-033).
 *
 * Tenet 4 says a deferred message gets a reply rather than silence. The obvious implementation posts
 * that reply each time, and it reproduces the exact doubling this whole design exists to prevent,
 * wearing different clothes: a person who sends three messages while the assistant is busy gets three
 * near-identical "still working on it" messages, and the conversation is noisier than if nothing had
 * been said at all.
 *
 * So there is ONE notice per conversation. The first queued message posts it; every later one UPDATES
 * it with the current count; and it is never deleted, because a delete emits a moderation-shaped
 * event about a message nobody moderated and erases the record that the person waited.
 *
 * ── WHY THIS CANNOT RIDE THE LEX RESPONSE ────────────────────────────────────────────────────────
 *
 * Because updating a message requires its id, and a reply returned through Lex is materialized by the
 * channel flow: the handler never learns which message it became. So the notice is POSTED by the
 * assistant directly, the same way a bypass turn already speaks its own acknowledgment, and the id
 * that comes back is what makes the second send an update rather than a second message.
 *
 * ── IT DEGRADES INTO THE OLD BEHAVIOR, NEVER INTO SILENCE ───────────────────────────────────────
 *
 * Every failure here returns null, and the caller falls back to handing the notice to Lex. A person
 * seeing two notices is untidy; a person seeing none cannot tell a deferral from a broken assistant,
 * and tenet 4 exists to prevent exactly that.
 *
 * ── EVERY WRITE DECLARES THE NOTICE'S KIND ─────────────────────────────────
 *
 * Each post and each update carries `turnKind: queue_ack`. It matters most when the notice is written
 * INTO the running answer's placeholder: that message carries the turn's correlation marker, so without a
 * declared kind both exchange pairers took it as the answer, and the answer the turn then posted at the
 * end counted as a turn with no exchange and no kind. Every write carries it, not only the first, because
 * the in-batch pairer reads whichever update of the message its batch happens to hold.
 */

import { templateLine } from './message-lines.js';
import {
  ChimeSDKMessagingClient,
  GetChannelMessageCommand,
  UpdateChannelMessageCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { rememberNotice, advanceQueueStatus } from './turn-lock.js';
import { readPlaceholderMapping } from './abuse-controls.js';
import type { AssistantCopy } from './active-profile.js';
import {
  configuredQueueStatusLabel,
  statesThatMayPrecede,
  QUEUE_DRAIN_MACHINE,
  type QueueStatus,
} from './turn-queue-status.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';
import { sendChannelMessage } from './chime/send.js';
import { QUEUE_ACK_TURN_KIND } from './turn-declaration.js';

const client = sessionClient(ChimeSDKMessagingClient, { region: process.env.AWS_REGION || 'us-east-1', requestHandler: BOUNDED_REQUEST_HANDLER });

/**
 * What the notice says, from the state rather than from which branch posted it.
 *
 * THE DROP IS ALWAYS STATED. An overflowed queue discarded something the person sent, and that is
 * theirs to know - a count that quietly stopped rising is the one thing this copy must never be.
 */
export function noticeText(args: {
  depth: number;
  overflowed: boolean;
  /**
   * THE ASSISTANT'S OWN WORDS, when the deployment configured them.
   *
   * This line is posted on the fast path, where a model call would cost a waiting person seconds they
   * are already unhappy about - so unlike almost everything else the assistant says, it cannot be
   * generated. Fixed English broke two tenets at once: a configured persona never reached it, and a
   * conversation held in another language got English at its most confusing moment.
   *
   * So it is CONFIGURATION. Absent leaves the shipped English, which is what every deployment that has
   * not set it already had.
   */
  copy?: AssistantCopy;
}): string {
  const { depth, overflowed, copy } = args;
  const name = overflowed ? 'queued-overflow' : depth > 1 ? 'queued-many' : 'queued-one';
  return templateLine(name, { copy }, { values: { count: depth } });
}

/**
 * THE RUNNING ANSWER'S OWN PLACEHOLDER, WHEN THE NOTICE CAN LIVE THERE.
 *
 * The first message to queue behind a running answer is placed right after that answer's placeholder.
 * So the placeholder is where the conversation shows what is happening to the follow-ups: the queue
 * notice goes into it, the reading's note that the follow-ups are being folded in goes into it, and
 * the answer itself is posted as a new message at the end, after everything it addresses
 * (`finalizePlaceholderResponse` reads the placeholder and moves the answer when it has become the
 * notice).
 *
 * ONLY A PUBLIC PLACEHOLDER THAT IS STILL A PLACEHOLDER. A targeted placeholder answers a private
 * request, and the notice is room-visible; a placeholder that already holds an answer or a notice is
 * not waiting for anything. Either way this returns undefined and the notice is posted on its own, as
 * before. A reading holds the lock with no placeholder at all, and gets the same fallback.
 */
export async function findHolderPlaceholder(args: {
  channelArn: string;
  botArn: string;
  holderCorrelationId?: string;
}): Promise<string | undefined> {
  const { channelArn, botArn, holderCorrelationId } = args;
  if (!channelArn || !botArn || !holderCorrelationId) return undefined;
  const messageId = await readPlaceholderMapping(holderCorrelationId).catch(() => null);
  if (!messageId) return undefined;
  try {
    const res = await client.send(new GetChannelMessageCommand({
      ChannelArn: channelArn, MessageId: messageId, ChimeBearer: botArn,
    }));
    const msg = res.ChannelMessage;
    if (!msg || msg.Sender?.Arn !== botArn) return undefined;
    if (Array.isArray(msg.Target) && msg.Target.length) return undefined;
    const content = decodeURIComponent(msg.Content || '');
    if (!content.includes('<!--corr:')) return undefined;
    if (phaseOf(msg.Metadata) === 'final' || phaseOf(msg.Metadata) === 'notice') return undefined;
    return messageId;
  } catch (err) {
    console.warn("[turn-queue-notice] could not read the running answer's placeholder; posting the notice on its own", {
      err: (err as Error)?.message,
    });
    return undefined;
  }
}

function phaseOf(metadata: string | undefined): string | undefined {
  try {
    return JSON.parse(metadata || '{}')?.respPhase;
  } catch {
    return undefined;
  }
}

/**
 * What the notice message holds now, read from the message itself (the one source of what it says):
 * the reading's note, if it carries one, which a stage or a settle must not overwrite, and whether it
 * holds an ANSWER instead. The second happens when the answer could not be posted at the end and was written
 * into the placeholder that had become the notice; that message then declares itself final.
 */
async function readNotice(channelArn: string, botArn: string, noticeId: string): Promise<{ note?: string; holdsAnswer: boolean }> {
  try {
    const res = await client.send(new GetChannelMessageCommand({
      ChannelArn: channelArn, MessageId: noticeId, ChimeBearer: botArn,
    }));
    const meta = JSON.parse(res.ChannelMessage?.Metadata || '{}') ?? {};
    const note = meta.carriesProposal === true ? (res.ChannelMessage?.Content || undefined) : undefined;
    return { ...(note !== undefined ? { note } : {}), holdsAnswer: meta.respPhase === 'final' };
  } catch {
    return { holdsAnswer: false };
  }
}

/**
 * WRITE THE READING'S NOTE INTO THE NOTICE.
 *
 * Used when everything the reading found was a follow-up folded into the running answer: the note says
 * so, and it belongs with the notice in the answer's original placeholder rather than as a message of
 * its own at the end, where the answer is about to land. A proposal that asks the person something is
 * still posted at the end, where their reply follows it.
 *
 * The notice metadata is kept (`respPhase: notice`, the depth) so the client's waiting styling reads
 * the same message it always did, and `carriesProposal` stops a later stage or settle overwriting the
 * note with notice text.
 */
export async function writeProposalIntoNotice(args: {
  channelArn: string;
  botArn: string;
  noticeId: string;
  content: string;
  depth: number;
}): Promise<boolean> {
  const { channelArn, botArn, noticeId, content, depth } = args;
  // AN ANSWER IS NEVER OVERWRITTEN BY THE NOTE. False, so the caller posts the note at the end instead.
  if ((await readNotice(channelArn, botArn, noticeId)).holdsAnswer) {
    console.log("[turn-queue-notice] the notice holds the answer; the reading's note is not written over it", { noticeId });
    return false;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.send(new UpdateChannelMessageCommand({
        ChannelArn: channelArn,
        MessageId: noticeId,
        Content: encodeURIComponent(content),
        ChimeBearer: botArn,
        Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', turnKind: QUEUE_ACK_TURN_KIND, queueDepth: depth, carriesProposal: true }),
      }));
      return true;
    } catch (err) {
      const message = (err as Error)?.message || '';
      if (!/in processing/i.test(message) || attempt === 3) {
        console.warn("[turn-queue-notice] could not write the reading's note into the notice", { noticeId, err: message });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  return false;
}

/**
 * Post the notice, or update the one already showing.
 *
 * Returns the message id on success and null on any failure, which is the caller's signal to fall
 * back to the Lex reply. An UPDATE that fails is treated the same way: the notice it referred to may
 * have been deleted by a moderator, and posting a fresh one is better than saying nothing.
 */
export async function showQueueNotice(args: {
  channelArn: string;
  botArn: string;
  responderId: string;
  depth: number;
  overflowed: boolean;
  /** The notice this conversation is already showing, from the queue record. */
  existingNoticeId?: string;
  /**
   * THE MESSAGE THIS POST IS ACKNOWLEDGING, so the acknowledgement can be measured.
   *
   * The notice IS the response to a queued message - it is fast, visible, and it is what the person
   * gets instead of an answer. Analytics could not see that: a queued message produces no
   * `placeholder_posted`, and both `ttff_ms` and `ack_ms` anchor on one, so every queued turn reported
   * NULL rather than a number. The wait the platform deliberately imposes was not measured as slow, it
   * was not measured at all, and the queued turns simply left the latency population.
   *
   * It could not be reconstructed downstream either. The notice carries no correlation marker, which
   * is what makes a bot message a response, so its own events carry no turn id to join on - and the
   * notice is one message UPDATED in place, so every queued send shares its id and a
   * first-event-per-response rule would collapse them into one. The id has to travel with the post
   * that acknowledges it, which is what this is.
   */
  acknowledges?: string;
  /** This assistant's configured wording, when it has any. */
  copy?: AssistantCopy;
  /**
   * The running answer's placeholder (`findHolderPlaceholder`). When there is no notice yet, the notice
   * is written into it instead of being posted on its own.
   */
  placeholderId?: string;
}): Promise<string | null> {
  const { channelArn, botArn, responderId, depth, overflowed, existingNoticeId, acknowledges, copy, placeholderId } = args;
  if (!channelArn || !botArn) return null;
  const content = noticeText({ depth, overflowed, ...(copy ? { copy } : {}) });

  // INTO THE RUNNING ANSWER'S PLACEHOLDER, when it has one. The answer then moves to the end.
  if (!existingNoticeId && placeholderId) {
    try {
      await client.send(new UpdateChannelMessageCommand({
        ChannelArn: channelArn,
        MessageId: placeholderId,
        Content: encodeURIComponent(content),
        ChimeBearer: botArn,
        Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', turnKind: QUEUE_ACK_TURN_KIND, queueDepth: depth, inPlaceholder: true,
          ...(acknowledges ? { acknowledges } : {}) }),
      }));
      await rememberNotice({ channelArn, responderId, noticeId: placeholderId });
      return placeholderId;
    } catch (err) {
      console.warn("[turn-queue-notice] could not write the notice into the running answer's placeholder; posting it on its own", {
        placeholderId, err: (err as Error)?.message,
      });
    }
  }

  // A NOTICE THAT NOW HOLDS THE ANSWER IS NOT UPDATED. The answer could not be posted at the end and
  // was written into it, so that message is the answer; a fresh notice is posted below instead, and the
  // pointer moves to it.
  const existingHoldsAnswer = !!existingNoticeId && (await readNotice(channelArn, botArn, existingNoticeId)).holdsAnswer;
  if (existingHoldsAnswer) {
    console.log('[turn-queue-notice] the notice holds the answer; posting a fresh notice', { existingNoticeId });
  }

  if (existingNoticeId && !existingHoldsAnswer) {
    try {
      await client.send(new UpdateChannelMessageCommand({
        ChannelArn: channelArn,
        MessageId: existingNoticeId,
        Content: encodeURIComponent(content),
        ChimeBearer: botArn,
        // `notice`, so the ledger does not read a deferral as a step of an answer. It closes nothing:
        // the turn this person is waiting on is somebody else's and is still running.
        Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', turnKind: QUEUE_ACK_TURN_KIND, queueDepth: depth,
          ...(acknowledges ? { acknowledges } : {}) }),
      }));
      return existingNoticeId;
    } catch (err) {
      // It may have been moderated away. Fall through and post a fresh one rather than going quiet.
      console.warn('[turn-queue-notice] could not update the notice; posting a new one', {
        existingNoticeId, err: (err as Error)?.message,
      });
    }
  }

  try {
    // ONE MESSAGE BY CONSTRUCTION: the queue's notice is the one message that is updated in place as more arrives.
    const res = await sendChannelMessage(client, {
      ChannelArn: channelArn,
      Content: encodeURIComponent(content),
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: botArn,
      // UNTARGETED, deliberately. Other members seeing that messages are waiting is what stops them
      // reading the silence as a broken assistant and sending a duplicate of their own. What it does
      // NOT carry is which messages - a targeted request must not become visible through this.
      Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', turnKind: QUEUE_ACK_TURN_KIND, queueDepth: depth,
          ...(acknowledges ? { acknowledges } : {}) }),
    });
    const messageId = res.MessageId;
    if (!messageId) return null;
    // Recorded so the NEXT queued message updates this one instead of adding another. Best effort:
    // a failed write costs one duplicate notice, not the notice itself.
    await rememberNotice({ channelArn, responderId, noticeId: messageId });
    return messageId;
  } catch (err) {
    console.warn('[turn-queue-notice] could not post the notice; handing it back to Lex', {
      err: (err as Error)?.message,
    });
    return null;
  }
}

/**
 * MOVE THE NOTICE ON TO THE NEXT STAGE.
 *
 * A queue being worked looks exactly like a queue that is stuck: the same messages marked waiting,
 * for as long as it takes. This is the difference between the two, and it is carried on the message
 * the client is ALREADY watching rather than on a new signal - the notice is the thing a person is
 * looking at, and it is the thing whose arrival the client subscribes to.
 *
 * BEST EFFORT, ALWAYS. A stage that fails to render costs a person a progress line; failing the drain
 * over it would cost them the work. The depth is carried unchanged so a client that reads it for the
 * waiting styling keeps reading the same number it had.
 */
export async function advanceQueueNotice(args: {
  channelArn: string;
  botArn: string;
  responderId: string;
  noticeId: string;
  depth: number;
  status: QueueStatus;
  copy?: AssistantCopy;
}): Promise<boolean> {
  const { channelArn, botArn, responderId, noticeId, depth, status, copy } = args;
  if (!channelArn || !botArn || !noticeId) return false;

  // THE RECORD DECIDES WHETHER THIS STAGE HAPPENS, not this function. Two stages written by
  // different awaits in the same turn race, and the loser must not repaint the notice with an
  // earlier stage - which would read as the turn having restarted.
  const configured = configuredQueueStatusLabel(status, copy);

  if (!(await advanceQueueStatus({
    channelArn,
    responderId,
    status,
    cameFrom: statesThatMayPrecede(status),
    // AN ABSENT STAGE IS THE MACHINE'S INITIAL STATE, not "no state". Nothing ever writes `waiting`
    // - a queue starts waiting by existing - so conditioning only on the recorded value meant the
    // FIRST advance could never pass, and with it every one after. The whole stage feature was inert
    // on the deployment while its unit test passed, because that test mocked the write.
    absentCountsAsStart: statesThatMayPrecede(status).includes(QUEUE_DRAIN_MACHINE.initial as QueueStatus),
  }))) return false;

  // A NOTE ALREADY WRITTEN INTO THE NOTICE IS NOT REPAINTED WITH NOTICE TEXT. The stage is recorded
  // above; the message keeps saying what the reading said. NOR IS AN ANSWER: when the answer could not
  // be posted at the end it was written into this message, and a stage painted over it would replace
  // the person's answer with "still working".
  const current = await readNotice(channelArn, botArn, noticeId);
  if (current.holdsAnswer) {
    console.log('[turn-queue-notice] the notice holds the answer; the stage is not painted over it', { noticeId, status });
    return true;
  }
  if (current.note !== undefined) return true;
  try {
    await client.send(new UpdateChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: noticeId,
      // THE TEXT STAYS THE TEXT. A stage is not prose and does not belong in the message body: it is
      // a state, and a person reads it the way they read a task's state - rendered beneath what was
      // said, not spliced into it. Splicing also made the notice grow a line every time the drain
      // moved, and lost the stage to anything reading the body as a sentence.
      Content: encodeURIComponent(noticeText({ depth, overflowed: false, ...(copy ? { copy } : {}) })),
      ChimeBearer: botArn,
      // A TOKEN, so the client can say it in the language the person is reading. The deployment's own
      // wording rides alongside ONLY when it set some, and wins where it did: a translation must not
      // override words somebody deliberately chose.
      Metadata: JSON.stringify({
        botResponse: true,
        respPhase: 'notice',
        turnKind: QUEUE_ACK_TURN_KIND,
        queueDepth: depth,
        queueStatus: status,
        ...(configured ? { queueStatusLabel: configured } : {}),
      }),
    }));
    return true;
  } catch (err) {
    console.warn('[turn-queue-notice] could not show the queue stage', {
      channelArn, status, err: (err as Error)?.message,
    });
    return false;
  }
}


/**
 * Settle the notice when the queue empties.
 *
 * WITHOUT THIS THE NOTICE LIES FOREVER. It is posted saying "still working on your earlier message"
 * and updated with a count as more arrive; when triage finally reads them, nothing touched it again.
 * A conversation that had been busy an hour ago still showed a message claiming it was busy now.
 *
 * IT IS ALSO THE EVENT THE CLIENT WAITS ON. The queued styling is driven by changes to this message,
 * so a queue that clears without an update leaves every waiting message styled as waiting until
 * something else happens to touch the conversation. The lie and the stale UI are the same defect.
 *
 * NEVER DELETED, only rewritten. A delete emits a moderation-shaped event about a message nobody
 * moderated, and it erases the record that the person waited at all.
 */
export async function settleQueueNotice(args: {
  channelArn: string;
  botArn: string;
  noticeId: string;
  /** How many were read. Zero when the queue was emptied without producing anything. */
  triaged: number;
  copy?: AssistantCopy;
  /**
   * WHAT THE ANSWERING TURN WAS, when the notice it settles is that turn's own displaced placeholder.
   *
   * A turn whose placeholder became the queue notice posts its answer as a new message at the end, and
   * that answer pairs through its own declaration. The attribution on the notice records which turn the
   * displaced placeholder belonged to; the notice's declared kind keeps it out of the exchange pairing.
   *
   * Supplied ONLY by the turn that owns the placeholder. A READING must never supply it: a reading
   * answers a burst, so it has no single message to name, and it declares `turnKind: 'reading'`
   * precisely to stay out of the exchange population.
   *
   * Built by `closeOutAttribution`, so there is one decision about what may ride a close-out rather
   * than two that can drift.
   */
  attribution?: Record<string, unknown>;
}): Promise<void> {
  const { channelArn, botArn, noticeId, triaged, copy } = args;
  if (!channelArn || !botArn || !noticeId) return;
  // THE READING'S NOTE STAYS. A notice carrying it already says what happened to the follow-ups, and
  // "caught up" written over it would erase the one sentence the person needs.
  const current = await readNotice(channelArn, botArn, noticeId);
  // AN ANSWER IS NEVER OVERWRITTEN BY "CAUGHT UP". When the answer could not be
  // posted at the end it was written into this message, and settling it would replace the person's
  // answer with a status line. The answer is the last word on that message.
  if (current.holdsAnswer) {
    console.log('[turn-queue-notice] the notice holds the answer; it is not settled over it', { noticeId });
    return;
  }
  const keptNote = current.note;
  const keepNote = keptNote !== undefined;
  const content = templateLine('queue-settled', { copy }, { count: triaged });
  // ── RETRIED, BECAUSE NOTHING COMES AFTER IT (live evidence, 2026-09-09) ───────────────────────
  //
  // Every other write to this message is superseded by the next one, so losing one costs a moment of
  // stale text. This write is the LAST one, and it is the event a client watches to stop showing a
  // message as waiting - so losing it is permanent, in the interface, on the person's own message.
  //
  // And it was being lost reliably. `showStage('clearing')` updates this same notice a few hundred
  // milliseconds earlier, and an update is itself carried through the channel flow: while one is in
  // flight Amazon Chime SDK refuses the next with `No operations allowed for messages in processing`.
  // Observed on the turn-queue sweep 2026-09-09 - the record drained, the work was created, the
  // answer was delivered, and the notice went on reading "Still working on your earlier message"
  // with the person's message marked waiting underneath it. The e2e failure this explains was
  // recorded in TROUBLESHOOTING.md #22 as a client-side defect, which it never was.
  //
  // Only that refusal is retried. It says "ask again", and it is the one failure here that clears on
  // its own; anything else (a redacted notice, a moderation refusal, a bearer without permission) is
  // an answer, and repeating the call would only delay saying so.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.send(new UpdateChannelMessageCommand({
        ChannelArn: channelArn,
        MessageId: noticeId,
        Content: keptNote ?? encodeURIComponent(content),
        ChimeBearer: botArn,
        // `queueDepth: 0` is what tells a client the queue is empty. It is the same field the notice
        // carries while filling, so a reader has one thing to watch rather than two.
        // AND THE STAGE IT SETTLED INTO. Without it the settle carried no stage at all, and a client
        // that keeps the last one it saw - because a stage update is one field among many on a message
        // it merges - went on showing `clearing the queue`, pulsing, underneath a notice that now read
        // `caught up`. Permanently: nothing else was ever going to arrive to correct it.
        Metadata: JSON.stringify({
          botResponse: true, respPhase: 'notice', queueDepth: 0, queueStatus: 'settled',
          ...(keepNote ? { carriesProposal: true } : {}),
          // `respPhase: 'notice'` still governs the ledger row this update produces (051 excludes a
          // response made only of notices from `v_turn_latency`). The attribution says which turn the
          // displaced placeholder belonged to and pairs nothing: the kind below says this is a notice,
          // and both pairers skip every declared kind.
          ...(args.attribution ?? {}),
          // AFTER the attribution, so nothing it carries can take the kind away.
          turnKind: QUEUE_ACK_TURN_KIND,
        }),
      }));
      return;
    } catch (err) {
      const message = (err as Error)?.message || '';
      const stillProcessing = /in processing/i.test(message);
      if (!stillProcessing || attempt === 3) {
        console.warn('[turn-queue-notice] could not settle the notice; it will read as stale', {
          noticeId, attempt, retriable: stillProcessing, err: message,
        });
        return;
      }
      // The flow releases a message in well under a second; this waits longer each time rather than
      // hammering a state it cannot influence.
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}
