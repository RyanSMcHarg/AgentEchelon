/**
 * A RATE OVER A POPULATION THAT CANNOT SUPPORT IT MUST NOT READ LIKE ONE THAT CAN.
 *
 * Measured on this surface: `image_generation` carried ONE exchange and `process_lookup` five, beside
 * intents carrying hundreds - every rate drawn to one decimal place, at the same visual weight, feeding
 * the same worst-first ranking. This surface is careful everywhere else (no rate without its denominator,
 * no unjudged row coalesced to zero), and then drew a rate over five at the same weight as one over five
 * hundred.
 *
 * THE RANKING IS THE HALF THAT MATTERS, and it is what these tests spend most of their assertions on.
 * Hiding the number while still ordering the table by it would be worse than showing it: the reader sees
 * "too few to report" at position one and reads the POSITION as the finding.
 *
 * Suppression is an OPTION, and the option is why the marking tests exist. Switching it off must reveal
 * the numbers without restoring a surface that reads as confident - an option that could do that would be
 * the original defect wearing a checkbox.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

const range = { start: '2026-05-13', end: '2026-05-20' };

/**
 * `thin_intent` is the measured shape: a terrible relevance average over THREE scored turns, which under
 * the old rule floated it above a healthy intent carrying four hundred. `busy_intent` is healthy and
 * high-volume, so any ordering change is attributable to the rule rather than to a tie-break.
 */
const ROWS = result([
  {
    intent: 'busy_intent', exchange_count: 400, direct_count: 400, task_count: 0,
    avg_confidence: 95, avg_relevance: 88, relevance_scored_count: 380,
    user_flag_rate: 2, user_flag_count: 4, user_rated_count: 200,
    tool_calls: 120, tool_error_rate: 1,
    avg_total_ms: 500, p95_total_ms: 900,
  },
  {
    intent: 'thin_intent', exchange_count: 3, direct_count: 3, task_count: 0,
    avg_confidence: 20, avg_relevance: 10, relevance_scored_count: 3,
    user_flag_rate: 50, user_flag_count: 1, user_rated_count: 2,
    tool_calls: 2, tool_error_rate: 50,
    avg_total_ms: 800, p95_total_ms: 1200,
  },
]);

const renderTab = () =>
  render(
    <EffectivenessTab
      data={ROWS}
      dateRange={range}
      isLoading={false}
      filters={EMPTY_FILTERS}
      onFiltersChange={() => {}}
    />,
  );

const rowFor = (intent: string) => screen.getByRole('button', { name: intent }).closest('tr')!;
const cell = (intent: string, field: string) => rowFor(intent).querySelector(`[data-label="${field}"]`)!;
const toggle = () => screen.getByRole('checkbox', { name: /Hide rates based on fewer than 10 data points/i });

/** True when `first` precedes `second` in document order. */
const precedes = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => mockQuery.mockReset());

describe('suppression is on by default', () => {
  it('replaces an underpopulated rate with a stated reason rather than a number', () => {
    renderTab();
    const relevance = cell('thin_intent', 'avg_relevance');
    expect(relevance.textContent).toMatch(/too few to report/i);
    // The FIGURE is what is withheld. 10.0 must not appear anywhere in the cell.
    expect(relevance.textContent).not.toMatch(/10\.0/);
  });

  it('keeps the denominator and the volume, which is the whole point of suppressing rather than hiding', () => {
    renderTab();
    // Hiding the population as well would leave a reader unable to tell a suppressed rate from an
    // absent one - strictly worse than the status quo this replaces.
    expect(cell('thin_intent', 'avg_relevance').textContent).toMatch(/3 scored/);
    expect(cell('thin_intent', 'exchange_count').textContent).toMatch(/3/);
    expect(cell('thin_intent', 'user_flag_rate').textContent).toMatch(/1 of 2 rated/);
  });

  it('keeps the drill reachable, so the evidence behind a suppressed rate is still one click away', () => {
    renderTab();
    expect(screen.getByRole('button', { name: 'thin_intent' })).toBeTruthy();
  });

  it('does NOT float the thin intent to the top on a rate it will not print', () => {
    renderTab();
    // The defect: relevance 10 over three scored turns ranked above relevance 88 over 380.
    expect(precedes(rowFor('busy_intent'), rowFor('thin_intent'))).toBe(true);
  });

  it('leaves a well-populated intent untouched', () => {
    renderTab();
    const relevance = cell('busy_intent', 'avg_relevance');
    expect(relevance.textContent).toMatch(/88/);
    expect(relevance.textContent).not.toMatch(/too few to report/i);
    expect(relevance.textContent).not.toMatch(/⚠/);
  });

  it('states the impact on the results, counted from the rows', () => {
    renderTab();
    // Four rates on thin_intent are underpopulated: confidence (3), relevance (3), user signal (2),
    // tools (2). Task execution has no flows, so it is nothing to measure rather than too little.
    expect(screen.getByText(/4 rates are hidden because each is based on fewer than 10 data points/i)).toBeTruthy();
    // TWO of the four feed the ranking - confidence and relevance. User signal and tools never have.
    expect(screen.getByText(/Hidden rates do not affect the ranking/i)).toBeTruthy();
  });

  it('survives a drill and a return, because the reader set it deliberately', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(toggle());
    expect(cell('thin_intent', 'avg_relevance').textContent).toMatch(/⚠ n=3/);

    await user.click(screen.getByRole('button', { name: 'thin_intent' }));
    await user.click(screen.getByRole('button', { name: 'Intents' }));

    // Silently re-enabling would change every figure on the page without the reader asking.
    expect(toggle()).not.toBeChecked();
    expect(cell('thin_intent', 'avg_relevance').textContent).toMatch(/⚠ n=3/);
  });
});

