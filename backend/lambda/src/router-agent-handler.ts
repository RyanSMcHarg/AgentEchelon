/**
 * Router Agent Handler
 *
 * Single entry point for all Lex fulfillment. Reads channel metadata
 * to determine the conversation's classification, then routes to the correct
 * async processor (Basic/Standard/Premium) and applies classification-appropriate
 * intent classification and task tracking.
 *
 * Classification routing (single entry point for ALL classifications; deployed
 * per-classification, keyed by the CLASSIFICATION env var). Intent classification
 * mode is per-profile (`AssistantProfile.classifierMode`); ALL default profiles —
 * basic included — use the LLM classifier (`classifyIntent`). `classifyIntentByKeyword`
 * (no-LLM keyword) runs ONLY for a profile a deployment explicitly sets to
 * `classifierMode: 'keyword'`, so it is not on the default path for any classification.
 * - basic    → classifyIntent() + BASIC_ASYNC_PROCESSOR_ARN (Haiku, tasks: full)
 * - standard → classifyIntent() + STANDARD_ASYNC_PROCESSOR_ARN (Sonnet, tasks: full)
 * - premium  → classifyIntent() + PREMIUM_ASYNC_PROCESSOR_ARN (Opus, tasks: full)
 */

import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  ChimeSDKMessagingClient,
  DescribeChannelCommand,
  ListChannelMembershipsCommand,
  ListTagsForResourceCommand,
  SendChannelMessageCommand,
  ListChannelMessagesCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  classifyIntent,
  classifyIntentByKeyword,
  IntentType,
  intentToDeliveryOption,
} from './lib/intent-classifier.js';
import { hydrateIntentPackFromSsm, responseSettingsForIntent, activeIntentPackRaw, taskStateMachines } from './lib/intent-pack.js';
import { awaitedPartyOf } from './lib/task-state-machines.js';
import { componentVersion } from './lib/config-identity.js';
import {
  DeliveryOption,
  selectDeliveryOption,
  getQuickResponse,
  getTaskPlaceholder,
} from './lib/delivery-options.js';
import { applyUserResponseToTask, createTask, getActiveTask, getActiveTaskForOwner, getOwnerChannelTasks, getTask, principalIdFromArn, RECENTLY_ENDED_TASK_WINDOW_MINUTES, taskEndedAt, TRIP_TASK_TTL_SECONDS, type TaskCreateOptions, type UserTask } from './lib/task-tracking.js';

/**
 * How long after a task ends the conversation is still treated as being about it, in milliseconds.
 *
 * Derived once from the named minutes constant (`task-tracking.ts`, which carries the reasoning for
 * the default and the trade it accepts) rather than recomputed at each of the three sites that use
 * it, so a deployment that tunes the window tunes all of them.
 */
const RECENTLY_ENDED_WINDOW_MS = RECENTLY_ENDED_TASK_WINDOW_MINUTES * 60 * 1000;
// The duel a channel currently has in flight, and who owns it. Read on the resume path below: a
// waiting duel side's chain is resumed through the ORDINARY Lex turn, so the handler is where the
// battle row has to be moved off `WAITING_FOR_USER`.
import { resolveActiveBattle, readBattleRows, resumeBotFromWaiting, loadChannelBattleConfig } from './lib/battle-state.js';
import { evaluateAbuseGate, capUserMessage, claimCorrelation, hasCorrelationClaim } from './lib/abuse-controls.js';
import { turnCorrelationId, mentionCorrelationId } from './lib/correlation.js';
import { resolveChannelSize } from './lib/channel-size.js';
// The bypass tokens, shared with the channel flow so the two sides cannot disagree about what one is.
import { flowBypassToken, stripAtAll } from './lib/flow-bypass.js';
import { resolveUserClearance } from './lib/user-clearance.js';
import { assembleHostGrounding } from './lib/host-grounding.js';
import { poolIdFromIssuer } from './lib/channel-notify.js';
// SPEC-CAPABILITY-PROFILES: the single interpreter of classification tags + group clearance.
// Replaces the local CLASSIFICATION_RANK / CLEARANCE_GROUPS / minRank / isAdvancedClassification / classificationScope constants.
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry.js';
import { resolveChannelClassificationTag as resolveChannelClassificationTagShared } from './lib/channel-classification.js';
// Retrieval runs in the VPC-attached data-plane Lambda (ADR-013);
// this handler stays non-VPC and invokes it via the client seam. Same signature.
import { retrieveContext, getLatestSummary, type RetrieveContextResult } from './lib/data-plane-client.js';
import { resolveExperimentModel, resolveClassificationExperiment, resolveBattleVariantBySlotArn } from './lib/experiment-manager.js';
import { getModelCatalog, bedrockInvokeId } from '../../lib/config/model-strategy.js';
import { resolveActiveProfile, concreteModel } from './lib/active-profile.js';
import type { ProfileDefinition } from './lib/active-profile.js';
import { randomUUID } from 'crypto';
import { runLiveDriftFlow } from './lib/live-drift-flow.js';
// Whether a turn continues in this conversation rather than being offered a new one. One named
// decision, so the two-axis rule that replaces it (task-relatedness, then conversation-relatedness)
// changes that function's body and no call site here.
import { resolveTaskContinuity } from './lib/task-continuity.js';
import {
  parseWelcomeOrientationDetailed,
  composeWelcome,
  type WelcomeOrientation,
} from './lib/welcome-orientation.js';
import { recordWelcomeConfigDefect } from './lib/welcome-metrics.js';
import { getParticipantContext, getChannelContext } from './lib/channel-context-client.js';
import {
  participantContextFor,
  onboardingApplies,
  type ParticipantContext,
} from './lib/participant-shape.js';
import {
  loadIntakeConfig,
  isOnboardingEnabled,
  startIntake,
  advanceIntake,
  readIntakeState,
  writeIntakeState,
} from './lib/onboarding-intake.js';
import { hasOnboarded, markOnboarded } from './lib/user-profile-client.js';
import { extractAttachment, type MessageAttachment } from './lib/battle-attachment.js';
import {
  isSanctionedBattleBot,
  resolveBattleSide,
  battlePlaceholderContent,
} from './lib/battle-turn.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
// Per-classification bot SSM key (= /agent-echelon/assistant/{classification}/bot-arn),
// always set by the deploying classification stack. There is no shared
// '/agent-echelon/bot-arn' fallback.
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || '';
const USER_POOL_ID = process.env.USER_POOL_ID || '';
/**
 * Pools a member name may be resolved from: this deployment's own, plus any additional trusted IdP
 * pools a multi-IdP deployment declares (`notifyAdditionalUserPoolIds`, the same knob and the same
 * trust boundary the notification fan-out uses). An issuer outside this set is not queried.
 */
const TRUSTED_NAME_POOL_IDS = new Set(
  [USER_POOL_ID, ...(process.env.NOTIFY_ALLOWED_POOL_IDS || '').split(',')]
    .map((s) => s.trim())
    .filter(Boolean),
);
// Per-classification deployment (ADR-011 reversal / bot-layer isolation): when this
// handler is deployed per-classification, CLASSIFICATION is set statically and BOT_ARN_PARAM points
// at that classification's bot key. With CLASSIFICATION set the handler skips channel-classification
// discovery (it IS the classification) and acts as the per-classification bot — no shared
// router, no shared bot. Unset = legacy shared-router behavior (back-compat).
const STATIC_CLASSIFICATION = process.env.CLASSIFICATION || '';

const BASIC_ASYNC_PROCESSOR_ARN = process.env.BASIC_ASYNC_PROCESSOR_ARN || '';
const STANDARD_ASYNC_PROCESSOR_ARN = process.env.STANDARD_ASYNC_PROCESSOR_ARN || '';
const PREMIUM_ASYNC_PROCESSOR_ARN = process.env.PREMIUM_ASYNC_PROCESSOR_ARN || '';

// Live drift detection — feature-flagged via ENABLE_LIVE_DRIFT (set by the
// auroraDriftWiring helper in Aurora mode). The flow itself lives in
// `lib/live-drift-flow.ts` (shared; this router runs on every classification so all
// classifications run it). The RAG-retrieval gate below still reads ENABLE_LIVE_DRIFT directly
// because RAG piggybacks on the same Aurora hookup.

const lambdaClient = new LambdaClient({ region: AWS_REGION });
const ssmClient = new SSMClient({ region: AWS_REGION });
const chimeClient = new ChimeSDKMessagingClient({ region: AWS_REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: AWS_REGION });

// ============================================================
// Caches (persist across warm invocations)
// ============================================================

let cachedBotArn: string | null = null;
const channelClassificationCache = new Map<string, string>();
function minRank(a: string, b: string): string {
  return profiles.min(a, b);
}

async function getBotArn(): Promise<string> {
  if (cachedBotArn) return cachedBotArn;
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: BOT_ARN_PARAM }));
    cachedBotArn = resp.Parameter?.Value || '';
  } catch {
    cachedBotArn = '';
  }
  return cachedBotArn;
}

/**
 * SSM getter passed to loadIntakeConfig so a deployment can supply the
 * onboarding intake schema via `ONBOARDING_INTAKE_PARAM` (an inline
 * `ONBOARDING_INTAKE` env is read first and needs no SSM). Returns undefined on
 * any failure so onboarding stays disabled rather than erroring the turn.
 */
async function getSsmParam(name: string): Promise<string | undefined> {
  return (await readSsmParam(name)).value;
}

/**
 * The same read, with the failure REASON preserved.
 *
 * `getSsmParam` collapses every outcome to `undefined`, which makes an absent parameter, a malformed
 * one and a REVOKED `ssm:GetParameter` grant indistinguishable to the caller. For the onboarding
 * schema that is fine (all three mean "stay disabled"), but for the welcome it is the difference
 * between a legitimate un-configured deployment and a silent misconfiguration serving degraded copy.
 * `ParameterNotFound` is reported separately from every other error for exactly that reason.
 */
async function readSsmParam(
  name: string,
): Promise<{ value: string | undefined; notFound: boolean; error: string | null }> {
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: name }));
    return { value: resp.Parameter?.Value || undefined, notFound: false, error: null };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const notFound = e?.name === 'ParameterNotFound';
    return { value: undefined, notFound, error: e?.name || e?.message || 'unknown error' };
  }
}

async function resolveChannelClassification(channelArn: string, botArn: string): Promise<string> {
  // Per-classification deployment: the handler IS the classification — no discovery needed. This
  // is the LIVE topology (every classification stack sets CLASSIFICATION), so the tag read below is only
  // reached in a hypothetical single-handler multi-classification deployment.
  if (STATIC_CLASSIFICATION) return STATIC_CLASSIFICATION;
  if (channelClassificationCache.has(channelArn)) return channelClassificationCache.get(channelArn)!;
  const classification = await resolveChannelClassificationTag(channelArn);
  channelClassificationCache.set(channelArn, classification);
  return classification;
}

/**
 * The served classification keys on the channel's IMMUTABLE `classification` TAG — the same
 * signal the IAM Layer-1 boundary enforces (agent-classification-common.classificationChannelScopedAllow,
 * `aws:ResourceTag/classification`). We deliberately do NOT trust `metadata.modelTier`:
 * channel Metadata is mutable via `chime:UpdateChannel` (the owner `rename` cap), so
 * keying the served classification on it would let a channel moderator raise the classification a
 * FEDERATED user is served at (the federated path takes `userClearance = channelClassification` with no min-cap).
 * The `classification` tag cannot be changed by UpdateChannel, so it is tamper-proof.
 * Fail-closed to 'basic' when the tag is absent, invalid, or unreadable.
 */
async function resolveChannelClassificationTag(channelArn: string): Promise<string> {
  return resolveChannelClassificationTagShared(chimeClient, channelArn, '[Router]');
}

/** Pull the channel's full Metadata JSON (modelTier, topic, triggerContext,
 *  createdBy, etc.). Cached per-channel for the Lambda's warm life so the
 *  WelcomeIntent path doesn't double the Chime calls already done for
 *  classification resolution. Returns {} on error -- the caller must default. */
const channelMetaCache = new Map<string, Record<string, unknown>>();
async function resolveChannelMetadata(channelArn: string, botArn: string, forceRefresh = false): Promise<Record<string, unknown>> {
  if (!forceRefresh && channelMetaCache.has(channelArn)) return channelMetaCache.get(channelArn)!;
  try {
    const resp = await chimeClient.send(new DescribeChannelCommand({
      ChannelArn: channelArn,
      ChimeBearer: botArn,
    }));
    const meta = JSON.parse(resp.Channel?.Metadata || '{}') as Record<string, unknown>;
    channelMetaCache.set(channelArn, meta);
    return meta;
  } catch (err) {
    console.warn('[Router] Failed to read channel metadata:', err);
    channelMetaCache.set(channelArn, {});
    return {};
  }
}

/** The channel's HUMAN member ARNs (AppInstanceUser ARNs carry `/user/`; bots carry
 *  `/bot/`), read live from Chime membership — the authoritative source, not a copy in
 *  channel metadata. Cached for the Lambda's warm life. Returns [] on error. */
const humanMembersCache = new Map<string, string[]>();
async function getHumanMemberArns(channelArn: string, bearerArn: string): Promise<string[]> {
  if (humanMembersCache.has(channelArn)) return humanMembersCache.get(channelArn)!;
  try {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await chimeClient.send(new ListChannelMembershipsCommand({
        ChannelArn: channelArn,
        ChimeBearer: bearerArn,
        MaxResults: 50,
        NextToken: nextToken,
      }));
      for (const m of resp.ChannelMemberships || []) {
        const arn = m.Member?.Arn || '';
        if (arn.includes('/user/')) arns.push(arn);
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    humanMembersCache.set(channelArn, arns);
    return arns;
  } catch (err) {
    console.warn('[Router] Failed to list human members:', err);
    return [];
  }
}

/** Count of human members. Used by the WelcomeIntent path to greet gracefully: a fresh
 *  1:1 (owner only) gets a name-personalised welcome; a multi-member channel gets a
 *  generic welcome, since the system WelcomeIntent event names no joiner. */
async function countHumanMembers(channelArn: string, bearerArn: string): Promise<number> {
  return (await getHumanMemberArns(channelArn, bearerArn)).length;
}

/** The sub of the SOLE human member (a 1:1 channel's owner), read from Chime membership
 *  — the authoritative "who owns this channel", replacing the metadata `createdBy` copy.
 *  Returns '' unless there is exactly one human member (so a shared channel never
 *  personalises to the wrong person). */
async function soleHumanMemberSub(channelArn: string, bearerArn: string): Promise<string> {
  const arns = await getHumanMemberArns(channelArn, bearerArn);
  return arns.length === 1 ? (arns[0].split('/user/').pop() || '') : '';
}

/**
 * The conversation's participant SHAPE for the once-per-user onboarding gate
 * (SPEC-USER-PROFILE-AND-ONBOARDING §2).
 *
 * Read from the server-only context store, which the creating path wrote BEFORE the channel existed. That
 * ordering is what makes this answer trustworthy at `WelcomeIntent`: the assistant is added to the channel BY
 * creation (it is the acting bearer), so there is no window afterwards, and a strongly consistent read of a
 * completed write cannot miss it.
 *
 * This REPLACES a five-attempt retry loop over two eventually-consistent Chime reads. That loop existed
 * because a single read missed the creator roughly 30% of the time inside the WelcomeIntent window, and a
 * miss fell open to starting the intake - RE-ONBOARDING a user who had already completed it, which is the
 * precise defect the gate exists to prevent. There is nothing left to retry across.
 *
 * Returns null when NOTHING was recorded (a legacy channel, or a failed write), which is deliberately
 * distinct from a recorded `none`. Null means "fall back and read live membership"; `none` is a positive
 * statement that the conversation has no human members, which is the steady state for an alert-initiated
 * conversation and not a race to wait out.
 */
async function resolveParticipants(
  channelArn: string,
  bearerArn: string,
): Promise<{ ctx: ParticipantContext; source: 'pre-creation' | 'live-membership' }> {
  const recorded = await getParticipantContext(channelArn);
  if (recorded) return { ctx: recorded, source: 'pre-creation' };

  // Legacy channel: no pre-creation row. Live membership is correct for these - their welcome fired long ago,
  // so nothing is racing now.
  const arns = await getHumanMemberArns(channelArn, bearerArn);
  return {
    ctx: participantContextFor(arns.map((a) => a.split('/user/').pop() || '')),
    source: 'live-membership',
  };
}

/** Best-effort fetch of the user's display name from Cognito (custom:name
 *  → name → email-local-part → 'there'). Cached for the Lambda's warm
 *  life. Used on the paths where the SENDER is known - the onboarding intake and the
 *  first real turn's greeting - and deliberately NOT on WelcomeIntent, which fires on the
 *  assistant's own membership with no sender and would resolve a racy name. Never throws --
 *  returns 'there' on any failure so those paths keep working when Cognito permissions /
 *  network blip. */
const userNameCache = new Map<string, string>();
async function resolveUserName(userSub: string): Promise<string> {
  if (!userSub) return 'there';
  if (userNameCache.has(userSub)) return userNameCache.get(userSub)!;
  try {
    const resp = await cognitoClient.send(new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userSub,
    }));
    const attrs = (resp.UserAttributes || []).reduce<Record<string, string>>((acc, a) => {
      if (a.Name && a.Value) acc[a.Name] = a.Value;
      return acc;
    }, {});
    const name = (attrs['name'] || '').trim()
      || (attrs['given_name'] || '').trim()
      || (attrs['email'] || '').split('@')[0]
      || 'there';
    userNameCache.set(userSub, name);
    return name;
  } catch (err) {
    console.warn('[Router] Failed to resolve user name for', userSub, '— falling back to "there":', err);
    userNameCache.set(userSub, 'there');
    return 'there';
  }
}

/**
 * Display name for ONE conversation member, for the participant roster the prompt grounds on.
 *
 * Separate from `resolveUserName` because the sender is always native to this deployment's pool,
 * while a member may be federated: their AppInstanceUser id is a one-way hash of (iss, sub), so the
 * only way to reach their record is the RAW sub in their own IdP's pool, which the caller supplies as
 * a hint. The pool is checked against the trusted set first, so a tampered `iss` cannot steer a
 * lookup at an unintended pool — the same gate `resolvePoolForTarget` applies on the delivery path.
 *
 * Returns undefined rather than a placeholder: an unresolved member still belongs in the roster (they
 * ARE in the conversation), and a name of 'there' or 'Member' rendered into the system prompt would
 * be the assistant stating something about a person that nobody told it.
 *
 * Cached per warm container, keyed by the id membership reports, so a multi-member conversation costs
 * its Cognito calls once and not once per turn.
 */
const memberNameCache = new Map<string, string | undefined>();
async function resolveMemberName(
  memberSub: string,
  hint?: { iss: string; rawSub: string },
): Promise<string | undefined> {
  if (!memberSub) return undefined;
  if (memberNameCache.has(memberSub)) return memberNameCache.get(memberSub);

  let poolId = USER_POOL_ID;
  let username = memberSub;
  if (hint?.iss) {
    const issuerPool = poolIdFromIssuer(hint.iss);
    // A non-Cognito issuer (Google, Okta, …) cannot be read with AdminGetUser at all, and an
    // untrusted one must not be. Either way the member keeps their place in the roster, unnamed.
    if (!issuerPool || !TRUSTED_NAME_POOL_IDS.has(issuerPool)) {
      memberNameCache.set(memberSub, undefined);
      return undefined;
    }
    poolId = issuerPool;
    username = hint.rawSub;
  }
  if (!poolId) {
    memberNameCache.set(memberSub, undefined);
    return undefined;
  }

  try {
    const resp = await cognitoClient.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }));
    const attrs = (resp.UserAttributes || []).reduce<Record<string, string>>((acc, a) => {
      if (a.Name && a.Value) acc[a.Name] = a.Value;
      return acc;
    }, {});
    const name = (attrs['name'] || '').trim()
      || [attrs['given_name'], attrs['family_name']].filter(Boolean).join(' ').trim()
      || (attrs['email'] || '').split('@')[0]
      || undefined;
    memberNameCache.set(memberSub, name);
    return name;
  } catch (err) {
    console.warn('[Router] could not resolve a member name; grounding that member unnamed:', err);
    memberNameCache.set(memberSub, undefined);
    return undefined;
  }
}

