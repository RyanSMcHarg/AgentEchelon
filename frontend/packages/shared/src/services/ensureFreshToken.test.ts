// @vitest-environment jsdom

/**
 * A REFRESH THAT OUTLIVES ITS SESSION WRITES NOTHING.
 *
 * `ensureFreshIdToken` refreshes outside React (the admin SigV4 path, the chat credential provider).
 * A sign-out while its `REFRESH_TOKEN_AUTH` is in flight clears storage; the refresh then resolves and,
 * unguarded, wrote `idToken` and `accessToken` straight back, signing the person in again. It now runs
 * under the same session epoch the AuthProvider's own refresh does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class {
    send = send;
  },
  InitiateAuthCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { ensureFreshIdToken } from './ensureFreshToken';
import { endSessionEpoch } from './sessionEpoch';

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}
const tokenExpiringIn = (seconds: number) => jwt({ exp: Math.floor(Date.now() / 1000) + seconds });

/** A Cognito answer the test releases when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const fresh = () => ({ AuthenticationResult: { IdToken: tokenExpiringIn(3600), AccessToken: 'new-access' } });

beforeEach(() => {
  send.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  endSessionEpoch();
});

describe('ensureFreshIdToken under the session epoch', () => {
  it('returns the stored token while it is live, asking Cognito nothing', async () => {
    const live = tokenExpiringIn(3600);
    localStorage.setItem('idToken', live);
    await expect(ensureFreshIdToken()).resolves.toBe(live);
    expect(send).not.toHaveBeenCalled();
  });

  it('refreshes and stores an expiring token within the same session', async () => {
    localStorage.setItem('idToken', tokenExpiringIn(-60));
    sessionStorage.setItem('refreshToken', 'refresh-token');
    const answer = fresh();
    send.mockResolvedValue(answer);
    await expect(ensureFreshIdToken()).resolves.toBe(answer.AuthenticationResult.IdToken);
    expect(localStorage.getItem('idToken')).toBe(answer.AuthenticationResult.IdToken);
    expect(localStorage.getItem('accessToken')).toBe('new-access');
  });

  it('discards a refresh that resolves after the session ended', async () => {
    localStorage.setItem('idToken', tokenExpiringIn(-60));
    sessionStorage.setItem('refreshToken', 'refresh-token');
    const cognito = deferred<ReturnType<typeof fresh>>();
    send.mockReturnValue(cognito.promise);

    const pending = ensureFreshIdToken();
    // The person signs out while Cognito is being asked.
    localStorage.clear();
    sessionStorage.clear();
    endSessionEpoch();
    cognito.resolve(fresh());

    await expect(pending).rejects.toThrow(/Session ended/);
    // THE POINT: nothing was written back over the sign-out.
    expect(localStorage.getItem('idToken')).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();
  });

  it('never hands a new session the refresh an old one started', async () => {
    localStorage.setItem('idToken', tokenExpiringIn(-60));
    sessionStorage.setItem('refreshToken', 'refresh-token');
    const old = deferred<ReturnType<typeof fresh>>();
    send.mockReturnValueOnce(old.promise);
    const oldCall = ensureFreshIdToken();

    endSessionEpoch();
    // A new session signs in and asks before the old refresh has answered.
    sessionStorage.setItem('refreshToken', 'new-refresh-token');
    const answer = fresh();
    send.mockResolvedValueOnce(answer);
    await expect(ensureFreshIdToken()).resolves.toBe(answer.AuthenticationResult.IdToken);
    expect(send).toHaveBeenCalledTimes(2);

    old.resolve(fresh());
    await expect(oldCall).rejects.toThrow(/Session ended/);
    // The new session's token survives the old refresh resolving.
    expect(localStorage.getItem('idToken')).toBe(answer.AuthenticationResult.IdToken);
  });
});
