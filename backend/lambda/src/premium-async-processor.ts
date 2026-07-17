/**
 * Premium Async Processor
 *
 * Tier-specific async processor for Premium users.
 * Uses Opus model with full access to knowledge base and task tracking.
 * Can load additional context documents from S3.
 *
 * Pipeline: poll placeholder -> load history -> load S3 context -> build task context -> invoke Bedrock -> detect state transitions -> update message
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
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
  prepareBattleInvocation,
  resolveBattleVisionPlan,
  resolveBattleGenerationOutPlan,
} from './lib/async-processor-core.js';
import { fetchAttachmentBytes, senderOwnsAttachmentKey } from './lib/attachment-bytes.js';
import { invokeImageGenModel } from './lib/image-gen-models.js';
import { persistImageGenOutput, buildBattleImageContent } from './lib/image-gen-output.js';
import { resolveBotDisplayName } from './lib/experiment-manager.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { invokeBedrockWithFallback } from './lib/bedrock-resilience.js';
import { buildTaskLoopContext, shadowKeywordTransition, recordStallIfNoTransition } from './lib/async-processor-core.js';
import { buildRetrievedContextHint, buildConversationSummaryHint } from './analytics-aurora/document-retrieval.js';
import {
  getTask,
  advanceTaskState,
  buildTaskContextForPrompt,
  buildCrossChannelTasksHint,
  getActiveTasksForUser,
  TASK_STATE_MACHINES,
} from './lib/task-tracking.js';
import { resolveModelForIntent } from './lib/model-resolver.js';
import { getModelCatalog, INTENT_ROUTE_STRATEGY, DEFAULT_TIER_MODEL_SELECTION, bedrockInvokeId } from '../../lib/config/model-strategy.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const CONTEXT_BUCKET = process.env.CONTEXT_BUCKET || '';
// Per-tier bot SSM key (= /agent-echelon/assistant/premium/bot-arn), always set by the
// premium tier stack. There is no shared-bot fallback.
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || '';

const s3Client = new S3Client({ region: AWS_REGION });
const ssmClient = new SSMClient({ region: AWS_REGION });

let cachedDefaultBotArn: string | null = null;
async function loadDefaultBotArn(): Promise<string> {
  if (cachedDefaultBotArn) return cachedDefaultBotArn;
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: BOT_ARN_PARAM }));
    cachedDefaultBotArn = resp.Parameter?.Value || '';
    return cachedDefaultBotArn;
  } catch (err) {
    console.warn('[PremiumAsyncProcessor] BOT_ARN SSM lookup failed:', err);
    return '';
  }
}

const CONFIG: AsyncProcessorConfig = {
  model: process.env.MODEL_ID || 'us.anthropic.claude-opus-4-6-v1',
  maxTokens: 4096,
  temperature: 0.7,
  userType: 'premium',
};
const MODEL_NAME = process.env.MODEL_NAME || 'Claude Opus';

const BASE_SYSTEM_PROMPT = `You are an AI assistant in Agent Echelon, an enterprise conversational AI platform. Users interact with you through a chat interface. You are running on the Premium tier (${MODEL_NAME}), the most capable model with advanced reasoning and full resource access.

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

// (Removed the dead `loadS3Context` path — it read an unprovisioned key and was
// never called. Company context reaches the model via the load_company_context
// tool + per-tier digest + RAG; see docs/GUIDE-ASSISTANT-CONTEXT.md.)

/**
 * Build task-specific system prompt additions (same logic as standard, but with richer prompts)
 */
function buildTaskSystemPrompt(taskType: string, taskState: string): string {
  switch (taskType) {
    case 'guided_troubleshooting':
      return getGuidedTroubleshootingPrompt(taskState);
    case 'data_extraction':
      return getDataExtractionPrompt(taskState);
    case 'report_generation':
      return getReportGenerationPrompt(taskState);
    default:
      return '';
  }
}

