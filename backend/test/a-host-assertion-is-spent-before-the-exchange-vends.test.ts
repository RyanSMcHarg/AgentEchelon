/**
 * A HOST ASSERTION IS SPENT BEFORE THE EXCHANGE VENDS, AND BINDS ONLY A PROVISIONED SUBJECT (A9, P-13).
 *
 * The credential exchange is the second layer behind the edge for a `host-assertion` issuer:
 *
 *  - the assertion's `jti`, which the edge recorded, is consumed before anything is bound or assumed: an
 *    assertion the edge never recorded, one already consumed and one expired are each refused, and nothing
 *    is vended;
 *  - its subject is bound to the person `provisionSubject` pre-assigned (a `pending` row), once: the row
 *    becomes `active`, and the person it names is created and vended, never a new id;
 *  - a subject with no row is refused (`PERSON_NOT_PROVISIONED`), and nothing is created for it;
 *  - a `pending` row written for another issuer is not accepted from this one;
 *  - a permission set the issuer's mapping does not declare reaches nothing (Q5);
 *  - each refusal is counted by check.
 *
 * `Identities` and `Tokens` are in memory here, honoring their conditions the way DynamoDB does. The same
 * refusals against a deployment are `backend/scripts/deny-test-host-assertion.mjs` and
 * `backend/scripts/deny-test-pending-identities.mjs`.
 */
import { generateKeyPairSync } from 'crypto';
import { edgeContext } from './helpers/edge-context';
import { compactIssuers, issuerRegistry, runtimeIssuers } from '../lib/config/issuers';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

const mockStsSend = jest.fn();
const mockChimeSend = jest.fn();
const mockDocSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) },
  PutCommand: jest.fn((input: unknown) => ({ __type: 'Put', input })),
  GetCommand: jest.fn((input: unknown) => ({ __type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ __type: 'Update', input })),
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
  TagResourceCommand: jest.fn((input: unknown) => ({ __type: 'TagResource', input })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTagsForResource', input })),
}));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const IDENTITIES = 'identities';
const HOST_ISS = 'https://example.my.salesforce.com';
const SUBJECT = '00D000000000001:005000000000001';
const PRE_ASSIGNED = `${APP}/user/0190a000-0000-7000-8000-00000000beef`;
const ALL = ['basic', 'standard', 'premium', 'admin'];
// Any well-formed pinned key: this suite starts behind the edge, which verified the signature.
const HOST_KEY = (generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true },
  {
    id: 'salesforce-org', kind: 'host-assertion', issuer: HOST_ISS, allowedOrigins: ['https://example.lightning.force.com'],
    hostAssertion: { publicKeys: { k1: HOST_KEY } },
    clearance: { mapping: { claim: 'permsets', values: { AE_Sales: 'standard' } }, classifications: ['basic', 'standard'] },
  },
  {
    id: 'other-host', kind: 'host-assertion', issuer: 'https://other.my.salesforce.com', allowedOrigins: ['https://other.lightning.force.com'],
    hostAssertion: { publicKeys: { k1: HOST_KEY } },
    clearance: { fixed: ['basic'], classifications: ['basic'] },
  },
];

