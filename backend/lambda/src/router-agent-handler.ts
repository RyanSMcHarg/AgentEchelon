/**
 * Router Agent Handler
 *
 * Single entry point for all Lex fulfillment. Reads channel metadata
 * to determine the conversation's classification, then routes to the correct
 * async processor (Basic/Standard/Premium) and applies classification-appropriate
 * intent classification and task tracking.
 *
 * Classification routing (single entry point for ALL classifications; deployed
 * per-classification, keyed by the CLASSIFICATION env var):
 * - basic    → classifyIntentBasic() + BASIC_ASYNC_PROCESSOR_ARN (Haiku, tasks: lightweight)
 * - standard → classifyIntent()      + STANDARD_ASYNC_PROCESSOR_ARN (Sonnet, tasks: full)
 * - premium  → classifyIntent()      + PREMIUM_ASYNC_PROCESSOR_ARN (Opus, tasks: full)
 */

import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  ChimeSDKMessagingClient,
  DescribeChannelCommand,
  ListChannelMembershipsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  classifyIntent,
  classifyIntentBasic,
  IntentType,
  intentToDeliveryOption,
} from './lib/intent-classifier.js';
import { hydrateIntentPackFromSsm, responseSettingsForIntent, activeIntentPackRaw } from './lib/intent-pack.js';
import { componentVersion } from './lib/config-identity.js';
import {
  DeliveryOption,
  selectDeliveryOption,
  getQuickResponse,
  getTaskPlaceholder,
} from './lib/delivery-options.js';
import { createTask, getActiveTask, TRIP_TASK_TTL_SECONDS, type TaskCreateOptions } from './lib/task-tracking.js';
import { checkAndConsumeBudget, budgetCannedResponse, checkRateLimit, rateLimitMessage } from './lib/abuse-controls.js';
// SPEC-CAPABILITY-PROFILES: the single interpreter of classification tags + group clearance.
// Replaces the local CLASSIFICATION_RANK / CLEARANCE_GROUPS / minRank / isAdvancedClassification / classificationScope constants.
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry.js';
// Retrieval runs in the VPC-attached data-plane Lambda (project decision 018);
// this handler stays non-VPC and invokes it via the client seam. Same signature.
import { retrieveContext, getLatestSummary, type RetrieveContextResult } from './lib/data-plane-client.js';
import { resolveExperimentModel, resolveClassificationExperiment } from './lib/experiment-manager.js';
import { getModelCatalog } from '../../lib/config/model-strategy.js';
import { randomUUID } from 'crypto';
import { runLiveDriftFlow } from './lib/live-drift-flow.js';
import { parseWelcomeOrientation, composeWelcomeMessage, type WelcomeOrientation } from './lib/welcome-orientation.js';
import {
  loadIntakeConfig,
  isOnboardingEnabled,
  startIntake,
  advanceIntake,
  readIntakeState,
  writeIntakeState,
} from './lib/onboarding-intake.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
// Per-classification bot SSM key (= /agent-echelon/assistant/{classification}/bot-arn),
// always set by the deploying classification stack. There is no shared
// '/agent-echelon/bot-arn' fallback.
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || '';
const USER_POOL_ID = process.env.USER_POOL_ID || '';
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
const userClearanceCache = new Map<string, { clearance: string; expires: number }>();
const USER_CLEARANCE_CACHE_TTL_MS = 5 * 60_000;

function minRank(a: string, b: string): string {
  return profiles.min(a, b);
}