function getGuidedTroubleshootingPrompt(state: string): string {
  const prompts: Record<string, string> = {
    collecting_symptoms: `\n\n## CURRENT TASK: Guided Troubleshooting - Collecting Symptoms
Systematically gather information about the problem:
- Error messages, codes, or unexpected behavior
- Timeline: when it started, what changed
- Environment details (system, version, configuration)
- Steps to reproduce
- Impact and urgency
Do NOT propose solutions yet. Focus on thorough problem understanding.`,

    diagnosing: `\n\n## CURRENT TASK: Guided Troubleshooting - Diagnosing
Perform root cause analysis:
- Cross-reference symptoms with known patterns
- Identify the most likely root causes
- Ask targeted clarifying questions if critical information is missing
- Rank potential causes by probability`,

    proposing_solutions: `\n\n## CURRENT TASK: Guided Troubleshooting - Proposing Solutions
Present solutions ranked by effectiveness and safety:
- Start with the least disruptive fix
- Provide detailed step-by-step instructions
- Note any prerequisites or potential side effects
- Include rollback steps where applicable`,

    awaiting_result: `\n\n## CURRENT TASK: Guided Troubleshooting - Awaiting Result
Evaluate the user's feedback on the attempted solution:
- If resolved: document the fix for future reference
- If partially resolved: identify remaining issues
- If not resolved: analyze why and suggest next approach`,
  };

  return prompts[state] || '\n\n## CURRENT TASK: Guided Troubleshooting\nHelp the user resolve their issue with thorough analysis.';
}

function getDataExtractionPrompt(state: string): string {
  const prompts: Record<string, string> = {
    collecting_requirements: `\n\n## CURRENT TASK: Data Extraction - Collecting Requirements
Gather comprehensive extraction requirements:
- Source data location and format
- Specific fields, columns, or data points needed
- Filters, date ranges, or conditions
- Desired output format (CSV, JSON, table, etc.)
- Any transformations or calculations needed`,

    extracting: `\n\n## CURRENT TASK: Data Extraction - Extracting
Execute the extraction based on requirements:
- Describe the extraction approach
- Show sample data if applicable
- Note any issues encountered during extraction`,

    validating: `\n\n## CURRENT TASK: Data Extraction - Validating
Validate extracted data thoroughly:
- Check record counts and completeness
- Verify data types and formats
- Flag outliers or suspicious values
- Present validation summary for user confirmation`,

    formatting: `\n\n## CURRENT TASK: Data Extraction - Formatting
Format the validated data:
- Apply requested output format
- Add headers, labels, or metadata
- Include any requested summary statistics
- Present the final deliverable`,
  };

  return prompts[state] || '\n\n## CURRENT TASK: Data Extraction\nHelp the user extract and format their data.';
}

function getReportGenerationPrompt(state: string): string {
  const prompts: Record<string, string> = {
    collecting_requirements: `\n\n## CURRENT TASK: Report Generation - Collecting Requirements
Understand report requirements in detail:
- Topic, purpose, and scope
- Target audience and their expertise level
- Key metrics, data points, and analysis needed
- Desired format, length, and style
- Specific sections or templates to follow
- Deadline or delivery constraints`,

    drafting_outline: `\n\n## CURRENT TASK: Report Generation - Drafting Outline
Create a detailed report outline:
- Executive summary/abstract
- Structured sections with descriptions
- Data/charts/tables planned for each section
- Key findings to highlight
- Conclusions and recommendations sections
Present for user approval before generating.`,

    generating: `\n\n## CURRENT TASK: Report Generation - Generating
Generate the full report:
- Follow the approved outline
- Write clear, professional prose
- Include data visualizations described in text
- Ensure logical flow between sections
- Add citations or references where applicable`,

    revising: `\n\n## CURRENT TASK: Report Generation - Revising
Revise the report:
- Apply all requested changes
- Clearly note what was modified
- Check consistency across sections
- Verify all data references are accurate
- Present the updated version for final approval`,
  };

  return prompts[state] || '\n\n## CURRENT TASK: Report Generation\nHelp the user create a comprehensive report.';
}

