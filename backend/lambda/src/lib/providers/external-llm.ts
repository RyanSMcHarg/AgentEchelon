/**
 * External (non-Bedrock) LLM provider adapter — the provider-adapter seam from
 * SPEC-CONTEXT-AWARE-MODEL-ROUTING (phase 2). DeepSeek and Qwen both expose an
 * OpenAI-compatible /chat/completions API, so one adapter serves both via config.
 *
 * Scope (v1): TEXT generation only — no tool-use on the external path yet (tool-use
 * proposals stay on the Bedrock path; a turn that needs them falls back).
 * Resilience: timeout + bounded retries on 429/5xx (the per-adapter analogue of
 * bedrock-resilience the spec requires). Cost: computed from a per-provider rate card and
 * returned so the caller can record `billedBy:'external'` (spend is invisible to AWS billing).
 *
 * SECURITY: the API key is read from Secrets Manager (never an env literal) and cached.
 * GUARDRAIL: Bedrock Guardrails do NOT apply here — the caller must apply a compensating
 * output check before this path is enabled for real users (spec Invariant).
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { ConversationMessage } from './../async-processor-core.js';

const secrets = new SecretsManagerClient({});

export type ExternalProvider = 'deepseek' | 'qwen';

export interface ExternalProviderConfig {
  provider: ExternalProvider;
  baseUrl: string;            // e.g. https://api.deepseek.com
  model: string;             // e.g. deepseek-chat
  apiKeySecretId: string;    // Secrets Manager id holding the raw key
  /** Rate card (USD per 1M tokens). Approximate + deployment-tunable. */
  usdPerMTokIn: number;
  usdPerMTokOut: number;
}

export interface ExternalInvokeResult {
  response: string;
  /** Set when the model called a function (OpenAI tool_calls). For propose-and-confirm,
   *  the caller turns a toolCall into a proposal marker (it is NOT executed here). */
  toolCall?: { name: string; args: Record<string, unknown> };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  provider: ExternalProvider;
  billedBy: 'external';
}

const keyCache = new Map<string, string>();
async function getApiKey(secretId: string): Promise<string> {
  const cached = keyCache.get(secretId);
  if (cached) return cached;
  const r = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const key = (r.SecretString || '').trim();
  if (!key) throw new Error(`external-llm: secret ${secretId} is empty`);
  keyCache.set(secretId, key);
  return key;
}

/** Translate AE's (systemPrompt, ConversationMessage[]) into OpenAI chat-completions messages. */
export function toOpenAiMessages(
  systemPrompt: string,
  messages: ConversationMessage[],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) out.push({ role: m.role, content: m.content });
  return out;
}

export function estimateExternalCostUsd(
  cfg: ExternalProviderConfig,
  inputTokens: number,
  outputTokens: number,
): number {
  return (inputTokens / 1e6) * cfg.usdPerMTokIn + (outputTokens / 1e6) * cfg.usdPerMTokOut;
}

interface InvokeOpts {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** OpenAI-format function tools (e.g. WORK_ITEM_OPENAI_TOOLS). When the model calls one, the
   *  result carries `toolCall` instead of (or alongside) text. */
  tools?: unknown[];
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Invoke an OpenAI-compatible external provider. Bounded retries with backoff; never loops
 * unbounded (spec: "No unbounded outbound fan-out"). Throws on non-retryable error / retries
 * exhausted so the caller can fall back to the Bedrock plan.
 */
export async function invokeExternalLlm(
  cfg: ExternalProviderConfig,
  systemPrompt: string,
  messages: ConversationMessage[],
  opts: InvokeOpts = {},
): Promise<ExternalInvokeResult> {
  const apiKey = await getApiKey(cfg.apiKeySecretId);
  const body = JSON.stringify({
    model: cfg.model,
    messages: toOpenAiMessages(systemPrompt, messages),
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.7,
    stream: false,
    ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
  });
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < maxRetries) {
          lastErr = new Error(`${cfg.provider} HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 300 * Math.pow(4, attempt)));
          continue;
        }
        throw new Error(`${cfg.provider} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = json.choices?.[0]?.message;
      const response = (message?.content || '').trim();
      let toolCall: { name: string; args: Record<string, unknown> } | undefined;
      const rawCall = message?.tool_calls?.[0]?.function;
      if (rawCall?.name) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(rawCall.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        toolCall = { name: rawCall.name, args };
      }
      if (!response && !toolCall) throw new Error(`${cfg.provider}: empty completion`);
      const inputTokens = json.usage?.prompt_tokens ?? 0;
      const outputTokens = json.usage?.completion_tokens ?? 0;
      return {
        response,
        toolCall,
        inputTokens,
        outputTokens,
        costUsd: estimateExternalCostUsd(cfg, inputTokens, outputTokens),
        provider: cfg.provider,
        billedBy: 'external',
      };
    } catch (err) {
      lastErr = err;
      const retriable = (err as { name?: string })?.name === 'AbortError';
      if (retriable && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 300 * Math.pow(4, attempt)));
        continue;
      }
      if (attempt >= maxRetries) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${cfg.provider}: invocation failed`);
}

/** Build a provider config from env (CDK sets these on the processor). Returns null when the
 *  provider isn't configured, so the resolver simply won't route to it. */
export function externalProviderFromEnv(provider: ExternalProvider): ExternalProviderConfig | null {
  const P = provider.toUpperCase();
  const baseUrl = process.env[`${P}_BASE_URL`];
  const model = process.env[`${P}_MODEL`];
  const apiKeySecretId = process.env[`${P}_API_KEY_SECRET`];
  if (!baseUrl || !model || !apiKeySecretId) return null;
  return {
    provider,
    baseUrl,
    model,
    apiKeySecretId,
    usdPerMTokIn: Number(process.env[`${P}_USD_PER_MTOK_IN`] ?? (provider === 'deepseek' ? 0.27 : 0.5)),
    usdPerMTokOut: Number(process.env[`${P}_USD_PER_MTOK_OUT`] ?? (provider === 'deepseek' ? 1.1 : 1.5)),
  };
}
