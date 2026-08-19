/**
 * Seed the ACTIVE profile version (SPEC-PORTABLE-PROFILES P0 §3, §8).
 *
 * Writes each shipped profile's compiled default as version 1 of `/{root}/assistant/{name}/definition`
 * and labels that version `active`. The seed is byte-identical to the deploy default, so activating it
 * changes nothing (the P0 "behavior diff empty on the seed" bar) — it just makes the active version
 * EXPLICIT so the P1 lifecycle (edit/activate/rollback) has a v1 to build on. Idempotent: re-running
 * overwrites with the same content (SSM stamps a new version number; the label follows to it).
 *
 * WRITE PATH, not the runtime path. This is invoked by a seed step (the demo seeder today; a CDK
 * custom resource / the manage-profiles management API in P1) — NEVER by the async-processor role,
 * which is read-only on this namespace (§7). Kept in its own module so the read-only runtime resolver
 * (`active-profile.ts`) never imports a write command.
 */
import { SSMClient, PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry } from '../../../lib/profile-registry.js';
import { serializeSeedDefinition, definitionParamName, type ProfileDefinition } from './active-profile.js';
import { offloadBodies, type BodyStoreDeps } from './profile-bodies.js';

/** Max value length of a Standard-tier SSM parameter, which is the tier this seeder writes. */
export const SSM_STANDARD_TIER_MAX = 4096;

export interface SeedResult {
  profileName: string;
  version: number;
  labeled: boolean;
}

/**
 * Seed + `active`-label one profile's definition. Returns null when the name is not a shipped profile.
 *
 * `persona`, when given, is written INTO the definition rather than left to the deployment's
 * `assistant-system-prompt` parameter. The definition is what a profile export carries and what the
 * async processor prefers, so this is what makes the persona travel with the profile.
 */
export async function seedActiveProfileDefinition(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  persona?: string,
  deps?: BodyStoreDeps,
): Promise<SeedResult | null> {
  const seeded = serializeSeedDefinition(profileName, persona);
  if (seeded === null) return null;
  const name = definitionParamName(ssmRoot, profileName);
  // Offload before measuring: with a body store configured the persona lives in S3 and the parameter
  // holds a pointer, so what has to fit in 4096 characters is everything EXCEPT the persona. Without a
  // body store this is a no-op and the check below behaves exactly as it always has.
  const stored = await offloadBodies(JSON.parse(seeded) as ProfileDefinition, deps);
  const body = JSON.stringify(stored);
  // The whole definition goes into ONE Standard-tier SSM parameter, and persona is the only field
  // that grows without bound. Schema validation allows 20000 characters, which no Standard-tier
  // parameter can hold, so a long INLINE persona would otherwise fail here as an opaque AWS
  // ValidationException naming neither the profile nor the persona. Fail by name instead, and say
  // how much room is left.
  if (body.length > SSM_STANDARD_TIER_MAX) {
    const overhead = body.length - (stored.persona?.length ?? 0);
    throw new Error(
      `profile '${profileName}' definition is ${body.length} chars, over the ${SSM_STANDARD_TIER_MAX}-char `
        + `SSM Standard-tier parameter limit. The rest of the definition needs ${overhead}, leaving room for a `
        + `persona of about ${Math.max(0, SSM_STANDARD_TIER_MAX - overhead)} characters. Shorten the persona, or `
        + 'configure a profile body store (PROFILE_BODY_BUCKET / the seeder\'s bucket argument) so the persona '
        + 'is kept in S3 and stops counting against this parameter.',
    );
  }
  const put = await ssm.send(
    new PutParameterCommand({ Name: name, Type: 'String', Value: body, Overwrite: true, Tier: 'Standard' }),
  );
  const version = put.Version ?? 1;
  // Move the `active` label onto the just-written version (LabelParameterVersion moves an existing label).
  await ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: version, Labels: ['active'] }));
  return { profileName, version, labeled: true };
}

/**
 * Seed every shipped profile. Used by the seeder to make each classification's active version explicit.
 *
 * `personas` maps profile name -> the deployment persona to fold into that profile's definition. A
 * name absent from the map seeds exactly as before (no persona ⇒ the runtime falls back to the
 * deployment seam). Passing nothing reproduces the previous behaviour for every profile.
 *
 * `deps.bucket` names the profile body store. The seeder runs as a script against a deployed stack, so
 * it is passed the bucket resolved from that stack's outputs rather than guessing at an environment
 * variable it does not have.
 */
export async function seedAllProfileDefinitions(
  ssm: SSMClient,
  ssmRoot: string,
  personas: Record<string, string> = {},
  deps?: BodyStoreDeps,
): Promise<SeedResult[]> {
  const names = new Set(defaultProfileRegistry.classificationValues().map((c) => defaultProfileRegistry.profileFor(c).name));
  const out: SeedResult[] = [];
  for (const name of names) {
    const r = await seedActiveProfileDefinition(ssm, ssmRoot, name, personas[name], deps);
    if (r) out.push(r);
  }
  return out;
}
