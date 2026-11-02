/**
 * A PERSON IS KEYED BY THEIR ISSUER'S REGISTRY ID AND THE SUBJECT IT DECLARES (A1, A2, A6).
 *
 * One resolver across the trusted-issuer registry: a token's `iss` is matched exactly to its entry (the
 * Entra template with a tenant on the allowlist), the subject is the claim that entry declares, and the
 * `Identities` row is `<registry id>|<subject>`. So:
 *
 *  - each kind matches its own tokens and no other's (a unit table per kind);
 *  - the same subject value under two issuers is two people;
 *  - an issuer the registry does not declare is refused, a revoked subject is refused, and nothing
 *    falls back to `cognito:username`;
 *  - a removed issuer's token is refused once the registry is read again, at the latest after the TTL;
 *  - an OIDC issuer declaring `admin: true` gets an admin console session whose opaque person id parses
 *    as an admin actor, and an issuer that does not declare it gets none.
 */
const mockStsSend = jest.fn();
const mockChimeSend = jest.fn();
const mockDocSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) },
  PutCommand: jest.fn((input: unknown) => ({ __type: 'Put', input })),
  GetCommand: jest.fn((input: unknown) => ({ __type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ __type: 'Query', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn(() => ({ send: mockStsSend })),
  AssumeRoleCommand: jest.fn((input: unknown) => ({ __type: 'AssumeRole', input })),
}));
jest.mock('@aws-sdk/client-chime-sdk-identity', () => ({
  ChimeSDKIdentityClient: jest.fn(() => ({ send: mockChimeSend })),
  CreateAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'CreateAppInstanceUser', input })),
  UpdateAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'UpdateAppInstanceUser', input })),
  DescribeAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'DescribeAppInstanceUser', input })),
  CreateAppInstanceAdminCommand: jest.fn((input: unknown) => ({ __type: 'CreateAppInstanceAdmin', input })),
  TagResourceCommand: jest.fn((input: unknown) => ({ __type: 'TagResource', input })),
  ListAppInstanceBotsCommand: jest.fn((input: unknown) => ({ __type: 'ListAppInstanceBots', input })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTagsForResource', input })),
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { issuerForClaims, subjectOf, holderTokenOf, type TrustedIssuer } from '../../lib/config/issuers';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { REGISTRY_TTL_MS, issuerOfToken, __resetTrustedIssuersForTests } from '../../lambda/src/lib/trusted-issuers';
import { edgeContext } from '../helpers/edge-context';
import { edgeEvent } from '../fixtures/http-api-payload-1.0';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const POOL = 'us-east-1_Deployment';
const POOL_ISS = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const HOST_POOL = 'us-east-1_HostApp';
const HOST_ISS = `https://cognito-idp.us-east-1.amazonaws.com/${HOST_POOL}`;
const TENANT = '11111111-2222-3333-4444-555555555555';
const OIDC_ISS = 'https://idp.example.com';
const ALL = ['basic', 'standard', 'premium', 'admin'];

const REGISTRY: TrustedIssuer[] = [
  { id: 'deployment', kind: 'cognito-pool', pool: POOL, iss: POOL_ISS, subject: ['sub'], clearance: { groups: true, classifications: ALL }, admin: true, groupsClaim: 'cognito:groups', directory: 'cognito' },
  { id: 'okta-saml', kind: 'cognito-federated', pool: POOL, iss: POOL_ISS, providerName: 'Okta', subject: ['sub'], clearance: { mapping: { claim: 'custom:roles', values: { analyst: 'standard' } }, classifications: ['basic', 'standard'] }, admin: false, groupsClaim: 'cognito:groups', directory: 'cognito' },
  { id: 'host', kind: 'cognito-pool', pool: HOST_POOL, iss: HOST_ISS, subject: ['sub'], clearance: { oneChannel: 'basic', classifications: ['basic'] }, admin: false, groupsClaim: 'cognito:groups', directory: 'cognito' },
  { id: 'okta', kind: 'oidc', iss: OIDC_ISS, subject: ['sub'], clearance: { groups: { map: { 'ae-admin': 'admins', viewer: 'basic' } }, classifications: ALL }, admin: true, groupsClaim: 'roles', directory: 'none' },
  { id: 'entra', kind: 'oidc-entra', tenants: [TENANT], tokenVersion: 2, subject: ['tid', 'oid'], clearance: { fixed: ['basic'], classifications: ['basic'] }, admin: false, groupsClaim: 'groups', directory: 'none' },
];

describe('each kind matches its own tokens and no other (a unit table)', () => {
  const okta = JSON.stringify([{ providerName: 'Okta', userId: 'x' }]);
  it.each<[string, Record<string, unknown>, string | null]>([
    ['a pool token', { iss: POOL_ISS, sub: 's' }, 'deployment'],
    ['a pool user federated through a declared provider', { iss: POOL_ISS, sub: 's', identities: okta }, 'okta-saml'],
    ['a pool user federated through an undeclared provider', { iss: POOL_ISS, sub: 's', identities: [{ providerName: 'Ping' }] }, null],
    ['a host pool token', { iss: HOST_ISS, sub: 's' }, 'host'],
    ['an exact oidc issuer', { iss: OIDC_ISS, sub: 's' }, 'okta'],
    ['an oidc issuer with a trailing slash', { iss: `${OIDC_ISS}/`, sub: 's' }, null],
    ['an Entra v2 token from an allowed tenant', { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, oid: 'o' }, 'entra'],
    ['an Entra v1 token where v2 is declared', { iss: `https://sts.windows.net/${TENANT}/`, tid: TENANT, oid: 'o' }, null],
    ['an Entra token whose tid disagrees with its iss', { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: '99999999-2222-3333-4444-555555555555', oid: 'o' }, null],
    ['an issuer the registry does not declare', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other', sub: 's' }, null],
    ['a token naming no issuer', { sub: 's' }, null],
  ])('%s', (_label, claims, expected) => {
    expect(issuerForClaims(REGISTRY, claims)?.id ?? null).toBe(expected);
  });

  it('reads the subject each entry declares, and nothing when a declared claim is missing', () => {
    const entra = REGISTRY.find((t) => t.id === 'entra')!;
    expect(subjectOf(entra, { tid: TENANT, oid: 'object-1', sub: 'pairwise' })).toBe(`${TENANT}:object-1`);
    expect(subjectOf(entra, { tid: TENANT, sub: 'pairwise' })).toBeNull();
    const pool = REGISTRY[0];
    expect(subjectOf(pool, { 'cognito:username': 'jane' })).toBeNull();
  });

  it('reaches only what each source declares, within the issuer\'s classifications', () => {
    const [pool, saml, hostApp, okta, entra] = REGISTRY;
    expect(holderTokenOf(pool, { 'cognito:groups': '[admins premium]' }, profiles)).toBe('premium');
    expect(holderTokenOf(saml, { 'custom:roles': 'analyst' }, profiles)).toBe('standard');
    // A claim value the mapping does not declare reaches nothing.
    expect(holderTokenOf(saml, { 'custom:roles': 'ceo' }, profiles)).toBeUndefined();
    // The issuer's classifications bind whatever the groups say: a host-pool group named premium grants nothing here.
    expect(holderTokenOf({ ...pool, clearance: { groups: true, classifications: ['basic'] } }, { 'cognito:groups': '[basic premium]' }, profiles)).toBe('basic');
    expect(holderTokenOf(hostApp, { 'cognito:groups': 'premium' }, profiles)).toBeUndefined();
    expect(holderTokenOf(okta, { roles: ['ae-admin'] }, profiles)).toBe('admin');
    expect(holderTokenOf(entra, {}, profiles)).toBe('basic');
  });
});

describe('the same subject under two issuers is two people', () => {
  const identity = jest.requireActual('../../lambda/src/lib/person-identity') as typeof import('../../lambda/src/lib/person-identity');
  const rows = new Map<string, Record<string, unknown>>();
  const doc = {
    send: jest.fn(async (cmd: { __type?: string; input: any }) => {
      const key = cmd.__type === 'Get' ? cmd.input.Key.issuerSubject : cmd.input.Item?.issuerSubject;
      if (cmd.__type === 'Get') return { Item: rows.get(key) };
      if (cmd.__type === 'Put' && cmd.input.TableName === 'identities') {
        if (rows.has(key)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
        rows.set(key, cmd.input.Item);
      }
      return {};
    }),
  };
  const deps = { doc, chime: { send: jest.fn(async () => ({})) }, table: 'identities', appInstanceArn: APP, audit: async () => undefined };

  it('mints one AppInstanceUser per (registry id, subject), never per subject alone', async () => {
    const a = await identity.mintOrResolvePerson({ issuer: 'deployment', subject: 'same-sub' }, deps);
    const b = await identity.mintOrResolvePerson({ issuer: 'host', subject: 'same-sub' }, deps);
    expect(a.personArn).not.toBe(b.personArn);
    expect([...rows.keys()].sort()).toEqual(['deployment|same-sub', 'host|same-sub']);
  });

  it('refuses a revoked subject and mints nothing for it', async () => {
    rows.set(identity.revokedMarkerKey('host', 'gone'), { issuerSubject: identity.revokedMarkerKey('host', 'gone') });
    await expect(identity.mintOrResolvePerson({ issuer: 'host', subject: 'gone' }, deps)).rejects.toMatchObject({ name: 'PersonNotActive' });
    expect(rows.has('host|gone')).toBe(false);
  });
});

describe('the resolver refuses what the registry does not declare', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mocked = require('../../lambda/src/lib/person-identity') as { resolvePerson: jest.Mock };
  const auth = () => jest.requireActual('../../lambda/src/lib/auth') as typeof import('../../lambda/src/lib/auth');
  // What the edge authorizer hands a handler: the registry id, the subject that entry declares, the person.
  const fromEdge = (issuerId: string, subject?: string) => edgeEvent('POST', '/tasks', {
    issuerId, subject: subject as string, personId: 'p-1', personArn: `${APP}/user/p-1`, claims: { sub: subject },
  });
  beforeEach(() => {
    process.env.APP_INSTANCE_ARN = APP;
    process.env.USER_POOL_ID = POOL;
    process.env.TRUSTED_ISSUERS = JSON.stringify(REGISTRY);
    mocked.resolvePerson.mockClear();
  });
  afterAll(() => { delete process.env.TRUSTED_ISSUERS; });

  it('names the caller through the registry entry the edge named, by its id', async () => {
    const caller = await auth().callerPerson(fromEdge('okta', 'opaque-subject'));
    expect(caller?.issuer?.id).toBe('okta');
    expect(caller?.personId).toBe('p-1');
    // THE EDGE KEYED THE LOOKUP; the handler does none.
    expect(mocked.resolvePerson).not.toHaveBeenCalled();
  });

  it('refuses an issuer this function\'s registry does not declare, with nothing looked up', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await auth().callerPersonId(fromEdge('evil', 's'))).toBeNull();
    warn.mockRestore();
    expect(mocked.resolvePerson).not.toHaveBeenCalled();
  });

  it('refuses a context that names no subject, and reads none off a claim', async () => {
    expect(await auth().callerPersonId(fromEdge('okta'))).toBeNull();
    expect(mocked.resolvePerson).not.toHaveBeenCalled();
  });
});

