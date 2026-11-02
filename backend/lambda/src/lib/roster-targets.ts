/**
 * WHERE AN ASSISTANT MAY BE CREATED AT RUNTIME (ADR-048), answered once for every route that offers it.
 *
 * The admin listing (`manage-profiles` GET) and a team's roster (`manage-assistants` team GET) both offer
 * create targets, and a create checks the same things (`createErrors`): the classification is one of the
 * deployment's own conversational classifications (an `outside` one takes no runtime assistant), and the role
 * is one DEPLOYED on it. A role is deployed exactly when the registry row its classification's stack publishes
 * names it (`rolesFor`), because that stack builds the role's reach from the same declaration; the acting role
 * trusts no other. A target offered here that the create then refuses is a control that cannot work, so the
 * offer and the refusal read the same facts, through this one function.
 *
 * A team route narrows further by the session's clearance (`include`): owning an assistant never raises it.
 */
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';

export interface RosterTarget {
  classification: string;
  roles: string[];
}

/** Whether a runtime assistant may be created in a classification at all, before any role is read. */
export function takesRuntimeAssistants(classification: string): boolean {
  return profiles.isConversational(classification)
    && profiles.resolveClassification(classification) === classification
    && profiles.audienceOf(classification) !== 'outside';
}

/**
 * Every classification a runtime assistant may be created in, with its DEPLOYED roles, from the registry the
 * caller loaded (`loadProfileRegistry`). A classification with no role is left out rather than offered empty.
 */
export function rosterTargets(include: (classification: string) => boolean = () => true): RosterTarget[] {
  const out: RosterTarget[] = [];
  for (const classification of profiles.classificationValues()) {
    if (!takesRuntimeAssistants(classification) || !include(classification)) continue;
    const roles = profiles.rolesFor(classification);
    if (roles.length) out.push({ classification, roles: [...roles] });
  }
  return out;
}
