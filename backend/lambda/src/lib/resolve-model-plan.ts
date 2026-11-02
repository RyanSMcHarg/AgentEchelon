/**
 * Context-aware model routing — resolveModelPlan (SPEC-CONTEXT-AWARE-MODEL-ROUTING.md).
 *
 * Generalizes model resolution from the closed set (intent, classification, experiment) to an OPEN
 * RoutingContext, so new signals (request-segment geography, data-sensitivity, …) route without
 * new call sites.
 *
 * BACKWARD COMPATIBILITY IS THE INVARIANT, not a phase. With no context extensions
 * (no `segment`/`signals`), this returns EXACTLY today's resolution —
 *   effectiveModel = experimentModelId || resolveModelForIntent(...).primaryModelId
 *   fallback       = resolveModelForIntent(...).fallbackModelId
 * — as an in-AWS Bedrock plan, and test/lib/resolve-model-plan.test.ts locks that across the
 * classification x intent matrix.
 *
 * BUILT since: both CN context rules (2a DeepSeek-on-Bedrock, the preferred in-AWS path; 2b the
 * external provider, reached only where the classification selects its catalog model, `deepseek_api`) and the
 * external adapter they route to.
 * STILL DESIGN: the tool registry — `tools` is `[]` at every return site below.
 */
import type {
  BackendModelDefinition,
  BackendModelKey,
  IntentRouteDefinition,
  Classification,
} from '../../../lib/config/model-strategy.js';
import type { ClassificationModels } from '../../../lib/config/profiles.js';
import { resolveModelForIntent, type ModelResolution } from './model-resolver.js';
import { stepDelivers, type IntentRoute, type ModelFrom, type StepOutput } from './step-models.js';
import { bedrockInvokeId } from '../../../lib/config/model-strategy.js';
import type { When } from './variables.js';

/**
 * A VERSION'S ROUTING RULE (ADR-060 decision 6): a condition over the turn's deciding values (`signal:userLanguage`,
 * the conversation's type and classification) and the model it selects. It selects only among the models the
 * classification already selects (`models.selected`): the platform allows, the classification selects, the version
 * uses, and IAM, which grants the classification's role exactly its selection, is the second layer.
 */
export interface RoutingRule {
  when: When;
  /** A text model key of the catalog. */
  model: string;
}

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
  /**
   * Rule 2b matched (a Chinese turn, an external provider configured, no in-AWS CN model) and the
   * plan stayed on Bedrock because the answering assistant's version does not allow an external
   * provider. Set only in that case, so the caller can log the reason once for the turn.
   */
  externalProviderWithheld?: true;
  /** A version's routing rule chose the model (`ResolveModelPlanDeps.rules`). */
  routedBy?: 'version-rule';
  /** Which rule chose the model (ADR-064 decision 4): recorded on the turn as `model_from`. */
  modelFrom: ModelFrom;
  /**
   * THE ROUTE'S CHOICE BEFORE ANY OVERRIDE: the step's override, the task intent's route for a delivering step, or the
   * message intent's route, with its fallback. What an experiment, a routing rule or a context rule overrides, and what
   * the turn falls back to when that override fails.
   */
  routed: Omit<ModelResolution, 'from'> & { from: 'step' | 'route' | 'general' | 'base' };
}

export interface RoutingContext {
  classification: Classification;
  intent?: string;
  /** Experiment override already resolved upstream (router `resolveExperimentModel`). Rule #1. */
  experimentModelId?: string;
  /**
   * This turn continues work already in flight, so the trivial-intent bypass does not apply to it
   * (`TurnContext.continuesActiveWork` in model-resolver). Absent ⇒ intent alone decides, unchanged.
   */
  continuesActiveWork?: boolean;
  /**
   * THE TASK THIS TURN IS BOUND TO (ADR-064 decision B): the intent its steps are configured under (`taskIntentOf`), the
   * state it was in when the turn started, and what that state produces. A step the route overrides runs on its override;
   * a step that delivers runs on the task intent's route; every other turn runs on the message's intent. Absent on a turn
   * bound to no task.
   */
  task?: { intent?: string; step?: string; produces?: StepOutput };
  // NEW, optional signals — absent ⇒ today's behavior unchanged:
  userLanguage?: string;
  segment?: { country?: string; region?: string; lat?: number; lng?: number };
  signals?: Record<string, string | number | boolean>;
}

