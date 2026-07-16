/**
 * Basic Async Processor
 *
 * Tier-specific async processor for Basic users.
 * Uses Haiku model with restricted permissions.
 * Supports tasks (lightweight): loads the task, grounds the prompt, and stamps the
 * task_id for analytics. The rich multi-step task-type prompts remain a standard/premium
 * enhancement (see the task block below).
 *
 * Pipeline: poll placeholder -> load history -> invoke Bedrock -> update message
 */

import {
  AsyncProcessorEvent,
  AsyncProcessorConfig,
  runSharedPipeline,
  handleProcessingError,
  finalizePlaceholderResponse,
  getTaskLabel,
} from './lib/async-processor-core.js';
import { getTask, buildTaskContextForPrompt, type Task } from './lib/task-tracking.js';
import { invokeBedrockWithFallback } from './lib/bedrock-resilience.js';
import { buildConversationSummaryHint } from './analytics-aurora/document-retrieval.js';
import { resolveModelForIntent } from './lib/model-resolver.js';
import { getModelCatalog, INTENT_ROUTE_STRATEGY, DEFAULT_TIER_MODEL_SELECTION } from '../../lib/config/model-strategy.js';

const CONFIG: AsyncProcessorConfig = {
  model: process.env.MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0',
  maxTokens: 1024,
  temperature: 0.7,
  userType: 'basic',
};
const MODEL_NAME = process.env.MODEL_NAME || 'Claude Haiku';

const SYSTEM_PROMPT = `You are an AI assistant in Agent Echelon, an enterprise conversational AI platform. Users interact with you through a chat interface. You are running on the Basic tier (${MODEL_NAME}), optimized for fast, cost-effective responses.

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

export const handler = async (event: AsyncProcessorEvent): Promise<void> => {
  const startTime = Date.now();
  console.log('[BasicAsyncProcessor] Invoked', JSON.stringify({
    channelArn: event.channelArn?.substring(0, 50),
    correlationId: event.correlationId,
  }));

  try {
    const pipeline = await runSharedPipeline(event);

    if (!pipeline) {
      return;
    }

    const { messageId, pollTime, consolidatedHistory, priorAgentContext, bedrockMessages } = pipeline;

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

    console.log('[BasicAsyncProcessor] Model resolution', {
      intent: event.intent,
      resolvedModel: effectiveModel,
      fallback: resolution.fallbackModelId,
      fromStrategy: resolution.resolvedFromStrategy,
    });

    // Build system prompt. The stable base (persona + standing policy) is
    // complete here; capture its length so invokeBedrock can insert a Bedrock
    // cachePoint after it (the dynamic per-turn appends below fall in the
    // uncached suffix). See docs/GUIDE-ASSISTANT-CONTEXT.md.
    let systemPrompt = SYSTEM_PROMPT;
    const cacheableSystemPrefixLength = systemPrompt.length;
    if (priorAgentContext) {
      systemPrompt += `\n\n[You already said the following — do NOT repeat it. Use completely different wording.]\n${priorAgentContext.trim()}`;
    }
    // Conversation summary as consumable context (ADR-017); no-op when short.
    systemPrompt += buildConversationSummaryHint(event.conversationSummary);

    // Task support: basic runs tasks too (the router classifies task intents on every
    // tier). Ground the prompt in the task + stamp activeTaskInfo (with taskId) so the
    // response archives with task_id → the Quality>Tasks tab. The shared core handles
    // task status updates. The rich multi-step task-type prompts stay a standard/premium
    // enhancement for now (to bring them to basic, unify the per-processor builders into
    // a shared lib rather than triple-duplicating them).
    let activeTaskInfo: { type: string; status: string; label: string; taskId: string } | undefined;
    if (event.taskId && event.taskType) {
      const task: Task | null = await getTask(event.taskId, event.channelArn);
      if (task) {
        systemPrompt += buildTaskContextForPrompt(task);
        activeTaskInfo = {
          type: event.taskType,
          status: task.taskState || task.status,
          label: getTaskLabel(event.taskType, task.taskState || ''),
          taskId: event.taskId,
        };
      }
    }

    // Invoke Bedrock with retry + fallback; enable the company-context tool
    // on this normal text turn (ADR-011 — self-hosted tool loop).
    const bedrockResult = await invokeBedrockWithFallback(
      systemPrompt,
      bedrockMessages,
      invokeConfig,
      resolution.fallbackModelId,
      { enableCompanyContextTool: true, cacheableSystemPrefixLength },
    );

    // Finalize response
    await finalizePlaceholderResponse({
      event,
      response: bedrockResult.response,
      model: bedrockResult.modelUsed,
      inputTokens: bedrockResult.inputTokens,
      outputTokens: bedrockResult.outputTokens,
      bedrockTime: bedrockResult.bedrockTime,
      messageId: messageId!,
      pollTime,
      conversationHistoryLength: consolidatedHistory.length,
      startTime,
      activeTaskInfo,
      wasFallback: bedrockResult.wasFallback,
      fallbackReason: bedrockResult.fallbackReason,
      retryCount: bedrockResult.retryCount,
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
