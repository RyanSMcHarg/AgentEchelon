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
 *   - Verifies the experiment exists, is battle-enabled, and names this
 *     classification's challenger (`challengerAssistant`)
 *   - CreateChannelMembership for the challenger's bot, read from its
 *     assignment record (the alt becomes a real channel member)
 *   - Writes ChannelBattleConfig row
 *   - Posts a system message announcing the addition (broadcast as the
 *     room's primary so all members see it)
 *
 * Disable reverses: DeleteChannelMembership for the challenger the enable
 * added, deletes the config row, posts a leaving system message.
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
import { SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { parseJsonBody, callerPersonId } from './lib/auth.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { readChannelClassificationTag } from './lib/channel-classification.js';
import { resolveActiveBattleExperimentForClassification, battleSidesOf, type Experiment as ManagedExperiment } from './lib/experiment-manager.js';
import { noticeLine } from './lib/assistant-notice.js';
import { endBattle } from './lib/battle-end.js';
import { sayThroughRouter } from './lib/say-through-router.js';
import { primaryAssistantOf, memoizedTagReader } from './lib/conversation-primary.js';
import { canRunBattle } from './lib/battle-enablement.js';
import { readAltAssignment, challengerOf, DUEL_ROLE, type LegacyBattleBinding } from './lib/alt-assignment.js';
import { challengerBotArnOf, type ChannelBattleConfig } from './lib/battle-state.js';
import { userArnFor } from './lib/person-arn.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { parseChannelMetadata } from './lib/chime/channel-meta.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const messagingClient = chimeMessagingClient({});
/** One tag read per conversation: the classification gate and the room's primary read the same tags. */
const tagReader = memoizedTagReader(messagingClient);
const ssmClient = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const CHANNEL_BATTLE_CONFIG_TABLE = process.env.CHANNEL_BATTLE_CONFIG_TABLE || '';
const EXPERIMENTS_TABLE = process.env.EXPERIMENTS_TABLE || '';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN);

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,POST,OPTIONS' });

const respond = http.respond;

// Resolve the channel's PER-CLASSIFICATION bot (its real creator+member). Each classification owns
// its own bot; no shared bot is a channel member, so bot-attributed sends (add
// alt-bot, announce) must run as the per-classification bot. Every conversational classification is
// battle-eligible (2026-09-17), so this is the bot of whichever classification the room carries and
// not, as this comment used to say, the premium one in practice. There is NO shared-bot fallback — a
// missing per-classification key returns '' and the caller surfaces "bot ARN not configured".
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
/**
 * THE PRIMARY ASSISTANT OF THIS CONVERSATION (ADR-030).
 *
 * Named for what it resolves rather than for how it currently finds it, because the old name -
 * "the bot arn" - claimed to answer "which assistant acts for this room" while actually answering
 * "which bot does this classification have". Those are the same answer only while a room has one
 * assistant, and the name is what hid that assumption from every call site.
 *
 * THE ROLE IS THE ANSWER, NOT THE CLASSIFICATION. What a caller needs is the assistant holding the
 * PRIMARY role in this conversation: the one that takes a turn nobody addressed, and the one that
 * may hand work to another assistant when the work is not its own. Classification decides what an
 * assistant may DO - it is the access boundary and stays tag-authoritative - and it stops deciding
 * WHO acts, which was only ever a coincidence of there being one of them.
 *
 * TODAY the role is implied: a classification has exactly one assistant, that assistant is the
 * channel's creator and member, so it holds every role there is. The lookup below is therefore
 * correct and will stay correct for single-assistant rooms after the role record exists - which is
 * what makes replacing it a behavior-neutral first step rather than a migration.
 */
/**
 * THE ROOM'S PRIMARY, which speaks for the room: Battle Mode's on and off notices and adding the alt
 * (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8). Empty when it cannot be resolved, or is not an assistant
 * of the classification this request was checked against, and the caller refuses.
 */
async function resolvePrimaryBotArn(channelArn: string, classification: string): Promise<string> {
  try {
    const primary = await primaryAssistantOf(channelArn, tagReader, '[channel-battle]');
    return primary.classification === classification ? primary.botArn : '';
  } catch (err) {
    console.warn('[channel-battle] the room has no resolvable primary', { channelArn, err: (err as Error).message });
    return '';
  }
}

/**
 * THIS CONVERSATION'S CHALLENGER: the alt of its classification's primary role, from the record its
 * classification stack writes (§3.7). Null when the classification provisions no alt or the record cannot
 * be read, and the caller refuses: a duel with no second side is not one to start.
 */
async function resolveRoomAlt(classification: string): Promise<{ botArn: string } | null> {
  try {
    return await readAltAssignment(ssmClient, SSM_ROOT, classification);
  } catch (err) {
    console.warn('[channel-battle] could not read the alt assignment record', {
      classification, error: (err as Error).name,
    });
    return null;
  }
}


function isValidChannelArn(channelArn: string): boolean {
  if (!APP_INSTANCE_ARN || !channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) return false;
  const channelId = channelArn.slice(`${APP_INSTANCE_ARN}/channel/`.length);
  return /^[a-zA-Z0-9-]+$/.test(channelId);
}

interface ChannelMetadata {
  /** Member-writable metadata: never read for a decision (the gate reads the classification tag). */
  modelTier?: string;
  createdBy?: string;
  modelId?: string;
  modelName?: string;
}

async function readChannelMetadata(channelArn: string, botArn: string): Promise<ChannelMetadata | null> {
  try {
    const channel = await messagingClient.send(
      new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: botArn }),
    );
    const meta = parseChannelMetadata(channel.Channel?.Metadata);
    if (!meta) console.warn('[channel-battle] the channel Metadata is not a JSON object');
    return (meta as ChannelMetadata | undefined) ?? null;
  } catch (err) {
    console.warn('[channel-battle] DescribeChannel failed:', err);
    return null;
  }
}

