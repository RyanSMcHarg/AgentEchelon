/**
 * Profile portability — export / import manifest (SPEC-PORTABLE-VERSIONED-PROFILES P3/§5).
 *
 * A version's point is that it can LEAVE the instance that made it. Export serializes a version into a
 * LOGICAL, INSTANCE-AGNOSTIC manifest: a model by catalog `modelKey` (never a Bedrock ARN), the
 * behavioral body, provenance, and a `contentHash`. It contains NO ARNs, account ids, secrets, or region
 * — nothing that binds it to the source instance, so cross-region falls out for free (§5).
 *
 * A MANIFEST IS UNTRUSTED INPUT (§5). Import validates it against the schema + a size bound, then against
 * the TARGET's capabilities (model in the target's catalog/allowlist; the named profile — an existing
 * assistant identity — is provisioned on the target), then lands it as a **draft** — NEVER auto-active.
 * Import creates no IAM, widens no scope, adds no model to the allowlist (§7): a reference the target does
 * not provision is rejected, not silently escalated. Activation stays a human step via the P1 lifecycle.
 *
 * SCOPE (the AssistantConfig-unification caveat, §2/§9). Until the unified definition lands, the manifest
 * carries the config-driven `AssistantProfile` body (model/classifierMode/limits/…); persona, intent pack,
 * guardrail, and tools travel on their existing seams and their manifest inlining is the documented
 * extension. So the import validations for scope/guardrail/tools are structurally present (the target is
 * authoritative) but degenerate to "the named profile exists on the target" until those fields are data.
 */
import { SSMClient, GetParameterCommand, GetParameterHistoryCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { createHash } from 'node:crypto';
import type { BackendModelDefinition, BackendModelKey } from '../../../lib/config/model-strategy.js';
import {
  ProfileDefinition,
  ProfileDefinitionBody,
  bodyFrom,
  buildDefinition,
  validateDefinitionBody,
  definitionParamName,
  serializeSeedDefinition,
} from './active-profile.js';

export const MANIFEST_SCHEMA_VERSION = 1 as const;
/** Reject a manifest larger than this (untrusted-input size bound, §5). */
const MAX_MANIFEST_BYTES = 16 * 1024;

export interface ProfileManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  kind: 'assistant-profile';
  /** Logical assistant name (the /assistant/{name} segment on any instance). */
  profileName: string;
  /** The behavioral body — logical only (modelKey is a catalog key, not an ARN). */
  body: ProfileDefinitionBody;
  provenance: {
    /** Best-effort source instance id; NEVER load-bearing (import re-resolves everything). */
    instanceId?: string;
    sourceProfileName: string;
    sourceVersion: number | 'active' | 'seed';
    exportedConfigId: string;
  };
  /** sha256 of the canonical body — carried through import as `createdFrom.contentHash` (audit chain). */
  contentHash: string;
}

export class ProfileManifestError extends Error {
  constructor(message: string, public readonly errors: string[] = []) {
    super(message);
    this.name = 'ProfileManifestError';
  }
}

function contentHashOf(body: ProfileDefinitionBody): string {
  const ordered = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex');
}

/** Read a specific definition version's value (from history), or the active/seed when version is omitted. */
async function readDefinition(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  version?: number,
): Promise<{ def: ProfileDefinition; sourceVersion: number | 'active' | 'seed' }> {
  const name = definitionParamName(ssmRoot, profileName);
  if (version !== undefined) {
    const hist = await ssm.send(new GetParameterHistoryCommand({ Name: name }));
    const match = (hist.Parameters ?? []).find((p) => p.Version === version);
    if (!match?.Value) throw new ProfileManifestError(`version ${version} not found for profile '${profileName}'`);
    return { def: JSON.parse(match.Value) as ProfileDefinition, sourceVersion: version };
  }
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: `${name}:active` }));
    if (resp.Parameter?.Value) return { def: JSON.parse(resp.Parameter.Value) as ProfileDefinition, sourceVersion: 'active' };
  } catch {
    /* fall through to seed */
  }
  const seed = serializeSeedDefinition(profileName);
  if (!seed) throw new ProfileManifestError(`unknown profile '${profileName}'`);
  return { def: JSON.parse(seed) as ProfileDefinition, sourceVersion: 'seed' };
}

