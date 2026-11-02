/**
 * ONE TURN AT A TIME, per responder per conversation (ADR-033).
 *
 * A person sends a message, sees no reply yet, and sends another. Today both start a turn: two
 * assistants answer, sometimes contradicting each other, and nothing reports an error because from
 * each turn's own point of view nothing went wrong. This is the record that lets the second message
 * WAIT instead.
 *
 * ── WHY THE KEY IS (CONVERSATION, RESPONDER) AND NOT THE CONVERSATION ────────────────────────────
 *
 * Busy is a property of a responder. Two people mentioning two different assistants should both get
 * answers; blocking the second because the first is mid-turn would invent a queue nobody asked for.
 * `/battle` is the deliberate exception and does NOT use this module: a duel occupies the whole
 * conversation, which is why its existing guard is channel-scoped and stays that way.
 *
 * ── THE RELEASE IS A RECORDED FACT, NEVER A CLOCK ────────────────────────────────────────────────
 *
 * A lock released by timeout has two failure modes and both are worse than the problem it solves.
 * Too short and it expires under a legitimately slow turn, so the interrupt starts a second turn
 * anyway. Too long and a turn that dies leaves the conversation unanswerable for the length of the
 * timeout - and a stranded lock is worse than a duplicate answer, because a duplicate is recoverable
 * by the person and silence is not.
 *
 * So the holder is released by something that HAPPENED: it finished (`releaseTurn`, in a `finally`,
 * so it covers every early return and every caught error). The only turn that never releases is one
 * killed outright by the platform, and for that there is a takeover below.
 *
 * THE TAKEOVER USED TO READ `readPlaceholderMapping`, AND THAT WAS WRONG. The reasoning was that the
 * mapping "says which message a correlation resolved to", so its presence meant the holder had
 * finished. It does not. `claimPlaceholderMapping` is written by the channel flow the moment the
 * PLACEHOLDER passes through it, seconds into the turn - that is how the processor later finds the
 * placeholder to write the answer over. So the record existed for every RUNNING turn, every later
 * message judged the live holder dead and displaced it, and nothing ever queued: the whole feature
 * was inert in production while its unit tests passed, because they mocked that read to null for the
 * "still running" case and so asserted the assumption rather than the behavior.
 *
 * The repair is NOT to ask how long the holder has held it. That is the clock this section rejects,
 * and asking it here would only move the guess: too short displaces a legitimately slow turn and
 * answers the person twice, too long leaves the conversation unanswerable. The platform already
 * reports the one ending `releaseLock` cannot cover. The processor is invoked ASYNCHRONOUSLY, so an
 * invocation killed on timeout or out of memory emits a failure record carrying the payload that
 * started it - see `turn-lock-release-on-failure.ts`, which releases exactly that lock.
 *
 * So a holder here means BUSY, with no second-guessing: released by the turn ending, or by the
 * platform saying the invocation running it did not.
 *
 * THERE IS NO EXPIRY ON THIS RECORD, and that is deliberate (maintainer, 2026-08-28). A drain now spans
 * the time a person takes to answer a question the assistant asked, so an expiry would delete a queue
 * somebody was told was waiting and leave them with nothing done and no explanation. That is a
 * certainty on any conversation somebody steps away from, which is worse than the stranding it bounded.
 *
 * What replaces it is the ARRIVING MESSAGE. A person who finds an assistant silent sends another one,
 * and that turn checks the state and takes the lock when the holder is past any possible turn. The
 * recovery is an event somebody actually caused, observed by code that is running - not a timer, and
 * not a deletion nothing is left alive to notice.
 *
 * ── FAILS OPEN, IN THE SAME DIRECTION AS EVERY OTHER CLAIM IN THIS CODEBASE ──────────────────────
 *
 * An unreadable or unwritable lock means NOT BUSY. Failing closed would let a table hiccup silence a
 * conversation, which is the stranded-lock failure arriving by a second route. Every catch here
 * returns the permissive answer, and the module is inert until `TURN_STATE_TABLE` is set.
 *
 * ── THE QUEUE HOLDS IDS, NEVER CONTENT ───────────────────────────────────────────────────────────
 *
 * Content is read at drain time, so a person who edits a queued message gets the edited version
 * answered and one who deletes it has it disappear from the batch. It also keeps this record out of
 * the retention story: copying message text here would create a parallel copy of a person's words
 * with its own lifetime and its own erasure path, which is what `drift_events` already refuses to do.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  recordOverflowDrop, recordQueued, recordTakeover, recordAwaitedAnswer,
} from './turn-queue-metrics.js';
import type { PendingStopDecision } from './stop-evaluation.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE = process.env.TURN_STATE_TABLE || '';

/**
 * THE KILL SWITCH. Absent or anything but '1' means every call here is a no-op that reports "not
 * busy", so the turn runs exactly as it does today.
 *
 * This gates a check on the critical path of every turn. A deployment must be able to ship the code,
 * confirm nothing changed, and only then enable it - and to turn it off again from configuration
 * rather than a rollback if it misbehaves.
 */
const ENABLED = process.env.TURN_QUEUE_ENABLED === '1';

/**
 * HOW LONG A HOLDER MAY GO WITHOUT PROGRESS BEFORE AN ARRIVING MESSAGE TAKES THE LOCK.
 *
 * This is NOT a lock timeout and it does not free anything on its own. Nothing expires, no timer
 * runs, and no record is deleted. It is read only when a message ARRIVES and finds the lock held,
 * to answer one question: is the invocation that holds this provably not running any more?
 *
 * It is a platform fact rather than an opinion. A Lambda invocation cannot outlive the timeout
 * configured on its own function, and the longest classification processor here is 90 seconds, with
 * `holderAt` refreshed on every hand-over pass. So a holder untouched for minutes belongs to an
 * invocation the platform has already ended. That is the same reasoning the earlier takeover got
 * wrong: it inferred liveness from a placeholder mapping the flow writes seconds into every HEALTHY
 * turn, so it fired on turns that were running fine.
 *
 * Waiting on a PERSON is not holding: a drain that asks a question releases the lock (ADR-033), so
 * human think-time leaves no holder to go stale. `freeToClaim` therefore checks only `holderAt`, and
 * a holder past this bound is taken over whether or not `awaitingPerson` is set on the record.
 *
 * Default 300000 (five minutes), floored at one minute; set with `TURN_STALE_AFTER_MS`.
 */
const STALE_AFTER_MS = Math.max(60_000, Number(process.env.TURN_STALE_AFTER_MS || '300000') || 300_000);

/** How many messages one conversation may hold. Deployment-tunable; see ADR-033. */
const QUEUE_MAX = Math.max(1, Number(process.env.TURN_QUEUE_MAX || '5') || 5);

// THE PROCESSOR'S OWN RECORD, ON ITS OWN ROLE: bookkeeping about a turn,
// not something the assistant does, so it never goes out on the assistant's session.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER }));

/** True when the mechanism is both configured and switched on. */
export function turnQueueEnabled(): boolean {
  return ENABLED && !!TABLE;
}

/** The lock's key. The responder is a principal id, so one conversation holds one per assistant. */
function lockKey(channelArn: string, responderId: string): string {
  return `turn#${channelArn}#${responderId}`;
}

export interface TurnClaim {
  /** True when this turn owns the conversation and may answer. */
  claimed: boolean;
  /** When claimed is false: the correlation id of the turn that holds it. */
  heldBy?: string;
  /**
   * True when this message is the answer the assistant was waiting on from this person.
   *
   * It was already computed here for the metric and then thrown away, so the one place that knew
   * a question had just been answered told nobody. What a person says when answering a question
   * they were asked is a clarification of THAT, and it must not be read as the continuation of
   * whatever else was open - which is exactly what happened: an answer to a split offer was
   * absorbed into an active task and the person was answered about a different subject.
   */
  answeredTheQuestion?: boolean;
}

/**
 * Claim the right to answer, or report who holds it.
 *
 * THE COMMON PATH IS ONE CONDITIONAL WRITE. Only a contended turn pays for the reads below, and
 * contention is the rare case by construction - it is the very thing this exists to handle.
 */
export async function claimTurn(args: {
  channelArn: string;
  responderId: string;
  correlationId: string;
  /**
   * Who is sending this turn, as a principal id, when the caller knows.
   *
   * Read for ONE case: the drain is waiting on an answer from this person. Their next message must
   * run rather than queue, whatever it says - it either answers the question, or it is new input the
   * reading has to fold in and ask again about. Queueing it would park the conversation behind a
   * question only they can end, which is a hang rather than a wait.
   */
  senderId?: string;
}): Promise<TurnClaim> {
  if (!turnQueueEnabled()) return { claimed: true };
  const { channelArn, responderId, correlationId, senderId } = args;
  if (!channelArn || !responderId || !correlationId) return { claimed: true };
  const pk = lockKey(channelArn, responderId);

  // The ways this lock is available, and the values that decide each. Assembled together so a branch
  // can never be added without the placeholder it reads.
  const freeToClaim = [
    'attribute_not_exists(holder)',
    'holder = :me',
    // The holder is past any possible turn - see STALE_AFTER_MS.
    //
    // This used to also require `attribute_not_exists(awaitingPerson)`, to protect a drain that was
    // "progressing, however long it waits". Waiting is no longer held here at all (ADR-033), so the
    // guard protects nothing and refuses the one record that most needs freeing: a conversation left
    // holding an outstanding question by a turn that has ended.
    'holderAt < :stale',
  ];
  // Held in a name, because the RESULT of the claim is read against it below: which clause let a
  // claim through decides whether what happened was a fault or the drain closing normally.
  const staleBefore = Date.now() - STALE_AFTER_MS;
  const claimValues: Record<string, unknown> = {
    ':me': correlationId, ':now': Date.now(), ':stale': staleBefore,
  };

  if (senderId) {
    // THE PERSON WHO WAS ASKED. Their message ends the wait one way or the other, so it runs.
    //
    // ONLY WHILE NOTHING IS EXECUTING (code review, 2026-09-04). This clause used to stand alone, so
    // it granted the claim even against a LIVE holder - and a person carrying a stale
    // `awaitingPerson` displaced running turns indefinitely, two answers at a time, counted as
    // answering the question rather than as a takeover so invisible in the metrics.
    //
    // The pairing is what it was always for. A drain that asks a question RELEASES the conversation
    // (ADR-033: waiting on a person is not holding it), so in the flow this serves there is no
    // holder, and requiring none costs that flow nothing. What it removes is the case the clause was
    // never meant to cover: a turn genuinely running while somebody who was asked something earlier
    // types. Their message queues, which is what every other message does while a turn runs, and a
    // holder that is actually dead is still taken over by the staleness clause above.
    // BOTH SHAPES, because a question is outstanding on EVERYONE the offer concerns and a record
    // written before that was true names one person. The offer's own `offeredTo` map is the current
    // shape; `awaitingPerson` is the single id a live record may still carry, read here as one more
    // link in the same chain this design already uses for older shapes rather than as a migration.
    //
    // A NESTED DOCUMENT PATH asks the question directly of the offer: is this person among those it
    // was put to. Nothing has to be kept in step with it, because it is the offer.
    freeToClaim.push('(attribute_exists(pendingSplit.offeredTo.#sender) AND attribute_not_exists(holder))');
    freeToClaim.push('(awaitingPerson = :sender AND attribute_not_exists(holder))');
    claimValues[':sender'] = senderId;
  }

  try {
    const taken = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk },
      // ── `awaitingPerson` IS CONSUMED BY THE PERSON SPEAKING (code review, 2026-09-04) ────────
      //
      // It is a lock BYPASS: it exists so the one person a question is outstanding on can speak past
      // a held conversation. Nothing removed it on this path, and the split branch only removes it
      // when the reply PARSED - so a reply that answered no offer left it standing for ever.
      //
      // What that costs is not a stale question. `answeredTheQuestion` below is computed from it, and
      // the router reads that as "this message is an answer, not the continuation of open work"
      // (`hasActiveTask = !!activeTask && !turnClaim.answeredTheQuestion`). So every later message
      // from that person disabled their own active-task continuity, permanently, and inflated the
      // `AwaitedAnswer` metric on every turn.
      //
      // Removed HERE because this is the moment it is spent: they have spoken. The offer itself
      // (`pendingSplit`) deliberately survives - it is read per speaker and can still be answered -
      // and what goes is only the right to walk past a lock a second time.
      //
      // ONE PERSON'S BYPASS IS SPENT SEPARATELY, and this statement must not try (2026-09-05).
      //
      // It did, and the assumption was wrong in the expensive direction: `REMOVE
      // pendingSplit.offeredTo.#sender` is NOT a no-op when `pendingSplit` is absent. DynamoDB
      // validates the whole document path and refuses the entire update - "The document path
      // provided in the update expression is invalid" - so on every ordinary turn, which is nearly
      // all of them, the claim failed. It fails OPEN by design, so nothing broke loudly: the turn
      // ran, no lock was taken, and the queue was inert for the whole deployment. Measured in the
      // router log as `[turn-lock] claim failed (fail-open)` on a conversation with no offer.
      //
      // The nested remove now happens in its own write, after the claim, and only when the record
      // that came back shows this person WAS awaited - which is the one condition under which
      // `pendingSplit` is known to exist. See `spendOfferBypass` below.
      UpdateExpression: 'SET holder = :me, holderAt = :now REMOVE holderMessageId, awaitingPerson',
      // Free when nothing holds it, or when THIS turn already does - a redelivery of the same
      // message must not be told it is queued behind itself.
      //
      // AND WHEN THE HOLDER IS PROVABLY GONE, which is what stops a conversation being unanswerable.
      // A person who finds an assistant silent sends another message; that message used to be appended
      // to a queue behind a lock nobody was going to release, and nothing else was ever going to look.
      // Now the arriving turn checks the state and gets it moving, which is the recovery - not a timer,
      // and not the record expiring.
      //
      // A drain waiting for somebody to answer a question it asked holds nothing (it released the
      // lock when it asked), so a person taking their time is never mistaken for a dead holder.
      // BUILT WITH ITS VALUES, never apart from them. A declared placeholder no expression uses is
      // rejected outright by DynamoDB, and this file has already lost a feature to that three times.
      ConditionExpression: freeToClaim.join(' OR '),
      ExpressionAttributeValues: claimValues,
      // ONLY WHEN AN EXPRESSION USES IT. DynamoDB rejects an unused ExpressionAttributeNames entry
      // outright, and the CONDITION above mentions `#sender` only when there is a sender.
      //
      // A NAME, not the literal id: a principal id is somebody else's string, and a document path
      // segment written raw is a parse waiting to happen the first time one carries a character the
      // expression grammar means something by.
      ...(senderId ? { ExpressionAttributeNames: { '#sender': senderId } } : {}),
      // The PRIOR holder, so a takeover can be told from an ordinary claim. Without it the two are
      // indistinguishable and the one event worth counting here would go uncounted.
      ReturnValues: 'ALL_OLD',
    }));
    const previous = (taken.Attributes?.holder as string | undefined) ?? '';
    const displaced = !!previous && previous !== correlationId;

    // WHICH CLAUSE LET THIS THROUGH, because two of them displace a holder and only one is a fault.
    //
    // "The holder changed" was the whole test, so a person answering the question the drain asked -
    // the ordinary close of the split-offer loop - was counted as a lock TAKEOVER and logged as a
    // holder "past any possible turn". That is the metric ADR-033 calls the judge of this design and
    // the one the stranded-lock alarm watches, so it rose whenever the feature WORKED, and an
    // operator reading it would have concluded the queue was stranding conversations constantly.
    //
    // The old item says which it was, and it is already in hand: the claim asks for ALL_OLD.
    // WHO WAS WAITED ON, in either shape. The offer's own `offeredTo` is what a current record
    // carries; the single id is what one written before the question became everybody's still has.
    const priorAwaiting = taken.Attributes?.awaitingPerson as string | undefined;
    const priorOffer = taken.Attributes?.pendingSplit as PendingSplitOffer | undefined;
    const wasAwaited = (id: string): boolean =>
      priorAwaiting === id || !!priorOffer?.offeredTo?.[id];
    const priorHolderAt = Number(taken.Attributes?.holderAt ?? 0);
    // NOT CONDITIONAL ON DISPLACING ANYBODY, and that is a consequence of the release above. While
    // waiting held the lock there was always a holder to displace, so `displaced` came free. Now the
    // ordinary case is an OPEN conversation with a question outstanding: nothing is held, nothing is
    // displaced, and requiring it would silently stop reporting the answer on the one path that is
    // now normal - taking the routing in `router-agent-handler` (an answer is not the continuation
    // of an open task) down with it.
    const answeredTheQuestion = !!senderId && wasAwaited(senderId);

    // ── SPEND THIS PERSON'S BYPASS, NOW THAT THE OFFER IS KNOWN TO EXIST ────────────────────────
    //
    // Separate from the claim because a nested REMOVE cannot be attempted speculatively: DynamoDB
    // validates the document path and refuses the WHOLE update when `pendingSplit` is absent, which
    // is every ordinary turn. Here we are past the claim and holding its ALL_OLD, so `wasAwaited`
    // is proof the offer was there - the one condition under which the path is valid.
    //
    // BEST EFFORT, and that is the right trade. A failed removal costs one extra walk past the lock;
    // a failed CLAIM costs the lock itself, which is what the speculative version was doing.
    if (answeredTheQuestion && priorOffer?.offeredTo?.[senderId]) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk },
        // ONE KEY, so the rest of the people the offer was put to keep theirs. Conditional on the
        // path still being there, so two people answering at once cannot fail each other's write.
        UpdateExpression: 'REMOVE pendingSplit.offeredTo.#sender',
        ConditionExpression: 'attribute_exists(pendingSplit.offeredTo.#sender)',
        ExpressionAttributeNames: { '#sender': senderId },
      })).catch(() => { /* the bypass stands one more turn; the offer is unaffected. */ });
    }

    if (answeredTheQuestion) {
      // Healthy. Counted on its own so the two are separable rather than conflated.
      recordAwaitedAnswer(process.env.CLASSIFICATION || '');
    } else if (displaced && priorHolderAt > 0 && priorHolderAt < staleBefore) {
      // COUNTED as `LockTakeover`, because this is the health signal for the whole design and the
      // metric the stranded-lock alarm watches. It is emitted by code that is running, at the moment
      // the recovery happens, naming the turn that was abandoned.
      console.warn('[turn-lock] took over a lock whose holder is past any possible turn', {
        channelArn, responderId, previousHolder: previous, staleAfterMs: STALE_AFTER_MS,
      });
      recordTakeover(process.env.CLASSIFICATION || '');
    }
    return { claimed: true, answeredTheQuestion };
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] claim failed (fail-open):', err?.message);
      return { claimed: true };
    }
  }

  // Held by someone else, so this turn waits. WHO the holder is, is read only to report it: nothing
  // here judges whether that holder is still alive, because nothing here can. A turn that ended
  // released the lock, and a turn the platform killed is reported by the failure destination that
  // releases it. Guessing between those two from this side is what broke the queue before.
  let holder: string | undefined;
  try {
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk } }));
    holder = res.Item?.holder as string | undefined;
  } catch (err: any) {
    console.warn('[turn-lock] holder read failed (fail-open):', err?.message);
    return { claimed: true };
  }
  if (!holder) return { claimed: true };
  return { claimed: false, heldBy: holder };
}

