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
} from '@aws-sdk/client-cognito-identity-provider';
import { setAuthToken, trackEvent } from '../services/eventTrackingService';
import { REGION, USER_POOL_CLIENT_ID as CLIENT_ID } from '../platform/config';

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

// Refresh tokens 5 minutes before expiry (Cognito tokens last 1 hour)
const REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

export type UserTier = 'basic' | 'standard' | 'premium';

export interface User {
  id: string;
  email: string;
  tier: UserTier;
  name?: string;
  userArn?: string;
  /** True when the user is in the `admins` Cognito group. Distinct from
   *  tier — only admins can call /admin/* endpoints. Derived from the
   *  idToken's `cognito:groups` claim. */
  isAdmin?: boolean;
}

/** Decode the cognito:groups claim from a JWT idToken without verifying
 *  the signature (the backend does that). Used only to gate UI affordances
 *  the user can't actually use — never as an authorization signal. */
function parseCognitoGroups(idToken: string | null): string[] {
  const payload = decodeIdToken(idToken);
  const raw = payload?.['cognito:groups'];
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Decode a JWT idToken's payload without verifying the signature (the backend
 *  verifies it). The ID token already carries sub, email, name, custom:tier, and
 *  cognito:groups, so the app builds the User from it — no GetUser round-trip.
 *  Used only for display + UI gating, never as an authorization signal. */
function decodeIdToken(idToken: string | null): Record<string, unknown> | null {
  if (!idToken) return null;
  try {
    const payloadB64 = idToken.split('.')[1] || '';
    return JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/** True if the JWT's `exp` is in the past (30s skew). A missing/unreadable `exp`
 *  is treated as expired (fail-safe: forces a refresh rather than trusting it). */
function isTokenExpired(idToken: string | null): boolean {
  const claims = decodeIdToken(idToken);
  const exp = claims && typeof claims.exp === 'number' ? claims.exp : 0;
  if (!exp) return true;
  return exp * 1000 <= Date.now() + 30_000;
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
   * in localStorage + idToken state has been updated. Throws if refresh
   * fails (e.g. expired refresh token).
   *
   * MessagingProvider awaits this in forceReconnect on visibility-stale
   * sessions to ensure the WebSocket handshake uses fresh credentials.
   * Refresh-credentials pattern.
   */
  refreshCredentials: () => Promise<void>;
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
  // NEW_PASSWORD_REQUIRED challenge session (opaque, single-use) — held in a ref,
  // not exposed to consumers.
  const challengeSessionRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    setUser(null);
    setIdToken(null);
    setAuthToken(null);
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const refreshTokens = useCallback(async (): Promise<boolean> => {
    // Read from sessionStorage; fall back to localStorage so an in-progress
    // session from a previous version still works once (then clearTokens /
    // login will write to the sessionStorage location).
    const refreshToken =
      sessionStorage.getItem('refreshToken') || localStorage.getItem('refreshToken');
    if (!refreshToken) return false;

    try {
      const response = await cognitoClient.send(
        new InitiateAuthCommand({
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          ClientId: CLIENT_ID,
          AuthParameters: {
            REFRESH_TOKEN: refreshToken,
          },
        })
      );

      if (response.AuthenticationResult) {
        const newAccessToken = response.AuthenticationResult.AccessToken || '';
        const newIdToken = response.AuthenticationResult.IdToken || '';

        localStorage.setItem('accessToken', newAccessToken);
        localStorage.setItem('idToken', newIdToken);
        // Note: REFRESH_TOKEN_AUTH does not return a new refresh token
        setIdToken(newIdToken);
        setAuthToken(newIdToken);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Token refresh failed:', error);
      return false;
    }
  }, []);

  const startRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
    }
    refreshTimerRef.current = setInterval(async () => {
      const success = await refreshTokens();
      if (!success) {
        clearTokens();
      }
    }, REFRESH_INTERVAL_MS);
  }, [refreshTokens, clearTokens]);

  const loadUserFromToken = useCallback((): User | null => {
    // Build the user entirely from the ID-token claims the app already holds — no
    // GetUser round-trip. The ID token carries sub, email, name, custom:tier, and
    // cognito:groups (verified server-side; decoded here for display + UI gating only).
    const idToken = localStorage.getItem('idToken');
    const claims = decodeIdToken(idToken);
    if (!claims) return null;
    const groups = parseCognitoGroups(idToken);
    return {
      id: (claims.sub as string) || '',
      email: (claims.email as string) || '',
      tier: (claims['custom:tier'] as UserTier) || 'basic',
      name: claims.name as string | undefined,
      isAdmin: groups.includes('admins'),
    };
  }, []);

  const checkAuthState = useCallback(async () => {
    try {
      const accessToken = localStorage.getItem('accessToken');
      let idToken = localStorage.getItem('idToken');

      if (!accessToken || !idToken) {
        clearTokens();
        return;
      }

      // The user is built from the ID token locally (no GetUser round-trip), so an
      // expired token no longer surfaces as a network error — check expiry explicitly
      // and refresh before loading, preserving the resume-on-expiry behavior.
      let resumed = false;
      if (isTokenExpired(idToken)) {
        const refreshed = await refreshTokens();
        if (!refreshed) {
          clearTokens();
          return;
        }
        idToken = localStorage.getItem('idToken');
        resumed = true;
      }

      const loadedUser = loadUserFromToken();
      if (!loadedUser) {
        clearTokens();
        return;
      }
      setUser(loadedUser);
      setIdToken(idToken);
      setAuthToken(idToken);
      startRefreshTimer();
      trackEvent('session_started', {
        tier: loadedUser.tier || 'unknown',
        ...(resumed ? { resumed: true } : {}),
      });
    } catch (error) {
      console.error('Auth state check failed:', error);
      clearTokens();
    } finally {
      setIsLoading(false);
    }
  }, [clearTokens, refreshTokens, loadUserFromToken, startRefreshTimer]);

  // Check for existing session on mount
  useEffect(() => {
    checkAuthState();
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [checkAuthState]);

  // refreshCredentials — public Promise-returning wrapper around refreshTokens.
  // Resolves only after the new idToken is in localStorage + idToken state
  // has been updated; throws on refresh failure. MessagingProvider awaits
  // this in forceReconnect so the next WebSocket handshake uses fresh
  // credentials.
  const refreshCredentials = useCallback(async (): Promise<void> => {
    const ok = await refreshTokens();
    if (!ok) {
      throw new Error('Cognito token refresh failed (refresh token expired or invalid)');
    }
  }, [refreshTokens]);

  // Note: visibility-change handling lives in MessagingProvider as the
  // single driver. MessagingProvider awaits refreshCredentials() in its
  // forceReconnect path, so we don't fire a parallel refresh here that
  // would race against the WebSocket reconnect.

  // Persist Cognito tokens. The refresh token goes in sessionStorage
  // (tab-scoped) to shrink XSS-exfil blast radius; access + id tokens in
  // localStorage (short-lived, avoids re-auth on every tab open).
  const storeTokens = (auth: {
    AccessToken?: string;
    RefreshToken?: string;
    IdToken?: string;
  }): void => {
    localStorage.setItem('accessToken', auth.AccessToken || '');
    sessionStorage.setItem('refreshToken', auth.RefreshToken || '');
    localStorage.setItem('idToken', auth.IdToken || '');
  };

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
      if (accessToken) {
        await cognitoClient.send(
          new GlobalSignOutCommand({ AccessToken: accessToken })
        );
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
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