describe('a column sort is a second ordering, and it reads the hidden number', () => {
  it('cannot sort a suppressed rate to the top of the table', async () => {
    const user = userEvent.setup();
    renderTab();
    // Ascending on Relevance puts the lowest score first. thin_intent's 10 is lower than busy's 88,
    // but it is being withheld - so sorting must not hand it position one with no number in the cell.
    const header = screen.getByRole('button', { name: /Relevance/i });
    await user.click(header);
    await user.click(header);
    expect(precedes(rowFor('busy_intent'), rowFor('thin_intent'))).toBe(true);
    expect(cell('thin_intent', 'avg_relevance').textContent).toMatch(/too few to report/i);
  });

  it('keeps suppressed rows at the bottom in BOTH directions', async () => {
    const user = userEvent.setup();
    renderTab();
    const header = screen.getByRole('button', { name: /Relevance/i });
    await user.click(header);
    expect(precedes(rowFor('busy_intent'), rowFor('thin_intent'))).toBe(true);
    await user.click(header);
    expect(precedes(rowFor('busy_intent'), rowFor('thin_intent'))).toBe(true);
  });

  it('sorts normally once suppression is switched off', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(toggle());
    const header = screen.getByRole('button', { name: /Relevance/i });
    await user.click(header);
    await user.click(header);
    // Ascending, nothing withheld: the lowest relevance leads, which is the plain sort.
    expect(precedes(rowFor('thin_intent'), rowFor('busy_intent'))).toBe(true);
  });
});

