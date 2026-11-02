/**
 * THE ROUTER LEG'S BREAKDOWN, READ AS AN OPERATOR READS IT.
 *
 * The Router card is one number for everything the handler does before the placeholder exists, and
 * Classifier is the only part of it broken out - so the rest was a single residual and a regression
 * inside it had no address. These assertions are about READING the breakdown, not about a table
 * rendering: the step names have to arrive as words, the count has to sit beside the average because
 * the steps have different denominators, and an empty result has to say it means "not recorded"
 * rather than "instant".
 *
 * REACHED BY PRESSING THE TTFF CARD. It used to be a collapsed native disclosure sitting below the
 * trend chart with nothing pointing at it from the number it explained, which is why it was reported
 * as a drill-down that was not there. It now opens from the card it takes apart, so every assertion
 * below goes through that press - if the card stops opening it, these fail rather than passing
 * against a panel nobody can reach.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import LatencyTab from './LatencyTab';
import { EMPTY_FILTERS } from './PerformanceFilters';

const RANGE = { start: '2026-09-01', end: '2026-09-08' };

const step = (over: Record<string, unknown> = {}) => ({
  step_name: 'turn_claimed',
  turns: '501',
  avg_ms: '865',
  p95_ms: '1900',
  max_ms: '4200',
  ...over,
});

/**
 * One day of latency carrying a TTFF, which the drill needs: the panel decomposes TTFF, so a window
 * with no measured TTFF has nothing to decompose and the card is correctly not pressable.
 */
const LATENCY_ROW = {
  date: '2026-09-02',
  assistant: 'standard',
  delivery_option: 'DIRECT_REPLY',
  assistant_turn_count: '400',
  avg_ttff_ms: '2000',
  avg_total_ms: '5000',
  avg_router_ms: '900',
  avg_router_other_ms: '300',
  avg_classifier_ms: '700',
  classified_by_model_count: '250',
  router_measured_count: '380',
  avg_inbound_ms: '1900',
  // The per-row measurement of the time outside the router, and the turns it was taken over.
  avg_ttff_outside_router_ms: '1100',
  ttff_router_paired_count: '390',
};

const renderTab = (
  routerSteps: Record<string, unknown>[] | null,
  rows: Record<string, unknown>[] = [LATENCY_ROW],
) =>
  render(
    <LatencyTab
      data={{ data: rows } as never}
      routerStepsData={routerSteps ? ({ data: routerSteps } as never) : null}
      isLoading={false}
      dateRange={RANGE}
      analyticsMode="aurora" filters={EMPTY_FILTERS} onFiltersChange={() => {}}
    />
  );

/** Press the TTFF card, which is how an operator reaches the breakdown. */
function openTtffDrill() {
  fireEvent.click(screen.getByRole('button', { name: /TTFF.*show breakdown/i }));
}

