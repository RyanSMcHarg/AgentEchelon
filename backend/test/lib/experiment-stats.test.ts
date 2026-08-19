/**
 * experiment-stats — unit tests (DESIGN-EXPERIMENTS-BATTLE §4, Appendix A.6).
 *
 * The module is pure, dependency-free math, so these assert CLOSED-FORM answers
 * (textbook Wilson / z / Fisher / Welch / t-critical / power values) and the
 * honest degenerate-case contracts — no AWS mocking needed. Where a value is a
 * well-known constant (t*(df=1)=12.706, 95% Wilson[5/10]≈[.237,.763], ~385/arm
 * for a 0.10 lift off 0.50) it is checked to a tight tolerance; elsewhere the
 * invariants (monotonicity, bounds, orientation, symmetry) are checked.
 */

import {
  normalCdf,
  normalTwoSidedP,
  normalInv,
  studentTTwoSidedP,
  studentTCritical,
  wilsonInterval,
  twoProportionTest,
  welchTTest,
  poolGroups,
  requiredSampleForProportion,
  requiredSampleForMean,
  winnerLabel,
  mapConfidence,
  humanPickTest,
  decideVerdict,
  evaluateExperimentOutcome,
  type PrimaryEval,
  type GuardrailEval,
  type VariantStats,
} from '../../lambda/src/lib/experiment-stats.js';

