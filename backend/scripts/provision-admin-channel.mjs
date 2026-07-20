/**
 * provision-admin-channel.mjs — manually provision the "Admin Notifications" channel WITHOUT a CDK
 * deploy. Runs the same work as the AdminNotificationStack custom resource
 * (backend/lambda/src/admin-notification-channel-provision.ts) as a one-off, against the live instance,
 * using your local AWS credentials.
 *
 * Idempotent: reuses an existing "Admin Notifications" channel if one exists; re-adding a member is a
 * no-op (ConflictException swallowed). Safe to re-run.
 *
 * Usage (from backend/, so the @aws-sdk deps resolve):
 *   AWS_REGION=us-east-1 node scripts/provision-admin-channel.mjs
 * Env overrides: AE_SSM_ROOT (default /agent-echelon), ADMIN_GROUP_NAME (default admins),
 *   STACK_PREFIX (default AgentEchelon).
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import {
  ChimeSDKMessagingClient,
  ListChannelsCommand,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  UpdateChannelCommand,
  ListChannelMembershipsCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { randomUUID } from 'node:crypto';

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const SSM_ROOT = process.env.AE_SSM_ROOT || '/agent-echelon';
const ADMIN_GROUP = process.env.ADMIN_GROUP_NAME || 'admins';
const STACK_PREFIX = process.env.STACK_PREFIX || 'AgentEchelon';
const CHANNEL_NAME = 'Admin Notifications';

const ssm = new SSMClient({ region });
const cfn = new CloudFormationClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });
const chime = new ChimeSDKMessagingClient({ region });

async function getSsm(name) {
  const r = await ssm.send(new GetParameterCommand({ Name: name }));
  return r.Parameter?.Value || '';
}

async function findUserPoolId() {
  const r = await cfn.send(new DescribeStacksCommand({}));
  for (const s of r.Stacks || []) {
    if (!s.StackName?.startsWith(STACK_PREFIX)) continue;
    for (const o of s.Outputs || []) if (o.OutputKey === 'UserPoolId') return o.OutputValue;
  }
  throw new Error(`UserPoolId output not found on any ${STACK_PREFIX}* stack`);
}

async function main() {
  const adminArn = await getSsm(`${SSM_ROOT}/app-instance-admin-arn`);
  if (!adminArn) throw new Error(`No admin ARN at ${SSM_ROOT}/app-instance-admin-arn — is the instance deployed?`);
  const appInstanceArn = adminArn.split('/user/')[0];
  const userPoolId = await findUserPoolId();
  console.log('region        :', region);
  console.log('app-instance  :', appInstanceArn);
  console.log('admin bearer  :', adminArn);
  console.log('user pool     :', userPoolId);

  // 1) Resolve the admins group -> AppInstanceUser ARNs.
  const adminArns = [];
  let nt;
  do {
    const resp = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: ADMIN_GROUP, NextToken: nt }));
    for (const u of resp.Users || []) {
      const sub = (u.Attributes || []).find((a) => a.Name === 'sub')?.Value;
      if (sub) adminArns.push(`${appInstanceArn}/user/${sub}`);
    }
    nt = resp.NextToken;
  } while (nt);
  console.log(`admins in '${ADMIN_GROUP}':`, adminArns.length);
  if (!adminArns.length) console.warn("  WARNING: no members in the admins group — the channel will have no recipients.");

  // 2) Find or create the channel (idempotent).
  let channelArn = '';
  let listNt;
  do {
    const lc = await chime.send(new ListChannelsCommand({ AppInstanceArn: appInstanceArn, ChimeBearer: adminArn, MaxResults: 50, NextToken: listNt }));
    for (const c of lc.Channels || []) if (c.Name === CHANNEL_NAME) { channelArn = c.ChannelArn; break; }
    listNt = channelArn ? undefined : lc.NextToken;
  } while (listNt);

  if (channelArn) {
    console.log('reusing channel:', channelArn);
  } else {
    const created = await chime.send(new CreateChannelCommand({
      AppInstanceArn: appInstanceArn, Name: CHANNEL_NAME, Mode: 'RESTRICTED', Privacy: 'PRIVATE',
      ChimeBearer: adminArn, ClientRequestToken: randomUUID(), Metadata: JSON.stringify({ kind: 'admin-notifications' }),
    }));
    channelArn = created.ChannelArn;
    console.log('created channel:', channelArn);
  }

  // 3) Add each admin as a member (no-op if already a member).
  for (const memberArn of adminArns) {
    try {
      await chime.send(new CreateChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: memberArn, Type: 'DEFAULT', ChimeBearer: adminArn }));
      console.log('  + member', memberArn);
    } catch (e) {
      console.log('  ~ member', memberArn, `(${e.name})`);
    }
  }

  // 4) Stamp the participant roster — the email fan-out reads recipients from Metadata.participants,
  //    NOT raw membership (lib/channel-notify.ts). Without this the email leg reaches no one.
  await chime.send(new UpdateChannelCommand({
    ChannelArn: channelArn, Name: CHANNEL_NAME, Mode: 'RESTRICTED',
    Metadata: JSON.stringify({ kind: 'admin-notifications', participants: adminArns.map((a) => ({ sub: a.split('/user/').pop() })) }),
    ChimeBearer: adminArn,
  }));
  console.log('roster stamped.');

  // 5) Verify.
  const mem = await chime.send(new ListChannelMembershipsCommand({ ChannelArn: channelArn, ChimeBearer: adminArn }));
  console.log('membership count:', (mem.ChannelMemberships || []).length);
  console.log('\nDONE. Admin Notifications channel:');
  console.log('  ' + channelArn);
  console.log('\nWire alerts to it either way:');
  console.log('  - redeploy with  -c enableAdminNotificationChannel=true   (the stack manages it), or');
  console.log('  - pass           -c membershipAuditAlertChannelArn=' + channelArn);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
