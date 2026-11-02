/**
 * THE IMAGE ROUTE AN EXPERIMENT VARIES, answered in one place for its writer and its readers.
 *
 * A variant's `imageGenModelKey` is written into the route this names (`variantDeltaOf`,
 * `manage-profiles.ts`), the live control is compared on it (`controlMismatch`), and a duel side reads its
 * image model back from it (`battleSideOf`, `experiment-manager.ts`), so every one of them names the model
 * the version actually serves.
 */
import { IMAGE_ROUTE_KEY } from './image-route.js';
import { needsOf } from './intent-pack.js';

/**
 * The route an experiment's `imageGenModelKey` names: its intent's route when it is an `intent` experiment
 * whose intent needs an image (`needsOf`), else `image_generation`.
 */
export function imageRouteKeyOf(exp: { intent?: unknown; experimentType?: unknown }): string {
  const intent = typeof exp.intent === 'string' ? exp.intent : '';
  return (exp.experimentType ?? 'intent') === 'intent' && intent && needsOf({ key: intent }) === 'image'
    ? intent : IMAGE_ROUTE_KEY;
}
