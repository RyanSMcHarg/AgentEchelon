/**
 * TRIAGE WHEN THE MESSAGE ARRIVES, NOT WHEN THE TURN ENDS (ADR-033).
 *
 * The queue's whole point is the person who kept typing while the assistant was busy, and the
 * question the design exists to ask them is whether the work in flight is still wanted. Triage ran in
 * the processor's `finally`, so it began only once the turn ENDED - and asked "do you still want me
 * to finish what I was working on?" about a report that had already finished. An interrupt evaluated
 * after the work completes is not an interrupt.
 *
 * ── WHY THIS COULD NOT SIMPLY BE MOVED ───────────────────────────────────────────────────────────
 *
 * Because it looked like it needed the turn lock, and the turn lock is the one thing tenet 2 says may
 * never be freed by a clock. Off-turn, either the lock is released while triage is pending - and a
 * message claims the conversation and runs alongside it - or it is held by something whose liveness
 * nothing can attest, and then only a TTL frees it.
 *
 * THE BLOCKER DISSOLVES ONCE THE TWO QUESTIONS ARE SEPARATED. The turn lock answers "who may
 * ANSWER", and while triage runs the turn it is triaging behind is still running and still holds it,
 * correctly. Triage answers nothing: it reads the queue, creates tasks, and posts a proposal. What it
 * needs is exclusion from ITSELF - two messages arriving together must not create the work twice -
 * which is a weaker claim whose stranding costs a delay rather than silence. See `claimTriage`.
 *
 * ── IT RUNS HERE BECAUSE THE STREAM IS THE ARRIVAL ───────────────────────────────────────────────
 *
 * Post-processing is already a consumer of the message stream with no batching window, measured at
 * ~200 to 500ms from message to dispatch. That is the platform's existing "act on a message as it
 * lands" seam, and triage is that seam applied to a new rule rather than a new component.
 */

import { sessionClient } from './assistant-session.js';
import { settleDrainTask, recallClarifiedMessage } from './queue-drain-task.js';
import { readTurnState, claimTriage, releaseTriage, clearQueue } from './turn-lock.js';
import { settleQueueNotice } from './turn-queue-notice.js';
import { triageQueuedMessages, dispatchTriageTurn } from './turn-triage.js';
import { readChannelClassificationTag } from './channel-classification.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { turnAssistantProfileForBot, logAssistantDecline } from './turn-assistant.js';
import { liveAssistantsByHandleOrThrow } from './default-agents.js';
import { principalIdFromArn } from './task-tracking.js';
import { arrivalTriageCorrelationId } from './correlation.js';
import { adoptSessionAsAssistant, releaseAssistantSession } from './assistant-session.js';
import type { MessageStreamEvent } from './message-stream-event.js';

import { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { botIdFromArn } from './person-arn.js';

const chime = sessionClient(ChimeSDKMessagingClient, { region: process.env.AWS_REGION || 'us-east-1' });

/**
 * THE TRIGGER IS THE DEFERRAL NOTICE, and choosing it settles two problems at once.
 *
 * The queue is keyed per (conversation, ASSISTANT), so acting on it needs to know which assistant -
 * and a user message on the stream does not say. Reading the conversation members to find out would
 * be a Chime call on every message in the deployment, to answer a question almost none of them are
 * about.
 *
 * The notice already carries it. It is posted BY the assistant whose queue this is, immediately after
 * a message is deferred, and updated on every further one - so its sender IS the responder, and its
 * arrival is exactly the moment the queue changed. No lookup, and no new signal invented for it.
 */
function noticeFor(event: MessageStreamEvent): { channelArn: string; responderId: string; depth: number } | null {
  const payload = event?.Payload;
  const channelArn = payload?.ChannelArn;
  const senderArn = payload?.Sender?.Arn || '';
  if (!channelArn || !senderArn.includes('/bot/')) return null;

  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(payload?.Metadata || '{}'); } catch { return null; }
  // A DEFERRAL notice with something still waiting. The settled notice carries zero, which is the
  // signal that the queue is empty - acting on it would read a queue that is already gone.
  if (metadata.respPhase !== 'notice') return null;
  if (!(typeof metadata.queueDepth === 'number' && metadata.queueDepth > 0)) return null;

  // A STAGE UPDATE IS NOT A NEW DEFERRAL, and telling them apart is what stops this re-entering.
  //
  // The trigger is "the queue changed", and it is recognized by a notice carrying a depth. But the
  // drain UPDATES that same notice as it moves - reviewing, clarifying, clearing - and each update
  // carries the same phase and the same non-zero depth, because the queue genuinely still holds
  // those messages until the turn that is reading them clears them at the end.
  //
  // So every stage re-triggered arrival triage, inside the window where the claim had already been
  // released and the queue not yet cleared: a second triage over the same ids, and because triage
  // turns bypass the turn claim and task creation is not idempotent, the person got duplicate work
  // items and two proposals for one queue.
  //
  // Only `advanceQueueNotice` writes `queueStatus`; a genuine new deferral never does. That is the
  // difference, and it is read here rather than inferred from timing.
  if (typeof metadata.queueStatus === 'string' && metadata.queueStatus) return null;

  return { channelArn, responderId: principalIdFromArn(senderArn), depth: metadata.queueDepth as number };
}
/**
 * Triage the queue behind a running turn.
 *
 * ── EVERY EXIT IS A NO-OP, AND ALMOST EVERY MESSAGE TAKES ONE ────────────────────────────────────
 *
 * This runs on every message in the deployment, so the common path has to be cheap and silent. The
 * notice check above rejects all of them without a single call: only a bot-authored notice carrying a
 * non-zero depth gets past it.
 *
 * ── AND THE TURN IT TRIAGES BEHIND KEEPS THE LOCK ────────────────────────────────────────────────
 *
 * No handover, which is the whole difference from the turn-completion path this replaces. That path
 * had to hand the lock over because it ran at the moment the turn released it; here the turn is still
 * running and still holds it, which is correct - this dispatch is not an answer and must not be
 * treated as one.
 */
