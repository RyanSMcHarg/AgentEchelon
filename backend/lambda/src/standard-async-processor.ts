/**
 * Standard Async Processor
 *
 * Tier-specific async processor for Standard users.
 * Uses Sonnet model with task-aware processing.
 * Handles multi-turn state transitions for all three task types.
 *
 * Pipeline: poll placeholder -> load history -> build task context -> invoke Bedrock -> detect state transitions -> update message
 */

import {
  AsyncProcessorEvent,
  AsyncProcessorConfig,
  GeneratedDocument,
  runSharedPipeline,
  handleProcessingError,
  finalizePlaceholderResponse,
  generateAndUploadDocument,
  isDocumentRequest,
  getTaskLabel,
  detectStateTransition,
  applyOutputGuardrail,
  WORK_ITEM_OPENAI_TOOLS,
  WORK_ITEM_TOOL_NAMES,
  proposalMarker,
  extractSuggestions,
  postTaskHandoffNotice,
  imageFormatFromContentType,
  docFormatFromContentType,
  type BedrockImageInput,
  type BedrockDocumentInput,
} from './lib/async-processor-core.js';
import { fetchAttachmentBytes, senderOwnsAttachmentKey } from './lib/attachment-bytes.js';
import type { RosterParticipant } from './lib/channel-notify.js';
import { buildConfigIdentity, componentVersion } from './lib/config-identity.js';
import { buildSystemPrompt } from './lib/context-framework.js';
import { createHostContextRegistry } from './lib/host-context-resolvers.js';
import { invokeBedrockWithFallback } from './lib/bedrock-resilience.js';
import { buildTaskLoopContext, shadowKeywordTransition, recordStallIfNoTransition } from './lib/async-processor-core.js';
import { makeConverseStep, type ConverseStep } from './lib/analytics-metadata.js';
import { resolveModelPlan } from './lib/resolve-model-plan.js';
import { externalProviderFromEnv, invokeExternalLlm } from './lib/providers/external-llm.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { buildRetrievedContextHint, buildConversationSummaryHint } from './analytics-aurora/document-retrieval.js';
import {
  getTask,
  advanceTaskState,
  buildTaskContextForPrompt,
  buildCrossChannelTasksHint,
  getActiveTasksForUser,
  TASK_STATE_MACHINES,
  type Task,
} from './lib/task-tracking.js';

const CONTEXT_BUCKET = process.env.CONTEXT_BUCKET || '';
const s3ContextClient = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

// The host's per-turn context resolvers (domain context, participant profile),
// built once at cold start. A registry + defensive composer replaces hardwired
// `systemPrompt += formatX(event)` branches. Generic AE turns resolve to empty sections.
const hostContextRegistry = createHostContextRegistry();

// (Removed the dead `loadS3Context` path — it read an unprovisioned key and was
// never called. Company context reaches the model via the load_company_context
// tool + per-tier digest + RAG; see docs/GUIDE-ASSISTANT-CONTEXT.md.)
import { resolveModelForIntent } from './lib/model-resolver.js';
import { clampResponseMaxTokens } from './lib/intent-pack.js';
import { getModelCatalog, INTENT_ROUTE_STRATEGY, DEFAULT_TIER_MODEL_SELECTION } from '../../lib/config/model-strategy.js';

const CONFIG: AsyncProcessorConfig = {
  model: process.env.MODEL_ID || 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  maxTokens: 4096,
  temperature: 0.7,
  userType: 'standard',
};
const MODEL_NAME = process.env.MODEL_NAME || 'Claude Sonnet';

// Per-intent response budget. The router forwards the intent's
// `responseSettings.maxTokens` (from the pack) in the event; it WINS, clamped to the tier ceiling
// (CONFIG.maxTokens) with a reasoning floor (see clampResponseMaxTokens, unit-tested). Absent ⇒ the
// tier default. This is how a deployment sizes answers per intent (tight logistics, longer research)
// via config, no code.
function resolveMaxTokens(event: AsyncProcessorEvent, reasoning: boolean): number {
  return clampResponseMaxTokens(event.responseSettings?.maxTokens, CONFIG.maxTokens, reasoning);
}

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant in Agent Echelon, an enterprise conversational AI platform. Users interact with you through a chat interface. You are running on the Standard tier (${MODEL_NAME}), offering a balance of capability and speed.

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

