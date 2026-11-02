import type { IntentCoverage } from '../../../../../backend/lambda/src/lib/golden-gate.ts';
import i18n from '@ae/shared/i18n';
import type { PublishedVariables, VersionVariable, When } from '../../../../../backend/lambda/src/lib/variables.ts';
import type { MessageEntry } from '../../../../../backend/lambda/src/lib/message-template.ts';
import { consoleCredentials, sigv4GetJson, sigv4PostJson } from './sigv4Fetch';
import { teamAssistant } from './teamScope';
import { adminApiConfigured, adminUrl } from './adminApi';

/**
 * Assistant-profile lifecycle service (SPEC-PORTABLE-PROFILES P1/P3) — the admin console's
 * client for the profile-management API. The routes are AWS_IAM (SigV4), so requests are signed with
 * the operator's console session (the gateway denies a role without `execute-api:Invoke` on the
 * profile resource). Same shape as adminConversationService. Every mutation is gated server-side on
 * its profile capability (`edit-profiles`, `activate-profiles`) and audited.
 */

/** The sentinel `models.*` value meaning "follow the classification-set default" (tracks the platform
 *  default over time; never a pinned concrete key). Mirrors the backend `DEFAULT_MODEL`. */
export const DEFAULT_MODEL = 'default';

export interface ProfileModels {
  /** Base model; blank or `'default'` ⇒ inherit the classification default. */
  default?: string;
  /** Classifier model; blank or `'default'` (the seeded value) ⇒ inherit the deployment default (Haiku). */
  classifier?: string;
  /** Per-intent routes, keyed by the intent (`IntentRoute` in `backend/lambda/src/lib/step-models.ts`). */
  byIntent?: Record<string, IntentRoute>;
  /**
   * The version's routing rules (ADR-060 decision 6): the first rule whose condition holds, and whose model the
   * classification selects, serves the turn, after an experiment and before the built-in context rules.
   */
  routing?: Array<{ when: When; model: string }>;
}

/**
 * A ROUTE KEYED BY ITS INTENT (ADR-064 decisions C and D): the text model and fallback, the image model and fallback, and
 * per-step overrides keyed by a state of the intent's workflow. Any part may be absent.
 */
export interface IntentRoute {
  primary?: string;
  fallback?: string;
  image?: { primary: string; fallback?: string };
  steps?: Record<string, { primary: string; fallback?: string }>;
}

/**
 * A REFUSAL VALIDATE ANCHORS TO A CARD OR STEP (`RouteError` in `backend/lambda/src/lib/image-route.ts`): a stable code,
 * the path it refuses, the params the console's message key fills, and the English the flat list prints.
 */
export interface RouteError { code: string; path: string; message: string; params?: Record<string, string> }

/**
 * A RETIRED welcome (W1): a version stored before the welcome became its assistant-joined workflow may still carry one.
 * Nothing reads it; a draft refuses it, and `npm run migrate-legacy-welcome` carries it into the welcome workflows.
 */
export type RetiredWelcome = Record<string, unknown>;

/**
 * The lines a version stored before message templates (ADR-062). Retired: nothing reads them as wording, a draft refuses
 * them, and `npm run migrate-legacy-copy` makes them the assistant's own templates.
 */
export type AssistantCopy = Record<string, string | Record<string, string> | undefined> & {
  queueStatus?: Record<string, string>;
  email?: Record<string, string>;
};

/** One field's decision on the assistant page (`profile-field-decisions.ts`), served with the listing. */
export type FieldDecision =
  | { kind: 'control' }
  | { kind: 'json'; command: string; guide: string }
  | { kind: 'readonly'; drivenBy: string; guide: string };

/** One intent of the classification's pack, as the catalog serves it (`CatalogIntent` in `classification-catalog.ts`). */
export interface CatalogIntent {
  key: string;
  description: string;
  summary?: string;
  instructions?: string;
  multiStep: boolean;
  machine?: string;
  /** What a turn of the intent hands over; `image` makes its card offer an image model. */
  needs?: string;
}

