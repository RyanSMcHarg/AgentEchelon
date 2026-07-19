/**
 * Profile versioning lifecycle — SPEC-PORTABLE-VERSIONED-PROFILES P1 (§4).
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
import {
  ProfileDefinition,
  ProfileDefinitionBody,
  buildDefinition,
  bodyFrom,
  validateDefinitionBody,
  definitionParamName,
  serializeSeedDefinition,
  profileDefinitionConfigId,
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

/** Read the current draft body, or null when there is none. */
export async function getDraft(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<ProfileDefinition | null> {
  try {
    const d = await ssm.send(new GetParameterCommand({ Name: draftParamName(ssmRoot, profileName) }));
    return d.Parameter?.Value ? (JSON.parse(d.Parameter.Value) as ProfileDefinition) : null;
  } catch {
    return null;
  }
}

/** Resolve the current ACTIVE definition body, falling back to the compiled seed (never fails). */
async function activeOrSeedBody(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<ProfileDefinitionBody> {
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(ssmRoot, profileName)}:${ACTIVE_LABEL}` }));
    if (resp.Parameter?.Value) return bodyFrom(JSON.parse(resp.Parameter.Value) as ProfileDefinition);
  } catch {
    /* fall through to seed */
  }
  const seed = serializeSeedDefinition(profileName);
  if (!seed) throw new Error(`unknown profile '${profileName}'`);
  return bodyFrom(JSON.parse(seed) as ProfileDefinition);
}

/** Clone the active version into a fresh draft (§4 create-version). Returns the draft definition. */
export async function createDraft(ssm: SSMClient, ssmRoot: string, profileName: string, actor: string): Promise<ProfileDefinition> {
  if (!isKnownProfile(profileName)) throw new Error(`unknown profile '${profileName}'`);
  const body = await activeOrSeedBody(ssm, ssmRoot, profileName);
  const def = buildDefinition(profileName, body);
  await ssm.send(new PutParameterCommand({ Name: draftParamName(ssmRoot, profileName), Type: 'String', Value: JSON.stringify(def), Overwrite: true, Tier: 'Standard' }));
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
  const errs = validateDefinitionBody(mergedBody);
  if (errs.length) throw new ProfileValidationError(errs);
  const def = buildDefinition(profileName, mergedBody);
  await ssm.send(new PutParameterCommand({ Name: draftParamName(ssmRoot, profileName), Type: 'String', Value: JSON.stringify(def), Overwrite: true, Tier: 'Standard' }));
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
  if (body.modelKey && !(body.modelKey in catalog)) {
    errs.push(`modelKey '${body.modelKey}' is not in the deployment's model catalog (InvokeModel allowlist boundary, §7)`);
  }
  return errs;
}

/** Validate the current draft (returns errors; empty ⇒ activatable). */
export async function validateDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): Promise<{ errors: string[]; configId?: string }> {
  const draft = await getDraft(ssm, ssmRoot, profileName);
  if (!draft) return { errors: ['no draft to validate'] };
  return { errors: validateBody(bodyFrom(draft), catalog), configId: draft.configId };
}

/** Promote the draft to a new active version (§4 activate): validate → PutParameter → move `active`. */
export async function activateDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  actor: string,
): Promise<{ version: number; configId: string }> {
  const draft = await getDraft(ssm, ssmRoot, profileName);
  if (!draft) throw new Error('no draft to activate');
  const body = bodyFrom(draft);
  const errs = validateBody(body, catalog);
  if (errs.length) throw new ProfileValidationError(errs);
  const def = buildDefinition(profileName, body);
  const name = definitionParamName(ssmRoot, profileName);
  const put = await ssm.send(new PutParameterCommand({ Name: name, Type: 'String', Value: JSON.stringify(def), Overwrite: true, Tier: 'Standard' }));
  const version = put.Version ?? 1;
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
  const resp = await ssm.send(new GetParameterHistoryCommand({ Name: name }));
  const match = (resp.Parameters ?? []).find((p) => p.Version === version);
  if (!match) throw new Error(`version ${version} not found for profile '${profileName}'`);
  await ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: version, Labels: [ACTIVE_LABEL] }));
  const configId = configIdOf(match.Value);
  audit('rollback', actor, profileName, { version, configId });
  return { version, configId };
}

export { profileDefinitionConfigId };
