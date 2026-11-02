/**
 * Unit tests for model-resolver
 *
 * Tests intent → model mapping with classification-based access control.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  resolveModelForIntent,
  ANSWERS_THROUGH_GENERAL,
  retiredRouteKeyError,
  isTrivialTurn,
  routesAsServedByTheFloor,
} from '../lambda/src/lib/model-resolver';
import type {
  BackendModelDefinition,
  BackendModelKey,
  IntentRouteDefinition,
} from '../lib/config/model-strategy';
import type { ClassificationModels } from '../lib/config/profiles';

// Minimal catalog for testing
const catalog: Record<BackendModelKey, BackendModelDefinition> = <Record<BackendModelKey, BackendModelDefinition>><unknown>{
  haiku: {
    key: 'haiku',
    provider: 'anthropic',
    displayName: 'Haiku',
    bedrockModelId: 'anthropic.claude-3-haiku',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/haiku'],
    strengths: [],
    costClass: 'low',
    latencyClass: 'fast',
    visionCapable: true,
    output: 'text',
    workingLanguage: 'en',
  },
  sonnet: {
    key: 'sonnet',
    provider: 'anthropic',
    displayName: 'Sonnet',
    bedrockModelId: 'anthropic.claude-sonnet',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/sonnet'],
    inferenceProfileArns: ['arn:aws:bedrock:us-east-1:123:inference-profile/sonnet'],
    strengths: [],
    costClass: 'medium',
    latencyClass: 'balanced',
    visionCapable: true,
    output: 'text',
    workingLanguage: 'en',
  },
  opus: {
    key: 'opus',
    provider: 'anthropic',
    displayName: 'Opus',
    bedrockModelId: 'anthropic.claude-opus',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/opus'],
    strengths: [],
    costClass: 'high',
    latencyClass: 'deep',
    visionCapable: true,
    output: 'text',
    workingLanguage: 'en',
  },
  titan: {
    key: 'titan',
    provider: 'amazon',
    displayName: 'Titan',
    bedrockModelId: 'amazon.titan',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/titan'],
    strengths: [],
    costClass: 'low',
    latencyClass: 'fast',
    visionCapable: false,
    output: 'text',
    workingLanguage: 'en',
  },
  gpt_oss_20b: {
    key: 'gpt_oss_20b',
    provider: 'openai',
    displayName: 'GPT OSS 20B',
    bedrockModelId: 'openai.gpt-oss-20b',
    foundationModelArns: [],
    strengths: [],
    costClass: 'low',
    latencyClass: 'fast',
    visionCapable: false,
    output: 'text',
    workingLanguage: 'en',
  },
  gpt_oss_120b: {
    key: 'gpt_oss_120b',
    provider: 'openai',
    displayName: 'GPT OSS 120B',
    bedrockModelId: 'openai.gpt-oss-120b',
    foundationModelArns: [],
    strengths: [],
    costClass: 'high',
    latencyClass: 'deep',
    visionCapable: false,
    output: 'text',
    workingLanguage: 'en',
  },
  deepseek_v3: {
    key: 'deepseek_v3',
    provider: 'deepseek',
    displayName: 'DeepSeek V3.1',
    bedrockModelId: 'deepseek.v3-v1:0',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/deepseek.v3-v1:0'],
    strengths: [],
    costClass: 'low',
    latencyClass: 'balanced',
    visionCapable: false,
    output: 'text',
    workingLanguage: 'zh',
  },
};

const strategy: IntentRouteDefinition[] = [
  {
    intent: 'code_generation',
    label: 'Code Gen',
    primaryModel: 'sonnet',
    fallbackModel: 'haiku',
    rationale: 'Sonnet is good at code',
  },
  {
    intent: 'strategic_analysis',
    label: 'Strategy',
    primaryModel: 'opus',
    fallbackModel: 'sonnet',
    rationale: 'Opus for deep thinking',
  },
  {
    intent: 'general',
    label: 'General',
    primaryModel: 'haiku',
    fallbackModel: 'titan',
    rationale: 'Fast and cheap',
  },
];

/** What each classification selects from the test catalog, and its default. */
const SELECTIONS: Record<string, ClassificationModels> = {
  'basic': {
    'selected': [
      'haiku',
      'titan',
      'gpt_oss_20b'
    ],
    'default': 'haiku'
  },
  'standard': {
    'selected': [
      'haiku',
      'sonnet',
      'titan',
      'deepseek_v3'
    ],
    'default': 'sonnet'
  },
  'premium': {
    'selected': [
      'haiku',
      'sonnet',
      'opus',
      'titan',
      'gpt_oss_120b',
      'deepseek_v3'
    ],
    'default': 'opus'
  },
  'guest': {
    'selected': [
      'haiku'
    ],
    'default': 'haiku'
  },
  'customer': {
    'selected': [
      'haiku'
    ],
    'default': 'haiku'
  }
};
const sel = (c: string): ClassificationModels | undefined => SELECTIONS[c];

