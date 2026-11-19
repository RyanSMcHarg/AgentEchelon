/**
 * Cognito Post-Confirmation Lambda Trigger
 *
 * Runs after a user confirms their email (via code). Responsibilities:
 * 1. Set custom:approved=false (admin must approve before use)
 * 2. Record the tier a sign-up asked for, or nothing when it is unset or undeclared
 *
 * THE TIER IS A REQUEST. A client writes it at sign-up, so this trigger adds nobody to a clearance group:
 * an administrator names the clearance at approval, and that is what authorization reads.
 *
 * IT CREATES NO AppInstanceUser. Only the credential exchange creates a person (lib/person-identity.ts),
 * at their first sign-in, with an opaque id minted for their (issuer, subject). A trigger that created
 * one here would key it on the Cognito username, a second id for the same human.
 */

const {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const cognitoClient = new CognitoIdentityProviderClient({});
// THE CLEARANCE GROUPS, FROM DEPLOYMENT CONFIG. They decide which requested tiers are recorded as asked. This
// trigger is deployed with `lambda.Code.fromAsset`, a raw directory, so it reads the deployment's registry
// rows at runtime (`registry-admission.js`) rather than importing `lib/profile-registry`.
const { loadAdmission } = require('./registry-admission');
let TIER_GROUPS = [];
// What a sign-up records when it carries no tier, or one this deployment does not declare: nothing.
// There is no floor; an unapproved person reaches nothing, and `pre-authentication` blocks them until approval.
const FAIL_CLOSED_TO = '';

async function setAttributes(userPoolId, username, attrs) {
  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId,
    Username: username,
    UserAttributes: attrs,
  }));
}

/** The one trigger source this handler acts on. See the guard at the top of `handler`. */
const SIGN_UP_CONFIRMED = 'PostConfirmation_ConfirmSignUp';

exports.handler = async (event) => {
  TIER_GROUPS = (await loadAdmission()).clearanceGroups || [];
  console.log('Post-confirmation trigger:', JSON.stringify(event, null, 2));

  // SIGN-UP ONLY. Cognito also runs this trigger after a password reset
  // (`PostConfirmation_ConfirmForgotPassword`), and `custom:tier` is self-writable, because sign-up sends
  // it as the REQUESTED tier. Acting on a reset let an approved user write `custom:tier`, reset their own
  // password, and be moved into that clearance group with no admin approval (security review,
  // 2026-10-13). It also set `approved=false` on every reset, locking the person out. A sign-up is
  // confirmed once, so after it only an admin moves a person between clearance groups.
  if (event.triggerSource !== SIGN_UP_CONFIRMED) {
    console.log(`[PostConfirmation] ${event.triggerSource}: not a sign-up; clearance and approval are left alone`);
    return event;
  }

  const userPoolId = event.userPoolId;
  const username = event.userName;
  const existingTier = event.request.userAttributes['custom:tier'];
  const tier = TIER_GROUPS.includes(existingTier) ? existingTier : FAIL_CLOSED_TO;

  // 1. Set approved=false and default the tier attribute if missing
  try {
    await setAttributes(userPoolId, username, [
      { Name: 'custom:approved', Value: 'false' },
      { Name: 'custom:tier', Value: tier },
    ]);
    console.log(`[PostConfirmation] Set approved=false, tier=${tier} for ${username}`);
  } catch (error) {
    console.error('[PostConfirmation] Error updating user attributes:', error);
    // Don't throw — we want confirmation to succeed even if this fails.
  }

  return event;
};
