/**
 * Concurrent callers must share ONE console-session request.
 *
 * The admin dashboard mounts and fires every section's analytics query at once. Each of the seven-plus
 * `consoleCredentials()` call sites would otherwise ask the credential exchange for a session before any
 * of them resolved - a burst of identical requests on first paint, measured once as the credential
 * source answering `TooManyRequestsException`. The session comes from the exchange, so the same burst
 * would land there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** One controllable pending exchange, so the test owns the timing. */
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const state: { calls: number; pending: Pending | null } = { calls: 0, pending: null };

/** The exchange's answer for a console session, built from the credentials a test resolves with. */
const sessionResponse = (c: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }) => ({
  ok: true,
  status: 200,
  json: async () => ({
    credentials: {
      AccessKeyId: c.accessKeyId,
      SecretAccessKey: c.secretAccessKey,
      SessionToken: c.sessionToken,
      Expiration: c.expiration.toISOString(),
    },
    identity: 'console',
    role: 'admins',
    capabilities: ['view-analytics'],
  }),
});

vi.stubGlobal('fetch', () => {
  state.calls += 1;
  return new Promise((resolve, reject) => {
    state.pending = { resolve: (v) => resolve(sessionResponse(v as never)), reject };
  });
});

// `sigv4Fetch` imports REGION / USER_POOL_ID / ensureFreshIdToken from the
// `@ae/shared` BARREL, so the barrel is what has to be mocked. An earlier version of this file
// mocked '@ae/shared/services/ensureFreshToken' - a path the module never imports - so the mock
// silently did nothing and these tests ran against the real shared module and whatever env the
// vitest config happened to load. They still passed, which is precisely the failure mode this suite
// keeps finding: green, having exercised something other than the thing under test.
vi.mock('@ae/shared', () => ({
  REGION: 'us-east-1',
  USER_POOL_ID: 'us-east-1_pool',
  ApiError: class ApiError extends Error {},
  ensureFreshIdToken: async () => 'a-stable-id-token',
  // The person exchange the console signs in at first. It answers at once: the call under count is the
  // admin exchange's console session.
  exchangeCredentials: async () => ({}),
}));
vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.com/');

/** Let the awaits inside consoleCredentials run before inspecting call counts. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const CREDS = {
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  sessionToken: 'token',
  expiration: new Date(Date.now() + 3_600_000),
};

describe('consoleCredentials — concurrent callers', () => {
  beforeEach(() => {
    state.calls = 0;
    state.pending = null;
  });

  it('collapses a concurrent burst into a single credential exchange', async () => {
    const mod = await import('./sigv4Fetch');
    mod.resetSignOnCredentials();

    // Ten callers with none resolved yet — the exact shape of dashboard mount.
    const inFlight = Array.from({ length: 10 }, () => mod.consoleCredentials());
    await flush();

    expect(
      state.calls,
      'each concurrent caller triggered its own console-session request; that is what produced '
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

    const first = mod.consoleCredentials();
    await flush();
    state.pending!.resolve(CREDS);
    await first;

    const second = await mod.consoleCredentials();
    expect(second.accessKeyId).toBe('AKIA');
    expect(state.calls, 'a cached, unexpired credential must not re-exchange').toBe(1);
  });

  it('does not cache a failure — one rate limit must not wedge every later read', async () => {
    const mod = await import('./sigv4Fetch');
    mod.resetSignOnCredentials();

    const failing = mod.consoleCredentials();
    await flush();
    state.pending!.reject(new Error('TooManyRequestsException: Rate exceeded'));
    await expect(failing).rejects.toThrow(/Rate exceeded/);

    // The next caller must get a FRESH attempt. Caching the rejected promise would make a single
    // transient rate limit permanent for the life of the page.
    const retry = mod.consoleCredentials();
    await flush();
    expect(state.calls, 'a failed exchange must not be cached').toBe(2);

    state.pending!.resolve(CREDS);
    expect((await retry).accessKeyId).toBe('AKIA');
  });
});
