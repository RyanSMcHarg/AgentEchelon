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
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import { ssmJsonValue } from './ssm-json-value.js';
import type { BackendModelDefinition, BackendModelKey, RouteKey } from '../../../lib/config/model-strategy.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import { SSM_STANDARD_TIER_MAX } from './seed-profile-definitions.js';
import { offloadBodies, hydrateBodies, bodyBucket, withLayout } from './profile-bodies.js';
import { layoutFor, workflowLayoutErrors, type WorkflowLayout } from './workflow-layout.js';
import { parseIntentPack, resolvePackParameterValue, intentKeysOf, taskStateMachines, canOpenWork, needsOf, UNIVERSAL_INTENT_KEYS, WORK_MANAGEMENT_INTENT_KEYS } from './intent-pack.js';
import { RETIRED_ROUTE_KEYS, retiredRouteKeyError, TRIVIAL_ROUTE_KEYS } from './model-resolver.js';
import { modelFits } from '../../../lib/config/model-availability.js';
import { modelKindOf } from '../../../lib/config/model-catalog.js';
import { IMAGE_GEN_MODELS, type ImageGenModelKey } from './image-gen-models.js';
import { IMAGE_ROUTE_KEY, isImageModelKey, isImageRoute, routeKindError, routeKindErrorDetail } from './image-route.js';
import { stepRouteErrors, type IntentRoute, type RouteError } from './step-models.js';
import { displayNameErrors } from './display-name.js';
import { messagesShapeErrors, patchShapeErrors, retiredCopyErrors, retiredWelcomeErrors } from './profile-copy-fields.js';
import { legacyWelcomePlan } from './legacy-welcome-migration.js';
import { eventWorkflowRoleWarnings, templatesNamedBy, versionEventWorkflowsErrors, type EventWorkflow } from './event-workflow.js';
import { workerAssistantRole } from './task-step.js';
import { confirmBriefErrors, type TaskStateMachine } from './task-state-machines.js';
import { buildSourceTable, catalogEntryForVariables, intakeFactKeys, sourceKindOf, sourceLookup, versionLookup, versionVariablesErrors, versionVariablesShapeErrors, whenErrors, whenReadsCatalog, withUnreadCatalog, type VariableCatalogEntry } from './variables.js';
import { parseIntakeConfig, type IntakeConfig } from './onboarding-intake.js';
import { projectAdvertisement, writeAdvertisement } from './assistant-advertisement.js';
import { lookupProfileVersion } from './profile-version-lookup.js';
import { GOLDEN_SET_CAPACITY } from './golden-upload.js';
import { withStartingChoices, type StartingChoices } from './starting-point.js';
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
  confineModelsToClassification,
  packWithoutMachines,
  DEFAULT_MODEL,
} from './active-profile.js';
import { isNoActiveVersion } from './active-label.js';
import { labelJustWrittenVersion } from './label-active.js';

const ACTIVE_LABEL = 'active';

function draftParamName(ssmRoot: string, profileName: string): string {
  return `${ssmRoot}/assistant/${profileName}/draft`;
}

/** Structured audit line — server-verified actor + action + target, emitted on every mutation (§4). */
export function audit(action: string, actor: string, profileName: string, extra: Record<string, unknown> = {}): void {
  console.log('[ProfileLifecycle][audit]', JSON.stringify({ _audit: 'manage-profiles', action, actor, profileName, ...extra }));
}

export interface ProfileVersionSummary {
  version: number;
  configId: string;
  active: boolean;
  lastModified?: string;
  /** Present on a candidate an experiment derived (it never served); read from the stored envelope. */
  derivedFrom?: ProfileDefinition['derivedFrom'];
  /** Present on a version an experiment's promotion copied in from its candidate. */
  promotedFrom?: ProfileDefinition['promotedFrom'];
  /** Present on a version an administrator activated past the golden gate, with the refusal and the reason. */
  activatedPastGate?: ProfileDefinition['activatedPastGate'];
}

export interface ProfileListing {
  profileName: string;
  activeVersion: number | null;
  versions: ProfileVersionSummary[];
  hasDraft: boolean;
  draftConfigId?: string;
  /** The active version's own `displayName`, when it names one (it stays inline, never offloaded). */
  activeDisplayName?: string;
  /**
   * THE ACTIVE VERSION'S EVENT WORKFLOWS, each by name with the event that starts it and the rooms it runs in, read from
   * the definition the listing already holds (`eventWorkflows` stays inline, never offloaded), so the console lists them
   * per assistant without reading a body. Absent while no version is active.
   */
  activeEventWorkflows?: Array<{ name: string; on: string; types?: string[] }>;
  /** Whether the active version declares an onboarding intake, which is how an assistant with no welcome of its own greets. */
  activeOnboarding?: boolean;
}

/**
 * THE CLASSIFICATION AN ASSISTANT SERVES, for the SSM keys that are CLASSIFICATION-scoped.
 *
 * Three parameters under `/assistant/{...}` are the classification's, not the assistant's: the intent
 * pack, the selectable guardrail catalog and the selectable context-source catalog. They describe what
 * the classification's infrastructure PROVIDES, and a profile version selects from them - so several
 * assistants in one classification share one catalog, which is the correct shape.
 *
 * Every one of them was read under the PROFILE name and hit by accident, because a profile was named
 * after the classification it served. Renaming assistants broke all three at once, and broke them
 * FAIL-OPEN: an absent catalog reads as "this deployment publishes none", so validation stopped
 * rejecting a selection the deployment cannot honor instead of reporting an error.
 *
 * Falls back to the profile name so a deployment whose profile IS its classification still resolves.
 */
/**
 * THE CLASSIFICATION AN ASSISTANT RUNS IN, including one that is not its classification's primary.
 *
 * `classificationFor` answers only for a primary: it scans the classifications for the one whose
 * `profile` names this assistant. An ADDITIONAL ROLE is not named by any classification, so it fell
 * through to `?? profileName` and the caller received the profile name where it expected a
 * classification. That is a silent wrong answer rather than a missing one, and it made the
 * per-classification model check in `profile-manifest.ts` INERT for exactly the assistants it was
 * written for: `ops-premium` resolved to `'ops-premium'`, the catalog declares no models for a
 * classification by that name, so the check logged that it did not apply and passed every model. An
 * import onto an additional role could still land a draft naming a model that role's classification is
 * denied, which is the failure the check exists to stop.
 *
 * THE SECOND BRANCH INVERTS A COMPOSITION THE STACK ALREADY OWNS rather than parsing a name. A role's
 * assistant is provisioned as `${role}-${classification}` (`assistant-profile-stack.ts`), and the
 * roles are DECLARED per classification (`rolesFor`), so this walks the declared pairs and matches -
 * it cannot invent a classification that the deployment has not named, and a renamed convention breaks
 * the composition in one place rather than two.
 *
 * The profile name is still the last resort, because a caller that passes something this deployment
 * does not declare must not be handed a classification it did not ask about.
 *
 * ONE CAVEAT, because this answer now feeds a security-shaped check and a plausible wrong answer is
 * worse there than an obvious one. An AMBIGUOUS composition returns the profile name rather than
 * picking the first match - role `ops` in a classification `a-b` and role `ops-a` in a classification
 * `b` both compose to `ops-a-b`, and guessing between them would apply the model check against the
 * wrong allowlist. It walks the DECLARED roles (`rolesFor`), which are the roles the stacks build, so
 * an answer names a classification a deployed role serves; it is still a statement about reach, and
 * whether the assistant is live is its assignment record's to say.
 */
/** The classification a profile serves, or undefined when it names none this deployment declares. */
function servedClassification(profileName: string): string | undefined {
  const c = classificationServedBy(profileName);
  return defaultProfileRegistry.classificationValues().includes(c) ? c : undefined;
}

export function classificationServedBy(profileName: string): string {
  if (!profileName) return profileName;
  // The registry's resolver, which walks the declared roles and refuses an ambiguous name (see the
  // caveat above). The name itself comes back when it resolves to none, which callers rely on.
  return defaultProfileRegistry.classificationOfAssistant(profileName) ?? runtimeAssistants.get(profileName) ?? profileName;
}

/**
 * Runtime assistants this container has read from the directory (ADR-048), by name, to the classification
 * their record assigns them to. Learned by the handler that read the directory (`rememberRuntimeAssistant`),
 * never from a request, so a name is only known with the classification its own record names.
 */
const runtimeAssistants = new Map<string, string>();

/** Know a runtime assistant read from the directory, so its versions and catalogs resolve. */
export function rememberRuntimeAssistant(name: string, classification: string): void {
  runtimeAssistants.set(name, classification);
}

/** Forget a name the directory no longer reports as an active runtime assistant. */
export function forgetRuntimeAssistant(name: string): void {
  runtimeAssistants.delete(name);
}

/** Whether a name is a runtime assistant this container knows, and not a compiled one. */
export function isRuntimeAssistant(name: string): boolean {
  return !defaultProfileRegistry.profileByName(name) && runtimeAssistants.has(name);
}

export function isKnownProfile(name: string): boolean {
  return defaultProfileRegistry.profileByName(name) !== undefined || runtimeAssistants.has(name);
}

/**
 * All declared profile names (the shipped/seeded set).
 *
 * EVERY DECLARED ASSISTANT, not one per classification. This mapped each classification through
 * `requireProfileFor`, which returns the assistant that classification NAMES - its primary - so a
 * classification hosting a second role listed only the first. The console lists profiles from here,
 * so the effect was that an additional role's assistant could not be versioned, validated or rolled
 * back by the team that owns it, which is the whole runtime half of the ownership model.
 */
export function allProfileNames(): string[] {
  return defaultProfileRegistry.profileNames();
}

/** The provenance envelope of a stored definition (`derivedFrom`, `promotedFrom`, `activatedPastGate`), or nothing. */
function provenanceOf(rawValue: string | undefined): Pick<ProfileVersionSummary, 'derivedFrom' | 'promotedFrom' | 'activatedPastGate'> {
  if (!rawValue) return {};
  try {
    const def = JSON.parse(rawValue) as ProfileDefinition;
    return {
      ...(def.derivedFrom ? { derivedFrom: def.derivedFrom } : {}),
      ...(def.promotedFrom ? { promotedFrom: def.promotedFrom } : {}),
      ...(def.activatedPastGate ? { activatedPastGate: def.activatedPastGate } : {}),
    };
  } catch {
    return {};
  }
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
  let activeDisplayName: string | undefined;
  let activeWorkflows: Pick<ProfileListing, 'activeEventWorkflows' | 'activeOnboarding'> = {};
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
      if (isActive && p.Version !== undefined) {
        activeVersion = p.Version;
        activeDisplayName = displayNameOf(p.Value)?.trim() || undefined;
        activeWorkflows = eventWorkflowsListedOf(p.Value);
      }
      versions.push({
        version: p.Version ?? 0,
        configId: configIdOf(p.Value),
        active: isActive,
        lastModified: p.LastModifiedDate?.toISOString(),
        // So the Profiles tab can mark a candidate and a version a promotion copied in.
        ...provenanceOf(p.Value),
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
  return { profileName, activeVersion, versions, hasDraft, draftConfigId, ...(activeDisplayName ? { activeDisplayName } : {}), ...activeWorkflows };
}

/** A stored definition's event workflows as the listing names them, and whether it declares an onboarding intake. */
function eventWorkflowsListedOf(rawValue: string | undefined): Pick<ProfileListing, 'activeEventWorkflows' | 'activeOnboarding'> {
  if (!rawValue) return {};
  try {
    const def = JSON.parse(rawValue) as ProfileDefinition;
    const workflows = Object.entries(def.eventWorkflows ?? {})
      .filter(([, wf]) => typeof wf?.on === 'string')
      .map(([name, wf]) => ({ name, on: wf.on, ...(Array.isArray(wf.types) && wf.types.length ? { types: [...wf.types] } : {}) }));
    return { activeEventWorkflows: workflows, activeOnboarding: !!def.onboarding };
  } catch {
    return {};
  }
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
  } catch (err) {
    // ONLY AN ABSENT PARAMETER IS "NO DRAFT". A throttle or a denied read reported as no draft would let a caller
    // seed or edit over a draft that exists, and the console would show it as missing.
    if ((err as { name?: string })?.name === 'ParameterNotFound') return null;
    throw err;
  }
  if (!raw) return null;
  // Hydration is OUTSIDE the catch on purpose. "No draft" and "the draft's persona could not be read"
  // are different answers, and collapsing them into null would make an unreadable body look like an
  // absent draft - `editDraft` would then silently restart from the active version and the operator's
  // work in progress would disappear without an error.
  // THE CANVAS LAYOUT IS READ BACK TOO (ADR-061 decision 7): getDraft is the admin plane's read, and the layout rides the draft
  // through every edit and into activation. An unreadable layout reads as none (`readLayout`).
  return withLayout(await hydrateBodies(JSON.parse(raw) as ProfileDefinition));
}

/**
 * THE TWO VERSIONS A GOLDEN RUN ANSWERS WITH (ADR-065), as SSM stores them: bodies by pointer, which the run follows
 * from S3 inside the archive's VPC, where SSM is unreachable. The active side is the compiled seed where nothing is
 * published, as a turn serves it. Null when there is no draft.
 */
export async function storedRunSides(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
): Promise<{ draft: ProfileDefinition; active: ProfileDefinition } | null> {
  let draftRaw: string | undefined;
  try {
    draftRaw = (await ssm.send(new GetParameterCommand({ Name: draftParamName(ssmRoot, profileName) }))).Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return null;
    throw err;
  }
  if (!draftRaw) return null;
  return { draft: JSON.parse(draftRaw) as ProfileDefinition, active: await storedActiveDefinition(ssm, ssmRoot, profileName) };
}

/** The active version's stored definition, bodies by pointer; the compiled seed where nothing is published. */
export async function storedActiveDefinition(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<ProfileDefinition> {
  let activeRaw: string | undefined;
  try {
    activeRaw = (await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(ssmRoot, profileName)}:${ACTIVE_LABEL}` }))).Parameter?.Value;
  } catch (err) {
    if (!isNoActiveVersion(err)) throw err;
  }
  const active = activeRaw ?? serializeSeedDefinition(profileName);
  if (!active) throw new Error(`unknown profile '${profileName}'`);
  return JSON.parse(active) as ProfileDefinition;
}

/**
 * THE INTENTS A VERSION SERVES: its own pack's, else the deployment's for its classification, as a turn classifies
 * against them. `packRaw` is the deployment's pack as stored, read once by the caller for both versions.
 */
export async function servedIntentKeys(def: ProfileDefinition, packRaw: string | undefined): Promise<string[]> {
  const hydrated = await hydrateBodies(def);
  return hydrated.intentPack ? [...intentKeysOf(hydrated.intentPack)] : parseIntentPack(packRaw).intents.map((d) => d.key);
}

/**
 * THE DEPLOYMENT'S INTENT PACK FOR THE CLASSIFICATION A PROFILE SERVES, as stored: what a version carrying no pack of its
 * own classifies and answers against. Undefined when absent or unreadable, which is the platform default, exactly what
 * the runtime would use.
 */
export async function deploymentPackRaw(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<string | undefined> {
  try {
    // THE DEPLOYMENT PACK IS CLASSIFICATION-KEYED, so the profile is mapped back to the
    // classification it serves rather than used as the segment. It is published per classification
    // (`assistant-profile-stack.ts`) and read per classification (`user-tasks-api.ts`); reading it
    // under a profile name misses, `parseIntentPack(undefined)` yields the platform default taxonomy,
    // and a version whose `models.byIntent` targets a deployment-declared intent is then rejected as
    // unreachable. That was invisible while a profile was named after its classification.
    const classification = classificationServedBy(profileName);
    const got = await ssm.send(new GetParameterCommand({
      Name: `${ssmRoot}/assistant/${classification}/assistant-intent-pack`,
    }));
    // A pointer is followed into the classification's pack prefix, which this role reads for every
    // classification because it edits every classification's profiles.
    return await resolvePackParameterValue(got.Parameter?.Value, classification);
  } catch {
    return undefined;
  }
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

/**
 * The version number the `active` label currently points at, or null when nothing is published yet
 * (a seed-only profile, which `activeOrSeedBody` serves from the compiled seed).
 *
 * A DIRECT LABEL READ, not a history scan. `readProfileVersions` also answers this, but it pages
 * `GetParameterHistory` to do it - the same paging that hid versions past the tenth from
 * `activateExistingVersion` until it was changed to address `name:N` directly. This is one question
 * with an exact answer, so it asks the exact question.
 */
async function activeVersionNumber(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<number | null> {
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(ssmRoot, profileName)}:${ACTIVE_LABEL}` }));
    return resp.Parameter?.Version ?? null;
  } catch {
    return null;
  }
}

