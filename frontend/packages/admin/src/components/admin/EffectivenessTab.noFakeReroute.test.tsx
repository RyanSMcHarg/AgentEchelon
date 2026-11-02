import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';

/**
 * THE DASHBOARD DOES NOT CLAIM A MEASUREMENT NOBODY TAKES.
 *
 * "Rerouted away" read `reroute_rate`, the share of exchanges where `was_rerouted` is true. Nothing
 * writes that flag: it is set nowhere in the tree and is not even declared on the analytics metadata
 * the archival reader pulls it from. So the figure was structurally 0.0% on every row, forever.
 *
 * A confident zero is worse than a blank. "rerouted away 0.0%" reads as "we checked and routing was
 * clean", when the truth is that no reroute can ever be recorded - and a reader cannot tell a
 * measured zero from an unmeasurable one.
 *
 * It is removed rather than shown as "not measured", because the classifier does not reclassify a
 * turn at all. This is not an uninstrumented behavior; it is a metric for behavior that does not
 * exist. This test exists so it does not quietly come back before the behavior does.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

const range = { start: '2026-05-13', end: '2026-05-20' };

const ROWS = result([
  {
    intent: 'expense_report', exchange_count: 500, direct_count: 500, task_count: 0,
    avg_confidence: 95,
    // Served by the query and deliberately not rendered.
    reroute_rate: 0,
    avg_relevance: 88, relevance_scored_count: 400,
    avg_total_ms: 500, p95_total_ms: 900,
  },
]);

describe('EffectivenessTab — no fabricated reroute figure', () => {
  beforeEach(() => {
    render(
      <EffectivenessTab data={ROWS} dateRange={range} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}} />,
    );
  });

  it('does not render "rerouted away" anywhere', () => {
    expect(screen.queryByText(/rerouted away/i)).toBeNull();
    expect(screen.queryByText(/Rerouted away/)).toBeNull();
  });

  it('still shows routing confidence, which IS measured', () => {
    // The column keeps the half that comes from a real signal: the classifier's own reported
    // confidence. Removing the fake half must not take the real one with it.
    const header = document.querySelector('thead') as HTMLElement;
    expect(header.textContent).toContain('Routing confidence');
    const row = screen.getByRole('button', { name: 'expense_report' }).closest('tr') as HTMLElement;
    const cell = row.querySelector('[data-label="avg_confidence"]') as HTMLElement;
    expect(cell.textContent).toContain('95');
  });

  it('does not describe reroutes in the explanatory copy either', () => {
    // The prose above the table promised the column showed "how often requests were re-routed away".
    expect(document.body.textContent).not.toMatch(/re-routed away/i);
  });
});
