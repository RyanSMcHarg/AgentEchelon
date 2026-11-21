/**
 * WHAT A CLASSIFICATION OFFERS ITS ASSISTANTS, as the console's assistant page reads it (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * The platform allows, the classification selects, the profile uses. A version's controls offer only what
 * the classification selects (its models, its guardrail catalog, its context-source catalog), and the
 * read-only rows say what the classification decides at deploy (its templates, its workflows, its topology,
 * its retrieval reach, its budgets). This reads each from where the runtime reads it, so the page and a turn
 * cannot disagree, and the write path still refuses anything outside it (`validateBody`): the console
 * offering only what is allowed is the first layer, the route refusing the rest is the second.
 *
 * Best-effort per part: a part that cannot be read is absent, and the console says it could not be read,
 * rather than failing the listing.
 */
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { modelFits } from '../../../lib/config/model-availability.js';
import { modelKindOf } from '../../../lib/config/model-catalog.js';
import { IMAGE_GEN_MODELS } from './image-gen-models.js';
import { answersThroughGeneral, parseIntentPack, resolvePackParameterValue, taskStateMachines, UNIVERSAL_INTENT_KEYS } from './intent-pack.js';
import { catalogIntentOf, type CatalogIntent, type StoredIntentPack } from './intent-pack-taxonomy.js';
import { DEFAULT_TASK_STATE_MACHINES, PLATFORM_TASK_MACHINE_KEYS, awaitedPartyOf, type TaskStateMachine, type TerminalKind } from './task-state-machines.js';
import { parseTemplatePointer, templatePointerPath } from './template-store.js';
import { buildSourceTable, catalogEntryForVariables, intakeFactKeys, publishedVariables, type PublishedVariables, type VariableCatalogEntry } from './variables.js';
import { parseIntakeConfig } from './onboarding-intake.js';
import { noticeTemplateName } from './shipped-message-templates.js';
import { parseWelcomeOrientationDetailed, type WelcomeOrientation } from './welcome-orientation.js';

