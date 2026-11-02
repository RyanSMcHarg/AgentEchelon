/**
 * A ONE-CONVERSATION PERSON REACHES EXACTLY ONE CONVERSATION, THROUGH THE ONE EXCHANGE.
 *
 * A host app embedding the assistant declares its own pool in the trusted-issuer registry with the
 * one-conversation session (`clearance: { oneChannel }`, Q5). Its people are the least-trusted callers
 * in the system, and the exchange every issuer shares vends them the narrowest credential: read and
 * participate, on the one channel they name, as their own AppInstanceUser, for an hour, on the
 * `restricted` role. This reproduces the session policy the separate host-pool exchange applied, so
 * folding that copy into the one exchange widens nothing (R2), and it asserts it on the merged handler
 * by calling it, not by reading its source.
 *
 * ── AND WHY THE ROW IS STILL THE WEAKEST ONE ────────────────────────────────────────────────────
 *
 * The `restricted` role carries NO `aws:ResourceTag/classification` condition, so unlike every ordinary
 * person it is not classification-gated (SPEC-CONVERSATION-SECURITY section 4a, footnote 1). Such a
 * person is bounded by SCOPE and MEMBERSHIP instead, so these pin the two mechanisms that bound it.
 *
 * The rest of their reach is refused by default: every handler that resolves its caller through
 * `callerPerson` gets nobody for them unless it admits the one-conversation session, which only the
 * conversation they open does.
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
import { edgeContext } from '../helpers/edge-context';
import { groupsOf } from '../../lib/config/issuers';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/ctx-basic-plan-p1`;
const POOL = 'us-east-1_Deployment';
const HOST_POOL = 'us-east-1_HostApp';
const HOST_ISS = `https://cognito-idp.us-east-1.amazonaws.com/${HOST_POOL}`;
const RESTRICTED = 'arn:aws:iam::111122223333:role/ex-restricted';
const SUB = 'host-subject-1';

/** The registry: this deployment's own pool, and the host app's with the one-conversation session. */
const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: POOL, iss: `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`, subject: ['sub'], clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true, groupsClaim: 'cognito:groups' },
  { id: 'host', kind: 'cognito-pool', pool: HOST_POOL, iss: HOST_ISS, subject: ['sub'], clearance: { oneChannel: 'basic', classifications: ['basic'] }, admin: false, groupsClaim: 'cognito:groups' },
];

const rows = new Map<string, { personArn: string; [k: string]: unknown }>();
async function identitiesDoc(cmd: { __type?: string; input?: any }): Promise<unknown> {
  if (cmd?.input?.TableName !== 'identities') return {};
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
    EXCHANGE_ROLE_RESTRICTED: RESTRICTED,
    EXCHANGE_ROLE_ARNS_JSON: JSON.stringify({ basic: 'arn:aws:iam::111122223333:role/ex-basic', premium: 'arn:aws:iam::111122223333:role/ex-premium' }),
    TRUSTED_ISSUERS: JSON.stringify(REGISTRY),
  });
  rows.clear();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../lambda/src/credential-exchange') as { handler: (e: unknown) => Promise<{ statusCode: number; body: string }> };
}

const hostToken = (extra: Record<string, unknown> = {}) => ({ sub: SUB, iss: HOST_ISS, name: 'Priya', ...extra });
const vend = (claims: Record<string, unknown>, body?: unknown) =>
  ({ httpMethod: 'POST', requestContext: { authorizer: edgeContext({ claims }) }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  jest.clearAllMocks();
  mockDocSend.mockImplementation(identitiesDoc);
  mockChimeSend.mockResolvedValue({});
  mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'sk', SessionToken: 'tok' } });
});

const assumed = () => mockStsSend.mock.calls.map((c) => c[0].input);

