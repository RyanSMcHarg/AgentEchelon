/**
 * Manage Profiles API — SPEC-PORTABLE-PROFILES P1/§4 (versioning lifecycle) + P3/§5
 * (export/import). The WRITE surface for assistant profile versions, gated by the `manage-profiles`
 * capability (§7 / plan item A14). Routes on the existing admin API — NO new gateway (§3).
 *
 *   GET  /profiles                 — list every profile: versions, active pointer, draft state
 *   POST /profiles/version         — {profileName} clone the active version into a fresh draft
 *   POST /profiles/draft           — {profileName, patch} edit the draft's runtime-editable fields
 *   POST /profiles/validate        — {profileName} validate the draft (schema + §7 model-ARN boundary)
 *   POST /profiles/golden-run      - {profileName} run the draft against its golden set, beside the active version (ADR-065)
 *   POST /profiles/golden-gate     - {profileName} the set's size and the draft's latest run, as Activate reads them
 *   POST /profiles/golden-set-import - {profileName, format, content} the deployment's own entries, de-identified (ADR-065 decision 7)
 *   POST /profiles/golden-set-retire-upload - {profileName, uploadId} retire the capability entries of one upload
 *   POST /profiles/golden-set-retire-generation - {profileName, uploadId} retire the capability entries of one generation
 *   POST /profiles/golden-set-batch - {profileName, batchId} how an upload or a generation ended
 *   POST /profiles/golden-set-generate - {profileName, intents?, perIntent?} entries written from the draft's intent pack (decision 8)
 *   POST /profiles/activate        — {profileName} promote the draft to a new active version, refused by the golden gate
 *   POST /profiles/rollback        — {profileName, version} move `active` onto an existing version
 *   POST /profiles/discard         - {profileName, configId} delete the draft, only if it is still that configId
 *   POST /profiles/export          — {profileName, version?} serialize an instance-agnostic manifest
 *   POST /profiles/import          — {manifest, targetProfileName} validate + land as the target's draft (never active)
 *
 * The mutations are the write path; the async-processor role is read-only on /assistant/* (§7). Every
 * mutation is audited with the server-verified caller sub. The management API is the ONLY sanctioned
 * write path to the profile SSM namespace.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { createInfraResolver, type InfraPlacement } from './lib/profile-infra.js';
import { bodyBucket } from './lib/profile-bodies.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { IAMClient } from '@aws-sdk/client-iam';
import { LexModelsV2Client } from '@aws-sdk/client-lex-models-v2';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { parseJsonBody, callerCanManageProfiles, callerActor, callerPersonArn, holdsAdminGroup, respond as authRespond } from './lib/auth.js';
import { defaultDirectory } from './lib/membership-source.js';
import { adminNotice, postAdminNotice } from './lib/admin-notice.js';
import { getModelCatalog } from '../../lib/config/model-strategy.js';
import {
  bodyFrom, concreteModel, definitionParamName, isNoActiveVersion, rememberRuntimeSeed, type ProfileDefinitionBody, type ProfileDefinition,
} from './lib/active-profile.js';
import { hydrateBodies } from './lib/profile-bodies.js';
import { GENERAL_ROUTE_KEY, needsOf, taskStateMachines, parseIntentPack, resolveStoredPack, type IntentDef } from './lib/intent-pack.js';
import { stepOutputOf } from './lib/step-models.js';
import { IMAGE_ROUTE_KEY } from './lib/image-route.js';
import type { TaskStateMachine } from './lib/task-state-machines.js';

/** What an intent of the platform hands over, read by key (`needsOf`). */
const needsOfIntent = (key: string) => needsOf({ key });
import { imageRouteFor } from './lib/image-route.js';
import { imageRouteKeyOf } from './lib/experiment-image-route.js';
import { readRuntimeAssistant, readDirectoryEntry, listDirectory, withAbandonedBuild, type DirectoryEntry } from './lib/runtime-directory.js';
import { listAssistantIdentities, type AssistantIdentity } from './lib/assistant-ownership.js';
import { chimeIdentityClient } from './lib/chime/clients.js';
import { lookupProfileVersion, concreteProfileVersion } from './lib/profile-version-lookup.js';
import {
  listProfile,
  createDraft,
  editDraft,
  validateDraft,
  activateDraft,
  activateExistingVersion,
  publishVariantVersion,
  promoteCandidate,
  readActiveVersion,
  PromotionRefusedError,
  allProfileNames,
  isKnownProfile,
  isRuntimeAssistant,
  rememberRuntimeAssistant,
  forgetRuntimeAssistant,
  classificationServedBy,
  ProfileValidationError,
  seedFirstDraft,
  copyFirstDraft,
  copySourceError,
  getDraft,
  discardDraft,
  previewDraftWorkflow,
  storedRunSides,
  storedActiveDefinition,
  servedIntentKeys,
  deploymentPackRaw,
  audit,
  type FirstDraftResult,
} from './lib/profile-lifecycle.js';
import { goldenGateOutcome, pastGateDecision, effectiveMinimum, type GoldenGateRead } from './lib/golden-gate.js';
import { readGoldenUpload, uploadIdFor, goldenUploadPrefix, GOLDEN_SET_CAPACITY } from './lib/golden-upload.js';
import {
  generationIntentOf, GENERATE_MAX_INTENTS, GENERATE_PER_INTENT_DEFAULT, GENERATE_PER_INTENT_MAX,
} from './lib/golden-generate.js';
import { randomUUID } from 'crypto';
import { exportManifest, importManifest, ProfileManifestError, type TargetContextSource } from './lib/profile-manifest.js';
import { startingPointErrors, startingPointOf, withStartingChoices, type StartingPoint, type StartingChoices } from './lib/starting-point.js';
// The canonical tool registry, SERVED rather than mirrored. See the GET handler for why.
import { TOOL_REGISTRY } from './lib/tool-registry.js';
import { classificationCatalog, type ClassificationCatalog } from './lib/classification-catalog.js';
import { fieldDecisions } from './lib/profile-field-decisions.js';
import { requireOwnedAssistant, isRefusal } from './lib/assistant-scope.js';
import { DUEL_ROLE, challengerOf } from './lib/alt-assignment.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { rosterTargets } from './lib/roster-targets.js';
import { displayNameHolder } from './lib/display-names-in-use.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const ssm = new SSMClient({ region: AWS_REGION });

/**
 * A RUNTIME ASSISTANT IS KNOWN HERE ONLY WHILE THE DIRECTORY SAYS IT IS ACTIVE (ADR-048).
 *
 * Read per request for a name the compiled registry does not declare, so a retired assistant stops being
 * editable on the next request rather than when the container recycles. Learning one makes its
 * classification and seed known to the lifecycle, which keys its catalogs and seeds its versions by them.
 */
async function learnRuntimeAssistant(name: string): Promise<boolean> {
  if (!name || profiles.profileByName(name) || profiles.roleOfAlt(name)) return false;
  const found = await readRuntimeAssistant(ssm, SSM_ROOT, name);
  if (!found) {
    forgetRuntimeAssistant(name);
    return false;
  }
  rememberRuntimeAssistant(name, found.entry.classification);
  rememberRuntimeSeed(found.seed);
  runtimeEntries.set(name, found.entry);
  return true;
}

/** The directory entries learned above, for what a create chose that a first draft carries. */
const runtimeEntries = new Map<string, DirectoryEntry>();

/** What a runtime assistant's create chose that its first draft takes, whatever it starts from. */
function startingChoicesOf(name: string): StartingChoices {
  const entry = runtimeEntries.get(name);
  return {
    ...(entry?.displayName ? { displayName: entry.displayName } : {}),
    ...(entry?.descriptor?.modelKey ? { modelKey: entry.descriptor.modelKey } : {}),
    ...(entry?.descriptor?.classifierModelKey ? { classifierModelKey: entry.descriptor.classifierModelKey } : {}),
  };
}

/** The import options every manifest landing here uses, for one target. */
function importOptions(actor: string, extra: Partial<Parameters<typeof importManifest>[3]> = {}): Parameters<typeof importManifest>[3] {
  return {
    catalog: catalog(),
    knownProfile: isKnownProfile,
    guardrailCatalog: guardrailCatalogFor,
    contextSourceCatalog: contextSourceCatalogFor,
    actor,
    ...extra,
  };
}

/**
 * Lands a new assistant's first draft from what its create chose to start from (`starting-point.ts`). A file
 * goes through the same import as any version, a copy through `copyFirstDraft`, and the classification's
 * defaults through `seedFirstDraft`; each writes the create's name and models over what it starts from.
 */
async function landFirstDraft(assistant: string, startingPoint: StartingPoint, actor: string): Promise<FirstDraftResult> {
  const choices = startingChoicesOf(assistant);
  if (startingPoint.kind === 'copy') {
    if (!profiles.profileByName(startingPoint.from)) await learnRuntimeAssistant(startingPoint.from);
    return copyFirstDraft(ssm, SSM_ROOT, assistant, startingPoint.from, actor, choices);
  }
  if (startingPoint.kind === 'manifest') {
    if (await getDraft(ssm, SSM_ROOT, assistant)) return { seeded: false, reason: 'it already has a draft' };
    const draft = await importManifest(ssm, SSM_ROOT, startingPoint.manifest, importOptions(actor, {
      targetProfileName: assistant,
      adjustBody: (b) => withStartingChoices(b, choices),
    }));
    return { seeded: true, configId: draft.configId };
  }
  return seedFirstDraft(ssm, SSM_ROOT, assistant, actor, { choices });
}

/**
 * Checks a create's starting point BEFORE `manage-assistants` takes the name, so a file or a copy that cannot
 * land is refused with its reasons instead of becoming a failed first draft. The assistant does not exist
 * yet, so it is known here for the length of the check only, as the classification the create names.
 */
async function checkStartingPoint(req: {
  assistant: string; classification: string; startingPoint: StartingPoint; choices: StartingChoices;
}): Promise<{ errors: string[] }> {
  const { assistant, classification, startingPoint, choices } = req;
  if (startingPoint.kind === 'defaults') return { errors: [] };
  if (startingPoint.kind === 'copy') {
    if (!profiles.profileByName(startingPoint.from)) await learnRuntimeAssistant(startingPoint.from);
    const refused = await copySourceError(ssm, SSM_ROOT, startingPoint.from, classification);
    return { errors: refused ? [refused] : [] };
  }
  const knownBefore = isKnownProfile(assistant);
  if (!knownBefore) rememberRuntimeAssistant(assistant, classification);
  try {
    await importManifest(ssm, SSM_ROOT, startingPoint.manifest, importOptions('manage-assistants', {
      targetProfileName: assistant,
      knownProfile: (n) => n === assistant,
      adjustBody: (b) => withStartingChoices(b, choices),
      checkOnly: true,
    }));
    return { errors: [] };
  } catch (err) {
    if (err instanceof ProfileManifestError) return { errors: err.errors?.length ? err.errors : [err.message] };
    throw err;
  } finally {
    if (!knownBefore) forgetRuntimeAssistant(assistant);
  }
}

/**
 * Every assistant's identity and owner, best-effort: a listing whose ownership cannot be read lists the
 * assistants without `ownerTeam` rather than failing. A team route already holds its one assistant's bots.
 */
async function assistantIdentities(scoped: AssistantIdentity[] | null): Promise<AssistantIdentity[] | null> {
  if (scoped) return scoped;
  const appInstanceArn = process.env.APP_INSTANCE_ARN || '';
  if (!appInstanceArn) return null;
  try {
    return await listAssistantIdentities(chimeIdentityClient({ region: AWS_REGION }), appInstanceArn);
  } catch (err) {
    console.error('[manage-profiles] assistant ownership could not be read; listing without owners', { err: (err as Error)?.name });
    return null;
  }
}

/**
 * WHAT A ROW SAYS ABOUT ITS ASSISTANT, so the console lists every assistant as one kind of thing: where it
 * runs (`classification`, `role`), who owns it, what it is called, its per-person turn limit, and how it
 * came to exist (`origin`: declared in the deployment's profiles, or created in the console).
 */