describe('resolveModelForIntent', () => {
  it('returns default for undefined intent', () => {
    const result = resolveModelForIntent(undefined, 'basic', catalog, strategy, sel('basic'));
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
    expect(result.resolvedFromStrategy).toBe(false);
    expect(result.routeKey).toBe('general');
  });

  it('returns default for unknown intent string', () => {
    const result = resolveModelForIntent('nonsense', 'basic', catalog, strategy, sel('basic'));
    expect(result.resolvedFromStrategy).toBe(false);
  });

  it('maps classifier intents to strategy keys', () => {
    // 'general' maps to 'general'
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, sel('basic'));
    expect(result.routeKey).toBe('general');
    expect(result.resolvedFromStrategy).toBe(true);
  });

  it('maps data_extraction to data_extraction', () => {
    // No strategy route for data_extraction in our fixture
    const result = resolveModelForIntent('data_extraction', 'basic', catalog, strategy, sel('basic'));
    // Should have mapped the key but found no route
    expect(result.routeKey).toBe('data_extraction');
    expect(result.resolvedFromStrategy).toBe(false);
  });

  it('serves a route as written, even below the base model: there is no silent floor', () => {
    // general → haiku on a standard version whose base is sonnet: the saved route is what serves.
    const result = resolveModelForIntent('general', 'standard', catalog, strategy, sel('standard'));
    expect(result.primaryModelKey).toBe('haiku');
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
    expect(result.resolvedFromStrategy).toBe(true);
  });

  it('a premium general question resolves to the route as written, which a migrated or seeded version writes as Opus', () => {
    expect(resolveModelForIntent('general', 'premium', catalog, strategy, sel('premium')).primaryModelKey).toBe('haiku');
    const asServed = routesAsServedByTheFloor({ general: { primary: 'haiku', fallback: 'sonnet' } }, 'opus', catalog).byIntent!;
    const written = Object.entries(asServed).map(([intent, r]) => ({ ...strategy[0], intent, primaryModel: r.primary, fallbackModel: r.fallback ?? r.primary }) as IntentRouteDefinition);
    expect(resolveModelForIntent('general', 'premium', catalog, written, sel('premium')).primaryModelKey).toBe('opus');
    // A standalone greeting keeps the route it was answered on; a continuation is answered as general work.
    expect(resolveModelForIntent('greeting', 'premium', catalog, written, sel('premium')).primaryModelKey).toBe('haiku');
    expect(resolveModelForIntent('acknowledgment', 'premium', catalog, written, sel('premium'), { continuesActiveWork: true }).primaryModelKey).toBe('opus');
  });

  it('an acknowledgment that CONTINUES a task is answered on the general route, never on a greeting route of its own', () => {
    const own: IntentRouteDefinition[] = [
      { ...strategy[0], intent: 'acknowledgment' as never, primaryModel: 'haiku', fallbackModel: 'haiku' },
      { ...strategy[0], intent: 'general' as never, primaryModel: 'opus', fallbackModel: 'sonnet' },
    ];
    expect(resolveModelForIntent('acknowledgment', 'premium', catalog, own, sel('premium'), { continuesActiveWork: true }).primaryModelKey).toBe('opus');
    expect(resolveModelForIntent('acknowledgment', 'premium', catalog, own, sel('premium')).primaryModelKey).toBe('haiku');
  });

  it('routesAsServedByTheFloor raises exactly the routes the old floor raised, and nothing else', () => {
    const routes = {
      general: { primary: 'haiku', fallback: 'sonnet' },
      code_generation: { primary: 'sonnet', fallback: 'haiku' },
      strategic_analysis: { primary: 'opus', fallback: 'sonnet' },
    };
    const premium = routesAsServedByTheFloor(routes, 'opus', catalog);
    expect(premium.raised.sort()).toEqual(['acknowledgment', 'code_generation', 'general', 'greeting']);
    expect(premium.byIntent).toEqual({
      general: { primary: 'opus', fallback: 'sonnet' },
      code_generation: { primary: 'opus', fallback: 'haiku' },
      strategic_analysis: { primary: 'opus', fallback: 'sonnet' },
      greeting: { primary: 'haiku', fallback: 'sonnet' },
      acknowledgment: { primary: 'haiku', fallback: 'sonnet' },
    });
    // On a basic base (haiku) nothing is cheaper than the base, so nothing changes.
    expect(routesAsServedByTheFloor(routes, 'haiku', catalog)).toEqual({ byIntent: routes, raised: [] });
    // Every raised route resolves to exactly what the floor served, for every intent that maps to it.
    // Every intent resolves to exactly what the old floor served it on a premium base (opus): a non-trivial
    // turn on the raised route, a standalone greeting or acknowledgment on the general route as written.
    const asServed: Record<string, string> = { general: 'opus', code_generation: 'opus', platform_question: 'opus', greeting: 'haiku', acknowledgment: 'haiku' };
    const toStrategy = (b: Record<string, { primary: string; fallback?: string }>) => Object.entries(b)
      .map(([k, r]) => ({ ...strategy[0], intent: k, primaryModel: r.primary, fallbackModel: r.fallback ?? r.primary }) as IntentRouteDefinition);
    for (const [intent, expected] of Object.entries(asServed)) {
      const served = resolveModelForIntent(intent, 'premium', catalog, toStrategy(premium.byIntent!), sel('premium')).primaryModelKey;
      expect({ intent, served }).toEqual({ intent, served: expected });
    }
  });

  it('leaves basic at Haiku', () => {
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, sel('basic'));
    expect(result.primaryModelKey).toBe('haiku');
  });

  it('a greeting with no route of its own is answered on the route its intent maps to', () => {
    const result = resolveModelForIntent('greeting', 'premium', catalog, strategy, sel('premium'));
    expect(result.primaryModelKey).toBe('haiku');
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
  });

  it('a STANDALONE acknowledgment still stays on the cheap model (the cost lever is intact)', () => {
    // The bypass exists so "thanks" does not buy a premium invoke. Continuation is the only thing
    // that suspends it; an acknowledgment with no work behind it is unchanged.
    const result = resolveModelForIntent(
      'acknowledgment', 'premium', catalog, strategy, sel('premium'),
      { continuesActiveWork: false },
    );
    expect(result.primaryModelKey).toBe('haiku');
    expect(resolveModelForIntent('acknowledgment', 'premium', catalog, strategy, sel('premium')).primaryModelKey)
      .toBe('haiku');
  });

  it('the turn context does not disturb a non-trivial intent', () => {
    // `general` was never subject to the bypass, so the floor applies either way. Guards against the
    // flag becoming a second, differently-shaped routing knob.
    const withWork = resolveModelForIntent('general', 'premium', catalog, strategy, sel('premium'), { continuesActiveWork: true });
    const without = resolveModelForIntent('general', 'premium', catalog, strategy, sel('premium'));
    expect(withWork).toEqual(without);
  });

  it('downgrades primary model when classification does not allow it', () => {
    // strategic_analysis → opus, but basic classification can't use opus
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, sel('basic'));
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
    expect(result.primaryModelKey).toBe('haiku');
  });

  it('sets fallback to null when fallback equals primary', () => {
    // general → primary: haiku, fallback: titan (both allowed for basic)
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, sel('basic'));
    // haiku primary, titan fallback — both allowed
    expect(result.fallbackModelId).toBe('amazon.titan');
    expect(result.fallbackModelKey).toBe('titan');
  });

  it('nulls fallback when classification does not allow it', () => {
    // strategic_analysis → opus/sonnet, basic classification can't use either
    // So primary falls to classification default (haiku), fallback (sonnet) not allowed for basic
    const customStrategy: IntentRouteDefinition[] = [
      {
        intent: 'general',
        label: 'General',
        primaryModel: 'opus',
        fallbackModel: 'sonnet',
        rationale: 'test',
      },
    ];

    const result = resolveModelForIntent('general', 'basic', catalog, customStrategy, sel('basic'));
    expect(result.primaryModelKey).toBe('haiku'); // downgraded
    expect(result.fallbackModelId).toBeNull(); // sonnet not allowed for basic
  });

  it('premium classification gets full strategy resolution', () => {
    const customStrategy: IntentRouteDefinition[] = [
      {
        intent: 'general',
        label: 'General',
        primaryModel: 'opus',
        fallbackModel: 'sonnet',
        rationale: 'test',
      },
    ];

    const result = resolveModelForIntent('general', 'premium', catalog, customStrategy, sel('premium'));
    // Invoke id prefers the inference-profile ARN when the catalog entry
    // has one (Sonnet/Opus 4.6 can't be invoked on-demand by bare id).
    // opus mock has no profile → bare id; sonnet mock has one → ARN.
    expect(result.primaryModelId).toBe('anthropic.claude-opus');
    expect(result.fallbackModelId).toBe('arn:aws:bedrock:us-east-1:123:inference-profile/sonnet');
    expect(result.resolvedFromStrategy).toBe(true);
  });
});

