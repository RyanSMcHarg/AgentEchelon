import { edgeContext } from './helpers/edge-context';
/**
 * Unit tests for the Credential Exchange Lambda (lambda/src/credential-exchange.ts).
 *
 * Pins the security contract: identity from validated claims only (IDOR), the authoritative
 * classification-to-role selection, and that every AssumeRole carries BOTH session tags.
 *
 * TWO TAGS, ANSWERING TWO QUESTIONS. `sub` is the bearer pin - who this credential belongs to, which
 * the role's policy matches to stop one person's credential acting as another. `classification` is
 * how far it reaches, which the role's TRUST policy matches, so a session that asserts no reach
 * cannot assume the role at all. This file pinned only the first, and a vend asserting nothing about
 * reach would have passed every test in it.
 */

const mockStsSend = jest.fn();
const mockChimeSend = jest.fn();
const mockSsmSend = jest.fn();
// The Access Log: every admin vend writes a record before it returns the credential (ADR-052).
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
  // The identity classification tag. Absent from this mock, `new TagResourceCommand(...)` threw
  // inside the handler's best-effort catch - so the tag silently never went out and every test here
  // still passed, which is the shape of gap this file exists to close.
  TagResourceCommand: jest.fn((input: unknown) => ({ __type: 'TagResource', input })),
  ListAppInstanceBotsCommand: jest.fn((input: unknown) => ({ __type: 'ListAppInstanceBots', input })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTagsForResource', input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __type: 'GetParameter', input })),
}));

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';

