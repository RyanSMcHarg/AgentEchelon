/**
 * Experiment TYPES and LIFECYCLE — the rules a live experiment is resolved and governed by.
 *
 * The suite already covered the admin HANDLER (`admin-experiments.test.ts`) and the type-exclusion
 * CONFLICT gate (`experiment-manager.conflicts.test.ts`). What neither reached is the layer between
 * them: the per-TYPE input rules, the objective metric/type pairing, the status machine as a matrix,
 * and the resolve-time date window. Those decide whether an experiment ever serves traffic, and three
 * of the four experiment types (`intent`, `classification`, `profile`) had no direct test at all.
 *
 * Everything here is a PURE function, so this file is the layer that can be proven without a
 * deployment. The e2e specs drive `base_model` and `classification` end to end; `intent` and `profile`
 * are exercised here first, because a type that is wrong at validation never gets as far as an e2e.
 *
 * `startDate` gating is included deliberately: the operator guide records future-dated start dates as
 * *(not available)*, which is stale - `isLiveForClassification` has enforced it at resolve time since
 * L5. A doc marker is not a test, and this is the test.
 */
import {
  validateAndSanitizeExperiment,
  validateObjective,
  isAllowedTransition,
  isLiveForClassification,
  assignVariant,
  EXPERIMENT_TYPES,
  type Experiment,
  type ExperimentType,
} from '../../lambda/src/lib/experiment-manager';

/** Minimal valid input; per-type extras are layered on by each case. */
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  experimentId: 'exp-1',
  status: 'active',
  tiers: ['premium'],
  variants: [
    { variantId: 'control', modelKey: 'sonnet', weight: 50 },
    { variantId: 'treatment', modelKey: 'opus', weight: 50 },
  ],
  ...over,
});

const live = (over: Partial<Experiment> = {}): Experiment => ({
  experimentId: 'exp-1',
  status: 'active',
  tiers: ['premium'],
  variants: [{ variantId: 'control', modelKey: 'sonnet', weight: 100 }],
  ...over,
} as Experiment);

describe('experiment TYPE validation — every type, including the two with no e2e', () => {
  it('defaults to `intent` when the type is absent, matching the resolver and the admin form', () => {
    // Both `experimentType ?? 'intent'` in validation and the form's initial value. A default that
    // drifted from either would silently retype every programmatically-created experiment.
    const out = validateAndSanitizeExperiment(base({ intent: 'general' }) as never);
    expect(out.experimentType).toBe('intent');
  });

  it('rejects an intent experiment with no intent — the one type that scopes to one', () => {
    expect(() => validateAndSanitizeExperiment(base() as never))
      .toThrow(/intent experiments require a non-empty intent/i);
    // Whitespace is not an intent.
    expect(() => validateAndSanitizeExperiment(base({ intent: '   ' }) as never))
      .toThrow(/intent experiments require a non-empty intent/i);
  });

  it.each(['base_model', 'classification', 'profile'] as ExperimentType[])(
    'accepts %s without an intent (these apply across intents)',
    (experimentType) => {
      const out = validateAndSanitizeExperiment(base({ experimentType }) as never);
      expect(out.experimentType).toBe(experimentType);
    },
  );

  it('rejects an unknown experiment type rather than storing it unchecked', () => {
    expect(() => validateAndSanitizeExperiment(base({ experimentType: 'vibes' }) as never))
      .toThrow(/experimentType must be one of/i);
  });

  it('carries a profile variant`s profileRef through validation (Profile vs Profile)', () => {
    // `profile` swaps the WHOLE assistant version rather than one model key, so the variant carries a
    // profileRef instead of a modelKey. If validation dropped it, resolveVariantForProfile would find
    // nothing to resolve and the experiment would silently serve the default assistant.
    const out = validateAndSanitizeExperiment(base({
      experimentType: 'profile',
      variants: [
        { variantId: 'control', profileRef: { profileName: 'alpha', version: 3 }, weight: 50 },
        { variantId: 'treatment', profileRef: { profileName: 'beta' }, weight: 50 },
      ],
    }) as never);
    expect(out.variants[0].profileRef).toEqual({ profileName: 'alpha', version: 3 });
    // An omitted version means "the active one" and must stay omitted, not be defaulted to a number.
    expect(out.variants[1].profileRef).toEqual({ profileName: 'beta' });
  });

  it('EXPERIMENT_TYPES is the full set the rest of the system branches on', () => {
    // Guards against a fifth type being added to the union without the validator, the conflict rule,
    // or this suite learning about it.
    expect([...EXPERIMENT_TYPES].sort()).toEqual(['base_model', 'classification', 'intent', 'profile']);
  });
});

