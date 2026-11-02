import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  ResendConfirmationCodeCommand,
  GlobalSignOutCommand,
  RevokeTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { setAuthToken, trackEvent } from '../services/eventTrackingService';
import { REGION, USER_POOL_CLIENT_ID as CLIENT_ID, FEDERATED_CLIENT_ID, SIGN_IN_ISSUERS_JSON } from '../platform/config';
import { idTokenDisplayClaims, idTokenExpiresWithin } from '../services/idTokenClaims';
import { currentSessionEpoch, endSessionEpoch } from '../services/sessionEpoch';
import { resolvePersonIdentity, IdentitySupersededError } from '../services/personIdentity';
import { ExchangeRefusedError } from '../services/credentialExchange';
import {
  parseSignInIssuers,
  beginRedirectSignIn,
  completeRedirectSignInOnce,
  foreignSessionIssuer,
  cognitoRefreshClientId,
  isRedirectCallback,
  refreshRedirectTokens,
  setSessionIssuerId,
  RedirectSignInError,
  type RedirectFailure,
  type SignInIssuer,
} from '../services/redirectSignIn';

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

/** The redirect issuers this build offers, from `VITE_ISSUERS`. Empty: password sign-in only. */
const SIGN_IN_ISSUERS: readonly SignInIssuer[] = parseSignInIssuers(SIGN_IN_ISSUERS_JSON);

/**
 * Persist Cognito tokens. The refresh token goes in sessionStorage (tab-scoped) to shrink the XSS
 * exfiltration blast radius; access and ID tokens in localStorage (short-lived, avoids re-auth on every
 * tab open). A redirect sign-in stores its tokens the same way, and records which issuer they came
 * from so they are refreshed there; a password sign-in records none.
 */
function storeTokens(
  auth: { AccessToken?: string; RefreshToken?: string; IdToken?: string },
  issuerId: string | null = null,
): void {
  localStorage.setItem('accessToken', auth.AccessToken || '');
  sessionStorage.setItem('refreshToken', auth.RefreshToken || '');
  localStorage.setItem('idToken', auth.IdToken || '');
  setSessionIssuerId(issuerId);
}

// Refresh tokens 5 minutes before expiry (Cognito tokens last 1 hour)
const REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

/** A classification value the deployment declares (`config/classifications.ts`). */
export type UserTier = string;

export interface User {
  /**
   * The person's AppInstanceUser id, read from the ARN the credential exchange returned. It is minted
   * by the exchange and is never the ID token's `sub`.
   */
  id: string;
  email: string;
  /**
   * The classification the ID token's `custom:tier` claim names, for UI gating only. Absent when the
   * token names none: a classification is set or not (ADR-046), so nothing is offered on a guess.
   */
  tier?: UserTier;
  name?: string;
  /** The person's AppInstanceUser ARN, exactly as the credential exchange returned it. */
  userArn: string;
  /** True when the exchange reports the `admins` console role for this person. A display hint that
   *  decides whether the chat header shows the console link, and grants nothing: admin credentials
   *  come only from the console's admin vend, with a console session and a stated reason. */
  isAdmin: boolean;
}

/** True if the JWT's `exp` is in the past (30s skew). A missing/unreadable `exp`
 *  is treated as expired (fail-safe: forces a refresh rather than trusting it). */
function isTokenExpired(idToken: string | null): boolean {
  return idTokenExpiresWithin(idToken, 30_000);
}

/**
 * What adopting a session came to. `refused` is the exchange deciding this sign-in is not vended for
 * (a 4xx), which ends the session; `unavailable` is the exchange not answering, which keeps the tokens
 * and retries, for the same reason a Cognito outage does (see `TokenRefreshOutcome`).
 */
type AdoptOutcome = 'adopted' | 'refused' | 'unavailable' | 'superseded';

/**
 * WHAT A FAILED TOKEN REFRESH ACTUALLY MEANS.
 *
 * Every failure used to collapse into one boolean, reported as "refresh token expired or invalid"
 * and acted on the same way: clear the tokens and put the person back on the sign-in screen. A
 * refresh that never reached Cognito is a different fact, and it deserves a different answer.
 *
 * Seen live 2026-09-09, minutes after a fresh sign-in: the browser logged
 * `net::ERR_INTERNET_DISCONNECTED` against `cognito-idp.us-east-1.amazonaws.com`, and the app
 * answered "refresh token expired or invalid" - telling the person to re-authenticate over the
 * connection that had just dropped, which cannot work. The diagnosis was the visible half. The
 * costly half is that `clearTokens` DELETES the refresh token, and the refresh token is the only
 * way back into a session, so a blip landing on the scheduled refresh ends the session for good
 * rather than for the length of the outage.
 *
 * So the outcome is named, and only an answer FROM Cognito that this token is no good ends a
 * session. Silence is not an answer.
 */
