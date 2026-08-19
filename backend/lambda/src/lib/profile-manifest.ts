/**
 * Profile portability — export / import manifest (SPEC-PORTABLE-PROFILES P3/§5).
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
 * SCOPE (the AssistantConfig-unification caveat, §2/§9). The manifest carries the config-driven
 * `AssistantProfile` body via `bodyFrom` - model/classifierMode/limits, the model bundle, the tool
 * allowlist, the selected guardrailId, per-profile task machines, AND the persona - so a version's
 * behavior AND character export/import as one artifact. The intent pack is the remaining seam (still
 * resolved per-deployment from ASSISTANT_INTENT_PACK); its manifest inlining is the documented extension.
 */
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
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
  MAX_PERSONA_LENGTH,
  DEFAULT_MODEL,
} from './active-profile.js';
import { offloadBodies, hydrateBodies } from './profile-bodies.js';

/**
 * Manifest schema version. Import REJECTS any other value, so this bumps only on a change that would
 * make an older manifest misread.
 *
 * Deliberately NOT bumped when export switched to emitting a guardrail SELECTION KEY instead of a
 * resolved id: the field's shape is unchanged (still a string) and import accepts BOTH forms - a key is
 * remapped, an id already provisioned on the target passes through. Bumping would reject every
 * previously-exported manifest to gain nothing, since the old form is still handled correctly.
 */
export const MANIFEST_SCHEMA_VERSION = 1 as const;
/**
 * Reject a manifest larger than this (untrusted-input size bound, §5).
 *
 * A MANIFEST INLINES THE BODIES even though storage keeps them in S3. That is the whole reason this
 * bound is derived rather than a flat 16KB: a manifest that referenced S3 keys would carry the SOURCE
 * instance's storage layout into the target, which breaks cross-instance and cross-region portability -
 * the one promise the artifact exists to make. So the bound must hold a full `MAX_PERSONA_LENGTH`
 * persona plus the rest of the body, with headroom for JSON escaping (a persona of quotes and newlines
 * roughly doubles), or export would produce manifests import refuses.
 */
const MAX_MANIFEST_BYTES = 16 * 1024 + MAX_PERSONA_LENGTH * 2;

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
  /**
   * The field CONTRACT each selected context source satisfied on the SOURCE instance, keyed by catalog
   * key (SPEC-CONTEXT-SOURCES-AND-STORES §4/§6).
   *
   * This is what makes a context selection portable rather than merely named. The body carries keys;
   * this records what those keys MEANT where the profile was authored, so import can reject a target
   * that publishes the same key with a different shape. Without it a manifest referencing
   * `x-resume.headline` lands cleanly on an instance whose `x-resume` has no `headline` and misbehaves
   * at runtime. Logical only - field names and types, never values or resources.
   *
   * Optional: a manifest exported before this existed, or one selecting no sources, simply has none,
   * and import falls back to checking key presence alone.
   */
  contextContracts?: Record<string, { contractVersion: string; fields: Record<string, string> }>;
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

/**
 * Read a specific definition version's value, or the active/seed when version is omitted.
 *
 * HYDRATED on every branch: export INLINES the bodies (see `MAX_MANIFEST_BYTES`), so a version whose
 * persona is offloaded must have its pointer followed here. Exporting the pointer instead would emit a
 * manifest that names this instance's storage - unusable anywhere else, and a silent loss of the
 * persona on any target that accepted it.
 */
