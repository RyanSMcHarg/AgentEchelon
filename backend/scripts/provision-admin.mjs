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
 * The admin ALWAYS sets their own password on first sign-in — this script never establishes a
 * permanent password. Two ways to deliver the one-time TEMPORARY password:
 *
 * DEFAULT (no ADMIN_TEMP_PASSWORD): the user is created through the standard Cognito invitation —
 * Cognito EMAILS a one-time temporary password. On first sign-in the SPA forces a reset
 * (NEW_PASSWORD_REQUIRED). Nothing is stored; this script never sees the password.
 *
 * ADMIN_TEMP_PASSWORD=<pw> (no email, e.g. a local bootstrap): creates the user in
 * FORCE_CHANGE_PASSWORD state with THIS temporary password (email suppressed), so you can hand it
 * over directly. First sign-in still forces a reset. It is a TEMPORARY password, never permanent.
 *
 * IT CREATES NO AppInstanceUser. Only the credential exchange creates a person (
 * lambda/src/lib/person-identity.ts): the admin's AppInstanceUser is minted, with an opaque UUID v7 id,
 * the first time they sign in to the app and it calls the exchange. This script cannot sign in for
 * them - their first sign-in sets their own password - so it leaves the person to that sign-in.
 *
 * IT REPORTS THE PERSON ONCE THERE IS ONE. Every run ends by reading the admin's row in the Identities
 * table (read-only, keyed by the pool's issuer and the admin's Cognito subject) and prints their
 * AppInstanceUser ARN, which is the value `briefingRecipientArns` and `alertRecipientArns` take. Before
 * the admin's first sign-in there is no row, and the run says so.
 *
 * `--print-arn` ONLY READS: it prints the admin's AppInstanceUser ARN and changes nothing in the pool,
 * so it is how the ARN is read after the admin's first sign-in. It needs ADMIN_EMAIL alone.
 *
 * `--dry-run` reads nothing from AWS and changes nothing: it prints the stack, the groups and the
 * attributes a run would apply, then exits.
 *
 * Idempotent: re-running updates attributes + group membership. Without ADMIN_TEMP_PASSWORD it
 * re-sends the invitation (while the user is still pending a first sign-in). AN EXISTING USER'S PASSWORD
 * IS NOT RESET BY A RE-RUN: with ADMIN_TEMP_PASSWORD it is reset to that temporary password only when
 * `--reset-password` is passed too, because an admin who has signed in holds a permanent password a
 * re-run would otherwise take from them.
 *
 * Env:
 *   ADMIN_EMAIL          (required) the admin's email = Cognito username
 *   ADMIN_TEMP_PASSWORD  (optional) a one-time temp password to set (no email); else invite by email.
 *                        Either way the admin must set their own password on first sign-in.
 *   ADMIN_TIER           (required, except with --print-arn) the classification group to also grant,
 *                        e.g. premium. No default: a classification is set or not (ADR-046), so the
 *                        operator names it.
 *   ADMIN_NAME           (optional) display name (default: derived from email)
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { personIdFromArn } = require('./lib/person-arn.cjs');

const region = process.env.AWS_REGION || 'us-east-1';
const DRY_RUN = process.argv.includes('--dry-run');
const PRINT_ARN = process.argv.includes('--print-arn');
const RESET_PASSWORD = process.argv.includes('--reset-password');
const EMAIL = process.env.ADMIN_EMAIL;
const TIER = (process.env.ADMIN_TIER || '').trim();
if (!EMAIL) {
  console.error('ADMIN_EMAIL is required, e.g. ADMIN_EMAIL=you@example.com ADMIN_TIER=premium node backend/scripts/provision-admin.mjs');
  process.exit(2);
}
if (!TIER && !PRINT_ARN) {
  console.error('ADMIN_TIER is required: the classification group to grant, e.g. ADMIN_TIER=premium. There is no default.');
  process.exit(2);
}
const NAME = process.env.ADMIN_NAME || EMAIL.split('@')[0];
// A one-time TEMPORARY password to set directly (email suppressed) so it can be handed over for a
// local bootstrap. When unset, Cognito emails the temp password instead. Either way the user is in
// FORCE_CHANGE_PASSWORD and must set their own password on first sign-in; this script never sets a
// permanent password.
const TEMP_PASSWORD = process.env.ADMIN_TEMP_PASSWORD || null;

