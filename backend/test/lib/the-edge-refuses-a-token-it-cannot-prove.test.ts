/**
 * THE EDGE REFUSES A TOKEN IT CANNOT PROVE (plan risk R1: the edge admits a token it should not).
 *
 * A token the edge accepts acts as its subject's AppInstanceUser, with every membership that person
 * holds, so each check `verifyToken` makes is a table here of good and bad tokens: the signature, the
 * issuer, the audience, the token type, the algorithm, the clock, the key id, a removed issuer and an
 * Entra tenant off the allowlist. Plus a fuzz of the header `alg`.
 *
 * Every key is generated here and every JWKS and discovery document is served from memory by a stub
 * fetcher, so nothing reaches the network. The registry is the real one, parsed by `issuerRegistry` and
 * passed through its travelling form (`edgeIssuers`, then `expandIssuer`), exactly as the edge function
 * reads it.
 */
import { __setFetcherForTests, TokenRefused, verifyToken, type RefusalCode } from '../../lambda/src/lib/token-verification';
import { __resetTrustedIssuersForTests } from '../../lambda/src/lib/trusted-issuers';
import { edgeIssuers, edgeVerificationErrors, type EdgeIssuer } from '../../lib/config/edge-verification';
import { expandIssuer, issuerErrors, issuerRegistry } from '../../lib/config/issuers';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { StubFetcher, ecKey, hmacWithPublicKey, jwks, nowSeconds, rsaKey, signToken, unsignedToken, type TestKey } from '../helpers/jwt-fixtures';

const REGION = 'us-east-1';
const SELF_POOL = 'us-east-1_SelfPool';
const SELF_CLIENT = 'self-client';
const PARTNER_POOL = 'us-east-1_Partner';
const HOST_POOL = 'us-east-1_HostApp';
const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER_TENANT = '99999999-8888-7777-6666-555555555555';
/** A second allowlisted tenant, for an entry that allowlists several. */
const SECOND_TENANT = '22222222-3333-4444-5555-666666666666';
const ALL = ['basic', 'standard', 'premium', 'admin'];

const cognitoIss = (pool: string) => `https://cognito-idp.${REGION}.amazonaws.com/${pool}`;
const cognitoJwks = (pool: string) => `${cognitoIss(pool)}/.well-known/jwks.json`;
const OKTA_ISS = 'https://idp.example.com';
const OKTA_DISCOVERY = `${OKTA_ISS}/.well-known/openid-configuration`;
const OKTA_JWKS = `${OKTA_ISS}/keys`;
const API_ISS = 'https://api-idp.example.com';
const API_DISCOVERY = `${API_ISS}/.well-known/openid-configuration`;
const API_JWKS = `${API_ISS}/keys`;
const entraIss = (tenant: string) => `https://login.microsoftonline.com/${tenant}/v2.0`;
const entraJwks = (tenant: string) => `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`;

const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true },
  { id: 'partner', kind: 'cognito-pool', pool: PARTNER_POOL, audience: 'partner-client', tokenUse: 'access', clearance: { fixed: ['basic'], classifications: ['basic'] } },
  { id: 'host', kind: 'cognito-pool', pool: HOST_POOL, audience: 'host-client', clearance: { oneChannel: 'basic', classifications: ['basic'] } },
  // A DIRECT OIDC PROVIDER, verified against its discovery document and the keys it publishes.
  { id: 'okta', kind: 'oidc', issuer: OKTA_ISS, discoveryUrl: OKTA_DISCOVERY, audience: 'okta-client', algorithm: 'ES256', clearance: { fixed: ['basic'], classifications: ['basic'] } },
  { id: 'api', kind: 'oidc', issuer: API_ISS, discoveryUrl: API_DISCOVERY, audience: 'api-client', tokenUse: 'access', clearance: { fixed: ['basic'], classifications: ['basic'] } },
  {
    id: 'entra', kind: 'oidc-entra', tenants: [TENANT, SECOND_TENANT], tokenVersion: 2,
    discoveryUrl: 'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration',
    audience: 'entra-client', clearance: { mapping: { claim: 'roles', values: { 'AE.Basic': 'basic' } }, classifications: ['basic'] },
  },
];

