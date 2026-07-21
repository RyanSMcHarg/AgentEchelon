/**
 * SPEC-PORTABLE-VERSIONED-PROFILES P0 — active profile resolution.
 *
 * The load-bearing guarantees: (1) seed byte-identical (behavior diff empty), (2) fail-closed to seed
 * on absent/corrupt versions, (3) the §7 cut — a version overrides ONLY runtime-editable fields, never
 * the boundary (contextScope), (4) TTL caching, (5) stable version fingerprint.
 */
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  resolveActiveProfile,
  serializeSeedDefinition,
  profileDefinitionConfigId,
  definitionParamName,
  buildIntentStrategy,
  concreteModel,
  ensureModelsBundle,
  validateDefinitionBody,
  DEFAULT_MODEL,
  __clearActiveProfileCache,
  PROFILE_DEFINITION_SCHEMA_VERSION,
} from '../../lambda/src/lib/active-profile';
import { ALL_TOOL_NAMES } from '../../lambda/src/lib/tool-registry';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { DEFAULT_PROFILE_MODEL_SELECTION, INTENT_ROUTE_STRATEGY, getModelCatalog } from '../../lib/config/model-strategy';
import { resolveModelForIntent } from '../../lambda/src/lib/model-resolver';

const SSM_ROOT = '/agent-echelon';

/** A fake SSMClient: `send` returns whatever the queued handler yields for the requested param name. */
function fakeSsm(handler: (name: string) => { Parameter?: { Value?: string } } | Promise<never>) {
  return {
    send: jest.fn(async (cmd: GetParameterCommand) => {
      const name = (cmd.input as { Name?: string }).Name || '';
      return handler(name);
    }),
  } as unknown as import('@aws-sdk/client-ssm').SSMClient;
}

function notFound(): never {
  const e = new Error('not found') as Error & { name: string };
  e.name = 'ParameterNotFound';
  throw e;
}

beforeEach(() => __clearActiveProfileCache());