// ── THE IDENTITIES TABLE, IN MEMORY ──────────────────────────────────────────────────────────────
//
// The exchange mints the person through lib/person-identity.ts, which reads and conditionally writes
// this table. A Map honours the condition the way DynamoDB does, so a second exchange for a subject
// resolves the row the first one reserved.
const IDENTITIES = 'identities';
const POOL = 'us-east-1_pool';
/** The native pool's token issuer, and the trusted-issuer registry id the exchange keys its rows on. */
const NATIVE_ISS = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const NATIVE_ID = 'deployment';
/** A second pool, declared in the registry beside the deployment's own. */
const OTHER_POOL = 'us-east-1_other';
const OTHER_ISS = `https://cognito-idp.us-east-1.amazonaws.com/${OTHER_POOL}`;
const identityRows = new Map<string, { personArn: string; [k: string]: unknown }>();
async function identitiesDoc(cmd: { __type?: string; input?: any }): Promise<unknown> {
  if (cmd?.input?.TableName !== IDENTITIES) return {};
  const key = cmd.__type === 'Get' ? cmd.input.Key.issuerSubject : cmd.input.Item?.issuerSubject;
  if (cmd.__type === 'Get') return { Item: identityRows.get(key) };
  if (cmd.__type === 'Update') {
    // The one update the exchange makes: its clearance decision, on a row that exists (C3).
    const row = identityRows.get(cmd.input.Key.issuerSubject);
    if (!row) throw Object.assign(new Error('no row'), { name: 'ConditionalCheckFailedException' });
    expect(cmd.input.UpdateExpression).toBe('SET clearanceDecision = :d');
    row.clearanceDecision = cmd.input.ExpressionAttributeValues[':d'];
    return {};
  }
  if (identityRows.has(key)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
  identityRows.set(key, cmd.input.Item);
  return {};
}
/** The AppInstanceUser ARN the exchange minted for this subject of the native pool. */
function personArnOf(sub: string, issuerId: string = NATIVE_ID): string {
  const row = identityRows.get(`${issuerId}|${sub}`);
  if (!row) throw new Error(`no person was minted for ${sub}`);
  return row.personArn;
}
const personIdOf = (sub: string, issuerId?: string): string => personArnOf(sub, issuerId).split('/').pop() as string;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function loadHandler() {
  jest.resetModules();
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ACCESS_LOG_TABLE = 'access-log';
  process.env.IDENTITIES_TABLE = IDENTITIES;
  process.env.USER_POOL_ID = POOL;
  delete process.env.TRUSTED_ISSUERS; // the default registry: this pool alone
  identityRows.clear();
  mockDocSend.mockReset().mockImplementation(identitiesDoc);
  process.env.ALLOWED_ORIGIN = 'https://app.example';
  // ONE MAP, KEYED BY CLASSIFICATION. This set four per-classification vars - EXCHANGE_ROLE_BASIC and its
  // siblings - which is deployment config spelled into the stack, the handler and this test, and
  // could not name a classification the deployment added. The stack emits the map instead, built from
  // the registry, so a new classification arrives here without an edit.
  process.env.EXCHANGE_ROLE_ARNS_JSON = JSON.stringify({
    basic: 'arn:aws:iam::111:role/ex-basic',
    standard: 'arn:aws:iam::111:role/ex-standard',
    premium: 'arn:aws:iam::111:role/ex-premium',
    admin: 'arn:aws:iam::111:role/ex-admin',
  });
  process.env.EXCHANGE_ROLE_ADMIN_PLANE = 'arn:aws:iam::111:role/ex-admin-plane';
  process.env.ADMIN_CONSOLE_ROLE_ARN = 'arn:aws:iam::111:role/agent-echelon-admin-console';
  process.env.TEAM_CONSOLE_ROLE_ARN = 'arn:aws:iam::111:role/agent-echelon-team-console';
  process.env.EXCHANGE_EXECUTE_API_TASKS_READ_ARN =
    'arn:aws:execute-api:us-east-1:111:api123/*/GET/admin/tasks/channel/{id}';
  process.env.EXCHANGE_EXECUTE_API_TASKS_MANAGE_ARN =
    'arn:aws:execute-api:us-east-1:111:api123/*/POST/admin/tasks/channel/{id}/cancel';
  process.env.EXCHANGE_EXECUTE_API_TASKS_OWNED_BY_ARN =
    'arn:aws:execute-api:us-east-1:111:api123/*/GET/admin/tasks/owned-by/{id}';
  process.env.EXCHANGE_EXECUTE_API_MESSAGES_ARN =
    'arn:aws:execute-api:us-east-1:111:api123/*/GET/admin/conversations/{id}/messages';
  process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN_PARAM = '/agentechelon/shared/attachments-bucket-arn';
  delete process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN; // force the SSM resolve path in tests
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../lambda/src/credential-exchange');
}

const goodCreds = { Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'sk', SessionToken: 'tok', Expiration: new Date('2030-01-01T00:00:00Z') } };

function event(claims: Record<string, unknown>, body?: unknown) {
  return { httpMethod: 'POST', requestContext: { authorizer: edgeContext({ claims }) }, body: body ? JSON.stringify(body) : undefined };
}

/**
 * The person behind the admin vends below. A console session names the person id the exchange minted
 * (a UUID), never a token subject, so this stands for one.
 */
const ADMIN_SUB = '0a1b2c3d-0000-4000-8000-00000000abcd';

/**
 * A per-conversation admin vend as the console sends it: the capability's own IAM-authorized route,
 * signed with a console session the exchange named `console-<personId>`, with a stated reason.
 */
