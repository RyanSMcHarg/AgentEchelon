/**
 * Custom-resource Lambda: register a SERVICE app-instance admin user.
 *
 * The Chime app instance is created by the `MessagingAppInstance` construct,
 * which does not create any admin. The admin CONSOLE needs an identity with
 * cross-channel moderation authority — redact AND delete — which only an
 * AppInstanceAdmin has (a channel moderator can redact but not delete, and the
 * per-tier bots are only moderators of their own channels). This creates a
 * dedicated service AppInstanceUser and registers it as an AppInstanceAdmin,
 * returning its ARN for publication to SSM (`/agent-echelon/app-instance-admin-arn`).
 *
 * NOT used by the conversation/bot layer — per-tier bots still operate as
 * themselves (see project_per_tier_ownership_architecture). This admin identity
 * is exclusively for the admin dashboard's moderation actions.
 *
 * Idempotent: re-running with the same user id returns the existing ARN.
 * Deliberately a no-op on Delete (leaving the admin user avoids orphaning
 * moderation history; the app instance teardown removes it).
 */
import {
  ChimeSDKIdentityClient,
  CreateAppInstanceUserCommand,
  CreateAppInstanceAdminCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const region = process.env.AWS_REGION || 'us-east-1';
const identityClient = new ChimeSDKIdentityClient({ region });

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'agent-echelon-admin';

function adminUserArn(): string {
  return `${APP_INSTANCE_ARN}/user/${ADMIN_USER_ID}`;
}

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  console.log('[CreateAppInstanceAdmin]', event.RequestType, { APP_INSTANCE_ARN, ADMIN_USER_ID });

  // Delete is a deliberate no-op (see header).
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: adminUserArn(), Data: { AdminArn: adminUserArn() } };
  }

  if (!APP_INSTANCE_ARN) {
    throw new Error('APP_INSTANCE_ARN env is required');
  }

  // 1) Create the service user (idempotent — ConflictException means it exists).
  let userArn = adminUserArn();
  try {
    const created = await identityClient.send(
      new CreateAppInstanceUserCommand({
        AppInstanceArn: APP_INSTANCE_ARN,
        AppInstanceUserId: ADMIN_USER_ID,
        Name: 'Agent Echelon Admin',
      }),
    );
    userArn = created.AppInstanceUserArn || userArn;
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
    console.log('[CreateAppInstanceAdmin] service user already exists, continuing');
  }

  // 2) Register it as an app-instance admin (idempotent).
  try {
    await identityClient.send(
      new CreateAppInstanceAdminCommand({
        AppInstanceArn: APP_INSTANCE_ARN,
        AppInstanceAdminArn: userArn,
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
    console.log('[CreateAppInstanceAdmin] admin already registered, continuing');
  }

  console.log('[CreateAppInstanceAdmin] admin ready:', userArn);
  return { PhysicalResourceId: userArn, Data: { AdminArn: userArn } };
};
