/**
 * THE UNIT OF ANALYSIS IS THE CONVERSATION (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §4.2).
 *
 * An experiment enrolls a conversation for its life, so the counted turns of one conversation share a
 * person, a topic and a version, and are not independent samples. A test that counts them as independent
 * reports far more confidence than the data holds. These pin the clustered tests: correlated data on which
 * the per-exchange test declares significance and the per-conversation test does not; data with one
 * exchange per conversation, on which the two agree exactly; and the battle pick, whose unit is the duel.
 */
import {
  clusterMomentsOf,
  clusterDesignEffect,
  clusterAdjust,
  proportionDesignEffect,
  clusteredTwoProportionTest,
  clusteredHumanPickTest,
  clusteredMcnemarTest,
  twoProportionTest,
  humanPickTest,
  welchTTest,
  poolGroups,
  evaluateExperimentOutcome,
  type GroupStat,
  type VariantStats,
} from '../../lambda/src/lib/experiment-stats.js';
import { evaluateClassifierGate, informativeClusters } from '../../lambda/src/lib/classifier-gate.js';
import {
  duelPickClusters,
  approvalClustersByVariant,
  type BattleOutcomeItem,
  type FeedbackRecord,
} from '../../lambda/src/analytics-aurora/variant-feedback.js';

/** Sample mean, sd and n of a flat list. */
function statOf(values: number[]): GroupStat {
  return poolGroups(values.map((v) => ({ n: 1, mean: v, sd: 0 })));
}

/**
 * Ten conversations per arm, twenty exchanges each. Each conversation has its own level (people differ a
 * lot), and its exchanges sit within a point of it (one person is consistent). The treatment's
 * conversations are five points higher. Per exchange that is 200 samples a side; per conversation, ten.
 */
const LEVELS = [50, 58, 66, 74, 82, 90, 98, 106, 114, 122];
function arm(shift: number): number[][] {
  return LEVELS.map((level) => Array.from({ length: 20 }, (_, j) => level + shift + ((j % 3) - 1) * 0.5));
}

