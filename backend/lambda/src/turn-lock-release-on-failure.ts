/**
 * THE TURN THAT NEVER CAME BACK, REPORTED AS AN EVENT (ADR-033).
 *
 * A turn releases its lock in a `finally`, so every ordinary ending is covered: the answer posted,
 * an early return, an error the processor caught itself. Exactly one ending is not, because no code
 * in that process runs for it - the platform killing the invocation outright on timeout or out of
 * memory.
 *
 * That ending is not silent, though. The processor is invoked ASYNCHRONOUSLY, and an asynchronous
 * invocation that fails after its retries emits a failure record naming the invocation and carrying
 * the request payload that started it. That is the event, and this is the thing that listens for it.
 *
 * ── WHY THIS EXISTS AT ALL, RATHER THAN A TIMEOUT ────────────────────────────────────────────────
 *
 * The lock used to be recovered by reading `readPlaceholderMapping` and treating a recorded mapping
 * as proof the holder had finished. It is not: that record is written when the PLACEHOLDER appears,
 * seconds into the turn, so every RUNNING turn looked finished, every later message displaced the
 * live holder, and nothing ever queued.
 *
 * The obvious repair is to ask how long the holder has been holding and call it dead past some
 * bound. That is a clock, and this design refuses clocks for a reason worth restating: too short and
 * it displaces a legitimately slow turn, which answers the person twice; too long and a conversation
 * stays unanswerable for the length of the timeout. Both are guesses about a fact the platform will
 * simply tell us. So the lock is released by something that HAPPENED, in both directions: the turn
 * ended, or the invocation running it failed.
 *
 * ── IT RETRIES FIRST, BECAUSE SILENCE IS NOT AN ACCEPTABLE OUTCOME ───────────────────────────────
 *
 * Releasing the lock and stopping there is a tidier silence, not a recovery: the person sent a
 * message, nothing came back, and they would have to send ANOTHER one before anything happened.
 * Freeing the conversation is what the NEXT person needs; answering is what THIS one needs.
 *
 * So the turn is re-dispatched, to the same function with the same payload. The failure record
 * carries both, and by the time it arrives the transient conditions that killed the invocation - a
 * downstream throttle, a cold dependency, a memory spike on one container - have usually passed.
 * The lock is deliberately NOT released on this path: the retry is the same correlation, so it still
 * holds the conversation, and one turn at a time still holds.
 *
 * BOUNDED, and the bound is small. Lambda's async invoke retries twice (its default; the processor
 * sets no `retryAttempts`) before this record exists, so each dispatch has already run up to three
 * invocations. `TURN_MAX_ATTEMPTS` (default 2) counts DISPATCHES, so by default the turn is
 * re-dispatched once, for one more shot at a transient; more is a loop. When the bound is spent the lock is released AND the person is told - the one
 * thing that must never happen is that they are left with nothing at all.
 */

import { principalIdFromArn } from './lib/task-tracking.js';
import { releaseLock } from './lib/turn-lock.js';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { loadProfileRegistry } from '../../lib/profile-registry';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const lambdaClient = new LambdaClient({ region: AWS_REGION });

/**
 * THE ONE PROCESSOR THIS INSTANCE RECOVERS, from configuration rather than from the record.
 *
 * The failure record names the function that died, and taking the target from there made this a
 * deputy that would invoke whatever it was told to. Destination records carry no signature, so a
 * hand-made one is indistinguishable from a real one - and every processor holds invoke on this
 * function, because that is what wiring it as a destination grants. One hop then reached ANY
 * classification with a fully chosen payload, which is exactly the boundary the rest of this
 * codebase spends its IAM enforcing.
 *
 * So the target is configuration, this function is deployed PER CLASSIFICATION, and its grant names
 * that one processor. A record naming anything else is refused below rather than acted on.
 */
const RETRY_TARGET_ARN = process.env.RETRY_TARGET_ARN || '';

