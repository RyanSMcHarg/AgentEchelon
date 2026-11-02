/**
 * THE RUNTIME REGISTRY FAILS CLOSED PER ITEM, AND NEVER SERVES A SET PAST ITS STALENESS.
 *
 * The rows are published by independently deployed stacks, so one stack's deploy or removal can leave the
 * others naming what is not there. A handler (`loadProfileRegistry`) and the Cognito trigger (`loadAdmission`)
 * each leave out only the item that is wrong, report it as a metric an operator alarms on, and agree on what is
 * left. The declared set is still refused whole at synth (`profilesConfigFromRows`).
 *
 * A read that fails keeps the set read before for at most twice the TTL from the last read that succeeded, and
 * one SSM client with adaptive retry serves every read in a container.
 */
import {
  DEFAULT_PROFILES_CONFIG, PROFILE_REGISTRY_PATH_ENV, profilesConfigFromPublishedRows, profilesConfigFromRows, registryRowFromValue,
  registryRowsOf, registryRowValue,
} from '../../lib/config/profiles';
import { ProfileRegistry } from '../../lib/profile-registry';
import { classificationAdmission } from '../../lib/classification-admission';

const PATH = '/test-instance/registry/classification';
const allRows = registryRowsOf(DEFAULT_PROFILES_CONFIG);
const valuesOf = (rows = allRows) => rows.map(registryRowValue);
/** The rows with `standard`'s removed, as they read between its stack's removal and premium's next deploy. */
const withoutStandard = () => valuesOf(allRows.filter((r) => r.classification.value !== 'standard'));
/** The rows with standard publishing a different copy of basic's profile. */
const withConflict = () => {
  const basic = allRows.find((r) => r.classification.value === 'basic')!;
  return valuesOf(allRows.map((r) => (r.classification.value === 'standard'
    ? { ...r, profiles: [...r.profiles, { ...basic.profiles[0], timeoutSeconds: 31 }] } : r)));
};
const emf = (spy: jest.SpyInstance, metric: string) => spy.mock.calls
  .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
  .filter((d) => d?._aws?.CloudWatchMetrics?.[0]?.Namespace === 'AgentEchelon/ProfileRegistry' && d[metric] === 1);

describe('the runtime assembly leaves out only what is wrong', () => {
  it('drops a grant naming a classification no row declares, where the declared set is refused whole', () => {
    expect(() => profilesConfigFromRows(withoutStandard().map(registryRowFromValue))).toThrow(/grants 'standard'/);
    const { config, dropped } = profilesConfigFromPublishedRows(withoutStandard());
    expect(config.classifications.find((c) => c.value === 'premium')!.grants).toEqual(['basic', 'premium']);
    expect(config.classifications.map((c) => c.value)).not.toContain('standard');
    expect(dropped).toEqual([expect.objectContaining({ kind: 'dangling-grant', classification: 'premium' })]);
  });

  it('skips a row it cannot read and serves the rest', () => {
    const { config, dropped } = profilesConfigFromPublishedRows([...valuesOf(), '{"not":"a row"}', 'gz64:%%%']);
    expect(config.classifications.map((c) => c.value).sort()).toEqual(DEFAULT_PROFILES_CONFIG.classifications.map((c) => c.value).sort());
    expect(dropped.map((d) => d.kind)).toEqual(['unreadable-row', 'unreadable-row']);
  });

  it('keeps the serving row\'s copy of a profile two rows publish differently', () => {
    expect(() => profilesConfigFromRows(withConflict().map(registryRowFromValue))).toThrow(/published twice, differently/);
    const { config, dropped } = profilesConfigFromPublishedRows(withConflict());
    const basic = allRows.find((r) => r.classification.value === 'basic')!.profiles[0];
    expect(config.profiles.find((p) => p.name === basic.name)).toEqual(basic);
    expect(dropped).toEqual([expect.objectContaining({ kind: 'conflicting-profile', classification: 'standard' })]);
  });

  it('keeps the first row of a classification read twice', () => {
    const basic = allRows.find((r) => r.classification.value === 'basic')!;
    const { dropped } = profilesConfigFromPublishedRows([...valuesOf(), registryRowValue(basic)]);
    expect(dropped).toEqual([expect.objectContaining({ kind: 'duplicate-row', classification: 'basic' })]);
  });

  it('the Cognito trigger leaves out the same items and agrees with the handlers on what remains', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const raw = require('../../lambda/cognito-triggers/registry-admission.js');
    for (const values of [withoutStandard(), [...valuesOf(), 'not json'], withConflict()]) {
      const { config, dropped } = profilesConfigFromPublishedRows(values);
      const fromRaw = raw.rowsOfValues(values);
      expect(fromRaw.dropped.map((d: { kind: string }) => d.kind)).toEqual(dropped.filter((d) => d.kind !== 'conflicting-profile').map((d) => d.kind));
      expect(raw.admissionOfRows(fromRaw.rows)).toEqual(classificationAdmission(new ProfileRegistry(config)));
    }
  });
});