/** As {@link activeOrSeedBody}, but with a COMPLETE `models` bundle backfilled — a legacy (pre-U2) active
 *  definition has only a bare modelKey, so a version cloned from it would inherit an empty models surface
 *  (nothing to edit). Backfilling here means a NEW version persists the full base/classifier/per-intent
 *  bundle, so activating it heals the stored definition. */
async function activeOrSeedBodyComplete(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<ProfileDefinitionBody> {
  const body = ensureModelsBundle(await activeOrSeedBody(ssm, ssmRoot, profileName));
  // A BODY CLONED INTO A NEW VERSION KEEPS ONLY THE MODELS ITS CLASSIFICATION ALLOWS. The write path
  // refuses any other selection (`validateBody`), and a version stored before it did - an image model
  // backfilled into every classification, a route copied from the platform strategy - would otherwise
  // make every later edit of it refused for a selection nobody made. Dropped here, by name, instead.
  const confined = confineModelsToClassification(body.models, servedClassification(profileName));
  if (confined.dropped.length) {
    console.warn('[profile-lifecycle] a new version leaves out model selections its classification does not allow', {
      profileName, dropped: confined.dropped,
    });
    return { ...body, ...(confined.models ? { models: confined.models } : {}) };
  }
  return body;
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
    Name: paramName, Type: 'String', Value: ssmJsonValue(stored), Overwrite: true, Tier: 'Standard',
  }));
  return { stored, version: put.Version ?? 1 };
}

/** The active version's canvas layout, or undefined when it has none or none could be read. */
async function activeLayout(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<WorkflowLayout | undefined> {
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(ssmRoot, profileName)}:${ACTIVE_LABEL}` }));
    if (!resp.Parameter?.Value) return undefined;
    return (await withLayout(JSON.parse(resp.Parameter.Value) as ProfileDefinition)).layout;
  } catch {
    return undefined;
  }
}

/** Clone the active version into a fresh draft (§4 create-version). Returns the draft definition. */
export async function createDraft(ssm: SSMClient, ssmRoot: string, profileName: string, actor: string): Promise<ProfileDefinition> {
  if (!isKnownProfile(profileName)) throw new Error(`unknown profile '${profileName}'`);
  const body = await activeOrSeedBodyComplete(ssm, ssmRoot, profileName);
  // A NEW VERSION STARTS WHERE THE ACTIVE ONE'S STEPS ARE DRAWN (ADR-061 decision 7), so a rollback followed by a new version
  // edits the layout the rolled-to version was saved with.
  const layout = layoutFor(await activeLayout(ssm, ssmRoot, profileName), body.eventWorkflows);
  const def = { ...buildDefinition(profileName, body), ...(layout ? { layout } : {}) };
  await putDefinition(ssm, draftParamName(ssmRoot, profileName), def);
  audit('create-version', actor, profileName, { configId: def.configId });
  return def;
}

/** What seeding a runtime assistant's first draft did. */
export interface FirstDraftResult {
  seeded: boolean;
  configId?: string;
  /** Why nothing was seeded, or what the seeded draft lacks that activation will ask for. */
  reason?: string;
}

/**
 * A CONSOLE-CREATED ASSISTANT'S FIRST DRAFT, from its classification's defaults (ADR-048).
 *
 * A runtime assistant has no compiled behavior to clone and no deploy that seeds it, so it opens with what
 * a declared assistant of its classification starts from: the record's own name and model (its runtime seed,
 * `runtimeSeedFor`), the classification's intent pack (`/assistant/{c}/assistant-intent-pack`, which a
 * runtime version must carry as its own, `activateDraft`), and the classification's persona parameter when
 * the deployment sets one. Landed as a DRAFT, never active: the team reads it, edits it and activates it.
 *
 * `replace` is for an operator's explicit "new version" on an assistant that has never been activated; a
 * create seeds only when there is no draft yet, so a draft someone started is never overwritten by the build.
 * An assistant with an active version is not seeded: its next version is a clone of what is serving.
 */
export async function seedFirstDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  actor: string,
  opts: { replace?: boolean; choices?: StartingChoices } = {},
): Promise<FirstDraftResult> {
  if (!isRuntimeAssistant(profileName)) return { seeded: false, reason: `'${profileName}' is not an active runtime assistant` };
  if ((await activeVersionNumber(ssm, ssmRoot, profileName)) !== null) {
    return { seeded: false, reason: 'it has an active version; a new version clones that' };
  }
  if (!opts.replace && (await getDraft(ssm, ssmRoot, profileName))) return { seeded: false, reason: 'it already has a draft' };
  const classification = classificationServedBy(profileName);
  const optional = async (name: string): Promise<string | undefined> => {
    try {
      return (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
    } catch (err) {
      if ((err as { name?: string })?.name === 'ParameterNotFound') return undefined;
      throw err;
    }
  };
  const packRaw = await resolvePackParameterValue(
    await optional(`${ssmRoot}/assistant/${classification}/assistant-intent-pack`), classification,
  );
  const persona = (await optional(`${ssmRoot}/assistant/${classification}/assistant-system-prompt`))?.replace(/\r\n/g, '\n').trim();
  const body: ProfileDefinitionBody = withStartingChoices({
    ...(await activeOrSeedBodyComplete(ssm, ssmRoot, profileName)),
    // THE CLASSIFICATION'S TASK GRAPHS STAY ON THE CLASSIFICATION: its pack parameter may declare `machines`, and a
    // version that carries them is refused at activation, so a first draft copied whole could never be activated.
    ...(packRaw ? { intentPack: packWithoutMachines(JSON.parse(packRaw)) as ProfileDefinitionBody['intentPack'] } : {}),
    ...(persona ? { persona } : {}),
  }, opts.choices ?? {});
  const def = buildDefinition(profileName, body);
  await putDefinition(ssm, draftParamName(ssmRoot, profileName), def);
  audit('seed-first-draft', actor, profileName, { configId: def.configId, classification, intentPack: !!packRaw, persona: !!persona });
  return {
    seeded: true,
    configId: def.configId,
    ...(packRaw ? {} : { reason: `the ${classification} classification publishes no intent pack; import one before activating` }),
  };
}

/**
 * A NEW ASSISTANT'S FIRST DRAFT, COPIED FROM ANOTHER ASSISTANT'S ACTIVE VERSION (the create flow's "copy").
 *
 * The source must serve the same classification, because a version is validated against its classification's
 * models, guardrails and context sources, and must have an active version, because a draft is not a reviewed
 * behavior. An alt is never a source: its profile is its experiment's. The create's own choices (name, base
 * and classifier model) are written over the copy, and the draft records where it came from.
 */
export async function copyFirstDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  from: string,
  actor: string,
  choices: StartingChoices = {},
): Promise<FirstDraftResult> {
  if (!isRuntimeAssistant(profileName)) return { seeded: false, reason: `'${profileName}' is not an active runtime assistant` };
  if ((await activeVersionNumber(ssm, ssmRoot, profileName)) !== null) {
    return { seeded: false, reason: 'it has an active version; a new version clones that' };
  }
  const refused = await copySourceError(ssm, ssmRoot, from, classificationServedBy(profileName));
  if (refused) return { seeded: false, reason: refused };
  const source = await readActiveVersion(ssm, ssmRoot, from);
  if (!source) return { seeded: false, reason: `'${from}' has no active version to copy` };
  // THE SOURCE'S WORDS ARE ITS TEMPLATES, which stay in its own family; a retired `copy` it still carries is not copied.
  const { copy: _retired, welcome: retiredWelcome, ...sourceBody } = source.body;
  // A RETIRED `welcome` THE SOURCE STILL CARRIES is copied as the welcome workflows it becomes (W1), so the copy greets as
  // the source does and its first draft validates.
  if (retiredWelcome !== undefined && retiredWelcome !== null) {
    const carried = legacyWelcomePlan(retiredWelcome, sourceBody.eventWorkflows).eventWorkflows;
    if (Object.keys(carried).length) sourceBody.eventWorkflows = carried;
  }
  const body = withStartingChoices(ensureModelsBundle(sourceBody as typeof source.body), choices);
  const def = { ...buildDefinition(profileName, body), provenance: { createdFrom: { profileName: from, version: source.version } } };
  await putDefinition(ssm, draftParamName(ssmRoot, profileName), def);
  audit('copy-first-draft', actor, profileName, { configId: def.configId, from, fromVersion: source.version });
  return { seeded: true, configId: def.configId };
}

/** Why `from` cannot be copied into an assistant of `classification`, or null when it can. */
export async function copySourceError(ssm: SSMClient, ssmRoot: string, from: string, classification: string): Promise<string | null> {
  if (defaultProfileRegistry.roleOfAlt(from)) return `'${from}' is an alt's profile; it belongs to its experiment and is not copied`;
  if (!isKnownProfile(from)) return `'${from}' is not an assistant on this deployment`;
  const served = classificationServedBy(from);
  if (served !== classification) return `'${from}' answers in ${served}, not ${classification}; a copy stays in its classification`;
  if ((await activeVersionNumber(ssm, ssmRoot, from)) === null) return `'${from}' has no active version to copy`;
  return null;
}

/** Apply a behavioral patch to the draft (§4 edit-draft) — runtime-editable fields only; re-hashes configId. */
/** Keys a draft patch may not carry: a deploy or another capability changes them. */
export const DEPLOY_TIME_KEYS = ['classification', 'role', 'roles', 'grants', 'reach', 'ownerTeam'] as const;

