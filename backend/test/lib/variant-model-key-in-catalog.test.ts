/**
 * An experiment variant's `modelKey` must be a key this deployment actually has.
 *
 * WHY PRESENCE WAS NOT ENOUGH, AND WHY THE FAILURE IS THE WORST KIND. Validation checked that exactly
 * one of `modelKey` / `profileRef` was SET, and never that the key existed. At resolution
 * `catalog[modelKey]` returns undefined for an unknown key, so no variant model resolves and the turn
 * falls back to the profile's default - which means BOTH ARMS RUN THE SAME MODEL and the experiment
 * reports `indistinguishable`.
 *
 * Nothing errors. Both arms answer. The console shows a clean verdict. A typo in a model key produces a
 * confident, meaningless result that an operator would act on. That is the same false-negative shape as
 * a variant-blind profile resolution, reached by a different route, and it is why this is a write-time
 * reject rather than something to notice later.
 *
 * The rule matches what the profile write path already does (`validateBody` against the model catalog):
 * confirm at the selection point. The KEY is what gets stored, never a resolved Bedrock id - a variant
 * has to stay instance-agnostic for the same reason a profile version does (SPEC-PORTABLE §5).
 */
import { validateAndSanitizeExperiment, ExperimentValidationError, type Experiment } from '../../lambda/src/lib/experiment-manager';
import { modelCatalogKeys } from '../../lib/config/model-strategy';

const KEYS = modelCatalogKeys();

function exp(variants: Array<Record<string, unknown>>): Experiment {
  return {
    experimentId: 'e1',
    name: 'test',
    status: 'draft',
    classification: 'premium',
    experimentType: 'base_model',
    intent: 'general',
    variants,
    createdAt: new Date('2026-08-10T00:00:00Z').toISOString(),
  } as unknown as Experiment;
}

describe('the catalog is consulted, not just the field', () => {
  it('rejects a modelKey that is not in the catalog', () => {
    expect(() => validateAndSanitizeExperiment(
      exp([
        { variantId: 'control', modelKey: 'sonnet', weight: 50 },
        { variantId: 'treatment', modelKey: 'sonnett', weight: 50 }, // the typo that used to pass
      ]),
      KEYS,
    )).toThrow(ExperimentValidationError);
  });

  it('names the offending key AND what is available, so the operator can fix it', () => {
    try {
      validateAndSanitizeExperiment(
        exp([
          { variantId: 'control', modelKey: 'sonnet', weight: 50 },
          { variantId: 'treatment', modelKey: 'gpt5', weight: 50 },
        ]),
        KEYS,
      );
      throw new Error('expected a validation error');
    } catch (err) {
      const e = err as ExperimentValidationError;
      expect(e.code).toBe('VARIANT_MODEL_KEY_UNKNOWN');
      expect(e.message).toContain("'gpt5'");
      expect(e.message).toContain("'sonnet'"); // the catalog, listed
    }
  });

  it('accepts every key the catalog actually publishes', () => {
    // Derived from the catalog rather than hardcoded: a new model must not need this test edited, and a
    // REMOVED model must not leave a stale key asserted as valid.
    for (const key of KEYS) {
      expect(() => validateAndSanitizeExperiment(
        exp([
          { variantId: 'control', modelKey: key, weight: 50 },
          { variantId: 'treatment', modelKey: 'sonnet', weight: 50 },
        ]),
        KEYS,
      )).not.toThrow();
    }
  });

  it('a profileRef variant is unaffected — it carries no modelKey to check', () => {
    expect(() => validateAndSanitizeExperiment(
      exp([
        { variantId: 'control', modelKey: 'sonnet', weight: 50 },
        { variantId: 'treatment', profileRef: { profileName: 'premium', version: 3 }, weight: 50 },
      ]),
      KEYS,
    )).not.toThrow();
  });

  it('omitting the catalog keeps the previous behaviour, so no unrelated caller breaks', () => {
    // The parameter is optional by design: ~40 call sites test unrelated rules, and a caller with no
    // catalog to hand should degrade rather than be unable to validate anything.
    expect(() => validateAndSanitizeExperiment(exp([
      { variantId: 'control', modelKey: 'sonnet', weight: 50 },
      { variantId: 'treatment', modelKey: 'not-a-model', weight: 50 },
    ]))).not.toThrow();
  });
});

describe('the catalog key set itself', () => {
  it('is non-empty and contains the seed models, so the check cannot pass vacuously', () => {
    // An empty set would make every key "unknown"; a set built from the wrong source would make every key
    // valid. Both would leave the test above green while enforcing nothing.
    expect(KEYS.size).toBeGreaterThan(1);
    expect(KEYS.has('sonnet')).toBe(true);
    expect(KEYS.has('haiku')).toBe(true);
    expect(KEYS.has('definitely-not-a-model')).toBe(false);
  });
});
