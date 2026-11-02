import { edgeContext } from './helpers/edge-context';
/**
 * A CLEARANCE NARROWED WHILE A PERSON IS DISABLED STILL RE-STAMPS THEIR TAG AND RE-AUDITS THEIR ROOMS.
 *
 * Disabling a pool account changes nothing on the platform's side: the exchange refuses the person at their
 * next vend by asking the pool. A downgrade on a disabled user still re-stamps the identity tag and asks
 * for the membership re-evaluation, so they never keep memberships their new clearance does not reach.
 * The lifecycle reads the row directly (`rowOfSubject`), at whatever status it holds, rather than resolve
 * it as a request does.
 */
const mockCognitoSend = jest.fn();
const mockChimeSend = jest.fn().mockResolvedValue({});
const mockLambdaSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
    ListUsersCommand: cmd('ListUsers'),
    ListUsersInGroupCommand: cmd('ListUsersInGroup'),
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
    ChimeSDKIdentityClient: jest.fn(() => ({ send: mockChimeSend })),
    TagResourceCommand: cmd('TagResource'),
    CreateAppInstanceUserCommand: cmd('CreateAppInstanceUser'),
    DescribeAppInstanceUserCommand: cmd('DescribeAppInstanceUser'),
    DeleteAppInstanceUserCommand: cmd('DeleteAppInstanceUser'),
    ListAppInstanceUsersCommand: cmd('ListAppInstanceUsers'),
  };
});
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ __t: 'Invoke', input })),
  InvocationType: { Event: 'Event' },
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({ ChimeSDKMessagingClient: jest.fn(() => ({ send: jest.fn() })) }));
jest.mock('@aws-sdk/client-ssm', () => ({ SSMClient: jest.fn(() => ({ send: jest.fn() })) }));

const POOL = 'us-east-1_Pool';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
const SUB = 'sub-lead';
const PERSON = `${APP}/user/0192f0e0-0000-7000-8000-00000000a11c`;

function loadHandler(rowStatus: string) {
  jest.resetModules();
  process.env.USER_POOL_ID = POOL;
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ALLOWED_ORIGIN = 'https://app.example';
  process.env.MEMBERSHIP_AUDIT_FN_NAME = 'membership-audit';
  // The person's row. A request's resolver is not what the lifecycle reads, so it answers nobody here.
  const identity = jest.requireMock('../lambda/src/lib/person-identity') as { resolvePerson: jest.Mock };
  identity.resolvePerson.mockResolvedValue(null);
  const row = { issuerSubject: `${ISSUER}|${SUB}`, personArn: PERSON, issuer: ISSUER, status: rowStatus };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../lambda/src/lib/offboarding').__setOffboardingDepsForTests({
    identitiesTable: 'Identities',
    primary: { issuer: ISSUER },
    doc: { send: jest.fn(async (cmd: { input: { Key?: { issuerSubject?: string } } }) => ({ Item: cmd.input.Key?.issuerSubject === row.issuerSubject ? row : undefined })) },
  });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('./helpers/offboarding-in-process') as typeof import('./helpers/offboarding-in-process')).userManagementWithOffboardingInProcess<{ handler: any }>().handler;
}

const tierTo = (tier: string) => ({
  httpMethod: 'POST',
  path: '/users/tier',
  headers: { origin: 'https://app.example' },
  requestContext: { authorizer: edgeContext({ claims: { 'cognito:groups': 'admins', sub: 'admin-sub' } }) },
  body: JSON.stringify({ username: 'lead@x', tier }),
}) as never;

beforeEach(() => {
  mockChimeSend.mockClear();
  mockLambdaSend.mockClear();
  mockCognitoSend.mockReset().mockImplementation((c: { __t: string }) => {
    if (c.__t === 'ListUsers') return Promise.resolve({ Users: [{ Username: 'lead@x', Enabled: false, Attributes: [{ Name: 'sub', Value: SUB }] }] });
    if (c.__t === 'AdminListGroupsForUser') return Promise.resolve({ Groups: [{ GroupName: 'premium' }] });
    if (c.__t === 'AdminGetUser') return Promise.resolve({ Enabled: false, UserAttributes: [{ Name: 'custom:approved', Value: 'true' }] });
    return Promise.resolve({});
  });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MEMBERSHIP_AUDIT_FN_NAME;
});

const sent = (mock: jest.Mock, t: string) => mock.mock.calls.map(([c]) => c).filter((c) => c.__t === t).map((c) => c.input);

describe('a downgrade on a person whose pool account is disabled', () => {
  it('re-stamps their identity tag and re-evaluates their memberships', async () => {
    const res = await loadHandler('active')(tierTo('basic'));
    expect(res.statusCode).toBe(200);
    expect(sent(mockChimeSend, 'TagResource')).toEqual([{ ResourceARN: PERSON, Tags: [{ Key: 'classification', Value: 'basic' }] }]);
    const invoked = sent(mockLambdaSend, 'Invoke');
    expect(invoked).toHaveLength(1);
    expect(JSON.parse(Buffer.from(invoked[0].Payload).toString())).toEqual({ type: 'reeval-user', userArn: PERSON });
  });

  it('the same whatever the row\'s status (a pending one)', async () => {
    await loadHandler('pending')(tierTo('basic'));
    expect(sent(mockChimeSend, 'TagResource')).toHaveLength(1);
    expect(sent(mockLambdaSend, 'Invoke')).toHaveLength(1);
  });
});
