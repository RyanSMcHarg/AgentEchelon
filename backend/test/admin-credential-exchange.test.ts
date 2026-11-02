import { edgeContext } from './helpers/edge-context';
/**
 * Unit tests for the admin credential exchange (lambda/src/admin-credential-exchange.ts), which exists
 * with the `admin` capability and issues every credential the admin console holds.
 *
 * Pins the security contract: the console session reads the person and never mints one, a
 * per-conversation credential is vended on the capability's own route with a reason and recorded before
 * it is returned, and every AssumeRole carries BOTH session tags.
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
/**
 * THE PERSON EXCHANGE HAS ALREADY MINTED THE CALLER. A console session reads the person a subject signs
 * in as and never mints one, so a subject read here is given a row as the person exchange would have,
 * unless a test turns that off to see the refusal.
 */
let signedInFirst = true;
let seeded = 0;
async function identitiesDoc(cmd: { __type?: string; input?: any }): Promise<unknown> {
  if (cmd?.input?.TableName !== IDENTITIES) return {};
  const key = cmd.__type === 'Get' ? cmd.input.Key.issuerSubject : cmd.input.Item?.issuerSubject;
  if (cmd.__type === 'Get' && signedInFirst && !identityRows.has(key) && !String(key).startsWith('revoked#')) {
    seeded += 1;
    identityRows.set(key, { issuerSubject: key, personArn: `${APP}/user/0190a000-0000-7000-8000-${String(seeded).padStart(12, '0')}`, status: 'active' });
  }
  if (cmd.__type === 'Get') return { Item: identityRows.get(key) };
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

function loadHandler(signedIn = true) {
  jest.resetModules();
  signedInFirst = signedIn;
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
  return require('../lambda/src/admin-credential-exchange');
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

describe('admin identity — two-plane model', () => {
  const CHANNEL = `${APP}/channel/room-1`;

  it('identity:admin without a channelArn scope is refused (400)', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('view-live-members'));
    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('creates the admin-plane twin itself and tags it with its owner, the person it belongs to', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('view-live-members', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    const sent = mockChimeSend.mock.calls.map((c) => c[0] as { __type: string; input: Record<string, unknown> });
    expect(sent.find((c) => c.__type === 'CreateAppInstanceUser')?.input.AppInstanceUserId).toBe(`${ADMIN_SUB}-admin`);
    const tag = sent.find((c) => c.__type === 'TagResource' && c.input.ResourceARN === `${APP}/user/${ADMIN_SUB}-admin`);
    expect(tag?.input.Tags).toEqual(expect.arrayContaining([{ Key: 'owner', Value: `${APP}/user/${ADMIN_SUB}` }]));
  });

  it('identity:admin + channelArn vends the ADMIN-PLANE role pinned to `${sub}-admin`, channel-scoped', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('view-live-members', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    // The elevated, SEPARATE admin identity — not the chat sub.
    expect(out.userArn).toBe(`${APP}/user/${ADMIN_SUB}-admin`);
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin-plane');
    // Session tag is still the human's person id (the role appends -admin in-policy).
    expect(input.Tags).toEqual([
      { Key: 'person', Value: ADMIN_SUB },
      // THE ADMIN PLANE'S OWN CLASSIFICATION, not the caller's. This identity is standing-elevated
      // and channel-scoped per vend, so it asserts the top of the axis and the trust policy binds it
      // there - a session tagged with the operator's ordinary reach could not assume this role.
      { Key: 'classification', Value: 'admin' },
    ]);
    // The session policy narrows to exactly the requested channel.
    const policy = JSON.parse(input.Policy);
    const requested = policy.Statement.find((s: { Sid: string }) => s.Sid === 'RequestedActions');
    expect(requested.Resource).toContain(CHANNEL);
  });
});

// A14 archive plane (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md section 6.5): reading
// customer message content (A2) is vended as a short-lived, audited `execute-api`
// session policy on the admin-plane role — NOT a Chime session policy — so a
// standing sign-on role never holds a customer-PII read.
describe('A14 archive vend — view-messages (execute-api plane)', () => {
  const CHANNEL = `${APP}/channel/room-1`;
  // The COMPLETED ARN. Until 2026-08-31 this route took ?channelArn= and the ARN could name only
  // the route, so a cred vended for one conversation could read every conversation while the audit
  // recorded the first. The id is a path segment now, and this asserts the substitution happened -
  // an env template without {id} would make this test pass while scoping nothing.
  const MESSAGES_ARN = 'arn:aws:execute-api:us-east-1:111:api123/*/GET/admin/conversations/room-1/messages';

  it('vends an execute-api:Invoke session policy on the admin-plane role', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('view-messages', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    const input = mockStsSend.mock.calls[0][0].input;
    // Assumed on the admin-plane role with the human's sub tag.
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin-plane');
    expect(input.Tags).toEqual([
      { Key: 'person', Value: ADMIN_SUB },
      // THE ADMIN PLANE'S OWN CLASSIFICATION, not the caller's. This identity is standing-elevated
      // and channel-scoped per vend, so it asserts the top of the axis and the trust policy binds it
      // there - a session tagged with the operator's ordinary reach could not assume this role.
      { Key: 'classification', Value: 'admin' },
    ]);
    // Session policy is execute-api on exactly the messages resource — no chime:* actions.
    const policy = JSON.parse(input.Policy);
    const stmt = policy.Statement.find((s: { Sid: string }) => s.Sid === 'ArchiveApiInvoke');
    expect(stmt.Action).toEqual(['execute-api:Invoke']);
    expect(stmt.Resource).toEqual([MESSAGES_ARN]);
    expect(JSON.stringify(policy)).not.toContain('chime:');
    // No Chime identity provisioned for an execute-api vend.
    expect(mockChimeSend).not.toHaveBeenCalled();
    const out = JSON.parse(res.body);
    expect(out.userArn).toBe(`${APP}/user/${ADMIN_SUB}-admin`);
    expect(out.identity).toBe('admin');
  });


  it('vends what the ROUTE names, whatever capabilities the body lists', async () => {
    // One route, one capability: a session admitted to the message-read route is vended the message
    // read and nothing else, so a body that also lists a Chime capability cannot widen it.
    const { handler } = loadHandler();
    const res = await handler(adminVend('view-messages', { channelArn: CHANNEL, capabilities: ['view-messages', 'view', 'delete'] }));
    expect(res.statusCode).toBe(200);
    const policy = JSON.stringify(JSON.parse(mockStsSend.mock.calls[0][0].input.Policy));
    expect(policy).toContain('execute-api:Invoke');
    expect(policy).not.toContain('chime:');
  });

});

// S3 attachment vend (admin conversation attachment review): a short-lived, audited
// `s3:GetObject` session policy on the admin-plane role, scoped to EXACTLY the named
// channel's key prefix. The generated-doc vs user-upload split is two capabilities, so a
// future restricted role can be denied the user-upload prefix at the IAM layer.
describe('S3 attachment vend — attachment-read (execute nothing but s3:GetObject)', () => {
  const CHANNEL = `${APP}/channel/room-1`;
  const BUCKET = 'arn:aws:s3:::my-attach-bucket';

  it('attachment-read vends s3:GetObject scoped to generated-docs/<channelId>/*, admin-plane, no Chime', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('attachment-read', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin-plane');
    expect(input.Tags).toEqual([
      { Key: 'person', Value: ADMIN_SUB },
      // THE ADMIN PLANE'S OWN CLASSIFICATION, not the caller's. This identity is standing-elevated
      // and channel-scoped per vend, so it asserts the top of the axis and the trust policy binds it
      // there - a session tagged with the operator's ordinary reach could not assume this role.
      { Key: 'classification', Value: 'admin' },
    ]);
    const policy = JSON.parse(input.Policy);
    const stmt = policy.Statement.find((s: { Sid: string }) => s.Sid === 'AttachmentGet');
    expect(stmt.Action).toEqual(['s3:GetObject']);
    // Confined to THIS channel's DELIVERABLES prefix — not the whole bucket, not user uploads.
    expect(stmt.Resource).toEqual([`${BUCKET}/generated-docs/room-1/*`]);
    expect(JSON.stringify(policy)).not.toContain('/attachments/');
    // An S3 vend provisions no Chime identity.
    expect(mockChimeSend).not.toHaveBeenCalled();
    const out = JSON.parse(res.body);
    expect(out.userArn).toBe(`${APP}/user/${ADMIN_SUB}-admin`);
    expect(out.identity).toBe('admin');
    expect(out.bucket).toBe('my-attach-bucket'); // name (not ARN) for the client to address GetObject
    expect(out.region).toBe('us-east-1');
  });

  it('attachment-read-uploads scopes to the USER-UPLOAD prefix (attachments/<channelId>/*)', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('attachment-read-uploads', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    const policy = JSON.parse(mockStsSend.mock.calls[0][0].input.Policy);
    const stmt = policy.Statement.find((s: { Sid: string }) => s.Sid === 'AttachmentGet');
    expect(stmt.Resource).toEqual([`${BUCKET}/attachments/room-1/*`]);
    expect(JSON.stringify(policy)).not.toContain('/generated-docs/');
  });


  it('500s (never leaks) when the attachments bucket ARN is unresolved', async () => {
    const { handler } = loadHandler();
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: '' } }); // param present but empty
    const res = await handler(adminVend('attachment-read', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(500);
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});


/**
 * THE SCOPE THE VEND CLAIMS IS THE SCOPE THE POLICY ENFORCES.
 *
 * The task routes took the conversation as `?channelArn=`, and an execute-api ARN carries no query
 * string - so a vend that REQUIRED and audited a channel handed back a credential that could read
 * every channel. The scope was declared and recorded, never enforced. The identifier is a path
 * segment now, and these assert that the session policy is completed with the ONE id rather than
 * left as the route.
 */
describe('a task vend is narrowed to the subject it names', () => {
  const CHANNEL = `${APP}/channel/room-1`;

  it('pins the channel id into the resource, not the bare route', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('tasks-read', { channelArn: CHANNEL }));

    expect(res.statusCode).toBe(200);
    const policy = JSON.parse(mockStsSend.mock.calls[0][0].input.Policy);
    const stmt = policy.Statement.find((st: { Sid: string }) => st.Sid === 'ArchiveApiInvoke');
    expect(stmt.Resource).toEqual([
      'arn:aws:execute-api:us-east-1:111:api123/*/GET/admin/tasks/channel/room-1',
    ]);
    // The template must not survive into a policy, and the route must not stand alone: either would
    // be the unscoped credential this change exists to end.
    expect(JSON.stringify(policy)).not.toContain('{id}');
    expect(stmt.Resource[0]).not.toMatch(/\/admin\/tasks\/channel\/?$/);
  });

  it('pins the owner id for the cross-channel read, and takes no channel', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('tasks-read-owned-by', { principalId: 'owner-7' }));

    expect(res.statusCode).toBe(200);
    const policy = JSON.parse(mockStsSend.mock.calls[0][0].input.Policy);
    const stmt = policy.Statement.find((st: { Sid: string }) => st.Sid === 'ArchiveApiInvoke');
    expect(stmt.Resource).toEqual([
      'arn:aws:execute-api:us-east-1:111:api123/*/GET/admin/tasks/owned-by/owner-7',
    ]);
  });

  it('refuses an owner read with no owner to narrow it to', async () => {
    // The failure this must never have: a capability whose template cannot be completed vending
    // something broader instead.
    const { handler } = loadHandler();
    const res = await handler(adminVend('tasks-read-owned-by', { channelArn: CHANNEL }));

    expect(res.statusCode).toBe(400);
  });

  // ── A WILDCARD IS THE SAME FAILURE, SPELLED DIFFERENTLY ──────────────────────────────────────
  //
  // The prefix check on `channelArn` is a `startsWith`, so `${APP}/channel/*` clears it, and
  // `encodeURIComponent` leaves `*` alone (it is one of its unreserved characters). Completed, the
  // template would read `.../GET/admin/conversations/*/messages` - the role's own boundary, so the
  // narrowing these tests describe would collapse to nothing while the audit line still recorded a
  // scope. `principalId` had no validation at all and is the same hole.
  it('refuses a wildcard channel scope rather than completing the template with it', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('view-messages', { channelArn: `${APP}/channel/*` }));

    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a wildcard principal scope', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('tasks-read-owned-by', { principalId: '*' }));

    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});