function adminVend(capability: string, body: Record<string, unknown> = {}, opts: { role?: 'admin' | 'team'; sub?: string } = {}) {
  const role = opts.role === 'team' ? 'agent-echelon-team-console' : 'agent-echelon-admin-console';
  return {
    httpMethod: 'POST',
    path: `/exchange-credentials/admin/${capability}`,
    requestContext: { identity: { userArn: `arn:aws:sts::111:assumed-role/${role}/console-${opts.sub ?? ADMIN_SUB}` } },
    body: JSON.stringify({ reason: 'unit test', ...body }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStsSend.mockResolvedValue(goodCreds);
  mockChimeSend.mockResolvedValue({});
  mockSsmSend.mockResolvedValue({ Parameter: { Value: 'arn:aws:s3:::my-attach-bucket' } });
});

describe('parseGroups', () => {
  it('handles array, bracketed string, and comma/space lists', () => {
    const { parseGroups } = loadHandler();
    expect(parseGroups(['basic', 'premium'])).toEqual(['basic', 'premium']);
    expect(parseGroups('[basic premium]')).toEqual(['basic', 'premium']);
    expect(parseGroups('basic,standard')).toEqual(['basic', 'standard']);
    expect(parseGroups(undefined)).toEqual([]);
  });
});

describe('resolveRoleKey', () => {
  it('resolves the token that means exactly what the caller holds, or nothing', () => {
    const { resolveRoleKey } = loadHandler();
    // The admin plane grants itself alone, so `admins` + `basic` is the `basic` token with the admin plane beside
    // it (`ProfileRegistry.holderOf`), and `admins` alone is `admin`. `basic` + `premium` is `premium`, read from
    // the declared sets (ADR-046).
    expect(resolveRoleKey(['admins', 'basic'])).toBe('basic');
    expect(resolveRoleKey(['admins'])).toBe('admin');
    expect(resolveRoleKey(['basic', 'premium'])).toBe('premium');
    expect(resolveRoleKey(['standard'])).toBe('standard');
    // NOTHING, NOT THE FLOOR. "else basic (fail-safe floor)" was the behavior ADR-046 removed: a
    // caller with no recognized clearance group used to be vended a working least-privileged session,
    // which reads as a permissions puzzle to them and as ordinary traffic to an operator. There is no
    // floor to vend now, and the handler turns this into a 403.
    expect(resolveRoleKey([])).toBeUndefined();
    expect(resolveRoleKey(['nonsense'])).toBeUndefined();
  });
});

describe('handler', () => {
  it('rejects an unauthenticated request (no sub claim)', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({}));
    expect(res.statusCode).toBe(401);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('IDOR: derives sub + tier from CLAIMS, never the body', async () => {
    const { handler } = loadHandler();
    // Body tries to claim premium + a different sub; must be ignored.
    const res = await handler(event({ sub: 'user-A', 'cognito:groups': 'basic' }, { sub: 'user-B', tier: 'premium' }));
    expect(res.statusCode).toBe(200);
    const assumeInput = mockStsSend.mock.calls[0][0].input;
    expect(assumeInput.RoleArn).toBe('arn:aws:iam::111:role/ex-basic'); // basic, not premium
    // BOTH TAGS, and from the claims either way. `sub` is the bearer pin; `classification` is what
    // the role's trust policy matches on, so a vend asserting only `sub` is one the role refuses.
    expect(assumeInput.Tags).toEqual([
      { Key: 'person', Value: personIdOf('user-A') }, // the person minted for the claim sub, not the body's
      { Key: 'classification', Value: 'basic' }, // claim groups, not the body's 'premium'
    ]);
    expect(identityRows.has(`${NATIVE_ID}|user-B`)).toBe(false);
    const out = JSON.parse(res.body);
    expect(out.userArn).toBe(personArnOf('user-A'));
    expect(out.tier).toBe('basic');
  });

  it('assumes the matching per-tier role with the sub session tag', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: 'u1', 'cognito:groups': ['standard'] }));
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/ex-standard');
    expect(input.Tags).toEqual([
      { Key: 'person', Value: personIdOf('u1') },
      { Key: 'classification', Value: 'standard' },
    ]);
  });

  it('records what it decided on the subject row: the classification, the issuer, the rule and when (C3)', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: 'u1', 'cognito:groups': ['standard'] }));
    const recorded = identityRows.get(`${NATIVE_ID}|u1`)?.clearanceDecision as { at: string };
    expect(recorded).toEqual({ classification: 'standard', issuer: NATIVE_ID, source: 'groups', matched: ['standard'], at: expect.any(String) });
    expect(Number.isNaN(Date.parse(recorded.at))).toBe(false);
  });

  it('ensures the AppInstanceUser (idempotent) before vending', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: 'u1', 'cognito:groups': 'premium' }));
    const createInput = mockChimeSend.mock.calls[0][0].input;
    expect(createInput.AppInstanceArn).toBe(APP);
    expect(createInput.AppInstanceUserId).toBe(personIdOf('u1'));
  });

  it('tolerates an already-existing AppInstanceUser (ConflictException)', async () => {
    const { handler } = loadHandler();
    mockChimeSend.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConflictException' }));
    const res = await handler(event({ sub: 'u1', 'cognito:groups': 'premium' }));
    expect(res.statusCode).toBe(200);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('returns the scoped credentials', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: 'u1', 'cognito:groups': 'admins' }));
    const out = JSON.parse(res.body);
    expect(out.credentials.AccessKeyId).toBe('AKIA');
    expect(out.credentials.SessionToken).toBe('tok');
    expect(mockStsSend.mock.calls[0][0].input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin');
  });

  it('the chat plane names the console role only as a display hint, and vends no admin reach with it', async () => {
    const { handler } = loadHandler();
    const admin = JSON.parse((await handler(event({ sub: 'adm', 'cognito:groups': 'admins' }))).body);
    expect(admin.consoleRole).toBe('admins');
    expect(admin.identity).toBe('chat');
    expect(admin.userArn).toBe(personArnOf('adm'));
    expect(admin.userArn).not.toMatch(/-admin$/);
    const member = JSON.parse((await handler(event({ sub: 'user-A', 'cognito:groups': 'basic' }))).body);
    expect(member.consoleRole).toBeNull();
  });

  it('vends an admins + premium person the premium role with the adminPlane session tag, and a premium person without it', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: 'adm', 'cognito:groups': '[admins premium]' }));
    const both = mockStsSend.mock.calls[mockStsSend.mock.calls.length - 1][0].input;
    expect(both.RoleArn).toBe('arn:aws:iam::111:role/ex-premium');
    expect(both.Tags).toEqual(expect.arrayContaining([
      { Key: 'classification', Value: 'premium' },
      { Key: 'adminPlane', Value: 'true' },
    ]));
    await handler(event({ sub: 'user-P', 'cognito:groups': 'premium' }));
    const member = mockStsSend.mock.calls[mockStsSend.mock.calls.length - 1][0].input;
    expect(member.Tags.map((t: { Key: string }) => t.Key)).not.toContain('adminPlane');
  });
});

