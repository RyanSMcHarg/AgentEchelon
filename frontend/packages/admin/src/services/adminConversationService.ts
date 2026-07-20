import type {
  AdminConversationMember,
  AdminConversationMessage,
  AdminConversationSummary,
  AdminMembershipEvent,
} from '@ae/shared';
import { apiCall, ADMIN_IAM_ENFORCEMENT, CREDENTIAL_EXCHANGE_API_URL, exchangeCredentials } from '@ae/shared';
import {
  adminListMembers,
  adminAddMember,
  adminRemoveMember,
  adminAddSelf,
  adminRedactMessage,
  adminDeleteMessage,
} from './adminChime';
import { identityPoolCredentials, sigv4GetJson } from './sigv4Fetch';

function getApiUrl(): string {
  const url = import.meta.env.VITE_ADMIN_CONVERSATIONS_API_URL;
  if (!url) throw new Error('VITE_ADMIN_CONVERSATIONS_API_URL not configured');
  return url;
}

/**
 * A14: vend a short-lived, audited `execute-api` credential for the message-content
 * read (A2). The exchange assumes the admin-plane role with a session policy scoped to
 * exactly the messages resource and logs an `admin_scoped_credential_vend` line, so
 * "who read this customer's conversation" is attributable. Same shared exchange
 * primitive the moderation plane uses — a different request body.
 */
async function vendMessagesReadCredential(channelArn: string): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}> {
  if (!CREDENTIAL_EXCHANGE_API_URL) {
    throw new Error('Signed message reads require VITE_CREDENTIAL_EXCHANGE_API_URL');
  }
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  const { credentials } = await exchangeCredentials(
    { identity: 'admin', channelArn, capabilities: ['view-messages'] },
    idToken,
  );
  return credentials;
}

export async function listAdminConversations(limit = 25, token?: string): Promise<AdminConversationSummary[]> {
  if (ADMIN_IAM_ENFORCEMENT) {
    // Sign-on plane (view-conversations): the operator's own Identity-Pool creds,
    // which resolve to their group role; the gateway denies a role that omits the resource.
    const creds = await identityPoolCredentials();
    const result = await sigv4GetJson<{ conversations?: AdminConversationSummary[] }>(
      getApiUrl(),
      { limit },
      creds,
    );
    return result.conversations || [];
  }
  const result = await apiCall<{ conversations?: AdminConversationSummary[] }>(getApiUrl(), '', {
    query: { limit },
    token,
  });
  return result.conversations || [];
}

export async function listAdminConversationMessages(channelArn: string, limit = 100, token?: string): Promise<AdminConversationMessage[]> {
  if (ADMIN_IAM_ENFORCEMENT) {
    // Message content (A2) rides the exchange-vended, audited execute-api credential.
    const creds = await vendMessagesReadCredential(channelArn);
    const result = await sigv4GetJson<{ messages?: AdminConversationMessage[] }>(
      `${getApiUrl().replace(/\/$/, '')}/messages`,
      { channelArn, limit },
      creds,
    );
    return result.messages || [];
  }
  const result = await apiCall<{ messages?: AdminConversationMessage[] }>(getApiUrl(), '/messages', {
    query: { channelArn, limit },
    token,
  });
  return result.messages || [];
}

export async function listAdminConversationMembers(channelArn: string): Promise<AdminConversationMember[]> {
  // Live membership read as the admin's own `${sub}-admin` identity (scoped, audited).
  return adminListMembers(channelArn);
}

export async function getAdminMembershipHistory(channelArn: string, token?: string): Promise<AdminMembershipEvent[]> {
  if (ADMIN_IAM_ENFORCEMENT) {
    // Membership history (A4) is on the sign-on plane alongside view-conversations.
    const creds = await identityPoolCredentials();
    const result = await sigv4GetJson<{ history?: AdminMembershipEvent[] }>(
      `${getApiUrl().replace(/\/$/, '')}/membership-history`,
      { channelArn },
      creds,
    );
    return result.history || [];
  }
  const result = await apiCall<{ history?: AdminMembershipEvent[] }>(getApiUrl(), '/membership-history', {
    query: { channelArn },
    token,
  });
  return result.history || [];
}

export async function addAdminMember(channelArn: string, memberArn: string, type: 'DEFAULT' | 'HIDDEN' = 'DEFAULT', moderator = false): Promise<void> {
  // Own-bearer, client-side (plane: admin identity, scoped to this channel, audited).
  await adminAddMember(channelArn, memberArn, type, moderator);
}

export async function removeAdminMember(channelArn: string, memberArn: string): Promise<void> {
  // Client-side, as the admin's OWN `${sub}-admin` identity (plane:'admin' scoped to this
  // channel + audited), not a server-side bearer swap.
  await adminRemoveMember(channelArn, memberArn);
}

export async function addAdminToConversation(channelArn: string, type: 'DEFAULT' | 'HIDDEN', moderator = false): Promise<void> {
  // The admin adds their OWN chat identity, using their own `${sub}-admin` authority.
  await adminAddSelf(channelArn, type, moderator);
}

export async function redactAdminConversationMessage(channelArn: string, messageId: string): Promise<void> {
  // Own-bearer, client-side moderation (plane:'admin', scoped to this channel, audited).
  await adminRedactMessage(channelArn, messageId);
}

export async function deleteAdminConversationMessage(channelArn: string, messageId: string): Promise<void> {
  // Own-bearer, client-side moderation (plane:'admin', scoped to this channel, audited).
  await adminDeleteMessage(channelArn, messageId);
}