/**
 * How many dispatches one turn may have, the original included: the handler re-dispatches while
 * `turnAttempt` (1 on the original) is below this, so the default of 2 allows one re-dispatch.
 *
 * SMALL ON PURPOSE. Lambda retries an async invoke twice before a failure record exists at all, so a
 * dispatch reaching here has already run up to three invocations. One more dispatch buys the thing
 * those did not have - elapsed time, in which a throttle clears or a cold dependency warms. Beyond
 * that it is a loop that keeps a conversation locked while it spins.
 */
const MAX_TURN_ATTEMPTS = Math.max(1, Number(process.env.TURN_MAX_ATTEMPTS || '2') || 2);

/**
 * The shape Lambda sends to an `onFailure` destination. Only `requestPayload` matters here - it is
 * the event the processor was given, so it carries the three things that identify the lock.
 */
interface AsyncFailureRecord {
  requestContext?: {
    condition?: string;
    approximateInvokeCount?: number;
    requestId?: string;
    /** The function that failed. Retrying is re-invoking exactly this, with exactly the payload below. */
    functionArn?: string;
  };
  requestPayload?: Record<string, unknown> & { channelArn?: string; botArn?: string; correlationId?: string; turnAttempt?: number };
}

export const handler = async (event: AsyncFailureRecord): Promise<void> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const payload = event?.requestPayload || {};
  const { channelArn, botArn, correlationId } = payload;

  // Nothing to release, and nothing to raise: a malformed record is not a conversation waiting on
  // an answer, and throwing here only re-queues this same record.
  if (!channelArn || !botArn || !correlationId) {
    console.warn('[turn-lock-release] failure record carried no lock to release', {
      condition: event?.requestContext?.condition,
      hasChannel: !!channelArn, hasBot: !!botArn, hasCorrelation: !!correlationId,
    });
    return;
  }

  const responderId = principalIdFromArn(botArn);
  const attempt = typeof payload.turnAttempt === 'number' ? payload.turnAttempt : 1;
  // THE RECORD IS EVIDENCE, NOT INSTRUCTION. It is checked against the configured target rather than
  // obeyed: a record naming another function is either a misrouted destination or a forged one, and
  // neither is a thing to act on.
  // THE BOUND IS IAM, NOT THIS LINE. This function is deployed per classification and its only
  // invoke permission is a resource policy on the ONE processor it serves, so a record naming any
  // other function is refused by Lambda rather than by a check here - which is where this codebase
  // keeps boundaries: denied at IAM rather than refused in code.
  //
  // `RETRY_TARGET_ARN` stays supported as a belt-and-braces equality check for a deployment that
  // wants to state the target explicitly; unset, the record names it and IAM decides.
  const named = event?.requestContext?.functionArn;
  const functionArn = RETRY_TARGET_ARN
    ? (named && named !== RETRY_TARGET_ARN ? undefined : RETRY_TARGET_ARN)
    : named;
  if (named && RETRY_TARGET_ARN && named !== RETRY_TARGET_ARN) {
    console.error('[turn-recovery][SecurityEvent] a failure record named a function this instance does not serve', {
      named, serves: RETRY_TARGET_ARN, channelArn, correlationId,
    });
  }

  // ── RETRY, AND KEEP THE LOCK WHILE DOING IT ──────────────────────────────────────────────────
  //
  // The retry runs as the SAME correlation, so it still holds the conversation and one turn at a
  // time is preserved. Releasing first and re-dispatching after would open a window in which an
  // arriving message could claim the turn and answer alongside the retry.
  // NOT FOR AN ANNOUNCEMENT. The payload says whether the turn that died was the apology (see below).
  // An apology dispatched after a retry could not be sent still carries an unspent `turnAttempt`, so
  // without this its own failure came back here and was RE-DISPATCHED: a second apology, and the lock
  // held for another round, which is the loop the guard below exists to end.
  const announcementFailed = (payload as { announceFailure?: unknown }).announceFailure === true;
  if (attempt < MAX_TURN_ATTEMPTS && functionArn && !announcementFailed) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: InvocationType.Event,
        Payload: Buffer.from(JSON.stringify({ ...payload, turnAttempt: attempt + 1 })),
      }));
      console.log('[turn-recovery] re-dispatched a turn that died', {
        channelArn, responderId, correlationId, attempt: attempt + 1,
        condition: event?.requestContext?.condition,
      });
      return;
    } catch (err) {
      // The retry could not even be dispatched. Fall through and finish honestly rather than
      // leaving the conversation held by a turn nothing is running.
      console.error('[turn-recovery] could not re-dispatch; giving up', {
        channelArn, correlationId, message: (err as Error)?.message,
      });
    }
  }

  // ── SPENT. ASK THE ASSISTANT TO SAY SO ───────────────────────────────────────────────────────
  //
  // Not said from here. Messages in a conversation come from ASSISTANTS - a shared recovery
  // function speaking into any room would need channel-send across every classification, a boundary
  // widened for one apology, and the line would carry none of that deployment's configured voice or
  // language.
  //
  // So the assistant is invoked once more with `announceFailure`, which is the cheapest path it has:
  // no model call, no tools, no retrieval. It runs once the expensive path has spent `TURN_MAX_ATTEMPTS` dispatches (or a re-dispatch could not be sent) and is
  // meant to succeed where that did not. It releases the lock in its own `finally`, the same as any
  // other ending.
  // AND THE ANNOUNCEMENT IS NOT ANNOUNCED AGAIN.
  //
  // This invoke carries the SAME failure destination as the turn it is apologising for, so when the
  // announcement itself dies its record arrives back here - and `turnAttempt` was never bumped for
  // it, so the retry branch above is still spent and this branch fires again. A payload the
  // processor reliably dies on therefore looped: record, give up, announce, die, record, forever.
  // Every pass `return`s before the release below, so the conversation stayed locked for the whole
  // loop - the exact stranding this function exists to end, produced by it.
  //
  // The failing payload says which one it was. If it was already the announcement, the cheapest
  // path the assistant has is also failing, and there is nothing left to try: stop asking and
  // release the lock, which is what the person needs most.
  if (announcementFailed) {
    console.error('[turn-recovery] the failure announcement itself failed; releasing without another', {
      channelArn, responderId, correlationId,
    });
  }

  if (functionArn && !announcementFailed) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: InvocationType.Event,
        // DECLARED, like every other dispatch here. An undeclared trigger reads as `user`, which
        // would count a machine-driven apology in the human-waiting population under a person's own
        // message - the same attribution bug the handover and repair kinds were added to prevent.
        Payload: Buffer.from(JSON.stringify({ ...payload, announceFailure: true, trigger: 'recovery' })),
      }));
      console.log('[turn-recovery] asked the assistant to report a failed turn', {
        channelArn, responderId, correlationId, attempts: attempt,
      });
      return;
    } catch (err) {
      console.error('[turn-recovery] could not ask the assistant to report; releasing anyway', {
        channelArn, correlationId, message: (err as Error)?.message,
      });
    }
  }

  // LAST RESORT, and it is silent by necessity rather than by choice: nothing here can speak. A
  // conversation held forever is worse than one that went quiet, and the person can still send again.
  const released = await releaseLock({ channelArn, responderId, correlationId }).catch((err) => {
    console.warn('[turn-lock-release] release threw', { correlationId, message: err?.message });
    return false;
  });

  // `false` is the ordinary outcome when something else already moved the lock on, so it is logged
  // as what happened rather than as a failure.
  console.log('[turn-lock-release] a turn died without releasing', {
    channelArn,
    responderId,
    correlationId,
    condition: event?.requestContext?.condition,
    invocations: event?.requestContext?.approximateInvokeCount,
    released,
  });
};