/**
 * ── THE LOCK AND THE QUEUE ARE RELEASED SEPARATELY, AND THE ORDER MATTERS ────────────────────────
 *
 * An earlier version of this module did both in one conditional write, arguing they were one fact:
 * the turn is over and these messages are no longer waiting. They are not one fact, and the bug is
 * concrete. Freeing the lock at the moment a turn returns opens the conversation to a message that
 * starts running ALONGSIDE the follow-up work being dispatched from the queue - the exact concurrency
 * the lock exists to prevent, arriving through the mechanism meant to prevent it.
 *
 * So a finishing turn goes: PEEK the queue, triage it while STILL HOLDING the lock, clear the queue,
 * and only then release. There is no instant at which the conversation is free and its own follow-up
 * work is still in flight.
 *
 * Peeking before clearing is what makes triage recoverable. Taking the queue first and crashing before
 * the tasks exist would lose the messages outright; leaving them queued means the next turn's takeover
 * finds them and tries again.
 */

/** What is waiting, without taking it. A read: triage must be able to fail and be retried. */
export async function peekQueue(args: {
  channelArn: string;
  responderId: string;
}): Promise<string[]> {
  if (!turnQueueEnabled()) return [];
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
    }));
    return (res.Item?.queued as string[] | undefined) ?? [];
  } catch (err: any) {
    console.warn('[turn-lock] queue peek failed:', err?.message);
    return [];
  }
}

/**
 * Clear the queue, AFTER its messages have become tasks.
 *
 * ── WHAT IT IS CONDITIONAL ON, STATED CORRECTLY (code review, 2026-09-11) ───────────────────────
 *
 * This said "conditional on still holding the lock", and that was never what it checked - nor what
 * it COULD check. A reading runs BESIDE the answer and deliberately does not claim the turn, so a
 * lock condition here would fail on every drain there has ever been.
 *
 * Two conditions, because they protect two different things:
 *  - `queued = :current` is a compare-and-swap on the queue contents, so a message that arrived
 *    since this reading read fails the write and stays queued for the next one.
 *  - `triagedBy = :claimant` is the DRAIN claim, and it is the one that was missing. Without it a
 *    reading displaced as stale could return and remove `noticeId` and `drainTaskId` out from under
 *    the reading that displaced it: the notice pointer is lost, so the next notice posts fresh
 *    instead of updating in place, and the drain row is left pending with nothing to close it.
 *
 * Also clears the notice pointer, because the notice it referred to has been settled by the same
 * triage.
 */
export async function clearQueue(args: {
  channelArn: string;
  responderId: string;
  /**
   * WHO IS DRAINING, as claimed through `claimTriage`. Optional so a caller that has not been
   * taught to pass it behaves exactly as before rather than silently failing to clear. Every caller
   * passes it: both dispatcher-side clears (`triage-on-arrival`, `turn-handover`) and the processor's
   * clear at the end of a reading, whose correlation id is the claim it was dispatched under. When it
   * is passed and the record names another reader, the clear returns false without writing: displaced.
   */
  claimedBy?: string;
  /**
   * The ids this reading actually accounted for.
   *
   * REMOVED INDIVIDUALLY, not by clearing the list. Two things make the queue and the reading
   * differ, and both are ordinary: a message that could not be read is skipped, and one whose
   * content is empty after markers are stripped is skipped as accounted-for. So the reading is a
   * SUBSET of the queue, and a clear conditional on the whole list matching would never fire -
   * the queue would never empty and every later notice would re-triage the same messages into
   * duplicate tasks.
   *
   * Removing by id also keeps a message that arrived DURING the reading: it is not in this set, so
   * it survives into the remainder and the next notice triages it, which is what the old
   * whole-list condition was protecting.
   */
  triagedIds: string[];
  /**
   * Leave the notice pointer when the queue empties, because the notice is settled later by the answer
   * the follow-ups were folded into (`settleNoticeAfterAnswer`), not by this reading.
   */
  keepNotice?: boolean;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return true;
  const { channelArn, responderId, triagedIds } = args;
  if (!channelArn || !responderId || !triagedIds?.length) return true;
  const pk = lockKey(channelArn, responderId);

  // THREE ATTEMPTS, FOR THE SAME REASON `returnAmendmentsToQueue` TAKES THEM (code review, 2026-09-09).
  //
  // The compare-and-swap below was written without one, and a single refusal removed NOTHING - not
  // even the ids this reading had just turned into tasks. The catch declined to warn on a
  // conditional failure, and the only caller logs and moves on, so the next drain re-triaged an
  // already-triaged queue: duplicate tasks, and the person told a second time what was understood.
  // That is the failure this file's own header records as already measured once.
  //
  // A refusal here is not an error, it is the queue having moved - which is ordinary, and the whole
  // reason the read is consistent and the write conditional. The answer to it is to re-read and
  // recompute, not to give up.
  for (let attempt = 0; attempt < 3; attempt++) {
  try {
    // COMPARE AND SWAP. The remainder is computed from what the record says NOW, and written back
    // conditional on it not having moved, so a message enqueued between the read and the write
    // cannot be dropped by this call.
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk }, ConsistentRead: true }));
    const current = (res.Item?.queued as string[] | undefined) ?? [];
    // DISPLACED IS AN ANSWER, NOT A RACE TO RETRY. When the claim this reading held now names
    // another reader, every write below is refused on `triagedBy = :claimant` however many times
    // it is re-read, and the three attempts ended in the "gave up" error for what is the designed
    // outcome: the queue, its notice and its drain belong to the reading that displaced this one.
    if (args.claimedBy && res.Item?.triagedBy !== args.claimedBy) {
      console.log('[turn-lock] this reading no longer holds the drain claim; leaving the queue to its holder', {
        channelArn, responderId, claimedBy: args.claimedBy, heldBy: res.Item?.triagedBy ?? null,
      });
      return false;
    }
    // ── AN EMPTY QUEUE STILL ENDS THE DRAIN (live 2026-09-15) ───────────────────────────────────
    //
    // This returned success here without writing anything. The queue can already be empty when the
    // reading clears it: a resumed answer folds the follow-ups and takes them off the queue first. The
    // claim (`triagedBy`), the stage and the drain id then stayed on the record, the answering turn's
    // exit saw a reading still holding the claim and skipped settling the notice, and the notice read
    // "clearing the queue" for good. So the terminal clear still runs, conditioned on the queue being
    // absent rather than equal to a list.
    if (!current.length) {
      // NOTHING TO END is still read-only: a write here on an empty record would create a row
      // describing nothing.
      const item = res.Item ?? {};
      if (!item.triagedBy && !item.queueStatus && !item.drainTaskId && (args.keepNotice || !item.noticeId)) return true;
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk },
        UpdateExpression: args.keepNotice
          ? 'REMOVE triagedBy, triageAt, queueStatus, drainTaskId'
          : 'REMOVE noticeId, triagedBy, triageAt, queueStatus, drainTaskId',
        ConditionExpression: args.claimedBy
          ? '(attribute_not_exists(queued) OR size(queued) = :zero) AND triagedBy = :claimant'
          : '(attribute_not_exists(queued) OR size(queued) = :zero)',
        ExpressionAttributeValues: {
          ':zero': 0,
          ...(args.claimedBy ? { ':claimant': args.claimedBy } : {}),
        },
      }));
      return true;
    }

    const triaged = new Set(triagedIds);
    const remainder = current.filter((id) => !triaged.has(id));

    // NOTHING LEFT ⇒ the queue and its notice both go. The notice is the room's record that
    // something was waiting, and nothing is.
    if (!remainder.length) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk },
        // AND THE TRIAGE CLAIM ENDS HERE, in the same statement as the clear.
        //
        // The claim's lifetime is the DRAIN, not the dispatch - the same correction the turn lock
        // needed. Both dispatchers released it the moment `dispatchTriageTurn` returned, while the
        // turn it started was still reading, and the queue is not cleared until that turn finishes.
        // So anything firing in between saw a full queue and a free claim and read the same messages
        // again. Observed live: one queue drained twice 33ms apart, five tasks for three messages,
        // and the person told twice what was understood.
        //
        // Ending it HERE needs no claim id and cannot disagree with the clear, because it IS the
        // clear. A dispatch that dies before reaching this is bounded by the claim's own short
        // expiry, which is what that expiry is for.
        // AND THE STAGE, because an absent `queueStatus` is what the machine reads as its START.
        // Nothing else ever removed it, and with the record's expiry gone it persisted as
        // 'clearing' for the life of the conversation - so the NEXT drain's first advance
        // (`reviewing`, legal only from waiting-or-absent) failed its condition, and every stage
        // after it failed its own. The progress a person watches worked exactly once per
        // conversation and was silently inert forever after.
        // AND THE DRAIN TASK'S IDENTITY, because the drain is over when the queue is.
        //
        // THIS BRANCH AND NOT THE OTHER ONE, and that asymmetry is the owner's rule (2026-09-03):
        // one drain per QUEUE, not per pass. A pass ends at either branch - the claim and the stage
        // reset at both, because the next pass is a new reading. The DRAIN spans them: a remainder is
        // the same queue still being worked, so its task carries across, and only an empty queue
        // means the work the task was opened for is done.
        UpdateExpression: args.keepNotice
          ? 'REMOVE queued, triagedBy, triageAt, queueStatus, drainTaskId'
          : 'REMOVE queued, noticeId, triagedBy, triageAt, queueStatus, drainTaskId',
        ConditionExpression: args.claimedBy
          ? 'queued = :current AND triagedBy = :claimant'
          : 'queued = :current',
        ExpressionAttributeValues: {
          ':current': current,
          ...(args.claimedBy ? { ':claimant': args.claimedBy } : {}),
        },
      }));
      return true;
    }

    // SOMETHING STILL WAITS, so the notice stays: it is still true, and the next reading updates
    // its depth rather than posting a second one.
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk },
      // The claim ends here too. A remainder is a queue somebody still has to read, so holding the
      // claim past this point would block the very next reading it needs.
      // The stage resets here too: a remainder is a queue somebody still has to read, and that
      // reading needs to start at the beginning of the machine like any other.
      UpdateExpression: 'SET queued = :remainder REMOVE triagedBy, triageAt, queueStatus',
      ConditionExpression: args.claimedBy
        ? 'queued = :current AND triagedBy = :claimant'
        : 'queued = :current',
      ExpressionAttributeValues: {
        ':remainder': remainder,
        ':current': current,
        ...(args.claimedBy ? { ':claimant': args.claimedBy } : {}),
      },
    }));
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      // The queue moved between the read and the write. Go round again with what it says now.
      continue;
    }
    console.warn('[turn-lock] queue clear failed:', err?.message);
    return false;
  }
  }
  // THREE LOSSES IN A ROW leaves the triaged ids still queued, and the next reading will read them
  // again. Said loudly, because the visible outcome is duplicate work and a person told twice what
  // was understood, and nothing downstream of the single caller would otherwise report it.
  console.error('[turn-lock] gave up clearing the queue; it moved three times', {
    channelArn, responderId, triaged: triagedIds.length,
  });
  return false;
}

