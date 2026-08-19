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
 * ON THE RATE, because this comment carried a wrong one and it travelled. The figure this file used to
 * give was derived from a 52-turn window and counted the E2E RETRY TEST'S OWN PROBES as organic
 * duplicates: 13 of the 14 "duplicate fulfillment" log lines were `Retry probe ...` messages the suite
 * sends deliberately. Over four days of logs the organic rate is roughly **1 turn in 1000**. The
 * 24-hour window above is still the right evidence for "no latency threshold", which is a statement
 * about the SHAPE of the data and does not depend on the rate; it is the frequency claim that was
 * wrong. (`docs-drift-guard` bans the retracted figure, so it is not restated here.)
 *
 * The number matters because it sets the stakes: at 1 in 1000, enabling Lex conversation logs to chase
 * the trigger is a bigger commitment than the defect, which is why row 30 is a decision rather than a
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
 * boundary is still recognised.
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
export function mentionCorrelationId(messageId?: string): string {
  // The Amazon Chime SDK `MessageId` is opaque and the service permits up to 128 characters, so
  // `mention-${messageId}` could exceed the reader's bound and produce a placeholder that never
  // closes. Fitting it keeps the id stable for a given message, which is the property this path
  // depends on: a redelivery of the SAME message still derives the SAME id.
  if (messageId) return `mention-${fitSegment(messageId, CORRELATION_ID_MAX_LENGTH - 'mention-'.length)}`;
  return `mention-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}