describe('the router leg divides on the tab', () => {
  it('names each step in words rather than showing the wire name', () => {
    renderTab([step(), step({ step_name: 'task_prepared', avg_ms: '410' })]);
    openTtffDrill();
    expect(screen.getByText('Turn claim')).toBeInTheDocument();
    expect(screen.getByText('Task start or continue')).toBeInTheDocument();
    expect(screen.queryByText('turn_claimed')).not.toBeInTheDocument();
  });

  it('shows the count beside the cost, because the steps have different denominators', () => {
    // A step that ran on a tenth of the turns renders exactly like one that ran on all of them
    // without this, and the cheap-looking one may be the expensive one.
    renderTab([step()]);
    openTtffDrill();
    expect(screen.getByText('865ms')).toBeInTheDocument();
    expect(screen.getByText('501')).toBeInTheDocument();
  });

  it('shows the tail beside the average, since the regression this exists for is in one of them', () => {
    renderTab([step()]);
    openTtffDrill();
    // Scoped to the step TABLE, not the whole drill: the Inbound card now lives inside the TTFF
    // breakdown too and carries the same 1.9s, so a drill-wide match finds two.
    const drill = screen.getByRole('region', { name: /TTFF breakdown/i });
    const table = within(drill.querySelector('table') as HTMLElement);
    expect(table.getByText('1.9s')).toBeInTheDocument();
    expect(table.getByText('4.2s')).toBeInTheDocument();
  });

  it('renders a step the copy has no label for, under its raw name', () => {
    // A boundary added to the router and not to the label map is a gap in the COPY. Hiding the row
    // would silently turn it into a gap in the measurement.
    renderTab([step({ step_name: 'a_new_boundary' })]);
    openTtffDrill();
    expect(screen.getByText('a_new_boundary')).toBeInTheDocument();
  });

  it('says an empty window means NOT RECORDED, never that the steps were instant', () => {
    renderTab([]);
    openTtffDrill();
    expect(screen.getByText(/No router steps were recorded/i)).toBeInTheDocument();
  });

  it('survives the query being absent entirely', () => {
    // Athena mode, or a deployment older than the migration: the rest of the tab must still render,
    // and the TTFF shares above the table do not come from this query, so they still render too.
    renderTab(null);
    openTtffDrill();
    expect(screen.getByText(/TTFF · .* average/i)).toBeInTheDocument();
    expect(screen.getByText(/No router steps were recorded/i)).toBeInTheDocument();
  });
});

describe('the breakdown is reachable, and only from the number it explains', () => {
  it('is closed until the TTFF card is pressed', () => {
    renderTab([step()]);
    expect(screen.queryByRole('region', { name: /TTFF breakdown/i })).not.toBeInTheDocument();
    openTtffDrill();
    expect(screen.getByRole('region', { name: /TTFF breakdown/i })).toBeInTheDocument();
  });

  it('closes again on a second press, and says which state it is in', () => {
    renderTab([step()]);
    const card = screen.getByRole('button', { name: /TTFF.*show breakdown/i });
    expect(card).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(card);
    expect(screen.getByRole('button', { name: /TTFF.*hide breakdown/i })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /TTFF.*hide breakdown/i }));
    expect(screen.queryByRole('region', { name: /TTFF breakdown/i })).not.toBeInTheDocument();
  });

  it('offers no press when there is no measured TTFF to take apart', () => {
    // An empty window must not invite a click that would open an empty panel.
    renderTab([step()], []);
    expect(screen.queryByRole('button', { name: /TTFF.*breakdown/i })).not.toBeInTheDocument();
  });

  it('makes only the cards WITH a breakdown pressable', () => {
    // The reported bug was fourteen cards wearing a hover lift and an accent stripe with no handler
    // behind any of them. Two cards now drill - TTFF and Worker compute, the two halves of the wait -
    // so exactly two are buttons, and E2E is deliberately not one: its breakdown IS those two.
    renderTab([step()]);
    const drillButtons = screen.queryAllByRole('button', { name: /breakdown/i });
    expect(drillButtons).toHaveLength(2);
  });
});

