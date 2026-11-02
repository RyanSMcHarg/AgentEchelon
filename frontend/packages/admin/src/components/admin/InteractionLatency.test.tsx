/**
 * The interaction breakdown exists to stop three different questions being answered by one number.
 *
 * The assertions are about READING, not rendering: a proactive turn must show a latency, a blank
 * TTFF must be legible as correct rather than missing, and a derived anchor must be visibly weaker
 * evidence than a declared one.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import InteractionLatency from './InteractionLatency';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const RANGE = { startDate: '2026-08-15', endDate: '2026-08-22' } as never;

const row = (over: Record<string, unknown> = {}) => ({
  interaction: 'user',
  turn_count: '40',
  measured_count: '40',
  avg_ack_ms: '2100',
  p95_ack_ms: '3800',
  avg_ttff_ms: '2100',
  avg_e2e_ms: '5200',
  avg_total_ms: '2500',
  declared_count: '40',
  derived_count: '0',
  unanchored_count: '0',
  ...over,
});

beforeEach(() => vi.mocked(queryAnalytics).mockReset());

describe('latency by interaction', () => {
  it('reads the interaction split, not the flat latency query', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row()] } as never);
    render(<InteractionLatency dateRange={RANGE} />);
    await waitFor(() => expect(queryAnalytics).toHaveBeenCalled());
    expect(vi.mocked(queryAnalytics).mock.calls[0][0]).toBe('latency_by_interaction');
  });

  it('shows a rebuttal with an Ack even though its TTFF is blank', async () => {
    // THE WHOLE POINT. Before Ack existed, this row rendered as a dash and read as unmeasured -
    // which on a duel-heavy day is the majority of assistant messages.
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row({
        interaction: 'rebuttal',
        turn_count: '12',
        avg_ack_ms: '880',
        avg_ttff_ms: null,
        declared_count: '12',
      })],
    } as never);

    render(<InteractionLatency dateRange={RANGE} />);

    expect(await screen.findByText('Battle round 2 (rebuttal)')).toBeTruthy();
    expect(screen.getByText('880ms')).toBeTruthy();
  });

  it('shows battle round 2 with its own End to end, labeled as round 2', async () => {
    // Round two's end to end runs from the instant it was triggered to the rebuttal's final answer
    // (migration 071). It is reported on its own row, named as the round it is, rather than averaged
    // into the person-initiated rows.
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [
        row(),
        row({ interaction: 'rebuttal', turn_count: '6', avg_ack_ms: '900', avg_ttff_ms: null, avg_e2e_ms: '7400' }),
      ],
    } as never);

    render(<InteractionLatency dateRange={RANGE} />);

    const label = await screen.findByText('Battle round 2 (rebuttal)');
    const rebuttalRow = label.closest('tr')!;
    expect(rebuttalRow.textContent).toContain('7.4s');
    // The person's row keeps its own figure; the two are not merged.
    expect(screen.getByText('User').closest('tr')!.textContent).toContain('5.2s');
  });

  it('keeps an untaught kind on its humanized name', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row({ interaction: 'some_new_kind' })] } as never);
    render(<InteractionLatency dateRange={RANGE} />);
    expect(await screen.findByText('Some new kind')).toBeTruthy();
  });

  it('says a blank TTFF is by construction, not missing data', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row({ interaction: 'rebuttal', avg_ttff_ms: null })],
    } as never);

    render(<InteractionLatency dateRange={RANGE} />);

    // Asserted on the EXPLANATION rather than the dash: a dash with no explanation is exactly the
    // ambiguity this table was built to remove.
    const dash = (await screen.findAllByText('—'))[0];
    expect(dash.closest('span')?.getAttribute('title')).toContain('no user message to measure from');
  });

  it('separates a derived anchor from a declared one', async () => {
    // A row resting on a reconstruction must not present with the same confidence as one resting on
    // an observed instant.
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row({ interaction: 'rebuttal', declared_count: '3', derived_count: '9', unanchored_count: '0' })],
    } as never);

    render(<InteractionLatency dateRange={RANGE} />);

    expect(await screen.findByText(/3 declared/)).toBeTruthy();
    expect(screen.getByText(/9 derived/)).toBeTruthy();
  });

  it('reports turns nothing could anchor rather than hiding them', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row({ declared_count: '0', derived_count: '0', unanchored_count: '7', avg_ack_ms: null })],
    } as never);

    render(<InteractionLatency dateRange={RANGE} />);

    expect(await screen.findByText(/7 none/)).toBeTruthy();
  });

  it('says an empty window is empty rather than rendering a bare table', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [] } as never);
    render(<InteractionLatency dateRange={RANGE} />);
    expect(await screen.findByText(/No turns were recorded in this window/)).toBeTruthy();
  });
});
