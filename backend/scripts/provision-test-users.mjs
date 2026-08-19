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
 * Order matters, and it is: create/refresh the users, WRITE THE SECRET, then rotate passwords. The
 * generated password lives only in this process, so a run that rotated first and was interrupted
 * left users holding a credential nobody knew and nothing recorded. Writing first makes every
 * failure resumable by simply re-running.
 *
 * Why a script and not the post-confirmation trigger: AdminCreateUser bypasses
 * the self-signup flow, so the Cognito post-confirmation trigger that normally
 * mirrors `custom:tier` into the tier group never fires. We therefore add each
 * user to its group(s) explicitly here — the group is the authoritative tier
 * signal (see CLAUDE.md "Tier authorization").
 *
 * Overridable via env:
 *   TEST_SECRET_NAME   secret id            (default: agent-interface/test-credentials)
 *   TEST_USER_PASSWORD permanent password   (default: RANDOM per run, written to the secret)
 *   TEST_EMAIL_DOMAIN  tier-user email host (default: agentechelon.test)
 *   ADMIN_EMAIL        admin user's email   (default: testuser-admin@<domain>)
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
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
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const require = createRequire(import.meta.url);
const { buildSecretPatch, mergeSecretValue } = require('./lib/test-user-secret.cjs');

const region = process.env.AWS_REGION || 'us-east-1';
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
/**
 * The test-user password: a strong RANDOM value per run unless TEST_USER_PASSWORD overrides it.
 *
 * This shipped a hardcoded default in a PUBLIC repo, and documented it in the README as the default.
 * The literal is not repeated here, because it is still the live password on any user provisioned by
 * an earlier run. Its sibling `seed-demo.ts` had already settled the policy the other way, in
 * as many words - "a strong RANDOM password is generated per run, so NO default credential ships in
 * the repo" - so the two provisioning paths disagreed about the same question, and the one a deployer
 * is told to run first was the one shipping a known password. Anyone who ran it and did not think to
 * override got four Cognito users whose password is published in this file.
 *
 * Nothing needs the value to be predictable: it is written to the credentials secret below, which is
 * where the e2e suite reads it from. TEST_USER_PASSWORD remains for a deployer who deliberately wants
 * stable logins across re-provisions.
 */
function generateTestPassword() {
  // Cognito-valid by construction: upper + lower + digit + symbol, plus ~16 chars of entropy.
  return `Ae${randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '')}9!`;
}
const PASSWORD = process.env.TEST_USER_PASSWORD || generateTestPassword();
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
  // A SECOND premium identity, distinct from the admin. `testAdmin` and `premiumUser` are the same
  // account, so nothing that turns on two different PEOPLE could be exercised: who owns a duel, whose
  // reply resumes it, per-user battle picks, what a NON-moderator member sees. The e2e suite has read
  // this key for as long as those tests have existed and nothing here created it, so they self-skipped
  // with "no provisioned secondPremiumUser" - a permanent gate that reads like a deployment choice.
  { key: 'secondPremiumUser', email: `testuser-premium2@${EMAIL_DOMAIN}`, tier: 'premium', groups: ['premium'], name: 'Test Premium Two' },
  // Reserved for the ONBOARDING intake and used by nothing else, so its onboarding state is whatever
  // the onboarding spec last set it to - global-setup deliberately does not pre-onboard it. Same story
  // as secondPremiumUser one row up: the e2e read this key for as long as the intake spec existed,
  // nothing wrote it, and the phase self-skipped with a reason that read like a deployment choice.
  { key: 'onboardingUser', email: `testuser-onboarding@${EMAIL_DOMAIN}`, tier: 'standard', groups: ['standard'], name: 'Test Onboarding' },
];

/**
 * `--only <key>[,<key>]` provisions just those users and leaves the rest of the secret untouched.
 *
 * Without it the only way to add one user is a full run, which resets EVERY user's password (a fresh
 * random one per run) and republishes the secret from this table alone. On a deployment whose e2e is
 * already signed in and whose demo data is tied to those accounts, that is a wide blast radius for
 * adding one login.
 */
