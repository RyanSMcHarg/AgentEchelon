#!/usr/bin/env node
/**
 * Provision an ADMIN user in the deployed Cognito User Pool.
 *
 * This is the operator-facing path to grant a real human admin access to the
 * console (the analytics API + moderation surfaces are gated on the `admins`
 * Cognito group). It mirrors provision-test-users.mjs but for a single named
 * admin, and it does NOT touch the E2E test-credentials secret.
 *
 *   AWS_PROFILE=<p> ADMIN_EMAIL=you@example.com node backend/scripts/provision-admin.mjs
 *
 * Password: pass ADMIN_PASSWORD to set your own; otherwise a strong random one is
 * generated. Either way the credentials are written to a Secrets Manager secret
 * (agent-echelon/admin-users/<localpart>) rather than printed — read it back with:
 *   aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text
 *
 * Idempotent: re-running updates the existing user's password + group membership.
 *
 * Env:
 *   ADMIN_EMAIL     (required) the admin's email = Cognito username
 *   ADMIN_PASSWORD  (optional) set a specific permanent password; else random
 *   ADMIN_TIER      (optional) model tier group to also grant (default: premium)
 *   ADMIN_NAME      (optional) display name (default: derived from email)
 */
import { randomBytes } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  ChimeSDKIdentityClient,
  CreateAppInstanceUserCommand,
  DescribeAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
} from '@aws-sdk/client-secrets-manager';

const region = process.env.AWS_REGION || 'us-east-1';
const EMAIL = process.env.ADMIN_EMAIL;
const TIER = process.env.ADMIN_TIER || 'premium';
if (!EMAIL) {
  console.error('ADMIN_EMAIL is required, e.g. ADMIN_EMAIL=you@example.com node backend/scripts/provision-admin.mjs');
  process.exit(2);
}
const NAME = process.env.ADMIN_NAME || EMAIL.split('@')[0];
// A strong random password that satisfies a default Cognito policy (upper/lower/
// digit/symbol) when none is supplied.
function strongPassword() {
  const b = randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return `Ae!${b}9`;
}
const PASSWORD = process.env.ADMIN_PASSWORD || strongPassword();
const LOCALPART = EMAIL.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '');
const SECRET_NAME = `agent-echelon/admin-users/${LOCALPART}`;

const cognito = new CognitoIdentityProviderClient({ region });
const chimeIdentity = new ChimeSDKIdentityClient({ region });
const cfn = new CloudFormationClient({ region });
const secrets = new SecretsManagerClient({ region });

async function outputs(stack) {
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  const out = {};
  for (const o of resp.Stacks?.[0]?.Outputs || []) if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  return out;
}

async function ensureChimeUser(appInstanceArn, userPoolId) {
  const got = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: EMAIL }));
  const sub = got.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error(`No sub for ${EMAIL}`);
  const arn = `${appInstanceArn}/user/${sub}`;
  try {
    await chimeIdentity.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: arn }));
  } catch (err) {
    if (err.name === 'NotFoundException' || err.name === 'ForbiddenException') {
      await chimeIdentity.send(new CreateAppInstanceUserCommand({ AppInstanceArn: appInstanceArn, AppInstanceUserId: sub, Name: EMAIL }));
      console.log(`    + Chime user ${arn}`);
      return sub;
    }
    throw err;
  }
  return sub;
}

async function writeSecret(payload) {
  const SecretString = JSON.stringify(payload, null, 2);
  try {
    const r = await secrets.send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString }));
    return r.ARN;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      const r = await secrets.send(new CreateSecretCommand({ Name: SECRET_NAME, SecretString }));
      return r.ARN;
    }
    throw err;
  }
}

async function main() {
  console.log(`Provisioning admin ${EMAIL} (tier=${TIER}, groups=admins+${TIER})...`);
  const cog = await outputs('AgentEchelonCognitoAuth');
  const userPoolId = cog['UserPoolId'];
  const clientId = cog['UserPoolClientId'];
  if (!userPoolId || !clientId) throw new Error('AgentEchelonCognitoAuth missing UserPoolId/UserPoolClientId outputs.');
  const chime = await outputs('AgentEchelonChimeMessaging');
  const appInstanceArn = chime['AppInstanceArnOutput'] || chime['AppInstanceArn'];
  if (!appInstanceArn) throw new Error('AgentEchelonChimeMessaging missing AppInstanceArn output.');

  const attrs = [
    { Name: 'email', Value: EMAIL },
    { Name: 'email_verified', Value: 'true' },
    { Name: 'custom:tier', Value: TIER },
    { Name: 'custom:approved', Value: 'true' },
    { Name: 'given_name', Value: NAME.split(/[.\s]/)[0] || NAME },
    { Name: 'family_name', Value: NAME.split(/[.\s]/).slice(1).join(' ') || 'Admin' },
  ];
  try {
    await cognito.send(new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: EMAIL, UserAttributes: attrs, MessageAction: 'SUPPRESS' }));
    console.log(`  + created ${EMAIL}`);
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      await cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: userPoolId, Username: EMAIL, UserAttributes: attrs }));
      console.log(`  ~ updated existing ${EMAIL}`);
    } else throw err;
  }

  // Permanent password moves the user to CONFIRMED (no FORCE_CHANGE challenge the
  // SPA sign-in doesn't handle).
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: EMAIL, Password: PASSWORD, Permanent: true }));

  for (const group of ['admins', TIER]) {
    try {
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: EMAIL, GroupName: group }));
      console.log(`  + group ${group}`);
    } catch (err) {
      console.warn(`    ! could not add to group "${group}": ${err.name || err.message}`);
    }
  }

  await ensureChimeUser(appInstanceArn, userPoolId);

  const arn = await writeSecret({
    email: EMAIL,
    password: PASSWORD,
    tier: TIER,
    groups: ['admins', TIER],
    cognitoUserPoolId: userPoolId,
    cognitoClientId: clientId,
    note: 'Admin console credentials. Rotate after first sign-in.',
  });

  console.log('');
  console.log(`Done. ${EMAIL} is an admin (groups: admins, ${TIER}).`);
  console.log(`Credentials stored in Secrets Manager (NOT printed here):`);
  console.log(`  ${arn}`);
  console.log(`Read the password with:`);
  console.log(`  aws secretsmanager get-secret-value --secret-id ${SECRET_NAME} --query SecretString --output text`);
  console.log(`Then sign in at the app URL with ${EMAIL}.`);
}

main().catch((err) => {
  console.error('provision-admin failed:', err);
  process.exit(1);
});
