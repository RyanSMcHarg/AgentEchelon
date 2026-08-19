/**
 * Read a profile VERSION's DEFINITION — SPEC-PORTABLE-PROFILES P2 (§6).
 *
 * An `ExperimentVariant.profileRef` runs an entire profile version as the variant, and "entire" is the
 * point of the feature: a variant is NOT a model. §6 puts model, persona, intent pack, tools, classifier
 * mode and guardrail selection in the variant, so that profile-vs-profile answers questions a model-only
 * knob cannot express — the sharpest being "do these tools earn their place", where the two versions
 * differ ONLY in `tools`. A model-only resolution silently turns that experiment into two identical
 * variants, which reports `indistinguishable` for a reason that has nothing to do with the tools. That is
 * why this returns the definition and the caller applies it, rather than extracting one field here.
 *
 * The lightweight `modelKey` variant still exists for model-only experiments and is unaffected; the two
 * are mutually exclusive per variant (validated in experiment-manager).
 *
 * Both the router (A/B resolution) and the battle path (alt-slot) call this. READ-ONLY on the assistant
 * definition namespace — reading a definition is behavior, not a boundary (§7), so it never escalates.
 *
 * Fail-safe: any failure (ref missing, param/version absent, malformed) returns null and the caller
 * skips the profileRef variant (falls back to the deterministic default) rather than erroring the turn.
 *
 * NOTE the caller's obligation: §6's classification ceiling binds on the WHOLE definition, not just its
 * model. A version's tools, guardrail selection and context sources must each be checked against the
 * channel's classification before the definition is served, or a variant becomes a way to widen access
 * inside a channel. This module reads; it does not authorize.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ProfileDefinition, definitionParamName } from './active-profile.js';

export interface ProfileRef {
  profileName: string;
  version?: number;
}

/**
 * Resolve a profileRef to its version's FULL definition, or null on any failure (fail-safe).
 *
 * A stored definition is only useful if it identifies itself: `configId` is the version's attribution
 * key, so a result missing it cannot be attributed in analytics and is treated as unusable rather than
 * served anonymously — a variant whose exchanges cannot be traced back to the version that produced them
 * defeats the comparison the experiment exists to make.
 */
export async function lookupProfileVersion(
  ssm: SSMClient,
  ssmRoot: string,
  ref: ProfileRef,
): Promise<ProfileDefinition | null> {
  if (!ref?.profileName) return null;
  const name = definitionParamName(ssmRoot, ref.profileName);
  try {
    let raw: string | undefined;
    if (ref.version !== undefined) {
      // ADDRESS THE VERSION DIRECTLY (`name:N`), rather than scanning history for it.
      //
      // `GetParameterHistory` pages at 10 and returns OLDEST FIRST, and this took the first page with no
      // `MaxResults` and no `NextToken` loop. So the moment a profile passed 10 versions, a lookup for a
      // RECENT one found nothing on that page and returned null - and null here means the variant is
      // silently skipped and the experiment quietly runs control-only. The failure arrives as a clean
      // "no difference" result rather than an error, which is the worst shape for an experiment.
      //
      // `name:N` is the same selector family as the `:active` label below, resolves in one call, and
      // needs no extra IAM (a version selector addresses the same parameter ARN).
      const resp = await ssm.send(new GetParameterCommand({ Name: `${name}:${ref.version}` }));
      raw = resp.Parameter?.Value;
    } else {
      const resp = await ssm.send(new GetParameterCommand({ Name: `${name}:active` }));
      raw = resp.Parameter?.Value;
    }
    if (!raw) return null;
    const def = JSON.parse(raw) as ProfileDefinition;
    // A definition with no model and no attribution key is not a runnable variant.
    if (!def?.modelKey || !def?.configId) return null;
    return def;
  } catch {
    return null;
  }
}

/**
 * Resolve a profileRef to its version's modelKey. Retained for the model-only call sites (and as the
 * narrow read where the whole definition is not wanted); prefer `lookupProfileVersion` when serving a
 * variant, because a variant is the whole definition.
 */
export async function lookupProfileVersionModelKey(
  ssm: SSMClient,
  ssmRoot: string,
  ref: ProfileRef,
): Promise<string | null> {
  return (await lookupProfileVersion(ssm, ssmRoot, ref))?.modelKey ?? null;
}
