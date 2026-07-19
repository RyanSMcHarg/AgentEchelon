/**
 * Channel Battle Admin API
 *
 * Per SPEC-BATTLE.md "Per-Channel Battle Enablement":
 *
 *   POST /channels/battle/enable   { channelArn, experimentId }
 *   POST /channels/battle/disable  { channelArn }
 *   GET  /channels/battle?channelArn=...
 *
 * Authorization:
 *   - Cognito-authenticated
 *   - Caller must be the channel's moderator (the creator, stored in
 *     channel.Metadata.createdBy)
 *   - Only premium-tier channels accept enable
 *
 * Side effects on enable:
 *   - Verifies the experiment exists, is battle-enabled, and has an
 *     altBotSlotArn bound
 *   - CreateChannelMembership for the alt-bot slot (the bot principal
 *     becomes a real channel member)
 *   - Writes ChannelBattleConfig row
 *   - Posts a system message announcing the addition (broadcast as the
 *     default bot so all members see it)
 *
 * Disable reverses: DeleteChannelMembership for the slot, deletes the
 * config row, posts a leaving system message.
 *
 * The router and channel-flow processor read ChannelBattleConfig on a
 * 60s cache, so a toggle propagates within that window.
 */

import {
  ChimeSDKMessagingClient,
  CreateChannelMembershipCommand,
  DeleteChannelMembershipCommand,
  DescribeChannelCommand,
  DescribeChannelMembershipCommand,
  ListChannelModeratorsCommand,
  ListTagsForResourceCommand,
  SendChannelMessageCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { parseJsonBody } from './lib/auth.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry.js';

const messagingClient = new ChimeSDKMessagingClient({});
const ssmClient = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const CHANNEL_BATTLE_CONFIG_TABLE = process.env.CHANNEL_BATTLE_CONFIG_TABLE || '';
const EXPERIMENTS_TABLE = process.env.EXPERIMENTS_TABLE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',');

function corsHeaders(origin?: string): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin',
  };
}

function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

// Resolve the channel's PER-TIER bot (its real creator+member). Each tier owns
// its own bot; no shared bot is a channel member, so bot-attributed sends (add
// alt-bot, announce) must run as the per-tier bot. Battle is premium-only, so in
// practice this is the premium bot. There is NO shared-bot fallback — a missing
// per-tier key returns '' and the caller surfaces "bot ARN not configured".
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const tierBotArnCache: Record<string, string> = {};
async function resolveTierBotArn(tier: string): Promise<string> {
  if (tierBotArnCache[tier]) return tierBotArnCache[tier];
  try {
    const resp = await ssmClient.send(
      new GetParameterCommand({ Name: `${SSM_ROOT}/assistant/${tier}/bot-arn` }),
    );
    tierBotArnCache[tier] = resp.Parameter?.Value || '';
    return tierBotArnCache[tier];
  } catch (err) {
    console.warn(`[channel-battle] per-tier bot param for ${tier} missing:`, (err as Error).name);
    return '';
  }
}

function getCallerSub(event: APIGatewayProxyEvent): string | null {
  const claims = (event.requestContext.authorizer?.claims || {}) as Record<string, string>;
  return claims.sub || null;
}

function callerUserArn(event: APIGatewayProxyEvent): string {
  const sub = getCallerSub(event);
  return sub ? `${APP_INSTANCE_ARN}/user/${sub}` : '';
}

function isValidChannelArn(channelArn: string): boolean {
  if (!APP_INSTANCE_ARN || !channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) return false;
  const channelId = channelArn.slice(`${APP_INSTANCE_ARN}/channel/`.length);
  return /^[a-zA-Z0-9-]+$/.test(channelId);
}

interface ChannelMetadata {
  modelTier?: 'basic' | 'standard' | 'premium';
  createdBy?: string;
  modelId?: string;
  modelName?: string;
}

async function readChannelMetadata(channelArn: string, botArn: string): Promise<ChannelMetadata | null> {
  try {
    const channel = await messagingClient.send(
      new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: botArn }),
    );
    return JSON.parse(channel.Channel?.Metadata || '{}') as ChannelMetadata;
  } catch (err) {
    console.warn('[channel-battle] DescribeChannel failed:', err);
    return null;
  }
}

