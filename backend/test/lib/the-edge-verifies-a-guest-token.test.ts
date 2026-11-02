/**
 * THE EDGE VERIFIES A GUEST TOKEN, AND ADMITS IT ONLY AT THE EXCHANGE (A3 for the guest issuer, A7).
 *
 * The platform signs a guest token with its own KMS key (ES256, `kid` per key generation); the edge reads
 * the key's public half and checks the token like any other issuer's. Each row here signs a token with a
 * P-256 key made in the test, standing in for the KMS key, and asserts the check that refuses it:
 *
 *  - a key generation the issuer does not list, an altered signature, another algorithm;
 *  - another deployment's audience, another issuer, a token that is not a guest token;
 *  - an expired token, one not valid yet, and one signed to live longer than the issuer allows (a valid
 *    signature does not make a long-lived token acceptable);
 *
 * then that a verified guest is admitted on `GUEST_ROUTES` alone, with their one conversation in the
 * context, and that a guest subject with no `Identities` row is denied every route rather than sent to
 * the exchange. The admin plane never verifies a guest token at all.
 */
import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'crypto';
import { decide, type EdgeRoutes } from '../../lambda/src/edge-authorizer';
import { TokenRefused, __setGuestKeyReaderForTests, verifyToken } from '../../lambda/src/lib/token-verification';
import { derToJose, signGuestToken } from '../../lambda/src/lib/guest-token';
import { edgeIssuers, type EdgeIssuer } from '../../lib/config/edge-verification';
import { expandIssuer, guestIssuerUri, issuerRegistry } from '../../lib/config/issuers';
import { EXCHANGE_ROUTE } from '../../lib/constructs/edge-authorizer';
import { GUEST_ROUTES, ONE_CHANNEL_ROUTES } from '../../lib/constructs/trusted-issuers';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';

const DEPLOYMENT = 'test-instance';
const KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/g1';
const KEY_ARN_2 = 'arn:aws:kms:us-east-1:111122223333:key/g2';
const ALL = ['basic', 'standard', 'premium', 'admin'];
const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true },
  { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] }, guest: { signingKeys: ['g1', 'g2'] } },
];
const issuers: EdgeIssuer[] = edgeIssuers(issuerRegistry(REGISTRY, profiles), 'us-east-1_Self', 'us-east-1', ['self-client'], {
  deploymentId: DEPLOYMENT, guestKeys: { g1: KEY_ARN, g2: KEY_ARN_2 },
}).map((t) => expandIssuer(JSON.parse(JSON.stringify(t))) as EdgeIssuer);
const ISS = guestIssuerUri(DEPLOYMENT, 'guest');

const g1 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const g2 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const byArn: Record<string, KeyObject> = { [KEY_ARN]: g1.publicKey, [KEY_ARN_2]: g2.publicKey };
beforeAll(() => __setGuestKeyReaderForTests(async (arn) => {
  if (!byArn[arn]) throw new Error('no such key');
  return byArn[arn];
}));
afterAll(() => __setGuestKeyReaderForTests());

