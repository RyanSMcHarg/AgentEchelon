import type {
  AdminConversationMember,
  AdminConversationMessage,
  AdminConversationSummary,
  AdminMembershipEvent,
} from '@ae/shared';
import { apiCall } from '@ae/shared';
import {
  adminListMembers,
  adminAddMember,
  adminRemoveMember,
  adminAddSelf,
  adminRedactMessage,
  adminDeleteMessage,
} from './adminChime';

function getApiUrl(): string {
  const url = import.meta.env.VITE_ADMIN_CONVERSATIONS_API_URL;
  if (!url) throw new Error('VITE_ADMIN_CONVERSATIONS_API_URL not configured');
  return url;
}

export async function listAdminConversations(limit = 25, token?: string): Promise<AdminConversationSummary[]> {
  const result = await apiCall<{ conversations?: AdminConversationSummary[] }>(getApiUrl(), '', {
    query: { limit },
    token,
  });
  return result.conversations || [];
}

export async function listAdminConversationMessages(channelArn: string, limit = 100, token?: string): Promise<AdminConversationMessage[]> {
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
