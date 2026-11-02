// @vitest-environment jsdom

/**
 * A CONNECTIVITY FAILURE IS NOT A CREDENTIAL DECISION.
 *
 * `refreshTokens` used to return a bare boolean, and all three of its callers read a `false` the same
 * way: clear the tokens and send the person back to the sign-in screen. Cognito refusing a refresh
 * token and Cognito never being reached are not the same fact and do not have the same remedy.
 *
 * Observed live 2026-09-09, minutes after a fresh sign-in: the browser logged
 * `net::ERR_INTERNET_DISCONNECTED` against `cognito-idp.us-east-1.amazonaws.com`, and the app
 * reported "Cognito token refresh failed (refresh token expired or invalid)". The message was wrong,
 * and the action behind it was worse - `clearTokens` deletes the refresh token, which is the only way
 * back into a session, so a network blip landing on the scheduled refresh ends the session for good
 * rather than for the length of the outage.
 *
 * These tests hold the distinction at each of the three places it is acted on: the mount-time resume,
 * the scheduled refresh, and the explicit `refreshCredentials` that MessagingProvider awaits.
 */

import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The refresh command class is shared with the test so one case can hold the refresh open while
// letting the sign-out through. Hoisted with `send` because `vi.mock` is hoisted above the imports.
const { send, InitiateAuthCommand } = vi.hoisted(() => ({
  send: vi.fn(),
  InitiateAuthCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
}));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class {
    send = send;
  },
  InitiateAuthCommand,
  SignUpCommand: class {},
  ConfirmSignUpCommand: class {},
  RespondToAuthChallengeCommand: class {},
  ForgotPasswordCommand: class {},
  ConfirmForgotPasswordCommand: class {},
  ResendConfirmationCodeCommand: class {},
  GlobalSignOutCommand: class {},
  RevokeTokenCommand: class {},
}));

vi.mock('../services/eventTrackingService', () => ({
  setAuthToken: vi.fn(),
  trackEvent: vi.fn(),
}));

// THE EXCHANGE IS WHO THE PERSON IS. It answers with an ARN whose id is not the token's `sub`, which
// is the case the provider used to get wrong. The real `personIdentity` module runs on top of it.
const { exchange } = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('../services/credentialExchange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/credentialExchange')>()),
  exchangeCredentials: exchange,
}));

const INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/i';
const PERSON_ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const PERSON_ARN = `${INSTANCE}/user/${PERSON_ID}`;
const exchangeAnswer = (consoleRole: 'admins' | 'team-members' | null = null) => ({
  credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' },
  userArn: PERSON_ARN,
  tier: 'premium',
  consoleRole,
});

import {
  AuthProvider,
  useAuth,
  classifyRefreshFailure,
  sessionActionForOutcome,
  TOKEN_REFRESH_FAILURE_MESSAGE,
} from './AuthProvider';
import { ExchangeRefusedError } from '../services/credentialExchange';
import { endSessionEpoch } from '../services/sessionEpoch';

const REFRESH_INTERVAL_MS = 50 * 60 * 1000;

/** An unsigned JWT carrying the claims the provider reads. Signature checking is the backend's job. */
function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

const idTokenExpiringIn = (seconds: number) =>
  jwt({
    sub: 'user-1',
    email: 'someone@example.com',
    'custom:tier': 'premium',
    exp: Math.floor(Date.now() / 1000) + seconds,
  });

/** A live session in storage, with the ID token's remaining life under the caller's control. */
function seedSession(idToken: string) {
  localStorage.setItem('accessToken', 'access-token');
  localStorage.setItem('idToken', idToken);
  sessionStorage.setItem('refreshToken', 'refresh-token');
}

const offline = () =>
  Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' });

const refused = () =>
  Object.assign(new Error('Refresh Token has expired'), {
    name: 'NotAuthorizedException',
    $metadata: { httpStatusCode: 400 },
  });

const freshTokens = () => ({
  AuthenticationResult: {
    AccessToken: 'new-access-token',
    IdToken: idTokenExpiringIn(3600),
  },
});

type Auth = ReturnType<typeof useAuth>;

/** Mount the provider and hand back a live handle on its context. */
function mountAuth(): { current: () => Auth | null } {
  let ctx: Auth | null = null;
  const Probe: React.FC = () => {
    ctx = useAuth();
    return null;
  };
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  return { current: () => ctx };
}

