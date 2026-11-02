/**
 * AN ORGANIZATION'S IDENTITY PROVIDER, FOR THE SPECS THAT FOLLOW THE IDENTITY-PROVIDER GUIDE.
 *
 * The guide's worked example (docs/guides/user/IDENTITY-PROVIDER-GUIDE.md, "Groups from your provider")
 * declares a provider verified directly as `oidc`, whose groups are translated into AgentEchelon groups.
 * The suite plays that provider with the `TestIssuer` stack's pool for the fixture (`owner: "test-fixture"`,
 * backend/lib/stacks/test-issuer-stack.ts): reached only through its OpenID discovery document, its groups
 * created from the entry's map plus one it leaves out, `admins`. The entry the deployment declares is the
 * guide's example with that pool's values filled in:
 *
 *   { "id": "idp-oidc", "kind": "oidc", "owner": "test-fixture", "issuer": "<iss>", "discoveryUrl": "<iss>/.well-known/openid-configuration",
 *     "audience": "<fixture client id>", "directory": "claims", "admin": true, "groupsClaim": "cognito:groups",
 *     "clearance": { "groups": { "map": { "Fixture-Standard": "standard", "Fixture-Admins": "admins" } },
 *                    "classifications": ["basic", "standard", "premium", "admin"] } }
 *
 * The provider's groups claim is `cognito:groups` only because the fixture is a Cognito pool; Okta's or
 * Entra's is `groups`. Everything else is what a deployer writes.
 *
 * Each spec makes its own people in the provider and removes them after, so no run depends on another.
 */
import { randomBytes } from 'crypto';
import { awsOrNull, awsv } from './aws';
import { idTokenFor } from './person';
import { SSM_ROOT } from './stack-prefix';

/** The fixture's registry id: `AE_IDP_FIXTURE_ID`, default `idp-oidc`. */
export const IDP_FIXTURE_ID = process.env.AE_IDP_FIXTURE_ID || 'idp-oidc';

/** The provider groups the guide's example maps, and the AgentEchelon group each is. */
export const PROVIDER_GROUPS = {
  standard: process.env.AE_IDP_STANDARD_GROUP || 'Fixture-Standard',
  admins: process.env.AE_IDP_ADMINS_GROUP || 'Fixture-Admins',
} as const;

/** The provider group the map leaves out, named as an outside administrator might name theirs. */
export const UNMAPPED_ADMINS_GROUP = 'admins';

const param = (name: string): string => String(awsOrNull(`ssm get-parameter --name "${SSM_ROOT}/test-issuer/${IDP_FIXTURE_ID}/${name}" --query Parameter.Value`) ?? '');

/** The fixture provider's pool and app client, or null when the deployment declares no such fixture. */
export function idpFixture(): { poolId: string; clientId: string } | null {
  const poolId = param('pool-id');
  const clientId = param('client-id');
  return poolId && clientId ? { poolId, clientId } : null;
}

export const IDP_MISSING_REASON =
  `No identity-provider fixture: the deployment declares no "${IDP_FIXTURE_ID}" test-fixture issuer (its pool's ids are not under `
  + `${SSM_ROOT}/test-issuer/${IDP_FIXTURE_ID}/). Declare the guide's example entry with owner "test-fixture" and deploy the TestIssuer stack.`;

/** A person the spec made in the provider. */
export interface ProviderPerson {
  username: string;
  password: string;
  /** A fresh ID token, as the provider issues one at sign-in now. */
  signIn(): string;
  /** Remove them from a provider group, as the provider's administrator would. */
  leave(group: string): void;
}

/** Make a person in the provider, in these groups. Each is removed by `removeProviderPeople`. */
export function providerPerson(fixture: { poolId: string; clientId: string }, label: string, groups: string[]): ProviderPerson {
  // NOT AN ADDRESS: the fixture pool signs in by username or email (`signInAliases`), and Cognito refuses an
  // email-shaped username on a pool where email is an alias. The address is the person's `email` attribute.
  const username = `e2e-${label}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const email = `${username}@idp.example.com`;
  const password = `Aa1${randomBytes(12).toString('base64url')}`;
  const pool = ['--user-pool-id', fixture.poolId];
  awsv(['cognito-idp', 'admin-create-user', ...pool, '--username', username, '--message-action', 'SUPPRESS',
    '--user-attributes', `Name=email,Value=${email}`, 'Name=email_verified,Value=true', `Name=name,Value=E2E ${label}`]);
  awsv(['cognito-idp', 'admin-set-user-password', ...pool, '--username', username, '--password', password, '--permanent']);
  for (const group of groups) awsv(['cognito-idp', 'admin-add-user-to-group', ...pool, '--username', username, '--group-name', group]);
  made.push({ poolId: fixture.poolId, username });
  return {
    username,
    password,
    signIn: () => idTokenFor(username, password, fixture.clientId),
    leave: (group) => { awsv(['cognito-idp', 'admin-remove-user-from-group', ...pool, '--username', username, '--group-name', group]); },
  };
}

const made: Array<{ poolId: string; username: string }> = [];

/** Remove every person this run made in the provider. */
export function removeProviderPeople(): void {
  for (const { poolId, username } of made.splice(0)) {
    awsOrNull(`cognito-idp admin-delete-user --user-pool-id "${poolId}" --username "${username}"`);
  }
}
