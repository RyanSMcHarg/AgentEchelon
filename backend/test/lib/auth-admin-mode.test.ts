/**
 * Admin-plane auth gate (lib/auth) — covers the configurable admin claim
 * (ADMIN_GROUP_NAMES) and the three admin auth modes that back
 * docs/ADMIN-INTEGRATION-GUIDE.md. ADMIN_GROUPS is resolved at module load,
 * so each env scenario re-imports the module via jest.resetModules().
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { edgeContext } from '../helpers/edge-context';

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

// A person's token reaches a handler as the edge authorizer's context; an IAM-signed call carries an identity.
function eventWith(claims: Record<string, unknown> | null, identity?: Record<string, unknown>) {
  return {
    requestContext: {
      authorizer: claims ? edgeContext({ claims }) : undefined,
      identity,
    },
  } as unknown as APIGatewayProxyEvent;
}

describe('callerIsAdmin — ae-cognito (default)', () => {
  test('admin when cognito:groups contains the default "admins"', () => {
    const auth = loadAuth({ ADMIN_GROUP_NAMES: undefined, ADMIN_AUTH_MODE: undefined });
    expect(auth.callerIsAdmin(eventWith({ sub: 'a1', 'cognito:groups': 'admins,premium' }))).toBe(true);
    expect(auth.callerIsAdmin(eventWith({ sub: 'a1', 'cognito:groups': ['admins'] }))).toBe(true);
  });

  test('not admin when the edge resolved no subject, whatever groups the claims carry', () => {
    // The edge admits a token only with the subject its issuer declares, so a context without one names nobody.
    const auth = loadAuth({ ADMIN_GROUP_NAMES: undefined, ADMIN_AUTH_MODE: undefined });
    expect(auth.callerIsAdmin(eventWith({ 'cognito:groups': 'admins' }))).toBe(false);
  });

  test('not admin for non-admin groups or missing claims', () => {
    const auth = loadAuth({ ADMIN_GROUP_NAMES: undefined, ADMIN_AUTH_MODE: undefined });
    expect(auth.callerIsAdmin(eventWith({ sub: 'u1', 'cognito:groups': 'premium,standard' }))).toBe(false);
    expect(auth.callerIsAdmin(eventWith({ sub: 'u1' }))).toBe(false);
    expect(auth.callerIsAdmin(eventWith(null))).toBe(false);
  });
});

describe('callerIsAdmin — ADMIN_GROUP_NAMES override', () => {
  test('admin keys on the configured claim, not the literal "admins"', () => {
    const auth = loadAuth({ ADMIN_GROUP_NAMES: 'operators,partner-admins', ADMIN_AUTH_MODE: 'ae-cognito' });
    expect(auth.callerIsAdmin(eventWith({ sub: 'a1', 'cognito:groups': 'operators' }))).toBe(true);
    expect(auth.callerIsAdmin(eventWith({ sub: 'a1', 'cognito:groups': ['partner-admins'] }))).toBe(true);
    // The legacy "admins" group is NOT admin once overridden.
    expect(auth.callerIsAdmin(eventWith({ sub: 'a1', 'cognito:groups': 'admins' }))).toBe(false);
  });
});

describe('admin auth — service mode (IAM-signed)', () => {
  test('an IAM-signed call is admin even with no Cognito claims', async () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'service' });
    const ev = eventWith(null, { userArn: 'arn:aws:iam::111:role/host-proxy' });
    expect(auth.isServiceAdminCall(ev)).toBe(true);
    expect(auth.callerIsAdmin(ev)).toBe(true);
    const guard = await auth.requireAdmin(ev);
    expect('claims' in guard).toBe(true);
    if ('claims' in guard) {
      expect(guard.claims.personId).toBeNull();
      expect(guard.claims.actor).toBe('arn:aws:iam::111:role/host-proxy');
      // THE CLASSIFICATION, not the group name. This expected `admins`, which is the Cognito GROUP;
      // the classification the shipped config maps that group to is `admin`, and the registry
      // resolves it rather than this file naming either one.
      expect(guard.claims.clearance).toBe('admin');
      expect(guard.claims.groups).toEqual(['admins']);
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

describe('admin auth — A14 per-resource IAM enforcement (adminIamEnforcement)', () => {
  const iamEv = eventWith(null, { userArn: 'arn:aws:sts::111:assumed-role/AdminAuthenticatedRole/abc' });

  test('an IAM-signed call is trusted when ADMIN_IAM_ENFORCEMENT=true (gateway already vetted the capability)', async () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'ae-cognito', ADMIN_IAM_ENFORCEMENT: 'true' });
    expect(auth.isAdminIamEnforcedCall(iamEv)).toBe(true);
    expect(auth.callerIsAdmin(iamEv)).toBe(true);
    expect(auth.callerCanReadArchive(iamEv)).toBe(true);
    const guard = await auth.requireAdmin(iamEv);
    expect('claims' in guard).toBe(true);
    if ('claims' in guard) {
      // Actor derived from the signed principal.
      expect(guard.claims.personId).toBeNull();
      expect(guard.claims.actor).toBe('arn:aws:sts::111:assumed-role/AdminAuthenticatedRole/abc');
      expect(guard.claims.clearance).toBe('admin');
    }
  });

  test('without the flag, the same IAM-signed call is NOT trusted (fails closed)', () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'ae-cognito', ADMIN_IAM_ENFORCEMENT: undefined });
    expect(auth.isAdminIamEnforcedCall(iamEv)).toBe(false);
    expect(auth.callerIsAdmin(iamEv)).toBe(false);
    expect(auth.callerCanReadArchive(iamEv)).toBe(false);
  });

  test('flag on but no IAM identity present is NOT trusted (fails closed)', () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'ae-cognito', ADMIN_IAM_ENFORCEMENT: 'true' });
    expect(auth.isAdminIamEnforcedCall(eventWith(null, {}))).toBe(false);
    expect(auth.callerIsAdmin(eventWith(null, {}))).toBe(false);
  });

  test('a Cognito-JWT call under the flag still resolves via the group gate (fallback)', () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'ae-cognito', ADMIN_IAM_ENFORCEMENT: 'true' });
    expect(auth.callerCanReadArchive(eventWith({ sub: 'a1', 'cognito:groups': 'admins' }))).toBe(true);
    expect(auth.callerCanReadArchive(eventWith({ sub: 'u1', 'cognito:groups': 'standard' }))).toBe(false);
  });
});

describe('requireAdmin — Cognito modes', () => {
  test('returns claims for an admin and a 403 result for a non-admin', async () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: undefined });
    const ok = await auth.requireAdmin(eventWith({ sub: 'a1', 'cognito:groups': 'admins' }));
    expect('claims' in ok).toBe(true);
    const denied = await auth.requireAdmin(eventWith({ sub: 'u1', 'cognito:groups': 'standard' }));
    expect('statusCode' in denied && denied.statusCode).toBe(403);
  });
});

/**
 * AN ADMIN ROUTE ADMITS ONLY THIS INSTANCE'S ADMINISTRATORS (tenet D3, the second layer behind the gateway).
 *
 * The gateway refuses a principal without `execute-api:Invoke` on the route. Behind it, a console or admin-plane
 * session is admitted only on this instance's own roles, by name, and a team session only on a team route, so a
 * grant that reaches further than it should (another instance's session in the same account, a team session on
 * an administrator's route) is still refused here.
 */
