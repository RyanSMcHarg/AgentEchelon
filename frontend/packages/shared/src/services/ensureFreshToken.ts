/**
 * Return a NON-expired Cognito idToken, refreshing on demand — usable OUTSIDE React.
 *
 * The AuthProvider keeps a 50-minute refresh timer, but `setInterval` is throttled in backgrounded tabs, so
 * during a long session the ~60-minute idToken can expire before the timer fires. Any code that signs a
 * request from the stored token (the admin SigV4 path, credential-exchange) would then send an EXPIRED token
 * → "Invalid login token. Token expired". This helper closes that gap: it checks expiry at call time and does
 * a `REFRESH_TOKEN_AUTH` if needed, so signers always get a live token. Concurrent callers share ONE in-flight
 * refresh. Throws when there is no session or the refresh fails (caller should surface a re-login).
 */
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { REGION, USER_POOL_CLIENT_ID as CLIENT_ID } from '../platform/config';

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

function decode(idToken: string | null): Record<string, unknown> | null {
  if (!idToken) return null;
  try {
    return JSON.parse(atob((idToken.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/** Expired or within 60s of expiring (skew + a refresh window). Missing/unreadable exp ⇒ treat as expired. */
function isExpiring(idToken: string | null): boolean {
  const claims = decode(idToken);
  const exp = claims && typeof claims.exp === 'number' ? (claims.exp as number) : 0;
  if (!exp) return true;
  return exp * 1000 <= Date.now() + 60_000;
}

let inflight: Promise<string> | null = null;

async function doRefresh(): Promise<string> {
  const refreshToken = sessionStorage.getItem('refreshToken') || localStorage.getItem('refreshToken');
  if (!refreshToken) throw new Error('Session expired — please sign in again.');
  const resp = await cognitoClient.send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  );
  const idToken = resp.AuthenticationResult?.IdToken;
  const accessToken = resp.AuthenticationResult?.AccessToken;
  if (!idToken) throw new Error('Token refresh failed');
  localStorage.setItem('idToken', idToken);
  if (accessToken) localStorage.setItem('accessToken', accessToken);
  return idToken;
}

export async function ensureFreshIdToken(): Promise<string> {
  const current = localStorage.getItem('idToken');
  if (current && !isExpiring(current)) return current;
  if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
  return inflight;
}
