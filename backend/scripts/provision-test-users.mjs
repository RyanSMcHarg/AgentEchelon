#!/usr/bin/env node
/**
 * Provision E2E Test Users
 *
 * Creates the four tier test users in the deployed Cognito User Pool and
 * writes the Secrets Manager secret that the Playwright suite reads
 * (`tests/e2e/helpers/test-credentials.ts`). This is the repeatable path so
 * ANY deployer — not just the original author — can stand up a fresh stack and
 * run the E2E tests:
 *
 *   cd backend && npx cdk deploy --all
 *   AWS_PROFILE=<profile> node backend/scripts/provision-test-users.mjs
 *   cd tests && npm test
 *
 * Idempotent: re-running updates each user's password + group membership and
 * rewrites the secret. Safe to run after every redeploy (pool/client IDs are
 * re-read from the live CloudFormation outputs each time).
 *
 * Why a script and not the post-confirmation trigger: AdminCreateUser bypasses
 * the self-signup flow, so the Cognito post-confirmation trigger that normally
 * mirrors `custom:tier` into the tier group never fires. We therefore add each
 * user to its group(s) explicitly here — the group is the authoritative tier
 * signal (see CLAUDE.md "Tier authorization").
 *
 * Overridable via env:
 *   TEST_SECRET_NAME   secret id            (default: agent-interface/test-credentials)
 *   TEST_USER_PASSWORD permanent password   (default: AgentEchelonE2E!2026)
 *   TEST_EMAIL_DOMAIN  tier-user email host (default: agentechelon.test)
 *   ADMIN_EMAIL        admin user's email   (default: testuser-admin@<domain>)
 */
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
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
} from '@aws-sdk/client-secrets-manager';

const region = process.env.AWS_REGION || 'us-east-1';
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const PASSWORD = process.env.TEST_USER_PASSWORD || 'AgentEchelonE2E!2026';
const EMAIL_DOMAIN = process.env.TEST_EMAIL_DOMAIN || 'agentechelon.test';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || `testuser-admin@${EMAIL_DOMAIN}`;

const cognito = new CognitoIdentityProviderClient({ region });
const chimeIdentity = new ChimeSDKIdentityClient({ region });
const cfn = new CloudFormationClient({ region });
const secrets = new SecretsManagerClient({ region });

// Each entry maps to a field in the test-credentials secret. The admin is in
// `premium` too so it has premium model access on top of admin UI access.
const USERS = [
  { key: 'basicUser',    email: `testuser-basic@${EMAIL_DOMAIN}`,    tier: 'basic',    groups: ['basic'],            name: 'Test Basic' },
  { key: 'standardUser', email: `testuser-standard@${EMAIL_DOMAIN}`, tier: 'standard', groups: ['standard'],         name: 'Test Standard' },
  { key: 'premiumUser',  email: `testuser-premium@${EMAIL_DOMAIN}`,  tier: 'premium',  groups: ['premium'],          name: 'Test Premium' },
  { key: 'testAdmin',    email: ADMIN_EMAIL,                         tier: 'premium',  groups: ['admins', 'premium'], name: 'Test Admin' },
];

async function getCognitoOutputs() {
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: 'AgentEchelonCognitoAuth' }));
  const out = {};
  for (const o of resp.Stacks?.[0]?.Outputs || []) {
    if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  }
  const userPoolId = out['UserPoolId'];
  const clientId = out['UserPoolClientId'];
  if (!userPoolId || !clientId) {
    throw new Error(
      'AgentEchelonCognitoAuth is missing UserPoolId / UserPoolClientId outputs. ' +
        'Deploy first: cd backend && npx cdk deploy --all',
    );
  }
  return { userPoolId, clientId };
}

async function getAppInstanceArn() {
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: 'AgentEchelonChimeMessaging' }));
  const out = {};
  for (const o of resp.Stacks?.[0]?.Outputs || []) {
    if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  }
  const arn = out['AppInstanceArnOutput'] || out['AppInstanceArn'];
  if (!arn) throw new Error('AgentEchelonChimeMessaging is missing AppInstanceArn output. Deploy first.');
  return arn;
}

