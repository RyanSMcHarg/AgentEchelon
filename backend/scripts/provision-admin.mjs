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
 * DEFAULT (no ADMIN_PASSWORD): the user is created through the standard Cognito invitation —
 * Cognito emails a ONE-TIME temporary password and forces the user to set their own permanent
 * password on first sign-in (the SPA handles NEW_PASSWORD_REQUIRED). Nothing is stored; the
 * human owns their password and this script never sees it.
 *
 * ADMIN_PASSWORD=<pw> (automation only): sets that permanent password directly (user CONFIRMED,
 * no email). Secrets Manager is deliberately NOT used here — that pattern is for TEST/automation
 * accounts a script must read back (see seed-demo's test-credentials), not a human admin.
 *
 * Idempotent: re-running updates attributes + group membership; without ADMIN_PASSWORD it
 * re-sends the invitation while the user is still pending a first sign-in.
 *
 * Env:
 *   ADMIN_EMAIL     (required) the admin's email = Cognito username
 *   ADMIN_PASSWORD  (optional) set a specific permanent password (automation); else invite by email
 *   ADMIN_TIER      (optional) model tier group to also grant (default: premium)
 *   ADMIN_NAME      (optional) display name (default: derived from email)
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
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const region = process.env.AWS_REGION || 'us-east-1';
const EMAIL = process.env.ADMIN_EMAIL;
const TIER = process.env.ADMIN_TIER || 'premium';
if (!EMAIL) {
  console.error('ADMIN_EMAIL is required, e.g. ADMIN_EMAIL=you@example.com node backend/scripts/provision-admin.mjs');
  process.exit(2);
}
const NAME = process.env.ADMIN_NAME || EMAIL.split('@')[0];
// When set, the operator chose a specific permanent password (automation/self). When unset,
// the user is invited: Cognito generates + emails a one-time temporary password and forces a
// reset on first sign-in. This script never generates or stores a password.
const PASSWORD = process.env.ADMIN_PASSWORD || null;

const cognito = new CognitoIdentityProviderClient({ region });
const chimeIdentity = new ChimeSDKIdentityClient({ region });
const cfn = new CloudFormationClient({ region });

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
  let invited = false;
  try {
    // No ADMIN_PASSWORD -> omit MessageAction so Cognito EMAILS a one-time temporary
    // password (the standard invitation). With ADMIN_PASSWORD -> SUPPRESS; we set it below.
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: EMAIL,
      UserAttributes: attrs,
      ...(PASSWORD ? { MessageAction: 'SUPPRESS' } : {}),
    }));
    invited = !PASSWORD;
    console.log(`  + created ${EMAIL}${invited ? ' (invitation email sent)' : ''}`);
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      await cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: userPoolId, Username: EMAIL, UserAttributes: attrs }));
      console.log(`  ~ updated existing ${EMAIL}`);
      if (!PASSWORD) {
        // Re-send the invitation — only succeeds while the user is still pending a first
        // sign-in. A user who already set a password can't be re-invited.
        try {
          await cognito.send(new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: EMAIL, MessageAction: 'RESEND' }));
          invited = true;
          console.log('  + invitation re-sent');
        } catch (e) {
          console.warn(`  ! could not re-send invitation (${e.name || e.message}); the user has likely already set a password. Pass ADMIN_PASSWORD to reset it, or delete + re-run for a fresh invite.`);
        }
      }
    } else throw err;
  }

  // Only set a password when the operator supplied one. Otherwise the emailed temporary
  // password stands and the user must set their own on first sign-in (the SPA handles
  // NEW_PASSWORD_REQUIRED). Nothing is stored either way.
  if (PASSWORD) {
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: EMAIL, Password: PASSWORD, Permanent: true }));
  }

  for (const group of ['admins', TIER]) {
    try {
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: EMAIL, GroupName: group }));
      console.log(`  + group ${group}`);
    } catch (err) {
      console.warn(`    ! could not add to group "${group}": ${err.name || err.message}`);
    }
  }

  await ensureChimeUser(appInstanceArn, userPoolId);

  console.log('');
  console.log(`Done. ${EMAIL} is an admin (groups: admins, ${TIER}).`);
  if (PASSWORD) {
    console.log(`Set the ADMIN_PASSWORD you supplied; the user is CONFIRMED. Sign in at the app URL with ${EMAIL}.`);
  } else if (invited) {
    console.log(`Cognito emailed ${EMAIL} a one-time temporary password. On first sign-in the app prompts`);
    console.log(`them to set their own permanent password. This script stored nothing.`);
  } else {
    console.log(`Existing user: no email sent and no password changed. Pass ADMIN_PASSWORD to set one, or`);
    console.log(`delete the user and re-run for a fresh invitation email.`);
  }
}

main().catch((err) => {
  console.error('provision-admin failed:', err);
  process.exit(1);
});
