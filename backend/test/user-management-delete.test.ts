/**
 * Unit test for the user-management full-lifecycle DELETE (SPEC-CREDENTIAL-EXCHANGE §5b):
 * deleting a user must remove BOTH the Cognito user and the Chime AppInstanceUser
 * (neutralizing the …/user/<sub> ARN), be admin-gated, and be idempotent (NotFound ok).
 */

const mockCognitoSend = jest.fn();
const mockChimeSend = jest.fn();
const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
    ListChannelMembershipsForAppInstanceUserCommand: cmd('ListMembershipsForUser'),
    DeleteChannelMembershipCommand: cmd('DeleteChannelMembership'),
  };
});
jest.mock('@aws-sdk/client-ssm', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    SSMClient: jest.fn(() => ({ send: mockSsmSend })),
    GetParameterCommand: cmd('GetParameter'),
  };
});

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
    ListUsersCommand: cmd('ListUsers'),
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
    ChimeSDKIdentityClient: jest.fn(() => ({ send: mockChimeSend })),
    CreateAppInstanceUserCommand: cmd('CreateAppInstanceUser'),
    DescribeAppInstanceUserCommand: cmd('DescribeAppInstanceUser'),
    DeleteAppInstanceUserCommand: cmd('DeleteAppInstanceUser'),
  };
});

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';

function loadHandler() {
  jest.resetModules();
  process.env.USER_POOL_ID = 'pool-1';
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ALLOWED_ORIGIN = 'https://app.example';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../lambda/src/user-management').handler;
}

function deleteEvent(username: string, groups: string | string[] = 'admins') {
  return {
    httpMethod: 'POST',
    path: '/users/delete',
    headers: { origin: 'https://app.example' },
    requestContext: { authorizer: { claims: { 'cognito:groups': groups } } },
    body: JSON.stringify({ username }),
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCognitoSend.mockImplementation((cmd: { __t: string }) => {
    if (cmd.__t === 'ListUsers') return Promise.resolve({ Users: [{ Attributes: [{ Name: 'sub', Value: 'sub-123' }] }] });
    return Promise.resolve({});
  });
  mockChimeSend.mockResolvedValue({});
  mockSsmSend.mockResolvedValue({ Parameter: { Value: 'arn:aws:chime:us-east-1:111:app-instance/abc/user/admin-bot' } });
  mockMessagingSend.mockImplementation((cmd: { __t: string }) => {
    if (cmd.__t === 'ListMembershipsForUser') {
      return Promise.resolve({ ChannelMemberships: [{ ChannelSummary: { ChannelArn: `${APP}/channel/c1` } }] });
    }
    return Promise.resolve({});
  });
});

describe('POST /users/delete', () => {
  it('requires admin', async () => {
    const handler = loadHandler();
    const res = await handler(deleteEvent('u@x.com', 'basic'));
    expect(res.statusCode).toBe(403);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it('deletes the AppInstanceUser (by sub) AND the Cognito user', async () => {
    const handler = loadHandler();
    const res = await handler(deleteEvent('u@x.com'));
    expect(res.statusCode).toBe(200);

    const chimeCmds = mockChimeSend.mock.calls.map((c) => c[0]);
    const del = chimeCmds.find((c) => c.__t === 'DeleteAppInstanceUser');
    expect(del).toBeTruthy();
    expect(del.input.AppInstanceUserArn).toBe(`${APP}/user/sub-123`);

    const cognitoCmds = mockCognitoSend.mock.calls.map((c) => c[0]);
    const adminDel = cognitoCmds.find((c) => c.__t === 'AdminDeleteUser');
    expect(adminDel).toBeTruthy();
    expect(adminDel.input.Username).toBe('u@x.com');
  });

  it('removes the user\'s channel memberships first, as the app-instance admin', async () => {
    const handler = loadHandler();
    await handler(deleteEvent('u@x.com'));
    const msgCmds = mockMessagingSend.mock.calls.map((c) => c[0]);
    const del = msgCmds.find((c) => c.__t === 'DeleteChannelMembership');
    expect(del).toBeTruthy();
    expect(del.input.ChannelArn).toBe(`${APP}/channel/c1`);
    expect(del.input.MemberArn).toBe(`${APP}/user/sub-123`);
    expect(del.input.ChimeBearer).toBe('arn:aws:chime:us-east-1:111:app-instance/abc/user/admin-bot');
  });

  it('membership cleanup is non-fatal — delete still completes if it fails', async () => {
    const handler = loadHandler();
    mockMessagingSend.mockRejectedValue(new Error('chime down'));
    const res = await handler(deleteEvent('u@x.com'));
    expect(res.statusCode).toBe(200);
    // The AppInstanceUser + Cognito user are still deleted.
    expect(mockChimeSend.mock.calls.some((c) => c[0].__t === 'DeleteAppInstanceUser')).toBe(true);
  });

  it('is idempotent — tolerates NotFound on both deletes', async () => {
    const handler = loadHandler();
    mockChimeSend.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NotFoundException' }));
    mockCognitoSend.mockImplementation((cmd: { __t: string }) => {
      if (cmd.__t === 'ListUsers') return Promise.resolve({ Users: [{ Attributes: [{ Name: 'sub', Value: 'sub-123' }] }] });
      if (cmd.__t === 'AdminDeleteUser') return Promise.reject(Object.assign(new Error('gone'), { name: 'UserNotFoundException' }));
      return Promise.resolve({});
    });
    const res = await handler(deleteEvent('u@x.com'));
    expect(res.statusCode).toBe(200);
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
