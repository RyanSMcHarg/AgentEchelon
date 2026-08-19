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
import { intentTypeToRouteKey } from '../../lambda/src/lib/model-resolver';

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

  test('image_generation is a first-class DEFAULT intent (PLACEHOLDER_UPDATE)', () => {
    _resetIntentPackCache();
    expect(knownIntentKeys().has('image_generation')).toBe(true);
    // A generated image is one reply updated in place — not a multi-step task.
    expect(deliveryClassForIntent('image_generation')).toBe('PLACEHOLDER_UPDATE');
    expect(intentPackCategoryLines()).toContain('- IMAGE_GENERATION:');
  });

  test('image_generation keywords BEAT report_generation for an image ask (declared first)', () => {
    _resetIntentPackCache();
    // "generate an image" contains report_generation's 'generate'; image_generation must win because it
    // is listed first and classifyByPackKeywords returns the first-listed match.
    expect(classifyByPackKeywords('generate an image of a mountain lake')).toBe('image_generation');
    expect(classifyByPackKeywords('create an image of a robot')).toBe('image_generation');
    expect(classifyByPackKeywords('make a picture of a sunset')).toBe('image_generation');
    expect(classifyByPackKeywords('draw a cat wearing a hat')).toBe('image_generation');
    expect(classifyByPackKeywords('please generate an image of a graph')).toBe('image_generation');
    // A plain report ask still classifies as report_generation (no image keyword present).
    expect(classifyByPackKeywords('generate a report on Q2 sales')).toBe('report_generation');
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
    process.env.ASSISTANT_INTENT_PACK_PARAM = '/agent-echelon/assistant/standard/assistant-intent-pack';
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
    process.env.ASSISTANT_INTENT_PACK_PARAM = '/agent-echelon/assistant/standard/assistant-intent-pack';
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

/**
 * Code work is its own intent by default.
 *
 * `code_generation` and `code_review` are RouteKeys in the model strategy and selectable intents in
 * the admin Experiments tab, but no default-pack intent emitted them, so the classifier could never
 * produce one and a code-specialist model pinned to that route was dead config.
 *
 * The ordering assertions are the load-bearing ones: `classifyByPackKeywords` returns the
 * FIRST-listed match, and `report_generation` owns the very broad 'generate'. Declaring the code
 * intents after it would silently route every "generate a function" to a multi-step report.
 */
describe('code_generation / code_review are in the default pack', () => {
  // THE CLASSIFIER IS THE LLM. Every default profile is `classifierMode: 'llm'`, and what the LLM
  // sees is `intentPackCategoryLines()` — the intent DESCRIPTIONS. `classifyByPackKeywords` is only
  // a fallback (a keyword-mode profile, or an LLM-classifier failure), so asserting keyword matches
  // would pin the wrong surface: a keyword test can pass while the shipped path is unchanged.
  it('offers both intents to the LLM classifier', () => {
    _resetIntentPackCache();
    const lines = intentPackCategoryLines();
    expect(lines).toContain('- CODE_GENERATION:');
    expect(lines).toContain('- CODE_REVIEW:');
  });

  it('describes them well enough for the LLM to separate them', () => {
    _resetIntentPackCache();
    const lines = intentPackCategoryLines();
    // The distinctions that matter are stated, not implied: authoring vs critique, and neither
    // is diagnosis. If these disappear the LLM has nothing to discriminate on.
    expect(lines).toMatch(/CODE_GENERATION:[^\n]*WRITE or MODIFY code/i);
    expect(lines).toMatch(/CODE_REVIEW:[^\n]*REVIEW, critique/i);
    expect(lines).toMatch(/CODE_GENERATION:[^\n]*guided_troubleshooting/i);
  });

  it('routes both to their own model-strategy key', () => {
    expect(intentTypeToRouteKey('code_generation')).toBe('code_generation');
    expect(intentTypeToRouteKey('code_review')).toBe('code_review');
  });

  // Fallback-only coverage. Ordering matters HERE because classifyByPackKeywords returns the first
  // match — but this path runs only when the LLM classifier is unavailable or a profile opts into
  // keyword mode. It is not how a default deployment classifies.
  it('fallback keyword path: does not steal image or troubleshooting requests', () => {
    _resetIntentPackCache();
    expect(classifyByPackKeywords('generate an image of a mountain lake')).toBe('image_generation');
    expect(classifyByPackKeywords('I have an error in my code')).toBe('guided_troubleshooting');
  });
});

/**
 * COMPLETENESS: every RouteKey must be reachable from an intent the DEFAULT PACK can actually emit.
 *
 * The weaker sibling assertion in model-resolver.test.ts only proves the identity mapping works —
 * that IF something classifies as `code_generation`, it routes there. This proves the other half:
 * that an intent capable of producing each route EXISTS. Without it, a route can be "reachable" in
 * principle and unreachable in practice, which is exactly the state `code_generation`,
 * `code_review` and `strategic_analysis` were in: routes in the model strategy, options in the
 * admin Experiments tab, and no classifier output that could ever select them.
 *
 * Deployments that supply their own pack are free to drop intents; this asserts the DEFAULT is
 * complete, so the shipped configuration surface has no dead entries.
 */
describe('the default pack covers every RouteKey', () => {
  it('leaves no route without an intent that can produce it', () => {
    const ALL_ROUTE_KEYS = [
      'general_qa',
      'code_generation',
      'code_review',
      'document_extraction',
      'report_generation',
      'strategic_analysis',
      'workflow_actions',
    ];

    // Everything the classifier can emit: the universal three plus the pack's domain intents.
    const emittable = [...knownIntentKeys(DEFAULT_INTENT_PACK)];
    const reachable = new Set(emittable.map((k) => intentTypeToRouteKey(k)));

    const dead = ALL_ROUTE_KEYS.filter((rk) => !reachable.has(rk as never));
    if (dead.length) {
      throw new Error(
        `RouteKeys with no default-pack intent that can produce them: ${dead.join(', ')}.\n`
        + 'These appear in the model strategy and the admin Experiments tab, so an operator can pin '
        + 'a model or start an A/B on them - and nothing will ever classify into them.\n'
        + `Intents the default pack can emit: ${emittable.join(', ')}`,
      );
    }
    expect(dead).toEqual([]);
  });

  it('offers strategic_analysis to the LLM classifier, distinguished from report_generation', () => {
    _resetIntentPackCache();
    const lines = intentPackCategoryLines();
    expect(lines).toContain('- STRATEGIC_ANALYSIS:');
    // The description must draw the boundary explicitly, since "analysis" alone is ambiguous
    // between a strategy judgement and a formatted write-up.
    expect(lines).toMatch(/STRATEGIC_ANALYSIS:[^\n]*report_generation/i);
  });

  it('fallback keyword path: strategic terms do not swallow ordinary analysis', () => {
    _resetIntentPackCache();
    // On the fallback path, strategic_analysis must not claim generic analysis phrasing — that
    // would change the delivery class of turns that are report_generation today.
    const verdict = classifyByPackKeywords('Analyze the pros and cons of microservices vs monolithic');
    expect(verdict).not.toBe('strategic_analysis');
    expect(classifyByPackKeywords('generate a report on Q2 sales')).toBe('report_generation');
  });
});

/**
 * SIZE BUDGET — the platform defaults must leave room for a deployment's own intents.
 *
 * A per-deployment pack is composed as `domain intents + DEFAULT_INTENT_PACK.intents` and stored in
 * ONE SSM parameter. SSM value size is a HARD limit — 4 KB Standard, 8 KB Advanced — and unlike
 * throughput or parameter count, AWS publishes no way to raise it. So every byte the PLATFORM adds
 * to the default pack is a byte a deployment cannot spend on its own taxonomy, in EVERY
 * classification's parameter.
 *
 * This is not hypothetical: adding code_generation / code_review / strategic_analysis took the demo
 * packs to 3674 / 4060 / 4633 bytes. Standard was left with 36 bytes of headroom and premium had to
 * move to Advanced tier. Nothing failed loudly at the time, because the seeder writes
 * write-if-absent — an over-size pack on an existing deployment is silently never applied. That
 * silence is what this budget exists to break.
 *
 * The durable fix is on the roadmap in SPEC-CONFIGURABLE-INTENT-PACK: an `extends` pack form so the
 * defaults (already compiled into the Lambda) stop being round-tripped through SSM at all. Until
 * that lands, this keeps the platform side honest.
 */
describe('intent pack size budget (SSM value limits are hard)', () => {
  const SSM_STANDARD_LIMIT = 4096;
  /** Bytes reserved for a deployment's own domain intents + the JSON envelope, inside Standard tier. */
  const DOMAIN_RESERVE = 900;
  const PLATFORM_BUDGET = SSM_STANDARD_LIMIT - DOMAIN_RESERVE;

  it('the DEFAULT pack leaves room for a deployment to add its own intents', () => {
    const size = JSON.stringify(DEFAULT_INTENT_PACK.intents).length;
    if (size > PLATFORM_BUDGET) {
      throw new Error(
        `DEFAULT_INTENT_PACK.intents is ${size} bytes; the budget is ${PLATFORM_BUDGET} `
        + `(SSM Standard ${SSM_STANDARD_LIMIT} minus ${DOMAIN_RESERVE} reserved for a deployment's own `
        + 'intents).\n'
        + 'Every byte here is spent again in EVERY classification\'s parameter, and an over-size pack '
        + 'is silently never applied by the write-if-absent seeder.\n'
        + 'Either tighten a description (keywords are fallback-only — the classifier is the LLM), or '
        + 'land the `extends` pack form so defaults stop being stored in SSM at all.',
      );
    }
    expect(size).toBeLessThanOrEqual(PLATFORM_BUDGET);
  });

  it('no single intent is disproportionately large', () => {
    // One runaway description is easier to fix than a diffuse overrun, and finding it late means
    // finding it as "the pack no longer fits" rather than "this entry got long".
    const oversized = DEFAULT_INTENT_PACK.intents
      .map((i) => ({ key: i.key, size: JSON.stringify(i).length }))
      .filter((i) => i.size > 700);
    expect(oversized.map((i) => `${i.key}=${i.size}`)).toEqual([]);
  });
});
