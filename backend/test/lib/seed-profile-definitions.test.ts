/**
 * SPEC-PORTABLE-VERSIONED-PROFILES P0 — seeding the active profile version.
 * The seed must write a byte-identical definition + move the `active` label onto it, and the runtime
 * resolver must then serve exactly the compiled seed (round-trip closes the loop).
 */
import { PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { seedAllProfileDefinitions, seedActiveProfileDefinition } from '../../lambda/src/lib/seed-profile-definitions';
import { resolveActiveProfile, __clearActiveProfileCache } from '../../lambda/src/lib/active-profile';
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

  it('is idempotent — re-seeding overwrites and keeps active on the newest version', async () => {
    const { client, params } = fakeSsmStore();
    await seedActiveProfileDefinition(client, SSM_ROOT, 'basic');
    await seedActiveProfileDefinition(client, SSM_ROOT, 'basic');
    const p = params.get(`${SSM_ROOT}/assistant/basic/definition`)!;
    expect(p.version).toBe(2);
    expect(p.labels.has('active')).toBe(true);
  });
});
