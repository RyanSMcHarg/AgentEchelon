/**
 * A14 (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md section 6): SigV4-signed GETs to the
 * IAM-authorized admin archive endpoints.
 *
 * Two credential sources, matching the two enforcement planes the backend wires:
 *   - SIGN-ON creds (`identityPoolCredentials`) — the operator's own Identity-Pool
 *     credentials, which resolve to their group's sign-on role (`AdminAuthenticatedRole`
 *     for `admins`). Standing, non-PII archive reads (`view-conversations`,
 *     `membership-history`) ride these. A role whose policy omits a resource is denied
 *     at the gateway.
 *   - EXCHANGE-vended creds — a short-lived, audited `execute-api` credential the
 *     credential exchange vends per use for customer message content (`view-messages`,
 *     A2). See `adminConversationService`.
 *
 * Both are signed here with SigV4 (`@smithy/signature-v4`) and sent as a plain fetch.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { REGION, IDENTITY_POOL_ID, USER_POOL_ID, ApiError, ensureFreshIdToken } from '@ae/shared';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * The operator's sign-on Identity-Pool credential provider, created once and
 * cached (the SDK provider refreshes itself as the session nears expiry). The
 * `logins` map exchanges the Cognito ID token for Identity-Pool creds, which the
 * pool's role mapping resolves to the caller's group role (`cognito:preferred_role`).
 */
let signOnProvider: (() => Promise<SigV4Credentials>) | null = null;
// The idToken the cached provider was built with. The Cognito-Identity provider refreshes the STS creds
// itself, but NOT the idToken baked into its `logins` map — so once that idToken expires the provider keeps
// sending a stale one and GetCredentialsForIdentity fails "Invalid login token. Token expired". We therefore
// recreate the provider whenever the (freshly-ensured) idToken changes.
let signOnToken: string | null = null;

export async function identityPoolCredentials(): Promise<SigV4Credentials> {
  if (!IDENTITY_POOL_ID || !USER_POOL_ID) {
    throw new Error('Signed admin reads require VITE_IDENTITY_POOL_ID + VITE_USER_POOL_ID');
  }
  // Always sign with a LIVE idToken — refreshes on demand (the AuthProvider timer can miss in a bg tab).
  const idToken = await ensureFreshIdToken();
  if (!signOnProvider || signOnToken !== idToken) {
    signOnToken = idToken;
    signOnProvider = fromCognitoIdentityPool({
      client: new CognitoIdentityClient({ region: REGION }) as unknown as Parameters<
        typeof fromCognitoIdentityPool
      >[0]['client'],
      identityPoolId: IDENTITY_POOL_ID,
      logins: { [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: idToken },
    }) as () => Promise<SigV4Credentials>;
  }
  return signOnProvider();
}

/** Drop the cached sign-on provider (call on sign-out). */
export function resetSignOnCredentials(): void {
  signOnProvider = null;
  signOnToken = null;
}

/**
 * SigV4-sign a GET to an `execute-api` URL with the given credentials and fetch it,
 * returning the parsed JSON. Query params are signed and re-serialized with the SAME
 * RFC3986 encoding SigV4 canonicalizes with (`encodeURIComponent`), so the signature
 * matches the sent request — AE's params (a Chime channel ARN, an integer limit) carry
 * no characters where `encodeURIComponent` diverges from SigV4.
 */
export async function sigv4GetJson<T>(
  url: string,
  query: Record<string, string | number | undefined>,
  credentials: SigV4Credentials,
): Promise<T> {
  const u = new URL(url);
  const cleanQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) cleanQuery[k] = String(v);
  }

  const signer = new SignatureV4({
    service: 'execute-api',
    region: REGION,
    credentials,
    sha256: Sha256,
  });

  const signed = await signer.sign({
    method: 'GET',
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname,
    query: cleanQuery,
    headers: { host: u.host },
  });

  const qs = Object.entries(cleanQuery)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const fetchUrl = qs ? `${u.origin}${u.pathname}?${qs}` : `${u.origin}${u.pathname}`;

  const res = await fetch(fetchUrl, {
    method: 'GET',
    headers: signed.headers as Record<string, string>,
  });

  if (!res.ok) {
    let be: string | undefined;
    try {
      be = (await res.clone().json())?.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, be ?? `Signed admin request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * SigV4-sign a POST (JSON body) to an `execute-api` URL and fetch it. Used for the
 * analytics query plane (the frontend's queryType contract is a POST) under A14
 * IAM enforcement — the body is signed, so it cannot be tampered in flight.
 */
export async function sigv4PostJson<T>(
  url: string,
  body: unknown,
  credentials: SigV4Credentials,
): Promise<T> {
  const u = new URL(url);
  const payload = JSON.stringify(body ?? {});

  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  const signed = await signer.sign({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname,
    headers: { host: u.host, 'content-type': 'application/json' },
    body: payload,
  });

  const res = await fetch(url, { method: 'POST', headers: signed.headers as Record<string, string>, body: payload });
  if (!res.ok) {
    let be: string | undefined;
    try {
      be = (await res.clone().json())?.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, be ?? `Signed admin request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
