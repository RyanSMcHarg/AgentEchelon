/**
 * THE INSTANCE'S MODEL CATALOG: EVERY MODEL THE PLATFORM ALLOWS, FROM ANY PROVIDER, AND NO CLASSIFICATION.
 *
 * Models are decided in three layers - the platform allows, the classification selects, the profile uses:
 *
 *   - THE PLATFORM ALLOWS. This catalog lists every model an instance may use, by a stable key: the text models
 *     Amazon Bedrock serves (`getModelCatalog`, `model-strategy.ts`), the text models an external adapter calls
 *     outside AWS ({@link EXTERNAL_MODELS}), and the image models ({@link IMAGE_MODEL_KEYS}, served in AWS or
 *     outside it, `lambda/src/lib/image-gen-models.ts`). It names no classification.
 *   - A CLASSIFICATION SELECTS. Each classification declares the catalog keys available in it and its default
 *     (`models` on its registry entry, `lib/config/profiles.ts`), and its own stack grants exactly those: the
 *     Bedrock ARNs of its Bedrock models, and the secret reads and egress of its external ones. Synth refuses an
 *     empty selection, a key this catalog does not list, and a default that is not a selected text model.
 *   - THE PROFILE USES. A profile and each of its versions choose only among their classification's selection,
 *     for the base model, the classifier, each intent's route and the image model; draft validation and
 *     activation refuse anything else (`modelFits`, `model-availability.ts`). A profile enables nothing.
 *
 * Imports nothing that reads the registry, so the registry's own validation can read it.
 */
import { getModelCatalog } from './model-strategy';

/** How a catalog model is reached: Amazon Bedrock, an external adapter over HTTPS, or the image registry. */
export type ModelKind = 'bedrock' | 'external' | 'image';

/** The image models the platform allows (`IMAGE_GEN_MODELS` in `lambda/src/lib/image-gen-models.ts`). */
export const IMAGE_MODEL_KEYS = [
  'titan_image',
  'nova_canvas',
  'stability_image_core',
  'stability_image_ultra',
  'openai_gpt_image_1',
  'fal_flux_pro_1_1',
] as const;
export type ImageGenModelKey = (typeof IMAGE_MODEL_KEYS)[number];

/** A text model an external adapter calls outside AWS, with its API key in a secret its classification's stack holds. */
export interface ExternalModelDefinition {
  key: string;
  provider: 'deepseek';
  displayName: string;
  /** The provider's API endpoint, which the processor calls over HTTPS. */
  endpoint: string;
  /** The model id the provider's API takes. */
  model: string;
  output: 'text';
  workingLanguage: string;
}

/**
 * THE EXTERNAL TEXT MODELS. DeepSeek's own API, called by the context-routing path
 * (SPEC-CONTEXT-AWARE-MODEL-ROUTING) for a classification that selects it; its key is a secret the
 * classification's stack creates and grants only where the classification selects this model.
 */
export const EXTERNAL_MODELS: Readonly<Record<string, ExternalModelDefinition>> = {
  deepseek_api: {
    key: 'deepseek_api',
    provider: 'deepseek',
    displayName: 'DeepSeek (external API)',
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    output: 'text',
    workingLanguage: 'zh',
  },
};

/** The kind of model a catalog key names, or undefined for a key the catalog does not list. */
export function modelKindOf(key: string | undefined): ModelKind | undefined {
  if (!key) return undefined;
  if ((IMAGE_MODEL_KEYS as readonly string[]).includes(key)) return 'image';
  if (Object.prototype.hasOwnProperty.call(EXTERNAL_MODELS, key)) return 'external';
  return Object.prototype.hasOwnProperty.call(getModelCatalog('us-east-1', '000000000000'), key) ? 'bedrock' : undefined;
}

/** Every key the instance's catalog lists, of every kind. */
export function instanceModelKeys(): string[] {
  return [...Object.keys(getModelCatalog('us-east-1', '000000000000')), ...Object.keys(EXTERNAL_MODELS), ...IMAGE_MODEL_KEYS];
}

/** What a model produces: a Bedrock or external model answers in text, an image model generates images. */
export function modelOutputOf(key: string | undefined): 'text' | 'image' | undefined {
  const kind = modelKindOf(key);
  return kind === undefined ? undefined : kind === 'image' ? 'image' : 'text';
}