describe('a deployed handler reports what it left out and never serves a set past its staleness', () => {
  let mod: typeof import('../../lib/profile-registry');
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    process.env[PROFILE_REGISTRY_PATH_ENV] = PATH;
    mod = require('../../lib/profile-registry');
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    mod.__setRegistryRowReaderForTest(undefined);
    delete process.env[PROFILE_REGISTRY_PATH_ENV];
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('serves the set with a dangling grant dropped, and counts it on the registry metric', async () => {
    mod.__setRegistryRowReaderForTest(async () => withoutStandard());
    await mod.loadProfileRegistry();
    expect(mod.defaultProfileRegistry.grantsFor('premium')).toEqual(['basic', 'premium']);
    const lines = emf(log, 'RegistryItemDropped');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ RegistryPath: PATH, kind: 'dangling-grant', classification: 'premium' });
    expect(lines[0]._aws.CloudWatchMetrics[0].Dimensions).toEqual([['RegistryPath']]);
    expect(error).toHaveBeenCalled();
  });

  it('keeps the set read before within twice the TTL, and throws past it', async () => {
    let fail = false;
    mod.__setRegistryRowReaderForTest(async () => { if (fail) throw new Error('ssm down'); return valuesOf(); });
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    await mod.loadProfileRegistry();
    fail = true;
    now.mockReturnValue(start + mod.PROFILE_REGISTRY_TTL_MS + 1);
    await expect(mod.loadProfileRegistry()).resolves.toBeDefined();
    expect(warn).toHaveBeenCalled();
    expect(emf(log, 'RegistryReadFailed')).toHaveLength(1);
    // Inside the retry window the kept set answers without a read; past the staleness nothing does.
    now.mockReturnValue(start + mod.PROFILE_REGISTRY_MAX_STALE_MS + 1);
    await expect(mod.loadProfileRegistry()).rejects.toThrow(/ssm down/);
    expect(mod.PROFILE_REGISTRY_MAX_STALE_MS).toBe(2 * mod.PROFILE_REGISTRY_TTL_MS);
  });

  it('reads through one SSM client per container, with adaptive retry', async () => {
    const constructed: unknown[] = [];
    jest.doMock('@aws-sdk/client-ssm', () => ({
      SSMClient: class { constructor(cfg: unknown) { constructed.push(cfg); } async send() { return { Parameters: valuesOf().map((Value) => ({ Value })) }; } },
      GetParametersByPathCommand: class { constructor(public input: unknown) {} },
    }));
    jest.resetModules();
    const fresh: typeof import('../../lib/profile-registry') = require('../../lib/profile-registry');
    fresh.__setRegistryRowReaderForTest(undefined);
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    await fresh.loadProfileRegistry();
    now.mockReturnValue(start + fresh.PROFILE_REGISTRY_TTL_MS + 1);
    await fresh.loadProfileRegistry();
    expect(constructed).toEqual([expect.objectContaining({ retryMode: 'adaptive' })]);
    jest.dontMock('@aws-sdk/client-ssm');
  });
});

describe('the Cognito trigger never admits from data past its staleness', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = require('../../lambda/cognito-triggers/registry-admission.js');
  afterEach(() => {
    delete process.env.AE_PROFILE_REGISTRY_PATH;
    raw.__setRowReaderForTest(undefined);
    jest.restoreAllMocks();
  });

  it('keeps the data within twice the TTL and throws past it', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.AE_PROFILE_REGISTRY_PATH = PATH;
    let fail = false;
    raw.__setRowReaderForTest(async () => { if (fail) throw new Error('ssm down'); return withoutStandard(); });
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    const first = await raw.loadAdmission();
    expect(first.grants.premium).toEqual(['basic', 'premium']);
    fail = true;
    now.mockReturnValue(start + 5 * 60_000 + 1);
    await expect(raw.loadAdmission()).resolves.toEqual(first);
    now.mockReturnValue(start + raw.MAX_STALE_MS + 1);
    await expect(raw.loadAdmission()).rejects.toThrow(/ssm down/);
  });
});

describe('the registry\'s alarms', () => {
  it('Identity alarms on items left out and on failed reads, by the registry path, and names no classification', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { identityTemplate } = require('../helpers/synth');
    const alarms = Object.values(identityTemplate().findResources('AWS::CloudWatch::Alarm') as Record<string, { Properties: Record<string, any> }>)
      .filter((a) => a.Properties.Namespace === 'AgentEchelon/ProfileRegistry');
    expect(alarms.map((a) => a.Properties.MetricName).sort()).toEqual(['RegistryItemDropped', 'RegistryReadFailed']);
    for (const a of alarms) {
      expect(a.Properties.Dimensions).toEqual([{ Name: 'RegistryPath', Value: expect.stringMatching(/\/registry\/classification$/) }]);
    }
  });
});
