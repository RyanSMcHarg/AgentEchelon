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
import { answersThroughGeneral, needsOf, parseIntentPack, resolvePackParameterValue, taskStateMachines, UNIVERSAL_INTENT_KEYS } from './intent-pack.js';
import { DEFAULT_TASK_STATE_MACHINES, PLATFORM_TASK_MACHINE_KEYS, awaitedPartyOf, type TaskStateMachine, type TerminalKind } from './task-state-machines.js';
import { parseTemplatePointer, templatePointerPath } from './template-store.js';
import { bodyBucket } from './profile-bodies.js';
import { buildSourceTable, catalogEntryForVariables, intakeFactKeys, publishedVariables, type PublishedVariables, type VariableCatalogEntry } from './variables.js';
import { parseIntakeConfig } from './onboarding-intake.js';

export interface ClassificationCatalog {
  classification: string;
  /** The models a version may select, by use. `default` is the classification's default text model. */
  models: { text: string[]; image: string[]; default?: string };
  /** The guardrails a version may select (`/assistant/{c}/guardrails`). Absent when unreadable. */
  guardrails?: Array<{ key: string; guardrailId: string }>;
  /** The context sources a version may select (`/assistant/{c}/context-sources`). Absent when unreadable. */
  contextSources?: Array<{ key: string; description?: string }>;
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
   * THE SAME INTENTS WITH WHAT EACH IS FOR, read from the pack the router and the processor read: the classifier's
   * description, the line a person reads (`summary`), the answering instructions, and the task machine a multi-step
   * intent runs (its own key, when the machines hold one by that name, as `planDelivery` opens it).
   */
  intents?: CatalogIntent[];
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
  /** The bucket the company-context prefixes are keys in: the deployment's attachments bucket. Absent when unconfigured. */
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
}

/** One platform intent, as the console's Platform intents group lists it. */
export interface PlatformIntent { key: string; answersThroughGeneral: boolean }

/** The intent the platform adds beside the universal ones, which a pack declares to offer. */
const PLATFORM_QUESTION = 'platform_question';

/** The platform intents and how each answers when a version gives it no route of its own. */
export function platformIntents(): PlatformIntent[] {
  return [...UNIVERSAL_INTENT_KEYS, PLATFORM_QUESTION].map((key) => ({ key, answersThroughGeneral: answersThroughGeneral(key) }));
}

/** One intent of the classification's pack, as the assistant page shows it. */
export interface CatalogIntent {
  key: string;
  description: string;
  summary?: string;
  instructions?: string;
  /** True when a turn of this intent opens a task (`delivery: TASK_MULTI_STEP`). */
  multiStep: boolean;
  /** The machine that task runs: the intent's own key, present only when the machines declare it. */
  machine?: string;
  /** What a turn of this intent hands over (`needsOf`): `image` makes the card offer an image model. */
  needs?: string;
}

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

async function budgetsOf(ssm: SSMClient, lambda: LambdaClient, ssmRoot: string, c: string): Promise<ClassificationCatalog['budgets']> {
  const routerArn = await optional(ssm, `${ssmRoot}/assistant/${c}/router-arn`);
  if (!routerArn) return undefined;
  const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: routerArn }));
  const env = cfg?.Environment?.Variables ?? {};
  const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const userHourly = num(env.BEDROCK_USER_HOURLY_BUDGET);
  const globalHourly = num(env.BEDROCK_GLOBAL_HOURLY_BUDGET);
  return { ...(userHourly !== undefined ? { userHourly } : {}), ...(globalHourly !== undefined ? { globalHourly } : {}) };
}

/** One classification's catalog. Never throws: an unreadable part is left out. */
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
  const [guardrailsRaw, sourcesRaw, packValue, templates, budgets, intakeRaw] = await Promise.all([
    optional(ssm, `${ssmRoot}/assistant/${c}/guardrails`),
    optional(ssm, `${ssmRoot}/assistant/${c}/context-sources`),
    optional(ssm, `${ssmRoot}/assistant/${c}/assistant-intent-pack`),
    safe(() => templatesOf(ssm, ssmRoot, c)),
    safe(() => budgetsOf(ssm, lambda, ssmRoot, c)),
    optional(ssm, `${ssmRoot}/assistant/${c}/onboarding-intake`),
  ]);
  const guardrails = jsonArray(guardrailsRaw)
    ?.filter((g) => typeof g.key === 'string' && typeof g.guardrailId === 'string')
    .map((g) => ({ key: g.key as string, guardrailId: g.guardrailId as string }));
  const contextSources = jsonArray(sourcesRaw)
    ?.filter((s) => typeof s.key === 'string')
    .map((s) => ({ key: s.key as string, ...(typeof s.description === 'string' ? { description: s.description } : {}) }));
  const pack = await safe(async () => parseIntentPack(await resolvePackParameterValue(packValue, c)));
  // THE SOURCE TABLE, AS VALIDATION BUILDS IT (`versionVariableErrors`): the published catalog with each entry's trust,
  // the declared classifications, and the deployment intake's fact keys.
  let facts: string[] | undefined;
  try { facts = intakeRaw ? intakeFactKeys([parseIntakeConfig(intakeRaw)]) : undefined; } catch { /* an unreadable intake publishes no fact keys */ }
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
  // A multi-step intent opens a task of its own key (`planDelivery`), so its machine is the one by that name.
  const intents: CatalogIntent[] | undefined = pack && packValue ? pack.intents.map((i) => {
    const multiStep = i.delivery === 'TASK_MULTI_STEP';
    return {
      key: i.key,
      description: i.description,
      ...(i.summary ? { summary: i.summary } : {}),
      ...(i.instructions ? { instructions: i.instructions } : {}),
      multiStep,
      ...(multiStep && machines[i.key] ? { machine: i.key } : {}),
      ...(needsOf(i) ? { needs: needsOf(i) } : {}),
    };
  }) : undefined;
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
    models: allowedModelsFor(c, catalogKeys),
    ...(guardrails ? { guardrails } : {}),
    ...(contextSources ? { contextSources } : {}),
    ...(templates ? { templates } : {}),
    workflows,
    platformIntents: platformIntents(),
    ...(pack && packValue ? { packIntents: pack.intents.map((i) => i.key) } : {}),
    ...(intents ? { intents } : {}),
    ...(topology ? { topology } : {}),
    retrievalReach,
    ...(bodyBucket() ? { contextBucket: bodyBucket() } : {}),
    roles,
    variables,
    ...(budgets ? { budgets } : {}),
  };
}
