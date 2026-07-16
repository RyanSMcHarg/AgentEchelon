import type {
  AdminConversationMember,
  AdminConversationMessage,
  AdminConversationSummary,
  AdminMembershipEvent,
} from '../types';
import { chimeService } from './chimeService';

function getApiUrl(): string {
  const url = import.meta.env.VITE_ADMIN_CONVERSATIONS_API_URL;
  if (!url) throw new Error('VITE_ADMIN_CONVERSATIONS_API_URL not configured');
  return url;
}

function getIdToken(): string {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  return idToken;
}

async function apiCall(path = '', init: RequestInit = {}, token?: string) {
  const idToken = token || getIdToken();

  const response = await fetch(`${getApiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

export async function listAdminConversations(limit = 25): Promise<AdminConversationSummary[]> {
  const result = await apiCall(`?limit=${limit}`);
  return result.conversations || [];
}

export async function listAdminConversationMessages(channelArn: string, limit = 100): Promise<AdminConversationMessage[]> {
  const result = await apiCall(`/messages?channelArn=${encodeURIComponent(channelArn)}&limit=${limit}`);
  return result.messages || [];
}

export async function listAdminConversationMembers(channelArn: string): Promise<AdminConversationMember[]> {
  // Live membership read as the admin's own `${sub}-admin` identity (scoped, audited).
  return chimeService.adminListMembers(channelArn);
}

export async function getAdminMembershipHistory(channelArn: string): Promise<AdminMembershipEvent[]> {
  const result = await apiCall(`/membership-history?channelArn=${encodeURIComponent(channelArn)}`);
  return result.history || [];
}

export async function addAdminMember(channelArn: string, memberArn: string, type: 'DEFAULT' | 'HIDDEN' = 'DEFAULT', moderator = false): Promise<void> {
  // Own-bearer, client-side (plane: admin identity, scoped to this channel, audited).
  await chimeService.adminAddMember(channelArn, memberArn, type, moderator);
}

export async function removeAdminMember(channelArn: string, memberArn: string): Promise<void> {
  // Client-side, as the admin's OWN `${sub}-admin` identity (plane:'admin' scoped to this
  // channel + audited), not a server-side bearer swap.
  await chimeService.adminRemoveMember(channelArn, memberArn);
}

export async function addAdminToConversation(channelArn: string, type: 'DEFAULT' | 'HIDDEN', moderator = false): Promise<void> {
  // The admin adds their OWN chat identity, using their own `${sub}-admin` authority.
  await chimeService.adminAddSelf(channelArn, type, moderator);
}

export async function redactAdminConversationMessage(channelArn: string, messageId: string): Promise<void> {
  // Own-bearer, client-side moderation (plane:'admin', scoped to this channel, audited).
  await chimeService.adminRedactMessage(channelArn, messageId);
}

export async function deleteAdminConversationMessage(channelArn: string, messageId: string): Promise<void> {
  // Own-bearer, client-side moderation (plane:'admin', scoped to this channel, audited).
  await chimeService.adminDeleteMessage(channelArn, messageId);
}
