/**
 * Cognito Post-Confirmation Lambda Trigger
 *
 * Runs after a user confirms their email (via code). Responsibilities:
 * 1. Set custom:approved=false (admin must approve before use)
 * 2. Default custom:tier to the deployment's fail-closed floor if unset or undeclared
 * 3. Mirror custom:tier into the matching Cognito group (the deployment's clearance groups)
 *    so downstream tier checks (create-conversation, router, share) can trust it
 *
 * IT CREATES NO AppInstanceUser. Only the credential exchange creates a person (lib/person-identity.ts),
 * at their first sign-in, with an opaque id minted for their (issuer, subject). A trigger that created
 * one here would key it on the Cognito username, a second id for the same human.
 */

const {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const cognitoClient = new CognitoIdentityProviderClient({});
// ── THE CLEARANCE GROUPS, FROM DEPLOYMENT CONFIG ────────────────────────────────────────────
//
// THIS MIRRORS `ProfileRegistry.clearanceGroups()`, and it is a mirror rather than a call because this
// trigger is deployed with `lambda.Code.fromAsset` - a raw directory, not an esbuild bundle - so it cannot
// import `lib/profile-registry`. It reads the deployment's registry rows at runtime (`registry-admission.js`),
// so a classification added or removed changes nothing in its environment.
//
// WHAT IT REPLACES: `TIER_GROUPS = ['basic', 'standard', 'premium']`, deployment config frozen in
// code. A deployment declaring a fourth classification got two failures from that one literal - a new
// signup carrying that tier was silently reset to `basic`, and the exclusivity sweep below left them
// in the old group as well, so precedence went to whichever writer ran last.
//
// ADMIN-PLANE GROUPS ARE NOT IN THIS SET, by construction in `clearanceGroups()`. They are a separate
// grant rather than a level, so the sweep must never strip one. Read at the start of every invocation.
const { loadAdmission } = require('./registry-admission');
let TIER_GROUPS = [];
// The floor a signup lands on when it carries no tier, or one this deployment does not declare.
// Absent config is a deployment fault; `''` makes the group writes below no-ops rather than inventing
// a group name, which is the fail-closed direction - an unapproved user with no clearance group
// reaches nothing, and `pre-authentication` blocks them until an administrator approves them anyway.
// Always `''`: this read `ADMISSION.failClosedTo`, a key the admission payload no longer carries
// (ADR-046 removed the floor, `lib/classification-admission.ts`), so the empty branch above is the
// only one that ever ran. Named directly so the behavior is not mistaken for a configurable floor.
const FAIL_CLOSED_TO = '';

async function setAttributes(userPoolId, username, attrs) {
  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId,
    Username: username,
    UserAttributes: attrs,
  }));
}

/**
 * Make sure the user is in exactly one tier group: the one matching `tier`.
 * Removes them from any other tier group first so precedence can't drift.
 */
async function syncTierGroup(userPoolId, username, tier) {
  if (!TIER_GROUPS.includes(tier)) {
    console.warn(`[PostConfirmation] Unknown tier "${tier}", defaulting to ${FAIL_CLOSED_TO || '(none)'}`);
    tier = FAIL_CLOSED_TO;
  }
  if (!tier) {
    console.error('[PostConfirmation] no clearance groups configured; leaving group membership alone');
    return;
  }

  // THE ONE GROUP READ OUTSIDE THE CLEARANCE SEAM, and deliberately. This is a trigger of the pool
  // itself, invoked by Cognito for one of its own users at confirmation, before that user has ever signed
  // in: there is no person to resolve through `Identities` yet, the user is named by the event, and the
  // read serves the pool's own group bookkeeping rather than an access decision. It is a raw directory
  // shipped as an asset, so it cannot import the seam. `clearance-has-one-provider-seam.test.ts` allows
  // this file by name for that reason.
  let existingGroups = [];
  try {
    const res = await cognitoClient.send(new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    }));
    existingGroups = (res.Groups || []).map((g) => g.GroupName);
  } catch (err) {
    console.warn('[PostConfirmation] Could not list user groups:', err.name);
  }

  for (const other of TIER_GROUPS) {
    if (other !== tier && existingGroups.includes(other)) {
      try {
        await cognitoClient.send(new AdminRemoveUserFromGroupCommand({
          UserPoolId: userPoolId,
          Username: username,
          GroupName: other,
        }));
      } catch (err) {
        console.warn(`[PostConfirmation] Could not remove from group ${other}:`, err.name);
      }
    }
  }

  if (!existingGroups.includes(tier)) {
    try {
      await cognitoClient.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: username,
        GroupName: tier,
      }));
      console.log(`[PostConfirmation] Added ${username} to group ${tier}`);
    } catch (err) {
      console.error(`[PostConfirmation] Failed to add to group ${tier}:`, err);
    }
  }
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

  // 2. Mirror tier into Cognito group (single source of truth for authorization)
  try {
    await syncTierGroup(userPoolId, username, tier);
  } catch (err) {
    console.error('[PostConfirmation] Tier group sync failed:', err);
  }

  return event;
};