export type TokenRefreshOutcome =
  /** New tokens are stored and the provider's state is updated. */
  | 'refreshed'
  /** Cognito answered, and the answer is that this refresh token will never be redeemed. */
  | 'rejected'
  /** No answer at all: offline, DNS, TLS, timeout, throttle, 5xx. The session is still good. */
  | 'unavailable'
  /** Nothing to refresh - this tab holds no refresh token. Distinct from one that was refused. */
  | 'absent'
  /**
   * The session ended while Cognito was being asked, so the answer was discarded unapplied.
   *
   * Not a failure and not a success: the tokens were valid, and writing them would have undone a
   * sign-out the person had already performed.
   */
  | 'superseded';

/**
 * Cognito error names that mean the stored refresh token can never be redeemed again.
 *
 * Deliberately a short list of answers rather than a list of exclusions: anything not named here is
 * treated as `unavailable`, because keeping a session that turns out to be dead costs one more
 * failed refresh, while discarding one that was only unreachable costs the person their session.
 */
const REFRESH_REJECTED_ERRORS = new Set([
  'NotAuthorizedException', // expired, revoked, or issued to another client
  'UserNotFoundException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
  'ResourceNotFoundException', // the app client is gone
  'InvalidParameterException',
]);

/**
 * Did Cognito refuse this refresh token, or did we simply never hear back?
 *
 * Exported for `AuthProvider.test.ts`, which is where the distinction is held to: a `TypeError:
 * Failed to fetch` must never be read as a credential decision.
 */
export function classifyRefreshFailure(error: unknown): 'rejected' | 'unavailable' {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (REFRESH_REJECTED_ERRORS.has(name)) return 'rejected';
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  // A 4xx is Cognito answering. 408 and 429 are the two that say "ask again", not "no".
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return 'rejected';
  }
  return 'unavailable';
}

/** What a session should do about an outcome. Pure, so the rule can be read and tested directly. */
export function sessionActionForOutcome(
  outcome: TokenRefreshOutcome,
): 'adopt' | 'retry' | 'sign-out' {
  if (outcome === 'refreshed') return 'adopt';
  // THE LINE THE DEFECT LIVED IN. `unavailable` used to reach the same clearTokens() as a refusal.
  if (outcome === 'unavailable') return 'retry';
  // Already signed out by the time the answer arrived. Retrying would ask on behalf of a session
  // that no longer exists, and signing out again is work for an outcome that already happened -
  // but `sign-out` is the safe one of the two, so it stays in that branch rather than gaining its
  // own. Left explicit so the next reader does not have to derive it from the fallthrough.
  return 'sign-out';
}

/** Developer-facing text for a refresh that produced no tokens. Never rendered to a user. */
export const TOKEN_REFRESH_FAILURE_MESSAGE: Record<
  Exclude<TokenRefreshOutcome, 'refreshed'>,
  string
> = {
  rejected:
    'Cognito refused the refresh token (expired, revoked or issued to another client); signing in again is required',
  unavailable:
    'Cognito could not be reached, so the token was not refreshed; this is a connectivity failure and the session is kept',
  absent: 'this tab holds no refresh token, so there was nothing to refresh',
  superseded:
    'the session ended while Cognito was being asked, so valid tokens were discarded rather than written back over a sign-out',
};

// An unreachable Cognito is retried on a short backoff rather than waited out for another full
// refresh interval - the current token has minutes left on it, not fifty. The `online` event
// shortens the wait when the browser thinks the connection is back; it is a hint, so it never
// replaces the wait.
const REFRESH_RETRY_MIN_MS = 30_000;
const REFRESH_RETRY_MAX_MS = 5 * 60 * 1000;
const REFRESH_RETRY_ONLINE_MS = 1_000;

