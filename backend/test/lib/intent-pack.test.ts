/**
 * Intent pack (lib/intent-pack.ts) — the per-deployment intent taxonomy.
 *
 * Pins two things:
 *  - BACK-COMPAT: with no `ASSISTANT_INTENT_PACK`, the active pack is the DEFAULT enterprise pack,
 *    so existing deployments classify + deliver exactly as before.
 *  - DEPLOYMENT OVERRIDE: a JSON pack (e.g. a domain-specific intent pack) replaces the domain intents,
 *    drives the classifier category list + keyword fallback, and maps each intent → delivery class.
 *    A malformed pack falls back to DEFAULT (a bad env var must never break classification).
 */
import {
  DEFAULT_INTENT_PACK,
  _resetIntentPackCache,
  classifyByPackKeywords,
  deliveryClassForIntent,
  getIntentPack,
  hydrateIntentPackFromSsm,
  intentPackCategoryLines,
  knownIntentKeys,
  responseSettingsForIntent,
  clampResponseMaxTokens,
} from '../../lambda/src/lib/intent-pack';

// An example custom domain pack (a recipe assistant) — stands in for any deployment's own taxonomy.
const DOMAIN_PACK = JSON.stringify([
  { key: 'find_recipe', description: 'Recipes for a dish or ingredient', keywords: ['recipe', 'cook', 'make'], delivery: 'PLACEHOLDER_UPDATE' },
  { key: 'wine_pairing', description: 'Drink / wine pairings for a meal', keywords: ['pairing', 'wine', 'what to drink'], delivery: 'PLACEHOLDER_UPDATE' },
  { key: 'nutrition_info', description: 'Nutrition / calorie info for a dish', keywords: ['calories', 'nutrition', 'macros'], delivery: 'PLACEHOLDER_UPDATE' },
  { key: 'meal_plan', description: 'Plan meals across a week', keywords: ['meal plan', 'weekly menu', 'plan meals'], delivery: 'PLACEHOLDER_UPDATE' },
]);

afterEach(() => {
  delete process.env.ASSISTANT_INTENT_PACK;
  _resetIntentPackCache();
});

describe('intent pack — back-compat (DEFAULT)', () => {
  test('no env ⇒ DEFAULT enterprise pack', () => {
    _resetIntentPackCache();
    expect(getIntentPack()).toBe(DEFAULT_INTENT_PACK);
    const keys = knownIntentKeys();
    expect(keys.has('greeting')).toBe(true);
    expect(keys.has('acknowledgment')).toBe(true);
    expect(keys.has('general')).toBe(true);
    expect(keys.has('guided_troubleshooting')).toBe(true);
    expect(keys.has('data_extraction')).toBe(true);
    expect(keys.has('report_generation')).toBe(true);
  });

  test('DEFAULT delivery classes unchanged', () => {
    _resetIntentPackCache();
    expect(deliveryClassForIntent('greeting')).toBe('DIRECT');
    expect(deliveryClassForIntent('acknowledgment')).toBe('DIRECT');
    expect(deliveryClassForIntent('general')).toBe('PLACEHOLDER_UPDATE');
    expect(deliveryClassForIntent('guided_troubleshooting')).toBe('TASK_MULTI_STEP');
    expect(deliveryClassForIntent('data_extraction')).toBe('TASK_MULTI_STEP');
    expect(deliveryClassForIntent('report_generation')).toBe('TASK_MULTI_STEP');
  });

  test('DEFAULT keyword fallback still matches enterprise terms', () => {
    _resetIntentPackCache();
    expect(classifyByPackKeywords('I have an error in my code')).toBe('guided_troubleshooting');
    expect(classifyByPackKeywords('extract the data from this')).toBe('data_extraction');
    expect(classifyByPackKeywords('generate a report')).toBe('report_generation');
    expect(classifyByPackKeywords('what is the capital of France')).toBeNull();
  });
});

