/**
 * THE EDGE VERIFIES A HOST ASSERTION, AND ADMITS IT ONCE, AT THE EXCHANGE ALONE (A9).
 *
 * A `host-assertion` issuer is a host application (a Salesforce org) that signs a short-lived JWT for its
 * own user. The registry pins the host's public keys; there is no discovery. Each row here signs an
 * assertion with a key made in the test, standing in for the host's (a test-double signer),
 * and asserts the check that refuses it:
 *
 *  - a key the registry does not pin, a `kid` it does not name, an altered signature, another algorithm,
 *    `none` and HMAC, and an embedded key;
 *  - another deployment's audience, another issuer;
 *  - no `exp`, an expired one, one further ahead than the entry allows, and a lifetime from `iat` longer
 *    than it allows (a valid signature does not make a long-lived assertion acceptable);
 *  - no `jti`;
 *
 * then, at the edge: an assertion on any route but the exchange is refused before its `jti` is recorded;
 * on the exchange its `jti` is recorded, and the same assertion presented again is refused; a subject
 * nobody provisioned is denied every route and nothing is minted; a `pending` subject reaches the exchange
 * alone with no person in the context; a bound person reaches the exchange alone too. Every refusal is
 * counted by check. The admin plane never verifies an assertion at all.
 *
 * What only a deployment can show (the `jti` record in a real `Tokens` table under the edge's own grant,
 * the uncached exchange route) is `backend/scripts/deny-test-host-assertion.mjs`.
 */
import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'crypto';
import { decide, type EdgeRoutes } from '../../lambda/src/edge-authorizer';
import { TokenRefused, verifyToken } from '../../lambda/src/lib/token-verification';
import { edgeIssuers, type EdgeIssuer } from '../../lib/config/edge-verification';
import { expandIssuer, issuerRegistry } from '../../lib/config/issuers';
import { EXCHANGE_ROUTE } from '../../lib/constructs/edge-authorizer';
import { GUEST_ROUTES, ONE_CHANNEL_ROUTES } from '../../lib/constructs/trusted-issuers';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import type { IdentityState } from '../../lambda/src/lib/person-identity';

const DEPLOYMENT = 'test-instance';
const HOST_ISS = 'https://example.my.salesforce.com';
const ALL = ['basic', 'standard', 'premium', 'admin'];
const k1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const k2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const spki = (k: KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');

const HOST = {
  id: 'salesforce-org', kind: 'host-assertion', issuer: HOST_ISS, allowedOrigins: ['https://example.lightning.force.com'],
  hostAssertion: { publicKeys: { k1: spki(k1.publicKey), k2: spki(k2.publicKey) } },
  clearance: { mapping: { claim: 'permsets', values: { AE_Sales: 'standard' } }, classifications: ['basic', 'standard'] },
};
const EC_HOST = {
  ...HOST, id: 'ec-host', issuer: 'https://ec.example.com', algorithm: 'ES256', hostAssertion: { publicKeys: { e1: spki(ec.publicKey) }, maxMinutes: 2 },
};
const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true },
  HOST,
  EC_HOST,
];
const edgeOf = (omitGuest = false): EdgeIssuer[] => edgeIssuers(issuerRegistry(REGISTRY, profiles), 'us-east-1_Self', 'us-east-1', ['self-client'], {
  deploymentId: DEPLOYMENT, omitGuest,
}).map((t) => expandIssuer(JSON.parse(JSON.stringify(t))) as EdgeIssuer);
const issuers = edgeOf();

