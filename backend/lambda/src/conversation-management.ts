/**
 * Conversation Management Lambda (moderator archive / member removal / self-leave)
 *
 * Implements docs/specs/conversation-messaging/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md
 * and ADR-017 (Option 1 - mark archived + read-only via an immutable tag).
 *
 * A single Cognito-JWT-authenticated API that performs the three membership
 * mutations a non-admin moderator cannot do on the chat plane. It authorizes per
 * operation and then acts as the app-instance-admin bearer to perform the Chime
 * mutation - keeping user creds least-privilege and moderation authority
 * server-side where it is checkable and auditable (the same pattern as
 * user-management.ts / federated-remove-member.ts).
 *
 * Routes (behind the Cognito authorizer, in AgentEchelonFoundations):
 *   POST /conversations/archive        { channelArn }           - moderator only
 *   POST /conversations/remove-member  { channelArn, memberArn} - moderator only, never the assistant
 *   POST /conversations/leave          { channelArn }           - any member, self only
 *
 * Read-only enforcement is IAM on the `archived` tag (set here); see Phase 2 in
 * cognito-auth-stack.ts / agent-tier-common.ts. This handler only SETS the tag +
 * removes moderators; it never blocks sends itself.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelModeratorsCommand,
  DeleteChannelModeratorCommand,
  DeleteChannelMembershipCommand,
  SendChannelMessageCommand,
  TagResourceCommand,
  DescribeChannelCommand,
  UpdateChannelCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { requireAuth, parseJsonBody, callerUserArn, respond, type AuthorizedClaims } from './lib/auth.js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const messagingClient = new ChimeSDKMessagingClient({ region: REGION });
const ssmClient = new SSMClient({ region: REGION });

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';
const AUDIT_TABLE = process.env.AUDIT_TABLE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ddb = AUDIT_TABLE ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })) : null;

let cachedAdminArn: string | null = null;
async function getAdminArn(): Promise<string> {
  if (cachedAdminArn !== null) return cachedAdminArn;
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: ADMIN_ARN_PARAM }));
    cachedAdminArn = resp.Parameter?.Value || '';
  } catch (err) {
    console.error('[conversation-management] failed to read app-instance-admin ARN:', err);
    cachedAdminArn = '';
  }
  return cachedAdminArn;
}

/** Pick the request's Origin if it is allow-listed, else the first configured origin. */
function pickOrigin(event: APIGatewayProxyEvent): string {
  const o = event.headers?.origin || event.headers?.Origin;
  return o && ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
}

/** The assistant is an `app_instance_bot` (.../bot/...). It must never be removed. */
function isBotArn(arn: string): boolean {
  return /\/bot\//.test(arn);
}

/** Best-effort durable audit row (actor, operation, target, channel, ts). */
async function writeAudit(row: {
  operation: 'ARCHIVE' | 'REMOVE_MEMBER' | 'LEAVE';
  actorSub: string;
  channelArn: string;
  targetArn?: string;
}): Promise<void> {
  if (!ddb) return;
  const ts = new Date().toISOString();
  try {
    await ddb.send(
      new PutCommand({
        TableName: AUDIT_TABLE,
        Item: {
          pk: `conversation-action#${row.channelArn}`,
          sk: `${ts}#${row.operation}`,
          operation: row.operation,
          actorSub: row.actorSub,
          channelArn: row.channelArn,
          targetArn: row.targetArn ?? null,
          ts,
        },
      }),
    );
  } catch (err) {
    // Audit is best-effort; never fail the mutation because the row didn't write.
    console.warn('[conversation-management] audit write failed (non-fatal):', err);
  }
}

/** Collect every ChannelModerator ARN on a channel (paginated), read as the admin bearer. */
async function listModeratorArns(channelArn: string, adminArn: string): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await messagingClient.send(
      new ListChannelModeratorsCommand({
        ChannelArn: channelArn,
        ChimeBearer: adminArn,
        MaxResults: 50,
        NextToken: nextToken,
      }),
    );
    for (const m of res.ChannelModerators || []) {
      const arn = m.Moderator?.Arn;
      if (arn) arns.push(arn);
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return arns;
}

/** Swallow the "already gone" errors so membership deletes are idempotent. */
function isAlreadyGone(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  return name === 'NotFoundException' || name === 'ConflictException';
}

// ── Operations ──────────────────────────────────────────────────────────────

