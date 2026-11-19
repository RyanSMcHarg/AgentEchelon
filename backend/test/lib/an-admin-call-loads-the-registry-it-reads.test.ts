/**
 * AN ADMIN CALL LOADS THE REGISTRY IT READS. `requireAdmin` resolves an IAM-signed admin's clearance from the deployment's
 * profile registry, and a deployed registry throws on any read until it is loaded. So the auth seam loads it itself, and an
 * admin route resolves its caller whatever its handler does first.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

test('requireAdmin resolves an IAM-signed admin on a handler that has not loaded the registry', async () => {
  process.env.ADMIN_AUTH_MODE = 'ae-cognito';
  process.env.ADMIN_IAM_ENFORCEMENT = 'true';
  let loaded = false;
  const load = jest.fn(async () => { loaded = true; });
  let auth!: typeof import('../../lambda/src/lib/auth');
  jest.isolateModules(() => {
    jest.doMock('../../lib/profile-registry', () => {
      const actual = jest.requireActual('../../lib/profile-registry');
      // As deployed: any read before the load throws, the way the guarded registry does.
      const guarded = new Proxy({ resolveHolderToken: () => 'admin' } as Record<string, unknown>, {
        get(target, prop, receiver) {
          if (!loaded) throw new Error(`profile registry: read (${String(prop)}) before it was loaded`);
          return Reflect.get(target, prop, receiver);
        },
      });
      return { ...actual, defaultProfileRegistry: guarded, loadProfileRegistry: load };
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    auth = require('../../lambda/src/lib/auth');
  });
  const event = { requestContext: { identity: { userArn: 'arn:aws:sts::111:assumed-role/AdminAuthenticatedRole/abc' } } } as unknown as APIGatewayProxyEvent;

  const guard = await auth.requireAdmin(event);

  expect(load).toHaveBeenCalled();
  expect('claims' in guard && guard.claims.clearance).toBe('admin');
});
