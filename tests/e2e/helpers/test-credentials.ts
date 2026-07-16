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

/** Get premium tier user */
export async function getPremiumUser(): Promise<TestUser> {
  const creds = await getTestCredentials();
  return creds.premiumUser;
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
