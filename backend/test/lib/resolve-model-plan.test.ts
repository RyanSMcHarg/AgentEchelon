/**
 * Backward-compat invariant for context-aware routing
 * (SPEC-CONTEXT-AWARE-MODEL-ROUTING.md): with NO context extensions, resolveModelPlan must
 * return EXACTLY today's resolution — experiment-override-else-intent/classification — as a Bedrock plan.
 * This pins the phase-1 refactor so the unification can't silently change a single turn's model.
 */
import {
  getModelCatalog,
  INTENT_ROUTE_STRATEGY,
} from '../../lib/config/model-strategy';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { resolveModelForIntent } from '../../lambda/src/lib/model-resolver';
import { resolveModelPlan } from '../../lambda/src/lib/resolve-model-plan';

const catalog = getModelCatalog('us-east-1', '123456789012');
// Each classification's own selection; the standard one where a case names no other.
const deps = { catalog, strategy: INTENT_ROUTE_STRATEGY, models: profiles.modelsOf('standard') };

const TIERS = ['basic', 'standard', 'premium'] as const;
const INTENTS = [
  undefined,
  'general',
  'guided_troubleshooting',
  'data_extraction',
  'report_generation',
  'greeting',
  'acknowledgment',
] as const;

describe('resolveModelPlan — backward compatibility (empty context)', () => {
  for (const classification of TIERS) {
    for (const intent of INTENTS) {
      it(`classification=${classification} intent=${intent ?? 'none'} → matches resolveModelForIntent`, () => {
        const today = resolveModelForIntent(intent, classification, catalog, INTENT_ROUTE_STRATEGY, profiles.modelsOf(classification));
        const plan = resolveModelPlan({ classification, intent }, { ...deps, models: profiles.modelsOf(classification) });

        // The invocation input (model id) is the thing that must be identical.
        expect(plan.ref.modelId).toBe(today.primaryModelId);
        expect(plan.fallback?.modelId ?? null).toBe(today.fallbackModelId);

        // Phase-1 plan is always an in-AWS Bedrock plan with no tools and English working lang.
        expect(plan.ref.provider).toBe('bedrock');
        expect(plan.fallback?.provider ?? 'bedrock').toBe('bedrock');
        expect(plan.tools).toEqual([]);
        expect(plan.workingLanguage).toBe('en');
      });
    }
  }
});

describe('resolveModelPlan — a turn that continues live work', () => {
  it('carries continuesActiveWork into the intent resolution, so an acknowledgment that continues a task is answered on the general route', () => {
    // The generalized resolver must not be a cheaper door than the baseline one. A version that routes
    // standalone acknowledgments to Haiku and general work to Opus answers a continuation on Opus.
    const own = [
      { ...INTENT_ROUTE_STRATEGY[0], intent: 'acknowledgment' as never, primaryModel: 'haiku' as never, fallbackModel: 'haiku' as never },
      { ...INTENT_ROUTE_STRATEGY[0], intent: 'general' as never, primaryModel: 'opus' as never, fallbackModel: 'sonnet' as never },
    ];
    const ownDeps = { ...deps, strategy: own, models: profiles.modelsOf('premium') };
    const plan = resolveModelPlan(
      { classification: 'premium', intent: 'acknowledgment', continuesActiveWork: true },
      ownDeps,
    );
    const continued = resolveModelForIntent(
      'acknowledgment', 'premium', catalog, own, profiles.modelsOf('premium'),
      { continuesActiveWork: true },
    );
    const standalone = resolveModelPlan({ classification: 'premium', intent: 'acknowledgment' }, ownDeps);

    expect(plan.ref.modelId).toBe(continued.primaryModelId);
    expect(plan.ref.modelId).toBe(resolveModelForIntent('general', 'premium', catalog, own, profiles.modelsOf('premium')).primaryModelId);
    expect(standalone.ref.modelId).not.toBe(plan.ref.modelId);
  });
});

describe('resolveModelPlan — experiment override (rule 1)', () => {
  it('experimentModelId wins on the primary, exactly like effectiveModel today', () => {
    const experimentModelId = 'us.anthropic.some-experiment-model-v1:0';
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', experimentModelId }, deps);
    expect(plan.ref.modelId).toBe(experimentModelId);
    // Fallback still comes from the intent/classification resolution (unchanged).
    const today = resolveModelForIntent('general', 'standard', catalog, INTENT_ROUTE_STRATEGY, profiles.modelsOf('standard'));
    expect(plan.fallback?.modelId ?? null).toBe(today.fallbackModelId);
  });
});

describe('resolveModelPlan — new signals are inert when routing is disabled', () => {
  it('a CN segment does NOT change the plan when deps lack enabled/cnProvider, even with the version allowing it', () => {
    const ctx = { classification: 'standard' as const, intent: 'general', segment: { country: 'CN' } };
    const withSeg = resolveModelPlan(ctx, { ...deps, externalProviderSelected: true }); // no `enabled`/`cnProvider`
    const without = resolveModelPlan({ classification: 'standard', intent: 'general' }, deps);
    expect(withSeg.ref.modelId).toBe(without.ref.modelId);
    expect(withSeg.ref.provider).toBe('bedrock');
  });
});