describe('active-profile P0 resolution', () => {
  it('falls back to the compiled seed when no active version exists (behavior diff empty)', async () => {
    const ssm = fakeSsm(() => notFound());
    const { profile, configId } = await resolveActiveProfile('standard', { ssm, ssmRoot: SSM_ROOT });
    expect(profile).toEqual(defaultProfileRegistry.profileByName('standard'));
    expect(configId).toBe('seed');
  });

  it('reads /assistant/{name}/definition by the :active label', async () => {
    const seen: string[] = [];
    const ssm = fakeSsm((name) => {
      seen.push(name);
      return notFound();
    });
    await resolveActiveProfile('premium', { ssm, ssmRoot: SSM_ROOT });
    expect(seen).toEqual([`${definitionParamName(SSM_ROOT, 'premium')}:active`]);
  });

  it('seed definition round-trips to a byte-identical profile', async () => {
    const raw = serializeSeedDefinition('standard')!;
    const ssm = fakeSsm((name) =>
      name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound(),
    );
    const { profile, configId } = await resolveActiveProfile('standard', { ssm, ssmRoot: SSM_ROOT });
    // The seed version, once activated, yields exactly the compiled profile.
    expect(profile).toEqual(defaultProfileRegistry.profileByName('standard'));
    expect(configId).toBe(JSON.parse(raw).configId);
    expect(configId).not.toBe('seed');
  });

  it('an active version overrides RUNTIME-EDITABLE fields but NOT the boundary (contextScope from seed)', async () => {
    const seed = defaultProfileRegistry.profileByName('basic')!;
    const def = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'basic',
      modelKey: 'sonnet', // was 'haiku'
      classifierMode: 'keyword', // was 'llm'
      timeoutSeconds: 45,
      taskSupport: 'lightweight',
      rateLimitPerHour: 5,
      battleEligible: true,
      // A HOSTILE attempt to widen the boundary — must be ignored by the resolver.
      contextScope: 'own-rank-and-above',
      configId: 'deadbeef0000',
    };
    const ssm = fakeSsm((name) =>
      name.endsWith(':active') ? { Parameter: { Value: JSON.stringify(def) } } : notFound(),
    );
    const { profile } = await resolveActiveProfile('basic', { ssm, ssmRoot: SSM_ROOT });
    // Runtime-editable fields came from the version:
    expect(profile.modelKey).toBe('sonnet');
    expect(profile.classifierMode).toBe('keyword');
    expect(profile.timeoutSeconds).toBe(45);
    expect(profile.taskSupport).toBe('lightweight');
    expect(profile.rateLimitPerHour).toBe(5);
    expect(profile.battleEligible).toBe(true);
    // Boundary + identity stayed from the seed — the hostile contextScope is ignored:
    expect(profile.contextScope).toBe(seed.contextScope);
    expect(profile.name).toBe('basic');
  });

  it('fails closed to the seed on a malformed / invalid definition', async () => {
    const cases = [
      'not json at all',
      JSON.stringify({ schemaVersion: 99, profileName: 'standard', modelKey: 'x' }),
      JSON.stringify({ schemaVersion: 1, profileName: 'WRONG', modelKey: 'x', classifierMode: 'llm', timeoutSeconds: 1, taskSupport: 'full' }),
      JSON.stringify({ schemaVersion: 1, profileName: 'standard', classifierMode: 'llm', timeoutSeconds: 1, taskSupport: 'full' }), // no modelKey
    ];
    for (const raw of cases) {
      __clearActiveProfileCache();
      const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
      const { profile, configId } = await resolveActiveProfile('standard', { ssm, ssmRoot: SSM_ROOT });
      expect(profile).toEqual(defaultProfileRegistry.profileByName('standard'));
      expect(configId).toBe('seed');
    }
  });

  it('caches within the TTL and re-reads after it expires', async () => {
    let clock = 1000;
    const ssm = fakeSsm(() => notFound());
    const opts = { ssm, ssmRoot: SSM_ROOT, ttlMs: 100, now: () => clock };
    await resolveActiveProfile('standard', opts);
    await resolveActiveProfile('standard', opts);
    expect((ssm.send as jest.Mock).mock.calls.length).toBe(1); // second was cached
    clock += 200; // TTL expired
    await resolveActiveProfile('standard', opts);
    expect((ssm.send as jest.Mock).mock.calls.length).toBe(2);
  });

  it('DECOUPLE is behavior-neutral on the seed: each seed modelKey == the deploy-default selection', () => {
    // The async-processor overrides the base model selection with the active version's modelKey. On the
    // seed (fail-closed), that override must equal DEFAULT_PROFILE_MODEL_SELECTION so the resolved base
    // model is byte-identical to today. This is the P0 "behavior diff empty on the seed" acceptance.
    for (const name of ['basic', 'standard', 'premium'] as const) {
      const seedModelKey = defaultProfileRegistry.profileByName(name)!.modelKey;
      expect(seedModelKey).toBe(DEFAULT_PROFILE_MODEL_SELECTION[name]);
      const baseSelection = { ...DEFAULT_PROFILE_MODEL_SELECTION, [name]: seedModelKey };
      expect(baseSelection).toEqual(DEFAULT_PROFILE_MODEL_SELECTION);
    }
  });

  it('configId is stable and body-derived (order-independent)', () => {
    const a = profileDefinitionConfigId({ modelKey: 'opus', classifierMode: 'llm', timeoutSeconds: 90, taskSupport: 'full', rateLimitPerHour: 240, battleEligible: true });
    const b = profileDefinitionConfigId({ battleEligible: true, rateLimitPerHour: 240, taskSupport: 'full', timeoutSeconds: 90, classifierMode: 'llm', modelKey: 'opus' });
    expect(a).toBe(b);
    const c = profileDefinitionConfigId({ modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 90, taskSupport: 'full', rateLimitPerHour: 240, battleEligible: true });
    expect(c).not.toBe(a);
  });
});

