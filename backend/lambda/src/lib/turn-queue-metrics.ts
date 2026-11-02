/**
 * WHAT THE QUEUE COSTS PEOPLE, AND WHETHER THE MECHANISM IS HOLDING (ADR-033).
 *
 * The existing latency surface answers "how long did turns take". These answer a different question:
 * is this mechanism working, and what is it costing the people it defers. Folding them into the
 * headline latency cards is exactly how a deliberate wait becomes indistinguishable from a slow one,
 * so they are their own namespace and belong beside the interaction breakdown.
 *
 * ── THE ONE THAT JUDGES THE DESIGN ───────────────────────────────────────────────────────────────
 *
 * `LockTakeover`. Tenets 2 and 3 claim a lock is released by something that HAPPENED - a turn
 * finishing, or the platform reporting that the invocation running it died. A takeover is the
 * measured admission that neither did: an arriving message found a holder with no progress for longer
 * than `STALE_AFTER_MS` (lib/turn-lock.ts) and had to free the conversation itself.
 * A build that cannot report this number cannot show its central claim holds, which is why it is the
 * one metric here worth an alarm.
 *
 * ── AND THE ONE THAT IS DATA LOSS ────────────────────────────────────────────────────────────────
 *
 * `OverflowDrop`. The bound discarded something a person sent. They are told at the time, but a count
 * that exists only as a log line means nobody can see it happening across a deployment, and this is
 * the one number here that represents a message that never got answered.
 *
 * ── NO CONTENT, EVER ─────────────────────────────────────────────────────────────────────────────
 *
 * These are aggregates: how many, how long, how deep. None of them needs the request that produced
 * them. The conversation read already holds that line by building its result field by field, and a
 * count has even less reason to cross it. The channel is NOT a dimension either - it would make the
 * cardinality unbounded and turn a metric into a per-conversation record.
 */

import { emitEmfMetric } from './emf-metrics.js';

const NAMESPACE = 'AgentEchelon/TurnQueue';

/** The classification serving the turn. The only dimension: bounded, and the axis operators tune on. */
type Classification = string;

function emit(
  name: string,
  unit: 'Count' | 'Milliseconds',
  value: number,
  classification: Classification,
  extra: Record<string, string | number> = {},
): void {
  try {
    emitEmfMetric({
      namespace: NAMESPACE,
      metrics: [{ name, unit }],
      // TWO SETS: per classification, and the AGGREGATE.
      //
      // Only the per-classification one was published, and everything that reads these asks for
      // the aggregate: the Queue Health panel queries the metric with no dimensions, and the
      // stranded-lock alarm watches it with none either. Both were therefore asking for a metric
      // that is never emitted - the panel returned null for every series on a working deployment,
      // and the alarm ADR-033 calls the judge of this design sat OK no matter how many locks
      // stranded, because missing data is treated as not breaching.
      //
      // The empty set is what makes a cross-classification total exist at all. An emitter whose
      // CLASSIFICATION is unset counts under 'unknown' in the per-classification set.
      dimensionSets: [['Classification'], []],
      properties: { Classification: classification || 'unknown', [name]: value, ...extra },
    });
  } catch {
    // A metric must never fail a turn. This is instrumentation, and the turn it describes is more
    // important than the description.
  }
}

/**
 * A message was queued behind a running turn.
 *
 * Emitted per message rather than per batch, so the RATE is readable: a deployment where this is high
 * is one where people routinely wait on their own earlier message, and that is a product signal
 * rather than a performance one.
 */
export function recordQueued(classification: Classification, depth: number): void {
  emit('MessageQueued', 'Count', 1, classification, { QueueDepth: depth });
}

/**
 * The bound was hit and the OLDEST queued message was discarded.
 *
 * DATA LOSS FROM THE PERSON'S POINT OF VIEW, which is why it is counted separately from `MessageQueued`
 * rather than inferred from a depth that stopped rising.
 */
export function recordOverflowDrop(classification: Classification): void {
  emit('OverflowDrop', 'Count', 1, classification);
}

