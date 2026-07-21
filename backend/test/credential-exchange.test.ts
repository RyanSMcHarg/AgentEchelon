/**
 * Unit tests for the Credential Exchange Lambda (lambda/src/credential-exchange.ts).
 * Pins the security contract: identity from validated claims only (IDOR), the
 * authoritative tier→role selection, and that AssumeRole carries the `sub` session
 * tag (the bearer pin lives on the role; the tag is what makes it resolve).
 */

const mockStsSend = jest.fn();
const mockChimeSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn(() => ({ send: mockStsSend })),
  AssumeRoleCommand: jest.fn((input: unknown) => ({ __type: 'AssumeRole', input })),
}));
jest.mock('@aws-sdk/client-chime-sdk-identity', () => ({
  ChimeSDKIdentityClient: jest.fn(() => ({ send: mockChimeSend })),
  CreateAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'CreateAppInstanceUser', input })),
  UpdateAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'UpdateAppInstanceUser', input })),
  CreateAppInstanceAdminCommand: jest.fn((input: unknown) => ({ __type: 'CreateAppInstanceAdmin', input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __type: 'GetParameter', input })),
}));

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';

function loadHandler() {
  jest.resetModules();
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ALLOWED_ORIGIN = 'https://app.example';
  process.env.EXCHANGE_ROLE_BASIC = 'arn:aws:iam::111:role/ex-basic';
  process.env.EXCHANGE_ROLE_STANDARD = 'arn:aws:iam::111:role/ex-standard';
  process.env.EXCHANGE_ROLE_PREMIUM = 'arn:aws:iam::111:role/ex-premium';
  process.env.EXCHANGE_ROLE_ADMIN = 'arn:aws:iam::111:role/ex-admin';
  process.env.EXCHANGE_ROLE_ADMIN_PLANE = 'arn:aws:iam::111:role/ex-admin-plane';
  process.env.EXCHANGE_EXECUTE_API_MESSAGES_ARN =
    'arn:aws:execute-api:us-east-1:111:api123/*/GET/admin/conversations/messages';
  process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN_PARAM = '/agentechelon/shared/attachments-bucket-arn';
  delete process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN; // force the SSM resolve path in tests
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../lambda/src/credential-exchange');
}

const goodCreds = { Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'sk', SessionToken: 'tok', Expiration: new Date('2030-01-01T00:00:00Z') } };

function event(claims: Record<string, unknown>, body?: unknown) {
  return { httpMethod: 'POST', requestContext: { authorizer: { claims } }, body: body ? JSON.stringify(body) : undefined };
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
  it('admins win; else highest tier; else basic (fail-safe floor)', () => {
    const { resolveRoleKey } = loadHandler();
    expect(resolveRoleKey(['admins', 'basic'])).toBe('admin');
    expect(resolveRoleKey(['basic', 'premium'])).toBe('premium');
    expect(resolveRoleKey(['standard'])).toBe('standard');
    expect(resolveRoleKey([])).toBe('basic');
    expect(resolveRoleKey(['nonsense'])).toBe('basic');
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
    expect(assumeInput.Tags).toEqual([{ Key: 'sub', Value: 'user-A' }]); // claim sub, not body
    const out = JSON.parse(res.body);
    expect(out.userArn).toBe(`${APP}/user/user-A`);
    expect(out.tier).toBe('basic');
  });

  it('assumes the matching per-tier role with the sub session tag', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: 'u1', 'cognito:groups': ['standard'] }));
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/ex-standard');
    expect(input.Tags).toEqual([{ Key: 'sub', Value: 'u1' }]);
  });

  it('ensures the AppInstanceUser (idempotent) before vending', async () => {
    const { handler } = loadHandler();
    await handler(event({ sub: 'u1', 'cognito:groups': 'premium' }));
    const createInput = mockChimeSend.mock.calls[0][0].input;
    expect(createInput.AppInstanceArn).toBe(APP);
    expect(createInput.AppInstanceUserId).toBe('u1');
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
});

// The two-plane admin identity model (docs/SPEC-ADMIN-IDENTITY.md): an admin's
// CHAT identity `${sub}` is never elevated; cross-channel moderation runs on a
// SEPARATE, standing-elevated `${sub}-admin` identity that only ever receives a
// per-channel, short-lived, audited credential (identity:'admin' + channelArn).
describe('admin identity — two-plane model', () => {
  const CHANNEL = `${APP}/channel/room-1`;

  it('an admin on the CHAT plane pins `${sub}`, never `${sub}-admin`', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: 'adm', 'cognito:groups': 'admins' }));
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    // Chat identity: the caller's own sub, never the elevated admin identity.
    expect(out.userArn).toBe(`${APP}/user/adm`);
    expect(mockStsSend.mock.calls[0][0].input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin');
  });

  it('identity:admin from a NON-admin is refused (403)', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: 'u1', 'cognito:groups': 'premium' }, { identity: 'admin', channelArn: CHANNEL }));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('identity:admin without a channelArn scope is refused (400)', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: 'adm', 'cognito:groups': 'admins' }, { identity: 'admin' }));
    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('identity:admin + channelArn vends the ADMIN-PLANE role pinned to `${sub}-admin`, channel-scoped', async () => {
    const { handler } = loadHandler();
    const res = await handler(event({ sub: 'adm', 'cognito:groups': 'admins' }, { identity: 'admin', channelArn: CHANNEL }));
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    // The elevated, SEPARATE admin identity — not the chat sub.
    expect(out.userArn).toBe(`${APP}/user/adm-admin`);
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin-plane');
    // Session tag is still the human's sub (the role appends -admin in-policy).
    expect(input.Tags).toEqual([{ Key: 'sub', Value: 'adm' }]);
    // The session policy narrows to exactly the requested channel.
    const policy = JSON.parse(input.Policy);
    const requested = policy.Statement.find((s: { Sid: string }) => s.Sid === 'RequestedActions');
    expect(requested.Resource).toContain(CHANNEL);
  });
});

