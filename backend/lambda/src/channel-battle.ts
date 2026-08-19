/**
 * Channel Battle Admin API
 *
 * Per SPEC-BATTLE.md "Per-Channel Battle Enablement":
 *
 *   POST /channels/battle/enable   { channelArn, experimentId? }
 *   POST /channels/battle/disable  { channelArn }
 *   GET  /channels/battle?channelArn=...
 *
 * experimentId is optional: there is at most one active battle-enabled
 * experiment per classification, so when it is omitted the handler
 * auto-resolves the single battle for the channel's classification.
 *
 * Authorization:
 *   - Cognito-authenticated
 *   - Caller must be the channel's moderator (the creator, stored in
 *     channel.Metadata.createdBy)
 *   - Only premium-classification channels accept enable
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
import { resolveChannelClassificationTag as resolveChannelClassificationTagShared } from './lib/channel-classification.js';
import { resolveActiveBattleExperimentForClassification } from './lib/experiment-manager.js';

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

// Resolve the channel's PER-CLASSIFICATION bot (its real creator+member). Each classification owns
// its own bot; no shared bot is a channel member, so bot-attributed sends (add
// alt-bot, announce) must run as the per-classification bot. Battle is premium-only, so in
// practice this is the premium bot. There is NO shared-bot fallback — a missing
// per-classification key returns '' and the caller surfaces "bot ARN not configured".
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const botArnCache: Record<string, string> = {};
async function resolveBotArn(classification: string): Promise<string> {
  if (botArnCache[classification]) return botArnCache[classification];
  try {
    const resp = await ssmClient.send(
      new GetParameterCommand({ Name: `${SSM_ROOT}/assistant/${classification}/bot-arn` }),
    );
    botArnCache[classification] = resp.Parameter?.Value || '';
    return botArnCache[classification];
  } catch (err) {
    console.warn(`[channel-battle] per-classification bot param for ${classification} missing:`, (err as Error).name);
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

// The battle classification gate keys on the IMMUTABLE `classification` tag, NOT `metadata.modelTier`.
// Metadata is mutable via the owner rename cap (chime:UpdateChannel), so trusting it would let
// a moderator tamper the classification up to open premium battles on a lower-classification channel. The tag cannot
// be changed by UpdateChannel. Fail-closed to the floor classification (not battle-eligible), so a
// missing/unreadable tag denies the battle rather than opening it.
async function resolveChannelClassification(channelArn: string): Promise<string> {
  return resolveChannelClassificationTagShared(messagingClient, channelArn, '[channel-battle]');
}

interface Experiment {
  experimentId: string;
  status: 'active' | 'paused' | 'completed';
  /** Target intent this experiment scopes to (drives the briefing's prompt steering, DESIGN §2.2). */
  intent?: string;
  tiers: string[];
  battleEnabled?: boolean;
  altBotSlotId?: string;
  altBotSlotArn?: string;
  variants?: Array<{ displayName?: string }>;
  /** Written objective (DESIGN §1.2). Only `statement` is read here, for the battle briefing (§2.2). */
  objective?: { statement?: string };
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
// Battle-start briefing (DESIGN §2.2 / §2.3, A.5)
// ---------------------------------------------------------------------------

// Static prompt-steering table keyed by the experiment's target intent (the 8
// shipped intents), so the enable briefing nudges users toward decision-relevant
// prompts (DESIGN §2.2). The FRONTEND renders the starter chips; the backend uses
// the coaching line + a couple of examples for the "Most useful prompts" line of
// the enable broadcast, and snapshots the intent onto the config row so the
// frontend can look up its own chips. Deployment-overridable example copy, not
// policy; these ship as defaults.
interface PromptSteering {
  coachingLine: string;
  examples: string[];
}

