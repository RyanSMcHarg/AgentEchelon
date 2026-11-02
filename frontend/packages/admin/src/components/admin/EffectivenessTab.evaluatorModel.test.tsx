/**
 * A SCORE THAT CANNOT NAME ITS JUDGE CANNOT BE COMPARED.
 *
 * The evaluation runner stamps the judge model on every row it writes and has done since the first
 * migration. No query returned it and no surface showed it, so it was recorded and thrown away.
 *
 * Tenet P3 is what makes that a defect rather than an omission: the harness outlives the model, and a
 * model is a replaceable function call, so swapping the judge is an EXPECTED event. Every score
 * re-baselines when it happens, and with the model unreadable a fall in relevance is indistinguishable
 * between a regression in the assistant and a different judge.
 *
 * These pin the reading half, the way the sibling rubric tests do. Each case is one where showing the
 * value wrong would be worse than not showing it:
 *
 *   - naming today's judge on a row scored before the column was read attributes a score to a model
 *     that never saw it, which is a confident wrong answer rather than a missing one;
 *   - a single name over a window that spans a model swap describes neither half of it;
 *   - a warning that is always on is noise, so nobody reads the one time it matters.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import { queryAnalytics } from '../../services/analyticsService';
import { modelDisplayName } from '@ae/shared';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const RANGE = { start: '2026-09-01', end: '2026-09-08' };

/** A judge and its successor. The whole feature is about telling these two apart. */
const JUDGE = 'anthropic.claude-3-5-haiku-20241022-v1:0';
const NEXT_JUDGE = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

const l0 = (over: Record<string, unknown> = {}) => ({
  intent: 'general',
  exchange_count: 100,
  direct_count: 80,
  task_count: 0,
  avg_confidence: 82,
  avg_relevance: 71,
  relevance_scored_count: 64,
  avg_total_ms: 5000,
  rubric_version_count: 1,
  evaluator_model: JUDGE,
  evaluator_model_count: 1,
  ...over,
});

/**
 * Scoped to ONE card, for the reason the sibling signal test gives: several cards on this surface
 * legitimately print a count, and a page-wide match would pass on the wrong one.
 */
function card(container: HTMLElement, title: string): HTMLElement {
  const found = Array.from(container.querySelectorAll('.metric-card')).find(
    (el) => el.querySelector('.metric-card-title')?.textContent?.startsWith(title),
  );
  if (!found) throw new Error(`no metric card titled ${title}`);
  return found as HTMLElement;
}

function renderL1(row: Record<string, unknown> = {}) {
  return render(
    <EffectivenessTab
      data={{ data: [l0(row)] } as never}
      dateRange={RANGE}
      isLoading={false}
      drill={{ level: 1, intent: 'general' }}
      onDrillChange={vi.fn()}
      filters={EMPTY_FILTERS}
      onFiltersChange={vi.fn()}
    />,
  );
}

/** The L2 exchange list, which is where an individual score meets its own judge. */
function renderL2(exchanges: Record<string, unknown>[], evals: Record<string, unknown>[] = []) {
  mockQuery.mockImplementation(((type: string) => {
    if (type === 'intent_exchanges') return Promise.resolve({ data: exchanges, total: exchanges.length } as never);
    if (type === 'evaluation_exchanges') return Promise.resolve({ data: evals } as never);
    return Promise.resolve({ data: [] } as never);
  }) as never);
  return render(
    <EffectivenessTab
      data={{ data: [l0()] } as never}
      dateRange={RANGE}
      isLoading={false}
      drill={{ level: 2, intent: 'general', delivery: 'direct' }}
      onDrillChange={vi.fn()}
      filters={EMPTY_FILTERS}
      onFiltersChange={vi.fn()}
    />,
  );
}

/**
 * The Judge cell of the Nth exchange row.
 *
 * By position, because the exchange id is not one of the table's columns: a lookup keyed on it matched
 * nothing and fell through to the first row, so a two-row case asserted the same cell twice and would
 * have passed on a column that rendered one judge for both.
 */
function judgeCell(index = 0): HTMLElement {
  const cells = Array.from(document.querySelectorAll('[data-col="evaluator_model"]')) as HTMLElement[];
  const found = cells[index];
  if (!found) throw new Error(`no Judge cell at row ${index}`);
  return found;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ data: [] } as never);
});