async function readDefinition(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  version?: number,
): Promise<{ def: ProfileDefinition; sourceVersion: number | 'active' | 'seed' }> {
  const name = definitionParamName(ssmRoot, profileName);
  if (version !== undefined) {
    // Addressed directly as `name:N`, the same selector family as `:active` below. This scanned
    // `GetParameterHistory` instead, which pages at 10 oldest-first with no pagination here - so
    // exporting any version of a profile with more than 10 of them failed with "version not found"
    // even though the version existed. See `profile-version-lookup.ts` for the same fix on the read
    // path, where the symptom was worse (a silently skipped variant rather than an error).
    let value: string | undefined;
    try {
      const resp = await ssm.send(new GetParameterCommand({ Name: `${name}:${version}` }));
      value = resp.Parameter?.Value;
    } catch {
      /* fall through to the not-found error below, which names the version */
    }
    if (!value) throw new ProfileManifestError(`version ${version} not found for profile '${profileName}'`);
    return { def: await hydrateBodies(JSON.parse(value) as ProfileDefinition), sourceVersion: version };
  }
  let activeRaw: string | undefined;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: `${name}:active` }));
    activeRaw = resp.Parameter?.Value;
  } catch {
    /* fall through to seed */
  }
  // Hydration is outside the catch: an unreadable BODY must not silently degrade an export of the
  // active version into an export of the compiled seed, which would look like a successful export of a
  // profile the operator never configured.
  if (activeRaw) return { def: await hydrateBodies(JSON.parse(activeRaw) as ProfileDefinition), sourceVersion: 'active' };
  const seed = serializeSeedDefinition(profileName);
  if (!seed) throw new ProfileManifestError(`unknown profile '${profileName}'`);
  return { def: JSON.parse(seed) as ProfileDefinition, sourceVersion: 'seed' };
}

/**
 * Rewrite a body's stored `guardrailId` into its stable catalog KEY, in place.
 *
 * A profile stores the guardrail id RESOLVED on the instance that authored it. That id is meaningless
 * anywhere else, which made it the one field that broke the manifest's instance-agnostic promise - and
 * it slipped past the export-side check for that promise because an opaque id is not an ARN, an account
 * id, or a region string. Emitting the KEY ('strict') instead is what lets the SELECTION survive the
 * move: the target resolves that key to its OWN provisioned guardrail on import.
 *
 * Deliberately does NOT throw. Export is a read-only operator action, and a selection that cannot be
 * mapped (catalog unreadable, or an id that predates the catalog) is emitted verbatim rather than
 * failing the export - import is the fail-closed gate and rejects an unmappable selection there, where
 * the operator can act on it. Absent selection ⇒ nothing to do.
 */
async function toPortableGuardrail(
  body: ProfileDefinitionBody,
  profileName: string,
  guardrailCatalog?: (profileName: string) => Promise<TargetGuardrail[]>,
): Promise<void> {
  if (!body.guardrailId || !guardrailCatalog) return;
  try {
    const available = await guardrailCatalog(profileName);
    const match = available.find((g) => g.guardrailId === body.guardrailId);
    if (match) {
      body.guardrailId = match.key;
    } else if (!available.some((g) => g.key === body.guardrailId)) {
      // Neither a resolved id nor already a key: leave it, and say so. Silence here would present an
      // unusable manifest as a clean export.
      console.warn(
        `[profile-manifest] guardrailId '${body.guardrailId}' on '${profileName}' matches no catalog entry; `
        + 'exporting it verbatim - it will be rejected on import into another instance',
      );
    }
  } catch (err) {
    console.warn(`[profile-manifest] could not read the guardrail catalog for '${profileName}' (${(err as Error).message}); exporting the selection verbatim`);
  }
}

/**
 * Export a version as an instance-agnostic manifest (§5).
 *
 * `guardrailCatalog` resolves the SOURCE's selectable guardrails so a stored guardrail SELECTION can be
 * emitted as its stable KEY instead of the id resolved on this instance - see {@link toPortableGuardrail}.
 * Optional: omit it and the selection is emitted verbatim (the pre-existing behaviour), which is what a
 * caller with no catalog access gets.
 */
