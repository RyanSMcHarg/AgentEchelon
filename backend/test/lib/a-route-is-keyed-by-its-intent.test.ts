/**
 * ADR-064 DECISION 1: A ROUTE IS KEYED BY THE INTENT IT SERVES.
 *
 * The rename table (`general` -> `general_qa`, `guided_troubleshooting` -> `workflow_actions`, `data_extraction` ->
 * `document_extraction`, and the universal intents -> `general_qa`) is deleted. This proves the shipped behavior is
 * unchanged by it: every intent of the shipped pack plus the universal intents, against every shipped and seeded
 * route set, resolves to the same primary and fallback, text and image, under the retired resolver (a frozen copy
 * held here, and only here) over the routes as they were keyed, and under the resolver over the routes as they are
 * keyed now. It also proves the retired keys are refused, naming the key that replaced them.
 */
import { resolveModelForIntent, isTrivialTurn, type TurnContext } from '../../lambda/src/lib/model-resolver';
import { buildIntentStrategy, platformRoutesServedOn, defaultImageRoute, validateDefinitionBody } from '../../lambda/src/lib/active-profile';
import { imageRouteFor } from '../../lambda/src/lib/image-route';
import { DEFAULT_INTENT_PACK, UNIVERSAL_INTENT_KEYS } from '../../lambda/src/lib/intent-pack';
import { getModelCatalog, INTENT_ROUTE_STRATEGY, bedrockInvokeId, type BackendModelDefinition, type BackendModelKey, type IntentRouteDefinition } from '../../lib/config/model-strategy';
import { DEFAULT_PROFILES_CONFIG, type ClassificationModels } from '../../lib/config/profiles';
import { validateAndSanitizeExperiment, ExperimentValidationError } from '../../lambda/src/lib/experiment-manager';

const catalog = getModelCatalog('us-east-1', '111122223333') as Record<BackendModelKey, BackendModelDefinition>;

/** THE RETIRED TABLE, frozen as it shipped. Held in this test only; nothing in the build reads it. */
const RETIRED_TABLE: Record<string, string> = {
  general: 'general_qa',
  guided_troubleshooting: 'workflow_actions',
  data_extraction: 'document_extraction',
  report_generation: 'report_generation',
  greeting: 'general_qa',
  acknowledgment: 'general_qa',
  conversation_summary: 'general_qa',
  set_preference: 'general_qa',
  show_preferences: 'general_qa',
  off_topic: 'general_qa',
  platform_question: 'general_qa',
};
const OLD_KEY_OF: Record<string, string> = { general: 'general_qa', guided_troubleshooting: 'workflow_actions', data_extraction: 'document_extraction' };
const oldKeyed = <R>(routes: Record<string, R>): Record<string, R> =>
  Object.fromEntries(Object.entries(routes).map(([k, r]) => [OLD_KEY_OF[k] ?? k, r]));

/** The retired resolver's route choice, frozen: a standalone trivial turn's own route, else the renamed key's. */
function retiredResolve(intent: string | undefined, models: ClassificationModels, strategy: IntentRouteDefinition[], turn: TurnContext) {
  const base = catalog[models.default as BackendModelKey];
  const selects = (k: string) => models.selected.includes(k);
  if (!intent) return { primary: base.key, fallback: null as string | null };
  const routeKey = RETIRED_TABLE[intent] ?? intent;
  const own = isTrivialTurn(intent, turn) ? strategy.find((r) => r.intent === intent) : undefined;
  const route = own ?? strategy.find((r) => r.intent === routeKey);
  if (!route) return { primary: base.key, fallback: null };
  const primary = catalog[route.primaryModel] && selects(route.primaryModel) ? route.primaryModel : base.key;
  const fb = catalog[route.fallbackModel] && selects(route.fallbackModel) && route.fallbackModel !== primary ? route.fallbackModel : null;
  return { primary, fallback: fb, id: bedrockInvokeId(catalog[primary as BackendModelKey]) };
}

