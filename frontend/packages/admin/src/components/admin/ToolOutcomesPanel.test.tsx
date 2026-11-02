import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@ae/shared/i18n';
import ToolOutcomesPanel from './ToolOutcomesPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/** Tool use (SPEC-EVALUATION Appendix C3): each tool's findings, split by who fixes them. */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });
const range = { start: '2026-10-01', end: '2026-10-26' };

beforeEach(() => mockQuery.mockReset());

describe('the tool use panel', () => {
  it('splits findings between the assistant\'s team and the tool\'s named owner', async () => {
    mockQuery.mockResolvedValue(result([{
      assistant: 'analyst', conversation_classification: 'standard', tool_name: 'search_corporate_travel', owner: 'connector:corporate-travel',
      verdicts: 10, used_correctly: 6, not_called: 1, wrong_arguments: 1, errored: 2, empty: 0, contradicted: 0, decided_by_judge: 7,
    }]));
    render(<ToolOutcomesPanel dateRange={range} />);
    expect(await screen.findByText('search_corporate_travel')).toBeInTheDocument();
    expect(screen.getByText('6 of 10')).toBeInTheDocument();
    expect(screen.getByText('1 not called · 1 wrong arguments')).toBeInTheDocument();
    expect(screen.getByText('2 errored (connector:corporate-travel)')).toBeInTheDocument();
    expect(screen.getByText('7 of 10')).toBeInTheDocument();
  });

  it('says when nothing was scored', async () => {
    mockQuery.mockResolvedValue(result([]));
    render(<ToolOutcomesPanel dateRange={range} />);
    expect(await screen.findByText('No tool call has been scored in this window.')).toBeInTheDocument();
  });
});
