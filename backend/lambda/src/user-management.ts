/**
 * User Management Lambda
 *
 * Admin API for managing Cognito users: list, approve, reject, change tier.
 * Protected by Cognito authorizer — only premium-tier users can access.
 *
 * Routes:
 *   GET  /users           — List all users with attributes
 *   POST /users/approve   — Approve a pending user
 *   POST /users/reject    — Reject (disable) a user
 *   POST /users/tier      — Change a user's tier
 *   POST /users/enable    — Re-enable a disabled user
 *   POST /users/delete    — Full-lifecycle delete (Cognito user + AppInstanceUser)
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminUpdateUserAttributesCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  ChimeSDKIdentityClient,
  CreateAppInstanceUserCommand,
  DescribeAppInstanceUserCommand,
  DeleteAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import {
  ChimeSDKMessagingClient,
  ListChannelMembershipsForAppInstanceUserCommand,
  DeleteChannelMembershipCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { parseJsonBody, callerIsAdmin } from './lib/auth.js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const cognitoClient = new CognitoIdentityProviderClient({});
const chimeClient = new ChimeSDKIdentityClient({ region: REGION });
const messagingClient = new ChimeSDKMessagingClient({ region: REGION });
const ssmClient = new SSMClient({ region: REGION });

const USER_POOL_ID = process.env.USER_POOL_ID || '';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
// The app-instance-admin ARN (moderator-of-everything) — bearer for membership
// cleanup on delete. Same SSM key admin-conversations uses (SPEC-MODERATION).
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';
let cachedAdminArn: string | null = null;
async function getAdminArn(): Promise<string | null> {
  if (cachedAdminArn) return cachedAdminArn;
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: ADMIN_ARN_PARAM }));
    cachedAdminArn = resp.Parameter?.Value || null;
  } catch {
    cachedAdminArn = null;
  }
  return cachedAdminArn;
}
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',');

const CLEARANCE_GROUPS = ['basic', 'standard', 'premium'] as const;
type Clearance = typeof CLEARANCE_GROUPS[number];

/** Make sure the user is in exactly one clearance group. Idempotent. */
async function syncClearanceGroup(username: string, clearance: Clearance): Promise<void> {
  let existing: string[] = [];
  try {
    const res = await cognitoClient.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    }));
    existing = (res.Groups || []).map((g) => g.GroupName || '').filter(Boolean);
  } catch (err) {
    console.warn('[UserManagement] listGroups failed:', (err as Error).name);
  }

  // Remove from other clearance groups so the user holds exactly one clearance.
  for (const other of CLEARANCE_GROUPS) {
    if (other !== clearance && existing.includes(other)) {
      try {
        await cognitoClient.send(new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: other,
        }));
      } catch (err) {
        console.warn(`[UserManagement] remove ${other} failed:`, (err as Error).name);
      }
    }
  }

  if (!existing.includes(clearance)) {
    await cognitoClient.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: clearance,
    }));
    console.log(`[UserManagement] Added ${username} to ${clearance}`);
  }
}

function corsHeaders(origin?: string) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin',
  };
}

function isAllowedOrigin(origin?: string): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

interface UserRecord {
  username: string;
  email: string;
  tier: string;
  approved: string;
  status: string;
  enabled: boolean;
  createdAt: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const origin = event.headers?.origin || event.headers?.Origin;
  const path = event.path;
  const method = event.httpMethod;

  console.log('[UserManagement]', method, path);

  if (!isAllowedOrigin(origin)) {
    return respond(403, { error: 'Origin not allowed' }, origin);
  }