export interface ClassificationCatalog {
  classification: string;
  /** The models a version may select, by use. `default` is the classification's default text model. */
  models: { text: string[]; image: string[]; default?: string };
  /** The guardrails a version may select (`/assistant/{c}/guardrails`). Absent when unreadable. */
  guardrails?: Array<{ key: string; guardrailId: string }>;
  /**
   * The context sources a version may select (`/assistant/{c}/context-sources`). Absent when unreadable. Each carries its
   * `type` and `prefix`, so the console reads which a role can read with the rule the turn applies (`readableByRole`).
   */
  contextSources?: Array<{ key: string; title?: string; description?: string; type?: string; prefix?: string }>;
  /** The deployment declares the `notifications` capability, so a workflow can offer email. */
  emailConfigured?: boolean;
  /** The document templates the classification holds, and the version each points at. Absent when unreadable. */
  templates?: Array<{ name: string; active: string }>;
  /**
   * The workflows (task machines) the classification offers: the platform's, and its own pack's. `required` marks the
   * platform machines every assistant has (`PLATFORM_TASK_MACHINE_KEYS`: the turn queue's), which no selection removes.
   */
  workflows?: Array<{ key: string; source: 'platform' | 'classification'; required: boolean; initial: string; states: string[]; steps: MachineStep[] }>;
  /** The intents the classification's pack declares, for a version that carries no pack of its own. */
  packIntents?: string[];
  /**
   * Where those intents come from: the classification's own `assistant-intent-pack` parameter, or the platform's default
   * pack, which the runtime serves to a classification that sets none (`parseIntentPack`).
   */
  packSource?: 'classification' | 'platform';
  /**
   * THE SAME INTENTS WITH WHAT EACH IS FOR, read from the pack the router and the processor read: the classifier's
   * description, the line a person reads (`summary`), the answering instructions, and the task machine a multi-step
   * intent runs (its own key, when the machines hold one by that name, as `planDelivery` opens it).
   */
  intents?: CatalogIntent[];
  /**
   * THE CLASSIFICATION'S PACK AS IT IS STORED, when the classification sets one: what a version copies as its own pack
   * when it first declares something of its own (a machine edited in the console), since a version's `intentPack`
   * replaces the classification's whole. Absent when the classification serves the platform's default pack, which a
   * version inherits with `extends: 'default'`.
   */
  storedPack?: StoredIntentPack;
  /**
   * THE MACHINES THIS DEPLOYMENT RUNS, whole, as the runtime resolves them for the classification (its pack's over the
   * platform's). The console starts a machine edit from these, never from the machines bundled into its own build, which
   * are only as current as the console's last deploy.
   */
  machines?: Record<string, TaskStateMachine>;
  /**
   * THE PLATFORM INTENTS EVERY ASSISTANT ANSWERS (the universal intents and `platform_question`), each with whether it
   * answers through the `general` route when a version gives it no route of its own (`ANSWERS_THROUGH_GENERAL`, ADR-064
   * decision A). Served from the resolver's own list, so the console's Platform intents group cannot drift from it.
   */
  platformIntents: PlatformIntent[];
  /** The deployed sizing of the classification's processor. */
  topology?: { processorTimeout: number; memorySize: number; reservedConcurrency?: number; maxTokens?: number };
  /** The company-context prefixes the classification grants (every role's boundary). */
  retrievalReach: string[];
  /** The bucket the company-context prefixes are keys in: the deployment's company bucket. Absent when unconfigured. */
  contextBucket?: string;
  /** Each role's own context prefixes: narrowed below the classification, never widened past it. */
  roles: Record<string, { contextPrefixes: string[] }>;
  /**
   * Every variable source the classification publishes (ADR-060 decision 1), each with its type, trust and whether it
   * may decide: the table validation reads, built from the same catalog parameter, so the console's picker offers what a
   * version may name and no more. Its `ctx:` sources are absent when the catalog is unreadable, and its `fact:` keys when
   * the intake is.
   */
  variables: PublishedVariables;
  /** The spend budgets the classification's router enforces, as deployed. Absent when unreadable. */
  budgets?: { userHourly?: number; globalHourly?: number };
  /**
   * THE DEPLOYMENT'S WELCOME ORIENTATION FOR THIS CLASSIFICATION (`/assistant/{c}/welcome-orientation`), as the router reads
   * it: what the primary's opening is built from when its version sets no opening of its own. Served so the console's
   * preview shows the text the room is actually greeted with. Absent when unset or unreadable.
   */
  welcomeOrientation?: WelcomeOrientation;
  /** The classification's primary assistant: the only one the deployment's orientation applies to (`deploymentCopyAppliesTo`). */
  primaryAssistant?: string;
  /**
   * THE DEPLOYMENT'S ONBOARDING INTAKE FOR THIS CLASSIFICATION (`/assistant/{c}/onboarding-intake`), as the router reads it:
   * what the primary asks a person it has not met when its version carries no onboarding of its own
   * (`intakeForAssistant`). Its greeting and the questions, in order, so the console shows what is asked. Absent when
   * unset or unreadable.
   */
  onboardingIntake?: { greeting?: string; questions: string[] };
  /** The deployment-wide lines a message is said from where no stored template fits, by template name (`deploymentLinesOf`). */
  deploymentLines?: Record<string, string>;
}

/** One platform intent, as the console's Platform intents group lists it. */
export interface PlatformIntent { key: string; answersThroughGeneral: boolean }

/** The intent the platform adds beside the universal ones, which a pack declares to offer. */
const PLATFORM_QUESTION = 'platform_question';

/** The platform intents and how each answers when a version gives it no route of its own. */
export function platformIntents(): PlatformIntent[] {
  return [...UNIVERSAL_INTENT_KEYS, PLATFORM_QUESTION].map((key) => ({ key, answersThroughGeneral: answersThroughGeneral(key) }));
}

/** One intent of the classification's pack, as the assistant page shows it (`catalogIntentOf`). */
export type { CatalogIntent } from './intent-pack-taxonomy.js';