describe('intent pack — deployment override (custom domain)', () => {
  test('domain pack replaces domain intents', () => {
    process.env.ASSISTANT_INTENT_PACK = DOMAIN_PACK;
    _resetIntentPackCache();
    const keys = knownIntentKeys();
    // universal three always present
    expect(keys.has('greeting')).toBe(true);
    expect(keys.has('general')).toBe(true);
    // domain intents present, enterprise ones gone
    expect(keys.has('find_recipe')).toBe(true);
    expect(keys.has('wine_pairing')).toBe(true);
    expect(keys.has('guided_troubleshooting')).toBe(false);
  });

  test('domain keyword fallback + delivery', () => {
    process.env.ASSISTANT_INTENT_PACK = DOMAIN_PACK;
    _resetIntentPackCache();
    expect(classifyByPackKeywords('what wine pairs with this?')).toBe('wine_pairing');
    expect(classifyByPackKeywords('find a recipe for dinner')).toBe('find_recipe');
    expect(deliveryClassForIntent('find_recipe')).toBe('PLACEHOLDER_UPDATE');
    // unknown domain key ⇒ safe default
    expect(deliveryClassForIntent('some_unknown_key')).toBe('PLACEHOLDER_UPDATE');
  });

  test('category lines feed the classifier prompt', () => {
    process.env.ASSISTANT_INTENT_PACK = DOMAIN_PACK;
    _resetIntentPackCache();
    const lines = intentPackCategoryLines();
    expect(lines).toContain('- FIND_RECIPE:');
    expect(lines).toContain('- WINE_PAIRING:');
    expect(lines).not.toContain('GUIDED_TROUBLESHOOTING');
  });

  test('object form { intents: [...] } also accepted', () => {
    process.env.ASSISTANT_INTENT_PACK = JSON.stringify({ intents: JSON.parse(DOMAIN_PACK) });
    _resetIntentPackCache();
    expect(knownIntentKeys().has('nutrition_info')).toBe(true);
  });

  test('a pack may not redefine a universal key', () => {
    process.env.ASSISTANT_INTENT_PACK = JSON.stringify([
      { key: 'greeting', description: 'x', keywords: [], delivery: 'TASK_MULTI_STEP' },
      { key: 'find_recipe', description: 'recipes', keywords: ['recipe'], delivery: 'PLACEHOLDER_UPDATE' },
    ]);
    _resetIntentPackCache();
    // greeting override dropped; still DIRECT
    expect(deliveryClassForIntent('greeting')).toBe('DIRECT');
    expect(knownIntentKeys().has('find_recipe')).toBe(true);
  });
});

describe('intent pack — SSM hydration (large packs)', () => {
  afterEach(() => {
    delete process.env.ASSISTANT_INTENT_PACK_PARAM;
    _resetIntentPackCache();
  });

  test('hydrated SSM value takes precedence over env + DEFAULT', async () => {
    process.env.ASSISTANT_INTENT_PACK_PARAM = '/agent-echelon/tier/standard/assistant-intent-pack';
    _resetIntentPackCache();
    await hydrateIntentPackFromSsm({ getParameter: async () => DOMAIN_PACK });
    expect(knownIntentKeys().has('find_recipe')).toBe(true);
    expect(knownIntentKeys().has('guided_troubleshooting')).toBe(false);
  });

  test('no param ⇒ hydrate is a no-op (DEFAULT stays)', async () => {
    _resetIntentPackCache();
    await hydrateIntentPackFromSsm({ getParameter: async () => DOMAIN_PACK });
    expect(getIntentPack()).toBe(DEFAULT_INTENT_PACK);
  });

  test('SSM fetch failure falls back to env/DEFAULT', async () => {
    process.env.ASSISTANT_INTENT_PACK_PARAM = '/agent-echelon/tier/standard/assistant-intent-pack';
    _resetIntentPackCache();
    await hydrateIntentPackFromSsm({ getParameter: async () => { throw new Error('ssm down'); } });
    expect(getIntentPack()).toBe(DEFAULT_INTENT_PACK);
  });
});

