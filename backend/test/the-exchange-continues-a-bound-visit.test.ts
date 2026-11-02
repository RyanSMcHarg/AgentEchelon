/**
 * THE CREDENTIAL EXCHANGE CONTINUES A BOUND VISIT (B6, PLAN §16.5 P-11).
 *
 * After a path A bind the exchange opens the visit's continuation at the person's OWN classification,
 * the one it vends the session at, and names it in the answer (`bound.conversationArn`). The session is
 * never vended at the visitor's classification, so the visitor's conversation stays out of its reach. A
 * continuation that cannot be opened vends nothing, and the same call retried is recognized as the bind
 * that already happened: nothing is bound twice and the same continuation is asked for.
 *
 * The bind itself and the continuation's two halves are unit-tested in
 * `test/lib/binding-a-guest-ends-the-guest-credential.test.ts` and
 * `a-bind-continues-the-visit-in-a-new-conversation.test.ts`; here they are stand-ins, so what is asserted
 * is the exchange's wiring.
 */
import { edgeContext } from './helpers/edge-context';

const mockStsSend = jest.fn();
const mockChimeSend = jest.fn();
const mockDocSend = jest.fn();
const mockBind = jest.fn();
const mockReplay = jest.fn();
const mockContinue = jest.fn();

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
  TagResourceCommand: jest.fn((input: unknown) => ({ __type: 'TagResource', input })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTagsForResource', input })),
  PutAppInstanceUserExpirationSettingsCommand: jest.fn((input: unknown) => ({ __type: 'PutExpiration', input })),
}));
jest.mock('../lambda/src/lib/guest-bind', () => {
  const actual = jest.requireActual('../lambda/src/lib/guest-bind');
  return {
    ...actual,
    bindGuestPerson: (...a: unknown[]) => mockBind(...a),
    boundVisitOf: (...a: unknown[]) => mockReplay(...a),
    continueBoundVisit: (...a: unknown[]) => mockContinue(...a),
  };
});

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
const POOL = 'us-east-1_pool';
const ISS = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const IDENTITIES = 'identities';
const VISITOR_ID = '0190c0de-0000-7000-8000-000000000001';
const VISITOR = `${APP}/user/${VISITOR_ID}`;
const GUEST_CHANNEL = `${APP}/channel/guest-1`;
const CONTINUATION = `${APP}/channel/conv-bound-1`;
const BIND = { bindGuest: { nonce: 'nonce-1', secret: 'secret-1' } };

function loadHandler() {
  jest.resetModules();
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ACCESS_LOG_TABLE = 'access-log';
  process.env.IDENTITIES_TABLE = IDENTITIES;
  process.env.USER_POOL_ID = POOL;
  delete process.env.TRUSTED_ISSUERS;
  process.env.EXCHANGE_ROLE_ARNS_JSON = JSON.stringify({ basic: 'arn:aws:iam::111:role/ex-basic', standard: 'arn:aws:iam::111:role/ex-standard' });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../lambda/src/credential-exchange');
}

/** A first sign-in: the edge verified the token and found no `Identities` row, so it names no person. */
function firstSignIn(body: unknown) {
  const ctx: Record<string, unknown> = { ...edgeContext({ claims: { sub: 'c-sub', iss: ISS, 'cognito:groups': 'basic' } }) };
  delete ctx.personId;
  delete ctx.personArn;
  return { httpMethod: 'POST', requestContext: { authorizer: ctx }, body: JSON.stringify(body) };
}
/** The same sign-in after the bind: the edge resolves its row to the visitor's AppInstanceUser. */
function boundSignIn(body: unknown) {
  return { httpMethod: 'POST', requestContext: { authorizer: edgeContext({ claims: { sub: 'c-sub', iss: ISS, 'cognito:groups': 'basic' }, personId: VISITOR_ID }) }, body: JSON.stringify(body) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'sk', SessionToken: 'tok', Expiration: new Date('2030-01-01T00:00:00Z') } });
  mockChimeSend.mockResolvedValue({});
  // The bound row, for the retried call's resolve.
  mockDocSend.mockImplementation(async (cmd: { __type?: string; input?: any }) => {
    if (cmd.__type === 'Get' && cmd.input?.TableName === IDENTITIES && cmd.input.Key.issuerSubject === 'deployment|c-sub') {
      return { Item: { issuerSubject: 'deployment|c-sub', personArn: VISITOR, issuer: 'deployment', status: 'active' } };
    }
    return {};
  });
  mockBind.mockResolvedValue({ personId: VISITOR_ID, personArn: VISITOR, created: false, guestChannelArn: GUEST_CHANNEL });
  mockReplay.mockResolvedValue(null);
  mockContinue.mockResolvedValue({ ok: true, conversationArn: CONTINUATION });
});

