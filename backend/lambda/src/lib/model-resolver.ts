/**
 * Model Resolver
 *
 * Maps classified intents to specific Bedrock models using the
 * INTENT_ROUTE_STRATEGY from model-strategy.ts. Enforces tier-based
 * access control at the code level — a basic-tier request will never
 * resolve to a premium-only model even if the strategy says so.
 *
 * Used by async processors to select the right model per intent.
 */

import type {
  BackendModelDefinition,
  BackendModelKey,
  RouteKey,
  IntentRouteDefinition,
  ModelTier,
  ProfileModelSelection,
} from '../../../lib/config/model-strategy.js';
import { bedrockInvokeId } from '../../../lib/config/model-strategy.js';

// Re-export for convenience
export type { BackendModelKey, ModelTier };

/**
 * Map from coarse IntentType (classifier output) to fine-grained RouteKey
 * (strategy input). The classifier produces 6 values; the strategy has 7 keys.
 * Unmapped classifier intents fall through to 'general_qa'.
 */
const INTENT_TYPE_TO_ROUTE_KEY: Record<string, RouteKey> = {
  general: 'general_qa',
  guided_troubleshooting: 'workflow_actions',
  data_extraction: 'document_extraction',
  report_generation: 'report_generation',
  greeting: 'general_qa',
  acknowledgment: 'general_qa',
};

/**
 * Normalize a coarse classifier intent to the fine-grained RouteKey the
 * strategy (and admin-defined experiments) key on. Mirrors the mapping this
 * module applies for model selection, so any consumer that needs to match a
 * turn against a route-keyed config (e.g. intent A/B experiments) sees the
 * SAME route the model resolver would pick. Unmapped intents fall through to
 * 'general_qa', exactly as resolveModelForIntent's default resolution does.
 */
export function intentTypeToRouteKey(intent: string | undefined): RouteKey {
  return (intent && INTENT_TYPE_TO_ROUTE_KEY[intent]) || 'general_qa';
}

// Ordinal capability/cost ranking, reusing each catalog entry's `costClass`.
// Used to enforce the tier floor: never resolve below the tier's default model.
const COST_RANK: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };

// Trivial intents that should stay on the cheapest capable model for ALL tiers —
// a greeting or "thanks" does not warrant a premium-grade invoke. Everything else
// is subject to the tier floor below.
const TRIVIAL_INTENTS = new Set<string>(['greeting', 'acknowledgment']);

export interface ModelResolution {
  primaryModelId: string;
  primaryModelKey: BackendModelKey;
  fallbackModelId: string | null;
  fallbackModelKey: BackendModelKey | null;
  routeKey: RouteKey;
  resolvedFromStrategy: boolean;
}

/**
 * Resolve the best model for a given intent and tier.
 *
 * 1. Maps the classifier's IntentType string to an RouteKey
 * 2. Looks up the INTENT_ROUTE_STRATEGY for that key
 * 3. Checks that the strategy's primaryModel is allowed for this tier
 * 4. Falls back to the tier's default model if not allowed
 * 5. Same logic for fallbackModel
 */