/**
 * Forget the notice pointer once the notice is settled, only while nothing is queued again.
 *
 * Conditional on the pointer still naming that notice and the queue being empty: a message queued in
 * the meantime owns the notice again, and the next reading settles it.
 */
export async function forgetSettledNotice(args: {
  channelArn: string;
  responderId: string;
  noticeId: string;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      UpdateExpression: 'REMOVE noticeId',
      ConditionExpression: 'noticeId = :n AND (attribute_not_exists(queued) OR size(queued) = :zero)',
      ExpressionAttributeValues: { ':n': args.noticeId, ':zero': 0 },
    }));
    return true;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] could not forget the settled notice:', err?.message);
    }
    return false;
  }
}

/**
 * Forget the notice pointer once the notice holds the ANSWER.
 *
 * When posting the answer at the end fails, the answer is written into the placeholder that had become
 * the notice. That message is then the answer, and nothing may write notice text over it: the next
 * queued message posts a fresh notice instead of updating this one. Unlike `forgetSettledNotice`, the
 * queue may still hold messages; they are waiting, and the fresh notice is theirs.
 *
 * Conditional only on the pointer still naming that message, so a pointer some other write already
 * moved on is left alone.
 */
export async function forgetNoticeHoldingAnswer(args: {
  channelArn: string;
  responderId: string;
  noticeId: string;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return false;
  if (!args.channelArn || !args.responderId || !args.noticeId) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      UpdateExpression: 'REMOVE noticeId',
      ConditionExpression: 'noticeId = :n',
      ExpressionAttributeValues: { ':n': args.noticeId },
    }));
    return true;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] could not forget the notice that holds the answer:', err?.message);
    }
    return false;
  }
}

/**
 * Pass the lock from a finishing turn to the turn that continues its work, in ONE write.
 *
 * WHY NOT RELEASE AND LET THE NEXT TURN CLAIM. Because between those two writes the conversation is
 * free, and a message arriving in that gap claims it and runs alongside the follow-up the finishing
 * turn just dispatched. That is the concurrency this whole module exists to prevent, and it would
 * arrive through the mechanism meant to prevent it. A handover has no such instant: the record moves
 * from one holder to the next without ever being unheld.
 *
 * CONDITIONAL ON THE OUTGOING HOLDER, so a turn that was itself displaced as dead cannot hand away a
 * lock it no longer owns.
 *
 * FAILS OPEN INTO A RELEASE, not into a hold. If the swap cannot be written, the caller is told and
 * the lock is left as it was rather than being cleared behind their back - the takeover path recovers
 * it either way, and a lock briefly held by a turn that has ended is a shorter problem than a
 * conversation that answers twice.
 */
export async function handOverLock(args: {
  channelArn: string;
  responderId: string;
  from: string;
  to: string;
  /**
   * Hand over ONLY while `to` still holds the reading claim. Set when handing a conversation to a
   * reader, whose completion is what clears that claim; unset for a handover between turns, where the
   * destination is being created rather than checked.
   */
  onlyWhileReading?: boolean;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return true;
  const { channelArn, responderId, from, to, onlyWhileReading } = args;
  if (!channelArn || !responderId || !from || !to) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'SET holder = :to, holderAt = :now',
      // ── AND, WHEN ASKED, THAT THE READER IS STILL READING (code review, 2026-09-04) ────────────
      //
      // Conditional on the holder alone, this could install a correlation that had already finished.
      // The caller reads the record, decides to hand the conversation to the reader named in it, and
      // writes - and a reader finishing in that window releases nothing, because it is not the holder
      // yet. The lock then names a turn that is over, the record has no expiry, and the conversation
      // is unanswerable to every member until the five-minute staleness takeover.
      //
      // `triagedBy` is cleared when a reading ends, so requiring it to still name that reader is the
      // compare-and-swap that closes the window. A refusal is not a failure: the caller falls back to
      // releasing, which is the correct outcome when the reader has in fact finished.
      ConditionExpression: onlyWhileReading
        ? 'holder = :from AND triagedBy = :to'
        : 'holder = :from',
      ExpressionAttributeValues: {
        ':to': to, ':from': from, ':now': Date.now(),
      },
    }));
    return true;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] handover failed:', err?.message);
    }
    return false;
  }
}

/**
 * Release the lock. THE LAST THING a finishing turn does.
 *
 * Conditional on still being the holder, so a displaced turn cannot free the lock its replacement is
 * holding. Leaves any queue in place deliberately: a queue that survives a release is one the next
 * turn will triage, which is better than one this turn discarded on its way out.
 */
export async function releaseLock(args: {
  channelArn: string;
  responderId: string;
  correlationId: string;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return true;
  const { channelArn, responderId, correlationId } = args;
  if (!channelArn || !responderId || !correlationId) return true;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'REMOVE holder, holderAt',
      ConditionExpression: 'holder = :me',
      ExpressionAttributeValues: { ':me': correlationId },
    }));
    return true;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] release failed:', err?.message);
    }
    return false;
  }
}

// ── WORK NAMED READY WHILE A TURN HOLDS THE CONVERSATION (ADR-063 decision 5) ─────────────────────────────

/**
 * RECORD A TASK NAMED READY WHILE ANOTHER TURN HOLDS THE CONVERSATION, so the holder takes it up at its exit. The router
 * writes it when `claimTurn` finds the lock held; the holder's release is conditional on there being none
 * (`releaseLockUnlessPickupPending`), so a naming that lands between the holder's read of its ready work and its
 * release is never missed by both sides. A set, so a redelivered naming adds nothing.
 */
export async function notePickupPending(args: { channelArn: string; responderId: string; taskId: string }): Promise<boolean> {
  if (!turnQueueEnabled()) return false;
  const { channelArn, responderId, taskId } = args;
  if (!channelArn || !responderId || !taskId) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'ADD pickupPending :t',
      ExpressionAttributeValues: { ':t': new Set([taskId]) },
    }));
    return true;
  } catch (err: any) {
    console.warn('[turn-lock] could not record a task named ready:', err?.message);
    return false;
  }
}

/** TAKE THE TASKS NAMED READY SINCE THE LAST TAKE, clearing them in the same write. Empty when there are none. */
export async function takePickupPending(args: { channelArn: string; responderId: string }): Promise<string[]> {
  if (!turnQueueEnabled()) return [];
  const { channelArn, responderId } = args;
  if (!channelArn || !responderId) return [];
  try {
    const out = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'REMOVE pickupPending',
      ReturnValues: 'UPDATED_OLD',
    }));
    const pending = (out.Attributes as { pickupPending?: Set<string> | string[] } | undefined)?.pickupPending;
    return pending ? [...pending] : [];
  } catch (err: any) {
    console.warn('[turn-lock] could not take the tasks named ready:', err?.message);
    return [];
  }
}

/**
 * RELEASE THE LOCK ONLY WHILE NO TASK HAS BEEN NAMED READY (ADR-063 decision 5). False when one was named since the
 * holder looked, or the holder is no longer this turn: the caller then takes the named work up instead, so the
 * conversation is never left with ready work and nobody holding it.
 */
export async function releaseLockUnlessPickupPending(args: { channelArn: string; responderId: string; correlationId: string }): Promise<'released' | 'pending' | 'not-holder'> {
  if (!turnQueueEnabled()) return 'released';
  const { channelArn, responderId, correlationId } = args;
  if (!channelArn || !responderId || !correlationId) return 'released';
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'REMOVE holder, holderAt',
      ConditionExpression: 'holder = :me AND attribute_not_exists(pickupPending)',
      ExpressionAttributeValues: { ':me': correlationId },
    }));
    return 'released';
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] release failed:', err?.message);
      return 'released';
    }
    const now = await readTurnState({ channelArn, responderId }).catch(() => null);
    return now && now.holder === correlationId ? 'pending' : 'not-holder';
  }
}

export interface EnqueueResult {
  /** Queue depth after this message, or the depth at which it was refused. */
  depth: number;
  /** True when the bound was hit and the OLDEST queued message was dropped to make room. */
  overflowed: boolean;
  /** The notice message this conversation is already showing, if one was recorded. */
  noticeId?: string;
  /**
   * The write did not happen. The message is NOT queued and nothing will read it, so a caller that
   * has already told somebody it is waiting has to correct that rather than fall silent.
   */
  failed?: boolean;
}

/** A queued message's id and the intent it was classified as when it queued (ADR-064 decision B). */
export interface QueuedIntent {
  messageId: string;
  intent: string;
}

/** How many queued intents the record keeps: four queues' worth, so a message is never read after its intent is gone. */
const QUEUED_INTENTS_KEPT = QUEUE_MAX * 4;

/** The recorded intents as a map by message id, the latest entry winning for an id queued twice. */
export function queuedIntentsById(entries: unknown): Record<string, string> {
  const byId: Record<string, string> = {};
  if (!Array.isArray(entries)) return byId;
  for (const e of entries) {
    const entry = e as Partial<QueuedIntent> | null;
    if (entry && typeof entry.messageId === 'string' && entry.messageId && typeof entry.intent === 'string' && entry.intent) {
      byId[entry.messageId] = entry.intent;
    }
  }
  return byId;
}

/**
 * Add a message to the queue behind the running turn.
 *
 * THE OLDEST IS DROPPED ON OVERFLOW, not the newest: the newest is the person's latest intent and the
 * one most likely to supersede the rest. The drop is returned so the caller can TELL them, per the
 * rule that a deferral is a reply rather than silence.
 */
