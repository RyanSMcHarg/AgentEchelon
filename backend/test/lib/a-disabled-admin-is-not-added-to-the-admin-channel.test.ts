/**
 * A DISABLED ADMIN IS NOT ADDED TO THE ADMIN NOTIFICATION CHANNEL.
 *
 * The channel carries every security finding. Its roster is the admins group's ENABLED members, as the
 * people they sign in as (`Directory.personsInGroup`); disabling an administrator in the directory has to
 * keep them out of it. The provisioner used to add every member of the group, `Enabled` unread, so a
 * disabled admin was re-added on every deploy.
 *
 * Driven through the real provisioner and the real directory, with the pool and `Identities` faked.
 */
const mockChime = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  const tagged = (t: string) => class { __t = t; constructor(public input: any) {} };
  return {
    ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => mockChime(...a) })),
    CreateChannelCommand: tagged('CreateChannel'),
    CreateChannelModeratorCommand: tagged('CreateModerator'),
    DeleteChannelMembershipCommand: tagged('DeleteMembership'),
    DescribeChannelCommand: tagged('DescribeChannel'),
    TagResourceCommand: tagged('TagResource'),
    CreateChannelMembershipCommand: tagged('CreateMembership'),
    UpdateChannelCommand: tagged('UpdateChannel'),
    DeleteChannelCommand: tagged('DeleteChannel'),
    ListTagsForResourceCommand: tagged('ListTags'),
  };
});

// The room's primary is resolved through the one resolver every creator uses; its reads are not this file's subject.
jest.mock('../../lambda/src/lib/conversation-primary', () => ({
  ...jest.requireActual('../../lambda/src/lib/conversation-primary'),
  primaryTagFor: async () => ({ Key: 'primaryAssistant', Value: 'admin-agent' }),
}));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
process.env.APP_INSTANCE_ARN = APP;
process.env.ADMIN_BEARER_ARN = `${APP}/user/ae-admin`;
process.env.ADMIN_AGENT_BOT_ARN = `${APP}/bot/admin-agent`;
process.env.USER_POOL_ID = 'us-east-1_pool';

import { poolIssuer, testDirectory } from '../helpers/directory';

const user = (sub: string, enabled: boolean) => ({ Username: `${sub}@example.com`, Enabled: enabled, Attributes: [{ Name: 'sub', Value: sub }] });

function directory() {
  const client = {
    send: async () => ({ Users: [user('enabled-admin', true), user('disabled-admin', false), user('never-signed-in', true)] }),
  };
  const people: Record<string, string> = {
    'enabled-admin': `${APP}/user/0192f0e0-0000-7000-8000-0000000000e1`,
    'disabled-admin': `${APP}/user/0192f0e0-0000-7000-8000-0000000000d1`,
  };
  return testDirectory({
    appInstanceArn: APP,
    issuers: [{ issuer: poolIssuer('deployment', 'us-east-1_pool'), client }],
    identities: { resolve: async (_iss, sub) => people[sub] ?? null, subjectsOf: async () => [] },
  });
}

/**
 * A STAFF POOL BESIDE THE DEPLOYMENT'S OWN (C2): a second cognito-pool declaring `admin: true`. Its admins
 * are asked of its own directory, with its own admin group, and sit in the admin rooms beside the
 * deployment pool's. A pool that does not declare `admin: true` contributes nobody, whatever its groups.
 */
function withStaffPool() {
  const asked: string[] = [];
  const pool = (name: string, members: Record<string, Array<ReturnType<typeof user>>>) => ({
    send: async (cmd: { input: { GroupName: string } }) => {
      asked.push(`${name}:${cmd.input.GroupName}`);
      return { Users: members[cmd.input.GroupName] ?? [] };
    },
  });
  const people: Record<string, string> = {
    'deployment|home-admin': `${APP}/user/0192f0e0-0000-7000-8000-0000000000a1`,
    'staff|staff-admin': `${APP}/user/0192f0e0-0000-7000-8000-0000000000a2`,
    'partner|partner-admin': `${APP}/user/0192f0e0-0000-7000-8000-0000000000a3`,
  };
  const directory = testDirectory({
    appInstanceArn: APP,
    issuers: [
      { issuer: poolIssuer('deployment', 'us-east-1_pool'), client: pool('home', { admins: [user('home-admin', true)] }) },
      { issuer: poolIssuer('staff', 'us-east-1_staff', { admin: true, adminGroups: ['operators'] }), client: pool('staff', { operators: [user('staff-admin', true)] }) },
      { issuer: poolIssuer('partner', 'us-east-1_partner', { admin: false }), client: pool('partner', { admins: [user('partner-admin', true)] }) },
    ],
    identities: { resolve: async (iss, sub) => people[`${iss}|${sub}`] ?? null, subjectsOf: async () => [] },
  });
  return { directory, asked };
}

describe('the admin notification channel roster', () => {
  it('keeps a staff-pool admin in the admin room, asked of the staff pool with its own admin group', async () => {
    const { listAdminUserArns } = await import('../../lambda/src/admin-notification-channel-provision');
    const { directory, asked } = withStaffPool();
    const arns = await listAdminUserArns(directory);
    expect(arns.sort()).toEqual([`${APP}/user/0192f0e0-0000-7000-8000-0000000000a1`, `${APP}/user/0192f0e0-0000-7000-8000-0000000000a2`]);
    // A pool that does not declare `admin: true` is never asked for admins.
    expect(asked.sort()).toEqual(['home:admins', 'staff:operators']);
  });

  it('names the enabled admins who have signed in, and never a disabled one', async () => {
    const { listAdminUserArns } = await import('../../lambda/src/admin-notification-channel-provision');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const arns = await listAdminUserArns(directory());
    log.mockRestore();
    expect(arns).toEqual([`${APP}/user/0192f0e0-0000-7000-8000-0000000000e1`]);
  });

  it('adds only those people when it provisions the channel', async () => {
    jest.resetModules();
    const ms = await import('../../lambda/src/lib/membership-source');
    ms.__setDefaultDirectoryForTests(directory());
    mockChime.mockReset().mockImplementation(async (cmd: { __t: string }) =>
      (cmd.__t === 'CreateChannel' ? { ChannelArn: `${APP}/channel/admin` } : {}));
    const { handler } = await import('../../lambda/src/admin-notification-channel-provision');
    const quiet = [jest.spyOn(console, 'log').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {})];
    await handler({ RequestType: 'Create', ResourceProperties: {} } as never);
    quiet.forEach((s) => s.mockRestore());
    const added = mockChime.mock.calls.map(([c]) => c).filter((c) => c.__t === 'CreateMembership').map((c) => c.input.MemberArn);
    expect(added).toEqual([`${APP}/user/0192f0e0-0000-7000-8000-0000000000e1`]);
    expect(added.join(' ')).not.toContain('0000000000d1');
  });
});
