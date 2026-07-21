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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { BackendModelDefinition, BackendModelKey } from '../../../lib/config/model-strategy.js';
import {
  ProfileDefinition,
  ProfileDefinitionBody,
  bodyFrom,
  buildDefinition,
  validateDefinitionBody,
  definitionParamName,
  serializeSeedDefinition,
  ensureModelsBundle,
  DEFAULT_MODEL,
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
  /**
   * P4 OPTIONAL manifest signing (§8): an HMAC-SHA256 over the canonical manifest (this field excluded),
   * present only when the exporter has MANIFEST_SIGNING_SECRET set. Import verifies it when a shared
   * secret is configured, and can REQUIRE it (MANIFEST_REQUIRE_SIGNATURE) — a supply-chain guard for
   * cross-instance transfer. Absent by default: signing is opt-in, not a gate on the common case.
   */
  signature?: string;
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

/** Stable JSON of a manifest with the `signature` field removed — the signing/verification basis. */
function canonicalForSigning(m: Partial<ProfileManifest>): string {
  const { signature: _omit, ...rest } = m;
  const stable = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, stable(val)]))
      : v;
  return JSON.stringify(stable(rest));
}

/** P4: HMAC-SHA256 signature of a manifest under a shared secret. */
export function signManifest(m: Partial<ProfileManifest>, secret: string): string {
  return createHmac('sha256', secret).update(canonicalForSigning(m), 'utf8').digest('hex');
}

/** Constant-time verify of a manifest's `signature` against the recomputed HMAC. */
export function verifyManifestSignature(m: Partial<ProfileManifest>, secret: string): boolean {
  if (!m.signature) return false;
  const expected = signManifest(m, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(m.signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
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
  // Backfill a complete `models` bundle so a LEGACY (pre-U2) definition exports its actual editable values
  // (base + classifier + per-intent), not a bare modelKey — otherwise the manifest is a hash with nothing to
  // edit. The contentHash is computed over this same (backfilled) body so a verbatim re-import still matches.
  const body = ensureModelsBundle(bodyFrom(def));
  const manifest: ProfileManifest = {
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
  // P4: sign only when a shared secret is configured (opt-in). The secret NEVER travels in the manifest.
  const secret = process.env.MANIFEST_SIGNING_SECRET;
  if (secret) manifest.signature = signManifest(manifest, secret);
  return manifest;
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

  // 1b. P4 OPTIONAL signature (supply-chain guard). Require it if the target policy demands one; verify
  // it whenever present + a secret is configured. Reject a bad/unverifiable signature — never silently
  // trust one. Absent signature + no requirement ⇒ the common unsigned path (opt-in feature).
  const secret = process.env.MANIFEST_SIGNING_SECRET;
  const requireSig = process.env.MANIFEST_REQUIRE_SIGNATURE === 'true';
  if (requireSig && !m.signature) throw new ProfileManifestError('manifest signature required by policy', ['MANIFEST_REQUIRE_SIGNATURE is set but the manifest is unsigned']);
  if (m.signature) {
    if (!secret) throw new ProfileManifestError('cannot verify manifest signature', ['manifest is signed but no MANIFEST_SIGNING_SECRET is configured on this instance']);
    if (!verifyManifestSignature(m, secret)) throw new ProfileManifestError('manifest signature invalid', ['signature does not match (tampered or wrong signing key)']);
  }

  const body = bodyFrom(m.body as Partial<ProfileDefinitionBody>);
  errors.push(...validateDefinitionBody(body));

  // 2. Models — EVERY model the imported version selects (base, classifier, complex, per-intent
  //    primary/fallback) must be in the TARGET's catalog (its InvokeModel allowlist). Never widen (§7);
  //    an unresolvable model is a reject-or-remap, never a silently-broadened boundary.
  const checkTargetModel = (mk: string | undefined, label: string) => {
    // The `'default'` sentinel resolves to the TARGET's classification default, so it is always valid on
    // import (it names no source-specific model) — skip the allowlist check for it.
    if (mk && mk !== DEFAULT_MODEL && !(mk in opts.catalog)) errors.push(`${label} '${mk}' is not in the target's model catalog (allowlist); reject or remap`);
  };
  checkTargetModel(body.modelKey, 'model');
  if (body.models) {
    checkTargetModel(body.models.default, 'models.default');
    checkTargetModel(body.models.classifier, 'models.classifier');
    checkTargetModel(body.models.complex, 'models.complex');
    for (const [intent, route] of Object.entries(body.models.byIntent ?? {})) {
      checkTargetModel(route.primary, `models.byIntent['${intent}'].primary`);
      checkTargetModel(route.fallback, `models.byIntent['${intent}'].fallback`);
    }
  }

  // 3. Target identity — the named profile (or the remap) must be a provisioned assistant identity on
  //    the target. Import binds to an EXISTING boundary; it never mints one (§7).
  const targetName = opts.targetProfileName || (m.profileName as string);
  if (!targetName) errors.push('no target profileName');
  else if (!opts.knownProfile(targetName)) errors.push(`target profile '${targetName}' is not provisioned on this instance`);

  // 4. contentHash is a best-effort PROVENANCE stamp, NOT an edit lock. Hand-editing the exported manifest
  //    (change a model, add a tool) then re-importing is the intended workflow (§5), so a mismatch must NOT
  //    block it: the landed draft re-derives its own configId from the edited body, staying self-consistent.
  //    Integrity for cross-instance transfer is the OPTIONAL P4 SIGNATURE (verified above), not this hash —
  //    a signed manifest whose body was altered already fails the signature check. So here we only LOG a
  //    mismatch (it just means "hand-edited since export"); we never reject on it.
  if (m.contentHash && m.contentHash !== contentHashOf(body)) {
    console.log('[profile-manifest] contentHash differs from body — hand-edited since export; accepting (draft re-hashes from the edited body)');
  }

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
