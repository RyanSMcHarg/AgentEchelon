/**
 * THE EDGE ADMITS A VERIFIED TOKEN ONLY WHERE ITS PERSON IS SERVED.
 *
 * A token that passes every check (`the-edge-refuses-a-token-it-cannot-prove.test.ts`) is then resolved
 * through `Identities`, and the answer is an IAM policy naming the routes it may call:
 *
 *  - a person: every route, with the person in the context;
 *  - a one-conversation person: `ONE_CHANNEL_ROUTES` only;
 *  - a first sign-in (no row yet): the credential exchange only, with no person in the context;
 *  - a subject whose row is not active, or a revoked one: no route. Whether the account is disabled at
 *    its issuer is the credential exchange's live question, never the edge's.
 *
 * The gateway caches a policy by token and evaluates it against every later request's own route, so
 * each row here evaluates the returned policy against the routes the token must NOT reach, the way the
 * gateway does, rather than only reading what the authorizer was asked about.
 */
import { authorize, bearerOf, decide, edgeRoutesFromEnv, policyOf, routeResource, type EdgePolicy, type EdgeRoutes } from '../../lambda/src/edge-authorizer';
import { __setFetcherForTests, verifyToken } from '../../lambda/src/lib/token-verification';
import { clearPersonCache, identityStateOf, revokedMarkerKey, type IdentityState } from '../../lambda/src/lib/person-identity';
import { edgeIssuers, type EdgeIssuer } from '../../lib/config/edge-verification';
import { expandIssuer, groupsOf, issuerRegistry } from '../../lib/config/issuers';
import { ONE_CHANNEL_ROUTES } from '../../lib/constructs/trusted-issuers';
import { EXCHANGE_ROUTE } from '../../lib/constructs/edge-authorizer';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { StubFetcher, jwks, nowSeconds, rsaKey, signToken } from '../helpers/jwt-fixtures';

const REGION = 'us-east-1';
const SELF_POOL = 'us-east-1_SelfPool';
const HOST_POOL = 'us-east-1_HostApp';
const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const PERSON_ID = '01890000-0000-7000-8000-000000000001';
const PERSON_ARN = `${APP}/user/${PERSON_ID}`;
const ALL = ['basic', 'standard', 'premium', 'admin'];
const iss = (pool: string) => `https://cognito-idp.${REGION}.amazonaws.com/${pool}`;

const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true },
  { id: 'host', kind: 'cognito-pool', pool: HOST_POOL, audience: 'host-client', clearance: { oneChannel: 'basic', classifications: ['basic'] } },
  { id: 'corp-sso', kind: 'cognito-federated', pool: 'self', providerName: 'CorpSAML',
    clearance: { groups: { map: { 'AE Standard': 'standard' }, emptyGroupsSent: true }, classifications: ['basic', 'standard'] } },
];
const issuers: EdgeIssuer[] = edgeIssuers(issuerRegistry(REGISTRY, profiles), SELF_POOL, REGION, ['self-client'])
  .map((t) => expandIssuer(JSON.parse(JSON.stringify(t))) as EdgeIssuer);

const selfKey = rsaKey('self-1');
const hostKey = rsaKey('host-1');
beforeAll(() => __setFetcherForTests(new StubFetcher()
  .set(`${iss(SELF_POOL)}/.well-known/jwks.json`, jwks(selfKey))
  .set(`${iss(HOST_POOL)}/.well-known/jwks.json`, jwks(hostKey))));
