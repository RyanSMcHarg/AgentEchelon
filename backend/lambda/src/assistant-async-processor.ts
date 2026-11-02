/**
 * Assistant Async Processor (unified) — SPEC-CAPABILITY-PROFILES.
 *
 * ONE config-driven async processor for every assistant profile. It replaces the former
 * per-classification {basic,standard,premium}-async-processor.ts, which were a DIVERGENT UNION rather
 * than a clean hierarchy:
 *   - standard carried the richest text path (context-framework host grounding, config-identity
 *     attribution, cross-channel task awareness, RAG, context-aware model routing / external LLM,
 *     attachment-in, work-item propose-and-confirm, suggestions, the advance_task_state loop,
 *     document generation, per-intent maxTokens, action_item hand-off);
 *   - premium carried /battle (prompt assembly, vision-in, generation-out image models);
 *   - basic was the simple text path with no task loop.
 *
 * The union runs the full text path for ALL profiles (the task loop is uniform — the
 * router classifies task intents on every classification), and gates the two genuinely
 * profile-specific capabilities:
 *   - /battle assembly runs only when BATTLE_CAPABLE=true (the classification wires battle);
 *   - the model, model display name, token limit, and persona come from per-profile env
 *     (PROFILE_NAME / MODEL_ID / MODEL_NAME / MAX_TOKENS) + an optional SSM/env persona override.
 *
 * Pipeline: poll placeholder -> load history -> build system prompt (persona + host context + task +
 * RAG + summary) -> resolve model (battle variant / context-routing) -> invoke (image-gen | vision |
 * external | Bedrock) -> shadow/stall task transitions -> generate document -> finalize -> title rename.
 */

import { estimateStepCostUsd } from './lib/model-rate-table.js';
import { deliversDocument, withConfirmBrief } from './lib/task-state-machines.js';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import {
  AsyncProcessorEvent,
  AsyncProcessorConfig,
  GeneratedDocument,
  runSharedPipeline,
  scanForPlaceholderMessage,
  resolveDeliveryMessageId,
  handleProcessingError,
  finalizePlaceholderResponse,
  generateAndUploadDocument,
  isDocumentRequest,
  updateMessage,
  isDeliverableDocument,
  getTaskLabel,
  applyInputGuardrail,
  applyOutputGuardrail,
  beginTurnGuardrailFindings,
  takeOutputGuardrailFindings,
  WORK_ITEM_OPENAI_TOOLS,
  WORK_ITEM_TOOL_NAMES,
  proposalMarker,
  extractSuggestions,
  postTaskHandoffNotice,
  imageFormatFromContentType,
  docFormatFromContentType,
  buildRebuttalContext,
  buildRebuttalImageNote,
  buildBattleAwareness,
  resolveBattleVisionPlan,
  resolveHistoryImageBlocks,
  resolveGenerationOutPlan,
  resolveTurnImageRoute,
  buildTaskLoopContext,
  shadowKeywordTransition,
  recordStallIfNoTransition,
  consolidateConsecutiveMessages,
  type BedrockImageInput,
  type BedrockDocumentInput,
} from './lib/async-processor-core.js';
// First-turn summary seed. Runs through the data-plane seam (ADR-013): this processor
// is non-VPC, so the Aurora write + Bedrock summarization happen in the data-plane Lambda.
import { seedConversationSummary } from './lib/data-plane-client.js';
import { deploymentCopyAppliesTo, deploymentCopySkipped } from './lib/deployment-copy-scope.js';
import { rememberHolderMessage } from './lib/turn-lock.js';
import { settleTurnLockAtExit } from './lib/turn-handover.js';
import { closeOutAttribution } from './lib/turn-attribution.js';
import { turnEntryOf } from './lib/turn-declaration.js';
import { isResumeParkedEvent, type ResumeParkedEvent } from './lib/parked-turn.js';
import { readTurnState, takeParkedTurn } from './lib/turn-lock.js';
import { messagingClient } from './lib/async-processor-core.js';
import { topicMovedLink, sanitizeTitle } from './lib/channel-creation.js';
import { actAsAssistant, actingAs, releaseAssistantIdentity, endAssistantTurn, companyContextScope } from './lib/async-processor-core.js';
import {
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { readPendingSplit, clearPendingSplit, recordDispatchFailure } from './lib/turn-lock.js';
import type { PendingSplitOffer } from './lib/turn-lock.js';
import {
  splitOfferDirective,
  parseSplitSelection,
  selectionFromTheirWords,
  stripSplitSelection,
  requestConversationSplit,
} from './lib/turn-topic-split.js';
// The task boundary. Named on import so a call site cannot read the table directly by accident.
import { hasTaskService, tasksForTurn as taskServiceTasksForTurn } from './lib/task-service-client.js';
import { fetchAttachmentBytes, senderOwnsAttachmentKey } from './lib/attachment-bytes.js';
import {
  attachmentFitsModelLimits,
  attachmentTooLargeLine,
  recordAttachmentOverBudget,
} from './lib/attachment-budget.js';
import { stripReasoningTags } from './lib/message-markers.js';
import { TASK_NOTICE_TEMPLATES, type RosterParticipant } from './lib/task-notify.js';
import { loadMessageTemplateSet, loadNamedPromptTemplate, loadNamedTemplate, selectMessageTemplate } from './lib/message-template-selection.js';
import { runWelcomePromptTurn } from './lib/welcome-prompt-turn.js';
import { ARRIVAL_EVENTS, agentStepIsNarrowed, audienceOf, conferredBy, nothingToRecap, proposalOf, sendValues, stepTakenBy, templatesForPeople, workflowFor } from './lib/event-workflow.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { proposalDraft, proposalDraftRefusal, proposalRecordOf, writeProposal, type ProposalAddressee, type ProposalCard } from './lib/proposals.js';
import { runAgentStep } from './lib/event-agent-step.js';
import { renderVoice } from './lib/voice-fill.js';
import { inLanguage } from './lib/message-language.js';
import { claimEventStep, wasGreetedByEventRun } from './lib/task-store.js';
import { openEventTask } from './lib/event-task.js';
import { DEFAULT_TASK_STATE_MACHINES } from './lib/task-state-machines.js';
import { continueEventRunThroughRouter } from './lib/say-through-router.js';
import { resolveRouterArn } from './lib/turn-triage.js';
import { renderMessageTemplate } from './lib/message-template.js';
import { evaluateAbuseGate } from './lib/abuse-controls.js';
import { resolveChannelSize } from './lib/channel-size.js';
import { recordWelcomePromptOutcome } from './lib/welcome-metrics.js';
import { localizedTemplate, resolverValues, templateLine, templatesOf, withMessageTemplates } from './lib/message-lines.js';
import { buildConfigIdentity, componentVersion } from './lib/config-identity.js';
import { createHostContextRegistry, createTurnContextRegistry } from './lib/host-context-resolvers.js';
import { parseWhoIsHere } from './lib/who-is-here.js';
import { composeAnswerPrompt } from './lib/answer-prompt.js';
import { invokeBedrockWithFallback } from './lib/bedrock-resilience.js';
import { imageGenerationStep, makeConverseStep, type ConverseStep, type ToolCallRecord } from './lib/analytics-metadata.js';
import { resolveModelPlan, routedModel } from './lib/resolve-model-plan.js';
import { externalProviderFromEnv, invokeExternalLlm } from './lib/providers/external-llm.js';
import {
  invokeImageGenWithFallback,
  imageGenRegionFor,
  imageGuardrailFor,
  imageGenModelIdToKey,
  IMAGE_GEN_MODELS,
} from './lib/image-gen-models.js';
import { persistImageGenOutput, buildBattleImageContent, buildImageGenAttachment } from './lib/image-gen-output.js';
import { buildRetrievedContextHint, buildConversationSummaryHint } from './analytics-aurora/document-retrieval.js';
import { resolveTurnGrounding, type TurnGrounding } from './lib/turn-grounding.js';
import { findInboundMessage } from './lib/inbound-message.js';
import { readPublishedCatalog, selectSources, resolveContextSources, renderContextMenu, renderSourceSection, turnCallSite, eventStepCallSite, type PublishedContextSource } from './lib/context-sources-runtime.js';
import { buildSourceTable, catalogValues, clearanceSet, PREFERRED_LANGUAGE_KEY, sourceLookup, turnValues, versionLookup, whenHolds, withUnreadCatalog, type VariableValue } from './lib/variables.js';
import { createSourceReader } from './lib/context-source-readers.js';
import { roleContextS3Client } from './lib/company-context.js';
import { emitContextSourceOutcome, classifyAccessError, ContextSourceAccessError } from './lib/context-source-outcomes.js';
import {
  getTask,
  buildTaskContextForPrompt,
  deliveringContract,
  buildCrossChannelTasksHint,
  principalIdFromArn,
  buildConversationTasksHint,
  type ConversationTask,
  getOpenTasksForConversation,
  terminalStateAfterDelivery,
} from './lib/task-tracking.js';
// THE WRITES GO THROUGH THE SEAM, and the reads beside them above do not need to.
//
// This role holds no direct write on the task tables - the task migration moved that to the
// service - but the table NAMES are still in its environment, so the `if (!TASKS_TABLE) return`
// guards inside the direct implementation never fire. Called directly these three reached
// DynamoDB, were refused, and task-tracking swallowed the refusal: a delivery was never recorded
// and a failed placeholder was never marked, silently, on every turn that tried.
import { updateTaskStatus, recordTaskDelivery, advanceTaskStateTo } from './lib/task-store.js';
import { clampResponseMaxTokens, taskStateMachines, toolsForIntent, hydrateIntentPackFromSsm, getIntentPack, needsOf, turnNeedsImage, knownIntentKeys, type IntentPack } from './lib/intent-pack.js';
import { documentWrittenOnStep, enteredStepModel, modelTheTurnEndedOn, stepOutputOf, taskIntentOf, type StepModelChoice } from './lib/step-models.js';
import { classificationAllows } from '../../lib/config/model-availability.js';
import { intentDefFor, deliverAsFile, fileForAnswer, answerShapeIssues } from './lib/intent-answer.js';
import { buildReferentHint } from './lib/task-referent.js';
import { taskRefHintLine, taskStillOpenLine } from './lib/task-reference.js';
import { buildOpenWorkSummary } from './lib/open-work-summary.js';
import { awaitedPartyOf, type TaskStateMachine } from './lib/task-state-machines.js';
import { buildTaskSystemPrompt } from './lib/task-step-prompt.js';
import { deliveredDocumentReference, type DeliveredDocumentReference, type DocumentTemplateRecord } from './lib/delivered-document.js';
import { checkAgainstTemplate, type TurnTemplates } from './lib/document-template.js';
import { loadTurnTemplates } from './lib/template-store.js';
import type { DeclaredTemplate, TurnVariables } from './lib/task-tools.js';
import { isPrivateVisibility } from './lib/task-visibility.js';
import {
  acceptCorrection,
  correctionInstruction,
  correctionProgressLine,
  deliverableIssues,
  documentWordCount,
  phraseShadowKinds,
  postInline,
  recordedLengthTarget,
  stillFailingPackaging,
  templateCheckOutcome,
} from './lib/deliverable-check.js';
import { edgeDelivers, templateRefsOfMachine } from './lib/task-state-machines.js';
import { getModelCatalog, INTENT_ROUTE_STRATEGY } from '../../lib/config/model-strategy.js';
import { EXTERNAL_MODELS } from '../../lib/config/model-catalog.js';
import { resolveActiveProfile, ownerEventWorkflows, resolveProfileVersion, resolveFromDefinition, buildIntentStrategy, platformRoutesServedOn, personaAddendumBlock, rememberRuntimeSeed } from './lib/active-profile.js';
import type { AssistantCopy } from './lib/active-profile.js';
import { noticeLine } from './lib/assistant-notice.js';
import { hydrateBodies } from './lib/profile-bodies.js';
import { triageContractDirective, mayTakeAnotherPass, QUEUED_CLARIFICATION_TASK_TYPE } from './lib/turn-triage-proposal.js';
import { recallClarifiedMessage } from './lib/queue-drain-task.js';
import { UTILITY_MODEL_ID } from '../../lib/config/model-strategy.js';
import { sessionClient, sessionDocumentClient } from './lib/assistant-session.js';
import { botIdFromArn, personIdFromArn } from './lib/person-arn.js';
import { sendChannelMessage, sendInParts, splitIntoChunks } from './lib/chime/send.js';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { loadProfileRegistry } from '../../lib/profile-registry';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
// SPEC-PORTABLE-PROFILES P0: root for the per-profile SSM namespace (/{root}/assistant/{name}/…).
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

// The serving profile: the classification's primary assistant (e.g. `concierge`, `analyst`, `advisor`).
// Set by the assistant-profile stack; drives the persona default + the model-strategy userType key.
//
// NO DEFAULT (ADR-046). A processor deployed without its profile is refused at module load, the way the
// federated handlers refuse a missing classification, rather than serving every turn as some other
// assistant.
const PROFILE_NAME = (process.env.PROFILE_NAME || '').trim() as AsyncProcessorConfig['userType'];
if (!PROFILE_NAME) {
  throw new Error('[AsyncProcessor] PROFILE_NAME is not set; this processor serves no assistant and refuses to load');
}
/**
 * THE CLASSIFICATION THIS ASSISTANT IS ASSIGNED - an access fact, not a profile lookup.
 *
 * Separate from `PROFILE_NAME`, and THE TWO NO LONGER HOLD THE SAME STRING. A classification
 * REFERENCES a profile in `config/profiles.ts` (`{ value, profile }`), and a profile name may not be
 * a classification value at all (`validateProfilesConfig`), so `premium` is served by `advisor`. A
 * profile is capability configuration and is operator-editable; a classification is a boundary and
 * must not move because a persona was edited.
 *
 * NO FALLBACK TO `PROFILE_NAME`. It fell back that way while the two were the same string, and after
 * the rename that fallback would answer an access question with a profile name: `grantsFor('advisor')`
 * is empty, `modelsOf` names no selection, and `context/advisor/_digest.json` does not
 * exist - every one of which degrades silently rather than failing. An empty value is the honest
 * answer for a processor deployed without its classification, and it fails closed through the same
 * three paths rather than pretending to be a classification that is not.
 */
const CLASSIFICATION = (process.env.CLASSIFICATION || '') as AsyncProcessorConfig['userType'];

/**
 * The token store a proposal is written to (ADR-061 decision 8), on the turn's session: proposing is the assistant's act,
 * so the record is written as the assistant, under the acting role's `proposal#*` grant alone.
 */
let proposalsDocClient: DynamoDBDocumentClient | null = null;
const proposalsDoc = (): DynamoDBDocumentClient => (proposalsDocClient ??= sessionDocumentClient({ region: AWS_REGION }, { marshallOptions: { removeUndefinedValues: true } }));
/**
 * THE ROLE THIS ASSISTANT HOLDS in its classification (DESIGN-SEPARATE-ASSISTANTS 3.0), stamped by
 * the stack like the classification above.
 *
 * EMPTY RECORDS NOTHING rather than defaulting to 'primary'. A default would make a processor that
 * was never told its role indistinguishable from one that holds the only role there is, which is
 * the same shape of plausible-but-unverifiable value that let a classification stand in for an
 * assistant. A missing role is discoverable; an assumed one is not.
 */
const ASSISTANT_ROLE = process.env.ASSISTANT_ROLE || '';

// THE DEPLOYMENT'S CAPABILITY, forwarded as an env string: does this classification wire battle at
// all (ADR-049). /battle assembly + image paths are gated on it. Whether an operator has TURNED
// battle on is runtime policy, checked by the flow before a duel is ever dispatched here.
const BATTLE_CAPABLE = process.env.BATTLE_CAPABLE === 'true';
const MODEL_NAME = process.env.MODEL_NAME || 'Claude';

const s3Client = sessionClient(S3Client, { region: AWS_REGION });

/**
 * DynamoDB client for `dynamodb-table` context sources, created on FIRST USE.
 *
 * Lazy on purpose: every profile pays this module's import cost on cold start, and a deployment whose
 * profiles select no DynamoDB-backed source should not construct a client it never calls.
 */
let ddbClientSingleton: import('@aws-sdk/client-dynamodb').DynamoDBClient | undefined;
function contextDdbClient(): import('@aws-sdk/client-dynamodb').DynamoDBClient {
  if (!ddbClientSingleton) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    ddbClientSingleton = sessionClient(DynamoDBClient, { region: AWS_REGION });
  }
  return ddbClientSingleton!;
}

/**
 * Lambda client for `lambda-service` context sources, same lazy rationale.
 *
 * This was MISSING, which made `lambda-service` the one published type that could never resolve: the
 * stack emitted its `lambda:InvokeFunction` grant, the catalog published the key, and the reader had
 * no client to call with. Published, granted, unreadable - the exact fail-open shape INV-CTX-CAT-3
 * exists to prevent, and the type an implementer swaps in to front their own profile store.
 */
let lambdaClientSingleton: import('@aws-sdk/client-lambda').LambdaClient | undefined;
function contextLambdaClient(): import('@aws-sdk/client-lambda').LambdaClient {
  if (!lambdaClientSingleton) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    lambdaClientSingleton = sessionClient(LambdaClient, { region: AWS_REGION });
  }
  return lambdaClientSingleton!;
}

/**
 * Read one SSM parameter. Absent ⇒ null. Anything else THROWS.
 *
 * ParameterNotFound is the normal state on a deployment that has configured no source, so it is null.
 *
 * Every other failure - above all AccessDenied - is a wiring fault and must propagate. Returning null
 * for it turned a missing IAM grant into "profile selects 'company-docs', not in this classification's
 * catalog", which blames the PROFILE for an infrastructure bug and cost a live debugging cycle.
 *
 * Logging it was not enough, and that is the subtle part. A swallowed denial still produced an empty
 * catalog, so every selected key counted `not-in-catalog` (a Skipped, not a Failed) and the
 * failure-rate alarm - which divides Failed by Failed+Resolved - stayed at zero while nothing worked.
 * The caller's `(catalog)` handler can only classify what reaches it, so this has to throw.
 */
async function getSsmParameter(name: string): Promise<string | null> {
  const res = await ssmClient.send(new GetParameterCommand({ Name: name }));
  return res.Parameter?.Value ?? null;
}
const ssmClient = sessionClient(SSMClient, { region: AWS_REGION });

const CONFIG: AsyncProcessorConfig = {
  model: process.env.MODEL_ID || UTILITY_MODEL_ID,
  maxTokens: Number(process.env.MAX_TOKENS) || 4096,
  temperature: 0.7,
  // THE CLASSIFICATION, NOT THE PROFILE NAME. `userType` is consumed as an access fact:
  // `loadCompanyContext` resolves prefixes through `grantsFor`, `loadContextDigest` builds
  // `context/{userType}/_digest.json`, and `resolveModelForIntent` checks the classification's selection.
  // A profile name here resolves to an empty grant set, a missing digest and a catalog that allows
  // no model - each of which degrades silently rather than failing. It read PROFILE_NAME only while
  // a profile was named after its classification.
  userType: CLASSIFICATION,
};

// The host's per-turn context resolvers (domain context, participant profile), built once at cold
// start. Each resolver no-ops to '' for a generic (non-plan) AE turn, so the composed prompt is
// byte-identical for a channel with no host grounding.
const hostContextRegistry = createHostContextRegistry();
// The sections that change within a conversation (who is here), rendered after the cache boundary.
const turnContextRegistry = createTurnContextRegistry();

// ============================================================
// Per-profile persona (default) + SSM/env override
// ============================================================
//
// The built-in persona is DECLARED: the `defaultPersona` of the profile serving the classification
// (`profiles.ts`), with `{model}` replaced by MODEL_NAME. A deployment overrides the persona
// per profile via ASSISTANT_SYSTEM_PROMPT_PARAM (SSM — a rich persona can exceed Lambda's 4 KB env
// cap) or ASSISTANT_SYSTEM_PROMPT (inline env). A profile that declares none, and a classification this
// deployment does not declare, get the generic template below.

/** The declared persona of the profile serving `classification`, or a generic template when it declares none. */
function defaultPersonaFor(classification: string): string {
  const declared = defaultProfileRegistry.profileFor(classification)?.defaultPersona;
  return (
    (declared ? declared.split('{model}').join(MODEL_NAME) : '') ||
    `You are an AI assistant in Agent Echelon, an enterprise conversational AI platform running on ${MODEL_NAME}. ` +
      `Users interact with you through a chat interface.\n\n` +
      `Guidelines:\n` +
      `- Be direct and helpful; use markdown formatting when it helps readability.\n` +
      `- If asked about "this tool" or "this app", explain that you are part of Agent Echelon, an enterprise AI assistant platform.\n` +
      `- Answer directly. Do NOT open with disclaimers such as "as an AI assistant" or "I don't have access to..."; never refuse and then comply in the same reply.`
  );
}

let cachedSystemPrompt: string | null = null;
async function resolveBaseSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  const param = process.env.ASSISTANT_SYSTEM_PROMPT_PARAM?.trim();
  if (param) {
    try {
      const r = await ssmClient.send(new GetParameterCommand({ Name: param }));
      if (r.Parameter?.Value?.trim()) {
        cachedSystemPrompt = r.Parameter.Value.trim();
        return cachedSystemPrompt;
      }
    } catch (e) {
      console.error('[AssistantAsyncProcessor] system-prompt SSM hydrate failed; using env/default:', e);
    }
  }
  cachedSystemPrompt = process.env.ASSISTANT_SYSTEM_PROMPT?.trim() || defaultPersonaFor(CLASSIFICATION);
  return cachedSystemPrompt;
}

// Per-intent response budget. The router forwards the intent's `responseSettings.maxTokens` (from the
// pack) in the event; it WINS, clamped to the profile's token limit (CONFIG.maxTokens) with a reasoning
// floor. Absent => the profile default. This is how a deployment sizes answers per intent via config.
function resolveMaxTokens(event: AsyncProcessorEvent, reasoning: boolean): number {
  return clampResponseMaxTokens(event.responseSettings?.maxTokens, CONFIG.maxTokens, reasoning);
}

/**
 * WHETHER THIS TURN MAY USE AN EXTERNAL (NON-AWS) PROVIDER on the context-routing path
 * (SPEC-CONTEXT-AWARE-MODEL-ROUTING, "The external-provider gate"): whether the classification selects that
 * provider's catalog model (`deepseek_api` for DeepSeek, `model-catalog.ts`), which is also exactly where its
 * stack holds the provider's key. A profile version enables nothing. A provider the catalog does not list is
 * never selected and is withheld.
 */
export function externalProviderSelected(classification: string, provider: string): { allowed: boolean; withheldReason?: string } {
  const key = Object.values(EXTERNAL_MODELS).find((m) => m.provider === provider)?.key;
  if (key && defaultProfileRegistry.selectsModel(classification, key)) return { allowed: true };
  return {
    allowed: false,
    withheldReason: key
      ? `the ${classification} classification does not select ${key}`
      : `the instance's model catalog lists no external ${provider} model`,
  };
}

/**
 * THE MODEL AN EXPERIMENT FORCES OVER THE TURN'S OWN RESOLUTION, if any (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP
 * §3.5). A turn that serves a version (an enrolled experiment arm, a duel side) is answered through that
 * version's routes and base model like any version, so nothing is forced: a `resolvedModel` beside a
 * version (from a router that predates this) is ignored. Only a model-only variant of an experiment armed
 * before versions were pinned still overrides the turn's model.
 */
export function experimentModelOverride(event: { variantProfile?: unknown; resolvedModel?: string }): string | undefined {
  return event.variantProfile ? undefined : event.resolvedModel;
}


/**
 * TRUE until this container has served one turn (G9, LATENCY-TARGETS.md).
 *
 * Cold start is the documented reason TTFF and worker compute legitimately diverge - the init runs
 * BEFORE handler entry, so `total_ms` cannot contain it while `ttff_ms` (Chime clock, from the user's
 * message) necessarily does. Until now that divergence was reasoning offered in prose, so an operator
 * looking at a slow TTFF beside a fast worker number had no way to tell a cold container from a
 * regression, and the doc could only advise them to "annotate it as cold-start, not error".
 *
 * Module scope is what makes it a measurement rather than a guess: the module body runs once per
 * container, so the first invocation on a fresh container sees `true` and every reused invocation
 * sees `false`. Read and flipped at handler ENTRY, before any await, so a concurrent second event
 * cannot also claim the cold start.
 */
let containerIsCold = true;

/**
 * NAME THE MESSAGE THIS TURN IS ANSWERING, so a reading of the queue behind it can say what the work
 * in flight IS (ADR-033).
 *
 * HERE RATHER THAN IN THE ROUTER, because the router's copy sat in front of the first frame: the
 * `ListChannelMessages` that recovers the id, and the DynamoDB write behind it, were both inside
 * TTFF for a value a drain does not read until a queue has formed. Nothing about the placeholder
 * depends on either.
 *
 * The id when the router already had one, and the shared matcher when it did not - `findInboundMessage`
 * is the same read the router uses for a task row, so there is one set of rules about which message
 * counts rather than two that can disagree.
 *
 * NON-FATAL AT EVERY STEP. An unresolved id costs the drain a description, never the turn.
 *
 * EXPORTED so the rule below can be driven through this module rather than through a copy of it. The
 * instant it picks and the matcher it picks it for are the whole behavior, and a test that reassembled
 * either would pass while the turn did something else.
 */
export async function recordWhatThisTurnIsAnswering(
  event: AsyncProcessorEvent,
  /** This handler's own entry instant, the fallback start when the dispatch carries no router log. */
  processorEntryAt: number,
): Promise<void> {
  try {
    const responderId = principalIdFromArn(event.botArn);
    if (!event.channelArn || !responderId || !event.correlationId) return;
    const messageId = event.userMessageId
      || (await findInboundMessage({
        channelArn: event.channelArn,
        senderArn: event.senderArn || '',
        botArn: event.botArn,
        userMessage: event.userMessage,
        // A WIDER WINDOW THAN THE ROUTER'S, because this read happens LATER. The router read the
        // channel before its own placeholder existed, with at most the person's own message above the
        // one it wanted. By the time this runs the placeholder is posted, a deferral notice may be
        // too, and messages are queueing behind the running turn - which is exactly the condition
        // that makes this record worth writing at all. A message that falls out of the window is not
        // found, nothing is recorded, and every amendment behind this turn is then misclassified as
        // new work: the defect the record exists to prevent, reappearing under load.
        maxResults: 50,
        // ── AND NOT PAST THE INSTANT THIS TURN STARTED (ADR-038 option F) ───────────────────────
        //
        // The wider window above is what makes the newest-first rule wrong here. A person who sends
        // "ok", waits, and sends "ok" again has a second identical message queued behind this turn by
        // the time this read runs, and the newest match is that one - so the running turn would record
        // that it is answering a message it is not answering, the queued message would be claimed by a
        // turn that will never fold it, and the message that started this turn would be claimed by
        // nobody. The exchange minted from it is then short by the interval between the two sends, and
        // it is admitted to the measured average with nothing about it looking wrong.
        //
        // WHICH INSTANT, and why this one. The router's `entry` mark is the earliest instant this
        // turn's own path recorded, and everything else on offer is later: the claim, the dispatch,
        // this handler's entry. Earliest is what makes the bound tightest, and it is still safely
        // after the message being answered, because that message had to exist for the channel flow
        // and Amazon Lex to invoke the router at all. So the true message always passes and the
        // repeats queued behind this turn do not.
        //
        // THE TWO CLOCKS ARE DIFFERENT AND THE MARGIN ABSORBS IT. `createdAt` is Amazon Chime SDK's
        // clock and this is a Lambda's, so the comparison is cross-clock in the same way
        // `exchanges.inbound_ms` already is. What separates them is the inbound leg - the channel
        // flow, Amazon Lex and the router's own entry - which is hundreds of milliseconds, orders
        // above any plausible skew between two NTP-disciplined AWS clocks. A skew large enough to
        // matter costs a declaration, never a wrong one.
        //
        // NO ROUTER LOG MEANS NO ROUTER, so this handler's own entry is the earliest instant the turn
        // has. It is later and therefore looser, and it is still before anything that can queue behind
        // a turn that has not yet posted its placeholder.
        notAfter: event.routerSteps?.find((s) => s.step === 'entry')?.at ?? processorEntryAt,
      })).messageId;
    if (!messageId) return;
    // AND THE TURN KEEPS IT. A turn that parks or folds carries its event forward, and without the id
    // the resumed or folded run cannot find its own message: its history was then bounded by the
    // queue alone and read the queue notice, two reading messages and the proposal back as assistant
    // turns (live 2026-09-14, `hadId: false`).
    if (!event.userMessageId) event.userMessageId = messageId;
    await rememberHolderMessage({
      channelArn: event.channelArn,
      responderId,
      correlationId: event.correlationId,
      messageId,
    });
  } catch (err) {
    console.warn('[AssistantAsyncProcessor] could not record what this turn is answering (non-fatal):',
      (err as Error)?.message);
  }
}