/** Why a retry is running, carried across the backoff so a recovered session is reported as one. */
interface RetryOptions {
  resumed?: boolean;
  delayMs?: number;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  idToken: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, tier: UserTier) => Promise<void>;
  confirmRegistration: (email: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Set when login() hits a NEW_PASSWORD_REQUIRED challenge — i.e. the account
   * was created with a temporary password (admin onboarding) and must set a
   * permanent one before first use. The LoginScreen renders a "set new password"
   * form while this is non-null; clear it by calling completeNewPassword().
   */
  passwordChallenge: { email: string } | null;
  /** Resolve a NEW_PASSWORD_REQUIRED challenge with a permanent password. */
  completeNewPassword: (newPassword: string) => Promise<void>;
  /** Set when login() hits a TOTP/SMS MFA challenge; the LoginScreen renders a
   *  one-time-code input while this is non-null. Resolve with completeMfa(). */
  mfaChallenge: { email: string; type: 'SOFTWARE_TOKEN_MFA' | 'SMS_MFA' } | null;
  /** Resolve an MFA challenge with the one-time code. */
  completeMfa: (code: string) => Promise<void>;
  /** Start a self-service password reset (Cognito emails a code). */
  forgotPassword: (email: string) => Promise<void>;
  /** Complete a password reset with the emailed code + new password. */
  confirmForgotPassword: (email: string, code: string, newPassword: string) => Promise<void>;
  /** Resend the sign-up email-verification code. */
  resendCode: (email: string) => Promise<void>;
  /**
   * Force-refresh Cognito tokens NOW and resolve only when new tokens are
   * in localStorage + idToken state has been updated. Throws if no tokens
   * were produced, with a message that says WHICH failure it was - a refusal
   * from Cognito and an unreachable Cognito are not the same thing and do not
   * have the same remedy.
   *
   * MessagingProvider awaits this in forceReconnect on visibility-stale
   * sessions to ensure the WebSocket handshake uses fresh credentials.
   * Refresh-credentials pattern.
   */
  refreshCredentials: () => Promise<void>;
  /** The redirect issuers the sign-in screen offers (`VITE_ISSUERS`), beside the password form. */
  signInIssuers: readonly SignInIssuer[];
  /** Send the tab to an issuer's sign-in (authorization code with PKCE). */
  signInWithIssuer: (issuerId: string) => Promise<void>;
  /** Why the last redirect sign-in did not finish; the screen shows its localized message. */
  redirectError: RedirectFailure | null;
  /** Dismiss `redirectError`, back to the sign-in screen. */
  clearRedirectError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [passwordChallenge, setPasswordChallenge] = useState<{ email: string } | null>(null);
  // Set when login() hits a TOTP/SMS MFA challenge; the LoginScreen renders a code
  // input while this is non-null, resolved by completeMfa().
  const [mfaChallenge, setMfaChallenge] = useState<{ email: string; type: 'SOFTWARE_TOKEN_MFA' | 'SMS_MFA' } | null>(null);
  const [redirectError, setRedirectError] = useState<RedirectFailure | null>(null);
  // NEW_PASSWORD_REQUIRED challenge session (opaque, single-use) — held in a ref,
  // not exposed to consumers.
  const challengeSessionRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // A refresh that never reached Cognito is retried instead of ending the session. Held in refs
  // rather than state because nothing renders from them and a re-render must not restart the wait.
  const refreshRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * WHICH SESSION THIS IS, so work started under an old one cannot land in a new one.
   *
   * A CLEARED TIMEOUT DOES NOT CANCEL AN IN-FLIGHT PROMISE, and that is the whole gap. The retry
   * nulls its own timer handle and then awaits Cognito, so a sign-out during that round trip finds
   * nothing to cancel: `clearTokens` wipes storage, the refresh resolves a moment later and writes
   * `accessToken` and `idToken` straight back, and `adoptSession` reads them and starts the refresh
   * timer. The person signed out and was silently signed back in.
   *
   * A counter settles it where a handle cannot: anything that ends a session bumps it, and work that
   * captured the old value discards its own result instead of applying it.
   */
  // The counter itself is module-level (`services/sessionEpoch.ts`) so `ensureFreshIdToken` and the
  // identity lookup, which run outside React, honour the same sign-out.
  const refreshRetryDelayRef = useRef<number>(REFRESH_RETRY_MIN_MS);
  const refreshRetryResumedRef = useRef<boolean>(false);
  const scheduleRefreshRetryRef = useRef<((opts?: RetryOptions) => void) | null>(null);

  const clearTokens = useCallback(() => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('idToken');
    // The refresh token lives in sessionStorage so any successful XSS is
    // bounded to the open tab's lifetime instead of the refresh-token TTL.
    // A production-grade upgrade is an httpOnly cookie via a backend
    // exchange endpoint.
    sessionStorage.removeItem('refreshToken');
    // Also clear the localStorage location in case the user upgraded
    // from a previous version that wrote it there.
    localStorage.removeItem('refreshToken');
    setSessionIssuerId(null);
    setUser(null);
    setIdToken(null);
    setAuthToken(null);
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    // There is no session left to recover, so a pending retry has nothing to retry for.
    if (refreshRetryTimerRef.current) {
      clearTimeout(refreshRetryTimerRef.current);
      refreshRetryTimerRef.current = null;
    }
    refreshRetryDelayRef.current = REFRESH_RETRY_MIN_MS;
    // Anything already asking Cognito on the old session now has a stale epoch and will drop its
    // answer rather than write it back over what was just cleared.
    endSessionEpoch();
  }, []);

  const refreshTokens = useCallback(async (): Promise<TokenRefreshOutcome> => {
    // Read from sessionStorage; fall back to localStorage so an in-progress
    // session from a previous version still works once (then clearTokens /
    // login will write to the sessionStorage location).
    const refreshToken =
      sessionStorage.getItem('refreshToken') || localStorage.getItem('refreshToken');
    // Absent, not refused. `storeTokens` writes '' when a login response carried no refresh token,
    // which lands here too, and calling that an expired token sends the reader hunting for a TTL.
    if (!refreshToken) return 'absent';
    // Captured BEFORE the round trip, compared after it.
    const epoch = currentSessionEpoch();

    // REFRESH PER ISSUER. A foreign OIDC session is refreshed at its own token endpoint; a password or
    // `cognito-federated` session through Cognito, below. An issuer the build no longer declares is
    // refused: its tokens reach nothing.
    const foreign = foreignSessionIssuer(SIGN_IN_ISSUERS);
    if (foreign === 'undeclared') return 'rejected';
    if (foreign) {
      try {
        const tokens = await refreshRedirectTokens(foreign, refreshToken);
        if (epoch !== currentSessionEpoch()) return 'superseded';
        if (tokens.accessToken) localStorage.setItem('accessToken', tokens.accessToken);
        localStorage.setItem('idToken', tokens.idToken);
        if (tokens.refreshToken) sessionStorage.setItem('refreshToken', tokens.refreshToken);
        setIdToken(tokens.idToken);
        setAuthToken(tokens.idToken);
        return 'refreshed';
      } catch (error) {
        const outcome = classifyRefreshFailure(error);
        console.error('Token refresh failed (' + outcome + ') at the session issuer', error);
        return outcome;
      }
    }

    try {
      const response = await cognitoClient.send(
        new InitiateAuthCommand({
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          // A federated session's refresh token is the federated client's (`cognitoRefreshClientId`).
          ClientId: cognitoRefreshClientId(SIGN_IN_ISSUERS, CLIENT_ID, FEDERATED_CLIENT_ID),
          AuthParameters: {
            REFRESH_TOKEN: refreshToken,
          },
        })
      );

      if (response.AuthenticationResult) {
        // THE SESSION THAT ASKED MUST STILL BE THE SESSION THAT IS RUNNING. Checked here rather than
        // at the call sites because this is the only place tokens are written, and a guard at each
        // caller is a guard somebody adds a caller without.
        if (epoch !== currentSessionEpoch()) return 'superseded';
        const newAccessToken = response.AuthenticationResult.AccessToken || '';
        const newIdToken = response.AuthenticationResult.IdToken || '';

        localStorage.setItem('accessToken', newAccessToken);
        localStorage.setItem('idToken', newIdToken);
        // Note: REFRESH_TOKEN_AUTH does not return a new refresh token
        setIdToken(newIdToken);
        setAuthToken(newIdToken);
        return 'refreshed';
      }
      // Cognito answered 200 with no AuthenticationResult. REFRESH_TOKEN_AUTH has no challenge to
      // return, so there is nothing to continue and nothing to wait for: this token is unusable.
      console.error('Token refresh returned no AuthenticationResult');
      return 'rejected';
    } catch (error) {
      const outcome = classifyRefreshFailure(error);
      console.error(
        'Token refresh failed (' + outcome + '): ' + TOKEN_REFRESH_FAILURE_MESSAGE[outcome],
        error,
      );
      return outcome;
    }
  }, []);

  const startRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
    }
    refreshTimerRef.current = setInterval(async () => {
      const outcome = await refreshTokens();
      if (sessionActionForOutcome(outcome) !== 'sign-out') {
        // 'retry' means Cognito was never reached. Keeping the tokens is the point: clearing them
        // deletes the refresh token, so an outage outliving one interval would have ended the
        // session permanently instead of for its own duration.
        if (outcome === 'unavailable') scheduleRefreshRetryRef.current?.();
        return;
      }
      clearTokens();
    }, REFRESH_INTERVAL_MS);
  }, [refreshTokens, clearTokens]);

  /**
   * Take the tokens currently in storage as the live session.
   *
   * WHO THE PERSON IS COMES FROM THE CREDENTIAL EXCHANGE, not from the token. The exchange resolves
   * the token to the person's AppInstanceUser, whose id it minted and which is never the token's
   * `sub`; an id read off the token names nobody in the app instance. The token is read only for what
   * is shown (email, name) and for the classification the UI gates on.
   *
   * Shared by the mount check and by the retry, so a session recovered after an outage is adopted
   * exactly the way one adopted at startup is - including the refresh timer, whose absence is how a
   * recovered session would quietly stop refreshing.
   */
  const adoptSession = useCallback(async (opts?: { resumed?: boolean }): Promise<AdoptOutcome> => {
    const stored = localStorage.getItem('idToken');
    const shown = idTokenDisplayClaims(stored);
    if (!stored || !shown) return 'refused';
    const epoch = currentSessionEpoch();
    let identity;
    try {
      identity = await resolvePersonIdentity(stored);
    } catch (error) {
      if (error instanceof IdentitySupersededError) return 'superseded';
      // A 4xx is the exchange deciding (an inactive sign-in, an undeclared group combination). Anything
      // else - offline, a 5xx - is silence, and silence does not end a session.
      if (error instanceof ExchangeRefusedError && error.status >= 400 && error.status < 500) {
        console.error('[Auth] the credential exchange refused this sign-in:', error.message);
        return 'refused';
      }
      console.warn('[Auth] the credential exchange could not be reached; retrying', error);
      return 'unavailable';
    }
    if (epoch !== currentSessionEpoch()) return 'superseded';
    const loadedUser: User = {
      id: identity.personId,
      userArn: identity.userArn,
      email: shown.email || '',
      tier: (shown.tier as UserTier | undefined) || undefined,
      name: shown.name,
      // Display hint only; the console's admin vend (session + reason) is the only admin grant.
      isAdmin: identity.consoleRole === 'admins',
    };
    setUser(loadedUser);
    setIdToken(stored);
    setAuthToken(stored);
    startRefreshTimer();
    trackEvent('session_started', {
      tier: loadedUser.tier || 'unknown',
      ...(opts?.resumed ? { resumed: true } : {}),
    });
    return 'adopted';
  }, [startRefreshTimer]);

  /**
   * Try again, later, because Cognito (or the credential exchange) could not be reached.
   *
   * Backs off from 30s to 5 minutes and stops on an answer either way: tokens, or a refusal that
   * ends the session. It recurses through `scheduleRefreshRetryRef` rather than by name so the
   * callback does not reference its own binding.
   */
  const scheduleRefreshRetry = useCallback((opts?: RetryOptions): void => {
    if (refreshRetryTimerRef.current) clearTimeout(refreshRetryTimerRef.current);
    if (opts?.resumed !== undefined) refreshRetryResumedRef.current = opts.resumed;
    const resumed = refreshRetryResumedRef.current;
    refreshRetryTimerRef.current = setTimeout(async () => {
      refreshRetryTimerRef.current = null;
      const outcome = await refreshTokens();
      const action = sessionActionForOutcome(outcome);
      const backOff = () => {
        refreshRetryDelayRef.current = Math.min(
          refreshRetryDelayRef.current * 2,
          REFRESH_RETRY_MAX_MS,
        );
        scheduleRefreshRetryRef.current?.({ resumed });
      };
      if (action === 'retry') {
        backOff();
        return;
      }
      if (action === 'adopt') {
        const adopted = await adoptSession({ resumed });
        if (adopted === 'adopted' || adopted === 'superseded') {
          refreshRetryDelayRef.current = REFRESH_RETRY_MIN_MS;
          return;
        }
        if (adopted === 'unavailable') {
          backOff();
          return;
        }
      }
      refreshRetryDelayRef.current = REFRESH_RETRY_MIN_MS;
      // Cognito (or the exchange) answered, and the answer is no. NOW signing out is the honest thing to do.
      clearTokens();
    }, opts?.delayMs ?? refreshRetryDelayRef.current);
  }, [refreshTokens, adoptSession, clearTokens]);

  useEffect(() => {
    scheduleRefreshRetryRef.current = scheduleRefreshRetry;
  }, [scheduleRefreshRetry]);

  // A retry waiting out a backoff on a dead connection should not keep waiting once the browser
  // says the connection is back. `online` fires on a link, not on reachability, so it shortens the
  // wait rather than replacing it, and does nothing at all when no retry is pending.
  useEffect(() => {
    const onOnline = () => {
      if (!refreshRetryTimerRef.current) return;
      refreshRetryDelayRef.current = REFRESH_RETRY_MIN_MS;
      scheduleRefreshRetryRef.current?.({ delayMs: REFRESH_RETRY_ONLINE_MS });
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const checkAuthState = useCallback(async () => {
    try {
      const accessToken = localStorage.getItem('accessToken');
      const idToken = localStorage.getItem('idToken');

      if (!accessToken || !idToken) {
        clearTokens();
        return;
      }

      // The user is built from the ID token locally (no GetUser round-trip), so an
      // expired token no longer surfaces as a network error — check expiry explicitly
      // and refresh before loading, preserving the resume-on-expiry behavior.
      let resumed = false;
      if (isTokenExpired(idToken)) {
        const outcome = await refreshTokens();
        const action = sessionActionForOutcome(outcome);
        if (action === 'retry') {
          // KEEP THE TOKENS. Cognito was never reached, so nothing here says the refresh token is
          // bad, and it is the only way back into this session. A reload during an outage used to
          // delete it, which is a permanent sign-out caused by a temporary condition.
          console.warn(
            '[Auth] Cognito unreachable while resuming a session; retrying instead of signing out',
          );
          scheduleRefreshRetry({ resumed: true });
          return;
        }
        if (action === 'sign-out') {
          clearTokens();
          return;
        }
        resumed = true;
      }

      const adopted = await adoptSession({ resumed });
      if (adopted === 'unavailable') {
        // The tokens are good and the exchange did not answer: keep them and ask again, exactly as
        // an unreachable Cognito is handled above.
        scheduleRefreshRetry({ resumed });
        return;
      }
      if (adopted === 'refused') clearTokens();
    } catch (error) {
      console.error('Auth state check failed:', error);
      clearTokens();
    } finally {
      setIsLoading(false);
    }
  }, [clearTokens, refreshTokens, adoptSession, scheduleRefreshRetry]);

  /**
   * THE CALLBACK ROUTE. The issuer sends the tab back to `/callback` with a code and the state this tab
   * sent. The code is redeemed (with the PKCE verifier), the tokens are stored like a password sign-in's,
   * and the session is adopted through the credential exchange by `checkAuthState`, exactly as after a
   * password sign-in. The code and state leave the address bar either way.
   */
  const finishRedirectSignIn = useCallback(async () => {
    const href = window.location.href;
    try {
      const tokens = await completeRedirectSignInOnce(href, SIGN_IN_ISSUERS, { ownClientId: CLIENT_ID, federatedClientId: FEDERATED_CLIENT_ID });
      window.history.replaceState(null, '', '/');
      storeTokens({ AccessToken: tokens.accessToken, IdToken: tokens.idToken, RefreshToken: tokens.refreshToken }, tokens.issuerId);
      trackEvent('signin_succeeded', { method: 'redirect' });
      await checkAuthState();
      trackEvent('login', { method: 'redirect' });
    } catch (error) {
      window.history.replaceState(null, '', '/');
      const code: RedirectFailure = error instanceof RedirectSignInError ? error.code : 'token-exchange-failed';
      console.error('[Auth] the redirect sign-in did not finish:', error);
      trackEvent('signin_failed', { reason: code, method: 'redirect' });
      setRedirectError(code);
      setIsLoading(false);
    }
  }, [checkAuthState]);

  // Check for existing session on mount, or finish the redirect sign-in this load returns from.
  useEffect(() => {
    if (isRedirectCallback()) void finishRedirectSignIn();
    else checkAuthState();
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
      // AND THE RETRY, which this cleanup did not touch. It backs off to five minutes, so an
      // unmounted provider could leave one armed for that long, wake up, and ask Cognito on behalf
      // of a component that no longer exists.
      if (refreshRetryTimerRef.current) {
        clearTimeout(refreshRetryTimerRef.current);
        refreshRetryTimerRef.current = null;
      }
    };
  }, [checkAuthState, finishRedirectSignIn]);

  /** Start a redirect sign-in at a declared issuer. A failure to start is shown like a failed callback. */
  const signInWithIssuer = useCallback(async (issuerId: string): Promise<void> => {
    const issuer = SIGN_IN_ISSUERS.find((i) => i.id === issuerId);
    if (!issuer) {
      setRedirectError('undeclared-issuer');
      return;
    }
    setRedirectError(null);
    trackEvent('signin_submitted', { method: 'redirect' });
    try {
      await beginRedirectSignIn(issuer, { ownClientId: CLIENT_ID, federatedClientId: FEDERATED_CLIENT_ID });
    } catch (error) {
      console.error('[Auth] the redirect sign-in could not start:', error);
      setRedirectError(error instanceof RedirectSignInError ? error.code : 'unavailable');
    }
  }, []);

  const clearRedirectError = useCallback(() => setRedirectError(null), []);

  // refreshCredentials — public Promise-returning wrapper around refreshTokens.
  // Resolves only after the new idToken is in localStorage + idToken state
  // has been updated; throws on refresh failure. MessagingProvider awaits
  // this in forceReconnect so the next WebSocket handshake uses fresh
  // credentials.
  const refreshCredentials = useCallback(async (): Promise<void> => {
    const outcome = await refreshTokens();
    if (outcome === 'refreshed') return;
    // THE STRING THE DEFECT WAS READ IN. Every failure claimed the refresh token had expired, so an
    // outage was reported as a credential problem and the remedy on offer - sign in again - was the
    // one thing that could not work while the connection was down.
    throw new Error(
      'Cognito token refresh failed (' + outcome + '): ' + TOKEN_REFRESH_FAILURE_MESSAGE[outcome],
    );
  }, [refreshTokens]);

  // Note: visibility-change handling lives in MessagingProvider as the
  // single driver. MessagingProvider awaits refreshCredentials() in its
  // forceReconnect path, so we don't fire a parallel refresh here that
  // would race against the WebSocket reconnect.

  const login = async (email: string, password: string): Promise<void> => {
    try {
      const response = await cognitoClient.send(
        new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: CLIENT_ID,
          AuthParameters: {
            USERNAME: email,
            PASSWORD: password,
          },
        })
      );

      // First-login (admin onboarding): account created with a temporary
      // password lands here. Stash the challenge session + surface it to the
      // LoginScreen, which collects a permanent password → completeNewPassword().
      if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        challengeSessionRef.current = response.Session || null;
        setPasswordChallenge({ email });
        return;
      }

      // MFA challenge: the pool has MFA enabled (TOTP or SMS) for this user. Stash the
      // challenge session and surface it to the LoginScreen, which collects the one-time
      // code → completeMfa(). Without this branch a user with MFA on cannot sign in.
      if (response.ChallengeName === 'SOFTWARE_TOKEN_MFA' || response.ChallengeName === 'SMS_MFA') {
        challengeSessionRef.current = response.Session || null;
        setMfaChallenge({ email, type: response.ChallengeName });
        return;
      }

      if (response.AuthenticationResult) {
        storeTokens(response.AuthenticationResult);
        // THE FUNNEL'S SUCCESS STEP, recorded where the tokens arrive and before the session is adopted,
        // so it travels in the flush that signing in triggers, with the form view and submit held before it.
        trackEvent('signin_succeeded');
        await checkAuthState();
        trackEvent('login');
      }
    } catch (error: any) {
      if (error.name === 'UserNotConfirmedException') {
        throw new Error('Please verify your email address before logging in. Check your inbox for the verification code.');
      } else if (error.name === 'NotAuthorizedException') {
        throw new Error('Invalid email or password');
      } else if (error.message?.includes('pending administrator approval')) {
        throw new Error('Your account is pending administrator approval. Please check back later.');
      }
      throw error;
    }
  };

  /** Resolve a NEW_PASSWORD_REQUIRED challenge (admin first-login reset). */
  const completeNewPassword = async (newPassword: string): Promise<void> => {
    if (!passwordChallenge || !challengeSessionRef.current) {
      throw new Error('No password challenge in progress');
    }
    try {
      const response = await cognitoClient.send(
        new RespondToAuthChallengeCommand({
          ClientId: CLIENT_ID,
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: challengeSessionRef.current,
          ChallengeResponses: {
            USERNAME: passwordChallenge.email,
            NEW_PASSWORD: newPassword,
          },
        })
      );
      if (response.AuthenticationResult) {
        storeTokens(response.AuthenticationResult);
        trackEvent('signin_succeeded');
        challengeSessionRef.current = null;
        setPasswordChallenge(null);
        await checkAuthState();
        trackEvent('login');
        return;
      }
      // A further challenge (rare for this flow) — surface generically.
      throw new Error('Could not complete password setup. Please try again.');
    } catch (error: any) {
      if (error.name === 'InvalidPasswordException') {
        throw new Error(error.message || 'Password does not meet the requirements.');
      }
      throw error;
    }
  };

  /** Resolve a SOFTWARE_TOKEN_MFA / SMS_MFA challenge with the one-time code. */
  const completeMfa = async (code: string): Promise<void> => {
    if (!mfaChallenge || !challengeSessionRef.current) {
      throw new Error('No MFA challenge in progress');
    }
    try {
      const responseKey = mfaChallenge.type === 'SMS_MFA' ? 'SMS_MFA_CODE' : 'SOFTWARE_TOKEN_MFA_CODE';
      const response = await cognitoClient.send(
        new RespondToAuthChallengeCommand({
          ClientId: CLIENT_ID,
          ChallengeName: mfaChallenge.type,
          Session: challengeSessionRef.current,
          ChallengeResponses: {
            USERNAME: mfaChallenge.email,
            [responseKey]: code,
          },
        })
      );
      if (response.AuthenticationResult) {
        storeTokens(response.AuthenticationResult);
        trackEvent('signin_succeeded');
        challengeSessionRef.current = null;
        setMfaChallenge(null);
        await checkAuthState();
        trackEvent('login');
        return;
      }
      throw new Error('Could not complete sign-in. Please try again.');
    } catch (error: any) {
      if (error.name === 'CodeMismatchException') {
        throw new Error('That code is incorrect. Please try again.');
      }
      if (error.name === 'ExpiredCodeException') {
        throw new Error('That code has expired. Sign in again to get a new one.');
      }
      throw error;
    }
  };

  /** Start a self-service password reset: Cognito emails a confirmation code. */
  const forgotPassword = async (email: string): Promise<void> => {
    try {
      await cognitoClient.send(
        new ForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email })
      );
    } catch (error: any) {
      // Do not reveal whether an account exists — surface a generic success-shaped
      // message for UserNotFound so the reset screen advances to the code step either way.
      if (error.name === 'UserNotFoundException') return;
      if (error.name === 'LimitExceededException') {
        throw new Error('Too many attempts. Please wait a few minutes and try again.');
      }
      throw error;
    }
  };

  /** Complete a password reset with the emailed code + a new password. */
  const confirmForgotPassword = async (email: string, code: string, newPassword: string): Promise<void> => {
    try {
      await cognitoClient.send(
        new ConfirmForgotPasswordCommand({
          ClientId: CLIENT_ID,
          Username: email,
          ConfirmationCode: code,
          Password: newPassword,
        })
      );
    } catch (error: any) {
      if (error.name === 'CodeMismatchException') {
        throw new Error('That code is incorrect. Please check your email and try again.');
      }
      if (error.name === 'ExpiredCodeException') {
        throw new Error('That code has expired. Request a new one.');
      }
      if (error.name === 'InvalidPasswordException') {
        throw new Error(error.message || 'Password does not meet the requirements.');
      }
      throw error;
    }
  };

  /** Resend the sign-up confirmation code (email verification). */
  const resendCode = async (email: string): Promise<void> => {
    await cognitoClient.send(
      new ResendConfirmationCodeCommand({ ClientId: CLIENT_ID, Username: email })
    );
  };

  const register = async (email: string, password: string, tier: UserTier): Promise<void> => {
    try {
      await cognitoClient.send(
        new SignUpCommand({
          ClientId: CLIENT_ID,
          Username: email,
          Password: password,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'custom:tier', Value: tier },
          ],
        })
      );
      localStorage.setItem('pendingUsername', email);
      trackEvent('signup_confirmation_required', { tier });
    } catch (error: any) {
      if (error.name === 'UsernameExistsException') {
        throw new Error('An account with this email already exists');
      }
      throw error;
    }
  };

  const confirmRegistration = async (email: string, code: string): Promise<void> => {
    try {
      const username = localStorage.getItem('pendingUsername') || email;
      await cognitoClient.send(
        new ConfirmSignUpCommand({
          ClientId: CLIENT_ID,
          Username: username,
          ConfirmationCode: code,
        })
      );
      localStorage.removeItem('pendingUsername');
      trackEvent('signup_confirmation_completed');
    } catch (error: any) {
      if (error.name === 'CodeMismatchException') {
        throw new Error('Invalid verification code');
      } else if (error.name === 'ExpiredCodeException') {
        throw new Error('Verification code has expired');
      }
      throw error;
    }
  };

  const logout = async () => {
    try {
      const accessToken = localStorage.getItem('accessToken');
      const refreshToken = sessionStorage.getItem('refreshToken') || localStorage.getItem('refreshToken');
      // A foreign issuer's access token means nothing to Cognito; signing out there is local.
      if (!foreignSessionIssuer(SIGN_IN_ISSUERS)) {
        if (cognitoRefreshClientId(SIGN_IN_ISSUERS, CLIENT_ID, FEDERATED_CLIENT_ID) === FEDERATED_CLIENT_ID && FEDERATED_CLIENT_ID) {
          // A FEDERATED SESSION IS REVOKED BY ITS REFRESH TOKEN. Its client carries no
          // aws.cognito.signin.user.admin scope (so no holder can rewrite a mapped attribute), which is the
          // scope GlobalSignOut requires; RevokeToken needs none, and ends every token that refresh token issued.
          if (refreshToken) await cognitoClient.send(new RevokeTokenCommand({ Token: refreshToken, ClientId: FEDERATED_CLIENT_ID }));
        } else if (accessToken) {
          await cognitoClient.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
        }
      }
    } catch (error) {
      console.error('Error signing out:', error);
    } finally {
      trackEvent('logout');
      clearTokens();
    }
  };

  const value = {
    user,
    isAuthenticated: !!user,
    isLoading,
    idToken,
    login,
    register,
    confirmRegistration,
    logout,
    refreshCredentials,
    passwordChallenge,
    completeNewPassword,
    mfaChallenge,
    completeMfa,
    forgotPassword,
    confirmForgotPassword,
    resendCode,
    signInIssuers: SIGN_IN_ISSUERS,
    signInWithIssuer,
    redirectError,
    clearRedirectError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
