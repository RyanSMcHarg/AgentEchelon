/**
 * A VPC-ATTACHED HANDLER READS THE REGISTRY'S S3 COPY, AND SERVES THE SAME SET THE PARAMETERS WOULD.
 *
 * A function in the analytics VPC is told the copy (`PROFILE_REGISTRY_S3_ENV`) and has no route to SSM, so
 * `loadProfileRegistry` reads the objects under its prefix and never calls SSM. Everything after the read is the
 * loader's own: the per-item assembly, the TTL, the staleness and the metrics are the same for either source.
 */
import {
  DEFAULT_PROFILES_CONFIG, PROFILE_REGISTRY_PATH_ENV, PROFILE_REGISTRY_S3_ENV, registryRowsOf, registryRowValue,
} from '../../lib/config/profiles';

const PATH = '/test-instance/registry/classification';
const LOCATION = 's3://test-instance-registry-111111111111-us-east-1/registry/classification/';
const values = registryRowsOf(DEFAULT_PROFILES_CONFIG).map(registryRowValue);
const keyOf = (i: number) => `registry/classification/${registryRowsOf(DEFAULT_PROFILES_CONFIG)[i].classification.value}`;

type Sent = { name: string; input: Record<string, unknown> };

/** A fake S3 that lists the rows two to a page, and records what it was sent and how its client was made. */
function fakeS3(objects: Record<string, string>, opts: { vanish?: string } = {}) {
  const sent: Sent[] = [];
  const constructed: unknown[] = [];
  const keys = Object.keys(objects);
  class ListObjectsV2Command { name = 'List'; constructor(public input: Record<string, unknown>) {} }
  class GetObjectCommand { name = 'Get'; constructor(public input: Record<string, unknown>) {} }
  class S3Client {
    constructor(cfg: unknown) { constructed.push(cfg); }
    async send(cmd: Sent) {
      sent.push({ name: cmd.name, input: cmd.input });
      if (cmd.name === 'List') {
        const start = Number(cmd.input.ContinuationToken ?? 0);
        const page = keys.slice(start, start + 2);
        const more = start + 2 < keys.length;
        return { Contents: [...(start === 0 ? [{ Key: 'registry/classification/' }] : []), ...page.map((Key) => ({ Key }))],
          IsTruncated: more, NextContinuationToken: more ? String(start + 2) : undefined };
      }
      const key = String(cmd.input.Key);
      if (key === opts.vanish) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => objects[key] } };
    }
  }
  return { module: { S3Client, ListObjectsV2Command, GetObjectCommand }, sent, constructed };
}

