// Federated identity helpers for the external-IdP credential exchange.
//
// The native exchange (credential-exchange.ts) keys on the Cognito `sub`: it is the
// AppInstanceUser id AND the `sub` session tag the per-tier role pins the bearer on
// (`resources: [${appInstanceArn}/user/${aws:PrincipalTag/sub}]`). For a FOREIGN IdP
// token, the issuer's `sub` could collide with a native sub, so we derive a disjoint,
// charset-safe id and use it for BOTH — keeping the bearer pin semantics unchanged.
//
// These are pure functions (no AWS) so the security-critical derivation + ceiling are
// unit-tested. The federated handler wiring (a JWT authorizer per trusted issuer +
// reusing the AssumeRole/ensureAppInstanceUser path with the derived id) is the
// AWS-specific remainder — see docs/SPEC-FEDERATED-PARTICIPANTS.md.

import { createHash } from 'node:crypto';

/** AE classification tiers, ordered lowest → highest. */
export type Classification = 'basic' | 'standard' | 'premium' | 'admin';

const ORDER: Record<Classification, number> = { basic: 0, standard: 1, premium: 2, admin: 3 };

/**
 * Derive a federated AppInstanceUser id from an external IdP's (issuer, subject):
 * - DISJOINT from native Cognito subs (always `fed_`-prefixed; native subs are raw UUIDs),
 * - CHARSET-SAFE for Chime AppInstanceUser ids (hex + underscore only),
 * - STABLE: same (issuer, subject) → same id, so a later login binds to the same identity.
 * Used as both the AppInstanceUser id and the `sub` session tag (pin unchanged).
 */
export function deriveFederatedSub(issuer: string, subject: string): string {
  if (!issuer || !subject) throw new Error('issuer and subject are required');
  const hash = createHash('sha256').update(`${issuer}|${subject}`).digest('hex');
  return `fed_${hash.slice(0, 40)}`; // fed_ + 160 bits; 44 chars, well under Chime's 64
}

/** Whether an id was produced by deriveFederatedSub (vs a native Cognito sub). */
export function isFederatedSub(id: string): boolean {
  return /^fed_[0-9a-f]{40}$/.test(id);
}

/**
 * Resolve an external IdP group claim to an AE classification — FAIL-CLOSED.
 * `groupToTier` is per-issuer deploy config; an absent/unmapped group → the lowest tier.
 */
export function resolveFederatedTier(
  group: string | undefined,
  groupToTier: Record<string, Classification>,
  lowest: Classification = 'basic',
): Classification {
  if (!group) return lowest;
  return groupToTier[group] ?? lowest;
}

/** The effective ceiling = the LOWER of the IdP-derived tier and the channel's classification. */
export function classificationCeiling(idpTier: Classification, channelTier: Classification): Classification {
  return ORDER[idpTier] <= ORDER[channelTier] ? idpTier : channelTier;
}