// ── IDENTITIES, IN MEMORY, HONORING ITS CONDITIONS ──────────────────────────────────────────────────
const rows = new Map<string, Record<string, any>>();
async function identitiesDoc(cmd: { __type?: string; input?: any }): Promise<unknown> {
  if (cmd?.input?.TableName !== IDENTITIES) return {};
  if (cmd.__type === 'Get') return { Item: rows.get(cmd.input.Key.issuerSubject) };
  if (cmd.__type === 'Put') {
    if (rows.has(cmd.input.Item.issuerSubject)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    rows.set(cmd.input.Item.issuerSubject, cmd.input.Item);
    return {};
  }
  if (cmd.__type === 'Update') {
    const row = rows.get(cmd.input.Key.issuerSubject);
    const v = cmd.input.ExpressionAttributeValues;
    if (!row || row.status !== v[':pending'] || row.issuer !== v[':issuer']) throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
    rows.set(cmd.input.Key.issuerSubject, { ...row, status: v[':active'], boundAt: v[':boundAt'] });
    return {};
  }
  return {};
}

// ── TOKENS: the records the edge wrote, consumed once ─────────────────────────────────────────────
const jtis = new Map<string, { expiresAt: number; consumedAt?: number }>();
const counted: string[] = [];

function load() {
  jest.resetModules();
  process.env.APP_INSTANCE_ARN = APP;
  process.env.IDENTITIES_TABLE = IDENTITIES;
  process.env.ACCESS_LOG_TABLE = 'access-log';
  process.env.USER_POOL_ID = 'us-east-1_pool';
  process.env.EXCHANGE_ROLE_ARNS_JSON = JSON.stringify({ basic: 'arn:aws:iam::111122223333:role/ex-basic', standard: 'arn:aws:iam::111122223333:role/ex-standard' });
  process.env.TRUSTED_ISSUERS = JSON.stringify(compactIssuers(runtimeIssuers(issuerRegistry(REGISTRY, profiles), 'us-east-1_pool', 'us-east-1', 'test-instance')));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const exchange = require('../lambda/src/credential-exchange');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../lambda/src/lib/host-assertion-exchange').__setHostAssertionDepsForTests({
    consume: async (issuerId: string, jti: string, now: number) => {
      const r = jtis.get(`${issuerId}|${jti}`);
      if (!r) return { ok: false, reason: 'unknown' };
      if (r.consumedAt !== undefined) return { ok: false, reason: 'consumed' };
      if (r.expiresAt <= now) return { ok: false, reason: 'expired' };
      r.consumedAt = now;
      return { ok: true, record: {} };
    },
    count: (issuerId: string, check: string) => { counted.push(`${issuerId}:${check}`); },
  });
  return exchange;
}

const now = () => Math.floor(Date.now() / 1000);
let n = 0;
/** An assertion's claims, its `jti` recorded by the edge unless `recorded` is false. */
function assertion(over: Record<string, unknown> = {}, recorded = true) {
  const jti = `jti-${++n}`;
  const claims = { iss: HOST_ISS, org: '00D000000000001', sub: '005000000000001', permsets: ['AE_Sales'], jti, ...over };
  const issuerId = claims.iss === HOST_ISS ? 'salesforce-org' : 'other-host';
  if (recorded) jtis.set(`${issuerId}|${claims.jti}`, { expiresAt: now() + 300 });
  return claims;
}
const event = (claims: Record<string, unknown>) => ({ httpMethod: 'POST', requestContext: { authorizer: edgeContext({ claims }) }, body: '{}' });
const pendingRow = (issuer = 'salesforce-org') => ({
  issuerSubject: `${issuer}|${SUBJECT}`, personArn: PRE_ASSIGNED, issuer, status: 'pending', createdAt: '2026-10-19T00:00:00.000Z', provisionedBy: 'connectors',
});

beforeEach(() => {
  jest.clearAllMocks();
  rows.clear();
  jtis.clear();
  counted.length = 0;
  mockDocSend.mockReset().mockImplementation(identitiesDoc);
  mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'sk', SessionToken: 'tok', Expiration: new Date('2030-01-01T00:00:00Z') } });
  mockChimeSend.mockResolvedValue({});
});

