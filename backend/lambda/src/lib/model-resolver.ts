/**
 * Model Resolver
 *
 * Maps classified intents to specific Bedrock models using the
 * INTENT_ROUTE_STRATEGY from model-strategy.ts. Enforces classification-based
 * access control at the code level: a request never resolves to a model whose
 * allow-list does not name its classification, even if the strategy says so.
 *
 * Used by async processors to select the right model per intent.
 */

import type {
  BackendModelDefinition,
  BackendModelKey,
  RouteKey,
  IntentRouteDefinition,
  Classification,
} from '../../../lib/config/model-strategy.js';
import { bedrockInvokeId } from '../../../lib/config/model-strategy.js';
import type { ClassificationModels } from '../../../lib/config/profiles.js';

// Re-export for convenience
export type { BackendModelKey, Classification };

/**
 * THE ROUTE AN INTENT WITH NO ROUTE OF ITS OWN ANSWERS THROUGH, when it is one of {@link ANSWERS_THROUGH_GENERAL}
 * (ADR-064 decision A). A route is keyed by the intent it serves; there is no rename table.
 */
export const GENERAL_ROUTE_KEY = 'general';

/**
 * THE PLATFORM INTENTS THAT ANSWER THROUGH THE `general` ROUTE when the version gives them no route of their own:
 * ordinary conversation and the platform's own short replies. Declared beside the platform intents
 * (`PLATFORM_INTENT_NEEDS`, re-exported from `intent-pack.ts`) and shown in the console's Platform intents group.
 * Every other intent with no route of its own answers on the version's base model.
 */
export const ANSWERS_THROUGH_GENERAL: readonly string[] = [
  'general',
  'greeting',
  'acknowledgment',
  'conversation_summary',
  'set_preference',
  'show_preferences',
  'off_topic',
  'platform_question',
];
const ANSWERS_THROUGH_GENERAL_SET = new Set<string>(ANSWERS_THROUGH_GENERAL);

/** Whether an intent with no route of its own answers through the `general` route. */
export function answersThroughGeneral(intent: string | undefined): boolean {
  return !!intent && ANSWERS_THROUGH_GENERAL_SET.has(intent);
}

/**
 * THE ROUTE KEYS RETIRED BY ADR-064 decision 1, each with the intent key that now keys its route. Read only to
 * refuse a version or experiment that names one, naming the key to write instead; nothing resolves through them.
 */
export const RETIRED_ROUTE_KEYS: Readonly<Record<string, string>> = {
  general_qa: 'general',
  workflow_actions: 'guided_troubleshooting',
  document_extraction: 'data_extraction',
};

/** The refusal for a retired route key at `path` (`models.byIntent['general_qa']`, `intent`), or null. */
export function retiredRouteKeyError(key: string, path: string): string | null {
  const now = RETIRED_ROUTE_KEYS[key];
  return now ? '`' + path + '` is a retired route key; the route is keyed by the intent, `' + now + '`.' : null;
}

// Ordinal cost ranking, reusing each catalog entry's `costClass`. The resolver no longer reads it: it is
// what `routesAsServedByTheFloor` uses to write down, once, what the retired classification floor served.
const COST_RANK: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };

/**
 * The intents a STANDALONE turn of which takes a route of its own (`greeting`, `acknowledgment`) when the version
 * has one. A version that routes them separately answers "thanks" on a different model from a general question; one
 * that does not answers both through `general`. A greeting inside work in flight answers through `general`.
 */
export const TRIVIAL_ROUTE_KEYS: readonly string[] = ['greeting', 'acknowledgment'];
const TRIVIAL_INTENTS = new Set<string>(TRIVIAL_ROUTE_KEYS);

/**
 * What the TURN is doing, as distinct from what the incoming message looks like.
 *
 * The intent classifies the user's message; it does not describe the work the reply has to do. Those
 * two came apart live: "Looks good" classified as `acknowledgment`, a cheap route answered it, and the
 * reply that followed was a full multi-section board report generated on Haiku. The shape of a four-word
 * message decided the model for work that was already in flight.
 */
