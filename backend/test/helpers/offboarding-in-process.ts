/**
 * USER MANAGEMENT, WITH OFFBOARDING RUN IN-PROCESS.
 *
 * In a deployment the console's delete, re-admission and export are invoked on the Identity
 * stack's offboarding function (`lib/offboarding-console.ts`). A test runs that same code in-process, on
 * the deps it set with `__setOffboardingDepsForTests`, by replacing the invoke and nothing else.
 */
export function userManagementWithOffboardingInProcess<T extends { handler: unknown }>(): T {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const um = require('../../lambda/src/user-management');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { consoleOffboarding } = require('../../lambda/src/lib/offboarding-console');
  um.__setOffboardingInvokerForTests((req: unknown) => consoleOffboarding(req));
  return um as T;
}
