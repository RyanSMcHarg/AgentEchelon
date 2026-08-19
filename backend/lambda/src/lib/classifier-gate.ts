/**
 * The classification shadow gate (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5).
 *
 * A `classification` experiment changes which model LABELS a message. Scored the ordinary way it is
 * judged on the evaluator's opinion of the ANSWER, which is a downstream proxy: the routing changes
 * for real users while the measurement watches a shadow of the effect. The gate replaces the proxy
 * with the question actually being asked - **is the challenger's labelling better?** - by having both
 * candidates label the SAME archived messages and adjudicating only where they disagree.
 *
 * Pure. The replay job supplies the rows; nothing here reads a database or calls a model, so the
 * counting rules and the ship criterion are testable in isolation.
 *
 * **A passing gate authorises the online split (§5.4). It does not replace it.** The gate measures
 * labelling on a fixed corpus; whether users are better served is a question about live traffic, and
 * §5.4 exists so the intermediate metric is never mistaken for the outcome.
 */

import { mcnemarTest, DEFAULT_ACCURACY_MARGIN_PCT, type HumanPickResult } from './experiment-stats.js';

/** One replayed message: what each candidate said, and what the human decided if asked. */
export interface ReplayLabel {
  incumbentLabel: string;
  challengerLabel: string;
  /** The adjudicated answer. Absent until a human rules; only ever set for discordant pairs. */
  trueLabel?: string | null;
}

export interface ReplaySummary {
  /** Every replayed message. */
  total: number;
  /** Both models said the same thing. Carries no comparative signal, and is never adjudicated. */
  concordant: number;
  /** The models disagreed. This is the adjudication queue. */
  discordant: number;
  /** Discordant pairs a human has ruled on. */
  adjudicated: number;
  /** Discordant pairs still waiting. The gate cannot conclude while this is above zero. */
  pending: number;
  /** Adjudicated discordant pairs the CHALLENGER got right (McNemar's `b` cell). */
  challengerOnlyRight: number;
  /** Adjudicated discordant pairs the INCUMBENT got right (McNemar's `c` cell). */
  incumbentOnlyRight: number;
  /**
   * Adjudicated discordant pairs where the true label matched NEITHER prediction.
   *
   * These are real and must be counted separately: both models were wrong, so the pair cannot favour
   * either, and folding it into either cell would invent a winner. Forcing the adjudicator to choose
   * one of the two predictions would do the same thing earlier in the pipeline, which is why
   * 'neither' is an allowed outcome.
   */
  bothWrong: number;
}

/**
 * Count a replay's labels into the cells the test needs.
 *
 * A pair is concordant when the two predictions are equal, whatever the truth. That is the whole
 * economy of this design: two classifiers agree on the large majority of traffic, so the human queue
 * is the small remainder.
 */
export function summarizeReplay(rows: ReplayLabel[]): ReplaySummary {
  const s: ReplaySummary = {
    total: rows.length,
    concordant: 0,
    discordant: 0,
    adjudicated: 0,
    pending: 0,
    challengerOnlyRight: 0,
    incumbentOnlyRight: 0,
    bothWrong: 0,
  };

  for (const row of rows) {
    if (row.incumbentLabel === row.challengerLabel) {
      s.concordant += 1;
      continue;
    }
    s.discordant += 1;
    const truth = (row.trueLabel ?? '').trim();
    if (!truth) {
      s.pending += 1;
      continue;
    }
    s.adjudicated += 1;
    if (truth === row.challengerLabel) s.challengerOnlyRight += 1;
    else if (truth === row.incumbentLabel) s.incumbentOnlyRight += 1;
    else s.bothWrong += 1;
  }
  return s;
}

export type GateVerdict =
  /** The challenger is better, and the interval says so. */
  | 'challenger_better'
  /** Not worse by more than the margin. Enough to authorise the online split, not to declare a win. */
  | 'non_inferior'
  /** The challenger is worse by more than the margin can excuse, or the data cannot rule that out. */
  | 'worse'
  /** No discordant pair exists: the two models are indistinguishable on this corpus. */
  | 'indistinguishable'
  /** Not enough adjudicated evidence to say anything. */
  | 'insufficient';

export interface GateResult {
  verdict: GateVerdict;
  summary: ReplaySummary;
  /** McNemar over the informative discordant cells; null when none exist. */
  mcnemar: HumanPickResult | null;
  /**
   * Paired accuracy difference (challenger minus incumbent) over the WHOLE corpus, as a proportion.
   * Derived from the discordant cells because the concordant ones cancel exactly: they contribute the
   * same amount to each model's accuracy.
   */
  accuracyDelta: number | null;
  /** CI on that difference, transformed from McNemar's interval on the discordant proportion. */
  accuracyDeltaCi: [number, number] | null;
  /** The non-inferiority margin applied, in percentage points. */
  marginPct: number;
  /** Plain statement of what the gate concluded and why. */
  rationale: string;
}

export interface GateOptions {
  /** Non-inferiority margin in percentage points. Defaults to the platform's declared margin. */
  marginPct?: number;
  /** Minimum adjudicated discordant pairs before the gate will conclude anything. */
  minAdjudicated?: number;
}

/**
 * The default floor on adjudicated evidence.
 *
 * Deliberately expressed in ADJUDICATED DISCORDANT pairs rather than corpus size: a 10,000-message
 * replay on which the models disagreed twice carries exactly two pairs of evidence, and a floor on
 * the corpus would wave that through.
 */