export interface TurnContext {
  /**
   * This turn continues work already in flight (a task the router resolved for it). A continuation
   * is never trivial however short the message that triggered it: the reply carries the task's work,
   * not the message's shape.
   *
   * The caller passes a fact it ALREADY holds - the router states it on the dispatch
   * (`isTaskContinuation`) and the turn's `taskId` is on the same event - so nothing here costs a
   * per-turn read.
   */
  continuesActiveWork?: boolean;
}

/**
 * Is this a standalone greeting or acknowledgment? Only when the intent is trivial AND the turn is not
 * carrying live work. Such a turn is answered through its own route (`greeting`, `acknowledgment`) when
 * the version has one; any other turn through the route its intent maps to.
 */
export function isTrivialTurn(intent: string | undefined, turn: TurnContext = {}): boolean {
  if (!intent || !TRIVIAL_INTENTS.has(intent)) return false;
  return !turn.continuesActiveWork;
}

/**
 * ── WHAT THE RETIRED CLASSIFICATION FLOOR SERVED, WRITTEN DOWN AS ROUTES ─────────────────────────────
 *
 * The resolver used to raise, on every non-trivial turn, a route whose primary model was cheaper than the
 * version's base model to that base model: a version said `general → haiku` and a premium turn was
 * answered on Opus. The served model was not the saved one. Routes are now served as written, so a body's
 * routes are rewritten ONCE to say what the floor served (seeds and the backfill of a body with no routes;
 * nothing else), and nothing changes for a person:
 *  - a route cheaper than the base model becomes the base model as its primary (its fallback is kept);
 *  - standalone greetings and acknowledgments were exempt from the floor and answered on the `general`
 *    route as written, so when that route is raised they get routes of their own (`greeting`,
 *    `acknowledgment`) carrying it as written, unless the body already routes them.
 * Pure; `raised` names each route this changed, for the caller to log or report. A route whose model the
 * catalog does not know, or a base that is not concrete, is left as it is.
 */
export function routesAsServedByTheFloor(
  byIntent: Record<string, { primary: string; fallback?: string }> | undefined,
  baseModelKey: string | undefined,
  catalog: Record<string, Pick<BackendModelDefinition, 'costClass'>>,
): { byIntent: Record<string, { primary: string; fallback?: string }> | undefined; raised: string[] } {
  const base = baseModelKey ? catalog[baseModelKey] : undefined;
  if (!byIntent || !base || !baseModelKey) return { byIntent, raised: [] };
  const raised: string[] = [];
  const out: Record<string, { primary: string; fallback?: string }> = {};
  for (const [intent, route] of Object.entries(byIntent)) {
    const primary = catalog[route.primary];
    // A trivial key's own route was never floored: it is what a standalone greeting is answered on.
    if (!TRIVIAL_INTENTS.has(intent) && primary && COST_RANK[primary.costClass] < COST_RANK[base.costClass]) {
      out[intent] = { ...route, primary: baseModelKey };
      raised.push(intent);
    } else {
      out[intent] = route;
    }
  }
  if (raised.includes(GENERAL_ROUTE_KEY)) {
    for (const trivial of TRIVIAL_ROUTE_KEYS) {
      if (!out[trivial]) {
        out[trivial] = { ...byIntent[GENERAL_ROUTE_KEY] };
        raised.push(trivial);
      }
    }
  }
  return { byIntent: out, raised };
}

export interface ModelResolution {
  primaryModelId: string;
  primaryModelKey: BackendModelKey;
  fallbackModelId: string | null;
  fallbackModelKey: BackendModelKey | null;
  /** The route this turn resolved to: an intent key, the intent's own or `general` (ADR-064 decision 1). */
  routeKey: string;
  resolvedFromStrategy: boolean;
  /** Which rule chose the model: the intent's own route, the `general` route it answers through, or the base model. */
  from: 'route' | 'general' | 'base';
}

