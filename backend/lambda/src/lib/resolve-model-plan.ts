/**
 * Context-aware model routing — resolveModelPlan (SPEC-CONTEXT-AWARE-MODEL-ROUTING.md).
 *
 * Generalises model resolution from the closed set (intent, tier, experiment) to an OPEN
 * RoutingContext, so new signals (request-segment geography, data-sensitivity, …) route without
 * new call sites.
 *
 * PHASE 1 (this file): a BACKWARD-COMPATIBLE wrapper. With no context extensions
 * (no `segment`/`signals`), it returns EXACTLY today's resolution —
 *   effectiveModel = experimentModelId || resolveModelForIntent(...).primaryModelId
 *   fallback       = resolveModelForIntent(...).fallbackModelId
 * — as an in-AWS Bedrock plan. The CN-segment context rule, the tool registry, and the
 * non-Bedrock provider adapter land in later increments at the marked extension point.
 * The backward-compat invariant is locked by test/lib/resolve-model-plan.test.ts.
 */
import type {
  BackendModelDefinition,
  BackendModelKey,
  IntentRouteDefinition,
  ModelTier,
  ProfileModelSelection,
} from '../../../lib/config/model-strategy.js';
import { resolveModelForIntent } from './model-resolver.js';

/** Who SERVES the model (distinct from the catalog's model-maker `provider`). Bedrock today;
 *  the non-Bedrock adapters (phase 2) add their own. */
export type ServingProvider = 'bedrock' | 'deepseek' | 'qwen';

export interface ModelRef {
  modelKey: BackendModelKey | string;
  modelId: string; // the provider invoke id (Bedrock inference-profile / model id today)
  provider: ServingProvider;
}

export interface ModelPlan {
  ref: ModelRef;
  fallback?: ModelRef;
  /** For the bilingual pivot (SPEC-BILINGUAL-CONVERSATIONS L2). 'en' until the catalog carries
   *  a per-model `workingLanguage`. */
  workingLanguage: string;
  /** Local-knowledge tool keys (tool registry). Empty until that registry lands. */
  tools: string[];
  /** The chosen model is a REASONING model (emits a chain-of-thought before the answer, e.g.
   *  DeepSeek-R1 on Bedrock). The caller must raise maxTokens (reasoning eats the budget before the
   *  answer) and skip tool-use (reasoning models are unreliable at tools). The reasoning text rides
   *  a separate `reasoningContent` block and is dropped by the normal text extraction. */
  reasoning?: boolean;
}

export interface RoutingContext {
  tier: ModelTier;
  intent?: string;
  /** Experiment override already resolved upstream (router `resolveExperimentModel`). Rule #1. */
  experimentModelId?: string;
  // NEW, optional signals — absent ⇒ today's behavior unchanged:
  userLanguage?: string;
  segment?: { country?: string; region?: string; lat?: number; lng?: number };
  externalModelConsent?: boolean;
  signals?: Record<string, string | number | boolean>;
}

export interface ResolveModelPlanDeps {
  catalog: Record<BackendModelKey, BackendModelDefinition>;
  strategy: IntentRouteDefinition[];
  profileDefaults: ProfileModelSelection;
  /** Context-aware routing master flag (`ENABLE_CONTEXT_ROUTING`). When false/absent, only rules
   *  1/3/4 apply — i.e. today's behavior, no context rules. */
  enabled?: boolean;
  /** The configured external CN provider (from `externalProviderFromEnv`), or null when none is
   *  wired — in which case Chinese turns simply stay on Bedrock. */
  cnProvider?: { provider: ServingProvider; modelId: string } | null;
  /** PREFERRED CN path: DeepSeek-on-Bedrock (in-AWS — Bedrock guardrails/resilience/billing, NO
   *  cross-border export, so NO consent gate). Intent-routed: reasoning-heavy intents → the
   *  reasoning model (R1), everything else → the chat model (V3). When set, this wins over the
   *  external `cnProvider` for Chinese turns. */
  cnBedrock?: {
    chatModelId: string;
    reasoningModelId: string;
    /** Intents that route to the reasoning model (e.g. report_generation / data_extraction / guided_troubleshooting). */
    reasoningIntents: string[];
  } | null;
  /** Deployment default for `externalModelConsent` when the per-user signal is absent
   *  (`EXTERNAL_MODEL_CONSENT_DEFAULT`): `true` in the private phase, `false` once public. */
  externalConsentDefault?: boolean;
}