/**
 * THE TARGET OF A MEMBERSHIP CALL CANNOT BE GATED IN IAM, AND THAT WAS MEASURED RATHER THAN ARGUED.
 *
 * A Deny on every bot ARN for `DeleteChannelMembership` and `CreateChannelModerator` was written
 * here, unit-tested here, shipped, and deployed. Four tests in this file asserted it and passed.
 * `backend/scripts/deny-test-assistant-membership.mjs` then ran it against the live service and it
 * did not hold: a vended `manage-membership` credential removed the assistant from a channel and
 * promoted it to moderator, while the SAME credential was correctly refused an action outside its
 * requested capabilities. The session policy is enforced; Amazon Chime SDK simply does not evaluate
 * the targeted member as an IAM resource for these actions.
 *
 * SO THE FOUR TESTS ARE GONE RATHER THAN RELAXED. They asserted the policy was WRITTEN, which was
 * true and worthless: a unit test over a policy document cannot tell you whether the service reads
 * it that way, and their green was the thing that made the control look finished. What replaces them
 * is the narrower claim this file can actually support - that a capability the caller did not ask
 * for is not in the policy - plus a pointer to the live test, which is the only place the real claim
 * can live.
 *
 * The protection itself now has to be enforced where the target is visible: the handler route in
 * `conversation-management.ts`, which already refuses a bot.
 */
