/**
 * THE CREATE FORM NAMES A BATTLE SIDE'S ADDENDUM AS THE INSTRUCTION THE EXPERIMENT TESTS: each side's box is labeled a
 * tested instruction, its example is a variation under test rather than a general rule, and the help says general
 * answer style belongs in the persona and that a promoted instruction is moved there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setClassificationsForTest } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';

vi.mock('../../capabilities', () => ({ useCan: () => () => true }));
vi.mock('../../services/profileService', () => ({ listProfiles: vi.fn(async () => []) }));
vi.mock('../../services/teamScope', () => ({ teamAssistant: () => null }));
vi.mock('../../services/experimentsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listExperiments: vi.fn(async () => []),
  listBattleSettings: vi.fn(async () => [{ classification: 'premium', capable: true, enabled: true }]),
  listChallengers: vi.fn(async () => []),
  setBattleEnabled: vi.fn(),
}));
vi.mock('../../services/analyticsService', () => ({
  queryAnalytics: vi.fn(async () => ({ data: [] })),
  getExperimentRecommendation: vi.fn(),
}));

import ExperimentsTab from './ExperimentsTab';

const range = { start: '2026-10-01', end: '2026-10-30' };

beforeEach(() => setClassificationsForTest(SAMPLE_CLASSIFICATIONS));
afterEach(() => {
  setClassificationsForTest(null);
  window.history.replaceState(null, '', '/');
});

describe('a battle side\'s tested instruction', () => {
  it('is labeled and explained as what the experiment tests, with general style left to the persona', async () => {
    window.history.replaceState(null, '', '/?admin=experiments');
    render(<ExperimentsTab resultsData={{ data: [], columns: [] } as never} isLoading={false} dateRange={range} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New Experiment' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable for/ }));

    const a = screen.getByRole('textbox', { name: 'Tested instruction for A · Control' });
    const b = screen.getByRole('textbox', { name: 'Tested instruction for B · Treatment' });
    for (const box of [a, b]) {
      expect(box.getAttribute('placeholder')).toContain('to test whether shorter replies are rated higher');
      expect(box.getAttribute('placeholder')).not.toContain('three bullet points');
    }
    const help = screen.getByTestId('addendum-help').textContent ?? '';
    expect(help).toContain('How the assistant answers in general belongs in the persona');
    expect(help).toContain('Move into the persona');
  });
});
