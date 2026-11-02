import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';

/**
 * RELEVANCE AND TASK EXECUTION ARE TWO COLUMNS, AND THE SECOND ONE IS ALLOWED TO BE ABSENT.
 *
 * There used to be one "Execution" cell that showed the completion rate for intents whose traffic was
 * mostly task-shaped and the relevance score for everything else. Two rows in that column were not
 * comparable: which question the number answered depended on which shape a row's traffic happened to
 * take, and only the cell's own label said so.
 *
 * What these pin:
 *   - relevance shows for EVERY intent, from the average over all scored turns, not just direct ones;
 *   - task execution shows only where tasks exist, and is a DASH otherwise (an intent that never opens
 *     a task has no task execution, and a 0% would read as "it failed every time");
 *   - where tasks did not complete, the cell says whether they failed, were left, or are still
 *     running, because a bare completion rate cannot distinguish them.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

const range = { start: '2026-05-13', end: '2026-05-20' };

// A DIRECT-only intent (no tasks), and a task intent where most tasks did not complete.
const ROWS = result([
  {
    intent: 'general_query', exchange_count: 500, direct_count: 500, task_count: 0,
    avg_confidence: 95, reroute_rate: 2,
    avg_relevance: 88, relevance_scored_count: 412, direct_relevance: 88,
    avg_total_ms: 500, p95_total_ms: 900,
  },
  {
    intent: 'report_generation', exchange_count: 40, direct_count: 0, task_count: 40,
    avg_confidence: 92, reroute_rate: 1,
    // Relevance is high even though completion is poor: the answers were good, the work did not
    // finish. The old single column could not say both, which is the case this exists for.
    avg_relevance: 91, relevance_scored_count: 38,
    task_completion_rate: 20, task_flow_count: 10,
    task_completed: 2, task_failed: 3, task_abandoned: 4, task_running: 1,
    avg_total_ms: 2000, p95_total_ms: 3000,
  },
]);

function rowFor(intent: string): HTMLElement {
  const cell = screen.getByRole('button', { name: intent });
  const row = cell.closest('tr');
  if (!row) throw new Error('no row for ' + intent);
  return row as HTMLElement;
}

describe('EffectivenessTab — relevance and task execution are separate columns', () => {
  beforeEach(() => {
    render(
      <EffectivenessTab data={ROWS} dateRange={range} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}} />,
    );
  });

  it('shows both column headers', () => {
    // Scoped to the header row: the prose above the table names both columns too, so an unscoped
    // lookup would pass on the explanation even if the columns were never rendered.
    const header = document.querySelector('thead');
    expect(header).toBeTruthy();
    expect(within(header as HTMLElement).getByText('Relevance')).toBeTruthy();
    expect(within(header as HTMLElement).getByText('Task execution')).toBeTruthy();
  });

  it('shows relevance for an intent that has no tasks at all', () => {
    const row = rowFor('general_query');
    expect(within(row).getByText(/88/)).toBeTruthy();
    // The scored population travels with the average: 88 over 412 turns is not the same claim as
    // 88 over three, and the number alone cannot tell them apart.
    expect(within(row).getByText(/412 scored/)).toBeTruthy();
  });

  it('shows a DASH, not a zero, for task execution on an intent with no tasks', () => {
    // Scoped to the task cell. Other cells legitimately render a dash for their own missing values,
    // so an unscoped match would pass without ever looking at this column.
    const row = rowFor('general_query');
    const cell = row.querySelector('[data-label="task_completion_rate"]');
    expect(cell).toBeTruthy();
    expect((cell as HTMLElement).textContent).toBe('—');
    expect(within(row).queryByText(/done/)).toBeNull();
  });

  it('reports high relevance and poor completion on the SAME row', () => {
    // The case the single column could not express: good answers, unfinished work.
    const row = rowFor('report_generation');
    expect(within(row).getByText(/91/)).toBeTruthy();
    expect(within(row).getByText(/2\/10 done/)).toBeTruthy();
  });

  it('says what happened to the tasks that did not complete', () => {
    // "20% completed" alone collapses failed, left and still-running into one bucket, and those have
    // different owners: a failure is the assistant's, an abandonment is the person's, and a running
    // task is neither yet.
    const row = rowFor('report_generation');
    const text = row.textContent || '';
    expect(text).toContain('3 failed');
    expect(text).toContain('4 left');
    expect(text).toContain('1 running');
  });

  it('does not list an ending that did not happen', () => {
    // An intent with nothing abandoned must not render "0 left" - a zero invites a reader to think
    // it was measured and came back empty on a row where the category simply did not occur.
    const row = rowFor('general_query');
    expect((row.textContent || '')).not.toContain('left');
  });
});