const cognito = new CognitoIdentityProviderClient({ region });
const cfn = new CloudFormationClient({ region });

async function outputs(stack) {
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  const out = {};
  for (const o of resp.Stacks?.[0]?.Outputs || []) if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  return out;
}

/**
 * The admin's AppInstanceUser, read from the Identities row the credential exchange wrote at their first
 * sign-in. Null when there is none yet. Read-only: only the exchange writes this table.
 *
 * The row key is `<issuerId>|<subject>` (lambda/src/lib/person-identity.ts `issuerSubjectKey`): this
 * deployment's own pool is the trusted-issuer registry id `deployment` (lib/config/issuers.ts).
 */
async function personOf(userPoolId) {
  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: EMAIL }));
  const subject = (user.UserAttributes || []).find((a) => a.Name === 'sub')?.Value;
  if (!subject) return null;
  const tableParam = `/${resolveInstanceName(process.env)}/shared/tables/identities-name`;
  const table = (await new SSMClient({ region }).send(new GetParameterCommand({ Name: tableParam }))).Parameter?.Value;
  if (!table) throw new Error(`${tableParam} is not published; deploy Identity first`);
  const row = await new DynamoDBClient({ region }).send(new GetItemCommand({
    TableName: table,
    Key: { issuerSubject: { S: `deployment|${subject}` } },
  }));
  const arn = row.Item?.personArn?.S || '';
  return personIdFromArn(arn) ? arn : null;
}

/** What a run would do, from the environment alone. No AWS call is made. */
function printDryRun() {
  console.log('provision-admin --dry-run (no AWS call is made, nothing is changed)');
  console.log(`  instance        ${resolveInstanceName(process.env)}`);
  if (PRINT_ARN) {
    console.log(`  --print-arn     reads ${EMAIL}'s Identities row and prints their AppInstanceUser; changes nothing`);
    return;
  }
  console.log(`  reads outputs   ${resolveStackPrefix(process.env)}Identity (UserPoolId, UserPoolClientId)`);
  console.log(`  user            ${EMAIL} (${NAME}), groups: admins, ${TIER}`);
  console.log(`  password        ${TEMP_PASSWORD ? 'the given temporary password, email suppressed' : 'Cognito emails a one-time temporary password'}; first sign-in sets their own`);
  console.log(`  existing user   password ${TEMP_PASSWORD && RESET_PASSWORD ? 'reset to the given temporary password (--reset-password)' : 'left as it is'}`);
  console.log(`  then reads      /${resolveInstanceName(process.env)}/shared/tables/identities-name and the admin's Identities row, to print their AppInstanceUser once they have signed in`);
}

/** The deployment's pool, from the Identity stack's outputs. */
async function userPool() {
  const prefix = resolveStackPrefix(process.env);
  const cog = await outputs(`${prefix}Identity`);
  const userPoolId = cog['UserPoolId'];
  const clientId = cog['UserPoolClientId'];
  if (!userPoolId || !clientId) throw new Error(`${prefix}Identity missing UserPoolId/UserPoolClientId outputs.`);
  return userPoolId;
}

/** `--print-arn`: the admin's AppInstanceUser ARN, read only. Nothing in the pool is changed. */
async function printArn() {
  const person = await personOf(await userPool());
  if (!person) {
    console.log(`${EMAIL} has no AppInstanceUser yet. It is created by the credential exchange at their first sign-in.`);
    process.exit(3);
  }
  console.log(person);
}