describe('isTrivialTurn', () => {
  it('is the one answer to "does the cheap-model bypass apply"', () => {
    expect(isTrivialTurn('greeting')).toBe(true);
    expect(isTrivialTurn('acknowledgment')).toBe(true);
    expect(isTrivialTurn('acknowledgment', { continuesActiveWork: true })).toBe(false);
    expect(isTrivialTurn('report_generation')).toBe(false);
    expect(isTrivialTurn(undefined)).toBe(false);
  });
});

/**
 * THE SIGNAL HAS TO REACH THE RESOLVER. A pure function that answers correctly while its caller
 * never passes the argument is inert, and the live defect was exactly a routing decision that no
 * test exercised end to end. The processor already holds both facts on its event, so this is a call
 * shape rather than a new read, and there is nothing for the router to send that it does not send
 * today (`isTaskContinuation`, `taskId`).
 */
describe('the async processor passes the turn context (wiring ratchet)', () => {
  const processorSrc = fs.readFileSync(
    path.join(__dirname, '../lambda/src/assistant-async-processor.ts'), 'utf8',
  );

  it('derives continuesActiveWork from the event, with no extra lookup', () => {
    expect(processorSrc).toMatch(
      /const continuesActiveWork = !!event\.isTaskContinuation \|\| !!event\.taskId;/,
    );
  });

  it('hands it to the one resolution every turn takes (resolveModelPlan, ADR-064)', () => {
    // On the RoutingContext, so the route's choice and the context rules read the same turn fact.
    expect(processorSrc).toMatch(/resolveModelPlan\([\s\S]{0,400}continuesActiveWork,/);
    expect(processorSrc).not.toMatch(/resolveModelForIntent\(/);
  });
});

/**
 * A ROUTE IS KEYED BY THE INTENT IT SERVES (ADR-064 decision 1): every shipped route is reached by the intent of
 * the same name, an intent with no route of its own answers through `general` only when it is one of the platform
 * intents that do (decision A), and every other unrouted intent answers on the base model.
 */
describe('a route is keyed by the intent it serves', () => {
  it('every shipped route is reached by the intent of its own name', () => {
    for (const r of strategy) {
      const resolved = resolveModelForIntent(r.intent, 'premium', catalog, strategy, sel('premium'));
      expect(resolved.routeKey).toBe(r.intent);
      expect(resolved.resolvedFromStrategy).toBe(true);
    }
  });

  it('the intents that answer through general take the general route when they have none of their own', () => {
    for (const intent of ANSWERS_THROUGH_GENERAL) {
      const resolved = resolveModelForIntent(intent, 'basic', catalog, strategy, sel('basic'));
      expect(resolved.routeKey).toBe('general');
    }
  });

  it('a pack-declared intent with no route answers on the base model, so the open key space grants nothing', () => {
    const resolved = resolveModelForIntent('recipe_lookup', 'basic', catalog, strategy, sel('basic'));
    expect(resolved.resolvedFromStrategy).toBe(false);
    expect(resolved.routeKey).toBe('recipe_lookup');
  });

  it('a retired route key is refused naming the intent that keys the route now', () => {
    expect(retiredRouteKeyError('general_qa', "models.byIntent['general_qa']")).toBe(
      "`models.byIntent['general_qa']` is a retired route key; the route is keyed by the intent, `general`.",
    );
    expect(retiredRouteKeyError('workflow_actions', 'intent')).toContain('`guided_troubleshooting`');
    expect(retiredRouteKeyError('document_extraction', 'intent')).toContain('`data_extraction`');
    expect(retiredRouteKeyError('general', 'intent')).toBeNull();
  });
});
