/**
 * Guardrail MASK TOKENS: one definition, shared by the CDK construct that declares a filter and the
 * runtime that removes what the filter leaves behind.
 *
 * Amazon Bedrock Guardrails replaces an `ANONYMIZE` match with the literal string `{FILTER_NAME}`.
 * A regex filter declared to hide an internal control marker therefore rewrites a leaked marker into
 * a DIFFERENT visible string, and the marker stripper cannot match it: the text it inspects has
 * already been rewritten before the runtime ever sees the response. A live reply ended with
 * `...in this condensed 1-2 page report format.{MetadataMarkerFilter}`.
 *
 * The filter name lives HERE so `lib/constructs/bedrock-guardrails.ts` (CDK, which provisions the
 * filter) and `lambda/src/lib/message-markers.ts` (runtime, which removes the token) cannot drift:
 * renaming the filter renames what is provisioned and what is stripped in one edit. `lib/config` is
 * the seam both sides already cross (`config/model-strategy` is read by the stacks and by the Lambda
 * bundle), and this module declares constants only, so the runtime bundle takes on no CDK dependency.
 *
 * THE SCOPE IS THE CLASS, NOT THE ONE INSTANCE, and its boundary is deliberate. Every regex filter
 * whose purpose is to hide an internal marker belongs in the list below, and
 * `test/lib/guardrail-mask-tokens.test.ts` fails when the provisioned policy declares one that is
 * not listed. PII entity masks (`{EMAIL}`, `{PHONE}`) are NOT in the class: there the mask IS the
 * intended output, and removing it would delete the evidence that something was redacted.
 */

/** The regex filter that masks internal metadata markers leaking into a response. */
export const METADATA_MARKER_FILTER_NAME = 'MetadataMarkerFilter';

/**
 * Every regex filter declared to hide an INTERNAL CONTROL MARKER. A filter listed here has a mask
 * token that carries no meaning for the reader, so the runtime removes it.
 */
export const INTERNAL_MARKER_MASK_FILTER_NAMES: readonly string[] = [METADATA_MARKER_FILTER_NAME];

/** The literal text Bedrock Guardrails substitutes for an ANONYMIZE match on `filterName`. */
export function guardrailMaskToken(filterName: string): string {
  return `{${filterName}}`;
}

/** Deterministic patterns for the mask tokens of the internal-marker filters above. */
export const GUARDRAIL_MASK_TOKEN_PATTERNS: RegExp[] = INTERNAL_MARKER_MASK_FILTER_NAMES.map(
  (name) => new RegExp(guardrailMaskToken(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
);
