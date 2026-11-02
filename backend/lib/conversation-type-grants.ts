/**
 * A CONVERSATION TYPE'S GROUP AND ITS CLASSIFICATION CANNOT CONTRADICT EACH OTHER (DESIGN-CONVERSATION-TYPES §6).
 *
 * A type that takes its people from a group adds whoever is in it. So the group is a membership group
 * (`ProfilesConfig.membershipGroups`) whose members must already be cleared for a classification that
 * reaches every classification the type is created at. The group grants nothing: an administrator cannot
 * add someone whose clearance falls short (user-management `POST /users/group`), and lowering a member's
 * clearance below the requirement removes them from the group. Synthesis refuses a deployment where a
 * type's group does not require what the type needs.
 *
 * Per-person admission still runs when each person is added (lib/membership-source.ts), as the second layer: a change
 * made straight in the directory, bypassing the route, still cannot add someone the classification refuses.
 */
import { CONVERSATION_TYPES, membershipSourceFor } from './config/conversation-types';
import type { ProfileRegistry } from './profile-registry';
import { typeIsServed } from './config/declared-classifications';

/** Every contradiction between a type's source group and its classifications, as sentences. Empty when consistent. */
export function typeGroupContradictions(registry: ProfileRegistry): string[] {
  const problems: string[] = [];
  const membership = registry.membershipGroups();
  const clearance = registry.groupClearance;
  for (const [key, type] of Object.entries(CONVERSATION_TYPES)) {
    const group = membershipSourceFor(key)?.group;
    // A type this deployment does not serve (it names none of its classifications) adds nobody.
    if (!group || !typeIsServed(key, registry)) continue;
    if (group in clearance) {
      problems.push(`type '${key}' takes its people from '${group}', which is a clearance group: a type's group must be a membership group, which grants nothing`);
      continue;
    }
    const required = membership[group];
    if (!required) {
      problems.push(`type '${key}' takes its people from group '${group}', which membershipGroups does not declare, so nothing requires its members to be cleared`);
      continue;
    }
    for (const c of type.classifications ?? registry.classificationValues()) {
      if (!registry.reaches(required, c)) {
        problems.push(`type '${key}' is created at '${c}', but its group '${group}' requires only '${required}', which does not reach it`);
      }
    }
  }
  return problems;
}

/** Synth-time refusal of any contradiction (called where the per-classification reconcile is built). */
export function assertTypeGroupsRequireTheirClassifications(registry: ProfileRegistry): void {
  const problems = typeGroupContradictions(registry);
  if (problems.length) {
    throw new Error(`conversation types contradict their groups:\n  - ${problems.join('\n  - ')}`);
  }
}
