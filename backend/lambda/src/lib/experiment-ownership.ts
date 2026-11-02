import type { Experiment } from './experiment-manager.js';
import type { OwnedScope } from './assistant-scope.js';

/**
 * WHETHER AN EXPERIMENT IS AN ASSISTANT'S OWN (SPEC-ADMIN-CONSOLE FR48, FR50).
 *
 * Only a `profile` experiment whose every variant names this assistant, on classifications it
 * serves. The other types - a base model, a classifier, an intent - change what every assistant of a
 * classification does, so they are a classification decision and stay with `admins`.
 */
export function experimentBelongsTo(exp: Pick<Experiment, 'experimentType' | 'variants' | 'tiers' | 'battleEnabled'>, scope: Pick<OwnedScope, 'assistant' | 'bots'>): boolean {
  if (exp.experimentType !== 'profile') return false;
  // A battle names the classification's challenger and runs the duel for a whole classification, so an experiment armed for
  // one is an admin's on every route - listing, status changes and deletion as well as creation.
  if (exp.battleEnabled) return false;
  const variants = exp.variants || [];
  if (variants.length === 0 || !variants.every((v) => v.profileRef?.profileName === scope.assistant)) return false;
  const served = new Set(scope.bots.map((b) => b.classification).filter(Boolean));
  return (exp.tiers || []).length > 0 && (exp.tiers || []).every((t) => served.has(t));
}