/** The registry as the edge function reads it: validated, given its verification, travelled and expanded. */
function edgeRegistry(raw: unknown[] = REGISTRY): EdgeIssuer[] {
  return edgeIssuers(issuerRegistry(raw, profiles), SELF_POOL, REGION, [SELF_CLIENT])
    .map((t) => expandIssuer(JSON.parse(JSON.stringify(t))) as EdgeIssuer);
}

const selfKey = rsaKey('self-1');
const partnerKey = rsaKey('partner-1');
const hostKey = rsaKey('host-1');
const oktaKey = ecKey('okta-1');
const apiKey = rsaKey('api-1');
const entraKey = rsaKey('entra-1');
const attackerKey = rsaKey('self-1'); // the same kid as the deployment's key, a different key

let fetcher: StubFetcher;
beforeEach(() => {
  fetcher = new StubFetcher()
    .set(cognitoJwks(SELF_POOL), jwks(selfKey))
    .set(cognitoJwks(PARTNER_POOL), jwks(partnerKey))
    .set(cognitoJwks(HOST_POOL), jwks(hostKey))
    .set(OKTA_DISCOVERY, { issuer: OKTA_ISS, jwks_uri: OKTA_JWKS })
    .set(OKTA_JWKS, jwks(oktaKey))
    .set(API_DISCOVERY, { issuer: API_ISS, jwks_uri: API_JWKS })
    .set(API_JWKS, jwks(apiKey))
    .set(entraJwks(TENANT), jwks(entraKey))
    .set(entraJwks(OTHER_TENANT), jwks(entraKey));
  __setFetcherForTests(fetcher);
});
afterAll(() => __setFetcherForTests());

const life = (over: Record<string, unknown> = {}) => ({ iat: nowSeconds(), exp: nowSeconds() + 600, ...over });

