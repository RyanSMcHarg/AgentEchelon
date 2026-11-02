/**
 * WHO CALLED, WITHOUT THE IDENTITIES TABLE, FOR EVERY SUITE.
 *
 * Every handler asks `callerPersonId` (lib/auth.ts) who called it, and on a token route that resolves the
 * token's `(registry id, subject)` through the `Identities` table. A suite about a handler would otherwise need a
 * table and an AppInstanceUser it is not about. Here the lookup answers the AppInstanceUser whose id is
 * the token's subject, in the app instance the suite configured, which keeps a suite's own fixtures
 * meaningful; a suite proving a handler keys on the PERSON rather than the subject overrides it with an
 * id that is not the subject (`mockResolvedValueOnce` on `resolvePerson`).
 *
 * The reverse lookup, `subjectsOfPerson`, answers the subject the person id names, in this deployment's
 * own pool, for the same reason: a suite's ids stay the subjects its directory fixtures key on. A suite
 * about a person signed in through another issuer overrides it the same way.
 *
 * The resolver itself is tested for real by `test/lib/person-identity.test.ts`, which unmocks it.
 */
jest.mock('../../lambda/src/lib/person-identity', () => {
  const resolvePerson = jest.fn(async (_issuer: string, subject: string) => {
    if (!subject) return null;
    const app = process.env.APP_INSTANCE_ARN || 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
    return `${app}/user/${subject}`;
  });
  const subjectsOfPerson = jest.fn(async (personArn: string) => {
    const id = /\/user\/([^/]+)$/.exec(String(personArn || ''))?.[1];
    if (!id) return [];
    // This deployment's own pool, by its trusted-issuer registry id (`lib/config/issuers.ts`).
    return [{ issuer: 'deployment', subject: id }];
  });
  const mocked: Record<string, unknown> = { resolvePerson, subjectsOfPerson };
  let actual: Record<string | symbol, unknown> | null = null;
  const real = (): Record<string | symbol, unknown> => (actual ??= jest.requireActual('../../lambda/src/lib/person-identity'));
  return new Proxy({}, {
    get: (_t, prop) => (prop === '__esModule' ? true : typeof prop === 'string' && prop in mocked ? mocked[prop] : real()[prop]),
    has: (_t, prop) => (typeof prop === 'string' && prop in mocked) || prop in real(),
  });
});
