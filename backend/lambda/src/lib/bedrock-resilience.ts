/**
 * Bedrock Resilience
 *
 * Wraps Bedrock invocations with retry, fallback, and circuit breaker logic.
 * Handles ThrottlingException, ServiceQuotaExceededException, and transient
 * model errors by retrying with exponential backoff then falling back to
 * an alternative model.
 *
 * The circuit breaker prevents hammering a consistently failing model —
 * after repeated failures it skips directly to the fallback model.
 */

import {
  AsyncProcessorConfig,
  ConversationMessage,
  invokeBedrock,
  type BedrockImageInput,
  type BedrockDocumentInput,
} from './async-processor-core.js';
import type { ConverseStep } from './analytics-metadata.js';

// ============================================================
// Circuit Breaker
// ============================================================

interface CircuitState {
  failures: number;
  lastFailure: number;
}

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 60_000; // 1 minute

export class BedrockCircuitBreaker {
  private state = new Map<string, CircuitState>();

  isOpen(modelId: string): boolean {
    const s = this.state.get(modelId);
    if (!s) return false;
    if (Date.now() - s.lastFailure > CIRCUIT_RESET_MS) {
      // Half-open: reset and allow through
      this.state.delete(modelId);
      return false;
    }
    return s.failures >= CIRCUIT_THRESHOLD;
  }

  recordFailure(modelId: string): void {
    const s = this.state.get(modelId) || { failures: 0, lastFailure: 0 };
    s.failures += 1;
    s.lastFailure = Date.now();
    this.state.set(modelId, s);
  }

  recordSuccess(modelId: string): void {
    this.state.delete(modelId);
  }
}

// Module-level instance — persists across warm Lambda invocations
export const circuitBreaker = new BedrockCircuitBreaker();

// ============================================================
// Error Classification
// ============================================================

type ErrorAction = 'retry' | 'fallback' | 'fail';

function classifyError(error: unknown): { action: ErrorAction; reason: string } {
  const name = (error as { name?: string })?.name || '';
  const message = (error as { message?: string })?.message || '';
  const code = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

  // Throttling — retry with backoff
  if (name === 'ThrottlingException' || code === 429) {
    return { action: 'retry', reason: 'throttled' };
  }
  if (name === 'ServiceQuotaExceededException') {
    return { action: 'retry', reason: 'quota_exceeded' };
  }

  // Model unavailable — skip to fallback
  if (name === 'ModelNotReadyException' || name === 'ModelTimeoutException') {
    return { action: 'fallback', reason: 'model_unavailable' };
  }
  if (name === 'ModelErrorException' || name === 'InternalServerException') {
    return { action: 'fallback', reason: 'model_error' };
  }

  // IAM / config error — fail immediately (don't retry or fallback)
  if (name === 'AccessDeniedException' || code === 403) {
    return { action: 'fail', reason: 'access_denied' };
  }
  if (name === 'ValidationException' || code === 400) {
    return { action: 'fail', reason: 'validation_error' };
  }

  // Unknown error — attempt fallback
  if (code && code >= 500) {
    return { action: 'fallback', reason: 'server_error' };
  }

  return { action: 'fail', reason: message || 'unknown_error' };
}

// ============================================================
// Resilient Invocation
// ============================================================

export interface ResilientInvokeResult {
  response: string;
  inputTokens: number;
  outputTokens: number;
  bedrockTime: number;
  modelUsed: string;
  wasFallback: boolean;
  fallbackReason?: string;
  retryCount: number;
  /**
   * Per-step telemetry for this turn (one entry per Converse iteration of the
   * self-hosted tool loop). Flows through from invokeBedrock via `...result`;
   * persisted out-of-band by finalizePlaceholderResponse (SPEC-MESSAGE-METADATA-CODEBOOK.md).
   */
  steps?: ConverseStep[];
}

interface ResilientInvokeOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /**
   * Phase-3 vision-in: image to attach to the current turn. Forwarded
   * verbatim to invokeBedrock on the primary AND fallback paths (only
   * pass for vision-capable models — see resolveBattleVisionPlan).
   */
  imageInput?: BedrockImageInput;
  /** ADR-011: expose load_company_context + run the in-Lambda tool loop. */
  enableCompanyContextTool?: boolean;
  /** Expose the deployment's edit tools (propose-and-confirm). Forwarded on both paths. */
  enableEditTools?: boolean;
  /**
   * Attachment-in: document (PDF/office/text) to attach to the current turn. Forwarded
   * verbatim to invokeBedrock on the primary AND fallback paths (only pass for
   * document-capable models).
   */
  documentInput?: BedrockDocumentInput;
  /**
   * Length (in chars) of the STABLE system-prompt prefix (persona + standing
   * policy) that can be cached via a Bedrock cachePoint. Forwarded to
   * invokeBedrock on the primary AND fallback paths. Omit to disable caching.
   */
  cacheableSystemPrefixLength?: number;
}