describe('objective metric x type pairing', () => {
  const objective = (metric: string) => ({ metric, target: 80 });

  it("rejects 'accuracy' on any type but classification", () => {
    for (const t of ['intent', 'base_model', 'profile'] as ExperimentType[]) {
      expect(() => validateObjective(objective('accuracy') as never, t))
        .toThrow(/'accuracy' applies only to a classification experiment/i);
    }
  });

  it("accepts 'accuracy' on classification", () => {
    expect(validateObjective(objective('accuracy') as never, 'classification')?.metric).toBe('accuracy');
  });

  it("rejects 'quality' on classification — it measures accuracy instead", () => {
    expect(() => validateObjective(objective('quality') as never, 'classification'))
      .toThrow(/measures 'accuracy', not 'quality'/i);
  });

  it.each(['cost', 'latency'] as const)('accepts %s on every type', (metric) => {
    for (const t of EXPERIMENT_TYPES) {
      expect(validateObjective(objective(metric) as never, t)?.metric).toBe(metric);
    }
  });

  it('rejects an unknown metric and an out-of-range target', () => {
    expect(() => validateObjective({ metric: 'vibes', target: 10 } as never, 'intent'))
      .toThrow(/objective.metric must be one of/i);
    for (const target of [-1, 101, Number.NaN]) {
      expect(() => validateObjective({ metric: 'cost', target } as never, 'intent'))
        .toThrow(/percentage in \[0, 100\]/i);
    }
  });

  it('an absent objective stays absent (advisory, never invented)', () => {
    expect(validateObjective(undefined, 'intent')).toBeUndefined();
  });
});

describe('lifecycle status machine', () => {
  const ALL = ['draft', 'active', 'paused', 'completed', 'deleted'] as const;

  it('allows the full intended path draft -> active -> paused -> active -> completed', () => {
    expect(isAllowedTransition('draft', 'active')).toBe(true);
    expect(isAllowedTransition('active', 'paused')).toBe(true);
    expect(isAllowedTransition('paused', 'active')).toBe(true);
    expect(isAllowedTransition('paused', 'completed')).toBe(true);
    expect(isAllowedTransition('active', 'completed')).toBe(true);
  });

  // THE rule the battle harness was broken by for a week: a completed experiment can never be
  // resumed, so any suite that arms a FIXED experiment id dies permanently the first time a run
  // completes it. Pinned here so the terminality is a stated contract, not folklore.
  it.each(ALL)('completed is terminal except for delete (to %s)', (to) => {
    expect(isAllowedTransition('completed', to)).toBe(to === 'deleted');
  });

  it.each(ALL)('deleted is fully terminal (to %s)', (to) => {
    expect(isAllowedTransition('deleted', to)).toBe(false);
  });

  it('a no-op same-state set is not a transition', () => {
    for (const s of ALL) expect(isAllowedTransition(s, s)).toBe(false);
  });
});

describe('resolve-time window (isLiveForClassification)', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const iso = (d: string) => new Date(d).toISOString();

  it('only an active experiment resolves traffic', () => {
    for (const status of ['draft', 'paused', 'completed', 'deleted'] as const) {
      expect(isLiveForClassification(live({ status }), 'premium', now)).toBe(false);
    }
    expect(isLiveForClassification(live(), 'premium', now)).toBe(true);
  });

  it('only a targeted classification resolves', () => {
    expect(isLiveForClassification(live({ tiers: ['premium'] }), 'standard', now)).toBe(false);
    expect(isLiveForClassification(live({ tiers: ['standard', 'premium'] }), 'standard', now)).toBe(true);
  });

  // The operator guide marks future-dated start dates *(not available)*. It IS enforced, here, at
  // resolve time. This test is what makes that claim checkable rather than a doc assertion.
  it('a FUTURE startDate is not live yet, and becomes live once passed', () => {
    const exp = live({ startDate: iso('2026-07-01T00:00:00Z') });
    expect(isLiveForClassification(exp, 'premium', now)).toBe(false);
    expect(isLiveForClassification(exp, 'premium', new Date('2026-07-02T00:00:00Z'))).toBe(true);
  });

  it('a past endDate stops resolving, and an absent window is live immediately', () => {
    expect(isLiveForClassification(live({ endDate: iso('2026-06-01T00:00:00Z') }), 'premium', now)).toBe(false);
    expect(isLiveForClassification(live({ endDate: iso('2026-12-01T00:00:00Z') }), 'premium', now)).toBe(true);
    expect(isLiveForClassification(live(), 'premium', now)).toBe(true);
  });

  it('rejects an unparseable date at WRITE time so it can never strand an experiment at read time', () => {
    // `new Date('nope') <= now` is a NaN compare, i.e. false: the row would store as active, resolve
    // nothing, and report no error anywhere. Cheaper to refuse the write.
    for (const field of ['startDate', 'endDate']) {
      expect(() => validateAndSanitizeExperiment(base({ intent: 'general', [field]: 'nope' }) as never))
        .toThrow(/is not a valid date/i);
    }
  });
});

describe('variant assignment', () => {
  const variants = [
    { variantId: 'control', modelKey: 'sonnet', weight: 50 },
    { variantId: 'treatment', modelKey: 'opus', weight: 50 },
  ];

  it('is deterministic for the same (experimentId, channel) — the A/B contract', () => {
    // A conversation must keep its variant for life; a non-deterministic assignment would silently
    // re-bucket a conversation mid-experiment and corrupt every result computed from it.
    const first = assignVariant('exp-1', 'arn:aws:chime:::channel/c1', variants as never);
    for (let i = 0; i < 25; i++) {
      expect(assignVariant('exp-1', 'arn:aws:chime:::channel/c1', variants as never).variantId)
        .toBe(first.variantId);
    }
  });

  it('splits across channels rather than pinning every conversation to one side', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(assignVariant('exp-1', `arn:aws:chime:::channel/c${i}`, variants as never).variantId);
    }
    expect([...seen].sort()).toEqual(['control', 'treatment']);
  });
});