describe('intent pack — malformed ⇒ DEFAULT', () => {
  test('invalid JSON falls back', () => {
    process.env.ASSISTANT_INTENT_PACK = '{ not valid json';
    _resetIntentPackCache();
    expect(getIntentPack()).toBe(DEFAULT_INTENT_PACK);
  });

  test('empty array falls back', () => {
    process.env.ASSISTANT_INTENT_PACK = '[]';
    _resetIntentPackCache();
    expect(getIntentPack()).toBe(DEFAULT_INTENT_PACK);
  });

  test('wrong shape falls back', () => {
    process.env.ASSISTANT_INTENT_PACK = JSON.stringify({ foo: 'bar' });
    _resetIntentPackCache();
    expect(getIntentPack()).toBe(DEFAULT_INTENT_PACK);
  });
});

describe('intent pack — P3 per-intent response settings (maxTokens / verbosity)', () => {
  const PACK_WITH_SETTINGS = JSON.stringify([
    { key: 'logistics', description: 'scheduling, transit, timing', keywords: ['schedule', 'transit'], delivery: 'PLACEHOLDER_UPDATE', maxTokens: 700, verbosity: 'tight' },
    { key: 'research', description: 'deep research / write-ups', keywords: ['research'], delivery: 'PLACEHOLDER_UPDATE', maxTokens: 1600, verbosity: 'long' },
    { key: 'plain', description: 'no response settings', keywords: ['plain'], delivery: 'PLACEHOLDER_UPDATE' },
    { key: 'bad_settings', description: 'invalid settings dropped', keywords: ['bad'], delivery: 'PLACEHOLDER_UPDATE', maxTokens: -5, verbosity: 'verbose' },
  ]);

  test('coerceIntentDef keeps valid maxTokens + verbosity, drops invalid', () => {
    process.env.ASSISTANT_INTENT_PACK = PACK_WITH_SETTINGS;
    _resetIntentPackCache();
    expect(responseSettingsForIntent('logistics')).toEqual({ maxTokens: 700, verbosity: 'tight' });
    expect(responseSettingsForIntent('research')).toEqual({ maxTokens: 1600, verbosity: 'long' });
    // no settings ⇒ empty (processor uses its default budget)
    expect(responseSettingsForIntent('plain')).toEqual({});
    // negative maxTokens + unknown verbosity are dropped, not silently kept
    expect(responseSettingsForIntent('bad_settings')).toEqual({});
    // unknown / universal intents ⇒ empty
    expect(responseSettingsForIntent('greeting')).toEqual({});
    expect(responseSettingsForIntent('nope')).toEqual({});
  });

  test('clampResponseMaxTokens: per-intent budget wins, clamped to ceiling, reasoning floor', () => {
    const CEILING = 4096;
    // requested under the ceiling wins (the whole point — tight answers)
    expect(clampResponseMaxTokens(700, CEILING, false)).toBe(700);
    expect(clampResponseMaxTokens(1600, CEILING, false)).toBe(1600);
    // absent ⇒ the tier ceiling (today's default — unchanged behavior)
    expect(clampResponseMaxTokens(undefined, CEILING, false)).toBe(CEILING);
    // a request above the ceiling is clamped down
    expect(clampResponseMaxTokens(9000, CEILING, false)).toBe(CEILING);
    // junk ⇒ ceiling
    expect(clampResponseMaxTokens(0, CEILING, false)).toBe(CEILING);
    // reasoning turns keep a higher floor even if the intent asked for fewer
    expect(clampResponseMaxTokens(700, CEILING, true)).toBe(4000);
    expect(clampResponseMaxTokens(undefined, CEILING, true)).toBe(CEILING);
  });
});