export async function exportManifest(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  version?: number,
  guardrailCatalog?: (profileName: string) => Promise<TargetGuardrail[]>,
  contextSourceCatalog?: (profileName: string) => Promise<TargetContextSource[]>,
): Promise<ProfileManifest> {
  const { def, sourceVersion } = await readDefinition(ssm, ssmRoot, profileName, version);
  // Backfill a complete `models` bundle so a LEGACY (pre-U2) definition exports its actual editable values
  // (base + classifier + per-intent), not a bare modelKey — otherwise the manifest is a hash with nothing to
  // edit. The contentHash is computed over this same (backfilled) body so a verbatim re-import still matches.
  const body = ensureModelsBundle(bodyFrom(def));
  await toPortableGuardrail(body, profileName, guardrailCatalog);
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
  // Record what each selected context source MEANT here, so the target can reject a same-named source
  // with a different shape (§4/§6). Best-effort: an unreadable catalog on EXPORT degrades to a manifest
  // with no contracts, which import falls back to checking key presence alone. Failing the export would
  // be the wrong trade - the manifest is still useful, just less strictly verifiable, and the import
  // side is where fail-closed belongs.
  if (body.contextSources?.length && contextSourceCatalog) {
    try {
      const available = await contextSourceCatalog(profileName);
      const byKey = new Map(available.map((s) => [s.key, s]));
      const contracts: NonNullable<ProfileManifest['contextContracts']> = {};
      for (const key of body.contextSources) {
        const src = byKey.get(key);
        if (!src) continue;
        contracts[key] = {
          contractVersion: src.contractVersion || '1.0',
          // Field NAMES and TYPES only - never values, never resources.
          fields: Object.fromEntries(Object.entries(src.fields ?? {}).map(([n, f]) => [n, f.type])),
        };
      }
      if (Object.keys(contracts).length) manifest.contextContracts = contracts;
    } catch (err) {
      console.warn('[profile-manifest] could not read the context source catalog on export; '
        + 'exporting the selection without contracts:', err);
    }
  }
  // P4: sign only when a shared secret is configured (opt-in). The secret NEVER travels in the manifest.
  const secret = process.env.MANIFEST_SIGNING_SECRET;
  if (secret) manifest.signature = signManifest(manifest, secret);
  return manifest;
}

/**
 * One selectable context source on the TARGET, as published by the assistant-profile stack. Only the
 * fields import needs to VERIFY a selection - the resource identifiers are deliberately not published.
 */
export interface TargetContextSource {
  key: string;
  fields?: Record<string, { type: string; optional?: boolean }>;
  /** Reserved keys only; a major difference means the two instances disagree about the shape. */
  contractVersion?: string;
}

/** One selectable guardrail on the TARGET, as published by the assistant-profile stack. */
export interface TargetGuardrail {
  /** Stable, deployment-independent selection key (e.g. 'default', 'strict'). */
  key: string;
  /** The id resolved at deploy time on THIS instance. */
  guardrailId: string;
}

export interface ImportOptions {
  catalog: Record<BackendModelKey, BackendModelDefinition>;
  /** Bind to this profile on the target instead of the manifest's name (operator remap). */
  targetProfileName?: string;
  /** Does a profile name exist as an assistant identity on this target? */
  knownProfile: (name: string) => boolean;
  /**
   * The TARGET profile's selectable guardrail catalog. Resolved by the caller (it is an SSM read that
   * depends on the resolved target name). Throwing is a valid outcome: an unreadable catalog means the
   * selection cannot be checked, and import fails closed rather than landing an unverifiable one.
   */
  guardrailCatalog: (profileName: string) => Promise<TargetGuardrail[]>;
  /**
   * The TARGET profile's published context source catalog. Same contract as `guardrailCatalog`:
   * resolved by the caller (an SSM read that depends on the resolved target name), and THROWING IS A
   * VALID OUTCOME - an unreadable catalog means the selection cannot be checked, so import fails
   * closed rather than landing an unverifiable one.
   */
  contextSourceCatalog: (profileName: string) => Promise<TargetContextSource[]>;
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

  // 3b. Guardrail SELECTION — the same §7 "reject or remap, never widen" rule the models get above.
  //
  // `guardrailId` is a DEPLOYMENT-RESOLVED id, so a manifest exported from another instance names a
  // resource that does not exist here (and a hand-authored one may carry a catalog KEY like 'strict').
  // Unvalidated, that landed a draft whose guardrail can never be applied. It is also the ONE
  // cross-deployment reference import did not check: models are checked against the target catalog,
  // tools against the registry, machines structurally, and the target profile must be provisioned.
  //
  // Resolution order, mirroring the models rule:
  //   - already a resolved id in THIS target's catalog  -> accept unchanged;
  //   - a catalog KEY                                   -> REMAP to this instance's resolved id. This is
  //     what makes the selection portable at all: "the strict guardrail" survives the move, the
  //     source's opaque id could not;
  //   - anything else                                   -> reject, listing what this target offers.
  // Absent ⇒ inherit the deployment default, which is always valid and needs no check.
  if (!errors.length && body.guardrailId !== undefined && targetName) {
    let available: TargetGuardrail[];
    try {
      available = await opts.guardrailCatalog(targetName);
    } catch (err) {
      throw new ProfileManifestError('cannot validate the guardrail selection', [
        `the guardrail catalog for '${targetName}' could not be read (${(err as Error).message}); `
        + 'refusing to land a version whose guardrail selection cannot be verified',
      ]);
    }
    const byId = available.find((g) => g.guardrailId === body.guardrailId);
    const byKey = available.find((g) => g.key === body.guardrailId);
    if (byKey && !byId) {
      console.log(`[profile-manifest] remapped guardrail key '${body.guardrailId}' to this instance's '${byKey.guardrailId}'`);
      body.guardrailId = byKey.guardrailId;
    } else if (!byId) {
      const offered = available.map((g) => `'${g.key}'`).join(', ') || '(none provisioned)';
      errors.push(
        `guardrailId '${body.guardrailId}' is not provisioned for '${targetName}' on this instance; `
        + `reject or remap to one of its selection keys: ${offered}`,
      );
    }
  }

