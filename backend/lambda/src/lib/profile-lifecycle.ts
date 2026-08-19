/**
 * Profile versioning lifecycle — SPEC-PORTABLE-PROFILES P1 (§4).
 *
 * The WRITE path behind `manage-profiles` (never the async-processor role, §7). Every mutation is
 * server-actor-audited. Reuses SSM's native versioning — NO new datastore (§3):
 *   - `/assistant/{name}/definition` — the served history; each PutParameter is a monotonic version,
 *     and the `active` LABEL is the served pointer (activate/rollback move the label — instant, lossless).
 *   - `/assistant/{name}/draft` — the work-in-progress (also SSM-versioned; only the latest is used)
 *     until activation promotes it into a new labeled version of `…/definition`. No status column.
 *
 * The BEHAVIORAL cut (§7) is enforced at validate: a version carries only runtime-editable fields
 * (active-profile.ProfileDefinitionBody); the model-ARN boundary (modelKey within the deployment's
 * InvokeModel allowlist) is checked against the model catalog HERE, at write time — an out-of-catalog
 * model is a reject, not a runtime AccessDenied.
 */
import {
  SSMClient,
  GetParameterCommand,
  GetParameterHistoryCommand,
  PutParameterCommand,
  LabelParameterVersionCommand,
} from '@aws-sdk/client-ssm';
import type { BackendModelDefinition, BackendModelKey } from '../../../lib/config/model-strategy.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry.js';
import { SSM_STANDARD_TIER_MAX } from './seed-profile-definitions.js';
import { offloadBodies, hydrateBodies, bodyBucket } from './profile-bodies.js';
import {
  ProfileDefinition,
  ProfileDefinitionBody,
  buildDefinition,
  bodyFrom,
  validateDefinitionBody,
  definitionParamName,
  serializeSeedDefinition,
  profileDefinitionConfigId,
  ensureModelsBundle,
  DEFAULT_MODEL,
} from './active-profile.js';

const ACTIVE_LABEL = 'active';

function draftParamName(ssmRoot: string, profileName: string): string {
  return `${ssmRoot}/assistant/${profileName}/draft`;
}

/** Structured audit line — server-verified actor + action + target, emitted on every mutation (§4). */
function audit(action: string, actor: string, profileName: string, extra: Record<string, unknown> = {}): void {
  console.log('[ProfileLifecycle][audit]', JSON.stringify({ _audit: 'manage-profiles', action, actor, profileName, ...extra }));
}

export interface ProfileVersionSummary {
  version: number;
  configId: string;
  active: boolean;
  lastModified?: string;
}

export interface ProfileListing {
  profileName: string;
  activeVersion: number | null;
  versions: ProfileVersionSummary[];
  hasDraft: boolean;
  draftConfigId?: string;
}

/** True when `name` is a declared profile (an /assistant/{name} segment that exists). */
export function isKnownProfile(name: string): boolean {
  return defaultProfileRegistry.profileByName(name) !== undefined;
}

/** All declared profile names (the shipped/seeded set). */
export function allProfileNames(): string[] {
  return [...new Set(defaultProfileRegistry.classificationValues().map((c) => defaultProfileRegistry.profileFor(c).name))];
}