async function archive(
  claims: AuthorizedClaims,
  channelArn: string,
  adminArn: string,
  origin: string,
): Promise<APIGatewayProxyResult> {
  const callerArn = callerUserArn(claims, APP_INSTANCE_ARN);
  const moderators = await listModeratorArns(channelArn, adminArn);
  if (!moderators.includes(callerArn)) {
    return respond(403, { error: 'Only a channel moderator can archive this conversation' }, origin);
  }

  // Order matters (spec §Archive): 1) system message BEFORE the tag (the admin
  // bearer is exempt from the archived Deny, but post it first regardless), then
  // 2) set the tag, then 3) remove all moderators to lock it.
  const who = claims.email || claims.sub;
  const when = new Date().toISOString().slice(0, 10);
  try {
    await messagingClient.send(
      new SendChannelMessageCommand({
        ChannelArn: channelArn,
        Content: `Conversation archived by ${who} on ${when}. It is now read-only.`,
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: adminArn,
      }),
    );
  } catch (err) {
    console.warn('[conversation-management] archive system message failed (non-fatal):', err);
  }

  // Immutable, tag-authoritative state (like `classification`), so it cannot be
  // spoofed via mutable metadata. This is what the Phase 2 IAM Deny keys on.
  await messagingClient.send(
    new TagResourceCommand({
      ResourceARN: channelArn,
      // Fixed 'true' so the Phase 2 IAM Deny is a clean StringEquals; the archive
      // date lives in the system message + audit row, not the tag.
      Tags: [{ Key: 'archived', Value: 'true' }],
    }),
  );

  // Display-mirror the archived state into channel Metadata (NON-authoritative -
  // the tag above is the IAM authority). The client's conversation list already
  // parses Metadata but not tags, so this lets it cheaply hide archived channels
  // without a per-channel ListTagsForResource. DescribeChannel first to preserve
  // Name/Mode/existing metadata (UpdateChannel replaces the mutable fields).
  try {
    const described = await messagingClient.send(
      new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: adminArn }),
    );
    let meta: Record<string, unknown> = {};
    if (described.Channel?.Metadata) {
      try {
        meta = JSON.parse(described.Channel.Metadata);
      } catch {
        meta = {};
      }
    }
    meta.archived = true;
    await messagingClient.send(
      new UpdateChannelCommand({
        ChannelArn: channelArn,
        Name: described.Channel?.Name,
        Mode: described.Channel?.Mode,
        Metadata: JSON.stringify(meta),
        ChimeBearer: adminArn,
      }),
    );
  } catch (err) {
    // Non-fatal: the tag (authoritative) is already set; only the display hint failed.
    console.warn('[conversation-management] archived metadata mirror failed (non-fatal):', err);
  }

  // Remove every moderator (including the caller) so no user-side actor can
  // un-archive / rename / re-open. The assistant bot is never a moderator.
  for (const modArn of moderators) {
    try {
      await messagingClient.send(
        new DeleteChannelModeratorCommand({
          ChannelArn: channelArn,
          ChannelModeratorArn: modArn,
          ChimeBearer: adminArn,
        }),
      );
    } catch (err) {
      if (!isAlreadyGone(err)) {
        console.warn('[conversation-management] failed to remove moderator (continuing):', { modArn, err });
      }
    }
  }

  await writeAudit({ operation: 'ARCHIVE', actorSub: claims.sub, channelArn });
  return respond(200, { ok: true, channelArn, archived: true }, origin);
}

async function removeMember(
  claims: AuthorizedClaims,
  channelArn: string,
  memberArn: string,
  adminArn: string,
  origin: string,
): Promise<APIGatewayProxyResult> {
  // Never the assistant - refuse server-side, independent of the UI hide.
  if (isBotArn(memberArn)) {
    return respond(403, { error: 'The assistant cannot be removed from a conversation' }, origin);
  }
  const callerArn = callerUserArn(claims, APP_INSTANCE_ARN);
  const moderators = await listModeratorArns(channelArn, adminArn);
  if (!moderators.includes(callerArn)) {
    return respond(403, { error: 'Only a channel moderator can remove a member' }, origin);
  }

  try {
    await messagingClient.send(
      new DeleteChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: memberArn,
        ChimeBearer: adminArn,
      }),
    );
  } catch (err) {
    if (!isAlreadyGone(err)) throw err;
  }

  await writeAudit({ operation: 'REMOVE_MEMBER', actorSub: claims.sub, channelArn, targetArn: memberArn });
  return respond(200, { ok: true, channelArn, removed: memberArn }, origin);
}

async function leave(
  claims: AuthorizedClaims,
  channelArn: string,
  adminArn: string,
  origin: string,
): Promise<APIGatewayProxyResult> {
  // Self-leave only: the target is always the caller's own membership. No
  // moderator check - a member may always leave. (A member can leave even an
  // archived channel: the read-only Deny covers Send/Update, not membership.)
  const callerArn = callerUserArn(claims, APP_INSTANCE_ARN);
  try {
    await messagingClient.send(
      new DeleteChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: callerArn,
        ChimeBearer: adminArn,
      }),
    );
  } catch (err) {
    if (!isAlreadyGone(err)) throw err;
  }

  await writeAudit({ operation: 'LEAVE', actorSub: claims.sub, channelArn, targetArn: callerArn });
  return respond(200, { ok: true, channelArn, left: true }, origin);
}

// ── Handler ───────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const origin = pickOrigin(event);

  const auth = requireAuth(event);
  if ('statusCode' in auth) return auth;
  const { claims } = auth;

  const parsed = parseJsonBody<{ channelArn?: string; memberArn?: string }>(event, origin);
  if ('statusCode' in parsed) return parsed;
  const { channelArn, memberArn } = parsed.body;

  if (!channelArn || typeof channelArn !== 'string') {
    return respond(400, { error: 'channelArn is required' }, origin);
  }

  const adminArn = await getAdminArn();
  if (!adminArn) {
    console.error('[conversation-management] no app-instance-admin ARN configured');
    return respond(500, { error: 'Server not configured for conversation management' }, origin);
  }

  // Route on the resource path (…/conversations/<action>).
  const path = event.resource || event.path || '';
  try {
    if (path.endsWith('/archive')) {
      return await archive(claims, channelArn, adminArn, origin);
    }
    if (path.endsWith('/remove-member')) {
      if (!memberArn || typeof memberArn !== 'string') {
        return respond(400, { error: 'memberArn is required' }, origin);
      }
      return await removeMember(claims, channelArn, memberArn, adminArn, origin);
    }
    if (path.endsWith('/leave')) {
      return await leave(claims, channelArn, adminArn, origin);
    }
    return respond(404, { error: 'Unknown conversation-management action' }, origin);
  } catch (err) {
    console.error('[conversation-management] operation failed:', { path, err });
    return respond(500, { error: 'Conversation management operation failed' }, origin);
  }
};
