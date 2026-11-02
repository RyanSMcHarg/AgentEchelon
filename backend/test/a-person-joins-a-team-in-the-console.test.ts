import { edgeContext } from './helpers/edge-context';
/**
 * AN ADMINISTRATOR PUTS A PERSON IN A CONSOLE TEAM, OR TAKES THEM OUT (owner decision, 2026-10-24: "Teams should
 * be editable").
 *
 * A team is a `team-<name>` group, and the console admits a team member only on the `team-members` role group, so
 * POST /users/team keeps the two in step: joining a first team adds the role, leaving the last one removes it, and
 * an administrator's groups are never touched beyond the team itself. Only an approved, enabled account joins, only
 * a team that exists can be named, and the role group itself is not a team. The user list carries the teams that
 * exist and each person's teams.
 */
const mockCognitoSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
    ListUsersCommand: cmd('ListUsers'),
    ListUsersInGroupCommand: cmd('ListUsersInGroup'),
    ListGroupsCommand: cmd('ListGroups'),
    GetGroupCommand: cmd('GetGroup'),
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

const event = (method: string, path: string, body?: unknown) => ({
  httpMethod: method,
  path,
  headers: { origin: 'https://app.example' },
  requestContext: { authorizer: edgeContext({ claims: { 'cognito:groups': 'admins', sub: 'admin-sub' } }) },
  body: body === undefined ? null : JSON.stringify(body),
}) as never;

const sent = (t: string) => mockCognitoSend.mock.calls.map(([c]) => c).filter((c) => c.__t === t).map((c) => c.input);
const group = (GroupName: string) => ({ UserPoolId: 'pool-1', Username: 'lead@x', GroupName });

/**
 * The pool: its groups, the target's groups, and whether the target is approved and enabled. The target's groups
 * follow the writes, as the pool's do, so a read after a change sees it.
 */
function directory(opts: { groups: string[]; approved?: boolean; enabled?: boolean }) {
  const groups = new Set(opts.groups);
  mockCognitoSend.mockReset().mockImplementation((c: { __t: string; input: { GroupName?: string } }) => {
    if (c.__t === 'AdminAddUserToGroup') { groups.add(c.input.GroupName!); return Promise.resolve({}); }
    if (c.__t === 'AdminRemoveUserFromGroup') { groups.delete(c.input.GroupName!); return Promise.resolve({}); }
    if (c.__t === 'AdminListGroupsForUser') return Promise.resolve({ Groups: [...groups].map((GroupName) => ({ GroupName })) });
    if (c.__t === 'ListGroups') {
      return Promise.resolve({ Groups: ['admins', 'premium', 'ops', 'team-members', 'team-ops', 'team-finance'].map((GroupName) => ({ GroupName })) });
    }
    if (c.__t === 'ListUsers') return Promise.resolve({ Users: [{ Username: 'lead@x', Attributes: [{ Name: 'sub', Value: 'sub-lead' }] }] });
    if (c.__t === 'ListUsersInGroup') return Promise.resolve({ Users: c.input.GroupName === 'team-ops' ? [{ Username: 'lead@x' }] : [] });
    if (c.__t === 'AdminGetUser') {
      return Promise.resolve({
        Enabled: opts.enabled ?? true,
        UserAttributes: [{ Name: 'custom:approved', Value: (opts.approved ?? true) ? 'true' : 'false' }],
      });
    }
    return Promise.resolve({});
  });
}

describe('POST /users/team', () => {
  it('adds a person to their first team with the team-member console role, and takes the role with the last team', async () => {
    directory({ groups: ['premium'] });
    const joined = await loadHandler()(event('POST', '/users/team', { username: 'lead@x', team: 'ops', member: true }));
    expect(joined.statusCode).toBe(200);
    expect(JSON.parse(joined.body).consoleRole).toBe('added');
    expect(sent('AdminAddUserToGroup')).toEqual([group('team-ops'), group('team-members')]);

    directory({ groups: ['premium', 'team-members', 'team-ops'] });
    const left = await loadHandler()(event('POST', '/users/team', { username: 'lead@x', team: 'ops', member: false }));
    expect(JSON.parse(left.body).consoleRole).toBe('removed');
    expect(sent('AdminRemoveUserFromGroup')).toEqual([group('team-ops'), group('team-members')]);
  });

  it('decides the role from the groups after the change, so a change made meanwhile is not undone', async () => {
    // Another administrator added team-finance after this request started; the person must keep the role.
    directory({ groups: ['premium', 'team-members', 'team-ops'] });
    const base = mockCognitoSend.getMockImplementation()!;
    mockCognitoSend.mockImplementation((c: { __t: string; input: { GroupName?: string } }) => {
      if (c.__t === 'AdminRemoveUserFromGroup' && c.input.GroupName === 'team-ops') {
        return base({ __t: 'AdminAddUserToGroup', input: { GroupName: 'team-finance' } }).then(() => base(c));
      }
      return base(c);
    });
    const res = await loadHandler()(event('POST', '/users/team', { username: 'lead@x', team: 'ops', member: false }));
    expect(JSON.parse(res.body).consoleRole).toBe('unchanged');
    expect(sent('AdminRemoveUserFromGroup')).toEqual([group('team-ops')]);
  });

  it('keeps the role while the person is still in another team', async () => {
    directory({ groups: ['premium', 'team-members', 'team-ops', 'team-finance'] });
    const res = await loadHandler()(event('POST', '/users/team', { username: 'lead@x', team: 'ops', member: false }));
    expect(JSON.parse(res.body).consoleRole).toBe('unchanged');
    expect(sent('AdminRemoveUserFromGroup')).toEqual([group('team-ops')]);
  });

  it('never gives or takes the console role of an administrator, who already reaches every assistant', async () => {
    directory({ groups: ['admins'] });
    await loadHandler()(event('POST', '/users/team', { username: 'lead@x', team: 'ops', member: true }));
    expect(sent('AdminAddUserToGroup')).toEqual([group('team-ops')]);
    directory({ groups: ['admins', 'team-ops'] });
    await loadHandler()(event('POST', '/users/team', { username: 'lead@x', team: 'ops', member: false }));
    expect(sent('AdminRemoveUserFromGroup')).toEqual([group('team-ops')]);
  });

  it('refuses a team that does not exist, the role group named as a team, and a pending or disabled account', async () => {
    for (const team of ['sales', 'members', 'Ops Team']) {
      directory({ groups: ['premium'] });
      const res = await loadHandler()(event('POST', '/users/team', { username: 'lead@x', team, member: true }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('NOT_A_TEAM');
      expect(sent('AdminAddUserToGroup')).toEqual([]);
    }
    for (const opts of [{ groups: ['premium'], approved: false }, { groups: ['premium'], enabled: false }]) {
      directory(opts);
      const res = await loadHandler()(event('POST', '/users/team', { username: 'lead@x', team: 'ops', member: true }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('NOT_APPROVED');
      expect(sent('AdminAddUserToGroup')).toEqual([]);
    }
  });

  it('lists the teams that exist and the teams each person is in', async () => {
    directory({ groups: ['premium', 'team-members', 'team-ops'] });
    const res = await loadHandler()(event('GET', '/users'));
    const body = JSON.parse(res.body);
    expect(body.teams).toEqual(['finance', 'ops']);
    expect(body.users.find((u: { username: string }) => u.username === 'lead@x').teams).toEqual(['ops']);
  });
});
