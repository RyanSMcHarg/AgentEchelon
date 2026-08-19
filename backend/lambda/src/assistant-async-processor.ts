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
 * The union runs the full text path for ALL profiles (taskSupport is 'full' everywhere now — the
 * router classifies task intents on every classification), and gates the two genuinely
 * profile-specific capabilities:
 *   - /battle is enabled only when BATTLE_ELIGIBLE=true (from profile.battleEligible);
 *   - the model, model display name, token ceiling, and persona come from per-profile env
 *     (PROFILE_NAME / MODEL_ID / MODEL_NAME / MAX_TOKENS) + an optional SSM/env persona override.
 *
 * Pipeline: poll placeholder -> load history -> build system prompt (persona + host context + task +
 * RAG + summary) -> resolve model (battle variant / context-routing) -> invoke (image-gen | vision |
 * external | Bedrock) -> shadow/stall task transitions -> generate document -> finalize -> title rename.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  AsyncProcessorEvent,
  AsyncProcessorConfig,
  GeneratedDocument,
  runSharedPipeline,
  scanForPlaceholderMessage,
  firstTurnGreetingDirective,
  userIdentityDirective,
  handleProcessingError,
  finalizePlaceholderResponse,
  generateAndUploadDocument,
  isDocumentRequest,
  isDeliverableDocument,
  getTaskLabel,
  applyInputGuardrail,
  applyOutputGuardrail,
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
  resolveTurnImageGenModelId,
  buildTaskLoopContext,
  shadowKeywordTransition,
  recordStallIfNoTransition,
  type BedrockImageInput,
  type BedrockDocumentInput,
} from './lib/async-processor-core.js';
// First-turn summary seed. Runs through the data-plane seam (ADR-013): this processor
// is non-VPC, so the Aurora write + Bedrock summarisation happen in the data-plane Lambda.
import { seedConversationSummary } from './lib/data-plane-client.js';
import { fetchAttachmentBytes, senderOwnsAttachmentKey } from './lib/attachment-bytes.js';
import { stripReasoningTags } from './lib/message-markers.js';
import type { RosterParticipant } from './lib/channel-notify.js';
import { buildConfigIdentity, componentVersion } from './lib/config-identity.js';
import { buildSystemPrompt } from './lib/context-framework.js';
import { createHostContextRegistry } from './lib/host-context-resolvers.js';
import { invokeBedrockWithFallback } from './lib/bedrock-resilience.js';
import { makeConverseStep, type ConverseStep } from './lib/analytics-metadata.js';
import { resolveModelPlan } from './lib/resolve-model-plan.js';
import { externalProviderFromEnv, invokeExternalLlm } from './lib/providers/external-llm.js';
import { transcriptConventionDirective } from './lib/transcript-attribution.js';
import {
  invokeImageGenModel,
  imageGenRegionFor,
  imageGuardrailFor,
  imageGenModelIdToKey,
  IMAGE_GEN_MODELS,
} from './lib/image-gen-models.js';
import { persistImageGenOutput, buildBattleImageContent, buildImageGenAttachment } from './lib/image-gen-output.js';
import { buildRetrievedContextHint, buildConversationSummaryHint } from './analytics-aurora/document-retrieval.js';
import { readPublishedCatalog, selectSources, resolveContextSources, renderContextMenu, renderSourceSection } from './lib/context-sources-runtime.js';
import { createSourceReader } from './lib/context-source-readers.js';
import { emitContextSourceOutcome, classifyAccessError, ContextSourceAccessError } from './lib/context-source-outcomes.js';
import {
  getTask,
  buildTaskContextForPrompt,
  buildCrossChannelTasksHint,
  getActiveTasksForUser,
  principalIdFromArn,
  buildConversationTasksHint,
  getOpenTasksForConversation,
  updateTaskStatus,
  type Task,
} from './lib/task-tracking.js';
import { resolveModelForIntent } from './lib/model-resolver.js';
import { clampResponseMaxTokens, taskStateMachines } from './lib/intent-pack.js';
import { legalTransitionsFrom } from './lib/task-state-machines.js';
import { taskHasMachine } from './lib/task-tools.js';
import { getModelCatalog, INTENT_ROUTE_STRATEGY, DEFAULT_PROFILE_MODEL_SELECTION, bedrockInvokeId } from '../../lib/config/model-strategy.js';
import { resolveActiveProfile, resolveFromDefinition, buildIntentStrategy } from './lib/active-profile.js';
import { hydrateBodies } from './lib/profile-bodies.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
// SPEC-PORTABLE-PROFILES P0: root for the per-profile SSM namespace (/{root}/assistant/{name}/…).
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

// The serving profile (= the classification's profile name, e.g. 'basic'/'standard'/'premium').
// Set by the assistant-profile stack; drives the persona default + the model-strategy userType key.
const PROFILE_NAME = (process.env.PROFILE_NAME || 'basic') as AsyncProcessorConfig['userType'];
// profile.battleEligible, forwarded as an env string. /battle assembly + image paths are gated on it.
const BATTLE_ELIGIBLE = process.env.BATTLE_ELIGIBLE === 'true';
const MODEL_NAME = process.env.MODEL_NAME || 'Claude';

const s3Client = new S3Client({ region: AWS_REGION });

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
    ddbClientSingleton = new DynamoDBClient({ region: AWS_REGION });
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
    lambdaClientSingleton = new LambdaClient({ region: AWS_REGION });
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
const ssmClient = new SSMClient({ region: AWS_REGION });

const CONFIG: AsyncProcessorConfig = {
  model: process.env.MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0',
  maxTokens: Number(process.env.MAX_TOKENS) || 4096,
  temperature: 0.7,
  userType: PROFILE_NAME,
};

// The host's per-turn context resolvers (domain context, participant profile), built once at cold
// start. Each resolver no-ops to '' for a generic (non-plan) AE turn, so the composed prompt is
// byte-identical for a channel with no host grounding.
const hostContextRegistry = createHostContextRegistry();

// ============================================================
// Per-profile persona (default) + SSM/env override
// ============================================================
//
// The shipped defaults are the legacy per-classification prose, verbatim (keyed by profile name so the merge
// is behavior-preserving); MODEL_NAME is interpolated from env. A deployment overrides the persona
// per profile via ASSISTANT_SYSTEM_PROMPT_PARAM (SSM — a rich persona can exceed Lambda's 4 KB env
// cap) or ASSISTANT_SYSTEM_PROMPT (inline env). Falls back to the profile default, then a generic
// template for an unrecognized profile name.

