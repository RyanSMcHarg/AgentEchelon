/**
 * Drift health answers two questions about an offer that was made, and nothing else:
 *
 *   1. Was the detection ACCURATE? Judged after the fact, by evaluation - not by the user's
 *      in-the-moment reaction, which can be wrong in both directions.
 *   2. Did the user ACCEPT it?
 *
 * They are deliberately separate. A user can decline a perfectly correct call (busy, mid-thought),
 * and can accept a bad one and regret it. Collapsing them into a single "precision" number hides
 * which of the two is failing, which is the thing an operator needs to know.
 *
 * What this is NOT: drift VOLUME. How often users change topic is a fact about users, not about
 * whether the feature works - a high number is not a failure and a low one is not success.
 *
 * Zero denominators return null so the UI renders "No data" rather than a fabricated 0%: an empty
 * window is not a perfect one.
 */

/** Raw counters for a window. Backend counts only `source='live'` rows, i.e. real OFFERS. */
export interface DriftOutcomeCounts {
  /** Offers made. The denominator for acceptance. */
  offered: number;
  /** The person said yes at the prompt, whatever became of the new conversation. */
  moved: number;
  /** Said yes and went on in the new conversation, once the engagement sweep has judged it. */
  carriedOn: number;
  /** Said yes and the move could not be made. */
  moveFailed: number;
  /** Said yes and nobody wrote in the new conversation. */
  neverUsed: number;
  /** Said no at the prompt, or in the new conversation afterwards. */
  declined: number;
  /** Nobody answered the offer. */
  unanswered: number;
  /** Offers still unsettled (outcome IS NULL). */
  pending: number;
  /** Offers the post-hoc judge has ruled on. The denominator for accuracy. */
  evaluated: number;
  /** Of those judged, how many the judge called correct. */
  evaluatedCorrect: number;
}

/** A rate that knows why it has no value, so the UI never invents one. */
export interface DriftRate {
  /** Fraction in [0,1], or null when the denominator is 0. */
  value: number | null;
  numerator: number;
  denominator: number;
}

export interface DriftHealthMetrics {
  /** Question 2: said yes / offered. Fully instrumented today. */
  acceptance: DriftRate;
  /** Where the settled offers ended. Each is a count; a move the sweep has not judged is in none yet. */
  outcomes: { carriedOn: number; neverUsed: number; declined: number; unanswered: number; moveFailed: number };
  /**
   * Question 1: of the offers judged after the fact, how many the judge called correct.
   *
   * The denominator is offers EVALUATED, not offers made, so an unjudged backlog cannot drag
   * accuracy down. Until the evaluation runner has judged anything the denominator is 0 and this is
   * null, which the UI renders as "Not measured" - a 0% or 100% would be a claim no evaluation
   * supports.
   */
  accuracy: DriftRate;
  /** Offers not yet settled. Acceptance counts every offer, so it is a floor while these resolve. */
  pending: number;
  /** Offers made in the window that the judge has not ruled on yet. */
  awaitingEvaluation: number;
}

/** Postgres returns COUNT(*) as a string; missing/NaN reads as 0. */
function count(stats: Record<string, string | number | null> | undefined, key: string): number {
  const raw = stats?.[key];
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseDriftCounts(
  stats: Record<string, string | number | null> | undefined,
): DriftOutcomeCounts {
  return {
    offered: count(stats, 'total_events'),
    moved: count(stats, 'moved_count'),
    carriedOn: count(stats, 'carried_on_count'),
    moveFailed: count(stats, 'move_failed_count'),
    neverUsed: count(stats, 'moved_unused_count'),
    declined: count(stats, 'declined_count'),
    unanswered: count(stats, 'unanswered_count'),
    pending: count(stats, 'pending_count'),
    evaluated: count(stats, 'evaluated_count'),
    evaluatedCorrect: count(stats, 'evaluated_correct_count'),
  };
}

function rate(numerator: number, denominator: number): DriftRate {
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}

export function driftHealthMetrics(counts: DriftOutcomeCounts): DriftHealthMetrics {
  return {
    acceptance: rate(counts.moved, counts.offered),
    outcomes: { carriedOn: counts.carriedOn, neverUsed: counts.neverUsed, declined: counts.declined, unanswered: counts.unanswered, moveFailed: counts.moveFailed },
    // Denominator is offers JUDGED, not offers made: a growing unjudged backlog must not read as
    // falling accuracy. `awaitingEvaluation` carries that backlog separately.
    accuracy: rate(counts.evaluatedCorrect, counts.evaluated),
    pending: counts.pending,
    awaitingEvaluation: Math.max(0, counts.offered - counts.evaluated),
  };
}

/** Percent for display, or null so the caller can choose its own "no data" wording. */
export function formatRate(r: DriftRate): string | null {
  return r.value === null ? null : `${(r.value * 100).toFixed(0)}%`;
}
