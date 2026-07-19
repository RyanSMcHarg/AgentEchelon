/**
 * Active profile resolution — SPEC-PORTABLE-VERSIONED-PROFILES P0 ("store + decouple").
 *
 * The capability-profiles migration froze a profile as deploy-time-only, 1:1 with a classification.
 * P0 relaxes exactly that: a profile's *behavioral* fields resolve at runtime from the **active
 * version** in SSM (native parameter versions + an `active` label — no new datastore, §3) instead of
 * baked-in deploy-time env. Activating/editing/importing a version is then a data write, not a deploy.
 *
 * THE BEHAVIOR / PRINCIPAL CUT (§7 — load-bearing). A version changes what the assistant DOES, never
 * who it IS or what it MAY do. So this resolver merges ONLY the runtime-editable fields of the active
 * version OVER the compiled seed; the boundary fields (contextScope — an IAM `s3:GetObject` grant) are
 * ALWAYS taken from the seed, never from SSM. A tampered/hostile active version therefore cannot widen
 * scope: the widest thing it can express is ignored at resolution. The model-ARN boundary is enforced
 * separately — a version's modelKey must resolve within the deployment's `bedrock:InvokeModel`
 * allowlist (validated at write time in P1; here an out-of-catalog key simply fails closed to the seed).
 *
 * FAIL-CLOSED. Any failure — the param/label is absent (no version seeded yet), unreadable, malformed,
 * or fails validation — falls back to the compiled seed (`defaultProfileRegistry.profileByName`), never
 * to "no profile". A deployment that never seeds a definition behaves EXACTLY as today (the P0 acceptance
 * bar: behavior diff empty on the seed). Result is cached per warm container for a short TTL so an
 * activation converges within the TTL without a redeploy.
 *
 * SCOPE (the AssistantConfig-unification caveat, §2/§9). The unified definition (persona, intent pack,
 * tools, guardrail as data) is not built yet, so P0 versions only the already-config-driven
 * `AssistantProfile` subset. Persona/pack still resolve from their existing SSM/env seams; this module
 * owns model/classifierMode/limits/taskSupport/battleEligible.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createHash } from 'node:crypto';
import { defaultProfileRegistry } from '../../../lib/profile-registry.js';
import type { AssistantProfile } from '../../../lib/config/profiles.js';

/** Current definition schema version. Bumped when the serialized shape changes (import migrations, §5). */
export const PROFILE_DEFINITION_SCHEMA_VERSION = 1 as const;

/**
 * The RUNTIME-EDITABLE behavioral fields a version may carry (§7). Deliberately a SUBSET of
 * `AssistantProfile`: `name` is identity (the /assistant/{name} segment, not editable) and
 * `contextScope` is a boundary (IAM grant, deploy-time), so neither appears here.
 */
export interface ProfileDefinitionBody {
  modelKey: string;
  classifierMode: 'keyword' | 'llm';
  timeoutSeconds: number;
  taskSupport: 'lightweight' | 'full';
  rateLimitPerHour?: number;
  battleEligible?: boolean;
}

/** A stored, versioned profile definition (the JSON in `/{instance}/assistant/{name}/definition`). */
export interface ProfileDefinition extends ProfileDefinitionBody {
  schemaVersion: typeof PROFILE_DEFINITION_SCHEMA_VERSION;
  /** Stable identity ACROSS versions — MUST equal the SSM segment. */
  profileName: string;
  /** Fingerprint of the behavioral body; a version's attribution key (analytics slices by it, §6). */
  configId: string;
}

const RUNTIME_EDITABLE_KEYS: ReadonlyArray<keyof ProfileDefinitionBody> = [
  'modelKey',
  'classifierMode',
  'timeoutSeconds',
  'taskSupport',
  'rateLimitPerHour',
  'battleEligible',
];

/** Deterministic, key-ordered JSON of just the behavioral body — the hash + equality basis. */
function canonicalBody(body: ProfileDefinitionBody): string {
  const ordered: Record<string, unknown> = {};
  for (const k of [...RUNTIME_EDITABLE_KEYS].sort()) {
    if (body[k] !== undefined) ordered[k] = body[k];
  }
  return JSON.stringify(ordered);
}

/** A version's fingerprint: a short, stable hash of its behavioral body. Same body ⇒ same id. */
export function profileDefinitionConfigId(body: ProfileDefinitionBody): string {
  return createHash('sha256').update(canonicalBody(body), 'utf8').digest('hex').slice(0, 12);
}

/** Extract the runtime-editable body from a full (seed) AssistantProfile. */
function bodyOf(profile: AssistantProfile): ProfileDefinitionBody {
  return {
    modelKey: profile.modelKey,
    classifierMode: profile.classifierMode,
    timeoutSeconds: profile.timeoutSeconds,
    taskSupport: profile.taskSupport,
    ...(profile.rateLimitPerHour !== undefined ? { rateLimitPerHour: profile.rateLimitPerHour } : {}),
    ...(profile.battleEligible !== undefined ? { battleEligible: profile.battleEligible } : {}),
  };
}

/**
 * Serialize a profile's SEED (version 1) definition for the initial SSM write. The seed is
 * byte-for-byte the compiled default, so a fresh deploy that activates it changes nothing.
 * Returns null when the name is not a declared profile (nothing to seed).
 */