describe('the one exchange vends a one-conversation issuer exactly one conversation', () => {
  it('REQUIRES a channelArn, and refuses one that could widen the policy resource', async () => {
    const { handler } = loadExchange();
    // Optional would leave the widest grant reachable by omitting the field.
    for (const body of [{}, { channelArn: `${APP}/channel/*` }, { channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/other/channel/x' },
      { channelArn: `${APP}/channel/a/b` }, { channelArn: `${APP}/channel/` }]) {
      const res = await handler(vend(hostToken(), body));
      expect([JSON.stringify(body), res.statusCode]).toEqual([JSON.stringify(body), 400]);
    }
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('vends a session policy naming that one channel and the bearer, on the restricted role, for an hour', async () => {
    const { handler } = loadExchange();
    const res = await handler(vend(hostToken(), { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.tier).toBe('restricted');
    const [input] = assumed();
    expect(input.RoleArn).toBe(RESTRICTED);
    expect(input.DurationSeconds).toBe(3600);
    const policy = JSON.parse(input.Policy);
    const one = policy.Statement.find((s: { Sid: string }) => s.Sid === 'OneConversation');
    expect(one.Resource).toEqual([CHANNEL, out.userArn]);
    expect(one.Action.sort()).toEqual([
      'chime:DescribeChannel', 'chime:GetChannelMessage', 'chime:ListChannelMemberships',
      'chime:ListChannelMessages', 'chime:SendChannelMessage', 'chime:UpdateChannelReadMarker',
    ]);
    // Nothing else names a channel: the only other statement is the session endpoint and connect.
    expect(policy.Statement.map((s: { Sid: string }) => s.Sid).sort()).toEqual(['OneConversation', 'SessionAndConnect']);
  });

  it('grants READ and PARTICIPATE only - never moderation, membership or rename', async () => {
    const { handler } = loadExchange();
    await handler(vend(hostToken(), { channelArn: CHANNEL }));
    const actions = JSON.parse(assumed()[0].Policy).Statement.flatMap((s: { Action: string[] }) => s.Action);
    for (const forbidden of [
      'chime:RedactChannelMessage', 'chime:DeleteChannelMessage', 'chime:CreateChannelMembership',
      'chime:DeleteChannelMembership', 'chime:CreateChannelModerator', 'chime:UpdateChannel', 'chime:DeleteChannel',
    ]) expect(actions).not.toContain(forbidden);
  });

  it('asserts both session tags, pinning the bearer on the person minted under the issuer\'s registry id', async () => {
    const { handler } = loadExchange();
    const out = JSON.parse((await handler(vend(hostToken(), { channelArn: CHANNEL }))).body);
    const personArn = rows.get(`host|${SUB}`)?.personArn;
    expect(personArn).toBe(out.userArn);
    const personId = out.userArn.split('/').pop();
    expect(assumed()[0].Tags).toEqual([{ Key: 'person', Value: personId }, { Key: 'classification', Value: 'restricted' }]);
  });

  it('reaches nothing more whatever the host token carries or the body asks for', async () => {
    const { handler } = loadExchange();
    // A host pool that also has a `premium` group, and a body asking for every other plane.
    for (const body of [
      { channelArn: CHANNEL, identity: 'console' },
      { channelArn: CHANNEL, identity: 'admin' },
      { channelArn: CHANNEL, capabilities: ['view', 'participate', 'manage-membership'] },
    ]) {
      const res = await handler(vend(hostToken({ 'cognito:groups': '[admins premium]' }), body));
      expect([JSON.stringify(body), res.statusCode]).toEqual([JSON.stringify(body), 403]);
    }
    expect(mockStsSend).not.toHaveBeenCalled();
    // The groups claim never selects a role for this issuer: the vend is the one conversation.
    await handler(vend(hostToken({ 'cognito:groups': 'premium' }), { channelArn: CHANNEL }));
    expect(assumed()[0].RoleArn).toBe(RESTRICTED);
  });
});

describe('every other route refuses a one-conversation person unless it admits them', () => {
  const auth = () => jest.requireActual('../../lambda/src/lib/auth') as typeof import('../../lambda/src/lib/auth');
  const event = (claims: Record<string, unknown>) => ({ requestContext: { authorizer: edgeContext({ claims }) } }) as unknown as APIGatewayProxyEvent;
  beforeEach(() => {
    process.env.APP_INSTANCE_ARN = APP;
    process.env.USER_POOL_ID = POOL;
    process.env.TRUSTED_ISSUERS = JSON.stringify(REGISTRY);
  });

  it('resolves nobody by default, and the person when the handler admits the session', async () => {
    const a = auth();
    expect(await a.callerPersonId(event(hostToken()))).toBeNull();
    expect('statusCode' in (await a.requireAuth(event(hostToken())))).toBe(true);
    expect(await a.callerPersonId(event(hostToken()), { oneChannel: true })).toBe(SUB);
    expect(a.callerOneChannel(event(hostToken()))).toBe('basic');
  });

  it('holds no group, no classification and no admin, whatever its token says', () => {
    const a = auth();
    const e = event(hostToken({ 'cognito:groups': '[admins premium]' }));
    const caller = a.edgeCallerOf(e)!;
    expect(caller.issuer.id).toBe('host');
    expect(groupsOf(caller.issuer, caller.claims)).toEqual([]);
    expect(a.callerHolderToken(e)).toBeUndefined();
    expect(a.callerIsAdmin(e)).toBe(false);
  });
});
