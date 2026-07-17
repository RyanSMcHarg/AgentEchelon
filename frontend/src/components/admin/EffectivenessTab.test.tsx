import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EffectivenessTab from './EffectivenessTab';
import type { AnalyticsResult } from '../../types/analytics';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

// A bad-classification task intent + a healthy DIRECT intent. Worst-first ranking must float the bad
// one above the healthy one despite the healthy one having far more volume.
const L0 = result([
  {
    intent: 'general_query', exchange_count: 500, direct_count: 500, task_count: 0,
    avg_confidence: 95, reroute_rate: 2, direct_relevance: 90,
    avg_total_ms: 500, p95_total_ms: 900, cost_per_reply_usd: null,
    tool_calls: 0, tool_errors: 0, tool_error_rate: 0,
  },
  {
    intent: 'report_generation', exchange_count: 5, direct_count: 0, task_count: 5,
    avg_confidence: 30, reroute_rate: 4, task_completion_rate: 90, flow_composite: 85,
    avg_total_ms: 2000, p95_total_ms: 3000, cost_per_reply_usd: 0.02,
    tool_calls: 4, tool_errors: 0, tool_error_rate: 0,
  },
]);

const range = { start: '2026-05-13', end: '2026-05-20' };

describe('EffectivenessTab', () => {
  beforeEach(() => mockQuery.mockReset());

  it('L0: ranks intents worst-first (bad classification above healthy high-volume)', () => {
    render(<EffectivenessTab data={L0} dateRange={range} isLoading={false} />);
    const report = screen.getByRole('button', { name: 'report_generation' });
    const general = screen.getByRole('button', { name: 'general_query' });
    // report_generation (bad classification) must appear before general_query in DOM order.
    expect(report.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('drills L0 → L1 (intent cards) → L2 (task list) → L3 (turn timeline + steps)', async () => {
    render(<EffectivenessTab data={L0} dateRange={range} isLoading={false} />);

    // L1: click the intent → its metric cards + a Tasks drill button (it is a task intent).
    fireEvent.click(screen.getByRole('button', { name: 'report_generation' }));
    expect(screen.getByText('Classification confidence')).toBeTruthy();
    const tasksBtn = screen.getByRole('button', { name: /Tasks \(5\)/ });

    // L2: task list is fetched with the intent filter.
    mockQuery.mockResolvedValueOnce(result([
      { task_id: 'task-abc12345', status: 'completed', task_state: 'completed', exchange_count: 3, transition_count: 2, last_at: '2026-05-20T00:00:00Z' },
    ]));
    fireEvent.click(tasksBtn);
    await waitFor(() => expect(mockQuery).toHaveBeenCalledWith('task_details', range, { intent: 'report_generation' }));
    const taskLink = await screen.findByRole('button', { name: /task-abc/ });

    // L3: the task timeline is fetched by taskId; a transition row + its steps render.
    mockQuery.mockResolvedValueOnce(result([
      {
        exchange_id: 'ex-1', task_transition: { from: 'drafting_outline', to: 'generating' }, task_state: 'generating',
        relevance_score: 88, total_ms: 1500, input_tokens: 800, output_tokens: 400,
        steps: [{ stepLabel: 'tool:advance_task_state', modelId: 'm', tokensIn: 10, tokensOut: 5, estCostUsd: 0.0001, tools: [{ name: 'advance_task_state', ok: true }] }],
      },
    ]));
    fireEvent.click(taskLink);
    await waitFor(() => expect(mockQuery).toHaveBeenCalledWith('task_timeline', range, { taskId: 'task-abc12345' }));
    expect(await screen.findByText('drafting_outline → generating')).toBeTruthy();

    // L4 inline: expand the turn to reveal its step + tool outcome.
    fireEvent.click(screen.getByRole('button', { name: /1 step/ }));
    expect(screen.getByText('tool:advance_task_state')).toBeTruthy();
  });

  it('shows a loading state', () => {
    render(<EffectivenessTab data={null} dateRange={range} isLoading={true} />);
    expect(screen.getByText(/Loading effectiveness/i)).toBeTruthy();
  });
});