export async function enqueueMessage(args: {
  channelArn: string;
  responderId: string;
  messageId: string;
  /**
   * THE INTENT THE MESSAGE WAS CLASSIFIED AS before it queued (ADR-064 decision B). Recorded beside the id
   * (`queuedIntents`), never in place of it, so the task a reading opens for the message and the answer it is folded
   * into are attributed to what it asked for. Absent records nothing.
   */
  intent?: string;
}): Promise<EnqueueResult> {
  if (!turnQueueEnabled()) return { depth: 0, overflowed: false };
  const { channelArn, responderId, messageId } = args;
  const intent = typeof args.intent === 'string' && args.intent ? args.intent : undefined;
  if (!channelArn || !responderId || !messageId) return { depth: 0, overflowed: false };
  const pk = lockKey(channelArn, responderId);

  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk },
      // list_append onto a possibly-absent attribute, via if_not_exists - the first queued message
      // creates the list rather than needing a separate write to initialize it.
      // NOTHING HERE TOUCHES `holderAt`, AND THAT IS THE POINT.
      //
      // The record has no expiry. A stranded lock is detected by the claim path: an arriving message
      // takes over a holder whose `holderAt` is older than `STALE_AFTER_MS` and counts it as
      // `LockTakeover`. Queueing behind a turn does not make that turn younger, so the traffic being
      // blocked must not refresh the holder's progress stamp.
      // THE INTENT RIDES IN THE SAME WRITE, as its own list, so the queue itself stays a list of ids every reader
      // already understands.
      UpdateExpression: 'SET queued = list_append(if_not_exists(queued, :empty), :one)'
        + (intent ? ', queuedIntents = list_append(if_not_exists(queuedIntents, :empty), :intent)' : ''),
      // NO `#ttl` NAME AND NO `:ttl` VALUE, because the expression above references neither.
      //
      // They were left behind when the TTL refresh was removed (the record has no expiry). DynamoDB
      // REJECTS an ExpressionAttributeNames entry that no expression uses - "Value provided in
      // ExpressionAttributeNames unused in expressions: keys: {#ttl}" - so every enqueue threw, and
      // the catch below reports the message as answered rather than queued. The queue degraded to
      // exactly the doubling it exists to prevent, on every deployment, while its unit tests passed:
      // they mock `send`, and a mock does not enforce what DynamoDB validates.
      ExpressionAttributeValues: { ':empty': [], ':one': [messageId], ...(intent ? { ':intent': [{ messageId, intent }] } : {}) },
      ReturnValues: 'ALL_NEW',
    }));
    const queued = (res.Attributes?.queued as string[] | undefined) ?? [];
    // BOUNDED: an intent is read while its message waits, is read by a reading, or is folded, which is within the last
    // few enqueues. The oldest entries past the bound are dropped by a conditional write that a moving list refuses.
    const intents = (res.Attributes?.queuedIntents as QueuedIntent[] | undefined) ?? [];
    if (intents.length > QUEUED_INTENTS_KEPT) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk },
        UpdateExpression: 'SET queuedIntents = :kept',
        ConditionExpression: 'queuedIntents = :current',
        ExpressionAttributeValues: { ':kept': intents.slice(intents.length - QUEUED_INTENTS_KEPT), ':current': intents },
      })).catch((err: any) => {
        if (err?.name !== 'ConditionalCheckFailedException') console.warn('[turn-lock] could not trim the queued intents:', err?.message);
      });
    }
    // FILTERED HERE TOO. A turn that queues while another is mid-post reads the claim marker, and
    // the caller would take it for a real message: it updates that id, Amazon Chime SDK refuses a
    // message that does not exist, and the notice code falls through to posting a fresh one -
    // which is the duplicate the claim was added to prevent, arriving by the other door. Measured:
    // one burst still drew three notices with the claim in place, until this line existed.
    const noticeId = noticeIdOrUndefined(res.Attributes?.noticeId as string | undefined);

    if (queued.length > QUEUE_MAX) {
      let dropped = false;
      const trimmed = queued.slice(queued.length - QUEUE_MAX);
      try {
        // CONDITIONAL, because this writes the QUEUE from a value read a moment ago. Unconditional,
        // a message enqueued between the read and this write was overwritten and gone - the sender
        // having just been told it was waiting. It is the same race `clearQueue` guards against and
        // the same one `returnAmendmentsToQueue` was fixed for; this was the third writer.
        //
        // Losing the condition is not worth a retry here: the trim is a bound on an over-long queue,
        // and a queue that grew again in the meantime is trimmed by the next enqueue anyway. What
        // matters is that it never DROPS a message that arrived, and refusing does that.
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk },
          UpdateExpression: 'SET queued = :q',
          ConditionExpression: 'queued = :current',
          ExpressionAttributeValues: { ':q': trimmed, ':current': queued },
        }));
        dropped = true;
      } catch (err: any) {
        if (err?.name === 'ConditionalCheckFailedException') {
          // The queue moved while we were trimming it, so this trim describes a queue that no
          // longer exists. The next enqueue reads the current one and trims that.
          console.log('[turn-lock] the queue moved under the overflow trim; leaving it to the next enqueue');
        } else {
          console.warn('[turn-lock] overflow trim failed:', err?.message);
        }
      }
      // ── ONLY WHAT ACTUALLY HAPPENED (code review, 2026-09-04) ───────────────────────────────
      //
      // The conditional trim above can refuse, and refusing is the CORRECT outcome: the queue moved,
      // so nothing was dropped. Reporting `overflowed` regardless told the person "I had to drop the
      // oldest one that was waiting - please send it again" about a message still sitting in the
      // queue, and counted a data loss that had not occurred. The metric is the one that judges this
      // bound, so a false count is worse than a missing one.
      if (dropped) {
        // DATA LOSS from the person's point of view. They are told at the time, but a count that
        // lives only in a log line means nobody can see it happening across a deployment.
        recordOverflowDrop(process.env.CLASSIFICATION || '');
      }
      // ── AND THE DEPTH IS WHAT IS ACTUALLY QUEUED, for the same reason ────────────────────────
      //
      // `overflowed` was corrected for a refused trim; `depth` was not. `trimmed` is the array this
      // invocation COMPUTED, not the one the record holds - so when the conditional write refused,
      // the queue still has everything and reporting `trimmed.length` under-states it by exactly the
      // number of messages the trim would have dropped. That lands in two places a person and an
      // operator read: the notice says five are waiting while six are, and `recordQueued` - the
      // metric that judges this very bound - under-reports at the bound.
      const actualDepth = dropped ? trimmed.length : queued.length;
      recordQueued(process.env.CLASSIFICATION || '', actualDepth);
      return { depth: actualDepth, overflowed: dropped, noticeId };
    }
    recordQueued(process.env.CLASSIFICATION || '', queued.length);
    return { depth: queued.length, overflowed: false, noticeId };
  } catch (err: any) {
    // ── THE CALLER HAS ALREADY PROMISED A QUEUE (code review, 2026-09-04) ─────────────────────
    //
    // This returned `{depth: 0}` under the comment "the message is answered, not queued", which was
    // true of an older shape. Its only caller is inside the `!claimed` branch: by the time this
    // runs it has posted "I am holding this" and is about to return a silent response. So a
    // throttled write lost the message outright - never in `queued`, no drain will read it - after
    // the person was told in the conversation that it was waiting.
    //
    // Saying so is what lets the caller tell them the truth instead. It cannot recover the write,
    // and pretending it succeeded is the one option that leaves them waiting for nothing.
    console.error('[turn-lock] enqueue FAILED; the message is neither answered nor queued:', err?.message);
    return { depth: 0, overflowed: false, failed: true };
  }
}

/** Record which message is showing the deferral notice, so later sends update it instead of adding one. */
/**
 * A notice is claimed while it is being posted, so only one turn posts one.
 *
 * Marks the record as "a notice is being posted" and reports whether THIS turn is the one doing
 * it. Conditional on nothing holding the claim, so of several turns queueing at the same instant
 * exactly one is told to post.
 *
 * WHY THIS EXISTS. `enqueueMessage` returns the notice id atomically, so a turn that queues after
 * a notice exists updates it correctly. Three messages arriving TOGETHER all queue before any of
 * them has posted anything: each sees no notice, each posts its own, and the conversation gets the
 * exact triplicate this design exists to prevent - measured, three distinct notices from one burst.
 * The id cannot be claimed after posting because by then the duplicates are already in the room.
 */
export async function claimNotice(args: {
  channelArn: string;
  responderId: string;
  correlationId: string;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return true;
  const { channelArn, responderId, correlationId } = args;
  if (!channelArn || !responderId || !correlationId) return true;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      // Same reason as the enqueue above: claiming the notice is driven by arriving traffic,
      // and traffic must not extend the life of a record that is holding a lock nobody is running.
      UpdateExpression: 'SET noticeId = :pending',
      ConditionExpression: 'attribute_not_exists(noticeId)',
      // No `#ttl`/`:ttl` here either, for the same reason and with the same consequence: the
      // expressions above reference neither, and DynamoDB refuses a declared name no expression uses.
      // This claim is what stops a burst drawing several notices, so when it threw, the very
      // duplication it exists to prevent came back.
      ExpressionAttributeValues: {
        ':pending': NOTICE_PENDING + correlationId,
      },
    }));
    return true;
  } catch (err) {
    // Held by another turn, or unreadable. Either way this turn does not post: a missing notice is
    // recoverable by the next queued send, and a duplicate one is not recoverable at all.
    return false;
  }
}

/**
 * The marker a claimed-but-unposted notice carries.
 *
 * It is never a real message id, so it must never reach a caller as one: `readTurnState` filters it
 * out, and a turn that finds it knows a notice is on its way rather than that one exists.
 */
export const NOTICE_PENDING = 'pending:';

/**
 * Release the notice claim when the post it was claimed for did not happen.
 *
 * WITHOUT THIS THE CONVERSATION GOES SILENT, permanently, and it is the claim working as designed
 * that does it. The claim is taken under `attribute_not_exists(noticeId)` and nothing released it,
 * so a failed post left `pending:<corr>` in place for good. `readTurnState` correctly refuses to
 * report a pending marker as a real id, so every later queued message found no notice, lost the
 * claim it then tried to take, waited its three seconds for an id that could never appear, and
 * returned silence - with no notice in the room either, so nothing told anybody they were waiting.
 *
 * Conditional on the marker still being THIS turn's, so a notice somebody else has since claimed, or
 * a real id that landed late, is never removed.
 */
export async function releaseNoticeClaim(args: {
  channelArn: string;
  responderId: string;
  correlationId: string;
}): Promise<void> {
  if (!turnQueueEnabled()) return;
  const { channelArn, responderId, correlationId } = args;
  if (!channelArn || !responderId || !correlationId) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'REMOVE noticeId',
      ConditionExpression: 'noticeId = :mine',
      ExpressionAttributeValues: { ':mine': NOTICE_PENDING + correlationId },
    }));
  } catch {
    // Somebody else holds it, or a real id landed. Both are correct outcomes, and neither is ours
    // to undo. The next queued send updates whatever is really there.
  }
}

export async function rememberNotice(args: {
  channelArn: string;
  responderId: string;
  noticeId: string;
}): Promise<void> {
  if (!turnQueueEnabled()) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      UpdateExpression: 'SET noticeId = :n',
      ExpressionAttributeValues: { ':n': args.noticeId },
    }));
  } catch (err: any) {
    console.warn('[turn-lock] notice id write failed:', err?.message);
  }
}

/** The state a client renders: who holds the turn, and which messages are waiting. */
/**
 * A SPLIT THIS ASSISTANT HAS OFFERED AND NOBODY HAS ANSWERED YET (DESIGN 2.4.2).
 *
 * It lives on the TURN-STATE record rather than in the task store, and the reason is what the task
 * store deliberately will not carry. A task row travels to other members as existence, type, owner
 * and state, with the text stripped on purpose - which is exactly right for a task and useless for
 * an offer, because an offer a person cannot read the subjects of is not an offer they can answer.
 *
 * This record is already this queue's authority, already read consistently at the start of the path
 * that needs it, and already expires with the same TTL. One store, owned by the feature that writes
 * it, rather than a field added to a shared type for one consumer.
 */
export interface PendingSplitOffer {
  /** The subjects offered, in the order they were put to the person. */
  topics: Array<{
    label: string;
    messageIds: string[];
    /**
     * The subject exists because somebody sent a TARGETED message, so it is not the room's to read.
     *
     * It decides who the spawned conversation belongs to. A private subject moves with its requester
     * and nobody else; an ordinary one carries the room with it, because the room could already see
     * it and moving it out from under them would make a shared thread vanish.
     */
    private?: boolean;
    /**
     * Whose request it is, as a PRINCIPAL ID - never a full ARN.
     *
     * The ARN is derivable (`${appInstance}/user/${id}`) and is rebuilt wherever a message actually
     * has to be addressed, so storing it would be storing the account, the region and the app
     * instance on every subject of every queue, forever, to save one string concatenation. The short
     * form is also the form every other identity comparison in this design uses, which is what makes
     * the record comparable without parsing.
     */
    requestorId?: string;
  }>;
  /**
   * WHO WAS ASKED, as principal ids - EVERYONE THE OFFER CONCERNS, not one person.
   *
   * A queue is the CONVERSATION's, not one member's: it holds whatever arrived while the assistant
   * was working, from whoever sent it, and the subjects read out of it belong to all of them. This
   * was a single id taken from whoever happened to trigger the drain, and both halves of that
   * dropped work (maintainer, 2026-09-05).
   *
   * It cost the whole offer when that one id could not be derived - `savePendingSplit` refused an
   * offer with no `offeredTo`, so every subject belonging to everybody was discarded because one
   * field about one person was empty. And it cost everybody else their answer: `awaitingPerson` is
   * the lock BYPASS, so only the named person could reply without queueing behind the conversation,
   * while the offer they were all shown said the decision was theirs.
   *
   * The other half of the record was already plural and correct: `readPendingSplit` shows a shared
   * subject to anybody and a private one only to its requester, and `clearPendingSplit` settles
   * exactly the subjects one speaker could see. Only the addressing disagreed with them.
   *
   * A PRIVATE subject can be answered by its requester alone; a shared one by anybody it concerns.
   * That distinction lives in `private`/`requestorId` on the topic, which is where it is enforced -
   * this is who may SPEAK to the offer, which is the union.
   *
   * A MAP KEYED BY PRINCIPAL, and the shape is the point. It lives inside the offer because the
   * offer is what it is a fact about - a second attribute beside it would be the same knowledge
   * written twice, free to disagree. And a map is addressable: `attribute_exists` on one key asks
   * whether this person is awaited, and `REMOVE` of that key spends their answer alone, both as
   * ordinary conditional writes on a nested path. A list cannot be indexed by value, which is the
   * only reason a set was reached for first.
   */
  offeredTo: Record<string, true>;
  /** The message the offer was made in reply to, so a spawned conversation can link back to it. */
  originatingMessageId: string;
  offeredAt: number;
}

/**
 * Record an offer awaiting an answer. ONE AT A TIME per (conversation, assistant): a second offer
 * replaces the first, because two open offers over overlapping subjects give a person no way to say
 * which one they are answering.
 */
export async function savePendingSplit(args: {
  channelArn: string;
  responderId: string;
  offer: PendingSplitOffer;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return false;
  const { channelArn, responderId, offer } = args;
  // ── THE SUBJECTS ARE THE OFFER; WHO MAY SPEAK TO IT IS NOT ─────────────────────────────────────
  //
  // This refused an offer whose `offeredTo` was empty, which discarded every subject belonging to
  // everybody because one field about one person could not be filled. An offer with nobody named is
  // still a real question the person was told about: `readPendingSplit` shows a shared subject to
  // anyone in the room, so it remains answerable - what is lost without a name is only the right to
  // walk past a held lock, which is a convenience rather than the offer.
  //
  // Topics remain the precondition. An offer with no subjects is nothing to ask about.
  if (!offer.topics.length) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      // AND THE DRAIN IS NOW WAITING ON PEOPLE, written in the SAME statement as the question.
      //
      // Two writes could not be, and the gap between them is the whole failure: an offer recorded
      // without the wait means the lock is released with a question outstanding, and a wait recorded
      // without the offer holds a conversation for an answer nobody was asked for. One statement
      // cannot land half way.
      //
      // This is what keeps a person's think-time from looking like a dead invocation: the takeover in
      // `claimTurn` refuses to touch a holder while this is set, however long they take.
      //
      // WHO IS AWAITED IS PART OF THE OFFER, not an attribute beside it. `offeredTo` travels inside
      // `pendingSplit`, so recording the question and recording who it was put to cannot come apart -
      // there is nothing to keep in step, because there is only one of them.
      //
      // `awaitingPerson` is REMOVED in the same statement: a record written before the question was
      // everybody's may carry one, and leaving it would hold the conversation for a single named
      // person while the offer says otherwise.
      UpdateExpression: 'SET pendingSplit = :offer REMOVE awaitingPerson',
      ExpressionAttributeValues: { ':offer': offer },
    }));
    return true;
  } catch (err: any) {
    // An offer that failed to record is one the person was still TOLD about, so this is loud: the
    // next turn will not know to act on their answer.
    console.warn('[turn-lock] could not record the split offer:', err?.message);
    return false;
  }
}

