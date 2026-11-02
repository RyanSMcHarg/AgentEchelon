import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setClassificationsForTest } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';
import LatencyTab from './LatencyTab';
import { EMPTY_FILTERS, type PerformanceFilters } from './PerformanceFilters';
import { latencyPopulation } from './latencyAggregate';

/**
 * Response type is a filter of the shared bar, and Latency's own default of leaving
 * multi-step task turns out of its timing cards is a separate toggle on Latency, because Effectiveness
 * has to keep those turns.
 */
beforeAll(() => setClassificationsForTest(SAMPLE_CLASSIFICATIONS));
afterAll(() => setClassificationsForTest(null));

const RANGE = { start: '2026-09-01', end: '2026-09-08' };
const row = (delivery: string, turns: string, e2e: string) => ({
  date: '2026-09-02', assistant: 'standard-assistant', delivery_option: delivery, turn_entry: 'flow',
  assistant_turn_count: turns, avg_ttff_ms: '1000', avg_e2e_ms: e2e, avg_total_ms: '4000', p95_total_ms: '8000',
});
const ROWS = [row('DIRECT_REPLY', '90', '4000'), row('TASK_STEP', '10', '60000')];

const renderTab = (filters: PerformanceFilters = EMPTY_FILTERS) => render(
  <LatencyTab data={{ data: ROWS } as never} routerStepsData={null} isLoading={false} dateRange={RANGE}
    analyticsMode="aurora" filters={filters} onFiltersChange={() => {}} />,
);
const e2e = () => Array.from(document.querySelectorAll('.metric-card'))
  .find((el) => el.querySelector('.metric-card-title')?.textContent?.trim().startsWith('E2E'))!
  .querySelector('.metric-card-value')!.textContent;

describe('task turns and the Response type filter', () => {
  it('leaves task turns out of the timing cards by default, and says how many', () => {
    renderTab();
    expect(e2e()).toBe('4.0s');
    expect(screen.getByText(/10 multi-step task turns are left out/)).toBeInTheDocument();
  });

  it('includes them when the person asks', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Include multi-step task turns' }));
    expect(e2e()).toBe('9.6s');
  });

  it('treats a task type chosen on the shared bar as the cut, with no toggle to undo it', () => {
    renderTab({ ...EMPTY_FILTERS, responseType: 'TASK_STEP' });
    expect(e2e()).toBe('60.0s');
    expect(screen.queryByRole('button', { name: 'Include multi-step task turns' })).toBeNull();
  });

  it('narrows the population the alerts read the same way', () => {
    expect(latencyPopulation(ROWS, EMPTY_FILTERS)).toHaveLength(1);
    expect(latencyPopulation(ROWS, EMPTY_FILTERS, true)).toHaveLength(2);
    expect(latencyPopulation(ROWS, { ...EMPTY_FILTERS, responseType: 'TASK_STEP' })).toHaveLength(1);
  });
});