const intents = [...new Set<string>([...DEFAULT_INTENT_PACK.intents.map((d) => d.key), ...UNIVERSAL_INTENT_KEYS, 'platform_question', 'pack_own_intent'])];
const classifications = DEFAULT_PROFILES_CONFIG.classifications.filter((c) => c.models && c.models.selected.length);

describe('a route is keyed by the intent it serves, and the shipped and seeded routes serve what they served', () => {
  const routeSets: Array<[string, Record<string, { primary: string; fallback?: string }>]> = [
    ['the shipped strategy', Object.fromEntries(INTENT_ROUTE_STRATEGY.map((r) => [r.intent, { primary: r.primaryModel, fallback: r.fallbackModel }]))],
    ...[...new Set(classifications.map((c) => c.models!.default))].map((base): [string, Record<string, { primary: string; fallback?: string }>] =>
      [`the seed on ${base}`, platformRoutesServedOn(base)]),
  ];

  it.each(routeSets)('%s: every intent, standalone and inside work, resolves to the same primary and fallback', (_label, routes) => {
    const newStrategy = buildIntentStrategy({ byIntent: routes })!;
    const oldStrategy = buildIntentStrategy({ byIntent: oldKeyed(routes) })!;
    let compared = 0;
    for (const c of classifications) {
      for (const intent of intents) {
        for (const turn of [{}, { continuesActiveWork: true }]) {
          const now = resolveModelForIntent(intent, c.value, catalog, newStrategy, c.models, turn);
          const then = retiredResolve(intent, c.models!, oldStrategy, turn);
          expect({ intent, c: c.value, turn, primary: now.primaryModelKey, fallback: now.fallbackModelKey })
            .toEqual({ intent, c: c.value, turn, primary: then.primary, fallback: then.fallback });
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(50);
  });

  it('every seeded image route serves the same image model, keyed by the image intent as before', () => {
    for (const c of classifications) {
      const routes = { ...platformRoutesServedOn(c.models!.default), ...defaultImageRoute(c.value) };
      for (const intent of intents) {
        expect(imageRouteFor({ byIntent: routes }, intent)).toEqual(imageRouteFor({ byIntent: oldKeyed(routes) }, RETIRED_TABLE[intent] ?? intent));
      }
    }
  });

  it('the shipped strategy and every seed are written in the intent keys', () => {
    for (const [, routes] of routeSets) {
      expect(Object.keys(routes)).not.toEqual(expect.arrayContaining(['general_qa']));
      for (const retired of ['general_qa', 'workflow_actions', 'document_extraction']) expect(routes[retired]).toBeUndefined();
    }
    expect(INTENT_ROUTE_STRATEGY.map((r) => r.intent)).toEqual(expect.arrayContaining(['general', 'data_extraction', 'guided_troubleshooting']));
  });
});

describe('a retired route key is refused, naming the intent that keys the route now', () => {
  it('in a version', () => {
    const errs = validateDefinitionBody({ modelKey: 'haiku', models: { byIntent: { general_qa: { primary: 'haiku' } } } } as never);
    expect(errs).toContain("`models.byIntent['general_qa']` is a retired route key; the route is keyed by the intent, `general`.");
  });

  it('in an experiment', () => {
    const exp = {
      experimentId: 'e', status: 'draft', experimentType: 'intent', intent: 'document_extraction', tiers: ['standard'],
      variants: [{ variantId: 'a', modelKey: 'haiku', weight: 50 }, { variantId: 'b', modelKey: 'sonnet', weight: 50 }],
    };
    expect(() => validateAndSanitizeExperiment(exp as never)).toThrow(ExperimentValidationError);
    expect(() => validateAndSanitizeExperiment(exp as never)).toThrow(/retired route key; the route is keyed by the intent, `data_extraction`/);
  });
});