/**
 * THE QUESTION A `/stop` ASKED, LEFT WHERE THE NEXT TURN WILL FIND IT.
 *
 * The third question of this exact shape, after the split offer above and the drift suggestion, and
 * recorded the same way for the same reason: the answer arrives in ordinary words on a later turn,
 * so something has to say a question is outstanding or the turn cannot know to act on it.
 *
 * WITHOUT THIS THE STOP HAS NO ENDING. Live 2026-09-10: the evaluation asked what to do with the
 * stopped report, the person answered "Drop it, I do not want that report", and that turn ran to
 * completion as an ordinary `intent: general` message. They were asked a question whose answer
 * nothing could act on. The router reads this record before it routes anything
 * (`readStopDecision`), so the question owns the message that answers it.
 *
 * NOT `awaitingPerson`, and not the lock. A stop RELEASES the conversation deliberately; holding it
 * until they answer would turn an escape hatch into a second thing that has to be escaped. This
 * records only that a question stands, and any later turn by that person can settle it.
 *
 * BEST-EFFORT, AND LOUD WHEN IT FAILS: they have already been asked by the time this runs, so a
 * failure here means their answer is routed as an ordinary message. The work is already cancelled,
 * so what that costs is a restart they have to ask for in full, never work lost.
 */
export async function rememberStopDecision(args: {
  channelArn: string;
  responderId: string;
  askedOf: string;
  taskIds: string[];
  /** What each cancelled piece of work was, so "start it again" can say what it was. */
  requests: Array<{ text: string; private: boolean }>;
}): Promise<boolean> {
  // THE TABLE, NOT THE QUEUE FLAG - the rule `turnStopEnabled` states, applied here too.
  //
  // This asked `turnQueueEnabled()` (the flag AND the table) while `recordStop` and
  // `wasStoppedSince` beside it ask only for the table. On a deployment with the table set and
  // queueing not opted into, `/stop` still held the work and still asked what to do with it, and
  // then no answer was ever recorded or read. The escape hatch opened and had no ending: the held
  // tasks stayed in_progress until their TTL, with nothing erroring.
  //
  // Suppressing an answer somebody asked to stop is not part of queueing, and neither is
  // remembering what they said to do about it.
  if (!turnStopEnabled()) return false;
  const { channelArn, responderId, askedOf, taskIds, requests } = args;
  if (!channelArn || !responderId || !askedOf || !taskIds.length) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'SET pendingStop = :s',
      ExpressionAttributeValues: {
        ':s': { askedOf, taskIds, requests, askedAt: new Date().toISOString() },
      },
    }));
    return true;
  } catch (err: any) {
    console.warn('[turn-lock] could not record the stop decision:', err?.message);
    return false;
  }
}

/**
 * The stop question outstanding for THIS person, if any.
 *
 * Scoped to the speaker for the same reason the split offer is: a question put to one person is not
 * another member's to answer, and reading it for the wrong speaker would let somebody else discard
 * work they cannot even see.
 */
export async function readStopDecision(args: {
  channelArn: string;
  responderId: string;
  speakerId: string;
}): Promise<PendingStopDecision | undefined> {
  // The table, not the queue flag - see `rememberStopDecision`. A decision that was written and
  // cannot be read is the same defect from the other side.
  if (!turnStopEnabled() || !args.speakerId) return undefined;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      ConsistentRead: true,
    }));
    const pending = res.Item?.pendingStop as Partial<PendingStopDecision> | undefined;
    if (!pending?.askedOf || !pending.taskIds?.length) return undefined;
    if (pending.askedOf !== args.speakerId) return undefined;
    return {
      askedOf: pending.askedOf,
      taskIds: pending.taskIds,
      // Absent on a question recorded without them. Such a question can still be left or answered
      // with something else; it simply has nothing to restart from.
      requests: Array.isArray(pending.requests)
        ? pending.requests.filter((r) => typeof r?.text === 'string')
          .map((r) => ({ text: r.text, private: r.private !== false }))
        : [],
      askedAt: pending.askedAt || '',
    };
  } catch (err: any) {
    console.warn('[turn-lock] could not read the stop decision:', err?.message);
    return undefined;
  }
}

/** Settled, either way. A question answered "keep" is as finished as one answered "drop". */
export async function clearStopDecision(args: {
  channelArn: string;
  responderId: string;
}): Promise<void> {
  // The table, not the queue flag - see `rememberStopDecision`. A decision that cannot be cleared
  // outlives the question it answered and is read again by the next unrelated message.
  if (!turnStopEnabled()) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      UpdateExpression: 'REMOVE pendingStop',
    }));
  } catch (err: any) {
    console.warn('[turn-lock] could not clear the stop decision:', err?.message);
  }
}

/**
 * MESSAGES THAT AMEND THE WORK IN FLIGHT, LEFT WHERE THE RUNNING TURN WILL FIND THEM.
 *
 * ADR-033's per-entry table is explicit that a message arriving mid-step is "queued, as CONTEXT for
 * the running step", and DESIGN 2.4 that an `amends` reading "changes what is already running rather
 * than opening new work". Both halves of that were missing the same thing: the reading classified the
 * message, declined to give it a task - correctly, "one task per new request, and none for an
 * amendment" - and then nothing carried the amendment to the work it amends. So "actually, make it
 * one page" was read, described back to the person, and the fifteen-paragraph report was delivered
 * unchanged.
 *
 * The reading and the work are different turns, so the amendment is left on the record they share.
 *
 * APPENDED, NOT REPLACED. Two messages can amend one turn, and the second must not erase the first.
 */
export async function recordAmendments(args: {
  channelArn: string;
  responderId: string;
  messageIds: string[];
}): Promise<string[]> {
  if (!turnQueueEnabled()) return [];
  const { channelArn, responderId, messageIds } = args;
  if (!channelArn || !responderId || !messageIds.length) return [];
  const pk = lockKey(channelArn, responderId);
  try {
    // ── ONLY WHAT IS STILL WAITING, AND ONLY ONCE (ADR-033, 2026-09-14) ─────────────────────────
    //
    // A reading now records what it found BEFORE it re-reads a queue that moved, so the next pass
    // reads the same message again and would record it a second time. Worse, the fold may have taken
    // it in between: the fold takes a folded message off the queue, so a message that is no longer
    // queued has already been answered, and recording it again would hand the handover an amendment
    // for work that is over - returned to the queue and answered twice.
    //
    // So an id is recorded only while it is still queued and not already recorded. Read, filter,
    // then append conditionally on the queue being the one filtered against.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk }, ConsistentRead: true }));
      const queued = (res.Item?.queued as string[] | undefined) ?? [];
      const already = new Set((res.Item?.amendments as string[] | undefined) ?? []);
      const fresh = messageIds.filter((id) => queued.includes(id) && !already.has(id));
      if (!fresh.length) return [];
      try {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk },
          UpdateExpression: 'SET amendments = list_append(if_not_exists(amendments, :empty), :ids)',
          ConditionExpression: 'queued = :queued',
          ExpressionAttributeValues: { ':empty': [], ':ids': fresh, ':queued': queued },
        }));
        return fresh;
      } catch (err: any) {
        if (err?.name === 'ConditionalCheckFailedException') continue;
        throw err;
      }
    }
    console.warn('[turn-lock] the queue kept moving; the amendment is left for the next pass', { channelArn });
    return [];
  } catch (err: any) {
    // The amendment stays in the queue and is read by the next pass, which is late rather than lost.
    console.warn('[turn-lock] could not record the amendment for the work in flight:', err?.message);
    return [];
  }
}

/**
 * A FOLDED MESSAGE LEAVES THE QUEUE (ADR-033, 2026-09-14).
 *
 * The fold answers it inside the running turn, so it is no longer waiting: the client stops showing it
 * as queued, a later reading pass cannot record it again (`recordAmendments` requires an id to still
 * be queued), and the drain's clear does not have to account for it. Compare-and-swap with retries,
 * for the reason `clearQueue` gives: the queue moving is ordinary.
 */
export async function takeFoldedOffQueue(args: {
  channelArn: string;
  responderId: string;
  messageIds: string[];
}): Promise<void> {
  if (!turnQueueEnabled()) return;
  const { channelArn, responderId, messageIds } = args;
  if (!channelArn || !responderId || !messageIds.length) return;
  const pk = lockKey(channelArn, responderId);
  const taken = new Set(messageIds);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk }, ConsistentRead: true }));
      const current = (res.Item?.queued as string[] | undefined) ?? [];
      if (!current.some((id) => taken.has(id))) return;
      const remainder = current.filter((id) => !taken.has(id));
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk },
        ...(remainder.length
          ? { UpdateExpression: 'SET queued = :rest', ExpressionAttributeValues: { ':rest': remainder, ':current': current } }
          : { UpdateExpression: 'REMOVE queued', ExpressionAttributeValues: { ':current': current } }),
        ConditionExpression: 'queued = :current',
      }));
      return;
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') continue;
      console.warn('[turn-lock] could not take the folded messages off the queue:', err?.message);
      return;
    }
  }
  console.warn('[turn-lock] the queue kept moving; folded messages are left queued', { channelArn });
}

/**
 * AN ANSWER THAT IS READY WAITS FOR THE READING STILL RUNNING BESIDE IT (ADR-033, 2026-09-14).
 *
 * Follow-ups are rolled into an answer before it is sent, and the reading is what says which messages
 * are follow-ups. When the answer is ready while that reading is still running, sending it now answers
 * without them. So the finished turn PARKS: its finalize inputs are stored on the record and the
 * conversation is handed to the reader in the same write, and the reader resumes it when it knows
 * (`resumeParkedTurnIfAny`). The resumed turn then folds or delivers through the ordinary path.
 *
 * ONE CONDITIONAL WRITE, so there is no instant the conversation is unheld: the holder moves from this
 * turn to the reader only if this turn still holds it, the reader still holds the reading claim, and
 * something is still queued. When any of those is false the reading has finished and the caller
 * delivers as it always did.
 */
export async function parkTurnForReading(args: {
  channelArn: string;
  responderId: string;
  correlationId: string;
  reader: string;
  /** The finalize inputs, serialized. Stored so the resumed turn never pays for the model again. */
  params: string;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return false;
  const { channelArn, responderId, correlationId, reader, params } = args;
  if (!channelArn || !responderId || !correlationId || !reader || reader === correlationId) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'SET holder = :reader, holderAt = :now, parkedTurn = :parked',
      ConditionExpression: 'holder = :me AND triagedBy = :reader AND size(queued) > :zero AND attribute_not_exists(parkedTurn)',
      ExpressionAttributeValues: {
        ':reader': reader,
        ':me': correlationId,
        ':now': Date.now(),
        ':zero': 0,
        ':parked': { correlationId, params, parkedAt: new Date().toISOString() },
      },
    }));
    return true;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] could not park the answer for the reading; delivering it now:', err?.message);
    }
    return false;
  }
}

/**
 * The reader starts resuming a parked turn: the conversation goes back to the parked turn, and the
 * record says who resumed it so a second reader or a redelivery cannot resume it twice.
 *
 * Returns the parked turn's correlation id when this call won, undefined otherwise.
 */
export async function beginResumeParkedTurn(args: {
  channelArn: string;
  responderId: string;
  reader: string;
}): Promise<string | undefined> {
  if (!turnQueueEnabled()) return undefined;
  const { channelArn, responderId, reader } = args;
  if (!channelArn || !responderId || !reader) return undefined;
  const pk = lockKey(channelArn, responderId);
  try {
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk }, ConsistentRead: true }));
    const parked = res.Item?.parkedTurn as { correlationId?: string; resumedBy?: string } | undefined;
    if (!parked?.correlationId || parked.resumedBy) return undefined;
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk },
      UpdateExpression: 'SET holder = :parked, holderAt = :now, parkedTurn.resumedBy = :reader',
      // THE READER MUST STILL HOLD IT, or be displaced with nothing holding it. A reader taken over as
      // stale must not hand a conversation that now belongs to somebody else.
      ConditionExpression: 'parkedTurn.correlationId = :parked AND attribute_not_exists(parkedTurn.resumedBy)'
        + ' AND (holder = :reader OR attribute_not_exists(holder))',
      ExpressionAttributeValues: { ':parked': parked.correlationId, ':reader': reader, ':now': Date.now() },
    }));
    return parked.correlationId;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] could not begin resuming the parked answer:', err?.message);
    }
    return undefined;
  }
}

/** The resume could not be dispatched: the reader takes the conversation back, and the parked turn waits. */
export async function abandonResumeParkedTurn(args: {
  channelArn: string;
  responderId: string;
  reader: string;
  parked: string;
}): Promise<void> {
  if (!turnQueueEnabled()) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      UpdateExpression: 'SET holder = :reader, holderAt = :now REMOVE parkedTurn.resumedBy',
      ConditionExpression: 'holder = :parked AND parkedTurn.resumedBy = :reader',
      ExpressionAttributeValues: { ':reader': args.reader, ':parked': args.parked, ':now': Date.now() },
    }));
  } catch (err: any) {
    console.warn('[turn-lock] could not hand the conversation back after a failed resume:', err?.message);
  }
}

/**
 * The resumed run takes its stored inputs off the record, exactly once. A duplicate delivery of the
 * resume finds nothing and must not touch the lock.
 */
export async function takeParkedTurn(args: {
  channelArn: string;
  responderId: string;
  correlationId: string;
}): Promise<string | undefined> {
  if (!turnQueueEnabled()) return undefined;
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      UpdateExpression: 'REMOVE parkedTurn',
      ConditionExpression: 'parkedTurn.correlationId = :c AND attribute_exists(parkedTurn.resumedBy)',
      ExpressionAttributeValues: { ':c': args.correlationId },
      ReturnValues: 'ALL_OLD',
    }));
    return (res.Attributes?.parkedTurn as { params?: string } | undefined)?.params;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] could not take the parked answer:', err?.message);
    }
    return undefined;
  }
}

/**
 * Taken back off once the running turn has folded them in.
 *
 * REMOVED BY ID rather than by clearing the field, for the reason `clearQueue` removes queued ids
 * individually: a message that arrived while the turn was folding the previous one has not been seen
 * by anything, and clearing the whole field would drop it unread.
 */