/** One step of a task machine, as the catalog serves it (`MachineStep` in `classification-catalog.ts`). */
export interface MachineStep {
  key: string;
  label?: string;
  awaits?: 'requester' | 'worker';
  terminal?: 'success' | 'failure' | 'handoff';
  requires?: string[];
  /** What the step hands over (ADR-064): text, a document, or an image the platform draws on entry. */
  produces?: 'text' | 'image' | 'document';
  /** The tools that must have run before the task leaves the step (ADR-064 decision 3). */
  requiresTool?: string[];
  templates?: string[];
  defaultTemplate?: string;
  transitions: string[];
  reopens?: string[];
  action?: string;
  prompt?: string;
}

/** What a classification offers its assistants (`classification-catalog.ts`). Absent parts were unreadable. */
export interface ClassificationCatalog {
  classification: string;
  models: { text: string[]; image: string[]; default?: string };
  guardrails?: Array<{ key: string; guardrailId: string }>;
  contextSources?: Array<{ key: string; description?: string }>;
  templates?: Array<{ name: string; active: string }>;
  /** `required`: a platform workflow every assistant has (the turn queue's), which no selection removes. */
  workflows?: Array<{ key: string; source: 'platform' | 'classification'; required: boolean; initial: string; states: string[]; steps?: MachineStep[] }>;
  packIntents?: string[];
  /** The pack's intents with what each is for, and the machine a multi-step intent runs. */
  intents?: CatalogIntent[];
  /** The platform intents every assistant answers, each with whether it answers through the `general` route unrouted. */
  platformIntents?: Array<{ key: string; answersThroughGeneral: boolean }>;
  topology?: { processorTimeout: number; memorySize: number; reservedConcurrency?: number; maxTokens?: number };
  retrievalReach: string[];
  /** The bucket the context prefixes are keys in (the deployment's attachments bucket). */
  contextBucket?: string;
  roles: Record<string, { contextPrefixes: string[] }>;
  budgets?: { userHourly?: number; globalHourly?: number };
  /** Every variable source the classification publishes, with its type, trust and whether it may decide (ADR-060). */
  variables?: PublishedVariables;
}

/**
 * The runtime-editable body of a profile VERSION — what publishing a new version actually changes.
 *
 * Deployment-time settings are deliberately absent: `classifierMode`, `timeoutSeconds`, `taskSupport`,
 * `rateLimitPerHour`, `battleEligible` and `models.complex` live in the backend's compiled
 * `lib/config/profiles.ts` and stack topology, and a running turn reads them from there, never from a
 * version. They were in this type and in the Profiles-tab editor while changing nothing, which offered
 * an operator a live knob that publishing could not turn. A stored version may still carry them; the
 * backend drops them on read (`bodyFrom`), so nothing here has to.
 */
type WorkflowLayout = import('../../../../../backend/lambda/src/lib/workflow-layout.ts').WorkflowLayout;

export interface ProfileDefinitionBody {
  modelKey: string;
  models?: ProfileModels;
  tools?: string[];
  guardrailId?: string;
  /**
   * WHAT THE ASSISTANT IS CALLED - the editable label, distinct from `profileName`, which is the
   * stable identifier that keys storage and never changes (DESIGN-SEPARATE-ASSISTANTS 3.0).
   *
   * It was missing from this type while the backend carried it, so the export manifest delivered a
   * name the console then discarded: the field existed end to end and was invisible here. Activating
   * a version with this set also renames the assistant's Amazon Chime SDK identity, which is what a
   * person reads beside its messages, so this is the one editable field with an effect outside the
   * profile store.
   */
  displayName?: string;
  /**
   * THE ASSISTANT'S CHARACTER - its system-prompt body, and the field a person actually means when
   * they say they want to change how the assistant sounds.
   *
   * It rides the version like any other behavior and the export manifest has always carried it
   * (hydrated from S3 when the version stores it as a pointer), but this type did not declare it, so
   * the console received the persona on every export and threw it away. Same shape as `displayName`:
   * the field existed end to end and was invisible here.
   */
  persona?: string;
  /** Context sources the version selects, by catalog key, in prompt order. */
  contextSources?: string[];
  /** Retired (W1); see RetiredWelcome. The welcome is the version's assistant-joined workflow in eventWorkflows. */
  welcome?: RetiredWelcome;
  copy?: AssistantCopy;
  /**
   * Which template a message is said from (ADR-062): one of the assistant's own by name, `@classification` or `@shipped`,
   * or an ordered list of `{ template, when }` whose last alternative alone carries no condition (ADR-060 decision 6).
   */
  messages?: Record<string, MessageEntry>;
  /** The event workflows this version declares (ADR-061 decision 1), by name. */
  eventWorkflows?: Record<string, import('../../../../../backend/lambda/src/lib/event-workflow.ts').EventWorkflow>;
  /** The variables this version names, each a source and a fallback (ADR-060 decision 1). */
  variables?: Record<string, VersionVariable>;
  /** The fields below are shown read-only on the page, each with its edit path. */
  intentPack?: { intents?: Array<{ key: string; description?: string }>; [k: string]: unknown };
  workflows?: string[];
  /** Per workflow, when its confirmed step is put to the person (ADR-064 decision G). */
  confirmBrief?: Record<string, 'always' | 'when-incomplete'>;
  onboarding?: { greeting?: string; fields?: Array<{ key: string; prompt?: string }>; completion?: string };
  boundary?: string;
  systemPromptAddendum?: string;
}