/**
 * THE DISPLAY NAME IS THE IdP'S, AND THE CACHE FOLLOWS IT.
 *
 * Every client reads a person's name off their AppInstanceUser, so a name changed at the IdP stayed
 * old in every mention menu until something rewrote that record. The exchange rewrites it from the
 * verified token on sign-in - for the caller, from the IdP's claim, and never from the request.
 */
describe('display name - refreshed from the verified token', () => {
  const conflict = () => Object.assign(new Error('exists'), { name: 'ConflictException' });
  const sent = (type: string) => mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c?.__type === type);

  /** An existing identity whose cached name and metadata are as given. */
  function existingIdentity(cached: { Name?: string; Metadata?: string }) {
    mockChimeSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'CreateAppInstanceUser') throw conflict();
      if (cmd?.__type === 'DescribeAppInstanceUser') return { AppInstanceUser: cached };
      return {};
    });
  }

  it('rewrites a stale cached name to the token name, for the authenticated sub', async () => {
    const { handler } = loadHandler();
    existingIdentity({ Name: 'Jane Old', Metadata: '{"k":"v"}' });
    const res = await handler(event({ sub: 'u1', name: 'Jane New', 'cognito:groups': 'premium' }, { sub: 'someone-else' }));
    expect(res.statusCode).toBe(200);
    const updates = sent('UpdateAppInstanceUser');
    expect(updates).toHaveLength(1);
    // The identity is the person minted for the claim's sub, never a request field.
    expect(updates[0].input.AppInstanceUserArn).toBe(personArnOf('u1'));
    expect(updates[0].input.Name).toBe('Jane New');
    // UpdateAppInstanceUser replaces Metadata too, so the current value is carried across.
    expect(updates[0].input.Metadata).toBe('{"k":"v"}');
  });

  it('writes nothing when the cached name already matches', async () => {
    const { handler } = loadHandler();
    existingIdentity({ Name: 'Jane New' });
    await handler(event({ sub: 'u1', name: 'Jane New', 'cognito:groups': 'premium' }));
    expect(sent('DescribeAppInstanceUser')).toHaveLength(1);
    expect(sent('UpdateAppInstanceUser')).toHaveLength(0);
  });

  it('writes nothing without a real name claim, so a fallback never replaces a real name', async () => {
    const { handler } = loadHandler();
    existingIdentity({ Name: 'Jane Set By An Administrator' });
    await handler(event({ sub: 'u1', email: 'jane@example.com', 'cognito:groups': 'premium' }));
    expect(sent('DescribeAppInstanceUser')).toHaveLength(0);
    expect(sent('UpdateAppInstanceUser')).toHaveLength(0);
  });

  it('does not refresh a newly created identity, which was just created with that name', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: 'u1', name: 'Jane New', 'cognito:groups': 'premium' }));
    expect(sent('CreateAppInstanceUser')[0].input.Name).toBe('Jane New');
    expect(sent('UpdateAppInstanceUser')).toHaveLength(0);
  });

  it('still vends credentials when the refresh fails', async () => {
    const { handler } = loadHandler();
    mockChimeSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'CreateAppInstanceUser') throw conflict();
      if (cmd?.__type === 'DescribeAppInstanceUser') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      return {};
    });
    const res = await handler(event({ sub: 'u1', name: 'Jane New', 'cognito:groups': 'premium' }));
    expect(res.statusCode).toBe(200);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('never hands the client the rename action, so a person cannot rename themselves', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: 'u1', name: 'Jane New', 'cognito:groups': 'premium' }));
    const policy = JSON.parse(mockStsSend.mock.calls[0][0].input.Policy);
    const actions = policy.Statement.flatMap((st: { Action: string | string[] }) => [].concat(st.Action as never));
    expect(actions).not.toContain('chime:UpdateAppInstanceUser');
  });
});

