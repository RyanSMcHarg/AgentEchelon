/**
 * WHO A TEST PERSON IS: their AppInstanceUser, as the credential exchange names it.
 *
 * A person's id is minted by the exchange (a UUID v7 recorded in the Identities table) and is never
 * their Cognito `sub`, so an ARN built from a sub names nobody. Every helper and spec takes a person
 * from here: the `userArn` provisioning stored in the test secret for that user, or, for a token a page
 * signed in with, the exchange's own answer for that token.
 */
import { execSync } from 'child_process';
import { exchange } from './admin-api';
import { getTestCredentials, type TestCredentials, type TestUser } from './test-credentials';

const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const REGION = process.env.AWS_REGION || 'us-east-1';

/** The person id an AppInstanceUser ARN carries: its last segment. */
export function personIdOf(userArn: string): string {
  return userArn.split('/').pop() || '';
}

/** The app instance a channel, user or bot ARN belongs to. */
export function appInstanceOf(arn: string): string {
  return arn.replace(/\/(channel|user|bot)\/.*$/, '');
}

/**
 * A Cognito id token for a test user, by USER_PASSWORD_AUTH through the AWS CLI, so the tests project
 * needs no Cognito SDK.
 */
export function idTokenFor(email: string, password: string, clientId: string): string {
  const raw = execSync(
    'aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH '
      + `--client-id "${clientId}" `
      + `--auth-parameters USERNAME="${email}",PASSWORD="${password}" `
      + `--query AuthenticationResult.IdToken --output text --region ${REGION}`,
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, AWS_PROFILE, MSYS_NO_PATHCONV: '1' } },
  ).trim();
  if (!raw || raw === 'None') throw new Error(`No IdToken for ${email}`);
  return raw;
}

const byToken = new Map<string, Promise<string>>();

/**
 * The AppInstanceUser the exchange names for an id token. Throws with the exchange's status when it
 * names nobody, so a refused sign-in reads as a refusal and never as a wrong person.
 */
export function personArnFromIdToken(idToken: string): Promise<string> {
  const hit = byToken.get(idToken);
  if (hit) return hit;
  const pending = exchange(idToken, {}).then(({ status, body }) => {
    const arn = typeof body?.userArn === 'string' ? body.userArn : '';
    if (status !== 200 || !arn.includes('/user/')) {
      throw new Error(`the credential exchange named no person for this token (status ${status})`);
    }
    return arn;
  });
  byToken.set(idToken, pending);
  pending.catch(() => byToken.delete(idToken));
  return pending;
}

/** The person id the exchange names for an id token. */
export async function personIdFromIdToken(idToken: string): Promise<string> {
  return personIdOf(await personArnFromIdToken(idToken));
}

/** Every test user the secret carries, under its key. */
function usersOf(creds: TestCredentials): TestUser[] {
  return Object.values(creds).filter(
    (v): v is TestUser => !!v && typeof v === 'object' && typeof (v as TestUser).email === 'string',
  );
}

/**
 * A test user's AppInstanceUser: the one provisioning recorded in the secret, else the exchange's
 * answer when they sign in.
 */
export async function personArnOf(user: TestUser): Promise<string> {
  if (user.userArn) return user.userArn;
  const creds = await getTestCredentials();
  return personArnFromIdToken(idTokenFor(user.email, user.password, creds.cognitoClientId));
}

/** The test user an email names, from the secret. Null when the secret carries no such user. */
export async function testUserByEmail(email: string): Promise<TestUser | null> {
  const wanted = email.toLowerCase();
  return usersOf(await getTestCredentials()).find((u) => u.email.toLowerCase() === wanted) ?? null;
}

/** The AppInstanceUser of the test user an email names. Null when the secret carries no such user. */
export async function personArnForEmail(email: string): Promise<string | null> {
  const user = await testUserByEmail(email);
  return user ? personArnOf(user) : null;
}

/** The test user an AppInstanceUser is, by the ARN provisioning recorded. Null for anyone else. */
export async function testUserByPersonArn(userArn: string): Promise<TestUser | null> {
  const id = personIdOf(userArn);
  for (const user of usersOf(await getTestCredentials())) {
    if (personIdOf(await personArnOf(user)) === id) return user;
  }
  return null;
}