/** The export/import manifest shape (the fields the console reads). The body is instance-agnostic — model
 *  keys are catalog keys, never ARNs (SPEC-PORTABLE §5), so AWS deep links are built client-side. */
export interface ProfileManifestTyped {
  schemaVersion: number;
  kind: string;
  profileName: string;
  body: ProfileDefinitionBody;
  provenance?: { instanceId?: string; sourceProfileName?: string; sourceVersion?: number | string; exportedConfigId?: string };
  /** Where the console draws each workflow step (ADR-061 decision 7): beside the body, never part of it. */
  layout?: WorkflowLayout;
  contentHash?: string;
  signature?: string;
}

export interface ProfileVersionSummary {
  version: number;
  configId: string;
  active: boolean;
  lastModified?: string;
  /** A candidate an experiment derived (it never served, and cannot be activated; Promote copies it). */
  derivedFrom?: { experimentId: string; variantId: string; baseProfile?: string; baseVersion?: number };
  /** A copy an experiment's promotion made of its measured candidate. */
  promotedFrom?: { profileName: string; version: number; experimentId: string };
  /** A version an administrator activated past the golden gate: the refusal passed, who, when and why (ADR-065). */
  activatedPastGate?: { code: string; params: Record<string, string | number>; reason: string; actor: string; at: string; runId?: string };
}

/** Live, instance-bound infra identifiers for a profile's assistant (server-resolved) — for AWS deep links.
 *  Absent/partial when the profile has no live processor yet or the resolve was denied. */
export interface ResolvedInfra {
  region: string;
  classification?: string;
  role?: string;
  /** Who each resolved resource belongs to, by field name: this assistant, its classification's assistants, or the deployment. */
  scopes?: Record<string, 'assistant' | 'classification' | 'deployment'>;
  // This assistant's own.
  botArn?: string;
  lexBotId?: string;
  lexBotAliasId?: string;
  definitionParam?: string;
  assignmentParam?: string;
  directoryParam?: string;
  profileBodies?: { bucket: string; prefix: string };
  // Shared by the classification's assistants.
  processorArn?: string;
  processorFunctionName?: string;
  routerArn?: string;
  routerFunctionName?: string;
  actingRoleArn?: string;
  actingRoleName?: string;
  boundaryPolicyArn?: string;
  boundaryPolicyName?: string;
  guardrailId?: string;
  guardrailName?: string;
  templates?: { bucket: string; prefix: string };
  templatePointerPath?: string;
  lexLogGroup?: string;
  // Shared by the deployment.
  channelFlowArn?: string;
  channelFlowProcessorArn?: string;
  channelFlowProcessorFunctionName?: string;
}

/**
 * An assistant and its state, from its directory entry (ADR-048): every provisioner-owned assistant, declared
 * or created in the console. `failed` carries what the
 * build left behind; `retired` is a tombstone, kept because a name is never reused.
 */
