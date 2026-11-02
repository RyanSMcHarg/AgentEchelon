import { describe, it, expect } from 'vitest';
import type { BattleChallenger } from '@ae/shared';
import { challengerForForm } from './ExperimentsTab';

// THE BATTLE FORM NAMES ITS CHALLENGER BY ASSISTANT ID, from what the deployment's assignment records
// provision (`GET /admin/experiments/challengers`), never from a list of the console's own.

const challengers: BattleChallenger[] = [
  { assistant: 'alt-primary-premium', classification: 'premium', role: 'primary', inUseBy: null },
  { assistant: 'alt-primary-standard', classification: 'standard', role: 'primary', inUseBy: 'exp-live' },
];

describe('challengerForForm', () => {
  it('offers only the targeted classification\'s challenger, and names it by id', () => {
    expect(challengerForForm(challengers, ['premium'], '')).toEqual({
      offered: [challengers[0]],
      chosen: 'alt-primary-premium',
    });
  });

  it('keeps an operator\'s choice only while it belongs to the targeted classification', () => {
    expect(challengerForForm(challengers, ['standard'], 'alt-primary-standard').chosen).toBe('alt-primary-standard');
    expect(challengerForForm(challengers, ['standard'], 'alt-primary-premium').chosen).toBe('alt-primary-standard');
  });

  it('offers nothing for a classification that provisions no challenger, or for more than one classification', () => {
    expect(challengerForForm(challengers, ['basic'], '')).toEqual({ offered: [], chosen: undefined });
    expect(challengerForForm(challengers, ['standard', 'premium'], '')).toEqual({ offered: [], chosen: undefined });
  });
});
