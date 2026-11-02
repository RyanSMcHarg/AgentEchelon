/**
 * THE EVALUATIONS TAB SAYS WHICH JUDGE PRODUCED ITS AVERAGE.
 *
 * The evaluation runner records the judge model on every scored row. This tab reported the relevance
 * average and the compliance rate over those rows and said nothing about the instrument, so a window
 * judged by one model and a window judged by its successor rendered identically: the same column, the
 * same average, silently re-baselined.
 *
 * Tenet P3 is why that is a defect rather than a nicety. The harness outlives the model and a model is a
 * replaceable function call, so the swap is an expected event, and after one a fall in relevance is
 * indistinguishable between a regression in the assistants and a different judge.
 *
 * AURORA MODE ONLY, AND THE TAB HAS TO BE CORRECT ABOUT THAT. This tab renders in both analytics modes.
 * Only the four-pass Aurora runner writes the judge; the Athena runner scores relevance alone and
 * records none, so the fields are ABSENT there. Absent is "not known", never "one judge".
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import EvaluationsTab from './EvaluationsTab';
import { modelDisplayName } from '@ae/shared';

const JUDGE = 'anthropic.claude-3-5-haiku-20241022-v1:0';
const NEXT_JUDGE = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

const daily = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-20',
  assistant: 'advisor',
  intent_type: 'general',
  count: 40,
  avg_relevance_score: 75,
  evaluator_model: JUDGE,
  evaluator_model_count: 1,
  ...over,
});

/** Scoped to ONE card: the compliance card beside it also prints a count and a population. */
function card(container: HTMLElement, title: string): HTMLElement {
  const found = Array.from(container.querySelectorAll('.metric-card')).find(
    (el) => el.querySelector('.metric-card-title')?.textContent?.startsWith(title),
  );
  if (!found) throw new Error(`no metric card titled ${title}`);
  return found as HTMLElement;
}

/** The Judge cell of the Nth daily row. */
function judgeCell(index = 0): HTMLElement {
  const cells = Array.from(document.querySelectorAll('[data-col="evaluator_model"]')) as HTMLElement[];
  const found = cells[index];
  if (!found) throw new Error(`no Judge cell at row ${index}`);
  return found;
}

function renderTab(rows: Record<string, unknown>[], top: Record<string, unknown> = {}) {
  return render(
    <EvaluationsTab data={{ data: rows, columns: [], ...top } as never} isLoading={false} />,
  );
}

describe('the daily series names the judge behind each row', () => {
  it('renders the judge for a group scored by one model', () => {
    renderTab([daily()]);
    expect(judgeCell(0)).toHaveTextContent(modelDisplayName(JUDGE));
  });

  it('renders a DASH for a row that records no judge', () => {
    // Three cases arrive as nothing and all of them are "not known": a group not scored yet, a row
    // written before the column was read back, and Athena mode, which records no judge at all.
    renderTab([daily({ evaluator_model: null, evaluator_model_count: 0 })]);
    const cell = judgeCell(0);
    expect(cell.textContent).toBe('—');
    expect(cell.textContent).not.toBe('');
    expect(cell).not.toHaveTextContent(/unknown/i);
  });

  it('a group spanning a swap says how many judges, rather than naming one of them', () => {
    // The row carries MAX() over its evaluations, so naming it would assert that judge for an average
    // the other one also produced.
    renderTab([daily({ evaluator_model: NEXT_JUDGE, evaluator_model_count: 2 })]);
    const cell = judgeCell(0);
    expect(cell).toHaveTextContent('2 judges');
    expect(cell).not.toHaveTextContent(modelDisplayName(NEXT_JUDGE));
  });

  it('two days judged by two models read as two different judges', () => {
    renderTab([daily(), daily({ date: '2026-09-21', evaluator_model: NEXT_JUDGE })]);
    expect(judgeCell(0)).toHaveTextContent(modelDisplayName(JUDGE));
    expect(judgeCell(1)).toHaveTextContent(modelDisplayName(NEXT_JUDGE));
  });
});

describe('the headline average states its instrument', () => {
  it('names the judge when exactly one scored the window', () => {
    const { container } = renderTab([daily()], { evaluatorModel: JUDGE, evaluatorModelCount: 1 });
    expect(card(container, 'Avg relevance')).toHaveTextContent(`judged by ${modelDisplayName(JUDGE)}`);
    expect(screen.queryByText('Judges in window')).not.toBeInTheDocument();
  });

  it('warns, and drops the name, when the window spans MORE THAN ONE judge', () => {
    const { container } = renderTab(
      [daily(), daily({ date: '2026-09-21', evaluator_model: NEXT_JUDGE })],
      { evaluatorModel: NEXT_JUDGE, evaluatorModelCount: 2 },
    );
    const judges = card(container, 'Judges in window');
    expect(judges).toHaveTextContent('2');
    expect(judges).toHaveTextContent(/MORE THAN ONE judge/);
    // The average is still shown; what changes is that it no longer claims a single instrument.
    expect(card(container, 'Avg relevance')).not.toHaveTextContent(/judged by/);
  });

  it('says nothing at all in a mode that records no judge', () => {
    // Athena mode. The fields never arrive, and undefined must not read as one judge or as a warning.
    const { container } = renderTab([daily({ evaluator_model: undefined, evaluator_model_count: undefined })]);
    expect(card(container, 'Avg relevance')).not.toHaveTextContent(/judged by/);
    expect(screen.queryByText('Judges in window')).not.toBeInTheDocument();
  });

  it('keeps the evaluation count it already reported, so the judge is additional', () => {
    // The subtitle carried the population before this change and still has to. A signal added by
    // replacing one already being read is a regression wearing a feature.
    const { container } = renderTab([daily()], { evaluatorModel: JUDGE, evaluatorModelCount: 1 });
    expect(card(container, 'Avg relevance')).toHaveTextContent('40 evaluations');
  });
});