export interface RuntimeAssistant {
  assistant: string;
  classification: string;
  role: string;
  status: 'provisioning' | 'active' | 'retiring' | 'retired' | 'failed';
  /** How it was asked for: declared in `deploy.config.json` and seeded by a deploy, or created in the console. */
  origin?: 'declared' | 'console';
  /** Whether retire accepts it: not a classification's primary (ADR-048, amended 2026-10-23). */
  retirable?: boolean;
  displayName?: string;
  /**
   * On an admin's listing, the team it was created for (its directory entry); on a team's roster, the team
   * whose `owner-team` tag names it. The tag is the record of ownership, so a row prefers the profile
   * listing's `ownerTeam`, which is read from the tag, whenever it has one.
   */
  ownerTeam?: string;
  error?: string;
  leftover?: string[];
  /** The build could not put the owner tag on the identity: the team cannot open it until an admin assigns it. */
  ownerSeedError?: string;
  /** The build could not seed the first draft; "new version" seeds it again. */
  firstDraftError?: string;
}

/** Where an assistant may be created: a conversational classification and the roles it declares. */
export interface RosterTarget {
  classification: string;
  roles: string[];
}

/** The Profiles tab's one read. The runtime roster and its targets are an admin's alone. */
export interface ProfilesListing {
  profiles: ProfileListing[];
  tools: ToolDescriptor[];
  runtimeAssistants: RuntimeAssistant[];
  rosterTargets: RosterTarget[];
  runtimeDirectoryUnreadable?: boolean;
  /** What each listed assistant's classification offers, by classification. */
  classifications?: Record<string, ClassificationCatalog>;
  /** What the page does with every version field. */
  fieldDecisions?: Record<string, FieldDecision>;
}

export interface ProfileListing {
  profileName: string;
  activeVersion: number | null;
  versions: ProfileVersionSummary[];
  hasDraft: boolean;
  draftConfigId?: string;
  resolved?: ResolvedInfra;
  /** The name people see beside its messages, when the listing could read it. */
  displayName?: string;
  /** The classification the assistant answers in, and its role there. */
  classification?: string;
  role?: string;
  /** The owning team, null when none owns it; absent when the owner could not be read. */
  ownerTeam?: string | null;
  /** How the assistant came to exist: declared in `deploy.config.json` and deployed, or created in the console. */
  origin?: 'deployed' | 'console';
  /**
   * Whether retire accepts it: it has a directory entry and is not a classification's primary. Retire is one path
   * for every assistant (ADR-048, amended 2026-10-23); how it was created decides nothing.
   */
  retirable?: boolean;
  /**
   * Turns per hour one person may send this assistant, as DEPLOYED: read-only, since a version cannot set
   * it. Absent or 0 means no per-assistant limit.
   */
  deployedTurnLimit?: number;
  /** How its turns are classified, as deployed (declared) or as created (console). Not part of a version. */
  deployedClassifierMode?: 'keyword' | 'llm';
  /** The active version's event workflows: each by name, the event that starts it and its rooms. Absent while none is active. */
  activeEventWorkflows?: Array<{ name: string; on: string; types?: string[] }>;
  /** Whether the active version declares an onboarding intake. */
  activeOnboarding?: boolean;
}

/**
 * One Converse tool as the BACKEND REGISTRY describes it (`backend/lambda/src/lib/tool-registry.ts`),
 * served with the profile listing.
 *
 * NOT MIRRORED HERE, and that is the point. This console kept a hand-written copy of the registry
 * (`services/toolRegistry.ts`) because a browser build cannot import a Lambda module - and it drifted
 * exactly as a second copy of anything does: it was two tools short, so the ops assistant's one tool
 * showed in the Profiles tab with no description and could not be unchecked in the draft editor. The
 * registry the backend validates against is now the one the console renders.
 */
export interface ToolDescriptor {
  name: string;
  category: 'context' | 'connector' | 'work-item' | 'task';
  changesState: boolean;
  /** One-line "how it functions", authored on the registry entry. */
  description: string;
  /** The RUNTIME precondition that must also hold for the tool to be offered, even when a profile
   *  allows it - so the console can explain "enabled, but only active when X". */
  requires: string;
}

export type ProfileManifest = Record<string, unknown>;

