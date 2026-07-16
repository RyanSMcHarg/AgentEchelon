#!/usr/bin/env node
/**
 * Backfill: mirror every user's custom:tier attribute into the matching
 * Cognito group (basic / standard / premium). Users without a tier attribute
 * default to `basic`.
 *
 * Safe to re-run: the script removes a user from any other tier group before
 * adding to the target group, so multi-group drift is corrected.
 *
 * Usage:
 *   AWS_PROFILE=<your-profile> USER_POOL_ID=us-east-1_xxx \
 *     node backend/scripts/backfill-tier-groups.mjs
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.USER_POOL_ID;

if (!USER_POOL_ID) {
  console.error('USER_POOL_ID env var is required');
  process.exit(1);
}

const client = new CognitoIdentityProviderClient({ region: REGION });
const TIER_GROUPS = ['basic', 'standard', 'premium'];

async function syncOne(username, tier) {
  let existing = [];
  try {
    const res = await client.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    }));
    existing = (res.Groups || []).map((g) => g.GroupName);
  } catch (err) {
    console.warn(`  list groups failed for ${username}:`, err.name);
  }

  for (const other of TIER_GROUPS) {
    if (other !== tier && existing.includes(other)) {
      await client.send(new AdminRemoveUserFromGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: other,
      }));
    }
  }

  if (!existing.includes(tier)) {
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: tier,
    }));
    return 'added';
  }
  return 'already';
}

async function main() {
  let paginationToken;
  let scanned = 0;
  let added = 0;
  let already = 0;
  let failed = 0;

  do {
    const result = await client.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Limit: 60,
      PaginationToken: paginationToken,
    }));

    for (const user of result.Users || []) {
      scanned++;
      const username = user.Username;
      const email = user.Attributes?.find((a) => a.Name === 'email')?.Value || username;
      const tierAttr = user.Attributes?.find((a) => a.Name === 'custom:tier')?.Value;
      const tier = TIER_GROUPS.includes(tierAttr) ? tierAttr : 'basic';

      try {
        const outcome = await syncOne(username, tier);
        console.log(`  ${outcome === 'added' ? '+' : '='} ${email} → ${tier}`);
        if (outcome === 'added') added++;
        else already++;
      } catch (err) {
        console.log(`  ✗ ${email}: ${err.message}`);
        failed++;
      }
    }

    paginationToken = result.PaginationToken;
  } while (paginationToken);

  console.log();
  console.log(`Scanned: ${scanned}`);
  console.log(`Newly added to group: ${added}`);
  console.log(`Already in correct group: ${already}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