export function serializeSeedDefinition(profileName: string): string | null {
  const seed = defaultProfileRegistry.profileByName(profileName);
  if (!seed) return null;
  const body = bodyOf(seed);
  const def: ProfileDefinition = {
    schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
    profileName,
    ...body,
    configId: profileDefinitionConfigId(body),
  };
  return JSON.stringify(def);
}

/** SSM parameter name holding a profile's definition. `active` label selects the served version (§3). */
export function definitionParamName(ssmRoot: string, profileName: string): string {
  return `${ssmRoot}/assistant/${profileName}/definition`;
}

/**
 * Validate a parsed definition against the schema + the §7 cut. Throws on any violation so the caller
 * fails closed to the seed rather than serving an unvalidated (possibly hostile) definition.
 */
function parseDefinition(raw: string, expectedName: string): ProfileDefinition {
  const d = JSON.parse(raw) as Partial<ProfileDefinition>;
  if (d.schemaVersion !== PROFILE_DEFINITION_SCHEMA_VERSION) {
    throw new Error(`definition schemaVersion ${d.schemaVersion} != ${PROFILE_DEFINITION_SCHEMA_VERSION}`);
  }
  if (d.profileName !== expectedName) {
    throw new Error(`definition profileName '${d.profileName}' != segment '${expectedName}'`);
  }
  if (typeof d.modelKey !== 'string' || !d.modelKey) throw new Error('definition: modelKey required');
  if (d.classifierMode !== 'keyword' && d.classifierMode !== 'llm') throw new Error('definition: bad classifierMode');
  if (typeof d.timeoutSeconds !== 'number' || d.timeoutSeconds <= 0) throw new Error('definition: bad timeoutSeconds');
  if (d.taskSupport !== 'lightweight' && d.taskSupport !== 'full') throw new Error('definition: bad taskSupport');
  if (d.rateLimitPerHour !== undefined && typeof d.rateLimitPerHour !== 'number') throw new Error('definition: bad rateLimitPerHour');
  if (d.battleEligible !== undefined && typeof d.battleEligible !== 'boolean') throw new Error('definition: bad battleEligible');
  return d as ProfileDefinition;
}

interface CacheEntry {
  profile: AssistantProfile;
  configId: string;
  expires: number;
}
const cache = new Map<string, CacheEntry>();

/** The resolved active profile plus its version fingerprint (for analytics/attribution). */
export interface ResolvedActiveProfile {
  profile: AssistantProfile;
  /** The active version's configId, or `'seed'` when it fell back to the compiled default. */
  configId: string;
}

export interface ResolveActiveProfileOptions {
  ssm: SSMClient;
  ssmRoot: string;
  /** Cache TTL for a warm container. Default 30s: an activation converges within it. */
  ttlMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Resolve the ACTIVE version of a profile, merged over its compiled seed. Boundary fields
 * (name, contextScope) always come from the seed; only the §7 runtime-editable subset is taken from
 * the active version. Fail-closed to the pure seed on any error. Cached per container for `ttlMs`.
 */
export async function resolveActiveProfile(
  profileName: string,
  opts: ResolveActiveProfileOptions,
): Promise<ResolvedActiveProfile> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 30_000;

  const seed = defaultProfileRegistry.profileByName(profileName);
  // No such seed profile ⇒ nothing to serve. Fall back to the classification-fail-closed profile so
  // the caller always gets *a* profile (never undefined), matching profileFor's fail-closed contract.
  const seedProfile = seed ?? defaultProfileRegistry.profileFor(defaultProfileRegistry.failClosedValue);

  const cached = cache.get(profileName);
  if (cached && cached.expires > now()) {
    return { profile: cached.profile, configId: cached.configId };
  }

  let resolved: ResolvedActiveProfile = { profile: seedProfile, configId: 'seed' };
  try {
    const resp = await opts.ssm.send(
      new GetParameterCommand({ Name: `${definitionParamName(opts.ssmRoot, profileName)}:active` }),
    );
    const raw = resp.Parameter?.Value;
    if (raw) {
      const def = parseDefinition(raw, profileName);
      // Merge ONLY the runtime-editable body over the seed; identity + boundary stay from the seed (§7).
      const merged: AssistantProfile = {
        ...seedProfile,
        modelKey: def.modelKey,
        classifierMode: def.classifierMode,
        timeoutSeconds: def.timeoutSeconds,
        taskSupport: def.taskSupport,
        rateLimitPerHour: def.rateLimitPerHour,
        battleEligible: def.battleEligible,
      };
      resolved = { profile: merged, configId: def.configId };
    }
  } catch (err) {
    // Absent label/param (nothing activated yet) is the COMMON, expected path — log at debug volume;
    // a parse/validation failure is louder but still fail-closed to the seed.
    const name = (err as { name?: string })?.name;
    if (name !== 'ParameterNotFound' && name !== 'ParameterVersionLabelNotFound') {
      console.warn(`[active-profile] '${profileName}' active version unresolved; serving seed:`, name ?? err);
    }
  }

  cache.set(profileName, { profile: resolved.profile, configId: resolved.configId, expires: now() + ttlMs });
  return resolved;
}

/** Test seam: drop the warm-container cache. */
export function __clearActiveProfileCache(): void {
  cache.clear();
}
