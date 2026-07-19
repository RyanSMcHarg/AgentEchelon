/**
 * SPEC-PORTABLE-VERSIONED-PROFILES P2 — variant validation: modelKey XOR profileRef.
 */
import { validateAndSanitizeExperiment, ExperimentValidationError, type Experiment } from '../../lambda/src/lib/experiment-manager';

function exp(variants: unknown[]): Experiment {
  return {
    experimentId: 'e1',
    status: 'active',
    experimentType: 'intent',
    intent: 'general_qa',
    tiers: ['premium'],
    variants: variants as never,
    startDate: '2026-07-19',
    createdAt: '2026-07-19',
  } as Experiment;
}

describe('ExperimentVariant modelKey XOR profileRef (P2)', () => {
  it('accepts a bare-model variant', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', modelKey: 'haiku', weight: 50 },
      { variantId: 'b', modelKey: 'sonnet', weight: 50 },
    ]))).not.toThrow();
  });

  it('accepts a profileRef variant (runs an entire version)', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', modelKey: 'haiku', weight: 50 },
      { variantId: 'b', profileRef: { profileName: 'premium', version: 2 }, weight: 50 },
    ]))).not.toThrow();
  });

  it('rejects a variant with BOTH modelKey and profileRef', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', modelKey: 'haiku', profileRef: { profileName: 'premium' }, weight: 100 },
    ]))).toThrow(ExperimentValidationError);
  });

  it('rejects a variant with NEITHER modelKey nor profileRef', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', weight: 100 },
    ]))).toThrow(ExperimentValidationError);
  });

  it('rejects a profileRef with a non-positive version', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', profileRef: { profileName: 'premium', version: 0 }, weight: 100 },
    ]))).toThrow(/positive integer/);
  });
});