describe('U2 — per-profile intent routing is byte-identical to the global strategy', () => {
  const catalog = getModelCatalog('us-east-1', '000000000000');
  const CLASSIFICATIONS = ['basic', 'standard', 'premium'] as const;
  // Representative raw intents (mapped to route keys inside resolveModelForIntent) + the no-intent case.
  const INTENTS: (string | undefined)[] = [
    'report_generation', 'data_extraction', 'guided_troubleshooting', 'general_query',
    'greeting', 'code_generation', 'analysis', 'unknown_intent', undefined,
  ];

  it('rebuilds the global strategy from a seeded profile (identical model triples)', () => {
    const def = JSON.parse(serializeSeedDefinition('premium')!);
    const rebuilt = buildIntentStrategy(def.models)!;
    expect(rebuilt).not.toBeNull();
    expect(rebuilt.length).toBe(INTENT_ROUTE_STRATEGY.length);
    for (const r of INTENT_ROUTE_STRATEGY) {
      const rr = rebuilt.find((x) => x.intent === r.intent)!;
      expect(rr).toBeDefined();
      expect(rr.primaryModel).toBe(r.primaryModel);
      expect(rr.fallbackModel).toBe(r.fallbackModel);
    }
  });

  it('resolveModelForIntent is identical via the profile strategy vs the global strategy, every profile+intent', () => {
    for (const classification of CLASSIFICATIONS) {
      const name = defaultProfileRegistry.profileFor(classification).name;
      const def = JSON.parse(serializeSeedDefinition(name)!);
      const profileStrategy = buildIntentStrategy(def.models)!;
      for (const intent of INTENTS) {
        const viaProfile = resolveModelForIntent(intent, classification, catalog as any, profileStrategy, DEFAULT_PROFILE_MODEL_SELECTION);
        const viaGlobal = resolveModelForIntent(intent, classification, catalog as any, INTENT_ROUTE_STRATEGY, DEFAULT_PROFILE_MODEL_SELECTION);
        expect(viaProfile).toEqual(viaGlobal);
      }
    }
  });

  it('a profile with no byIntent yields null so the caller falls back to the global strategy', () => {
    expect(buildIntentStrategy(undefined)).toBeNull();
    expect(buildIntentStrategy({ default: 'sonnet' })).toBeNull();
    expect(buildIntentStrategy({ default: 'sonnet', byIntent: {} })).toBeNull();
  });
});