// The battle tier gate keys on the IMMUTABLE `classification` tag, NOT `metadata.modelTier`.
// Metadata is mutable via the owner rename cap (chime:UpdateChannel), so trusting it would let
// a moderator tamper the tier up to open premium battles on a lower-tier channel. The tag cannot
// be changed by UpdateChannel. Fail-closed to the floor classification (not battle-eligible), so a
// missing/unreadable tag denies the battle rather than opening it.
async function resolveChannelClassification(channelArn: string): Promise<string> {
  try {
    const resp = await messagingClient.send(new ListTagsForResourceCommand({ ResourceARN: channelArn }));
    const tag = (resp.Tags || []).find((t) => t.Key === 'classification')?.Value;
    if (profiles.isKnownClassification(tag)) return profiles.resolveClassification(tag);
    console.warn('[channel-battle][SecurityEvent] channel missing/invalid classification tag; failing closed', { channelArn, tag, failClosedTo: profiles.failClosedValue });
    return profiles.failClosedValue;
  } catch (err) {
    console.warn('[channel-battle] failed to read channel classification tag; failing closed:', err);
    return profiles.failClosedValue;
  }
}

interface Experiment {
  experimentId: string;
  status: 'active' | 'paused' | 'completed';
  tiers: string[];
  battleEnabled?: boolean;
  altBotSlotId?: string;
  altBotSlotArn?: string;
  variants?: Array<{ displayName?: string }>;
}

async function loadExperiment(experimentId: string): Promise<Experiment | null> {
  if (!EXPERIMENTS_TABLE) return null;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: EXPERIMENTS_TABLE, Key: { experimentId } }),
    );
    return (result.Item as Experiment | undefined) || null;
  } catch (err) {
    console.warn('[channel-battle] GetItem experiments failed:', err);
    return null;
  }
}

/**
 * Verify the caller is a CURRENT moderator of the channel via the live
 * ChimeSDK channel-moderator list — not via channel.Metadata.createdBy.
 * `/create-conversation` derives userArn from JWT, so the stored `createdBy`
 * can't be spoofed at channel-creation time, but relying on metadata means any
 * code path that later mutates Metadata could re-open the gap.
 * ListChannelModerators is the live, authoritative source.
 *
 * Returns true iff the caller appears in the moderator list. Uses the
 * caller's own ARN as ChimeBearer (allowed: a user can list moderators
 * of channels they're a member of). On any AWS error we fail CLOSED —
 * deny the action rather than allow it on a transient failure.
 */
async function callerIsModerator(channelArn: string, callerArn: string): Promise<boolean> {
  if (!callerArn) return false;
  try {
    let nextToken: string | undefined;
    do {
      const res = await messagingClient.send(new ListChannelModeratorsCommand({
        ChannelArn: channelArn,
        ChimeBearer: callerArn,
        MaxResults: 50,
        NextToken: nextToken,
      }));
      const mods = res.ChannelModerators || [];
      if (mods.some((m) => m.Moderator?.Arn === callerArn)) return true;
      nextToken = res.NextToken;
    } while (nextToken);
    return false;
  } catch (err) {
    console.warn('[channel-battle] ListChannelModerators failed (fail-closed):', err);
    return false;
  }
}

