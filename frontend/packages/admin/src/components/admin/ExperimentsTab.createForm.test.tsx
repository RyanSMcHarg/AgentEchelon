/**
 * THE CREATE FORM SAYS WHERE A BATTLE CAN RUN FROM THE DEPLOYMENT'S BATTLE SETTINGS. Battle Mode is a
 * per-classification setting (`listBattleSettings`: classification, capable, enabled), so the battle
 * option names the classifications this deployment builds it for, and says so when there are none.
 * Every caption in the form's top grid carries the same label element, so the controls share a baseline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setClassificationsForTest, type BattleSetting } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';

const settings = vi.hoisted(() => ({ rows: [] as BattleSetting[] }));

vi.mock('../../capabilities', () => ({ useCan: () => () => true }));
vi.mock('../../services/profileService', () => ({ listProfiles: vi.fn(async () => []) }));
vi.mock('../../services/teamScope', () => ({ teamAssistant: () => null }));
vi.mock('../../services/experimentsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listExperiments: vi.fn(async () => []),
  listBattleSettings: vi.fn(async () => settings.rows),
  listChallengers: vi.fn(async () => []),
  setBattleEnabled: vi.fn(),
}));
vi.mock('../../services/analyticsService', () => ({
  queryAnalytics: vi.fn(async () => ({ data: [] })),
  getExperimentRecommendation: vi.fn(),
}));

import ExperimentsTab from './ExperimentsTab';

const range = { start: '2026-10-01', end: '2026-10-30' };

async function openCreateForm() {
  window.history.replaceState(null, '', '/?admin=experiments');
  render(<ExperimentsTab resultsData={{ data: [], columns: [] } as never} isLoading={false} dateRange={range} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New Experiment' }));
}

beforeEach(() => setClassificationsForTest(SAMPLE_CLASSIFICATIONS));
afterEach(() => {
  setClassificationsForTest(null);
  window.history.replaceState(null, '', '/');
});

describe('the battle option in the create form', () => {
  it('names the classifications whose deployment builds Battle Mode', async () => {
    settings.rows = [
      { classification: 'basic', capable: false, enabled: false },
      { classification: 'premium', capable: true, enabled: true },
      { classification: 'standard', capable: true, enabled: false },
    ];
    await openCreateForm();
    const badge = await screen.findByText('Available in Confidential, Internal');
    expect(badge.getAttribute('data-testid')).toBe('battle-availability');
    expect(document.body.textContent).not.toMatch(/premium-only/i);
    // The label is translated copy, with the command set apart.
    const toggle = screen.getByRole('checkbox', { name: /Enable for \/battle/ });
    expect(toggle).toBeTruthy();
    expect(document.querySelector('.experiment-battle-toggle-label strong')?.textContent).toBe('/battle');
  });

  it('says so when no classification can run a battle', async () => {
    settings.rows = [{ classification: 'basic', capable: false, enabled: false }];
    await openCreateForm();
    expect(await screen.findByText('Not available in any classification')).toBeTruthy();
    expect(screen.getByTestId('battle-availability').textContent).not.toMatch(/premium/i);
  });
});

describe('the battle option when the settings could not be read', () => {
  it('says nothing about where a battle can run, rather than that it runs nowhere', async () => {
    const svc = await import('../../services/experimentsService');
    vi.mocked(svc.listBattleSettings).mockRejectedValueOnce(new Error('unreachable'));
    await openCreateForm();
    await screen.findByRole('checkbox', { name: /Enable for \/battle/ });
    expect(screen.queryByTestId('battle-availability')).toBeNull();
    expect(screen.queryByText('Not available in any classification')).toBeNull();
  });
});

describe('the create form top grid', () => {
  it('gives every field one caption element, with the type tip inside it', async () => {
    settings.rows = [];
    await openCreateForm();
    const grid = document.querySelector('.experiment-create-form > .admin-form-grid')!;
    const fields = Array.from(grid.children);
    expect(fields.length).toBeGreaterThan(4);
    for (const field of fields) {
      if (field.tagName === 'P') continue; // a full-width note, not a field
      expect(field.firstElementChild?.className, field.textContent ?? '').toBe('admin-field-label');
    }
    const type = fields.find((f) => f.textContent?.startsWith('Type'))!;
    expect(type.querySelector('.admin-field-label > .info-tip button[aria-label="About experiment type"]')).toBeTruthy();
  });
});
