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
  feedback?: string | null; // 'up' | 'down' | 'clear'
  assignmentMode?: string | null; // 'probabilistic' | 'battle' | null
  createdAt?: string | null; // ISO timestamp
  /** Identity of the VOTE, not of the record: the table is append-only, so one voter revising a
   *  thumb writes a second row with the same (userSub, messageId). Required for `latestVotePerVote`
   *  to collapse a decision trail down to the decision. */
  userSub?: string | null;
  messageId?: string | null;
}

/** A thumbs record carrying what a drill-down needs to show the exchange behind the vote. */
export interface FeedbackRecord extends FeedbackItem {
  feedbackId?: string | null;
  channelArn?: string | null;
}

/**
 * Collapse an append-only feedback log to ONE record per (userSub, messageId) — the latest by
 * `createdAt`.
 *
 * The table appends every vote, INCLUDING a revision (up→down) and a 'clear', "so the full decision
 * trail is preserved for audit" (user-feedback.ts), and only the latest is meant to count. The
 * per-message summary the chat UI reads already does this. The variant rollup did NOT: it counted
 * every row, so one voter switching up→down added one to EACH side and a 'clear' left the withdrawn
 * vote standing. `approval_rate` overstated its vote count and mis-stated the rate, and that number
 * now feeds a tested verdict (the two-proportion approval axis).
 *
 * Records missing either half of the key cannot be collapsed and are kept as-is — losing an
 * unattributable vote would be a worse error than counting it once.
 *
 * The window filter must be applied AFTER this, not before: a vote revised today supersedes its
 * original whenever the original was cast, so filtering first would resurrect a superseded vote whose
 * replacement fell outside the window.
 */
export function latestVotePerVoter<T extends FeedbackItem>(items: T[]): T[] {
  const latest = new Map<string, T>();
  const unkeyed: T[] = [];
  for (const item of items) {
    const userSub = (item.userSub ?? '').trim();
    const messageId = (item.messageId ?? '').trim();
    if (!userSub || !messageId) {
      unkeyed.push(item);
      continue;
    }
    const key = `${userSub}#${messageId}`;
    const prev = latest.get(key);
    if (!prev) {
      latest.set(key, item);
      continue;
    }
    const prevAt = Date.parse(String(prev.createdAt ?? ''));
    const nextAt = Date.parse(String(item.createdAt ?? ''));
    // An unparseable timestamp never wins, so a malformed row cannot silently supersede a real vote.
    if (Number.isFinite(nextAt) && (!Number.isFinite(prevAt) || nextAt >= prevAt)) latest.set(key, item);
  }
  return [...latest.values(), ...unkeyed];
}

/**
 * The thumbs records behind an approval rate, newest first — the per-vote evidence for the
 * aggregate, under the SAME predicate the aggregate applies (latest-vote-per-voter, the date window,
 * the battle exclusion, and up/down only).
 *
 * Deliberately shares `latestVotePerVoter` with `aggregateVariantFeedback` rather than
 * re-implementing the filter: a drill-down filtered differently from the number it explains is worse
 * than no drill-down, and two copies of a predicate diverge.
 */
export function selectVariantFeedbackRecords(
  items: FeedbackRecord[],
  sinceMs: number,
  includeBattle: boolean,
  variantId?: string | null,
): FeedbackRecord[] {
  const wanted = (variantId ?? '').trim();
  return latestVotePerVoter(items)
    .filter((item) => {
      const experimentId = (item.experimentId ?? '').trim();
      const variant = (item.variantId ?? '').trim();
      if (!experimentId || !variant) return false;
      if (wanted && variant !== wanted) return false;
      const created = Date.parse(String(item.createdAt ?? ''));
      if (!Number.isFinite(created) || created < sinceMs) return false;
      if (!includeBattle && item.assignmentMode === 'battle') return false;
      return item.feedback === 'up' || item.feedback === 'down';
    })
    .sort((a, b) => Date.parse(String(b.createdAt ?? '')) - Date.parse(String(a.createdAt ?? '')));
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

/**
 * Join key shared by a feedback record and an experiment_results row.
 *
 * The EXPERIMENT is part of the key, for the same reason `battleWinKey` carries it: `control` and
 * `treatment` are per-experiment labels, not global ones, so they collide across experiments. Keyed on
 * `variantId::intent` alone, any two experiments sharing a variant id and an intent shared one bucket
 * and each row reported the other's votes.
 *
 * That was invisible on a single-experiment read, where the scan already filters `#eid = :eid` and only
 * one experiment's records are present. It was live on the ALL-experiments view, which scans every
 * experiment's feedback at once - the exact case `battleWinKey`'s comment was written to prevent.
 */
export function feedbackKey(experimentId: string, variantId: string, intent: string): string {
  return `${experimentId}::${variantId}::${intent}`;
}

/**
 * Bucket thumbs by `variantId::intent`, applying the same date-window and
 * battle-exclusion filters the Aurora results query uses.
 *
 * ONE VOTE PER (voter, message): the feedback table is append-only, so the raw scan carries a
 * voter's whole decision trail. `latestVotePerVoter` collapses it first — see there for why counting
 * the raw rows overstated both the vote count and the rate.
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
  for (const item of latestVotePerVoter(items)) {
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
    const key = feedbackKey(experimentId, variantId, intent);
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
  experimentId: string,
  variantId: string,
  intent: string,
): VariantFeedbackColumns {
  const agg = map.get(feedbackKey(experimentId, variantId, intent));
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
// signal. A /battle round ends with each user's explicit head-to-head pick,
// stored in the BattleOutcome DynamoDB table as ONE item per battle (PK battleId)
// holding a per-user `votes` map keyed by the chooser's sub, each entry carrying
// its own experimentId / variantId / intent (Phase-2 capture). flattenBattleOutcomeItem
// hoists those to one BattleOutcomeItem per pick. The variantId is the
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
  /** The battle this pick belongs to (the raw item's PK). Carried so a pick can be traced back to
   *  the duel it judged: `battleId` is `sha256(channelArn:userMessageId)`, one-way, so the CONVERSATION
   *  is resolved by matching this against the battle turns' stored battleId, never by decoding it. */
  battleId?: string | null;
  /** Who picked. Present for v2 votes-map picks (the map key); absent on a legacy v1 row. */
  userSub?: string | null;
}

