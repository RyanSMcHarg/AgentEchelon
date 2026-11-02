/**
 * The display claims and the expiry of the client's own ID token, read without verifying it.
 *
 * Nothing here names who the person is. Their identity is the AppInstanceUser the credential exchange
 * resolves the token to (`personIdentity.ts`), which is never the token's subject. What the token is
 * read for is the email and name shown on screen, the classification used to gate UI, and its `exp`,
 * which decides when to refresh it. Signature checking is the backend's job.
 *
 * The one place in the client that decodes a token, so a reader looking for "where does the client
 * read its own identity" finds that it does not.
 */

export interface IdTokenDisplayClaims {
  email?: string;
  name?: string;
  /** The classification the token's `custom:tier` claim names, for UI gating only. */
  tier?: string;
}

function decodePayload(idToken: string | null | undefined): Record<string, unknown> | null {
  if (!idToken) return null;
  try {
    const payloadB64 = idToken.split('.')[1] || '';
    return JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The claims the client shows. Null when the token is missing or unreadable. */
export function idTokenDisplayClaims(idToken: string | null | undefined): IdTokenDisplayClaims | null {
  const payload = decodePayload(idToken);
  if (!payload) return null;
  return {
    email: text(payload['email']),
    name: text(payload['name']),
    tier: text(payload['custom:tier']),
  };
}

/**
 * True when the token has expired or expires within `windowMs`. A missing or unreadable `exp` counts
 * as expired, which forces a refresh rather than trusting a token whose life is unknown.
 */
export function idTokenExpiresWithin(idToken: string | null | undefined, windowMs: number): boolean {
  const payload = decodePayload(idToken);
  const exp = payload && typeof payload.exp === 'number' ? payload.exp : 0;
  if (!exp) return true;
  return exp * 1000 <= Date.now() + windowMs;
}

/**
 * The protocol claims a redirect sign-in checks before it keeps a token: who issued it, who it is for,
 * the nonce the sign-in sent, and the Entra tenant when there is one. Read without verifying the
 * signature: the token arrived over TLS straight from the issuer's token endpoint (OpenID Connect Core
 * 3.1.3.7), and the credential exchange and the edge verify it before it reaches anything.
 */
export interface IdTokenProtocolClaims {
  iss?: string;
  aud: string[];
  nonce?: string;
  tid?: string;
}

/** The protocol claims, or null when the token is missing or unreadable. */
export function idTokenProtocolClaims(idToken: string | null | undefined): IdTokenProtocolClaims | null {
  const payload = decodePayload(idToken);
  if (!payload) return null;
  const aud = payload['aud'];
  return {
    iss: text(payload['iss']),
    aud: Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : text(aud) ? [aud as string] : [],
    nonce: text(payload['nonce']),
    tid: text(payload['tid']),
  };
}
