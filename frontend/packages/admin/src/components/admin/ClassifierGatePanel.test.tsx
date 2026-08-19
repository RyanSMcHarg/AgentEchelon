/**
 * The classification shadow gate surface (DESIGN-EXPERIMENTS-BATTLE §5).
 *
 * The tests that matter are the refusals. A verdict shown from an unfinished run, or a concordant
 * pair put in front of a human, both produce work and confidence that the data does not support -
 * and both look completely normal on screen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ClassifierGatePanel, { gateAuthorisesSplit, disagreementRate } from './ClassifierGatePanel';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const range = { start: '2026-07-08', end: '2026-08-07' };

const run = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  experimentId: 'exp1',
  incumbentModel: 'haiku',
  challengerModel: 'sonnet',
  windowStart: '2026-07-08T00:00:00.000Z',
  windowEnd: '2026-08-07T00:00:00.000Z',
  messagesConsidered: 400,
  messagesReplayed: 345,
  messagesRetracted: 3,
  messagesFastPath: 52,
  status: 'complete',
  ...over,
});

const gate = (over: Record<string, unknown> = {}) => ({
  verdict: 'challenger_better',
  rationale: 'The challenger won 42 of 60 informative disagreements.',
  marginPct: 2,
  accuracyDelta: 0.06,
  accuracyDeltaCi: [0.02, 0.1],
  summary: {
    total: 400, concordant: 340, discordant: 60, adjudicated: 60, pending: 0,
    challengerOnlyRight: 42, incumbentOnlyRight: 18, bothWrong: 0,
  },
  ...over,
});

/** Route each queryType to its fixture, so tests state intent rather than call order. */
function prime(fixtures: Record<string, unknown>) {
  mockQuery.mockImplementation(async (qt: string) => (fixtures[qt] ?? { data: [] }) as never);
}

beforeEach(() => mockQuery.mockReset());

describe('gateAuthorisesSplit', () => {
  it('authorises only a FINISHED run with a clearing verdict', () => {
    expect(gateAuthorisesSplit(run() as never, gate() as never)).toBe(true);
    expect(gateAuthorisesSplit(run() as never, gate({ verdict: 'non_inferior' }) as never)).toBe(true);
  });

  it('refuses on every verdict that does not clear', () => {
    for (const verdict of ['worse', 'indistinguishable', 'insufficient']) {
      expect(gateAuthorisesSplit(run() as never, gate({ verdict }) as never)).toBe(false);
    }
  });

  it('refuses a run that did not FINISH, whatever its verdict says', () => {
    // A truncated corpus can produce a clearing verdict from the fraction it managed to replay.
    expect(gateAuthorisesSplit(run({ status: 'failed' }) as never, gate() as never)).toBe(false);
    expect(gateAuthorisesSplit(run({ status: 'running' }) as never, gate() as never)).toBe(false);
  });

  it('refuses when there is no gate at all', () => {
    expect(gateAuthorisesSplit(run() as never, null)).toBe(false);
    expect(gateAuthorisesSplit(null, gate() as never)).toBe(false);
  });
});

describe('disagreementRate (§5.4 sizes the split before it runs)', () => {
  it('is the discordant share of the replayed corpus', () => {
    expect(disagreementRate(gate() as never)).toBeCloseTo(0.15, 10);
  });
  it('is null when nothing was replayed, rather than zero', () => {
    // Zero would read as "they never disagree", which is a finding. No data is not a finding.
    expect(disagreementRate(gate({ summary: { ...gate().summary, total: 0 } }) as never)).toBeNull();
  });
});