beforeEach(() => {
  send.mockReset();
  exchange.mockReset().mockResolvedValue(exchangeAnswer());
  // A fresh session per test, so an identity cached by one test is never read by the next.
  endSessionEpoch();
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('classifying a refresh failure', () => {
  it('reads a fetch failure as unreachable, not as a refused token', () => {
    // THE CASE THE DEFECT WAS SEEN IN. A dropped connection surfaces as `TypeError: Failed to fetch`
    // and carries nothing that says anything about the token.
    expect(classifyRefreshFailure(offline())).toBe('unavailable');
  });

  it('reads Cognito refusing the token as refused', () => {
    expect(classifyRefreshFailure(refused())).toBe('rejected');
    expect(classifyRefreshFailure({ name: 'UserNotFoundException' })).toBe('rejected');
  });

  it('reads a throttle or a server fault as unreachable', () => {
    // Cognito answered, but the answer is "ask again" - not "this token is no good".
    expect(classifyRefreshFailure({ $metadata: { httpStatusCode: 429 } })).toBe('unavailable');
    expect(classifyRefreshFailure({ $metadata: { httpStatusCode: 503 } })).toBe('unavailable');
    expect(classifyRefreshFailure({ $metadata: { httpStatusCode: 408 } })).toBe('unavailable');
  });

  it('reads any other 4xx as an answer from Cognito', () => {
    expect(classifyRefreshFailure({ $metadata: { httpStatusCode: 403 } })).toBe('rejected');
  });

  it('treats an unrecognizable failure as unreachable', () => {
    // Chosen deliberately: keeping a session that turns out to be dead costs one more failed
    // refresh, while discarding one that was only unreachable costs the person their session.
    expect(classifyRefreshFailure(new Error('who knows'))).toBe('unavailable');
    expect(classifyRefreshFailure(undefined)).toBe('unavailable');
  });
});

describe('what a session does about an outcome', () => {
  it('only ends a session on an answer from Cognito', () => {
    expect(sessionActionForOutcome('refreshed')).toBe('adopt');
    expect(sessionActionForOutcome('unavailable')).toBe('retry');
    expect(sessionActionForOutcome('rejected')).toBe('sign-out');
    expect(sessionActionForOutcome('absent')).toBe('sign-out');
  });
});

describe('resuming a session while Cognito is unreachable', () => {
  it('keeps the refresh token instead of signing the person out', async () => {
    seedSession(idTokenExpiringIn(-60)); // expired, so the mount check must refresh
    send.mockRejectedValue(offline());

    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isLoading).toBe(false));

    // THE POINT. The refresh token is the only way back into this session and nothing that happened
    // says it is bad, so a reload during an outage must not be a permanent sign-out.
    expect(sessionStorage.getItem('refreshToken')).toBe('refresh-token');
    expect(auth.current()?.isAuthenticated).toBe(false);
  });

  it('signs the person out when Cognito refuses the token', async () => {
    seedSession(idTokenExpiringIn(-60));
    send.mockRejectedValue(refused());

    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isLoading).toBe(false));

    expect(sessionStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.getItem('idToken')).toBeNull();
    expect(auth.current()?.isAuthenticated).toBe(false);
  });

  it('recovers the session on the retry, without a reload', async () => {
    vi.useFakeTimers();
    seedSession(idTokenExpiringIn(-60));
    send.mockRejectedValueOnce(offline()).mockResolvedValue(freshTokens());

    const auth = mountAuth();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(auth.current()?.isAuthenticated).toBe(false);

    // The retry backs off from 30s. Nothing about it needs the person to do anything.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(auth.current()?.isAuthenticated).toBe(true);
    expect(auth.current()?.user?.email).toBe('someone@example.com');
  });

  it('takes the browser coming back online as a reason to stop waiting', async () => {
    vi.useFakeTimers();
    seedSession(idTokenExpiringIn(-60));
    send.mockRejectedValueOnce(offline()).mockResolvedValue(freshTokens());

    const auth = mountAuth();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(auth.current()?.isAuthenticated).toBe(false);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(auth.current()?.isAuthenticated).toBe(true);
  });
});

describe('the scheduled refresh', () => {
  it('does not end a live session because one refresh could not reach Cognito', async () => {
    vi.useFakeTimers();
    seedSession(idTokenExpiringIn(3600)); // valid, so the mount adopts it without refreshing

    const auth = mountAuth();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(auth.current()?.isAuthenticated).toBe(true);

    send.mockRejectedValue(offline());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });

    // Fifty minutes of being offline is not evidence about a refresh token.
    expect(auth.current()?.isAuthenticated).toBe(true);
    expect(sessionStorage.getItem('refreshToken')).toBe('refresh-token');
  });

  it('ends the session when the scheduled refresh is refused', async () => {
    vi.useFakeTimers();
    seedSession(idTokenExpiringIn(3600));

    const auth = mountAuth();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(auth.current()?.isAuthenticated).toBe(true);

    send.mockRejectedValue(refused());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });

    expect(auth.current()?.isAuthenticated).toBe(false);
    expect(sessionStorage.getItem('refreshToken')).toBeNull();
  });
});