/** Throws the named configuration error when `AdminApi` is unconfigured. */
function requireApi(): void {
  if (!adminApiConfigured()) throw new Error(i18n.t('admin.profileService.vite_manage_profiles_api_urlNotConfigured'));
}

/**
 * A profile route in its two forms: the admin route, and the team route a team member's console reaches
 * for its own assistant (the encoded assistant is passed in). Each call site writes both paths out.
 */
interface ProfileRoute {
  admin: () => string;
  team: (assistant: string) => string;
}

/**
 * The URL for a route. A team member's call goes on the team route of the assistant it is about (the
 * profile it names), else of the assistant the console is scoped to; the session names only owned
 * assistants and the handler refuses a body naming another.
 */
function resolve(route: ProfileRoute, assistant?: string): string {
  requireApi();
  const team = teamAssistant();
  return team ? route.team(encodeURIComponent(assistant || team)) : route.admin();
}

/** Signed GET on the operator's sign-on credentials (every profile route is IAM-authorized). */
async function get<T>(assistant?: string): Promise<T> {
  const url = resolve({
    admin: () => adminUrl('assistant-admin', '/admin/profiles'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles`),
  }, assistant);
  const creds = await consoleCredentials();
  return sigv4GetJson<T>(url, {}, creds);
}

/** Signed POST to one profile action's route; each names its own capability. */
async function post<T>(route: ProfileRoute, body: Record<string, unknown>): Promise<T> {
  const named = [body.profileName, body.targetProfileName].find((v): v is string => typeof v === 'string' && !!v);
  const url = resolve(route, named);
  const creds = await consoleCredentials();
  return sigv4PostJson<T>(url, body, creds);
}

/**
 * The Profiles tab's one read: every profile, plus the tool registry that describes their `tools`.
 *
 * ONE REQUEST, TWO ANSWERS, because they are read together and the second is static metadata that
 * belongs to the first. A separate endpoint for the registry would be a second round trip and a second
 * thing to gate for no gain.
 */
export async function listProfilesAndTools(): Promise<ProfilesListing> {
  const r = await get<Partial<ProfilesListing>>();
  return {
    profiles: r.profiles || [],
    tools: r.tools || [],
    runtimeAssistants: r.runtimeAssistants || [],
    rosterTargets: r.rosterTargets || [],
    ...(r.runtimeDirectoryUnreadable ? { runtimeDirectoryUnreadable: true } : {}),
    ...(r.classifications ? { classifications: r.classifications } : {}),
    ...(r.fieldDecisions ? { fieldDecisions: r.fieldDecisions } : {}),
  };
}

/**
 * A TEAM MEMBER'S LISTING: each assistant their team owns, read on that assistant's own team route, so
 * the server answers for exactly what the session reaches and nothing outside it is fetched. The tool
 * registry is the same on every route, so the first answer's is kept.
 */
export async function listOwnedProfiles(assistants: readonly string[]): Promise<ProfilesListing> {
  const answers = await Promise.all(assistants.map((a) => get<Partial<ProfilesListing>>(a)));
  return {
    profiles: answers.flatMap((r) => r.profiles || []),
    tools: answers.find((r) => r.tools?.length)?.tools || [],
    runtimeAssistants: [],
    rosterTargets: [],
    // Each route answers for its own assistant's classification; the decisions are the same everywhere.
    classifications: Object.assign({}, ...answers.map((r) => r.classifications ?? {})),
    ...(answers.find((r) => r.fieldDecisions)?.fieldDecisions ? { fieldDecisions: answers.find((r) => r.fieldDecisions)!.fieldDecisions } : {}),
  };
}

/** Just the profiles, for a caller that only needs the options list. */
export async function listProfiles(): Promise<ProfileListing[]> {
  return (await listProfilesAndTools()).profiles;
}

export async function createProfileVersion(profileName: string): Promise<{ profileName: string; draftConfigId: string }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/version'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/version`),
  }, { profileName });
}

/**
 * A draft edit is a MERGE, so an omitted key keeps what the draft already had. `null` is how a field
 * is cleared - the same spelling JSON Merge Patch uses - because "inherit the configured default" is
 * a third state that neither omission (leave alone) nor an empty string (a name nobody can address)
 * can express.
 */