/** A good token from each issuer, as its clients present it. */
const good = {
  deployment: (over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => signToken(selfKey, {
    iss: cognitoIss(SELF_POOL), aud: SELF_CLIENT, token_use: 'id', sub: 'sub-self', 'cognito:groups': ['basic'], ...life(), ...over,
  }, header),
  partner: (over: Record<string, unknown> = {}) => signToken(partnerKey, {
    iss: cognitoIss(PARTNER_POOL), client_id: 'partner-client', token_use: 'access', sub: 'sub-partner', ...life(), ...over,
  }),
  host: (over: Record<string, unknown> = {}) => signToken(hostKey, {
    iss: cognitoIss(HOST_POOL), aud: 'host-client', token_use: 'id', sub: 'sub-host', ...life(), ...over,
  }),
  okta: (over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => signToken(oktaKey, {
    iss: OKTA_ISS, aud: 'okta-client', sub: 'sub-okta', ...life(), ...over,
  }, header),
  api: (over: Record<string, unknown> = {}, header: Record<string, unknown> = { typ: 'at+jwt' }) => signToken(apiKey, {
    iss: API_ISS, aud: 'api-client', sub: 'sub-api', scp: 'chat', ...life(), ...over,
  }, header),
  entra: (over: Record<string, unknown> = {}) => signToken(entraKey, {
    iss: entraIss(TENANT), aud: 'entra-client', tid: TENANT, oid: 'oid-1', roles: ['AE.Basic'], ...life(), ...over,
  }),
};

async function refusal(token: string, issuers: EdgeIssuer[] = edgeRegistry()): Promise<RefusalCode | 'accepted'> {
  try {
    await verifyToken(token, issuers);
    return 'accepted';
  } catch (err) {
    if (err instanceof TokenRefused) return err.code;
    throw err;
  }
}

describe('a good token from every issuer kind is accepted, as the entry it comes from', () => {
  it.each([
    ['deployment (Cognito ID token)', () => good.deployment(), 'deployment'],
    ['partner (Cognito access token)', () => good.partner(), 'partner'],
    ['host (one-conversation Cognito pool)', () => good.host(), 'host'],
    ['okta (OIDC ID token, ES256)', () => good.okta(), 'okta'],
    ['api (OIDC access token, at+jwt)', () => good.api(), 'api'],
    ['entra (tenant on the allowlist)', () => good.entra(), 'entra'],
  ])('%s', async (_name, token, id) => {
    const v = await verifyToken(token(), edgeRegistry());
    expect(v.issuer.id).toBe(id);
  });
});

describe('the signature', () => {
  it.each<[string, () => string]>([
    ['signed by another key under the deployment key id', () => signToken(attackerKey, {
      iss: cognitoIss(SELF_POOL), aud: SELF_CLIENT, token_use: 'id', sub: 'sub-self', ...life(),
    })],
    ['a genuine signature over a changed payload', () => {
      const [h, , s] = good.deployment().split('.');
      const forged = Buffer.from(JSON.stringify({ iss: cognitoIss(SELF_POOL), aud: SELF_CLIENT, token_use: 'id', sub: 'someone-else', ...life() })).toString('base64url');
      return `${h}.${forged}.${s}`;
    }],
    ['a genuine signature from one issuer presented under another', () => {
      const [, , s] = good.partner().split('.');
      const [h, p] = good.deployment().split('.');
      return `${h}.${p}.${s}`;
    }],
  ])('%s is refused', async (_name, token) => {
    expect(await refusal(token())).toBe('signature');
  });
});

describe('the issuer is matched exactly against the registry', () => {
  it.each<[string, () => string, RefusalCode]>([
    ['a pool the registry does not declare', () => signToken(selfKey, { iss: cognitoIss('us-east-1_Stranger'), aud: SELF_CLIENT, token_use: 'id', sub: 's', ...life() }), 'unknown-issuer'],
    ['the deployment pool in another region', () => signToken(selfKey, { iss: `https://cognito-idp.us-west-2.amazonaws.com/${SELF_POOL}`, aud: SELF_CLIENT, token_use: 'id', sub: 's', ...life() }), 'unknown-issuer'],
    ['the deployment pool with a trailing slash', () => signToken(selfKey, { iss: `${cognitoIss(SELF_POOL)}/`, aud: SELF_CLIENT, token_use: 'id', sub: 's', ...life() }), 'unknown-issuer'],
    ['an OIDC issuer differing only by case', () => signToken(oktaKey, { iss: 'https://IDP.example.com', aud: 'okta-client', sub: 's', ...life() }), 'unknown-issuer'],
    ['no issuer at all', () => signToken(selfKey, { aud: SELF_CLIENT, token_use: 'id', sub: 's', ...life() }), 'unknown-issuer'],
    ['a provider the pool has that the registry does not declare', () => good.deployment({ identities: [{ providerName: 'Undeclared' }] }), 'unknown-issuer'],
  ])('%s is refused', async (_name, token, code) => {
    expect(await refusal(token())).toBe(code);
  });

  it('an OIDC discovery document naming another issuer makes that issuer unverifiable', async () => {
    fetcher.set(OKTA_DISCOVERY, { issuer: 'https://evil.example.com', jwks_uri: OKTA_JWKS });
    __setFetcherForTests(fetcher);
    expect(await refusal(good.okta())).toBe('not-verifiable');
  });
});

describe('the audience is checked per issuer', () => {
  it.each<[string, () => string]>([
    ['a deployment ID token for another client', () => good.deployment({ aud: 'some-other-client' })],
    ['a partner access token for another client', () => good.partner({ client_id: 'self-client' })],
    ['a host token carrying the deployment client id', () => good.host({ aud: SELF_CLIENT })],
    ['an OIDC ID token for another client', () => good.okta({ aud: 'another-relying-party' })],
    ['an OIDC token with no audience', () => good.okta({ aud: undefined })],
    ['an Entra token for another application', () => good.entra({ aud: 'api://someone-else' })],
  ])('%s is refused', async (_name, token) => {
    expect(await refusal(token())).toBe('audience');
  });
});

describe('the token type is the one the issuer declares', () => {
  it.each<[string, () => string]>([
    ['a Cognito access token where the ID token is declared', () => signToken(selfKey, {
      iss: cognitoIss(SELF_POOL), client_id: SELF_CLIENT, token_use: 'access', sub: 'sub-self', ...life(),
    })],
    ['a Cognito ID token where the access token is declared', () => signToken(partnerKey, {
      iss: cognitoIss(PARTNER_POOL), aud: 'partner-client', token_use: 'id', sub: 'sub-partner', ...life(),
    })],
    ['a Cognito token with no token_use', () => good.deployment({ token_use: undefined })],
    ['an OIDC access token (at+jwt) where the ID token is declared', () => good.okta({}, { typ: 'at+jwt' })],
    ['an OIDC token carrying an OAuth scope where the ID token is declared', () => good.okta({ scp: 'chat' })],
    ['an OIDC ID token where the access token is declared', () => good.api({}, { typ: 'JWT' })],
  ])('%s is refused', async (_name, token) => {
    expect(await refusal(token())).toBe('token-use');
  });

  it('an access token marked by its declared claim, not the header type, is accepted where that claim is declared', async () => {
    const raw = REGISTRY.map((e) => (e.id === 'api' ? { ...e, tokenType: { claim: 'token_class', value: 'access_token' } } : e));
    const token = good.api({ token_class: 'access_token' }, { typ: 'JWT' });
    expect(await refusal(token, edgeRegistry(raw))).toBe('accepted');
    expect(await refusal(good.api({ token_class: 'id_token' }, { typ: 'JWT' }), edgeRegistry(raw))).toBe('token-use');
  });
});

describe('only the declared algorithm is accepted', () => {
  const payload = () => ({ iss: cognitoIss(SELF_POOL), aud: SELF_CLIENT, token_use: 'id', sub: 'sub-self', ...life() });

  it('alg none, with or without a signature, is refused before any key is read', async () => {
    expect(await refusal(unsignedToken({ alg: 'none', typ: 'JWT' }, payload(), 'c2ln'))).toBe('algorithm');
    // With the signature segment left empty, as alg none is usually sent, it is not even a JWT.
    expect(await refusal(unsignedToken({ alg: 'none', typ: 'JWT' }, payload()))).toBe('malformed');
    expect(await refusal(unsignedToken({ alg: 'none', kid: 'self-1' }, payload(), 'c2ln'))).toBe('algorithm');
    expect(fetcher.readsOf(cognitoJwks(SELF_POOL))).toBe(0);
  });

  it('an HS256 token whose secret is the issuer\'s public key (key confusion) is refused before any key is read', async () => {
    expect(await refusal(hmacWithPublicKey(selfKey, payload()))).toBe('algorithm');
    expect(fetcher.readsOf(cognitoJwks(SELF_POOL))).toBe(0);
  });

  it('a genuine RS256 signature at an issuer that declares ES256 is refused', async () => {
    const rsaUnderOkta = rsaKey('okta-1');
    fetcher.set(OKTA_JWKS, jwks(oktaKey, { ...rsaUnderOkta, jwk: { ...rsaUnderOkta.jwk, kid: 'okta-rsa' } } as TestKey));
    const token = signToken(rsaUnderOkta, { iss: OKTA_ISS, aud: 'okta-client', sub: 's', ...life() }, { kid: 'okta-rsa' });
    expect(await refusal(token)).toBe('algorithm');
  });

  it('a genuine ES256 signature at an issuer that declares RS256 is refused', async () => {
    const ecUnderSelf = ecKey('self-ec');
    fetcher.set(cognitoJwks(SELF_POOL), jwks(selfKey, ecUnderSelf));
    const token = signToken(ecUnderSelf, payload());
    expect(await refusal(token)).toBe('algorithm');
  });

  it.each<[string, Record<string, unknown>]>([
    ['an embedded jwk', { jwk: selfKey.jwk }],
    ['a jku pointing elsewhere', { jku: 'https://evil.example.com/keys' }],
    ['an x5u pointing elsewhere', { x5u: 'https://evil.example.com/cert' }],
    ['an x5c chain', { x5c: ['MIIB'] }],
    ['a crit extension', { crit: ['exp'] }],
  ])('a header carrying %s is refused', async (_name, header) => {
    expect(await refusal(good.deployment({}, header))).toBe('embedded-key');
  });

  // THE FUZZ: every header `alg` but the declared one is refused, whatever the signature.
  const FUZZ: unknown[] = [
    'none', 'None', 'NONE', 'nOnE', '', ' RS256', 'RS256 ', 'rs256', 'HS256', 'HS384', 'HS512', 'hs256',
    'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES384', 'ES512', 'EdDSA', 'Ed25519', 'RSA-OAEP', 'dir',
    null, 0, 256, true, [], ['RS256'], { RS256: true },
  ];
  it.each(FUZZ.map((alg) => [JSON.stringify(alg), alg]))('alg %s is refused at an RS256 issuer', async (_label, alg) => {
    // A string is refused by the pin; anything else is not a JWT header the parser accepts.
    const expected: RefusalCode = typeof alg === 'string' ? 'algorithm' : 'malformed';
    const [, p, s] = good.deployment().split('.');
    const h = Buffer.from(JSON.stringify({ alg, kid: 'self-1', typ: 'JWT' })).toString('base64url');
    expect(await refusal(`${h}.${p}.${s}`)).toBe(expected);
  });

  it('a header with no alg is refused', async () => {
    expect(await refusal(unsignedToken({ kid: 'self-1', typ: 'JWT' }, payload(), 'c2ln'))).toBe('algorithm');
  });
});

describe('exp and nbf, with at most 60 seconds of skew', () => {
  it.each<[string, () => string, RefusalCode | 'accepted']>([
    ['expired two minutes ago', () => good.deployment({ exp: nowSeconds() - 120 }), 'expired'],
    ['expired an hour ago', () => good.deployment({ exp: nowSeconds() - 3600 }), 'expired'],
    ['expired 90 seconds ago (over the skew)', () => good.deployment({ exp: nowSeconds() - 90 }), 'expired'],
    ['expired 30 seconds ago (inside the skew)', () => good.deployment({ exp: nowSeconds() - 30 }), 'accepted'],
    ['not valid for two more minutes', () => good.deployment({ nbf: nowSeconds() + 120 }), 'not-yet-valid'],
    ['not valid for 90 more seconds (over the skew)', () => good.deployment({ nbf: nowSeconds() + 90 }), 'not-yet-valid'],
    ['not valid for 30 more seconds (inside the skew)', () => good.deployment({ nbf: nowSeconds() + 30 }), 'accepted'],
    ['carrying no expiry', () => good.okta({ exp: undefined }), 'no-expiry'],
    ['from an OIDC issuer, expired two minutes ago', () => good.okta({ exp: nowSeconds() - 120 }), 'expired'],
  ])('a token %s', async (_name, token, expected) => {
    expect(await refusal(token())).toBe(expected);
  });
});

describe('keys are fetched once and cached by kid', () => {
  it('a second token from the same issuer reads no key again', async () => {
    const issuers = edgeRegistry();
    await verifyToken(good.deployment(), issuers);
    await verifyToken(good.deployment({ sub: 'another' }), issuers);
    expect(fetcher.readsOf(cognitoJwks(SELF_POOL))).toBe(1);
  });

  it('an unknown kid refetches the keys once, then is refused, and a repeat does not fetch again', async () => {
    const issuers = edgeRegistry();
    await verifyToken(good.deployment(), issuers);
    const stranger = rsaKey('not-published');
    const token = signToken(stranger, { iss: cognitoIss(SELF_POOL), aud: SELF_CLIENT, token_use: 'id', sub: 's', ...life() });
    expect(await refusal(token, issuers)).toBe('unknown-key');
    expect(fetcher.readsOf(cognitoJwks(SELF_POOL))).toBe(2);
    expect(await refusal(token, issuers)).toBe('unknown-key');
    expect(fetcher.readsOf(cognitoJwks(SELF_POOL))).toBe(2);
  });

  it('a rotated key is found by the one refetch', async () => {
    const issuers = edgeRegistry();
    await verifyToken(good.deployment(), issuers);
    const next = rsaKey('self-2');
    fetcher.set(cognitoJwks(SELF_POOL), jwks(selfKey, next));
    const token = signToken(next, { iss: cognitoIss(SELF_POOL), aud: SELF_CLIENT, token_use: 'id', sub: 's', ...life() });
    expect(await refusal(token, issuers)).toBe('accepted');
    expect(fetcher.readsOf(cognitoJwks(SELF_POOL))).toBe(2);
  });

  it('a token with no kid is refused', async () => {
    expect(await refusal(good.deployment({}, { kid: undefined }))).toBe('unknown-key');
  });

  it('keys that cannot be fetched refuse the token', async () => {
    fetcher.documents.delete(cognitoJwks(SELF_POOL));
    expect(await refusal(good.deployment())).not.toBe('accepted');
  });
});

describe('a removed issuer', () => {
  it('is refused by a registry that no longer declares it', async () => {
    expect(await refusal(good.partner())).toBe('accepted');
    expect(await refusal(good.partner(), edgeRegistry(REGISTRY.filter((e) => e.id !== 'partner')))).toBe('unknown-issuer');
  });

  it('is refused on the first request after the function\'s registry changes', async () => {
    const before = process.env.TRUSTED_ISSUERS;
    try {
      __resetTrustedIssuersForTests();
      process.env.TRUSTED_ISSUERS = JSON.stringify(edgeRegistry());
      await expect(verifyToken(good.partner())).resolves.toMatchObject({ issuer: { id: 'partner' } });
      process.env.TRUSTED_ISSUERS = JSON.stringify(edgeRegistry(REGISTRY.filter((e) => e.id !== 'partner')));
      await expect(verifyToken(good.partner())).rejects.toMatchObject({ code: 'unknown-issuer' });
    } finally {
      if (before === undefined) delete process.env.TRUSTED_ISSUERS; else process.env.TRUSTED_ISSUERS = before;
      __resetTrustedIssuersForTests();
    }
  });

  it('an unreadable registry trusts nobody', async () => {
    const before = process.env.TRUSTED_ISSUERS;
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      __resetTrustedIssuersForTests();
      process.env.TRUSTED_ISSUERS = '{not json';
      await expect(verifyToken(good.deployment())).rejects.toMatchObject({ code: 'unknown-issuer' });
    } finally {
      quiet.mockRestore();
      if (before === undefined) delete process.env.TRUSTED_ISSUERS; else process.env.TRUSTED_ISSUERS = before;
      __resetTrustedIssuersForTests();
    }
  });

  it('an entry that reached the edge without its verification is refused', async () => {
    const bare = edgeRegistry().map(({ verify: _v, ...rest }) => rest as EdgeIssuer);
    expect(await refusal(good.deployment(), bare)).toBe('not-verifiable');
  });
});

describe('Entra: the tenant template plus the allowlist', () => {
  it.each<[string, () => string]>([
    ['a tenant not on the allowlist, signed with Entra\'s keys', () => signToken(entraKey, {
      iss: entraIss(OTHER_TENANT), aud: 'entra-client', tid: OTHER_TENANT, oid: 'oid-1', ...life(),
    })],
    ['an allowlisted tid under another tenant\'s issuer', () => good.entra({ iss: entraIss(OTHER_TENANT) })],
    ['another tenant\'s tid under the allowlisted issuer', () => good.entra({ tid: OTHER_TENANT })],
    ['the v1 issuer at a v2 entry', () => good.entra({ iss: `https://sts.windows.net/${TENANT}/` })],
    ['no tid', () => good.entra({ tid: undefined })],
  ])('%s is refused', async (_name, token) => {
    expect(await refusal(token())).toBe('unknown-issuer');
  });
});

describe('a malformed token', () => {
  it.each<[string, () => string]>([
    ['an empty signature segment', () => good.deployment().split('.').slice(0, 2).join('.') + '.'],
    ['an empty string', () => ''],
    ['one segment', () => 'abc'],
    ['two segments', () => 'eyJhbGciOiJSUzI1NiJ9.e30'],
    ['segments that are not JSON', () => 'a.b.c'],
    ['empty segments', () => '...'],
    ['segments that decode to nothing', () => `${'x'.repeat(10)}.${'y'.repeat(10)}.z`],
  ])('%s is refused', async (_name, token) => {
    const t = token();
    expect(await refusal(t)).toBe('malformed');
  });
});

describe('the registry declares how its tokens are verified', () => {
  const synthErrors = (entry: Record<string, unknown>) => issuerErrors([REGISTRY[0], entry], profiles);

  it('refuses an algorithm that is not RS256 or ES256', () => {
    for (const algorithm of ['none', 'HS256', 'EdDSA', 'RS512']) {
      expect(synthErrors({ ...REGISTRY[3], algorithm }).join('\n')).toMatch(/algorithm is one of RS256, ES256/);
    }
    expect(synthErrors({ ...REGISTRY[3], algorithm: 'ES256' })).toEqual([]);
  });

  it('refuses a token-type claim anywhere but an OIDC access-token entry', () => {
    expect(synthErrors({ ...REGISTRY[1], tokenType: { claim: 'x', value: 'y' } }).join('\n')).toMatch(/tokenType marks an OIDC access token/);
    expect(synthErrors({ ...REGISTRY[3], tokenType: { claim: 'x', value: 'y' } }).join('\n')).toMatch(/tokenType marks an OIDC access token/);
    expect(synthErrors({ ...REGISTRY[4], tokenType: { claim: 'x', value: 'y' } })).toEqual([]);
  });

  it('refuses an empty Cognito audience', () => {
    expect(synthErrors({ ...REGISTRY[1], audience: [] }).join('\n')).toMatch(/audience lists the app client ids/);
  });

  it('the edge refuses a foreign pool that declares no audience, and the deployment pool without its client ids', () => {
    const noAudience = REGISTRY.map((e) => (e.id === 'partner' ? { ...e, audience: undefined } : e));
    expect(edgeVerificationErrors(issuerRegistry(noAudience, profiles), [SELF_CLIENT]).join('\n'))
      .toMatch(/issuer "partner": declares no audience/);
    expect(edgeVerificationErrors(issuerRegistry(REGISTRY, profiles), []).join('\n'))
      .toMatch(/issuer "deployment": the edge authorizer needs this deployment's app client ids/);
    expect(() => edgeIssuers(issuerRegistry(noAudience, profiles), SELF_POOL, REGION, [SELF_CLIENT])).toThrow(/cannot verify this registry/);
    expect(edgeVerificationErrors(issuerRegistry(REGISTRY, profiles), [SELF_CLIENT])).toEqual([]);
  });

  it('defaults: an ID token, RS256, and the deployment pool\'s own clients as its audience', () => {
    const self = edgeRegistry().find((e) => e.id === 'deployment')!;
    expect(self.verify).toEqual({ audience: [SELF_CLIENT], tokenUse: 'id', algorithm: 'RS256' });
    expect(edgeRegistry().find((e) => e.id === 'okta')!.verify).toEqual({
      audience: ['okta-client'], tokenUse: 'id', algorithm: 'ES256', discoveryUrl: OKTA_DISCOVERY, maxLifetimeSeconds: 90 * 60,
    });
  });
});

describe('a direct provider\'s token is bounded, and an entry can require what makes it its own', () => {
  const bounded = () => edgeRegistry(REGISTRY.map((e) => ((e as { id: string }).id === 'okta'
    ? { ...(e as object), maxLifetimeMinutes: 30, requiredClaims: { hd: 'example.com' } } : e)));

  it('refuses a token living longer than the entry allows, from its own iat', async () => {
    expect(await refusal(good.okta({ hd: 'example.com' }), bounded())).toBe('accepted');
    expect(await refusal(good.okta({ hd: 'example.com', iat: nowSeconds(), exp: nowSeconds() + 31 * 60 }), bounded())).toBe('lifetime');
    expect(await refusal(good.okta({ hd: 'example.com', iat: undefined }), bounded())).toBe('lifetime');
  });

  it('refuses a token without the required claim, or with another value', async () => {
    expect(await refusal(good.okta(), bounded())).toBe('required-claim');
    expect(await refusal(good.okta({ hd: 'attacker.example' }), bounded())).toBe('required-claim');
  });

  it('bounds a direct token at 90 minutes when the entry declares nothing', async () => {
    expect(await refusal(good.okta({ iat: nowSeconds(), exp: nowSeconds() + 89 * 60 }))).toBe('accepted');
    expect(await refusal(good.okta({ iat: nowSeconds(), exp: nowSeconds() + 91 * 60 }))).toBe('lifetime');
  });
});
