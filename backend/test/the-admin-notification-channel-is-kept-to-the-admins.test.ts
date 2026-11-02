/**
 * THE ADMIN NOTIFICATION CHANNEL IS KEPT TO THE ADMINS, AS MEMBERS ONLY.
 *
 * Its provisioner adds the admins it finds when the channel is created. On a fresh deployment that is nobody,
 * because people are provisioned after the stacks, and the channel stayed empty: an alert posted into it
 * reached no one (notification e2e, 2026-10-22). The scheduled sync now reconciles it like an admin
 * conversation, except that it grants no moderation: its creator, the admin assistant, moderates it, and an
 * alert is not something an admin edits.
 */

const mockChimeSend = jest.fn();
const mockCognitoSend = jest.fn();
const mockIdentitySend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => mockChimeSend(...a) })),
  ListChannelMembershipsCommand: class { __t = 'ListMemberships'; constructor(public input: any) {} },
  CreateChannelMembershipCommand: class { __t = 'CreateMembership'; constructor(public input: any) {} },
  DeleteChannelMembershipCommand: class { __t = 'DeleteMembership'; constructor(public input: any) {} },
  ListChannelModeratorsCommand: class { __t = 'ListModerators'; constructor(public input: any) {} },
  CreateChannelModeratorCommand: class { __t = 'CreateModerator'; constructor(public input: any) {} },
  DeleteChannelModeratorCommand: class { __t = 'DeleteModerator'; constructor(public input: any) {} },
  DescribeChannelCommand: class { __t = 'DescribeChannel'; constructor(public input: any) {} },
  UpdateChannelCommand: class { __t = 'UpdateChannel'; constructor(public input: any) {} },
}));
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: (...a: unknown[]) => mockCognitoSend(...a) })),
  ListUsersInGroupCommand: class { __t = 'ListUsersInGroup'; constructor(public input: any) {} },
}));
jest.mock('@aws-sdk/client-chime-sdk-identity', () => ({
  ChimeSDKIdentityClient: jest.fn(() => ({ send: (...a: unknown[]) => mockIdentitySend(...a) })),
  ListAppInstanceAdminsCommand: class { __t = 'ListAppInstanceAdmins'; constructor(public input: any) {} },
  DeleteAppInstanceAdminCommand: class { __t = 'DeleteAppInstanceAdmin'; constructor(public input: any) {} },
  DeleteAppInstanceUserCommand: class { __t = 'DeleteAppInstanceUser'; constructor(public input: any) {} },
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: (...a: unknown[]) => mockSsmSend(...a) })),
  GetParameterCommand: class { __t = 'GetParameter'; constructor(public input: any) {} },
}));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
const NOTIFY = `${APP}/channel/admin-notifications`;
const SERVICE_ADMIN = `${APP}/user/agent-echelon-admin`;
const AGENT_BOT = `${APP}/bot/admin-agent`;
const ADMIN = '11111111-0000-4000-8000-00000000aaaa';
const FORMER = '22222222-0000-4000-8000-00000000bbbb';
const arnOf = (sub: string) => `${APP}/user/${sub}`;
const callsOf = (tag: string) => mockChimeSend.mock.calls
  .map(([cmd]) => cmd as { __t: string; input: Record<string, unknown> })
  .filter((cmd) => cmd.__t === tag)
  .map((cmd) => cmd.input);

async function sync(opts: { admins: string[]; members: string[]; moderators: string[] }): Promise<void> {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.AWS_REGION = 'us-east-1';
  process.env.USER_POOL_ID = 'pool';
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ADMIN_CONVERSATION_ARNS = '';
  process.env.ADMIN_NOTIFICATION_CHANNEL_ARN = NOTIFY;
  mockSsmSend.mockResolvedValue({ Parameter: { Value: SERVICE_ADMIN } });
  mockCognitoSend.mockResolvedValue({ Users: opts.admins.map((sub) => ({ Attributes: [{ Name: 'sub', Value: sub }] })) });
  mockIdentitySend.mockResolvedValue({ AppInstanceAdmins: [] });
  mockChimeSend.mockImplementation((cmd: { __t: string }) => {
    if (cmd.__t === 'ListMemberships') return Promise.resolve({ ChannelMemberships: opts.members.map((arn) => ({ Member: { Arn: arn } })) });
    if (cmd.__t === 'ListModerators') return Promise.resolve({ ChannelModerators: opts.moderators.map((arn) => ({ Moderator: { Arn: arn } })) });
    return Promise.resolve({});
  });
  const mod = await import('../lambda/src/admin-conversation-sync');
  await mod.handler();
}

afterEach(() => { delete process.env.ADMIN_NOTIFICATION_CHANNEL_ARN; });

describe('the admin notification channel', () => {
  it('gains every admin as a member when it was created before any admin existed', async () => {
    await sync({ admins: [ADMIN], members: [AGENT_BOT], moderators: [AGENT_BOT] });
    expect(callsOf('CreateMembership')).toEqual([
      expect.objectContaining({ ChannelArn: NOTIFY, MemberArn: arnOf(ADMIN), ChimeBearer: SERVICE_ADMIN }),
    ]);
  });

  it('makes no admin a moderator of it', async () => {
    await sync({ admins: [ADMIN], members: [], moderators: [AGENT_BOT] });
    expect(callsOf('CreateModerator')).toEqual([]);
  });

  it('removes a person who is no longer an admin, and leaves the admin assistant alone', async () => {
    await sync({ admins: [ADMIN], members: [arnOf(ADMIN), arnOf(FORMER), AGENT_BOT], moderators: [AGENT_BOT] });
    expect(callsOf('DeleteMembership')).toEqual([
      expect.objectContaining({ ChannelArn: NOTIFY, MemberArn: arnOf(FORMER) }),
    ]);
    expect(callsOf('DeleteModerator').map((c) => c.ChannelModeratorArn)).not.toContain(AGENT_BOT);
  });
});
