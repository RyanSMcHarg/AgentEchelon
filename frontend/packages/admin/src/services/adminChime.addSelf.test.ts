/**
 * "ADD ME" ADDS THE PERSON THE EXCHANGE RESOLVED, NOT AN ARN BUILT FROM THE TOKEN.
 *
 * The admin app runs no chat client, so it used to decode its ID token and build
 * `${APP_INSTANCE_ARN}/user/${sub}` - an AppInstanceUser that does not exist once the exchange mints
 * the person's id. The member added is now the ARN `resolvePersonIdentity` returns.
 */
import { describe, it, expect, vi } from 'vitest';

const INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/i';
const CHANNEL = `${INSTANCE}/channel/c1`;
const PERSON_ARN = `${INSTANCE}/user/0192f3a4-5b6c-7d8e-9f01-23456789abcd`;
const ADMIN_TWIN = `${INSTANCE}/user/0192f3a4-5b6c-7d8e-9f01-23456789abcd-admin`;

const { send, resolvePersonIdentity } = vi.hoisted(() => ({
  send: vi.fn(),
  resolvePersonIdentity: vi.fn(),
}));

vi.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  const command = (name: string) => class { name = name; input: unknown; constructor(input: unknown) { this.input = input; } };
  return {
    ChimeSDKMessagingClient: class { send = send; },
    DeleteChannelMembershipCommand: command('DeleteChannelMembership'),
    DeleteChannelCommand: command('DeleteChannel'),
    ListChannelMembershipsCommand: command('ListChannelMemberships'),
    RedactChannelMessageCommand: command('RedactChannelMessage'),
    DeleteChannelMessageCommand: command('DeleteChannelMessage'),
    CreateChannelMembershipCommand: command('CreateChannelMembership'),
    CreateChannelModeratorCommand: command('CreateChannelModerator'),
  };
});
vi.mock('@ae/shared', () => ({
  REGION: 'us-east-1',
  trackEvent: () => {},
  isAssistantArn: (arn: string) => arn.includes('/bot/'),
  ensureFreshIdToken: async () => 'id-token',
  resolvePersonIdentity,
}));
vi.mock('./sigv4Fetch', () => ({
  vendAdminCapability: async () => ({
    credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' },
    userArn: ADMIN_TWIN,
  }),
}));
vi.mock('./adminReason', () => ({ reasonFor: async () => 'observing' }));

import { adminAddSelf } from './adminChime';

describe('adminAddSelf', () => {
  it('adds the ARN the exchange resolved the sign-in to, acting as the admin twin', async () => {
    resolvePersonIdentity.mockResolvedValue({ userArn: PERSON_ARN, personId: 'x', consoleRole: 'admins' });
    send.mockResolvedValue({});

    await adminAddSelf(CHANNEL);

    expect(resolvePersonIdentity).toHaveBeenCalledWith('id-token');
    const create = send.mock.calls.map((c) => c[0]).find((c) => c.name === 'CreateChannelMembership');
    expect(create.input).toMatchObject({ ChannelArn: CHANNEL, MemberArn: PERSON_ARN, ChimeBearer: ADMIN_TWIN });
  });
});
