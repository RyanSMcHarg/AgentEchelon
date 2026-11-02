/**
 * THE REGISTRY'S DECISION DATA, AS ONE OBJECT A HANDLER APPLIES LOCALLY.
 *
 * `share-conversation` is a bundled `NodejsFunction` and builds this from the registry it loads at runtime
 * (`classificationAdmission(await loadProfileRegistry())`). The Cognito triggers are the one raw asset
 * (`lambda.Code.fromAsset('lambda/cognito-triggers')`): they cannot import the registry, so they assemble the
 * same object from the registry rows themselves (`lambda/cognito-triggers/registry-admission.js`). No function
 * receives it in its environment.
 *
 * ONE BUILDER. The consumers fail CLOSED on a missing field, so a second copy that lacked one would be a
 * Lambda that quietly admits nobody rather than an error; the raw triggers' copy is pinned to this one by
 * `backend/test/lib/admission-mirrors-the-registry.test.ts`.
 *
 * WHAT TRAVELS, AND WHY EACH FIELD IS HERE:
 *  - `groupClearance`  - which Cognito group clears for which classification;
 *  - `grants`          - what each classification lets its holder reach, which is a SET and need not
 *                        be a rank prefix, so no consumer may compare ranks;
 *  - `clearanceGroups` - the groups that are exclusive of each other, for a writer that sets one and
 *                        must remove the rest (admin-plane groups are deliberately not among them);
 *  - (there is no `failClosedTo`) - a combination this deployment has not named resolves to NO
 *                        token, and the consumer refuses. There is no floor to fall to once
 *                        classifications are peers rather than levels;
 *  - `adminPlane`      - the classifications no conversation may be created at, because their
 *                        assistant has no conversational runtime (`ProfileRegistry.isConversational`).
 *
 * No ranks travel. A consumer holding ranks would be able to express the comparison this model
 * replaced, and every consumer bug being fixed here was a rank comparison.
 *
 * Pinned against the registry by `backend/test/lib/admission-mirrors-the-registry.test.ts`.
 */
import type { ProfileRegistry } from './profile-registry';

export interface ClassificationAdmission {
  groupClearance: Record<string, string>;
  grants: Record<string, string[]>;
  clearanceGroups: string[];
  adminPlane: string[];
}

export function classificationAdmission(registry: ProfileRegistry): ClassificationAdmission {
  return {
    groupClearance: registry.groupClearance,
    grants: Object.fromEntries(registry.classificationValues().map((v) => [v, registry.grantsFor(v)])),
    clearanceGroups: registry.clearanceGroups(),
    adminPlane: registry.adminPlaneValues(),
  };
}

/** The object serialized, as a test compares it. */
export function classificationAdmissionJson(registry: ProfileRegistry): string {
  return JSON.stringify(classificationAdmission(registry));
}
