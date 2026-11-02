/**
 * THE TRUST OF A CONTEXT SOURCE'S FIELDS (ADR-060 decision 2, INV-CTX-CAT-2), shared by the catalog's validation
 * (`context-sources.ts`), the prompt's fence (`context-sources-runtime.ts`) and the variable table (`variables.ts`),
 * so all three read one rule. Pure and dependency-free.
 *
 * A field may LOWER its entry's trust and never raise it, and the prompt fences an entry at the lowest trust inside
 * it, so the label on a fence is never higher than the least trusted value it holds.
 */
export type SourceTrust = 'platform' | 'operator' | 'member';

/** Trust from least to most. */
export const TRUST_ORDER: readonly SourceTrust[] = ['member', 'operator', 'platform'];

/** The lower of two trusts. An unknown trust is member trust, the reading that permits least. */
export function lowerTrust(a: unknown, b: unknown): SourceTrust {
  const rank = (t: unknown) => Math.max(0, TRUST_ORDER.indexOf(t as SourceTrust));
  return TRUST_ORDER[Math.min(rank(a), rank(b))];
}

/** A field's trust: its own where it declares one, never above its entry's. */
export function fieldTrust(entry: { trust: unknown }, field: { trust?: unknown }): SourceTrust {
  return lowerTrust(entry.trust, field.trust === undefined ? entry.trust : field.trust);
}

/**
 * The trust a whole entry is fenced at in the prompt: the lowest of the entry's and its fields'. An entry whose
 * fields declare no trust of their own is fenced at its own trust.
 */
export function entryFenceTrust(entry: { trust: unknown; fields?: Readonly<Record<string, { trust?: unknown }>> }): SourceTrust {
  return Object.values(entry.fields ?? {}).reduce<SourceTrust>((t, f) => lowerTrust(t, fieldTrust(entry, f)), lowerTrust(entry.trust, entry.trust));
}