describe('the vended policy grants only what was asked for', () => {
  const ROOM = `${APP}/channel/room-m`;
  const policyOf = () => JSON.parse(mockStsSend.mock.calls[0][0].input.Policy);

  it('carries no Deny, because a Deny on the target was measured not to work', async () => {
    // Not a preference. See the live deny-test named above; an inert Deny in a security-critical
    // policy is worse than none, because the next reader relies on it.
    const { handler } = loadHandler();
    await handler(adminVend('manage-membership', { channelArn: ROOM }));
    expect(policyOf().Statement.find((s: { Effect: string }) => s.Effect === 'Deny')).toBeUndefined();
  });

  it('scopes the allow to the requested channel and the caller, and nothing wider', async () => {
    const { handler } = loadHandler();
    await handler(adminVend('manage-membership', { channelArn: ROOM }));
    const st = policyOf().Statement.find((s: { Sid: string }) => s.Sid === 'RequestedActions');
    expect([].concat(st.Resource as never)).toEqual([ROOM, `${APP}/user/${ADMIN_SUB}-admin`]);
  });

});

/**
 * THE CONSOLE PLANE AND THE MOVED ADMIN VEND (SPEC-ADMIN-CONSOLE "Temporary, scoped credentials", FR45, FR51).
 *
 * The console asks for a short-lived session on the console role its groups name, and every admin
 * credential is then requested on that capability's own IAM-authorized route with a stated reason. The
 * Cognito route no longer vends on the admin plane at all, because its decision was a group lookup.
 */