afterAll(() => __setFetcherForTests());
// A refused subject logs a security event; the rows assert the policy, not the log line.
let quietWarn: jest.SpyInstance;
beforeAll(() => { quietWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterAll(() => quietWarn.mockRestore());

const life = () => ({ iat: nowSeconds(), exp: nowSeconds() + 600 });
const selfToken = (over: Record<string, unknown> = {}) => signToken(selfKey, {
  iss: iss(SELF_POOL), aud: 'self-client', token_use: 'id', sub: 'sub-self', 'cognito:groups': ['basic'],
  email: 'a@example.com', name: 'A', 'custom:other': 'not carried', ...life(), ...over,
});
const hostToken = () => signToken(hostKey, { iss: iss(HOST_POOL), aud: 'host-client', token_use: 'id', sub: 'sub-host', ...life() });

const ROUTES: EdgeRoutes = { exchange: [EXCHANGE_ROUTE], oneChannel: [...ONE_CHANNEL_ROUTES] };
const API = 'arn:aws:execute-api:us-east-1:111122223333:abc123/$default';
const arnOf = (routeKey: string, concretePath?: string) => {
  const [method, p] = routeKey.split(' ');
  return `${API}/${method}${concretePath ?? p}`;
};

/** Every person-facing route a table row evaluates the policy against. */
const EVERY_ROUTE = [
  EXCHANGE_ROUTE,
  'POST /create-conversation',
  'GET /tasks',
  'POST /conversations/{id}/members',
  'GET /presigned-url',
  'POST /client-events',
];

/** The gateway's evaluation of a policy against one request's route: an explicit Deny wins, then an Allow. */
function admits(policy: EdgePolicy, routeArn: string): boolean {
  const matches = (resource: string) => new RegExp(`^${resource.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(routeArn);
  const st = policy.policyDocument.Statement;
  if (st.some((s) => s.Effect === 'Deny' && s.Resource.some(matches))) return false;
  return st.some((s) => s.Effect === 'Allow' && s.Resource.some(matches));
}

const lookupAs = (state: IdentityState) => jest.fn(async () => state);
const deps = (state: IdentityState, routes: EdgeRoutes = ROUTES) => ({
  verify: (t: string) => verifyToken(t, issuers),
  lookup: lookupAs(state),
  routes,
});
const request = (token: string, routeKey: string, concretePath?: string) => ({
  type: 'REQUEST', routeKey, routeArn: arnOf(routeKey, concretePath), headers: { authorization: `Bearer ${token}` },
});

describe('which routes a verified token is admitted to', () => {
  it.each<[string, () => string, IdentityState, string[]]>([
    ['a person', () => selfToken(), { state: 'active', personArn: PERSON_ARN }, EVERY_ROUTE],
    ['a first sign-in (no Identities row)', () => selfToken(), { state: 'unbound' }, [EXCHANGE_ROUTE]],
    ['a one-conversation person', () => hostToken(), { state: 'active', personArn: PERSON_ARN }, [...ONE_CHANNEL_ROUTES]],
    ['a one-conversation first sign-in', () => hostToken(), { state: 'unbound' }, [EXCHANGE_ROUTE]],
    ['a subject whose row is not active', () => selfToken(), { state: 'refused', status: 'pending' }, []],
    ['a revoked subject', () => selfToken(), { state: 'refused', status: 'revoked' }, []],
    ['a one-conversation subject whose row is not active', () => hostToken(), { state: 'refused', status: 'pending' }, []],
  ])('%s', async (_name, token, state, reachable) => {
    // Decided on the first route, as the gateway would before caching the answer for this token.
    for (const asked of EVERY_ROUTE) {
      const policy = await authorize(request(token(), asked, asked.includes('{id}') ? '/conversations/c-1/members' : undefined), deps(state));
      for (const route of EVERY_ROUTE) {
        const concrete = route.includes('{id}') ? '/conversations/c-1/members' : undefined;
        expect({ asked, route, admitted: admits(policy, arnOf(route, concrete)) })
          .toEqual({ asked, route, admitted: reachable.includes(route) });
      }
    }
  });

  it('a one-conversation token cached on conversation creation is not reused on any other route', async () => {
    const policy = await authorize(request(hostToken(), 'POST /create-conversation'), deps({ state: 'active', personArn: PERSON_ARN }));
    expect(admits(policy, arnOf('POST /create-conversation'))).toBe(true);
    for (const route of EVERY_ROUTE.filter((r) => !ONE_CHANNEL_ROUTES.includes(r))) {
      expect({ route, admitted: admits(policy, arnOf(route, route.includes('{id}') ? '/conversations/c-1/members' : undefined)) })
        .toEqual({ route, admitted: false });
    }
  });

  it('a first-time token on a task route is refused, and is admitted on the exchange', async () => {
    const atTasks = await authorize(request(selfToken(), 'GET /tasks'), deps({ state: 'unbound' }));
    expect(admits(atTasks, arnOf('GET /tasks'))).toBe(false);
    expect(admits(atTasks, arnOf(EXCHANGE_ROUTE))).toBe(true);
  });
});

describe('the context a handler reads its caller from', () => {
  it('carries the person, the issuer, the subject and only the claims the registry reads', async () => {
    const policy = await authorize(request(selfToken(), 'GET /tasks'), deps({ state: 'active', personArn: PERSON_ARN }));
    expect(policy.principalId).toBe(PERSON_ID);
    expect(policy.context).toEqual({
      personId: PERSON_ID,
      personArn: PERSON_ARN,
      issuerId: 'deployment',
      subject: 'sub-self',
      tokenClaims: expect.any(String),
    });
    expect(JSON.parse(policy.context!.tokenClaims)).toEqual({
      sub: 'sub-self', 'cognito:groups': ['basic'], email: 'a@example.com', name: 'A', token_use: 'id',
    });
    for (const v of Object.values(policy.context!)) expect(typeof v).toBe('string');
  });

  it('names no context key an HTTP API reserves, so every value reaches the handler', async () => {
    // "claims is a reserved placeholder and cannot be used as the context object" (API Gateway, HTTP API
    // Lambda authorizers). Named `claims`, the token's claims were replaced on the way to the credential
    // exchange, which then read every person of a fresh deployment as holding no group and vended nothing.
    const RESERVED = ['claims', 'scopes', 'principalId', 'integrationLatency'];
    for (const state of [{ state: 'active', personArn: PERSON_ARN }, { state: 'unbound' }] as const) {
      const policy = await authorize(request(selfToken(), 'POST /exchange-credentials'), deps(state as never));
      expect(Object.keys(policy.context ?? {}).filter((k) => RESERVED.includes(k))).toEqual([]);
    }
  });

  it('carries what a translation reads, so a federated person keeps their translated groups through the edge', async () => {
    // The handler reads groups from the edge's context, never the raw token: a context without `identities`
    // would read every federated person as holding no group.
    const token = selfToken({ identities: [{ providerName: 'CorpSAML' }], 'custom:groups': '[AE%20Standard]', 'cognito:groups': ['us-east-1_SelfPool_CorpSAML'] });
    const policy = await authorize(request(token, 'GET /tasks'), deps({ state: 'active', personArn: PERSON_ARN }));
    expect(policy.context).toMatchObject({ issuerId: 'corp-sso' });
    const claims = JSON.parse(policy.context!.tokenClaims);
    expect(claims).toMatchObject({ identities: [{ providerName: 'CorpSAML' }], 'custom:groups': '[AE%20Standard]' });
    const federated = issuers.find((i) => i.id === 'corp-sso')!;
    expect(groupsOf(federated, claims)).toEqual(['standard']);
  });

  it('a first sign-in carries no person, only what the exchange mints one from', async () => {
    const policy = await authorize(request(selfToken(), EXCHANGE_ROUTE), deps({ state: 'unbound' }));
    expect(policy.principalId).toBe('unbound');
    expect(policy.context).not.toHaveProperty('personId');
    expect(policy.context).not.toHaveProperty('personArn');
    expect(policy.context).toMatchObject({ issuerId: 'deployment', subject: 'sub-self' });
  });

  it('a refused subject carries no context at all', async () => {
    const policy = await authorize(request(selfToken(), 'GET /tasks'), deps({ state: 'refused', status: 'revoked' }));
    expect(policy.context).toBeUndefined();
  });

  it('the lookup is keyed on the registry id and the declared subject', async () => {
    const d = deps({ state: 'active', personArn: PERSON_ARN });
    await authorize(request(hostToken(), 'POST /create-conversation'), d);
    expect(d.lookup).toHaveBeenCalledWith('host', 'sub-host');
  });
});

describe('refusals', () => {
  it.each<[string, Record<string, string | undefined> | null]>([
    ['no Authorization header', {}],
    ['no headers at all', null],
    ['an empty bearer', { authorization: 'Bearer ' }],
    ['a token that fails verification', { authorization: 'Bearer not.a.jwt' }],
    ['a token from an undeclared pool', { authorization: `Bearer ${signToken(selfKey, { iss: iss('us-east-1_Stranger'), aud: 'self-client', token_use: 'id', sub: 's', ...life() })}` }],
  ])('%s is 401 (Unauthorized), and nothing is looked up', async (_name, headers) => {
    const d = deps({ state: 'active', personArn: PERSON_ARN });
    await expect(authorize({ type: 'REQUEST', routeKey: 'GET /tasks', routeArn: arnOf('GET /tasks'), headers }, d)).rejects.toThrow(/^Unauthorized$/);
    expect(d.lookup).not.toHaveBeenCalled();
  });

  it('a lookup that cannot be answered is an error, never an answer', async () => {
    const d = { ...deps({ state: 'unbound' }), lookup: jest.fn(async () => { throw new Error('DynamoDB is unavailable'); }) };
    await expect(authorize(request(selfToken(), EXCHANGE_ROUTE), d)).rejects.toThrow('DynamoDB is unavailable');
  });

  it('an active row naming no AppInstanceUser is refused everywhere', async () => {
    const policy = await authorize(request(selfToken(), 'GET /tasks'), deps({ state: 'active', personArn: 'not-an-arn' }));
    for (const route of EVERY_ROUTE) expect(admits(policy, arnOf(route, route.includes('{id}') ? '/c/x' : undefined))).toBe(false);
  });

  it('unreadable route data admits a first sign-in and a one-conversation person nowhere', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const routes = edgeRoutesFromEnv('{oops');
    quiet.mockRestore();
    expect(routes).toEqual({ exchange: [], oneChannel: [] });
    expect(edgeRoutesFromEnv(undefined)).toEqual({ exchange: [], oneChannel: [] });
    expect(edgeRoutesFromEnv(JSON.stringify({ exchange: ['POST /exchange-credentials', 'not a route', 7] })).exchange).toEqual(['POST /exchange-credentials']);
    const first = await authorize(request(selfToken(), EXCHANGE_ROUTE), deps({ state: 'unbound' }, routes));
    expect(admits(first, arnOf(EXCHANGE_ROUTE))).toBe(false);
    const host = await authorize(request(hostToken(), 'POST /create-conversation'), deps({ state: 'active', personArn: PERSON_ARN }, routes));
    expect(admits(host, arnOf('POST /create-conversation'))).toBe(false);
  });

  it('a route ARN the policy cannot be scoped to admits nothing', () => {
    const policy = policyOf({ effect: 'allow', routes: 'all', reason: 'person', context: { issuerId: 'deployment', subject: 's', tokenClaims: '{}' } }, 'garbage');
    expect(policy.policyDocument.Statement[0].Effect).toBe('Deny');
  });
});

describe('the shapes the gateway sends and expects', () => {
  it('reads the bearer from either payload format, with or without the scheme', () => {
    expect(bearerOf({ headers: { Authorization: 'Bearer abc' } })).toBe('abc');
    expect(bearerOf({ headers: { authorization: 'bearer   abc ' } })).toBe('abc');
    expect(bearerOf({ headers: { authorization: 'abc' } })).toBe('abc');
    expect(bearerOf({ authorizationToken: 'Bearer abc' })).toBe('abc');
    expect(bearerOf({ identitySource: ['Bearer abc'] })).toBe('abc');
    expect(bearerOf({ headers: {} })).toBeNull();
  });

  it('writes a route key as the ARN it covers, path parameters as wildcards', () => {
    expect(routeResource(API, 'POST /exchange-credentials')).toBe(`${API}/POST/exchange-credentials`);
    expect(routeResource(API, 'POST /conversations/{id}/members')).toBe(`${API}/POST/conversations/*/members`);
  });

  it('decides a 1.0-format request by its method ARN', async () => {
    const policy = await authorize({ type: 'REQUEST', methodArn: arnOf('GET /tasks'), headers: { Authorization: `Bearer ${selfToken()}` } },
      deps({ state: 'active', personArn: PERSON_ARN }));
    expect(policy.policyDocument.Statement).toEqual([{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: [`${API}/*`] }]);
  });

  it('decide() answers without a route at all', async () => {
    expect(await decide(null)).toEqual({ effect: 'unauthorized', reason: 'no-token' });
  });
});

describe('where a subject stands in Identities (identityStateOf)', () => {
  const TABLE = 'Identities';
  type Rows = Record<string, Record<string, unknown>>;
  const docOver = (rows: Rows) => ({
    send: jest.fn(async (cmd: { input: { Key: { issuerSubject: string } } }) => ({ Item: rows[cmd.input.Key.issuerSubject] })),
  });
  const chimeAnswering = (found: boolean) => ({
    send: jest.fn(async () => {
      if (found) return {};
      throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
    }),
  });
  const row = (status: string, personArn = PERSON_ARN) => ({ issuerSubject: 'deployment|sub-self', personArn, issuer: 'deployment', status, createdAt: 'x' });
  beforeEach(() => clearPersonCache());

  it.each<[string, Rows, boolean, IdentityState]>([
    ['no row and no marker is a first sign-in', {}, true, { state: 'unbound' }],
    ['no row and a revocation marker is refused', { [revokedMarkerKey('deployment', 'sub-self')]: { issuerSubject: 'm' } }, true, { state: 'refused', status: 'revoked' }],
    ['a pending row written for another issuer is refused', { 'deployment|sub-self': { ...row('pending'), issuer: 'salesforce-org' } }, true, { state: 'refused', status: 'pending' }],
    ['a row naming no AppInstanceUser is refused', { 'deployment|sub-self': row('active', 'nobody') }, true, { state: 'refused', status: 'no-app-instance-user' }],
    ['an active row whose AppInstanceUser exists is the person', { 'deployment|sub-self': row('active') }, true, { state: 'active', personArn: PERSON_ARN }],
    ['an active row whose AppInstanceUser is gone goes back to the exchange', { 'deployment|sub-self': row('active') }, false, { state: 'unbound' }],
  ])('%s', async (_name, rows, exists, expected) => {
    const state = await identityStateOf('deployment', 'sub-self', { doc: docOver(rows), chime: chimeAnswering(exists), table: TABLE, appInstanceArn: APP });
    expect(state).toEqual(expected);
  });

  it('reads the row on every call, and checks existence only on a cache miss', async () => {
    const doc = docOver({ 'deployment|sub-self': row('active') });
    const chime = chimeAnswering(true);
    const d = { doc, chime, table: TABLE, appInstanceArn: APP };
    await identityStateOf('deployment', 'sub-self', d);
    await identityStateOf('deployment', 'sub-self', d);
    expect(doc.send).toHaveBeenCalledTimes(2);
    expect(chime.send).toHaveBeenCalledTimes(1);
  });

  it('a lookup that fails throws', async () => {
    const doc = { send: jest.fn(async () => { throw new Error('throttled'); }) };
    await expect(identityStateOf('deployment', 'sub-self', { doc, chime: chimeAnswering(true), table: TABLE, appInstanceArn: APP })).rejects.toThrow('throttled');
  });
});
