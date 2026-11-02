/**
 * THE LATENCY PAGE ANSWERS ONE QUESTION, THEN LETS YOU OPEN EITHER HALF.
 *
 * A reader arrives asking whether this was slow, and the answer is E2E. TTFF and Worker compute are
 * the two halves it divides into, and each opens the detail behind ITSELF - so somebody who pressed a
 * card knows which number they are now inside, rather than scrolling a page of cards working out
 * which figure belongs to which.
 *
 *   E2E              the whole wait, and it does not open: its breakdown IS the other two cards
 *   TTFF             the message sent, to the placeholder appearing
 *   Worker compute   the placeholder, to the final reply replacing it
 *
 * The two halves are disjoint by construction - TTFF stops the instant the placeholder is visible,
 * which is where the worker has not yet begun - so a card in the wrong section is a claim that a span
 * happened at a time it did not. Each section is titled with the metric it takes apart.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import LatencyTab from './LatencyTab';
import { EMPTY_FILTERS } from './PerformanceFilters';

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
  avg_router_other_ms: '300',
  avg_classifier_ms: '700',
  classified_by_model_count: '80',
  router_measured_count: '100',
  ttff_measured_count: '100',
  avg_inbound_ms: '1900',
  avg_ttff_outside_router_ms: '1100',
  ttff_router_paired_count: '100',
  turn_entry: 'flow',
  ...over,
});

const renderTab = (rows: Record<string, unknown>[]) =>
  render(
    <LatencyTab
      data={{ data: rows } as never}
      routerStepsData={null}
      isLoading={false}
      dateRange={RANGE}
      analyticsMode="aurora" filters={EMPTY_FILTERS} onFiltersChange={() => {}}
    />
  );

/** The title of every metric card on the page, which is what "a card exists" actually means here. */
function cardTitles(): string[] {
  return Array.from(document.querySelectorAll('.metric-card-title')).map((el) => {
    // The title node also holds the tooltip trigger and the drill glyph; take the leading text only.
    const raw = el.childNodes[0]?.textContent ?? el.textContent ?? '';
    return raw.trim();
  });
}

const openTtff = () => userEvent.click(screen.getByRole('button', { name: /TTFF.*show breakdown/i }));
const openWorker = () => userEvent.click(screen.getByRole('button', { name: /Worker compute.*show breakdown/i }));

describe('the headline is the three numbers, and two of them open', () => {
  it('shows E2E, TTFF and Worker compute before any detail', () => {
    renderTab([row()]);
    // Matched on the card TITLE element, not on page text: every one of these three words also
    // appears inside another card's tooltip prose, so a bare text match finds the explanation as
    // readily as the card and would pass with the headline gone.
    expect(cardTitles()).toEqual(expect.arrayContaining(['E2E', 'First update (TTFF)', 'Worker compute']));
    expect(screen.getByRole('button', { name: /TTFF.*breakdown/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Worker compute.*breakdown/i })).toBeInTheDocument();
  });

  it('leaves E2E unpressable, because its breakdown is the other two cards', () => {
    // Opening it would show a reader what they are already looking at, and a card that lifts under
    // the pointer and does nothing is the affordance bug this page was reported for.
    renderTab([row()]);
    // Its CARD is not a button. Asked as "no button mentions E2E" this passed nothing: the Worker
    // compute tooltip says "see E2E for the full wait", so that text is inside a button either way.
    const e2e = Array.from(document.querySelectorAll('.metric-card'))
      .find((el) => el.querySelector('.metric-card-title')?.textContent?.trim().startsWith('E2E'));
    expect(e2e).toBeTruthy();
    expect(e2e!.tagName).toBe('DIV');
  });

  it('opens exactly two breakdowns, one per half', () => {
    renderTab([row()]);
    expect(screen.queryAllByRole('button', { name: /breakdown/i })).toHaveLength(2);
  });
});

describe('each section is titled with the metric it takes apart', () => {
  it('titles the TTFF section with TTFF', async () => {
    renderTab([row()]);
    await openTtff();
    const region = screen.getByRole('region', { name: /TTFF breakdown/i });
    expect(within(region).getByText(/^TTFF ·/)).toBeInTheDocument();
  });

  it('titles the worker section with Worker compute', async () => {
    renderTab([row()]);
    await openWorker();
    const region = screen.getByRole('region', { name: /Worker compute breakdown/i });
    expect(within(region).getByText(/^Worker compute ·/)).toBeInTheDocument();
  });

  it('opens each half independently, so the two can be read together', async () => {
    // Closing one to read the other would be the page deciding what an operator may compare.
    renderTab([row()]);
    await openTtff();
    await openWorker();
    expect(screen.getByRole('region', { name: /TTFF breakdown/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Worker compute breakdown/i })).toBeInTheDocument();
  });
});

