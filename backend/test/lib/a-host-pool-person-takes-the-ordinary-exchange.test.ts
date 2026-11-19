/**
 * A PERSON FROM A HOST APP'S POOL IS AN ORDINARY IDENTITY.
 *
 * A host app declares its pool in the trusted-issuer registry with an ordinary clearance source. What limits
 * its people is that declaration: the exchange vends them their classification on that classification's own
 * role, as it does anyone, and Amazon Chime SDK membership and the classification decide what they reach. A
 * first sign-in writes the person's `Identities` row, which is what a host's add resolves them through
 * (`membershipHandler`, `a-host-adds-a-person-to-its-context-conversation.test.ts`).
 */
const mockStsSend = jest.fn();
const mockChimeSend = jest.fn();
const mockDocSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) },
  PutCommand: jest.fn((input: unknown) => ({ __type: 'Put', input })),
  GetCommand: jest.fn((input: unknown) => ({ __type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ __type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ __type: 'Update', input })),
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
// The issuer answers that the account is active; `a-disabled-account-is-refused-at-the-next-vend` covers the other answers.
jest.mock('../../lambda/src/lib/membership-source', () => ({
  ...jest.requireActual('../../lambda/src/lib/membership-source'),
  defaultDirectory: () => ({ accountState: async () => 'active' }),
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { edgeContext } from '../helpers/edge-context';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const POOL = 'us-east-1_Deployment';
const HOST_POOL = 'us-east-1_HostApp';
const HOST_ISS = `https://cognito-idp.us-east-1.amazonaws.com/${HOST_POOL}`;
const BASIC_ROLE = 'arn:aws:iam::111122223333:role/ex-basic';
const SUB = 'host-subject-1';

/** This deployment's own pool, and the host app's, whose people are cleared for `basic` by a fixed set. */
const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: POOL, iss: `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`, subject: ['sub'], clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true, groupsClaim: 'cognito:groups' },
  { id: 'host', kind: 'cognito-pool', pool: HOST_POOL, iss: HOST_ISS, subject: ['sub'], clearance: { fixed: ['basic'], classifications: ['basic'] }, admin: false, groupsClaim: 'cognito:groups' },
];

const rows = new Map<string, { personArn: string; [k: string]: unknown }>();
async function identitiesDoc(cmd: { __type?: string; input?: any }): Promise<unknown> {
  if (cmd?.input?.TableName !== 'identities') return {};
  if (cmd.__type === 'Update') return {};
  const key = cmd.__type === 'Get' ? cmd.input.Key.issuerSubject : cmd.input.Item?.issuerSubject;
  if (cmd.__type === 'Get') return { Item: rows.get(key) };
  if (rows.has(key)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
  rows.set(key, cmd.input.Item);
  return {};
}

function loadExchange() {
  jest.resetModules();
  Object.assign(process.env, {
    APP_INSTANCE_ARN: APP,
    IDENTITIES_TABLE: 'identities',
    ACCESS_LOG_TABLE: 'access-log',
    USER_POOL_ID: POOL,
    EXCHANGE_ROLE_ARNS_JSON: JSON.stringify({ basic: BASIC_ROLE }),
    TRUSTED_ISSUERS: JSON.stringify(REGISTRY),
  });
  rows.clear();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../lambda/src/credential-exchange') as { handler: (e: unknown) => Promise<{ statusCode: number; body: string }> };
}

const hostToken = (extra: Record<string, unknown> = {}) => ({ sub: SUB, iss: HOST_ISS, name: 'Priya', ...extra });
const vend = (claims: Record<string, unknown>, body: unknown = {}) =>
  ({ httpMethod: 'POST', requestContext: { authorizer: edgeContext({ claims }) }, body: JSON.stringify(body) });
const assumed = () => mockStsSend.mock.calls.map((c) => c[0].input);

beforeEach(() => {
  jest.clearAllMocks();
  mockDocSend.mockImplementation(identitiesDoc);
  mockChimeSend.mockResolvedValue({});
  mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'sk', SessionToken: 'tok' } });
});

describe('the exchange vends a host pool person as it vends anyone', () => {
  it('a first sign-in is minted under the registry id and vended their classification, so a host\'s add finds them', async () => {
    const { handler } = loadExchange();
    const res = await handler(vend(hostToken()));
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.tier).toBe('basic');
    expect(rows.get(`host|${SUB}`)?.personArn).toBe(out.userArn);
    const [input] = assumed();
    expect(input.RoleArn).toBe(BASIC_ROLE);
    expect(input.Tags).toEqual(expect.arrayContaining([
      { Key: 'person', Value: out.userArn.split('/').pop() },
      { Key: 'classification', Value: 'basic' },
    ]));
  });

  it('the fixed set decides the classification, whatever groups the token carries', async () => {
    const { handler } = loadExchange();
    const out = JSON.parse((await handler(vend(hostToken({ 'cognito:groups': '[admins premium]' })))).body);
    expect(out.tier).toBe('basic');
    expect(assumed()[0].RoleArn).toBe(BASIC_ROLE);
  });

  it('asks for a console session are refused here, as for any person', async () => {
    const { handler } = loadExchange();
    const res = await handler(vend(hostToken(), { identity: 'console' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ADMIN_VEND_MOVED');
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});

describe('every other route reads a host pool person as a person', () => {
  const auth = () => jest.requireActual('../../lambda/src/lib/auth') as typeof import('../../lambda/src/lib/auth');
  const event = (claims: Record<string, unknown>) => ({ requestContext: { authorizer: edgeContext({ claims, personId: 'p-1' }) } }) as unknown as APIGatewayProxyEvent;
  beforeEach(() => {
    process.env.APP_INSTANCE_ARN = APP;
    process.env.USER_POOL_ID = POOL;
    process.env.TRUSTED_ISSUERS = JSON.stringify(REGISTRY);
  });

  it('resolves their AppInstanceUser, at their fixed classification and never as an admin', async () => {
    const a = auth();
    const e = event(hostToken({ 'cognito:groups': '[admins premium]' }));
    expect(await a.callerPersonId(e)).toBe('p-1');
    expect(a.callerHolderToken(e)).toBe('basic');
    expect(a.callerIsAdmin(e)).toBe(false);
  });
});
