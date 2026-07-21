import { CREDENTIAL_EXCHANGE_API_URL } from '../platform/config';
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

function exchangeUrl(): string {
  if (!CREDENTIAL_EXCHANGE_API_URL) {
    throw new Error('Credential exchange requires VITE_CREDENTIAL_EXCHANGE_API_URL');
  }
  return `${CREDENTIAL_EXCHANGE_API_URL.replace(/\/$/, '')}/exchange-credentials`;
}

/**
 * POST the exchange with an arbitrary body; returns vended STS credentials +
 * the identity ARN the exchange vended them for. Reused by every plane
 * (chat's refreshing provider, admin's scoped ops, chat's rename).
 */
export async function exchangeCredentials(
  body: Record<string, unknown>,
  idToken: string,
): Promise<{ credentials: VendedCredentials; userArn: string }> {
  const resp = await fetch(exchangeUrl(), {
    method: 'POST',
    // identity comes from the validated token, never the body (IDOR guard)
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({} as { error?: string }));
    throw new Error(errBody.error || `Credential exchange failed: ${resp.status}`);
  }
  const data = await resp.json();
  const c = data.credentials;
  return {
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ? new Date(c.Expiration) : undefined,
    },
    userArn: data.userArn,
  };
}

/**
 * An AWS SDK credentials provider that fetches STS creds from the backend
 * Credential Exchange with an empty body (chat plane — the caller's own
 * `${sub}` identity, no channel scoping). Returns a provider (not static
 * creds) so the SDK auto-refreshes by re-calling the exchange when the
 * session nears expiry. On each (re)call it fetches a FRESH idToken via
 * `ensureFreshIdToken` rather than reusing the one captured at creation, so a
 * refresh that fires after the idToken expired (e.g. a backgrounded tab whose
 * AuthProvider timer was throttled) still authorizes — instead of replaying a
 * stale token and failing "Invalid login token. Token expired". The `idToken`
 * arg is a fallback for the first call before any refresh machinery is ready.
 */
export function exchangeCredentialsProvider(idToken?: string): () => Promise<VendedCredentials> {
  return async () => {
    const token = await ensureFreshIdToken().catch(() => idToken);
    if (!token) throw new Error('Not authenticated');
    const resp = await fetch(exchangeUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}', // identity comes from the validated token, never the body (IDOR guard)
    });
    if (!resp.ok) throw new Error(`Credential exchange failed: ${resp.status}`);
    const data = await resp.json();
    const c = data.credentials;
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ? new Date(c.Expiration) : undefined,
    };
  };
}