export function resolveModelForIntent(
  intent: string | undefined,
  tier: ModelTier,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  strategy: IntentRouteDefinition[],
  profileDefaults: ProfileModelSelection,
): ModelResolution {
  const defaultModel = catalog[profileDefaults[tier]];
  const defaultResolution: ModelResolution = {
    primaryModelId: bedrockInvokeId(defaultModel),
    primaryModelKey: defaultModel.key,
    fallbackModelId: null,
    fallbackModelKey: null,
    routeKey: 'general_qa',
    resolvedFromStrategy: false,
  };

  if (!intent) return defaultResolution;

  const routeKey = INTENT_TYPE_TO_ROUTE_KEY[intent];
  if (!routeKey) return defaultResolution;

  const route = strategy.find((r) => r.intent === routeKey);
  if (!route) return { ...defaultResolution, routeKey };

  // Resolve primary model — must be allowed for this tier
  const primaryDef = catalog[route.primaryModel];
  let primaryModelId: string;
  let primaryModelKey: BackendModelKey;

  if (primaryDef && primaryDef.allowedClassifications.includes(tier)) {
    // Tier floor: a strategy primary can be allowed for a tier yet weaker than
    // that tier's default model (e.g. general_qa → haiku, which IS allowed for
    // premium). For any non-trivial intent, never resolve below the tier default,
    // so a premium user gets a premium-grade response instead of silently
    // dropping to Haiku. Lower tiers still degrade to their own (cheaper) floor;
    // greetings/acknowledgments bypass the floor and stay on Haiku for everyone.
    const belowFloor = COST_RANK[primaryDef.costClass] < COST_RANK[defaultModel.costClass];
    if (intent && !TRIVIAL_INTENTS.has(intent) && belowFloor) {
      primaryModelId = bedrockInvokeId(defaultModel);
      primaryModelKey = defaultModel.key;
    } else {
      primaryModelId = bedrockInvokeId(primaryDef);
      primaryModelKey = primaryDef.key;
    }
  } else {
    // Primary not allowed for this tier — use tier default
    primaryModelId = bedrockInvokeId(defaultModel);
    primaryModelKey = defaultModel.key;
  }

  // Resolve fallback model — must be allowed for this tier and different from primary
  let fallbackModelId: string | null = null;
  let fallbackModelKey: BackendModelKey | null = null;

  const fallbackDef = catalog[route.fallbackModel];
  if (fallbackDef && fallbackDef.allowedClassifications.includes(tier) && fallbackDef.key !== primaryModelKey) {
    fallbackModelId = bedrockInvokeId(fallbackDef);
    fallbackModelKey = fallbackDef.key;
  }

  return {
    primaryModelId,
    primaryModelKey,
    fallbackModelId,
    fallbackModelKey,
    routeKey,
    resolvedFromStrategy: true,
  };
}

/**
 * Phase-3 vision-in guard helper: is this model able to accept image
 * input? A `/battle` turn carrying an image attachment whose resolved
 * variant model is text-only must be rejected with an actionable
 * message. Single source = the catalog's `visionCapable` flag.
 */
export function isVisionCapableModel(
  modelKey: BackendModelKey,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): boolean {
  return catalog[modelKey]?.visionCapable === true;
}

/**
 * What a battle variant should do for a given turn (SPEC-BATTLE.md
 * §"Image Battles — Vision-In"):
 *  - `text`              — no image on the turn; normal text battle.
 *  - `vision`            — image present + this variant's model can
 *                          read images → send a Converse image block.
 *  - `reject-text-only`  — image present but this variant's model is
 *                          text-only → the variant replies with an
 *                          actionable message (NOT a Bedrock call), so
 *                          the user knows to pick a vision-capable
 *                          pairing. The battle still runs; the other
 *                          (vision) variant answers normally.
 *
 * Pure decision — keeps the per-turn guard out of the in-flight async
 * path's branching and unit-testable on its own.
 */
export type VisionBattleAction = 'text' | 'vision' | 'reject-text-only';

export function resolveVisionBattleAction(
  modelKey: BackendModelKey,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  hasImageAttachment: boolean,
): VisionBattleAction {
  if (!hasImageAttachment) return 'text';
  return isVisionCapableModel(modelKey, catalog) ? 'vision' : 'reject-text-only';
}

/** Actionable reply a text-only variant posts when the turn has an image. */
export function visionRejectMessage(modelKey: string): string {
  return (
    `This battle turn includes an image, but this assistant's model ` +
    `(${modelKey}) can't read images. Re-run the battle with a ` +
    `vision-capable variant (Claude Haiku, Sonnet, or Opus), or send a ` +
    `text-only prompt.`
  );
}

/**
 * Collect all Bedrock ARNs that a given tier might need access to.
 * Used by CDK to generate IAM policies from the catalog rather than hardcoding.
 */
export function collectArnsForTier(
  tier: ModelTier,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): string[] {
  const arns: string[] = [];
  for (const model of Object.values(catalog)) {
    if (model.allowedClassifications.includes(tier)) {
      arns.push(...model.foundationModelArns);
      if (model.inferenceProfileArns) {
        arns.push(...model.inferenceProfileArns);
      }
    }
  }
  return arns;
}