const PROMPT_STEERING: Record<string, PromptSteering> = {
  general_qa: {
    coachingLine: 'Ask real questions your users ask.',
    examples: ['Explain X to a new hire', "What's the difference between A and B?"],
  },
  code_generation: {
    coachingLine: "Ask a real coding task you'd actually ship.",
    examples: ['Write a function that …', 'Add retry/timeout to this call'],
  },
  code_review: {
    coachingLine: 'Paste real code and ask for a review.',
    examples: ['Review this for bugs', 'Is this concurrency-safe?'],
  },
  document_extraction: {
    coachingLine: 'Give a document and ask for specific fields.',
    examples: ['Extract the totals as a table', 'Pull every date + owner'],
  },
  report_generation: {
    coachingLine: "Ask for a report you'd actually send.",
    examples: ['Draft a one-page status report on …', 'Summarize this for execs'],
  },
  image_generation: {
    coachingLine: 'Describe an image you actually need.',
    examples: ['A hero image for …', 'An icon set for …'],
  },
  strategic_analysis: {
    coachingLine: 'Pose a real judgment call.',
    examples: ['Pros/cons of migrating to …', 'What are the risks of …?'],
  },
  workflow_actions: {
    coachingLine: 'Ask it to drive a multi-step task.',
    examples: ['Plan and track the steps to …', 'Walk me through …'],
  },
};

// Base/classification/profile experiments span intents (no single target intent),
// so fall back to a generic coaching line (DESIGN §2.2).
const GENERIC_COACHING_LINE =
  'ask the kinds of questions your users actually ask';

