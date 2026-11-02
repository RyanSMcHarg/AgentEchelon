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
  /** The AppInstanceUser the credential exchange vended at provisioning, when the run recorded one. */
  userArn?: string;
}

export interface TestCredentials {
  testAdmin: TestUser;
  basicUser: TestUser;
  standardUser: TestUser;
  premiumUser: TestUser;
  /**
   * A second premium account, distinct from `premiumUser`, for anything that needs two people at one
   * classification. Optional because a deployment provisioned before this key existed has no entry; callers
   * gate on it rather than fail the whole suite.
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
   * warmed by an earlier phase. Both are correct behaviors that simply make a shared user unusable
   * here. Optional: a deployment provisioned before this key skips the spec with a stated reason.
   */
  onboardingUser?: TestUser;
  /** Premium-cleared and in the `ops` membership group: the person an `ops` event names. */
  opsLeadUser?: TestUser;
  /** A second premium-cleared `ops` member. */
  opsEngineerUser?: TestUser;
  /** In `team-members` and `team-ops`: an admin-console team member whose reach is the ops team's assistants. */
  teamOpsUser?: TestUser;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  /**
   * Where the test users' mail lands: an SES receipt rule writes every message for `domain` to
   * `s3://bucket/prefix`. Absent when the deployment configured no inbox, and the delivery tests skip
   * naming how to add one (`helpers/test-inbox.ts`).
   */
  testInbox?: { bucket: string; prefix: string; domain: string };
}

const cachedSecrets = new Map<string, unknown>();

/**
 * A provisioning secret, read from Secrets Manager BY NAME and cached per name for the run. The e2e users'
 * secret (`agent-interface/test-credentials`) and the demo cast's (`agent-interface/demo-credentials`,
 * `helpers/demo-credentials.ts`) are both written by `provision-test-users.mjs` and read here.
 */
export async function readCredentialsSecret<T>(secretName: string): Promise<T> {
  if (cachedSecrets.has(secretName)) return cachedSecrets.get(secretName) as T;
  try {
    const raw = execSync(
      `aws secretsmanager get-secret-value ` +
        `--secret-id "${secretName}" ` +
        `--query SecretString --output text ` +
        `--region ${REGION}`,
      // UTF-8 both ways; see `task-backend.aws` for why the AWS CLI needs both on Windows.
      { encoding: 'utf8', timeout: 15000,
        env: { ...process.env, AWS_PROFILE, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }
    ).trim();
    const parsed = JSON.parse(raw) as T;
    cachedSecrets.set(secretName, parsed);
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to load credentials from Secrets Manager (${secretName}). ` +
        `Ensure AWS_PROFILE=${AWS_PROFILE} is configured and the secret exists.\n` +
        `Original error: ${error}`
    );
  }
}

/** Whether a secret exists, without reading it or throwing. Useful for test.skip() guards. */
export function hasCredentialsSecret(secretName: string): boolean {
  try {
    execSync(
      `aws secretsmanager describe-secret ` +
        `--secret-id "${secretName}" --region ${REGION}`,
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, AWS_PROFILE, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Load test credentials from Secrets Manager.
 * Results are cached: subsequent calls return the same object.
 */
export async function getTestCredentials(): Promise<TestCredentials> {
  return readCredentialsSecret<TestCredentials>(SECRET_NAME);
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
/** The ops lead, or null when this deployment's secret carries none (provision-test-users --only opsLeadUser). */
export async function getOpsLeadUser(): Promise<TestUser | null> {
  const creds = await getTestCredentials();
  return creds.opsLeadUser ?? null;
}

/** The second ops member, or null when none is provisioned. */
export async function getOpsEngineerUser(): Promise<TestUser | null> {
  const creds = await getTestCredentials();
  return creds.opsEngineerUser ?? null;
}

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
  secretKey: 'basicUser' | 'standardUser' | 'premiumUser' | 'testAdmin' | 'secondPremiumUser' | 'onboardingUser' | 'opsLeadUser' | 'opsEngineerUser' | 'teamOpsUser',
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
  return hasCredentialsSecret(SECRET_NAME);
}
