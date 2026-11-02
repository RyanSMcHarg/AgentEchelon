/**
 * Return a NON-expired Cognito idToken, refreshing on demand — usable OUTSIDE React.
 *
 * The AuthProvider keeps a 50-minute refresh timer, but `setInterval` is throttled in backgrounded tabs, so
 * during a long session the ~60-minute idToken can expire before the timer fires. Any code that signs a
 * request from the stored token (the admin SigV4 path, credential-exchange) would then send an EXPIRED token
 * → "Invalid login token. Token expired". This helper closes that gap: it checks expiry at call time and does
 * a `REFRESH_TOKEN_AUTH` if needed, so signers always get a live token. Concurrent callers share ONE in-flight
 * refresh. Throws when there is no session or the refresh fails (caller should surface a re-login).
 *
 * UNDER THE SESSION EPOCH, like the AuthProvider's own refresh. A refresh in flight when the person signs out
 * resolves after `clearTokens` has wiped storage; writing its tokens back would silently sign them in again.
 * So the epoch is captured before the round trip and compared after it, and a stale answer is discarded and
 * reported, never written. A refresh started in an earlier session is never shared with a caller in a new one.
 */
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { REGION, USER_POOL_CLIENT_ID as CLIENT_ID, SIGN_IN_ISSUERS_JSON } from '../platform/config';
import { idTokenExpiresWithin } from './idTokenClaims';
import { currentSessionEpoch } from './sessionEpoch';
import { foreignSessionIssuer, parseSignInIssuers, refreshRedirectTokens } from './redirectSignIn';

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const SIGN_IN_ISSUERS = parseSignInIssuers(SIGN_IN_ISSUERS_JSON);

/** Expired or within 60s of expiring (skew + a refresh window). */
const EXPIRY_WINDOW_MS = 60_000;

let inflight: { epoch: number; promise: Promise<string> } | null = null;

async function doRefresh(epoch: number): Promise<string> {
  const refreshToken = sessionStorage.getItem('refreshToken') || localStorage.getItem('refreshToken');
  if (!refreshToken) throw new Error('Session expired — please sign in again.');
  // A foreign OIDC session refreshes at its own token endpoint, under the same epoch rule.
  const foreign = foreignSessionIssuer(SIGN_IN_ISSUERS);
  if (foreign === 'undeclared') throw new Error('Session expired — please sign in again.');
  if (foreign) {
    const tokens = await refreshRedirectTokens(foreign, refreshToken);
    if (epoch !== currentSessionEpoch()) throw new Error('Session ended while the token was being refreshed.');
    localStorage.setItem('idToken', tokens.idToken);
    if (tokens.accessToken) localStorage.setItem('accessToken', tokens.accessToken);
    if (tokens.refreshToken) sessionStorage.setItem('refreshToken', tokens.refreshToken);
    return tokens.idToken;
  }
  const resp = await cognitoClient.send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  );
  // THE SESSION THAT ASKED MUST STILL BE THE SESSION THAT IS RUNNING.
  if (epoch !== currentSessionEpoch()) throw new Error('Session ended while the token was being refreshed.');
  const idToken = resp.AuthenticationResult?.IdToken;
  const accessToken = resp.AuthenticationResult?.AccessToken;
  if (!idToken) throw new Error('Token refresh failed');
  localStorage.setItem('idToken', idToken);
  if (accessToken) localStorage.setItem('accessToken', accessToken);
  return idToken;
}

export async function ensureFreshIdToken(): Promise<string> {
  const current = localStorage.getItem('idToken');
  if (current && !idTokenExpiresWithin(current, EXPIRY_WINDOW_MS)) return current;
  const epoch = currentSessionEpoch();
  if (!inflight || inflight.epoch !== epoch) {
    const promise = doRefresh(epoch).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { epoch, promise };
  }
  return inflight.promise;
}