export async function editDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  patchWithLayout: Partial<ProfileDefinitionBody> & { layout?: WorkflowLayout | null },
  actor: string,
): Promise<ProfileDefinition> {
  // THE CANVAS LAYOUT RIDES THE PATCH AND IS NO PART OF THE BODY (ADR-061 decision 7): checked for its shape alone, kept when
  // the patch does not name it, cleared by `null`, and never hashed or validated against what the workflows do.
  const { layout: patchedLayout, ...patch } = patchWithLayout;
  const layoutErrors = workflowLayoutErrors(patchedLayout);
  if (layoutErrors.length) throw new ProfileValidationError(layoutErrors);
  // WHAT ONLY A DEPLOY CHANGES IS REFUSED BY NAME, not dropped. Where an assistant runs (its classification
  // and role) and what that reaches are IAM, built at deploy from the deployment's profiles; ownership is the
  // `owner-team` tag, written by `manage-ownership` alone. The whitelist below would silently discard any of
  // them, and an operator who sent one would believe the assistant had moved.
  const deployOnly = DEPLOY_TIME_KEYS.filter((k) => k in (patch as Record<string, unknown>));
  if (deployOnly.length) {
    throw new ProfileValidationError(deployOnly.map((k) => (k === 'ownerTeam'
      ? 'ownerTeam is not part of a version: ownership is changed through manage-ownership, with a reason'
      : `${k} is not part of a version: it needs a deploy, because it changes IAM (docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md)`)));
  }
  // THE WORDS THE CONSOLE EDITS DIRECTLY ARE CHECKED AS SENT. `messages` and `eventWorkflows` have controls, so a
  // malformed one is refused here, naming the field, rather than stored and read as nothing at runtime; a `copy`
  // line is refused, because what an assistant says is its message templates (ADR-062), and a `welcome`, because the
  // welcome is the version's `assistant-joined` workflow (W1).
  // A TASK STEP'S MACHINE is checked against the machines the runtime runs (ADR-063), read only where the patch assigns one.
  const patchMachines = hasTaskStep((patch as { eventWorkflows?: unknown }).eventWorkflows)
    ? await deploymentTaskMachines(ssm, ssmRoot, profileName) : undefined;
  if (patchMachines && 'error' in patchMachines) throw new ProfileValidationError([patchMachines.error]);
  const shapeErrors = patchShapeErrors(patch, patchMachines ? { machines: patchMachines.machines } : {});
  if (shapeErrors.length) throw new ProfileValidationError(shapeErrors);
  const existing = (await getDraft(ssm, ssmRoot, profileName)) ?? buildDefinition(profileName, await activeOrSeedBody(ssm, ssmRoot, profileName));
  // A VERSION MAY NOT DEFINE A TASK WORKFLOW, AND THE REFUSAL HAS TO HAPPEN ON THE PATCH.
  //
  // EVENT WORKFLOWS ARE THE EXCEPTION, BY DECISION (ADR-061 decision 1, as built): `eventWorkflows` is the
  // assistant's own greeting and follow-up, so a version declares it and it is validated with the version
  // (`welcomeWorkflowErrors`). Task machines stay global and select-only.
  //
  // `bodyFrom` below is a whitelist and drops `machines`, so by the time the body validator runs
  // there is nothing left to object to - the edit would be accepted and the block silently
  // discarded. An operator who sent one meant something by it, so they are told where task graphs
  // live instead of watching a field refuse to stick.
  const patchedMachines = (patch as { machines?: Record<string, unknown> }).machines;
  if (patchedMachines !== undefined && Object.keys(patchedMachines ?? {}).length > 0) {
    throw new ProfileValidationError([
      'machines are global workflows and are not part of a version. They are defined by the platform '
      + "and by a classification's intent pack; a version SELECTS from them with `workflows`.",
    ]);
  }
  // Only runtime-editable keys from the patch are honored; unknown/boundary keys are ignored (§7).
  const mergedBody: ProfileDefinitionBody = bodyFrom({ ...bodyFrom(existing), ...patch });
  // ── NULL CLEARS A FIELD, because a merge alone cannot express "go back to the default" ──────────
  //
  // The patch is a spread, so an OMITTED key keeps whatever the draft already had. That is right for
  // a partial edit and it leaves no way to REMOVE a value: an assistant renamed once could never be
  // returned to its configured name, because clearing the console's name field sent no key and the
  // draft kept the old one. Absent and empty are already meaningfully different here (absent =
  // inherit, empty = a name nobody can address), so the third state gets the third spelling, the same
  // one JSON Merge Patch (RFC 7386) uses.
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete (mergedBody as unknown as Record<string, unknown>)[k];
  }
  // The transitional top-level `modelKey` and `models.default` are the SAME "base model" — keep them
  // consistent so resolution (`models.default ?? modelKey`) is unambiguous. A patch to either syncs both,
  // whether the editor edits the legacy `modelKey` or the new `models.default`.
  //
  // `!= null` rather than `!== undefined`: the clear-loop above has already deleted a key patched to
  // `null`, and re-syncing from that null would write it straight back as `models.default: null` -
  // a null that then hashes into `configId` and persists. The base model has no "clear" today (the
  // console never sends one), but the typed client advertises `null` for every body key, so the
  // reachable-but-wrong path is closed here rather than left to the caller to avoid.
  if (patch.modelKey != null) {
    mergedBody.models = { ...(mergedBody.models ?? {}), default: patch.modelKey };
  } else if (patch.models?.default != null) {
    mergedBody.modelKey = patch.models.default;
  }
  const errs = validateDefinitionBody(mergedBody, new Set(Object.keys(bodyFrom(existing).models?.byIntent ?? {})));
  if (errs.length) throw new ProfileValidationError(errs);
  // A STEP'S POINT FOLLOWS IT, and a removed step's point is dropped (`layoutFor`).
  const layout = layoutFor(patchedLayout === null ? undefined : patchedLayout ?? existing.layout, mergedBody.eventWorkflows);
  const def = { ...buildDefinition(profileName, mergedBody), ...(layout ? { layout } : {}) };
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
export function validateBody(
  body: Partial<ProfileDefinitionBody>,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  /** Routes the version already had - forwarded so validate and activate apply the same
   *  inherited-route rule the edit path does, rather than refusing at the next gate what the edit
   *  just accepted. */
  inheritedRoutes?: ReadonlySet<string>,
  /**
   * The classification the profile serves. When given, every model must be ALLOWED for it, not merely
   * in the catalog: the vend narrows an assistant's session from this definition (`assistant-grant.ts`),
   * so the definition is part of the boundary and a model the classification cannot reach is refused
   * here rather than denied at inference.
   */
  classification?: string,
): string[] {
  const errs = validateDefinitionBody(body, inheritedRoutes);
  // §7 model-ARN boundary: EVERY model a version selects — base, classifier, and each per-intent
  // primary/fallback — must resolve within the deployment's InvokeModel allowlist (the catalog). A version
  // picks WITHIN the boundary, never beyond it; an out-of-catalog model is a reject here, not an
  // AccessDenied at inference.
  // The `'default'` sentinel names no catalog model (it means "follow the classification default"), so it
  // is always in-bounds — skip the allowlist check for it.
  // `chosen` is a model the definition picks outright (its base model, default and classifier), which
  // must be allowed for the classification. A per-intent route is not held to that: routes start from the
  // platform's intent strategy, which names models some classifications cannot reach, and the resolver
  // degrades a disallowed route to the classification default by design.
  // EVERY MODEL A VERSION SELECTS IS ONE ITS CLASSIFICATION ALLOWS AND FIT FOR ITS USE (`modelFits`,
  // `lib/config/model-availability.ts`): the base model, the classifier and each per-intent route are
  // text models, the image model is an image model, and each is in the classification's catalog list.
  // Routes are held to it too: an assistant manager selects within what the classification allows, and a
  // seed preselects only what it allows, so a route naming any other model is a choice to refuse here.
  const checkModel = (mk: string | undefined, label: string) => {
    // AN ADAPTER OUTSIDE AWS IS NOT A MODEL A VERSION ANSWERS ON. `deepseek_api` is reached only by context
    // routing's external path, for a classification that selects it; named here it would be ignored and the
    // turn answered on the classification default, so it is refused with what it is.
    if (mk && mk !== DEFAULT_MODEL && modelKindOf(mk) === 'external') {
      errs.push(`${label} '${mk}' is an adapter outside AWS, reached only by context routing; a version answers on a Bedrock text model`);
    } else if (mk && mk !== DEFAULT_MODEL && !(mk in catalog)) {
      errs.push(`${label} '${mk}' is not in the deployment's model catalog (InvokeModel allowlist boundary, §7)`);
    } else if (mk && mk !== DEFAULT_MODEL && classification) {
      const why = modelFits(mk, classification, 'text');
      if (why) errs.push(`${label} ${why}; this assistant serves the ${classification} classification`);
    }
  };
  // THE DISPLAY NAME IS SHOWN TO PEOPLE AND SET ON A CHIME IDENTITY, so it is bounded on the way in
  // rather than at either of those. The rules live in `display-name.ts` because the applier that puts
  // the name onto the identity checks them again from a DIFFERENT Lambda: a name accepted here and
  // refused there would leave a version active and the bot still wearing the old name, which is the
  // split this work exists to close. Absent stays valid and means inherit; blank does not.
  errs.push(...displayNameErrors(body.displayName));
  checkModel(body.modelKey, 'modelKey');
  if (body.models) {
    checkModel(body.models.default, 'models.default');
    checkModel(body.models.classifier, 'models.classifier');
    for (const [intent, route] of Object.entries(body.models.byIntent ?? {})) {
      // AN IMAGE ROUTE (its primary is an image model) generates an image for its intent, whatever the intent
      // is called: both of its models are image models this classification allows.
      if (isImageRoute(route)) {
        for (const [mk, label] of [[route.primary, 'primary'], [route.fallback, 'fallback']] as const) {
          if (!mk || !classification) continue;
          const why = modelFits(mk, classification, 'image');
          if (why) errs.push(`models.byIntent['${intent}'].${label} ${why}; this assistant serves the ${classification} classification`);
        }
        continue;
      }
      // An intent that needs an image may name a text model too: its text steps (asking what to draw) run on it
      // (ADR-064 decision 2), and its image model is the route's image part, checked below.
      checkModel(route.primary, `models.byIntent['${intent}'].primary`);
      checkModel(route.fallback, `models.byIntent['${intent}'].fallback`);
    }
    // EVERY STEP OVERRIDE AND IMAGE PART is a model this classification selects and fit for its use (ADR-064 security
    // posture): an image model held to the image selection, a text model to the text catalog.
    for (const [intent, route] of Object.entries(body.models.byIntent ?? {})) {
      const parts: Array<[string | undefined, string]> = [];
      for (const [state, step] of Object.entries((route as IntentRoute).steps ?? {})) {
        parts.push([step?.primary, `models.byIntent['${intent}'].steps['${state}'].primary`], [step?.fallback, `models.byIntent['${intent}'].steps['${state}'].fallback`]);
      }
      const image = (route as IntentRoute).image;
      if (image) parts.push([image.primary, `models.byIntent['${intent}'].image.primary`], [image.fallback, `models.byIntent['${intent}'].image.fallback`]);
      for (const [mk, label] of parts) {
        if (!mk || mk === DEFAULT_MODEL) continue;
        if (isImageModelKey(mk)) {
          const why = classification ? modelFits(mk, classification, 'image') : null;
          if (why) errs.push(`${label} ${why}; this assistant serves the ${classification} classification`);
        } else {
          checkModel(mk, label);
        }
      }
    }
    // The legacy image field, read as the `image_generation` route's primary (`image-route.ts`).
    if (body.models.image !== undefined && classification) {
      const why = modelFits(body.models.image, classification, 'image');
      if (why) errs.push(`models.image ${why}; this assistant serves the ${classification} classification`);
    }
    // AN IMAGE MODEL HOSTED OUTSIDE AWS is allowed exactly where its classification selects it (`modelFits`
    // above), which is also where its stack holds the provider's key: the version enables nothing.
  }

  // Measure what would be STORED, not what was submitted: on a deployment with a body store the persona
  // moves to S3 and stops counting against the parameter, so measuring it here would reject a persona
  // that saves perfectly well. The pointer that replaces it costs about 90 characters, which this does
  // not add back - a deliberate slack, since the load-bearing check is the one `putDefinition` runs on
  // the exact bytes it is about to send, and that one reports just as precisely.
  // Both bodies move to S3 when a store is configured, so neither counts against the parameter. Leaving
  // `intentPack` in this measurement would reject a taxonomy that stores perfectly well - and would do it
  // precisely on the deployments that migrated, which is backwards.
  const tooBig = storageBoundaryError(
    bodyBucket() ? { ...body, persona: undefined, intentPack: undefined } : body,
  );
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
  const serialized = ssmJsonValue(value).length;
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
 * ROUTES CHECKED AGAINST THE DEPLOYMENT PACK, for a version that carries no pack of its own.
 *
 * `validateDefinitionBody` reconciles `models.byIntent` against the version's OWN `intentPack`, and can
 * do no more than that because it is pure - the deployment taxonomy is an SSM parameter. This is the
 * other half, and it exists because the half that was missing is what let a route to an intent nobody
 * recognized publish, activate, never fire, and answer every such turn as `general` with nothing logged.
 *
 * READ PER PROFILE, not from `getIntentPack()`. The module-level accessor answers from
 * `ASSISTANT_INTENT_PACK_PARAM`, which this Lambda does not set and could not set meaningfully: the pack
 * is PER CLASSIFICATION and this handler edits any profile. Calling it here would validate every
 * deployment's routes against the platform DEFAULT taxonomy and refuse the domain intents that are the
 * whole reason a deployment writes a pack. The role already grants `ssm:GetParameter` on
 * `{SSM_ROOT}/assistant/*`, so the specific parameter is readable without a new grant.
 *
 * SILENT ON AN UNREADABLE PARAMETER, deliberately, and this is the opposite call from
 * `contextSelectionErrors` above. An absent pack parameter is the NORMAL state - it means the deployment
 * runs the platform default taxonomy - so it cannot be treated as "unverifiable, refuse". A version that
 * carries its own pack never reaches here at all.
 */
/**
 * The `byIntent` routes the ACTIVE version already serves - the baseline an edit inherits.
 *
 * Read from what is SERVING rather than from the draft: a draft is cloned from active, so using the
 * draft as its own baseline would excuse every route it contains including ones just added.
 */
export async function activeRouteKeys(ssm: SSMClient, ssmRoot: string, profileName: string): Promise<Set<string>> {
  try {
    const active = await activeOrSeedBody(ssm, ssmRoot, profileName);
    return new Set(Object.keys(active.models?.byIntent ?? {}));
  } catch {
    // No active version, or unreadable. An empty baseline inherits nothing, so every unreachable
    // route is treated as newly introduced - the strict reading, which is the safe direction.
    return new Set();
  }
}

/**
 * Errors for a workflow SELECTION naming a graph this deployment does not have.
 *
 * The available set is the platform's task graphs plus whatever the CLASSIFICATION's intent pack adds
 * - the same two layers the runtime resolves. A key outside it would be a workflow the assistant can
 * never open, which is the identical failure `deploymentRouteErrors` exists to refuse for routes: it
 * does not break anything, it simply never fires, and an operator is left reading a selection that
 * looks configured and does nothing.
 *
 * Absent selection ⇒ every available workflow, so nothing to check.
 */
/** Whether a body's event workflows assign a task, the one case that needs the classification's machines read. */
export function hasTaskStep(eventWorkflows: unknown): boolean {
  return !!eventWorkflows && typeof eventWorkflows === 'object'
    && Object.values(eventWorkflows as Record<string, { states?: Record<string, { task?: unknown }> }>).some((wf) => Object.values(wf?.states ?? {}).some((d) => d?.task !== undefined));
}

/**
 * THE TASK MACHINES THE RUNTIME RUNS FOR AN ASSISTANT (ADR-063 decision 1): its classification's intent pack merged over the
 * platform's (`taskStateMachines`), read from the parameter and body the router and the task service hydrate from
 * (`hydrateIntentPackFromSsm`), by the read `workflowSelectionErrors` already makes. An absent pack is the platform's set;
 * any other failure is a refusal that names it, never the platform's set standing in for a pack nobody could read.
 */
export async function deploymentTaskMachines(
  ssm: SSMClient, ssmRoot: string, profileName: string,
): Promise<{ machines: Record<string, TaskStateMachine> } | { error: string }> {
  let raw: string | undefined;
  try {
    const classification = classificationServedBy(profileName);
    const got = await ssm.send(new GetParameterCommand({ Name: `${ssmRoot}/assistant/${classification}/assistant-intent-pack` }));
    raw = await resolvePackParameterValue(got.Parameter?.Value, classification);
  } catch (err) {
    if ((err as { name?: string })?.name !== 'ParameterNotFound') {
      return { error: `eventWorkflows assigns a task, and the task machines of this assistant's classification could not be read (${(err as { name?: string })?.name ?? 'error'}); try again` };
    }
  }
  return { machines: taskStateMachines(parseIntentPack(raw)) };
}

/**
 * THE STEP OVERRIDES OF A VERSION'S ROUTES, checked against the machines the runtime runs (ADR-064 decision D): each names
 * a state of its intent's workflow and a model of the kind the step produces. The machines are read only where a route
 * overrides a step. Returned structured, so the console anchors each to the card and step it names.
 */
export async function stepModelErrorDetails(body: Partial<ProfileDefinitionBody>, ssm: SSMClient, ssmRoot: string, profileName: string): Promise<RouteError[]> {
  const routes = Object.entries(body.models?.byIntent ?? {}).filter(([, r]) => r && typeof r === 'object' && (r as IntentRoute).steps);
  if (!routes.length) return [];
  const read = await deploymentTaskMachines(ssm, ssmRoot, profileName);
  if ('error' in read) return [{ code: 'machines_unreadable', path: 'models.byIntent', message: read.error.replace('eventWorkflows assigns a task', 'a route overrides a step') }];
  return routes.flatMap(([intent, route]) => stepRouteErrors(intent, route as IntentRoute, read.machines[intent]));
}

/**
 * A WORKFLOW'S REQUIRED TOOL IS ONE THE VERSION ALLOWS (ADR-064 decision 3): a version whose `tools` omit a tool a step of
 * a workflow it selects requires is refused, naming both, so no task can be left in a step it cannot leave. Read only
 * where the version narrows its tools.
 */
export async function requiredToolErrors(body: Partial<ProfileDefinitionBody>, ssm: SSMClient, ssmRoot: string, profileName: string): Promise<string[]> {
  return (await requiredToolErrorDetails(body, ssm, ssmRoot, profileName)).map((e) => e.message);
}

/** The same refusals, structured: each anchored to the workflow step that requires the tool (`workflows['<m>'].steps['<s>'].requiresTool`). */
export async function requiredToolErrorDetails(body: Partial<ProfileDefinitionBody>, ssm: SSMClient, ssmRoot: string, profileName: string): Promise<RouteError[]> {
  if (!Array.isArray(body.tools)) return [];
  const read = await deploymentTaskMachines(ssm, ssmRoot, profileName);
  if ('error' in read) return [];
  const allowed = new Set(body.tools);
  const selected = Array.isArray(body.workflows) ? body.workflows : Object.keys(read.machines);
  const errs: RouteError[] = [];
  for (const name of selected) {
    for (const [state, def] of Object.entries(read.machines[name]?.states ?? {})) {
      for (const t of def.requiresTool ?? []) {
        if (allowed.has(t)) continue;
        errs.push({
          code: 'required_tool_not_allowed', path: `workflows['${name}'].steps['${state}'].requiresTool`, params: { workflow: name, state, tool: t },
          message: 'the `' + name + '` workflow requires `' + t + '` at `' + state + "`, and this version's tools do not include it; add it to tools or stop selecting `" + name + '`',
        });
      }
    }
  }
  return errs;
}

/**
 * THE ROUTE REFUSALS OF A VERSION'S `models`, STRUCTURED (ADR-064 decision 5): a retired route key, the retired
 * `models.image`, and a route that mixes kinds, each with the code, path and params the console anchors and renders it
 * by. The same checks `validateBody` makes, read from the same functions, so the flat list and these never disagree.
 */
export function routeErrorDetails(models: ProfileDefinitionBody['models'] | undefined): RouteError[] {
  const errs: RouteError[] = [];
  if (!models || typeof models !== 'object') return errs;
  if ((models as { image?: unknown }).image !== undefined) {
    errs.push({ code: 'legacy_image_field', path: 'models.image', params: { intent: IMAGE_ROUTE_KEY }, message: "models.image is retired; name the image model as models.byIntent['image_generation'].image.primary" });
  }
  const byIntent = models.byIntent;
  if (!byIntent || typeof byIntent !== 'object') return errs;
  for (const [intent, route] of Object.entries(byIntent)) {
    const path = `models.byIntent['${intent}']`;
    const retired = retiredRouteKeyError(intent, path);
    if (retired) { errs.push({ code: 'retired_route_key', path, params: { intent, now: RETIRED_ROUTE_KEYS[intent] }, message: retired }); continue; }
    if (!route || typeof route !== 'object') continue;
    const kind = routeKindErrorDetail(intent, route as never);
    if (kind) errs.push(kind);
  }
  return errs;
}

/** Each event-workflow check that needs the runtime's machines, read only where a step assigns a task. */
async function workflowErrorsWithMachines(body: ProfileDefinitionBody, ssm: SSMClient, ssmRoot: string, profileName: string): Promise<string[]> {
  if (!hasTaskStep(body.eventWorkflows)) return welcomeWorkflowErrors(body);
  const read = await deploymentTaskMachines(ssm, ssmRoot, profileName);
  return 'error' in read ? [read.error] : welcomeWorkflowErrors(body, read.machines);
}

/**
 * A VERSION'S `confirmBrief` NAMES WORKFLOWS WITH A CONFIRMED STEP (ADR-064 decision G): each key a workflow the runtime
 * runs whose step declares `confirm`, and `when-incomplete` only where that step declares its `brief`. Read only where the
 * version sets it; an unreadable pack is a refusal that names it, as a step override's is.
 */
export async function versionConfirmBriefErrors(body: Partial<ProfileDefinitionBody>, ssm: SSMClient, ssmRoot: string, profileName: string): Promise<string[]> {
  if (body.confirmBrief === undefined) return [];
  const read = await deploymentTaskMachines(ssm, ssmRoot, profileName);
  if ('error' in read) return [read.error.replace('eventWorkflows assigns a task', 'confirmBrief names a workflow')];
  return confirmBriefErrors(body.confirmBrief, read.machines);
}

export async function workflowSelectionErrors(
  body: Partial<ProfileDefinitionBody>,
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
): Promise<string[]> {
  const selected = body.workflows;
  if (!selected?.length) return [];
  let raw: string | undefined;
  try {
    const classification = classificationServedBy(profileName);
    const got = await ssm.send(new GetParameterCommand({
      Name: `${ssmRoot}/assistant/${classification}/assistant-intent-pack`,
    }));
    raw = await resolvePackParameterValue(got.Parameter?.Value, classification);
  } catch {
    // No pack ⇒ the platform graphs are the whole available set, which is a real answer.
  }
  const available = new Set(Object.keys(taskStateMachines(parseIntentPack(raw))));
  const unknown = selected.filter((w) => !available.has(w));
  return unknown.map((w) => (
    `workflows['${w}'] names no workflow this deployment has, so the assistant could never open it; `
    + `available: ${[...available].sort().join(', ') || '(none)'}. Task graphs are global - a `
    + 'classification adds its own on its intent pack, and a version selects from what exists.'
  ));
}

/**
 * Errors for a version-carried intent pack that leaves the assistant unable to open work.
 *
 * ON THE WRITE PATH ONLY, and that placement is the point. The first version of this check sat in
 * `validateDefinitionBody`, which also runs when a stored version is READ - and a failure there fails
 * closed to the compiled seed. A version stored before this rule would have had its persona, models,
 * tools and name discarded on the next turn over a taxonomy question, with no operator present. The
 * same file already carries that lesson about `machines`: a narrowing must not be able to delete a
 * configuration.
 *
 * A pack WITHOUT `extends: "default"` replaces the platform taxonomy, so one that also declares no
 * work-management intent produces an assistant that cannot classify a request as work at all - no
 * multi-step task, no queue drain, nothing failing, every turn answered as a one-shot reply.
 *
 * Refused rather than repaired: the pack is authored, and adding to it would overrule the author to
 * deliver a guarantee they can be told about instead.
 */
export function workIntentErrors(body: Partial<ProfileDefinitionBody>): string[] {
  const pack = body.intentPack as { intents?: Array<{ key: string }>; extends?: string } | undefined;
  if (!pack?.intents?.length) return [];
  if (pack.extends === 'default') return [];
  if (canOpenWork(pack.intents)) return [];
  return [
    'this intent pack REPLACES the platform taxonomy (no `extends: "default"`) and declares no '
    + 'work-management intent, so the assistant could never open a tracked task. Declare one of '
    + `${WORK_MANAGEMENT_INTENT_KEYS.join(', ')}, or set extends:"default" to inherit them.`,
  ];
}
/**
 * A MINIMUM THE SET COULD NEVER HOLD is refused where the version is checked (ADR-065 decision 6): `minRegressionPerIntent`
 * applies to every intent of the pack the version serves, and the set holds at most `GOLDEN_SET_CAPACITY` live entries, so
 * a minimum past that would refuse every later draft, and the minimum is the active version's, so no draft could lower it.
 */
export async function goldenSetReachErrors(
  body: Pick<ProfileDefinitionBody, 'goldenSet' | 'intentPack'>,
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
): Promise<string[]> {
  const min = body.goldenSet?.minRegressionPerIntent;
  if (!min) return [];
  const intents = body.intentPack
    ? intentKeysOf(body.intentPack).size
    : parseIntentPack(await deploymentPackRaw(ssm, ssmRoot, profileName)).intents.length;
  if (min * intents <= GOLDEN_SET_CAPACITY) return [];
  return [`goldenSet.minRegressionPerIntent of ${min} across the ${intents} intents this version serves needs ${min * intents} regression entries; the golden set holds at most ${GOLDEN_SET_CAPACITY}`];
}

export async function deploymentRouteErrors(
  body: Partial<ProfileDefinitionBody>,
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  /**
   * Routes the body ALREADY HAD before this edit. They are reported but do not block.
   *
   * WHY INHERITING AN UNREACHABLE ROUTE MUST NOT BE FATAL. The rule exists to stop someone routing an
   * intent that can never fire. Applied to the whole merged body it also punishes an editor for a
   * route they did not write: a deployment whose intent pack NARROWS after its profiles were seeded
   * has every profile carrying routes the pack no longer declares, so every subsequent edit is
   * refused and the profile becomes permanently uneditable - including edits that would remove the
   * offending routes. Measured on a deployment running the demo pack, where the seeded
   * `code_generation`/`code_review`/`strategic_analysis` routes blocked renaming an assistant.
   *
   * An inherited unreachable route is also HARMLESS at runtime: it never fires, because nothing
   * classifies to it. A newly INTRODUCED one is the mistake worth refusing, and still is.
   */
  inheritedRoutes?: ReadonlySet<string>,
): Promise<string[]> {
  const routes = Object.keys(body.models?.byIntent ?? {});
  if (!routes.length || body.intentPack !== undefined) return [];
  const raw = await deploymentPackRaw(ssm, ssmRoot, profileName);
  // A route is keyed by the intent it serves (ADR-064 decision 1), so a route fires when the pack can classify its key.
  const reachable = new Set<string>([
    ...intentKeysOf(parseIntentPack(raw)), ...UNIVERSAL_INTENT_KEYS,
    // A standalone greeting or acknowledgment may have a route of its own (`resolveModelForIntent`).
    ...TRIVIAL_ROUTE_KEYS,
  ]);
  return routes
    .filter((intent) => !reachable.has(intent as RouteKey))
    // Inherited ⇒ reported by the runtime's own reachability note, not refused here.
    .filter((intent) => !inheritedRoutes?.has(intent))
    .map((intent) => (
      `models.byIntent['${intent}'] routes a key no intent the deployment pack for '${profileName}' can `
      + `classify resolves to, so it would never fire; reachable routes: ${[...reachable].sort().join(', ') || '(none)'}. `
      + "Add the intent to this version's own intentPack, or drop the route - as written the turn would "
      + 'answer on the base model with nothing logged.'
    ));
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

/**
 * EACH TEMPLATE A VERSION'S `messages` NAMES IS ACTIVE IN THE ASSISTANT'S FAMILY AND FITS ITS MESSAGE (ADR-062
 * decision 3). Read from the store, so a mapping to a template nobody saved, or one asking for a value the
 * message's call site does not supply, is refused before the version serves rather than passed over at a send.
 */
export async function messageTemplateErrors(
  body: ProfileDefinitionBody,
  profileName: string,
  deps?: import('./template-store.js').TemplateStoreDeps,
): Promise<string[]> {
  const entries = Object.entries(body.messages ?? {});
  if (!entries.length) return [];
  const shape = messagesShapeErrors(body.messages);
  if (shape.length) return shape;
  const classification = servedClassification(profileName);
  if (!classification) return [`messages cannot be checked: '${profileName}' serves no classification this deployment declares`];
  const [{ loadTemplate }, { shippedMessageTemplate }, { storedTemplateMisfit }] = await Promise.all([
    import('./template-store.js'), import('./shipped-message-templates.js'), import('./message-template.js'),
  ]);
  const [{ messageEntryNames }, { messageAudience: audienceOf }, variables] = await Promise.all([
    import('./message-template.js'), import('./shipped-message-templates.js'), import('./variables.js'),
  ]);
  // A MESSAGE'S CONDITIONS ARE HELD TO ADR-060 decision 3 (`whenErrors`), read through the version's variables. A key
  // that reads the classification's catalog is held where the catalog is read (`versionConditionErrors`).
  const lookup = variables.withUnreadCatalog(variables.versionLookup(
    variables.buildSourceTable({ catalog: [], classifications: defaultProfileRegistry.classificationValues() }), body.variables,
  ), body.variables);
  const errors: string[] = [];
  for (const [message, entry] of entries) {
    const shipped = shippedMessageTemplate(message);
    if (Array.isArray(entry)) {
      entry.forEach((c, i) => {
        if (c.when !== undefined) {
          errors.push(...variables.whenErrors(c.when, lookup, { selects: audienceOf(message), catalog: 'deferred' }).map((e) => `messages.${message}[${i}].when: ${e}`));
        }
      });
    }
    for (const name of messageEntryNames(entry)) {
      try {
        const loaded = await loadTemplate(classification, { name }, deps, { owner: { family: 'assistant', assistant: profileName }, kind: shipped.kind ?? 'message' });
        const misfit = storedTemplateMisfit(loaded.template, shipped);
        if (misfit) errors.push(`messages.${message} names "${name}", which does not fit it: ${misfit}`);
      } catch (err) {
        errors.push(`messages.${message} names "${name}", which is not an active template of this assistant: ${(err as Error).message.replace(/^\[TemplateStore\] /, '')}`);
      }
    }
  }
  return errors;
}

/**
 * THE TOOLS OF AN AGENT STEP THAT ARE THIS ASSISTANT'S OWN: every tool of a step it takes itself, and none of a step that
 * names `as`, which the assistant holding that role takes with its own tools and grants (tenet D1). A welcome's prompt
 * step is the assistant's own turn, so its tools are its own.
 */
function stepToolsOwn(def: { agent?: { tools?: string[]; as?: { role: string } }; prompt?: { tools?: string[] } } | undefined): string[] {
  if (def?.prompt) return def.prompt.tools ?? [];
  return def?.agent && !def.agent.as ? def.agent.tools ?? [] : [];
}

/** THE WORKFLOWS A VERSION RUNS: its own, each selected by its event (W1). Each is read by the warnings below. */
function workflowsRunBy(body: ProfileDefinitionBody): Array<[string, EventWorkflow]> {
  return Object.entries((body.eventWorkflows ?? {}) as Record<string, EventWorkflow>);
}

/**
 * A STEP ANOTHER ASSISTANT TAKES, WHERE NONE COULD (ADR-061 decision 1, "Whose workflow runs"): each agent step naming
 * `as: { role }` that this deployment's classification does not declare. Never a refusal: a role can be added to a
 * running deployment (`add-assistant-role`), and until an assistant holding it is in the room the step reads nothing,
 * says its `absent` message and takes its failure edge.
 */
export function stepRoleWarnings(body: ProfileDefinitionBody, declaredRoles: readonly string[]): string[] {
  const out: string[] = [];
  for (const [name, wf] of workflowsRunBy(body)) {
    for (const [step, def] of Object.entries(wf?.states ?? {})) {
      const role = def?.agent?.as?.role;
      if (role && !declaredRoles.includes(role)) {
        out.push(`eventWorkflows.${name}, whose step ${step} is taken by the ${role} assistant, which this deployment does not declare for the classification; until one is in the room the step reads nothing and says its absent message`);
      }
      // A TASK WORKED BY AN ASSISTANT ROLE (ADR-063 decision 1), held to the same rule as `as`: said, never refused.
      const worker = workerAssistantRole(def?.task?.by);
      if (worker && !declaredRoles.includes(worker)) {
        out.push(`eventWorkflows.${name}, whose step ${step} assigns its task to the ${worker} assistant, which this deployment does not declare for the classification; until one is in the room the task is not opened and the step takes its failure edge`);
      }
    }
  }
  return out;
}

/**
 * WORK ASSIGNED TO AN ASSISTANT WHERE NO IDLE ASSISTANT TAKES IT UP (ADR-063 decision H1). Idle is read from the turn lock,
 * so where the turn queue is off a task step's assistant work runs its first step and every later step waits for a
 * message in the room. Said beside the result, never refused.
 */
export function pickupWarnings(body: ProfileDefinitionBody, turnQueueOn = process.env.TURN_QUEUE_ENABLED === '1'): string[] {
  if (turnQueueOn) return [];
  const out: string[] = [];
  for (const [name, wf] of workflowsRunBy(body)) {
    for (const [step, def] of Object.entries(wf?.states ?? {})) {
      if (!def?.task) continue;
      const toAssistant = def.task.by === undefined || workerAssistantRole(def.task.by) !== undefined;
      if (toAssistant) out.push(`eventWorkflows.${name}, whose step ${step} assigns its task to an assistant: the turn queue is off in this deployment, so the assistant runs the task's first step and every later step waits for a message in the room`);
    }
  }
  return out;
}

/**
 * WHAT A VERSION'S WORKFLOWS MAY RUN (W1, ADR-061). Each event selects its own workflow, the welcome on `assistant-joined`
 * by the room's conversation type, so a version declares only workflows an event selects (their shape and the one
 * welcome per kind of room are `versionEventWorkflowsErrors`). An agent step's and a prompt step's tools are the
 * assistant's own, and a task an agent step opens is one this version offers.
 */
export function welcomeWorkflowErrors(body: ProfileDefinitionBody, machines?: Readonly<Record<string, TaskStateMachine>>): string[] {
  const own = body.eventWorkflows ?? {};
  // A TASK STEP OPENS A MACHINE THE RUNTIME RUNS (ADR-063 decision 1): the classification's pack merged over the
  // platform's (`deploymentTaskMachines`), the set the router and the task service resolve. Absent, the platform's.
  const errors: string[] = [...versionEventWorkflowsErrors(body.eventWorkflows, machines ? { machines } : {})];
  const tools = new Set(body.tools ?? []);
  if (body.tools) {
    for (const [name, wf] of Object.entries(own)) {
      for (const [step, def] of Object.entries(wf?.states ?? {})) {
        for (const t of stepToolsOwn(def)) {
          if (!tools.has(t)) errors.push(`eventWorkflows.${name}, whose step ${step} uses ${t}, which this assistant's tools do not include`);
        }
      }
    }
  }
  // A TASK AN AGENT STEP OPENS IS ONE THIS VERSION OFFERS (ADR-061 decision 8): where the version selects its task
  // workflows, the step's `workflow:` is among them, so the task it opens is one its later turns know.
  const selection = Array.isArray((body as { workflows?: unknown }).workflows) ? (body as { workflows: string[] }).workflows : [];
  if (selection.length) {
    for (const [name, wf] of Object.entries(own)) {
      for (const [step, def] of Object.entries(wf?.states ?? {})) {
        const machine = def?.agent?.workflow ?? def?.task?.machine;
        if (machine && !selection.includes(machine)) errors.push(`eventWorkflows.${name}, whose step ${step} opens a ${machine} task, which this version's workflows do not include`);
      }
    }
  }
  return [...new Set(errors)];
}

/**
 * EVERY TEMPLATE A VERSION'S OWN WORKFLOW NAMES EXISTS AND FITS ITS STEP: a send's message, an agent step's prompt
 * and its fallback's message, the assistant's own, its classification's, or a shipped one of that kind.
 */
export async function eventWorkflowTemplateErrors(
  body: ProfileDefinitionBody,
  profileName: string,
  deps?: import('./template-store.js').TemplateStoreDeps,
): Promise<string[]> {
  const own = body.eventWorkflows ?? {};
  if (!Object.keys(own).length) return [];
  const classification = servedClassification(profileName);
  if (!classification) return [`eventWorkflows cannot be checked: '${profileName}' serves no classification this deployment declares`];
  const [{ loadNamedTemplate }, { shippedMessageTemplates }] = await Promise.all([
    import('./message-template-selection.js'), import('./shipped-message-templates.js'),
  ]);
  const shipped = shippedMessageTemplates();
  const errors: string[] = [];
  for (const [name, wf] of Object.entries(own)) {
    if (!wf?.states) continue;
    for (const t of templatesNamedBy(wf)) {
      // A shipped template of the kind the step needs exists wherever the version lands; only another name reads the store.
      if ((shipped.get(t.name)?.template.kind ?? 'message') === t.kind && shipped.has(t.name)) continue;
      if (!(await loadNamedTemplate({ classification, assistant: profileName, name: t.name }, t.kind, deps))) {
        errors.push(`eventWorkflows.${name}.states.${t.at} names "${t.name}", which is not a ${t.kind} template the platform ships, this assistant holds, or its classification holds`);
      }
    }
  }
  return errors;
}

/**
 * THE INTAKE THE CLASSIFICATION'S DEPLOYMENT SEAM DECLARES (`<root>/assistant/<classification>/onboarding-intake`),
 * or null when it declares none. Any read failure but an absent parameter throws, so a caller that needs the
 * declared fields fails closed rather than reading "no intake".
 */
async function deploymentIntakeOf(ssm: SSMClient, ssmRoot: string, classification: string): Promise<IntakeConfig | null> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${ssmRoot}/assistant/${classification}/onboarding-intake` }));
    return res.Parameter?.Value ? parseIntakeConfig(res.Parameter.Value) : null;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return null;
    throw err;
  }
}

/**
 * EACH VARIABLE A VERSION NAMES READS A SOURCE ITS CLASSIFICATION PUBLISHES (ADR-060 decision 1, decision 3's first
 * layer), with a fallback that fits the source's type. The table is built from what the classification publishes:
 * its context-source catalog with each entry's trust, the classifications the deployment declares (clearance is a
 * set of them), and, for a `fact:` variable, the fields the version's own intake and its classification's intake
 * declare. An unreadable catalog or intake refuses the version rather than letting an unverified variable through.
 */
export async function versionVariableErrors(
  body: Partial<ProfileDefinitionBody>,
  profileName: string,
  ssm: SSMClient,
  ssmRoot: string,
  readCatalog?: (profileName: string) => Promise<Array<{ key: string }>>,
): Promise<string[]> {
  const variables = body.variables;
  if (variables === undefined || variables === null) return [];
  const shape = versionVariablesShapeErrors(variables);
  if (shape.length || !Object.keys(variables).length) return shape;
  const classification = servedClassification(profileName);
  if (!classification) return [`variables cannot be checked: '${profileName}' serves no classification this deployment declares`];
  const kinds = new Set(Object.values(variables).map((v) => sourceKindOf(v.source)));
  let catalog: ReturnType<typeof catalogEntryForVariables>[] = [];
  if (kinds.has('ctx')) {
    if (!readCatalog) return ['variables name a ctx: source, and no context source catalog was given to check it against'];
    try {
      catalog = (await readCatalog(profileName)).map((e) => catalogEntryForVariables(e as VariableCatalogEntry));
    } catch (err) {
      return [`the context source catalog for '${profileName}' could not be read (${(err as Error).message}); refusing a version whose variables cannot be verified`];
    }
  }
  let facts: string[] | undefined;
  if (kinds.has('fact')) {
    try {
      facts = intakeFactKeys([body.onboarding, await deploymentIntakeOf(ssm, ssmRoot, classification)]);
    } catch (err) {
      return [`the onboarding intake for '${classification}' could not be read (${(err as Error).message}); refusing a version whose fact: variables cannot be verified`];
    }
  }
  const table = buildSourceTable({ catalog, classifications: defaultProfileRegistry.classificationValues(), facts });
  return versionVariablesErrors(variables, table);
}

/**
 * A VERSION'S `ctx:` CONDITIONS, HELD AGAINST WHAT ITS CLASSIFICATION'S CATALOG PUBLISHES (ADR-060 decision 3, first
 * layer). A routing rule (`models.routing`) and a `messages` entry may decide on a context-source field, by name or
 * through one of the version's variables; the checks made without the catalog (`routingRuleErrors`,
 * `messageTemplateErrors`) leave those keys here. The catalog is read only when a condition names one, through the
 * reader `versionVariableErrors` uses, so no grant is added. A field the catalog does not publish, publishes as member
 * text, or types against the operator is refused, naming the rule or the entry; an unreadable catalog refuses the
 * version rather than letting an unverified condition through.
 */
export async function versionConditionErrors(
  body: Partial<ProfileDefinitionBody>,
  profileName: string,
  readCatalog?: (profileName: string) => Promise<Array<{ key: string }>>,
): Promise<string[]> {
  const classifications = defaultProfileRegistry.classificationValues();
  const routing = Array.isArray(body.models?.routing) ? body.models!.routing : [];
  const messages = body.messages && typeof body.messages === 'object' ? Object.entries(body.messages) : [];
  // What each condition is checked against, before the catalog is read: a routing rule names sources, a message entry
  // names sources or the version's variables.
  const fixed = buildSourceTable({ catalog: [], classifications });
  const routeLookup = withUnreadCatalog(sourceLookup(fixed));
  const messageLookup = withUnreadCatalog(versionLookup(fixed, body.variables), body.variables);
  const routeWhens = routing.flatMap((r, i) => (r && typeof r === 'object' && r.when !== undefined && whenReadsCatalog(r.when, routeLookup) ? [{ i, when: r.when }] : []));
  const messageWhens = messages.flatMap(([message, entry]) => (Array.isArray(entry)
    ? entry.flatMap((c: { when?: unknown }, i: number) => (c && c.when !== undefined && whenReadsCatalog(c.when, messageLookup) ? [{ message, i, when: c.when }] : []))
    : []));
  if (!routeWhens.length && !messageWhens.length) return [];
  if (!readCatalog) return ['a condition names a ctx: source, and no context source catalog was given to check it against'];
  let catalog: ReturnType<typeof catalogEntryForVariables>[];
  try {
    catalog = (await readCatalog(profileName)).map((e) => catalogEntryForVariables(e as VariableCatalogEntry));
  } catch (err) {
    return [`the context source catalog for '${profileName}' could not be read (${(err as Error).message}); refusing a version whose conditions cannot be verified`];
  }
  const table = buildSourceTable({ catalog, classifications });
  const { messageAudience: audienceOf } = await import('./shipped-message-templates.js');
  return [
    ...routeWhens.flatMap(({ i, when }) => whenErrors(when, sourceLookup(table), { selects: 'room', catalog: 'only' })
      .map((e) => `models.routing[${i}].when: ${e}`)),
    ...messageWhens.flatMap(({ message, i, when }) => whenErrors(when, versionLookup(table, body.variables), { selects: audienceOf(message), catalog: 'only' })
      .map((e) => `messages.${message}[${i}].when: ${e}`)),
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
): Promise<{ errors: string[]; configId?: string; warnings?: string[]; errorDetails?: RouteError[] }> {
  const draft = await getDraft(ssm, ssmRoot, profileName);
  if (!draft) return { errors: ['no draft to validate'] };
  const body = bodyFrom(draft);
  // The routes the ACTIVE version already serves: inherited, so not this edit's doing.
  const inherited = await activeRouteKeys(ssm, ssmRoot, profileName);
  // THE REFUSALS THE CONSOLE ANCHORS TO A CARD OR STEP, read once and returned beside the flat list (ADR-064 decision 5).
  const stepDetails = await stepModelErrorDetails(body, ssm, ssmRoot, profileName);
  const toolDetails = await requiredToolErrorDetails(body, ssm, ssmRoot, profileName);
  const errorDetails = [...routeErrorDetails(body.models), ...stepDetails, ...toolDetails];
  const errors = [
    ...validateBody(body, catalog, inherited, servedClassification(profileName)),
    ...retiredCopyErrors(body.copy),
    ...retiredWelcomeErrors(body.welcome),
    ...(await deploymentRouteErrors(body, ssm, ssmRoot, profileName, inherited)),
    ...(await goldenSetReachErrors(body, ssm, ssmRoot, profileName)),
    ...(await workflowSelectionErrors(body, ssm, ssmRoot, profileName)),
    ...(await versionConfirmBriefErrors(body, ssm, ssmRoot, profileName)),
    ...workIntentErrors(body),
    ...(await contextSelectionErrors(body, profileName, readContextCatalog)),
    ...(await guardrailSelectionErrors(body, profileName, readGuardrailCatalog)),
    ...(await messageTemplateErrors(body, profileName)),
    ...(await workflowErrorsWithMachines(body, ssm, ssmRoot, profileName)),
    ...stepDetails.map((e) => e.message),
    ...toolDetails.map((e) => e.message),
    ...(await eventWorkflowTemplateErrors(body, profileName)),
    ...(await versionVariableErrors(body, profileName, ssm, ssmRoot, readContextCatalog)),
    ...(await versionConditionErrors(body, profileName, readContextCatalog)),
  ];
  // A WORKFLOW WITH NO `types` NAMING A PARTICIPANT ROLE is not refused, because it runs in every type; the types where
  // the role addresses nobody are said beside the result (ADR-061 decision 1).
  const classification = servedClassification(profileName);
  const warnings = [
    ...Object.entries(body.eventWorkflows ?? {}).flatMap(([name, wf]) => eventWorkflowRoleWarnings(name, wf as EventWorkflow, body.variables)),
    // A STEP ANOTHER ASSISTANT TAKES, by a role this classification does not declare: said, never refused.
    ...(classification ? stepRoleWarnings(body, defaultProfileRegistry.rolesFor(classification)) : []),
    ...pickupWarnings(body),
  ];
  return { errors, configId: draft.configId, ...(warnings.length ? { warnings } : {}), ...(errorDetails.length ? { errorDetails } : {}) };
}

/** Promote the draft to a new active version (§4 activate): validate → PutParameter → move `active`. */
/**
 * REPUBLISH WHAT PEERS MAY READ, wherever a version becomes active.
 *
 * Called from both activation paths rather than from one, because activation is the moment what an
 * assistant recognizes changes for everybody and a label move is as much an activation as a draft
 * promotion. A projection written on only one of them would be correct until the first rollback.
 *
 * FROM THE VERSION'S OWN STORED PACK. An inheriting version advertises nothing, which is the rule that
 * keeps a primary from routing to a peer no more specialized than itself.
 *
 * NEVER FAILS AN ACTIVATION. A behavior edit must not depend on a routing projection: a failed write
 * leaves the previous advertisement standing, so a roommate may be offered a capability since withdrawn
 * and the specialist then classifies the handed-over turn as `general` and says so. That is a worse
 * answer, not a wrong boundary.
 */
async function republishAdvertisement(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  body: { displayName?: string; intentPack?: Parameters<typeof projectAdvertisement>[0]['pack']; boundary?: string },
): Promise<void> {
  await writeAdvertisement(ssm, ssmRoot, projectAdvertisement({
    assistant: profileName,
    displayName: body.displayName,
    pack: body.intentPack,
    boundary: body.boundary,
  }));
}

/**
 * A DRAFT IS SPENT BY ITS ACTIVATION (SPEC-PORTABLE-PROFILES: a draft is a sibling parameter "until
 * activation promotes" it). Leaving it behind made the next edit inherit the last one's content: the
 * console offers "+ New version" only when no draft exists, so an operator, or a test, opening the
 * profile after an activation edited the promoted body rather than a fresh clone of what is serving.
 * Measured on dev: a test persona activated and rolled back by one e2e stayed in the draft, and the next
 * e2e's rename activated it again.
 *
 * ONLY THE DRAFT THAT WAS PROMOTED. Re-read and compared by configId, so an edit saved between the read
 * and this delete is kept rather than discarded with the one that was activated.
 *
 * NEVER FAILS THE ACTIVATION, which has already happened: the new version is labeled and serving. A
 * failed delete is logged as an error, and the listing still shows the draft as pending, so it is visible
 * rather than silent.
 */
async function consumeDraft(ssm: SSMClient, ssmRoot: string, profileName: string, promotedConfigId: string): Promise<void> {
  try {
    const current = await getDraft(ssm, ssmRoot, profileName);
    if (!current || current.configId !== promotedConfigId) return;
    await ssm.send(new DeleteParameterCommand({ Name: draftParamName(ssmRoot, profileName) }));
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return;
    console.error(JSON.stringify({ event: 'profile-draft-not-consumed', profileName, configId: promotedConfigId, error: (err as Error)?.message }));
  }
}

/** What `discardDraft` did: the draft it removed, no draft at all, or a newer draft it kept. */
export type DiscardOutcome =
  | { outcome: 'discarded'; configId: string }
  | { outcome: 'no-draft' }
  | { outcome: 'changed'; configId: string };

/**
 * DISCARD THE DRAFT THE CALLER SAW (SPEC-PORTABLE-PROFILES FR18). The draft parameter is deleted only when
 * its stored configId equals `expectedConfigId`, the same compare `consumeDraft` makes, so an edit saved after the
 * caller last read the draft is kept and reported as `changed` with the configId that is there now.
 *
 * THE DRAFT'S ENVELOPE IS READ, NOT HYDRATED: the decision needs only its configId, so a draft whose persona body
 * or layout no longer reads can still be thrown away.
 *
 * OFFLOADED BODIES AND THE LAYOUT OBJECT STAY. Both are content-addressed by configId, and an activated version that
 * carries the same content names the same keys, so deleting them could break a version that serves.
 */
export async function discardDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  expectedConfigId: string,
  actor: string,
): Promise<DiscardOutcome> {
  const name = draftParamName(ssmRoot, profileName);
  let raw: string | undefined;
  try {
    raw = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return { outcome: 'no-draft' };
    throw err;
  }
  if (!raw) return { outcome: 'no-draft' };
  const stored = (JSON.parse(raw) as { configId?: string }).configId ?? '';
  if (stored !== expectedConfigId) return { outcome: 'changed', configId: stored };
  try {
    await ssm.send(new DeleteParameterCommand({ Name: name }));
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return { outcome: 'no-draft' };
    throw err;
  }
  audit('discard', actor, profileName, { configId: stored });
  return { outcome: 'discarded', configId: stored };
}

export async function activateDraft(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  actor: string,
  readContextCatalog?: (profileName: string) => Promise<Array<{ key: string }>>,
  readGuardrailCatalog?: (profileName: string) => Promise<Array<{ key: string; guardrailId: string }>>,
  /**
   * The configId a caller's checks were made against (the golden gate, ADR-065). A draft saved since is a different
   * draft, which those checks never saw, so it is refused rather than activated.
   */
  expectedConfigId?: string,
  /**
   * The refusal an administrator activated this draft past (ADR-065 decision 5), recorded on the version as envelope.
   * Only the golden gate is passed by it: every check below still runs.
   */
  activatedPastGate?: ProfileDefinition['activatedPastGate'],
): Promise<{ version: number; configId: string; displayName?: string }> {
  const draft = await getDraft(ssm, ssmRoot, profileName);
  if (!draft) throw new Error('no draft to activate');
  if (expectedConfigId !== undefined && draft.configId !== expectedConfigId) {
    throw new ProfileValidationError([`the draft changed while it was being activated (now ${draft.configId}); activate again`]);
  }
  const body = bodyFrom(draft);
  // The routes the ACTIVE version already serves: inherited, so not this edit's doing.
  const inherited = await activeRouteKeys(ssm, ssmRoot, profileName);
  const errs = [
    // A RUNTIME ASSISTANT CARRIES ITS OWN INTENT PACK (ADR-048, ADR-054). It has no deploy-time pack of
    // its own, and inheriting its classification's would hand it another assistant's use cases.
    ...(isRuntimeAssistant(profileName) && !body.intentPack
      ? ["a runtime assistant's version must carry its own intentPack; it does not inherit its classification's"]
      : []),
    ...validateBody(body, catalog, inherited, servedClassification(profileName)),
    ...retiredCopyErrors(body.copy),
    ...retiredWelcomeErrors(body.welcome),
    // Activation is the gate, not validate: a caller can skip validate entirely.
    ...(await deploymentRouteErrors(body, ssm, ssmRoot, profileName, inherited)),
    ...(await goldenSetReachErrors(body, ssm, ssmRoot, profileName)),
    ...(await workflowSelectionErrors(body, ssm, ssmRoot, profileName)),
    ...(await versionConfirmBriefErrors(body, ssm, ssmRoot, profileName)),
    ...workIntentErrors(body),
    ...(await contextSelectionErrors(body, profileName, readContextCatalog)),
    ...(await guardrailSelectionErrors(body, profileName, readGuardrailCatalog)),
    ...(await messageTemplateErrors(body, profileName)),
    ...(await workflowErrorsWithMachines(body, ssm, ssmRoot, profileName)),
    ...(await stepModelErrorDetails(body, ssm, ssmRoot, profileName)).map((e) => e.message),
    ...(await requiredToolErrors(body, ssm, ssmRoot, profileName)),
    ...(await eventWorkflowTemplateErrors(body, profileName)),
    ...(await versionVariableErrors(body, profileName, ssm, ssmRoot, readContextCatalog)),
    ...(await versionConditionErrors(body, profileName, readContextCatalog)),
  ];
  if (errs.length) throw new ProfileValidationError(errs);
  // THE ACTIVATED VERSION KEEPS THE DRAFT'S LAYOUT (ADR-061 decision 7): the same configId, so the same layout key.
  const layout = layoutFor(draft.layout, body.eventWorkflows);
  const def = { ...buildDefinition(profileName, body), ...(layout ? { layout } : {}), ...(activatedPastGate ? { activatedPastGate } : {}) };
  const name = definitionParamName(ssmRoot, profileName);
  // `putDefinition` re-measures the value it is about to send, for the same reason editDraft relies on
  // it: validateBody above sees only the body, and this is the last gate before the write - activation
  // is reachable without ever calling validate. The body write it does first is a no-op in content
  // terms (the draft already stored this exact configId's persona at this exact key), so promoting a
  // draft never rewrites a body it did not author.
  const { version } = await putDefinition(ssm, name, def);
  await labelJustWrittenVersion(ssm, name, version, ACTIVE_LABEL);
  await republishAdvertisement(ssm, ssmRoot, profileName, body);
  await consumeDraft(ssm, ssmRoot, profileName, draft.configId);
  audit(activatedPastGate ? 'activate-past-golden-gate' : 'activate', actor, profileName, {
    version, configId: def.configId, ...(activatedPastGate ? { activatedPastGate } : {}),
  });
  // THE ACTIVATED NAME TRAVELS WITH THE RESULT, so the caller can put it on the identity without
  // re-reading what it just wrote. Absent means this version names nothing, which is an instruction
  // rather than a gap: the caller applies the assistant's CONFIGURED default, so clearing a name
  // returns the identity to what it was provisioned as. (This comment previously said the caller
  // leaves the identity alone, which is what made "inherit" unreachable once an assistant had been
  // renamed - the old name simply stayed.)
  return { version, configId: def.configId, displayName: body.displayName };
}

/** Roll the `active` label onto an existing (immutable) version — rollback or forward-activate (§4). */
export async function activateExistingVersion(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  version: number,
  actor: string,
): Promise<{ version: number; configId: string; displayName?: string }> {
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

  // A CANDIDATE IS NOT A ROLLBACK TARGET, and refusing here is what makes that true.
  //
  // An experiment publishes a derived version to be measured, deliberately WITHOUT the `active` label
  // (`publishVariantVersion`), and it then sits in the same history as versions that really served.
  // `listProfile` summarises a version as `{version, configId, active, lastModified}` and does not
  // surface `derivedFrom`, so an operator scanning that list cannot tell a candidate from a prior live
  // state - and rolling "back" into one would serve a room a version nobody ever approved.
  //
  // REFUSED RATHER THAN HIDDEN. The version stays visible, because it is the evidence of what an
  // experiment ran; what it may not do is become live by a label move. A measured candidate becomes
  // live through its experiment's Promote action (`promoteCandidate`), which copies it into the live
  // history only when the copy hashes to what was measured (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6).
  let derivedFrom: { experimentId?: string; variantId?: string } | undefined;
  let retiredWelcome: unknown;
  try {
    const parsed = JSON.parse(match.Value ?? '{}') as ProfileDefinition;
    derivedFrom = parsed.derivedFrom;
    retiredWelcome = parsed.welcome;
  } catch {
    /* an unparseable body is the not-a-candidate case; the activation below reports its own failure */
  }
  // A VERSION STORED BEFORE THE WELCOME BECAME A WORKFLOW (W1) would serve without the welcome it was validated with: the
  // runtime reads no `welcome`. It becomes live again as a new version the migration writes.
  const retired = retiredWelcomeErrors(retiredWelcome);
  if (retired.length) throw new ProfileValidationError([`version ${version} of '${profileName}' carries the retired welcome. ${retired[0]}`]);
  if (derivedFrom) {
    throw new ProfileValidationError([
      `version ${version} of '${profileName}' was derived by experiment `
      + `'${derivedFrom.experimentId}' (variant '${derivedFrom.variantId}') and has never served a `
      + "conversation, so it cannot be activated by rollback. Promote it with its experiment's Promote "
      + 'action, which copies the measured candidate into the live history as a new version.',
    ]);
  }

  await ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: version, Labels: [ACTIVE_LABEL] }));
  // A ROLLBACK CHANGES WHAT THIS ASSISTANT ADVERTISES, so the projection follows the label rather than
  // the last forward activation. Projected from the version being rolled TO, read out of the body this
  // function already fetched to check it.
  // HYDRATED FIRST, because a stored version does not carry its own pack inline. The pack is offloaded
  // to S3 beside the persona (`intentPackRef`), so projecting the raw parameter value would publish an
  // advertisement with NO intents - which by the inherit rule reads as "this assistant advertises
  // nothing", and would silently stop every roommate routing to it after any rollback. The same trap
  // caught the one-time backfill, which is how it was found.
  try {
    const rolledTo = await hydrateBodies(JSON.parse(match.Value ?? '{}') as ProfileDefinition);
    await republishAdvertisement(ssm, ssmRoot, profileName, rolledTo);
  } catch (err) {
    console.warn('[profile-lifecycle] could not project the rolled-to version; the previous '
      + 'advertisement stands', { profileName, version, err: (err as Error)?.message });
  }
  const configId = configIdOf(match.Value);
  audit('rollback', actor, profileName, { version, configId });
  // A ROLLBACK IS A RENAME TOO when the version it rolls back to carried a different name. Reading it
  // off the version being activated is what makes the identity follow the label rather than drifting
  // to whatever the last forward activation happened to set.
  return { version, configId, displayName: displayNameOf(match.Value) };
}

/** The `displayName` of a stored definition, or undefined for one that names nothing. */
function displayNameOf(rawValue: string | undefined): string | undefined {
  if (!rawValue) return undefined;
  try {
    // A stored definition EXTENDS the body rather than nesting one, so the field is at the top level.
    const dn = (JSON.parse(rawValue) as ProfileDefinition).displayName;
    return typeof dn === 'string' ? dn : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ── A VARIANT'S VERSION: THE LIVE ASSISTANT'S PROFILE, PLUS THE EXPERIMENT'S DELTA ───────────────
 *
 * An experiment compares two implementations of ONE assistant. Today a variant that carries no
 * `profileRef` can only say `modelKey` and `imageGenModelKey`, so "which model is best for this
 * intent" is testable and "does this persona work better" is not - even though a `profileRef`
 * variant already serves an entire definition. The capability was there; the way to AUTHOR one was
 * not, so every softer field was unreachable in practice.
 *
 * This is that authoring step: copy what the live assistant is serving now, apply the experiment
 * type's recipe, publish it in the candidate history (the role's alt, `alt-{role}-{classification}`),
 * and hand back the pin. The experiment's treatment variant then pins it (`altPin`), and every turn
 * assigned to the treatment serves it whole - no new resolution path and no deploy.
 *
 * PUBLISHED WITHOUT THE `active` LABEL, which is what makes it a candidate rather than a change. The
 * live assistant keeps serving what it served. Nothing is published under the live name: the control
 * is the live assistant's active version, pinned by number (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP
 * §3.5). Promotion copies the candidate into the live history (`promoteCandidate`), refusing a copy
 * that does not hash to what was measured, and is never a label move (`activateExistingVersion`
 * refuses a derived version).
 *
 * ── THE INTENTS ARE NOT THE EXPERIMENT'S TO CHANGE ─────────────────────────────────────────────
 *
 * A variant may change anything about the assistant EXCEPT which use cases it serves.
 * `intentPack` is hashed into `configId` and its own comment calls it "the field that
 * decides how turns are routed in the first place" - so a variant that altered it would make the
 * two sides classify differently, serve different use cases, and produce scores that cannot be
 * compared. That is not an experiment with a confound in it; it is two different products in one
 * duel, reported as a winner and a loser.
 *
 * REFUSED RATHER THAN SILENTLY INHERITED. Dropping the field would let an operator believe they had
 * changed the taxonomy and read the result as though they had, which is the quieter of the two
 * failures and the worse one. The patch is rejected and says why.
 */
export async function publishVariantVersion(
  ssm: SSMClient,
  ssmRoot: string,
  /**
   * WHERE THE BODY COMES FROM AND WHERE THE CANDIDATE GOES (ADR-050, DESIGN-SEPARATE-ASSISTANTS §3.7).
   * `baseProfile` is its role's live assistant, whose ACTIVE body is read and pinned. `targetProfile` is
   * that role's alt, `alt-{role}-{classification}`, and nothing else: the live history holds only versions
   * that served or were promoted (§3.5), so a candidate is never published under the live name.
   */
  profiles: { baseProfile: string; targetProfile: string },
  patch: Partial<ProfileDefinitionBody>,
  /** Passed in, not imported: this module stays free of the catalog so it can be unit-tested
   *  without one, which is the convention `validateDraft` and `activateDraft` already follow. */
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  actor: string,
  /** WHICH DUEL SIDE THIS IS. Stamped onto the version as `derivedFrom` so the candidate can say what
   *  produced it, and compared by the arm path to decide whether it already has the version it needs. */
  provenance: { experimentId: string; variantId: string },
  /**
   * The pin this (experiment, variant) already carries, when it has one. Present ⇒ the existing
   * version is READ BACK and reused whenever it still says the same thing, so a re-arm publishes
   * nothing: one pinned version per (experiment, variant).
   *
   * Reuse is decided on `configId`, which is the body's own fingerprint, rather than on the
   * experiment having been armed before. An arm after the live assistant published a new active
   * version derives a DIFFERENT body, and silently reusing the old pin would measure the variant
   * against a base its operator has already replaced.
   */
  existingVersion?: number,
  /** The SAME catalog readers `validateDraft` and `activateDraft` take. Optional in their signatures
   *  and optional here for the same reason, but a caller that omits them gets a laxer check than the
   *  editor applies, so `manage-profiles` passes both. */
  readContextCatalog?: (profileName: string) => Promise<Array<{ key: string }>>,
  readGuardrailCatalog?: (profileName: string) => Promise<Array<{ key: string; guardrailId: string }>>,
): Promise<{ profileName: string; version: number; configId: string; reused: boolean }> {
  const { baseProfile, targetProfile } = profiles;
  if (!isKnownProfile(baseProfile)) throw new Error(`unknown profile '${baseProfile}'`);
  // THE TARGET IS THE ALT OF THE BASE'S OWN ROLE, and nothing else. A candidate published under any other
  // name would land in another assistant's history, attach one role's experiment to another role, or (under
  // the live name) put a version that never served into the history of what did.
  const assignment = defaultProfileRegistry.roleOfAssistant(baseProfile);
  const expectedTarget = assignment ? defaultProfileRegistry.altAssistantName(assignment.classification, assignment.role) : undefined;
  if (!expectedTarget || targetProfile !== expectedTarget) {
    throw new ProfileValidationError([
      `a candidate for '${baseProfile}' is published under its role's alt (${expectedTarget ?? 'none declared'}), not '${targetProfile}'`,
    ]);
  }
  const profileName = baseProfile;

  if (patch.intentPack !== undefined) {
    throw new ProfileValidationError([
      'a variant may not change intentPack: an experiment compares two implementations of the same '
      + 'assistant, and a side that serves different use cases produces a score the other side cannot '
      + 'be compared against. Change the model, persona, tools, guardrail, context sources or '
      + 'workflows instead.',
    ]);
  }

  // The live assistant's CURRENT active body is the base, read the same way `createDraft` reads it - so a
  // derived version inherits everything the live assistant is serving, including the taxonomy, and
  // differs only where the experiment says it does.
  const base = await activeOrSeedBodyComplete(ssm, ssmRoot, profileName);
  const baseVersion = await activeVersionNumber(ssm, ssmRoot, profileName);
  // THE MODEL BUNDLE MERGES FIELD BY FIELD, so a delta naming one model (the classifier, the image model)
  // keeps the base's others rather than replacing the whole bundle. A delta naming the base model by
  // `modelKey` moves `models.default` with it: the served base model is `models.default` when it is
  // concrete, so moving only the top-level key would leave the version serving the live model.
  // THE ROUTES MERGE ROUTE BY ROUTE, and a route's fields merge too, so an `intent` recipe naming one
  // intent's primary model changes that one route and keeps every other route and that route's fallback.
  // The image part and the step overrides merge too (ADR-064), so a recipe naming the image model keeps the image fallback.
  const mergeRoute = (b: IntentRoute | undefined, r: IntentRoute | undefined): IntentRoute => ({
    ...(b ?? {}), ...(r ?? {}),
    ...(b?.image || r?.image ? { image: { ...(b?.image ?? {}), ...(r?.image ?? {}) } as IntentRoute['image'] } : {}),
    ...(b?.steps || r?.steps ? { steps: { ...(b?.steps ?? {}), ...(r?.steps ?? {}) } } : {}),
  });
  const byIntent = patch.models?.byIntent
    ? Object.fromEntries(Object.entries({ ...(base.models?.byIntent ?? {}), ...patch.models.byIntent }).map(([intent, route]) => [
      intent,
      mergeRoute(base.models?.byIntent?.[intent], route),
    ]))
    : undefined;
  const models = patch.models || patch.modelKey !== undefined
    ? {
      ...(base.models ?? {}),
      ...(patch.models ?? {}),
      ...(byIntent ? { byIntent } : {}),
      ...(patch.modelKey !== undefined && patch.models?.default === undefined ? { default: patch.modelKey } : {}),
    }
    : base.models;
  // A ROUTE THE DELTA CHANGES KEEPS A SOUND FALLBACK: a base fallback that is now the primary, or of the
  // other kind, is dropped and the new primary stands alone (`routeKindError`). The image part is held to
  // the same rule on its own: a recipe naming the base's image fallback as its image primary serves that
  // model alone. A delta that routes the `image_generation` intent retires the legacy `models.image` it supersedes.
  if (models && byIntent) {
    for (const intent of Object.keys(patch.models?.byIntent ?? {})) {
      const r = byIntent[intent] as { primary: string; fallback?: string; image?: { primary?: string; fallback?: string } };
      if (!r) continue;
      if (r.image?.fallback && r.image.fallback === r.image.primary) delete r.image.fallback;
      if (r.fallback && routeKindError(intent, { primary: r.primary, fallback: r.fallback })) delete r.fallback;
    }
    if (isImageRoute(byIntent[IMAGE_ROUTE_KEY] as { primary: string } | undefined)) delete (models as { image?: string }).image;
  }
  const merged = ensureModelsBundle({
    ...base, ...patch, ...(models ? { models } : {}), intentPack: base.intentPack,
  } as ProfileDefinitionBody);

  // THE SAME VALIDATION AN OPERATOR'S OWN EDIT GOES THROUGH, with the same catalog and the same
  // inherited-route allowance. A variant is not a privileged writer: a body it could not have
  // authored by hand is one the runtime cannot serve either, and a second, laxer validation path
  // for experiment-derived versions is how a deployment ends up serving a duel side that its own
  // editor would have refused.
  const inherited = await activeRouteKeys(ssm, ssmRoot, profileName);
  const errs = [
    ...validateBody(merged, catalog, inherited, servedClassification(profileName)),
    // A version that still carries the retired welcome is not one the runtime reads the same way (W1).
    ...retiredWelcomeErrors(merged.welcome),
    ...(await deploymentRouteErrors(merged, ssm, ssmRoot, profileName, inherited)),
    ...(await goldenSetReachErrors(merged, ssm, ssmRoot, profileName)),
    ...(await workflowSelectionErrors(merged, ssm, ssmRoot, profileName)),
    ...(await versionConfirmBriefErrors(merged, ssm, ssmRoot, profileName)),
    // THE SELECTION CHECKS, WHICH THIS OMITTED WHILE CLAIMING PARITY WITH AN OPERATOR EDIT. Without
    // them a variant could name a guardrail or a context source this deployment does not publish: the
    // candidate would publish, the duel's side would run, the resolver would fall back to the
    // deployment default, and the experiment would report a winner measured under a guardrail its own
    // version says it is not getting. A laxer path for experiment-derived versions is exactly what the
    // comment above promises this does not have.
    ...(await contextSelectionErrors(merged, profileName, readContextCatalog)),
    ...(await guardrailSelectionErrors(merged, profileName, readGuardrailCatalog)),
    ...workIntentErrors(merged),
    ...(await versionVariableErrors(merged, profileName, ssm, ssmRoot, readContextCatalog)),
    ...(await versionConditionErrors(merged, profileName, readContextCatalog)),
  ];
  if (errs.length) throw new ProfileValidationError(errs);

  const def: ProfileDefinition = {
    ...buildDefinition(targetProfile, merged),
    // Stamped AFTER the build, because `buildDefinition` hashes the body it is given: provenance is
    // envelope and must not reach `configId` (see `derivedFrom` on the type).
    // `baseVersion` is OMITTED when the profile has no published version yet, rather than written as
    // 0. The base was then the compiled seed, which is not a version and has no number; a 0 would read
    // as one and send whoever is tracing a candidate looking for a version that never existed.
    derivedFrom: { ...provenance, baseProfile, ...(baseVersion !== null ? { baseVersion } : {}) },
  };

  // ALREADY PUBLISHED? Read the pin back and compare fingerprints. A re-arm of an unchanged
  // experiment against an unchanged live assistant derives the same body, and publishing it again would
  // mint a version per arm - the churn the (experiment, variant) reuse rule exists to bound.
  //
  // Compared rather than assumed: the pin is only still correct if what it points at still says what
  // this derivation says. A version that has been deleted, or was never readable, falls through and
  // publishes, which is the safe direction - a duel with no resolvable profile has nothing to run.
  if (existingVersion !== undefined) {
    const prior = await lookupProfileVersion(ssm, ssmRoot, { profileName: targetProfile, version: existingVersion });
    if (prior?.configId === def.configId) {
      audit('reuse-variant-version', actor, targetProfile, { version: existingVersion, configId: def.configId, baseProfile });
      return { profileName: targetProfile, version: existingVersion, configId: def.configId, reused: true };
    }
  }

  const { version } = await putDefinition(ssm, definitionParamName(ssmRoot, targetProfile), def);
  audit('publish-variant-version', actor, targetProfile, { version, configId: def.configId, baseProfile });
  return { profileName: targetProfile, version, configId: def.configId, reused: false };
}