/** Export a version as an instance-agnostic manifest (§5). */
export async function exportManifest(ssm: SSMClient, ssmRoot: string, profileName: string, version?: number): Promise<ProfileManifest> {
  const { def, sourceVersion } = await readDefinition(ssm, ssmRoot, profileName, version);
  const body = bodyFrom(def);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: 'assistant-profile',
    profileName,
    body,
    provenance: {
      instanceId: process.env.AE_INSTANCE_NAME || undefined,
      sourceProfileName: profileName,
      sourceVersion,
      exportedConfigId: def.configId,
    },
    contentHash: contentHashOf(body),
  };
}

export interface ImportOptions {
  catalog: Record<BackendModelKey, BackendModelDefinition>;
  /** Bind to this profile on the target instead of the manifest's name (operator remap). */
  targetProfileName?: string;
  /** Does a profile name exist as an assistant identity on this target? */
  knownProfile: (name: string) => boolean;
  actor: string;
}

/**
 * Validate an untrusted manifest against the TARGET, then land it as a draft (never active). Throws
 * ProfileManifestError with the reasons on any rejection. Returns the landed draft definition.
 */
export async function importManifest(
  ssm: SSMClient,
  ssmRoot: string,
  rawManifest: unknown,
  opts: ImportOptions,
): Promise<ProfileDefinition> {
  // 0. Size bound BEFORE parse-heavy work (untrusted input, §5).
  if (typeof rawManifest === 'string' && Buffer.byteLength(rawManifest, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ProfileManifestError('manifest exceeds size bound');
  }
  const m = (typeof rawManifest === 'string' ? safeParse(rawManifest) : rawManifest) as Partial<ProfileManifest>;
  if (rawManifest && typeof rawManifest === 'object' && Buffer.byteLength(JSON.stringify(rawManifest), 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ProfileManifestError('manifest exceeds size bound');
  }

  const errors: string[] = [];
  // 1. Schema.
  if (!m || m.kind !== 'assistant-profile') errors.push('not an assistant-profile manifest');
  if (m?.schemaVersion !== MANIFEST_SCHEMA_VERSION) errors.push(`unsupported schemaVersion '${m?.schemaVersion}' (expected ${MANIFEST_SCHEMA_VERSION})`);
  if (!m?.body || typeof m.body !== 'object') errors.push('manifest.body missing');
  if (errors.length) throw new ProfileManifestError('manifest rejected', errors);

  const body = bodyFrom(m.body as Partial<ProfileDefinitionBody>);
  errors.push(...validateDefinitionBody(body));

  // 2. Model — must be in the TARGET's catalog (its InvokeModel allowlist). Never widen (§7).
  if (body.modelKey && !(body.modelKey in opts.catalog)) {
    errors.push(`model '${body.modelKey}' is not in the target's model catalog (allowlist); reject or remap`);
  }

  // 3. Target identity — the named profile (or the remap) must be a provisioned assistant identity on
  //    the target. Import binds to an EXISTING boundary; it never mints one (§7).
  const targetName = opts.targetProfileName || (m.profileName as string);
  if (!targetName) errors.push('no target profileName');
  else if (!opts.knownProfile(targetName)) errors.push(`target profile '${targetName}' is not provisioned on this instance`);

  // 4. contentHash integrity (best-effort tamper check — recompute vs the carried hash).
  if (m.contentHash && m.contentHash !== contentHashOf(body)) errors.push('contentHash does not match body (tampered manifest)');

  if (errors.length) throw new ProfileManifestError('manifest failed target validation', errors);

  // Land as a DRAFT — never active. Provenance records where it came from (audit chain, §5).
  const draft: ProfileDefinition & { provenance?: unknown } = {
    ...buildDefinition(targetName, body),
    provenance: {
      createdFrom: {
        instanceId: m.provenance?.instanceId,
        profileName: m.provenance?.sourceProfileName,
        version: m.provenance?.sourceVersion,
      },
      contentHash: m.contentHash,
    },
  };
  await ssm.send(
    new PutParameterCommand({ Name: `${ssmRoot}/assistant/${targetName}/draft`, Type: 'String', Value: JSON.stringify(draft), Overwrite: true, Tier: 'Standard' }),
  );
  console.log('[profile-manifest][audit]', JSON.stringify({ _audit: 'manage-profiles', action: 'import', actor: opts.actor, profileName: targetName, from: m.provenance }));
  return draft;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new ProfileManifestError('manifest is not valid JSON');
  }
}
