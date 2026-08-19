/**
 * SPEC-PORTABLE-PROFILES P0 — seeding the active profile version.
 * The seed must write a byte-identical definition + move the `active` label onto it, and the runtime
 * resolver must then serve exactly the compiled seed (round-trip closes the loop).
 */
import { PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { seedAllProfileDefinitions, seedActiveProfileDefinition, SSM_STANDARD_TIER_MAX } from '../../lambda/src/lib/seed-profile-definitions';
import { resolveActiveProfile, __clearActiveProfileCache, serializeSeedDefinition } from '../../lambda/src/lib/active-profile';
import { defaultProfileRegistry } from '../../lib/profile-registry';

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
    const names = defaultProfileRegistry.classificationValues().map((c) => defaultProfileRegistry.profileFor(c).name);
    expect(results.map((r) => r.profileName).sort()).toEqual([...new Set(names)].sort());
    for (const r of results) {
      expect(r.version).toBe(1);
      const p = params.get(`${SSM_ROOT}/assistant/${r.profileName}/definition`)!;
      expect(p.labels.has('active')).toBe(true);
    }
    expect(label).toHaveBeenCalledTimes(results.length);
  });

  it('round-trips: after seeding, resolveActiveProfile serves the byte-identical compiled seed', async () => {
    const { client } = fakeSsmStore();
    await seedAllProfileDefinitions(client, SSM_ROOT);
    for (const name of ['basic', 'standard', 'premium'] as const) {
      __clearActiveProfileCache();
      const { profile, configId } = await resolveActiveProfile(name, { ssm: client, ssmRoot: SSM_ROOT });
      expect(profile).toEqual(defaultProfileRegistry.profileByName(name));
      expect(configId).not.toBe('seed'); // an explicit active version now exists
    }
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
      await seedAllProfileDefinitions(client, SSM_ROOT, { standard: persona });

      const raw = params.get(`${SSM_ROOT}/assistant/standard/definition`)!.value;
      expect(JSON.parse(raw).persona).toBe(persona);

      __clearActiveProfileCache();
      const resolved = await resolveActiveProfile('standard', { ssm: client, ssmRoot: SSM_ROOT });
      expect(resolved.persona).toBe(persona);
    });

    it('leaves every OTHER profile persona-free, so the map is opt-in not a broadcast', async () => {
      const { client, params } = fakeSsmStore();
      await seedAllProfileDefinitions(client, SSM_ROOT, { standard: 'standard only' });
      for (const name of ['basic', 'premium'] as const) {
        expect(JSON.parse(params.get(`${SSM_ROOT}/assistant/${name}/definition`)!.value).persona).toBeUndefined();
      }
    });

    it('changes the configId, so per-turn attribution can tell two personas apart', async () => {
      const { client, params } = fakeSsmStore();
      await seedActiveProfileDefinition(client, SSM_ROOT, 'standard');
      const withoutPersona = JSON.parse(params.get(`${SSM_ROOT}/assistant/standard/definition`)!.value).configId;
      await seedActiveProfileDefinition(client, SSM_ROOT, 'standard', 'a persona');
      const withPersona = JSON.parse(params.get(`${SSM_ROOT}/assistant/standard/definition`)!.value).configId;
      expect(withPersona).not.toBe(withoutPersona);
    });

    // A persona authored in the repo arrives through a git checkout, and Windows autocrlf rewrites
    // its newlines. Without normalising, the same profile seeded from a dev box and from CI hashes to
    // two different configIds, splitting per-turn config attribution by platform and making an
    // exported manifest's contentHash depend on who exported it.
    it('normalises CRLF, so the configId does not depend on the seeding machine', async () => {
      const { client, params } = fakeSsmStore();
      const lf = 'line one\nline two\nline three';
      const crlf = lf.replace(/\n/g, '\r\n');

      await seedActiveProfileDefinition(client, SSM_ROOT, 'standard', crlf);
      const fromCrlf = JSON.parse(params.get(`${SSM_ROOT}/assistant/standard/definition`)!.value);
      await seedActiveProfileDefinition(client, SSM_ROOT, 'standard', lf);
      const fromLf = JSON.parse(params.get(`${SSM_ROOT}/assistant/standard/definition`)!.value);

      expect(fromCrlf.persona).toBe(lf);
      expect(fromCrlf.configId).toBe(fromLf.configId);
    });

    it('treats blank as absent, matching the runtime `persona?.trim() || fallback`', async () => {
      const { client, params } = fakeSsmStore();
      await seedActiveProfileDefinition(client, SSM_ROOT, 'standard', '   ');
      expect(JSON.parse(params.get(`${SSM_ROOT}/assistant/standard/definition`)!.value).persona).toBeUndefined();
    });

    it('no persona argument seeds exactly as before (existing callers unchanged)', async () => {
      const { client, params } = fakeSsmStore();
      await seedActiveProfileDefinition(client, SSM_ROOT, 'standard');
      expect(params.get(`${SSM_ROOT}/assistant/standard/definition`)!.value)
        .toBe(serializeSeedDefinition('standard'));
    });

    // A persona validates up to MAX_PERSONA_LENGTH (20000), which is five times what a Standard-tier
    // SSM parameter can hold. Without this the failure is an opaque AWS ValidationException naming
    // neither the profile nor the field.
    it('refuses a persona that would overflow the SSM parameter, and says how much room is left', async () => {
      const { client, put } = fakeSsmStore();
      await expect(
        seedActiveProfileDefinition(client, SSM_ROOT, 'standard', 'x'.repeat(SSM_STANDARD_TIER_MAX)),
      ).rejects.toThrow(/over the 4096-char SSM Standard-tier parameter limit.*room for a persona of about \d+/s);
      expect(put).not.toHaveBeenCalled(); // fails BEFORE writing a truncated/invalid definition
    });

    it('accepts a persona that fits', async () => {
      const { client, params } = fakeSsmStore();
      const base = serializeSeedDefinition('standard')!.length;
      const persona = 'y'.repeat(SSM_STANDARD_TIER_MAX - base - 200); // 200 chars of JSON overhead headroom
      await seedActiveProfileDefinition(client, SSM_ROOT, 'standard', persona);
      expect(JSON.parse(params.get(`${SSM_ROOT}/assistant/standard/definition`)!.value).persona).toBe(persona);
    });
  });

  it('is idempotent — re-seeding overwrites and keeps active on the newest version', async () => {
    const { client, params } = fakeSsmStore();
    await seedActiveProfileDefinition(client, SSM_ROOT, 'basic');
    await seedActiveProfileDefinition(client, SSM_ROOT, 'basic');
    const p = params.get(`${SSM_ROOT}/assistant/basic/definition`)!;
    expect(p.version).toBe(2);
    expect(p.labels.has('active')).toBe(true);
  });
});
