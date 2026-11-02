import i18n from '@ae/shared/i18n';
import type {
  AdminConversationMember,
  AdminConversationMessage,
  AdminConversationSummary,
  AdminMembershipEvent,
} from '@ae/shared';
import { reasonFor } from './adminReason';
import {
  adminListMembers,
  adminAddMember,
  adminRemoveMember,
  adminAddSelf,
  adminRedactMessage,
  adminDeleteMessage,
  adminDeleteConversation,
} from './adminChime';
import { adminCredentialExchangeConfigured, consoleCredentials, sigv4GetJson, vendAdminCapability, adminRequest } from './sigv4Fetch';
import { ApiError } from '@ae/shared';
import { teamAssistant } from './teamScope';
import { adminApiConfigured, adminUrl } from './adminApi';

/** Throws the named configuration error when `AdminApi` is unconfigured. */
function requireApi(): void {
  if (!adminApiConfigured()) throw new Error(i18n.t('admin.adminConversationService.vite_admin_conversations_api_urlNotConfigured'));
}

const enc = (s: string) => encodeURIComponent(s);

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
  if (!adminCredentialExchangeConfigured()) {
    throw new Error(i18n.t('admin.adminConversationService.signedMessageReadsRequireVite_credential_exchange_api_url'));
  }
  // The capability's own IAM-authorized route, with the reason the conversation was opened for.
  const reason = await reasonFor({ capability: 'view-messages', channelArn, kind: 'read' });
  const { credentials } = await vendAdminCapability('view-messages', { channelArn, reason });
  return credentials;
}

export interface AdminConversationPage {
  conversations: AdminConversationSummary[];
  /** Total matching conversations across all pages (server-side pagination). */
  total: number;
}

// Server-side pagination: fetch ONE page (limit/offset) plus the total match count, so the list scales
// past any single fetch window instead of silently truncating. The backend pushes the caller's
// classification scope into SQL, so the page and total are consistent for scoped admins.
/** `assistant` narrows an admin's list to the conversations that assistant was a member of; a team's route is one assistant's already. */
export async function listAdminConversations(limit = 25, offset = 0, token?: string, assistant?: string | null): Promise<AdminConversationPage> {
  void token;
  // Sign-on plane (view-conversations): the operator's console-session credentials from the credential exchange,
  // which carry their console role; the gateway denies a role that omits the resource.
  requireApi();
  const team = teamAssistant();
  const creds = await consoleCredentials();
  const result = await sigv4GetJson<{ conversations?: AdminConversationSummary[]; total?: number }>(
    // A team member lists only conversations its assistant was a member of, under the team route.
    team
      ? adminUrl('admin-conversations', `/admin/assistants/${enc(team)}/conversations`)
      : adminUrl('admin-conversations', '/admin/conversations'),
    { limit, offset, ...(!team && assistant ? { assistant } : {}) },
    creds,
  );
  return { conversations: result.conversations || [], total: result.total ?? (result.conversations?.length || 0) };
}

/**
 * One conversation by the id a person gave the operator (`find-conversation`, SPEC-ADMIN-CONSOLE FR52).
 *
 * Resolves to null when there is no such conversation in the caller's scope; the server answers a
 * conversation outside the scope exactly as one that does not exist, so null means both.
 */
export async function findAdminConversation(id: string): Promise<AdminConversationSummary | null> {
  requireApi();
  const team = teamAssistant();
  const url = team
    ? adminUrl('admin-conversations', `/admin/assistants/${enc(team)}/conversations/find`)
    : adminUrl('admin-conversations', '/admin/conversations/find');
  const creds = await consoleCredentials();
  try {
    const result = await sigv4GetJson<{ conversation?: AdminConversationSummary }>(url, { id: id.trim() }, creds);
    return result.conversation ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    if (err instanceof ApiError && err.status === 400) throw new Error(i18n.t('admin.conversations.findInvalid'));
    throw err;
  }
}