const BASIC_PROMPT = `You are an AI assistant in Agent Echelon, an enterprise conversational AI platform. Users interact with you through a chat interface. You are running on the Basic tier (${MODEL_NAME}), optimized for fast, cost-effective responses.

Your capabilities on this tier:
- Quick Q&A and general knowledge
- Basic code assistance and debugging
- Straightforward information lookups
- Concise explanations and summaries

Guidelines:
- Be direct and helpful
- Keep responses focused and concise
- Use markdown formatting when it helps readability
- If asked about "this tool" or "this app", explain that you are part of Agent Echelon, an enterprise AI assistant platform with tiered access (Basic, Standard, Premium) offering different AI models and capabilities
- If you don't know a fact, say so honestly, but if you CAN do the task (drafting, writing, summarizing), just do it
- Answer directly. Do NOT open with disclaimers such as "as an AI assistant" or "I don't have access to..."; never refuse and then comply in the same reply`;

const STANDARD_PROMPT = `You are an AI assistant in Agent Echelon, an enterprise conversational AI platform. Users interact with you through a chat interface. You are running on the Standard tier (${MODEL_NAME}), offering a balance of capability and speed.

Your capabilities on this tier:
- Complex reasoning and detailed analysis
- Code review, debugging, and generation
- Multi-step guided workflows (troubleshooting, data extraction, report generation)
- Task tracking with state management across conversation turns
- Document generation: when the user asks you to "write as a document", "save as a file", "generate a report", or "provide as an attachment", your response will automatically be saved as a downloadable Markdown file and attached to your message

Guidelines:
- Be thorough but concise
- Use markdown formatting for structured responses
- When working on multi-step tasks, guide the user through each step clearly
- If asked about "this tool" or "this app", explain that you are part of Agent Echelon, an enterprise AI assistant platform with tiered access
- If the user's message seems off-topic from an active task, briefly acknowledge it and redirect back to the task
- Answer directly. Do NOT open with disclaimers such as "as an AI assistant" or "I don't have access to..."; if you can do the task (drafting, writing, brainstorming, summarizing), just do it
- If a creative or drafting request is missing a specific detail, make a reasonable assumption (note it in one short line) or ask ONE brief question; never refuse and then comply in the same reply`;

const PREMIUM_PROMPT = `You are an AI assistant in Agent Echelon, an enterprise conversational AI platform. Users interact with you through a chat interface. You are running on the Premium tier (${MODEL_NAME}), the most capable model with advanced reasoning and full resource access.

Your capabilities on this tier:
- Advanced reasoning, deep analysis, and nuanced problem-solving
- Full code generation, architecture review, and debugging
- Multi-step guided workflows with detailed state tracking
- Access to knowledge base context documents for enriched responses
- Report generation with document attachment delivery
- Document generation: when the user asks you to "write as a document", "save as a file", "generate a report", or "provide as an attachment", your response will automatically be saved as a downloadable Markdown file and attached to your message

Guidelines:
- Provide thorough, well-reasoned responses
- Use markdown formatting for structured output
- When working on multi-step tasks, provide detailed guidance at each step
- Leverage any available context documents to enrich responses
- If asked about "this tool" or "this app", explain that you are part of Agent Echelon, an enterprise AI assistant platform with tiered access
- If the user's message seems off-topic from an active task, briefly acknowledge it and redirect back to the task
- Answer directly. Do NOT open with disclaimers such as "as an AI assistant" or "I don't have access to..."; if you can do the task (drafting, writing, brainstorming, summarizing), just do it
- If a creative or drafting request is missing a specific detail, make a reasonable assumption (note it in one short line) or ask ONE brief question; never refuse and then comply in the same reply`;

const DEFAULT_PROMPTS: Record<string, string> = {
  basic: BASIC_PROMPT,
  standard: STANDARD_PROMPT,
  premium: PREMIUM_PROMPT,
};

/** The profile's default persona (legacy per-classification prose), or a generic template for an unknown
 *  profile so a new deployment-defined profile still gets a sensible persona out of the box. */
