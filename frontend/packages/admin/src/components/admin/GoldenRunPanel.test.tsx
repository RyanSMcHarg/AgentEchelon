/**
 * THE DRAFT'S RUN AGAINST THE GOLDEN SET, BESIDE VALIDATE (ADR-065).
 *
 * What it proves: the panel reads the gate when the draft opens and says a run is needed; a refused run names each
 * failed entry and attempt with its reason; starting a run is offered only to an editor and reads the gate once after;
 * "Check again" reads it on request; and nothing in the panel waits on a timer (tenet D6). Activate anyway (ADR-065
 * decision 5) is offered on a refusal only to a session holding `activate-past-golden-gate`, needs a reason before it
 * confirms, sends the draft and the refusal shown, and words a refusal of the confirmation and reads the gate afresh.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GoldenRunPanel from './GoldenRunPanel';
import * as svc from '../../services/profileService';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  readGoldenGate: vi.fn(),
  startGoldenRun: vi.fn(),
}));

const gate = (run: NonNullable<svc.GoldenGateReading['gate']>['run']): svc.GoldenGateReading => ({
  profileName: 'advisor', draftConfigId: 'cfg-2', available: true,
  gate: { entries: 2, regressionEntries: 2, run },
});
const refused: svc.GoldenResult = {
  refused: true, failures: [{ entryId: 'e1aaaaaa-0000', attempt: 2, reason: 'empty' }], readyToPromote: [],
  pairedDifference: { mean: -3.2, ci: [-8.1, 1.7], entries: 2 }, minimumDetectable: 6.5, notExercised: [], regressionExercised: 1, entries: 2, k: 3,
};

// The console session's capabilities, which the panel reads to offer Activate anyway.
const HELD = { capabilities: new Set<string>(['view-profiles', 'edit-profiles']) };
vi.mock('../../capabilities', () => ({ useCan: () => (c: string) => HELD.capabilities.has(c) }));

const refusedRun = (): svc.GoldenGateReading => ({
  ...gate({
    runId: 'r', draftConfigId: 'cfg-2', k: 3, entriesTotal: 2, entriesDone: 2, status: 'complete', result: refused,
    error: null, startedBy: 's', startedAt: '2026-10-31T00:00:00Z', completedAt: '2026-10-31T00:05:00Z',
  }),
  outcome: { proceed: false, code: 'GOLDEN_SET_REFUSED', params: { count: 1 }, error: 'refused', failures: refused.failures },
});

beforeEach(() => {
  vi.mocked(svc.readGoldenGate).mockReset();
  HELD.capabilities = new Set(['view-profiles', 'edit-profiles']);
});

describe('the golden run panel', () => {
  it('says a run is needed when the set holds regression entries and none ran for this draft', async () => {
    vi.mocked(svc.readGoldenGate).mockResolvedValue(gate(null));
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun />);
    expect(await screen.findByTestId('golden-run-needed')).toBeTruthy();
    expect(svc.readGoldenGate).toHaveBeenCalledTimes(1);
  });

  it('names each failed entry and attempt of a refused run', async () => {
    vi.mocked(svc.readGoldenGate).mockResolvedValue(gate({
      runId: 'r', draftConfigId: 'cfg-2', k: 3, entriesTotal: 2, entriesDone: 2, status: 'complete', result: refused,
      error: null, startedBy: 's', startedAt: '2026-10-31T00:00:00Z', completedAt: '2026-10-31T00:05:00Z',
    }));
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun />);
    const failures = await screen.findByTestId('golden-run-failures');
    expect(failures.textContent).toContain('e1aaaaaa');
    expect(failures.querySelectorAll('li')).toHaveLength(1);
  });

  it('offers a run only to an editor, and reads the gate once after starting one', async () => {
    vi.mocked(svc.readGoldenGate).mockResolvedValue(gate(null));
    vi.mocked(svc.startGoldenRun).mockResolvedValue({ profileName: 'advisor', runId: 'r', draftConfigId: 'cfg-2' });
    const { unmount } = render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun={false} />);
    await screen.findByTestId('golden-run-needed');
    expect(screen.queryByTestId('golden-run-start')).toBeNull();
    unmount();
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun />);
    fireEvent.click(await screen.findByTestId('golden-run-start'));
    await waitFor(() => expect(svc.startGoldenRun).toHaveBeenCalledWith('advisor'));
    await waitFor(() => expect(svc.readGoldenGate).toHaveBeenCalledTimes(3));
  });

  it('offers Activate anyway on a refusal only to a session holding activate-past-golden-gate', async () => {
    vi.mocked(svc.readGoldenGate).mockResolvedValue(refusedRun());
    const onPass = vi.fn();
    const { unmount } = render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun onActivatePastGate={onPass} />);
    await screen.findByTestId('golden-run-failures');
    expect(screen.queryByTestId('golden-past-gate-offer')).toBeNull();
    unmount();
    HELD.capabilities.add('activate-past-golden-gate');
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun onActivatePastGate={onPass} />);
    expect(await screen.findByTestId('golden-past-gate-offer')).toBeTruthy();
  });

  it('is not offered where the gate does not refuse', async () => {
    HELD.capabilities.add('activate-past-golden-gate');
    vi.mocked(svc.readGoldenGate).mockResolvedValue({ ...gate(null), outcome: { proceed: true, note: 'empty' } });
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun onActivatePastGate={vi.fn()} />);
    await screen.findByTestId('golden-run');
    expect(screen.queryByTestId('golden-past-gate-offer')).toBeNull();
  });

  it('confirms the refusal shown with a reason, and sends the draft, the refusal and the reason', async () => {
    HELD.capabilities.add('activate-past-golden-gate');
    vi.mocked(svc.readGoldenGate).mockResolvedValue(refusedRun());
    const onPass = vi.fn().mockResolvedValue({ activated: true });
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun onActivatePastGate={onPass} />);
    fireEvent.click(await screen.findByTestId('golden-past-gate-offer'));
    const dialog = screen.getByTestId('golden-past-gate');
    expect(dialog.querySelectorAll('li')).toHaveLength(1);
    const confirm = screen.getByTestId('golden-past-gate-confirm') as HTMLButtonElement;
    fireEvent.change(screen.getByTestId('golden-past-gate-reason'), { target: { value: 'too short' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('golden-past-gate-reason'), { target: { value: '  Ship the outage fix; entry e1 is stale  ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onPass).toHaveBeenCalledWith({ configId: 'cfg-2', code: 'GOLDEN_SET_REFUSED', params: { count: 1 }, runId: 'r', reason: 'Ship the outage fix; entry e1 is stale' }));
    await waitFor(() => expect(screen.queryByTestId('golden-past-gate')).toBeNull());
  });

  it('words a refusal of the confirmation and reads the gate afresh', async () => {
    HELD.capabilities.add('activate-past-golden-gate');
    vi.mocked(svc.readGoldenGate).mockResolvedValue(refusedRun());
    const onPass = vi.fn().mockResolvedValue({ activated: false, code: 'GATE_CHANGED' });
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun onActivatePastGate={onPass} />);
    fireEvent.click(await screen.findByTestId('golden-past-gate-offer'));
    fireEvent.change(screen.getByTestId('golden-past-gate-reason'), { target: { value: 'Ship the outage fix now' } });
    fireEvent.click(screen.getByTestId('golden-past-gate-confirm'));
    const refusedLine = await screen.findByTestId('golden-past-gate-refused');
    expect(refusedLine.textContent).not.toContain('pastGate.refused');
    expect(svc.readGoldenGate).toHaveBeenCalledTimes(2);
  });

  it('says so when the gate stopped refusing, and closes the confirmation', async () => {
    HELD.capabilities.add('activate-past-golden-gate');
    vi.mocked(svc.readGoldenGate).mockResolvedValueOnce(refusedRun()).mockResolvedValue({ ...gate(null), outcome: { proceed: true, note: 'passed' } });
    const onPass = vi.fn().mockResolvedValue({ activated: false, code: 'GATE_NOT_REFUSING' });
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun onActivatePastGate={onPass} />);
    fireEvent.click(await screen.findByTestId('golden-past-gate-offer'));
    fireEvent.change(screen.getByTestId('golden-past-gate-reason'), { target: { value: 'Ship the outage fix now' } });
    fireEvent.click(screen.getByTestId('golden-past-gate-confirm'));
    expect((await screen.findByTestId('golden-past-gate-refused')).textContent).not.toContain('pastGate.refused');
    await waitFor(() => expect(screen.queryByTestId('golden-past-gate')).toBeNull());
  });

  it('reads nothing again when the person declined, with no refusal from the server', async () => {
    HELD.capabilities.add('activate-past-golden-gate');
    vi.mocked(svc.readGoldenGate).mockResolvedValue(refusedRun());
    const onPass = vi.fn().mockResolvedValue({ activated: false });
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun onActivatePastGate={onPass} />);
    fireEvent.click(await screen.findByTestId('golden-past-gate-offer'));
    fireEvent.change(screen.getByTestId('golden-past-gate-reason'), { target: { value: 'Ship the outage fix now' } });
    fireEvent.click(screen.getByTestId('golden-past-gate-confirm'));
    await waitFor(() => expect(onPass).toHaveBeenCalled());
    expect(svc.readGoldenGate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('golden-past-gate')).toBeTruthy();
  });

  it("shows each intent's coverage, and a set too thin for the active version's minimum, even with no entries", async () => {
    vi.mocked(svc.readGoldenGate).mockResolvedValue({
      profileName: 'advisor', draftConfigId: 'cfg-2', available: true,
      gate: {
        entries: 0, regressionEntries: 0, run: null, minRegressionPerIntent: 2,
        coverage: [{ intent: 'report_generation', regression: 0, capability: 0, uploaded: 0, exercised: 0 }],
        outsidePack: [{ intent: 'weather', entries: 1 }],
      },
      outcome: { proceed: false, code: 'GOLDEN_SET_THIN', params: { count: 1, min: 2, intents: 'report_generation' }, error: 'thin' },
    });
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun />);
    const thin = await screen.findByTestId('golden-set-thin');
    expect(thin.textContent).toContain('report_generation');
    expect(thin.textContent).not.toContain('refusal.GOLDEN_SET_THIN');
    const coverage = screen.getByTestId('golden-coverage');
    expect(coverage.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(coverage.querySelector('tbody tr')!.className).toContain('admin-golden-coverage-thin');
    expect(coverage.textContent).toContain('weather (1)');
  });

  it('names the intents a passing run checked nothing for', async () => {
    vi.mocked(svc.readGoldenGate).mockResolvedValue({ ...gate(null), outcome: { proceed: true, note: 'passed', unchecked: ['code_review'] } });
    render(<GoldenRunPanel profileName="advisor" draftConfigId="cfg-2" canRun />);
    expect((await screen.findByTestId('golden-unchecked')).textContent).toContain('code_review');
  });

  it('never waits on a timer', () => {
    const source = fs.readFileSync(path.join(__dirname, 'GoldenRunPanel.tsx'), 'utf8');
    expect(source).not.toMatch(/setInterval|setTimeout/);
  });
});