/**
 * The live assistant's ACTIVE version: its number and its hydrated body. Null when nothing is published
 * (the assistant serves its compiled seed, which is not a version and cannot be pinned).
 */
export async function readActiveVersion(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
): Promise<{ version: number; body: ProfileDefinitionBody; configId: string } | null> {
  let resp;
  try {
    resp = await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(ssmRoot, profileName)}:${ACTIVE_LABEL}` }));
  } catch {
    return null;
  }
  const raw = resp.Parameter?.Value;
  const version = resp.Parameter?.Version;
  if (!raw || version === undefined) return null;
  const def = await hydrateBodies(JSON.parse(raw) as ProfileDefinition);
  return { version, body: bodyFrom(def), configId: def.configId };
}

/** Why a promotion was refused, by code, so the experiments API can answer each with its own status. */
export class PromotionRefusedError extends Error {
  constructor(public readonly code: 'LIVE_VERSION_MOVED' | 'CANDIDATE_NOT_FOUND' | 'PROMOTION_HASH_MISMATCH', message: string) {
    super(message);
    this.name = 'PromotionRefusedError';
  }
}

/**
 * ── PROMOTION: THE MEASURED CANDIDATE, COPIED INTO THE LIVE HISTORY (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6) ──
 *
 * The candidate's body is copied into the live assistant as a NEW version (the same `fromProfileRef`
 * copy `/variant-version` uses), and activated. Three refusals keep it exactly what was measured:
 *  - THE BASE MOVED. The live active version is no longer the experiment's pinned control, so the
 *    candidate was a variation of something that no longer serves; re-deriving it would be a new,
 *    untested candidate (`LIVE_VERSION_MOVED`).
 *  - THE CANDIDATE IS UNREADABLE (`CANDIDATE_NOT_FOUND`).
 *  - THE COPY DOES NOT HASH TO THE CANDIDATE'S `configId` (`PROMOTION_HASH_MISMATCH`). Nothing is
 *    written or activated, so a promotion can only ever activate a byte-identical behavior.
 *
 * The new version records `promotedFrom` (candidate, version, experiment) as envelope, so the live
 * history says which experiment put it there; analytics keeps reading the same `configId`.
 */
export async function promoteCandidate(
  ssm: SSMClient,
  ssmRoot: string,
  args: {
    liveProfile: string;
    candidate: { profileName: string; version: number };
    /** The control the experiment pinned: the live active version number when it started. */
    controlVersion: number;
    experimentId: string;
  },
  actor: string,
): Promise<{ version: number; configId: string; displayName?: string }> {
  const { liveProfile, candidate, controlVersion, experimentId } = args;
  const active = await activeVersionNumber(ssm, ssmRoot, liveProfile);
  if (active !== controlVersion) {
    throw new PromotionRefusedError(
      'LIVE_VERSION_MOVED',
      `'${liveProfile}' now serves version ${active ?? 'none'}, not the control version ${controlVersion} this experiment `
      + 'measured against; the candidate is a variation of a version that no longer serves. Run a new experiment against the current version.',
    );
  }
  const stored = await lookupProfileVersion(ssm, ssmRoot, candidate);
  if (!stored) {
    throw new PromotionRefusedError('CANDIDATE_NOT_FOUND', `version ${candidate.version} of '${candidate.profileName}' could not be read`);
  }
  const body = bodyFrom(await hydrateBodies(stored));
  const def: ProfileDefinition = {
    ...buildDefinition(liveProfile, body),
    // Envelope, stamped after the hash like `derivedFrom`.
    promotedFrom: { profileName: candidate.profileName, version: candidate.version, experimentId },
  };
  if (def.configId !== stored.configId) {
    throw new PromotionRefusedError(
      'PROMOTION_HASH_MISMATCH',
      `the copy of ${candidate.profileName}@${candidate.version} hashes to ${def.configId}, not the measured ${stored.configId}; nothing was activated`,
    );
  }
  // RE-CHECKED AT THE WRITE, after the reads above, so an activation that landed while this promotion was
  // reading cannot be overtaken by it. Every refusal so far has written nothing.
  const stillActive = await activeVersionNumber(ssm, ssmRoot, liveProfile);
  if (stillActive !== controlVersion) {
    throw new PromotionRefusedError(
      'LIVE_VERSION_MOVED',
      `'${liveProfile}' was activated at version ${stillActive ?? 'none'} while this promotion ran; nothing was written`,
    );
  }
  const name = definitionParamName(ssmRoot, liveProfile);
  const { version } = await putDefinition(ssm, name, def);
  await labelJustWrittenVersion(ssm, name, version, ACTIVE_LABEL);
  try {
    await republishAdvertisement(ssm, ssmRoot, liveProfile, body);
  } catch (err) {
    console.warn('[profile-lifecycle] could not project the promoted version; the previous advertisement stands', {
      liveProfile, version, err: (err as Error)?.message,
    });
  }
  audit('promote', actor, liveProfile, { version, configId: def.configId, promotedFrom: def.promotedFrom });
  return { version, configId: def.configId, displayName: body.displayName };
}

export { profileDefinitionConfigId };

/**
 * PREVIEW RUN OF ONE OF THE DRAFT'S WORKFLOWS (ADR-061 decision 7): the workflow the console holds (`definition`, which may be
 * unsaved) or the draft's own of that name, checked by the rules the draft is held to, then walked with sample values by
 * `previewWorkflowRun`. It reads the draft and the classification's task machines and writes nothing: no parameter, no
 * body, no record, no message.
 */
export async function previewDraftWorkflow(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
  req: { workflow?: unknown; definition?: unknown; values?: unknown; outcomes?: unknown },
): Promise<import('./workflow-preview.js').PreviewResult> {
  const { previewWorkflowRun, previewValuesErrors, PREVIEW_ENDINGS } = await import('./workflow-preview.js');
  const name = typeof req.workflow === 'string' ? req.workflow : '';
  const draft = await getDraft(ssm, ssmRoot, profileName);
  const body = draft ? bodyFrom(draft) : null;
  const wf = req.definition !== undefined ? req.definition : body?.eventWorkflows?.[name];
  if (!name || wf === undefined) throw new ProfileValidationError([`no workflow named '${name}' to preview`]);
  const outcomes = req.outcomes;
  const outcomeErrors = outcomes === undefined ? [] : typeof outcomes !== 'object' || outcomes === null || Array.isArray(outcomes)
    ? ['outcomes maps a step name to success, failure or deadline']
    : Object.entries(outcomes as Record<string, unknown>).filter(([, v]) => !(PREVIEW_ENDINGS as readonly unknown[]).includes(v)).map(([k]) => `outcomes.${k} is success, failure or deadline`);
  const machines = hasTaskStep({ [name]: wf }) ? await deploymentTaskMachines(ssm, ssmRoot, profileName) : undefined;
  if (machines && 'error' in machines) throw new ProfileValidationError([machines.error]);
  const errors = [
    ...previewValuesErrors(req.values),
    ...outcomeErrors,
    ...versionEventWorkflowsErrors({ [name]: wf }, machines ? { machines: machines.machines } : {}),
  ];
  if (errors.length) throw new ProfileValidationError(errors);
  return previewWorkflowRun(name, wf as EventWorkflow, {
    ...(body?.variables ? { variables: body.variables } : {}),
    classifications: defaultProfileRegistry.classificationValues(),
    ...(req.values ? { values: req.values as Record<string, import('./variables.js').VariableValue> } : {}),
    ...(outcomes ? { outcomes: outcomes as Record<string, import('./workflow-preview.js').PreviewEnding> } : {}),
    ...(machines ? { machines: machines.machines } : {}),
  });
}
