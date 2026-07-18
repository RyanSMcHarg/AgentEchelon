/**
 * Cognito Post-Confirmation Lambda Trigger
 *
 * Runs after a user confirms their email (via code). Responsibilities:
 * 1. Set custom:approved=false (admin must approve before use)
 * 2. Default custom:tier=basic if unset
 * 3. Mirror custom:tier into the matching Cognito group (basic/standard/premium)
 *    so downstream tier checks (create-conversation, router, share) can trust it
 * 4. Create the matching Chime AppInstance User
 */

const {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const {
  ChimeSDKIdentityClient,
  CreateAppInstanceUserCommand,
  DescribeAppInstanceUserCommand,
} = require('@aws-sdk/client-chime-sdk-identity');

const cognitoClient = new CognitoIdentityProviderClient({});
const chimeClient = new ChimeSDKIdentityClient({ region: 'us-east-1' });

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN;
const TIER_GROUPS = ['basic', 'standard', 'premium'];

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
    console.warn(`[PostConfirmation] Unknown tier "${tier}", defaulting to basic`);
    tier = 'basic';
  }

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

exports.handler = async (event) => {
  console.log('Post-confirmation trigger:', JSON.stringify(event, null, 2));

  const userPoolId = event.userPoolId;
  const username = event.userName;
  const email = event.request.userAttributes.email;
  const existingTier = event.request.userAttributes['custom:tier'];
  const tier = TIER_GROUPS.includes(existingTier) ? existingTier : 'basic';

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

  // 3. Create Chime App Instance User
  if (!APP_INSTANCE_ARN) {
    console.warn('[PostConfirmation] APP_INSTANCE_ARN not set, skipping Chime user creation');
    return event;
  }

  const appInstanceUserArn = `${APP_INSTANCE_ARN}/user/${username}`;
  try {
    try {
      await chimeClient.send(new DescribeAppInstanceUserCommand({
        AppInstanceUserArn: appInstanceUserArn,
      }));
      console.log(`[PostConfirmation] Chime user already exists: ${appInstanceUserArn}`);
    } catch (error) {
      if (error.name === 'NotFoundException' || error.name === 'ForbiddenException') {
        await chimeClient.send(new CreateAppInstanceUserCommand({
          AppInstanceArn: APP_INSTANCE_ARN,
          AppInstanceUserId: username,
          Name: email,
        }));
        console.log(`[PostConfirmation] Created Chime user: ${appInstanceUserArn}`);
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('[PostConfirmation] Error creating Chime user:', error);
    // Don't throw — we want confirmation to succeed even if this fails.
  }

  return event;
};
