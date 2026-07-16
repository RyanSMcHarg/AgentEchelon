/**
 * Per-variant thumbs aggregation for the experiment results join
 * (the "feedback join").
 *
 * Thumbs live in DynamoDB (the always-deployed UserFeedback table, owned by
 * the CognitoAuth stack), while the per-variant experiment metrics
 * (avg_score, latency, cost, …) come from Aurora. Rather than pipe thumbs into
 * Aurora via a second write path, they are aggregated at read time inside the
 * analytics-query Lambda: it already runs in the Aurora
 * VPC and does cross-source work (Bedrock + Aurora), so it scans the small,
 * admin-only feedback table and folds thumbs into the Aurora result rows. No
 * second write pipeline, no putting the (non-VPC) capture Lambda into the VPC.
 *
 * Grain: feedback is bucketed by `variantId::intent` — the two join keys
 * present on both a feedback record and an experiment_results row. In a normal
 * two-variant experiment a variant maps to exactly one model on a given
 * intent, so this grain lines up 1:1 with the Aurora rows (which also split by
 * model/agent_type) and the frontend's per-variant weighted aggregate sums the
 * intent rows back up to a correct variant total without double-counting.
 *
 * Battle traffic is excluded by default, matching fetchExperimentRows: a
 * battle thumbs record carries assignmentMode='battle' and must not count into
 * the probabilistic A/B comparison. Pass includeBattle=true to fold it in.
 *
 * Pure functions only (no AWS SDK) so the bucketing rules are unit-testable in
 * isolation; the Lambda supplies the scanned items.
 */

/** A thumbs record as projected from the UserFeedback DynamoDB table. */
export interface FeedbackItem {
  experimentId?: string | null;
  variantId?: string | null;
  intent?: string | null;
  feedback?: string | null; // 'up' | 'down'
  assignmentMode?: string | null; // 'probabilistic' | 'battle' | null
  createdAt?: string | null; // ISO timestamp
}

/** Per-(variant,intent) thumbs tally. */
export interface VariantFeedback {
  thumbs_up: number;
  thumbs_down: number;
  feedback_count: number;
}

/** The thumbs columns merged onto an experiment_results row. */
export interface VariantFeedbackColumns extends VariantFeedback {
  /** thumbs_up / feedback_count as a percent, or null when there is no feedback yet (honesty contract). */
  approval_rate: number | null;
}

/** Join key shared by a feedback record and an experiment_results row. */
export function feedbackKey(variantId: string, intent: string): string {
  return `${variantId}::${intent}`;
}

/**
 * Bucket thumbs by `variantId::intent`, applying the same date-window and
 * battle-exclusion filters the Aurora results query uses.
 *
 * @param items         scanned UserFeedback records (already projected)
 * @param sinceMs       epoch ms floor; records older than this are dropped
 * @param includeBattle when false, assignmentMode==='battle' records are dropped
 */
export function aggregateVariantFeedback(
  items: FeedbackItem[],
  sinceMs: number,
  includeBattle: boolean,
): Map<string, VariantFeedback> {
  const map = new Map<string, VariantFeedback>();
  for (const item of items) {
    const experimentId = (item.experimentId ?? '').trim();
    const variantId = (item.variantId ?? '').trim();
    // Only experiment-served thumbs join; the common case (no experiment) is skipped.
    if (!experimentId || !variantId) continue;

    const created = Date.parse(String(item.createdAt ?? ''));
    if (!Number.isFinite(created) || created < sinceMs) continue;

    if (!includeBattle && item.assignmentMode === 'battle') continue;

    const vote = item.feedback;
    if (vote !== 'up' && vote !== 'down') continue;

    const intent = (item.intent ?? '').trim() || 'unknown';
    const key = feedbackKey(variantId, intent);
    const acc = map.get(key) || { thumbs_up: 0, thumbs_down: 0, feedback_count: 0 };
    if (vote === 'up') acc.thumbs_up += 1;
    else acc.thumbs_down += 1;
    acc.feedback_count += 1;
    map.set(key, acc);
  }
  return map;
}

/**
 * Resolve the thumbs columns for a given (variantId, intent) from an aggregate
 * map. Returns zeros + null approval_rate when no feedback has been recorded
 * for that variant/intent yet (so the row is honest about "no signal").
 */
export function feedbackColumnsFor(
  map: Map<string, VariantFeedback>,
  variantId: string,
  intent: string,
): VariantFeedbackColumns {
  const agg = map.get(feedbackKey(variantId, intent));
  if (!agg || agg.feedback_count === 0) {
    return { thumbs_up: 0, thumbs_down: 0, feedback_count: 0, approval_rate: null };
  }
  return {
    thumbs_up: agg.thumbs_up,
    thumbs_down: agg.thumbs_down,
    feedback_count: agg.feedback_count,
    approval_rate: Math.round((agg.thumbs_up / agg.feedback_count) * 1000) / 10,
  };
}

// ---------------------------------------------------------------------------
// Battle picks — the second human
// signal. A /battle round ends with the user's explicit head-to-head pick,
// stored in the BattleOutcome DynamoDB table (PK battleId) already carrying
// experimentId / variantId / intent (Phase-2 capture). The variantId is the
// credited side (A→control, B→treatment); a tie credits neither and has no
// variantId. We fold per-variant WIN counts into experiment_results so the
// battle becomes the fast path to the same per-variant decision the
// probabilistic A/B split reaches slowly.
//
// Battle wins are NOT gated by the includeBattle toggle: a pick only exists
// because a battle happened, so it is always the battle signal — there is no
// "probabilistic vs battle" ambiguity the way there is for exchange traffic.
// ---------------------------------------------------------------------------

/** A battle pick as projected from the BattleOutcome DynamoDB table. */
export interface BattleOutcomeItem {
  experimentId?: string | null;
  variantId?: string | null; // 'control' | 'treatment' | undefined (tie)
  intent?: string | null;
  winner?: string | null; // 'A' | 'B' | 'tie'
  chosenAt?: string | null; // ISO timestamp
}

/** The battle column merged onto an experiment_results row. */
export interface VariantBattleColumns {
  /** Head-to-head picks this variant won, or null when no picks credit it yet. */
  battle_wins: number | null;
}

/**
 * Bucket battle picks by `variantId::intent`, counting wins for the credited
 * side. Ties (no variantId) credit neither side and are dropped — they are an
 * experiment-level concept the live scorecard surfaces, not a per-variant one.
 *
 * @param items   scanned BattleOutcome records (already projected)
 * @param sinceMs epoch ms floor; picks older than this are dropped
 */
export function aggregateBattleWins(items: BattleOutcomeItem[], sinceMs: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const experimentId = (item.experimentId ?? '').trim();
    const variantId = (item.variantId ?? '').trim();
    // Only experiment-attributed, side-crediting picks join (ties have no variantId).
    if (!experimentId || !variantId) continue;

    const chosen = Date.parse(String(item.chosenAt ?? ''));
    if (!Number.isFinite(chosen) || chosen < sinceMs) continue;

    const intent = (item.intent ?? '').trim() || 'unknown';
    const key = feedbackKey(variantId, intent);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

/**
 * Resolve the battle-wins column for a (variantId, intent). Returns null when
 * no pick has credited that variant/intent yet (honest "no signal").
 */
export function battleColumnsFor(
  map: Map<string, number>,
  variantId: string,
  intent: string,
): VariantBattleColumns {
  const wins = map.get(feedbackKey(variantId, intent));
  return { battle_wins: wins == null ? null : wins };
}
