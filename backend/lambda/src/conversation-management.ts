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
 * user-management.ts).
 *
 * Routes (behind the person authorizer, in AgentEchelonConversations):
 *   POST /conversations/archive        { channelArn }           - moderator only
 *   POST /conversations/remove-member  { channelArn, memberArn} - moderator only, never the assistant
 *   POST /conversations/leave          { channelArn }           - any member, self only
 *
 * Read-only enforcement is IAM on the `archived` tag (set here); see Phase 2 in
 * identity-stack.ts / agent-classification-common.ts. This handler only SETS the tag +
 * removes moderators; it never blocks sends itself.
 *
 * A HOST'S MEMBERSHIP CHANGES (`membershipHandler`, its own function): a host app adds or removes a
 * person in one of its context conversations, after its own access check, by invoking that function
 * directly. IAM (the host's invoke grant) is the authorization boundary, so membership is a projection of
 * the host's access list and bare channel membership is never trusted. The person is named by their
 * issuer and subject and resolved through the trusted-issuer registry and `Identities`, whichever issuer
 * signed them in.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelModeratorsCommand,
  DeleteChannelModeratorCommand,
  DeleteChannelMembershipCommand,
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
import { requireAuth, parseJsonBody, respond, callerPersonId, isAdminConsoleSession, type AuthorizedClaims } from './lib/auth.js';
import { cancelDeadlinesThroughRouter, personJoinedThroughRouter, sayThroughRouter } from './lib/say-through-router.js';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { primaryAssignmentOf, primaryAssistantOf } from './lib/conversation-primary.js';
import { addContextMember, contextChannelId, createConversationForContext } from './lib/channel-creation.js';
import { resolvePerson } from './lib/person-identity.js';
import { accountStateOfPerson, defaultDirectory } from './lib/membership-source.js';
import { issuerIdOf } from './lib/trusted-issuers.js';
import { DEFAULT_CONVERSATION_TYPE, typeAdmitsIssuers } from '../../lib/config/conversation-types.js';
import { putChannelContext, recordMemberIdentity, type ChannelContextPatch } from './lib/channel-context-client.js';
import { boundedDomainContext, boundedOtherContexts } from './lib/host-grounding.js';
import { resolveServiceAdminBearer } from './lib/service-admin-bearer.js';
import { readChannelClassificationTag, readChannelTags } from './lib/channel-classification.js';
import type { Classification } from '../../lib/config/model-strategy.js';
import { turnAssistantProfile, logAssistantDecline } from './lib/turn-assistant.js';
import { ChimeSDKIdentityClient, DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import { adminTwinIdFor, userArnFor } from './lib/person-arn.js';
import { originsFrom, pickOrigin, requestOrigin, DEV_ORIGIN } from './lib/http-response.js';
import { chimeMessagingClient, chimeIdentityClient, appInstanceAdminBearer } from './lib/chime/clients.js';
import { parseChannelMetadata, mergeChannelMetadata, metadataBytes, CHANNEL_METADATA_CAP_BYTES } from './lib/chime/channel-meta.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const REGION = process.env.AWS_REGION || 'us-east-1';
const messagingClient = chimeMessagingClient({ region: REGION });
const ssmClient = new SSMClient({ region: REGION });
const identityClient = chimeIdentityClient({ region: REGION });

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';
const AUDIT_TABLE = process.env.AUDIT_TABLE || '';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN, { trim: true, dropEmpty: true });

const ddb = AUDIT_TABLE ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })) : null;