// Welcome orientation is CONFIG-DRIVEN (SPEC: config not code). A deployment may point
// ASSISTANT_WELCOME_PARAM at an SSM param holding per-assistant orientation JSON (company, access
// blurb, example prompts, platform note) that the demo seeds; absent it, the welcome is the generic
// platform greeting. Hydrated once per container (the welcome path stays instant) — a fetch failure
// falls back to generic rather than erroring the greeting.
const WELCOME_PARAM = process.env.ASSISTANT_WELCOME_PARAM || '';
// Cache only a SUCCESSFUL load — never pin an absent/null result, so a welcome that fires before the
// param is written doesn't lock the container into the generic greeting for its whole lifetime.
let welcomeOrientationCache: WelcomeOrientation | null = null;

interface WelcomeOrientationLoad {
  orientation: WelcomeOrientation | null;
  /** True when this deployment declares a welcome parameter, so config was EXPECTED to be there. */
  expected: boolean;
  /** Everything wrong with the configured value: read failures plus per-field parse rejections. */
  issues: string[];
}

async function loadWelcomeOrientation(): Promise<WelcomeOrientationLoad> {
  if (welcomeOrientationCache) return { orientation: welcomeOrientationCache, expected: true, issues: [] };
  // No parameter declared at all: the platform default. Not a misconfiguration.
  if (!WELCOME_PARAM) return { orientation: null, expected: false, issues: [] };

  const read = await readSsmParam(WELCOME_PARAM);
  if (read.notFound) {
    // DECLARED BUT NEVER SEEDED - the ordinary state of any deployment that has not run the demo
    // seeder, which is the only thing that writes this parameter. The stack always sets the env var,
    // so "the deployment names a parameter" says nothing about whether an operator chose to configure
    // one. Treating that as a config defect made every WelcomeIntent on a stock deployment log an
    // error and emit `welcome_orientation_unusable` - contradicting this module's own contract that
    // un-configured deployments are unaffected, turning the alerting metric into permanent noise, and
    // tripping the e2e handler-error gate. Same treatment as a blank value: serve the generic welcome.
    return { orientation: null, expected: false, issues: [] };
  }
  if (read.error) {
    // A DENIED read is the dangerous one, and is still a defect: it looks exactly like "not
    // configured" at runtime, and the stack DOES grant this parameter, so a denial means the grant or
    // the parameter name has drifted.
    return {
      orientation: null,
      expected: true,
      issues: [`${WELCOME_PARAM} could not be read (${read.error})`],
    };
  }

  const parsed = parseWelcomeOrientationDetailed(read.value);
  if (parsed.orientation) welcomeOrientationCache = parsed.orientation;
  return { orientation: parsed.orientation, expected: true, issues: parsed.issues };
}

function envAsyncProcessorArn(classification: string): string {
  switch (classification) {
    case 'premium': return PREMIUM_ASYNC_PROCESSOR_ARN;
    case 'standard': return STANDARD_ASYNC_PROCESSOR_ARN;
    default: return BASIC_ASYNC_PROCESSOR_ARN;
  }
}

// Resolved classification → processor ARN (only SSM hits are cached, so once a classification
// resolves to its per-classification processor it stays cached for the life of the warm
// container; a classification without a published SSM param re-checks SSM each turn and
// thus picks up its AgentEchelonClassification-* processor the moment that stack is
// deployed — no router redeploy).
const processorArnCache = new Map<string, string>();

/**
 * Resolve the classification's async-processor ARN, preferring the per-classification stack's
 * SSM-published value (/agent-echelon/assistant/{classification}/processor-arn) and falling
 * back to the *_ASYNC_PROCESSOR_ARN env var. A classification routes to its
 * AgentEchelonClassification-* processor as soon as that stack publishes its SSM param.
 */
async function resolveAsyncProcessorArn(classification: string): Promise<string> {
  const cached = processorArnCache.get(classification);
  if (cached) return cached;

  const fromSsm = await getSsmValue(`${SSM_ROOT}/assistant/${classification}/processor-arn`);
  if (fromSsm) {
    processorArnCache.set(classification, fromSsm);
    return fromSsm;
  }
  return envAsyncProcessorArn(classification);
}

// ============================================================
// Lex types
// ============================================================

interface LexEvent {
  inputTranscript?: string;
  /** Lex session identifier. Stable across a retried fulfillment of the same turn (ADR-022). */
  sessionId?: string;
  sessionState: {
    intent: { name: string; state?: string };
    sessionAttributes?: Record<string, string>;
  };
  requestAttributes?: Record<string, string>;
}

interface LexResponse {
  sessionState: {
    dialogAction: { type: string };
    intent: { name: string; state: string };
    sessionAttributes?: Record<string, string>;
  };
  messages: Array<{ contentType: string; content: string }>;
}

/**
 * Fulfil the intent and show the user nothing.
 *
 * NO LONGER THE DUPLICATE-FULFILLMENT PATH. A duplicate now replays the SAME placeholder rather than
 * going silent, because silencing it drops the turn: Chime materialises one message per turn from the
 * LAST fulfillment response, so the attempt this used to silence is frequently the only one the user
 * would have seen. See the claim check in `handleAgentRequest` for the traced failure.
 *
 * Retained because an empty envelope is still a legitimate Lex reply for a handler that is a formality
 * rather than a reply path (`battle-alt-slot-handler`), and because the client and the e2e capture
 * must both keep tolerating one: envelopes already written to channel history do not disappear.
 *
 * An EMPTY ARRAY, not an absent field. Chime posts the Lex envelope either way, so something lands in
 * the channel regardless; the question is only whether the client recognises it. `chimeService`
 * suppresses a Lex message whose `Messages` is present AND empty, so omitting the field would leave
 * `parsed.Messages` undefined, fall through that guard, and render the raw envelope to the user.
 */
export function formatLexSilentResponse(event: LexEvent): LexResponse {
  return {
    sessionState: {
      dialogAction: { type: 'Close' },
      intent: { name: event.sessionState.intent.name, state: 'Fulfilled' },
      sessionAttributes: { ...event.sessionState.sessionAttributes },
    },
    messages: [],
  };
}

function formatLexResponse(
  event: LexEvent,
  messages: Array<{ contentType: string; content: string }>,
  sessionAttributes?: Record<string, string>,
): LexResponse {
  return {
    sessionState: {
      dialogAction: { type: 'Close' },
      intent: {
        name: event.sessionState.intent.name,
        state: 'Fulfilled',
      },
      sessionAttributes: {
        ...event.sessionState.sessionAttributes,
        ...sessionAttributes,
      },
    },
    messages,
  };
}

function extractUserSub(event: LexEvent): string {
  const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
  return senderArn.split('/user/').pop() || '';
}

// ============================================================
// Non-Lex entry (the Lex bypass)
// ============================================================

/**
 * A turn that did not arrive through Lex.
 *
 * `@all` and `/battle` are not Amazon Chime SDK mentions, so Amazon Chime SDK will not route them to
 * Lex and the channel flow has to decide that a turn happens at all. That decision - WHO responds -
 * is the flow's job and only the flow can make it: it is the one component that sees every message
 * with a stable `MessageId` (ADR-022).
 *
 * Everything after that decision is an ordinary turn, and this is how a bypass asks for one.
 * Bypassing Lex is the ONLY sanctioned difference (MESSAGE-FLOW §3.1); a bypass that re-implemented
 * classification, profile resolution or variant resolution would be a second turn path, and a second
 * turn path diverges SILENTLY - the turn still answers, so nothing errors and no test fails.
 */
export interface TurnRequest {
  channelArn: string;
  /** The human who spoke. Drives identity, grounding and the user's profile. */
  senderArn: string;
  /** Already decoded. The caller strips its own command token (`@all`, `/battle`) first. */
  userMessage: string;
  /**
   * The inbound Amazon Chime SDK `MessageId` of the user message this turn answers.
   *
   * COORDINATION CONTEXT, not turn logic: it lets the turn's correlation id be DECLARED rather than
   * derived. The Lex path cannot supply it - Amazon Chime SDK sends Lex exactly three request
   * attributes and the message id is not among them - so that path derives the id from a time bucket
   * (`turnCorrelationId`). The flow sees a stable id on every message, so a redelivery of the same
   * `@all` re-derives the SAME correlation id and collapses instead of answering twice. Dropping it
   * would put that dedup on a 90-second window it does not need.
   */
  userMessageId?: string;
  /**
   * Attachment-in (image or document) carried on the user's message.
   *
   * The flow reads it from the message Metadata, which Lex never sees, so this is the only way it can
   * reach the turn. Forwarded to the async processor unchanged.
   */
  attachment?: MessageAttachment;
  /**
   * Which bot identity this turn answers as.
   *
   * The handler otherwise resolves exactly ONE identity, from its per-classification SSM parameter. A
   * duel has two sides, so the caller has to say which. VALIDATED against the published alt-slot
   * roster plus this classification's own bot (`isSanctionedBattleBot`) - an unchecked
   * caller-supplied identity would let anything able to invoke this handler post as any bot in the
   * app instance.
   *
   * Absent ⇒ the classification's own bot, exactly as on the Lex path.
   */
  botArn?: string;
  /**
   * The turn's correlation id, DECLARED by the caller.
   *
   * `/battle` needs this: the battle state row keys on it and must exist before dispatch so the
   * orchestrator can see the side in flight, which means the caller mints it. `@all` does not - it
   * hands `userMessageId` instead and lets the handler derive.
   */
  correlationId?: string;
  /**
   * Battle coordination context: which duel, which round, which side, which rival, and for round 2
   * the rival's reply. Everything a side cannot derive about itself.
   *
   * Its presence is what makes this a battle turn. It carries NO turn decisions - not the intent, not
   * the delivery option, not the variant - those are resolved here, on the one turn path.
   */
  battleContext?: BattleTurnContext;
  /**
   * An EXISTING message this turn's answer should land on, instead of the turn posting a new one.
   *
   * Coordination context, not turn logic. Exactly one caller has it: a battle continuation, where the
   * side already has a visible "waiting" message from when it asked its clarifying question. Updating
   * that message in place is what makes the cleared `<!--battlewaiting-->` marker the frontend's
   * "waiting ended" signal; posting a fresh placeholder instead would strand the old one.
   *
   * Present ⇒ the turn does NOT post its own acknowledgment (ADR-025) and hands this id to the
   * processor. Absent ⇒ ordinary behaviour.
   *
   * **NO PRODUCER SINCE [ADR-029].** The battle continuation was the only caller; it now posts its own
   * placeholder like every other turn and passes `battleContext.clearWaitingMarkerMessageId` instead,
   * which names a message to un-mark rather than one to answer onto. This field, the
   * `BYPASS_PLACEHOLDER_ATTR` silence branch below and the processor's handed-id resolution step are
   * therefore unreachable, and are kept only until the removal is done deliberately with its tests
   *. Do not add a caller: answering onto a message that already exists is what put a
   * finished answer above the question that produced it.
   */
  placeholderMessageId?: string;
  /**
   * What caused this turn. `user` (the default) means a person spoke; `orchestrator` means the system
   * did - a round-2 rebuttal answers a rival, not a person.
   *
   * Load-bearing for measurement, not just bookkeeping: a system-triggered response has no user
   * message to measure from, so its TTFF is UNDEFINED and must be null rather than zero
   * (LATENCY-TARGETS). It also keeps rebuttals out of the TTFF average, where they would otherwise
   * drag it toward a number nobody experienced.
   */
  trigger?: 'user' | 'orchestrator';
  /**
   * THIS TURN ARRIVED BY HANDOVER, and names the assistant that passed it on (a principal id).
   *
   * Routing follows the TASK, never who the message was addressed to (owner, 2026-08-14). A person can
   * answer work in the channel without addressing anyone, or address the wrong assistant - the same
   * case either way - so the assistant that RECEIVES the message is not necessarily the one whose
   * chain it answers. The receiver resolves the task, finds an `assistantId` that is not its own, and
   * hands the turn to that assistant rather than answering work it does not own or dropping it.
   *
   * Two things follow from its presence, and both are why it is a field rather than a log line:
   *   - The receiving assistant already gave the person their receipt (with copy of its own, saying
   *     who the work went to), so this turn owes only the answer. Without that, one message earns two
   *     acknowledgements, the second contradicting the first about who is acting.
   *   - A handed-over turn never hands over again. The owning assistant owns the chain by
   *     construction, so a second hop should be impossible, and "should be impossible" is not a loop
   *     bound. Only a turn WITHOUT this field may create one, so the chain is bounded at one hop
   *     structurally rather than by a counter each side declares for itself - which is the failure
   *     ADR-023's hop cap has, measured on the deployment.
   */
  handedOverFrom?: string;
}

/**
 * The battle coordination context a caller supplies. Mirrors the worker's `BattleContextPayload`
 * minus every field the TURN resolves (variant, display names, image model), which is the point:
 * the caller says which duel and which side, the turn decides what that side IS.
 */
export interface BattleTurnContext {
  battleId: string;
  round: 1 | 2;
  totalRounds: 2;
  selfBotArn: string;
  rivalBotArn: string;
  /** The treatment slot, so the turn can tell which side of the experiment it is. */
  altSlotArn: string;
  /** Round 2 only: the rival's round-1 reply, and its message id. */
  rivalReply?: string;
  rivalReplyMsgId?: string;
  /** Round 2 only: the rival never finished, so the rebuttal must say so rather than invent one. */
  rivalDidNotFinish?: boolean;
  /**
   * A resume only: the message holding this side's clarifying QUESTION, whose `<!--battlewaiting-->`
   * marker this turn clears (ADR-029).
   *
   * NOT a placeholder id, and named so it cannot be mistaken for one. This turn does not answer onto
   * that message - it posts its own placeholder like every other turn. It only ends the frontend's
   * waiting affordance while leaving the question text in the transcript.
   */
  clearWaitingMarkerMessageId?: string;
  originatingMessageId?: string;
  imageAttachment?: { fileKey: string; contentType: string };
}

/**
 * What a bypass gets back: an ordinary `LexResponse`, the SAME shape Lex receives.
 *
 * `messages[0].content` is the placeholder the caller must post, carrying its `<!--corr:{id}-->`
 * marker. That the caller posts it is the one legitimate asymmetry between the two paths and it is
 * unavoidable: Lex materialises a message from the fulfillment return, and a bypass has no Lex return
 * to materialise, so somebody has to call `SendChannelMessage`. It is also harmless to measurement -
 * TTFF is placeholder minus user message on the Amazon Chime SDK clock, which does not care which
 * component wrote it (LATENCY-TARGETS).
 *
 * An EMPTY `messages` array means POST NOTHING - a silent turn, or a duplicate fulfillment that lost
 * its claim (ADR-022). The caller must honour it rather than inventing a bubble.
 *
 * Exported so the channel flow consumes the real return type rather than a hand-copied shape that can
 * drift from it.
 */
export type { LexResponse };

/**
 * The bypass invocation payload.
 *
 * The channel flow is a SEPARATE Lambda, so it reaches the turn the same way it reaches the async
 * processor: by invoking this function, not by importing it. Running the router's code inside the
 * flow would put the turn on the flow's IAM role - which holds no Bedrock or SSM grants - and would
 * ship a second copy of the router in a second bundle, which is the duplication this work removes.
 *
 * The reply is an ordinary `LexResponse`. The caller posts `messages[0].content` as the placeholder;
 * an EMPTY `messages` array means "post nothing", which is how a duplicate fulfillment that lost its
 * correlation claim reports itself (ADR-022), and the caller must honour it rather than inventing a
 * bubble.
 */
export interface BypassTurnEvent {
  aeTurn: TurnRequest;
}

/** Marks the invocation as the flow's, so guards that exist to keep LEX quiet do not fire here. */
const FLOW_ENTRY_ATTR = 'AE.entry';
const FLOW_ENTRY_VALUE = 'channel-flow';
/** The inbound message id, when the caller can declare it. See `TurnRequest.userMessageId`. */
const BYPASS_MESSAGE_ID_ATTR = 'AE.message.id';
/** The turn's attachment, JSON-encoded. See `TurnRequest.attachment`. */
const BYPASS_ATTACHMENT_ATTR = 'AE.attachment';
/** Which bot identity to answer as. See `TurnRequest.botArn`. */
const BYPASS_BOT_ARN_ATTR = 'AE.bot.arn';
/** A caller-declared correlation id. See `TurnRequest.correlationId`. */
const BYPASS_CORRELATION_ATTR = 'AE.corr';
/** Battle coordination context, JSON-encoded. See `TurnRequest.battleContext`. */
const BYPASS_BATTLE_ATTR = 'AE.battle';
/** What caused the turn. See `TurnRequest.trigger`. */
const BYPASS_TRIGGER_ATTR = 'AE.trigger';
/** An existing message to answer onto. See `TurnRequest.placeholderMessageId`. */
const BYPASS_PLACEHOLDER_ATTR = 'AE.placeholder.id';
/** The assistant that handed this turn over. See `TurnRequest.handedOverFrom`. */
const BYPASS_HANDOVER_ATTR = 'AE.handover.from';

/**
 * Normalize a bypass payload into the event shape the turn already runs on.
 *
 * `FallbackIntent` is the intent every real user turn arrives on. `WelcomeIntent` means "the
 * assistant was just added" and carries no sender or transcript, so a bypass must never claim it.
 *
 * The extra context rides `requestAttributes` rather than a parallel field on the event, because that
 * is already how per-turn context reaches this handler - `CHIME.channel.arn` and `CHIME.sender.arn`
 * arrive the same way. One event type, one set of accessors, and no branch below this function that
 * has to ask which entry it came from.
 */
function bypassToLexEvent(req: TurnRequest): LexEvent {
  return {
    // The handler decodes the transcript (Amazon Chime SDK delivers it percent-encoded), so encode
    // here to keep the round trip lossless. Passing raw text would corrupt any message containing a
    // literal '%' and throw outright on a malformed escape.
    inputTranscript: encodeURIComponent(req.userMessage),
    sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
    requestAttributes: {
      'CHIME.channel.arn': req.channelArn,
      'CHIME.sender.arn': req.senderArn,
      [FLOW_ENTRY_ATTR]: FLOW_ENTRY_VALUE,
      ...(req.userMessageId && { [BYPASS_MESSAGE_ID_ATTR]: req.userMessageId }),
      ...(req.attachment && { [BYPASS_ATTACHMENT_ATTR]: JSON.stringify(req.attachment) }),
      ...(req.botArn && { [BYPASS_BOT_ARN_ATTR]: req.botArn }),
      ...(req.correlationId && { [BYPASS_CORRELATION_ATTR]: req.correlationId }),
      ...(req.battleContext && { [BYPASS_BATTLE_ATTR]: JSON.stringify(req.battleContext) }),
      ...(req.trigger && { [BYPASS_TRIGGER_ATTR]: req.trigger }),
      ...(req.placeholderMessageId && { [BYPASS_PLACEHOLDER_ATTR]: req.placeholderMessageId }),
      ...(req.handedOverFrom && { [BYPASS_HANDOVER_ATTR]: req.handedOverFrom }),
    },
  };
}

/**
 * The battle coordination context, or undefined on an ordinary turn.
 *
 * Malformed JSON yields undefined, which degrades the turn to an ordinary one rather than dropping
 * it. That is the safe direction here: an answer without duel framing is recoverable; silence is not.
 */
