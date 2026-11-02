// Mirrors the backend's Bedrock text catalog (`backend/lib/config/model-strategy.ts`), which names no classification:
// which models a classification uses is its own selection (`models` on each entry of GET /classifications).
export type ProviderKey = 'anthropic' | 'amazon' | 'openai' | 'deepseek';
export type ModelStrategyKey =
  | 'haiku' | 'sonnet' | 'opus' | 'titan' | 'gpt_oss_20b' | 'gpt_oss_120b' | 'deepseek_v3' | 'deepseek_r1';

export interface ModelStrategyCard {
  key: ModelStrategyKey;
  provider: ProviderKey;
  bedrockModelId: string;
  displayName: string;
  strengths: string[];
  costClass: 'low' | 'medium' | 'high';
  latencyClass: 'fast' | 'balanced' | 'deep';
  codingFit: 'limited' | 'good' | 'excellent';
  deploymentNotes: string;
}

export interface IntentStrategyCard {
  intent: string;
  label: string;
  primaryModel: ModelStrategyKey;
  fallbackModel: ModelStrategyKey;
  rationale: string;
}

export const MODEL_STRATEGY_MODELS: ModelStrategyCard[] = [
  {
    key: 'haiku',
    provider: 'anthropic',
    bedrockModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    displayName: 'Claude Haiku 4.5',
    strengths: ['fast replies', 'low-cost triage', 'simple extraction'],
    costClass: 'low',
    latencyClass: 'fast',
    codingFit: 'limited',
    deploymentNotes: 'Best default for cheap throughput and basic Q&A.',
  },
  {
    key: 'sonnet',
    provider: 'anthropic',
    bedrockModelId: 'anthropic.claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    strengths: ['coding tasks', 'reasoning', 'tool reliability'],
    costClass: 'medium',
    latencyClass: 'balanced',
    codingFit: 'excellent',
    deploymentNotes: 'Best current fit for coding and workflow-heavy intents.',
  },
  {
    key: 'opus',
    provider: 'anthropic',
    bedrockModelId: 'anthropic.claude-opus-4-6-v1',
    displayName: 'Claude Opus 4.6',
    strengths: ['deep analysis', 'complex architecture', 'high-stakes reasoning'],
    costClass: 'high',
    latencyClass: 'deep',
    codingFit: 'excellent',
    deploymentNotes: 'Reserve for premium strategic work and the most complex requests.',
  },
  {
    key: 'titan',
    provider: 'amazon',
    // Titan Text Premier reached Bedrock end-of-life; Nova Pro is its successor. The catalog KEY stays
    // 'titan' so the strategy and admin wiring are unaffected, which is exactly why this mirror drifted
    // unnoticed - the key kept working while the console advertised a retired model by name.
    bedrockModelId: 'amazon.nova-pro-v1:0',
    displayName: 'Amazon Nova Pro',
    strengths: ['summaries', 'structured drafting', 'bedrock-native fallback'],
    costClass: 'medium',
    latencyClass: 'balanced',
    codingFit: 'good',
    deploymentNotes: 'Strong fallback and drafting option when Anthropic routing is not ideal.',
  },
  {
    key: 'gpt_oss_20b',
    provider: 'openai',
    bedrockModelId: 'openai.gpt-oss-20b-1:0',
    displayName: 'OpenAI GPT-OSS 20B',
    strengths: ['low-cost coding support', 'fast drafting', 'OpenAI-on-Bedrock option'],
    costClass: 'medium',
    latencyClass: 'balanced',
    codingFit: 'excellent',
    deploymentNotes: 'Useful when you want an OpenAI option in Bedrock for code generation and review.',
  },
  {
    key: 'gpt_oss_120b',
    provider: 'openai',
    bedrockModelId: 'openai.gpt-oss-120b-1:0',
    displayName: 'OpenAI GPT-OSS 120B',
    strengths: ['deeper coding analysis', 'larger open-weight reasoning', 'OpenAI-on-Bedrock experimentation'],
    costClass: 'high',
    latencyClass: 'deep',
    codingFit: 'excellent',
    deploymentNotes: 'Best fit for premium experiments that want stronger OpenAI-style coding or review behavior through Bedrock.',
  },
  {
    key: 'deepseek_v3',
    provider: 'deepseek',
    bedrockModelId: 'deepseek.v3.2',
    displayName: 'DeepSeek V3.2 (Bedrock)',
    strengths: ['Chinese fluency', 'strong reasoning', 'low-cost open-weight'],
    costClass: 'low',
    latencyClass: 'balanced',
    codingFit: 'good',
    deploymentNotes:
      'The working-language model behind geography routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING): a CN-segment '
      + 'turn routes here and replies in Chinese. Was missing from this mirror while present in the backend '
      + 'catalog, which made it unselectable in the experiments form - see model-catalog-mirror.test.ts.',
  },
  {
    key: 'deepseek_r1',
    provider: 'deepseek',
    bedrockModelId: 'us.deepseek.r1-v1:0',
    displayName: 'DeepSeek R1 (Bedrock)',
    strengths: ['step-by-step reasoning', 'Chinese fluency'],
    costClass: 'medium',
    latencyClass: 'deep',
    codingFit: 'good',
    deploymentNotes: 'The reasoning model context routing sends a reasoning intent to (SPEC-CONTEXT-AWARE-MODEL-ROUTING).',
  },
];

