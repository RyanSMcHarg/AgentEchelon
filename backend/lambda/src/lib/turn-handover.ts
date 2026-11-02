/**
 * THE LOCK STANDS UNTIL THE ANSWER IS DELIVERED AND THE QUEUE IS EMPTY (ADR-033).
 *
 * Triage runs on message ARRIVAL, which is the right trigger and is not what this file changes. What
 * arrival triage cannot cover is the message that arrives while it is ALREADY RUNNING. It takes
 * `claimTriage` for exactly the reason that claim exists - two notices must not create the same work
 * twice - so a message landing inside that window finds the claim held, returns, and is never read by
 * anything afterwards. It sits in the queue, shown to the person as waiting, and waits forever.
 *
 * Observed in the e2e and live: three messages held, one described in the proposal, `drained: false`.
 *
 * ── WHY THE END OF THE TURN IS THE PLACE TO CATCH IT ─────────────────────────────────────────────
 *
 * Not because time has passed - a sweep on a timer would be tenet D6's polling, and would also be
 * answering a question about work that has already finished. Because turn completion is itself an
 * EVENT, and it is the last moment at which anything still holds this conversation. Whatever is in
 * the queue here was missed by arrival triage and has nothing else coming for it.
 *
 * ── AND WHY IT HANDS THE LOCK OVER RATHER THAN RELEASING IT ──────────────────────────────────────
 *
 * Releasing and letting the next message re-claim leaves the conversation unheld in between. In that
 * gap the queued messages are no longer behind a lock, so the next arrival does not queue - it starts
 * a fresh turn alongside the triage that is being dispatched for it, and the person gets two
 * assistants answering the same backlog.
 *
 * `handOverLock` moves the holder from this turn to the triage turn in ONE conditional write, so
 * there is no instant at which the lock is free. Someone who keeps typing therefore keeps meeting a
 * held lock, which is the rule this implements rather than a side effect of it.
 */

