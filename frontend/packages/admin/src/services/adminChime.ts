import {
  ChimeSDKMessagingClient,
  DeleteChannelMembershipCommand,
  ListChannelMembershipsCommand,
  RedactChannelMessageCommand,
  DeleteChannelMessageCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import type { AdminConversationMember } from '@ae/shared';
import { REGION, CREDENTIAL_EXCHANGE_API_URL, APP_INSTANCE_ARN, exchangeCredentials, trackEvent } from '@ae/shared';

/**
 * ADMIN moderation, performed as the admin's OWN `${sub}-admin` identity, client-side.
 * Each call vends a fresh, channel-scoped, short-lived, audited credential (plane:'admin')
 * via the SAME shared `exchangeCredentials` primitive the chat plane uses (just a
 * different request body), and names the admin ChimeBearer, so the elevated authority
 * never attaches to the chat cred and every action is attributable server-side.
 */

/**
 * Vend an ADMIN-plane credential. The exchange provisions/uses the caller's SEPARATE
 * `${sub}-admin` identity (a standing app-instance-admin), scopes the cred to ONE channel
 * plus the requested capabilities, keeps it short-lived, and records the access
 * server-side (`admin_scoped_credential_vend`). Returns static creds + the admin
 * ChimeBearer ARN to name on the calls. Fetched eagerly (not a refreshing provider)
 * because each admin action is a discrete, immediate operation — the cred is meant to
 * expire, not renew. This is the admin acting as their OWN identity; there is no
 * server-side bearer swap.
 */
async function vendAdminCreds(
  channelArn: string,
  capabilities: string[],
): Promise<{
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: Date };
  adminArn: string;
}> {
  if (!CREDENTIAL_EXCHANGE_API_URL) {
    throw new Error('Admin moderation requires the Credential Exchange (VITE_CREDENTIAL_EXCHANGE_API_URL)');
  }
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  const { credentials, userArn } = await exchangeCredentials(
    { identity: 'admin', channelArn, capabilities },
    idToken,
  );
  return { credentials, adminArn: userArn };
}

/** A short-lived messaging client bound to the admin identity, scoped to one channel. */
async function adminClientFor(
  channelArn: string,
  capabilities: string[],
): Promise<{ client: ChimeSDKMessagingClient; adminArn: string }> {
  const { credentials, adminArn } = await vendAdminCreds(channelArn, capabilities);
  const client = new ChimeSDKMessagingClient({ region: REGION, credentials });
  return { client, adminArn };
}

/** Decode a JWT idToken's payload without verifying the signature (the backend
 *  verifies it) — a minimal base64-url decode, mirroring AuthProvider's
 *  decodeIdToken (not exported from `@ae/shared`, so re-implemented here). */
function decodeIdTokenSub(idToken: string): string {
  const payloadB64 = idToken.split('.')[1] || '';
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  const sub = payload?.sub;
  if (typeof sub !== 'string' || !sub) throw new Error('ID token has no sub claim');
  return sub;
}

/**
 * The operator's own chat-identity ARN, derived from the Cognito ID token's
 * `sub` claim. The admin app never runs `chimeService.initialize` (it has no
 * chat messaging client), so unlike the chat app it cannot read a cached
 * `this.userArn` — it decodes the token it already holds instead.
 */
function ownChatUserArn(): string {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  const sub = decodeIdTokenSub(idToken);
  return `${APP_INSTANCE_ARN}/user/${sub}`;
}

export async function adminRedactMessage(channelArn: string, messageId: string): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, ['redact']);
  await client.send(new RedactChannelMessageCommand({ ChannelArn: channelArn, MessageId: messageId, ChimeBearer: adminArn }));
  trackEvent('admin_message_redacted', { channelArn });
}

export async function adminDeleteMessage(channelArn: string, messageId: string): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, ['delete']);
  await client.send(new DeleteChannelMessageCommand({ ChannelArn: channelArn, MessageId: messageId, ChimeBearer: adminArn }));
  trackEvent('admin_message_deleted', { channelArn });
}

export async function adminRemoveMember(channelArn: string, memberArn: string): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, ['manage-membership']);
  await client.send(new DeleteChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: memberArn, ChimeBearer: adminArn }));
  trackEvent('admin_member_removed', { channelArn });
}

/** List a channel's live members as the admin identity (scoped, audited view). */
export async function adminListMembers(channelArn: string): Promise<AdminConversationMember[]> {
  const { client, adminArn } = await adminClientFor(channelArn, ['view']);
  const response = await client.send(new ListChannelMembershipsCommand({
    ChannelArn: channelArn, ChimeBearer: adminArn, MaxResults: 50,
  }));
  return (response.ChannelMemberships || []).map((m) => {
    const memberArn = m.Member?.Arn || '';
    return {
      memberArn,
      name: m.Member?.Name || 'Unknown',
      type: 'DEFAULT' as const,
      isBot: memberArn.includes('/bot/'),
    };
  });
}

export async function adminAddMember(
  channelArn: string,
  memberArn: string,
  type: 'DEFAULT' | 'HIDDEN' = 'DEFAULT',
  moderator = false,
): Promise<void> {
  const { client, adminArn } = await adminClientFor(channelArn, ['manage-membership']);
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
 * Unlike the chat app's `chimeService.adminAddSelf` (which used to read the
 * cached `this.userArn` set by `chimeService.initialize`), the admin app never
 * initializes a chat messaging client — there is no chat plane running here.
 * `ownChatUserArn()` derives the same `${APP_INSTANCE_ARN}/user/${sub}` ARN
 * directly from the ID token's `sub` claim instead.
 */
export async function adminAddSelf(channelArn: string, type: 'DEFAULT' | 'HIDDEN' = 'HIDDEN', moderator = false): Promise<void> {
  await adminAddMember(channelArn, ownChatUserArn(), type, moderator);
}