/**
 * Register the user as a Chime AppInstanceUser. AdminCreateUser bypasses the
 * Cognito post-confirmation trigger that normally does this, so without it the
 * user has a Cognito identity but no Chime identity — and create-conversation
 * fails with "An invalid app instance user ARN was supplied". Mirrors
 * user-management.ts ensureChimeUser: AppInstanceUserId = the Cognito `sub`,
 * Name = email (the frontend derives the user ARN as <appInstance>/user/<sub>).
 */
async function ensureChimeUser(appInstanceArn, userPoolId, email) {
  const got = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  const sub = got.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error(`No sub for ${email}`);
  const arn = `${appInstanceArn}/user/${sub}`;
  try {
    await chimeIdentity.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: arn }));
  } catch (err) {
    if (err.name === 'NotFoundException' || err.name === 'ForbiddenException') {
      await chimeIdentity.send(
        new CreateAppInstanceUserCommand({
          AppInstanceArn: appInstanceArn,
          AppInstanceUserId: sub,
          Name: email,
        }),
      );
      console.log(`    + Chime user ${arn}`);
      return;
    }
    throw err;
  }
}

async function ensureUser(userPoolId, appInstanceArn, u) {
  const attrs = [
    { Name: 'email', Value: u.email },
    { Name: 'email_verified', Value: 'true' },
    { Name: 'custom:tier', Value: u.tier },
    { Name: 'custom:approved', Value: 'true' },
    { Name: 'given_name', Value: u.name.split(' ')[0] },
    { Name: 'family_name', Value: u.name.split(' ').slice(1).join(' ') || 'User' },
  ];
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: u.email,
        UserAttributes: attrs,
        MessageAction: 'SUPPRESS', // no welcome email (emails may be undeliverable .test)
      }),
    );
    console.log(`  + created ${u.email} (${u.tier})`);
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      await cognito.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: u.email,
          UserAttributes: [
            { Name: 'email_verified', Value: 'true' },
            { Name: 'custom:tier', Value: u.tier },
            { Name: 'custom:approved', Value: 'true' },
          ],
        }),
      );
      console.log(`  ~ updated existing ${u.email} (${u.tier})`);
    } else {
      throw err;
    }
  }

  // Permanent password also moves the user to CONFIRMED (skips the
  // FORCE_CHANGE_PASSWORD challenge AdminCreateUser would otherwise impose).
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: u.email,
      Password: PASSWORD,
      Permanent: true,
    }),
  );

  for (const group of u.groups) {
    try {
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: u.email,
          GroupName: group,
        }),
      );
    } catch (err) {
      console.warn(`    ! could not add ${u.email} to group "${group}": ${err.name || err.message}`);
    }
  }

  await ensureChimeUser(appInstanceArn, userPoolId, u.email);
}

async function writeSecret(creds) {
  const SecretString = JSON.stringify(creds);
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString }));
    console.log(`  ~ updated secret ${SECRET_NAME}`);
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      await secrets.send(new CreateSecretCommand({ Name: SECRET_NAME, SecretString }));
      console.log(`  + created secret ${SECRET_NAME}`);
    } else {
      throw err;
    }
  }
}

async function main() {
  console.log('Provisioning E2E test users...');
  const { userPoolId, clientId } = await getCognitoOutputs();
  const appInstanceArn = await getAppInstanceArn();
  console.log(`  pool=${userPoolId} client=${clientId}`);
  console.log(`  appInstance=${appInstanceArn}`);

  for (const u of USERS) {
    await ensureUser(userPoolId, appInstanceArn, u);
  }

  const creds = { cognitoUserPoolId: userPoolId, cognitoClientId: clientId };
  for (const u of USERS) {
    creds[u.key] = { email: u.email, password: PASSWORD, tier: u.tier };
  }
  await writeSecret(creds);

  console.log('');
  console.log('Done. Test users ready (all share one password):');
  for (const u of USERS) console.log(`  ${u.key.padEnd(13)} ${u.email}`);
  console.log('');
  console.log('Next: cd tests && npm install && npx playwright install chromium && npm test');
}

main().catch((err) => {
  console.error('provision-test-users failed:', err);
  process.exit(1);
});