import { settleDrainTask } from './queue-drain-task.js';
import type { AssistantCopy } from './active-profile.js';
import {
  readTurnState, claimTriage, releaseTriage, handOverLock, releaseLock, clearQueue,
  returnAmendmentsToQueue,
} from './turn-lock.js';
import { settleQueueNotice } from './turn-queue-notice.js';
import { handoverCorrelationId } from './correlation.js';
import { triageQueuedMessages, dispatchTriageTurn, resolveRouterArn as resolveOwnRouterArn } from './turn-triage.js';
import { readChannelClassificationTag } from './channel-classification.js';
import { TRIAGE_MAX_PASSES } from './turn-triage-proposal.js';
import { principalIdFromArn } from './task-tracking.js';
import { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { resumeParkedTurnIfAny } from './parked-turn.js';
import { forgetSettledNotice } from './turn-lock.js';
import { sessionClient } from './assistant-session.js';
import { readyTasks as readyTasksOf } from './task-store.js';
import { takePickupPending, releaseLockUnlessPickupPending, turnQueueEnabled } from './turn-lock.js';
import { pickupCorrelationId } from './workflow-task.js';
import { pickupThroughRouter } from './say-through-router.js';

/**
 * Settle a notice the reading left for this answer, then forget its pointer. The pointer is forgotten
 * only while the queue is still empty, so a message that arrived in between keeps its notice.
 */
async function settleNoticeAfterAnswer(args: {
  channelArn: string; botArn: string; responderId: string; noticeId: string; copy?: AssistantCopy;
  /** The answering turn's attribution, carried onto the notice it displaced. See `settleQueueNotice`. */
  attribution?: Record<string, unknown>;
}): Promise<void> {
  const { channelArn, botArn, responderId, noticeId, copy } = args;
  await settleQueueNotice({
    channelArn, botArn, noticeId, triaged: 0,
    ...(copy ? { copy } : {}),
    ...(args.attribution ? { attribution: args.attribution } : {}),
  })
    .catch(() => { /* the record is what the client reads; the text is best-effort */ });
  await forgetSettledNotice({ channelArn, responderId, noticeId });
  console.log('[turn-handover] the answer is delivered; settled the notice the reading left for it', {
    channelArn, noticeId,
  });
}

// Its own client, as `triage-on-arrival` has: this runs in the processor, which otherwise never talks
// to Chime directly, and threading one through the release path would put a messaging dependency in a
// signature whose only job is to say who holds the lock.
const chime = sessionClient(ChimeSDKMessagingClient, { region: process.env.AWS_REGION || 'us-east-1' });

/**
 * THE END OF A PROCESSOR RUN SETTLES THE TURN LOCK, AND ONLY THE RUN THAT WAS ADMITTED MAY.
 *
 * The release is conditional on `holder = <correlationId>`, and a duplicate delivery of the same
 * dispatch carries the SAME correlation id. So a duplicate that lost the dedup claim and returned at
 * once still passed that condition in its `finally`, and released the lock while the admitted run was
 * still answering: the next message then started a second turn beside it instead of queueing.
 *
 * A run that was not admitted touches nothing. Its lock belongs to the run that was, which settles it
 * on its own exit. A run the platform killed outright - whose retry is exactly such a duplicate - is
 * released by the async-invoke onFailure destination (`turn-lock-release-on-failure.ts`) once the
 * retries are spent, so this costs that case a delay, never a stranded conversation.
 */
export async function settleTurnLockAtExit(args: {
  /** Whether this run won the dedup claim (`runSharedPipeline`'s admission). */
  admitted: boolean;
  /** A triage pass was dispatched on this correlation id and still holds the lock through it. */
  redispatchedPass: boolean;
  channelArn: string;
  botArn: string;
  correlationId: string;
  classification?: string;
  triage?: { pass: number };
  /** The assistant's configured wording, carried so nothing this path says is fixed English. */
  copy?: AssistantCopy;
  /**
   * WHAT THIS TURN WAS, for the notice it displaced.
   *
   * A turn whose placeholder became the queue notice answers in a new message at the end, so the
   * exchange is minted against the NOTICE. Carried here, the settle stamps the same declaration and
   * attribution `closeOutAttribution` puts on an ordinary receipt, and that exchange stops being an
   * unattributed row. Supplied only by an ANSWERING turn; a reading names no single message.
   */
  attribution?: Record<string, unknown>;
}): Promise<void> {
  const { admitted, redispatchedPass, channelArn, botArn, correlationId, classification, triage, copy } = args;
  if (!admitted) {
    console.log('[turn-handover] this run was not admitted; the lock belongs to the run that was', {
      channelArn, correlationId,
    });
    return;
  }
  // SHORT-CIRCUIT WHEN A PASS IS STILL READING. Calling the handover here would find the queue still
  // populated (the pass that clears it has not finished) and, if the triage claim had expired,
  // dispatch a SECOND reader for the same messages.
  if (redispatchedPass) return;
  // ── A READING NEVER ENDS WITH AN ANSWER STILL WAITING FOR IT ────────────────
  //
  // The reading resumes a parked answer once it has recorded its follow-ups. Every other way a
  // reading can end - an unreadable reply that asked instead, an error the handler caught - would
  // otherwise leave that answer parked with nothing coming for it, and the person watching a
  // placeholder that never resolves. So the last thing a reading does is resume it if nobody has.
  // The resume is idempotent: a reading that already resumed it finds nothing to do.
  if (triage) {
    await resumeParkedTurnIfAny({ channelArn, botArn, readerCorrelationId: correlationId })
      .catch((err: unknown) => console.error('[turn-handover] could not resume a parked answer at the reading\'s exit', {
        channelArn, correlationId, err: (err as Error)?.message,
      }));
  }
  const handedOver = await handOverToFollowUpTriage({
    channelArn, botArn, correlationId,
    ...(classification ? { classification } : {}),
    ...(triage ? { triage: { pass: triage.pass } } : {}),
    ...(copy ? { copy } : {}),
    ...(args.attribution ? { attribution: args.attribution } : {}),
  }).catch((err) => {
    console.error('[AsyncProcessor] the follow-up handover threw; the queue may be left unread', {
      correlationId, message: (err as Error)?.message,
    });
    return false;
  });
  if (handedOver) return;
  // ── NOTHING QUEUED: THE ASSISTANT IS IDLE HERE, SO IT TAKES UP ITS OWN WORK (ADR-063 decision 5) ─────────────
  //
  // The first of the two events idle is entered at. The lock is handed to a pickup turn for the first ready task, in
  // priority order, in one conditional write, so the conversation is never unheld between the two; with none ready it
  // is released only while no task was named ready meanwhile.
  if (await handOverToPickup({ channelArn, botArn, correlationId, ...(classification ? { classification } : {}) })
    .catch((err) => {
      console.warn('[turn-handover] the pickup handover threw; releasing', { correlationId, message: (err as Error)?.message });
      return false;
    })) return;
  // Swallowed: this turn is over either way. Nothing recovers a lock stranded by this write failing
  // except the next arriving message taking it over as stale.
  await releaseLock({ channelArn, responderId: principalIdFromArn(botArn), correlationId })
    .catch(() => { /* see above */ });
}

/**
 * TAKE UP THE NEXT READY TASK, OR RELEASE (ADR-063 decision 5). True when the lock no longer needs releasing by the
 * caller: it was handed to a pickup turn, or released here. False when the turn queue is off or nothing could be read,
 * and the caller releases as it always did.
 *
 * A task named ready by the router while this turn held the lock is on the turn record (`pickupPending`); the release
 * is conditional on there being none, so a naming that lands between the read below and the release is found on the
 * second look rather than missed by both sides. Two looks at most.
 */
export async function handOverToPickup(
  args: { channelArn: string; botArn: string; correlationId: string; classification?: string },
  deps: {
    ready?: typeof readyTasksOf; takePending?: typeof takePickupPending; handOver?: typeof handOverLock;
    release?: typeof releaseLockUnlessPickupPending; releaseHeld?: typeof releaseLock; dispatch?: typeof pickupThroughRouter;
  } = {},
): Promise<boolean> {
  if (!turnQueueEnabled() && !deps.ready) return false;
  const responderId = principalIdFromArn(args.botArn);
  const classification = args.classification || process.env.CLASSIFICATION || '';
  if (!responderId || !classification) return false;
  for (let look = 0; look < 2; look++) {
    await (deps.takePending ?? takePickupPending)({ channelArn: args.channelArn, responderId });
    const ready = await (deps.ready ?? readyTasksOf)({ channelArn: args.channelArn, assistantId: responderId });
    const next = ready[0];
    if (next) {
      const to = pickupCorrelationId(next);
      if (!(await (deps.handOver ?? handOverLock)({ channelArn: args.channelArn, responderId, from: args.correlationId, to }))) return false;
      const req = { channelArn: args.channelArn, botArn: args.botArn, taskId: next.taskId, correlationId: to };
      // THE PROCESSOR'S OWN ROUTER, read from the parameter it holds for its own classification.
      const handed = deps.dispatch ? await deps.dispatch(classification, req) : await pickupThroughRouter(classification, req, resolveOwnRouterArn);
      console.log('[turn-handover] nothing queued; the assistant takes up its next ready task', { channelArn: args.channelArn, correlationId: args.correlationId, handed, waiting: ready.length - 1 });
      // A HAND-OFF THAT COULD NOT BE NAMED gives the lock back up, so the conversation is not held by a turn that will not run.
      if (!handed) await (deps.releaseHeld ?? releaseLock)({ channelArn: args.channelArn, responderId, correlationId: to }).catch(() => undefined);
      return true;
    }
    const out = await (deps.release ?? releaseLockUnlessPickupPending)({ channelArn: args.channelArn, responderId, correlationId: args.correlationId });
    if (out !== 'pending') return true;
  }
  return false;
}

/**
 * @returns true when the lock now belongs to a dispatched follow-up triage, meaning the CALLER MUST
 *   NOT RELEASE IT. False means this turn still holds it and must release as it always did - the
 *   queue was empty, someone else is already reading it, or the handover could not be made.
 */
export async function handOverToFollowUpTriage(args: {
  channelArn: string;
  botArn: string;
  correlationId: string;
  /** The answering turn's attribution, for the notice this exit settles. See `settleTurnLockAtExit`. */
  attribution?: Record<string, unknown>;
  /** The assistant's configured wording. Fixed English here reaches a person at the moment they are
   *  told to wait, in whatever language the conversation is being held in. */
  copy?: AssistantCopy;
  /**
   * THE CLASSIFICATION THIS TURN ALREADY RAN AS.
   *
   * Passed rather than looked up. Reading the channel tag from here needs
   * `chime:ListTagsForResource`, which the processor role does not hold and should not be given for
   * this: the turn that is ending already knows what it ran as, so asking Chime is both a grant and
   * a round trip bought for an answer already in hand. Observed live as an AccessDenied that failed
   * the handover closed and stranded the remainder of the queue.
   */
  classification?: string;
  /**
   * HOW MANY HANDOVERS DEEP THIS ALREADY IS, when the turn handing over was itself a triage.
   *
   * Only the COUNT travels. The within-turn wall clock does not: it is six seconds long and exists
   * to stop a reading looping over one queue while somebody waits, so after a full turn it is always
   * spent - carrying it made every handover refuse and strand the queue. Absent means an ordinary
   * answering turn, which starts a fresh chain.
   */
  triage?: { pass: number };
}): Promise<boolean> {
  const { channelArn, botArn, correlationId, triage } = args;
  const responderId = principalIdFromArn(botArn);
  if (!channelArn || !responderId || !correlationId) {
    // The last exit here that said nothing. Every other one logs, so an absent line meant either
    // this or a throw at the call site - two very different faults with one appearance.
    console.warn('[turn-handover] cannot look for a queue without the turn it followed', {
      hasChannel: !!channelArn, hasResponder: !!responderId, hasCorrelation: !!correlationId,
    });
    return false;
  }

  // ── AN AMENDMENT THE FOLD NEVER REACHED GOES BACK ON THE QUEUE (maintainer, 2026-09-01) ─────────────
  //
  // The turn is over, so there is nothing left to fold into: whatever is still recorded here was
  // read, classified as amending, described back to the person, and then reached by nothing. It sat
  // there permanently, because the fold was the only thing that ever cleared the list.
  //
  // RETURNED, NOT PRIORITIZED HERE. This is the moment the assistant gets to the queue, and the
  // reading it triggers below is what decides where this sits among everything else waiting. Placing
  // it now - one message at a time, as each is orphaned - is the re-prioritisation against work
  // already under way that the deferral exists to avoid.
  //
  // BEFORE THE READ, so the ids are in `state.queued`: the branch below releases the conversation on
  // a queue it believes is empty, and a message returned after that read would be stranded a second
  // time by the very thing meant to catch it.
  //
  // ── AND ONLY WHEN THIS TURN IS THE WORK BEING AMENDED (code review, 2026-09-04) ────────────────
  //
  // An amendment is recorded BY a reading turn FOR the answering turn it is reading alongside. This
  // ran on every turn, so the short reading turn - which finishes first, by design - returned the
  // amendment it had just recorded and removed it from the record. The long answering turn then read
  // an empty list and delivered unamended: the feature defeated on its normal path, silently, with a
  // log line saying an amendment had been rescued.
  //
  // `triage` is present exactly when THIS turn is the reading one, so it is the discriminator, and it
  // is already passed for the pass budget.
  //
  // ── BUT "A READING RETURNS NOTHING" WAS TOO STRONG (live evidence, 2026-09-09) ─────────────────
  //
  // It rests on the reading finishing FIRST, which is the usual order and not the only one. When the
  // answering turn finishes first, the amendment is recorded FOR A TURN THAT HAS ALREADY ENDED: the
  // fold that was the only thing clearing the list will never run, the queue is empty so no drain
  // looks, and the lock is released so nothing folds. The message is read, classified as amending,
  // described back to the person - and then reached by nothing, permanently.
  //
  // Seen on a live conversation: the answer landed at 11:49:26 and the reading's proposal at
  // 11:49:32, and the record was left holding two amendment ids with an empty queue and no holder.
  // The proposal had told the person it would answer both "now".
  //
  // `busy` is the honest discriminator, and it is already on the record: it is `!!holder`, and a
  // triage turn never claims the lock, so during a reading it reports whether the ANSWERING turn is
  // still there. Still running ⇒ leave the amendments for it to fold, which is what the 09-04 fix
  // protects. Gone ⇒ nothing will ever fold them, so they go back on the queue and the reading below
  // hands the conversation to a drain that will actually do the work.
  //
  // THE RECORD DECIDES, and it is read consistently: a message queued moments ago by another Lambda
  // is exactly the case this exists for, and an eventually-consistent read is entitled to miss it.
  // Read BEFORE the rescue now, because the rescue's condition depends on it.
  let state;
  try {
    state = await readTurnState({ channelArn, responderId });
  } catch (err) {
    // Unreadable state is not a reason to hold the conversation. Release as normal - but SAY SO.
    // This is the last thing that can stop a queued message waiting forever, and it used to decline
    // without a trace, which is why a stranded message could not be told from one nobody sent.
    console.warn('[turn-handover] could not read the turn state; releasing without checking the queue', {
      channelArn, correlationId, err: (err as Error)?.message,
    });
    return false;
  }

  // ── AND "BUSY" INCLUDED THIS TURN'S OWN HOLD (live evidence, 2026-09-09) ───────────────────────
  //
  // The rule above is right and the reading of `busy` was wrong. `busy` is `!!holder`, and the comment
  // that justified it said a triage turn never claims the lock. That was true of a reading dispatched
  // alongside a running turn, and false of the case this branch was added for: when the answering turn
  // finishes first it HANDS the conversation to the reader (`handOverLock` sets `holder = <reader>`),
  // so by the time that reading runs its own handover it is the holder, `busy` is true because of
  // itself, and the rescue that exists for exactly this ordering declined to run.
  //
  // The record then held the amendment with no queue and no holder - the same shape described above,
  // reached through the guard meant to prevent it. Seen on the turn-queue sweep 2026-09-09: three
  // conversations left holding amendment ids, `queued` absent, `holder` absent, and no rescue line in
  // the log because the function was never called.
  //
  // So the question is asked properly: is somebody ELSE still answering. A stranger's hold means the
  // fold is still coming and the amendments are theirs to use; our own means nothing else will ever
  // fold them.
  const heldByAnotherTurn = state.busy && state.holder !== correlationId;
  const somethingIsStillAnswering = triage && heldByAnotherTurn;
  const returnedAmendments = somethingIsStillAnswering
    ? []
    : await returnAmendmentsToQueue({ channelArn, responderId });
  if (returnedAmendments.length) {
    console.log('[turn-handover] an amendment outlived the work it amended; queued pending prioritisation', {
      channelArn, correlationId, amendments: returnedAmendments.length, readingTurn: !!triage,
    });
    // THE IDS ARE PART OF THE QUEUE NOW, and the branches below decide on `state.queued`. Merging
    // rather than re-reading keeps this to one read and cannot see a stale list: these are the exact
    // ids this call just moved. Without it the release-on-an-outstanding-question branch would look
    // at a queue it believed was empty and strand them a second time, by the very thing meant to
    // catch them.
    const already = new Set(state.queued);
    state = { ...state, queued: [...state.queued, ...returnedAmendments.filter((id) => !already.has(id))] };
  }
  // A QUESTION THIS DRAIN ASKED AND HAS NOT HAD ANSWERED DISPATCHES NOTHING, AND HOLDS NOTHING.
  //
  // This used to keep the lock, on the reasoning that the drain was not over. The drain is not
  // over, but the LOCK is not what carries it (ADR-033, "waiting on a person is not holding the
  // conversation"). Nothing is executing here. The next thing to happen is a person typing, and a
  // lock that excludes everybody while nothing runs is not mutual exclusion, it is a stranding:
  // `awaitingPerson` is removed only by an answer, the record has no expiry, and the takeover
  // clause refused any record carrying it. One reply the parse did not recognize left every OTHER
  // member queued behind a turn that had finished, with only the asked person able to free it.
  //
  // Releasing is safe precisely here, and the branch says why: the queue is EMPTY. There is no
  // unread work a second turn could race for. The question outlives the lock as conversation
  // state, blocks nobody, and is answered, withdrawn or superseded on its own terms.
  // EITHER SHAPE COUNTS AS A QUESTION OUTSTANDING. A current record names everyone the offer
  // concerns (`awaitingPeople`); one written before that names one person. Reading only the single
  // id would have made every multi-person offer look like no question at all, and the branch below
  // would then treat a paused drain as an idle one.
  const awaiting = state.awaitingPeople?.length
    ? state.awaitingPeople
    : (state.awaitingPerson ? [state.awaitingPerson] : []);
  // ── AND THE NOTICE A READING LEFT FOR THIS ANSWER IS SETTLED NOW (owner report, 2026-09-14) ─────
  //
  // A reading that folded follow-ups into this answer leaves the notice unsettled, because "caught
  // up" is not true for the person until the answer containing them is in the conversation. This is
  // that moment. Only for an ANSWERING turn with no reading holding the claim: a reading settles its
  // own notice, and a new queue owns the notice again.
  if (!triage && state.noticeId && !state.triagedBy && !state.queued.length) {
    await settleNoticeAfterAnswer({
      channelArn, botArn, responderId, noticeId: state.noticeId, copy: args.copy,
      ...(args.attribution ? { attribution: args.attribution } : {}),
    });
  } else if (!triage && state.noticeId) {
    // SAID, because its absence was only visible by elimination (live 2026-09-15): a notice left
    // unsettled with no line saying why.
    console.log('[turn-handover] a notice is showing but this exit does not settle it', {
      channelArn, correlationId, readingHoldsClaim: !!state.triagedBy, stillQueued: state.queued.length,
    });
  }
  if (awaiting.length && !state.queued.length) {
    console.log('[turn-handover] a question is outstanding; releasing the conversation to everyone', {
      channelArn, correlationId, awaiting,
    });
    return false;
  }

  if (!state.queued.length) {
    // SAID OUT LOUD, because this silence is what made the remainder untraceable. This is the
    // ordinary exit - almost every turn ends with nothing queued - so it is logged at debug volume
    // by being the only thing said, and it is the difference between "the queue was empty" and
    // "the handover never ran", which cost several rounds of guessing to tell apart.
    console.log('[turn-handover] nothing queued behind this turn; releasing normally', {
      channelArn, correlationId,
    });
    return false;
  }

  // THE LOOP ENDS EVEN THOUGH THE QUEUE HAS NOT. The turn this hands to is itself a triage turn, so
  // its own completion arrives back here - and a person who keeps typing keeps refilling the queue it
  // reads. Holding the conversation for that indefinitely is the stranding tenet 2 forbids, just
  // reached by a route that looks like progress.
  //
  // Bounded by the budget triage ALREADY has rather than a second one invented here: at the end of
  // it the lock is released normally, and the next message the person sends starts a fresh turn that
  // reads what is still queued.
  // THE PASS COUNT BOUNDS THIS, THE WALL CLOCK MUST NOT. The deadline is a WITHIN-TURN budget: it
  // exists so a reading cannot spend a waiting person's seconds looping over the same queue, and it
  // is six seconds long. A handover happens AFTER a whole turn has run, so that clock is always
  // already spent - which made every handover refuse, release the lock, and strand whatever had
  // arrived. Observed live as `budget is spent, pass: 1, stillQueued: 1` and a queue that never
  // drained.
  //
  // And it is the wrong question anyway. A handover is not another pass at the same reading: it is a
  // FIRST reading of different messages, the ones that arrived while the last one ran. What still
  // needs bounding is how many times that may chain, which is what the pass count is for.
  if (triage && triage.pass >= TRIAGE_MAX_PASSES) {
    console.log('[turn-handover] the handover chain is at its limit; releasing rather than looping', {
      channelArn, correlationId, pass: triage.pass, max: TRIAGE_MAX_PASSES,
      stillQueued: state.queued.length,
    });
    return false;
  }

  // ONE READER. An arrival triage already in flight will cover this queue itself, and the two of them
  // reading it together is the duplicate-work case `claimTriage` was added to prevent. Losing the
  // claim is therefore a correct outcome, not a failure: release the lock and let that one finish.
  // A READING TURN ALREADY HOLDS THE CLAIM IT IS ABOUT TO ASK FOR.
  //
  // Arrival triage now names its turn by the claim it took, so when the turn ending here IS that
  // reading, `triagedBy` is its own correlation id. Asking under a derived `handover-` id asks for
  // something it already has, and the conditional refuses it - the reading would then fall into the
  // branch below and hand the conversation to ITSELF, a lock held by a turn that has just ended and
  // that nothing would ever release. Observed as a conversation that stopped answering entirely.
  //
  // So it asks under the id it already holds, which `claimTriage` grants to its own holder, and
  // carries on with the drain it is the rightful reader of.
  if (state.triagedBy === correlationId) {
    // THIS TURN IS THE READING, AND ITS READING IS OVER.
    //
    // Arrival triage names its turn by the claim it holds, so a reading turn ending here finds its
    // OWN id in `triagedBy`. It must not ask for the claim under a derived `handover-` id - that
    // asks for something it already has, is refused, and sends it into the branch below to hand the
    // conversation to ITSELF: a lock held by a turn that has ended, which nothing ever releases.
    //
    // And it must not chain another reading either. Claiming under its own id and carrying on
    // turned one reading into a chain of them, each taking a slice of the queue, so a queue that
    // spanned two subjects was consumed piecemeal and never presented as the one thing a split is
    // offered for - the offer stopped being recorded at all. Measured: three runs, no offer, the
    // chain ending at `pass: 3` with a message still queued.
    //
    // So it releases, which is what it did before the conversation was handed to it, and what the
    // queue needs: the lock is free, the reading is genuinely over, and anything still queued is
    // read by the next arrival rather than by a chain racing itself.
    console.log('[turn-handover] this turn was the reading; releasing now that it is done', {
      channelArn, correlationId, stillQueued: state.queued.length,
    });
    return false;
  }

  // ── THE CLAIM IS THE ID THE TURN WILL RUN UNDER (code review, 2026-09-04) ────────────────────
  //
  // Arrival triage states this rule for itself - "the claim id is the turn's id, so the record
  // NAMES the turn that is reading" - and this path broke it: it claimed as `handover-<parent>` and
  // then dispatched a turn running as `th{n}-<parent>`.
  //
  // Nothing noticed until the queue was not cleared. The fallback below hands the CONVERSATION to
  // `state.triagedBy` on the reasoning that a reading is still processing and must keep it - so it
  // handed the lock to `handover-<parent>`, an id no turn ever ran under and therefore an id nothing
  // will ever release. The conversation was unanswerable to every member until the five-minute
  // staleness takeover, on a path taken precisely when a reading had already gone wrong.
  //
  // Derived here rather than at the dispatch so the two cannot drift: the same value is claimed,
  // recorded, handed to, and dispatched under.
  const claim = handoverCorrelationId(correlationId, (triage?.pass ?? 0) + 1);
  if (!(await claimTriage({ channelArn, responderId, by: claim }))) {
    // A READING IS PROCESSING, SO THE CONVERSATION STAYS HELD (ADR-033, invariant A).
    //
    // This released the lock, on the reasoning that the reader already running would cover the
    // queue. It does not always: it read the queue BEFORE these messages arrived, and when it is
    // finishing at this same moment both sides stand down and nothing comes back. The comment that
    // stood here predicted exactly that and left it, and it was then measured live -
    // `stillQueued: 3`, ending with no holder, one message queued, and nothing that would ever
    // read it.
    //
    // Releasing was wrong for a second and larger reason. The reading turn holds NO lock of its
    // own: `dispatchTriageTurn` never takes one, because until now it always ran behind an
    // answering turn that did, and this file's own doc records that assumption ("while triage runs,
    // the turn it is triaging behind is still running and still holds it"). That sentence stops
    // being true at exactly this line - the turn behind it is THIS one, and it is over. So
    // releasing here does not hand the conversation on, it leaves it unowned WHILE a turn reads it:
    // the person is told nothing is happening, and the next message to arrive starts a second turn
    // racing the reader, which is the duplicated work `claimTriage` exists to prevent.
    //
    // So the lock goes TO the reader. It is the thing doing the work, it is named by the claim it
    // holds, and its own completion arrives back in this same function - as the holder this time,
    // so it either hands on to a follow-up reading or releases with the queue empty.
    // NEVER THIS TURN. Handing the lock to the correlation that is finishing is not a handover, it
    // is a strand: the guard above should make it unreachable, and it is repeated here because the
    // cost of being wrong is a conversation that never answers again.
    const reader = state.triagedBy && state.triagedBy !== correlationId ? state.triagedBy : '';
    const handedToReader = reader
      // ONLY WHILE IT IS STILL READING. A reader that finished between the read above and this
      // write releases nothing - it is not the holder yet - so an unconditional hand-over would
      // install a turn that is over and leave the conversation unanswerable until the takeover.
      ? await handOverLock({
        channelArn, responderId, from: correlationId, to: reader, onlyWhileReading: true,
      })
      : false;
    console.log('[turn-handover] a reading holds the queue; handing it the conversation', {
      channelArn, correlationId, reader: reader || '(unnamed)', handedToReader,
      stillQueued: state.queued.length,
    });
    // AND FALLS BACK TO RELEASING when there is nobody to hand to: a claim that expired between the
    // read and this write, or a reader from a build that predates the claim naming its own turn.
    // Holding a lock on behalf of a turn that cannot be named is the stranding tenet 2 forbids -
    // nothing would ever release it - so this keeps the old behavior for that case, which costs the
    // delay it always cost and is ended by the next message.
    return handedToReader;
  }

  let dispatchedOk = false;
  // FITTED, AND IT NO LONGER STACKS. Interpolated here this re-prefixed the id it was handed, so a
  // handover from an arrival reading ran to ~90 characters and a chain grew by 16 per link - all of
  // them past what a marker reader accepts, so every handover reading paid the mapping poll and a
  // billed scan to find its own placeholder. The pass carries the distinctness instead; the
  // derivation and the measurement are on `handoverCorrelationId`.
  // The same id this turn claimed under, so `triagedBy` and the running turn are one thing.
  const handedTo = claim;
  let handed = false;
  try {
    // The tag read stays as the FALLBACK, for a caller that genuinely does not know.
    //
    // "IT FAILS CLOSED" WAS NOT TRUE, and the guard below was dead (ADR-045 decision 2).
    // `resolveChannelClassificationTag` substituted the floor rather than refusing, so an unreadable
    // tag on a premium channel handed the turn to the BASIC router instead of not handing it over.
    // `readChannelClassificationTag` returns `undefined` and the refusal below is now real.
    const classification = args.classification
      || await readChannelClassificationTag(chime, channelArn, '[turn-handover]');
    if (!classification) return false;

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
        // UNDER THE CLAIM THIS TURN TOOK, as `triage-on-arrival` already clears the identical block
        // (queue review, 2026-09-12). Without it a reading displaced as stale could return here and
        // strip `noticeId` and `drainTaskId` from the reading that displaced it: a duplicate notice
        // and a drain row nothing closes.
        const cleared = await clearQueue({ channelArn, responderId, triagedIds: triaged.emptiedIds, claimedBy: claim })
          .catch((err: unknown) => {
            console.error('[triage] the emptied queue could not be cleared', {
              channelArn, message: (err as Error)?.message,
            });
            return false;
          });
        // A REFUSED CLEAR SETTLES NOTHING. Refused means this reading no longer holds the drain, so
        // the notice and the drain it would settle below are its successor's to end, not this one's.
        if (!cleared) return false;
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
        // AN UNREADABLE RECORD IS NOT AN EMPTY ONE (code review, 2026-09-04).
        //
        // `readTurnState` catches its own failure and returns `{ queued: [], unreadable: true }`, so
        // the `.catch` that stood here was dead code and an unreadable read scored zero - producing
        // exactly the false settle this block exists to prevent: the notice rewritten to "caught up",
        // the drain closed, the client's waiting styling cleared, over messages nobody had read.
        //
        // `unreadable` is the flag that says so, and it is read here rather than inferred.
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
          await settleQueueNotice({ channelArn, botArn, noticeId: state.noticeId, triaged: 0, ...(args.copy ? { copy: args.copy } : {}) })
            .catch(() => { /* the row is empty either way; the client reads that, not this */ });
        }
        // AND THE DRAIN ENDS WITH IT, for the reason given at the same point in `triage-on-arrival`:
        // the queue emptying, the notice settling and the drain closing are one fact said three ways,
        // and a drain left open is the newest task the assistant owns in that channel.
        if (state.drainTaskId) {
          await settleDrainTask({ taskId: state.drainTaskId, channelArn, correlationId: claim });
        }
        }
      }
      return false;
    }

    // THE HANDOVER PRECEDES THE DISPATCH, so the turn being dispatched already owns the conversation
    // by the time it starts. Conditional on still being the holder: a turn displaced as dead must not
    // hand away a lock that has since been given to the turn which displaced it.
    handed = await handOverLock({ channelArn, responderId, from: correlationId, to: handedTo });
    if (!handed) return false;

    const dispatched = await dispatchTriageTurn({
      channelArn,
      botArn,
      classification,
      correlationId: handedTo,
      senderArn: triaged.messages[triaged.messages.length - 1].senderArn || '',
      messages: triaged.messages,
      visibility: triaged.visibility,
      accountedIds: triaged.emptiedIds,
      // A CONTINUATION when the turn handing over was a triage, a first reading when it was not.
      ...(triage ? { pass: triage.pass + 1 } : {}),
      // NO DEADLINE CARRIED. The turn being dispatched reads messages this one never saw, so it gets
      // its own within-turn budget the moment it starts - the same as any first reading.
    });
    // What the claim is held for: a turn is now reading this queue, and it ends the claim when it
    // clears it.
    dispatchedOk = dispatched;

    // THE RESULT IS READ, because `dispatchTriageTurn` SWALLOWS its failures and returns false: an
    // unresolvable router, a throttled invoke. Returning true on that told the caller the lock had a
    // new owner when nothing was running under it, and the conversation then queued behind a holder
    // that would never finish - the exact stranding this file exists to prevent, produced by it.
    if (!dispatched) {
      await releaseLock({ channelArn, responderId, correlationId: handedTo }).catch(() => { /* a later message takes over the stale holder */ });
      return false;
    }
    return true;
  } catch (err) {
    // THE LOCK IS NOT LEFT WITH A TURN THAT NEVER STARTED. If the handover landed and the dispatch
    // then failed, the holder is now a correlation id belonging to nothing, and only a later message
    // taking over the stale holder would free it - the stranding tenet 2 forbids. Release it under the
    // id it was handed to.
    if (handed) {
      await releaseLock({ channelArn, responderId, correlationId: handedTo }).catch(() => { /* a later message takes over the stale holder */ });
    }
    console.warn('[turn-handover] could not hand the turn to a follow-up triage', {
      channelArn, correlationId, message: (err as Error)?.message,
    });
    return handed;
  } finally {
    // HELD ACROSS THE DRAIN when a turn actually started. Releasing here is what let a second
    // dispatcher read the same queue: the turn is still reading, and the queue is not cleared
    // until it finishes. The drain ends the claim itself, in the same write that clears the queue.
    //
    // Released only when NOTHING was started, so a run that returned early or failed does not
    // block the next reading. A dispatch that died after this point is bounded by the claim expiry.
    if (!dispatchedOk) {
      await releaseTriage({ channelArn, responderId, by: claim }).catch(() => { /* it expires */ });
    }
  }
}
