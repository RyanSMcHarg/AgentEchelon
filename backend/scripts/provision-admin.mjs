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
 * Idempotent: re-running updates attributes + group membership. Without ADMIN_TEMP_PASSWORD it
 * re-sends the invitation (while the user is still pending a first sign-in); with it, it resets the
 * user back to the given temporary password (forcing a fresh first-login reset).
 *
 * Env:
 *   ADMIN_EMAIL          (required) the admin's email = Cognito username
 *   ADMIN_TEMP_PASSWORD  (optional) a one-time temp password to set (no email); else invite by email.
 *                        Either way the admin must set their own password on first sign-in.
 *   ADMIN_TIER           (optional) model tier group to also grant (default: premium)
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
// A one-time TEMPORARY password to set directly (email suppressed) so it can be handed over for a
// local bootstrap. When unset, Cognito emails the temp password instead. Either way the user is in
// FORCE_CHANGE_PASSWORD and must set their own password on first sign-in; this script never sets a
// permanent password.
const TEMP_PASSWORD = process.env.ADMIN_TEMP_PASSWORD || null;

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
    console.log(`  + created ${EMAIL}${invited ? ' (invitation email sent)' : ' (temporary password set)'}`);
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      await cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: userPoolId, Username: EMAIL, UserAttributes: attrs }));
      console.log(`  ~ updated existing ${EMAIL}`);
      if (TEMP_PASSWORD) {
        // Reset the existing user to the given TEMPORARY password (Permanent:false -> back to
        // FORCE_CHANGE_PASSWORD, so first sign-in forces a fresh reset).
        await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: EMAIL, Password: TEMP_PASSWORD, Permanent: false }));
        console.log('  + reset to the given temporary password (must reset on next sign-in)');
      } else {
        // Re-send the invitation — only succeeds while the user is still pending a first
        // sign-in. A user who already set a password can't be re-invited.
        try {
          await cognito.send(new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: EMAIL, MessageAction: 'RESEND' }));
          invited = true;
          console.log('  + invitation re-sent');
        } catch (e) {
          console.warn(`  ! could not re-send invitation (${e.name || e.message}); the user has likely already set a password. Pass ADMIN_TEMP_PASSWORD to reset it to a temporary password, or delete + re-run for a fresh invite.`);
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

  await ensureChimeUser(appInstanceArn, userPoolId);

  console.log('');
  console.log(`Done. ${EMAIL} is an admin (groups: admins, ${TIER}).`);
  if (TEMP_PASSWORD) {
    console.log(`Temporary password set (email suppressed). Sign in with it at the app URL as ${EMAIL};`);
    console.log(`the app forces a permanent-password reset on first sign-in (NEW_PASSWORD_REQUIRED).`);
  } else if (invited) {
    console.log(`Cognito emailed ${EMAIL} a one-time temporary password. On first sign-in the app forces`);
    console.log(`them to set their own permanent password. This script stored nothing.`);
  } else {
    console.log(`Existing user: attributes/groups synced, no password changed. Pass ADMIN_TEMP_PASSWORD to`);
    console.log(`reset it, or delete the user and re-run for a fresh invitation email.`);
  }
}

main().catch((err) => {
  console.error('provision-admin failed:', err);
  process.exit(1);
});
