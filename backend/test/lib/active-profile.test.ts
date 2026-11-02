/**
 * SPEC-PORTABLE-PROFILES P0 — active profile resolution.
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
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_FALLBACK_MODEL,
  __clearActiveProfileCache,
  PROFILE_DEFINITION_SCHEMA_VERSION,
  resolveFromDefinition,
  classificationOfProfile,
} from '../../lambda/src/lib/active-profile';
import { ALL_TOOL_NAMES } from '../../lambda/src/lib/tool-registry';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { modelFits } from '../../lib/config/model-availability';
import { resolveTurnImageRoute } from '../../lambda/src/lib/async-processor-core';
import { INTENT_ROUTE_STRATEGY, getModelCatalog } from '../../lib/config/model-strategy';
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
    const { profile, configId } = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    expect(profile).toEqual(defaultProfileRegistry.profileByName('analyst'));
    expect(configId).toBe('seed');
  });

  it('reads /assistant/{name}/definition by the :active label', async () => {
    const seen: string[] = [];
    const ssm = fakeSsm((name) => {
      seen.push(name);
      return notFound();
    });
    await resolveActiveProfile('advisor', { ssm, ssmRoot: SSM_ROOT });
    expect(seen).toEqual([`${definitionParamName(SSM_ROOT, 'advisor')}:active`]);
  });

  it('seed definition round-trips to a byte-identical profile', async () => {
    const raw = serializeSeedDefinition('analyst')!;
    const ssm = fakeSsm((name) =>
      name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound(),
    );
    const { profile, configId } = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    // The seed version, once activated, yields exactly the compiled profile.
    expect(profile).toEqual(defaultProfileRegistry.profileByName('analyst'));
    expect(configId).toBe(JSON.parse(raw).configId);
    expect(configId).not.toBe('seed');
  });

  it('surfaces the active version PERSONA so it rides the versioned definition (SPEC-PORTABLE §5)', async () => {
    const persona = 'You are Ada, a meticulous research assistant. Cite sources.';
    const def = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      modelKey: 'sonnet',
      classifierMode: 'llm',
      timeoutSeconds: 30,
      taskSupport: 'full',
      persona,
      configId: 'persona00test',
    };
    const ssm = fakeSsm((name) =>
      name.endsWith(':active') ? { Parameter: { Value: JSON.stringify(def) } } : notFound(),
    );
    const resolved = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    expect(resolved.persona).toBe(persona); // the worker prefers this over the deployment persona seam
  });

  it('validateDefinitionBody accepts a persona and rejects an over-long one', async () => {
    const base = { modelKey: 'sonnet', classifierMode: 'llm' as const, timeoutSeconds: 30, taskSupport: 'full' as const };
    expect(validateDefinitionBody({ ...base, persona: 'A concise persona.' })).toEqual([]);
    const tooLong = 'x'.repeat(20001);
    expect(validateDefinitionBody({ ...base, persona: tooLong }).some((e) => e.includes('persona'))).toBe(true);
  });

  it('an active version overrides RUNTIME-EDITABLE fields but NOT the boundary (contextScope from seed)', async () => {
    const seed = defaultProfileRegistry.profileByName('concierge')!;
    const def = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'concierge',
      modelKey: 'sonnet', // was 'haiku'
      tools: ['add_item'],
      // DEPLOYMENT-TIME fields a legacy version still carries. Stored, tolerated, and read by nothing:
      // the resolver takes each from the seed, so a version cannot claim any of them.
      classifierMode: 'keyword', // seed says 'llm'
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
    const { profile, tools } = await resolveActiveProfile('concierge', { ssm, ssmRoot: SSM_ROOT });
    // Runtime-editable fields came from the version:
    expect(profile.modelKey).toBe('sonnet');
    expect(tools).toEqual(['add_item']);
    // Deployment-time fields stayed from the seed, whatever the version says:
    expect(profile.classifierMode).toBe(seed.classifierMode);
    expect(profile.timeoutSeconds).toBe(seed.timeoutSeconds);
    expect(profile.rateLimitPerHour).toBe(seed.rateLimitPerHour);
    // Boundary + identity stayed from the seed — the hostile contextScope is ignored:
    expect(profile.contextScope).toBe(seed.contextScope);
    expect(profile.name).toBe('concierge');
  });

  it(`DROPS a version's task machines, because workflows are global`, async () => {
    // This asserted the opposite: that a version's own machines reached the resolved result, so an
    // assistant could redefine a task graph for itself. That is the capability the global-workflows
    // decision removes. A graph decides what states exist, which moves are legal and when a person is
    // awaited, so an assistant running its own report_generation was running a different contract
    // under a shared name - "manage this work" meant different things depending on who was asked.
    //
    // Dropped on READ rather than only refused on write, so a version stored before the decision
    // normalizes away instead of quietly out-ranking the platform graphs for the life of that version.
    const machines = {
      report_generation: {
        initial: 'start',
        states: { start: { transitions: ['done'] }, done: { transitions: [], terminal: 'success' } },
      },
    };
    const def = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      modelKey: 'sonnet',
      classifierMode: 'llm',
      timeoutSeconds: 60,
      taskSupport: 'full',
      machines,
      configId: 'aa11bb22cc33',
    };
    const ssm = fakeSsm((name) =>
      name.endsWith(':active') ? { Parameter: { Value: JSON.stringify(def) } } : notFound(),
    );
    const resolved = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    // The resolved profile no longer carries the field at all (ADR-047), which is stronger than it
    // being undefined: a version's task graphs cannot reach a turn even by accident.
    expect('machines' in resolved).toBe(false);
    // The rest of the version still resolves - this narrows one field, it does not reject the version.
    expect(resolved.configId).toEqual('aa11bb22cc33');
  });

  it('SERVES a version carrying an invalid machine, because the field is inert now', async () => {
    // THIS USED TO FAIL CLOSED TO THE SEED, and it must not any more. The rule protected against a
    // hostile or malformed version seeding an invalid lifecycle that would strand tasks - a real risk
    // while a version's machines reached the runtime. They no longer do (global workflows, 2026-09-20):
    // `bodyFrom` drops the field, so an invalid machine on a version is INERT and cannot strand
    // anything.
    //
    // Discarding the version for it would now be the destructive option, not the safe one: the whole
    // definition - persona, models, tools - would be replaced by the compiled seed over a field that
    // is ignored. So the version serves, and the bad block is simply not there.
    const def = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      modelKey: 'sonnet',
      classifierMode: 'llm',
      timeoutSeconds: 60,
      taskSupport: 'full',
      machines: { report_generation: { initial: 'nope', states: { start: { transitions: [] } } } },
      configId: 'bad0bad0bad0',
    };
    const ssm = fakeSsm((name) =>
      name.endsWith(':active') ? { Parameter: { Value: JSON.stringify(def) } } : notFound(),
    );
    const resolved = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    expect(resolved.configId).toBe('bad0bad0bad0');
    // The resolved profile no longer carries the field at all (ADR-047), which is stronger than it
    // being undefined: a version's task graphs cannot reach a turn even by accident.
    expect('machines' in resolved).toBe(false);
  });

  it('fails closed to the seed on a malformed / invalid definition', async () => {
    const cases = [
      'not json at all',
      JSON.stringify({ schemaVersion: 99, profileName: 'analyst', modelKey: 'x' }),
      JSON.stringify({ schemaVersion: 1, profileName: 'WRONG', modelKey: 'x', classifierMode: 'llm', timeoutSeconds: 1, taskSupport: 'full' }),
      JSON.stringify({ schemaVersion: 1, profileName: 'analyst', classifierMode: 'llm', timeoutSeconds: 1, taskSupport: 'full' }), // no modelKey
    ];
    for (const raw of cases) {
      __clearActiveProfileCache();
      const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
      const { profile, configId } = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
      expect(profile).toEqual(defaultProfileRegistry.profileByName('analyst'));
      expect(configId).toBe('seed');
    }
  });

  it('caches within the TTL and re-reads after it expires', async () => {
    let clock = 1000;
    const ssm = fakeSsm(() => notFound());
    const opts = { ssm, ssmRoot: SSM_ROOT, ttlMs: 100, now: () => clock };
    await resolveActiveProfile('analyst', opts);
    await resolveActiveProfile('analyst', opts);
    expect((ssm.send as jest.Mock).mock.calls.length).toBe(1); // second was cached
    clock += 200; // TTL expired
    await resolveActiveProfile('analyst', opts);
    expect((ssm.send as jest.Mock).mock.calls.length).toBe(2);
  });

  it('DECOUPLE is behavior-neutral on the seed: each seed modelKey is the default model of its classification', () => {
    // The async-processor serves the active version's modelKey as the classification's default. On the seed
    // (fail-closed) that is the classification's own declared default, so the resolved base model is unchanged.
    for (const classification of ['basic', 'standard', 'premium'] as const) {
      const seedModelKey = defaultProfileRegistry.requireProfileFor(classification).modelKey;
      expect(seedModelKey).toBe(defaultProfileRegistry.defaultModelOf(classification));
    }
  });

  it('configId is stable and body-derived (order-independent)', () => {
    const a = profileDefinitionConfigId({ modelKey: 'opus', tools: ['add_item'], guardrailId: 'strict' });
    const b = profileDefinitionConfigId({ guardrailId: 'strict', tools: ['add_item'], modelKey: 'opus' });
    expect(a).toBe(b);
    const c = profileDefinitionConfigId({ modelKey: 'sonnet', tools: ['add_item'], guardrailId: 'strict' });
    expect(c).not.toBe(a);
  });

  it('changes when only the deployment wording changes', () => {
    // `copy` is on the body and `bodyFrom` keeps it, but it was absent from the hashed key list, so
    // a copy-only edit produced the SAME configId and the new version was attributed in analytics to
    // the one it replaced. A deployment that reworded its queue notice could not tell them apart.
    const base = { modelKey: 'opus' };
    const quiet = profileDefinitionConfigId({ ...base, copy: { queueSettled: 'Caught up.' } });
    const chatty = profileDefinitionConfigId({ ...base, copy: { queueSettled: 'All caught up now!' } });

    expect(quiet).not.toBe(chatty);
  });
});

describe('a seed says what it serves: the platform routes, with each route the retired floor raised written as the base model', () => {
  const catalog = getModelCatalog('us-east-1', '000000000000');
  const CLASSIFICATIONS = ['basic', 'standard', 'premium'] as const;
  // Representative raw intents (mapped to route keys inside resolveModelForIntent) + the no-intent case.
  const INTENTS: (string | undefined)[] = [
    'report_generation', 'data_extraction', 'guided_troubleshooting', 'general_query',
    'greeting', 'code_generation', 'analysis', 'unknown_intent', undefined,
  ];

  it('a premium seed writes each route cheaper than its base as the base, and keeps the fallbacks', () => {
    const def = JSON.parse(serializeSeedDefinition('advisor')!);
    const base = def.models.default as string;
    const rebuilt = buildIntentStrategy(def.models)!;
    for (const r of INTENT_ROUTE_STRATEGY) {
      const rr = rebuilt.find((x) => x.intent === r.intent);
      if (!rr) continue; // a route the classification cannot use is not seeded
      const cheaper = ({ low: 0, medium: 1, high: 2 } as const)[(catalog as any)[r.primaryModel].costClass as 'low']
        < ({ low: 0, medium: 1, high: 2 } as const)[(catalog as any)[base].costClass as 'low'];
      expect({ intent: r.intent, primary: rr.primaryModel }).toEqual({ intent: r.intent, primary: cheaper ? base : r.primaryModel });
    }
    // A standalone greeting and acknowledgment keep the route they were answered on.
    expect(def.models.byIntent.greeting?.primary).toBe(INTENT_ROUTE_STRATEGY.find((r) => r.intent === 'general')!.primaryModel);
  });

  it('a seeded version answers each intent on the model the retired floor served it on', () => {
    // A SEED PRESELECTS ONLY WHAT ITS CLASSIFICATION ALLOWS, so a route whose global primary the
    // classification cannot use is not seeded; the global path degrades that same route to the
    // classification default, so the answering model is the same either way. A fallback is only ever one
    // the classification allows.
    for (const classification of CLASSIFICATIONS) {
      const name = defaultProfileRegistry.requireProfileFor(classification).name;
      const def = JSON.parse(serializeSeedDefinition(name)!);
      const profileStrategy = buildIntentStrategy(def.models)!;
      for (const intent of INTENTS) {
        const viaProfile = resolveModelForIntent(intent, classification, catalog as any, profileStrategy, defaultProfileRegistry.modelsOf(classification));
        // WHAT THE RETIRED FLOOR SERVED: the global route as written, raised to the classification base when
        // it was cheaper, except on a standalone greeting or acknowledgment.
        const viaGlobal = resolveModelForIntent(intent, classification, catalog as any, INTENT_ROUTE_STRATEGY, defaultProfileRegistry.modelsOf(classification));
        const base = (catalog as any)[defaultProfileRegistry.defaultModelOf(classification)!];
        const rank = { low: 0, medium: 1, high: 2 } as const;
        const floored = viaGlobal.resolvedFromStrategy && intent !== 'greeting' && intent !== 'acknowledgment'
          && rank[(catalog as any)[viaGlobal.primaryModelKey].costClass as 'low'] < rank[base.costClass as 'low']
          ? base.key : viaGlobal.primaryModelKey;
        expect({ intent, classification, model: viaProfile.primaryModelKey }).toEqual({ intent, classification, model: floored });
        if (viaProfile.fallbackModelKey) {
          expect(defaultProfileRegistry.selectsModel(classification, viaProfile.fallbackModelKey)).toBe(true);
        }
      }
    }
  });

  it('a seed preselects no route its classification does not allow', () => {
    for (const classification of CLASSIFICATIONS) {
      const def = JSON.parse(serializeSeedDefinition(defaultProfileRegistry.requireProfileFor(classification).name)!);
      type SeededRoute = { primary?: string; fallback?: string; image?: { primary: string; fallback?: string } };
      for (const [intent, route] of Object.entries(def.models.byIntent as Record<string, SeededRoute>)) {
        // A route's text model is held to the text catalog, its image part to the image catalog.
        if (route.primary) expect({ intent, why: modelFits(route.primary, classification, 'text') }).toEqual({ intent, why: null });
        if (route.fallback) expect({ intent, why: modelFits(route.fallback, classification, 'text') }).toEqual({ intent, why: null });
        if (route.image) {
          expect({ intent, why: modelFits(route.image.primary, classification, 'image') }).toEqual({ intent, why: null });
          if (route.image.fallback) expect({ intent, why: modelFits(route.image.fallback, classification, 'image') }).toEqual({ intent, why: null });
        }
        expect(route.primary || route.image).toBeTruthy();
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
    for (const name of ['concierge', 'analyst', 'advisor']) {
      const def = JSON.parse(serializeSeedDefinition(name)!);
      // Explicit, visible — never absent…
      expect(def.models.classifier).toBe(DEFAULT_MODEL);
      // …and never materialized to a concrete catalog key (that would pin it, defeating the tracking).
      expect(def.models.classifier).not.toBe('haiku');
    }
  });

  it('resolves a seed profile to the seed base model (classifier sentinel does not disturb resolution)', async () => {
    const raw = serializeSeedDefinition('analyst')!;
    const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
    const { profile } = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    expect(profile.modelKey).toBe(defaultProfileRegistry.profileByName('analyst')!.modelKey);
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
      models: { default: 'opus', classifier: 'haiku', byIntent: { general: { primary: 'haiku' } } },
      classifierMode: 'llm', timeoutSeconds: 60, taskSupport: 'full',
    } as never;
    const out = ensureModelsBundle(already);
    expect(out.models?.byIntent).toEqual({ general: { primary: 'haiku' } });
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
        general: { primary: DEFAULT_MODEL },        // sentinel ⇒ dropped
        code_generation: { primary: 'sonnet', fallback: DEFAULT_MODEL }, // fallback sentinel ⇒ collapses to primary
      },
    })!;
    expect(strat.find((r) => r.intent === 'general')).toBeUndefined();
    const code = strat.find((r) => r.intent === 'code_generation')!;
    expect(code.primaryModel).toBe('sonnet');
    expect(code.fallbackModel).toBe('sonnet');
  });
});

describe('tools are PER-PROFILE (SPEC-ASSISTANT-CONFIG §4)', () => {
  it('seeds every profile with the full tool registry (explicit + editable, byte-behaviour-identical)', () => {
    for (const name of ['concierge', 'analyst', 'advisor']) {
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
    const raw = serializeSeedDefinition('analyst')!;
    const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
    const active = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    expect(active.tools).toEqual(ALL_TOOL_NAMES);

    __clearActiveProfileCache();
    const noVersion = await resolveActiveProfile('analyst', { ssm: fakeSsm(() => notFound()), ssmRoot: SSM_ROOT });
    expect(noVersion.tools).toBeUndefined(); // ⇒ loop offers all runtime-available tools (legacy behavior)
  });
});

describe("image generation is a per-profile capability (models.byIntent['image_generation'].image, ADR-064)", () => {
  const base = { modelKey: 'sonnet', classifierMode: 'llm' as const, timeoutSeconds: 60, taskSupport: 'full' as const };

  it('a seed carries the default image model only where the catalog allows its classification one', () => {
    // Premium is allowed image models (`IMAGE_MODEL_CLASSIFICATIONS`), so its assistant generates images
    // out of the box; basic and standard are allowed none, so their seeds name none.
    // The seed expresses it as the `image_generation` route's image part, with an aws-bedrock fallback
    // (`defaultImageRoute`); the route names no text model of its own.
    const advisor = JSON.parse(serializeSeedDefinition('advisor')!).models;
    expect(advisor.byIntent.image_generation).toEqual({ image: { primary: DEFAULT_IMAGE_MODEL, fallback: DEFAULT_IMAGE_FALLBACK_MODEL } });
    expect(advisor).not.toHaveProperty('image');
    for (const name of ['concierge', 'analyst']) {
      const models = JSON.parse(serializeSeedDefinition(name)!).models;
      expect(models).not.toHaveProperty('image');
      expect(models.byIntent).not.toHaveProperty('image_generation');
    }
    // The default is an aws-bedrock, active model needing NO external key.
    expect(DEFAULT_IMAGE_MODEL).toBe('stability_image_core');
  });

  const imagePart = (image: unknown) => ({ default: 'sonnet', byIntent: { image_generation: { image } } }) as never;

  it("accepts a known image key in the route's image part and REJECTS an empty / non-string one", () => {
    expect(validateDefinitionBody({ ...base, models: imagePart({ primary: 'stability_image_ultra' }) })).toEqual([]);
    expect(validateDefinitionBody({ ...base, models: imagePart({ primary: 'titan_image' }) })).toEqual([]);
    const refusal = "models.byIntent['image_generation'].image.primary must be a non-empty image model key";
    expect(validateDefinitionBody({ ...base, models: imagePart({ primary: '' }) })).toContain(refusal);
    expect(validateDefinitionBody({ ...base, models: imagePart({ primary: 7 }) })).toContain(refusal);
  });

  it('an image part is NOT run through the text-catalog allowlist (image keys are not BackendModelKeys)', () => {
    // A valid image key that is deliberately NOT a text model key passes shape validation: the route names no
    // text model, so the §7 text-catalog boundary (profile-lifecycle/manifest checkModel) never sees it.
    expect(validateDefinitionBody({ ...base, models: imagePart({ primary: 'stability_image_core', fallback: 'stability_image_ultra' }) })).toEqual([]);
  });

  it('refuses the retired models.image, naming where the image model is chosen now', () => {
    expect(validateDefinitionBody({ ...base, models: { default: 'sonnet', image: 'stability_image_core' } }))
      .toEqual(["models.image is retired; name the image model as models.byIntent['image_generation'].image.primary"]);
  });

  it('resolveActiveProfile surfaces imageModelKey — the version value, and the seed default on fallback', async () => {
    const raw = serializeSeedDefinition('advisor')!;
    const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
    const active = await resolveActiveProfile('advisor', { ssm, ssmRoot: SSM_ROOT });
    expect(active.imageModelKey).toBe(DEFAULT_IMAGE_MODEL);
    expect(active.models?.byIntent?.image_generation?.image?.primary).toBe(DEFAULT_IMAGE_MODEL);
    expect(active.models?.byIntent?.image_generation?.primary).toBeUndefined();

    // Seed fallback (no activated version): still image-capable out of the box.
    __clearActiveProfileCache();
    const noVersion = await resolveActiveProfile('advisor', { ssm: fakeSsm(() => notFound()), ssmRoot: SSM_ROOT });
    expect(noVersion.imageModelKey).toBe(DEFAULT_IMAGE_MODEL);
  });

  it('ensureModelsBundle backfills NO image model onto a legacy body, and preserves an explicit key', () => {
    // No default an assistant did not choose: a body that names no image model generates no images.
    const legacy = { modelKey: 'sonnet', classifierMode: 'llm' as const, timeoutSeconds: 60, taskSupport: 'full' as const };
    expect(ensureModelsBundle(legacy).models).not.toHaveProperty('image');
    const explicit = ensureModelsBundle({ ...legacy, models: { default: 'sonnet', image: 'titan_image' } });
    expect(explicit.models?.image).toBe('titan_image');
  });

  it('a stored body naming an image model its classification does not allow is served without it, not crashed on', async () => {
    const seed = JSON.parse(serializeSeedDefinition('analyst')!);
    const raw = JSON.stringify({ ...seed, models: { ...seed.models, byIntent: { ...seed.models.byIntent, image_generation: { image: { primary: 'stability_image_core' } } } } });
    const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
    __clearActiveProfileCache();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const active = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    // The read path leaves routes to the turn's resolver (`routes: false`), which serves an image model only where
    // the classification selects it (`modelFits`): the version is served, and its image turn resolves no image model.
    expect(active.configId).not.toBe('seed');
    expect(resolveTurnImageRoute({
      classification: classificationOfProfile('analyst')!,
      intent: 'image_generation',
      models: active.models,
      profileImageModelKey: active.imageModelKey,
    })).toEqual({});
    warn.mockRestore();
  });

  it('a stored body carrying the retired models.image is refused whole, and the seed is served', async () => {
    const raw = JSON.stringify({ ...JSON.parse(serializeSeedDefinition('analyst')!), models: { default: 'sonnet', image: 'stability_image_core' } });
    const ssm = fakeSsm((name) => (name.endsWith(':active') ? { Parameter: { Value: raw } } : notFound()));
    __clearActiveProfileCache();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const active = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT });
    expect(active.configId).toBe('seed');
    expect(active.imageModelKey).toBeUndefined();
    expect(active.models?.image).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('serving seed'))).toBe(true);
    warn.mockRestore();
  });

  it('a stored base model or classifier the classification does not allow is ignored too', () => {
    const def = { ...JSON.parse(serializeSeedDefinition('concierge')!), models: { default: 'opus', classifier: 'opus', image: 'opus' } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const served = resolveFromDefinition(def, 'concierge');
    expect(served.models?.default).toBeUndefined();
    expect(served.models?.classifier).toBeUndefined();
    expect(served.imageModelKey).toBeUndefined();
    // The base model falls to the classification's seed.
    expect(served.profile.modelKey).toBe(defaultProfileRegistry.profileByName('concierge')!.modelKey);
    warn.mockRestore();
  });
});

describe('a seeded version is consistent with the pack it carries', () => {
  it('seeds ONLY the routes the carried pack can classify', () => {
    // The seed wrote the PLATFORM default routes beside whatever pack it was handed, so a deployment
    // with a narrower pack got a version that was invalid against its own taxonomy - routes that can
    // never fire, refused by the validator the carried pack exists to enable. Measured: a deployment
    // running the demo pack seeded code_generation/code_review/strategic_analysis and could not
    // afterwards edit those profiles at all, because every edit was refused for those routes.
    const narrow = { intents: [{ key: 'general', description: 'general questions' }] };
    const def = JSON.parse(serializeSeedDefinition('analyst', undefined, narrow as never)!);
    const routes = Object.keys(def.models.byIntent ?? {});

    expect(routes).toContain('general');
    expect(routes).not.toContain('code_generation');
    expect(routes).not.toContain('strategic_analysis');
  });

  it('keeps every route when no pack is carried, because then the default taxonomy IS the taxonomy', () => {
    const def = JSON.parse(serializeSeedDefinition('analyst')!);
    expect(Object.keys(def.models.byIntent ?? {}).length).toBeGreaterThan(1);
  });
});
