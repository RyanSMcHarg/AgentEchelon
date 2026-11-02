/**
 * THE DEMO CAST'S LOGINS, as `provision-test-users.mjs --cast ops-demo` writes them.
 *
 * A separate secret from the e2e users' (`agent-interface/demo-credentials`, DEMO_SECRET_NAME overrides it),
 * so an e2e provisioning run never rotates a demo login, or the other way round. The people and the address
 * rule are in `backend/scripts/lib/demo-cast.cjs`: with a test inbox each address is `demo-<who>@<inbox
 * domain>` and the secret carries `testInbox`, so a spec reads what the demo's people received.
 */
import { readCredentialsSecret, hasCredentialsSecret, type TestUser } from './test-credentials';
import type { TestInbox } from './test-inbox';

export const DEMO_SECRET_NAME = process.env.DEMO_SECRET_NAME || 'agent-interface/demo-credentials';

/** The cast's keys, as `lib/demo-cast.cjs` names them. */
export type DemoCastKey =
  | 'onCallLead' | 'platformEngA' | 'platformEngB' | 'engManager' | 'demoAdmin' | 'basicDemo' | 'salesVp';

export type DemoCredentials = Partial<Record<DemoCastKey, TestUser>> & {
  cognitoUserPoolId?: string;
  cognitoClientId?: string;
  /** Where the cast's mail lands. Absent when the cast was provisioned with no test inbox. */
  testInbox?: TestInbox;
};

/** Whether the demo cast has been provisioned on this account. */
export function hasDemoCredentials(): boolean {
  return hasCredentialsSecret(DEMO_SECRET_NAME);
}

export async function getDemoCredentials(): Promise<DemoCredentials> {
  return readCredentialsSecret<DemoCredentials>(DEMO_SECRET_NAME);
}

/** The cast's inbox, or null when it was provisioned with none. */
export async function getDemoInbox(): Promise<TestInbox | null> {
  const inbox = (await getDemoCredentials()).testInbox;
  return inbox?.bucket && inbox?.domain ? inbox : null;
}

/** The skip reason for a cast member the secret does not carry, stated in the run report. */
export function missingDemoUserReason(key: DemoCastKey): string {
  return `No provisioned ${key}: the "${key}" entry in the ${DEMO_SECRET_NAME} secret has no password. `
    + 'Run: cd backend && npm run provision-test-users -- --cast ops-demo';
}
