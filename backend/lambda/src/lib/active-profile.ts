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
import { INTENT_ROUTE_STRATEGY } from '../../../lib/config/model-strategy.js';
import type { IntentRouteDefinition, RouteKey, BackendModelKey } from '../../../lib/config/model-strategy.js';
import { ALL_TOOL_NAMES, unknownTools } from './tool-registry.js';

/** Current definition schema version. Bumped when the serialized shape changes (import migrations, §5). */
export const PROFILE_DEFINITION_SCHEMA_VERSION = 1 as const;

/**
 * The RUNTIME-EDITABLE behavioral fields a version may carry (§7). Deliberately a SUBSET of
 * `AssistantProfile`: `name` is identity (the /assistant/{name} segment, not editable) and
 * `contextScope` is a boundary (IAM grant, deploy-time), so neither appears here.
 */
/**
 * The per-profile model bundle (SPEC-ASSISTANT-CONFIG §4 unification). Model selection is PROFILE-level,
 * not a global strategy table: each profile version decides its own base/classifier/complex model and
 * per-intent overrides, all bounded by the classification's `bedrock:InvokeModel` allowlist (the
 * security ceiling — validated at the write path, §7). `byIntent` moves per-intent routing OFF the
 * global `model-strategy` table and onto the profile, which is the level of control a portable,
 * versioned assistant needs (SPEC-PORTABLE-VERSIONED-PROFILES §6).
 */
/**
 * Sentinel model value meaning "follow the classification-set default, whatever it is now". Stored
 * EXPLICITLY (a field carrying `'default'` is visible, self-documenting, and — unlike a concrete model
 * key — is NOT pinned: it deliberately tracks the platform default as it changes over time, rather than
 * freezing today's model into the profile). The seed uses it for the classifier so a profile's choice to
 * ride the platform classifier is recorded as a choice, not an absence. Resolution treats it exactly like
 * "unset" (falls back to the applicable default); the write-path catalog check skips it (it names no
 * catalog model). NEVER materialize it into a concrete key on read — that would defeat the tracking.
 */
export const DEFAULT_MODEL = 'default';

/** A concrete (non-sentinel, non-empty) model key, or undefined — so `?? fallback` chains skip both a
 *  blank field and the `'default'` sentinel and land on the applicable default. */
export function concreteModel(v: string | undefined): string | undefined {
  return v && v !== DEFAULT_MODEL ? v : undefined;
}

export interface ProfileModels {
  /** Base model. OPTIONAL: blank OR `'default'` ⇒ inherit the CLASSIFICATION default
   *  (DEFAULT_PROFILE_MODEL_SELECTION, shown in the Model Strategy tab). A profile only sets this to a
   *  concrete key to override the classification default. */
  default?: string;
  /** LLM intent-classifier model. Blank OR `'default'` (the seeded value) ⇒ inherit the deployment default
   *  classifier (Haiku / CLASSIFIER_MODEL). Profile-level; resolved per-classification via the serving
   *  profile. Seeded EXPLICITLY as `'default'` so the profile records "follow the platform classifier" as
   *  a choice that tracks the default over time — never a pinned snapshot. */
  classifier?: string;
  /** Heavier model for complex turns. */
  complex?: string;
  /** Per-intent-route model overrides, keyed by ROUTE key (the `IntentRouteDefinition.intent`): each
   *  carries the `primary` model and an optional `fallback` (resilience degrade target). Absent route ⇒
   *  `default`. Seeded from the legacy global `INTENT_ROUTE_STRATEGY` so resolution is byte-identical
   *  until an operator edits it. (Richer than the spec's flat `Record<intent, modelKey>` so the
   *  per-intent FALLBACK — not just the primary — moves per-profile too; a bare-string form would lose
   *  the graceful-degrade model the global strategy carried.) */
  byIntent?: Record<string, { primary: string; fallback?: string }>;
}

export interface ProfileDefinitionBody {
  /** DEPRECATED (transitional): equals `models.default`. U2 removes it once resolution reads `models`.
   *  Kept in U1 so every current reader keeps working while the schema lands additively + behavior-
   *  identically; the seed sets both from the same value. */
  modelKey: string;
  /** SPEC-ASSISTANT-CONFIG §4: the per-profile model bundle (base + classifier + complex + per-intent). */
  models?: ProfileModels;
  /** The Converse tool surface for this profile (tool names; a subset of what the deployment/type allows,
   *  validated at the write path). Enables per-profile tool experiments (SPEC-PORTABLE §6). */
  tools?: string[];
  /** Selection among deployment-provisioned guardrails (a version selects, never points at an arbitrary
   *  resource — §7 boundary). */
  guardrailId?: string;
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
  'models',
  'tools',
  'guardrailId',
  'classifierMode',
  'timeoutSeconds',
  'taskSupport',
  'rateLimitPerHour',
  'battleEligible',
];