function describeAssistant<T extends { profileName: string; activeDisplayName?: string }>(
  listing: T,
  entry: DirectoryEntry | undefined,
  identities: AssistantIdentity[] | null,
): T & Record<string, unknown> {
  const n = listing.profileName;
  const declared = profiles.profileByName(n);
  // How it was asked for: a detail on its row, never a capability (ADR-048, amended 2026-10-23).
  const consoleCreated = !!entry && entry.origin !== 'declared';
  const placed = entry ? { classification: entry.classification, role: entry.role } : profiles.roleOfAssistant(n);
  const bots = identities?.filter((i) => i.assistant === n) ?? [];
  const owners = [...new Set(bots.map((b) => b.ownerTeam))];
  // THE DEPLOYED VALUE, read-only and under its own name: a version cannot set it (the limit is deploy
  // configuration, read by the router), so it is shown the way the deployed channel flow is.
  const deployedTurnLimit = consoleCreated ? entry?.descriptor?.rateLimitPerHour : declared?.rateLimitPerHour;
  const displayName = listing.activeDisplayName || declared?.displayName || entry?.displayName;
  // HOW TURNS ARE CLASSIFIED, read where the router reads it: the directory's descriptor for a console-created
  // assistant, the deployment's profile for a declared one. Not part of a version.
  const classifierMode = consoleCreated ? entry?.descriptor?.classifierMode : declared?.classifierMode;
  return {
    ...listing,
    ...(classifierMode === 'keyword' || classifierMode === 'llm' ? { deployedClassifierMode: classifierMode } : {}),
    origin: consoleCreated ? 'console' : 'deployed',
    // WHETHER RETIRE ACCEPTS IT: one with a directory entry that is not a classification's primary (`retire` in
    // `manage-assistants.ts`). The console offers the action exactly where the route takes it.
    retirable: !!entry && retirable(n),
    ...(placed ? { classification: placed.classification, role: placed.role } : {}),
    // One owner when every bot agrees; null when none owns it or they disagree. Omitted when unread.
    ...(identities ? { ownerTeam: owners.length === 1 ? owners[0] : null } : {}),
    ...(displayName ? { displayName } : {}),
    ...(typeof deployedTurnLimit === 'number' ? { deployedTurnLimit } : {}),
  };
}

/** Whether retire accepts an assistant, by the guards it checks: not a classification's primary, not a duel's alt. */
const retirable = (name: string): boolean => !profiles.classificationFor(name) && !profiles.roleOfAlt(name);

/**
 * THE REFUSAL FOR A NAME ANOTHER ASSISTANT IN THE CLASSIFICATION SHOWS, or null when it is free. `@`
 * resolves an assistant by the name it shows, so a create refuses a duplicate and a rename does the same.
 */
async function nameTakenRefusal(profileName: string, displayName: string): Promise<{ error: string; code: string } | null> {
  const classification = classificationServedBy(profileName);
  const holder = await displayNameHolder(ssm, SSM_ROOT, classification, displayName, profileName);
  return holder
    ? { error: `an assistant in ${classification} already shows the name '${displayName.trim()}'`, code: 'ASSISTANT_DISPLAY_NAME_TAKEN' }
    : null;
}

