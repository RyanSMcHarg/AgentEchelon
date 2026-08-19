/**
 * The classification shadow gate (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5).
 *
 * What these pin is the counting and the ship criterion, which is where this can go quietly wrong:
 * a pair folded into the wrong cell, an unadjudicated queue treated as evidence, or a
 * non-inferiority claim resting on a point estimate. Each of those produces a plausible verdict from
 * data that does not support it, and the whole reason this gate exists is that the metric it
 * replaces was plausible in exactly that way.
 */

import {
  summarizeReplay,
  evaluateClassifierGate,
  gateAuthorisesSplit,
  MIN_ADJUDICATED_PAIRS,
  type ReplayLabel,
} from '../../lambda/src/lib/classifier-gate';

/** Agreement carries no comparative signal, whatever the truth. */
const agree = (label = 'general', n = 1): ReplayLabel[] =>
  Array.from({ length: n }, () => ({ incumbentLabel: label, challengerLabel: label }));

/** A disagreement, optionally adjudicated. */
const disagree = (trueLabel?: string | null, n = 1): ReplayLabel[] =>
  Array.from({ length: n }, () => ({
    incumbentLabel: 'general',
    challengerLabel: 'code_generation',
    trueLabel: trueLabel ?? null,
  }));

describe('summarizeReplay', () => {
  it('splits agreement from disagreement, and never queues an agreement', () => {
    const s = summarizeReplay([...agree('general', 300), ...disagree(null, 60)]);
    expect(s.total).toBe(360);
    expect(s.concordant).toBe(300);
    expect(s.discordant).toBe(60);
    // The economy of the design: the human queue is the disagreements, not the corpus.
    expect(s.pending).toBe(60);
    expect(s.adjudicated).toBe(0);
  });

  it('credits each adjudicated disagreement to the model that was right', () => {
    const s = summarizeReplay([
      ...disagree('code_generation', 42), // challenger's label
      ...disagree('general', 18), // incumbent's label
    ]);
    expect(s.challengerOnlyRight).toBe(42);
    expect(s.incumbentOnlyRight).toBe(18);
    expect(s.adjudicated).toBe(60);
    expect(s.bothWrong).toBe(0);
  });

  it('counts BOTH-WRONG separately instead of forcing it onto a side', () => {
    // A human may rule that neither prediction was right. Folding that into either cell would invent
    // a winner from a pair that has none.
    const s = summarizeReplay(disagree('document_extraction', 5));
    expect(s.adjudicated).toBe(5);
    expect(s.bothWrong).toBe(5);
    expect(s.challengerOnlyRight).toBe(0);
    expect(s.incumbentOnlyRight).toBe(0);
  });

  it('treats a blank or whitespace true label as unadjudicated, not as a both-wrong ruling', () => {
    const s = summarizeReplay([
      { incumbentLabel: 'general', challengerLabel: 'code_generation', trueLabel: '   ' },
      { incumbentLabel: 'general', challengerLabel: 'code_generation', trueLabel: undefined },
    ]);
    expect(s.pending).toBe(2);
    expect(s.bothWrong).toBe(0);
  });
});