export async function clearAmendments(args: {
  channelArn: string;
  responderId: string;
  messageIds: string[];
}): Promise<void> {
  if (!turnQueueEnabled()) return;
  const { channelArn, responderId, messageIds } = args;
  if (!channelArn || !responderId || !messageIds.length) return;
  const taken = new Set(messageIds);
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      ConsistentRead: true,
    }));
    const current = (res.Item?.amendments as string[] | undefined) ?? [];
    const remainder = current.filter((id) => !taken.has(id));
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      // CONDITIONAL, for the reason the queue writes are: this replaces the list from a value read a
      // moment ago, and `recordAmendments` appends with `list_append` from the reading that runs
      // BESIDE this turn. An amendment recorded in that window was dropped - a message read,
      // classified as amending, described back to the person, and then reached by nothing.
      //
      // The doc comment above already says the field must not be cleared wholesale for exactly this
      // reason, and removing by id does not help if the write that follows is unconditional.
      ...(remainder.length
        ? {
          UpdateExpression: 'SET amendments = :rest',
          ConditionExpression: 'amendments = :current',
          ExpressionAttributeValues: { ':rest': remainder, ':current': current },
        }
        : {
          UpdateExpression: 'REMOVE amendments',
          ConditionExpression: 'amendments = :current',
          ExpressionAttributeValues: { ':current': current },
        }),
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      // Something was recorded while this turn was folding. Leaving the list alone is the safe half:
      // the folded ids stay marked, and the handover returns whatever is still there to the queue -
      // one message re-read, against one message silently dropped.
      console.log('[turn-lock] an amendment arrived while folding; leaving the list for the handover');
      return;
    }
    console.warn('[turn-lock] could not clear the folded amendments:', err?.message);
  }
}

/**
 * PUT AN AMENDMENT BACK ON THE QUEUE, PENDING PRIORITISATION (maintainer, 2026-09-01).
 *
 * An amendment is recorded for the running turn to fold in, and the fold is the only thing that ever
 * took one off again. So an amendment the fold could not reach - recorded after the turn passed its
 * checkpoint, or arriving when there was nothing left to amend - sat in `amendments` forever: not
 * folded, not queued, and holding no task. The person's message had been read, classified, described
 * back to them, and acted on by nothing. Measured live: `recorded 1 amendment(s)`, never taken off.
 *
 * THE QUEUE IS THE PENDING-PRIORITISATION STATE, which is why this needs no new field. Returning the
 * id puts it exactly where an unread message sits, and the next reading prioritizes it with whatever
 * else is waiting - "the assistant prioritises when it gets to it". Deciding its position at the
 * moment it is orphaned would be re-prioritising against work already under way, which is the churn
 * the deferral exists to avoid.
 *
 * ONE WRITE, both halves. Clearing first and appending after would drop the message entirely if the
 * second call failed, and losing it is the one outcome worse than folding it late.
 *
 * IDEMPOTENT: an id already queued is not added twice, so a redelivery cannot make one message look
 * like two waiting.
 */
export async function returnAmendmentsToQueue(args: {
  channelArn: string;
  responderId: string;
  /** Omitted returns EVERY amendment still recorded, which is what a turn ending wants. */
  messageIds?: string[];
}): Promise<string[]> {
  if (!turnQueueEnabled()) return [];
  const { channelArn, responderId, messageIds } = args;
  if (!channelArn || !responderId) return [];
  // THREE ATTEMPTS, because the loser of this race is a message somebody sent. A conditional
  // failure here means the queue moved under the read - re-read it and merge again.
  for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      ConsistentRead: true,
    }));
    const recorded = (res.Item?.amendments as string[] | undefined) ?? [];
    const returning = messageIds?.length
      ? recorded.filter((id) => messageIds.includes(id))
      : recorded;
    if (!returning.length) return [];

    const queued = (res.Item?.queued as string[] | undefined) ?? [];
    const alreadyQueued = new Set(queued);
    const merged = [...queued, ...returning.filter((id) => !alreadyQueued.has(id))];
    const remainder = recorded.filter((id) => !returning.includes(id));

    // ── COMPARE AND SWAP, BECAUSE THIS WRITES THE QUEUE (code review, 2026-09-04) ──────────────
    //
    // This read `queued`, merged, and wrote `SET queued = :q` unconditionally - so a message that
    // arrived between the two was overwritten and gone. It runs at TURN END, which is exactly when
    // `enqueueMessage`'s `list_append` is firing for arriving messages, so the window is not
    // theoretical: the person had already been told their message was waiting, and nothing would
    // ever look at it again.
    //
    // `clearQueue` conditions on the list it read for precisely this reason. The same guard belongs
    // here, and it retries rather than giving up: losing the race means an AMENDMENT is stranded,
    // which is the thing this function exists to prevent.
    const current = res.Item?.queued as string[] | undefined;
    // ── AND THE CONDITION COVERS `amendments` TOO, BECAUSE THIS STATEMENT WRITES IT ─────────────
    //
    // The guard above was added for `queued` and stopped there, but both branches also write
    // `amendments` - one narrows it to the remainder, the other REMOVES it outright. The reading
    // turn appends to that same list concurrently (`recordAmendments`, a `list_append`), so a GET
    // that saw `[A]` while the reading appended `B` would write the remainder of `[A]` over the
    // top of `[A, B]`, or remove the attribute holding B. B was read, classified as amending, and
    // described back to the person, and would then be in neither list.
    //
    // `clearAmendments` guards the identical write with `amendments = :current`; the guard was
    // simply absent here. Conditioning on BOTH lists means a concurrent append refuses this write
    // and the loop re-reads, which is exactly what the retry is for.
    const currentAmendments = res.Item?.amendments as string[] | undefined;
    // AN ARRAY JOINED, not an interpolated string. Both are one expression to DynamoDB, but
    // `a-command-declares-only-what-it-uses` reads a condition assembled in a variable only in the
    // `.join()` form - so an interpolated one hides every placeholder it uses and the guard reports
    // them as unused declarations. Written the way the checker can read, it stays checkable.
    const guards = [
      current === undefined ? 'attribute_not_exists(queued)' : 'queued = :current',
      currentAmendments === undefined
        ? 'attribute_not_exists(amendments)'
        : 'amendments = :currentAmendments',
    ];
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      ...(remainder.length
        ? { UpdateExpression: 'SET queued = :q, amendments = :rest' }
        : { UpdateExpression: 'SET queued = :q REMOVE amendments' }),
      // Absent is a real state and is not the same as empty: a queue that never existed must not be
      // matched by a condition written for one that did. The same holds for the amendment list.
      ConditionExpression: guards.join(' AND '),
      ExpressionAttributeValues: {
        ':q': merged,
        ...(remainder.length ? { ':rest': remainder } : {}),
        ...(current === undefined ? {} : { ':current': current }),
        ...(currentAmendments === undefined ? {} : { ':currentAmendments': currentAmendments }),
      },
    }));
    return returning;
  } catch (err: any) {
    // LOUD, because the alternative to this working is a message nobody ever answers.
    if (err?.name === 'ConditionalCheckFailedException') {
      // The queue moved. Go round again with what it says now.
      continue;
    }
    console.error('[turn-lock] could not return the unfolded amendments to the queue:', err?.message);
    return [];
  }
  }
  // THREE LOSSES IN A ROW is a queue changing faster than this can read it, which on a real
  // conversation does not happen. Said loudly rather than silently, because what is left behind is a
  // message somebody sent, classified as amending, described back to them, and now reached by
  // nothing - the exact outcome this function exists to prevent.
  console.error('[turn-lock] gave up returning the unfolded amendments; the queue moved three times', {
    channelArn, responderId,
  });
  return [];
}

/**
 * The outstanding offer AS THIS PERSON MAY SEE IT (DESIGN 2.4.2).
 *
 * SHARED SUBJECTS FIRST, PRIVATE ONES ONE-TO-ONE. A room can hold several people, and the assistant
 * deals with what is everyone's in the open and with what is one person's in private. So the record
 * holds every subject that may be acted on, and this read narrows it to what the person in front of
 * it is entitled to: the shared subjects, which are anybody's to answer about, plus their OWN
 * private ones and nobody else's.
 *
 * Filtered on the way OUT rather than on the way in, because who is asking is not known when the
 * offer is written and there may be several of them. A private subject belonging to somebody else is
 * not merely unanswerable here - it is invisible, because naming it would describe a message this
 * person cannot read.
 */
export async function readPendingSplit(args: {
  channelArn: string;
  responderId: string;
  speakerId: string;
}): Promise<PendingSplitOffer | undefined> {
  if (!turnQueueEnabled() || !args.speakerId) return undefined;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      ConsistentRead: true,
    }));
    const offer = res.Item?.pendingSplit as PendingSplitOffer | undefined;
    if (!offer?.topics?.length) return undefined;

    const visible = offer.topics.filter(
      (topic) => !topic.private || topic.requestorId === args.speakerId,
    );
    if (!visible.length) return undefined;
    return { ...offer, topics: visible };
  } catch {
    return undefined;
  }
}

/**
 * MOVE THE QUEUE ON TO A LATER STAGE, OR REFUSE.
 *
 * The authority for stage ordering, and it is a conditional write rather than a read-then-compare
 * because the writes genuinely race: the private half and the clear are driven by different awaits
 * in the same turn, and once a handover is involved by different invocations entirely. A check that
 * reads the current stage and then writes cannot settle two of those; a condition on the stored rank
 * can, and it is the same compare-and-swap the rest of this record already uses.
 *
 * @returns true when the stage actually advanced, so the caller knows whether to render it. False is
 *   an ordinary outcome, not an error: it means something later already happened.
 */
export async function advanceQueueStatus(args: {
  channelArn: string;
  responderId: string;
  status: string;
  /** The states the declared machine says may precede `status`. Empty means nothing legally can. */
  cameFrom: string[];
  /**
   * True when the machine's INITIAL state is one of `cameFrom`, so a record with nothing recorded
   * yet may take this move.
   *
   * A queue is `waiting` by existing; nothing writes that value. So an absent attribute means the
   * initial state rather than an unknown one, and reading it as unknown made the first advance
   * impossible and every later one unreachable.
   */
  absentCountsAsStart?: boolean;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return false;
  const { channelArn, responderId, status, cameFrom, absentCountsAsStart } = args;
  if (!channelArn || !responderId) return false;
  if (!cameFrom.length && !absentCountsAsStart) return false;

  // THE CONDITION IS THE MACHINE. A move is accepted only from a state that actually leads to it, so
  // an ordering check that would wave through waiting -> settled cannot: that edge is not declared.
  // ONLY WHAT THE EXPRESSION USES. `#ttl` was declared here and never referenced, so DynamoDB rejected
  // every stage advance and the drain silently showed no progress at all.
  const names: Record<string, string> = { '#qs': 'queueStatus' };
  const values: Record<string, unknown> = {
    ':s': status,
  };
  const froms = cameFrom.map((from, i) => {
    values[`:f${i}`] = from;
    return `:f${i}`;
  });
  const clauses: string[] = [];
  // Nothing recorded yet is a legal start only for the state the machine starts in.
  if (absentCountsAsStart) clauses.push('attribute_not_exists(#qs)');
  if (froms.length) clauses.push(`#qs IN (${froms.join(', ')})`);

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'SET #qs = :s',
      ConditionExpression: clauses.join(' OR '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    // Unwritable state costs a progress line, never the drain: the caller renders nothing and
    // carries on with the work the stage was describing.
    console.warn('[turn-lock] could not advance the queue stage:', err?.message);
    return false;
  }
}

/** How many times one speaker's settlement re-reads an offer that another answer changed under it. */
const SPLIT_SETTLE_ATTEMPTS = 3;

/** Answered, superseded, or acted on. Either way it is no longer a question. */
export async function clearPendingSplit(args: {
  channelArn: string;
  responderId: string;
  /**
   * WHOSE ANSWER THIS IS. Omitted clears the whole offer, which is right only when nobody's answer is
   * outstanding any more - a drain settling, or the TTL backstop.
   */
  speakerId?: string;
}): Promise<void> {
  if (!turnQueueEnabled()) return;
  try {
    // ── ONE PERSON'S ANSWER SETTLES ONE PERSON'S SUBJECTS (code review, 2026-09-04) ─────────────
    //
    // An offer deliberately carries several people's subjects at once - narrowing it to one person
    // would mean everybody else was never asked - and `readPendingSplit` filters it per speaker. This
    // removed the WHOLE field, so the first person to answer erased everybody else's outstanding
    // offer: when the next person answered, `readPendingSplit` found nothing and their reply did
    // nothing at all, silently.
    //
    // What a speaker settles is exactly what they could SEE, which is the same rule the read uses:
    // their own subjects, and any shared one, because a shared subject answered by anybody is
    // answered. A subject private to somebody else is untouched and still waiting for them.
    //
    // ── AND ONLY THE OFFER THIS SPEAKER READ (queue review, 2026-09-12) ─────────────────────────
    //
    // This is a read-modify-write, and it was the one writer of this record with no condition. Two
    // people answering one offer at once both read it whole, and whichever wrote second put back the
    // subject the first had settled - and with it the first person's spent right to walk past the
    // lock. So the write is conditional on the offer still being exactly what was read. A refusal
    // is the designed outcome, not an error: somebody else settled part of it first, and the answer
    // is recomputed from what they left rather than from what this speaker saw.
    if (args.speakerId) {
      for (let attempt = 0; attempt < SPLIT_SETTLE_ATTEMPTS; attempt++) {
        const current = await ddb.send(new GetCommand({
          TableName: TABLE,
          Key: { pk: lockKey(args.channelArn, args.responderId) },
          ConsistentRead: true,
        }));
        const offer = current.Item?.pendingSplit as PendingSplitOffer | undefined;
        const remaining = (offer?.topics ?? []).filter(
          (topic) => topic.private && topic.requestorId !== args.speakerId,
        );
        try {
          if (remaining.length) {
            // WHO IS STILL OWED IT, recomputed from what is left rather than left as it was.
            //
            // The offer stands for whoever still holds a subject in it, so the awaited set has to
            // shrink to exactly those people: leaving it whole would keep a bypass alive for somebody
            // with nothing outstanding, and removing it whole would take it from the people who still
            // have. Both were wrong in the same statement - it removed `awaitingPerson` entirely while
            // keeping the topics, so after the first answer nobody could walk past the lock to give
            // the second.
            const stillOwed: Record<string, true> = {};
            for (const topic of remaining) if (topic.requestorId) stillOwed[topic.requestorId] = true;
            await ddb.send(new UpdateCommand({
              TableName: TABLE,
              Key: { pk: lockKey(args.channelArn, args.responderId) },
              // Only this speaker's right to walk past a held lock is spent; the rest keep theirs,
              // and they keep it inside the offer they still hold a subject in rather than beside it.
              UpdateExpression: 'SET pendingSplit = :rest REMOVE awaitingPerson',
              ConditionExpression: 'pendingSplit = :seen',
              ExpressionAttributeValues: {
                ':rest': { ...offer, topics: remaining, offeredTo: stillOwed },
                ':seen': offer,
              },
            }));
            return;
          }
          // Nothing of anybody else's is left, so the whole offer goes - but still only the offer
          // that was read. A NEW offer recorded in between belongs to a later drain and is not this
          // speaker's to settle. An offer that was already absent stays a legal clear, because a
          // record written earlier can still carry the single `awaitingPerson` id.
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { pk: lockKey(args.channelArn, args.responderId) },
            UpdateExpression: 'REMOVE pendingSplit, awaitingPerson',
            ...(offer
              ? { ConditionExpression: 'pendingSplit = :seen', ExpressionAttributeValues: { ':seen': offer } }
              : { ConditionExpression: 'attribute_not_exists(pendingSplit)' }),
          }));
          return;
        } catch (err: any) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          // Changed under us. Read again and settle against what is actually there now.
        }
      }
      // Still racing after every attempt: leave the offer as the other writers left it. A subject
      // left standing costs a question asked twice; a subject restored costs work done twice.
      console.warn('[turn-lock] split offer kept changing while it was being settled; left as found');
      return;
    }
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      // THE WAIT ENDS WITH THE QUESTION. Leaving `awaitingPerson` behind would hold the conversation
      // for an answer that has already arrived, and no takeover would ever free it - the guard that
      // protects a waiting person would have become the thing that strands them.
      // BOTH SHAPES GO. The offer carries who was awaited, so removing it removes them; the single
      // id a record written earlier may still carry goes in the same statement, because leaving it
      // would strand the conversation exactly as the offer would.
      UpdateExpression: 'REMOVE pendingSplit, awaitingPerson',
    }));
  } catch (err: any) {
    // A stale offer costs a question asked twice rather than work done twice: nothing moves without
    // an answer naming subjects. A stale WAIT is the expensive half, which is why the next arriving
    // message checks the state rather than trusting this write to have happened.
    console.warn('[turn-lock] could not clear the split offer:', err?.message);
  }
}

