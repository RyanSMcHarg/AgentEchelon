/**
 * Unit tests for the Credential Exchange Lambda (lambda/src/credential-exchange.ts).
 * Pins the security contract: identity from validated claims only (IDOR), the
 * authoritative tier→role selection, and that AssumeRole carries the `sub` session
 * tag (the bearer pin lives on the role; the tag is what makes it resolve).
 */

const mockStsSend = jest.fn();
const mockChimeSend = jest.fn();

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

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
