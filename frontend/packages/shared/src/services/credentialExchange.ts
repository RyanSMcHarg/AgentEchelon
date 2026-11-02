import { personUrl } from '../platform/config';
import { ensureFreshIdToken } from './ensureFreshToken';

/**
 * The Credential Exchange (SPEC-CREDENTIAL-EXCHANGE) is ONE reused primitive:
 * chat, admin, and rename all POST to the same `/exchange-credentials` route
 * on the same instance, differing only in the `identity`/`channelArn`/
 * `capabilities` fields of the request body. This module is the single place
 * that owns the request shape, so every plane vends credentials the same way.
 */

export interface VendedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

/** A console role the exchange can name for the caller. */
export type ConsoleRole = 'admins' | 'team-members';

/** What every exchange answer carries: the credentials, and the identity they were vended for. */
export interface ExchangeAnswer {
  credentials: VendedCredentials;
  /**
   * The AppInstanceUser (or admin twin) ARN the credentials act as. On the chat plane this is the
   * person: an opaque id the exchange minted, never the token's subject.
   */
  userArn: string;
  /** The classification the session asserts (wire name `tier`). */
  tier?: string;
  /** The console role the caller's groups name (null: none), when the exchange reports it. */
  consoleRole?: ConsoleRole | null;
  /** A sign-in redemption only: the conversation the invitation was to, which the person is now in. */
  invitationChannelArn?: string;
  /** A path A bind only: the visit's continuation, the conversation the client opens. */
  bound?: { conversationArn: string };
}

/**
 * The exchange answered with a refusal. `status` is the HTTP status, so a caller can tell a decision
 * (a 4xx: this sign-in is not vended for) from an outage (a 5xx), which does not end a session.
 */
export class ExchangeRefusedError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ExchangeRefusedError';
    this.status = status;
    this.code = code;
  }
}

function exchangeUrl(): string {
  return personUrl('/exchange-credentials');
}

function answerFrom(data: Record<string, any>): ExchangeAnswer {
  const c = data.credentials;
  const role = data.consoleRole;
  return {
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ? new Date(c.Expiration) : undefined,
    },
    userArn: data.userArn,
    ...(typeof data.tier === 'string' ? { tier: data.tier } : {}),
    ...(role === 'admins' || role === 'team-members' || role === null ? { consoleRole: role } : {}),
    ...(typeof data.invitation?.channelArn === 'string' ? { invitationChannelArn: data.invitation.channelArn } : {}),
    ...(typeof data.bound?.conversationArn === 'string' ? { bound: { conversationArn: data.bound.conversationArn } } : {}),
  };
}

async function postExchange(body: string, idToken: string): Promise<ExchangeAnswer> {
  const resp = await fetch(exchangeUrl(), {
    method: 'POST',
    // identity comes from the validated token, never the body (IDOR guard)
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({} as { error?: string; code?: string }));
    throw new ExchangeRefusedError(
      errBody.error || `Credential exchange failed: ${resp.status}`,
      resp.status,
      errBody.code,
    );
  }
  return answerFrom(await resp.json());
}

/**
 * POST the exchange with an arbitrary body; returns vended STS credentials, the identity ARN the
 * exchange vended them for, and what it reports about the caller. Reused by every plane (chat's
 * refreshing provider, the person's own identity, chat's rename).
 */
export async function exchangeCredentials(
  body: Record<string, unknown>,
  idToken: string,
): Promise<ExchangeAnswer> {
  return postExchange(JSON.stringify(body), idToken);
}

/**
 * An AWS SDK credentials provider that fetches STS creds from the backend
 * Credential Exchange with an empty body (chat plane: the caller's own
 * AppInstanceUser, no channel scoping). Returns a provider (not static
 * creds) so the SDK auto-refreshes by re-calling the exchange when the
 * session nears expiry. On each (re)call it fetches a FRESH idToken via
 * `ensureFreshIdToken` rather than reusing the one captured at creation, so a
 * refresh that fires after the idToken expired (e.g. a backgrounded tab whose
 * AuthProvider timer was throttled) still authorizes, instead of replaying a
 * stale token and failing "Invalid login token. Token expired". The `idToken`
 * arg is a fallback for the first call before any refresh machinery is ready.
 */
export function exchangeCredentialsProvider(idToken?: string): () => Promise<VendedCredentials> {
  return async () => {
    const token = await ensureFreshIdToken().catch(() => idToken);
    if (!token) throw new Error('Not authenticated');
    return (await postExchange('{}', token)).credentials;
  };
}
