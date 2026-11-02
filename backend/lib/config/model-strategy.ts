/**
 * THE BEDROCK TEXT MODELS OF THE INSTANCE'S CATALOG (`model-catalog.ts`): every one the platform allows, by key, with
 * no classification on any of them. Which a classification may use is its own `models` selection
 * (`lib/config/profiles.ts`), and its stack grants exactly those.
 */
/**
 * A CLASSIFICATION VALUE THIS DEPLOYMENT DECLARES (`profiles`, `lib/config/profiles.ts`). A string, never a
 * union of the shipped sample's names: a classification is configuration, so which values exist is the
 * registry's answer (`ProfileRegistry.isKnownClassification`), and a value it does not know is refused
 * where it arrives rather than narrowed by a cast.
 */
export type Classification = string;
export type ProviderKey = 'anthropic' | 'amazon' | 'openai' | 'deepseek';
export type BackendModelKey =
  | 'haiku'
  | 'sonnet'
  | 'opus'
  | 'titan'
  | 'gpt_oss_20b'
  | 'gpt_oss_120b'
  | 'deepseek_v3'
  | 'deepseek_r1';
/**
 * A ROUTE IS KEYED BY THE INTENT IT SERVES (ADR-064 decision 1): the classifier's intent key, the same key the intent
 * pack declares, the console's card shows and an analytics row records. There is no second vocabulary.
 */
export type RouteKey = string;

export interface BackendModelDefinition {
  key: BackendModelKey;
  provider: ProviderKey;
  displayName: string;
  bedrockModelId: string;
  foundationModelArns: string[];
  inferenceProfileArns?: string[];
  /**
   * WHAT THE MODEL IS FOR: every model in this catalog answers in text. Image models carry `'image'` in the
   * image registry, and a model serves only uses whose need matches its output (`modelFits` in
   * `model-availability.ts`). Required, so a new entry cannot leave its purpose unstated.
   */
  output: 'text';
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
   * users, so the field changes no current behavior until a non-'en' model is
   * added.
   */
  workingLanguage: string;
}

