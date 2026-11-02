/**
 * WHICH ASSISTANT MAY FALL BACK TO THE CLASSIFICATION'S OWN COPY, AND WHY A SECOND ASSISTANT MAY NOT.
 *
 * ADR-054 names this as a gap: four per-deployment parameters are keyed by CLASSIFICATION -
 * `{SSM_ROOT}/assistant/{classification}/assistant-system-prompt`, `.../assistant-intent-pack`,
 * `.../onboarding-intake` and `.../welcome-orientation` - while a profile VERSION is keyed by
 * ASSISTANT. They are the fallback for an assistant whose active version does not carry the field, so
 * two assistants in one classification share one fallback and the second inherits the first's copy.
 *
 * ── IT IS NOT HYPOTHETICAL, AND THE MEASUREMENT IS THE REASON THIS FILE EXISTS ──────────────────
 *
 * Read from the deployment, 2026-10-03: neither premium assistant's active version carries a
 * `welcome` (`advisor` has `onboarding`, `personaRef`, `intentPackRef`, `tools`; `ops-premium` has
 * `personaRef`, `intentPackRef`, `tools`), so BOTH resolve the premium classification's welcome copy.
 * That is why an event-opened ops conversation showed the same welcome sentence twice, once from each
 * assistant, and why `active-profile.ts` records the ops assistant opening by describing itself as
 * the business advisor. `ops-premium` also carries no `onboarding`, so it inherits `advisor`'s intake.
 *
 * ── THE RULE, AND WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────────────
 *
 * The classification's copy belongs to the assistant the classification NAMES - its primary. It was
 * seeded for that assistant, and a deployment with one assistant per classification is the case it
 * was written for. Any OTHER assistant gets its own version's field or the built-in default, never the
 * primary's copy.
 *
 * It does not give a second assistant copy of its own. Composing an ops welcome from the conversation
 * it was opened for is separate work with its own requirement; this only stops the wrong copy being
 * used, which is the half that is actively wrong in front of a person today. The honest outcome for a
 * non-primary assistant with no version field is the platform default, which says nothing specific rather
 * than something specific and false.
 *
 * ── WHY IT IS KEYED ON THE ASSISTANT NAME AND NOT ON THE ROLE TAG ───────────────────────────────
 *
 * Every site that needs this answer already knows which assistant the turn arrived for - the router
 * resolves it from the bot the invocation was addressed as, and the processor from the adopted assignment.
 * None of them needs the role, and the `alt` assistant of a role is not a published profile at all, so
 * a role comparison would have to special-case it. Comparing the assistant to the classification's named
 * primary answers the question directly and the same way at every site.
 */

/**
 * True when `assignedAssistant` may use a per-deployment, classification-keyed parameter as its fallback.
 *
 * An UNKNOWN assistant is allowed it, and that is the compatibility case rather than an oversight: a turn
 * that established no assistant is running the path every deployment ran before a classification could
 * hold two assistants, where the only assistant IS the primary. Refusing there would take the
 * deployment's own seeded copy away from the single-assistant deployments that are its entire reason
 * for existing.
 */
export function deploymentCopyAppliesTo(
  assignedAssistant: string | undefined | null,
  primaryAssistant: string | undefined | null,
): boolean {
  if (!assignedAssistant) return true;
  if (!primaryAssistant) return true;
  return assignedAssistant === primaryAssistant;
}

/** The log line for an assistant that was refused the classification copy, so the absence is explicable. */
export function deploymentCopySkipped(field: string, assignedAssistant: string, primaryAssistant: string): string {
  return `[deployment-copy] '${assignedAssistant}' is not the primary assistant of its classification `
    + `('${primaryAssistant}'), so the classification's ${field} is NOT used as its fallback. It uses its `
    + 'own version\'s field where it carries one, and the platform default otherwise. See ADR-054.';
}