/**
 * A turn finished and absorbed this many queued messages.
 *
 * Depth AT DRAIN, not at enqueue: it distinguishes one person double-sending from a conversation
 * nobody is keeping up with, and only the drain knows how many the turn actually took.
 */
export function recordDrainDepth(classification: Classification, depth: number): void {
  emit('QueueDepthAtDrain', 'Count', depth, classification);
}

/**
 * How long a queued message waited before anything looked at it.
 *
 * THE ONE DELAY THE PLATFORM CHOSE DELIBERATELY, so the one that most needs a name. Measured from the
 * message being queued to triage reading it, which is the moment it stops waiting - not the moment it
 * is answered, because a message that became a task is measured on the task surface from there.
 */
export function recordQueueWait(classification: Classification, waitedMs: number): void {
  if (!Number.isFinite(waitedMs) || waitedMs < 0) return;
  emit('QueueWaitMs', 'Milliseconds', waitedMs, classification);
}

/** Triage turned queued messages into this many tasks. The handoff count; what happens after is the task surface's. */
export function recordTriageTasks(classification: Classification, created: number): void {
  emit('TriageTasksCreated', 'Count', created, classification);
}

/**
 * NO CANCELLATION COUNTER HERE, AND THE ABSENCE IS THE DECISION.
 *
 * A cancelled turn already lands in the ledger as its own phase (`cancelled_response`), which is
 * where every other turn OUTCOME is counted. Emitting it here as well would give one question two
 * answers in two stores that can disagree, and an operator comparing them would have no way to know
 * which one to believe.
 *
 * The rest of this module measures the MECHANISM - depth, waits, drops, strandings - which the
 * archive has no rows for because they are facts about the queue rather than about messages. That is
 * the line: this namespace holds what nothing else can answer, and nothing that something else
 * already answers.
 */

/**
 * THE JUDGED READING WAS REFUSED, so the drain fell back to one task per message.
 *
 * THE ONE THAT WAS MISSING, and its absence is why this took weeks to find. The judged half of
 * ADR-033 was refused on EVERY drain of every deployment - three separate causes over this branch
 * alone - and nothing counted it. The condition was a `console.warn`, so noticing it required
 * somebody to already suspect it and go reading a log group; the panel showed tasks being created
 * and a queue draining, which is exactly what a healthy deployment looks like.
 *
 * A derived reading is not an error - it is the floor, and the floor working is why nothing was
 * lost. But it is one task per message with nothing grouped and nothing prioritized, which is the
 * feature not running. Counted, it is a rate an operator can watch: a deployment where this
 * approaches the drain count has a judged half that is not working, whatever the logs say.
 *
 * `reason` rides as a PROPERTY rather than a dimension: it is worth having on the record that
 * explains a spike, and not worth multiplying the metric by.
 */
export function recordReadingRefused(classification: Classification, reason: string): void {
  emit('ReadingRefused', 'Count', 1, classification, { Reason: reason });
}

/**

/**
 * A PERSON ANSWERED THE QUESTION THE DRAIN ASKED, which is the drain working rather than failing.
 *
 * Counted separately because it used to be counted as a TAKEOVER. Both paths displace a holder, so
 * "the holder changed" could not tell them apart - and this one is the ordinary close of the
 * split-offer loop. The signal ADR-033 calls the judge of this design was therefore dominated by
 * its own healthy case, and the stranded-lock alarm watched a number that rose whenever the
 * feature worked.
 */
export function recordAwaitedAnswer(classification: Classification): void {
  emit('AwaitedAnswer', 'Count', 1, classification);
}

/**
 * A lock was taken over from a holder with no progress for longer than `STALE_AFTER_MS`.
 *
 * The stranded-lock alarm watches this. A person answering the drain's question is counted separately
 * (`recordAwaitedAnswer`), so the healthy close and the recovery are never read as the same event.
 */
export function recordTakeover(classification: Classification): void {
  emit('LockTakeover', 'Count', 1, classification);
}