function bypassBattleContext(event: LexEvent): BattleTurnContext | undefined {
  const raw = event.requestAttributes?.[BYPASS_BATTLE_ATTR];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as BattleTurnContext;
    return parsed && typeof parsed.battleId === 'string' && parsed.battleId ? parsed : undefined;
  } catch {
    console.warn('[Router] battle context is not valid JSON; running as an ordinary turn');
    return undefined;
  }
}

/** True when the channel flow invoked this turn rather than Lex. */
function isFlowEntry(event: LexEvent): boolean {
  return event.requestAttributes?.[FLOW_ENTRY_ATTR] === FLOW_ENTRY_VALUE;
}

/**
 * This turn answered a chain a DUEL SIDE owns, so take that side out of `WAITING_FOR_USER`.
 *
 * SEPARATE FROM WHICH LOOKUP FOUND THE CHAIN, and that is the whole reason it is a function. It used
 * to live inside the assistant's-own-chain branch, which was right when a duel side's chain was owned
 * by the assistant. Under the ownership split a chain that starts in a waiting state (`awaits`) is held by
 * the PERSON from its first moment, so the person-owed lookup finds it first and the assistant's branch
 * never runs - and the resume went with it. The task advanced, the battle row stayed waiting, round 2
 * stayed suspended, and nothing errored: the person's answer was accepted and the duel simply never
 * finished. Resuming a side is a consequence of the chain being answered, not of where it was found.
 *
 * Best-effort throughout: a battle-state failure must not cost the person their answer. Returns whether
 * a side was actually taken out of the waiting state.
 */
async function resumeDuelSideIfWaiting(
  channelArn: string,
  botArn: string,
): Promise<BattleTurnContext | null> {
  try {
    const duel = await resolveActiveBattle(channelArn);
    if (!duel?.battleId) return null;
    const rows = await readBattleRows(duel.battleId);
    const waiting = rows.some((r) => r.botArn === botArn && r.state === 'WAITING_FOR_USER');
    if (!waiting) return null;
    // No correlation id passed: this turn's is minted later, and the row's own is the one the
    // orchestrator has been tracking this side by. Leave it alone.
    const resumed = await resumeBotFromWaiting({ battleId: duel.battleId, botArn });
    console.log('[Router] duel side resumed from WAITING_FOR_USER', { battleId: duel.battleId, resumed });
    if (!resumed) return null;
    // THE RESUMED TURN IS A BATTLE TURN, and it must SAY SO. This used to return a boolean: the row
    // flipped to INVOKED but the worker dispatched with no battleContext, and every terminal write
    // in the processor sits inside `if (event.battleContext)` - so the side could never reach
    // COMPLETED, allBotsTerminal never became true, and the duel silently stranded to TTL on the
    // path a task-shaped duel actually takes. The context is synthesized from the same state the
    // orchestrator tracks: round 1 (WAITING_FOR_USER exists only there), the rival from the duel's
    // own rows, the treatment slot from the channel's battle config.
    const cfg = await loadChannelBattleConfig(channelArn);
    const rivalBotArn = rows.find((r) => r.botArn !== botArn)?.botArn ?? '';
    return {
      battleId: duel.battleId,
      round: 1,
      totalRounds: 2,
      selfBotArn: botArn,
      rivalBotArn,
      altSlotArn: cfg?.altBotSlotArn ?? '',
    };
  } catch (err) {
    console.warn('[Router] could not resume the duel side (answer still proceeds):', err);
    return null;
  }
}

/** The assistant that handed this turn over, or undefined on a turn that arrived directly. */
function handedOverFrom(event: LexEvent): string | undefined {
  return event.requestAttributes?.[BYPASS_HANDOVER_ATTR] || undefined;
}

/**
 * The id of the message this turn is answering, from whichever entry it arrived on.
 *
 * Amazon Chime SDK stamps `CHIME.message.id` on the Lex path; a bypass caller declares the same fact as
 * `AE.message.id`, because it has no Chime attributes to stamp. ONE accessor, because reading only the
 * Lex form silently yields `undefined` on every bypass - which does not fail, it just records a task
 * response with no message behind it (ADR-024 D5), and the gap only shows up much later as a chain
 * nobody can trace back to what answered it.
 */
function inboundMessageId(event: LexEvent): string | undefined {
  return event.requestAttributes?.['CHIME.message.id']
    || event.requestAttributes?.[BYPASS_MESSAGE_ID_ATTR]
    || undefined;
}

/**
 * The receipt for a message that answered work belonging to a DIFFERENT assistant (rule 3).
 *
 * Its own copy, deliberately. The ordinary receipt says "picking that back up", which would be a lie
 * here - this assistant is not picking anything up, it is standing aside - and a person who is told
 * their answer was received but then watches a different assistant reply has no way to tell a handover
 * from a bug.
 */
function handoverAcknowledgement(owningAssistantName: string): string {
  return `Thanks - that answers work ${owningAssistantName} is handling, so I have passed it along. `
    + 'Their reply will follow in the conversation.';
}

/**
 * What to CALL the assistant the work went to, in copy a person reads.
 *
 * Its principal id is not it. `AltSlot0` is a slot in a pool, and in a duel the name in the channel is
 * the variant's ("Atlas") - so printing the id would name something the person has never seen, in a
 * message whose only job is to tell them where their answer went.
 *
 * Best-effort, and the fallback is deliberately vague rather than precise-and-wrong: the owning
 * assistant's reply arrives in the conversation moments later under its own name, so a receipt that
 * says "another assistant here" costs a little and a receipt that says `AltSlot0` costs trust.
 */
async function owningAssistantDisplayName(owningBotArn: string): Promise<string> {
  try {
    const variant = await resolveBattleVariantBySlotArn(owningBotArn);
    if (variant?.displayName) return variant.displayName;
  } catch (err) {
    console.warn('[Router] could not resolve the owning assistant\'s display name:', err);
  }
  return 'another assistant here';
}

/**
 * A person's message answers work a DIFFERENT assistant owns, so give it to that assistant.
 *
 * ROUTING FOLLOWS THE TASK, NEVER THE TARGET (owner, 2026-08-14). Whether the person addressed nobody
 * or addressed the wrong assistant is the same case, because targeting is a DELIVERY concern the client
 * already settled at send - it says who sees the message, not what the message is about. What it is
 * about is answerable from the task alone: the chain names its `assistantId`, and that assistant is the
 * one that can act on it.
 *
 * The transport is the handler bypass, the same seam the round-2 dispatch and the alt-slot delegation
 * already run on. It is not a message from one assistant to another, and it cannot be: ADR-023 measured
 * that Amazon Chime SDK does not deliver a bot-authored message to another bot's Lex (bot to bot, 0
 * invocations; the identical user to bot control, 1), so a handover sent as a message would silently
 * reach nobody. When ADR-023's B-proxy identities land this can move onto them; until then this is the
 * only route that arrives.
 *
 * IDENTITY IS VALIDATED, NOT ASSUMED. The owning bot's ARN is reconstructed from the task's
 * `assistantId` against this turn's own app instance, then checked with `isSanctionedBattleBot` - the
 * same gate that stops a caller-supplied identity becoming an impersonation seam - so a task carrying a
 * junk or foreign `assistantId` cannot make this handler invoke a turn as an arbitrary bot.
 *
 * Returns TRUE when the turn was handed over and this assistant owes nothing further. FALSE means it
 * could not be handed over, and the caller must answer the message as an ordinary turn: dropping it
 * would leave a person who answered a question watching nothing happen, which is the failure this whole
 * path exists to remove.
 */
async function handOverToOwningAssistant(args: {
  task: UserTask;
  event: LexEvent;
  channelArn: string;
  senderArn: string;
  selfBotArn: string;
  classificationBotArn: string;
}): Promise<boolean> {
  const { task, event, channelArn, senderArn, selfBotArn, classificationBotArn } = args;
  const owningAssistantId = task.assistantId;
  const selfAssistantId = principalIdFromArn(selfBotArn);
  if (!owningAssistantId || owningAssistantId === selfAssistantId) return false;

  // The owning bot lives in the SAME app instance as this one, so its ARN is this bot's with the
  // principal swapped. Derived rather than stored: a second copy of an ARN is a second thing that can
  // disagree with the wiring it describes, and the sanction check below is what makes deriving it safe.
  const owningBotArn = `${selfBotArn.substring(0, selfBotArn.lastIndexOf('/') + 1)}${owningAssistantId}`;
  if (!(await isSanctionedBattleBot(owningBotArn, classificationBotArn, ssmClient))) {
    console.error('[Router][SecurityEvent] a task names an assistant this deployment does not sanction; not handing over', {
      taskId: task.taskId, owningAssistantId, classification: STATIC_CLASSIFICATION,
    });
    return false;
  }

  const selfFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!selfFunctionName) {
    console.error('[Router] cannot hand over: this function does not know its own name', { taskId: task.taskId });
    return false;
  }

  // ONCE PER INBOUND MESSAGE, AND THE MARK RECORDS A DISPATCH THAT HAPPENED. Delivery is
  // at-least-once, and this runs ahead of the turn's own correlation claim (`fulfil-`), which cannot
  // cover it: that claim is minted per FULFILLMENT, and a redelivery of the same message is a new one.
  // Unmarked, a duplicate delivery gives the person two receipts and the owning assistant two turns on
  // one message - the visible half of the same defect the placeholder claim exists to prevent.
  //
  // TAKEN BEFORE THE DISPATCH, THE MARK CAUSED WHAT IT PREVENTED. A container that died between
  // claiming and invoking left the mark standing with no turn behind it, and the redelivery read it as
  // "the first handover stands" - so no invoke was ever issued and nobody answered the person at all.
  // The mark is therefore a record of a dispatch, written after one, and a delivery that finds no mark
  // does the work: the first delivery, or the redelivery of one that never got there.
  //
  // WHAT THAT TRADES. Two deliveries inside the dispatch window - the invoke itself - both find no
  // mark and both dispatch. Priced deliberately: a redelivery arrives seconds later rather than inside
  // a millisecond invoke, and a doubled answer is recoverable where a dropped one is not.
  //
  // Keyed on the message, so it is the same key from either entry (`inboundMessageId`). Fails OPEN
  // like every claim here: a dedup table hiccup must not swallow a person's answer.
  const inboundId = inboundMessageId(event);
  const handoverMark = inboundId ? `handover-${inboundId}` : '';
  if (handoverMark && await hasCorrelationClaim(handoverMark)) {
    console.log('[Router] this message was handed over already; the first handover stands', {
      taskId: task.taskId, messageId: inboundId,
    });
    // TRUE, not false. The handover already happened, so this delivery owes nothing - falling through
    // to answer it would put the receiving assistant's reply beside the owning assistant's.
    return true;
  }

  const aeTurn: TurnRequest = {
    channelArn,
    senderArn,
    userMessage: event.inputTranscript ? decodeURIComponent(event.inputTranscript) : '',
    botArn: owningBotArn,
    handedOverFrom: selfAssistantId,
    ...(inboundId && { userMessageId: inboundId }),
  };
  try {
    await lambdaClient.send(new InvokeCommand({
      // SELF. Every identity this handler may answer as is one `isSanctionedBattleBot` sanctioned,
      // which is by definition this classification's own bot or an alt slot - all of them served by
      // this function. A routing table keyed on the owning bot would be a second place for that fact
      // to live, and it would drift the first time a slot moved.
      FunctionName: selfFunctionName,
      // Fire and forget: this turn is finished the moment the work is somewhere it can be done, and
      // waiting would hold a Lex fulfillment open for the whole of another assistant's turn.
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTurn })),
    }));
  } catch (err) {
    console.error('[Router] handover invoke failed; answering as an ordinary turn instead:', err);
    // NOTHING WAS SAID AND NOTHING WAS MARKED, which is what makes falling back honest: the caller
    // answers this as an ordinary turn without a receipt contradicting it, and a redelivery is free to
    // attempt the handover again.
    return false;
  }

  // The dispatch stands, so record it - and let the RECORD decide who speaks. A delivery that loses
  // this claim raced one that already dispatched and posted, so it stays quiet rather than telling the
  // person a second time where their answer went.
  const speaksForTheHandover = !handoverMark || await claimCorrelation(handoverMark);

  // THE RECEIPT FOLLOWS THE DISPATCH, and it is POSTED rather than returned.
  //
  // It follows because it is a promise about something that has to be true by the time it is read.
  // Sent first, an invoke that then threw left the person told that another assistant had their answer
  // while this one answered it instead, under a name they were never given.
  //
  // It is posted rather than returned because a Lex reply inherits the INBOUND's targeting, so
  // returning this as the turn's message would make it public exactly when the person did not address
  // anyone - broadcasting to the channel that a message it never saw was passed somewhere. Targeted
  // here explicitly, which is the whole of rule 2's "the code targets it".
  //
  // Best-effort in this direction only: a person who gets the answer without the receipt has lost a
  // courtesy, so a failed post does not undo a dispatch that already stands.
  if (speaksForTheHandover) {
    try {
      await chimeClient.send(new SendChannelMessageCommand({
        ChannelArn: channelArn,
        Content: encodeURIComponent(handoverAcknowledgement(await owningAssistantDisplayName(owningBotArn))),
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: selfBotArn,
        Target: [{ MemberArn: senderArn }],
        Metadata: JSON.stringify({ botResponse: true }),
      }));
    } catch (err) {
      console.warn('[Router] could not post the handover receipt (the handover still stands):', err);
    }
  }
  console.log('[Router] handed the turn to the assistant that owns the chain', {
    taskId: task.taskId, from: selfAssistantId, to: owningAssistantId,
  });
  return true;
}

/**
 * The turn's attachment, or undefined.
 *
 * Malformed JSON yields undefined rather than throwing: an unreadable attachment must degrade to a
 * text turn, never drop the turn. Undefined on the Lex path, which never carries one.
 */
function bypassAttachment(event: LexEvent): MessageAttachment | undefined {
  const raw = event.requestAttributes?.[BYPASS_ATTACHMENT_ATTR];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as MessageAttachment;
    return parsed && typeof parsed.fileKey === 'string' && parsed.fileKey ? parsed : undefined;
  } catch {
    console.warn('[Router] bypass attachment is not valid JSON; continuing as a text turn');
    return undefined;
  }
}

// ============================================================
// Handler
// ============================================================

/**
 * THE ASSISTANT SPEAKS ITS OWN ACKNOWLEDGMENT ON A BYPASS (ADR-025).
 *
 * The turn already decides what the acknowledgment SAYS - `getQuickResponse` / `getTaskPlaceholder`,
 * resolved from the profile version this turn loaded. Before this, the words were authored here and
 * the ACT was performed elsewhere: by Amazon Chime SDK on the Lex path, by the channel flow on a
 * bypass. One profile-resolved behaviour, two routes to the channel, which is the divergence class
 * the `@all` and round-1 handoffs exist to remove.
 *
 * So on a flow entry the turn posts whatever it produced - placeholder, canned greeting, gate notice
 * or error - and returns an EMPTY `messages` array, which every bypass caller already understands as
 * "post nothing" (ADR-022). The Lex path is untouched: Chime still materialises that message from the
 * fulfillment return, because nothing else can.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, so it is not mistaken for a cleanup. It does not hand the
 * processor a `placeholderMessageId`, and holding one would buy almost nothing: the channel flow
 * learns the placeholder's id the instant it crosses the flow and writes `corr# -> MessageId`, and the
 * processor reads that mapping once at FINALIZE, after the model call, long after it has landed.
 * `pollForPlaceholderMessage` is the third fallback behind that read and does not run on an ordinary
 * turn. Handing the id over would require posting BEFORE the dispatch, which means reordering every
 * return path in this file to buy one skipped GetItem. Priced and declined; the case for this change
 * is ownership, not simplification.
 */
export const handler = async (rawEvent: LexEvent | BypassTurnEvent): Promise<LexResponse> => {
  const event: LexEvent = (rawEvent as BypassTurnEvent).aeTurn
    ? bypassToLexEvent((rawEvent as BypassTurnEvent).aeTurn)
    : (rawEvent as LexEvent);

  // The identity this turn answered as, filled in by `runTurn` once it has resolved and VALIDATED it.
  // Carried out here rather than re-resolved, so the send can never post as a bot the turn itself
  // rejected (`isSanctionedBattleBot`).
  const spoke: SpokenAs = {};
  const response = await runTurn(event, spoke);
  if (!isFlowEntry(event)) return response;

  // A caller that handed over an EXISTING message already has one on screen - a battle continuation
  // reusing the side's "waiting" message. Posting here would strand it and give the processor two
  // candidates. Return silence so nothing else posts either; the processor updates the message it was
  // told about.
  //
  // ONLY WHEN A WORKER ACTUALLY RAN. Silence is safe because something else finishes the job; if nothing
  // was dispatched, nothing will. This returned silence unconditionally, so every non-dispatching exit -
  // the catch-all "I encountered an issue" and the `!asyncProcessorArn || !channelArn` fall-through -
  // was DISCARDED on a battle continuation: nothing posted, the side's `<!--battlewaiting-->` marker
  // never cleared, and the user waited on a turn that had already failed. Posting a fresh message leaves
  // a stale waiting marker, which is worse than tidy and far better than silent.
  if (event.requestAttributes?.[BYPASS_PLACEHOLDER_ATTR] && spoke.dispatched) {
    return formatLexSilentResponse(event);
  }
  return postAsAssistant(event, response, spoke);
};

/**
 * What the turn did, reported back to the entry wrapper.
 *
 * `botArn` is filled once the turn has resolved and VALIDATED its identity, so the send can never post
 * as a bot the turn itself rejected. `dispatched` says a worker was invoked, which is what makes it safe
 * for this entry to stay quiet and let the processor finish.
 */
interface SpokenAs { botArn?: string; dispatched?: boolean }

/**
 * Post the turn's own output on a bypass, and tell the caller there is nothing left to post.
 *
 * An empty `messages` array in means a silent turn (a duplicate fulfillment that lost its correlation
 * claim), so it stays silent and nothing is invented here.
 *
 * A send failure is NOT swallowed into silence: the caller is handed the message back so it can post
 * it the old way. That keeps a Chime hiccup from turning into a turn that answered and showed nothing,
 * which is the failure mode this whole path exists to avoid.
 */
async function postAsAssistant(
  event: LexEvent,
  response: LexResponse,
  spoke: SpokenAs,
): Promise<LexResponse> {
  const content = response.messages?.[0]?.content;
  if (!content) return response;

  const channelArn = event.requestAttributes?.['CHIME.channel.arn'] || '';
  if (!channelArn || !spoke.botArn) {
    console.warn('[Router] cannot post as the assistant (no channel or unresolved identity); handing the message back', {
      hasChannel: !!channelArn, hasBot: !!spoke.botArn,
    });
    return response;
  }

  try {
    await chimeClient.send(new SendChannelMessageCommand({
      ChannelArn: channelArn,
      Content: content,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: spoke.botArn,
      // Matches what the channel flow stamped, so the frontend cannot tell which component sent it.
      // UNTARGETED, always: a bypass reply is visible to every member, and the flow does no targeting.
      Metadata: JSON.stringify({ botResponse: true }),
    }));
  } catch (err) {
    console.error('[Router] posting the assistant acknowledgment failed; handing it back to the caller', err);
    return response;
  }
  return formatLexSilentResponse(event);
}