function configIdOf(rawValue: string | undefined): string {
  if (!rawValue) return 'unknown';
  try {
    return (JSON.parse(rawValue) as ProfileDefinition).configId ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** List a profile's version history (from SSM), which is active, and whether a draft exists. */
export async function listProfile(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<ProfileListing> {
  const name = definitionParamName(ssmRoot, profileName);
  const versions: ProfileVersionSummary[] = [];
  let activeVersion: number | null = null;
  let nextToken: string | undefined;
  do {
    let page;
    try {
      page = await ssm.send(new GetParameterHistoryCommand({ Name: name, WithDecryption: false, NextToken: nextToken }));
    } catch (err) {
      if ((err as { name?: string }).name === 'ParameterNotFound') break; // never seeded yet
      throw err;
    }
    for (const p of page.Parameters ?? []) {
      const isActive = (p.Labels ?? []).includes(ACTIVE_LABEL);
      if (isActive && p.Version !== undefined) activeVersion = p.Version;
      versions.push({
        version: p.Version ?? 0,
        configId: configIdOf(p.Value),
        active: isActive,
        lastModified: p.LastModifiedDate?.toISOString(),
      });
    }
    nextToken = page.NextToken;
  } while (nextToken);

  let hasDraft = false;
  let draftConfigId: string | undefined;
  try {
    const d = await ssm.send(new GetParameterCommand({ Name: draftParamName(ssmRoot, profileName) }));
    if (d.Parameter?.Value) {
      hasDraft = true;
      draftConfigId = configIdOf(d.Parameter.Value);
    }
  } catch {
    /* no draft */
  }

  versions.sort((a, b) => b.version - a.version);
  return { profileName, activeVersion, versions, hasDraft, draftConfigId };
}

/**
 * Read the current draft body, or null when there is none.
 *
 * HYDRATED, so callers see the persona whether the draft stores it inline or as an S3 pointer. That is
 * load-bearing rather than cosmetic: `editDraft` merges its patch over this, and a draft returned with
 * the pointer stripped and no persona would silently drop the persona out of the next version.
 */
export async function getDraft(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<ProfileDefinition | null> {
  let raw: string | undefined;
  try {
    const d = await ssm.send(new GetParameterCommand({ Name: draftParamName(ssmRoot, profileName) }));
    raw = d.Parameter?.Value;
  } catch {
    return null; // no draft
  }
  if (!raw) return null;
  // Hydration is OUTSIDE the catch on purpose. "No draft" and "the draft's persona could not be read"
  // are different answers, and collapsing them into null would make an unreadable body look like an
  // absent draft - `editDraft` would then silently restart from the active version and the operator's
  // work in progress would disappear without an error.
  return hydrateBodies(JSON.parse(raw) as ProfileDefinition);
}

/** Resolve the current ACTIVE definition body, falling back to the compiled seed (never fails). */
async function activeOrSeedBody(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<ProfileDefinitionBody> {
  let activeRaw: string | undefined;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(ssmRoot, profileName)}:${ACTIVE_LABEL}` }));
    activeRaw = resp.Parameter?.Value;
  } catch {
    /* fall through to seed */
  }
  // Hydrated before `bodyFrom`, which strips the envelope: an offloaded persona is in `personaRef` (an
  // envelope field), so cloning the active version without following the pointer first would produce a
  // new version identical to it EXCEPT that the assistant lost its persona.
  if (activeRaw) return bodyFrom(await hydrateBodies(JSON.parse(activeRaw) as ProfileDefinition));
  const seed = serializeSeedDefinition(profileName);
  if (!seed) throw new Error(`unknown profile '${profileName}'`);
  return bodyFrom(JSON.parse(seed) as ProfileDefinition);
}

/** As {@link activeOrSeedBody}, but with a COMPLETE `models` bundle backfilled — a legacy (pre-U2) active
 *  definition has only a bare modelKey, so a version cloned from it would inherit an empty models surface
 *  (nothing to edit). Backfilling here means a NEW version persists the full base/classifier/per-intent
 *  bundle, so activating it heals the stored definition. */
async function activeOrSeedBodyComplete(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<ProfileDefinitionBody> {
  return ensureModelsBundle(await activeOrSeedBody(ssm, ssmRoot, profileName));
}

/**
 * The ONE way a definition is written: offload the bodies, refuse an oversize remainder, then put.
 *
 * The sequence is fixed and the reason is `configId`. It hashes the body INCLUDING the persona, and the
 * S3 key contains the configId, so the definition must be BUILT before a body can be stored - hash,
 * then put, then keep the pointer. Doing it in one function is what stops the three write paths
 * (create-version, edit-draft, activate) from each growing their own ordering.
 *
 * The storage-boundary check measures the value that is actually about to be sent, after offload. That
 * is the point of the indirection: what has to fit in 4096 characters is the definition MINUS its
 * bodies, so a persona anywhere inside `MAX_PERSONA_LENGTH` is now storable instead of passing schema
 * validation and dying at PutParameter.
 */
async function putDefinition(
  ssm: SSMClient,
  paramName: string,
  def: ProfileDefinition,
): Promise<{ stored: ProfileDefinition; version: number }> {
  const stored = await offloadBodies(def);
  const tooBig = storageBoundaryError(stored);
  if (tooBig) throw new ProfileValidationError([tooBig]);
  const put = await ssm.send(new PutParameterCommand({
    Name: paramName, Type: 'String', Value: JSON.stringify(stored), Overwrite: true, Tier: 'Standard',
  }));
  return { stored, version: put.Version ?? 1 };
}

/** Clone the active version into a fresh draft (§4 create-version). Returns the draft definition. */
export async function createDraft(ssm: SSMClient, ssmRoot: string, profileName: string, actor: string): Promise<ProfileDefinition> {
  if (!isKnownProfile(profileName)) throw new Error(`unknown profile '${profileName}'`);
  const body = await activeOrSeedBodyComplete(ssm, ssmRoot, profileName);
  const def = buildDefinition(profileName, body);
  await putDefinition(ssm, draftParamName(ssmRoot, profileName), def);
  audit('create-version', actor, profileName, { configId: def.configId });
  return def;
}

/** Apply a behavioral patch to the draft (§4 edit-draft) — runtime-editable fields only; re-hashes configId. */
export async function editDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  patch: Partial<ProfileDefinitionBody>,
  actor: string,
): Promise<ProfileDefinition> {
  const existing = (await getDraft(ssm, ssmRoot, profileName)) ?? buildDefinition(profileName, await activeOrSeedBody(ssm, ssmRoot, profileName));
  // Only runtime-editable keys from the patch are honored; unknown/boundary keys are ignored (§7).
  const mergedBody: ProfileDefinitionBody = bodyFrom({ ...bodyFrom(existing), ...patch });
  // The transitional top-level `modelKey` and `models.default` are the SAME "base model" — keep them
  // consistent so resolution (`models.default ?? modelKey`) is unambiguous. A patch to either syncs both,
  // whether the editor edits the legacy `modelKey` or the new `models.default`.
  if (patch.modelKey !== undefined) {
    mergedBody.models = { ...(mergedBody.models ?? {}), default: patch.modelKey };
  } else if (patch.models?.default !== undefined) {
    mergedBody.modelKey = patch.models.default;
  }
  const errs = validateDefinitionBody(mergedBody);
  if (errs.length) throw new ProfileValidationError(errs);
  const def = buildDefinition(profileName, mergedBody);
  // The edit re-hashes, so it produces a NEW configId and therefore a new body key. That is correct and
  // is why nothing here deletes: the previous version's body must survive for a rollback to it to mean
  // anything. Content-addressing makes the write idempotent - re-saving an unchanged draft rewrites
  // identical bytes to the same key.
  //
  // `putDefinition` still refuses an oversize remainder HERE, where the operator's edit actually is.
  // The draft parameter carries the same limit as the active one, so without that check PutParameter
  // throws an AWS ValidationException that the route reports as a bare 500 'Internal error' - naming
  // neither the persona, the profile, nor the size.
  await putDefinition(ssm, draftParamName(ssmRoot, profileName), def);
  audit('edit-draft', actor, profileName, { configId: def.configId });
  return def;
}

export class ProfileValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`profile validation failed: ${errors.join('; ')}`);
    this.name = 'ProfileValidationError';
  }
}

/**
 * Validate a body against the schema (§2) AND the boundary (§7): the modelKey must resolve within the
 * deployment's model catalog (the InvokeModel-allowlist source). Returns the error list (empty ⇒ valid).
 */
export function validateBody(body: Partial<ProfileDefinitionBody>, catalog: Record<BackendModelKey, BackendModelDefinition>): string[] {
  const errs = validateDefinitionBody(body);
  // §7 model-ARN boundary: EVERY model a version selects — base, classifier, complex, and each per-intent
  // primary/fallback — must resolve within the deployment's InvokeModel allowlist (the catalog). A version
  // picks WITHIN the boundary, never beyond it; an out-of-catalog model is a reject here, not an
  // AccessDenied at inference.
  // The `'default'` sentinel names no catalog model (it means "follow the classification default"), so it
  // is always in-bounds — skip the allowlist check for it.
  const checkModel = (mk: string | undefined, label: string) => {
    if (mk && mk !== DEFAULT_MODEL && !(mk in catalog)) {
      errs.push(`${label} '${mk}' is not in the deployment's model catalog (InvokeModel allowlist boundary, §7)`);
    }
  };
  checkModel(body.modelKey, 'modelKey');
  if (body.models) {
    checkModel(body.models.default, 'models.default');
    checkModel(body.models.classifier, 'models.classifier');
    checkModel(body.models.complex, 'models.complex');
    for (const [intent, route] of Object.entries(body.models.byIntent ?? {})) {
      checkModel(route.primary, `models.byIntent['${intent}'].primary`);
      checkModel(route.fallback, `models.byIntent['${intent}'].fallback`);
    }
  }

  // Measure what would be STORED, not what was submitted: on a deployment with a body store the persona
  // moves to S3 and stops counting against the parameter, so measuring it here would reject a persona
  // that saves perfectly well. The pointer that replaces it costs about 90 characters, which this does
  // not add back - a deliberate slack, since the load-bearing check is the one `putDefinition` runs on
  // the exact bytes it is about to send, and that one reports just as precisely.
  const tooBig = storageBoundaryError(bodyBucket() ? { ...body, persona: undefined } : body);
  if (tooBig) errs.push(tooBig);
  return errs;
}

/**
 * The STORAGE boundary, as an actionable message (null when the value fits).
 *
 * Every definition write is `Tier: 'Standard'`, whose value limit is 4096 characters for the whole
 * serialized definition. Without a message, an oversize write fails at PutParameter with an opaque AWS
 * ValidationException naming neither the profile nor the field.
 *
 * MEASURE THE VALUE AS IT WILL BE STORED. Once the persona is offloaded (`personaRef` present) it does
 * not count here at all, and the two cases need different advice: "shorten the persona" is the fix in
 * one and actively misleading in the other, where the persona is no longer what is spending the budget.
 *
 * The seeder shares the same constant and arithmetic, so the paths cannot drift.
 */
export function storageBoundaryError(value: Partial<ProfileDefinition>): string | null {
  const serialized = JSON.stringify(value).length;
  if (serialized <= SSM_STANDARD_TIER_MAX) return null;
  if (value.personaRef) {
    return (
      `definition is ${serialized} characters, over the ${SSM_STANDARD_TIER_MAX}-character SSM Standard-tier `
      + 'limit WITH the persona already stored outside it. What remains - the model bundle, tool allowlist, '
      + 'task machines and context selection - is what exceeds the budget, so shortening the persona will '
      + 'not help; reduce one of those.'
    );
  }
  const overhead = serialized - (value.persona?.length ?? 0);
  return (
    `definition is ${serialized} characters, over the ${SSM_STANDARD_TIER_MAX}-character SSM Standard-tier `
    + `limit. Everything but the persona accounts for ${overhead}, leaving room for a persona of about `
    + `${Math.max(0, SSM_STANDARD_TIER_MAX - overhead)} characters. Shorten the persona, move the long-form `
    + 'grounding into a context source, or configure a profile body store (PROFILE_BODY_BUCKET) so the '
    + 'persona is kept in S3 instead of inside the parameter.'
  );
}

/**
 * Check every selected context key against this classification's PUBLISHED catalog.
 *
 * `validateDefinitionBody` only proves the selection is a list of non-empty strings, and its own
 * comment claimed the keys were "checked at the write path and at import". Only import checked them.
 * So an operator could activate a version naming a key this deployment never publishes, get no error,
 * and discover it as a per-turn `not-in-catalog` metric afterwards - a silent partial assistant.
 *
 * Fails CLOSED, matching import: a selection that cannot be verified must not be activated. Scoped to
 * profiles that actually select sources, so an unrelated SSM problem cannot block a profile that uses
 * none of this.
 */
async function contextSelectionErrors(
  body: Partial<ProfileDefinitionBody>,
  profileName: string,
  readCatalog?: (profileName: string) => Promise<Array<{ key: string }>>,
): Promise<string[]> {
  if (!body.contextSources?.length || !readCatalog) return [];
  let available: Array<{ key: string }>;
  try {
    available = await readCatalog(profileName);
  } catch (err) {
    return [
      `the context source catalog for '${profileName}' could not be read (${(err as Error).message}); `
      + 'refusing to activate a version whose context selection cannot be verified',
    ];
  }
  const keys = new Set(available.map((s) => s.key));
  const offered = available.map((s) => `'${s.key}'`).join(', ') || '(none published)';
  return body.contextSources
    .filter((key) => !keys.has(key))
    .map((key) => `contextSources key '${key}' is not published for '${profileName}'; one of: ${offered}`);
}

/**
 * Errors for a `guardrailId` the target cannot resolve.
 *
 * WHY THE WRITE PATH AND NOT JUST THE RUNTIME. `importManifest` already validates this, and
 * activate/validate did not - so the same selection was rejected arriving as a manifest and accepted
 * arriving through the console. The catalog publishes selection KEYS ('default', 'strict') alongside
 * deploy-resolved ids, and an EXPORTED manifest deliberately carries the key, so a round trip through
 * export/edit/activate is exactly how a key ends up in the stored field where an id belongs.
 *
 * What that costs is not silence: `runGuardrail` treats a selected guardrail that will not apply as a
 * persistent misconfiguration, falls back to the deployment default and logs LOUD, so content is still
 * filtered. But the profile then claims a stricter guardrail it is not getting, and the only signal is
 * an error line on every single turn. Rejecting it once at the write is the same principle `validateBody`
 * already applies to `modelKey`: an out-of-catalog selection is a reject, not a runtime surprise.
 *
 * Accepts either form, matching import: a catalog KEY or an already-resolved id that the target
 * provisions. Fails CLOSED on an unreadable catalog - a selection that cannot be verified is not
 * activated - and is skipped entirely when the profile selects no guardrail.
 */
async function guardrailSelectionErrors(
  body: Partial<ProfileDefinitionBody>,
  profileName: string,
  readGuardrailCatalog?: (profileName: string) => Promise<Array<{ key: string; guardrailId: string }>>,
): Promise<string[]> {
  if (!body.guardrailId || !readGuardrailCatalog) return [];
  let available: Array<{ key: string; guardrailId: string }>;
  try {
    available = await readGuardrailCatalog(profileName);
  } catch (err) {
    return [
      `the guardrail catalog for '${profileName}' could not be read (${(err as Error).message}); `
      + 'refusing to activate a version whose guardrail selection cannot be verified',
    ];
  }
  if (available.some((g) => g.key === body.guardrailId || g.guardrailId === body.guardrailId)) return [];
  const offered = available.map((g) => `'${g.key}'`).join(', ') || '(none published)';
  return [
    `guardrailId '${body.guardrailId}' matches no guardrail published for '${profileName}'; one of: ${offered}`,
  ];
}

/** Validate the current draft (returns errors; empty ⇒ activatable). */
export async function validateDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  readContextCatalog?: (profileName: string) => Promise<Array<{ key: string }>>,
  readGuardrailCatalog?: (profileName: string) => Promise<Array<{ key: string; guardrailId: string }>>,
): Promise<{ errors: string[]; configId?: string }> {
  const draft = await getDraft(ssm, ssmRoot, profileName);
  if (!draft) return { errors: ['no draft to validate'] };
  const body = bodyFrom(draft);
  const errors = [
    ...validateBody(body, catalog),
    ...(await contextSelectionErrors(body, profileName, readContextCatalog)),
    ...(await guardrailSelectionErrors(body, profileName, readGuardrailCatalog)),
  ];
  return { errors, configId: draft.configId };
}

/** Promote the draft to a new active version (§4 activate): validate → PutParameter → move `active`. */
export async function activateDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  actor: string,
  readContextCatalog?: (profileName: string) => Promise<Array<{ key: string }>>,
  readGuardrailCatalog?: (profileName: string) => Promise<Array<{ key: string; guardrailId: string }>>,
): Promise<{ version: number; configId: string }> {
  const draft = await getDraft(ssm, ssmRoot, profileName);
  if (!draft) throw new Error('no draft to activate');
  const body = bodyFrom(draft);
  const errs = [
    ...validateBody(body, catalog),
    // Activation is the gate, not validate: a caller can skip validate entirely.
    ...(await contextSelectionErrors(body, profileName, readContextCatalog)),
    ...(await guardrailSelectionErrors(body, profileName, readGuardrailCatalog)),
  ];
  if (errs.length) throw new ProfileValidationError(errs);
  const def = buildDefinition(profileName, body);
  const name = definitionParamName(ssmRoot, profileName);
  // `putDefinition` re-measures the value it is about to send, for the same reason editDraft relies on
  // it: validateBody above sees only the body, and this is the last gate before the write - activation
  // is reachable without ever calling validate. The body write it does first is a no-op in content
  // terms (the draft already stored this exact configId's persona at this exact key), so promoting a
  // draft never rewrites a body it did not author.
  const { version } = await putDefinition(ssm, name, def);
  await ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: version, Labels: [ACTIVE_LABEL] }));
  audit('activate', actor, profileName, { version, configId: def.configId });
  return { version, configId: def.configId };
}

/** Roll the `active` label onto an existing (immutable) version — rollback or forward-activate (§4). */
export async function activateExistingVersion(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  version: number,
  actor: string,
): Promise<{ version: number; configId: string }> {
  const name = definitionParamName(ssmRoot, profileName);
  // Confirm the version exists + read its configId for the audit (immutable — no content change).
  //
  // Addressed as `name:N`. This scanned `GetParameterHistory`, which pages at 10 OLDEST-FIRST, with no
  // pagination - so ROLLBACK was impossible past the tenth version: the version existed, the scan did
  // not reach it, and the operator got "version N not found". `listProfile` above pages correctly
  // (`NextToken`), so the console would OFFER a version this function then refused.
  let match: { Value?: string } | undefined;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: `${name}:${version}` }));
    if (resp.Parameter?.Value !== undefined) match = { Value: resp.Parameter.Value };
  } catch {
    /* fall through to the not-found error below, which names the version */
  }
  if (!match) throw new Error(`version ${version} not found for profile '${profileName}'`);
  await ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: version, Labels: [ACTIVE_LABEL] }));
  const configId = configIdOf(match.Value);
  audit('rollback', actor, profileName, { version, configId });
  return { version, configId };
}

export { profileDefinitionConfigId };
