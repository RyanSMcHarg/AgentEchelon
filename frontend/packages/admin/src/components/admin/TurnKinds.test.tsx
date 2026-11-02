/**
 * The turn-kind panel exists so a person can see WHICH TURNS ARE IN the figures beside it.
 *
 * Drift is excluded from normal responses and still tracked in analytics, filterable and viewable on its
 * own, like readings. This console makes every turn kind visible, not only diagnosable.
 *
 * The assertions are about READING, not rendering: a non-answer kind must be visible with its own
 * reply time, a pairing that ignored a declaration must look wrong rather than ordinary, and the
 * filter must actually narrow the population.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TurnKinds from './TurnKinds';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const RANGE = { startDate: '2026-09-04', endDate: '2026-09-11' } as never;

const row = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-11',
  turn_kind: 'answer',
  message_count: '120',
  declared_target_count: '118',
  exchange_count: '118',
  avg_reply_ms: '2600',
  reply_measured_count: '118',
  ...over,
});

beforeEach(() => vi.mocked(queryAnalytics).mockReset());

describe('turn kinds', () => {
  it('reads the turn-kind breakdown, not a latency query', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row()] } as never);

    render(<TurnKinds dateRange={RANGE} />);

    await waitFor(() => expect(queryAnalytics).toHaveBeenCalled());
    expect(vi.mocked(queryAnalytics).mock.calls[0][0]).toBe('turn_kinds');
  });

  it('shows a drift suggestion with its own reply time, separate from answers', async () => {
    // THE WHOLE POINT. A suggestion answers fast and deliberately does not do the work, so mixing it
    // into the answer average would drag every latency figure down while representing a turn that
    // answered nothing. Here the fast number is visible and is not in that average.
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [
        row(),
        row({
          turn_kind: 'drift',
          message_count: '9',
          declared_target_count: '9',
          exchange_count: '0',
          avg_reply_ms: '410',
          reply_measured_count: '9',
        }),
      ],
    } as never);

    render(<TurnKinds dateRange={RANGE} />);

    expect(await screen.findByText('Drift')).toBeTruthy();
    expect(screen.getByText('410ms')).toBeTruthy();
    expect(screen.getByText('2.6s')).toBeTruthy();
  });

  it('marks a declared kind that was paired anyway as wrong, not as data', async () => {
    // A turn that said it is not an answer and still minted an exchange is a pairing that ignored a
    // declaration. Rendered like any other number it reads as a fact about the traffic.
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row({ turn_kind: 'reading', message_count: '4', exchange_count: '2' })],
    } as never);

    render(<TurnKinds dateRange={RANGE} />);

    const cell = await screen.findByText('2');
    expect(cell.className).toContain('status-bad');
  });

  it('does not flag zero exchanges on a declared kind, which is the correct outcome', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row({ turn_kind: 'reading', message_count: '4', exchange_count: '0' })],
    } as never);

    render(<TurnKinds dateRange={RANGE} />);

    const cell = await screen.findByText('0');
    expect(cell.className || '').not.toContain('status-bad');
  });

  it('narrows to the turns that are not answers when asked', async () => {
    // Answers are the bulk of every window, so "what else ran" has to be one click away rather than
    // a scroll through the population it is being compared against.
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row(), row({ turn_kind: 'reading', message_count: '4', exchange_count: '0' })],
    } as never);

    // Scoped to the TABLE cell: the caption below the table names both kinds in prose, so a bare
    // text query would match copy that never changes and pass whatever the filter did.
    const kindCell = (kind: string) =>
      screen.queryAllByText(kind).find((el) => el.hasAttribute('title'));

    render(<TurnKinds dateRange={RANGE} />);
    await waitFor(() => expect(kindCell('Answer')).toBeTruthy());

    await userEvent.click(screen.getByRole('checkbox'));

    expect(kindCell('Answer')).toBeUndefined();
    expect(kindCell('Reading')).toBeTruthy();
  });

  it('names a kind it has not been taught about rather than rendering it as settled', async () => {
    // A kind this console does not know is a producer that shipped ahead of its reader, which is
    // worth saying out loud.
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row({ turn_kind: 'rehearsal', message_count: '3', exchange_count: '0' })],
    } as never);

    render(<TurnKinds dateRange={RANGE} />);

    const cell = await screen.findByText('Rehearsal');
    expect(cell.getAttribute('title')).toContain('has no description for yet');
  });
});
