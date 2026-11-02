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
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { labelJustWrittenVersion } from './label-active.js';
import { ssmJsonValue } from './ssm-json-value.js';
import type { EventWorkflow } from './event-workflow.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import { serializeSeedDefinition, definitionParamName, SEEDED_CONTEXT_SOURCES, type ProfileDefinition } from './active-profile.js';
import type { StoredIntentPack } from './intent-pack.js';
import type { IntakeConfig } from './onboarding-intake.js';
import { offloadBodies, type BodyStoreDeps } from './profile-bodies.js';
import { projectAdvertisement, writeAdvertisement } from './assistant-advertisement.js';

/** Max value length of a Standard-tier SSM parameter, which is the tier this seeder writes. */
export const SSM_STANDARD_TIER_MAX = 4096;

/** The context sources every seed selects, defined where every seed is built (`serializeSeedDefinition`). */
export { SEEDED_CONTEXT_SOURCES };

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
 *
 * `intentPack` travels for the same reason and, unlike the persona, has no other way in: the
 * `assistant-intent-pack` parameter is written by this seeder WRITE-IF-ABSENT and by a CDK writer that
 * only exists under `-c assistantIntentPack`, so on a deployment that passes neither there is no update
 * path for the taxonomy at all. Seeding it onto version 1 gives it one.
 */
export async function seedActiveProfileDefinition(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  persona?: string,
  deps?: BodyStoreDeps,
  intentPack?: StoredIntentPack,
  onboarding?: IntakeConfig,
  boundary?: string,
  welcomeWorkflows?: Record<string, EventWorkflow>,
): Promise<SeedResult | null> {
  const seeded = serializeSeedDefinition(profileName, persona, intentPack, onboarding, boundary, welcomeWorkflows);
  if (seeded === null) return null;
  const name = definitionParamName(ssmRoot, profileName);
  // Offload before measuring: with a body store configured the persona AND the intent pack live in S3
  // and the parameter holds pointers, so what has to fit is everything except those two. Without a body
  // store this is a no-op and the check below behaves exactly as it always has.
  const def = JSON.parse(seeded) as ProfileDefinition;
  const stored = await offloadBodies(def, deps);
  const body = ssmJsonValue(stored);
  // The whole definition goes into ONE SSM parameter capped at 4096 characters. Persona and the intent
  // pack are the two fields that grow with what an operator writes, and BOTH are offloaded to S3 when a
  // body store is configured - so reaching this check at all means there is no store, and what is
  // measured is the fully inline definition. Schema validation allows a 20000-character persona, which
  // no such parameter can hold, so a long inline persona would otherwise fail here as an opaque AWS
  // ValidationException naming neither the profile nor the field. Fail by name instead, name BOTH sizes
  // so it is clear which one grew, and say how much room is left.
  if (body.length > SSM_STANDARD_TIER_MAX) {
    // Read off the ORIGINAL definition, not the stored one. With a body store both fields are already
    // pointers by this point, so measuring `stored` reported "persona 0, intent pack 0" on the one path
    // where the numbers are the whole point of the message.
    const personaChars = def.persona?.length ?? 0;
    const packChars = def.intentPack ? JSON.stringify(def.intentPack).length : 0;
    const overhead = body.length - personaChars;
    throw new Error(
      `profile '${profileName}' definition is ${body.length} chars, over the ${SSM_STANDARD_TIER_MAX}-char `
        + `SSM Standard-tier parameter limit (persona ${personaChars}, intent pack ${packChars}). The rest of `
        + `the definition needs ${overhead}, leaving room for a persona of about `
        + `${Math.max(0, SSM_STANDARD_TIER_MAX - overhead)} characters. Shorten the persona, or configure a `
        + 'profile body store (PROFILE_BODY_BUCKET / the seeder\'s bucket argument) so the persona is kept in '
        + 'S3 and stops counting against this parameter. If the INTENT PACK is what grew, trim its keyword '
        + 'lists first - the LLM classifier reads `description`, so keywords only matter on the fallback path.',
    );
  }
  const put = await ssm.send(
    new PutParameterCommand({ Name: name, Type: 'String', Value: body, Overwrite: true, Tier: 'Standard' }),
  );
  const version = put.Version ?? 1;
  // Move the `active` label onto the just-written version (LabelParameterVersion moves an existing label).
  await labelJustWrittenVersion(ssm, name, version, 'active');
  // A LABEL MOVE IS AN ACTIVATION, so the advertisement is republished here exactly as the console's
  // activation does (`profile-lifecycle.ts` republishAdvertisement), from the same stored pack. Without
  // it every seed left roommates routing on the previous version's advertisement: a seed
  // activated an `ops-premium` version whose pack did not declare `deployment_health` while the
  // advertisement still offered it, so the primary handed throttle questions over, the specialist
  // reclassified them as multi-step troubleshooting, and the task it opened then captured the person's
  // next, unrelated question (2026-10-06). Best-effort, like the lifecycle's: it never fails the seed.
  await writeAdvertisement(ssm, ssmRoot, projectAdvertisement({
    assistant: profileName,
    displayName: def.displayName,
    pack: def.intentPack,
    boundary: def.boundary,
  }));
  return { profileName, version, labeled: true };
}

