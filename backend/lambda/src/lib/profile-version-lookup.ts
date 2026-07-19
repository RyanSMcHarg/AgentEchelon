/**
 * Read a profile VERSION's model — SPEC-PORTABLE-VERSIONED-PROFILES P2 (§6).
 *
 * An `ExperimentVariant.profileRef` runs an entire profile version as the variant. Until the
 * AssistantConfig unification lands (§2/§9), the config-driven part of "the whole definition" is the
 * model; this resolves a `{profileName, version}` ref to that version's `modelKey`. Both the router
 * (A/B resolution) and the battle path (alt-slot) call it. READ-ONLY on the assistant definition
 * namespace — reading a definition is behavior, not a boundary (§7), so it never escalates.
 *
 * Fail-safe: any failure (ref missing, param/version absent, malformed) returns null and the caller
 * skips the profileRef variant (falls back to the deterministic default) rather than erroring the turn.
 */
import { SSMClient, GetParameterCommand, GetParameterHistoryCommand } from '@aws-sdk/client-ssm';
import { ProfileDefinition, definitionParamName } from './active-profile.js';

export interface ProfileRef {
  profileName: string;
  version?: number;
}

/** Resolve a profileRef to its version's modelKey, or null on any failure (fail-safe). */
export async function lookupProfileVersionModelKey(
  ssm: SSMClient,
  ssmRoot: string,
  ref: ProfileRef,
): Promise<string | null> {
  if (!ref?.profileName) return null;
  const name = definitionParamName(ssmRoot, ref.profileName);
  try {
    if (ref.version !== undefined) {
      const hist = await ssm.send(new GetParameterHistoryCommand({ Name: name }));
      const match = (hist.Parameters ?? []).find((p) => p.Version === ref.version);
      if (!match?.Value) return null;
      return (JSON.parse(match.Value) as ProfileDefinition).modelKey ?? null;
    }
    const resp = await ssm.send(new GetParameterCommand({ Name: `${name}:active` }));
    if (!resp.Parameter?.Value) return null;
    return (JSON.parse(resp.Parameter.Value) as ProfileDefinition).modelKey ?? null;
  } catch {
    return null;
  }
}
