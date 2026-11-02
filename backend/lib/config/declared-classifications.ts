/**
 * NOTHING THE DEPLOYMENT DECLARES MAY NAME A CLASSIFICATION IT DOES NOT DECLARE.
 *
 * A deployment runs the set its `profiles` key declares (`resolveDeploymentProfiles`,
 * `lib/config/profiles.ts`), and an outside classification (`guest`, `customer`) is in that set only when
 * declared. Everything that names a classification is checked against the set at synth, so a missing one
 * is a refusal naming the declaration to add rather than a conversation that cannot be opened:
 *
 *   - the guest issuer opens `guest-visitor` conversations, so it needs that type's classification
 *     (`guest`), and the type's path B claim (`upgrade.into`) needs the target type's (`customer`);
 *   - an invitation-link issuer redeems link invitations up to a type's `linkClassifications`, so every
 *     classification a type's link classifications name is declared;
 *   - a conversation type this deployment serves names declared classifications only, and its
 *     `defaultAgents` declared assistants, or a shipped role's assistant the deployment does not declare. A type
 *     that names none of the declared classifications is not served here: every creator refuses a classification
 *     the registry does not declare.
 *
 * An issuer's own classifications, fixed set, mapping and oneChannel are checked by the issuer registry
 * (`issuerErrors`, `lib/config/issuers.ts`) against the same set.
 */
import { CONVERSATION_TYPES, GUEST_VISITOR_TYPE, invitationPolicyOf } from './conversation-types';
import { shippedRoleAssistants } from './profiles';
import type { ProfileRegistry } from '../profile-registry';

type Declared = Pick<ProfileRegistry, 'isKnownClassification'> & Partial<Pick<ProfileRegistry, 'profileNames' | 'rolesFor'>>;

/**
 * A shipped role's assistant (`ops-premium`) whose classification this deployment declares WITHOUT that role. The
 * role is the deployment's choice (`profiles`, `shippedProfilesSelection`), so a type naming its assistant is not a
 * misdeclaration: the assistant exists where the role is declared, and elsewhere creating the type is refused at
 * runtime because the handle resolves to no assignment record (`lambda/src/lib/default-agents.ts`).
 */
function undeclaredShippedRole(name: string, registry: Declared): boolean {
  const offered = shippedRoleAssistants().get(name);
  if (!offered || !registry.rolesFor || !registry.isKnownClassification(offered.classification)) return false;
  return !registry.rolesFor(offered.classification).includes(offered.role);
}

/**
 * Whether this deployment serves a conversation type: it permits any classification (no list), or it
 * names at least one the deployment declares. An unknown type is not served.
 */
export function typeIsServed(typeKey: string, registry: Pick<ProfileRegistry, 'isKnownClassification'>): boolean {
  const type = CONVERSATION_TYPES[typeKey];
  if (!type) return false;
  if (!type.classifications) return true;
  return type.classifications.some((c) => registry.isKnownClassification(c));
}

const undeclared = (values: readonly string[] | undefined, registry: Declared): string[] =>
  (values ?? []).filter((v) => !registry.isKnownClassification(v));

/** Every way the declared issuers and the shipped conversation types name an undeclared classification. Empty when none. */
export function classificationDeclarationErrors(issuers: readonly unknown[] | undefined, registry: Declared): string[] {
  const errors: string[] = [];
  const entries = (issuers ?? []).filter((e): e is { id?: unknown; kind?: unknown } => !!e && typeof e === 'object' && !Array.isArray(e));
  const add = (v: string) => `add "${v}" to profiles in deploy.config.json`;

  // THE GUEST ISSUER AND THE TWO TYPES IT REACHES.
  const guest = entries.find((e) => e.kind === 'guest');
  if (guest) {
    const visitor = CONVERSATION_TYPES[GUEST_VISITOR_TYPE];
    for (const v of undeclared(visitor?.classifications, registry)) {
      errors.push(`issuer "${String(guest.id)}": a guest issuer opens ${GUEST_VISITOR_TYPE} conversations at "${v}", which this deployment does not declare; ${add(v)}`);
    }
    const into = visitor?.upgrade?.paths.includes('claim') ? visitor.upgrade.into : undefined;
    if (into) {
      for (const v of undeclared(CONVERSATION_TYPES[into]?.classifications, registry)) {
        errors.push(`issuer "${String(guest.id)}": ${GUEST_VISITOR_TYPE}'s upgrade path B (claim) opens ${into} conversations at "${v}", `
          + `which this deployment does not declare; ${add(v)}`);
      }
    }
  }

  // AN INVITATION-LINK ISSUER AND EVERY LINK CLASSIFICATION IT REDEEMS AT.
  const link = entries.find((e) => e.kind === 'invitation-link');
  if (link) {
    for (const typeKey of Object.keys(CONVERSATION_TYPES)) {
      if (!typeIsServed(typeKey, registry)) continue;
      const policy = invitationPolicyOf(typeKey);
      if (!policy?.modes.includes('link')) continue;
      for (const v of undeclared(policy.linkClassifications, registry)) {
        errors.push(`issuer "${String(link.id)}": conversation type "${typeKey}" declares link invitations up to "${v}" (linkClassifications), `
          + `which this deployment does not declare; ${add(v)}`);
      }
    }
  }

  // EVERY SERVED TYPE NAMES DECLARED CLASSIFICATIONS AND DECLARED ASSISTANTS.
  const assistants = registry.profileNames ? new Set(registry.profileNames()) : undefined;
  for (const [typeKey, type] of Object.entries(CONVERSATION_TYPES)) {
    if (!typeIsServed(typeKey, registry)) continue;
    for (const v of undeclared(type.classifications, registry)) {
      errors.push(`conversation type "${typeKey}" is created at "${v}" beside classifications this deployment declares, but not at "${v}"; ${add(v)}`);
    }
    for (const name of type.defaultAgents ?? []) {
      if (assistants && !assistants.has(name) && !undeclaredShippedRole(name, registry)) {
        errors.push(`conversation type "${typeKey}" adds the assistant "${name}", which this deployment's profiles do not declare`);
      }
    }
  }
  return errors;
}

/** Synth-time refusal of every error {@link classificationDeclarationErrors} finds. */
export function assertClassificationsDeclared(issuers: readonly unknown[] | undefined, registry: Declared): void {
  const errors = classificationDeclarationErrors(issuers, registry);
  if (errors.length) throw new Error(`profiles: the deployment names classifications it does not declare:\n  - ${errors.join('\n  - ')}`);
}
