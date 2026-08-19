/**
 * evaluateExperimentOutcome — the recommendation HONORS THE GOAL of the test.
 *
 * This is the objective→verdict logic the analytics recommendation runs (DESIGN
 * §4.2-4.4), extracted pure. These tests prove the verdict is DRIVEN by the
 * experiment's pre-registered objective: which primary metric (and its
 * good-direction), the target that sets the power bar, each guardrail's veto, and
 * the weighted human battle pick as a distinct axis. The headline case: the SAME
 * variant data yields OPPOSITE verdicts under a quality objective vs a cost
 * objective — because the recommendation reads the goal, not a fixed metric.
 */

import {
  metricAxis,
  evaluateOutcomeGuardrail,
  mcnemarTest,
  evaluateExperimentOutcome,
  type VariantStats,
  type OutcomeObjective,
} from '../../lambda/src/lib/experiment-stats.js';

/** Build a variant's four continuous stats, overriding any of them. */
const vstats = (over: Partial<VariantStats> = {}): VariantStats => ({
  score: { n: 200, mean: 7, sd: 1 },
  latency: { n: 200, mean: 1000, sd: 100 },
  cost: { n: 200, mean: 0.008, sd: 0.001 },
  tokens: { n: 200, mean: 500, sd: 50 },
  ...over,
});

describe('metricAxis (which stat + good-direction a metric reads)', () => {
  test('quality/accuracy read score, higher is better', () => {
    expect(metricAxis('quality')).toMatchObject({ key: 'score', higherIsBetter: true });
    expect(metricAxis('accuracy')).toMatchObject({ key: 'score', higherIsBetter: true });
  });
  test('cost/latency read their own stat, LOWER is better', () => {
    expect(metricAxis('cost')).toMatchObject({ key: 'cost', higherIsBetter: false });
    expect(metricAxis('latency')).toMatchObject({ key: 'latency', higherIsBetter: false });
  });
});