describe('admin auth: only this instance\'s administrators', () => {
  const ENFORCED = { ADMIN_AUTH_MODE: 'ae-cognito', ADMIN_IAM_ENFORCEMENT: 'true' };
  const PERSON = '0192f0e0-0000-7000-8000-0000000000a1';
  const signedOn = (role: string, session: string, at = '/admin/conversations') => ({
    ...eventWith(null, { userArn: `arn:aws:sts::111:assumed-role/${role}/${session}` }),
    path: at,
    resource: at,
  }) as unknown as APIGatewayProxyEvent;

  test('this instance\'s admin console session and admin plane are admitted', async () => {
    const auth = loadAuth(ENFORCED);
    for (const ev of [signedOn('agent-echelon-admin-console', `console-${PERSON}`), signedOn('agent-echelon-admin-plane', `archive-${PERSON}`)]) {
      expect(auth.trustedIamAdminPrincipal(ev)).toBe('admin');
      expect(auth.callerIsAdmin(ev)).toBe(true);
      expect('claims' in await auth.requireAdmin(ev)).toBe(true);
    }
    expect(auth.isAdminConsoleSession(signedOn('agent-echelon-admin-console', `console-${PERSON}`))).toBe(true);
  });

  test.each([
    ['another instance\'s admin console session', 'acme-admin-console', `console-${PERSON}`],
    ['another instance\'s admin plane', 'acme-admin-plane', `archive-${PERSON}`],
    ['another instance\'s team console session', 'acme-team-console', `console-${PERSON}@standard`],
    ['a person\'s chat credential', 'agent-echelon-exchange-premium', PERSON],
    ['another instance\'s person credential', 'acme-exchange-admin', PERSON],
  ])('%s is refused', async (_label, role, session) => {
    const auth = loadAuth(ENFORCED);
    const ev = signedOn(role, session);
    expect(auth.trustedIamAdminPrincipal(ev)).toBeNull();
    expect(auth.callerIsAdmin(ev)).toBe(false);
    expect(auth.callerCanReadArchive(ev)).toBe(false);
    expect(auth.callerCanManageProfiles(ev)).toBe(false);
    expect(auth.callerCanManageAssistants(ev)).toBe(false);
    expect(auth.callerCanSeeUserIdentity(ev)).toBe(false);
    expect(auth.isAdminConsoleSession(ev)).toBe(false);
    // Refused: 403 when the session names a person who is not an admin here, 401 when it names nobody.
    const guard = await auth.requireAdmin(ev);
    expect('statusCode' in guard && [401, 403].includes(guard.statusCode)).toBe(true);
  });

  test('another instance\'s session is refused in service mode too', () => {
    const auth = loadAuth({ ADMIN_AUTH_MODE: 'service' });
    expect(auth.callerIsAdmin(signedOn('acme-admin-console', `console-${PERSON}`))).toBe(false);
    expect(auth.callerIsAdmin(signedOn('agent-echelon-admin-console', `console-${PERSON}`))).toBe(true);
  });

  test('a team console session is refused on an administrator\'s route, and admitted on its team route', async () => {
    const auth = loadAuth(ENFORCED);
    const team = `console-${PERSON}@standard`;
    for (const route of ['/admin/conversations', '/admin/tasks/channel/{channelId}', '/admin/templates/save', '/admin/profiles/activate']) {
      const ev = signedOn('agent-echelon-team-console', team, route);
      expect([route, auth.trustedIamAdminPrincipal(ev)]).toEqual([route, null]);
      expect([route, auth.callerIsAdmin(ev)]).toEqual([route, false]);
      const guard = await auth.requireAdmin(ev);
      expect([route, 'statusCode' in guard && guard.statusCode]).toEqual([route, 403]);
    }
    for (const route of ['/admin/assistants/{assistant}/profiles', '/query/analytics/assistants/{assistant}/query', '/admin/teams/{team}/roster']) {
      expect([route, auth.trustedIamAdminPrincipal(signedOn('agent-echelon-team-console', team, route))]).toEqual([route, 'team']);
    }
    // The matched route decides, not a path segment that happens to read like one.
    const channelNamedAssistants = {
      ...signedOn('agent-echelon-team-console', team, '/admin/conversations/assistants/messages'),
      resource: '/admin/conversations/{channelId}/messages',
    } as unknown as APIGatewayProxyEvent;
    expect(auth.trustedIamAdminPrincipal(channelNamedAssistants)).toBeNull();
  });

  test('a handler not told this instance\'s roles admits none of its sessions', () => {
    const auth = loadAuth({ ...ENFORCED, ADMIN_CONSOLE_ROLE_NAME: undefined, TEAM_CONSOLE_ROLE_NAME: undefined, ADMIN_PLANE_ROLE_NAME: undefined });
    expect(auth.callerIsAdmin(signedOn('agent-echelon-admin-console', `console-${PERSON}`))).toBe(false);
    expect(auth.callerIsAdmin(signedOn('agent-echelon-admin-plane', `archive-${PERSON}`))).toBe(false);
    expect(auth.isAdminConsoleSession(signedOn('agent-echelon-admin-console', `console-${PERSON}`))).toBe(false);
  });

  test('an operator\'s own signed credential, which no instance mints, is admitted', () => {
    const auth = loadAuth(ENFORCED);
    expect(auth.callerIsAdmin(eventWith(null, { userArn: 'arn:aws:iam::111:user/operator' }))).toBe(true);
    expect(auth.callerIsAdmin(signedOn('AWSReservedSSO_AdministratorAccess_0123', 'operator@example.com'))).toBe(true);
  });
});
