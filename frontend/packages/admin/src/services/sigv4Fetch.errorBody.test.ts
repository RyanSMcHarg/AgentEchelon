/**
 * A REFUSAL KEEPS ITS BODY.
 *
 * Every admin route is signed, so a refusal reaches the console through `sigv4Fetch` rather than the
 * unsigned `apiCall`. The experiments tab's conflict-resolution flow renders the blockers a 409 names in
 * its `conflicts` array; when the signed client threw only the message, the panel had nothing to show and
 * the operator saw no way forward. Measured by the experiments e2e (E2, E3) before this was fixed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@ae/shared', () => ({
  REGION: 'us-east-1',
  USER_POOL_ID: 'us-east-1_pool',
  ApiError: class ApiError extends Error {
    status: number;
    body?: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
  ensureFreshIdToken: async () => 'token',
}));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));

const CREDS = { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' };
type Refusal = { status: number; message: string; body?: unknown };

describe('a signed request that is refused', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'classification already holds a live experiment', conflicts: [{ experimentId: 'blocker' }] }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));
  });

  it('carries the parsed body on the error, so a 409 still names its conflicts', async () => {
    const { sigv4PostJson } = await import('./sigv4Fetch');
    const err = await sigv4PostJson('https://api.example.com/prod/admin/experiments', {}, CREDS).catch((e: Refusal) => e) as Refusal;
    expect(err.status).toBe(409);
    expect(err.message).toBe('classification already holds a live experiment');
    expect(err.body).toEqual({ error: 'classification already holds a live experiment', conflicts: [{ experimentId: 'blocker' }] });
  });

  it('does the same for a signed GET and DELETE', async () => {
    const { sigv4GetJson, sigv4Delete } = await import('./sigv4Fetch');
    for (const call of [
      () => sigv4GetJson('https://api.example.com/prod/x', {}, CREDS),
      () => sigv4Delete('https://api.example.com/prod/x', CREDS),
    ]) {
      const err = await call().catch((e: Refusal) => e) as Refusal;
      expect((err.body as { conflicts: unknown[] }).conflicts).toHaveLength(1);
    }
  });
});
