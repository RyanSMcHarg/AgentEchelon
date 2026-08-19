/**
 * Concurrent callers must share ONE Identity-Pool credential exchange.
 *
 * The admin dashboard mounts and fires every section's analytics query at once. Each of the
 * seven-plus `identityPoolCredentials()` call sites used to invoke the Cognito provider before any
 * of them resolved, so Cognito saw ten identical GetId calls and answered
 * `TooManyRequestsException: Rate exceeded` on GetCredentialsForIdentity - a self-inflicted rate
 * limit on first paint. It was invisible in the product (the SDK retries, the tabs populate) and
 * showed up only as 400s in the browser console, which nothing was reading until the e2e console
 * guard was repaired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** One controllable pending exchange, so the test owns the timing. */
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const state: { calls: number; pending: Pending | null } = { calls: 0, pending: null };

vi.mock('@aws-sdk/client-cognito-identity', () => ({
  CognitoIdentityClient: class {},
}));

vi.mock('@aws-sdk/credential-provider-cognito-identity', () => ({
  fromCognitoIdentityPool: () => () => {
    state.calls += 1;
    return new Promise((resolve, reject) => {
      state.pending = { resolve, reject };
    });
  },
}));

// `sigv4Fetch` imports REGION / IDENTITY_POOL_ID / USER_POOL_ID / ensureFreshIdToken from the
// `@ae/shared` BARREL, so the barrel is what has to be mocked. An earlier version of this file
// mocked '@ae/shared/services/ensureFreshToken' - a path the module never imports - so the mock
// silently did nothing and these tests ran against the real shared module and whatever env the
// vitest config happened to load. They still passed, which is precisely the failure mode this suite
// keeps finding: green, having exercised something other than the thing under test.
vi.mock('@ae/shared', () => ({
  REGION: 'us-east-1',
  IDENTITY_POOL_ID: 'us-east-1:pool',
  USER_POOL_ID: 'us-east-1_pool',
  ApiError: class ApiError extends Error {},
  ensureFreshIdToken: async () => 'a-stable-id-token',
}));

/** Let the awaits inside identityPoolCredentials run before inspecting call counts. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const CREDS = {
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  sessionToken: 'token',
  expiration: new Date(Date.now() + 3_600_000),
};

describe('identityPoolCredentials — concurrent callers', () => {
  beforeEach(() => {
    state.calls = 0;
    state.pending = null;
  });

  it('collapses a concurrent burst into a single credential exchange', async () => {
    const mod = await import('./sigv4Fetch');
    mod.resetSignOnCredentials();

    // Ten callers with none resolved yet — the exact shape of dashboard mount.
    const inFlight = Array.from({ length: 10 }, () => mod.identityPoolCredentials());
    await flush();

    expect(
      state.calls,
      'each concurrent caller triggered its own Cognito exchange; that is what produced '
      + 'TooManyRequestsException on first paint',
    ).toBe(1);

    state.pending!.resolve(CREDS);
    const all = await Promise.all(inFlight);

    expect(all).toHaveLength(10);
    for (const c of all) expect(c.accessKeyId).toBe('AKIA');
    expect(state.calls).toBe(1);
  });

  it('serves a later caller from cache without a second exchange', async () => {
    const mod = await import('./sigv4Fetch');
    mod.resetSignOnCredentials();

    const first = mod.identityPoolCredentials();
    await flush();
    state.pending!.resolve(CREDS);
    await first;

    const second = await mod.identityPoolCredentials();
    expect(second.accessKeyId).toBe('AKIA');
    expect(state.calls, 'a cached, unexpired credential must not re-exchange').toBe(1);
  });

  it('does not cache a failure — one rate limit must not wedge every later read', async () => {
    const mod = await import('./sigv4Fetch');
    mod.resetSignOnCredentials();

    const failing = mod.identityPoolCredentials();
    await flush();
    state.pending!.reject(new Error('TooManyRequestsException: Rate exceeded'));
    await expect(failing).rejects.toThrow(/Rate exceeded/);

    // The next caller must get a FRESH attempt. Caching the rejected promise would make a single
    // transient rate limit permanent for the life of the page.
    const retry = mod.identityPoolCredentials();
    await flush();
    expect(state.calls, 'a failed exchange must not be cached').toBe(2);

    state.pending!.resolve(CREDS);
    expect((await retry).accessKeyId).toBe('AKIA');
  });
});
