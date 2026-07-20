/**
 * Live battle tally (SPEC-BATTLE.md "Battle Objectives", objective 2 — the
 * real-time tangible decision experience).
 *
 * Aggregates every /battle round in the current conversation into a running
 * scorecard: how many rounds each side has won, who is leading on speed and
 * cost, and how far the conversation is toward a confident call. This is the
 * fast, in-conversation counterpart to the admin Experiments tab's per-variant
 * battle_wins column (the slow, cross-conversation view) — same picks, two speeds.
 *
 * Sides are keyed by the bot's stable label (its Chime/AppInstanceUser name),
 * NOT by per-round array position: a round's A/B order follows message arrival,
 * which can differ between rounds, so positional aggregation would mix the two
 * bots together. The recorded winner ('A'|'B'|'tie') is positional to the round
 * it belongs to, so we resolve it to a label at accumulation time.
 *
 * Pure functions only — unit-testable; the component supplies the rounds.
 */

export type BattleWinner = 'A' | 'B' | 'tie';

/** One battle round's two sides + the user's pick (null = not yet picked). */
export interface BattleRoundInput {
  battleId: string;
  sideA: BattleSideInput;
  sideB: BattleSideInput;
  winner: BattleWinner | null;
}

export interface BattleSideInput {
  /** Stable bot label (Chime sender name) — the per-side aggregation key. */
  label: string;
  responseMs?: number;
  costUsd?: number | null;
}

export interface SideTally {
  label: string;
  wins: number;
  /** Mean across rounds that carried the metric, or null when none did. */
  avgResponseMs: number | null;
  avgCostUsd: number | null;
}

export interface BattleTally {
  totalRounds: number;
  /** Rounds with a recorded pick (A/B/tie). */
  pickedRounds: number;
  ties: number;
  /** One entry per distinct side, in first-seen order (normally two). */
  sides: SideTally[];
  /** Label leading on each axis, or null when undecided / insufficient data. */
  speedLeaderLabel: string | null; // lower avg responseMs wins
  costLeaderLabel: string | null; // lower avg cost wins
  qualityLeaderLabel: string | null; // more picks wins
  /** Soft confidence target for the progress nudge (picks, not exchanges). */
  target: number;
}

/**
 * Per-conversation soft confidence target for the progress nudge. This is a UX
 * cue ("you're building a clear signal"), NOT the admin A/B statistical
 * threshold (MIN_SAMPLE_PER_VARIANT = 30 *exchanges*). Battle picks are explicit
 * and far stronger per-sample than passive traffic, so a handful makes a
 * conversation-level call feel earned without implying statistical rigor.
 */
export const BATTLE_CONFIDENCE_TARGET = 10;

interface Acc {
  label: string;
  wins: number;
  msSum: number;
  msN: number;
  costSum: number;
  costN: number;
}

function ensure(map: Map<string, Acc>, order: string[], label: string): Acc {
  let acc = map.get(label);
  if (!acc) {
    acc = { label, wins: 0, msSum: 0, msN: 0, costSum: 0, costN: 0 };
    map.set(label, acc);
    order.push(label);
  }
  return acc;
}

function addMetrics(acc: Acc, side: BattleSideInput): void {
  if (typeof side.responseMs === 'number' && Number.isFinite(side.responseMs)) {
    acc.msSum += side.responseMs;
    acc.msN += 1;
  }
  if (typeof side.costUsd === 'number' && Number.isFinite(side.costUsd)) {
    acc.costSum += side.costUsd;
    acc.costN += 1;
  }
}

/** Lower-is-better leader across sides; null if fewer than two have data or it's a tie. */
function lowerLeader(sides: SideTally[], pick: (s: SideTally) => number | null): string | null {
  const withData = sides.filter((s) => pick(s) != null) as Array<SideTally>;
  if (withData.length < 2) return null;
  let best = withData[0];
  let tie = false;
  for (let i = 1; i < withData.length; i++) {
    const v = pick(withData[i])!;
    const b = pick(best)!;
    if (v < b) { best = withData[i]; tie = false; }
    else if (v === b) { tie = true; }
  }
  return tie ? null : best.label;
}

/** More-is-better leader by win count; null if no picks or a tie at the top. */
function winsLeader(sides: SideTally[]): string | null {
  if (sides.length === 0) return null;
  const max = Math.max(...sides.map((s) => s.wins));
  if (max === 0) return null;
  const leaders = sides.filter((s) => s.wins === max);
  return leaders.length === 1 ? leaders[0].label : null;
}

/**
 * Fold a conversation's battle rounds into a running tally. Rounds missing a
 * second side are skipped (an incomplete pair can't be scored).
 */
export function computeBattleTally(
  rounds: BattleRoundInput[],
  target: number = BATTLE_CONFIDENCE_TARGET,
): BattleTally {
  const map = new Map<string, Acc>();
  const order: string[] = [];
  let totalRounds = 0;
  let pickedRounds = 0;
  let ties = 0;

  for (const r of rounds) {
    if (!r.sideA?.label || !r.sideB?.label) continue;
    totalRounds += 1;

    const accA = ensure(map, order, r.sideA.label);
    const accB = ensure(map, order, r.sideB.label);
    addMetrics(accA, r.sideA);
    addMetrics(accB, r.sideB);

    if (r.winner === 'A') { accA.wins += 1; pickedRounds += 1; }
    else if (r.winner === 'B') { accB.wins += 1; pickedRounds += 1; }
    else if (r.winner === 'tie') { ties += 1; pickedRounds += 1; }
  }

  const sides: SideTally[] = order.map((label) => {
    const a = map.get(label)!;
    return {
      label,
      wins: a.wins,
      avgResponseMs: a.msN > 0 ? Math.round(a.msSum / a.msN) : null,
      avgCostUsd: a.costN > 0 ? a.costSum / a.costN : null,
    };
  });

  return {
    totalRounds,
    pickedRounds,
    ties,
    sides,
    speedLeaderLabel: lowerLeader(sides, (s) => s.avgResponseMs),
    costLeaderLabel: lowerLeader(sides, (s) => s.avgCostUsd),
    qualityLeaderLabel: winsLeader(sides),
    target,
  };
}