export type ProfileDraftPatch = { [K in keyof ProfileDefinitionBody]?: ProfileDefinitionBody[K] | null } & {
  /** The canvas layout (ADR-061 decision 7): saved with the draft as its own body, never part of what the version does. */
  layout?: WorkflowLayout | null;
};

export async function editProfileDraft(profileName: string, patch: ProfileDraftPatch): Promise<{ profileName: string; draftConfigId: string }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/draft'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/draft`),
  }, { profileName, patch });
}

/**
 * DISCARD THE DRAFT THIS CONSOLE IS SHOWING, named by its configId (SPEC-PORTABLE-PROFILES FR18). The server deletes it
 * only while it is still that configId: a draft saved since is refused `409 DRAFT_CHANGED` and kept, and no draft is
 * `404 NO_DRAFT`. Nothing serving changes.
 */
export async function discardProfileDraft(profileName: string, configId: string): Promise<{ profileName: string; discarded: true; configId: string }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/discard'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/discard`),
  }, { profileName, configId });
}

/** What Preview run says one workflow would do (ADR-061 decision 7): each step's outcome, and what each step would say or start. */
export interface WorkflowPreview {
  steps: Array<{ step: string; outcome: string }>;
  acts: Array<{ step: string; act: string; template?: string; to?: 'room' | string[]; values?: Record<string, string>; fallback?: boolean }>;
  ended?: 'success' | 'failure';
}

/**
 * PREVIEW RUN: one workflow, as the console holds it, walked on the server with sample values. It writes nothing and
 * says nothing (`a-preview-run-says-nothing-and-writes-nothing.test.ts`); a workflow that breaks the draft's rules is
 * refused with the reasons.
 */
export async function previewWorkflowRun(
  profileName: string,
  workflow: string,
  definition: import('../../../../../backend/lambda/src/lib/event-workflow.ts').EventWorkflow,
  sample: { values?: Record<string, string | boolean | string[]>; outcomes?: Record<string, 'success' | 'failure' | 'deadline'> } = {},
): Promise<WorkflowPreview> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/preview-run'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/preview-run`),
  }, { profileName, workflow, definition, ...sample });
}

export async function validateProfileDraft(profileName: string): Promise<{ profileName: string; valid: boolean; errors: string[]; configId: string; warnings?: string[]; errorDetails?: RouteError[] }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/validate'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/validate`),
  }, { profileName });
}

/** One regression entry the draft failed, on one attempt, and why (`lib/promotion-gate.ts`). */
export interface GoldenFailure { entryId: string; attempt: number; reason: 'error' | 'empty' | 'blocked' | 'breach'; rules?: string[] }

/** The gate's decision over a draft's run against the golden set (ADR-065). */
export interface GoldenResult {
  refused: boolean;
  failures: GoldenFailure[];
  readyToPromote: string[];
  pairedDifference: { mean: number; ci: [number | null, number | null]; entries: number } | null;
  minimumDetectable: number | null;
  notExercised: Array<{ entryId: string; reason: 'tools' }>;
  regressionExercised: number;
  entries: number;
  k: number;
}

/** The set's size and the draft's latest run, as Activate reads them. `gate` is null where there is no golden run. */
export interface GoldenGateReading {
  profileName: string;
  draft?: false;
  draftConfigId?: string;
  available?: boolean;
  gate?: {
    entries: number;
    regressionEntries: number;
    uncoveredRegression?: number;
    /** Per intent of the draft's pack (ADR-065 decision 6). */
    coverage?: IntentCoverage[];
    outsidePack?: Array<{ intent: string; entries: number }>;
    /** The minimum per intent the gate applies: the active version's, held at what the set can hold across the draft's intents. */
    minRegressionPerIntent?: number;
    /** The active version's own minimum, where it was held lower. */
    minDeclared?: number;
    /** The active version could not be read for its minimum. */
    minUnread?: boolean;
    run: {
      runId: string; draftConfigId: string; k: number; entriesTotal: number; entriesDone: number;
      status: 'running' | 'complete' | 'failed'; result: GoldenResult | null; error: string | null;
      startedBy: string; startedAt: string; completedAt: string | null;
    } | null;
  } | null;
  outcome?: { proceed: true; note: 'unavailable' | 'empty' | 'passed' | 'unmeasured'; unchecked?: string[] } | { proceed: false; code: string; params?: Record<string, string | number>; error: string; failures?: GoldenFailure[] };
}

