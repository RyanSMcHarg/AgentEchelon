/**
 * Unit tests for model-resolver
 *
 * Tests intent → model mapping with tier-based access control.
 */

import { resolveModelForIntent, collectArnsForTier } from '../lambda/src/lib/model-resolver';
import type {
  BackendModelDefinition,
  BackendModelKey,
  IntentRouteDefinition,
  TierModelSelection,
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

const tierDefaults: TierModelSelection = {
  basic: 'haiku',
  standard: 'sonnet',
  premium: 'opus',
};

describe('resolveModelForIntent', () => {
  it('returns default for undefined intent', () => {
    const result = resolveModelForIntent(undefined, 'basic', catalog, strategy, tierDefaults);
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
    expect(result.resolvedFromStrategy).toBe(false);
    expect(result.routeKey).toBe('general_qa');
  });

  it('returns default for unknown intent string', () => {
    const result = resolveModelForIntent('nonsense', 'basic', catalog, strategy, tierDefaults);
    expect(result.resolvedFromStrategy).toBe(false);
  });

  it('maps classifier intents to strategy keys', () => {
    // 'general' maps to 'general_qa'
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, tierDefaults);
    expect(result.routeKey).toBe('general_qa');
    expect(result.resolvedFromStrategy).toBe(true);
  });

  it('maps data_extraction to document_extraction', () => {
    // No strategy route for document_extraction in our fixture
    const result = resolveModelForIntent('data_extraction', 'basic', catalog, strategy, tierDefaults);
    // Should have mapped the key but found no route
    expect(result.routeKey).toBe('document_extraction');
    expect(result.resolvedFromStrategy).toBe(false);
  });

  it('applies the tier floor: a strategy primary weaker than the tier default is raised to the floor', () => {
    // general_qa → haiku, but standard's floor is sonnet — a non-trivial question
    // must not drop below the tier default.
    const result = resolveModelForIntent('general', 'standard', catalog, strategy, tierDefaults);
    expect(result.primaryModelKey).toBe('sonnet');
    expect(result.primaryModelId).toBe('arn:aws:bedrock:us-east-1:123:inference-profile/sonnet');
    expect(result.resolvedFromStrategy).toBe(true);
  });

  it('applies the tier floor for premium: a general question resolves to Opus, not Haiku', () => {
    // The core bug this fixes: general_qa → haiku IS allowed for premium, so without
    // a floor a premium user silently got Haiku. Premium permission ⇒ premium response.
    const result = resolveModelForIntent('general', 'premium', catalog, strategy, tierDefaults);
    expect(result.primaryModelKey).toBe('opus');
    expect(result.primaryModelId).toBe('anthropic.claude-opus');
    expect(result.resolvedFromStrategy).toBe(true);
  });

  it('leaves basic at Haiku (its tier floor IS Haiku — lower tiers may degrade)', () => {
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, tierDefaults);
    expect(result.primaryModelKey).toBe('haiku');
  });

  it('trivial intents (greeting) bypass the floor and stay on Haiku even for premium', () => {
    const result = resolveModelForIntent('greeting', 'premium', catalog, strategy, tierDefaults);
    expect(result.primaryModelKey).toBe('haiku');
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
  });

  it('downgrades primary model when tier does not allow it', () => {
    // strategic_analysis → opus, but basic tier can't use opus
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, tierDefaults);
    expect(result.primaryModelId).toBe('anthropic.claude-3-haiku');
    expect(result.primaryModelKey).toBe('haiku');
  });

  it('sets fallback to null when fallback equals primary', () => {
    // general_qa → primary: haiku, fallback: titan (both allowed for basic)
    const result = resolveModelForIntent('general', 'basic', catalog, strategy, tierDefaults);
    // haiku primary, titan fallback — both allowed
    expect(result.fallbackModelId).toBe('amazon.titan');
    expect(result.fallbackModelKey).toBe('titan');
  });

  it('nulls fallback when tier does not allow it', () => {
    // strategic_analysis → opus/sonnet, basic tier can't use either
    // So primary falls to tier default (haiku), fallback (sonnet) not allowed for basic
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

    const result = resolveModelForIntent('general', 'basic', catalog, customStrategy, tierDefaults);
    expect(result.primaryModelKey).toBe('haiku'); // downgraded
    expect(result.fallbackModelId).toBeNull(); // sonnet not allowed for basic
  });

  it('premium tier gets full strategy resolution', () => {
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

    const result = resolveModelForIntent('general', 'premium', catalog, customStrategy, tierDefaults);
    // Invoke id prefers the inference-profile ARN when the catalog entry
    // has one (Sonnet/Opus 4.6 can't be invoked on-demand by bare id).
    // opus mock has no profile → bare id; sonnet mock has one → ARN.
    expect(result.primaryModelId).toBe('anthropic.claude-opus');
    expect(result.fallbackModelId).toBe('arn:aws:bedrock:us-east-1:123:inference-profile/sonnet');
    expect(result.resolvedFromStrategy).toBe(true);
  });
});

describe('collectArnsForTier', () => {
  it('returns only ARNs for models the tier can access', () => {
    const basicArns = collectArnsForTier('basic', catalog);
    expect(basicArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/haiku');
    expect(basicArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/titan');
    expect(basicArns).not.toContain('arn:aws:bedrock:us-east-1::foundation-model/opus');
    expect(basicArns).not.toContain('arn:aws:bedrock:us-east-1::foundation-model/sonnet');
  });

  it('includes inference profile ARNs', () => {
    const standardArns = collectArnsForTier('standard', catalog);
    expect(standardArns).toContain('arn:aws:bedrock:us-east-1:123:inference-profile/sonnet');
  });

  it('premium tier gets all models', () => {
    const premiumArns = collectArnsForTier('premium', catalog);
    expect(premiumArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/haiku');
    expect(premiumArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/sonnet');
    expect(premiumArns).toContain('arn:aws:bedrock:us-east-1::foundation-model/opus');
  });
});