export interface IntentRouteDefinition {
  intent: RouteKey;
  label: string;
  primaryModel: BackendModelKey;
  fallbackModel: BackendModelKey;
  rationale: string;
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
 * The catalog's model KEYS — the stable selection vocabulary every write path validates against.
 *
 * DERIVED from the catalog rather than restated, so it cannot drift from the definitions the way a
 * hand-maintained list would. The region/account arguments are placeholders on purpose: only the keys are
 * read here, and the ARNs they would build are never looked at. Callers that need a real ARN must call
 * `getModelCatalog` with the deployment's own values.
 *
 * A key is what profiles and experiment variants STORE (SPEC-PORTABLE §5: a model by catalog key, never a
 * Bedrock ARN, so a version stays instance-agnostic and can move between deployments and regions). The
 * Bedrock id is resolved from it per-deployment at runtime by `bedrockInvokeId`.
 */
export function modelCatalogKeys(): ReadonlySet<string> {
  return new Set(Object.keys(getModelCatalog('us-east-1', '000000000000')));
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
/**
 * THE SMALL, FAST MODEL EVERY UTILITY STEP USES, named once.
 *
 * Intent classification, conversation titling, drift reasoning, conversation summaries, analytics
 * recommendations and the evaluation judge are all the same shape of work: a short prompt, a short
 * answer, running either on somebody's turn or on a batch nobody is watching. They do not each get to
 * pick a model.
 *
 * WHY THIS CONSTANT EXISTS. They DID each pick, by writing the same literal into fourteen files, and
 * on 2026-09-17 that literal turned out to be `anthropic.claude-3-haiku-20240307-v1:0`, which Amazon
 * Bedrock reports as "This model version has reached the end of its life". It still invoked through a
 * legacy inference profile, so nothing had failed and nothing had noticed. Fourteen copies is fourteen
 * chances to miss the next one. This is tenet D7 applied to a model id.
 *
 * ON-DEMAND THROUGHPUT FOR THIS MODEL IS SERVED THROUGH A CROSS-REGION PROFILE, so the id a caller
 * hands Bedrock is the PROFILE id, and IAM has to cover the profile plus every member region it can
 * route to. `utilityModelArns` builds that set; it is not hand-written at the call site.
 */
export const UTILITY_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** The underlying foundation model behind {@link UTILITY_MODEL_ID}, which is what IAM names. */
export const UTILITY_MODEL_FOUNDATION_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Every ARN a principal needs in order to invoke {@link UTILITY_MODEL_ID}: the account's inference
 * profile, and the foundation model in each region that profile is allowed to route to.
 */
export function utilityModelArns(region: string, account: string): string[] {
  return [
    ...crossRegionFoundationModelArns(region, UTILITY_MODEL_FOUNDATION_ID),
    `arn:aws:bedrock:${region}:${account}:inference-profile/${UTILITY_MODEL_ID}`,
  ];
}

export const US_CROSS_REGION_PROFILE_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
] as const;

/**
 * Foundation-model ARNs for a model invoked through a `us.` cross-region
 * inference profile: the deploy region plus every profile member region,
 * deduped. Consumed by the catalog so the IAM grant
 * (`modelArnsForClassification` → `foundationModelArns`) covers every region the
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
      displayName: 'Claude Haiku 4.5',
      // CLAUDE 3 HAIKU IS END OF LIFE ON AMAZON BEDROCK, AND THAT DECIDES THIS (2026-09-17).
      //
      // `GetFoundationModel` on `anthropic.claude-3-haiku-20240307-v1:0` answers
      // `ResourceNotFoundException: This model version has reached the end of its life`, and no
      // Claude 3 model appears in `ListFoundationModels` at all. It still INVOKES through its legacy
      // inference profile, which is why nothing had failed yet - an availability that ends without
      // this deployment doing anything.
      //
      // THE LATENCY GOES THE WRONG WAY AND IS ACCEPTED. This entry also sets `CLASSIFIER_MODEL_ID`
      // (`assistant-profile-stack.ts`), and the intent classifier is the largest step in front of a
      // person's first feedback. Measured through the deployed path on the probe classification:
      // Haiku 4.5 at 728, 689 and 708 ms against Claude 3 Haiku at 360 to 627 ms. A one-word
      // classification gains nothing from a larger model and pays a higher latency floor, so this is
      // roughly +80 ms on every turn whose message misses `fastPathIntent`. It is paid because the
      // alternative is a model that is scheduled to stop answering.
      //
      // Cross-region profile (`us.`), like sonnet below: on-demand throughput for this model is
      // served through the profile, so `bedrockModelId` is the PROFILE id and IAM must cover every
      // member region the profile can route to, not just the deploy region.
      bedrockModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      foundationModelArns: crossRegionFoundationModelArns(region, 'anthropic.claude-haiku-4-5-20251001-v1:0'),
      inferenceProfileArns: [
        `arn:aws:bedrock:${region}:${account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
      ],
      strengths: ['fast replies', 'low-cost triage', 'simple extraction'],
      costClass: 'low',
      latencyClass: 'fast',
      visionCapable: true,
      output: 'text',
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
      strengths: ['coding tasks', 'reasoning', 'tool reliability'],
      costClass: 'medium',
      latencyClass: 'balanced',
      visionCapable: true,
      output: 'text',
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
      strengths: ['deep analysis', 'complex architecture', 'high-stakes reasoning'],
      costClass: 'high',
      latencyClass: 'deep',
      visionCapable: true,
      output: 'text',
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
      strengths: ['summaries', 'structured drafting', 'bedrock-native fallback'],
      costClass: 'medium',
      latencyClass: 'balanced',
      visionCapable: false,
      output: 'text',
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
      strengths: ['low-cost coding support', 'fast drafting', 'OpenAI-on-Bedrock option'],
      costClass: 'medium',
      latencyClass: 'balanced',
      visionCapable: false,
      output: 'text',
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
      strengths: ['deeper coding analysis', 'larger open-weight reasoning', 'OpenAI-on-Bedrock experimentation'],
      costClass: 'high',
      latencyClass: 'deep',
      visionCapable: false,
      output: 'text',
      workingLanguage: 'en',
    },
    // DeepSeek V3.2 — served IN-AWS via Amazon Bedrock (on-demand, Converse API), so it gets
    // Bedrock Guardrails + AWS billing and needs NO external API key (unlike the external DeepSeek adapter,
    // `deepseek_api` in `model-catalog.ts`, which a classification selects and its stack grants the key of).
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
      strengths: ['Chinese fluency', 'strong reasoning', 'low-cost open-weight'],
      costClass: 'low',
      latencyClass: 'balanced',
      visionCapable: false,
      output: 'text',
      workingLanguage: 'zh',
    },
    // DeepSeek R1, the reasoning model the context-routing path sends a reasoning intent to
    // (SPEC-CONTEXT-AWARE-MODEL-ROUTING), through its `us.` cross-region inference profile.
    deepseek_r1: {
      key: 'deepseek_r1',
      provider: 'deepseek',
      displayName: 'DeepSeek R1 (Bedrock)',
      bedrockModelId: 'us.deepseek.r1-v1:0',
      foundationModelArns: crossRegionFoundationModelArns(region, 'deepseek.r1-v1:0'),
      inferenceProfileArns: [
        `arn:aws:bedrock:${region}:${account}:inference-profile/us.deepseek.r1-v1:0`,
      ],
      strengths: ['step-by-step reasoning', 'Chinese fluency'],
      costClass: 'medium',
      latencyClass: 'deep',
      visionCapable: false,
      output: 'text',
      workingLanguage: 'zh',
    },
  };
}

export const INTENT_ROUTE_STRATEGY: IntentRouteDefinition[] = [
  {
    intent: 'general',
    label: 'General Q&A',
    primaryModel: 'haiku',
    fallbackModel: 'sonnet',
    rationale: 'Fast, low-cost answers default to the cheapest capable model; fall back within Anthropic (Sonnet) rather than cross-provider. A classification that selects no Sonnet simply gets no fallback.',
  },
  {
    intent: 'code_generation',
    label: 'Code Generation',
    primaryModel: 'sonnet',
    fallbackModel: 'gpt_oss_20b',
    rationale: 'Coding work should support both Anthropic and OpenAI-on-Bedrock paths without forcing a premium-only default.',
  },
  {
    intent: 'code_review',
    label: 'Code Review',
    primaryModel: 'gpt_oss_20b',
    fallbackModel: 'sonnet',
    rationale: 'Detailed review should expose an OpenAI-on-Bedrock option while keeping a strong Anthropic fallback at the same classification.',
  },
  {
    intent: 'data_extraction',
    label: 'Document Extraction',
    primaryModel: 'haiku',
    fallbackModel: 'sonnet',
    rationale: 'Extraction and parsing optimize for throughput and cost; fall back within Anthropic (Sonnet) rather than cross-provider.',
  },
  {
    intent: 'report_generation',
    label: 'Report Generation',
    primaryModel: 'titan',
    fallbackModel: 'sonnet',
    rationale: 'Structured drafting and summaries benefit from a stable drafting model with a stronger reasoning fallback.',
  },
  {
    intent: 'strategic_analysis',
    label: 'Strategic Analysis',
    primaryModel: 'opus',
    fallbackModel: 'sonnet',
    rationale: 'Executive and strategic work should route to the deepest reasoning model available.',
  },
  {
    intent: 'guided_troubleshooting',
    label: 'Workflow Actions',
    primaryModel: 'sonnet',
    fallbackModel: 'haiku',
    rationale: 'Tool-heavy workflows prefer the strongest action-group model; fall back within Anthropic (Haiku) rather than cross-provider.',
  },
];