/** The draft's latest run against the golden set (ADR-065). Read on demand: the console never polls it. */
export async function readGoldenGate(profileName: string): Promise<GoldenGateReading> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/golden-gate'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/golden-gate`),
  }, { profileName });
}

/** Run the draft against the golden set beside the active version. Spends model calls; posts nothing. */
export async function startGoldenRun(profileName: string): Promise<{ profileName: string; runId: string; draftConfigId: string }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/golden-run'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/golden-run`),
  }, { profileName });
}

/** An upload the server refused: its code and values, and each line it names (ADR-065 decision 7). */
export interface GoldenUploadRefusal {
  code: string;
  error?: string;
  params?: Record<string, string | number>;
  problems?: Array<{ line: number; code: string; field?: string }>;
  /** The lines the detector could not process. */
  lines?: number[];
}

/** A background batch as it was started: its id, which its channel and its result are read by. */
export interface GoldenBatchStarted {
  profileName: string;
  batchId: string;
  kind: 'upload' | 'generation';
  status: 'running';
  /** A row of this batch that started before this (less skew) is an earlier run of it, not this one. */
  startedAfter?: string;
}

/** How an upload or a generation ended (ADR-065 decisions 7, 8). */
export interface GoldenBatchReading {
  batchId: string;
  kind: 'upload' | 'generation';
  status: 'running' | 'complete' | 'refused' | 'failed';
  /** What was written (`imported` or `generated`), or the refusal's `code`, `params` and `lines`, or the `error`. */
  result: Record<string, unknown> | null;
  /** When this run of the batch started (the database's clock). */
  startedAt: string;
}

/** How a batch ended, read once when its channel says it ended, or when asked. */
export async function readGoldenBatch(profileName: string, batchId: string): Promise<{ profileName: string; batch: GoldenBatchReading }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/golden-set-batch'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/golden-set-batch`),
  }, { profileName, batchId });
}

/**
 * Add a deployment's own entries to the assistant's golden set, as capability, in the background. A file whose lines are
 * not entries is refused at once, thrown with its body; what the batch came to is read from `readGoldenBatch`.
 */
export async function uploadGoldenEntries(profileName: string, format: 'jsonl' | 'csv', content: string): Promise<GoldenBatchStarted> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/golden-set-import'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/golden-set-import`),
  }, { profileName, format, content });
}

/**
 * Write golden entries from the draft's intent pack (ADR-065 decision 8): requests for each intent, stored as capability
 * entries marked generated. Spends a model call per intent, so it is an editor's. A refusal is thrown with its body.
 */
export async function generateGoldenEntries(profileName: string, perIntent: number, generationId: string): Promise<GoldenBatchStarted> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/golden-set-generate'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/golden-set-generate`),
  }, { profileName, perIntent, generationId });
}

/** Retire the capability entries of one upload (`import-golden-set`) or one generation (`edit-profiles`). */
export async function retireGoldenUpload(profileName: string, uploadId: string, source: 'uploaded' | 'generated'): Promise<{ retired: number }> {
  // Each path written out, so the route table's check reads every URL the console calls.
  return source === 'generated'
    ? post({
      admin: () => adminUrl('assistant-admin', '/admin/profiles/golden-set-retire-generation'),
      team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/golden-set-retire-generation`),
    }, { profileName, uploadId })
    : post({
      admin: () => adminUrl('assistant-admin', '/admin/profiles/golden-set-retire-upload'),
      team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/golden-set-retire-upload`),
    }, { profileName, uploadId });
}

/**
 * `identityRename` reports the half of an activation that lands OUTSIDE the profile store: applying
 * the version's `displayName` to the assistant's Amazon Chime SDK identity.
 *
 * `unsupported` means this deployment has no applier for that assistant (the admin assistant), and
 * `unchanged` means the identity already read that way or the version names nothing - neither is a
 * failure. It is surfaced because a rename that did not reach the identity is otherwise invisible:
 * the console would show the new name and the room would keep the old one.
 */
