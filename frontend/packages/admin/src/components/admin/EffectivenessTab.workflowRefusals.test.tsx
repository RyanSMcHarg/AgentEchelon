import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * A WORKFLOW REFUSAL IS NOT A TOOL ERROR.
 *
 * The task workflow refuses a move its own rules forbid, and the model corrects it in the same loop.
 * The step records it as `errorClass: 'workflow_refusal'`. The server keeps it out of
 * `tool_errors` / `tool_error_rate` and counts it as `workflow_refusals`; the console shows that count
 * in its own column, and the tool lens makes the same split client-side from the steps.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

const range = { start: '2026-05-13', end: '2026-05-20' };

const L0 = result([
  {
    intent: 'data_extraction', exchange_count: 100, direct_count: 0, task_count: 100,
    avg_confidence: 90, avg_relevance: 85, relevance_scored_count: 90,
    avg_total_ms: 500, p95_total_ms: 900,
    tool_calls: 40, tool_errors: 1, tool_error_rate: 2.5, workflow_refusals: 7,
  },
]);

const STEPS = result([
  {
    message_id: 'm-1', channel_arn: 'arn:chan:one', timestamp: '2026-05-19T10:00:00Z', intent: 'data_extraction',
    steps: [{ tools: [
      { name: 'advance_task_state', ok: false, errorClass: 'workflow_refusal', refusal: 'requirement_unsourced' },
      { name: 'advance_task_state', ok: true },
    ] }],
  },
  {
    message_id: 'm-2', channel_arn: 'arn:chan:two', timestamp: '2026-05-19T11:00:00Z', intent: 'data_extraction',
    steps: [{ tools: [{ name: 'advance_task_state', ok: false, errorClass: 'timeout' }] }],
  },
  {
    message_id: 'm-3', channel_arn: 'arn:chan:three', timestamp: '2026-05-19T12:00:00Z', intent: 'data_extraction',
    steps: [{ tools: [{ name: 'deliver_document', ok: false, errorClass: 'workflow_refusal', refusal: 'not_a_delivering_step' }] }],
  },
]);

function renderTab() {
  render(
    <EffectivenessTab data={L0} dateRange={range} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}} />,
  );
}

describe('EffectivenessTab — workflow refusals are counted apart from tool errors', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue(STEPS);
  });

  it('the intent table has a Refused column carrying the server count', async () => {
    renderTab();
    const header = screen.getAllByRole('columnheader').find((h) => /^Refused/.test(h.textContent ?? ''));
    expect(header).toBeTruthy();
    const row = screen.getByText('data_extraction').closest('tr') as HTMLElement;
    const cells = within(row).getAllByRole('cell');
    const headers = screen.getAllByRole('columnheader').filter((h) => h.closest('table') === row.closest('table'));
    const idx = headers.indexOf(header as HTMLElement);
    expect(cells[idx].textContent).toBe('7');
  });

  it('the tool lens counts a refusal under Refused, not under Errors, and lists only the failure', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitFor(() => expect(screen.getByText('advance_task_state')).toBeTruthy());
    await user.click(screen.getByText('advance_task_state'));

    // Three calls: one refused, one failed, one succeeded. Only the failure is a failure.
    const heading = await screen.findByText(/1 of 3 calls failed/);
    const panel = heading.closest('.admin-review-panel') as HTMLElement;
    const cards = panel.querySelector('.admin-metrics-row') as HTMLElement;
    expect(within(cards).getByText('timeout')).toBeTruthy();
    expect(within(cards).queryByText('workflow_refusal')).toBeNull();
    expect(within(panel).queryByText('workflow_refusal')).toBeNull();
  });

  it('a tool that was only refused says nothing failed, rather than that every call succeeded', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitFor(() => expect(screen.getByText('deliver_document')).toBeTruthy());
    await user.click(screen.getByText('deliver_document'));
    expect(await screen.findByText(/No call to this tool failed in the window\. 1 was refused/)).toBeTruthy();
    expect(screen.queryByText(/Every call to this tool succeeded/)).toBeNull();
  });
});