export interface ResolveModelPlanDeps {
  catalog: Record<BackendModelKey, BackendModelDefinition>;
  strategy: IntentRouteDefinition[];
  /** The classification's model selection and default (the profile's active base model in place of the default where it chose one). */
  models: ClassificationModels | undefined;
  /** Context-aware routing master flag (`ENABLE_CONTEXT_ROUTING`). When false/absent, only rules
   *  1/3/4 apply — i.e. today's behavior, no context rules. */
  enabled?: boolean;
  /** The configured external CN provider (from `externalProviderFromEnv`), or null when none is
   *  wired — in which case Chinese turns simply stay on Bedrock. */
  cnProvider?: { provider: ServingProvider; modelId: string } | null;
  /** PREFERRED CN path: DeepSeek-on-Bedrock (in-AWS — Bedrock guardrails/resilience/billing, NO
   *  cross-border export, so NO external-provider gate). Intent-routed: reasoning-heavy intents → the
   *  reasoning model (R1), everything else → the chat model (V3). When set, this wins over the
   *  external `cnProvider` for Chinese turns. */
  cnBedrock?: {
    chatModelId: string;
    reasoningModelId: string;
    /** Intents that route to the reasoning model (e.g. report_generation / data_extraction / guided_troubleshooting). */
    reasoningIntents: string[];
  } | null;
  /**
   * Whether this turn may go to a non-AWS provider: whether the classification selects the external adapter
   * (`deepseek_api` in its `models`), which is also what grants its key. A profile enables nothing. Only `true`
   * opens rule 2b; absent or false keeps the turn on the in-AWS Bedrock baseline.
   */
  externalProviderSelected?: boolean;
  /**
   * THE VERSION'S ROUTING RULES, in order, and whether a condition holds at this turn (`whenHolds` over the turn's
   * deciding values, read for the room, which reads the reply). The first rule whose condition holds and whose model
   * the classification selects serves the turn, after an experiment override and before the built-in context rules.
   */
  rules?: readonly RoutingRule[];
  holds?: (when: When) => boolean;
  /** The version's routes as written, whose `steps` overrides a turn bound to a task reads (`models.byIntent`). */
  routes?: Readonly<Record<string, Partial<IntentRoute> | undefined>>;
}

/**
 * THE ROUTE'S CHOICE FOR THIS TURN (ADR-064 decision B), before an experiment, a routing rule or a context rule:
 *  1. a turn bound to a task whose route overrides the step it starts in runs on the override, where the classification
 *     selects it and it is a text model;
 *  2. a step that delivers a document runs on the task intent's route, because the deliverable is the intent's work;
 *  3. every other turn runs on the message's intent: its own route, `general` where it answers through it, else the base.
 * An image step is the platform's act (`generate_image`) and never reaches this text resolution.
 */
export function routedModel(ctx: RoutingContext, deps: Pick<ResolveModelPlanDeps, 'catalog' | 'strategy' | 'models' | 'routes'>): ModelPlan['routed'] {
  const { catalog, strategy, models } = deps;
  const task = ctx.task;
  const override = task?.intent && task.step ? deps.routes?.[task.intent]?.steps?.[task.step] : undefined;
  const selects = (k: string | undefined): k is string => !!k && !!models?.selected.includes(k) && !!(catalog as Record<string, unknown>)[k];
  if (override && selects(override.primary)) {
    const primary = (catalog as Record<string, BackendModelDefinition>)[override.primary];
    const fb = override.fallback && override.fallback !== override.primary && selects(override.fallback)
      ? (catalog as Record<string, BackendModelDefinition>)[override.fallback] : undefined;
    return {
      primaryModelId: bedrockInvokeId(primary), primaryModelKey: primary.key,
      fallbackModelId: fb ? bedrockInvokeId(fb) : null, fallbackModelKey: fb ? fb.key : null,
      routeKey: task!.intent!, resolvedFromStrategy: true, from: 'step',
    };
  }
  const delivering = !!task?.intent && task.produces !== 'image' && stepDelivers(task.produces);
  return resolveModelForIntent(delivering ? task!.intent : ctx.intent, ctx.classification, catalog, strategy, models, {
    continuesActiveWork: delivering || ctx.continuesActiveWork,
  });
}