// Per-deployment persona override. AE ships the generic default above; a deployment (e.g. the
// host deployment) supplies its own concierge persona so the assistant speaks
// in-domain (AgentEchelon stays generic — the persona lives in the deployment). A rich persona can
// exceed AWS Lambda's 4 KB total env-var cap, so it's read from an SSM parameter
// (ASSISTANT_SYSTEM_PROMPT_PARAM) at cold start, falling back to the inline env, then the default.
let cachedSystemPrompt: string | null = null;
async function resolveBaseSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  const param = process.env.ASSISTANT_SYSTEM_PROMPT_PARAM?.trim();
  if (param) {
    try {
      const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
      const r = await ssm.send(new GetParameterCommand({ Name: param }));
      if (r.Parameter?.Value?.trim()) {
        cachedSystemPrompt = r.Parameter.Value.trim();
        return cachedSystemPrompt;
      }
    } catch (e) {
      console.error('[StandardAsyncProcessor] system-prompt SSM hydrate failed; using env/default:', e);
    }
  }
  cachedSystemPrompt = process.env.ASSISTANT_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT;
  return cachedSystemPrompt;
}

/**
 * Build task-specific system prompt additions
 */
function buildTaskSystemPrompt(taskType: string, taskState: string, task?: Task | null): string {
  switch (taskType) {
    case 'guided_troubleshooting':
      return getGuidedTroubleshootingPrompt(taskState);
    case 'data_extraction':
      return getDataExtractionPrompt(taskState);
    case 'report_generation':
      return getReportGenerationPrompt(taskState);
    case 'place_item':
      return getPlaceItemPrompt(taskState);
    case 'action_item':
      return getActionItemPrompt(taskState, task);
    default:
      return '';
  }
}

// Action item. A tracked, assignable real-world action.
// The assistant never completes it in-app — it gathers details, presents options + concrete
// steps/deep-links, and the participant completes it off-platform. On a shared plan it confirms WHO
// owns the action (the roster is in the domain context); a due-by date is captured when it matters.
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

// Place-an-item task. The task persists the intent across
// turns + anchors it to the plan; the per-state prompt drives the gather → propose → confirm flow.
// The persona already tells the assistant HOW to place (position + afterItemId); this keeps it on-task.
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
- Explain what you're extracting and from where
- Show progress or intermediate results if applicable`;

    case 'validating':
      return `\n\n## CURRENT TASK: Data Extraction - Validating
Validate the extracted data:
- Check for completeness and accuracy
- Highlight any anomalies or missing data
- Ask the user to confirm the results look correct`;

    case 'formatting':
      return `\n\n## CURRENT TASK: Data Extraction - Formatting
Format the validated data for delivery:
- Apply the requested output format
- Add any requested calculations or transformations
- Present the final results clearly`;

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
Generate the report content:
- Follow the approved outline
- Include relevant data and analysis
- Use appropriate formatting (headers, tables, etc.)`;

    case 'revising':
      return `\n\n## CURRENT TASK: Report Generation - Revising
Revise the report based on user feedback:
- Make requested changes
- Highlight what was modified
- Ask if further revisions are needed`;

    default:
      return '\n\n## CURRENT TASK: Report Generation\nHelp the user create their report.';
  }
}

