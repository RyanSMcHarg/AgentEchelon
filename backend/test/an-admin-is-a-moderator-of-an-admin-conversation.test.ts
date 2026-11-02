/**
 * AN ADMIN IS A MODERATOR OF AN ADMIN CONVERSATION, AND A DEMOTED ONE STOPS BEING ONE.
 *
 * THE FAILURE THIS EXISTS FOR. The sync added every current admin to each admin conversation as a
 * plain `DEFAULT` member and granted moderation to nobody, so the admin assistant's bot was the only
 * moderator those channels had. Moderation is what decides who may rename, archive or redact inside a
 * channel, so the humans in an admin channel could do none of it: a channel whose only moderator is a
 * bot has no person who can administer it, and nothing failed to say so.
 *
 * AND THE REMOVAL IS WHAT BOUNDS IT. The property under test is an END STATE: after a run, the humans
 * who moderate an admin conversation are exactly its current admins. It is asserted that way on
 * purpose, because whether `DeleteChannelMembership` also clears a `ChannelModerator` record is not
 * stated by the Amazon Chime SDK API reference in either direction. An earlier version of this file
 * asserted that it does not, which was an unverified claim about the service dressed up as the reason
 * for the code. The reconcile does not depend on the answer: it reads the moderator list and
 * converges it, so if the service cascades the revoke is a no-op and if it does not the revoke is
 * what closes the gap. A dropped event or a failed delete needs the same sweep regardless.
 *
 * WHAT IT DOES NOT CLAIM. That moderation is enforced - Amazon Chime SDK enforces that, and these are
 * assertions about which calls the reconcile makes. Nor that this elevates anything beyond the
 * channel: moderation is channel-scoped (SPEC-MODERATION), and cross-channel administration stays on
 * the separate `${sub}-admin` plane, which this path never touches.
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
const CHANNEL = `${APP}/channel/c1`;
const SERVICE_ADMIN = `${APP}/user/agent-echelon-admin`;
const AGENT_BOT = `${APP}/bot/admin-agent`;
const STAYS = '11111111-0000-4000-8000-00000000aaaa'; // an admin, before and after
const DEMOTED = '22222222-0000-4000-8000-00000000bbbb'; // was an admin, no longer

const arnOf = (sub: string) => `${APP}/user/${sub}`;

/** Calls of one mocked command class, by the `__t` tag the mock stamps on it. */
const callsOf = (tag: string) => mockChimeSend.mock.calls
  .map(([cmd]) => cmd as { __t: string; input: Record<string, unknown> })
  .filter((cmd) => cmd.__t === tag)
  .map((cmd) => cmd.input);

/**
 * Run the reconcile with `admins` as the current admin group, and the channel already holding
 * `members` and `moderators`. Imported inside the helper so the env is set before module load.
 */
async function reconcile(opts: {
  admins: string[];
  members: string[];
  moderators: string[];
  /** In the group, but disabled in the directory. */
  disabled?: string[];
}): Promise<void> {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.AWS_REGION = 'us-east-1';
  process.env.USER_POOL_ID = 'pool';
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ADMIN_CONVERSATION_ARNS = CHANNEL;

  mockSsmSend.mockResolvedValue({ Parameter: { Value: SERVICE_ADMIN } });
  mockCognitoSend.mockResolvedValue({
    Users: [
      ...opts.admins.map((sub) => ({ Attributes: [{ Name: 'sub', Value: sub }] })),
      ...(opts.disabled ?? []).map((sub) => ({ Enabled: false, Attributes: [{ Name: 'sub', Value: sub }] })),
    ],
  });
  mockIdentitySend.mockResolvedValue({ AppInstanceAdmins: [] });
  mockChimeSend.mockImplementation((cmd: { __t: string }) => {
    if (cmd.__t === 'ListMemberships') {
      return Promise.resolve({
        ChannelMemberships: opts.members.map((arn) => ({ Member: { Arn: arn } })),
      });
    }
    if (cmd.__t === 'ListModerators') {
      return Promise.resolve({
        ChannelModerators: opts.moderators.map((arn) => ({ Moderator: { Arn: arn } })),
      });
    }
    return Promise.resolve({});
  });

  const mod = await import('../lambda/src/admin-conversation-sync');
  await mod.handler();
}

