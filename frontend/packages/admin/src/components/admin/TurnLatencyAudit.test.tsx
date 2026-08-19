/**
 * The per-turn audit drill.
 *
 * What matters is not that a table renders. It is that an operator can reconcile a number:
 *   - the ledger is read for the conversation they name, not for a date window;
 *   - the instants and the residuals are shown, because those are what a reconciliation compares;
 *   - a NEGATIVE unattributed_ms is marked, since that is the "compute attributed to the wrong turn"
 *     case the ledger exists to expose;
 *   - an empty result SAYS which of the two things it means, rather than rendering a blank table.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TurnLatencyAudit from './TurnLatencyAudit';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const RANGE = { startDate: '2026-08-10', endDate: '2026-08-17' } as never;
const ARN = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';

const row = (over: Record<string, unknown> = {}) => ({
  turn_id: 'abc123def4567890',
  response_id: 'm-1',
  turn_id_source: 'declared',
  trigger_kind: 'user',
  battle_round: null,
  responder: 'Assistant',
  t0_user_at: '2026-08-17T10:00:00.000Z',
  t2_placeholder_at: '2026-08-17T10:00:01.200Z',
  t3_final_at: '2026-08-17T10:00:06.500Z',
  ttff_ms: 1200,
  e2e_ms: 6500,
  answer_ms: 5300,
  unattributed_ms: 40,
  overhead_ms: 12,
  status: 'closed',
  progress_update_count: 1,
  task_id: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(queryAnalytics).mockReset();
});

const auditFor = async (arn: string) => {
  render(<TurnLatencyAudit dateRange={RANGE} />);
  fireEvent.change(screen.getByLabelText('Conversation ARN'), { target: { value: arn } });
  fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
};

describe('TurnLatencyAudit', () => {
  it('reads the ledger for the conversation the operator named', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row()] } as never);

    await auditFor(ARN);

    await waitFor(() => expect(queryAnalytics).toHaveBeenCalled());
    const [queryType, , extra] = vi.mocked(queryAnalytics).mock.calls[0];
    expect(queryType).toBe('turn_latency_audit');
    // Scoped by CHANNEL. An unbounded ledger read is a table scan, and the auditing workflow always
    // starts from a conversation someone is looking at.
    expect((extra as Record<string, unknown>).channelArn).toBe(ARN);
  });

  it('shows the instants and the durations a reconciliation needs', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row()] } as never);

    await auditFor(ARN);

    // The durations are arithmetic over the instants; both have to be on screen or the operator is
    // being asked to trust the number rather than check it.
    expect(await screen.findByText('1200ms')).toBeTruthy();
    expect(screen.getByText('6500ms')).toBeTruthy();
    expect(screen.getByText(/2026-08-17 10:00:00/)).toBeTruthy();
  });

  it('marks a NEGATIVE unattributed residual - compute attributed to the wrong turn', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row({ unattributed_ms: -250 })] } as never);

    await auditFor(ARN);

    const cell = await screen.findByText('-250ms');
    expect(cell.className).toContain('status-bad');
  });

  it('an unclosed turn shows no end-to-end figure rather than a zero', async () => {
    // A zero would read as an instant answer. The turn never closed; that is a recorded state.
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row({ t3_final_at: null, e2e_ms: null, answer_ms: null, status: 'unclosed' })],
    } as never);

    await auditFor(ARN);

    expect(await screen.findByText('unclosed')).toBeTruthy();
    expect(screen.queryByText('0ms')).toBeNull();
  });

  it('says what an empty result means instead of rendering a blank table', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [] } as never);

    await auditFor(ARN);

    expect(await screen.findByText(/No ledger rows for this conversation/)).toBeTruthy();
  });

  it('surfaces a payload error rather than showing it as no data', async () => {
    // The backend answers an unusable request with an error INSIDE the payload, so without this an
    // operator sees "no turns" for what is actually "you did not give me enough to look at".
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [], error: 'channelArn is required to audit a turn' } as never);

    await auditFor(ARN);

    expect(await screen.findByRole('alert')).toHaveTextContent('channelArn is required');
  });

  it('does not read the ledger until a conversation is named', () => {
    render(<TurnLatencyAudit dateRange={RANGE} />);
    expect(screen.getByRole('button', { name: 'Audit' })).toBeDisabled();
    expect(queryAnalytics).not.toHaveBeenCalled();
  });
});