/** Whether an assistant has an active version. */
async function hasActiveVersion(name: string): Promise<boolean> {
  try {
    await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(SSM_ROOT, name)}:active` }));
    return true;
  } catch (err) {
    if (isNoActiveVersion(err)) return false;
    throw err;
  }
}
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const lambdaClient = new LambdaClient({ region: AWS_REGION });

/**
 * WHERE EACH ASSISTANT LIVES IN AWS, for the console's links (`lib/profile-infra.ts`): its classification and
 * role first, because the shared resources are published per classification, then its own identity.
 */
function infraResolver() {
  return createInfraResolver(
    {
      ssm, lambda: lambdaClient,
      chimeIdentity: chimeIdentityClient({ region: AWS_REGION }),
      chimeMessaging: chimeMessagingClient({ region: AWS_REGION }),
      lex: new LexModelsV2Client({ region: AWS_REGION }),
      iam: new IAMClient({ region: AWS_REGION }),
    },
    { ssmRoot: SSM_ROOT, region: AWS_REGION, bodyBucket: bodyBucket() },
  );
}

/** Where an assistant sits and the identities it answers as, from what the listing already read. */
export function infraPlacement(
  name: string,
  entry: DirectoryEntry | undefined,
  identities: AssistantIdentity[] | null,
): InfraPlacement {
  const placed = entry
    ? { classification: entry.classification, role: entry.role }
    : profiles.roleOfAssistant(name) ?? profiles.roleOfAlt(name) ?? undefined;
  const bots = (identities ?? []).filter((i) => i.assistant === name).map((i) => i.botArn);
  return {
    ...(placed ? { classification: placed.classification, role: placed.role } : {}),
    provisioned: !!entry,
    ...(entry?.occupancy === 'alt' || (!entry && profiles.roleOfAlt(name)) ? { alt: true } : {}),
    botArns: bots.length ? bots : entry?.botArn ? [entry.botArn] : [],
    ...(entry?.lexBotId ? { lexBotId: entry.lexBotId } : {}),
  };
}

function catalog() {
  return getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
}

/** The catalog of each classification the listed assistants serve, read once per classification. */
async function classificationCatalogsFor(listed: Array<Record<string, unknown>>): Promise<Record<string, ClassificationCatalog>> {
  const values = [...new Set(listed.map((l) => l.classification).filter((c): c is string => typeof c === 'string' && !!c))];
  const keys = Object.keys(catalog());
  const entries = await Promise.all(values.map(async (c) => [c, await classificationCatalog(ssm, lambdaClient, SSM_ROOT, c, keys)] as const));
  return Object.fromEntries(entries);
}

// ── A DRAFT ANSWERS THE GOLDEN SET BEFORE IT IS ACTIVATED (ADR-065) ─────────────────────────────────────────────
//
// The run and the set are in Aurora, inside the archive's VPC, so they are reached through the classification's own
// GoldenRun function, found by its published key. No key means this deployment has no golden run (Athena mode, or the
// function is not deployed): the gate reads as unavailable and Activate proceeds.

// ONLY A FOUND ARN IS KEPT. A miss is read again next time: caching it would leave the gate open for the life of a warm
// container that read the key before the classification's stack published it.
const goldenRunArns = new Map<string, string>();

async function goldenRunArnFor(classification: string): Promise<string | null> {
  const known = goldenRunArns.get(classification);
  if (known) return known;
  const root = (process.env.GOLDEN_RUN_PARAM_ROOT || '').trim();
  let arn: string | null = null;
  if (root) {
    try {
      arn = (await ssm.send(new GetParameterCommand({ Name: `${root}/${classification}/golden-run-arn` }))).Parameter?.Value || null;
    } catch (err) {
      if ((err as { name?: string })?.name !== 'ParameterNotFound') throw err;
    }
  }
  if (arn) goldenRunArns.set(classification, arn);
  return arn;
}

/**
 * The set's size, the latest run for the draft and the set's coverage of the draft's intents, with the active version's
 * minimum per intent (ADR-065 decision 6); null where there is no golden run to read. The minimum is read from the ACTIVE
 * version here, never from the draft, so a draft cannot lower the bar it is measured against.
 */
async function readGoldenGate(profileName: string, draft: ProfileDefinition, opts: { coverage?: boolean; strict?: boolean } = {}): Promise<GoldenGateRead | null> {
  const classification = classificationServedBy(profileName);
  const arn = await goldenRunArnFor(classification);
  if (!arn) return null;
  // Whether a run is going needs no coverage, so a start does not read the packs and the active version for it.
  if (opts.coverage === false) {
    return askGoldenRun<GoldenGateRead>(arn, { op: 'gate', classification, assistant: profileName, configId: draft.configId });
  }
  // The minimum and the draft's intents read side by side. The minimum is read as Activate reads the active version, so a
  // failure there fails the gate as it would fail the activation.
  const [declared, intents] = await Promise.all([
    storedActiveDefinition(ssm, SSM_ROOT, profileName).then((active) => active.goldenSet?.minRegressionPerIntent).catch((err) => {
      // FOR ACTIVATE A FAILED READ OF THE MINIMUM REFUSES; for the console's view it is said and the rest still shown.
      if (opts.strict !== false) throw err;
      console.warn('[manage-profiles] the active version could not be read for its minimum', { profileName, name: (err as Error)?.name });
      return 'unread' as const;
    }),
    deploymentPackRaw(ssm, SSM_ROOT, profileName).then((packRaw) => servedIntentKeys(draft, packRaw)).catch((err) => err as Error),
  ]);
  const minUnread = declared === 'unread';
  const min = minUnread ? undefined : declared;
  if (intents instanceof Error) {
    // COVERAGE IS A REPORT UNLESS A MINIMUM BINDS IT: with none declared, the gate reads as before and says nothing per
    // intent; with one, a gate that could not count refuses (thrown, so Activate is refused) rather than passes.
    console.warn('[manage-profiles] the draft\'s intents could not be read for coverage', { profileName, name: intents.name });
    if (min) throw intents;
    return askGoldenRun<GoldenGateRead>(arn, { op: 'gate', classification, assistant: profileName, configId: draft.configId });
  }
  // A failed read is not a pass: the gate refuses rather than activating unmeasured.
  const read = await askGoldenRun<GoldenGateRead>(arn, { op: 'gate', classification, assistant: profileName, configId: draft.configId, intents });
  // A MINIMUM THE SET COULD NEVER HOLD ACROSS THIS DRAFT'S INTENTS is held at the most it can: otherwise a draft that adds
  // intents could never be activated, and the minimum is lowered only by activating a version.
  const effective = effectiveMinimum(min, intents.length, GOLDEN_SET_CAPACITY);
  return {
    ...read, intents,
    ...(effective ? { minRegressionPerIntent: effective } : {}),
    ...(min && effective !== min ? { minDeclared: min } : {}),
    ...(minUnread ? { minUnread: true } : {}),
  };
}

/** One RequestResponse call to a classification's GoldenRun function; a function error is thrown, never read as an answer. */
async function askGoldenRun<T>(arn: string, payload: Record<string, unknown>): Promise<T> {
  const out = await lambdaClient.send(new InvokeCommand({
    FunctionName: arn,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  if (out.FunctionError) throw new Error(`the golden set could not be read (${out.FunctionError})`);
  return JSON.parse(Buffer.from(out.Payload ?? new Uint8Array()).toString('utf8')) as T;
}

/**
 * The intents an upload may name: every intent of the pack the assistant's active version serves, and its draft's where it has one,
 * so a team adding an intent in its draft can bring cases for it before it goes live.
 */
async function uploadIntents(profileName: string): Promise<Set<string>> {
  const [sides, packRaw] = await Promise.all([storedRunSides(ssm, SSM_ROOT, profileName), deploymentPackRaw(ssm, SSM_ROOT, profileName)]);
  const active = sides?.active ?? await storedActiveDefinition(ssm, SSM_ROOT, profileName);
  const [activeIntents, draftIntents] = await Promise.all([
    servedIntentKeys(active, packRaw),
    sides ? servedIntentKeys(sides.draft, packRaw) : Promise.resolve([] as string[]),
  ]);
  // THE PACK'S INTENTS, the ones coverage counts and a minimum binds; a universal intent (a greeting) is not measured here.
  return new Set([...activeIntents, ...draftIntents]);
}

/** The intents of the draft's pack, or the active version's where there is no draft, as a turn classifies against them. */
async function generationIntents(profileName: string): Promise<IntentDef[]> {
  // The draft where there is one (read hydrated); the active version is read only when there is none.
  const def = (await getDraft(ssm, SSM_ROOT, profileName)) ?? await hydrateBodies(await storedActiveDefinition(ssm, SSM_ROOT, profileName));
  return def.intentPack ? resolveStoredPack(def.intentPack).intents : parseIntentPack(await deploymentPackRaw(ssm, SSM_ROOT, profileName)).intents;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let uploadS3Client: S3Client | undefined;
const uploadS3 = (): S3Client => (uploadS3Client ??= new S3Client({ region: process.env.AWS_REGION || 'us-east-1' }));

/** The API's own sentence for each upload refusal, for a caller with no console; the console words the code. */
const UPLOAD_REFUSAL_TEXT: Record<string, string> = {
  BAD_FORMAT: 'An upload is JSON Lines (format "jsonl") or CSV (format "csv")',
  EMPTY: 'The file holds no entries',
  TOO_LARGE: 'The file is larger than an upload may be',
  TOO_MANY_LINES: 'The file holds more entries than an upload may',
  BAD_HEADER: 'The CSV header names a column an upload does not have, repeats one, or lacks intent or request',
  INVALID_LINES: 'Some lines of the file are not entries; nothing was stored',
  GOLDEN_SET_FULL: 'The set would hold more live entries than a run can answer; retire some first',
  DETECTOR_UNAVAILABLE: 'This deployment has no detector to de-identify an upload with, so nothing was stored',
  DETECTOR_FAILED: 'The detector could not process some lines, so nothing was stored',
  DETECTOR_BUSY: 'The detector stayed throttled, so nothing was stored; send the file again',
  GENERATION_FAILED: 'The model gave no usable requests for some intents, so nothing was stored; the cause is in the golden run function\'s log',
  UNKNOWN_INTENT: 'Name intents of the draft\'s pack',
  TOO_MANY_INTENTS: 'Name the intents to generate for; one call generates for a limited number',
  NO_INTENTS: 'The draft\'s pack declares no intents to generate for',
  BAD_PER_INTENT: 'perIntent is a whole number within its bounds',
};

/** The persona a version without one answers with in a run: the classification's declared persona, else none. */
function fallbackPersonaFor(classification: string): string {
  return profiles.profileFor(classification)?.defaultPersona?.split('{model}').join('the assistant') ?? '';
}

/**
 * Start the draft's run: mint its id, send both versions' stored definitions to the classification's GoldenRun
 * function as an Event, and answer at once. The run's own row is what the console reads next.
 */
async function startGoldenRun(profileName: string, actor: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const classification = classificationServedBy(profileName);
  const arn = await goldenRunArnFor(classification);
  if (!arn) return { status: 409, body: { error: 'This deployment has no golden run (it runs in Aurora mode only)', code: 'GOLDEN_RUN_UNAVAILABLE' } };
  const sides = await storedRunSides(ssm, SSM_ROOT, profileName);
  if (!sides) return { status: 409, body: { error: 'There is no draft to run', code: 'NO_DRAFT' } };
  // ONE RUN AT A TIME PER DRAFT: a second click, or a second editor, would spend the whole set's model calls again.
  const current = await readGoldenGate(profileName, sides.draft, { coverage: false });
  if (current?.run?.status === 'running' && current.run.draftConfigId === sides.draft.configId) {
    return { status: 409, body: { error: 'A run of this draft is already going', code: 'GOLDEN_RUN_RUNNING', runId: current.run.runId } };
  }
  // A version without a pack of its own answers against the deployment's, which the run cannot read from inside the VPC.
  const packRaw = !sides.draft.intentPack && !sides.draft.intentPackRef || !sides.active.intentPack && !sides.active.intentPackRef
    ? await deploymentPackRaw(ssm, SSM_ROOT, profileName)
    : undefined;
  const runId = randomUUID();
  // A console-created assistant's seed is in its directory record, which the run cannot read from inside the VPC.
  const seed = isRuntimeAssistant(profileName) ? (await readRuntimeAssistant(ssm, SSM_ROOT, profileName))?.seed : undefined;
  // THE RUN'S INPUT TRAVELS AS AN OBJECT, NOT IN THE EVENT: an async invocation's request is repeated in the record its
  // destination sends to EventBridge, which has a size limit and every rule on the bus reads. The event names the key.
  const bucket = bodyBucket();
  if (!bucket) return { status: 503, body: { error: 'This deployment has no body bucket to hand a run over in', code: 'GOLDEN_RUN_UNAVAILABLE' } };
  const inputKey = `${goldenUploadPrefix(classification, profileName)}runs/${runId}.json`;
  const put = await uploadS3().send(new PutObjectCommand({
    Bucket: bucket, Key: inputKey, ContentType: 'application/json',
    Body: JSON.stringify({
      draft: { configId: sides.draft.configId, definition: sides.draft },
      active: { configId: sides.active.configId, definition: sides.active },
      ...(seed ? { seed } : {}),
      fallbackPersona: fallbackPersonaFor(classification),
      ...(packRaw ? { deploymentPackRaw: packRaw } : {}),
    }),
  }));
  await lambdaClient.send(new InvokeCommand({
    FunctionName: arn,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({
      op: 'start', runId, classification, assistant: profileName, startedBy: actor, inputKey,
      ...(put.VersionId ? { inputVersion: put.VersionId } : {}),
    })),
  }));
  return { status: 202, body: { profileName, runId, draftConfigId: sides.draft.configId } };
}

/**
 * The shape reported back for the half of a rename that lands on the identity.
 *
 * `unchanged` is not a failure and `unsupported` is not one either - the second means this
 * deployment has no applier for that assistant, which is the state every deployment was in before
 * the applier existed. Distinguishing them is the point: "the room still says the old name" has
 * three different causes and an operator needs to know which.
 */
type IdentityRenameOutcome = 'applied' | 'unchanged' | 'unsupported' | 'failed';

/**
 * PUT THE ACTIVATED VERSION'S DISPLAY NAME ONTO THE ASSISTANT'S IDENTITY.
 *
 * This role does NOT hold `chime:UpdateAppInstanceBot`, deliberately: that API replaces the bot's
 * whole `Configuration` alongside its name, so holding it would mean the capability for editing
 * behavior also carried the power to repoint the assistant's Amazon Lex wiring. It invokes a function
 * that takes a name and nothing else (`apply-assistant-name.ts`), resolved per assistant from SSM.
 *
 * NEVER FATAL TO THE ACTIVATION, and the ordering is why: the version is already active and
 * immutable by the time this runs, so throwing here would report a failure for work that succeeded
 * and invite a retry that re-publishes. The outcome is REPORTED instead, because the failure mode
 * this replaces - a rename that silently reached the console and not the room - is precisely the one
 * that is invisible when nobody says anything.
 */
async function applyNameToIdentity(
  profileName: string,
  displayName: string | undefined,
): Promise<{ identityRename: IdentityRenameOutcome; identityRenameError?: string }> {
  // NO EARLY RETURN FOR AN ABSENT NAME. This used to report `unchanged` without calling, which made
  // "inherit the configured default" unreachable at the identity: an assistant renamed once kept that
  // custom name forever, while the console read "inherits the provisioned name". The applier resolves
  // absent to its configured default, so activating a version that names nothing puts the provisioned
  // name back - which is what the version is asking for.
  // ONE APPLIER FOR EVERY ASSISTANT (ADR-048, amended 2026-10-23). Every identity is the provisioner's, declared
  // or created in the console, so the admin backend's one applier (`RuntimeApplyAssistantName`) finds it through
  // its directory entry and is granted only identities stamped `provisioner = runtime`. An assistant with no
  // active entry has no identity to rename yet: reported as such, not as a failure.
  const entry = await readDirectoryEntry(ssm, SSM_ROOT, profileName).catch(() => null);
  const applierArn = entry?.status === 'active' ? process.env.RUNTIME_NAME_APPLIER_ARN || undefined : undefined;
  if (!applierArn) return { identityRename: 'unsupported' };
  try {
    const out = await lambdaClient.send(new InvokeCommand({
      FunctionName: applierArn,
      // SYNCHRONOUS, so the caller learns the outcome in the response that reports the activation.
      // An Event invoke would make the rename unobservable at exactly the moment someone is watching.
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ assistant: profileName, displayName })),
    }));
    // A FUNCTION ERROR IS NOT A TRANSPORT ERROR. `Invoke` returns 200 with `FunctionError` set when
    // the applier threw, so reading only the status code would report a failed rename as applied.
    if (out.FunctionError) {
      return { identityRename: 'failed', identityRenameError: out.FunctionError };
    }
    const parsed = out.Payload
      ? (JSON.parse(Buffer.from(out.Payload).toString('utf8')) as {
        applied?: boolean; unsupported?: boolean; error?: string;
      })
      : undefined;
    // UNSUPPORTED IS CHECKED FIRST, because it arrives WITH a reason and is not a failure: the
    // deployment cannot apply a name here (no applier, or nothing configured to inherit), which is a
    // different thing from a rename that broke. Reading the reason first would report every
    // name-less activation as a failed rename to an operator who was changing a model.
    if (parsed?.unsupported) return { identityRename: 'unsupported', identityRenameError: parsed.error };
    if (parsed?.error) return { identityRename: 'failed', identityRenameError: parsed.error };
    return { identityRename: parsed?.applied ? 'applied' : 'unchanged' };
  } catch (err: any) {
    return { identityRename: 'failed', identityRenameError: err?.message || String(err) };
  }
}

/**
 * The selectable guardrails a profile may reference, as published by the assistant-profile stack at
 * `${SSM_ROOT}/assistant/{profileName}/guardrails` (SPEC-CONFIGURABLE-ASSISTANTS 4.6b). Used by import
 * to reject-or-remap a guardrail selection that came from another deployment.
 *
 * Throws on an unreadable/absent/malformed catalog rather than returning [] — importManifest fails
 * CLOSED on a throw, and an empty array would read as "this instance provisions no guardrails", which
 * would reject every selection with a misleading reason.
 */
async function guardrailCatalogFor(profileName: string): Promise<Array<{ key: string; guardrailId: string }>> {
  const name = `${SSM_ROOT}/assistant/${classificationServedBy(profileName)}/guardrails`;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const raw = res.Parameter?.Value;
  if (!raw) throw new Error(`${name} is empty`);
  const parsed = JSON.parse(raw) as Array<{ key?: string; guardrailId?: string }>;
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a JSON array`);
  return parsed
    .filter((g) => typeof g.key === 'string' && typeof g.guardrailId === 'string')
    .map((g) => ({ key: g.key as string, guardrailId: g.guardrailId as string }));
}
/**
 * The target's published context source catalog, for import validation
 * (SPEC-CONTEXT-SOURCES-AND-STORES §6).
 *
 * THROWS on an absent/unreadable/malformed parameter, deliberately and exactly like
 * `guardrailCatalogFor`: import treats a throw as "cannot verify this selection" and fails closed.
 * Returning an empty array instead would read as "this instance publishes nothing", which silently
 * rejects every key for the wrong reason - or, worse, would let a future caller treat it as no
 * constraint at all.
 */
