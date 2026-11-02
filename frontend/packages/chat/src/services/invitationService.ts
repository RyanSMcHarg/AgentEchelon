/**
 * Invitations into a conversation (M-10): issue one, see the ones this person issued (all of them, for a
 * moderator), and revoke one. The routes are on the person API (`backend/lambda/src/invitations.ts`).
 *
 * An invitation names its invitee by the AppInstanceUser minted for it, never by an address: the address
 * given here is where the one invitation email goes, and it is stored nowhere. When no email carried the
 * invitation, the answer carries its link, for this person to pass on: the link is the credential.
 */
import { personUrl } from '@ae/shared';

export type RedemptionMode = 'sign-in' | 'link';

export interface InvitationView {
  invitationId: string;
  channelArn: string;
  inviteeArn: string;
  inviteeName: string;
  inviterArn: string;
  inviterName: string;
  mode: RedemptionMode;
  classification: string;
  status: 'pending' | 'redeemed' | 'expired' | 'revoked';
  createdAt: string;
  /** Epoch seconds. */
  expiresAt: number;
  redeemedAt?: number;
  revokedAt?: number;
  emailed: boolean;
}

export interface IssuedInvitation {
  invitation: InvitationView;
  emailed: boolean;
  /** Present only when no email carried the invitation. */
  link?: string;
}

/** A refusal the server named, so the dialog shows its own localized sentence for it (tenet D11). */
export class InvitationRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'InvitationRequestError';
    this.code = code;
    this.status = status;
  }
}

function idToken(): string {
  const token = localStorage.getItem('idToken');
  if (!token) throw new InvitationRequestError('UNAUTHENTICATED', 401, 'Not authenticated');
  return token;
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken()}`, ...(init.headers ?? {}) },
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) throw new InvitationRequestError(String(body.code || 'UNKNOWN'), resp.status, String(body.error || `HTTP ${resp.status}`));
  return body as T;
}

export function issueInvitation(input: { channelArn: string; name: string; email?: string; mode?: RedemptionMode }): Promise<IssuedInvitation> {
  return call<IssuedInvitation>(personUrl('/invitations'), { method: 'POST', body: JSON.stringify(input) });
}

export async function listInvitations(channelArn: string): Promise<{ invitations: InvitationView[]; moderator: boolean }> {
  return call(personUrl(`/invitations?channelArn=${encodeURIComponent(channelArn)}`), { method: 'GET' });
}

export async function revokeInvitation(channelArn: string, invitationId: string): Promise<InvitationView> {
  const answer = await call<{ invitation: InvitationView }>(personUrl('/invitations/revoke'), {
    method: 'POST',
    body: JSON.stringify({ channelArn, invitationId }),
  });
  return answer.invitation;
}