function defaultPersonaFor(profile: string): string {
  return (
    DEFAULT_PROMPTS[profile] ||
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
  cachedSystemPrompt = process.env.ASSISTANT_SYSTEM_PROMPT?.trim() || defaultPersonaFor(PROFILE_NAME);
  return cachedSystemPrompt;
}

// ============================================================
// Task-type system prompt additions (per-state)
// ============================================================
//
// NOTE: SPEC-TASK-STATE-TRANSITIONS moved authoritative per-state guidance into the intent-pack
// machines; these prose blocks are the standing fallback guidance folded into the persona. They
// cover the full task-type set (troubleshooting, data extraction, report generation, place_item,
// action_item) — the superset the standard processor carried.
function buildTaskSystemPrompt(taskType: string, taskState: string, task?: Task | null): string {
  let base: string;
  switch (taskType) {
    case 'guided_troubleshooting':
      base = getGuidedTroubleshootingPrompt(taskState);
      break;
    case 'data_extraction':
      base = getDataExtractionPrompt(taskState);
      break;
    case 'report_generation':
      base = getReportGenerationPrompt(taskState);
      break;
    case 'place_item':
      base = getPlaceItemPrompt(taskState);
      break;
    case 'action_item':
      base = getActionItemPrompt(taskState, task);
      break;
    default:
      base = '';
  }
  // Append the machine's EXACT legal next-state names. The per-state prose above says what to do but
  // not always the precise state to advance TO, so the model would guess a to_state that isn't in the
  // declared graph — advance_task_state then errors (unknown_state/illegal_transition) and the machine
  // stalls mid-flow (e.g. data_extraction stuck in `extracting` while the reply is delivered). Naming the
  // valid targets verbatim removes the guesswork.
  if (base && taskHasMachine(taskType)) base += taskAdvanceHint(taskType, taskState);
  return base;
}

/** The exact legal next states for the model's advance_task_state call, verbatim (no guessing). */
function taskAdvanceHint(taskType: string, taskState: string): string {
  const legal = legalTransitionsFrom(taskType, taskState);
  if (legal.length === 0) {
    return `\n\n**Task state machine:** the task is in \`${taskState}\` — a terminal state. Do not call advance_task_state.`;
  }
  const names = legal.map((s) => `\`${s}\``).join(', ');
  return `\n\n**Task state machine:** the task is currently in \`${taskState}\`. When the conversation has actually reached the next milestone, call the **advance_task_state** tool with \`to_state\` set to EXACTLY one of these declared next states (copy the name verbatim): ${names}. These are the ONLY valid targets from here — do not invent or paraphrase a state name. If no milestone has been reached yet, do not call the tool.`;
}

// Action item. A tracked, assignable real-world action. The assistant never completes it in-app — it
// gathers details, presents options + concrete steps/deep-links, and the participant completes it
// off-platform. On a shared plan it confirms WHO owns the action; a due-by date is captured when it matters.
function getActionItemPrompt(state: string, _task?: Task | null): string {
  switch (state) {
    case 'gathering':
      return `\n\n## CURRENT TASK: Action item
Help the participant lock in a real action. First confirm:
- WHAT: the action and which work item it's for.
- WHEN: the date/time, and any **due-by deadline** (lead time / it can't wait) — note it.
- WHO: on a SHARED plan (see the participants above), ask who's responsible for it; otherwise it's
  the person you're talking to.
Then present concrete options + the exact steps or a deep-link. You CANNOT complete it in-app —
everything is "to confirm on the operator's site".`;
    case 'options_presented':
      return `\n\n## CURRENT TASK: Action item — options presented
Help them choose, then give the precise steps / deep-link. Be explicit that it's completed on the
operator's site, not here. Capture the due-by deadline if you haven't.`;
    case 'awaiting_completion':
      return `\n\n## CURRENT TASK: Action item — awaiting completion
They're completing it off-platform. When they say it's done, acknowledge it and offer to record the
confirmation / details onto the work item (update_item).`;
    case 'completed':
      return `\n\n## CURRENT TASK: Action item — done
Done. Confirm what's locked in and suggest the next open item.`;
    default:
      return '';
  }
}

// Place-an-item task. The task persists the intent across turns + anchors it to the plan; the
// per-state prompt drives the gather -> propose -> confirm flow.
function getPlaceItemPrompt(state: string): string {
  switch (state) {
    case 'collecting':
      return `\n\n## CURRENT TASK: Add a work item to the plan
The user wants to ADD a work item to this plan (see their message + the work items above). Before you
propose the add, make sure you know WHERE it goes:
- Where in the order it lands (after which existing item), and any start/due date.
- Briefly, what it involves — capture it as the item's notes.
If the position or detail is unclear, ask ONE short question (offer your best suggestion). Once you
know the detail + position, PROPOSE the add with the add_item tool, setting \`afterItemId\` so it lands
where it belongs (not appended blindly at the bottom).`;
    case 'confirming':
      return `\n\n## CURRENT TASK: Add a work item — awaiting confirmation
You've proposed the add; the user reviews it on the card. If they confirm, acknowledge briefly and say
where it landed. If they want a different position/detail, propose the corrected add_item again.`;
    case 'placed':
      return `\n\n## CURRENT TASK: Add a work item — done
The item has been added. Offer a sensible next step (assign it, set a date, or add a related item).`;
    default:
      return '';
  }
}

function getGuidedTroubleshootingPrompt(state: string): string {
  switch (state) {
    case 'collecting_symptoms':
      return `\n\n## CURRENT TASK: Guided Troubleshooting - Collecting Symptoms
Ask the user to describe the problem in detail. Gather:
- What exactly is happening (error messages, unexpected behavior)
- When it started happening
- What changed recently
- Steps to reproduce
Do NOT propose solutions yet. Focus on understanding the problem.`;

    case 'diagnosing':
      return `\n\n## CURRENT TASK: Guided Troubleshooting - Diagnosing
Based on the symptoms collected, analyze the problem:
- Identify likely root causes
- Ask targeted follow-up questions if needed
- Narrow down the possibilities`;

    case 'proposing_solutions':
      return `\n\n## CURRENT TASK: Guided Troubleshooting - Proposing Solutions
Present 2-3 possible solutions ranked by likelihood:
- Start with the most likely fix
- Provide step-by-step instructions for each
- Ask the user to try the first solution and report back`;

    case 'awaiting_result':
      return `\n\n## CURRENT TASK: Guided Troubleshooting - Awaiting Result
The user is trying a proposed solution. Based on their feedback:
- If it worked: congratulate and ask if they need anything else
- If it didn't: suggest the next solution or ask for more details`;

    default:
      return '\n\n## CURRENT TASK: Guided Troubleshooting\nHelp the user resolve their issue step by step.';
  }
}

function getDataExtractionPrompt(state: string): string {
  switch (state) {
    case 'collecting_requirements':
      return `\n\n## CURRENT TASK: Data Extraction - Collecting Requirements
Understand what data the user needs:
- What data source(s) are involved
- What specific fields or information to extract
- Any filters or conditions
- Desired output format`;

    case 'extracting':
      return `\n\n## CURRENT TASK: Data Extraction - Extracting
Process the extraction based on collected requirements:
- Explain briefly what you're extracting and from where.
- Present the extracted records as a **markdown table** — one row per record, a column per field —
  when the data is tabular; use a titled list only when it genuinely isn't. Include every matching
  record, not a sample. This result is delivered to the user as a downloadable document.`;

    case 'validating':
      return `\n\n## CURRENT TASK: Data Extraction - Validating
Validate the extracted data:
- Check for completeness and accuracy
- Highlight any anomalies or missing data
- Ask the user to confirm the results look correct`;

    case 'formatting':
      return `\n\n## CURRENT TASK: Data Extraction - Formatting
Format the validated data for delivery as a downloadable document:
- Default to a clean **markdown table** for tabular data (add a short title line above it); apply the
  user's requested format if they named one.
- Add any requested calculations or transformations (totals, sorting, derived columns).
- Present the complete, final result — this is the deliverable the user downloads.`;

    default:
      return '\n\n## CURRENT TASK: Data Extraction\nHelp the user extract the data they need.';
  }
}

function getReportGenerationPrompt(state: string): string {
  switch (state) {
    case 'collecting_requirements':
      return `\n\n## CURRENT TASK: Report Generation - Collecting Requirements
Understand what report the user needs:
- Report topic and purpose
- Target audience
- Key metrics or data points to include
- Desired format and length
- Any specific sections or structure`;

    case 'drafting_outline':
      return `\n\n## CURRENT TASK: Report Generation - Drafting Outline
Present a report outline for approval:
- List proposed sections with brief descriptions
- Note key data/metrics for each section
- Ask if the user wants to adjust the structure`;

    case 'generating':
      return `\n\n## CURRENT TASK: Report Generation - Generating
Generate the full report and DELIVER it:
- Follow the approved outline; include relevant data and analysis; use appropriate formatting (headers, tables, etc.).
- The report is a finished deliverable. When you present it, mark the task done: advance_task_state to \`completed\`.
- Do NOT make the user run a revision pass. Only if the user later asks for changes, advance to \`revising\`.`;

    case 'revising':
      return `\n\n## CURRENT TASK: Report Generation - Revising (user-requested changes)
The user asked for changes to a report you already delivered. Apply them:
- Make the requested changes and briefly highlight what you modified.
- Re-deliver: advance_task_state back to \`completed\`. Stay in revising only if the user asks for further changes.`;

    default:
      return '\n\n## CURRENT TASK: Report Generation\nHelp the user create their report.';
  }
}

// Per-intent response budget. The router forwards the intent's `responseSettings.maxTokens` (from the
// pack) in the event; it WINS, clamped to the profile ceiling (CONFIG.maxTokens) with a reasoning
// floor. Absent => the profile default. This is how a deployment sizes answers per intent via config.
function resolveMaxTokens(event: AsyncProcessorEvent, reasoning: boolean): number {
  return clampResponseMaxTokens(event.responseSettings?.maxTokens, CONFIG.maxTokens, reasoning);
}

export const handler = async (event: AsyncProcessorEvent): Promise<void> => {
  const startTime = Date.now();
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
    const pipeline = await runSharedPipeline(event);

    if (!pipeline) {
      return;
    }

    const { messageId, pollTime, consolidatedHistory, priorAgentContext, bedrockMessages, isFirstUserTurn } = pipeline;

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
    const activeProfile = event.variantProfile
      ? resolveFromDefinition(await hydrateBodies(event.variantProfile), PROFILE_NAME)
      : await resolveActiveProfile(PROFILE_NAME, { ssm: ssmClient, ssmRoot: SSM_ROOT });
    const versionedPersona = activeProfile.persona;
    const baseSystemPrompt = versionedPersona?.trim() || (await resolveBaseSystemPrompt());

    // P4 config attribution — fingerprint the deployment config (persona resolved here + the pack
    // version the router forwarded) so this turn's analytics is sliceable by config, not just model.
    // Derived from the BASE prompt only (pre context/task append) so the id is a stable per-deploy
    // value. A fall-through to the profile default reads as personaVersion='default'.
    const configIdentity = buildConfigIdentity({
      personaVersion: baseSystemPrompt === defaultPersonaFor(PROFILE_NAME) ? 'default' : componentVersion(baseSystemPrompt),
      intentPackVersion: event.intentPackVersion ?? 'default',
      systemPromptHash: componentVersion(baseSystemPrompt, 'empty'),
    });

    let systemPrompt = buildSystemPrompt(baseSystemPrompt, hostContextRegistry.resolveSections(event));
    // The stable base (persona + host per-turn context) is complete here; capture its length so
    // invokeBedrock can insert a Bedrock cachePoint after it (the dynamic per-turn appends below fall
    // in the uncached suffix). On /battle turns systemPrompt is reassembled below but still leads with
    // this same stable base, so the prefix remains a valid front slice.
    let cacheableSystemPrefixLength = systemPrompt.length;

    // First-turn greeting (A3): on the user's first message, greet them by name once. Appended AFTER
    // the cache-prefix capture so it sits in the dynamic (uncached) suffix, like the task appends
    // below. No-ops when the name is unresolved or this is not the first turn. Name personalization
    // lives here (not the creation-time welcome, which races membership/metadata).
    if (isFirstUserTurn) {
      systemPrompt += firstTurnGreetingDirective(event.senderDisplayName);
    }

    // WHO the user is, on EVERY turn - not just the first. A name asserted in conversation ("my name
    // is X") can arrive on any turn, and until it did the assistant simply adopted it, having been
    // told to greet by name but never that the name was authoritative. Sits in the dynamic suffix
    // beside the greeting for the same reason: it is per-USER, so caching it would poison the shared
    // prefix. No-ops for an unresolved sender, which is what keeps guest and federated flows free of a
    // constraint that has no identity to anchor to.
    systemPrompt += userIdentityDirective(event.senderDisplayName);

    // WHAT THE SPEAKER LABELS MEAN (ADR-027 part 2). Returns '' unless this turn's transcript actually
    // carries labels, so a 1:1 pays nothing and reads exactly as before. In the dynamic suffix beside
    // the identity directive, and for the same reason: it depends on who is in the conversation.
    systemPrompt += transcriptConventionDirective(bedrockMessages);

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
    try {
      const senderSub = event.senderArn?.split('/user/').pop() || '';
      const selection = activeProfile.contextSources;
      if (selection?.length) {
        // Throws on anything but ParameterNotFound, so a denied catalog read reaches the `(catalog)`
        // handler below instead of quietly becoming an empty catalog.
        const catalog = await readPublishedCatalog(
          () => getSsmParameter(`${SSM_ROOT}/assistant/${PROFILE_NAME}/context-sources`),
        );
        // On a real turn the sender is resolved and the channel exists, so both availability gates are
        // met. The creation-time welcome is the call site where they are not - see the router.
        const callSite = { identitySettled: Boolean(senderSub), conversationSettled: Boolean(event.channelArn) };
        // PROFILE_NAME is the classification, and it is passed to both calls so every source's
        // disposition lands in CloudWatch under AgentEchelon/ContextSources. Without it the feature is
        // observable only by reading this log group by hand, which is not a control an operator can
        // alarm on - see GUIDE-ASSISTANT-CONTEXT "Monitoring and access review".
        const chosen = selectSources(catalog, selection, callSite, PROFILE_NAME);
        if (chosen.length) {
          const resolved = await resolveContextSources(chosen, {
            callSite,
            classification: PROFILE_NAME,
            // No resource map: each entry carries its own locator and prefix from the published
            // catalog, so the read lands where the grant was scoped rather than at an env-var path.
            read: createSourceReader(
              { classification: PROFILE_NAME, userSub: senderSub, channelArn: event.channelArn },
              { s3: s3Client, ddb: contextDdbClient(), ssm: ssmClient, lambda: contextLambdaClient() },
            ),
          });
          // The menu names what the model HAS this turn, so it is built from what actually resolved,
          // never from the selection - listing a source that failed to resolve invites the model to
          // promise what it cannot deliver.
          systemPrompt += renderContextMenu(resolved.map((r) => r.entry));
          for (const r of resolved) systemPrompt += renderSourceSection(r);
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
          classification: PROFILE_NAME,
          sourceKey: '(catalog)',
          outcome: err instanceof ContextSourceAccessError ? err.reason : classifyAccessError(err),
        });
      }
    }

    // Load task context if task-based: fold the standing per-state guidance + the task's own context
    // into the prompt, and stamp activeTaskInfo (with taskId) so the reply archives with task_id.
    let activeTaskInfo: { type: string; status: string; label: string; taskId: string } | undefined;
    if (event.taskId && event.taskType) {
      const task = await getTask(event.taskId, event.channelArn);
      if (task) {
        systemPrompt += buildTaskSystemPrompt(event.taskType, task.taskState || '', task);
        // THIS PROFILE'S machines, the same ones the `advance_task_state` tool is authorized against
        // below. A profile that declares its own step - and therefore its own `requires` - must have
        // the step's needs grounded from that declaration, or the prompt would chase the deployment
        // pack's checklist while the tool enforced the profile's graph. Undefined ⇒ the pack, which is
        // byte-identical for every profile that does not override machines.
        systemPrompt += buildTaskContextForPrompt(task, activeProfile.machines);
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
    try {
      const conversationTasks = await getOpenTasksForConversation(event.channelArn);
      const hereHint = buildConversationTasksHint(
        conversationTasks,
        event.senderArn ? { id: event.senderArn.split('/user/').pop() || '' } : null,
        { excludeTaskId: event.taskId },
      );
      if (hereHint) systemPrompt += hereHint;
    } catch (err) {
      console.warn('[AssistantAsyncProcessor] conversation task hint failed (non-fatal):', err);
    }

    try {
      const userSub = event.senderArn?.split('/user/').pop() || '';
      if (userSub) {
        const crossChannelTasks = await getActiveTasksForUser(userSub);
        const hint = buildCrossChannelTasksHint(event.channelArn, crossChannelTasks);
        if (hint) systemPrompt += hint;
      }
    } catch (err) {
      console.warn('[AssistantAsyncProcessor] cross-channel task hint failed (non-fatal):', err);
    }

    // RAG — retrieved by the router (the VPC-attached Lambda with Aurora access); we just format the
    // hint here. The router's retrieveContext call already applied the classification-scope filter.
    if (event.retrievedContext) {
      const ragHint = buildRetrievedContextHint(event.retrievedContext);
      if (ragHint) systemPrompt += ragHint;
    }

    // Conversation summary as consumable context (ADR-017); no-op when short.
    systemPrompt += buildConversationSummaryHint(event.conversationSummary);

    if (priorAgentContext) {
      systemPrompt += `\n\n[You already said the following — do NOT repeat it. Use completely different wording.]\n${priorAgentContext.trim()}`;
    }

    // /battle (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "Battle delegates to the normal engine"): a
    // battle turn is a NORMAL request for this bot's assigned experiment variant. The variant is
    // resolved ONCE in the fan-out (channel-flow / battle-orchestrator) and passed in via
    // battleContext, so there is no second resolution here (this removes the two-Lambda divergence).
    // We layer the variant's persona addendum as normal persona (not a battle constraint), and on
    // round 2 append the rival's round-1 reply as a minimal, non-adversarial rebuttal note. Round 1
    // is fully normal: no length cap, no adversarial framing. Only battle-eligible profiles
    // participate; only when event.battleContext is set. All other invocations proceed normally.
    let battleVariantModelKey: string | undefined;
    let battleSelfDisplayName: string | undefined;
    const battleOn = BATTLE_ELIGIBLE && !!event.battleContext;
    if (battleOn && event.battleContext) {
      // A profileRef variant's WHOLE version arrives as `event.variantProfile` (stamped by both
      // fan-out sites) and has already been applied above, so this side's persona, tools, classifier
      // mode and guardrail are the variant's. `variantModelKey` remains the model override for a
      // lightweight modelKey variant; if it ever arrives unset, the model application below falls back
      // to the profile's normal resolution rather than crashing.
      battleVariantModelKey = event.battleContext.variantModelKey;
      battleSelfDisplayName = event.battleContext.selfDisplayName;
      // Normal persona layering: <persona_addendum> is the SAME mechanism the normal engine uses,
      // NOT a battle-mode constraint block.
      if (event.battleContext.variantAddendum) {
        systemPrompt += `\n\n<persona_addendum>${event.battleContext.variantAddendum}</persona_addendum>`;
      }
      // Battle awareness: round 1 gets a light "you are in battle mode" note; round 2 gets the
      // rival's round-1 reply as the thing to respond to (which is itself battle-aware).
      if (event.battleContext.round === 2) {
        systemPrompt += buildRebuttalContext(
          event.battleContext.rivalDisplayName || 'the other assistant',
          event.battleContext.rivalReply || '',
        );
      } else {
        systemPrompt += buildBattleAwareness(
          event.battleContext.rivalDisplayName || 'the other assistant',
        );
      }
      // systemPrompt may have changed; the stable base is still its leading slice but the length shifted.
      cacheableSystemPrefixLength = Math.min(cacheableSystemPrefixLength, systemPrompt.length);
      console.log('[AssistantAsyncProcessor][battle] Normal-engine battle turn', {
        round: event.battleContext.round,
        self: battleSelfDisplayName,
        rival: event.battleContext.rivalDisplayName,
        variantModelKey: battleVariantModelKey,
      });
    }

    // Resolve model for this intent (respects classification boundaries). When the bot is an alt-slot
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
    const baseModelSelection = (catalog as Record<string, unknown>)[activeModelKey]
      ? { ...DEFAULT_PROFILE_MODEL_SELECTION, [CONFIG.userType]: activeModelKey }
      : DEFAULT_PROFILE_MODEL_SELECTION;
    // U2 (SPEC-ASSISTANT-CONFIG §4): per-intent model routing comes from THIS profile version's
    // `models.byIntent`, not the global strategy table. The seed copies the global strategy per-profile,
    // so this is byte-identical until an operator edits a version; fail-closed to the global strategy
    // when a version carries no per-intent routing.
    const profileStrategy = buildIntentStrategy(active.models) ?? INTENT_ROUTE_STRATEGY;
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
    const resolution = resolveModelForIntent(
      event.intent || event.resolvedModel,
      CONFIG.userType,
      catalog,
      profileStrategy,
      baseModelSelection,
      { continuesActiveWork },
    );
    const variantDef = battleVariantModelKey
      ? catalog[battleVariantModelKey as keyof typeof catalog]
      : undefined;
    const variantBedrockModelId = variantDef ? bedrockInvokeId(variantDef) : undefined;
    const effectiveModel = variantBedrockModelId || event.resolvedModel || resolution.primaryModelId;
    // SPEC-ASSISTANT-CONFIG §4 — per-profile tool allowlist: the active version's `tools` gate which tools
    // the Converse loop may offer (undefined ⇒ all available, byte-identical to before). Flows into
    // bedrockInvokeConfig below (which spreads invokeConfig).
    // A /battle round-2 rebuttal carries no new user input (the prompt was guarded on round 1), so skip the
    // INPUT guardrail on it - otherwise a rebuttal whose prompt round-1 already allowed gets blocked. Output
    // guardrail still runs.
    const invokeConfig = {
      ...CONFIG,
      model: effectiveModel,
      tools: active.tools,
      // The guardrail this assistant SELECTS (SPEC-CONFIGURABLE-ASSISTANTS 4.6); undefined ⇒ deployment default.
      guardrailId: active.guardrailId,
      skipInputGuardrail: battleOn && event.battleContext?.round === 2,
      // ADR-027 phase 1: the input guardrail scores what this turn's human submitted, not whatever
      // sits last in the user role. In a channel with a second assistant those differ, and the peer's
      // message wins the slot.
      userTurnText: event.userMessage,
    };
    // P0 attribution: which profile VERSION served this turn's base model ('seed' = the compiled
    // default, i.e. no active version). Battle/experiment overrides still take precedence above.
    console.log('[AssistantAsyncProcessor] active profile', {
      profile: PROFILE_NAME,
      profileConfigId: active.configId,
      baseModelKey: activeModelKey,
      effectiveModel,
    });

    // Context-aware model routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING), flag-gated + battle-exclusive.
    // When ENABLE_CONTEXT_ROUTING is off (or this is a /battle turn), `plan` is null and the Bedrock
    // path below is unchanged. PREFERRED CN path is DeepSeek-on-Bedrock (in-AWS, intent-routed R1/V3,
    // no consent gate); the external provider is used only when no Bedrock CN model is configured.
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
    const plan =
      cnBedrock || cnCfg
        ? resolveModelPlan(
            {
              classification: CONFIG.userType,
              intent: event.intent,
              experimentModelId: event.resolvedModel,
              userLanguage: event.userLanguage,
              // Same turn fact as the baseline resolution above, so the context-routing path cannot
              // reach a cheaper model than the path it is meant to be backward-compatible with.
              continuesActiveWork,
              // Geography routing (rule 2): the dominant geo segment forwarded from the host. A CN
              // segment routes to the CN model even when the user's global language isn't zh.
              segment: event.segment,
            },
            {
              catalog,
              strategy: profileStrategy,
              profileDefaults: baseModelSelection,
              enabled: true,
              cnBedrock,
              cnProvider: cnCfg ? { provider: cnCfg.provider, modelId: cnCfg.model } : null,
              externalConsentDefault: process.env.EXTERNAL_MODEL_CONSENT_DEFAULT === 'true',
            },
          )
        : null;
    const useExternal = !!(plan && cnCfg && plan.ref.provider !== 'bedrock');

    // DeepSeek-on-Bedrock swap: the CN rule returned a Bedrock model different from the default. It
    // rides the normal Bedrock Converse path (guardrails/resilience/tool loop), just with a different
    // model id. For the reasoning model (R1): raise maxTokens (chain-of-thought eats the budget) and
    // skip tool-use (reasoning models are unreliable at tools — edits arrive on their own V3 turn).
    const cnBedrockModel =
      plan && plan.ref.provider === 'bedrock' && plan.ref.modelId !== effectiveModel ? plan.ref.modelId : null;
    const reasoningTurn = !!(cnBedrockModel && plan!.reasoning);
    const bedrockInvokeConfig = {
      ...invokeConfig,
      model: cnBedrockModel ?? effectiveModel,
      maxTokens: resolveMaxTokens(event, reasoningTurn),
    };
    const enableEditTools = !!event.domainContext && !reasoningTurn;
    const cnFallbackModelId = plan?.fallback?.modelId ?? resolution.fallbackModelId;

    console.log('[AssistantAsyncProcessor] Model resolution', {
      profile: PROFILE_NAME,
      intent: event.intent,
      resolvedModel: useExternal
        ? `${cnCfg!.provider}:${cnCfg!.model}`
        : cnBedrockModel ?? effectiveModel,
      fallback: cnFallbackModelId,
      fromStrategy: resolution.resolvedFromStrategy,
      contextRouted: useExternal || !!cnBedrockModel,
      battle: battleOn ? { variantModelKey: battleVariantModelKey } : undefined,
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
      /** The INPUT guardrail blocked the turn before any model ran (structural, see invokeBedrock). */
      inputGuardBlocked?: boolean;
    };

    // SPEC-TASK-STATE-TRANSITIONS: active-task context for the in-loop advance_task_state tool
    // (undefined unless this turn belongs to a machine-backed task). Passing it registers the tool.
    // All profiles are taskSupport:'full', so this is wired uniformly.
    const taskContext = await buildTaskLoopContext({
      taskId: event.taskId,
      taskType: event.taskType,
      channelArn: event.channelArn,
      // Per-assistant task machines (SPEC-CONFIGURABLE-ASSISTANTS 4.5): the resolved active version's
      // machines are preferred over the deployment pack (undefined ⇒ the pack, byte-identical).
      machines: active.machines,
      // Who holds the task while the assistant is working, and who it returns to once the person has
      // answered. Without it a task that entered a waiting state would stay in the user's queue
      // after they had already dealt with it.
      assistantId: principalIdFromArn(event.botArn),
    });

    // Attachment-in (non-battle): the user sent an image/PDF/doc — fetch it and attach a Converse
    // image or document block so the assistant can read it. Best-effort: a fetch/format miss degrades
    // to a normal text turn. Skipped on /battle turns (battle carries its image via battleContext).
    let imageInput: BedrockImageInput | undefined;
    let documentInput: BedrockDocumentInput | undefined;
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
          if (imgFmt) {
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
          console.log('[AssistantAsyncProcessor] attachment-in', { type: event.attachment.contentType, kind: imgFmt ? 'image' : 'document' });
        } else {
          console.warn('[AssistantAsyncProcessor] attachment type not supported by Converse:', event.attachment.contentType);
        }
      } catch (e) {
        console.warn('[AssistantAsyncProcessor] attachment fetch failed (non-fatal):', e);
      }
    } else if (!battleOn && event.attachment?.fileKey && !attachmentOwnedBySender) {
      console.warn('[AssistantAsyncProcessor] attachment fileKey not under the sender prefix; ignoring (possible cross-user reference)');
    }

    // ── Generation-out: produce an IMAGE from the prompt instead of text. This is now a NORMAL
    // capability (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "image generation must become a normal
    // capability"), not a battle-only branch. Evaluated FIRST and mutually exclusive with vision-in.
    // Resolve the image-gen model id, in precedence:
    //   1. the battle variant's image model (battleContext.variantImageModelKey) — image battle;
    //   2. the legacy battle imageGenModelId (resolveBattleImageGenPair path) — kept working;
    //   3. the active profile's models.image, ONLY on an `image_generation` turn — the normal path.
    // Absent/unknown id => 'text'; a present-but-unknown id is surfaced visibly, never string-matched away.
    let battleImageCount: number | undefined;
    // Delivered message attachment (a generated image here, or a generated document below). Declared
    // once and shared: a generation-out turn sets an image attachment; the doc-generation block only
    // runs when no attachment is set yet, so the two paths never clobber each other.
    let attachment: GeneratedDocument | undefined;
    const genOutModelId = resolveTurnImageGenModelId({
      battleOn,
      intent: event.intent,
      variantImageModelKey: event.battleContext?.variantImageModelKey,
      battleImageGenModelId: event.battleContext?.imageGenModelId,
      // Non-battle image experiment: the resolved variant's image model (router → event) wins over the
      // profile default on an image_generation turn, so normal traffic A/Bs the variants' image models.
      experimentImageModelKey: event.resolvedImageModelKey,
      profileImageModelKey: active.imageModelKey,
    });
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
    if (event.intent === 'image_generation' && genOutPlan.action !== 'generation') {
      const reason = genOutModelId
        ? `resolved image model "${genOutModelId}" is not a registered image model`
        : 'no image model is configured for this turn';
      const where = battleOn
        ? "the battle variant carries no image model (its `imageGenModelKey`), so the variant's TEXT "
          + 'model was all that was available'
        : "the profile's `models.image` is unset";
      console.error(
        '[AssistantAsyncProcessor] image_generation turn cannot run: ' + reason + ' — ' + where,
        { imageGenModelId: genOutModelId, battleOn, intent: event.intent },
      );
      await handleProcessingError(
        event,
        new Error(
          'image_generation turn cannot run: ' + reason + ' — ' + where
            + '. No image model is configured for this assistant.',
        ),
      );
      return;
    }
    // Honest degrade (no crash): image generation needs the attachments bucket (to persist the PNG).
    // The guardrail + cost-cap env (BATTLE_IMAGE_GUARDRAIL_ID, BATTLE_IMAGE_MAX_IMAGES/DIMENSION,
    // IMAGE_GEN_KEYS_SECRET_ARN) are wired on the PREMIUM processor, so normal image gen works there. A
    // non-premium profile that sets models.image but whose processor lacks the bucket degrades to a
    // normal text turn rather than throwing in persistImageGenOutput.
    // TODO(phase2b): wire the image env (ATTACHMENTS_BUCKET + BATTLE_IMAGE_* guardrail/caps +
    // IMAGE_GEN_KEYS_SECRET_ARN) on the non-premium processors so they can generate images too.
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
          'processor; degrading to a text turn. TODO(phase2b): wire image env on non-premium processors.',
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
        variantModelKey: battleVariantModelKey,
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
            systemPrompt += buildRebuttalImageNote(event.battleContext?.rivalDisplayName);
            console.log('[AssistantAsyncProcessor][battle] round-2 rebuttal sees rival image(s) via conversation', { attached });
          }
        } catch (e) {
          console.warn('[AssistantAsyncProcessor][battle] rival image resolution failed; text-only rebuttal:', e);
        }
      } else {
        console.log('[AssistantAsyncProcessor][battle] round-2 model not vision-capable; text-only rebuttal');
      }
    }

    if (canGenerateImage) {
      // No Bedrock text call: invoke the image model, persist to S3, deliver the image as a message
      // ATTACHMENT (like a generated document) so the frontend AttachmentDisplay renders an <img> that
      // fetches a fresh presigned URL on demand — no giant presigned URL embedded in the content, no
      // STS-token expiry, and it renders in the browser (the old inline <!--battleimage:--> marker did
      // not). Honest empty path: a generation failure or guardrail block persists nothing, attaches
      // nothing, and yields an honest text line (never a fabricated image).
      const genStart = Date.now();
      // Phase-4D deployer cost cap (env-sourced; only ever lowers the registry hard cap).
      const envInt = (v: string | undefined): number | undefined => {
        const n = Number(v);
        return v != null && Number.isFinite(n) ? n : undefined;
      };
      // Guardrails are REGIONAL and image models are not always local: the Stability generators are
      // us-west-2-only, so a us-east-1 deployment invokes them cross-region. Resolve the guardrail
      // that exists in the region this call actually goes to.
      const genKey = imageGenModelIdToKey(genOutPlan.modelId);
      const genRegion = imageGenRegionFor(genKey ? IMAGE_GEN_MODELS[genKey] : undefined);
      const guard = imageGuardrailFor(genRegion);
      if (!guard) {
        // REFUSE rather than generate unguarded. Dropping the guardrail would produce an image and a
        // green test while content moderation was silently off - the failure mode that hides longest.
        // Deliberately loud: this is a deployment gap (no guardrail provisioned in that region), and
        // the honest empty path below already handles "no image" without fabricating one.
        console.error(
          `[AssistantAsyncProcessor][image] no guardrail provisioned in ${genRegion}; refusing to `
          + 'generate rather than run unmoderated. Provision a guardrail there '
          + '(BATTLE_IMAGE_GUARDRAIL_BY_REGION) and redeploy.',
        );
        throw new Error(`image generation blocked: no content guardrail available in ${genRegion}`);
      }
      const gen = await invokeImageGenModel(genOutPlan.modelId!, event.userMessage || '', {
        guardrailIdentifier: guard.id,
        guardrailVersion: guard.version,
        maxImagesCap: envInt(process.env.BATTLE_IMAGE_MAX_IMAGES),
        maxDimensionCap: envInt(process.env.BATTLE_IMAGE_MAX_DIMENSION),
      });
      const out = await persistImageGenOutput({
        images: gen.images,
        bucket: process.env.ATTACHMENTS_BUCKET || '',
        channelArn: event.channelArn,
        modelId: genOutPlan.modelId!,
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
          modelId: genOutPlan.modelId!,
          displayName: genOutPlan.displayName,
          guardrailIntervened: gen.guardrailIntervened,
        }),
        inputTokens: 0,
        outputTokens: 0,
        bedrockTime: Date.now() - genStart,
        modelUsed: genOutPlan.modelId!,
        wasFallback: false,
        retryCount: gen.retryCount,
      };
    } else if (imgAtt) {
      // ── /battle vision-in: decide per-variant whether to send the image or reject text-only.
      const visionPlan = resolveBattleVisionPlan({
        variantModelKey: battleVariantModelKey,
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
          bedrockResult = await invokeBedrockWithFallback(
            systemPrompt,
            bedrockMessages,
            invokeConfig,
            resolution.fallbackModelId,
            { imageInput: { format: visionPlan.imageFormat!, bytes }, cacheableSystemPrefixLength },
          );
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
      const extInputGuard = await applyInputGuardrail(event.userMessage || '', active.guardrailId);
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
        };
      } else {
      try {
        const ext = await invokeExternalLlm(cnCfg, systemPrompt, bedrockMessages, {
          maxTokens: resolveMaxTokens(event, false),
          temperature: CONFIG.temperature,
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
          enableCompanyContextTool: true,
          enableEditTools,
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
        { enableCompanyContextTool: true, enableEditTools, imageInput, documentInput, cacheableSystemPrefixLength, taskContext },
      );
    }

    // On plan conversations, extract any ```suggestions JSON block the model emitted into a
    // `<!--suggestions:-->` marker (model-agnostic — works for R1, which can't use tools). The
    // visible prose is unchanged; the widget renders cards from the marker.
    // Strip any leaked reasoning scaffolding (`<thinking>…</thinking>`, `<result>` wrappers) the model
    // sometimes emits in its FINAL answer — never intended for the human, and it also poisons the
    // generated report file if left in. Not a control marker, so stripMessageMarkers wouldn't catch it.
    const response = stripReasoningTags(
      event.domainContext ? extractSuggestions(bedrockResult.response) : bedrockResult.response,
    );

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
        (taskContext.transitions ?? []).some((t) => t.to === 'awaiting_completion');
      if (reachedAwaitingCompletion) {
        const roster = Array.isArray(event.participants) ? (event.participants as RosterParticipant[]) : [];
        await postTaskHandoffNotice({
          channelArn: event.channelArn,
          botArn: event.botArn,
          task: taskContext.task,
          roster,
          senderArn: event.senderArn,
        });
      }
    }

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
      const mergedMachines = { ...taskStateMachines(), ...(activeProfile.machines ?? {}) };
      const taskMachine = event.taskType ? mergedMachines[event.taskType] : undefined;
      const deliveryStates = taskMachine
        ? Object.entries(taskMachine.states).filter(([, d]) => d.delivers).map(([name]) => name)
        : [];
      if (event.taskType && event.taskId && deliveryStates.length > 0) {
        // THE DELIVERY CONTRACT IS DECLARED, NOT INFERRED (owner decision 2026-08-18). The model is
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
        const declaredDelivery = (taskContext?.transitions ?? []).some((t) =>
          deliveryStates.includes(t.to)
          || (deliveryStates.includes(t.from) && taskMachine?.states[t.to]?.terminal !== undefined));
        // IN-STATE REWRITE: a follow-up inside a delivering state ("add a section on churn", asked
        // while the task sits in `generating`/`revising`) legitimately re-produces the whole
        // document with NO legal transition to declare, so a declaration-only gate posted the full
        // rewritten report as an inline wall of chat text. Restored from the pre-contract shape with
        // two guards the declared path does not need: the artifact floor below, and a
        // trailing-question veto - the single structural residue of the retired heuristic, kept
        // because the live incident that demoted it (a proposed outline ATTACHED as the report while
        // still asking for approval) ended with exactly such a question, and end-punctuation is
        // language-neutral where the English phrase list was not.
        const trimmedResponse = response.trim();
        const inStateRewrite =
          startState !== undefined
          && deliveryStates.includes(startState)
          && (taskContext?.transitions ?? []).length === 0
          && !/[?？؟]$/.test(trimmedResponse);
        // The 400-char floor is a MINIMUM ARTIFACT SIZE, not a return of the shape heuristic: a
        // delivery below it still advances and completes identically, but its content posts as chat
        // text instead of a file - a one-sentence extraction shipped as a downloadable document
        // buries the answer behind a click (measured live: a single-fact codename landed as an
        // attachment nobody asked for). Above the floor, the machine decides.
        generate = (declaredDelivery || inStateRewrite) && trimmedResponse.length >= 400;
        // SHADOW: the retired heuristic, log-only (same treatment as shadowKeywordTransition). A
        // deliverable-shaped output with NO declared delivery transition is the model
        // under-declaring — the case the heuristic existed for — and is now measured instead of
        // silently acted on.
        if (!declaredDelivery && !inStateRewrite && isDeliverableDocument(response)) {
          console.log('[AssistantAsyncProcessor][shadow] deliverable_shaped_without_declared_state', {
            taskId: event.taskId, taskType: event.taskType, state: startState ?? 'unknown',
          });
        }
      } else {
        // Ad-hoc (no report task): the user explicitly asked to save THIS response as a document.
        generate = isDocumentRequest(event.userMessage || '');
      }

      // In a /battle, round-1 of a report battle produces its deliverable in one shot (there is no
      // multi-step state machine across rounds), so deliver it as a downloadable attachment
      // deterministically, bypassing the state-machine delivery gate. Round-2 is the rebuttal turn.
      // Non-battle multi-step report tasks are unaffected.
      if (!generate
        && event.battleContext?.round === 1
        && event.taskType === 'report_generation') {
        generate = true;
      }

      if (generate) {
        try {
          attachment = await generateAndUploadDocument(
            response, event.channelArn, event.taskType || 'document', process.env.ATTACHMENTS_BUCKET,
          );
          console.log('[AssistantAsyncProcessor] Document generated:', attachment.fileKey);
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
    let deliverMessageId = messageId;
    if (!deliverMessageId) {
      deliverMessageId = await scanForPlaceholderMessage(
        event.channelArn,
        event.correlationId,
        event.botArn,
      );
      console.log('[AssistantAsyncProcessor] Deferred placeholder resolution', {
        correlationId: event.correlationId,
        resolved: !!deliverMessageId,
        messageId: deliverMessageId ?? undefined,
      });
    }

    if (!deliverMessageId) {
      // The placeholder genuinely does not exist. Report it rather than posting a replacement: a
      // replacement duplicates the answer and strands a "One moment..." bubble (DESIGN-BATTLE,
      // "nothing appears-then-vanishes"). The answer is lost, and that is the honest outcome to
      // record - see TROUBLESHOOTING.md #19.
      console.error(
        '[AssistantAsyncProcessor] No placeholder for correlationId after the answer was ready:',
        event.correlationId,
        '- the reply cannot be delivered. Not posting a replacement.',
      );
      if (event.taskId) {
        await updateTaskStatus(event.taskId, event.channelArn, 'failed', undefined, 'Placeholder message not found')
          .catch((e) => console.error('[AssistantAsyncProcessor] task status update failed:', e));
      }
      return;
    }

    // Finalize response
    await finalizePlaceholderResponse({
      event,
      response,
      model: bedrockResult.modelUsed,
      inputTokens: bedrockResult.inputTokens,
      outputTokens: bedrockResult.outputTokens,
      bedrockTime: bedrockResult.bedrockTime,
      messageId: deliverMessageId,
      pollTime,
      conversationHistoryLength: consolidatedHistory.length,
      startTime,
      activeTaskInfo,
      taskContext,
      attachment,
      // The structural block fact, never inferred from the reply's text shape.
      guardrailBlocked: bedrockResult.inputGuardBlocked,
      wasFallback: bedrockResult.wasFallback,
      fallbackReason: bedrockResult.fallbackReason,
      retryCount: bedrockResult.retryCount,
      configIdentity,
      // Attribute this turn to the exact assistant/profile + version that served it (SPEC-ASSISTANT-CONFIG §4)
      // — not just its classification. `active.configId` is the portable-profile VERSION fingerprint.
      profileAttribution: { profileName: PROFILE_NAME, profileConfigId: active.configId },
      ...(battleImageCount != null && { imageCount: battleImageCount }),
      ...(battleSelfDisplayName && { battleSelfDisplayName }),
      steps: bedrockResult.steps,
      modelMs: bedrockResult.modelMs,
      toolMs: bedrockResult.toolMs,
    });

    // Seed the conversation summary from THIS exchange, on the same first turn that names the
    // conversation. Drift compares against the summary, so without a turn-one anchor it cannot fire
    // at all until the scheduled summariser catches up - every early turn skips with
    // `drift_skipped_no_summary`, which is precisely the window where a user is most likely to
    // pivot. The exchange is passed straight from memory: reading it back from Aurora would wait on
    // the Kinesis + archival lag this exists to remove. Awaited for the same reason as the rename
    // below (the environment freezes on resolve); the actual summarisation runs asynchronously.
    if (pipeline.isFirstUserTurn && event.channelArn && event.userMessage && response) {
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
    await handleProcessingError(event, error);
  }
};