async function contextSourceCatalogFor(
  profileName: string,
): Promise<TargetContextSource[]> {
  const name = `${SSM_ROOT}/assistant/${classificationServedBy(profileName)}/context-sources`;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const raw = res.Parameter?.Value;
  if (!raw) throw new Error(`${name} is empty`);
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a JSON array`);
  return parsed
    .filter((s) => typeof s.key === 'string')
    .map((s) => ({
      key: s.key as string,
      fields: s.fields as TargetContextSource['fields'],
      contractVersion: typeof s.contractVersion === 'string' ? s.contractVersion : undefined,
      // What a version's variables are checked against (ADR-060): the published trust, person flag and availability.
      ...(typeof s.title === 'string' ? { title: s.title } : {}),
      ...(s.trust === 'platform' || s.trust === 'operator' || s.trust === 'member' ? { trust: s.trust } : {}),
      ...(typeof s.describesPerson === 'boolean' ? { describesPerson: s.describesPerson } : {}),
      ...(s.availability === 'always' || s.availability === 'identity-settled' || s.availability === 'conversation-settled' ? { availability: s.availability } : {}),
    }));
}

/**
 * WHICH ROLE AN EXPERIMENT COMPARES TWO VERSIONS OF (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5).
 *
 * A battle's challenger is the alt of its one classification's primary role (`DUEL_ROLE`, §3.7). A
 * `profile` experiment names its assistant on the control's `profileRef`. Any other experiment varies the
 * primary role of its one classification. A caller may name the assistant itself (`/variant-version`).
 */
function roleForCandidate(
  exp: Record<string, unknown>,
  namedAssistant: string,
): { classification: string; role: string } | undefined {
  const runsIn = Array.isArray(exp.tiers) ? exp.tiers.map(String) : [];
  const challenger = challengerOf(exp as Parameters<typeof challengerOf>[0]);
  if (exp.battleEnabled === true && challenger) {
    return runsIn.length === 1 ? { classification: runsIn[0], role: DUEL_ROLE } : undefined;
  }
  if (namedAssistant) return profiles.roleOfAssistant(namedAssistant);
  if (exp.experimentType === 'profile') {
    const variants = Array.isArray(exp.variants) ? exp.variants as Array<{ profileRef?: { profileName?: unknown } }> : [];
    const named = variants[0]?.profileRef?.profileName;
    return typeof named === 'string' ? profiles.roleOfAssistant(named) : undefined;
  }
  return runsIn.length === 1 ? { classification: runsIn[0], role: DUEL_ROLE } : undefined;
}

/** The experiment row a candidate is derived for, or null when it does not exist. */
async function readExperimentForCandidate(experimentId: string): Promise<Record<string, unknown> | null> {
  const table = process.env.EXPERIMENTS_TABLE || '';
  if (!table) throw new Error('EXPERIMENTS_TABLE is not set');
  const res = await ddb.send(new GetCommand({ TableName: table, Key: { experimentId } }));
  return (res.Item as Record<string, unknown> | undefined) ?? null;
}

/**
 * WHAT A VARIANT MAY CHANGE, by the experiment's type (ADR-050). A `profile` experiment pits two whole
 * definitions against each other, so any field but the intents may differ. Every other type varies one
 * thing - a model - so its candidate may change only the model selections and the persona addendum; a
 * persona or tool change there would be a second variable in a one-variable experiment. The display name
 * is not among them: a battle's aliases live on the experiment row, never in a version (§3.5).
 */
const NON_PROFILE_PATCH_KEYS = new Set(['models', 'modelKey', 'systemPromptAddendum']);

/**
 * WHICH DUEL SIDE A VARIANT IS: a battle's `variants[0]` is the control (the live assistant) and
 * `variants[1]` the treatment (the alt). Undefined for an experiment that is not a battle, whose
 * candidate is the alt's as before.
 */
export function battleSideOfVariant(exp: Record<string, unknown>, variantId: string): 'control' | 'treatment' | undefined {
  if (exp.battleEnabled !== true) return undefined;
  const variants = Array.isArray(exp.variants) ? exp.variants as Array<{ variantId?: unknown }> : [];
  const at = variants.findIndex((v) => v?.variantId === variantId);
  return at === 0 ? 'control' : at === 1 ? 'treatment' : undefined;
}

/** The route an `intent` experiment's recipe changes: the route keyed by the experiment's intent (ADR-064 decision 1). */
export function recipeRouteKey(exp: Record<string, unknown>): string {
  return typeof exp.intent === 'string' && exp.intent ? exp.intent : GENERAL_ROUTE_KEY;
}

/** The image route an experiment's `imageGenModelKey` names (`experiment-image-route.ts`), the route a duel side reads back. */
export { imageRouteKeyOf };

/**
 * THE TYPE'S RECIPE: THE DELTA A VARIANT APPLIES TO ITS ROLE'S LIVE BODY, read from the experiment row
 * (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5).
 *
 * - `modelKey`, by the experiment's type:
 *   - `intent`: `models.byIntent[<intent>].primary` only; every other route, the route's fallback and the
 *     base model are the control's. An intent that needs an image takes no text route (its model is
 *     the `imageGenModelKey`).
 *   - `base_model`: the base model.
 *   - `classification`: `models.classifier`.
 * - `profileRef`: the whole referenced version, handed back as `fromProfileRef` for the caller to read.
 * - `systemPromptAddendum`: carried as it is.
 * - `imageGenModelKey`: the primary of the image route (`models.byIntent[<image intent>]`, by default
 *   `image_generation`); the route's fallback is the control's.
 *
 * A variant carries no name: a duel side is named from its version (`battleSideNames`), so nothing about a
 * name is derived here.
 */
export function variantDeltaOf(
  exp: Record<string, unknown>,
  variantId: string,
): { patch: Partial<ProfileDefinitionBody>; fromProfileRef?: { profileName: string; version?: number } } {
  const variants = Array.isArray(exp.variants) ? exp.variants as Array<Record<string, unknown>> : [];
  const v = variants.find((x) => x?.variantId === variantId);
  if (!v) return { patch: {} };
  const models: Record<string, unknown> = {};
  const patch: Partial<ProfileDefinitionBody> = {};
  if (typeof v.modelKey === 'string' && v.modelKey) {
    const type = exp.experimentType ?? 'intent';
    if (type === 'classification') models.classifier = v.modelKey;
    else if (type === 'intent') {
      // THE TARGET DECIDES WHICH ONE MODEL OF THE INTENT CHANGES (ADR-064 decision 6): a step's override, the image part,
      // or the text model.
      const target = (exp.target ?? {}) as { kind?: string; step?: string };
      const route = target.step
        ? { steps: { [target.step]: { primary: v.modelKey } } }
        : target.kind === 'image' ? { image: { primary: v.modelKey } } : { primary: v.modelKey };
      models.byIntent = { [recipeRouteKey(exp)]: route };
    } else patch.modelKey = v.modelKey;
  }
  // THE IMAGE MODEL IS THE ROUTE'S IMAGE PART (ADR-064 decision C): the experiment's intent when it needs an image, else
  // `image_generation`. The route's fallback is the control's (`publishVariantVersion` merges route fields).
  if (typeof v.imageGenModelKey === 'string' && v.imageGenModelKey) {
    const byIntent = (models.byIntent ?? {}) as Record<string, Record<string, unknown>>;
    const key = imageRouteKeyOf(exp);
    models.byIntent = { ...byIntent, [key]: { ...(byIntent[key] ?? {}), image: { primary: v.imageGenModelKey } } };
  }
  if (Object.keys(models).length) patch.models = models as ProfileDefinitionBody['models'];
  if (typeof v.systemPromptAddendum === 'string' && v.systemPromptAddendum) patch.systemPromptAddendum = v.systemPromptAddendum;
  const ref = v.profileRef as { profileName?: unknown; version?: unknown } | undefined;
  return {
    patch,
    ...(ref && typeof ref.profileName === 'string' && ref.profileName
      ? { fromProfileRef: { profileName: ref.profileName, ...(Number.isInteger(ref.version) ? { version: ref.version as number } : {}) } }
      : {}),
  };
}

export function candidateRefusal(
  exp: Record<string, unknown> | null,
  variantId: string,
  classification: string,
  patch: Partial<ProfileDefinitionBody>,
): { status: number; error: string; code: string } | null {
  if (!exp) return { status: 404, error: 'No experiment with that id', code: 'EXPERIMENT_NOT_FOUND' };
  const status = String(exp.status ?? '');
  if (status === 'completed' || status === 'deleted') {
    return { status: 409, error: `The experiment is ${status}; it derives no new candidate`, code: 'EXPERIMENT_ENDED' };
  }
  const variants = Array.isArray(exp.variants) ? exp.variants as Array<{ variantId?: unknown }> : [];
  if (!variants.some((v) => v?.variantId === variantId)) {
    return { status: 404, error: 'That experiment has no such variant', code: 'VARIANT_NOT_FOUND' };
  }
  const runsIn = Array.isArray(exp.tiers) ? exp.tiers.map(String) : [];
  if (!runsIn.includes(classification)) {
    return { status: 409, error: `The experiment does not run in '${classification}'`, code: 'EXPERIMENT_NOT_IN_CLASSIFICATION' };
  }
  if ((exp.experimentType ?? 'intent') !== 'profile') {
    const extra = Object.keys(patch).filter((k) => !NON_PROFILE_PATCH_KEYS.has(k));
    if (extra.length) {
      return {
        status: 422,
        error: `A ${String(exp.experimentType ?? 'intent')} experiment varies the model; it may not change ${extra.join(', ')}`,
        code: 'PATCH_OUTSIDE_EXPERIMENT_TYPE',
      };
    }
  }
  return null;
}

/** One side's pin, as the experiment row stores it. */
/** One side's pin, with the version's configId so a pick or a result can name the version without reading it. */
export interface SidePin { profileName: string; version: number; configId?: string }

/** What the experiments handler asks of this function when it arms an experiment (`deriveExperimentVersions`). */
export interface DeriveExperimentVersionsEvent {
  aeDeriveExperimentVersions: {
    /** The experiment row as it will be stored, pins it already carries included. */
    experiment: Record<string, unknown>;
    /** The person arming it, for the audit line. */
    actor: string;
  };
}

/** The same request under the name the experiments handler sent while only battles were armed this way. */
export interface DeriveBattleSidesEvent {
  aeDeriveBattleSides: DeriveExperimentVersionsEvent['aeDeriveExperimentVersions'];
}

export type DeriveExperimentVersionsResult =
  | { ok: true; controlPin: SidePin; altPin: SidePin }
  | { ok: false; status: number; error: string; code: string };
export type DeriveBattleSidesResult = DeriveExperimentVersionsResult;

/** A model key, unless it is blank or the `'default'` sentinel. */
function concreteKey(key: unknown): string | undefined {
  return typeof key === 'string' ? concreteModel(key) : undefined;
}

/** The live body's base model, the classification default when the version tracks it. */
function baseModelOf(live: ProfileDefinitionBody, classification: string): string | undefined {
  return concreteKey(live.models?.default) ?? concreteKey(live.modelKey)
    ?? profiles.defaultModelOf(classification);
}

/**
 * WHY THE CONTROL VARIANT IS NOT THE LIVE ACTIVE VERSION, or null when it is (§3.5).
 *
 * The control of an `intent`, `base_model` or `classification` experiment IS the live assistant's active
 * version, so a control variant that names something else describes a comparison that will not run. A
 * control variant may leave its model unnamed (it is the live version by definition); one that names a
 * model, an addendum or an image model must name what the live version serves for that type. Comparing two
 * configurations neither of which is live is a `profile` experiment with two referenced versions.
 */
export function controlMismatch(
  exp: Record<string, unknown>,
  live: ProfileDefinitionBody,
  classification: string,
): string | null {
  const variants = Array.isArray(exp.variants) ? exp.variants as Array<Record<string, unknown>> : [];
  const control = variants[0] ?? {};
  const type = String(exp.experimentType ?? 'intent');
  if (type === 'profile') return null;
  const named = concreteKey(control.modelKey);
  if (named) {
    let liveValue: string | undefined;
    let what: string;
    const intent = typeof exp.intent === 'string' ? exp.intent : '';
    if (type === 'classification') {
      liveValue = concreteKey(live.models?.classifier);
      what = 'classifier (models.classifier)';
    } else if (type === 'intent' && (exp.target as { step?: string } | undefined)?.step) {
      const step = (exp.target as { step: string }).step;
      liveValue = concreteKey(live.models?.byIntent?.[recipeRouteKey(exp)]?.steps?.[step]?.primary);
      what = `model for ${recipeRouteKey(exp)}'s step ${step}`;
    } else if (type === 'intent' && (exp.target as { kind?: string } | undefined)?.kind === 'image') {
      liveValue = imageRouteFor(live.models, recipeRouteKey(exp))?.primary;
      what = `image model for ${recipeRouteKey(exp)}`;
    } else if (type === 'intent') {
      liveValue = concreteKey(live.models?.byIntent?.[recipeRouteKey(exp)]?.primary) ?? baseModelOf(live, classification);
      what = `model for ${recipeRouteKey(exp)}`;
    } else {
      liveValue = baseModelOf(live, classification);
      what = 'base model';
    }
    if (named !== liveValue) {
      return `the control names '${named}' but the live assistant's ${what} is ${liveValue ? `'${liveValue}'` : 'the deployment default'}; `
        + "leave the control's model unset, or name the live one";
    }
  }
  const addendum = typeof control.systemPromptAddendum === 'string' ? control.systemPromptAddendum : '';
  if (addendum && addendum !== (live.systemPromptAddendum ?? '')) {
    return 'the control carries a persona addendum the live version does not; a change belongs on the treatment';
  }
  const image = concreteKey(control.imageGenModelKey);
  // The live image model is that route's primary, the legacy `models.image` included (`imageRouteFor`).
  const liveImage = imageRouteFor(live.models, imageRouteKeyOf(exp))?.primary;
  if (image && image !== liveImage) {
    return `the control names image model '${image}' but the live version's is ${liveImage ? `'${liveImage}'` : 'unset'}`;
  }
  return null;
}

/**
 * A BATTLE OF AN INTENT THAT DRAWS AN IMAGE IS ARMED ONLY WITH AN IMAGE MODEL ON BOTH SIDES (ADR-064 decision 7): the
 * intent needs an image, or its workflow has a step that produces one, and each pinned version's route for it names an
 * image model (the treatment's is the control's merged with its recipe). Null when it may be armed.
 */