  try {
    // Gate on the admins group, not custom:tier — a paying tier is not admin
    // permission. Per CLAUDE.md, Cognito groups are authoritative.
    // Shared, IdP-agnostic check (honors ADMIN_GROUP_NAMES + service mode).
    if (!callerIsAdmin(event)) {
      return respond(403, { error: 'Admin access required' }, origin);
    }

    // GET /users — list all users
    if (method === 'GET' && path.endsWith('/users')) {
      return respond(200, await listUsers(), origin);
    }

    // 400 on malformed JSON instead of 500.
    const parsed = parseJsonBody<{ username?: string; tier?: string }>(event, origin);
    if ('statusCode' in parsed) return parsed;
    const body = parsed.body;
    const { username } = body;
    if (!username) {
      return respond(400, { error: 'username is required' }, origin);
    }

    // POST /users/approve
    if (method === 'POST' && path.endsWith('/approve')) {
      await approveUser(username, body.tier || 'basic');
      return respond(200, { message: `User ${username} approved`, tier: body.tier || 'basic' }, origin);
    }

    // POST /users/reject
    if (method === 'POST' && path.endsWith('/reject')) {
      await rejectUser(username);
      return respond(200, { message: `User ${username} disabled` }, origin);
    }

    // POST /users/tier  (wire field stays `tier`; it is the user's clearance)
    if (method === 'POST' && path.endsWith('/tier')) {
      const { tier: clearance } = body;
      if (!clearance || !['basic', 'standard', 'premium'].includes(clearance)) {
        return respond(400, { error: 'tier must be basic, standard, or premium' }, origin);
      }
      await changeClearance(username, clearance);
      return respond(200, { message: `User ${username} tier changed to ${clearance}` }, origin);
    }

    // POST /users/enable
    if (method === 'POST' && path.endsWith('/enable')) {
      await enableUser(username);
      return respond(200, { message: `User ${username} re-enabled` }, origin);
    }

    // POST /users/delete — full-lifecycle offboard (SPEC-CREDENTIAL-EXCHANGE §5b)
    if (method === 'POST' && path.endsWith('/delete')) {
      await deleteUser(username);
      return respond(200, { message: `User ${username} deleted` }, origin);
    }

    return respond(404, { error: 'Not found' }, origin);

  } catch (error) {
    // Don't echo raw error.message to client.
    console.error('[UserManagement] Error:', error);
    return respond(500, { error: 'Internal error' }, origin);
  }
};

async function listUsers(): Promise<{ users: UserRecord[] }> {
  const users: UserRecord[] = [];
  let paginationToken: string | undefined;

  do {
    const result = await cognitoClient.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Limit: 60,
      PaginationToken: paginationToken,
    }));

    for (const user of result.Users || []) {
      const attrs: Record<string, string> = {};
      for (const attr of user.Attributes || []) {
        if (attr.Name && attr.Value) attrs[attr.Name] = attr.Value;
      }

      users.push({
        username: user.Username || '',
        email: attrs.email || '',
        tier: attrs['custom:tier'] || 'none',
        approved: attrs['custom:approved'] || 'false',
        status: user.UserStatus || '',
        enabled: user.Enabled ?? true,
        createdAt: user.UserCreateDate?.toISOString() || '',
      });
    }

    paginationToken = result.PaginationToken;
  } while (paginationToken);

  return { users };
}

async function approveUser(username: string, clearance: string): Promise<void> {
  const effectiveClearance = (CLEARANCE_GROUPS as readonly string[]).includes(clearance)
    ? (clearance as Clearance)
    : 'basic';

  // Set approved + clearance
  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'custom:approved', Value: 'true' },
      { Name: 'custom:tier', Value: effectiveClearance },
    ],
  }));

  // Mirror into Cognito group so authorization checks trust it
  await syncClearanceGroup(username, effectiveClearance);

  // Enable the user if disabled
  await cognitoClient.send(new AdminEnableUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));

  // Ensure Chime AppInstance User exists
  if (APP_INSTANCE_ARN) {
    const sub = await getUserSub(username);
    if (sub) {
      await ensureChimeUser(sub, username);
    }
  }
}

async function rejectUser(username: string): Promise<void> {
  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'custom:approved', Value: 'false' },
    ],
  }));

  await cognitoClient.send(new AdminDisableUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
}

async function enableUser(username: string): Promise<void> {
  await cognitoClient.send(new AdminEnableUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));

  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'custom:approved', Value: 'true' },
    ],
  }));
}

async function changeClearance(username: string, clearance: string): Promise<void> {
  if (!(CLEARANCE_GROUPS as readonly string[]).includes(clearance)) {
    throw new Error(`Invalid clearance: ${clearance}`);
  }
  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'custom:tier', Value: clearance },
    ],
  }));
  await syncClearanceGroup(username, clearance as Clearance);
}

