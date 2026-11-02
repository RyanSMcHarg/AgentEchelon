/**
 * Conversation management service — moderator archive, member removal, self-leave.
 *
 * Calls the backend conversation-management Lambda (SPEC-CONVERSATION-ARCHIVE-AND-
 * MEMBERSHIP.md, ADR-017). These are membership mutations a non-admin moderator
 * cannot do on the chat plane, so they go server-side where the moderator check +
 * app-instance-admin bearer live. Never a local-only state change (that would
 * silently not persist, like the old deleteConversation).
 *
 * The routes are on the person API (VITE_PERSON_API_URL), under
 * /conversations/{archive,remove-member,leave}.
 */
import { personUrl } from '@ae/shared';

function getIdToken(): string {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  return idToken;
}

async function post(url: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
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
  await post(personUrl('/conversations/archive'), { channelArn });
}

/** Remove one member from a conversation (moderator only; never the assistant). */
export async function removeConversationMember(channelArn: string, memberArn: string): Promise<void> {
  await post(personUrl('/conversations/remove-member'), { channelArn, memberArn });
}

/** Leave a conversation (any member; removes only the caller's own membership). */
export async function leaveConversation(channelArn: string): Promise<void> {
  await post(personUrl('/conversations/leave'), { channelArn });
}
