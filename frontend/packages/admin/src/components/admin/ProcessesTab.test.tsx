import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProcessesTab, { processFilters } from './ProcessesTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import { setTeamAssistant, teamCanQuery } from '../../services/teamScope';

const svc = vi.hoisted(() => ({ queryAnalytics: vi.fn(), listProfiles: vi.fn() }));
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: svc.queryAnalytics }));
vi.mock('../../services/profileService', () => ({ listProfiles: svc.listProfiles }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const range = { start: '2026-11-10', end: '2026-11-16' };

describe('the Processes tab (SPEC-PROCESSES P9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.listProfiles.mockResolvedValue([]);
    svc.queryAnalytics.mockResolvedValue({ data: [
      { dimension: 'process', process: 'incident-response', runs: 1, ended: 1, succeeded: 1, p50_ms: 1, p95_ms: 1 },
    ] });
  });
  afterEach(() => setTeamAssistant(null));

  it('shows the process analytics over the window and the shared classification and assistant', async () => {
    const filters = { ...EMPTY_FILTERS, classification: 'premium', assistant: 'ops-premium', role: 'ops', version: ['3'], entry: 'flow' };
    render(<ProcessesTab dateRange={range} filters={filters} onFiltersChange={() => undefined} filterRows={[]} />);
    await waitFor(() => expect(screen.getByTestId('processes-table')).toBeTruthy());
    expect(svc.queryAnalytics).toHaveBeenCalledWith('process_runs', range, { agentType: 'ops-premium', conversationClassification: 'premium' });
    expect(screen.getByTestId('processes-tab')).toBeTruthy();
  });

  it('applies only the two axes a process run carries, and a change here clears what it invalidates', async () => {
    expect(processFilters({ ...EMPTY_FILTERS, assistant: 'a', role: 'r', entry: 'flow', version: ['2'] })).toEqual({ ...EMPTY_FILTERS, assistant: 'a' });
    const onChange = vi.fn();
    const filters = { ...EMPTY_FILTERS, classification: 'premium', assistant: 'ops-premium', version: ['3'], entry: 'flow' };
    render(<ProcessesTab dateRange={range} filters={filters} onFiltersChange={onChange} filterRows={[]} />);
    // The bar shows the active filters, which stay clearable.
    fireEvent.click(await screen.findByText('Clear filters'));
    expect(onChange).toHaveBeenCalledWith({ ...filters, classification: null, assistant: null, version: null, role: null });
  });

  it('is read by a team on its own route: the process query is one the team route answers', () => {
    setTeamAssistant('ops-premium');
    expect(teamCanQuery('process_runs')).toBe(true);
  });
});
