/**
 * Experiments, as one model: the list is one row per experiment (name and goal, what it compares, status,
 * evidence and the current result), and the experiment's page reads Goal, Results, Battles and Settings in
 * that order. Results appear only on an experiment's page, titled with its name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setClassificationsForTest, type Experiment } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';

vi.mock('../../capabilities', () => ({ useCan: () => () => true }));
vi.mock('../../services/profileService', () => ({ listProfiles: vi.fn(async () => []) }));
vi.mock('../../services/teamScope', () => ({ teamAssistant: () => null }));

const battleExp = {
  experimentId: 'exp-voice',
  description: 'Premium advisor voice',
  status: 'active',
  intent: 'general',
  tiers: ['premium'],
  variants: [
    { variantId: 'control', weight: 50, controlPin: { profileName: 'advisor', version: 12 } },
    { variantId: 'treatment', weight: 50, altPin: { profileName: 'alt-primary-premium', version: 13 } },
  ],
  startDate: '2026-10-01',
  createdAt: '2026-10-02',
  battleEnabled: true,
  challengerAssistant: 'alt-primary-premium',
  sideNames: { control: 'Atlas', treatment: 'Atlas (alt)' },
  objective: { metric: 'quality', target: 4, statement: 'Decide whether the shorter voice should ship.' },
} as unknown as Experiment;
const abExp = {
  ...battleExp,
  experimentId: 'exp-ab',
  description: '',
  battleEnabled: false,
  createdAt: '2026-10-01',
  sideNames: undefined,
  objective: { metric: 'cost', target: 10 },
} as unknown as Experiment;

vi.mock('../../services/experimentsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listExperiments: vi.fn(async () => [battleExp, abExp]),
  listBattleSettings: vi.fn(async () => [{ classification: 'premium', capable: true, enabled: true }]),
  listChallengers: vi.fn(async () => []),
  setBattleEnabled: vi.fn(),
  updateExperimentStatus: vi.fn(),
  endExperiment: vi.fn(),
  deleteExperiment: vi.fn(),
}));
const queryAnalytics = vi.fn(async (qt: string) => (qt === 'battle_results' ? { data: [] } : { data: [], battleEffectiveness: { data: [] } }));
vi.mock('../../services/analyticsService', () => ({
  queryAnalytics: (...a: unknown[]) => queryAnalytics(...(a as [string])),
  getExperimentRecommendation: vi.fn(),
}));

import ExperimentsTab, { summarizeResult } from './ExperimentsTab';

const range = { start: '2026-10-01', end: '2026-10-30' };
const resultRow = (over: Record<string, unknown> = {}) => ({
  experiment_id: 'exp-voice', variant_id: 'control', model_name: 'sonnet', intent: 'general', assistant: 'premium',
  exchange_count: 100, scored_count: 100, avg_score: 4, avg_total_ms: 1000, p95_total_ms: 2000, avg_tokens: 1,
  avg_cost_usd: 0.01, compliance_rate: null, fallback_count: 0, fallback_rate: 0, task_count: 0,
  task_completion_rate: null, thumbs_up: 0, thumbs_down: 0, feedback_count: 0, approval_rate: null,
  battle_wins: null, needs_more_data: false, ...over,
});
const rollup = [
  { experiment_id: 'exp-voice', variant_id: 'control', conversation_classification: 'premium', assistant: 'advisor', assistant_role: 'primary', profile_version: 12, model_name: 'sonnet', turn_count: 18, battle_count: 9, avg_score: 4, avg_cost_usd: 0.01, battle_wins: 3 },
  { experiment_id: 'exp-voice', variant_id: 'treatment', conversation_classification: 'premium', assistant: 'advisor', assistant_role: 'alt', profile_version: 13, model_name: 'sonnet', turn_count: 18, battle_count: 9, avg_score: 3.5, avg_cost_usd: 0.02, battle_wins: 6 },
];
const results = {
  data: [resultRow(), resultRow({ variant_id: 'treatment', avg_score: 4.4 })],
  columns: [],
  battleEffectiveness: { data: rollup },
  units: { data: [
    { experiment_id: 'exp-voice', variant_id: 'control', unit: 'conversation', conversation_count: 120, exchange_count: 100, scored_conversation_count: 1, scored_count: 1 },
    { experiment_id: 'exp-voice', variant_id: 'treatment', unit: 'conversation', conversation_count: 120, exchange_count: 100, scored_conversation_count: 1, scored_count: 1 },
  ], columns: [] },
} as never;

beforeEach(() => {
  queryAnalytics.mockClear();
  setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
});
afterEach(() => {
  setClassificationsForTest(null);
  window.history.replaceState(null, '', '/');
});

const param = (k: string) => new URLSearchParams(window.location.search).get(k);

describe('the experiment list', () => {
  it('reads each row as name and goal, comparison, status, evidence and the current result', async () => {
    window.history.replaceState(null, '', '/?admin=experiments');
    render(<ExperimentsTab resultsData={results} isLoading={false} dateRange={range} />);
    const name = await screen.findByRole('button', { name: 'Premium advisor voice' });
    const row = name.closest('tr')!;
    expect(row).toHaveTextContent('Decide whether the shorter voice should ship.');
    expect(row).toHaveTextContent('advisor: v12 vs v13');
    expect(row).toHaveTextContent('active');
    expect(row).toHaveTextContent('240 conversations · 9 battles');
    expect(within(row).getByTestId('experiment-result-line')).toHaveTextContent('Challenger leads on quality by 10% · minimum sample reached');
    // An experiment without Battle Mode names no battles, and one without a written goal says what it decides on.
    const abRow = screen.getByRole('button', { name: 'exp-ab' }).closest('tr')!;
    expect(abRow).toHaveTextContent('0 conversations');
    expect(abRow).not.toHaveTextContent(/battle/i);
    expect(abRow).toHaveTextContent('Decides on Cost −10% target');
    expect(within(abRow).getByTestId('experiment-result-line')).toHaveTextContent('No results yet');
  });

  it('shows no results block on the list, and opens the experiment\'s page from its row', async () => {
    window.history.replaceState(null, '', '/?admin=experiments');
    render(<ExperimentsTab resultsData={results} isLoading={false} dateRange={range} />);
    const name = await screen.findByRole('button', { name: 'Premium advisor voice' });
    expect(screen.queryByTestId('experiment-results')).toBeNull();
    expect(screen.queryByText(/Experiment results/i)).toBeNull();
    fireEvent.click(name.closest('tr')!.querySelector('td[data-col="status"]')!);
    expect(await screen.findByTestId('experiment-page')).toBeInTheDocument();
    expect(param('exp')).toBe('exp-voice');
  });

  it('keeps the Athena banner when results are unsupported', async () => {
    window.history.replaceState(null, '', '/?admin=experiments');
    const unsupported = { data: [], columns: [], unsupported: true, reason: 'aurora-only' } as never;
    const { container } = render(<ExperimentsTab resultsData={unsupported} isLoading={false} dateRange={range} />);
    await screen.findByRole('button', { name: 'Premium advisor voice' });
    expect(container.querySelector('.admin-info-banner')).not.toBeNull();
  });

  it('says a thin result is not decisive yet, and a recorded decision as decided', () => {
    const thin = { ...(results as object), data: [resultRow({ needs_more_data: true }), resultRow({ variant_id: 'treatment', avg_score: 3, needs_more_data: true })], units: undefined } as never;
    expect(summarizeResult(battleExp, thin)).toMatchObject({ state: 'leads', leader: 'control', liftPct: 25, thin: true });
    const decided = { ...battleExp, decision: { outcome: 'promoted_treatment' } } as unknown as Experiment;
    expect(summarizeResult(decided, results)).toEqual({ state: 'decided', outcome: 'promoted_treatment' });
  });
});

describe('an experiment\'s page', () => {
  it('reads Goal, Results, Battles, Settings in that order, with Results titled by the experiment\'s name', async () => {
    window.history.replaceState(null, '', '/?admin=experiments&exp=exp-voice');
    render(<ExperimentsTab resultsData={results} isLoading={false} dateRange={range} />);
    const page = await screen.findByTestId('experiment-page');
    await screen.findByTestId('experiment-battles');
    const order = ['experiment-goal', 'experiment-results', 'experiment-battles', 'experiment-settings']
      .map((id) => within(page).getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(order[0]).getByRole('heading', { name: 'Goal' })).toBeInTheDocument();
    expect(order[0]).toHaveTextContent('Decide whether the shorter voice should ship.');
    expect(order[0]).toHaveTextContent('Quality ≥4% target');
    expect(within(order[1]).getByRole('heading', { name: 'Results: Premium advisor voice' })).toBeInTheDocument();
    expect(within(order[2]).getByRole('heading', { name: 'Battles' })).toBeInTheDocument();
    const settings = order[3];
    expect(settings).toHaveTextContent('50% of traffic');
    expect(settings).toHaveTextContent('alt-primary-premium');
    expect(settings).toHaveTextContent('Battle Mode in Premium');
    await waitFor(() => expect(queryAnalytics).toHaveBeenCalledWith('battle_results', range, expect.objectContaining({ experimentId: 'exp-voice' })));
    // The battle numbers are the Battles section's own; Results does not repeat them as a table.
    expect(within(order[1]).queryByText(/Battle results/)).toBeNull();
  });

  it('an experiment without Battle Mode has no Battles section and reads no battles', async () => {
    window.history.replaceState(null, '', '/?admin=experiments&exp=exp-ab');
    render(<ExperimentsTab resultsData={results} isLoading={false} dateRange={range} />);
    await screen.findByTestId('experiment-settings');
    expect(screen.getByRole('heading', { name: 'Results: exp-ab' })).toBeInTheDocument();
    expect(screen.queryByTestId('experiment-battles')).toBeNull();
    expect(screen.queryByTestId('experiment-battle')).toBeNull();
    expect(queryAnalytics).not.toHaveBeenCalledWith('battle_results', expect.anything(), expect.anything());
  });

  it('a link naming a battle opens its experiment page', async () => {
    window.history.replaceState(null, '', '/?admin=experiments&exp=exp-voice&battle=b-1');
    render(<ExperimentsTab resultsData={results} isLoading={false} dateRange={range} />);
    expect(await screen.findByTestId('experiment-page')).toBeInTheDocument();
  });

  it('Back returns to the list', async () => {
    window.history.replaceState(null, '', '/?admin=experiments&exp=exp-voice');
    render(<ExperimentsTab resultsData={results} isLoading={false} dateRange={range} />);
    fireEvent.click(await screen.findByRole('button', { name: '← All experiments' }));
    expect(await screen.findByRole('button', { name: 'Premium advisor voice' })).toBeInTheDocument();
    expect(param('exp')).toBeNull();
  });
});
