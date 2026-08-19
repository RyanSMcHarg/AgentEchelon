import { describe, it, expect } from 'vitest';
import { parseDriftCounts, driftHealthMetrics, formatRate } from './driftHealth';

/**
 * Drift health is two questions about an offer: was it accurate (judged post-hoc by evaluation),
 * and did the user accept. The failure modes worth pinning are the ones that would make an
 * unmeasured or empty feature look healthy.
 */
describe('driftHealthMetrics', () => {
  it('computes acceptance from the recorded counts, parsing Postgres string counters', () => {
    const counts = parseDriftCounts({ total_events: '10', accepted_count: '6', pending_count: '0' });
    expect(counts.offered).toBe(10);

    const m = driftHealthMetrics(counts);
    expect(m.acceptance.value).toBeCloseTo(0.6);
    expect(formatRate(m.acceptance)).toBe('60%');
  });

  it('computes accuracy from the judge verdicts', () => {
    const m = driftHealthMetrics(
      parseDriftCounts({
        total_events: '10',
        accepted_count: '5',
        evaluated_count: '8',
        evaluated_correct_count: '6',
      }),
    );
    expect(m.accuracy.value).toBeCloseTo(0.75); // 6 of 8 JUDGED, not of 10 offered
    expect(m.accuracy.denominator).toBe(8);
  });

  it('measures accuracy over the JUDGED subset, so an unjudged backlog is not counted as wrong', () => {
    // 10 offered, only 2 judged and both correct. Accuracy is 100% of what has been judged, with
    // the backlog surfaced separately - dividing by all 10 would report 20% and read as a broken
    // detector when nothing is known about the other 8.
    const m = driftHealthMetrics(
      parseDriftCounts({ total_events: '10', evaluated_count: '2', evaluated_correct_count: '2' }),
    );
    expect(m.accuracy.value).toBe(1);
    expect(m.awaitingEvaluation).toBe(8);
  });

  it('reports accuracy as unmeasurable until something has been judged', () => {
    // Any number with a zero denominator - 0% or 100% - would be a claim no evaluation supports.
    const m = driftHealthMetrics(parseDriftCounts({ total_events: '10', accepted_count: '10' }));
    expect(m.accuracy.value).toBeNull();
    expect(m.accuracy.denominator).toBe(0);
  });

  it('keeps accuracy and acceptance separate (a declined offer is not a wrong one)', () => {
    // Every offer was judged CORRECT, yet only one was accepted. Blending them into a single
    // number would hide that the detector is right and the prompt is being ignored.
    const m = driftHealthMetrics(
      parseDriftCounts({
        total_events: '10',
        accepted_count: '1',
        evaluated_count: '10',
        evaluated_correct_count: '10',
      }),
    );
    expect(m.acceptance.value).toBeCloseTo(0.1);
    expect(m.accuracy.value).toBe(1);
  });

  it('returns null (not 0) when nothing was offered, so the UI cannot render a fake 0%', () => {
    const m = driftHealthMetrics(parseDriftCounts({}));
    expect(m.acceptance.value).toBeNull();
    expect(formatRate(m.acceptance)).toBeNull();
  });

  it('surfaces pending offers, because acceptance counts them in its denominator', () => {
    const m = driftHealthMetrics(
      parseDriftCounts({ total_events: '10', accepted_count: '4', pending_count: '6' }),
    );
    expect(m.acceptance.value).toBeCloseTo(0.4);
    expect(m.pending).toBe(6);
  });

  it('treats missing, null and malformed counters as zero rather than NaN', () => {
    const m = driftHealthMetrics(
      parseDriftCounts({ total_events: 'not-a-number', accepted_count: null }),
    );
    expect(m.acceptance.value).toBeNull();
    expect(Number.isNaN(m.acceptance.numerator)).toBe(false);
  });
});
