/**
 * Admin conversation membership sync (SPEC-ADMIN-IDENTITY section 8).
 *
 * Scheduled reconcile. Resolves the admin set from the Cognito `admins` group and syncs each
 * configured admin conversation's Chime MEMBERSHIP — which is the whole roster; no second copy is
 * written anywhere, and the notification bridge reads membership directly. Runs as the SERVICE
 * app-instance-admin (an automated, no-human path). It also de-provisions
 * app-instance-admin for any human no longer in the admins group (the demotion
 * backstop, so a demoted user loses cross-channel authority even if their last
 * exchange did not drop the elevation).
 */
import { CognitoIdentityProviderClient, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import {
  ChimeSDKMessagingClient,
  ListChannelMembershipsCommand,
  CreateChannelMembershipCommand,
  DeleteChannelMembershipCommand,
  DescribeChannelCommand,
  UpdateChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  ChimeSDKIdentityClient,
  ListAppInstanceAdminsCommand,
  DeleteAppInstanceAdminCommand,
  DeleteAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const REGION = process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const ADMIN_GROUP = process.env.ADMIN_GROUP_NAME || 'admins';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ADMIN_CONVERSATION_ARNS = (process.env.ADMIN_CONVERSATION_ARNS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const messaging = new ChimeSDKMessagingClient({ region: REGION });
const identity = new ChimeSDKIdentityClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

const errName = (e: unknown): string => (e as { name?: string })?.name || '';

/**
 * Name AND message, for the places that REPORT an error rather than branch on it.
 *
 * `errName` is right for control flow (`!== 'NotFoundException'`), and wrong for a log line: an
 * AccessDeniedException's whole diagnostic value is in its message, which names the principal and the
 * action denied. Logging the name alone produced "deprovision sweep failed AccessDeniedException" on
 * every scheduled run - enough to know something is broken, not enough to know WHAT, and the sweep
 * spans four different API calls. Determining which one required reading IAM policies by hand against
 * the source, and still did not settle it.
 */
const errDetail = (e: unknown): string => {
  const err = e as { name?: string; message?: string };
  return err?.message ? `${err.name || 'Error'}: ${err.message}` : (err?.name || String(e));
};

let cachedAdminArn = '';
async function serviceAdminArn(): Promise<string> {
  if (cachedAdminArn) return cachedAdminArn;
  const r = await ssm.send(new GetParameterCommand({ Name: ADMIN_ARN_PARAM }));
  cachedAdminArn = r.Parameter?.Value || '';
  return cachedAdminArn;
}

/** The `admins` group members, resolved to their app-instance-user ARNs (id == sub). */
async function resolveAdminUserArns(): Promise<Set<string>> {
  const arns = new Set<string>();
  let NextToken: string | undefined;
  do {
    const res = await cognito.send(new ListUsersInGroupCommand({
      UserPoolId: USER_POOL_ID, GroupName: ADMIN_GROUP, NextToken,
    }));
    for (const u of res.Users || []) {
      const sub = (u.Attributes || []).find((a) => a.Name === 'sub')?.Value;
      if (sub) arns.add(`${APP_INSTANCE_ARN}/user/${sub}`);
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return arns;
}

/** Sync one admin conversation: add missing admins and remove humans no longer admins
 *  (bots/assistants are left alone). Membership IS the roster — nothing else is written; see the
 *  note at the end of this function for why the Metadata copy was removed. */
async function syncConversation(channelArn: string, adminArns: Set<string>, bearer: string): Promise<void> {
  const currentHumans = new Set<string>();
  let NextToken: string | undefined;
  do {
    const res = await messaging.send(new ListChannelMembershipsCommand({
      ChannelArn: channelArn, ChimeBearer: bearer, MaxResults: 50, NextToken,
    }));
    for (const m of res.ChannelMemberships || []) {
      const arn = m.Member?.Arn || '';
      if (arn.includes('/user/')) currentHumans.add(arn); // humans only; never touch bots
    }
    NextToken = res.NextToken;
  } while (NextToken);

  for (const arn of adminArns) {
    if (currentHumans.has(arn)) continue;
    try {
      await messaging.send(new CreateChannelMembershipCommand({
        ChannelArn: channelArn, MemberArn: arn, Type: 'DEFAULT', ChimeBearer: bearer,
      }));
    } catch (e) { if (errName(e) !== 'ConflictException') throw e; }
  }
  for (const arn of currentHumans) {
    if (adminArns.has(arn)) continue;
    try {
      await messaging.send(new DeleteChannelMembershipCommand({
        ChannelArn: channelArn, MemberArn: arn, ChimeBearer: bearer,
      }));
    } catch (e) { if (errName(e) !== 'NotFoundException') throw e; }
  }

  // NO Metadata roster refresh. This used to rewrite `Metadata.participants` on every sync so the
  // notification bridge had a recipient list. Both halves of that are now wrong:
  //
  //   - IDENTITY IN METADATA. It wrote every admin's `sub` into a blob readable by every channel
  //     member and writable by any moderator. METADATA-AND-TAGS §1 puts identity on the never list.
  //   - IT WAS A COPY THAT DRIFTED. The membership calls above are the real change; the roster was a
  //     second representation of the same fact, and any sync that updated one and failed the other
  //     left them disagreeing — with the stale copy deciding who got emailed.
  //
  // `channel-notify.ts` now derives recipients from live `ListChannelMemberships`, so the membership
  // work above IS the update. These are native subs (AppInstanceUser id == sub), so no issuer hint is
  // needed either.
}

/**
 * Demotion + migration backstop. Human admin authority lives on the SEPARATE
 * `${sub}-admin` identity (the two-identity model). Keep an app-instance-admin only when
 * it is a `${sub}-admin` whose human is still in the admins group, plus the service admin.
 * Remove it from everything else: demoted admins (and delete their orphaned `${sub}-admin`
 * identity), and any LEGACY elevation left on a bare chat identity `${sub}` (chat
 * identities must never be app-instance-admins).
 */
async function deprovisionDemotedAdmins(adminArns: Set<string>): Promise<void> {
  const serviceAdmin = await serviceAdminArn();
  const ADMIN_SUFFIX = '-admin';
  let NextToken: string | undefined;
  do {
    const res = await identity.send(new ListAppInstanceAdminsCommand({ AppInstanceArn: APP_INSTANCE_ARN, NextToken }));
    for (const a of res.AppInstanceAdmins || []) {
      const arn = a.Admin?.Arn || '';
      if (!arn.includes('/user/') || arn === serviceAdmin) continue; // bots aside; keep the service admin
      const isAdminIdentity = arn.endsWith(ADMIN_SUFFIX);
      // The human this elevation belongs to, as their CHAT identity ARN.
      const humanArn = isAdminIdentity ? arn.slice(0, -ADMIN_SUFFIX.length) : arn;
      if (isAdminIdentity && adminArns.has(humanArn)) continue; // valid, current admin — keep
      try {
        await identity.send(new DeleteAppInstanceAdminCommand({ AppInstanceArn: APP_INSTANCE_ARN, AppInstanceAdminArn: arn }));
      } catch (e) { if (errName(e) !== 'NotFoundException') throw e; }
      // Delete the orphaned admin identity itself (ONLY a `${sub}-admin` user; never a
      // chat identity, which the human still needs for their own participation).
      if (isAdminIdentity) {
        try {
          await identity.send(new DeleteAppInstanceUserCommand({ AppInstanceUserArn: arn }));
        } catch (e) { if (errName(e) !== 'NotFoundException') throw e; }
      }
    }
    NextToken = res.NextToken;
  } while (NextToken);
}

export const handler = async (): Promise<{ ok: boolean; admins: number; conversations: number }> => {
  if (!USER_POOL_ID || !APP_INSTANCE_ARN) {
    console.warn('[AdminConvSync] USER_POOL_ID / APP_INSTANCE_ARN not set; skipping');
    return { ok: false, admins: 0, conversations: 0 };
  }
  const adminArns = await resolveAdminUserArns();

  const bearer = await serviceAdminArn();
  if (bearer) {
    for (const channelArn of ADMIN_CONVERSATION_ARNS) {
      try { await syncConversation(channelArn, adminArns, bearer); }
      catch (e) { console.error('[AdminConvSync] conversation sync failed', channelArn, errDetail(e)); }
    }
  }
  try { await deprovisionDemotedAdmins(adminArns); }
  catch (e) { console.error('[AdminConvSync] deprovision sweep failed', errDetail(e)); }

  console.log(JSON.stringify({
    _auditEvent: 'admin_conversation_sync',
    timestamp: new Date().toISOString(),
    admins: adminArns.size,
    conversations: ADMIN_CONVERSATION_ARNS.length,
  }));
  return { ok: true, admins: adminArns.size, conversations: ADMIN_CONVERSATION_ARNS.length };
};