/**
 * What the running turn is working on, in words a reading can compare a queued message against.
 *
 * Resolved from the message the turn is answering rather than stored as text, the same discipline the
 * queue itself follows. Trimmed hard: this is a LABEL for a comparison, not context to reason from,
 * and a fifteen-paragraph prompt reproduced in full would crowd out the queue it is meant to help
 * classify.
 */
/** Exported for the test that pins the transform, after a mangled one shipped unnoticed. */
export async function inFlightDescription(
  holderMessageId: string | undefined, channelArn: string, botArn: string,
): Promise<string> {
  const BARE = 'the work already in progress';
  if (!holderMessageId) return BARE;
  const text = await recallClarifiedMessage({ channelArn, messageId: holderMessageId, botArn })
    .catch(() => '');
  // `\s`, and the backslash is the whole point: written as `/s+/` this deleted every letter "s" from
  // the description - "Please summarise the Q3 sales report" reached the model as "Plea e ummari e
  // the Q3 ale report". The reading was then comparing queued messages against mangled text while the
  // instrument beside it reported `described: true`, so the amendment fix looked verified and was not.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return BARE;
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

export async function triageOnArrival(event: MessageStreamEvent): Promise<void> {
  const notice = noticeFor(event);
  if (!notice) return;
  const { channelArn, responderId, depth } = notice;

  const botArn = event.Payload?.Sender?.Arn || '';

  let state;
  try {
    state = await readTurnState({ channelArn, responderId });
  } catch {
    // Unreadable state is not a reason to act. The next queued message posts another notice.
    return;
  }
  // The notice said a depth; the RECORD is what decides. Between the two, a queue that has already
  // been triaged reads as empty here and this leaves - which is what makes a re-delivered or updated
  // notice harmless rather than a second triage.
  if (!state.queued.length) return;

  // ONE TRIAGE AT A TIME, and this is the only exclusion it needs. Two notices arriving together
  // would otherwise both read the same queue and create the same work twice - duplicates a person has
  // to close by hand.
  // THE DEPTH IS PART OF THE CLAIM, because the notice is UPDATED IN PLACE rather than reposted.
  //
  // A second message arriving behind a deferred turn rewrites the SAME notice with a higher depth,
  // and that is a legitimate trigger - the queue really did change. What was not legitimate is
  // that it arrived carrying the same message id, so the claim it built was the one the running
  // triage already held, and `claimTriage` grants a claim to its own holder so a redelivery is
  // idempotent. Two different runs therefore looked like one run twice, and the second dispatched
  // a triage turn over a queue that was already being read. Observed live: two dispatches seven
  // seconds apart under one correlation id, the second reading two messages while the first still
  // held the queue.
  //
  // Adding the depth keeps the property that mattered and drops the one that did not: the SAME
  // event redelivered still builds the same claim and is still idempotent, while a notice whose
  // depth moved builds a different one, loses it to the reading in flight, and correctly leaves
  // that message to the fold the running turn does before it speaks.
  // FITTED TO WHAT A READER ACCEPTS. Interpolated here it ran to 74 characters against a 64-character
  // bound, so the placeholder mapping was never written and every triage turn paid a ~7s poll and a
  // billed scan to find its own placeholder. The derivation and the measurement are on
  // `arrivalTriageCorrelationId`; it lives there so the next call site cannot reintroduce the bound.
  const claim = arrivalTriageCorrelationId({
    ...(event.Payload?.MessageId ? { messageId: event.Payload.MessageId } : {}),
    channelArn,
    depth,
  });
  if (!(await claimTriage({ channelArn, responderId, by: claim }))) return;

  let dispatched = false;
  try {
    // THIS GUARD WAS DEAD UNTIL ADR-045. It reads as a fail-closed check and was not one:
    // `resolveChannelClassificationTag` substitutes the floor for an unreadable tag and never returns
    // a falsy value, and the `.catch` could not fire either because that resolver swallows its own
    // errors. So a throttled tag read on a PREMIUM channel dispatched the queue to the BASIC router.
    // `readChannelClassificationTag` returns `undefined`, which is what makes the line below real.
    //
    // The claim taken above is released by the `finally`, which releases whenever nothing was
    // dispatched - so returning here leaves no claim behind and the next notice retries.
    const classification = await readChannelClassificationTag(chime, channelArn, '[triage-on-arrival]');
    if (!classification) return;

    // WHICH ASSISTANT'S QUEUE THIS IS, from its assignment record (`turnAssistantProfileForBot`), resolved
    // before the session is adopted so the read goes out on this function's own role. Everything this
    // path says is in that assistant's words. An assistant that cannot be named triages nothing: the
    // claim is released below and the queue is left for a turn that can name it (tenet P4, ADR-046).
    const assistant = await turnAssistantProfileForBot({
      botArn, classification, registry: profiles, liveAssistants: liveAssistantsByHandleOrThrow,
    });
    if (assistant.decision === 'decline') {
      logAssistantDecline('[triage]', assistant.reason, { channelArn, classification, asBot: botIdFromArn(botArn) });
      return;
    }

    // READ AND SETTLE AS THE ASSISTANT WHOSE QUEUE THIS IS, on a session its classification's vend mints
    // for that one bot. This function's own role holds no Amazon Chime SDK bearer grant: the queued
    // messages and the notice are read and edited through the shared conversation clients, which send
    // on the adopted session. Released in the `finally`.
    // A refused session reads nothing and settles nothing; the claim is released below and the next
    // notice tries again.
    try {
      await adoptSessionAsAssistant({ botArn, classification, purpose: 'triage' });
    } catch (err) {
      console.error('[triage] no session for the assistant whose queue this is; not read', {
        channelArn, message: (err as Error)?.message,
      });
      return;
    }

    const triaged = await triageQueuedMessages({ channelArn, botArn, classification, queued: state.queued });
    if (!triaged.messages.length) {
      // NOTHING READABLE, AND THE QUEUE STILL HAS TO EMPTY (invariant B, ADR-033).
      //
      // This returned here, and `clearQueue` runs only inside a triage turn - so a queue whose
      // messages were ALL redacted or markers-only was never cleared by anything. The person was
      // shown "1 message waiting" indefinitely, for a message that no longer had any content to
      // read. `emptiedIds` exists precisely to account for those, and it could not reach the
      // dispatch because there was nothing to dispatch.
      //
      // Cleared directly instead. No turn is started: there is nothing for a model to read, and
      // spending a turn to discover that is the cost this avoids.
      if (triaged.emptiedIds.length) {
        const cleared = await clearQueue({ channelArn, responderId, triagedIds: triaged.emptiedIds, claimedBy: claim })
          .catch((err) => {
            console.error('[triage] the emptied queue could not be cleared', {
              channelArn, message: (err as Error)?.message,
            });
            return false;
          });
        // A REFUSED CLEAR SETTLES NOTHING: this reading no longer holds the drain, so the notice and
        // the drain are the displacing reading's to end.
        if (!cleared) return;
        // AND ONLY WHEN NOTHING IS STILL WAITING (code review, 2026-09-04).
        //
        // This branch fires when the reading produced no messages, and cleared the ids it could
        // account for. Those are not the only ids: a message whose READ failed - throttled, or a
        // transient Chime error - is deliberately left queued for the next attempt, and is not in
        // `emptiedIds`. With one redacted message and one failed read, this settled the notice to
        // "caught up", closed the drain, and cleared the waiting styling on the client, while a
        // message the person sent sat unread in the queue with nothing coming for it.
        //
        // Settling is a CLAIM that the queue was handled. It is made from the record after the
        // clear, never from the subset this pass happened to account for - the same re-read the
        // processor's own clear path already does, and for the same reason.
        // AN UNREADABLE RECORD IS NOT AN EMPTY ONE. `readTurnState` catches its own failure and
        // returns `{ queued: [], unreadable: true }`, so the `.catch` that stood here never ran and an
        // unreadable read scored zero - the false settle this re-read exists to prevent, arriving
        // through the guard meant to catch it.
        const after = await readTurnState({ channelArn, responderId });
        const stillQueued = after.unreadable ? 1 : after.queued.length;
        if (stillQueued) {
          console.warn('[triage] part of the queue could not be read; the notice is NOT settled', {
            channelArn, stillQueued,
          });
        } else {
        // THE NOTICE STOPS SAYING SOMEBODY IS WAITING. Leaving it would be a claim that work is
        // pending when the queue is empty. `triaged: 0` is the case it already names: emptied
        // without producing anything.
        if (state.noticeId) {
          await settleQueueNotice({ channelArn, botArn, noticeId: state.noticeId, triaged: 0 })
            .catch(() => { /* the row is empty either way; the client reads that, not this */ });
        }
        // AND THE DRAIN ENDS WITH IT. The queue emptying, the notice settling and the drain closing
        // are one fact said three ways - to the record, to the person, and to the system - so they
        // are done together. They disagreed once: `clearQueue` removed the drain's id while the row
        // stayed open to its TTL, where it was the newest task the assistant owned in the channel
        // and masked a chain that was genuinely blocked on somebody.
        if (state.drainTaskId) {
          await settleDrainTask({ taskId: state.drainTaskId, channelArn, correlationId: claim });
        }
        }
      }
      return;
    }

    // WHETHER THE READING KNOWS WHAT IT IS COMPARING AGAINST. A drain asked to judge amendments
    // against "the work already in progress" cannot, and the symptom - corrections classified as new
    // work - looks identical to the model simply getting it wrong. This says which of the two it is.
    const inFlightText = state.busy
      ? await inFlightDescription(state.holderMessageId, channelArn, botArn)
      : '';
    if (state.busy) {
      console.log('[triage-on-arrival] what the reading is told is running', {
        channelArn,
        namedTheMessage: !!state.holderMessageId,
        described: inFlightText !== 'the work already in progress',
        chars: inFlightText.length,
      });
    }

    dispatched = await dispatchTriageTurn({
      channelArn,
      botArn,
      classification,
      // THE CLAIM ID IS THE TURN'S ID, so the record NAMES the turn that is reading.
      //
      // These were two different strings for one thing, and nothing could get from the claim to the
      // turn holding it. That mattered at exactly one moment: an answering turn ending while this
      // reading is in flight. Its handover finds the claim held, and to keep the conversation held
      // it has to hand the lock TO somebody - which it could not do, because `triagedBy` named a
      // claim and not a turn. So it released instead, and the reading below carried on with nothing
      // marking the conversation busy.
      //
      // The depth stays in the id for the reason the claim comment gives: a redelivery of the same
      // notice builds the same id and stays idempotent, while a notice whose depth moved builds a
      // different one and correctly loses to the reading already running.
      correlationId: claim,
      senderArn: triaged.messages[triaged.messages.length - 1].senderArn || '',
      messages: triaged.messages,
      visibility: triaged.visibility,
      accountedIds: triaged.emptiedIds,
      // ── THE READING IS TOLD THAT SOMETHING IS RUNNING (ADR-033) ────────────────────────────────
      //
      // A message is in this queue BECAUSE a turn was running - that is the only way it got here -
      // and this dispatch never said so. `inFlight` was therefore false on every arrival reading and
      // every handover reading, and the only place that ever set it read the same false value from
      // its own event. It was false in production, always.
      //
      // Three rules were gated on it and none of them ran:
      //   - "one task per new request, and NONE for an amendment": `createTasksFromProposal` folds an
      //     amends item only when work is in flight, so every amendment opened its own task instead;
      //   - the work in progress taking a subject of its own, so one queued message can be a split;
      //   - the amendment being recorded for the running turn to fold in.
      // Each was written, tested in isolation, and unreachable on the deployment.
      //
      // `busy` is the honest source: it is true exactly while a turn holds this conversation.
      // AND WHAT THAT WORK ACTUALLY IS, when the record names the message it is answering.
      //
      // The label used to be the literal phrase below for every turn, so the model was asked whether
      // a queued message amends work it had been given no description of. It cannot, and corrections
      // came back classified as new work - the amendment became a second item, answered after the
      // thing it was meant to change.
      //
      // Falls back to the bare phrase, which is still true and is what an unresolvable id leaves.
      ...(state.busy ? { inFlightLabel: inFlightText } : {}),
    });
  } catch (err) {
    // Swallowed, like every rule here: a failure must not stall the shard for the messages behind it.
    console.error('[triage-on-arrival] failed; the queue stays for the next notice', {
      channelArn, err: (err as Error)?.message,
    });
  } finally {
    // HELD ACROSS THE DRAIN when a turn actually started. Releasing here is what let a second
    // dispatcher read the same queue: the turn is still reading, and the queue is not cleared
    // until it finishes. The drain ends the claim itself, in the same write that clears the queue.
    //
    // Released only when NOTHING was started, so a run that returned early or failed does not
    // block the next reading. A dispatch that died after this point is bounded by the claim expiry.
    if (!dispatched) {
      await releaseTriage({ channelArn, responderId, by: claim }).catch(() => { /* it expires */ });
    }
    releaseAssistantSession();
  }
}
