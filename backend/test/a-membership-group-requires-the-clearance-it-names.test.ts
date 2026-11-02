import { edgeContext } from './helpers/edge-context';
/**
 * An administrator adds a person to a membership group (`ops`) or removes them, through POST /users/group,
 * and the user list shows who is in each membership group and what clearance it requires.
 *
 * A membership group grants nothing. Joining requires an approved, enabled person ALREADY cleared for what
 * the group requires; anyone else is refused, so the group can never name someone its conversations'
 * classification would refuse. Lowering a member's clearance below the requirement removes them from the
 * group. The route touches membership groups only: a clearance group is set through /tier.
 */
const mockCognitoSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
    ListUsersCommand: cmd('ListUsers'),
    ListUsersInGroupCommand: cmd('ListUsersInGroup'),
    ListGroupsCommand: cmd('ListGroups'),
    AdminGetUserCommand: cmd('AdminGetUser'),
    AdminDeleteUserCommand: cmd('AdminDeleteUser'),
    AdminUpdateUserAttributesCommand: cmd('AdminUpdateUserAttributes'),
    AdminDisableUserCommand: cmd('AdminDisableUser'),
    AdminEnableUserCommand: cmd('AdminEnableUser'),
    AdminAddUserToGroupCommand: cmd('AdminAddUserToGroup'),
    AdminRemoveUserFromGroupCommand: cmd('AdminRemoveUserFromGroup'),
    AdminListGroupsForUserCommand: cmd('AdminListGroupsForUser'),
  };
});
jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    ChimeSDKIdentityClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
    TagResourceCommand: cmd('TagResource'),
    CreateAppInstanceUserCommand: cmd('CreateAppInstanceUser'),
    DescribeAppInstanceUserCommand: cmd('DescribeAppInstanceUser'),
    DeleteAppInstanceUserCommand: cmd('DeleteAppInstanceUser'),
    // The list of people starts from the AppInstanceUsers; none here, so every pool account is listed as one
    // that has not signed in yet.
    ListAppInstanceUsersCommand: cmd('ListAppInstanceUsers'),
  };
});
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
  InvokeCommand: jest.fn((input: unknown) => ({ __t: 'Invoke', input })),
  InvocationType: { Event: 'Event' },
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({ ChimeSDKMessagingClient: jest.fn(() => ({ send: jest.fn() })) }));
jest.mock('@aws-sdk/client-ssm', () => ({ SSMClient: jest.fn(() => ({ send: jest.fn() })) }));

function loadHandler() {
  jest.resetModules();
  process.env.USER_POOL_ID = 'pool-1';
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111:app-instance/abc';
  process.env.ALLOWED_ORIGIN = 'https://app.example';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('./helpers/offboarding-in-process') as typeof import('./helpers/offboarding-in-process')).userManagementWithOffboardingInProcess<{ handler: any }>().handler;
}

const event = (method: string, path: string, body?: unknown, groups = 'admins') => ({
  httpMethod: method,
  path,
  headers: { origin: 'https://app.example' },
  requestContext: { authorizer: edgeContext({ claims: { 'cognito:groups': groups, sub: 'admin-sub' } }) },
  body: body === undefined ? null : JSON.stringify(body),
}) as never;

const sent = (t: string) => mockCognitoSend.mock.calls.map(([c]) => c).filter((c) => c.__t === t).map((c) => c.input);

/** The directory: the target's current groups, and whether they are approved and enabled. */
function directory(opts: { groups: string[]; approved?: boolean; enabled?: boolean }) {
  mockCognitoSend.mockReset().mockImplementation((c: { __t: string }) => {
    if (c.__t === 'ListUsers') return Promise.resolve({ Users: [{ Username: 'lead@x', Attributes: [{ Name: 'sub', Value: 'sub-lead' }] }, { Username: 'other@x', Attributes: [] }] });
    if (c.__t === 'ListUsersInGroup') return Promise.resolve({ Users: [{ Username: 'lead@x' }] });
    if (c.__t === 'AdminListGroupsForUser') return Promise.resolve({ Groups: opts.groups.map((GroupName) => ({ GroupName })) });
    if (c.__t === 'AdminGetUser') {
      return Promise.resolve({
        Enabled: opts.enabled ?? true,
        UserAttributes: [{ Name: 'custom:approved', Value: (opts.approved ?? true) ? 'true' : 'false' }],
      });
    }
    return Promise.resolve({});
  });
}

