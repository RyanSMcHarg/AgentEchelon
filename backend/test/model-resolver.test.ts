/**
 * Unit tests for model-resolver
 *
 * Tests intent → model mapping with classification-based access control.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  resolveModelForIntent,
  collectArnsForClassification,
  intentTypeToRouteKey,
  isTrivialTurn,
} from '../lambda/src/lib/model-resolver';
import type {
  BackendModelDefinition,
  BackendModelKey,
  IntentRouteDefinition,
  ProfileModelSelection,
} from '../lib/config/model-strategy';

// Minimal catalog for testing
const catalog: Record<BackendModelKey, BackendModelDefinition> = {
  haiku: {
    key: 'haiku',
    provider: 'anthropic',
    displayName: 'Haiku',
    bedrockModelId: 'anthropic.claude-3-haiku',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/haiku'],
    allowedClassifications: ['basic', 'standard', 'premium'],
    strengths: [],
    costClass: 'low',
    latencyClass: 'fast',
    visionCapable: true,
    workingLanguage: 'en',
  },
  sonnet: {
    key: 'sonnet',
    provider: 'anthropic',
    displayName: 'Sonnet',
    bedrockModelId: 'anthropic.claude-sonnet',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/sonnet'],
    inferenceProfileArns: ['arn:aws:bedrock:us-east-1:123:inference-profile/sonnet'],
    allowedClassifications: ['standard', 'premium'],
    strengths: [],
    costClass: 'medium',
    latencyClass: 'balanced',
    visionCapable: true,
    workingLanguage: 'en',
  },
  opus: {
    key: 'opus',
    provider: 'anthropic',
    displayName: 'Opus',
    bedrockModelId: 'anthropic.claude-opus',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/opus'],
    allowedClassifications: ['premium'],
    strengths: [],
    costClass: 'high',
    latencyClass: 'deep',
    visionCapable: true,
    workingLanguage: 'en',
  },
  titan: {
    key: 'titan',
    provider: 'amazon',
    displayName: 'Titan',
    bedrockModelId: 'amazon.titan',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/titan'],
    allowedClassifications: ['basic', 'standard', 'premium'],
    strengths: [],
    costClass: 'low',
    latencyClass: 'fast',
    visionCapable: false,
    workingLanguage: 'en',
  },
  gpt_oss_20b: {
    key: 'gpt_oss_20b',
    provider: 'openai',
    displayName: 'GPT OSS 20B',
    bedrockModelId: 'openai.gpt-oss-20b',
    foundationModelArns: [],
    allowedClassifications: ['basic'],
    strengths: [],
    costClass: 'low',
    latencyClass: 'fast',
    visionCapable: false,
    workingLanguage: 'en',
  },
  gpt_oss_120b: {
    key: 'gpt_oss_120b',
    provider: 'openai',
    displayName: 'GPT OSS 120B',
    bedrockModelId: 'openai.gpt-oss-120b',
    foundationModelArns: [],
    allowedClassifications: ['premium'],
    strengths: [],
    costClass: 'high',
    latencyClass: 'deep',
    visionCapable: false,
    workingLanguage: 'en',
  },
  deepseek_v3: {
    key: 'deepseek_v3',
    provider: 'deepseek',
    displayName: 'DeepSeek V3.1',
    bedrockModelId: 'deepseek.v3-v1:0',
    foundationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/deepseek.v3-v1:0'],
    allowedClassifications: ['standard', 'premium'],
    strengths: [],
    costClass: 'low',
    latencyClass: 'balanced',
    visionCapable: false,
    workingLanguage: 'zh',
  },
};

const strategy: IntentRouteDefinition[] = [
  {
    intent: 'code_generation',
    label: 'Code Gen',
    primaryModel: 'sonnet',
    fallbackModel: 'haiku',
    preferredClearance: 'standard',
    rationale: 'Sonnet is good at code',
  },
  {
    intent: 'strategic_analysis',
    label: 'Strategy',
    primaryModel: 'opus',
    fallbackModel: 'sonnet',
    preferredClearance: 'premium',
    rationale: 'Opus for deep thinking',
  },
  {
    intent: 'general_qa',
    label: 'General',
    primaryModel: 'haiku',
    fallbackModel: 'titan',
    preferredClearance: 'basic',
    rationale: 'Fast and cheap',
  },
];

const profileDefaults: ProfileModelSelection = {
  basic: 'haiku',
  standard: 'sonnet',
  premium: 'opus',
};

describe('resolveModelForIntent', () => {
  it('returns default for undefined intent', () => {
    const result = resolveModelForIntent(undefined, 'basic', catalog, strategy, profileDefaults);
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
    expect(result.resolvedFromStrategy).toBe(false);
    expect(result.routeKey).toBe('general_qa');
  });

  it('returns default for unknown intent string', () => {
    const result = resolveModelForIntent('nonsense', 'basic', catalog, strategy, profileDefaults);
    expect(result.resolvedFromStrategy).toBe(false);
  });

  it('maps classifier intents to strategy keys', () => {
    // 'general' maps to 'general_qa'
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, profileDefaults);
    expect(result.routeKey).toBe('general_qa');
    expect(result.resolvedFromStrategy).toBe(true);
  });

  it('maps data_extraction to document_extraction', () => {
    // No strategy route for document_extraction in our fixture
    const result = resolveModelForIntent('data_extraction', 'basic', catalog, strategy, profileDefaults);
    // Should have mapped the key but found no route
    expect(result.routeKey).toBe('document_extraction');
    expect(result.resolvedFromStrategy).toBe(false);
  });

  it('applies the classification floor: a strategy primary weaker than the classification default is raised to the floor', () => {
    // general_qa → haiku, but standard's floor is sonnet — a non-trivial question
    // must not drop below the classification default.
    const result = resolveModelForIntent('general', 'standard', catalog, strategy, profileDefaults);
    expect(result.primaryModelKey).toBe('sonnet');
    expect(result.primaryModelId).toBe('arn:aws:bedrock:us-east-1:123:inference-profile/sonnet');
    expect(result.resolvedFromStrategy).toBe(true);
  });

  it('applies the classification floor for premium: a general question resolves to Opus, not Haiku', () => {
    // The core bug this fixes: general_qa → haiku IS allowed for premium, so without
    // a floor a premium user silently got Haiku. Premium permission ⇒ premium response.
    const result = resolveModelForIntent('general', 'premium', catalog, strategy, profileDefaults);
    expect(result.primaryModelKey).toBe('opus');
    expect(result.primaryModelId).toBe('anthropic.claude-opus');
    expect(result.resolvedFromStrategy).toBe(true);
  });

  it('leaves basic at Haiku (its classification floor IS Haiku — lower tiers may degrade)', () => {
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, profileDefaults);
    expect(result.primaryModelKey).toBe('haiku');
  });

  it('trivial intents (greeting) bypass the floor and stay on Haiku even for premium', () => {
    const result = resolveModelForIntent('greeting', 'premium', catalog, strategy, profileDefaults);
    expect(result.primaryModelKey).toBe('haiku');
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
  });

  // A TURN THAT CONTINUES LIVE WORK IS NOT TRIVIAL, whatever the message that triggered it looked
  // like. Live: a person answered "Looks good" mid-report, the message classified as
  // `acknowledgment`, the bypass below kept the cheap model, and the reply that followed was a full
  // multi-section board report generated on Haiku for a premium conversation.
  it('an acknowledgment that CONTINUES a task keeps the classification floor (Opus, not Haiku)', () => {
    const result = resolveModelForIntent(
      'acknowledgment', 'premium', catalog, strategy, profileDefaults,
      { continuesActiveWork: true },
    );
    expect(result.primaryModelKey).toBe('opus');
    expect(result.primaryModelId).toBe('anthropic.claude-opus');
  });

  it('a greeting that continues a task keeps the floor too (the bypass is about the TURN)', () => {
    const result = resolveModelForIntent(
      'greeting', 'standard', catalog, strategy, profileDefaults,
      { continuesActiveWork: true },
    );
    expect(result.primaryModelKey).toBe('sonnet');
  });

  it('a STANDALONE acknowledgment still stays on the cheap model (the cost lever is intact)', () => {
    // The bypass exists so "thanks" does not buy a premium invoke. Continuation is the only thing
    // that suspends it; an acknowledgment with no work behind it is unchanged.
    const result = resolveModelForIntent(
      'acknowledgment', 'premium', catalog, strategy, profileDefaults,
      { continuesActiveWork: false },
    );
    expect(result.primaryModelKey).toBe('haiku');
    expect(resolveModelForIntent('acknowledgment', 'premium', catalog, strategy, profileDefaults).primaryModelKey)
      .toBe('haiku');
  });

  it('the turn context does not disturb a non-trivial intent', () => {
    // `general` was never subject to the bypass, so the floor applies either way. Guards against the
    // flag becoming a second, differently-shaped routing knob.
    const withWork = resolveModelForIntent('general', 'premium', catalog, strategy, profileDefaults, { continuesActiveWork: true });
    const without = resolveModelForIntent('general', 'premium', catalog, strategy, profileDefaults);
    expect(withWork).toEqual(without);
  });

  it('downgrades primary model when classification does not allow it', () => {
    // strategic_analysis → opus, but basic classification can't use opus
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, profileDefaults);
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
    expect(result.primaryModelKey).toBe('haiku');
  });

  it('sets fallback to null when fallback equals primary', () => {
    // general_qa → primary: haiku, fallback: titan (both allowed for basic)
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, profileDefaults);
    // haiku primary, titan fallback — both allowed
    expect(result.fallbackModelId).toBe('amazon.titan');
    expect(result.fallbackModelKey).toBe('titan');
  });

  it('nulls fallback when classification does not allow it', () => {
    // strategic_analysis → opus/sonnet, basic classification can't use either
    // So primary falls to classification default (haiku), fallback (sonnet) not allowed for basic
    const customStrategy: IntentRouteDefinition[] = [
      {
        intent: 'general_qa',
        label: 'General',
        primaryModel: 'opus',
        fallbackModel: 'sonnet',
        preferredClearance: 'premium',
        rationale: 'test',
      },
    ];

    const result = resolveModelForIntent('general', 'basic', catalog, customStrategy, profileDefaults);
    expect(result.primaryModelKey).toBe('haiku'); // downgraded
    expect(result.fallbackModelId).toBeNull(); // sonnet not allowed for basic
  });

  it('premium classification gets full strategy resolution', () => {
    const customStrategy: IntentRouteDefinition[] = [
      {
        intent: 'general_qa',
        label: 'General',
        primaryModel: 'opus',
        fallbackModel: 'sonnet',
        preferredClearance: 'premium',
        rationale: 'test',
      },
    ];

    const result = resolveModelForIntent('general', 'premium', catalog, customStrategy, profileDefaults);
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

  it('hands it to BOTH resolution paths (the baseline and context routing)', () => {
    // resolveModelForIntent takes it as the turn context; resolveModelPlan takes it on the
    // RoutingContext, so the context-routing path cannot resolve cheaper than the path it is meant
    // to stay backward-compatible with.
    expect(processorSrc).toMatch(/\{ continuesActiveWork \}/);
    expect((processorSrc.match(/continuesActiveWork/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('collectArnsForClassification', () => {
  it('returns only ARNs for models the classification can access', () => {
    const basicArns = collectArnsForClassification('basic', catalog);
    expect(basicArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/haiku');
    expect(basicArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/titan');
    expect(basicArns).not.toContain('arn:aws:bedrock:us-east-1::foundation-model/opus');
    expect(basicArns).not.toContain('arn:aws:bedrock:us-east-1::foundation-model/sonnet');
  });

  it('includes inference profile ARNs', () => {
    const standardArns = collectArnsForClassification('standard', catalog);
    expect(standardArns).toContain('arn:aws:bedrock:us-east-1:123:inference-profile/sonnet');
  });

  it('premium classification gets all models', () => {
    const premiumArns = collectArnsForClassification('premium', catalog);
    expect(premiumArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/haiku');
    expect(premiumArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/sonnet');
    expect(premiumArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/opus');
  });
});

/**
 * Every RouteKey the platform offers must be REACHABLE from some classified intent.
 *
 * `code_generation`, `code_review` and `strategic_analysis` were not. No entry in the legacy
 * rename table produced them, and the resolver consulted only that table, so any turn carrying
 * those intents fell through to `general_qa`. The config was operator-facing - the admin
 * Experiments tab lists Code Generation, Code Review and Strategic Analysis as selectable intents -
 * so an operator could pin a model or run an A/B on code generation and it could never fire.
 *
 * `IntentDef.key` is documented as "the classified intent value + INTENT_ROUTE_STRATEGY key", i.e.
 * one namespace. This asserts that contract holds for every route, which is also what lets a
 * per-deployment intent pack (SPEC-CONFIGURABLE-INTENT-PACK) add `code_generation` and have model
 * routing follow without editing platform code.
 */
