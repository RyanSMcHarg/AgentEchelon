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
  firstTurnGreetingDirective,
  handleProcessingError,
  finalizePlaceholderResponse,
  generateAndUploadDocument,
  isDocumentRequest,
  isDeliverableDocument,
  getTaskLabel,
  applyOutputGuardrail,
  WORK_ITEM_OPENAI_TOOLS,
  WORK_ITEM_TOOL_NAMES,
  proposalMarker,
  extractSuggestions,
  postTaskHandoffNotice,
  imageFormatFromContentType,
  docFormatFromContentType,
  buildRebuttalContext,
  buildBattleAwareness,
  resolveBattleVisionPlan,
  resolveGenerationOutPlan,
  resolveTurnImageGenModelId,
  buildTaskLoopContext,
  shadowKeywordTransition,
  recordStallIfNoTransition,
  type BedrockImageInput,
  type BedrockDocumentInput,
} from './lib/async-processor-core.js';
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
import { invokeImageGenModel } from './lib/image-gen-models.js';
import { persistImageGenOutput, buildBattleImageContent, buildImageGenAttachment } from './lib/image-gen-output.js';
import { buildRetrievedContextHint, buildConversationSummaryHint } from './analytics-aurora/document-retrieval.js';
import {
  getTask,
  buildTaskContextForPrompt,
  buildCrossChannelTasksHint,
  getActiveTasksForUser,
  type Task,
} from './lib/task-tracking.js';
import { resolveModelForIntent } from './lib/model-resolver.js';
import { clampResponseMaxTokens } from './lib/intent-pack.js';
import { legalTransitionsFrom } from './lib/task-state-machines.js';
import { taskHasMachine } from './lib/task-tools.js';
import { getModelCatalog, INTENT_ROUTE_STRATEGY, DEFAULT_PROFILE_MODEL_SELECTION, bedrockInvokeId } from '../../lib/config/model-strategy.js';
import { resolveActiveProfile, buildIntentStrategy } from './lib/active-profile.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
// SPEC-PORTABLE-VERSIONED-PROFILES P0: root for the per-profile SSM namespace (/{root}/assistant/{name}/…).
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

// The serving profile (= the classification's profile name, e.g. 'basic'/'standard'/'premium').
// Set by the assistant-profile stack; drives the persona default + the model-strategy userType key.
const PROFILE_NAME = (process.env.PROFILE_NAME || 'basic') as AsyncProcessorConfig['userType'];
// profile.battleEligible, forwarded as an env string. /battle assembly + image paths are gated on it.
const BATTLE_ELIGIBLE = process.env.BATTLE_ELIGIBLE === 'true';
const MODEL_NAME = process.env.MODEL_NAME || 'Claude';