describe('an exchange names the model that judged it', () => {
  it('renders the judge beside the score it produced', async () => {
    renderL2([{ exchange_id: 'ex1', relevance_score: 82, evaluator_model: JUDGE, created_at: RANGE.start }]);
    await waitFor(() => expect(document.querySelector('[data-col="evaluator_model"]')).toBeTruthy());

    const cell = judgeCell(0);
    // The display name is what a reader sees; the RAW id is what identifies the model, so it rides in
    // the title rather than being lost to the formatter.
    expect(cell).toHaveTextContent(modelDisplayName(JUDGE));
    expect(cell.querySelector('[title]')?.getAttribute('title')).toContain(JUDGE);
  });

  it('renders a DASH, not a model name, when the row carries no judge', async () => {
    // A row scored before the column was read back has no judge to name. Printing the current one
    // would attribute a score to a model that never saw it.
    renderL2([{ exchange_id: 'ex1', relevance_score: 82, evaluator_model: null, created_at: RANGE.start }]);
    await waitFor(() => expect(document.querySelector('[data-col="evaluator_model"]')).toBeTruthy());

    const cell = judgeCell(0);
    expect(cell.textContent).toBe('—');
    expect(cell.textContent).not.toBe('');
    expect(cell).not.toHaveTextContent(/unknown/i);
    expect(cell).not.toHaveTextContent(modelDisplayName(JUDGE));
  });

  it('shows two rows judged by two models as two different judges', async () => {
    renderL2([
      { exchange_id: 'ex1', relevance_score: 82, evaluator_model: JUDGE, created_at: RANGE.start },
      { exchange_id: 'ex2', relevance_score: 44, evaluator_model: NEXT_JUDGE, created_at: RANGE.start },
    ]);
    await waitFor(() => expect(document.querySelectorAll('[data-col="evaluator_model"]').length).toBe(2));

    expect(judgeCell(0)).toHaveTextContent(modelDisplayName(JUDGE));
    expect(judgeCell(1)).toHaveTextContent(modelDisplayName(NEXT_JUDGE));
  });

  it('falls back to the folded evaluation row, so either query answering fills the cell', async () => {
    // Both the exchange list and the evaluation list carry the judge. The drill merges them, and a
    // cell that read only one of the two would print a dash on data it was given.
    renderL2(
      [{ exchange_id: 'ex1', relevance_score: 82, created_at: RANGE.start }],
      [{ id: 'ex1', classification: 'good', evaluator_model: NEXT_JUDGE }],
    );
    await waitFor(() => expect(document.querySelector('[data-col="evaluator_model"]')).toBeTruthy());

    expect(judgeCell(0)).toHaveTextContent(modelDisplayName(NEXT_JUDGE));
  });

  it('labels the column, so the value is not an unexplained model id', async () => {
    renderL2([{ exchange_id: 'ex1', relevance_score: 82, evaluator_model: JUDGE, created_at: RANGE.start }]);
    await waitFor(() => expect(document.querySelector('thead')).toBeTruthy());

    const header = document.querySelector('thead') as HTMLElement;
    expect(within(header).getByText('Judge')).toBeTruthy();
    // Beside the rubric, which is the other axis of the same question: what the judge was ASKED.
    expect(within(header).getByText('Rubric')).toBeTruthy();
  });
});

describe('the aggregate says whether one judge produced it', () => {
  it('names the judge on the card the average sits on', () => {
    const { container } = renderL1();
    expect(card(container, 'Relevance')).toHaveTextContent(`judged by ${modelDisplayName(JUDGE)}`);
  });

  it('stays silent about the judge when the rows do not record one', () => {
    // Athena mode records no judge, and so does a window nothing has scored. Neither is "one judge",
    // and asserting one would be an invention rather than a gap.
    const { container } = renderL1({ evaluator_model: null, evaluator_model_count: 0 });
    const relevance = card(container, 'Relevance');
    expect(relevance).not.toHaveTextContent(/judged by/);
    expect(screen.queryByText('Judges in window')).not.toBeInTheDocument();
  });

  it('warns when the window spans MORE THAN ONE judge', () => {
    renderL1({ evaluator_model_count: 2 });
    expect(screen.getByText('Judges in window')).toBeInTheDocument();
    expect(screen.getByText(/mixes evaluation models/)).toBeInTheDocument();
    // The count is stated, because "two judges" and "five judges" are different readings.
    expect(card(document.body, 'Judges in window')).toHaveTextContent('2');
  });

  it('drops the single name once the window is mixed, rather than picking one of them', () => {
    // MAX() over a mixed window returns one of the models. Printing it beside the average would say
    // the average came from that judge, which is the confident wrong answer this exists to avoid.
    const { container } = renderL1({ evaluator_model_count: 2, evaluator_model: NEXT_JUDGE });
    expect(card(container, 'Relevance')).not.toHaveTextContent(/judged by/);
  });

  it('stays silent while ONE judge scored the whole window', () => {
    // A banner that is always on is noise, and noise is why nobody reads the one that matters.
    renderL1({ evaluator_model_count: 1 });
    expect(screen.queryByText('Judges in window')).not.toBeInTheDocument();
  });
});