export async function readTurnState(args: {
  channelArn: string;
  responderId: string;
  /**
   * `unreadable` is set when the read FAILED, as opposed to finding nothing.
   *
   * Every lock path here is deliberately fail-open and ignores it: a conversation must not become
   * unanswerable because one GetItem was throttled. But a caller that REPORTS this state to a
   * person is making a claim, and "nothing is waiting" is the wrong thing to say when the truth is
   * "I could not look" - the client believes it and clears the styling on messages that are still
   * queued. The turn-state API has always had a 500 branch for exactly that, and it was
   * unreachable, because this returned an empty state for both.
   */
}): Promise<{
  busy: boolean; queued: string[]; noticeId?: string; awaitingPerson?: string;
  /** The turn holding the conversation, when one does. `busy` is this being present. */
  holder?: string;
  /** Everyone a split offer is outstanding on. See `PendingSplitOffer.offeredTo`. */
  awaitingPeople?: string[]; unreadable?: boolean;
  triagedBy?: string; amendments?: string[]; drainTaskId?: string; holderMessageId?: string;
  /** A finished answer waiting for the reading beside it (`parkTurnForReading`): its correlation id. */
  parkedTurn?: string;
  /** The intent each queued message was classified as when it queued, by message id (ADR-064 decision B). */
  queuedIntents?: Record<string, string>;
}> {
  if (!turnQueueEnabled()) return { busy: false, queued: [] };
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: lockKey(args.channelArn, args.responderId) },
      // STRONGLY CONSISTENT, because this record is the authority and the callers read it
      // IMMEDIATELY after it changes.
      //
      // The deferral notice is posted right after the enqueue, and the client re-reads the moment it
      // sees that notice - milliseconds later. An eventually consistent read can still answer with
      // the item as it was BEFORE the enqueue, so the client is told the queue is empty and, with one
      // queued message, the notice never changes again and it never re-reads: the waiting message
      // goes unmarked for the life of the conversation. The same read decides what triage sees.
      //
      // One small item on the critical path of a state change, so the cost is one extra read unit and
      // no extra round trip. A design that calls this record the only authority cannot then read it
      // in a way that may not show what it says.
      ConsistentRead: true,
    }));
    return {
      busy: !!res.Item?.holder,
      queued: (res.Item?.queued as string[] | undefined) ?? [],
      // NEVER the pending sentinel: it is not a message, and a client told to watch it would be
      // watching something that does not exist.
      noticeId: noticeIdOrUndefined(res.Item?.noticeId as string | undefined),
      // WHO THE DRAIN IS WAITING ON, when it asked something and has not been answered. The handover
      // reads this to keep the lock: a drain paused on a person is unfinished, not idle.
      // BOTH SHAPES ARE SURFACED. The current one is DERIVED from the offer rather than stored
      // beside it, so it cannot drift from the question it describes; `awaitingPerson` is the single
      // id a record written earlier still has. A caller asking only "is anybody being waited on" must
      // see either, or the handover releases a conversation that is genuinely paused.
      ...(res.Item?.awaitingPerson ? { awaitingPerson: String(res.Item.awaitingPerson) } : {}),
      ...(awaitingPeopleOf(res.Item?.pendingSplit).length
        ? { awaitingPeople: awaitingPeopleOf(res.Item?.pendingSplit) }
        : {}),
      // WHICH TURN HOLDS THE CONVERSATION, and not merely that somebody does.
      //
      // `busy` cannot answer "is somebody ELSE still answering", and a caller that needs that
      // question is reading its own hold as a stranger's. The handover needs exactly this: a reading
      // handed the conversation by the turn it was reading alongside IS the holder by then, so
      // `busy` is true because of itself.
      ...(res.Item?.holder ? { holder: String(res.Item.holder) } : {}),
      // WHO IS READING THE QUEUE RIGHT NOW, so the handover can hand the conversation to them.
      //
      // A reading is PROCESSING. The claim used to be invisible here, so a turn ending while
      // somebody else read the queue could only release the lock - and the reading it released
      // around holds no lock of its own (`dispatchTriageTurn` never takes one; it inherited the
      // answering turn's). The conversation then reported idle while a turn was actively reading
      // it, and the messages that reading did not reach had nothing left to pick them up.
      ...(res.Item?.triagedBy ? { triagedBy: String(res.Item.triagedBy) } : {}),
      // THE TASK THIS DRAIN IS, when one was opened for it. Read by every pass, because a handover
      // chain is ONE reading that took more than one turn and has to advance one task, not a new
      // task per link. Absent means no task is tracking this drain, which a caller treats as a
      // reason to carry on rather than a reason to stop.
      ...(res.Item?.drainTaskId ? { drainTaskId: String(res.Item.drainTaskId) } : {}),
      // WHAT THE RUNNING TURN IS ANSWERING, so a reading can describe the work it is asked to compare
      // against. Absent means no id was recorded, and the reading falls back to saying only that
      // something is running.
      ...(res.Item?.holderMessageId ? { holderMessageId: String(res.Item.holderMessageId) } : {}),
      ...(res.Item?.parkedTurn?.correlationId ? { parkedTurn: String(res.Item.parkedTurn.correlationId) } : {}),
      // WHAT THE RUNNING TURN HAS NOT SEEN YET. Messages the reading judged to AMEND the work in
      // flight, waiting for that work to fold them in before it speaks.
      amendments: (res.Item?.amendments as string[] | undefined) ?? [],
      // WHAT EACH QUEUED MESSAGE ASKED FOR, as the router classified it when it queued. A reading opens a task under it,
      // and a fold declares it on the answer, so a queued message is attributed to its own intent.
      queuedIntents: queuedIntentsById(res.Item?.queuedIntents),
    };
  } catch (err: any) {
    console.warn('[turn-lock] state read failed:', err?.message);
    return { busy: false, queued: [], unreadable: true };
  }
}

/** Exposed for the tests and for the notice copy, so the bound is stated in one place. */
/** A real notice id, or nothing when the notice is only claimed. */
/** Everyone an offer is outstanding on, read off the offer itself. Empty when there is none. */
function awaitingPeopleOf(offer: unknown): string[] {
  const offeredTo = (offer as PendingSplitOffer | undefined)?.offeredTo;
  return offeredTo ? Object.keys(offeredTo).filter(Boolean) : [];
}

function noticeIdOrUndefined(v: string | undefined): string | undefined {
  return v && !v.startsWith(NOTICE_PENDING) ? v : undefined;
}

export const TURN_QUEUE_MAX = QUEUE_MAX;

/**
 * ── STOPPING A TURN THAT IS ALREADY RUNNING (ADR-033) ────────────────────────────────────────────
 *
 * `/stop` cancels the task RECORDS in a conversation, which is the durable half. It does not reach
 * the turn already in flight: that Lambda is mid-Bedrock-call and will post its answer when it
 * finishes, so a person who stops a report still receives the report. From their side the escape
 * hatch did not work.
 *
 * A RUNNING LAMBDA CANNOT BE SIGNALED, so the turn asks instead, once, immediately before it
 * delivers. That is the only instant where the answer is still suppressible and the cost is a single
 * keyed read on a path where the person has already waited seconds.
 *
 * IT IS A COMPARISON OF TWO RECORDED INSTANTS, NEVER A TIMEOUT. The stop records when it happened;
 * the turn knows when it began; a stop is this turn's if it arrived after the turn started. No clock
 * arbitrates and no duration is guessed, which is the same rule tenet 2 applies to the lock itself.
 *
 * CHANNEL-WIDE, because `/stop` is. It cancels the work in this conversation rather than one
 * assistant's, so the marker is keyed on the conversation and every responder in it sees the same
 * answer.
 *
 * GATED ON THE TABLE, NOT ON THE QUEUE FLAG. Suppressing an answer somebody asked to stop is not part
 * of the queueing behavior and should not wait for it: the two are independent, and coupling them
 * would leave the escape hatch broken on every deployment that has not opted into queueing.
 */

/** True when the stop marker can be read and written. Independent of `TURN_QUEUE_ENABLED`. */
export function turnStopEnabled(): boolean {
  return !!TABLE;
}

/**
 * The stop marker's key: one per conversation, PER PERSON, PER RESPONDER.
 *
 * SCOPED TO WHO ASKED, and the first version was not. A conversation-wide marker meant Alice typing
 * `/stop` suppressed the answer Bob was still waiting for - she cancelled his work by using an escape
 * hatch meant for her own. The task cancellation beside it already had this right:
 * `cancelActiveTasksInChannel` takes the requester and cancels only their tasks. The two halves of
 * one command disagreed about scope, and the quieter half was the wrong one.
 *
 * AND SCOPED TO THE ASSISTANT IT WAS AIMED AT, which the second version was not either. A room can
 * hold several assistants, each with its own queue and its own turn in flight (the turn lock beside
 * this is already keyed that way). A marker without the responder means "stop" aimed at the one
 * writing a report also suppresses the one halfway through an unrelated lookup, and the person who
 * sent it was watching only one of them. Channel-wide is not a safer default: it destroys work nobody
 * asked to lose, in a room where the person cannot see what else was running.
 *
 * The earlier note here said naming an assistant "needs a syntax nobody has chosen". ADR-033 chooses
 * it: an addressed stop names its assistant, an unaddressed stop in a room with exactly one means
 * that one, and an unaddressed stop in a room with several is asked about rather than guessed. The
 * resolution is a lookup rather than a judgement, so it stays on the deterministic path
 * (`lib/stop-target.ts`).
 *
 * THE KEY CHANGED SHAPE, and the transition is safe by construction. A marker written by an older
 * router is simply not found by a newer reader, and not-found is this module's fail-open answer:
 * the answer is delivered. That is the same direction an unreadable marker already takes, it lasts
 * only as long as one deploy overlap, and the durable half of a stop is the task records rather
 * than this.
 */
function stopKey(channelArn: string, bySub: string, responderId: string): string {
  return `stop#${channelArn}#${bySub}#${responderId}`;
}

/**
 * HOW LONG A STOP MARKER IS KEPT: until no turn it can apply to is still running.
 *
 * A marker counts only for a turn that began BEFORE it (`wasStoppedSince` compares the two instants),
 * so once every invocation that was running at the stop has ended, the marker can change no answer.
 * No invocation outlives `STALE_AFTER_MS`, the bound this module already treats as "past any possible
 * turn", so the marker expires that long after it was written, through the table's TTL (`ttl`, epoch
 * seconds). DynamoDB removes an expired item some time after it expires; a marker still present is read
 * the same way, and a marker already gone reads as no stop, which is this module's fail-open answer.
 *
 * Only the stop marker carries `ttl`. The turn lock and its queue carry none, because their release is
 * a recorded fact, never a clock (above).
 */
export const STOP_MARKER_TTL_SECONDS = Math.ceil(STALE_AFTER_MS / 1000);

/** The `ttl` a stop marker written at `nowMs` carries, in epoch seconds. */
export function stopMarkerExpiry(nowMs: number): number {
  return Math.floor(nowMs / 1000) + STOP_MARKER_TTL_SECONDS;
}

/**
 * Record that somebody stopped the work here.
 *
 * Best effort, and it does NOT gate the cancellation that accompanies it: the task records are the
 * durable half and must be cancelled whether or not this write lands. A failure here costs the
 * suppression of one in-flight answer, not the stop itself.
 */
export async function recordStop(channelArn: string, bySub: string, responderId: string): Promise<void> {
  // NO RESPONDER MEANS NO MARKER. Writing one without the assistant it is aimed at would be the
  // channel-wide marker this key exists to retire, arriving through a missing argument instead of a
  // deliberate choice. The task cancellation beside this still runs, so the stop is not lost.
  if (!turnStopEnabled() || !channelArn || !bySub || !responderId) return;
  try {
    const now = Date.now();
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: stopKey(channelArn, bySub, responderId) },
      UpdateExpression: 'SET stoppedAt = :now, #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': now, ':ttl': stopMarkerExpiry(now) },
    }));
  } catch (err: any) {
    console.warn('[turn-lock] stop marker write failed; an in-flight answer may still land:', err?.message);
  }
}