describe('a bind', () => {
  it('opens the continuation at the person\'s own classification, vends that classification and names the new conversation', async () => {
    const { handler } = loadHandler();
    const r = await handler(firstSignIn(BIND));
    expect(r.statusCode).toBe(200);
    expect(mockBind).toHaveBeenCalledTimes(1);
    expect(mockContinue).toHaveBeenCalledTimes(1);
    expect(mockContinue.mock.calls[0][0]).toEqual({ personArn: VISITOR, guestChannelArn: GUEST_CHANNEL, classification: 'basic' });
    expect(JSON.parse(r.body).bound).toEqual({ from: 'guest', channelArn: GUEST_CHANNEL, conversationArn: CONTINUATION });
    // THE GUEST ROOM STAYS UNREACHABLE: the session is the person's own classification, never the visitor's.
    const assumed = mockStsSend.mock.calls[0][0].input;
    expect(assumed.RoleArn).toBe('arn:aws:iam::111:role/ex-basic');
    expect(assumed.Tags).toEqual([{ Key: 'person', Value: VISITOR_ID }, { Key: 'classification', Value: 'basic' }]);
    expect(JSON.stringify(assumed)).not.toContain('guest');
  });

  it('whose continuation cannot be opened vends nothing, and says to retry', async () => {
    mockContinue.mockResolvedValue({ ok: false, why: 'the creator did not answer' });
    const { handler } = loadHandler();
    const r = await handler(firstSignIn(BIND));
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body).code).toBe('CONTINUATION_UNAVAILABLE');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('retried after it happened binds nothing twice and asks for the same continuation', async () => {
    mockReplay.mockResolvedValue(GUEST_CHANNEL);
    const { handler } = loadHandler();
    const r = await handler(boundSignIn(BIND));
    expect(r.statusCode).toBe(200);
    expect(mockReplay.mock.calls[0][0]).toEqual({ personId: VISITOR_ID, request: { nonce: 'nonce-1', secret: 'secret-1' } });
    expect(mockBind).not.toHaveBeenCalled();
    expect(mockContinue.mock.calls[0][0]).toEqual({ personArn: VISITOR, guestChannelArn: GUEST_CHANNEL, classification: 'basic' });
    expect(JSON.parse(r.body).bound).toEqual({ from: 'guest', channelArn: GUEST_CHANNEL, conversationArn: CONTINUATION });
  });

  it('from an existing account that is not this visit\'s is path B: refused, and nothing is opened', async () => {
    const { handler } = loadHandler();
    const r = await handler(boundSignIn(BIND));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('SUBJECT_ALREADY_BOUND');
    expect(mockBind).not.toHaveBeenCalled();
    expect(mockContinue).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('an ordinary sign-in opens no continuation', async () => {
    const { handler } = loadHandler();
    const r = await handler(boundSignIn({}));
    expect(r.statusCode).toBe(200);
    expect(mockContinue).not.toHaveBeenCalled();
    expect(JSON.parse(r.body).bound).toBeUndefined();
  });
});