describe('POST /users/group', () => {
  it('adds a person already cleared for premium to ops, and removes them', async () => {
    directory({ groups: ['premium'] });
    const handler = loadHandler();
    expect((await handler(event('POST', '/users/group', { username: 'lead@x', group: 'ops', member: true }))).statusCode).toBe(200);
    expect(sent('AdminAddUserToGroup')).toEqual([{ UserPoolId: 'pool-1', Username: 'lead@x', GroupName: 'ops' }]);
    expect((await handler(event('POST', '/users/group', { username: 'lead@x', group: 'ops', member: false }))).statusCode).toBe(200);
    expect(sent('AdminRemoveUserFromGroup')).toEqual([{ UserPoolId: 'pool-1', Username: 'lead@x', GroupName: 'ops' }]);
  });

  it('refuses someone whose clearance does not reach what the group requires: the group never raises it', async () => {
    for (const groups of [['basic'], ['standard'], []]) {
      directory({ groups });
      const res = await loadHandler()(event('POST', '/users/group', { username: 'lead@x', group: 'ops', member: true }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'CLEARANCE_BELOW_GROUP', requires: 'premium' });
      expect(sent('AdminAddUserToGroup')).toEqual([]);
    }
  });

  it('refuses an admins-only person, who holds no clearance a /tier change would maintain', async () => {
    directory({ groups: ['admins'] });
    const res = await loadHandler()(event('POST', '/users/group', { username: 'lead@x', group: 'ops', member: true }));
    expect(res.statusCode).toBe(409);
    expect(sent('AdminAddUserToGroup')).toEqual([]);
  });

  it('refuses a pending or disabled user even with the clearance', async () => {
    for (const opts of [{ groups: ['premium'], approved: false }, { groups: ['premium'], enabled: false }]) {
      directory(opts);
      const res = await loadHandler()(event('POST', '/users/group', { username: 'lead@x', group: 'ops', member: true }));
      expect(res.statusCode).toBe(409);
      expect(sent('AdminAddUserToGroup')).toEqual([]);
    }
  });

  it('refuses a clearance group, so this route can never set anybody\'s clearance', async () => {
    directory({ groups: ['basic'] });
    const res = await loadHandler()(event('POST', '/users/group', { username: 'lead@x', group: 'premium', member: true }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('NOT_A_MEMBERSHIP_GROUP');
    expect(sent('AdminAddUserToGroup')).toEqual([]);
  });

  it('requires an administrator', async () => {
    directory({ groups: ['premium'] });
    expect((await loadHandler()(event('POST', '/users/group', { username: 'lead@x', group: 'ops', member: true }, 'basic'))).statusCode).toBe(403);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });
});

describe('lowering a member\'s clearance', () => {
  it('removes them from a membership group whose requirement they no longer meet', async () => {
    directory({ groups: ['premium', 'ops'] });
    expect((await loadHandler()(event('POST', '/users/tier', { username: 'lead@x', tier: 'standard' }))).statusCode).toBe(200);
    expect(sent('AdminRemoveUserFromGroup')).toEqual(expect.arrayContaining([
      { UserPoolId: 'pool-1', Username: 'lead@x', GroupName: 'ops' },
    ]));
  });

  it('still removes them when their group list cannot be read, rather than assuming they are in nothing', async () => {
    directory({ groups: ['premium', 'ops'] });
    const base = mockCognitoSend.getMockImplementation()!;
    mockCognitoSend.mockImplementation((c: { __t: string }) =>
      (c.__t === 'AdminListGroupsForUser' ? Promise.reject(Object.assign(new Error('x'), { name: 'TooManyRequestsException' })) : base(c)));
    expect((await loadHandler()(event('POST', '/users/tier', { username: 'lead@x', tier: 'basic' }))).statusCode).toBe(200);
    expect(sent('AdminRemoveUserFromGroup')).toEqual(expect.arrayContaining([
      { UserPoolId: 'pool-1', Username: 'lead@x', GroupName: 'ops' },
    ]));
  });

  it('leaves them in the group when the new clearance still meets it', async () => {
    directory({ groups: ['standard', 'ops'] });
    await loadHandler()(event('POST', '/users/tier', { username: 'lead@x', tier: 'premium' }));
    expect(sent('AdminRemoveUserFromGroup').filter((i) => i.GroupName === 'ops')).toEqual([]);
  });
});

describe('GET /users', () => {
  it('shows who is in each membership group, and what clearance each requires', async () => {
    directory({ groups: [] });
    const { users, membershipGroups } = JSON.parse((await loadHandler()(event('GET', '/users'))).body);
    expect(membershipGroups).toEqual([{ name: 'ops', requires: 'premium' }]);
    expect(users.find((u: { username: string }) => u.username === 'lead@x').membershipGroups).toEqual(['ops']);
    expect(users.find((u: { username: string }) => u.username === 'other@x').membershipGroups).toEqual([]);
  });
});
