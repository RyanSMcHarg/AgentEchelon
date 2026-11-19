/**
 * THE MODEL A STEP OF AN INTENT'S WORKFLOW RUNS ON, AS THE CONSOLE SHOWS IT (ADR-064 decisions B and D).
 *
 * Read through the runtime's own resolution (`stepModelOf` in `backend/lambda/src/lib/resolve-model-plan.ts`, which calls
 * the processor's `routedModel` over `versionRouteStrategy`), so the intent card and the workflow editor never name a
 * model the runtime would not pick. An image step is drawn on the intent's image route (`imageRouteFor`), else the
 * `image_generation` route's, as `imagePrimaryForIntent` reads it.
 */
import { getModelStrategyLookup, modelDisplayName, type ModelStrategyKey } from '@ae/shared';
import { stepModelOf, type StepModelPreview } from '../../../../../../backend/lambda/src/lib/resolve-model-plan.ts';
import { getModelCatalog, type BackendModelDefinition, type BackendModelKey } from '../../../../../../backend/lib/config/model-strategy.ts';
import { IMAGE_ROUTE_KEY, imageRouteFor } from '../../../../../../backend/lambda/src/lib/image-route.ts';
import { DEFAULT_MODEL, type ClassificationCatalog, type MachineStep, type ProfileDefinitionBody } from '../../services/profileService';

export type { StepModelPreview };

/** The catalog's model definitions; cost classes and keys do not depend on the region or account. */
const CATALOG = getModelCatalog('us-east-1', '') as Record<BackendModelKey, BackendModelDefinition>;

const concrete = (key: string | undefined): string | undefined => (key && key !== DEFAULT_MODEL ? key : undefined);

/**
 * What `step` of `intent`'s workflow runs on in `body`, with the rule that chose it. Undefined when the classification's
 * selection cannot be read (the catalog has not loaded), so the console says nothing rather than guess.
 */
export function stepRunsOn(
  body: Partial<ProfileDefinitionBody> | null | undefined,
  catalog: ClassificationCatalog | undefined,
  intent: string,
  step: Pick<MachineStep, 'key' | 'produces'>,
): StepModelPreview | undefined {
  if (!catalog) return undefined;
  const text = catalog.models.text ?? [];
  const selected = [...text, ...(catalog.models.image ?? [])];
  const fallbackDefault = catalog.models.default ?? text[0];
  if (!fallbackDefault) return undefined;
  const models = body?.models;
  const image = imageRouteFor(models, intent) ?? imageRouteFor(models, IMAGE_ROUTE_KEY);
  try {
    return stepModelOf({
      classification: catalog.classification,
      intent,
      step: step.key,
      produces: step.produces,
      routes: models?.byIntent,
      baseModelKey: concrete(models?.default) ?? concrete(body?.modelKey) ?? fallbackDefault,
      selection: { selected, default: fallbackDefault },
      catalog: CATALOG,
      imageModel: image,
    });
  } catch {
    return undefined;
  }
}

/** A model key as a person reads it: the catalog's display name, else the key. */
export function modelName(key: string | undefined): string {
  if (!key) return '';
  return getModelStrategyLookup()[key as ModelStrategyKey]?.displayName ?? (modelDisplayName(key) || key);
}