const onlyIdx = process.argv.indexOf('--only');
const ONLY_KEYS = onlyIdx !== -1 && process.argv[onlyIdx + 1]
  ? process.argv[onlyIdx + 1].split(',').map((k) => k.trim()).filter(Boolean)
  : null;
if (ONLY_KEYS) {
  const unknown = ONLY_KEYS.filter((k) => !USERS.some((u) => u.key === k));
  if (unknown.length) {
    console.error(`--only: unknown user key(s): ${unknown.join(', ')}. Known: ${USERS.map((u) => u.key).join(', ')}`);
    process.exit(1);
  }
}
const SELECTED = ONLY_KEYS ? USERS.filter((u) => ONLY_KEYS.includes(u.key)) : USERS;

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

/**
 * Create the user (or refresh its attributes) WITHOUT touching its password.
 *
 * Split from the credential step below so the whole run can reach the secret write before anything
 * rotates a password. See the ordering note in main().
 */
async function ensureUserExists(userPoolId, u) {
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
}

/**
 * Set the password, the group membership and the Chime identity.
 *
 * Runs only AFTER the secret holds this password: the rotation is the irreversible half, and a
 * password nobody recorded is a user nobody can sign in as.
 */
async function applyCredentialAndAccess(userPoolId, appInstanceArn, u) {
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

/**
 * MERGES into the existing secret rather than replacing it. A wholesale replace drops any key this
 * table does not know about - `onboardingUser` is one the e2e reads and this script has never written -
 * so adding a user could silently un-provision another suite.
 *
 * `fillIfAbsent` supplies a key only when the secret has none, which is how `--only` mode leaves a
 * deliberately-chosen app client alone. See lib/test-user-secret.cjs for which key is which and why.
 */
async function writeSecret(patch, fillIfAbsent = {}) {
  let existing = {};
  try {
    const cur = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    existing = cur.SecretString ? JSON.parse(cur.SecretString) : {};
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }
  const SecretString = JSON.stringify(mergeSecretValue(existing, patch, fillIfAbsent));
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

  if (ONLY_KEYS) console.log(`  --only: ${SELECTED.map((u) => u.key).join(', ')} (other users and secret keys untouched)`);

  // PASS 1: existence and attributes only. Nothing here changes a password, so a failure - the
  // common one, a permissions gap on AdminCreateUser - leaves every existing login working and the
  // secret untouched.
  for (const u of SELECTED) {
    await ensureUserExists(userPoolId, u);
  }

  // PERSIST THE CREDENTIAL BEFORE IT BECOMES ANYONE'S PASSWORD.
  //
  // The password is a fresh random value per run unless TEST_USER_PASSWORD pins it, and it exists
  // nowhere but this process's memory. Rotating first meant an interrupted run - an expired session
  // midway, a throttle, a Ctrl-C - left the users it had already reached holding a password nobody
  // knew and nothing recorded, with the secret still advertising the previous one. Writing first
  // inverts that: the secret is always at least as current as the pool, so an interrupted run is
  // resumable by re-running (the whole script is idempotent), and no state is ever unrecoverable.
  const { patch, fillIfAbsent } = buildSecretPatch({
    userPoolId,
    clientId,
    users: SELECTED,
    password: PASSWORD,
    onlyMode: !!ONLY_KEYS,
  });
  await writeSecret(patch, fillIfAbsent);

  // PASS 2: the irreversible half - password, groups, Chime identity.
  for (const u of SELECTED) {
    await applyCredentialAndAccess(userPoolId, appInstanceArn, u);
  }

  console.log('');
  console.log('Done. Test users ready (all share one password):');
  for (const u of SELECTED) console.log(`  ${u.key.padEnd(18)} ${u.email}`);
  console.log('');
  console.log('Next: cd tests && npm install && npx playwright install chromium && npm test');
}

main().catch((err) => {
  console.error('provision-test-users failed:', err);
  console.error(
    '\nNo user is left holding an unrecorded password: this run writes the credential to\n'
      + `${SECRET_NAME} BEFORE rotating anyone to it. Re-run the same command once the cause is\n`
      + 'fixed - the script is idempotent and re-applies the password to every selected user.',
  );
  process.exit(1);
});
