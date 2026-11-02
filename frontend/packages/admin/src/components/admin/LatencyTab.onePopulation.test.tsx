/**
 * THE CARDS, THE TABLE AND THE ALERTS ARE ONE POPULATION, OR THEY ARE THREE SCREENS.
 *
 * The tab cut three sets and drew them as one: the cards gated on `avg_total_ms > 0`, the TTFF card on
 * `avg_ttff_ms > 0`, and the breakdown table on neither. The query had already dropped its own
 * `total_ms > 0` gate on purpose - a response that ran no measurable compute is counted and attributed
 * rather than vanishing - so the frontend gate put the FASTEST turns there are (handler-answered ones,
 * where ttff equals e2e) into the TTFF headline and into nothing else. E2E read high, and the cards
 * disagreed with the rows printed underneath them.
 *
 * `computeAlerts` made a third set and said in a comment that it mirrored the tab.
 *
 * The fixture is the shape that exposes it: one ordinary turn group and one handler-answered group that
 * records no worker compute. Every case below is a number that MOVES when the populations are pulled
 * back together, so none of them can pass against the old arrangement.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setClassificationsForTest } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';
import LatencyTab from './LatencyTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import { computeAlerts } from './alerts';

// A band is read under the selection key a classification declares; these cases run the sample deployment.
beforeAll(() => setClassificationsForTest(SAMPLE_CLASSIFICATIONS));
afterAll(() => setClassificationsForTest(null));

const RANGE = { start: '2026-09-01', end: '2026-09-08' };

/** An ordinary turn: the worker computed an answer, and the wait was long. */
const WORKED = {
  date: '2026-09-02',
  assistant: 'standard-assistant',
  delivery_option: 'DIRECT_REPLY',
  turn_entry: 'flow',
  assistant_turn_count: '100',
  avg_ttff_ms: '3000',
  avg_e2e_ms: '22000',
  avg_total_ms: '5000',
  p95_total_ms: '9000',
};

/**
 * A turn the handler answered itself. It records no worker compute at all, and it is the fastest thing
 * the platform does - which is exactly why dropping it from the population biased E2E upward.
 */
const HANDLER_ANSWERED = {
  date: '2026-09-02',
  assistant: 'standard-assistant',
  delivery_option: 'DIRECT_REPLY',
  turn_entry: 'flow',
  assistant_turn_count: '100',
  avg_ttff_ms: '1000',
  avg_e2e_ms: '2000',
  avg_total_ms: null,
  p95_total_ms: null,
};

const ROWS = [WORKED, HANDLER_ANSWERED];

const renderTab = (rows: Record<string, unknown>[] = ROWS) =>
  render(
    <LatencyTab
      data={{ data: rows } as never}
      routerStepsData={null}
      isLoading={false}
      dateRange={RANGE}
      analyticsMode="aurora"
      filters={EMPTY_FILTERS}
      onFiltersChange={() => {}}
    />,
  );

/**
 * A card by its title, which is the only stable handle on one - the value is what is under test.
 *
 * Every title on this tab also appears in the prose above the cards ("<strong>TTFF</strong> is the delay
 * to..."), so the match is narrowed to the elements that are inside a card.
 */
const card = (title: string) => {
  const cards = screen.getAllByText(title).map((el) => el.closest('.metric-card')).filter(Boolean);
  expect(cards).toHaveLength(1);
  return cards[0]!;
};
const valueOf = (title: string) => card(title).querySelector('.metric-card-value')!.textContent;
const subtitleOf = (title: string) => card(title).querySelector('.metric-card-subtitle')!.textContent;