const runTurn = async (event: LexEvent, spoke: SpokenAs): Promise<LexResponse> => {
  // ONE turn path, two entries. A bypass (@all, /battle) is normalized to the same event the Lex
  // fulfillment arrives on, so everything below this line cannot tell them apart - which is the point
  // (MESSAGE-FLOW §3.1). Bypassing Lex is the only sanctioned difference, and it ends here.
  const lexIntentName = event.sessionState?.intent?.name;
  const channelArn = event.requestAttributes?.['CHIME.channel.arn'] || '';

  console.log('[Router] Invoked', { intent: lexIntentName, hasTranscript: !!event.inputTranscript });

  // ═══════════════════════════════════════════════════════════════
  // A BYPASS TOKEN IS THE CHANNEL FLOW'S TURN, NOT OURS. Return nothing visible, BEFORE any work.
  //
  // A bypass token takes the flow's path in EVERY channel: the flow claims the turn and posts the
  // reply. One path, no member-count branch. What varies with channel size is only whether Chime ALSO
  // invokes Lex, and that is the whole defect this guard closes. `StandardMessages: AUTO` routes
  // mention-carrying messages only in a group, and neither token is a Chime CHIME.mentions value, so
  // in a group they never reach this handler. In a 1:1 AUTO routes EVERY message regardless of
  // mentions, so this handler IS invoked, and without this guard the turn is answered twice - once by
  // the flow, once by an ordinary Lex reply. Deterministic at that size, not a race.
  //
  // BOTH TOKENS, AND THAT IS THE FIX. This tested `@all` alone while the flow had two bypasses, so a
  // `/battle` in a 2-member channel was answered twice: the flow takes its `<2 bot members` fallback
  // and dispatches through the `@all` path while the message still reads `/battle`, which this guard
  // did not match. The tokens now come from `lib/flow-bypass.ts`, which BOTH sides import, so a third
  // one cannot be added to the flow alone.
  //
  // FIRST STATEMENT IN THE HANDLER, deliberately. Everything below - bot ARN, classification,
  // clearance, onboarding, the LLM classifier - is work whose result would be discarded, and the
  // classifier is a billed model call. It also keeps the guard testable without standing up all of it.
  //
  // WHY NOT A MEMBER-COUNT BRANCH IN THE FLOW. Keeping `@all` on one bypass at every channel size is
  // the point: one responder, and nothing that behaves differently as a conversation gains members.
  // The alternative leaves two different responders for one feature plus a `ListChannelMemberships`
  // call on the hot path.
  //
  // WHY NOT DENY THE MESSAGE IN THE FLOW. That would keep Lex out with no router change, but a denied
  // message is never persisted: the user's own `@all` would vanish from the channel and from the
  // assistant's history. Acceptable for a battle continuation, whose answer is deliberately private;
  // not for `@all`.
  //
  // FAILURE MODE, STATED PLAINLY. This trusts that the flow ran. If the channel flow is not associated
  // to the channel, a 1:1 `@all` is silenced here and nothing answers it. That is a broken deployment
  // rather than a normal state - the flow is associated at channel creation, before any membership -
  // and the log line below is what makes it visible.
  //
  // Matched on the UNCAPPED transcript: `capUserMessage` truncates, which could drop a trailing
  // `@all` and un-silence the very turn this exists for.
  //
  // Tested in BOTH the decoded and raw forms, exactly as the channel flow detects it. A single
  // malformed %-sequence anywhere in the message makes `decodeURIComponent` throw, and falling back to
  // the raw string would otherwise leave a percent-encoded token that defeats the match. The two sides
  // must agree on what each token means, or one of them answers and the other stays silent.
  // ═══════════════════════════════════════════════════════════════
  const rawTranscript = event.inputTranscript || '';
  let decodedTranscript = rawTranscript;
  try {
    decodedTranscript = decodeURIComponent(rawTranscript);
  } catch {
    /* malformed encoding — fall back to the raw form, which is still tested below */
  }
  // THE GUARD SILENCES THE LEX ENTRY ONLY. When the flow invokes this handler it has already decided
  // that this turn happens and that this assistant answers it, so silencing there would mean nothing
  // answers at all. The invariant is unchanged and is still ONE responder: exactly one entry runs the
  // turn, and in a 1:1 - where AUTO routes every message to Lex regardless of mentions - the Lex entry
  // is the one that stands down.
  const bypassToken = flowBypassToken(rawTranscript, decodedTranscript);
  if (!isFlowEntry(event) && bypassToken) {
    // THE COMPLEMENT OF THE FLOW'S BRANCH, and it must stay exactly that. The flow takes the bypass
    // only above 1:1, so standing down at every size would leave a 1:1 `@all` answered by nobody.
    // Both sides read the SAME helper for that reason (lib/channel-size.ts), the way both already
    // share `flow-bypass.ts` for the token itself.
    //
    // The read is paid only on a turn that carries a bypass token, never on the ordinary path - which
    // is the cost the previous comment here objected to, now bounded.
    // Bearer for the membership read: the classification bot this handler serves. `getBotArn()` is
    // SSM-backed and memoized per container, so this adds no per-turn parameter fetch.
    // THE COMPLEMENT IS PER TOKEN, because the flow's behaviour is per token.
    //
    // `/battle` is handled by the flow at EVERY channel size: it fans out when there are two bots, and
    // below that it falls back to `handleMentionedMessage` and answers anyway. So there is no size at
    // which this entry should also answer, and reading the size here would be both wasted and wrong -
    // in a 2-member channel the old code fell through and produced a SECOND answer with its own
    // placeholder, which is exactly the duplicate `lib/flow-bypass.ts` was written to remove, returning
    // on the other token.
    //
    // `@all` is the one with a size branch, because the flow stands aside in a 1:1 (Chime AUTO routes
    // every message there, so the Lex entry runs regardless and is the better responder).
    if (bypassToken === '/battle') {
      console.log('[Router] /battle belongs to the channel flow at every size; returning no visible message', {
        intent: lexIntentName,
      });
      return formatLexSilentResponse(event);
    }

    let size = await resolveChannelSize(chimeClient, channelArn, await getBotArn());
    // UNKNOWN IS NOT "GROUP", and it must not be treated as one SILENTLY. The catch in
    // resolveChannelSize returns isOneToOne:false for an unreadable count - the right fail direction
    // for the FLOW (it dispatches) but ambiguous here: silence in a true 1:1 leaves the turn
    // answered by NOBODY. Retry once, because the usual cause is a transient throttle. If the count
    // is STILL unreadable, silence remains the chosen direction - one-responder is the owner-decided
    // invariant, and answering here in a real group would produce the second answer that rule
    // exists to forbid - but the failure is now LOUD (warn + the reason in the log) instead of
    // masquerading as a considered "this is a group" decision.
    if (size.unknown) {
      size = await resolveChannelSize(chimeClient, channelArn, await getBotArn());
    }
    if (size.unknown) {
      console.warn('[Router] channel size unreadable twice; standing down to preserve one-responder. '
        + 'If this channel is a 1:1, this turn was answered by nobody - the size read is the defect to chase.', {
        intent: lexIntentName, token: bypassToken,
      });
      return formatLexSilentResponse(event);
    }
    if (!size.isOneToOne) {
      console.log('[Router] bypass token belongs to the channel flow; returning no visible message', {
        intent: lexIntentName,
        token: bypassToken,
        memberCount: size.memberCount,
      });
      return formatLexSilentResponse(event);
    }
    console.log('[Router] bypass token in a 1:1 — the flow stood aside, so this entry answers', {
      intent: lexIntentName,
      token: bypassToken,
      memberCount: size.memberCount,
    });
    // Fall through and run the turn as an ordinary Lex reply: one placeholder, one correlation id,
    // one answer, resolved by the standard placeholder-then-update path.
    //
    // NORMALIZED TO THE EVENT THE BYPASS WOULD HAVE CARRIED, because everything below this line
    // cannot tell the entries apart and must not need to. Two facts the flow's bypass passes were
    // missing on this entry, and both were silent:
    //   - the token itself stayed in the transcript, so the model was handed a literal `@all` the
    //     group path strips before dispatch;
    //   - the ATTACHMENT was dropped. It rides the message Metadata, Lex never sees Metadata
    //     (MESSAGE-FLOW §3.2), and the flow's stand-aside returns before reading it - so a 1:1
    //     "@all summarize this" with a PDF answered on the caption alone, with no error anywhere.
    // The stored message still holds the Metadata, so it is recovered here, on the one entry that
    // answers this turn. Best-effort: an unreadable message degrades to the text turn it already was.
    // READ BACK BY CONTENT, not by id: Chime sends Lex no `CHIME.message.id` (measured live - the
    // drift flow's resolveOriginatingMessageId documents the exact attribute set), so the stored
    // message is found the same way drift finds its anchor: newest-first listing, matched on the
    // exact transcript being handled, BEFORE the token strip below mutates it. The listing carries
    // the Metadata, which is where the attachment rides.
    const allSenderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
    if (channelArn && allSenderArn) {
      try {
        const listed = await chimeClient.send(new ListChannelMessagesCommand({
          ChannelArn: channelArn,
          ChimeBearer: await getBotArn(),
          SortOrder: 'DESCENDING',
          MaxResults: 20,
        }));
        const wantedRaw = rawTranscript.trim();
        const wantedDec = decodedTranscript.trim();
        const inbound = (listed.ChannelMessages || []).find((m) => {
          if (m.Sender?.Arn !== allSenderArn) return false;
          const raw = (m.Content || '').trim();
          let dec = raw;
          try { dec = decodeURIComponent(raw).trim(); } catch { /* raw form is still compared */ }
          return raw === wantedRaw || dec === wantedDec || dec === wantedRaw || raw === wantedDec;
        });
        const recovered = extractAttachment(inbound?.Metadata);
        if (recovered && event.requestAttributes) {
          event.requestAttributes[BYPASS_ATTACHMENT_ATTR] = JSON.stringify(recovered);
        }
      } catch (err) {
        console.warn('[Router] could not read the stored 1:1 @all message for its attachment; continuing as a text turn', err);
      }
    }
    event.inputTranscript = encodeURIComponent(stripAtAll(decodedTranscript));
  }

  try {
    // WHICH IDENTITY THIS TURN ANSWERS AS.
    //
    // Ordinarily the classification's own bot. A duel side is told which to be, because the handler
    // resolves exactly one and a duel has two. VALIDATED, never trusted: an unchecked caller-supplied
    // ARN would let anything able to invoke this handler post as any bot in the app instance. An
    // unsanctioned ARN falls back to this classification's own bot rather than failing the turn - the
    // duel then shows the wrong author, which is visible, instead of going silent, which is not.
    const classificationBotArn = await getBotArn();
    const requestedBotArn = event.requestAttributes?.[BYPASS_BOT_ARN_ATTR];
    let botArn = classificationBotArn;
    if (requestedBotArn && requestedBotArn !== classificationBotArn) {
      if (await isSanctionedBattleBot(requestedBotArn, classificationBotArn, ssmClient)) {
        botArn = requestedBotArn;
      } else {
        console.error('[Router][SecurityEvent] rejected an unsanctioned bot identity on a bypass turn', {
          requestedBotArn, classification: STATIC_CLASSIFICATION,
        });
      }
    }
    // Publish the VALIDATED identity so a bypass posts as this bot and no other (ADR-025). Set after
    // the sanction check, never before, so a rejected ARN cannot become the sender.
    spoke.botArn = botArn;
    const channelClassification = channelArn ? await resolveChannelClassification(channelArn, botArn) : 'basic';

    // Defense in depth: never trust channel metadata alone. Pull the sender's
    // real clearance from Cognito group membership and use the minimum of the two.
    // If someone was added to a premium channel they don't have the clearance for,
    // they get downgraded (not errored) and we log a security event.
    const userSub = extractUserSub(event);

    // WelcomeIntent fires when the assistant/user is ADDED to the channel — a
    // Chime SYSTEM event with no CHIME.sender.arn, so `userSub` is empty here.
    // Gather the greeting's context from channel metadata instead
    // (auth-agent-handler.loadProfileFromChannelMetadata does the same — a system
    // WelcomeIntent has no sender, so context lives in metadata). The creator's
    // sub is encoded in `createdBy` (…/user/<sub>) that create-conversation
    // stamped. We only personalise by name for a fresh 1:1 (creator is the sole
    // human); in a multi-member channel the event names no joiner, so greeting
    // `createdBy` would address the wrong person — fall back to a generic
    // welcome. Handled BEFORE the async-processor resolution: the welcome needs
    // no processor and must not hinge on a defaulted userClearance.
    // WelcomeIntent must mean the assistant/user was just ADDED to the channel —
    // a Chime SYSTEM event with NO inputTranscript. Lex sometimes misclassifies a
    // short real reply ("yes"/"no") as WelcomeIntent WITH a transcript; greeting
    // there would swallow the message so it never reaches the drift flow or the
    // agent (this broke drift confirm/decline). A transcript present ⇒ a real user
    // turn ⇒ fall through to normal processing regardless of the Lex intent label.
    if (lexIntentName === 'WelcomeIntent' && !(event.inputTranscript && event.inputTranscript.trim())) {
      const channelMeta = channelArn
        ? await resolveChannelMetadata(channelArn, botArn)
        : ({} as Record<string, unknown>);
      // Name personalization is intentionally NOT done here. The Chime WelcomeIntent fires on the
      // BOT's CHANNEL_MEMBERSHIP at channel creation, BEFORE the creator's membership AND before the
      // channel Metadata are reliably readable (both eventually consistent, verified empirically against
      // live Chime) — so any name resolved here races and is routinely wrong or missing. The welcome
      // stays generic; the assistant greets the user by name on their FIRST real turn instead (see the
      // async processor's first-turn greeting, driven by the resolved senderDisplayName). [A3]
      // The drift carry-over comes from the CHANNEL-CONTEXT STORE, not from channel Metadata.
      //
      // Written before `CreateChannel` and read CONSISTENTLY here, which is what makes it readable at
      // all: this intent fires on the assistant's automatic membership at creation, and Metadata is
      // eventually consistent (the note above says exactly that about the creator's name). The store is
      // also not member-writable, and not subject to Metadata's ~1KB whole-blob cap — which is what
      // truncated the quoted message.
      //
      // Metadata is still read as a FALLBACK for channels created before the move. New channels write
      // `priorSubject` here and no longer write `priorMessage` to Metadata at all.
      const driftCtx = channelArn ? await getChannelContext(channelArn, { consistent: true }) : null;
      const triggerContext = driftCtx?.priorSubject
        || (typeof channelMeta.triggerContext === 'string' ? channelMeta.triggerContext : undefined);
      const topic = typeof channelMeta.topic === 'string' ? channelMeta.topic : undefined;

      // Onboarding welcome (opt-in): when a deployment supplies an intake schema,
      // the welcome is the richer context-gathering flow instead of the static
      // greeting. Show the greeting + the first field's question and seed the
      // intake state into sessionAttributes; the user's answers drive the FSM on
      // the following turns (see the intake interception below). Inert (config is
      // null) unless ONBOARDING_INTAKE / ONBOARDING_INTAKE_PARAM is set.
      const intakeConfig = await loadIntakeConfig(getSsmParam);
      if (isOnboardingEnabled(intakeConfig)) {
        // Once-per-user (SPEC-USER-PROFILE-AND-ONBOARDING §2/§3). Onboarding needs ONE person to key on, so
        // it applies to the `single` shape only: a group has no single subject whose profile the gate could
        // read, and a conversation with no humans yet (alert-initiated) has nobody to onboard. Neither is a
        // failure, so neither falls open to asking questions of a group.
        const { ctx: participants, source } = await resolveParticipants(channelArn, botArn);
        console.log('[Router][WelcomeIntent] participants', {
          focus: participants.focus, humans: participants.humans.length, source,
        });

        if (!onboardingApplies(participants)) {
          console.log('[Router][WelcomeIntent] onboarding does not apply to this shape; skipping intake', {
            focus: participants.focus,
          });
        } else if (await hasOnboarded(participants.subject)) {
          console.log('[Router][WelcomeIntent] participant already onboarded; skipping intake');
        } else {
          const step = startIntake(intakeConfig);
          console.log('[Router][WelcomeIntent] onboarding intake started', { fields: intakeConfig.fields.length });
          return formatLexResponse(event, [{ contentType: 'PlainText', content: step.reply }], writeIntakeState(step.state));
        }
      }

      const loaded = await loadWelcomeOrientation();
      // ONE assembled orientation. The deployment's configured copy and the reason this conversation
      // exists are both orientation sources, merged rather than raced: before this, a channel carrying a
      // topic short-circuited past the company name and example prompts entirely.
      const welcome = composeWelcome({
        ...(loaded.orientation ?? {}),
        ...(topic ? { topic } : {}),
        // `triggerContext` is the channel's carry-over LABEL for what a previous conversation was about.
        // Named `priorSubject` in the orientation because that is what it has to be: the drift design's
        // by-reference principle forbids copying the user's message body into a new conversation.
        ...(triggerContext ? { priorSubject: triggerContext } : {}),
        // The way back to the conversation this one continues from. Deep-links to the ORIGINATING MESSAGE
        // when the creating flow recorded one, which is what lets the welcome reference the user's earlier
        // message without copying its text (SPEC-DRIFT-CONVERGENCE's by-reference principle).
        //
        // Composed at WRITE time in the store. The Metadata fallback reassembles the same link from the
        // two structural pointers, which stay in Metadata because routing, live-drift and the data
        // plane all read them.
        ...(driftCtx?.parentRef
          ? { parentRef: driftCtx.parentRef }
          : typeof channelMeta.parentChannelArn === 'string' && channelMeta.parentChannelArn
            ? {
              parentRef: `?conversation=${encodeURIComponent(channelMeta.parentChannelArn)}`
                + (typeof channelMeta.originatingMessageId === 'string' && channelMeta.originatingMessageId
                  ? `#message=${encodeURIComponent(channelMeta.originatingMessageId)}`
                  : ''),
            }
            : {}),
        // The person's own words that started this conversation, quoted back by the welcome.
        //
        // STORE ONLY — deliberately NO Metadata fallback, following the same rule `host-grounding.ts`
        // states for the private grounding fields: reading a "never put this in Metadata" field back
        // out of Metadata reintroduces exactly the member-writable path the move removed. The quoted
        // body is the person's own text, which the metadata guide puts in the never list.
        //
        // Nothing is stranded by that. `WelcomeIntent` fires on the assistant's membership at channel
        // CREATION, so a channel created before this move already received its welcome and will not
        // compose another; there is no population of old channels waiting to read this.
        ...(driftCtx?.priorMessage ? { priorMessage: driftCtx.priorMessage } : {}),
      });

      // A single absent field only omits its own piece of copy — it never falls back to the generic
      // greeting and never discards the fields that ARE configured. What it does do is get recorded,
      // because degraded copy is the only symptom this failure has.
      if (loaded.expected && loaded.issues.length > 0) {
        recordWelcomeConfigDefect({
          classification: channelClassification,
          reason: loaded.orientation ? 'incomplete' : 'unusable',
          detail: loaded.issues,
        });
      } else if (loaded.expected && welcome.usedGenericFallback) {
        // The parameter is declared and read cleanly, yet nothing usable came back.
        recordWelcomeConfigDefect({
          classification: channelClassification,
          reason: 'unusable',
          detail: [`${WELCOME_PARAM} yielded no orientation, so the generic welcome was served`],
        });
      }
      if (welcome.variant === 'oriented' && welcome.missingFields.length > 0) {
        recordWelcomeConfigDefect({
          classification: channelClassification,
          reason: 'incomplete',
          detail: [`orientation omitted these fields from the welcome: ${welcome.missingFields.join(', ')}`],
        });
      }

      console.log('[Router][WelcomeIntent]', {
        variant: welcome.variant,
        // What actually reached the user, not just what was configured. `contributed` is the readable
        // form of "which orientation sources landed in this welcome".
        contributed: welcome.contributed,
        missingFields: welcome.missingFields,
      });
      // ═══════════════════════════════════════════════════════════════
      // ANSWER THE QUESTION THAT STARTED THIS CONVERSATION, so the person does not retype it.
      //
      // A drift-spawned conversation quotes what they said ("You asked: > …") and, until now, answered
      // nothing — the welcome was a terminal message and the user had to ask again in the new thread.
      //
      // The welcome becomes the PLACEHOLDER, the same shape every other turn uses: it carries the
      // `<!--corr:{id}-->` marker, the processor resolves it and updates it in place. `messagePrefix`
      // is what keeps the welcome visible — a plain update replaces content, which would discard the
      // orientation copy to show the answer.
      //
      // ONLY on a spawned conversation. `priorMessage` is set solely by the drift creation path, so an
      // ordinary new conversation keeps a plain, unmarked welcome and dispatches nothing.
      //
      // The correlation id is derived from the SPAWNING message, exactly as an ordinary turn derives
      // from the user's, so a repeated WelcomeIntent for the same channel collapses on the processor's
      // own claim instead of answering twice.
      // ═══════════════════════════════════════════════════════════════
      if (driftCtx?.priorMessage && channelArn) {
        const welcomeCorrelationId = turnCorrelationId({
          channelArn,
          senderArn: event.requestAttributes?.['CHIME.sender.arn'] || '',
          userMessage: driftCtx.priorMessage,
        });
        const welcomeProcessorArn = await resolveAsyncProcessorArn(channelClassification);
        if (welcomeProcessorArn) {
          const withMarker = `${welcome.content}\n\n<!--corr:${welcomeCorrelationId}-->`;
          await invokeAsync(welcomeProcessorArn, {
            channelArn,
            correlationId: welcomeCorrelationId,
            userMessage: driftCtx.priorMessage,
            userType: channelClassification,
            botArn,
            // Keep the welcome above the answer.
            messagePrefix: welcome.content,
          });
          console.log('[Router][WelcomeIntent] answering the spawning question in place', {
            correlationId: welcomeCorrelationId,
          });
          return formatLexResponse(event, [{ contentType: 'PlainText', content: withMarker }]);
        }
        console.warn('[Router][WelcomeIntent] no async processor resolved; the spawning question '
          + 'stays quoted but unanswered');
      }

      return formatLexResponse(event, [{ contentType: 'PlainText', content: welcome.content }]);
    }

    // Federated users (a `fed_` AppInstanceUser from the embedded-widget exchange) do NOT
    // exist in the AE Cognito pool, so a group-based clearance lookup always throws
    // UserNotFoundException and would wrongly downgrade them to basic. Their entitlement is
    // fixed by the channel they were provisioned into (federated-create-conversation creates
    // the channel at ASSISTANT_CLASSIFICATION and they can only ever be a member of that channel), so the
    // channel classification IS authoritative for them — trust it and skip the Cognito lookup. Without
    // this, every turn downgrades to basic and the standard processor is never invoked.
    const isFederated = userSub.startsWith('fed_');
    const { clearance: userClearance, isAdmin: isExemptAdmin } = isFederated
      ? { clearance: channelClassification, isAdmin: false } // federated senders are cross-instance, never abuse-exempt
      : await resolveUserClearance(userSub);
    const effectiveClassification = isFederated ? channelClassification : minRank(channelClassification, userClearance);

    if (!isFederated && channelClassification !== userClearance) {
      console.warn('[Router][SecurityEvent] Classification mismatch', {
        userSub,
        channelArn,
        channelClassification,
        userClearance,
        effectiveClassification,
      });
    }

    const asyncProcessorArn = await resolveAsyncProcessorArn(effectiveClassification);
    // Does this classification's profile use the LLM intent classifier? True for all default
    // profiles (basic included — a deliberate change from the legacy keyword path); a deployment
    // can still set classifierMode:'keyword' on a cheap profile.
    const usesLlmClassifier = profiles.profileFor(effectiveClassification).classifierMode === 'llm';

    console.log('[Router] Resolved', {
      effectiveClassification,
      channelClassification,
      userClearance,
      asyncProcessorArn: asyncProcessorArn.split(':').pop(),
    });

    // Cap length HERE, at the entry, before it drives any expensive work: the intent classifier
    // (an LLM call) and RAG retrieval (an embedding call) both run on this string, so a pathologically
    // long message would otherwise pay full classifier + embedding cost before the processor's own cap.
    // MAX_USER_MESSAGE_LENGTH (0/unset ⇒ off) rides abuse.env onto this handler.
    const userMessage = capUserMessage(decodeURIComponent(event.inputTranscript || '').trim());

    // Attachment-in, present only on a bypass (the flow reads it from message Metadata; Lex never
    // sees it). Resolved here because it changes what the turn IS, not just what the processor gets:
    // see the greeting short-circuit below.
    const turnAttachment = bypassAttachment(event);

    // Onboarding intake interception (opt-in). While an intake is in progress,
    // every user turn is an answer to the current field (or the yes/no on the
    // summary), driven deterministically with NO Bedrock call — the same instant,
    // shaped model as the static welcome. State rides in sessionAttributes across
    // turns; the collected answers land in channel history, so the working
    // assistant sees them once intake completes. This runs BEFORE classification,
    // drift, and dispatch so an intake answer is never misread as a query. Fully
    // inert unless the deployment opts in (config is null by default). Once the
    // intake is done, `phase === 'done'` persists in sessionAttributes for the
    // rest of the session and every turn falls through to normal processing.
    const intakeConfig = await loadIntakeConfig(getSsmParam);
    if (isOnboardingEnabled(intakeConfig)) {
      const prior = readIntakeState(event.sessionState.sessionAttributes);
      // Once-per-user (SPEC-USER-PROFILE-AND-ONBOARDING): if there is NO in-progress intake in this
      // conversation and this user was already onboarded before, do NOT re-onboard — fall through so
      // their message is answered directly. An in-progress `prior` is always continued (the user is
      // mid-intake in THIS conversation), so an already-onboarded flag never interrupts a live intake.
      const skipForOnboarded = !prior && (await hasOnboarded(userSub));
      if (!skipForOnboarded && (!prior || prior.phase !== 'done')) {
        // No prior state ⇒ this is the first answer (the WelcomeIntent greeting
        // already showed the first question); start at the first field.
        const state = prior ?? { cursor: 0, collected: {}, phase: 'collecting' as const };
        const intakeName = await resolveUserName(userSub);
        const step = advanceIntake(intakeConfig, state, userMessage, intakeName);
        console.log('[Router][Onboarding]', { phase: step.state.phase, cursor: step.state.cursor, done: step.done });
        // On completion, persist the once-per-user flag + collected facts so no future conversation
        // re-onboards this user (and the assistant keeps the facts as durable context).
        if (step.done) await markOnboarded(userSub, step.state.collected);
        return formatLexResponse(event, [{ contentType: 'PlainText', content: step.reply }], writeIntakeState(step.state));
      }
    }

    // Hydrate the per-deployment intent pack from SSM (no-op unless ASSISTANT_INTENT_PACK_PARAM is
    // set; cached after the first cold-start fetch). Must precede classification so the categories +
    // keyword fallback reflect the deployment's taxonomy. See lib/intent-pack.ts.
    await hydrateIntentPackFromSsm();

    // Classification A/B: resolve a classifier-model experiment for this classification
    // BEFORE classifying, so the variant's model does the classification.
    // Best-effort — any failure falls back to the deployment-default classifier.
    // The mutual-exclusion rule guarantees a classification experiment never
    // coexists with a base/intent experiment on the classification, so this never
    // double-resolves with the response-model experiment.
    let classifierModelId: string | undefined;
    let classifierExperimentId: string | undefined;
    let classifierVariantId: string | undefined;
    if (usesLlmClassifier && channelArn) {
      try {
        const catalog = getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
        const cls = await resolveClassificationExperiment(effectiveClassification as 'basic' | 'standard' | 'premium', channelArn, catalog);
        if (cls) {
          classifierModelId = cls.bedrockModelId;
          classifierExperimentId = cls.experimentId;
          classifierVariantId = cls.variantId;
          console.log('[Router] Classification experiment resolved', {
            experimentId: classifierExperimentId, variantId: classifierVariantId, modelKey: cls.modelKey,
          });
        }
      } catch (error) {
        console.error('[Router] Classification experiment resolution failed (using default classifier):', error);
      }
    }

    // U2b (SPEC-ASSISTANT-CONFIG §4): when no classification A/B overrides it, the CLASSIFIER model comes
    // from THIS profile version's `models.classifier` (per-profile — the classifier model is no longer a
    // single global default). Byte-identical until a version names a CONCRETE model: the seed carries the
    // `'default'` sentinel, which `concreteModel` skips, so this stays undefined and `classifyIntent` uses
    // the deployment-default CLASSIFIER_MODEL (the profile's recorded choice to track the platform default).
    if (usesLlmClassifier && !classifierModelId) {
      try {
        const profileName = profiles.profileFor(effectiveClassification).name;
        const active = await resolveActiveProfile(profileName, { ssm: ssmClient, ssmRoot: SSM_ROOT });
        const classifierKey = concreteModel(active.models?.classifier);
        if (classifierKey) {
          const catalog = getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
          const def = (catalog as Record<string, unknown>)[classifierKey];
          if (def) classifierModelId = bedrockInvokeId(def as Parameters<typeof bedrockInvokeId>[0]);
        }
      } catch (error) {
        console.error('[Router] profile classifier resolution failed (using default classifier):', error);
      }
    }

    // Classify intent via the profile's classifierMode — 'llm' for all default profiles (basic
    // included), 'keyword' (classifyIntentByKeyword) only if a deployment selects it for a cheap profile.
    const classification = usesLlmClassifier
      ? await classifyIntent(userMessage, { modelId: classifierModelId })
      : classifyIntentByKeyword(userMessage);

    // A TURN CARRYING A FILE IS NOT A GREETING, whatever its caption says.
    //
    // Both classifiers decide on the TEXT alone - they cannot see the attachment - and both call a
    // short message a greeting (`fastPathIntent`: anything under 3 characters, plus the exact
    // greeting/acknowledgement lists). So "hi" with a PDF dropped on it classifies as GREETING, and
    // GREETING has three consequences that are all wrong here: `getQuickResponse` answers "Hey, what
    // can I help you with?" and returns DIRECT, so the processor is never dispatched and THE FILE IS
    // NEVER READ; the exchange is attributed to the wrong intent; and experiment resolution is skipped
    // for the turn.
    //
    // Corrected once, HERE, rather than at each of those three branches - the fault is the
    // classification, not what reads it. Only reachable on a bypass: Lex is never given an attachment.
    if (turnAttachment &&
        (classification.intent === IntentType.GREETING ||
         classification.intent === IntentType.ACKNOWLEDGMENT)) {
      console.log('[Router] attachment present; not treating a short caption as a greeting', {
        classifiedAs: classification.intent,
      });
      classification.intent = IntentType.GENERAL;
    }

    // Classifier-step instrumentation — logged for now; threading classifier
    // experiment/variant + latency/tokens into the analytics record lands with
    // the per-variant measurement work.
    if (classifierExperimentId || classification.classifierLatencyMs !== undefined) {
      console.log('[Router] Classifier step', {
        classifierExperimentId,
        classifierVariantId,
        classifierModelId: classification.classifierModelId,
        classifierLatencyMs: classification.classifierLatencyMs,
        classifierTokensIn: classification.classifierTokensIn,
        classifierTokensOut: classification.classifierTokensOut,
      });
    }

    // ============================================================
    // Live drift detection (feature-flagged via ENABLE_LIVE_DRIFT).
    // The flow is shared (lib/live-drift-flow.ts) so every classification runs the
    // identical logic — this router is the handler for all classifications. It
    // gates internally on ENABLE_LIVE_DRIFT + HAS_AURORA + a real channel,
    // and suppresses itself in battle-enabled channels. A non-null result
    // short-circuits the turn (drift suggestion, or confirm/navigate); a
    // null falls through to the normal agent flow (the decline path mutates
    // event.sessionState.sessionAttributes so the fall-through carries it).
    // ============================================================
    // Resolve this channel's LIVE task before the drift check. Two consumers now share the
    // one lookup: drift suppression (below) and task continuation further down.
    //
    // Cost of the hoist: on the turn that reaches the agent flow it is free — the continuation
    // path performed exactly these reads already, just later. It is NOT free on the paths that
    // return between here and there (a fired drift suggestion, an abuse-gate rejection), which
    // now pay up to 3 GetItems they previously skipped. Bounded and small next to the reads
    // those paths already make, and the alternative — resolving it lazily inside the drift flow —
    // buys nothing, since drift runs before the gate and would force the same reads anyway.
    //
    // Drift needs it because a mid-task turn is an ANSWER to something the assistant asked,
    // and an answer is a continuation, not a pivot. Without this, a report task's
    // "audience is engineering leadership, focus on CI cost" reply lands far from the
    // summary embedding (it repeats none of its topic words) and fires a false drift
    // suggestion on the very turn the assistant solicited.
    // Hoisted above the active-task lookup: WHO OWNS the task depends on whether this is a duel side.
    // Assignable, deliberately: a person-owed resume discovers mid-turn that this ordinary Lex
    // turn IS a battle side's continuation, and synthesizes the context the bypass would have
    // carried (see resumeDuelSideIfWaiting).
    let battleCtx = bypassBattleContext(event);
    // WHETHER THE CALLER ALREADY METERED THIS TURN. True only for a DECLARED context: the channel
    // flow gates a duel as a whole before the fan-out and before a continuation invoke, so a turn
    // that ARRIVES with battleContext was paid for upstream. A context SYNTHESIZED by a resume below
    // is the opposite case - an ordinary Lex turn no upstream ever gated - and it must be metered
    // here like any other turn, or every answer in a multi-step duel chain is unmetered model spend.
    const meteredUpstream = Boolean(battleCtx);

    let activeTask: UserTask | null = null;
    /**
     * THIS CHANNEL HAS LIVE WORK IN IT, whoever currently holds it.
     *
     * Distinct from `activeTask`, which is the chain this turn CONTINUES and is therefore owner-scoped
     * on purpose - a duel side must never resume its rival's work, and a bare "thanks" must not be
     * annexed by a task nobody was blocked on the speaker for. Drift asks a different question, and it
     * is the broader one: is the assistant mid-workflow in this conversation. It is, whether the
     * machine currently rests on the person or on the assistant.
     *
     * WHY THE OWNER-KEYED ANSWER WAS THE WRONG ONE. Suppression was keyed on `activeTask`, so it held
     * only while a state declared `awaits`. A state that ends its turn on a question and forgets
     * the flag therefore lost drift protection silently: `report_generation.drafting_outline` did, and
     * a one-line answer to the assistant's own outline question ("Can you make it 1-2 pages?") was
     * served an offer to split the conversation instead of an answer. The flag is worth declaring for
     * its own reasons (ownership, the person's queue), but drift must not depend on it being right.
     *
     * NO EXTRA READ. Every value below comes from lookups this turn already makes: the person's held
     * list, the assistant's own partition (read on the same branch), and the requester-keyed fallback.
     * All of them filter to `pending` and `in_progress`, so anything they return IS live.
     */
    let liveTaskInChannel = false;
    /**
     * WORK THAT FINISHED HERE A MOMENT AGO, which the conversation is probably still about.
     *
     * A message arriving shortly after a task ends is usually about the thing that was just delivered:
     * "Where is the file?", "Can you make it shorter?". Nothing in the live-task signal above reaches
     * that turn, because every task lookup on this path filters to `pending`/`in_progress` and a
     * finished task is invisible to all of them. Measured on the same live conversation that produced
     * the `drafting_outline` failure: the report was delivered, the person said "Looks good", the
     * assistant said it had saved the file, and "Where is the file?" was answered with an offer to
     * start a separate conversation.
     *
     * PROVISIONAL UNTIL THE LOG CONFIRMS IT. The mirror row's `updatedAt` is when the ending was
     * MIRRORED, and a task's ending is recorded in its `stateHistory`
     * (SPEC-TASK-STATE-TRANSITIONS §6, which is explicit that there is no `resolvedAt` scalar beside
     * that log). So the widened query is a pre-filter and the ending is read from the log before this
     * is believed - one GetItem, taken only when the pre-filter matched AND nothing live was found,
     * which is precisely the rare turn this exists for.
     *
     * WHAT IT DOES NOT COVER, and these are real: work that ended longer ago than the window; a
     * conversation whose task never reached a terminal state at all (the model delivered without
     * declaring it, in which case the task is still live and the signal above catches it instead); a
     * follow-up about something the assistant said that was never a task; and the first follow-up in a
     * conversation that has no task history. None of those are reachable from a task lookup, and the
     * anchor that would reach them is a design question recorded in SPEC-DRIFT-CONVERGENCE rather than
     * a widening of this one.
     */
    let recentlyEndedTaskHere: UserTask | null = null;
    /**
     * This turn is the answer to a chain THIS ASSISTANT owns (a duel side, or any assistant-held
     * work), resumed below.
     *
     * It decides how the answer is DELIVERED. The message that triggered it is targeted at this
     * assistant - that is how the person answered privately - so the reply Amazon Chime SDK posts for
     * this turn is targeted too, and updating it in place would bury the answer in a private message
     * only its sender can see. A duel is a comparison; its answers have to be public to be one. So the
     * targeted reply stays an acknowledgement and the worker posts the answer as a NEW, untargeted
     * message (owner, 2026-08-14).
     */
    let resumedOwnChain = false;
    /**
     * The message is one the classifier settles without a model: under 3 characters, or an exact
     * greeting/acknowledgement token (`fastPathIntent`). "ok" and "thanks" are both.
     */
    const shortAcknowledgment = classification.intent === IntentType.GREETING
      || classification.intent === IntentType.ACKNOWLEDGMENT;
    /**
     * This turn resumed work that was WAITING on this person, which makes it a continuation whatever
     * its length. Read below, once, to correct the classification the fast path gave it.
     */
    let resumedWaitingWork = false;
    // WHAT IS WAITING ON THIS PERSON IS LOOKED UP REGARDLESS OF INTENT (ADR-026). The
    // greeting/acknowledgment skip is right for a message that OPENS work, since a bare "thanks" opens
    // none, and wrong for one that ANSWERS it. Answering a clarifying question with "ok" (2 characters)
    // or "thanks" (an exact token) is how people answer, and every continuation path sits behind this
    // gate: the response is never applied to the awaited task, the assistant's own chain is never
    // resumed, and the duel side is never taken out of `WAITING_FOR_USER`.
    //
    // `battleCtx` did not rescue the duel case, which is why it is not the guard: a flow-callback turn
    // carries no battle context at all (the callback has no `Target`, see channel-flow-processor), so
    // the person got a canned quick reply, the battle row stayed WAITING_FOR_USER, and the chain sat
    // there until the deadline reported an assistant that had in fact been answered as never finished.
    //
    // WHAT IT COSTS: one strongly-consistent Query on this person's queue for every short message,
    // plus the reads the resume paths make when that finds nothing (the assistant's own partition, the
    // channel's duel pointer). The same reads an ordinary turn already pays, and there is no cheaper
    // way to answer "is anything waiting on this person" - which is precisely the question the quick
    // reply further down is an answer to. The requester-keyed fallback is the one lookup a short
    // message still skips; see the guard on it below.
    if (battleCtx || channelArn || !shortAcknowledgment) {
      if (battleCtx) {
        // A DUEL SIDE'S CHAIN IS OWNED BY THE ASSISTANT, NOT THE HUMAN (ADR-024). Each side runs its
        // own chain for one user prompt, so `getActiveTask(userSub, ...)` would find the person's task
        // - or nothing - and a resumed side would silently start over instead of continuing.
        //
        // Asking by owner also removes the need for a caller to tell us which chain to continue: the
        // battle continuation used to resolve this itself and pass a delivery option down, which was
        // the channel flow deciding a turn question.
        activeTask = await getActiveTaskForOwner(principalIdFromArn(botArn), channelArn);
        // A duel turn reads the ASSISTANT's partition only, so this is what it can say about live work
        // without a second query. Narrower than the ordinary branch below by exactly the person's own
        // chains, and deliberately left that way: a battle turn already spends the reads it needs, and
        // adding a person-keyed query here to widen a suppression would be a per-turn read bought for
        // one branch. A duel side's chain is the live work in a duel channel in any case.
        liveTaskInChannel = liveTaskInChannel || !!activeTask;
      } else {
        // THE MESSAGE IS THE RESPONSE TO THE WORK THIS PERSON OWES, and that is asked FIRST.
        //
        // A task in a state that declares `awaits` was handed to the user (ADR-024 ownership), so it is
        // findable by owner without anything being tagged, carried or parsed out of message content -
        // which is what lets this work identically for every workflow instead of each inventing its
        // own waiting signal. The queue has already brought them to this conversation; speaking here
        // is the answer.
        //
        // Asked before the requester-keyed lookup below because the two can name different rows: the
        // person may have opened a task earlier that is not the one currently waiting on them, and the
        // one waiting on them is the one this message is about.
        // ONE partition read serves every lookup on this person's queue this turn. The singular
        // helpers both delegate to this same strongly-consistent Query with the same key condition
        // and filter, so calling them separately issued up to two byte-identical reads per ordinary
        // turn; the list is fetched once and each question is answered from it.
        // ONE query, both questions: what this person holds here, and what of theirs ended here within
        // the window. The ended half is free - the filter runs after the read, so those rows are paid
        // for by the channel scan whether or not they are handed back.
        const personTasks = channelArn
          ? await getOwnerChannelTasks(userSub, channelArn, { endedWithinMs: RECENTLY_ENDED_WINDOW_MS })
          : { live: [], recentlyEnded: [] };
        const heldByPerson = personTasks.live;
        // Live work this person holds here. Recorded for drift the moment it is read, not when a
        // continuation decides to use it: the two branches below can legitimately decline to continue
        // one (it belongs to another assistant, or another person is the one being waited on), and the
        // conversation is mid-workflow either way.
        liveTaskInChannel = liveTaskInChannel || heldByPerson.length > 0;
        recentlyEndedTaskHere = recentlyEndedTaskHere ?? personTasks.recentlyEnded[0] ?? null;
        const owed = heldByPerson[0] ?? null;
        // WHICH of the chains this person holds, when they hold more than one. The lookup above returns
        // the NEWEST, and the moment two duel sides both wait on the same person that names two rows -
        // so "the active task" as an implicit notion would hand a side its rival's work.
        //
        // This assistant's own chain wins. Not because targeting decides routing (it does not, see
        // `handOverToOwningAssistant`), but because the person is speaking to an assistant that is
        // already mid-conversation with them about work of its own, and the reading that makes their
        // message answer someone ELSE's question is the wrong one. When this assistant holds nothing
        // with them, the newest chain stands and the handover below sends it where it belongs.
        const mineWithThisPerson = owed && channelArn
          && owed.assistantId !== principalIdFromArn(botArn)
          ? heldByPerson.find((t) => t.assistantId === principalIdFromArn(botArn)) ?? null
          : null;
        const answered = mineWithThisPerson ?? owed;
        // ROUTING FOLLOWS THE TASK (rule 1). The chain names the assistant whose work it is, and if
        // that is not this one, this one stands aside rather than answering work it does not own. Not
        // attempted on a turn that ARRIVED by handover: that assistant owns the chain by construction,
        // and the bound on the hop is that only a turn without the marker may make one.
        if (answered && !handedOverFrom(event) && channelArn && userSub
            && answered.assistantId && answered.assistantId !== principalIdFromArn(botArn)) {
          const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
          const handed = senderArn && await handOverToOwningAssistant({
            task: answered,
            event,
            channelArn,
            senderArn,
            selfBotArn: botArn,
            classificationBotArn,
          });
          // Silence, because everything this turn owed is already said or under way: the person has
          // their receipt, and the answer is the owning assistant's to give.
          if (handed) return formatLexSilentResponse(event);
        }
        if (answered) {
          const applied = await applyUserResponseToTask({
            taskId: answered.taskId,
            channelArn,
            assistantId: principalIdFromArn(botArn),
            // The DEPLOYMENT pack, not the profile's overrides: the active profile version is resolved
            // later in this turn, after this point. The cost is bounded and degrades safely - a state
            // that only a profile's custom machine declares `awaits` on is not advanced here, and the
            // model's `advance_task_state` on the worker, which does have the merged machines, moves it
            // instead. Nothing is advanced WRONGLY; at worst it is advanced one hop later.
            machines: taskStateMachines(),
            messageId: inboundMessageId(event),
          });
          console.log('[Router] user response applied to the awaited task', {
            taskId: answered.taskId, ...applied,
          });
          // Either way the chain continues on this turn: an applied advance has already moved the
          // machine and handed the work back, and a deferred branch has handed it back for the model
          // to resolve with `advance_task_state`.
          activeTask = answered;
          // Something WAS waiting on this person and this message answered it, so the turn is a
          // continuation however short the message is.
          resumedWaitingWork = true;

          // AND IF THAT CHAIN IS A DUEL SIDE'S, take the side out of `WAITING_FOR_USER` too.
          //
          // THIS IS THE PATH A DUEL ACTUALLY TAKES. A duel side's chain starts in an `awaits`
          // state, so the person holds it from its first moment and THIS lookup is the one that finds
          // it - the assistant's-own-chain branch below never runs for it. Measured on the deployment:
          // the response was applied here, the battle row was never touched, and both sides sat in
          // `WAITING_FOR_USER` while the duel looked like it had simply gone quiet.
          //
          // The owner rule needs no check here, and that is a property of the lookup rather than an
          // omission: this branch only ever finds a chain THIS PERSON holds, so a member who did not
          // start the duel finds nothing and advances nothing. The refusal is structural.
          const resumedCtx = await resumeDuelSideIfWaiting(channelArn, botArn);
          if (resumedCtx) {
            battleCtx = battleCtx ?? resumedCtx;
            // A duel is a comparison, so this side's answer has to be readable by the channel - and
            // the person answered by targeting this bot, which makes the reply Amazon Chime SDK posts
            // for this turn private. Scoped to a duel deliberately: an ordinary task continuation in a
            // 1:1 has no public to broadcast to, and would gain only a receipt nobody needs.
            resumedOwnChain = true;
          }
        }
        // THE ASSISTANT'S OWN WAITING CHAIN, answered through the ordinary Lex turn.
        //
        // The lookup above asks what the PERSON owes. A duel side's chain is owned by the ASSISTANT
        // (ADR-024 D1: each side runs its own, so two sides' chains stay apart by owner), so it is
        // invisible there - and the message that answers it arrives here, as an ordinary turn, because
        // the client targeted it and Amazon Chime SDK routed it to this bot's Lex.
        //
        // THIS IS THE WHOLE CONTINUATION MECHANISM NOW. It used to be the channel flow's: read the
        // message's `Target`, resolve the duel, deny the message, hand the turn back. That path never
        // ran - the flow callback does not carry `Target` at all - and it did not
        // need to exist: targeting is a client-side DELIVERY concern, already handled at send, and
        // "which work is this the answer to" is answerable from ownership alone.
        if (!activeTask && channelArn) {
          // BY ASSISTANT AND BY HOLDER, not "the current task". The chain is held by the PERSON while
          // it waits on them (that is what puts it in their queue), so it is found in their partition -
          // and `assistantId` is what picks THIS assistant's chain out of it. Two duel sides wait on
          // the same person, so without that a side could resume its rival's work.
          let mine = heldByPerson.find((t) => t.assistantId === principalIdFromArn(botArn)) ?? null;
          if (!mine) {
            // A chain the assistant still holds (its state does not await anyone) or one written
            // before `assistantId` existed. A DIFFERENT partition (the bot as owner), so this one
            // is a real read - and it is where a FINISHED chain's mirror row lives too, since a report
            // is handed back to the assistant before it completes. Same query, both answers; the
            // short-circuit above is kept so a person already holding this assistant's chain still
            // costs nothing here.
            const ownTasks = await getOwnerChannelTasks(
              principalIdFromArn(botArn), channelArn, { endedWithinMs: RECENTLY_ENDED_WINDOW_MS },
            );
            mine = ownTasks.live[0] ?? null;
            recentlyEndedTaskHere = recentlyEndedTaskHere ?? ownTasks.recentlyEnded[0] ?? null;
          }
          // THE READ THAT ANSWERS THE DRIFT QUESTION FOR THE REPORTED FAILURE, and it is already here.
          // A chain the assistant still holds is live work in this conversation even though the
          // continuation below declines to resume it - `blockedOnAPerson` is a rule about whose message
          // may move a machine, not about whether the workflow is running. Recording it here is what
          // makes the suppression independent of a state remembering to declare `awaits`.
          liveTaskInChannel = liveTaskInChannel || !!mine;
          // ONLY A CHAIN THAT IS ACTUALLY BLOCKED ON A PERSON. `awaits` is the machine declaring
          // "I cannot go further without an answer from this party", and it is the whole licence for
          // reading an ordinary message as that answer. A chain merely IN PROGRESS must not absorb what
          // someone says in the channel: that is a person's message being annexed by work they were not
          // talking about, and it is what the guard test on this path exists to prevent.
          //
          // Through the normalizer, so a per-profile machine authored in either accepted form is read
          // the same way. The only shipped reference is `requester`, a person, so the question this
          // answers is unchanged; WHO is being waited on is settled just below.
          const blockedOnAPerson = Boolean(
            mine?.taskState
            && awaitedPartyOf(taskStateMachines()[mine.taskType]?.states?.[mine.taskState]),
          );
          if (mine && blockedOnAPerson) {
            // WHO IS THIS WAITING ON. A duel's answer belongs to the person who started it (tracker
            // row 93), and the pointer is where that is recorded; for any other assistant-owned chain
            // it is the requester. A message from anyone else does not advance it - they are not
            // refused, their turn is simply answered as ordinary conversation.
            const duel = await resolveActiveBattle(channelArn);
            // The mirror row carries the assignee, not the requester ARN, so those are the two
            // sources: the duel's owner from the pointer, else whoever the task was assigned to.
            // Neither recorded ⇒ nobody is named, so the chain answers to whoever speaks rather than
            // becoming unanswerable - the same fail-open the duel rule takes.
            const waitingOn = duel?.initiatorUserSub ?? mine.assigneeUserSub;
            if (waitingOn && userSub && waitingOn !== userSub) {
              console.log('[Router] a chain this assistant owns is waiting on someone else; not advancing it', {
                taskId: mine.taskId, speakerIsWaitedOn: false,
              });
            } else {
              const applied = await applyUserResponseToTask({
                taskId: mine.taskId,
                channelArn,
                assistantId: principalIdFromArn(botArn),
                machines: taskStateMachines(),
                messageId: inboundMessageId(event),
              });
              activeTask = mine;
              resumedOwnChain = true;
              resumedWaitingWork = true;
              console.log('[Router] resuming the chain this assistant owns', {
                taskId: mine.taskId, ...applied,
              });

              // A duel side blocked on the user is ALSO a battle row, and round 2 stays suspended
              // until it leaves `WAITING_FOR_USER`. The SAME call as the person-owed branch above, and
              // deliberately not a second copy: one of the two paths having a resume and the other not
              // is exactly the defect that left both sides of a live duel parked forever.
              battleCtx = battleCtx ?? (await resumeDuelSideIfWaiting(channelArn, botArn)) ?? undefined;
            }
          }
        }

        // A TASKLESS WAIT RESUMES TOO. A round-1 clarification asked before any chain exists parks
        // the side in `WAITING_FOR_USER` with no task row - the wait lives on the battle row alone -
        // so neither lookup above finds anything, and both resume sites sit behind a found task. The
        // answer still arrived exactly like the task-shaped one: targeted at this side, routed to its
        // Lex. Same owner rule as the chain branch above (a duel answers to whoever started it, and an
        // unrecorded initiator fails open rather than making the side unresumable), and checked BEFORE
        // the generic task fallback below so an unrelated open task cannot absorb the answer while the
        // duel strands.
        if (!activeTask && !battleCtx && channelArn) {
          const duel = await resolveActiveBattle(channelArn);
          const waitingOn = duel?.initiatorUserSub;
          if (duel && (!waitingOn || !userSub || waitingOn === userSub)) {
            const resumedCtx = await resumeDuelSideIfWaiting(channelArn, botArn);
            if (resumedCtx) {
              battleCtx = resumedCtx;
              // A duel is a comparison: the resumed side's answer is posted publicly, same as the
              // task-shaped resumes above.
              resumedOwnChain = true;
              resumedWaitingWork = true;
            }
          }
        }

        // NOT FOR A SHORT MESSAGE, and that is the one lookup it still skips. Every branch above asks
        // what is WAITING on this person; this one asks what this person has open at all - it is keyed
        // on the requester, so it finds chains nobody is blocked on them for, and it costs a read per
        // declared task type. Letting a bare "thanks" be absorbed by one of those is a message being
        // annexed by work it was not about, at the price of N reads on the cheapest turn there is.
        if (!activeTask && !shortAcknowledgment) {
          // EVERY declared task type, from the authoritative machines - not a hand-maintained list.
          // The literal trio this replaces omitted place_item/action_item and any pack-defined type,
          // so a continuation that missed the owner lookups found nothing here and the multi-step
          // branch opened a fresh task beside the live chain; the next machine anyone adds drifted
          // the same way with no error.
          for (const candidateType of Object.keys(taskStateMachines())) {
            activeTask = channelArn
              ? await getActiveTask(userSub, candidateType, { channelArn })
              : await getActiveTask(userSub, candidateType);
            if (activeTask) break;
          }
        }
      }
    }
    // The requester-keyed fallback and both resume branches can each be the first to name live work,
    // so the last word is taken once, here, rather than repeated at every site that assigns a task.
    liveTaskInChannel = liveTaskInChannel || !!activeTask;

    // A SHORT ANSWER TO A WAITING QUESTION IS NOT A PLEASANTRY, so the classification is corrected
    // here - once, in the same place and for the same reason as the attachment correction above. The
    // fault is the label, not the three things that read it: `getQuickResponse` answers "Let me know
    // if you have other questions" and returns, so no worker is dispatched and the chain this turn
    // just resumed gets no turn; `selectDeliveryOption` maps a greeting to DIRECT, so even without the
    // quick reply the task branch is skipped; and the exchange is attributed to the wrong intent.
    //
    // ONLY WHEN SOMETHING WAS ACTUALLY RESUMED. A person with nothing waiting on them keeps their
    // greeting, their canned reply and their unspent model call, which is what the fast path is for.
    if (resumedWaitingWork && shortAcknowledgment) {
      console.log('[Router] a short message answered work that was waiting; not treating it as a greeting', {
        classifiedAs: classification.intent,
        taskId: activeTask?.taskId,
        battleId: battleCtx?.battleId,
      });
      classification.intent = IntentType.GENERAL;
    }

    // THE ENDING IS READ FROM THE LOG THAT RECORDS IT, and only when it can still change the answer.
    //
    // The widened queries above hand back a finished chain by the MIRROR's `updatedAt`, which is when
    // the ending was mirrored rather than when it happened - a second instant for a fact
    // `stateHistory` already holds, and SPEC-TASK-STATE-TRANSITIONS §6 is explicit that the log is
    // the record and there is deliberately no `resolvedAt` beside it. So the mirror decides only
    // whether to LOOK, and the log decides.
    //
    // ONE GetItem, and it is skipped on every turn that cannot use it: a turn with live work is
    // already suppressed, and a turn with nothing recently ended has nothing to confirm. What is left
    // is a conversation whose task finished minutes ago, which is the turn this exists for.
    let recentlyEndedWithinWindow = false;
    if (!liveTaskInChannel && recentlyEndedTaskHere && channelArn) {
      const ended = await getTask(recentlyEndedTaskHere.taskId, channelArn);
      const endedAt = taskEndedAt(ended);
      recentlyEndedWithinWindow = Boolean(
        endedAt && Date.now() - Date.parse(endedAt) <= RECENTLY_ENDED_WINDOW_MS,
      );
      if (recentlyEndedWithinWindow) {
        console.log('[Router] work finished here a moment ago; this turn is read as being about it', {
          taskId: recentlyEndedTaskHere.taskId,
          taskType: recentlyEndedTaskHere.taskType,
          endedAt,
          windowMinutes: RECENTLY_ENDED_TASK_WINDOW_MINUTES,
        });
      }
    }

    // WHETHER THIS TURN CONTINUES HERE, decided in ONE named place (`lib/task-continuity.ts`) rather
    // than as a boolean assembled in the argument list below. The inputs are what this turn already
    // read; the RULE is what is going to change.
    //
    // WHAT IT DOES TODAY IS AN INTERIM, and blunter than the intent: any live task in this
    // conversation means continue here, whatever the person just said. The target design asks TWO
    // questions - is the message unrelated to the TASK, and if so is it also unrelated to the
    // CONVERSATION - and only the second is drift. Read `task-continuity.ts` before changing this: it
    // carries the target, the cost this interim accepts (while a task is open, a genuinely new
    // subject is never offered its own conversation), and the signal the two-axis version needs and
    // does not have.
    const continuity = resolveTaskContinuity({
      liveTaskInChannel,
      recentlyEndedTaskInChannel: recentlyEndedWithinWindow,
    });

    const driftResponse = await runLiveDriftFlow({
      event,
      channelArn,
      userMessage,
      userSub,
      classification: effectiveClassification as 'basic' | 'standard' | 'premium',
      botArn,
      intent: classification.intent,
      // The field name is the WIRE contract: `detectDrift` runs in the data-plane Lambda and this
      // value crosses that boundary as JSON, so it is deliberately not renamed to match the widened
      // meaning. Renaming it would mean a router and a data plane deployed minutes apart disagree
      // about a field, and the failure would be silent - the suppression simply stops, exactly as it
      // did here. `taskSignal` is additive for the same reason: an older data plane that has never
      // heard of it still suppresses, and only loses the finer counter.
      activeTaskInProgress: continuity.continueHere,
      taskSignal: continuity.signal,
    });
    if (driftResponse) {
      return formatLexResponse(event, driftResponse.messages, driftResponse.sessionAttributes);
    }

    // BATTLE SIDE RESOLUTION, on the turn path (MESSAGE-FLOW §3.2, DESIGN-BATTLE §5a).
    //
    // A duel is an interactive A/B test, so a battle turn is only worth something if it is what a
    // production turn would have been. Resolving this in the fan-out made a SECOND resolution path,
    // and a second path diverges silently - the duel still answers, so nothing errors. That is how an
    // image duel ran as a text duel for three sessions.
    //
    // Note what is battle-specific and why it is legitimate: variant SELECTION is deterministic
    // (this side is control, that side is treatment) rather than probabilistic, which IS the
    // experiment; and DIRECT is never chosen, because a duel always produces a generated reply.
    // Everything downstream of the selected variant is the ordinary resolution.
    const battleSide = battleCtx
      ? await resolveBattleSide({
          altSlotArn: battleCtx.altSlotArn,
          selfBotArn: battleCtx.selfBotArn,
          intent: classification.intent,
        })
      : null;

    const deliveryOptionName = battleSide
      ? battleSide.deliveryOption
      : intentToDeliveryOption(classification.intent);

    // Resolve A/B experiment (if any active experiment matches this classification + intent)
    let experimentId: string | undefined;
    let variantId: string | undefined;
    let resolvedModel: string | undefined;
    let resolvedImageModelKey: string | undefined;
    let resolvedVariantProfile: ProfileDefinition | undefined;

    // A DUEL DOES NOT DRAW A PROBABILISTIC ASSIGNMENT. Its sides are already assigned - that is what
    // makes it a controlled comparison rather than two samples - so the ordinary resolver is skipped
    // and this side's variant is used instead. Attribution rides the SAME top-level fields either
    // way, which is what lets a battle exchange reach the decision loop it exists to feed.
    if (battleSide) {
      experimentId = battleSide.selfVariant?.experimentId;
      variantId = battleSide.selfVariant?.variantId;
      resolvedImageModelKey = battleSide.selfVariant?.imageGenModelKey;
      resolvedVariantProfile = battleSide.selfVariant?.variantProfile;
      console.log('[Router][battle] side resolved', {
        battleId: battleCtx?.battleId,
        round: battleCtx?.round,
        experimentId,
        variantId,
        displayName: battleSide.selfVariant?.displayName,
        deliveryOption: deliveryOptionName,
        imageGenModelId: battleSide.imageGenModelId,
      });
    } else if (channelArn && classification.intent !== IntentType.GREETING && classification.intent !== IntentType.ACKNOWLEDGMENT) {
      try {
        const catalog = getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
        const experiment = await resolveExperimentModel(effectiveClassification as 'basic' | 'standard' | 'premium', classification.intent, channelArn, catalog);
        if (experiment) {
          experimentId = experiment.experimentId;
          variantId = experiment.variantId;
          resolvedModel = experiment.bedrockModelId;
          // Image experiment: the variant's image model serves the image_generation turn in the normal
          // flow (the worker's resolveTurnImageGenModelId honors it above the profile's models.image).
          resolvedImageModelKey = experiment.imageGenModelKey;
          // §6: a profileRef variant carries its whole version (persona, tools, classifier mode,
          // guardrail, machines, context sources). Absent for a lightweight modelKey variant.
          resolvedVariantProfile = experiment.variantProfile;
          console.log('[Router] Experiment resolved', {
            experimentId, variantId, modelKey: experiment.modelKey, imageGenModelKey: experiment.imageGenModelKey,
            variantConfigId: experiment.configId, variantProfileVersion: experiment.variantProfile?.profileName,
          });
        }
      } catch (error) {
        console.error('[Router] Experiment resolution failed (continuing without):', error);
      }
    }

    // A CLASSIFICATION experiment is attributed on the SAME fields (DESIGN §5.4).
    //
    // Its variant changed which model LABELLED this turn, which is a real assignment and belongs on
    // the exchange: the analytics rollup keys on `experimentId`, so without this the type produced no
    // rows at all - an empty results view, no recommendation, and §5.4's online confirm with nothing
    // to read. The classifier ids were resolved above and only logged.
    //
    // Reusing the fields cannot collide: the mutual-exclusion rule (§11.1) guarantees a classification
    // experiment never coexists with a response-model one on a classification, so exactly one of the
    // two resolutions can be non-null. The fallback is written that way round - response model first -
    // so if that invariant ever breaks, the response-model attribution wins and this is inert rather
    // than silently relabelling A/B traffic.
    //
    // EXPECT BOTH VARIANTS TO SHOW THE SAME MODEL in the results table. That is correct: this
    // experiment changes the classifier, not the responder. The difference it makes shows up in the
    // downstream outcome metrics, and its direct measurement is the §5 gate, not `avg_score`.
    //
    // GATED ON THE CLASSIFIER HAVING ACTUALLY RUN. `classifierModelId` is set only on the LLM path;
    // a greeting or acknowledgement is answered by the fast path in `fastPathIntent` without asking
    // any model, so the variant did nothing on that turn. Attributing those would pad the experiment
    // with exchanges it never touched - the same "wrong set" error the drill-down exists to prevent,
    // arriving one layer earlier where no reconciliation can catch it.
    if (!experimentId && classifierExperimentId && classification.classifierModelId) {
      experimentId = classifierExperimentId;
      variantId = classifierVariantId;
      console.log('[Router] Attributing turn to CLASSIFICATION experiment', {
        experimentId, variantId, classifierModelId: classification.classifierModelId,
      });
    }

    console.log('[Router]', {
      effectiveClassification,
      classifiedIntent: classification.intent,
      confidence: classification.confidence,
      deliveryOption: deliveryOptionName,
      experimentId,
      variantId,
    });

    // DIRECT delivery for greetings/acknowledgments (all classifications)
    //
    // A DUEL NEVER TAKES THIS PATH (ADR-026, DESIGN-BATTLE). `DIRECT` answers from the handler and
    // dispatches no worker, so a battle side that took it would never run its battle path: no
    // `markBotCompleted`, no `round1Reply`, and the row left at `INVOKED` until the orchestrator reports
    // "didn't finish in time" for a side that in fact answered instantly. The duel then closes with two
    // canned greetings and no comparison.
    //
    // Reachable, not theoretical: the flow strips the command before dispatch (`stripBattleCommand`), so
    // `/battle hello` arrives at the classifier as `hello` and classifies as a greeting.
    //
    // A CONTINUATION NO LONGER ARRIVES HERE AS A GREETING AT ALL. Answering a clarifying question with
    // "ok" or "thanks" is an ACKNOWLEDGMENT carrying a whole chain, and `!battleCtx` never caught it:
    // a flow-callback turn has no battle context. That turn is relabelled GENERAL above, on the lookup
    // that finds the work it answers, so what reaches this guard is the pleasantry it was written for.
    //
    // The fan-out used to enforce this itself; the round-1 handoff moved the decision here and did not
    // bring the guard with it. Falling through to `PLACEHOLDER_UPDATE` costs a duel one model call and
    // keeps every state transition intact.
    if (!battleCtx
        && (classification.intent === IntentType.GREETING
          || classification.intent === IntentType.ACKNOWLEDGMENT)) {
      const quickResponse = getQuickResponse(lexIntentName, userMessage);
      if (quickResponse) {
        return formatLexResponse(event, [{ contentType: 'PlainText', content: quickResponse }]);
      }
    }

    // Per-turn correlation id, threaded through the async processor, tasks and metrics so one
    // turn's records join up, and embedded in the placeholder as `<!--corr:{id}-->` so the processor
    // can find the message to update.
    //
    // DERIVED, not random (ADR-022). One user message sometimes produces TWO fulfillments of the same
    // turn, downstream of the channel flow and beyond its reach. A random id per fulfillment gives
    // each attempt its own label, so two placeholders appear and two answers land. Deriving it from
    // the turn makes both attempts share the label, so the processor's dedup claim collapses them and
    // the flow denies the second placeholder. `CHIME.message.id` cannot serve here: Chime sends
    // exactly three request attributes (channel arn, sender arn, lex platform) and that is not among
    // them.
    //
    // NOT a "fulfillment that did not answer in time" - see `lib/correlation.ts` for the measurement
    // that rules a timeout out (a 4222ms turn was not duplicated; a 3055ms one was).
    //
    // DECLARED WHEN THE CALLER CAN DECLARE IT. A bypass supplies the inbound `MessageId`, which is
    // stable across a redelivery, so its correlation id is exact rather than window-derived. The Lex
    // path has no such id (see above) and keeps the derivation. Same id for the same turn either way -
    // only the evidence it is built from differs.
    //
    // A FULLY DECLARED id wins over both. `/battle` mints its own per side, because the battle state
    // row keys on it and has to exist before dispatch so the orchestrator can see the side in flight.
    const declaredCorrelationId = event.requestAttributes?.[BYPASS_CORRELATION_ATTR];
    const declaredMessageId = event.requestAttributes?.[BYPASS_MESSAGE_ID_ATTR];
    const correlationId = declaredCorrelationId
      ? declaredCorrelationId
      : declaredMessageId
        ? mentionCorrelationId(declaredMessageId)
        : turnCorrelationId({
            channelArn,
            senderArn: event.requestAttributes?.['CHIME.sender.arn'] || '',
            userMessage,
          });

    // Collapse a DUPLICATE fulfillment (ADR-022). A second fulfillment of the same turn arrives after
    // the channel flow released the message, so nothing upstream can gate it; the derived correlation
    // id makes it recognisable here. Claimed under a separate namespace from the processor's own
    // dispatch claim: this one collapses two FULFILLMENTS, that one collapses two executions of a
    // single dispatch.
    //
    // The cause is unestablished and is NOT a response-time retry - `lib/correlation.ts` records the
    // measurement. It is rare (1 turn in 52 over 24h) and independent of turn latency.
    //
    // The claim is taken before the work rather than after, so a fulfillment that fails midway is not
    // retried. That is the correct trade here: the alternative leaves duplicate placeholders, and the
    // claim expires, whereas a stranded bubble does not.
    if (!(await claimCorrelation(`fulfil-${correlationId}`))) {
      // IDEMPOTENT, NOT SILENT. Return the SAME placeholder the winning fulfillment returned, carrying
      // the SAME `<!--corr:{id}-->` marker, and do no work: the winner already dispatched the
      // processor, opened any task, and spent the abuse gate.
      //
      // WHY NOT AN EMPTY ENVELOPE, WHICH THIS USED TO RETURN. Because the LOSER's response is often the
      // one the user actually sees. Amazon Chime SDK materialises ONE message per turn, from the LAST
      // fulfillment response, so silencing the second attempt silences the only response that reaches
      // the channel. Traced live 2026-08-06 on an ordinary turn: fulfillment A resolved
      // `PLACEHOLDER_UPDATE` in 3055ms, claimed the correlation and dispatched the processor; its
      // response was discarded; fulfillment B arrived 3.5s later, lost the claim, and returned the
      // empty envelope - which became the channel's ONLY bot message. The processor then polled 22s
      // for A's placeholder, logged `No placeholder for correlationId`, and the user's question went
      // unanswered. The dedup had its assumption backwards: it silenced the winner.
      //
      // Returning the same placeholder makes the two attempts interchangeable, which is what
      // idempotency means here - same turn in, same response out. Whichever one materialises carries
      // the marker, so the single dispatched processor finds it and updates it in place.
      //
      // SAFE IF BOTH EVER MATERIALISE. Bot messages created from a Lex return DO pass through the
      // channel flow (verified 2026-08-06: the flow was invoked for the exact MessageId of a
      // Lex-created bot message), so the flow's duplicate-placeholder guard claims the correlation
      // against the first MessageId and DENIES a second placeholder carrying the same marker. Two
      // "One moment..." bubbles therefore cannot both land.
      //
      // The copy may differ from the winner's when the winner used a task-specific placeholder. That
      // is immaterial: only one message survives, and the MARKER - not the wording - is what the
      // processor resolves on.
      // UNLESS THE WINNER WAS GATE-BLOCKED. The claim above runs BEFORE the abuse gate (so a
      // duplicate cannot double-meter the user), which means a winner can take the claim and then be
      // refused - it dispatched nothing and returned the block notice, not a placeholder. Replaying
      // the placeholder here would post a waiting bubble no worker will ever update, and Chime
      // materialising the LAST response would discard the notice the person should see. A gate
      // block is fast and never hits the Lex retry timeout, so the winner's notice DID materialise;
      // the correct duplicate response is the empty envelope, which materialises nothing over it.
      if (await hasCorrelationClaim(`fulfil-blocked-${correlationId}`)) {
        console.log('[Router] duplicate of a gate-blocked fulfillment: staying silent so the notice stands', { correlationId });
        return formatLexSilentResponse(event);
      }
      console.log('[Router] duplicate fulfillment: replaying the same placeholder', { correlationId });
      return formatLexResponse(event, [{
        contentType: 'PlainText',
        content: `One moment... <!--corr:${correlationId}-->`,
      }]);
    }

    // Per-user rate limit (SPEC-ABUSE-CONTROLS): enforce the EFFECTIVE classification's hourly
    // ceiling before any budget spend or dispatch. Over limit -> short "try again in N min" reply,
    // no Bedrock. The ceiling is the profile's rateLimitPerHour (config, always defined for a known
    // classification); 0/undefined disables it. Counter is per-user; the effective classification is
    // min(channel, user), so a user is capped at the more restrictive of the two.
    // Shared gate (SPEC-ABUSE-CONTROLS): the rate-limit-then-budget order + reject-message selection
    // live in lib/abuse-controls (evaluateAbuseGate), so the router and the channel-flow @all/battle
    // paths enforce them identically. Over limit/budget -> serve the notice and do NOT dispatch (no
    // Bedrock cost). The ceiling is the effective classification's profile rateLimitPerHour (min of
    // channel + user); isExemptAdmin forwards the opt-in per-user exemption (never the global budget).
    //
    // A BATTLE TURN IS NOT METERED HERE, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT (owner,
    // 2026-08-09, DESIGN-BATTLE). One `/battle` is ONE user action that becomes TWO turns. The
    // channel flow gates the duel as a whole before it fans out, so metering again per side would
    // charge a duel three times over - and worse, a rejection could land BETWEEN the sides, leaving
    // one answer with nothing to compare it against. A rejected arm is indistinguishable in the
    // results from an arm that answered badly, so that is measurement bias in an experiment, not a UX
    // wrinkle. Gating once, upstream, is what makes a duel refuse or run as a whole.
    //
    // This is the one battle-shaped branch in the handler. It is not a licence for others: what is
    // special here is that the caller already authorised BOTH turns, which is true of nothing else.
    // Only a DECLARED battle context skips the gate (see meteredUpstream above): a resumed side's
    // synthesized context is a real, un-gated user turn and pays like one.
    if (battleCtx && meteredUpstream) {
      console.log('[Router] battle turn: metered once by the flow for the whole duel, not per side', {
        battleId: battleCtx.battleId,
        round: battleCtx.round,
      });
    } else {
      const gate = await evaluateAbuseGate({
        userSub,
        rateCeiling: profiles.profileFor(effectiveClassification).rateLimitPerHour ?? 0,
        isAdmin: isExemptAdmin,
      });
      if (!gate.allowed) {
        console.warn(`[Router] ${gate.reason} gate blocked dispatch; serving notice`, { effectiveClassification, userSub: userSub.slice(0, 8) });
        // Mark the block beside the fulfillment claim, so a duplicate delivery of this same turn
        // knows the winner dispatched NOTHING and stays silent instead of replaying a placeholder
        // no worker will ever update. Best-effort: an unwritten marker degrades to the old replay.
        await claimCorrelation(`fulfil-blocked-${correlationId}`).catch(() => true);
        return formatLexResponse(event, [{ contentType: 'PlainText', content: gate.message }]);
      }
    }

    // Domain grounding: forward the domain context
    // stamped into channel Metadata so the async processor renders it into the system prompt.
    // Force-refresh so an edited plan (re-stamped each session by the host) is never served
    // stale from a warm container's metadata cache. Absent for non-plan AE channels ⇒ the
    // fields stay undefined and the processor's formatDomainContextForPrompt is a no-op.
    // Host grounding: member-readable routing bits + roster from channel Metadata, and the PRIVATE
    // grounding (domain context / participant profile / ...) from the server-only Channel Context
    // store. assembleHostGrounding enforces the P1 split (private fields never read from Metadata).
    let domainGrounding: Record<string, unknown> = {};
    // The context id (= the conversation's contextId, stamped by create-conversation) anchors a
    // place_item task to its plan. Undefined for non-plan AE channels.
    let contextId: string | undefined;
    if (channelArn) {
      const contextMeta = await resolveChannelMetadata(channelArn, botArn, true);
      // WHO is in the conversation comes from Chime membership, resolved live, with names from the
      // IdP — never from a roster written at creation time, which drifts the moment anyone joins or
      // leaves and then grounds the prompt on people who are not here.
      const grounding = await assembleHostGrounding(channelArn, contextMeta, {
        listHumanMemberSubs: async () =>
          (await getHumanMemberArns(channelArn, botArn)).map((a) => a.split('/user/').pop() || '').filter(Boolean),
        resolveName: resolveMemberName,
      });
      domainGrounding = grounding.domainGrounding;
      contextId = grounding.contextId;
    }

    // P3 (D2): per-intent response shaping (maxTokens/verbosity) from the pack — forwarded in the
    // event so the processor can size the answer per intent (e.g. tight logistics, longer research).
    // Empty ⇒ omitted ⇒ the processor uses its default budget.
    const responseSettings = responseSettingsForIntent(classification.intent);
    const hasResponseSettings = Object.keys(responseSettings).length > 0;

    // P4 config attribution: the handler holds the intent pack, so it forwards the pack's version
    // (short hash of the raw pack JSON — which already includes per-intent response settings — or
    // 'default'). The processor combines it with the persona it resolves into the turn's `configId`.
    const intentPackVersion = componentVersion(activeIntentPackRaw());

    // First-turn greeting (A3): resolve the sender's display name (Cognito, cached) and forward it so
    // the async processor greets the user by name on their FIRST turn — where the identity is settled,
    // unlike the racy channel-creation WelcomeIntent. Cached per warm container; a federated or
    // unresolvable sender falls back to 'there', which the processor treats as "no name".
    const senderDisplayName = await resolveUserName(
      (event.requestAttributes?.['CHIME.sender.arn'] || '').split('/user/').pop() || '',
    );

    // THE WORKER'S BATTLE PAYLOAD, DEFINED ONCE (ADR-026).
    //
    // Both dispatch branches need it, and only one of them had it. `TASK_MULTI_STEP` omitted
    // `battleContext` entirely, so a task-shaped duel never entered the worker's battle path at all: no
    // `markBotCompleted`, no `round1Reply` captured, no `<!--battle:-->` marker on the placeholder. The
    // orchestrator then reported "didn't finish in time" for BOTH sides and closed the duel. It also
    // dropped `variantProfile`, so a `profileRef` variant silently served the profile's ACTIVE version -
    // the same defect class as the worker's second profile resolution, in a second place.
    //
    // A second copy of a payload is where that hides, because the duel still answers either way. One
    // definition, two consumers, so they cannot drift apart again.
    const workerBattleFields = battleCtx && battleSide
      ? {
          battleContext: {
            battleId: battleCtx.battleId,
            round: battleCtx.round,
            totalRounds: battleCtx.totalRounds,
            selfBotArn: battleCtx.selfBotArn,
            rivalBotArn: battleCtx.rivalBotArn,
            ...(battleCtx.rivalReply !== undefined && { rivalReply: battleCtx.rivalReply }),
            ...(battleCtx.rivalReplyMsgId && { rivalReplyMsgId: battleCtx.rivalReplyMsgId }),
            ...(battleCtx.rivalDidNotFinish && { rivalDidNotFinish: true }),
            ...(battleCtx.clearWaitingMarkerMessageId && {
              clearWaitingMarkerMessageId: battleCtx.clearWaitingMarkerMessageId,
            }),
            ...(battleCtx.originatingMessageId && { originatingMessageId: battleCtx.originatingMessageId }),
            ...(battleCtx.imageAttachment && { imageAttachment: battleCtx.imageAttachment }),
            ...(battleSide.imageGenModelId && { imageGenModelId: battleSide.imageGenModelId }),
            ...(battleSide.selfVariant?.modelKey && { variantModelKey: battleSide.selfVariant.modelKey }),
            ...(battleSide.selfVariant?.systemPromptAddendum && {
              variantAddendum: battleSide.selfVariant.systemPromptAddendum,
            }),
            ...(battleSide.selfVariant?.displayName && { selfDisplayName: battleSide.selfVariant.displayName }),
            ...(battleSide.rivalVariant?.displayName && { rivalDisplayName: battleSide.rivalVariant.displayName }),
            ...(battleSide.selfVariant?.imageGenModelKey && {
              variantImageModelKey: battleSide.selfVariant.imageGenModelKey,
            }),
          },
        }
      : {};

    /** Fields every dispatch owes the worker regardless of delivery option. */
    const workerCommonFields = {
      // WHAT CAUSED THIS TURN, forwarded so the measurement can tell one cause from another.
      //
      // This attribute was declared and written and then read by NOTHING, which made its own doc
      // comment wrong: it claimed to keep rebuttals out of the TTFF average, while that exclusion was
      // actually structural (a rebuttal pairs to no user message, so it never entered the average in
      // the first place). Forwarding it is what makes the claim true rather than incidental, and it
      // is what lets a REPAIRED turn - one re-driven after a failure - be told apart from a person
      // waiting, instead of being counted as one very slow answer.
      ...(event.requestAttributes?.[BYPASS_TRIGGER_ATTR] && {
        trigger: event.requestAttributes[BYPASS_TRIGGER_ATTR] as 'user' | 'orchestrator',
      }),
      ...(turnAttachment && { attachment: turnAttachment }),
      // SPEC-PORTABLE §6: a profileRef variant runs its whole version, so the definition rides the
      // event. Resolved once here; the worker applies it without a second read.
      ...(resolvedVariantProfile && { variantProfile: resolvedVariantProfile }),
      // A continuation answers onto the side's EXISTING waiting message rather than a new one.
      ...(event.requestAttributes?.[BYPASS_PLACEHOLDER_ATTR] && {
        placeholderMessageId: event.requestAttributes[BYPASS_PLACEHOLDER_ATTR],
      }),
      // The answer to a privately-answered chain belongs to the CHANNEL (see `resumedOwnChain`): the
      // targeted reply stays an acknowledgement, and the worker broadcasts the answer itself.
      ...(resumedOwnChain && { broadcastAnswer: true }),
      // A HANDED-OVER TURN OWES THE ANSWER AND NOTHING ELSE. The assistant that received the person's
      // message already gave them their receipt, naming this one as the assistant acting, so a second
      // receipt here would tell them the same message was picked up twice by different assistants.
      ...(handedOverFrom(event) && { suppressAcknowledgement: true }),
    };

    // Task tracking runs on EVERY classification. The router is the single Lex entry point for all
    // classifications (deployed per-classification via STATIC_CLASSIFICATION); tasks are a platform
    // capability, not a standard/premium-only one. getActiveTask/createTask are classification-agnostic, and basic
    // tracks tasks in DynamoDB too (grounds the prompt + stamps task_id + advances state, taskSupport:'full');
    // richProcessor:false only omits basic's rich OUTPUT (generated docs), not its task tracking.
    // The `classification.intent` used for task-type routing came from the profile's classifier above
    // (LLM by default for every classification, basic included; the keyword path only for a
    // keyword-mode profile), so task intents (report_generation/data_extraction/…) are resolved
    // the same way at every classification. A bare block keeps taskId/taskType scoping local.
    {
      // `activeTask` was resolved above (hoisted so the drift check could consume it too).
      // The lookup is scoped to the CURRENT channel (P2.4) — resuming a task from a
      // different channel would silently fail when the async processor looks up
      // the task by (taskId, channelArn), since that table is keyed by
      // both. Cross-channel awareness is surfaced separately by the
      // async processor via getActiveTasksForUser + buildCrossChannelTasksHint
      // at prompt-build time, where it belongs.
      const hasActiveTask = !!activeTask;
      // A duel side uses the delivery option resolved for its side, never the ordinary selection.
      // `selectDeliveryOption` folds in `hasActiveTask`, which is wrong for a battle: each side gets
      // its OWN task (the owner decision behind `hasActiveTaskForBot`), so a duel must not be
      // absorbed into whatever task the user already had open in the channel.
      const deliveryOption = battleSide
        ? battleSide.deliveryOption
        : selectDeliveryOption(classification.intent, hasActiveTask);

      // RAG retrieval (ADR-001 + ADR-002 proof-point) — runs in the
      // router because the router is the VPC-attached Lambda with
      // Aurora access when ENABLE_LIVE_DRIFT is on. The async
      // processors are not VPC-attached, so retrieval happens here
      // and the chunks + citations ride the InvokeAsync payload.
      // Best-effort: a failed retrieval (no Aurora, embedding error,
      // empty corpus) returns null and the agent reply proceeds
      // without RAG context.
      // Retrieval + summary run in parallel (both hit the data-plane Lambda), so
      // adding summary-as-context costs no extra wall-clock. Both are best-effort
      // and null when unavailable (ADR-017).
      const [retrievedContext, conversationSummary] = await Promise.all([
        maybeRetrieveContext(userMessage, effectiveClassification, classification.intent),
        maybeGetSummary(channelArn, classification.intent),
      ]);

      // TASK_MULTI_STEP: Create or continue task
      if (deliveryOption === DeliveryOption.TASK_MULTI_STEP) {
        let isNewTaskForBattle = false;
        let taskId: string;
        let taskType: string;
        let taskState: string | undefined;
        // The OPEN edge, declared where it happens: true only on the two branches that call
        // createTask this turn. The worker carries it into the analytics record as a from-less
        // transition, which is what the turn-events projection reads as task_opened.
        let taskCreated = false;

        // CONTINUE BEFORE CREATE, FOR A DUEL SIDE TOO (ADR-026).
        //
        // The battle branch used to be tested FIRST, so a resumed side called `createBattleTask` every
        // turn and restarted its state machine from state 0 - the report it had already collected
        // requirements for began again, and the abandoned chain sat `in_progress` until TTL. The
        // owner lookup above (`getActiveTaskForOwner`, the whole reason `planBattleResume` left the
        // flow) was resolved and then ignored for the task decision.
        //
        // `activeTask` is already owner-scoped: for a duel side it is that SIDE's chain in this channel,
        // never the human's and never the rival's, so continuing it cannot absorb someone else's work.
        if (activeTask) {
          taskId = activeTask.taskId;
          taskType = activeTask.taskType;
          taskState = activeTask.taskState;
        } else if (battleCtx && battleSide?.taskType) {
          // A DUEL'S TASK IS AN ORDINARY TASK WHOSE OWNER IS AN ASSISTANT (ADR-024 D1, ADR-026).
          //
          // ONE CREATION DOOR. This used to call `createBattleTask`, a near-duplicate of `createTask`
          // that differed only in taking its channel/user explicitly, stamping `battleId`, and forcing
          // an assistant owner. Once ADR-024 made "the owner may be an assistant" first-class, the
          // second door bought nothing and cost something real: because it was a separate branch, it was
          // tested BEFORE the ordinary active-task branch, and a resumed side therefore created a fresh
          // task every turn instead of continuing its own chain.
          //
          // `battleId` is descriptive only. What keeps two sides' tasks apart is the OWNER being that
          // side, which is why one door is sufficient (ADR-024 D2).
          const battleTask = await createTask(event, deliveryOption, battleSide.taskType, correlationId, {
            owner: { id: principalIdFromArn(botArn), type: 'assistant' as const },
            battleId: battleCtx.battleId,
            // The DECODED message. `event.inputTranscript` is percent-encoded on a bypass, so reading it
            // would store `Produce%20a%20report` as the excerpt an operator reads back.
            requestExcerpt: userMessage,
            // The USER's message, when this caller holds a resolvable one (ADR-024 D5). A bypass
            // declares the inbound id; the Lex path has none to declare, and absent is the honest
            // value there rather than the correlation id standing in for it.
            ...(declaredMessageId ? { userMessageId: declaredMessageId } : {}),
          });
          taskId = battleTask.taskId;
          taskCreated = true;
          // The resolved side's taskType is the authority: `Task.taskType` is optional on the record,
          // and falling back to an empty string here would silently detach the task from its state
          // machine.
          taskType = battleSide.taskType;
          taskState = battleTask.taskState;
          isNewTaskForBattle = true;
        } else {
          taskType = classification.intent === IntentType.GUIDED_TROUBLESHOOTING
            ? 'guided_troubleshooting'
            : classification.intent === IntentType.DATA_EXTRACTION
              ? 'data_extraction'
              : classification.intent === IntentType.REPORT_GENERATION
                ? 'report_generation'
                // A configurable-pack intent (string key) → its task type.
                : classification.intent === 'place_item'
                  ? 'place_item'
                  : classification.intent === 'action_item'
                    ? 'action_item'
                    : 'general';

          // Work-item tasks (place_item / action_item) anchor to the plan + get the long plan TTL so
          // they survive until the work happens. An `action_item` also gets a
          // default assignee = the requester (the persona asks who on a shared plan; reassign later).
          // Enterprise tasks pass no opts.
          const requesterSub =
            event.requestAttributes?.['CHIME.sender.arn']?.split('/user/').pop() || undefined;
          const taskOpts: TaskCreateOptions | undefined =
            taskType === 'place_item'
              ? { contextId, ttlSeconds: TRIP_TASK_TTL_SECONDS }
              : taskType === 'action_item'
                ? {
                    contextId,
                    ttlSeconds: TRIP_TASK_TTL_SECONDS,
                    ...(requesterSub ? { owner: { id: requesterSub, type: 'user' as const } } : {}),
                  }
                : undefined;
          // The turn's correlationId ties the task to the rest of that turn's records (async
          // processor, metrics). It is NOT a message id and is no longer stored as one (ADR-024 D5):
          // the user's message id is carried separately, and stays absent on this path rather than
          // being filled with the correlation key. The duplicate-task guard is getActiveTask's
          // strongly-consistent recheck.
          const task = await createTask(event, deliveryOption, taskType, correlationId, {
            ...(taskOpts ?? {}),
            // Whose work this is: the assistant running this turn (the validated identity from
            // ADR-025, same value the battle branch derives its owner from). Without it the mirror
            // row has no assistantId, and the composer's "Answering..." affordance - which resolves
            // the ADDRESSEE from this field - cannot render, so in a shared conversation the person's
            // answer goes unaddressed and only the stream-side repair can save the turn. Every
            // ordinary task was shipping that way; only duel tasks carried it, via their owner.
            // Distinct from `owner` on purpose: an action_item's owner is the requester (a person),
            // but the work still belongs to this assistant.
            assistantId: principalIdFromArn(botArn),
            // Decoded, for the same reason the battle branch passes it: an `@all` task turn is a bypass
            // too, so its transcript is percent-encoded and the stored excerpt was unreadable.
            requestExcerpt: userMessage,
            ...(declaredMessageId ? { userMessageId: declaredMessageId } : {}),
          });
          taskId = task.taskId;
          taskState = task.taskState;
          taskCreated = true;
        }

        if (asyncProcessorArn && channelArn) {
          await invokeAsync(asyncProcessorArn, {
            channelArn,
            correlationId,
            userMessage,
            userType: effectiveClassification,
            taskId,
            taskType,
            taskCreated,
            botArn,
            // A resumed duel side IS a continuation (ADR-026). This was hardcoded `false` for every
            // battle turn on the reasoning that a duel side's task is always fresh - true only while the
            // battle branch created one unconditionally. Now that a side continues the chain it owns,
            // telling the worker otherwise would have it re-open work already in flight.
            //
            // `activeTask` is owner-scoped, so for a duel side it is that side's own chain: the case the
            // old comment worried about (an unrelated open task in the channel making a battle look like
            // a resumption) cannot arise from this lookup.
            isTaskContinuation: !isNewTaskForBattle && !!activeTask,
            senderArn: event.requestAttributes?.['CHIME.sender.arn'],
            senderDisplayName,
            // Reply visibility (targeted vs broadcast) is derived from the
            // placeholder's actual Target in the async processor, not passed
            // here - the router cannot see the inbound message's Target.
            intent: classification.intent,
            intentConfidence: classification.confidence,
            deliveryOption,
            ...(resolvedModel && { resolvedModel }),
            ...(resolvedImageModelKey && { resolvedImageModelKey }),
            ...(experimentId && { experimentId }),
            ...(variantId && { variantId }),
            ...(retrievedContext && { retrievedContext }),
            ...(conversationSummary && { conversationSummary }),
            ...(hasResponseSettings && { responseSettings }),
            intentPackVersion,
            ...workerCommonFields,
            ...workerBattleFields,
            ...domainGrounding,
          });
          spoke.dispatched = true;
        }

        // A DUEL SIDE'S PLACEHOLDER CARRIES THE BATTLE MARKER, on this branch too. Without it the
        // frontend does not render the turn as a duel side, so a task-shaped duel showed two ordinary
        // task placeholders and no scorecard. The `name=` part is this side's resolved display name,
        // which is why composing it belongs to the turn rather than the caller.
        if (battleCtx && battleSide) {
          return formatLexResponse(event, [{
            contentType: 'PlainText',
            content: battlePlaceholderContent({
              correlationId,
              battleId: battleCtx.battleId,
              round: battleCtx.round,
              totalRounds: battleCtx.totalRounds,
              rivalBotArn: battleCtx.rivalBotArn,
              displayName: battleSide.selfVariant?.displayName,
              rivalReplyMsgId: battleCtx.rivalReplyMsgId,
              // The task placeholder is the visible copy; the markers ride behind it.
              lead: getTaskPlaceholder(deliveryOption, taskType, taskState),
            }),
          }], { taskId, taskType });
        }

        const placeholder = getTaskPlaceholder(deliveryOption, taskType, taskState);
        return formatLexResponse(event, [{
          contentType: 'PlainText',
          content: `${placeholder} <!--corr:${correlationId}-->`,
        }], { taskId, taskType });
      }
    }

    // RAG retrieval + summary for the PLACEHOLDER_UPDATE path. The effective classification
    // comes from the basic short-circuit above; the intent classifier has the intent.
    // Skipped automatically when ENABLE_LIVE_DRIFT is off (no Aurora). Parallel.
    const [placeholderRetrievedContext, placeholderSummary] = await Promise.all([
      maybeRetrieveContext(userMessage, effectiveClassification, classification.intent),
      maybeGetSummary(channelArn, classification.intent),
    ]);

    // PLACEHOLDER_UPDATE: General questions (all classifications)
    if (asyncProcessorArn && channelArn) {
      await invokeAsync(asyncProcessorArn, {
        channelArn,
        correlationId,
        userMessage,
        userType: effectiveClassification,
        botArn,
        senderArn: event.requestAttributes?.['CHIME.sender.arn'],
        senderDisplayName,
        // Reply visibility is derived from the placeholder's actual Target in
        // the async processor (see the task-continuation invoke above).
        intent: classification.intent,
        intentConfidence: classification.confidence,
        ...(placeholderRetrievedContext && { retrievedContext: placeholderRetrievedContext }),
        ...(placeholderSummary && { conversationSummary: placeholderSummary }),
        deliveryOption: deliveryOptionName,
        ...(resolvedModel && { resolvedModel }),
        ...(resolvedImageModelKey && { resolvedImageModelKey }),
        ...(experimentId && { experimentId }),
        ...(variantId && { variantId }),
        ...(hasResponseSettings && { responseSettings }),
        // The attachment, the profileRef definition, the handed-over placeholder id and the battle
        // coordination context, all from the single definitions above so this branch and the
        // task-shaped one cannot drift.
        ...workerCommonFields,
        ...workerBattleFields,
        intentPackVersion,
        ...domainGrounding,
      });
      spoke.dispatched = true;
    }

    // A duel side's placeholder carries the battle marker as well as the correlation marker, and the
    // `name=` part is this side's resolved display name - which is why composing it belongs to the
    // turn rather than the caller. That coupling was the only reason the fan-out resolved variants.
    if (battleCtx && battleSide) {
      return formatLexResponse(event, [{
        contentType: 'PlainText',
        content: battlePlaceholderContent({
          correlationId,
          battleId: battleCtx.battleId,
          round: battleCtx.round,
          totalRounds: battleCtx.totalRounds,
          rivalBotArn: battleCtx.rivalBotArn,
          displayName: battleSide.selfVariant?.displayName,
          rivalReplyMsgId: battleCtx.rivalReplyMsgId,
        }),
      }]);
    }

    return formatLexResponse(event, [{
      contentType: 'PlainText',
      content: `One moment... <!--corr:${correlationId}-->`,
    }]);

  } catch (error) {
    console.error('[Router] Error:', error);
    return formatLexResponse(event, [{
      contentType: 'PlainText',
      content: 'I encountered an issue. Could you try rephrasing?',
    }]);
  }
};