/**
 * Invoke Bedrock with retry, fallback, and circuit breaker protection.
 *
 * Flow:
 * 1. If circuit breaker is open for primary → skip to fallback
 * 2. Try primary model
 * 3. On retryable error → exponential backoff up to maxRetries
 * 4. If all retries fail → try fallback model (1 attempt)
 * 5. If fallback also fails → throw
 */
export async function invokeBedrockWithFallback(
  systemPrompt: string,
  messages: ConversationMessage[],
  primaryConfig: AsyncProcessorConfig,
  fallbackModelId: string | null,
  options: ResilientInvokeOptions = {},
): Promise<ResilientInvokeResult> {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 200;
  let retryCount = 0;

  // Check circuit breaker — if primary is tripped, skip directly to fallback
  if (circuitBreaker.isOpen(primaryConfig.model)) {
    console.warn(`[BedrockResilience] Circuit open for ${primaryConfig.model}, skipping to fallback`);

    if (fallbackModelId) {
      return tryFallback(systemPrompt, messages, primaryConfig, fallbackModelId, 0, 'circuit_open', options.imageInput, options.enableCompanyContextTool, options.enableEditTools, options.documentInput, options.cacheableSystemPrefixLength);
    }
    // No fallback available — try primary anyway (circuit may be stale)
  }

  // Try primary model with retries
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await invokeBedrock(systemPrompt, messages, primaryConfig, options.imageInput, options.enableCompanyContextTool, options.enableEditTools, options.documentInput, options.cacheableSystemPrefixLength);
      circuitBreaker.recordSuccess(primaryConfig.model);
      return {
        ...result,
        modelUsed: primaryConfig.model,
        wasFallback: false,
        retryCount: attempt,
      };
    } catch (error) {
      lastError = error;
      const { action, reason } = classifyError(error);

      console.warn(`[BedrockResilience] Attempt ${attempt + 1}/${maxRetries + 1} failed`, {
        model: primaryConfig.model,
        action,
        reason,
        errorName: (error as { name?: string })?.name,
      });

      if (action === 'fail') {
        // Non-retryable, non-fallbackable error
        throw error;
      }

      if (action === 'fallback') {
        circuitBreaker.recordFailure(primaryConfig.model);
        if (fallbackModelId) {
          return tryFallback(systemPrompt, messages, primaryConfig, fallbackModelId, attempt + 1, reason, options.imageInput, options.enableCompanyContextTool, options.enableEditTools, options.documentInput, options.cacheableSystemPrefixLength);
        }
        throw error;
      }

      // action === 'retry'
      retryCount = attempt + 1;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(4, attempt); // 200ms, 800ms
        console.log(`[BedrockResilience] Retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted — try fallback
  circuitBreaker.recordFailure(primaryConfig.model);

  if (fallbackModelId) {
    return tryFallback(systemPrompt, messages, primaryConfig, fallbackModelId, retryCount, 'retries_exhausted', options.imageInput, options.enableCompanyContextTool, options.enableEditTools, options.documentInput, options.cacheableSystemPrefixLength);
  }

  throw lastError;
}

async function tryFallback(
  systemPrompt: string,
  messages: ConversationMessage[],
  primaryConfig: AsyncProcessorConfig,
  fallbackModelId: string,
  retryCount: number,
  reason: string,
  imageInput?: BedrockImageInput,
  enableCompanyContextTool?: boolean,
  enableEditTools?: boolean,
  documentInput?: BedrockDocumentInput,
  cacheableSystemPrefixLength?: number,
): Promise<ResilientInvokeResult> {
  console.log(`[BedrockResilience] Falling back to ${fallbackModelId} (reason: ${reason})`);

  const fallbackConfig = { ...primaryConfig, model: fallbackModelId };
  const result = await invokeBedrock(systemPrompt, messages, fallbackConfig, imageInput, enableCompanyContextTool, enableEditTools, documentInput, cacheableSystemPrefixLength);
  circuitBreaker.recordSuccess(fallbackModelId);

  return {
    ...result,
    modelUsed: fallbackModelId,
    wasFallback: true,
    fallbackReason: reason,
    retryCount,
  };
}
