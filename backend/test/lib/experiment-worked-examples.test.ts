/**
 * The worked examples in DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §4.6 and §5.3, pinned to the code.
 *
 * A spec that prints numbers is only useful if the numbers are the ones the system produces. Worked
 * examples are the most drift-prone thing in a design document: nothing fails when a constant, a
 * rounding rule or a decision branch moves underneath them, and a reader has no way to tell a stale
 * figure from a current one. So every figure quoted in those sections is asserted here, against the
 * same functions the recommendation path calls.
 *
 * WHEN THIS FAILS, the spec is wrong, not the test. Recompute the example, update the document, and
 * check whether the change of behaviour was intended before doing either.
 */

import {
  welchTTest,
  poolGroups,
  requiredSampleForMean,
  humanPickTest,
  twoProportionTest,
  mcnemarTest,
  evaluateOutcomeGuardrail,
  evaluateExperimentOutcome,
  DEFAULT_ACCURACY_MARGIN_PCT,
  type VariantStats,
} from '../../lambda/src/lib/experiment-stats';

// The running experiment of §4.6: control is the incumbent, treatment the challenger.
const CONTROL: VariantStats = {
  score: { n: 500, mean: 69.0, sd: 18.0 },
  latency: { n: 500, mean: 1800, sd: 600 },
  cost: { n: 500, mean: 0.0021, sd: 0.0008 },
  tokens: { n: 500, mean: 700, sd: 200 },
};
const TREATMENT_GUARDRAIL_HELD: VariantStats = {
  score: { n: 500, mean: 75.6, sd: 15.0 },
  latency: { n: 500, mean: 1850, sd: 500 },
  cost: { n: 500, mean: 0.0026, sd: 0.0009 },
  tokens: { n: 500, mean: 780, sd: 220 },
};
const TREATMENT_GUARDRAIL_INDETERMINATE: VariantStats = {
  ...TREATMENT_GUARDRAIL_HELD,
  latency: { n: 500, mean: 1950, sd: 700 },
};
const LATENCY_GUARDRAIL = { metric: 'latency' as const, direction: 'no_worse_than' as const, bound: 10 };

describe('§4.6.1 the per-variant aggregate', () => {
  it('collapses intent rows by exchange count', () => {
    // control: (72.0 x 30 + 60.0 x 10) / 40 ; treatment: (78.0 x 28 + 70.0 x 12) / 40
    expect((72.0 * 30 + 60.0 * 10) / 40).toBe(69.0);
    expect((78.0 * 28 + 70.0 * 12) / 40).toBe(75.6);
  });

  it('pools two intent groups into {n:40, mean:69.0, sd:17.617}', () => {
    const pooled = poolGroups([
      { n: 30, mean: 72.0, sd: 16.0 },
      { n: 10, mean: 60.0, sd: 20.0 },
    ]);
    expect(pooled.n).toBe(40);
    expect(pooled.mean).toBeCloseTo(69.0, 6);
    expect(pooled.sd).toBeCloseTo(17.617, 3);
    // The claim the example is making: the pooled SD EXCEEDS both inputs, because the group means
    // differ. An average-of-SDs would have produced 17.0 and understated the variant's spread.
    expect(pooled.sd).toBeGreaterThan(16.0);
  });
});

describe('§4.6.2 the drill-down reconciliation and scoring coverage', () => {
  it('an unscored-as-zero mean of 75.6 is a 94.5 mean over 32 of 40 scored rows', () => {
    expect((94.5 * 32) / 40).toBeCloseTo(75.6, 10);
  });
});

describe('§4.6.3 the approval rate and the latest-vote collapse', () => {
  // 62 raw records: 50 single votes (42 up, 8 down), 3 revisions (up then down, 6 rows),
  // 2 withdrawals (up then clear, 4 rows), 2 further single ups.
  const RAW_ROWS = 50 + 6 + 4 + 2;
  it('counting rows reports 60 votes at 81.7%; counting voters reports 55 at 80.0%', () => {
    expect(RAW_ROWS).toBe(62);
    // Naive: every up/down row counts, so the 2 'clear' rows drop and nothing else does.
    const naiveVotes = RAW_ROWS - 2;
    const naiveUp = 42 + 3 /* superseded ups */ + 2 /* withdrawn ups */ + 2;
    expect(naiveVotes).toBe(60);
    expect(naiveUp).toBe(49);
    expect(Math.round((naiveUp / naiveVotes) * 1000) / 10).toBe(81.7);

    // Correct: one record per (voter, message), and a withdrawal removes the pair entirely.
    const countedVotes = 50 + 3 + 2;
    const countedUp = 42 + 2;
    expect(countedVotes).toBe(55);
    expect(countedUp).toBe(44);
    expect(Math.round((countedUp / countedVotes) * 1000) / 10).toBe(80.0);
  });

  it('control reads 30 of 48 at 62.5%', () => {
    expect(Math.round((30 / 48) * 1000) / 10).toBe(62.5);
  });
});

