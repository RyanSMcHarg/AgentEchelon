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
 *   cd backend && npm run deploy
 *   AWS_PROFILE=<profile> node backend/scripts/provision-test-users.mjs
 *   cd tests && npm test
 *
 * `--dry-run` reads nothing from AWS and changes nothing: it prints the instance, the Identity stack
 * it would read, the secret it would write and every user it would create or refresh, then exits.
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
 *   TEST_EMAIL_DOMAIN  tier-user email host (default: the test inbox's domain, else agentechelon.test)
 *   TEST_INBOX_BUCKET  an EXISTING bucket an SES receipt rule writes TEST_EMAIL_DOMAIN's mail into
 *   TEST_INBOX_PREFIX  the key prefix that rule writes under (default: none)
 *
 * THE TEST INBOX is what lets a notification test assert an email ARRIVED. An existing one is declared in
 * `deploy.config.json` (`testInboxBucket`, `testInboxPrefix`, `testInboxDomain`), so a fresh deploy keeps
 * it, or named for one run with the three variables above; otherwise the opt-in TestInbox stack
 * (`testInboxDomain` alone) publishes its own to SSM for this script to find. The environment wins over
 * the config, and the config over SSM (lib/test-inbox-config.cjs). Whichever it is goes into the secret as
 * `testInbox`, and the users are given addresses on its domain: the e2e users always, and the demo cast
 * (`--cast ops-demo`) by the rule in lib/demo-cast.cjs. See README "Test inbox".
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
  CreateGroupCommand,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const require = createRequire(import.meta.url);
const { buildSecretPatch, mergeSecretValue, emailMoves } = require('./lib/test-user-secret.cjs');
const { resolveTestInbox, needsSsmLookup } = require('./lib/test-inbox-config.cjs');
const { opsDemoCast } = require('./lib/demo-cast.cjs');
const { readDeployConfig } = require('./lib/deploy-guards.cjs');
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { signInAndExchange } = require('./lib/sign-in-exchange.cjs');

const region = process.env.AWS_REGION || 'us-east-1';
const DRY_RUN = process.argv.includes('--dry-run');
/**
 * `--cast ops-demo` provisions the PEOPLE of the new-assistant demo instead of the e2e users: the
 * on-call engineer who leads, two platform engineers and their engineering manager, all premium-cleared
 * and in NO membership group (the presenter ticks `ops` in the console on camera). Same mechanism and
 * the same ordering guarantees as the e2e set, written to its OWN secret so a demo login can never be
 * rotated or overwritten by an e2e provisioning run, or the other way round.
 */
const castIdx = process.argv.indexOf('--cast');
const CAST = castIdx !== -1 ? process.argv[castIdx + 1] : null;
if (CAST && CAST !== 'ops-demo') {
  console.error(`--cast: unknown cast '${CAST}'. Known: ops-demo`);
  process.exit(1);
}
const SECRET_NAME = process.env.TEST_SECRET_NAME
  || (CAST ? 'agent-interface/demo-credentials' : 'agent-interface/test-credentials');
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
/** An SSM value, or '' when it is absent. A read that is refused is reported and treated as absent. */
async function ssmValue(name) {
  try {
    const r = await new SSMClient({ region }).send(new GetParameterCommand({ Name: name }));
    return r.Parameter?.Value || '';
  } catch (err) {
    if (err.name !== 'ParameterNotFound') console.warn(`  ! could not read ${name}: ${err.name || err.message}`);
    return '';
  }
}
// Published by the TestInbox stack (lib/stacks/test-inbox-stack.ts TEST_INBOX_SSM), under the instance root.
const SSM_ROOT = `/${resolveInstanceName(process.env)}`;
// The deployment's declared inbox, so a fresh deploy re-provisions onto it without anyone re-typing it.
const DEPLOY_CONFIG = readDeployConfig();
// ONE INBOX FOR BOTH SETS. The e2e users and the demo cast read the same inbox, so what the demo's people
// receive is asserted the way the e2e users' mail is (tests/e2e/demo-cast-mail.spec.ts).
const TEST_INBOX = resolveTestInbox({
  env: process.env,
  config: DEPLOY_CONFIG,
  // A dry run reads nothing from AWS, so it shows only an inbox the environment or the config names.
  ssm: needsSsmLookup({ env: process.env, config: DEPLOY_CONFIG, dryRun: DRY_RUN }) ? {
    domain: await ssmValue(`${SSM_ROOT}/test-inbox/domain`),
    bucket: await ssmValue(`${SSM_ROOT}/test-inbox/bucket`),
    prefix: await ssmValue(`${SSM_ROOT}/test-inbox/prefix`),
  } : {},
});
if (TEST_INBOX.problem) {
  console.error(`provision-test-users: ${TEST_INBOX.problem}`);
  process.exit(1);
}
const EMAIL_DOMAIN = TEST_INBOX.emailDomain;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || `testuser-admin@${EMAIL_DOMAIN}`;

const cognito = new CognitoIdentityProviderClient({ region });
const cfn = new CloudFormationClient({ region });
const secrets = new SecretsManagerClient({ region });

// Each entry maps to a field in the test-credentials secret. The admin is in
// `premium` too so it has premium model access on top of admin UI access.
const E2E_USERS = [
  { key: 'basicUser',    email: `testuser-basic@${EMAIL_DOMAIN}`,    tier: 'basic',    groups: ['basic'],            name: 'Test Basic' },
  { key: 'standardUser', email: `testuser-standard@${EMAIL_DOMAIN}`, tier: 'standard', groups: ['standard'],         name: 'Test Standard' },
  { key: 'premiumUser',  email: `testuser-premium@${EMAIL_DOMAIN}`,  tier: 'premium',  groups: ['premium'],          name: 'Test Premium' },
  { key: 'testAdmin',    email: ADMIN_EMAIL,                         tier: 'premium',  groups: ['admins', 'premium'], name: 'Test Admin' },
  // A SECOND premium identity, distinct from the admin and from `premiumUser` (which `seed-demo` re-points
  // at its own premium persona), so anything that turns on two different PEOPLE is exercised: who owns a duel, whose
  // reply resumes it, per-user battle picks, what a NON-moderator member sees. The e2e suite has read
  // this key for as long as those tests have existed and nothing here created it, so they self-skipped
  // with "no provisioned secondPremiumUser" - a permanent gate that reads like a deployment choice.
  { key: 'secondPremiumUser', email: `testuser-premium2@${EMAIL_DOMAIN}`, tier: 'premium', groups: ['premium'], name: 'Test Premium Two' },
  // Reserved for the ONBOARDING intake and used by nothing else, so its onboarding state is whatever
  // the onboarding spec last set it to - global-setup deliberately does not pre-onboard it. Same story
  // as secondPremiumUser one row up: the e2e read this key for as long as the intake spec existed,
  // nothing wrote it, and the phase self-skipped with a reason that read like a deployment choice.
  { key: 'onboardingUser', email: `testuser-onboarding@${EMAIL_DOMAIN}`, tier: 'standard', groups: ['standard'], name: 'Test Onboarding' },
  // THE OPERATIONS TEAM: two premium-cleared people in the `ops` membership group, which the `ops` and
  // `ops-team` conversation types add their people from. Premium FIRST, because `ops` grants nothing
  // and requires premium (DESIGN-CONVERSATION-TYPES §6). The lead is the person an `ops` event names; the
  // engineer is a second member, so a room the group populates is visibly a group.
  { key: 'opsLeadUser', email: `testuser-ops-lead@${EMAIL_DOMAIN}`, tier: 'premium', groups: ['premium', 'ops'], name: 'Test Ops Lead' },
  { key: 'opsEngineerUser', email: `testuser-ops-engineer@${EMAIL_DOMAIN}`, tier: 'premium', groups: ['premium', 'ops'], name: 'Test Ops Engineer' },
  // A TEAM MEMBER (SPEC-ADMIN-CONSOLE "Admin and team-member groups"). `team-members` is the admin role and
  // `team-ops` is the team; the team reaches the assistants whose AppInstanceBot carries `owner-team=ops`,
  // which is the ops assistant. It signs in to the admin console and can manage, and read analytics for,
  // that assistant only. The admin capability deny-test signs in as this user.
  { key: 'teamOpsUser', email: `testuser-team-ops@${EMAIL_DOMAIN}`, tier: 'premium', groups: ['premium', 'team-members', 'team-ops'], name: 'Test Team Ops' },
  // In `team-members` with NO team group: the case that must reach nothing rather than everything
  // (SPEC-ADMIN-CONSOLE acceptance criterion (c)). The deny-test asks for its console session and expects
  // the refusal.
  { key: 'teamNoTeamUser', email: `testuser-team-none@${EMAIL_DOMAIN}`, tier: 'premium', groups: ['premium', 'team-members'], name: 'Test Team None' },
  // THE PROBE IDENTITY IS GONE, with the `probe` classification it held (removed 2026-09-17). It
  // existed for ADR-041's flow-versus-Lex comparison; provisioning it now fails, because the Cognito
  // group is not created and no classification declares it.
];

// THE DEMO CAST (DEMO-SCRIPT Act 1 and Act 3.2). EVERY DEMO LOGIN IS A MAILBOX SOMETHING CAN READ: each
// person's DEMO_*_EMAIL when set, else `demo-<who>@<inbox domain>` when a test inbox resolves, so the
// demo's mail lands where tests/e2e/demo-cast-mail.spec.ts reads it, else a plus-address on the presenter's
// mailbox (`presenterMailbox` in deploy.config.json). The rule and the people are in lib/demo-cast.cjs.
const OPS_DEMO_CAST = opsDemoCast({ env: process.env, inboxDomain: TEST_INBOX.inbox?.domain || '', config: DEPLOY_CONFIG });

/**
 * `--only <key>[,<key>]` provisions just those users and leaves the rest of the secret untouched.
 *
 * Without it the only way to add one user is a full run, which resets EVERY user's password (a fresh
 * random one per run) and republishes the secret from this table alone. On a deployment whose e2e is
 * already signed in and whose demo data is tied to those accounts, that is a wide blast radius for
 * adding one login.
 */
const USERS = CAST === 'ops-demo' ? OPS_DEMO_CAST : E2E_USERS;

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
  const stack = `${resolveStackPrefix(process.env)}Identity`;
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  const out = {};
  for (const o of resp.Stacks?.[0]?.Outputs || []) {
    if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  }
  const userPoolId = out['UserPoolId'];
  const clientId = out['UserPoolClientId'];
  // The person credential exchange is a route on PersonApi: its base URL is that stack's output.
  const personStack = `${resolveStackPrefix(process.env)}PersonApi`;
  const person = await cfn.send(new DescribeStacksCommand({ StackName: personStack }));
  const exchangeUrl = (person.Stacks?.[0]?.Outputs || []).find((o) => o.OutputKey === 'PersonApiUrl')?.OutputValue;
  if (!userPoolId || !clientId || !exchangeUrl) {
    throw new Error(
      `${stack} UserPoolId / UserPoolClientId or ${personStack} PersonApiUrl outputs are missing. ` +
        'Deploy first: cd backend && npm run deploy',
    );
  }
  return { userPoolId, clientId, exchangeUrl };
}