describe('a removed issuer is refused once the registry is read again', () => {
  beforeEach(() => __resetTrustedIssuersForTests());
  afterAll(() => { delete process.env.TRUSTED_ISSUERS; __resetTrustedIssuersForTests(); });

  it('resolves while declared, and is refused after the TTL once removed', () => {
    const t0 = 1_000_000;
    process.env.TRUSTED_ISSUERS = JSON.stringify(REGISTRY);
    expect(issuerOfToken({ iss: HOST_ISS, sub: 's' }, t0)?.id).toBe('host');
    // Within the TTL an unchanged configuration is not read again.
    expect(issuerOfToken({ iss: HOST_ISS, sub: 's' }, t0 + REGISTRY_TTL_MS - 1)?.id).toBe('host');
    // The redeploy that removes it.
    process.env.TRUSTED_ISSUERS = JSON.stringify(REGISTRY.filter((t) => t.id !== 'host'));
    expect(issuerOfToken({ iss: HOST_ISS, sub: 's' }, t0 + REGISTRY_TTL_MS + 1)).toBeNull();
    expect(issuerOfToken({ iss: POOL_ISS, sub: 's' }, t0 + REGISTRY_TTL_MS + 1)?.id).toBe('deployment');
  });

  it('trusts nobody when the registry cannot be read', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.TRUSTED_ISSUERS = '{not json';
    expect(issuerOfToken({ iss: POOL_ISS, sub: 's' })).toBeNull();
    err.mockRestore();
  });
});