describe('admin console sessions and per-capability vends', () => {
  const CHANNEL = `${APP}/channel/room-1`;

  it('issues an admin a console session on the admin console role, named for the person', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': 'admins', email: 'ops@example.com' }, { identity: 'console' }));
    expect(res.statusCode).toBe(200);
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/agent-echelon-admin-console');
    // Named for the PERSON the exchange minted, never the token subject.
    expect(input.RoleSessionName).toBe(`console-${personIdOf(ADMIN_SUB)}`);
    expect(personIdOf(ADMIN_SUB)).not.toBe(ADMIN_SUB);
    expect(input.Tags).toEqual(expect.arrayContaining([{ Key: 'person', Value: personIdOf(ADMIN_SUB) }]));
    expect(input.DurationSeconds).toBeLessThanOrEqual(3600);
    const out = JSON.parse(res.body);
    expect(out.role).toBe('admins');
    expect(out.capabilities).toContain('redact');
    expect(out.capabilities).toContain('view-analytics');
  });

  it('names which granted capabilities are vended on request, from the catalog, and how long one vend lasts', async () => {
    const { ADMIN_CAPABILITIES } = jest.requireActual('../lib/config/admin-capabilities') as typeof import('../lib/config/admin-capabilities');
    const { handler } = loadHandler();
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    // Exactly the granted capabilities the catalog marks `exchangeVend`: never held by the session itself.
    const vended = out.capabilities.filter((k: string) => ADMIN_CAPABILITIES[k]?.enforcement === 'exchangeVend');
    expect(out.onRequest.capabilities).toEqual(vended);
    expect(out.onRequest.capabilities).toEqual(expect.arrayContaining(['delete-conversation', 'delete', 'redact', 'manage-membership']));
    expect(out.onRequest.capabilities).not.toContain('view-analytics');
    expect(out.onRequest.ttlSeconds).toBe(1800);
  });

  /** The app instance's assistants as the bots and their tags record them. */
  const assistantsAre = (bots: Array<{ assistant: string; classification: string; owner?: string }>) => {
    mockChimeSend.mockImplementation(async (cmd: { __type?: string; input?: { ResourceARN?: string } }) => {
      if (cmd.__type === 'ListAppInstanceBots') {
        return { AppInstanceBots: bots.map((b) => ({ AppInstanceBotArn: `${APP}/bot/${b.assistant}`, Name: b.assistant })) };
      }
      if (cmd.__type === 'ListTagsForResource') {
        const b = bots.find((x) => cmd.input?.ResourceARN === `${APP}/bot/${x.assistant}`);
        return { Tags: b ? [
          { Key: 'assistant', Value: b.assistant },
          { Key: 'classification', Value: b.classification },
          ...(b.owner ? [{ Key: 'owner-team', Value: b.owner }] : []),
        ] : [] };
      }
      return {};
    });
  };
  const TEAM_OPS = ['premium', 'team-members', 'team-ops'];

  it('issues a team member a session on the team console role, scoped to the assistants their team owns', async () => {
    assistantsAre([
      { assistant: 'ops-premium', classification: 'premium', owner: 'ops' },
      { assistant: 'advisor', classification: 'premium' },
      { assistant: 'analyst', classification: 'standard', owner: 'support' },
    ]);
    const { handler } = loadHandler();
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': TEAM_OPS }, { identity: 'console' }));
    expect(res.statusCode).toBe(200);
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/agent-echelon-team-console');
    // The session can reach the owned assistant's routes and its own team's, and nothing else.
    expect(JSON.parse(input.Policy).Statement[0].Resource).toEqual([
      'arn:aws:execute-api:*:*:*/assistants/ops-premium/*',
      'arn:aws:execute-api:*:*:*/teams/ops/*',
    ]);
    // The person's clearance rides the session name, which is what bounds the session by classification.
    expect(input.RoleSessionName).toBe(`console-${personIdOf(ADMIN_SUB)}@premium`);
    // Shorter than an admin's hour: its reach is a snapshot of ownership and clearance at issue.
    expect(input.DurationSeconds).toBe(900);
    const out = JSON.parse(res.body);
    expect(out.role).toBe('team-members');
    expect(out.assistants).toEqual(['ops-premium']);
    expect(out.teams).toEqual(['ops']);
    expect(out.owners).toEqual({ 'ops-premium': 'ops' });
    expect(out.capabilities).toContain('view-analytics');
    expect(out.capabilities).not.toContain('redact');
    // Held on the team's own routes only: assigning an owned assistant to its own teams, creating for them.
    expect(out.capabilities).toEqual(expect.arrayContaining(['manage-ownership', 'manage-assistants']));
  });

  it('gives a team that owns nothing it is cleared for a session naming its team alone', async () => {
    assistantsAre([{ assistant: 'ops-premium', classification: 'premium', owner: 'ops' }]);
    const { handler } = loadHandler();
    // In the ops team, but cleared only for basic: owning a premium assistant does not raise that.
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': ['basic', 'team-members', 'team-ops'] }, { identity: 'console' }));
    expect(res.statusCode).toBe(200);
    // No assistant route: only the team's own, where it may create the assistant it will own.
    expect(JSON.parse(mockStsSend.mock.calls[0][0].input.Policy).Statement[0].Resource).toEqual(['arn:aws:execute-api:*:*:*/teams/ops/*']);
    const out = JSON.parse(res.body);
    expect(out.assistants).toEqual([]);
    expect(out.teams).toEqual(['ops']);
  });

  it('refuses a team member in no team, and issues nothing', async () => {
    assistantsAre([{ assistant: 'ops-premium', classification: 'premium', owner: 'ops' }]);
    const { handler } = loadHandler();
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': ['premium', 'team-members'] }, { identity: 'console' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('NO_TEAM');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('gives an admin an unscoped session: no session policy narrows it', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: ADMIN_SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(mockStsSend.mock.calls[0][0].input.Policy).toBeUndefined();
    expect(mockStsSend.mock.calls[0][0].input.DurationSeconds).toBe(3600);
  });

  it('tells a sign-in with no admin capability so, and issues nothing', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': 'premium' }, { identity: 'console' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('NO_ADMIN_CAPABILITY');
    expect(mockStsSend).not.toHaveBeenCalled();
  });


  it('requires a reason, and records it on the audit line', async () => {
    const { handler } = loadHandler();
    const noReason = adminVend('redact', { channelArn: CHANNEL });
    noReason.body = JSON.stringify({ channelArn: CHANNEL });
    const refused = await handler(noReason);
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body).code).toBe('REASON_REQUIRED');
    expect(mockStsSend).not.toHaveBeenCalled();

    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await handler(adminVend('redact', { channelArn: CHANNEL, reason: 'removing a leaked password' }));
    expect(ok.statusCode).toBe(200);
    const audit = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('admin_scoped_credential_vend'));
    expect(JSON.parse(audit!).reason).toBe('removing a leaked password');
    log.mockRestore();
  });

  // ── THE ACCESS LOG (ADR-052, SPEC-ADMIN-CONSOLE FR30) ──────────────────────────────────────────
  /** The access records of operator access; the minter's own `identity_minted` record is tested beside it. */
  const accessRecords = () => mockDocSend.mock.calls.map((c) => c[0])
    .filter((c) => c.__type === 'Put' && c.input.TableName === 'access-log' && c.input.Item?.event !== 'identity_minted')
    .map((c) => c.input);

  it('writes a durable access record, with the reason, before returning a per-conversation credential', async () => {
    const { handler } = loadHandler();
    const ok = await handler(adminVend('redact', { channelArn: CHANNEL, reason: 'removing a leaked password' }));
    expect(ok.statusCode).toBe(200);
    const [put] = accessRecords();
    expect(put.TableName).toBe('access-log');
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(put.Item).toMatchObject({
      event: 'admin_scoped_credential_vend', actorPersonId: ADMIN_SUB, conversation: CHANNEL, reason: 'removing a leaked password',
    });
    expect(put.Item.capabilities).toContain('redact');
  });

  it('records the console session too, under the person and no conversation', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(res.statusCode).toBe(200);
    const [put] = accessRecords();
    expect(put.Item).toMatchObject({ event: 'admin_console_session_vend', actorPersonId: personIdOf(ADMIN_SUB) });
    expect(put.Item.conversation).toBeUndefined();
  });

  it('withholds the credential when the record cannot be written, for a conversation vend and for the console session', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { handler } = loadHandler();
      // The ACCESS LOG is down; the Identities table is not, so the person still resolves.
      mockDocSend.mockImplementation(async (cmd: { input?: { TableName?: string } }) => {
        if (cmd?.input?.TableName === 'access-log') throw Object.assign(new Error('down'), { name: 'ServiceUnavailable' });
        return identitiesDoc(cmd);
      });
      for (const req of [
        adminVend('redact', { channelArn: CHANNEL, reason: 'removing a leaked password' }),
        event({ sub: ADMIN_SUB, 'cognito:groups': 'admins' }, { identity: 'console' }),
      ]) {
        const res = await handler(req);
        expect(res.statusCode).toBe(503);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('ACCESS_LOG_UNAVAILABLE');
        expect(body.credentials).toBeUndefined();
      }
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[SecurityEvent]'), expect.anything());
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('withholds the credential on a deployment with no access log at all', async () => {
    const { handler } = loadHandler();
    delete process.env.ACCESS_LOG_TABLE;
    const res = await handler(event({ sub: ADMIN_SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).credentials).toBeUndefined();
  });

  it.each(['redact', 'delete', 'manage-membership', 'view-live-members', 'delete-conversation', 'view-messages', 'attachment-read'])(
    'refuses a %s credential for anything but one literal conversation',
    async (capability) => {
      const { handler } = loadHandler();
      for (const channelArn of [`${APP}/channel/*`, `${APP}/channel/a*`, `${APP}/channel/a/b`, `${APP}/channel/?`]) {
        const res = await handler(adminVend(capability, { channelArn }));
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe('CHANNEL_NOT_LITERAL');
      }
      expect(mockStsSend).not.toHaveBeenCalled();
    },
  );

  it('refuses a vend from anything but a console session the exchange named', async () => {
    const { handler } = loadHandler();
    const forged = adminVend('redact', { channelArn: CHANNEL });
    forged.requestContext.identity.userArn = 'arn:aws:sts::111:assumed-role/some-other-role/console-' + ADMIN_SUB;
    expect((await handler(forged)).statusCode).toBe(403);
    const unnamed = adminVend('redact', { channelArn: CHANNEL });
    unnamed.requestContext.identity.userArn = 'arn:aws:sts::111:assumed-role/agent-echelon-admin-console/' + ADMIN_SUB;
    expect((await handler(unnamed)).statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a team session a capability its role does not hold, as a second layer behind IAM', async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('redact', { channelArn: CHANNEL }, { role: 'team' }));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a capability the catalog does not declare', async () => {
    const { handler } = loadHandler();
    expect((await handler(adminVend('make-me-root', { channelArn: CHANNEL }))).statusCode).toBe(404);
  });
});

describe('the person behind a console session', () => {
  const SUB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';

  it('creates the admin twin from the person the subject signs in as, and creates no person', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    const ids = mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'CreateAppInstanceUser').map((c) => c.input.AppInstanceUserId);
    expect(ids).toEqual([`${personIdOf(SUB)}-admin`]);
  });

  it('mints nobody: a subject with no person yet is told to sign in first, and nothing is created', async () => {
    const { handler } = loadHandler(false);
    const res = await handler(event({ sub: 'never-signed-in', 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_SIGNED_IN');
    expect(identityRows.size).toBe(0);
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'CreateAppInstanceUser')).toEqual([]);
  });

  it('refuses a subject whose row is not active', async () => {
    const { handler } = loadHandler(false);
    identityRows.set(`${NATIVE_ID}|${SUB}`, { personArn: `${APP}/user/0190a000-0000-7000-8000-000000000001`, issuer: 'another-issuer', status: 'pending' });
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_ACTIVE');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  // THE ISSUER IS ASKED AT EVERY CONSOLE SESSION, as the person exchange asks at every vend (SPEC-CREDENTIAL-EXCHANGE §4b).
  const accountStateMock = (): jest.Mock =>
    (jest.requireMock('../lambda/src/lib/membership-source') as { __accountStateForTests: { accountState: jest.Mock } }).__accountStateForTests.accountState;

  it.each(['disabled', 'gone'] as const)('refuses an admin whose account their issuer reports %s, and assumes nothing', async (state) => {
    const { handler } = loadHandler(false);
    identityRows.set(`${NATIVE_ID}|${SUB}`, { personArn: `${APP}/user/0190a000-0000-7000-8000-000000000001`, issuer: NATIVE_ID, status: 'active' });
    accountStateMock().mockResolvedValue(state);
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_ACTIVE');
    expect(accountStateMock()).toHaveBeenCalledWith(NATIVE_ID, SUB);
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'CreateAppInstanceUser')).toEqual([]);
  });

  it('refuses 503 and assumes nothing when the issuer cannot be asked (fail closed)', async () => {
    const { handler } = loadHandler(false);
    identityRows.set(`${NATIVE_ID}|${SUB}`, { personArn: `${APP}/user/0190a000-0000-7000-8000-000000000001`, issuer: NATIVE_ID, status: 'active' });
    accountStateMock().mockRejectedValue(Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }));
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'admins' }, { identity: 'console' }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('DIRECTORY_UNAVAILABLE');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('issues only console sessions on the token route', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: SUB, 'cognito:groups': 'admins' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('CONSOLE_SESSION_ONLY');
  });
});