// A14 archive plane (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md section 6.5): reading
// customer message content (A2) is vended as a short-lived, audited `execute-api`
// session policy on the admin-plane role — NOT a Chime session policy — so a
// standing sign-on role never holds a customer-PII read.
describe('A14 archive vend — view-messages (execute-api plane)', () => {
  const CHANNEL = `${APP}/channel/room-1`;
  const MESSAGES_ARN = 'arn:aws:execute-api:us-east-1:111:api123/*/GET/admin/conversations/messages';

  it('vends an execute-api:Invoke session policy on the admin-plane role', async () => {
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['view-messages'] },
    ));
    expect(res.statusCode).toBe(200);
    const input = mockStsSend.mock.calls[0][0].input;
    // Assumed on the admin-plane role with the human's sub tag.
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin-plane');
    expect(input.Tags).toEqual([{ Key: 'sub', Value: 'adm' }]);
    // Session policy is execute-api on exactly the messages resource — no chime:* actions.
    const policy = JSON.parse(input.Policy);
    const stmt = policy.Statement.find((s: { Sid: string }) => s.Sid === 'ArchiveApiInvoke');
    expect(stmt.Action).toEqual(['execute-api:Invoke']);
    expect(stmt.Resource).toEqual([MESSAGES_ARN]);
    expect(JSON.stringify(policy)).not.toContain('chime:');
    // No Chime identity provisioned for an execute-api vend.
    expect(mockChimeSend).not.toHaveBeenCalled();
    const out = JSON.parse(res.body);
    expect(out.userArn).toBe(`${APP}/user/adm-admin`);
    expect(out.identity).toBe('admin');
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

  it('refuses to mix archive (execute-api) and Chime capabilities', async () => {
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['view-messages', 'view'] },
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
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['attachment-read'] },
    ));
    expect(res.statusCode).toBe(200);
    const input = mockStsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::111:role/ex-admin-plane');
    expect(input.Tags).toEqual([{ Key: 'sub', Value: 'adm' }]);
    const policy = JSON.parse(input.Policy);
    const stmt = policy.Statement.find((s: { Sid: string }) => s.Sid === 'AttachmentGet');
    expect(stmt.Action).toEqual(['s3:GetObject']);
    // Confined to THIS channel's DELIVERABLES prefix — not the whole bucket, not user uploads.
    expect(stmt.Resource).toEqual([`${BUCKET}/generated-docs/room-1/*`]);
    expect(JSON.stringify(policy)).not.toContain('/attachments/');
    // An S3 vend provisions no Chime identity.
    expect(mockChimeSend).not.toHaveBeenCalled();
    const out = JSON.parse(res.body);
    expect(out.userArn).toBe(`${APP}/user/adm-admin`);
    expect(out.identity).toBe('admin');
    expect(out.bucket).toBe('my-attach-bucket'); // name (not ARN) for the client to address GetObject
    expect(out.region).toBe('us-east-1');
  });

  it('attachment-read-uploads scopes to the USER-UPLOAD prefix (attachments/<channelId>/*)', async () => {
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['attachment-read-uploads'] },
    ));
    expect(res.statusCode).toBe(200);
    const policy = JSON.parse(mockStsSend.mock.calls[0][0].input.Policy);
    const stmt = policy.Statement.find((s: { Sid: string }) => s.Sid === 'AttachmentGet');
    expect(stmt.Resource).toEqual([`${BUCKET}/attachments/room-1/*`]);
    expect(JSON.stringify(policy)).not.toContain('/generated-docs/');
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

  it('refuses to mix S3 attachment and Chime capabilities', async () => {
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['attachment-read', 'view'] },
    ));
    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses to mix S3 attachment and archive (execute-api) capabilities', async () => {
    const { handler } = loadHandler();
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['attachment-read', 'view-messages'] },
    ));
    expect(res.statusCode).toBe(400);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('500s (never leaks) when the attachments bucket ARN is unresolved', async () => {
    const { handler } = loadHandler();
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: '' } }); // param present but empty
    const res = await handler(event(
      { sub: 'adm', 'cognito:groups': 'admins' },
      { identity: 'admin', channelArn: CHANNEL, capabilities: ['attachment-read'] },
    ));
    expect(res.statusCode).toBe(500);
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