async function resolveUserClearance(userSub: string): Promise<string> {
  if (!userSub || !USER_POOL_ID) return 'basic';
  const cached = userClearanceCache.get(userSub);
  if (cached && cached.expires > Date.now()) return cached.clearance;

  try {
    const resp = await cognitoClient.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userSub,
    }));
    const groups = (resp.Groups || []).map((g) => g.GroupName || '');
    // Highest classification the user's Cognito groups clear for (fail-closed floor if none).
    // The Lambda reads the raw group list, so the registry picks the max — group-resource
    // precedence controls the cognito:groups claim, which this path does not use.
    const clearance = profiles.clearanceForGroups(groups);

    userClearanceCache.set(userSub, { clearance, expires: Date.now() + USER_CLEARANCE_CACHE_TTL_MS });
    return clearance;
  } catch (err) {
    console.warn('[Router] Failed to resolve user clearance from groups:', err);
    return 'basic';
  }
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
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: name }));
    return resp.Parameter?.Value || undefined;
  } catch {
    return undefined;
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
  try {
    const resp = await chimeClient.send(new ListTagsForResourceCommand({ ResourceARN: channelArn }));
    const tag = (resp.Tags || []).find((t) => t.Key === 'classification')?.Value || '';
    if (profiles.isKnownClassification(tag)) return profiles.resolveClassification(tag);
    console.warn('[Router][SecurityEvent] channel missing/invalid classification tag; failing closed', { channelArn, tag, failClosedTo: profiles.failClosedValue });
    return profiles.failClosedValue;
  } catch (err) {
    console.warn('[Router] Failed to read channel classification tag; failing closed to basic:', err);
    return 'basic';
  }
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

/** Best-effort fetch of the user's display name from Cognito (custom:name
 *  → name → email-local-part → 'there'). Cached for the Lambda's warm
 *  life. Used for the WelcomeIntent context so the bot greets users by
 *  name. Never throws -- returns 'there' on any failure so the welcome
 *  path keeps working when Cognito permissions / network blip. */
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

// Welcome orientation is CONFIG-DRIVEN (SPEC: config not code). A deployment may point
// ASSISTANT_WELCOME_PARAM at an SSM param holding per-assistant orientation JSON (company, access
// blurb, example prompts, platform note) that the demo seeds; absent it, the welcome is the generic
// platform greeting. Hydrated once per container (the welcome path stays instant) — a fetch failure
// falls back to generic rather than erroring the greeting.
const WELCOME_PARAM = process.env.ASSISTANT_WELCOME_PARAM || '';
// Cache only a SUCCESSFUL load — never pin an absent/null result, so a welcome that fires before the
// param is written doesn't lock the container into the generic greeting for its whole lifetime.
let welcomeOrientationCache: WelcomeOrientation | null = null;

async function loadWelcomeOrientation(): Promise<WelcomeOrientation | null> {
  if (welcomeOrientationCache) return welcomeOrientationCache;
  if (!WELCOME_PARAM) return null;
  const parsed = parseWelcomeOrientation(await getSsmParam(WELCOME_PARAM));
  if (parsed) welcomeOrientationCache = parsed;
  return parsed;
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
// Handler
// ============================================================

export const handler = async (event: LexEvent): Promise<LexResponse> => {
  const lexIntentName = event.sessionState?.intent?.name;
  const channelArn = event.requestAttributes?.['CHIME.channel.arn'] || '';

  console.log('[Router] Invoked', { intent: lexIntentName, hasTranscript: !!event.inputTranscript });

  try {
    const botArn = await getBotArn();
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
      const triggerContext = typeof channelMeta.triggerContext === 'string' ? channelMeta.triggerContext : undefined;
      const topic = typeof channelMeta.topic === 'string' ? channelMeta.topic : undefined;

      // Onboarding welcome (opt-in): when a deployment supplies an intake schema,
      // the welcome is the richer context-gathering flow instead of the static
      // greeting. Show the greeting + the first field's question and seed the
      // intake state into sessionAttributes; the user's answers drive the FSM on
      // the following turns (see the intake interception below). Inert (config is
      // null) unless ONBOARDING_INTAKE / ONBOARDING_INTAKE_PARAM is set.
      const intakeConfig = await loadIntakeConfig(getSsmParam);
      if (isOnboardingEnabled(intakeConfig)) {
        const step = startIntake(intakeConfig);
        console.log('[Router][WelcomeIntent] onboarding intake started', { fields: intakeConfig.fields.length });
        return formatLexResponse(event, [{ contentType: 'PlainText', content: step.reply }], writeIntakeState(step.state));
      }

      const orientation = await loadWelcomeOrientation();
      const content = composeWelcomeMessage({ triggerContext, topic, orientation });
      console.log('[Router][WelcomeIntent]', {
        hasTriggerContext: !!triggerContext,
        hasTopic: !!topic,
      });
      return formatLexResponse(event, [{ contentType: 'PlainText', content }]);
    }

    // Federated users (a `fed_` AppInstanceUser from the embedded-widget exchange) do NOT
    // exist in the AE Cognito pool, so a group-based clearance lookup always throws
    // UserNotFoundException and would wrongly downgrade them to basic. Their entitlement is
    // fixed by the channel they were provisioned into (federated-create-conversation creates
    // the channel at ASSISTANT_CLASSIFICATION and they can only ever be a member of that channel), so the
    // channel classification IS authoritative for them — trust it and skip the Cognito lookup. Without
    // this, every turn downgrades to basic and the standard processor is never invoked.
    const isFederated = userSub.startsWith('fed_');
    const userClearance = isFederated ? channelClassification : await resolveUserClearance(userSub);
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

    const userMessage = decodeURIComponent(event.inputTranscript || '').trim();

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
      if (!prior || prior.phase !== 'done') {
        // No prior state ⇒ this is the first answer (the WelcomeIntent greeting
        // already showed the first question); start at the first field.
        const state = prior ?? { cursor: 0, collected: {}, phase: 'collecting' as const };
        const intakeName = await resolveUserName(userSub);
        const step = advanceIntake(intakeConfig, state, userMessage, intakeName);
        console.log('[Router][Onboarding]', { phase: step.state.phase, cursor: step.state.cursor, done: step.done });
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

    // Classify intent via the profile's classifierMode — 'llm' for all default profiles (basic
    // included), 'keyword' (classifyIntentBasic) only if a deployment selects it for a cheap profile.
    const classification = usesLlmClassifier
      ? await classifyIntent(userMessage, { modelId: classifierModelId })
      : classifyIntentBasic(userMessage);

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
    const driftResponse = await runLiveDriftFlow({
      event,
      channelArn,
      userMessage,
      userSub,
      classification: effectiveClassification as 'basic' | 'standard' | 'premium',
      botArn,
      intent: classification.intent,
    });
    if (driftResponse) {
      return formatLexResponse(event, driftResponse.messages, driftResponse.sessionAttributes);
    }

    const deliveryOptionName = intentToDeliveryOption(classification.intent);

    // Resolve A/B experiment (if any active experiment matches this classification + intent)
    let experimentId: string | undefined;
    let variantId: string | undefined;
    let resolvedModel: string | undefined;

    if (channelArn && classification.intent !== IntentType.GREETING && classification.intent !== IntentType.ACKNOWLEDGMENT) {
      try {
        const catalog = getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
        const experiment = await resolveExperimentModel(effectiveClassification as 'basic' | 'standard' | 'premium', classification.intent, channelArn, catalog);
        if (experiment) {
          experimentId = experiment.experimentId;
          variantId = experiment.variantId;
          resolvedModel = experiment.bedrockModelId;
          console.log('[Router] Experiment resolved', { experimentId, variantId, modelKey: experiment.modelKey });
        }
      } catch (error) {
        console.error('[Router] Experiment resolution failed (continuing without):', error);
      }
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
    if (classification.intent === IntentType.GREETING ||
        classification.intent === IntentType.ACKNOWLEDGMENT) {
      const quickResponse = getQuickResponse(lexIntentName, userMessage);
      if (quickResponse) {
        return formatLexResponse(event, [{ contentType: 'PlainText', content: quickResponse }]);
      }
    }

    // Idempotency (SPEC-ABUSE-CONTROLS): key the correlationId on the STABLE inbound Chime
    // message id, not a fresh random one, so a duplicate at-least-once fulfillment of the same
    // message reuses it and the async processor's dedup guard collapses the two (no double
    // Bedrock call, no completed->failed task clobber). Falls back to a random id when the
    // message id is absent (synthetic/test events).
    const correlationId = event.requestAttributes?.['CHIME.message.id'] || randomUUID();

    // Per-user rate limit (SPEC-ABUSE-CONTROLS): enforce the EFFECTIVE classification's hourly
    // ceiling before any budget spend or dispatch. Over limit -> short "try again in N min" reply,
    // no Bedrock. The ceiling is the profile's rateLimitPerHour (config, always defined for a known
    // classification); 0/undefined disables it. Counter is per-user; the effective classification is
    // min(channel, user), so a user is capped at the more restrictive of the two.
    const classificationRateLimit = profiles.profileFor(effectiveClassification).rateLimitPerHour ?? 0;
    const rate = await checkRateLimit(userSub, classificationRateLimit);
    if (!rate.allowed) {
      console.warn('[Router] Rate limit exceeded; serving limit notice', { effectiveClassification, userSub: userSub.slice(0, 8) });
      return formatLexResponse(event, [{ contentType: 'PlainText', content: rateLimitMessage(rate.resetInMinutes) }]);
    }

    // Spend-budget guard (SPEC-ABUSE-CONTROLS): before dispatching a Bedrock turn, consume the
    // per-user + global hourly model-call budget. Over budget -> serve the canned response and do
    // NOT invoke the async processor (no Bedrock cost). No-op until the budget env is set; the
    // global ceiling fails safe so a control-table outage cannot become unbounded spend.
    const budget = await checkAndConsumeBudget(userSub);
    if (!budget.allowed) {
      console.warn('[Router] Spend budget exceeded; serving canned response', { reason: budget.reason });
      return formatLexResponse(event, [{ contentType: 'PlainText', content: budgetCannedResponse() }]);
    }

    // Domain grounding: forward the domain context
    // stamped into channel Metadata so the async processor renders it into the system prompt.
    // Force-refresh so an edited plan (re-stamped each session by the host) is never served
    // stale from a warm container's metadata cache. Absent for non-plan AE channels ⇒ the
    // fields stay undefined and the processor's formatDomainContextForPrompt is a no-op.
    const domainGrounding: Record<string, unknown> = {};
    // The context id (= the conversation's contextId, stamped by create-conversation) anchors a
    // place_item task to its plan. Undefined for non-plan AE channels.
    let contextId: string | undefined;
    if (channelArn) {
      const contextMeta = await resolveChannelMetadata(channelArn, botArn, true);
      if (typeof contextMeta.contextId === 'string' && contextMeta.contextId) contextId = contextMeta.contextId;
      if (contextMeta.domainContext) domainGrounding.domainContext = contextMeta.domainContext;
      if (contextMeta.otherContexts) domainGrounding.otherContexts = contextMeta.otherContexts;
      if (Array.isArray(contextMeta.participants)) domainGrounding.participants = contextMeta.participants;
      if (typeof contextMeta.userName === 'string' && contextMeta.userName) domainGrounding.userName = contextMeta.userName;
      if (typeof contextMeta.userLanguage === 'string' && contextMeta.userLanguage) domainGrounding.userLanguage = contextMeta.userLanguage;
      if (typeof contextMeta.participantProfile === 'string' && contextMeta.participantProfile) domainGrounding.participantProfile = contextMeta.participantProfile;
      // Geography routing signal (SPEC-CONTEXT-AWARE-MODEL-ROUTING) — forward the geo segment so the
      // processor's resolveModelPlan can route a CN-segment turn to the Chinese model + reply zh.
      if (contextMeta.segment && typeof contextMeta.segment === 'object') domainGrounding.segment = contextMeta.segment;
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

    // Task tracking runs on EVERY classification. The router is the single Lex entry point for all
    // classifications (deployed per-classification via STATIC_CLASSIFICATION); tasks are a platform
    // capability, not a standard/premium-only one. getActiveTask/createTask are classification-agnostic, and basic's
    // async processor gives lightweight task support (grounds the prompt + stamps task_id).
    // Basic keeps keyword classification (classifyIntentBasic above), whose pack keywords
    // already emit task intents (report_generation/data_extraction/…), so no per-turn LLM
    // classifier cost is added. A bare block keeps taskId/taskType scoping local.
    {
      // Check for active task to handle continuations. Scope the lookup
      // to the CURRENT channel (P2.4) — resuming a task from a different
      // channel would silently fail when the async processor looks up
      // the task by (taskId, channelArn), since that table is keyed by
      // both. Cross-channel awareness is surfaced separately by the
      // async processor via getActiveTasksForUser + buildCrossChannelTasksHint
      // at prompt-build time, where it belongs.
      let activeTask = null;
      if (classification.intent !== IntentType.GREETING &&
          classification.intent !== IntentType.ACKNOWLEDGMENT) {
        for (const taskType of ['guided_troubleshooting', 'data_extraction', 'report_generation']) {
          activeTask = channelArn
            ? await getActiveTask(userSub, taskType, { channelArn })
            : await getActiveTask(userSub, taskType);
          if (activeTask) break;
        }
      }

      const hasActiveTask = !!activeTask;
      const deliveryOption = selectDeliveryOption(classification.intent, hasActiveTask);

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
        const isNewTask = !activeTask;
        let taskId: string;
        let taskType: string;
        let taskState: string | undefined;

        if (activeTask) {
          taskId = activeTask.taskId;
          taskType = activeTask.taskType;
          taskState = activeTask.taskState;
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
                ? { contextId, ttlSeconds: TRIP_TASK_TTL_SECONDS, assigneeUserSub: requesterSub }
                : undefined;
          const task = await createTask(event, deliveryOption, taskType, undefined, taskOpts);
          taskId = task.taskId;
          taskState = task.taskState;
        }

        if (asyncProcessorArn && channelArn) {
          await invokeAsync(asyncProcessorArn, {
            channelArn,
            correlationId,
            userMessage,
            userType: effectiveClassification,
            taskId,
            taskType,
            botArn,
            isTaskContinuation: !isNewTask,
            senderArn: event.requestAttributes?.['CHIME.sender.arn'],
            senderDisplayName,
            // Reply visibility (targeted vs broadcast) is derived from the
            // placeholder's actual Target in the async processor, not passed
            // here - the router cannot see the inbound message's Target.
            intent: classification.intent,
            intentConfidence: classification.confidence,
            deliveryOption,
            ...(resolvedModel && { resolvedModel }),
            ...(experimentId && { experimentId }),
            ...(variantId && { variantId }),
            ...(retrievedContext && { retrievedContext }),
            ...(conversationSummary && { conversationSummary }),
            ...(hasResponseSettings && { responseSettings }),
            intentPackVersion,
            ...domainGrounding,
          });
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
        ...(experimentId && { experimentId }),
        ...(variantId && { variantId }),
        ...(hasResponseSettings && { responseSettings }),
        intentPackVersion,
        ...domainGrounding,
      });
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

    // 'company' is the classification-gated business/financial corpus (ADR-017): company
    // documents are embedded under rag/company/{classification}/ and retrieved here by
    // relevance, deterministically (router pre-fetch), so a classification's own facts reach
    // the model without depending on the model electing to call a tool. Classification scope
    // is the same fail-closed SQL metadata filter used for wiki/doc.
    const result = await retrieveContext({
      query: userMessage,
      sourceTypes: ['wiki', 'doc', 'company'],
      topK: 6,
      classificationScope,
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
