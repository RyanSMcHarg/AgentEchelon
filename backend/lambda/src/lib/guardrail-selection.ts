/**
 * A GUARDRAIL SELECTION READ AGAINST THE CATALOG A DEPLOYMENT PUBLISHES (`/assistant/{c}/guardrails`), one rule for
 * every write that lands a `guardrailId`: import (`importManifest`) and the draft edit (`editDraft`).
 *
 * The stored field is the id `ApplyGuardrail` is called with, so it always holds a resolved id:
 *   - an id this catalog provisions is kept unchanged;
 *   - a catalog KEY ('strict') is mapped to the id this deployment provisions for it;
 *   - anything else is refused, naming the keys on offer.
 */

/** One selectable guardrail, as the assistant-profile stack publishes it. */
export interface PublishedGuardrail {
  key: string;
  guardrailId: string;
}

export type GuardrailResolution =
  | { guardrailId: string; remappedFrom?: string }
  | { offered: string };

/** The id a selection resolves to in `available`, or the keys on offer when it names none of them. */
export function resolveGuardrailSelection(selection: string, available: readonly PublishedGuardrail[]): GuardrailResolution {
  if (available.some((g) => g.guardrailId === selection)) return { guardrailId: selection };
  const byKey = available.find((g) => g.key === selection);
  if (byKey) return { guardrailId: byKey.guardrailId, remappedFrom: selection };
  return { offered: available.map((g) => `'${g.key}'`).join(', ') || '(none provisioned)' };
}