/**
 * ONE STEP OF A TASK MACHINE, as the assistant page lists it: who it waits on, what it needs before moving on, whether it
 * delivers a document and with which template, where it may go next (reopens included), and its instructions.
 * Read from the machine the runtime authorizes transitions against, never restated.
 */
export interface MachineStep {
  key: string;
  label?: string;
  /** The party the step waits on (`awaitedPartyOf`); absent when the assistant moves it or it is terminal. */
  awaits?: 'requester' | 'worker';
  terminal?: TerminalKind;
  requires?: string[];
  /** What the step hands over (`produces`), present when it is not text. */
  produces?: 'image' | 'document';
  /** The tools that must have run before the task leaves the step (`requiresTool`, ADR-064 decision 3). */
  requiresTool?: string[];
  /** The template a delivering step fills: the one it names, or the ones the person chooses between. */
  templates?: string[];
  defaultTemplate?: string;
  transitions: string[];
  reopens?: string[];
  /** The tool the platform runs when a task enters the step. */
  action?: string;
  prompt?: string;
}


/** The steps of a machine in declared order, each read through the runtime's own readers. */
export function machineSteps(machine: TaskStateMachine): MachineStep[] {
  return Object.entries(machine.states).map(([key, def]) => {
    const party = awaitedPartyOf(def)?.party;
    const templates = def.template ? [def.template] : def.templates?.length ? [...def.templates] : undefined;
    return {
      key,
      transitions: [...(def.transitions ?? [])],
      ...(def.label ? { label: def.label } : {}),
      ...(party ? { awaits: party } : {}),
      ...(def.terminal ? { terminal: def.terminal } : {}),
      ...(def.requires?.length ? { requires: [...def.requires] } : {}),
      ...(def.produces && def.produces !== 'text' ? { produces: def.produces } : {}),
      ...(def.requiresTool?.length ? { requiresTool: [...def.requiresTool] } : {}),
      ...(templates ? { templates } : {}),
      ...(def.defaultTemplate ? { defaultTemplate: def.defaultTemplate } : {}),
      ...(def.reopens?.length ? { reopens: [...def.reopens] } : {}),
      ...(def.action?.tool ? { action: def.action.tool } : {}),
      ...(def.prompt ? { prompt: def.prompt } : {}),
    };
  });
}

const optional = async (ssm: SSMClient, name: string): Promise<string | undefined> => {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name })))?.Parameter?.Value;
  } catch {
    return undefined;
  }
};

const jsonArray = (raw: string | undefined): Array<Record<string, unknown>> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : undefined;
  } catch {
    return undefined;
  }
};

/** The models a classification lets a version select, by use, from the deployment's catalog keys. */
export function allowedModelsFor(classification: string, catalogKeys: readonly string[]): ClassificationCatalog['models'] {
  const text = catalogKeys.filter((k) => modelKindOf(k) !== 'external' && modelFits(k, classification, 'text') === null);
  const image = Object.keys(IMAGE_GEN_MODELS).filter((k) => modelFits(k, classification, 'image') === null);
  const def = profiles.defaultModelOf(classification);
  return { text, image, ...(def ? { default: def } : {}) };
}

async function templatesOf(ssm: SSMClient, ssmRoot: string, c: string): Promise<ClassificationCatalog['templates']> {
  const out: Array<{ name: string; active: string }> = [];
  const path = templatePointerPath(ssmRoot, c);
  let token: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: path, MaxResults: 10, NextToken: token }));
    for (const p of page?.Parameters ?? []) {
      const pointer = parseTemplatePointer(p.Value);
      const name = (p.Name ?? '').slice(path.length + 1);
      if (pointer && name) out.push({ name, active: pointer.active });
    }
    token = page?.NextToken;
  } while (token);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The classification's router's environment, as deployed: where its budgets and its deployment-wide lines are set. */
