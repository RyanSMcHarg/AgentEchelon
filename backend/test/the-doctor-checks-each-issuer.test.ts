/**
 * THE DOCTOR CHECKS EACH TRUSTED ISSUER: its pool exists, its discovery URL answers (A2).
 *
 * Synth validates the registry's shape and cannot know whether a pool id names a pool or a discovery
 * document is reachable, so `npm run doctor` asks (`scripts/lib/issuer-checks.cjs`). The lookups are
 * stubbed here: no AWS call and no HTTP request is made.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkIssuers, issuersFromConfig } = require('../scripts/lib/issuer-checks.cjs') as {
  checkIssuers: (issuers: unknown[], deps: {
    describePool: (id: string) => Promise<unknown>;
    fetchDiscovery: (url: string) => Promise<{ issuer?: string }>;
  }) => Promise<Array<{ issuer: string; check: string; ok: boolean; detail: string }>>;
  issuersFromConfig: (config: unknown) => unknown[];
};

const TENANT = '11111111-2222-3333-4444-555555555555';
const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self' },
  { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp' },
  { id: 'okta', kind: 'oidc', issuer: 'https://idp.example.com', discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration' },
  { id: 'entra', kind: 'oidc-entra', tenants: [TENANT], discoveryUrl: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration` },
];

const unreachable = () => Object.assign(new Error('getaddrinfo ENOTFOUND idp.example.com'), { name: 'FetchError' });

describe('the doctor checks each trusted issuer', () => {
  it('passes a registry whose pools exist and whose discovery documents answer as the declared issuer', async () => {
    const describePool = jest.fn(async () => ({}));
    const fetchDiscovery = jest.fn(async (url: string) => ({
      issuer: url.includes('microsoftonline') ? `https://login.microsoftonline.com/${TENANT}/v2.0` : 'https://idp.example.com',
    }));
    const results = await checkIssuers(REGISTRY, { describePool, fetchDiscovery });
    expect(results.map((r) => [r.issuer, r.check, r.ok])).toEqual([
      ['deployment', 'pool', true], ['host', 'pool', true], ['okta', 'discovery', true], ['entra', 'discovery', true],
    ]);
    // This deployment's own pool does not exist before its deploy, so it is not looked up.
    expect(describePool).toHaveBeenCalledTimes(1);
    expect(describePool).toHaveBeenCalledWith('us-east-1_HostApp');
  });

  it('fails an issuer whose discovery URL does not answer, naming why', async () => {
    const results = await checkIssuers(REGISTRY, {
      describePool: async () => ({}),
      fetchDiscovery: async (url: string) => { if (url.includes('idp.example.com')) throw unreachable(); return { issuer: `https://login.microsoftonline.com/${TENANT}/v2.0` }; },
    });
    const okta = results.find((r) => r.issuer === 'okta')!;
    expect(okta.ok).toBe(false);
    expect(okta.detail).toMatch(/did not answer: FetchError/);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });

  it('fails a pool that does not exist, and a discovery document advertising another issuer', async () => {
    const results = await checkIssuers(REGISTRY, {
      describePool: async () => { throw Object.assign(new Error('pool does not exist'), { name: 'ResourceNotFoundException' }); },
      fetchDiscovery: async () => ({ issuer: 'https://someone-else.example.com' }),
    });
    expect(results.find((r) => r.issuer === 'host')).toMatchObject({ ok: false, detail: expect.stringMatching(/ResourceNotFoundException/) });
    expect(results.find((r) => r.issuer === 'okta')).toMatchObject({ ok: false, detail: expect.stringMatching(/advertises issuer "https:\/\/someone-else\.example\.com"/) });
    expect(results.find((r) => r.issuer === 'entra')!.ok).toBe(false);
  });

  it('checks the pinned keys of a host assertion, which have no discovery to ask, and asks nothing of the guest', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { generateKeyPairSync } = require('crypto') as typeof import('crypto');
    const key = (generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
    const describePool = jest.fn(async () => ({}));
    const fetchDiscovery = jest.fn(async () => ({}));
    const results = await checkIssuers([
      { id: 'sf', kind: 'host-assertion', hostAssertion: { publicKeys: { k1: key } } },
      { id: 'sf-bad', kind: 'host-assertion', hostAssertion: { publicKeys: { k1: 'bm90IGEga2V5' } } },
      { id: 'sf-none', kind: 'host-assertion' },
      { id: 'guest', kind: 'guest' },
    ], { describePool, fetchDiscovery });
    expect(results.map((r) => [r.issuer, r.check, r.ok])).toEqual([['sf', 'keys', true], ['sf-bad', 'keys', false], ['sf-none', 'keys', false], ['guest', 'kind', true]]);
    expect(describePool).not.toHaveBeenCalled();
    expect(fetchDiscovery).not.toHaveBeenCalled();
  });

  it('reads the registry from deploy.config.json as an array or its JSON, and none as none', () => {
    expect(issuersFromConfig({ issuers: REGISTRY })).toEqual(REGISTRY);
    expect(issuersFromConfig({ issuers: JSON.stringify(REGISTRY) })).toEqual(REGISTRY);
    expect(issuersFromConfig({})).toEqual([]);
  });

  it('is what npm run doctor runs', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const doctor = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deployment-doctor.mjs'), 'utf8');
    expect(doctor).toContain("createRequire(import.meta.url)('./lib/issuer-checks.cjs')");
    expect(doctor).toMatch(/await checkIssuers\(issuers,/);
  });
});
