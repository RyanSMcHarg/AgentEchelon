/**
 * ONE RULE FOR EVERY MODEL: which classifications may use it, and what it is for.
 *
 * The platform allows a model by listing it in the instance's catalog (`model-catalog.ts`); a classification
 * selects from that catalog (`models` on its registry entry, `lib/config/profiles.ts`); a profile uses only what
 * its classification selects. So whether a classification may use a model is whether it selects it, and the
 * grants (`modelArnsForClassification`, `imageModelArnsForClassification`), the image guardrail wiring, a
 * classification's `produces: image` and the write path all derive from that selection, read through the
 * registry: the deployment's set at synth, the runtime registry in a handler.
 *
 * Purpose is the model's output kind. A text model answers; an image model generates. An intent that
 * `needs` an image is served only by an image model, and every other intent only by a text model
 * (`outputForNeed`). Every place a model is chosen applies the same two checks (`modelFits`): the
 * profile write path, experiment validation, and the runtime resolvers whatever the source.
 */
import { IMAGE_MODEL_KEYS, modelOutputOf, type ImageGenModelKey } from './model-catalog';
// The registry imports the catalog, never this module; it is read here at call time only.
import { defaultProfileRegistry } from '../profile-registry';

export { IMAGE_MODEL_KEYS, type ImageGenModelKey };

/** What a model produces. */
export type ModelOutput = 'text' | 'image';

/** The image models a classification selects. Empty means the classification generates no images. */
export function imageModelsAllowedFor(classification: string | undefined): ImageGenModelKey[] {
  const selected = defaultProfileRegistry.modelsOf(classification)?.selected ?? [];
  return (IMAGE_MODEL_KEYS as readonly string[]).filter((k) => selected.includes(k)) as ImageGenModelKey[];
}

/** Whether a classification selects any model of this output kind. */
export function classificationAllows(classification: string | undefined, output: ModelOutput): boolean {
  const selected = defaultProfileRegistry.modelsOf(classification)?.selected ?? [];
  return selected.some((k) => modelOutputOf(k) === output);
}

/** The output kind a model key produces, or undefined for a key the catalog does not list. */
export function outputOf(key: string | undefined): ModelOutput | undefined {
  return modelOutputOf(key);
}

/** The output an intent needs: `image` for an intent that `needs` an image, `text` for everything else. */
export function outputForNeed(need: string | undefined): ModelOutput {
  return need === 'image' ? 'image' : 'text';
}

/** Whether a classification may use this model at all: whether it selects it. */
export function modelAllowedFor(key: string | undefined, classification: string | undefined): boolean {
  return defaultProfileRegistry.selectsModel(classification, key);
}

/**
 * THE ONE CHECK: may this model serve this use in this classification? Its classification selects it, and its
 * output is the output the use needs. Null when it fits; otherwise the reason, for a log line or a refusal.
 */
export function modelFits(
  key: string | undefined,
  classification: string | undefined,
  output: ModelOutput,
): string | null {
  if (!key) return 'no model is named';
  const kind = outputOf(key);
  if (!kind) return `'${key}' is not in the model catalog`;
  if (kind !== output) return `'${key}' is a${kind === 'image' ? 'n image' : ' text'} model, and this use needs a${output === 'image' ? 'n image' : ' text'} model`;
  if (!modelAllowedFor(key, classification)) return `'${key}' is not selected by the ${classification ?? 'unknown'} classification`;
  return null;
}