export function battleImageRefusal(
  exp: Record<string, unknown>,
  controlModels: ProfileDefinitionBody['models'] | undefined,
  treatmentPatch: Partial<ProfileDefinitionBody>,
  machines: Record<string, TaskStateMachine>,
): string | null {
  if (exp.battleEnabled !== true) return null;
  const intent = typeof exp.intent === 'string' && exp.intent ? exp.intent : IMAGE_ROUTE_KEY;
  const drawsImage = needsOfIntent(intent) === 'image'
    || Object.values(machines[intent]?.states ?? {}).some((d) => stepOutputOf(d) === 'image');
  if (!drawsImage) return null;
  const control = imageRouteFor(controlModels, intent);
  const treatment = imageRouteFor(treatmentPatch.models, intent) ?? control;
  const missing = [!control && 'control', !treatment && 'treatment'].filter(Boolean);
  return missing.length
    ? `${intent} draws an image, and the ${missing.join(' and ')} version${missing.length > 1 ? 's name' : ' names'} no image model for it; `
      + `set models.byIntent['${intent}'].image on the live version, or arm with an image model on both variants`
    : null;
}

/**
 * ARMING AN EXPERIMENT PINS ITS TWO VERSIONS (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5, ADR-050).
 *
 * The experiments handler invokes this function directly when any experiment is armed, battle or not, so
 * an operator arms in one action and no caller restates a variant as a patch.
 *
 * - CONTROL (variants[0]): the live assistant's ACTIVE version, pinned by number. Nothing is published
 *   under the live name. A control variant that differs from it is refused (`controlMismatch`). A `profile`
 *   experiment's control is its referenced version, pinned by number; two referenced versions compare two
 *   non-live configurations, record a decision, and are never promoted.
 * - TREATMENT (variants[1]): a candidate derived from the control by the type's recipe (`variantDeltaOf`)
 *   and published in the candidate history, the role's alt `alt-{role}-{classification}`
 *   (`publishVariantVersion`). A pin that still says the same thing is reused rather than republished.
 *
 * THE WRITER OF EVERY PROFILE STAYS THIS FUNCTION (§7). A derivation takes no patch: it can publish only what
 * the experiment's own variants already say. The same validation an operator's edit goes through applies,
 * and the experiment-type rule applies (`candidateRefusal`).
 */
export async function deriveExperimentVersions(
  req: DeriveExperimentVersionsEvent['aeDeriveExperimentVersions'],
): Promise<DeriveExperimentVersionsResult> {
  const exp = req?.experiment ?? {};
  const actor = typeof req?.actor === 'string' && req.actor ? req.actor : 'experiments';
  const fail = (status: number, error: string, code: string): DeriveExperimentVersionsResult => ({ ok: false, status, error, code });
  const experimentId = typeof exp.experimentId === 'string' ? exp.experimentId : '';
  const variants = Array.isArray(exp.variants) ? exp.variants as Array<Record<string, unknown>> : [];
  const runsIn = Array.isArray(exp.tiers) ? exp.tiers.map(String) : [];
  if (!experimentId) return fail(400, 'The experiment has no id', 'EXPERIMENT_ID_REQUIRED');
  if (variants.length !== 2) {
    return fail(400, 'An experiment compares two versions of one assistant: a control and a treatment', 'EXPERIMENT_TWO_VERSIONS');
  }
  if (runsIn.length !== 1) {
    return fail(400, 'An experiment compares two versions of one assistant, so it runs in exactly one classification', 'EXPERIMENT_ONE_CLASSIFICATION');
  }
  const assignment = roleForCandidate(exp, '');
  const baseProfile = assignment ? profiles.roleAssistantName(assignment.classification, assignment.role) : undefined;
  if (!assignment || !baseProfile) return fail(400, 'The experiment names no assistant role this deployment declares', 'NO_ALT_FOR_ROLE');
  if (assignment.classification !== runsIn[0]) {
    return fail(400, `The experiment's assistant serves ${assignment.classification}, not ${runsIn[0]}`, 'VARIANT_PROFILE_REF_CLASSIFICATION');
  }
  const altProfile = profiles.altAssistantName(assignment.classification, assignment.role);
  if (!altProfile) return fail(400, "The experiment's role has no alt to hold its candidate", 'NO_ALT_FOR_ROLE');
  const type = String(exp.experimentType ?? 'intent');
  const [control, treatment] = variants;

  // ── CONTROL: a reference, never a publish ──────────────────────────────────────────────────────
  let controlPin: SidePin;
  if (type === 'profile') {
    const ref = control.profileRef as { profileName?: unknown; version?: unknown } | undefined;
    if (!ref || typeof ref.profileName !== 'string') return fail(400, "A profile experiment's control references a version", 'VARIANT_MODEL_KEY_REQUIRED');
    const version = await concreteProfileVersion(ssm, SSM_ROOT, {
      profileName: ref.profileName, ...(Number.isInteger(ref.version) ? { version: ref.version as number } : {}),
    });
    const controlVersion = version === null ? null : await lookupProfileVersion(ssm, SSM_ROOT, { profileName: ref.profileName, version });
    if (version === null || !controlVersion) return fail(404, `The control's version of ${ref.profileName} does not exist`, 'FROM_PROFILE_REF_NOT_FOUND');
    controlPin = { profileName: ref.profileName, version, configId: controlVersion.configId };
  } else {
    const live = await readActiveVersion(ssm, SSM_ROOT, baseProfile);
    if (!live) {
      return fail(409, `${baseProfile} has no active version to pin as the control; activate one in the Profiles tab first`, 'CONTROL_HAS_NO_ACTIVE_VERSION');
    }
    const mismatch = controlMismatch(exp, live.body, assignment.classification);
    if (mismatch) return fail(409, `The control must be the live assistant's active version: ${mismatch}`, 'CONTROL_DIFFERS_FROM_LIVE');
    controlPin = { profileName: baseProfile, version: live.version, configId: live.configId };
  }

  // ── TREATMENT: a candidate in the alt's history ────────────────────────────────────────────────
  const variantId = String(treatment.variantId ?? '');
  const delta = variantDeltaOf(exp, variantId);
  let patch = delta.patch;
  if (delta.fromProfileRef) {
    const source = await lookupProfileVersion(ssm, SSM_ROOT, delta.fromProfileRef);
    if (!source) return fail(404, `The ${variantId} variant's profile version does not exist`, 'FROM_PROFILE_REF_NOT_FOUND');
    // Hydrated, so an offloaded persona is copied rather than left to the live one.
    const { intentPack: _intents, ...rest } = bodyFrom(await hydrateBodies(source));
    void _intents;
    patch = { ...rest, ...patch, ...(patch.models ? { models: { ...(rest.models ?? {}), ...patch.models } } : {}) };
  }
  const refusal = candidateRefusal(exp, variantId, assignment.classification, patch);
  if (refusal) return fail(refusal.status, refusal.error, refusal.code);
  const controlBody = await lookupProfileVersion(ssm, SSM_ROOT, { profileName: controlPin.profileName, version: controlPin.version });
  const imageRefusal = battleImageRefusal(exp, controlBody ? bodyFrom(controlBody).models : undefined, patch, taskStateMachines());
  if (imageRefusal) return fail(409, imageRefusal, 'BATTLE_SIDE_HAS_NO_IMAGE_MODEL');
  const prior = treatment.altPin as Partial<SidePin> | undefined;
  const existingVersion = prior?.profileName === altProfile && Number.isInteger(prior.version) ? prior.version : undefined;
  const r = await publishVariantVersion(
    ssm, SSM_ROOT, { baseProfile, targetProfile: altProfile }, patch, catalog(), actor,
    { experimentId, variantId }, existingVersion, contextSourceCatalogFor, guardrailCatalogFor,
  );
  return { ok: true, controlPin, altPin: { profileName: r.profileName, version: r.version, configId: r.configId } };
}

/** The name this request had while only battles were armed this way. */
export const deriveBattleSides = deriveExperimentVersions;

/** What the experiments handler asks of this function when an operator promotes an experiment's treatment. */
export interface PromoteCandidateEvent {
  aePromoteCandidate: {
    /** The experiment row, its pins included. */
    experiment: Record<string, unknown>;
    /** The person promoting, for the audit line. */
    actor: string;
  };
}

export type PromoteCandidateResult =
  | {
    ok: true; profileName: string; version: number; configId: string;
    promotedFrom: { profileName: string; version: number; experimentId: string };
    identityRename?: string;
  }
  | { ok: false; status: number; error: string; code: string };

/**
 * PROMOTE AN EXPERIMENT'S MEASURED CANDIDATE INTO THE LIVE ASSISTANT (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6).
 *
 * Read from the experiment row: the control pin names the live assistant and the version measured against,
 * the treatment's `altPin` the candidate. `promoteCandidate` refuses when the live active version moved and
 * when the copy does not hash to the candidate's `configId`, before any write. On success the new version is
 * active and its display name is applied to the identity, as `/activate` does.
 */