export const MIN_ADJUDICATED_PAIRS = 10;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Apply the ship criterion to a replay.
 *
 * The criterion is NON-INFERIORITY, and it is checked against the interval rather than the point
 * estimate, for the same reason §4.2's guardrails are: on thin data a noisy estimate lands inside the
 * margin by chance, and "we could not tell" must not read as "it held". The worst case still
 * consistent with the data has to clear the margin.
 */
export function evaluateClassifierGate(rows: ReplayLabel[], opts: GateOptions = {}): GateResult {
  const summary = summarizeReplay(rows);
  const marginPct = opts.marginPct ?? DEFAULT_ACCURACY_MARGIN_PCT;
  const minAdjudicated = opts.minAdjudicated ?? MIN_ADJUDICATED_PAIRS;
  const base = {
    summary,
    mcnemar: null,
    accuracyDelta: null,
    accuracyDeltaCi: null,
    marginPct,
  };

  if (summary.pending > 0) {
    return {
      ...base,
      verdict: 'insufficient',
      rationale:
        `${summary.pending} of ${summary.discordant} disagreements are still waiting on adjudication. `
        + 'The gate reports nothing until the queue is clear, because the unadjudicated pairs could fall either way.',
    };
  }

  if (summary.discordant === 0) {
    // Not a tie. The models label this corpus identically, so splitting traffic between them would
    // measure nothing and expose users to a change that makes no difference here.
    return {
      ...base,
      verdict: 'indistinguishable',
      rationale:
        `The two models agreed on all ${summary.total} replayed messages. They are indistinguishable on `
        + 'this corpus, so there is nothing to gain from splitting traffic between them.',
    };
  }

  const mcnemar = mcnemarTest(summary.challengerOnlyRight, summary.incumbentOnlyRight);
  const informative = summary.challengerOnlyRight + summary.incumbentOnlyRight;

  if (!mcnemar || informative < minAdjudicated) {
    const reason = !mcnemar
      ? `all ${summary.discordant} disagreements were adjudicated to a label neither model produced, so none of them favours either side`
      : `only ${informative} adjudicated ${informative === 1 ? 'pair distinguishes' : 'pairs distinguish'} the two models (floor is ${minAdjudicated})`;
    return {
      ...base,
      mcnemar,
      verdict: 'insufficient',
      rationale:
        `Not enough evidence to decide: ${reason}. `
        + `${summary.bothWrong} of ${summary.adjudicated} adjudicated disagreements had both models wrong.`,
    };
  }

  // The concordant pairs cancel: each contributes equally to both accuracies. So the paired accuracy
  // difference over the whole corpus is exactly (b - c) / total, and McNemar's interval on
  // p = b / (b + c) transforms onto it by delta = (2p - 1) * (b + c) / total.
  const total = summary.total || 1;
  const scale = informative / total;
  const accuracyDelta = (summary.challengerOnlyRight - summary.incumbentOnlyRight) / total;
  const accuracyDeltaCi: [number, number] = [
    (2 * mcnemar.ci[0] - 1) * scale,
    (2 * mcnemar.ci[1] - 1) * scale,
  ];
  const margin = marginPct / 100;
  const result = { ...base, mcnemar, accuracyDelta, accuracyDeltaCi };

  // Worse by more than the margin can excuse, or too uncertain to rule that out. Both land here, and
  // the rationale distinguishes them so an operator knows whether to collect more or to stop.
  if (accuracyDeltaCi[0] < -margin) {
    const damaging = accuracyDelta < -margin;
    return {
      ...result,
      verdict: 'worse',
      rationale: damaging
        ? `The challenger labels ${pct(Math.abs(accuracyDelta))} fewer messages correctly `
          + `(95% CI ${pct(accuracyDeltaCi[0])} to ${pct(accuracyDeltaCi[1])}), past the ${marginPct}-point margin. Do not split traffic.`
        : `The data cannot rule out a regression larger than the ${marginPct}-point margin `
          + `(95% CI ${pct(accuracyDeltaCi[0])} to ${pct(accuracyDeltaCi[1])}). Adjudicate more disagreements before deciding.`,
    };
  }

  if (mcnemar.significant && mcnemar.favors === 'a') {
    return {
      ...result,
      verdict: 'challenger_better',
      rationale:
        `The challenger won ${summary.challengerOnlyRight} of ${informative} informative disagreements `
        + `(${pct(mcnemar.winRate)}, 95% CI ${pct(mcnemar.ci[0])} to ${pct(mcnemar.ci[1])}, p=${mcnemar.pValue.toFixed(4)}), `
        + `a ${pct(accuracyDelta)} accuracy gain on this corpus. This authorises an online split; it is not the result of one.`,
    };
  }

  return {
    ...result,
    verdict: 'non_inferior',
    rationale:
      `The challenger is not worse by more than the ${marginPct}-point margin `
      + `(accuracy difference ${pct(accuracyDelta)}, 95% CI ${pct(accuracyDeltaCi[0])} to ${pct(accuracyDeltaCi[1])}), `
      + 'without being measurably better. This authorises an online split; it does not recommend one.',
  };
}

/** True when the gate's verdict permits the online confirm to start (§5.4). */
export function gateAuthorisesSplit(verdict: GateVerdict): boolean {
  return verdict === 'challenger_better' || verdict === 'non_inferior';
}
