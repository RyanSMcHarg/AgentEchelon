/**
 * Admin conversation membership sync (SPEC-ADMIN-IDENTITY section 8).
 *
 * Runs when the `admins` group changes - a Cognito group event delivered through the platform trail and
 * EventBridge - and on a daily backstop schedule for an event that was dropped (tenet D6: the sweep is the
 * backstop, never the primary mechanism). Resolves the admin set from the Cognito `admins` group and syncs each
 * configured admin conversation's Chime MEMBERSHIP — which is the whole roster; no second copy is
 * written anywhere, and the notification bridge reads membership directly. Runs as the SERVICE
 * app-instance-admin (an automated, no-human path). It also de-provisions
 * app-instance-admin for any human no longer in the admins group (the demotion
 * backstop, so a demoted user loses cross-channel authority even if their last
 * exchange did not drop the elevation).
 */
import { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { reconcileHumans } from './lib/membership-reconcile.js';
import {
  ChimeSDKIdentityClient,
  ListAppInstanceAdminsCommand,
  DeleteAppInstanceAdminCommand,
  DeleteAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ADMIN_ROLE_GROUP, rolesNeedingAdministrationIdentity } from '../../lib/config/admin-capabilities.js';
import { defaultDirectory } from './lib/membership-source.js';
import { chimeMessagingClient, chimeIdentityClient, appInstanceAdminBearer } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const REGION = process.env.AWS_REGION || 'us-east-1';
/**
 * WHO HOLDS THE ADMINISTRATION IDENTITY: the people in a group whose role is granted a capability that
 * needs it (`rolesNeedingAdministrationIdentity`). Separate from the admin issuers' admin groups, who sit in the
 * admin conversations; the identity follows the capability, not that group's name.
 */
const IDENTITY_GROUPS = [...new Set(rolesNeedingAdministrationIdentity().map((r) => ADMIN_ROLE_GROUP[r]))];
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ADMIN_CONVERSATION_ARNS = (process.env.ADMIN_CONVERSATION_ARNS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';
/**
 * THE ADMIN NOTIFICATION CHANNEL, kept to the admins on the same schedule. Its provisioner adds the admins
 * it finds when the channel is created, and on a fresh deployment that is nobody, because people are
 * provisioned after the stacks; without this the channel stays empty and every alert reaches no one.
 * Members only: its creator, the admin assistant, moderates it.
 */
const ADMIN_NOTIFICATION_CHANNEL_ARN = (process.env.ADMIN_NOTIFICATION_CHANNEL_ARN || '').trim();

const messaging = chimeMessagingClient({ region: REGION });
const identity = chimeIdentityClient({ region: REGION });
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

const serviceAdminArn = appInstanceAdminBearer({ ssm, param: ADMIN_ARN_PARAM, onFailure: 'throw' });

/**
 * The groups' ENABLED members, as the people they sign in as (`Directory.personsInGroup`). A disabled
 * user stays in the group, so without the filter disabling an admin would remove nothing - the same rule
 * the group-membership reconcile applies (lib/membership-source.ts). A member who has never signed in
 * has no AppInstanceUser and is in no channel, so leaving them out removes nobody.
 */
async function resolveAdminUserArns(groups?: string[]): Promise<Set<string>> {
  // EVERY ISSUER DECLARING `admin: true` (C2): its admin groups (`adminGroups`, default `admins`), or the
  // groups named, in its own directory. A staff pool's admins sit in the admin rooms beside the
  // deployment pool's.
  return new Set((await defaultDirectory().admins(groups)).persons);
}

/**
 * Sync one admin conversation: its humans become exactly the admins, and every admin moderates it.
 *
 * AN ADMIN IS A MODERATOR OF AN ADMIN CONVERSATION, not merely a member of it. Moderation is
 * channel-scoped (SPEC-MODERATION), so this grants nothing outside this channel and is NOT the chat
 * identity being elevated to cross-channel administration - that stays on the separate `${personId}-admin`
 * plane. Without it the admin assistant bot is the only moderator, and the humans in an admin channel could
 * not rename it, archive it, or redact a message in it.
 *
 * The reconcile itself - humans only, membership as the roster, the measured moderator coupling - is
 * `lib/membership-reconcile.ts`, shared with the group-membership reconcile.
 */
async function syncConversation(
  channelArn: string, adminArns: Set<string>, bearer: string,
  moderators: 'all-allowed' | 'revoke-only' = 'all-allowed',
): Promise<void> {
  const res = await reconcileHumans({ messaging, channelArn, bearer, allowed: adminArns, moderators });
  if (res.added.length || res.removed.length || res.moderatorsRemoved.length) {
    console.log(JSON.stringify({ _auditEvent: 'admin_conversation_membership_change', channelArn, ...res }));
  }
}

/**
 * Demotion + migration backstop. Human admin authority lives on the SEPARATE
 * `${personId}-admin` identity (the two-identity model). Keep an app-instance-admin only when
 * it is a `${personId}-admin` whose human is still in the admins group, plus the service admin.
 * Remove it from everything else: demoted admins (and delete their orphaned `${personId}-admin`
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
      // Delete the orphaned admin identity itself (ONLY a `${personId}-admin` user; never a
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
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (!APP_INSTANCE_ARN) {
    console.warn('[AdminConvSync] APP_INSTANCE_ARN not set; skipping');
    return { ok: false, admins: 0, conversations: 0 };
  }
  const adminArns = await resolveAdminUserArns();

  const bearer = await serviceAdminArn();
  if (bearer) {
    for (const channelArn of ADMIN_CONVERSATION_ARNS) {
      try { await syncConversation(channelArn, adminArns, bearer); }
      catch (e) { console.error('[AdminConvSync] conversation sync failed', channelArn, errDetail(e)); }
    }
    if (ADMIN_NOTIFICATION_CHANNEL_ARN && !ADMIN_CONVERSATION_ARNS.includes(ADMIN_NOTIFICATION_CHANNEL_ARN)) {
      try { await syncConversation(ADMIN_NOTIFICATION_CHANNEL_ARN, adminArns, bearer, 'revoke-only'); }
      catch (e) { console.error('[AdminConvSync] notification channel sync failed', ADMIN_NOTIFICATION_CHANNEL_ARN, errDetail(e)); }
    }
  }
  // The identity follows the capability: its holders are the enabled people in every group whose role
  // needs it, which may differ from who sits in the admin conversations.
  const identityHolders = await resolveAdminUserArns(IDENTITY_GROUPS);
  try { await deprovisionDemotedAdmins(identityHolders); }
  catch (e) { console.error('[AdminConvSync] deprovision sweep failed', errDetail(e)); }

  console.log(JSON.stringify({
    _auditEvent: 'admin_conversation_sync',
    timestamp: new Date().toISOString(),
    admins: adminArns.size,
    conversations: ADMIN_CONVERSATION_ARNS.length,
  }));
  return { ok: true, admins: adminArns.size, conversations: ADMIN_CONVERSATION_ARNS.length };
};