async function findSlotConflicts(altBotSlotId: string, excludeExperimentId: string): Promise<string[]> {
  // Used to enforce "one experiment per slot." Scans active experiments;
  // small table, infrequent admin path, so the cost is fine.
  if (!EXPERIMENTS_TABLE) return [];
  try {
    const result = await ddb.send(new ScanCommand({ TableName: EXPERIMENTS_TABLE }));
    return ((result.Items || []) as Experiment[])
      .filter(
        (e) =>
          e.battleEnabled === true
          && e.altBotSlotId === altBotSlotId
          && e.experimentId !== excludeExperimentId
          && e.status === 'active',
      )
      .map((e) => e.experimentId);
  } catch (err) {
    console.warn('[channel-battle] findSlotConflicts scan failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface EnableBody {
  channelArn?: string;
  experimentId?: string;
}

async function handleEnable(event: APIGatewayProxyEvent, origin?: string): Promise<APIGatewayProxyResult> {
  // parseJsonBody returns 400 on malformed JSON instead of throwing into the
  // outer 500 handler.
  const parsed = parseJsonBody<EnableBody>(event, origin);
  if ('statusCode' in parsed) return parsed;
  const body = parsed.body;
  const channelArn = body.channelArn;
  const experimentId = body.experimentId;

  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'Invalid or missing channelArn' }, origin);
  }
  if (!experimentId) {
    return respond(400, { error: 'Missing experimentId' }, origin);
  }

  const callerSub = getCallerSub(event);
  if (!callerSub) {
    return respond(401, { error: 'Unauthorized — no Cognito sub on the request' }, origin);
  }
  const callerArn = callerUserArn(event);

  // Channel access + moderator check. Read metadata as the CALLER (a member):
  // no shared bot is a channel member, so the per-tier bot can't DescribeChannel.
  const meta = await readChannelMetadata(channelArn, callerArn);
  if (!meta) {
    return respond(404, { error: 'Channel not found or inaccessible' }, origin);
  }
  // Access confirmed above (caller could DescribeChannel). Tier comes from the tag.
  const channelClassification = await resolveChannelClassification(channelArn);
  if (!profiles.profileFor(channelClassification).battleEligible) {
    return respond(403, {
      error: `Battle Mode is not available on ${channelClassification}-classification channels`,
      code: 'TIER_FORBIDDEN',
      tier: channelClassification,
    }, origin);
  }
  // Act as the channel's per-tier bot (its creator+member) for the alt-bot
  // membership add + announcement. Premium by default; the channel's own tier
  // when /battle is opened to other tiers.
  const botArn = await resolveTierBotArn(channelClassification);
  if (!botArn) {
    return respond(500, { error: `${channelClassification} bot ARN not configured` }, origin);
  }
  // Verify against the live channel moderator list rather than
  // channel.Metadata.createdBy. The metadata is trustworthy on creation, but
  // ListChannelModerators is the authoritative source if a moderator is later
  // added/removed out-of-band.
  if (!(await callerIsModerator(channelArn, callerArn))) {
    return respond(403, {
      error: 'Only a channel moderator can toggle Battle Mode',
      code: 'NOT_MODERATOR',
    }, origin);
  }

  // Experiment validation.
  const exp = await loadExperiment(experimentId);
  if (!exp) {
    return respond(404, { error: 'Experiment not found' }, origin);
  }
  if (!exp.battleEnabled) {
    return respond(400, {
      error: 'Experiment is not battle-enabled. Mark it battleEnabled in the Experiments tab first.',
      code: 'EXPERIMENT_NOT_BATTLE',
    }, origin);
  }
  if (!exp.altBotSlotArn || !exp.altBotSlotId) {
    return respond(400, {
      error: 'Experiment is missing altBotSlotArn (re-save it to bind a slot)',
      code: 'EXPERIMENT_NO_SLOT',
    }, origin);
  }
  if (exp.status !== 'active') {
    return respond(400, {
      error: 'Experiment is not active',
      code: 'EXPERIMENT_NOT_ACTIVE',
    }, origin);
  }

  // Slot-conflict check (defense in depth — admin write path also enforces).
  const conflicts = await findSlotConflicts(exp.altBotSlotId, exp.experimentId);
  if (conflicts.length > 0) {
    return respond(409, {
      error: 'Slot is bound to another active battle experiment',
      code: 'SLOT_BOUND',
      conflictingExperimentIds: conflicts,
    }, origin);
  }

  // Add the alt-slot bot as a channel member.
  try {
    await messagingClient.send(
      new CreateChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: exp.altBotSlotArn,
        Type: 'DEFAULT',
        ChimeBearer: botArn,
      }),
    );
  } catch (err) {
    const errAny = err as { name?: string; message?: string };
    // Idempotent: ConflictException means already a member.
    if (errAny.name !== 'ConflictException') {
      console.error('[channel-battle][enable] CreateChannelMembership failed:', err);
      return respond(500, { error: `Failed to add alt-bot: ${errAny.message || err}` }, origin);
    }
  }

  // Write ChannelBattleConfig row.
  if (!CHANNEL_BATTLE_CONFIG_TABLE) {
    return respond(500, { error: 'CHANNEL_BATTLE_CONFIG_TABLE not configured' }, origin);
  }
  await ddb.send(
    new PutCommand({
      TableName: CHANNEL_BATTLE_CONFIG_TABLE,
      Item: {
        channelArn,
        enabled: true,
        experimentId: exp.experimentId,
        altBotSlotId: exp.altBotSlotId,
        altBotSlotArn: exp.altBotSlotArn,
        enabledBy: callerArn,
        enabledAt: new Date().toISOString(),
      },
    }),
  );

  // Announce the addition. Broadcast (no Target) as the default bot.
  const variantDisplayName = exp.variants?.[1]?.displayName || 'an alternative assistant';
  try {
    await messagingClient.send(
      new SendChannelMessageCommand({
        ChannelArn: channelArn,
        Content: `Battle Mode is now ON. ${variantDisplayName} has joined the channel. Try \`/battle <your prompt>\` to compare both assistants.`,
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: botArn,
      }),
    );
  } catch (err) {
    console.warn('[channel-battle][enable] System message send failed (non-fatal):', err);
  }

  return respond(200, {
    enabled: true,
    channelArn,
    experimentId: exp.experimentId,
    altBotSlotArn: exp.altBotSlotArn,
    altBotDisplayName: variantDisplayName,
  }, origin);
}

interface DisableBody {
  channelArn?: string;
}

