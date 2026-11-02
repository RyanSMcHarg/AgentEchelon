import {
  ChimeSDKMessagingClient,
  DeleteChannelMembershipCommand,
  DeleteChannelCommand,
  ListChannelMembershipsCommand,
  RedactChannelMessageCommand,
  DeleteChannelMessageCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import type { AdminConversationMember } from '@ae/shared';
import { REGION, trackEvent, isAssistantArn, ensureFreshIdToken, resolvePersonIdentity } from '@ae/shared';
import { vendAdminCapability } from './sigv4Fetch';
import { reasonFor, type ReasonKind } from './adminReason';

/**
 * ADMIN moderation, performed as the admin's OWN `${personId}-admin` identity, client-side.
 * Each call vends a fresh, channel-scoped, short-lived, audited credential (plane:'admin')
 * via the SAME shared `exchangeCredentials` primitive the chat plane uses (just a
 * different request body), and names the admin ChimeBearer, so the elevated authority
 * never attaches to the chat cred and every action is attributable server-side.
 */

/**
 * Vend an ADMIN-plane credential. The exchange provisions/uses the caller's SEPARATE
 * `${personId}-admin` identity (a standing app-instance-admin), scopes the cred to ONE channel
 * plus the requested capabilities, keeps it short-lived, and records the access
 * server-side (`admin_scoped_credential_vend`). Returns static creds + the admin
 * ChimeBearer ARN to name on the calls. Fetched eagerly (not a refreshing provider)
 * because each admin action is a discrete, immediate operation — the cred is meant to
 * expire, not renew. This is the admin acting as their OWN identity; there is no
 * server-side bearer swap.
 */
async function vendAdminCreds(
  channelArn: string,
  capability: string,
  kind: ReasonKind,
): Promise<{
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date };
  adminArn: string;
}> {
  // The capability's own IAM-authorized route, with the operator's stated reason (FR45, FR51).
  const reason = await reasonFor({ capability, channelArn, kind });
  const { credentials, userArn } = await vendAdminCapability(capability, { channelArn, reason });
  return { credentials, adminArn: userArn };
}

/** A short-lived messaging client bound to the admin identity, scoped to one channel and one capability. */
async function adminClientFor(
  channelArn: string,
  capability: string,
  kind: ReasonKind,
): Promise<{ client: ChimeSDKMessagingClient; adminArn: string }> {
  const { credentials, adminArn } = await vendAdminCreds(channelArn, capability, kind);
  const client = new ChimeSDKMessagingClient({ region: REGION, credentials });
  return { client, adminArn };
}

export async function adminRedactMessage(channelArn: string, messageId: string): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, 'redact', 'change');
  await client.send(new RedactChannelMessageCommand({ ChannelArn: channelArn, MessageId: messageId, ChimeBearer: adminArn }));
  trackEvent('admin_message_redacted', { channelArn });
}

export async function adminDeleteMessage(channelArn: string, messageId: string): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, 'delete', 'change');
  await client.send(new DeleteChannelMessageCommand({ ChannelArn: channelArn, MessageId: messageId, ChimeBearer: adminArn }));
  trackEvent('admin_message_deleted', { channelArn });
}

/**
 * DELETE A WHOLE CONVERSATION (`delete-conversation`): the administration identity, vended for this one
 * conversation with a stated reason, deletes the channel. Its archived history stays in the archive.
 */
export async function adminDeleteConversation(channelArn: string): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, 'delete-conversation', 'change');
  await client.send(new DeleteChannelCommand({ ChannelArn: channelArn, ChimeBearer: adminArn }));
  trackEvent('admin_conversation_deleted', { channelArn });
}

export async function adminRemoveMember(channelArn: string, memberArn: string): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, 'manage-membership', 'change');
  await client.send(new DeleteChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: memberArn, ChimeBearer: adminArn }));
  trackEvent('admin_member_removed', { channelArn });
}

/** List a channel's live members as the admin identity (scoped, audited view). */
export async function adminListMembers(channelArn: string): Promise<AdminConversationMember[]> {
  const { client, adminArn } = await adminClientFor(channelArn, 'view-live-members', 'read');
  const response = await client.send(new ListChannelMembershipsCommand({
    ChannelArn: channelArn, ChimeBearer: adminArn, MaxResults: 50,
  }));
  return (response.ChannelMemberships || []).map((m) => {
    const memberArn = m.Member?.Arn || '';
    return {
      memberArn,
      name: m.Member?.Name || 'Unknown',
      type: 'DEFAULT' as const,
      isBot: isAssistantArn(memberArn),
    };
  });
}

export async function adminAddMember(
  channelArn: string,
  memberArn: string,
  type: 'DEFAULT' | 'HIDDEN' = 'DEFAULT',
  moderator = false,
): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, 'manage-membership', 'change');
  try {
    await client.send(new CreateChannelMembershipCommand({
      ChannelArn: channelArn, MemberArn: memberArn, Type: type, ChimeBearer: adminArn,
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
  }
  if (moderator && type === 'DEFAULT') {
    await client.send(new CreateChannelModeratorCommand({
      ChannelArn: channelArn, ChannelModeratorArn: memberArn, ChimeBearer: adminArn,
    }));
  }
  trackEvent('admin_member_added', { channelArn });
}

/**
 * Add the admin's OWN chat identity to a conversation (to observe or participate).
 *
 * The admin app runs no chat messaging client, so it has no cached chat ARN. The person's ARN is the
 * one the credential exchange resolved their sign-in to (`resolvePersonIdentity`, asked once per
 * session and shared with the AuthProvider). It is never built from the ID token: the exchange mints
 * the AppInstanceUser id, and it is not the token's `sub`.
 */
export async function adminAddSelf(channelArn: string, type: 'DEFAULT' | 'HIDDEN' = 'HIDDEN', moderator = false): Promise<void> {
  const { userArn } = await resolvePersonIdentity(await ensureFreshIdToken());
  await adminAddMember(channelArn, userArn, type, moderator);
}