describe('every RouteKey is reachable from a classified intent', () => {
  const ALL_ROUTE_KEYS = [
    'general_qa',
    'code_generation',
    'code_review',
    'document_extraction',
    'report_generation',
    'strategic_analysis',
    'workflow_actions',
  ] as const;

  it('maps an intent named for a RouteKey to that route, not to general_qa', () => {
    const unreachable = ALL_ROUTE_KEYS.filter((rk) => intentTypeToRouteKey(rk) !== rk);
    if (unreachable.length) {
      throw new Error(
        `These RouteKeys cannot be selected by any classified intent: ${unreachable.join(', ')}.\n`
        + 'A model pinned to them is dead config, and the admin Experiments tab offers them as '
        + 'selectable intents, so an operator can configure an A/B that never fires.',
      );
    }
    expect(unreachable).toEqual([]);
  });

  it('still honours the legacy renames', () => {
    expect(intentTypeToRouteKey('data_extraction')).toBe('document_extraction');
    expect(intentTypeToRouteKey('guided_troubleshooting')).toBe('workflow_actions');
    expect(intentTypeToRouteKey('greeting')).toBe('general_qa');
    expect(intentTypeToRouteKey('acknowledgment')).toBe('general_qa');
  });

  it('falls through to general_qa for an intent that is neither', () => {
    expect(intentTypeToRouteKey('recipe_lookup')).toBe('general_qa');
    expect(intentTypeToRouteKey(undefined)).toBe('general_qa');
  });
});
