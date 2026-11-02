/**
 * The handover panel shows how often one assistant passed a person's message to another, and whether the
 * other answered (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4). The assertions are about READING: it
 * asks the handovers query, shows each receiver and kind with its counts, and makes an unanswered handover
 * look wrong rather than ordinary.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Handovers from './Handovers';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const RANGE = { startDate: '2026-10-01', endDate: '2026-10-06' } as never;

const row = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-06',
  receiver: 'ops-premium',
  kind: 'capability',
  sent_count: '4',
  answered_count: '4',
  unanswered_count: '0',
  avg_handover_to_answer_ms: '1850',
  ...over,
});

beforeEach(() => vi.mocked(queryAnalytics).mockReset());

describe('handovers', () => {
  it('reads the handovers query and shows each receiver with its counts', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row()] } as never);

    render(<Handovers dateRange={RANGE} />);

    await waitFor(() => expect(screen.getByText('ops-premium')).toBeTruthy());
    expect(vi.mocked(queryAnalytics)).toHaveBeenCalledWith('handovers', RANGE);
    expect(screen.getByText('capability')).toBeTruthy();
    expect(screen.getByText('1.9s')).toBeTruthy();
  });

  it('marks an unanswered handover as wrong, because it is a misroute or an outage', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row({ answered_count: '3', unanswered_count: '1' })] } as never);

    render(<Handovers dateRange={RANGE} />);

    const cell = await screen.findByText('1', { selector: 'span.status-bad' });
    expect(cell).toBeTruthy();
  });

  it('says so when the window holds none, rather than showing an empty table', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [] } as never);

    render(<Handovers dateRange={RANGE} />);

    await waitFor(() => expect(screen.getByText(/No handovers in this window|admin\.handovers\.empty/)).toBeTruthy());
  });
});
