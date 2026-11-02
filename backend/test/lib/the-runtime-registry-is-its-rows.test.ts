/**
 * THE RUNTIME REGISTRY IS THE ROWS THE DEPLOYMENT'S STACKS PUBLISH (the classification-independence plan, step 5).
 *
 *  - Each classification's row carries its own declaration, its profiles and its groups, and the admin plane's
 *    names no member classification; the rows assemble to the declared set, for the shipped catalog, a
 *    selection of it and the matrix's custom sets.
 *  - A row fits an SSM parameter, compressed past a standard one's limit.
 *  - A deployed handler (`PROFILE_REGISTRY_PATH_ENV` set) reads nothing from the registry before it loads it, and
 *    loads it with one read per TTL, shared by concurrent callers; a failed read keeps a set read before and
 *    throws when there is none.
 */
import {
  DEFAULT_PROFILES_CONFIG, PROFILE_REGISTRY_PATH_ENV, canonicalProfilesConfig, profilesConfigFromRows, registryRowFromValue,
  registryRowOf, registryRowValue, registryRowsOf, resolveDeploymentProfiles, STANDARD_PARAMETER_LIMIT, ADVANCED_PARAMETER_LIMIT,
  type ProfilesConfig,
} from '../../lib/config/profiles';
import { CUSTOM_PROFILES, CUSTOM_PROFILES_PLUS_ENTERPRISE, CUSTOM_BATTLE_PROFILES_PLUS_RESEARCH } from '../deploy-matrix/configurations';

const SETS: Array<[string, ProfilesConfig]> = [
  ['the shipped catalog', DEFAULT_PROFILES_CONFIG],
  ['a deployment that declares nothing', resolveDeploymentProfiles(undefined)],
  ['a selection of the catalog', resolveDeploymentProfiles(['standard', 'guest', 'customer'])],
  ['C1-custom', resolveDeploymentProfiles(CUSTOM_PROFILES)],
  ['C1-custom+enterprise', resolveDeploymentProfiles(CUSTOM_PROFILES_PLUS_ENTERPRISE)],
  ['C7-custom+research', resolveDeploymentProfiles(CUSTOM_BATTLE_PROFILES_PLUS_RESEARCH)],
];

