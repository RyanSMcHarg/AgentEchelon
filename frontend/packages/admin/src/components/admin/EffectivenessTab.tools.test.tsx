import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * THE TOOL LENS HAS A WAY OUT OF ITS OWN ERROR COUNT.
 *
 * It reported "12 errors" and stopped there. A reader could not find out what kind of failure, or
 * where it happened, and the next step was reading Lambda logs by hand - not a step an operator can
 * take from a dashboard. The rows also highlighted on hover without being clickable, which promised
 * exactly the interaction that was missing.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

const range = { start: '2026-05-13', end: '2026-05-20' };

const L0 = result([
  {
    intent: 'expense_report', exchange_count: 100, direct_count: 100, task_count: 0,
    avg_confidence: 90, avg_relevance: 85, relevance_scored_count: 90,
    avg_total_ms: 500, p95_total_ms: 900,
  },
]);

// Two turns, one tool failing twice with different classes and one tool that never failed.
const STEPS = result([
  {
    message_id: 'm-1', channel_arn: 'arn:chan:one', timestamp: '2026-05-19T10:00:00Z', intent: 'expense_report',
    steps: [{ tools: [{ name: 'load_company_context', ok: false, errorClass: 'timeout' }, { name: 'search', ok: true }] }],
  },
  {
    message_id: 'm-2', channel_arn: 'arn:chan:two', timestamp: '2026-05-19T11:00:00Z', intent: 'expense_report',
    steps: [{ tools: [{ name: 'load_company_context', ok: false, errorClass: 'unauthorized' }] }],
  },
  {
    message_id: 'm-3', channel_arn: 'arn:chan:three', timestamp: '2026-05-19T12:00:00Z', intent: 'expense_report',
    steps: [{ tools: [{ name: 'load_company_context', ok: true }, { name: 'search', ok: true }] }],
  },
]);

describe('EffectivenessTab — the tool lens routes to the errors', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue(STEPS);
  });

  async function renderLens(onOpenConversation?: (arn: string) => void) {
    render(
      <EffectivenessTab
        data={L0}
        dateRange={range}
        isLoading={false}
        filters={EMPTY_FILTERS}
        onFiltersChange={() => {}}
        onOpenConversation={onOpenConversation}
      />,
    );
    // The system-wide lens loads its steps asynchronously.
    await waitFor(() => expect(screen.getByText('load_company_context')).toBeTruthy());
  }

  it('makes tool rows genuinely clickable, not just hoverable', async () => {
    await renderLens();
    // The class DataTable puts on a row only when it has an onRowClick. Its absence was the defect:
    // the CSS highlighted every row on hover regardless.
    const row = screen.getByText('load_company_context').closest('tr');
    expect(row?.className).toContain('data-table-row--clickable');
  });

  it('opens the failures behind the count, broken down by error class', async () => {
    const user = userEvent.setup();
    await renderLens();
    await user.click(screen.getByText('load_company_context'));

    const heading = await screen.findByText(/2 of 3 calls failed/);
    const panel = heading.closest('.admin-review-panel') as HTMLElement;
    expect(panel).toBeTruthy();
    // Both classes, counted separately - "2 errors" cannot tell a permissions problem from a slow
    // dependency, and those have different fixes. Scoped to the panel: each class also appears in
    // the per-failure table below the cards, so an unscoped lookup matches twice.
    // Scoped to the CARDS row: each class also appears in the per-failure table below it, so a
    // panel-wide lookup matches twice.
    const cards = panel.querySelector('.admin-metrics-row') as HTMLElement;
    expect(cards).toBeTruthy();
    expect(within(cards).getByText('timeout')).toBeTruthy();
    expect(within(cards).getByText('unauthorized')).toBeTruthy();
    expect(within(cards).getAllByText('1')).toHaveLength(2); // one failure of each class
  });

  it('offers a route to the conversation each failure happened in', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    await renderLens(onOpen);
    await user.click(screen.getByText('load_company_context'));

    const open = await screen.findAllByRole('button', { name: /Open conversation/ });
    expect(open.length).toBe(2); // one per failing call
    await user.click(open[0]);
    // Newest first, so the most recent failure is the one offered at the top.
    expect(onOpen).toHaveBeenCalledWith('arn:chan:two');
  });

  it('says so plainly when a tool never failed, rather than opening an empty table', async () => {
    const user = userEvent.setup();
    await renderLens();
    await user.click(screen.getByText('search'));
    expect(await screen.findByText(/Every call to this tool succeeded/)).toBeTruthy();
  });

  it('closes again on a second click of the same row', async () => {
    const user = userEvent.setup();
    await renderLens();
    await user.click(screen.getByText('load_company_context'));
    expect(await screen.findByText(/2 of 3 calls failed/)).toBeTruthy();
    await user.click(screen.getByText('load_company_context'));
    await waitFor(() => expect(screen.queryByText(/2 of 3 calls failed/)).toBeNull());
  });

  it('does not offer a dead button when no conversation was recorded', async () => {
    mockQuery.mockResolvedValue(result([
      {
        message_id: 'm-9', channel_arn: null, timestamp: '2026-05-19T10:00:00Z', intent: 'expense_report',
        steps: [{ tools: [{ name: 'orphan_tool', ok: false, errorClass: 'error' }] }],
      },
    ]));
    const user = userEvent.setup();
    render(
      <EffectivenessTab data={L0} dateRange={range} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}} onOpenConversation={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('orphan_tool')).toBeTruthy());
    await user.click(screen.getByText('orphan_tool'));
    // A button that cannot work is worse than an honest absence: it reads as a route that is broken.
    const panel = (await screen.findByText(/1 of 1 calls failed/)).closest('.admin-review-panel');
    expect(within(panel as HTMLElement).queryByRole('button', { name: /Open conversation/ })).toBeNull();
    expect(within(panel as HTMLElement).getByText(/no conversation recorded/)).toBeTruthy();
  });
});
