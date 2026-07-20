/**
 * Conversation management service — moderator archive, member removal, self-leave.
 *
 * Calls the backend conversation-management Lambda (SPEC-CONVERSATION-ARCHIVE-AND-
 * MEMBERSHIP.md, ADR-017). These are membership mutations a non-admin moderator
 * cannot do on the chat plane, so they go server-side where the moderator check +
 * app-instance-admin bearer live. Never a local-only state change (that would
 * silently not persist, like the old deleteConversation).
 *
 * The routes live on the same API as create-conversation / add-agent, under
 * /conversations/{archive,remove-member,leave}. Prefer an explicit
 * VITE_CONVERSATION_MGMT_API_URL (the /conversations base); otherwise derive it
 * from VITE_CREATE_CONVERSATION_API_URL (same RestApi stage).
 */

function getConversationsBaseUrl(): string {
  const explicit = import.meta.env.VITE_CONVERSATION_MGMT_API_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const create =
    import.meta.env.VITE_CREATE_CONVERSATION_API_URL || import.meta.env.VITE_CREATE_CHANNEL_API_URL;
  if (!create) {
    throw new Error('VITE_CONVERSATION_MGMT_API_URL (or VITE_CREATE_CONVERSATION_API_URL) not configured');
  }
  // Same API stage as create-conversation: swap the trailing resource for /conversations.
  return `${create.replace(/\/create-conversation\/?$/, '')}/conversations`;
}

function getIdToken(): string {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  return idToken;
}

async function post(action: 'archive' | 'remove-member' | 'leave', body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${getConversationsBaseUrl()}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getIdToken()}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(detail.error || `Request failed: ${response.status}`);
  }
}

/** Archive a conversation for everyone (moderator only). Read-only + hidden thereafter. */
export async function archiveConversation(channelArn: string): Promise<void> {
  await post('archive', { channelArn });
}

/** Remove one member from a conversation (moderator only; never the assistant). */
export async function removeConversationMember(channelArn: string, memberArn: string): Promise<void> {
  await post('remove-member', { channelArn, memberArn });
}

/** Leave a conversation (any member; removes only the caller's own membership). */
export async function leaveConversation(channelArn: string): Promise<void> {
  await post('leave', { channelArn });
}