const getAdminArn = appInstanceAdminBearer({
  ssm: ssmClient,
  param: ADMIN_ARN_PARAM,
  onFailure: 'cache',
  log: (err) => console.error('[conversation-management] failed to read app-instance-admin ARN:', err),
});

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
  /** An administrator's stated reason, for an archive made from the admin console. */
  reason?: string;
}): Promise<void> {
  if (!ddb) return;
  const ts = new Date().toISOString();
  try {
    await ddb.send(
      new PutCommand({
        TableName: AUDIT_TABLE,
        Item: {
          ...(row.reason ? { reason: row.reason } : {}),
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

/** Every ChannelModerator ARN on a channel (paginated), read as the admin bearer. Authorization only. */
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

/**
 * THE NAME THE ROOM SHOWS FOR A PERSON: their `AppInstanceUser` name, which the credential exchange sets
 * from the identity provider on every sign-in (`refreshDisplayName`). The one record their own messages
 * are shown under. Never an email.
 */
async function displayNameOf(userArn: string): Promise<string> {
  try {
    const res = await identityClient.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: userArn }));
    return res.AppInstanceUser?.Name?.trim() || 'A moderator';
  } catch (err) {
    console.warn('[conversation-management] could not read the archiver\'s name; the notice says "A moderator"', err);
    return 'A moderator';
  }
}

/**
 * POST THE ARCHIVE NOTICE AS THE ROOM'S PRIMARY (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8).
 *
 * A notice said for the room is said by the room's primary, resolved by `primaryAssistantOf` like every
 * other. This role holds no send: the notice goes out on a speak session the classification's vend mints
 * for that assistant (Phase 1c). Best-effort, like the message it replaces: a room with no resolvable
 * primary is archived without a notice, and says so in the log.
 *
 * THE NOTICE IS IN THAT ASSISTANT'S OWN WORDS: its copy is read from the profile the assignment record
 * names (`turnAssistantProfile`), not from the classification's primary. A record naming an assistant this
 * deployment does not declare posts no notice and logs a `[SecurityEvent]`.
 */
async function postArchiveNotice(channelArn: string, callerArn: string, date: string): Promise<void> {
  const primary = await primaryAssistantOf(channelArn, messagingClient, '[conversation-management]');
  const speaker = turnAssistantProfile({
    classification: primary.classification,
    // `primaryAssistantOf` read the records to find this assistant, so the index is loaded.
    assistantIndexLoaded: true,
    assignedAssistant: primary.assistant,
    isAltAssistant: false,
    primaryBot: false,
    registry: defaultProfileRegistry,
  });
  if (speaker.decision === 'decline') {
    logAssistantDecline('[conversation-management]', speaker.reason, {
      channelArn, classification: primary.classification, assignedAssistant: primary.assistant,
    });
    return;
  }
  // NAMED, NOT SAID: the room's primary says it through its router, in its own copy (`conversationArchived`),
  // before the `archived` tag lands, which would refuse it after. This function speaks as no assistant.
  const who = await displayNameOf(callerArn);
  const said = await sayThroughRouter(primary.classification, {
    kind: 'conversationArchived', channelArn, botArn: primary.botArn, to: [], vars: { who, date },
    // The person the mention names, so the router says the name only of a member (ADR-060 decision 7).
    people: { who: callerArn },
  });
  if (!said.posted) throw new Error(`the archive notice was not said (${said.reason})`);

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
  const callerArn = userArnFor(APP_INSTANCE_ARN, claims.actor);
  const moderators = await listModeratorArns(channelArn, adminArn);
  if (!moderators.includes(callerArn)) {
    return respond(403, { error: 'Only a channel moderator can archive this conversation' }, origin);
  }
  return archiveConversation({ actorSub: claims.actor, actorArn: callerArn, channelArn, adminArn, moderators, origin });
}

/**
 * ARCHIVE A CONVERSATION: the one sequence, whoever asked for it - a moderator in the room, or an
 * administrator from the console under `archive-conversation` (SPEC-ADMIN-CONSOLE FR51).
 */
async function archiveConversation(a: {
  actorSub: string;
  /** Whose name the notice carries: the moderator, or the administrator's administration identity. */
  actorArn: string;
  channelArn: string;
  adminArn: string;
  moderators: string[];
  origin: string;
  reason?: string;
}): Promise<APIGatewayProxyResult> {
  const { actorSub, actorArn: callerArn, channelArn, adminArn, moderators, origin, reason } = a;

  // Order matters (spec §Archive): 1) the notice BEFORE the tag, because the archived Deny refuses the
  // assistant's post once the tag is set; then 2) set the tag; then 3) remove all moderators to lock it.
  try {
    await postArchiveNotice(channelArn, callerArn, new Date().toISOString().slice(0, 10));
  } catch (err) {
    console.warn('[conversation-management] archive notice failed (non-fatal):', err);
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
    const meta = parseChannelMetadata(described.Channel?.Metadata) ?? {};
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
  // un-archive / rename / re-open. The conversation's assistant is a moderator too (the creator makes it one
  // so it can add members), and it is removed with the rest: an archived conversation's membership is frozen.
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

  await writeAudit({ operation: 'ARCHIVE', actorSub, channelArn, ...(reason ? { reason } : {}) });
  console.log(JSON.stringify({ event: 'conversation_archived', actorSub, channelArn, reason: reason ?? null }));
  // AN ARCHIVED CONVERSATION'S DEADLINES (ADR-061 decision 1): the router of its classification deletes the schedule of
  // every invitation it carried. Asynchronous and best-effort: one left behind finds the room archived when it fires.
  const classification = await readChannelClassificationTag(messagingClient, channelArn, '[conversation-management]').catch(() => undefined);
  if (classification) await cancelDeadlinesThroughRouter(classification, { channelArn }).catch(() => false);
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
  const callerArn = userArnFor(APP_INSTANCE_ARN, claims.actor);
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

  await writeAudit({ operation: 'REMOVE_MEMBER', actorSub: claims.actor, channelArn, targetArn: memberArn });
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
  const callerArn = userArnFor(APP_INSTANCE_ARN, claims.actor);
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

  await writeAudit({ operation: 'LEAVE', actorSub: claims.actor, channelArn, targetArn: callerArn });
  return respond(200, { ok: true, channelArn, left: true }, origin);
}

// ── Handler ───────────────────────────────────────────────────────────────

/**
 * AN ADMINISTRATOR ARCHIVES A CONVERSATION FROM THE CONSOLE (`archive-conversation`).
 *
 * `POST /admin/conversations/{channelId}/archive` on the admin API, IAM-authorized and granted only to
 * a role holding the capability, so the gateway has already refused anyone else. Accepted here only from
 * an admin console session on that path - the same function serves the chat API, where no such route
 * exists - and only with a stated reason, which the audit row and log line carry beside the actor.
 */
const ADMIN_ARCHIVE_PATH = /\/admin\/conversations\/([A-Za-z0-9._-]+)\/archive$/;
async function adminArchive(event: APIGatewayProxyEvent, origin: string): Promise<APIGatewayProxyResult | null> {
  const match = ADMIN_ARCHIVE_PATH.exec(event.path || '');
  if (event.httpMethod !== 'POST' || !match) return null;
  const sub = isAdminConsoleSession(event) ? await callerPersonId(event) : null;
  if (!sub) {
    return respond(403, { error: 'archiving from the console requires an admin console session' }, origin);
  }
  const parsed = parseJsonBody<{ reason?: string }>(event, origin);
  if ('statusCode' in parsed) return parsed;
  const reason = typeof parsed.body.reason === 'string' ? parsed.body.reason.trim().slice(0, 500) : '';
  if (!reason) return respond(400, { error: 'a reason is required to archive a conversation', code: 'REASON_REQUIRED' }, origin);
  const adminArn = await getAdminArn();
  if (!adminArn) return respond(500, { error: 'Server not configured for conversation management' }, origin);
  const channelArn = `${APP_INSTANCE_ARN}/channel/${match[1]}`;
  const moderators = await listModeratorArns(channelArn, adminArn);
  return archiveConversation({
    actorSub: sub,
    // The notice names the administrator through their administration identity, which carries their name.
    actorArn: userArnFor(APP_INSTANCE_ARN, adminTwinIdFor(sub)),
    channelArn,
    adminArn,
    moderators,
    origin,
    reason,
  });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = pickOrigin(ALLOWED_ORIGINS, requestOrigin(event));

  const fromConsole = await adminArchive(event, origin);
  if (fromConsole) return fromConsole;

  const auth = await requireAuth(event);
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

// ── A HOST ADDS OR REMOVES A PERSON IN ITS CONTEXT CONVERSATION ─────────────────────────────────

/**
 * The classification a host's context conversations are created at: the one the trusted-issuer
 * registry's oneChannel issuers name (`lib/config/issuers.ts`), set by the stack. NO FLOOR (ADR-046): an
 * unset or undeclared value refuses every call rather than naming a classification nobody configured.
 */
const CONTEXT_CLASSIFICATION = (process.env.CONTEXT_CLASSIFICATION || '').trim();
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';

let cachedFlowArn: string | null = null;
async function contextFlowArn(): Promise<string> {
  if (cachedFlowArn !== null) return cachedFlowArn;
  if (!CHANNEL_FLOW_ARN_PARAM) return (cachedFlowArn = '');
  try {
    cachedFlowArn = (await ssmClient.send(new GetParameterCommand({ Name: CHANNEL_FLOW_ARN_PARAM }))).Parameter?.Value || '';
  } catch {
    cachedFlowArn = '';
  }
  return cachedFlowArn;
}

let cachedEvictBot: string | null = null;
/** The classification's assistant, which evicts: a moderator of every room of the classification. */
async function evictingAssistant(): Promise<string> {
  if (cachedEvictBot) return cachedEvictBot;
  const name = `${SSM_ROOT}/assistant/${CONTEXT_CLASSIFICATION}/bot-arn`;
  const value = (await ssmClient.send(new GetParameterCommand({ Name: name }))).Parameter?.Value || '';
  if (!value) throw new Error(`per-classification bot ARN ${name} is empty`);
  return (cachedEvictBot = value);
}

interface WorkItem { title?: string; status?: string; assignee?: string; start?: string; end?: string }
interface DomainContext { title?: string; items?: WorkItem[]; [k: string]: unknown }

/** A short, member-visible recap composed from the domain context the host passes through. */
function buildRecap(title: string, dc?: DomainContext): string {
  const bits: string[] = [];
  if (title) bits.push(`**${title}**`);
  const n = Array.isArray(dc?.items) ? dc!.items!.length : 0;
  if (n) bits.push(`${n} item${n === 1 ? '' : 's'}`);
  return bits.length ? bits.join(' · ') : 'a shared context';
}

/** A host's direct invoke (NOT an API Gateway event): the host sends the arguments as they are. */
export interface MembershipEvent {
  op?: 'add' | 'remove';
  contextType?: string;
  contextId?: string;
  /** The person's issuer, as its `iss` or its registry id. */
  iss?: string;
  /** Their subject at that issuer. */
  sub?: string;
  /** The role the host granted. Informational only. */
  role?: string;
  title?: string;
  userName?: string;
  userLanguage?: string;
  participantProfile?: string;
  domainContext?: DomainContext;
  otherContexts?: unknown[];
  segment?: { country?: unknown };
}

export type MembershipResult =
  | { ok: true; conversationArn: string; userArn: string; contextType?: string; contextId?: string }
  | { ok: false; error: string };

/**
 * THE PERSON A HOST NAMES, resolved exactly as at sign-in: their issuer through the trusted-issuer
 * registry, then `(registry id, subject)` through `Identities`. An issuer the registry does not declare,
 * or a subject that has never signed in, is nobody, and nothing is invented for them.
 */
async function personNamed(iss: string, sub: string): Promise<{ userArn: string } | { error: string }> {
  const issuerId = issuerIdOf(iss);
  if (!issuerId) return { error: 'The issuer is not one this deployment trusts' };
  try {
    const userArn = await resolvePerson(issuerId, sub);
    return userArn ? { userArn } : { error: 'The person has not signed in yet' };
  } catch (err) {
    console.error('[conversation-membership] the subject could not be resolved to a person', { err: (err as Error)?.name });
    return { error: 'The person could not be resolved' };
  }
}

/**
 * WHETHER THE PERSON MAY BE ADMITTED: null when any of their sign-ins is active at its issuer, else why not.
 * A failed read refuses (fail closed), never admits.
 */
async function refuseInactiveAdmission(userArn: string): Promise<string | null> {
  try {
    const state = await accountStateOfPerson(userArn, defaultDirectory());
    if (state === 'active') return null;
    console.warn('[conversation-membership][SecurityEvent] the person is not active at their issuer; not admitted', { state });
    return "The person's account is not active";
  } catch (err) {
    console.error("[conversation-membership] the person's issuer could not be asked; not admitted", { err: (err as Error)?.name });
    return "The person's account could not be checked; retry";
  }
}

/**
 * A HOST ADDS OR REMOVES A PERSON in one of its context conversations (`op`: `add` or `remove`).
 *
 * ADD enrols the person as a DEFAULT member, never a moderator, creating the conversation through the
 * shared creator when it does not exist yet (so a share works before its owner has opened it), and the
 * room's primary greets them. REMOVE evicts them, idempotently. Either is refused, with nothing written,
 * for a conversation not of this deployment's context classification.
 */
export async function membershipHandler(event: MembershipEvent): Promise<MembershipResult> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (!CONTEXT_CLASSIFICATION || !defaultProfileRegistry.isConversational(CONTEXT_CLASSIFICATION) || !APP_INSTANCE_ARN) {
    console.error('[conversation-membership] not configured', { classification: CONTEXT_CLASSIFICATION });
    return { ok: false, error: 'Conversation membership is not configured' };
  }
  const contextType = String(event?.contextType || '').trim();
  const contextId = String(event?.contextId || '').trim();
  const iss = String(event?.iss || '').trim();
  const sub = String(event?.sub || '').trim();
  if (event?.op !== 'add' && event?.op !== 'remove') return { ok: false, error: 'op is add or remove' };
  if (!contextType || !contextId || !iss || !sub) return { ok: false, error: 'contextType, contextId, iss and sub are required' };

  const person = await personNamed(iss, sub);
  if ('error' in person) return { ok: false, error: person.error };
  const { userArn } = person;
  // ADD ADMITS ONLY A PERSON WHO MAY STILL SIGN IN, asked of their issuers now (SPEC-CREDENTIAL-EXCHANGE
  // §4b): a disabled or gone account is not admitted, and a read that fails admits nobody. REMOVE asks
  // nothing, so a disabled person can always be taken out.
  if (event.op === 'add') {
    const refused = await refuseInactiveAdmission(userArn);
    if (refused) return { ok: false, error: refused };
  }
  // A context conversation is the ordinary type; a type that narrows by issuer (T1, FR23) refuses a person
  // named through an issuer it does not list. A refused issuer is settled: nothing is written.
  if (event.op === 'add' && !typeAdmitsIssuers(DEFAULT_CONVERSATION_TYPE, [issuerIdOf(iss) || ''])) {
    return { ok: false, error: 'Conversations of this kind do not admit people of this issuer' };
  }
  const conversationArn = `${APP_INSTANCE_ARN}/channel/${contextChannelId(CONTEXT_CLASSIFICATION, contextType, contextId)}`;
  return event.op === 'remove'
    ? removeContextMember(conversationArn, userArn)
    : addContextMemberFor(event, { contextType, contextId, conversationArn, userArn, iss, sub });
}

async function removeContextMember(conversationArn: string, userArn: string): Promise<MembershipResult> {
  try {
    const botArn = await evictingAssistant();
    try {
      await messagingClient.send(new DeleteChannelMembershipCommand({
        ChannelArn: conversationArn, MemberArn: userArn, ChimeBearer: botArn,
      }));
    } catch (err) {
      // Already gone (never joined, or the channel or membership is absent): revocation is idempotent.
      if (!isAlreadyGone(err)) throw err;
    }
    return { ok: true, conversationArn, userArn };
  } catch (err) {
    console.error('[conversation-membership] remove failed:', err);
    return { ok: false, error: 'Removing the member failed' };
  }
}

async function addContextMemberFor(
  event: MembershipEvent,
  c: { contextType: string; contextId: string; conversationArn: string; userArn: string; iss: string; sub: string },
): Promise<MembershipResult> {
  const { contextType, contextId, conversationArn, userArn } = c;
  // Display context (drives metadata and the greeting only; not authoritative).
  const title = String(event.title || contextId).slice(0, 80);
  const userName = String(event.userName || '').slice(0, 80);
  const userLanguage = String(event.userLanguage || '').slice(0, 8);
  const participantProfile = String(event.participantProfile || '').slice(0, 600);
  // Bounded, for the same reason and by the same helper as the creation path.
  const domainContext = boundedDomainContext<DomainContext>(event.domainContext, '[conversation-membership]');
  const otherContexts = boundedOtherContexts(event.otherContexts);
  const segCountry = event.segment && typeof event.segment === 'object'
    ? String(event.segment.country || '').slice(0, 3).toUpperCase()
    : '';
  const segment = /^[A-Z]{2}$/.test(segCountry) ? { country: segCountry } : undefined;

  // Member-readable channel Metadata carries the conversation's identity bits only; the private
  // grounding and the routing signals go to the server-only Channel Context store.
  let metadata = JSON.stringify({
    modelTier: CONTEXT_CLASSIFICATION,
    contextType: contextType.slice(0, 64),
    contextId: contextId.slice(0, 128),
    topic: title,
  });
  if (Buffer.byteLength(metadata, 'utf8') > CHANNEL_METADATA_CAP_BYTES) {
    metadata = JSON.stringify({
      modelTier: CONTEXT_CLASSIFICATION, contextType: contextType.slice(0, 64), contextId: contextId.slice(0, 128), topic: title.slice(0, 200),
    });
  }

  // OMISSION PRESERVES; ONLY AN EXPLICIT `null` CLEARS. Add-member create-or-GETS an existing
  // conversation and adds one person to it - "this member joins", not "here is the complete grounding
  // again" - so a field the host did not send is left as the conversation has it.
  const grounding: ChannelContextPatch = {
    ...(event.participantProfile === undefined ? {} : { participantProfile: event.participantProfile === null ? null : participantProfile }),
    ...(event.domainContext === undefined ? {} : { domainContext: event.domainContext === null ? null : domainContext }),
    ...(event.otherContexts === undefined ? {} : { otherContexts: event.otherContexts === null ? null : otherContexts }),
    ...(event.userLanguage === undefined ? {} : { userLanguage: event.userLanguage === null ? null : userLanguage }),
    ...(event.segment === undefined ? {} : { segment: event.segment === null ? null : segment }),
  };

  try {
    const [botArn, flowArn, serviceAdmin] = await Promise.all([
      primaryAssignmentOf(CONTEXT_CLASSIFICATION).then((p) => p.botArn),
      contextFlowArn(),
      resolveServiceAdminBearer(),
    ]);
    // NO SERVICE ADMIN, NO CONVERSATION.
    if (!serviceAdmin) {
      console.error('[conversation-membership] no service admin is configured; refusing to create or add');
      return { ok: false, error: 'Conversation membership is not configured' };
    }

    // 1. Create-or-get through the shared creator, as the service admin: the flow is attached before the
    //    assistant is a member, then the assistant and the TARGET are added (a DEFAULT member, never a
    //    moderator), and the admin leaves. An existing conversation throws ConflictException before
    //    anything is written, and is refreshed and joined below instead.
    let existed = false;
    try {
      await createConversationForContext({
        appInstanceArn: APP_INSTANCE_ARN,
        botArn,
        userArn,
        classification: CONTEXT_CLASSIFICATION as Classification,
        channelId: conversationArn.split('/').pop()!,
        title,
        metadataExtras: JSON.parse(metadata),
        tagExtras: [{ Key: 'contextType', Value: contextType.slice(0, 128) }],
        contextExtras: grounding,
        channelFlowArn: flowArn || undefined,
        creatorBearerArn: serviceAdmin,
        openerModerator: false,
      });
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException') throw err;
      existed = true;
      // AN EXISTING CONVERSATION IS JOINED ONLY AT THIS CLASSIFICATION.
      const existingClassification = (await readChannelTags(messagingClient, conversationArn)).classification || '';
      if (existingClassification !== CONTEXT_CLASSIFICATION) {
        console.error('[conversation-membership][SecurityEvent] refused: the existing conversation is not this classification', {
          conversationArn, existingClassification, own: CONTEXT_CLASSIFICATION,
        });
        return { ok: false, error: 'The conversation is not this deployment\'s classification' };
      }
      try {
        // OMISSION PRESERVES HERE TOO: our four keys win, everything else the channel carries survives.
        // A failed read is not an empty channel, and a merge over the cap is not written.
        // THE NAME IS KEPT AS IT IS: the room was named when it was created, and after that only its primary assistant
        // renames it (SPEC-CONVERSATION-TYPES FR32). So the name written back is the one this read found.
        let currentName: string | undefined;
        const existing = await messagingClient.send(new DescribeChannelCommand({ ChannelArn: conversationArn, ChimeBearer: serviceAdmin }))
          .then((r) => {
            currentName = r.Channel?.Name;
            return parseChannelMetadata(r.Channel?.Metadata) ?? {};
          })
          .catch((readErr) => {
            console.warn('[conversation-membership] could not read the channel to merge onto; leaving its metadata alone:', (readErr as Error)?.name);
            return null;
          });
        const patch = JSON.parse(metadata) as Record<string, unknown>;
        const merged = mergeChannelMetadata(existing, patch, CHANNEL_METADATA_CAP_BYTES);
        if (existing !== null && merged === null) {
          console.warn('[conversation-membership] merged metadata exceeds the cap; leaving the channel metadata alone', {
            bytes: metadataBytes(JSON.stringify({ ...existing, ...patch })), cap: CHANNEL_METADATA_CAP_BYTES,
          });
        }
        await messagingClient.send(new UpdateChannelCommand({
          ChannelArn: conversationArn,
          Name: currentName || title,
          Mode: 'RESTRICTED',
          ...(merged === null ? {} : { Metadata: merged }),
          ChimeBearer: serviceAdmin,
        }));
      } catch (uerr) {
        console.warn('[conversation-membership] metadata refresh failed (non-fatal):', uerr);
      }
    }

    // An existing conversation takes the grounding as a patch; a new one was created with it.
    if (existed) await putChannelContext(conversationArn, grounding);
    // Record THIS member's host-supplied role beside the existing ones. Where to reach them is not
    // recorded: the directory resolves it through `Identities` at send time.
    await recordMemberIdentity(conversationArn, { sub: c.sub, iss: c.iss, role: event.role });
    // 2. In an EXISTING conversation, enrol the assistant and the target through the shared creator's
    //    helper, as the service admin. A new conversation already has both.
    if (existed) await addContextMember({ channelArn: conversationArn, botArn, userArn, bearerArn: serviceAdmin });

    // 3. Greet: a room-wide join notice and a recap targeted to the new member, said by the room's
    //    primary through its router. This function speaks as no assistant.
    const who = userName || 'Someone';
    try {
      const primary = await primaryAssistantOf(conversationArn, messagingClient, '[conversation-membership]');
      if (primary.classification !== CONTEXT_CLASSIFICATION) throw new Error('the room is not this classification');
      await sayThroughRouter(CONTEXT_CLASSIFICATION, {
        kind: 'memberJoined', channelArn: conversationArn, botArn: primary.botArn, to: [], vars: { name: who },
        // The person the mention names, so the router says the name only of a member (ADR-060 decision 7).
        people: { name: userArn },
      });
      // `person-joined` IS NAMED TO THE ROUTER once the membership exists (ADR-061 decision 1). Where the room's
      // assistant declares a workflow on it, that run welcomes the new member, by email too, and the separate welcome
      // below is not sent, so the person is welcomed once. A naming that fails owns nobody, and the welcome is sent.
      if ((await personJoinedThroughRouter(CONTEXT_CLASSIFICATION, conversationArn, [userArn])).has(userArn)) {
        return { ok: true, conversationArn, userArn, contextType, contextId };
      }
      await sayThroughRouter(CONTEXT_CLASSIFICATION, {
        kind: 'memberWelcome', channelArn: conversationArn, botArn: primary.botArn, to: [userArn],
        vars: {
          name: userName || who, recap: buildRecap(title, domainContext),
          notifyPerson: userArn, title,
        },
      });
    } catch (gerr) {
      console.warn('[conversation-membership] greeting failed (non-fatal):', gerr);
    }
    return { ok: true, conversationArn, userArn, contextType, contextId };
  } catch (err) {
    console.error('[conversation-membership] add failed:', err);
    return { ok: false, error: 'Adding the member failed' };
  }
}