/**
 * Resolve a model PLAN from a routing context. Rule order (first match wins; every rule
 * inherits the classification safety enforced by `resolveModelForIntent`):
 *   1. experiment override
 *   2. the version's routing rules, then the context rules (segment, signals)
 *   3. the route's choice (`routedModel`): a step override, a delivering step's task route, the message intent's route
 *   4. classification default
 * Every turn the processor answers is resolved here, once (SPEC-CONTEXT-AWARE-MODEL-ROUTING FR1).
 */
export function resolveModelPlan(ctx: RoutingContext, deps: ResolveModelPlanDeps): ModelPlan {
  const { catalog, strategy, models } = deps;

  // Rules 3 + 4: the route's choice for this turn (with classification safety) is the baseline.
  const base = routedModel(ctx, deps);

  // Rule 1: experiment override wins on the primary model id — identical to today's
  // `event.resolvedModel || resolution.primaryModelId`.
  const primaryModelId = ctx.experimentModelId || base.primaryModelId;
  const primaryModelKey: BackendModelKey | string = ctx.experimentModelId
    ? primaryModelId // experiment supplies a raw model id; key is not separately tracked today
    : base.primaryModelKey;

  // ── Rule 2, first: the version's routing rules (ADR-060 decision 6) ──────────────────────────────────
  // Never over an experiment override (rule 1), and only a model the classification selects: a rule naming any other
  // is passed over, so a version cannot reach a model its classification's role was not granted.
  if (!ctx.experimentModelId && deps.rules?.length && deps.holds) {
    const selected = new Set(models?.selected ?? []);
    for (const rule of deps.rules) {
      const def = (catalog as Record<string, BackendModelDefinition | undefined>)[rule.model];
      if (!def || !selected.has(rule.model)) continue;
      if (!deps.holds(rule.when)) continue;
      const modelId = bedrockInvokeId(def);
      return {
        ref: { modelKey: rule.model, modelId, provider: 'bedrock' },
        fallback: { modelKey: primaryModelKey, modelId: primaryModelId, provider: 'bedrock' },
        workingLanguage: 'en',
        tools: [],
        routedBy: 'version-rule',
        modelFrom: 'version_rule',
        routed: base,
      };
    }
  }

  // ── Rule 2: context rules (CN routing) ───────────────────────────────────────────────────
  // A Chinese turn = the user's language is zh OR the request's geographic segment is in China.
  const isChineseTurn = ctx.userLanguage === 'zh' || ctx.segment?.country === 'CN';

  // 2a. PREFERRED: DeepSeek-on-Bedrock. In-AWS (Bedrock guardrails/resilience/billing, no
  // cross-border export) ⇒ NO external-provider gate. Intent-routed: reasoning-heavy intents → R1 (reasoning),
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
      modelFrom: 'context_rule',
      routed: base,
    };
  }

  // 2b. External Chinese provider (api.deepseek.com etc.). Conversation content leaves AWS, so it is
  // gated by the master flag AND by the classification selecting the external adapter (`deepseek_api`). Fail closed: only an explicit `true` opens it. Only reached
  // when no cnBedrock is configured. The in-AWS Bedrock baseline is the fallback.
  let externalProviderWithheld = false;
  if (deps.enabled && deps.cnProvider && isChineseTurn) {
    if (deps.externalProviderSelected === true) {
      return {
        ref: { modelKey: deps.cnProvider.modelId, modelId: deps.cnProvider.modelId, provider: deps.cnProvider.provider },
        fallback: { modelKey: primaryModelKey, modelId: primaryModelId, provider: 'bedrock' },
        workingLanguage: 'zh',
        tools: [], // external path is text-only in v1 (item-edit tools stay on Bedrock)
        modelFrom: 'context_rule',
        routed: base,
      };
    }
    externalProviderWithheld = true;
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
    ...(externalProviderWithheld ? { externalProviderWithheld: true as const } : {}),
    modelFrom: ctx.experimentModelId ? 'experiment' : base.from,
    routed: base,
  };
}
