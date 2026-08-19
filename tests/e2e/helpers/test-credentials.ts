/**
 * Test Credentials Loader
 *
 * Loads test user credentials from AWS Secrets Manager at runtime.
 * Caches the result in memory so the secret is only fetched once per test run.
 *
 * Secret: agent-interface/test-credentials
 *
 * Usage:
 *   const creds = await getTestCredentials();
 *   const admin = creds.testAdmin;
 *   await signIn(page, admin.email, admin.password);
 */
import { execSync } from 'child_process';

const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const REGION = 'us-east-1';

export interface TestUser {
  email: string;
  password: string;
  tier: 'basic' | 'standard' | 'premium';
}

export interface TestCredentials {
  testAdmin: TestUser;
  basicUser: TestUser;
  standardUser: TestUser;
  premiumUser: TestUser;
  /**
   * A premium account that is NOT `testAdmin`. In the deployed secret `testAdmin` and `premiumUser`
   * are the same address, so anything needing two distinct people had only one. Optional because a
   * deployment provisioned before this key existed still has four entries; callers gate on it rather
   * than fail the whole suite.
   */
  secondPremiumUser?: TestUser;
  /**
   * A standard-tier user reserved for the ONBOARDING intake, and used by nothing else.
   *
   * The intake only runs for a user who has not been onboarded, so a spec testing it has to control
   * that user's onboarding state completely. The shared demo users cannot provide that: global-setup
   * pre-onboards every one of them (any of them may open a standard conversation, which would
   * otherwise trigger an intake mid-suite), and the handler caches a positive onboarded result for a
   * few minutes, so a reset performed seconds before the test can still be invisible to a container
   * warmed by an earlier phase. Both are correct behaviours that simply make a shared user unusable
   * here. Optional: a deployment provisioned before this key skips the spec with a stated reason.
   */
  onboardingUser?: TestUser;
  cognitoUserPoolId: string;
  cognitoClientId: string;
}

let cachedCredentials: TestCredentials | null = null;

/**
 * Load test credentials from Secrets Manager.
 * Results are cached — subsequent calls return the same object.
 */
export async function getTestCredentials(): Promise<TestCredentials> {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  try {
    const raw = execSync(
      `aws secretsmanager get-secret-value ` +
        `--secret-id "${SECRET_NAME}" ` +
        `--query SecretString --output text ` +
        `--region ${REGION}`,
      { encoding: 'utf8', timeout: 15000, env: { ...process.env, AWS_PROFILE } }
    ).trim();

    cachedCredentials = JSON.parse(raw) as TestCredentials;
    return cachedCredentials;
  } catch (error) {
    throw new Error(
      `Failed to load test credentials from Secrets Manager (${SECRET_NAME}). ` +
        `Ensure AWS_PROFILE=${AWS_PROFILE} is configured and the secret exists.\n` +
        `Original error: ${error}`
    );
  }
}

/** Get admin user (premium tier) */
export async function getAdminUser(): Promise<TestUser> {
  const creds = await getTestCredentials();
  return creds.testAdmin;
}

/** Get basic tier user */
export async function getBasicUser(): Promise<TestUser> {
  const creds = await getTestCredentials();
  return creds.basicUser;
}

/** Get standard tier user */
export async function getStandardUser(): Promise<TestUser> {
  const creds = await getTestCredentials();
  return creds.standardUser;
}

/**
 * A SECOND premium user, distinct from the admin the suite runs as. Returns null when the deployment
 * predates this key, so a test can state that reason rather than fail as if the product were broken.
 *
 * Needed wherever a claim turns on two different PEOPLE - per-user battle picks are keyed by the
 * chooser's sub, so one identity picking twice overwrites its own vote. Sharing is also gated on the
 * invitee's own tier, so the standard user cannot stand in for a premium conversation.
 */
export async function getSecondPremiumUser(): Promise<TestUser | null> {
  const creds = await getTestCredentials();
  return creds.secondPremiumUser ?? null;
}

/**
 * The onboarding-only user. Returns null when the deployment predates this key, so the spec can state
 * that reason rather than fail as if the intake were broken.
 *
 * Deliberately NOT pre-onboarded by global-setup and not used by any other spec, so its onboarding
 * state is whatever the onboarding spec last set it to.
 */
export async function getOnboardingUser(): Promise<TestUser | null> {
  const creds = await getTestCredentials();
  return creds.onboardingUser ?? null;
}

/** Get premium tier user */
export async function getPremiumUser(): Promise<TestUser> {
  const creds = await getTestCredentials();
  return creds.premiumUser;
}

/**
 * The reason a credential gate skipped, stated in the run report.
 *
 * `test.skip()` with no arguments opts a test out and records NOTHING, so a run without provisioned
 * users prints "22 skipped" and gives the reader nothing to act on. `test.skip(condition, reason)`
 * records the reason, which `e2e/reporters/skip-visibility.ts` groups and prints. Same gate, with the
 * why attached — use it everywhere a missing test user is the condition.
 */
export function missingUserReason(
  secretKey: 'basicUser' | 'standardUser' | 'premiumUser' | 'testAdmin' | 'secondPremiumUser' | 'onboardingUser',
): string {
  return (
    `No provisioned ${secretKey}: the "${secretKey}" entry in the ${SECRET_NAME} secret `
    + `(region ${REGION}) has no password. Populate the secret and set AWS_PROFILE to run this.`
  );
}

/**
 * Check if test credentials are available without throwing.
 * Useful for test.skip() guards.
 */
export function hasTestCredentials(): boolean {
  try {
    execSync(
      `aws secretsmanager describe-secret ` +
        `--secret-id "${SECRET_NAME}" --region ${REGION}`,
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, AWS_PROFILE } }
    );
    return true;
  } catch {
    return false;
  }
}
