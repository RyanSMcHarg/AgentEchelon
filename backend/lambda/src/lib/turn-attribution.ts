/**
 * WHAT A TURN CARRIES ON THE ACKNOWLEDGMENT IT CLOSES OUT (ADR-033, owner 2026-09-15).
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────────────────────────
 *
 * A turn that moves delivery to a NEW message - a broadcast answer, a privately targeted answer, or
 * an answer displaced to the end because its placeholder became the queue notice - leaves the
 * ORIGINAL placeholder behind as a receipt. Both exchange pairers take the earliest bot CREATE after
 * the user message from that sender, and the placeholder is always earlier than the message the
 * answer moved to. So the receipt wins the exchange and the answer keeps nothing.
 *
 * Measured through the signed path on 2026-09-15: 220 exchanges, 31 minted against an acknowledgment,
 * 30 of those carrying NO intent. One queued turn recorded a 16.5 second wait that nothing attributed.
 *
 * ── THE ANSWER PAIRS, AND THE RECEIPT KEEPS THE TURN'S FIRST FEEDBACK ──────────
 *
 * Latency is paired from whatever triggered a message to the message itself, so the moved answer is the
 * message that pairs: it declares its own answersMessageId and its own intent on its own update. The
 * close-out declares the receipt's kind (`receipt`, `turn-declaration.ts`) and both pairers skip it.
 *
 * The receipt is still the placeholder, so its post is still the turn's time to first feedback.
 * `v_turn_latency` anchors it on the moved answer's exchange through the target this attribution
 * declares (`anchor_source = declared_target`, migration 080), so the TTFF is kept on the receipt's
 * row while the exchange belongs to the answer.
 *
 * The attribution itself rides the update the turn already performs to close the receipt out, so a
 * reader of the receipt row still knows which turn it belonged to.
 *
 * ── WHAT DELIBERATELY DOES NOT RIDE IT, AND WHY THE NEXT READER NEEDS TO KNOW ────────────────────
 *
 * THE COMPUTE FIELDS: tokens, cost, model, and the latency split. They are per-MESSAGE facts, and a
 * turn in this shape produces TWO bot CREATE rows - the receipt and the message the answer moved to.
 * `model_usage`, the Effectiveness cost estimate and every token sum read `messages`, one row at a
 * time, with no idea that two of them belong to one turn. Stamping the compute twice would double
 * every one of those figures, and it would double them only for turns that were queued or answered
 * privately - the population least likely to be reconciled against an AWS bill.
 *
 * The attribution fields below have no such problem. Intent, delivery option and the task id are
 * facts about the TURN, and nothing sums them per message.
 *
 * THE TASK TRANSITION IS EXCLUDED FOR THE SAME REASON, in its own form. `task_transition` and a
 * terminal `task_status` are what the turn-events projection reads as `task_opened`,
 * `task_transition` and `task_terminal`; carried on both rows, one task movement would be recorded
 * twice and `v_task_resolution` would count it twice. The task ID alone opens no ledger row.
 */

/** What the turn knows about itself at the moment it closes out its acknowledgment. */
export interface TurnAttributionSource {
  /** The Amazon Chime SDK `MessageId` this turn answers. The pairing declaration. */
  userMessageId?: string;
  /** The classified intent, as the router declared it. */
  intent?: string;
  /** The classifier's confidence band. */
  intentConfidence?: string;
  /** The `DeliveryOption` this turn took. */
  deliveryOption?: string;
  /** The task this turn advanced, by id and by id only. See the header on why nothing else. */
  taskId?: string;
  /**
   * HOW THE TURN ENTERED (`turnEntryOf`). The receipt is a message of the turn and is counted among the
   * turn's messages, so it records the turn's path rather than leaving it unrecorded. A fact about the
   * turn, like the intent, and nothing sums it per message.
   */
  entry?: string;
}

/**
 * The metadata a close-out carries, or `undefined` when the turn knows nothing worth declaring.
 *
 * `undefined` rather than an empty object, so `updateMessage` is handed exactly what it was handed
 * before on a turn with nothing to say, and the only observable change is on turns that have
 * something.
 */
export function closeOutAttribution(
  source: TurnAttributionSource,
): Record<string, unknown> | undefined {
  const attribution: Record<string, unknown> = {};
  // THE PAIRING DECLARATION. The same key the answer's own metadata uses, read by both pairers and
  // folded to `messages.answers_message_id` at archival (migration 042).
  if (source.userMessageId) attribution.answersMessageId = source.userMessageId;
  if (source.intent) attribution.intent = source.intent;
  if (source.intentConfidence) attribution.intentConfidence = source.intentConfidence;
  if (source.deliveryOption) attribution.deliveryOption = source.deliveryOption;
  // A BARE ID, NOT AN `activeTask` BLOB. The blob carries a status, and a terminal status is what the
  // ledger reads as `task_terminal` - which on a second row would count one ending twice.
  if (source.taskId) attribution.taskId = source.taskId;
  if (source.entry) attribution.entry = source.entry;
  return Object.keys(attribution).length ? attribution : undefined;
}

/**
 * The keys a close-out may carry, stated once so a test can assert the complement.
 *
 * A test that lists the forbidden keys by hand goes stale the day a new compute field is added. This
 * is the allowlist, and the rule is that anything absent from it must not appear on a close-out.
 */
export const CLOSE_OUT_ATTRIBUTION_KEYS: readonly string[] = [
  'answersMessageId', 'intent', 'intentConfidence', 'deliveryOption', 'taskId', 'entry',
];