describe('refreshCredentials, which MessagingProvider awaits', () => {
  it('names the connectivity failure rather than blaming the token', async () => {
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));

    send.mockRejectedValue(offline());
    await expect(auth.current()!.refreshCredentials()).rejects.toThrow(
      TOKEN_REFRESH_FAILURE_MESSAGE.unavailable,
    );
    // THE STRING THE DEFECT WAS READ IN, and the reason a real outage was chased as an auth problem.
    await expect(auth.current()!.refreshCredentials()).rejects.not.toThrow(
      /expired or invalid/,
    );
  });

  it('says so plainly when Cognito refuses the token', async () => {
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));

    send.mockRejectedValue(refused());
    await expect(auth.current()!.refreshCredentials()).rejects.toThrow(
      TOKEN_REFRESH_FAILURE_MESSAGE.rejected,
    );
  });

  it('distinguishes a tab that holds no refresh token at all', async () => {
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));

    // `storeTokens` writes '' when a login response carried no refresh token, and reporting that as
    // an expired token sends the reader hunting for a TTL that was never the problem.
    sessionStorage.setItem('refreshToken', '');
    await expect(auth.current()!.refreshCredentials()).rejects.toThrow(
      TOKEN_REFRESH_FAILURE_MESSAGE.absent,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('signing out while a refresh is already in flight', () => {
  /**
   * A CLEARED TIMEOUT DOES NOT CANCEL AN IN-FLIGHT PROMISE.
   *
   * The retry nulls its own timer handle and then awaits Cognito, so a sign-out during that round
   * trip finds nothing to cancel. The refresh resolves a moment later and writes `accessToken` and
   * `idToken` straight back over what was just cleared, and the session is adopted from them - so the
   * person signed out and was silently signed back in.
   */
  it('discards tokens that arrive after the session has ended', async () => {
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));

    // Hold the REFRESH open so the sign-out lands strictly inside its round trip, while the sign-out
    // call itself answers at once - `logout` awaits GlobalSignOut through this same client, so a mock
    // that held both would deadlock the test on its own fixture rather than on the defect.
    let answer: (value: unknown) => void = () => {};
    send.mockImplementation((cmd: unknown) => (cmd instanceof InitiateAuthCommand
      ? new Promise((resolve) => { answer = resolve; })
      : Promise.resolve({})));

    const inFlight = auth.current()!.refreshCredentials().catch(() => undefined);
    await act(async () => {
      auth.current()!.logout();
    });
    expect(localStorage.getItem('idToken')).toBeNull();

    // Cognito now answers, successfully, for a session that no longer exists.
    await act(async () => {
      answer(freshTokens());
      await inFlight;
    });

    expect(localStorage.getItem('idToken')).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(auth.current()?.isAuthenticated).toBe(false);
  });

  it('still applies tokens when no sign-out happened', async () => {
    // Non-vacuity: a guard that discarded everything would pass the test above.
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));

    send.mockResolvedValue(freshTokens());
    await act(async () => {
      await auth.current()!.refreshCredentials();
    });

    expect(localStorage.getItem('idToken')).toBeTruthy();
    expect(auth.current()?.isAuthenticated).toBe(true);
  });
});

describe('the classification on the session', () => {
  it('is absent when the ID token names none, never a guessed floor', async () => {
    seedSession(jwt({ sub: 'user-1', email: 'someone@example.com', exp: Math.floor(Date.now() / 1000) + 3600 }));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));
    expect(auth.current()?.user?.tier).toBeUndefined();
  });

  it('is the one the ID token names', async () => {
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));
    expect(auth.current()?.user?.tier).toBe('premium');
  });
});

describe('who the person is', () => {
  it('is the AppInstanceUser the exchange returned, not the token subject', async () => {
    seedSession(idTokenExpiringIn(3600)); // the token's sub is 'user-1'
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));

    expect(auth.current()?.user?.id).toBe(PERSON_ID);
    expect(auth.current()?.user?.id).not.toBe('user-1');
    expect(auth.current()?.user?.userArn).toBe(PERSON_ARN);
    // The exchange is asked with the token, which is how it knows who to resolve.
    expect(exchange).toHaveBeenCalledWith({}, localStorage.getItem('idToken'));
  });

  it('takes the admin flag from the exchange, never from the token groups', async () => {
    seedSession(jwt({
      sub: 'user-1',
      email: 'someone@example.com',
      'cognito:groups': ['admins'],
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));
    // The token claims `admins`; the exchange reports no console role. The exchange is the answer.
    expect(auth.current()?.user?.isAdmin).toBe(false);
  });

  it('is an admin when the exchange reports the admins console role', async () => {
    exchange.mockResolvedValue(exchangeAnswer('admins'));
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isAuthenticated).toBe(true));
    expect(auth.current()?.user?.isAdmin).toBe(true);
  });

  it('signs out when the exchange refuses the sign-in', async () => {
    exchange.mockRejectedValue(new ExchangeRefusedError('this sign-in is not active', 403, 'PERSON_NOT_ACTIVE'));
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await waitFor(() => expect(auth.current()?.isLoading).toBe(false));
    expect(auth.current()?.isAuthenticated).toBe(false);
    expect(sessionStorage.getItem('refreshToken')).toBeNull();
  });

  it('keeps the session when the exchange cannot be reached, and adopts it on the retry', async () => {
    vi.useFakeTimers();
    exchange.mockRejectedValueOnce(offline()).mockResolvedValue(exchangeAnswer());
    send.mockResolvedValue(freshTokens());
    seedSession(idTokenExpiringIn(3600));
    const auth = mountAuth();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(auth.current()?.isAuthenticated).toBe(false);
    expect(sessionStorage.getItem('refreshToken')).toBe('refresh-token');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(auth.current()?.isAuthenticated).toBe(true);
    expect(auth.current()?.user?.id).toBe(PERSON_ID);
  });
});
