/**
 * A SIGNAL THAT IS STORED AND NOT SHOWN IS NOT DELIVERED.
 *
 * Four evaluation signals were scored on every exchange, written to `evaluation_results`, and
 * covered by a passing backend test, while reaching no surface a person reads: `is_grounded`,
 * `rubric_version`, `sample_stratum` and `retrieved_passage_count`. The spec marked them BUILT,
 * which was true of the pipeline and false of the product - the runner and the schema had them and
 * the console had none of them.
 *
 * These guard the reading half. Each one is a case where showing the number wrong would be worse
 * than not showing it:
 *
 *   - a groundedness rate over EVERY exchange reports a retrieval gap as a truthfulness failure
 *   - "0% grounded" on a window nobody assessed is a fabricated verdict
 *   - a rubric warning that is always on is noise, so nobody reads the one time it matters
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';

const RANGE = { start: '2026-09-01', end: '2026-09-08' };

const l0 = (over: Record<string, unknown> = {}) => ({
  intent: 'general',
  exchange_count: 100,
  direct_count: 80,
  task_count: 0,
  avg_confidence: 82,
  avg_relevance: 71,
  relevance_scored_count: 64,
  avg_total_ms: 5000,
  tool_calls: 0,
  tool_errors: 0,
  user_rated_count: 0,
  groundedness_rate: 85,
  groundedness_assessed_count: 20,
  avg_retrieved_passages: 4.2,
  rubric_version_count: 1,
  ...over,
});

/**
 * Scoped to ONE card. "Not assessed" is also what the Compliance card says on a window nothing
 * judged, and a page-wide match would pass on the wrong card - the shape of assertion that made the
 * earlier drill tests prove nothing.
 */
function card(container: HTMLElement, title: string): HTMLElement {
  const found = Array.from(container.querySelectorAll('.metric-card')).find(
    (el) => el.querySelector('.metric-card-title')?.textContent?.startsWith(title)
  );
  if (!found) throw new Error(`no metric card titled ${title}`);
  return found as HTMLElement;
}

function renderTab(row: Record<string, unknown> = {}) {
  return render(
    <EffectivenessTab
      data={{ data: [l0(row)] } as never}
      dateRange={RANGE}
      isLoading={false}
      drill={{ level: 1, intent: 'general' }}
      onDrillChange={vi.fn()}
      filters={EMPTY_FILTERS}
      onFiltersChange={vi.fn()}
    />
  );
}

describe('groundedness states the population it was computed over', () => {
  it('divides by the exchanges a judge could assess, not by every exchange', () => {
    renderTab();
    // 17 of 20 assessed is 85%. Over all 100 exchanges it would read 17%, which would report the
    // 80 turns that retrieved nothing as ungrounded answers.
    expect(screen.getByText('85% grounded')).toBeInTheDocument();
    expect(screen.getByText(/20 of 100 had retrieval to check/)).toBeInTheDocument();
  });

  it('carries the average passage count, because the rate means less without it', () => {
    renderTab();
    // A rate over turns that saw one passage each is not the same measurement as one over turns
    // that saw ten, and the reader cannot tell which they have without this.
    expect(screen.getByText(/4\.2 passages avg/)).toBeInTheDocument();
  });

  it('says nothing was assessed rather than reporting zero percent grounded', () => {
    const { container } = renderTab({
      groundedness_assessed_count: 0, groundedness_rate: null, avg_retrieved_passages: null,
    });
    const g = card(container, 'Groundedness');
    expect(g).toHaveTextContent('Not assessed');
    expect(g).not.toHaveTextContent(/0% grounded/);
    expect(g).toHaveTextContent(/no turn in this window retrieved anything/);
  });

  it('reaches the exchanges behind the rate', () => {
    renderTab();
    expect(screen.getByRole('button', { name: /Groundedness.*breakdown/i })).toBeInTheDocument();
  });
});

describe('the rubric boundary is shown only where it changes the reading', () => {
  it('stays silent while one rubric judged the whole window', () => {
    renderTab({ rubric_version_count: 1 });
    // A permanent banner is noise, and noise is why nobody reads the one that matters.
    expect(screen.queryByText('Rubrics in window')).not.toBeInTheDocument();
  });

  it('warns when the window spans a prompt change', () => {
    renderTab({ rubric_version_count: 2 });
    expect(screen.getByText('Rubrics in window')).toBeInTheDocument();
    expect(screen.getByText(/NOT comparable/i)).toBeInTheDocument();
  });
});

describe('which retrieved passages the answer used (SPEC-EVALUATION Appendix C7)', () => {
  it('shows the share used over the turns that retrieved', () => {
    const { container } = renderTab({ passage_use_rate: 62.5, passage_use_assessed_count: 18 });
    const c = card(container, 'Retrieved passages used');
    expect(c).toHaveTextContent('62.5% used');
    expect(c).toHaveTextContent('over 18 turns that retrieved');
  });

  it('shows no card where nothing was assessed, rather than zero percent used', () => {
    renderTab({ passage_use_rate: null, passage_use_assessed_count: 0 });
    expect(screen.queryByText('Retrieved passages used')).not.toBeInTheDocument();
  });
});
