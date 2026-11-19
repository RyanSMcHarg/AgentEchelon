import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import WorkflowEditionsPanel, { editionsWithSteps } from './WorkflowEditionsPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * A WORKFLOW READ PER EDITION, AND REWORK PER TASK (SPEC-WORKFLOWS-AND-TASKS WT109, WT105).
 *
 * Effectiveness reads `workflow_editions` and `task_rework` under the tab's assistant and classification filters, shows
 * one row per workflow edition with its runs, the runs that ended, the success share and its run-level steps, and one row
 * per intent and machine edition with its reopens per task; Athena mode says the panel is not built there.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [], ...extra } as AnalyticsResult);
const RANGE = { start: '2026-05-13', end: '2026-05-20' };

const EDITIONS = [
  { dimension: 'edition', workflow_name: 'ops-room', workflow_origin_hash: 'aaaaaaaa1111', runs: 5, ended: 4, succeeded: 3, success_share: 0.75, avg_ms: 800 },
  { dimension: 'step', workflow_name: 'ops-room', workflow_origin_hash: 'aaaaaaaa1111', workflow_step: 'first-look', runs: 5, messages: 6, avg_ms: 700, p95_ms: 1200 },
  { dimension: 'edition', workflow_name: 'ops-room', workflow_origin_hash: 'bbbbbbbb2222', runs: 2, ended: 0, succeeded: 0, success_share: null, avg_ms: 900 },
];
const REWORK = [{ task_type: 'report_generation', task_origin_machine_hash: 'cccccccc3333', tasks: 4, tasks_reopened: 1, reopens: 2, reopens_per_task: 0.5 }];

describe('workflow editions and rework', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (type) => (type === 'workflow_editions' ? result(EDITIONS) : type === 'task_rework' ? result(REWORK) : result([])));
  });

  it('puts each edition\'s steps beside it', () => {
    const rows = editionsWithSteps(EDITIONS);
    expect(rows).toHaveLength(2);
    expect((rows[0].steps as unknown[]).length).toBe(1);
    expect((rows[1].steps as unknown[]).length).toBe(0);
  });

  it('reads both under the filters and shows each edition and each machine edition', async () => {
    render(<WorkflowEditionsPanel dateRange={RANGE} assistant="advisor" classification="standard" />);
    const editions = await screen.findByTestId('workflow-editions-table');
    expect(mockQuery).toHaveBeenCalledWith('workflow_editions', RANGE, { agentType: 'advisor', conversationClassification: 'standard' });
    expect(mockQuery).toHaveBeenCalledWith('task_rework', RANGE, { agentType: 'advisor', conversationClassification: 'standard' });
    expect(within(editions).getByText('aaaaaaaa')).toBeTruthy();
    expect(within(editions).getByText('75%')).toBeTruthy();
    expect(within(editions).getByTestId('workflow-edition-steps-ops-room-aaaaaaaa').textContent).toContain('first-look');
    const rework = await screen.findByTestId('task-rework-table');
    expect(within(rework).getByText('report_generation')).toBeTruthy();
    expect(within(rework).getByText('0.50')).toBeTruthy();
  });

  it('says Athena mode does not read them', async () => {
    mockQuery.mockImplementation(async () => result([], { unsupported: true }));
    render(<WorkflowEditionsPanel dateRange={RANGE} />);
    expect((await screen.findAllByText(/read the Aurora archive/)).length).toBe(2);
  });
});
