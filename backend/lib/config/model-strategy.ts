export type Classification = 'basic' | 'standard' | 'premium';
export type ProviderKey = 'anthropic' | 'amazon' | 'openai' | 'deepseek';
export type BackendModelKey =
  | 'haiku'
  | 'sonnet'
  | 'opus'
  | 'titan'
  | 'gpt_oss_20b'
  | 'gpt_oss_120b'
  | 'deepseek_v3';
export type RouteKey =
  | 'general_qa'
  | 'code_generation'
  | 'code_review'
  | 'document_extraction'
  | 'report_generation'
  | 'strategic_analysis'
  | 'workflow_actions';

export interface BackendModelDefinition {
  key: BackendModelKey;
  provider: ProviderKey;
  displayName: string;
  bedrockModelId: string;
  foundationModelArns: string[];
  inferenceProfileArns?: string[];
  allowedClassifications: Classification[];
  strengths: string[];
  costClass: 'low' | 'medium' | 'high';
  latencyClass: 'fast' | 'balanced' | 'deep';
  /**
   * True if the model accepts image input (Bedrock Converse image
   * content blocks). Required (not optional) so the catalog stays
   * exhaustive and parity-testable. Consumed by the Phase-3 image
   * vision-in `/battle` guard — a vision-in turn whose variant is
   * text-only must be rejected with an actionable message.
   */
  visionCapable: boolean;
  /**
   * The language this model reasons best in, as a short tag ('en' | 'zh' | …).
   * Required (like visionCapable) so the catalog stays exhaustive + parity-
   * testable. Consumed by the bilingual pivot (SPEC-BILINGUAL-CONVERSATIONS
   * Level 2 / ADR-014): when a turn's userLanguage !== the resolved model's
   * workingLanguage, the input is translated into workingLanguage for inference
   * and the output back. Default 'en' for current models — a no-op for English
   * users, so the field changes no current behaviour until a non-'en' model is
   * added.
   */
  workingLanguage: string;
}

export interface IntentRouteDefinition {
  intent: RouteKey;
  label: string;
  primaryModel: BackendModelKey;
  fallbackModel: BackendModelKey;
  preferredClearance: Classification;
  rationale: string;
}

export interface ProfileModelSelection {
  basic: BackendModelKey;
  standard: BackendModelKey;
  premium: BackendModelKey;
}

/**
 * The identifier to pass to Bedrock InvokeModel/Converse. Newer Anthropic
 * models (Sonnet 4.6, Opus 4.6) cannot be invoked on-demand by bare model
 * id — Bedrock requires an inference-profile id/ARN ("Invocation of model
 * ID … with on-demand throughput isn't supported"). When the catalog
 * entry carries an inference profile, that is the only valid invoke id;
 * otherwise the bare model id is correct (Haiku, Titan, GPT-OSS).
 */
export function bedrockInvokeId(def: BackendModelDefinition): string {
  return def.inferenceProfileArns?.[0] ?? def.bedrockModelId;
}

/**
 * Member regions of the `us.` Anthropic SYSTEM_DEFINED cross-region
 * inference profiles (Sonnet 4.6 / Opus 4.6).
 *
 * Bedrock evaluates `bedrock:InvokeModel` authorization against the
 * *destination* foundation-model ARN in whichever member region the
 * profile routes the request to — not the caller's region. So a role
 * that may only ever call from `us-east-1` STILL needs the
 * foundation-model resource granted in every member region, or the
 * invoke fails `AccessDeniedException` on e.g.
 * `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-opus-4-6-v1`.
 *
 * Verify via
 * `aws bedrock get-inference-profile us.anthropic.claude-opus-4-6-v1`
 * → "Routes requests to Anthropic Claude … in us-east-1, us-east-2 and
 * us-west-2." Foundation-model ARNs carry an empty account field, so
 * this set is account-independent and portable. Re-verify with that
 * CLI if AWS changes a profile's member set.
 */
export const US_CROSS_REGION_PROFILE_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
] as const;

/**
 * Foundation-model ARNs for a model invoked through a `us.` cross-region
 * inference profile: the deploy region plus every profile member region,
 * deduped. Consumed by the catalog so the IAM grant
 * (`collectArnsForTier` → `foundationModelArns`) covers every region the
 * profile can fan out to. A non-US deploy region is unioned in defensively
 * (the catalog still hardcodes `us.` profiles — a true non-US deployment
 * is out of scope and documented elsewhere).
 */
function crossRegionFoundationModelArns(region: string, modelId: string): string[] {
  const regions = Array.from(new Set([region, ...US_CROSS_REGION_PROFILE_REGIONS]));
  return regions.map((r) => `arn:aws:bedrock:${r}::foundation-model/${modelId}`);
}