// The two-plane admin identity model (docs/SPEC-ADMIN-IDENTITY.md): an admin's
// CHAT identity `${sub}` is never elevated; cross-channel moderation runs on a
// SEPARATE, standing-elevated `${sub}-admin` identity that only ever receives a
// per-channel, short-lived, audited credential (identity:'admin' + channelArn).
// ADMIN REACH IS NOT VENDED HERE: a console session and every admin credential come from the admin
// credential exchange (`admin-credential-exchange.test.ts`), which this exchange refuses to stand in for.
describe('the person exchange vends no admin reach', () => {
  const CHANNEL = `${APP}/channel/room-1`;
  const ROOM = `${APP}/channel/room-m`;

  it('an admin on the CHAT plane pins `${sub}`, never `${sub}-admin`', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: 'adm', 'cognito:groups': 'admins' }));
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    // Chat identity: the caller's own person id, never the elevated admin identity.
    expect(out.userArn).toBe(personArnOf('adm'));
    expect(mockStsSend.mock.calls[0][0].input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin');
  });

  it('identity:admin from a NON-admin is refused (403)', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: 'u1', 'cognito:groups': 'premium' }, { identity: 'admin', channelArn: CHANNEL }));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('rejects view-messages on the CHAT plane (403/400 — admin-plane only)', async () => {
    const { handler } = loadHandler();
    // identity defaults to chat; an admin caller but no plane:admin.
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { channelArn: CHANNEL, capabilities: ['view-messages'] },
    ));
    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('a non-admin cannot vend an archive cred (admin plane requires admins)', async () => {
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'u1', 'cognito:groups': 'premium' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['view-messages'] },
    ));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('rejects an attachment vend on the CHAT plane (admin-plane only)', async () => {
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { channelArn: CHANNEL, capabilities: ['attachment-read'] }, // no identity:admin
    ));
    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('a non-admin cannot vend an attachment cred (admin plane requires admins)', async () => {
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'u1', 'cognito:groups': 'premium' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['attachment-read'] },
    ));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('is refused on the CHAT plane, because no chat role holds the membership actions', async () => {
    // A boundary, not a preference: EXCHANGE_MODERATION_ACTIONS is granted to the admin role only and
    // a session policy narrows rather than widens, so a chat-plane vend would return a credential
    // IAM refuses at use - a 200 that does not work.
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'u1', 'cognito:groups': 'premium' },
      { channelArn: ROOM, capabilities: ['manage-membership'] },
    ));
    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('no longer vends an admin credential on the Cognito route, even to an admin', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': 'admins' }, { identity: 'admin', channelArn: CHANNEL, capabilities: ['redact'] }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ADMIN_VEND_MOVED');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a console session, which the admin credential exchange issues', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ADMIN_VEND_MOVED');
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};

