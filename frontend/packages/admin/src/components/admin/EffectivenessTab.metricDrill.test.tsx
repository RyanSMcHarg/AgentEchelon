/**
 * EVERY HEADLINE REACHES THE EVIDENCE UNDER IT.
 *
 * The drill used to hang off the ROW, so pressing Relevance and pressing Tool error rate landed in
 * the same place. A number a reader distrusts has to lead to the rows it was computed from, not to a
 * general view of the intent - otherwise the answer to "is this right?" is "go and look somewhere
 * near it", which is how a figure nobody can check ends up being acted on anyway.
 *
 * Each metric now names its own evidence, and every target REUSES a surface that already exists
 * rather than growing a second view of the same rows:
 *
 *   Relevance        the scored exchanges, each with its score          (L2 direct drill)
 *   Task execution   the tasks, so a failure can be read                (L2 task drill)
 *   Tool error rate  the tool lens, opened on the worst-failing tool    (existing failure list)
 *   User signal      the flagged surface                                (existing signal list)
 *   Avg latency      the Latency surface, same population               (shared filter set)
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';

const RANGE = { start: '2026-09-01', end: '2026-09-08' };

const l0 = (over: Record<string, unknown> = {}) => ({
  intent: 'general',
  exchange_count: 100,
  direct_count: 80,
  task_count: 20,
  avg_confidence: 82,
  avg_relevance: 71,
  relevance_scored_count: 64,
  task_completion_rate: 60,
  task_flow_count: 20,
  task_completed: 12,
  task_failed: 5,
  avg_total_ms: 5000,
  p95_total_ms: 9000,
  tool_calls: 40,
  tool_errors: 6,
  tool_error_rate: 15,
  // TWELVE VOTES, NOT NINE. Every rate card carries the low-N suppression now, so a nine-vote fixture
  // made the ratings card read "too few to report" and these cases stopped testing what they are about:
  // which evidence each card reaches. The suppression rule itself is asserted in the lowN suite.
  user_rated_count: 12,
  user_flag_count: 4,
  user_flag_rate: 33,
  user_up_count: 8,
  user_down_count: 4,
  user_positive_rate: 66.7,
  raised_flag_count: 2,
  ...over,
});

function renderTab(extra: Record<string, unknown> = {}) {
  return render(
    <EffectivenessTab
      data={{ data: [l0()] } as never}
      dateRange={RANGE}
      isLoading={false}
      drill={{ level: 1, intent: 'general' }}
      onDrillChange={vi.fn()}
      filters={EMPTY_FILTERS}
      onFiltersChange={vi.fn()}
      {...(extra as Record<string, never>)}
    />
  );
}

const pressable = (name: RegExp) => screen.queryByRole('button', { name });

describe('each metric card reaches its own evidence', () => {
  it('makes Relevance pressable when there are direct exchanges to show', () => {
    renderTab();
    expect(pressable(/Relevance.*breakdown/i)).toBeInTheDocument();
  });

  it('makes Task execution pressable when the intent opens tasks', () => {
    renderTab();
    expect(pressable(/Task execution.*breakdown/i)).toBeInTheDocument();
  });

  it('leaves Tool error rate alone until the per-tool evidence has loaded', () => {
    // The lens is fetched at L1 from the step rows, so until it arrives there is no failing tool to
    // open on and the card must not offer a press that would land on nothing. Asserted as the rule
    // rather than worked around with a mocked fetch: "pressable only when the evidence exists" is the
    // behaviour, and a test that stubbed the fetch would stop checking it.
    renderTab();
    expect(pressable(/Tool error rate.*breakdown/i)).not.toBeInTheDocument();
  });

  it('hands the population to Latency when asked', async () => {
    const onOpenLatency = vi.fn();
    renderTab({ onOpenLatency });
    const card = pressable(/Avg latency.*breakdown/i);
    expect(card).toBeInTheDocument();
    await userEvent.click(card!);
    expect(onOpenLatency).toHaveBeenCalledWith('general');
  });

  it('opens the flagged surface from FLAGS RAISED, which is a different signal', async () => {
    // A rating and a flag are not the same thing. The old single card reported a thumbs DOWN under the
    // word "flagged", so an intent reading zero could still have flags on it and following the number
    // to that tab found rows it never counted.
    const onOpenFlagged = vi.fn();
    renderTab({ onOpenFlagged });
    const card = pressable(/Flags raised.*breakdown/i);
    expect(card).toBeInTheDocument();
    await userEvent.click(card!);
    expect(onOpenFlagged).toHaveBeenCalled();
  });

  it('shows ratings as a positive share, not as a count of the unhappy', async () => {
    // "0 flagged of 3 rated" said almost nothing; "100% positive of 3" says what happened. The card
    // reaches the ratings themselves rather than the flag surface.
    const onOpenRatings = vi.fn();
    renderTab({ onOpenRatings });
    expect(screen.getByText(/% positive/)).toBeInTheDocument();
    const card = pressable(/User ratings.*breakdown/i);
    expect(card).toBeInTheDocument();
  });
});

describe('a card with no evidence behind it is not pressable', () => {
  it('leaves Task execution alone when the intent opens no tasks', () => {
    render(
      <EffectivenessTab
        data={{ data: [l0({ task_count: 0, task_flow_count: 0 })] } as never}
        dateRange={RANGE} isLoading={false}
        drill={{ level: 1, intent: 'general' }} onDrillChange={vi.fn()}
        filters={EMPTY_FILTERS} onFiltersChange={vi.fn()}
      />
    );
    expect(pressable(/Task execution.*breakdown/i)).not.toBeInTheDocument();
  });

  it('leaves User signal alone when nobody flagged anything', () => {
    render(
      <EffectivenessTab
        data={{ data: [l0({ user_flag_count: 0 })] } as never}
        dateRange={RANGE} isLoading={false}
        drill={{ level: 1, intent: 'general' }} onDrillChange={vi.fn()}
        filters={EMPTY_FILTERS} onFiltersChange={vi.fn()} onOpenFlagged={vi.fn()}
      />
    );
    // A card that lifts under the pointer and does nothing is the affordance bug this console was
    // reported for; an empty evidence set is exactly when that would happen.
    expect(pressable(/User signal.*breakdown/i)).not.toBeInTheDocument();
  });

  it('leaves Routing confidence alone, which has no evidence view of its own', () => {
    // The classifier grading itself. There is no list of rows that would show a reader why the
    // confidence was what it was, so the card must not imply there is one.
    renderTab();
    expect(pressable(/Routing confidence.*breakdown/i)).not.toBeInTheDocument();
  });
});