function endWithPeriod(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * Build the battle-start briefing sentence(s) from the experiment's written
 * objective + target intent (DESIGN §2.2). Semi-blind by design: it names the
 * DECISION, never which alias is which model (INV-4 / §2.4). Returns null when
 * there is no objective statement to brief on, so callers fall back to today's
 * announcement (INV-2: absent ⇒ prior behavior).
 */
function buildBattleBriefing(statement?: string, intent?: string): string | null {
  const decision = (statement || '').trim();
  if (!decision) return null;

  const steering = intent ? PROMPT_STEERING[intent] : undefined;
  const prompts = steering
    ? `${steering.coachingLine} For example: ${steering.examples.map((e) => `"${e}"`).join(', ')}.`
    : `${GENERIC_COACHING_LINE}.`;

  return (
    'Battle Mode is now ON. Two assistants will answer the same prompt so you can compare them. '
    + `We're deciding: ${endWithPeriod(decision)} `
    + `Most useful prompts: ${prompts} `
    + 'Try `/battle <your prompt>` to compare both assistants.'
  );
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
  // experimentId is OPTIONAL. There is at most one active battle-enabled
  // experiment per classification, so when the caller omits it we auto-resolve
  // the channel classification's single battle below. An explicit id is still
  // honored (back-compat) and takes precedence.

  const callerSub = getCallerSub(event);
  if (!callerSub) {
    return respond(401, { error: 'Unauthorized — no Cognito sub on the request' }, origin);
  }
  const callerArn = callerUserArn(event);

  // Channel access + moderator check. Read metadata as the CALLER (a member):
  // no shared bot is a channel member, so the per-classification bot can't DescribeChannel.
  const meta = await readChannelMetadata(channelArn, callerArn);
  if (!meta) {
    return respond(404, { error: 'Channel not found or inaccessible' }, origin);
  }
  // Access confirmed above (caller could DescribeChannel). Classification comes from the tag.
  const channelClassification = await resolveChannelClassification(channelArn);
  if (!profiles.profileFor(channelClassification).battleEligible) {
    return respond(403, {
      error: `Battle Mode is not available on ${channelClassification}-classification channels`,
      code: 'TIER_FORBIDDEN',
      tier: channelClassification,
    }, origin);
  }
  // Act as the channel's per-classification bot (its creator+member) for the alt-bot
  // membership add + announcement. Premium by default; the channel's own classification
  // when /battle is opened to other classifications.
  const botArn = await resolveBotArn(channelClassification);
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

  // Resolve which experiment to bind. When the caller supplied one, use it
  // (back-compat). Otherwise auto-resolve the single active battle-enabled
  // experiment for this channel's classification.
  let resolvedExperimentId = experimentId;
  if (!resolvedExperimentId) {
    const auto = await resolveActiveBattleExperimentForClassification(channelClassification);
    if (!auto) {
      return respond(400, {
        error: 'No active battle-enabled experiment for this classification',
        code: 'NO_BATTLE_EXPERIMENT',
      }, origin);
    }
    resolvedExperimentId = auto.experimentId;
  }

  // Experiment validation.
  const exp = await loadExperiment(resolvedExperimentId);
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
  // ChannelBattleConfig has no shared TS interface — it is this inline Item.
  // Snapshot the objective statement + target intent at enable time (DESIGN A.5,
  // §2.3) so the frontend can render the same briefing to NON-moderators from the
  // config GET, without a per-render experiment read. Both fields are optional and
  // added only when present: this DocumentClient does not strip `undefined`, and a
  // record without them keeps working (INV-2).
  const configItem: Record<string, unknown> = {
    channelArn,
    enabled: true,
    experimentId: exp.experimentId,
    altBotSlotId: exp.altBotSlotId,
    altBotSlotArn: exp.altBotSlotArn,
    enabledBy: callerArn,
    enabledAt: new Date().toISOString(),
  };
  const briefingStatement = exp.objective?.statement?.trim();
  if (briefingStatement) configItem.briefingStatement = briefingStatement;
  if (exp.intent) configItem.briefingIntent = exp.intent;
  await ddb.send(
    new PutCommand({
      TableName: CHANNEL_BATTLE_CONFIG_TABLE,
      Item: configItem,
    }),
  );

  // Announce the addition. Broadcast (no Target) as the default bot.
  //
  // When the experiment carries a written objective, brief battling users on WHAT
  // is being decided and which prompts help (DESIGN §2.2) — semi-blind: the copy
  // names the decision, never the models, so the aliases stay opaque (§2.4 / INV-4).
  // With no objective statement we fall back to today's announcement (INV-2:
  // absent ⇒ prior behavior).
  const variantDisplayName = exp.variants?.[1]?.displayName || 'an alternative assistant';
  const briefing = buildBattleBriefing(exp.objective?.statement, exp.intent);
  const announcement = briefing
    ?? `Battle Mode is now ON. ${variantDisplayName} has joined the channel. Try \`/battle <your prompt>\` to compare both assistants.`;
  try {
    await messagingClient.send(
      new SendChannelMessageCommand({
        ChannelArn: channelArn,
        Content: announcement,
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
  // Then resolve the channel's per-classification bot for the bot-attributed delete +
  // announcement.
  const meta = await readChannelMetadata(channelArn, callerArn);
  if (!meta) {
    return respond(404, { error: 'Channel not found or inaccessible' }, origin);
  }
  const botArn = await resolveBotArn(await resolveChannelClassification(channelArn));
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

  // Whether this conversation MAY battle at all, from the same per-profile flag the enable path gates
  // on. Returned so the UI can hide the Battle surfaces on capability rather than on a hardcoded
  // `modelTier === 'premium'` — which read mutable channel metadata and ignored `battleEligible`
  // entirely, so marking a non-premium profile eligible left the toggle invisible.
  const battleEligible = profiles.profileFor(
    await resolveChannelClassification(channelArn),
  ).battleEligible === true;

  const result = await ddb.send(
    new GetCommand({ TableName: CHANNEL_BATTLE_CONFIG_TABLE, Key: { channelArn } }),
  );
  if (!result.Item) {
    return respond(200, { enabled: false, channelArn, battleEligible }, origin);
  }
  // Return only the member-relevant fields. NOT the raw Item: it carries `enabledBy` (the enabling
  // admin's user ARN) and `enabledAt`, which would deanonymize the operator to every channel member.
  const item = result.Item as Record<string, unknown>;
  return respond(200, {
    channelArn,
    enabled: item.enabled ?? false,
    battleEligible,
    experimentId: item.experimentId,
    altBotSlotArn: item.altBotSlotArn,
    ...(item.briefingStatement ? { briefingStatement: item.briefingStatement } : {}),
    ...(item.briefingIntent ? { briefingIntent: item.briefingIntent } : {}),
  }, origin);
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
