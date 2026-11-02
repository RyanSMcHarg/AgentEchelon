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
 * SCOPE (the AssistantConfig-unification caveat, §2/§9). The manifest carries the runtime-editable body
 * via `bodyFrom` - the model bundle, the tool allowlist, the selected guardrailId, per-profile task
 * machines, the assistant copy, the context selection, the INTENT PACK, the ONBOARDING intake AND the
 * persona - so a version's behavior AND character export/import as one artifact. It carries no
 * deployment-time setting (`classifierMode`, `timeoutSeconds`, `taskSupport`, `rateLimitPerHour`,
 * `battleEligible`): those belong to the TARGET's own compiled config and stack, and exporting them
 * would promise an import that moves them. A manifest exported before they left still carries them, and
 * `bodyFrom` drops them on import.
 *
 * The pack travels INLINE in the manifest even though storage keeps it in S3, on exactly the same terms
 * as the persona: a manifest naming an `intentPackRef` would point the target at the SOURCE account's
 * bucket. `readDefinition` hydrates on every branch so the pointer is followed before export.
 */
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { ssmJsonValue } from './ssm-json-value.js';
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
  confineModelsToClassification,
  MAX_PERSONA_LENGTH,
  DEFAULT_MODEL,
} from './active-profile.js';
import { offloadBodies, hydrateBodies, withLayout } from './profile-bodies.js';
import { layoutFor, workflowLayoutErrors, type WorkflowLayout } from './workflow-layout.js';
import { MAX_INTENT_PACK_BYTES } from './intent-pack.js';
import { modelFits } from '../../../lib/config/model-availability.js';
import { isImageRoute } from './image-route.js';
import { retiredWelcomeErrors } from './profile-copy-fields.js';
import { deploymentRouteErrors, goldenSetReachErrors, activeRouteKeys, classificationServedBy, DEPLOY_TIME_KEYS, eventWorkflowTemplateErrors, getDraft, versionConditionErrors, versionVariableErrors, welcomeWorkflowErrors, hasTaskStep, deploymentTaskMachines } from './profile-lifecycle.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';

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
 * persona, a full `MAX_INTENT_PACK_BYTES` intent pack, and the rest of the body, with headroom for JSON
 * escaping (a persona of quotes and newlines roughly doubles), or export would produce manifests import
 * refuses. The pack term is why `MAX_INTENT_PACK_BYTES` exists at all: `MAX_INTENT_INSTRUCTIONS` bounds
 * one intent and nothing bounded how many a pack declares, so without a whole-pack limit this bound
 * could not be derived and a large pack would store fine and fail only when someone moved it.
 */