/**
 * MAKE THE PERSON EXIST BY SIGNING THEM IN. Only the credential exchange creates an AppInstanceUser:
 * it mints the person, with an opaque UUID v7 id, at their first exchange, and resolves the same one on
 * every exchange after, refreshing the display name from the IdP's `name` claim (set in ensureUserExists).
 * So this signs the user in and calls the exchange, the signed path every client takes, and returns the
 * `userArn` it vended, which the secret records for the e2e suite. A rerun resolves the same person.
 */
async function ensurePerson(clientId, exchangeUrl, u) {
  const userArn = await signInAndExchange({
    cognito, InitiateAuthCommand, clientId, exchangeUrl, email: u.email, password: PASSWORD,
  });
  console.log(`    = person ${userArn}`);
  return userArn;
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
    // THE NAME CLAIM the credential exchange reads to keep the Chime display name current at sign-in.
    { Name: 'name', Value: u.name },
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
            // THE IDP OWNS THE NAME, so an existing user's is refreshed too; the exchange copies `name` into the
            // Chime display name at sign-in.
            { Name: 'name', Value: u.name },
            { Name: 'given_name', Value: u.name.split(' ')[0] },
            { Name: 'family_name', Value: u.name.split(' ').slice(1).join(' ') || 'User' },
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
 * Set the password and the group membership.
 *
 * Runs only AFTER the secret holds this password: the rotation is the irreversible half, and a
 * password nobody recorded is a user nobody can sign in as.
 */
async function applyCredentialAndAccess(userPoolId, u) {
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
    // A TEAM GROUP is deployment data, not infrastructure: each deployment names its own teams, so no
    // stack declares them. Create one the test cast needs if it is missing. It carries no role and no
    // precedence that could choose a person's role; it only names the team the ownership tags match.
    if (/^team-/.test(group) && group !== 'team-members') {
      try {
        await cognito.send(new CreateGroupCommand({
          UserPoolId: userPoolId,
          GroupName: group,
          Description: `Team ${group.slice('team-'.length)} - reaches the assistants whose AppInstanceBot carries owner-team=${group.slice('team-'.length)}`,
        }));
        console.log(`    + created team group ${group}`);
      } catch (err) {
        if (err.name !== 'GroupExistsException') console.warn(`    ! could not create team group "${group}": ${err.name || err.message}`);
      }
    }
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

}

/**
 * MERGES into the existing secret rather than replacing it. A wholesale replace drops any key this
 * table does not know about - `onboardingUser` is one the e2e reads and this script has never written -
 * so adding a user could silently un-provision another suite.
 *
 * `fillIfAbsent` supplies a key only when the secret has none, which is how `--only` mode leaves a
 * deliberately-chosen app client alone. See lib/test-user-secret.cjs for which key is which and why.
 */
async function readSecret() {
  try {
    const cur = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    return cur.SecretString ? JSON.parse(cur.SecretString) : {};
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
    return {};
  }
}

/**
 * Change a user's address IN PLACE, keeping its sub and so its Amazon Chime SDK identity. A user the
 * secret recorded under an old address that no longer exists is simply created fresh below.
 */
async function moveUserEmail(userPoolId, { key, from, to }) {
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: from }));
  } catch (err) {
    if (err.name === 'UserNotFoundException') return;
    throw err;
  }
  try {
    await cognito.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId,
      Username: from,
      UserAttributes: [{ Name: 'email', Value: to }, { Name: 'email_verified', Value: 'true' }],
    }));
    console.log(`  ~ moved ${key} ${from} -> ${to} (same user, same sub)`);
  } catch (err) {
    // Somebody already holds the new address. Leave both alone; the run below refreshes that user.
    if (err.name !== 'AliasExistsException') throw err;
    console.warn(`  ! ${key}: ${to} already belongs to another user, so ${from} was not moved`);
  }
}