/**
 * The channel id a conversation ARN ends with - the segment the message route is keyed on.
 *
 * Both callers below send this rather than the ARN, because the route puts it in the path so the
 * vended credential can be scoped to it. The ARN is rebuilt server-side from the app instance.
 */
function channelIdOf(channelArn: string): string {
  return channelArn.split('/').pop() || '';
}

export async function listAdminConversationMessages(channelArn: string, limit = 300, token?: string): Promise<AdminConversationMessage[]> {
  void token;
  // A TEAM MEMBER READS ON ITS ASSISTANT'S ROUTE, with the same stated reason. The handler answers only
  // the turns from while that assistant was a member, and a conversation it was never in as not found.
  requireApi();
  const team = teamAssistant();
  if (team) {
    const reason = await reasonFor({ capability: 'view-messages', channelArn, kind: 'read' });
    const scoped = await sigv4GetJson<{ messages?: AdminConversationMessage[] }>(
      adminUrl('admin-conversations', `/admin/assistants/${enc(team)}/conversations/${enc(channelIdOf(channelArn))}/messages`),
      { limit, reason },
      await consoleCredentials(),
    );
    return scoped.messages || [];
  }
  // Message content rides the exchange-vended, audited execute-api credential, scoped to the one
  // conversation in the PATH (a query parameter is no part of the resource ARN that scoping uses).
  const creds = await vendMessagesReadCredential(channelArn);
  const result = await sigv4GetJson<{ messages?: AdminConversationMessage[] }>(
    adminUrl('admin-conversations', `/admin/conversations/${enc(channelIdOf(channelArn))}/messages`),
    { limit },
    creds,
  );
  return result.messages || [];
}

export async function listAdminConversationMembers(channelArn: string): Promise<AdminConversationMember[]> {
  // Live membership read as the admin's own `${sub}-admin` identity (scoped, audited).
  return adminListMembers(channelArn);
}

export async function getAdminMembershipHistory(channelArn: string, token?: string): Promise<AdminMembershipEvent[]> {
  void token;
  // Membership history is on the sign-on plane alongside view-conversations.
  requireApi();
  const creds = await consoleCredentials();
  const result = await sigv4GetJson<{ history?: AdminMembershipEvent[] }>(
    adminUrl('admin-conversations', '/admin/conversations/membership-history'),
    { channelArn },
    creds,
  );
  return result.history || [];
}

/**
 * WHO the participants of a conversation are, for a caller holding `see-user-identity`.
 *
 * The conversation reads return participant ARNs and never names, so a surface renders the principal id
 * by default and calls this to enrich it. A caller without the capability is REFUSED - 403 at the gateway
 * under IAM enforcement, or by the handler on a Cognito-JWT deployment - and that is an expected answer
 * rather than an error: it returns an empty map, the ids stay on screen, and nothing tells the operator
 * the console is broken.
 *
 * It resolves per conversation rather than per ARN, so one call covers a whole view and the classification
 * scope applies to the same subject the other reads check.
 */