/**
 * RESUME AN ANSWER THAT WAITED FOR A READING (ADR-033, owner 2026-09-14).
 *
 * The answer was finished and parked at the fold checkpoint while a reading beside it was still deciding
 * which queued messages are follow-ups. The reading has now recorded them and handed the conversation
 * back, so this run takes the stored finalize inputs and runs the SAME finalize again: the checkpoint
 * folds what was recorded, or finds nothing and delivers the draft. No model call is repeated unless
 * there is something to fold.
 *
 * EXACTLY ONCE. `takeParkedTurn` removes the stored inputs conditionally, so a duplicate delivery finds
 * nothing and touches neither the lock nor the conversation.
 */
async function resumeParkedTurn(resume: ResumeParkedEvent): Promise<void> {
  const { botArn, correlationId } = resume.resumeParked;
  // A parked answer is posted by the assistant that wrote it, so the resume acts as that assistant.
  await adoptTurnIdentity(correlationId, botArn);
  try {
    await deliverParkedTurn(resume);
  } finally {
    await endAssistantTurn();
    turnAssistantName = '';
    turnCopy = undefined;
    turnDefinition = undefined;
    turnAssistantRole = '';
  }
}

async function deliverParkedTurn(resume: ResumeParkedEvent): Promise<void> {
  const { channelArn, botArn, correlationId } = resume.resumeParked;
  const responderId = principalIdFromArn(botArn);
  const stored = await takeParkedTurn({ channelArn, responderId, correlationId });
  if (!stored) {
    // A DUPLICATE, OR A RETRY AFTER THE RUN THAT TOOK IT DIED. The two cannot be told apart without a
    // clock. What can be told is whether the conversation is still held under this turn with nothing
    // parked: after a death that is a stranded lock, and nothing else will ever release it. Released,
    // on the rule this module is built on - a second answer is recoverable, a conversation that never
    // answers again is not. LOUD, because the parked answer itself is lost on this path.
    const state = await readTurnState({ channelArn, responderId }).catch(() => undefined);
    if (state && state.holder === correlationId && !state.parkedTurn) {
      console.error('[AssistantAsyncProcessor] a resume found nothing parked while this turn still holds the '
        + 'conversation; releasing it. The parked answer was not delivered', {
        channelId: channelArn.split('/').pop(), correlationId,
      });
      await settleTurnLockAtExit({ admitted: true, redispatchedPass: false, channelArn, botArn, correlationId });
      return;
    }
    console.warn('[AssistantAsyncProcessor] nothing parked to resume; another run already took it', {
      channelId: channelArn.split('/').pop(), correlationId,
    });
    return;
  }
  let params: Parameters<typeof finalizePlaceholderResponse>[0];
  try {
    params = JSON.parse(stored);
  } catch (err) {
    // An unreadable record cannot be delivered; the conversation must not stay held by it.
    console.error('[AssistantAsyncProcessor] the parked answer could not be read back; releasing the conversation', {
      correlationId, err: (err as Error)?.message,
    });
    await settleTurnLockAtExit({ admitted: true, redispatchedPass: false, channelArn, botArn, correlationId });
    return;
  }
  beginTurnGuardrailFindings();
  console.log('[AssistantAsyncProcessor] resuming a parked answer', {
    channelId: channelArn.split('/').pop(), correlationId,
  });
  let redispatchedPass = false;
  try {
    redispatchedPass = (await finalizePlaceholderResponse(params)).redispatched;
  } catch (error) {
    await handleProcessingError(params.event, error, turnCopy);
  } finally {
    await settleTurnLockAtExit({
      admitted: true,
      redispatchedPass,
      channelArn,
      botArn,
      correlationId,
      ...(params.event.classification ? { classification: params.event.classification } : {}),
      ...(params.copy ? { copy: params.copy } : {}),
    });
  }
}

/**
 * THE ASSISTANT THIS TURN IS ACTING AS, and its assistant role, or '' when none is held.
 *
 * Set by `adoptTurnIdentity` and read where the turn resolves its behavior and its attribution, which
 * are later in the handler. Cleared per turn beside the session, so a warm container never lets one
 * assistant answer in the previous one's voice.
 */
let turnAssistantName = '';
/** The turn's assistant's copy once its profile is read, so a failure is said in that assistant's words. */
let turnCopy: AssistantCopy | undefined;
/** Whether the turn's assistant is a runtime assistant (ADR-048): the vend sent its seed. */
let turnAssistantIsRuntime = false;
let turnAssistantRole = '';
/** The definition version the turn's session was narrowed by (`assistant-grant.ts`); served exactly. */
let turnDefinition: { profileName: string; version: number } | undefined;

/**
 * ACT AS THE ASSISTANT THE ROUTER ROUTED THIS TURN TO (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * The vend reads the routing record the router wrote for this correlation id and mints a session for
 * the assistant it names; the processor never names an assistant itself. The bot the event says to
 * answer as must be the routed one: a mismatch means the payload names an identity nobody routed, and
 * the turn is refused rather than answered.
 *
 * THROWS RATHER THAN FALLING BACK. There is no other identity to answer with, so a refused session
 * fails the turn; the async invoke's retries and the failure destination handle a transient fault.
 */
async function adoptTurnIdentity(correlationId: string, botArn?: string): Promise<void> {
  const session = await actAsAssistant(correlationId);
  if (botArn && botArn !== session.botArn) {
    releaseAssistantIdentity();
    throw new Error(`[AssistantAsyncProcessor] the event names a bot the turn was not routed to (${correlationId})`);
  }
  turnAssistantName = session.assistant;
  turnAssistantRole = session.role;
  turnDefinition = session.definition;
  // A runtime assistant (ADR-048) has no compiled profile; the vend built its seed from its own record.
  turnAssistantIsRuntime = !!session.seed;
  if (session.seed) rememberRuntimeSeed(session.seed);
  console.log('[AssistantAsyncProcessor] acting as', actingAs());
}

/** The part of the Lambda context a turn reads: the time it has left, for work that is optional (an image fallback). */
type TurnContext = { getRemainingTimeInMillis(): number };

/**
 * WHO IS IN THE ROOM, FOR A TURN NO PERSON ASKED FOR: an event workflow's agent step (whose fallback mentions only
 * members) and a prompt welcome (whose model is given the names of the people it greets). These are the only turns
 * this processor reads membership for, and they read it once, on this assistant's session, failing to nobody.
 *
 * Neither has a roster the router read. The router posts the opening and hands either turn over without waiting on a
 * membership read (SPEC-WELCOME-AND-CONTEXT FR2), and at the join the live roster converges only after the opening,
 * so a read here, later, sees the room the turn speaks to. A person's turn never reads one: its who-is-here section is
 * the roster the router read for that turn and handed over (`rosterForDispatch`), so two reads cannot disagree.
 */
function machineTurnRoster(channelArn: string, botArn: string): Promise<Array<{ arn: string; name: string; isBot?: boolean }>> {
  return resolveChannelSize(messagingClient, channelArn, botArn).then((r) => r.members ?? []).catch(() => []);
}

