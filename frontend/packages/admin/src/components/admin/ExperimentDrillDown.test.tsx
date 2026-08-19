/**
 * The drill-down behind an experiment result (DESIGN-EXPERIMENTS-BATTLE §4.3).
 *
 * The acceptance criterion is REPRODUCIBILITY: an operator must be able to derive the number they
 * are about to ship on from what this view shows. So the tests that matter are the ones asserting
 * the view CHECKS itself against the console figure and says so when the two disagree - a render
 * assertion would pass on a view that quietly showed the wrong set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ExperimentDrillDown, { reconcile } from './ExperimentDrillDown';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const range = { start: '2026-05-13', end: '2026-06-12' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const result = (over: Record<string, any> = {}): any => ({
  data: [],
  columns: [],
  total: 0,
  ...over,
});

describe('reconcile - the self-check that makes the view evidence', () => {
  it('agrees when the drill-down and the console report the same set', () => {
    const r = reconcile('metrics', { total: 40, avg_score: 72.4 }, { count: 40, mean: 72.4 });
    expect(r.status).toBe('ok');
    expect(r.lines.every((l) => l.agrees)).toBe(true);
  });

  it('FAILS on a count mismatch - the drill is showing a different set from the aggregate', () => {
    // This is the failure mode the whole feature exists to catch: a predicate that resolves to more
    // (or fewer) exchanges than the number beside it was computed from.
    const r = reconcile('metrics', { total: 55, avg_score: 72.4 }, { count: 40, mean: 72.4 });
    expect(r.status).toBe('mismatch');
    expect(r.lines.find((l) => l.label === 'Exchanges')?.agrees).toBe(false);
  });

  it('FAILS on a mean mismatch even when the counts agree', () => {
    // Same rows, different number: the rollup is computing something other than the mean of these.
    const r = reconcile('metrics', { total: 40, avg_score: 61 }, { count: 40, mean: 72.4 });
    expect(r.status).toBe('mismatch');
  });

  it('tolerates rounding, because the aggregate rounds each row before weighting them', () => {
    const r = reconcile('metrics', { total: 40, avg_score: 72.44 }, { count: 40, mean: 72.4 });
    expect(r.status).toBe('ok');
  });

  it('checks the approval axis on its own figures - votes and the rate', () => {
    const ok = reconcile('approval', { total: 12, approval_rate: 75 }, { count: 12, mean: 75 });
    expect(ok.status).toBe('ok');
    // A revised vote counted twice by the rollup would show up exactly here.
    const bad = reconcile('approval', { total: 12, approval_rate: 75 }, { count: 14, mean: 71.4 });
    expect(bad.status).toBe('mismatch');
  });

  it('checks the picks axis on the count alone - a pick has no mean', () => {
    const r = reconcile('picks', { total: 5 }, { count: 5, mean: null });
    expect(r.status).toBe('ok');
    expect(r.lines).toHaveLength(1);
  });

  it('reports UNAVAILABLE rather than a false pass when there is nothing to check against', () => {
    // Silence would read as agreement. An unchecked number must not look like a verified one.
    expect(reconcile('metrics', undefined, { count: 40, mean: 72 }).status).toBe('unavailable');
    expect(reconcile('metrics', { total: 40 }, { count: null, mean: null }).status).toBe('unavailable');
  });
});

describe('ExperimentDrillDown', () => {
  beforeEach(() => mockQuery.mockReset());

  const target = { experimentId: 'exp1', axis: 'metrics' as const, variantId: 'control' };

  it('queries ONE axis of ONE experiment, scoped to the variant it reconciles against', async () => {
    mockQuery.mockResolvedValue(result());
    render(
      <ExperimentDrillDown target={target} aggregate={{ count: 0, mean: null }} dateRange={range} includeBattle={false} onClose={() => {}} />,
    );
    await waitFor(() => expect(mockQuery).toHaveBeenCalled());
    const [queryType, , extra] = mockQuery.mock.calls[0];
    expect(queryType).toBe('experiment_exchanges');
    expect(extra).toMatchObject({ experimentId: 'exp1', variantId: 'control', axis: 'metrics' });
  });

  it('says which population it is showing', async () => {
    // C3: three axes, three populations. A view that does not name its own set invites the operator
    // to read battle turns as A/B evidence.
    mockQuery.mockResolvedValue(result());
    render(
      <ExperimentDrillDown target={target} aggregate={{ count: 0, mean: null }} dateRange={range} includeBattle={false} onClose={() => {}} />,
    );
    expect(screen.getByText(/Randomly assigned turns only/i)).toBeTruthy();
  });

  it('announces a MISMATCH loudly instead of rendering a quiet contradiction', async () => {
    mockQuery.mockResolvedValue(result({ total: 55, stats: { total: 55, avg_score: 70 } }));
    render(
      <ExperimentDrillDown
        target={target}
        aggregate={{ count: 40, mean: 72.4 }}
        dateRange={range}
        includeBattle={false}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/DOES NOT reconcile/i)).toBeTruthy());
    expect(screen.getByText(/Treat the verdict as unverified/i)).toBeTruthy();
  });

  it('confirms agreement when the figures match', async () => {
    mockQuery.mockResolvedValue(result({ total: 40, stats: { total: 40, avg_score: 72.4 } }));
    render(
      <ExperimentDrillDown
        target={target}
        aggregate={{ count: 40, mean: 72.4 }}
        dateRange={range}
        includeBattle={false}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Reconciles with the result above/i)).toBeTruthy());
  });

  it('states the FULL N when it is showing a page', async () => {
    // "10 most recent" cannot reproduce a mean over 200. A truncated view that does not say so is a
    // false pass in UI form.
    mockQuery.mockResolvedValue(
      result({
        total: 200,
        stats: { total: 200, avg_score: 70 },
        data: Array.from({ length: 25 }, (_, i) => ({ exchange_id: `e${i}`, relevance_score: 70 })),
      }),
    );
    render(
      <ExperimentDrillDown target={target} aggregate={{ count: 200, mean: 70 }} dateRange={range} includeBattle={false} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText(/Showing 1–25 of 200/)).toBeTruthy());
    expect(screen.getByText(/computed over ALL 200, not this page/i)).toBeTruthy();
  });

  it('says how many transcripts are WITHHELD, and keeps their rows', async () => {
    mockQuery.mockResolvedValue(
      result({
        total: 10,
        stats: { total: 10, avg_score: 70, withheld_count: 3 },
        data: [{ exchange_id: 'e1', relevance_score: 70, redacted: true, channel_arn: 'arn:1' }],
      }),
    );
    render(
      <ExperimentDrillDown
        target={target}
        aggregate={{ count: 10, mean: 70 }}
        dateRange={range}
        includeBattle={false}
        onClose={() => {}}
        onOpenConversation={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/3 of 10 rows have a redacted or deleted message/i)).toBeTruthy());
    // The row keeps its numbers; only the transcript is withheld, and it is labelled as such.
    expect(screen.getByText('redacted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
  });

  it('links an ordinary row to its transcript', async () => {
    const onOpen = vi.fn();
    mockQuery.mockResolvedValue(
      result({
        total: 1,
        stats: { total: 1, avg_score: 70 },
        data: [{ exchange_id: 'e1', relevance_score: 70, channel_arn: 'arn:chime:channel/xyz' }],
      }),
    );
    render(
      <ExperimentDrillDown
        target={target}
        aggregate={{ count: 1, mean: 70 }}
        dateRange={range}
        includeBattle={false}
        onClose={() => {}}
        onOpenConversation={onOpen}
      />,
    );
    const link = await screen.findByRole('button', { name: 'View' });
    link.click();
    expect(onOpen).toHaveBeenCalledWith('arn:chime:channel/xyz');
  });

  it('warns when part of the mean is scoring COVERAGE rather than quality', async () => {
    // Unscored exchanges count as 0 in the aggregate. An operator recomputing needs that convention
    // stated, or the number is not reproducible even with every row in front of them.
    mockQuery.mockResolvedValue(
      result({ total: 100, stats: { total: 100, avg_score: 40, scored_count: 55 } }),
    );
    render(
      <ExperimentDrillDown target={target} aggregate={{ count: 100, mean: 40 }} dateRange={range} includeBattle={false} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText(/45 of 100 exchanges carry no evaluator score/i)).toBeTruthy());
  });

  it('the picks axis warns about picks it cannot trace to a conversation', async () => {
    mockQuery.mockResolvedValue(
      result({ total: 5, stats: { total: 5, unresolved_conversations: 2 } }),
    );
    render(
      <ExperimentDrillDown
        target={{ experimentId: 'exp1', axis: 'picks', variantId: 'treatment' }}
        aggregate={{ count: 5, mean: null }}
        dateRange={range}
        includeBattle={false}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/2 picks on this page cannot be traced/i)).toBeTruthy());
  });

  it('surfaces a query failure instead of rendering an empty set as "no evidence"', async () => {
    mockQuery.mockRejectedValueOnce(new Error('analytics unavailable'));
    mockQuery.mockResolvedValue(result());
    render(
      <ExperimentDrillDown target={target} aggregate={{ count: 40, mean: 70 }} dateRange={range} includeBattle={false} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('analytics unavailable')).toBeTruthy());
  });
});