async function writeSecret(patch, fillIfAbsent = {}) {
  const existing = await readSecret();
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
  const { userPoolId, clientId, exchangeUrl } = await getCognitoOutputs();
  console.log(`  pool=${userPoolId} client=${clientId}`);

  if (ONLY_KEYS) console.log(`  --only: ${SELECTED.map((u) => u.key).join(', ')} (other users and secret keys untouched)`);

  // A domain change MOVES the users the secret already knows, rather than creating a second set.
  for (const move of emailMoves(await readSecret(), SELECTED)) {
    await moveUserEmail(userPoolId, move);
  }

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
    testInbox: TEST_INBOX.inbox,
  });
  await writeSecret(patch, fillIfAbsent);

  // PASS 2: the irreversible half - password and groups.
  for (const u of SELECTED) {
    await applyCredentialAndAccess(userPoolId, u);
  }

  // PASS 3: each person signs in and calls the credential exchange, which mints their AppInstanceUser
  // on the first run and resolves it on every run after. The ARN it answers with is the person the e2e
  // suite acts as, recorded beside the login (the same merge as above, so other keys are untouched).
  const people = {};
  for (const u of SELECTED) {
    people[u.key] = { email: u.email, password: PASSWORD, tier: u.tier, userArn: await ensurePerson(clientId, exchangeUrl, u) };
  }
  await writeSecret(people);

  console.log('');
  console.log('Done. Test users ready (all share one password):');
  for (const u of SELECTED) console.log(`  ${u.key.padEnd(18)} ${u.email}`);
  console.log('');
  console.log(TEST_INBOX.inbox
    ? `Test inbox (${TEST_INBOX.source}): s3://${TEST_INBOX.inbox.bucket}/${TEST_INBOX.inbox.prefix} receives ${TEST_INBOX.inbox.domain}`
    : 'No test inbox: the email-delivery tests will skip. See README "Test inbox".');
  console.log('Next: cd tests && npm install && npx playwright install chromium && npm test');
}