/**
 * Full-lifecycle deletion (SPEC-CREDENTIAL-EXCHANGE §5b). Neutralizes the identity
 * everywhere: deleting the AppInstanceUser invalidates the `…/user/<sub>` ARN (it can
 * no longer be borne or be a valid channel member), and deleting the Cognito user stops
 * any new token/exchange. Order: resolve sub → delete AppInstanceUser → delete Cognito
 * user. Both idempotent (NotFound is fine — the goal state is "gone").
 *
 * Channel-membership rows are cleaned up first (best-effort, as the app-instance
 * admin) so they don't linger as stale entries; deleting the AppInstanceUser then
 * removes the user's ability to act regardless.
 */
async function deleteUser(username: string): Promise<void> {
  const sub = await getUserSub(username);
  if (sub) {
    const userArn = `${APP_INSTANCE_ARN}/user/${sub}`;
    // Best-effort membership cleanup BEFORE deleting the AppInstanceUser (the list
    // call needs the user to still exist). Never blocks the delete.
    await cleanupChannelMemberships(userArn).catch((err) =>
      console.warn('[user-management] membership cleanup failed (non-fatal):', err));
    try {
      await chimeClient.send(new DeleteAppInstanceUserCommand({ AppInstanceUserArn: userArn }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'NotFoundException') throw err;
    }
  }
  try {
    await cognitoClient.send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'UserNotFoundException') throw err;
  }
}

/**
 * Remove all of a user's channel memberships, acting as the app-instance admin
 * (the moderator-of-everything — SPEC-MODERATION). Best-effort: a missing admin
 * ARN, or a per-channel failure, is logged and skipped — the caller's
 * DeleteAppInstanceUser still neutralizes the identity. Paginated.
 */
async function cleanupChannelMemberships(userArn: string): Promise<void> {
  const adminArn = await getAdminArn();
  if (!adminArn) {
    console.warn('[user-management] no app-instance-admin ARN; skipping membership cleanup');
    return;
  }
  let nextToken: string | undefined;
  do {
    const resp = await messagingClient.send(new ListChannelMembershipsForAppInstanceUserCommand({
      AppInstanceUserArn: userArn,
      ChimeBearer: adminArn,
      MaxResults: 50,
      NextToken: nextToken,
    }));
    for (const m of resp.ChannelMemberships || []) {
      const channelArn = m.ChannelSummary?.ChannelArn;
      if (!channelArn) continue;
      try {
        await messagingClient.send(new DeleteChannelMembershipCommand({
          ChannelArn: channelArn,
          MemberArn: userArn,
          ChimeBearer: adminArn,
        }));
      } catch (err) {
        console.warn('[user-management] failed to remove membership (skipping):', { channelArn, err });
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
}

async function getUserSub(username: string): Promise<string | null> {
  // Cognito filter language has limited grammar but accepts quoted strings;
  // an embedded `"` breaks parsing
  // (silently DoSing this lookup) and some shapes risk filter injection
  // across attributes. Validate before interpolating + reject anything
  // that isn't a plain Cognito username (email or sub UUID).
  if (typeof username !== 'string' || username.length === 0 || username.length > 256) {
    return null;
  }
  // Reject double quotes, control chars, backslashes — these can confuse
  // the Cognito filter parser. Allow @ + . for emails and - for UUIDs.
  if (/[\\"\x00-\x1f]/.test(username)) {
    console.warn('[user-management] rejected unsafe username for filter', { len: username.length });
    return null;
  }
  const result = await cognitoClient.send(new ListUsersCommand({
    UserPoolId: USER_POOL_ID,
    Filter: `username = "${username}"`,
    Limit: 1,
  }));
  const user = result.Users?.[0];
  return user?.Attributes?.find(a => a.Name === 'sub')?.Value || null;
}

async function ensureChimeUser(sub: string, email: string): Promise<void> {
  const arn = `${APP_INSTANCE_ARN}/user/${sub}`;
  try {
    await chimeClient.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: arn }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'NotFoundException' || name === 'ForbiddenException') {
      await chimeClient.send(new CreateAppInstanceUserCommand({
        AppInstanceArn: APP_INSTANCE_ARN,
        AppInstanceUserId: sub,
        Name: email,
      }));
      console.log('[UserManagement] Created Chime user:', arn);
    }
  }
}
