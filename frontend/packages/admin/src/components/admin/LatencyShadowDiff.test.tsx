/**
 * The shadow diff is read by the person deciding whether the Latency tab's read can move to the ledger.
 *
 * The assertions are about READING, not rendering: the panel must name which side the tab's figures
 * come from - the ledger, since the repoint - the summary must carry the real counts and the
 * difference distribution, a disagreeing turn must be visible with both figures and the direction of
 * the difference, and the class filter must actually narrow the rows.
 */
import '@ae/shared/i18n';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LatencyShadowDiff from './LatencyShadowDiff';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const RANGE = { start: '2026-09-08', end: '2026-09-15' };

const summary = (over: Record<string, unknown> = {}) => ({
  tolerance_ms: 1,
  compared_count: 1148,
  agree_count: 1140,
  disagree_count: 2,
  derived_only_count: 5,
  ledger_only_count: 1,
  ttff_diff_sample_count: 1142,
  p50_abs_ttff_diff_ms: 0,
  p95_abs_ttff_diff_ms: 1,
  max_abs_ttff_diff_ms: 412,
  e2e_diff_sample_count: 1100,
  p50_abs_e2e_diff_ms: 0,
  p95_abs_e2e_diff_ms: 0,
  max_abs_e2e_diff_ms: 3315,
  exchange_anchored_count: 37,
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  response_id: 'resp-disagree-1',
  channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/x/channel/c1',
  turn_id: 'corr-1',
  exchange_id: 91,
  placeholder_at: '2026-09-14T10:11:12.000Z',
  assistant: 'premium',
  paired_by: 'in_batch',
  anchor_source: 'ledger',
  trigger_kind: 'user',
  derived_ttff_ms: 2100,
  ledger_ttff_ms: 2512,
  ttff_diff_ms: 412,
  derived_e2e_ms: 5200,
  ledger_e2e_ms: 5200,
  e2e_diff_ms: 0,
  classification: 'disagree',
  disagreed_on: 'ttff',
  ...over,
});

// A block body, not an expression: vitest calls a function returned from beforeEach as the test's
// teardown, and mockReset returns the mock itself - so the failure test's throwing mock ran once more
// after the test and failed it.
beforeEach(() => { vi.mocked(queryAnalytics).mockReset(); });

describe('the derived path and the ledger, compared per turn', () => {
  it('asks the shadow-diff query for the tab window', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [], summary: summary() } as never);
    render(<LatencyShadowDiff dateRange={RANGE} />);
    await waitFor(() => expect(queryAnalytics).toHaveBeenCalled());
    expect(vi.mocked(queryAnalytics).mock.calls[0][0]).toBe('turn_latency_shadow_diff');
    expect(vi.mocked(queryAnalytics).mock.calls[0][1]).toEqual(RANGE);
  });

  it('names the authoritative side - the ledger - even before data arrives', async () => {
    // Without this a reader cannot tell which side the console's figures come from, and the panel
    // reads as a proposal rather than as a check. It moved to Operations, where it sits beside the
    // other watchdogs rather than among the numbers it is vouching for, and the statement matters
    // more there, not less: nothing else on that surface explains where latency figures originate.
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [], summary: summary({ compared_count: 0 }) } as never);
    render(<LatencyShadowDiff dateRange={RANGE} />);
    expect(screen.getByRole('note')).toHaveTextContent('comes from the turn ledger');
    expect(screen.getByRole('note')).not.toHaveTextContent('comes from the derived path');
    // 'nothing to compare' is NOT 'they agree', and the empty copy has to say which it is.
    expect(await screen.findByText(/measured by both paths/)).toBeInTheDocument();
    expect(await screen.findByText(/not the same as agreement/)).toBeInTheDocument();
  });

  it('shows the real counts per class and the distribution of the difference', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [row(), row({ response_id: 'resp-derived-only', classification: 'derived_only', ledger_ttff_ms: null, ledger_e2e_ms: null, ttff_diff_ms: null, e2e_diff_ms: null, disagreed_on: null })],
      summary: summary(),
    } as never);
    render(<LatencyShadowDiff dateRange={RANGE} />);

    const compared = (await screen.findByText('Compared')).closest('.metric-card') as HTMLElement;
    expect(within(compared).getByText((1148).toLocaleString())).toBeInTheDocument();
    const agree = screen.getByText('Agree', { selector: '.metric-card-title' }).closest('.metric-card') as HTMLElement;
    expect(within(agree).getByText((1140).toLocaleString())).toBeInTheDocument();
    const derivedOnly = screen.getByText('Derived only', { selector: '.metric-card-title' }).closest('.metric-card') as HTMLElement;
    expect(within(derivedOnly).getByText('5')).toBeInTheDocument();

    const ttff = screen.getByText('TTFF difference').closest('.metric-card') as HTMLElement;
    expect(within(ttff).getByText('p50 0ms · p95 1ms')).toBeInTheDocument();
    expect(within(ttff).getByText('max 412ms over 1142 turns')).toBeInTheDocument();
    const e2e = screen.getByText('E2E difference').closest('.metric-card') as HTMLElement;
    expect(within(e2e).getByText('max 3.3s over 1100 turns')).toBeInTheDocument();

    // The tolerance is stated with its value, and the weaker exchange-anchored agreement is counted.
    expect(screen.getByText(/within 1 ms/)).toBeInTheDocument();
    expect(screen.getByText(/37 of the turns both paths measured/)).toBeInTheDocument();
  });

  it('lists a disagreeing turn with both figures and the signed difference', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [row()], summary: summary() } as never);
    render(<LatencyShadowDiff dateRange={RANGE} />);

    const cell = await screen.findByText('resp-disagree-1');
    const tr = cell.closest('tr') as HTMLElement;
    expect(within(tr).getByText('Disagree')).toBeInTheDocument();
    expect(within(tr).getByText('ttff')).toBeInTheDocument();
    expect(within(tr).getByText('2.1s')).toBeInTheDocument();
    expect(within(tr).getByText('2.5s')).toBeInTheDocument();
    expect(within(tr).getByText('+412ms')).toBeInTheDocument();
  });

  it('narrows the rows to one class', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [
        row(),
        row({ response_id: 'resp-ledger-only', classification: 'ledger_only', derived_ttff_ms: null, derived_e2e_ms: null, ttff_diff_ms: null, e2e_diff_ms: null, disagreed_on: null, exchange_id: null, paired_by: null }),
      ],
      summary: summary(),
    } as never);
    render(<LatencyShadowDiff dateRange={RANGE} />);

    expect(await screen.findByText('resp-disagree-1')).toBeInTheDocument();
    expect(screen.getByText('resp-ledger-only')).toBeInTheDocument();

    const group = screen.getByRole('group', { name: 'Show' });
    await userEvent.click(within(group).getByRole('button', { name: 'Ledger only' }));

    expect(screen.queryByText('resp-disagree-1')).not.toBeInTheDocument();
    expect(screen.getByText('resp-ledger-only')).toBeInTheDocument();
  });

  it('says every turn agreed rather than rendering an empty table', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [],
      summary: summary({ agree_count: 1148, disagree_count: 0, derived_only_count: 0, ledger_only_count: 0 }),
    } as never);
    render(<LatencyShadowDiff dateRange={RANGE} />);
    expect(await screen.findByText(/Every turn both paths measured agreed/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    vi.mocked(queryAnalytics).mockImplementation(async () => { throw new Error('Analytics query failed: 500'); });
    render(<LatencyShadowDiff dateRange={RANGE} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Analytics query failed: 500');
  });
});