/** What a run would do, read from the environment and this file alone. No AWS call is made. */
function printDryRun() {
  const prefix = resolveStackPrefix(process.env);
  console.log('provision-test-users --dry-run (no AWS call is made, nothing is changed)');
  console.log(`  instance        ${resolveInstanceName(process.env)}`);
  console.log(`  reads outputs   ${prefix}Identity (UserPoolId, UserPoolClientId), ${prefix}PersonApi (PersonApiUrl)`);
  console.log(`  writes secret   ${SECRET_NAME}${ONLY_KEYS ? ' (merge: only the selected keys)' : ' (merge)'}`);
  console.log(`  test inbox      ${TEST_INBOX.inbox ? `s3://${TEST_INBOX.inbox.bucket}/${TEST_INBOX.inbox.prefix} for ${TEST_INBOX.inbox.domain} (from the ${TEST_INBOX.source})` : 'none named in the environment or deploy.config.json (a real run also reads the TestInbox stack from SSM)'}`);
  console.log('  users (created or refreshed, password set, then signed in through the credential exchange):');
  for (const u of SELECTED) console.log(`    ${u.key.padEnd(18)} ${u.email.padEnd(40)} groups: ${u.groups.join(', ')}`);
  console.log('  each user\'s userArn is the one the exchange answers with, recorded in the secret beside the login.');
}

if (DRY_RUN) {
  printDryRun();
  process.exit(0);
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