describe('a leg sits in the section it belongs to', () => {
  it('puts the pre-placeholder legs inside TTFF', async () => {
    renderTab([row()]);
    await openTtff();
    const region = within(screen.getByRole('region', { name: /TTFF breakdown/i }));
    expect(region.getByText('Router')).toBeInTheDocument();
    expect(region.getByText('Classifier')).toBeInTheDocument();
    expect(region.getByText('Inbound')).toBeInTheDocument();
  });

  it('puts the post-placeholder legs inside Worker compute', async () => {
    renderTab([row()]);
    await openWorker();
    const region = within(screen.getByRole('region', { name: /Worker compute breakdown/i }));
    expect(region.getByText('Model time')).toBeInTheDocument();
    expect(region.getByText('Answer target check')).toBeInTheDocument();
  });

  it('shows the scan COST beside the scan RATE, not buried in its subtitle', async () => {
    // Two questions - how often the handoff misses, and what a miss costs. A number in a subtitle is
    // where one goes when nobody has decided whether it matters.
    renderTab([row()]);
    await openWorker();
    const region = within(screen.getByRole('region', { name: /Worker compute breakdown/i }));
    expect(region.getByText('Placeholder scan rate')).toBeInTheDocument();
    expect(region.getByText('Placeholder scan cost')).toBeInTheDocument();
  });

  it('names Worker compute once, in the headline, not again inside its own section', async () => {
    renderTab([row()]);
    await openWorker();
    // The card was duplicated when the section was built from the old flat grid. One metric, one card
    // - counted over card TITLES, because the words also appear in the section heading and in prose.
    expect(cardTitles().filter((t) => t === 'Worker compute')).toHaveLength(1);
  });
});

describe('TTFF is split by how the turn arrived', () => {
  it('labels the two entries as standard and targeted, not by their wire names', async () => {
    // 'flow' and 'lex' are implementation names. Under StandardMessages: NONE the split IS the
    // standard-versus-targeted one, and the page says so rather than making a reader carry it.
    renderTab([row({ turn_entry: 'flow' }), row({ turn_entry: 'lex', assistant_turn_count: '20', avg_ttff_ms: '3000' })]);
    await openTtff();
    const note = screen.getByText(/By how the turn arrived/).parentElement?.textContent ?? '';
    expect(note).toMatch(/Channel flow/);
    expect(note).toMatch(/Amazon Lex/);
  });

  it('counts the turns that carry no entry rather than dropping them', async () => {
    // A split that quietly omits the unlabelled reports a clean partition of a population it does not
    // cover. These are the turns that never paired to an exchange.
    renderTab([
      row({ turn_entry: 'flow' }),
      row({ turn_entry: 'lex', assistant_turn_count: '20' }),
      row({ turn_entry: null, assistant_turn_count: '37' }),
    ]);
    await openTtff();
    const note = screen.getByText(/By how the turn arrived/).parentElement?.textContent ?? '';
    expect(note).toMatch(/37 turns have no recorded path/);
  });
});

describe('what is not about a latency step is not on this page', () => {
  it('does not render the answer-type breakdown', () => {
    // It has its own Performance tab: "what KIND of message is this" is a different question from
    // "how long did this step take".
    renderTab([row()]);
    expect(screen.queryByText(/Turn kinds/i)).not.toBeInTheDocument();
  });

  it('does not render queue metrics, which live in exactly one tab', () => {
    // Queue Health is its own tab. Showing it here too would put the same numbers on two surfaces,
    // which is how two readings of one thing drift apart.
    renderTab([row()]);
    expect(screen.queryByText(/Queue health/i)).not.toBeInTheDocument();
  });
});

/**
 * A HEADLINE REACHES THE TURNS UNDER IT.
 *
 * The breakdown showed the groups a headline aggregates from and stopped there, so an operator who
 * distrusted a number had nowhere to go. A figure nobody can check is a figure nobody should act on.
 *
 * The drill is keyed on the WHOLE group - day, assistant, delivery, entry, role, version, tier -
 * because a breakdown row is that whole tuple. Anything less would return a different population than
 * the row that was clicked, and numbers that nearly reconcile are worse than no drill at all: the
 * reader sees a discrepancy and has no way to learn it came from the query, not the data.
 */
describe('the breakdown reaches the turns behind a row', () => {
  it('makes its rows clickable, which the affordance is gated on', () => {
    // DataTable adds the cursor, hover and chevron only when onRowClick is set - the rule that stopped
    // rows advertising an interaction they did not have. So this asserts the affordance too.
    renderTab([row()]);
    const clickable = document.querySelectorAll('.data-table-row--clickable');
    expect(clickable.length).toBeGreaterThan(0);
  });

  it('does not open the drill until a row is clicked', () => {
    renderTab([row()]);
    expect(screen.queryByRole('region', { name: /Turns in this group/i })).not.toBeInTheDocument();
  });
});