/**
 * THE PERSON IS MINTED, NOT THE TOKEN'S SUB (README.md:3).
 *
 * The exchange resolves `(iss, sub)` to an opaque UUID v7 AppInstanceUser through the Identities
 * table, minting it on the first sign-in. A Cognito `sub` is a UUID v4, so a regression to keying on
 * it fails the version check below.
 */
describe('the person behind a token', () => {
  const SUB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'; // a Cognito sub: UUID v4

  it('mints a UUID v7 on the first exchange, never the token sub', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'premium' }));
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    const id = out.userArn.split('/').pop();
    expect(id).toMatch(V7);
    expect(id).not.toBe(SUB);
    expect(out.userArn).toBe(personArnOf(SUB));
    // The bearer pin and the session name carry the same person.
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.Tags).toEqual(expect.arrayContaining([{ Key: 'person', Value: id }]));
    expect(input.RoleSessionName).toBe(`chime-${id}`);
  });

  it('resolves the same ARN on a second exchange, and creates nothing new', async () => {
    const { handler } = loadHandler();
    const first = JSON.parse((await handler(event({ sub: SUB, 'cognito:groups': 'premium' }))).body).userArn;
    mockChimeSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'CreateAppInstanceUser') throw Object.assign(new Error('exists'), { name: 'ConflictException' });
      return {};
    });
    const second = JSON.parse((await handler(event({ sub: SUB, 'cognito:groups': 'premium' }))).body).userArn;
    expect(second).toBe(first);
    expect(identityRows.size).toBe(1);
  });

  it('never gives another subject that person, nor the same subject under another issuer', async () => {
    const { handler } = loadHandler();
    // A second pool the registry declares, with the deployment's own beside it.
    process.env.TRUSTED_ISSUERS = JSON.stringify([
      { id: NATIVE_ID, kind: 'cognito-pool', pool: POOL, iss: NATIVE_ISS, subject: ['sub'], clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true, groupsClaim: 'cognito:groups' },
      { id: 'other', kind: 'cognito-pool', pool: OTHER_POOL, iss: OTHER_ISS, subject: ['sub'], clearance: { groups: true, classifications: ['basic', 'standard', 'premium'] }, admin: false, groupsClaim: 'cognito:groups' },
    ]);
    const a = JSON.parse((await handler(event({ sub: SUB, 'cognito:groups': 'premium' }))).body).userArn;
    const b = JSON.parse((await handler(event({ sub: 'someone-else', 'cognito:groups': 'premium' }))).body).userArn;
    const c = JSON.parse((await handler(event({ sub: SUB, iss: OTHER_ISS, 'cognito:groups': 'premium' }))).body).userArn;
    expect(new Set([a, b, c]).size).toBe(3);
    expect(c).toBe(personArnOf(SUB, 'other'));
    delete process.env.TRUSTED_ISSUERS;
  });

  it('refuses a token from an issuer the registry does not declare, and mints nothing', async () => {
    // The edge refuses such a token itself (401). An answer it cached for an issuer since removed reaches
    // the exchange naming an issuer this function no longer trusts, and is refused here too.
    const { handler } = loadHandler();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await handler({
      ...event({}),
      requestContext: { authorizer: edgeContext({ claims: { sub: SUB, iss: 'https://issuer.example', 'cognito:groups': 'premium' }, issuerId: 'removed-issuer' }) },
    });
    warn.mockRestore();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ISSUER_NOT_TRUSTED');
    expect(identityRows.size).toBe(0);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('keys the row on the registry id of the issuer the token names, never the raw iss', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: SUB, iss: NATIVE_ISS, 'cognito:groups': 'premium' }));
    expect([...identityRows.keys()]).toEqual([`${NATIVE_ID}|${SUB}`]);
  });

  it('writes no address into the AppInstanceUser name', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: SUB, 'cognito:username': 'jane@example.com', 'cognito:groups': 'premium' }));
    const create = mockChimeSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'CreateAppInstanceUser');
    expect(create.input.Name).toBe('jane');
  });

  it('records the new row on the access log', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: SUB, 'cognito:groups': 'premium' }));
    const minted = mockDocSend.mock.calls.map((c) => c[0])
      .filter((c) => c.__type === 'Put' && c.input.TableName === 'access-log' && c.input.Item?.event === 'identity_minted');
    expect(minted).toHaveLength(1);
    expect(JSON.parse(minted[0].input.Item.detail)).toMatchObject({ issuer: NATIVE_ID, personArn: personArnOf(SUB) });
  });

  it('refuses a sign-in whose row is not active, and vends nothing', async () => {
    const { handler } = loadHandler();
    identityRows.set(`${NATIVE_ID}|${SUB}`, { personArn: `${APP}/user/0190a000-0000-7000-8000-000000000001`, status: 'pending' });
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'premium' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_ACTIVE');
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  // THE ISSUER IS ASKED AT EVERY VEND (SPEC-CREDENTIAL-EXCHANGE §4b): the Identities row keeps no copy of it.
  const accountStateMock = (): jest.Mock =>
    (jest.requireMock('../lambda/src/lib/membership-source') as { __accountStateForTests: { accountState: jest.Mock } }).__accountStateForTests.accountState;

  it.each(['disabled', 'gone'] as const)('refuses an account its issuer reports %s, before anything is minted, recorded or assumed', async (state) => {
    const { handler } = loadHandler();
    accountStateMock().mockResolvedValue(state);
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'premium' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_ACTIVE');
    expect(accountStateMock()).toHaveBeenCalledWith(NATIVE_ID, SUB);
    expect(identityRows.size).toBe(0);
    expect(mockDocSend).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('asks again at a refresh: an active person whose account is then disabled is refused, and their row is left as it is', async () => {
    const { handler } = loadHandler();
    expect((await handler(event({ sub: SUB, 'cognito:groups': 'premium' }))).statusCode).toBe(200);
    const row = { ...identityRows.get(`${NATIVE_ID}|${SUB}`) };
    mockStsSend.mockClear();
    accountStateMock().mockResolvedValue('disabled');
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'premium' }));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(identityRows.get(`${NATIVE_ID}|${SUB}`)).toEqual(row);
    // Re-enabled at the pool: the next vend goes through with no step on the platform's side.
    accountStateMock().mockResolvedValue('active');
    expect((await handler(event({ sub: SUB, 'cognito:groups': 'premium' }))).statusCode).toBe(200);
  });

  it('refuses 503 and vends nothing when the issuer cannot be asked (fail closed)', async () => {
    const { handler } = loadHandler();
    accountStateMock().mockRejectedValue(Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }));
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'premium' }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('DIRECTORY_UNAVAILABLE');
    expect(identityRows.size).toBe(0);
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockChimeSend).not.toHaveBeenCalled();
  });


  it('fails closed with no credential when the Identities table cannot be read', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { handler } = loadHandler();
      mockDocSend.mockRejectedValue(Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
      const res = await handler(event({ sub: SUB, 'cognito:groups': 'premium' }));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).credentials).toBeUndefined();
      expect(mockStsSend).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