const near = (actual: number, expected: number, tol = 1e-3) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe('special functions', () => {
  test('normalCdf matches known standard-normal values', () => {
    near(normalCdf(0), 0.5);
    near(normalCdf(1.959963985), 0.975, 1e-4);
    near(normalCdf(-1.959963985), 0.025, 1e-4);
    near(normalCdf(1), 0.8413447, 1e-4);
    near(normalCdf(-2.575829304), 0.005, 1e-4);
  });

  test('normalCdf is monotone increasing and bounded (0,1)', () => {
    let prev = 0;
    for (let x = -5; x <= 5; x += 0.5) {
      const v = normalCdf(x);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test('normalTwoSidedP: z=1.96 ⇒ ~0.05, z=2.576 ⇒ ~0.01, z=0 ⇒ 1', () => {
    near(normalTwoSidedP(1.959963985), 0.05, 1e-4);
    near(normalTwoSidedP(2.575829304), 0.01, 1e-4);
    expect(normalTwoSidedP(0)).toBe(1);
    // Sign-independent (two-sided).
    expect(normalTwoSidedP(-3)).toBeCloseTo(normalTwoSidedP(3), 12);
  });

  test('normalInv inverts normalCdf and hits known quantiles', () => {
    near(normalInv(0.975), 1.959963985, 1e-4);
    near(normalInv(0.5), 0, 1e-6);
    near(normalInv(0.025), -1.959963985, 1e-4);
    near(normalInv(0.8), 0.8416212, 1e-4);
    // Round-trip.
    for (const p of [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
      near(normalCdf(normalInv(p)), p, 1e-5);
    }
    expect(normalInv(0)).toBe(-Infinity);
    expect(normalInv(1)).toBe(Infinity);
  });

  test('studentTTwoSidedP: t=0 ⇒ 1, large t ⇒ tiny, approaches normal as df→∞', () => {
    expect(studentTTwoSidedP(0, 10)).toBe(1);
    expect(studentTTwoSidedP(10, 20)).toBeLessThan(1e-6);
    // With large df the t tail ≈ the normal tail.
    near(studentTTwoSidedP(1.96, 1e6), 0.05, 2e-3);
    // Invalid df ⇒ conservative p=1.
    expect(studentTTwoSidedP(3, 0)).toBe(1);
  });

  test('studentTCritical hits textbook two-sided 95% values', () => {
    near(studentTCritical(1, 0.05), 12.7062, 1e-2); // df=1
    near(studentTCritical(2, 0.05), 4.3027, 1e-2); // df=2
    near(studentTCritical(10, 0.05), 2.2281, 1e-2); // df=10
    near(studentTCritical(1e6, 0.05), 1.959963985, 2e-3); // df→∞ ⇒ z
  });
});

describe('wilsonInterval', () => {
  test('n=0 ⇒ all zero', () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, lower: 0, upper: 0, n: 0 });
  });

  test('5/10 ⇒ symmetric center 0.5, known 95% CI ≈ [0.237, 0.763]', () => {
    const w = wilsonInterval(5, 10);
    near(w.point, 0.5, 1e-12);
    near(w.lower, 0.2366, 2e-3);
    near(w.upper, 0.7634, 2e-3);
  });

  test('point = successes/n and bounds stay within [0,1]', () => {
    for (const [s, n] of [[0, 10], [1, 10], [10, 10], [3, 7], [99, 100]] as const) {
      const w = wilsonInterval(s, n);
      near(w.point, s / n, 1e-12);
      expect(w.lower).toBeGreaterThanOrEqual(0);
      expect(w.upper).toBeLessThanOrEqual(1);
      expect(w.lower).toBeLessThanOrEqual(w.point);
      expect(w.upper).toBeGreaterThanOrEqual(w.point);
    }
  });
});

describe('twoProportionTest', () => {
  test('equal proportions ⇒ delta 0, p=1, z-method', () => {
    const r = twoProportionTest(50, 100, 50, 100);
    expect(r.delta).toBe(0);
    expect(r.method).toBe('z');
    near(r.pValue, 1, 1e-9);
    expect(r.ci[0]).toBeLessThan(0);
    expect(r.ci[1]).toBeGreaterThan(0);
  });

  test('large clear difference ⇒ z-method, highly significant, delta = pA − pB', () => {
    const r = twoProportionTest(80, 100, 50, 100);
    near(r.delta, 0.3, 1e-12);
    expect(r.method).toBe('z');
    expect(r.pValue).toBeLessThan(0.001);
    // CI on the difference excludes 0.
    expect(r.ci[0]).toBeGreaterThan(0);
  });

  test('small cell counts fall back to Fisher exact', () => {
    const r = twoProportionTest(1, 10, 0, 10);
    expect(r.method).toBe('fisher');
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThanOrEqual(1);
  });

  test('orientation: swapping A/B negates delta, same |p|', () => {
    const ab = twoProportionTest(80, 100, 50, 100);
    const ba = twoProportionTest(50, 100, 80, 100);
    near(ab.delta, -ba.delta, 1e-12);
    near(ab.pValue, ba.pValue, 1e-9);
  });
});

describe('welchTTest', () => {
  test('equal means ⇒ delta 0, p=1', () => {
    const r = welchTTest(10, 2, 30, 10, 2, 30);
    expect(r.delta).toBe(0);
    near(r.pValue, 1, 1e-9);
  });

  test('clear mean separation ⇒ significant, CI excludes 0', () => {
    const r = welchTTest(10, 2, 30, 8, 2, 30);
    near(r.delta, 2, 1e-12);
    expect(r.pValue).toBeLessThan(0.01);
    expect(r.ci[0]).toBeGreaterThan(0);
    expect(r.t).toBeGreaterThan(0);
    near(r.df, 58, 1); // equal n & sd ⇒ df ≈ 2(n-1)
  });

  test('too few samples / no variance ⇒ honest no-significance (p=1)', () => {
    expect(welchTTest(10, 0, 1, 8, 0, 1).pValue).toBe(1);
    expect(welchTTest(10, 0, 30, 8, 0, 30).pValue).toBe(1); // se=0
  });
});

describe('poolGroups', () => {
  test('empty ⇒ n=0', () => {
    expect(poolGroups([])).toEqual({ n: 0, mean: 0, sd: 0 });
    expect(poolGroups([{ n: 0, mean: 5, sd: 1 }])).toEqual({ n: 0, mean: 0, sd: 0 });
  });

  test('single group returns itself', () => {
    expect(poolGroups([{ n: 12, mean: 3.5, sd: 1.2 }])).toEqual({ n: 12, mean: 3.5, sd: 1.2 });
  });

  test('weighted mean + exact between/within SD decomposition', () => {
    // Two zero-variance groups at 0 and 10, n=10 each: grand mean 5,
    // SS = 10*25 + 10*25 = 500, sd = sqrt(500/19) ≈ 5.129.
    const p = poolGroups([{ n: 10, mean: 0, sd: 0 }, { n: 10, mean: 10, sd: 0 }]);
    expect(p.n).toBe(20);
    near(p.mean, 5, 1e-12);
    near(p.sd, Math.sqrt(500 / 19), 1e-9);
  });

  test('unequal-n weighted mean', () => {
    const p = poolGroups([{ n: 30, mean: 2, sd: 1 }, { n: 10, mean: 6, sd: 1 }]);
    expect(p.n).toBe(40);
    near(p.mean, (30 * 2 + 10 * 6) / 40, 1e-12); // = 3
  });
});

describe('power / MDE', () => {
  test('proportion: ~385 per arm for a 0.10 lift off 0.50 at 80% power', () => {
    const r = requiredSampleForProportion(0.5, 0.1, 100);
    expect(Math.abs(r.requiredN - 385)).toBeLessThanOrEqual(2);
    expect(r.powered).toBe(false);
    expect(r.additionalNeeded).toBe(r.requiredN - 100);
  });

  test('proportion: zero MDE ⇒ infinite requirement, never powered', () => {
    const r = requiredSampleForProportion(0.5, 0, 1000);
    expect(r.requiredN).toBe(Infinity);
    expect(r.powered).toBe(false);
    expect(r.additionalNeeded).toBe(Infinity);
  });

  test('proportion: enough current N ⇒ powered', () => {
    const r = requiredSampleForProportion(0.5, 0.1, 5000);
    expect(r.powered).toBe(true);
    expect(r.additionalNeeded).toBe(0);
  });

  test('mean: ~63 per arm to detect a 1.0 shift at sd 2, 80% power', () => {
    const r = requiredSampleForMean(2, 1, 10);
    expect(Math.abs(r.requiredN - 63)).toBeLessThanOrEqual(2);
    expect(r.powered).toBe(false);
  });

  test('mean: no variance ⇒ trivially powered with tiny N', () => {
    const r = requiredSampleForMean(0, 1, 10);
    expect(r.requiredN).toBe(2);
    expect(r.powered).toBe(true);
  });
});

describe('winnerLabel', () => {
  test('significance thresholds', () => {
    expect(winnerLabel(0.3, [0.2, 0.4], 0.004)).toBe('leads (p<0.01)');
    expect(winnerLabel(0.3, [0.05, 0.55], 0.03)).toBe('leads (p<0.05)');
  });

  test('point lead on thin data ⇒ "leads (not significant)"', () => {
    expect(winnerLabel(0.5, [-0.1, 1.1], 0.2)).toBe('leads (not significant)');
  });

  test('negligible + CI straddles 0 ⇒ "no difference"', () => {
    expect(winnerLabel(0.0, [-0.2, 0.2], 0.9, 0.05)).toBe('no difference');
  });
});

describe('mapConfidence', () => {
  test('high needs p<0.01 AND powered AND guardrails held', () => {
    expect(mapConfidence({ primaryPValue: 0.005, powered: true, guardrailsHeld: true })).toBe('high');
    expect(mapConfidence({ primaryPValue: 0.005, powered: false, guardrailsHeld: true })).toBe('medium');
    expect(mapConfidence({ primaryPValue: 0.005, powered: true, guardrailsHeld: false })).toBe('low');
  });

  test('medium at p<0.05 with guardrails held; low otherwise', () => {
    expect(mapConfidence({ primaryPValue: 0.03, powered: true, guardrailsHeld: true })).toBe('medium');
    expect(mapConfidence({ primaryPValue: 0.03, powered: true, guardrailsHeld: false })).toBe('low');
    expect(mapConfidence({ primaryPValue: 0.2, powered: true, guardrailsHeld: true })).toBe('low');
  });
});

describe('humanPickTest', () => {
  test('no decisive picks ⇒ neutral, not significant', () => {
    const r = humanPickTest(0, 0);
    expect(r).toMatchObject({ picks: 0, wins: 0, winRate: 0, significant: false, favors: 'none' });
  });

  test('8/10 favors A but is NOT significant (Wilson lower < 0.5)', () => {
    const r = humanPickTest(8, 10);
    near(r.winRate, 0.8, 1e-12);
    expect(r.favors).toBe('a');
    expect(r.ci[0]).toBeLessThan(0.5);
    expect(r.significant).toBe(false);
  });

  test('90/100 favors A and IS significant', () => {
    const r = humanPickTest(90, 100);
    expect(r.favors).toBe('a');
    expect(r.significant).toBe(true);
    expect(r.ci[0]).toBeGreaterThan(0.5);
    expect(r.pValue).toBeLessThan(0.001);
  });

  test('minority picks favor B; even split favors none', () => {
    expect(humanPickTest(2, 10).favors).toBe('b');
    expect(humanPickTest(5, 10).favors).toBe('none');
  });
});

describe('decideVerdict', () => {
  const primary = (over: Partial<PrimaryEval> = {}): PrimaryEval => ({
    metric: 'accuracy',
    deltaPct: 5,
    ci: [1, 9],
    pValue: 0.005,
    significant: true,
    powered: true,
    favors: 'treatment',
    ...over,
  });
  const heldGuard: GuardrailEval = { metric: 'cost', deltaPct: 1, bound: 10, held: true, breached: false, pointWithinBound: true, indeterminate: false };
  const breachedGuard: GuardrailEval = { metric: 'cost', deltaPct: 40, bound: 10, held: false, breached: true, pointWithinBound: false, indeterminate: false };

  test('underpowered ⇒ keep_running (regardless of point estimate)', () => {
    const r = decideVerdict({ primary: primary({ powered: false }), guardrails: [heldGuard] });
    expect(r.verdict).toBe('keep_running');
    expect(r.confidence).toBe('low');
  });

  test('guardrail breach vetoes a ship ⇒ keep_control', () => {
    const r = decideVerdict({ primary: primary(), guardrails: [breachedGuard] });
    expect(r.verdict).toBe('keep_control');
  });

  test('significant treatment win + guardrails held ⇒ promote_treatment', () => {
    const r = decideVerdict({ primary: primary(), guardrails: [heldGuard] });
    expect(r.verdict).toBe('promote_treatment');
    expect(r.confidence).toBe('high');
  });

  test('significant control win ⇒ keep_control', () => {
    const r = decideVerdict({ primary: primary({ favors: 'control' }), guardrails: [heldGuard] });
    expect(r.verdict).toBe('keep_control');
  });

  test('powered, no significant difference ⇒ equivalent', () => {
    const r = decideVerdict({
      primary: primary({ significant: false, favors: 'none', pValue: 0.4 }),
      guardrails: [heldGuard],
    });
    expect(r.verdict).toBe('equivalent');
  });

  test('human axis agreeing with the primary is flagged, never blended (INV-3)', () => {
    const r = decideVerdict({
      primary: primary(),
      guardrails: [heldGuard],
      human: { favors: 'treatment', significant: true },
      humanPickWeight: 0.5,
    });
    expect(r.verdict).toBe('promote_treatment'); // unchanged by the human axis
    expect(r.humanAgrees).toBe(true);
    expect(r.humanConflicts).toBe(false);
  });

  test('human axis contradicting the primary is surfaced as a conflict', () => {
    const r = decideVerdict({
      primary: primary(),
      guardrails: [heldGuard],
      human: { favors: 'control', significant: true },
      humanPickWeight: 0.5,
    });
    expect(r.verdict).toBe('promote_treatment'); // verdict still driven by the metric
    expect(r.humanConflicts).toBe(true);
    expect(r.humanAgrees).toBe(false);
  });

  test('human axis with zero weight never enters the rule', () => {
    const r = decideVerdict({
      primary: primary(),
      guardrails: [heldGuard],
      human: { favors: 'control', significant: true },
      humanPickWeight: 0,
    });
    expect(r.humanConflicts).toBe(false);
    expect(r.humanAgrees).toBe(false);
  });
});

describe('evaluateExperimentOutcome — zero-baseline guard', () => {
  // A four-metric variant with the same GroupStat on every axis except the one
  // under test (quality reads `score`), so only the primary matters here.
  const variant = (score: { n: number; mean: number; sd: number }): VariantStats => ({
    score,
    latency: { n: score.n, mean: 1, sd: 1 },
    cost: { n: score.n, mean: 1, sd: 1 },
    tokens: { n: score.n, mean: 1, sd: 1 },
  });

  test('control primary mean 0 ⇒ deltaPct 0 and no NaN/Infinity leaks', () => {
    // Control's quality mean is exactly 0 — the deltaPct denominator. The guard
    // (c.mean !== 0 ? ... : 0) must yield 0 rather than dividing by zero, and no
    // downstream number may become NaN/Infinity.
    const out = evaluateExperimentOutcome({
      control: variant({ n: 30, mean: 0, sd: 1 }),
      treatment: variant({ n: 30, mean: 2, sd: 1 }),
    });

    // The zero-baseline guard collapses the percentage delta to exactly 0.
    expect(out.primary.deltaPct).toBe(0);

    // Every numeric the evaluation produced is finite (no NaN/Infinity leak).
    expect(Number.isFinite(out.primary.pValue)).toBe(true);
    expect(Number.isFinite(out.primary.ci[0])).toBe(true);
    expect(Number.isFinite(out.primary.ci[1])).toBe(true);

    // Verdict/confidence are well-formed enum strings, not NaN. The raw score
    // difference is real & significant with a zero-mean control, so the metric
    // favors treatment and the rule promotes it.
    expect(['promote_treatment', 'keep_control', 'keep_running', 'equivalent', 'inconclusive'])
      .toContain(out.verdict);
    expect(out.verdict).toBe('promote_treatment');
    expect(['low', 'medium', 'high']).toContain(out.confidence);
    expect(out.confidence).toBe('high');
    expect(out.primary.significant).toBe(true);
    expect(out.primary.favors).toBe('treatment');
  });
});

describe('poolGroups — degenerate-input exclusion', () => {
  test('drops n=0 and NaN-mean groups; pools only the valid one, result finite', () => {
    const pooled = poolGroups([
      { n: 10, mean: 5, sd: 1 },
      { n: 0, mean: NaN, sd: NaN }, // n=0 ⇒ dropped
      { n: 5, mean: NaN, sd: 1 }, // NaN mean ⇒ dropped
    ]);

    // Equivalent to pooling ONLY the first (valid) group.
    const onlyValid = poolGroups([{ n: 10, mean: 5, sd: 1 }]);
    expect(pooled).toEqual(onlyValid);

    // A single valid group with sd 1: n=10, mean=5, sd=1 (SS = 9*1 + 0 = 9;
    // sqrt(9/9) = 1). Everything finite — no NaN propagated from the dropped rows.
    expect(pooled).toEqual({ n: 10, mean: 5, sd: 1 });
    expect(Number.isFinite(pooled.n)).toBe(true);
    expect(Number.isFinite(pooled.mean)).toBe(true);
    expect(Number.isFinite(pooled.sd)).toBe(true);
  });
});