describe('evaluateExperimentOutcome — the recommendation reads the objective', () => {
  test('absent objective defaults to quality-primary, no guardrails (backward compatible)', () => {
    const r = evaluateExperimentOutcome({
      control: vstats({ score: { n: 200, mean: 7, sd: 1 } }),
      treatment: vstats({ score: { n: 200, mean: 8, sd: 1 } }),
    });
    expect(r.primary.metric).toBe('quality');
    expect(r.guardrails).toEqual([]);
    expect(r.primary.favors).toBe('treatment');
  });

  test('SAME data, DIFFERENT objective yields OPPOSITE verdict (the core honors-the-goal proof)', () => {
    // Treatment: higher quality (8 vs 7) but higher cost (0.012 vs 0.008).
    const control = vstats({ score: { n: 200, mean: 7, sd: 1 }, cost: { n: 200, mean: 0.008, sd: 0.001 } });
    const treatment = vstats({ score: { n: 200, mean: 8, sd: 1 }, cost: { n: 200, mean: 0.012, sd: 0.001 } });

    const quality = evaluateExperimentOutcome({ control, treatment, objective: { metric: 'quality', target: 10 } });
    expect(quality.primary.metric).toBe('quality');
    expect(quality.primary.favors).toBe('treatment');
    expect(quality.verdict).toBe('promote_treatment');

    const cost = evaluateExperimentOutcome({ control, treatment, objective: { metric: 'cost', target: 10 } });
    expect(cost.primary.metric).toBe('cost/reply');
    expect(cost.primary.favors).toBe('control'); // lower cost is better; treatment is dearer
    expect(cost.verdict).toBe('keep_control');
  });

  test('cost objective: a cheaper treatment is favored (lower-is-better direction)', () => {
    const r = evaluateExperimentOutcome({
      control: vstats({ cost: { n: 200, mean: 0.010, sd: 0.001 } }),
      treatment: vstats({ cost: { n: 200, mean: 0.007, sd: 0.001 } }),
      objective: { metric: 'cost', target: 10 },
    });
    expect(r.primary.favors).toBe('treatment');
    expect(r.verdict).toBe('promote_treatment');
  });

  test('latency objective: a faster treatment is favored', () => {
    const r = evaluateExperimentOutcome({
      control: vstats({ latency: { n: 200, mean: 1200, sd: 100 } }),
      treatment: vstats({ latency: { n: 200, mean: 900, sd: 100 } }),
      objective: { metric: 'latency', target: 10 },
    });
    expect(r.primary.favors).toBe('treatment');
    expect(r.verdict).toBe('promote_treatment');
  });

  test('power is tied to objective.target: a tiny target underpowers to keep_running', () => {
    const control = vstats({ score: { n: 60, mean: 7, sd: 1 } });
    const treatment = vstats({ score: { n: 60, mean: 8, sd: 1 } });
    const tiny = evaluateExperimentOutcome({ control, treatment, objective: { metric: 'quality', target: 1 } });
    expect(tiny.primary.powered).toBe(false);
    expect(tiny.verdict).toBe('keep_running');
    const big = evaluateExperimentOutcome({ control, treatment, objective: { metric: 'quality', target: 10 } });
    expect(big.primary.powered).toBe(true);
    expect(big.verdict).toBe('promote_treatment');
  });

  test('a guardrail breach VETOES a ship the primary would otherwise win', () => {
    const control = vstats({ score: { n: 200, mean: 7, sd: 1 }, cost: { n: 200, mean: 0.008, sd: 0.0005 } });
    const treatment = vstats({ score: { n: 200, mean: 8, sd: 1 }, cost: { n: 200, mean: 0.012, sd: 0.0005 } });

    const noGuard = evaluateExperimentOutcome({ control, treatment, objective: { metric: 'quality', target: 10 } });
    expect(noGuard.verdict).toBe('promote_treatment');

    const guarded: OutcomeObjective = {
      metric: 'quality',
      target: 10,
      guardrails: [{ metric: 'cost', direction: 'no_worse_than', bound: 20 }],
    };
    const withGuard = evaluateExperimentOutcome({ control, treatment, objective: guarded });
    expect(withGuard.guardrails[0].held).toBe(false); // +50% cost is past the 20% bound
    expect(withGuard.guardrails[0].breached).toBe(true); // and significant
    expect(withGuard.verdict).toBe('keep_control'); // the veto flips the decision
  });

  test('a guardrail that HOLDS does not block a winner', () => {
    const control = vstats({ score: { n: 200, mean: 7, sd: 1 }, cost: { n: 200, mean: 0.008, sd: 0.0005 } });
    const treatment = vstats({ score: { n: 200, mean: 8, sd: 1 }, cost: { n: 200, mean: 0.0082, sd: 0.0005 } });
    const r = evaluateExperimentOutcome({
      control, treatment,
      objective: { metric: 'quality', target: 10, guardrails: [{ metric: 'cost', direction: 'no_worse_than', bound: 20 }] },
    });
    expect(r.guardrails[0].held).toBe(true);
    expect(r.verdict).toBe('promote_treatment');
  });

  test('no significant primary difference yields equivalent (an honest answer)', () => {
    const r = evaluateExperimentOutcome({
      control: vstats({ score: { n: 200, mean: 7.0, sd: 1 } }),
      treatment: vstats({ score: { n: 200, mean: 7.02, sd: 1 } }),
      objective: { metric: 'quality', target: 10 },
    });
    expect(r.primary.significant).toBe(false);
    expect(r.verdict).toBe('equivalent');
  });

  test('human battle pick that AGREES with the metric is flagged, never blended', () => {
    const r = evaluateExperimentOutcome({
      control: vstats({ score: { n: 200, mean: 7, sd: 1 } }),
      treatment: vstats({ score: { n: 200, mean: 8, sd: 1 } }),
      objective: { metric: 'quality', target: 10, humanPickWeight: 0.5 },
      battleWins: { treatment: 90, control: 10 },
    });
    expect(r.human?.significant).toBe(true);
    expect(r.humanAgrees).toBe(true);
    expect(r.humanConflicts).toBe(false);
    expect(r.verdict).toBe('promote_treatment'); // verdict is the metric's, not an average
  });

  test('human battle pick CONTRADICTING the metric is surfaced as a conflict, not averaged (INV-3)', () => {
    const r = evaluateExperimentOutcome({
      control: vstats({ score: { n: 200, mean: 7, sd: 1 } }),
      treatment: vstats({ score: { n: 200, mean: 8, sd: 1 } }),
      objective: { metric: 'quality', target: 10, humanPickWeight: 0.5 },
      battleWins: { treatment: 10, control: 90 },
    });
    expect(r.humanConflicts).toBe(true);
    expect(r.humanAgrees).toBe(false);
    expect(r.verdict).toBe('promote_treatment'); // metric still drives it
  });

  test('human pick with zero weight never enters the rule', () => {
    const r = evaluateExperimentOutcome({
      control: vstats({ score: { n: 200, mean: 7, sd: 1 } }),
      treatment: vstats({ score: { n: 200, mean: 8, sd: 1 } }),
      objective: { metric: 'quality', target: 10, humanPickWeight: 0 },
      battleWins: { treatment: 10, control: 90 },
    });
    expect(r.humanConflicts).toBe(false);
    expect(r.humanAgrees).toBe(false);
  });
});