describe('ClassifierGatePanel', () => {
  it('says plainly when no replay has been run', async () => {
    prime({ classifier_replays: { data: [] } });
    render(<ClassifierGatePanel dateRange={range} />);
    await waitFor(() =>
      expect(screen.getByText(/judged on the answer rather than on the labelling/i)).toBeTruthy(),
    );
  });

  it('describes the CORPUS: the window and what was excluded from it', async () => {
    // A replay you cannot describe is not evidence about anything, and both exclusions change what
    // the numbers mean.
    prime({
      classifier_replays: { data: [run()] },
      classifier_replay: { run: run(), gate: gate() },
      classifier_replay_labels: { data: [], total: 0 },
    });
    render(<ClassifierGatePanel dateRange={range} />);
    (await screen.findByRole('button', { name: /haiku vs sonnet/i })).click();

    await waitFor(() => expect(screen.getByText(/Replayed 345 of 400 messages/i)).toBeTruthy());
    expect(screen.getByText(/3 were retracted by a redaction or deletion/i)).toBeTruthy();
    expect(screen.getByText(/52 are answered without a model/i)).toBeTruthy();
  });

  it('flags an unfinished run ABOVE its numbers', async () => {
    prime({
      classifier_replays: { data: [run({ status: 'failed' })] },
      classifier_replay: { run: run({ status: 'failed', error: 'aurora unavailable' }), gate: gate() },
      classifier_replay_labels: { data: [], total: 0 },
    });
    render(<ClassifierGatePanel dateRange={range} />);
    (await screen.findByRole('button', { name: /haiku vs sonnet/i })).click();

    await waitFor(() => expect(screen.getByText(/not a reading of the window above/i)).toBeTruthy());
  });

  it('warns when the models agree too closely for a split to detect anything', async () => {
    // §5.4: if they agree on 99.5% of traffic, no online experiment can find a difference.
    prime({
      classifier_replays: { data: [run()] },
      classifier_replay: {
        run: run(),
        gate: gate({ summary: { ...gate().summary, discordant: 2, total: 1000 } }),
      },
      classifier_replay_labels: { data: [], total: 0 },
    });
    render(<ClassifierGatePanel dateRange={range} />);
    (await screen.findByRole('button', { name: /haiku vs sonnet/i })).click();

    await waitFor(() =>
      expect(screen.getByText(/almost nothing to detect, and is probably not worth running/i)).toBeTruthy(),
    );
  });

  it('queues ONLY disagreements, and offers a "neither" ruling', async () => {
    prime({
      classifier_replays: { data: [run()] },
      classifier_replay: {
        run: run(),
        gate: gate({ verdict: 'insufficient', summary: { ...gate().summary, adjudicated: 0, pending: 60 } }),
      },
      classifier_replay_labels: {
        data: [{ id: 'l1', exchangeId: 'e1', incumbentLabel: 'general', challengerLabel: 'code_generation' }],
        total: 60,
      },
    });
    render(<ClassifierGatePanel dateRange={range} />);
    (await screen.findByRole('button', { name: /haiku vs sonnet/i })).click();

    await waitFor(() => expect(screen.getByText(/Only the disagreements are here/i)).toBeTruthy());
    // Both predictions offered as one-click rulings, plus the third option: neither was right.
    expect(screen.getByRole('button', { name: 'general' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'code_generation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neither' })).toBeTruthy();
  });

  it('says how much of the queue is on screen, so a page cannot read as the whole queue', async () => {
    prime({
      classifier_replays: { data: [run()] },
      classifier_replay: {
        run: run(),
        gate: gate({ verdict: 'insufficient', summary: { ...gate().summary, adjudicated: 0, pending: 60 } }),
      },
      classifier_replay_labels: {
        data: [{ id: 'l1', exchangeId: 'e1', incumbentLabel: 'general', challengerLabel: 'code_generation' }],
        total: 60,
      },
    });
    render(<ClassifierGatePanel dateRange={range} />);
    (await screen.findByRole('button', { name: /haiku vs sonnet/i })).click();

    await waitFor(() => expect(screen.getByText(/showing 1 of 60/i)).toBeTruthy());
  });

  it('will not start a replay without both models', async () => {
    prime({ classifier_replays: { data: [] } });
    render(<ClassifierGatePanel dateRange={range} />);
    const button = await screen.findByRole('button', { name: /Run replay/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('waits for the run ROW before selecting it, because the id exists before the row does', async () => {
    // The start is answered from OUTSIDE the VPC and cannot write to the database; the batch Lambda
    // inside it opens the row a moment later under the same id. Selecting immediately would read
    // that gap as "No such replay run" and report a failure for a replay that started normally.
    let detailCalls = 0;
    mockQuery.mockImplementation(async (qt: string) => {
      if (qt === 'classifier_replay_start') return { run: { runId: 'run-1' }, started: true } as never;
      if (qt === 'classifier_replay') {
        detailCalls++;
        // The row is not there yet on the first look. That is the normal state, not a failure.
        if (detailCalls === 1) throw new Error('No such replay run');
        return { run: run(), gate: gate() } as never;
      }
      if (qt === 'classifier_replays') return { data: [run()] } as never;
      return { data: [] } as never;
    });

    render(<ClassifierGatePanel dateRange={range} />);
    fireEvent.change(await screen.findByLabelText('Incumbent model'), { target: { value: 'haiku' } });
    fireEvent.change(screen.getByLabelText('Challenger model'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: /Run replay/i }));

    // It retried rather than giving up on the first miss, and the run is now on screen.
    await waitFor(() => expect(detailCalls).toBeGreaterThan(1), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText(/haiku/)).toBeTruthy());
    expect(screen.queryByText(/Could not load the replay/i)).toBeNull();
    expect(screen.queryByText(/never opened/i)).toBeNull();
  });
});
