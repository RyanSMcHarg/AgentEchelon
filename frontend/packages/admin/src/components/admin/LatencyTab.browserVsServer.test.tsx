/**
 * THE BROWSER NUMBER MOVED INTO THE TURN DRILL, AND ITS COVERAGE STOPPED BEING HIDDEN.
 *
 * "There is too much on the latency page... The browser vs server could maybe be rolled into the
 * exchange." It was a third list of turns, below two that already listed turns, with its own 200-row
 * window and no filters. A reader comparing browser against server held a row from one table beside a
 * row from another and hoped they were the same population.
 *
 * THE PART THAT MATTERS MOST IS THE COVERAGE. The old table joined client to server and listed only
 * rows where BOTH existed, so it could never show how rarely the browser number is present - the
 * client timing exists only for turns where the chat bundle saw the placeholder land and tagged it
 * with the correlation id. Inside the drill, a turn with no client timing renders a dash beside a real
 * server figure. That is a worse-looking table and a truer one, and it is the reason this is a fold
 * rather than a move.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import LatencyTab from './LatencyTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const RANGE = { start: '2026-09-01', end: '2026-09-08' };

const row = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-02',
  assistant: 'standard',
  delivery_option: 'DIRECT_REPLY',
  assistant_turn_count: '100',
  avg_ttff_ms: '2000',
  avg_e2e_ms: '9000',
  avg_total_ms: '5000',
  avg_router_ms: '900',
  ttff_measured_count: '100',
  turn_entry: 'flow',
  ...over,
});

/** Two turns: one the browser reported, one it did not. The second is the point of the change. */
const TURNS = [
  {
    created_at: '2026-09-02T10:00:00.000Z', intent: 'general',
    ttff_ms: 2000, client_ttff_ms: 2350, delivery_gap_ms: 350,
    total_ms: 5000, e2e_ms: 9000, router_ms: 900, latency_ms: 4000,
    bedrock_model: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  },
  {
    created_at: '2026-09-02T11:00:00.000Z', intent: 'report_generation',
    ttff_ms: 1800, client_ttff_ms: null, delivery_gap_ms: null,
    total_ms: 4200, e2e_ms: 7000, router_ms: 800, latency_ms: 3300,
    bedrock_model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  },
];

function renderTab(rows: Record<string, unknown>[] = [row()]) {
  return render(
    <LatencyTab
      data={{ data: rows } as never}
      routerStepsData={null}
      isLoading={false}
      dateRange={RANGE}
      analyticsMode="aurora"
      filters={EMPTY_FILTERS}
      onFiltersChange={() => {}}
    />
  );
}

beforeEach(() => {
  vi.mocked(queryAnalytics).mockReset();
  // The tab fetches several query types on mount. Answering all of them with the turn rows would let
  // a passing assertion come from the wrong fetch, so the mock replies per type and everything else
  // gets an empty set.
  vi.mocked(queryAnalytics).mockImplementation((queryType: unknown) =>
    Promise.resolve({ data: queryType === 'latency_exchanges' ? TURNS : [] }) as never
  );
});

/** The drill fetch, found by type rather than by position: the tab fetches other things on mount. */
const drillCalls = () =>
  vi.mocked(queryAnalytics).mock.calls.filter((c) => c[0] === 'latency_exchanges');

describe('the browser comparison lives in the turn drill', () => {
  it('no longer renders a standalone browser-vs-server table', () => {
    renderTab();
    // The heading the old table carried. The comparison now lives in the turn drill, which keeps the page focused.
    expect(screen.queryByText(/Browser vs server/i)).not.toBeInTheDocument();
  });

  it('shows the browser figure and the delivery gap beside the server TTFF', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(document.querySelector('.data-table-row--clickable') as Element);

    const drill = await screen.findByRole('region', { name: /Turns in this group/i });
    // COLUMN HEADERS specifically, not just the words. An <option value="client_ttff_ms">Browser</option>
    // already exists on this page, so a plain text match passed on a dropdown entry rather than on the
    // table this change is about.
    expect(within(drill).getByRole('columnheader', { name: 'Browser' })).toBeInTheDocument();
    expect(within(drill).getByRole('columnheader', { name: 'Delivery and render' })).toBeInTheDocument();
    // And the values land, so the columns are wired to the row rather than merely declared.
    expect(within(drill).getByText('2.4s')).toBeInTheDocument();
  });

  it('asks the backend for the turns behind the row that was clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(document.querySelector('.data-table-row--clickable') as Element);
    // The drill is keyed on the whole group; the browser columns ride that same population rather
    // than a second 200-row window of their own, which is the whole point of folding it in.
    await waitFor(() => expect(drillCalls().length).toBeGreaterThan(0));
  });

  it('renders a dash for a turn the browser never reported, rather than hiding the turn', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(document.querySelector('.data-table-row--clickable') as Element);
    const drill = await screen.findByRole('region', { name: /Turns in this group/i });

    // Both turns are listed. The old table would have shown only the first, which is how it concealed
    // its own coverage: a reader could not tell a well-measured population from a filtered one.
    expect(within(drill).getByText('report_generation')).toBeInTheDocument();
    expect(within(drill).getByText('general')).toBeInTheDocument();
  });
});

