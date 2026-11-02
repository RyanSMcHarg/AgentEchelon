/**
 * Correlation-id derivation (SPEC-ABUSE-CONTROLS dedup, ADR-022).
 *
 * A correlation id LABELS A PLACEHOLDER so the async processor can find the message it must update.
 * It is not a message identifier: the placeholder is a different message from the one the user sent,
 * created later by Amazon Chime SDK from the Lex response, so the label has to travel in the
 * placeholder's own content (`<!--corr:{id}-->`).
 *
 * WHY IT IS DERIVED RATHER THAN RANDOM. One user message sometimes produces TWO Lex fulfillments of
 * the same turn. It happens downstream of the channel flow, which has already released the message
 * and cannot gate it. With a random id per fulfillment each attempt mints its own label, so two
 * placeholders appear and two answers land - the duplicate-reply symptom on the normal path. Deriving
 * the id from the turn makes both attempts produce the SAME label, so the processor's dedup claim
 * collapses them and the flow can deny the second placeholder.
 *
 * WHAT CAUSES THE SECOND FULFILLMENT IS NOT ESTABLISHED, and the explanation this file used to give -
 * "Amazon Chime SDK retries a fulfillment that does not answer in time", cited to TROUBLESHOOTING #18b
 * - is wrong twice over. That section is about single-stack deploys and CORS and says nothing about
 * retries, and the timeout story is contradicted by measurement: over 24 hours and 52 turns, ONE
 * duplicated (first attempt 3055ms) while six turns ran longer WITHOUT duplicating, the slowest at
 * 4222ms. There is no latency threshold in the data. The router's own timeout is 30s and the intent
 * configures no fulfillment timeout, so neither bounds it either.
 *
 * What can be said: it is rare, independent of how long the turn took, and not initiated by our code
 * - nothing in this codebase invokes the router; Lex does. That shape is what at-least-once delivery
 * looks like. Confirming the trigger needs Lex conversation logs.
 *
 * ON THE RATE, because this comment carried a wrong one and it traveled. The figure this file used to
 * give was derived from a 52-turn window and counted the E2E RETRY TEST'S OWN PROBES as organic
 * duplicates: 13 of the 14 "duplicate fulfillment" log lines were `Retry probe ...` messages the suite
 * sends deliberately. Over four days of logs the organic rate is roughly **1 turn in 1000**. The
 * 24-hour window above is still the right evidence for "no latency threshold", which is a statement
 * about the SHAPE of the data and does not depend on the rate; it is the frequency claim that was
 * wrong. (`docs-drift-guard` bans the retracted figure, so it is not restated here.)
 *
 * The number matters because it sets the stakes: at 1 in 1000, enabling Lex conversation logs to chase
 * the trigger is a bigger commitment than the defect, which is why enabling them is a decision rather than a
 * fix. A measurement that includes the measurer's own traffic is not a measurement.
 *
 * THE PRACTICAL CONSEQUENCE. Because it is not a timeout, making the handler faster does not reduce
 * it. Idempotency is not a stopgap until the turn is quick enough; it is the whole answer.
 *
 * WHY NOT THE CHIME MESSAGE ID. It never arrives. Measured live across every classification, the Lex
 * request attributes are exactly `CHIME.channel.arn`, `CHIME.sender.arn` and
 * `x-amz-lex:channels:platform`; `CHIME.message.id` is not among them, which is also why
 * `resolveOriginatingMessageId` reads it back from the channel instead.
 */
import { createHash } from 'crypto';

/**
 * How long two identical turns are treated as the same turn.
 *
 * Sized for a RETRY, not for a conversation. A fulfillment retry lands within seconds, so a short
 * window catches it; the cost of a long one is that a user who deliberately sends byte-identical text
 * twice gets one answer instead of two. Ninety seconds covers the retry of a handler that ran to its
 * 30s timeout, with margin, and is short enough that a deliberate repeat is unaffected in practice.
 */
export const TURN_CORRELATION_WINDOW_SECONDS = 90;