describe('evaluateOutcomeGuardrail (direction x good-direction matrix)', () => {
  const control = vstats({ cost: { n: 200, mean: 0.010, sd: 0.0005 }, score: { n: 200, mean: 7, sd: 1 } });

  test('cost no_worse_than: a big significant rise is breached; a flat cost holds', () => {
    const dearer = evaluateOutcomeGuardrail(
      { metric: 'cost', direction: 'no_worse_than', bound: 10 },
      control,
      vstats({ cost: { n: 200, mean: 0.013, sd: 0.0005 } }),
    );
    expect(dearer.held).toBe(false);
    expect(dearer.breached).toBe(true);

    const flat = evaluateOutcomeGuardrail(
      { metric: 'cost', direction: 'no_worse_than', bound: 10 },
      control,
      vstats({ cost: { n: 200, mean: 0.0101, sd: 0.0005 } }),
    );
    expect(flat.held).toBe(true);
    expect(flat.breached).toBe(false);
  });

  test('quality at_least: treatment must clear an improvement floor', () => {
    const meetsFloor = evaluateOutcomeGuardrail(
      { metric: 'quality', direction: 'at_least', bound: 5 },
      control,
      vstats({ score: { n: 200, mean: 7.9, sd: 1 } }),
    );
    expect(meetsFloor.held).toBe(true);

    const belowFloor = evaluateOutcomeGuardrail(
      { metric: 'quality', direction: 'at_least', bound: 5 },
      control,
      vstats({ score: { n: 200, mean: 7.05, sd: 1 } }),
    );
    expect(belowFloor.held).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-inferiority guardrails (DESIGN §5.5).
//
// A `no_worse_than` guardrail is a claim that something did NOT get meaningfully worse. A point
// estimate cannot support that claim: on thin data a noisy estimate lands inside the bound by chance,
// and shipping on it means a regression ships precisely when there was too little data to catch it.
// Absence of evidence of harm is not evidence of no harm.
// ---------------------------------------------------------------------------
describe('guardrails require evidence of no harm, not absence of evidence of harm', () => {
  // Cost, lower-is-better. Bound: cost may rise at most 10%.
  const guard = { metric: 'cost' as const, direction: 'no_worse_than' as const, bound: 10 };

  it('THIN data: point estimate inside the bound, but the CI is too wide to claim it', () => {
    // Treatment looks ~2% more expensive. With n=3 and this spread the interval is enormous, so a
    // 40% regression is still consistent with the data. That must NOT read as "guardrail held".
    const control = { cost: { mean: 1.0, sd: 0.5, n: 3 } } as any;
    const treatment = { cost: { mean: 1.02, sd: 0.5, n: 3 } } as any;
    const r = evaluateOutcomeGuardrail(guard, control, treatment);

    expect(r.pointWithinBound).toBe(true);      // the old check would have shipped on this
    expect(r.held).toBe(false);                 // non-inferiority is NOT established
    expect(r.breached).toBe(false);             // nor is a regression proven
    expect(r.indeterminate).toBe(true);         // the honest state: not enough evidence
  });

  it('a guardrail that cannot be claimed BLOCKS a ship the primary would otherwise win', () => {
    // The failure this prevents: a cheaper model shipping on ignorance about what it cost in quality.
    const control = { score: { mean: 50, sd: 5, n: 400 }, cost: { mean: 1.0, sd: 0.5, n: 3 } } as any;
    const treatment = { score: { mean: 62, sd: 5, n: 400 }, cost: { mean: 1.02, sd: 0.5, n: 3 } } as any;
    const out = evaluateExperimentOutcome({
      control,
      treatment,
      objective: { metric: 'quality', target: 10, guardrails: [guard] } as any,
    });
    expect(out.primary.significant).toBe(true);       // the primary genuinely won
    expect(out.guardrails[0].indeterminate).toBe(true);
    expect(out.verdict).not.toBe('promote_treatment'); // and it still must not ship
  });

  it('WELL-POWERED and genuinely flat: the guardrail is held and does not block', () => {
    // The counterpart. Enough data to prove the cost difference is inside the margin.
    const control = { cost: { mean: 1.0, sd: 0.02, n: 500 } } as any;
    const treatment = { cost: { mean: 1.005, sd: 0.02, n: 500 } } as any;
    const r = evaluateOutcomeGuardrail(guard, control, treatment);
    expect(r.held).toBe(true);
    expect(r.indeterminate).toBe(false);
    expect(r.breached).toBe(false);
  });

  it('WELL-POWERED and genuinely worse: still breached, unchanged from before', () => {
    const control = { cost: { mean: 1.0, sd: 0.02, n: 500 } } as any;
    const treatment = { cost: { mean: 1.4, sd: 0.02, n: 500 } } as any;
    const r = evaluateOutcomeGuardrail(guard, control, treatment);
    expect(r.breached).toBe(true);
    expect(r.held).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A breach is significance against the MARGIN, never against zero.
//
// A guardrail states a bound, so the only question it asks is where the difference sits relative to
// THAT bound. Testing the p-value against zero answers a different question, and answers it wrongly in
// both directions: it calls a proven improvement that merely misses a floor a "significant" breach,
// and it calls a cost overrun a breach on evidence that only rules out zero. Both reach an operator as
// a ship or no-ship recommendation, which is why these are pinned case by case.
// ---------------------------------------------------------------------------
describe('a guardrail breach is proven against the bound, not against zero', () => {
  const quality = { metric: 'quality' as const, direction: 'at_least' as const, bound: 5 };
  const cost = { metric: 'cost' as const, direction: 'no_worse_than' as const, bound: 10 };

  it('a significant IMPROVEMENT whose interval still reaches the floor is not a breach', () => {
    // +3% quality against a +5% floor, significant against zero (CI roughly [+0.2%, +5.8%], p ~ 0.035).
    // Tested against zero this was "past its 5% bound (significant)" and vetoed the ship: a real
    // improvement reported to an operator as a significant regression. The interval still reaches the
    // floor, so the honest state is that the guardrail is not established either way.
    const r = evaluateOutcomeGuardrail(
      quality,
      vstats({ score: { n: 100, mean: 100, sd: 10 } }),
      vstats({ score: { n: 100, mean: 103, sd: 10 } }),
    );
    expect(r.deltaPct).toBe(3);
    expect(r.pointWithinBound).toBe(false); // below the floor on the point estimate
    expect(r.breached).toBe(false);         // and NOT proven below it
    expect(r.held).toBe(false);
    expect(r.indeterminate).toBe(true);
  });

  it('an improvement that clears the floor holds and is never a breach', () => {
    const r = evaluateOutcomeGuardrail(
      quality,
      vstats({ score: { n: 400, mean: 100, sd: 5 } }),
      vstats({ score: { n: 400, mean: 108, sd: 5 } }),
    );
    expect(r.held).toBe(true);
    expect(r.breached).toBe(false);
  });

  it('a FLAT result against an improvement floor is a breach, and p against zero read 1', () => {
    // The symmetric hole: with no difference at all, the p-value against zero is 1, so nothing could
    // ever breach an `at_least` guardrail however far short of the floor the result sat. Against the
    // margin, a tight interval around zero proves the +5% floor was missed.
    const r = evaluateOutcomeGuardrail(
      quality,
      vstats({ score: { n: 200, mean: 100, sd: 1 } }),
      vstats({ score: { n: 200, mean: 100, sd: 1 } }),
    );
    expect(r.deltaPct).toBe(0);
    expect(r.breached).toBe(true);
    expect(r.direction).toBe('at_least'); // so a caller narrates a MISSED FLOOR, not a regression
    expect(r.held).toBe(false);
  });

  it('a cost overrun that is significant vs zero but not vs the margin is not a breach', () => {
    // +12% cost against a 10% bound, interval roughly [+0.9%, +23.1%]. Significant against zero and
    // entirely consistent with sitting inside the bound, yet it was narrated as proven past it.
    const r = evaluateOutcomeGuardrail(
      cost,
      vstats({ cost: { n: 50, mean: 1.0, sd: 0.28 } }),
      vstats({ cost: { n: 50, mean: 1.12, sd: 0.28 } }),
    );
    expect(r.deltaPct).toBe(12);
    expect(r.pointWithinBound).toBe(false);
    expect(r.breached).toBe(false);
    expect(r.indeterminate).toBe(true);
  });

  it('a cost overrun proven past the margin IS a breach, and still vetoes a ship', () => {
    // The case the guardrail exists for: the whole interval beyond the bound. Removing the p-value
    // must not remove the veto.
    const control = vstats({ cost: { n: 500, mean: 1.0, sd: 0.02 }, score: { n: 500, mean: 50, sd: 5 } });
    const treatment = vstats({ cost: { n: 500, mean: 1.4, sd: 0.02 }, score: { n: 500, mean: 62, sd: 5 } });
    const r = evaluateOutcomeGuardrail(cost, control, treatment);
    expect(r.breached).toBe(true);
    expect(r.direction).toBe('no_worse_than');
    expect(r.held).toBe(false);

    const out = evaluateExperimentOutcome({
      control,
      treatment,
      objective: { metric: 'quality', target: 5, guardrails: [cost] },
    });
    expect(out.primary.significant).toBe(true);   // the primary genuinely won
    expect(out.verdict).toBe('keep_control');     // and the breach still vetoes the ship
  });

  it('held and breached are the two ends of one comparison, so never both', () => {
    const cases: Array<[number, number]> = [[1.0, 1.0], [1.0, 1.05], [1.0, 1.12], [1.0, 1.4], [1.0, 0.5]];
    for (const [c, t] of cases) {
      for (const g of [cost, { ...cost, direction: 'at_least' as const }]) {
        const r = evaluateOutcomeGuardrail(
          g,
          vstats({ cost: { n: 200, mean: c, sd: 0.1 } }),
          vstats({ cost: { n: 200, mean: t, sd: 0.1 } }),
        );
        expect(r.held && r.breached).toBe(false);
        expect(r.indeterminate).toBe(!r.held && !r.breached);
      }
    }
  });
});

describe('mcnemarTest (paired classifier comparison, DESIGN §5.3)', () => {
  it('returns null when the models never disagree - a real finding, not a 50/50 result', () => {
    // "Do not bother splitting traffic": no online experiment could detect a difference either.
    expect(mcnemarTest(0, 0)).toBeNull();
  });

  it('uses ONLY discordant pairs, so agreements cannot dilute the signal', () => {
    // 70 challenger-only vs 30 incumbent-only. The 900 agreements are irrelevant and absent here.
    const r = mcnemarTest(70, 30)!;
    expect(r.picks).toBe(100);
    expect(r.winRate).toBeCloseTo(0.7, 5);
    expect(r.significant).toBe(true);
  });

  it('a small lopsided discordant set is not called decisive', () => {
    const r = mcnemarTest(3, 0)!;
    expect(r.picks).toBe(3);
    expect(r.significant).toBe(false);
  });
});