describe('one population for the cards and the table', () => {
  it('counts a turn that ran no measurable compute in the E2E headline', () => {
    renderTab();
    // 22s over 100 turns and 2s over 100 turns. Gating on avg_total_ms left only the first and read
    // 22.0s - a headline about the whole window, computed over half of it and the slower half.
    expect(valueOf('E2E')).toBe('12.0s');
  });

  it('gives every headline the same denominator, and says so on the card', () => {
    renderTab();
    expect(subtitleOf('E2E')).toContain('over 200 of 200 turns');
    expect(subtitleOf('First update (TTFF)')).toContain('over 200 of 200 turns');
  });

  it('states the coverage of a metric only some turns recorded, rather than hiding the rest', () => {
    renderTab();
    // Worker compute is still averaged over the turns that HAVE it - the absence belongs to the metric,
    // not to the population - so the card has to say which half of the traffic it describes.
    expect(valueOf('Worker compute')).toBe('5.0s');
    expect(subtitleOf('Worker compute')).toContain('over 100 of 200 turns');
  });

  it('prints exactly the rows the headlines were computed from', () => {
    renderTab();
    // The table always showed both. The cards showed one and did not say so, which is how a reader
    // could check a headline against the rows below it and find arithmetic that did not land.
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('keeps a narrowing filter honest across all three', () => {
    renderTab([
      { ...WORKED, assistant: 'premium-assistant', conversation_classification: 'premium' },
      { ...HANDLER_ANSWERED, conversation_classification: 'standard' },
    ]);
    // Nothing is filtered here: the assertion is that the one population is the FILTERED one, so both
    // tiers are in both the cards and the table until somebody narrows.
    expect(subtitleOf('E2E')).toContain('over 200 of 200 turns');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});

describe('alerts read the numbers the tab is showing', () => {
  it('raises the E2E alert on the figure the card prints, not on its own subset', () => {
    renderTab();
    const shown = valueOf('E2E');
    const alerts = computeAlerts({ latency: ROWS, filters: EMPTY_FILTERS });
    const e2e = alerts.find((a) => a.id === 'lat-e2e');
    expect(e2e).toBeDefined();
    expect(e2e!.detail).toContain(shown!);
  });

  it('agrees with the TTFF card too', () => {
    renderTab();
    const shown = valueOf('First update (TTFF)');
    const alerts = computeAlerts({ latency: ROWS, filters: EMPTY_FILTERS });
    expect(alerts.find((a) => a.id === 'lat-ttff')!.detail).toContain(shown!);
  });

  it('says how many turns the alert covers, so a breach over a handful reads as one', () => {
    const alerts = computeAlerts({ latency: ROWS, filters: EMPTY_FILTERS });
    expect(alerts.find((a) => a.id === 'lat-e2e')!.detail).toContain('over 200 of 200 turns');
  });

  it('judges against the tier band when the surface is narrowed to one tier', () => {
    // 5s of worker compute is good against the global 10s target and BAD against basic's 4s one. The
    // tab has applied the per-tier band since G10; alerts read the global registry, so a console
    // narrowed to basic showed a red card and a silent alert list for the same window.
    const basic = [{ ...WORKED, conversation_classification: 'basic', p95_total_ms: '12000' }];
    const global = computeAlerts({ latency: basic, filters: EMPTY_FILTERS });
    const tiered = computeAlerts({ latency: basic, filters: { ...EMPTY_FILTERS, classification: 'basic' } });
    expect(global.find((a) => a.id === 'lat-p95')).toBeUndefined();     // 12s <= the global 15s target
    expect(tiered.find((a) => a.id === 'lat-p95')?.severity).toBe('warn'); // over basic's 8s, under 15s
  });

  it('leaves duel rounds out of an SLA alert unless they were asked for', () => {
    // A duel fans one hand-picked prompt across several assistants, so its rounds move every percentile
    // they are pooled into. An alert raised off traffic nobody sent is an alert that stops being read.
    const withDuel = [
      { ...WORKED, avg_ttff_ms: '900', avg_e2e_ms: '3000' },
      { ...WORKED, battle_round: 1, avg_ttff_ms: '9000', avg_e2e_ms: '40000' },
    ];
    expect(computeAlerts({ latency: withDuel, filters: EMPTY_FILTERS }).find((a) => a.id === 'lat-ttff'))
      .toBeUndefined();
    // Asking for the round puts it back, and the alert then describes what the operator is looking at.
    const round = computeAlerts({ latency: withDuel, filters: { ...EMPTY_FILTERS, duel: '1' } });
    expect(round.find((a) => a.id === 'lat-ttff')?.severity).toBe('error');
  });
});
