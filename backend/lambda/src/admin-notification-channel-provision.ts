/**
 * Custom-resource Lambda: provision the ADMIN NOTIFICATION channel (A6).
 *
 * The membership-audit (SPEC-CONVERSATION-SECURITY Layer 6) and admin-error alert paths post
 * findings into an admin conversation (in-app message + email fan-out). Without a channel configured
 * both degrade to log-only. This creates ONE dedicated "Admin Notifications" channel, owned by the
 * service app-instance-admin, adds the `admins` Cognito group as members, and — crucially — stamps
 * them into `Metadata.participants` (the notification fan-out resolves email recipients from the
 * roster, NOT raw channel membership; see lib/channel-notify.ts). Returns the channel ARN, which the
 * stack surfaces so both alert paths post here instead of falling back to log-only.
 *
 * Idempotent: Create makes the channel (PhysicalResourceId = its ARN); Update reuses that ARN and
 * re-syncs the admin roster (picking up admins added since the last deploy). Delete removes it.
 */
import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  UpdateChannelCommand,
  DeleteChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'crypto';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const region = process.env.AWS_REGION || 'us-east-1';
const chime = new ChimeSDKMessagingClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ADMIN_BEARER_ARN = process.env.ADMIN_BEARER_ARN || ''; // the service app-instance-admin
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const ADMIN_GROUP_NAME = process.env.ADMIN_GROUP_NAME || 'admins';
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'Admin Notifications';

/** ARNs of the `admins` group members, mapped to their Chime AppInstanceUser ARN. */
async function listAdminUserArns(): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await cognito.send(new ListUsersInGroupCommand({
      UserPoolId: USER_POOL_ID,
      GroupName: ADMIN_GROUP_NAME,
      NextToken: nextToken,
    }));
    for (const u of resp.Users || []) {
      const sub = (u.Attributes || []).find((a) => a.Name === 'sub')?.Value;
      if (sub) arns.push(`${APP_INSTANCE_ARN}/user/${sub}`);
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return arns;
}

/** Add every admin as a channel member AND stamp the roster into Metadata.participants (the email
 *  fan-out reads recipients from the roster, not membership). Best-effort per member. */
async function syncAdmins(channelArn: string): Promise<number> {
  const adminArns = await listAdminUserArns();
  for (const memberArn of adminArns) {
    try {
      await chime.send(new CreateChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: memberArn,
        Type: 'DEFAULT',
        ChimeBearer: ADMIN_BEARER_ARN,
      }));
    } catch (err) {
      // ConflictException = already a member; any other error is logged and skipped, never fatal.
      console.warn('[AdminNotifChannel] add member skipped:', memberArn, (err as { name?: string }).name);
    }
  }
  try {
    await chime.send(new UpdateChannelCommand({
      ChannelArn: channelArn,
      Name: CHANNEL_NAME,
      Mode: 'RESTRICTED',
      Metadata: JSON.stringify({
        kind: 'admin-notifications',
        participants: adminArns.map((a) => ({ sub: a.split('/user/').pop() })),
      }),
      ChimeBearer: ADMIN_BEARER_ARN,
    }));
  } catch (err) {
    console.warn('[AdminNotifChannel] roster stamp failed:', (err as { name?: string }).name);
  }
  return adminArns.length;
}

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  console.log('[AdminNotifChannel]', event.RequestType, { APP_INSTANCE_ARN, ADMIN_GROUP_NAME });
  if (!APP_INSTANCE_ARN || !ADMIN_BEARER_ARN) {
    throw new Error('APP_INSTANCE_ARN and ADMIN_BEARER_ARN env are required');
  }

  if (event.RequestType === 'Delete') {
    const arn = event.PhysicalResourceId;
    if (arn && arn.includes('/channel/')) {
      try {
        await chime.send(new DeleteChannelCommand({ ChannelArn: arn, ChimeBearer: ADMIN_BEARER_ARN }));
      } catch (err) {
        console.warn('[AdminNotifChannel] delete skipped:', (err as { name?: string }).name);
      }
    }
    return { PhysicalResourceId: arn || 'admin-notifications-none' };
  }

  // Update reuses the existing channel (its ARN is the PhysicalResourceId); Create makes a new one.
  let channelArn = event.RequestType === 'Update' ? event.PhysicalResourceId : '';
  if (!channelArn || !channelArn.includes('/channel/')) {
    const created = await chime.send(new CreateChannelCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      Name: CHANNEL_NAME,
      Mode: 'RESTRICTED',
      Privacy: 'PRIVATE',
      ChimeBearer: ADMIN_BEARER_ARN,
      ClientRequestToken: randomUUID(),
      Metadata: JSON.stringify({ kind: 'admin-notifications' }),
    }));
    channelArn = created.ChannelArn || '';
    if (!channelArn) throw new Error('CreateChannel returned no ARN');
  }

  const count = await syncAdmins(channelArn);
  console.log('[AdminNotifChannel] ready:', channelArn, `(${count} admins)`);
  return { PhysicalResourceId: channelArn, Data: { ChannelArn: channelArn } };
};