async function routerEnvOf(ssm: SSMClient, lambda: LambdaClient, ssmRoot: string, c: string): Promise<Record<string, string> | undefined> {
  const routerArn = await optional(ssm, `${ssmRoot}/assistant/${c}/router-arn`);
  if (!routerArn) return undefined;
  const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: routerArn }));
  return cfg?.Environment?.Variables ?? {};
}

/**
 * THE DEPLOYMENT-WIDE LINES A MESSAGE IS SAID FROM, by template name, as the router reads them: the budget notice's
 * `BUDGET_CANNED_RESPONSE` (`noticeSelection`), which wins over the shipped template where no stored one fits.
 */
function deploymentLinesOf(env: Record<string, string> | undefined): Record<string, string> | undefined {
  const budget = env?.BUDGET_CANNED_RESPONSE?.trim();
  return budget ? { [noticeTemplateName('budgetExhausted')]: budget } : undefined;
}

function budgetsOf(env: Record<string, string> | undefined): ClassificationCatalog['budgets'] {
  if (!env) return undefined;
  const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const userHourly = num(env.BEDROCK_USER_HOURLY_BUDGET);
  const globalHourly = num(env.BEDROCK_GLOBAL_HOURLY_BUDGET);
  return { ...(userHourly !== undefined ? { userHourly } : {}), ...(globalHourly !== undefined ? { globalHourly } : {}) };
}

/** One classification's catalog. Never throws: an unreadable part is left out. */
/** The stored pack's object form: a bare array of intents is the older shape of `{ intents }`. Undefined when unreadable. */
export function storedPackOf(raw: string | undefined): StoredIntentPack | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return { intents: parsed as StoredIntentPack['intents'] };
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as StoredIntentPack).intents)) return parsed as StoredIntentPack;
  } catch { /* unreadable: no version can copy it */ }
  return undefined;
}