describe('an OIDC admin (A6)', () => {
  const rows = new Map<string, { personArn: string }>();
  function loadExchange() {
    jest.resetModules();
    Object.assign(process.env, {
      APP_INSTANCE_ARN: APP,
      IDENTITIES_TABLE: 'identities',
      ACCESS_LOG_TABLE: 'access-log',
      USER_POOL_ID: POOL,
      TRUSTED_ISSUERS: JSON.stringify(REGISTRY),
      ADMIN_CONSOLE_ROLE_ARN: 'arn:aws:iam::111122223333:role/agent-echelon-admin-console',
      TEAM_CONSOLE_ROLE_ARN: 'arn:aws:iam::111122223333:role/agent-echelon-team-console',
      EXCHANGE_ROLE_ARNS_JSON: JSON.stringify({ basic: 'arn:aws:iam::111122223333:role/ex-basic', admin: 'arn:aws:iam::111122223333:role/ex-admin' }),
    });
    rows.clear();
    mockDocSend.mockImplementation(async (cmd: { __type?: string; input?: any }) => {
      if (cmd?.input?.TableName !== 'identities') return {};
      const key = cmd.__type === 'Get' ? cmd.input.Key.issuerSubject : cmd.input.Item?.issuerSubject;
      if (cmd.__type === 'Get') return { Item: rows.get(key) };
      if (rows.has(key)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      rows.set(key, cmd.input.Item);
      return {};
    });
    mockChimeSend.mockResolvedValue({});
    mockStsSend.mockReset().mockResolvedValue({ Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'sk', SessionToken: 'tok' } });
    type Exchange = { handler: (e: unknown) => Promise<{ statusCode: number; body: string }> };
    /* eslint-disable @typescript-eslint/no-var-requires */
    const person = require('../../lambda/src/credential-exchange') as Exchange;
    const admin = require('../../lambda/src/admin-credential-exchange') as Exchange;
    /* eslint-enable @typescript-eslint/no-var-requires */
    // The person exchange mints the person on their first sign-in; the admin exchange reads that person
    // for the console session and mints nobody. So a console request follows a sign-in, as in the console.
    return {
      handler: async (e: unknown) => {
        await person.handler({ ...(e as object), body: undefined });
        mockStsSend.mockClear();
        return admin.handler(e);
      },
    };
  }
  const consoleRequest = (claims: Record<string, unknown>) =>
    ({ httpMethod: 'POST', requestContext: { authorizer: edgeContext({ claims }) }, body: JSON.stringify({ identity: 'console' }) });
  afterAll(() => { delete process.env.TRUSTED_ISSUERS; });

  it('vends a console session whose opaque person id parses as an admin actor', async () => {
    const { handler } = loadExchange();
    const res = await handler(consoleRequest({ iss: OIDC_ISS, sub: 'okta-00u1abcd', roles: ['ae-admin'], name: 'Ana' }));
    expect(res.statusCode).toBe(200);
    const personArn = rows.get('okta|okta-00u1abcd')!.personArn;
    const personId = personArn.split('/').pop()!;
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleSessionName).toBe(`console-${personId}`);
    // The session the console then signs with, as every admin handler reads it.
    const auth = jest.requireActual('../../lambda/src/lib/auth') as typeof import('../../lambda/src/lib/auth');
    const sessionArn = `arn:aws:sts::111122223333:assumed-role/agent-echelon-admin-console/${input.RoleSessionName}`;
    expect(auth.consoleSessionOf(sessionArn)).toEqual({ kind: 'admin', personId, clearance: null });
    const signed = { requestContext: { identity: { userArn: sessionArn } } } as unknown as APIGatewayProxyEvent;
    expect(await auth.callerPersonId(signed)).toBe(personId);
    expect(auth.isAdminConsoleSession(signed)).toBe(true);
  });

  it('vends none to an issuer that does not declare admin: true, whatever its token\'s groups', async () => {
    const { handler } = loadExchange();
    const res = await handler(consoleRequest({ iss: POOL_ISS, sub: 'saml-user', identities: [{ providerName: 'Okta' }], 'custom:roles': 'analyst', 'cognito:groups': 'admins' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('NO_ADMIN_CAPABILITY');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a one-conversation issuer the admin console', async () => {
    const { handler } = loadExchange();
    const res = await handler(consoleRequest({ iss: HOST_ISS, sub: 'host-user', 'cognito:groups': 'admins' }));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});