/**
 * RAG retrieval — gated on the same condition as live drift (Aurora
 * hookup present + ENABLE_LIVE_DRIFT=true). Returns null when the
 * gate is off, when retrieval fails, or when the corpus has no
 * matches above the similarity threshold.
 *
 * Why piggyback on the drift flag for now: both features need the
 * VPC + RDS Proxy + DB env vars + Titan embed IAM. The deploy story
 * is simpler with one toggle. A future `enableRag` flag could
 * decouple them; not in this proof-point's scope.
 */
/**
 * Every corpus the router pre-fetches from, by `source_type`.
 *
 * A source_type is the FIRST PATH SEGMENT under `rag/` (`document-ingestion.ts:deriveSourceType`), so
 * uploading to a new prefix silently mints a new type - and a type absent from this list is embedded,
 * stored, and never retrieved. That is not a hypothetical: `rag/agentechelon/` (the platform's own
 * documentation, ingested by `sync-project-knowledge.mjs --rag`) was fully embedded and returned ZERO
 * chunks on every live query, because this list named only wiki/doc/company. Nothing errored - the
 * assistant kept answering platform questions from the curated `load_platform_info` summaries, which
 * reads as a thin answer rather than as an unreachable corpus.
 *
 * So: ADDING A PREFIX MEANS ADDING IT HERE. The list is exported for the guard that pins it
 * (`rag-source-types.test.ts`).
 *
 *  - `wiki` / `doc` - the operator's own uploaded reference corpus.
 *  - `company` - the classification-gated business/financial corpus (ADR-017), embedded under
 *    `rag/company/{classification}/` and pre-fetched here so a classification's own facts reach the
 *    model without depending on it electing to call a tool.
 *  - `agentechelon` - the platform's own docs, so "how does this work?" is answered from the
 *    documentation rather than from titles and summaries. Ingested at the LOWEST classification
 *    (public product information), so the scope ladder admits it at every rank.
 *
 * Classification scope is the same fail-closed SQL metadata filter for all of them.
 */