async function handleDisable(event: APIGatewayProxyEvent, origin?: string): Promise<APIGatewayProxyResult> {
  // 400 on malformed JSON.
  const parsed = parseJsonBody<DisableBody>(event, origin);
  if ('statusCode' in parsed) return parsed;
  const body = parsed.body;
  const channelArn = body.channelArn;

  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'Invalid or missing channelArn' }, origin);
  }

  const callerSub = getCallerSub(event);
  if (!callerSub) {
    return respond(401, { error: 'Unauthorized — no Cognito sub on the request' }, origin);
  }
  const callerArn = callerUserArn(event);

  // Read metadata as the CALLER (a member); no shared bot is a channel member.
  // Then resolve the channel's per-tier bot for the bot-attributed delete +
  // announcement.
  const meta = await readChannelMetadata(channelArn, callerArn);
  if (!meta) {
    return respond(404, { error: 'Channel not found or inaccessible' }, origin);
  }
  const botArn = await resolveTierBotArn(await resolveChannelClassification(channelArn));
  // See handleEnable — live moderator list.
  if (!(await callerIsModerator(channelArn, callerArn))) {
    return respond(403, {
      error: 'Only a channel moderator can toggle Battle Mode',
      code: 'NOT_MODERATOR',
    }, origin);
  }

  // Load the current config to find the slot ARN to remove.
  if (!CHANNEL_BATTLE_CONFIG_TABLE) {
    return respond(500, { error: 'CHANNEL_BATTLE_CONFIG_TABLE not configured' }, origin);
  }
  const config = await ddb.send(
    new GetCommand({ TableName: CHANNEL_BATTLE_CONFIG_TABLE, Key: { channelArn } }),
  );
  const altBotSlotArn = (config.Item as { altBotSlotArn?: string } | undefined)?.altBotSlotArn;

  if (altBotSlotArn) {
    try {
      await messagingClient.send(
        new DeleteChannelMembershipCommand({
          ChannelArn: channelArn,
          MemberArn: altBotSlotArn,
          ChimeBearer: botArn,
        }),
      );
    } catch (err) {
      console.warn('[channel-battle][disable] DeleteChannelMembership (non-fatal):', err);
    }
  }

  await ddb.send(
    new DeleteCommand({ TableName: CHANNEL_BATTLE_CONFIG_TABLE, Key: { channelArn } }),
  );

  try {
    await messagingClient.send(
      new SendChannelMessageCommand({
        ChannelArn: channelArn,
        Content: 'Battle Mode is now OFF.',
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: botArn,
      }),
    );
  } catch (err) {
    console.warn('[channel-battle][disable] System message send failed (non-fatal):', err);
  }

  return respond(200, { enabled: false, channelArn }, origin);
}

async function handleGet(event: APIGatewayProxyEvent, origin?: string): Promise<APIGatewayProxyResult> {
  const channelArn = event.queryStringParameters?.channelArn || '';
  if (!isValidChannelArn(channelArn)) {
    return respond(400, { error: 'Invalid or missing channelArn' }, origin);
  }
  if (!CHANNEL_BATTLE_CONFIG_TABLE) {
    return respond(500, { error: 'CHANNEL_BATTLE_CONFIG_TABLE not configured' }, origin);
  }

  // Verify the caller is a channel member before disclosing battle config
  // (enabled flag, experimentId, altBotSlotArn) — otherwise any signed-in user
  // could read any channel's config just by knowing the ARN.
  const callerSub = getCallerSub(event);
  if (callerSub && APP_INSTANCE_ARN) {
    const callerUserArn = `${APP_INSTANCE_ARN}/user/${callerSub}`;
    try {
      await messagingClient.send(new DescribeChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: callerUserArn,
        ChimeBearer: callerUserArn,
      }));
    } catch (membershipErr) {
      console.warn('[channel-battle] config GET denied — caller not a member', {
        callerSub, channelArn, err: (membershipErr as Error).name,
      });
      return respond(403, {
        error: 'Caller is not a member of the channel',
        code: 'NOT_A_MEMBER',
      }, origin);
    }
  }

  const result = await ddb.send(
    new GetCommand({ TableName: CHANNEL_BATTLE_CONFIG_TABLE, Key: { channelArn } }),
  );
  if (!result.Item) {
    return respond(200, { enabled: false, channelArn }, origin);
  }
  return respond(200, result.Item, origin);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;
  const path = event.path || '';
  const method = event.httpMethod;

  if (method === 'OPTIONS') {
    return respond(200, {}, origin);
  }

  try {
    if (method === 'POST' && path.endsWith('/battle/enable')) {
      return await handleEnable(event, origin);
    }
    if (method === 'POST' && path.endsWith('/battle/disable')) {
      return await handleDisable(event, origin);
    }
    if (method === 'GET' && path.endsWith('/battle')) {
      return await handleGet(event, origin);
    }
    return respond(404, { error: `No route for ${method} ${path}` }, origin);
  } catch (err) {
    console.error('[channel-battle] Unhandled error:', err);
    return respond(500, { error: 'Internal server error' }, origin);
  }
}