export const handler = async (event: AsyncProcessorEvent, context?: TurnContext): Promise<void> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (isResumeParkedEvent(event)) return resumeParkedTurn(event);
  const startTime = Date.now();
  // Set by the "another pass" exit of finalizePlaceholderResponse: a triage turn was dispatched on
  // THIS correlation id and is still reading. It takes no lock of its own, so this turn must not
  // release the one it is running under (invariant A, ADR-033).
  let redispatchedPass = false;
  // Whether this run won the dedup claim. Only an admitted run may settle the turn lock (`finally`).
  const admission = { admitted: false };
  const coldStart = containerIsCold;
  containerIsCold = false;
  // OPEN THIS TURN'S GUARDRAIL-FINDINGS SCOPE BEFORE ANY PATH CAN RECORD ONE. The findings are
  // compliance evidence, and several turn paths (an input-guardrail block, the external-provider
  // path, a failure announcement) never run an output guardrail - in a warm container they would
  // otherwise read the previous turn's and record its interventions as their own breach.
  beginTurnGuardrailFindings();
  // ── ACT AS THE ASSISTANT THIS TURN WAS ROUTED TO (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b) ────────────────────────────────────
  //
  // Everything this turn does goes out on a session the vend minted for the routed assistant. The
  // Lambda's own role is bootstrap-only, so nothing below can act as anyone else. Released in the
  // `finally`, so a warm container never lets one turn's identity serve the next.
  await adoptTurnIdentity(event.correlationId, (event as { botArn?: string }).botArn);
  // ── THE ROOM'S OWN ASSISTANT NAMES THE ROOM (`conversation-name.ts`) ─────────────────────────────────────────────
  //
  // Dispatched by the router when a person's message the room is still unnamed for went to an assistant that does not
  // moderate it. This assistant is the room's primary, acting as itself on the session the router routed to it: it
  // derives the title and renames the room only while it still carries the placeholder, and answers nothing. No turn
  // lock is taken or settled, so the turn that answers the message is untouched.
  if (event.nameRoom) {
    try {
      const { maybeDeriveAndRenameChannel } = await import('./lib/channel-title.js');
      const named = await maybeDeriveAndRenameChannel(event.channelArn, event.userMessage || '', event.botArn);
      console.log('[AssistantAsyncProcessor] the room\'s assistant named the room', { named: named !== null });
    } catch (err) {
      console.warn('[AssistantAsyncProcessor] the room could not be named (non-fatal)', { err: (err as Error)?.name });
    } finally {
      await endAssistantTurn();
      turnAssistantName = '';
      turnDefinition = undefined;
      turnAssistantRole = '';
    }
    return;
  }
  // Declared out here so the `finally` can settle it. See where it is started, below.
  let holderRecorded: Promise<void> = Promise.resolve();
  // THE WORDING THIS ASSISTANT WAS CONFIGURED WITH, HOISTED SO THE EXIT PATH CAN READ IT.
  //
  // `activeProfile` is resolved inside the `try` and is therefore invisible to the `finally`, so the
  // handover there reached for `event.variantProfile?.copy` - the only thing in scope. That field is
  // populated only on a battle or experiment VARIANT turn, so on an ordinary deployment it is always
  // undefined and the deferral notice the handover settles falls back to fixed English, whatever
  // voice and language the deployment configured (tenets P5 and D11). Two other call sites already
  // read `activeProfile.copy` correctly; this is the third, and it could not.
  let turnCopy: AssistantCopy | undefined;
  console.log('[AssistantAsyncProcessor] Invoked', JSON.stringify({
    profile: PROFILE_NAME,
    // The IDS ONLY - the two values that identify this turn and nothing else.
    //
    // This logged `channelArn.substring(0, 50)`, and a Chime ARN is about that long before it reaches
    // the instance id, so every line read `...:app-instance/` and identified nothing: a failure could
    // not be traced back to the conversation it happened in. The fix is not a longer ARN, though. The
    // prefix is identical on every line of every deployment - it carries the account and app-instance
    // ids and no information - so logging it is noise that also sprays real identifiers through
    // CloudWatch. The channel id alone is what a reader greps, and what `describe-channel` needs.
    channelId: event.channelArn?.split('/').pop(),
    placeholderMessageId: event.placeholderMessageId,
    correlationId: event.correlationId,
    taskType: event.taskType,
    taskId: event.taskId,
  }));

  try {
    // ── WHAT THIS TURN IS GROUNDED IN, FETCHED HERE AND STARTED FIRST ────────────────────────────
    //
    // Retrieval and the conversation summary used to be fetched by the router, in front of the first
    // frame. They are fetched here now (`lib/turn-grounding.ts` says why), and started BEFORE the
    // shared pipeline rather than at the point of use: the pipeline waits on the placeholder mapping,
    // which is dead time this can run inside, so the move off TTFF costs this turn nothing either.
    //
    // NOT AWAITED HERE, and it never rejects - both halves degrade to a safe value of their own - so
    // there is no window in which this is an unhandled rejection instead of a missing hint.
    //
    // NOT ON A FAILURE ANNOUNCEMENT, which is the one turn here that runs no model and therefore
    // reads no grounding - it exists because the expensive turn already spent its recovery dispatches
    // (`TURN_MAX_ATTEMPTS`, default 2, in turn-lock-release-on-failure.ts).
    const groundingPromise: Promise<TurnGrounding> = event.announceFailure
      ? Promise.resolve({})
      : resolveTurnGrounding({
        channelArn: event.channelArn,
        userMessage: event.userMessage,
        classification: event.classification,
        intent: event.intent,
      });

    // ── AND WHAT THE QUEUE BEHIND THIS TURN IS WAITING ON ────────────────────────────────────────
    //
    // Started here for the same reason as the grounding above - it overlaps the placeholder wait - and
    // SETTLED IN THE `finally`, not after the line below: an unresolved promise in Lambda is not a
    // background task, and a handler that returns first freezes the environment with the write never
    // sent. That is exactly how the router's first version of this silently did nothing. Awaiting it
    // here would have covered the early return and NOT a throw from the pipeline, which is a way out
    // of this block too.
    //
    // NOT ON A FAILURE ANNOUNCEMENT, for the same reason as the grounding and one more: that turn is
    // the recovery's cheapest path, reached only after three failures of the expensive one, and it
    // releases the lock moments later in its own `finally` - so the record it would pay a channel
    // read for is one no drain ever gets to read.
    holderRecorded = event.rememberHolder && !event.announceFailure
      ? recordWhatThisTurnIsAnswering(event, startTime)
      : Promise.resolve();

    const pipeline = await runSharedPipeline(event, admission);

    if (!pipeline) {
      return;
    }

    const { messageId, guardMs, placeholderResolveMs, pollMs, consolidatedHistory, priorAgentContext, bedrockMessages, isFirstUserTurn } = pipeline;

    // Build system prompt with the resolved persona + host per-turn context (domain grounding + i18n
    // + participant profile), assembled via the resolver registry + defensive composer. Each resolver
    // no-ops to '' for a generic AE conversation, so the composed prompt is byte-identical there.
    // Persona: prefer the ACTIVE profile version's persona - it rides the versioned/portable definition
    // (SPEC-CONFIGURABLE-ASSISTANTS §2 / SPEC-PORTABLE §5), so two versions can differ in character and an
    // import carries it. Fall back to the deployment persona seam (ASSISTANT_SYSTEM_PROMPT[_PARAM] →
    // default) when the version carries none. resolveActiveProfile is cached per container, so this shares
    // the resolution the model/guardrail path does below (no extra SSM round-trip).
    // SPEC-PORTABLE §6: when this turn is serving a `profileRef` variant, the VARIANT'S version is the
    // definition for the turn — persona, tools, classifier mode, guardrail selection, machines and
    // context sources — not the profile's active version. Built from the stamped definition rather than
    // read again: the router already resolved it, and re-reading could serve a version that changed
    // mid-turn. Deliberately does NOT populate the profile cache (keyed by profile name), or the next
    // ordinary turn on this warm container would inherit the variant's persona and tools.
    // The variant's definition arrives carrying a POINTER to its persona, not the persona itself: the
    // router that stamped it has no use for the body, so the body is fetched HERE, at the one place it
    // is read. An unreadable body throws rather than degrading to the profile's active version - a
    // variant quietly served as control is the exact shape that reports "indistinguishable" for a
    // reason that has nothing to do with what the experiment was testing.
    // ── WHICH ASSISTANT'S BEHAVIOR THIS TURN SERVES, from the assignment rather than the environment ────
    //
    // `PROFILE_NAME` is the classification's seeded assistant, one value per function. A
    // classification that declares a second role hosts a second assistant on the same runtime, so
    // resolving from the env would serve the PRIMARY's persona, intents and tools for a turn the ops
    // assistant was addressed for - the assistant would bear its own identity and answer in somebody
    // else's voice, with somebody else's tools.
    //
    // The assignment already knows: `adoptTurnIdentity` resolved it from the bot this turn was addressed
    // as, and the assignment record names the assistant. Falling back to the env keeps every
    // single-assistant classification on exactly the path it was on.
    // ── THE ASSISTANT'S NAME, ALWAYS, AND THE ALT INCLUDED (ADR-050) ─────────────────────────────
    //
    // The vend admits only a declared profile, the alt of a declared role (`alt-{role}-{classification}`),
    // or a runtime assistant with an active version (ADR-048), so a session that reached here names an
    // assistant with a profile of its own. The alt's seed is its
    // role's live descriptor under its own name, and its behavior is the version its experiment pinned. No
    // assistant ever answers on another assistant's profile. `PROFILE_NAME` serves only a turn with no
    // assigned assistant.
    const turnProfileName = turnAssistantName || PROFILE_NAME;
    // The assignment named an assistant with no profile and the primary's behavior serves it. Behavior may
    // fall back; an admin setting may not, so the external-provider gate reads this as "not allowed".
    const assistantFellBack = !!turnAssistantName && turnProfileName !== turnAssistantName;
    // THE VERSION THE SESSION WAS NARROWED BY, when the vend read one: serving a different version than
    // the one that decided the session's reach would ask for grants the session does not hold. Absent
    // (the seed, or a variant) resolves exactly as before.
    // A served variant carries its number beside it (`variantVersion`), so its turn is attributed to the version
    // it is, as an ordinary turn is to the active one; without it the number is left out, never guessed.
    const activeProfile = event.variantProfile
      ? { ...resolveFromDefinition(await hydrateBodies(event.variantProfile), turnProfileName), version: event.variantVersion }
      : turnDefinition && turnDefinition.profileName === turnProfileName
        ? await resolveProfileVersion(turnProfileName, turnDefinition.version, { ssm: ssmClient, ssmRoot: SSM_ROOT })
        : await resolveActiveProfile(turnProfileName, { ssm: ssmClient, ssmRoot: SSM_ROOT });
    // THE TURN'S WORDS (ADR-062): the message templates its version's `messages` names, its assistant's
    // family and its classification hold, read once here. Every line this turn says is selected from them.
    let versionCopy = withMessageTemplates<AssistantCopy>(await loadMessageTemplateSet({
      classification: CLASSIFICATION, assistant: turnProfileName, messages: activeProfile.messages,
      ...(activeProfile.variables ? { variables: activeProfile.variables } : {}),
    }));
    turnCopy = versionCopy;
    // Whether `activeProfile` is the assistant's active version itself. A variant or a narrowed version
    // is not, and the external-provider gate then also reads the active version.
    const servingIsActiveVersion = !event.variantProfile
      && !(turnDefinition && turnDefinition.profileName === turnProfileName);
    // THE PACK THIS TURN IS ANSWERED BY, and it is the one the router classified against: the serving
    // version's own pack, else the deployment pack the router hydrated from SSM - which this processor
    // now hydrates too, so the two can no longer disagree (SPEC-CONFIGURABLE-INTENT-PACK FR17).
    await hydrateIntentPackFromSsm();
    const turnPack: IntentPack = activeProfile.intentPack ?? getIntentPack();
    const turnIntentDef = intentDefFor(event.intent || '', turnPack);
    // Published to the hoisted binding the exit path reads. Assigned the moment it resolves, so a
    // turn that dies anywhere after this still settles its notice in the configured voice.
    turnCopy = versionCopy;
    // ── THE TURN'S TASK MACHINES, RESOLVED ONCE, HERE (ADR-047) ──────────────────────────────
    //
    // Every consumer below takes this value; none of them resolves again. It used to be resolved at
    // each point of use, and every pair of sites that disagreed was a silent defect with its own
    // symptom: a document delivered as chat text, a task stalled on a transition the prompt promised.
    //
    // THE FULL SET, DELIBERATELY - the workflow SELECTION is not applied here. A selection decides
    // what an assistant may OPEN, which is a router decision; it must not decide what may be RUN.
    // Narrowing here would strand every task opened before the selection changed: the graph would
    // vanish from under a task already in flight, `advance_task_state` would stop being offered for
    // it, and a person waiting on that work would get an ordinary reply and no way to finish it.
    // Gating the opening cannot strand anything, because nothing is in flight yet.
    // THE VERSION'S CONFIRMATION SETTING IS APPLIED HERE, once (ADR-064 decision G): every consumer of the turn's machines
    // reads the same answer to whether a complete request goes past a confirmed step.
    const turnMachines = withConfirmBrief(taskStateMachines(), activeProfile.confirmBrief);
    // ── THE TURN DIED AND ITS RETRIES ARE SPENT. SAY SO, AS THIS ASSISTANT ────────────────────
    //
    // The recovery handler could have posted this itself, and deliberately does not: messages in a
    // conversation come from ASSISTANTS. A shared recovery function speaking into any room would
    // need channel-send across every classification, which is a boundary widened for one apology,
    // and the line would carry none of this deployment's configured voice or language.
    //
    // So the recovery asks the assistant to speak, and this is that path. It is deliberately the
    // cheapest turn the processor has - no model call, no tools, no retrieval - because it runs
    // after three failures of the expensive one, and the whole point is that it succeeds where that
    // did not.
    //
    // The lock is released by this turn's own `finally`, the same as any other ending.
    if (event.announceFailure) {
      const copy = noticeLine(versionCopy, 'turnFailed');
      try {
        await sendInParts(messagingClient, {
          ChannelArn: event.channelArn,
          text: copy,
          Type: ChannelMessageType.STANDARD,
          Persistence: ChannelMessagePersistenceType.PERSISTENT,
          ChimeBearer: event.botArn,
          Metadata: JSON.stringify({ botResponse: true, respPhase: 'final', turnFailed: true }),
        });
      } catch (err) {
        console.error('[AssistantAsyncProcessor] could not announce a failed turn', {
          correlationId: event.correlationId, message: (err as Error)?.message,
        });
      }
      return;
    }

    const versionedPersona = activeProfile.persona;
    // ── THE CLASSIFICATION'S PERSONA IS THE PRIMARY'S, SO ONLY THE PRIMARY FALLS BACK TO IT ────────
    //
    // `resolveBaseSystemPrompt` reads `ASSISTANT_SYSTEM_PROMPT_PARAM`, which is keyed by
    // CLASSIFICATION and cached on the module. One runtime serves every role a classification
    // declares, so a second assistant whose version carries no persona would be given the primary's -
    // the same shape as the welcome defect in `router-agent-handler.ts`, which was measured in front
    // of a person (ADR-054). Unreachable on this deployment today because premium sets
    // `systemPromptParam: false`, and gated anyway: latent is what the welcome was until a
    // classification held two assistants.
    const isPrimaryAssistant = deploymentCopyAppliesTo(turnAssistantName, PROFILE_NAME);
    if (!isPrimaryAssistant && !versionedPersona?.trim()) {
      console.log(deploymentCopySkipped('persona', String(turnAssistantName), PROFILE_NAME));
    }
    const baseSystemPrompt = versionedPersona?.trim()
      || (isPrimaryAssistant ? await resolveBaseSystemPrompt() : defaultPersonaFor(CLASSIFICATION));

    // P4 config attribution — fingerprint the deployment config (persona resolved here + the pack
    // version the router forwarded) so this turn's analytics is sliceable by config, not just model.
    // Derived from the BASE prompt only (pre context/task append) so the id is a stable per-deploy
    // value. A fall-through to the profile default reads as personaVersion='default'.
    const configIdentity = buildConfigIdentity({
      personaVersion: baseSystemPrompt === defaultPersonaFor(CLASSIFICATION) ? 'default' : componentVersion(baseSystemPrompt),
      intentPackVersion: event.intentPackVersion ?? 'default',
      systemPromptHash: componentVersion(baseSystemPrompt, 'empty'),
    });

    // ── THE SYSTEM PROMPT, FROM THE ONE COMPOSER A GOLDEN RUN ALSO CALLS (ADR-065) ─────────────────
    //
    // The persona and THE VERSION'S PERSONA ADDENDUM (a duel side's pinned version carries its variant's addendum this
    // way, §3.7, and so does any version promoted from one) with the host's per-turn context form the stable base; the
    // composer reports its length so invokeBedrock can insert a Bedrock cachePoint after it. On /battle turns
    // systemPrompt is reassembled below but still leads with this same stable base, so the prefix remains a valid front
    // slice. invokeBedrock places the company document menu at the end of this prefix and grows it by the menu's
    // length, so the menu is cached too.
    //
    // Everything after the prefix varies by turn, intent or person and stays out of the cache: HOW TO ANSWER THIS
    // INTENT from the pack the router classified against (scope and delivery come from the pack, never from persona
    // prose, SPEC-CONFIGURABLE-INTENT-PACK FR17-FR21); the first-turn greeting by name (A3), withheld from a person an
    // event run already greeted (ADR-061 decision 5, decided from the run's record, never from what was posted); WHO
    // the user is, on every turn, because a name asserted in conversation can arrive on any turn; HOW THIS PERSON ASKED
    // TO BE ANSWERED (the router attached the value keys; the text is the registry's); WHAT THE SPEAKER LABELS MEAN
    // (ADR-027 part 2, '' unless the transcript carries labels); and WHO IS HERE, from the roster the router read
    // where more than one assistant could answer (`lib/who-is-here.ts`).
    const greet = isFirstUserTurn && !(await wasGreetedByEventRun({ channelArn: event.channelArn, personArn: event.senderArn ?? '' }).catch(() => false));
    const whoIsHere = parseWhoIsHere(event.whoIsHere);
    const composed = composeAnswerPrompt({
      persona: baseSystemPrompt,
      addendum: activeProfile.systemPromptAddendum,
      hostSections: hostContextRegistry.resolveSections(event),
      intent: event.intent || '',
      pack: turnPack,
      transcript: bedrockMessages,
      context: {
        senderDisplayName: event.senderDisplayName,
        greet,
        replyPreferences: event.replyPreferences,
        preferenceTurn: event.preferenceTurn,
        heldQuestion: event.heldQuestion,
        turnSections: turnContextRegistry.resolveSections({ whoIsHere }),
      },
    });
    let systemPrompt = composed.systemPrompt;
    let cacheableSystemPrefixLength = composed.cacheablePrefixLength;

    // Catalog context sources (SPEC-CONTEXT-SOURCES-AND-STORES phase 5). The profile SELECTS keys; this
    // resolves them against the classification's published catalog and appends one fenced section per
    // source, plus the AVAILABLE CONTEXT menu.
    //
    // Appended AFTER the cache-prefix capture, like the first-turn greeting and the task appends: these
    // values are per-turn and per-USER, so putting them inside the cached prefix would invalidate the
    // persona cachePoint on every request and raise the cost of every turn to serve one of them.
    //
    // Entirely inert until a profile sets `contextSources` - `selectSources` returns [] for an empty
    // selection and nothing below runs.
    //
    // WHERE THIS TURN STANDS (ADR-060 decision 4): a person's turn settles its sender; an event workflow's agent step
    // has no sender, and settles its run's subject only when the step's output is addressed to that subject, so a
    // room step is never handed a fact about one member. The sources read below, and every `ctx:` value a template
    // or a condition reads this turn, are settled by this one call site.
    const senderSub = personIdFromArn(event.senderArn) || '';
    // A STEP ANOTHER ASSISTANT TAKES (`as: { role }`) is read from the run's assistant's active version, which declares it;
    // this turn stays this assistant's own, its persona, its session and its grants.
    const stepOwner = event.eventStep?.workflowOwner && event.eventStep.workflowOwner !== turnProfileName ? event.eventStep.workflowOwner : undefined;
    const stepWorkflows = stepOwner
      ? await ownerEventWorkflows(stepOwner, { ssm: ssmClient, ssmRoot: SSM_ROOT })
      : activeProfile.eventWorkflows;
    const eventStepDef = event.eventStep ? workflowFor(stepWorkflows, event.eventStep.workflow)?.states[event.eventStep.step]?.agent : undefined;
    const subjectSub = event.eventStep ? personIdFromArn(event.eventStep.subject) || '' : '';
    const turnSite = event.eventStep
      ? eventStepCallSite(subjectSub, eventStepDef?.to === 'subject', event.channelArn)
      : turnCallSite(senderSub, event.channelArn);
    const sourcePersonId = event.eventStep ? (turnSite.subjectSettled ? subjectSub : '') : senderSub;
    // The catalog and the `ctx:` values this turn read, held for its templates and conditions (`turnVariables`).
    let turnCatalog: PublishedContextSource[] | undefined;
    let turnCatalogValues: Record<string, VariableValue> = {};
    try {
      const selection = activeProfile.contextSources;
      if (selection?.length) {
        // Throws on anything but ParameterNotFound, so a denied catalog read reaches the `(catalog)`
        // handler below instead of quietly becoming an empty catalog.
        const catalog = await readPublishedCatalog(
          // CLASSIFICATION-KEYED. The catalog is published at
          // `/assistant/{classification}/context-sources` and its IAM grant names that exact key, so
          // a profile name here is an AccessDenied rather than a miss - which this call deliberately
          // propagates, making every catalog source silently unavailable on every turn.
          () => getSsmParameter(`${SSM_ROOT}/assistant/${CLASSIFICATION}/context-sources`),
        );
        turnCatalog = catalog;
        // On a real turn the sender is resolved and the channel exists, so both availability gates are
        // met. The creation-time welcome is the call site where they are not - see the router.
        const callSite = turnSite;
        // THE CLASSIFICATION, which these parameters are named for. It is passed to both calls so
        // every source's disposition lands in CloudWatch under AgentEchelon/ContextSources. Without
        // it the feature is observable only by reading this log group by hand, which is not a control
        // an operator can alarm on - see GUIDE-ASSISTANT-CONTEXT "Monitoring and access review".
        // COMPANY CONTEXT IS READ AS THE ASSISTANT, FOR ITS ROLE (DESIGN-SEPARATE-ASSISTANTS-AND-
        // DELEGATION Phase 1b). A catalog `s3-prefix` source under `context/` is the same documents the
        // company-context tool reads, and the shared Lambda role holds no grant on them. Such a source is
        // kept only when the assistant's role is scoped to its prefix, and read on the assistant's credentials,
        // so an ops assistant in premium is not offered premium's financials through the catalog either.
        const scope = companyContextScope(CLASSIFICATION);
        const isCompanyContext = (e: { type: string; prefix?: string }) =>
          e.type === 's3-prefix' && (e.prefix || '').startsWith('context/');
        const chosen = selectSources(catalog, selection, callSite, CLASSIFICATION)
          .filter((e) => !isCompanyContext(e) || scope.prefixes.some((p) => (e.prefix || '').startsWith(p)));
        if (chosen.length) {
          // A source about a person is read for the person this call site settled: the sender, or the step's subject.
          const readerCtx = { classification: CLASSIFICATION, personId: sourcePersonId, channelArn: event.channelArn };
          const clients = { s3: s3Client, ddb: contextDdbClient(), ssm: ssmClient, lambda: contextLambdaClient() };
          const sharedRead = createSourceReader(readerCtx, clients);
          const roleContextRead = scope.credentials
            ? createSourceReader(readerCtx, { ...clients, s3: roleContextS3Client(scope.credentials) })
            : sharedRead;
          const resolved = await resolveContextSources(chosen, {
            callSite,
            classification: CLASSIFICATION,
            // No resource map: each entry carries its own locator and prefix from the published
            // catalog, so the read lands where the grant was scoped rather than at an env-var path.
            read: (entry) => (isCompanyContext(entry) ? roleContextRead(entry) : sharedRead(entry)),
          });
          // The menu names what the model HAS this turn, so it is built from what actually resolved,
          // never from the selection - listing a source that failed to resolve invites the model to
          // promise what it cannot deliver.
          systemPrompt += renderContextMenu(resolved.map((r) => r.entry));
          for (const r of resolved) systemPrompt += renderSourceSection(r);
          // The same values, typed, are what this turn's templates and conditions read as `ctx:` (ADR-060 decision 4).
          turnCatalogValues = catalogValues(resolved);
          // Positive confirmation that sources reached the prompt. Without it the only signal is the
          // ABSENCE of a warning, which cannot distinguish "resolved fine" from "never ran" - the
          // difference this project keeps getting caught by. Names what was asked for AND what landed,
          // so a source silently resolving to nothing is visible as a gap between the two.
          console.log('[context-sources] applied', {
            selected: selection,
            resolved: resolved.map((r) => r.entry.key),
          });
        }
      }
    } catch (err) {
      // The whole feature is additive context. A failure here must cost the sections, never the turn.
      //
      // But it must not cost the SIGNAL. This catch also covers the catalog read itself, and a failure
      // there takes out every source at once - which is the worst outcome and, before this, the only
      // one that emitted nothing at all. It has happened: the processor lacked `ssm:GetParameter` on
      // the catalog parameter, `getSsmParameter` threw, and the sole evidence was this warn line.
      //
      // Counted under a `(catalog)` pseudo-key so it is impossible to mistake for one source failing,
      // and classified, so a missing grant on the parameter reads as `denied` like any other refusal.
      console.warn('[AssistantAsyncProcessor] context source resolution failed (non-fatal):', err);
      if (activeProfile.contextSources?.length) {
        emitContextSourceOutcome({
          classification: CLASSIFICATION,
          sourceKey: '(catalog)',
          outcome: err instanceof ContextSourceAccessError ? err.reason : classifyAccessError(err),
        });
      }
    }

    // ── WHAT THIS TURN'S RESOLVER HOLDS (ADR-060 decision 4, slice 1d) ────────────────────────────────
    //
    // The values the turn already read for its own use, by source: the classification, the conversation's type and
    // language signal the router forwarded with the host grounding, the sender's clearance as the set its holder
    // token grants, reply preferences and display name (a person's turn only), and the `ctx:` values of the sources
    // resolved above. Nothing is read here. The lookup is the catalog the turn read, else the catalog's
    // least-permitting reading (`withUnreadCatalog`). One holder for the turn's templates, its task's conditions and
    // its step actions' arguments, under no grant the turn did not already use.
    const personTurn = !event.eventStep && !event.welcomePrompt && !event.voiceSend && turnSite.identitySettled;
    const turnSourceTable = buildSourceTable({ catalog: turnCatalog ?? [], classifications: defaultProfileRegistry.classificationValues() });
    const turnVariables: TurnVariables = {
      lookup: turnCatalog ? sourceLookup(turnSourceTable) : withUnreadCatalog(sourceLookup(turnSourceTable)),
      values: turnValues({
        classification: CLASSIFICATION,
        conversationType: typeof event.conversationType === 'string' ? event.conversationType : undefined,
        userLanguage: event.userLanguage,
        ...(personTurn ? {
          clearance: clearanceSet(event.userClearance, (t) => defaultProfileRegistry.grantsFor(t)),
          preferences: { ...(event.replyPreferences ?? {}), ...(event.preferredLanguage ? { [PREFERRED_LANGUAGE_KEY]: event.preferredLanguage } : {}) },
          displayName: event.senderDisplayName,
        } : {}),
        catalog: turnCatalogValues,
      }),
      callSite: turnSite,
    };
    // THE TURN'S LINES RESOLVE THROUGH IT: every template line and notice this turn says reads a field bound to a source
    // or to one of the version's variables from these values (`resolverValues`, `message-lines.ts`).
    const versionTemplates = templatesOf(versionCopy);
    if (versionTemplates) {
      versionCopy = withMessageTemplates<AssistantCopy>({
        ...versionTemplates,
        resolver: {
          lookup: turnCatalog ? versionLookup(turnSourceTable, activeProfile.variables) : withUnreadCatalog(versionLookup(turnSourceTable, activeProfile.variables)),
          ...(activeProfile.variables ? { variables: activeProfile.variables } : {}),
          values: turnVariables.values,
          callSite: turnSite,
        },
      });
      turnCopy = versionCopy;
    }

    // Load task context if task-based: fold the standing per-state guidance + the task's own context
    // into the prompt, and stamp activeTaskInfo (with taskId) so the reply archives with task_id.
    // ── ONE QUESTION ABOUT TASKS, NOT THREE (DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING) ────────────
    //
    // The task this turn continues, what is open in this conversation, and what the speaker owes
    // elsewhere used to be three sequential reads before the model call. Behind the service they are
    // one invoke whose parts run concurrently, which is what keeps the boundary affordable inside
    // time-to-first-feedback: three invokes would not have been.
    //
    // The service is also where the CLASSIFICATION refusal happens. Reading the table directly, as
    // the fallback below still does, is scoped by nothing but the `channelArn` this turn supplies.
    //
    // FALLS BACK ONLY WHEN THE SERVICE IS NOT WIRED, never when it fails or refuses. Dropping task
    // context on a deployment that has not enabled this would be a regression for a change nobody
    // turned on; reading around a REFUSAL would make the boundary a suggestion.
    const viaService = hasTaskService();
    const turnTasks = viaService
      ? await taskServiceTasksForTurn({
        channelArn: event.channelArn,
        ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(event.senderArn ? { senderArn: event.senderArn } : {}),
      })
      : null;

    // ── THE DOCUMENT TEMPLATES THIS TASK'S WORKFLOW DECLARES, LOADED BEFORE THE TURN RUNS ──────────
    //
    // From this classification's own `templates/` prefix, at the version each pointer makes active (or
    // the pinned one), cached per container with its content hash (SPEC-DOCUMENT-TEMPLATES FR2, FR5).
    // Loaded once here so the step's prompt, the guidance returned with an advance, the platform fill
    // and the delivery check all read the same version. Nothing is read for a workflow that declares no
    // template.
    const turnTemplateRefs = templateRefsOfMachine(event.taskType ? turnMachines[event.taskType] : undefined);
    const turnTemplates: TurnTemplates | undefined = turnTemplateRefs.length
      ? await loadTurnTemplates(turnTemplateRefs, CLASSIFICATION, { s3: s3Client, ssm: ssmClient, ssmRoot: SSM_ROOT })
      : undefined;

    let activeTaskInfo: { type: string; status: string; label: string; taskId: string } | undefined;
    // THE STEP THE TASK IS IN WHEN THIS TURN STARTS (ADR-064 decision B): it chooses the model where the version's route
    // overrides it or it delivers, and the turn's record names it (`task_step`), whichever rule chose the model.
    let turnTaskStep: string | undefined;
    // THE INTENT THE REQUEST THAT OPENED THE TASK WAS CLASSIFIED AS (ADR-064 decision B), read off the same row: a
    // platform machine's steps route, and its turns are attributed, under it.
    let turnTaskOpeningIntent: string | undefined;
    // The step's own section of the prompt, kept so it can be rendered again once the turn's model is chosen and the
    // step prompt can say which model writes the document of a delivering step it moves into (ADR-064 decision B).
    let taskStepPrompt = '';
    let renderTaskStep: ((documentWrittenOnStep?: (state: string) => boolean) => string) | undefined;
    if (event.taskId && event.taskType) {
      const task = turnTasks ? turnTasks.current : await getTask(event.taskId, event.channelArn);
      if (task) {
        turnTaskStep = task.taskState || undefined;
        turnTaskOpeningIntent = task.openingIntent || undefined;
        const stepTaskType = event.taskType;
        renderTaskStep = (documentWrittenOnStep) => buildTaskSystemPrompt(stepTaskType, task.taskState || '', turnMachines, {
          ...(turnTemplates ? { templates: turnTemplates } : {}),
          details: task.details as Record<string, unknown> | undefined,
        }, documentWrittenOnStep);
        taskStepPrompt = renderTaskStep();
        systemPrompt += taskStepPrompt;
        // THIS PROFILE'S machines, the same ones the `advance_task_state` tool is authorized against
        // below. A profile that declares its own step - and therefore its own `requires` - must have
        // the step's needs grounded from that declaration, or the prompt would chase the deployment
        // pack's checklist while the tool enforced the profile's graph. Undefined ⇒ the pack, which is
        // byte-identical for every profile that does not override machines.
        systemPrompt += buildTaskContextForPrompt(task, turnMachines);
        activeTaskInfo = {
          type: event.taskType,
          status: task.taskState || task.status,
          label: getTaskLabel(event.taskType, task.taskState || ''),
          // taskId is what the archival reads onto the exchange (task_id).
          taskId: event.taskId,
        };
      }
    }

    // TASK AWARENESS, on two axes that answer different questions (ADR-024 D4/D6). By CONVERSATION:
    // what is open HERE, whoever owns it, because visibility is scoped by membership and never by
    // ownership. By OWNER, across conversations: the speaker's own work elsewhere, deliberately terse
    // because that one crosses the conversation boundary and this one does not.
    //
    // Both are best-effort — the hints augment judgment, and a failure must not cost the turn.
    //
    // HOISTED, because a triage turn below has to know whether that list reached the prompt. It is
    // the list the arrivals are ranked AGAINST, and telling the model to rank against a list a failed
    // read never appended would be asking it to invent one.
    let hasOpenWork = false;
    // AND THE LIST ITSELF, for the ORDER the proposal shows. Read once here and handed down, rather
    // than read again in the core: the tasks table has one holder and this turn's composite has
    // already paid for it.
    let openWorkHere: ConversationTask[] = [];
    // Every open row here INCLUDING this turn's own task, for the open-work summary tool.
    let conversationTasksAll: ConversationTask[] = [];
    try {
      // WHO IS ASKING, so the speaker's own private work reaches this hint (ADR-033). Omitting it is
      // safe by construction - the read returns conversation-visible tasks only - but safe here means
      // the person cannot be reminded of a task they opened by a targeted request, which is the one
      // audience it was kept private FOR. The filter admits the requester and the owning assistant
      // and nobody else, so passing the speaker widens disclosure to exactly them.
      const viewerId = event.senderArn ? personIdFromArn(event.senderArn) || '' : '';
      const conversationTasks = turnTasks
        ? turnTasks.here
        : await getOpenTasksForConversation(event.channelArn, { ...(viewerId ? { viewerId } : {}) });
      const hereHint = buildConversationTasksHint(
        conversationTasks,
        viewerId ? { id: viewerId } : null,
        { excludeTaskId: event.taskId },
      );
      if (hereHint) systemPrompt += hereHint;
      // The hint is empty exactly when there is nothing open here other than this turn's own task,
      // so it answers the question directly rather than re-deriving it from the rows.
      hasOpenWork = !!hereHint;
      // The same rows the hint was built from, minus this turn's own task, so the order the person is
      // shown and the order the model was told to rank against are the same list.
      openWorkHere = conversationTasks.filter((t) => t.taskId !== event.taskId);
      conversationTasksAll = conversationTasks;
    } catch (err) {
      console.warn('[AssistantAsyncProcessor] conversation task hint failed (non-fatal):', err);
    }

    // ── WHICH OF THEIR OPEN ITEMS THIS MESSAGE IS ABOUT (maintainer, 2026-09-04; ADR-024 D7) ────
    //
    // The router ranked and assumed one. The ranking sees the work - which is in flight, which is
    // parked, which is newest - and the question is which work the MESSAGE is about, which only
    // this turn can answer because only this turn has the message.
    //
    // The hint appears ONLY when the router found a real choice, so an ordinary turn is unchanged
    // and the model is never invited to redirect where there is nowhere to redirect to.
    //
    // NON-FATAL like every hint here: without it the model still answers, on the assumption. The
    // assumption is right most of the time, which is exactly why it needed to stop being silent.
    try {
      // RENDERED FROM WHAT THE ROUTER SENT, not from a fresh read. The router already held these
      // rows when it ranked them, and a second read here would be a round trip for an answer
      // already in hand - and one that could disagree with the allowlist the tool enumerates.
      const referentHint = buildReferentHint(event.referentCandidates ?? [], {
        ...(event.taskId ? { provisionalTaskId: event.taskId } : {}),
        machines: turnMachines,
      });
      if (referentHint) systemPrompt += referentHint;
    } catch (err) {
      console.warn('[AssistantAsyncProcessor] referent hint failed (non-fatal):', err);
    }

    // ── ANSWERING A CLARIFICATION HAS TO MOVE IT FORWARD (maintainer, 2026-09-03) ────────────────────
    //
    // A clarification stores the message's ID and none of its words, which is what keeps a targeted
    // request out of a row the room can read. Kept only that far, the rule is half a rule: the row is
    // safe and the assistant is helpless. The person answers "I meant the Q3 one" against a task that
    // deliberately says nothing about what was asked, so the answer has nothing to attach to.
    //
    // So the question is recovered HERE, at the one moment it is needed, and by the one person
    // entitled to it: the clarification awaits its own requester, so the only turn that reaches this
    // is that person answering their own message. It recovers, for them, the words they wrote.
    //
    // NON-FATAL, like every hint on this path. Without it the assistant has the answer and not the
    // question, which is worse than having both and much better than losing the turn.
    try {
      // THE READ THIS TURN ALREADY PAID FOR. `turnTasks.current` is the same row, fetched once for
      // the whole turn; asking again would be a second round trip for an answer already in hand.
      const clarifying = event.taskType === QUEUED_CLARIFICATION_TASK_TYPE
        ? (turnTasks ? turnTasks.current : await getTask(event.taskId || '', event.channelArn).catch(() => null))
        : null;
      const askedAbout = clarifying?.userMessageId
        ? await recallClarifiedMessage({
          channelArn: event.channelArn,
          messageId: clarifying.userMessageId,
          botArn: event.botArn,
        })
        : '';
      if (askedAbout) {
        systemPrompt += `\n\nTHE MESSAGE YOU COULD NOT MAKE OUT, which this person is now explaining:\n`
          + `"${askedAbout}"\n`
          + 'Read their reply as telling you what it asked for. Do that work, or say what is still '
          + 'missing - and move the clarification on with advance_task_state either way, so it stops '
          + 'sitting in their list.';
      }
    } catch (err) {
      console.warn('[AssistantAsyncProcessor] could not recall the clarified message (non-fatal):', err);
    }

    try {
      const personId = personIdFromArn(event.senderArn) || '';
      if (personId) {
        // NO FALLBACK TO THE STORE. This read `getActiveTasksForUser` directly when the composite
        // was absent, which is the one path that skips the classification gate in `tasksForTurn`
        // entirely - so the hint was built from rows no check had seen. An absent composite means
        // the guarded read did not happen, and the honest response to that is no hint rather than
        // an ungated one: the hint is an aid, and a turn without it answers exactly as well.
        const crossChannelTasks = turnTasks ? turnTasks.elsewhere : [];
        const hint = buildCrossChannelTasksHint(event.channelArn, crossChannelTasks);
        if (hint) systemPrompt += hint;
      }
    } catch (err) {
      console.warn('[AssistantAsyncProcessor] cross-channel task hint failed (non-fatal):', err);
    }

    // RAG + the running summary, started at the top of this handler and awaited here, at the first
    // point either is read. `resolveTurnGrounding` applied the classification-scope filter (ADR-007).
    const grounding = await groundingPromise;
    if (grounding.retrievedContext) {
      const ragHint = buildRetrievedContextHint(grounding.retrievedContext);
      if (ragHint) systemPrompt += ragHint;
    }

    // Conversation summary as consumable context (ADR-017); no-op when short.
    systemPrompt += buildConversationSummaryHint(grounding.conversationSummary);

    if (priorAgentContext) {
      systemPrompt += `\n\n[You already said the following — do NOT repeat it. Use completely different wording.]\n${priorAgentContext.trim()}`;
    }

    // ── A TRIAGE TURN IS A CLASSIFICATION STEP, AND THE SYSTEM PROMPT HAS TO SAY SO ────────────
    //
    // Appended LAST, and appended at all, because the user message could not carry it. A triage
    // turn is dispatched as an ordinary turn request, so everything above - the persona, the host
    // context, the conversation itself - shapes it toward an ordinary answer. Measured against the
    // deployment, the model produced prose every single time: no machine lines, no marker, not even
    // the escape hatch. The judged reading never once succeeded, so every drain used the derived
    // floor and the assistant's actual judgement was never applied to a queue.
    //
    // It governs SHAPE, not manner. The persona stays, because the spoken half of the proposal is
    // meant to be this assistant's voice in this conversation's language.
    if (event.triage?.ids.length) {
      systemPrompt += triageContractDirective(
        event.triage.ids,
        mayTakeAnotherPass(event.triage),
        // So one queued message arriving during a long turn is still asked about: the subject it
        // raises is separable from the work already running, even though the queue holds one thing.
        !!event.triage.inFlight,
        // NEW WORK IS NOT NEXT WORK (maintainer, 2026-09-01): the arrivals are ranked against the open
        // work listed above, not against each other alone.
        hasOpenWork,
        // The reading tool is offered on this turn, so the directive must ask for a CALL rather than
        // lines - two contracts for one answer means the prompt wins and the tool is never used.
        !!event.triage.ids.length,
      );
    }
    // AN UNANSWERED STOP IS NOT READ HERE. The router reads the person's answer against the stop
    // question before it routes anything (ADR-033, "the question owns its follow-up"), so by the time
    // a turn reaches this processor the question has been settled or the message was about something
    // else.
    let pendingSplit: PendingSplitOffer | undefined;

    // ── AN OFFER TO SPLIT THIS CONVERSATION, STILL UNANSWERED (DESIGN 2.4.2) ────────────────
    //
    // The subjects were put to this person on an earlier turn, and the answer arrives in ordinary
    // words on this one. NOT on a triage turn: that turn is a classification step which must not
    // reply to anybody, so putting a second contract on it would ask it to answer while telling it
    // not to.
    //
    // The offer is read AS THE SPEAKER, so one put to somebody else is not visible here at all.
    // NOR ON A FOLD, which re-runs a turn with its follow-ups rolled in. The offer was made by the reading
    // about those same follow-ups a moment ago; the fold is not the person answering it (live 2026-09-14:
    // "the reply answered no offer; it stays open" on a fold turn).
    if (!event.triage?.ids.length && !event.amendedFold && event.senderArn) {
      pendingSplit = await readPendingSplit({
        channelArn: event.channelArn,
        responderId: principalIdFromArn(event.botArn),
        speakerId: personIdFromArn(event.senderArn) || '',
      }).catch(() => undefined);
      if (pendingSplit) {
        systemPrompt += splitOfferDirective(pendingSplit.topics);
        // Said only when an offer STANDS, so the ordinary turn stays quiet. Without it, an offer
        // read for the wrong speaker and an offer the reply never answered are the same silence.
        console.log('[AsyncProcessor][split] an unanswered offer is on this turn', {
          correlationId: event.correlationId,
          topics: pendingSplit.topics.length,
        });
      }
    }
    // /battle (DESIGN-SEPARATE-ASSISTANTS §3.7): each side of a duel is a pinned version, and this turn
    // serves it as `event.variantProfile` exactly as it serves any version - persona and addendum, tools,
    // guardrail, image model and name were all applied above with the rest of the version. Nothing about
    // the variant rides `battleContext`. What is battle-specific is only the framing: round 1 gets a light
    // battle-awareness note and round 2 the rival's round-1 reply to respond to, both naming the rival by
    // its profile's name (`battleSideNames`). Only a battle-CAPABLE classification participates, and
    // only when event.battleContext is set (the flow has already checked that battle is turned on).
    const battleOn = BATTLE_CAPABLE && !!event.battleContext;
    // The side's name for its scorecard: its profile's name, the same source as its placeholder's `name=` and
    // the rival's `rivalName`, settled against the other side so the two columns never read the same
    // (`battleSideNames`).
    const battleSelfDisplayName = battleOn ? event.battleContext?.selfName : undefined;
    if (battleOn && event.battleContext) {
      if (event.battleContext.round === 2) {
        systemPrompt += buildRebuttalContext(
          event.battleContext.rivalName || 'the other assistant',
          event.battleContext.rivalReply || '',
        );
      } else {
        systemPrompt += buildBattleAwareness(
          event.battleContext.rivalName || 'the other assistant',
        );
      }
      // systemPrompt may have changed; the stable base is still its leading slice but the length shifted.
      cacheableSystemPrefixLength = Math.min(cacheableSystemPrefixLength, systemPrompt.length);
      console.log('[AssistantAsyncProcessor][battle] Normal-engine battle turn', {
        round: event.battleContext.round,
        self: battleSelfDisplayName,
        rival: event.battleContext.rivalName,
        servedVersion: event.variantProfile ? `${event.variantProfile.profileName}@${event.variantProfile.configId}` : undefined,
      });
    }

    // Resolve model for this intent (respects classification boundaries). When the bot is the challenger
    // in a battle, the variant's modelKey wins.
    const catalog = getModelCatalog(process.env.AWS_REGION || 'us-east-1', process.env.AWS_ACCOUNT_ID || '');
    // P0 (SPEC-PORTABLE-PROFILES): the profile's BASE model comes from the ACTIVE version in
    // SSM, not the deploy-time default — so activating a new profile version re-models the assistant
    // with NO redeploy. Fail-closed to the compiled seed (== today's deploy default), so a deployment
    // that never versions behaves byte-identically. A version whose modelKey is not in this catalog is
    // ignored here (the deploy-time default holds) — the §7 model-ARN boundary is deploy-owned; a
    // version selects WITHIN it, never beyond. Battle/experiment models still win over this base below.
    //
    // ONE RESOLUTION PER TURN, and it is the one resolved above. This used to call
    // `resolveActiveProfile` a SECOND time, which ignored `event.variantProfile` and therefore served
    // the profile's ACTIVE version here while the persona came from the variant. Everything downstream
    // of this line reads it - tools, guardrail selection, per-intent routing, the base model and the
    // attribution `configId` - so a `profileRef` experiment whose two versions differed in any of those
    // ran BOTH ARMS IDENTICALLY and reported "indistinguishable". A false negative reads exactly like a
    // real result, which is why this is one binding rather than two lookups that agree by luck.
    // `resolveFromDefinition` returns the same `ResolvedActiveProfile` shape, so there is nothing to
    // reconcile: SPEC-PORTABLE §6 says the variant's version IS the definition for the turn.
    const active = activeProfile;
    const activeModelKey = active.profile.modelKey;
    // THE CLASSIFICATION'S SELECTION, with the version's base model as its default where the classification
    // selects it: a version uses only what its classification selected, and chooses within it.
    const classificationModels = defaultProfileRegistry.modelsOf(CONFIG.userType);
    const baseModelSelection = classificationModels && (catalog as Record<string, unknown>)[activeModelKey]
      && classificationModels.selected.includes(activeModelKey)
      ? { ...classificationModels, default: activeModelKey }
      : classificationModels;
    // U2 (SPEC-ASSISTANT-CONFIG §4): per-intent model routing comes from THIS profile version's
    // `models.byIntent`, not the global strategy table. The seed copies the global strategy per-profile,
    // so this is byte-identical until an operator edits a version; fail-closed to the global strategy
    // when a version carries no per-intent routing.
    // A version with no routes is served the platform routes AS SERVED on its base model
    // (`platformRoutesServedOn`), never the global table raw: routes are served as written.
    const profileStrategy = buildIntentStrategy(active.models)
      ?? buildIntentStrategy({ byIntent: platformRoutesServedOn(activeModelKey) })
      ?? INTENT_ROUTE_STRATEGY;
    // WHAT THE TURN IS DOING, not only what the message looked like. The trivial-intent bypass in
    // model-resolver keeps the cheap model for a greeting or an acknowledgment; a turn that carries a
    // task is doing that task's work whatever the message's shape, and resolving it from the shape
    // alone put a full board report on Haiku because the message before it was "Looks good" (live).
    //
    // Both signals are already on THIS event - no extra read, and no change to the router:
    //  - `isTaskContinuation`: the router's own statement that this turn continues an open chain. It
    //    is resolved from an owner-scoped active-task lookup, which depends on a state declaring
    //    `awaits`, so it can be false while work really is in flight.
    //  - `taskId`: the structural fact that this turn is bound to a task at all, which holds whether
    //    the task was opened this turn or resumed, and does not depend on any state's declaration.
    const continuesActiveWork = !!event.isTaskContinuation || !!event.taskId;
    // Context-aware model routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING), flag-gated + battle-exclusive.
    // When ENABLE_CONTEXT_ROUTING is off (or this is a /battle turn), `plan` is null and the Bedrock
    // path below is unchanged. PREFERRED CN path is DeepSeek-on-Bedrock (in-AWS, intent-routed R1/V3,
    // no external-provider gate); the external provider is used only when no Bedrock CN model is
    // configured AND the classification selects the external adapter (`externalProviderSelected`); a profile
    // version enables nothing.
    const contextRoutingOn = !battleOn && process.env.ENABLE_CONTEXT_ROUTING === 'true';
    const cnBedrock =
      contextRoutingOn && process.env.CN_BEDROCK_CHAT_MODEL
        ? {
            chatModelId: process.env.CN_BEDROCK_CHAT_MODEL,
            reasoningModelId: process.env.CN_BEDROCK_REASONING_MODEL || process.env.CN_BEDROCK_CHAT_MODEL,
            reasoningIntents: (process.env.CN_BEDROCK_REASONING_INTENTS || '')
              .split(',').map((s) => s.trim()).filter(Boolean),
          }
        : null;
    const cnCfg =
      contextRoutingOn && !cnBedrock
        ? externalProviderFromEnv('deepseek') || externalProviderFromEnv('qwen')
        : null;
    // The classification's selection decides, with no read.
    const externalGate = cnCfg ? externalProviderSelected(CONFIG.userType, cnCfg.provider) : null;
    // THE VERSION'S ROUTING RULES (ADR-060 decision 6): a condition over this turn's deciding values, read as the room
    // reads the reply, selecting among the models the classification selects. Never on a duel turn, which serves the
    // model its side was given.
    const versionRules = !battleOn ? activeProfile.models?.routing ?? [] : [];
    const ruleHolds = (when: import('./lib/variables.js').When) => whenHolds(when, {
      lookup: turnVariables.lookup, values: turnVariables.values, site: { callSite: turnVariables.callSite, audience: 'room' },
    });
    // ONE RESOLUTION PER TURN (SPEC-CONTEXT-AWARE-MODEL-ROUTING FR1): an experiment override, the version's routing
    // rules, the context rules, then the route's choice for this turn (ADR-064 decision B): the step's override where the
    // version's route sets one for the step the task starts in, the task intent's route where that step delivers, and
    // otherwise the message's own intent. `plan.routed` is the route's choice, what an override falls back to.
    const experimentModelId = experimentModelOverride(event);
    const turnTaskIntent = event.taskId ? taskIntentOf(event.taskType, knownIntentKeys(turnPack), turnTaskOpeningIntent, event.intent) : undefined;
    const turnStepDef = event.taskType && turnTaskStep ? turnMachines[event.taskType]?.states?.[turnTaskStep] : undefined;
    const plan = resolveModelPlan(
      {
        classification: CONFIG.userType,
        intent: event.intent || event.resolvedModel,
        experimentModelId,
        userLanguage: event.userLanguage,
        continuesActiveWork,
        // Geography routing (rule 2): the dominant geo segment forwarded from the host. A CN
        // segment routes to the CN model even when the user's global language isn't zh.
        segment: event.segment,
        ...(event.taskId && event.taskType
          ? { task: { intent: turnTaskIntent, step: turnTaskStep, produces: stepOutputOf(turnStepDef) } }
          : {}),
      },
      {
        catalog,
        strategy: profileStrategy,
        models: baseModelSelection,
        enabled: true,
        cnBedrock,
        cnProvider: cnCfg ? { provider: cnCfg.provider, modelId: cnCfg.model } : null,
        // THE CLASSIFICATION'S SELECTION of the provider's catalog model (`externalProviderSelected`).
        externalProviderSelected: externalGate?.allowed === true,
        rules: versionRules,
        holds: ruleHolds,
        routes: active.models?.byIntent,
      },
    );
    const resolution = plan.routed;
    // THE STEP A TASK ENTERS MID-TURN picks the rest of the loop's model where it overrides or delivers (ADR-064 decision
    // B), unless an experiment, a routing rule or a context rule chose this turn's model, which holds for the whole turn.
    const routeChoseTheModel = plan.modelFrom === 'step' || plan.modelFrom === 'route' || plan.modelFrom === 'general' || plan.modelFrom === 'base';
    const stepModel = event.taskId && routeChoseTheModel && !battleOn
      ? (taskType: string | undefined, state: string | undefined): StepModelChoice | undefined => {
        if (!taskType || !state) return undefined;
        const produces = stepOutputOf(turnMachines[taskType]?.states?.[state]);
        const chosen = routedModel({
          classification: CONFIG.userType, intent: event.intent, continuesActiveWork,
          task: { intent: taskIntentOf(taskType, knownIntentKeys(turnPack), taskType === event.taskType ? turnTaskOpeningIntent : undefined, event.intent), step: state, produces },
        }, { catalog, strategy: profileStrategy, models: baseModelSelection, routes: active.models?.byIntent });
        return enteredStepModel(chosen, produces);
      }
      : undefined;
    // WHAT CHOSE THIS TURN'S MODEL AND WHICH WORK IT IS ATTRIBUTED TO, on the turn's record (ADR-064 decision 4). The work
    // is the task's intent (decision I): its type where that is an intent, else the intent of the request that opened it,
    // so Effectiveness counts a platform machine's turn (`queued_request`, `queue_drain`) under the work it carries. The
    // machine itself rides beside it (`taskMachine`) where the two differ.
    const modelChoice: {
      taskType?: string; taskMachine?: string; turnStep?: string; modelKind: 'text' | 'image'; modelFrom: string;
      imageEgress?: { provider: string; model: string; contextSourced: boolean };
    } = {
      ...(event.taskId && event.taskType ? { taskType: turnTaskIntent || event.taskType } : {}),
      ...(event.taskId && event.taskType && turnTaskIntent && turnTaskIntent !== event.taskType ? { taskMachine: event.taskType } : {}),
      ...(turnTaskStep ? { turnStep: turnTaskStep } : {}),
      modelKind: 'text' as const,
      modelFrom: plan.modelFrom,
    };
    // A TURN THAT SERVES A VERSION ANSWERS THROUGH THAT VERSION'S ROUTES (DESIGN-EXPERIMENTS-BATTLE-
    // DECISION-LOOP §3.5): an enrolled experiment arm and a duel side alike resolve their model from the
    // version's `models.byIntent` and base model (`resolution` above, built from `active`), exactly as the
    // live assistant resolves its own. No experiment model is forced over a version: a `resolvedModel` on
    // such an event (a router that predates this) is ignored, so a routed intent answers through its route.
    const effectiveModel = experimentModelId || resolution.primaryModelId;
    // The model a duel side's turn serves, through its version's routes: what the vision plans below judge.
    const servedVariantModelKey = battleOn && event.variantProfile ? resolution.primaryModelKey : undefined;
    // SPEC-ASSISTANT-CONFIG §4 — per-profile tool allowlist: the active version's `tools` gate which tools
    // the Converse loop may offer (undefined ⇒ all available, byte-identical to before). Flows into
    // bedrockInvokeConfig below (which spreads invokeConfig).
    // A /battle round-2 rebuttal carries no new user input (the prompt was guarded on round 1), so skip the
    // INPUT guardrail on it - otherwise a rebuttal whose prompt round-1 already allowed gets blocked. Output
    // guardrail still runs.
    const invokeConfig = {
      ...CONFIG,
      model: effectiveModel,
      // THE INTENT NARROWS THE PROFILE'S ALLOWLIST, and can never widen it (tenet D4: a selection picks
      // within a boundary rather than moving it). `toolsForIntent` intersects, so an intent naming a
      // tool the profile forbids loses it here even though the write path already refused that version.
      // An intent declaring no tools of its own returns `active.tools` unchanged, which is every intent
      // today.
      tools: toolsForIntent(event.intent || '', active.tools, turnPack),
      // THE INTENT'S ANSWERING TEMPERATURE, when it declares one (FR19): an intent that must answer
      // the same way every time runs low and fixed. Absent keeps the deployment default.
      ...(turnIntentDef?.answer?.temperature !== undefined ? { temperature: turnIntentDef.answer.temperature } : {}),
      // The guardrail this assistant SELECTS (SPEC-CONFIGURABLE-ASSISTANTS 4.6); undefined ⇒ deployment default.
      guardrailId: active.guardrailId,
      skipInputGuardrail: battleOn && event.battleContext?.round === 2,
      // ADR-027 phase 1: the input guardrail scores what this turn's human submitted, not whatever
      // sits last in the user role. In a channel with a second assistant those differ, and the peer's
      // message wins that position.
      // WHAT A PERSON ACTUALLY WROTE, which on a triage turn is NOT the turn's user message.
      //
      // This is what the input guardrail scores. A triage turn's user message is the assembled
      // contract - instructions telling the model what to decide, wrapped around the quoted queued
      // messages - and that is the shape of a prompt-injection attempt, so the prompt-attack filter
      // fired on our own scaffolding and blocked every triage turn before the model was called.
      //
      // The queued messages are the human input of that turn, so naming them here is not a guardrail
      // exemption dressed up: it is telling the guardrail which part a person submitted. Everything
      // a person wrote is still screened; the platform's own instructions are not.
      userTurnText: event.triage?.userContent ?? event.stopEvaluation?.userContent
        ?? event.userContent ?? event.userMessage,
    };

    // ── A PROMPT WELCOME'S ONE TURN (SPEC-WELCOME-AND-CONTEXT FR24, ADR-061 decision 9) ─────────────────
    //
    // The structured opening is already in the room. This turn runs the version's prompt template as the joining
    // assistant, on its own session, with its persona and context (the system prompt above, which carries the
    // conversation's context sections, and the company document digest the company context tool adds) and only the
    // read tools the welcome names. It posts a new message once, on success, and nothing otherwise: no placeholder
    // exists for it to update, so a failure leaves the opening as the welcome (`runWelcomePromptTurn`).
    // ── AN EVENT WORKFLOW'S AGENT STEP (ADR-061 decision 8) ───────────────────────────────────────────
    //
    // One turn of this assistant, from the step's prompt template, with only the step's read tools, ending in one
    // message: its output or the step's fallback, whichever wins the step's claim. No placeholder: nobody asked.
    if (event.eventStep) {
      const req = event.eventStep;
      // The served version's own workflow of that name first, then the platform's (ADR-061 decision 1).
      const wf = workflowFor(stepWorkflows, req.workflow);
      const def = wf?.states[req.step]?.agent;
      if (!wf || !def || wf.on !== req.event) {
        console.warn('[event-step] the dispatch names no agent step of the served version or the platform; nothing runs', { workflow: req.workflow, step: req.step });
        return;
      }
      // THE RUN GOES BACK TO THE ROUTER of the assistant whose version declares it, naming the step's outcome.
      const handBack = async (outcome: string) => continueEventRunThroughRouter((await resolveRouterArn(CLASSIFICATION)) ?? '', {
        runKey: req.runKey, workflow: req.workflow, step: req.step, outcome, event: req.event,
        channelArn: event.channelArn, botArn: (stepOwner && req.ownerBotArn) || event.botArn, values: req.values ?? {},
        ...(req.eventPerson ? { eventPerson: req.eventPerson } : {}), ...(req.subject ? { subject: req.subject } : {}),
        ...(req.invitationId ? { invitationId: req.invitationId } : {}),
        ...(req.alarm ? { alarm: req.alarm } : {}),
        transitions: req.transitions ?? [],
      });
      // EACH ASSISTANT ACTS ONLY AS ITSELF (tenet D1): a step another assistant's version declares is taken here only when
      // it names this assistant's role, and a step naming a role is taken only by an assistant holding it. A refused step
      // runs no turn and calls nothing; it is claimed `refused` and handed back, so the router says its fallback and the
      // run takes its failure edge, and the room is never left waiting on a step nobody took.
      if (!stepTakenBy(def, { owner: stepOwner, role: turnAssistantRole })) {
        console.warn('[event-step][SecurityEvent] the step is not this assistant\'s to take; nothing runs', { workflow: req.workflow, step: req.step, role: def.as?.role });
        if (await claimEventStep({ runKey: req.runKey, channelArn: event.channelArn, step: req.step, outcome: 'refused' }).catch(() => false)) await handBack('refused');
        return;
      }
      const roster = machineTurnRoster(event.channelArn, event.botArn);
      // THE ROLES THE ROUTER READ FROM THE CONTEXT ROW, KEPT TO WHO IS A MEMBER NOW (DESIGN-CONVERSATION-TYPES section 6.1):
      // the same rule the router's runs apply, so a holder who left since the dispatch is addressed and named by nothing.
      const people = new Set((await roster).filter((m) => !m.isBot).map((m) => m.arn));
      const roles = req.roles
        ? Object.fromEntries(Object.entries(req.roles).map(([r, arns]) => [r, (Array.isArray(arns) ? arns : []).filter((a) => people.has(a))]))
        : undefined;
      const ctx: import('./lib/event-workflow.js').EventRunContext = {
        event: req.event, channelArn: event.channelArn, eventPerson: req.eventPerson, subject: req.subject, inviter: req.inviter, values: req.values ?? {},
        ...(roles ? { roles } : {}), ...(req.conversationType ? { conversationType: req.conversationType } : {}),
      };
      const targetsOf = (to: import('./lib/event-workflow.js').EventAudience) => { const a = audienceOf(to, ctx); return a === 'room' ? [] : a; };
      const post = async (content: string, to: string[], outcome: string, proposal?: ProposalCard) => {
        // ONE RESPONSE, IN AS MANY PARTS AS IT NEEDS: a model chose its length, and every part reaches the same audience.
        // A refused part throws, so the step records `post_failed` for the response (`runAgentStep`).
        await sendInParts(messagingClient, {
          ChannelArn: event.channelArn,
          text: content,
          ChimeBearer: event.botArn,
          Metadata: JSON.stringify({
            botResponse: true,
            respPhase: 'final',
            agentType: turnProfileName,
            turnKind: 'event_step',
            eventStep: { workflow: req.workflow, step: req.step, event: req.event, outcome },
            // Timed from the event that started the run, so the latency grid measures it (`declared_trigger`).
            trigger: 'event_step',
            ...(typeof event.triggerAtMs === 'number' ? { triggerAtMs: event.triggerAtMs } : {}),
            // No message entered this turn; the platform started it (`turnEntryOf`).
            entry: turnEntryOf(event.entry, 'event_step'),
            // THE RUN'S MOVES REACH THE ARCHIVE ON ITS MESSAGES (ADR-061 rule 11).
            eventRun: { runKey: req.runKey, transitions: [...(req.transitions ?? []), { step: req.step, outcome }] },
            ...(to.length ? { targetedSender: to[0] } : {}),
            // A CONFIRMATION CARD (ADR-061 decision 8, rule 8): the proposal's handle, which only its addressee receives.
            ...(proposal ? { proposal } : {}),
          }),
          ...(to.length ? { Target: to.map((MemberArn) => ({ MemberArn })) } : {}),
        });
      };
      // A STEP THAT PROPOSES (decision 8, rules 6 to 8): its turn drafts the proposal, and whatever it writes executes
      // nothing. Where the draft reaches a person not reading the room (`send_nudge`), the turn is NARROWED: the persona
      // alone as its system prompt, its prompt and the event's declared values as data, no conversation and no tools.
      const op = proposalOf(def);
      const narrowed = agentStepIsNarrowed(def);
      const promptValues = { ...ctx.values, ...(req.promptValues ?? {}) };
      const addressee = op ? targetsOf(def.to)[0] : undefined;
      const addressedAs: ProposalAddressee | undefined = def.to === 'joined' || def.to === 'subject' ? def.to
        : typeof def.to === 'object' && 'people' in def.to ? def.to.people
          : typeof def.to === 'object' && 'participantRole' in def.to ? `participantRole:${def.to.participantRole}` : undefined;
      const offerProposal = async (draftText: string) => {
        const tokens = process.env.TOKENS_TABLE || '';
        if (!op || !addressee || !addressedAs || !tokens) throw new Error('the proposal has no addressee or no store');
        const draft = proposalDraft(draftText, op);
        const nowSec = Math.floor(Date.now() / 1000);
        const made = proposalRecordOf({
          channelArn: event.channelArn, addresseeArn: addressee, now: nowSec,
          ...(typeof req.proposalNotAfter === 'number' ? { notAfter: req.proposalNotAfter } : {}),
          fields: {
            op, classification: CLASSIFICATION, addressedAs, workflow: req.workflow, step: req.step, runKey: req.runKey, draft,
            ...(op === 'send_nudge' && req.invitationId ? { invitationId: req.invitationId } : {}),
            ...(op === 'open_conversation' && def.opens ? { conversationType: def.opens } : {}),
          },
        });
        await writeProposal(proposalsDoc(), tokens, made.record);
        // THE CARD'S WORDS ARE A TEMPLATE the assistant can replace (ADR-062): the draft and the names as data.
        const cardName = op === 'send_nudge' ? 'invitation-nudge-proposal' : 'open-conversation-proposal';
        const card = await loadNamedTemplate({ classification: CLASSIFICATION, assistant: turnProfileName, name: cardName }, 'message');
        const said = card ? localizedTemplate(card, { copy: versionCopy }, 'addressed') : undefined;
        const rendered = said ? renderMessageTemplate(said, { ...(req.promptValues ?? {}), draft }, { refusedValue: 'empty' }) : undefined;
        const content = rendered?.ok ? (rendered.sections.chat ?? '').trim() : '';
        await post(content || draft, [addressee], 'posted', made.card);
      };
      // THE BRIEF THE ADDRESSED PERSON'S ROLE CONFERS (`fromRole: brief`), else the step's own prompt; a brief that cannot
      // be read falls back to the step's own as well.
      const briefName = def.fromRole === 'brief' ? conferredBy(ctx, targetsOf(def.to)[0], 'brief') : undefined;
      const template = (briefName ? await loadNamedTemplate({ classification: CLASSIFICATION, assistant: turnProfileName, name: briefName }, 'prompt') : undefined)
        ?? await loadNamedTemplate({ classification: CLASSIFICATION, assistant: turnProfileName, name: def.prompt }, 'prompt');
      const persona = baseSystemPrompt + personaAddendumBlock(activeProfile.systemPromptAddendum);
      // THE ROOM'S RECENT MESSAGES (`reads: messages`, the join recap): the history this turn's pipeline read, as the
      // room's assistant reads it under its own grants, with every targeted message kept out (`privateReaderOf`). A join
      // recap in a room where no person wrote anything has nothing to catch anyone up on, so no model is called; every
      // other step reads the room as context for its own work (the incident watch's re-read) and runs either way.
      const readsRoom = def.reads === 'messages' && !narrowed;
      const roomHistory = readsRoom ? consolidatedHistory : [];
      // A TASK THE RUNTIME OPENS BEFORE THE TURN (`workflow:`, decision 8): an event task in the room, opened once per step
      // of a run (its id follows from the run), owned by this assistant and visible to the room. The turn runs its first
      // step, whose instructions follow the step's own prompt. Opening it is the runtime's act; the model calls nothing.
      const opened = def.workflow && !narrowed ? await openEventTask({
        machine: def.workflow, channelArn: event.channelArn, runKey: req.runKey, step: req.step,
        botArn: event.botArn, excerpt: typeof ctx.values.label === 'string' ? ctx.values.label : '',
      }) : undefined;
      const withStep = (prompt: string) => (opened?.stepPrompt ? `${prompt}\n\n${opened.stepPrompt}` : prompt);
      const run = await runAgentStep({
        template, values: narrowed ? promptValues : ctx.values, deadlineMs: def.deadlineMs,
        ...(readsRoom && nothingToRecap(wf.states[req.step], pipeline.personSpoke) ? { nothingToRead: true } : {}),
      }, {
        // No person asked: metered against the global budget only, as the join recap is.
        meter: async () => (await evaluateAbuseGate({ personId: '', rateLimit: 0, isAdmin: false, machineWritten: true })).allowed,
        invoke: async (prompt) => (narrowed
          ? invokeBedrockWithFallback(
            persona,
            [{ role: 'user', content: prompt }],
            { ...invokeConfig, tools: [], userTurnText: '' },
            resolution.fallbackModelId,
            { cacheableSystemPrefixLength: persona.length, enableCompanyContextTool: false },
          )
          : invokeBedrockWithFallback(
            systemPrompt,
            consolidateConsecutiveMessages([...roomHistory, { role: 'user', content: withStep(prompt) }]),
            { ...invokeConfig, tools: def.tools ?? [], userTurnText: '' },
            resolution.fallbackModelId,
            { cacheableSystemPrefixLength, enableCompanyContextTool: true },
          )),
        claim: (outcome) => claimEventStep({ runKey: req.runKey, channelArn: event.channelArn, step: req.step, outcome }),
        // A DRAFT THAT REACHES SOMEONE OUTSIDE THE ROOM carries no link, handle or address (rule 6).
        ...(op ? { vet: (text: string) => !proposalDraftRefusal(text) } : {}),
        postOutput: (content) => (op ? offerProposal(content) : post(content, targetsOf(def.to), 'posted')),
        postFallback: async (outcome) => {
          const send = def.fallback.send;
          // THE FALLBACK LEARNS ITS AUDIENCE AND RESOLVES THROUGH THE TURN'S RESOLVER (ADR-060, slice 1d): a stored
          // template its readers may not read is passed over, and a field bound to a source or a version variable is
          // read from what this turn holds. The run's own values stand over it.
          const audience = send.to === 'room' ? 'room' as const : 'addressed' as const;
          const lineResolver = templatesOf(versionCopy)?.resolver;
          const members = await roster;
          const to = targetsOf(send.to);
          // A ROLE'S LIST OF NAMES IN ITS READERS' LANGUAGE (ADR-062 decision 4): the one reader's own, else the room's.
          const languages = lineResolver?.values ?? {};
          const listLanguage = async (readers: readonly string[]) => {
            const tag = readers.length === 1 ? languages['person:preferredLanguage'] ?? languages['signal:userLanguage'] : languages['signal:userLanguage'];
            return typeof tag === 'string' ? tag : undefined;
          };
          // A FALLBACK ADDRESSED TO A PERSON may name the invitation's people from its record (an invitation's events
          // only); a room fallback never does.
          const named = audience === 'addressed' && req.promptValues
            ? Object.fromEntries(['invitee', 'inviter', 'title'].filter((k) => typeof req.promptValues![k] === 'string').map((k) => [k, req.promptValues![k]]))
            : {};
          const values = { ...named, ...(await sendValues(send, ctx, { mentionName: async (arn) => members.find((m) => m.arn === arn && !m.isBot)?.name ?? '', listLanguage }, to)) };
          // EACH PERSON IS SAID THE TEMPLATE THEIR ROLE CONFERS where the fallback says `fromRole: template`.
          for (const group of to.length ? templatesForPeople(send, ctx, to) : [{ template: send.template, to }]) {
            const fallbackTemplate = await loadNamedTemplate({ classification: CLASSIFICATION, assistant: turnProfileName, name: group.template }, 'message', undefined,
              lineResolver ? {
                lookup: lineResolver.lookup, audience, mentions: Object.keys(send.mention ?? {}),
                holds: (when) => whenHolds(when, { ...lineResolver, site: { callSite: lineResolver.callSite, audience } }),
              } : undefined);
            // In the language its readers get (ADR-062 decision 4): written text only, because a fallback waits on no model.
            const said = fallbackTemplate ? localizedTemplate(fallbackTemplate, { copy: versionCopy }, audience) : undefined;
            const resolved = said ? resolverValues(said, { copy: versionCopy }, audience) : {};
            const rendered = said ? renderMessageTemplate(said, { ...resolved, ...values }, { refusedValue: 'empty' }) : undefined;
            const content = rendered?.ok ? (rendered.sections.chat ?? '').trim() : '';
            if (content) await post(content, group.to, outcome);
          }
        },
        log: (entry) => console.log('[event-step]', JSON.stringify({ ...entry, workflow: req.workflow, step: req.step, event: req.event })),
        warn: (entry) => console.warn('[event-step]', JSON.stringify({ ...entry, workflow: req.workflow, step: req.step, event: req.event })),
        emptyReplies: [noticeLine(versionCopy, 'nothingChanged'), noticeLine(versionCopy, 'completedWithoutSummary')],
      });
      await run.settled;
      // THE TASK RESTS ON ITS NEXT STEP once the turn that ran its first step posted: the runtime takes that step's one
      // declared transition, as it closes a delivered step, and never on a fallback.
      if (opened && run.won && run.outcome === 'posted' && opened.next) {
        const advanced = await advanceTaskStateTo({
          task: opened.task, toState: opened.next, by: 'system', reason: 'the event step that opened the task ran its first step',
          machines: { [def.workflow!]: DEFAULT_TASK_STATE_MACHINES[def.workflow!] }, assistantId: principalIdFromArn(event.botArn),
        }).catch(() => ({ ok: false as const }));
        console.log('[event-step] event task', { machine: def.workflow, to: opened.next, ok: advanced.ok });
      }
      // ONLY THE WINNER HANDS THE RUN ON: the invocation whose output or fallback won the step's claim names the
      // continuation back to the router, which claims it once and runs the steps that follow.
      if (run.won) await handBack(run.outcome);
      return;
    }

    // ── A `voice` SEND (ADR-062 decision 4) ─────────────────────────────────────────────────────────────
    //
    // The router chose the reader's language and found no variant written for it, so the template's sections are said
    // in this assistant's voice by one bounded model call: the persona alone as the system prompt (no conversation, no
    // context sections), the written text as data, metered `machineWritten` against the global budget. Any bound that
    // fails posts the platform fill of the first written language instead. One message either way, carrying the outcome.
    if (event.voiceSend) {
      const req = event.voiceSend;
      const audience = req.to.length ? 'addressed' as const : 'room' as const;
      const lineResolver = templatesOf(versionCopy)?.resolver;
      const template = await loadNamedTemplate({ classification: CLASSIFICATION, assistant: turnProfileName, name: req.template }, 'message', undefined,
        lineResolver ? {
          lookup: lineResolver.lookup, audience, mentions: req.mentions ?? [],
          holds: (when) => whenHolds(when, { ...lineResolver, site: { callSite: lineResolver.callSite, audience } }),
        } : undefined);
      if (!template) {
        console.warn('[voice-send] the send names no message template this assistant can say; nothing is posted', { template: req.template, step: req.step });
        return;
      }
      const written = inLanguage(template, req.writtenLanguage);
      const resolved = resolverValues(written, { copy: versionCopy }, audience);
      const persona = baseSystemPrompt + personaAddendumBlock(activeProfile.systemPromptAddendum);
      const voiced = await renderVoice({ written, values: { ...resolved, ...req.values }, target: req.target, sections: ['chat'] }, {
        meter: async () => (await evaluateAbuseGate({ personId: '', rateLimit: 0, isAdmin: false, machineWritten: true })).allowed,
        invoke: async (prompt) => invokeBedrockWithFallback(
          persona,
          [{ role: 'user', content: prompt }],
          // No tools, and no person's input to screen: the output guardrail runs on what the model wrote.
          { ...invokeConfig, tools: [], userTurnText: '' },
          resolution.fallbackModelId,
          { cacheableSystemPrefixLength: persona.length, enableCompanyContextTool: false },
        ),
        log: (entry) => console.log('[voice-send]', JSON.stringify({ ...entry, workflow: req.workflow, step: req.step })),
      });
      const content = (voiced.sections.chat ?? '').trim();
      if (!content) return;
      // ONE RESPONSE, IN AS MANY PARTS AS IT NEEDS, every part to the send's audience.
      await sendInParts(messagingClient, {
        ChannelArn: event.channelArn,
        text: content,
        ChimeBearer: event.botArn,
        Metadata: JSON.stringify({
          botResponse: true,
          respPhase: 'final',
          agentType: turnProfileName,
          // A VOICED SEND AT AN ARRIVAL IS A WELCOME (ADR-061 decision 2): measured with the welcomes, and with the other
          // event steps at every other event.
          turnKind: ARRIVAL_EVENTS.includes(req.event) ? 'welcome' : 'event_step',
          eventStep: { workflow: req.workflow, step: req.step, event: req.event, outcome: 'posted' },
          // WHICH LANGUAGE AND WHETHER THE MODEL SAID IT: data on the message, which is how it reaches the archive.
          voiceFill: { target: req.target, language: voiced.language, outcome: voiced.outcome },
          trigger: 'event_step',
          ...(typeof event.triggerAtMs === 'number' ? { triggerAtMs: event.triggerAtMs } : {}),
          entry: turnEntryOf(event.entry, 'event_step'),
          eventRun: { runKey: req.runKey, transitions: req.transitions ?? [] },
          ...(req.to.length ? { targetedSender: req.to[0] } : {}),
        }),
        ...(req.to.length ? { Target: req.to.map((MemberArn) => ({ MemberArn })) } : {}),
      });
      return;
    }

    if (event.welcomePrompt) {
      const request = event.welcomePrompt;
      const template = await loadNamedPromptTemplate({ classification: CLASSIFICATION, assistant: turnProfileName, name: request.template });
      await runWelcomePromptTurn(request, template, {
        // Metered here, after the opening is already posted, against the global budget only: no person asked.
        meter: async () => (await evaluateAbuseGate({ personId: '', rateLimit: 0, isAdmin: false, machineWritten: true })).allowed,
        people: async () => (await machineTurnRoster(event.channelArn, event.botArn)).filter((m) => !m.isBot).map((m) => m.name),
        invoke: async (prompt) => invokeBedrockWithFallback(
          systemPrompt,
          [{ role: 'user', content: prompt }],
          // Only the tools the welcome names, never the version's whole list; its own instructions are not a
          // person's input, so the input guardrail screens nothing (`userTurnText`), and the output guardrail runs.
          { ...invokeConfig, tools: request.tools, userTurnText: '' },
          resolution.fallbackModelId,
          { cacheableSystemPrefixLength, enableCompanyContextTool: true },
        ),
        post: async (content) => {
          // ONE RESPONSE, IN AS MANY PARTS AS IT NEEDS; a refused part throws, and the greeting is recorded as not posted.
          await sendInParts(messagingClient, {
            ChannelArn: event.channelArn,
            text: content,
            ChimeBearer: event.botArn,
            Metadata: JSON.stringify({
              botResponse: true,
              respPhase: 'final',
              agentType: turnProfileName,
              turnKind: 'welcome',
              welcomeOutcome: 'posted',
              // A welcome answers no message; the platform started it when the assistant joined (`turnEntryOf`).
              entry: turnEntryOf(event.entry, 'welcome'),
            }),
          });
        },
        record: (outcome, detail) => recordWelcomePromptOutcome(outcome, { correlationId: event.correlationId, ...detail }),
        // The tool loop's line for a turn that produced no text is not a greeting.
        emptyReplies: [noticeLine(versionCopy, 'nothingChanged'), noticeLine(versionCopy, 'completedWithoutSummary')],
      });
      return;
    }
    // P0 attribution: which profile VERSION served this turn's base model ('seed' = the compiled
    // default, i.e. no active version). Battle/experiment overrides still take precedence above.
    console.log('[AssistantAsyncProcessor] active profile', {
      profile: turnProfileName,
      profileConfigId: active.configId,
      baseModelKey: activeModelKey,
      effectiveModel,
    });

    const useExternal = !!(plan && cnCfg && plan.ref.provider !== 'bedrock');
    // Which rule routed the turn is said by its model, never by the value that decided it.
    if (plan?.routedBy === 'version-rule') {
      console.log('[AssistantAsyncProcessor] a routing rule of the version chose the model', { profile: turnProfileName, profileConfigId: active.configId, model: plan.ref.modelKey });
    }
    // Said once, with the reason, so an operator who configured a provider and sees every Chinese turn
    // on Bedrock can find why without reading the resolver.
    if (plan?.externalProviderWithheld) {
      console.log('[AssistantAsyncProcessor] external provider withheld; serving the in-AWS Bedrock baseline', {
        profile: turnProfileName,
        profileConfigId: active.configId,
        provider: cnCfg?.provider,
        model: plan.ref.modelId,
        reason: externalGate?.withheldReason ?? 'the classification does not select the external provider',
      });
    }

    // DeepSeek-on-Bedrock swap: the CN rule returned a Bedrock model different from the default. It
    // rides the normal Bedrock Converse path (guardrails/resilience/tool loop), just with a different
    // model id. For the reasoning model (R1): raise maxTokens (chain-of-thought eats the budget) and
    // skip tool-use (reasoning models are unreliable at tools — edits arrive on their own V3 turn).
    const cnBedrockModel =
      plan && plan.ref.provider === 'bedrock' && plan.ref.modelId !== effectiveModel ? plan.ref.modelId : null;
    const reasoningTurn = !!(cnBedrockModel && plan!.reasoning);
    // ── A TRIAGE TURN'S TOOL SURFACE IS SCOPED, NOT ABSENT (ADR-033, DESIGN 2.3) ─────────────────
    //
    // Its job is to produce a READING of what arrived - amends or new, in what order - and hand it
    // back for a person to confirm. The prompt says "do not answer any of them yet", and a prompt is
    // the weakest possible way to say that while the model is holding tools that let it advance a
    // task or generate a document.
    //
    // Executing a reading is the exact failure this ADR exists to prevent, and it would arrive here
    // through the TOOL SURFACE rather than through the text - which no amount of parsing the reply
    // would catch, because the acting happens before the reply exists.
    //
    // SO THE GUARD IS WHAT THE TOOLS ARE, and that is a different thing from having none. The first
    // build removed the surface entirely, which satisfied the guard and also removed step 3 of the
    // loop: a turn that cannot look anything up can never decide it needs another pass, so it always
    // returns its first impression. What is withheld here is everything with a SIDE EFFECT - the
    // work-item edit tools and the task loop - while the read-only context tools stay, because
    // reading cannot execute the work it was only asked to classify.
    const isTriageTurn = !!event.triage?.ids.length;

    const bedrockInvokeConfig = {
      ...invokeConfig,
      // THE READING IS RECORDED THROUGH A TOOL, so the ids it may classify are the queue itself.
      //
      // ON THE CONFIG, NOT THE OPTIONS BAG. `invokeBedrockWithFallback` forwards a fixed list of
      // options and reads everything else off `primaryConfig`; a field added to the bag is simply
      // dropped, silently - which is what happened, and the symptom was `toolCalled: false` on a turn
      // that had been told to call a tool it was never actually offered.
      ...(event.triage?.ids.length ? { readingOf: event.triage.ids } : {}),
      // WHAT IS OPEN HERE AND WHAT EACH ITEM STILL NEEDS, for the `open_work_summary` tool. Not on a
      // reading, whose tool surface is scoped to classifying the queue, nor on a duel side.
      ...(!isTriageTurn && !battleOn
        ? {
          openWorkSummary: buildOpenWorkSummary(conversationTasksAll, {
            ...(event.senderArn ? { viewerId: personIdFromArn(event.senderArn) || '' } : {}),
            machines: turnMachines,
            active: turnTasks?.current ?? null,
          }),
        }
        : {}),
      model: cnBedrockModel ?? effectiveModel,
      ...(stepModel && !cnBedrockModel ? { stepModel } : {}),
      maxTokens: resolveMaxTokens(event, reasoningTurn),
      // THE PROFILE'S OWN WORDS reach the loop, for the few lines it has to speak itself (tenet D11).
      // Without this the copy field exists and is never populated, which is a switch that looks wired
      // and is not - the loop would keep emitting hardcoded English while the console showed the
      // deployment had configured otherwise.
      // FROM THE RESOLVED PROFILE (code review, 2026-09-04). This read `event.variantProfile`,
      // which is set only on a battle or experiment VARIANT turn - so on an ordinary deployment it
      // was always undefined and the loop went on emitting hardcoded English, which is precisely
      // the "switch that looks wired and is not" the comment above warns about, in the same
      // statement that warns about it. `activeProfile` already resolves the variant when there is
      // one and the active version otherwise, so it is correct on both paths.
      copy: versionCopy,
    };
    const enableEditTools = !!event.domainContext && !reasoningTurn;
    const cnFallbackModelId = plan?.fallback?.modelId ?? resolution.fallbackModelId;

    // ── THE STEP PROMPT SAYS WHICH MODEL WRITES THE DOCUMENT (ADR-064 decision B) ───────────────────────────────────────
    //
    // A delivering step this one moves into whose model is not the turn's writes its own document: the loop moves onto
    // that model once the task enters it, and the move is made without the document. The step's section of the prompt
    // is rendered again from the same builder with that answer, read from the version this turn serves (an experiment
    // arm's own routes included), so the model running now is not asked to write a document it does not write.
    const turnStepModel = bedrockInvokeConfig.stepModel;
    if (turnStepModel && renderTaskStep && taskStepPrompt && event.taskType && !useExternal) {
      const turnTaskType = event.taskType;
      const rendered = renderTaskStep((state) => documentWrittenOnStep(
        stepOutputOf(turnMachines[turnTaskType]?.states?.[state]), turnStepModel(turnTaskType, state), bedrockInvokeConfig.model,
      ));
      if (rendered !== taskStepPrompt) systemPrompt = systemPrompt.replace(taskStepPrompt, () => rendered);
    }

    console.log('[AssistantAsyncProcessor] Model resolution', {
      profile: PROFILE_NAME,
      intent: event.intent,
      resolvedModel: useExternal
        ? `${cnCfg!.provider}:${cnCfg!.model}`
        : cnBedrockModel ?? effectiveModel,
      fallback: cnFallbackModelId,
      fromStrategy: resolution.resolvedFromStrategy,
      contextRouted: useExternal || !!cnBedrockModel,
      battle: battleOn ? { servedVariantModelKey } : undefined,
    });

    let bedrockResult: {
      response: string;
      inputTokens: number;
      outputTokens: number;
      bedrockTime: number;
      modelUsed: string;
      wasFallback?: boolean;
      fallbackReason?: string;
      retryCount?: number;
      steps?: ConverseStep[];
      modelMs?: number;
      toolMs?: number;
      /** Each tool call and the tools the turn held, for the tool judge (SPEC-EVALUATION Appendix C3). */
      toolCalls?: ToolCallRecord[];
      toolsOffered?: string[];
      /** The INPUT guardrail blocked the turn before any model ran (structural, see invokeBedrock). */
      inputGuardBlocked?: boolean;
      /** Which INPUT guardrail policies intervened - including on a turn that was masked rather than
       *  blocked, which the boolean above cannot express. See AnalyticsMetadata.guardrailFindings. */
      guardrailFindings?: string[];
      /** What the reading tool recorded, on a triage turn that used it. */
      reading?: Record<string, unknown>;
      /** The step's model the loop moved onto when the task entered a step with a model of its own mid-turn. */
      enteredStep?: StepModelChoice;
    };

    // SPEC-TASK-STATE-TRANSITIONS: active-task context for the in-loop advance_task_state tool
    // (undefined unless this turn belongs to a machine-backed task). Passing it registers the tool.
    // Every profile runs the same task loop, so this is wired uniformly.
    const taskContext = await buildTaskLoopContext({
      taskId: event.taskId,
      taskType: event.taskType,
      channelArn: event.channelArn,
      // THE SAME SET THE DELIVERY LOOKUP USES, and it has to be. This resolved independently while
      // another consumer narrowed, which authorized the advance tool over graphs the delivery gate no
      // longer knew about: the model could advance a task into a delivering state, the delivery
      // lookup would find no machine for it, and the document would ship as unattached chat text -
      // the exact failure that gate exists to prevent. One value, resolved once (ADR-047).
      machines: turnMachines,
      // What the turn's resolver holds: the machine's conditions and its step actions' variable bindings read it.
      variables: turnVariables,
      // Who holds the task while the assistant is working, and who it returns to once the person has
      // answered. Without it a task that entered a waiting state would stay in the user's queue
      // after they had already dealt with it.
      assistantId: principalIdFromArn(event.botArn),
      // The other work this message might be about, which is what lets the tool offer `task_id`.
      // Absent on an ordinary single-task turn, and then nothing about the loop changes.
      ...(event.referentCandidateIds?.length
        ? { referentCandidateIds: event.referentCandidateIds }
        : {}),
      // So the loop can tell, from the task row, that this is the turn that opened the task: a step the
      // machine declares `presented` may not be left on that turn.
      ...(event.correlationId ? { turnCorrelationId: event.correlationId } : {}),
      // THE NEW STEP'S INSTRUCTIONS RIDE THE ADVANCE. The prompt above is rendered for the state the
      // turn started in; an advance mid-loop lands the model somewhere else, so the tool result hands
      // it that state's guidance, rendered the same way and from the same machines.
      guidanceFor: (taskType: string, state: string, details?: Record<string, unknown>) => {
        const def = turnMachines[taskType]?.states?.[state];
        return buildTaskSystemPrompt(taskType, state, turnMachines, {
          ...(turnTemplates ? { templates: turnTemplates } : {}),
          ...(details ? { details } : {}),
        })
          + (deliversDocument(def) ? `\n\n${deliveringContract()}` : '');
      },
      ...(turnTemplates ? { templates: turnTemplates } : {}),
    });

    // Attachment-in (non-battle): the user sent an image/PDF/doc — fetch it and attach a Converse
    // image or document block so the assistant can read it. Best-effort: a fetch/format miss degrades
    // to a normal text turn. Skipped on /battle turns (battle carries its image via battleContext).
    let imageInput: BedrockImageInput | undefined;
    let documentInput: BedrockDocumentInput | undefined;
    // THE FILE ARRIVED AND WAS NOT READ, and the person has to be told. Set when the
    // attachment is over the model byte budget; the line is appended to the answer once the answer
    // exists, so the turn still completes rather than dying on a Bedrock ValidationException.
    let attachmentTooLargeName: string | undefined;
    let attachmentTooLarge = false;
    const attachmentsBucket = process.env.ATTACHMENTS_BUCKET;
    // Ownership check (mirrors the presigned-url download path): the fileKey comes from user-controlled
    // message Metadata, so verify the object is under the SENDER's own storage prefix —
    // attachments/<conversationId>/<senderSub>/... — before reading it. Without this a crafted fileKey
    // could read another user's file (the S3 grant spans the whole attachments/* prefix). S3 keys are
    // not path-normalized, so a literal '..' cannot traverse out of the sender's segment.
    const attachmentOwnedBySender = senderOwnsAttachmentKey(event.attachment?.fileKey, event.senderArn);
    if (!battleOn && event.attachment?.fileKey && attachmentsBucket && attachmentOwnedBySender) {
      try {
        const imgFmt = imageFormatFromContentType(event.attachment.contentType);
        const docFmt = docFormatFromContentType(event.attachment.contentType);
        if (imgFmt || docFmt) {
          const bytes = await fetchAttachmentBytes(s3Client, attachmentsBucket, event.attachment.fileKey);
          // OVER THE LIMIT IS A DEGRADE, NOT A FAILED TURN. The upload cap (10 MiB) is deliberately
          // above the model budget (see attachment-budget.ts), so a file the platform accepted can
          // still be one the model cannot take - by weight, or by pixel edge, which a phone screenshot
          // stitched into a long capture reaches while staying well inside the byte budget. Sending it
          // anyway is what produced the ValidationException this guard exists for. The turn proceeds
          // without the block and the person is told, once, here. Both limits are compared in the one
          // place, and an image whose header could not be read is SENT rather than guessed at.
          const fit = attachmentFitsModelLimits(bytes);
          if (!fit.fits) {
            recordAttachmentOverBudget({
              path: 'current-turn',
              byteLength: bytes.byteLength,
              reason: fit.reason,
              dimensions: fit.dimensions,
              contentType: event.attachment.contentType,
              classification: CLASSIFICATION,
            });
            attachmentTooLarge = true;
            attachmentTooLargeName = event.attachment.name;
          } else if (imgFmt) {
            imageInput = { format: imgFmt, bytes };
          } else if (docFmt) {
            // Bedrock's document-name rules are stricter than a filesystem's: alphanumerics,
            // single spaces, hyphens, parentheses and brackets ONLY - a dot rejects the request
            // outright (ValidationException, measured live on 'project-brief.txt'), and so does any
            // run of consecutive whitespace. The extension is dropped rather than laundered: the
            // `format` field is what tells Converse the type.
            const safeName = (event.attachment.name || 'document')
              .replace(/\.[a-zA-Z0-9]+$/, '')
              .replace(/[^a-zA-Z0-9 \-()[\]]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 200) || 'document';
            documentInput = { format: docFmt, name: safeName, bytes };
          }
          if (!attachmentTooLarge) {
            console.log('[AssistantAsyncProcessor] attachment-in', { type: event.attachment.contentType, kind: imgFmt ? 'image' : 'document' });
          }
        } else {
          console.warn('[AssistantAsyncProcessor] attachment type not supported by Converse:', event.attachment.contentType);
        }
      } catch (e) {
        console.warn('[AssistantAsyncProcessor] attachment fetch failed (non-fatal):', e);
      }
    } else if (!battleOn && event.attachment?.fileKey && !attachmentOwnedBySender) {
      console.warn('[AssistantAsyncProcessor] attachment fileKey not under the sender prefix; ignoring (possible cross-user reference)');
    } else if (!battleOn && event.attachment?.fileKey && !attachmentsBucket) {
      // A FILE ARRIVED AT A PROFILE THAT CANNOT OPEN ONE, and until this line that was the only path
      // through here which said nothing at all: the `if` failed on the missing bucket and the
      // ownership `else if` did not cover it, so the turn answered from the caption with no error,
      // no warning and no record. Measured 2026-09-12 on basic - the reply was fluent and wrong, and
      // finding out why took a trace across three Lambdas.
      //
      // This is the LAST-RESORT witness, not the fix. `attachmentsReadable` (config/profiles.ts) now
      // drives the grant, this env var and the composer's paperclip together, so a person should not
      // be able to send a file here at all. If this line ever prints, those three have come apart -
      // which is exactly when somebody needs to be told.
      console.warn('[AssistantAsyncProcessor] an attachment arrived but this profile has no ATTACHMENTS_BUCKET; answering from the text alone', {
        contentType: event.attachment.contentType,
        profile: PROFILE_NAME,
      });
    }

    // ── Generation-out: produce an IMAGE from the prompt instead of text. This is now a NORMAL
    // capability (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "image generation must become a normal
    // capability"), not a battle-only branch. Evaluated FIRST and mutually exclusive with vision-in.
    // Resolve the image-gen model id ONLY on a turn whose intent is routed to an image model or needs an
    // image (every source, battle included):
    // the experiment variant's image model, then the served version's image route. A duel side's image
    // model is its pinned version's image route, so a battle takes the same path as any turn.
    // Absent/unknown id => 'text'; a present-but-unknown id is surfaced visibly, never string-matched away.
    let battleImageCount: number | undefined;
    // Delivered message attachment (a generated image here, or a generated document below). Declared
    // once and shared: a generation-out turn sets an image attachment; the doc-generation block only
    // runs when no attachment is set yet, so the two paths never clobber each other.
    let attachment: GeneratedDocument | undefined;
    // The reference evaluation grades the delivered document from (SPEC-EVALUATION FR22), set only when
    // the doc-generation block below uploads one.
    let deliveredDocument: DeliveredDocumentReference | undefined;
    // THE TURN'S IMAGE ROUTE: an intent whose route names an image model generates an image, whatever the
    // intent is called; its fallback is tried once when the primary fails on the model side.
    // A TURN BOUND TO A TASK'S WORKFLOW NEEDS AN IMAGE ONLY IN A STEP THAT PRODUCES ONE (ADR-064 decision 2), and that
    // step is the platform's act (`generate_image`, below), so such a turn never takes this single-turn image path. An
    // intent with no workflow has one implicit step, whose output is its `needs`.
    const boundToMachine = !!(event.taskId && event.taskType && turnMachines[event.taskType]);
    const turnImageNeed = boundToMachine
      ? { intent: event.intent, need: 'text' }
      : { intent: event.intent, need: turnIntentDef ? needsOf(turnIntentDef) : undefined };
    const imageRoute = boundToMachine ? {} as ReturnType<typeof resolveTurnImageRoute> : resolveTurnImageRoute({
      ...turnImageNeed,
      // Only an image model this classification allows is ever resolved, whatever the source names.
      classification: CLASSIFICATION,
      // A turn that serves a version (an enrolled experiment arm, a duel side) takes the image model from
      // that version's routes, like any version; only a turn of an experiment armed before versions were
      // served still carries a per-turn variant image model here.
      experimentImageModelKey: event.variantProfile ? undefined : event.resolvedImageModelKey,
      models: active.models,
      profileImageModelKey: active.imageModelKey,
    });
    const genOutModelId = imageRoute.primaryId;
    const genOutFallbackModelId = imageRoute.fallbackId;
    const genOutPlan = resolveGenerationOutPlan({ imageGenModelId: genOutModelId });
    if (genOutModelId && genOutPlan.action !== 'generation') {
      console.warn(
        '[AssistantAsyncProcessor] image model id set but not a registered image model — ' +
          'falling through to a text turn',
        { imageGenModelId: genOutModelId },
      );
    }

    // FAIL FAST, AND SAY WHY. An `image_generation` turn that resolved no registered image model used
    // to fall through and run as a TEXT turn. That is the wrong failure twice over: the person asked
    // for an image and silently got prose, and when the text model was itself unusable the turn died on
    // a `ValidationException: The provided model identifier is invalid` from Bedrock - after paying the
    // round-trip, with a stack trace and no statement of what was misconfigured.
    //
    // Observed in a battle: the variant carried a TEXT model key ('sonnet') and no image model, so an
    // `image_generation` turn resolved a text inference-profile ARN and failed inside Bedrock.
    //
    // NOTE ON THAT BEDROCK MESSAGE. It reads like a bad id and is not always one: Bedrock returns the
    // identical text for a VALID id invoked in a region that does not carry the model. That cost one
    // investigation already. Region is now a property of the registry entry (`region` in
    // image-gen-models.ts) and the invoker builds its client for the model's own region, so a
    // wrong-region call is no longer reachable through configuration. What remains below is the
    // genuinely-unconfigured case.
    //
    // Name the three things a reader needs: that this was an image turn, which id was resolved (or that
    // none was), and where an image model is configured. Battle is called out separately because the
    // variant is the override that wins, so that is the thing to fix.
    // Every intent that needs an image is held to this (`turnNeedsImage`: `image_generation`, and a pack
    // intent that declares `needs: 'image'`), so no such turn answers in text.
    if (!boundToMachine && turnNeedsImage(turnImageNeed) && genOutPlan.action !== 'generation') {
      const reason = genOutModelId
        ? `resolved image model "${genOutModelId}" is not a registered image model`
        : 'no image model is configured for this turn';
      const where = !classificationAllows(CLASSIFICATION, 'image')
        ? `the ${CLASSIFICATION} classification is allowed no image model in the model catalog`
        : battleOn
          ? "this side's pinned version carries no image model (its variant's `imageGenModelKey` is unset)"
          : `the version routes \`${event.intent}\` to no image model this classification allows (\`models.byIntent\`)`;
      console.error(
        `[AssistantAsyncProcessor] ${event.intent} turn cannot run: ` + reason + ' — ' + where,
        { imageGenModelId: genOutModelId, battleOn, intent: event.intent },
      );
      await handleProcessingError(
        event,
        new Error(
          `${event.intent} turn cannot run: ` + reason + ' — ' + where
            + '. No image model is configured for this assistant.',
        ),
        turnCopy,
      );
      return;
    }
    // Honest degrade (no crash): image generation needs the attachments bucket (to persist the PNG).
    // The guardrail + cost-cap env (BATTLE_IMAGE_GUARDRAIL_ID, BATTLE_IMAGE_MAX_IMAGES/DIMENSION,
    // and, where it selects an image model hosted outside AWS, IMAGE_GEN_KEYS_SECRET_ARN) are wired on every
    // processor whose classification selects an image model (`imageModelsAllowedFor`, `assistant-profile-stack.ts`). A processor without
    // the bucket resolved an image model its classification is not wired for, and degrades to a normal
    // text turn rather than throwing in persistImageGenOutput.
    // A round-2 battle turn is always a VERBAL rebuttal (a grounded critique of the rival's round-1
    // output), never a fresh image generation - even in an image battle. So suppress gen-out on round 2
    // and let the normal Bedrock text path run, with the rival's round-1 image attached as a vision
    // block (resolved from the conversation below). Round-1 image battles are unaffected.
    const isRebuttalTurn = battleOn && event.battleContext?.round === 2;
    const canGenerateImage =
      genOutPlan.action === 'generation' && !!process.env.ATTACHMENTS_BUCKET && !isRebuttalTurn;
    if (genOutPlan.action === 'generation' && !canGenerateImage && !isRebuttalTurn) {
      console.warn(
        '[AssistantAsyncProcessor] resolved an image model but ATTACHMENTS_BUCKET is unset on this ' +
          'processor; degrading to a text turn. The image env is wired only where the catalog allows the classification an image model.',
        { modelId: genOutPlan.modelId, profile: PROFILE_NAME },
      );
    }
    const imgAtt = battleOn ? event.battleContext?.imageAttachment : undefined;

    // ── /battle round-2 image rebuttal (perceive-through-conversation): if the rival's round-1 output
    // was a GENERATED IMAGE, it rides its round-1 message as a Chime attachment - already captured onto
    // the loaded history by loadChannelHistory. Resolve those recent history image attachments into
    // Converse vision blocks (bytes fetched from ATTACHMENTS_BUCKET, bounded for cost) so the rebuttal
    // critiques the rival's ACTUAL image read from the shared channel, not just its caption. Gated to a
    // vision-capable model; degrades to a text-only rebuttal on any miss (never crashes). The rebuttal
    // then runs the normal Bedrock text path below, which renders the attached image blocks. A text
    // battle has no history images, so this is a no-op there.
    if (isRebuttalTurn && process.env.ATTACHMENTS_BUCKET) {
      const rebuttalVisionPlan = resolveBattleVisionPlan({
        variantModelKey: servedVariantModelKey,
        baseModelId: effectiveModel,
        hasImageAttachment: true,
        imageContentType: 'image/png', // generated battle images are always PNG
      });
      if (rebuttalVisionPlan.action === 'vision') {
        try {
          const attached = await resolveHistoryImageBlocks({
            messages: bedrockMessages,
            s3: s3Client,
            bucket: process.env.ATTACHMENTS_BUCKET,
          });
          if (attached > 0) {
            // Additive one-liner (buildRebuttalContext wording unchanged): point the model at the image
            // it now sees in the conversation. Appended to the END, after the cache-prefix point, so it
            // does not disturb systemPrompt caching.
            systemPrompt += buildRebuttalImageNote(event.battleContext?.rivalName);
            console.log('[AssistantAsyncProcessor][battle] round-2 rebuttal sees rival image(s) via conversation', { attached });
          }
        } catch (e) {
          console.warn('[AssistantAsyncProcessor][battle] rival image resolution failed; text-only rebuttal:', e);
        }
      } else {
        console.log('[AssistantAsyncProcessor][battle] round-2 model not vision-capable; text-only rebuttal');
      }
    }

    // THE IMAGE OPTIONS FOR ONE MODEL: its region's guardrail and the deployer's caps. Shared by the single-turn image path
    // and the `generate_image` step, so both are held to the same guardrail and the same caps.
    const envIntOf = (v: string | undefined): number | undefined => {
      const n = Number(v);
      return v != null && Number.isFinite(n) ? n : undefined;
    };
    const imageOptionsFor = (modelId: string) => {
      const key = imageGenModelIdToKey(modelId);
      const region = imageGenRegionFor(key ? IMAGE_GEN_MODELS[key] : undefined);
      const g = imageGuardrailFor(region);
      if (!g) {
        console.error(
          `[AssistantAsyncProcessor][image] no guardrail provisioned in ${region}; not running ${modelId} unmoderated. `
          + 'Provision a guardrail there (BATTLE_IMAGE_GUARDRAIL_BY_REGION) and redeploy.',
        );
        return undefined;
      }
      return {
        guardrailIdentifier: g.id,
        guardrailVersion: g.version,
        maxImagesCap: envIntOf(process.env.BATTLE_IMAGE_MAX_IMAGES),
        maxDimensionCap: envIntOf(process.env.BATTLE_IMAGE_MAX_DIMENSION),
      };
    };
    // ── A STEP THAT PRODUCES AN IMAGE (ADR-064 decision E) ─────────────────────────────────────────
    // The `generate_image` action draws it on the image model of the task intent's route, from the recorded brief, under
    // the same guardrail, persisted and attached to this turn's reply, so the turn that confirmed the brief returns the
    // image. An image model hosted outside AWS is the admin's choice through the classification's selection; the call is
    // recorded on the turn (provider, model, and whether the brief carried a context-sourced requirement), not blocked.
    if (boundToMachine && process.env.ATTACHMENTS_BUCKET) {
      const generateImage = async (prompt: string, task: { taskType?: string; details?: Record<string, unknown> }) => {
        const stepRoute = resolveTurnImageRoute({
          intent: task.taskType, need: 'image', classification: CLASSIFICATION,
          experimentImageModelKey: event.variantProfile ? undefined : event.resolvedImageModelKey,
          models: active.models, profileImageModelKey: active.imageModelKey,
        });
        const stepPlan = resolveGenerationOutPlan({ imageGenModelId: stepRoute.primaryId });
        if (stepPlan.action !== 'generation') return { ok: false, errorClass: 'image_model_unavailable' };
        const gen = await invokeImageGenWithFallback({
          primaryModelId: stepPlan.modelId!,
          fallbackModelId: stepRoute.fallbackId,
          prompt,
          optionsFor: imageOptionsFor,
          ...(context ? { remainingMs: () => context.getRemainingTimeInMillis() } : {}),
        });
        const out = await persistImageGenOutput({
          images: gen.images, bucket: process.env.ATTACHMENTS_BUCKET || '', channelArn: event.channelArn, modelId: gen.modelId, s3: s3Client,
        });
        battleImageCount = out.persisted.length;
        const key = imageGenModelIdToKey(gen.modelId);
        const def = key ? IMAGE_GEN_MODELS[key] : undefined;
        if (def && def.hosting === 'external-http') {
          const collected = (task.details?.collectedRequirements ?? {}) as Record<string, { source?: string }>;
          modelChoice.imageEgress = { provider: String(def.provider), model: def.key, contextSourced: collected['what to draw']?.source === 'context' };
        }
        if (!out.persisted.length) return { ok: false, modelId: gen.modelId, errorClass: gen.guardrailIntervened ? 'guardrail' : 'model_error' };
        attachment = buildImageGenAttachment({ persisted: out.persisted });
        const cost = estimateStepCostUsd({ modelId: gen.modelId, imageCount: out.persisted.length, tokensIn: 0, tokensOut: 0 });
        return { ok: true, modelId: gen.modelId, imageCount: out.persisted.length, ...(cost != null ? { estCostUsd: cost } : {}) };
      };
      Object.assign(bedrockInvokeConfig, { generateImage });
    }

    if (canGenerateImage) {
      // No Bedrock text call: invoke the image model, persist to S3, deliver the image as a message
      // ATTACHMENT (like a generated document) so the frontend AttachmentDisplay renders an <img> that
      // fetches a fresh presigned URL on demand — no giant presigned URL embedded in the content, no
      // STS-token expiry, and it renders in the browser (the old inline <!--battleimage:--> marker did
      // not). Honest empty path: a generation failure or guardrail block persists nothing, attaches
      // nothing, and yields an honest text line (never a fabricated image).
      const genStart = Date.now();
      // THE IMAGE ROUTE: the primary, then the route's fallback once on a model-side failure. Guardrails are
      // REGIONAL and image models are not always local (the Stability generators are us-west-2-only), so
      // `optionsFor` resolves each model's guardrail in the region that model's call goes to, and is the one
      // place it is resolved. A primary whose region has no guardrail refuses the turn (the invoker throws
      // `image generation blocked: no content guardrail available in <region>`) and nothing is generated
      // unmoderated; a fallback whose region has none is not run.
      const gen = await invokeImageGenWithFallback({
        primaryModelId: genOutPlan.modelId!,
        fallbackModelId: genOutFallbackModelId,
        prompt: event.userMessage || '',
        optionsFor: imageOptionsFor,
        onFallback: (info) => console.warn('[AssistantAsyncProcessor][image] primary image model failed on the model side; trying the route fallback', {
          ...info, profile: PROFILE_NAME, correlationId: event.correlationId,
        }),
        // The fallback runs only in the time this invocation has left, with room to post the reply.
        ...(context ? { remainingMs: () => context.getRemainingTimeInMillis() } : {}),
        onFallbackSkipped: (info) => console.warn('[AssistantAsyncProcessor][image] not trying the route fallback: too little time left', {
          ...info, profile: PROFILE_NAME, correlationId: event.correlationId,
        }),
      });
      // The model that produced the image is the one the turn records, so analytics attribute it.
      const genModelKey = imageGenModelIdToKey(gen.modelId);
      const out = await persistImageGenOutput({
        images: gen.images,
        bucket: process.env.ATTACHMENTS_BUCKET || '',
        channelArn: event.channelArn,
        modelId: gen.modelId,
        s3: s3Client,
      });
      battleImageCount = out.persisted.length;
      // Deliver the first persisted image as the message attachment (the required minimum). Nothing
      // persisted (failure / guardrail block) => no attachment, only the honest text line below.
      if (out.persisted.length > 0) {
        attachment = buildImageGenAttachment({ persisted: out.persisted });
      }
      bedrockResult = {
        response: buildBattleImageContent({
          persisted: out.persisted,
          modelId: gen.modelId,
          displayName: genModelKey ? IMAGE_GEN_MODELS[genModelKey].displayName : genOutPlan.displayName,
          guardrailIntervened: gen.guardrailIntervened,
        }),
        inputTokens: 0,
        outputTokens: 0,
        bedrockTime: Date.now() - genStart,
        modelUsed: gen.modelId,
        wasFallback: gen.wasFallback,
        retryCount: gen.retryCount,
        // The image call is this turn's step, with its model, its span and its price per image, so the turn reads
        // its call and its cost in Effectiveness like a text turn does (ADR-064 decision 4).
        steps: [imageGenerationStep({
          modelId: gen.modelId,
          startedAt: new Date(genStart).toISOString(),
          endedAt: new Date().toISOString(),
          imageCount: out.persisted.length,
        })],
      };
    } else if (imgAtt) {
      // ── /battle vision-in: decide per-variant whether to send the image or reject text-only.
      const visionPlan = resolveBattleVisionPlan({
        variantModelKey: servedVariantModelKey,
        baseModelId: effectiveModel,
        hasImageAttachment: true,
        imageContentType: imgAtt.contentType,
      });
      if (visionPlan.action === 'reject-text-only') {
        bedrockResult = {
          response: visionPlan.rejectMessage as string,
          inputTokens: 0,
          outputTokens: 0,
          bedrockTime: 0,
          modelUsed: invokeConfig.model,
          wasFallback: false,
          retryCount: 0,
        };
      } else if (visionPlan.action === 'vision') {
        // Ownership check (mirrors the non-battle attachment path + presigned-url path). On a
        // cross-user reference, fall back to a text-only battle turn.
        if (!senderOwnsAttachmentKey(imgAtt.fileKey, event.senderArn)) {
          console.warn('[AssistantAsyncProcessor] battle image fileKey not under the sender prefix; ignoring (possible cross-user reference)');
          bedrockResult = await invokeBedrockWithFallback(
            systemPrompt,
            bedrockMessages,
            invokeConfig,
            resolution.fallbackModelId,
            { cacheableSystemPrefixLength },
          );
        } else {
          const bytes = await fetchAttachmentBytes(
            s3Client,
            process.env.ATTACHMENTS_BUCKET || '',
            imgAtt.fileKey,
          );
          // The same limits as the ordinary attach path, from the same place - bytes and pixel edges
          // both. A duel side that sent an image the model could not take failed at Bedrock and lost
          // the round to a ValidationException; it now argues from the caption and says the image went
          // unread.
          const battleFit = attachmentFitsModelLimits(bytes);
          if (!battleFit.fits) {
            recordAttachmentOverBudget({
              path: 'current-turn',
              byteLength: bytes.byteLength,
              reason: battleFit.reason,
              dimensions: battleFit.dimensions,
              contentType: imgAtt.contentType,
              classification: CLASSIFICATION,
            });
            attachmentTooLarge = true;
            // The battle attachment carries no display name of its own; the same upload arrives on
            // `event.attachment` when the router forwarded one, so that is where a name can come from.
            attachmentTooLargeName = event.attachment?.name;
            bedrockResult = await invokeBedrockWithFallback(
              systemPrompt,
              bedrockMessages,
              invokeConfig,
              resolution.fallbackModelId,
              { cacheableSystemPrefixLength },
            );
          } else {
            bedrockResult = await invokeBedrockWithFallback(
              systemPrompt,
              bedrockMessages,
              invokeConfig,
              resolution.fallbackModelId,
              { imageInput: { format: visionPlan.imageFormat!, bytes }, cacheableSystemPrefixLength },
            );
          }
        }
      } else {
        bedrockResult = await invokeBedrockWithFallback(
          systemPrompt,
          bedrockMessages,
          invokeConfig,
          resolution.fallbackModelId,
          { cacheableSystemPrefixLength },
        );
      }
    } else if (useExternal && cnCfg) {
      // External (Chinese) provider — text-only. Bedrock Guardrails do NOT apply to external
      // providers, so apply the compensating INPUT and output checks explicitly. Any failure degrades to Bedrock.
      const t0 = Date.now();
      // Input guardrail parity: the external provider never runs Bedrock's input-side PROMPT_ATTACK /
      // content filter, so run it here BEFORE the external model sees the prompt (the Bedrock path does
      // this inside invokeBedrock). A prompt attack short-circuits the turn with no external call; fails
      // OPEN on a guardrail outage. External turns are never /battle rounds, so no skip case applies.
      // THE UNTRUSTED HALF, not the wrapper around it. On a triage turn the `userMessage` is the
      // assembled contract - instructions around quoted user text - and screening that blocked every
      // triage turn before the model call. The queued messages are what a person actually sent, so
      // they are what gets screened; the contract is our own text and screening it protects nobody.
      // A STOP EVALUATION IS ASSEMBLED THE SAME WAY A READING IS, and was screened as though it were
      // a person's message. The prompt-attack filter then fired on our own contract and blocked the
      // turn before the model ran, so the stop judged nothing and the held work stayed open.
      // THREE ASSEMBLERS, ONE LINE. A reading, a stop evaluation and an amendment fold each wrap
      // instructions around what somebody wrote, and each was screened as though the whole thing had
      // been typed by a person - blocking the turn before the model ran. Each was found separately
      // and fixed where it was found, which is why the shapes differ; this is the one place that
      // decides, and a fourth assembler belongs here rather than beside them.
      const guardedInput = event.triage?.userContent
        ?? event.stopEvaluation?.userContent
        ?? event.userContent
        ?? event.userMessage
        ?? '';
      const extInputGuard = await applyInputGuardrail(guardedInput, active.guardrailId, versionCopy);
      if (extInputGuard.blocked) {
        console.warn('[AssistantAsyncProcessor] external path: input guardrail intervened; blocking before the external model call');
        bedrockResult = {
          response: extInputGuard.message,
          inputTokens: 0,
          outputTokens: 0,
          bedrockTime: Date.now() - t0,
          modelUsed: `external:${cnCfg.model}`,
          wasFallback: false,
          retryCount: 0,
          // The SAME structural fact the Bedrock path declares (invokeBedrock's blocked early return).
          // `response` here is guardrail block copy, not an answer, and a deployment with custom
          // blockedInputMessaging leaves no text shape a reader could recover that from - so a turn
          // blocked on this path archived as an ordinary answer purely because it took the external
          // route. Parity in the guardrail call without parity in what it records is not parity.
          inputGuardBlocked: true,
          // AND WHICH POLICIES DID IT. The Bedrock path returns these beside the boolean, and this
          // one dropped them - so an external turn recorded THAT a guardrail stopped it and never
          // which one, leaving the abuse signal blank on exactly the deployments that route away
          // from Bedrock. Parity is the findings as well as the flag.
          guardrailFindings: extInputGuard.findings,
        };
      } else {
      try {
        const ext = await invokeExternalLlm(cnCfg, systemPrompt, bedrockMessages, {
          maxTokens: resolveMaxTokens(event, false),
          // The intent's answering temperature (FR19), the same value the Bedrock path sends: a code
          // turn routed to an external model must not fall back to the deployment default.
          temperature: invokeConfig.temperature,
          // Propose-and-confirm parity: expose the work-item tools on plan conversations.
          ...(event.domainContext ? { tools: WORK_ITEM_OPENAI_TOOLS } : {}),
        });
        // A work-item tool call on the external path becomes a proposal marker (not executed),
        // exactly like the Bedrock tool loop — so Chinese turns can propose edits too.
        let extText = ext.response;
        if (ext.toolCall && WORK_ITEM_TOOL_NAMES.has(ext.toolCall.name)) {
          const lead = ext.response || "Here's the change I'd make — review and apply it when you're ready.";
          extText = `${lead}\n\n${proposalMarker(ext.toolCall.name, ext.toolCall.args)}`;
        }
        const guarded = await applyOutputGuardrail(extText, active.guardrailId);
        bedrockResult = {
          response: guarded,
          inputTokens: ext.inputTokens,
          outputTokens: ext.outputTokens,
          bedrockTime: Date.now() - t0,
          modelUsed: `${ext.provider}:${cnCfg.model}`,
          wasFallback: false,
          // THE TURN RAN AND THE INPUT GUARDRAIL MAY STILL HAVE INTERVENED - a policy that MASKED
          // rather than blocked. Same line the Bedrock path carries at its own successful return; the
          // output-side findings are picked up separately from `takeOutputGuardrailFindings()`.
          ...(extInputGuard.findings.length ? { guardrailFindings: extInputGuard.findings } : {}),
          steps: [makeConverseStep({
            stepLabel: ext.toolCall ? `tool-propose:${ext.toolCall.name}` : 'generate',
            modelId: `${ext.provider}:${cnCfg.model}`,
            startedAt: new Date(t0).toISOString(),
            endedAt: new Date().toISOString(),
            tokensIn: ext.inputTokens,
            tokensOut: ext.outputTokens,
          })],
        };
        // External spend is invisible to AWS billing — log it so it's always attributable.
        console.log('[AssistantAsyncProcessor][cost] external', {
          provider: ext.provider,
          model: cnCfg.model,
          inputTokens: ext.inputTokens,
          outputTokens: ext.outputTokens,
          costUsd: ext.costUsd,
          billedBy: ext.billedBy,
        });
      } catch (err) {
        console.warn('[AssistantAsyncProcessor] External provider failed; falling back to Bedrock:', err);
        bedrockResult = await invokeBedrockWithFallback(systemPrompt, bedrockMessages, bedrockInvokeConfig, cnFallbackModelId, {
          // READ-ONLY, so triage keeps it: looking something up cannot execute the work it was only
          // asked to classify, and step 3 of the loop needs somewhere to look.
          enableCompanyContextTool: true,
          // SIDE-EFFECTING, so triage never gets it.
          enableEditTools: enableEditTools && !isTriageTurn,
          imageInput,
          documentInput,
          cacheableSystemPrefixLength,
          taskContext,
        });
      }
      } // end input-guardrail else (external path)
    } else {
      // Default path — Bedrock with retry + fallback; company-context tool + work-item tools (the
      // latter only on plan conversations, and not on reasoning-model turns) + the task tool loop.
      // The model is the profile default, the /battle text-turn model, OR the CN DeepSeek-on-Bedrock
      // model when geography routing selected it.
      bedrockResult = await invokeBedrockWithFallback(
        systemPrompt,
        bedrockMessages,
        bedrockInvokeConfig,
        cnFallbackModelId,
        {
          // READ-ONLY, so triage keeps it: looking something up cannot execute the work it was only
          // asked to classify, and step 3 of the loop needs somewhere to look.
          enableCompanyContextTool: true,
          // SIDE-EFFECTING, so triage never gets it.
          enableEditTools: enableEditTools && !isTriageTurn,
          imageInput,
          documentInput,
          cacheableSystemPrefixLength,
          // No task loop either: a turn that is reading a queue must not be able to advance the work
          // it is reading ABOUT.
          ...(isTriageTurn ? {} : { taskContext }),
        },
      );
    }

    // ── THE MODEL THE TURN ENDED ON (ADR-064 decision B) ────────────────────────────────────────────
    //
    // A task that entered a step with a model of its own mid-turn moved the loop onto that step's model, which wrote the
    // reply. A correction before delivery runs on that model and its fallback, and the turn's record names it with the
    // rule that chose it (`model_from`); `task_step` stays the step the turn started in.
    const endedOn = modelTheTurnEndedOn(
      { model: invokeConfig.model, fallbackModelId: resolution.fallbackModelId, modelFrom: plan.modelFrom },
      bedrockResult.enteredStep,
    );
    const followOnConfig = endedOn.model === invokeConfig.model ? invokeConfig : { ...invokeConfig, model: endedOn.model };
    modelChoice.modelFrom = endedOn.modelFrom;
    // THE FOLLOW-ON CALLS ARE STEPS OF THIS TURN, each priced on the model it ran on, so a turn's cost is the sum of
    // every call it made (ADR-064 decision 4). Their tokens join the turn's.
    const followOnSteps: ConverseStep[] = [];
    const recordFollowOn = (label: string, r: { inputTokens?: number; outputTokens?: number; steps?: ConverseStep[] }) => {
      followOnSteps.push(...(r.steps ?? []).map((s) => ({ ...s, stepLabel: `${label}:${s.stepLabel}` })));
      bedrockResult.inputTokens += r.inputTokens ?? 0;
      bedrockResult.outputTokens += r.outputTokens ?? 0;
    };

    // On plan conversations, extract any ```suggestions JSON block the model emitted into a
    // `<!--suggestions:-->` marker (model-agnostic — works for R1, which can't use tools). The
    // visible prose is unchanged; the widget renders cards from the marker.
    // Strip any leaked reasoning scaffolding (`<thinking>…</thinking>`, `<result>` wrappers) the model
    // sometimes emits in its FINAL answer — never intended for the human, and it also poisons the
    // generated report file if left in. Not a control marker, so stripMessageMarkers wouldn't catch it.
    // `let`, because a delivering turn may CORRECT this once before it is delivered (the deliverable
    // check below). Nothing else reassigns it.
    let response = stripReasoningTags(
      event.domainContext ? extractSuggestions(bedrockResult.response) : bedrockResult.response,
    );

    // ── WHAT THEY CHOSE, IF THIS REPLY ANSWERED THE OFFER (DESIGN 2.4.2) ────────────────────
    //
    // The marker is stripped WHATEVER it said, including when it says nothing usable: it is a
    // machine line and a person reading it is reading scaffolding. Stripping first also means a
    // refused or unparsed selection cannot leak the contract into the conversation.
    if (pendingSplit) {
      // THE MODEL FIRST, THEN THE PERSON.
      //
      // The machine line is still the primary contract and still wins where it exists. But live, on
      // a deployed turn carrying the offer and an unambiguous answer, the model wrote 2102
      // characters and no SPLIT line - so the offer stayed open, the person watched nothing happen,
      // and they could be asked again. Two prompt revisions did not change that.
      //
      // The offer does not need the model: its labels are a closed set this system recorded, and the
      // person answered in their own words in a message already in hand. `selectionFromTheirWords`
      // reads those, and is deliberately conservative - it needs an intent to separate AND a label
      // it can name, so mentioning a subject in passing selects nothing.
      const selection = parseSplitSelection(response, pendingSplit.topics)
        ?? selectionFromTheirWords(event.userMessage || '', pendingSplit.topics);
      response = stripSplitSelection(response);

      // THE STRANDING CASE, NAMED. A reply that answers no offer leaves it standing, so somebody
      // who answered in plain words watches nothing happen and is told nothing - and the offer can
      // still be answered a second time. Whether that is the parse or the reply is the first thing
      // anybody needs to know, and until now neither left a line.
      if (!selection) {
        console.warn('[AsyncProcessor][split] the reply answered no offer; it stays open', {
          correlationId: event.correlationId,
          topics: pendingSplit.topics.map((t) => t.label),
          replyChars: response.length,
        });
      } else {
        console.log('[AsyncProcessor][split] the offer was answered', {
          correlationId: event.correlationId,
          kind: selection.kind,
          labels: selection.kind === 'selected' ? selection.topics.map((t) => t.label) : [],
        });
      }

      if (selection?.kind === 'declined') {
        // A COMPLETE ANSWER. Clearing it is what stops them being asked the same thing again.
        await clearPendingSplit({
          channelArn: event.channelArn,
          responderId: principalIdFromArn(event.botArn),
          // Whose answer this is, so a declining reply settles their subjects and leaves anybody
          // else's offer standing (ADR-033).
          ...(event.senderArn ? { speakerId: principalIdFromArn(event.senderArn) } : {}),
        }).catch(() => { /* the TTL is the backstop; the cost is being asked once more */ });
      } else if (selection?.kind === 'selected') {
        const outcome = await requestConversationSplit({
          channelArn: event.channelArn,
          responderId: principalIdFromArn(event.botArn),
          botArn: event.botArn,
          // The turn's routing record, so the split speaks in the parent as this assistant and no other.
          correlationId: event.correlationId || '',
          userArn: event.senderArn || '',
          classification: event.classification || '',
          labels: selection.topics.map((topic) => topic.label),
          originatingMessageId: pendingSplit.originatingMessageId,
        });

        // WHAT DID NOT HAPPEN IS SAID. The reply above already told them it was moving these, so
        // silence here leaves them looking for a conversation that was never created. Deployment
        // copy, like every other line this path can add, because the words belong to the
        // deployment and its language rather than to this file.
        // ── THE OFFER IS CLEARED BECAUSE THEY ANSWERED, NOT BECAUSE IT WORKED ────────────────────
        //
        // `conversation-split` clears it on every path IT reaches, including "every chosen subject
        // failed", and says why in its own comment. Three paths never reach it: the function ARN
        // unset, a `FunctionError` (a timeout is one), and a throw on the invoke. All three return
        // refused labels from here, so the offer and `awaitingPerson` survived a person's answer.
        //
        // That is not a stale question, it is a stuck room. `awaitingPerson` is what the claim path
        // reads to let the asked person speak, and with the record's expiry gone nothing else ever
        // removes it - so the conversation stayed answerable only by them, permanently, on a path
        // reached by OUR failure rather than anything they did.
        //
        // Clearing twice is free: it is a REMOVE, and the split Lambda's own clear is idempotent with
        // this one. Not clearing once is not.
        await clearPendingSplit({
          channelArn: event.channelArn,
          responderId: principalIdFromArn(event.botArn),
          ...(event.senderArn ? { speakerId: principalIdFromArn(event.senderArn) } : {}),
        }).catch(() => { /* reported below either way; the next claim path is what this protects */ });

        // THE LINK TO EACH NEW CONVERSATION, POSTED BY THIS ASSISTANT AS PART OF ITS ANSWER. The split speaks
        // as nobody; this turn's session is the assistant, so the line is in its copy (`topicMoved`) and carries
        // the `driftRedirect` the client follows. One message per conversation, because each carries its own
        // link. Best-effort: the conversation exists either way, and a failed post is logged rather than
        // turning a split that worked into one reported as failed.
        for (const created of outcome.created) {
          const link = topicMovedLink(sanitizeTitle(created.label), created.channelArn, versionCopy);
          try {
            await sendInParts(messagingClient, {
              ChannelArn: event.channelArn,
              text: link.content,
              Metadata: JSON.stringify(link.metadata),
              Type: ChannelMessageType.STANDARD,
              Persistence: ChannelMessagePersistenceType.PERSISTENT,
              ChimeBearer: event.botArn,
            });
          } catch (err) {
            console.error('[AsyncProcessor][split] the link to a new conversation was not posted', {
              correlationId: event.correlationId, childChannelArn: created.channelArn, message: (err as Error)?.message,
            });
          }
        }

        if (outcome.refused.length) {
          const refused = templateLine('split-refused', { copy: versionCopy }, { values: { subjects: outcome.refused.join(', ') } });
          response += '\n\n' + refused;
        }
      }
    }

    // SPEC-TASK-STATE-TRANSITIONS §8: task state advances ONLY via the authorized advance_task_state
    // tool inside the loop. The legacy keyword detector runs in SHADOW mode (log-only, to measure the
    // old race rate on real traffic). Side effects that used to hang off the keyword advance are
    // re-keyed to the tool transition below.
    if (taskContext) {
      shadowKeywordTransition(response, taskContext, 'AssistantAsyncProcessor');
      // §7: a task turn that advanced nothing bumps the stall counter (emits task_state_stalled past
      // the threshold). No-op when the tool advanced this turn.
      await recordStallIfNoTransition(taskContext);

      // Preserve the action_item hand-off email (Phase 5b): when the tool advances an action_item to
      // awaiting_completion, and the assignee is someone other than the sender, notify them.
      const reachedAwaitingCompletion =
        event.taskType === 'action_item' &&
        // THIS TURN'S OWN TASK ONLY. A tagged entry belongs to a task the model redirected to
        // (ADR-024 D7), and this notice names `taskContext.task` - so an untagged filter would
        // email somebody about work whose assignee never moved.
        (taskContext.transitions ?? []).some((t) => !t.taskId && t.to === 'awaiting_completion');
      if (reachedAwaitingCompletion) {
        const roster = Array.isArray(event.participants) ? (event.participants as RosterParticipant[]) : [];
        const assignedTemplate = (await selectMessageTemplate({
          classification: CLASSIFICATION, assistant: turnProfileName, name: TASK_NOTICE_TEMPLATES.assigned,
          messages: activeProfile?.messages,
        })).template;
        await postTaskHandoffNotice({
          channelArn: event.channelArn,
          botArn: event.botArn,
          task: taskContext.task,
          roster,
          senderArn: event.senderArn,
          // This assistant's own `task-assigned` template, else the classification's, else the shipped one.
          template: assignedTemplate,
          // Addressed to the assignee, not to the person whose turn this is, so it carries no fact about a person:
          // its resolver-bound fields are read as the room would read them (ADR-060 decision 7).
          resolved: resolverValues(assignedTemplate, { copy: versionCopy }, 'room'),
        });
      }
    }

    // THE ANSWER'S REQUIRED SHAPE, checked before it is delivered (FR21). Only off the task path: a task
    // turn may be a question or an outline, and its delivering step has its own check below. Bounded
    // like that check, and a correction that does not clear the issues keeps the original.
    const shapeChecks = turnIntentDef?.answer?.require?.length && !event.taskId && !bedrockResult.inputGuardBlocked;
    if (shapeChecks) {
      let shapeIssues = answerShapeIssues(turnIntentDef?.answer, response);
      for (let round = 1; shapeIssues.length > 0 && round <= 2; round += 1) {
        console.log('[AssistantAsyncProcessor] answer shape check found issues; correcting', {
          intent: event.intent, round, kinds: shapeIssues.map((i) => i.kind),
        });
        try {
          const corrected = await invokeBedrockWithFallback(
            'You are revising an answer before it is delivered. Return only the revised answer.',
            [{ role: 'user', content: `Revise this answer so it meets every point below, changing nothing else.\n\n${shapeIssues.map((i) => `- ${i.fix}`).join('\n')}\n\n---\n\n${response}` }],
            followOnConfig,
            endedOn.fallbackModelId,
          );
          recordFollowOn('correction-answer', corrected);
          const rewritten = (corrected.response || '').trim();
          const remaining = rewritten ? answerShapeIssues(turnIntentDef?.answer, rewritten) : shapeIssues;
          if (!rewritten || corrected.inputGuardBlocked || remaining.length >= shapeIssues.length) break;
          response = rewritten;
          shapeIssues = remaining;
        } catch (err) {
          console.warn('[AssistantAsyncProcessor] answer shape correction failed (keeping the answer):', err);
          break;
        }
      }
    }

    // THE DOCUMENT AND THE REPLY ARE TWO TEXTS. `documentText` is what a file would carry: the
    // document a task turn declared, or, on the ad-hoc path and a duel's round 1, the reply itself.
    // `replyBesideFile` says which, so the reply beside a declared document posts whole as chat while
    // a reply that IS the file shows only its lede.
    let documentText = '';
    let replyBesideFile = false;
    // THE TEMPLATE THE DECLARED DOCUMENT FOLLOWS, and how the delivery fared against it
    // (SPEC-DOCUMENT-TEMPLATES FR6, FR8). Set only on a task delivery whose step declares a template.
    let deliveryTemplate: DeclaredTemplate | undefined;
    let documentTemplate: DocumentTemplateRecord | undefined;
    let templateCorrected = false;
    // Generate document attachment — on report tasks or explicit user request. Skipped when a
    // generation-out turn already attached an image (attachment is shared; never clobber it).
    if (!attachment && process.env.ATTACHMENTS_BUCKET) {
      let generate;
      // WHICH STATES DELIVER A FILE comes from the MACHINE, not a hardcoded list. Task machines are
      // per-profile configurable (SPEC-CONFIGURABLE-ASSISTANTS 4.5); a `Record<taskType, string[]>`
      // of default-machine state names here could never match a renamed state or a new
      // document-producing task type, so every such deliverable shipped as unattached chat text with
      // only a shadow line as the trace. The merged machines - the same merge the advance tool is
      // authorized against - are the authority, and `delivers` is their declared flag.
      const mergedMachines = turnMachines;
      const taskMachine = event.taskType ? mergedMachines[event.taskType] : undefined;
      const deliveryStates = taskMachine
        ? Object.entries(taskMachine.states).filter(([, d]) => deliversDocument(d)).map(([name]) => name)
        : [];
      if (event.taskType && event.taskId && deliveryStates.length > 0) {
        // THE DELIVERY CONTRACT IS DECLARED, NOT INFERRED (maintainer decision 2026-08-18). The model is
        // told, per state, to advance_task_state when it delivers — the final state is explicit and
        // MEASURED. Attachment therefore keys on a transition the model DECLARED this turn: into a
        // delivering state, or from a delivering state to a terminal (the deliver-and-finish turn).
        // Completion is not decided here at all; it has one door — the machine reaching a terminal
        // state via the model's own advance_task_state (shouldMarkTaskCompleted, invariant AT6:
        // never force-completed mid-flow).
        //
        // The output-shape heuristic (isDeliverableDocument) used to be a second door on BOTH
        // decisions, and it kept failing in a new costume each time: a clarifying question attached as
        // a file, a requirements questionnaire attached as a file, and finally a structured
        // outline-for-approval attached as the report AND completing the task from `drafting_outline`
        // while it was still ASKING — three live incidents patched into one predicate. Its last
        // remnant on the live gate was an English-opener phrase list (solicitsInput) deciding
        // attach-vs-chat, which a non-English deployment defeated in both directions. It survives
        // below in SHADOW MODE only, so the divergence it used to hide is now a number.
        //
        // The failure this trades into is the honest one: a model that delivers without declaring
        // leaves the report as chat text, unattached, task open — visible and recoverable next turn —
        // instead of a question shipped as a deliverable and a falsely closed task, which is invisible.
        // A clarifying question asked from a delivering state declares nothing, so it stays chat.
        const startState = activeTaskInfo?.status;
        // Untagged for the same reason: the delivery states are read from the ACTIVE task's machine,
        // so matching them against a redirected task's transition would package a document for a
        // step that machine never declared. Read through `edgeDelivers`, the same reader the advance
        // tool uses to require the document, so the two cannot disagree about which moves deliver.
        const declaredDelivery = (taskContext?.transitions ?? []).filter((t) => !t.taskId).some((t) =>
          edgeDelivers(taskMachine, t.from, t.to));
        // ── THE FILE IS THE DOCUMENT THE TURN DECLARED, AND NOTHING ELSE ─────────────────────────
        //
        // The reply used to become the file whenever a delivery was declared, and when the final text
        // was short the text written beside the advance was promoted in its place. Measured live: an
        // extraction's first model call advanced into a delivering step and wrote, beside the call, a
        // greeting, a narration of what it was doing, the table and "I can't generate a downloadable
        // file"; the final text was 133 characters, so that whole beside-text became the document.
        //
        // The model now declares the document as an argument (`document` on the advance, or
        // `deliver_document` for a rewrite inside a delivering step), and the gate packages exactly
        // that. The reply is chat. No text is promoted, and nothing about the reply's shape decides.
        //
        // Through the same reasoning-tag strip the reply gets, so scaffolding cannot ship in the file.
        const declaredDocument = stripReasoningTags(taskContext?.declaredDocument || '').trim();
        // IN-STATE REWRITE: a follow-up inside a delivering state ("add a section on churn", asked
        // while the task sits in `generating`/`revising`) re-produces the whole document with no
        // transition to declare. It declares the document instead, so it is as structural as the
        // declared path: a clarifying question asked from a delivering state declares no document and
        // stays chat.
        const inStateRewrite = startState !== undefined
          && deliveryStates.includes(startState)
          && Boolean(declaredDocument);
        documentText = declaredDelivery || inStateRewrite ? declaredDocument : '';
        replyBesideFile = Boolean(documentText);
        // The template rides the declaration that produced the document, resolved by the same advance.
        deliveryTemplate = documentText ? taskContext?.declaredTemplate : undefined;
        // The 400-char floor is a MINIMUM ARTIFACT SIZE, not a return of the shape heuristic: a
        // delivery below it still advances and completes identically, but its content posts as chat
        // text instead of a file - a one-sentence extraction shipped as a downloadable document
        // buries the answer behind a click (measured live: a single-fact codename landed as an
        // attachment nobody asked for). Above the floor, the machine decides.
        generate = documentText.length >= 400;
        // SAID, because a declared delivery that packages nothing should be findable. The advance tool
        // allows this only when the document already went out (finishing from a delivering step after
        // its delivery), so it is the person confirming, not a lost document.
        if (declaredDelivery && !documentText) {
          console.log('[AssistantAsyncProcessor] a delivery was declared with no document this turn; nothing is packaged', {
            taskId: event.taskId, taskType: event.taskType,
          });
        }
        // SHADOW: the retired heuristic, log-only (same treatment as shadowKeywordTransition). A
        // deliverable-shaped reply with NO declared document is the model under-declaring - the case
        // the heuristic existed for - and is measured instead of silently acted on.
        if (!declaredDocument && isDeliverableDocument(response)) {
          console.log('[AssistantAsyncProcessor][shadow] deliverable_shaped_without_declared_state', {
            taskId: event.taskId, taskType: event.taskType, state: startState ?? 'unknown',
          });
        }
      } else {
        // Ad-hoc (no report task): the user explicitly asked to save THIS response as a document.
        // THE INTENT DECIDES, from what was produced (FR20): message, file, or a threshold on the
        // answer. The phrase list below answers only for an intent that declares no form.
        generate = deliverAsFile(turnIntentDef?.answer, response) ?? isDocumentRequest(event.userMessage || '');
        if (generate) documentText = response;
      }

      // In a /battle, round-1 of a report battle produces its deliverable in one shot (there is no
      // multi-step state machine across rounds), so deliver it as a downloadable attachment
      // deterministically, bypassing the state-machine delivery gate. Round-2 is the rebuttal turn.
      // Non-battle multi-step report tasks are unaffected.
      if (!generate
        && event.battleContext?.round === 1
        && event.taskType === 'report_generation') {
        generate = true;
        // THE ROUND-1 REPLY IS THE REPORT. A duel side is answered in one shot and declares no
        // document, so the reply is what is packaged, and its chat is the lede as before.
        documentText = response;
        replyBesideFile = false;
      }

      // A BLOCKED TURN HAS NOTHING TO DELIVER, and this is where that stopped being obvious. The
      // ad-hoc document path keys on the PERSON's words ("give it to me as a downloadable table"), not
      // on what came back, and it carries no artifact floor - so when the guardrail blocked the turn,
      // the 60-character refusal ("I cannot process that request. Please rephrase your message.") was
      // uploaded as the downloadable table they asked for. Measured live: an e2e downloaded it and
      // found a 60-byte document.
      //
      // TWO GUARDS, AND NEITHER READS THE TEXT'S SHAPE. The block-copy recogniser in
      // `async-processor-core` looks made for this, and `guardrail-block-is-not-an-answer.test.ts`
      // pins that this file must NOT call it - a deployment with custom `blockedInputMessaging` never
      // matches the English prefix, so a text-shape test would protect the default deployment and
      // silently fail every other one. The structural fact rides the invoke result instead. (That test
      // asserts on this file's SOURCE, so naming the function even in a comment trips it, which is how
      // this comment came to describe it rather than name it.)
      //
      // The floor is the second guard and the language-neutral one: the ad-hoc path had no minimum at
      // all, while the task path has required 400 characters since the delivery contract landed. A
      // document worth downloading is not 60 bytes in any language, whatever produced it.
      if (generate && bedrockResult.inputGuardBlocked) {
        console.warn('[AssistantAsyncProcessor] guardrail-blocked turn: no document is generated', {
          taskId: event.taskId, taskType: event.taskType,
        });
        generate = false;
      }
      if (generate && documentText.trim().length < 400) {
        console.warn('[AssistantAsyncProcessor] document is below the minimum artifact size; posting inline', {
          taskId: event.taskId, taskType: event.taskType, length: documentText.trim().length,
        });
        generate = false;
      }

      // WRITE, CHECK, CORRECT - then deliver (maintainer, 2026-08-20). The loop has just written a
      // document and is about to hand it over; this is the last point at which it is still ours to
      // fix, and the only point at which the finished text exists.
      //
      // WHY IT IS A CHECK AND NOT A PROMPT LINE. The delivering prompt has told the model not to claim
      // a saved file since this branch's first deploy, and the report that arrived still opened
      // "Here's your report, <name> - delivered as a downloadable markdown document." An instruction
      // the model can ignore is not a control, and the e2e - not the runtime - is what noticed.
      //
      // The length half compares against what the person AGREED to, read from the requirements the
      // step recorded when they confirmed them. Nothing recorded means nothing to enforce.
      //
      // IT ITERATES UNTIL THE DOCUMENT MATCHES, and the person watches it happen. A single silent pass
      // was the first shape and it was wrong in both directions: a document still off after one try was
      // delivered anyway, and the person saw a placeholder sit unchanged through a model call that
      // never announced itself. A report agreed at one length and delivered at another is not the
      // report they agreed to, and the turn is not finished until it matches.
      //
      // BOUNDED, because a loop that cannot end is worse than a document that is slightly long: each
      // pass costs a model call on the most expensive turn the platform runs. When the bound is reached
      // the best version still goes out - the person gets their report, and the shortfall is in the log
      // rather than in a turn that never lands.
      const MAX_CORRECTION_ROUNDS = 3;
      // A PLATFORM-FILLED DOCUMENT IS NOT CORRECTED. It was rendered from the record with no model call
      // (SPEC-DOCUMENT-TEMPLATES FR9), and a correction pass is a model call.
      if (generate && event.taskId && !deliveryTemplate?.filled) {
        // NO PATTERN GUESSES WHICH REQUIREMENT WAS THE LENGTH. The first version searched the recorded
        // requirement NAMES for /length|format|size|pages?|words?/, which fails the moment a machine
        // words its own requirement differently ("how long should it be") - and a machine's `requires`
        // are per-deployment prose, so that was always going to happen. The model marks the size when
        // it records it, so the size arrives as numbers under a known key.
        const target = recordedLengthTarget(taskContext?.task.details);
        // A CODE DELIVERABLE IS CODE WHEREVER IT STARTS, so the opening check does not apply to it. Read
        // from the intent's declared file type, the same declaration that names the file by language.
        // AND THE TEMPLATE'S STRUCTURE, when the step declares one: a miss is one more fault the bounded
        // correction is asked to fix, naming the missing structure (SPEC-DOCUMENT-TEMPLATES FR6).
        const checkOpts = {
          code: turnIntentDef?.answer?.fileType === 'code',
          ...(deliveryTemplate ? { template: deliveryTemplate.loaded.template } : {}),
        };
        let issues = deliverableIssues(documentText, target, checkOpts);
        const templateMissedAtFirst = issues.some((i) => i.kind === 'template_structure');
        if (issues.length > 0) {
          console.log('[AssistantAsyncProcessor] deliverable check found issues; correcting', {
            taskId: event.taskId,
            kinds: issues.map((i) => i.kind),
            words: documentWordCount(documentText),
            agreed: target ? `${target.minWords}-${target.maxWords} (${target.source})` : 'not recorded',
          });
        }
        for (let round = 1; issues.length > 0 && round <= MAX_CORRECTION_ROUNDS; round += 1) {
          try {
            // THE PLACEHOLDER SAYS WHAT IS HAPPENING. `interim` deliberately, never `final`: this
            // update must not close the turn or freeze the completion instant - the answer has not
            // been delivered yet. Best-effort, because failing to narrate is not a reason to stop
            // fixing.
            if (messageId) {
              await updateMessage(
                event.channelArn, messageId, correctionProgressLine(issues, target), event.botArn, 'progress',
              ).catch((err: unknown) => console.warn('[AssistantAsyncProcessor] progress update failed:', err));
            }
            // The SAME resilient path every other model call here takes, so a corrective turn degrades
            // to the fallback model rather than throwing away a document over a throttle.
            // THE TURN'S OWN RESOLVED CONFIG, not the profile default. `CONFIG.model` is a bare model
            // id, and this deployment's premium model has no on-demand throughput under one: the call
            // failed with "Invocation of model ID ... with on-demand throughput isn't supported. Retry
            // with the ID or ARN of an inference profile". `followOnConfig` is the turn's config on the
            // model the turn ended on (the delivering step's, where the task entered it mid-turn), so the
            // correction runs on that model, with its fallback, and cannot drift from the turn it corrects.
            const corrected = await invokeBedrockWithFallback(
              'You are editing a document that is about to be delivered. Return only the corrected '
                + 'document.',
              [{ role: 'user', content: correctionInstruction(issues, documentText) }],
              followOnConfig,
              endedOn.fallbackModelId,
            );
            recordFollowOn('correction-deliverable', corrected);
            const rewritten = (corrected.response || '').trim();
            const remaining = rewritten ? deliverableIssues(rewritten, target, checkOpts) : issues;
            const verdict = acceptCorrection({
              original: documentText,
              rewritten,
              issuesBefore: issues,
              issuesAfter: remaining,
              target,
              blocked: corrected.inputGuardBlocked,
            });
            if (verdict.accept) {
              console.log('[AssistantAsyncProcessor] deliverable corrected', {
                taskId: event.taskId,
                round,
                before: issues.map((i) => i.kind),
                after: remaining.map((i) => i.kind),
                detail: verdict.reason,
              });
              documentText = rewritten;
              issues = remaining;
            } else {
              // A REJECTED REWRITE ENDS THE LOOP rather than feeding it. The rejections are a blocked
              // corrective turn, an empty answer, and one that gutted the document - none of which
              // another identical pass would fix, and each retry is a model call.
              console.warn('[AssistantAsyncProcessor] correction rejected; keeping the best version', {
                taskId: event.taskId, round, reason: verdict.reason, remaining: remaining.map((i) => i.kind),
              });
              break;
            }
          } catch (err) {
            console.warn('[AssistantAsyncProcessor] deliverable correction failed (keeping the best version):', err);
            break;
          }
        }
        templateCorrected = templateMissedAtFirst && !issues.some((i) => i.kind === 'template_structure');
        const stillFailing = stillFailingPackaging(issues, replyBesideFile);
        if (stillFailing === 'template_structure') {
          // A DOCUMENT THAT STILL DOES NOT FOLLOW ITS TEMPLATE IS NOT ATTACHED (SPEC-DOCUMENT-TEMPLATES
          // FR6). A file of this kind is one readers scan for its sections; posted inline, it is read in
          // the conversation, and the next turn can produce the file in the declared shape.
          console.warn('[AssistantAsyncProcessor] the document still does not follow its template; posting it inline', {
            taskId: event.taskId, template: deliveryTemplate?.loaded.name, remaining: issues.map((i) => i.kind),
          });
          generate = false;
        } else if (stillFailing === 'purity') {
          // A DECLARED DOCUMENT THAT STILL READS AS CONVERSATION IS NOT PACKAGED. A file is read later
          // by somebody outside the conversation, and one that opens with a sentence to the person who
          // asked is not the document they asked for. Posted inline it is at least read in the
          // conversation it was written for, and the next turn can produce the file.
          //
          // Only a DECLARED document. Where the reply itself is the file (a duel's round 1, the ad-hoc
          // document), there is no separate reply to post it beside, and withholding the file would
          // take away the one deliverable that path has.
          console.warn('[AssistantAsyncProcessor] the document still does not open as a document; posting it inline', {
            taskId: event.taskId, remaining: issues.map((i) => i.kind),
          });
          generate = false;
        } else if (stillFailing === 'mismatch') {
          // VISIBLE, not silent. The document goes out because a report the person can read beats a
          // turn that never lands, but a delivery that did not meet what was agreed is a fact somebody
          // should be able to find afterwards.
          console.warn('[AssistantAsyncProcessor] delivering a document that still does not match', {
            taskId: event.taskId,
            remaining: issues.map((i) => i.kind),
            words: documentWordCount(documentText),
            agreed: target ? `${target.minWords}-${target.maxWords} (${target.source})` : 'not recorded',
          });
        }
        // THE ENGLISH PHRASE CHECKS, MEASURED AND NEVER ACTED ON (tenet D11). How often a declared
        // document still carries a greeting, an ask or a file claim is worth knowing; deciding from
        // English a model wrote is not.
        const phraseKinds = phraseShadowKinds(documentText);
        if (phraseKinds.length > 0) {
          console.log('[AssistantAsyncProcessor][shadow] deliverable_phrase_check', {
            taskId: event.taskId, taskType: event.taskType, kinds: phraseKinds, packaged: generate,
          });
        }
      }

      // A DECLARED DOCUMENT THAT IS NOT PACKAGED STILL REACHES THE PERSON. Below the minimum artifact
      // size, or still reading as conversation after correction, it posts inline after the reply, so
      // the work the turn did is never lost between the two texts.
      // WHAT THE TEMPLATE CHECK CAME TO, decided now that the packaging is (SPEC-DOCUMENT-TEMPLATES FR8):
      // attached as written, attached after the correction, posted inline, or filled by the platform.
      // The heading-text agreement rides along as a measurement only (tenet D11).
      if (deliveryTemplate && documentText) {
        const check = deliveryTemplate.filled ? null : checkAgainstTemplate(documentText, deliveryTemplate.loaded.template);
        documentTemplate = {
          name: deliveryTemplate.loaded.name,
          contentHash: deliveryTemplate.loaded.contentHash,
          outcome: templateCheckOutcome({ filled: Boolean(deliveryTemplate.filled), attached: generate, corrected: templateCorrected }),
          ...(deliveryTemplate.chosen ? { chosen: true as const } : {}),
          ...(typeof check?.headingTextAgreement === 'number' ? { headingTextAgreement: check.headingTextAgreement } : {}),
        };
        console.log('[AssistantAsyncProcessor][shadow] template_heading_text', {
          taskId: event.taskId, template: documentTemplate.name, outcome: documentTemplate.outcome,
          headingTextAgreement: documentTemplate.headingTextAgreement ?? null,
        });
      }

      if (!generate && replyBesideFile && documentText) {
        response = postInline(response, documentText);
        replyBesideFile = false;
        // A document posted inline is still a hand-over the task should know about, with the template and
        // the result where the step declares one, so the record says which version it was held to. It is
        // also what holds an idle assistant from writing the step's document again (ADR-063 `pickupReadiness`).
        if (event.taskId) {
          await recordTaskDelivery(event.taskId, event.channelArn, {
            name: 'posted inline',
            at: new Date().toISOString(),
            fromState: taskContext?.task.taskState,
            ...(documentTemplate ? { template: documentTemplate } : {}),
          });
        }
      }

      if (generate) {
        try {
          // A code answer with one fenced block is that code, named by its language; anything else is the
          // Markdown answer (`fileForAnswer`).
          attachment = await generateAndUploadDocument(
            documentText, event.channelArn, event.taskType || 'document', process.env.ATTACHMENTS_BUCKET,
            fileForAnswer(turnIntentDef?.answer, documentText),
          );
          console.log('[AssistantAsyncProcessor] Document generated:', attachment.fileKey);
          // WHAT EVALUATION GRADES THE DOCUMENT AGAINST, taken now: the state is the one it was
          // delivered from (the close below moves it), and the requirements are the ones the task
          // recorded before the document was written.
          deliveredDocument = deliveredDocumentReference({
            attachment,
            intent: event.intent,
            taskId: event.taskId,
            taskType: event.taskType,
            fromState: taskContext?.task.taskState,
            taskDetails: taskContext?.task.details as Record<string, unknown> | undefined,
            taskPrivate: isPrivateVisibility(taskContext?.task.visibility),
            ...(documentTemplate ? { template: documentTemplate } : {}),
          });
          // REMEMBER THAT IT WENT OUT, so the next turn knows this task has already handed something
          // over. Without it a turn knows everything about the document it is writing and nothing
          // about the one it wrote last time - which is how an assistant asked "is this task
          // complete?" answered by starting the report again instead of looking at the one it had
          // already delivered.
          //
          // A record, not a trigger: completion still happens only when the model advances the machine.
          if (event.taskId) {
            await recordTaskDelivery(event.taskId, event.channelArn, {
              name: attachment.name || attachment.fileKey,
              at: new Date().toISOString(),
              fromState: taskContext?.task.taskState,
              ...(documentTemplate ? { template: documentTemplate } : {}),
            });

            // AND THE DELIVERY CLOSES IT (owner: "if the report is delivered it is complete unless the
            // user objects with additional changes required").
            //
            // This is the point the delivery is a FACT rather than an intention - the document exists
            // and is attached. Telling the model to advance here was tried first and is still in the
            // prompt, because a model that closes its own task is the better outcome; it did not
            // happen. Every recent report sat `in_progress` in `generating`, delivered and never
            // advanced. The instruction stays and the fact is now enough on its own.
            //
            // `terminalStateAfterDelivery` is why this is not the walker that was removed: it reads the
            // machine's declaration, refuses anything that awaits a person, and takes a single declared
            // edge only when the machine names one way to finish. A change request reopens the task by
            // the ordinary route - the person asks, and the model advances to revising.
            const closesOnDelivery = terminalStateAfterDelivery(
              event.taskType ?? taskContext?.task.taskType,
              taskContext?.task.taskState,
              turnMachines,
            );
            if (taskContext?.task && closesOnDelivery) {
              const advanced = await advanceTaskStateTo({
                task: taskContext.task,
                toState: closesOnDelivery,
                by: 'system',
                reason: 'the delivering step delivered its deliverable',
                machines: turnMachines,
                assistantId: principalIdFromArn(event.botArn),
              }).catch((err: unknown) => {
                console.warn('[AssistantAsyncProcessor] closing a delivered task threw (non-fatal):', err);
                return { ok: false as const, error: 'threw' };
              });
              console.log('[AssistantAsyncProcessor] delivered step close', {
                taskId: event.taskId,
                to: closesOnDelivery,
                ok: advanced.ok,
                ...(advanced.ok ? {} : { error: (advanced as { error?: string }).error }),
              });
              if (advanced.ok) taskContext.task.taskState = closesOnDelivery;
            }
          }
        } catch (docError) {
          console.error('[AssistantAsyncProcessor] Document generation failed:', docError);
        }
      }

      // No completion here. The auto-complete-on-delivery door (advanceDeliveredTaskToCompletion,
      // gated on the output-shape heuristic) is REMOVED: it completed a task from `drafting_outline`
      // while the reply was still asking for outline approval, against invariant AT6. Completion has
      // one path — the model's advance_task_state reaching the machine's terminal state — so the
      // final state is explicit and measured, never inferred from what the reply looked like.
    }

    // THE ANSWER IS READY. If the placeholder was not resolved at dispatch, resolve it now.
    //
    // This is the only place the channel is scanned, and it runs only when the mapping never appeared.
    // `ListChannelMessages` is a billed call, so the happy path must not pay for it: the mapping the
    // channel flow writes resolves virtually every turn, and this line is never reached on those.
    //
    // Deferring it to here also makes it far likelier to succeed - the placeholder has had the entire
    // inference window to be created, whereas the old up-front loop was racing Chime and burned up to
    // 22 seconds before the model was even called.
    // ── A READING OWNS NO PLACEHOLDER, AND MUST NOT BE REFUSED FOR IT ────────
    //
    // While a queue is being read there is ONE thing showing progress and it is the notice, so the
    // router stays silent for a reading and no placeholder is ever created for its correlation id.
    // The reading posts its own message at delivery time instead - `finalizePlaceholderResponse`,
    // "A READING OWNS NO PLACEHOLDER, SO ITS PROPOSAL IS POSTED FRESH".
    //
    // This guard was written when every turn had a placeholder, so for a reading it turned the
    // expected absence into a refusal and returned BEFORE the code that posts the message. Observed
    // live 2026-09-09 in two conversations minutes apart: "No placeholder for correlationId after
    // the answer was ready: arrival-2e8530c4...-4 - the reply cannot be delivered", and with it the
    // whole drain. The queue stayed at five, the deferral notice kept promising to read messages
    // that were never read, and the next turn handed over to another reading that died the same way.
    //
    // So the scan is skipped too. It is a billed `ListChannelMessages` that searches for a marker
    // nobody wrote, and it can only ever come back empty.
    const readingOwnsNoPlaceholder = !!event.triage;
    let deliverMessageId = messageId;
    // What the billed scan below cost, when one ran. Stays undefined on every turn that did not scan,
    // which is what keeps COUNT(poll_ms) a rate and AVG(poll_ms) the cost of one - a zero here would
    // put the mean in the gap between two populations.
    let deliveryScanMs: number | undefined;
    if (!deliverMessageId && !readingOwnsNoPlaceholder) {
      // READ THE MAPPING FIRST. This path went straight to the scan, which was right while the turn
      // always arrived here with the id already resolved - nothing before inference waits for the
      // placeholder any more, so for a Lex turn `messageId` is legitimately null at this point and
      // the mapping is the cheap answer. It was written during the model call, thousands of
      // milliseconds ago.
      //
      // Skipping this read would trade a DynamoDB point read for a BILLED `ListChannelMessages` on
      // every Lex turn - the same information, at a cost, from a system that has to search for it.
      deliverMessageId = await resolveDeliveryMessageId(event.correlationId, event.placeholderMessageId);
    }
    // ── THE SCAN IS MEASURED HERE, AND FOR A WHILE IT WAS NOT MEASURED ANYWHERE ──
    //
    // `poll_ms` means "the handoff did not supply a target, so a billed ListChannelMessages ran", and
    // `poll_fallback_count` is the rate that sits on a hard floor of zero - the shape that makes an
    // alert on it mean one thing.
    //
    // The pre-inference wait was removed on 2026-09-22, correctly: it timed a placeholder that was not
    // needed yet, in front of the work everyone is waiting for. But it was also the only thing that
    // ever wrote `pollMs`, so removing it left the DELIVERY-side scan below - which still runs -
    // recording nothing. `async-processor-core` states the intended end state, that pollMs "is now
    // only ever written by the delivery-side path", and nothing implemented it.
    //
    // WHY THAT IS WORSE THAN NO METRIC. The column kept returning rows from before the change, so the
    // console showed a live-looking scan rate that no longer described anything, and it would have
    // decayed toward zero as the 90-day window rolled - reading as an optimisation landing rather than
    // as a measurement going blind. Found by reading the live figure and failing to trace it to code.
    //
    // MEASURED WHETHER OR NOT IT FINDS ANYTHING. A scan that comes back empty was still bought and
    // still cost the person the wait; recording only the successful ones would report the cheap half
    // of the population.
    if (!deliverMessageId && !readingOwnsNoPlaceholder) {
      const scanStart = Date.now();
      deliverMessageId = await scanForPlaceholderMessage(
        event.channelArn,
        event.correlationId,
        event.botArn,
      );
      deliveryScanMs = Date.now() - scanStart;
      console.log('[AssistantAsyncProcessor] Deferred placeholder resolution', {
        correlationId: event.correlationId,
        resolved: !!deliverMessageId,
        messageId: deliverMessageId ?? undefined,
        scanMs: deliveryScanMs,
      });
    }

    if (!deliverMessageId && !readingOwnsNoPlaceholder) {
      // ── NO PLACEHOLDER: THE ANSWER IS POSTED AS A NEW MESSAGE, BY THIS ASSISTANT ──
      //
      // The router could not post one (a send that failed), so nothing will ever be updated in place. The
      // answer was already paid for, and this turn's session IS the assistant, so it posts the message
      // itself rather than discarding the answer. The rest of delivery then runs against the new message as
      // it would against a placeholder, so a duel side still records its terminal state and round 2 can
      // fire. No correlation marker: none was ever claimed, so there is nothing for the flow to match.
      //
      // Only if that send also fails is the turn lost, and then it is RECORDED for the person's own client
      // (`reply_undeliverable`), never left as silence.
      try {
        const posted = await sendChannelMessage(messagingClient, {
          ChannelArn: event.channelArn,
          // The answer's FIRST PART: delivery below updates this message and posts the rest as its continuations, as it
          // does for a placeholder (`handleLongResponse`), so a long answer is never refused here whole.
          Content: encodeURIComponent(splitIntoChunks(response)[0]),
          Type: ChannelMessageType.STANDARD,
          Persistence: ChannelMessagePersistenceType.PERSISTENT,
          ChimeBearer: event.botArn,
          Metadata: JSON.stringify({ botResponse: true, respPhase: 'interim' }),
        });
        deliverMessageId = posted.MessageId ?? null;
        console.warn('[AssistantAsyncProcessor] no placeholder; the answer was posted as a new message', {
          correlationId: event.correlationId, messageId: deliverMessageId,
        });
      } catch (err) {
        console.error('[AssistantAsyncProcessor] no placeholder, and the answer could not be posted either', {
          correlationId: event.correlationId, message: (err as Error)?.message,
        });
      }
      if (!deliverMessageId) {
        await recordDispatchFailure({
          channelArn: event.channelArn,
          senderSub: personIdFromArn(event.senderArn) || '',
          responderId: botIdFromArn(event.botArn) || '',
          reason: 'reply_undeliverable',
        }).catch(() => false);
        if (event.taskId) {
          await updateTaskStatus(event.taskId, event.channelArn, 'failed', undefined, noticeLine(turnCopy, 'answerUndelivered'))
            .catch((e) => console.error('[AssistantAsyncProcessor] task status update failed:', e));
        }
        return;
      }
    }

    // ── THE FILE THAT WAS NOT READ ──────────────────────────────────────────
    //
    // Said ABOVE the answer, not under it: the person needs to know what the reply is missing before
    // they read it, otherwise they read a confident answer about a document nothing opened. Said only
    // by the turn that carried the file - a historical one is skipped in silence
    // (`resolveHistoryImageBlocks`), so nobody is apologized to on every subsequent turn.
    if (attachmentTooLarge) {
      response = `${attachmentTooLargeLine({
        name: attachmentTooLargeName,
        copy: versionCopy,
      })}\n\n${response}`;
    }

    // ── WHICH REFERENCE TO TYPE, UNDER A QUESTION ABOUT ONE OF SEVERAL ITEMS (ADR-035) ──────────
    //
    // Read from the state the turn ENDED in: only a turn that left its item waiting on the person asked
    // them something. Not on a reading or a duel side, whose replies are not about one item.
    if (taskContext?.task && !event.triage && !event.battleContext) {
      try {
        const ended = taskContext.task;
        const hint = taskRefHintLine({
          taskRef: ended.taskRef,
          awaitsPerson: Boolean(ended.taskState
            && awaitedPartyOf(taskContext.machines?.[ended.taskType ?? '']?.states?.[ended.taskState])),
          openItemCount: event.openItemCount,
          response,
          copy: versionCopy,
          // The client already said which item this is, so there is no syntax to teach.
          namedByClient: event.taskResolution === 'id',
        });
        if (hint) response = `${response}\n\n${hint}`;
      } catch (err) {
        console.warn('[AssistantAsyncProcessor] reference hint failed (non-fatal):', err);
      }
    }

    // ── AND THE ITEM SAYS WHETHER IT IS FINISHED, WHATEVER THE REPLY SAID ────────────────────────
    //
    // Measured live: an item was reported to the person as closed twice while its row sat one step
    // short of terminal. The tool answered truthfully both times, and the turn that believed it had
    // finished the work is exactly the turn that will not correct itself - so the prompt and the
    // tool's `finished` field are mitigations, and this is the guarantee.
    //
    // DECIDED FROM THE TRANSITION THAT WAS WRITTEN, never from the words of the reply. It fires on
    // the fact, so no phrasing can duck it and it makes no claim about what the reply said. Reading
    // the reply for "closed" would be the output-shape heuristic this codebase has retired twice.
    //
    // ONLY WHEN THIS TURN ADVANCED SOMETHING. A conversational turn adds nothing, and a turn that
    // reached a terminal state adds nothing either, because then the work really is done.
    //
    // AND ONLY WHEN IT ADVANCED *THIS* ITEM. A transition carries `taskId` when the model redirected
    // and moved a DIFFERENT item (`async-processor-core.ts:2587`); that path updates only the target's
    // state and leaves `taskContext.task` exactly as it was read. Counting those made a redirected
    // turn report the active item's stale state as though this turn had just moved it - the same
    // "claimed something that did not happen" this line exists to prevent, pointing at a second item.
    // The three other readers of `transitions` already filter the same way (`:2327`, `:2361`,
    // `async-processor-core.ts:4419`); this one did not, and a code review caught it.
    const advancedThisTask = taskContext?.transitions?.some((t) => !t.taskId) ?? false;
    if (taskContext?.task && advancedThisTask && !event.triage && !event.battleContext) {
      try {
        const landed = taskContext.task;
        const step = landed.taskState
          ? taskContext.machines?.[landed.taskType ?? '']?.states?.[landed.taskState]
          : undefined;
        const stillOpen = taskStillOpenLine({
          advanced: true,
          ...(landed.taskState ? { state: landed.taskState } : {}),
          ...(step?.transitions ? { nextStates: step.transitions } : {}),
          ...(step?.terminal ? { terminal: step.terminal } : {}),
          copy: versionCopy,
        });
        if (stillOpen) response = `${response}\n\n${stillOpen}`;
      } catch (err) {
        console.warn('[AssistantAsyncProcessor] still-open line failed (non-fatal):', err);
      }
    }

    // Finalize response
    // THE ID OF THE MESSAGE THIS TURN ANSWERS IS SETTLED BEFORE FINALIZE, which may park or fold this
    // turn and carries the event forward. It was started at entry and is normally long done by now.
    await holderRecorded;
    redispatchedPass = (await finalizePlaceholderResponse({
      event,
      response,
      // THE CLASSIFICATION THIS ASSISTANT IS ASSIGNED - a BOUNDARY, carried as itself. Not the
      // profile name, which is a different question that happens to share a value on the default
      // config: a deployment may point a classification at a differently-named profile and the two
      // strings come apart. A classification must not move because a persona was edited.
      servingClassification: CLASSIFICATION,
      // WHICH ASSISTANT ANSWERED, which is a different fact and now carried as one. `agent_type` in
      // analytics is the responder's identity, and it was being fed the classification above - so two
      // assistants in one classification would have been one row, and the "scope to this assistant"
      // filter separated nothing. This is the `/assistant/{name}` segment: the same
      // identifier the profile store, the assignment record and the version history are keyed by.
      // FROM THE ASSIGNMENT, because the env is one value per function. `PROFILE_NAME` is the
      // classification's seeded assistant, and a classification hosting a second role serves both from
      // one runtime - so every ops turn was archived as `advisor`, which is the dimension the console's
      // "scope to this assistant" filter reads. Measured: no `ops-premium` row existed after the ops
      // assistant had answered, and the turns were attributed to the primary instead.
      // THE SAME NAME THE BEHAVIOR CAME FROM, so a duel's challenger is archived as the alt that answered
      // (`alt-{role}-{classification}`, ADR-050) and the two can never disagree about who answered.
      servingAssistant: turnProfileName,
      // A runtime assistant's classification, for archival's boundary check (ADR-048). The vend admitted
      // it from this classification's records, so it is this function's own.
      ...(turnAssistantIsRuntime && { servingRuntimeClassification: CLASSIFICATION }),
      // WHICH ROLE IT HOLDS. From the assignment for the same reason: the env holds the role this function
      // was stamped with, which is the primary's, so a second role's turns would report the first's and
      // the role filter would separate nothing.
      servingRole: turnAssistantRole || ASSISTANT_ROLE,
      // The same resolved copy the loop got. `finalizePlaceholderResponse` speaks several lines of
      // its own - the derived-reading note, the unreadable-queue note, the private-handling line -
      // and each read the variant profile directly, so each was English on every ordinary turn.
      copy: versionCopy,
      ...(bedrockResult.reading ? { reading: bedrockResult.reading } : {}),
      model: bedrockResult.modelUsed,
      inputTokens: bedrockResult.inputTokens,
      outputTokens: bedrockResult.outputTokens,
      bedrockTime: bedrockResult.bedrockTime,
      // Empty for a reading, which is how `finalizePlaceholderResponse` knows to post its own
      // message rather than write into one. Every other turn resolved one above or returned.
      messageId: deliverMessageId || '',
      // NEW WORK IS NOT NEXT WORK (maintainer, 2026-09-01): the proposal shows where the arrivals fall
      // against this, not a fresh list of its own.
      ...(openWorkHere.length ? { openWork: openWorkHere } : {}),
      guardMs,
      // The mapping read plus the scan, which is what LOCATING the placeholder cost in total. The
      // pipeline measured the pre-inference half; the scan below is the other half and is added here
      // so the superset stays a superset of `pollMs` rather than excluding the expensive case.
      placeholderResolveMs: deliveryScanMs !== undefined
        ? (placeholderResolveMs ?? 0) + deliveryScanMs
        : placeholderResolveMs,
      // The scan alone. `pollMs` from the pipeline is always undefined since the pre-inference wait
      // was removed, so this is now the column's only writer - the end state its comment describes.
      pollMs: deliveryScanMs ?? pollMs,
      conversationHistoryLength: consolidatedHistory.length,
      startTime,
      // Whether this container had to initialize first (G9). Travels with the turn's other timings
      // rather than being logged, because the question it answers - "is this slow TTFF a cold start
      // or a regression?" - is asked of the dashboard, not of CloudWatch.
      coldStart,
      // THE STATE THE TURN ENDED IN, not the one it started in. `activeTaskInfo` is stamped before the
      // model runs, because the same object grounds the prompt - but it is also what becomes the
      // `<!--ACTIVE_TASK:-->` marker the chat client renders as a status chip. Left as stamped, the
      // chip is always ONE TURN BEHIND: it reads "Drafting outline" while the report is being
      // generated, and still reads "Generating report" after the document has been delivered, as
      // measured in the live app. The tool loop has since moved `taskContext.task.taskState`, so the
      // chip is rebuilt from it here.
      activeTaskInfo: activeTaskInfo && taskContext
        ? {
          ...activeTaskInfo,
          status: taskContext.task.taskState || activeTaskInfo.status,
          label: getTaskLabel(
            activeTaskInfo.type,
            taskContext.task.taskState || '',
            taskContext.machines,
          ),
        }
        : activeTaskInfo,
      taskContext,
      attachment,
      ...(deliveredDocument ? { deliveredDocument } : {}),
      ...(documentTemplate ? { documentTemplate } : {}),
      // The file carries a declared document, so the reply beside it posts whole as chat.
      ...(attachment && replyBesideFile ? { replyBesideAttachment: true } : {}),
      // The structural block fact, never inferred from the reply's text shape.
      guardrailBlocked: bedrockResult.inputGuardBlocked,
      // WHICH POLICIES INTERVENED, input and output together. The input half rides the bedrock result
      // (it is decided inside the resilience wrapper); the output half is read from the module the
      // output guardrail just ran in. Deduped, because a policy can fire on both sides of one turn.
      guardrailFindings: [...new Set([
        ...(bedrockResult.guardrailFindings ?? []),
        ...takeOutputGuardrailFindings(),
      ])],
      wasFallback: bedrockResult.wasFallback,
      fallbackReason: bedrockResult.fallbackReason,
      retryCount: bedrockResult.retryCount,
      configIdentity,
      // Attribute this turn to the exact assistant/profile + version that served it (SPEC-ASSISTANT-CONFIG §4)
      // — not just its classification. `active.configId` is the portable-profile VERSION fingerprint.
      // WHICH VERSION ANSWERED. `profileVersion` was declared on the metadata, rendered in the
      // console's L1 view and written by nothing on the live path - only the manual backfill tool -
      // so "which version produced this" was blank on every real turn. The resolver keeps the SSM
      // parameter version now, which is the number the Profiles tab lists and rolls back to.
      //
      // THE NAME COMES FROM THE DEFINITION THAT SERVED, not from this Lambda's own. A `profileRef`
      // variant is a version of some assistant's profile, and on a duel it can be a version of an
      // assistant OTHER than the one whose assignment is running it. `configId` and `profileVersion` were
      // already the variant's; only the name was this processor's module constant - so the row read
      // "advisor, version 7" for a configId that belongs to no version of advisor, and an attribution
      // whose three fields do not describe one artifact cannot be joined back to anything.
      //
      // DELIBERATELY NOT THE SAME QUESTION AS `servingAssistant` ABOVE. That one names the ASSISTANT that
      // answered, which is what `agent_type` groups by; this one names the DEFINITION it served. They
      // are the same string on every ordinary turn and come apart exactly on a cross-assistant
      // variant, which is the case worth being able to see rather than the one to paper over.
      profileAttribution: {
        // The assistant's profile on an ordinary turn, the one `active` was resolved from: `PROFILE_NAME`
        // is the classification primary's, so it would name `advisor` for an `ops-premium` version.
        profileName: event.variantProfile?.profileName || turnProfileName,
        profileConfigId: active.configId,
        ...(active.version !== undefined && { profileVersion: active.version }),
      },
      modelChoice,
      ...(battleImageCount != null && { imageCount: battleImageCount }),
      ...(battleSelfDisplayName && { battleSelfDisplayName }),
      steps: followOnSteps.length ? [...(bedrockResult.steps ?? []), ...followOnSteps] : bedrockResult.steps,
      modelMs: bedrockResult.modelMs,
      toolMs: bedrockResult.toolMs,
      // What each tool call asked for and got back, and the tools the turn held (SPEC-EVALUATION C3).
      ...(bedrockResult.toolCalls?.length ? { toolCalls: bedrockResult.toolCalls } : {}),
      ...(bedrockResult.toolsOffered?.length ? { toolsOffered: bedrockResult.toolsOffered } : {}),
      // WHAT THIS TURN WAS GIVEN TO ANSWER FROM. Persisted so groundedness can be judged in batch
      // later: the passages built the prompt and were then discarded, so nothing downstream could
      // recompute what the turn had actually seen, and the one question a retrieval system is
      // normally judged on could not be asked at all.
      ...(grounding.retrievedContext?.chunks?.length ? {
        retrievedPassages: grounding.retrievedContext.chunks.map((c) => ({
          sourceId: c.sourceId,
          title: c.title ?? c.sourceId,
          content: c.content,
          // Which retrieval leg found it (vector, lexical, or both), so a judged answer can be traced to
          // the ranking that put the passage in front of the model.
          ...(c.foundBy?.length ? { foundBy: c.foundBy } : {}),
        })),
      } : {}),
    })).redispatched;

    // Seed the conversation summary from THIS exchange, on the same first turn that names the
    // conversation. Drift compares against the summary, so without a turn-one anchor it cannot fire
    // at all until the scheduled summariser catches up - every early turn skips with
    // `drift_skipped_no_summary`, which is precisely the window where a user is most likely to
    // pivot. The exchange is passed straight from memory: reading it back from Aurora would wait on
    // the Kinesis + archival lag this exists to remove. Awaited for the same reason as the rename
    // below (the environment freezes on resolve); the actual summarization runs asynchronously.
    // ── EARLY, NOT FIRST, FOR THE SAME REASON THE RENAME CHANGED ──────────────────────────────
    //
    // This was gated on `isFirstUserTurn`, which is derived from channel history at processor time
    // and which a queued burst makes false before any turn runs: the anchor was then never written,
    // and drift cannot fire at all without one - every early turn skips with
    // `drift_skipped_no_summary`, which is precisely the window a person is most likely to pivot in.
    //
    // Safe to ask more than once, and this does not weaken the once-per-conversation rule: the
    // data plane holds it. `seedSummaryFromExchange` selects from `conversation_summaries` first and
    // returns `already-summarised`, and its insert is `ON CONFLICT DO NOTHING` so even a race
    // between two turns writes one row. The guard was always there; the caller was asking the wrong
    // question in front of it.
    if (pipeline.earlyInConversation && event.channelArn && event.userMessage && response) {
      await seedConversationSummary({
        channelArn: event.channelArn,
        userMessage: event.userMessage,
        assistantReply: response,
      });
    }

    // Reply is posted; now let the first-turn title rename finish before the Lambda execution
    // environment freezes (see runSharedPipeline). Awaiting here adds no user-facing latency (this is
    // an Event invoke with no caller waiting) but guarantees the UpdateChannel lands.
    if (pipeline.titleRename) {
      try {
        await pipeline.titleRename;
      } catch {
        /* best-effort rename; never fail the turn on it */
      }
    }
  } catch (error) {
    await handleProcessingError(event, error, turnCopy);
  } finally {
    try {
      // WHAT THIS TURN IS ANSWERING, SETTLED FIRST. Before the release below, because the write is
      // conditional on this turn still being the holder and the release is what stops it being one.
      // It never rejects - `recordWhatThisTurnIsAnswering` catches its own - so this cannot become the
      // reason a lock goes unreleased.
      await holderRecorded;
      // ── RELEASE, ON EVERY EXIT (ADR-033) ──────────────────────────────────────────────────────
      //
      // A `finally`, not a line at the end of the happy path. This handler returns early in several
      // places - a placeholder it could not find, a duel side parked waiting on the person - and it
      // catches its own errors above. Every one of those is a turn that has stopped running, and a
      // lock that survives any of them strands the conversation until a later message takes over the stale holder, which is exactly the
      // failure tenet 2 exists to prevent. The release is conditional on still being the holder, so a
      // turn already displaced as dead cannot clear the queue of the turn that displaced it.
      //
      // Inert when the feature is off: `releaseTurn` returns an empty drain without touching DynamoDB.
      // -- THE DRAIN IS GONE FROM HERE (ADR-033) ------------------------------------------------
      //
      // Triage used to run at this point, when the turn ENDED. That made the question the design
      // exists to ask - whether the work in flight is still wanted - a question about a report that
      // had already finished. An interrupt evaluated after the work completes is not an interrupt.
      //
      // It now runs on message ARRIVAL, in post-processing (see lib/triage-on-arrival.ts), where the
      // work it asks about is genuinely still in flight. This turn therefore only releases the lock.
      //
      // ONE OWNER, deliberately. A drain left here as well would have two components reading the
      // same queue: a message triaged twice becomes work somebody has to close by hand, and a queue
      // cleared by whichever ran second loses whatever the first had not finished with.
      //
      // The handover below is not a second owner. It reads nothing this turn interprets and clears
      // nothing: it dispatches the SAME arrival-triage path, under the SAME `claimTriage`, for a queue
      // that path could not reach. One reader still, reached from a second trigger.
      // -- THE LOCK STANDS UNTIL THE QUEUE IS EMPTY, NOT UNTIL THIS TURN FINISHES ----------------
      //
      // Arrival triage takes `claimTriage` so two notices cannot create the same work twice, which
      // means a message landing while it runs finds the claim held and returns. Nothing comes back for
      // that message: it stays queued, is shown to the person as waiting, and waits forever.
      //
      // This is the last moment anything holds the conversation, so it is where that is caught. If
      // something is still queued the lock is HANDED to the triage turn that will read it rather than
      // released - one conditional write, no instant at which the conversation is free for a new turn
      // to start alongside the backlog being triaged. Someone who keeps typing keeps meeting a lock.
      // SHORT-CIRCUIT WHEN A PASS IS STILL READING. Not merely an optimization: calling the handover
      // here would find the queue still populated (the pass that clears it has not finished) and, if
      // the triage claim had expired, dispatch a SECOND reader for the same messages - the duplicated
      // work this file spends three paragraphs above preventing. True means handed over, so the lock
      // stays with the pass that is running on this correlation.
      // ONLY THE ADMITTED RUN SETTLES IT. A duplicate delivery carries this same correlation id, so it
      // would pass the release condition and free the lock under the run still answering; the
      // reasoning, and how a killed run is still released, is on `settleTurnLockAtExit`.
      await settleTurnLockAtExit({
        admitted: admission.admitted,
        redispatchedPass,
        channelArn: event.channelArn,
        botArn: event.botArn,
        correlationId: event.correlationId,
        // What this turn ran as, so the handover never has to ask Chime for it.
        ...(event.classification ? { classification: event.classification } : {}),
        // THE WORDING THIS ASSISTANT WAS CONFIGURED WITH. The handover can settle the deferral notice,
        // which is a line a person reads - so without this it said fixed English whatever the
        // deployment configured and whatever language the conversation is in (tenets P5 and D11).
        ...(turnCopy ? { copy: turnCopy } : {}),
        // The turn handed to is another triage, so its completion arrives back here. Passing this
        // turn's budget on is what makes that a bounded loop rather than a conversation held for as
        // long as somebody keeps typing into it.
        ...(event.triage ? { triage: { pass: event.triage.pass } } : {}),
        // ── AND WHAT THIS TURN WAS, FOR THE NOTICE IT DISPLACED ───────────────
        //
        // When this turn's placeholder became the queue notice, the answer went to a new message at
        // the end and the exchange is minted against the NOTICE. The settle is the update that notice
        // already receives, so the declaration and the attribution ride it - the same decision
        // `closeOutAcknowledgement` makes for an ordinary receipt, taken in the one place a queued
        // turn's receipt is settled instead of closed out.
        //
        // NOT ON A READING. A reading answers a burst and names no single message, which is why it
        // declares `turnKind: 'reading'` and stays out of the exchange population entirely.
        ...(event.triage ? {} : (() => {
          const attribution = closeOutAttribution({
            ...(event.userMessageId ? { userMessageId: event.userMessageId } : {}),
            ...(event.intent ? { intent: event.intent } : {}),
            ...(event.intentConfidence ? { intentConfidence: event.intentConfidence } : {}),
            ...(event.deliveryOption ? { deliveryOption: event.deliveryOption } : {}),
            ...(event.taskId ? { taskId: event.taskId } : {}),
            ...(turnEntryOf(event.entry, event.trigger) ? { entry: turnEntryOf(event.entry, event.trigger) } : {}),
          });
          return attribution ? { attribution } : {};
        })()),
      });
    } finally {
      // ── THE ASSISTANT IS GIVEN BACK LAST, ON EVERY EXIT ───────────────────────────────────────────
      //
      // Last, because everything above still acts as the assistant: settling the lock can rewrite the
      // queue notice, which is a message posted as this assistant. The Lambda's own role is
      // bootstrap-only, so releasing earlier would refuse that work. And on every exit, because a warm
      // container that kept the session would serve it to the next turn - one assistant answering in
      // another's voice. The assistant's name goes with it, for the same reason. Work the turn held past a
      // deadline (a voiced send, a welcome prompt, a context read) settles first, so it finishes as this assistant.
      await endAssistantTurn();
      turnAssistantName = '';
      turnCopy = undefined;
      turnDefinition = undefined;
      turnAssistantRole = '';
    }
  }
};