export const RAG_SOURCE_TYPES = ['wiki', 'doc', 'company', 'agentechelon'] as const;

async function maybeRetrieveContext(
  userMessage: string,
  classification: string,
  intent: string,
): Promise<RetrieveContextResult | null> {
  if (process.env.ENABLE_LIVE_DRIFT !== 'true') return null;

  // Skip trivial intents — no point spending an embedding call on "hi".
  if (intent === IntentType.GREETING || intent === IntentType.ACKNOWLEDGMENT) {
    return null;
  }

  try {
    // Classification-scope: a classification sees content at its rank and below (own-rank-and-below),
    // the fail-closed SQL metadata filter (ADR-007). Ladder derived from config via the registry.
    const classificationScope = profiles.scopeAtOrBelow(classification);

    const result = await retrieveContext({
      query: userMessage,
      sourceTypes: [...RAG_SOURCE_TYPES],
      topK: 6,
      classificationScope,
      // The classification itself, not just the ladder derived from it: it selects the database
      // reader role the query runs as (ADR-028). Passed independently so a mistake in the ladder
      // above cannot also widen the privilege - retrieval rejects the pair if they disagree.
      classification,
    });

    // Honest empty — no matches above the similarity threshold.
    if (result.chunks.length === 0) return null;
    return result;
  } catch (err) {
    console.warn('[Router] RAG retrieval failed (non-fatal):', err);
    return null;
  }
}

/**
 * Fetch the conversation's running summary as consumable context (ADR-017).
 * Gated exactly like retrieval: needs the data-plane (ENABLE_LIVE_DRIFT), a real
 * channel, and a non-trivial intent. The summary only exists once a conversation
 * has grown past the recent-history window, so a non-null result is also the
 * "this conversation is long enough to need its earlier thread" signal. The
 * async processor injects it; best-effort, null when unavailable.
 */
async function maybeGetSummary(
  channelArn: string | undefined,
  intent: string,
): Promise<string | null> {
  if (process.env.ENABLE_LIVE_DRIFT !== 'true') return null;
  if (!channelArn) return null;
  if (intent === IntentType.GREETING || intent === IntentType.ACKNOWLEDGMENT) return null;
  return getLatestSummary(channelArn);
}

async function getSsmValue(paramName: string): Promise<string | null> {
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
    return resp.Parameter?.Value || null;
  } catch (err) {
    console.warn(`[Router] SSM lookup failed for ${paramName}:`, err);
    return null;
  }
}

async function invokeAsync(functionName: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
  } catch (err) {
    console.error('[Router] Failed to invoke async processor:', err);
  }
}