/**
 * The correlation id for one assistant turn on the Lex path.
 *
 * Stable across a retried fulfillment of the same turn, distinct between turns. The time bucket bounds
 * how long two identical turns collide; it is quantised so a retry seconds later lands in the same
 * bucket, and `previousBucket` lets a caller check the adjacent one so a retry that straddles a
 * boundary is still recognized.
 *
 * EVERY INPUT IS ONE A RETRY PROVABLY REPLAYS, which is the property the whole control rests on. The
 * channel and sender arrive as request attributes of the same message. The transcript is replayed
 * verbatim: confirmed on a live duplicate (two fulfillments 2.6s apart, byte-identical transcript).
 *
 * The Lex `sessionId` is deliberately NOT an input. It would add no discrimination - the session is
 * per channel and user, both of which are already hashed here, so two turns that share those share the
 * session too. What it would add is a dependency on Amazon Chime SDK replaying the same session on a
 * retry, which is not documented and was never measured. An input that separates nothing and can only
 * fail is a liability: if it varied, every derived id would differ and this control would silently do
 * nothing, with no signal that it had stopped working.
 *
 * Sixteen hex characters, matching `deriveBattleId`. The id travels inside the placeholder's content,
 * so it is charged against the 4KB Amazon Chime SDK message limit and is worth keeping short; 64 bits
 * separates turns inside a 90 second window with room to spare.
 */
export function turnCorrelationId(args: {
  channelArn: string;
  senderArn: string;
  userMessage: string;
  /** Epoch milliseconds. Injected so the derivation is testable. */
  nowMs?: number;
  /** Derive against the previous window instead of the current one. */
  previousBucket?: boolean;
}): string {
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  let bucket = Math.floor(nowSec / TURN_CORRELATION_WINDOW_SECONDS);
  if (args.previousBucket) bucket -= 1;
  return createHash('sha256')
    .update([args.channelArn, args.senderArn, args.userMessage, String(bucket)].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * THE bound on a correlation id, and the only place it is stated in TypeScript.
 *
 * It is a READER'S limit that every WRITER has to respect, and nothing connected the two: the marker
 * is built by string interpolation at seven call sites, none of which knew this number existed. An id
 * longer than this is not rejected anywhere - it is posted, and then silently cannot be read back, so
 * the placeholder carrying it can never be matched to its answer.
 *
 * The SQL readers (`turn-events-backfill.ts`, `analytics-query.ts`) embed the same pattern as a
 * literal because a parameterised regex would defeat the query plan. `correlation-id-is-readable.test.ts`
 * asserts every copy still matches this one, so the four definitions cannot drift apart.
 */
export const CORRELATION_ID_MAX_LENGTH = 64;

/** `<!--corr:{id}-->`. Bounded and character-classed so a crafted marker cannot smuggle a key. */
const CORR_MARKER = new RegExp(`<!--corr:([A-Za-z0-9._-]{1,${CORRELATION_ID_MAX_LENGTH}})-->`);

/**
 * Can this id survive the round trip? A writer asks BEFORE posting; the answer is the reader's, not a
 * second opinion, because it runs the reader's own pattern.
 */
export function isReadableCorrelationId(id: string): boolean {
  return correlationMarkerOf(`<!--corr:${id}-->`) === id;
}

/**
 * Fit an arbitrary suffix into what a correlation id may carry.
 *
 * Battle ids embed a bot ARN's last segment, which is service-assigned and unbounded from our side.
 * Truncation keeps the TAIL rather than the head: the discriminating bytes of an opaque id are at the
 * end, and two bots in one channel differing only in a prefix would otherwise collapse to one id.
 */
function fitSegment(value: string, budget: number): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '');
  return safe.length <= budget ? safe : safe.slice(safe.length - budget);
}

/**
 * The correlation id for a battle round's placeholder.
 *
 * Extracted from three call sites that each wrote the same template inline
 * (`battle-orchestrator.ts`, and twice in `channel-flow-processor.ts`). Inline, each was free to
 * exceed the reader's bound, and all three did whenever the bot ARN's last segment was long: the
 * fixed part is 31 characters, so any segment of 34 or more overflowed 64 and produced a placeholder
 * that could never close. Every test fixture used a short bot name, so nothing caught it.
 */