describe('the admin conversation reconcile', () => {
  it('makes a current admin a moderator, not merely a member', async () => {
    await reconcile({ admins: [STAYS], members: [], moderators: [AGENT_BOT] });

    expect(callsOf('CreateMembership')).toEqual([
      expect.objectContaining({ ChannelArn: CHANNEL, MemberArn: arnOf(STAYS) }),
    ]);
    expect(callsOf('CreateModerator')).toEqual([
      expect.objectContaining({ ChannelArn: CHANNEL, ChannelModeratorArn: arnOf(STAYS) }),
    ]);
  });

  it('grants moderation to an admin who is already a member, so an existing deployment heals', async () => {
    // The case a deployment upgrading into this behavior is in: the roster is already right and
    // nobody human moderates. Driving the grant off the membership list alone would skip it.
    await reconcile({ admins: [STAYS], members: [arnOf(STAYS)], moderators: [AGENT_BOT] });

    expect(callsOf('CreateMembership')).toEqual([]);
    expect(callsOf('CreateModerator')).toEqual([
      expect.objectContaining({ ChannelModeratorArn: arnOf(STAYS) }),
    ]);
  });

  it('treats a disabled admin as gone: a disabled user stays in the group, and must still lose membership and the moderator role', async () => {
    await reconcile({
      admins: [STAYS], disabled: [DEMOTED],
      members: [arnOf(STAYS), arnOf(DEMOTED)], moderators: [arnOf(STAYS), arnOf(DEMOTED)],
    });

    expect(callsOf('DeleteMembership')).toEqual([
      expect.objectContaining({ ChannelArn: CHANNEL, MemberArn: arnOf(DEMOTED) }),
    ]);
    expect(callsOf('DeleteModerator')).toEqual([
      expect.objectContaining({ ChannelModeratorArn: arnOf(DEMOTED) }),
    ]);
    expect(callsOf('CreateMembership')).toEqual([]);
  });

  it('asks for nothing when the admin already moderates', async () => {
    await reconcile({ admins: [STAYS], members: [arnOf(STAYS)], moderators: [arnOf(STAYS)] });

    expect(callsOf('CreateMembership')).toEqual([]);
    expect(callsOf('CreateModerator')).toEqual([]);
    expect(callsOf('DeleteModerator')).toEqual([]);
  });

  it('revokes moderation from a demoted admin as well as their membership', async () => {
    await reconcile({
      admins: [STAYS],
      members: [arnOf(STAYS), arnOf(DEMOTED)],
      moderators: [arnOf(STAYS), arnOf(DEMOTED), AGENT_BOT],
    });

    expect(callsOf('DeleteMembership')).toEqual([
      expect.objectContaining({ MemberArn: arnOf(DEMOTED) }),
    ]);
    expect(callsOf('DeleteModerator')).toEqual([
      expect.objectContaining({ ChannelModeratorArn: arnOf(DEMOTED) }),
    ]);
  });

  it('revokes moderation from someone who moderates without being a member', async () => {
    // Not a claim that the service produces this state - it is a state the reconcile must handle if
    // it is ever observed, whether from a failed delete, a dropped event, or a moderator granted out
    // of band. Reconciling from the membership list alone would miss it, which is why the moderator
    // list is read separately.
    await reconcile({ admins: [STAYS], members: [arnOf(STAYS)], moderators: [arnOf(DEMOTED)] });

    expect(callsOf('DeleteMembership')).toEqual([]);
    expect(callsOf('DeleteModerator')).toEqual([
      expect.objectContaining({ ChannelModeratorArn: arnOf(DEMOTED) }),
    ]);
  });

  it('never touches the admin assistant bot, in either direction', async () => {
    // The bot owns the channel and is its moderator by design (DESIGN-ADMIN-AGENT-NOTIFICATIONS).
    // It is not in the admin group, so a reconcile that filtered by group rather than by identity
    // shape would revoke the one moderator that must keep it.
    await reconcile({ admins: [STAYS], members: [AGENT_BOT], moderators: [AGENT_BOT] });

    const touched = [
      ...callsOf('DeleteMembership').map((i) => i.MemberArn),
      ...callsOf('DeleteModerator').map((i) => i.ChannelModeratorArn),
      ...callsOf('CreateModerator').map((i) => i.ChannelModeratorArn),
    ];
    expect(touched).not.toContain(AGENT_BOT);
  });
});
