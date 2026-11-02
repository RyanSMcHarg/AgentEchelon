/**
 * SPEC-PORTABLE-PROFILES P0 — seeding the active profile version.
 * The seed must write a byte-identical definition + move the `active` label onto it, and the runtime
 * resolver must then serve exactly the compiled seed (round-trip closes the loop).
 */
import { PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { seedAllProfileDefinitions, seedActiveProfileDefinition, SSM_STANDARD_TIER_MAX, SEEDED_CONTEXT_SOURCES } from '../../lambda/src/lib/seed-profile-definitions';
import { contextSourceCatalog } from '../../lib/config/context-sources.example';
import { resolveActiveProfile, __clearActiveProfileCache, serializeSeedDefinition } from '../../lambda/src/lib/active-profile';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { validateBody } from '../../lambda/src/lib/profile-lifecycle';

const SSM_ROOT = '/agent-echelon';

/** A fake SSM that records writes into a param store and serves them back on GetParameter (with labels). */
function fakeSsmStore() {
  const params = new Map<string, { value: string; version: number; labels: Set<string> }>();
  const put = jest.fn();
  const label = jest.fn();
  const client = {
    send: jest.fn(async (cmd: unknown) => {
      if (cmd instanceof PutParameterCommand) {
        const { Name, Value } = cmd.input as { Name: string; Value: string };
        const prev = params.get(Name);
        const version = (prev?.version ?? 0) + 1;
        params.set(Name, { value: Value, version, labels: prev?.labels ?? new Set() });
        put(Name, Value);
        return { Version: version };
      }
      if (cmd instanceof LabelParameterVersionCommand) {
        const { Name, Labels } = cmd.input as { Name: string; Labels: string[] };
        const p = params.get(Name)!;
        for (const l of Labels) p.labels.add(l);
        label(Name, Labels);
        return {};
      }
      // GetParameter (used by resolveActiveProfile): resolve the :active-labeled value.
      const { Name } = (cmd as { input: { Name: string } }).input;
      const [base, lbl] = Name.split(':');
      const p = params.get(base);
      if (!p || (lbl && !p.labels.has(lbl))) {
        const e = new Error('not found') as Error & { name: string };
        e.name = 'ParameterNotFound';
        throw e;
      }
      return { Parameter: { Value: p.value } };
    }),
  };
  return { client: client as unknown as import('@aws-sdk/client-ssm').SSMClient, params, put, label };
}

beforeEach(() => __clearActiveProfileCache());

describe('seed-profile-definitions P0', () => {
  it('seeds every shipped profile and labels version 1 active', async () => {
    const { client, params, label } = fakeSsmStore();
    const results = await seedAllProfileDefinitions(client, SSM_ROOT);
    // EVERY DECLARED ASSISTANT, which is not the same as one per classification. This expected the
    // classification-mapped set - `requireProfileFor` per classification - and so did the seeder, which
    // is how a classification's SECOND assistant came to have an identity, a Lex bot and an assignment
    // record with no definition behind any of them.
    const names = defaultProfileRegistry.profileNames();
    expect(results.map((r) => r.profileName).sort()).toEqual([...new Set(names)].sort());
    for (const r of results) {
      expect(r.version).toBe(1);
      const p = params.get(`${SSM_ROOT}/assistant/${r.profileName}/definition`)!;
      expect(p.labels.has('active')).toBe(true);
    }
    expect(label).toHaveBeenCalledTimes(results.length);
  });

  it("includes a ROLE's assistant, which the classification-mapped set left out", async () => {
    // Named rather than left to the set comparison above, because the set is derived from the registry
    // and would keep passing if the role's profile were removed from the config. `ops-premium` serves
    // (premium, ops) and is the worked case for a second assistant inside one classification.
    const { client, params } = fakeSsmStore();
    const results = await seedAllProfileDefinitions(client, SSM_ROOT);
    expect(results.map((r) => r.profileName)).toContain('ops-premium');
    expect(params.get(`${SSM_ROOT}/assistant/ops-premium/definition`)!.labels.has('active')).toBe(true);
  });

  it('round-trips: after seeding, resolveActiveProfile serves the byte-identical compiled seed', async () => {
    const { client } = fakeSsmStore();
    await seedAllProfileDefinitions(client, SSM_ROOT);
    for (const name of ['concierge', 'analyst', 'advisor'] as const) {
      __clearActiveProfileCache();
      const { profile, configId } = await resolveActiveProfile(name, { ssm: client, ssmRoot: SSM_ROOT });
      expect(profile).toEqual(defaultProfileRegistry.profileByName(name));
      expect(configId).not.toBe('seed'); // an explicit active version now exists
    }
  });

  it('republishes the advertisement from the pack it activates, as console activation does', async () => {
    // A seed moves the active label, which is an activation; an advertisement left from the previous
    // version offers roommates intents the active version no longer declares.
    const { client, params } = fakeSsmStore();
    const pack = {
      intents: [{ key: 'deployment_health', summary: 'read the deployment telemetry', description: 'how the deployment is running' }],
    } as unknown as Parameters<typeof seedActiveProfileDefinition>[5];
    await seedActiveProfileDefinition(client, SSM_ROOT, 'ops-premium', undefined, undefined, pack);
    const ad = params.get(`${SSM_ROOT}/assistant/ops-premium/advertisement`);
    expect(ad).toBeDefined();
    expect(JSON.parse(ad!.value).intents.map((i: { key: string }) => i.key)).toEqual(['deployment_health']);
  });

  it("seeds user-profile as every assistant's context source, and not company-docs", async () => {
    // The company document menu is in every turn already, so `company-docs` would be the same documents twice.
    const { client, params } = fakeSsmStore();
    const results = await seedAllProfileDefinitions(client, SSM_ROOT);
    expect(SEEDED_CONTEXT_SOURCES).toEqual(['user-profile']);
    for (const r of results) {
      const def = JSON.parse(params.get(`${SSM_ROOT}/assistant/${r.profileName}/definition`)!.value);
      expect(def.contextSources).toEqual(['user-profile']);
    }
    __clearActiveProfileCache();
    expect((await resolveActiveProfile('analyst', { ssm: client, ssmRoot: SSM_ROOT })).contextSources).toEqual(['user-profile']);
  });

  it('keeps user-profile off the welcome: its catalog entry waits for a settled identity', () => {
    const entry = contextSourceCatalog({
      classification: 'basic', attachmentsBucketArn: 'arn:aws:s3:::b', attachmentsBucketName: 'b',
      userProfileTableArn: 'arn:aws:dynamodb:us-east-1:1:table/p', userProfileTableName: 'p',
      region: 'us-east-1', account: '1',
    }).find((e) => e.key === 'user-profile');
    expect(entry?.availability).toBe('identity-settled');
  });

  it('returns null for an unknown profile name (nothing to seed)', async () => {
    const { client } = fakeSsmStore();
    expect(await seedActiveProfileDefinition(client, SSM_ROOT, 'no-such-profile')).toBeNull();
  });

  // Persona truth lives in the PROFILE, because the profile is the portable artifact: the manifest
  // exports it and the async processor prefers it over the deployment seam. Seeding the persona only
  // into `assistant-system-prompt` produces a profile that exports mute and lands on another instance
  // answering as the generic default. These pin the seam so it cannot quietly revert.
  describe('deployment persona rides the definition (portability)', () => {
    it('folds the persona into the seeded definition, and resolveActiveProfile serves it', async () => {
      const { client, params } = fakeSsmStore();
      const persona = 'You are the internal assistant for Stratum Technologies.';
      await seedAllProfileDefinitions(client, SSM_ROOT, { analyst: persona });

      const raw = params.get(`${SSM_ROOT}/assistant/analyst/definition`)!.value;
      expect(JSON.parse(raw).persona).toBe(persona);

      __clearActiveProfileCache();
      const resolved = await resolveActiveProfile('analyst', { ssm: client, ssmRoot: SSM_ROOT });
      expect(resolved.persona).toBe(persona);
    });

    it('leaves every OTHER profile persona-free, so the map is opt-in not a broadcast', async () => {
      const { client, params } = fakeSsmStore();
      await seedAllProfileDefinitions(client, SSM_ROOT, { analyst: 'standard only' });
      for (const name of ['concierge', 'advisor'] as const) {
        expect(JSON.parse(params.get(`${SSM_ROOT}/assistant/${name}/definition`)!.value).persona).toBeUndefined();
      }
    });

    it('changes the configId, so per-turn attribution can tell two personas apart', async () => {
      const { client, params } = fakeSsmStore();
      await seedActiveProfileDefinition(client, SSM_ROOT, 'analyst');
      const withoutPersona = JSON.parse(params.get(`${SSM_ROOT}/assistant/analyst/definition`)!.value).configId;
      await seedActiveProfileDefinition(client, SSM_ROOT, 'analyst', 'a persona');
      const withPersona = JSON.parse(params.get(`${SSM_ROOT}/assistant/analyst/definition`)!.value).configId;
      expect(withPersona).not.toBe(withoutPersona);
    });

    // A persona authored in the repo arrives through a git checkout, and Windows autocrlf rewrites
    // its newlines. Without normalizing, the same profile seeded from a dev box and from CI hashes to
    // two different configIds, splitting per-turn config attribution by platform and making an
    // exported manifest's contentHash depend on who exported it.
    it('normalises CRLF, so the configId does not depend on the seeding machine', async () => {
      const { client, params } = fakeSsmStore();
      const lf = 'line one\nline two\nline three';
      const crlf = lf.replace(/\n/g, '\r\n');

      await seedActiveProfileDefinition(client, SSM_ROOT, 'analyst', crlf);
      const fromCrlf = JSON.parse(params.get(`${SSM_ROOT}/assistant/analyst/definition`)!.value);
      await seedActiveProfileDefinition(client, SSM_ROOT, 'analyst', lf);
      const fromLf = JSON.parse(params.get(`${SSM_ROOT}/assistant/analyst/definition`)!.value);

      expect(fromCrlf.persona).toBe(lf);
      expect(fromCrlf.configId).toBe(fromLf.configId);
    });

    it('treats blank as absent, matching the runtime `persona?.trim() || fallback`', async () => {
      const { client, params } = fakeSsmStore();
      await seedActiveProfileDefinition(client, SSM_ROOT, 'analyst', '   ');
      expect(JSON.parse(params.get(`${SSM_ROOT}/assistant/analyst/definition`)!.value).persona).toBeUndefined();
    });

    it('no persona argument seeds exactly as before (existing callers unchanged)', async () => {
      const { client, params } = fakeSsmStore();
      await seedActiveProfileDefinition(client, SSM_ROOT, 'analyst');
      expect(params.get(`${SSM_ROOT}/assistant/analyst/definition`)!.value)
        .toBe(serializeSeedDefinition('analyst'));
    });

    // A persona validates up to MAX_PERSONA_LENGTH (20000), which is five times what a Standard-tier
    // SSM parameter can hold. Without this the failure is an opaque AWS ValidationException naming
    // neither the profile nor the field.
    it('refuses a persona that would overflow the SSM parameter, and says how much room is left', async () => {
      const { client, put } = fakeSsmStore();
      await expect(
        seedActiveProfileDefinition(client, SSM_ROOT, 'analyst', 'x'.repeat(SSM_STANDARD_TIER_MAX)),
      ).rejects.toThrow(/over the 4096-char SSM Standard-tier parameter limit.*room for a persona of about \d+/s);
      expect(put).not.toHaveBeenCalled(); // fails BEFORE writing a truncated/invalid definition
    });

    it('accepts a persona that fits', async () => {
      const { client, params } = fakeSsmStore();
      const base = serializeSeedDefinition('analyst')!.length;
      const persona = 'y'.repeat(SSM_STANDARD_TIER_MAX - base - 200); // 200 chars of JSON overhead headroom
      await seedActiveProfileDefinition(client, SSM_ROOT, 'analyst', persona);
      expect(JSON.parse(params.get(`${SSM_ROOT}/assistant/analyst/definition`)!.value).persona).toBe(persona);
    });
  });

  it('is idempotent — re-seeding overwrites and keeps active on the newest version', async () => {
    const { client, params } = fakeSsmStore();
    await seedActiveProfileDefinition(client, SSM_ROOT, 'concierge');
    await seedActiveProfileDefinition(client, SSM_ROOT, 'concierge');
    const p = params.get(`${SSM_ROOT}/assistant/concierge/definition`)!;
    expect(p.version).toBe(2);
    expect(p.labels.has('active')).toBe(true);
  });
});

describe('every seed is a version its own write path accepts', () => {
  it('the seed of every declared assistant validates against its classification', () => {
    const catalog = getModelCatalog('us-east-1', '123456789012');
    const names = [...new Set(defaultProfileRegistry.profileNames())];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const classification = defaultProfileRegistry.roleOfAssistant(name)?.classification;
      const body = JSON.parse(serializeSeedDefinition(name)!);
      expect({ name, classification, errors: validateBody(body, catalog, undefined, classification) }).toEqual({ name, classification, errors: [] });
    }
  });
});
