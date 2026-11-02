import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * A PLATFORM ACTION IS COUNTED APART FROM THE MODEL'S TOOL CALLS (SPEC-TASK-STATE-TRANSITIONS FR29).
 *
 * The server counts the declared step actions the platform ran per intent as `platform_actions`, from
 * steps[].action, apart from `tool_calls`. The intent table shows it as a plain count in its own column,
 * with a zero where none ran, and the tool count beside it is unchanged.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

const L0 = result([
  {
    intent: 'report_generation', exchange_count: 50, direct_count: 0, task_count: 50,
    avg_confidence: 90, avg_relevance: 85, relevance_scored_count: 40,
    avg_total_ms: 500, p95_total_ms: 900,
    tool_calls: 12, tool_errors: 0, tool_error_rate: 0, workflow_refusals: 0, platform_actions: 5,
  },
  {
    intent: 'data_extraction', exchange_count: 20, direct_count: 0, task_count: 20,
    avg_confidence: 90, avg_relevance: 85, relevance_scored_count: 15,
    avg_total_ms: 500, p95_total_ms: 900,
    tool_calls: 3, tool_errors: 0, tool_error_rate: 0, workflow_refusals: 0,
  },
]);

function cellUnder(headerPattern: RegExp, intent: string): string {
  const header = screen.getAllByRole('columnheader').find((h) => headerPattern.test(h.textContent ?? ''));
  expect(header, `a column headed ${headerPattern}`).toBeTruthy();
  const row = screen.getByText(intent).closest('tr') as HTMLElement;
  const headers = screen.getAllByRole('columnheader').filter((h) => h.closest('table') === row.closest('table'));
  return within(row).getAllByRole('cell')[headers.indexOf(header as HTMLElement)].textContent ?? '';
}

describe('EffectivenessTab - platform actions', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue(result([]));
  });

  it('the intent table carries the server count of platform actions as a plain count, zero where none ran', () => {
    render(<EffectivenessTab data={L0} dateRange={{ start: '2026-05-13', end: '2026-05-20' }} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}} />);
    expect(cellUnder(/^Platform actions/, 'report_generation')).toBe('5');
    expect(cellUnder(/^Platform actions/, 'data_extraction')).toBe('0');
  });
});