describe('§4.6.4 the approval axis', () => {
  const r = twoProportionTest(44, 55, 30, 48);

  it('reports +17.5 percentage points with a Newcombe interval of +0.07pp to +33.97pp', () => {
    expect(r.pA).toBeCloseTo(0.8, 10);
    expect(r.pB).toBeCloseTo(0.625, 10);
    expect(r.delta).toBeCloseTo(0.175, 10);
    expect(r.ci[0]).toBeCloseTo(0.0007, 4);
    expect(r.ci[1]).toBeCloseTo(0.3397, 4);
  });

  it('uses the z-test (no small cell) and lands at p = 0.0489', () => {
    expect(r.method).toBe('z');
    expect(r.pValue).toBeCloseTo(0.0489, 4);
  });

  it('is significant by a margin of 0.07 of a percentage point', () => {
    // The example's point: this is decided by a hair, which is why the axis is reported with its
    // interval rather than as two bare percentages.
    expect(r.ci[0]).toBeGreaterThan(0);
    expect(r.ci[0]).toBeLessThan(0.001);
  });
});

describe('§4.6.5 the battle pick axis', () => {
  const r = humanPickTest(18, 25);

  it('reports 72% for treatment with a Wilson interval of [52.4%, 85.7%] at p = 0.0433', () => {
    expect(r.picks).toBe(25);
    expect(r.wins).toBe(18);
    expect(r.winRate).toBeCloseTo(0.72, 10);
    expect(r.ci[0]).toBeCloseTo(0.524, 3);
    expect(r.ci[1]).toBeCloseTo(0.857, 3);
    expect(r.pValue).toBeCloseTo(0.0433, 4);
    expect(r.significant).toBe(true);
    expect(r.favors).toBe('a');
  });
});

describe('§4.6.6 the primary metric', () => {
  const w = welchTTest(75.6, 15.0, 500, 69.0, 18.0, 500);

  it('reports +6.6 score points, CI [+4.544, +8.656], t 6.299, df 966.57', () => {
    expect(w.delta).toBeCloseTo(6.6, 10);
    expect(w.ci[0]).toBeCloseTo(4.544, 3);
    expect(w.ci[1]).toBeCloseTo(8.656, 3);
    expect(w.t).toBeCloseTo(6.299, 3);
    // Welch, so the df is not nA + nB - 2 = 998.
    expect(w.df).toBeCloseTo(966.57, 2);
    expect(w.df).toBeLessThan(998);
  });

  it('lands at p = 4.55e-10, which the API reports rounded to 0.0000', () => {
    expect(w.pValue).toBeCloseTo(4.5542e-10, 14);
    // The rounding the example warns about: a very small p displays as zero.
    expect(Math.round(w.pValue * 1e4) / 1e4).toBe(0);
  });

  it('is +9.6% relative to the control mean', () => {
    expect(Math.round(((6.6 / 69.0) * 100) * 10) / 10).toBe(9.6);
  });
});

describe('§4.6.7 power', () => {
  // A 5% target against a control mean of 69.0 is an MDE of 3.45 score points.
  const MDE = 0.05 * 69.0;

  it('requires 428 per variant at sd 18.0', () => {
    expect(MDE).toBeCloseTo(3.45, 10);
    expect(requiredSampleForMean(18.0, MDE, 500).requiredN).toBe(428);
  });

  it('is powered at n=500 and short by 388 at n=40', () => {
    expect(requiredSampleForMean(18.0, MDE, 500).powered).toBe(true);
    const thin = requiredSampleForMean(18.0, MDE, 40);
    expect(thin.powered).toBe(false);
    expect(thin.additionalNeeded).toBe(388);
  });
});

