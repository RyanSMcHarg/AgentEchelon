/**
 * Auth-helper contract tests. The load-bearing case is `parseGroups` on a
 * MULTI-group `cognito:groups` claim: API Gateway serializes it bracketed and
 * space-separated (`"[admins premium]"`), and an earlier comma-only split
 * silently denied additive-admin users (a `premium`+`admins` operator failed the
 * console gate). These pin all three claim shapes and the admin gate that rides
 * on them. See docs/IDENTITY-AND-ACCESS-MODEL.md §4/§8.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { parseGroups, requireAuth, callerIsAdmin, type AuthorizedClaims } from '../../lambda/src/lib/auth';
import { edgeContext } from '../helpers/edge-context';
import { edgeEvent, iamEvent } from '../fixtures/http-api-payload-1.0';

// The trusted-issuer registry a function with no TRUSTED_ISSUERS reads: this deployment's own pool alone.
process.env.USER_POOL_ID = 'us-east-1_Pool';

/** The claims `requireAuth` resolves for an event, or null when it refuses. */
const extractClaims = async (event: APIGatewayProxyEvent): Promise<AuthorizedClaims | null> => {
  const r = await requireAuth(event);
  return 'claims' in r ? r.claims : null;
};

const eventWithGroups = (groups: unknown): APIGatewayProxyEvent =>
  ({ requestContext: { authorizer: edgeContext({ claims: { sub: 'u-1', 'cognito:groups': groups } }) } } as unknown as APIGatewayProxyEvent);

describe('parseGroups — claim shapes', () => {
  it('parses a JSON array', () => {
    expect(parseGroups(['admins', 'premium'])).toEqual(['admins', 'premium']);
  });

  it('parses a comma-separated string (raw JWT)', () => {
    expect(parseGroups('admins,premium')).toEqual(['admins', 'premium']);
  });

  it('parses the bracketed space-separated multi-group string (API Gateway)', () => {
    expect(parseGroups('[admins premium]')).toEqual(['admins', 'premium']);
  });

  it('parses a single-group bracketed string', () => {
    expect(parseGroups('[premium]')).toEqual(['premium']);
  });

  it('parses a bare single group', () => {
    expect(parseGroups('premium')).toEqual(['premium']);
  });

  it('returns [] for absent/non-string/non-array', () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups(null)).toEqual([]);
    expect(parseGroups(42)).toEqual([]);
    expect(parseGroups('')).toEqual([]);
  });
});

/**
 * THE CLEARANCE IS THE REGISTRY'S HOLDER TOKEN, not the first entry of a hardcoded order.
 *
 * `requireAuth` (then `extractClaims`) used to read `['admins', 'premium', 'standard', 'basic']` and take the first group
 * the caller held, which is "the highest level wins". A classification is a declared set of grants
 * (ADR-046), so these pin the three answers that distinguish the two: a combination the deployment
 * NAMES resolves to its declared token, a single group resolves to itself, and a combination nothing
 * names resolves to `undefined` rather than to the nearest fit.
 */
describe('requireAuth — clearance is the declared holder token', () => {
  it('resolves a named combination to its declared token, not to a group name', async () => {
    const claims = await extractClaims(eventWithGroups('[admins premium]'));
    // The member token, `premium`: the admin plane (the `admins` group's classification) grants itself alone and
    // rides beside the token rather than in it (`ProfileRegistry.holderOf`). Never `admins`, the group name.
    expect(claims?.clearance).toBe('premium');
    expect(claims?.groups).toEqual(['admins', 'premium']);
  });

  it('resolves the admins group alone to the admin plane classification, never the group name', async () => {
    expect((await extractClaims(eventWithGroups('admins')))?.clearance).toBe('admin');
  });

  it('resolves a single clearance group to its own classification', async () => {
    expect((await extractClaims(eventWithGroups('standard')))?.clearance).toBe('standard');
  });

  it('resolves a group that clears for nothing to undefined', async () => {
    // A persona or directory group is not a clearance. The old order answered `unknown`, a fifth
    // value no classification ever has; `undefined` says the same thing without inventing one.
    expect((await extractClaims(eventWithGroups('platform-devs')))?.clearance).toBeUndefined();
  });

  it('ignores a group that clears for nothing beside one that does', async () => {
    // The unmapped group neither adds reach nor removes it. Under the old order a group absent from
    // the list simply did not match, which happened to give the same answer here and the wrong one
    // whenever the list and the deployment's group names disagreed.
    const claims = await extractClaims(eventWithGroups('[platform-devs standard]'));
    expect(claims?.clearance).toBe('standard');
    expect(claims?.groups).toEqual(['platform-devs', 'standard']);
  });

  it('resolves the union of two clearance groups, not the first one listed', async () => {
    // `basic` grants [basic] and `premium` grants [basic, standard, premium]. The union IS premium's
    // grant set, so the declared token for holding both is `premium` - reached by comparing SETS.
    // The old order returned `premium` here too, from its position in the list rather than from what
    // the deployment declared. The PEER case - two classifications neither of which contains the
    // other - cannot be reached through `requireAuth`, which reads the shipped registry; it is
    // pinned on the resolver itself in `profile-registry.test.ts`, and `requireAuth` is correct for
    // it by calling that resolver instead of carrying its own list.
    expect((await extractClaims(eventWithGroups('[basic premium]')))?.clearance).toBe('premium');
  });
});