describe('the TTFF shares are honest about what was measured', () => {
  it('splits the router leg into classification and the rest', () => {
    renderTab([step()]);
    openTtffDrill();
    // router 900 less router_other 300 = 600ms of classification, over the SAME population - not the
    // 700ms Classifier card, which is the cost when a model is asked and covers fewer turns.
    expect(screen.getByText(/600ms · 30%/)).toBeInTheDocument();
    expect(screen.getByText(/300ms · 15%/)).toBeInTheDocument();
  });

  it('shows the time outside the router as a MEASUREMENT, taken per turn', () => {
    // 1100ms, from the query's per-row avg_ttff_outside_router_ms - NOT from subtracting the TTFF
    // average and the router average, which are taken over different populations.
    renderTab([step()]);
    openTtffDrill();
    expect(screen.getByText(/1\.1s · 55%/)).toBeInTheDocument();
    const drillText = screen.getByRole('region', { name: /TTFF breakdown/i }).textContent ?? '';
    expect(drillText).toMatch(/measured per turn/i);
    expect(drillText).toMatch(/over 390 turns/);
    // It must NOT present this row as an estimate. That framing was the trust problem: the majority of
    // the headline read as unexplained when it is simply two hops with one instant missing between.
    // Matched on the old copy exactly, rather than on the word "unknowable" - the current text uses
    // that word to DENY it, so a bare word match tests nothing and fails on the correct wording.
    expect(drillText).not.toMatch(/a bound, not a measurement/i);
    expect(drillText).not.toMatch(/produces an estimate rather than a figure/i);
  });

  it('splits the remainder where the channel flow recorded its receipt, over the turns that have it', () => {
    // Migration 090: the flow's receipt instant divides the remainder into reaching the flow, the flow
    // handing to the router, and the placeholder returning. Stated over its own count, because it is a
    // subset of the turns the row is drawn over.
    renderTab([step()], [{ ...LATENCY_ROW, avg_to_flow_ms: '300', avg_flow_to_router_ms: '120', avg_placeholder_return_ms: '450', flow_split_count: '250' }]);
    openTtffDrill();
    const drillText = screen.getByRole('region', { name: /TTFF breakdown/i }).textContent ?? '';
    expect(drillText).toContain('On the 250 standard turns where the channel flow recorded when it received the message: reaching the flow 300ms (approximate, two clocks), the flow handing to the router 120ms, and the placeholder returning 450ms');
  });

  it('says nothing about a split where no turn carries one', () => {
    renderTab([step()]);
    openTtffDrill();
    const drillText = screen.getByRole('region', { name: /TTFF breakdown/i }).textContent ?? '';
    expect(drillText).not.toMatch(/channel flow recorded/);
  });

  it('falls back to the cruder figure, and labels it, when the query lacks the column', () => {
    // A deployment that has not shipped the query yet must not be shown a per-row measurement it does
    // not have - and must be told which of the two figures it is looking at.
    const { avg_ttff_outside_router_ms, ttff_router_paired_count, ...older } = LATENCY_ROW;
    void avg_ttff_outside_router_ms; void ttff_router_paired_count;
    renderTab([step()], [older]);
    openTtffDrill();
    const drillText = screen.getByRole('region', { name: /TTFF breakdown/i }).textContent ?? '';
    expect(drillText).toMatch(/hatched row is an estimate/i);
    expect(drillText).toMatch(/difference between two averages/i);
  });

  it('states which turns the headline is over, since that governs how it reads', () => {
    // WHAT THIS USED TO ASSERT, and why it changed. It required the panel to explain its own
    // METHODOLOGY - that both instants come off one clock, so the figure carries no skew. That is
    // documentation, it is `LATENCY-TARGETS.md`'s job, and keeping a copy of it here is how a
    // dashboard grows a second, divergeable manual. The paragraph was removed and the guide is linked.
    //
    // WHAT STILL HAS TO BE TRUE is the half a guide cannot state about THIS view: the average excludes
    // turns whose user instant was inferred. A reader who does not know that reads the number as
    // covering every turn, so it stays on the page and stays asserted here.
    renderTab([step()]);
    openTtffDrill();
    const drillText = screen.getByRole('region', { name: /TTFF breakdown/i }).textContent ?? '';
    expect(drillText).toMatch(/send time had to be estimated are left out/i);
  });

  it('reports each row denominator, because they are not the same population', () => {
    // Asserting these are PRINTED is the point: a percentage over two populations is only readable
    // when a reader can see that they differ.
    renderTab([step()]);
    openTtffDrill();
    const drillText = screen.getByRole('region', { name: /TTFF breakdown/i }).textContent ?? '';
    expect(drillText).toMatch(/averaged over 400 turns/);
    expect(drillText).toMatch(/Router over 380/);
  });
});