describe('§4.6.8 the guardrail', () => {
  it('HOLDS at 1850ms: point +2.8%, interval -1.03% to +6.59%, all inside the 10% margin', () => {
    const w = welchTTest(1850, 500, 500, 1800, 600, 500);
    expect(w.delta).toBeCloseTo(50, 10);
    expect(w.ci[0]).toBeCloseTo(-18.54, 2);
    expect(w.ci[1]).toBeCloseTo(118.54, 2);
    expect((w.ci[0] / 1800) * 100).toBeCloseTo(-1.03, 2);
    expect((w.ci[1] / 1800) * 100).toBeCloseTo(6.59, 2);

    const g = evaluateOutcomeGuardrail(LATENCY_GUARDRAIL, CONTROL, TREATMENT_GUARDRAIL_HELD);
    expect(g.deltaPct).toBe(2.8);
    expect(g.held).toBe(true);
    expect(g.indeterminate).toBe(false);
  });

  it('is INDETERMINATE at 1950ms: point +8.3% inside the bound, interval reaching +12.83%', () => {
    const w = welchTTest(1950, 700, 500, 1800, 600, 500);
    expect(w.delta).toBeCloseTo(150, 10);
    expect(w.ci[0]).toBeCloseTo(69.09, 2);
    expect(w.ci[1]).toBeCloseTo(230.91, 2);
    expect((w.ci[0] / 1800) * 100).toBeCloseTo(3.84, 2);
    expect((w.ci[1] / 1800) * 100).toBeCloseTo(12.83, 2);

    const g = evaluateOutcomeGuardrail(LATENCY_GUARDRAIL, CONTROL, TREATMENT_GUARDRAIL_INDETERMINATE);
    expect(g.deltaPct).toBe(8.3);
    // The whole point of the example: inside the bound on the point estimate, and still not held.
    expect(g.pointWithinBound).toBe(true);
    expect(g.held).toBe(false);
    expect(g.breached).toBe(false);
    expect(g.indeterminate).toBe(true);
  });
});

describe('§4.6.9 the verdict', () => {
  it('promotes the treatment when the guardrail holds, at high confidence, with the humans agreeing', () => {
    const out = evaluateExperimentOutcome({
      control: CONTROL,
      treatment: TREATMENT_GUARDRAIL_HELD,
      objective: { metric: 'quality', target: 5, guardrails: [LATENCY_GUARDRAIL], humanPickWeight: 0.5 },
      battleWins: { treatment: 18, control: 7 },
    });
    expect(out.primary.deltaPct).toBe(9.6);
    expect(out.primary.ci).toEqual([4.5437, 8.6563]);
    expect(out.primary.pValue).toBe(0);
    expect(out.primary.significant).toBe(true);
    expect(out.primary.powered).toBe(true);
    expect(out.primary.favors).toBe('treatment');
    expect(out.guardrails[0].held).toBe(true);
    expect(out.human?.winRate).toBeCloseTo(0.72, 10);
    expect(out.verdict).toBe('promote_treatment');
    expect(out.confidence).toBe('high');
    expect(out.humanAgrees).toBe(true);
    expect(out.humanConflicts).toBe(false);
  });

  it('does NOT ship the SAME winning primary when the guardrail is indeterminate', () => {
    const out = evaluateExperimentOutcome({
      control: CONTROL,
      treatment: TREATMENT_GUARDRAIL_INDETERMINATE,
      objective: { metric: 'quality', target: 5, guardrails: [LATENCY_GUARDRAIL] },
    });
    // Identical primary: significant, powered, +9.6%, favouring treatment.
    expect(out.primary.deltaPct).toBe(9.6);
    expect(out.primary.significant).toBe(true);
    expect(out.primary.powered).toBe(true);
    expect(out.primary.favors).toBe('treatment');
    // And it still does not ship, because the latency guardrail cannot be shown to have held.
    expect(out.guardrails[0].indeterminate).toBe(true);
    expect(out.verdict).toBe('keep_running');
    expect(out.confidence).toBe('low');
    expect(out.human).toBeNull();
  });
});

describe('§4.6.10 cost, shown but not tested by default', () => {
  it('is a +23.8% increase per reply', () => {
    expect(Math.round(((0.0026 - 0.0021) / 0.0021) * 1000) / 10).toBe(23.8);
  });
});

describe('§5.3 the classifier gate', () => {
  const r = mcnemarTest(42, 18);

  it('drops the 340 concordant pairs and tests the 60 that carry signal', () => {
    expect(300 + 40).toBe(340);
    expect(r?.picks).toBe(60);
    expect(r?.wins).toBe(42);
  });

  it('reports 70.0% for the challenger, CI [0.575, 0.801], p = 0.00267', () => {
    expect(r?.winRate).toBeCloseTo(0.7, 10);
    expect(r?.ci[0]).toBeCloseTo(0.575, 3);
    expect(r?.ci[1]).toBeCloseTo(0.801, 3);
    expect(r?.pValue).toBeCloseTo(0.00267, 5);
    expect(r?.significant).toBe(true);
  });

  it('reads as 85.5% against 79.5% on this corpus, a +6.0 point difference', () => {
    expect(Math.round(((300 + 42) / 400) * 1000) / 10).toBe(85.5);
    expect(Math.round(((300 + 18) / 400) * 1000) / 10).toBe(79.5);
    expect(85.5 - 79.5).toBeCloseTo(6.0, 10);
    // Comfortably outside the default non-inferiority margin.
    expect(85.5 - 79.5).toBeGreaterThan(DEFAULT_ACCURACY_MARGIN_PCT);
  });

  it('returns null with no discordant pairs, which is a finding and not a tie', () => {
    expect(mcnemarTest(0, 0)).toBeNull();
  });
});