export async function classificationCatalog(
  ssm: SSMClient,
  lambda: LambdaClient,
  ssmRoot: string,
  classification: string,
  catalogKeys: readonly string[],
): Promise<ClassificationCatalog> {
  const c = classification;
  const safe = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (err) {
      console.warn(`[classification-catalog] part unreadable for '${c}'`, (err as { name?: string })?.name ?? err);
      return undefined;
    }
  };
  const [guardrailsRaw, sourcesRaw, packValue, templates, routerEnv, intakeRaw, welcomeRaw] = await Promise.all([
    optional(ssm, `${ssmRoot}/assistant/${c}/guardrails`),
    optional(ssm, `${ssmRoot}/assistant/${c}/context-sources`),
    optional(ssm, `${ssmRoot}/assistant/${c}/assistant-intent-pack`),
    safe(() => templatesOf(ssm, ssmRoot, c)),
    safe(() => routerEnvOf(ssm, lambda, ssmRoot, c)),
    optional(ssm, `${ssmRoot}/assistant/${c}/onboarding-intake`),
    optional(ssm, `${ssmRoot}/assistant/${c}/welcome-orientation`),
  ]);
  const budgets = budgetsOf(routerEnv);
  const deploymentLines = deploymentLinesOf(routerEnv);
  const welcomeOrientation = welcomeRaw ? parseWelcomeOrientationDetailed(welcomeRaw).orientation ?? undefined : undefined;
  let primaryAssistant: string | undefined;
  try { primaryAssistant = profiles.profileFor(c)?.name; } catch { /* undeclared */ }
  const guardrails = jsonArray(guardrailsRaw)
    ?.filter((g) => typeof g.key === 'string' && typeof g.guardrailId === 'string')
    .map((g) => ({ key: g.key as string, guardrailId: g.guardrailId as string }));
  const contextSources = jsonArray(sourcesRaw)
    ?.filter((s) => typeof s.key === 'string')
    .map((s) => ({
      key: s.key as string,
      ...(typeof s.title === 'string' ? { title: s.title } : {}),
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
      ...(typeof s.type === 'string' ? { type: s.type } : {}),
      ...(typeof s.prefix === 'string' ? { prefix: s.prefix } : {}),
    }));
  const packRaw = await safe(() => resolvePackParameterValue(packValue, c));
  const pack = await safe(async () => parseIntentPack(packRaw));
  const storedPack = packValue && pack ? storedPackOf(packRaw) : undefined;
  // THE SOURCE TABLE, AS VALIDATION BUILDS IT (`versionVariableErrors`): the published catalog with each entry's trust,
  // the declared classifications, and the deployment intake's fact keys.
  let facts: string[] | undefined;
  let onboardingIntake: ClassificationCatalog['onboardingIntake'];
  try {
    const intake = intakeRaw ? parseIntakeConfig(intakeRaw) : undefined;
    facts = intake ? intakeFactKeys([intake]) : undefined;
    if (intake?.fields.length) onboardingIntake = { ...(intake.greeting ? { greeting: intake.greeting } : {}), questions: intake.fields.map((f) => f.prompt) };
  } catch { /* an unreadable intake publishes no fact keys */ }
  let classifications: string[] = [];
  try { classifications = profiles.classificationValues(); } catch { /* undeclared */ }
  const variables = publishedVariables(buildSourceTable({
    catalog: (jsonArray(sourcesRaw) ?? []).filter((s) => typeof s.key === 'string').map((s) => catalogEntryForVariables(s as unknown as VariableCatalogEntry)),
    classifications,
    ...(facts ? { facts } : {}),
  }));
  const machines = pack ? taskStateMachines(pack) : DEFAULT_TASK_STATE_MACHINES;
  const workflows = Object.entries(machines).map(([key, m]) => ({
    key,
    source: (pack?.machines && key in pack.machines ? 'classification' : 'platform') as 'platform' | 'classification',
    required: (PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(key),
    initial: m.initial,
    states: Object.keys(m.states),
    steps: machineSteps(m),
  }));
  // THE PACK THE RUNTIME SERVES: the classification's own, or the platform's default pack when it sets none.
  // A multi-step intent opens a task of its own key (`planDelivery`), so its machine is the one by that name.
  const intents: CatalogIntent[] | undefined = pack ? pack.intents.map((i) => catalogIntentOf(i, machines)) : undefined;
  let topology: ClassificationCatalog['topology'];
  try {
    const t = profiles.requireTopology(c);
    topology = { processorTimeout: t.timeoutSeconds, memorySize: t.memorySize, reservedConcurrency: t.reservedConcurrency, maxTokens: t.maxTokens };
  } catch { /* a classification with no topology of its own */ }
  const roles = Object.fromEntries(profiles.rolesFor(c).map((r) => {
    let contextPrefixes: string[] = [];
    try { contextPrefixes = profiles.contextPrefixesForRole(c, r); } catch { /* a misdeclared role reads nothing */ }
    return [r, { contextPrefixes }];
  }));
  let retrievalReach: string[] = [];
  try { retrievalReach = profiles.contextPrefixesGranted(c); } catch { /* undeclared */ }
  return {
    classification: c,
    ...(process.env.EMAIL_CONFIGURED === 'true' ? { emailConfigured: true } : {}),
    models: allowedModelsFor(c, catalogKeys),
    ...(guardrails ? { guardrails } : {}),
    ...(contextSources ? { contextSources } : {}),
    ...(templates ? { templates } : {}),
    workflows,
    platformIntents: platformIntents(),
    ...(pack ? { packIntents: pack.intents.map((i) => i.key), packSource: packValue ? 'classification' as const : 'platform' as const } : {}),
    ...(intents ? { intents } : {}),
    ...(storedPack ? { storedPack } : {}),
    machines,
    ...(topology ? { topology } : {}),
    retrievalReach,
    ...(process.env.CONTEXT_BUCKET ? { contextBucket: process.env.CONTEXT_BUCKET } : {}),
    roles,
    variables,
    ...(budgets ? { budgets } : {}),
    ...(welcomeOrientation ? { welcomeOrientation } : {}),
    ...(onboardingIntake ? { onboardingIntake } : {}),
    ...(deploymentLines ? { deploymentLines } : {}),
    ...(primaryAssistant ? { primaryAssistant } : {}),
  };
}