describe('a VPC-attached handler reads the S3 copy of the rows', () => {
  const ssmSends: unknown[] = [];
  beforeEach(() => {
    jest.resetModules();
    process.env[PROFILE_REGISTRY_PATH_ENV] = PATH;
    process.env[PROFILE_REGISTRY_S3_ENV] = LOCATION;
    ssmSends.length = 0;
    jest.doMock('@aws-sdk/client-ssm', () => ({
      SSMClient: class { async send(c: unknown) { ssmSends.push(c); throw new Error('no route to SSM'); } },
      GetParametersByPathCommand: class { constructor(public input: unknown) {} },
    }));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env[PROFILE_REGISTRY_PATH_ENV];
    delete process.env[PROFILE_REGISTRY_S3_ENV];
    jest.dontMock('@aws-sdk/client-s3');
    jest.dontMock('@aws-sdk/client-ssm');
    jest.restoreAllMocks();
    jest.resetModules();
  });

  const load = (s3: ReturnType<typeof fakeS3>) => {
    jest.doMock('@aws-sdk/client-s3', () => s3.module);
    const mod: typeof import('../../lib/profile-registry') = require('../../lib/profile-registry');
    mod.__setRegistryRowReaderForTest(undefined);
    return mod;
  };

  it('serves the set the parameters serve, read from every page under the prefix, and never calls SSM', async () => {
    const objects = Object.fromEntries(values.map((v, i) => [keyOf(i), v]));
    const s3 = fakeS3(objects);
    const mod = load(s3);
    await mod.loadProfileRegistry();
    const { ProfileRegistry } = mod;
    const expected = new ProfileRegistry(require('../../lib/config/profiles').profilesConfigFromPublishedRows(values).config);
    expect(mod.defaultProfileRegistry.classificationValues().sort())
      .toEqual(expected.classificationValues().sort());
    for (const c of expected.classificationValues()) expect(mod.defaultProfileRegistry.grantsFor(c)).toEqual(expected.grantsFor(c));
    const lists = s3.sent.filter((s) => s.name === 'List');
    expect(lists.length).toBeGreaterThan(1);
    for (const l of lists) expect(l.input).toMatchObject({ Bucket: 'test-instance-registry-111111111111-us-east-1', Prefix: 'registry/classification/', Delimiter: '/' });
    expect(s3.sent.filter((s) => s.name === 'Get').map((s) => s.input.Key).sort()).toEqual(Object.keys(objects).sort());
    expect(ssmSends).toEqual([]);
  });

  it('reads once per TTL through one client with adaptive retry', async () => {
    const s3 = fakeS3(Object.fromEntries(values.map((v, i) => [keyOf(i), v])));
    const mod = load(s3);
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    await mod.loadProfileRegistry();
    const afterFirst = s3.sent.length;
    now.mockReturnValue(start + mod.PROFILE_REGISTRY_TTL_MS - 1);
    await mod.loadProfileRegistry();
    expect(s3.sent.length).toBe(afterFirst);
    now.mockReturnValue(start + mod.PROFILE_REGISTRY_TTL_MS + 1);
    await mod.loadProfileRegistry();
    expect(s3.sent.length).toBe(2 * afterFirst);
    expect(s3.constructed).toEqual([expect.objectContaining({ retryMode: 'adaptive' })]);
  });

  it('skips a row removed between the listing and its read, and leaves out the grant that names it', async () => {
    const rows = registryRowsOf(DEFAULT_PROFILES_CONFIG);
    const standard = rows.findIndex((r) => r.classification.value === 'standard');
    const s3 = fakeS3(Object.fromEntries(values.map((v, i) => [keyOf(i), v])), { vanish: keyOf(standard) });
    const mod = load(s3);
    await mod.loadProfileRegistry();
    expect(mod.defaultProfileRegistry.classificationValues()).not.toContain('standard');
    expect(mod.defaultProfileRegistry.grantsFor('premium')).toEqual(['basic', 'premium']);
  });

  it('keeps the set read before when a read fails, within twice the TTL, on the same metric path', async () => {
    const objects = Object.fromEntries(values.map((v, i) => [keyOf(i), v]));
    const s3 = fakeS3(objects);
    const mod = load(s3);
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    await mod.loadProfileRegistry();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const k of Object.keys(objects)) delete objects[k];
    s3.module.S3Client.prototype.send = async () => { throw new Error('s3 down'); };
    now.mockReturnValue(start + mod.PROFILE_REGISTRY_TTL_MS + 1);
    await expect(mod.loadProfileRegistry()).resolves.toBeDefined();
    now.mockReturnValue(start + mod.PROFILE_REGISTRY_MAX_STALE_MS + 1);
    await expect(mod.loadProfileRegistry()).rejects.toThrow(/s3 down/);
    const failed = (console.log as unknown as jest.SpyInstance).mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((d) => d?.RegistryReadFailed === 1);
    expect(failed.length).toBeGreaterThan(0);
    for (const d of failed) expect(d.RegistryPath).toBe(PATH);
  });

  it('refuses a location that is not s3://<bucket>/<prefix>/', () => {
    const mod: typeof import('../../lib/profile-registry') = require('../../lib/profile-registry');
    expect(mod.parseRegistryS3Location(LOCATION)).toEqual({ bucket: 'test-instance-registry-111111111111-us-east-1', prefix: 'registry/classification/' });
    expect(() => mod.parseRegistryS3Location('registry/classification')).toThrow(/s3:\/\/<bucket>\/<prefix>\//);
  });
});

describe('a handler outside the VPC reads the parameters', () => {
  afterEach(() => {
    delete process.env[PROFILE_REGISTRY_PATH_ENV];
    jest.dontMock('@aws-sdk/client-s3');
    jest.dontMock('@aws-sdk/client-ssm');
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('calls GetParametersByPath on the path and never S3', async () => {
    jest.resetModules();
    process.env[PROFILE_REGISTRY_PATH_ENV] = PATH;
    delete process.env[PROFILE_REGISTRY_S3_ENV];
    const ssmInputs: unknown[] = [];
    let s3Used = false;
    jest.doMock('@aws-sdk/client-ssm', () => ({
      SSMClient: class { async send(c: { input: unknown }) { ssmInputs.push(c.input); return { Parameters: values.map((Value) => ({ Value })) }; } },
      GetParametersByPathCommand: class { constructor(public input: unknown) {} },
    }));
    jest.doMock('@aws-sdk/client-s3', () => ({ S3Client: class { constructor() { s3Used = true; } } }));
    const mod: typeof import('../../lib/profile-registry') = require('../../lib/profile-registry');
    mod.__setRegistryRowReaderForTest(undefined);
    await mod.loadProfileRegistry();
    expect(ssmInputs).toEqual([expect.objectContaining({ Path: PATH })]);
    expect(s3Used).toBe(false);
  });
});