/**
 * Resolve the best model for a given intent and classification.
 *
 * 1. Looks up the intent's own route (a standalone greeting or acknowledgment's own; any other intent's own), else
 *    the `general` route for an intent that answers through it (`ANSWERS_THROUGH_GENERAL`)
 * 2. Checks that the strategy's primaryModel is allowed for this classification
 * 3. Falls back to the classification's default model if not allowed
 * 4. Same logic for fallbackModel
 *
 * `turn` carries what the TURN is doing (see {@link TurnContext}); omitted ⇒ intent alone decides,
 * which is the historical behavior.
 */
export function resolveModelForIntent(
  intent: string | undefined,
  classification: Classification,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  strategy: IntentRouteDefinition[],
  models: ClassificationModels | undefined,
  turn: TurnContext = {},
): ModelResolution {
  // THE CLASSIFICATION'S OWN SELECTION AND DEFAULT (`models` on its registry entry; the profile's active base
  // model in place of the default where it chose one). A classification this deployment does not declare has
  // none: the turn is refused, never answered on a default that belongs to another classification.
  const defaultModel = models && models.selected.includes(models.default) ? catalog[models.default as BackendModelKey] : undefined;
  if (!defaultModel) {
    throw new Error(`[model-resolver] classification "${classification}" has no default model in its selection`);
  }
  const selects = (key: string) => models!.selected.includes(key);
  const defaultResolution: ModelResolution = {
    primaryModelId: bedrockInvokeId(defaultModel),
    primaryModelKey: defaultModel.key,
    fallbackModelId: null,
    fallbackModelKey: null,
    routeKey: GENERAL_ROUTE_KEY,
    resolvedFromStrategy: false,
    from: 'base',
  };

  if (!intent) return defaultResolution;

  // THE INTENT'S OWN ROUTE (ADR-064 decision 1). A greeting or acknowledgment takes its own only as a standalone
  // turn; inside work in flight it answers as the general reply it is. An intent with no route of its own answers
  // through `general` when it is one that does (decision A), else on the base model.
  const trivial = TRIVIAL_INTENTS.has(intent);
  const own = !trivial || isTrivialTurn(intent, turn) ? strategy.find((r) => r.intent === intent) : undefined;
  const general = !own && answersThroughGeneral(intent) ? strategy.find((r) => r.intent === GENERAL_ROUTE_KEY) : undefined;
  const route = own ?? general;
  const routeKey = route ? route.intent : intent;
  if (!route) return { ...defaultResolution, routeKey };

  // Resolve primary model — must be allowed for this classification
  const primaryDef = catalog[route.primaryModel];
  let primaryModelId: string;
  let primaryModelKey: BackendModelKey;

  // THE ROUTE IS SERVED AS WRITTEN, provided the classification allows its model. There is no silent
  // floor: a version that routes a simple intent to a cheaper model than its base is answered on that model,
  // because an assistant manager chose it. Routes that predate this were rewritten to say what the floor
  // served (`routesAsServedByTheFloor`). A classification minimum, if one is ever wanted, is an explicit
  // admin setting refused on write, never a swap here.
  if (primaryDef && selects(primaryDef.key)) {
    primaryModelId = bedrockInvokeId(primaryDef);
    primaryModelKey = primaryDef.key;
  } else {
    // Primary not allowed for this classification — use classification default
    primaryModelId = bedrockInvokeId(defaultModel);
    primaryModelKey = defaultModel.key;
  }

  // Resolve fallback model — must be allowed for this classification and different from primary
  let fallbackModelId: string | null = null;
  let fallbackModelKey: BackendModelKey | null = null;

  const fallbackDef = catalog[route.fallbackModel];
  if (fallbackDef && selects(fallbackDef.key) && fallbackDef.key !== primaryModelKey) {
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
    // A route whose primary the classification does not select served the base model in its place.
    from: primaryModelKey !== route.primaryModel ? 'base' : own ? 'route' : 'general',
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

