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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { recordTurnRouting } from './lib/turn-routing.js';
import { sessionClient, speakAsRoutedAssistant, releaseAssistantSession, releaseAfterHeldWork } from './lib/assistant-session.js';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import {
  ChimeSDKMessagingClient,
  DescribeChannelCommand,
  ListChannelMembershipsCommand,
  ListTagsForResourceCommand,
  UpdateChannelMessageCommand,
  ListChannelMessagesCommand,
  GetChannelMessageCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  classifierReading,
  classifyIntent,
  classifyIntentByKeyword,
  IntentType,
  intentToDeliveryOption,
} from './lib/intent-classifier.js';
import { hydrateIntentPackFromSsm, responseSettingsForIntent, activeIntentPackRaw, taskStateMachines, getIntentPack, refusedPlatformIntents, needsOf, knownIntentKeys, type IntentPack } from './lib/intent-pack.js';
import { classificationAllows, modelFits } from '../../lib/config/model-availability.js';
import { composeRefusal } from './lib/capability-refusal.js';
import type { TaskStateMachine } from './lib/task-state-machines.js';
import { awaitedPartyOf, assistantOwesTheStep, machineHasAssistantStep, PLATFORM_TASK_MACHINE_KEYS, reopenTargetsFrom } from './lib/task-state-machines.js';
import { componentVersion } from './lib/config-identity.js';
import {
  DeliveryOption,
  selectDeliveryOption,
  quickReply,
  getTaskPlaceholder,
} from './lib/delivery-options.js';
// TASKS GO THROUGH THE STORE SEAM, not the table. Same signatures; the boundary is inside.
import { createTask, getTask } from './lib/task-store.js';
import { isPrivateVisibility } from './lib/task-visibility.js';
// THE SEAM, NOT THE TABLE, for every task read on this path (ADR-033). What stays imported from
// `task-tracking` below is pure: an id derivation, a window constant, a TTL, and types - none of
// them touches DynamoDB, and none needs the boundary the service provides.
import { applyUserResponseToTask, cancelStoppedTasks, getActiveTask, getActiveTaskForOwner, getAssigneeChannelTasks, selectStoppableTasks } from './lib/task-store.js';
import { principalIdFromArn, RECENTLY_ENDED_TASK_WINDOW_MINUTES, taskEndedAt, TRIP_TASK_TTL_SECONDS, type TaskCreateOptions, type UserTask } from './lib/task-tracking.js';
import { BOUNDED_REQUEST_HANDLER } from './lib/bounded-request-handler.js';
import {
  buildStopAnswerReading,
  dispatchStopEvaluationTurn,
  parseStopAnswer,
  parseStopEvaluationContext,
  restartedRequest,
  type StopEvaluationContext,
} from './lib/stop-evaluation.js';
import { sendChannelMessage, sendInParts } from './lib/chime/send.js';

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
import { resolveActiveBattle, readBattleRows, resumeBotFromWaiting, battleChannelFrom, botRowsOnly, duelWasAbandoned } from './lib/battle-state.js';
import { clearBattleWaitingMarker } from './lib/battle-waiting-marker.js';
import { evaluateAbuseGate, capUserMessage, claimCorrelation, hasCorrelationClaim, claimPlaceholderMapping } from './lib/abuse-controls.js';
import { turnCorrelationId, mentionCorrelationId, correlationMarkerOf } from './lib/correlation.js';
import { resolveChannelSize } from './lib/channel-size.js';
import { roommatesInConversation, type Roommate } from './lib/assistant-advertisement.js';
import { whoIsHereFrom, rosterForDispatch, type ReadRoster } from './lib/who-is-here.js';
import { decideDelegation, intentKeptHere, parseDelegationKey, withRoommateCategories } from './lib/delegation.js';
import { liveAssistantsForClassification } from './lib/default-agents.js';
import { isAccessDenial, recordClassificationBoundaryRefusal } from './lib/access-denial.js';
// The bypass tokens, shared with the channel flow so the two sides cannot disagree about what one is.
// The private prefix. A separate module from the bypasses on purpose: `.` is routed by Amazon Chime
// SDK from the Target, `@` is routed by the channel flow, and confusing the two answers a turn twice.
import { mightAddressPrivately, resolvePrivateTarget, stripPrivatePrefix } from './lib/private-prefix.js';
import { handoverContent, handoverMetadata, handoverCarriedText, parseHandover, isAssistantArn, type HandoverMarker } from './lib/assistant-handover.js';
import {
  flowBypassToken,
  commandFor,
  matchCommand,
  flowOwnsTheTurn,
  matchesBattleCommand,
  mightMentionSomeone,
  resolveMentionedMember,
  stripAtAll,
  stripMentionOf,
} from './lib/flow-bypass.js';
import { inboundTarget, inboundWasTargeted, lexEntryAnswersCommand } from './lib/private-command.js';
import { resolveUserClearance } from './lib/user-clearance.js';
import { assembleHostGrounding } from './lib/host-grounding.js';
import { defaultDirectory } from './lib/membership-source.js';
import { conversationRef, notifyDirective } from './lib/notify-directive.js';
// SPEC-CAPABILITY-PROFILES: the single interpreter of classification tags + group clearance.
// Replaces the local CLASSIFICATION_RANK / CLEARANCE_GROUPS / minRank / isAdvancedClassification / classificationScope constants.
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { deploymentCopyAppliesTo, deploymentCopySkipped } from './lib/deployment-copy-scope.js';
import { turnAssistantProfile, logAssistantDecline, type TurnAssistantProfile } from './lib/turn-assistant.js';
import { isServingRecord, runtimeSeedFor, type AssignmentRecord } from './lib/runtime-assistant.js';
import type { AssistantProfile } from '../../lib/config/profiles.js';
import { classificationEnvName } from './lib/classification-env.js';
import { CLASSIFICATION_TAG, readChannelClassificationTag, readChannelTags } from './lib/channel-classification.js';
import { primaryAssistantOf } from './lib/conversation-primary.js';
// The handler stays non-VPC (ADR-013). It reaches the VPC-attached data-plane Lambda only for drift
// detection; retrieval runs in the async processor (lib/turn-grounding.ts).
import { resolveExperimentModel, resolveClassificationExperiment, resolveBattleTreatment, resolveEnrollment, countsTowardExperiment, experimentArmOf, resolveTaskArm } from './lib/experiment-manager.js';
import { taskIntentOf } from './lib/step-models.js';
import { imagePrimaryForIntent } from './lib/image-route.js';
import { enrollmentMayApply, enrollmentOf } from './lib/experiment-enrollment.js';
import { normaliseLegacyTrigger, type InteractionKind } from './lib/interaction-kinds.js';
import { claimTurn, turnQueueEnabled, enqueueMessage, recordStop, claimNotice, releaseNoticeClaim, readTurnState, releaseLock, rememberStopDecision, readStopDecision, clearStopDecision, recordDispatchFailure } from './lib/turn-lock.js';
import { adminNotice, postAdminNotice } from './lib/admin-notice.js';
import { openDrainTask } from './lib/queue-drain-task.js';
import { parseStopCommand, resolveStopTarget } from './lib/stop-target.js';
import { showQueueNotice, noticeText, findHolderPlaceholder } from './lib/turn-queue-notice.js';
import { parseTriageTurnContext } from './lib/turn-triage-proposal.js';
import { withTurnDeclaration, isDeclarableValue } from './lib/turn-declaration.js';
import type { TriageTurnContext } from './lib/turn-triage-proposal.js';
import { getModelCatalog, bedrockInvokeId } from '../../lib/config/model-strategy.js';
import { resolveActiveProfile, resolveFromDefinition, concreteModel, rememberRuntimeSeed } from './lib/active-profile.js';
import { botMessageMetadata, type BotMessageAttribution } from './lib/bot-message-attribution.js';
import { noticeLine, noticeUse, noticeMentionsForMembers, isNoticeCopyKey, noticeTurnKind, checkNoticeVars, noticeMetadata, type NoticeCopyKey, type NoticeEvent, type NoticeRequest, type NoticeOutcome } from './lib/assistant-notice.js';
import {
  buildSourceTable,
  clearanceSet,
  PREFERRED_LANGUAGE_KEY,
  whenHolds,
  type When,
  resolveTemplateFields,
  versionLookup,
  withUnreadCatalog,
  type SourceLookup,
  type VariableValue,
  type VersionVariable,
} from './lib/variables.js';
import { turnCallSite, welcomeCallSite } from './lib/context-sources-runtime.js';
import { loadMessageTemplateSet, selectMessageTemplate } from './lib/message-template-selection.js';
import { templateLine, withMessageTemplates, type MessageTemplateSet, type VersionWords } from './lib/message-lines.js';
import { dispatchWelcomePromptTurn, type WelcomePromptRequest } from './lib/welcome-prompt-turn.js';
import {
  conditionSources,
  participantRoleReferences,
  audienceRole,
  mentionedRole,
  continueAfter,
  arrivalWelcomeOwner,
  conversationKey,
  declaredWorkflowOn,
  eventNaturalKey,
  eventRunKey,
  INVITATION_ID,
  assistantForStep,
  personJoinedWorkflowOf,
  runEventWorkflow,
  verifiedJoiners,
  workflowFor,
  welcomeWorkflowOf,
  openedWorkflowOf,
  welcomePlan,
  type WelcomePlan,
  type PromptWelcomeStep,
  workflowSendEmailKind,
  isInvitationEvent,
  ALARM_NAME,
  alarmWatchKey,
  isAlarmState,
  type AlarmChange,
  type AgentStep,
  type EventGate,
  type EventRunContext,
  type EventRunDeps,
  type EventTransition,
  type EventWorkflow,
  type WorkflowEvent,
} from './lib/event-workflow.js';
import { workerAssistantRole, type TaskStep } from './lib/task-step.js';
import { eventTaskId } from './lib/event-task.js';
import { audienceOf, inertMention as workflowMention, type EventAudience } from './lib/event-workflow.js';
import {
  createTaskDeadlineSchedule, deleteTaskDeadlineSchedule, taskDeadlineFiringOf, type TaskDeadlineFiring,
} from './lib/event-deadlines.js';
import { cancelForDeadline, workflowTaskIds as workflowTasksOf } from './lib/task-store.js';
import {
  pickupBudget, pickupCorrelationId, pickupReadiness, settlementOutcome, taskCardOf, type TaskCard, type TaskPickupRequest,
} from './lib/workflow-task.js';
// The lock a pickup turn takes is the turn's own lock (ADR-033); named apart so a turn's claim reads as one place.
import { notePickupPending, claimTurn as claimLockForPickup } from './lib/turn-lock.js';
import { claimPickup } from './lib/task-store.js';
import { renderPromptTemplate } from './lib/message-template.js';
import { taskHasBeenGivenATurn } from './lib/task-state-machines.js';
import type { Task } from './lib/task-tracking.js';
import { openWorkflowTask } from './lib/task-store.js';
import type { TaskAssignee, WorkflowRunRef } from './lib/task-tracking.js';
import type { TaskNaming } from './lib/say-through-router.js';
import { holdersByRole, hostRoleHoldings, rolesOfPerson, withHostHoldings } from './lib/participant-roles.js';
import { resolvePerson } from './lib/person-identity.js';
import { issuerIdOf } from './lib/trusted-issuers.js';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { hostSourcedRoles, participantRoleOf, participantRolesOf, roleSaidInRoom } from '../../lib/config/participant-roles.js';
import { claimEventRun, claimEventStep, recordEventGreeting } from './lib/task-store.js';
import { eventDispatchId } from './lib/event-dispatch-id.js';
import type { ConversationOpenedNaming, EventContinuation, InvitationSentNaming, PersonJoinedNaming } from './lib/say-through-router.js';
import { INVITATION_KEY, everyInvitation, pendingInvitation, type InvitationRecord } from './lib/invitations.js';
import {
  DEADLINE_METRIC_NAMESPACE, DEADLINE_SCHEDULE_FAILED_METRIC, createDeadlineSchedule, deadlineAt, deadlineCancelOf, deadlineFiringOf, deleteDeadlineSchedule, deadlineWiringFromEnv,
  type DeadlineCancel, type DeadlineFiring, type DeadlineWiring,
} from './lib/event-deadlines.js';
import { emitEmfMetric } from './lib/emf-metrics.js';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { MAX_PEOPLE_JOINED } from './lib/say-through-router.js';
import { loadNamedTemplate } from './lib/message-template-selection.js';
import { renderMessageTemplate } from './lib/message-template.js';
import { chooseLanguage } from './lib/message-language.js';
import { resolveLanguageTag } from '../../lib/config/languages.js';
import { getConversationTypeConfig } from '../../lib/config/conversation-types.js';
import { noticeTemplateName } from './lib/shipped-message-templates.js';
import type { ParsedTemplate } from './lib/document-template.js';
import type { AssistantCopy, ProfileDefinition } from './lib/active-profile.js';
import { joinRecapRequestFor } from './lib/join-recap.js';
import { NOTHING_TO_POST } from './lib/lex-envelope.js';
import { randomUUID } from 'crypto';
import { runLiveDriftFlow, resolveOriginatingMessage, type TurnSubjectDecision, type HeldQuestion } from './lib/live-drift-flow.js';
import { variantGrantOf, SPEAK_ROUTE_PREFIX, type GrantVariant } from './lib/assistant-grant.js';
import { startRouterSteps } from './lib/router-steps.js';
// Whether a turn continues in this conversation rather than being offered a new one. One named
// decision, so the two-axis rule that replaces it (task-relatedness, then conversation-relatedness)
// changes that function's body and no call site here.
import { isStalledStepCandidate, opensOtherWorkThan, reopenableFollowUpSubject, resolveTaskContinuity, resumesAStalledStep } from './lib/task-continuity.js';
import {
  parseWelcomeOrientationDetailed,
  composeOpening,
  selectOpening,
  type WelcomeOpeningStep,
  type WelcomeOrientation,
} from './lib/welcome-orientation.js';
import { recordWelcomeConfigDefect, welcomeConfigDefects } from './lib/welcome-metrics.js';
import {
  getParticipantContext, getChannelContext, putChannelContext, advanceOnboardingIntake, startOnboardingIntake, alarmWatchOf,
  claimRoomNaming, releaseRoomNaming, markRoomNamed, roomNamingOf, ROOM_NAMING_LEASE_MS,
} from './lib/channel-context-client.js';
import { askRoomPrimaryToName, namingDecisionFor, type NamingDecision, type RoomNamingMemory } from './lib/room-naming.js';
import {
  participantContextFor,
  onboardingApplies,
  type ParticipantContext,
} from './lib/participant-shape.js';
import {
  loadIntakeConfig,
  isOnboardingEnabled,
  intakeAfterChecking,
  intakeAsStarted,
  startIntake,
  advanceIntake,
  parseStoredIntake,
  splitCollected,
  type KnownFacts,
  type IntakeConfig,
} from './lib/onboarding-intake.js';
import { onboardingStatus, markOnboarded, getReplyPreferences, setReplyPreference } from './lib/user-profile-client.js';
import { knownPreferences, resolvePreferenceValue, REPLY_PREFERENCES } from '../../lib/config/reply-preferences.js';
import type { PreferenceTurn } from './lib/reply-preferences-runtime.js';
import { extractAttachment, type MessageAttachment } from './lib/battle-attachment.js';
import {
  rankReferentCandidates, MAX_REFERENT_CANDIDATES, type ReferentCandidate,
} from './lib/task-referent.js';
import { referentCandidates as referentCandidatesFor } from './lib/task-store.js';
import {
  findReferencedTask, formatReferenceNotFound, parseTaskReference,
  type TaskResolution,
} from './lib/task-reference.js';

import {
  isSanctionedBattleBot,
  resolveBattleSide,
  resolveDuelSides,
  duelChallengerOf,
  battlePlaceholderContent,
  type DuelSides,
} from './lib/battle-turn.js';
import { endBattle, type BattleEndReason } from './lib/battle-end.js';
import { hydrateBodies } from './lib/profile-bodies.js';
import { appInstanceArnOf, botArnFor, botIdFromArn, isPersonArn, personIdFromArn, userArnFor } from './lib/person-arn.js';
import { parseChannelMetadata } from './lib/chime/channel-meta.js';
import { recentChannelMessages, decodeContent } from './lib/chime/history.js';
import { loadProfileRegistry } from '../../lib/profile-registry';


const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
// Per-classification bot SSM key (= /agent-echelon/assistant/{classification}/bot-arn),
// always set by the deploying classification stack. There is no shared
// '/agent-echelon/bot-arn' fallback.
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || '';
// Per-classification deployment (ADR-011 reversal / bot-layer isolation): when this
// handler is deployed per-classification, CLASSIFICATION is set statically and BOT_ARN_PARAM points
// at that classification's bot key. With CLASSIFICATION set the handler skips channel-classification
// discovery (it IS the classification) and acts as the per-classification bot — no shared
// router, no shared bot. Unset = legacy shared-router behavior (back-compat).
const STATIC_CLASSIFICATION = process.env.CLASSIFICATION || '';
/** This classification's routing table (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b). Written before every dispatch; see `invokeAsync`. */
const TURN_ROUTING_TABLE = process.env.TURN_ROUTING_TABLE || '';
/** The token store, read only through its sparse invitation index, to verify `invitation-sent` (ADR-061 decision 1). */
const INVITATIONS_TABLE = process.env.TOKENS_TABLE || '';

/**
 * THE ROLE THIS HANDLER SERVES. An alt is the alternate assistant of one (classification, role), so
 * the identity guard needs both halves to tell this role's alt from another role's alt in the same
 * classification. Empty admits no alt at all - fail closed, never fall back to the whole roster.
 */
const ASSISTANT_ROLE = process.env.ASSISTANT_ROLE || '';


// Live drift detection — feature-flagged via ENABLE_LIVE_DRIFT (set by the
// auroraDriftWiring helper in Aurora mode). The flow itself lives in
// `lib/live-drift-flow.ts` (shared; this router runs on every classification so all
// classifications run it). Retrieval, which rides the same Aurora hookup, runs in the async
// processor (lib/turn-grounding.ts), not here.

const lambdaClient = new LambdaClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });
/** Writes the routing record; see `invokeAsync`. */
const routingDdb = new DynamoDBClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });
const ssmClient = new SSMClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });
// THE ROUTER SPEAKS AS THE ASSISTANT IT ROUTED TO (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b). This client goes out on that assistant's
// session once the turn has resolved which bot answers (`speakAsRoutedAssistant` in `runTurn`), and on
// the router's own role before then, which can read but cannot post as any bot.
const chimeClient = sessionClient(ChimeSDKMessagingClient, { region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });

// ============================================================
// Caches (persist across warm invocations)
// ============================================================

let cachedBotArn: string | null = null;
const channelClassificationCache = new Map<string, string>();
// `minRank` lived here to cap a turn at the SPEAKER's clearance. It has no callers since one
// channel means one classification (see the turn's classification below): the cap decided nothing
// IAM had not, and downgraded a whole conversation whenever a clearance lookup failed. The
// registry still exposes `profiles.min` for anything that genuinely needs a floor of two values.

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
 * THE ASSISTANT SERVED BY A GIVEN AMAZON LEX BOT, from the assignment records.
 *
 * WHY THIS EXISTS: a Lex turn does not say which assistant was addressed, so the only thing that can
 * is the Lex bot the turn arrived on. Each additional role owns one, and its record names it.
 *
 * Returns '' for the classification's primary, which owns the shared Lex bot and needs no lookup, and
 * for any Lex bot no record claims. The caller then uses the classification's own bot, which is every
 * deployment that hosts one assistant per classification.
 *
 * CACHED FOR A MINUTE (`ASSISTANT_INDEX_TTL_MS`), with the rest of the assistant index: a Lex bot's assistant changes
 * only on a deploy, but a runtime assistant (ADR-048) is assigned and retired without one.
 */
const botArnByLexBot = new Map<string, string>();
/**
 * Which assistant a given bot answers as, from the same records. Read for the welcome and for the turn's
 * assistant profile (`turnAssistantProfile`), which every per-assistant setting of the turn comes from.
 */
const assistantByBotArn = new Map<string, string>();
/**
 * Which ROLE a given bot holds, from the same records.
 *
 * The assignment record carries `role` in its value as well as in its parameter path, so this costs
 * nothing beyond a second `set` in the loop that already parses it. Read by the welcome, to pick the
 * per-role template a conversation TYPE declares (the role the room was opened for says what
 * happened, the primary says it has arrived), and by the turn's attribution.
 */
const roleByBotArn = new Map<string, string>();
/**
 * The bots whose record is an `alt` occupancy (a duel's challenger). Its assistant is
 * `alt-{role}-{classification}` with a profile of its own (ADR-050), which `turnAssistantProfile` names from the
 * record's role. Read from the record's occupancy and not its assistant name, because that name is written when an
 * experiment arms; whether an alt bot may take a turn is decided by the battle sanction and the vend, which
 * serves the alt only while an experiment holds it. Its record also names its own Amazon Lex bot, so a
 * reply a person targets at the alt arrives here on that Lex bot and resolves to the alt like any addressed
 * assistant (`resolveBotArnForLexBot`).
 */
const altBotArns = new Set<string>();
/** The seed of each runtime assistant's bot, built from its own record (`runtimeSeedFor`, ADR-048). */
const runtimeSeedByBotArn = new Map<string, AssistantProfile>();
/** When the assistant index was last read completely; 0 before the first read. */
let assistantIndexLoadedAt = 0;
/**
 * How long a complete read of the records serves. A runtime assistant is assigned or retired without a
 * deploy, so a container-lifetime cache would admit a retired assistant until the container recycled.
 */
const ASSISTANT_INDEX_TTL_MS = 60_000;
async function resolveBotArnForLexBot(lexBotId: string | undefined): Promise<string> {
  if (!lexBotId || !STATIC_CLASSIFICATION) return '';
  if (!(await loadAssistantIndex())) return '';
  return botArnByLexBot.get(lexBotId) || '';
}

/**
 * Loads the assistant index above from the assignment records, once per container. True when it is loaded.
 *
 * Called for a Lex turn (to find the addressed bot) and for EVERY turn before the assistant profile is
 * resolved, because a turn the channel flow hands over carries no Lex bot id: it names its bot in
 * `AE.bot.arn`, and the assistant of that bot is still read from this index.
 */
async function loadAssistantIndex(): Promise<boolean> {
  if (!STATIC_CLASSIFICATION) return false;
  if (assistantIndexLoadedAt && Date.now() - assistantIndexLoadedAt < ASSISTANT_INDEX_TTL_MS) return true;
  try {
    // PAGED, because the service default page size is TEN and a classification's assignments are not
    // bounded: each role contributes a live and an alt record, so a classification declaring four
    // roles silently truncates this index. A Lex bot that falls off the end resolves to no assistant, and
    // the turn answers as the classification's primary - with the primary's profile, bearer and
    // attribution - which is the exact failure this index was added to prevent, reappearing only at
    // scale and with no symptom.
    const params: Array<{ Value?: string }> = [];
    let token: string | undefined;
    do {
      const res = await ssmClient.send(new GetParametersByPathCommand({
        Path: `${SSM_ROOT}/assistant-assignments/${STATIC_CLASSIFICATION}`,
        Recursive: true,
        MaxResults: 10,
        NextToken: token,
      }));
      params.push(...(res.Parameters || []));
      token = res.NextToken;
    } while (token);
    // REBUILT WHOLE, then swapped in, so a retired assistant leaves the index and a failed read keeps the
    // last complete one rather than a half-built one.
    const next = {
      lex: new Map<string, string>(), assistant: new Map<string, string>(), role: new Map<string, string>(),
      alt: new Set<string>(), runtime: new Map<string, AssistantProfile>(),
    };
    for (const p of params) {
      const parsed = JSON.parse(p.Value || '{}') as AssignmentRecord;
      // A retiring or provisioning runtime assistant reads as absent (ADR-048).
      if (!isServingRecord(parsed)) continue;
      if (parsed.lexBotId && parsed.botArn) next.lex.set(parsed.lexBotId, parsed.botArn);
      if (parsed.botArn && parsed.occupancy === 'alt') next.alt.add(parsed.botArn);
      // AND WHICH ASSISTANT IT IS, so the welcome can come from that assistant's own profile.
      // The welcome is an intent and therefore the assistant's, not the room's.
      if (parsed.botArn && parsed.assistant) next.assistant.set(parsed.botArn, parsed.assistant);
      if (parsed.botArn && parsed.role) next.role.set(parsed.botArn, parsed.role);
      const seed = parsed.botArn && parsed.source === 'runtime' ? runtimeSeedFor(parsed, profiles) : undefined;
      if (seed && parsed.botArn) next.runtime.set(parsed.botArn, seed);
    }
    const swap = <K, V>(into: Map<K, V>, from: Map<K, V>) => { into.clear(); for (const [k, v] of from) into.set(k, v); };
    swap(botArnByLexBot, next.lex);
    swap(assistantByBotArn, next.assistant);
    swap(roleByBotArn, next.role);
    swap(runtimeSeedByBotArn, next.runtime);
    altBotArns.clear();
    for (const b of next.alt) altBotArns.add(b);
    assistantIndexLoadedAt = Date.now();
  } catch (err) {
    // The caller decides from `false`: a classification that has one assistant answers (its primary
    // IS that assistant), and one that has several declines, because the addressed assistant is
    // unknown (`turnAssistantProfile`).
    console.warn('[Router] could not index the assignment records by Lex bot; the addressed assistant '
      + 'cannot be resolved from them this turn',
      { err: err instanceof Error ? err.message : String(err) });
    // A RE-READ THAT FAILS KEEPS THE LAST COMPLETE INDEX: a throttled read is not a classification that
    // lost its assistants, and declining every multi-assistant turn for it would be.
    return assistantIndexLoadedAt > 0;
  }
  return true;
}

/**
 * THE ASSISTANT OF A BOT: which assistant's profile everything it says comes from. One resolution for a
 * turn and for a notice, so the two cannot describe different assistants (`turnAssistantProfile`).
 */
async function assistantOfBot(botArn: string, classification: string, classificationBotArn: string): Promise<TurnAssistantProfile> {
  const assistantIndexLoaded = await loadAssistantIndex();
  const runtimeSeed = runtimeSeedByBotArn.get(botArn);
  const assistant = turnAssistantProfile({
    classification,
    assistantIndexLoaded,
    assignedAssistant: assistantByBotArn.get(botArn),
    runtimeSeed,
    isAltAssistant: altBotArns.has(botArn),
    altRole: roleByBotArn.get(botArn),
    primaryBot: botArn === classificationBotArn,
    registry: profiles,
  });
  // A runtime assistant's versions resolve under its own name, from the seed its own record produced.
  if (assistant.decision === 'answer' && runtimeSeed && assistant.profile === runtimeSeed) rememberRuntimeSeed(runtimeSeed);
  return assistant;
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
 * The onboarding intake in force for the turn's assistant: its SERVING VERSION's, else the deployment's.
 *
 * ONE RESOLUTION, TWO CALL SITES. The welcome starts an intake and a later turn reads an answer
 * against it. Both pass the turn's assistant profile (`turnAssistantProfile`), so both resolve the same
 * assistant; if they resolved differently the person would be asked one assistant's questions and
 * have their answers checked against another's field list, which `intakeAsStarted` refuses - it would
 * strand them mid-intake with a warning in the log and no way forward.
 *
 * Resolved through the same 30-second profile cache as the pack and the classifier model, so on any
 * turn that has already resolved the profile this costs nothing, and an activation converges without a
 * redeploy. Fails to the deployment seam rather than to no onboarding: an unreadable version must not
 * silently stop introducing the assistant to people who have not met it.
 *
 * THE DEPLOYMENT SEAM IS THE PRIMARY'S. `ONBOARDING_INTAKE` / `ONBOARDING_INTAKE_PARAM` is one config
 * per classification, seeded for the assistant the classification names, so a second assistant whose
 * version carries no intake gets none rather than the primary's questions (`deploymentCopyAppliesTo`,
 * the rule the persona and the welcome follow).
 */
async function intakeForAssistant(profileName: string, classification: string): Promise<IntakeConfig | null> {
  try {
    const active = await resolveActiveProfile(profileName, { ssm: ssmClient, ssmRoot: SSM_ROOT });
    if (active?.onboarding) return active.onboarding;
  } catch (error) {
    console.error('[Router][Onboarding] profile intake resolution failed (using the deployment seam):', error);
  }
  const primaryName = profiles.profileFor(classification)?.name;
  if (primaryName && !deploymentCopyAppliesTo(profileName, primaryName)) {
    console.log(deploymentCopySkipped('onboarding intake', profileName, primaryName));
    return null;
  }
  return loadIntakeConfig(getSsmParam);
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

/**
 * Channels THIS TURN has been refused on.
 *
 * NOT a cache. `resolveChannelMetadata` and `getMemberArns` return a default on failure; if they
 * cached it, a refusal would become a confident empty document for the container's whole warm life.
 * So they do NOT cache on refusal, and record it here instead, where it means "refused" rather than
 * "empty".
 *
 * ── IT IS CLEARED EVERY INVOCATION, AND THE REASONING THAT SAID OTHERWISE WAS WRONG ──────────────
 *
 * This was kept for the container's life, on the grounds that both operands are immutable: the
 * channel's `classification` tag cannot be changed by `UpdateChannel`, and this handler's own
 * classification is fixed at deploy. Both facts are true and the conclusion still does not follow,
 * because the INPUT is not the tag comparison, it is `isAccessDenial`, which matches any 403 or
 * `ForbiddenException` - and Amazon Chime SDK raises `ForbiddenException` for membership propagation
 * lag, a genuinely transient condition (review, 2026-09-17).
 *
 * So one racy first read after a bot is added would have silenced the assistant in that conversation
 * for the container's whole warm life, every later turn short-circuiting to silence and emitting a
 * SecurityEvent that names a boundary violation which is not happening. A sticky wrong answer, and
 * the kind that looks like the product is broken rather than like a bug.
 *
 * Per-invocation costs nothing worth having: the reads that populate it happen on the turn anyway,
 * a genuine refusal still ends THIS turn, and the next turn simply asks again. It also bounds the
 * set, which had no eviction.
 */
const refusedChannelReads = new Set<string>();

/** Whether the classification boundary has refused this container a read of this channel. */
/**
 * What the intent classification COST, for the analytics record.
 *
 * Captured by `intent-classifier.ts` since it was written, read by this handler, and until now
 * written to a console.log and nowhere else - so the cost surface covered the ANSWER and could not
 * have covered more. Most turns pay for this call; on a deployment with heavy fast-path coverage most
 * do not, and the difference is exactly what an operator comparing two intents needs to see.
 *
 * ALL THREE OR NONE. A token count without the model that consumed it cannot be priced, because the
 * classifier is per-profile configurable - two deployments with identical counts can pay ten times
 * differently. Emitting tokens alone would put an unpriceable number in a cost column.
 *
 * ABSENT, NOT ZERO, on a turn that asked no model. Zero would make the classifier look cheaper the
 * more often it is skipped rather than rarer, which is the defect `classifier_ms` already documents.
 */
function classifierSpendFields(classification: {
  classifierTokensIn?: number;
  classifierTokensOut?: number;
  classifierModelId?: string;
}): Record<string, number | string> {
  const { classifierTokensIn: tin, classifierTokensOut: tout, classifierModelId: model } = classification;
  if (typeof tin !== 'number' || typeof tout !== 'number' || !model) return {};
  return { classifierTokensIn: tin, classifierTokensOut: tout, classifierModel: model };
}

function channelReadWasRefused(channelArn: string): boolean {
  return refusedChannelReads.has(channelArn);
}

/**
 * THE TURN ENDS HERE. The classification boundary refused this assistant, and a refusal is not a
 * degraded condition to route around (ADR-045 decision 1).
 *
 * WHY THIS RETURNS SILENCE AND NOT AN APOLOGY. Whatever this handler returns, Amazon Chime SDK
 * materializes into the channel from the Lex fulfillment WITHOUT passing this assistant's IAM
 * (measured 2026-09-17: a message whose sender ARN is the premium bot lands in a basic-tagged room
 * although that principal is implicitDeny on SendChannelMessage there). So any content here is
 * content posted into a room this assistant may not act in, and "I cannot help in this conversation"
 * is itself a disclosure of its presence. `formatLexSilentResponse` returns `messages: []`, which
 * every caller already honors as POST NOTHING.
 *
 * The person sees silence. That is the trade ADR-045 states once and it is the correct direction: an
 * assistant that should not be in the room says nothing, rather than answering there with its own
 * model and context. The SecurityEvent and the count below are what tell an operator the difference
 * between this silence and a flow-failure silence.
 */
async function refuseAtClassificationBoundary(event: LexEvent, channelArn: string, where: string): Promise<LexResponse> {
  recordClassificationBoundaryRefusal({ channelArn, assistant: STATIC_CLASSIFICATION, refusedAt: where });
  // SHOWN AND REPORTED, NOT ONLY COUNTED. The assistant cannot read this conversation, so it cannot speak
  // in it either; the person's own client shows why from the turn state, and an administrator is told,
  // because a refusal here is a misconfigured room or a probe and both need a person.
  await reportTurnNotStarted({ event, channelArn, botArn: '', why: `the classification boundary refused the conversation read (${where})`, notice: false });
  return formatLexSilentResponse(event);
}

/**
 * A TURN THAT CANNOT START IS SHOWN AND REPORTED, NEVER SILENT.
 *
 * Three things, each best-effort so a failure to report never becomes a second failure:
 *  - the sender's own client is told, as turn state it renders in their language (`assistant_unreachable`);
 *  - when the classification's own assistant can speak, it says `assistantUnavailable` to the sender, so a
 *    broken or missing assistant is named rather than impersonated;
 *  - an administrator is alerted through the admin notification channel.
 */
async function reportTurnNotStarted(args: {
  event: LexEvent;
  channelArn: string;
  /** The assistant that could not take the turn, when one was resolved. */
  botArn: string;
  why: string;
  /** Whether the classification's own assistant should tell the sender. */
  notice: boolean;
}): Promise<void> {
  const { event, channelArn, botArn, why } = args;
  const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
  const senderSub = personIdFromArn(senderArn) || '';
  const responderId = botIdFromArn(botArn) || STATIC_CLASSIFICATION;
  try {
    if (channelArn && senderSub) {
      await recordDispatchFailure({ channelArn, senderSub, responderId, reason: 'assistant_unreachable' });
    }
    const classificationBotArn = await getBotArn().catch(() => '');
    if (args.notice && channelArn && senderSub && classificationBotArn && botArn && botArn !== classificationBotArn) {
      const name = assistantByBotArn.get(botArn) || 'That assistant';
      await sayNotice({ kind: 'assistantUnavailable', channelArn, botArn: classificationBotArn, to: [senderArn], vars: { name } });
    }
    // Operator-facing, for the admin notification channel; the person sees the turn-state banner instead. Said from the
    // `turn-not-started` template (ADR-062 decision 6); a value this router does not have is the template's own label.
    await postAdminNotice(adminNotice({
      name: 'turn-not-started',
      values: {
        why,
        ...(STATIC_CLASSIFICATION ? { classification: STATIC_CLASSIFICATION } : {}),
        ...(botArn ? { assistant: botArn } : {}),
        ...(channelArn ? { conversation: channelArn } : {}),
      },
      labels: {
        ...(STATIC_CLASSIFICATION ? {} : { classification: 'unknown' }),
        ...(botArn ? {} : { assistant: 'notResolved' }),
        ...(channelArn ? {} : { conversation: 'none' }),
      },
    }, 'turn_not_started', { channelArn, botArn, why }));
  } catch (err) {
    console.warn('[Router] could not report a turn that did not start', { channelArn, why, message: (err as Error)?.message });
  }
}

async function resolveChannelClassification(channelArn: string, botArn: string): Promise<string> {
  // THE VALUE IS STILL THIS HANDLER'S OWN, AND THAT IS NOW CORRECT BY CONSTRUCTION RATHER THAN BY
  // FAITH. The old comment here said "the handler IS the classification - no discovery needed", which
  // was true only if membership is perfectly enforced. It is not: the app-instance administrator can
  // put any assistant in any room, and on 2026-09-17 doing exactly that let a premium router run a
  // full turn in a basic-tagged conversation.
  //
  // What makes the value right is not a discovery, it is a REFUSAL. This performs the channel read
  // that a flow-entry turn might otherwise never make before the model runs, so that IAM gets to
  // decide first. If the boundary allows the read, this handler's classification and the room's agree
  // - that is what being allowed means, since the grant is exactly-own on the room's tag. If it
  // refuses, the caller ends the turn.
  //
  // NO NEW API CALL. `resolveChannelMetadata` is already a `DescribeChannel`, already exactly-own,
  // and already memoized per channel per container, so on every path that reads metadata this is
  // free, and on the flow path it is the one read that was missing.
  if (STATIC_CLASSIFICATION) {
    await resolveChannelMetadata(channelArn, botArn);
    return STATIC_CLASSIFICATION;
  }
  if (channelClassificationCache.has(channelArn)) return channelClassificationCache.get(channelArn)!;
  const classification = await resolveChannelClassificationTag(channelArn);
  if (classification === undefined) {
    // Not cached: an unreadable tag is a condition of this moment, and caching it would make one
    // throttled read decide every later turn in this channel for the container's whole life. The
    // caller refuses this turn through the same path a denial takes.
    refusedChannelReads.add(channelArn);
    // The value is never used: the caller checks `channelReadWasRefused` on the next line and ends
    // the turn. Returning this handler's own classification rather than a floor keeps the type honest
    // without inventing a room classification nobody read.
    return STATIC_CLASSIFICATION;
  }
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
 * Returns `undefined` when the tag is absent, invalid, or unreadable - it does NOT fail closed to the
 * floor any more (ADR-045 decision 2). On this handler the floor is not a safe answer: it is another
 * classification's value, and serving a turn at it is the defect rather than the mitigation. The only
 * caller is `resolveChannelClassification`, which is reached solely on a deployment that does not set
 * `CLASSIFICATION`, and it refuses on `undefined`.
 */
async function resolveChannelClassificationTag(channelArn: string): Promise<string | undefined> {
  return readChannelClassificationTag(chimeClient, channelArn, '[Router]');
}

/** Pull the channel's full Metadata JSON (modelTier, topic, triggerContext,
 *  createdBy, etc.). Cached per-channel for the Lambda's warm life so the
 *  WelcomeIntent path doesn't double the Chime calls already done for
 *  classification resolution. Returns {} on error -- the caller must default. */
const channelMetaCache = new Map<string, Record<string, unknown>>();
/**
 * The channel's NAME as the same read saw it, per channel per container. Read only to skip asking a room's assistant to
 * name a room that already has a name: a name never returns to the placeholder, so a stale read can cost one claim and
 * never a rename (the rename reads the name itself before it writes). A claim taken over after a lapse reads it again
 * (`currentName` below), so the cache follows the rename that run made.
 */
const channelNameCache = new Map<string, string>();
/** What this container knows about each room's naming (`room-naming.ts`): named, or in hand until its claim lapses. */
const roomNamingMemory: RoomNamingMemory = new Map();
async function resolveChannelMetadata(channelArn: string, botArn: string, forceRefresh = false): Promise<Record<string, unknown>> {
  if (!forceRefresh && channelMetaCache.has(channelArn)) return channelMetaCache.get(channelArn)!;
  try {
    const resp = await chimeClient.send(new DescribeChannelCommand({
      ChannelArn: channelArn,
      ChimeBearer: botArn,
    }));
    const meta = parseChannelMetadata(resp.Channel?.Metadata);
    if (!meta) console.warn('[Router] Failed to read channel metadata: it is not a JSON object');
    channelMetaCache.set(channelArn, meta ?? {});
    if (typeof resp.Channel?.Name === 'string') channelNameCache.set(channelArn, resp.Channel.Name);
    return meta ?? {};
  } catch (err) {
    // A REFUSAL IS NOT AN EMPTY METADATA DOCUMENT, and it must not be cached as one. Caching `{}`
    // here would make the refusal sticky for the container's whole warm life, so every later turn in
    // this channel would read a confident empty document instead of probing the boundary again
    // (ADR-045 decision 1). The caller learns about it from `channelReadWasRefused`.
    if (isAccessDenial(err)) {
      console.error('[Router][SecurityEvent] DescribeChannel REFUSED by the channel classification boundary', {
        channelArn, assistant: STATIC_CLASSIFICATION,
      });
      refusedChannelReads.add(channelArn);
      return {};
    }
    console.warn('[Router] Failed to read channel metadata:', err);
    channelMetaCache.set(channelArn, {});
    return {};
  }
}

/** ALL of the channel's member ARNs, read live from Chime membership - the authoritative source,
 *  not a copy in channel metadata. Cached for the Lambda's warm life. Returns [] on error.
 *
 *  ONE READ SERVES BOTH SHAPES. Humans carry `/user/` and app-instance bots carry `/bot/`, and this
 *  used to discard the bots at read time. `/stop` needs to know how many assistants share the room
 *  before it can say which one a stop was aimed at, and paying a second `ListChannelMemberships` for
 *  a discriminator the first response already carried would be a new Chime call on the escape hatch's
 *  own path. Cache the response, filter at the call site. */
const memberArnsCache = new Map<string, string[]>();
async function getMemberArns(channelArn: string, bearerArn: string): Promise<string[]> {
  if (memberArnsCache.has(channelArn)) return memberArnsCache.get(channelArn)!;
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
        if (arn) arns.push(arn);
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    memberArnsCache.set(channelArn, arns);
    return arns;
  } catch (err) {
    // As above: an empty roster and a refused one mean opposite things. `[]` says "nobody is in this
    // room", which every caller reads as a fact about the conversation rather than as a fact about
    // this assistant's right to be in it.
    if (isAccessDenial(err)) {
      console.error('[Router][SecurityEvent] ListChannelMemberships REFUSED by the channel classification boundary', {
        channelArn, assistant: STATIC_CLASSIFICATION,
      });
      refusedChannelReads.add(channelArn);
      return [];
    }
    console.warn('[Router] Failed to list channel members:', err);
    return [];
  }
}

/** The channel's HUMAN member ARNs. */
async function getHumanMemberArns(channelArn: string, bearerArn: string): Promise<string[]> {
  return (await getMemberArns(channelArn, bearerArn)).filter(isPersonArn);
}

/** How many assistants share this conversation. See `lib/stop-target.ts` for why `/stop` asks. */
async function countAssistantsInChannel(channelArn: string, bearerArn: string): Promise<number> {
  return (await getMemberArns(channelArn, bearerArn)).filter(isAssistantArn).length;
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
  return arns.length === 1 ? (personIdFromArn(arns[0]) || '') : '';
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
    ctx: participantContextFor(arns.map((a) => personIdFromArn(a) || '')),
    source: 'live-membership',
  };
}

/**
 * A person's display name, for a greeting: through the one directory (`Directory.displayNameFor`,
 * `lib/membership-source.ts`), which reaches the person's subject in whichever trusted directory holds
 * it through `Identities`. Cached there per warm container. 'there' when nobody names them, which the
 * processor treats as "no name"; never throws, so a directory blip costs a greeting nothing worse.
 */
async function resolveUserName(personArn: string): Promise<string> {
  if (!personArn) return 'there';
  return (await defaultDirectory().displayNameFor(personArn)) || 'there';
}

/**
 * Display name for ONE conversation member, for the participant roster the prompt grounds on.
 *
 * Undefined rather than a placeholder: an unresolved member still belongs in the roster (they ARE in
 * the conversation), and a name of 'there' or 'Member' rendered into the system prompt would be the
 * assistant stating something about a person that nobody told it.
 */
async function resolveMemberName(memberArn: string): Promise<string | undefined> {
  if (!memberArn) return undefined;
  return (await defaultDirectory().displayNameFor(memberArn)) || undefined;
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

/**
 * WHAT THIS ROUTER'S TEMPLATES READ A VERSION'S VARIABLES THROUGH (ADR-060, slice 1c): the fixed sources and the
 * version's variables (`versionLookup`). The router does not read the classification's context-source catalog, so a
 * `ctx:` source is checked as the catalog's least-permitting entry (`withUnreadCatalog`) and inserts its fallback.
 * The values are the ones this router already holds, by source; anything else is unresolved, never awaited.
 */
function routerVariables(
  variables: Readonly<Record<string, VersionVariable>> | undefined,
  held: { conversationType?: string } = {},
): { lookup: SourceLookup; variables?: Readonly<Record<string, VersionVariable>>; values: Record<string, VariableValue | undefined> } {
  return {
    lookup: withUnreadCatalog(versionLookup(buildSourceTable({ catalog: [] }), variables)),
    ...(variables ? { variables } : {}),
    values: {
      ...(STATIC_CLASSIFICATION ? { 'conversation:classification': STATIC_CLASSIFICATION } : {}),
      ...(held.conversationType ? { 'conversation:type': held.conversationType } : {}),
    },
  };
}

/**
 * WHETHER A TEMPLATE'S CONDITION HOLDS WHERE THIS ROUTER SAYS IT (ADR-060 decision 6), over the values it holds, for the
 * readers the message reaches. A stored template carrying a `when` that does not hold, or a version's `messages`
 * alternative whose `when` does not, is passed over for the next.
 */
function routerHolds(resolver: ReturnType<typeof routerVariables>, channelArn: string, audience: 'room' | 'addressed'): (when: When) => boolean {
  return (when) => whenHolds(when, { ...resolver, site: { callSite: turnCallSite(undefined, channelArn), audience } });
}

interface WelcomeOrientationLoad {
  orientation: WelcomeOrientation | null;
  /** True when this deployment declares a welcome parameter, so config was EXPECTED to be there. */
  expected: boolean;
  /** Everything wrong with the configured value: read failures plus per-field parse rejections. */
  issues: string[];
  /**
   * The assistant's own opening text for THIS kind of room, when its welcome's opening step carries one.
   *
   * Resolved here rather than at the call site because this function is already the one place that
   * reads the answering assistant's profile, and a second reader would be a second chance for the two
   * to disagree about which assistant is speaking.
   */
  template?: string;
  /**
   * THE WELCOME `WelcomeIntent` STARTS in this kind of room (W1): the version's `assistant-joined` workflow its type
   * selects, else the platform's `welcome`, read from the same profile read, so knowing it costs the welcome no read of
   * its own. The platform's when the profile cannot be read.
   */
  welcome: { name: string; workflow: EventWorkflow; declared: boolean };
  /** How that welcome is said (`welcomePlan`): by the intent's reply, or by a run. */
  plan: WelcomePlan;
  /** The version the welcome is served from, and the experiment arm's definition when an arm serves it. */
  served?: ServedWelcomeVersion;
}

interface ServedWelcomeVersion {
  version: Awaited<ReturnType<typeof resolveActiveProfile>>;
  /** Present when the conversation's experiment arm serves the version, for the processor to serve it too. */
  variantProfile?: import('./lib/active-profile.js').ProfileDefinition;
}

/**
 * THE VERSION A WELCOME IS SERVED FROM: the conversation's experiment arm when it is enrolled, as an ordinary turn
 * is served (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP section 3.5), else the active version.
 *
 * THE ENROLLMENT IS READ ONLY WHEN IT CAN MATTER (SPEC-WELCOME-AND-CONTEXT FR2). The container's cached list of
 * enrollable experiments decides it with no read (`enrollmentMayApply`): when no conversation-scoped experiment is
 * live for this classification, the welcome reads only the active version, as it always did. When one is, or this
 * container holds no fresh list yet, the enrollment is read beside the active version, never after it.
 */
async function servedWelcomeVersion(profileName: string, channelArn: string | undefined): Promise<ServedWelcomeVersion> {
  const classification = STATIC_CLASSIFICATION as Parameters<typeof enrollmentOf>[1];
  const mayEnroll = !!channelArn && !!STATIC_CLASSIFICATION && !profiles.roleOfAlt(profileName)
    && enrollmentMayApply(classification) !== false;
  if (!mayEnroll) return { version: await resolveActiveProfile(profileName, { ssm: ssmClient, ssmRoot: SSM_ROOT }) };
  const armRead = enrollmentOf(channelArn!, classification)
    .then((e) => (e ? resolveEnrollment(e, classification, channelArn!, getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '')) : null))
    .catch(() => null);
  const [active, arm] = await Promise.all([resolveActiveProfile(profileName, { ssm: ssmClient, ssmRoot: SSM_ROOT }), armRead]);
  if (arm?.variantProfile) {
    try {
      return { version: resolveFromDefinition(await hydrateBodies(arm.variantProfile), profileName), variantProfile: arm.variantProfile };
    } catch (err) {
      console.warn('[Router] the conversation\'s experiment version could not be read for its welcome; the active version serves it', { err: (err as Error)?.name });
    }
  }
  return { version: active };
}

/**
 * THE ASSISTANT'S OWN WELCOME FIRST, THE CLASSIFICATION'S ONLY AS A FALLBACK.
 *
 * The welcome is an INTENT, so it belongs to the assistant that answers it rather than to the room it
 * happens in. It was read from a per-classification SSM parameter and cached on the module, so two
 * assistants in one classification introduced themselves identically - the ops assistant opened by
 * describing itself as the business advisor and offering to compile ARR reports.
 *
 * A version's welcome workflow therefore wins (W1), which also makes the opening line something a product
 * manager edits, validates, activates and rolls back like any other behavior. A version that declares none
 * runs the platform's `welcome`, whose opening step falls through to the deployment's configured
 * orientation, which is every single-assistant classification unchanged.
 *
 * NOT CACHED PER CONTAINER when it comes from a profile: `resolveActiveProfile` has its own 30-second
 * cache keyed by profile name, which is the right grain. The module-level cache below is kept for the
 * classification parameter only, and caching a per-assistant value there is exactly the bug being
 * fixed, one layer down.
 */
async function loadWelcomeFor(
  profileName: string | undefined,
  /**
   * The ROOM's classification, which is also the assistant's: an assistant acts in exactly one (ADR-042).
   *
   * PASSED IN RATHER THAN DERIVED FROM `profileName`, and the difference is the whole fix. The obvious
   * version asked `profiles.classificationFor(assistant)`, which finds the classification whose `profile`
   * field NAMES that assistant - so it answers `premium` for `advisor` and **undefined** for
   * `ops-premium`, because an additional role's assistant is declared as a profile and is named by no
   * classification. The gate below would then have read "primary unknown, allow the copy" for exactly
   * the assistant it exists to refuse, and the defect would have survived the fix that was written for it.
   */
  classification: string | undefined,
  /** The kind of room this is, so the assistant can open differently in an alert room. */
  conversationType: string | undefined,
  /** The conversation, whose experiment arm decides which version is served. */
  channelArn?: string,
): Promise<WelcomeOrientationLoad> {
  let welcome = welcomeWorkflowOf(undefined, conversationType);
  let plan = welcomePlan(welcome.workflow);
  let served: ServedWelcomeVersion | undefined;
  if (profileName) {
    try {
      served = await servedWelcomeVersion(profileName, channelArn);
      const active = served.version;
      // THE WELCOME IS THE VERSION'S `assistant-joined` WORKFLOW (W1), selected by the room's conversation type.
      welcome = welcomeWorkflowOf(active.eventWorkflows, conversationType);
      plan = welcomePlan(welcome.workflow);
      // ── THROUGH THE SAME PARSER THE DEPLOYMENT PARAMETER GOES THROUGH ────────────────────────────
      //
      // The parser rejects the PER-CONVERSATION fields (`topic`, `priorSubject`, `parentRef`,
      // `quotedMessage`) because those carry member trust and a version must not be able to set them;
      // and it type-checks and caps `examples`, so a string or a number there never reaches
      // `composeWelcome`.
      //
      // A version is edited at runtime by whoever holds `manage-profiles`, so it is the LESS trusted
      // of the two sources, not the more. Parsing a JSON round-trip rather than the object keeps one
      // implementation of that contract.
      // THE ASSISTANT'S OPENING FOR THIS KIND OF ROOM: the template step of the welcome its type selects. An opening
      // step with no field of its own falls through to the deployment copy. The console's preview reads an opening
      // through the same function, so it shows what this posts.
      const own = selectOpening(plan.opening);
      if (own?.template) {
        return { orientation: own.orientation, expected: true, issues: own.issues, template: own.template, welcome, plan, served };
      }
      if (own?.orientation) {
        if (own.issues.length) {
          console.warn('[Router] the assistant\'s own welcome carries fields it may not set; they are '
            + 'ignored and the rest is used', { profileName, issues: own.issues });
        }
        return { orientation: own.orientation, expected: true, issues: own.issues, welcome, plan, served };
      }
    } catch (err) {
      // Falls through to the classification's copy rather than failing the greeting: a welcome that
      // cannot be resolved must still be a welcome, and the deployment's own is the honest default.
      console.warn('[Router] could not read the assistant\'s own welcome; using the classification copy',
        { profileName, err: err instanceof Error ? err.message : String(err) });
    }
  }
  // ── THE CLASSIFICATION'S COPY BELONGS TO THE ASSISTANT THE CLASSIFICATION NAMES ────────────────
  //
  // The comment above says a profile declaring no welcome "falls through to the deployment's
  // configured orientation, which is every single-assistant classification unchanged" - and that was
  // the whole fix while a classification held one assistant. It does not hold for two. Measured on
  // this deployment: NEITHER premium assistant's active version carries a `welcome`, so both fall
  // through to `assistant/premium/welcome-orientation` and both introduce themselves as the advisor.
  // The per-assistant cache one layer down is correct and simply has nothing to cache.
  //
  // So the fallback is scoped to the primary. A second assistant with no welcome of its own gets the
  // platform default, which says nothing specific rather than something specific and false.
  // `profileFor`, not `requireProfileFor`: the latter THROWS on a classification the config does not
  // declare, and the channel tag is an outside value, so the absence is a real answer here. A throw
  // would kill a welcome over a question that has a perfectly good "unknown".
  const classificationPrimary = classification ? profiles.profileFor(classification)?.name : undefined;
  if (profileName && classificationPrimary && !deploymentCopyAppliesTo(profileName, classificationPrimary)) {
    console.log(deploymentCopySkipped('welcome orientation', profileName, classificationPrimary));
    return { orientation: null, expected: false, issues: [], welcome, plan, served };
  }
  return { ...(await loadWelcomeOrientation()), welcome, plan, served };
}

async function loadWelcomeOrientation(): Promise<Omit<WelcomeOrientationLoad, 'welcome' | 'plan'>> {
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

/**
 * The classification's OWN processor from the environment (`classificationEnvName(c,
 * 'ASYNC_PROCESSOR_ARN')`, the one naming rule the stack sets it by), or empty. Never another classification's processor (ADR-046): a value this
 * deployment does not declare has no processor, and the caller's empty-ARN path declines the turn.
 * Read per call, so a test or a classification added in `config/profiles.ts` needs no edit here.
 */
function envAsyncProcessorArn(classification: string): string {
  const declared = profiles.resolveClassification(classification);
  if (!declared) return '';
  return (process.env[classificationEnvName(declared, 'ASYNC_PROCESSOR_ARN')] || '').trim();
}

// Resolved classification → processor ARN (only SSM hits are cached, so once a classification
// resolves to its per-classification processor it stays cached for the life of the warm
// container; a classification without a published SSM param re-checks SSM each turn and
// thus picks up its AgentEchelonAssistants-* processor the moment that stack is
// deployed — no router redeploy).
const processorArnCache = new Map<string, string>();

/**
 * Resolve the classification's async-processor ARN, preferring the per-classification stack's
 * SSM-published value (/agent-echelon/assistant/{classification}/processor-arn) and then the same
 * classification's `{CLASSIFICATION}_ASYNC_PROCESSOR_ARN` env var. Both name that classification's own
 * processor. A value this deployment does not declare resolves to empty without a read, and the
 * caller declines the turn: no classification's turn runs on another classification's processor.
 */
async function resolveAsyncProcessorArn(classification: string): Promise<string> {
  if (!profiles.resolveClassification(classification)) {
    console.warn('[Router][SecurityEvent] no processor for an undeclared classification; the turn is declined', { classification });
    return '';
  }
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
  /**
   * THE AMAZON LEX BOT THIS TURN ARRIVED ON, which is the only thing that says which assistant was
   * addressed: Amazon Chime SDK supplies no addressed-bot attribute (see section 10a of
   * DESIGN-ADDING-AN-ASSISTANT-ROLE). Each additional role owns a Lex bot and its assignment record
   * names the id, so the invocation identifies the assistant because the Lex bot does.
   */
  bot?: { id?: string; name?: string; aliasId?: string };
}

interface LexResponse {
  sessionState: {
    dialogAction: { type: string };
    intent: { name: string; state: string };
    sessionAttributes?: Record<string, string>;
  };
  messages: Array<{ contentType: string; content: string }>;
  /**
   * WHO THIS TURN IS, for a caller that has to post the message on its behalf.
   *
   * BYPASS-ONLY, AND IT NEVER REACHES AMAZON LEX. The entry wrapper returns before `postAsAssistant`
   * for anything that is not a flow entry (`if (!isFlowEntry(event)) return response`), so this field
   * is set only on the path whose response goes back to the channel flow through our own
   * `lambda:InvokeFunction`. Amazon Chime SDK never materializes a response carrying it.
   *
   * Set only when this handler could NOT post the message itself - an unresolved identity, or a send
   * that threw. The flow then posts it as the fallback, and without this it would post the turn's own
   * acknowledgment with no attribution, which is the defect this whole change removes. The assistant
   * saying who it is must survive the assistant failing to speak.
   */
  aeAttribution?: BotMessageAttribution;
}

/**
 * Fulfil the intent and show the user nothing.
 *
 * NO LONGER THE DUPLICATE-FULFILLMENT PATH. A duplicate now replays the SAME placeholder rather than
 * going silent, because silencing it drops the turn: Chime materializes one message per turn from the
 * LAST fulfillment response, so the attempt this used to silence is frequently the only one the user
 * would have seen. See the claim check in `handleAgentRequest` for the traced failure.
 *
 * Retained because the client and the e2e capture must both keep tolerating an empty envelope:
 * envelopes already written to channel history do not disappear.
 *
 * An EMPTY ARRAY, not an absent field. Chime posts the Lex envelope either way, so something lands in
 * the channel regardless; the question is only whether the client recognizes it. `chimeService`
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

/**
 * A `WelcomeIntent` that posts nothing, where a run greets the room (ADR-061 decision 5). Not `formatLexSilentResponse`:
 * a join that closes with no message makes Amazon Chime SDK post `{"Code":500}` as the assistant, past the channel flow.
 * This returns the one message the flow denies (`NOTHING_TO_POST`, `lex-envelope.ts`), so the room holds nothing.
 */
export function formatLexNothingToPost(event: LexEvent): LexResponse {
  return formatLexResponse(event, [{ contentType: 'PlainText', content: NOTHING_TO_POST }]);
}

/**
 * The reply to Lex. The session attributes are ECHOED, never written: no turn state lives in the Amazon
 * Lex session, because a turn the channel flow answers has none and Lex drops it after five idle minutes.
 * Echoing rather than clearing leaves Lex's own session untouched.
 */
function formatLexResponse(
  event: LexEvent,
  messages: Array<{ contentType: string; content: string }>,
): LexResponse {
  return {
    sessionState: {
      dialogAction: { type: 'Close' },
      intent: {
        name: event.sessionState.intent.name,
        state: 'Fulfilled',
      },
      sessionAttributes: { ...event.sessionState.sessionAttributes },
    },
    messages,
  };
}

function extractUserSub(event: LexEvent): string {
  const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
  return personIdFromArn(senderArn) || '';
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
 * Bypassing Lex is the ONLY sanctioned difference (MESSAGE-FLOW §6.1); a bypass that re-implemented
 * classification, profile resolution or variant resolution would be a second turn path, and a second
 * turn path diverges SILENTLY - the turn still answers, so nothing errors and no test fails.
 */
export interface TurnRequest {
  /**
   * When the channel flow received the message, on the server clock. Set only on the standard path;
   * a Lex-entered turn never crossed the flow. Carried to the worker beside `routerSteps`, never
   * folded into them: those are the router's own span, and `routerMs` is their first-to-last.
   */
  flowReceivedAt?: number;
  channelArn: string;
  /** The human who spoke. Drives identity, grounding and the user's profile. */
  senderArn: string;
  /**
   * Already decoded. The caller strips its own command token (`@all`, `/battle`) first.
   *
   * OPTIONAL, because a reference-only handover deliberately carries no text: the receiving assistant
   * resolves the message from `userMessageId` with its own permissions, so that the boundary is what it
   * may read rather than what the sender chose to repeat. A caller that has the text still passes it.
   */
  userMessage?: string;
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
   * Whether the turn's own reply is TARGETED at the asker rather than shown to the room.
   *
   * DECLARED, BECAUSE THE LOOKUP CANNOT ESTABLISH IT ON THIS PATH. `inboundMessage()` decides
   * targeting by finding the stored channel message whose content matches the turn's text. A flow
   * dispatch strips its own address token first (`stripAtAll`, `stripMentionOf`), so the dispatched
   * text NEVER equals the stored content and that match cannot succeed - not rarely, structurally.
   * The lookup then returns `undefined`, the task is written with no visibility, and an absent
   * visibility reads as private (`task-visibility.ts`). Every task opened by an openly-asked `@all`
   * turn was therefore private, and the room was told the assistant had replied privately.
   *
   * The flow already holds the fact as `broadcast`, so it declares it here for the same reason it
   * declares `userMessageId`: the caller knows, and deriving it again downstream is a second
   * implementation that disagrees silently.
   */
  targeted?: boolean;
  /**
   * HOW MANY TIMES THIS TURN HAS ALREADY FOLDED IN AN AMENDMENT.
   *
   * A person may keep amending, and each fold restarts the step. Unbounded, that is a turn held for
   * as long as somebody keeps typing - the stranding tenet 2 forbids, reached by a route that looks
   * like responsiveness. Bounded by a count for the same reason the triage chain is: a wall clock
   * would guess at how long the work should take.
   */
  amendedFold?: number;
  /**
   * THE QUEUED MESSAGES THIS TURN'S ANSWER ADDRESSES, by Amazon Chime SDK `MessageId`.
   *
   * ── WHY THIS IS A DECLARATION AND NOT AN INFERENCE ────────────────────────
   *
   * ADR-033 argued that queued messages "do not map one-to-one onto answers" and that marking each
   * queued message with the answer that addressed it "has no correct behavior to implement". That
   * objection was about INFERRING the mapping from adjacency or transcript ordering, and it stands
   * for that. It does not bind here, because this list is not inferred: the reading produces exactly
   * one entry per queued message and labels it `amends`, `new` or `unclear`, and the fold takes the
   * `amends` entries and rolls them into the running answer. The fold is the moment the mapping
   * becomes a recorded fact - these messages are answered by THIS answer - and this is where it is
   * written down. Where one reply addresses three queued messages, all three are named here.
   *
   * It accumulates across folds: a turn that folds twice answers both batches, and both are named.
   */
  foldedMessageIds?: string[];
  /**
   * THE INTENT EACH FOLDED MESSAGE WAS CLASSIFIED AS WHEN IT QUEUED, by message id (ADR-064 decision B). Declared on the
   * answer beside `foldedMessageIds`, so each folded message's exchange carries its own intent.
   */
  foldedIntents?: Record<string, string>;
  /**
   * THE PERSON'S OWN WORDS, when `userMessage` is a contract assembled around them.
   *
   * Set by a caller that wraps instructions around what somebody wrote - today the amendment fold.
   * The input guardrail screens this instead of `userMessage`, because screening our own scaffolding
   * protects nobody and blocks the turn. See `BYPASS_USER_CONTENT_ATTR` for what that cost.
   */
  userContent?: string;
  /**
   * Attachment-in (image or document) carried on the user's message.
   *
   * The flow reads it from the message Metadata, which Lex never sees, so this is the only way it can
   * reach the turn. Forwarded to the async processor unchanged.
   */
  attachment?: MessageAttachment;
  /**
   * THE OPEN ITEM THIS TURN ANSWERS, already decided, by task id.
   *
   * Set by the channel flow when the message named an item in its `Metadata` rather than in its text
   * (`resolveReferenceTarget`). It is the id form of a leading `#<n>`: the person said which item this
   * is, so the turn fixes that item instead of ranking candidates and letting the model pick.
   *
   * ALREADY CHECKED, AND NOT RE-OPENED. The flow asked the task service whether this sender may answer
   * this item before dispatching, which is the same permission the reference path applies; the turn
   * still intersects it with the rows it reads for itself, so a stale id narrows to nothing rather
   * than widening what this person may reach.
   *
   * Absent on every Lex turn, which has no metadata to carry it.
   */
  answersTaskId?: string;
  /**
   * Which bot identity this turn answers as.
   *
   * The handler otherwise resolves exactly ONE identity, from its per-classification SSM parameter. A
   * duel has two sides, so the caller has to say which. VALIDATED against this classification's own bot
   * and its assignment records (`isSanctionedBattleBot`) - an unchecked
   * caller-supplied identity would let anything able to invoke this handler post as any bot in the
   * app instance.
   *
   * Absent ⇒ the classification's own bot, exactly as on the Lex path.
   */
  botArn?: string;
  /**
   * The receiver's own advertised intent key, when a roommate handed this turn over.
   *
   * NOT the sender's opinion of what the work is: the key comes out of the RECEIVER's published
   * advertisement, so this hands a category back to the assistant that declared it. It exists because a
   * reference-only handover leaves the receiving turn with no transcript to classify - measured, as an
   * empty message classified `general` - which costs that assistant its own per-intent delivery option
   * and model route on the one turn it was chosen for.
   */
  handedOverIntent?: string;
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
   * processor. Absent ⇒ ordinary behavior.
   *
   * **NO PRODUCER SINCE [ADR-029].** The battle continuation was the only caller; it now posts its own
   * placeholder like every other turn and passes `battleContext.clearWaitingMarkerMessageId` instead,
   * which names a message to un-mark rather than one to answer onto. This field, the
   * `BYPASS_PLACEHOLDER_ATTR` silence branch below and the processor's handed-id resolution step are
   * therefore unreachable, and are kept only until the removal is done deliberately with its tests.
   * Do not add a caller: answering onto a message that already exists is what put a
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
   *
   * `join_recap` also changes what the turn IS: the room's primary catches up a person who was just
   * added, privately, answering its own copy rather than a message (`isJoinRecap`, `lib/join-recap.ts`).
   * Such a turn carries no `userMessage` and no `botArn`; the router supplies both.
   */
  trigger?: InteractionKind;
  /**
   * WHEN THE CAUSE HAPPENED, epoch ms, declared by the dispatcher that knows it.
   *
   * Without this a proactive turn has a KIND but nothing to measure from, so it is named and still
   * unmeasured. Absent is legal and means exactly that - the metric stays NULL rather than being
   * anchored to the dispatch, which would report a repaired turn as fast by excluding the whole
   * detection delay the person actually waited through.
   */
  triggerAtMs?: number;
  /**
   * THIS TURN IS A TRIAGE TURN (ADR-033): what it is reading, and what the work it creates may be
   * seen by.
   *
   * Its `userMessage` is the triage PROMPT rather than anything a person wrote, which is why this
   * travels separately: the parse must key on what was actually queued, not on what the prompt
   * happens to say, and the visibility was decided from message targeting the prompt does not carry.
   */
  triage?: TriageTurnContext;
  /**
   * THIS TURN IS THE JUDGED HALF OF A `/stop` (ADR-033): it evaluates why the stop was sent and asks
   * what to do with the work being held.
   *
   * Like the triage turn, its `userMessage` is a prompt rather than anything a person wrote, and it
   * must not claim the conversation: it is not answering a new message, and queueing it behind the
   * turn it is asking ABOUT would deliver the question only once that turn had ended.
   */
  stopEvaluation?: StopEvaluationContext;
  /**
   * THIS TURN ARRIVED BY HANDOVER, and names the assistant that passed it on (a principal id).
   *
   * Routing follows the TASK, never who the message was addressed to (maintainer, 2026-08-14). A person can
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
  /**
   * THE HANDOVER MESSAGE THIS TURN WAS STARTED FROM (`lib/assistant-handover.ts`).
   *
   * Required on every `trigger: 'handover'` turn, and it is the authority rather than this payload: the
   * receiving turn reads the message back as its own bearer and proceeds only when an assistant of this
   * classification sent it, it is targeted at this assistant, and it references a person's message. So a
   * caller able to invoke this handler cannot start a handed-over turn without a real handover in the
   * conversation, and an assistant cannot start another assistant's turn by naming it in a payload.
   */
  handoverMessageId?: string;
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
 * unavoidable: Lex materializes a message from the fulfillment return, and a bypass has no Lex return
 * to materialize, so somebody has to call `SendChannelMessage`. It is also harmless to measurement -
 * TTFF is placeholder minus user message on the Amazon Chime SDK clock, which does not care which
 * component wrote it (LATENCY-TARGETS).
 *
 * An EMPTY `messages` array means POST NOTHING - a silent turn, or a duplicate fulfillment that lost
 * its claim (ADR-022). The caller must honor it rather than inventing a bubble.
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
 * correlation claim reports itself (ADR-022), and the caller must honor it rather than inventing a
 * bubble.
 */
export interface BypassTurnEvent {
  aeTurn: TurnRequest;
}

/** Marks the invocation as the flow's, so guards that exist to keep LEX quiet do not fire here. */
const FLOW_ENTRY_ATTR = 'AE.entry';
const FLOW_ENTRY_VALUE = 'channel-flow';
/**
 * A TURN THIS SYSTEM DISPATCHED TO ITSELF, rather than a person speaking.
 *
 * The region below asks what is waiting on a PERSON and whether this turn bears on it. A turn this
 * system dispatched to itself is not a person and bears on nothing: it carries a prompt written
 * here, to re-read a queue.
 *
 * AN EARLIER VERSION OF THIS COMMENT SAID the region rests on "speaking here is the answer", true of
 * a person and false of a machine. That was wrong twice over. Speaking is never the answer - only a
 * relevant message is - so the rule does not hold for a person either, and the real distinction is
 * not person-versus-machine at all. It is that relevance is JUDGED, and a self-dispatched turn is
 * not a candidate for that judgement in the first place.
 *
 * Observed live: a triage fold re-dispatched pass 2, an awaited task existed by then because the
 * turn being triaged behind had asked its own question, and the region took the turn - not by
 * applying the prompt to the task, which it correctly declined to do, but by matching the
 * chain-resume path and dispatching it onward as an ORDINARY turn. The triage context never reached
 * the processor, so no reading ran and the queue stayed put. Pass 1 escaped only because nothing was
 * awaiting yet when it went.
 *
 * Read from the request attribute rather than from the turn context, which is assembled a thousand
 * lines further down - long after these branches have already decided what the turn is.
 */
function isSelfDispatchedTriage(event: { requestAttributes?: Record<string, string> }): boolean {
  return !!parseTriageTurnContext(event.requestAttributes?.[BYPASS_TRIAGE_ATTR])?.ids.length;
}

/**
 * A turn this assistant wrote to itself, of ANY kind - a triage reading or a stop evaluation.
 *
 * A stop evaluation has the same shape as a self-dispatched triage: the `userMessage` is written by
 * the machine and the sender is a real person, so anything reading the message as that person's
 * words is wrong about both. Triage was excluded from those branches and the stop evaluation was
 * excluded nowhere, because it is not parsed until a thousand lines further down.
 *
 * What that cost: a `/stop` sent while the person had a task awaiting them applied the
 * machine-written stop prompt AS their answer to it. If the task belonged to another assistant,
 * `handOverToOwningAssistant` then built a TurnRequest with no `stopEvaluation` at all, and the
 * stop question was lost outright.
 */
function isMachineWrittenTurn(event: { requestAttributes?: Record<string, string> }): boolean {
  return isSelfDispatchedTriage(event)
    || !!parseStopEvaluationContext(event.requestAttributes?.[BYPASS_STOP_EVAL_ATTR])
    // A join recap: its message is the assistant's own copy, and the new member said nothing.
    || isJoinRecap(event);
}

/**
 * AN AMENDMENT FOLD RE-RUNS A TURN THAT ALREADY RAN THIS PATH (live 2026-09-14).
 *
 * Its message is the original request with the follow-ups folded in, assembled by this system, so it
 * is not the person answering anything: the original run already applied their message to the task,
 * checked drift and read any stop question. Treated as a person speaking, the fold was applied a
 * SECOND time as the answer to an open task.
 *
 * DELIBERATELY NOT `isMachineWrittenTurn`. That also skips the task lookup, and a fold must keep the
 * task context the turn it re-runs had, or a report step re-runs as a general answer.
 */
function isAmendmentFold(event: { requestAttributes?: Record<string, string> }): boolean {
  return Number(event.requestAttributes?.[BYPASS_AMENDED_FOLD_ATTR]) > 0;
}

/** The inbound message id, when the caller can declare it. See `TurnRequest.userMessageId`. */
const BYPASS_MESSAGE_ID_ATTR = 'AE.message.id';
/** When the channel flow received the message. See `TurnRequest.flowReceivedAt`. */
const BYPASS_FLOW_RECEIVED_ATTR = 'AE.flow.receivedAt';
/**
 * Whether the reply is targeted at the asker. See `TurnRequest.targeted`.
 *
 * Carried as the string `'1'` / `'0'` rather than omitted-when-false, because ABSENT and FALSE mean
 * different things here: absent is "nobody established it" (leave the task private), false is "the
 * caller checked, it is public". Collapsing them is the bug this attribute exists to fix.
 */
const BYPASS_TARGETED_ATTR = 'AE.turn.targeted';
/** The turn's attachment, JSON-encoded. See `TurnRequest.attachment`. */
const BYPASS_ATTACHMENT_ATTR = 'AE.attachment';
/** The open item this turn answers, by id. See `TurnRequest.answersTaskId`. */
const BYPASS_ANSWERS_TASK_ATTR = 'AE.turn.answersTask';
/** Which bot identity to answer as. See `TurnRequest.botArn`. */
const BYPASS_BOT_ARN_ATTR = 'AE.bot.arn';
/** A caller-declared correlation id. See `TurnRequest.correlationId`. */
const BYPASS_CORRELATION_ATTR = 'AE.corr';
/** Battle coordination context, JSON-encoded. See `TurnRequest.battleContext`. */
const BYPASS_BATTLE_ATTR = 'AE.battle';
/** What caused the turn. See `TurnRequest.trigger`. */
const BYPASS_TRIGGER_ATTR = 'AE.trigger';
/** The receiver's OWN advertised intent key, when this turn was handed to it by a roommate. */
const BYPASS_HANDED_INTENT_ATTR = 'AE.handedOverIntent';
/** When the cause happened, epoch ms as a string. See `TurnRequest.triggerAtMs`. */
const BYPASS_TRIGGER_AT_ATTR = 'AE.trigger.at';
/** What a triage turn is reading, and for whom. See `TurnRequest.triage`. */
const BYPASS_TRIAGE_ATTR = 'AE.triage.queued';
/**
 * How many amendments this turn has already folded in, carried across the same hop as the triage
 * context and for the same reason: Amazon Chime SDK gives Lex three request attributes, so anything
 * a turn must know about ITSELF travels here or not at all. Without it the fold count resets on
 * every re-dispatch and the bound that stops a person holding a turn by amending never binds.
 */
const BYPASS_AMENDED_FOLD_ATTR = 'AE.turn.amendedFold';
/**
 * WHICH QUEUED MESSAGES THIS TURN'S ANSWER ADDRESSES. See `TurnRequest.foldedMessageIds`.
 *
 * Comma-joined, because a request attribute is a string. Every id is checked against the declarable
 * value pattern before it is joined and again when it is read back, so a value that could not
 * survive the round trip is dropped rather than mangled - the same rule `turn-declaration.ts`
 * applies, and for the same reason: a truncated message id names nothing and looks like a value.
 */
const BYPASS_FOLDED_IDS_ATTR = 'AE.turn.foldedIds';
/**
 * WHAT EACH FOLDED MESSAGE ASKED FOR. See `TurnRequest.foldedIntents`.
 *
 * `<messageId>:<intent>` pairs, comma-joined, each half checked against the declarable value pattern on the way in and
 * on the way back, so a pair that could not survive the hop is dropped rather than attributing a message to a mangled
 * intent.
 */
const BYPASS_FOLDED_INTENTS_ATTR = 'AE.turn.foldedIntents';
/** The folded intents as the attribute carries them, keeping only pairs whose halves both round-trip. */
export function encodeFoldedIntents(intents: Record<string, string> | undefined): string {
  return Object.entries(intents ?? {})
    .filter(([id, intent]) => isDeclarableValue(id) && isDeclarableValue(intent))
    .map(([id, intent]) => `${id}:${intent}`)
    .join(',');
}
/** The folded intents read back from the attribute, dropping any pair a hop mangled. */
export function decodeFoldedIntents(value: string | undefined): Record<string, string> {
  const byId: Record<string, string> = {};
  for (const pair of String(value || '').split(',')) {
    const [id, intent, extra] = pair.trim().split(':');
    if (extra === undefined && id && intent && isDeclarableValue(id) && isDeclarableValue(intent)) byId[id] = intent;
  }
  return byId;
}
/**
 * WHAT A PERSON ACTUALLY WROTE, when this turn's `userMessage` is an assembled contract.
 *
 * A fold rewrites `userMessage` into the original request plus instructions telling the model how to
 * treat the amendment ("answer the request AS AMENDED", "do not mention that a revision happened").
 * That is the shape of a prompt-injection attempt, so the input guardrail's prompt-attack filter
 * fires on our own scaffolding and blocks the turn before the model is called. Observed live
 * 2026-09-09 on the turn-queue sweep: the amendment was folded, the turn was re-dispatched, and
 * `input guardrail intervened; blocking turn before model call` replaced a finished report with a
 * refusal - `scoredIsWholePrompt: true`, 856 characters of contract screened as though a person had
 * typed them.
 *
 * THE THIRD PATH TO DO THIS. `turn-triage.ts` carries the fix for the reading turn and
 * `stop-evaluation.ts` for the stop, each with the same reasoning written above it. The answer is
 * never to stop screening; it is to screen the part that is actually untrusted.
 */
const BYPASS_USER_CONTENT_ATTR = 'AE.turn.userContent';

/**
 * WHICH ATTEMPT AT A TURN THIS IS, for the delivery dedup key.
 *
 * A turn keeps ONE correlation id for its whole chain - that identity is load-bearing well past
 * delivery: arrival triage names its turn by the triage claim it holds, so a reading turn's
 * correlation id IS `triagedBy`, and `turn-handover` recognizes "this turn was the reading" by
 * comparing them. Giving a re-dispatch a fresh id trades a stranded queue for a dead conversation.
 *
 * So the two identities are separated: the turn keeps its id, and only the DELIVERY key carries
 * which attempt is being delivered. Anything that re-enters the router on the same correlation has
 * to appear here, or the duplicate-fulfillment guard reads it as a redelivery of the turn that
 * dispatched it, replays that turn's placeholder, and returns without dispatching anything.
 *
 * TWO THINGS RE-ENTER, and each cost a live conversation before it was added:
 *
 *   - A FURTHER TRIAGE PASS, when the queue moved under a reading. Observed as "more arrived while
 *     reading; folding into one answer" followed 79ms later by "duplicate fulfillment", with the
 *     queue never draining.
 *   - AN AMENDMENT FOLD, when a reading judged that something arriving mid-turn changes the work
 *     rather than starting new work. Observed 2026-09-05 on `bd3444ecd844c285`: folded at
 *     14:33:24.374, "duplicate fulfillment" at 14:33:26.038, and that id never appears again. The
 *     person watched "One moment..." for the rest of the conversation, the lock stayed held until
 *     the staleness takeover, and the amendment was already gone - `clearAmendments` runs as soon
 *     as the fold is dispatched, because losing it to a failed invoke is the worse outcome. The
 *     invoke had succeeded; it was this guard that discarded the turn.
 *
 * Both discriminators already travel on the request. The empty string for a first attempt is what
 * keeps the key identical to what it has always been for the ordinary turn, so this narrows nothing
 * that was working: a genuine retry of a fold still dedups against that fold.
 */
export function deliveryAttemptSuffix(requestAttributes?: Record<string, string>): string {
  const t = parseTriageTurnContext(requestAttributes?.[BYPASS_TRIAGE_ATTR]);
  const pass = t?.pass && t.pass > 1 ? `#p${t.pass}` : '';
  const raw = Number(requestAttributes?.[BYPASS_AMENDED_FOLD_ATTR] ?? 0);
  const fold = Number.isFinite(raw) && raw > 0 ? `#f${raw}` : '';
  return `${pass}${fold}`;
}
/** That this turn is the judged half of a stop. See `TurnRequest.stopEvaluation`. */
const BYPASS_STOP_EVAL_ATTR = 'AE.stop.evaluation';
/** An existing message to answer onto. See `TurnRequest.placeholderMessageId`. */
const BYPASS_PLACEHOLDER_ATTR = 'AE.placeholder.id';
/** The assistant that handed this turn over. See `TurnRequest.handedOverFrom`. */
const BYPASS_HANDOVER_ATTR = 'AE.handover.from';
/** The handover message a handed-over turn was started from. See `TurnRequest.handoverMessageId`. */
const BYPASS_HANDOVER_MESSAGE_ATTR = 'AE.handover.message';

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
    // `?? ''` BECAUSE `encodeURIComponent(undefined)` IS THE STRING "undefined". A reference-only
    // handover carries no text by design, so this field is legitimately absent on that entry - and
    // without the guard the receiving turn was handed the four-character word "undefined" as the
    // person's message. Measured: it classified that string, landed on `general`, and the assistant
    // replied "it looks like your message came through empty" - which was true, and arrived by a route
    // nothing would have flagged, because a non-empty string is what every downstream check tests for.
    inputTranscript: encodeURIComponent(req.userMessage ?? ''),
    sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
    requestAttributes: {
      'CHIME.channel.arn': req.channelArn,
      'CHIME.sender.arn': req.senderArn,
      [FLOW_ENTRY_ATTR]: FLOW_ENTRY_VALUE,
      ...(req.userMessageId && { [BYPASS_MESSAGE_ID_ATTR]: req.userMessageId }),
      ...(req.flowReceivedAt !== undefined && { [BYPASS_FLOW_RECEIVED_ATTR]: String(req.flowReceivedAt) }),
      ...(req.targeted !== undefined && { [BYPASS_TARGETED_ATTR]: req.targeted ? '1' : '0' }),
      ...(req.attachment && { [BYPASS_ATTACHMENT_ATTR]: JSON.stringify(req.attachment) }),
      ...(req.answersTaskId && { [BYPASS_ANSWERS_TASK_ATTR]: req.answersTaskId }),
      ...(req.botArn && { [BYPASS_BOT_ARN_ATTR]: req.botArn }),
      ...(req.correlationId && { [BYPASS_CORRELATION_ATTR]: req.correlationId }),
      ...(req.battleContext && { [BYPASS_BATTLE_ATTR]: JSON.stringify(req.battleContext) }),
      ...(req.trigger && { [BYPASS_TRIGGER_ATTR]: req.trigger }),
      ...(req.handedOverIntent && { [BYPASS_HANDED_INTENT_ATTR]: req.handedOverIntent }),
      // Stringified because request attributes are a string map. Read back with a finite-number guard
      // on the other side, so a malformed value is an absent instant rather than a NaN latency.
      ...(req.triggerAtMs !== undefined && { [BYPASS_TRIGGER_AT_ATTR]: String(req.triggerAtMs) }),
      // JSON, because it is a record. Read back with a shape guard: a malformed value must yield NO
      // triage context rather than a half-parsed one, which would make the reply unmatchable and, if
      // the visibility were the part that went missing, would show private work to the room.
      ...(req.triage?.ids.length && { [BYPASS_TRIAGE_ATTR]: JSON.stringify(req.triage) }),
      ...(req.amendedFold ? { [BYPASS_AMENDED_FOLD_ATTR]: String(req.amendedFold) } : {}),
      ...(req.foldedMessageIds?.filter(isDeclarableValue).length
        ? { [BYPASS_FOLDED_IDS_ATTR]: req.foldedMessageIds.filter(isDeclarableValue).join(',') }
        : {}),
      ...(encodeFoldedIntents(req.foldedIntents) ? { [BYPASS_FOLDED_INTENTS_ATTR]: encodeFoldedIntents(req.foldedIntents) } : {}),
      ...(req.userContent ? { [BYPASS_USER_CONTENT_ATTR]: req.userContent } : {}),
      ...(req.stopEvaluation && { [BYPASS_STOP_EVAL_ATTR]: JSON.stringify(req.stopEvaluation) }),
      ...(req.placeholderMessageId && { [BYPASS_PLACEHOLDER_ATTR]: req.placeholderMessageId }),
      ...(req.handedOverFrom && { [BYPASS_HANDOVER_ATTR]: req.handedOverFrom }),
      ...(req.handoverMessageId && { [BYPASS_HANDOVER_MESSAGE_ATTR]: req.handoverMessageId }),
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
    // own rows. Which side is the challenger the turn reads from the alt's assignment record (`resolveDuelSides`).
    const rivalBotArn = rows.find((r) => r.botArn !== botArn)?.botArn ?? '';
    // THE MESSAGE THE SIDE PARKED ON, whose `<!--battlewaiting-->` marker the resumed turn takes down
    // (ADR-029): the step or question stays in the transcript and its answer control ends, because the
    // person has answered it. Read from the rows taken before the resume; the resume leaves it in place.
    const waitingMessageId = rows.find((r) => r.botArn === botArn)?.waitingMessageId;
    return {
      battleId: duel.battleId,
      round: 1,
      totalRounds: 2,
      selfBotArn: botArn,
      rivalBotArn,
      ...(waitingMessageId ? { clearWaitingMarkerMessageId: waitingMessageId } : {}),
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
 * A bypass caller declares it as `AE.message.id`. The Lex path is read for `CHIME.message.id` too, but
 * Amazon Chime SDK sends Lex no message id (the three request attributes are the channel, the sender and
 * the platform), so on a Lex turn this is normally undefined and the id is resolved from the channel. ONE accessor, because reading only the
 * Lex form silently yields `undefined` on every bypass - which does not fail, it just records a task
 * response with no message behind it (ADR-024 D5), and the gap only shows up much later as a chain
 * nobody can trace back to what answered it.
 *
 * EXPORTED SO THE RESOLUTION CAN BE EXECUTED RATHER THAN READ. Two things key off this - the one
 * handover per message claim and the reference a handover carries - and both are silently inert rather
 * than broken when it returns `undefined`: the claim skips, and a redelivery buys a second model turn.
 * A test that reads the call site cannot tell a populated key from a blank one, so it is asserted by
 * calling it with each entry's own attributes (`delegation-sits-after-drift-and-before-the-claim`).
 */
export function inboundMessageId(event: LexEvent): string | undefined {
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
function handoverAcknowledgement(owningAssistantName: string, words: VersionWords = {}): string {
  return templateLine('handover-receipt', words, { values: { name: owningAssistantName } });
}

/**
 * What to CALL the assistant the work went to, in copy a person reads.
 *
 * Its principal id is not it. `Alt-premium` names a role's alt, and in a duel the name in the channel is
 * the duel side's, from its profile - so printing the id would name something the person has never seen, in a
 * message whose only job is to tell them where their answer went.
 *
 * Best-effort, and the fallback is deliberately vague rather than precise-and-wrong: the owning
 * assistant's reply arrives in the conversation moments later under its own name, so a receipt that
 * says "another assistant here" costs a little and a receipt that says `Alt-premium` costs trust.
 *
 * KNOWN GAP, AND AN ATTEMPT AT IT WAS REVERTED (2026-09-21). Only a BATTLE variant resolves here; an
 * ordinary renamed assistant falls to the vague phrasing, because the bot's principal id
 * (`premium-bot`) is not the profile name (`advisor`).
 *
 * The assignment record now maps a bot to its assistant, so the mapping exists - but reading it here
 * made the receipt WORSE in both cases it can actually reach today, which is why it is not wired:
 *
 *   - The only sanctioned handover target in a one-assistant classification is that role's ALT, and
 *     its recorded assistant is `alt-{role}`. That is a record name, not a name anybody has seen, and
 *     printing it is precisely what the paragraph above says costs trust.
 *   - For an ordinary assistant, `displayNameFor(assistant)` without the active version's
 *     `displayName` returns the PROVISIONED name - so a renamed assistant, the one case this was
 *     for, is named by what it used to be called. Precise and wrong is worse than vague.
 *
 * What it needs, stated so the next attempt starts from it: resolve the assistant's ACTIVE VERSION
 * and take its `displayName` (that is where a rename lives, and what `apply-assistant-name.ts`
 * pushes onto the identity), and skip record-shaped names rather than rendering them. Neither is
 * hard; both were missing, and the case they serve - a second ordinary assistant in one
 * classification - does not exist yet, so the machinery was pure risk.
 */
async function owningAssistantDisplayName(owningBotArn: string): Promise<string> {
  try {
    // The duel's challenger in this classification, when the work went to it.
    const challenger = await duelChallengerOf(STATIC_CLASSIFICATION);
    const variant = challenger && challenger.botArn === owningBotArn ? await resolveBattleTreatment(challenger.assistant) : null;
    if (variant?.displayName) return variant.displayName;
  } catch (err) {
    console.warn('[Router] could not resolve the owning assistant\'s display name:', err);
  }
  return 'another assistant here';
}

/**
 * A person's message answers work a DIFFERENT assistant owns, so give it to that assistant.
 *
 * ROUTING FOLLOWS THE TASK, NEVER THE TARGET (maintainer, 2026-08-14). Whether the person addressed nobody
 * or addressed the wrong assistant is the same case, because targeting is a DELIVERY concern the client
 * already settled at send - it says who sees the message, not what the message is about. What it is
 * about is answerable from the task alone: the chain names its `assistantId`, and that assistant is the
 * one that can act on it.
 *
 * The transport is the handler bypass, the same seam the round-2 dispatch and the delegation to an alt
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
 * could not be handed over, and the caller tells the person the owning assistant could not be reached.
 * It must not answer in the owner's place: applying the message to the chain as
 * this assistant moves the owner's work onto it on the strength of a transient failure.
 */
/**
 * Did this turn arrive because another assistant handed it over?
 *
 * The depth bound for delegation reads this, and the attribute it reads already travels: the bypass
 * envelope carries `trigger`, and both handover producers set it. So the bound costs nothing new and
 * cannot be lost by a caller forgetting to pass a depth.
 *
 * TASK HANDOVER COUNTS TOO, deliberately. A message routed to the assistant that owns the work it
 * answers is also a turn somebody else started, and letting that one delegate onward would reopen the
 * cycle through a second door.
 */
/**
 * One message's text, read by id as a given bearer.
 *
 * Exists so a handover can carry a reference instead of the question: the receiver resolves what it was
 * asked with its own credentials, and a bearer that may not read this conversation gets nothing rather
 * than a copy somebody else decided to send it.
 *
 * Returns '' on any failure - not entitled, deleted, redacted, unreadable. The caller then behaves as it
 * does for any message it cannot see, which is the same fail direction every other read here takes.
 */
async function readMessageText(channelArn: string, messageId: string, bearerArn: string): Promise<string> {
  try {
    const res = await chimeClient.send(new GetChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: messageId,
      ChimeBearer: bearerArn,
    }));
    const raw = res.ChannelMessage?.Content || '';
    // Content is URL-encoded on the wire, exactly as the Lex transcript is, so it is decoded the same
    // way and the two entries produce the same string for the same message. Markers are NOT stripped
    // here: the flow already strips them before a message reaches a turn, and stripping twice would
    // differ from what the direct entry produces for the same text.
    return decodeURIComponent(raw).trim();
  } catch (err) {
    console.warn('[Router] could not resolve the referenced message; the turn sees no text', {
      messageId, err: (err as { name?: string })?.name ?? err,
    });
    return '';
  }
}

function arrivedByHandover(event: LexEvent): boolean {
  return event.requestAttributes?.[BYPASS_TRIGGER_ATTR] === 'handover';
}

/**
 * A RECAP FOR SOMEBODY WHO WAS JUST ADDED TO THE CONVERSATION (`lib/join-recap.ts`).
 *
 * Asked for by the share, answered here as an ordinary turn by the room's primary, privately to the new
 * member. Its message is this assistant's own copy rather than anything the person said, so it is a
 * machine-written turn in every branch that asks whether a person is answering something.
 *
 * FLOW ENTRY ONLY. The trigger rides a request attribute, and only `bypassToLexEvent` writes those; a
 * Lex event carrying it is not one this platform produced.
 */
function isJoinRecap(event: { requestAttributes?: Record<string, string> }): boolean {
  return event.requestAttributes?.[BYPASS_TRIGGER_ATTR] === 'join_recap'
    && event.requestAttributes?.[FLOW_ENTRY_ATTR] === FLOW_ENTRY_VALUE;
}

/**
 * Why a join recap is refused, or `undefined` when it may run.
 *
 * The payload arrives from another component, so it is checked against the conversation rather than
 * believed, the same way a handover is checked against its message and a notice against its
 * classification:
 *   - the speaker is the room's primary, which the router resolved itself. A payload naming a bot is
 *     refused rather than honored, because a recap is the room speaking, not a sanctioned side;
 *   - the turn is for a PERSON, and that person is a member of the conversation now, read live as this
 *     assistant. A recap is never posted to somebody outside the room.
 * Targeting is not checked here because it is not optional: the turn sets it once this passes.
 */
async function joinRecapRefusal(event: LexEvent, channelArn: string, botArn: string): Promise<string | undefined> {
  if (event.requestAttributes?.[BYPASS_BOT_ARN_ATTR]) return 'the recap named a speaker; the room\'s primary speaks';
  const memberArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
  if (!channelArn || !memberArn.includes('/user/')) return 'the recap names no conversation or no person';
  const size = await resolveChannelSize(chimeClient, channelArn, botArn);
  if (size.refused || size.unknown) return 'the conversation\'s members could not be read';
  if (!size.members.some((m) => m.arn === memberArn && !m.isBot)) return 'the person is not a member of the conversation';
  return undefined;
}

/**
 * THE ASSISTANTS SHARING THIS CONVERSATION, and what each of them advertises.
 *
 * Called BEFORE classification, because their advertised lines become categories in the one
 * classification this turn makes. That ordering is what removed a second model call.
 *
 * ── THE GATE IS A CACHED LOOKUP, AND IT IS THE WHOLE COST CONTROL ────────────────────────────────
 *
 * "Could this classification hold a roommate at all" is answered from the assistant index, which is cached per
 * container. It is false for every deployment that has not asked for a second assistant, and those
 * therefore read no roster, fetch no advertisement, and send no larger prompt. Where it is true the turn
 * pays one `ListChannelMemberships`; the advertisements themselves are cached per assistant.
 *
 * ── EVERY FAILURE RETURNS NO ROOMMATES ──────────────────────────────────────────────────────────
 *
 * An unreadable assistant index, an unreadable roster, a missing advertisement: all mean this turn classifies
 * against its own pack exactly as it would have before any of this existed. A routing improvement must
 * never cost a person their reply (tenet D5).
 *
 * ── THE ROSTER IT READ BELONGS TO THIS TURN ─────────────────────────────────────────────────────
 *
 * The membership read also answers the "who is here" section, so it is returned beside the roommates,
 * tagged with the conversation and the answering assistant it was built for. The turn hands it to its own
 * dispatch, and `rosterForDispatch` forwards it only into a dispatch for that same conversation and
 * assistant (`lib/who-is-here.ts`).
 */
async function resolveRoommatesForTurn(args: {
  channelArn: string;
  selfBotArn: string;
  classification: string;
}): Promise<{ roommates: Roommate[]; roster?: ReadRoster }> {
  const { channelArn, selfBotArn, classification } = args;
  if (!channelArn || !selfBotArn) return { roommates: [] };
  let roster: ReadRoster | undefined;
  try {
    const liveAssistants = await liveAssistantsForClassification(classification);
    if (liveAssistants.filter((s) => s.botArn !== selfBotArn).length === 0) return { roommates: [] };

    const size = await resolveChannelSize(chimeClient, channelArn, selfBotArn);
    if (size.unknown || size.refused) return { roommates: [] };
    const botArnsInRoom = size.members.filter((m) => m.isBot).map((m) => m.arn);
    roster = { channelArn, selfBotArn, roster: whoIsHereFrom(size.members, selfBotArn, []) };
    if (botArnsInRoom.filter((a) => a !== selfBotArn).length === 0) return { roommates: [], roster };

    const roommates = await roommatesInConversation({
      botArnsInRoom,
      selfBotArn,
      liveAssistants: liveAssistants.map((s) => ({ handle: s.handle, botArn: s.botArn, role: s.role })),
    });
    roster = { channelArn, selfBotArn, roster: whoIsHereFrom(size.members, selfBotArn, roommates) };
    return { roommates, roster };
  } catch (err) {
    console.warn('[Router] could not resolve this conversation\'s other assistants; classifying against '
      + 'this assistant\'s own pack only', { err: err instanceof Error ? err.message : String(err) });
    return { roommates: [], roster };
  }
}

/**
 * ACT ON WHAT THE CLASSIFICATION DECIDED: hand the turn over, ask which assistant, or keep it.
 *
 * No model call of its own. The decision was already made by the turn's single classification over the
 * merged pack, so this reads a key and acts.
 *
 * Returns a Lex response when this assistant is done - having handed over, or having asked - and null
 * when it should answer the turn itself.
 */
async function actOnDelegation(args: {
  event: LexEvent;
  channelArn: string;
  selfBotArn: string;
  roommates: Roommate[];
  classifiedIntent: string;
  /** What this assistant's lines are worded from. */
  words?: VersionWords;
}): Promise<ReturnType<typeof formatLexResponse> | null> {
  if (args.roommates.length === 0) return null;
  const decision = decideDelegation({
    classifiedIntent: args.classifiedIntent,
    roommates: args.roommates,
  });
  if (decision.kind !== 'keep') {
    console.log('[Router] delegation decision', {
      decision: decision.kind,
      classifiedIntent: args.classifiedIntent,
      ...(decision.kind === 'handover' ? { to: decision.roommate.assistant, key: decision.key } : {}),
      ...(decision.kind === 'ask' ? { candidates: decision.roommates.map((r) => r.assistant) } : {}),
    });
  }
  if (decision.kind === 'keep') return null;

  if (decision.kind === 'ask') {
    // REFUSING TO CHOOSE IS AN ANSWER, SO IT IS SAID. Naming the candidates is the whole value: the
    // person can then address one directly, which is the thing they could not do when they did not know
    // the other assistant was there.
    const names = decision.roommates.map((r) => r.advertisement.displayName);
    const and = templateLine('roommates-ambiguous', args.words, { section: 'label.and' });
    return formatLexResponse(args.event, [{
      contentType: 'PlainText',
      content: templateLine('roommates-ambiguous', args.words, { values: { names: names.join(` ${and} `) } }),
    }]);
  }

  // ── ONE HANDOVER PER MESSAGE, WHATEVER DELIVERY DOES ──────────────────────────────────────────
  //
  // Amazon Chime SDK delivery is at-least-once, so a redelivered message reaches this point again as a
  // fresh turn that has not arrived by handover - the chain bound cannot see it - and would dispatch a
  // second model turn to the same specialist for the same question. The person would get two answers and
  // the deployment would pay for both.
  //
  // CLAIMED BEFORE THE DISPATCH, because the thing being made once is the dispatch. Fails OPEN like every
  // claim here: a dedup table hiccup must not swallow a person's question.
  const inboundForDedup = inboundMessageId(args.event) || '';
  if (inboundForDedup && !(await claimCorrelation(`delegate-${inboundForDedup}`))) {
    console.log('[Router] this message has already been handed over; not dispatching a second turn', {
      inboundMessageId: inboundForDedup, to: decision.roommate.assistant,
    });
    return formatLexSilentResponse(args.event);
  }

  const handedOver = await dispatchTurnToRoommate({
    event: args.event,
    channelArn: args.channelArn,
    roommate: decision.roommate,
    selfBotArn: args.selfBotArn,
    intentKey: decision.key,
  });
  if (!handedOver) return null;

  // ── THIS ASSISTANT ANSWERS, AND ITS ANSWER IS WHERE THE QUESTION WENT ────────────────────────────
  //
  // Not silence. A person who asked one assistant and is answered by another has no way to tell a
  // handover from a bug, and the one they addressed going quiet is the part that reads as broken. So the
  // turn's response says it was passed on and NAMES who has it - and the specialist's reply follows as
  // its own message, which is the order a person can follow: acknowledgement, then answer.
  //
  // RETURNED RATHER THAN POSTED, unlike the task handover's receipt. That one is posted and targeted
  // because it answers a message that may itself have been private; this turn answers a question the
  // person asked the room, so the room is where the acknowledgement belongs - returning it keeps it on the
  // same visibility as the question.
  //
  // THE DISPLAY NAME, never the handle. `ops-premium` is an internal identifier; what a person is told to
  // expect has to match the name they will see on the reply.
  return formatLexResponse(args.event, [{
    contentType: 'PlainText',
    content: handedToRoommateAcknowledgement(decision.roommate.advertisement.displayName, args.words),
  }]);
}

/**
 * What this assistant says when it passes a question to a roommate.
 *
 * Its own copy rather than the task handover's, because the two are not the same event: that one answers
 * work already under way ("that answers work X is handling"), and this is a fresh question that belongs
 * to somebody else. Telling a person their message continued a chain that does not exist would be worse
 * than saying nothing.
 *
 * Said from the `handed-to-roommate` message template, as the handover receipt beside it is said from
 * `handover-receipt`, so both carry the assistant's wording and are reworded the same way (ADR-062).
 */
function handedToRoommateAcknowledgement(assistantDisplayName: string, words: VersionWords = {}): string {
  return templateLine('handed-to-roommate', words, { values: { name: assistantDisplayName } });
}

/**
 * Hand a person's message to a roommate by POSTING A HANDOVER MESSAGE targeted at it, carrying a
 * REFERENCE and never the question (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4).
 *
 * NOT AN INVOKE. This handler never starts another assistant's turn itself: the channel flow routes the
 * handover (post-processing if the flow could not), and the receiving turn reads it back and verifies it
 * before acting (`verifyHandover`). So an assistant reaches another only through a stored conversation
 * message, under the same bearer pinning and read rules as every other message.
 *
 * THE RECEIVER READS THE PERSON'S MESSAGE ITSELF, with its own permissions, and fails closed if it may
 * not. The boundary is the receiver's own read access rather than this assistant's judgment about what is
 * safe to repeat, and nothing is republished because nothing was copied.
 */
async function dispatchTurnToRoommate(args: {
  event: LexEvent;
  channelArn: string;
  roommate: { assistant: string; botArn: string; role: string; advertisement: { displayName: string } };
  selfBotArn: string;
  /** The receiver's own advertised key this turn was placed in. */
  intentKey: string;
}): Promise<boolean> {
  // THROUGH THE SHARED RESOLVER, because a flow-entry turn carries the id as a bypass attribute rather
  // than as `CHIME.message.id`. Without an id there is nothing to reference, so nothing is handed over.
  const inboundId = inboundMessageId(args.event);
  if (!inboundId) {
    console.warn('[Router] no inbound message id to hand over; this assistant keeps the turn', {
      to: args.roommate.assistant, intentKey: args.intentKey,
    });
    return false;
  }
  const posted = await postHandover({
    channelArn: args.channelArn,
    selfBotArn: args.selfBotArn,
    receiver: { name: args.roommate.advertisement.displayName || args.roommate.assistant, botArn: args.roommate.botArn },
    // THE KEY THE RECEIVER'S OWN TAXONOMY NAMED, so it does not re-classify an empty transcript and lose
    // its own per-intent delivery option and model route. It came out of the RECEIVER's advertisement.
    marker: {
      personMessageId: inboundId,
      personSenderArn: args.event.requestAttributes?.['CHIME.sender.arn'] || '',
      personWasPrivate: args.event.requestAttributes?.[BYPASS_TARGETED_ATTR] === '1',
      kind: 'capability',
      intent: args.intentKey,
    },
  });
  if (posted) {
    console.log('[Router] handed the turn to a roommate', {
      to: args.roommate.assistant, role: args.roommate.role, inboundId, intentKey: args.intentKey,
    });
  }
  return posted;
}

/**
 * Post a handover message: targeted at the receiver, led by its address token, marked in `Metadata`.
 * Returns whether it was posted. See `lib/assistant-handover.ts` for the bounds it carries.
 */
async function postHandover(args: {
  channelArn: string;
  selfBotArn: string;
  receiver: { name: string; botArn: string };
  marker: HandoverMarker;
  /** The person's words, on a task handover only (`handoverContent`). */
  personText?: string;
}): Promise<boolean> {
  try {
    // ONE MESSAGE BY CONSTRUCTION: the receiving assistant takes this instruction as its turn's one message, so it is
    // never split into parts that would each start a turn.
    await sendChannelMessage(chimeClient, {
      ChannelArn: args.channelArn,
      Content: encodeURIComponent(handoverContent(args.receiver, args.personText ? capUserMessage(args.personText) : undefined)),
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: args.selfBotArn,
      // READABLE BY THE SENDER AND THE RECEIVER ONLY. The room is told where the question went by the
      // acknowledgment; this message is the instruction, and nobody else needs to see it.
      Target: [{ MemberArn: args.receiver.botArn }],
      Metadata: handoverMetadata(args.marker),
    });
    return true;
  } catch (err) {
    console.error('[Router] could not post the handover; answering here instead', {
      to: args.receiver.botArn.split('/').pop(), kind: args.marker.kind,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * THE AUTHORITY FOR A HANDED-OVER TURN IS THE HANDOVER MESSAGE, READ BACK, NOT THE PAYLOAD.
 *
 * Read as THIS turn's bearer, which Amazon Chime SDK permits only to the message's sender and its
 * `Target`. Accepted only when all hold:
 *  - it is a handover (`parseHandover`), and its `personMessageId` is the message this turn answers;
 *  - its sender is an assistant this classification sanctions, and not this assistant;
 *  - it is targeted at this assistant.
 * A read moments after the post can miss, so it is retried once, as the private-address check is.
 *
 * Returns the verified marker and the sender's assistant id, or null. A null ends the turn quietly: there is
 * no person waiting on a handover that does not exist, and a forged one deserves no reply.
 */
async function verifyHandover(args: {
  channelArn: string;
  handoverMessageId: string;
  personMessageId: string;
  selfBotArn: string;
  classificationBotArn: string;
}): Promise<{ marker: HandoverMarker; fromAssistantId: string; content: string } | null> {
  let message: { Content?: string; Metadata?: string; Sender?: { Arn?: string }; Target?: Array<{ MemberArn?: string }> } | undefined;
  for (let attempt = 1; attempt <= 2 && !message; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await chimeClient.send(new GetChannelMessageCommand({
        ChannelArn: args.channelArn,
        MessageId: args.handoverMessageId,
        ChimeBearer: args.selfBotArn,
      }));
      message = res.ChannelMessage;
    } catch (err) {
      if (attempt === 2) {
        console.warn('[Router] the handover this turn names is not readable to it', {
          handoverMessageId: args.handoverMessageId, err: (err as { name?: string })?.name ?? err,
        });
      }
    }
  }
  if (!message) return null;
  const marker = parseHandover(message.Metadata);
  const senderArn = message.Sender?.Arn || '';
  const targeted = (message.Target || []).some((t) => t.MemberArn === args.selfBotArn);
  const reject = (reason: string) => {
    console.error('[Router][SecurityEvent] a handed-over turn named a message that is not a valid handover to it; refusing', {
      reason, handoverMessageId: args.handoverMessageId, sender: senderArn.split('/').pop(),
    });
    return null;
  };
  if (!marker) return reject('not-a-handover');
  if (marker.personMessageId !== args.personMessageId) return reject('references-another-message');
  if (!isAssistantArn(senderArn) || senderArn === args.selfBotArn) return reject('sender-not-another-assistant');
  if (!targeted) return reject('not-targeted-at-this-assistant');
  if (!(await isSanctionedBattleBot(senderArn, args.classificationBotArn, STATIC_CLASSIFICATION, ASSISTANT_ROLE))) {
    return reject('sender-not-sanctioned-in-this-classification');
  }
  let content = '';
  try { content = decodeURIComponent(message.Content || ''); } catch { content = message.Content || ''; }
  return { marker, fromAssistantId: principalIdFromArn(senderArn), content };
}

async function handOverToOwningAssistant(args: {
  task: UserTask;
  event: LexEvent;
  channelArn: string;
  senderArn: string;
  selfBotArn: string;
  classificationBotArn: string;
  /** Who this turn is, for the receipt below. See `SpokenAs.attribution`. */
  attribution?: BotMessageAttribution;
  /** What this assistant's receipt is worded from. */
  words?: VersionWords;
}): Promise<boolean> {
  const { task, event, channelArn, senderArn, selfBotArn, classificationBotArn, attribution } = args;
  const owningAssistantId = task.assistantId;
  const selfAssistantId = principalIdFromArn(selfBotArn);
  if (!owningAssistantId || owningAssistantId === selfAssistantId) return false;

  // The owning bot lives in the SAME app instance as this one, so its ARN is this bot's with the
  // principal swapped. Derived rather than stored: a second copy of an ARN is a second thing that can
  // disagree with the wiring it describes, and the sanction check below is what makes deriving it safe.
  const owningBotArn = `${selfBotArn.substring(0, selfBotArn.lastIndexOf('/') + 1)}${owningAssistantId}`;
  if (!(await isSanctionedBattleBot(owningBotArn, classificationBotArn, STATIC_CLASSIFICATION, ASSISTANT_ROLE))) {
    console.error('[Router][SecurityEvent] a task names an assistant this classification does not sanction; not handing over', {
      taskId: task.taskId, owningAssistantId, classification: STATIC_CLASSIFICATION,
    });
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

  // A HANDOVER MESSAGE, NOT AN INVOKE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4). The person's
  // words ride it because their answer may have been addressed privately to THIS assistant, which the
  // owner cannot read; the handover is readable only by this assistant and the owner, so the words reach
  // exactly the assistant the payload used to carry them to.
  if (!inboundId) return false;
  const posted = await postHandover({
    channelArn,
    selfBotArn,
    receiver: { name: await owningAssistantDisplayName(owningBotArn), botArn: owningBotArn },
    marker: {
      personMessageId: inboundId,
      personSenderArn: senderArn,
      personWasPrivate: event.requestAttributes?.[BYPASS_TARGETED_ATTR] === '1',
      kind: 'task',
      taskId: task.taskId,
    },
    personText: event.inputTranscript ? decodeURIComponent(event.inputTranscript) : '',
  });
  if (!posted) {
    // NOTHING WAS SAID AND NOTHING WAS MARKED, which is what makes the caller's notice honest: no
    // receipt contradicts it, and a redelivery or a resend is free to attempt the handover again.
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
      await sendInParts(chimeClient, {
        ChannelArn: channelArn,
        text: handoverAcknowledgement(await owningAssistantDisplayName(owningBotArn), args.words),
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: selfBotArn,
        Target: [{ MemberArn: senderArn }],
        // THE HANDING-OVER ASSISTANT'S OWN ATTRIBUTION, not the receiving one's: this receipt is said
        // by the assistant that is standing down, and the turn that follows is attributed separately
        // by the assistant that runs it.
        Metadata: botMessageMetadata(attribution),
      });
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
 * The turn already decides what the acknowledgment SAYS - `quickReply` / `getTaskPlaceholder`,
 * resolved from the profile version this turn loaded. Before this, the words were authored here and
 * the ACT was performed elsewhere: by Amazon Chime SDK on the Lex path, by the channel flow on a
 * bypass. One profile-resolved behavior, two routes to the channel, which is the divergence class
 * the `@all` and round-1 handoffs exist to remove.
 *
 * So on a flow entry the turn posts whatever it produced - placeholder, canned greeting, gate notice
 * or error - and returns an EMPTY `messages` array, which every bypass caller already understands as
 * "post nothing" (ADR-022). The Lex path is untouched: Chime still materializes that message from the
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
/**
 * A DUEL'S REBUTTAL ROUND, handed over by the battle orchestrator (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION,
 * Phase 1c). The orchestrator serves every classification and speaks as no assistant (step 36): the round's
 * placeholder is posted here, as the side, and the round's turn record - the one the processor's session is
 * vended from - is recorded here, by the classification's own router, and the processor is dispatched with
 * the orchestrator's payload unchanged. Nothing about the round is decided here: round 2 inherits round 1's
 * intent and opens no work (`a-rebuttal-opens-no-work`), so this entry validates against the duel's state,
 * posts the placeholder, records, and does not run a turn.
 */
/**
 * SAY A NOTICE THE CHANNEL FLOW HANDED OVER, AS THE ASSISTANT IT NAMES, IN THAT ASSISTANT'S WORDS.
 *
 * The flow decides a notice is due and names its kind; it composes no words (`lib/assistant-notice.ts`).
 * This resolves the assistant the same way a turn does - the assistant of the bot, from the assignment
 * records - reads that assistant's active copy, and posts the line on that assistant's own session,
 * targeted at whoever the flow named, with the assistant's attribution and the notice's `turnKind`.
 *
 * Every field is checked before anything is said, because the payload arrives from another component:
 * the kind must be one this platform says, the conversation must carry this router's classification, and
 * the bot must be one of its assistants (`isSanctionedBattleBot`). A bot whose assistant cannot be named is
 * declined like a turn would be, with no reply on another assistant's words (tenet P4, ADR-046).
 */
/**
 * The template a notice is said from, by the selection order: the one the version's `messages` names, the
 * assistant's own in the store, the classification's, the deployment's `budgetCannedResponse` for a spend refusal, then the
 * shipped template. Every store fault answers the next family, so a notice is always said.
 */
/**
 * WHAT THIS ASSISTANT'S LINES ARE WORDED FROM (ADR-062): its active version's `messages`, and the
 * templates its family and this classification hold (`loadMessageTemplateSet`, read once per TTL). A line is then
 * said with `templateLine` in the selection order. A version that cannot be read words its lines from the store
 * and the shipped templates.
 */
async function wordsOf(profileName: string): Promise<{ copy: AssistantCopy; templates: MessageTemplateSet }> {
  const version = await resolveActiveProfile(profileName, { ssm: ssmClient, ssmRoot: SSM_ROOT }).catch(() => undefined);
  const templates = await loadMessageTemplateSet({ classification: STATIC_CLASSIFICATION, assistant: profileName, messages: version?.messages });
  return { copy: withMessageTemplates<AssistantCopy>(templates), templates };
}

/**
 * DISPATCH A PROMPT WELCOME'S ONE MODEL TURN (SPEC-WELCOME-AND-CONTEXT FR24, ADR-061 decision 9), after the opening.
 *
 * The joining assistant's own turn on its own vended session: dispatched through `invokeAsync`, which records the
 * turn routing the processor's session is vended from, as the join recap's router turn and the drift-spawned welcome
 * are. It takes no turn lock, because no person is waiting on it and nothing is queued behind it. It is metered
 * `machineWritten` against the global budget only, and a refused meter dispatches nothing. The correlation is the
 * conversation and the assistant, so a redelivered `WelcomeIntent` collapses on the processor's own claim and the
 * room is greeted once. Who is here is read once, as display names; every value reaches the model as data.
 */
async function dispatchWelcomePrompt(args: { channelArn: string; botArn: string; request: WelcomePromptRequest }): Promise<void> {
  const { channelArn } = args;
  try {
    const outcome = await dispatchWelcomePromptTurn({ ...args, classification: STATIC_CLASSIFICATION }, {
      processorArn: () => resolveAsyncProcessorArn(STATIC_CLASSIFICATION),
      invoke: (processorArn, payload) => invokeAsync(processorArn, payload),
    });
    console.log('[Router][WelcomeIntent] prompt welcome', { outcome, channelArn, template: args.request.template });
  } catch (err) {
    console.warn('[Router][WelcomeIntent] the prompt welcome could not be dispatched; the opening stands', {
      channelArn, err: (err as Error)?.name, message: (err as Error)?.message,
    });
  }
}

/**
 * THE ASSISTANT A RUN IS THE WORKFLOW OF, and what its welcome says. `welcome` is set only where `WelcomeIntent` runs the
 * welcome: the opening it composed for this room, said by the welcome's `opening` step, and the values its `prompt` step
 * hands the model turn.
 */
interface WorkflowRunner {
  botArn: string;
  assistant: string;
  variantProfile?: import('./lib/active-profile.js').ProfileDefinition;
  variables?: Readonly<Record<string, VersionVariable>>;
  welcome?: { opening: string; promptValues: Record<string, string> };
}

/**
 * RUN AN EVENT WORKFLOW AS ONE ASSISTANT (ADR-061 decision 5): its platform sends posted by this router, its agent
 * step handed to the processor. The run and each step are claimed through the task service, keyed
 * `<event>#<natural key>#<assistant>` (`eventNaturalKey`: the conversation, at `person-joined` the person too, and at
 * `invitation-sent` the invitation), so a redelivered event starts nothing twice.
 */
async function runWorkflowFor(
  name: string,
  wf: EventWorkflow,
  ctx: EventRunContext,
  who: WorkflowRunner,
  held: RouterGateHeld = {},
): Promise<{ ran: boolean }> {
  const naturalKey = eventNaturalKey(ctx.event, ctx.channelArn, ctx.eventPerson, ctx.invitationId, ctx.alarm);
  if (!naturalKey) return { ran: false };
  const runKey = eventRunKey(ctx.event, naturalKey, who.assistant);
  const roles = await participantRolesForRun(name, wf, ctx, who, held);
  const withRoles: EventRunContext = roles.roles ? { ...ctx, roles: roles.roles, roleSaidInRoom: roles.saidInRoom, ...(roles.deciding ? { decidingRoles: roles.deciding } : {}), ...(roles.conversationType ? { conversationType: roles.conversationType } : {}) } : ctx;
  const heldNow: RouterGateHeld = { ...held, ...(roles.members ? { members: roles.members } : {}), ...(roles.conversationType ? { conversationType: roles.conversationType } : {}) };
  const gated: EventRunContext = { ...withRoles, gate: await routerGate(wf, withRoles, who.variables, heldNow) };
  const result = await runEventWorkflow(name, wf, gated, eventRunDeps(name, gated, who, runKey, heldNow.members, held.invitationReason, held.invitationRole, held.invitationPrompt));
  return { ran: result.ran };
}

/**
 * WHO HOLDS EACH PARTICIPANT ROLE THE WORKFLOW NAMES (DESIGN-CONVERSATION-TYPES section 6.1), read only when it names one
 * in an audience, a mention or a condition. The holdings are the channel-context row's, never channel Metadata, and
 * a holder counts only while a member: at `assistant-joined` a person in the participant shape's `humans` (live
 * membership has not converged), at every other event the live roster, read as the room's assistant. A role the
 * conversation's type does not declare resolves to nobody, and is logged by name.
 */
async function participantRolesForRun(
  name: string, wf: EventWorkflow, ctx: EventRunContext,
  who: { botArn: string; variables?: Readonly<Record<string, VersionVariable>> },
  held: RouterGateHeld,
): Promise<{ roles?: Record<string, string[]>; deciding?: Record<string, string[]>; saidInRoom?: (role: string) => boolean; members?: RouterGateHeld['members']; conversationType?: string }> {
  const refs = participantRoleReferences(wf, who.variables);
  if (!refs.roles.size && !refs.readsParticipantRole && !refs.fromRole) return {};
  const row = await getChannelContext(ctx.channelArn, { consistent: ctx.event === 'assistant-joined' || ctx.event === 'conversation-opened' }).catch(() => null);
  const conversationType = held.conversationType ?? row?.conversationType;
  let members = held.members;
  let memberArns: string[];
  if (ctx.event === 'assistant-joined') {
    const app = appInstanceArnOf(ctx.channelArn) || '';
    memberArns = (held.participants?.humans ?? []).map((id) => userArnFor(app, id));
  } else {
    if (!members) {
      const size = await resolveChannelSize(chimeClient, ctx.channelArn, who.botArn).catch(() => null);
      if (size && !size.refused && !size.unknown) members = (size.members ?? []).map((m) => ({ arn: m.arn, name: m.name, isBot: m.isBot }));
    }
    memberArns = (members ?? []).filter((m) => !m.isBot).map((m) => m.arn);
  }
  const stored = holdersByRole(row?.participantRoles, conversationType, memberArns);
  // A CREATING APPLICATION'S ASSERTION (the `host` source), read over the row's `memberIdentities` for the members only, and
  // kept out of what a condition reads: it addresses and is mentioned, and never decides.
  const host = hostSourcedRoles(conversationType).length
    ? await hostRoleHoldings(row?.memberIdentities, conversationType, memberArns, hostPerson).catch(() => ({}))
    : {};
  const roles = Object.keys(host).length ? withHostHoldings(stored, host, conversationType) : stored;
  const undeclared = [...refs.roles].filter((r) => !participantRoleOf(conversationType, r));
  if (undeclared.length) {
    console.warn('[Router][event-workflow] the workflow names participant roles this conversation\'s type does not declare; they address nobody', {
      workflow: name, roles: undeclared, conversationType, channelArn: ctx.channelArn,
    });
  }
  const outside = profiles.outsideClassificationValues();
  return {
    roles,
    ...(roles !== stored ? { deciding: stored } : {}),
    saidInRoom: (role: string) => roleSaidInRoom(conversationType, role, { outside }),
    ...(members ? { members } : {}),
    ...(conversationType ? { conversationType } : {}),
  };
}

/** The role a creating application asserted for one member (`memberIdentities[].role`), or undefined. */
async function hostRoleOf(channelArn: string, personArn: string): Promise<string | undefined> {
  const row = await getChannelContext(channelArn).catch(() => null);
  const id = personIdFromArn(personArn);
  for (const e of (row?.memberIdentities ?? []).slice(0, 200)) {
    if (!e?.role || typeof e.sub !== 'string') continue;
    const pid = e.iss ? personIdFromArn((await hostPerson(e.iss, e.sub).catch(() => null)) ?? undefined) : e.sub;
    if (pid && pid === id) return e.role;
  }
  return undefined;
}

/** A member a creating application named by its issuer's subject, as a person (through Identities, as at sign-in). */
async function hostPerson(iss: string, sub: string): Promise<string | null> {
  const issuer = issuerIdOf(iss);
  return issuer ? resolvePerson(issuer, sub) : null;
}

/**
 * What the router already holds when a run starts: the conversation's type, at the join the participant shape, and at
 * `person-joined` the live roster it verified the person against, which the run's mentions then read.
 */
interface RouterGateHeld {
  conversationType?: string;
  participants?: ParticipantContext;
  members?: ReadonlyArray<{ arn: string; name: string; isBot?: boolean }>;
  /** At `invitation-sent`, the reason the verified invitation records. */
  invitationReason?: string;
  /** At `invitation-sent`, the participant role the verified invitation records, if any. */
  invitationRole?: string;
  /**
   * At an invitation's events, what a narrowed agent step's prompt reads as data (decision 8, rule 6): the names the
   * record carries, the conversation's title and the reason, and the invitation's expiry, which a proposal never outlives.
   * Handed to the processor with the step only, never rendered into a send by the router.
   */
  invitationPrompt?: { values: Record<string, string>; expiresAt: number };
}

/**
 * THE VALUES AN EVENT ITSELF CARRIES, by source, as the router verified them: the person it names and, at
 * `invitation-sent`, the invitation's people and reason from its record. A send's fields and a run's conditions read
 * them through the resolver, which says each only where its trust and its readers allow.
 */
function eventSourceValues(ctx: EventRunContext, invitationReason?: string, invitationRole?: string): Record<string, VariableValue> {
  const invitation = isInvitationEvent(ctx.event);
  return {
    ...(invitation ? { 'invitation:role': invitationRole ?? '' } : {}),
    ...(ctx.eventPerson ? { 'event:person': [ctx.eventPerson] } : {}),
    ...(invitation && ctx.eventPerson ? { 'invitation:invitee': [ctx.eventPerson] } : {}),
    ...(invitation && ctx.inviter ? { 'invitation:inviter': [ctx.inviter] } : {}),
    ...(invitation && invitationReason ? { 'invitation:reason': invitationReason } : {}),
    // THE ALARM AND THE STATE IT ENTERED, as the router read them back from CloudWatch (the incident watch).
    ...(ctx.alarm ? { 'event:alarmName': ctx.alarm.name, 'event:alarmState': ctx.alarm.state } : {}),
  };
}

/**
 * WHAT A RUN'S CONDITIONS READ AT THIS ROUTER (ADR-060 decisions 4 and 6): the values the router holds (the
 * classification, the conversation's type, the person the event names) and, only when a condition names it, a value
 * the router reads under the grants it already holds: the subject's onboarded flag (the user-profile read the intake
 * gate makes) and the subject's clearance as the set its holder token grants (`clearanceSet`). Both describe the
 * subject, so they are read only where the participant shape names one subject (`welcomeCallSite`). The router reads
 * no context-source catalog, so a `ctx:` condition is unresolved here and does not hold.
 */
async function routerGate(
  wf: EventWorkflow,
  ctx: EventRunContext,
  variables: Readonly<Record<string, VersionVariable>> | undefined,
  held: RouterGateHeld,
): Promise<EventGate> {
  const named = conditionSources(wf, variables);
  let conversationType = held.conversationType;
  if (!conversationType && named.has('conversation:type')) {
    conversationType = (await getChannelContext(ctx.channelArn).catch(() => null))?.conversationType;
  }
  const resolver = routerVariables(variables, { conversationType });
  const values: Record<string, VariableValue | undefined> = {
    ...resolver.values,
    ...eventSourceValues(ctx, held.invitationReason, held.invitationRole),
    ...participantRoleValues(ctx, held.invitationRole),
  };
  // THE ONE PERSON WHOSE FACTS A CONDITION READS: the participant shape's subject at `assistant-joined`, and the person
  // the event names at `person-joined` (verified a member) and `invitation-sent` (the invitee its record names), each
  // read under the grants the join already uses. Validation lets such a condition select only a step addressed to that
  // person (`eventWorkflowErrors`).
  const eventSettlesPerson = (ctx.event === 'person-joined' || isInvitationEvent(ctx.event)) && !!ctx.eventPerson;
  const callSite = ctx.event === 'assistant-joined'
    ? welcomeCallSite(held.participants)
    : { identitySettled: false, conversationSettled: true, subjectSettled: eventSettlesPerson };
  const personArn = ctx.event === 'assistant-joined' ? (callSite.subjectSettled ? ctx.subject : undefined) : (eventSettlesPerson ? ctx.eventPerson : undefined);
  const personId = ctx.event === 'assistant-joined' ? (callSite.subjectSettled ? held.participants?.subject : undefined) : personIdFromArn(personArn) ?? undefined;
  if (personId && named.has('person:onboarded')) {
    const status = await onboardingStatus(personId).catch(() => null);
    if (status) values['person:onboarded'] = status.onboarded;
  }
  if (personArn && named.has('person:clearance')) {
    const resolved = await resolveUserClearance(personArn).catch(() => undefined);
    values['person:clearance'] = clearanceSet(resolved?.clearance, (t) => profiles.grantsFor(t));
  }
  return { lookup: resolver.lookup, ...(variables ? { variables } : {}), values, callSite };
}

/**
 * THE PARTICIPANT-ROLE VALUES A RUN'S CONDITIONS READ: `participantRole:<name>`, each role's holders who are members,
 * and `participant:role`, the roles the person the event names holds. At `invitation-sent` the invitee is not reading
 * the room yet, so their roles are the one the invitation records; at `assistant-joined` the person is the participant
 * shape's subject. Without holdings read, none is held, and a condition on one does not hold.
 */
function participantRoleValues(ctx: EventRunContext, invitationRole?: string): Record<string, VariableValue> {
  if (isInvitationEvent(ctx.event)) return { 'participant:role': invitationRole ? [invitationRole] : [] };
  // A HOST'S ASSERTION NEVER DECIDES (ADR-060 decision 2): a condition reads the holdings less the `host` source's.
  const held = ctx.decidingRoles ?? ctx.roles;
  if (!held) return {};
  const person = ctx.event === 'assistant-joined' ? ctx.subject : ctx.eventPerson;
  return {
    ...Object.fromEntries(Object.entries(held).map(([role, arns]) => [`participantRole:${role}`, [...arns]])),
    ...(person ? { 'participant:role': rolesOfPerson(held, person) } : {}),
  };
}

/** The most holders of one role an agent step's dispatch carries. */
const MAX_DISPATCHED_HOLDERS = 50;

/**
 * THE HOLDINGS AN AGENT STEP NEEDS (ADR-061 decision 8): the roles its audience, its fallback's audience and mentions
 * name, and every role that confers a brief or a template, so the processor's turn addresses and names exactly whom the
 * router would. Ids only, at most `MAX_DISPATCHED_HOLDERS` per role.
 */
function stepRoles(def: AgentStep, ctx: EventRunContext): Record<string, string[]> {
  const named = new Set<string>();
  for (const to of [def.to, def.fallback.send.to]) { const r = audienceRole(to); if (r) named.add(r); }
  for (const source of Object.values(def.fallback.send.mention ?? {})) { const r = mentionedRole(source); if (r) named.add(r); }
  for (const [role, decl] of Object.entries(participantRolesOf(ctx.conversationType))) if (decl.confers?.brief || decl.confers?.template) named.add(role);
  return Object.fromEntries([...named].filter((r) => ctx.roles?.[r]).map((r) => [r, ctx.roles![r].slice(0, MAX_DISPATCHED_HOLDERS)]));
}

/** What a run of this router needs: its claims, mentions, sends and the hand-off to the processor. */
export function eventRunDeps(
  name: string, ctx: EventRunContext,
  who: WorkflowRunner,
  runKey: string,
  roster?: ReadonlyArray<{ arn: string; name: string; isBot?: boolean }>,
  invitationReason?: string,
  invitationRole?: string,
  invitationPrompt?: RouterGateHeld['invitationPrompt'],
): EventRunDeps {
  const eventValues = eventSourceValues(ctx, invitationReason, invitationRole);
  const members = new Map<string, string>();
  // READ ON FIRST USE, AND AWAITED BY ITS USER: a run that mentions nobody reads no roster, and no read outlives the
  // invocation that started it.
  let membersRead: Promise<void> | undefined;
  const readMembers = (): Promise<void> => (membersRead ??= (roster ? Promise.resolve({ members: [...roster] }) : resolveChannelSize(chimeClient, ctx.channelArn, who.botArn))
    .then((r) => { for (const m of r.members ?? []) if (!m.isBot) members.set(m.arn, m.name); })
    .catch(() => undefined));
  return {
    claimRun: () => claimEventRun({ runKey, channelArn: ctx.channelArn, workflow: name }),
    claimStep: (step, outcome) => claimEventStep({ runKey, channelArn: ctx.channelArn, step, outcome }),
    // ONLY A MEMBER IS MENTIONED (decision 6): at `assistant-joined` the participant shape's subject counts, because
    // live membership has not converged; at any other event the live roster decides, and a non-member renders empty.
    mentionName: async (personArn) => {
      if (ctx.event === 'assistant-joined') return resolveUserName(personArn).then((n) => (n === 'there' ? '' : n));
      await readMembers();
      return members.get(personArn) ?? '';
    },
    send: (args) => sayWorkflowSend({ ...args, runKey, channelArn: ctx.channelArn, botArn: who.botArn, assistant: who.assistant, workflow: name, event: ctx.event, variables: who.variables, eventValues }),
    // A ROLE'S LIST OF NAMES IN ITS READERS' LANGUAGE (ADR-062 decision 4): the order a send's template is chosen in.
    listLanguage: async (to) => {
      const langs = await sendLanguages(ctx.channelArn, [...to]);
      return (to.length === 1 ? langs.preferred : undefined) ?? langs.conversation;
    },
    dispatchAgent: async (step, _def: AgentStep, values, transitions) => {
      // THE STEP'S ASSISTANT (`as`): the room's assistant holding the step's role takes this one turn as itself, on its
      // own session, so a primary never reads what only that role is granted. None in the room: nothing is dispatched.
      const taker = _def.as ? await stepTaker(_def, ctx.channelArn, who.botArn) : { botArn: who.botArn };
      if (!taker) {
        console.log('[Router][event-workflow] no assistant holding the step\'s role is in the room; its absent message is said', { step, role: _def.as?.role, channelArn: ctx.channelArn });
        return 'absent' as const;
      }
      return dispatchEventAgentStep({
      runKey, workflow: name, step, event: ctx.event, channelArn: ctx.channelArn, botArn: taker.botArn,
      // A STEP ANOTHER ASSISTANT TAKES names the run's assistant, whose version declares the step, and hands back to it.
      ...(taker.assistant ? { workflowOwner: who.assistant, ownerBotArn: who.botArn } : {}),
      ...(ctx.alarm ? { alarm: ctx.alarm } : {}),
      ...(ctx.eventPerson ? { eventPerson: ctx.eventPerson } : {}), ...(ctx.subject ? { subject: ctx.subject } : {}), values, transitions,
      ...(ctx.invitationId ? { invitationId: ctx.invitationId } : {}), ...(ctx.inviter ? { inviter: ctx.inviter } : {}),
      ...(ctx.roles ? { roles: stepRoles(_def, ctx) } : {}), ...(ctx.conversationType ? { conversationType: ctx.conversationType } : {}),
      // The arm's version is the run's assistant's; a step another assistant takes runs on that assistant's own.
      ...(who.variantProfile && !taker.assistant ? { variantProfile: who.variantProfile } : {}),
      // A NARROWED STEP'S DATA (decision 8, rule 6), for an agent step at an invitation's event only.
      ...(invitationPrompt ? { promptValues: invitationPrompt.values, proposalNotAfter: invitationPrompt.expiresAt } : {}),
      });
    },
    greeted: (personArn) => recordEventGreeting({ channelArn: ctx.channelArn, personArn }),
    openTask: (step, def, transitions) => openWorkflowTaskStep({ name, step, def, ctx, who, runKey, transitions, eventValues }),
    startIntake: (personArn, step, transitions) => offerIntakeStep({
      channelArn: ctx.channelArn, botArn: who.botArn, assistant: who.assistant, personArn, workflow: name, step, event: ctx.event, runKey, transitions,
    }),
    // THE WELCOME'S OWN STEPS (W1), only where `WelcomeIntent` runs it: the opening it composed, and the prompt turn.
    ...(who.welcome ? {
      opening: (step: string, _def: WelcomeOpeningStep, transitions: EventTransition[]) => postWelcomeOpening({
        channelArn: ctx.channelArn, botArn: who.botArn, assistant: who.assistant, content: who.welcome!.opening, workflow: name, step, event: ctx.event, runKey, transitions,
      }),
      prompt: async (_step: string, def: PromptWelcomeStep) => {
        await dispatchWelcomePrompt({ channelArn: ctx.channelArn, botArn: who.botArn, request: { template: def.template, tools: def.tools ?? [], values: who.welcome!.promptValues } });
        return true;
      },
    } : {}),
    log: (entry) => console.log('[Router][event-workflow]', JSON.stringify({ ...entry, channelArn: ctx.channelArn })),
  };
}

/**
 * THE INTAKE AS A STEP (ADR-061 decision 2, `start_intake`): the onboarding intake this assistant declares, offered to one
 * person with no model call. Read as the join reads it (`intakeForAssistant`, every field the deployment already asserts
 * dropped, then the person's stored profile, `onboardingStatus`); a person already onboarded, or with nothing left to
 * ask, is offered nothing. The intake is recorded on the channel-context row as theirs before its first question is
 * asked, and only where no other person's is in progress (`startOnboardingIntake`), because only the recorded subject's
 * messages answer it. The question is targeted at them alone; their answers are read on their next turns, as an intake
 * the join started is.
 */
async function offerIntakeStep(args: {
  channelArn: string; botArn: string; assistant: string; personArn: string; workflow: string; step: string;
  event: WorkflowEvent; runKey: string; transitions: EventTransition[];
}): Promise<'started' | 'skipped' | 'failed'> {
  try {
    const personId = personIdFromArn(args.personArn);
    if (!personId) return 'skipped';
    const loaded = await intakeForAssistant(args.assistant, STATIC_CLASSIFICATION);
    const facts: KnownFacts = {
      hasPersona: loaded?.fields.some((f) => f.assertedBy?.includes('persona'))
        ? await resolveActiveProfile(args.assistant, { ssm: ssmClient, ssmRoot: SSM_ROOT }).then((a) => Boolean(a?.persona?.trim())).catch(() => false)
        : false,
      classification: STATIC_CLASSIFICATION,
    };
    const config = intakeAfterChecking(loaded, facts);
    if (!isOnboardingEnabled(config)) return 'skipped';
    const gate = await onboardingStatus(personId).catch(() => null);
    if (!gate || gate.onboarded) return 'skipped';
    const toAsk = intakeAfterChecking(config, { ...facts, profileFacts: gate.facts, profilePreferences: gate.preferences });
    if (!toAsk) return 'skipped';
    const started = startIntake({ ...toAsk, words: await wordsOf(args.assistant) }, '');
    const recorded = await startOnboardingIntake(args.channelArn, { ...started.state, subject: personId });
    if (recorded === 'busy') {
      console.log('[Router][event-workflow] another person\'s intake is in progress here; this one is offered in their next conversation', { step: args.step });
      return 'skipped';
    }
    if (recorded !== 'started') return 'failed';
    const content = started.reply.trim();
    if (!content) return 'failed';
    await speakAsRoutedAssistant(
      { routeId: `${SPEAK_ROUTE_PREFIX}event-${randomUUID()}`, botArn: args.botArn, classification: STATIC_CLASSIFICATION, tableName: TURN_ROUTING_TABLE, channelArn: args.channelArn },
      { ddb: routingDdb },
    );
    await sendInParts(chimeClient, {
      ChannelArn: args.channelArn,
      text: content,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: args.botArn,
      Metadata: JSON.stringify({
        ...JSON.parse(botMessageMetadata({ agentType: args.assistant, classification: STATIC_CLASSIFICATION, turnKind: 'notification' }, { targetedSender: args.personArn })),
        eventStep: { workflow: args.workflow, step: args.step, event: args.event, outcome: 'posted' },
        eventRun: { runKey: args.runKey, transitions: args.transitions },
      }),
      Target: [{ MemberArn: args.personArn }],
    });
    return 'started';
  } catch (err) {
    console.warn('[Router][event-workflow] the intake could not be offered', { step: args.step, errName: (err as Error)?.name });
    return 'failed';
  }
}

/**
 * THE WELCOME'S OPENING, SAID BY A RUN (W1): the opening `WelcomeIntent` composed for this room, posted to the room as the
 * assistant, with no model call, where its welcome greets and then continues. Declared a welcome (`turnKind`), so the
 * ledger counts it as the room's opening rather than as an answer, and carrying the run's step and transitions as every
 * message a run posts does.
 */
async function postWelcomeOpening(args: {
  channelArn: string; botArn: string; assistant: string; content: string; workflow: string; step: string;
  event: WorkflowEvent; runKey: string; transitions: EventTransition[];
}): Promise<boolean> {
  try {
    const content = args.content.trim();
    if (!content) return false;
    await speakAsRoutedAssistant(
      { routeId: `${SPEAK_ROUTE_PREFIX}event-${randomUUID()}`, botArn: args.botArn, classification: STATIC_CLASSIFICATION, tableName: TURN_ROUTING_TABLE, channelArn: args.channelArn },
      { ddb: routingDdb },
    );
    await sendInParts(chimeClient, {
      ChannelArn: args.channelArn,
      text: content,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: args.botArn,
      Metadata: botMessageMetadata({ agentType: args.assistant, classification: STATIC_CLASSIFICATION }, {
        turnKind: 'welcome',
        eventStep: { workflow: args.workflow, step: args.step, event: args.event, outcome: 'posted' },
        eventRun: { runKey: args.runKey, transitions: args.transitions },
      }),
    });
    return true;
  } catch (err) {
    console.warn('[Router][event-workflow] the opening of the welcome could not be posted', { step: args.step, errName: (err as Error)?.name });
    return false;
  }
}

/**
 * A TASK STEP OPENS ITS TASK (ADR-063 decisions 1 and 2). The references resolve as the run's audiences do: `for` and a
 * person `by` to exactly one member, an assistant role to the room's live assistant of this classification holding it
 * (`stepTaker`, as an agent step's `as`). Nobody to resolve is `no-worker`, and nothing is written. The task service
 * writes the task, and refuses an assistant outside this classification. Where its first holder is a person, they are
 * told privately in the run assistant's `workflow-task-assigned` template, with the card when the state offers
 * choices, and emailed as a `task` notice; an assistant holder is named ready by the task service itself.
 */
async function openWorkflowTaskStep(args: {
  name: string; step: string; def: TaskStep; ctx: EventRunContext; who: WorkflowRunner; runKey: string;
  transitions: EventTransition[]; eventValues?: Readonly<Record<string, VariableValue>>;
}): Promise<'opened' | 'no-worker' | 'failed'> {
  const { def, ctx, who } = args;
  const one = (ref: unknown): string | undefined => {
    const a = audienceOf(ref as EventAudience, ctx);
    return a !== 'room' && a.length === 1 ? a[0] : undefined;
  };
  try {
    const requesterArn = def.for !== undefined ? one(def.for) : undefined;
    if (def.for !== undefined && !requesterArn) return 'no-worker';
    const role = workerAssistantRole(def.by);
    let worker: TaskAssignee;
    let workerArn: string | undefined;
    if (def.by === undefined) worker = { id: principalIdFromArn(who.botArn), type: 'assistant' };
    else if (role) {
      const taker = await stepTaker({ as: { role } } as AgentStep, ctx.channelArn, who.botArn);
      if (!taker) return 'no-worker';
      worker = { id: principalIdFromArn(taker.botArn), type: 'assistant' };
    } else {
      workerArn = one(def.by);
      const id = workerArn ? personIdFromArn(workerArn) : null;
      if (!id) return 'no-worker';
      worker = { id, type: 'user' };
    }
    const machines = taskStateMachines();
    const deadlineAt = Math.floor(Date.now() / 1000) + def.deadline.afterMinutes * 60;
    const workflowRun: WorkflowRunRef = {
      runKey: args.runKey, workflow: args.name, step: args.step, event: ctx.event, botArn: who.botArn,
      ...(ctx.eventPerson ? { eventPerson: ctx.eventPerson } : {}), ...(ctx.subject ? { subject: ctx.subject } : {}),
      ...(ctx.invitationId ? { invitationId: ctx.invitationId } : {}), ...(ctx.alarm ? { alarm: ctx.alarm } : {}),
      values: ctx.values, deadlineAt,
    };
    const task = await openWorkflowTask({
      channelArn: ctx.channelArn, taskId: eventTaskId(args.runKey, args.step), machine: def.machine,
      ...(requesterArn ? { requesterArn } : {}), worker,
      assistantId: worker.type === 'assistant' ? worker.id : principalIdFromArn(who.botArn),
      ...(def.visibility ? { visibility: def.visibility } : {}), ...(def.priority ? { priority: def.priority } : {}),
      workflowRun,
    });
    if (!task) return 'failed';
    // THE TASK'S END IS SCHEDULED NOW, on this classification's group (decision 4); a schedule that could not be made is
    // counted and leaves the task to its person and its row's expiry.
    await scheduleTaskDeadline(ctx.channelArn, task.taskId, deadlineAt);
    // THE PERSON WHO HOLDS ITS FIRST STEP IS TOLD, PRIVATELY, AND EMAILED (decision 2).
    if (task.assigneeType === 'user' && task.assigneeId) {
      const holder = [requesterArn, workerArn].find((arn) => arn && personIdFromArn(arn) === task.assigneeId);
      if (holder) {
        const name = await resolveUserName(holder).then((n) => (n === 'there' ? '' : n)).catch(() => '');
        await sayWorkflowSend({
          channelArn: ctx.channelArn, botArn: who.botArn, assistant: who.assistant, workflow: args.name, event: ctx.event, step: args.step,
          template: 'workflow-task-assigned', values: { ...ctx.values, ...(name ? { name: workflowMention(name) } : {}) }, to: [holder],
          runKey: args.runKey, transitions: args.transitions, mentions: ['name'], variables: who.variables,
          ...(args.eventValues ? { eventValues: args.eventValues } : {}),
          ...(() => { const card = taskCardOf(task, machines); return card ? { taskCard: card } : {}; })(),
          emailKind: 'task',
        });
      }
    }
    return 'opened';
  } catch (err) {
    console.warn('[Router][event-workflow] a task step could not open its task', { step: args.step, errName: (err as Error)?.name });
    return 'failed';
  }
}

/**
 * WHAT THE TASK SERVICE NAMED (ADR-063 decisions 3 and 5), checked before anything runs: the conversation is this
 * router's classification, and the task, read back through the task service, still says what the naming said. A
 * settled task a run waits on continues that run, once, on the edge its ending chose; a task now an assistant's to take
 * up is taken up where that assistant is idle (`handleTaskReady`).
 */
export async function handleTaskNaming(raw: unknown): Promise<{ ran: boolean; reason?: string }> {
  const r = raw as Partial<TaskNaming> | null;
  if (!r || (r.kind !== 'settled' && r.kind !== 'ready') || typeof r.channelArn !== 'string' || !r.channelArn.includes('/channel/') || typeof r.taskId !== 'string' || !r.taskId) {
    return { ran: false, reason: 'malformed' };
  }
  if ((await resolveChannelClassificationTag(r.channelArn)) !== STATIC_CLASSIFICATION) return { ran: false, reason: 'not this classification' };
  const task = await getTask(r.taskId, r.channelArn);
  if (!task) return { ran: false, reason: 'no such task' };
  if (r.kind === 'ready') return handleTaskReady(task);
  const run = task.workflowRun;
  const outcome = settlementOutcome(task, taskStateMachines());
  if (!run || !outcome) return { ran: false, reason: 'the task names no run, or is still open' };
  // THE SCHEDULE IS NO LONGER NEEDED (decision 4): settled, it would fire, find the task settled and start nothing.
  await deleteTaskDeadline(r.channelArn, task.taskId);
  return handleEventContinuation({
    runKey: run.runKey, workflow: run.workflow, step: run.step, outcome, event: run.event as WorkflowEvent,
    channelArn: r.channelArn, botArn: run.botArn, values: run.values ?? {},
    ...(run.eventPerson ? { eventPerson: run.eventPerson } : {}), ...(run.subject ? { subject: run.subject } : {}),
    ...(run.invitationId ? { invitationId: run.invitationId } : {}), ...(run.alarm ? { alarm: run.alarm as AlarmChange } : {}),
  });
}

/**
 * A TASK NAMED READY FOR AN ASSISTANT (ADR-063 decision 5, the second event): the work became the assistant's while it may
 * hold no lock here. Checked from the row: the assignee is a live assistant of this classification and the task is ready
 * for it (`pickupReadiness`). Then the lock is asked for under the pickup's own correlation: claimed, the pickup turn is
 * dispatched; held, the task is recorded on the turn record, and the holder takes it up at its exit. Where the turn queue
 * is off there is no lock and so no idle (decision H1): only a task no turn has touched yet, its first step, is dispatched.
 */
async function handleTaskReady(task: Task): Promise<{ ran: boolean; reason?: string }> {
  const assistantId = task.assigneeType === 'assistant' ? task.assigneeId ?? '' : '';
  const instance = appInstanceArnOf(task.channelArn);
  if (!assistantId || !instance) return { ran: false, reason: 'not an assistant\'s' };
  const botArn = botArnFor(instance, assistantId);
  const assistant = await assistantOfBot(botArn, STATIC_CLASSIFICATION, await getBotArn());
  if (assistant.decision === 'decline') return { ran: false, reason: assistant.reason };
  if (!pickupReadiness(task, taskStateMachines(), assistantId).ready) return { ran: false, reason: 'not ready' };
  const correlationId = pickupCorrelationId(task);
  if (!turnQueueEnabled()) {
    if (taskHasBeenGivenATurn(task)) return { ran: false, reason: 'the turn queue is off; a later step waits for a message' };
    return dispatchTaskPickup(task, botArn, assistant.profile, correlationId);
  }
  const claim = await claimLockForPickup({ channelArn: task.channelArn, responderId: assistantId, correlationId });
  if (!claim.claimed) {
    await notePickupPending({ channelArn: task.channelArn, responderId: assistantId, taskId: task.taskId });
    return { ran: false, reason: 'a turn holds the conversation; it takes the task up at its exit' };
  }
  const out = await dispatchTaskPickup(task, botArn, assistant.profile, correlationId);
  if (!out.ran) await releaseLock({ channelArn: task.channelArn, responderId: assistantId, correlationId }).catch(() => undefined);
  return out;
}

/**
 * A TURN'S EXIT GAVE THE LOCK TO A PICKUP TURN (ADR-063 decision 5, the first event): the processor handed the lock over
 * in one conditional write and names the task here, because this router alone dispatches its classification's turns.
 * The task is read again and must still be ready for that assistant, and the lock must name the pickup; otherwise the
 * lock is released, so the conversation is never left held by a turn that will not run.
 */
export async function handleTaskPickup(raw: unknown): Promise<{ ran: boolean; reason?: string }> {
  const r = raw as Partial<TaskPickupRequest> | null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const channelArn = str(r?.channelArn); const botArn = str(r?.botArn); const correlationId = str(r?.correlationId);
  if (!channelArn.includes('/channel/') || !botArn.includes('/bot/') || !correlationId.startsWith('pickup-') || !str(r?.taskId)) return { ran: false, reason: 'malformed' };
  const responderId = principalIdFromArn(botArn);
  const release = () => releaseLock({ channelArn, responderId, correlationId }).catch(() => undefined);
  if ((await resolveChannelClassificationTag(channelArn)) !== STATIC_CLASSIFICATION) return { ran: false, reason: 'not this classification' };
  const assistant = await assistantOfBot(botArn, STATIC_CLASSIFICATION, await getBotArn());
  if (assistant.decision === 'decline') { await release(); return { ran: false, reason: assistant.reason }; }
  const task = await getTask(str(r?.taskId), channelArn);
  if (!task || !pickupReadiness(task, taskStateMachines(), responderId).ready || pickupCorrelationId(task) !== correlationId) {
    await release();
    return { ran: false, reason: 'the task is no longer ready for this assistant' };
  }
  const out = await dispatchTaskPickup(task, botArn, assistant.profile, correlationId);
  if (!out.ran) await release();
  return out;
}

/**
 * A PICKUP TURN SERVES THE ARM ITS TASK WAS OPENED UNDER, while the experiment holds it (ADR-064 decision J): the version
 * whose routes chose the task's models in the turns before, so the step it takes up (a delivering step writing its own
 * document, ADR-064 decision B) runs on that version's model rather than the live one's. Resolved through `resolveTaskArm`,
 * as an ordinary turn of the task resolves it; once the experiment stops nothing is added and the live version serves the
 * turn. The routing record carries what the version reaches (`routedVariant`), so the vend narrows the turn's session to
 * it, and the turn is attributed to the experiment where the experiment counts the task's work.
 */
export async function pickupArmFields(task: Pick<Task, 'experimentArm' | 'createdAt' | 'channelArn' | 'taskType' | 'openingIntent'>): Promise<Record<string, unknown>> {
  const arm = experimentArmOf(task);
  if (!arm || !task.channelArn) return {};
  const served = await resolveTaskArm(arm, task.createdAt, STATIC_CLASSIFICATION, task.channelArn,
    getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '')).catch((err: unknown) => {
    console.warn("[Router][pickup] the task's experiment arm could not be resolved; the live version serves the turn", { err: (err as Error)?.message });
    return null;
  });
  if (!served) return {};
  const taskIntent = taskIntentOf(task.taskType, knownIntentKeys(getIntentPack()), task.openingIntent, undefined);
  const imageModelKey = served.variantProfile ? imagePrimaryForIntent(served.variantProfile.models, taskIntent ?? '') : served.imageGenModelKey;
  const routedVariant = variantGrantOf({ modelKey: served.modelKey, imageModelKey, profile: served.variantProfile });
  return {
    ...(served.variantProfile
      ? { variantProfile: served.variantProfile, ...(served.variantVersion !== undefined ? { variantVersion: served.variantVersion } : {}) }
      : { ...(served.bedrockModelId ? { resolvedModel: served.bedrockModelId } : {}), ...(imageModelKey ? { resolvedImageModelKey: imageModelKey } : {}) }),
    ...(routedVariant ? { routedVariant } : {}),
    ...(countsTowardExperiment(served, '', false, taskIntent) ? { experimentId: served.experimentId, variantId: served.variantId } : {}),
  };
}

/**
 * HAND A PICKUP TURN TO THE PROCESSOR AS AN ORDINARY TASK TURN (ADR-063 decision 5). It is metered first by whose work it
 * is (decision I3), and the entry of the task's state is claimed once (`claimPickup`) before anything is posted. Then it is
 * the turn every task turn is: an acknowledgment posted as the assistant carrying the turn's `<!--corr:-->` marker, its
 * mapping recorded as `postAsAssistant` records it, and the dispatch the task-continuation path sends (`taskId`,
 * `taskType`, `isTaskContinuation`, `deliveryOption`), so the processor runs its ordinary pipeline: the task's step in the
 * system prompt, the task tools, a declared step action on entry, a delivering step's document, long replies split, and
 * the turn's attribution, declared `task_step` (`declaredTurnKind`). The line that starts the turn is the assistant's
 * `task-pickup` prompt template, and nobody's message is answered. A private task's acknowledgment and answer are its
 * owner's alone.
 */
async function dispatchTaskPickup(task: Task, botArn: string, profile: { name: string; rateLimitPerHour?: number }, correlationId: string): Promise<{ ran: boolean; reason?: string }> {
  const budget = pickupBudget(task);
  const gate = await evaluateAbuseGate({
    personId: budget === 'machineWritten' ? '' : budget.owner,
    rateLimit: budget === 'machineWritten' ? 0 : profile.rateLimitPerHour ?? 0,
    isAdmin: false,
    ...(budget === 'machineWritten' ? { machineWritten: true } : {}),
  }).catch(() => ({ allowed: false }));
  if (!gate.allowed) {
    console.warn('[Router][pickup] the budget refused a pickup turn; the task waits', { classification: STATIC_CLASSIFICATION });
    return { ran: false, reason: 'budget' };
  }
  const processorArn = await resolveAsyncProcessorArn(STATIC_CLASSIFICATION);
  if (!processorArn || !task.taskType || !task.taskState) return { ran: false, reason: 'no processor' };
  const prompt = await loadNamedTemplate({ classification: STATIC_CLASSIFICATION, assistant: profile.name, name: 'task-pickup' }, 'prompt').catch(() => undefined);
  const startLine = prompt ? renderPromptTemplate(prompt, {}) : undefined;
  if (!startLine?.ok) return { ran: false, reason: 'the task-pickup prompt could not be read' };
  // ONCE PER ENTRY, before anything is posted, so a second naming of the same ready step posts nothing.
  const claim = await claimPickup({ taskId: task.taskId, channelArn: task.channelArn, state: task.taskState });
  if (!claim.claimed) return { ran: false, reason: `not taken up (${claim.reason})` };
  const instance = appInstanceArnOf(task.channelArn);
  const ownerArn = instance && task.ownerPersonId ? userArnFor(instance, task.ownerPersonId) : '';
  const privately = isPrivateVisibility(task.visibility);
  if (privately && !ownerArn) return { ran: false, reason: 'a private task with no owner has nobody to answer' };
  const machines = taskStateMachines();
  const placeholder = getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, task.taskType, task.taskState, {
    words: await wordsOf(profile.name), declared: machines[task.taskType]?.states?.[task.taskState]?.placeholder,
  });
  let placeholderMessageId = '';
  try {
    await speakAsRoutedAssistant(
      { routeId: `${SPEAK_ROUTE_PREFIX}pickup-${randomUUID()}`, botArn, classification: STATIC_CLASSIFICATION, tableName: TURN_ROUTING_TABLE, channelArn: task.channelArn },
      { ddb: routingDdb },
    );
    // ONE MESSAGE BY CONSTRUCTION: a placeholder, short platform text the answer later replaces in place.
    const sent = await sendChannelMessage(chimeClient, {
      ChannelArn: task.channelArn,
      // DECLARED A TASK STEP from its first message, as a join recap declares itself, so it pairs with nothing.
      Content: withTurnDeclaration(`${placeholder} <!--corr:${correlationId}-->`, { kind: 'task_step' }),
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: botArn,
      Metadata: botMessageMetadata({ agentType: profile.name, classification: STATIC_CLASSIFICATION }, privately ? { targetedSender: ownerArn } : undefined),
      ...(privately ? { Target: [{ MemberArn: ownerArn }] } : {}),
    });
    placeholderMessageId = sent.MessageId ?? '';
    if (placeholderMessageId) await claimPlaceholderMapping(correlationId, placeholderMessageId).catch(() => undefined);
  } catch (err) {
    console.warn('[Router][pickup] the acknowledgment could not be posted; the step is not taken up', { errName: (err as Error)?.name });
    return { ran: false, reason: 'acknowledgment' };
  }
  const handed = await invokeAsync(processorArn, {
    channelArn: task.channelArn,
    correlationId,
    userMessage: startLine.prompt,
    // THE INSTRUCTION IS THE PLATFORM'S OWN, not a person's words, so the input guardrail screens nothing.
    userContent: '',
    classification: STATIC_CLASSIFICATION,
    botArn,
    taskId: task.taskId,
    taskType: task.taskType,
    taskCreated: false,
    isTaskContinuation: true,
    deliveryOption: DeliveryOption.TASK_MULTI_STEP,
    // A PRIVATE TASK IS ITS OWNER'S, and its turn answers them; a conversation task's turn speaks for nobody's message.
    ...(privately ? { senderArn: ownerArn } : {}),
    placeholderMessageId,
    trigger: 'task_step',
    triggerAtMs: Date.now(),
    taskPickup: { taskId: task.taskId, state: task.taskState },
    ...await pickupArmFields(task),
  });
  console.log('[Router][pickup] a ready task is taken up as an ordinary task turn', { handed, taskType: task.taskType, state: task.taskState });
  return { ran: handed };
}

/**
 * A RUN HANDED BACK AFTER ITS AGENT STEP (ADR-061 decision 5), verified before it continues: the conversation is
 * this router's classification, the workflow and the step are a platform workflow's agent step on the event named,
 * and the assistant is one of this classification's. The run key is recomputed from those, never taken from the
 * payload, and the continuation is claimed once, so a redelivered hand-back or one for a finished run posts nothing.
 */
export async function handleEventContinuation(req: EventContinuation): Promise<{ ran: boolean; reason?: string }> {
  const refuse = (reason: string) => {
    console.warn('[Router][event] continuation refused', { reason, classification: STATIC_CLASSIFICATION });
    return { ran: false, reason };
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const channelArn = str(req?.channelArn);
  const botArn = str(req?.botArn);
  if (!channelArn || !botArn || !str(req?.workflow) || !str(req?.step)) return refuse('malformed');
  if ((await resolveChannelClassificationTag(channelArn)) !== STATIC_CLASSIFICATION) return refuse('not this classification');
  const assistant = await assistantOfBot(botArn, STATIC_CLASSIFICATION, await getBotArn());
  if (assistant.decision === 'decline') return refuse(assistant.reason);
  const served = await servedWelcomeVersion(assistant.profile.name, channelArn).catch(() => undefined);
  const wf = workflowFor(served?.version.eventWorkflows, str(req.workflow));
  // AN AGENT STEP THE PROCESSOR COMPLETED, OR A TASK STEP WHOSE TASK SETTLED (ADR-063 decision 3).
  if (!wf || wf.on !== req.event || !(wf.states[str(req.step)]?.agent || wf.states[str(req.step)]?.task)) return refuse('no such agent or task step');
  const person = (v: unknown) => (typeof v === 'string' && v.includes('/user/') ? v : undefined);
  // AN ALARM'S RUN GOES ON ONLY WHILE THIS CONVERSATION STILL WATCHES THE ALARM, read again from its watch and its row.
  const alarm = wf.on === 'alarm-state-changed' ? alarmChangeOf(req.alarm) : undefined;
  if (wf.on === 'alarm-state-changed') {
    if (!alarm) return refuse('the run names no alarm');
    if (!(await conversationWatches(channelArn, alarm.name))) return refuse('the conversation no longer watches the alarm');
  }
  const naturalKey = eventNaturalKey(wf.on, channelArn, person(req.eventPerson), str(req.invitationId), alarm);
  if (!naturalKey) return refuse('the run names no person');
  const runKey = eventRunKey(wf.on, naturalKey, assistant.profile.name);
  if (str(req.runKey) !== runKey) return refuse('the run key does not match the run');
  // AN INVITATION'S RUN IS VERIFIED AGAIN BEFORE IT GOES ON: its people come from its record, never from the hand-back,
  // and an invitation revoked, redeemed or expired since the run started continues nothing.
  const invitation = isInvitationEvent(wf.on) ? await verifyInvitationEvent(channelArn, str(req.invitationId)) : undefined;
  if (invitation && 'refused' in invitation) return refuse(`the invitation is ${invitation.refused}`);
  const values = Object.fromEntries(Object.entries(req.values ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v).slice(0, 500)]));
  const base: EventRunContext = invitation
    ? { event: wf.on, channelArn, eventPerson: invitation.record.personArn, invitationId: invitation.record.invitationId, inviter: invitation.record.inviterArn, values }
    : { event: wf.on, channelArn, eventPerson: person(req.eventPerson), subject: person(req.subject), values, ...(alarm ? { alarm } : {}) };
  const invitationReason = invitation?.record.reason;
  const invitationRole = invitation?.record.participantRole;
  // The participant shape is re-read at the join only when a condition names a fact about its subject.
  const subjectNamed = [...conditionSources(wf, served?.version.variables)].some((s) => s.startsWith('person:'));
  const participants = wf.on === 'assistant-joined' && subjectNamed ? (await resolveParticipants(channelArn, botArn).catch(() => undefined))?.ctx : undefined;
  // THE STEPS AFTER IT ADDRESS ROLES AS THE RUN'S FIRST STEPS DID: the holdings are read again, from the row, now.
  const held: RouterGateHeld = {
    ...(participants ? { participants } : {}), ...(invitationReason ? { invitationReason } : {}), ...(invitationRole ? { invitationRole } : {}),
    ...(invitation ? { invitationPrompt: invitationPromptOf(invitation.record) } : {}),
  };
  const roles = await participantRolesForRun(str(req.workflow), wf, base, { botArn, variables: served?.version.variables }, held);
  const withRoles: EventRunContext = roles.roles ? { ...base, roles: roles.roles, roleSaidInRoom: roles.saidInRoom, ...(roles.deciding ? { decidingRoles: roles.deciding } : {}), ...(roles.conversationType ? { conversationType: roles.conversationType } : {}) } : base;
  const ctx: EventRunContext = { ...withRoles, gate: await routerGate(wf, withRoles, served?.version.variables, { ...held, ...(roles.members ? { members: roles.members } : {}), ...(roles.conversationType ? { conversationType: roles.conversationType } : {}) }) };
  const transitions: EventTransition[] = (Array.isArray(req.transitions) ? req.transitions : [])
    .filter((t) => t && typeof t.step === 'string' && typeof t.outcome === 'string').slice(0, 16);
  const out = await continueAfter(str(req.workflow), wf, ctx, { step: str(req.step), outcome: str(req.outcome), transitions },
    eventRunDeps(str(req.workflow), ctx, { botArn, assistant: assistant.profile.name, variantProfile: served?.variantProfile, variables: served?.version.variables }, runKey, undefined, invitationReason, invitationRole, held.invitationPrompt),
    taskStateMachines());
  return { ran: out.ran };
}

/**
 * ONE PLATFORM SEND (ADR-061 decision 2): the step's message template, selected for the assistant that says it,
 * rendered with no model call, posted as that assistant on a speak session, to the room or targeted at each person.
 * Declared a `notification` turn and carrying its workflow, step and event, never the rendered values.
 */
async function sayWorkflowSend(args: {
  channelArn: string; botArn: string; assistant: string; workflow: string; event: WorkflowEvent; step: string;
  template: string; values: Record<string, string>; to: string[]; runKey: string; transitions: EventTransition[];
  mentions?: string[]; variables?: Readonly<Record<string, VersionVariable>>; fallback?: boolean;
  /** The values the event carries by source (`eventSourceValues`), resolved like any other source. */
  eventValues?: Readonly<Record<string, VariableValue>>;
  /** A task step's card (ADR-063 decision 2), on the message only its addressee receives. */
  taskCard?: TaskCard;
  /** The email this send carries, where the event's own rule does not decide it: a task step's `task` notice. */
  emailKind?: 'task';
}): Promise<boolean> {
  try {
    // THE TEMPLATE LEARNS ITS AUDIENCE (ADR-060 decision 3): a stored one this send's readers may not read is passed
    // over; a field it binds to the version's variables or a source is resolved here, and the run's own values stand.
    const held = routerVariables(args.variables);
    const resolver = { ...held, values: { ...held.values, ...(args.eventValues ?? {}) } };
    const audience = args.to.length ? 'addressed' as const : 'room' as const;
    const template = await loadNamedTemplate({ classification: STATIC_CLASSIFICATION, assistant: args.assistant, name: args.template }, 'message', undefined,
      { lookup: resolver.lookup, audience, mentions: args.mentions ?? [], holds: routerHolds(resolver, args.channelArn, audience) });
    if (!template) {
      console.warn('[Router][event-workflow] the send names no message template this assistant can say', { template: args.template, step: args.step });
      return false;
    }
    // THE READER'S LANGUAGE (ADR-062 decision 4), read only when the template has a choice to make: a written variant,
    // or a `voice` fill. One person reads a targeted send, so their preferred language comes first; the room reads the
    // conversation's. Each is a declared tag from a record, never a judgement on text.
    const languages = (template.variants || template.fill === 'voice') ? await sendLanguages(args.channelArn, args.to) : {};
    const choice = chooseLanguage(template, { audience, ...languages });
    if (template.fill === 'voice' && !choice.targetWritten && !args.fallback) {
      // NO VARIANT IS WRITTEN FOR THE READER: the assistant says it in its own voice, which is a model call on its own
      // session, so the processor renders it and posts the written text if the render does not hold. THE EVENT'S OWN
      // VALUES TRAVEL RESOLVED (an invitation's reason, for one): the resolver says each only where its trust and this
      // send's readers allow, here where the router holds them, and the processor renders them as data.
      const eventResolved = resolveTemplateFields(choice.written.fields ?? {}, { ...resolver, site: { callSite: turnCallSite(undefined, args.channelArn), audience, section: 'chat' } });
      const handed = await dispatchVoiceSend({ ...args, values: { ...eventResolved, ...args.values }, target: choice.target, writtenLanguage: choice.writtenLanguage });
      if (handed) return true;
      console.warn('[Router][event-workflow] a voice send could not be handed to the processor; its written text is said', { step: args.step });
    }
    const written = choice.written;
    // THE ROLE A CREATING APPLICATION ASSERTED FOR THE ONE PERSON A SEND IS ADDRESSED TO (`host:role`), read from the row
    // only when the template binds it: member trust, so it is inserted for that person and never decides.
    const hostRole = args.to.length === 1 && Object.values(written.fields ?? {}).includes('host:role')
      ? await hostRoleOf(args.channelArn, args.to[0]) : undefined;
    const withHost = hostRole ? { ...resolver, values: { ...resolver.values, 'host:role': hostRole } } : resolver;
    const resolved = resolveTemplateFields(written.fields ?? {}, { ...withHost, site: { callSite: turnCallSite(undefined, args.channelArn), audience, section: 'chat' } });
    const rendered = renderMessageTemplate(written, { ...resolved, ...args.values }, { refusedValue: 'empty' });
    const content = rendered.ok ? (rendered.sections.chat ?? '').trim() : '';
    if (!content) return false;
    await speakAsRoutedAssistant(
      { routeId: `${SPEAK_ROUTE_PREFIX}event-${randomUUID()}`, botArn: args.botArn, classification: STATIC_CLASSIFICATION, tableName: TURN_ROUTING_TABLE, channelArn: args.channelArn },
      { ddb: routingDdb },
    );
    const metadata = {
      ...JSON.parse(botMessageMetadata(
        { agentType: args.assistant, classification: STATIC_CLASSIFICATION, turnKind: 'notification' },
        args.to.length ? { targetedSender: args.to[0] } : undefined,
      )),
      eventStep: { workflow: args.workflow, step: args.step, event: args.event, outcome: 'posted' },
      // THE RUN'S MOVES REACH THE ARCHIVE ON ITS MESSAGES (ADR-061 rule 11), as a task's transitions do.
      eventRun: { runKey: args.runKey, transitions: args.transitions },
      // A PERSON ADDED TO A CONVERSATION THEY DID NOT OPEN IS EMAILED THE SEND ADDRESSED TO THEM (ADR-061 decision 3),
      // as the `memberWelcome` notice the run replaces emailed them: a `conversation-shared` notice they can mute, its
      // subject the template's own `email.subject`, sent by the notification bridge off the message stream.
      // A TASK STEP'S CARD, which only its addressee receives (ADR-063 decision 2): ids and declared names, never words.
      ...(args.taskCard && args.to.length === 1 ? { task: args.taskCard } : {}),
      ...(() => {
        const kind = args.emailKind && args.to.length ? args.emailKind : workflowSendEmailKind(args.event, args.to);
        if (!kind) return {};
        const subject = rendered.ok ? (rendered.sections['email.subject'] ?? '').trim() : '';
        return notifyDirective({ ...(subject ? { subject } : {}), targets: args.to, kind, conversationId: conversationKey(args.channelArn) });
      })(),
    };
    // ONE RESPONSE, IN AS MANY PARTS AS IT NEEDS (`sendInParts`), every part to the send's audience. The first part
    // carries the directive, so a person is emailed once.
    await sendInParts(chimeClient, {
      ChannelArn: args.channelArn,
      text: content,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: args.botArn,
      Metadata: JSON.stringify(metadata),
      ...(args.to.length && { Target: args.to.map((MemberArn) => ({ MemberArn })) }),
    });
    return true;
  } catch (err) {
    console.error('[Router][event-workflow] a send could not be posted', { step: args.step, errName: (err as Error)?.name });
    return false;
  }
}

/**
 * THE LANGUAGES A SEND'S READERS NAME (ADR-062 decision 4): the conversation's, from the server-only channel-context row
 * (never member-writable Metadata, SPEC-BILINGUAL-CONVERSATIONS FR2), and, for a send one person reads, that person's
 * preferred language from the user-profile store, the read the reply preferences make. A read that fails is a language
 * not known, and the order moves on.
 */
async function sendLanguages(channelArn: string, to: string[]): Promise<{ conversation?: string; preferred?: string }> {
  const [row, prefs] = await Promise.all([
    getChannelContext(channelArn).catch(() => null),
    to.length === 1 ? getReplyPreferences(personIdFromArn(to[0]) || '').catch(() => ({} as Record<string, string>)) : Promise.resolve({} as Record<string, string>),
  ]);
  return {
    ...(typeof row?.userLanguage === 'string' && row.userLanguage ? { conversation: row.userLanguage } : {}),
    ...(typeof prefs[PREFERRED_LANGUAGE_KEY] === 'string' ? { preferred: prefs[PREFERRED_LANGUAGE_KEY] } : {}),
  };
}

/**
 * HAND A `voice` SEND TO THE PROCESSOR (ADR-062 decision 4): the template's name, the run's values and the languages
 * the order chose, through `invokeAsync`, as an agent step is handed over. The processor reads the template by name
 * through the same selection, so a payload never carries words.
 */
async function dispatchVoiceSend(args: {
  channelArn: string; botArn: string; assistant: string; workflow: string; event: WorkflowEvent; step: string;
  template: string; values: Record<string, string>; to: string[]; runKey: string; transitions: EventTransition[];
  mentions?: string[]; target: string; writtenLanguage: string;
}): Promise<boolean> {
  const processorArn = await resolveAsyncProcessorArn(STATIC_CLASSIFICATION);
  if (!processorArn) return false;
  return invokeAsync(processorArn, {
    channelArn: args.channelArn,
    // ONE TURN PER EVENT, STEP AND GROUP: a `fromRole: template` send says one template to each group of people
    // (`templatesForPeople`), so the template is the group's discriminator, and the event keeps two events that share a
    // natural key apart.
    correlationId: eventDispatchId('voice', [args.event, args.runKey.split('#').slice(1, -1).join('-') || conversationKey(args.channelArn), args.step, args.template, botIdFromArn(args.botArn)]),
    userMessage: '',
    userContent: '',
    classification: STATIC_CLASSIFICATION,
    botArn: args.botArn,
    trigger: 'event_step',
    triggerAtMs: Date.now(),
    voiceSend: {
      runKey: args.runKey, workflow: args.workflow, step: args.step, event: args.event, template: args.template,
      values: args.values, to: args.to, ...(args.mentions ? { mentions: args.mentions } : {}),
      target: args.target, writtenLanguage: args.writtenLanguage, transitions: args.transitions,
    },
  });
}

/**
 * THE ASSISTANT THAT TAKES A STEP NAMING `as` (ADR-061 decision 1, "Whose workflow runs"): read from this classification's
 * live assignment records and the room's members as the run's assistant reads them (`assistantForStep`). Undefined when
 * no assistant holding the role is in the room, or the room cannot be read, so nothing is dispatched to anyone.
 */
async function stepTaker(def: AgentStep, channelArn: string, selfBotArn: string): Promise<{ botArn: string; assistant?: string } | undefined> {
  await loadAssistantIndex();
  const self = { botArn: selfBotArn, role: roleByBotArn.get(selfBotArn) || ASSISTANT_ROLE || undefined };
  if (self.role === def.as?.role) return { botArn: selfBotArn };
  const live = await liveAssistantsForClassification(STATIC_CLASSIFICATION);
  if (!live.some((a) => a.role === def.as?.role)) return undefined;
  const size = await resolveChannelSize(chimeClient, channelArn, selfBotArn).catch(() => undefined);
  if (!size || size.unknown || size.refused) return undefined;
  return assistantForStep(def, { self, live, botsInRoom: (size.members ?? []).filter((m) => m.isBot).map((m) => m.arn) });
}

/**
 * HAND AN AGENT STEP TO THE PROCESSOR (ADR-061 decision 5): one turn of the assistant on its own vended session,
 * through `invokeAsync`, which records the turn routing the session is vended from. It carries ids and the
 * conversation's fields only; the processor reads the step from the platform's workflow by name, so a payload cannot
 * supply instructions.
 */
async function dispatchEventAgentStep(args: {
  runKey: string; workflow: string; step: string; event: WorkflowEvent; channelArn: string; botArn: string;
  eventPerson?: string; subject?: string; values: Record<string, string>; transitions: EventTransition[];
  roles?: Record<string, string[]>; conversationType?: string;
  invitationId?: string; inviter?: string;
  alarm?: AlarmChange;
  variantProfile?: import('./lib/active-profile.js').ProfileDefinition;
  promptValues?: Record<string, string>; proposalNotAfter?: number;
  /** A step another assistant takes (`as`): the run's assistant, whose version declares it, and its bot, handed back to. */
  workflowOwner?: string; ownerBotArn?: string;
}): Promise<boolean> {
  const processorArn = await resolveAsyncProcessorArn(STATIC_CLASSIFICATION);
  if (!processorArn) return false;
  // THE ARM'S VERSION RIDES THE DISPATCH, as an experiment turn's does, so the processor runs the step from the
  // same version that chose the workflow.
  const { channelArn, botArn, variantProfile, ...eventStep } = args;
  return invokeAsync(processorArn, {
    channelArn,
    // Keyed by the event and its natural key, so two people's `person-joined` runs, two invitations' runs, and two events
    // sharing a natural key (`invitation-sent` and `invitation-unredeemed`) are two turns, never collapsed into one.
    correlationId: eventDispatchId('event', [args.event, eventNaturalKey(args.event, channelArn, args.eventPerson, args.invitationId, args.alarm) ?? conversationKey(channelArn), args.step, botIdFromArn(botArn)]),
    userMessage: '',
    userContent: '',
    classification: STATIC_CLASSIFICATION,
    botArn,
    trigger: 'event_step',
    triggerAtMs: Date.now(),
    eventStep,
    ...(variantProfile ? { variantProfile } : {}),
  });
}

/**
 * What names an event to this router (ADR-061 decision 1): `conversation-opened` from the creator, `person-joined`
 * from each path that adds a person, and `invitation-sent` from the invitations function.
 */
export interface EventNaming {
  aeEvent: ConversationOpenedNaming | PersonJoinedNaming | InvitationSentNaming;
}

/** An event a declared source names, sent to the handler that verifies it. */
async function handleEventNaming(req: EventNaming['aeEvent']): Promise<{ ran: boolean; reason?: string; people?: string[] }> {
  if (req?.event === 'person-joined') return handlePersonJoined(req);
  if (req?.event === 'invitation-sent') return handleInvitationSent(req);
  return handleConversationOpened(req as ConversationOpenedNaming);
}

/** The token store's sparse invitation index is read through this, as the router reads no other token. */
let invitationsDoc: DynamoDBDocumentClient | null = null;

/**
 * THE INVITATION AN EVENT NAMES, AS ITS RECORD HOLDS IT: one of this conversation's invitations, at this router's
 * classification, still pending (`pendingInvitation`). With the record's key, which `invitation-sent` carries from the
 * function that has just written it, the record is read by that key, strongly consistent, so a fresh invitation is never
 * missed; otherwise through the sparse index that lists a conversation's invitations and holds no token, to its end. A
 * read that fails verifies nothing.
 */
async function verifyInvitationEvent(channelArn: string, invitationId: string, invitationKey?: string): Promise<{ record: InvitationRecord } | { refused: string }> {
  if (!INVITATIONS_TABLE) return { refused: 'unreadable: no token store is named' };
  if (!INVITATION_ID.test(invitationId)) return { refused: 'unknown' };
  if (invitationKey !== undefined && !INVITATION_KEY.test(invitationKey)) return { refused: 'unknown' };
  try {
    invitationsDoc = invitationsDoc ?? DynamoDBDocumentClient.from(routingDdb);
    return await pendingInvitation(invitationsDoc, INVITATIONS_TABLE, channelArn, invitationId, STATIC_CLASSIFICATION, Math.floor(Date.now() / 1000), invitationKey);
  } catch (err) {
    return { refused: `unreadable: ${(err as Error)?.name || 'error'}` };
  }
}

/**
 * What a narrowed agent step at an invitation's event reads as data (ADR-061 decision 8, rule 6): the names the record
 * carries, the conversation's title and the reason the inviter gave, and the invitation's expiry. Never a send's values.
 */
function invitationPromptOf(record: InvitationRecord): NonNullable<RouterGateHeld['invitationPrompt']> {
  const values: Record<string, string> = {
    ...(record.inviteeName ? { invitee: String(record.inviteeName).slice(0, 100) } : {}),
    ...(record.inviterName ? { inviter: String(record.inviterName).slice(0, 100) } : {}),
    ...(record.conversationName ? { title: String(record.conversationName).slice(0, 200) } : {}),
    ...(record.reason ? { reason: String(record.reason).slice(0, 280) } : {}),
  };
  return { values, expiresAt: record.expiresAt };
}

/** The held values a run at an invitation's events starts from, read from the verified record. */
function invitationHeld(record: InvitationRecord): RouterGateHeld {
  return {
    ...(record.conversationType ? { conversationType: record.conversationType } : {}),
    ...(record.reason ? { invitationReason: record.reason } : {}),
    ...(record.participantRole ? { invitationRole: record.participantRole } : {}),
    invitationPrompt: invitationPromptOf(record),
  };
}

/**
 * WHERE THIS CLASSIFICATION'S DEADLINE SCHEDULES LIVE (ADR-061 decision 1): its schedule group and scheduler role, from
 * the environment its stack sets, and this router as the target, its ARN read from the conversation's own account and
 * this function's name and region. Null where the stack declares none, and then no deadline is scheduled.
 */
function deadlineWiringFor(channelArn: string): DeadlineWiring | null {
  const account = channelArn.split(':')[4] || '';
  const region = process.env.AWS_REGION || '';
  const name = process.env.AWS_LAMBDA_FUNCTION_NAME || '';
  return deadlineWiringFromEnv(account && region && name ? `arn:aws:lambda:${region}:${account}:function:${name}` : undefined);
}

/** How many times a deadline's create is tried in one call, and the first wait between tries (then four times longer). */
export const DEADLINE_CREATE_ATTEMPTS = 3;
export const DEADLINE_CREATE_BACKOFF_MS = 200;

/**
 * A DEADLINE THAT COULD NOT BE SCHEDULED, COUNTED (decision 1): an EMF line CloudWatch extracts with no call, the one
 * metric the classification's `EventDeadlineUnscheduledAlarm` watches. Nothing else records this failure: the schedule
 * that would have been the record does not exist.
 */
function deadlineScheduleFailed(classification: string): void {
  emitEmfMetric({
    namespace: DEADLINE_METRIC_NAMESPACE,
    metrics: [{ name: DEADLINE_SCHEDULE_FAILED_METRIC, unit: 'Count' }],
    dimensionSets: [['Classification']],
    properties: { Classification: classification, [DEADLINE_SCHEDULE_FAILED_METRIC]: 1 },
  });
}

/**
 * SCHEDULE `invitation-unredeemed` FOR ONE INVITATION (decision 1): once, when the router handles its `invitation-sent`,
 * and only when the primary's served version declares a workflow on the deadline event for the invitation's type. The
 * deadline is the workflow's, brought forward to before the invitation expires. Never throws.
 *
 * A CREATE THAT FAILS IS RETRIED, then raised (decision 1, decided): up to `DEADLINE_CREATE_ATTEMPTS` attempts in this
 * same call, backing off between them, and where every one fails the router emits `DeadlineScheduleFailed`, which the
 * classification's alarm watches (`EventDeadlineUnscheduledAlarm`), so an operator learns that an invitation will not
 * be chased. Nothing sweeps for it and nothing polls.
 */
export async function scheduleInvitationDeadline(
  record: InvitationRecord,
  own: Record<string, EventWorkflow> | null | undefined,
  deps: {
    wiring?: DeadlineWiring | null; create?: typeof createDeadlineSchedule; now?: () => number;
    sleep?: (ms: number) => Promise<void>; metric?: (classification: string) => void;
  } = {},
): Promise<'scheduled' | 'exists' | 'no workflow' | 'no deadline' | 'not wired' | 'failed'> {
  const declared = declaredWorkflowOn(own, 'invitation-unredeemed');
  if (!declared || (declared.workflow.types?.length && !declared.workflow.types.includes(record.conversationType))) return 'no workflow';
  const after = declared.workflow.deadline?.afterMinutes;
  const at = typeof after === 'number' ? deadlineAt((deps.now ?? Date.now)(), after, record.expiresAt) : undefined;
  if (!at) return 'no deadline';
  const wiring = deps.wiring === undefined ? deadlineWiringFor(record.channelArn) : deps.wiring;
  if (!wiring) {
    console.warn('[Router][deadline] a workflow declares invitation-unredeemed and this classification has no schedule group; not scheduled', { classification: STATIC_CLASSIFICATION });
    return 'not wired';
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError = '';
  let lastMessage = '';
  for (let attempt = 0; attempt < DEADLINE_CREATE_ATTEMPTS; attempt++) {
    if (attempt) await sleep(DEADLINE_CREATE_BACKOFF_MS * 4 ** (attempt - 1));
    try {
      const out = await (deps.create ?? createDeadlineSchedule)(wiring, { event: 'invitation-unredeemed', channelArn: record.channelArn, invitationId: record.invitationId }, at);
      console.log('[Router][deadline] invitation-unredeemed', { outcome: out, workflow: declared.name, channelArn: record.channelArn, attempts: attempt + 1 });
      return out === 'created' ? 'scheduled' : 'exists';
    } catch (err) {
      lastError = (err as Error)?.name || 'error';
      // The service's own reason (a role it cannot assume, a malformed expression), which names no person.
      lastMessage = String((err as Error)?.message ?? '').slice(0, 300);
    }
  }
  console.error('[Router][deadline] the invitation-unredeemed schedule could not be created; raised to the alarm', { channelArn: record.channelArn, err: lastError, reason: lastMessage, attempts: DEADLINE_CREATE_ATTEMPTS });
  (deps.metric ?? deadlineScheduleFailed)(STATIC_CLASSIFICATION);
  return 'failed';
}

/**
 * `invitation-sent`, VERIFIED BEFORE ANYTHING RUNS (ADR-061 decision 1): the conversation is this router's
 * classification, the invitation's record exists, names this conversation at this classification, and is still
 * pending, and the room's primary is one of this classification's assistants. The invitee and the inviter are the
 * record's, never the payload's, which carries ids alone. Then two things, each only where the primary's served version
 * declares it: the deadline `invitation-unredeemed` is scheduled (`scheduleInvitationDeadline`), and the workflow on
 * `invitation-sent` runs (`declaredWorkflowOn`), each in a conversation of a type it declares. A refusal is logged by
 * reason and conversation, never by person.
 */
export async function handleInvitationSent(req: InvitationSentNaming): Promise<{ ran: boolean; reason?: string; deadline?: string }> {
  const refuse = (reason: string) => {
    console.warn('[Router][event] invitation-sent refused', { reason, classification: STATIC_CLASSIFICATION });
    return { ran: false, reason };
  };
  const channelArn = typeof req?.channelArn === 'string' ? req.channelArn : '';
  const invitationId = typeof req?.invitationId === 'string' ? req.invitationId : '';
  // THE RECORD'S KEY, when the invitations function named it: read strongly consistent, because the record was written
  // a moment ago and the index may not show it yet. A key that is not an invitation's is malformed.
  const invitationKey = typeof req?.invitationKey === 'string' ? req.invitationKey : undefined;
  if (req?.event !== 'invitation-sent' || !channelArn || !INVITATION_ID.test(invitationId)) return refuse('malformed');
  if (invitationKey !== undefined && !INVITATION_KEY.test(invitationKey)) return refuse('malformed');
  if ((await resolveChannelClassificationTag(channelArn)) !== STATIC_CLASSIFICATION) return refuse('not this classification');
  const invitation = await verifyInvitationEvent(channelArn, invitationId, invitationKey);
  if ('refused' in invitation) {
    console.warn('[Router][SecurityEvent] invitation-sent names no pending invitation of this conversation; nothing runs', {
      refused: invitation.refused, channelArn, classification: STATIC_CLASSIFICATION,
    });
    return { ran: false, reason: `the invitation is ${invitation.refused}` };
  }
  const primary = await primaryAssistantOf(channelArn, chimeClient, '[Router][event]');
  if (primary.classification !== STATIC_CLASSIFICATION) return refuse('primary is another classification');
  const assistant = await assistantOfBot(primary.botArn, STATIC_CLASSIFICATION, await getBotArn());
  if (assistant.decision === 'decline') return refuse(assistant.reason);
  const served = await servedWelcomeVersion(assistant.profile.name, channelArn).catch(() => undefined);
  const { record } = invitation;
  const deadline = await scheduleInvitationDeadline(record, served?.version.eventWorkflows);
  const declared = declaredWorkflowOn(served?.version.eventWorkflows, 'invitation-sent');
  if (!declared) return { ran: false, reason: 'no workflow', deadline };
  const { name, workflow: wf } = declared;
  if (wf.types?.length && !wf.types.includes(record.conversationType)) return { ran: false, reason: 'no workflow for this type', deadline };
  const out = await runWorkflowFor(name, wf, {
    event: 'invitation-sent', channelArn, eventPerson: record.personArn, invitationId: record.invitationId, inviter: record.inviterArn, values: {},
  }, { botArn: primary.botArn, assistant: assistant.profile.name, variantProfile: served?.variantProfile, variables: served?.version.variables },
  invitationHeld(record));
  return { ...out, deadline };
}

/**
 * A DEADLINE FIRED (ADR-061 decision 1, "on fire, before any model call"). The schedule carries ids alone, and nothing
 * runs until the record that answers whether the deadline still matters says it does:
 *  - the conversation carries this router's classification and is not archived (an unreadable or deleted one refuses);
 *  - the invitation is one of this conversation's, at this classification, and still pending: unredeemed, unrevoked,
 *    unexpired (`pendingInvitation`);
 *  - the people it names are still members: the inviter, and the invitee the invitation added, read live as the room's
 *    primary;
 *  - the primary's served version still declares a workflow on the event, for the invitation's type.
 * A redeemed invitation, a revoked one, an archived room or an inviter who left produces nothing, and is logged by
 * reason and conversation, never by person.
 */
/**
 * SCHEDULE A TASK STEP'S DEADLINE (ADR-063 decision 4) on this classification's group, as an invitation's is, retried and
 * raised to the same alarm when every attempt fails. Never throws.
 */
async function scheduleTaskDeadline(channelArn: string, taskId: string, deadlineAtSeconds: number): Promise<'scheduled' | 'exists' | 'not wired' | 'failed'> {
  const wiring = deadlineWiringFor(channelArn);
  if (!wiring) {
    console.warn('[Router][deadline] a task step has a deadline and this classification has no schedule group; not scheduled', { classification: STATIC_CLASSIFICATION });
    return 'not wired';
  }
  for (let attempt = 0; attempt < DEADLINE_CREATE_ATTEMPTS; attempt++) {
    if (attempt) await new Promise<void>((r) => setTimeout(r, DEADLINE_CREATE_BACKOFF_MS * 4 ** (attempt - 1)));
    try {
      const out = await createTaskDeadlineSchedule(wiring, { kind: 'task', channelArn, taskId }, new Date(deadlineAtSeconds * 1000));
      return out === 'created' ? 'scheduled' : 'exists';
    } catch { /* tried again below, then raised */ }
  }
  console.error('[Router][deadline] a task step\'s deadline could not be scheduled; raised to the alarm', { channelArn });
  deadlineScheduleFailed(STATIC_CLASSIFICATION);
  return 'failed';
}

/** DELETE A TASK'S DEADLINE SCHEDULE once the task settled (decision 4). A failure leaves its check on fire. Never throws. */
async function deleteTaskDeadline(channelArn: string, taskId: string): Promise<void> {
  const wiring = deadlineWiringFor(channelArn);
  if (!wiring) return;
  await deleteTaskDeadlineSchedule(wiring, channelArn, taskId).catch((err) => {
    console.warn('[Router][deadline] a task deadline could not be deleted; its check on fire still holds', { err: (err as Error)?.name });
  });
}

/**
 * A TASK STEP'S DEADLINE FIRED (ADR-063 decision 4). Nothing runs until the records say it still matters: the conversation
 * is this classification's and not archived, and the task, read through the task service, is still open and still names
 * a run. Then the task service cancels it with the deadline's ending and names the settlement, and the run continues on
 * `onDeadline`, else `onFailure`, when that naming arrives.
 */
export async function handleTaskDeadlineFired(firing: TaskDeadlineFiring): Promise<{ ran: boolean; reason?: string }> {
  const tags = await readChannelTags(chimeClient, firing.channelArn).catch(() => null);
  if (!tags) return { ran: false, reason: 'the conversation could not be read' };
  if (tags[CLASSIFICATION_TAG] !== STATIC_CLASSIFICATION) return { ran: false, reason: 'not this classification' };
  if (tags.archived === 'true') return { ran: false, reason: 'the conversation is archived' };
  const task = await getTask(firing.taskId, firing.channelArn);
  if (!task?.workflowRun) return { ran: false, reason: 'the task names no run' };
  if (settlementOutcome(task, taskStateMachines())) {
    console.info('[Router][deadline] the task settled before its deadline; nothing runs', { classification: STATIC_CLASSIFICATION });
    return { ran: false, reason: 'the task is settled' };
  }
  const { cancelled } = await cancelForDeadline({ taskId: firing.taskId, channelArn: firing.channelArn });
  return { ran: cancelled, ...(cancelled ? {} : { reason: 'the task service did not cancel it' }) };
}

export async function handleDeadlineFired(raw: unknown): Promise<{ ran: boolean; reason?: string }> {
  // A TASK STEP'S DEADLINE (ADR-063 decision 4) shares the router entry and the schedule group, by its own firing shape.
  const taskFiring = taskDeadlineFiringOf(raw);
  if (taskFiring) return handleTaskDeadlineFired(taskFiring);
  const refuse = (reason: string, expected = false) => {
    // AN INVITATION REDEEMED, REVOKED, EXPIRED OR GONE IS THE EXPECTED END OF A SCHEDULE: redemption and offboarding never
    // delete one, so it fires, finds nothing pending and deletes itself. That is logged at info; anything else at warn.
    (expected ? console.info : console.warn)('[Router][deadline] the deadline names nothing that still matters; nothing runs', { reason, classification: STATIC_CLASSIFICATION });
    return { ran: false, reason };
  };
  const firing: DeadlineFiring | null = deadlineFiringOf(raw);
  if (!firing) return refuse('malformed');
  const { channelArn, invitationId } = firing;
  const tags = await readChannelTags(chimeClient, channelArn).catch(() => null);
  if (!tags) return refuse('the conversation could not be read');
  if (tags[CLASSIFICATION_TAG] !== STATIC_CLASSIFICATION) return refuse('not this classification');
  if (tags.archived === 'true') return refuse('the conversation is archived');
  const invitation = await verifyInvitationEvent(channelArn, invitationId);
  if ('refused' in invitation) return refuse(`the invitation is ${invitation.refused}`, !invitation.refused.startsWith('unreadable'));
  const { record } = invitation;
  const primary = await primaryAssistantOf(channelArn, chimeClient, '[Router][deadline]');
  if (primary.classification !== STATIC_CLASSIFICATION) return refuse('primary is another classification');
  const assistant = await assistantOfBot(primary.botArn, STATIC_CLASSIFICATION, await getBotArn());
  if (assistant.decision === 'decline') return refuse(assistant.reason);
  const served = await servedWelcomeVersion(assistant.profile.name, channelArn).catch(() => undefined);
  const declared = declaredWorkflowOn(served?.version.eventWorkflows, firing.event);
  if (!declared) return refuse('no workflow');
  const { name, workflow: wf } = declared;
  if (wf.types?.length && !wf.types.includes(record.conversationType)) return refuse('no workflow for this type');
  // THE PEOPLE IT NAMES ARE STILL MEMBERS, read live as the room's primary: an inviter who left is chased for nobody.
  const size = await resolveChannelSize(chimeClient, channelArn, primary.botArn);
  if (size.refused || size.unknown) return refuse('the conversation\'s members could not be read');
  const roster = (size.members ?? []).map((m) => ({ arn: m.arn, name: m.name, isBot: m.isBot }));
  if (verifiedJoiners([record.inviterArn, record.personArn], roster).length < 2) return refuse('a person it names is no longer a member');
  return runWorkflowFor(name, wf, {
    event: firing.event, channelArn, eventPerson: record.personArn, invitationId: record.invitationId, inviter: record.inviterArn, values: {},
  }, { botArn: primary.botArn, assistant: assistant.profile.name, variantProfile: served?.variantProfile, variables: served?.version.variables },
  { ...invitationHeld(record), members: roster });
}

/** The alarm change a payload names, checked for shape only: the router reads the state itself before anything runs. */
function alarmChangeOf(raw: unknown): AlarmChange | undefined {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const name = typeof r.name === 'string' ? r.name : '';
  const changedAt = typeof r.changedAt === 'number' ? r.changedAt : NaN;
  return ALARM_NAME.test(name) && isAlarmState(r.state) && Number.isInteger(changedAt) && changedAt > 0
    ? { name, state: r.state, changedAt } : undefined;
}

/**
 * WHETHER THIS CONVERSATION WATCHES THE ALARM: the alarm's watch record names it at this classification, and its own row
 * names the alarm. Both are server-only records the canonical creator wrote (`recordAlarmWatch`, `watchedAlarm`); a room
 * a newer incident's room superseded watches it no longer.
 */
async function conversationWatches(channelArn: string, alarmName: string): Promise<{ conversationType?: string } | null> {
  const watch = await alarmWatchOf(alarmWatchKey(alarmName));
  if (!watch || watch.room !== channelArn || watch.classification !== STATIC_CLASSIFICATION) return null;
  const row = await getChannelContext(channelArn, { consistent: true }).catch(() => null);
  if (!row || row.watchedAlarm !== alarmName) return null;
  return { ...(row.conversationType ? { conversationType: row.conversationType } : {}) };
}

let cloudwatch: CloudWatchClient | null = null;

/**
 * THE ALARM'S STATE AS CLOUDWATCH REPORTS IT NOW, read by name under the router's one alarm read, which reaches this
 * deployment's alarms alone. Null when it cannot be read or names no alarm.
 */
async function alarmStateNow(alarmName: string): Promise<{ state: string; changedAt: number } | null> {
  try {
    cloudwatch = cloudwatch ?? new CloudWatchClient({});
    // METRIC ALARMS ONLY: asking for composite alarms is authorized against `*`, which the scoped read refuses. The
    // platform declares no composite alarm.
    const res = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: [alarmName], AlarmTypes: ['MetricAlarm'] }));
    const alarm = res.MetricAlarms?.[0];
    const at = alarm?.StateUpdatedTimestamp ? new Date(alarm.StateUpdatedTimestamp).getTime() : NaN;
    return alarm?.StateValue && Number.isFinite(at) ? { state: alarm.StateValue, changedAt: at } : null;
  } catch (err) {
    console.warn('[Router][alarm] the alarm could not be read', { err: (err as Error)?.name });
    return null;
  }
}

/**
 * `alarm-state-changed`, VERIFIED BEFORE ANYTHING RUNS (ADR-061, the incident watch). Its one source is the CloudWatch
 * alarm state change on the default bus, which this classification's incident-watch rule hands over as the alarm's name
 * and the state it reported; nothing else in the payload is read. Before any model call:
 *  - the alarm's watch record names a conversation at this router's classification, and that conversation's own row
 *    names the alarm (`conversationWatches`), so a payload cannot point a run at a room;
 *  - the conversation carries this classification's tag and is not archived;
 *  - the alarm is read back from CloudWatch and is still in the state the change reported, and the time it entered that
 *    state is the run's natural key, so a redelivered change starts nothing twice and a state the alarm has already left
 *    starts nothing;
 *  - the room's primary is one of this classification's assistants, whose served version declares a workflow on the
 *    event for the room's type.
 * A refusal is logged by reason, never with the alarm's name.
 */
export async function handleAlarmStateChanged(
  raw: unknown,
  deps: { stateNow?: typeof alarmStateNow; watch?: typeof alarmWatchOf; watches?: typeof conversationWatches } = {},
): Promise<{ ran: boolean; reason?: string }> {
  const refuse = (reason: string) => {
    console.warn('[Router][alarm] the alarm change starts nothing here', { reason, classification: STATIC_CLASSIFICATION });
    return { ran: false, reason };
  };
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const alarmName = typeof r.alarmName === 'string' ? r.alarmName : '';
  if (!ALARM_NAME.test(alarmName) || !isAlarmState(r.state)) return refuse('malformed');
  const watch = await (deps.watch ?? alarmWatchOf)(alarmWatchKey(alarmName));
  if (!watch) return refuse('no conversation watches the alarm');
  const channelArn = watch.room;
  const watching = await (deps.watches ?? conversationWatches)(channelArn, alarmName);
  if (!watching) return refuse('the conversation does not watch the alarm at this classification');
  const tags = await readChannelTags(chimeClient, channelArn).catch(() => null);
  if (!tags) return refuse('the conversation could not be read');
  if (tags[CLASSIFICATION_TAG] !== STATIC_CLASSIFICATION) return refuse('not this classification');
  if (tags.archived === 'true') return refuse('the conversation is archived');
  const now = await (deps.stateNow ?? alarmStateNow)(alarmName);
  if (!now) return refuse('the alarm could not be read');
  if (now.state !== r.state || !isAlarmState(now.state)) return refuse('the alarm has left the state the change reported');
  const primary = await primaryAssistantOf(channelArn, chimeClient, '[Router][alarm]');
  if (primary.classification !== STATIC_CLASSIFICATION) return refuse('primary is another classification');
  const assistant = await assistantOfBot(primary.botArn, STATIC_CLASSIFICATION, await getBotArn());
  if (assistant.decision === 'decline') return refuse(assistant.reason);
  const served = await servedWelcomeVersion(assistant.profile.name, channelArn).catch(() => undefined);
  const declared = declaredWorkflowOn(served?.version.eventWorkflows, 'alarm-state-changed');
  if (!declared) return refuse('no workflow');
  const { name, workflow: wf } = declared;
  if (wf.types?.length && !(watching.conversationType && wf.types.includes(watching.conversationType))) return refuse('no workflow for this type');
  const alarm: AlarmChange = { name: alarmName, state: now.state, changedAt: now.changedAt };
  return runWorkflowFor(name, wf, {
    event: 'alarm-state-changed', channelArn, alarm, values: { alarm: alarmName, alarmState: now.state },
  }, { botArn: primary.botArn, assistant: assistant.profile.name, variantProfile: served?.variantProfile, variables: served?.version.variables },
  { ...(watching.conversationType ? { conversationType: watching.conversationType } : {}) });
}

/**
 * DELETE THE DEADLINE SCHEDULES A RESOLVED THING NO LONGER NEEDS (ADR-061 decision 1, tenet D15): one invitation's, when
 * it is revoked, or every invitation's of a conversation, when it is archived. Redeeming an invitation and offboarding a
 * person name nothing here, by decision: their schedule fires, finds the invitation redeemed or gone, starts nothing, and
 * deletes itself (`handleDeadlineFired`).
 * Each is deleted by the name its ids derive, in this classification's own group, which is all its grant reaches. For a
 * whole conversation the invitations are read from the token store's sparse index, the one read this router holds
 * there, and only those at this classification are named. A schedule already gone is not an error. Never throws.
 */
export async function handleDeadlineCancel(
  raw: unknown,
  deps: { wiring?: DeadlineWiring | null; del?: typeof deleteDeadlineSchedule; list?: (channelArn: string) => Promise<InvitationRecord[]> } = {},
): Promise<{ deleted: number; reason?: string }> {
  const cancel: DeadlineCancel | null = deadlineCancelOf(raw);
  if (!cancel) return { deleted: 0, reason: 'malformed' };
  const wiring = deps.wiring === undefined ? deadlineWiringFor(cancel.channelArn) : deps.wiring;
  if (!wiring) return { deleted: 0, reason: 'not wired' };
  let ids: string[];
  if (cancel.invitationId) ids = [cancel.invitationId];
  else {
    const list = deps.list ?? (async (channelArn: string) => {
      if (!INVITATIONS_TABLE) throw new Error('no token store is named');
      invitationsDoc = invitationsDoc ?? DynamoDBDocumentClient.from(routingDdb);
      return everyInvitation(invitationsDoc, INVITATIONS_TABLE, channelArn);
    });
    const listed = await list(cancel.channelArn).catch(() => null);
    if (!listed) return { deleted: 0, reason: 'the conversation\'s invitations could not be read' };
    ids = listed.filter((r) => r.classification === STATIC_CLASSIFICATION).map((r) => r.invitationId);
  }
  let deleted = 0;
  for (const id of ids) {
    const out = await (deps.del ?? deleteDeadlineSchedule)(wiring, 'invitation-unredeemed', cancel.channelArn, id).catch((err) => {
      console.warn('[Router][deadline] a schedule could not be deleted; its check on fire still holds', { err: (err as Error)?.name });
      return 'failed' as const;
    });
    if (out === 'deleted') deleted++;
  }
  // AN ARCHIVED CONVERSATION'S OPEN WORKFLOW TASKS LOSE THEIR DEADLINES TOO (ADR-063 decision 4), by name.
  if (!cancel.invitationId && !deps.list) {
    const open = await workflowTasksOf(cancel.channelArn).catch(() => []);
    for (const taskId of open) {
      const out = await deleteTaskDeadlineSchedule(wiring, cancel.channelArn, taskId).catch(() => 'failed' as const);
      if (out === 'deleted') deleted++;
    }
  }
  console.log('[Router][deadline] cancelled', { deleted, named: ids.length, channelArn: cancel.channelArn });
  return { deleted };
}

/** How many people's `person-joined` runs one naming runs at once. */
const PERSON_JOINED_CONCURRENCY = 5;

/**
 * `person-joined`, VERIFIED BEFORE ANYTHING RUNS (ADR-061 decision 1): the conversation is this router's classification,
 * its primary is one of this classification's assistants, and each person named is a member of the conversation now,
 * read live from the Amazon Chime SDK as that assistant. A person who is not is refused, logged by kind and
 * conversation and never by person, and starts no run. The workflow is the one the primary's served version declares on
 * `person-joined` (`personJoinedWorkflowOf`), in a conversation of a type it declares, with the join recap after its
 * own steps; where it declares none, or none for this type, the platform's `join-recap`. A payload names none.
 *
 * Returns the people whose welcome a run owns, which is every verified person when the version declares a workflow for
 * this type, including one whose run a redelivered naming already claimed: the source then sends them no
 * `memberWelcome` of its own, so a person is welcomed once. With none declared it owns nobody, and each source welcomes
 * as before. `recapped` is every verified person: their run carries the join recap, so no source asks for one of its
 * own, and declaring a workflow never costs a joiner the recap.
 */
export async function handlePersonJoined(req: PersonJoinedNaming): Promise<{ ran: boolean; reason?: string; people: string[]; recapped: string[] }> {
  const refuse = (reason: string) => {
    console.warn('[Router][event] person-joined refused', { reason, classification: STATIC_CLASSIFICATION });
    return { ran: false, reason, people: [] as string[], recapped: [] as string[] };
  };
  const channelArn = typeof req?.channelArn === 'string' ? req.channelArn : '';
  const named = Array.isArray(req?.personArns)
    ? [...new Set(req.personArns.filter((p): p is string => typeof p === 'string' && p.includes('/user/')))].slice(0, MAX_PEOPLE_JOINED)
    : [];
  if (req?.event !== 'person-joined' || !channelArn || !named.length) return refuse('malformed');
  if ((await resolveChannelClassificationTag(channelArn)) !== STATIC_CLASSIFICATION) return refuse('not this classification');
  const primary = await primaryAssistantOf(channelArn, chimeClient, '[Router][event]');
  if (primary.classification !== STATIC_CLASSIFICATION) return refuse('primary is another classification');
  const assistant = await assistantOfBot(primary.botArn, STATIC_CLASSIFICATION, await getBotArn());
  if (assistant.decision === 'decline') return refuse(assistant.reason);
  const served = await servedWelcomeVersion(assistant.profile.name, channelArn).catch(() => undefined);
  // THE VERSION'S OWN, FOR A TYPE IT DECLARES, ELSE THE PLATFORM'S RECAP: a workflow written for another type leaves the
  // joiner caught up all the same.
  let chosen = personJoinedWorkflowOf(served?.version.eventWorkflows);
  const conversationType = chosen.workflow.types?.length ? (await getChannelContext(channelArn).catch(() => null))?.conversationType : undefined;
  if (chosen.workflow.types?.length && !(conversationType && chosen.workflow.types.includes(conversationType))) {
    chosen = { name: 'join-recap', workflow: workflowFor(undefined, 'join-recap')!, declared: false };
  }
  const { name, workflow: wf, declared } = chosen;
  // THE PERSON IS A MEMBER, read live as the room's primary: the read the join recap's refusal makes.
  const size = await resolveChannelSize(chimeClient, channelArn, primary.botArn);
  if (size.refused || size.unknown) return refuse('the conversation\'s members could not be read');
  const roster = (size.members ?? []).map((m) => ({ arn: m.arn, name: m.name, isBot: m.isBot }));
  const members = verifiedJoiners(named, roster);
  if (members.length < named.length) {
    console.warn('[Router][SecurityEvent] person-joined named people who are not members; no run for them', {
      refused: named.length - members.length, channelArn, classification: STATIC_CLASSIFICATION,
    });
  }
  const who = { botArn: primary.botArn, assistant: assistant.profile.name, variantProfile: served?.variantProfile, variables: served?.version.variables };
  let ran = false;
  for (let i = 0; i < members.length; i += PERSON_JOINED_CONCURRENCY) {
    const results = await Promise.all(members.slice(i, i + PERSON_JOINED_CONCURRENCY).map((personArn) => runWorkflowFor(name, wf, {
      event: 'person-joined', channelArn, eventPerson: personArn, values: {},
    }, who, { ...(conversationType ? { conversationType } : {}), members: roster }).catch((err) => {
      console.warn('[Router][event] a person-joined run failed', { channelArn, err: (err as Error)?.name });
      return { ran: false };
    })));
    ran = ran || results.some((r) => r.ran);
  }
  return { ran, people: declared ? members : [], recapped: members };
}

/**
 * `conversation-opened`, VERIFIED BEFORE ANYTHING RUNS (decision 1): the conversation is this router's
 * classification and its context row records a type an event opens. The workflow is the room primary's, the
 * `conversation-opened` workflow its served version declares for that type (W1); a payload names none. Returns whether a run started, so the
 * creator sends no separate welcome where one did, and the person the run owns, so the creator names them in no
 * `person-joined`.
 */
export async function handleConversationOpened(req: ConversationOpenedNaming): Promise<{ ran: boolean; reason?: string; people?: string[] }> {
  const refuse = (reason: string) => {
    console.warn('[Router][event] conversation-opened refused', { reason, classification: STATIC_CLASSIFICATION });
    return { ran: false, reason };
  };
  const channelArn = typeof req?.channelArn === 'string' ? req.channelArn : '';
  const personArn = typeof req?.personArn === 'string' && req.personArn.includes('/user/') ? req.personArn : '';
  if (req?.event !== 'conversation-opened' || !channelArn || !personArn) return refuse('malformed');
  if ((await resolveChannelClassificationTag(channelArn)) !== STATIC_CLASSIFICATION) return refuse('not this classification');
  const type = (await getChannelContext(channelArn, { consistent: true }).catch(() => null))?.conversationType;
  if (!type || !(getConversationTypeConfig(type).openedBy ?? []).length) return refuse('no type an event opens');
  const primary = await primaryAssistantOf(channelArn, chimeClient, '[Router][event]');
  if (primary.classification !== STATIC_CLASSIFICATION) return refuse('primary is another classification');
  const assistant = await assistantOfBot(primary.botArn, STATIC_CLASSIFICATION, await getBotArn());
  if (assistant.decision === 'decline') return refuse(assistant.reason);
  const served = await servedWelcomeVersion(assistant.profile.name, channelArn).catch(() => undefined);
  // THE WORKFLOW THE ROOM'S TYPE SELECTS (W1): the primary's `conversation-opened` workflow whose `types` name it.
  const opened = openedWorkflowOf(served?.version.eventWorkflows, type);
  if (!opened) return { ran: false, reason: 'no workflow' };
  const wf = opened.workflow;
  const label = typeof req.label === 'string' ? req.label.slice(0, 200) : '';
  const out = await runWorkflowFor(opened.name, wf, {
    event: 'conversation-opened', channelArn, eventPerson: personArn, values: { ...(label ? { label } : {}) },
  }, { botArn: primary.botArn, assistant: assistant.profile.name, variantProfile: served?.variantProfile, variables: served?.version.variables }, { conversationType: type });
  // THE PERSON THE OPENING NAMES ARRIVES WITH IT (decision 5, one welcome per arrival): a run that started owns their
  // welcome, so the creator names them in no `person-joined` and they are welcomed once, by this run.
  return { ran: out.ran, ...(out.ran ? { people: [personArn] } : {}) };
}

async function noticeSelection(
  kind: NoticeCopyKey,
  assistant: string | undefined,
  version: { messages?: import('./lib/message-template.js').VersionMessages } | undefined,
  /** Who reads it: a stored template whose insertions that audience may not read is passed over. */
  use?: import('./lib/message-template-selection.js').TemplateUse,
): Promise<ParsedTemplate> {
  const budget = kind === 'budgetExhausted' ? process.env.BUDGET_CANNED_RESPONSE : undefined;
  const selected = await selectMessageTemplate({
    classification: STATIC_CLASSIFICATION,
    ...(assistant ? { assistant } : {}),
    name: noticeTemplateName(kind),
    messages: version?.messages,
    ...(budget ? { deploymentLines: { chat: budget } } : {}),
    ...(use ? { use } : {}),
  });
  return selected.template;
}

export async function sayNotice(req: NoticeRequest): Promise<NoticeOutcome> {
  const refuse = (reason: string): NoticeOutcome => {
    console.error('[Router][SecurityEvent] refused a notice', { reason, kind: req?.kind, classification: STATIC_CLASSIFICATION });
    return { posted: false, reason };
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const channelArn = str(req?.channelArn);
  const botArn = str(req?.botArn);
  if (!isNoticeCopyKey(req?.kind)) return refuse('not a notice this platform says');
  // EVERY VARIABLE IS DECLARED, TYPED AND CAPPED for its kind (`checkNoticeVars`), so a caller names a notice
  // and cannot make an assistant say text of its own through a variable.
  const checked = checkNoticeVars(req.kind, req.vars ?? {});
  if ('refused' in checked) return refuse(checked.refused);
  let vars = checked.vars;
  if (!channelArn || !botArn) return refuse('the notice names no conversation or assistant');
  if (!STATIC_CLASSIFICATION) return refuse('this handler serves no classification');
  if ((await resolveChannelClassificationTag(channelArn)) !== STATIC_CLASSIFICATION) {
    return refuse('the conversation is not this classification');
  }
  const classificationBotArn = await getBotArn();
  if (!(await isSanctionedBattleBot(botArn, classificationBotArn, STATIC_CLASSIFICATION, ASSISTANT_ROLE))) {
    return refuse('the assistant is not one of this classification');
  }

  const assistant = await assistantOfBot(botArn, STATIC_CLASSIFICATION, classificationBotArn);
  if (assistant.decision === 'decline') {
    logAssistantDecline('[Router][notice]', assistant.reason, { kind: req.kind, channelArn, asBot: botIdFromArn(botArn) });
    return { posted: false, reason: assistant.reason };
  }
  const version = await resolveActiveProfile(assistant.profile.name, { ssm: ssmClient, ssmRoot: SSM_ROOT }).catch(() => undefined);
  // THE TEMPLATE THIS ASSISTANT SAYS IT FROM (ADR-062 decision 3): the one its version names, else its own of
  // the notice's name, else the classification's, else the shipped one.
  // People only: a notice is addressed to the person it concerns, or to the whole room when `to` is empty.
  const to = (Array.isArray(req.to) ? req.to : []).filter((a): a is string => typeof a === 'string' && a.includes('/user/'));
  // THE TEMPLATE LEARNS ITS AUDIENCE (ADR-060 decision 3), and a field it binds to the version's variables or a source
  // is resolved here, under what this router holds (`resolveTemplateFields`). A value the caller supplied stands.
  const resolver = routerVariables(version?.variables);
  const { audience, mentions } = noticeUse(req.kind, to);
  // A MENTION RENDERS ONLY FOR A MEMBER (ADR-060 decision 7): the person each mention names is checked against the
  // conversation's live membership, the read the join recap makes, and a name of a person who is not a member is left
  // out, so its line drops. A caller that names no person is said as before and logged.
  if (mentions.some((m) => m in vars)) {
    const named = req.people && typeof req.people === 'object' ? req.people : undefined;
    const roster = named
      ? await resolveChannelSize(chimeClient, channelArn, botArn).catch(() => ({ members: [] as Array<{ arn: string; isBot?: boolean }>, refused: false }))
      : undefined;
    // A ROOM THE BOUNDARY REFUSED IS NOT SPOKEN IN: the read that would check the mention is the read that says this
    // assistant may not act here, so nothing is posted.
    if (roster && 'refused' in roster && roster.refused) return { posted: false, reason: 'refused' };
    const members = new Set(roster?.members?.filter((m) => !m.isBot).map((m) => m.arn) ?? []);
    const held = noticeMentionsForMembers(req.kind, vars, named, members);
    vars = held.vars;
    if (held.unverified.length) console.warn('[Router][notice] a mention names no person, so membership was not checked', { kind: req.kind, fields: held.unverified });
    if (held.notMembers.length) console.warn('[Router][notice] a mention names a person who is not a member; it is left out', { kind: req.kind, fields: held.notMembers });
  }
  const chosen = await noticeSelection(req.kind, assistant.profile.name, version, { lookup: resolver.lookup, audience, mentions, holds: routerHolds(resolver, channelArn, audience) });
  // IN ITS READERS' LANGUAGE (ADR-062 decision 4), read only when the template carries a variant to choose: the one
  // person's preferred language for a notice addressed to them, else the conversation's, else the deployment's.
  const selected = chosen.variants ? chooseLanguage(chosen, { audience, ...(await sendLanguages(channelArn, to)) }).written : chosen;
  const resolved = resolveTemplateFields(selected.fields ?? {}, { ...resolver, site: { callSite: turnCallSite(undefined, channelArn), audience, section: 'chat' } });
  let content = noticeLine(undefined, req.kind, { ...resolved, ...vars }, undefined, selected);
  // A notice whose only line named a person who is not a member says nothing, rather than a line with a hole in it.
  if (!content.trim()) return { posted: false, reason: 'nothing to say' };
  const role = (assistant.source === 'assigned' && roleByBotArn.get(botArn)) || ASSISTANT_ROLE;

  try {
    await speakAsRoutedAssistant(
      { routeId: `${SPEAK_ROUTE_PREFIX}notice-${randomUUID()}`, botArn, classification: STATIC_CLASSIFICATION, tableName: TURN_ROUTING_TABLE, channelArn },
      { ddb: routingDdb },
    );
    const metadata = {
      ...JSON.parse(botMessageMetadata(
        {
          agentType: assistant.profile.name,
          ...(role && { assistantRole: role }),
          ...(assistant.profile === runtimeSeedByBotArn.get(botArn) && { runtimeClassification: STATIC_CLASSIFICATION }),
          classification: STATIC_CLASSIFICATION,
          turnKind: noticeTurnKind(req.kind),
        },
        to.length ? { targetedSender: to[0] } : undefined,
      )),
      // The kind's own shape (a join announcement, a welcome to email), built from its
      // checked variables and never supplied by the caller.
      ...noticeMetadata(req.kind, vars, { channelArn, template: selected }),
    };
    // ONE RESPONSE, IN AS MANY PARTS AS IT NEEDS (`sendInParts`), every part to the notice's audience.
    await sendInParts(chimeClient, {
      ChannelArn: channelArn,
      text: content,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: botArn,
      Metadata: JSON.stringify(metadata),
      ...(to.length && { Target: to.map((MemberArn) => ({ MemberArn })) }),
    });
    return { posted: true };
  } catch (err) {
    console.error('[Router][notice] the notice could not be posted', {
      kind: req.kind, channelArn, errName: (err as Error)?.name, err: (err as Error)?.message,
    });
    return { posted: false, reason: 'send-failed' };
  }
}

export interface RebuttalRoundEvent {
  aeRebuttal: Record<string, unknown>;
}
export interface RebuttalDispatch {
  dispatched: boolean;
  reason?: string;
  /** The round placeholder this router posted as the side, when it posted one. */
  placeholderMessageId?: string;
}

export async function dispatchRebuttalRound(p: Record<string, unknown>): Promise<RebuttalDispatch> {
  const refuse = (reason: string): RebuttalDispatch => {
    console.error('[Router][SecurityEvent] refused a rebuttal round', { reason, correlationId: p?.correlationId, classification: STATIC_CLASSIFICATION });
    return { dispatched: false, reason };
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const botArn = str(p?.botArn);
  const channelArn = str(p?.channelArn);
  const battle = (p?.battleContext && typeof p.battleContext === 'object' ? p.battleContext : {}) as { round?: unknown };
  if (!str(p?.correlationId) || !botArn || !channelArn) return refuse('the round names no turn, assistant or conversation');
  if (str(p?.classification) !== STATIC_CLASSIFICATION) return refuse('the round is for another classification');
  // The fixed shape of a rebuttal: round 2, no person waiting, no work opened. Anything else is a turn,
  // and a turn enters through the ordinary path.
  if (battle.round !== 2 || p.trigger !== 'rebuttal' || p.deliveryOption !== 'PLACEHOLDER_UPDATE') return refuse('not a rebuttal round');
  if ((await resolveChannelClassificationTag(channelArn)) !== STATIC_CLASSIFICATION) return refuse('the conversation is not this classification');
  if (!(await isSanctionedBattleBot(botArn, await getBotArn(), STATIC_CLASSIFICATION, ASSISTANT_ROLE))) {
    return refuse('the side is not an assistant of this classification');
  }
  // THE DUEL'S OWN RECORD AGREES (step 36). Round 2 exists only for a duel whose fan-out was claimed, for a
  // side that finished round 1, in the conversation the duel ran in. Read from the battle state rather than
  // trusted from the payload, so a round naming a side or a room the duel never had is refused.
  const battleId = str((battle as { battleId?: unknown }).battleId);
  const rivalBotArn = str((battle as { rivalBotArn?: unknown }).rivalBotArn);
  const rivalReplyMsgId = str((battle as { rivalReplyMsgId?: unknown }).rivalReplyMsgId);
  if (!battleId) return refuse('the round names no duel');
  const rows = await readBattleRows(battleId);
  if (!rows.some((r) => r.botArn === ORCHESTRATOR_CLAIM)) return refuse('the duel has no claimed round 2');
  const recordedChannel = battleChannelFrom(rows);
  if (recordedChannel && recordedChannel !== channelArn) return refuse('the duel ran in another conversation');
  if (botRowsOnly(rows).find((r) => r.botArn === botArn)?.state !== 'COMPLETED') return refuse('the side did not finish round 1');
  if (rivalBotArn && !botRowsOnly(rows).some((r) => r.botArn === rivalBotArn)) return refuse('the rival is not a side of the duel');
  const processorArn = await resolveAsyncProcessorArn(STATIC_CLASSIFICATION);
  if (!processorArn) return refuse('no processor for this classification');

  // ── WHAT THE SIDE SERVES IS RE-RESOLVED HERE, NEVER TAKEN FROM THE PAYLOAD ─────────────────────────
  //
  // The session this round is recorded with is narrowed from the routed variant (`grantEdgesFor`), and the
  // processor serves the version the dispatch carries. Both are read from the experiment's own pins, for
  // this side, exactly as round 1 read them (`resolveDuelSides`); a version, definition or attribution the
  // caller put in the payload is dropped, so a forged payload can neither be served nor widen the session.
  // The names are the sides' profiles' (`battleSideNames`): the side's names its placeholder, the rival's its rebuttal note.
  const sides = await resolveDuelSides({ classification: STATIC_CLASSIFICATION, selfBotArn: botArn, channelArn });
  // AN ENDED OR PAUSED EXPERIMENT ENDS ITS DUEL: no rebuttal from a treatment nobody
  // may judge any more. Ending is idempotent, so the other side's round finding the same answers nothing new.
  if (sides.ended) {
    await endDuelHere({ channelArn, battleId, reason: 'abandoned:experiment-ended' });
    return refuse('the experiment of the duel is no longer active; the duel is ended');
  }
  const self = sides.self;
  const {
    variantProfile: _payloadVersion, variantVersion: _payloadVersionNumber, routedVariant: _payloadVariant, experimentId: _payloadExperiment, variantId: _payloadVariantId,
    resolvedModel: _payloadModel, resolvedImageModelKey: _payloadImage, ...unversioned
  } = p;
  void _payloadVersion; void _payloadVersionNumber; void _payloadVariant; void _payloadExperiment; void _payloadVariantId; void _payloadModel; void _payloadImage;
  const payloadBattle = (unversioned.battleContext && typeof unversioned.battleContext === 'object' ? unversioned.battleContext : {}) as Record<string, unknown>;
  const { rivalName: _payloadRival, selfName: _payloadSelf, ...battleWithoutRival } = payloadBattle;
  void _payloadRival; void _payloadSelf;
  const routedVariant = self
    ? variantGrantOf({ modelKey: self.modelKey, imageModelKey: self.imageGenModelKey, profile: self.variantProfile })
    : undefined;
  // The round's duel context as the orchestrator described it, with both sides' profile names: the
  // rival's for the rebuttal note, this side's for its scorecard marker.
  const roundDuel = {
    ...battleWithoutRival,
    ...(sides.rival?.displayName && { rivalName: sides.rival.displayName }),
    ...(self?.displayName && { selfName: self.displayName }),
  };
  const round: Record<string, unknown> = {
    ...unversioned,
    battleContext: roundDuel,
    ...(self && { experimentId: self.experimentId, variantId: self.variantId, variantProfile: self.variantProfile }),
    ...(self?.variantVersion !== undefined && { variantVersion: self.variantVersion }),
    ...(routedVariant && { routedVariant }),
  };

  // THE ROUND'S PLACEHOLDER IS SAID HERE, as the side, on a speak route of this router's own, before the
  // round is recorded: the processor finds it by the correlation id its markers carry and answers into it.
  // The markers are the one battle-marker builder's (`battlePlaceholderContent`), and the placeholder
  // declares no answered message, since a rebuttal answers the rival rather than a person. A placeholder
  // that cannot be posted dispatches nothing, so no rebuttal is generated with nowhere to land.
  let placeholderMessageId: string | undefined;
  try {
    await speakAsRoutedAssistant(
      { routeId: `${SPEAK_ROUTE_PREFIX}duel-${randomUUID()}`, botArn, classification: STATIC_CLASSIFICATION, tableName: TURN_ROUTING_TABLE, channelArn },
      { ddb: routingDdb },
    );
    // ONE MESSAGE BY CONSTRUCTION: a duel side's placeholder, which its round-2 answer replaces in place.
    const sent = await sendChannelMessage(chimeClient, {
      ChannelArn: channelArn,
      Content: battlePlaceholderContent({
        correlationId: str(p.correlationId),
        battleId,
        round: 2,
        totalRounds: 2,
        rivalBotArn,
        ...(rivalReplyMsgId && { rivalReplyMsgId }),
        // The side's profile name, so the working state names it as round 1 did.
        ...(self?.displayName && { displayName: self.displayName }),
      }),
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: botArn,
    });
    placeholderMessageId = sent?.MessageId;
  } catch (err) {
    console.error('[Router][rebuttal] the round placeholder could not be posted; the round is not dispatched', {
      correlationId: p.correlationId, errName: (err as Error)?.name, err: (err as Error)?.message,
    });
    return { dispatched: false, reason: 'placeholder-failed' };
  } finally {
    // The speak session ends with the placeholder: recording and dispatching the round acts as this router.
    releaseAssistantSession();
  }
  // invokeAsync records the turn (with the side's routed variant and the conversation) before dispatching.
  return (await invokeAsync(processorArn, round))
    ? { dispatched: true, ...(placeholderMessageId && { placeholderMessageId }) }
    : { dispatched: false, reason: 'the round could not be recorded or dispatched', ...(placeholderMessageId && { placeholderMessageId }) };
}

/** The exactly-once claim row the orchestrator writes before it fans round 2 out (`tryClaimOrchestratorFire`). */
const ORCHESTRATOR_CLAIM = '__orchestrator__';

export interface ClearMarkersEvent {
  aeClearMarkers: { channelArn: string; battleId: string; markers: Array<{ messageId: string; botArn: string }> };
}
export interface ClearMarkersOutcome {
  cleared: number;
  reason?: string;
}

/**
 * END A DUEL THIS ROUTER DECIDED TO END, clearing its waiting markers IN PLACE (`clearDuelMarkers`).
 *
 * Never by invoking a router: the remote path resolves `routerArnForClassification`, which this router's own
 * environment does not carry (it reads `ROUTER_ARN_PARAM` only), so a router that asked itself would leave
 * every waiting marker standing on a duel it had ended. The checks are the same either way, because the
 * in-place clear is the function the remote path invokes.
 */
async function endDuelHere(args: { channelArn: string; battleId: string; reason: BattleEndReason }): Promise<void> {
  await endBattle({
    ...args,
    classification: STATIC_CLASSIFICATION,
    clearMarkers: async (req) => (await clearDuelMarkers(req)).cleared,
  });
}

/**
 * TAKE DOWN AN ENDED DUEL'S WAITING MARKERS, each as the side whose message carries it (step 36).
 *
 * Ending a duel (`endBattle`) clears each waiting side's "answer here" control, an edit of that side's own
 * message, so it is said as that assistant. The caller (the channel flow, the battle administration API)
 * speaks as no assistant and names the markers; this router validates them and edits on a speak route of
 * its own. Every marker is checked against the battle state before anything is edited: the duel was
 * ended, it ran in this conversation, and the message is the one that side recorded as its waiting
 * question. A marker that fails any check is skipped, and the edit removes only `<!--battlewaiting:...-->`
 * (`clearBattleWaitingMarker`), so the question text stays.
 */
export async function clearDuelMarkers(req: ClearMarkersEvent['aeClearMarkers']): Promise<ClearMarkersOutcome> {
  const refuse = (reason: string): ClearMarkersOutcome => {
    console.error('[Router][SecurityEvent] refused a marker clear', { reason, classification: STATIC_CLASSIFICATION });
    return { cleared: 0, reason };
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const channelArn = str(req?.channelArn);
  const battleId = str(req?.battleId);
  if (!channelArn || !battleId || !Array.isArray(req?.markers)) return refuse('the clear names no conversation or duel');
  if (!STATIC_CLASSIFICATION) return refuse('this handler serves no classification');
  if ((await resolveChannelClassificationTag(channelArn)) !== STATIC_CLASSIFICATION) return refuse('the conversation is not this classification');
  const rows = await readBattleRows(battleId);
  if (!duelWasAbandoned(rows)) return refuse('the duel was not ended');
  const recordedChannel = battleChannelFrom(rows);
  if (recordedChannel && recordedChannel !== channelArn) return refuse('the duel ran in another conversation');
  const classificationBotArn = await getBotArn();

  let cleared = 0;
  for (const marker of req.markers) {
    const botArn = str(marker?.botArn);
    const messageId = str(marker?.messageId);
    const side = botRowsOnly(rows).find((r) => r.botArn === botArn);
    if (!botArn || !messageId || !side || side.waitingMessageId !== messageId) {
      console.error('[Router][SecurityEvent] skipped a marker the duel did not record', { battleId, asBot: botIdFromArn(botArn) });
      continue;
    }
    if (!(await isSanctionedBattleBot(botArn, classificationBotArn, STATIC_CLASSIFICATION, ASSISTANT_ROLE))) {
      console.error('[Router][SecurityEvent] skipped a marker of an assistant not of this classification', { battleId });
      continue;
    }
    try {
      await speakAsRoutedAssistant(
        { routeId: `${SPEAK_ROUTE_PREFIX}duel-${randomUUID()}`, botArn, classification: STATIC_CLASSIFICATION, tableName: TURN_ROUTING_TABLE, channelArn },
        { ddb: routingDdb },
      );
      if (await clearBattleWaitingMarker(channelArn, messageId, botArn, chimeClient)) cleared += 1;
    } catch (err) {
      console.warn('[Router][markers] could not clear a waiting marker', { battleId, message: (err as Error)?.message });
    } finally {
      releaseAssistantSession();
    }
  }
  return { cleared };
}

/**
 * What this invocation's intake did about reply preferences, for the dispatch to carry to the assistant.
 * Reset at handler entry: one Lambda container handles one event at a time, and a value left from the
 * previous event must never reach the next one's dispatch.
 */
let turnPreferenceOutcome: PreferenceTurn | undefined;
/** What this invocation's drift comparison decided, for the dispatch to carry to the analytics record. Reset likewise. */
let turnSubjectDecision: TurnSubjectDecision | undefined;
/** The question a declined drift offer held, for this turn to answer. Reset likewise. */
let turnHeldQuestion: HeldQuestion | undefined;

export const handler = async (rawEvent: LexEvent | BypassTurnEvent | RebuttalRoundEvent | NoticeEvent | ClearMarkersEvent): Promise<LexResponse> => {
  turnPreferenceOutcome = undefined;
  turnSubjectDecision = undefined;
  turnHeldQuestion = undefined;
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  // A rebuttal round is not a Lex turn and returns its own answer to the orchestrator's synchronous invoke.
  // Typed as the Lex response only so existing callers of `handler` keep their type. Released like a
  // notice, because it posts the round's placeholder as the side.
  if ((rawEvent as RebuttalRoundEvent).aeRebuttal) {
    try {
      return (await dispatchRebuttalRound((rawEvent as RebuttalRoundEvent).aeRebuttal)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // An ended duel's waiting markers, named by whoever ended it and taken down as each side (`clearDuelMarkers`).
  if ((rawEvent as ClearMarkersEvent).aeClearMarkers) {
    try {
      return (await clearDuelMarkers((rawEvent as ClearMarkersEvent).aeClearMarkers)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // A run the processor hands back after its agent step (ADR-061 decision 5), verified before it continues.
  if ((rawEvent as unknown as { aeEventContinue?: EventContinuation }).aeEventContinue) {
    try {
      return (await handleEventContinuation((rawEvent as unknown as { aeEventContinue: EventContinuation }).aeEventContinue)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // A turn's exit gave the lock to a pickup turn (ADR-063 decision 5), dispatched here as this classification's turn.
  if ((rawEvent as unknown as { aeTaskPickup?: unknown }).aeTaskPickup) {
    try {
      return (await handleTaskPickup((rawEvent as unknown as { aeTaskPickup: unknown }).aeTaskPickup)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // A task the task service named (ADR-063): one a run waits on settled, or one became an assistant's to take up.
  if ((rawEvent as unknown as { aeTask?: unknown }).aeTask) {
    try {
      return (await handleTaskNaming((rawEvent as unknown as { aeTask: unknown }).aeTask)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // A deadline a schedule marks (ADR-061 decision 1), checked against its record before anything runs.
  if ((rawEvent as unknown as { aeDeadline?: unknown }).aeDeadline) {
    try {
      return (await handleDeadlineFired((rawEvent as unknown as { aeDeadline: unknown }).aeDeadline)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // An alarm the incident watch follows changed state (ADR-061 slice 5), checked against CloudWatch before anything runs.
  if ((rawEvent as unknown as { aeAlarm?: unknown }).aeAlarm) {
    try {
      return (await handleAlarmStateChanged((rawEvent as unknown as { aeAlarm: unknown }).aeAlarm)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // A resolved invitation or an archived conversation whose deadline schedules are no longer needed.
  if ((rawEvent as unknown as { aeDeadlineCancel?: unknown }).aeDeadlineCancel) {
    return (await handleDeadlineCancel((rawEvent as unknown as { aeDeadlineCancel: unknown }).aeDeadlineCancel)) as unknown as LexResponse;
  }
  // An event a declared source names (ADR-061 decision 1), verified before its workflow runs.
  if ((rawEvent as unknown as EventNaming).aeEvent) {
    try {
      return (await handleEventNaming((rawEvent as unknown as EventNaming).aeEvent)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // A notice the channel flow handed over, said by the assistant it names (`sayNotice`). Released like a
  // turn, because it adopts that assistant's session to speak.
  if ((rawEvent as NoticeEvent).aeNotice) {
    try {
      return (await sayNotice((rawEvent as NoticeEvent).aeNotice)) as unknown as LexResponse;
    } finally {
      await releaseAfterHeldWork();
    }
  }
  // ONE INVOCATION, ONE ASSISTANT. The session the turn adopts is released on every exit, so a warm
  // container never carries this turn's identity into the next (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
  // Every exit above ends the same way: work the invocation held settles first (`releaseAfterHeldWork`), so nothing
  // it started runs after its session ends or inside the next invocation's.
  try {
    return await handleTurn(rawEvent as LexEvent | BypassTurnEvent);
  } finally {
    await releaseAfterHeldWork();
  }
};

const handleTurn = async (rawEvent: LexEvent | BypassTurnEvent): Promise<LexResponse> => {
  // A refusal is a fact about THIS turn, not about the container. See `refusedChannelReads`.
  refusedChannelReads.clear();
  const event: LexEvent = (rawEvent as BypassTurnEvent).aeTurn
    ? bypassToLexEvent((rawEvent as BypassTurnEvent).aeTurn)
    : (rawEvent as LexEvent);

  // The identity this turn answered as, filled in by `runTurn` once it has resolved and VALIDATED it.
  // Carried out here rather than re-resolved, so the send can never post as a bot the turn itself
  // rejected (`isSanctionedBattleBot`).
  const spoke: SpokenAs = {};
  const response = await runTurn(event, spoke);
  if (!isFlowEntry(event)) return replyThroughLex(event, response, spoke);

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
  // ── A READING OPENS NOTHING; THE NOTICE IS THE PROGRESS ──────────────────
  //
  // A reading is dispatched because a queue formed, and a queue draws a notice - the one message
  // that updates as more arrives. Posting a placeholder here put a second working indicator beside
  // it for the same piece of work.
  //
  // NOT by handing this turn the notice to answer onto: that would write the proposal at the
  // notice's position, which predates the messages the proposal is about, and putting a finished
  // answer above the question that produced it is the defect ADR-029 exists for. The processor
  // posts a fresh message when it has the proposal, so it lands at the end.
  //
  // ONLY WHEN A WORKER RAN, the same condition the branch above uses: silence is safe because
  // something else finishes the job, and if nothing was dispatched nothing will.
  if (isSelfDispatchedTriage(event) && spoke.dispatched) {
    return formatLexSilentResponse(event);
  }
  return postAsAssistant(event, response, spoke);
};

/**
 * THE LONGEST MESSAGE AMAZON LEX CARRIES. Amazon Lex V2 refuses a fulfillment message whose `content` is over 1000
 * characters, so a reply Amazon Chime SDK would post from it never reaches the room.
 */
export const LEX_MESSAGE_MAX = 1000;

/**
 * A REPLY ON THE AMAZON LEX ENTRY IS SPLIT, NEVER REFUSED. A reply that fits goes back through Amazon Lex as it always
 * has. A longer one is posted as the assistant in parts (`sendInParts`), as every long message is, and Amazon Lex is
 * handed the one message the channel flow denies (`formatLexNothingToPost`), so the room holds the parts alone.
 *
 * WHO READS IT. Amazon Lex carries only a targeted message and the room's welcome (ADR-036: every assistant is created
 * with `StandardMessages: NONE` and `TargetedMessages: ALL`, and the channel flow dispatches every untargeted turn). So
 * a reply on this entry answers a message said privately to the assistant, and its parts are addressed to the person
 * who spoke, as Amazon Lex's own reply would be. The room's welcome (`WelcomeIntent` with no transcript, the assistant
 * joining) is said to the room. Only if the post is refused is the reply cut to one Amazon Lex message, because one
 * message is all that entry can carry.
 */
async function replyThroughLex(event: LexEvent, response: LexResponse, spoke: SpokenAs): Promise<LexResponse> {
  const messages = response.messages ?? [];
  if (!messages.some((m) => (m.content ?? '').length > LEX_MESSAGE_MAX)) return response;
  const channelArn = event.requestAttributes?.['CHIME.channel.arn'] || '';
  const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
  const roomWelcome = event.sessionState.intent.name === 'WelcomeIntent' && !(event.inputTranscript && event.inputTranscript.trim());
  const toSender = !roomWelcome && !!senderArn;
  const text = messages.map((m) => m.content ?? '').filter(Boolean).join('\n\n');
  if (channelArn && spoke.botArn) {
    try {
      await sendInParts(chimeClient, {
        ChannelArn: channelArn,
        text,
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: spoke.botArn,
        Metadata: botMessageMetadata(spoke.attribution, toSender ? { targetedSender: senderArn } : undefined),
        ...(toSender && { Target: [{ MemberArn: senderArn }] }),
      });
      return formatLexNothingToPost(event);
    } catch (err) {
      console.warn('[Router] a reply over the Amazon Lex message cap could not be posted in parts; cut to one message', {
        errName: (err as Error)?.name, err: (err as Error)?.message,
      });
    }
  }
  return {
    ...response,
    messages: messages.map((m) => (m.content && m.content.length > LEX_MESSAGE_MAX ? { ...m, content: cutForLex(m.content) } : m)),
  };
}

/** `text` cut to one Amazon Lex message, whole code points only, marked as cut. */
function cutForLex(text: string): string {
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > LEX_MESSAGE_MAX - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * What the turn did, reported back to the entry wrapper.
 *
 * `botArn` is filled once the turn has resolved and VALIDATED its identity, so the send can never post
 * as a bot the turn itself rejected. `dispatched` says a worker was invoked, which is what makes it safe
 * for this entry to stay quiet and let the processor finish.
 */
interface SpokenAs {
  botArn?: string;
  dispatched?: boolean;
  /**
   * WHO THIS TURN IS, for the metadata of anything it posts.
   *
   * Published beside `botArn` and for the same reason: the acknowledgment this handler posts on a
   * bypass carries the turn's `<!--corr:-->` marker, so it COUNTS as an assistant turn - and it used
   * to declare nothing, which reported an unknown assistant, an unknown role and an unknown version
   * on every flow-dispatched turn. Flow dispatch is the standard path, so that was most of the
   * traffic (`lib/bot-message-attribution.ts`).
   *
   * Set where the identity is validated, never derived at the send: the send has only an ARN, and
   * reading an assistant's name back off an ARN is the guess the archival deliberately removed.
   */
  attribution?: BotMessageAttribution;
}

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
    return { ...response, ...(spoke.attribution && { aeAttribution: spoke.attribution }) };
  }

  // ── A PRIVATE REQUEST STARTS WITH A PRIVATE ACKNOWLEDGMENT ────────────────
  //
  // "Targeted messages ... always generate a private response that starts with a private placeholder.
  // Any other message has a broadcast placeholder and broadcast message even in a 1:1."
  //
  // THIS POSTED UNTARGETED ALWAYS, and the cost was a whole mechanism built to work around it. A
  // private task answered onto a public acknowledgment cannot be answered in place, so
  // `planResumedChainDelivery` posted the answer as a SECOND, targeted message and turned this one
  // into the line "I have replied to you privately." That receipt is the visible half of the
  // workaround: measured four times in one two-person conversation, where it reads as the assistant
  // announcing a privacy nobody asked for.
  //
  // Targeted from the start, the answer simply updates this message, `placeholderIsTargeted` is true,
  // and no receipt is posted at all.
  //
  // DECLARED BY THE FLOW, NOT INFERRED HERE. `AE.turn.targeted` is set only by the `.<assistant>`
  // dispatch (`requestWasPrivate`), so an ordinary turn - including every 1:1 - is untargeted, which
  // is what it would have been had Amazon Lex carried it.
  const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
  const privateRequest = event.requestAttributes?.[BYPASS_TARGETED_ATTR] === '1' && !!senderArn;
  try {
    // ONE RESPONSE, IN AS MANY PARTS AS IT NEEDS (`sendInParts`): a placeholder is one part, and a long DIRECT answer
    // is split, its markers riding the first part, which is the message the correlation names.
    const sent = await sendInParts(chimeClient, {
      ChannelArn: channelArn,
      text: content,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: spoke.botArn,
      // Matches what the channel flow stamped, so the frontend cannot tell which component sent it.
      //
      // AND IT SAYS WHICH ASSISTANT SENT IT. This message carries the turn's `<!--corr:-->` marker, so
      // it is counted as an assistant turn; declaring nothing made every flow-dispatched turn report
      // an unknown assistant and an unknown role.
      Metadata: botMessageMetadata(
        spoke.attribution,
        privateRequest ? { targetedSender: senderArn } : undefined,
      ),
      ...(privateRequest && { Target: [{ MemberArn: senderArn }] }),
    });

    // ── THE SENDER RECORDS THE MAPPING, BECAUSE IT IS THE ONE THAT KNOWS IT ──────────────────────
    //
    // MEASURED, 2026-09-21, dev, three days: 127 of 270 turns (47%) entered
    // `pollForPlaceholderMessage`, and NONE of them gave up - 116 found the mapping on the second
    // read, about 150ms after the first miss. So the mapping was never absent, only late, and the
    // lateness is one fixed thing: the round trip this id was taking to get here.
    //
    // It used to travel Chime send -> message event -> channel flow invocation -> DynamoDB write,
    // and the worker waited on the far end of that. `MessageId` is in THIS response, and it was
    // being discarded. Writing it here removes the round trip from the wait; the ~150ms was the
    // round trip.
    //
    // WRITE-ONCE, AND THE FLOW STILL CLAIMS. `claimPlaceholderMapping` returns the owner, and the
    // flow denies only a DIFFERENT message holding the same correlation
    // (`channel-flow-processor.ts:539`). This claim names the same message the flow will see, so the
    // flow's claim returns this id, matches, and allows it. The flow's claim is NOT redundant: it
    // still covers placeholders Amazon Chime SDK materializes from a Lex fulfillment, which this
    // function never posts (it is bypass-only), and it is the duplicate guard ADR-022 specifies.
    //
    // NOT AWAITED INTO THE REPLY PATH'S FAILURE MODE. A mapping that does not get written costs the
    // poll that is being paid today, so it degrades to the current behavior rather than breaking the
    // turn - and the function already fails open for the same reason.
    const corr = correlationMarkerOf(content);
    if (corr && sent.MessageId) {
      try {
        const owner = await claimPlaceholderMapping(corr, sent.MessageId);
        if (owner !== sent.MessageId) {
          // Someone else already owns this correlation. The flow would deny this message as a
          // duplicate placeholder, so say so here rather than leaving it to be inferred downstream.
          console.warn('[Router] correlation already mapped to another message', {
            correlationId: corr, messageId: sent.MessageId, owner,
          });
        }
      } catch (err) {
        console.warn('[Router] recording the placeholder mapping failed; the worker will poll for it', err);
      }
    }
  } catch (err) {
    console.error('[Router] posting the assistant acknowledgment failed; handing it back to the caller', err);
    return { ...response, ...(spoke.attribution && { aeAttribution: spoke.attribution }) };
  }
  return formatLexSilentResponse(event);
}

const runTurn = async (event: LexEvent, spoke: SpokenAs): Promise<LexResponse> => {
  // ONE turn path, two entries. A bypass (@all, /battle) is normalized to the same event the Lex
  // fulfillment arrives on, so everything below this line cannot tell them apart - which is the point
  // (MESSAGE-FLOW §6.1). Bypassing Lex is the only sanctioned difference, and it ends here.
  // THE ROUTER LEG'S OWN CLOCK. Everything this handler does before it hands the turn off sits in
  // front of the placeholder, so it is inside TTFF - and until now the only instrument aimed at that
  // span was exchanges.inbound_ms, which is CROSS-CLOCK and spans the flow, Lex and this handler
  // together. One server-clock measurement of this handler alone is what makes the leg divisible.
  const routerStart = Date.now();
  // AND WHERE INSIDE IT THE TIME GOES. `routerStart` gives the leg a length; the step log gives it
  // parts, as instants the durations are derived from at read (see lib/router-steps.ts). Stamped
  // from the same entry point so the marks and `routerMs` share one origin and can be checked
  // against each other.
  const { log: routerSteps, mark: markRouterStep } = startRouterSteps(routerStart);
  /**
   * The two latency fields every dispatch carries, taken together from one instant.
   *
   * Both say "the router is done": `routerMs` as a length, `routerSteps` as the instants it is made
   * of. Reading them from one call is what makes `last(routerSteps) - first(routerSteps) ===
   * routerMs` an invariant rather than a coincidence, and an invariant is what lets a later reader
   * tell a mis-stamped step from a genuinely slow one.
   */
  const flowReceivedAt = Number(event.requestAttributes?.[BYPASS_FLOW_RECEIVED_ATTR]) || undefined;
  const stampDispatch = () => {
    const at = Date.now();
    markRouterStep('dispatched', at);
    return { routerMs: at - routerStart, routerSteps, ...(flowReceivedAt && { flowReceivedAt }) };
  };
  const lexIntentName = event.sessionState?.intent?.name;
  const channelArn = event.requestAttributes?.['CHIME.channel.arn'] || '';

  // `channelArn` IS ON THIS LINE BECAUSE ITS ABSENCE MADE THE LINE UNUSABLE FOR ATTRIBUTION. One log
  // group carries every turn this classification serves, so "was Amazon Lex invoked for THIS
  // conversation" - the question any entry-configuration change is measured by - could only be
  // answered by correlating timestamps. It is resolved two lines above and costs nothing to record.
  console.log('[Router] Invoked', { intent: lexIntentName, channelArn, hasTranscript: !!event.inputTranscript });


  // ═══════════════════════════════════════════════════════════════
  // THE CHANNEL FLOW'S TURN IS NOT OURS. Return nothing visible, BEFORE any work.
  //
  // WHAT THE FLOW CLAIMS, and it is one answer rather than a list (ADR-034). `/battle` at every
  // channel size; above a 1:1, `@all` and any `@` naming a member of this conversation. In a 1:1 the
  // flow stands aside entirely except for `/battle`. `flowOwnsTheTurn` IS that rule, the flow asks it
  // to decide whether to act, and this guard asks the same function over the same roster to decide
  // whether to stand down - so the two are complements by construction rather than by two lists
  // agreeing.
  //
  // WHY A GUARD IS NEEDED AT ALL. What varies with channel size is whether Amazon Chime SDK ALSO
  // invokes Lex. In a group, `StandardMessages: AUTO` routes only messages whose `CHIME.mentions`
  // names this bot; in a 1:1 it routes EVERY message regardless of mentions, so this handler is
  // invoked for a turn the flow may also be running, and without this guard it is answered twice.
  // Deterministic at that size, not a race.
  //
  // ONE DEFINITION, BECAUSE TWO DRIFTED. This tested `@all` alone while the flow had two bypasses, so
  // a `/battle` in a 2-member channel was answered twice: the flow took its `<2 bot members` fallback
  // and dispatched through the `@all` path while the message still read `/battle`, which this guard
  // did not match. Nothing errored - two plausible answers arrived. The rule now lives in
  // `lib/flow-bypass.ts` and both sides import it, so a new shape cannot be added to one half.
  //
  // FIRST STATEMENT IN THE HANDLER, deliberately. Everything below - bot ARN, classification,
  // clearance, onboarding, the LLM classifier - is work whose result would be discarded, and the
  // classifier is a billed model call. It also keeps the guard testable without standing up all of it.
  //
  // THE MEMBER-COUNT BRANCH IS LOAD-BEARING, and this comment used to argue against it. It read "one
  // path, no member-count branch", on the grounds that one responder at every size is simpler and
  // costs no membership read. Measured 2026-08-12, that design produced two placeholders on a live
  // 1:1 `@all`, 558ms apart, one stranded at "One moment..." forever: the two entries derive
  // correlation ids by different rules - the flow has the inbound `MessageId`, the Lex path provably
  // does not - so the duplicate-placeholder claim saw two identities and had no collision to deny.
  // The branch fixes that at the root by leaving exactly one entry. See `lib/channel-size.ts`.
  //
  // WHY NOT DENY THE MESSAGE IN THE FLOW. That would keep Lex out with no change here, but a denied
  // message is never persisted: the user's own message would vanish from the channel and from the
  // assistant's history. Acceptable for a battle continuation, whose answer is deliberately private;
  // not for anything a person said to the room.
  //
  // FAILURE MODE, STATED PLAINLY. This trusts that the flow ran. If the channel flow is not associated
  // to the channel, a 1:1 `@all` is silenced here and nothing answers it. That is a broken deployment
  // rather than a normal state - the flow is associated at channel creation, before any membership -
  // and the log line below is what makes it visible.
  //
  // Matched on the UNCAPPED transcript: `capUserMessage` truncates, which could drop a trailing
  // token and un-silence the very turn this exists for.
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
  // WIDENED FROM TWO LITERALS TO EVERY `@` TOKEN (ADR-034). The flow now routes `@<member>` as well
  // as `@all`, so the set this guard must complement is no longer enumerable - it is any `@` that
  // resolves against this channel's roster, which cannot be known without reading the roster.
  //
  // THE PREFILTER IS WHAT KEEPS THAT AFFORDABLE. A message with no `@` in it skips this block
  // entirely and this guard reads nothing, exactly as before. What IS new is that a mention-carrying
  // turn now pays the membership read where previously only `@all` did. That cost is real and it is
  // the price of the two sides agreeing: the flow reads the same roster for the same message, and a
  // handler that guessed instead would be the second implementation this whole seam exists to prevent.
  //
  // IT IS NOT THE ONLY MEMBERSHIP READ IN THIS HANDLER, and saying otherwise would be wrong:
  // `getMemberArns` above reads the same list for `/stop` and caches it per container, while this
  // path goes through `resolveChannelSize` and does not. Two reads of one list in one handler is
  // worth collapsing, and collapsing it is a change to what `getMemberArns` returns (it discards
  // names) rather than anything this guard can do locally.
  //
  // `bypassToken` IS IN THE GATE, AND DROPPING IT WAS A DEFECT. This guard used to fire on that alone;
  // widening it to the prefilter without keeping it NARROWED the guard, because the two have different
  // match surfaces - `matchesAtAll` has no leading boundary and the prefilter requires one, so
  // "hey@all" is an `@all` that the prefilter calls no mention. Every such form skipped the guard
  // entirely and this entry ran a full turn for a message the flow was claiming at the same moment.
  // A guard that grows must be a superset of the guard it replaces, or the widening is a narrowing
  // somewhere nobody looked.
  const invokesBattle = matchesBattleCommand(rawTranscript) || matchesBattleCommand(decodedTranscript);
  const mightMention = mightMentionSomeone(rawTranscript) || mightMentionSomeone(decodedTranscript);
  if (!isFlowEntry(event) && (invokesBattle || mightMention || bypassToken !== null)) {
    // `/battle` FIRST, AND WITHOUT READING ANYTHING. The flow owns a duel at every channel size: it
    // fans out when there are two assistants, and below that falls back to `handleMentionedMessage`
    // and answers anyway. So there is no size at which this entry should also answer, and reading the
    // roster to decide would be both wasted and wrong - in a 2-member channel the old code fell
    // through and produced a SECOND answer with its own placeholder, the exact duplicate
    // `lib/flow-bypass.ts` was written to remove.
    //
    // EVERY OTHER SHAPE NEEDS THE ROSTER, because the flow's behavior is per token and per size.
    // Bearer for the read: the classification bot this handler serves. `getBotArn()` is SSM-backed
    // and memoized per container, so this adds no per-turn parameter fetch.
    if (invokesBattle) {
      console.log('[Router] /battle belongs to the channel flow at every size; returning no visible message', {
        intent: lexIntentName,
      });
      return formatLexSilentResponse(event);
    }

    let size = await resolveChannelSize(chimeClient, channelArn, await getBotArn());
    // REFUSED IS CHECKED BEFORE UNKNOWN, AND BEFORE THE RETRY. A refusal sets `unknown` too, so
    // without this the retry below would re-probe the boundary and then fall into the per-token
    // fail-direction reasoning - which weighs "who answers" for an assistant that may not answer at
    // all. There is no fail direction to pick here: the turn ends (ADR-045 decision 1).
    if (size.refused) {
      return refuseAtClassificationBoundary(event, channelArn, 'channel-size:mention-or-bypass');
    }
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
      // THE RETRY CAN BE THE READ THAT IS REFUSED. The first read failing as a throttle and the
      // second as a denial is not exotic: a cold container racing an out-of-band membership change
      // produces exactly that pair. Checking only before the retry would let this turn continue on a
      // refusal the router had already been told about once.
      if (size.refused) {
        return refuseAtClassificationBoundary(event, channelArn, 'channel-size:mention-or-bypass-retry');
      }
    }
    // UNKNOWN IS NOT "GROUP", AND IT IS NOT ONE ANSWER ANY MORE EITHER. Silence is the right direction
    // only for a message the flow is CERTAIN to have claimed, and after widening this guard to every
    // `@` that is no longer the same set as "the guard fired".
    //
    //  - `@all` is a literal. The flow takes it at every size above 1:1 and its own unreadable-count
    //    path fails toward dispatching, so the flow answers and this entry must not. Silence, loudly.
    //  - ANY OTHER `@` needs the roster to mean anything, and the flow needs the same roster from the
    //    same service that just failed here. It resolved nobody and dispatched nothing. Standing down
    //    as well would leave the turn answered by NOBODY - and unlike the `@all` case that is not a
    //    rare 1:1 edge, it is every `@`-shaped message during an outage, including "meet @ 3pm".
    //
    // So the fail direction is now per token, which is what it always should have been: preserve
    // one-responder, and pick the responder that can still be right.
    if (size.unknown) {
      // THE FAIL DIRECTION IS THE COMMAND'S OWN, READ FROM THE REGISTRY rather than named here. The
      // default above trades a possible silence for one-responder, which is right for `@all` and
      // `/battle`: a duplicate answer is worse than a missing one and the person can ask again. A
      // command that cannot usefully be asked again declares `answeredWhenRosterUnreadable`, and
      // `/stop` is the one that does - `lib/stop-target.ts` settles the identical question the same
      // way on its own path, reading an unreadable membership as no ambiguity rather than as a
      // question the person must answer before anything stops. The cost of being wrong is bounded
      // there and here alike: the stop marker is keyed per responder, so the worst case is this
      // assistant being stopped twice, not a second assistant being stopped.
      const answersAnyway = commandFor(bypassToken)?.answeredWhenRosterUnreadable === true;
      if (bypassToken && !answersAnyway) {
        console.warn('[Router] channel size unreadable twice; standing down to preserve one-responder. '
          + 'If this channel is a 1:1, this turn was answered by nobody - the size read is the defect to chase.', {
          intent: lexIntentName, token: bypassToken,
        });
        return formatLexSilentResponse(event);
      }
      if (answersAnyway) {
        console.warn('[Router] channel size unreadable twice on a command that must be answered; answering '
          + 'it rather than standing down, because for this command an unanswered turn is worse than a '
          + 'duplicated one. The size read is the defect to chase.', {
          intent: lexIntentName, token: bypassToken,
        });
      }
      console.warn('[Router] roster unreadable for an @ token; answering it, because the flow faced the '
        + 'same failure and cannot have claimed it. The roster read is the defect to chase.', {
        intent: lexIntentName,
      });
    }

    // THE SAME ANSWER THE FLOW READ, from the same function over the same roster. This is the whole
    // of the complement: the flow acts when this is true, and this entry stands down when it is true.
    // Tested in both transcript forms for the reason the block header gives - one malformed
    // %-sequence makes `decodeURIComponent` throw, and a percent-encoded token would otherwise be
    // seen by one side and not the other.
    // THE SAME ANSWER THE FLOW REACHED, or the two stop being complements. Both call the shared
    // handler's own classification rather than from the channel, because that is what makes the two
    // sides agree: this Lambda is the classification's router, Amazon Chime SDK invokes the assistant
    // whose classification matches the conversation, and the flow dispatches to the router named by
    // the conversation's classification. All three are the same value for one message.
    //
    // Under `'flow'` this entry is reached only by a targeted message, because `StandardMessages` is
    // `NONE` - and `flowOwnsTheTurn` stands the flow down for a resolved private address at every
    // size, so this entry answers it. That is the complement holding at the one size it changed.
    const flowAnswers =
      flowOwnsTheTurn({ text: decodedTranscript, members: size.members, isOneToOne: size.isOneToOne })
      || flowOwnsTheTurn({ text: rawTranscript, members: size.members, isOneToOne: size.isOneToOne });

    // A PRIVATE COMMAND IN A ROOM IS THIS ENTRY'S. An unaddressed command reaches Lex in a room only when
    // it was sent with a `Target`; the flow's copy of the same message stands down once it reads that
    // `Target` back. See `lib/private-command.ts`.
    if (flowAnswers && lexEntryAnswersCommand(bypassToken, size.isOneToOne)) {
      console.log('[Router] a command reached the Lex entry in a room, so it was sent privately; answering it', {
        intent: lexIntentName,
        token: bypassToken,
        memberCount: size.memberCount,
      });
    } else if (flowAnswers) {
      console.log('[Router] the channel flow owns this turn; returning no visible message', {
        intent: lexIntentName,
        token: bypassToken,
        memberCount: size.memberCount,
      });
      return formatLexSilentResponse(event);
    }

    // THE FLOW DID NOT CLAIM IT, SO THIS ENTRY ANSWERS. Two shapes reach here, and both are correct:
    //
    //  - A 1:1 carrying any `@` token. The flow stands aside at that size (AUTO routes every message
    //    to Lex there regardless of mentions, so this entry runs whatever the flow does), and this is
    //    the one entry, with one placeholder and one correlation id.
    //  - A GROUP message whose `@` named nobody on the roster - a typo, or a member who has left.
    //    The flow logged that and dispatched nothing. If AUTO invoked this handler at all it did so
    //    because the composer named a bot in `CHIME.mentions`, so answering is right; if it did not,
    //    this code never runs and the flow's warning is the only record, which is what that warning
    //    is for.
    console.log('[Router] no bypass claimed this turn, so this entry answers it', {
      intent: lexIntentName,
      token: bypassToken,
      memberCount: size.memberCount,
      isOneToOne: size.isOneToOne,
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
    //     (MESSAGE-FLOW §6.1), and the flow's stand-aside returns before reading it - so a 1:1
    //     "@all summarize this" with a PDF answered on the caption alone, with no error anywhere.
    // The stored message still holds the Metadata, so it is recovered here, on the one entry that
    // answers this turn. Best-effort: an unreadable message degrades to the text turn it already was.
    // READ BACK BY CONTENT, not by id: Chime sends Lex no `CHIME.message.id` (measured live - the
    // drift flow's resolveOriginatingMessageId documents the exact attribute set), so the stored
    // message is found the same way drift finds its anchor: newest-first listing, matched on the
    // exact transcript being handled, BEFORE the token strip below mutates it. The listing carries
    // the Metadata, which is where the attachment rides.
    //
    // ONLY WHEN THE MESSAGE REALLY ADDRESSED SOMEBODY. This block used to be reachable by `@all` and
    // `/battle` alone; widening the guard above to every `@` brought it a message like "email me
    // @home", which addresses nobody and has no bypass behind it to have dropped an attachment. That
    // is a stored-message read on ordinary traffic for no possible gain. The roster is already in
    // hand, so the question is answered exactly rather than approximated by the prefilter: a token
    // that resolves to a member (or to `@all`) can have come through a stand-aside; one that resolves
    // to nobody cannot.
    const addressed = resolveMentionedMember(decodedTranscript, size.members);
    const allSenderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
    if (channelArn && allSenderArn && (bypassToken || addressed)) {
      try {
        const listed = await recentChannelMessages(chimeClient, channelArn, await getBotArn());
        const wantedRaw = rawTranscript.trim();
        const wantedDec = decodedTranscript.trim();
        const inbound = listed.find((m) => {
          if (m.Sender?.Arn !== allSenderArn) return false;
          const raw = (m.Content || '').trim();
          // The raw form is still compared when it will not decode.
          const dec = decodeContent(raw).trim();
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
    // THE MENTION GOES TOO, not only `@all`. The comment above says this normalization exists so
    // "everything below cannot tell the entries apart and must not need to", and it named exactly one
    // token - so a 1:1 `@Atlas what is the deploy order` reached the model with the assistant's own
    // name as the first words, while the group path strips it before dispatch. Same defect the `@all`
    // normalization was added to fix, one token along. The roster was already read above.
    const normalized = addressed
      ? stripMentionOf(stripAtAll(decodedTranscript), addressed)
      : stripAtAll(decodedTranscript);
    event.inputTranscript = encodeURIComponent(normalized);
  }

  // THE FLOW'S COPY OF A PRIVATE COMMAND STANDS DOWN. The flow dispatched an unaddressed command it
  // could not see was targeted; the stored message can say so, and when it was, the Lex entry is
  // answering it (see the guard above and `lib/private-command.ts`). Only commands the flow dispatches
  // to the primary assistant pay this read.
  if (isFlowEntry(event) && channelArn) {
    const flowCommand = matchCommand(decodedTranscript) || matchCommand(rawTranscript);
    const flowMessageId = inboundMessageId(event);
    if (flowCommand?.dispatch === 'primary' && flowMessageId
      && await inboundWasTargeted(chimeClient, channelArn, flowMessageId, await getBotArn())) {
      // ── ONLY STAND DOWN IF SOMETHING ELSE WILL ANSWER (review, 2026-09-17) ──────────────────────
      //
      // This is the complement of `lexEntryAnswersCommand`, which carries `&& !isOneToOne`. This side
      // did not, so in a 1:1 BOTH entries stood down: the Lex entry because a 1:1 is not its case, and
      // this one because the message was targeted. A private `/stop` in a one-to-one stopped nothing
      // and said nothing.
      //
      // The size read is paid HERE rather than above, so it costs nothing on the ordinary path: it is
      // reached only by a primary-dispatch command that was actually sent with a `Target`, which is
      // rare. A refusal ends the turn as it does everywhere else (ADR-045).
      const commandSize = await resolveChannelSize(chimeClient, channelArn, await getBotArn());
      if (commandSize.refused) {
        return refuseAtClassificationBoundary(event, channelArn, 'channel-size:private-command');
      }
      if (!commandSize.isOneToOne) {
        console.log('[Router] the flow dispatched a command that was sent privately; the Lex entry answers it', {
          channelArn, command: flowCommand.token,
        });
        return formatLexSilentResponse(event);
      }
      // A 1:1 falls through and ANSWERS. `flowOwnsTheTurn` returns true for a one-to-one
      // unconditionally, so this dispatch is the only path the command has.
      console.log('[Router] a privately sent command in a 1:1; this dispatch is the only path, so it answers', {
        channelArn, command: flowCommand.token,
      });
    }
  }

  // THE LOCK THIS TURN WOULD STRAND, if it claims one and never hands the work on.
  //
  // Declared out here because the release below is a `finally` on the try that follows, and that
  // is the only scope it can read. Null means there is nothing to release: either this turn never
  // claimed, or it dispatched and the turn that runs owns the lock now.
  let lockToRelease: { channelArn: string; responderId: string; correlationId: string } | null = null;

  try {
    // WHICH IDENTITY THIS TURN ANSWERS AS.
    //
    // Ordinarily the classification's own bot. A duel side is told which to be, because the handler
    // resolves exactly one and a duel has two. VALIDATED, never trusted: an unchecked caller-supplied
    // ARN would let anything able to invoke this handler post as any bot in the app instance. An
    // unsanctioned ARN falls back to this classification's own bot rather than failing the turn - the
    // duel then shows the wrong author, which is visible, instead of going silent, which is not.
    // ── WHICH ASSISTANT THIS INVOCATION IS FOR, from the Amazon Lex bot it arrived on ─────────────
    //
    // Amazon Chime SDK supplies `CHIME.channel.arn` and `CHIME.sender.arn` and nothing else: it does
    // NOT say which bot was addressed (measured; DESIGN-ADDING-AN-ASSISTANT-ROLE §10a). So a
    // classification hosting two assistants cannot tell them apart from the attributes, and the
    // fallback to the classification's own bot is not a cosmetic wrong-name problem - Chime authorizes
    // a channel read on MEMBERSHIP, so the fallback identity is the one that cannot read a room only
    // the other assistant is in, and the turn dies on a refused `DescribeChannel`.
    //
    // Each additional role therefore has its own Lex bot, and the assignment record names it. The
    // invocation identifies the assistant because the Lex bot does.
    const classificationBotArn = await getBotArn();
    const addressedBotArn = await resolveBotArnForLexBot(event.bot?.id);
    const requestedBotArn = event.requestAttributes?.[BYPASS_BOT_ARN_ATTR];
    // THE ADDRESSED ASSISTANT WINS, and it is not caller-supplied: it comes from this invocation's own Lex
    // bot id matched against the deployment's records, so there is nothing for a caller to assert.
    // OTHERWISE THE ROOM'S PRIMARY answers (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8): the assistant
    // the room's `primaryAssistant` tag names, resolved through the assignment records. It must be an
    // assistant of this handler's classification; a room whose primary is not refuses the turn rather
    // than answering as some other bot.
    let botArn = addressedBotArn;
    // The room's primary when this turn resolved it, so a turn it answers asks for no second read to learn who names the room.
    let resolvedRoomPrimary: string | undefined;
    if (!botArn && channelArn) {
      const primary = await primaryAssistantOf(channelArn, chimeClient, '[Router]');
      // A handler with no static classification (the legacy path) serves the channel's own; every deployed
      // router has one, and there the primary must be an assistant of it.
      if (STATIC_CLASSIFICATION && primary.classification !== STATIC_CLASSIFICATION) {
        throw new Error(`[Router] the room's primary is a ${primary.classification} assistant; this handler serves ${STATIC_CLASSIFICATION}`);
      }
      botArn = primary.botArn;
      resolvedRoomPrimary = primary.botArn;
    }
    if (!botArn) botArn = classificationBotArn;
    if (requestedBotArn && requestedBotArn !== classificationBotArn) {
      if (await isSanctionedBattleBot(requestedBotArn, classificationBotArn, STATIC_CLASSIFICATION, ASSISTANT_ROLE)) {
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
    // ── FROM HERE, EVERYTHING THIS TURN SAYS IS SAID AS THAT ASSISTANT (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b) ──────────────────
    //
    // The router is the routing authority, so it records this decision under an id of its own and asks
    // the vend for the session it allows. Every conversation call after this - the placeholder, a
    // refusal, a handover, the queue notice - goes out on that session, which can act only as this bot.
    // The router's own role can no longer post or edit as any bot, so a turn that cannot get the
    // session cannot speak as anyone; it fails here rather than later.
    // A SPEAK ROUTE: the router posts as the assistant and nothing more, so it never holds a turn's session
    // (the speak edge carries the conversation read the boundary check makes). A refusal here is a broken or
    // missing assistant, named to the person and reported, never answered as somebody else.
    try {
      await speakAsRoutedAssistant(
        { routeId: `${SPEAK_ROUTE_PREFIX}router-${randomUUID()}`, botArn, classification: STATIC_CLASSIFICATION, tableName: TURN_ROUTING_TABLE, ...(channelArn ? { channelArn } : {}) },
        { ddb: routingDdb },
      );
    } catch (err) {
      console.error('[Router][SecurityEvent] the vend refused the routed assistant; the turn does not start', {
        botArn, channelArn, message: (err as Error)?.message,
      });
      await reportTurnNotStarted({ event, channelArn, botArn, why: `the vend refused the assistant's session (${(err as Error)?.message})`, notice: true });
      return formatLexSilentResponse(event);
    }
    const channelClassification = channelArn
      ? await resolveChannelClassification(channelArn, botArn)
      // NO CHANNEL MEANS NO ROOM TO CLASSIFY, so the turn runs at this handler's own classification.
      // It used to answer the deployment's floor, which on a ladder was the safest guess and between
      // peers is just a different classification's name.
      : STATIC_CLASSIFICATION;
    // THE DECISIVE POINT, AND IT IS DELIBERATELY BEFORE EVERYTHING EXPENSIVE. This sits ahead of
    // intent classification, processor resolution, drift and dispatch, so a refused turn writes no
    // drift row, archives nothing at this assistant's classification, and invokes no processor
    // (ADR-045 decision 1). It is also the only check a flow-entry turn passes through, which is why
    // `resolveChannelClassification` now performs a channel read rather than answering from a
    // constant.
    if (channelArn && channelReadWasRefused(channelArn)) {
      return refuseAtClassificationBoundary(event, channelArn, 'channel-classification:first-read');
    }
    // A CLASSIFICATION THIS DEPLOYMENT DOES NOT DECLARE IS REFUSED HERE, never carried on as some declared
    // one. Every reader below takes the turn's classification as a declared value (a string the registry
    // knows), so this is the one place an undeclared value can be stopped, and it is stopped before any
    // model, drift or dispatch work.
    if (!profiles.isConversational(channelClassification)) {
      console.error('[Router][SecurityEvent] the turn\'s classification is not a conversational classification this deployment declares', {
        channelArn, classification: channelClassification,
      });
      return channelArn
        ? refuseAtClassificationBoundary(event, channelArn, 'channel-classification:undeclared')
        : formatLexSilentResponse(event);
    }
    // The conversation is known. Everything above this is Amazon Chime SDK and DynamoDB reads, and it
    // is the first part of the path that leaves the Lambda at all.
    markRouterStep('channel_resolved');

    // ── THIS TURN CAN NOW SAY WHO IT IS ──────────────────────────────────────────────────────────
    //
    // The identity is validated (`spoke.botArn`) and the room is classified, which is everything a
    // message this turn posts needs in order to be attributable. Declared HERE, once, rather than at
    // each send: a send holds an ARN, and recovering an assistant's name from an ARN is precisely the
    // inference `kinesis-archival` removed for landing "unknown rows that looked like a measurement".
    //
    // The VERSION is deliberately not resolved here. It costs a read this point does not otherwise
    // need, and the acknowledgment these fields travel on is a placeholder the ANSWER overwrites -
    // and the answer declares version and configId itself (`async-processor-core`), which the
    // exchange folds. These fields say WHICH ASSISTANT and WHICH ROLE.
    //
    // ── THE TURN'S ASSISTANT PROFILE, RESOLVED ONCE ─────────────────────────────────────────────
    //
    // A profile belongs to an assistant, and a classification can have several (`premium` has
    // `advisor` and `ops-premium`). Every per-assistant setting this turn reads comes from this one
    // value: the attribution below, the onboarding intake (both call sites), the classifier mode and
    // model, the rate limit, and the copy the assistant speaks in its own voice. One resolution, so
    // no two of them can describe different assistants.
    //
    // The assistant is the one behind the bot this invocation was addressed as (`assistantByBotArn`, from
    // the assignment records). An alt runs on its own profile (`alt-{role}-{classification}`,
    // ADR-050), and a runtime assistant on the seed its record produces (ADR-048). A turn whose assistant cannot be named - no classification, a record
    // naming an undeclared assistant, unreadable records in a classification that has several, or a
    // bot with no record that is not the classification's own - is DECLINED here with no reply, never
    // answered on another assistant's settings (tenet P4, ADR-046).
    //
    // The index is loaded here and not only on a Lex turn: a turn the channel flow hands over (an
    // `@ops-premium` mention) carries no Lex bot id, only the bot it answers as.
    // A HANDLER WITH NO CLASSIFICATION OF ITS OWN DECLINES. Every deployed router carries one; the
    // channel's tag is not a substitute for the classification this handler was deployed to serve.
    const turnAssignment = await assistantOfBot(botArn, STATIC_CLASSIFICATION ? channelClassification : '', classificationBotArn);
    if (turnAssignment.decision === 'decline') {
      logAssistantDecline('[Router]', turnAssignment.reason, {
        classification: STATIC_CLASSIFICATION || undefined,
        asBot: botIdFromArn(botArn),
        assignedAssistant: assistantByBotArn.get(botArn),
        ...(channelArn ? { channelArn } : {}),
      });
      await reportTurnNotStarted({ event, channelArn, botArn, why: `the assistant could not be named (${turnAssignment.reason})`, notice: true });
      return formatLexSilentResponse(event);
    }
    const turnProfile = turnAssignment.profile;
    // THE TURN'S WORDS, RESOLVED ONCE (ADR-062): the assistant's served version and its message template set are read the
    // first time a line of this turn needs them, and every later line of the turn reads the same set. A read that fails is
    // not kept, so the next line asks again.
    let turnWordsRead: ReturnType<typeof wordsOf> | undefined;
    const turnWords = (): ReturnType<typeof wordsOf> => (turnWordsRead ??= wordsOf(turnProfile.name).catch((err) => { turnWordsRead = undefined; throw err; }));
    const turnRole = (turnAssignment.source === 'assigned' && roleByBotArn.get(botArn)) || ASSISTANT_ROLE;
    /** The turn's assistant, for the welcome: the same resolution the answer uses. */
    const turnAssistant = turnProfile.name;
    spoke.attribution = {
      agentType: turnProfile.name,
      ...(turnRole && { assistantRole: turnRole }),
      ...(turnProfile === runtimeSeedByBotArn.get(botArn) && { runtimeClassification: STATIC_CLASSIFICATION }),
      classification: channelClassification,
    };

    // Defense in depth: never trust channel metadata alone. Pull the sender's
    // real clearance from Cognito group membership and use the minimum of the two.
    // If someone was added to a premium channel they don't have the clearance for,
    // they get downgraded (not errored) and we log a security event.
    const personId = extractUserSub(event);

    // WelcomeIntent fires when the assistant/user is ADDED to the channel — a
    // Chime SYSTEM event with no CHIME.sender.arn, so `personId` is empty here.
    // Gather the greeting's context from channel metadata instead
    // (auth-agent-handler.loadProfileFromChannelMetadata does the same — a system
    // WelcomeIntent has no sender, so context lives in metadata). The creator's
    // person id is encoded in `createdBy` (…/user/<personId>) that create-conversation
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
      // THE STORE FIRST, METADATA AS THE FALLBACK - the same order as `triggerContext` above, and for
      // the same reason the comment above gives: this intent fires at creation, when Metadata is
      // eventually consistent. Reading Metadata alone made a topic-seeded welcome lose its grounding
      // intermittently. The fallback leg still serves channels created before the store carried it.
      const topic = driftCtx?.topic
        || (typeof channelMeta.topic === 'string' ? channelMeta.topic : undefined);

      // THE WELCOME IS COMPOSED FIRST, AND AN INTAKE ADDS TO IT RATHER THAN REPLACING IT.
      //
      // This composition used to sit BELOW the intake branch, which returned before reaching it. So
      // any deployment that configured an intake silently lost its orientation copy - the access
      // line, the example prompts, the platform note - and opened on a bare question instead. That is
      // what made a premium conversation open with a report-preference question and nothing else, and
      // it would have taken basic down the same way the moment an intake was configured there.
      //
      // Composed unconditionally now: the intake uses it as its opening line, and a conversation with
      // no intake renders exactly what it rendered before.
      // THE ADDRESSED ASSISTANT'S OWN WELCOME, falling back to the classification's configured copy.
      // Two assistants in one classification introduced themselves identically before this.
      const welcomeTypeKey = driftCtx?.conversationType;
      const loaded = await loadWelcomeFor(
        turnAssistant,
        channelClassification,
        welcomeTypeKey,
        channelArn,
      );
      // ONE assembled orientation. The deployment's configured copy and the reason this conversation
      // exists are both orientation sources, merged rather than raced: before this, a channel carrying a
      // topic short-circuited past the company name and example prompts entirely.
      const welcomeOrientation: WelcomeOrientation = {
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
              // THE CHANNEL ID, matching `channel-creation.ts` and the client's own `?conversation=`
              // convention (`ChannelArn.split('/').pop()`). A full ARN here resolves to nothing and
              // the link silently does not navigate.
              parentRef: `?${conversationRef(channelMeta.parentChannelArn.split('/').pop() || channelMeta.parentChannelArn)}`
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
        // The line the event wrote, for a type whose template names it. Carried by
        // `channel-creation.ts` beside the grounding copy, and rendered only on request.
        ...(driftCtx?.eventSummary ? { eventSummary: driftCtx.eventSummary } : {}),
        // A carried-over visit's opening line (FR26), which the creator of a claimed or bound conversation
        // wrote beside the seed. Store only, like `priorMessage`: it was never on Metadata.
        ...(driftCtx?.visitSummary ? { visitSummary: driftCtx.visitSummary } : {}),
      };

      // ── A TYPE MAY DECLARE WHAT EACH ROLE SAYS, AND THAT IS WHERE THE DUPLICATE IS FIXED ──────────
      //
      // Two assistants in one room both render the same clause assembly, because that assembly answers
      // "introduce an assistant in a room" and the room is the same for both. Measured twice on the
      // deployment: the ops conversation opened with the identical sentence from each assistant, the
      // second time after the orientation-inheritance gate shipped - which is how it was established
      // that the duplicate belongs to the room's copy rather than to the assistant's.
      //
      // So the TYPE carries the per-role copy (`templateByRole`) and the role comes from the assistant this
      // invocation was addressed as. No role branch lives in the composer: the selection happens here
      // and the renderer is handed one template. A type that declares none, or a role with no entry,
      // falls through to `composeWelcome` unchanged - which is every conversation on a deployment that
      // configures nothing.
      // The assistant's role, gated exactly as the turn's attribution is (`turnRole`): one resolution.
      const welcomeRole = turnRole;
      const roleTemplate = loaded.template;
      // A TEMPLATE REPLACES WHAT IS SAID, NOT WHAT THE WELCOME IS. `variant`,
      // `usedGenericFallback` and the rest are read downstream for logging and for the intake
      // decision, and they describe the composition rather than the copy - so the assembly still
      // produces them and only `content` is overridden. `composeOpening` is also what the console's
      // preview renders, so the preview and this post are one function.
      // A TEMPLATE NAMES ITS VERSION'S VARIABLES TOO (ADR-060, slice 1c), read through the served version.
      const opening = composeOpening(roleTemplate, welcomeOrientation, { role: welcomeRole },
        routerVariables(loaded.served?.version.variables, { conversationType: welcomeTypeKey }));
      const assembledWelcome = opening.composition;
      const renderedTemplate = opening.rendered;
      if (renderedTemplate) {
        console.log('[Router][WelcomeIntent] the assistant\'s own welcome template rendered', {
          assistant: turnAssistant,
          conversationType: welcomeTypeKey,
          role: welcomeRole,
          contributed: renderedTemplate.contributed,
          missing: renderedTemplate.missing,
          // AN EMPTY RENDER FALLS BACK, and says so. Every line of a template can be dropped when the
          // room carries none of the fields it names, and posting nothing would read as the assistant
          // having failed rather than as having nothing to add.
          usedTemplate: opening.usedTemplate,
        });
      }
      const welcome = { ...assembledWelcome, content: opening.content };

      // ── WHO WELCOMES THE PEOPLE THIS ROOM WAS OPENED FOR (ADR-061 decision 5) ─────────────────────────────────
      //
      // Read from configuration, never from which of the join and the creator's naming finished first. Where a
      // `conversation-opened` run owns the room and its lead, the join posts nothing and starts no intake. Where a
      // `person-joined` run owns every admitted person's welcome, the join greets the room and addresses nobody: no
      // intake, and no `subject` greeting, so each person is welcomed once (`arrivalWelcomeOwner`).
      const arrivals = arrivalWelcomeOwner({ conversationType: welcomeTypeKey, own: loaded.served?.version.eventWorkflows });
      if (channelArn && arrivals === 'conversation-opened') return formatLexNothingToPost(event);

      // Onboarding welcome (opt-in): when a deployment supplies an intake schema,
      // the welcome is the richer context-gathering flow instead of the static
      // greeting. Show the greeting + the first field's question and store the
      // intake state on the channel context row, naming the person it belongs to;
      // their answers drive the FSM on the following turns (see the intake
      // interception below). Inert (config is
      // null) unless ONBOARDING_INTAKE / ONBOARDING_INTAKE_PARAM is set.
      const loadedIntake = await intakeForAssistant(turnProfile.name, channelClassification);
      // ── CHECKED BEFORE ASKED (owner rule 2026-09-03; "cheap" chosen 2026-09-14) ─────────────────
      //
      // Drop every field the deployment already asserts, so an intake asks only for what is genuinely
      // unknown. When nothing is left, `intakeAfterChecking` returns null and this whole branch is
      // skipped - the conversation opens normally with no questions at all.
      //
      // CHEAP, AND THAT IS THE DECISION RATHER THAN AN OVERSIGHT. Only what this turn already holds:
      // whether a persona is configured, the classification already resolved above, and the stored
      // facts the once-per-user gate reads anyway. A thorough check would also consult company docs,
      // which costs a tool call BEFORE the first reply - and the rule exists precisely so an intake
      // never sits in front of a question somebody is waiting on.
      //
      // THE OTHER HALF OF THE RULE ALREADY HOLDS HERE: this is `WelcomeIntent`, so an intake that does
      // run runs at conversation OPEN, not in front of a real question.
      //
      // The persona is the ACTIVE VERSION's, the same source the processor reads first, resolved only
      // when a field asserts by persona. The environment seam alone never matched here: the stacks set
      // the persona parameter on the processor, not on this handler. A persona held only in that
      // parameter is still not visible here, and the field is then ASKED - the annoying direction.
      //
      // The ASSISTANT's version, the same assistant the intake came from. The environment persona is the
      // classification's, so it counts only for the classification's primary (`deploymentCopyAppliesTo`).
      const intakeFacts: KnownFacts = {
        hasPersona: loadedIntake?.fields.some((f) => f.assertedBy?.includes('persona'))
          ? (deploymentCopyAppliesTo(turnProfile.name, profiles.profileFor(channelClassification)?.name)
            && Boolean(process.env.ASSISTANT_SYSTEM_PROMPT?.trim()))
            || await resolveActiveProfile(turnProfile.name, { ssm: ssmClient, ssmRoot: SSM_ROOT })
              .then((a) => Boolean(a?.persona?.trim())).catch(() => false)
          : false,
        classification: channelClassification,
      };
      // The profile half is applied after the gate below, from the read the gate makes.
      const intakeConfig = intakeAfterChecking(loadedIntake, intakeFacts);
      if (loadedIntake && !intakeConfig) {
        console.log('[Router][WelcomeIntent] every intake field is already asserted; asking nothing', {
          fields: loadedIntake.fields.map((f) => f.key),
        });
      }
      // A WELCOME THAT RUNS OWNS THE INTAKE (ADR-061 decision 2, W1): its author decides whether a `start_intake` step
      // follows the greeting, replaces it or is left out, so the join starts none of its own and the welcome runs below. A
      // drift-spawned room keeps the opening that answers the question it was spawned for, and its intake.
      const workflowOwnsIntake = !driftCtx?.priorMessage && loaded.plan.runs;
      if (isOnboardingEnabled(intakeConfig) && arrivals === 'person-joined') {
        console.log('[Router][WelcomeIntent] a person-joined run welcomes the people this room was opened for; no intake starts here');
      } else if (isOnboardingEnabled(intakeConfig) && workflowOwnsIntake) {
        console.log('[Router][WelcomeIntent] the workflow welcome offers the intake as its own step, where its author put one');
      } else if (isOnboardingEnabled(intakeConfig)) {
        // Once-per-user (SPEC-USER-PROFILE-AND-ONBOARDING §2/§3). Onboarding needs ONE person to key on, so
        // it applies to the `single` shape only: a group has no single subject whose profile the gate could
        // read, and a conversation with no humans yet (alert-initiated) has nobody to onboard. Neither is a
        // failure, so neither falls open to asking questions of a group.
        const { ctx: participants, source } = await resolveParticipants(channelArn, botArn);
        console.log('[Router][WelcomeIntent] participants', {
          focus: participants.focus, humans: participants.humans.length, source,
        });

        const gate = onboardingApplies(participants)
          ? await onboardingStatus(participants.subject)
          : null;
        // `toAsk` is THE intake for this conversation. `startIntake` pins its keys on the row, and every
        // answer turn runs exactly that list (`intakeAsStarted`), so the two paths cannot disagree.
        const toAsk = gate && !gate.onboarded
          ? intakeAfterChecking(intakeConfig, { ...intakeFacts, profileFacts: gate.facts, profilePreferences: gate.preferences })
          : null;
        if (!gate) {
          console.log('[Router][WelcomeIntent] onboarding does not apply to this shape; skipping intake', {
            focus: participants.focus,
          });
        } else if (gate.onboarded) {
          console.log('[Router][WelcomeIntent] participant already onboarded; skipping intake');
        } else if (!toAsk) {
          console.log('[Router][WelcomeIntent] the stored profile answers every remaining field; asking nothing');
        } else {
          // The ORIENTATION WELCOME is the opening line, so the intake adds its question to what the
          // conversation would have said anyway rather than standing in place of it.
          const step = startIntake({ ...toAsk, words: await turnWords() }, welcome.content);
          // THE QUESTION IS ASKED ONLY IF THE INTAKE WAS RECORDED. The answers are intercepted from the
          // stored row, so a question sent without one is a question whose answer nothing reads: the
          // person replies, the working assistant answers instead, and they are never onboarded. A failed
          // write falls through to the ordinary welcome, and the next conversation offers the intake again.
          const recorded = await putChannelContext(channelArn, {
            onboardingIntake: { ...step.state, subject: participants.subject },
          });
          if (recorded) {
            console.log('[Router][WelcomeIntent] onboarding intake started', { fields: toAsk.fields.length });
            return formatLexResponse(event, [{ contentType: 'PlainText', content: step.reply }]);
          }
          console.warn('[Router][WelcomeIntent] the intake could not be recorded; using the ordinary welcome');
        }
      }


      // A single absent field only omits its own piece of copy — it never falls back to the generic
      // greeting and never discards the fields that ARE configured. What it does do is get recorded,
      // because degraded copy is the only symptom this failure has.
      // Where the assistant's own template rendered, the template is the copy, and the assembly's shortfalls are not.
      for (const defect of welcomeConfigDefects({
        classification: channelClassification,
        param: WELCOME_PARAM,
        loaded,
        usedTemplate: opening.usedTemplate,
        composition: assembledWelcome,
      })) recordWelcomeConfigDefect(defect);

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
          // The drift-spawned welcome declares its kind for the same reason the ordinary one does: it
          // opens a conversation rather than answering a message. It keeps its correlation marker,
          // which is a different claim - that marker is how the worker finds this placeholder.
          // `assistant` for the same reason `kind` is here: this is a Lex-entry return with no
          // metadata channel, and it carries a correlation marker so the ledger counts it as a turn.
          // Without the declaration it counts as a turn by an unknown assistant.
          // AND ITS ENTRY, on both carriers: the welcome came through this router's own door and its turn answers
          // the spawning question, so it records that door like any turn a message started.
          const welcomeEntry = isFlowEntry(event) ? 'flow' as const : 'lex' as const;
          const withMarker = withTurnDeclaration(
            `${welcome.content}\n\n<!--corr:${welcomeCorrelationId}-->`,
            {
              kind: 'welcome',
              entry: welcomeEntry,
              ...(spoke.attribution?.agentType && { assistant: spoke.attribution.agentType }),
            },
          );
          await invokeAsync(welcomeProcessorArn, {
            channelArn,
            correlationId: welcomeCorrelationId,
            userMessage: driftCtx.priorMessage,
            classification: channelClassification,
            botArn,
            entry: welcomeEntry,
            // Keep the welcome above the answer.
            messagePrefix: welcome.content,
          });
          // ── THIS TURN'S PLACEHOLDER HAS NO MAPPING, AND CANNOT (measured 2026-09-22) ───────────
          //
          // Every other path writes `corr# -> MessageId` before the worker needs it: a bypass claims
          // it at the send (`postAsAssistant`), and the flow claims it as the message crosses. This
          // one can do neither. The content is RETURNED for Amazon Chime SDK to materialize, so the
          // router never sees a MessageId to record, and the message is standard - the assistants
          // carry `StandardMessages: NONE`, so nothing invokes the flow to claim it either.
          //
          // So the worker finds no mapping and falls to `scanForPlaceholderMessage`, which finds it:
          // the message genuinely exists. Measured over three days, this was every drift-spawned
          // welcome, four of them, all resolving `resolved: true`.
          //
          // THAT IS THE DESIGN, NOT A GAP. Posting it here instead and claiming at the send is the
          // obvious alternative and is BLOCKED: Chime materializes a message even from an empty
          // `messages` array (ADR-025, verified live), so returning silence would leave a stray
          // envelope beside the welcome. One billed `ListChannelMessages` per drift-spawned
          // conversation is the honest price of that, and it is paid once per NEW conversation
          // rather than per turn.
          console.log('[Router][WelcomeIntent] answering the spawning question in place', {
            correlationId: welcomeCorrelationId,
          });
          return formatLexResponse(event, [{ contentType: 'PlainText', content: withMarker }]);
        }
        console.warn('[Router][WelcomeIntent] no async processor resolved; the spawning question '
          + 'stays quoted but unanswered');
      }

      // ── THE WELCOME IS THE WORKFLOW `WelcomeIntent` STARTS (W1, ADR-061) ──────────────────────────────────────
      //
      // What the room's type selected (`loadWelcomeFor`) decides how it is said, read from the profile read that
      // composed the opening, so the check is synchronous. A welcome that RUNS (its opening followed by sends, an intake
      // step or an agent step) posts each step itself, the opening composed above among them, and the intent posts
      // nothing, so the room is greeted once. A welcome said by this reply is the opening returned below, with its one
      // PROMPT turn dispatched behind it (SPEC-WELCOME-AND-CONTEXT FR24): the opening is the welcome whatever happens
      // next (FR2), and the prompt turn's one added wait is the dispatch, an asynchronous invoke; the meter, the roster
      // and the template are the processor's, after it. Only the conversation's plain welcome dispatches it: a
      // drift-spawned welcome already answers its question, and an intake asks one, so either would put a second
      // responder in the room.
      const promptValues: Record<string, string> = {
        ...(welcomeOrientation.topic ? { topic: welcomeOrientation.topic } : {}),
        ...(welcomeOrientation.eventSummary ? { event: welcomeOrientation.eventSummary } : {}),
        ...(welcomeRole ? { role: welcomeRole } : {}),
      };
      if (channelArn && loaded.plan.runs) {
        const { ctx: participants } = await resolveParticipants(channelArn, botArn).catch(() => ({ ctx: { subject: '' } as { subject: string } }));
        await runWorkflowFor(loaded.welcome.name, loaded.welcome.workflow, {
          event: 'assistant-joined',
          channelArn,
          // A `person-joined` run owns the subject's welcome here, so the join's `subject` steps address nobody.
          subject: participants.subject && arrivals !== 'person-joined' ? userArnFor(channelArn.split('/channel/')[0], participants.subject) : undefined,
          values: {
            ...(welcomeOrientation.topic ? { topic: welcomeOrientation.topic } : {}),
            ...(welcomeRole ? { role: welcomeRole } : {}),
          },
        }, {
          botArn, assistant: turnAssistant, variantProfile: loaded.served?.variantProfile, variables: loaded.served?.version.variables,
          welcome: { opening: welcome.content, promptValues },
        }, { ...(welcomeTypeKey ? { conversationType: welcomeTypeKey } : {}), participants: participants as ParticipantContext });
        return formatLexNothingToPost(event);
      }
      if (channelArn && loaded.plan.prompt) {
        await dispatchWelcomePrompt({
          channelArn,
          botArn,
          request: { template: loaded.plan.prompt.template, tools: loaded.plan.prompt.tools ?? [], values: promptValues },
        });
      }
      // A WELCOME ANSWERS NOTHING, AND NOW SAYS SO. It fires on the assistant's
      // membership at channel creation, so nobody sent anything to provoke it. Undeclared it fell into
      // the "answer" bucket - which means "declared nothing", not "is an answer" - and got paired to
      // whatever message happened to precede it, contributing a reply time measured from nothing.
      //
      // DECLARED IN CONTENT because this message is RETURNED for Amazon Chime SDK to materialize, so
      // there is no Metadata this handler controls. The marker is stripped before display by the same
      // parser that strips every other one.
      return formatLexResponse(event, [{ contentType: 'PlainText', content: withTurnDeclaration(welcome.content, { kind: 'welcome' }) }]);
    }

    // A PERSON OF ANOTHER ISSUER holds no clearance group in any directory this deployment reads, and
    // `resolveUserClearance` says so (`fromIssuer: false`) rather than answering a lookup failure. Their
    // reach is the conversation they were provisioned into, and IAM already decided they may send in it
    // (see below), so the channel's classification IS authoritative for them. Nothing here reads the
    // person's id: which issuer a person signs in through lives only in `Identities`.
    const senderPersonArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
    const resolvedClearance = await resolveUserClearance(senderPersonArn);
    const scopedByIssuer = !resolvedClearance.fromIssuer;
    const { clearance: userClearance, isAdmin: isExemptAdmin } = scopedByIssuer
      ? { clearance: channelClassification, isAdmin: false } // a person of another issuer is never abuse-exempt
      : resolvedClearance;
    // ONE CHANNEL, ONE CLASSIFICATION, AND IAM IS WHAT DECIDES IT (maintainer, 2026-08-31).
    //
    // This was `minRank(channelClassification, userClearance)`: a per-person cap applied in
    // application code. Two members of the SAME conversation could therefore be answered at
    // different classifications - different model, different context scope - which is not a
    // property a conversation can coherently have, and nothing in the room would explain it.
    //
    // The cap also decided nothing that IAM had not already decided. The channel-scoped Allow
    // (`classificationChannelScopedAllow`) is applied to the per-classification COGNITO USER roles
    // as well as the assistant roles, and it is fail-closed: a basic-cleared identity has no grant
    // on a premium-tagged channel and cannot send into it at all. So a message ARRIVING here is
    // itself proof that IAM permitted this person to act on this channel, at this classification.
    // The only reachable disagreement was the harmless direction - a higher-cleared person in a
    // lower channel - where the min already returned the channel value.
    //
    // AND IT DOWNGRADED ON AN OUTAGE. `resolveUserClearance` answers `basic` for ANY failure, and
    // for an unset pool id. So a Cognito throttle during a turn in a premium conversation quietly
    // routed it to the BASIC processor: a worse model and a narrower context, in a channel IAM was
    // perfectly willing to serve at premium, with nothing said to anybody. A transient fault
    // presenting as a policy decision is exactly the confusion invariant E exists to stop.
    const effectiveClassification = channelClassification;

    // STILL REPORTED, and it means something stronger now. This is no longer the routine downgrade
    // it was when the cap existed: IAM should have refused this person this channel, so a mismatch
    // is either a tagging gap or a clearance lookup that failed, and both want a person.
    // ── THE ANOMALY IS REACH, NOT EQUALITY ──────────────────────────────────────────────────────
    //
    // This warned whenever the two values DIFFERED, which was only the right question while a holder's
    // reach was "own rank and below" and the two could be compared as one ladder. A holder carries a
    // token naming a SET now, so difference is the ordinary case: a premium holder in a basic room
    // holds `premium` and the room is `basic`, and nothing is wrong. Warning on that logs a
    // SecurityEvent for normal traffic, which is how a real one stops being noticed.
    //
    // What is genuinely anomalous is a sender whose reach does NOT include this channel: IAM should
    // have refused them the send, so either the channel tag is missing or the clearance lookup failed.
    // That is the condition worth a person's attention, and it is the one this now reports.
    // AN UNRESOLVED CLEARANCE REACHES NOTHING, so the check below fires - which is the point. It
    // used to be impossible to get here without a clearance because the floor was always returned;
    // now "we could not establish who this is" is distinguishable from "they are basic", and only the
    // first is worth a person's attention.
    const senderReach = profiles.reachOf({ token: userClearance, adminPlane: !scopedByIssuer && resolvedClearance.adminPlane === true });
    if (!scopedByIssuer && !senderReach.includes(channelClassification)) {
      console.warn('[Router][SecurityEvent] sender does not reach this channel classification', {
        personId,
        channelArn,
        channelClassification,
        userClearance,
        senderReach,
        effectiveClassification,
      });
    }
    // A SENDER WHOSE ISSUER DECIDES ONLY FROM A TOKEN is read through what the exchange recorded it decided at
    // their last sign-in (C3). EVIDENCE, FLAGGED AND NEVER APPLIED: the turn is still answered at the channel's
    // classification, which IAM decided they may send in. A record that does not reach this channel, or is
    // older than its issuer allows, is worth a person's attention.
    for (const e of scopedByIssuer ? resolvedClearance.lastSignIn ?? [] : []) {
      if (!e.stale && profiles.grantsFor(e.classification).includes(channelClassification)) continue;
      console.warn(`[Router][SecurityEvent] the sender's recorded clearance decision ${e.stale ? 'is stale' : 'does not reach this channel classification'}`, {
        personId, channelArn, channelClassification, issuer: e.issuer, recorded: e.classification, recordedAt: e.at, stale: e.stale,
      });
    }

    const asyncProcessorArn = await resolveAsyncProcessorArn(effectiveClassification);
    // Does the ADDRESSED assistant's profile use the LLM intent classifier? A deployment-time field,
    // read from the turn's assistant profile: `ops-premium` is keyword-classified while `advisor`, in the same
    // classification, is not. True for every shipped primary (basic included, a deliberate change from
    // the legacy keyword path); a deployment can set classifierMode:'keyword' on a cheap profile.
    const usesLlmClassifier = turnProfile.classifierMode === 'llm';

    console.log('[Router] Resolved', {
      effectiveClassification,
      channelClassification,
      userClearance,
      asyncProcessorArn: asyncProcessorArn.split(':').pop(),
    });

    // Cap length HERE, at the entry, before it drives any expensive work: the intent classifier
    // (an LLM call) and drift detection (an embedding call) both run on this string, so a pathologically
    // long message would otherwise pay full classifier + embedding cost before the processor's own cap.
    // MAX_USER_MESSAGE_LENGTH (0/unset ⇒ off) rides abuse.env onto this handler.
    let userMessage = capUserMessage(decodeURIComponent(event.inputTranscript || '').trim());

    // ── A HANDED-OVER TURN STARTS ONLY FROM A REAL HANDOVER MESSAGE ──────────────────────────────
    //
    // The payload says "handover"; the conversation has to agree. The handover message is read back as
    // this turn's own bearer and verified (`verifyHandover`), and anything that does not verify ends here
    // with no reply. This is what closes the old shape, where any caller able to invoke this handler could
    // start another assistant's turn by naming that assistant in a payload.
    if (arrivedByHandover(event)) {
      const handoverMessageId = event.requestAttributes?.[BYPASS_HANDOVER_MESSAGE_ATTR] || '';
      const personMessageId = event.requestAttributes?.[BYPASS_MESSAGE_ID_ATTR] || '';
      const verified = handoverMessageId && personMessageId && channelArn
        ? await verifyHandover({ channelArn, handoverMessageId, personMessageId, selfBotArn: botArn, classificationBotArn })
        : null;
      if (!verified) {
        if (!handoverMessageId) {
          console.error('[Router][SecurityEvent] a handed-over turn arrived without a handover message; refusing', {
            channelArn, asBot: botIdFromArn(botArn),
          });
        }
        return formatLexSilentResponse(event);
      }
      // The sender is what the verified message says, never what the payload claimed.
      event.requestAttributes = {
        ...(event.requestAttributes || {}),
        ...(verified.marker.kind === 'task' ? { [BYPASS_HANDOVER_ATTR]: verified.fromAssistantId } : {}),
        ...(verified.marker.intent ? { [BYPASS_HANDED_INTENT_ATTR]: verified.marker.intent } : {}),
      };
      // A TASK HANDOVER CARRIES THE PERSON'S WORDS, because their answer may have been private to the
      // assistant that handed it over (`handoverContent`). Read from the verified message, not the payload.
      if (!userMessage && verified.marker.kind === 'task') {
        userMessage = capUserMessage(handoverCarriedText(verified.content));
      }
    }

    // ── A JOIN RECAP IS THE ROOM'S PRIMARY, PRIVATELY, TO A PERSON WHO IS IN THE ROOM ─────────────
    //
    // Checked against the conversation before anything is spent (`joinRecapRefusal`); a refusal ends the
    // turn with no reply. Then the turn is made what it is: targeted at the new member whatever the
    // payload declared, and answering this assistant's own request for a recap (`joinRecapRequest`),
    // so the words the model is asked come from the assistant's copy and never from the caller.
    if (isJoinRecap(event)) {
      const refusal = await joinRecapRefusal(event, channelArn, botArn);
      if (refusal) {
        console.error('[Router][SecurityEvent] refused a join recap', {
          reason: refusal, channelArn, asBot: botIdFromArn(botArn),
        });
        return formatLexSilentResponse(event);
      }
      event.requestAttributes = { ...(event.requestAttributes || {}), [BYPASS_TARGETED_ATTR]: '1' };
      const recapVersion = await resolveActiveProfile(turnProfile.name, { ssm: ssmClient, ssmRoot: SSM_ROOT }).catch(() => undefined);
      userMessage = capUserMessage(await joinRecapRequestFor({
        classification: STATIC_CLASSIFICATION, assistant: turnProfile.name, messages: recapVersion?.messages,
      }));
    }

    // ── A HANDED-OVER TURN RESOLVES THE MESSAGE ITSELF ────────────────────────────────────────────
    //
    // A roommate handover carries a REFERENCE and not the text, so the transcript is empty here. The
    // whole point of the reference is that the receiver reads the conversation with ITS OWN permissions:
    // the boundary is what this assistant may read, not the sending assistant's judgment about what is
    // safe to repeat, and nothing is republished because nothing was copied.
    //
    // WITHOUT THIS THE DESIGN IS ONLY AN INTENTION. Measured: the specialist answered "it looks like your
    // message came through empty" - it had been handed a question and no way to see it. An earlier turn
    // appeared to work only because the same question was already in the conversation history, which is
    // luck rather than a mechanism.
    //
    // FAILS TOWARD THE EMPTY TRANSCRIPT rather than throwing: a read this assistant is not entitled to
    // make is the boundary working, and the turn then behaves as it does for any message it cannot see.
    if (!userMessage && channelArn) {
      const referencedId = event.requestAttributes?.[BYPASS_MESSAGE_ID_ATTR];
      if (referencedId) {
        userMessage = capUserMessage(await readMessageText(channelArn, referencedId, botArn));
        console.log('[Router] resolved the handed-over message by reference', {
          referencedId, resolved: userMessage.length > 0,
        });
      }
    }

    // ── A HANDOVER THIS ASSISTANT CANNOT COMPLETE IS SAID OUT LOUD, BY THIS ASSISTANT ─────────────
    //
    // THE WINDOW THIS CLOSES. The sender answered "I have passed it along, and their reply will follow
    // here" and returned - before the turn claim, before any placeholder - and the dispatch is a
    // fire-and-forget invoke. So if the reference cannot be resolved here, the person has been promised a
    // reply by one assistant and nothing arrives from the other. That is worse than the silence it
    // replaced, because a promise was made: the room shows a handover that looks successful and a question
    // that is never answered again.
    //
    // IT SPEAKS AS ITSELF rather than failing the turn, which is tenet D5: a dependency that fails degrades
    // to a helpful response instead of silence. Failing would be no better than the gap - an async invoke's
    // exception is retried and then dropped, with nobody in the room told either time.
    //
    // IT ASKS FOR THE QUESTION AGAIN rather than explaining a reference it could not read. The person does
    // not know a reference was involved and does not need to; what they need is the one action that gets
    // them an answer. The log carries the diagnosis.
    //
    // REACHED ONLY WHEN THE TRANSCRIPT IS GENUINELY EMPTY, so an ordinary turn cannot land here: a direct
    // Lex turn always carries its text, and a handover that resolved its reference has it by now.
    if (!userMessage && arrivedByHandover(event)) {
      console.error('[Router] a handed-over turn could not resolve the message it was given; telling the '
        + 'person rather than going quiet', {
        channelArn,
        referencedId: event.requestAttributes?.[BYPASS_MESSAGE_ID_ATTR] || '(none)',
        asBot: botIdFromArn(botArn),
      });
      return formatLexResponse(event, [{
        contentType: 'PlainText',
        content: templateLine('handover-unresolved', await turnWords()),
      }]);
    }

    /**
     * THE TEXT AS IT WAS SENT, kept because one thing downstream matches on it CHARACTER FOR
     * CHARACTER.
     *
     * Chime hands Lex no message id (measured), so `findInboundMessage` locates the inbound message
     * by comparing stored content against this string. Stripping the private address out of
     * `userMessage` - which is right for the MODEL, since the address is not part of the question -
     * silently broke that comparison for every `.member` message: the lookup missed, so the turn
     * declared no `answers=`, and `inboundTaskFields` lost `visibility`. The task then reads as private
     * (absent fails closed), so every shared request whose lookup missed would lose its visibility too.
     *
     * So the model gets the question and the lookup gets the message. They are different strings on
     * purpose.
     *
     */
    const inboundText = userMessage;

    // THE PRIVATE ADDRESS IS NOT PART OF THE REQUEST (ADR-034). ".assistant draft me a reply" asks
    // for a draft; handing the model its own name as the first word makes the address part of the
    // question it answers, which is the same reason an `@` token is stripped before dispatch.
    //
    // RESOLVED FROM THE ROSTER, NOT FROM THE SHAPE OF THE TEXT. The token is stripped only when it
    // names a member of this conversation in full - so ".env is missing" reaches the model exactly as
    // written, because it is a sentence about a file and not an address.
    //
    // Gated on a cheap anchored test, so an ordinary message pays no membership read to answer a
    // question its first character settles.
    if (mightAddressPrivately(userMessage)) {
      const size = await resolveChannelSize(chimeClient, channelArn, await getBotArn());
      // The `.`-addressed entry shape, and one of the three the deny-test covers. Measured refused
      // for a premium router in a basic room on 2026-09-17, and before ADR-045 the empty roster read
      // as "nobody was addressed" and the turn continued into the model.
      if (size.refused) {
        return refuseAtClassificationBoundary(event, channelArn, 'channel-size:private-address');
      }
      const privateTo = resolvePrivateTarget(userMessage, size.members);
      if (privateTo) {
        userMessage = stripPrivatePrefix(userMessage, privateTo);
        console.log('[Router] private prefix resolved; the address is not part of the request', {
          addresseeIsAssistant: privateTo.isBot,
          rosterSize: size.members.length,
        });
      }
    }

    // `/stop` - CANCEL THE WORK IN THIS CONVERSATION, and it runs before everything below.
    //
    // A COMMAND, for the reasons `/battle end` is one: "stop" typed mid-sentence is ambiguous, a wrong
    // guess throws away work the person wanted, and a decision that depends on recognizing a phrase
    // does not survive the conversation being held in another language (tenet D11). A literal token
    // cannot be misread and reads the same everywhere.
    //
    // FIRST, because it is the escape hatch. The declining guard below tells people to send this, so
    // it has to reach the runtime even when the assistant believes it owes them a step - anything that
    // could swallow it would make the way out unreachable exactly when it is needed.
    //
    // AND BEFORE ANYTHING IS READ FOR IT: the intake, the intent classifier and the waiting-task step
    // all run below this (ADR-033 "Cancellation", DESIGN-TASK-ACCESS 2.5: an interrupt is acted on
    // immediately, before anything else is read). Placed after them, a stop waited on a model call to
    // be answered, and the waiting-task step had already applied it as an answer, so a REFUSED private
    // stop still handed the person's task back to the assistant. Only the text it parses is needed
    // here, with the private address already stripped above.
    // MENTION-TOLERANT, and that is a fix rather than a convenience. In a room with several
    // assistants Amazon Chime SDK puts them in MENTIONS mode, so the only way to reach one is to
    // mention it - and the exact-match check this replaces (`message === '/stop'`) failed on
    // `@analyst /stop`. The escape hatch was unreachable in exactly the rooms where naming a target
    // is the point. See `lib/stop-target.ts`.
    const parsedStop = parseStopCommand(userMessage);
    if (parsedStop.isStop) {
      const thisResponderId = principalIdFromArn(botArn);

      // WHICH ASSISTANT THIS STOP NAMED, resolved by lookup and never by a model call: the
      // deterministic path must not wait on a judgement (DESIGN section 1.2). The membership read is
      // the one the router already caches for this container, so this costs a filter rather than a
      // Chime call.
      const stopTarget = resolveStopTarget({
        addressed: parsedStop.addressed,
        assistantCount: await countAssistantsInChannel(channelArn, botArn),
        thisResponderId,
      });

      // THIS ASSISTANT'S OWN WORDING WHERE THE DEPLOYMENT CONFIGURED ANY. Resolution is cached per
      // container, the same bargain the queue notice strikes: configuration is affordable on this
      // path where a model call is not. Fixed English here would mean a configured persona never
      // reached the one line posted at the moment somebody asked things to stop, and a conversation
      // held in another language got English at exactly that moment (tenets P5 and D11).
      const stopWords = await turnWords();

      // ── A STOP IS SENT TO THE WHOLE ROOM, OR IT IS NOT A STOP ─────────────────
      //
      // A stop halts this assistant for everybody in the conversation. Sent privately, the room watches
      // the assistant stop working with nothing to say why. So a private stop is refused before anything
      // is stopped, and the refusal is the Lex reply, which inherits the private message's targeting and
      // reaches only the sender.
      //
      // Private here means it did not come through the channel flow in a group. A public `/stop` in a
      // room reaches the flow whether or not it names an assistant - the CHAT_COMMANDS registry
      // dispatches an unaddressed one to the primary assistant - so it arrives as a flow entry either
      // way. What reaches the Lex entry directly in a room was sent with a Target, which is what makes
      // it private. A 1:1 has no room to hide from, so it proceeds. A room whose size cannot be read
      // proceeds too: refusing a stop on a failed read would take away the escape hatch exactly when
      // something is already going wrong.
      if (!isFlowEntry(event) && channelArn) {
        const room = await resolveChannelSize(chimeClient, channelArn, botArn);
        // THE ESCAPE-HATCH ARGUMENT ABOVE IS ABOUT AN UNREADABLE ROOM, NOT A REFUSED ONE, and the two
        // part company here. Proceeding on `unknown` protects a stop during an outage. A refusal is
        // not an outage: it says this assistant may not act in this conversation, so there is nothing
        // of its own running here for a stop to halt. Ending the turn is therefore not taking the
        // escape hatch away - the thing the hatch exists to stop is already not happening.
        if (room.refused) {
          return refuseAtClassificationBoundary(event, channelArn, 'channel-size:private-stop');
        }
        if (!room.unknown && !room.isOneToOne) {
          console.log('[Router] /stop was sent privately in a group; refusing it', { channelArn });
          return formatLexResponse(event, [{
            contentType: 'PlainText',
            content: templateLine('stop-must-be-public', stopWords),
          }]);
        }
      }

      // AMBIGUOUS MEANS ASK, NEVER GUESS. Picking one assistant silences work the person may have
      // been watching; picking all of them destroys work nobody asked to lose. Nothing is stopped on
      // this branch, deliberately: the person is one word away from an unambiguous stop, and a guess
      // is not recoverable by them.
      if (stopTarget.kind === 'ambiguous') {
        console.log('[Router] /stop was not addressed and this room holds several assistants; asking', {
          channelArn, assistantCount: stopTarget.assistantCount,
        });
        return formatLexResponse(
          event,
          [{
            contentType: 'PlainText',
            content: templateLine('stop-ambiguous', stopWords),
          }],
        );
      }

      // COMPLETED WORK IS KEPT; WORK IN PROGRESS IS CANCELLED; THEN THEY ARE ASKED HOW TO PROCEED
      // (ADR-033, owner 2026-09-14).
      //
      // `/stop` means "stop what you are doing", and the open work is what the assistant is doing.
      // Finished work is not in this selection at all: it reads open tasks only, so nothing the person
      // already received can be cancelled by stopping what came after it.
      //
      // SCOPED TO THE ASSISTANT IT NAMED, as well as to the person who asked. `assistantId` is the
      // stable "whose work this is", unlike the owner, which moves between the person and the
      // assistant at every step boundary.
      const held = await selectStoppableTasks(channelArn, personId, stopTarget.responderId);
      // AND STOP THE TURN THAT IS ALREADY RUNNING, FIRST. Without this the Lambda mid-answer still
      // posts, so a person who stopped a report receives the report and the escape hatch did not work
      // from their side. This is the half that must not fail: it is the only part of a stop the person
      // can see working, so it is written before the cancel can cost it anything.
      await recordStop(channelArn, personId, stopTarget.responderId);
      // THROUGH THE SEAM, BY THE IDS JUST SELECTED. `cancelStoppedTasks` skips anything already
      // finished and takes the per-user mirror with the row, without which `getActiveTask` resurrects
      // the task on the next turn. A turn still running cannot advance it back out of `cancelled`:
      // a status update never overwrites a terminal status.
      const cancelled = held.length
        ? await cancelStoppedTasks(channelArn, held.map(({ summary }) => summary.taskId))
          .catch((err: unknown) => {
            console.error('[Router] /stop could not cancel the work it stopped', err);
            return 0;
          })
        : 0;
      console.log('[Router] /stop suppressed this assistant\'s turn and cancelled its work in progress', {
        channelArn, responderId: stopTarget.responderId, selected: held.length, cancelled,
      });

      // NOTHING WAS CANCELLED THOUGH SOMETHING WAS OPEN: the seam refused or failed. The running answer
      // is still suppressed, so the stop is visibly working, but the task records are still open and
      // the person must not be told otherwise or asked how to proceed with work that has not stopped.
      const cancelFailed = held.length > 0 && cancelled === 0;
      if (held.length > cancelled && cancelled > 0) {
        // Partial: a task finished or was cancelled between the selection and the cancel, or one write
        // failed (`cancelStoppedTasks` logs which). The question still goes out about the whole set.
        console.warn('[Router] /stop cancelled only part of the work it selected', {
          channelArn, selected: held.length, cancelled,
        });
      }

      // THE JUDGED HALF, DISPATCHED BEHIND THE ACKNOWLEDGMENT AND NEVER IN FRONT OF IT. A model call
      // before this reply would put seconds between the person asking things to stop and being told
      // they had, on the one path where immediacy is the whole point. Its failure costs the follow-up
      // question and never the stop.
      // Declared out here because the reply below reads it: the line a person sees differs by whether
      // a question was actually arranged for them.
      let asked = false;
      const askedLine = templateLine('stopped', stopWords, { count: held.length });
      const notAskedLine = templateLine('stop-cancelled-but-not-asked', stopWords, { count: held.length });
      // ── THE ACKNOWLEDGMENT IS POSTED BEFORE THE QUESTION TURN EXISTS ──────────
      //
      // Returned to Lex, the acknowledgment is posted by Amazon Chime SDK only after this handler
      // returns, and the question turn below was already started by then - so the question often
      // landed first and read as an answer to nothing. Posting it here, and dispatching only after the
      // post returns, makes the order a fact of the code's sequence rather than of a race or a wait.
      //
      // PUBLIC, because a stop that reaches this point was sent to the room: a private one was refused
      // above.
      let postedAckId: string | undefined;
      if (held.length && !cancelFailed) {
        try {
          const posted = await sendInParts(chimeClient, {
            ChannelArn: channelArn,
            text: askedLine,
            Type: ChannelMessageType.STANDARD,
            Persistence: ChannelMessagePersistenceType.PERSISTENT,
            ChimeBearer: botArn,
            // WHO STOPPED WORK, AND HOW MUCH, as a recorded fact on the acknowledgment (SPEC-EVALUATION
            // Appendix C6). The frustration reading counts a stop from this marker, never from the
            // words of the person's message. Written by the assistant's own bearer, so no member can
            // post one.
            Metadata: botMessageMetadata(spoke.attribution, { stopped: { personId, cancelled } }),
          });
          postedAckId = posted.MessageId;
        } catch (err) {
          // The stop still stands and the question still goes out; only the order is no longer
          // guaranteed, because the acknowledgment falls back to the Lex reply below.
          console.warn('[Router] could not post the stop acknowledgment first; replying through Lex', {
            err: (err as Error)?.message,
          });
        }
      }
      if (held.length && !cancelFailed) {
        asked = await dispatchStopEvaluationTurn({
          channelArn,
          botArn,
          classification: effectiveClassification,
          // DERIVED HERE rather than reused. The turn's own correlation is resolved further down,
          // after this escape hatch has already returned, and reusing the STOPPED turn's would attach
          // this question to the answer that was just suppressed - an update landing on a message the
          // person has been told is finished with. This turn gets its own placeholder, so it needs
          // its own identity.
          correlationId: `stop-${principalIdFromArn(botArn)}-${Date.now()}`,
          senderArn: event.requestAttributes?.['CHIME.sender.arn'] || '',
          // A BOUNDED EXCERPT, never the transcript: `requestExcerpt` is what ADR-024 D5 keeps for
          // exactly this, and it does not outlive a redaction the way a copy of the message would.
          // A PRIVATE TASK'S EXCERPT NEVER REACHES THIS PROMPT (maintainer decision, 2026-08-23: a
          // private task is visible in that it exists, not in what it is). The evaluation's reply
          // posts to the room, so a label carrying the excerpt would publish the one thing a
          // targeted request withheld. The requester knows what their own request was; the neutral
          // label tells them WHICH kind of cancelled thing the question is about without telling the
          // room. ABSENT VISIBILITY IS PRIVATE HERE, as it is at every reader (`task-visibility.ts`).
          //
          // A task opened from a TARGETED message carries no visibility at creation: the channel-flow
          // callback does not deliver `Target` at all, so the router cannot know, and the row is only
          // narrowed later in the turn once the placeholder can be read. Reading absence as
          // `conversation` therefore turned "not yet decided" into "public" for the whole duration of
          // a turn - which is precisely the window /stop is used in, because there is nothing to stop
          // outside it.
          //
          // Costs nothing to fail closed: the neutral label goes to the person who made the request,
          // and they already know what they asked for.
          cancelledLabels: held.map(({ full }) => (!isPrivateVisibility(full.visibility)
            ? (full.requestExcerpt || full.taskType || 'work in progress')
            : 'a private request (its details stay between you and the person who made it)')),
          // WHEN A BYPASS CALLER DECLARED IT. The Lex path cannot: Amazon Chime SDK sends Lex three
          // request attributes and the message id is not among them, and resolving it here would put
          // a channel read on the one path whose whole promise is immediacy.
          ...(event.requestAttributes?.[BYPASS_MESSAGE_ID_ATTR]
            ? { userMessageId: String(event.requestAttributes[BYPASS_MESSAGE_ID_ATTR]) }
            : {}),
        }).catch((err) => {
          console.warn('[Router] stop evaluation dispatch failed', err);
          return false;
        });
        // ── AND THE QUESTION IS RECORDED, SO THE STOP OWNS THE ANSWER ────────────────────────────
        //
        // The evaluation asks how they want to proceed. Their answer arrives as an ordinary message
        // on a later turn, and the router reads this record before routing that message (see "THE
        // STOP QUESTION OWNS ITS FOLLOW-UP" below), so the answer is read against the question rather
        // than classified as whatever it happens to sound like.
        //
        // ONLY WHEN THE PERSON WAS ACTUALLY ASKED. `dispatchStopEvaluationTurn` returns false rather
        // than throwing when no router resolves, and a record of a question nobody heard would make a
        // later unrelated message be read as an answer to it.
        if (asked) {
          await rememberStopDecision({
            channelArn,
            responderId: stopTarget.responderId,
            askedOf: personId,
            taskIds: held.map(({ summary }) => summary.taskId),
            // THE REQUEST TEXT, for "start it again". Read back only for the person who made it, and
            // restored into a turn only under the visibility rule `restartedRequest` applies.
            requests: held.map(({ full }) => ({
              text: full.requestExcerpt || full.taskType || '',
              private: isPrivateVisibility(full.visibility),
            })),
          }).catch((err: unknown) => console.warn('[Router] could not record the stop decision', err));
        } else {
          // Loud, because the person was promised nothing and will not be asked. The work is already
          // cancelled, so nothing is stranded; they are told they can ask for it again.
          console.error('[Router] the stop evaluation was not dispatched, so no question follows the'
            + ' cancel', { channelArn, cancelled });
        }
      }

      // ── THE LINE ONLY SAYS WHAT HAPPENED, AND ONLY PROMISES WHAT WAS ARRANGED ───────────────────
      //
      // Four outcomes, four lines, because each is a different fact for the person: cancelled and a
      // question is coming; cancelled with no question (the same rule `queueWriteFailed` is written
      // under - a promise nothing can keep is not made); not cancelled at all; nothing to stop.
      // THE ACKNOWLEDGMENT WAS ALREADY POSTED. It promised a question; when none was arranged, it is
      // corrected in place rather than left promising one.
      if (postedAckId) {
        if (!asked) {
          await chimeClient.send(new UpdateChannelMessageCommand({
            ChannelArn: channelArn,
            MessageId: postedAckId,
            Content: encodeURIComponent(notAskedLine),
            ChimeBearer: botArn,
          })).catch((err: unknown) => {
            console.warn('[Router] could not correct the stop acknowledgment', { err: (err as Error)?.message });
          });
        }
        return formatLexSilentResponse(event);
      }
      return formatLexResponse(
        event,
        [{
          contentType: 'PlainText',
          content: !held.length
            ? templateLine('stop-nothing-to-stop', stopWords)
            : cancelFailed
              ? templateLine('stop-cancel-failed', stopWords, { count: held.length })
              : asked ? askedLine : notAskedLine,
        }],
      );
    }

    // Attachment-in, present only on a bypass (the flow reads it from message Metadata; Lex never
    // sees it). Resolved here because it changes what the turn IS, not just what the processor gets:
    // see the greeting short-circuit below.
    const turnAttachment = bypassAttachment(event);

    // Onboarding intake interception (opt-in). While an intake is in progress,
    // every message from the person being onboarded is an answer to the current
    // field (or the yes/no on the summary), driven deterministically with NO
    // Bedrock call - the same instant, shaped model as the static welcome. The
    // collected answers land in channel history, so the working assistant sees
    // them once intake completes. This runs BEFORE classification, drift, and
    // dispatch so an intake answer is never misread as a query. Fully inert unless
    // the deployment opts in (config is null by default).
    //
    // THE STORED INTAKE DECIDES, not the Amazon Lex session. The state is on the
    // channel context row, written when WelcomeIntent started the intake. That
    // makes four things true that were not:
    //   - NO RECORD MEANS NO INTAKE. The Lex version read an empty session as "the
    //     first answer", so on any turn without Lex's session - the channel flow's
    //     entry, a handover, a reading, a stop evaluation - a not-yet-onboarded
    //     person's message was taken as the answer to question one, and the state
    //     it wrote was discarded, so the intake could never advance.
    //   - ONLY ITS SUBJECT ANSWERS IT. A message from anyone else, or a turn the
    //     platform wrote to itself, is not an intake answer.
    //   - A PAUSE IS HARMLESS. Lex dropped its session after five idle minutes.
    //   - THE INTAKE IS THE ONE THE WELCOME STARTED. The welcome drops asserted fields and pins the
    //     keys it asked on the row; `intakeAsStarted` runs exactly those. Advancing against the full
    //     deployed list filed every answer after a dropped field under the wrong key.
    // The SAME resolution the welcome used. If these two disagreed about which intake is in force, a
    // conversation would be opened with one assistant's questions and its answers read against
    // another's field list - which `intakeAsStarted` would then refuse, stranding the person mid-intake.
    // Both pass the turn's assistant profile, so a conversation with the ops assistant reads its answers
    // against the ops assistant's intake.
    const deployedIntake = await intakeForAssistant(turnProfile.name, channelClassification);
    if (isOnboardingEnabled(deployedIntake) && channelArn && !isMachineWrittenTurn(event) && !isAmendmentFold(event)) {
      const stored = parseStoredIntake(
        (await getChannelContext(channelArn, { consistent: true }))?.onboardingIntake,
      );
      const answering = stored && stored.subject === personId && stored.phase !== 'done' ? stored : null;
      const intakeConfig = answering ? intakeAsStarted(deployedIntake, answering, channelClassification) : null;
      if (answering && !intakeConfig) {
        console.warn('[Router][Onboarding] the deployed intake no longer has the fields this conversation was asked; not reading the turn as an answer', {
          asked: answering.asked,
        });
      }
      if (stored && answering && intakeConfig) {
        const intakeName = await resolveUserName(event.requestAttributes?.['CHIME.sender.arn'] || '');
        // DOES THIS PERSON REACH BEYOND THIS ROOM? Used only by an offer's access line.
        //
        // `undefined` RATHER THAN A GUESS when clearance did not resolve. `resolveUserClearance`
        // answers `basic` for any failure (see its note above), so a transient outage would otherwise
        // tell somebody holding premium that they must request it - a false statement about their own
        // permissions, which is worse than saying nothing about access at all.
        const reachesBeyond = userClearance
          ? profiles.grantsFor(userClearance).some((c) => c !== channelClassification)
          : undefined;
        const step = advanceIntake({ ...intakeConfig, words: await turnWords() }, stored, userMessage, intakeName, reachesBeyond);
        console.log('[Router][Onboarding]', { phase: step.state.phase, cursor: step.state.cursor, done: step.done });
        // On completion, persist the once-per-user flag + collected facts so no future conversation
        // re-onboards this user (and the assistant keeps the facts as durable context). The stored
        // intake keeps `phase: 'done'`, so a failed flag write still does not restart the intake here.
        // CONDITIONAL ON THE STATE THIS TURN READ. A duplicate delivery of the same answer, or a second
        // message racing it, reads the same state; only one may advance it. The loser changes nothing and
        // replies with the step computed from that same state and message - the reply the winner sent -
        // so a redelivery is harmless. The once-per-user flag is written only by the turn that advanced.
        const outcome = await advanceOnboardingIntake(
          channelArn,
          { cursor: stored.cursor, phase: stored.phase, subject: stored.subject },
          { ...step.state, subject: stored.subject },
        );
        if (outcome === 'lost') {
          console.log('[Router][Onboarding] another turn advanced this intake first; replying without writing');
        } else if (step.done) {
          // A preference field's answer is stored under the person's `preferences` (the value key), every
          // other answer under `facts`.
          const { facts, preferences } = splitCollected(intakeConfig, step.state.collected);
          await markOnboarded(personId, facts, preferences);
          // The assistant confirms a preference in its own voice, so the outcome rides this turn's dispatch.
          if (step.preferencesSet) turnPreferenceOutcome = { action: 'set', saved: step.preferencesSet };
        }
        // ── RELEASED: THIS TURN WAS NOT AN ANSWER, SO THE ASSISTANT TAKES IT ──────────────────────
        //
        // The person asked something, or asked to stop. The intake is closed above (its state is
        // `done` and the once-per-user flag is written), and we deliberately DO NOT return
        // `step.reply` - falling through means this same message goes on to classification and
        // dispatch, so the question they asked is the question that gets answered.
        //
        // Returning here instead is what produced the trap this fixes: the intake replied, the
        // message never reached the assistant, and no input the person could type changed that.
        if (step.release && step.pending) {
          // AN OPEN OFFER, NOT AN ANSWER. The message goes to the assistant like any other, the offer
          // stays pending for the next message, and onboarding is not recorded: a preference has to be
          // chosen (or "no preference") to finish it.
          console.log('[Router][Onboarding] the turn did not choose an offered preference; routing it and keeping the offer open');
        } else if (step.release) {
          console.log('[Router][Onboarding] the turn was not an answer; releasing it to ordinary routing', {
            phase: stored.phase, collected: Object.keys(step.state.collected).length,
          });
        } else {
          return formatLexResponse(event, [{ contentType: 'PlainText', content: step.reply }]);
        }
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
    // ── A DUEL SIDE IS ITS PINNED VERSION, FROM THE FIRST READ (DESIGN-SEPARATE-ASSISTANTS §3.7) ──────────
    //
    // Both sides of a battle are pinned versions derived at arm time, so a side's turn reads its version
    // where any turn reads the version it serves: the classifier model, the intent pack and the workflow
    // selection below all come from it, and the processor serves it whole (`variantProfile`). That is what
    // keeps a `classification` experiment meaningful in a duel: each side's version carries its variant's
    // classifier, and the side classifies with it. A side whose pin does not resolve serves its assistant
    // as it is. A duel resumed mid-turn (a person's answer to a side's question) is found after this point
    // and resolves its side below.
    const duelEntry = bypassBattleContext(event);
    const duelSides: DuelSides | undefined = duelEntry
      ? await resolveDuelSides({ classification: STATIC_CLASSIFICATION, selfBotArn: duelEntry.selfBotArn, ...(channelArn && { channelArn }) })
      : undefined;
    // A DUEL WHOSE EXPERIMENT ENDED OR PAUSED IS ENDED, NOT ANSWERED: a treatment that is
    // unjudged (paused) or decided (completed) must not keep answering. Neither side posts; the duel ends
    // through the one door, which releases the channel for the next /battle.
    if (duelEntry && duelSides?.ended && channelArn) {
      await endDuelHere({ channelArn, battleId: duelEntry.battleId, reason: 'abandoned:experiment-ended' });
      return formatLexSilentResponse(event as LexEvent);
    }
    let duelVersion: Awaited<ReturnType<typeof resolveActiveProfile>> | undefined;
    if (duelSides?.self) {
      try {
        duelVersion = { ...resolveFromDefinition(await hydrateBodies(duelSides.self.variantProfile), turnProfile.name), version: duelSides.self.variantVersion };
      } catch (error) {
        console.error('[Router][battle] the side\'s pinned version could not be read; it serves its assistant as it is:', error);
      }
    }
    // ── AN EXPERIMENT TURN SERVES ITS VERSION, FROM THE FIRST READ (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5) ──
    //
    // An ordinary turn of a conversation enrolled in an experiment is served the version its arm pins (the
    // control's live active version, or the treatment's candidate) under the live identity, so that version's
    // classifier, intent pack and workflow selection decide the turn, as a duel side's version does. A turn
    // the alt identity answers outside a duel (a reply targeted at it, a mention) serves the alt's armed
    // candidate whatever the conversation's enrollment. Resolved once here and reused below.
    let enrolledResolution: Awaited<ReturnType<typeof resolveEnrollment>> = null;
    let enrollmentDecided = false;
    let enrolledVersion: Awaited<ReturnType<typeof resolveActiveProfile>> | undefined;
    if (!duelEntry && channelArn) {
      try {
        const catalog = getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
        if (profiles.roleOfAlt(turnProfile.name)) {
          const side = await resolveBattleTreatment(turnProfile.name);
          if (side) {
            enrolledResolution = {
              experimentId: side.experimentId, variantId: side.variantId, experimentType: undefined,
              modelKey: side.modelKey, bedrockModelId: '', variantProfile: side.variantProfile, configId: side.variantProfile.configId,
              ...(side.variantVersion !== undefined ? { variantVersion: side.variantVersion } : {}),
              ...(side.imageGenModelKey ? { imageGenModelKey: side.imageGenModelKey } : {}),
            };
          }
        } else {
          const enrollment = await enrollmentOf(channelArn, effectiveClassification);
          if (enrollment) enrolledResolution = await resolveEnrollment(enrollment, effectiveClassification, channelArn, catalog);
        }
        enrollmentDecided = true;
        if (enrolledResolution?.variantProfile) {
          enrolledVersion = { ...resolveFromDefinition(await hydrateBodies(enrolledResolution.variantProfile), turnProfile.name), version: enrolledResolution.variantVersion };
        }
      } catch (error) {
        console.error('[Router] the conversation\'s experiment version could not be resolved; it serves its assistant as it is:', error);
      }
    }
    const servedVersion = duelVersion ?? enrolledVersion;
    if (usesLlmClassifier && channelArn && !servedVersion) {
      try {
        const catalog = getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
        const cls = await resolveClassificationExperiment(effectiveClassification, channelArn, catalog);
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
    // from the addressed assistant's active version (`models.classifier`, read through the turn's assistant
    // profile). Byte-identical until a version names a CONCRETE model: the seed carries the
    // `'default'` sentinel, which `concreteModel` skips, so this stays undefined and `classifyIntent` uses
    // the deployment-default CLASSIFIER_MODEL (the profile's recorded choice to track the platform default).
    if (usesLlmClassifier && !classifierModelId) {
      try {
        const active = servedVersion ?? await resolveActiveProfile(turnProfile.name, { ssm: ssmClient, ssmRoot: SSM_ROOT });
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

    // ── THE TAXONOMY THE SERVING ASSISTANT RECOGNIZES ────────────────────────────────────────────
    //
    // A pack rides the profile version (SPEC-PORTABLE-PROFILES), so WHICH intents exist is a property
    // of the assistant answering rather than of the deployment. Undefined here means this version
    // carries none, and the classifier falls back to the deployment pack - which is every version
    // written before the pack moved, so this reads byte-identically for them.
    //
    // Same 30s-cached read as the classifier model above; a second call inside the TTL is free.
    let profileIntentPack: IntentPack | undefined;
    // THE MACHINES THIS TURN RUNS UNDER, resolved once (ADR-047): the FULL resolved set, platform
    // graphs plus whatever this classification pack adds.
    //
    // The workflow SELECTION is deliberately NOT applied to this value. A selection decides what an
    // assistant may OPEN; applying it here would also hide tasks already in flight, and a task whose
    // graph disappeared from under it cannot be advanced or finished by anyone. It is applied at the
    // one place a task TYPE is chosen, below.
    const turnMachines: Record<string, TaskStateMachine> = taskStateMachines();
    // WHAT A PLACEHOLDER SAYS: the workflow state's declared `placeholder`, else this assistant's
    // `task-placeholder` template (ADR-062 decision 6).
    const placeholderWords = async (taskType?: string, taskState?: string) => ({
      words: await turnWords(),
      declared: taskType && taskState ? turnMachines[taskType]?.states?.[taskState]?.placeholder : undefined,
    });
    /** The serving version selection, applied only where a task is OPENED. */
    let turnWorkflowSelection: string[] | undefined;
    /**
     * MAY THIS ASSISTANT OPEN A TASK OF THIS TYPE? The selection gate, declared once because there are
     * TWO doors that open a task - the ordinary intent path and the battle side - and a gate on one of
     * them is a gate an assistant can be walked around by asking for a duel.
     *
     * Platform machines are exempt: the queue opens its own task types directly and a selection must
     * not remove them (SPEC-TASK-STATE-TRANSITIONS, two kinds of shipped machine).
     */
    const mayOpen = (t: string): boolean => !turnWorkflowSelection?.length
      || (PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(t)
      || turnWorkflowSelection.includes(t);
    try {
      // ── THE TAXONOMY COMES FROM THE ASSISTANT ADDRESSED, NOT THE CLASSIFICATION'S PRIMARY ────────
      //
      // A classification hosting a second assistant classifies that assistant's turns against its own
      // taxonomy: an operational question put to `ops-premium` is matched against the ops intents, not
      // `advisor`'s, and reaches the processor with the delivery class and per-intent instructions the
      // ops pack declares. The processor resolves behavior from the same assistant, so both halves of one
      // turn read one profile.
      //
      // From the turn's assistant profile, the same value the classifier mode and model above read. An alt's
      // version is not a published profile (its version is derived at battle activation), so it
      // resolves to the classification's primary, the guard the processor applies too.
      const activeForPack = servedVersion ?? await resolveActiveProfile(turnProfile.name, { ssm: ssmClient, ssmRoot: SSM_ROOT });
      profileIntentPack = activeForPack.intentPack;
      turnWorkflowSelection = activeForPack.workflows;
    } catch (error) {
      // Fail to the deployment pack, never to no taxonomy: an unreadable version must not collapse
      // every domain intent to `general`, which is the failure this whole change exists to end.
      console.error('[Router] profile intent-pack resolution failed (using the deployment pack):', error);
    }

    // The assistant that will answer is settled: intent pack hydrated, classifier experiment
    // resolved, the profile version's own classifier model read. Mostly SSM, and the step a cold
    // container pays most for.
    markRouterStep('profile_resolved');

    // Classify intent via the profile's classifierMode — 'llm' for all default profiles (basic
    // included), 'keyword' (classifyIntentByKeyword) only if a deployment selects it for a cheap profile.
    // THE JUDGED HALF OF A STOP IS NEVER CLASSIFIED. Its message is this system's own prompt about the work
    // that was just cancelled, so reading it for intent reads the cancelled work: measured live 2026-09-15,
    // the prompt for a stopped report classified as REPORT_GENERATION, and because a machine-written turn
    // skips the active-task lookup, the question about the stop OPENED A NEW REPORT. It asks a question, so
    // it is a general turn, and no model call is spent deciding that.
    const isStopQuestionTurn = !!parseStopEvaluationContext(event.requestAttributes?.[BYPASS_STOP_EVAL_ATTR]);
    // ── WHO ELSE IS IN THIS CONVERSATION, RESOLVED BEFORE CLASSIFYING ─────────────────────────────
    //
    // ONE PASS. The roommates' advertised lines join this assistant's own intents as categories in the
    // SAME classification that was going to happen anyway, so deciding "whose question is this" costs no
    // extra model call. The earlier shape asked twice - once over its own pack, then again over the
    // roommates' - which measured at 757 ms plus 795 ms on one turn for a question a single call can
    // answer.
    //
    // THE ORDER IS THE WHOLE SAVING, so it is worth being explicit about what it costs: resolving
    // roommates now means the roster read moves onto every turn in a room that could hold one. The assistant
    // index is cached per container, so the gate in front of it is a lookup, and it is false for every
    // deployment that has not asked for a second assistant - those pay nothing and read nothing.
    //
    // SKIPPED ENTIRELY ON A HANDED-OVER TURN. Such a turn may not delegate onward (the chain bound), so
    // offering it roommate categories would spend prompt tokens on choices it cannot act on - and risk it
    // classifying as a roommate's key and losing its own delivery option for no reason.
    //
    // AND ON A DUEL SIDE. A battle turn is one side's own answer to the same prompt the other side
    // answers, so it is never anyone else's question. Offered roommates, the alt classified the prompt as
    // the primary's key and handed its side over to the primary (measured live 2026-10-13): the alt never
    // answered, and the handed-over turn queued behind the primary's own side and put a queue notice in
    // its placeholder, so that side's scorecard stats never reached its duel message.
    // The roster the read answered stays with THIS turn and reaches only this turn's own dispatch.
    const { roommates, roster: turnRoster } = arrivedByHandover(event) || bypassBattleContext(event)
      ? { roommates: [] as Roommate[], roster: undefined }
      : await resolveRoommatesForTurn({ channelArn, selfBotArn: botArn, classification: effectiveClassification });
    const packForClassification = roommates.length
      ? withRoommateCategories(profileIntentPack, roommates)
      : profileIntentPack;

    // A HANDED-OVER TURN IS ALREADY PLACED, in this assistant's OWN taxonomy, so it does not classify
    // again. The key came out of this assistant's published advertisement, which is why accepting it is
    // not accepting the sender's opinion of the work - and it is only honored when the pack really
    // declares it, so a stale advertisement or a key this assistant has since withdrawn falls through to
    // ordinary classification rather than routing on a category it no longer serves.
    //
    // WITHOUT THIS THE RECEIVER CLASSIFIES NOTHING. The handover carries a reference and not the text,
    // so the transcript is empty here: measured as an empty message landing on `general`, which costs
    // this assistant the per-intent delivery option and model route it was chosen for.
    const handedIntent = event.requestAttributes?.[BYPASS_HANDED_INTENT_ATTR];
    // CHECKED AGAINST THIS ASSISTANT'S OWN DECLARED PACK, not the resolved one. An assistant carrying no
    // pack of its own advertises nothing and therefore cannot be a handover target, so falling through to
    // ordinary classification there is the same answer by a shorter route.
    const handedIsServed = !!handedIntent
      && (profileIntentPack?.intents ?? []).some((i) => i.key === handedIntent);
    if (handedIntent && !handedIsServed) {
      console.warn('[Router] a handover named an intent this assistant does not declare; classifying '
        + 'the turn normally', { handedIntent });
    }
    // ── WHAT THIS ASSISTANT DOES NOT OFFER, so a request for it is recognized and refused ────────────
    //
    // DESIGN-CAPABILITY-REFUSAL §3: a capability the assistant does not offer is refused, never guessed at. Every
    // platform intent this assistant's OWN pack does not declare is offered to the model as a category,
    // and a turn classified as one is refused below rather than answered as `general`. Computed from
    // the assistant's own pack, never the roommate-merged one, because the question is what THIS
    // assistant offers. The model only: the keyword path is a substring match (tenet D11).
    // A JOIN RECAP IS NEVER CLASSIFIED EITHER. It is a catch-up on this conversation by construction, which
    // is the platform's `conversation_summary` capability: every assistant answers it from the conversation,
    // no pack can drop it, and reading the request for intent would only spend a model call to agree.
    const joinRecapTurn = isJoinRecap(event);
    const refusedIntents = usesLlmClassifier && !isStopQuestionTurn && !joinRecapTurn && !handedIsServed
      ? refusedPlatformIntents(profileIntentPack ?? getIntentPack())
      : [];
    // WHAT IS WAITING ON THIS PERSON, read BEFORE the label so the model can tell a step of open work from
    // new work (`waitingWork`, intent-classifier.ts). The same read the active-task lookup below makes, made
    // once here and reused there, so an ordinary turn pays no extra query. A duel turn reads the assistant's
    // partition instead and is not prefetched. A failed read classifies as before and the lookup below
    // reads again.
    //
    // AND THE WORK THIS ASSISTANT IS STILL DOING FOR THEM. A task moves to whoever owes its next step
    // (ADR-024), so a step the assistant holds is in the ASSISTANT's partition, not the person's - and a
    // person's follow-up to it was classified blind (measured live 2026-10-26: an extraction stalled at
    // `extracting`, and "deliver it as a downloadable document" opened a report). The same read the
    // own-chain lookup below makes when the person holds nothing, made here and reused there.
    const prefetchWork = usesLlmClassifier && !isStopQuestionTurn && !joinRecapTurn && !handedIsServed
      && !!channelArn && !!personId && !bypassBattleContext(event);
    const readBeforeClassifying = (owner: string) => getAssigneeChannelTasks(owner, channelArn!, { endedWithinMs: RECENTLY_ENDED_WINDOW_MS })
      .catch((err: unknown) => {
        console.warn('[Router] could not read the open work before classifying', { err: (err as Error)?.message });
        return null;
      });
    const [prefetchedPersonTasks, prefetchedOwnTasks] = prefetchWork
      ? await Promise.all([readBeforeClassifying(personId!), readBeforeClassifying(principalIdFromArn(botArn))])
      : [null, null];
    const openWorkForThisPerson = [
      ...(prefetchedPersonTasks?.live ?? []),
      ...(prefetchedOwnTasks?.live ?? []).filter((t) => t.ownerPersonId === personId),
    ];
    const classification = isStopQuestionTurn
      ? { intent: IntentType.GENERAL as string, confidence: 'high' as const }
      : joinRecapTurn
      ? { intent: IntentType.CONVERSATION_SUMMARY as string, confidence: 'high' as const }
      : handedIsServed
        ? { intent: handedIntent as string, confidence: 'high' as const }
        : usesLlmClassifier
          ? await classifyIntent(userMessage, {
            modelId: classifierModelId,
            pack: packForClassification,
            refused: refusedIntents,
            waitingWork: openWorkForThisPerson.map((t) => ({ taskType: t.taskType, step: t.taskState })),
          })
          : classifyIntentByKeyword(userMessage, packForClassification);
    // WHAT THE LABEL COST, as an instant rather than only as `classifierMs`. Marked on BOTH the model
    // and the keyword branch, because "this turn did not buy a classification" is itself the fact
    // `classifier_ms` records by being NULL - and a step that vanished on the fast paths would make
    // the following step absorb them.
    markRouterStep('classified');
    /**
     * The task type this turn's intent would OPEN, or undefined when it opens none: an intent owns the
     * machine of its own name when one exists and the selection allows it, the rule the opening branch
     * applies. Read at call time, because the intent is corrected below.
     */
    const turnOpensTaskType = (): string | undefined =>
      (turnMachines[classification.intent] && mayOpen(classification.intent) ? classification.intent : undefined);
    /**
     * The work this turn's intent names when it is not the waiting task's: the task type it would open, or
     * a roommate's key, which names another assistant's work and is the clearest case of other work.
     */
    const turnOpensOtherWorkKey = (): string | undefined =>
      (parseDelegationKey(classification.intent) ? classification.intent : turnOpensTaskType());
    /**
     * The intent this turn keeps if it is not handed over (`intentKeptHere`), which the other-work rule
     * compares too: a roommate key that reads back to the waiting task's own type is not other work,
     * because a handover that does not happen keeps the turn here as exactly that type.
     */
    const turnKeptHereAs = (): string => intentKeptHere(classification.intent, profileIntentPack ?? getIntentPack());
    /**
     * A step this assistant holds, of work this person owns, and the message is that work
     * (`isStalledStepCandidate`, task-continuity.ts). Asked wherever the turn finds the task.
     */
    const stalledStepCandidateHere = (t: Pick<UserTask, 'taskType' | 'taskState' | 'ownerPersonId' | 'assistantId'>): boolean =>
      isStalledStepCandidate({
        task: t,
        awaitsAParty: !!awaitedPartyOf(taskStateMachines()[t.taskType]?.states?.[t.taskState ?? '']),
        selfAssistantId: principalIdFromArn(botArn),
        speakerPersonId: personId,
        // The same turn value every caller of the rule reads, a roommate's key included: that key names no task
        // type, and what it reads back to here is `keptHereAs`.
        turnOpensTaskType: turnOpensOtherWorkKey(),
        keptHereAs: turnKeptHereAs(),
      });
    /** Whether this conversation holds a live duel, read once and only when a decision needs it. */
    let duelHereRead: Promise<boolean> | undefined;
    const duelHere = (): Promise<boolean> => (duelHereRead ??= channelArn
      // An unreadable battle record holds the earlier rule (the message is the awaited answer), which is
      // the direction that cannot strand a duel side waiting on its initiator.
      ? resolveActiveBattle(channelArn).then((d) => !!d).catch(() => true)
      : Promise.resolve(false));
    /**
     * WHETHER THIS MESSAGE IS OTHER WORK THAN `task`, A TASK WAITING ON IT (`opensOtherWorkThan`,
     * task-continuity.ts). The duel is read through `inADuel` only when the rule would otherwise set the
     * task aside, so a turn the rule already settles costs no battle read. Both waiting lookups ask this.
     */
    const otherWorkThan = async (task: { taskType?: string }, inADuel: () => Promise<boolean>): Promise<boolean> =>
      opensOtherWorkThan({
        task,
        turnOpensTaskType: turnOpensOtherWorkKey(),
        keptHereAs: turnKeptHereAs(),
        namedByThePerson: false,
        platformTaskTypes: PLATFORM_TASK_MACHINE_KEYS,
        inADuel: false,
      }) && !(await inADuel());

    // A TURN CARRYING A FILE IS NOT A GREETING, whatever its caption says.
    //
    // Both classifiers decide on the TEXT alone - they cannot see the attachment - and both call a
    // short message a greeting (`fastPathIntent`: anything under 3 characters, plus the exact
    // greeting/acknowledgement lists). So "hi" with a PDF dropped on it classifies as GREETING, and
    // GREETING has three consequences that are all wrong here: `quickReply` answers "Hey, what
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

    // Classifier-step instrumentation. The log is a convenience; the ANALYTICS record is the source,
    // and the threading this comment used to describe as future work is about 140 lines below:
    // `classifierSpendFields(...)` carries the experiment, variant, latency, tokens and model into the
    // record, archival stores them, `avg_classifier_ms` is published, and `LatencyTab` renders it.
    //
    // Said explicitly because the old wording ("logged for now... lands with the per-variant
    // measurement work") was the SOLE surviving basis for a claim that classifier spend has
    // no dashboard and must be read out of CloudWatch. A future-tense comment sitting above the code
    // that does the thing is the most durable kind of stale: it reads as a known gap.
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
    // null falls through to the normal agent flow. Its state (an open offer, the
    // conversation's adopted topics) is in Aurora, never in the Lex session.
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
    // Which of this person's open work this message could be about, when more than one is.
    // The turn decides between them; this is the closed set it may decide FROM.
    let referentCandidateIds: string[] = [];
    let referentCandidates: ReferentCandidate[] = [];
    // How the item this message answers was decided (ADR-035), recorded on the turn's analytics row.
    let taskResolution: TaskResolution | undefined;
    // How many open items this person may answer here, and which (ADR-035): a question about one of
    // several gets a line saying which reference to type.
    let answerableTaskIds: string[] = [];
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
     * message (maintainer, 2026-08-14).
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
    /**
     * The active task is a step THIS assistant holds, of work this person owns, and the message is that
     * work. Whether it resumes or is declined is settled at the one-thread rule below
     * (`resumesAStalledStep`), which is the only place that knows whether a turn is still running.
     */
    let stalledStepCandidate = false;
    /** This assistant's live work in this conversation, when the own-chain lookup below read it. */
    let ownLive: UserTask[] = [];
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
    // AND NOT AT ALL FOR A TURN THIS SYSTEM DISPATCHED TO ITSELF.
    //
    // Everything in here asks "is something waiting on this PERSON, and is this their answer". A
    // triage turn is neither: it carries a prompt this system wrote, to re-read a queue.
    //
    // Declining to APPLY it was not enough, which the deployment showed. The turn still entered this
    // region, matched the chain-resume path, and was dispatched from there as an ORDINARY turn - so
    // the triage context never reached the processor, no reading ran, and the queue stayed put. The
    // guards further down stop the task being mutated; this one stops the turn being misrouted, and
    // it is the routing that swallowed the reading.
    if ((battleCtx || channelArn || !shortAcknowledgment) && !isMachineWrittenTurn(event)) {
      if (battleCtx) {
        // A DUEL SIDE'S CHAIN IS OWNED BY THE ASSISTANT, NOT THE HUMAN (ADR-024). Each side runs its
        // own chain for one user prompt, so `getActiveTask(personId, ...)` would find the person's task
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
        // own waiting signal.
        //
        // WHAT THIS LOOKUP ESTABLISHES IS THAT SOMETHING IS WAITING, NOT THAT THIS MESSAGE ANSWERS IT.
        // This comment used to end "the queue has already brought them to this conversation; speaking
        // here is the answer", and that rule is wrong: speaking is never the answer, only a RELEVANT
        // message is. Somebody with a task awaiting them can perfectly well ask about something else,
        // and treating arrival as assent would close work they never addressed.
        //
        // The code does not do what that sentence said - `applyUserResponseToTask` judges relevance
        // and returns `applied: false, reason: deferred_to_model` when it cannot settle it - so what
        // was wrong here was the STATED rule, which is the more dangerous half: an implementation is
        // corrected by a test, and a rule nobody questions is copied into the next branch. It is
        // written down correctly now because it already got copied once, three lines further down.
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
          ? prefetchedPersonTasks ?? await getAssigneeChannelTasks(personId, channelArn, { endedWithinMs: RECENTLY_ENDED_WINDOW_MS })
          : { live: [], recentlyEnded: [] };
        const heldByPerson = personTasks.live;
        // Live work this person holds here. Recorded for drift the moment it is read, not when a
        // continuation decides to use it: the two branches below can legitimately decline to continue
        // one (it belongs to another assistant, or another person is the one being waited on), and the
        // conversation is mid-workflow either way.
        liveTaskInChannel = liveTaskInChannel || heldByPerson.length > 0;
        recentlyEndedTaskHere = recentlyEndedTaskHere ?? personTasks.recentlyEnded[0] ?? null;
        // ── THE PICK IS A PROPOSAL, NOT A DECISION (maintainer, 2026-09-04; ADR-024 D7) ─────────
        //
        // This was `heldByPerson[0]` - newest-first - and holding more than one open piece of work
        // is ordinary: a long request opens a `report_generation` in `collecting_requirements` while
        // a queued message opens a `queued_clarification` in `asked`. Measured on the turn-queue
        // e2e, of fourteen answers TWELVE went to `collecting_requirements` and one to `asked`: the
        // clarification the assistant had just asked about stayed open while the person believed
        // they had answered it.
        //
        // Recency is a fact about the WORK. Which work a message is about is a fact about the
        // MESSAGE, and nothing here has read it - the router must return fast and spends no model
        // call. So it RANKS, hands the ranking to the turn, and the turn decides with the words in
        // front of it. `awaits` is treated as weak evidence rather than strong, which is the
        // owner's rule: work in flight is a likelier referent than a question parked a while ago.
        // ── THE CANDIDATES ARE THIS PERSON'S WORK HERE, NOT WHAT THEY HAPPEN TO HOLD ────────────
        //
        // Built from `heldByPerson` this could never apply the rule it exists for. That list is the
        // ASSIGNEE partition, and a person is the assignee only while a step awaits them - so every
        // candidate was parked by construction and "work in flight ranks above a parked question"
        // had nothing in flight to rank. The rule was inert.
        //
        // Read by OWNER instead (ADR-024 D8), which holds still while the assistant works, so both
        // kinds of work are eligible. It goes through the task service because that is where the
        // classification boundary is applied before the read runs; the owner travels from the
        // message sender, which Amazon Chime SDK stamps, never from anything the person typed.
        //
        // ONLY WHEN SOMETHING IS ALREADY OPEN FOR THEM, so this costs a read on the turns where a
        // referent question can arise rather than on every turn in the deployment.
        // ── A REPLY THAT NAMES ITS ITEM (ADR-035) ────────────────────────────────────────────────
        //
        // A leading `#<n>` says which item this message answers, on any channel, because it is text.
        // Read here, before ranking, so a valid reference fixes the item and nothing is ranked or left
        // to the model. Not on a fold: its text is written by this system, not typed by the person.
        const reference = !isAmendmentFold(event) ? parseTaskReference(userMessage) : null;
        // ── THE SAME FACT, SAID BY A CLIENT INSTEAD OF TYPED BY A PERSON ─────────────────────────
        //
        // The channel flow carries it when the message named its item in `Metadata`
        // (`TurnRequest.answersTaskId`). It fixes the item exactly as a `#<n>` does, and for the same
        // reason: the person said which item this is, so nothing is ranked and the model does not get
        // to re-decide it.
        //
        // NOT A SECOND PERMISSION PATH. It is intersected with `answerable` below - the rows this
        // person holds or owns here - so an id naming anything else finds nothing, precisely as a
        // reference to anything else does. The flow already checked it; this does not trust that.
        const declaredTaskId = !isAmendmentFold(event)
          ? event.requestAttributes?.[BYPASS_ANSWERS_TASK_ATTR] || null
          : null;
        const ownedHere = (heldByPerson.length || reference || declaredTaskId) && channelArn && personId
          ? await referentCandidatesFor({
            channelArn, assistantId: principalIdFromArn(botArn), ownerPersonId: personId,
          }).catch(() => [])
          : [];
        // The assignee-held rows stay in the set: a row written before `ownerPersonId` existed has no
        // owner to match, and dropping it would make this narrower than what it replaced.
        //
        // ── AND ONLY THIS ASSISTANT'S OWN CHAINS (code review, 2026-09-04) ───────────────────────
        //
        // `heldByPerson` is the person's WHOLE assignee partition in this conversation, across every
        // assistant in it. Ranking puts this assistant's chains first but never removes the others, so
        // a rival's task reached the `task_id` enum - and `advance_task_state` checks transition
        // legality, not whose work it is. The model naming that id would have moved another
        // assistant's chain.
        //
        // That is the failure `mineWithThisPerson` and `handOverToOwningAssistant` below already exist
        // to prevent, and the exact case ranking rule 1 cites: two duel sides waiting on the same
        // person at once. Demoting it is not enough; a set the model may WRITE THROUGH has to exclude
        // it. Routing still hands a foreign chain to the assistant that owns it - that is the branch
        // above, and it is unaffected by this filter.
        //
        // A row with no `assistantId` predates the field and is kept: it belongs to whichever assistant
        // is answering, which on this turn is this one.
        const self = principalIdFromArn(botArn);
        const candidateRows = [
          ...heldByPerson,
          ...ownedHere.filter((o) => !heldByPerson.some((h) => h.taskId === o.taskId)),
        ].filter((t) => !t.assistantId || t.assistantId === self);
        const referents = rankReferentCandidates(
          candidateRows.map((t) => ({
            taskId: t.taskId,
            taskType: t.taskType,
            ...(t.taskState ? { taskState: t.taskState } : {}),
            ...(t.taskRef ? { taskRef: t.taskRef } : {}),
            ...(t.requestExcerpt ? { requestExcerpt: t.requestExcerpt } : {}),
            ...(t.visibility ? { visibility: t.visibility } : {}),
            ...(t.assistantId ? { assistantId: t.assistantId } : {}),
            updatedAt: t.updatedAt,
          })),
          { assistantId: principalIdFromArn(botArn), machines: taskStateMachines() },
        );
        // NAMEABLE ONLY WHEN THERE IS A CHOICE. One open item is not ambiguous, and offering a
        // redirect with one destination teaches the model to redirect for no reason.
        referentCandidates = referents.length > 1
          ? referents.slice(0, MAX_REFERENT_CANDIDATES).map((c) => ({
            ...c,
            // A PRIVATE REQUEST TRAVELS WITHOUT ITS WORDS. The turn this feeds writes a reply the
            // conversation can read, so the excerpt is dropped at the source rather than trusted to
            // be withheld at every later render. What remains is what its own requester already
            // sees in their list: that it exists, its type, and where it has got to.
            ...(isPrivateVisibility(c.visibility) ? { requestExcerpt: undefined } : {}),
          }))
          : [];
        referentCandidateIds = referentCandidates.map((c) => c.taskId);

        // THE ROWS ARE THE PERMISSION. What this person holds here (the step awaits them) and what they
        // own with this assistant: a reference to anything else - closed, someone else's, another
        // conversation's - finds nothing, so it narrows what was already allowed and never widens it.
        // Another assistant's item held by this person stays in the set, and the handover below sends it
        // to its owner exactly as a ranked pick would be.
        const answerable = [
          ...heldByPerson,
          ...ownedHere.filter((o) => !heldByPerson.some((h) => h.taskId === o.taskId)),
        ];
        answerableTaskIds = answerable.map((t) => t.taskId);
        // The declared id first: a client that named the item is not guessing, and a `#<n>` cannot
        // also be present on that message (the flow reads the metadata in preference to the text).
        const referenced = declaredTaskId
          ? answerable.find((t) => t.taskId === declaredTaskId) ?? null
          : reference ? findReferencedTask(answerable, reference.taskRef) : null;
        if (reference && !referenced && answerable.length && channelArn) {
          // ANSWERED, NOT IGNORED, AND ONLY TO THE SENDER. Falling through would let the ranked path
          // attach the reply to whatever ranks first, which is the silent wrong pick a reference exists
          // to prevent. Nothing else was open for them at all ⇒ the message is not a reply to anything
          // and is answered as ordinary conversation, so "#1 priority is revenue" still gets an answer.
          const { copy } = await turnWords();
          const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
          console.log('[Router] a reference named nothing this person may answer', {
            taskRef: reference.taskRef, answerable: answerable.length,
          });
          if (senderArn) {
            await sendInParts(chimeClient, {
              ChannelArn: channelArn,
              text: formatReferenceNotFound(
                { copy },
                reference.taskRef,
                answerable,
              ),
              Type: ChannelMessageType.STANDARD,
              Persistence: ChannelMessagePersistenceType.PERSISTENT,
              ChimeBearer: botArn,
              Target: [{ MemberArn: senderArn }],
              Metadata: botMessageMetadata(spoke.attribution, { targetedSender: senderArn }),
            }).catch((err: unknown) => {
              console.warn('[Router] could not send the reference not-found reply', { err: (err as Error)?.message });
            });
          }
          return formatLexSilentResponse(event);
        }
        if (referenced) {
          // A PRIVATE ITEM IS ANSWERED PRIVATELY, whatever the message was. The turn
          // runs, and its delivery sends anything about the item only to the person, leaving the room a
          // line that says they were answered privately (`planResumedChainDelivery`).
          // THE ITEM IS FIXED. No candidates travel, so the turn has nothing to redirect to: the person
          // said which item this is, and the model does not get to re-decide it.
          referentCandidates = [];
          referentCandidateIds = [];
          taskResolution = declaredTaskId ? 'id' : 'reference';
          console.log('[Router] the reply named its item', {
            taskId: referenced.taskId,
            namedBy: declaredTaskId ? 'metadata' : 'reference',
            ...(reference ? { taskRef: reference.taskRef } : {}),
          });
        } else if (heldByPerson.length) {
          // A DECLARED ID THAT NAMES NOTHING falls through to ranking rather than refusing. It means
          // the item closed, or moved, between the client reading it and this turn running - the
          // person's words are still an answer to something, so the turn treats them as one and asks
          // rather than telling them an id they never saw is invalid.
          if (declaredTaskId) {
            console.log('[Router] the declared item is no longer answerable by this person; ranking instead', {
              declaredTaskId, answerable: answerable.length,
            });
          }
          taskResolution = 'ranked';
        }
        const owed = heldByPerson.find((t) => t.taskId === referents[0]?.taskId) ?? heldByPerson[0] ?? null;
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
        // NEW WORK OF ANOTHER KIND IS NOT THE AWAITED ANSWER: it opens its own task, and the waiting one
        // stays where it was (`opensOtherWorkThan`, task-continuity.ts).
        //
        // THE CANDIDATES IN THE ORDER ABOVE, not only the first. When this assistant's own chain is set aside
        // as other work, another chain the person holds may be exactly what the message answers (another
        // assistant's troubleshooting question, say), and it is that one's answer. An item they NAMED is fixed.
        // In a conversation holding a live duel the earlier rule stands: the first candidate is the answer.
        const waitingCandidates = [mineWithThisPerson, owed, ...heldByPerson]
          .filter((t, i, all): t is NonNullable<typeof owed> => !!t && all.findIndex((x) => x?.taskId === t.taskId) === i);
        const firstCandidate = waitingCandidates[0] ?? null;
        // The first candidate the message is not other work for. In a live duel the first is never set
        // aside; the duel is read once (`duelHere` is memoized), so later candidates are the rule alone.
        let answered = referenced ?? null;
        if (!referenced) {
          for (const t of waitingCandidates) {
            if (!(await otherWorkThan(t, duelHere))) { answered = t; break; }
          }
        }
        if (!referenced && firstCandidate && answered !== firstCandidate) {
          console.log('[Router] the message opens other work; the waiting task is left as it was', {
            waitingTaskId: firstCandidate.taskId,
            waitingTaskType: firstCandidate.taskType,
            opens: classification.intent,
            ...(answered ? { answersInstead: answered.taskId } : {}),
          });
        }
        // ROUTING FOLLOWS THE TASK (rule 1). The chain names the assistant whose work it is, and if
        // that is not this one, this one stands aside rather than answering work it does not own. Not
        // attempted on a turn that ARRIVED by handover: that assistant owns the chain by construction,
        // and the bound on the hop is that only a turn without the marker may make one.
        if (answered && !handedOverFrom(event) && !arrivedByHandover(event) && channelArn && personId
            && answered.assistantId && answered.assistantId !== principalIdFromArn(botArn)) {
          const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
          const handed = senderArn && await handOverToOwningAssistant({
            task: answered,
            event,
            channelArn,
            senderArn,
            selfBotArn: botArn,
            classificationBotArn,
            attribution: spoke.attribution,
            words: await turnWords(),
          });
          // Silence, because everything this turn owed is already said or under way: the person has
          // their receipt, and the answer is the owning assistant's to give.
          if (handed) return formatLexSilentResponse(event);

          // ── A FAILED HANDOVER DOES NOT ANSWER, AND DOES NOT REASSIGN ─────────
          //
          // Falling through from here answered the message as THIS assistant and applied it to the
          // chain with `assistantId = self`, which moves another assistant's work onto this one on
          // the strength of a transient failure - an invoke that threw, a sanction lookup that could
          // not be read. The person is then answered by an assistant that does not own the work, and
          // the owner loses it without anything saying so.
          //
          // So the chain is left exactly where it was, and the person is told the owner could not be
          // reached. Their message is not lost: it is still in the conversation, and sending it again
          // retries the handover, which has recorded nothing for this message (the handover mark is
          // written only after a dispatch that stood).
          //
          // A REPLY TO THEIR MESSAGE, so it takes that message's visibility: the room already saw an
          // untargeted answer, and a targeted one gets a targeted reply.
          console.warn('[Router] the handover failed; not answering in the owning assistant\'s place', {
            taskId: answered.taskId, owningAssistantId: answered.assistantId,
          });
          const ownerName = await owningAssistantDisplayName(
            `${botArn.substring(0, botArn.lastIndexOf('/') + 1)}${answered.assistantId}`,
          );
          return formatLexResponse(event, [{
            contentType: 'PlainText',
            content: templateLine('handover-owner-unavailable', await turnWords(), { values: { name: ownerName } }),
          }]);
        }
        // NOT WHEN THIS SYSTEM SENT THE TURN. A prompt written here is not a candidate answer to
        // anything. This is defense rather than the fix: the judgement below already declines what it
        // cannot settle, and what actually swallowed the reading was the ROUTING above, not this.
        if (answered && !isMachineWrittenTurn(event) && !isAmendmentFold(event)) {
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
          // A REDELIVERY OF THE REQUEST THAT OPENED THE TASK is not its answer (`applyUserResponseToTask`
          // refuses it). Nothing was handed back, so nothing resumed: the task is not made this turn's
          // active task, and the turn goes on to the duplicate check, which replays the first
          // delivery's placeholder.
          if (applied.reason === 'opened_by_this_message') {
            console.log('[Router] this message opened the waiting task, so it is not its answer', {
              taskId: answered.taskId,
            });
          } else {
            console.log('[Router] user response applied to the awaited task', {
              taskId: answered.taskId, ...applied,
            });
            // Either way the chain continues on this turn: an applied advance has already moved the
            // machine and handed the work back, and a deferred branch has handed it back for the model
            // to resolve with `advance_task_state`.
            activeTask = answered;
            // Something WAS waiting on this person and this message answered it, so the turn is a
            // continuation however short the message is.
            //
            // ONLY IF SOMETHING ACTUALLY ENGAGED, and the two refusals are not hypothetical: the person
            // can hold a task whose CURRENT state awaits nobody (`not_awaiting`, task-tracking.ts), or
            // whose machine is not in this deployment's pack (`no_machine`). Neither hands the work
            // back, so nothing resumed - and calling it a continuation anyway spends a full worker turn
            // on the classification floor for a "thanks" that answered nothing, because
            // `continuesActiveWork` reads this. `deferred_to_model` DOES count: the reply handed the
            // work back for `advance_task_state` to resolve, which is the one-answer path.
            //
            // Stated as what does NOT count, so an unrecognized future reason still resumes. A missed
            // resume is the deterministic-strand class this branch exists to close; a wrongly-resumed
            // turn only costs money.
            if (applied.reason !== 'not_awaiting' && applied.reason !== 'no_machine') {
              resumedWaitingWork = true;
            } else if (applied.reason === 'not_awaiting' && stalledStepCandidateHere(answered)) {
              // A STEP THIS ASSISTANT HOLDS, FOUND IN THE PERSON'S PARTITION. A task opened at a step the
              // assistant works is filed under its requester, so a turn that ended there without
              // advancing is found here rather than in this assistant's partition. It is the same
              // candidate the own-chain lookup marks, and the one-thread rule below decides whether it
              // is still running (declined) or stalled (resumed).
              stalledStepCandidate = true;
              console.log('[Router] the message is this person\'s work that this assistant holds', {
                taskId: answered.taskId, taskType: answered.taskType, taskState: answered.taskState,
              });
            }

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
          // The rule the lookup above applies (`otherWorkThan`): this assistant's own waiting chain does
          // not absorb new work of another kind either.
          if (!mine) {
            // A chain the assistant still holds (its state does not await anyone) or one written
            // before `assistantId` existed. A DIFFERENT partition (the bot as owner), so this one
            // is a real read - and it is where a FINISHED chain's mirror row lives too, since a report
            // is handed back to the assistant before it completes. Same query, both answers; the
            // short-circuit above is kept so a person already holding this assistant's chain still
            // costs nothing here.
            const ownTasks = prefetchedOwnTasks ?? await getAssigneeChannelTasks(
              principalIdFromArn(botArn), channelArn, { endedWithinMs: RECENTLY_ENDED_WINDOW_MS },
            );
            ownLive = ownTasks.live;
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
          // "I cannot go further without an answer from this party", and it is the whole license for
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
          if (mine && blockedOnAPerson && !(await otherWorkThan(mine, duelHere))) {
            // WHO IS THIS WAITING ON. A duel's answer belongs to the person who started it,
            // and the pointer is where that is recorded; for any other assistant-owned chain
            // it is the requester. A message from anyone else does not advance it - they are not
            // refused, their turn is simply answered as ordinary conversation.
            const duel = await resolveActiveBattle(channelArn);
            // The mirror row carries the assignee, not the requester ARN, so those are the two
            // sources: the duel's owner from the pointer, else whoever the task was assigned to.
            // Neither recorded ⇒ nobody is named, so the chain answers to whoever speaks rather than
            // becoming unanswerable - the same fail-open the duel rule takes.
            const waitingOn = duel?.initiatorUserSub ?? mine.assigneePersonId;
            if (waitingOn && personId && waitingOn !== personId) {
              console.log('[Router] a chain this assistant owns is waiting on someone else; not advancing it', {
                taskId: mine.taskId, speakerIsWaitedOn: false,
              });
            } else if (isSelfDispatchedTriage(event)) {
              // Same rule as above, and defense for the same reason: the chain waits on a person, and
              console.log('[Router] a self-dispatched triage turn is not a chain answer; leaving the chain', {
                taskId: mine.taskId,
              });
            } else {
              const applied = await applyUserResponseToTask({
                taskId: mine.taskId,
                channelArn,
                assistantId: principalIdFromArn(botArn),
                machines: taskStateMachines(),
                messageId: inboundMessageId(event),
              });
              // The same refusal as the person's branch, for a chain found only in this assistant's
              // partition: the request that opened it is not its answer, so nothing resumed.
              if (applied.reason === 'opened_by_this_message') {
                console.log('[Router] this message opened the chain, so it is not its answer', {
                  taskId: mine.taskId,
                });
              } else {
                activeTask = mine;
                // THE SAME RULE AS THE PERSON'S BRANCH: only a reply that handed the work back resumed it.
                // `not_awaiting` means the row has already moved on (the mirror lagged), so this message is
                // not the awaited input and must still meet the one-thread decline below.
                if (applied.reason !== 'not_awaiting' && applied.reason !== 'no_machine') {
                  resumedWaitingWork = true;
                }
                console.log('[Router] resuming the chain this assistant owns', {
                  taskId: mine.taskId, ...applied,
                });

                // A duel side blocked on the user is ALSO a battle row, and round 2 stays suspended
                // until it leaves `WAITING_FOR_USER`. The SAME call as the person-owed branch above, and
                // deliberately not a second copy: one of the two paths having a resume and the other not
                // is exactly the defect that left both sides of a live duel parked forever.
                battleCtx = battleCtx ?? (await resumeDuelSideIfWaiting(channelArn, botArn)) ?? undefined;

                // THE ANSWER/RECEIPT SPLIT NEEDS A PUBLIC TO SPLIT FOR, and this branch set it
                // unconditionally.
                //
                // `broadcastAnswer` makes the turn post its answer as a NEW untargeted message and leave
                // the private placeholder holding "Thanks - picking that back up. My answer is in the
                // conversation." That is right in a room: the person targeted the assistant, so the reply
                // Amazon Chime SDK posts is private, and burying a task result where only its sender can
                // read it is the defect the split exists to fix.
                //
                // In a 1:1 there is nobody else to read it. The person gets their answer AND a note
                // telling them the answer is somewhere else, which reads as the assistant replying to
                // itself - and because that note is targeted, it latches the client's sticky target, so
                // their next message goes out addressed rather than spoken to the room.
                //
                // The duel branch above already states this rule in its own comment ("an ordinary task
                // continuation in a 1:1 has no public to broadcast to, and would gain only a receipt
                // nobody needs") and scopes itself accordingly. This branch is that ordinary task
                // continuation, and did not.
                //
                // A duel always broadcasts: it is a comparison, and a channel running one has two bots in
                // it anyway. Unknown size resolves to "not 1:1", which keeps today's behavior rather
                // than inventing a new one on an unreadable read.
                if (battleCtx) {
                  resumedOwnChain = true;
                } else {
                  const size = await resolveChannelSize(chimeClient, channelArn, botArn);
                  // NOT NAMED IN ADR-045, AND IT IS A REAL ONE. The record lists the mention and
                  // private-address reads; this third one is reached by a flow-entry turn, which takes
                  // neither of those guards. A refusal here used to resolve to "not a 1:1" and carry on
                  // splitting off a receipt in a room this assistant may not act in.
                  if (size.refused) {
                    return refuseAtClassificationBoundary(event, channelArn, 'channel-size:chain-resume');
                  }
                  resumedOwnChain = !size.isOneToOne;
                  if (size.isOneToOne) {
                    console.log('[Router] 1:1 chain resume - answering in place, no receipt to split off', {
                      taskId: mine.taskId,
                    });
                  }
                }
              }
            }
          }
          // A STEP THIS ASSISTANT HOLDS, OF THIS PERSON'S OWN WORK, AND THE MESSAGE IS THAT WORK.
          //
          // The rule above stands for anyone else's message and for anything the classifier did not place
          // as this work: a chain in progress does not absorb what someone says. When the requester asks
          // for exactly this work, the task is the turn's, so the one-thread rule below decides whether
          // it is still running (declined) or stalled (resumed) instead of a second task being opened
          // beside it (`resumesAStalledStep`, task-continuity.ts).
          if (!activeTask && !battleCtx && personId) {
            const stalled = ownLive.find((t) => stalledStepCandidateHere(t));
            if (stalled) {
              activeTask = stalled;
              stalledStepCandidate = true;
              console.log('[Router] the message is this person\'s work that this assistant holds', {
                taskId: stalled.taskId, taskType: stalled.taskType, taskState: stalled.taskState,
              });
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
          if (duel && (!waitingOn || !personId || waitingOn === personId)) {
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

        // THE LOOKUP FOR A TURN THAT HAS NO CHANNEL TO SCOPE TO, and only that turn.
        //
        // This was written as the requester-keyed question - "what does this person have open at
        // all", as against "what is waiting on them" - and that was a real distinction before
        // ADR-024. It is not one now. The mirror row is partitioned by the CURRENT OWNER
        // (`putMirrorRow`), so this reads the same partition as the channel lookup above, which
        // already returns every live row in it for this channel: paginated with no Limit, strongly
        // consistent, and not narrowed by task type. Per type this is the same partition key, the
        // same channel filter and the same active statuses with a type filter added - strictly
        // weaker than a read the turn has already made, and it cannot name a row that read missed.
        //
        // So with a channel it found nothing and cost up to two DynamoDB reads per declared machine
        // on the most ordinary turn there is (a GSI query, then the strongly-consistent base-table
        // re-check behind it). Skipped rather than deleted: a channel-less turn makes no owner read
        // at all - `getAssigneeChannelTasks` needs a channel for its filter - so there this is the only
        // lookup, and removing it would remove a lookup rather than a duplicate.
        //
        // NOT FOR A SHORT MESSAGE, unchanged: letting a bare "thanks" be absorbed by an open chain is
        // a message annexed by work it was not about.
        if (!activeTask && !shortAcknowledgment && !channelArn) {
          // EVERY declared task type, from the authoritative machines - not a hand-maintained list.
          // The literal trio this replaces omitted place_item/action_item and any pack-defined type,
          // so a continuation that missed the owner lookups found nothing here and the multi-step
          // branch opened a fresh task beside the live chain; the next machine anyone adds drifted
          // the same way with no error.
          for (const candidateType of Object.keys(taskStateMachines())) {
            activeTask = await getActiveTask(personId, candidateType);
            if (activeTask) break;
          }
        }
      }
    }
    // The requester-keyed fallback and both resume branches can each be the first to name live work,
    // so the last word is taken once, here, rather than repeated at every site that assigns a task.
    liveTaskInChannel = liveTaskInChannel || !!activeTask;
    // The conversation's live work is settled. Marked at the one place the answer is final, for the
    // same reason `liveTaskInChannel` is assigned here: every branch above can be the one that found
    // it, and a mark per branch would measure whichever branch ran rather than the step.
    markRouterStep('task_resolved');

    // A SHORT ANSWER TO A WAITING QUESTION IS NOT A PLEASANTRY, so the classification is corrected
    // here - once, in the same place and for the same reason as the attachment correction above. The
    // fault is the label, not the three things that read it: `quickReply` answers "Let me know
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
      // A FINISHED REPORT IS STILL REVISABLE, so a follow-up from its requester is answered against it
      // (`reopenableFollowUpSubject`, task-continuity.ts). The task stays ended and stays out of the
      // open-work list; this turn is handed it so the model can take the declared reopen if, and only
      // if, the person is asking for changes. `liveTaskInChannel` is left alone: nothing is running.
      //
      // NOT FOR A SHORT ACKNOWLEDGMENT. "thanks" after a delivery keeps its quick reply and its unspent
      // model call; a bare token is never a change request.
      if (
        !activeTask && !battleCtx && !shortAcknowledgment && ended
        && reopenableFollowUpSubject({
          task: ended,
          endedWithinWindow: recentlyEndedWithinWindow,
          assistantId: principalIdFromArn(botArn),
          senderSub: personId,
          reopenTargets: (type, state) => reopenTargetsFrom(type, state, taskStateMachines()),
          // NOT FOR NEW WORK OF ANOTHER KIND. The same opening rule the TASK_MULTI_STEP branch below
          // applies: an intent owns the machine of its own name when one exists and may be opened.
          // A turn that would open a different workflow opens it, rather than continuing the report.
          turnOpensTaskType: turnOpensOtherWorkKey(),
          keptHereAs: turnKeptHereAs(),
        })
      ) {
        activeTask = {
          ...recentlyEndedTaskHere,
          taskType: ended.taskType ?? recentlyEndedTaskHere.taskType,
          taskState: ended.taskState,
          status: ended.status,
        };
        console.log('[Router] a follow-up on a finished, revisable task; the turn may reopen it', {
          taskId: activeTask.taskId,
          taskType: activeTask.taskType,
          taskState: activeTask.taskState,
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

    // NOT ON A TRIAGE TURN, which is a machine-written classification step and not somebody
    // changing the subject.
    //
    // A triage turn embeds the queued messages verbatim in its own `userMessage`, so an unrelated
    // queued topic - precisely what a queue full of new subjects contains - reads as drift. Drift
    // RETURNS from here, before the claim and the dispatch, so the reading never reached the
    // processor: `clearQueue` never ran, the triage claim stayed held across a drain that would
    // never happen, and the messages sat queued being shown to the person as waiting.
    //
    // Same exclusion, and the same reason, as the awaited-task region and the task-resume region
    // above: a turn the machine wrote to itself is not a person speaking.
    // AND THAT INCLUDES A STOP EVALUATION (code review, 2026-09-04). This named the triage guard
    // rather than the machine-written one, while the comment above claims the same exclusion as the
    // two regions that use `isMachineWrittenTurn`. A stop evaluation's `userMessage` is
    // `buildStopEvaluationPrompt(...)` - text this system wrote to itself - and it was handed to drift
    // as though somebody had typed it. Drift firing on it returns below, so the judged half of the
    // stop is never dispatched: the person is told their work is HELD and then never asked what to do
    // with it, which is the one thing the judged half exists to prevent.
    // ── DEFINED HERE SO ONE TURN RESOLVES ONE TIME (2026-09-10) ──────────────────────────────────
    //
    // This used to sit two hundred lines below, AFTER the drift check - and drift resolves the same
    // fact for its own row. So a turn that fired drift and then opened a task paid TWO
    // `ListChannelMessages` for one message, in one invocation, seconds apart. The memo below is
    // handed to drift as `resolveInbound`, so whichever of them needs it first pays, and the other
    // gets the answer.
    //
    // STILL LAZY. Moving it earlier does not start it earlier: nothing here calls it, and a turn that
    // neither drifts, queues nor opens a task still pays nothing.
    // WHICH MESSAGE THIS TURN ANSWERS, AND WHETHER IT WAS ADDRESSED PRIVATELY - resolved once, here.
    //
    // Amazon Chime SDK sends Lex neither fact, and BOTH are needed before the task row is written. A
    // task stored without its visibility reads as private, so an untargeted request whose addressing
    // was never read is withheld from the room it was sent to. The processor narrows a row once the
    // placeholder comes back targeted, and never widens one, so the row has to be right when written.
    //
    // ONE LOOKUP ANSWERS BOTH, because `ChannelMessageSummary` carries `Target`: the listing that
    // identifies the message is already holding its addressing. The queued branch below wants the id
    // and the answering branch wants the visibility, and they are exclusive - so this is the SAME
    // single channel read the queued path was already paying, now also spent on the turn being answered.
    //
    // LAZY, AND THAT IS DELIBERATE. Starting it here would overlap it with the work in between and cost
    // the answering turn nothing in latency - but most turns that reach this point neither queue nor
    // open a task (a resumed chain, an ordinary question), and those would each pay a channel read for
    // an answer nobody asks for. The rule this path already follows is to spend the read on the branch
    // that needs it, so the cost lands on task creation and on queueing, and nowhere else.
    let inboundLookup: Promise<{ messageId: string; targeted?: boolean }> | null = null;
    // THE ID, ONCE THIS TURN HAS IT FOR ANY REASON. A bypass declares it; a task-shaped turn resolves
    // it for the task row. Kept here so the hand-off can pass it on rather than have the processor pay
    // a second channel read for an answer this turn already has - and left empty on the turns that
    // never needed it, which is the whole point of the lazy lookup below.
    // ── AND THE LEX PATH DOES NOT HAVE ONE. MEASURED, NOT ARGUED (2026-09-10) ────────────────────
    //
    // Amazon Chime SDK sends a Lex turn exactly three request attributes: `CHIME.channel.arn`,
    // `CHIME.sender.arn` and `x-amz-lex:channels:platform`. The message id is not among them, and
    // neither is `CHIME.mentions` - that one is a MESSAGE attribute the channel flow reads, never a
    // Lex request attribute.
    //
    // THE INSTRUMENT, so this never has to be argued from comments again: Lex text conversation logs
    // are enabled on every assistant's bot alias (`assistant-provisioner.ts`, and `AssistantLexConversationLogs`
    // in `Messaging`) and record `requestAttributes` verbatim on every turn. Swept across
    // fourteen days of those logs on all three classifications, `CHIME.message.id` occurs zero times.
    //
    // THIS FILE ASSERTED THE OPPOSITE, in a comment written with no measurement behind it, and the
    // read it justified could never fire. `inboundMessageId` reads the attribute anyway because a
    // BYPASS caller declares the same fact as `AE.message.id` - so the accessor is right and only the
    // claim about the Lex path was wrong. What an ordinary turn has instead is the lazy lookup below.
    let knownInboundMessageId = event.requestAttributes?.[BYPASS_MESSAGE_ID_ATTR] || '';
    // ── A HANDED-OVER TURN ANSWERS THE HANDOVER, NOT THE PERSON ──────────────
    //
    // The primary's acknowledgment is ITS response to the person, and pairs with the person's message
    // as the primary's exchange. The handover message is where THIS assistant's work starts, so this turn
    // declares the handover as what it answers: its exchange is (handover, reply) and its end to end is
    // measured from the handover, not from a person's message the other assistant already answered.
    // `knownInboundMessageId` stays the person's message, which is what the turn reads and what its task
    // rows record.
    const handoverMessageIdForTurn = arrivedByHandover(event)
      ? (event.requestAttributes?.[BYPASS_HANDOVER_MESSAGE_ATTR] || '')
      : '';
    const declaredAnswerId = (): string => handoverMessageIdForTurn || knownInboundMessageId;
    const inboundMessage = (): Promise<{ messageId: string; targeted?: boolean; createdAt?: string }> => {
      inboundLookup ??= resolveOriginatingMessage({
        event,
        channelArn,
        senderArn: event.requestAttributes?.['CHIME.sender.arn'] || '',
        botArn,
        // The text AS SENT, not the text handed to the model: this lookup compares against stored
        // content, so a stripped private address makes it miss every time.
        userMessage: inboundText,
      }).then((r) => {
        knownInboundMessageId ||= r.messageId;
        return r;
      }).catch(() => ({ messageId: '' }));
      return inboundLookup;
    };

    /**
     * THE PLACEHOLDER NAMES WHAT IT ANSWERS, WHENEVER THIS TURN ALREADY KNOWS.
     *
     * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────────────────────
     *
     * The declaration used to ride the closing UPDATE alone (`closeOutAttribution`,
     * `buildAnalyticsMetadata`). Kinesis archival batches on a five second window, so a turn whose
     * time to first feedback exceeds five seconds cannot have its user message and its placeholder in
     * one batch: the in-batch pairer never sees the turn, the cross-batch sweep mints the exchange
     * from the placeholder CREATE alone, and at that moment every carrier of the declaration is still
     * NULL. The sweep therefore records `paired_by = 'swept'`, which the Latency tab excludes from
     * TTFF by design - so the slowest turns, the ones the SLO exists to catch, were the ones dropped.
     *
     * Declaring on the CREATE removes the race for those turns: the fact is in the row the sweep
     * reads, at the moment it reads it.
     *
     * ── THE CARRIER IS CONTENT, BECAUSE A PLACEHOLDER HAS NO OTHER ───────────────────────────────
     *
     * Amazon Chime SDK materializes this message from the Lex fulfillment return, and a fulfillment
     * return carries messages and session attributes - not message metadata. So the 1024 byte
     * Metadata cap is not reached at all here; the declaration travels the same way a DIRECT answer's
     * does, through `withTurnDeclaration`, which archival already folds to
     * `messages.answers_message_id`. A bypass caller posts this content verbatim
     * (`postHandedBackMessage`), so both entries carry it from one composition.
     *
     * ── WHEN KNOWN, NEVER AT ANY PRICE ───────────────────────────────────────────────────────────
     *
     * Only from the id this turn already holds: a bypass declared it, or a task row, a queue or the
     * stop path already paid the channel read for it. Buying a `ListChannelMessages` here would put
     * the read in front of the person's first frame, which is precisely what
     * `recordWhatThisTurnIsAnswering` moved OUT of the router and into the processor. A turn that does
     * not know declares nothing, keeps the exact content it posted before, and is repaired by the
     * update fold instead (`backfillFromUpdateEvents` promotes its swept label once the declaration
     * lands).
     *
     * NO PHASE IS DECLARED. This message is a placeholder and something else closes it; declaring
     * `final` here would close the response the instant it opened.
     */
    // HOW THIS TURN ENTERED, declared on everything this handler writes.
    //
    // It rides the analytics metadata too, and that metadata does not always reach archival: it is
    // slimmed in Aurora mode (`entry` is not a kept key) and a `DIRECT` answer materialized from a
    // Lex fulfillment carries none at all. `delivery` survived both because archival falls back to
    // the content declaration; `entry` had no such fallback, so it was lost on exactly those turns.
    // It is a property of the INVOCATION and known here for nothing, so it is declared rather than
    // recovered later.
    const turnEntry = isFlowEntry(event) ? 'flow' as const : 'lex' as const;
    // A JOIN RECAP ANSWERS NO MESSAGE: it catches up a person who was just added, so it declares its kind
    // and the archive never pairs it with whatever preceded it, in the batch or across batches.
    const recapKind = isJoinRecap(event) ? { kind: 'join_recap' as const } : {};
    const placeholderContent = (body: string): string => withTurnDeclaration(
      body,
      declaredAnswerId() ? { answers: declaredAnswerId(), entry: turnEntry, ...recapKind } : { entry: turnEntry, ...recapKind },
    );

    // ── THE STOP QUESTION OWNS ITS FOLLOW-UP (ADR-033, owner 2026-09-14) ─────────────────────────
    //
    // A `/stop` cancelled this person's work and asked how they want to proceed. Their answer is this
    // message or a later one, in their own words, and ordinary routing cannot be trusted with it:
    // measured live, "Drop it, I do not want that report" was classified `intent: general` and
    // answered conversationally. So the message is read against the question HERE, before drift, the
    // declining guard, the quick reply or task routing can each claim it for something else.
    //
    // THREE READINGS, AND EACH ENDS THE QUESTION:
    //   leave - the work stays cancelled; confirmed in this assistant's configured words, and done.
    //   again - the message is routed as the request it restarts: what they originally asked for,
    //           followed by what they just said about it, classified afresh so it opens its task.
    //   other - it was about something else, and it is routed exactly as sent.
    // No reading at all (the model call failed) leaves the question standing and routes the message
    // as sent, so the next message is read again rather than an answer being invented.
    //
    // A MODEL CALL, NOT A WORD LIST, because the decision is taken from what somebody said and has to
    // survive a conversation held in another language (tenet D11). It is the classifier model, and it
    // runs only on the one message after a stop question - including on a keyword-mode profile, which
    // opted out of paying for intent labels, not out of having its stop answers understood.
    //
    // AS THE SPEAKER: a question put to one person is not another member's to answer.
    if (!isMachineWrittenTurn(event) && !isAmendmentFold(event) && channelArn && personId) {
      const stopResponderId = principalIdFromArn(botArn);
      const stopQuestion = await readStopDecision({
        channelArn, responderId: stopResponderId, speakerId: personId,
      }).catch(() => undefined);
      if (stopQuestion) {
        const answer = parseStopAnswer(await classifierReading(
          buildStopAnswerReading({ requests: stopQuestion.requests, message: userMessage }),
          { modelId: classifierModelId },
        ));
        console.log('[Router][stop] the stop question read the next message', {
          channelArn,
          answer: answer ?? 'no reading; the question stays open',
          cancelled: stopQuestion.taskIds.length,
        });
        if (answer) {
          await clearStopDecision({ channelArn, responderId: stopResponderId })
            .catch((err: unknown) => console.warn('[Router][stop] could not clear the stop question', err));
        }
        if (answer === 'leave') {
          return formatLexResponse(event, [{
            contentType: 'PlainText',
            content: templateLine('stop-left-cancelled', await turnWords()),
          }]);
        }
        if (answer === 'again') {
          // THE REPLY TAKES THE VISIBILITY OF THIS MESSAGE, so whether a privately made request may be
          // restored depends on whether this message was itself private. Resolved only when a private
          // request is actually at stake, because it costs a channel read.
          const followUpIsPrivate = stopQuestion.requests.some((r) => r.private)
            ? !!(await inboundMessage()).targeted
            : false;
          const restarted = restartedRequest({
            requests: stopQuestion.requests, followUp: userMessage, followUpIsPrivate,
          });
          if (restarted) {
            userMessage = restarted;
            // CLASSIFIED AFRESH, IN PLACE. The label above was for "yes, start it again", which reads as
            // general; the restarted request is what decides whether a task opens. Assigned into the
            // same object because everything below reads `classification.intent` from it.
            Object.assign(classification, usesLlmClassifier
              ? await classifyIntent(restarted, { modelId: classifierModelId })
              : classifyIntentByKeyword(restarted));
            console.log('[Router][stop] restarting the cancelled work as asked', {
              channelArn, intent: classification.intent,
            });
          } else {
            // Every cancelled request was private and this message is not: restoring one here would
            // publish it. Routed as sent, which is what they typed in the room they typed it in.
            console.log('[Router][stop] asked to restart, but nothing may be restored into a public reply', {
              channelArn,
            });
          }
        }
      }
    }

    // A ROOMMATE KEY THIS TURN CANNOT ACT ON IS READ BACK BEFORE ANY DECISION READS THE INTENT. A duel side
    // (declared or resumed) is never delegated and a turn with no roommates has nobody to delegate to, so
    // for those the synthetic key is already known to stay: the drift, refusal and image-capability checks
    // below decide on this assistant's own intent rather than on a key no pack declares. A turn that may
    // still hand over keeps the key until the delegation decision, and is read back there if it stays.
    if ((battleCtx || roommates.length === 0) && parseDelegationKey(classification.intent)) {
      const kept = intentKeptHere(classification.intent, profileIntentPack ?? getIntentPack());
      console.log('[Router] a roommate key on a turn that cannot hand over; reading it back into this taxonomy', {
        classifiedIntent: classification.intent, intent: kept,
      });
      classification.intent = kept;
    }

    // A DUEL SIDE'S TURN IS NOT CHECKED FOR DRIFT. Its message is the `/battle` prompt, whose subject is the
    // duel, not the conversation moving on; and drift firing here makes the side answer with an offer instead
    // of its round-1 answer, so round 2 never fires (measured 2026-10-15: B-E4's fourth duel, whose prompt
    // changed subject from the third, stranded on "It looks like you're shifting topics"). The person's own
    // messages between duels are still checked.
    //
    // A REQUEST THIS ASSISTANT WILL REFUSE IS NOT DRIFT. The refusal below names where the thing is offered;
    // offering to split the conversation out for something the assistant then refuses helps nobody, and
    // since every turn is compared with the conversation's subjects such a request is usually a new
    // subject, so drift answered first and the person never learned it is not offered here (2026-10-16,
    // capability-refusal e2e). Decided once, here, and the refusal below reads the same decision.
    const servedIntentDef = profileIntentPack?.intents.find((d) => d.key === classification.intent)
      ?? { key: classification.intent };
    const imageUnavailable = needsOf(servedIntentDef) === 'image' && !classificationAllows(effectiveClassification, 'image');
    const willRefuse = !!channelArn && ((!battleCtx && (classification as { refused?: boolean }).refused) || imageUnavailable);
    const driftResponse = isMachineWrittenTurn(event) || isAmendmentFold(event) || battleCtx || willRefuse ? null : await runLiveDriftFlow({
      event,
      words: await turnWords(),
      channelArn,
      userMessage,
      personId,
      classification: effectiveClassification,
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
      // The turn's one resolution, shared. Optional on the type, so a caller without one still
      // resolves for itself exactly as before.
      resolveInbound: inboundMessage,
      onDecision: (d) => { turnSubjectDecision = d; },
      onHeldQuestion: (q) => { turnHeldQuestion = q; },
    });
    // Drift has run, or declined to. Marked BEFORE the early return below, so a turn that drift
    // answered records how long the check took even though it never reaches a placeholder - which is
    // the turn where knowing matters most, since the person waits the whole span for a drift offer.
    markRouterStep('drift_checked');
    if (driftResponse) {
      // ── AN OFFER ON A TARGETED REQUEST IS TARGETED (DESIGN-TASK-ACCESS 2.4) ─────────────────────
      //
      // Privacy is a property of the request, and the offer is what that request produced. A Lex reply
      // inherits the message's `Target` already; a flow entry is posted by `postAsAssistant`, which
      // targets only what `AE.turn.targeted` declares. The flow declares `0` for "not addressed in the
      // text", which is not "sent without a `Target`", so a declaration short of `1` is checked against
      // the stored message, the same read the task's visibility takes below. Measured: an offer to a
      // targeted request posted to the whole room.
      if (isFlowEntry(event) && channelArn && event.requestAttributes?.[BYPASS_TARGETED_ATTR] !== '1') {
        const offeredFor = (await inboundMessage()).messageId;
        // An offer whose request cannot be read back fails toward PRIVATE: a public offer to a private
        // request discloses it, and a private offer to a public one costs only a courtesy.
        if (offeredFor && await inboundTarget(chimeClient, channelArn, offeredFor, await getBotArn()) !== 'public') {
          event.requestAttributes = { ...(event.requestAttributes || {}), [BYPASS_TARGETED_ATTR]: '1' };
          console.log('[Router] the drift offer answers a targeted request; targeting it at the sender', {
            channelArn, messageId: offeredFor,
          });
        }
      }
      return formatLexResponse(event, driftResponse.messages);
    }

    // ONE THREAD PER PIECE OF WORK (maintainer, 2026-08-20).
    //
    // Drift has already answered the question this depends on: it ran above and did not fire, so this
    // message is about the work in hand rather than a new topic. What remains is whose turn it is, and
    // the task already records that - a state that does not `await` the requester is one the ASSISTANT
    // owes. A message arriving then is not input the task is waiting for; it is someone asking about
    // work already under way.
    //
    // Starting a turn for it produced a second thread on one task: the person asked "is this task
    // complete?", the runtime re-entered report generation, and they watched their finished report be
    // written again. So the runtime declines, and says so.
    //
    // THE WAY OUT IS NAMED IN THE REPLY, and that is what makes declining safe. "The assistant owes the
    // next step" is also true of a task that has stalled, so without an escape this would answer every
    // message with the same sentence for ever. `/stop` cancels the work in this conversation; changing
    // the subject also passes, because drift runs before this and returns first.
    // A TASK NO TURN HAS BEEN GIVEN IS NOT OWED, whatever state it sits in: a message to it starts the work
    // rather than a second thread (`assistantOwesTheStep`, task-state-machines.ts). Whether a turn has been
    // given it is on the task ROW (the opening turn's correlation id, the edge log, the stall counter), not
    // on the mirror this turn resolved, so the row is read.
    //
    // NOT A MESSAGE THAT ANSWERED WHAT THE TASK WAS WAITING FOR. `resumedWaitingWork` means this message
    // is the awaited input (ADR-033), and the step it hands back is the one this turn exists to work.
    // Declining it strands the task on its own answer: a `place_item` confirmation was applied at
    // `confirming` and then declined against the mirror's `collecting` (measured live, 2026-10-16).
    //
    // AND THE STATE IS THE ROW'S. The mirror this turn resolved lags the row by the write it is a copy
    // of, so the state that decides is read from the row with the rest of the record - read whenever a
    // turn has an active task to decide on, not only when the mirror already says the step is the
    // assistant's, or a mirror lagging at an `awaits` state would wave a second turn through. One read,
    // and only on a turn that carries an active task. The platform machines are decided on the state
    // this turn holds: their rule does not depend on the row (`assistantOwesTheStep`).
    const declineMachines = taskStateMachines();
    const declinePlatform = !!activeTask?.taskType
      && (PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(activeTask.taskType);
    // A MACHINE WITH NO STATE THE ASSISTANT MOVES IS NEVER OWED, at whatever state the row holds, so its
    // row is not read (`machineHasAssistantStep`). That is the one pre-check equivalent to the read: the
    // mirror's own state is not, because it lags the row.
    const declineRow = !resumedWaitingWork && activeTask?.taskType && !declinePlatform
      && machineHasAssistantStep(declineMachines, activeTask.taskType)
      ? await getTask(activeTask.taskId, activeTask.channelArn || channelArn).catch(() => null)
      : null;
    const declineState = declineRow?.taskState || activeTask?.taskState;
    // A STALLED STEP IS RESUMED, NOT DECLINED, when the requester asks for exactly that work and nothing
    // is running or delivered (`resumesAStalledStep`). Asked only for the candidate the own-chain lookup
    // marked, and the lock is read only then, so every other turn decides exactly as before.
    const owedHere = !resumedWaitingWork && !!activeTask?.taskType && !!declineState
      && assistantOwesTheStep(declineMachines, activeTask!.taskType, declineState!, declineRow);
    if (owedHere && stalledStepCandidate && channelArn) {
      const turnState = turnQueueEnabled()
        ? await readTurnState({ channelArn, responderId: principalIdFromArn(botArn) }).catch(() => ({ busy: false, queued: [], unreadable: true }))
        : null;
      if (resumesAStalledStep({
        assistantOwesTheStep: true,
        turnQueue: turnState ? { enabled: true, busy: turnState.busy, unreadable: turnState.unreadable } : null,
        taskOwnerPersonId: activeTask!.ownerPersonId,
        speakerPersonId: personId,
        labeledAsThisWork: true,
        deliveries: declineRow ? (declineRow.deliveries?.length ?? 0) : null,
      })) {
        resumedWaitingWork = true;
        console.log('[Router] resuming a stalled step of this person\'s work', {
          taskId: activeTask!.taskId, taskType: activeTask!.taskType, taskState: declineState,
        });
      }
    }
    if (!resumedWaitingWork && activeTask?.taskType && declineState) {
      if (assistantOwesTheStep(declineMachines, activeTask.taskType, declineState, declineRow)) {
        console.log('[Router] a turn is already owed on this task; declining to start a second', {
          taskId: activeTask.taskId,
          taskType: activeTask.taskType,
          taskState: declineState,
        });
        return formatLexResponse(
          event,
          [{
            contentType: 'PlainText',
            content: templateLine('turn-already-owed', await turnWords()),
          }],
        );
      }
    }

    // ── DOES THIS TURN BELONG TO A ROOMMATE? (DESIGN-SEPARATE-ASSISTANTS 3.1b, 3.4) ──────────────
    //
    // HERE, AND THE POSITION IS THE DESIGN. After classification, so the question is only asked once
    // this assistant's own taxonomy has failed to place the message. After drift, so a person changing
    // subject is offered their own conversation before the platform offers them another assistant.
    // BEFORE the turn claim and the placeholder, so a handed-over turn is claimed by the assistant that
    // will answer it rather than by this one standing down afterwards - one responder per turn, decided
    // before anybody speaks rather than repaired after.
    //
    // THE GATE IS WHETHER A ROOMMATE COULD OWN THIS, NOT WHETHER THIS ASSISTANT FELL THROUGH.
    //
    // The first version gated on the classifier returning `general`, on the reasoning that `general` is
    // the taxonomy's own way of saying "I did not recognize this as my work". Measured on a live
    // deployment, that reasoning is false and fails in the expensive direction: asked "what is the
    // deployment error rate right now", the premium primary classified `financial_metric` with HIGH
    // confidence, because its pack advertises "ask for a figure like ARR or churn" and an error rate is
    // a figure. No fall-through ever happened, so the gate never fired, and the person got the dead-end
    // referral this feature exists to replace.
    //
    // A classifier does not know what it does not know. It places a message in the nearest category it
    // was shown, confidently, and "nearest among mine" is not "mine" - so the only question that
    // separates them is one that puts both sides on the ballot. That question is asked below.
    //
    // WHAT BOUNDS THE COST, since it is no longer the fall-through. The live assistants for this
    // classification are cached per container, so "could there be a roommate at all" is free after the
    // first turn and is `false` for every deployment that has not asked for a second assistant - those
    // reach neither the roster nor the classifier. Where a roommate does exist it costs one roster read
    // and one extra classifier call per turn, which is the price of the question being answerable.
    const delegated = await actOnDelegation({
      event,
      channelArn,
      selfBotArn: botArn,
      // NOT A DUEL SIDE, including one RESUMED from waiting on the person. The category gate above sees
      // only a declared duel turn, because a resumed side's battle context is set after classification,
      // so this is where a side is kept out of handing its own answer to somebody else.
      roommates: battleCtx ? [] : roommates,
      classifiedIntent: classification.intent,
      words: await turnWords(),
    });
    if (delegated) return delegated;
    // KEPT HERE, SO IT IS THIS ASSISTANT'S OWN INTENT (`intentKeptHere`, lib/delegation.ts). A roommate's
    // key carried past this point names the delivery option, the model route and the archived intent.
    const keptIntent = intentKeptHere(classification.intent, profileIntentPack ?? getIntentPack());
    if (keptIntent !== classification.intent) {
      console.log('[Router] the turn stays here; reading the roommate key back into this taxonomy', {
        classifiedIntent: classification.intent, intent: keptIntent,
      });
      classification.intent = keptIntent;
    }

    // BATTLE SIDE RESOLUTION, on the turn path (MESSAGE-FLOW §6.1, DESIGN-BATTLE §5a).
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
          classification: STATIC_CLASSIFICATION,
          selfBotArn: battleCtx.selfBotArn,
          ...(channelArn && { channelArn }),
          intent: classification.intent,
          need: needsOf(servedIntentDef),
          // THE SECOND DOOR, NOW GATED BY THE SAME SELECTION AS THE FIRST (ADR-047). Applied where
          // the delivery option and the task type are chosen together, so a side that may not open
          // the workflow plans a generated reply with no task type and the creation branch below is
          // never reached - rather than the task id becoming conditional for the whole battle chain.
          workflowSelection: turnWorkflowSelection,
          // Read once per turn: the sides resolved above for a declared duel, else resolved here.
          ...(duelSides && duelEntry?.battleId === battleCtx.battleId && { sides: duelSides }),
        })
      : null;

    // A RESUMED DUEL SIDE (a person answering a side's question) re-reads the experiment too: an ended or
    // paused one ends the duel rather than letting the side answer.
    if (battleCtx && battleSide?.ended && channelArn) {
      await endDuelHere({ channelArn, battleId: battleCtx.battleId, reason: 'abandoned:experiment-ended' });
      return formatLexSilentResponse(event as LexEvent);
    }

    const deliveryOptionName = battleSide
      ? battleSide.deliveryOption
      : intentToDeliveryOption(classification.intent);

    // Resolve A/B experiment (if any active experiment matches this classification + intent)
    let experimentId: string | undefined;
    let variantId: string | undefined;
    let resolvedModel: string | undefined;
    let resolvedImageModelKey: string | undefined;
    let resolvedVariantProfile: ProfileDefinition | undefined;
    /** The number of `resolvedVariantProfile`, from the pin that chose it; undefined when the pin names none. */
    let resolvedVariantVersion: number | undefined;
    /** The variant's text model, recorded in the routing record so the vend narrows to what this turn serves. */
    let resolvedModelKey: string | undefined;

    // ── A TASK STAYS ON THE ARM IT WAS OPENED UNDER WHILE THE EXPERIMENT RUNS (ADR-064 decision J) ──────────────
    //
    // The conversation's enrollment was resolved before its tasks were read, so a task that recorded its arm is served
    // that arm here, ahead of the conversation's, whenever the two differ (an enrollment read that failed soft, or a
    // conversation whose enrollment no longer names the task's arm). Once the experiment stops, its losing version is
    // no longer served and `resolveTaskArm` returns null, so the task carries on with the live version, which is the
    // version it was already on where its arm is the one that became live. Not for a duel side or an alt identity, which
    // serve the side or the candidate they were armed with.
    const openTaskArm = !battleSide && !duelEntry && !profiles.roleOfAlt(turnProfile.name) ? experimentArmOf(activeTask) : null;
    if (openTaskArm && channelArn
        && !(enrolledResolution?.experimentId === openTaskArm.experimentId && enrolledResolution?.variantId === openTaskArm.variantId)) {
      try {
        const taskArm = await resolveTaskArm(openTaskArm, activeTask?.createdAt, effectiveClassification, channelArn,
          getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || ''));
        if (taskArm) {
          enrolledResolution = taskArm;
          console.log('[Router] the task is served the arm it was opened under', {
            taskId: activeTask?.taskId, experimentId: taskArm.experimentId, variantId: taskArm.variantId,
          });
        }
      } catch (error) {
        console.warn("[Router] the task's experiment arm could not be resolved; the conversation's version serves it", {
          taskId: activeTask?.taskId, err: (error as Error)?.message,
        });
      }
    }

    // A DUEL DOES NOT DRAW A PROBABILISTIC ASSIGNMENT. Its sides are already assigned - that is what
    // makes it a controlled comparison rather than two samples - so the ordinary resolver is skipped
    // and this side's variant is used instead. Attribution rides the SAME top-level fields either
    // way, which is what lets a battle exchange reach the decision loop it exists to feed.
    if (battleSide) {
      // EVERY FIELD IS THE SIDE'S PINNED VERSION, served whole like any version (§3.5): the processor
      // answers through the version's own routes and base model, so no model is forced here. `modelKey` and
      // the image model are recorded for the routing record, so the vend narrows to what the version serves.
      experimentId = battleSide.selfVariant?.experimentId;
      variantId = battleSide.selfVariant?.variantId;
      resolvedImageModelKey = battleSide.selfVariant?.imageGenModelKey;
      resolvedVariantProfile = battleSide.selfVariant?.variantProfile;
      resolvedVariantVersion = battleSide.selfVariant?.variantVersion;
      resolvedModelKey = battleSide.selfVariant?.modelKey;
      console.log('[Router][battle] side resolved', {
        battleId: battleCtx?.battleId,
        round: battleCtx?.round,
        experimentId,
        variantId,
        displayName: battleSide.selfVariant?.displayName,
        deliveryOption: deliveryOptionName,
        imageGenModelKey: battleSide.selfVariant?.imageGenModelKey,
      });
    } else if (enrolledResolution) {
      // AN ENROLLED CONVERSATION SERVES ITS ARM'S VERSION ON EVERY TURN (ADR-050, §3.5), the greeting
      // included, resolved above before classification. The version is served whole, routes included, so
      // nothing forces a model. WHICH TURNS THE EXPERIMENT COUNTS keeps each type's meaning
      // (`countsTowardExperiment`): an `intent` experiment its intent's turns, a `classification` one the
      // turns its classifier labeled, a `base_model` one every turn but the fast-path greeting.
      resolvedVariantProfile = enrolledResolution.variantProfile;
      resolvedVariantVersion = enrolledResolution.variantVersion;
      resolvedModelKey = enrolledResolution.modelKey;
      // Only a row armed before versions were pinned carries a per-turn image model; a version carries its own.
      if (!enrolledResolution.variantProfile) {
        resolvedImageModelKey = enrolledResolution.imageGenModelKey;
        resolvedModel = enrolledResolution.bedrockModelId || undefined;
      } else {
        // The image model this turn's intent is served by: its own image route, else `image_generation`'s.
        resolvedImageModelKey = imagePrimaryForIntent(enrolledResolution.variantProfile.models, classification.intent);
      }
      // A task's turns count by its intent, whatever each message was classified as (ADR-064 decision 6): its type where
      // that is an intent, else the intent of the request that opened it (decision B).
      const activeTaskIntent = activeTask
        ? taskIntentOf(activeTask.taskType, knownIntentKeys(profileIntentPack ?? getIntentPack()), activeTask.openingIntent, undefined)
        : undefined;
      if (countsTowardExperiment(enrolledResolution, classification.intent, !!classification.classifierModelId, activeTaskIntent)) {
        experimentId = enrolledResolution.experimentId;
        variantId = enrolledResolution.variantId;
      }
      console.log('[Router] Enrolled experiment version served', {
        experimentId: enrolledResolution.experimentId, variantId: enrolledResolution.variantId,
        attributed: !!experimentId, configId: enrolledResolution.configId,
        servedVersion: enrolledResolution.variantProfile?.profileName,
      });
    } else if (channelArn && classification.intent !== IntentType.GREETING && classification.intent !== IntentType.ACKNOWLEDGMENT) {
      // AN EXPERIMENT ARMED BEFORE VERSIONS WERE PINNED (an `intent` or `base_model` row with no pins, until
      // it is paused and resumed) still resolves its variant's model per turn. Every other experiment reaches
      // a turn only through the enrollment above.
      try {
        const catalog = getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
        const experiment = await resolveExperimentModel(
          effectiveClassification, classification.intent, channelArn, catalog,
          // Decided above; a store outage there is retried here so a pinned conversation is never missed.
          enrollmentDecided ? null : await enrollmentOf(channelArn, effectiveClassification),
        );
        if (experiment) {
          experimentId = experiment.experimentId;
          variantId = experiment.variantId;
          // A version served here (the retried enrollment) answers through its routes; a model-only
          // variant overrides the turn's model as before.
          if (!experiment.variantProfile) resolvedModel = experiment.bedrockModelId;
          resolvedImageModelKey = experiment.variantProfile
            ? imagePrimaryForIntent(experiment.variantProfile.models, classification.intent)
            : experiment.imageGenModelKey;
          resolvedVariantProfile = experiment.variantProfile;
          resolvedVariantVersion = experiment.variantVersion;
          resolvedModelKey = experiment.modelKey;
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
    // Its variant changed which model LABELED this turn, which is a real assignment and belongs on
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
    /**
     * The caller's declared targeting, or `undefined` when it did not declare one.
     *
     * Only the two values the writer produces are honoured. An unrecognized string is treated as no
     * declaration rather than as `false`, so a malformed attribute leaves the task private instead of
     * publishing one - the same direction every other unknown is resolved in here.
     */
    const declaredTargeted = (): boolean | undefined => {
      const raw = event.requestAttributes?.[BYPASS_TARGETED_ATTR];
      return raw === '1' ? true : raw === '0' ? false : undefined;
    };
    const correlationId = declaredCorrelationId
      ? declaredCorrelationId
      : declaredMessageId
        ? mentionCorrelationId(declaredMessageId)
        : turnCorrelationId({
            channelArn,
            senderArn: event.requestAttributes?.['CHIME.sender.arn'] || '',
            userMessage,
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
    //
    // ── AND IT DECLARES WHAT IT ANSWERED, WHICH IS WHY THE MINT NOW SITS ABOVE IT ────────────────
    //
    // This branch used to return four lines before the correlation id existed, so the one answer in
    // the system that never carried a `<!--corr:-->` marker was the one that answered fastest. The
    // marker was missing by code ORDERING, not by any platform limit: every Lex turn reaches this
    // handler, DIRECT included. Moving the mint above the branch is the whole fix for that half, and
    // nothing between the two points depended on the id not existing yet.
    //
    // The marker alone would still only make the answer RECOGNIZABLE, not PAIRED. Archival's in-batch
    // rule took the first bot message after a user message, which under a queue pairs a deferral
    // notice or a reading's proposal with somebody else's question. So the turn names the message it
    // is answering, in the only carrier a handler-answered turn has: its own content.
    //
    // THE READ IS THE PRICE, AND IT IS THE ACCEPTED ONE: "I'd rather have
    // accuracy with delay than mismatching." Amazon Chime SDK sends Lex no message id, so the id
    // comes from the memoized channel read this turn may already have paid for. A greeting is the
    // fastest turn in the system and this is the first thing that makes it wait; record the measured
    // cost when it ships rather than estimating it here.
    //
    // A DECLARATION THAT COULD NOT BE MADE IS NOT FAKED. When the lookup finds nothing the marker
    // still goes out with the delivery option alone, which leaves the pairing exactly where it was
    // rather than inventing a target.
    if (!battleCtx
        && (classification.intent === IntentType.GREETING
          || classification.intent === IntentType.ACKNOWLEDGMENT)) {
      // THE INTENT DECIDES THE REPLY (ADR-062 decision 7): the classifier recorded which greeting or
      // acknowledgment this is, and the line is that intent's template, in this assistant's words.
      const quickResponse = quickReply(classification, await turnWords());
      if (quickResponse) {
        const answers = declaredMessageId || (await inboundMessage()).messageId;
        // ── THE ID THE RESOLVED MESSAGE GIVES, WHEN IT GAVE ONE ──────────────────────────────────
        //
        // The derived id buckets on (channel, sender, text, 90s) because the Lex path has nothing
        // more exact. Every other marked message in the channel is a placeholder, and the flow's
        // one-placeholder-per-turn guard DENIES a second message holding a correlation already
        // claimed - so marking this one hands greetings the cost that derivation was priced for
        // somewhere else: "thanks" twice inside a minute is two turns, and the second answer would
        // be the one denied. Silence in reply to a real message is worse than a duplicated greeting,
        // and this is exactly the shape of message people repeat.
        //
        // The resolved id removes the collision rather than accepting it. A retry replays the same
        // user message, so it still derives the same correlation and still collapses; two distinct
        // messages carrying the same words no longer do. It is the same id the bypass path declares
        // for the same reason, and the derivation stays as the fallback for a turn that resolved
        // nothing.
        const directCorrelationId = answers ? mentionCorrelationId(answers) : correlationId;
        // AND IT DECLARES THAT IT IS ALREADY FINISHED. A bot message carrying a correlation marker
        // is read by the ledger as a PLACEHOLDER - a response something else will close. This one
        // posts once and is done, so without the phase the marker would have turned every greeting
        // into a response that never closes. `final` is the same word every other producer declares.
        // AND WHICH ASSISTANT ANSWERED. This return is materialized by Amazon Chime SDK from the
        // fulfillment, so it carries no message metadata and `spoke.attribution` cannot ride there -
        // the content declaration is the only carrier. Without it this turn lands with a NULL
        // `agent_type` and every console rollup renders it as an unknown assistant, which is one of
        // exactly two remaining producers of that row.
        const declared = withTurnDeclaration(
          `${quickResponse} <!--corr:${directCorrelationId}-->`,
          {
            answers,
            delivery: DeliveryOption.DIRECT,
            phase: 'final',
            entry: turnEntry,
            ...(spoke.attribution?.agentType && { assistant: spoke.attribution.agentType }),
          },
        );
        return formatLexResponse(event, [{ contentType: 'PlainText', content: declared }]);
      }
    }

    // ── A REQUEST FOR SOMETHING THIS ASSISTANT DOES NOT OFFER IS REFUSED, HERE ────────────────────────
    //
    // DESIGN-CAPABILITY-REFUSAL §5. Beside DIRECT and before the turn claim, so a refused turn writes
    // no task, dispatches nothing and runs no model to say no. No other assistant is consulted: every
    // assistant in a conversation acts in its one classification (ADR-042), so none present offers what
    // this classification's assistant does not.
    //
    // AS VISIBLE AS THE REQUEST (SPEC FR16), and the access lines ALWAYS to the person alone
    // (SPEC FR17): they state what this person's clearance reaches, which the room must not read.
    //
    // THE REFUSAL IS USER EXPERIENCE, NOT ENFORCEMENT (tenet P4). A classification that produces no
    // document or image holds no grant to write one; a missed refusal fails at the grant.
    // AN IMAGE REQUEST IN A CLASSIFICATION THE CATALOG ALLOWS NO IMAGE MODEL IS REFUSED TOO, in a duel as
    // well as on an ordinary turn: an image intent is served only by an image model (`modelFits`,
    // `lib/config/model-availability.ts`), and there is none here for either side to use. Without this the
    // turn reached the processor, resolved no image model, and failed there.
    if (willRefuse) {
      const refusedDef = refusedIntents.find((d) => d.key === classification.intent)
        ?? (imageUnavailable ? servedIntentDef : undefined);
      const { copy } = await turnWords();
      const composed = composeRefusal({
        need: refusedDef ? needsOf(refusedDef) : undefined,
        channelClassification: effectiveClassification,
        userClearance,
        copy,
        registry: profiles,
      });
      const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
      // Private when the flow declared it (`.<assistant>` dispatch), or when the message itself was
      // targeted. The channel read is the one DIRECT may already have paid for, memoized.
      const inbound = await inboundMessage();
      const privateRequest = !!senderArn
        && (event.requestAttributes?.[BYPASS_TARGETED_ATTR] === '1' || !!inbound.targeted);
      const answers = declaredMessageId || inbound.messageId;
      const refusalCorrelationId = answers ? mentionCorrelationId(answers) : correlationId;
      const text = privateRequest && composed.access
        ? `${composed.refusal}\n\n${composed.access}`
        : composed.refusal;
      // IT ANSWERS THE MESSAGE IT REFUSES, so it declares no turn kind: archival skips any message that
      // declares one when pairing, and the refusal would never become an exchange. `REFUSED` is what
      // makes it countable (SPEC FR11).
      const declared = withTurnDeclaration(
        `${text} <!--corr:${refusalCorrelationId}-->`,
        {
          answers,
          delivery: DeliveryOption.REFUSED,
          phase: 'final',
          entry: turnEntry,
          ...(spoke.attribution?.agentType && { assistant: spoke.attribution.agentType }),
        },
      );
      console.log('[Router] refused: this assistant does not offer the classified intent', {
        intent: classification.intent, need: (refusedDef && needsOf(refusedDef)) ?? null, privateRequest,
        accessLine: composed.access ? 'yes' : 'no', clearanceResolved: userClearance !== undefined,
      });
      try {
        await sendInParts(chimeClient, {
          ChannelArn: channelArn,
          text: declared,
          Type: ChannelMessageType.STANDARD,
          Persistence: ChannelMessagePersistenceType.PERSISTENT,
          ChimeBearer: botArn,
          ...(privateRequest && { Target: [{ MemberArn: senderArn }] }),
          Metadata: botMessageMetadata(spoke.attribution, {
            intent: classification.intent,
            deliveryOption: DeliveryOption.REFUSED,
            respPhase: 'final',
            ...(privateRequest && { targetedSender: senderArn }),
          }),
        });
      } catch (err) {
        // THE PERSON IS STILL ANSWERED (tenet D5). The Lex fulfillment carries no metadata, so this
        // refusal goes unrecorded as one, which is the smaller loss than silence.
        console.warn('[Router] could not post the refusal; answering through the fulfillment instead', {
          err: (err as Error)?.message,
        });
        return formatLexResponse(event, [{ contentType: 'PlainText', content: declared }]);
      }
      // A PUBLIC REQUEST'S ACCESS LINES FOLLOW TO THE PERSON ALONE. Declared a `notice`: the platform
      // telling one person something, not an answer, so it never pairs as the exchange.
      if (!privateRequest && composed.access && senderArn) {
        await sendInParts(chimeClient, {
          ChannelArn: channelArn,
          text: composed.access,
          Type: ChannelMessageType.STANDARD,
          Persistence: ChannelMessagePersistenceType.PERSISTENT,
          ChimeBearer: botArn,
          Target: [{ MemberArn: senderArn }],
          Metadata: botMessageMetadata({ ...spoke.attribution, turnKind: 'notice' }, { targetedSender: senderArn }),
        }).catch((err: unknown) => {
          console.warn('[Router] could not send the refusal access lines', { err: (err as Error)?.message });
        });
      }
      return formatLexSilentResponse(event);
    }

    /**
     * The id and the addressing, as the options `createTask` takes.
     *
     * A DECLARED ID WINS. A bypass caller hands over the exact inbound `MessageId`; the lookup matches
     * on content, which is identifying but not exact, so the declared one is preferred where it exists.
     *
     * VISIBILITY IS OMITTED WHEN NOTHING ESTABLISHED IT, and that is the important half. An absent
     * visibility reads as private (`task-visibility.ts`), so a lookup that FAILED leaves the task
     * private rather than converting "we did not find out" into "we checked, it is public". A lookup
     * that found an untargeted message records `conversation` explicitly, which is the only way this
     * writer produces a shared task.
     */
    const inboundTaskFields = async (): Promise<Pick<TaskCreateOptions, 'userMessageId' | 'visibility'>> => {
      const { messageId, targeted: looked } = await inboundMessage();
      const id = declaredMessageId || messageId;
      // A DECLARED TARGETING WINS, for the same reason a declared id does, and here it is the ONLY
      // thing that can answer. The lookup matches the turn's text against the stored message; a flow
      // dispatch strips its address token first, so on that path the match cannot succeed and `looked`
      // is always `undefined`. Reading the declaration first is what lets an openly-asked `@all` open
      // a task the room can actually see.
      const declared = declaredTargeted();
      let targeted = declared !== undefined ? declared : looked;

      /**
       * A DECLARED `false` IS CHECKED, BECAUSE THE DECLARING PATH CANNOT SEE `Target`.
       *
       * Two owner decisions meet here and both are right about their own case:
       *
       *  - 2026-09-21: every flow dispatch DECLARES, because absent visibility reads as private and a
       *    path that stays quiet reaches private by omission. Measured on a real conversation: a plainly
       *    public "List all the tasks in this conversation and their status" opened a private task and a
       *    two-person room collected four "I have replied to you privately." receipts.
       *  - ADR-033, 2026-09-15: absent reads as private PRECISELY BECAUSE the flow callback carries no
       *    `Target`, so "failing open discloses a private request, and that cannot be taken back."
       *
       * They conflict only because the flow declares `false` for "not addressed in the text", which is
       * not the same fact as "not sent with a `Target`" - and it cannot tell them apart (ADR-029,
       * ADR-034). MEASURED 2026-09-28 on the deployed stack: `turn-queue.spec.ts:1251` sent a genuine
       * `Target` and read `conversation` off the agent row.
       *
       * SO THE DECLARATION IS TREATED AS WHAT IT IS - a statement about the TEXT - and the other half is
       * resolved from the stored message, which does carry `Target` (`lib/private-command.ts`). Both
       * decisions then hold: an openly-asked turn still opens a task the room can see, and a targeted
       * one is still private.
       *
       * THE READ IS PAID HERE AND NOWHERE EARLIER. This runs only when a task is actually being opened,
       * which is after the placeholder is posted, so it is off the time-to-first-frame path that
       * `LATENCY-TARGETS.md` is trying to shorten. Putting it in the flow instead would cost every turn
       * a `GetChannelMessage` to serve the few that open work.
       *
       * AN UNREADABLE MESSAGE KEEPS THE DECLARATION. `inboundWasTargeted` already answers `false` when it
       * cannot read, and overriding a declaration on a failed read would convert "we could not check"
       * into "it is private" for every ordinary turn - reinstating the receipts by another route.
       */
      const verifyId = id;
      if (declared === false && channelArn && verifyId) {
        try {
          if (await inboundWasTargeted(chimeClient, channelArn, verifyId, await getBotArn())) {
            targeted = true;
            console.log('[Router] the flow declared this untargeted; the stored message says otherwise', {
              channelArn, messageId: verifyId,
            });
          }
        } catch (err) {
          // Never fail opening the task over this check: the declaration stands, which is the same
          // outcome as before the check existed.
          console.warn('[Router] could not verify the declared targeting; keeping the declaration', {
            channelArn, messageId: verifyId, err: (err as { name?: string })?.name,
          });
        }
      }

      return {
        ...(id ? { userMessageId: id } : {}),
        ...(targeted === undefined
          ? {}
          : { visibility: targeted ? ('private' as const) : ('conversation' as const) }),
      };
    };

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
    // A LATER PASS OF THE SAME TURN IS NOT A DUPLICATE DELIVERY OF IT.
    //
    // This claim is idempotency for a Lex RETRY: same turn in, same response out. A triage fold
    // re-dispatches deliberately under the SAME correlation, because the next pass is meant to own
    // that correlation and update the same placeholder - so to this guard it looked identical to a
    // retry, and it replayed the placeholder instead of running the turn.
    //
    // The two never collided until now: the fold could not fire while a six-second budget gated it,
    // so the re-dispatch path had never run in production. Observed the first time it did, live:
    // "more arrived while reading; folding into one answer" at 19:53:01, then "duplicate
    // fulfillment: replaying the same placeholder" 79ms later, and the queue never drained. The
    // handover could not rescue it either, because the triage claim is held across the drain and it
    // correctly stood down for a reader that was never going to run.
    //
    // The pass number is the discriminator and it already travels. Scoping the claim to it keeps
    // the property this guard exists for - a genuine retry of pass 2 still dedups against pass 2 -
    // while letting pass 2 be a different delivery from pass 1.
    // Parsed here rather than hoisting the declaration 350 lines up: it is a pure read of one
    // request attribute, and the guard below needs it long before the turn context is assembled.
    const attemptSuffix = deliveryAttemptSuffix(event.requestAttributes);
    // ── AND THE AMENDMENT FOLD, WHICH IS THE OTHER RE-ENTRY ON ONE CORRELATION ────────────────────
    //
    // The paragraph above is this defect, one re-dispatch path along, and it happened again exactly
    // as described (owner-reported, 2026-09-05).
    //
    // When a reading judges that something arriving mid-turn AMENDS the work, the processor
    // re-dispatches the turn to run again with the correction folded in - deliberately on the SAME
    // correlation id, because the placeholder and the lock have to carry over to the answer that
    // replaces them. This guard then read the second arrival as a redelivery of the first, replayed
    // the placeholder and returned without dispatching anything.
    //
    // Traced live: `bd3444ecd844c285` folded at 14:33:24.374, reached the router 40ms later, and
    // logged "duplicate fulfillment: replaying the same placeholder" at 14:33:26.038. That
    // correlation id never appears again in any log. The person was left watching "One moment..."
    // for the rest of the conversation, the lock stayed held until the staleness takeover, and the
    // amendment itself was gone - `clearAmendments` runs the moment the fold is dispatched, on the
    // reasoning that losing it to a failed invoke is the worse outcome. The invoke had succeeded.
    //
    // THE FOLD NUMBER IS THE DISCRIMINATOR AND IT ALREADY TRAVELS, as `AE.turn.amendedFold`. Scoping
    // the claim to it keeps exactly what this guard is for - a genuine retry of fold 1 still dedups
    // against fold 1 - while letting fold 1 be a different delivery from the turn it amends.
    const fulfilKey = `fulfil-${correlationId}${attemptSuffix}`;
    if (!(await claimCorrelation(fulfilKey))) {
      // IDEMPOTENT, NOT SILENT. Return the SAME placeholder the winning fulfillment returned, carrying
      // the SAME `<!--corr:{id}-->` marker, and do no work: the winner already dispatched the
      // processor, opened any task, and spent the abuse gate.
      //
      // WHY NOT AN EMPTY ENVELOPE, WHICH THIS USED TO RETURN. Because the LOSER's response is often the
      // one the user actually sees. Amazon Chime SDK materializes ONE message per turn, from the LAST
      // fulfillment response, so silencing the second attempt silences the only response that reaches
      // the channel. Traced live 2026-08-06 on an ordinary turn: fulfillment A resolved
      // `PLACEHOLDER_UPDATE` in 3055ms, claimed the correlation and dispatched the processor; its
      // response was discarded; fulfillment B arrived 3.5s later, lost the claim, and returned the
      // empty envelope - which became the channel's ONLY bot message. The processor then polled 22s
      // for A's placeholder, logged `No placeholder for correlationId`, and the user's question went
      // unanswered. The dedup had its assumption backwards: it silenced the winner.
      //
      // Returning the same placeholder makes the two attempts interchangeable, which is what
      // idempotency means here - same turn in, same response out. Whichever one materializes carries
      // the marker, so the single dispatched processor finds it and updates it in place.
      //
      // SAFE IF BOTH EVER MATERIALIZE. Bot messages created from a Lex return DO pass through the
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
      // materializing the LAST response would discard the notice the person should see. A gate
      // block is fast and never hits the Lex retry timeout, so the winner's notice DID materialize;
      // the correct duplicate response is the empty envelope, which materializes nothing over it.
      if (await hasCorrelationClaim(`fulfil-blocked-${correlationId}${attemptSuffix}`)) {
        console.log('[Router] duplicate of a gate-blocked fulfillment: staying silent so the notice stands', { correlationId });
        return formatLexSilentResponse(event);
      }
      console.log('[Router] duplicate fulfillment: replaying the same placeholder', { correlationId });
      return formatLexResponse(event, [{
        contentType: 'PlainText',
        content: placeholderContent(`${getTaskPlaceholder(DeliveryOption.PLACEHOLDER_UPDATE, undefined, undefined, { words: await turnWords() })} <!--corr:${correlationId}-->`),
      }]);
    }

    // ── ONE TURN AT A TIME (ADR-033) ────────────────────────────────────────────────────────────
    //
    // HERE, AND NOT IN THE CHANNEL FLOW, which is where the ADR first placed it. The flow sees every
    // message, but seeing a message is not knowing a turn will run: in a group channel an unmentioned
    // message reaches the flow and produces no turn at all, so claiming there would lock conversations
    // on messages nobody was going to answer. This point is past the dedup and past the addressing
    // rules, so a turn that gets here is one this assistant is committed to answering.
    //
    // KEYED ON THE RESPONDER, not the conversation: two people mentioning two different assistants
    // should both get answers. `/battle` is the deliberate exception and does not come through here -
    // a duel occupies the whole conversation, and its own channel-scoped guard already says so.
    //
    // INERT UNTIL SWITCHED ON. `claimTurn` returns `claimed: true` when the feature is off or its
    // table is unset, so this whole block is a no-op on a deployment that has not enabled it.
    const responderId = principalIdFromArn(botArn);
    // A TRIAGE TURN DOES NOT CLAIM, because it is not answering.
    //
    // It reads the queue and posts a proposal while the turn it is triaging behind is still
    // running and still holds the lock - correctly. Claiming here would queue triage behind the
    // very turn it exists to describe, and the proposal would arrive only once that turn ended,
    // which is the retrospective behavior moving triage to arrival was meant to remove.
    // Read here rather than reusing the parse below, which happens after this point. A cheap guard on
    // an attribute the dispatcher set: absent means an ordinary turn, which is every turn but these.
    const isTriageTurn = !!parseTriageTurnContext(event.requestAttributes?.[BYPASS_TRIAGE_ATTR]);
    // NOR DOES THE JUDGED HALF OF A STOP, and for the same reason read from the other side: it is
    // asking about the turn that is still running, so claiming here would hold the question until
    // that turn ended - which is exactly the retrospective behavior a stop exists to escape.
    const isStopEvaluationTurn = !!parseStopEvaluationContext(
      event.requestAttributes?.[BYPASS_STOP_EVAL_ATTR],
    );
    // NOR A JOIN RECAP. It answers nobody's message, so it holds no place in the conversation's queue,
    // and queueing it behind a running turn would put its request in the queue as if the new member had
    // typed it.
    const isJoinRecapTurn = isJoinRecap(event);
    const turnClaim = isTriageTurn || isStopEvaluationTurn || isJoinRecapTurn
      ? { claimed: true }
      : await claimTurn({
        channelArn,
        responderId,
        correlationId,
        // So a drain waiting on THIS person does not queue the very message it is waiting for.
        ...(personId ? { senderId: personId } : {}),
      });
    // ── AND WHAT THIS TURN IS ANSWERING, FOR WHOEVER READS THE QUEUE BEHIND IT ──────────────────
    //
    // A drain asks, per queued message, whether it AMENDS the work already running - and was told
    // that work was "the work already in progress", the same literal phrase for every turn. So the
    // model judged whether "actually, keep it to one page" amends something it had no description
    // of, and corrections were classified as new work: the amendment became a second item, answered
    // after the thing it was meant to change.
    //
    // RECORDED BY THE PROCESSOR, NOT HERE. Resolving the id costs a Chime `ListChannelMessages` on
    // every claiming turn, and this point is in front of the first frame: the whole read and the
    // DynamoDB write behind it were inside TTFF. Nothing on the return depends on either, and
    // `rememberHolderMessage` says the same from its own side - written AFTER the claim, never as
    // part of it, because a drain does not read it until a queue has formed.
    //
    // THE WINDOW THIS OPENS, STATED. The record now lands a hand-off plus a channel read after the
    // claim rather than before the return - a few hundred milliseconds. A message that arrives inside
    // that window and is triaged on arrival reads the state before the id is there, and describes the
    // work in flight bare ("something is running") instead of naming the message. That is the same
    // degradation `inFlightDescription` already produces for an unresolvable id, on a far smaller
    // population than the every-turn TTFF cost it replaces.
    //
    // WHAT TRAVELS IS THE DECISION, NOT THE WORK: this turn claimed, so it owes the record. The id
    // rides with it only when this turn already has one - a bypass declares it, a task-shaped turn
    // resolves it anyway - and otherwise the processor resolves it from the same shared matcher.
    //
    // GATED ON THE QUEUE FLAG, which `claimTurn` is not: it returns `claimed: true` when the feature
    // is off, so an ungated hand-off would have a queue-off deployment pay a channel read for a write
    // that then no-ops on its own flag check.
    // NOT ON A TRIAGE OR STOP-EVALUATION TURN, which did not claim - they were handed `claimed: true`
    // above precisely so they do NOT queue behind the turn they are describing. Their write would fail
    // the holder condition anyway, after the processor had already paid a channel read for it.
    const owesHolderRecord = turnQueueEnabled() && turnClaim.claimed
      && !isTriageTurn && !isStopEvaluationTurn && !isJoinRecapTurn
      && !!channelArn && !!responderId;
    /** The hand-off fields for that record. Empty on a turn that owes nothing. */
    const holderRecordFields = (): Record<string, unknown> => (owesHolderRecord
      ? {
        rememberHolder: true,
        ...(knownInboundMessageId ? { userMessageId: knownInboundMessageId } : {}),
      }
      : {});
    // ── WHO HOLDS IT, AND WHETHER THE WORK EVER LEFT ─────────────────────────────────────
    //
    // The lock is released by the turn that RUNS, in the processor's `finally`. Every path that
    // claims here and then returns without dispatching leaves it held: the abuse gate serving a
    // rate-limit notice, a missing processor ARN, and - worst - the catch at the bottom, which
    // covers any error at all. The failure destination needs an invocation to have failed and
    // there was none, so the only other recovery is the staleness takeover in `claimTurn`, which
    // fires only when a later message arrives after the holder has gone `STALE_AFTER_MS` (default
    // five minutes) without progress, and which counts as a `LockTakeover`.
    //
    // It went unnoticed because it used to be repaired by accident: the old takeover judged any
    // holder dead the moment its placeholder existed, so a stranded lock was displaced by the
    // next message. Removing that (it was displacing LIVE turns, which is why the queue never
    // worked) took the accident away with it, and left this.
    //
    // Concretely, without this release: one rate-limited message and every later message in that
    // conversation queues behind a holder that will never drain, until one arrives after the
    // staleness bound and takes the lock over. The record has no TTL.
    if (!isTriageTurn && !isStopEvaluationTurn && turnClaim.claimed) {
      lockToRelease = { channelArn, responderId, correlationId };
    }
    // ADR-033 ADMISSION IS OVER: the claim was attempted, and a turn that took it knows whether it
    // owes the queue a description of what it is answering. Marked whichever way the claim went, so a
    // REFUSED claim - the turn that queues - still says what deciding that cost. The DynamoDB round
    // trips this step covers are the ones the turn queue added to the pre-placeholder path, and they
    // had no timing at all before this.
    markRouterStep('turn_claimed');
    if (!turnClaim.claimed) {
      // The conversation is answering something else. The person's message WAITS rather than starting
      // a second turn - and they are told, because a deferred message that says nothing is
      // indistinguishable from a broken assistant.
      // THE CHIME MESSAGE ID, not this turn's correlation.
      //
      // `declaredMessageId` is only set on the bypass path, so an ordinary turn queued its own
      // CORRELATION id, and nothing downstream can use that. The queue deliberately holds ids and
      // reads the content at DRAIN time by message id, and the turn-state API resolves each queued
      // id through Amazon Chime SDK as the caller to decide what that person may see. Both then look
      // up a message that does not exist: the drain has nothing to read, so the queued message is
      // never answered, and `visibleQueued` drops every entry it cannot resolve, silently, so the
      // record holds the waiting message while every client asking is told the queue is empty.
      //
      // It cannot be passed through Lex. Measured live and recorded in live-drift-flow: the request
      // attributes are exactly `CHIME.channel.arn`, `CHIME.sender.arn` and
      // `x-amz-lex:channels:platform`. So it is read back from the channel and matched on the exact
      // text being handled, which is what drift already does for the same reason - one way to answer
      // "which message was this", not two.
      //
      // THE SAME LOOKUP THE ANSWERING BRANCH USES, not a second one. It used to be paid only here, on
      // the branch that had already decided to make somebody wait; it is now started once per turn
      // above, because the answering branch needs the addressing the same read returns. The two
      // branches are exclusive, so no turn pays for it twice.
      const queuedMessageId = declaredMessageId
        || (await inboundMessage()).messageId
        // Last resort. Queued under an id nothing can resolve still beats losing the message, and
        // the notice still tells the person something is waiting.
        || correlationId;
      // WITH THE INTENT IT WAS CLASSIFIED AS, which is what the message is attributed to wherever it is completed: the
      // task a reading opens for it, or the answer it is folded into (ADR-064 decision B).
      const queued = await enqueueMessage({ channelArn, responderId, messageId: queuedMessageId, intent: classification.intent });
      console.log('[Router] a turn is already running here; queueing', {
        correlationId, heldBy: turnClaim.heldBy, depth: queued.depth, overflowed: queued.overflowed,
      });

      // ── A QUEUE THAT DID NOT HAPPEN IS SAID OUT LOUD (code review, 2026-09-04) ────────────────
      //
      // Everything below this point assumes the message is in `queued`: the notice tells the person
      // it is waiting, the drain task is opened to read it, and this branch then returns silently.
      // When the write failed, none of that is true - no drain will ever read the message, because
      // it is not there - and the person had been told the opposite.
      //
      // So the branch stops here and ANSWERS instead. Asking them to send it again is a poor outcome
      // and it is an honest one; the alternative is a message that waits for something that will
      // never come, which is the failure the whole queue exists to prevent.
      if (queued.failed) {
        // The deployment's own words where it has them (tenet D11). Resolved here rather than at the
        // top of the branch because this path is the rare one, and the ordinary queueing path already
        // resolves the same copy a few lines below.
        const failedWords = await turnWords();
        console.error('[Router] the message could not be queued; telling the person rather than going quiet', {
          correlationId, channelArn, messageId: queuedMessageId,
        });
        return formatLexResponse(
          event,
          [{
            contentType: 'PlainText',
            content: templateLine('queue-write-failed', failedWords),
          }],
        );
      }
      // ── THE DRAIN IS A TASK, AND THIS IS WHERE IT OPENS (ADR-033, owner 2026-09-03) ──────────
      //
      // There is a queue now, so something has to read it, and that reading is WORK. One drain per
      // QUEUE and not per pass: this path runs for every message that queues, and the claim inside
      // makes a burst open one. Both ends of its life are in `queue-drain-task.ts`, together,
      // because the end is the half that gets forgotten - and was.
      //
      // THE MESSAGE IS REFERENCED BY ID, never copied. Its content is resolved as the caller when
      // somebody reads it, which is what keeps a targeted request invisible to a person who may
      // not see it - the same rule the queue itself follows.
      await openDrainTask({
        event,
        channelArn,
        responderId,
        ...(correlationId ? { correlationId } : {}),
        ...(queuedMessageId ? { queuedMessageId } : {}),
        // The intent of the message that opened the drain (ADR-064 decision B).
        openingIntent: classification.intent,
      });
      // ONE NOTICE, UPDATED IN PLACE. Posting a fresh reply for every queued message reproduces the
      // exact doubling this design exists to prevent: three messages while the assistant is busy
      // would draw three near-identical "still working on it" lines, and the conversation ends up
      // noisier than if nothing had been said.
      //
      // It cannot ride the Lex reply, because updating a message needs its id and a reply returned
      // through Lex is materialized by the channel flow - this handler never learns which message it
      // became. So the assistant posts it directly, the same way a bypass turn already speaks its own
      // acknowledgment, and the id that comes back is what makes the next send an update.
      // THIS ASSISTANT'S OWN WORDING, when the deployment configured any. Resolution is cached per
      // container, so the fast path pays it once rather than per queued message - which is what makes
      // configuration affordable here where a model call is not.
      const queueCopy = (await turnWords()).copy;
      // ONE TURN POSTS, THE REST UPDATE OR STAY QUIET.
      //
      // `enqueueMessage` hands back the notice id atomically, so a message queueing after a
      // notice exists updates it. Messages arriving TOGETHER all queue before any of them has
      // posted: each saw no notice, each posted its own, and one burst of three drew three
      // near-identical notices - measured, and the exact doubling this design exists to prevent.
      //
      // So the notice is claimed before anything is posted. The turn that wins posts and records
      // the real id. A turn that loses says nothing through the notice: its message is queued and
      // the winner's notice already tells the room that something is waiting. Silence from the
      // loser is recoverable - the next queued send updates the notice with the true depth - and
      // a second notice in the room is not.
      const mayPost = queued.noticeId ? true : await claimNotice({
        channelArn, responderId, correlationId,
      });
      // WHO POSTS, AND WHY. A burst that draws several notices and a burst that draws one look
      // identical from outside the handler: both end with messages in the channel. This says which
      // decision each turn took, so a duplicate names its own cause instead of needing a guess.
      console.log('[Router] queue notice decision', {
        correlationId,
        depth: queued.depth,
        existingNoticeId: queued.noticeId ?? null,
        mayPost,
      });
      // A THROW IS NOT A REFUSAL, and both used to arrive as the same `null`. Named here so the
      // claim is released either way and the cause is still in the log (invariant E).
      // ── THE NOTICE GOES INTO THE RUNNING ANSWER'S PLACEHOLDER ──────────────
      //
      // That placeholder sits right after the message being answered, which is where the person looks
      // for what is happening. The answer itself then posts at the end, after the follow-ups it
      // addresses. Resolved only for the first notice: once one exists, every later send updates it.
      const holderPlaceholder = mayPost && !queued.noticeId
        ? await findHolderPlaceholder({ channelArn, botArn, holderCorrelationId: turnClaim.heldBy })
        : undefined;
      const noticeId = mayPost
        ? await showQueueNotice({
          channelArn,
          botArn,
          responderId,
          depth: queued.depth,
          overflowed: queued.overflowed,
          ...(queued.noticeId ? { existingNoticeId: queued.noticeId } : {}),
          ...(holderPlaceholder ? { placeholderId: holderPlaceholder } : {}),
          // WHICH MESSAGE THIS ACKNOWLEDGES, so the acknowledgement is measurable. Every queued send
          // updates the same notice, so without naming the message the post is answering, all of them
          // collapse into one instant and only the first could ever have a time to first feedback.
          ...(queuedMessageId ? { acknowledges: queuedMessageId } : {}),
          ...(queueCopy ? { copy: queueCopy } : {}),
        }).catch((err) => {
          console.error('[Router] the queue notice threw while posting', {
            correlationId, message: (err as Error)?.message,
          });
          return null;
        })
        : null;

      // RELEASE THE CLAIM IF NOTHING WAS POSTED. Only when this turn is the one that claimed it:
      // `mayPost` is also true when a notice already existed, and that id belongs to another turn.
      // Leaving the marker behind is what turned one failed post into a conversation that answered
      // nobody ever again.
      if (mayPost && !noticeId && !queued.noticeId) {
        await releaseNoticeClaim({ channelArn, responderId, correlationId })
          .catch(() => { /* the next queued send corrects whatever is really there */ });
      }
      // A LOSER STILL HAS TO BE COUNTED.
      //
      // It must not post - that is the duplicate this claim exists to stop - but the notice the
      // winner posted says the depth the winner saw, which for a burst is 1 while three wait. A
      // notice that undercounts is its own defect: it tells the person less is waiting than is.
      //
      // So the loser waits briefly for the winner's real id and updates the depth. The depth comes
      // from the RECORD rather than from this turn, so two losers updating at once write the same
      // number instead of racing 2 against 3, and the answer is whatever is actually queued.
      if (!mayPost) {
        const deadline = Date.now() + 3_000;
        for (;;) {
          const seen = await readTurnState({ channelArn, responderId }).catch(() => null);
          if (seen?.noticeId) {
            await showQueueNotice({
              channelArn,
              botArn,
              responderId,
              depth: seen.queued.length || queued.depth,
              overflowed: queued.overflowed,
              existingNoticeId: seen.noticeId,
              // The same message as the post above: this branch is the retry that finally found the
              // notice to update, not a different acknowledgement.
              ...(queuedMessageId ? { acknowledges: queuedMessageId } : {}),
              ...(queueCopy ? { copy: queueCopy } : {}),
            }).catch(() => null);
            break;
          }
          // Bounded, because this is on the path of somebody who is already waiting. Giving up
          // costs an undercounted notice that the next queued send corrects; blocking costs the
          // person their turn.
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        return formatLexSilentResponse(event);
      }
      // POSTED IT OURSELVES ⇒ say nothing through Lex, or the person gets the notice twice.
      if (noticeId) return formatLexSilentResponse(event);

      // IT FAILED ⇒ hand the notice back to Lex rather than going quiet. Two notices is untidy; none
      // is indistinguishable from a broken assistant, which is what tenet 4 exists to prevent.
      return formatLexResponse(event, [{
        contentType: 'PlainText',
        content: noticeText({
          depth: queued.depth,
          overflowed: queued.overflowed,
          ...(queueCopy ? { copy: queueCopy } : {}),
        }),
      }]);
    }

    // Per-user rate limit (SPEC-ABUSE-CONTROLS): enforce the ADDRESSED ASSISTANT's hourly limit
    // before any budget spend or dispatch. Over limit -> short "try again in N min" reply, no Bedrock.
    // The limit is `rateLimitPerHour` on the turn's assistant profile (deployment config), so a turn to
    // `ops-premium` is held to its 120 and a turn to `advisor` to its own; 0/undefined disables it. The
    // COUNTER is the person's (`ratelimit#<person id>#<hour>`), shared across the assistants they talk
    // to, and the limit is that of the assistant answering this turn.
    // Shared gate (SPEC-ABUSE-CONTROLS): the rate-limit-then-budget order + reject-message selection
    // live in lib/abuse-controls (evaluateAbuseGate), so the router and the channel-flow battle path
    // enforce them identically. Over limit/budget -> serve the notice and do NOT dispatch (no Bedrock
    // cost). isExemptAdmin forwards the opt-in per-user exemption (never the global budget).
    //
    // A BATTLE TURN IS NOT METERED HERE, BY DESIGN (DESIGN-BATTLE). One `/battle` is ONE user action that becomes TWO turns. The
    // channel flow gates the duel as a whole before it fans out, so metering again per side would
    // charge a duel three times over - and worse, a rejection could land BETWEEN the sides, leaving
    // one answer with nothing to compare it against. A rejected arm is indistinguishable in the
    // results from an arm that answered badly, so that is measurement bias in an experiment, not a UX
    // wrinkle. Gating once, upstream, is what makes a duel refuse or run as a whole.
    //
    // This is the one battle-shaped branch in the handler. It is not a license for others: what is
    // special here is that the caller already authorized BOTH turns, which is true of nothing else.
    // Only a DECLARED battle context skips the gate (see meteredUpstream above): a resumed side's
    // synthesized context is a real, un-gated user turn and pays like one.
    if (battleCtx && meteredUpstream) {
      console.log('[Router] battle turn: metered once by the flow for the whole duel, not per side', {
        battleId: battleCtx.battleId,
        round: battleCtx.round,
      });
    } else {
      // A JOIN RECAP IS METERED AGAINST NOBODY'S ALLOWANCE. The person on it is the one
      // who was just added, and they asked for nothing, so neither their hourly rate limit nor their per-user
      // budget is spent on it. It still calls a model, so the deployment's global budget counts it and can
      // refuse it (`machineWritten` in `evaluateAbuseGate`).
      const recapTurn = isJoinRecap(event);
      const gate = await evaluateAbuseGate({
        personId,
        rateLimit: turnProfile.rateLimitPerHour ?? 0,
        isAdmin: isExemptAdmin,
        ...(recapTurn && { machineWritten: true }),
      });
      if (!gate.allowed && recapTurn) {
        // The new member asked nothing, so a budget line addressed to them would answer a question they never
        // put. The recap is skipped, and says so in the log.
        console.warn('[Router] the global budget refused a join recap; no recap is posted', { effectiveClassification, correlationId });
        return formatLexSilentResponse(event as LexEvent);
      }
      if (!gate.allowed) {
        // THE REFUSAL IN THIS ASSISTANT'S OWN WORDS (`rateLimited`, `budgetExhausted`). The copy is read
        // only once the gate has refused, so the allowed path pays nothing for it; an unreadable profile
        // keeps the line the gate composed.
        const refusalVersion = await resolveActiveProfile(turnProfile.name, { ssm: ssmClient, ssmRoot: SSM_ROOT }).catch(() => undefined);
        gate.message = noticeLine(undefined, gate.notice.kind, gate.notice.vars, undefined,
          await noticeSelection(gate.notice.kind, turnProfile.name, refusalVersion));
        console.warn(`[Router] ${gate.reason} gate blocked dispatch; serving notice`, { effectiveClassification, personId: personId.slice(0, 8) });
        // Mark the block beside the fulfillment claim, so a duplicate delivery of this same turn
        // knows the winner dispatched NOTHING and stays silent instead of replaying a placeholder
        // no worker will ever update. Best-effort: an unwritten marker degrades to the old replay.
        // Scoped to the pass, like the claim it mirrors: a block on pass 2 must not silence pass 3.
        await claimCorrelation(`fulfil-blocked-${correlationId}${attemptSuffix}`).catch(() => true);
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
          (await getHumanMemberArns(channelArn, botArn)).map((a) => personIdFromArn(a) || '').filter(Boolean),
        resolveName: (memberId) => resolveMemberName(userArnFor(appInstanceArnOf(channelArn) || '', memberId)),
      });
      domainGrounding = grounding.domainGrounding;
      contextId = grounding.contextId;
    }

    // P3 (D2): per-intent response shaping (maxTokens/verbosity) from the pack — forwarded in the
    // event so the processor can size the answer per intent (e.g. tight logistics, longer research).
    // Empty ⇒ omitted ⇒ the processor uses its default budget.
    // Shaped by the pack the turn was CLASSIFIED against. Reading the deployment pack here while the
    // label came from the profile's would size the answer by a different taxonomy's numbers - and
    // silently, since a key the deployment pack does not carry returns `{}` and looks like "this intent
    // sets no override" rather than "this intent is not in the pack I just asked".
    // (Undefined falls to the parameter default, which is the deployment pack — the previous behavior.)
    const responseSettings = responseSettingsForIntent(classification.intent, profileIntentPack);
    const hasResponseSettings = Object.keys(responseSettings).length > 0;

    // P4 config attribution: the handler holds the intent pack, so it forwards the pack's version
    // (short hash of the raw pack JSON — which already includes per-intent response settings — or
    // 'default'). The processor combines it with the persona it resolves into the turn's `configId`.
    //
    // THE EFFECTIVE PACK, not the deployment one. This is the taxonomy that actually produced
    // `classification.intent` a few hundred lines above, and attribution that names a different one is
    // worse than none: it reports every turn as classified by a taxonomy that had no part in it, and it
    // does so most wrongly exactly when a profile carries its OWN pack, which is the case worth
    // measuring. A version with no pack still hashes the deployment raw, unchanged.
    //
    // The profile branch hashes the canonical `JSON.stringify` of the stored pack rather than a raw
    // string, because there is no raw string to hash - the pack arrives parsed off the version. So a
    // deployment whose seed now carries its own pack re-keys its `intentPackVersion` once, at the
    // migration, to the id its actual taxonomy earns. Same one-time re-key as `copy` on the configId.
    const intentPackVersion = profileIntentPack
      ? componentVersion(JSON.stringify(profileIntentPack))
      : componentVersion(activeIntentPackRaw());

    // First-turn greeting (A3): resolve the sender's display name (the directory, cached) and forward it
    // so the async processor greets the user by name on their FIRST turn — where the identity is settled,
    // unlike the racy channel-creation WelcomeIntent. An unresolvable sender falls back to 'there', which
    // the processor treats as "no name".
    const senderDisplayName = await resolveUserName(event.requestAttributes?.['CHIME.sender.arn'] || '');

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
            // NOTHING ABOUT THIS SIDE'S BEHAVIOR RIDES HERE (§3.7): the side serves its pinned version, which
            // travels as `variantProfile` like any version a turn serves. What rides are the two NAMES,
            // each side's profile name as `battleSideNames` settles them: the rival's for the prompt, and this
            // side's for its scorecard marker. When both versions read the live name, the challenger's carries
            // its `battleAltName` marker, so the two scorecard columns differ.
            ...(battleSide.rivalName && { rivalName: battleSide.rivalName }),
            ...(battleSide.selfVariant?.displayName && { selfName: battleSide.selfVariant.displayName }),
            // The room's own assistant names a conversation a duel opens; the alt never does.
            ...(battleCtx.round === 1 && !altBotArns.has(battleCtx.selfBotArn) && { namesConversation: true }),
          },
        }
      : {};

    // The declared cause instant, parsed once. A finite-number guard rather than a bare Number():
    // an absent or malformed attribute must yield an ABSENT instant, because a NaN forwarded here
    // reaches a latency column and every comparison against it is silently false.
    const rawTriggerAt = event.requestAttributes?.[BYPASS_TRIGGER_AT_ATTR];
    const parsedTriggerAt = rawTriggerAt ? Number(rawTriggerAt) : NaN;
    const triggerAtFromBypass = Number.isFinite(parsedTriggerAt) ? parsedTriggerAt : undefined;

    // What a triage turn is reading, and for whom. Guarded whole: a malformed value yields NO triage
    // context, so the turn behaves as an ordinary one rather than as a triage turn whose reply can
    // never be matched against anything - or one that knows the messages but not who may see them.
    const triage = parseTriageTurnContext(event.requestAttributes?.[BYPASS_TRIAGE_ATTR]);

    // The queued messages this turn's answer addresses, declared by the fold that rolled them in.
    // Split, trimmed and re-checked against the declarable pattern: an attribute is a string a hop
    // may truncate, and a half-written id names nothing while looking exactly like a value.
    const foldedMessageIds = String(event.requestAttributes?.[BYPASS_FOLDED_IDS_ATTR] || '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id && isDeclarableValue(id));
    // What each of them was classified as when it queued (ADR-064 decision B), kept only for a declared folded id.
    const foldedIntents = Object.fromEntries(Object.entries(decodeFoldedIntents(event.requestAttributes?.[BYPASS_FOLDED_INTENTS_ATTR]))
      .filter(([id]) => foldedMessageIds.includes(id)));

    // ── THE READING CONTRACT NAMES ONLY WHAT THE PROMPT SHOWED ─────────────────────────────────
    //
    // A fold used to happen HERE: the router re-read the queue and appended anything that had landed
    // since dispatch to `triage.ids`. It was reverted because it silently destroyed every reading it
    // touched, and it is recorded rather than deleted so it is not reintroduced.
    //
    // `triage.ids` is not a list of messages. It is the CONTRACT: `triageContractDirective` demands
    // one `TRIAGE:` line per id, and `parseTriageProposal` refuses the reply whole unless it gets
    // exactly that many. The message CONTENT lives in the turn's user message, which
    // `buildTriagePrompt` rendered at dispatch and which nothing here can rebuild - this handler has
    // no in-flight label to put back into it.
    //
    // So appending an id here asked the model to classify a message it had never been shown. It
    // answered for the ones it could see, the count did not match, and the reading was refused - which
    // costs far more than the straggler it was trying to collect: the whole judged half goes, and with
    // it the priorities, the grouping, and the offer to separate subjects, all replaced by the derived
    // floor of one task per message. The more messages arrive at once, the likelier the split, so the
    // batches this was meant to help were the ones it broke.
    //
    // Late arrivals are not lost, and they are not read one at a time either. The processor checks the
    // queue again once its reading is done and BEFORE the proposal is put to anybody, and dispatches
    // another pass over everything through `dispatchTriageTurn` - which rebuilds the prompt and the id
    // set together, from the same messages, so the two cannot disagree. That path already covers this
    // window, because it compares the live queue against the ids this turn was given.
    // Guarded the same way: malformed yields NO context, and the turn's reply is then stamped as an
    // ordinary answer - late and mislabelled, but never a question closing a turn as `final`.
    const stopEvaluation = parseStopEvaluationContext(event.requestAttributes?.[BYPASS_STOP_EVAL_ATTR]);

    // ── WHO NAMES THE ROOM, WHEN THIS TURN'S ASSISTANT CANNOT (`conversation-name.ts`) ─────────────────────────────
    //
    // Only the room's primary moderates the room, so a turn answered by any other assistant (a duel's alt, a member
    // assistant addressed by name) names nothing, and the primary is asked to name it from this message instead, on its
    // own session, once per room. Not asked of a triage reading or a stop evaluation, whose message is the platform's
    // prompt rather than the person's, nor where this turn's assistant is the primary it resolved.
    //
    // READ AS CHEAPLY AS THE ROOM ALLOWS (`namingDecisionFor`): a room this container knows is named, or whose naming is in
    // hand, reads nothing; one the row records as named reads no Amazon Chime SDK; only then is the primary read.
    const naming: NamingDecision = channelArn && botArn !== resolvedRoomPrimary && !triage && !stopEvaluation
      ? await namingDecisionFor({
        channelArn, answeringBotArn: botArn, classification: STATIC_CLASSIFICATION,
        knownName: channelNameCache.get(channelArn), ...(battleCtx ? { battle: battleCtx } : {}),
      }, roomNamingMemory, {
        primaryOf: (arn) => primaryAssistantOf(arn, chimeClient, '[Router][naming]'),
        isNamed: async (arn) => (await roomNamingOf(arn)).named,
        markNamed: (arn) => markRoomNamed(arn),
      })
      : { namer: null, ask: false };
    const roomNamingFields = naming.namer ? { namesConversation: false } : {};
    // STARTED BESIDE THE ANSWERING DISPATCH, never after it, so asking adds nothing to the turn's own latency, and it
    // never fails the turn: every failure is a room asked about again by a later message.
    const askRoomToBeNamed = (processorArn: string): Promise<void> => {
      const namer = naming.namer;
      if (!naming.ask || !namer || !channelArn) return Promise.resolve();
      return askRoomPrimaryToName(
        { channelArn, primaryBotArn: namer, userMessage, classification: STATIC_CLASSIFICATION },
        {
          claim: claimRoomNaming,
          release: releaseRoomNaming,
          markNamed: (arn) => markRoomNamed(arn),
          currentName: async (arn) => {
            channelNameCache.delete(arn);
            await resolveChannelMetadata(arn, botArn, true);
            return channelNameCache.get(arn);
          },
          dispatch: (payload) => invokeAsync(processorArn, payload),
          leaseMs: ROOM_NAMING_LEASE_MS,
        },
        roomNamingMemory,
      ).then((asked) => {
        console.log('[Router] the primary of the room is asked to name it', { asked });
      }, (err) => {
        console.warn('[Router] the primary of the room could not be asked to name it (non-fatal)', { err: (err as Error)?.name });
      });
    };

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
        // NORMALIZED, so a row written by a not-yet-redeployed producer is still readable: the legacy
        // 'orchestrator' maps to the interaction it was overwhelmingly used for. An unrecognized
        // value becomes absent rather than being forwarded as a kind nothing understands.
        trigger: normaliseLegacyTrigger(event.requestAttributes[BYPASS_TRIGGER_ATTR]) ?? undefined,
      }),
      // The cause instant, guarded to a finite number: a malformed attribute must produce an ABSENT
      // instant, never a NaN that would propagate into a latency column.
      ...(triggerAtFromBypass !== undefined && { triggerAtMs: triggerAtFromBypass }),
      // HOW THIS TURN ENTERED. Two values, and the router is the only component that can say: both
      // entries converge here, and `AE.entry` is set by `bypassToLexEvent` and read by nothing that
      // outlives the invocation, so the fact was available and thrown away.
      //
      // WHY TWO VALUES AND NOT THREE. The interesting third case is an Amazon Lex turn that arrived
      // TARGETED rather than standard, and the router cannot know it without a channel read: Amazon
      // Chime SDK sends Amazon Lex three request attributes and none of them is the `Target` or the
      // message id (measured over fourteen days, see `resolveOriginatingMessage`). That read sits in
      // front of the person's first frame and `test/lib/what-waits-for-the-first-frame.test.ts` exists
      // to keep it there, so buying it to record a latency dimension would make the metric change the
      // thing it measures. It is not needed either: under a deployment-wide `StandardMessages: NONE`
      // an Amazon Lex invocation IS a targeted message by construction, so the split is implied by the
      // configuration rather than stored per row.
      entry: isFlowEntry(event) ? 'flow' : 'lex',
      ...(triage ? { triage } : {}),
      // FINITE OR ABSENT. A malformed attribute must not become a NaN that compares false against
      // the fold limit and lets the bound fall open.
      ...(Number.isFinite(Number(event.requestAttributes?.[BYPASS_AMENDED_FOLD_ATTR]))
        && Number(event.requestAttributes?.[BYPASS_AMENDED_FOLD_ATTR]) > 0
        ? { amendedFold: Number(event.requestAttributes?.[BYPASS_AMENDED_FOLD_ATTR]) }
        : {}),
      // THE QUEUED MESSAGES THIS ANSWER ADDRESSES, re-checked on the way back. An id that does not
      // match the declarable pattern is dropped: it could not have been written by the fold, and a
      // mangled id would attribute an answer to a message that does not exist.
      ...(foldedMessageIds.length ? { foldedMessageIds } : {}),
      ...(Object.keys(foldedIntents).length ? { foldedIntents } : {}),
      // Absent leaves the guardrail screening `userMessage`, which is what every ordinary turn wants
      // and what a turn dispatched by an older version still gets.
      // A JOIN RECAP HAS NO HUMAN HALF: its message is the platform's own request for a catch-up
      // (`joinRecapRequest`), which nobody wrote. Screening it as a person's input fired the
      // prompt-attack filter on our own instruction and answered a new member with a refusal. Empty
      // content is screened as nothing (`applyInputGuardrail`); the output guardrail still runs.
      ...(isJoinRecap(event)
        ? { userContent: '' }
        : event.requestAttributes?.[BYPASS_USER_CONTENT_ATTR]
          ? { userContent: String(event.requestAttributes[BYPASS_USER_CONTENT_ATTR]) }
          : {}),
      ...(stopEvaluation ? { stopEvaluation } : {}),
      ...(turnAttachment && { attachment: turnAttachment }),
      // SPEC-PORTABLE §6: a profileRef variant runs its whole version, so the definition rides the
      // event. Resolved once here; the worker applies it without a second read.
      ...(resolvedVariantProfile && { variantProfile: resolvedVariantProfile }),
      // ITS NUMBER, so the turn is attributed to the version it is (`variantVersion`); absent when the pin names none.
      ...(resolvedVariantProfile && resolvedVariantVersion !== undefined && { variantVersion: resolvedVariantVersion }),
      // WHAT THE VARIANT REACHES, for the routing record (not read by the worker): the vend narrows this
      // turn's session to the variant it serves rather than the assistant's own definition.
      ...((() => {
        const routedVariant = variantGrantOf({ modelKey: resolvedModelKey, imageModelKey: resolvedImageModelKey, profile: resolvedVariantProfile });
        return routedVariant ? { routedVariant } : {};
      })()),
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
    // tracks tasks in DynamoDB too (grounds the prompt + stamps task_id + advances state);
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
      // AN ANSWER TO A STANDING QUESTION IS NOT THE CONTINUATION OF WHATEVER ELSE WAS OPEN.
      //
      // Same shape as the duel exception below, and for the same reason: a turn must not be
      // absorbed into a task just because one is open. When the drain asked this person something
      // and this is their reply, the reply settles THAT. Folding it into the active task put two
      // instructions on one turn - work this task, and answer the offer if this answers it - and
      // the task won: somebody answered "just split out Q3 headcount, leave the rest here" and was
      // told about the pricing page, with the offer still standing and askable again.
      //
      // Anything else waiting is not lost by this. It is queued or still open, and it is picked up
      // on the next turn, which is one turn later than it would have been and is the correct
      // trade: a person cannot answer a question twice, and an unanswered offer is asked again.
      const hasActiveTask = !!activeTask && !turnClaim.answeredTheQuestion;
      // A duel side uses the delivery option resolved for its side, never the ordinary selection.
      // `selectDeliveryOption` folds in `hasActiveTask`, which is wrong for a battle: each side gets
      // its OWN task (the maintainer decision behind `hasActiveTaskForBot`), so a duel must not be
      // absorbed into whatever task the user already had open in the channel.
      const deliveryOption = battleSide
        ? battleSide.deliveryOption
        : selectDeliveryOption(classification.intent, hasActiveTask, profileIntentPack);

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
          // THE SECOND DOOR, AND IT IS GATED UPSTREAM RATHER THAN HERE (ADR-047). A duel side opens
          // a task the same way an ordinary turn does, so an ungated door made `/battle` a
          // walk-around for a workflow the serving version deselected.
          //
          // The gate is NOT applied at this line, and that is the point. Refusing here would leave
          // the side holding a TASK_MULTI_STEP delivery with no task - the reason this was carried as
          // a gap rather than fixed in place. `resolveBattleSide` takes `workflowSelection` instead,
          // builds the gate from the SERVING VARIANT's own selection where it has one, and plans a
          // generated reply with NO task type, so an ungated type never reaches this branch: reaching
          // it at all means the selection already allowed it.
          const battleTask = await createTask(event, deliveryOption, battleSide.taskType, correlationId, {
            owner: { id: principalIdFromArn(botArn), type: 'assistant' as const },
            battleId: battleCtx.battleId,
            // SAID OUT LOUD, BECAUSE ABSENT MEANS PRIVATE (review, 2026-09-17). `readTaskVisibility`
            // reads a missing value as `private` - every writer that means a task to be shared records
            // `conversation` - and this one did not, so a duel's own task read as private work. The
            // delivery planner then sent that side's answer to the person alone, and a comparison
            // nobody else in the room can see is not a comparison.
            //
            // Fixed here rather than by letting a duel override the private rule: a genuinely private
            // item answered inside a duel must still stay private, which is what
            // `a-reply-goes-where-the-work-lives.test.ts` pins.
            visibility: 'conversation' as const,
            // The DECODED message. `event.inputTranscript` is percent-encoded on a bypass, so reading it
            // would store `Produce%20a%20report` as the excerpt an operator reads back.
            requestExcerpt: userMessage,
            // The USER's message, when this caller holds a resolvable one (ADR-024 D5). A bypass
            // declares the inbound id; the Lex path has none to declare, and absent is the honest
            // value there rather than the correlation id standing in for it.
            ...(await inboundTaskFields()),
            // THE INTENT THAT OPENED IT (ADR-064 decision B), which the side's steps route and are attributed under.
            openingIntent: classification.intent,
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
          // AN INTENT OWNS THE TASK TYPE OF THE SAME NAME, when a machine exists for it.
          //
          // This replaces a hardcoded chain over five intents (guided_troubleshooting, data_extraction,
          // report_generation, place_item, action_item), every one of which mapped to a task type with
          // the SAME name - so on the shipped machines this is the identical answer, and the e2e suite
          // is the check on that.
          //
          // What it opens is the case the chain could not express: a deployment adds an intent to its
          // pack, declares a machine for it in the version's `machines`, and gets a real tracked
          // workflow. Before, every such intent fell to `general`, for which NO machine exists - so
          // `buildTaskLoopContext` returned undefined, the `advance_task_state` tool was never offered
          // and a TASK_MULTI_STEP intent silently answered as an ordinary reply. Declaring a taxonomy
          // you cannot attach a workflow to is the gap this closes.
          // THE ONE PLACE THE WORKFLOW SELECTION IS APPLIED (ADR-047).
          //
          // Opening is the decision a selection governs: an assistant configured not to offer a
          // workflow must not start one. Everything downstream - the prompt, the advance tool, the
          // delivery gate - runs the task it was handed against the FULL set, so a task already in
          // flight is never stranded by a selection that changed after it opened.
          //
          // Platform machines are exempt: the queue opens its own task types directly and a
          // selection must not remove them (SPEC-TASK-STATE-TRANSITIONS, two kinds of shipped machine).
          taskType = turnMachines[classification.intent] && mayOpen(classification.intent)
            ? classification.intent
            : 'general';

          // Work-item tasks (place_item / action_item) anchor to the plan + get the long plan TTL so
          // they survive until the work happens. An `action_item` also gets a
          // default assignee = the requester (the persona asks who on a shared plan; reassign later).
          // Enterprise tasks pass no opts.
          const requesterPersonId =
            personIdFromArn(event.requestAttributes?.['CHIME.sender.arn']) || undefined;
          const taskOpts: TaskCreateOptions | undefined =
            taskType === 'place_item'
              ? { contextId, ttlSeconds: TRIP_TASK_TTL_SECONDS }
              : taskType === 'action_item'
                ? {
                    contextId,
                    ttlSeconds: TRIP_TASK_TTL_SECONDS,
                    ...(requesterPersonId ? { owner: { id: requesterPersonId, type: 'user' as const } } : {}),
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
            ...(await inboundTaskFields()),
            // THE INTENT THAT OPENED IT (ADR-064 decision B): the task's steps route under it where its type is not an
            // intent, and its turns are attributed to it.
            openingIntent: classification.intent,
            // THE ARM THE TASK WAS OPENED UNDER (ADR-064 decision J): while the experiment runs the task is served that
            // version; once it stops, the live one (`resolveTaskArm`, experiment-manager.ts). A field only the platform
            // writes, never `details`, which a person's own task may carry.
            ...(enrolledResolution ? { experimentArm: {
              experimentId: enrolledResolution.experimentId, variantId: enrolledResolution.variantId,
              ...(enrolledResolution.configId ? { configId: enrolledResolution.configId } : {}),
            } } : {}),
          });
          taskId = task.taskId;
          taskState = task.taskState;
          taskCreated = true;
        }

        // The task this turn will be answered against exists and its state is known - a DynamoDB
        // read, sometimes a write, and on a task that is being OPENED the channel read that resolves
        // which message it came from. Marked only on the task-shaped paths, so its absence says the
        // turn was an ordinary question rather than reporting task work as free.
        markRouterStep('task_prepared');

        if (asyncProcessorArn && channelArn) {
          // RELEASED ONLY IF THE TURN WAS ACTUALLY HANDED OVER - see invokeAsync.
          const [dispatched] = await Promise.all([invokeAsync(asyncProcessorArn, {
            channelArn,
            correlationId,
            userMessage,
            classification: effectiveClassification,
            // Point-in-time clearance; see the note at the main dispatch.
            userClearance,
            taskId,
            taskType,
            taskCreated,
            // The other open work this message might be about, so the turn can name one of them
            // instead of the one this router assumed. Sent only when there was a real
            // choice, and only when the assumed task is one of them - a turn that opened fresh work
            // is not answering any of it.
            ...(referentCandidateIds.includes(taskId)
              ? { referentCandidateIds, referentCandidates }
              : {}),
            ...(taskResolution ? { taskResolution } : {}),
            // A task this turn opened counts too: it is one more thing a bare reply could answer.
            openItemCount: answerableTaskIds.length + (answerableTaskIds.includes(taskId) ? 0 : 1),
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
            ...holderRecordFields(),
            ...(handoverMessageIdForTurn ? { answersMessageId: handoverMessageIdForTurn } : {}),
            senderArn: event.requestAttributes?.['CHIME.sender.arn'],
            senderDisplayName,
            // Reply visibility (targeted vs broadcast) is derived from the
            // placeholder's actual Target in the async processor, not passed
            // here - the router cannot see the inbound message's Target.
            intent: classification.intent,
            intentConfidence: classification.confidence,
            // WHAT THE LABEL COST, carried because it is the largest controllable step in TTFF and the
            // router is the only component that can see it. Absent on the no-LLM fast paths, which
            // is itself the fact worth recording: those turns did not pay for a model.
            ...(classification.classifierLatencyMs !== undefined
              && { classifierMs: classification.classifierLatencyMs }),
            // WHAT THE LABEL COST IN MONEY, not only in milliseconds. The classifier is a real Bedrock
            // call and its tokens were captured here and written to a log line and nowhere else, so
            // the cost surface could only ever cover the ANSWER. The model rides with them because the
            // classifier is per-profile configurable: a token count with no model beside it is an
            // input to a cost, not a cost. All three absent together on a fast path, which is the fact
            // worth recording rather than a gap.
            ...classifierSpendFields(classification),
            // This handler entry -> the hand-off, on ONE clock. Stamped HERE rather than at the
            // return because the payload leaves before the turn does; what is missed is formatting
            // the Lex envelope, and naming the span for what it measures beats a truer number that
            // cannot be taken.
            //
            // `dispatched` is marked from the SAME instant, so the step log's first-to-last span and
            // `routerMs` are the same number by construction. Two derivations of one span that
            // disagree is a measurement bug, and this is the pair that can show it.
            ...stampDispatch(),
            deliveryOption,
            ...(resolvedModel && { resolvedModel }),
            ...(resolvedImageModelKey && { resolvedImageModelKey }),
            ...(experimentId && { experimentId }),
            ...(variantId && { variantId }),
            ...(hasResponseSettings && { responseSettings }),
            intentPackVersion,
            ...workerCommonFields,
            ...workerBattleFields,
            ...roomNamingFields,
            ...domainGrounding,
          }, turnRoster), askRoomToBeNamed(asyncProcessorArn)]);
          if (dispatched) lockToRelease = null;
          // FROM THE INVOKE, NOT BESIDE IT. `dispatched` already decides whether the lock is held,
          // and this was set true regardless one line later - so a throttled or failed Invoke left
          // the flag saying a worker had it. Both silent-return guards key on this flag, so the
          // entry returned SILENCE for a turn nothing was running: no placeholder update, no
          // battle marker cleared, and a person waiting on work that had already stopped. Setting
          // it from the same value the lock uses makes the two agree by construction, and a false
          // value falls through to posting the turn's own words, which is what those guards
          // document as the better outcome.
          spoke.dispatched = dispatched;
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
              lead: getTaskPlaceholder(deliveryOption, taskType, taskState, await placeholderWords(taskType, taskState)),
              // FROM THE ID THIS TURN ALREADY HOLDS, on the same terms as `placeholderContent`
              // above: the round-1 fan-out declared it, or an earlier lookup on this turn paid for
              // it. Empty declares nothing rather than buying a channel read.
              answersMessageId: declaredAnswerId(),
              // And how the turn entered, as every placeholder this handler writes declares it.
              entry: turnEntry,
            }),
          }]);
        }

        const placeholder = getTaskPlaceholder(deliveryOption, taskType, taskState, await placeholderWords(taskType, taskState));
        return formatLexResponse(event, [{
          contentType: 'PlainText',
          content: placeholderContent(`${placeholder} <!--corr:${correlationId}-->`),
        }]);
      }
    }

    // PLACEHOLDER_UPDATE: General questions (all classifications)
    if (asyncProcessorArn && channelArn) {
      // RELEASED ONLY IF THE TURN WAS ACTUALLY HANDED OVER - see invokeAsync.
      const [dispatched] = await Promise.all([invokeAsync(asyncProcessorArn, {
        channelArn,
        correlationId,
        userMessage,
        classification: effectiveClassification,
        // THE PERSON CLEARANCE AT THIS MOMENT, beside the conversation classification above. Recorded because a
        // classification change moves it: read later, the groups and the identity tag both answer what they
        // hold NOW, and an analytics row needs what they held when the turn ran.
        userClearance,
        botArn,
        senderArn: event.requestAttributes?.['CHIME.sender.arn'],
        senderDisplayName,
        // Reply visibility is derived from the placeholder's actual Target in
        // the async processor (see the task-continuation invoke above).
        intent: classification.intent,
        intentConfidence: classification.confidence,
        ...(classification.classifierLatencyMs !== undefined
          && { classifierMs: classification.classifierLatencyMs }),
        // The same spend fields as the other dispatch site; see the comment there.
        ...classifierSpendFields(classification),
        ...stampDispatch(),
        deliveryOption: deliveryOptionName,
        ...holderRecordFields(),
        ...(handoverMessageIdForTurn ? { answersMessageId: handoverMessageIdForTurn } : {}),
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
        ...roomNamingFields,
        intentPackVersion,
        ...domainGrounding,
      }, turnRoster), askRoomToBeNamed(asyncProcessorArn)]);
      if (dispatched) lockToRelease = null;
      // Same rule as the task-shaped branch above: the flag reports what the Invoke did.
      spoke.dispatched = dispatched;
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
          // The same declaration the ordinary placeholder below makes, from the same id. A duel
          // side is the slowest turn in the system and the one whose id is handed to it, so it is
          // the population that gains most from declaring rather than being swept.
          answersMessageId: declaredAnswerId(),
          // And how the turn entered, as the ordinary placeholder below declares it.
          entry: turnEntry,
        }),
      }]);
    }

    return formatLexResponse(event, [{
      contentType: 'PlainText',
      content: placeholderContent(`${getTaskPlaceholder(DeliveryOption.PLACEHOLDER_UPDATE, undefined, undefined, { words: await turnWords() })} <!--corr:${correlationId}-->`),
    }]);

  } catch (error) {
    console.error('[Router] Error:', error);
    return formatLexResponse(event, [{
      contentType: 'PlainText',
      content: templateLine('turn-error', await loadMessageTemplateSet({ classification: STATIC_CLASSIFICATION }).then((templates) => ({ templates }), () => ({}))),
    }]);
  } finally {
    // A `finally`, not a line before each `return`, for the reason ADR-033 gives about the
    // processor's own release: there are eight ways out of the block above and the next one
    // added would not know to release either. A held lock that nothing frees is worse than a
    // duplicate answer, because the person can recover from a duplicate and cannot from silence.
    //
    // ONLY when the work never left. A dispatched turn owns the lock now and releasing it here
    // would free the conversation while that turn is still answering, which is the double-answer
    // this lock exists to prevent.
    if (lockToRelease) {
      await releaseLock(lockToRelease)
        .catch(() => { /* the TTL is the backstop; a failed release must not fail the reply */ });
    }
  }
};

async function getSsmValue(paramName: string): Promise<string | null> {
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
    return resp.Parameter?.Value || null;
  } catch (err) {
    console.warn(`[Router] SSM lookup failed for ${paramName}:`, err);
    return null;
  }
}

/**
 * @returns whether the processor was actually handed the turn.
 *
 * IT REPORTS, because the caller releases the turn lock on every path that did NOT dispatch. Silently
 * returning void made a failed invoke - a throttle, an oversized payload, a transient IAM error -
 * indistinguishable from a successful one, and the caller had already given up the lock by then. The
 * conversation was then held by a correlation id nobody was running, with no processor to reach the
 * failure destination either, so nothing recovered it until the TTL.
 */
/**
 * Handle the `set_preference` and `show_preferences` platform intents for the person who sent the turn.
 *
 * DETERMINISTIC, AND THE ROUTER'S. The classifier decided the person is asking about their preferences;
 * the registry decides the value (`resolvePreferenceValue`), and the router writes it with the grant it
 * already holds on the profile store. No model chooses what is stored, and no assistant session needs a
 * write grant. Setting one completes onboarding, because onboarding is complete once preferences are set.
 */
async function preferenceTurnFor(intent: string, subject: string, message: string): Promise<PreferenceTurn> {
  if (intent === 'show_preferences') {
    return { action: 'show', current: knownPreferences(await getReplyPreferences(subject)) };
  }
  const saved: Record<string, string> = {};
  for (const key of Object.keys(REPLY_PREFERENCES)) {
    const value = resolvePreferenceValue(key, message);
    if (value) saved[key] = value;
  }
  if (!Object.keys(saved).length) return { action: 'choose' };
  for (const [key, value] of Object.entries(saved)) {
    if (!(await setReplyPreference(subject, key, value))) return { action: 'failed' };
  }
  await markOnboarded(subject);
  return { action: 'set', saved };
}

async function invokeAsync(
  functionName: string,
  payload: Record<string, unknown>,
  roster?: ReadRoster,
): Promise<boolean> {
  // ── THE ROUTING DECISION IS RECORDED BEFORE THE TURN IS HANDED OVER (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b) ─────────────────
  //
  // The processor acts as the assistant this router chose, and the vend mints that session only from
  // this record. So a turn whose decision cannot be recorded is not dispatched: the processor would be
  // refused an identity and could not answer anyway, and reporting "not dispatched" lets the caller
  // release the conversation instead of leaving it held by a turn that cannot run.
  const correlationId = typeof payload.correlationId === 'string' ? payload.correlationId : '';
  const botArn = typeof payload.botArn === 'string' ? payload.botArn : '';
  const classification = typeof payload.classification === 'string' ? payload.classification : '';
  if (classification !== STATIC_CLASSIFICATION) {
    // This router writes only its own classification's routing table, and its processors are its
    // own. A dispatch naming another classification is refused rather than routed somewhere this
    // router cannot vouch for.
    console.error('[Router][SecurityEvent] refused to dispatch a turn for another classification', {
      classification, routerClassification: STATIC_CLASSIFICATION, correlationId,
    });
    return false;
  }
  try {
    const channelArn = typeof payload.channelArn === 'string' ? payload.channelArn : '';
    const variant = payload.routedVariant && typeof payload.routedVariant === 'object' ? payload.routedVariant as GrantVariant : undefined;
    await recordTurnRouting(routingDdb, TURN_ROUTING_TABLE, {
      correlationId, botArn, classification,
      ...(channelArn ? { channelArn } : {}),
      ...(variant ? { variant } : {}),
    });
  } catch (err) {
    console.error('[Router] could not record the turn routing; not dispatching', {
      correlationId, err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  // ── THE ASKER'S REPLY PREFERENCES TRAVEL WITH EVERY TURN ─────────────────────────────────────────
  //
  // Read here because this is the one place every turn passes through, and the router already reads
  // the profile store (the onboarding gate), so the processor needs no grant of its own to honor them.
  // Only declared preferences with declared values are passed (`knownPreferences`); the processor turns
  // them into the registry's own instructions, so nothing the person typed reaches the prompt.
  // Fail-open by construction: `getReplyPreferences` answers {} on any store error.
  const senderArn = typeof payload.senderArn === 'string' ? payload.senderArn : '';
  const senderSub = personIdFromArn(senderArn) || '';
  // WHAT THIS TURN DID ABOUT PREFERENCES, decided and STORED here, said by the assistant. The intake's
  // outcome (an offered preference just chosen) wins; otherwise the two platform intents are handled.
  // Stored before the preferences below are read, so this very reply already follows a new choice.
  let preferenceTurn = (payload.preferenceTurn as PreferenceTurn | undefined) ?? turnPreferenceOutcome;
  turnPreferenceOutcome = undefined;
  if (!preferenceTurn && senderSub && (payload.intent === 'set_preference' || payload.intent === 'show_preferences')) {
    preferenceTurn = await preferenceTurnFor(String(payload.intent), senderSub, String(payload.userMessage ?? ''));
  }
  if (preferenceTurn) payload = { ...payload, preferenceTurn };
  if (turnSubjectDecision && payload.subjectDecision === undefined) payload = { ...payload, subjectDecision: turnSubjectDecision };
  turnSubjectDecision = undefined;
  if (turnHeldQuestion && payload.heldQuestion === undefined) payload = { ...payload, heldQuestion: turnHeldQuestion };
  turnHeldQuestion = undefined;
  // WHO IS HERE: the roster the dispatching turn read and handed in, and only when it was built for this
  // dispatch's conversation and answering assistant. Every other dispatch carries none.
  const whoIsHere = rosterForDispatch(roster, payload.channelArn, payload.botArn);
  payload = { ...payload, whoIsHere };
  if (senderSub && payload.replyPreferences === undefined) {
    const stored = await getReplyPreferences(senderSub);
    const preferences = knownPreferences(stored);
    if (Object.keys(preferences).length) payload = { ...payload, replyPreferences: preferences };
    // THE SENDER'S OWN LANGUAGE (ADR-062 decision 4), from the same read: a declared tag, or nothing.
    const preferredLanguage = resolveLanguageTag(stored[PREFERRED_LANGUAGE_KEY]);
    if (preferredLanguage) payload = { ...payload, preferredLanguage };
  }
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    return true;
  } catch (err) {
    console.error('[Router] Failed to invoke async processor:', err);
    return false;
  }
}
