/**
 * WHERE A NEW ASSISTANT'S FIRST DRAFT COMES FROM (ADR-048, `manage-assistants` create).
 *
 * A console-created assistant opens with a DRAFT, never an active version, and the person creating it says
 * what that draft starts from:
 *
 *   - `defaults`: the classification's intent pack and persona, which is what a create without a starting
 *     point has always seeded (`seedFirstDraft`);
 *   - `manifest`: a profile file in the export format, landed through the same import a version takes
 *     (`importManifest`), so the same refusals apply: a deploy-time key, a model the classification does
 *     not select, a guardrail or context source the deployment does not publish;
 *   - `copy`: the active version of an assistant in the same classification.
 *
 * WHAT THE CREATE ITSELF DECIDES WINS OVER THE STARTING POINT. The display name, the base model and the
 * classifier model are chosen in the create flow and written over whatever the file or the copied version
 * says (`withStartingChoices`), so the review a person confirms is what the draft holds. Where it answers,
 * its role and its owner are never part of a starting point: they are the create's, and a file that names
 * one is refused by the import exactly as it is anywhere else.
 *
 * Nothing here is active until someone reads the draft and activates it.
 */
import type { ProfileDefinitionBody } from './active-profile.js';

export type StartingPoint =
  | { kind: 'defaults' }
  | { kind: 'manifest'; manifest: Record<string, unknown> }
  | { kind: 'copy'; from: string };

/** What the create flow chose that every starting point carries into the draft. */
export interface StartingChoices {
  displayName?: string;
  modelKey?: string;
  /** The intent classifier's model, or `'default'` for the platform classifier. Absent: the starting point's own. */
  classifierModelKey?: string;
}

/** Shape errors for a starting point as a request carries it; what it may contain is checked where it lands. */
export function startingPointErrors(sp: unknown): string[] {
  if (sp === undefined) return [];
  if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return ['startingPoint must be an object'];
  const s = sp as Record<string, unknown>;
  if (s.kind === 'defaults') return [];
  if (s.kind === 'manifest') {
    return s.manifest && typeof s.manifest === 'object' && !Array.isArray(s.manifest)
      ? [] : ['startingPoint.manifest must be a profile manifest object'];
  }
  if (s.kind === 'copy') {
    return typeof s.from === 'string' && s.from.trim() ? [] : ['startingPoint.from must name the assistant to copy'];
  }
  return ["startingPoint.kind must be 'defaults', 'manifest' or 'copy'"];
}

/** The starting point a valid request names, `defaults` when it names none. */
export function startingPointOf(sp: unknown): StartingPoint {
  return sp && startingPointErrors(sp).length === 0 ? sp as StartingPoint : { kind: 'defaults' };
}

/**
 * The body with the create's own choices written over it. The base model is the body's `modelKey` and its
 * models bundle's `default`, which are the same choice, so both are set.
 */
export function withStartingChoices(body: ProfileDefinitionBody, choices: StartingChoices): ProfileDefinitionBody {
  const models = body.models ?? {};
  const next: ProfileDefinitionBody = { ...body };
  if (choices.displayName) next.displayName = choices.displayName;
  if (choices.modelKey) next.modelKey = choices.modelKey;
  if (choices.modelKey || choices.classifierModelKey) {
    next.models = {
      ...models,
      ...(choices.modelKey ? { default: choices.modelKey } : {}),
      ...(choices.classifierModelKey ? { classifier: choices.classifierModelKey } : {}),
    };
  }
  return next;
}
