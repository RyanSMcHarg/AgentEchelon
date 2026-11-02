/**
 * A proposal addressed to the signed-in person (ADR-061 decision 8, rule 8): `POST /proposals/apply` on the person API
 * (`backend/lambda/src/proposals-api.ts`). The person is the caller the edge authorizer resolved, so nothing here names
 * whose decision it is; the server applies a proposal only for the person it is addressed to, once, before it expires.
 *
 * Served in the core of every deployment that has member conversations.
 */
import { personUrl } from '@ae/shared';

export type ProposalDecision = 'apply' | 'decline';

/** What a confirmation card is drawn from: the proposal's handle, its op and when it expires (epoch seconds). */
export interface ProposalOnMessage { id: string; op: string; expiresAt: number }

/**
 * THE PROPOSAL A MESSAGE CARRIES, lifted from its Metadata by the one function the live path and the history load
 * both use, so a reload shows the card the live message showed. Anything malformed is no proposal.
 */
export function proposalFromMetadata(metadata: Record<string, unknown>): ProposalOnMessage | undefined {
  const raw = metadata.proposal as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const id = typeof raw.id === 'string' && raw.id.length <= 128 ? raw.id : '';
  const op = typeof raw.op === 'string' ? raw.op : '';
  const expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : NaN;
  return id && op && Number.isFinite(expiresAt) ? { id, op, expiresAt } : undefined;
}

export interface ProposalAnswer {
  applied?: boolean;
  declined?: boolean;
  op?: string;
  /** `send_nudge`: whether the reminder was emailed. */
  sent?: boolean;
  /** `open_conversation`: the conversation it opened. */
  channelArn?: string;
}

/** A refusal the server named, shown in the client's own words (tenet D11). */
export class ProposalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProposalError';
    this.code = code;
  }
}

/** Apply or decline one proposal by the handle its card carries. `address` is a reminder's recipient, used once. */
export async function decideProposal(proposal: string, decision: ProposalDecision, address?: string): Promise<ProposalAnswer> {
  const token = localStorage.getItem('idToken');
  if (!token) throw new ProposalError('UNAUTHENTICATED', 'Not authenticated');
  const resp = await fetch(personUrl('/proposals/apply'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ proposal, decision, ...(address ? { address } : {}) }),
  });
  const body = await resp.json().catch(() => ({})) as ProposalAnswer & { code?: string; error?: string };
  if (!resp.ok) throw new ProposalError(body.code || `HTTP_${resp.status}`, body.error || resp.statusText);
  return body;
}
