/**
 * Backward-compat invariant for context-aware routing
 * (SPEC-CONTEXT-AWARE-MODEL-ROUTING.md): with NO context extensions, resolveModelPlan must
 * return EXACTLY today's resolution — experiment-override-else-intent/classification — as a Bedrock plan.
 * This pins the phase-1 refactor so the unification can't silently change a single turn's model.
 */
import {
  getModelCatalog,
  INTENT_ROUTE_STRATEGY,
  DEFAULT_PROFILE_MODEL_SELECTION,
} from '../../lib/config/model-strategy';
import { resolveModelForIntent } from '../../lambda/src/lib/model-resolver';
import { resolveModelPlan } from '../../lambda/src/lib/resolve-model-plan';

const catalog = getModelCatalog('us-east-1', '123456789012');
const deps = { catalog, strategy: INTENT_ROUTE_STRATEGY, profileDefaults: DEFAULT_PROFILE_MODEL_SELECTION };

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
        const today = resolveModelForIntent(intent, classification, catalog, INTENT_ROUTE_STRATEGY, DEFAULT_PROFILE_MODEL_SELECTION);
        const plan = resolveModelPlan({ classification, intent }, deps);

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

describe('resolveModelPlan — experiment override (rule 1)', () => {
  it('experimentModelId wins on the primary, exactly like effectiveModel today', () => {
    const experimentModelId = 'us.anthropic.some-experiment-model-v1:0';
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', experimentModelId }, deps);
    expect(plan.ref.modelId).toBe(experimentModelId);
    // Fallback still comes from the intent/classification resolution (unchanged).
    const today = resolveModelForIntent('general', 'standard', catalog, INTENT_ROUTE_STRATEGY, DEFAULT_PROFILE_MODEL_SELECTION);
    expect(plan.fallback?.modelId ?? null).toBe(today.fallbackModelId);
  });
});

describe('resolveModelPlan — new signals are inert when routing is disabled', () => {
  it('a CN segment + consent does NOT change the plan when deps lack enabled/cnProvider', () => {
    const ctx = { classification: 'standard' as const, intent: 'general', segment: { country: 'CN' }, externalModelConsent: true };
    const withSeg = resolveModelPlan(ctx, deps); // deps has no `enabled`/`cnProvider`
    const without = resolveModelPlan({ classification: 'standard', intent: 'general' }, deps);
    expect(withSeg.ref.modelId).toBe(without.ref.modelId);
    expect(withSeg.ref.provider).toBe('bedrock');
  });
});

describe('resolveModelPlan — CN routing rule (enabled + external provider)', () => {
  const cnDeps = {
    ...deps,
    enabled: true,
    cnProvider: { provider: 'deepseek' as const, modelId: 'deepseek-chat' },
    externalConsentDefault: true,
  };

  it('zh user + consent default → routes to the external CN provider, Bedrock as fallback', () => {
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

  it('explicit consent=false blocks the external provider (stays Bedrock)', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh', externalModelConsent: false }, cnDeps);
    expect(plan.ref.provider).toBe('bedrock');
  });

  it('en + non-CN segment stays on Bedrock', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'en' }, cnDeps);
    expect(plan.ref.provider).toBe('bedrock');
  });

  it('disabled flag keeps a zh turn on Bedrock', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh' }, { ...cnDeps, enabled: false });
    expect(plan.ref.provider).toBe('bedrock');
  });

  it('consent default false (public phase) keeps a zh turn on Bedrock until the user opts in', () => {
    const plan = resolveModelPlan({ classification: 'standard', intent: 'general', userLanguage: 'zh' }, { ...cnDeps, externalConsentDefault: false });
    expect(plan.ref.provider).toBe('bedrock');
  });
});

describe('resolveModelPlan — DeepSeek-on-Bedrock CN routing (intent-routed, no consent gate)', () => {
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

  it('NO consent gate: zh turn routes to Bedrock DeepSeek even with externalModelConsent=false', () => {
    const plan = resolveModelPlan(
      { classification: 'standard', intent: 'report_generation', userLanguage: 'zh', externalModelConsent: false },
      cnDeps,
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