export const handler = async (event: AsyncProcessorEvent): Promise<void> => {
  const startTime = Date.now();
  console.log('[PremiumAsyncProcessor] Invoked', JSON.stringify({
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

    // Build system prompt. The stable base (persona + standing policy) is
    // complete here; capture its length so invokeBedrock can insert a Bedrock
    // cachePoint after it (the dynamic per-turn appends below fall in the
    // uncached suffix). See docs/GUIDE-ASSISTANT-CONTEXT.md. On /battle turns
    // systemPrompt is reassembled below (assembled.systemPrompt) but still
    // leads with this same stable base, so the prefix remains a valid front
    // slice; buildSystemBlocks guards length < systemPrompt.length regardless.
    let systemPrompt = BASE_SYSTEM_PROMPT;
    const cacheableSystemPrefixLength = systemPrompt.length;

    // (Removed: the legacy static `premium/context.json` paste. It read an unprovisioned key
    // (the tool loop reads context/{tier}/*, a different location) so it always no-op'd, and a
    // whole-file paste is the anti-pattern ADR-011 replaced with the load_company_context tool.)

    // Load task context if task-based
    let activeTaskInfo: { type: string; status: string; label: string; taskId: string } | undefined;
    if (event.taskId && event.taskType) {
      const task = await getTask(event.taskId, event.channelArn);
      if (task) {
        systemPrompt += buildTaskSystemPrompt(event.taskType, task.taskState || '');
        systemPrompt += buildTaskContextForPrompt(task);
        activeTaskInfo = {
          type: event.taskType,
          status: task.taskState || task.status,
          label: getTaskLabel(event.taskType, task.taskState || ''),
          // taskId is what the archival reads onto the exchange (task_id); without it
          // task_details/task_metrics stay empty even though the task exists.
          taskId: event.taskId,
        };
      }
    }

    // P2.4 cross-channel task awareness: tell the model when the user
    // has open tasks in OTHER conversations. Best-effort; failure is
    // never fatal — the hint augments judgment, the conversation
    // proceeds regardless.
    try {
      const userSub = event.senderArn?.split('/user/').pop() || '';
      if (userSub) {
        const crossChannelTasks = await getActiveTasksForUser(userSub);
        const hint = buildCrossChannelTasksHint(event.channelArn, crossChannelTasks);
        if (hint) systemPrompt += hint;
      }
    } catch (err) {
      console.warn('[PremiumAsyncProcessor] cross-channel task hint failed (non-fatal):', err);
    }

    // RAG (ADR-001 + ADR-002): the
    // router-agent-handler retrieves top-K chunks from the embeddings
    // table (it's the VPC-attached Lambda with DB access) and attaches
    // them to event.retrievedContext. We just format the hint here —
    // no DB call from this Lambda.
    if (event.retrievedContext) {
      const ragHint = buildRetrievedContextHint(event.retrievedContext);
      if (ragHint) systemPrompt += ragHint;
    }

    // Conversation summary as consumable context (ADR-017): the router attaches
    // it for long conversations so earlier turns aren't lost when raw history is
    // truncated. Empty string (no-op) for short conversations.
    systemPrompt += buildConversationSummaryHint(event.conversationSummary);

    if (priorAgentContext) {
      systemPrompt += `\n\n[You already said the following — do NOT repeat it. Use completely different wording.]\n${priorAgentContext.trim()}`;
    }

    // /battle: assemble the system prompt with the 3-layer ordering
    // (tier base → <persona_addendum> → battle constraints LAST so they
    // win over any addendum) and resolve the variant's model override.
    // Only kicks in when event.battleContext is set; non-battle invocations
    // proceed normally.
    let battleVariantModelKey: string | undefined;
    let battleSelfDisplayName: string | undefined;
    let battleLongFormMode: 'one-shot' | 'outline-first' = 'one-shot';
    if (event.battleContext) {
      const defaultBotArn = await loadDefaultBotArn();
      // The experiment is keyed by the alt-slot ARN. From either side of
      // the battle that's whichever of {self, rival} is NOT the default
      // bot — needed so the control side can resolve variants[0]'s
      // displayName for the rival name + scorecard.
      const altSlotArn =
        [event.battleContext.selfBotArn, event.battleContext.rivalBotArn].find(
          (a) => a !== defaultBotArn,
        ) || event.battleContext.rivalBotArn;
      const rivalDisplayName = await resolveBotDisplayName({
        thisBotArn: event.battleContext.rivalBotArn,
        defaultBotArn,
        altSlotArn,
      });
      // Intent-aware length: a battle whose deliverable is sent as an
      // attachment (report_generation task, or an explicit document
      // request) must NOT be capped to the conversational ~150-word
      // budget. Conversational battles stay concise (fast + readable).
      const battleLongForm =
        event.taskType === 'report_generation' ||
        isDocumentRequest(event.userMessage || '');
      const assembled = await prepareBattleInvocation({
        baseSystemPrompt: systemPrompt,
        battleContext: event.battleContext,
        defaultBotArn,
        selfBotArn: event.botArn,
        rivalDisplayName,
        longForm: battleLongForm,
      });
      systemPrompt = assembled.systemPrompt;
      battleVariantModelKey = assembled.variantModelKey;
      battleSelfDisplayName = assembled.selfDisplayName;
      battleLongFormMode = assembled.longFormMode;
      console.log('[PremiumAsyncProcessor][battle] Prompt assembled', {
        round: event.battleContext.round,
        self: assembled.selfDisplayName,
        rival: rivalDisplayName,
        variantModelKey: battleVariantModelKey,
      });
    }

    // Resolve model for this intent (respects tier boundaries). When the
    // bot is an alt-slot in a battle, the variant's modelKey wins.
    const catalog = getModelCatalog(process.env.AWS_REGION || 'us-east-1', process.env.AWS_ACCOUNT_ID || '');
    const resolution = resolveModelForIntent(
      event.intent || event.resolvedModel,
      CONFIG.userType,
      catalog,
      INTENT_ROUTE_STRATEGY,
      DEFAULT_TIER_MODEL_SELECTION,
    );
    const variantDef = battleVariantModelKey
      ? catalog[battleVariantModelKey as keyof typeof catalog]
      : undefined;
    const variantBedrockModelId = variantDef ? bedrockInvokeId(variantDef) : undefined;
    const effectiveModel = variantBedrockModelId || event.resolvedModel || resolution.primaryModelId;
    const invokeConfig = { ...CONFIG, model: effectiveModel };

    console.log('[PremiumAsyncProcessor] Model resolution', {
      intent: event.intent,
      resolvedModel: effectiveModel,
      fallback: resolution.fallbackModelId,
      fromStrategy: resolution.resolvedFromStrategy,
    });

    // Invoke Bedrock with retry + fallback.
    // Phase-3 vision-in: when the /battle turn carried an image, decide
    // per-variant (resolveBattleVisionPlan, already unit-tested):
    //  - reject-text-only → no Bedrock call; synthesize a result so
    //    finalize still runs (records terminal state → round-2 fires).
    //  - vision           → fetch the image + forward it to Bedrock.
    //  - text             → unchanged.
    // Non-image battles and all non-battle invocations are unaffected.
    let bedrockResult;

    // SPEC-TASK-STATE-TRANSITIONS: active-task context for the in-loop advance_task_state tool
    // (undefined unless this turn belongs to a machine-backed task). Passing it registers the tool.
    const taskContext = await buildTaskLoopContext({
      taskId: event.taskId,
      taskType: event.taskType,
      channelArn: event.channelArn,
    });
    let battleImageCount: number | undefined;
    // Phase-4 generation-out: a battle variant bound to an image-gen
    // model (Titan v2 / Nova Canvas) produces an IMAGE from the prompt
    // instead of text. Evaluated FIRST and mutually exclusive with
    // vision-in (gen-out has no input image). Absent/unknown id →
    // 'text' (normal battle); a present-but-unknown id is a deployer
    // misconfig surfaced visibly, never silently string-matched away.
    const genOutModelId = event.battleContext?.imageGenModelId;
    const genOutPlan = resolveBattleGenerationOutPlan({ imageGenModelId: genOutModelId });
    if (genOutModelId && genOutPlan.action !== 'generation') {
      console.warn(
        '[PremiumAsyncProcessor][battle] imageGenModelId set but not a registered ' +
          'image model — falling through to text battle',
        { imageGenModelId: genOutModelId },
      );
    }
    const imgAtt = event.battleContext?.imageAttachment;
    if (genOutPlan.action === 'generation') {
      // No Bedrock text call: invoke the image model, persist to S3,
      // hand back a marker the frontend renders. Honest empty path —
      // a generation failure or guardrail block persists nothing and
      // yields an honest line with NO marker (never a fabricated image).
      const genStart = Date.now();
      // Phase-4D deployer cost cap (env-sourced; only ever lowers the
      // registry hard cap — the shaper enforces min(registry, cap)).
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
      const plan = resolveBattleVisionPlan({
        variantModelKey: battleVariantModelKey,
        baseModelId: effectiveModel,
        hasImageAttachment: true,
        imageContentType: imgAtt.contentType,
      });
      if (plan.action === 'reject-text-only') {
        bedrockResult = {
          response: plan.rejectMessage as string,
          inputTokens: 0,
          outputTokens: 0,
          bedrockTime: 0,
          modelUsed: invokeConfig.model,
          wasFallback: false,
          retryCount: 0,
        };
      } else if (plan.action === 'vision') {
        // Ownership check (mirrors the standard processor + presigned-url path): imgAtt.fileKey
        // comes from user-controlled message Metadata, so verify the object is under the SENDER's
        // own prefix — attachments/<conversationId>/<senderSub>/... — before reading it. Without
        // this, a crafted fileKey could read another user's upload (premium's s3:GetObject grant
        // spans the whole attachments/* prefix). On a cross-user reference, fall back to text-only.
        if (!senderOwnsAttachmentKey(imgAtt.fileKey, event.senderArn)) {
          console.warn('[PremiumAsyncProcessor] battle image fileKey not under the sender prefix; ignoring (possible cross-user reference)');
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
            { imageInput: { format: plan.imageFormat!, bytes }, cacheableSystemPrefixLength },
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
    } else {
      // Normal text turn → enable the company-context tool (ADR-011).
      // Vision (above) and /battle stay tool-less.
      bedrockResult = await invokeBedrockWithFallback(
        systemPrompt,
        bedrockMessages,
        invokeConfig,
        resolution.fallbackModelId,
        { enableCompanyContextTool: true, cacheableSystemPrefixLength, taskContext },
      );
    }
    const { response } = bedrockResult;

    // SPEC-TASK-STATE-TRANSITIONS §8: task state now advances ONLY via the authorized
    // advance_task_state tool inside the loop (recorded on taskContext.transitions). The legacy
    // keyword detector runs in SHADOW mode — it logs what it WOULD have advanced (to measure the old
    // race rate on real traffic) but no longer mutates state.
    if (taskContext) {
      shadowKeywordTransition(response, taskContext, 'PremiumAsyncProcessor');
      // §7: a task turn that advanced nothing bumps the stall counter (emits task_state_stalled past
      // the threshold). No-op when the tool advanced this turn.
      await recordStallIfNoTransition(taskContext);
    }

    // Generate document attachment — on report tasks or explicit user request
    let attachment: GeneratedDocument | undefined;
    if (process.env.ATTACHMENTS_BUCKET) {
      let generate = isDocumentRequest(event.userMessage || '');

      if (!generate && event.taskType === 'report_generation' && event.taskId) {
        const task = await getTask(event.taskId, event.channelArn);
        generate = task?.taskState === 'generating' || task?.taskState === 'revising';
      }

      // D: in a battle, the long-form prompt told the model the
      // deliverable will be delivered as a downloadable attachment, so
      // honor that promise deterministically on round-1 of a report
      // battle - bypass the multi-step state-machine gate (battles are
      // one-shot per round, not an interactive collect-then-approve
      // flow). Round-2 stays out: it's the concise rebuttal turn and a
      // short rebuttal should not be turned into a file. Non-battle
      // multi-step report tasks (where the state gate matters) are
      // unaffected.
      // D + B: force attachment on round-1 report battles in ONE-SHOT
      // mode (the long-form prompt promised an attachment). In
      // OUTLINE-FIRST mode, round-1 is a short approach/outline only -
      // no full deliverable yet, no attachment. The full deliverable is
      // produced in a subsequent steered turn.
      if (!generate
        && event.battleContext?.round === 1
        && event.taskType === 'report_generation'
        && battleLongFormMode !== 'outline-first') {
        generate = true;
      }

      if (generate) {
        try {
          attachment = await generateAndUploadDocument(
            response, event.channelArn, event.taskType || 'document', process.env.ATTACHMENTS_BUCKET,
          );
          console.log('[PremiumAsyncProcessor] Document generated:', attachment.fileKey);
        } catch (docError) {
          console.error('[PremiumAsyncProcessor] Document generation failed:', docError);
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
      ...(battleImageCount != null && { imageCount: battleImageCount }),
      ...(battleSelfDisplayName && { battleSelfDisplayName }),
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