describe('evaluateClassifierGate', () => {
  it('refuses to conclude while the queue still has pairs in it', () => {
    // Unadjudicated pairs could fall either way. Reporting a verdict over the adjudicated subset
    // would let whoever stopped labelling choose the answer.
    const g = evaluateClassifierGate([
      ...agree('general', 300),
      ...disagree('code_generation', 30),
      ...disagree(null, 10),
    ]);
    expect(g.verdict).toBe('insufficient');
    expect(g.rationale).toMatch(/10 of 40 disagreements are still waiting/);
    expect(gateAuthorisesSplit(g.verdict)).toBe(false);
  });

  it('reports INDISTINGUISHABLE when the models never disagreed', () => {
    // Not a tie, and not a pass: there is nothing to be gained from splitting traffic here.
    const g = evaluateClassifierGate(agree('general', 500));
    expect(g.verdict).toBe('indistinguishable');
    expect(g.mcnemar).toBeNull();
    expect(gateAuthorisesSplit(g.verdict)).toBe(false);
  });

  it('reports INSUFFICIENT when every disagreement was adjudicated to a third label', () => {
    const g = evaluateClassifierGate([...agree('general', 100), ...disagree('workflow_actions', 20)]);
    expect(g.verdict).toBe('insufficient');
    expect(g.summary.bothWrong).toBe(20);
    expect(g.rationale).toMatch(/neither model produced/);
  });

  it('reports INSUFFICIENT below the adjudicated-pair floor, however large the corpus', () => {
    // A 10,000-message replay on which the models disagreed three times carries three pairs of
    // evidence. A floor on corpus size would wave that through.
    const g = evaluateClassifierGate([
      ...agree('general', 10_000),
      ...disagree('code_generation', 3),
    ]);
    expect(g.summary.total).toBe(10_003);
    expect(g.verdict).toBe('insufficient');
    expect(g.rationale).toMatch(new RegExp(`floor is ${MIN_ADJUDICATED_PAIRS}`));
  });

  it('passes the §5.3 worked example: 42 to 18 reads as CHALLENGER BETTER', () => {
    const g = evaluateClassifierGate([
      ...agree('general', 300),
      ...disagree('document_extraction', 40), // both wrong: the 40 "both wrong" cell
      ...disagree('code_generation', 42),
      ...disagree('general', 18),
    ]);
    expect(g.summary.total).toBe(400);
    expect(g.summary.concordant).toBe(300);
    expect(g.summary.discordant).toBe(100);
    expect(g.summary.challengerOnlyRight).toBe(42);
    expect(g.summary.incumbentOnlyRight).toBe(18);
    expect(g.mcnemar?.winRate).toBeCloseTo(0.7, 10);
    expect(g.verdict).toBe('challenger_better');
    expect(gateAuthorisesSplit(g.verdict)).toBe(true);
    // (42 - 18) / 400 = +6.0 percentage points of paired accuracy.
    expect(g.accuracyDelta).toBeCloseTo(0.06, 10);
  });

  it('states that a pass authorises the split rather than being its result', () => {
    // §5.4: the gate measures labelling on a fixed corpus. Whether users are better served is a
    // question about live traffic, and the wording must not let the proxy stand in for the outcome.
    const g = evaluateClassifierGate([
      ...agree('general', 300),
      ...disagree('code_generation', 42),
      ...disagree('general', 18),
    ]);
    expect(g.rationale).toMatch(/authorises an online split; it is not the result of one/);
  });

  it('reports WORSE when the challenger loses past the margin', () => {
    const g = evaluateClassifierGate([
      ...agree('general', 100),
      ...disagree('code_generation', 10),
      ...disagree('general', 60),
    ]);
    expect(g.verdict).toBe('worse');
    expect(g.accuracyDelta).toBeLessThan(0);
    expect(gateAuthorisesSplit(g.verdict)).toBe(false);
    expect(g.rationale).toMatch(/Do not split traffic/);
  });

  it('reports WORSE, not a pass, when the interval merely CANNOT RULE OUT a regression', () => {
    // The non-inferiority discipline, and the case a point-estimate check gets wrong: the estimate
    // sits INSIDE the 2-point margin and the interval reaches well past it. Thin data must block a
    // change rather than wave it through, and the rationale distinguishes "it is worse" from "we
    // cannot tell" so an operator knows whether to collect more or to stop.
    const g = evaluateClassifierGate([
      ...agree('general', 472),
      ...disagree('code_generation', 12),
      ...disagree('general', 16),
    ]);
    expect(g.summary.total).toBe(500);
    expect(g.accuracyDelta).toBeCloseTo(-0.008, 10); // -0.8pp, inside the margin
    expect(Math.abs(g.accuracyDelta!)).toBeLessThan(0.02);
    expect(g.accuracyDeltaCi![0]).toBeLessThan(-0.02); // the interval is not
    expect(g.verdict).toBe('worse');
    expect(g.rationale).toMatch(/cannot rule out a regression/);
  });

  it('a POSITIVE point estimate does not pass on its own either', () => {
    // Prove the criterion is the interval and nothing else: the challenger is ahead on the point
    // estimate and the data still cannot clear the margin.
    const g = evaluateClassifierGate([
      ...agree('general', 176),
      ...disagree('code_generation', 14),
      ...disagree('general', 10),
    ]);
    expect(g.accuracyDelta).toBeGreaterThan(0);
    expect(g.accuracyDeltaCi![0]).toBeLessThan(-0.02);
    expect(g.verdict).toBe('worse');
  });

  it('reports NON_INFERIOR when the interval clears the margin without showing a win', () => {
    // A large corpus where the models are close: not better, not worse by more than the margin.
    const g = evaluateClassifierGate([
      ...agree('general', 5000),
      ...disagree('code_generation', 30),
      ...disagree('general', 28),
    ]);
    expect(g.verdict).toBe('non_inferior');
    expect(g.mcnemar?.significant).toBe(false);
    expect(gateAuthorisesSplit(g.verdict)).toBe(true);
    expect(g.rationale).toMatch(/does not recommend one/);
  });

  it('honours a caller-supplied margin', () => {
    const rows = [
      ...agree('general', 200),
      ...disagree('code_generation', 12),
      ...disagree('general', 20),
    ];
    // A permissive margin tolerates the regression the default rejects.
    expect(evaluateClassifierGate(rows, { marginPct: 2 }).verdict).toBe('worse');
    expect(evaluateClassifierGate(rows, { marginPct: 25 }).verdict).toBe('non_inferior');
  });

  it('an empty replay is insufficient, never a pass', () => {
    const g = evaluateClassifierGate([]);
    expect(g.verdict).toBe('indistinguishable');
    expect(gateAuthorisesSplit(g.verdict)).toBe(false);
  });
});