export const handler = async (event: AsyncProcessorEvent): Promise<void> => {
  const startTime = Date.now();
  console.log('[StandardAsyncProcessor] Invoked', JSON.stringify({
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

    const { messageId, pollTime, consolidatedHistory, priorAgentContext, bedrockMessages } = pipeline;

    // Build system prompt with task context
    const baseSystemPrompt = await resolveBaseSystemPrompt();

    // P4 config attribution — fingerprint the deployment config (persona resolved here + the pack
    // version the router forwarded) so this turn's analytics is sliceable by config, not just model.
    // Derived from the BASE prompt only (pre context/task append) so the id is a stable per-deploy
    // value, not per-turn. A fall-through to the platform default reads as personaVersion='default'.
    const configIdentity = buildConfigIdentity({
      personaVersion: baseSystemPrompt === DEFAULT_SYSTEM_PROMPT ? 'default' : componentVersion(baseSystemPrompt),
      intentPackVersion: event.intentPackVersion ?? 'default',
      systemPromptHash: componentVersion(baseSystemPrompt, 'empty'),
    });

    // P6: persona + host per-turn context (domain grounding + i18n + participant profile), assembled
    // via the resolver registry + defensive composer (was two hardwired `+=`). Each resolver no-ops to
    // '' for non-plan AE conversations, so the composed prompt is byte-identical for every channel.
    let systemPrompt = buildSystemPrompt(baseSystemPrompt, hostContextRegistry.resolveSections(event));
    // The stable base (persona + host per-turn context) is complete here;
    // capture its length so invokeBedrock can insert a Bedrock cachePoint after
    // it (the dynamic per-turn appends below fall in the uncached suffix).
    // See docs/GUIDE-ASSISTANT-CONTEXT.md.
    const cacheableSystemPrefixLength = systemPrompt.length;

    // (Removed: the legacy static `standard/context.json` paste. It read an unprovisioned key
    // (the tool loop reads context/{tier}/*, a different location) so it always no-op'd, and a
    // whole-file paste is the anti-pattern ADR-011 replaced with the load_company_context tool.)

    // Load task context if task-based
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

    // P2.4 cross-channel task awareness — see premium processor for
    // rationale. Best-effort hint about open work in other channels.
    try {
      const userSub = event.senderArn?.split('/user/').pop() || '';
      if (userSub) {
        const crossChannelTasks = await getActiveTasksForUser(userSub);
        const hint = buildCrossChannelTasksHint(event.channelArn, crossChannelTasks);
        if (hint) systemPrompt += hint;
      }
    } catch (err) {
      console.warn('[StandardAsyncProcessor] cross-channel task hint failed (non-fatal):', err);
    }

    // RAG — retrieved by the router (VPC-attached Lambda); we just
    // format the hint here. Standard tier sees the same payload the
    // router built; the router's retrieveContext call applies the
    // tier-scope filter based on the classified caller tier.
    if (event.retrievedContext) {
      const ragHint = buildRetrievedContextHint(event.retrievedContext);
      if (ragHint) systemPrompt += ragHint;
    }

    // Conversation summary as consumable context (ADR-017); no-op when short.
    systemPrompt += buildConversationSummaryHint(event.conversationSummary);

    if (priorAgentContext) {
      systemPrompt += `\n\n[You already said the following — do NOT repeat it. Use completely different wording.]\n${priorAgentContext.trim()}`;
    }

    // Resolve model for this intent (respects tier boundaries)
    const catalog = getModelCatalog(process.env.AWS_REGION || 'us-east-1', process.env.AWS_ACCOUNT_ID || '');
    const resolution = resolveModelForIntent(
      event.intent || event.resolvedModel,
      CONFIG.userType,
      catalog,
      INTENT_ROUTE_STRATEGY,
      DEFAULT_TIER_MODEL_SELECTION,
    );
    const effectiveModel = event.resolvedModel || resolution.primaryModelId;
    const invokeConfig = { ...CONFIG, model: effectiveModel };

    // Context-aware model routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING), flag-gated. When
    // ENABLE_CONTEXT_ROUTING is off, `plan` is null and the Bedrock path below is
    // unchanged. PREFERRED CN path is DeepSeek-on-Bedrock (in-AWS, intent-routed R1/V3 — no consent
    // gate); the external provider is used only when no Bedrock CN model is configured.
    const contextRoutingOn = process.env.ENABLE_CONTEXT_ROUTING === 'true';
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
              tier: CONFIG.userType,
              intent: event.intent,
              experimentModelId: event.resolvedModel,
              userLanguage: event.userLanguage,
              // Geography routing (rule 2): the dominant geo segment forwarded from the host. A CN
              // segment routes to the CN model even when the user's global language isn't zh.
              segment: event.segment,
            },
            {
              catalog,
              strategy: INTENT_ROUTE_STRATEGY,
              tierDefaults: DEFAULT_TIER_MODEL_SELECTION,
              enabled: true,
              cnBedrock,
              cnProvider: cnCfg ? { provider: cnCfg.provider, modelId: cnCfg.model } : null,
              externalConsentDefault: process.env.EXTERNAL_MODEL_CONSENT_DEFAULT === 'true',
            },
          )
        : null;
    const useExternal = !!(plan && cnCfg && plan.ref.provider !== 'bedrock');

    // DeepSeek-on-Bedrock swap: the CN rule returned a Bedrock model different from the tier default.
    // It rides the normal Bedrock Converse path (guardrails/resilience/tool loop), just with a
    // different model id. For the reasoning model (R1): raise maxTokens (the chain-of-thought eats
    // the budget before the answer; firstText drops the reasoningContent block) and skip tool-use
    // (reasoning models are unreliable at tools — edits arrive on their own V3 turn).
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

    console.log('[StandardAsyncProcessor] Model resolution', {
      intent: event.intent,
      resolvedModel: useExternal
        ? `${cnCfg!.provider}:${cnCfg!.model}`
        : cnBedrockModel ?? effectiveModel,
      fallback: cnFallbackModelId,
      fromStrategy: resolution.resolvedFromStrategy,
      contextRouted: useExternal || !!cnBedrockModel,
      cnBedrock: cnBedrockModel ? { model: cnBedrockModel, reasoning: reasoningTurn } : undefined,
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
      // Per-step telemetry (SPEC-MESSAGE-METADATA-CODEBOOK.md): the Bedrock path
      // carries one step per Converse iteration; the external path is a
      // single call → one synthesized step. Persisted out-of-band by finalize.
      steps?: ConverseStep[];
    };

    // SPEC-TASK-STATE-TRANSITIONS: active-task context for the in-loop advance_task_state tool
    // (undefined unless this turn belongs to a machine-backed task). Passing it registers the tool.
    const taskContext = await buildTaskLoopContext({
      taskId: event.taskId,
      taskType: event.taskType,
      channelArn: event.channelArn,
    });

    // Attachment-in: the user sent an image/PDF/doc — fetch it and attach a Converse image or
    // document block so the assistant can read it. Best-effort: a fetch/format miss degrades to a
    // normal text turn. Populated only on the direct-invoke paths (@all).
    let imageInput: BedrockImageInput | undefined;
    let documentInput: BedrockDocumentInput | undefined;
    const attachmentsBucket = process.env.ATTACHMENTS_BUCKET;
    // Ownership check (mirrors the presigned-url download path): the fileKey comes from
    // user-controlled message Metadata, so verify the object is under the SENDER's own storage
    // prefix — attachments/<conversationId>/<senderSub>/... — before reading it. Without this, a
    // crafted fileKey could read another user's uploaded file (the tier's s3:GetObject grant spans
    // the whole attachments/* prefix). S3 keys are not path-normalized, so a literal '..' cannot
    // traverse out of the sender's segment.
    const attachmentOwnedBySender = senderOwnsAttachmentKey(event.attachment?.fileKey, event.senderArn);
    if (event.attachment?.fileKey && attachmentsBucket && attachmentOwnedBySender) {
      try {
        const imgFmt = imageFormatFromContentType(event.attachment.contentType);
        const docFmt = docFormatFromContentType(event.attachment.contentType);
        if (imgFmt || docFmt) {
          const bytes = await fetchAttachmentBytes(s3ContextClient, attachmentsBucket, event.attachment.fileKey);
          if (imgFmt) {
            imageInput = { format: imgFmt, bytes };
          } else if (docFmt) {
            const safeName = (event.attachment.name || 'document').replace(/[^a-zA-Z0-9 .\-()[\]]/g, ' ').slice(0, 200) || 'document';
            documentInput = { format: docFmt, name: safeName, bytes };
          }
          console.log('[StandardAsyncProcessor] attachment-in', { type: event.attachment.contentType, kind: imgFmt ? 'image' : 'document' });
        } else {
          console.warn('[StandardAsyncProcessor] attachment type not supported by Converse:', event.attachment.contentType);
        }
      } catch (e) {
        console.warn('[StandardAsyncProcessor] attachment fetch failed (non-fatal):', e);
      }
    } else if (event.attachment?.fileKey && !attachmentOwnedBySender) {
      console.warn('[StandardAsyncProcessor] attachment fileKey not under the sender prefix; ignoring (possible cross-user reference)');
    }

    if (useExternal && cnCfg) {
      // External (Chinese) provider — text-only. Bedrock Guardrails do NOT apply to external
      // providers, so apply the compensating output check explicitly (spec Invariant). Any
      // failure degrades gracefully to the Bedrock plan.
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
        console.log('[StandardAsyncProcessor][cost] external', {
          provider: ext.provider,
          model: cnCfg.model,
          inputTokens: ext.inputTokens,
          outputTokens: ext.outputTokens,
          costUsd: ext.costUsd,
          billedBy: ext.billedBy,
        });
      } catch (err) {
        console.warn('[StandardAsyncProcessor] External provider failed; falling back to Bedrock:', err);
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
      // Default path — Bedrock with retry + fallback; company-context tool + work-item
      // tools (the latter only on plan conversations, and not on reasoning-model turns). The model
      // is the tier default OR the CN DeepSeek-on-Bedrock model when geography routing selected it.
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
    const response = event.domainContext
      ? extractSuggestions(bedrockResult.response)
      : bedrockResult.response;

    // SPEC-TASK-STATE-TRANSITIONS §8: task state now advances ONLY via the authorized
    // advance_task_state tool inside the loop. The legacy keyword detector runs in SHADOW mode
    // (log-only, to measure the old race rate on real traffic). Side effects that used to hang off
    // the keyword advance are re-keyed to the tool transition below.
    if (taskContext) {
      shadowKeywordTransition(response, taskContext, 'StandardAsyncProcessor');
      // §7: a task turn that advanced nothing bumps the stall counter (emits task_state_stalled past
      // the threshold). No-op when the tool advanced this turn.
      await recordStallIfNoTransition(taskContext);

      // Preserve the action_item hand-off email (Phase 5b): when the tool advances an action_item to
      // awaiting_completion, and the assignee is someone other than the sender, notify them. The
      // tool has already mutated taskContext.task.taskState to awaiting_completion.
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

    // Generate document attachment — on report tasks or explicit user request
    let attachment: GeneratedDocument | undefined;
    const shouldGenerateDoc = process.env.ATTACHMENTS_BUCKET && (
      // Automatic: report_generation task in generating/revising state
      (event.taskType === 'report_generation' && event.taskId && (() => {
        // Check task state inline
        return true; // Will be refined by task state check below
      })()) ||
      // Explicit: user asked for a document/file
      isDocumentRequest(event.userMessage || '')
    );

    if (shouldGenerateDoc && process.env.ATTACHMENTS_BUCKET) {
      let generate = isDocumentRequest(event.userMessage || '');

      if (!generate && event.taskType === 'report_generation' && event.taskId) {
        const task = await getTask(event.taskId, event.channelArn);
        generate = task?.taskState === 'generating' || task?.taskState === 'revising';
      }

      if (generate) {
        try {
          attachment = await generateAndUploadDocument(
            response, event.channelArn, event.taskType || 'document', process.env.ATTACHMENTS_BUCKET,
          );
          console.log('[StandardAsyncProcessor] Document generated:', attachment.fileKey);
        } catch (docError) {
          console.error('[StandardAsyncProcessor] Document generation failed:', docError);
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
      steps: bedrockResult.steps,
    });

    // Reply is posted; now let the first-turn title rename finish before the
    // Lambda execution environment freezes (see runSharedPipeline). Awaiting
    // here adds no user-facing latency (this is an Event invoke with no caller
    // waiting) but guarantees the UpdateChannel lands.
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