/**
 * EVERY BOUNDARY EXPLAINS ITSELF, INCLUDING WHEN IT APPLIES.
 *
 * The table named the steps and nothing else, so a reader could see that "Turn claim" cost 865ms and
 * had no way to learn what a turn claim is - or that it only happens where the queue is enabled.
 *
 * The second half carries as much weight as the first. Every step has its own denominator, so one
 * that looks cheap may simply be rare and one that looks expensive may run on every turn. A tooltip
 * that explained only the mechanism would leave the reader with the same wrong conclusion.
 */
describe('the router steps explain themselves', () => {
  const helpFor = (label: string): string => {
    const cell = screen.getByText(label).closest('span');
    const trigger = cell?.querySelector('button');
    return trigger?.getAttribute('aria-label') ?? '';
  };

  it('offers help on each step rather than only a name', () => {
    renderTab([step(), step({ step_name: 'classified' })]);
    openTtffDrill();
    expect(helpFor('Turn claim')).toMatch(/About Turn claim/);
    expect(helpFor('Intent classification')).toMatch(/About Intent classification/);
  });

  it('keys the help on the RAW boundary, not the humanised label', () => {
    // r.step is already humanised, so a lookup on it would silently miss every entry and every step
    // would render the unknown-boundary fallback - copy nobody wrote rather than an obvious bug. The
    // tooltip renders its content only while OPEN, so this opens it: asserting on the closed table's
    // text passed whatever was written, which is how the first version of this test proved nothing.
    renderTab([step({ step_name: 'classified' })]);
    openTtffDrill();
    fireEvent.click(screen.getByRole('button', { name: /About Intent classification/i }));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent(/Deciding the intent/i);
    expect(tip).not.toHaveTextContent(/has no description for yet/);
  });

  it('says WHEN a step applies, not only what it does', () => {
    // Every step has its own denominator, so one that looks cheap may simply be rare. A tooltip
    // explaining only the mechanism would leave a reader with the same wrong conclusion.
    renderTab([step({ step_name: 'classified' })]);
    openTtffDrill();
    fireEvent.click(screen.getByRole('button', { name: /About Intent classification/i }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Missing on turns settled without asking a model/i);
  });

  it('still says something for a boundary the copy has no entry for', () => {
    // A step added to the router and not here is a gap in the copy. The row keeps its real timing and
    // says so, rather than an empty tooltip implying there is nothing to know.
    renderTab([step({ step_name: 'a_new_boundary' })]);
    openTtffDrill();
    fireEvent.click(screen.getByRole('button', { name: /About a_new_boundary/i }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Its timing is still accurate/i);
  });
});

describe('the first update is split by path, and nothing else is', () => {
  const standard = { ...LATENCY_ROW, turn_entry: 'flow', assistant_turn_count: '300', avg_ttff_ms: '1200' };
  const targeted = { ...LATENCY_ROW, turn_entry: 'lex', assistant_turn_count: '40', avg_ttff_ms: '3400' };

  it('leads the TTFF card with the standard path and names the targeted path beside it', () => {
    renderTab([], [standard, targeted]);
    const card = screen.getByRole('button', { name: /TTFF.*show breakdown/i });
    expect(card).toHaveTextContent('1.2s');
    expect(card).toHaveTextContent('Amazon Lex: 3.4s over 40 turns');
  });

  it('gives each path its own router-step table instead of interleaving the rows', () => {
    renderTab([
      step({ step_name: 'classified', turn_entry: 'flow', turns: '300' }),
      step({ step_name: 'classified', turn_entry: 'lex', turns: '40', avg_ms: '2100' }),
    ], [standard, targeted]);
    openTtffDrill();
    expect(screen.getByRole('heading', { name: 'Channel flow' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Amazon Lex' })).toBeInTheDocument();
    const cells = within(screen.getByRole('region', { name: /TTFF breakdown/i })).queryAllByRole('cell');
    expect(cells.some((c) => /\((lex|flow)\)/.test(c.textContent ?? ''))).toBe(false);
  });
});
