/**
 * ONE POPULATION, AND ONE AVERAGER, FOR EVERY LATENCY FIGURE THE CONSOLE DRAWS.
 *
 * The Latency tab cut three different sets and rendered them as one screen: the headline cards gated on
 * `avg_total_ms > 0`, the TTFF card gated on `avg_ttff_ms > 0`, and the breakdown table below them gated
 * on neither. The query had deliberately dropped its own `total_ms > 0` gate - a response that ran no
 * measurable compute is counted and attributed rather than vanishing from the population - and the tab
 * put that gate straight back, so handler-answered turns (the fastest turns there are, the ones where
 * ttff equals e2e) sat in the TTFF headline and were missing from every other card. E2E read high and
 * the cards disagreed with the table underneath them.
 *
 * `computeAlerts` made a THIRD set: no scope filter at all, its own `> 0` subset per metric, and duel
 * rounds pooled in with production traffic - all under a comment claiming it mirrored the tab.
 *
 * So the population is `rowMatches` plus the delivery-type choice and nothing else, and per-metric
 * absence lives HERE, in the averager: a metric is averaged over the rows that recorded it, weighted by
 * traffic, and it reports how many turns that average actually covers so the card can state it. A card
 * that cannot say what its own coverage is, is a card computed over a set nobody checked.
 */
import i18n from '@ae/shared/i18n';
import { rowMatches, type PerformanceFilters } from './PerformanceFilters';

/** One grouped row of the latency query, as far as the aggregation cares. */
export type LatencyRow = Record<string, unknown>;

/** A multi-step task turn. Per-turn reply latency, not whole-task cycle time. */
export const isTaskDelivery = (r: LatencyRow): boolean =>
  String(r.delivery_option ?? '').toUpperCase().startsWith('TASK');

/**
 * The rows every figure on the surface is computed from.
 *
 * `deliveryTypes` is the response-type choice the tab offers; omitting it takes that control's DEFAULT -
 * every non-task delivery - which is what a caller with no such control (Alerts) should be measuring.
 * Expressed as the same default rather than as its own predicate, so the two cannot drift.
 */
export function latencyPopulation(
  rows: readonly LatencyRow[],
  filters: PerformanceFilters,
  includeTasks = false,
): LatencyRow[] {
  // A response type chosen on the bar is the person's explicit cut, task types included. Only with
  // none chosen does Latency's own default apply: task turns stay out of a headline about reply time.
  const keepTasks = includeTasks || filters.responseType !== null;
  return rows.filter((r) => (keepTasks || !isTaskDelivery(r)) && rowMatches(r, filters));
}

/** A traffic-weighted average and the population it was actually taken over. */
export interface WeightedMetric {
  /** The weighted mean over the rows that recorded this metric. 0 when none did. */
  value: number;
  /** How many turns that mean covers, summed from the weight column. 0 when no row carries a count. */
  turns: number;
  /** How many grouped rows recorded it, which is the denominator of the plain-mean fallback. */
  rows: number;
}

/**
 * The traffic-weighted mean of one field over the rows that recorded it.
 *
 * ABSENCE IS A PROPERTY OF THE METRIC, NOT OF THE POPULATION. A step is stamped only on a turn that ran
 * it, so averaging in the rows that did not would make a step look CHEAPER the more often it is skipped;
 * removing those rows from the whole surface instead is what produced three populations on one screen.
 *
 * A NEGATIVE READING IS KEPT. `avg_processor_tail_ms` goes negative when compute was attributed to the
 * wrong turn, and that is a finding the tab deliberately declines to clamp - so only null and zero mean
 * "not recorded here".
 *
 * `weightField` is for a step that publishes its own population: a group's router average is over the
 * turns that stamped a router span, so weighting it by the group's whole traffic lets a group with few
 * measured turns count as much as all of its turns.
 */
export function weightedMetric(
  rows: readonly LatencyRow[],
  field: string,
  weightField = 'assistant_turn_count',
): WeightedMetric {
  const measured = rows.filter((r) => {
    const n = Number(r[field]);
    return r[field] != null && Number.isFinite(n) && n !== 0;
  });
  const weightOf = (r: LatencyRow) => Number(r[weightField] ?? r.assistant_turn_count) || 0;
  const turns = measured.reduce((s, r) => s + weightOf(r), 0);
  if (turns <= 0) {
    return {
      value: measured.length ? measured.reduce((s, r) => s + Number(r[field]), 0) / measured.length : 0,
      turns: 0,
      rows: measured.length,
    };
  }
  return {
    value: measured.reduce((s, r) => s + Number(r[field]) * weightOf(r), 0) / turns,
    turns,
    rows: measured.length,
  };
}

/**
 * What a card says about its own coverage, in the shape the tab already uses for a sample count.
 *
 * `scopeTurns` is the scope-wide denominator, so a metric recorded on a fraction of the traffic reads as
 * a fraction rather than as a figure about everything.
 */
export function coverage(m: WeightedMetric, scopeTurns: number): string {
  if (m.turns > 0) return `over ${m.turns.toLocaleString()} of ${scopeTurns.toLocaleString()} turns`;
  if (m.rows > 0) return `over ${m.rows} group${m.rows === 1 ? '' : 's'} carrying no turn count`;
  return i18n.t('admin.latencyAggregate.notRecordedOnAnyTurn');
}

/** The value, or NaN where nothing recorded it - so a caller judging it against a target judges nothing. */
export function measuredValue(m: WeightedMetric): number {
  return m.turns > 0 || m.rows > 0 ? m.value : NaN;
}