export function getModelCatalog(region: string, account: string): Record<BackendModelKey, BackendModelDefinition> {
  return {
    haiku: {
      key: 'haiku',
      provider: 'anthropic',
      displayName: 'Claude Haiku',
      bedrockModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      foundationModelArns: [
        `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
      ],
      allowedClassifications: ['basic', 'standard', 'premium'],
      strengths: ['fast replies', 'low-cost triage', 'simple extraction'],
      costClass: 'low',
      latencyClass: 'fast',
      visionCapable: true,
      workingLanguage: 'en',
    },
    sonnet: {
      key: 'sonnet',
      provider: 'anthropic',
      displayName: 'Claude Sonnet 4.6',
      bedrockModelId: 'anthropic.claude-sonnet-4-6',
      // Cross-region profile (`us.`): IAM must cover every member region
      // Bedrock can route to, not just the deploy region. See
      // crossRegionFoundationModelArns / US_CROSS_REGION_PROFILE_REGIONS.
      foundationModelArns: crossRegionFoundationModelArns(region, 'anthropic.claude-sonnet-4-6'),
      inferenceProfileArns: [
        `arn:aws:bedrock:${region}:${account}:inference-profile/us.anthropic.claude-sonnet-4-6`,
      ],
      allowedClassifications: ['standard', 'premium'],
      strengths: ['coding tasks', 'reasoning', 'tool reliability'],
      costClass: 'medium',
      latencyClass: 'balanced',
      visionCapable: true,
      workingLanguage: 'en',
    },
    opus: {
      key: 'opus',
      provider: 'anthropic',
      displayName: 'Claude Opus 4.6',
      bedrockModelId: 'anthropic.claude-opus-4-6-v1',
      // Cross-region profile (`us.`): IAM must cover every member region
      // Bedrock can route to, not just the deploy region. See
      // crossRegionFoundationModelArns / US_CROSS_REGION_PROFILE_REGIONS.
      foundationModelArns: crossRegionFoundationModelArns(region, 'anthropic.claude-opus-4-6-v1'),
      inferenceProfileArns: [
        `arn:aws:bedrock:${region}:${account}:inference-profile/us.anthropic.claude-opus-4-6-v1`,
      ],
      allowedClassifications: ['premium'],
      strengths: ['deep analysis', 'complex architecture', 'high-stakes reasoning'],
      costClass: 'high',
      latencyClass: 'deep',
      visionCapable: true,
      workingLanguage: 'en',
    },
    titan: {
      key: 'titan',
      provider: 'amazon',
      // Titan Text Premier reached Bedrock end-of-life (ResourceNotFound
      // "this model version has reached the end of its life"). Nova Pro is
      // its current successor — the flagship Amazon text model, ON_DEMAND
      // capable (no inference profile needed). Catalog key stays 'titan'
      // so BackendModelKey/strategy/admin wiring is unaffected.
      displayName: 'Amazon Nova Pro',
      bedrockModelId: 'amazon.nova-pro-v1:0',
      foundationModelArns: [
        `arn:aws:bedrock:${region}::foundation-model/amazon.nova-pro-v1:0`,
      ],
      allowedClassifications: ['standard', 'premium'],
      strengths: ['summaries', 'structured drafting', 'bedrock-native fallback'],
      costClass: 'medium',
      latencyClass: 'balanced',
      visionCapable: false,
      workingLanguage: 'en',
    },
    gpt_oss_20b: {
      key: 'gpt_oss_20b',
      provider: 'openai',
      displayName: 'OpenAI GPT-OSS 20B',
      bedrockModelId: 'openai.gpt-oss-20b-1:0',
      foundationModelArns: [
        `arn:aws:bedrock:${region}::foundation-model/openai.gpt-oss-20b-1:0`,
      ],
      allowedClassifications: ['standard', 'premium'],
      strengths: ['low-cost coding support', 'fast drafting', 'OpenAI-on-Bedrock option'],
      costClass: 'medium',
      latencyClass: 'balanced',
      visionCapable: false,
      workingLanguage: 'en',
    },
    gpt_oss_120b: {
      key: 'gpt_oss_120b',
      provider: 'openai',
      displayName: 'OpenAI GPT-OSS 120B',
      bedrockModelId: 'openai.gpt-oss-120b-1:0',
      foundationModelArns: [
        `arn:aws:bedrock:${region}::foundation-model/openai.gpt-oss-120b-1:0`,
      ],
      allowedClassifications: ['premium'],
      strengths: ['deeper coding analysis', 'larger open-weight reasoning', 'OpenAI-on-Bedrock experimentation'],
      costClass: 'high',
      latencyClass: 'deep',
      visionCapable: false,
      workingLanguage: 'en',
    },
    // DeepSeek V3.2 — served IN-AWS via Amazon Bedrock (on-demand, Converse API), so it gets
    // Bedrock Guardrails + AWS billing and needs NO external API key / cross-border consent gate
    // (unlike the external `provider:'deepseek'` adapter in providers/external-llm.ts).
    // workingLanguage 'zh': strong Chinese fluency/reasoning — the Bedrock-native CN option for the
    // bilingual pivot / context-aware routing.
    //
    // Access: this is a Bedrock Marketplace model. The FIRST invocation auto-accepts the
    // marketplace offer (a confirmation email arrives) — there is no manual console "request
    // access" step. Subscription is account-level, but the classification Lambda's least-privilege role has
    // `bedrock:InvokeModel` and NOT `aws-marketplace:Subscribe`, so the account must be subscribed
    // once by a principal that can accept the offer (admin creds — done in dev us-east-1). After
    // that one-time acceptance the Lambda invokes freely.
    deepseek_v3: {
      key: 'deepseek_v3',
      provider: 'deepseek',
      displayName: 'DeepSeek V3.2 (Bedrock)',
      bedrockModelId: 'deepseek.v3.2',
      foundationModelArns: [
        `arn:aws:bedrock:${region}::foundation-model/deepseek.v3.2`,
      ],
      allowedClassifications: ['standard', 'premium'],
      strengths: ['Chinese fluency', 'strong reasoning', 'low-cost open-weight'],
      costClass: 'low',
      latencyClass: 'balanced',
      visionCapable: false,
      workingLanguage: 'zh',
    },
  };
}

export const DEFAULT_PROFILE_MODEL_SELECTION: ProfileModelSelection = {
  basic: 'haiku',
  standard: 'sonnet',
  premium: 'opus',
};

export function parseProfileModelSelection(
  requested: Partial<Record<Classification, string | undefined>>,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): ProfileModelSelection {
  const selection: ProfileModelSelection = { ...DEFAULT_PROFILE_MODEL_SELECTION };

  for (const classification of Object.keys(selection) as Classification[]) {
    const requestedKey = requested[classification] as BackendModelKey | undefined;
    if (!requestedKey) continue;

    const model = catalog[requestedKey];
    if (!model) {
      throw new Error(`Unknown model key "${requestedKey}" for classification "${classification}"`);
    }
    if (!model.allowedClassifications.includes(classification)) {
      throw new Error(`Model "${requestedKey}" is not allowed for classification "${classification}"`);
    }

    selection[classification] = requestedKey;
  }

  return selection;
}

export const INTENT_ROUTE_STRATEGY: IntentRouteDefinition[] = [
  {
    intent: 'general_qa',
    label: 'General Q&A',
    primaryModel: 'haiku',
    fallbackModel: 'sonnet',
    preferredClearance: 'basic',
    rationale: 'Fast, low-cost answers default to the cheapest capable model; fall back within Anthropic (Sonnet) rather than cross-provider. Basic classification (Sonnet not allowed) simply gets no fallback.',
  },
  {
    intent: 'code_generation',
    label: 'Code Generation',
    primaryModel: 'sonnet',
    fallbackModel: 'gpt_oss_20b',
    preferredClearance: 'standard',
    rationale: 'Coding work should support both Anthropic and OpenAI-on-Bedrock paths without forcing a premium-only default.',
  },
  {
    intent: 'code_review',
    label: 'Code Review',
    primaryModel: 'gpt_oss_20b',
    fallbackModel: 'sonnet',
    preferredClearance: 'standard',
    rationale: 'Detailed review should expose an OpenAI-on-Bedrock option while keeping a strong Anthropic fallback at the same classification.',
  },
  {
    intent: 'document_extraction',
    label: 'Document Extraction',
    primaryModel: 'haiku',
    fallbackModel: 'sonnet',
    preferredClearance: 'basic',
    rationale: 'Extraction and parsing optimize for throughput and cost; fall back within Anthropic (Sonnet) rather than cross-provider.',
  },
  {
    intent: 'report_generation',
    label: 'Report Generation',
    primaryModel: 'titan',
    fallbackModel: 'sonnet',
    preferredClearance: 'standard',
    rationale: 'Structured drafting and summaries benefit from a stable drafting model with a stronger reasoning fallback.',
  },
  {
    intent: 'strategic_analysis',
    label: 'Strategic Analysis',
    primaryModel: 'opus',
    fallbackModel: 'sonnet',
    preferredClearance: 'premium',
    rationale: 'Executive and strategic work should route to the deepest reasoning model available.',
  },
  {
    intent: 'workflow_actions',
    label: 'Workflow Actions',
    primaryModel: 'sonnet',
    fallbackModel: 'haiku',
    preferredClearance: 'standard',
    rationale: 'Tool-heavy workflows prefer the strongest action-group model; fall back within Anthropic (Haiku) rather than cross-provider.',
  },
];