describe('the rule follows the reader into the drill', () => {
  /**
   * EVERY RATE CARD, NOT THE TWO THAT HAPPENED TO BE WIRED.
   *
   * The rule was applied to Routing confidence and Relevance only, so Task execution, User ratings and
   * Tool error rate still stepped around it - an intent with two tool calls read "too few to report" in
   * the table and a colored "50.0% · 2 calls" on the card one click away. This fixture is thin on all
   * five populations at once, which is the only way to notice a card that was missed.
   */
  const THIN_EVERYWHERE = result([
    {
      intent: 'thin_all', exchange_count: 4, direct_count: 2, task_count: 2,
      // No figure here may be 10: the suppressed card names the threshold ("below the 10 this console
      // reports"), so a fixture value of 10 would match the assertion that the FIGURE is withheld.
      avg_confidence: 20, avg_relevance: 12, relevance_scored_count: 3,
      task_completion_rate: 50, task_flow_count: 2, task_completed: 1, task_failed: 1,
      user_rated_count: 2, user_up_count: 1, user_down_count: 1, user_positive_rate: 50,
      user_flag_rate: 50, user_flag_count: 1,
      tool_calls: 2, tool_error_rate: 50,
    },
  ]);

  const openThin = async () => {
    const user = userEvent.setup();
    render(
      <EffectivenessTab
        data={THIN_EVERYWHERE}
        dateRange={range}
        isLoading={false}
        filters={EMPTY_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'thin_all' }));
  };

  const drillCard = (title: string) => screen.getByText(title).closest('.metric-card')!;

  it.each([
    ['Routing confidence', '20'],
    ['Relevance', '12'],
    ['Task execution', '50'],
    ['User ratings', '50'],
    ['Tool error rate', '50'],
  ])('withholds %s on the card, the way the table already withholds it', async (title, figure) => {
    await openThin();
    const el = drillCard(title);
    expect(el.textContent).toMatch(/too few to report/i);
    expect(el.textContent).not.toMatch(new RegExp(`\\b${figure}\\b`));
  });

  it.each(['Routing confidence', 'Relevance', 'Task execution', 'User ratings', 'Tool error rate'])(
    'paints no verdict on the withheld %s figure',
    async (title) => {
      // Keeping the target would color a card whose number is being withheld - a status about a
      // figure the console has just said it will not report.
      await openThin();
      expect(drillCard(title).querySelector('.metric-card-target')).toBeNull();
    },
  );

  it('does not tell the reader the table is hiding a cell it never had', async () => {
    // User signal and user ratings are two readings of the SAME votes. Counting both would report six
    // hidden rates on a table that draws five.
    render(
      <EffectivenessTab
        data={THIN_EVERYWHERE}
        dateRange={range}
        isLoading={false}
        filters={EMPTY_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    expect(screen.getByText(/5 rates are hidden because each is based on fewer than 10 data points/i)).toBeTruthy();
  });

  it('does not show the unqualified figure on the L1 card one click away', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: 'thin_intent' }));
    const card = screen.getByText('Routing confidence').closest('.metric-card')!;
    expect(card.textContent).toMatch(/too few to report/i);
    expect(card.textContent).not.toMatch(/\b20\b/);
    // The population is stated on the card itself, not left to a hover.
    expect(card.textContent).toMatch(/Based on \d+ data points?, fewer than 10/i);
  });

  it('marks rather than hides on the card when suppression is off', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'thin_intent' }));
    const card = screen.getByText('Routing confidence').closest('.metric-card')!;
    expect(card.textContent).toMatch(/Based on only \d+ data points?/i);
    expect(card.textContent).not.toMatch(/too few to report/i);
  });
});

describe('only the three rates that rank may claim to rank', () => {
  // 400 exchanges and 380 scored turns, so both ranking axes are well populated. The only thin
  // figures are user signal (2 rated) and tools (3 calls), neither of which qualityRank reads.
  const NON_RANKING = result([
    {
      intent: 'well_ranked', exchange_count: 400, direct_count: 400, task_count: 0,
      avg_confidence: 95, avg_relevance: 88, relevance_scored_count: 380,
      user_flag_rate: 50, user_flag_count: 1, user_rated_count: 2,
      tool_calls: 3, tool_error_rate: 33,
    },
  ]);

  const renderNonRanking = () =>
    render(
      <EffectivenessTab
        data={NON_RANKING}
        dateRange={range}
        isLoading={false}
        filters={EMPTY_FILTERS}
        onFiltersChange={() => {}}
      />,
    );

  it('does not claim the order is affected when no ranking rate is thin', () => {
    renderNonRanking();
    expect(screen.getByText(/None of them affects the ranking/i)).toBeTruthy();
  });

  it('still suppresses them, because an unsupportable figure is unsupportable anywhere', () => {
    renderNonRanking();
    const row = screen.getByRole('button', { name: 'well_ranked' }).closest('tr')!;
    expect(row.querySelector('[data-label="user_flag_rate"]')!.textContent).toMatch(/too few to report/i);
    expect(row.querySelector('[data-label="tool_error_rate"]')!.textContent).toMatch(/too few to report/i);
  });

  it('does not tell the reader a revealed user-signal rate is ranking anything', async () => {
    const user = userEvent.setup();
    renderNonRanking();
    await user.click(toggle());
    expect(screen.getByText(/None of them affects the ranking/i)).toBeTruthy();
  });
});