describe("the classifier default is stored EXPLICITLY as the 'default' sentinel (not absent, not pinned)", () => {
  it("seeds every profile's classifier as 'default'", () => {
    for (const name of ['basic', 'standard', 'premium']) {
      const def = JSON.parse(serializeSeedDefinition(name)!);
      // Explicit, visible — never absent…
      expect(def.models.classifier).toBe(DEFAULT_MODEL);
      // …and never materialized to a concrete catalog key (that would pin it, defeating the tracking).
      expect(def.models.classifier).not.toBe('haiku');
    }
  });

  it('resolves a seed profile to the seed base model (classifier sentinel does not disturb resolution)', async () => {
    const raw = serializeSeedDefinition('standard')!;
    const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
    const { profile } = await resolveActiveProfile('standard', { ssm, ssmRoot: SSM_ROOT });
    expect(profile.modelKey).toBe(defaultProfileRegistry.profileByName('standard')!.modelKey);
  });

  it("treats a base of 'default' as inherit-the-classification-default (concreteModel skips the sentinel)", () => {
    expect(concreteModel(DEFAULT_MODEL)).toBeUndefined();
    expect(concreteModel(undefined)).toBeUndefined();
    expect(concreteModel('')).toBeUndefined();
    expect(concreteModel('sonnet')).toBe('sonnet');
  });

  it('backfills a COMPLETE models bundle onto a legacy (pre-U2) body so export/edit has real values', () => {
    // A definition activated before the models bundle existed: bare modelKey, no models/tools.
    const legacy = { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 60, taskSupport: 'full' } as never;
    const full = ensureModelsBundle(legacy);
    expect(full.models?.default).toBe('sonnet'); // from the body's own base model
    expect(full.models?.classifier).toBe(DEFAULT_MODEL); // explicit sentinel, not absent
    expect(Object.keys(full.models?.byIntent ?? {}).length).toBeGreaterThan(0); // seeded per-intent strategy
    expect(full.modelKey).toBe('sonnet'); // untouched
  });

  it('is idempotent — a body that already carries a populated byIntent is returned unchanged', () => {
    const already = {
      modelKey: 'opus',
      models: { default: 'opus', classifier: 'haiku', byIntent: { general_qa: { primary: 'haiku' } } },
      classifierMode: 'llm', timeoutSeconds: 60, taskSupport: 'full',
    } as never;
    const out = ensureModelsBundle(already);
    expect(out.models?.byIntent).toEqual({ general_qa: { primary: 'haiku' } });
    expect(out.models?.classifier).toBe('haiku'); // not overwritten by the sentinel
  });

  it('backfills the full tool registry onto a legacy body and preserves an explicit tools list', () => {
    const legacy = { modelKey: 'sonnet', classifierMode: 'llm' as const, timeoutSeconds: 60, taskSupport: 'full' as const };
    expect(ensureModelsBundle(legacy).tools).toEqual(ALL_TOOL_NAMES);
    expect(ensureModelsBundle({ ...legacy, tools: ['advance_task_state'] }).tools).toEqual(['advance_task_state']);
  });

  it("drops a per-intent route whose primary is 'default' (falls back to base for that intent)", () => {
    const strat = buildIntentStrategy({
      byIntent: {
        general_qa: { primary: DEFAULT_MODEL },        // sentinel ⇒ dropped
        code_generation: { primary: 'sonnet', fallback: DEFAULT_MODEL }, // fallback sentinel ⇒ collapses to primary
      },
    })!;
    expect(strat.find((r) => r.intent === 'general_qa')).toBeUndefined();
    const code = strat.find((r) => r.intent === 'code_generation')!;
    expect(code.primaryModel).toBe('sonnet');
    expect(code.fallbackModel).toBe('sonnet');
  });
});

describe('tools are PER-PROFILE (SPEC-ASSISTANT-CONFIG §4)', () => {
  it('seeds every profile with the full tool registry (explicit + editable, byte-behaviour-identical)', () => {
    for (const name of ['basic', 'standard', 'premium']) {
      const def = JSON.parse(serializeSeedDefinition(name)!);
      expect(def.tools).toEqual(ALL_TOOL_NAMES);
      expect(def.tools.length).toBeGreaterThan(0);
    }
  });

  it('accepts a known-tool subset and REJECTS an unknown tool name', () => {
    const base = { modelKey: 'sonnet', classifierMode: 'llm' as const, timeoutSeconds: 60, taskSupport: 'full' as const };
    expect(validateDefinitionBody({ ...base, tools: ['advance_task_state', 'load_company_context'] })).toEqual([]);
    const errs = validateDefinitionBody({ ...base, tools: ['advance_task_state', 'make_coffee'] });
    expect(errs.some((e) => /unknown tool/.test(e) && /make_coffee/.test(e))).toBe(true);
  });

  it('resolveActiveProfile surfaces the active version tools allowlist (undefined on the seed fallback)', async () => {
    const raw = serializeSeedDefinition('standard')!;
    const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
    const active = await resolveActiveProfile('standard', { ssm, ssmRoot: SSM_ROOT });
    expect(active.tools).toEqual(ALL_TOOL_NAMES);

    __clearActiveProfileCache();
    const noVersion = await resolveActiveProfile('standard', { ssm: fakeSsm(() => notFound()), ssmRoot: SSM_ROOT });
    expect(noVersion.tools).toBeUndefined(); // ⇒ loop offers all runtime-available tools (legacy behavior)
  });
});