/**
 * Resolve a model PLAN from a routing context. Rule order (first match wins; every rule
 * inherits the tier safety enforced by `resolveModelForIntent`):
 *   1. experiment override (unchanged)
 *   2. context rules (segment, signals) — extension point, none in phase 1
 *   3. intent route
 *   4. tier default
 */
export function resolveModelPlan(ctx: RoutingContext, deps: ResolveModelPlanDeps): ModelPlan {
  const { catalog, strategy, profileDefaults } = deps;

  // Rules 3 + 4: today's intent→tier resolution (with tier safety) is the baseline.
  const base = resolveModelForIntent(ctx.intent, ctx.tier, catalog, strategy, profileDefaults);

  // Rule 1: experiment override wins on the primary model id — identical to today's
  // `event.resolvedModel || resolution.primaryModelId`.
  const primaryModelId = ctx.experimentModelId || base.primaryModelId;
  const primaryModelKey: BackendModelKey | string = ctx.experimentModelId
    ? primaryModelId // experiment supplies a raw model id; key is not separately tracked today
    : base.primaryModelKey;

  // ── Rule 2: context rules (CN routing) ───────────────────────────────────────────────────
  // A Chinese turn = the user's language is zh OR the request's geographic segment is in China.
  const isChineseTurn = ctx.userLanguage === 'zh' || ctx.segment?.country === 'CN';

  // 2a. PREFERRED: DeepSeek-on-Bedrock. In-AWS (Bedrock guardrails/resilience/billing, no
  // cross-border export) ⇒ NO consent gate. Intent-routed: reasoning-heavy intents → R1 (reasoning),
  // everything else → V3 (chat, supports tool-use). The Sonnet baseline is the graceful fallback.
  if (deps.enabled && deps.cnBedrock && isChineseTurn) {
    const useReasoning = !!ctx.intent && deps.cnBedrock.reasoningIntents.includes(ctx.intent);
    const modelId = useReasoning ? deps.cnBedrock.reasoningModelId : deps.cnBedrock.chatModelId;
    return {
      ref: { modelKey: modelId, modelId, provider: 'bedrock' },
      fallback: { modelKey: primaryModelKey, modelId: primaryModelId, provider: 'bedrock' },
      workingLanguage: 'zh',
      tools: [],
      reasoning: useReasoning,
    };
  }

  // 2b. LEGACY: external Chinese provider (api.deepseek.com etc.). Cross-border ⇒ gated by the
  // master flag AND per-user consent (default from deployment config). Only reached when no
  // cnBedrock is configured. The in-AWS Bedrock baseline is the fallback.
  if (deps.enabled && deps.cnProvider && isChineseTurn) {
    const consented = ctx.externalModelConsent ?? deps.externalConsentDefault ?? false;
    if (consented) {
      return {
        ref: { modelKey: deps.cnProvider.modelId, modelId: deps.cnProvider.modelId, provider: deps.cnProvider.provider },
        fallback: { modelKey: primaryModelKey, modelId: primaryModelId, provider: 'bedrock' },
        workingLanguage: 'zh',
        tools: [], // external path is text-only in v1 (item-edit tools stay on Bedrock)
      };
    }
  }
  // ───────────────────────────────────────────────────────────────────────────────────────

  const ref: ModelRef = { modelKey: primaryModelKey, modelId: primaryModelId, provider: 'bedrock' };
  const fallback: ModelRef | undefined = base.fallbackModelId
    ? {
        modelKey: base.fallbackModelKey ?? base.fallbackModelId,
        modelId: base.fallbackModelId,
        provider: 'bedrock',
      }
    : undefined;

  return {
    ref,
    fallback,
    workingLanguage: 'en', // catalog `workingLanguage` (bilingual L2) will override this
    tools: [],
  };
}