// The battle classification gate keys on the IMMUTABLE `classification` tag, NOT `metadata.modelTier`.
// Metadata is mutable via the owner rename cap (chime:UpdateChannel), so trusting it would let
// a moderator rewrite the classification to open premium battles on a channel not cleared for them.
// The tag cannot be changed by UpdateChannel.
//
// IT NO LONGER FAILS CLOSED TO THE FLOOR, AND IT CANNOT (ADR-045 decision 2). The old guarantee was
// "a missing or unreadable tag denies the battle rather than opening it", and it rested entirely on
// the floor classification not being battle-eligible. Every conversational classification is
// battle-eligible as of 2026-09-17, so substituting the floor would now OPEN a duel on a tag nobody
// could read - the safety property inverted the moment that config changed, silently, in a different
// file. An unreadable tag is `undefined` here and the caller refuses.
async function resolveChannelClassification(channelArn: string): Promise<string | undefined> {
  return readChannelClassificationTag(tagReader as unknown as ChimeSDKMessagingClient, channelArn, '[channel-battle]');
}

interface Experiment extends LegacyBattleBinding {
  experimentId: string;
  status: 'active' | 'paused' | 'completed';
  /** Target intent this experiment scopes to (drives the briefing's prompt steering, DESIGN §2.2). */
  intent?: string;
  tiers: string[];
  battleEnabled?: boolean;
  /** The challenger's assistant id, `alt-{role}-{classification}`; read through `challengerOf`. */
  challengerAssistant?: string;
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

async function findChallengerConflicts(challengerAssistant: string, excludeExperimentId: string): Promise<string[]> {
  // Used to enforce "one experiment per challenger", keyed by the challenger's assistant id. Scans active
  // experiments; small table, infrequent admin path.
  if (!EXPERIMENTS_TABLE) return [];
  try {
    const result = await ddb.send(new ScanCommand({ TableName: EXPERIMENTS_TABLE }));
    return ((result.Items || []) as Experiment[])
      .filter(
        (e) =>
          e.battleEnabled === true
          && challengerOf(e) === challengerAssistant
          && e.experimentId !== excludeExperimentId
          && e.status === 'active',
      )
      .map((e) => e.experimentId);
  } catch (err) {
    console.warn('[channel-battle] findChallengerConflicts scan failed:', err);
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
  general: {
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
  data_extraction: {
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
  guided_troubleshooting: {
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
 * DECISION, never which side is which model (INV-4 / §2.4). Returns null when
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

  const callerSub = await callerPersonId(event);
  if (!callerSub) {
    return respond(401, { error: 'Unauthorized: this sign-in names no person' }, origin);
  }
  const callerArn = userArnFor(APP_INSTANCE_ARN, callerSub);

  // Channel access + moderator check. Read metadata as the CALLER (a member):
  // no shared bot is a channel member, so the per-classification bot can't DescribeChannel.
  const meta = await readChannelMetadata(channelArn, callerArn);
  if (!meta) {
    return respond(404, { error: 'Channel not found or inaccessible' }, origin);
  }
  // Access confirmed above (caller could DescribeChannel). Classification comes from the tag.
  const channelClassification = await resolveChannelClassification(channelArn);
  if (!channelClassification) {
    // Unreadable is not a classification, and with every classification now battle-eligible there is
    // no safe value to stand in for one. Refuse the enable rather than guess which room this is.
    return respond(403, {
      error: 'Battle Mode cannot be enabled: this conversation\'s classification could not be read',
      code: 'CLASSIFICATION_UNREADABLE',
    }, origin);
  }
  // CAPABILITY AND POLICY, IN THAT ORDER (ADR-049). This read `battleEligible` off the assistant
  // profile, which was `true` for basic while basic's stack wires no battle plumbing at all - so an
  // enable here succeeded and the duel had no grants to run with. `canRunBattle` refuses unless the
  // deployment wired battle for this classification AND an operator turned it on.
  if (!(await canRunBattle(channelClassification))) {
    return respond(403, {
      error: `Battle Mode is not available on ${channelClassification}-classification channels`,
      code: 'TIER_FORBIDDEN',
      tier: channelClassification,
    }, origin);
  }
  // Act as the channel's per-classification bot (its creator+member) for the alt-bot
  // membership add + announcement: always the channel's own classification's bot, or none.
  const botArn = await resolvePrimaryBotArn(channelArn, channelClassification);
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
  const challengerAssistant = challengerOf(exp);
  if (!challengerAssistant) {
    return respond(400, {
      error: 'Experiment names no challenger (re-save it to name one)',
      code: 'EXPERIMENT_NO_CHALLENGER',
    }, origin);
  }
  // THE DUEL'S SECOND SIDE COMES FROM THIS ROOM'S OWN CLASSIFICATION (ADR-045 decision 7).
  //
  // An alt is an assistant OF a classification, and adding one to a room of a different classification
  // is the out-of-band membership this whole record is about - it would be refused by IAM at its first
  // channel read.
  //
  // Checked here rather than left to IAM because this is the moment a person can be TOLD. A refusal
  // at the first read is silent by design; a 400 at the enable names the mismatch while somebody is
  // looking at the screen.
  //
  // The experiment's classification is the alt's, because the alt is the experiment's classification's own
  // assistant; and the challenger it names must be the one this room's classification provisions today.
  const altClassification = exp.tiers?.[0];
  if (altClassification && altClassification !== channelClassification) {
    return respond(400, {
      error: `That experiment runs in ${altClassification} and this conversation is `
        + `${channelClassification}. Choose a ${channelClassification} experiment and try again.`,
      code: 'CHALLENGER_CLASSIFICATION_MISMATCH',
    }, origin);
  }
  if (exp.status !== 'active') {
    return respond(400, {
      error: 'Experiment is not active',
      code: 'EXPERIMENT_NOT_ACTIVE',
    }, origin);
  }

  // The challenger's bot comes from its assignment record, never from the experiment row.
  const roomAlt = await resolveRoomAlt(channelClassification);
  if (!roomAlt || challengerAssistant !== profiles.altAssistantName(channelClassification, DUEL_ROLE)) {
    return respond(400, {
      error: `The experiment's challenger is not this deployment's ${channelClassification} alt `
        + 'assistant. Re-save the experiment to name it again.',
      code: 'EXPERIMENT_NO_CHALLENGER',
    }, origin);
  }

  // Challenger-conflict check (defense in depth — admin write path also enforces).
  const conflicts = await findChallengerConflicts(challengerAssistant, exp.experimentId);
  if (conflicts.length > 0) {
    return respond(409, {
      error: 'The challenger is named by another active battle experiment',
      code: 'CHALLENGER_BOUND',
      conflictingExperimentIds: conflicts,
    }, origin);
  }

  // Add the challenger as a channel member.
  try {
    await messagingClient.send(
      new CreateChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: roomAlt.botArn,
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
  //
  // `challengerBotArn` is the member this enable ADDED to this room, recorded so disable removes exactly
  // that member even if the alt's record names another bot by then. It is a fact about this room's
  // membership, not a copy of the record for readers: a turn reads the challenger from the record.
  const configItem: Record<string, unknown> = {
    channelArn,
    enabled: true,
    experimentId: exp.experimentId,
    challengerAssistant,
    challengerBotArn: roomAlt.botArn,
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
  // names the decision, never the models, so the side names stay opaque (§2.4 / INV-4).
  // With no objective statement we fall back to today's announcement (INV-2:
  // absent ⇒ prior behavior).
  // THE CHALLENGER'S NAME IS ITS PROFILE'S (`battleSideNames`), the name the room's members panel shows,
  // read from the experiment this enable already holds rather than a second scan for it. A name that does
  // not resolve is said as the catalog's line for an unnamed challenger, never as its assistant id.
  const sides = await battleSidesOf(exp as unknown as ManagedExperiment).catch((err) => {
    console.warn('[channel-battle][enable] the battle sides did not resolve', { experimentId: exp.experimentId, err: (err as Error)?.message });
    return null;
  });
  let variantDisplayName = sides?.treatment?.displayName?.trim();
  if (!variantDisplayName) {
    console.warn("[channel-battle][enable] the challenger's name did not resolve; it is announced unnamed", {
      experimentId: exp.experimentId, challengerAssistant,
    });
    variantDisplayName = noticeLine(undefined, 'battleChallengerUnnamed');
  }
  const briefing = buildBattleBriefing(exp.objective?.statement, exp.intent);
  // NAMED, NOT SAID: the room's assistant says it through its router, in its own copy
  // (`say-through-router.ts`). This API speaks as no assistant.
  await sayThroughRouter(channelClassification, briefing
    ? { kind: 'battleModeBriefing', channelArn, botArn, to: [], vars: { briefing } }
    : { kind: 'battleModeOn', channelArn, botArn, to: [], vars: { variant: variantDisplayName } });

  return respond(200, {
    enabled: true,
    channelArn,
    experimentId: exp.experimentId,
    challengerAssistant,
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

  const callerSub = await callerPersonId(event);
  if (!callerSub) {
    return respond(401, { error: 'Unauthorized: this sign-in names no person' }, origin);
  }
  const callerArn = userArnFor(APP_INSTANCE_ARN, callerSub);

  // Read metadata as the CALLER (a member); no shared bot is a channel member.
  // Then resolve the channel's per-classification bot for the bot-attributed delete +
  // announcement.
  const meta = await readChannelMetadata(channelArn, callerArn);
  if (!meta) {
    return respond(404, { error: 'Channel not found or inaccessible' }, origin);
  }
  const disableClassification = await resolveChannelClassification(channelArn);
  if (!disableClassification) {
    // DISABLE REFUSES TOO, and that is worth a sentence because the instinct is to let a teardown
    // through. The bot ARN is resolved FROM the classification, so an unreadable tag would pick some
    // other classification's assistant to act as - posting the leaving message and deleting the
    // membership as an identity that was never in this room.
    return respond(403, {
      error: 'Battle Mode cannot be changed: this conversation\'s classification could not be read',
      code: 'CLASSIFICATION_UNREADABLE',
    }, origin);
  }
  const botArn = await resolvePrimaryBotArn(channelArn, disableClassification);
  // See handleEnable — live moderator list.
  if (!(await callerIsModerator(channelArn, callerArn))) {
    return respond(403, {
      error: 'Only a channel moderator can toggle Battle Mode',
      code: 'NOT_MODERATOR',
    }, origin);
  }

  // Load the current config to find the challenger the enable added. A row written before the re-key
  // names it under its old attribute (`challengerBotArnOf`).
  if (!CHANNEL_BATTLE_CONFIG_TABLE) {
    return respond(500, { error: 'CHANNEL_BATTLE_CONFIG_TABLE not configured' }, origin);
  }
  const config = await ddb.send(
    new GetCommand({ TableName: CHANNEL_BATTLE_CONFIG_TABLE, Key: { channelArn } }),
  );
  const challengerBotArn = challengerBotArnOf(config.Item as ChannelBattleConfig | undefined);

  // END THE DUEL BEFORE THE CONFIG ROW GOES, and the order is the whole point.
  //
  // Turning Battle Mode off is what every refusal tells people to ask a moderator for, and it used to
  // leave a running duel exactly where it stood: sides still INVOKED or waiting, a question in the
  // transcript still rendering its live "Replying to:" control, and a pointer nothing would clear.
  // Ending the container ends the task inside it (DESIGN-BATTLE 2a-i), so one action does what the
  // person asked for rather than half of it.
  //
  // Before the delete because the pointer lives ON the config row: clearing it afterwards would find no
  // item and do nothing. The row is deleted a few lines below, which takes the pointer with it - the
  // release still runs first so the audit fields are written and the abandon path is driven from one
  // door rather than open-coded here.
  const activeBattleId = (config.Item as { activeBattleId?: string } | undefined)?.activeBattleId;
  if (activeBattleId) {
    await endBattle({
      channelArn,
      battleId: activeBattleId,
      reason: 'abandoned:battle-mode-off',
      endedBy: callerArn,
      // The orchestrator takes down each side's waiting marker as that side's assistant, and this waits for it:
      // the alt is removed from the room next, and an edit by a non-member fails.
      classification: disableClassification,
      waitForMarkers: true,
    });
  }

  // THE ALT LEAVES AFTER THE DUEL HAS ENDED, so its marker could still be cleared while it was a member.
  if (challengerBotArn) {
    try {
      await messagingClient.send(
        new DeleteChannelMembershipCommand({
          ChannelArn: channelArn,
          MemberArn: challengerBotArn,
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

  await sayThroughRouter(disableClassification, {
    kind: activeBattleId ? 'battleModeOffEnded' : 'battleModeOff', channelArn, botArn, to: [],
  });

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
  // (enabled flag, experimentId, challenger) — otherwise any signed-in user
  // could read any channel's config just by knowing the ARN.
  const callerSub = await callerPersonId(event);
  if (callerSub && APP_INSTANCE_ARN) {
    const callerUserArn = userArnFor(APP_INSTANCE_ARN, callerSub);
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
  // A READ, SO AN UNREADABLE TAG REPORTS "NOT ELIGIBLE" RATHER THAN REFUSING THE WHOLE RESPONSE.
  // This endpoint answers several capability questions at once for the composer; failing all of them
  // because one could not be resolved would blank the UI. Reporting the capability as absent hides
  // the Battle surfaces, which is the same direction the gate takes and costs a person a toggle
  // rather than a working conversation.
  const statusClassification = await resolveChannelClassification(channelArn);
  // The SAME question the enable path asks, so the composer never offers a toggle the enable would
  // refuse. Reporting it as absent when the classification is unreadable is unchanged.
  const battleEligible = await canRunBattle(statusClassification);
  /**
   * Whether the assistant here can READ a file the user attaches (attachment-in).
   *
   * WHY IT RIDES THIS RESPONSE. The composer needs a per-conversation capability answer, and this is
   * already the endpoint that has one: it is MEMBER-gated rather than admin- or moderator-gated, and
   * it resolves the classification from the IMMUTABLE TAG (`resolveChannelClassification`) rather
   * than from `metadata.modelTier`, which members can write. The alternative was for the client to
   * decide from the tier name it holds - which is that mutable metadata, and would have put a
   * capability rule in one client for a boundary IAM enforces.
   *
   * THE ENDPOINT'S NAME IS NOW NARROWER THAN ITS JOB, and that is worth saying rather than quietly
   * accepting: it answers "what may this conversation do", of which battle is one case. Renaming it
   * is a breaking change to a live route, so the name stays and this comment carries the intent.
   *
   * It is an AFFORDANCE, never the enforcement. The grant is: a profile without
   * `attachmentsReadable` has no `s3:GetObject` on `attachments/*`, so a client that ignores this
   * field still cannot make the turn read the file - it only makes a person wonder why not.
   */
  const attachmentsReadable = statusClassification
    ? profiles.requireProfileFor(statusClassification).attachmentsReadable === true
    : false;

  const result = await ddb.send(
    new GetCommand({ TableName: CHANNEL_BATTLE_CONFIG_TABLE, Key: { channelArn } }),
  );
  if (!result.Item) {
    return respond(200, { enabled: false, channelArn, battleEligible, attachmentsReadable }, origin);
  }
  // Return only the member-relevant fields. NOT the raw Item: it carries `enabledBy` (the enabling
  // admin's user ARN) and `enabledAt`, which would deanonymize the operator to every channel member.
  const item = result.Item as Record<string, unknown>;
  return respond(200, {
    channelArn,
    enabled: item.enabled ?? false,
    battleEligible,
    attachmentsReadable,
    experimentId: item.experimentId,
    ...(item.challengerAssistant ? { challengerAssistant: item.challengerAssistant } : {}),
    ...(item.briefingStatement ? { briefingStatement: item.briefingStatement } : {}),
    ...(item.briefingIntent ? { briefingIntent: item.briefingIntent } : {}),
  }, origin);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
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