/** A raw BattleOutcome table item: one per battle (PK battleId) with a per-user votes map. */
export interface RawBattleOutcomeItem {
  battleId?: string | null;
  votes?: Record<string, Partial<BattleOutcomeItem> | null> | null;
  // Legacy v1 single-pick row fields (tolerated during cutover).
  experimentId?: string | null;
  variantId?: string | null;
  intent?: string | null;
  winner?: string | null;
  chosenAt?: string | null;
  chosenByUserSub?: string | null;
}

/**
 * Flatten one raw BattleOutcome item into per-user picks. Reads the v2 per-user
 * `votes` map (each entry keyed by the chooser's sub, carrying its own join
 * fields) and tolerates a legacy v1 top-level single pick during cutover —
 * skipped for a sub already present in the map. Mirrors extractPicks in
 * lib/battle-outcome.ts, projected to the analytics join columns; a pure v2 item
 * has no top-level winner/experimentId, so the legacy branch only fires for a
 * genuine legacy row.
 */
export function flattenBattleOutcomeItem(raw: RawBattleOutcomeItem | null | undefined): BattleOutcomeItem[] {
  if (!raw) return [];
  const out: BattleOutcomeItem[] = [];
  const seen = new Set<string>();
  const votes = raw.votes;
  if (votes && typeof votes === 'object') {
    for (const [sub, v] of Object.entries(votes)) {
      if (!v || typeof v !== 'object') continue;
      out.push({
        experimentId: v.experimentId ?? null,
        variantId: v.variantId ?? null,
        intent: v.intent ?? null,
        winner: v.winner ?? null,
        chosenAt: v.chosenAt ?? null,
        battleId: raw.battleId ?? null,
        userSub: sub || null,
      });
      if (sub) seen.add(sub);
    }
  }
  if (raw.winner != null || raw.experimentId != null) {
    const legacySub = typeof raw.chosenByUserSub === 'string' ? raw.chosenByUserSub : '';
    if (!legacySub || !seen.has(legacySub)) {
      out.push({
        experimentId: raw.experimentId ?? null,
        variantId: raw.variantId ?? null,
        intent: raw.intent ?? null,
        winner: raw.winner ?? null,
        chosenAt: raw.chosenAt ?? null,
        battleId: raw.battleId ?? null,
        userSub: legacySub || null,
      });
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Battle win join key. Wins bucket per (experiment, variant) everywhere they are
// read - the A/B rollup, the battle-scoped effectiveness view, and the
// recommendation. A pick carries no intent (the judgement is of the whole reply,
// and nothing in the write path has an intent to record), and a scorecard sums a
// variant's wins across all of its intents. The experiment must be part of the key
// because 'control'/'treatment' collide across experiments when picks from every
// experiment are scanned at once.
// ---------------------------------------------------------------------------

/** Join key for the battle-scoped effectiveness view: one bucket per (experiment, variant). */
export function battleWinKey(experimentId: string, variantId: string): string {
  return `${experimentId}::${variantId}`;
}

/**
 * Bucket battle picks by `experimentId::variantId` (wins summed across intents),
 * for the battle-scoped effectiveness view. Same crediting + date-window rules as
 * aggregateBattleWins: ties (no variantId) and picks without an experiment are
 * dropped. Pure so the bucketing is unit-testable without DynamoDB.
 *
 * @param items   scanned BattleOutcome records (already projected)
 * @param sinceMs epoch ms floor; picks older than this are dropped
 */
/**
 * The individual picks behind a `battle_wins` count, newest first — the per-pick evidence for the
 * human axis, under the SAME predicate `aggregateBattleWinsByVariant` counts on.
 *
 * TIES ARE EXCLUDED, exactly as they are from the tally: a tie credits no side, so including it here
 * would show an operator rows that did not contribute to the number they are reconciling. That the
 * ties are therefore invisible is a real limitation of this axis, and the caller states it rather
 * than letting a shorter list read as fewer battles.
 */
export function selectBattlePicks(
  items: BattleOutcomeItem[],
  sinceMs: number,
  variantId?: string | null,
): BattleOutcomeItem[] {
  const wanted = (variantId ?? '').trim();
  return items
    .filter((item) => {
      const experimentId = (item.experimentId ?? '').trim();
      const variant = (item.variantId ?? '').trim();
      if (!experimentId || !variant) return false;
      if (wanted && variant !== wanted) return false;
      const chosen = Date.parse(String(item.chosenAt ?? ''));
      return Number.isFinite(chosen) && chosen >= sinceMs;
    })
    .sort((a, b) => Date.parse(String(b.chosenAt ?? '')) - Date.parse(String(a.chosenAt ?? '')));
}

export function aggregateBattleWinsByVariant(items: BattleOutcomeItem[], sinceMs: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const experimentId = (item.experimentId ?? '').trim();
    const variantId = (item.variantId ?? '').trim();
    // Only experiment-attributed, side-crediting picks join (ties have no variantId).
    if (!experimentId || !variantId) continue;

    const chosen = Date.parse(String(item.chosenAt ?? ''));
    if (!Number.isFinite(chosen) || chosen < sinceMs) continue;

    const key = battleWinKey(experimentId, variantId);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}
