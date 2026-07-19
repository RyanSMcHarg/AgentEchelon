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
  __clearActiveProfileCache,
  PROFILE_DEFINITION_SCHEMA_VERSION,
} from '../../lambda/src/lib/active-profile';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { DEFAULT_PROFILE_MODEL_SELECTION } from '../../lib/config/model-strategy';

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