describe('every admin vend asks the issuer, not the console session', () => {
  // A CONSOLE SESSION OUTLIVES ITS ISSUE (SPEC-CREDENTIAL-EXCHANGE §4b): a per-capability or a team
  // attachment vend asks the person's issuers again, through their subjects at the `admin: true` issuers.
  const CHANNEL = `${APP}/channel/room-1`;
  const accountStateMock = (): jest.Mock =>
    (jest.requireMock('../lambda/src/lib/membership-source') as { __accountStateForTests: { accountState: jest.Mock } }).__accountStateForTests.accountState;
  const subjectsMock = (): jest.Mock =>
    (jest.requireMock('../lambda/src/lib/person-identity') as { subjectsOfPerson: jest.Mock }).subjectsOfPerson;
  const teamAttachment = () => ({
    httpMethod: 'POST',
    path: '/exchange-credentials/admin/assistants/helper/attachment-read',
    requestContext: { identity: { userArn: `arn:aws:sts::111:assumed-role/agent-echelon-team-console/console-${ADMIN_SUB}@standard` } },
    body: JSON.stringify({ reason: 'unit test', channelArn: CHANNEL }),
  });

  it("asks the issuer of the session's person at a per-capability vend, and vends when it answers active", async () => {
    const { handler } = loadHandler();
    const res = await handler(adminVend('view-messages', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    expect(subjectsMock()).toHaveBeenCalledWith(`${APP}/user/${ADMIN_SUB}`, {});
    expect(accountStateMock()).toHaveBeenCalledWith(NATIVE_ID, ADMIN_SUB);
  });

  it.each(['disabled', 'gone'] as const)('refuses a per-capability vend for a person their issuer reports %s, and assumes nothing', async (state) => {
    const { handler } = loadHandler();
    accountStateMock().mockResolvedValue(state);
    for (const cap of ['view-messages', 'attachment-read', 'redact']) {
      const res = await handler(adminVend(cap, { channelArn: CHANNEL }));
      expect([cap, res.statusCode, JSON.parse(res.body).code]).toEqual([cap, 403, 'PERSON_NOT_ACTIVE']);
    }
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockDocSend.mock.calls.filter((c) => c[0]?.input?.TableName === 'access-log')).toEqual([]);
  });

  it('refuses 503 and assumes nothing when the issuer cannot be asked (fail closed)', async () => {
    const { handler } = loadHandler();
    accountStateMock().mockRejectedValue(Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }));
    const res = await handler(adminVend('view-messages', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('DIRECTORY_UNAVAILABLE');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it("refuses 503 when the person's subjects cannot be read", async () => {
    const { handler } = loadHandler();
    subjectsMock().mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));
    const res = await handler(adminVend('view-messages', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(503);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('asks only the admin issuers: a person who signs in through no admin issuer is refused, and nobody is asked', async () => {
    const { handler } = loadHandler();
    subjectsMock().mockResolvedValueOnce([{ issuer: 'some-host', subject: 'host-sub' }]);
    const res = await handler(adminVend('view-messages', { channelArn: CHANNEL }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_ACTIVE');
    expect(accountStateMock()).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'gone'] as const)('refuses a team attachment vend for a person their issuer reports %s, before reading the assistant', async (state) => {
    const { handler } = loadHandler();
    accountStateMock().mockResolvedValue(state);
    const res = await handler(teamAttachment());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERSON_NOT_ACTIVE');
    expect(accountStateMock()).toHaveBeenCalledWith(NATIVE_ID, ADMIN_SUB);
    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a team attachment vend 503 when the issuer cannot be asked', async () => {
    const { handler } = loadHandler();
    accountStateMock().mockRejectedValue(new Error('down'));
    const res = await handler(teamAttachment());
    expect(res.statusCode).toBe(503);
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});

export {};