const now = () => Math.floor(Date.now() / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
let jtiCounter = 0;
const claims = (over: Record<string, unknown> = {}) => ({
  iss: HOST_ISS, aud: DEPLOYMENT, org: '00D000000000001', sub: '005000000000001', permsets: ['AE_Sales'],
  iat: now(), nbf: now(), exp: now() + 120, jti: `jti-${++jtiCounter}`, ...over,
});
const head = (over: Record<string, unknown> = {}) => ({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...over });
function sign(header: Record<string, unknown>, body: Record<string, unknown>, key: KeyObject = k1.privateKey): string {
  const input = `${b64(header)}.${b64(body)}`;
  const sig = header.alg === 'ES256'
    ? signBytes('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
    : signBytes('sha256', Buffer.from(input), key);
  return `${input}.${sig.toString('base64url')}`;
}

async function refusal(token: string): Promise<string> {
  try {
    await verifyToken(token, issuers);
  } catch (err) {
    if (err instanceof TokenRefused) return err.code;
    throw err;
  }
  return 'verified';
}

describe('a host assertion is checked against the keys the registry pins', () => {
  it('verifies an assertion signed by either pinned key, and an ES256 host by its own', async () => {
    expect(await refusal(sign(head(), claims()))).toBe('verified');
    expect(await refusal(sign(head({ kid: 'k2' }), claims(), k2.privateKey))).toBe('verified');
    expect(await refusal(sign({ alg: 'ES256', typ: 'JWT', kid: 'e1' }, claims({ iss: 'https://ec.example.com' }), ec.privateKey))).toBe('verified');
  });

  it.each([
    ['a key the registry does not pin', () => sign(head(), claims(), stranger.privateKey), 'signature'],
    ['a kid the registry does not name', () => sign(head({ kid: 'k9' }), claims()), 'unknown-key'],
    ['no kid', () => sign(head({ kid: undefined }), claims()), 'unknown-key'],
    ['another algorithm than the entry declares', () => sign({ alg: 'ES256', typ: 'JWT', kid: 'k1' }, claims(), ec.privateKey), 'algorithm'],
    // The classic shape, an empty signature, fails the JWT parse before any header is read.
    ['alg none with an empty signature', () => `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.`, 'malformed'],
    // With a signature segment present it parses, and the algorithm pin refuses it before any key is read.
    ['alg none', () => `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.${Buffer.from('x').toString('base64url')}`, 'algorithm'],
    ['HMAC', () => `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(claims())}.c2ln`, 'algorithm'],
    ['an embedded key', () => sign(head({ jwk: { kty: 'RSA' } }), claims()), 'embedded-key'],
    ['another deployment\'s audience', () => sign(head(), claims({ aud: 'another-instance' })), 'audience'],
    ['an issuer the registry does not declare', () => sign(head(), claims({ iss: 'https://evil.my.salesforce.com' })), 'unknown-issuer'],
    ['no expiry', () => sign(head(), claims({ exp: undefined })), 'no-expiry'],
    ['an expired assertion', () => sign(head(), claims({ iat: now() - 400, nbf: now() - 400, exp: now() - 100 })), 'expired'],
    ['an expiry further ahead than the issuer allows', () => sign(head(), claims({ exp: now() + 3600 })), 'lifetime'],
    ['no iat', () => sign(head(), claims({ iat: undefined })), 'lifetime'],
    ['a lifetime from iat longer than the issuer allows', () => sign(head(), claims({ iat: now() - 3600, exp: now() + 60 })), 'lifetime'],
    ['no jti', () => sign(head(), claims({ jti: undefined })), 'no-jti'],
    ['a jti longer than any host id', () => sign(head(), claims({ jti: 'j'.repeat(257) })), 'no-jti'],
  ])('refuses %s', async (_label, make, code) => {
    expect(await refusal(make())).toBe(code);
  });

  it('refuses an altered signature', async () => {
    const t = sign(head(), claims());
    const altered = `${t.slice(0, t.lastIndexOf('.'))}.${Buffer.from('not the signature').toString('base64url')}`;
    expect(await refusal(altered)).toBe('signature');
  });

  it('names the host on every refusal after the entry is matched, for the count by issuer and check', async () => {
    try {
      await verifyToken(sign(head(), claims({ aud: 'another' })), issuers);
      throw new Error('verified');
    } catch (err) {
      expect((err as TokenRefused).issuer).toEqual({ id: 'salesforce-org', kind: 'host-assertion' });
    }
  });

  it('is left out of the admin plane\'s edge altogether: an assertion names an issuer it does not know', async () => {
    const admin = edgeOf(true);
    expect(admin.map((i) => i.id)).toEqual(['deployment']);
    await expect(verifyToken(sign(head(), claims()), admin)).rejects.toMatchObject({ code: 'unknown-issuer' });
  });
});

describe('the edge admits an assertion once, at the exchange alone', () => {
  const routes: EdgeRoutes = { exchange: [EXCHANGE_ROUTE], oneChannel: [...ONE_CHANNEL_ROUTES], guest: [...GUEST_ROUTES] };
  const PERSON_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/test/user/0190a000-0000-7000-8000-000000000001';

  function harness(state: IdentityState) {
    const recorded = new Set<string>();
    const counted: string[] = [];
    const lookups: string[] = [];
    const deps = {
      verify: (t: string) => verifyToken(t, issuers),
      lookup: async (issuerId: string, subject: string) => { lookups.push(`${issuerId}|${subject}`); return state; },
      routes,
      recordJti: jest.fn(async (issuerId: string, jti: string) => {
        if (recorded.has(`${issuerId}|${jti}`)) return false;
        recorded.add(`${issuerId}|${jti}`);
        return true;
      }),
      countRefusal: (issuerId: string, check: string) => { counted.push(`${issuerId}:${check}`); },
    };
    return { deps, counted, lookups, recorded };
  }

  it('records the jti on the exchange, and refuses the same assertion presented again', async () => {
    const h = harness({ state: 'pending', personArn: PERSON_ARN });
    const t = sign(head(), claims());
    const first = await decide(t, h.deps, EXCHANGE_ROUTE);
    expect(first).toMatchObject({ effect: 'allow', routes: [EXCHANGE_ROUTE], reason: 'provisioned-first-sign-in' });
    // A PENDING SUBJECT HAS NO PERSON YET: the exchange binds it.
    expect((first as { context: { personId?: string } }).context.personId).toBeUndefined();
    expect(JSON.parse((first as { context: { tokenClaims: string } }).context.tokenClaims).jti).toBeDefined();
    expect(await decide(t, h.deps, EXCHANGE_ROUTE)).toEqual({ effect: 'unauthorized', reason: 'replayed' });
    expect(h.counted).toEqual(['salesforce-org:replayed']);
  });

  it('refuses an assertion on any route but the exchange, before its jti is recorded', async () => {
    const h = harness({ state: 'active', personArn: PERSON_ARN });
    const t = sign(head(), claims());
    for (const route of ['POST /create-conversation', 'GET /tasks', undefined]) {
      expect(await decide(t, h.deps, route)).toEqual({ effect: 'unauthorized', reason: 'off-route' });
    }
    expect(h.deps.recordJti).not.toHaveBeenCalled();
    expect(h.lookups).toEqual([]);
    // The same assertion is still good at the exchange: nothing was spent on the wrong route.
    expect(await decide(t, h.deps, EXCHANGE_ROUTE)).toMatchObject({ effect: 'allow', routes: [EXCHANGE_ROUTE] });
  });

  it('refuses an assertion on the admin plane', async () => {
    const h = harness({ state: 'active', personArn: PERSON_ARN });
    const admin: EdgeRoutes = { plane: 'admin', exchange: [], oneChannel: [], guest: [], admin: ['POST /exchange-credentials'] };
    expect(await decide(sign(head(), claims()), { ...h.deps, routes: admin }, 'POST /exchange-credentials')).toEqual({ effect: 'unauthorized', reason: 'off-route' });
  });

  it('denies a subject nobody provisioned every route, and sends it nowhere to be minted', async () => {
    const h = harness({ state: 'unbound' });
    expect(await decide(sign(head(), claims()), h.deps, EXCHANGE_ROUTE)).toEqual({ effect: 'deny', reason: 'not-provisioned', issuerId: 'salesforce-org' });
    expect(h.counted).toEqual(['salesforce-org:not-provisioned']);
  });

  it('admits a bound person on the exchange alone, never on every route', async () => {
    const h = harness({ state: 'active', personArn: PERSON_ARN });
    const d = await decide(sign(head(), claims()), h.deps, EXCHANGE_ROUTE);
    expect(d).toMatchObject({ effect: 'allow', routes: [EXCHANGE_ROUTE], reason: 'host-assertion' });
    expect((d as { context: { personId?: string } }).context.personId).toBe('0190a000-0000-7000-8000-000000000001');
  });

  it('denies a revoked subject', async () => {
    const h = harness({ state: 'refused', status: 'revoked' });
    expect(await decide(sign(head(), claims()), h.deps, EXCHANGE_ROUTE)).toMatchObject({ effect: 'deny', reason: 'person-revoked' });
  });

  it('counts each verification refusal by its check', async () => {
    const h = harness({ state: 'active', personArn: PERSON_ARN });
    await decide(sign(head(), claims({ aud: 'another' })), h.deps, EXCHANGE_ROUTE);
    await decide(sign(head(), claims({ exp: now() + 3600 })), h.deps, EXCHANGE_ROUTE);
    await decide(sign(head(), claims(), stranger.privateKey), h.deps, EXCHANGE_ROUTE);
    expect(h.counted).toEqual(['salesforce-org:audience', 'salesforce-org:lifetime', 'salesforce-org:signature']);
    expect(h.deps.recordJti).not.toHaveBeenCalled();
  });

  it('fails closed when the jti cannot be recorded: the gateway answers an error and admits nobody', async () => {
    const h = harness({ state: 'pending', personArn: PERSON_ARN });
    const deps = { ...h.deps, recordJti: async () => { throw new Error('store down'); } };
    await expect(decide(sign(head(), claims()), deps, EXCHANGE_ROUTE)).rejects.toThrow('store down');
  });
});