/** A KMS that signs with a local key, the way the real one answers: a DER signature. */
const kmsWith = (key: KeyObject) => ({
  send: async (cmd: { input: { Message: Uint8Array } }) => ({ Signature: signBytes('sha256', Buffer.from(cmd.input.Message), key) }),
});
const now = () => Math.floor(Date.now() / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A hand-built token, for the rows the signer would never produce. */
function forge(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject = g1.privateKey): string {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${derToJose(signBytes('sha256', Buffer.from(input), key)).toString('base64url')}`;
}
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISS, aud: DEPLOYMENT, sub: 'guest-subject', ch: 'guest-visitor-abc', token_use: 'guest',
  iat: now(), nbf: now(), exp: now() + 600, jti: 'j', ...over,
});
const head = (over: Record<string, unknown> = {}) => ({ alg: 'ES256', typ: 'JWT', kid: 'g1', ...over });

async function refusal(token: string): Promise<string> {
  try {
    await verifyToken(token, issuers);
  } catch (err) {
    if (err instanceof TokenRefused) return err.code;
    throw err;
  }
  return 'verified';
}

describe('a guest token is checked like every other issuer\'s, against the KMS key', () => {
  it('verifies a token the signer made, under either listed generation', async () => {
    for (const [kid, key, arn] of [['g1', g1.privateKey, KEY_ARN], ['g2', g2.privateKey, KEY_ARN_2]] as const) {
      const { token } = await signGuestToken({ keyArn: arn, kid, iss: ISS, aud: DEPLOYMENT, sub: 's', ch: 'c', ttlSeconds: 600 }, { kms: kmsWith(key) });
      const v = await verifyToken(token, issuers);
      expect(v.issuer.id).toBe('guest');
      expect(v.claims).toMatchObject({ sub: 's', ch: 'c', token_use: 'guest' });
    }
  });

  it.each([
    ['a key generation the issuer does not list', forge(head({ kid: 'g9' }), claims()), 'unknown-key'],
    ['no key generation', forge(head({ kid: undefined }), claims()), 'unknown-key'],
    ['a key the deployment does not hold', forge(head(), claims(), stranger.privateKey), 'signature'],
    ['another deployment\'s audience', forge(head(), claims({ aud: 'another-instance' })), 'audience'],
    ['not a guest token', forge(head(), claims({ token_use: 'id' })), 'token-use'],
    ['an expired token', forge(head(), claims({ iat: now() - 3600, nbf: now() - 3600, exp: now() - 600 })), 'expired'],
    ['a token not valid yet', forge(head(), claims({ nbf: now() + 600, exp: now() + 1200 })), 'not-yet-valid'],
    ['a token signed to live a day', forge(head(), claims({ exp: now() + 86_400 })), 'lifetime'],
    ['no expiry', forge(head(), claims({ exp: undefined })), 'no-expiry'],
    ['no issue time', forge(head(), claims({ iat: undefined })), 'lifetime'],
  ])('refuses %s', async (_label, token, code) => {
    expect(await refusal(token)).toBe(code);
  });

  it('refuses an altered signature and an altered claim', async () => {
    const good = forge(head(), claims());
    const [h, p, s] = good.split('.');
    const flipped = Buffer.from(s, 'base64url');
    flipped[5] ^= 0xff;
    expect(await refusal(`${h}.${p}.${flipped.toString('base64url')}`)).toBe('signature');
    expect(await refusal(`${h}.${b64(claims({ ch: 'someone-elses' }))}.${s}`)).toBe('signature');
  });

  it('refuses any other algorithm before a key is read, none and HMAC included', async () => {
    for (const alg of ['RS256', 'none', 'HS256', 'ES384']) {
      expect(await refusal(`${b64(head({ alg }))}.${b64(claims())}.x`)).toBe('algorithm');
    }
  });

  it('refuses a token from another issuer URI, even signed with the right key', async () => {
    expect(await refusal(forge(head(), claims({ iss: guestIssuerUri('another-instance', 'guest') })))).toBe('unknown-issuer');
  });

  it('turns a KMS key that cannot be read into a refusal, never an admission', async () => {
    __setGuestKeyReaderForTests(async () => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); });
    try {
      expect(await refusal(forge(head(), claims()))).toBe('keys-unavailable');
    } finally {
      __setGuestKeyReaderForTests(async (arn) => byArn[arn]);
    }
  });

  it('converts a DER signature to the 64-byte JWS form and refuses a malformed one', () => {
    const der = signBytes('sha256', Buffer.from('x'), g1.privateKey);
    expect(derToJose(der)).toHaveLength(64);
    expect(() => derToJose(Buffer.from([0x30, 0x02, 0x01, 0x01]))).toThrow(/not a P-256 DER signature/);
    expect(() => derToJose(Buffer.concat([der, Buffer.from([0])]))).toThrow(/not a P-256 DER signature/);
  });
});

describe('a verified guest is admitted at the exchange and the registration alone', () => {
  const ROUTES: EdgeRoutes = { exchange: [EXCHANGE_ROUTE], oneChannel: [...ONE_CHANNEL_ROUTES], guest: [...GUEST_ROUTES] };
  const verify = (t: string) => verifyToken(t, issuers);
  const PERSON = 'arn:aws:chime:us-east-1:111122223333:app-instance/test/user/0190a000-0000-7000-8000-000000000001';

  it('names the exchange and path B\'s registration as its routes, with its conversation and no other claim in the context', async () => {
    expect([...GUEST_ROUTES]).toEqual(['POST /exchange-credentials', 'POST /guest/register']);
    const token = forge(head(), claims({ name: 'Visitor', 'custom:anything': 'dropped' }));
    const d = await decide(token, { verify, routes: ROUTES, lookup: async () => ({ state: 'active', personArn: PERSON }) });
    expect(d).toMatchObject({ effect: 'allow', routes: ['POST /exchange-credentials', 'POST /guest/register'], reason: 'guest' });
    const ctx = JSON.parse((d as { context: { tokenClaims: string } }).context.tokenClaims);
    expect(ctx).toEqual({ sub: 'guest-subject', name: 'Visitor', token_use: 'guest', ch: 'guest-visitor-abc' });
  });

  it('denies every route to a guest subject with no Identities row, rather than sending it to the exchange', async () => {
    const d = await decide(forge(head(), claims()), { verify, routes: ROUTES, lookup: async () => ({ state: 'unbound' }) });
    expect(d).toMatchObject({ effect: 'deny', reason: 'guest-not-minted' });
  });

  it('denies a revoked guest every route', async () => {
    const d = await decide(forge(head(), claims()), { verify, routes: ROUTES, lookup: async () => ({ state: 'refused', status: 'revoked' }) });
    expect(d).toMatchObject({ effect: 'deny' });
  });

  it('a guest route list the function cannot read admits a guest nowhere', async () => {
    const d = await decide(forge(head(), claims()), {
      verify, routes: { exchange: [EXCHANGE_ROUTE], oneChannel: [] }, lookup: async () => ({ state: 'active', personArn: PERSON }),
    });
    expect(d).toMatchObject({ effect: 'allow', routes: [] });
  });

  it('the admin plane is not handed the guest issuer at all, so a guest token names an issuer it does not know', async () => {
    const admin = edgeIssuers(issuerRegistry(REGISTRY, profiles), 'us-east-1_Self', 'us-east-1', ['self-client'], { deploymentId: DEPLOYMENT, omitGuest: true })
      .map((t) => expandIssuer(JSON.parse(JSON.stringify(t))) as EdgeIssuer);
    expect(admin.map((i) => i.kind)).toEqual(['cognito-pool']);
    await expect(verifyToken(forge(head(), claims()), admin)).rejects.toMatchObject({ code: 'unknown-issuer' });
  });

  it('refuses at synth a guest issuer the edge was handed no key for', () => {
    expect(() => edgeIssuers(issuerRegistry(REGISTRY, profiles), 'us-east-1_Self', 'us-east-1', ['self-client'], { deploymentId: DEPLOYMENT, guestKeys: { g1: KEY_ARN } }))
      .toThrow(/no signing key for g2/);
  });
});