async function main() {
  console.log(`Provisioning admin ${EMAIL} (tier=${TIER}, groups=admins+${TIER})...`);
  const userPoolId = await userPool();

  const attrs = [
    { Name: 'email', Value: EMAIL },
    { Name: 'email_verified', Value: 'true' },
    { Name: 'custom:tier', Value: TIER },
    { Name: 'custom:approved', Value: 'true' },
    { Name: 'given_name', Value: NAME.split(/[.\s]/)[0] || NAME },
    { Name: 'family_name', Value: NAME.split(/[.\s]/).slice(1).join(' ') || 'Admin' },
  ];
  let invited = false;
  // Whether this run set a temporary password: on a create with ADMIN_TEMP_PASSWORD, or a reset by flag.
  let temporarySet = false;
  try {
    // With ADMIN_TEMP_PASSWORD: create in FORCE_CHANGE_PASSWORD state with that temporary password
    // and SUPPRESS the email. Without it: omit both so Cognito EMAILS a one-time temporary password
    // (the standard invitation). Either path forces a permanent-password reset on first sign-in.
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: EMAIL,
      UserAttributes: attrs,
      ...(TEMP_PASSWORD ? { TemporaryPassword: TEMP_PASSWORD, MessageAction: 'SUPPRESS' } : {}),
    }));
    invited = !TEMP_PASSWORD;
    temporarySet = !!TEMP_PASSWORD;
    console.log(`  + created ${EMAIL}${invited ? ' (invitation email sent)' : ' (temporary password set)'}`);
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      await cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: userPoolId, Username: EMAIL, UserAttributes: attrs }));
      console.log(`  ~ updated existing ${EMAIL}`);
      if (TEMP_PASSWORD && RESET_PASSWORD) {
        // Reset the existing user to the given TEMPORARY password (Permanent:false -> back to
        // FORCE_CHANGE_PASSWORD, so first sign-in forces a fresh reset). Only when the flag asks.
        await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: EMAIL, Password: TEMP_PASSWORD, Permanent: false }));
        temporarySet = true;
        console.log('  + reset to the given temporary password (must reset on next sign-in)');
      } else if (TEMP_PASSWORD) {
        console.log('  = password left as it is (the user exists; pass --reset-password to reset it to ADMIN_TEMP_PASSWORD)');
      } else {
        // Re-send the invitation — only succeeds while the user is still pending a first
        // sign-in. A user who already set a password can't be re-invited.
        try {
          await cognito.send(new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: EMAIL, MessageAction: 'RESEND' }));
          invited = true;
          console.log('  + invitation re-sent');
        } catch (e) {
          console.warn(`  ! could not re-send invitation (${e.name || e.message}); the user has likely already set a password. Pass ADMIN_TEMP_PASSWORD with --reset-password to reset it to a temporary password, or delete + re-run for a fresh invite.`);
        }
      }
    } else throw err;
  }

  for (const group of ['admins', TIER]) {
    try {
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: EMAIL, GroupName: group }));
      console.log(`  + group ${group}`);
    } catch (err) {
      console.warn(`    ! could not add to group "${group}": ${err.name || err.message}`);
    }
  }

  console.log('');
  console.log(`Done. ${EMAIL} is an admin (groups: admins, ${TIER}).`);
  const person = await personOf(userPoolId).catch((err) => {
    console.warn(`  ! could not read the admin's Identities row: ${err.name || err.message}`);
    return null;
  });
  if (person) {
    console.log(`Their AppInstanceUser: ${person}`);
    console.log('This is the value briefingRecipientArns and alertRecipientArns take in deploy.config.json.');
  } else {
    console.log('Their AppInstanceUser is created by the credential exchange at their first sign-in.');
    console.log('After that sign-in, run this with --print-arn to print it (the value the recipient keys take).');
  }
  if (temporarySet) {
    console.log(`Temporary password set (email suppressed). Sign in with it at the app URL as ${EMAIL};`);
    console.log(`the app forces a permanent-password reset on first sign-in (NEW_PASSWORD_REQUIRED).`);
  } else if (invited) {
    console.log(`Cognito emailed ${EMAIL} a one-time temporary password. On first sign-in the app forces`);
    console.log(`them to set their own permanent password. This script stored nothing.`);
  } else {
    console.log(`Existing user: attributes/groups synced, no password changed. Pass ADMIN_TEMP_PASSWORD with`);
    console.log(`--reset-password to reset it, or delete the user and re-run for a fresh invitation email.`);
  }
}

if (DRY_RUN) {
  printDryRun();
  process.exit(0);
}

(PRINT_ARN ? printArn() : main()).catch((err) => {
  console.error('provision-admin failed:', err);
  process.exit(1);
});