/**
 * Seed every shipped profile. Used by the seeder to make each ASSISTANT's active version explicit.
 *
 * EVERY DECLARED ASSISTANT, NOT ONE PER CLASSIFICATION. This mapped each classification to
 * `requireProfileFor`, which returns the assistant that classification NAMES - its primary. So a second
 * assistant in a classification was seeded by nothing: `ops-premium` had an assignment record, an
 * identity and its own Amazon Lex bot, and no definition at all. Its persona therefore fell
 * through to `defaultPersonaFor(CLASSIFICATION)` (premium's built-in tier prose) and its taxonomy to the
 * deployment pack, so the one assistant in the tree that most needed its own character and its own
 * intents was the only one that could not be given either. `profileNames()` is the registry's own answer
 * to "every declared assistant", written for exactly this reason.
 *
 * A name absent from every map still seeds, with no persona and no pack, byte-identically to before.
 *
 * `personas` maps profile name -> the deployment persona to fold into that profile's definition. A
 * name absent from the map seeds exactly as before (no persona ⇒ the runtime falls back to the
 * deployment seam). Passing nothing reproduces the previous behavior for every profile.
 *
 * `deps.bucket` names the profile body store. The seeder runs as a script against a deployed stack, so
 * it is passed the bucket resolved from that stack's outputs rather than guessing at an environment
 * variable it does not have.
 *
 * `intentPacks` maps profile name -> the deployment taxonomy to fold in, on the same terms: a name
 * absent from the map seeds with no pack and the runtime falls back to the `assistant-intent-pack`
 * seam, byte-identically. Passing nothing reproduces the previous behavior for every profile.
 */
export async function seedAllProfileDefinitions(
  ssm: SSMClient,
  ssmRoot: string,
  personas: Record<string, string> = {},
  deps?: BodyStoreDeps,
  intentPacks: Record<string, StoredIntentPack> = {},
  onboardings: Record<string, IntakeConfig> = {},
  boundaries: Record<string, string> = {},
  /**
   * Per-assistant welcome workflows (W1), and only the assistants that NEED one appear.
   *
   * A classification primary's ordinary opening is already the classification parameter's, so seeding it here
   * too would be two sources for one sentence. An assistant whose classification copy belongs to
   * somebody else, or one that opens differently in a kind of room, is the case this exists for.
   */
  welcomes: Record<string, Record<string, EventWorkflow>> = {},
): Promise<SeedResult[]> {
  const names = new Set(defaultProfileRegistry.profileNames());
  const out: SeedResult[] = [];
  for (const name of names) {
    const r = await seedActiveProfileDefinition(ssm, ssmRoot, name, personas[name], deps, intentPacks[name], onboardings[name], boundaries[name], welcomes[name]);
    if (r) out.push(r);
  }
  return out;
}
