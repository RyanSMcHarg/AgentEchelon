/**
 * Admin-plane auth gate (lib/auth) — covers the configurable admin claim
 * (ADMIN_GROUP_NAMES) and the three admin auth modes that back
 * docs/ADMIN-INTEGRATION-GUIDE.md. ADMIN_GROUPS is resolved at module load,
 * so each env scenario re-imports the module via jest.resetModules().
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

type AuthModule = typeof import('../../lambda/src/lib/auth');

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

// Sets the env (ADMIN_GROUP_NAMES is read at module load; ADMIN_AUTH_MODE is
// read per-call) and re-imports the module under it. Env stays set for the
// duration of the test and is restored in afterEach.
function loadAuth(env: Record<string, string | undefined>): AuthModule {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod: AuthModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../lambda/src/lib/auth') as AuthModule;
  });
  return mod!;
}

function eventWith(claims: Record<string, unknown> | null, identity?: Record<string, unknown>) {
  return {
    requestContext: {
      authorizer: claims ? { claims } : undefined,
      identity,
    },
  } as unknown as APIGatewayProxyEvent;
}

describe('callerIsAdmin — ae-cognito (default)', () => {
  test('admin when cognito:groups contains the default "admins", even without sub', () => {
    const auth = loadAuth({ ADMIN_GROUP_NAMES: undefined, ADMIN_AUTH_MODE: undefined });
    expect(auth.callerIsAdmin(eventWith({ 'cognito:groups': 'admins,premium' }))).toBe(true);
    expect(auth.callerIsAdmin(eventWith({ 'cognito:groups': ['admins'] }))).toBe(true);
  });

  test('not admin for non-admin groups or missing claims', () => {
    const auth = loadAuth({ ADMIN_GROUP_NAMES: undefined, ADMIN_AUTH_MODE: undefined });
    expect(auth.callerIsAdmin(eventWith({ 'cognito:groups': 'premium,standard' }))).toBe(false);
    expect(auth.callerIsAdmin(eventWith({ sub: 'u1' }))).toBe(false);
    expect(auth.callerIsAdmin(eventWith(null))).toBe(false);
  });
});

describe('callerIsAdmin — ADMIN_GROUP_NAMES override (federated)', () => {
  test('admin keys on the configured claim, not the literal "admins"', () => {
    const auth = loadAuth({ ADMIN_GROUP_NAMES: 'operators,partner-admins', ADMIN_AUTH_MODE: 'federated' });
    expect(auth.callerIsAdmin(eventWith({ 'cognito:groups': 'operators' }))).toBe(true);
    expect(auth.callerIsAdmin(eventWith({ 'cognito:groups': ['partner-admins'] }))).toBe(true);
    // The legacy "admins" group is NOT admin once overridden.
    expect(auth.callerIsAdmin(eventWith({ 'cognito:groups': 'admins' }))).toBe(false);
  });
});

describe('admin auth — service mode (IAM-signed)', () => {
  test('an IAM-signed call is admin even with no Cognito claims', () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'service' });
    const ev = eventWith(null, { userArn: 'arn:aws:iam::111:role/host-proxy' });
    expect(auth.isServiceAdminCall(ev)).toBe(true);
    expect(auth.callerIsAdmin(ev)).toBe(true);
    const guard = auth.requireAdmin(ev);
    expect('claims' in guard).toBe(true);
    if ('claims' in guard) {
      expect(guard.claims.sub).toBe('arn:aws:iam::111:role/host-proxy');
      expect(guard.claims.tier).toBe('admins');
    }
  });

  test('service mode without an IAM identity is not admin (fails closed)', () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'service' });
    const ev = eventWith(null, {});
    expect(auth.isServiceAdminCall(ev)).toBe(false);
    expect(auth.callerIsAdmin(ev)).toBe(false);
  });

  test('outside service mode, a present IAM identity does NOT grant admin', () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'ae-cognito' });
    const ev = eventWith(null, { userArn: 'arn:aws:iam::111:role/host-proxy' });
    expect(auth.isServiceAdminCall(ev)).toBe(false);
    expect(auth.callerIsAdmin(ev)).toBe(false);
  });
});

describe('requireAdmin — Cognito modes', () => {
  test('returns claims for an admin and a 403 result for a non-admin', () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: undefined });
    const ok = auth.requireAdmin(eventWith({ sub: 'a1', 'cognito:groups': 'admins' }));
    expect('claims' in ok).toBe(true);
    const denied = auth.requireAdmin(eventWith({ sub: 'u1', 'cognito:groups': 'standard' }));
    expect('statusCode' in denied && denied.statusCode).toBe(403);
  });
});
