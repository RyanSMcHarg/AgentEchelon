/**
 * WHETHER AN ACCOUNT MAY STILL SIGN IN, WITHOUT A POOL, FOR EVERY SUITE.
 *
 * Both credential exchanges ask the caller's issuer at every vend whether the account may still sign in
 * (`refuseInactiveAccount`, lib/vend.ts, through `defaultDirectory().accountState`), and the list of people
 * asks the same of a person of another pool. A suite about a vend or the list would otherwise need a
 * Cognito pool it is not about. Here the deployment's directory answers every account `active` and every
 * other question exactly as it does in a deployment.
 *
 * A suite about the answer sets it on the mock, after loading its handler:
 *
 *   const { accountState } = jest.requireMock('../lambda/src/lib/membership-source').__accountStateForTests;
 *   accountState.mockResolvedValue('disabled');
 *
 * The live read itself is tested for real, through `createDirectory` over a faked pool, by
 * `test/lib/a-disabled-account-is-refused-at-the-next-vend.test.ts` and
 * `test/lib/a-federated-pool-account-is-addressed-by-its-username.test.ts`.
 */
jest.mock('../../lambda/src/lib/membership-source', () => {
  const accountState = jest.fn(async (_issuer: string, _subject: string): Promise<'active' | 'disabled' | 'gone'> => 'active');
  let actual: Record<string | symbol, any> | null = null;
  const real = (): Record<string | symbol, any> => (actual ??= jest.requireActual('../../lambda/src/lib/membership-source'));
  const defaultDirectory = () => {
    const d = real().defaultDirectory();
    return new Proxy(d, { get: (t, prop) => (prop === 'accountState' ? accountState : t[prop]) });
  };
  const mocked: Record<string, unknown> = { defaultDirectory, __accountStateForTests: { accountState } };
  return new Proxy({}, {
    get: (_t, prop) => (prop === '__esModule' ? true : typeof prop === 'string' && prop in mocked ? mocked[prop] : real()[prop]),
    has: (_t, prop) => (typeof prop === 'string' && prop in mocked) || prop in real(),
  });
});
