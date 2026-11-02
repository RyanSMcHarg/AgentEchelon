import { describe, it, expect } from 'vitest';
import { duelSideName } from './experimentControl';

describe('duelSideName: a battle variant is shown by the name the duel gave its side', () => {
  const experiment = {
    variants: [{ variantId: 'control' }, { variantId: 'treatment' }],
    sideNames: { control: 'Advisor', treatment: 'Advisor (alt)' },
  };

  it('names the control by variants[0] and the challenger by variants[1]', () => {
    expect(duelSideName(experiment, 'control')).toBe('Advisor');
    expect(duelSideName(experiment, 'treatment')).toBe('Advisor (alt)');
  });

  it('names nothing for a variant that is neither side, or when no name resolved', () => {
    expect(duelSideName(experiment, 'other')).toBeUndefined();
    expect(duelSideName({ variants: experiment.variants }, 'control')).toBeUndefined();
    expect(duelSideName({ ...experiment, sideNames: { control: 'Advisor' } }, 'treatment')).toBeUndefined();
    expect(duelSideName(undefined, 'control')).toBeUndefined();
  });
});