const MAX_MANIFEST_BYTES = 16 * 1024 + MAX_PERSONA_LENGTH * 2 + MAX_INTENT_PACK_BYTES;

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
    sourceVersion: number | 'active' | 'seed' | 'draft';
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
  /**
   * Where the console draws each workflow step (ADR-061 decision 7), inline as the persona is. Outside the body and its
   * `contentHash`, because it is no part of what the version does; an import lands it on the draft beside the body.
   */
  layout?: WorkflowLayout;
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
  version?: number | 'draft',
): Promise<{ def: ProfileDefinition; sourceVersion: number | 'active' | 'seed' | 'draft' }> {
  const name = definitionParamName(ssmRoot, profileName);
  // THE DRAFT, for the console's view of an assistant that has never been activated and for the draft editor,
  // which must start from what the draft holds rather than from what is serving.
  if (version === 'draft') {
    const draft = await getDraft(ssm, ssmRoot, profileName);
    if (!draft) throw new ProfileManifestError(`profile '${profileName}' has no draft`);
    return { def: draft, sourceVersion: 'draft' };
  }
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
    return { def: await withLayout(await hydrateBodies(JSON.parse(value) as ProfileDefinition)), sourceVersion: version };
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
  if (activeRaw) return { def: await withLayout(await hydrateBodies(JSON.parse(activeRaw) as ProfileDefinition)), sourceVersion: 'active' };
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
 * Optional: omit it and the selection is emitted verbatim (the pre-existing behavior), which is what a
 * caller with no catalog access gets.
 */
export async function exportManifest(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  version?: number | 'draft',
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
  const layout = layoutFor(def.layout, body.eventWorkflows);
  if (layout) manifest.layout = layout;
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
  /** A field's own trust, where it is lower than the entry's (ADR-060 decision 2), travels with it. */
  fields?: Record<string, { type: string; optional?: boolean; trust?: 'platform' | 'operator' | 'member' }>;
  /** Reserved keys only; a major difference means the two instances disagree about the shape. */
  contractVersion?: string;
  /** What a version's `ctx:` variable is checked against (ADR-060): the entry's trust, whether it describes a person, and when it is readable. */
  title?: string;
  trust?: 'platform' | 'operator' | 'member';
  describesPerson?: boolean;
  availability?: 'always' | 'identity-settled' | 'conversation-settled';
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
  /**
   * Choices the caller writes over the manifest's body before it is validated (a new assistant's name and
   * models, `withStartingChoices`), so what is checked is exactly what lands.
   */
  adjustBody?: (body: ProfileDefinitionBody) => ProfileDefinitionBody;
  /** Validate everything and write nothing: the create flow checks a file before it takes a name. */
  checkOnly?: boolean;
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

  // 1a. WHAT ONLY A DEPLOY OR ANOTHER CAPABILITY CHANGES IS REFUSED BY NAME, the same as a draft edit
  //     (`DEPLOY_TIME_KEYS`). The body is whitelisted below, so these would otherwise be dropped silently,
  //     and someone who hand-edited a manifest to move an assistant would believe it had moved. An import
  //     lands on its target's classification and owner, whatever the manifest says.
  const carried = DEPLOY_TIME_KEYS.filter((k) => k in (m.body as unknown as Record<string, unknown>) || k in (m as unknown as Record<string, unknown>));
  if (carried.length) {
    throw new ProfileManifestError('manifest rejected', carried.map((k) => (k === 'ownerTeam'
      ? 'ownerTeam is not part of a profile: ownership is changed through manage-ownership, with a reason'
      : `${k} is not part of a profile: it needs a deploy, because it changes IAM (docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md)`)));
  }

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

  const body = (opts.adjustBody ?? ((b) => b))(bodyFrom(m.body as Partial<ProfileDefinitionBody>));
  // Body validation is deferred until `targetName` is known, because the baseline it is judged
  // against is the TARGET's existing routes.

  // 2. Models — EVERY model the imported version selects (base, classifier, per-intent
  //    primary/fallback) must be reachable BY THE TARGET. Never widen (§7); an unreachable model is a
  //    reject-or-remap, never a silently-broadened boundary.
  //
  // ── THE DEPLOYMENT CATALOG IS NOT THE TARGET'S ALLOWLIST, AND TREATING IT AS ONE WAS THE DEFECT ──
  //
  // This checked only `mk in opts.catalog`, which asks whether the deployment provisions the model at
  // all. Every classification shares one catalog, so a premium-only model passed that check on a
  // STANDARD target: importing the premium assistant's definition onto the standard one was accepted
  // and landed a draft naming `opus`, which standard's processor role is denied by IAM. Measured
  // against the deployment, not reasoned about - `an-import-cannot-carry-a-model-the-target-\
  // classification-lacks.spec.ts` is the case, and it failed with
  // `{"imported":"analyst","landedAs":"draft"}` before this.
  //
  // IAM was still the layer that stopped it, which is why this was a reject-or-remap bug rather than
  // a breach: activating such a draft degrades every turn on an AccessDenied instead of reaching the
  // model. That is the failure an operator cannot diagnose from the console, and the §7 rule exists so
  // the refusal arrives at import time with the model named.
  //
  // THE TARGET CLASSIFICATION'S SELECTION (`models` on its registry entry) IS the source the grant is built from
  // (`modelArnsForClassification` filters on exactly it), so the check and the IAM policy cannot disagree.
  const targetName = opts.targetProfileName || (m.profileName as string);
  const targetClassification = targetName ? classificationServedBy(targetName) : '';
  // WHETHER THE TARGET HAS A SELECTION TO JUDGE BY. Every declared classification selects its models, so a target
  // with none is one this deployment does not declare; it is skipped and SAID, where an operator reading import
  // logs will find it, and IAM remains the enforcing layer.
  const targetModels = targetClassification ? profiles.modelsOf(targetClassification) : undefined;
  const catalogSpeaksForTarget = !!targetModels;
  if (targetClassification && !catalogSpeaksForTarget) {
    console.log(
      `[profile-manifest] classification '${targetClassification}' (target '${targetName}') declares no model selection, `
      + 'so the per-classification model check is NOT applied to this import. '
      + 'Models are still required to exist in the deployment catalog, and IAM remains the enforcing layer.',
    );
  }
  // ── WHICH SELECTIONS REJECT, AND WHICH FALL BACK, IS DECIDED BY THE RUNTIME AND NOT BY TASTE ────
  //
  // A DIRECT selection is used as given. The version's base model becomes the classification's default
  // in `baseModelSelection` (`assistant-async-processor.ts:1682`) and `resolveModelForIntent` reads
  // `catalog[profileDefaults[classification]]` with no allowlist check at all, so an unreachable base
  // model is attempted and fails on AccessDenied. That is the case the §7 refusal is for.
  //
  // A PER-INTENT ROUTE is already clamped. `resolveModelForIntent` takes a route's primary only when
  // the classification selects it, and otherwise resolves the
  // classification default, and the fallback is gated the same way (`model-resolver.ts:187` and
  // `:215`). So an unreachable route degrades by design rather than failing.
  //
  // THAT ASYMMETRY IS LOAD-BEARING FOR THE FEATURE, not a concession. Export backfills the COMPLETE
  // bundle (`ensureModelsBundle`) from the deployment-wide `INTENT_ROUTE_STRATEGY`, which names `opus`
  // for `strategic_analysis` for every profile including the basic one. Rejecting routes would
  // therefore refuse EVERY cross-classification import, including the basic-to-standard one that is
  // entirely within the target's reach - the feature would read as implemented and work for nothing.
  // Measured: the first version of this check refused `concierge` onto `analyst` on that single route.
  const willFallBack: string[] = [];
  const reachableByTarget = (mk: string): boolean =>
    !catalogSpeaksForTarget
    || targetModels!.selected.includes(mk);
  /** A selection the runtime uses as given: unreachable is a refusal. */
  const checkTargetModel = (mk: string | undefined, label: string) => {
    // The `'default'` sentinel resolves to the TARGET's classification default, so it is always valid on
    // import (it names no source-specific model) — skip the allowlist check for it.
    if (!mk || mk === DEFAULT_MODEL) return;
    if (!(mk in opts.catalog)) {
      errors.push(`${label} '${mk}' is not in the target's model catalog (allowlist); reject or remap`);
      return;
    }
    if (reachableByTarget(mk)) return;
    errors.push(
      `${label} '${mk}' is not available to the target classification '${targetClassification}' `
      + `(it selects [${targetModels!.selected.join(', ')}]); reject or remap`,
    );
  };
  /** A selection the runtime clamps: unreachable is a degradation, and it is reported rather than hidden. */
  const noteRouteModel = (mk: string | undefined, label: string) => {
    if (!mk || mk === DEFAULT_MODEL) return;
    if (!(mk in opts.catalog)) {
      errors.push(`${label} '${mk}' is not in the target's model catalog (allowlist); reject or remap`);
      return;
    }
    if (!reachableByTarget(mk)) willFallBack.push(`${label} '${mk}'`);
  };
  checkTargetModel(body.modelKey, 'model');
  if (body.models) {
    checkTargetModel(body.models.default, 'models.default');
    checkTargetModel(body.models.classifier, 'models.classifier');
    for (const [intent, route] of Object.entries(body.models.byIntent ?? {})) {
      // AN IMAGE ROUTE IS USED AS GIVEN, like the legacy `models.image` below: each of its models is refused
      // where the target's classification does not allow it (`modelFits`).
      if (isImageRoute(route)) {
        for (const [mk, label] of [[route.primary, 'primary'], [route.fallback, 'fallback']] as const) {
          if (!mk || !catalogSpeaksForTarget) continue;
          const why = modelFits(mk, targetClassification, 'image');
          if (why) errors.push(`models.byIntent['${intent}'].${label} ${why}; reject or remap`);
        }
        continue;
      }
      noteRouteModel(route.primary, `models.byIntent['${intent}'].primary`);
      noteRouteModel(route.fallback, `models.byIntent['${intent}'].fallback`);
    }
    // AN IMAGE MODEL IS USED AS GIVEN, so one the target's classification does not allow is refused like
    // a base model (`modelFits`). A target allowed no image model takes no `models.image` at all.
    if (body.models.image !== undefined && catalogSpeaksForTarget) {
      const why = modelFits(body.models.image, targetClassification, 'image');
      if (why) errors.push(`models.image ${why}; reject or remap`);
    }
    // THE ROUTES THE TARGET CANNOT INVOKE ARE LEFT OUT OF THE DRAFT, named below. The draft's activation
    // holds every route to the target's classification (`validateBody`), so carrying them would land a
    // draft that can never be activated; the runtime already resolved those intents to the default.
    if (catalogSpeaksForTarget && body.models.byIntent) {
      body.models = {
        ...body.models,
        byIntent: confineModelsToClassification({ byIntent: body.models.byIntent }, targetClassification).models?.byIntent,
      };
    }
  }
  // SAID WHERE AN OPERATOR WILL FIND IT. A landed draft naming a model the target cannot invoke is
  // correct behavior and still surprising to read in the console, so the degradation is named at import
  // rather than left to be discovered from a turn that quietly used a different model.
  if (willFallBack.length) {
    console.log(
      `[profile-manifest] import onto '${targetName}' (${targetClassification}) carries `
      + `${willFallBack.length} per-intent route(s) the target cannot invoke: ${willFallBack.join(', ')}. `
      + 'They are LEFT OUT of the draft rather than refused, so the draft is valid and those intents '
      + 'resolve to the classification default model, as they would have at runtime.',
    );
  }

  // 3. Target identity — the named profile (or the remap) must be a provisioned assistant identity on
  //    the target. Import binds to an EXISTING boundary; it never mints one (§7).
  //    `targetName` is resolved in step 2, which needs it to know which classification to judge the
  //    models against; the checks it gates stay here.
  if (!targetName) errors.push('no target profileName');
  else if (!opts.knownProfile(targetName)) errors.push(`target profile '${targetName}' is not provisioned on this instance`);
  // THE TARGET'S EXISTING ROUTES ARE THE BASELINE, the same rule the edit and activate gates apply.
  // Without it an import is refused for an unreachable route the TARGET already serves - so a profile
  // whose pack narrowed after seeding could not be imported into either, and the export/import round
  // trip failed on a body this deployment itself produced.
  errors.push(...validateDefinitionBody(body, await activeRouteKeys(ssm, ssmRoot, targetName)));

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
  // tools against the registry, machines structurally (a machine's wait declaration is accepted in
  // either form, so a manifest exported before the declared one existed still imports), and the target
  // profile must be provisioned.
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

  // 3d. Per-intent ROUTES against the taxonomy that will actually classify on this instance.
  //
  // `validateDefinitionBody` already reconciled `models.byIntent` against a manifest that carries its own
  // `intentPack`, which after the migration is every exported profile. This covers the other case - a
  // manifest written before the pack rode the version, or hand-authored without one - where the routes
  // will be resolved against the TARGET's deployment pack. Checked against `targetName`, not the
  // manifest's own name, because a remapped import is validated against the identity it lands on.
  //
  // Activation would catch it too, but a reject here names the manifest the operator just handed over
  // rather than a draft they will meet later without the context of where it came from.
  if (!errors.length && targetName) {
    // The TARGET's existing routes are the baseline here too: an import that lands on a profile
    // already serving an unreachable route is not the thing that introduced it, and refusing it would
    // make such a profile permanently unimportable as well as uneditable.
    errors.push(...await deploymentRouteErrors(body, ssm, ssmRoot, targetName, await activeRouteKeys(ssm, ssmRoot, targetName)));
    errors.push(...await goldenSetReachErrors(body, ssm, ssmRoot, targetName));
  }

  // 3d'. A MANIFEST EXPORTED BEFORE THE WELCOME BECAME A WORKFLOW (W1) carries a `welcome` the runtime reads nowhere, so it
  //      is refused by name rather than imported as a version that greets differently from the one exported.
  if (!errors.length) errors.push(...retiredWelcomeErrors((body as { welcome?: unknown }).welcome));

  // 3e. THE VERSION'S OWN EVENT WORKFLOWS, against the target (ADR-061 decision 1): the same rules a draft is held to,
  //     and every template they name resolved in the target classification, so a workflow that reads a tool or a
  //     template the target does not have is refused here rather than at its first event.
  if (!errors.length && targetName && body.eventWorkflows) {
    // A task step's machine against the machines the TARGET's runtime runs (ADR-063).
    const machines = hasTaskStep(body.eventWorkflows) ? await deploymentTaskMachines(ssm, ssmRoot, targetName) : undefined;
    if (machines && 'error' in machines) errors.push(machines.error);
    else errors.push(...welcomeWorkflowErrors(body, machines?.machines), ...await eventWorkflowTemplateErrors(body, targetName));
  }

  // 3f. THE VERSION'S VARIABLES, against what the TARGET classification publishes (ADR-060 decision 1): a manifest
  //     carries each variable as a source name and a fallback, never a resource, so a source the target's catalog,
  //     declared classifications or intakes do not hold is refused here rather than resolving to nothing.
  if (!errors.length && targetName && body.variables) {
    errors.push(...await versionVariableErrors(body, targetName, ssm, ssmRoot, opts.contextSourceCatalog));
  }

  // 3g. THE VERSION'S CONDITIONS ON A CONTEXT SOURCE, against the TARGET classification's catalog (ADR-060 decision 3):
  //     a routing rule or a `messages` entry deciding on a `ctx:` field the target does not publish, or publishes as
  //     member text, is refused here.
  if (!errors.length && targetName) {
    errors.push(...await versionConditionErrors(body, targetName, opts.contextSourceCatalog));
  }

  // THE LAYOUT IS CHECKED FOR ITS SHAPE ALONE (ADR-061 decision 7): it decides nothing a version does.
  if (!errors.length) errors.push(...workflowLayoutErrors(m.layout));
  if (errors.length) throw new ProfileManifestError('manifest failed target validation', errors);
  if (opts.checkOnly) return buildDefinition(targetName, body);
  const layout = layoutFor(m.layout, body.eventWorkflows);

  // Land as a DRAFT — never active. Provenance records where it came from (audit chain, §5).
  const draft: ProfileDefinition & { provenance?: unknown } = {
    ...buildDefinition(targetName, body),
    ...(layout ? { layout } : {}),
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
    new PutParameterCommand({ Name: `${ssmRoot}/assistant/${targetName}/draft`, Type: 'String', Value: ssmJsonValue(stored), Overwrite: true, Tier: 'Standard' }),
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