describe('a deployment\'s rows assemble to the set it declares', () => {
  it.each(SETS)('%s', (_name, config) => {
    const rows = registryRowsOf(config);
    expect(rows.map((r) => r.classification.value)).toEqual(config.classifications.map((c) => c.value));
    const back = profilesConfigFromRows(rows.map((r) => registryRowFromValue(registryRowValue(r))));
    expect(canonicalProfilesConfig(back)).toEqual(canonicalProfilesConfig(config));
  });

  it('gives the admin plane a row that names no member classification, and reads its grants as itself alone', () => {
    const config = resolveDeploymentProfiles(CUSTOM_PROFILES_PLUS_ENTERPRISE);
    const admin = registryRowOf(config, 'admin');
    expect(admin.classification.grants).toEqual(['admin']);
    expect(JSON.stringify(admin)).not.toMatch(/legal|finance|enterprise/);
    // The same row with or without enterprise declared.
    expect(registryRowOf(resolveDeploymentProfiles(CUSTOM_PROFILES), 'admin')).toEqual(admin);
    const assembled = profilesConfigFromRows(registryRowsOf(config));
    expect(assembled.classifications.find((c) => c.value === 'admin')!.grants).toEqual(['admin']);
  });

  it('gives a member classification the same row whichever other classifications are declared', () => {
    for (const value of ['legal', 'finance']) {
      expect(registryRowOf(resolveDeploymentProfiles(CUSTOM_PROFILES_PLUS_ENTERPRISE), value)).toEqual(registryRowOf(resolveDeploymentProfiles(CUSTOM_PROFILES), value));
    }
  });

  it('carries each classification\'s profiles, groups and membership groups on its own row', () => {
    const premium = registryRowOf(DEFAULT_PROFILES_CONFIG, 'premium');
    expect(premium.profiles.map((p) => p.name).sort()).toEqual(['advisor', 'ops-premium']);
    expect(premium.groupClearance).toEqual({ premium: 'premium' });
    expect(premium.membershipGroups).toEqual({ ops: 'premium' });
    expect(registryRowOf(DEFAULT_PROFILES_CONFIG, 'basic').membershipGroups).toBeUndefined();
  });

  it('refuses a profile no classification serves, and a profile two rows publish differently', () => {
    expect(() => registryRowsOf({ ...DEFAULT_PROFILES_CONFIG, profiles: [...DEFAULT_PROFILES_CONFIG.profiles, { name: 'orphan', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted' }] }))
      .toThrow(/orphan serve no classification/);
    const rows = registryRowsOf(DEFAULT_PROFILES_CONFIG);
    const basic = rows.find((r) => r.classification.value === 'basic')!;
    const twin = { ...rows.find((r) => r.classification.value === 'standard')!, profiles: [{ ...basic.profiles[0], timeoutSeconds: 31 }] };
    expect(() => profilesConfigFromRows([...rows.filter((r) => r.classification.value !== 'standard'), { ...twin, profiles: [...twin.profiles, ...rows.find((r) => r.classification.value === 'standard')!.profiles] }]))
      .toThrow(/published twice, differently/);
  });

  it('fits every row of the shipped catalog in a parameter, compressing one longer than a standard parameter holds', () => {
    for (const row of registryRowsOf(DEFAULT_PROFILES_CONFIG)) {
      const value = registryRowValue(row);
      expect(value.length).toBeLessThanOrEqual(ADVANCED_PARAMETER_LIMIT);
      if (JSON.stringify(row).length > STANDARD_PARAMETER_LIMIT) expect(value.startsWith('gz64:')).toBe(true);
      else expect(value).toBe(JSON.stringify(row));
    }
    expect(() => registryRowFromValue('{"not":"a row"}')).toThrow(/not a classification registry row/);
  });
});

describe('a deployed handler loads the registry before it reads it', () => {
  const PATH = '/test-instance/registry/classification';
  const rows = registryRowsOf(resolveDeploymentProfiles(CUSTOM_PROFILES)).map(registryRowValue);
  let mod: typeof import('../../lib/profile-registry');

  beforeEach(() => {
    jest.resetModules();
    process.env[PROFILE_REGISTRY_PATH_ENV] = PATH;
    mod = require('../../lib/profile-registry');
  });
  afterEach(() => {
    delete process.env[PROFILE_REGISTRY_PATH_ENV];
    jest.resetModules();
  });

  it('refuses a read before the load, and answers from the rows after it', async () => {
    expect(() => mod.defaultProfileRegistry.classificationValues()).toThrow(/before it was loaded/);
    const reads: string[] = [];
    mod.__setRegistryRowReaderForTest(async (path) => { reads.push(path); return rows; });
    const [a, b] = await Promise.all([mod.loadProfileRegistry(), mod.loadProfileRegistry()]);
    expect(a).toBe(b);
    expect(reads).toEqual([PATH]);
    expect(mod.defaultProfileRegistry.classificationValues()).toEqual(['admin', 'finance', 'legal']);
    expect(mod.defaultProfileRegistry.grantsFor('admin')).toEqual(['admin']);
    await mod.loadProfileRegistry();
    expect(reads).toHaveLength(1);
  });

  it('throws when the first read fails, and keeps the set read before when a later one does', async () => {
    mod.__setRegistryRowReaderForTest(async () => { throw new Error('ssm down'); });
    await expect(mod.loadProfileRegistry()).rejects.toThrow(/ssm down/);
    let fail = false;
    mod.__setRegistryRowReaderForTest(async () => { if (fail) throw new Error('ssm down'); return rows; });
    await mod.loadProfileRegistry();
    fail = true;
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + mod.PROFILE_REGISTRY_TTL_MS + 1);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(mod.loadProfileRegistry()).resolves.toBeDefined();
      expect(mod.defaultProfileRegistry.classificationValues()).toEqual(['admin', 'finance', 'legal']);
      expect(warn).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('a refresh is a read of its own: it fails loudly rather than serve the set read before', async () => {
    let fail = false;
    mod.__setRegistryRowReaderForTest(async () => { if (fail) throw new Error('ssm down'); return rows; });
    await mod.loadProfileRegistry();
    fail = true;
    await expect(mod.refreshProfileRegistry()).rejects.toThrow(/the registry could not be read \(\/test-instance\/registry\/classification\): ssm down/);
  });

  it('a refresh does not join a read already in flight, which began before the row it needs was published', async () => {
    const older = rows.filter((r) => registryRowFromValue(r).classification.value !== 'finance');
    expect(older.length).toBe(rows.length - 1);
    let release: () => void = () => undefined;
    let current = older;
    mod.__setRegistryRowReaderForTest(async () => {
      const served = current;
      if (served === older) await new Promise<void>((r) => { release = r; });
      return served;
    });
    const inFlight = mod.loadProfileRegistry();
    // The deploy publishes the row; the read in flight was already answering the older rows.
    current = rows;
    const refreshed = mod.refreshProfileRegistry();
    release();
    await inFlight;
    await refreshed;
    expect(mod.defaultProfileRegistry.classificationValues()).toEqual(['admin', 'finance', 'legal']);
  });

  it('wraps a handler so it runs with the registry loaded', async () => {
    mod.__setRegistryRowReaderForTest(async () => rows);
    const handler = mod.withProfileRegistry(async (x: number) => `${x}:${mod.defaultProfileRegistry.classificationValues().length}`);
    await expect(handler(7)).resolves.toBe('7:3');
  });

  it('reads nothing outside a deployed handler, and answers from the catalog', async () => {
    delete process.env[PROFILE_REGISTRY_PATH_ENV];
    jest.resetModules();
    const local: typeof import('../../lib/profile-registry') = require('../../lib/profile-registry');
    const reader = jest.fn(async () => rows);
    local.__setRegistryRowReaderForTest(reader);
    await local.loadProfileRegistry();
    expect(reader).not.toHaveBeenCalled();
    expect(local.defaultProfileRegistry.classificationValues()).toEqual(DEFAULT_PROFILES_CONFIG.classifications.map((c) => c.value));
  });
});
