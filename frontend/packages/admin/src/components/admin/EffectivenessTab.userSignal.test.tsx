import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';

/**
 * USER SIGNAL: THE ONLY NUMBER ON THIS DASHBOARD A PERSON PRODUCED.
 *
 * Everything else here is the model judging itself or the runtime measuring itself. That makes the
 * two ways of misreading it worth pinning in tests rather than only in a tooltip:
 *
 *   1. SILENCE IS NOT APPROVAL. Voting is voluntary and most replies get none, so the rate is over
 *      RATED replies, and an intent nobody voted on must render a dash. A 0% there would claim we
 *      asked and nobody objected, when nobody was asked.
 *   2. A RATE WITHOUT ITS POPULATION IS UNREADABLE. 20% of five votes is one person. The counts
 *      travel with the rate for that reason.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

const range = { start: '2026-05-13', end: '2026-05-20' };

const ROWS = result([
  {
    // Rated, and mostly badly. The reasons are what make it actionable.
    intent: 'expense_report', exchange_count: 500, direct_count: 500, task_count: 0,
    avg_confidence: 95, avg_relevance: 88, relevance_scored_count: 400,
    user_rated_count: 20, user_flag_count: 5, user_flag_rate: 25, user_rated_share: 4,
    user_flag_wrong_assistant: 3, user_flag_poor_answer: 1, user_flag_asked_again: 0,
    user_flag_unspecified: 1,
    avg_total_ms: 500, p95_total_ms: 900,
  },
  {
    // Nobody voted at all. This is the row the dash exists for.
    intent: 'quiet_intent', exchange_count: 300, direct_count: 300, task_count: 0,
    avg_confidence: 90, avg_relevance: 85, relevance_scored_count: 250,
    user_rated_count: null, user_flag_count: null, user_flag_rate: null, user_rated_share: null,
    avg_total_ms: 600, p95_total_ms: 1000,
  },
  {
    // Rated, and nobody objected. A REAL zero, and it must not look like the row above.
    intent: 'happy_intent', exchange_count: 200, direct_count: 200, task_count: 0,
    avg_confidence: 93, avg_relevance: 92, relevance_scored_count: 180,
    user_rated_count: 12, user_flag_count: 0, user_flag_rate: 0, user_rated_share: 6,
    user_flag_wrong_assistant: 0, user_flag_poor_answer: 0, user_flag_asked_again: 0,
    user_flag_unspecified: 0,
    avg_total_ms: 400, p95_total_ms: 700,
  },
]);

function cellFor(intent: string): HTMLElement {
  const row = screen.getByRole('button', { name: intent }).closest('tr');
  if (!row) throw new Error('no row for ' + intent);
  const cell = row.querySelector('[data-label="user_flag_rate"]');
  if (!cell) throw new Error('no user-signal cell for ' + intent);
  return cell as HTMLElement;
}

describe('EffectivenessTab — user signal', () => {
  beforeEach(() => {
    render(
      <EffectivenessTab data={ROWS} dateRange={range} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}} />,
    );
  });

  it('shows the column', () => {
    const header = document.querySelector('thead');
    expect(within(header as HTMLElement).getByText('User signal')).toBeTruthy();
  });

  it('shows the rate WITH the counts it is over', () => {
    // 25% alone is unreadable: over 20 votes it is five people, and a reader deciding whether to act
    // needs the second number to know that.
    const text = cellFor('expense_report').textContent || '';
    expect(text).toContain('25');
    expect(text).toContain('5 of 20 rated');
  });

  it('renders a DASH, not 0%, when nobody rated the intent', () => {
    // The distinction this whole column turns on: nobody was asked, so nothing was measured.
    expect((cellFor('quiet_intent').textContent || '').trim()).toBe('—');
  });

  it('renders a REAL zero differently from nobody having voted', () => {
    // Twelve people rated it and none objected. That is a measurement, and it must not be collapsed
    // into the same rendering as the row above - which is exactly what a naive falsy check would do.
    const text = cellFor('happy_intent').textContent || '';
    expect(text).toContain('0 of 12 rated');
    expect(text.trim()).not.toBe('—');
  });

  it('does not list a reason nobody gave', () => {
    // asked_again is 0 here. Rendering "0 had to re-ask" would invite a reader to think that category
    // was measured and came back empty, when it simply did not occur.
    const tip = cellFor('expense_report').querySelector('[aria-label="Why people flagged it"]');
    expect(tip).toBeTruthy();
    const content = (tip as HTMLElement).getAttribute('title') || (tip as HTMLElement).textContent || '';
    expect(content).not.toContain('had to re-ask');
  });
});
