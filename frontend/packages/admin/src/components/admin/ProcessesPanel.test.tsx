import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import en from '@ae/shared/locales/en.json';
import ProcessesPanel, { durationMs, fmtDuration, metricShare, outcomeCounts } from './ProcessesPanel';

const svc = vi.hoisted(() => ({ queryAnalytics: vi.fn(), listProfiles: vi.fn(), exportProfile: vi.fn() }));
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: svc.queryAnalytics }));
vi.mock('../../services/profileService', () => ({ listProfiles: svc.listProfiles, exportProfile: svc.exportProfile }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const H = 3_600_000;
const run = (over: Record<string, unknown>) => ({ dimension: 'run', process: 'incident-response', process_edition: 'ed1', process_started_at: 0, started_at: 0, ended_at: H, disposition: 'success', steps: [], ...over });

describe('a declared metric, per process edition (SPEC-PROCESSES P10)', () => {
  const metric = { id: 'review', label: 'Review within 2 days', workflow: 'ops-room', step: 'review', outcome: 'sent', within: 'P2D' };
  it('the share of the edition\'s processes that reached the step with its outcome within the time', () => {
    const runs = [
      run({ process_id: 'p1', workflow: 'ops-room', steps: [{ step: 'review', outcome: 'sent' }] }),
      run({ process_id: 'p2', workflow: 'ops-room', steps: [{ step: 'review', outcome: 'sent' }], ended_at: 3 * 24 * H }),
      run({ process_id: 'p3', workflow: 'ops-room', steps: [{ step: 'review', outcome: 'refused' }] }),
      run({ process_id: 'p4', workflow: 'ops-room', steps: [{ step: 'review', outcome: 'sent' }], process_edition: 'ed0' }),
    ];
    expect(metricShare(runs, metric, 'ed1')).toEqual({ share: 1 / 3, processes: 3 });
  });
  it('a process of another edition is never counted, so a changed metric never reaches back', () => {
    expect(metricShare([run({ process_id: 'p4', workflow: 'ops-room', process_edition: 'ed0' })], metric, 'ed1')).toEqual({ share: null, processes: 0 });
  });
  it('reads days, hours and minutes', () => {
    expect(durationMs('P2D')).toBe(48 * H);
    expect(durationMs('PT90M')).toBe(1.5 * H);
    expect(durationMs('soon')).toBeNull();
    expect(fmtDuration(26 * H)).toBe('26h 0m');
    expect(fmtDuration(42_000)).toBe('42s');
  });
});

describe('the Processes panel (SPEC-PROCESSES P9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.exportProfile.mockRejectedValue(new Error('not readable'));
    svc.listProfiles.mockResolvedValue([{ profileName: 'ops-premium', activeProcesses: { 'incident-response': { label: 'Incident response', edition: 'ed1', metrics: [{ id: 'm', label: 'Review within 2 days', workflow: 'ops-room', step: 'review', within: 'P2D', target: 0.8 }] } } }]);
    svc.queryAnalytics.mockResolvedValue({ data: [
      { dimension: 'process', process: 'incident-response', runs: 2, ended: 1, succeeded: 1, p50_ms: 3 * H, p95_ms: 4 * H },
      { dimension: 'workflow', process: 'incident-response', workflow: 'ops-room', owner_team: 'ops', runs: 2, ended: 1, succeeded: 1, p50_ms: H, p95_ms: H },
      { dimension: 'team', process: 'incident-response', owner_team: 'ops', runs: 1, ended: 1, succeeded: 1, p50_ms: 2 * H, p95_ms: 2 * H },
      run({ process_id: 'a1b2c3d4e5f6', workflow: 'ops-room', steps: [{ step: 'review', outcome: 'task:success:acknowledged' }], step_times: [{ step: 'review', at: 0 }] }),
    ] });
  });

  it('lists each process by its label, and opens one only when it is chosen: its key figures, teams and metrics, and no hand-off', async () => {
    render(<ProcessesPanel dateRange={undefined} assistant="ops-premium" />);
    await waitFor(() => expect(screen.getByTestId('processes-table').textContent).toContain('Incident response'));
    expect(svc.queryAnalytics).toHaveBeenCalledWith('process_runs', undefined, { agentType: 'ops-premium' });
    expect(screen.queryByTestId('process-current')).toBeNull();
    fireEvent.click(screen.getByTestId('process-pick-incident-response'));
    expect(screen.getByTestId('process-current').textContent).toBe('Incident response');
    expect(screen.getByTestId('process-kpi-started').textContent).toContain('1');
    expect(screen.getByTestId('process-kpi-open').textContent).toContain('0');
    expect(screen.getByTestId('process-teams')).toBeTruthy();
    expect(screen.queryByTestId('process-handoffs')).toBeNull();
    expect(screen.getByTestId('process-metrics').textContent).toContain('Review within 2 days');
  });

  it('counts the outcomes of a process run by run, an open run as open', () => {
    expect(outcomeCounts([run({ disposition: 'success' }), run({ disposition: 'success' }), run({ ended_at: null, disposition: null }), run({ disposition: 'failed' })]))
      .toEqual([{ outcome: 'success', runs: 2 }, { outcome: '', runs: 1 }, { outcome: 'failed', runs: 1 }]);
  });

  it('opens one process id on its own: its runs, read by that id, with each stage and how it ended, and back to its process', async () => {
    render(<ProcessesPanel dateRange={undefined} assistant="ops-premium" />);
    fireEvent.click(await screen.findByTestId('process-pick-incident-response'));
    const open = within(await screen.findByTestId('process-drill-a1b2c3d4e5f6')).getByRole('button');
    expect(open.getAttribute('aria-label')).toBe('admin.processes.drill.open');
    fireEvent.click(open);
    await waitFor(() => expect(screen.getByTestId('process-drill-runs').textContent).toContain('admin.processes.outcome.task.success'));
    expect(screen.getByTestId('process-drill-runs').textContent).not.toContain('task:success:acknowledged');
    expect(svc.queryAnalytics).toHaveBeenLastCalledWith('process_runs', undefined, { processId: 'a1b2c3d4e5f6', agentType: 'ops-premium' });
    expect(screen.queryByTestId('process-detail')).toBeNull();
    fireEvent.click(screen.getByTestId('process-drill-back'));
    expect(screen.getByTestId('process-detail')).toBeTruthy();
  });

  it('each view is an address: opening a process and a process id writes them, and a link opens the process id at once', async () => {
    const first = render(<ProcessesPanel dateRange={undefined} assistant="ops-premium" />);
    fireEvent.click(await screen.findByTestId('process-pick-incident-response'));
    expect(new URLSearchParams(window.location.search).get('process')).toBe('incident-response');
    fireEvent.click(within(await screen.findByTestId('process-drill-a1b2c3d4e5f6')).getByRole('button'));
    expect(new URLSearchParams(window.location.search).get('processRun')).toBe('a1b2c3d4e5f6');
    first.unmount();
    // A LINK: the process id opens with no click, read by that id.
    window.history.replaceState({}, '', '/?admin=processes&process=incident-response&processRun=a1b2c3d4e5f6');
    render(<ProcessesPanel dateRange={undefined} assistant="ops-premium" />);
    await waitFor(() => expect(screen.getByTestId('process-drill-runs')).toBeTruthy());
    expect(svc.queryAnalytics).toHaveBeenCalledWith('process_runs', undefined, { processId: 'a1b2c3d4e5f6', agentType: 'ops-premium' });
    // BACK, as the browser takes it, follows the address to the process.
    window.history.replaceState({}, '', '/?admin=processes&process=incident-response');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(screen.getByTestId('process-detail')).toBeTruthy());
  });

  it('a process id\'s breadcrumb links every level above it: all processes, then its process', async () => {
    render(<ProcessesPanel dateRange={undefined} assistant="ops-premium" />);
    fireEvent.click(await screen.findByTestId('process-pick-incident-response'));
    expect(within(screen.getByTestId('process-breadcrumb')).getByTestId('process-back').textContent).toBe('admin.processes.drill.back');
    fireEvent.click(within(await screen.findByTestId('process-drill-a1b2c3d4e5f6')).getByRole('button'));
    const crumbs = await screen.findByTestId('process-drill-breadcrumb');
    expect(within(crumbs).getByTestId('process-drill-back')).toBeTruthy();
    fireEvent.click(within(crumbs).getByTestId('process-drill-all'));
    expect(screen.queryByTestId('process-drill')).toBeNull();
    expect(screen.queryByTestId('process-detail')).toBeNull();
    expect(screen.getByTestId('processes-table')).toBeTruthy();
  });

  it('lists a declared process that did not run, and says nothing ran only where nothing is declared either, never that there is no data', async () => {
    svc.queryAnalytics.mockResolvedValueOnce({ data: [] });
    const first = render(<ProcessesPanel dateRange={undefined} />);
    await waitFor(() => expect(screen.getByTestId('processes-table').textContent).toContain('Incident response'));
    first.unmount();
    svc.queryAnalytics.mockResolvedValueOnce({ data: [] });
    svc.listProfiles.mockResolvedValueOnce([]);
    render(<ProcessesPanel dateRange={undefined} />);
    expect((await screen.findByTestId('processes-empty')).textContent).toBe('admin.processes.empty');
    expect(en.admin.processes.empty).toBe('No process is declared, and none ran in this window.');
    expect(en.admin.processes.empty.toLowerCase()).not.toContain('no data');
  });

  it('says when nothing ran, and when the deployment is not in Aurora mode', async () => {
    svc.queryAnalytics.mockResolvedValueOnce({ data: [], unsupported: true });
    render(<ProcessesPanel dateRange={undefined} />);
    await screen.findByText('admin.processes.unsupported');
  });
});