/**
 * Was this turn stopped while it ran?
 *
 * FAILS OPEN INTO DELIVERING. An unreadable marker means the answer is posted, which is the same
 * direction every other claim in this module takes: a table hiccup must not start swallowing answers
 * people are waiting for. The cost of being wrong that way is an answer somebody asked to stop; the
 * cost of the other way is silence, and silence is the failure this codebase treats as worse.
 */
export async function wasStoppedSince(
  channelArn: string,
  turnStartedAtMs: number,
  requesterSub: string,
  responderId: string,
): Promise<boolean> {
  // NO REQUESTER MEANS NO SUPPRESSION. A turn nobody asked for - a rebuttal, a repaired dispatch -
  // has no person whose stop could apply to it, and inventing an owner is how one person's escape
  // hatch reaches another person's answer.
  //
  // NO RESPONDER MEANS NO SUPPRESSION EITHER, for the same reason read from the other side: a turn
  // that cannot say which assistant it belongs to cannot be the one a targeted stop named, and
  // guessing would suppress an answer the stop was not aimed at.
  if (!turnStopEnabled() || !channelArn || !turnStartedAtMs || !requesterSub || !responderId) return false;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { pk: stopKey(channelArn, requesterSub, responderId) },
    }));
    const stoppedAt = res.Item?.stoppedAt as number | undefined;
    return typeof stoppedAt === 'number' && stoppedAt > turnStartedAtMs;
  } catch (err: any) {
    console.warn('[turn-lock] stop marker read failed (fail-open, delivering):', err?.message);
    return false;
  }
}

/**
 * ── TRIAGE HAS ITS OWN CLAIM, AND IT IS NOT THE TURN LOCK (ADR-033) ─────────────────────────────
 *
 * Moving triage to message ARRIVAL looked blocked on the lock, and the blocker dissolves once the two
 * questions are separated.
 *
 * THE TURN LOCK ANSWERS "WHO MAY ANSWER". While triage runs, the turn it is triaging behind is still
 * running and still holds it, which is correct and needs no change. Triage does not answer anything:
 * it reads the queue, creates tasks, and posts a proposal. It never needed that lock, and handing it
 * over was an artefact of triage running at turn COMPLETION, where releasing and re-claiming would
 * have left a gap.
 *
 * THIS ANSWERS "WHO MAY READ THE QUEUE", which is a different and much weaker question. It excludes
 * triage from itself - two messages arriving together must not both triage the same queue and create
 * the work twice - and nothing else.
 *
 * ── WHICH IS WHY A STRANDED ONE IS HARMLESS ─────────────────────────────────────────────────────
 *
 * The turn lock may never be freed by a clock, because a stranded one silences a conversation: tenet
 * 2 exists for that. A stranded TRIAGE claim silences nothing. Answering is unaffected, the queue
 * keeps its messages, and the next arrival triages them. So this one MAY expire on a short TTL, and
 * the short TTL is safe precisely because the thing it guards is recoverable.
 *
 * That asymmetry is the whole resolution: the lock that must never be timed out is not the lock
 * triage needs.
 */

/** Short, because a stranded triage claim costs a delay rather than silence. Minutes, not hours. */
const TRIAGE_CLAIM_TTL_SECONDS = 300;

/** Claim the right to read this conversation's queue. False when somebody else already holds it. */
export async function claimTriage(args: {
  channelArn: string;
  responderId: string;
  by: string;
}): Promise<boolean> {
  if (!turnQueueEnabled()) return false;
  const { channelArn, responderId, by } = args;
  if (!channelArn || !responderId || !by) return false;
  const nowMs = Date.now();
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'SET triagedBy = :me, triageAt = :now',
      // Free when nobody holds it, when this run already does, or when the previous claim is past its
      // own short expiry. The expiry is read HERE rather than left to DynamoDB's TTL sweep, which is
      // best-effort and can lag by hours - long enough to look like a permanent stall.
      ConditionExpression:
        'attribute_not_exists(triagedBy) OR triagedBy = :me OR triageAt < :stale',
      ExpressionAttributeValues: {
        ':me': by,
        ':now': nowMs,
        ':stale': nowMs - TRIAGE_CLAIM_TTL_SECONDS * 1000,
      },
    }));
    return true;
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      // FAILS CLOSED, unlike the turn lock. A claim that cannot be written must not become a second
      // triage run: duplicate work items are visible to the person and have to be closed by hand,
      // whereas not triaging yet costs a delay the next arrival ends.
      console.warn('[turn-lock] triage claim failed; leaving the queue for the next arrival:', err?.message);
    }
    return false;
  }
}

/** Release the triage claim. Conditional, so a run displaced as stale cannot clear its successor's. */
export async function releaseTriage(args: {
  channelArn: string;
  responderId: string;
  by: string;
}): Promise<void> {
  if (!turnQueueEnabled()) return;
  const { channelArn, responderId, by } = args;
  if (!channelArn || !responderId || !by) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'REMOVE triagedBy, triageAt',
      ConditionExpression: 'triagedBy = :me',
      ExpressionAttributeValues: { ':me': by },
    }));
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] triage release failed; it will expire:', err?.message);
    }
  }
}

/**
 * OPEN THE DRAIN'S TASK, OR FIND THE ONE ALREADY OPEN (maintainer, 2026-09-03).
 *
 * Working a queue is a task: it has states, legal moves between them, a step that awaits a person,
 * and a point at which it is over. What it needed and did not have was an IDENTITY that survives a
 * handover, because a chain of readings is one reading that took more than one turn. A correlation
 * id cannot be that identity - it changes per link, by design, so that a re-read is not swallowed as
 * a duplicate delivery. So the identity is carried here, on the record the whole chain shares.
 *
 * ONE PER QUEUE, NOT PER PASS. The drain is claimed by conditional write, so of two readings racing to
 * open a drain exactly one creates the row and the other is TOLD THE WINNER'S ID rather than being
 * refused. That distinction is the whole point: a loser that only learned "no" would either open a
 * second task or work an unrecorded drain, and both are the thing this prevents.
 *
 * The caller creates the task row only when `created` comes back true, so a lost race leaves no
 * orphan. That ordering means a crash between this write and the create can leave an id pointing at
 * nothing, which costs the drain its record for as long as the queue lasts - the cheaper failure by a
 * wide margin, and the queue itself is unaffected either way.
 *
 * BEST EFFORT. A drain that cannot record its task still drains: this returns no id, and the caller
 * carries on without one. The queue is the work; the task is how the work is seen.
 */
export async function claimDrainTask(args: {
  channelArn: string;
  responderId: string;
  /** The id to use if this reading is the one that opens it. */
  taskId: string;
}): Promise<{ taskId: string; created: boolean }> {
  const none = { taskId: '', created: false };
  if (!turnQueueEnabled()) return none;
  const { channelArn, responderId, taskId } = args;
  if (!channelArn || !responderId || !taskId) return none;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'SET drainTaskId = :id',
      ConditionExpression: 'attribute_not_exists(drainTaskId)',
      ExpressionAttributeValues: { ':id': taskId },
      // THE LOSER LEARNS THE WINNER'S ID FROM THE REFUSAL ITSELF, in the same round trip. Reading it
      // afterwards instead would be a second race: the id can be removed by a clear between the
      // refusal and the read, and the caller would then open a task for a drain that is over.
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    }));
    return { taskId, created: true };
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      const held = err?.Item?.drainTaskId?.S || err?.Item?.drainTaskId;
      return held ? { taskId: String(held), created: false } : none;
    }
    console.warn('[turn-lock] could not record the drain task; the drain runs untracked:', err?.message);
    return none;
  }
}

/**
 * NAME THE MESSAGE THE RUNNING TURN IS ANSWERING, so a reading can say what the work in flight IS.
 *
 * A drain decides, for each queued message, whether it AMENDS the work already running. It was told
 * that work was "the work already in progress" - a literal phrase, identical for every turn - so the
 * model was asked whether "actually, keep it to one page" amends something it had been given no
 * description of. It cannot, and corrections were classified as new work: the person's amendment
 * became a second item, answered after the thing it was meant to change.
 *
 * WRITTEN AFTER THE CLAIM, NEVER AS PART OF IT. Resolving the id needs a Chime read, and the claim is
 * on the critical path of every turn in the deployment. The drain reads this seconds later, once a
 * queue has formed, so a write that lands slightly after the claim is in time - and one that never
 * lands costs a description, not a turn.
 *
 * THE ID, NOT THE TEXT, for the reason the queue itself holds ids: this record is shared state, and
 * the drain resolves the content when it needs it.
 *
 * CONDITIONAL ON STILL BEING THE HOLDER, so a turn displaced as stale cannot label its successor's
 * work with its own.
 */
export async function rememberHolderMessage(args: {
  channelArn: string;
  responderId: string;
  correlationId: string;
  messageId: string;
}): Promise<void> {
  if (!turnQueueEnabled()) return;
  const { channelArn, responderId, correlationId, messageId } = args;
  if (!channelArn || !responderId || !correlationId || !messageId) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: lockKey(channelArn, responderId) },
      UpdateExpression: 'SET holderMessageId = :mid',
      ConditionExpression: 'holder = :me',
      ExpressionAttributeValues: { ':mid': messageId, ':me': correlationId },
    }));
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('[turn-lock] could not record what this turn is answering:', err?.message);
    }
  }
}

/**
 * A TURN THAT NEVER STARTED, RECORDED FOR THE PERSON IT HAPPENED TO.
 *
 * WHY THIS EXISTS INSTEAD OF A MESSAGE. The channel flow used to post these as the ASSISTANT: "I
 * could not reach my router". Three things were wrong with that and only the third is about IAM.
 *
 *   1. It attributes an INFRASTRUCTURE failure to the assistant, in a PERSISTENT message. It lands in
 *      the archive as assistant turn content, so a transcript reads as though the assistant said it.
 *   2. It shows the whole room a failure that happened to ONE person. A channel message cannot be
 *      scoped without a `Target`, and these paths have no target.
 *   3. It is the last reason the flow needs to bear a bot identity at all. The flow is one function
 *      for the WHOLE deployment, so its bearer grant spans every classification - the widest in the
 *      system. Removing the reason is what lets the grant be deleted rather than narrowed.
 *
 * SO THE FAILURE IS STATE, AND THE CLIENT RENDERS IT. The server records a reason CODE and never
 * prose: the turn-state API's contract is "ids and flags; never content", and the copy a person reads
 * has to carry their language (tenets P5 and D11), which only the client can do.
 *
 * THE MESSAGE IS NOT DENIED, which is the other way this could have gone and is refused elsewhere in
 * this codebase for a good reason: denying deletes a person's words from their own conversation. The
 * message stays; only the answer is missing, and the client says so.
 *
 * SCOPED PER PERSON AND PER RESPONDER, the same shape as the stop marker beside it and for the same
 * reason: a room can hold several assistants, and a failure to reach one is not a failure of another,
 * nor is it another member's error to see.
 */
export type DispatchFailureReason =
  /** No assistant could be resolved for this conversation, so nothing was dispatched. */
  | 'assistant_unreachable'
  /** The router was reached and the handoff did not complete. */
  | 'handoff_failed'
  /** The turn ran and its answer could not be delivered. */
  | 'reply_undeliverable';

/**
 * How long a recorded failure is worth showing. THE TABLE HAS NO TTL, deliberately (a drain holds a
 * record across however long a person takes to answer), so this ages at READ rather than by expiry -
 * the same way `wasStoppedSince` compares a timestamp rather than trusting the record's presence.
 * Long enough that a person who looks away and comes back still learns why nothing happened; short
 * enough that yesterday's outage is not reported as today's silence.
 */
const DISPATCH_FAILURE_FRESH_MS = 10 * 60 * 1000;

function dispatchFailureKey(channelArn: string, bySub: string, responderId: string): string {
  return `dispatchfail#${channelArn}#${bySub}#${responderId}`;
}

/** Record that this person's turn could not be dispatched. Never throws: the turn already failed. */
export async function recordDispatchFailure(args: {
  channelArn: string;
  senderSub: string;
  responderId: string;
  reason: DispatchFailureReason;
}): Promise<boolean> {
  // The table, not the queue flag - the rule `rememberStopDecision` states, for the same reason:
  // telling somebody their turn never ran is not part of queueing.
  if (!turnStopEnabled()) return false;
  const { channelArn, senderSub, responderId, reason } = args;
  if (!channelArn || !senderSub || !responderId) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: dispatchFailureKey(channelArn, senderSub, responderId) },
      UpdateExpression: 'SET reason = :r, failedAt = :a',
      ExpressionAttributeValues: { ':r': reason, ':a': new Date().toISOString() },
    }));
    return true;
  } catch (err: any) {
    console.warn('[turn-lock] could not record the dispatch failure:', err?.message);
    return false;
  }
}

/** The failure this person is owed an explanation for, if it is recent enough to still mean anything. */
export async function readDispatchFailure(args: {
  channelArn: string;
  senderSub: string;
  responderId: string;
  now?: number;
}): Promise<{ reason: DispatchFailureReason; failedAt: string } | undefined> {
  if (!turnStopEnabled()) return undefined;
  const { channelArn, senderSub, responderId } = args;
  if (!channelArn || !senderSub || !responderId) return undefined;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: dispatchFailureKey(channelArn, senderSub, responderId) },
    }));
    const item = res.Item as { reason?: DispatchFailureReason; failedAt?: string } | undefined;
    if (!item?.reason || !item.failedAt) return undefined;
    const age = (args.now ?? Date.now()) - Date.parse(item.failedAt);
    if (!Number.isFinite(age) || age > DISPATCH_FAILURE_FRESH_MS) return undefined;
    return { reason: item.reason, failedAt: item.failedAt };
  } catch (err: any) {
    console.warn('[turn-lock] could not read the dispatch failure:', err?.message);
    return undefined;
  }
}

/**
 * Forget the failure. Called when a turn for this person DOES get dispatched, so a later success
 * clears an earlier failure rather than leaving the client reporting an error that has been overtaken.
 */
export async function clearDispatchFailure(args: {
  channelArn: string;
  senderSub: string;
  responderId: string;
}): Promise<void> {
  if (!turnStopEnabled()) return;
  const { channelArn, senderSub, responderId } = args;
  if (!channelArn || !senderSub || !responderId) return;
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: dispatchFailureKey(channelArn, senderSub, responderId) },
    }));
  } catch (err: any) {
    console.warn('[turn-lock] could not clear the dispatch failure:', err?.message);
  }
}