const s3Client = new S3Client({ region: AWS_REGION });
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
    channelArn: event.channelArn?.substring(0, 50),
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
    const baseSystemPrompt = await resolveBaseSystemPrompt();

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

    // Load task context if task-based: fold the standing per-state guidance + the task's own context
    // into the prompt, and stamp activeTaskInfo (with taskId) so the reply archives with task_id.
    let activeTaskInfo: { type: string; status: string; label: string; taskId: string } | undefined;
    if (event.taskId && event.taskType) {
      const task = await getTask(event.taskId, event.channelArn);
      if (task) {
        systemPrompt += buildTaskSystemPrompt(event.taskType, task.taskState || '', task);
        systemPrompt += buildTaskContextForPrompt(task);
        activeTaskInfo = {
          type: event.taskType,
          status: task.taskState || task.status,
          label: getTaskLabel(event.taskType, task.taskState || ''),
          // taskId is what the archival reads onto the exchange (task_id).
          taskId: event.taskId,
        };
      }
    }

    // P2.4 cross-channel task awareness — best-effort hint about open work in the user's OTHER
    // channels. Failure is never fatal — the hint augments judgment, the conversation proceeds.
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
      // TODO(phase1b): profileRef variants. `variantModelKey` is a resolved modelKey today (the
      // fan-out resolvers resolve a profileRef variant to its modelKey upstream). If a variant ever
      // arrives unresolved, this stays undefined and the model application below falls back to the
      // profile's normal resolution rather than crashing.
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
    // P0 (SPEC-PORTABLE-VERSIONED-PROFILES): the profile's BASE model comes from the ACTIVE version in
    // SSM, not the deploy-time default — so activating a new profile version re-models the assistant
    // with NO redeploy. Fail-closed to the compiled seed (== today's deploy default), so a deployment
    // that never versions behaves byte-identically. A version whose modelKey is not in this catalog is
    // ignored here (the deploy-time default holds) — the §7 model-ARN boundary is deploy-owned; a
    // version selects WITHIN it, never beyond. Battle/experiment models still win over this base below.
    const active = await resolveActiveProfile(PROFILE_NAME, { ssm: ssmClient, ssmRoot: SSM_ROOT });
    const activeModelKey = active.profile.modelKey;
    const baseModelSelection = (catalog as Record<string, unknown>)[activeModelKey]
      ? { ...DEFAULT_PROFILE_MODEL_SELECTION, [CONFIG.userType]: activeModelKey }
      : DEFAULT_PROFILE_MODEL_SELECTION;
    // U2 (SPEC-ASSISTANT-CONFIG §4): per-intent model routing comes from THIS profile version's
    // `models.byIntent`, not the global strategy table. The seed copies the global strategy per-profile,
    // so this is byte-identical until an operator edits a version; fail-closed to the global strategy
    // when a version carries no per-intent routing.
    const profileStrategy = buildIntentStrategy(active.models) ?? INTENT_ROUTE_STRATEGY;
    const resolution = resolveModelForIntent(
      event.intent || event.resolvedModel,
      CONFIG.userType,
      catalog,
      profileStrategy,
      baseModelSelection,
    );
    const variantDef = battleVariantModelKey
      ? catalog[battleVariantModelKey as keyof typeof catalog]
      : undefined;
    const variantBedrockModelId = variantDef ? bedrockInvokeId(variantDef) : undefined;
    const effectiveModel = variantBedrockModelId || event.resolvedModel || resolution.primaryModelId;
    // SPEC-ASSISTANT-CONFIG §4 — per-profile tool allowlist: the active version's `tools` gate which tools
    // the Converse loop may offer (undefined ⇒ all available, byte-identical to before). Flows into
    // bedrockInvokeConfig below (which spreads invokeConfig).
    const invokeConfig = { ...CONFIG, model: effectiveModel, tools: active.tools };
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
    };

    // SPEC-TASK-STATE-TRANSITIONS: active-task context for the in-loop advance_task_state tool
    // (undefined unless this turn belongs to a machine-backed task). Passing it registers the tool.
    // All profiles are taskSupport:'full', so this is wired uniformly.
    const taskContext = await buildTaskLoopContext({
      taskId: event.taskId,
      taskType: event.taskType,
      channelArn: event.channelArn,
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
            const safeName = (event.attachment.name || 'document').replace(/[^a-zA-Z0-9 .\-()[\]]/g, ' ').slice(0, 200) || 'document';
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
    // Honest degrade (no crash): image generation needs the attachments bucket (to persist the PNG).
    // The guardrail + cost-cap env (BATTLE_IMAGE_GUARDRAIL_ID, BATTLE_IMAGE_MAX_IMAGES/DIMENSION,
    // IMAGE_GEN_KEYS_SECRET_ARN) are wired on the PREMIUM processor, so normal image gen works there. A
    // non-premium profile that sets models.image but whose processor lacks the bucket degrades to a
    // normal text turn rather than throwing in persistImageGenOutput.
    // TODO(phase2b): wire the image env (ATTACHMENTS_BUCKET + BATTLE_IMAGE_* guardrail/caps +
    // IMAGE_GEN_KEYS_SECRET_ARN) on the non-premium processors so they can generate images too.
    const canGenerateImage = genOutPlan.action === 'generation' && !!process.env.ATTACHMENTS_BUCKET;
    if (genOutPlan.action === 'generation' && !canGenerateImage) {
      console.warn(
        '[AssistantAsyncProcessor] resolved an image model but ATTACHMENTS_BUCKET is unset on this ' +
          'processor; degrading to a text turn. TODO(phase2b): wire image env on non-premium processors.',
        { modelId: genOutPlan.modelId, profile: PROFILE_NAME },
      );
    }
    const imgAtt = battleOn ? event.battleContext?.imageAttachment : undefined;

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
      const gen = await invokeImageGenModel(genOutPlan.modelId!, event.userMessage || '', {
        guardrailIdentifier: process.env.BATTLE_IMAGE_GUARDRAIL_ID,
        guardrailVersion: process.env.BATTLE_IMAGE_GUARDRAIL_VERSION,
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
      // providers, so apply the compensating output check explicitly. Any failure degrades to Bedrock.
      const t0 = Date.now();
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
        const guarded = await applyOutputGuardrail(extText);
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
      // Document-producing tasks and the machine states on which they DELIVER a file. Keyed on
      // taskType so report_generation and data_extraction both hand back a real downloadable
      // document; guided_troubleshooting / work-item tasks are interactive and never attach.
      const DOC_DELIVERY_STATES: Record<string, string[]> = {
        report_generation: ['generating', 'revising'],
        data_extraction: ['extracting', 'validating', 'formatting'],
      };
      if (event.taskType && event.taskId && DOC_DELIVERY_STATES[event.taskType]) {
        // Deliver the document (a finished report, or a formatted data extraction) as a downloadable
        // file on the turn the model actually PRODUCES it, detected DETERMINISTICALLY from the OUTPUT
        // (isDeliverableDocument: substantial + structured) — NOT from the task's machine state. The
        // model reliably writes the deliverable but does NOT reliably advance the state machine to its
        // delivery state on that turn (reports often emit while still in 'drafting_outline'), so a
        // state-based gate silently dropped the file. A short clarifying/outline turn fails
        // isDeliverableDocument, so a few-line follow-up is never turned into a file (the original
        // "clarifying-text-as-attachment" bug stays fixed). Belt-and-suspenders fallback: the task
        // clearly entered a delivery state this turn (or started there) and produced non-trivial
        // content. Do NOT use isDocumentRequest here: it matches the user's original ask on EVERY turn.
        const startState = activeTaskInfo?.status;
        const deliveryStates = DOC_DELIVERY_STATES[event.taskType];
        const inDeliveryState =
          (startState !== undefined && deliveryStates.includes(startState)) ||
          (taskContext?.transitions ?? []).some((t) => deliveryStates.includes(t.to));
        generate = isDeliverableDocument(response) || (inDeliveryState && response.trim().length >= 400);
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
    }

    // Finalize response
    await finalizePlaceholderResponse({
      event,
      response,
      model: bedrockResult.modelUsed,
      inputTokens: bedrockResult.inputTokens,
      outputTokens: bedrockResult.outputTokens,
      bedrockTime: bedrockResult.bedrockTime,
      messageId: messageId!,
      pollTime,
      conversationHistoryLength: consolidatedHistory.length,
      startTime,
      activeTaskInfo,
      taskContext,
      attachment,
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
    });

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