describe('resolveModelPlan — CN routing rule (enabled + external provider, allowed by the answering version)', () => {
  const cnDeps = {
    ...deps,
    enabled: true,
    cnProvider: { provider: 'deepseek' as const, modelId: 'deepseek-chat' },
    externalProviderSelected: true,
  };

  it('zh user + the answering version allows it → routes to the external CN provider, Bedrock as fallback', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh' }, cnDeps);
    expect(plan.ref.provider).toBe('deepseek');
    expect(plan.ref.modelId).toBe('deepseek-chat');
    expect(plan.fallback?.provider).toBe('bedrock');
    expect(plan.workingLanguage).toBe('zh');
  });

  it('CN request segment (even with en) → routes to the external CN provider', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'en', segment: { country: 'CN' } }, cnDeps);
    expect(plan.ref.provider).toBe('deepseek');
  });

  it('an allowed external route is not marked withheld', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh' }, cnDeps);
    expect(plan.externalProviderWithheld).toBeUndefined();
  });

  it('en + non-CN segment stays on Bedrock', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'en' }, cnDeps);
    expect(plan.ref.provider).toBe('bedrock');
  });

  it('disabled flag keeps a zh turn on Bedrock', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh' }, { ...cnDeps, enabled: false });
    expect(plan.ref.provider).toBe('bedrock');
  });

});

describe('resolveModelPlan — the external provider is closed unless the answering version allows it', () => {
  const configured = {
    ...deps,
    enabled: true,
    cnProvider: { provider: 'deepseek' as const, modelId: 'deepseek-chat' },
  };
  const baseline = resolveModelPlan({ classification: 'standard', intent: 'general' }, deps);

  it('ABSENT (every seed, every version before the field) keeps a zh turn on the Bedrock baseline', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh' }, configured);
    expect(plan.ref.provider).toBe('bedrock');
    expect(plan.ref.modelId).toBe(baseline.ref.modelId);
    expect(plan.fallback?.modelId).toBe(baseline.fallback?.modelId);
    expect(plan.workingLanguage).toBe('en');
    expect(plan.externalProviderWithheld).toBe(true);
  });

  it('FALSE keeps a zh turn and a CN-segment turn on Bedrock, marked withheld', () => {
    const off = { ...configured, externalProviderSelected: false };
    const zh = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh' }, off);
    const cn = resolveModelPlan({ classification: 'standard', intent: 'general', segment: { country: 'CN' } }, off);
    for (const plan of [zh, cn]) {
      expect(plan.ref.provider).toBe('bedrock');
      expect(plan.ref.modelId).toBe(baseline.ref.modelId);
      expect(plan.externalProviderWithheld).toBe(true);
    }
  });

  it('a non-Chinese turn is not marked withheld, because rule 2b never applied to it', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'en' }, configured);
    expect(plan.ref.provider).toBe('bedrock');
    expect(plan.externalProviderWithheld).toBeUndefined();
  });

  it('no configured provider means nothing is withheld, even for a zh turn', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh' }, { ...deps, enabled: true });
    expect(plan.externalProviderWithheld).toBeUndefined();
  });

  it('an end-user consent field, if a caller still sent one, opens nothing', () => {
    // The per-person flag is gone from RoutingContext; a stale caller is a type error, and at runtime it is ignored.
    const ctx = { classification: 'standard' as const, intent: 'general', userLanguage: 'zh', externalModelConsent: true } as never;
    const plan = resolveModelPlan(ctx, configured);
    expect(plan.ref.provider).toBe('bedrock');
  });
});

describe('resolveModelPlan — DeepSeek-on-Bedrock CN routing (intent-routed, no external-provider gate)', () => {
  const cnBedrock = {
    chatModelId: 'deepseek.v3.2',
    reasoningModelId: 'us.deepseek.r1-v1:0',
    reasoningIntents: ['report_generation', 'data_extraction', 'guided_troubleshooting'],
  };
  const cnDeps = { ...deps, enabled: true, cnBedrock };

  it('zh turn + reasoning intent → R1 (provider bedrock, reasoning=true)', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'report_generation', userLanguage: 'zh' }, cnDeps);
    expect(plan.ref.provider).toBe('bedrock');
    expect(plan.ref.modelId).toBe('us.deepseek.r1-v1:0');
    expect(plan.reasoning).toBe(true);
    expect(plan.workingLanguage).toBe('zh');
  });

  it('CN segment (even en) + non-reasoning intent → V3 (reasoning=false)', () => {
    const plan = resolveModelPlan(
      { classification: 'standard', intent: 'general', userLanguage: 'en', segment: { country: 'CN' } },
      cnDeps,
    );
    expect(plan.ref.modelId).toBe('deepseek.v3.2');
    expect(plan.reasoning).toBeFalsy();
  });

  it('NO external-provider gate: zh turn routes to Bedrock DeepSeek even when the version does not allow an external provider', () => {
    const plan = resolveModelPlan(
      { classification: 'standard', intent: 'report_generation', userLanguage: 'zh' },
      { ...cnDeps, externalProviderSelected: false },
    );
    expect(plan.ref.modelId).toBe('us.deepseek.r1-v1:0');
  });

  it('Bedrock CN wins over a configured external provider', () => {
    const plan = resolveModelPlan(
      { classification: 'standard', intent: 'general', userLanguage: 'zh' },
      { ...cnDeps, cnProvider: { provider: 'deepseek' as const, modelId: 'deepseek-chat' } },
    );
    expect(plan.ref.provider).toBe('bedrock');
    expect(plan.ref.modelId).toBe('deepseek.v3.2');
  });

  it('en + non-CN turn stays on the classification-default Bedrock model', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'report_generation', userLanguage: 'en' }, cnDeps);
    expect(plan.ref.modelId).not.toBe('us.deepseek.r1-v1:0');
    expect(plan.ref.modelId).not.toBe('deepseek.v3.2');
  });

  it('disabled flag keeps a zh reasoning turn on the default Bedrock model', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'report_generation', userLanguage: 'zh' }, { ...cnDeps, enabled: false });
    expect(plan.ref.modelId).not.toBe('us.deepseek.r1-v1:0');
  });
});
