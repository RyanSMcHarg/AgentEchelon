import { edgeContext } from './helpers/edge-context';
/**
 * GET /users READS EACH PERSON CONCURRENTLY AND ANSWERS THE SAME LIST (user-management.ts `listPeople`).
 *
 * The list is one Identities query and one name lookup per person. They ran one person after another,
 * so the console's list took a round trip per person. They now run a page at a time with a bounded
 * pool, and the answer is the list a sequential walk produces: the AppInstanceUsers in their listed
 * order, service principals and admin twins left out, then the pool accounts nobody signs in as.
 */
const mockCognitoSend = jest.fn();
const mockChimeSend = jest.fn();

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
    ChimeSDKIdentityClient: jest.fn(() => ({ send: mockChimeSend })),
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

const POOL = 'us-east-1_Pool';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const OTHER = 'https://idp.partner.example';
const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
const SERVICE_ADMIN = `${APP}/user/service-admin`;
const id = (n: number) => `0192f0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const arn = (n: number) => `${APP}/user/${id(n)}`;

/**
 * 23 people over two pages. Person 5 is a service principal (no rows), 9's pool account is disabled, and 14
 * signs in through another issuer only, which reports their account disabled.
 */
const PEOPLE = Array.from({ length: 23 }, (_, i) => i + 1);
const rowsOf = (n: number) => {
  if (n === 5) return [];
  if (n === 14) return [{ issuerSubject: `${OTHER}|ext-14`, personArn: arn(n), issuer: OTHER, status: 'active' }];
  return [{ issuerSubject: `${ISSUER}|sub-${n}`, personArn: arn(n), issuer: ISSUER, status: 'active' }];
};
/** Pool accounts: one per pool person, and one that never signed in. */
const ACCOUNTS = [...PEOPLE.filter((n) => n !== 5 && n !== 14).map((n) => `sub-${n}`), 'sub-never'];

let inFlight = 0;
let peak = 0;

function loadHandler() {
  jest.resetModules();
  process.env.USER_POOL_ID = POOL;
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ALLOWED_ORIGIN = 'https://app.example';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../lambda/src/lib/offboarding').__setOffboardingDepsForTests({
    identitiesTable: 'Identities',
    primary: { issuer: ISSUER },
    adminBearer: async () => SERVICE_ADMIN,
    doc: {
      send: jest.fn(async (cmd: { input: { ExpressionAttributeValues: Record<string, string> } }) => {
        const personArn = cmd.input.ExpressionAttributeValues[':p'];
        const n = PEOPLE.find((p) => arn(p) === personArn)!;
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Uneven latencies, so a list assembled in completion order would come out shuffled.
        await new Promise((r) => setTimeout(r, (n * 7) % 5));
        inFlight--;
        return { Items: rowsOf(n) };
      }),
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('./helpers/offboarding-in-process') as typeof import('./helpers/offboarding-in-process')).userManagementWithOffboardingInProcess<{ handler: any }>().handler;
}

const user = (sub: string) => ({
  Username: `${sub}@x`, Enabled: sub !== 'sub-9', UserStatus: 'CONFIRMED',
  Attributes: [{ Name: 'sub', Value: sub }, { Name: 'email', Value: `${sub}@x` }, { Name: 'custom:tier', Value: 'basic' }, { Name: 'custom:approved', Value: 'true' }],
});

beforeEach(() => {
  inFlight = 0;
  peak = 0;
  mockCognitoSend.mockReset().mockImplementation(async (c: { __t: string; input: { Username?: string } }) => {
    if (c.__t === 'ListUsers') return { Users: ACCOUNTS.map(user) };
    if (c.__t === 'ListUsersInGroup') return { Users: [] };
    // The name the directory reads for a person, by the subject the reverse lookup names.
    if (c.__t === 'AdminGetUser') return { Username: c.input.Username, UserAttributes: [{ Name: 'name', Value: `Name ${c.input.Username}` }] };
    return {};
  });
  const listed = [SERVICE_ADMIN, `${APP}/user/${id(3)}-admin`, ...PEOPLE.map(arn)];
  mockChimeSend.mockReset().mockImplementation(async (c: { __t: string; input: { NextToken?: string } }) => {
    if (c.__t !== 'ListAppInstanceUsers') return {};
    return c.input.NextToken
      ? { AppInstanceUsers: listed.slice(13).map((a) => ({ AppInstanceUserArn: a })) }
      : { AppInstanceUsers: listed.slice(0, 13).map((a) => ({ AppInstanceUserArn: a })), NextToken: 'page-2' };
  });
});

const get = () => ({
  httpMethod: 'GET',
  path: '/users',
  headers: { origin: 'https://app.example' },
  requestContext: { authorizer: edgeContext({ claims: { 'cognito:groups': 'admins', sub: 'admin-sub' } }) },
  body: null,
}) as never;

describe('the list of people', () => {
  it('is the list a sequential walk produces, in the listed order', async () => {
    const handler = loadHandler();
    // The other issuer's own answer for person 14's account, asked when the list is read.
    const { accountState } = (jest.requireMock('../lambda/src/lib/membership-source') as { __accountStateForTests: { accountState: jest.Mock } }).__accountStateForTests;
    accountState.mockImplementation(async (issuer: string) => (issuer === OTHER ? 'disabled' : 'active'));
    const res = await handler(get());
    expect(res.statusCode).toBe(200);
    const { users } = JSON.parse(res.body);

    const expected = [
      ...PEOPLE.filter((n) => n !== 5).map((n) => {
        const pool = n !== 14;
        return {
          personArn: arn(n),
          personId: id(n),
          // The name the directory reads for the person's subject (the reverse lookup names it by their id here).
          displayName: `Name ${id(n)}`,
          account: pool ? 'pool' : 'other',
          username: pool ? `sub-${n}@x` : null,
          email: pool ? `sub-${n}@x` : '',
          tier: pool ? 'basic' : 'none',
          approved: pool ? 'true' : 'false',
          status: pool ? 'CONFIRMED' : '',
          // From the issuer's own record: the pool account's `Enabled`, and for 14 the other issuer's answer.
          enabled: n !== 9 && n !== 14,
          createdAt: '',
          membershipGroups: [], teams: [],
          // The registry ids their Identities rows carry; nobody here signs in only as a guest.
          issuers: [pool ? ISSUER : OTHER],
          guest: false,
        };
      }),
      {
        personArn: null, personId: null, displayName: null, account: 'pool', username: 'sub-never@x', email: 'sub-never@x',
        tier: 'basic', approved: 'true', status: 'CONFIRMED', enabled: true, createdAt: '', membershipGroups: [], teams: [],
        issuers: [ISSUER], guest: false,
      },
    ];
    expect(users).toEqual(expected);
    // Only the person with no pool account is asked of their issuer: the pool's listing already said.
    expect(accountState.mock.calls).toEqual([[OTHER, 'ext-14']]);
    // Names are read for every person listed.
    expect(users.filter((u: { personId: string | null }) => u.personId).every((u: { displayName: string | null }) => typeof u.displayName === 'string')).toBe(true);
  });

  it('runs the per-person reads concurrently, within the bound', async () => {
    await loadHandler()(get());
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(10);
  });
});