export type IdentityRenameOutcome = 'applied' | 'unchanged' | 'unsupported' | 'failed';

export async function activateProfileDraft(profileName: string): Promise<{
  profileName: string;
  version?: number;
  identityRename?: IdentityRenameOutcome;
  identityRenameError?: string;
}> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/activate'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/activate`),
  }, { profileName });
}

/** What an administrator confirms to activate a draft past the golden gate (ADR-065 decision 5). */
export interface PastGateConfirmation {
  /** The draft the refusal was shown for. */
  configId: string;
  /** The refusal shown: its code, the values it was worded with and the run it was read from, which the server checks still stand. */
  code: string;
  params: Record<string, string | number>;
  runId?: string;
  reason: string;
}

/**
 * Activate the draft past the golden gate's refusal. An administrator's alone: the route is its own capability with no team
 * route, so it is always the admin URL. The server refuses a refusal that changed since it was shown (`GATE_CHANGED`, with
 * the one that stands) and a gate that no longer refuses (`GATE_NOT_REFUSING`).
 */
export async function activatePastGoldenGate(profileName: string, confirm: PastGateConfirmation): Promise<{
  profileName: string;
  version?: number;
  identityRename?: IdentityRenameOutcome;
  identityRenameError?: string;
}> {
  requireApi();
  return sigv4PostJson(adminUrl('assistant-admin', '/admin/profiles/activate-past-golden-gate'), { profileName, ...confirm }, await consoleCredentials());
}

export async function rollbackProfile(profileName: string, version: number): Promise<{ profileName: string; version?: number }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/rollback'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/rollback`),
  }, { profileName, version });
}

/** One message or prompt template as the console shows it (ADR-062): the shipped source, and the active sources. */
export interface MessageTemplateListing {
  name: string;
  kind: 'message' | 'prompt';
  description: string;
  shipped: string;
  /** The message may be saved as `fill: voice`: its call site may await a model (ADR-062 decision 4). */
  voiceable?: boolean;
  classification?: { contentHash: string; source: string };
  own?: { contentHash: string; source: string; history: string[] };
}

/** A language the deployment declares (`lib/config/languages.ts`), its own first. */
export interface DeclaredLanguage {
  tag: string;
  name: string;
  native: string;
}

/** Every template the platform ships, beside the assistant's classification's and its own active versions. */
/** Every active template in the assistant's own family, by name. */
export type AssistantTemplateFamily = Record<string, { contentHash: string; source: string; history: string[] }>;

export async function listMessageTemplates(profileName: string): Promise<{ assistant: string; classification: string; templates: MessageTemplateListing[]; family: AssistantTemplateFamily; languages?: DeclaredLanguage[] }> {
  const url = resolve({
    admin: () => adminUrl('assistant-admin', '/admin/templates'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/templates`),
  }, profileName);
  const creds = await consoleCredentials();
  return sigv4GetJson(url, { profileName }, creds);
}

/** Store a template in the assistant's own family and make it the one in use. */
export async function saveMessageTemplate(profileName: string, source: string, message?: string): Promise<{ name: string; contentHash: string; previous?: string; changed: boolean }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/templates/save'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/templates/save`),
  }, { profileName, source, ...(message ? { message } : {}) });
}

/** Return the assistant's own template to the version in use before. */
export async function rollbackMessageTemplate(profileName: string, name: string): Promise<{ name: string; from: string; to: string }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/templates/rollback'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/templates/rollback`),
  }, { profileName, name });
}

/** Export a version: the active one by default, a numbered one, or `'draft'` for the assistant's draft. */
export async function exportProfile(profileName: string, version?: number | 'draft'): Promise<ProfileManifest> {
  const r = await post<{ manifest: ProfileManifest }>({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/export'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/export`),
  }, version === 'draft' ? { profileName, draft: true } : { profileName, version });
  return r.manifest;
}

export async function importProfile(manifest: ProfileManifest, targetProfileName?: string): Promise<{ imported: string; configId: string; landedAs: string }> {
  return post({
    admin: () => adminUrl('assistant-admin', '/admin/profiles/import'),
    team: (a) => adminUrl('assistant-admin', `/admin/assistants/${a}/profiles/import`),
  }, { manifest, targetProfileName });
}