describe('the exchange spends a host assertion before it vends', () => {
  it('binds a pending subject once, to the person it pre-assigned, and vends at the mapped classification', async () => {
    const { handler } = load();
    rows.set(`salesforce-org|${SUBJECT}`, pendingRow());
    const res = await handler(event(assertion()));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).userArn).toBe(PRE_ASSIGNED);
    expect(rows.get(`salesforce-org|${SUBJECT}`)).toMatchObject({ status: 'active', personArn: PRE_ASSIGNED });
    const assume = mockStsSend.mock.calls[0][0].input;
    expect(assume.RoleArn).toBe('arn:aws:iam::111122223333:role/ex-standard');
    expect(assume.Tags).toEqual([{ Key: 'person', Value: '0190a000-0000-7000-8000-00000000beef' }, { Key: 'classification', Value: 'standard' }]);
    // The pre-assigned id becomes a person at this first sign-in, and no other id is ever minted.
    const created = mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'CreateAppInstanceUser');
    expect(created.map((c) => c.input.AppInstanceUserId)).toEqual(['0190a000-0000-7000-8000-00000000beef']);
  });

  it('refuses the same assertion presented twice, the second time before anything is vended', async () => {
    const { handler } = load();
    rows.set(`salesforce-org|${SUBJECT}`, pendingRow());
    const claims = assertion();
    expect((await handler(event(claims))).statusCode).toBe(200);
    mockStsSend.mockClear();
    const again = await handler(event(claims));
    expect(again.statusCode).toBe(401);
    expect(JSON.parse(again.body).code).toBe('ASSERTION_REFUSED');
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(counted).toEqual(['salesforce-org:replayed']);
  });

  it('refuses an assertion the edge never recorded, and an expired record', async () => {
    const { handler } = load();
    rows.set(`salesforce-org|${SUBJECT}`, pendingRow());
    expect((await handler(event(assertion({}, false)))).statusCode).toBe(401);
    const expired = assertion();
    jtis.get(`salesforce-org|${expired.jti}`)!.expiresAt = now() - 1;
    expect((await handler(event(expired))).statusCode).toBe(401);
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(rows.get(`salesforce-org|${SUBJECT}`)!.status).toBe('pending');
    expect(counted).toEqual(['salesforce-org:unrecorded', 'salesforce-org:expired']);
  });

  it('refuses an assertion that carries no jti', async () => {
    const { handler } = load();
    expect((await handler(event(assertion({ jti: undefined }, false)))).statusCode).toBe(401);
    expect(counted).toEqual(['salesforce-org:no-jti']);
  });

  it('refuses a subject nobody provisioned, and creates nothing for it', async () => {
    const { handler } = load();
    const res = await handler(event(assertion()));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_PROVISIONED');
    expect(rows.size).toBe(0);
    expect(mockChimeSend.mock.calls.filter((c) => c[0].__type === 'CreateAppInstanceUser')).toEqual([]);
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(counted).toEqual(['salesforce-org:not-provisioned']);
  });

  it('does not accept a pending row written for another issuer', async () => {
    const { handler } = load();
    // A row under this issuer's key whose own issuer attribute names another: never bound.
    rows.set(`salesforce-org|${SUBJECT}`, { ...pendingRow(), issuer: 'other-host' });
    expect((await handler(event(assertion()))).statusCode).toBe(403);
    expect(rows.get(`salesforce-org|${SUBJECT}`)!.status).toBe('pending');
    // And the other issuer's own pending row is not this issuer's.
    rows.clear();
    rows.set(`other-host|${SUBJECT}`, pendingRow('other-host'));
    expect(JSON.parse((await handler(event(assertion()))).body).code).toBe('PERSON_NOT_PROVISIONED');
    expect(rows.get(`other-host|${SUBJECT}`)!.status).toBe('pending');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a permission set the mapping does not declare: it reaches nothing', async () => {
    const { handler } = load();
    rows.set(`salesforce-org|${SUBJECT}`, pendingRow());
    const res = await handler(event(assertion({ permsets: ['System_Administrator'] })));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(counted).toEqual(['salesforce-org:unmapped-permission-set']);
  });

  it('refuses a subject of a provisioned-only issuer whose row was written for another issuer', async () => {
    const { handler } = load();
    rows.set(`salesforce-org|${SUBJECT}`, { ...pendingRow(), issuer: 'another-issuer' });
    const res = await handler(event(assertion()));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_ACTIVE');
  });

  it('resolves a bound person on a later assertion, as the same person', async () => {
    const { handler } = load();
    rows.set(`salesforce-org|${SUBJECT}`, pendingRow());
    expect((await handler(event(assertion()))).statusCode).toBe(200);
    const later = await handler(event(assertion()));
    expect(later.statusCode).toBe(200);
    expect(JSON.parse(later.body).userArn).toBe(PRE_ASSIGNED);
  });
});