export async function getAdminConversationIdentities(channelArn: string, token?: string): Promise<Record<string, string>> {
  try {
    void token;
    const creds = await consoleCredentials();
    const result = await sigv4GetJson<{ identities?: Record<string, string> }>(
      adminUrl('admin-conversations', '/admin/conversations/identities'),
      { channelArn },
      creds,
    );
    return result.identities || {};
  } catch {
    // A refusal is the designed outcome for a role without the grant, and it is indistinguishable here
    // from the capability simply not being deployed. Either way the ids are already rendered.
    return {};
  }
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

/**
 * ARCHIVE A CONVERSATION FROM THE CONSOLE (`archive-conversation`): the same sequence a moderator's
 * archive runs, on the admin API, with the operator's stated reason. It becomes read-only and its
 * membership is frozen.
 */
export async function archiveAdminConversation(channelArn: string): Promise<void> {
  const reason = await reasonFor({ capability: 'archive-conversation', channelArn, kind: 'change' });
  requireApi();
  await adminRequest('POST', adminUrl('admin-conversations', `/admin/conversations/${enc(channelIdOf(channelArn))}/archive`), { body: { reason } });
}

/** Delete a whole conversation (`delete-conversation`), with a stated reason. */
export async function deleteAdminConversation(channelArn: string): Promise<void> {
  await adminDeleteConversation(channelArn);
}

export async function deleteAdminConversationMessage(channelArn: string, messageId: string): Promise<void> {
  // Own-bearer, client-side moderation (plane:'admin', scoped to this channel, audited).
  await adminDeleteMessage(channelArn, messageId);
}

/** One row of a conversation's de-identified copy (SPEC-ADMIN-CONSOLE FR54). */
export interface CleanConversationRow {
  seq: number;
  kind: 'message' | 'membership';
  occurredAt: string;
  /** `Person N`, or the assistant's name. */
  actor: string;
  actorKind: 'person' | 'assistant';
  action: string | null;
  subject: string | null;
  /** De-identified text; null for a removed message and a membership change. */
  text: string | null;
  /** De-identified first version, when a person edited the message. */
  originalText: string | null;
  state: 'present' | 'redacted' | 'deleted';
}

export interface CleanConversation {
  rows: CleanConversationRow[];
  /** When the copy was last derived; null when the batch has not reached this conversation yet. */
  derivedAt: string | null;
}

/**
 * THE DE-IDENTIFIED COPY OF ONE CONVERSATION (`view-clean-conversations`): what was said, every person a
 * pseudonym and personal data described rather than shown. It asks for a stated reason like a raw read,
 * once per conversation. A team member's read goes to their assistant's route, which bounds it to the
 * periods that assistant was a member.
 */
export async function getCleanConversation(channelArn: string): Promise<CleanConversation> {
  requireApi();
  const reason = await reasonFor({ capability: 'view-clean-conversations', channelArn, kind: 'read' });
  const team = teamAssistant();
  const result = await sigv4GetJson<{ rows?: CleanConversationRow[]; derivedAt?: string | null }>(
    team
      ? adminUrl('admin-conversations', `/admin/assistants/${enc(team)}/conversations/${enc(channelIdOf(channelArn))}/clean`)
      : adminUrl('admin-conversations', `/admin/conversations/${enc(channelIdOf(channelArn))}/clean`),
    { reason },
    await consoleCredentials(),
  );
  return { rows: result.rows || [], derivedAt: result.derivedAt ?? null };
}

/** One invitation into a conversation (M-10), as the console is shown it: never its token, never an address. */
export interface AdminInvitation {
  invitationId: string;
  channelArn: string;
  inviteeArn: string;
  inviteeName: string;
  inviterArn: string;
  inviterName: string;
  mode: 'sign-in' | 'link';
  classification: string;
  status: 'pending' | 'redeemed' | 'expired' | 'revoked';
  createdAt: string;
  /** Epoch seconds. */
  expiresAt: number;
  redeemedAt?: number;
  revokedAt?: number;
  revokedBy?: string;
  emailed: boolean;
}

/** A conversation's invitations, newest first (`view-invitations`). */
export async function listAdminInvitations(channelArn: string): Promise<AdminInvitation[]> {
  requireApi();
  const answer = await adminRequest<{ invitations?: AdminInvitation[] }>('GET',
    adminUrl('admin-conversations', `/admin/conversations/${enc(channelIdOf(channelArn))}/invitations`));
  return answer.invitations ?? [];
}

/** Withdraw one invitation (`revoke-invitations`): the person it named is removed from the conversation. */
export async function revokeAdminInvitation(channelArn: string, invitationId: string): Promise<AdminInvitation> {
  requireApi();
  const answer = await adminRequest<{ invitation: AdminInvitation }>('POST',
    adminUrl('admin-conversations', `/admin/conversations/${enc(channelIdOf(channelArn))}/invitations/${enc(invitationId)}/revoke`));
  return answer.invitation;
}