  // 3c. Context SELECTION (SPEC-CONTEXT-SOURCES-AND-STORES §6) — the same reject-never-widen rule.
  //
  // A profile names context sources by KEY, so a manifest is portable between deployments that publish
  // the same keys. Key presence alone is NOT enough: a context source returns DATA WITH A SHAPE, unlike
  // a guardrail (an opaque id handed to Bedrock). Two deployments can both publish `x-resume` and return
  // different fields, so a manifest referencing a field the target does not provide would import cleanly
  // and misbehave at runtime. The FIELD CONTRACT is therefore what makes portability real rather than
  // nominal, and it is checked here, not just the key.
  //
  // Fails CLOSED on an unreadable catalog: a selection that cannot be verified must not land.
  if (!errors.length && body.contextSources?.length && targetName) {
    let available: TargetContextSource[];
    try {
      available = await opts.contextSourceCatalog(targetName);
    } catch (err) {
      throw new ProfileManifestError('cannot validate the context source selection', [
        `the context source catalog for '${targetName}' could not be read (${(err as Error).message}); `
        + 'refusing to land a version whose context selection cannot be verified',
      ]);
    }
    const byKey = new Map(available.map((s) => [s.key, s]));
    for (const key of body.contextSources) {
      const target = byKey.get(key);
      if (!target) {
        const offered = available.map((s) => `'${s.key}'`).join(', ') || '(none published)';
        errors.push(
          `contextSources key '${key}' is not published for '${targetName}' on this instance; `
          + `reject or remap to one of: ${offered}`,
        );
        continue;
      }
      // A RESERVED key carries a fixed contract across deployments, so a major-version difference means
      // the two instances disagree about the shape. Deployment-defined (`x-`) keys carry whatever their
      // deployment declares, so there is no cross-instance major to compare.
      const sourceContract = m.contextContracts?.[key];
      if (sourceContract && target.contractVersion) {
        const major = (v: string) => v.split('.')[0];
        if (major(sourceContract.contractVersion) !== major(target.contractVersion)) {
          errors.push(
            `contextSources key '${key}' was written against contract v${sourceContract.contractVersion} `
            + `but this instance publishes v${target.contractVersion}; the field shapes may differ`,
          );
          continue;
        }
      }
      // Every field the manifest relied on must still be provided here, with the same type. A missing or
      // retyped field is the silent-misbehaviour case this check exists for.
      for (const [field, type] of Object.entries(sourceContract?.fields ?? {})) {
        const targetField = target.fields?.[field];
        if (!targetField) {
          errors.push(`contextSources key '${key}' needs field '${field}', which '${targetName}' does not publish`);
        } else if (targetField.type !== type) {
          errors.push(
            `contextSources key '${key}' field '${field}' is '${type}' in the manifest but `
            + `'${targetField.type}' on this instance`,
          );
        }
      }
    }
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
  // The inlined body is written into THIS instance's body store and the draft keeps a TARGET-LOCAL
  // pointer. The manifest never carried one, and could not: a pointer from the source would aim this
  // deployment at another account's bucket. Import is also where the size problem would otherwise
  // resurface - a manifest carrying a persona larger than the parameter cap validates cleanly and then
  // dies at PutParameter.
  const stored = (await offloadBodies(draft)) as typeof draft;
  await ssm.send(
    new PutParameterCommand({ Name: `${ssmRoot}/assistant/${targetName}/draft`, Type: 'String', Value: JSON.stringify(stored), Overwrite: true, Tier: 'Standard' }),
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
