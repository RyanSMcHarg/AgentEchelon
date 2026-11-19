/**
 * AN EXPERIMENT'S RESULTS HEADER NAMES THE INTENTS IT TESTS, FROM ITS DEFINITION: an `intent` experiment its one
 * intent, every other type all intents. Whenever the figures beside it were summed over intents other than exactly
 * those, the header says which intents the figures cover, so the header and the numbers describe the same traffic
 * whatever order the rows arrive in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { setClassificationsForTest, type Experiment } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';

vi.mock('../../capabilities', () => ({ useCan: () => () => true }));
vi.mock('../../services/profileService', () => ({ listProfiles: vi.fn(async () => []) }));
vi.mock('../../services/teamScope', () => ({ teamAssistant: () => null }));

let experiments: Experiment[] = [];
vi.mock('../../services/experimentsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listExperiments: vi.fn(async () => experiments),
  listBattleSettings: vi.fn(async () => []),
  listChallengers: vi.fn(async () => []),
  setBattleEnabled: vi.fn(),
}));
vi.mock('../../services/analyticsService', () => ({
  queryAnalytics: vi.fn(async () => ({ data: [] })),
  getExperimentRecommendation: vi.fn(),
}));

import ExperimentsTab from './ExperimentsTab';

const range = { start: '2026-10-01', end: '2026-10-30' };

const experimentOf = (over: Record<string, unknown>) => ({
  experimentId: 'exp-1',
  description: 'Scope test',
  status: 'active',
  intent: '',
  tiers: ['premium'],
  variants: [{ variantId: 'control', weight: 50 }, { variantId: 'treatment', weight: 50 }],
  startDate: '2026-10-01',
  createdAt: '2026-10-01',
  ...over,
}) as unknown as Experiment;

const row = (variant: string, intent: string, exchanges: number, over: Record<string, unknown> = {}) => ({
  experiment_id: 'exp-1', variant_id: variant, model_name: 'sonnet', intent, assistant: 'advisor', classifications: ['premium'],
  exchange_count: exchanges, scored_count: exchanges, avg_score: 4, avg_total_ms: 1000, p95_total_ms: 2000, avg_tokens: 1,
  avg_cost_usd: 0.01, compliance_rate: null, fallback_count: 0, fallback_rate: 0, task_count: 0,
  task_completion_rate: null, thumbs_up: 0, thumbs_down: 0, feedback_count: 0, approval_rate: null,
  battle_wins: null, needs_more_data: false, ...over,
});

async function headerFor(experiment: Experiment, rows: ReturnType<typeof row>[]): Promise<HTMLElement> {
  experiments = [experiment];
  window.history.replaceState(null, '', '/?admin=experiments&exp=exp-1');
  render(<ExperimentsTab resultsData={{ data: rows, columns: [] } as never} isLoading={false} dateRange={range} />);
  return (await screen.findByTestId('experiment-intent-scope')).closest('.exp-compare-meta') as HTMLElement;
}

beforeEach(() => setClassificationsForTest(SAMPLE_CLASSIFICATIONS));
afterEach(() => {
  setClassificationsForTest(null);
  window.history.replaceState(null, '', '/');
});

describe('the results header of an experiment', () => {
  it('names the one intent an intent experiment tests', async () => {
    const head = await headerFor(experimentOf({ experimentType: 'intent', intent: 'research' }), [
      row('control', 'research', 30), row('treatment', 'research', 20),
    ]);
    expect(screen.getByTestId('experiment-intent-scope')).toHaveTextContent(/^research$/);
    expect(head).toHaveTextContent('50 exchanges');
    // The classification comes from the definition, never the assistant that answered a row.
    expect(screen.getByTestId('experiment-classification-scope')).toHaveTextContent(/^Confidential$/);
    expect(head).not.toHaveTextContent('advisor');
  });

  it('names the tested intent and every intent the figures cover when they reach beyond it, whatever the row order', async () => {
    // An experiment on `general` counts the intents answered through the `general` route, so its figures span intents.
    await headerFor(experimentOf({ experimentType: 'intent', intent: 'general' }), [
      row('control', 'research', 30), row('control', 'general', 10), row('treatment', 'general', 10), row('treatment', 'research', 20),
    ]);
    expect(screen.getByTestId('experiment-intent-scope')).toHaveTextContent(/^general · figures from general, research$/);
  });

  it.each(['base_model', 'classification', 'profile'])('says all intents for a %s experiment, and which intents its figures came from', async (experimentType) => {
    await headerFor(experimentOf({ experimentType, intent: '' }), [
      row('control', 'research', 30), row('control', 'general', 10), row('treatment', 'research', 20), row('treatment', 'general', 10),
    ]);
    expect(screen.getByTestId('experiment-intent-scope')).toHaveTextContent(/^All intents · figures from general, research$/);
  });

  it('describes the same intents the figures sum: every intent named, every intent\'s exchanges counted', async () => {
    const head = await headerFor(experimentOf({ experimentType: 'base_model', intent: '' }), [
      row('control', 'research', 30), row('control', 'general', 10), row('control', 'code_generation', 5),
      row('treatment', 'research', 20), row('treatment', 'general', 10), row('treatment', 'code_generation', 5),
    ]);
    expect(screen.getByTestId('experiment-intent-scope')).toHaveTextContent('figures from code_generation, general, research');
    // 45 + 35: the exchange total beside the header is summed over exactly the intents it names.
    expect(head).toHaveTextContent('80 exchanges');
  });

  it('labels the Goal scope from the definition too', async () => {
    await headerFor(experimentOf({ experimentType: 'profile', intent: '' }), [row('control', 'research', 1), row('treatment', 'research', 1)]);
    expect(screen.getByTestId('experiment-goal')).toHaveTextContent(/All intents · Confidential/);
  });

  it('names the targeted classification and every classification the figures cover when they reach beyond it', async () => {
    await headerFor(experimentOf({ experimentType: 'intent', intent: 'research', tiers: ['premium'] }), [
      row('control', 'research', 30, { classifications: ['standard', 'premium'] }), row('treatment', 'research', 20),
    ]);
    expect(screen.getByTestId('experiment-classification-scope')).toHaveTextContent(/^Confidential · figures from Confidential, Internal$/);
  });

  it('counts one exchange in the singular and a large total with separators', async () => {
    const one = await headerFor(experimentOf({ experimentType: 'intent', intent: 'research' }), [row('control', 'research', 1)]);
    expect(one).toHaveTextContent(/1 exchange$/);
    cleanup();
    const many = await headerFor(experimentOf({ experimentType: 'intent', intent: 'research' }), [
      row('control', 'research', 1000), row('treatment', 'research', 250),
    ]);
    expect(many).toHaveTextContent('1,250 exchanges');
  });

  it('names every model a variant was answered by, most exchanges first, whatever the row order', async () => {
    await headerFor(experimentOf({ experimentType: 'intent', intent: 'general' }), [
      row('control', 'general', 10, { model_name: 'model-a' }), row('control', 'research', 30, { model_name: 'model-b' }),
      row('treatment', 'general', 5, { model_name: 'model-c' }),
    ]);
    const models = screen.getAllByText(/model-/).map((el) => el.textContent);
    expect(models).toEqual(['model-b, model-a', 'model-c']);
  });
});