export const INTENT_STRATEGY_CARDS: IntentStrategyCard[] = [
  {
    intent: 'general',
    label: 'General Q&A',
    primaryModel: 'haiku',
    fallbackModel: 'titan',
    rationale: 'Fast, low-cost answers should default to the cheapest capable model.',
  },
  {
    intent: 'code_generation',
    label: 'Code Generation',
    primaryModel: 'sonnet',
    fallbackModel: 'gpt_oss_20b',
    rationale: 'Coding tasks should be able to route to either Anthropic or OpenAI-on-Bedrock depending on deployment preference and observed quality.',
  },
  {
    intent: 'code_review',
    label: 'Code Review',
    primaryModel: 'gpt_oss_20b',
    fallbackModel: 'sonnet',
    rationale: 'Code review should expose an OpenAI-on-Bedrock option while keeping Sonnet as a same-tier fallback.',
  },
  {
    intent: 'data_extraction',
    label: 'Document Extraction',
    primaryModel: 'haiku',
    fallbackModel: 'titan',
    rationale: 'Extraction should optimize for throughput and cost before premium reasoning.',
  },
  {
    intent: 'report_generation',
    label: 'Report Generation',
    primaryModel: 'titan',
    fallbackModel: 'sonnet',
    rationale: 'Structured drafting benefits from a stable drafting model with a stronger analytical fallback.',
  },
  {
    intent: 'strategic_analysis',
    label: 'Strategic Analysis',
    primaryModel: 'opus',
    fallbackModel: 'sonnet',
    rationale: 'Strategic work should route to the deepest reasoning model available.',
  },
  {
    intent: 'guided_troubleshooting',
    label: 'Workflow Actions',
    primaryModel: 'sonnet',
    fallbackModel: 'titan',
    rationale: 'Tool-heavy workflows should prioritize action-group reliability.',
  },
];

export const PROVIDER_POSITIONING = [
  {
    provider: 'Anthropic',
    summary: 'Primary reasoning and coding provider in the current Bedrock deployment.',
  },
  {
    provider: 'Amazon',
    summary: 'Bedrock-native drafting and fallback provider for balanced cost control.',
  },
  {
    provider: 'Future providers',
    summary: 'Routing metadata is capability-first, so Bedrock-native OpenAI, Anthropic, Amazon, and later providers can all fit the same operating model.',
  },
];

export function getModelStrategyLookup(): Record<ModelStrategyKey, ModelStrategyCard> {
  return Object.fromEntries(MODEL_STRATEGY_MODELS.map((model) => [model.key, model])) as Record<ModelStrategyKey, ModelStrategyCard>;
}