describe('switching suppression off reveals the numbers without restoring a confident surface', () => {
  it('shows the figure and marks it with its population', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(toggle());
    const relevance = cell('thin_intent', 'avg_relevance');
    expect(relevance.textContent).not.toMatch(/too few to report/i);
    expect(relevance.textContent).toMatch(/⚠ n=3/);
  });

  it('says that the revealed rates are now driving the order', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(toggle());
    // The claim is scoped to the rates that actually rank: two of the four here (confidence and
    // relevance), not all four. Saying "4 rates ... are ranking" would be false about user signal and
    // tools, which have never fed the order.
    expect(screen.getByText(/marked ⚠. Treat (it|them) with caution/i)).toBeTruthy();
    expect(screen.getByText(/2 of them affect the ranking/i)).toBeTruthy();
  });

  it('ranks on them again, which is exactly what the warning says it is doing', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(toggle());
    expect(precedes(rowFor('thin_intent'), rowFor('busy_intent'))).toBe(true);
  });

  it('never marks a well-populated rate', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(toggle());
    expect(cell('busy_intent', 'avg_relevance').textContent).not.toMatch(/⚠/);
  });
});

describe('zero is not the same statement as too few', () => {
  const NO_SIGNAL = {
    intent: 'no_signal', exchange_count: 40, direct_count: 40, task_count: 0,
    avg_confidence: 90, avg_relevance: 80, relevance_scored_count: 30,
    // Nobody rated and no tool ran: there is nothing to measure, not too little.
    user_rated_count: 0, user_flag_count: 0,
    tool_calls: 0, tool_error_rate: 0,
  };
  const ZERO = result([NO_SIGNAL]);

  /**
   * A RATE OF 0.0% WHEN NOTHING WAS MEASURED IS A VERDICT ON WORK THAT NEVER HAPPENED.
   *
   * The L0 cell has always guarded on `tool_calls` and printed a dash. The L1 card did not, and was
   * handed the target as well - so an intent that never invoked a tool showed a GREEN "0.0% · 0 calls"
   * one click from that dash. Asserted for both shapes the column can arrive in: the zero the query
   * used to coalesce to, and the null it returns once nothing ran.
   */
  it.each([
    ['a zero', 0],
    ['a null', null],
  ])('reports %s tool-error rate over no tool calls as no data, never as a good score', async (_shape, rate) => {
    const user = userEvent.setup();
    render(
      <EffectivenessTab
        data={result([{ ...NO_SIGNAL, tool_error_rate: rate }])}
        dateRange={range}
        isLoading={false}
        filters={EMPTY_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'no_signal' }));
    const card = screen.getByText('Tool error rate').closest('.metric-card')!;
    expect(card.textContent).toMatch(/—/);
    expect(card.textContent).not.toMatch(/0\.0%/);
    // No target, so no color: a card cannot pass a judgement on a measurement that does not exist.
    expect(card.querySelector('.metric-card-target')).toBeNull();
  });

  it('renders a dash with its own reason, not "too few to report"', () => {
    render(
      <EffectivenessTab
        data={ZERO}
        dateRange={range}
        isLoading={false}
        filters={EMPTY_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    const rated = screen.getByRole('button', { name: 'no_signal' }).closest('tr')!
      .querySelector('[data-label="user_flag_rate"]')!;
    expect(rated.textContent).toMatch(/—/);
    expect(rated.textContent).not.toMatch(/too few to report/i);
  });

  it('reports nothing suppressed when every population is either healthy or empty', () => {
    render(
      <EffectivenessTab
        data={ZERO}
        dateRange={range}
        isLoading={false}
        filters={EMPTY_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    expect(screen.getByText(/Every rate shown is based on at least 10 data points/i)).toBeTruthy();
  });
});

describe('each rate is judged on its OWN population, not on the volume column', () => {
  // The rule that would have been wrong: suppressing everything on `exchange_count`. This intent has
  // few exchanges but a relevance average over 200 scored turns, which is a reportable figure.
  const MIXED = result([
    {
      intent: 'odd_shape', exchange_count: 4, direct_count: 4, task_count: 0,
      avg_relevance: 75, relevance_scored_count: 200,
      avg_confidence: 60,
      tool_calls: 0, tool_error_rate: 0,
    },
  ]);

  it('reports a well-scored relevance even where the intent has few exchanges', () => {
    render(
      <EffectivenessTab
        data={MIXED}
        dateRange={range}
        isLoading={false}
        filters={EMPTY_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    const row = screen.getByRole('button', { name: 'odd_shape' }).closest('tr')!;
    expect(row.querySelector('[data-label="avg_relevance"]')!.textContent).toMatch(/75/);
    // ...while routing confidence, whose population IS the exchange count, is suppressed on the same row.
    expect(row.querySelector('[data-label="avg_confidence"]')!.textContent).toMatch(/too few to report/i);
  });
});