export async function promoteExperimentCandidate(req: PromoteCandidateEvent['aePromoteCandidate']): Promise<PromoteCandidateResult> {
  const exp = req?.experiment ?? {};
  const actor = typeof req?.actor === 'string' && req.actor ? req.actor : 'experiments';
  const fail = (status: number, error: string, code: string): PromoteCandidateResult => ({ ok: false, status, error, code });
  const experimentId = typeof exp.experimentId === 'string' ? exp.experimentId : '';
  const variants = Array.isArray(exp.variants) ? exp.variants as Array<Record<string, unknown>> : [];
  const controlPin = variants[0]?.controlPin as Partial<SidePin> | undefined;
  const altPin = variants[1]?.altPin as Partial<SidePin> | undefined;
  if (!experimentId || !controlPin?.profileName || !Number.isInteger(controlPin.version)
    || !altPin?.profileName || !Number.isInteger(altPin.version)) {
    return fail(409, 'The experiment does not pin two versions, so there is no measured candidate to promote', 'PROMOTION_NEEDS_TWO_VERSIONS');
  }
  const assignment = roleForCandidate(exp, '');
  const live = assignment ? profiles.roleAssistantName(assignment.classification, assignment.role) : undefined;
  if (!live || controlPin.profileName !== live) {
    return fail(409, "The control is not the live assistant's version, so the experiment records a decision and promotes nothing", 'PROMOTION_CONTROL_NOT_LIVE');
  }
  try {
    const r = await promoteCandidate(ssm, SSM_ROOT, {
      liveProfile: live,
      candidate: { profileName: altPin.profileName, version: altPin.version as number },
      controlVersion: controlPin.version as number,
      experimentId,
    }, actor);
    // The identity wears the name of what is serving, as after `/activate`.
    const identity = await applyNameToIdentity(live, r.displayName);
    return {
      ok: true, profileName: live, version: r.version, configId: r.configId,
      promotedFrom: { profileName: altPin.profileName, version: altPin.version as number, experimentId },
      identityRename: identity.identityRename,
    };
  } catch (err) {
    if (err instanceof PromotionRefusedError) return fail(409, err.message, err.code);
    if (err instanceof ProfileValidationError) return fail(422, err.message, 'PROMOTION_INVALID');
    throw err;
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  // THE EXPERIMENTS HANDLER'S DIRECT INVOKES, never an API Gateway request (which always carries a method).
  // `aeDeriveBattleSides` is the name the derivation had while only battles were armed this way; an
  // experiments handler deployed before this one still sends it.
  const direct = event as unknown as Partial<DeriveExperimentVersionsEvent & DeriveBattleSidesEvent & PromoteCandidateEvent>;
  const derive = direct.aeDeriveExperimentVersions ?? direct.aeDeriveBattleSides;
  if (derive && !event.httpMethod) {
    try {
      return await deriveExperimentVersions(derive) as unknown as APIGatewayProxyResult;
    } catch (err) {
      const status = err instanceof ProfileValidationError ? 422 : 500;
      console.error('[manage-profiles] experiment version derivation failed', { err: (err as Error)?.message });
      return { ok: false, status, error: (err as Error)?.message || 'derivation failed', code: 'DERIVATION_FAILED' } as unknown as APIGatewayProxyResult;
    }
  }
  // THE ALT'S IDENTITY WEARS THE CHALLENGER'S DUEL NAME WHILE AN EXPERIMENT HOLDS IT (§3.5), its profile's
  // name as `battleSideNames` settles it, and its provisioned name again when it is released (no name sent). Only an alt: the live identity's name is its
  // active version's and never changes for a battle.
  const alias = (event as unknown as { aeApplyAltAlias?: { alt?: unknown; alias?: unknown } }).aeApplyAltAlias;
  if (alias && !event.httpMethod) {
    const alt = typeof alias.alt === 'string' ? alias.alt : '';
    if (!alt || !profiles.roleOfAlt(alt)) {
      return { identityRename: 'failed', identityRenameError: 'only an alt wears a battle name' } as unknown as APIGatewayProxyResult;
    }
    return await applyNameToIdentity(alt, typeof alias.alias === 'string' && alias.alias ? alias.alias : undefined) as unknown as APIGatewayProxyResult;
  }
  // A CONSOLE-CREATED ASSISTANT'S FIRST DRAFT, asked for by `manage-assistants` when its build finishes.
  // It names an assistant and nothing else, and seeds only a runtime assistant with no version and no draft,
  // so an invoke can add a draft to an empty assistant and change nothing that exists.
  const startCheck = (event as unknown as { aeCheckStartingPoint?: Record<string, unknown> }).aeCheckStartingPoint;
  if (startCheck && !event.httpMethod) {
    const shape = startingPointErrors(startCheck.startingPoint);
    if (shape.length) return { errors: shape } as unknown as APIGatewayProxyResult;
    const choices = (startCheck.choices && typeof startCheck.choices === 'object' ? startCheck.choices : {}) as StartingChoices;
    return await checkStartingPoint({
      assistant: String(startCheck.assistant ?? ''),
      classification: String(startCheck.classification ?? ''),
      startingPoint: startingPointOf(startCheck.startingPoint),
      choices,
    }) as unknown as APIGatewayProxyResult;
  }
  const firstDraft = (event as unknown as { aeSeedFirstDraft?: { assistant?: unknown; actor?: unknown; startingPoint?: unknown } }).aeSeedFirstDraft;
  if (firstDraft && !event.httpMethod) {
    const assistant = typeof firstDraft.assistant === 'string' ? firstDraft.assistant : '';
    try {
      if (!(await learnRuntimeAssistant(assistant))) {
        return { seeded: false, reason: `'${assistant}' is not an active runtime assistant` } as unknown as APIGatewayProxyResult;
      }
      const actor = typeof firstDraft.actor === 'string' && firstDraft.actor ? firstDraft.actor : 'manage-assistants';
      return await landFirstDraft(assistant, startingPointOf(firstDraft.startingPoint), actor) as unknown as APIGatewayProxyResult;
    } catch (err) {
      console.error('[manage-profiles] the first draft could not be seeded', { assistant, err: (err as Error)?.message });
      return { seeded: false, error: (err as Error)?.message || 'seed failed' } as unknown as APIGatewayProxyResult;
    }
  }
  if (direct.aePromoteCandidate && !event.httpMethod) {
    try {
      return await promoteExperimentCandidate(direct.aePromoteCandidate) as unknown as APIGatewayProxyResult;
    } catch (err) {
      console.error('[manage-profiles] promotion failed', { err: (err as Error)?.message });
      return { ok: false, status: 500, error: (err as Error)?.message || 'promotion failed', code: 'PROMOTION_FAILED' } as unknown as APIGatewayProxyResult;
    }
  }
  const origin = event.headers?.origin || event.headers?.Origin;
  const method = event.httpMethod;
  const path = event.path || '';
  const respond = (code: number, body: unknown) => authRespond(code, body, origin);

  if (method === 'OPTIONS') return respond(200, { ok: true });

  // A14: the routes are AWS_IAM, and the gateway already vetted the signed principal's
  // `manage-profiles` teeth (callerCanManageProfiles → isTrustedIamAdminCall). The actor is the person
  // the session names, or the signing principal, so the audit has a real subject.
  const sub = await callerActor(event);
  if (!sub) return respond(401, { error: 'Unauthorized' });
  // `manage-profiles` is a DISTINCT capability from view-* — versioning/import an assistant is
  // separately denyable (§7 / A14). Default = admins; narrow via MANAGE_PROFILES_GROUP_NAMES.
  if (!callerCanManageProfiles(event)) {
    console.warn('[manage-profiles] caller lacks manage-profiles capability', { sub });
    return respond(403, { error: 'manage-profiles capability required' });
  }

  // A TEAM MEMBER'S ROUTE NAMES ONE ASSISTANT (SPEC-ADMIN-CONSOLE FR48). Every read and write below is
  // bound to it: the listing is that assistant alone, and a body naming another is refused rather
  // than quietly redirected, because a mismatch means the caller asked for something else.
  const scope = await requireOwnedAssistant(event, origin);
  if (isRefusal(scope)) return scope;

  try {
    if (method === 'GET') {
      // Each listing is augmented with `resolved` — the live infra identifiers (processor Lambda, its role,
      // its guardrail) for the console's AWS deep links. Best-effort; a resolve failure just omits the links.
      // Every declared assistant, then every ACTIVE runtime one from the directory (ADR-048). A team
      // member's scope is one name, compiled or runtime, and is learned the same way.
      let names = scope ? [scope.assistant] : allProfileNames();
      // An unreadable directory lists the declared assistants and SAYS the runtime ones are missing,
      // rather than failing the whole listing or presenting a partial one as complete.
      let runtimeDirectoryUnreadable = false;
      // EVERY RUNTIME ASSISTANT AND ITS STATE, for the roster: one being created, one whose create
      // failed and what it left behind, and the retired tombstones. Admins only; a team member's
      // listing is their one assistant.
      let roster: Array<{ assistant: string; classification: string; role: string; status: string; origin?: string; retirable?: boolean; displayName?: string; ownerTeam?: string; error?: string; leftover?: string[] }> = [];
      // The directory entries of the runtime assistants listed, for what each row says about itself.
      const runtimeEntries = new Map<string, DirectoryEntry>();
      if (scope) {
        if (await learnRuntimeAssistant(scope.assistant)) {
          const entry = await readDirectoryEntry(ssm, SSM_ROOT, scope.assistant).catch(() => null);
          if (entry) runtimeEntries.set(scope.assistant, entry);
        }
      } else {
        try {
          const directory = await listDirectory(ssm, SSM_ROOT);
          for (const [n, e] of directory) runtimeEntries.set(n, e);
          // A DUEL'S ALT IS NOT A ROW: it is no one's to manage, and it is removed with its duel.
          roster = [...directory].filter(([, e]) => e.occupancy !== 'alt').map(([assistant, stored]) => ({ assistant, e: withAbandonedBuild(stored) })).map(({ assistant, e }) => ({
            assistant, classification: e.classification, role: e.role, status: e.status,
            origin: e.origin ?? 'console',
            retirable: retirable(assistant),
            ...(e.displayName ? { displayName: e.displayName } : {}),
            ...(e.ownerTeam ? { ownerTeam: e.ownerTeam } : {}),
            ...(e.error ? { error: e.error } : {}),
            ...(e.leftover?.length ? { leftover: e.leftover } : {}),
            ...(e.ownerSeedError ? { ownerSeedError: e.ownerSeedError } : {}),
            ...(e.firstDraftError ? { firstDraftError: e.firstDraftError } : {}),
          }));
          const active = [...directory].filter(([, e]) => e.status === 'active').map(([n]) => n);
          const learned = await Promise.all(active.map(async (n) => ((await learnRuntimeAssistant(n)) ? n : '')));
          // A DECLARED ASSISTANT RETIRED IN THE CONSOLE is listed by its tombstone, as a retired console-created one
          // is, not as a profile to open: a deploy does not recreate it.
          const gone = new Set([...directory].filter(([, e]) => e.status === 'retired' || e.status === 'retiring').map(([n]) => n));
          names = [...names.filter((n) => !gone.has(n)), ...learned.filter(Boolean)];
        } catch (err) {
          runtimeDirectoryUnreadable = true;
          console.error('[manage-profiles] the runtime assistant directory could not be read; listing declared assistants only', {
            err: (err as Error)?.name,
          });
        }
      }
      const identities = await assistantIdentities(scope ? scope.bots : null);
      // One resolver per listing, so each classification's shared resources are read once.
      const resolveInfra = infraResolver();
      const listed = await Promise.all(
        names.map(async (n) => describeAssistant(
          { ...(await listProfile(ssm, SSM_ROOT, n)), resolved: await resolveInfra(n, infraPlacement(n, runtimeEntries.get(n), identities)) },
          runtimeEntries.get(n),
          identities,
        )),
      );
      // ── THE TOOL REGISTRY TRAVELS WITH THE LISTING ────────────────────────────────────────────
      //
      // `tool-registry.ts` says it is the single source of truth for the tool names and descriptions
      // that "render the admin console's per-tool 'what it does / how it functions' surface", and the
      // console could not read it: it is a Lambda module and the console is a separate browser build.
      // So the console kept a hand-maintained copy, and the copy drifted exactly as a second copy
      // does - it was missing `read_deployment_health` and `open_work_summary`, so an operator
      // reviewing the ops assistant's tools saw the one tool that assistant exists for listed with no
      // description at all, and the draft editor's checkbox list (built from the copy's keys) could
      // not show either tool to be turned off.
      //
      // Serving it closes that without a second endpoint and without a tenth copy of the prose. It is
      // the same request the console already makes to draw this tab, the payload is a couple of
      // kilobytes of static metadata, and it is behind the same `manage-profiles` gate as the listing
      // it describes.
      return respond(200, {
        profiles: listed,
        tools: TOOL_REGISTRY,
        // WHAT EACH LISTED ASSISTANT'S CLASSIFICATION OFFERS, so the draft editor offers only that (the
        // write path refuses the rest), and what every version field is to the console: a control, JSON
        // with its edit path, or read-only with what drives it (`lib/profile-field-decisions.ts`).
        classifications: await classificationCatalogsFor(listed),
        fieldDecisions: fieldDecisions(),
        // Where an assistant may be created: each of the deployment's own conversational classifications
        // and its DEPLOYED roles, read the way a create checks them (`lib/roster-targets.ts`), so nothing
        // is offered that the create would refuse. A team's roster route answers through the same helper.
        ...(scope ? {} : {
          runtimeAssistants: roster,
          rosterTargets: rosterTargets(),
        }),
        ...(runtimeDirectoryUnreadable ? { runtimeDirectoryUnreadable } : {}),
      });
    }

    if (method === 'POST') {
      const parsed = parseJsonBody<Record<string, unknown>>(event, origin);
      if ('statusCode' in parsed) return parsed;
      const body = parsed.body;
      // An import names its target separately, so the same refusal covers it rather than redirecting it.
      if (scope && typeof body.targetProfileName === 'string' && body.targetProfileName !== scope.assistant) {
        return respond(403, { error: 'This route imports only into the assistant it names', code: 'ASSISTANT_MISMATCH' });
      }
      if (scope && typeof body.profileName === 'string' && body.profileName !== scope.assistant) {
        return respond(403, { error: 'This route edits only the assistant it names', code: 'ASSISTANT_MISMATCH' });
      }
      // ── AN IMPORT NAMES WHERE IT LANDS; THE MANIFEST NEVER DECIDES ─────────────────────────────────
      //
      // A manifest carries the name of the assistant it was exported from. Falling back to that name
      // landed an import on whichever assistant the file happened to name, which the person choosing the
      // file never saw. The target is therefore required, and refused before anything is read: the team
      // route supplies its own assistant, and every other caller names one, so whoever imports always
      // says which assistant gets the draft.
      const importTarget = scope ? scope.assistant
        : typeof body.targetProfileName === 'string' && body.targetProfileName.trim() ? body.targetProfileName : '';
      if (path.endsWith('/import') && !importTarget) {
        return respond(400, {
          error: "An import names the assistant it lands on (targetProfileName); the manifest's own name is never used",
          code: 'TARGET_REQUIRED',
        });
      }
      const profileName = scope ? scope.assistant : typeof body.profileName === 'string' ? body.profileName : '';
      // A runtime assistant named here, or as an import's target, is read from the directory first.
      await learnRuntimeAssistant(profileName);
      if (typeof body.targetProfileName === 'string') await learnRuntimeAssistant(body.targetProfileName);

      // ── AN ALT'S PROFILE IS EDITED THROUGH ITS EXPERIMENT, NOT HERE (ADR-050) ──────────────────────
      //
      // The alt (`alt-{role}-{classification}`) is derived from the experiment's settings and published
      // by `/variant-version`. Accepting a draft, an activation, a rollback or an import for it here
      // would let anyone holding manage-profiles change what one side of a running experiment serves
      // without the experiment knowing, which is the measurement this rule protects. Export stays open:
      // promoting a winner is export, then import into the LIVE profile as a draft, then activate.
      const namedAlt = [profileName, typeof body.targetProfileName === 'string' ? body.targetProfileName : '']
        .find((n) => n && profiles.roleOfAlt(n));
      if (namedAlt && !path.endsWith('/export')) {
        return respond(409, {
          error: `'${namedAlt}' is an alt's profile; it is changed through the experiment that owns it (variant-version)`,
          code: 'ALT_PROFILE_IS_EDITED_THROUGH_ITS_EXPERIMENT',
        });
      }

      // The target was required above; scoped, it is the assistant the route names, whatever the manifest says.
      if (path.endsWith('/import')) {
        const draft = await importManifest(ssm, SSM_ROOT, body.manifest, importOptions(sub, { targetProfileName: importTarget }));
        return respond(200, { imported: draft.profileName, configId: draft.configId, landedAs: 'draft' });
      }

      // A battle's candidate names its role through the experiment's challenger, so `/variant-version` may
      // arrive with no profileName; the route resolves and checks the role itself.
      const altFromExperiment = path.endsWith('/variant-version') && !profileName;
      if (!altFromExperiment
        && (!profileName || (!isKnownProfile(profileName) && !(path.endsWith('/export') && profiles.roleOfAlt(profileName))))) {
        return respond(400, { error: `unknown or missing profileName '${profileName}'` });
      }

      if (path.endsWith('/version')) {
        // A RUNTIME ASSISTANT THAT HAS NEVER BEEN ACTIVATED starts again from its classification's defaults
        // (`seedFirstDraft`): there is no active version to clone, and a draft cloned from its record's seed
        // alone would carry no intents.
        if (isRuntimeAssistant(profileName) && !(await hasActiveVersion(profileName))) {
          const first = await seedFirstDraft(ssm, SSM_ROOT, profileName, sub, { replace: true, choices: startingChoicesOf(profileName) });
          return respond(200, { profileName, draftConfigId: first.configId, firstDraft: true, ...(first.reason ? { note: first.reason } : {}) });
        }
        const draft = await createDraft(ssm, SSM_ROOT, profileName, sub);
        return respond(200, { profileName, draftConfigId: draft.configId });
      }
      if (path.endsWith('/draft')) {
        const patch = (body.patch ?? {}) as Partial<ProfileDefinitionBody>;
        if (typeof patch.displayName === 'string') {
          const taken = await nameTakenRefusal(profileName, patch.displayName);
          if (taken) return respond(409, taken);
        }
        const draft = await editDraft(ssm, SSM_ROOT, profileName, patch, sub);
        return respond(200, { profileName, draftConfigId: draft.configId });
      }
      if (path.endsWith('/validate')) {
        // The same catalog reader import uses, so a key that would be rejected on the way IN to
        // another instance is also rejected on the way in here.
        const { errors, configId, warnings, errorDetails } = await validateDraft(ssm, SSM_ROOT, profileName, catalog(), contextSourceCatalogFor, guardrailCatalogFor);
        return respond(200, { profileName, valid: errors.length === 0, errors, configId, ...(warnings?.length ? { warnings } : {}), ...(errorDetails?.length ? { errorDetails } : {}) });
      }
      if (path.endsWith('/preview-run')) {
        // PREVIEW RUN (ADR-061 decision 7): one workflow walked with sample values. It reads the draft and writes nothing.
        const preview = await previewDraftWorkflow(ssm, SSM_ROOT, profileName, {
          workflow: body.workflow, definition: body.definition, values: body.values, outcomes: body.outcomes,
        });
        return respond(200, { profileName, workflow: body.workflow, ...preview });
      }
      if (path.endsWith('/golden-run')) {
        const started = await startGoldenRun(profileName, sub);
        return respond(started.status, started.body);
      }
      if (path.endsWith('/golden-gate')) {
        // Read when the console opens the draft and when the person asks again; nothing here waits on a timer.
        const draft = await getDraft(ssm, SSM_ROOT, profileName);
        if (!draft) return respond(200, { profileName, draft: false });
        const gate = await readGoldenGate(profileName, draft, { strict: false });
        return respond(200, { profileName, draftConfigId: draft.configId, available: !!gate, gate, outcome: goldenGateOutcome(gate, draft.configId) });
      }
      if (path.endsWith('/golden-set-import') || path.endsWith('/golden-set-retire-upload') || path.endsWith('/golden-set-retire-generation')
        || path.endsWith('/golden-set-generate') || path.endsWith('/golden-set-batch')) {
        // A DEPLOYMENT'S OWN ENTRIES (ADR-065 decisions 7 and 8). Each route is its own capability's, and a team member
        // reaches it only for the assistant in its path. A file is read and checked here, where the assistant's intents are
        // known; the classification's GoldenRun function de-identifies and writes it inside the classification, as a
        // batch in the background, and the console is told on the batch's channel when it ends.
        const classification = classificationServedBy(profileName);
        const arn = await goldenRunArnFor(classification);
        if (!arn) return respond(409, { error: 'This deployment has no golden set (it is kept in Aurora mode only)', code: 'GOLDEN_RUN_UNAVAILABLE' });
        if (path.endsWith('/golden-set-batch')) {
          // How an upload or a generation ended: read once when the console is told it ended, or asked.
          const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : '';
          if (!UUID.test(batchId)) return respond(400, { error: 'Name the batch (batchId)', code: 'BATCH_ID_REQUIRED' });
          const batch = await askGoldenRun<Record<string, unknown> | null>(arn, { op: 'batch', classification, assistant: profileName, batchId });
          return batch ? respond(200, { profileName, batch }) : respond(404, { error: 'No such batch for this assistant', code: 'NO_BATCH' });
        }
        if (path.endsWith('/golden-set-retire-upload') || path.endsWith('/golden-set-retire-generation')) {
          // The route's capability decides the kind: an upload is `import-golden-set`'s, a generation `edit-profiles`'.
          const source = path.endsWith('/golden-set-retire-generation') ? 'generated' : 'uploaded';
          const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
          if (!UUID.test(uploadId)) return respond(400, { error: 'Name the upload or generation to retire (uploadId)', code: 'UPLOAD_ID_REQUIRED' });
          const r = await askGoldenRun<{ retired: number }>(arn, { op: 'retire-upload', classification, assistant: profileName, uploadId, retiredBy: sub, source });
          audit(`golden-set-retire-${source === 'generated' ? 'generation' : 'upload'}`, sub, profileName, { uploadId, retired: r.retired });
          return respond(200, { profileName, uploadId, retired: r.retired });
        }
        if (path.endsWith('/golden-set-generate')) {
          // ENTRIES WRITTEN FROM THE DRAFT'S INTENT PACK (decision 8): under `edit-profiles`, because it spends a model call
          // per intent. They enter as capability, marked generated, and refuse nothing until a person promotes them.
          const pack = await generationIntents(profileName);
          const named = Array.isArray(body.intents) ? body.intents.filter((i): i is string => typeof i === 'string') : null;
          const unknown = named?.filter((k) => !pack.some((d) => d.key === k)) ?? [];
          if (unknown.length) return respond(400, { error: UPLOAD_REFUSAL_TEXT.UNKNOWN_INTENT, code: 'UNKNOWN_INTENT', params: { intents: unknown.join(', ') } });
          if (!pack.length) return respond(400, { error: UPLOAD_REFUSAL_TEXT.NO_INTENTS, code: 'NO_INTENTS', params: {} });
          const chosen = named?.length ? pack.filter((d) => named.includes(d.key)) : pack;
          // Named intents are at most one call's worth; with none named, the run function takes the least covered of the pack.
          if (!chosen.length || (named?.length && chosen.length > GENERATE_MAX_INTENTS)) {
            return respond(400, { error: UPLOAD_REFUSAL_TEXT.TOO_MANY_INTENTS, code: 'TOO_MANY_INTENTS', params: { count: chosen.length, max: GENERATE_MAX_INTENTS } });
          }
          const perIntent = body.perIntent === undefined ? GENERATE_PER_INTENT_DEFAULT : Number(body.perIntent);
          if (!Number.isInteger(perIntent) || perIntent < 1 || perIntent > GENERATE_PER_INTENT_MAX) {
            return respond(400, { error: UPLOAD_REFUSAL_TEXT.BAD_PER_INTENT, code: 'BAD_PER_INTENT', params: { max: GENERATE_PER_INTENT_MAX } });
          }
          // THE CALLER'S ID, where it sends one: the console keeps it until it hears the batch ended, so a second click while
          // it runs starts nothing (the run function's row is claimed once).
          const generationId = typeof body.generationId === 'string' && UUID.test(body.generationId) ? body.generationId : randomUUID();
          const startedAfterGen = new Date().toISOString();
          await lambdaClient.send(new InvokeCommand({
            FunctionName: arn,
            InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({
              op: 'generate', classification, assistant: profileName, generationId, generatedBy: sub,
              intents: chosen.map(generationIntentOf), perIntent, ...(named?.length ? {} : { leastCovered: true }),
            })),
          }));
          audit('golden-set-generate', sub, profileName, { generationId, intents: chosen.length, perIntent });
          return respond(202, { profileName, batchId: generationId, kind: 'generation', status: 'running', startedAfter: startedAfterGen });
        }
        const read = readGoldenUpload(body.format, body.content, await uploadIntents(profileName));
        if (!read.ok) {
          return respond(400, { error: UPLOAD_REFUSAL_TEXT[read.code], code: read.code, params: read.params, ...(read.problems ? { problems: read.problems } : {}) });
        }
        const uploadId = uploadIdFor(profileName, body.format, body.content);
        // THE SAME FILE IS THE SAME BATCH, so a batch already running is not started again: the answer names when it started,
        // and the console reads that batch's end. Otherwise it names now, and the console takes no row older than that.
        const current = await askGoldenRun<{ status?: string; startedAt?: string } | null>(arn, { op: 'batch', classification, assistant: profileName, batchId: uploadId });
        if (current?.status === 'running') {
          return respond(202, { profileName, batchId: uploadId, kind: 'upload', status: 'running', entries: read.entries.length, startedAfter: current.startedAt });
        }
        const startedAfter = new Date().toISOString();
        // THE ENTRIES TRAVEL AS AN OBJECT, NOT IN THE EVENT: an async invocation's request is repeated in the record its
        // destination sends to EventBridge, and an upload's text has not been de-identified yet. The run function reads the
        // object and removes that version of it; a lifecycle rule removes anything left within a day.
        const bucket = bodyBucket();
        if (!bucket) return respond(503, { error: 'This deployment has no body bucket to hand an upload over in', code: 'GOLDEN_RUN_UNAVAILABLE' });
        const entriesKey = `${goldenUploadPrefix(classification, profileName)}${uploadId}.json`;
        const put = await uploadS3().send(new PutObjectCommand({
          Bucket: bucket, Key: entriesKey, Body: JSON.stringify(read.entries), ContentType: 'application/json',
        }));
        await lambdaClient.send(new InvokeCommand({
          FunctionName: arn,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({
            op: 'import', classification, assistant: profileName, uploadId, uploadedBy: sub, entriesKey,
            ...(put.VersionId ? { entriesVersion: put.VersionId } : {}),
          })),
        }));
        audit('golden-set-import', sub, profileName, { uploadId, entries: read.entries.length, format: body.format });
        return respond(202, { profileName, batchId: uploadId, kind: 'upload', status: 'running', entries: read.entries.length, startedAfter });
      }
      if (path.endsWith('/activate')) {
        // CHECKED AGAIN AT ACTIVATION: another assistant may have taken the name since the draft was edited,
        // and an import lands a name without passing the edit.
        const pendingDraft = await getDraft(ssm, SSM_ROOT, profileName);
        const pending = pendingDraft?.displayName;
        if (pending) {
          const taken = await nameTakenRefusal(profileName, pending);
          if (taken) return respond(409, taken);
        }
        // THE GOLDEN SET'S GATE (ADR-065): a draft that fails a regression entry, or was not run against a set that has
        // one, is refused here, whatever the console showed. Activation is the gate; a caller can skip the console.
        if (pendingDraft) {
          const outcome = goldenGateOutcome(await readGoldenGate(profileName, pendingDraft), pendingDraft.configId);
          if (!outcome.proceed) return respond(409, { error: outcome.error, code: outcome.code, params: outcome.params, ...(outcome.failures ? { failures: outcome.failures } : {}) });
        }
        // The configId the gate checked: a draft saved since is refused, not activated unrun.
        const r = await activateDraft(ssm, SSM_ROOT, profileName, catalog(), sub, contextSourceCatalogFor, guardrailCatalogFor, pendingDraft?.configId);
        // The identity carries the name a person reads in the room; the version carries the one the
        // console reads. Activating has to move both or the two disagree until someone notices.
        const identity = await applyNameToIdentity(profileName, r.displayName);
        return respond(200, { profileName, ...r, ...identity });
      }
      if (path.endsWith('/activate-past-golden-gate')) {
        // ACTIVATING PAST THE GOLDEN GATE (ADR-065 decision 5). Layer one is the gateway: the route is its own capability,
        // `activate-past-golden-gate`, granted to the admin role alone, with no team route. Layer two is here, and does not
        // rest on the signed call: the caller's groups are read from the directory and one must be an admin group.
        if (scope) return respond(403, { error: 'Activating past the golden gate is an administrator\'s', code: 'ADMIN_REQUIRED' });
        const personArn = await callerPersonArn(event);
        const groups = personArn ? await defaultDirectory().groupsFor(personArn) : null;
        if (!groups || !holdsAdminGroup(groups)) {
          console.warn('[manage-profiles] activate-past-golden-gate refused: caller holds no admin group', { sub });
          return respond(403, { error: 'Activating past the golden gate is an administrator\'s', code: 'ADMIN_REQUIRED' });
        }
        const pendingDraft = await getDraft(ssm, SSM_ROOT, profileName);
        if (!pendingDraft) return respond(404, { error: `'${profileName}' has no draft to activate`, code: 'NO_DRAFT' });
        if (pendingDraft.displayName) {
          const taken = await nameTakenRefusal(profileName, pendingDraft.displayName);
          if (taken) return respond(409, taken);
        }
        const gate = await readGoldenGate(profileName, pendingDraft);
        const decision = pastGateDecision(gate, pendingDraft.configId, body);
        if (!decision.allow) {
          return respond(decision.status, { error: decision.error, code: decision.code, ...(decision.current ? { current: decision.current } : {}) });
        }
        const runId = gate?.run && gate.run.draftConfigId === pendingDraft.configId ? gate.run.runId : undefined;
        const activatedPastGate = {
          code: decision.refusal.code, params: decision.refusal.params, reason: decision.reason, actor: sub,
          at: new Date().toISOString(), ...(runId ? { runId } : {}),
        };
        // Held to the configId the administrator confirmed, and every other check of an activation still runs.
        const r = await activateDraft(
          ssm, SSM_ROOT, profileName, catalog(), sub, contextSourceCatalogFor, guardrailCatalogFor, pendingDraft.configId, activatedPastGate,
        );
        const identity = await applyNameToIdentity(profileName, r.displayName);
        // ANNOUNCED, not only recorded: the other administrators read it in the admin channel. A notice that could not be
        // sent is logged by `postAdminNotice` and does not undo the activation, which the version already records.
        await postAdminNotice(adminNotice({
          name: 'activated-past-golden-gate',
          values: { assistant: profileName, version: String(r.version), refusal: decision.refusal.code, actor: sub, reason: decision.reason },
        }, 'activated-past-golden-gate', { assistant: profileName, version: r.version, refusal: decision.refusal.code }));
        return respond(200, { profileName, ...r, ...identity, activatedPastGate });
      }
      if (path.endsWith('/rollback')) {
        const version = Number(body.version);
        if (!Number.isInteger(version) || version < 1) return respond(400, { error: 'version (>=1) required' });
        const r = await activateExistingVersion(ssm, SSM_ROOT, profileName, version, sub);
        // A ROLLBACK RENAMES TOO when the version rolled back to carried a different name. Without
        // this the identity would keep whatever the last forward activation set, so rolling back
        // behavior would leave the assistant wearing the name of a version no longer serving.
        const identity = await applyNameToIdentity(profileName, r.displayName);
        return respond(200, { profileName, ...r, ...identity });
      }
      if (path.endsWith('/discard')) {
        // DISCARD THE DRAFT THE CALLER SAW (SPEC-PORTABLE-PROFILES FR18). The caller names its configId, so a
        // draft saved since is kept and named back to it; nothing serving changes.
        const configId = typeof body.configId === 'string' ? body.configId.trim() : '';
        if (!configId) {
          return respond(400, { error: 'A discard names the configId of the draft it throws away', code: 'CONFIG_ID_REQUIRED' });
        }
        const r = await discardDraft(ssm, SSM_ROOT, profileName, configId, sub);
        if (r.outcome === 'no-draft') {
          return respond(404, { error: `'${profileName}' has no draft to discard`, code: 'NO_DRAFT' });
        }
        if (r.outcome === 'changed') {
          return respond(409, {
            error: 'The draft was saved again since it was opened; reload it to see the newer edit before discarding',
            code: 'DRAFT_CHANGED',
            configId: r.configId,
          });
        }
        return respond(200, { profileName, discarded: true, configId: r.configId });
      }
      if (path.endsWith('/variant-version')) {
        // ── THE EXPERIMENT DOOR INTO THE PROFILE NAMESPACE, AND IT IS THIS ONE ──────────────────
        //
        // A battle variant runs a whole profile version, and §3.7 derives that version from the live
        // assistant plus the variant's delta. The derivation is a WRITE to `/assistant/*/definition`,
        // which §7 reserves to this role alone - so it happens HERE, behind this handler's
        // `manage-profiles` check, rather than by granting the experiments admin a second writer on
        // the namespace (tenet D4 - narrow the grant, do not widen the writer).
        //
        // WHAT THE CALLER STILL HAS TO BE. The capability check above has already run, so arming an
        // experiment with a derived variant requires the OPERATOR to hold manage-profiles in their
        // own right. An experiment admin who does not cannot author an assistant through the
        // experiments door, which is the whole point of the write living here.
        //
        // It publishes an UNLABELLED version: a candidate, not a change. Nothing this route does
        // alters what any room is served - moving the `active` label is `/activate` and `/rollback`,
        // and both stay exactly where they were.
        const experimentId = typeof body.experimentId === 'string' ? body.experimentId : '';
        const variantId = typeof body.variantId === 'string' ? body.variantId : '';
        if (!experimentId || !variantId) {
          return respond(400, { error: 'experimentId and variantId are required - a candidate records what produced it' });
        }
        const existingVersion = body.existingVersion !== undefined ? Number(body.existingVersion) : undefined;
        if (existingVersion !== undefined && (!Number.isInteger(existingVersion) || existingVersion < 1)) {
          return respond(400, { error: 'existingVersion, when sent, is the pin this variant already carries (>=1)' });
        }
        // THE BASE IS THE ROLE'S LIVE ASSISTANT; THE CANDIDATE LANDS UNDER THE ROLE'S ALT (§3.5). Computed
        // here rather than taken from the caller, so a team route (scoped to its own assistant) derives for
        // its own role and nothing else.
        const exp = await readExperimentForCandidate(experimentId);
        if (!exp) return respond(404, { error: 'No experiment with that id', code: 'EXPERIMENT_NOT_FOUND' });
        const assignment = roleForCandidate(exp, scope ? scope.assistant : profileName);
        const baseProfile = assignment ? profiles.roleAssistantName(assignment.classification, assignment.role) : undefined;
        const altProfile = assignment ? profiles.altAssistantName(assignment.classification, assignment.role) : undefined;
        if (!assignment || !baseProfile || !altProfile) {
          return respond(400, { error: 'The candidate names no role with an alt', code: 'NO_ALT_FOR_ROLE' });
        }
        // THE CONTROL IS THE LIVE ACTIVE VERSION, pinned by number when the experiment is armed (§3.5), so
        // there is nothing to derive for it and nothing is ever published under the live name.
        const variantList = Array.isArray(exp.variants) ? exp.variants as Array<{ variantId?: unknown }> : [];
        if (variantList[0]?.variantId === variantId) {
          return respond(409, {
            error: "The control is the live assistant's active version, pinned when the experiment is armed; only the treatment has a candidate",
            code: 'CONTROL_IS_THE_LIVE_VERSION',
          });
        }
        const targetProfile = altProfile;
        if (scope && baseProfile !== scope.assistant) {
          return respond(403, { error: 'This route derives only for the assistant it names', code: 'ASSISTANT_MISMATCH' });
        }
        // THE VARIANT'S OWN DELTA IS READ FROM THE EXPERIMENT ROW, so a side's version carries exactly what
        // its variant says (model, persona addendum, image model, display name) without the caller restating
        // it. A `profileRef` variant hands over its whole version by reference, read below like
        // `fromProfileRef`. A caller's `patch` lays over the delta, within what the experiment type allows.
        const delta = variantDeltaOf(exp, variantId);
        let patch = { ...delta.patch, ...((body.patch ?? {}) as Partial<ProfileDefinitionBody>) } as Partial<ProfileDefinitionBody>;
        const from = (body.fromProfileRef ?? delta.fromProfileRef) as { profileName?: unknown; version?: unknown } | undefined;
        if (from) {
          // A ref read off the variant may track the `active` label; it is pinned to the version the label
          // points at now, which is what a derivation does with its base too. A caller's ref names a version.
          const versionOk = Number.isInteger(from.version) || (!body.fromProfileRef && from.version === undefined);
          if (typeof from.profileName !== 'string' || !versionOk) {
            return respond(400, { error: 'fromProfileRef names a profile and a version', code: 'FROM_PROFILE_REF_INVALID' });
          }
          // THE SOURCE IS READ UNDER THE SAME SCOPE AS THE TARGET. A team route may hand over a version of
          // its own assistant, or of the alt this route writes; reading any other name would copy another
          // team's definition into this alt and out again through its export.
          if (scope && from.profileName !== scope.assistant && from.profileName !== targetProfile) {
            return respond(403, { error: 'fromProfileRef names an assistant this route does not reach', code: 'ASSISTANT_MISMATCH' });
          }
          const source = await lookupProfileVersion(ssm, SSM_ROOT, { profileName: from.profileName, version: from.version as number | undefined });
          if (!source) return respond(404, { error: 'That profile version does not exist', code: 'FROM_PROFILE_REF_NOT_FOUND' });
          const { intentPack: _intents, ...rest } = bodyFrom(source);
          void _intents;
          patch = { ...rest, ...patch, ...(patch.models ? { models: { ...(rest.models ?? {}), ...patch.models } } : {}) };
        }
        const refusal = candidateRefusal(exp, variantId, assignment.classification, patch);
        if (refusal) return respond(refusal.status, { error: refusal.error, code: refusal.code });
        const r = await publishVariantVersion(
          ssm, SSM_ROOT, { baseProfile, targetProfile },
          patch,
          catalog(), sub,
          { experimentId, variantId },
          existingVersion,
          // The SAME catalog readers `/validate` and `/activate` pass, so a selection this deployment
          // cannot resolve is refused here exactly as it is on the editor's own path.
          contextSourceCatalogFor, guardrailCatalogFor,
        );
        // NO `applyNameToIdentity` HERE, and that is the difference from `/activate`. The identity
        // wears the name of what is SERVING; a candidate serves nobody, so renaming the assistant
        // after one would put a duel side's name on the live assistant.
        return respond(200, r);
      }
      if (path.endsWith('/export')) {
        const version = body.draft === true ? 'draft' as const : body.version !== undefined ? Number(body.version) : undefined;
        // Pass the catalog so a guardrail SELECTION is emitted as its portable key rather than the id
        // resolved on this instance (the manifest's instance-agnostic promise).
        const manifest = await exportManifest(ssm, SSM_ROOT, profileName, version, guardrailCatalogFor, contextSourceCatalogFor);
        return respond(200, { manifest });
      }
    }

    return respond(404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ProfileValidationError || err instanceof ProfileManifestError) {
      return respond(422, { error: err.message, errors: (err as ProfileValidationError).errors });
    }
    console.error('[manage-profiles] error:', err);
    return respond(500, { error: 'Internal error' });
  }
};