/**
 * Friendly display names for the image-generation (generation-out) models. These
 * live in the backend registry (lib/image-gen-models.ts) and are deliberately kept
 * OUT of the text model catalog, so the admin dashboard has no text-catalog entry
 * to name them by. This small map lets the analytics tables render "Stability Image
 * Core (Bedrock)" instead of the raw id "stability.stable-image-core-v1:1". Keyed by
 * the model id the analytics rows carry (bedrock_model / dominant_model). Kept minimal
 * and display-only; the backend registry stays the source of truth for behavior.
 */
const IMAGE_GEN_MODEL_DISPLAY_NAMES: Record<string, string> = {
  'amazon.titan-image-generator-v2:0': 'Amazon Titan Image G1 v2 (legacy)',
  'amazon.nova-canvas-v1:0': 'Amazon Nova Canvas (legacy)',
  'stability.stable-image-core-v1:1': 'Stability Image Core (Bedrock)',
  'stability.stable-image-ultra-v1:1': 'Stability Image Ultra (Bedrock)',
  'gpt-image-1': 'OpenAI gpt-image-1',
  'fal-ai/flux-pro/v1.1': 'Black Forest Labs FLUX 1.1 Pro (via FAL)',
};

/**
 * Resolve a raw model id (as recorded on analytics rows) to a friendly display name.
 * Prefers the text model catalog, then the image-gen display map, and falls back to
 * the raw id unchanged (honest — never a fabricated name) so an unrecognized or empty
 * id still renders as-is. Image turns record an image model id that the text catalog
 * cannot name, so this is what keeps them from showing a raw id in the dashboard.
 */
export function modelDisplayName(modelId: string | null | undefined): string {
  if (!modelId) return '';
  const id = profileIdFromArn(modelId);
  const bare = id.replace(GEO_PREFIX, '');
  const text = MODEL_STRATEGY_MODELS.find(
    (m) => m.bedrockModelId === id || m.bedrockModelId.replace(GEO_PREFIX, '') === bare,
  );
  if (text) return text.displayName;
  return IMAGE_GEN_MODEL_DISPLAY_NAMES[id] ?? IMAGE_GEN_MODEL_DISPLAY_NAMES[bare] ?? id;
}

/**
 * THE ID AN ANALYTICS ROW CARRIES IS NOT ALWAYS A BARE MODEL ID.
 *
 * The battle path, and any inference-profile-only model, records the full profile ARN:
 * `arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1`. That is
 * around ninety characters, and a catalog lookup keyed on the bare id misses it — so it reaches a
 * surface as the raw ARN, and one model makes a cost card's mix run several lines tall.
 *
 * Same rule the backend already applies (`backend/lambda/src/lib/model-rate-table.ts`,
 * `profileIdFromArn`): take the segment after `inference-profile/`, and pass anything else through
 * unchanged, so a bare model id or a bare profile id is untouched.
 */
function profileIdFromArn(id: string): string {
  const marker = 'inference-profile/';
  const i = id.indexOf(marker);
  return i === -1 ? id : id.slice(i + marker.length);
}

/**
 * A cross-region inference profile prefixes the model id with its geography. The catalog stores some
 * ids with the prefix (`us.anthropic.claude-haiku-...`) and some without (`anthropic.claude-sonnet-4-6`),
 * so a lookup has to try both rather than assume one spelling.
 */
const GEO_PREFIX = /^(us|eu|apac|us-gov)\./;

/**
 * THE MODEL A CLASSIFICATION'S ASSISTANT ANSWERS ON BY DEFAULT, for the New conversation picker's label and
 * the create call: its own declared default (`models.default`, carried in `GET /classifications`). Undefined
 * for a classification that declares none, or a default this mirror cannot name.
 */
export function modelForClassification(c: { models?: { default: string } } | undefined): ModelStrategyCard | undefined {
  const key = c?.models?.default;
  return key ? getModelStrategyLookup()[key as ModelStrategyKey] : undefined;
}

/** Whether a classification selects this model (`models.selected`, carried in `GET /classifications`). */
export function classificationSelectsModel(c: { models?: { selected: string[] } } | undefined, key: string): boolean {
  return !!c?.models?.selected.includes(key);
}