describe('callerIsAdmin — additive admin must pass', () => {
  it('grants a multi-group admin (bracketed form)', () => {
    expect(callerIsAdmin(eventWithGroups('[admins premium]'))).toBe(true);
  });

  it('grants a comma-separated admin', () => {
    expect(callerIsAdmin(eventWithGroups('premium,admins'))).toBe(true);
  });

  it('denies a non-admin tier', () => {
    expect(callerIsAdmin(eventWithGroups('[standard basic]'))).toBe(false);
  });

  it('denies when no claims are present', () => {
    expect(callerIsAdmin({ requestContext: {} } as unknown as APIGatewayProxyEvent)).toBe(false);
  });
});

/**
 * WHO CALLED IS THE APPINSTANCEUSER, NEVER THE TOKEN'S SUB (`callerPersonId`, the one resolver).
 *
 * The exchange mints each person an opaque id, so every case below resolves to an id that is NOT the
 * subject the token or the provider string carries: a handler that read the subject would name nobody.
 */
describe('callerPersonId: one resolver, reading what the edge authorizer and the signed session say', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const identity = require('../../lambda/src/lib/person-identity') as { resolvePerson: jest.Mock };
  const auth = jest.requireActual('../../lambda/src/lib/auth') as typeof import('../../lambda/src/lib/auth');
  const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
  const SUB = '6b1e2f4a-9c7d-4e3b-8a21-0d5c9e7f1a33';
  const PERSON = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.APP_INSTANCE_ARN = APP;
    identity.resolvePerson.mockClear();
  });
  afterAll(() => { process.env = saved; });

  const answer = { issuerId: 'deployment', subject: SUB, personId: PERSON, personArn: `${APP}/user/${PERSON}`, claims: { sub: SUB, 'cognito:groups': ['standard'], email: 'a@example.com', name: 'A' } };
  const signed = (identityFields: Record<string, unknown>) =>
    ({ requestContext: { identity: identityFields } }) as unknown as APIGatewayProxyEvent;

  it('names the person the edge resolved, from a payload 1.0 event, with no lookup of its own', async () => {
    const event = edgeEvent('POST', '/tasks', answer);
    expect(await auth.callerPersonId(event)).toBe(PERSON);
    expect(await auth.callerPersonArn(event)).toBe(`${APP}/user/${PERSON}`);
    const guard = await auth.requireAuth(event);
    expect('claims' in guard && guard.claims.personId).toBe(PERSON);
    expect('claims' in guard && guard.claims.actor).toBe(PERSON);
    expect('claims' in guard && guard.claims.groups).toEqual(['standard']);
    expect('claims' in guard && guard.claims.email).toBe('a@example.com');
    expect((await auth.callerPerson(event))?.contact).toEqual({ email: 'a@example.com', name: 'A' });
    // THE EDGE DID THE LOOKUP. A handler that read Identities again would hold a grant it does not need.
    expect(identity.resolvePerson).not.toHaveBeenCalled();
  });

  it('reads the context the same when the gateway nests it under `lambda`', async () => {
    expect(await auth.callerPersonId(edgeEvent('POST', '/tasks', answer, { nested: true }))).toBe(PERSON);
  });

  it('composes the ARN from the person id when the context carries none', async () => {
    const { personArn: _omit, ...withoutArn } = answer;
    expect(await auth.callerPersonArn(edgeEvent('GET', '/tasks/mine', withoutArn))).toBe(`${APP}/user/${PERSON}`);
  });

  it('names nobody for a first sign-in, whose context carries no person', async () => {
    const { personId: _p, personArn: _a, ...firstSignIn } = answer;
    const event = edgeEvent('POST', '/exchange-credentials', firstSignIn);
    expect(await auth.callerPersonId(event)).toBeNull();
    const refused = await auth.requireAuth(event);
    expect('statusCode' in refused && refused.statusCode).toBe(401);
    // The exchange still reads who the token is, to mint the person.
    expect(auth.edgeCallerOf(event)?.subject).toBe(SUB);
  });

  it('names nobody when the context names an issuer this function does not trust', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await auth.callerPersonId(edgeEvent('POST', '/tasks', { ...answer, issuerId: 'removed-issuer' }))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[SecurityEvent]'), expect.anything());
    warn.mockRestore();
  });

  it('reads no claim off a request the edge did not authorize, whatever it carries', async () => {
    // The Cognito authorizer's shape: `claims` with a `sub`. No route is behind one, so it names nobody.
    const cognitoShaped = { requestContext: { authorizer: { claims: { sub: SUB, 'cognito:groups': 'admins' } } } } as unknown as APIGatewayProxyEvent;
    expect(await auth.callerPersonId(cognitoShaped)).toBeNull();
    expect(auth.callerIsAdmin(cognitoShaped)).toBe(false);
  });

  it('resolves once per request', async () => {
    const event = edgeEvent('POST', '/tasks', answer);
    const first = await auth.callerPerson(event);
    expect(await auth.callerPerson(event)).toBe(first);
  });

  it('reads a console session from its name, whatever shape the id has, with no lookup', async () => {
    for (const id of [PERSON, 'person_01J8Z', 'a.b-c=d']) {
      const event = iamEvent('GET', '/admin/conversations', `arn:aws:sts::111:assumed-role/agent-echelon-admin-console/console-${id}`);
      expect(await auth.callerPersonId(event)).toBe(id);
      expect(auth.isAdminConsoleSession(event)).toBe(true);
      expect(auth.signedAsPerson(event)).toBe(true);
    }
    const team = signed({ userArn: `arn:aws:sts::111:assumed-role/agent-echelon-team-console/console-${PERSON}@standard` });
    expect(await auth.callerPersonId(team)).toBe(PERSON);
    expect(auth.isAdminConsoleSession(team)).toBe(false);
    expect(auth.consoleSessionOf(`arn:aws:sts::111:assumed-role/agent-echelon-team-console/console-${PERSON}@standard`))
      .toEqual({ kind: 'team', personId: PERSON, clearance: 'standard' });
    expect(identity.resolvePerson).not.toHaveBeenCalled();
  });

  it('names nobody for a session on any other role, or one the exchange did not name', async () => {
    expect(await auth.callerPersonId(iamEvent('GET', '/users', `arn:aws:sts::111:assumed-role/some-role/console-${PERSON}`))).toBeNull();
    expect(await auth.callerPersonId(iamEvent('GET', '/users', `arn:aws:sts::111:assumed-role/agent-echelon-admin-console/${PERSON}`))).toBeNull();
    expect(await auth.callerPersonId(iamEvent('GET', '/users', 'arn:aws:iam::111:role/host-proxy'))).toBeNull();
    expect(auth.signedAsPerson(iamEvent('GET', '/users', 'arn:aws:iam::111:role/host-proxy'))).toBe(false);
  });

  it('names nobody for an Identity-Pool principal: the deployment has no Identity Pool', async () => {
    const provider = 'cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool,cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool:CognitoSignIn:' + SUB;
    const event = signed({ cognitoAuthenticationProvider: provider, userArn: 'arn:aws:sts::111:assumed-role/StandardRole/CognitoIdentityCredentials' });
    expect(await auth.callerPersonId(event)).toBeNull();
    expect(auth.signedAsPerson(event)).toBe(false);
  });
});
