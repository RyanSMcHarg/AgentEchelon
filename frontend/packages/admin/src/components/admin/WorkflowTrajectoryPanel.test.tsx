import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import WorkflowTrajectoryPanel from './WorkflowTrajectoryPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * The workflow reading (SPEC-EVALUATION Appendix C2) shows where each task type's tasks ended up and how
 * directly, scoped by the same assistant and classification as the table above it.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });
const range = { start: '2026-10-01', end: '2026-10-26' };

beforeEach(() => mockQuery.mockReset());

describe('the workflow panel', () => {
  it('shows outcomes as counts, the path as a ratio, and a dash where no task reached success', async () => {
    mockQuery.mockResolvedValue(result([
      { assistant: 'analyst', conversation_classification: 'premium', task_type: 'report_generation', tasks: 12, success: 9, failure: 1, handoff: 0, open: 2, path_ratio: 1.33, tasks_regressed: 3, stalled: 1, platform_moves: 4, refused_moves: 5 },
      { assistant: 'analyst', conversation_classification: 'premium', task_type: 'data_extraction', tasks: 2, success: 0, failure: 0, handoff: 0, open: 2, path_ratio: null, tasks_regressed: 0, stalled: 2, platform_moves: 0, refused_moves: 0 },
    ]));
    render(<WorkflowTrajectoryPanel dateRange={range} />);
    expect(await screen.findByText('report_generation')).toBeInTheDocument();
    expect(screen.getByText('9 succeeded · 1 failed · 2 open')).toBeInTheDocument();
    expect(screen.getByText('1.33×')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('asks for the assistant and classification it is scoped to', async () => {
    mockQuery.mockResolvedValue(result([]));
    render(<WorkflowTrajectoryPanel dateRange={range} assistant="analyst" classification="premium" />);
    await waitFor(() => expect(mockQuery).toHaveBeenCalled());
    expect(mockQuery).toHaveBeenCalledWith('workflow_trajectory', range, { agentType: 'analyst', conversationClassification: 'premium' });
    expect(await screen.findByText('No workflow tasks in this window.')).toBeInTheDocument();
  });

  it('says so when the reading cannot be loaded', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    mockQuery.mockResolvedValue(result([]));
    render(<WorkflowTrajectoryPanel dateRange={range} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load workflows.');
  });
});