export function battleCorrelationId(args: {
  botArn: string;
  /** `r1`, `r1c` or `r2`. */
  round: string;
  nowMs?: number;
  /** Injected so the derivation is testable. */
  suffix?: string;
}): string {
  const prefix = `battle-${args.round}-`;
  const stamp = `-${args.nowMs ?? Date.now()}-${args.suffix ?? Math.random().toString(36).slice(2, 8)}`;
  const budget = CORRELATION_ID_MAX_LENGTH - prefix.length - stamp.length;
  return `${prefix}${fitSegment(args.botArn.split('/').pop() ?? '', Math.max(0, budget))}${stamp}`;
}

/**
 * The correlation id a placeholder carries, or null.
 *
 * Amazon Chime SDK message content arrives URL-encoded on the channel-flow event, so the raw form is
 * tried first and the decoded form second. A malformed encoding is not an error here: no marker simply
 * means this is not a placeholder, which is the common case for ordinary bot traffic.
 */
export function correlationMarkerOf(content: string): string | null {
  if (!content) return null;
  const direct = CORR_MARKER.exec(content);
  if (direct) return direct[1];
  try {
    const decoded = decodeURIComponent(content);
    const m = CORR_MARKER.exec(decoded);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * The dedup correlation id for an @all mention turn. Stable and deterministic when the inbound Chime
 * `messageId` is present (so a redelivery reuses it and the processor's claim collapses the duplicate);
 * a unique random id when it is absent (synthetic/test events), so those never wrongly collide.
 *
 * This path can key on the message id directly because the channel flow dispatches it, and the flow
 * DOES receive a stable `MessageId` on every message. The Lex path cannot: see above.
 */
/**
 * The correlation id for a reading dispatched by arrival triage.
 *
 * IT IS ALSO THE TRIAGE CLAIM, deliberately: arrival triage names its turn by the claim it holds, so
 * the handover can recognize "this turn was the reading" by comparing the two. The depth is part of
 * it so a redelivery of the same notice builds the same id and stays idempotent, while a notice whose
 * depth moved builds a different one and correctly loses to the reading already in flight.
 *
 * FITTED, BECAUSE IT IS ALSO A PLACEHOLDER MARKER AND WAS OVERFLOWING IT (maintainer, 2026-09-02). Built
 * inline this read `arrival-${MessageId}-${depth}`, and an Amazon Chime SDK message id is opaque and
 * commonly 64 characters, which made the id 74 - ten over what a reader accepts. The consequences
 * were invisible because everything still worked, slowly:
 *
 *   - `channel-flow-processor.ts` reads the marker to write the placeholder mapping. It never
 *     matched, so no mapping was ever written for a triage turn.
 *   - the processor therefore polled for a mapping that could not arrive, eight attempts with
 *     backoff, MEASURED LIVE AT 6.9 SECONDS, on a path section 7.4 budgets at 1.5 to 4 seconds
 *     end to end.
 *   - it then fell back to a billed `ListChannelMessages` scan.
 *   - and the duplicate-placeholder denial in that same branch never ran for a triage turn either.
 *
 * This is the identical defect `mentionCorrelationId` and `battleCorrelationId` were already fixed
 * for. The arrival id is the one that never got the treatment, which is why it is here now rather
 * than interpolated at the call site: a bound nothing enforces is a bound every new call site breaks.
 *
 * The DEPTH is what gets the remaining budget, never truncated, because it is what separates one
 * notice from the next. The message id keeps its tail, where an opaque id's discriminating bytes are.
 */
export function arrivalTriageCorrelationId(args: {
  messageId?: string;
  /** Used only when there is no message id, and an ARN is long, so it is fitted the same way. */
  channelArn: string;
  depth: number;
}): string {
  const suffix = `-${Math.max(0, Math.floor(args.depth))}`;
  const prefix = 'arrival-';
  const budget = CORRELATION_ID_MAX_LENGTH - prefix.length - suffix.length;
  const source = args.messageId || args.channelArn;
  return `${prefix}${fitSegment(source, Math.max(0, budget))}${suffix}`;
}

/**
 * The correlation id for the reading a finishing turn hands the conversation to.
 *
 * SAME DEFECT AS THE ARRIVAL ID, AND IT COMPOUNDED. Built inline this was
 * `triage-handover-${correlationId}`, so handing over from an arrival reading produced roughly 90
 * characters, and because it re-prefixed the id it was given, a chain of handovers grew by 16
 * characters per link. Every one of them was unreadable as a marker, so every handover reading also
 * paid the mapping poll and the billed scan. Observed live as
 * `triage-handover-arrival-b13ea666...-1`, logging `No placeholder mapping yet`.
 *
 * THE PASS CARRIES THE DISTINCTNESS, not a stacked prefix. Each link increments it, so link 2 and
 * link 3 differ without either being longer, and the id stays derivable from the turn handing over
 * rather than accumulating its history. That also keeps it STABLE: the handover runs once at the end
 * of a turn, and a re-run derives the same id rather than minting a second reader.
 *
 * It must differ from the id it is derived from, because `handOverLock` moves the lock FROM one TO
 * the other and a self-handover is a lock nothing releases. The prefix guarantees that.
 */
export function handoverCorrelationId(correlationId: string, pass: number): string {
  const prefix = `th${Math.max(1, Math.floor(pass))}-`;
  return `${prefix}${fitSegment(correlationId, Math.max(0, CORRELATION_ID_MAX_LENGTH - prefix.length))}`;
}

/**
 * The correlation id for the question a `/stop` asks back.
 *
 * SAME DEFECT AS THE TWO ABOVE, and the last inline one. Written at the call site as
 * `${correlationId}-stopeval`, it inherited whatever it was handed and added nine characters, so a
 * stop aimed at a turn already running under a long id - an arrival reading, or any handover of one -
 * produced a marker past the bound. The placeholder that question posts could then never be matched,
 * which on THIS path means a person who just typed `/stop` is asked which work to stop and never sees
 * the answer resolve.
 *
 * A SUFFIX, unlike its siblings, because the stop is about the turn it names and reads better ending
 * in what it is. `fitSegment` keeps the tail of what it trims, so the discriminating end of the id
 * being stopped survives; only its prefix is spent.
 */
export function stopEvaluationCorrelationId(correlationId: string): string {
  const suffix = '-stopeval';
  return `${fitSegment(correlationId, Math.max(0, CORRELATION_ID_MAX_LENGTH - suffix.length))}${suffix}`;
}
/**
 * THE KEY THE DEDUP GUARD CLAIMS, which is NOT the turn's correlation id (maintainer, 2026-09-02).
 *
 * Two different questions had been sharing one string, and the collision made a bounded loop
 * unable to take its second iteration.
 *
 * CONVERSATION IDENTITY is `correlationId` itself. Arrival triage names its turn by the triage claim
 * it holds, so for a reading turn that id IS `triagedBy`, and `turn-handover.ts` recognizes "this
 * turn was the reading" by comparing the two. It must stay stable across passes: a pass carrying a
 * fresh id is not recognized, falls through to the branch that hands the conversation onward, and
 * hands it to a turn that has already ended - which nothing then releases.
 *
 * DELIVERY IDENTITY is this. The guard asks only "is this the same delivery arriving twice?", which
 * is what at-least-once delivery requires and all it requires. A triage pass 2 is not a redelivery
 * of pass 1; it is the next iteration of the loop DESIGN 2.3 step 3 describes. Keyed on the bare id
 * it was indistinguishable from a duplicate and was dropped every time, so a queue that moved under
 * a reading was never re-read: the drain released the conversation still holding it. Measured live
 * as `reading it again  pass: 2, read: 1, arrived: 2`, then `Duplicate invocation, skipping`, then
 * `releasing now that it is done  stillQueued: 3`.
 *
 * AN AMENDMENT FOLD IS THE OTHER RE-ENTRY, and it is the same defect one path along. When a reading
 * judges that something arriving mid-turn changes the work rather than starting new work,
 * `dispatchAmendedTurn` re-invokes on the SAME correlation id - deliberately, because the placeholder
 * and the lock have to carry over to the answer that replaces them. The router already scopes its
 * duplicate-fulfillment claim to the fold (`deliveryAttemptSuffix`, `#f{n}`), so the fold reaches
 * this side; keyed on the bare id here it was then read as a redelivery of the turn it amends and
 * dropped, with `clearAmendments` already run and the placeholder and lock still held. That is the
 * `bd3444ecd844c285` symptom the router-side fix records, surviving on the half that was not fixed.
 *
 * PASS 1 WITH NO FOLD KEYS ON THE BARE ID, so every turn that is neither a re-read nor a fold - which
 * is all of them outside triage - claims exactly what it claimed before. This adds keys, it does not
 * change any existing one.
 *
 * AND THE RECOVERY RE-ENTERS TWICE MORE, on the same correlation id and for the same reason: the
 * turn keeps its identity so the lock and the placeholder carry over. `turn-lock-release-on-failure`
 * re-invokes the processor with `{...payload, turnAttempt: n+1}` up to three times, and then once
 * with `{...payload, announceFailure: true}`. Every one of those spreads the ORIGINAL correlation id,
 * and the turn that just died had already claimed it. Against a 300s dedup TTL and a 30-90s function
 * timeout the claim is always still held, so keyed on the bare id: every retry was skipped as a
 * duplicate and RETURNED SUCCESS - which is also why Lambda's own async retries never escalated to
 * the failure destination - and the apology, the one path whose whole job is to succeed where the
 * expensive path did not, was skipped too. The person was never told anything had gone wrong.
 *
 * The announcement is a delivery in its own right, not attempt n+1 of the turn: it does different
 * work, and a redelivery of the announcement still has to dedup against the announcement.
 *
 * The suffixes stay inside the reader's character class even though a delivery key never travels in a
 * placeholder marker. It costs nothing, and an id shape that is legal everywhere cannot become a
 * trap for the next caller who does put it somewhere that parses.
 */
export function deliveryCorrelationId(
  correlationId: string,
  triagePass?: number,
  amendedFold?: number,
  recovery?: { turnAttempt?: number; announceFailure?: boolean },
): string {
  // FINITE AND POSITIVE OR ABSENT, on both discriminators. A malformed value must leave the key it
  // would have qualified untouched rather than append a `NaN` segment that no retry can reproduce -
  // a key nothing else ever derives again dedups against nothing.
  const pass = Number.isFinite(Number(triagePass)) && Number(triagePass) > 1
    ? `.p${Math.floor(Number(triagePass))}`
    : '';
  const fold = Number.isFinite(Number(amendedFold)) && Number(amendedFold) > 0
    ? `.f${Math.floor(Number(amendedFold))}`
    : '';
  // Attempt 1 is the ordinary turn and adds nothing, so an instance that never fails keys exactly
  // as it always has.
  const attempt = Number.isFinite(Number(recovery?.turnAttempt)) && Number(recovery?.turnAttempt) > 1
    ? `.a${Math.floor(Number(recovery?.turnAttempt))}`
    : '';
  const announcement = recovery?.announceFailure ? '.fail' : '';
  return `${correlationId}${pass}${fold}${attempt}${announcement}`;
}

export function mentionCorrelationId(messageId?: string): string {
  // The Amazon Chime SDK `MessageId` is opaque and the service permits up to 128 characters, so
  // `mention-${messageId}` could exceed the reader's bound and produce a placeholder that never
  // closes. Fitting it keeps the id stable for a given message, which is the property this path
  // depends on: a redelivery of the SAME message still derives the SAME id.
  if (messageId) return `mention-${fitSegment(messageId, CORRELATION_ID_MAX_LENGTH - 'mention-'.length)}`;
  return `mention-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}