describe('a continuous metric on correlated conversations', () => {
  const control = arm(0);
  const treatment = arm(5);
  const cStat = statOf(control.flat());
  const tStat = statOf(treatment.flat());

  it('the per-exchange Welch test calls the difference significant', () => {
    const r = welchTTest(tStat.mean, tStat.sd, tStat.n, cStat.mean, cStat.sd, cStat.n);
    expect(tStat.n).toBe(200);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('per conversation it is not: ten conversations a side cannot separate five points of a 24-point spread', () => {
    const cAdj = clusterAdjust(cStat, clusterDesignEffect(clusterMomentsOf(control)), 10);
    const tAdj = clusterAdjust(tStat, clusterDesignEffect(clusterMomentsOf(treatment)), 10);
    expect(cAdj.n).toBe(10);
    expect(cAdj.mean).toBeCloseTo(cStat.mean, 10); // the point estimate does not move
    const r = welchTTest(tAdj.mean, tAdj.sd, tAdj.n, cAdj.mean, cAdj.sd, cAdj.n);
    expect(r.pValue).toBeGreaterThan(0.05);
    expect(r.delta).toBeCloseTo(5, 6);
  });

  it('the design effect is close to the cluster size when people differ far more than their turns do', () => {
    const deff = clusterDesignEffect(clusterMomentsOf(control));
    expect(deff).toBeGreaterThan(15);
    expect(deff).toBeLessThanOrEqual(23);
  });

  it('the recommendation reaches no verdict on it: quality is not significant in conversation units', () => {
    const asVariant = (stat: GroupStat, groups: number[][]): VariantStats => {
      const deff = clusterDesignEffect(clusterMomentsOf(groups));
      const adj = clusterAdjust(stat, deff, groups.length);
      return { score: adj, latency: adj, cost: adj, tokens: adj, scoredCount: stat.n, unit: 'conversation' };
    };
    const clustered = evaluateExperimentOutcome({
      control: asVariant(cStat, control),
      treatment: asVariant(tStat, treatment),
      objective: { metric: 'quality' },
    });
    expect(clustered.primary.significant).toBe(false);
    expect(clustered.verdict).toBe('equivalent');

    // The same data counted per exchange promotes the treatment, which is the overstatement.
    const perExchange = evaluateExperimentOutcome({
      control: { score: cStat, latency: cStat, cost: cStat, tokens: cStat, scoredCount: 200 },
      treatment: { score: tStat, latency: tStat, cost: tStat, tokens: tStat, scoredCount: 200 },
      objective: { metric: 'quality' },
    });
    expect(perExchange.primary.significant).toBe(true);
    expect(perExchange.verdict).toBe('promote_treatment');
  });

  it('power is counted in conversations: a 5% target needs more conversations than ten', () => {
    const asVariant = (stat: GroupStat, groups: number[][]): VariantStats => {
      const adj = clusterAdjust(stat, clusterDesignEffect(clusterMomentsOf(groups)), groups.length);
      return { score: adj, latency: adj, cost: adj, tokens: adj, scoredCount: stat.n, unit: 'conversation' };
    };
    const r = evaluateExperimentOutcome({
      control: asVariant(cStat, control),
      treatment: asVariant(tStat, treatment),
      objective: { metric: 'quality', target: 5 },
    });
    expect(r.primary.powered).toBe(false);
    expect(r.verdict).toBe('keep_running');
  });
});

describe('one exchange per conversation: the clustered test IS the per-exchange test', () => {
  const values = [3, 7, 4, 9, 6, 5, 8, 2, 7, 6, 5, 4];
  const groups = values.map((v) => [v]);

  it('design effect exactly 1, and the adjusted stat is unchanged', () => {
    const m = clusterMomentsOf(groups);
    expect(clusterDesignEffect(m)).toBeCloseTo(1, 12);
    const s = statOf(values);
    const adj = clusterAdjust(s, clusterDesignEffect(m), groups.length);
    expect(adj.n).toBe(s.n);
    expect(adj.sd).toBeCloseTo(s.sd, 12);
    expect(adj.mean).toBeCloseTo(s.mean, 12);
  });

  it('a proportion: singleton clusters reproduce twoProportionTest', () => {
    const t = Array.from({ length: 55 }, (_, i) => ({ successes: i < 44 ? 1 : 0, n: 1 }));
    const c = Array.from({ length: 48 }, (_, i) => ({ successes: i < 30 ? 1 : 0, n: 1 }));
    expect(proportionDesignEffect(t)).toBeCloseTo(1, 12);
    const clustered = clusteredTwoProportionTest(t, c);
    const plain = twoProportionTest(44, 55, 30, 48);
    expect(clustered.pValue).toBeCloseTo(plain.pValue, 10);
    expect(clustered.ci[0]).toBeCloseTo(plain.ci[0], 10);
    expect(clustered.ci[1]).toBeCloseTo(plain.ci[1], 10);
    expect(clustered.unitsA).toBe(55);
  });

  it('a duel judged once each: the worked example 18 of 25 is unchanged', () => {
    const duels = Array.from({ length: 25 }, (_, i) => ({ successes: i < 18 ? 1 : 0, n: 1 }));
    const clustered = clusteredHumanPickTest(duels);
    const plain = humanPickTest(18, 25);
    expect(clustered.winRate).toBeCloseTo(0.72, 10);
    expect(clustered.ci[0]).toBeCloseTo(plain.ci[0], 10);
    expect(clustered.ci[1]).toBeCloseTo(plain.ci[1], 10);
    expect(clustered.pValue).toBeCloseTo(plain.pValue, 10);
    expect(clustered.significant).toBe(true);
    expect(clustered.units).toBe(25);
  });
});

describe('a rate on correlated conversations (user approval)', () => {
  // Ten conversations a side, ten votes each, and a person votes the same way on every reply.
  const allUp = { successes: 10, n: 10 };
  const allDown = { successes: 0, n: 10 };
  const treatment = [...Array(8).fill(allUp), ...Array(2).fill(allDown)];
  const control = [...Array(6).fill(allUp), ...Array(4).fill(allDown)];

  it('per vote, 80% against 60% over 100 votes a side is significant', () => {
    const r = twoProportionTest(80, 100, 60, 100);
    expect(r.ci[0]).toBeGreaterThan(0);
  });

  it('per conversation it is 8 people against 6, and not significant; the rates do not move', () => {
    const r = clusteredTwoProportionTest(treatment, control);
    expect(r.pA).toBeCloseTo(0.8, 10);
    expect(r.pB).toBeCloseTo(0.6, 10);
    expect(r.ci[0]).toBeLessThan(0);
    expect(r.pValue).toBeGreaterThan(0.05);
    expect(r.unitsA).toBe(10);
    expect(r.nA).toBe(100);
  });
});

describe('the battle pick: the unit is the duel', () => {
  it('ten people agreeing on ONE duel is one duel of evidence, not ten', () => {
    expect(humanPickTest(10, 10).significant).toBe(true);
    const r = clusteredHumanPickTest([{ successes: 10, n: 10 }]);
    expect(r.picks).toBe(10);
    expect(r.units).toBe(1);
    expect(r.winRate).toBe(1);
    expect(r.significant).toBe(false);
  });

  it('picks are grouped by battleId, ties and other experiments excluded, under the battle_wins predicate', () => {
    const at = '2026-05-15T00:00:00.000Z';
    const items: BattleOutcomeItem[] = [
      { battleId: 'b1', experimentId: 'exp', variantId: 'treatment', chosenAt: at, userSub: 'u1' },
      { battleId: 'b1', experimentId: 'exp', variantId: 'treatment', chosenAt: at, userSub: 'u2' },
      { battleId: 'b1', experimentId: 'exp', variantId: 'control', chosenAt: at, userSub: 'u3' },
      { battleId: 'b2', experimentId: 'exp', variantId: 'control', chosenAt: at, userSub: 'u1' },
      { battleId: 'b3', experimentId: 'exp', variantId: null, winner: 'tie', chosenAt: at, userSub: 'u1' },
      { battleId: 'b4', experimentId: 'other', variantId: 'treatment', chosenAt: at, userSub: 'u1' },
      { battleId: 'b5', experimentId: 'exp', variantId: 'treatment', chosenAt: '2020-01-01T00:00:00.000Z', userSub: 'u1' },
    ];
    const r = duelPickClusters(items, 'exp', Date.parse('2026-05-01'), Date.parse('2026-06-01'));
    expect(r.picks).toBe(4);
    expect(r.duels).toBe(2);
    expect(r.clusters).toEqual(expect.arrayContaining([{ successes: 2, n: 3 }, { successes: 0, n: 1 }]));
  });
});

describe('votes are grouped by the conversation they were cast in', () => {
  it('the latest vote per voter counts once, per (experiment, variant), clustered by channel', () => {
    const at = (d: number) => `2026-05-1${d}T00:00:00.000Z`;
    const items: FeedbackRecord[] = [
      { experimentId: 'exp', variantId: 'treatment', feedback: 'up', createdAt: at(4), userSub: 'u1', messageId: 'm1', channelArn: 'c1' },
      { experimentId: 'exp', variantId: 'treatment', feedback: 'down', createdAt: at(5), userSub: 'u1', messageId: 'm1', channelArn: 'c1' },
      { experimentId: 'exp', variantId: 'treatment', feedback: 'up', createdAt: at(4), userSub: 'u1', messageId: 'm2', channelArn: 'c1' },
      { experimentId: 'exp', variantId: 'treatment', feedback: 'up', createdAt: at(4), userSub: 'u2', messageId: 'm3', channelArn: 'c2' },
      { experimentId: 'exp', variantId: 'control', feedback: 'up', createdAt: at(4), userSub: 'u3', messageId: 'm4', channelArn: 'c3' },
    ];
    const map = approvalClustersByVariant(items, Date.parse('2026-05-01'), false, Date.parse('2026-06-01'));
    const t = map.get('exp::treatment')!;
    expect(t).toHaveLength(2);
    expect(t).toEqual(expect.arrayContaining([{ successes: 1, n: 2 }, { successes: 1, n: 1 }]));
    expect(map.get('exp::control')).toEqual([{ successes: 1, n: 1 }]);
  });
});

describe('the classifier gate: McNemar per conversation', () => {
  // Twelve informative disagreements, all won by the challenger. Unclustered that is decisive.
  const disagreement = (conversationId: string | null) => ({
    incumbentLabel: 'general', challengerLabel: 'research', trueLabel: 'research', conversationId,
  });

  it('twelve wins from twelve conversations is a challenger_better verdict', () => {
    const rows = Array.from({ length: 12 }, (_, i) => disagreement(`c${i}`));
    const gate = evaluateClassifierGate(rows, { minAdjudicated: 10 });
    expect(gate.informativeConversations).toBe(12);
    expect(gate.mcnemar?.significant).toBe(true);
    expect(gate.verdict).toBe('challenger_better');
  });

  it('the same twelve wins from ONE conversation are one conversation of evidence', () => {
    const rows = Array.from({ length: 12 }, () => disagreement('c1'));
    const gate = evaluateClassifierGate(rows, { minAdjudicated: 10 });
    expect(gate.informativeConversations).toBe(1);
    expect(gate.mcnemar?.significant).toBe(false);
    expect(gate.verdict).not.toBe('challenger_better');
  });

  it('a pair with no conversation is its own cluster, and concordant or both-wrong pairs are not counted', () => {
    const rows = [
      disagreement(null),
      disagreement(null),
      { incumbentLabel: 'general', challengerLabel: 'general', trueLabel: null, conversationId: 'c9' },
      { incumbentLabel: 'general', challengerLabel: 'research', trueLabel: 'coding', conversationId: 'c9' },
    ];
    expect(informativeClusters(rows)).toEqual([{ successes: 1, n: 1 }, { successes: 1, n: 1 }]);
    expect(clusteredMcnemarTest([])).toBeNull();
  });
});
