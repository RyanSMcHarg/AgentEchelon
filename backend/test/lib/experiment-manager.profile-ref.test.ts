/**
 * SPEC-PORTABLE-PROFILES P2 — variant validation: modelKey XOR profileRef.
 */
import { validateAndSanitizeExperiment, ExperimentValidationError, type Experiment } from '../../lambda/src/lib/experiment-manager';

/** A model experiment: the variant shape rules below hold for every type that may carry a profileRef. */
function exp(variants: unknown[]): Experiment {
  return {
    experimentId: 'e1',
    status: 'active',
    experimentType: 'base_model',
    intent: '',
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
      { variantId: 'b', profileRef: { profileName: 'advisor', version: 2 }, weight: 50 },
    ]))).not.toThrow();
  });

  it('rejects a variant with BOTH modelKey and profileRef', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', modelKey: 'haiku', profileRef: { profileName: 'advisor' }, weight: 100 },
    ]))).toThrow(ExperimentValidationError);
  });

  it('rejects a treatment with NEITHER modelKey nor profileRef', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', weight: 50 },
      { variantId: 'b', weight: 50 },
    ]))).toThrow(ExperimentValidationError);
  });

  it('accepts a control that names neither: it is the live active version (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5)', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', weight: 50 },
      { variantId: 'b', modelKey: 'sonnet', weight: 50 },
    ]))).not.toThrow();
  });

  it('rejects a profileRef with a non-positive version', () => {
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'a', profileRef: { profileName: 'advisor', version: 0 }, weight: 100 },
    ]))).toThrow(/positive integer/);
  });

  it('accepts a profile-vs-profile experiment (type "profile", no intent, two profileRefs)', () => {
    const out = validateAndSanitizeExperiment({
      ...exp([
        { variantId: 'control', profileRef: { profileName: 'advisor' }, weight: 50 },
        { variantId: 'treatment', profileRef: { profileName: 'advisor', version: 3 }, weight: 50 },
      ]),
      experimentType: 'profile',
      intent: '', // profile experiments apply across intents (like base_model)
    } as Experiment);
    expect(out.experimentType).toBe('profile');
  });
});

describe("a whole profile is never an intent experiment's variant (ADR-050)", () => {
  it('refuses a profileRef variant on an intent experiment', () => {
    const intentExp = { ...exp([
      { variantId: 'a', modelKey: 'haiku', weight: 50 },
      { variantId: 'b', profileRef: { profileName: 'alt-primary-premium', version: 1 }, weight: 50 },
    ]), experimentType: 'intent', intent: 'general' } as Experiment;
    try {
      validateAndSanitizeExperiment(intentExp);
      throw new Error('accepted');
    } catch (err) {
      expect(err).toBeInstanceOf(ExperimentValidationError);
      expect((err as ExperimentValidationError & { code?: string }).code).toBe('PROFILE_REF_ON_INTENT_EXPERIMENT');
    }
  });

  it('still accepts a model-only intent experiment', () => {
    expect(() => validateAndSanitizeExperiment({ ...exp([
      { variantId: 'a', modelKey: 'haiku', weight: 50 },
      { variantId: 'b', modelKey: 'sonnet', weight: 50 },
    ]), experimentType: 'intent', intent: 'general' } as Experiment)).not.toThrow();
  });
});
