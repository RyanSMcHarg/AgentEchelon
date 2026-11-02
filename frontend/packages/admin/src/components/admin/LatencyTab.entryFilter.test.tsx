/**
 * TARGETED AND STANDARD TURNS ARE DIFFERENT POPULATIONS, AND THE TAB CAN NOW SAY SO.
 *
 * Under `StandardMessages: NONE` an untargeted message reaches no Amazon Lex, so `turn_entry` is the
 * same question as "was this message targeted" (migration 054 states the equivalence). The two paths
 * do different work - the Lex path is not handed the id of the message it will answer and falls back
 * to polling for it - so an average over both describes neither.
 *
 * The query has grouped by `turn_entry` since 054 and the step grid already split on it. What was
 * missing was a control, so the page could show the split per step and could not answer "what do
 * targeted turns cost".
 *
 * ── WHY `not recorded` IS AN OPTION RATHER THAN A FILTERED-OUT ROW ───────────────────────────────
 *
 * Measured live over 30 days: 493 turns carry no entry, against 191 `flow` and 3 `lex`; 77 of one
 * day's 196 are unrecorded. A control offering only the two real entries would therefore describe a
 * fraction of the traffic with nothing saying the rest was dropped. It is a defect rather than a
 * third kind of turn, and it is selectable so it can be chased.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import LatencyTab from './LatencyTab';
import { EMPTY_FILTERS, type PerformanceFilters } from './PerformanceFilters';

const RANGE = { start: '2026-09-01', end: '2026-09-08' };

/** One latency row. The fields the tab scopes and averages on, and nothing else. */
const row = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-07',
  assistant: 'premium-assistant',
  assistant_role: 'primary',
  profile_version: 3,
  battle_round: null,
  conversation_classification: 'premium',
  delivery_option: 'DIRECT',
  turn_entry: 'flow',
  assistant_turn_count: '10',
  avg_total_ms: '1000',
  ...over,
});

/**
 * THE FILTERS ARE CONTROLLED NOW, so the harness holds them.
 *
 * Latency and Effectiveness share one filter set, lifted to the dashboard, which is what stops a
 * person narrowing one surface and being shown a different population on the other. A stub
 *  would make every case below pass by never narrowing anything - the test would
 * assert a click and observe nothing - so this wrapper is the state the dashboard supplies.
 */
const Harness: React.FC<{ rows: Record<string, unknown>[] }> = ({ rows }) => {
  const [filters, setFilters] = React.useState<PerformanceFilters>(EMPTY_FILTERS);
  return (
    <LatencyTab
      data={{ data: rows } as never}
      routerStepsData={null}
      isLoading={false}
      dateRange={RANGE}
      analyticsMode="aurora"
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
};

const renderTab = (rows: Record<string, unknown>[]) => render(<Harness rows={rows} />);

const MIXED = [
  row({ turn_entry: 'flow', assistant_turn_count: '10', avg_total_ms: '1000' }),
  row({ turn_entry: 'lex', assistant_turn_count: '10', avg_total_ms: '5000' }),
  row({ turn_entry: 'unknown', assistant_turn_count: '10', avg_total_ms: '3000' }),
];

describe('filtering latency by how the turn arrived', () => {
  it('offers the control only when the window holds more than one entry', () => {
    renderTab([row({ turn_entry: 'flow' }), row({ turn_entry: 'flow' })]);
    expect(screen.queryByText('Amazon Lex')).not.toBeInTheDocument();
  });

  it('names the entries as the operator thinks of them, not as the column spells them', () => {
    renderTab(MIXED);
    // `lex` and `flow` are wire values. The question an operator has is about targeting.
    expect(screen.getByText('Amazon Lex')).toBeInTheDocument();
    expect(screen.getByText('Channel flow')).toBeInTheDocument();
    expect(screen.queryByText('lex')).not.toBeInTheDocument();
  });

  // THE POINT OF THE CONTROL. Not that a chip renders - that choosing one MOVES the figure, because
  // the two populations have different costs and the unfiltered average sits between them describing
  // neither. A test that only asserted the chip exists would pass against a filter wired to nothing.
  it('narrows the headline to the chosen population', () => {
    renderTab(MIXED);
    // All three: 10 turns at 1000ms, 10 at 5000ms, 10 at 3000ms -> 3000ms weighted. Asserted with
    // queryAll because a figure legitimately appears in more than one place on this tab; what matters
    // is that the chosen population's number is present and the others are gone.
    expect(screen.queryAllByText('3.0s').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Amazon Lex'));
    expect(screen.queryAllByText('5.0s').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('3.0s')).toHaveLength(0);

    fireEvent.click(screen.getByText('Channel flow'));
    expect(screen.queryAllByText('1.0s').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('5.0s')).toHaveLength(0);
  });

  // The three options have to cover the population, or the two real ones silently describe less
  // traffic than they appear to.
  it('offers the unrecorded turns rather than dropping them from the control', () => {
    renderTab(MIXED);
    expect(screen.getByText('not recorded')).toBeInTheDocument();

    fireEvent.click(screen.getByText('not recorded'));
    expect(screen.queryAllByText('3.0s').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('1.0s')).toHaveLength(0);
  });
});
