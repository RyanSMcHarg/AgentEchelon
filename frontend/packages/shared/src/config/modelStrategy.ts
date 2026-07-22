export type ModelTier = 'basic' | 'standard' | 'premium';
export type ProviderKey = 'anthropic' | 'amazon' | 'openai';
export type ModelStrategyKey = 'haiku' | 'sonnet' | 'opus' | 'titan' | 'gpt_oss_20b' | 'gpt_oss_120b';

export interface ModelStrategyCard {
  key: ModelStrategyKey;
  provider: ProviderKey;
  bedrockModelId: string;
  displayName: string;
  allowedTiers: ModelTier[];
  strengths: string[];
  costClass: 'low' | 'medium' | 'high';
  latencyClass: 'fast' | 'balanced' | 'deep';
  codingFit: 'limited' | 'good' | 'excellent';
  deploymentNotes: string;
}

export interface IntentStrategyCard {
  intent: string;
  label: string;
  preferredTier: ModelTier;
  primaryModel: ModelStrategyKey;
  fallbackModel: ModelStrategyKey;
  rationale: string;
}

export const MODEL_STRATEGY_MODELS: ModelStrategyCard[] = [
  {
    key: 'haiku',
    provider: 'anthropic',
    bedrockModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    displayName: 'Claude Haiku',
    allowedTiers: ['basic', 'standard', 'premium'],
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
    allowedTiers: ['standard', 'premium'],
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
    allowedTiers: ['premium'],
    strengths: ['deep analysis', 'complex architecture', 'high-stakes reasoning'],
    costClass: 'high',
    latencyClass: 'deep',
    codingFit: 'excellent',
    deploymentNotes: 'Reserve for premium strategic work and the most complex requests.',
  },
  {
    key: 'titan',
    provider: 'amazon',
    bedrockModelId: 'amazon.titan-text-premier-v1:0',
    displayName: 'Amazon Titan Text Premier',
    allowedTiers: ['standard', 'premium'],
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
    allowedTiers: ['standard', 'premium'],
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
    allowedTiers: ['premium'],
    strengths: ['deeper coding analysis', 'larger open-weight reasoning', 'OpenAI-on-Bedrock experimentation'],
    costClass: 'high',
    latencyClass: 'deep',
    codingFit: 'excellent',
    deploymentNotes: 'Best fit for premium experiments that want stronger OpenAI-style coding or review behavior through Bedrock.',
  },
];

export const INTENT_STRATEGY_CARDS: IntentStrategyCard[] = [
  {
    intent: 'general_qa',
    label: 'General Q&A',
    preferredTier: 'basic',
    primaryModel: 'haiku',
    fallbackModel: 'titan',
    rationale: 'Fast, low-cost answers should default to the cheapest capable model.',
  },
  {
    intent: 'code_generation',
    label: 'Code Generation',
    preferredTier: 'standard',
    primaryModel: 'sonnet',
    fallbackModel: 'gpt_oss_20b',
    rationale: 'Coding tasks should be able to route to either Anthropic or OpenAI-on-Bedrock depending on deployment preference and observed quality.',
  },
  {
    intent: 'code_review',
    label: 'Code Review',
    preferredTier: 'standard',
    primaryModel: 'gpt_oss_20b',
    fallbackModel: 'sonnet',
    rationale: 'Code review should expose an OpenAI-on-Bedrock option while keeping Sonnet as a same-tier fallback.',
  },
  {
    intent: 'document_extraction',
    label: 'Document Extraction',
    preferredTier: 'basic',
    primaryModel: 'haiku',
    fallbackModel: 'titan',
    rationale: 'Extraction should optimize for throughput and cost before premium reasoning.',
  },
  {
    intent: 'report_generation',
    label: 'Report Generation',
    preferredTier: 'standard',
    primaryModel: 'titan',
    fallbackModel: 'sonnet',
    rationale: 'Structured drafting benefits from a stable drafting model with a stronger analytical fallback.',
  },
  {
    intent: 'strategic_analysis',
    label: 'Strategic Analysis',
    preferredTier: 'premium',
    primaryModel: 'opus',
    fallbackModel: 'sonnet',
    rationale: 'Strategic work should route to the deepest reasoning model available.',
  },
  {
    intent: 'workflow_actions',
    label: 'Workflow Actions',
    preferredTier: 'standard',
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

export const DEFAULT_TIER_MODEL_SELECTION: Record<ModelTier, ModelStrategyKey> = {
  basic: 'haiku',
  standard: 'sonnet',
  premium: 'opus',
};

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
 * the raw id unchanged (honest — never a fabricated name) so an unrecognised or empty
 * id still renders as-is. Image turns record an image model id that the text catalog
 * cannot name, so this is what keeps them from showing a raw id in the dashboard.
 */
export function modelDisplayName(modelId: string | null | undefined): string {
  if (!modelId) return '';
  const text = MODEL_STRATEGY_MODELS.find((m) => m.bedrockModelId === modelId);
  if (text) return text.displayName;
  return IMAGE_GEN_MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

export function getTierModelSelection(): Record<ModelTier, ModelStrategyCard> {
  const lookup = getModelStrategyLookup();
  const resolve = (tier: ModelTier): ModelStrategyCard => {
    const envKey = import.meta.env[`VITE_${tier.toUpperCase()}_MODEL_KEY` as 'VITE_BASIC_MODEL_KEY'];
    const chosenKey = (envKey && lookup[envKey as ModelStrategyKey]) ? envKey as ModelStrategyKey : DEFAULT_TIER_MODEL_SELECTION[tier];
    return lookup[chosenKey];
  };

  return {
    basic: resolve('basic'),
    standard: resolve('standard'),
    premium: resolve('premium'),
  };
}