/** Recursively key-sort an object/array so the configId hash is stable regardless of insertion order
 *  (the `models.byIntent` map + `tools` list must canonicalize deterministically). */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = canonicalize(val);
    }
    return out;
  }
  return v;
}

/** Deterministic, key-ordered JSON of just the behavioral body — the hash + equality basis. */
function canonicalBody(body: ProfileDefinitionBody): string {
  const ordered: Record<string, unknown> = {};
  for (const k of [...RUNTIME_EDITABLE_KEYS].sort()) {
    if (body[k] !== undefined) ordered[k] = canonicalize(body[k]);
  }
  return JSON.stringify(ordered);
}

/** A version's fingerprint: a short, stable hash of its behavioral body. Same body ⇒ same id. */
export function profileDefinitionConfigId(body: ProfileDefinitionBody): string {
  return createHash('sha256').update(canonicalBody(body), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Validate a runtime-editable body. Returns a list of human-readable errors (empty ⇒ valid). The
 * §7 model-ARN boundary (modelKey within the deployment's InvokeModel allowlist) is NOT checked here —
 * it needs the model catalog and is enforced by the write path (profile-lifecycle validate); this is
 * the schema/shape check shared by the runtime parse and the lifecycle validate.
 */
export function validateDefinitionBody(body: Partial<ProfileDefinitionBody>): string[] {
  const errs: string[] = [];
  if (typeof body.modelKey !== 'string' || !body.modelKey) errs.push('modelKey required');
  if (body.classifierMode !== 'keyword' && body.classifierMode !== 'llm') errs.push('classifierMode must be keyword|llm');
  if (typeof body.timeoutSeconds !== 'number' || body.timeoutSeconds <= 0) errs.push('timeoutSeconds must be a positive number');
  if (body.taskSupport !== 'lightweight' && body.taskSupport !== 'full') errs.push('taskSupport must be lightweight|full');
  if (body.rateLimitPerHour !== undefined && (typeof body.rateLimitPerHour !== 'number' || body.rateLimitPerHour < 0)) errs.push('rateLimitPerHour must be a non-negative number');
  if (body.battleEligible !== undefined && typeof body.battleEligible !== 'boolean') errs.push('battleEligible must be a boolean');
  // SPEC-ASSISTANT-CONFIG §4: the per-profile model bundle (shape only — the InvokeModel-allowlist
  // boundary for each model is enforced at the write path, §7, where the catalog is available).
  if (body.models !== undefined) {
    const m = body.models;
    if (typeof m !== 'object' || m === null) errs.push('models must be an object');
    else {
      // default is OPTIONAL (blank ⇒ classification default); only shape-check when present.
      if (m.default !== undefined && (typeof m.default !== 'string' || !m.default)) errs.push('models.default must be a non-empty modelKey (or omitted to inherit the classification default)');
      for (const k of ['classifier', 'complex'] as const) {
        if (m[k] !== undefined && (typeof m[k] !== 'string' || !m[k])) errs.push(`models.${k} must be a non-empty modelKey`);
      }
      if (m.byIntent !== undefined) {
        if (typeof m.byIntent !== 'object' || m.byIntent === null) errs.push('models.byIntent must be a map of route→{primary,fallback?}');
        else for (const [intent, route] of Object.entries(m.byIntent)) {
          if (typeof route !== 'object' || route === null || typeof route.primary !== 'string' || !route.primary) {
            errs.push(`models.byIntent['${intent}'].primary must be a non-empty modelKey`);
          } else if (route.fallback !== undefined && (typeof route.fallback !== 'string' || !route.fallback)) {
            errs.push(`models.byIntent['${intent}'].fallback must be a non-empty modelKey`);
          }
        }
      }
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.some((t) => typeof t !== 'string' || !t)) {
      errs.push('tools must be an array of non-empty tool names');
    } else {
      // Every tool must be a KNOWN registered tool (SPEC-ASSISTANT-CONFIG §4) — a profile can only allow
      // tools the loop actually implements; an unknown name is a typo/tampering, not a silent no-op.
      const unknown = unknownTools(body.tools);
      if (unknown.length) errs.push(`unknown tool(s): ${unknown.join(', ')} (must be in the tool registry)`);
    }
  }
  if (body.guardrailId !== undefined && (typeof body.guardrailId !== 'string' || !body.guardrailId)) errs.push('guardrailId must be a non-empty string');
  return errs;
}

/** Assemble a stored definition from a name + a (validated) body, stamping schemaVersion + configId. */
export function buildDefinition(profileName: string, body: ProfileDefinitionBody): ProfileDefinition {
  return {
    schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
    profileName,
    ...body,
    configId: profileDefinitionConfigId(body),
  };
}

/** Narrow a full/partial object down to just the runtime-editable body keys (drops name/scope/etc.). */
export function bodyFrom(obj: Partial<ProfileDefinitionBody>): ProfileDefinitionBody {
  return {
    modelKey: obj.modelKey as string,
    ...(obj.models !== undefined ? { models: obj.models } : {}),
    ...(obj.tools !== undefined ? { tools: obj.tools } : {}),
    ...(obj.guardrailId !== undefined ? { guardrailId: obj.guardrailId } : {}),
    classifierMode: obj.classifierMode as 'keyword' | 'llm',
    timeoutSeconds: obj.timeoutSeconds as number,
    taskSupport: obj.taskSupport as 'lightweight' | 'full',
    ...(obj.rateLimitPerHour !== undefined ? { rateLimitPerHour: obj.rateLimitPerHour } : {}),
    ...(obj.battleEligible !== undefined ? { battleEligible: obj.battleEligible } : {}),
  };
}

/**
 * Build the per-intent route strategy (`IntentRouteDefinition[]`, what `resolveModelForIntent` consumes)
 * from a profile version's `models.byIntent`. `resolveModelForIntent` reads only `intent`/`primaryModel`/
 * `fallbackModel`, so the other fields are placeholders. Returns null when the profile has no per-intent
 * routing, so the caller falls back to the (legacy) global strategy. THIS is what moves per-intent model
 * routing off the global table and onto the profile (U2 / SPEC-ASSISTANT-CONFIG §4).
 */
export function buildIntentStrategy(models: ProfileModels | undefined): IntentRouteDefinition[] | null {
  const byIntent = models?.byIntent;
  if (!byIntent || Object.keys(byIntent).length === 0) return null;
  // A per-intent route whose primary is the `'default'` sentinel means "no override — use the base model
  // for this intent", so it is DROPPED from the strategy (the resolver then falls back to base). Only
  // routes that name a concrete primary become strategy entries.
  const entries = Object.entries(byIntent).filter(([, route]) => concreteModel(route.primary));
  if (entries.length === 0) return null;
  return entries.map(([intent, route]) => ({
    intent: intent as RouteKey,
    label: intent,
    primaryModel: route.primary as BackendModelKey,
    fallbackModel: (concreteModel(route.fallback) ?? route.primary) as BackendModelKey,
    preferredClearance: 'basic',
    rationale: 'per-profile version (SPEC-ASSISTANT-CONFIG §4)',
  }));
}

/** Seed a profile's `models.byIntent` from the legacy global strategy — a per-profile COPY, so building
 *  the strategy back from it is byte-identical to feeding `INTENT_ROUTE_STRATEGY` directly. */
function seedByIntentFromGlobalStrategy(): Record<string, { primary: string; fallback?: string }> {
  const out: Record<string, { primary: string; fallback?: string }> = {};
  for (const r of INTENT_ROUTE_STRATEGY) out[r.intent] = { primary: r.primaryModel, fallback: r.fallbackModel };
  return out;
}

/**
 * Backfill a COMPLETE `models` bundle onto a (possibly legacy) body so export/edit surfaces the ACTUAL
 * editable values, not a bare `modelKey` + a config hash. A definition activated BEFORE the models bundle
 * existed (pre-U2) has no `models` at all; this reconstructs it from the body's own base model + the seeded
 * per-intent strategy + the explicit classifier sentinel, so a round-trip (export → hand-edit → import) has
 * real fields to change. Idempotent: a body that already carries a populated `byIntent` is returned as-is
 * (only genuinely-missing pieces are filled). Does NOT invent tools/guardrail (those have no compiled seed).
 */
export function ensureModelsBundle(body: ProfileDefinitionBody): ProfileDefinitionBody {
  const models = body.models ?? {};
  const hasByIntent = !!models.byIntent && Object.keys(models.byIntent).length > 0;
  return {
    ...body,
    models: {
      default: models.default ?? body.modelKey,
      classifier: models.classifier ?? DEFAULT_MODEL,
      ...(models.complex !== undefined ? { complex: models.complex } : {}),
      byIntent: hasByIntent ? models.byIntent : seedByIntentFromGlobalStrategy(),
    },
    // A legacy body carries no `tools`; backfill the full registry set so export/edit shows the real,
    // editable tool surface (an all-tools body resolves byte-identically to unset). Preserve an explicit list.
    tools: body.tools ?? [...ALL_TOOL_NAMES],
  };
}

/** Extract the runtime-editable body from a full (seed) AssistantProfile. The seed carries the new
 *  `models` bundle: `default` = the profile's base modelKey, and `byIntent` seeded per-profile from the
 *  legacy global strategy so U2's per-profile resolution is byte-identical to the old global path. */
function bodyOf(profile: AssistantProfile): ProfileDefinitionBody {
  return {
    modelKey: profile.modelKey,
    // classifier is seeded EXPLICITLY as the `'default'` sentinel (not absent, not the concrete Haiku key):
    // the profile records "follow the classification-set classifier" as a choice that tracks the platform
    // default over time. Resolution treats `'default'` == unset ⇒ CLASSIFIER_MODEL, so this is byte-behaviour-
    // identical to leaving it off.
    models: { default: profile.modelKey, classifier: DEFAULT_MODEL, byIntent: seedByIntentFromGlobalStrategy() },
    // Tools are seeded EXPLICITLY as the full registry set (visible + editable per profile). All-tools-allowed
    // intersected with runtime availability == the pre-allowlist behavior, so seeding is byte-behaviour-identical
    // while making the surface concrete (an operator removes a tool to restrict this profile). SPEC-ASSISTANT-CONFIG §4.
    tools: [...ALL_TOOL_NAMES],
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
  const errs = validateDefinitionBody(d);
  if (errs.length) throw new Error(`definition invalid: ${errs.join('; ')}`);
  return d as ProfileDefinition;
}

interface CacheEntry {
  profile: AssistantProfile;
  configId: string;
  models?: ProfileModels;
  tools?: string[];
  expires: number;
}
const cache = new Map<string, CacheEntry>();

/** The resolved active profile plus its version fingerprint (for analytics/attribution). */
export interface ResolvedActiveProfile {
  profile: AssistantProfile;
  /** The active version's configId, or `'seed'` when it fell back to the compiled default. */
  configId: string;
  /** The active version's per-profile model bundle (base + classifier + per-intent routing). Undefined
   *  when it fell back to the seed profile (no active version) — the caller then uses the global strategy
   *  (byte-identical, since the seed COPIES the global strategy into each version's byIntent). */
  models?: ProfileModels;
  /** The active version's per-profile tool ALLOWLIST. Undefined when it fell back to the seed (no active
   *  version) — the loop then offers all runtime-available tools (byte-identical to the pre-allowlist path). */
  tools?: string[];
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
    return { profile: cached.profile, configId: cached.configId, models: cached.models, tools: cached.tools };
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
        // Effective base model: the version's `models.default` when set to a CONCRETE key, else the
        // transitional top-level modelKey, else the seed's CLASSIFICATION default — so a version that
        // leaves base blank OR carries the `'default'` sentinel inherits the classification default
        // (shown in the Model Strategy tab). `concreteModel` skips both blank and the sentinel.
        modelKey: concreteModel(def.models?.default) ?? concreteModel(def.modelKey) ?? seedProfile.modelKey,
        classifierMode: def.classifierMode,
        timeoutSeconds: def.timeoutSeconds,
        taskSupport: def.taskSupport,
        rateLimitPerHour: def.rateLimitPerHour,
        battleEligible: def.battleEligible,
      };
      resolved = { profile: merged, configId: def.configId, models: def.models, tools: def.tools };
    }
  } catch (err) {
    // Absent label/param (nothing activated yet) is the COMMON, expected path — log at debug volume;
    // a parse/validation failure is louder but still fail-closed to the seed.
    const name = (err as { name?: string })?.name;
    if (name !== 'ParameterNotFound' && name !== 'ParameterVersionLabelNotFound') {
      console.warn(`[active-profile] '${profileName}' active version unresolved; serving seed:`, name ?? err);
    }
  }

  cache.set(profileName, { profile: resolved.profile, configId: resolved.configId, models: resolved.models, tools: resolved.tools, expires: now() + ttlMs });
  return resolved;
}

/** Test seam: drop the warm-container cache. */
export function __clearActiveProfileCache(): void {
  cache.clear();
}
