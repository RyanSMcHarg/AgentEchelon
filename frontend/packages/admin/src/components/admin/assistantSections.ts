/**
 * AN ASSISTANT'S PAGE, READ AS ITS SECTIONS (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * The page is one section at a time, chosen from a menu: Behavioral, Workflows, Scope and models, Tools and context,
 * Variables, Versions. Each section owns the draft areas (`draftAreas.ts`) it edits, so the menu's changed mark and the
 * header's count are the draft's own diff, read once. The workflows a section lists are the version's own and the
 * platform's shipped ones (`PLATFORM_EVENT_WORKFLOWS`), and the intents are the version's and its classification's pack
 * (`CatalogIntent`), so nothing here restates what a workflow or an intent is.
 */
import { PLATFORM_EVENT_WORKFLOWS, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { draftDiff, type DraftArea } from './draftAreas';
import type { ClassificationCatalog, IntentRoute, ProfileDefinitionBody } from '../../services/profileService';

export const SECTIONS = ['behavioral', 'workflows', 'scope', 'tools', 'variables', 'versions'] as const;
export type Section = typeof SECTIONS[number];

/** The draft areas each section edits. Versions edits none; Variables is explained, not edited. */
export const SECTION_AREAS: Record<Section, readonly DraftArea[]> = {
  behavioral: ['identity'],
  workflows: ['welcome', 'events', 'messages'],
  scope: ['models', 'routing'],
  tools: ['abilities'],
  variables: ['variables'],
  versions: [],
};

/**
 * THE CREATION WIZARD'S STEPS. The first two make the assistant (where it answers and its name, then its starting point
 * and models); the build makes its first draft; then the draft is shaped in the page's own sections, in the page's
 * order, and the last step is the page's draft banner: Discard draft, Validate and Activate, over what the draft sets.
 * Variables is read-only and Versions holds nothing before the first activation, so neither is a step.
 */
export const WIZARD_SECTIONS = ['behavioral', 'workflows', 'scope', 'tools'] as const satisfies readonly Section[];
export type WizardSection = typeof WIZARD_SECTIONS[number];
export const CREATION_STEPS = ['assistant', 'start', ...WIZARD_SECTIONS, 'review'] as const;
export type CreationStep = typeof CREATION_STEPS[number];

/** Each step's name: the page's own section title for a section, the create's own for the rest. */
export function creationSteps(t: (key: string) => string): Array<{ key: CreationStep; label: string }> {
  return CREATION_STEPS.map((key) => ({
    key,
    label: (WIZARD_SECTIONS as readonly string[]).includes(key) ? t(`admin.assistantPage.sections.${key}.title`) : t(`admin.create.step.${key}`),
  }));
}

/** The sections whose areas the draft changes against the active version (every area it sets, while none is active). */
export function changedSections(active: Partial<ProfileDefinitionBody> | null, draft: Partial<ProfileDefinitionBody> | null): Set<Section> {
  if (!draft) return new Set();
  const areas = new Set(draftDiff(active, draft).map((d) => d.area));
  return new Set(SECTIONS.filter((s) => SECTION_AREAS[s].some((a) => areas.has(a))));
}

type Workflows = Record<string, EventWorkflow>;
const isWelcome = (wf: EventWorkflow | undefined) => wf?.on === 'assistant-joined';

/** A version's own workflows of one kind: its welcomes (on `assistant-joined`) or its other event workflows. */
export function ownWorkflows(body: Partial<ProfileDefinitionBody> | null, welcome: boolean): Array<[string, EventWorkflow]> {
  return Object.entries((body?.eventWorkflows ?? {}) as Workflows).filter(([, wf]) => isWelcome(wf) === welcome);
}

/** The platform's shipped workflows of one kind, read-only, which a draft may copy in. */
export function platformWorkflows(welcome: boolean): Array<[string, EventWorkflow]> {
  return Object.entries(PLATFORM_EVENT_WORKFLOWS).filter(([, wf]) => isWelcome(wf) === welcome);
}

/** The name a copied workflow takes: its own, or the first `<name>-<n>` the version does not hold. */
export function copyName(own: Readonly<Workflows> | undefined, name: string): string {
  if (!own?.[name]) return name;
  for (let n = 2; ; n += 1) if (!own[`${name}-${n}`]) return `${name}-${n}`;
}

/** The version's workflows with a platform workflow copied in under a free name, as `workflowsWith` copies one. */
export function withPlatformCopy(own: Readonly<Workflows> | undefined, name: string): { name: string; workflows: Workflows } {
  const at = copyName(own, name);
  return { name: at, workflows: { ...(own ?? {}), [at]: JSON.parse(JSON.stringify(PLATFORM_EVENT_WORKFLOWS[name])) as EventWorkflow } };
}

/** One intent as its card shows it. */
export interface IntentCard {
  key: string;
  /** What a person gets (the pack's `summary`), else what the classifier reads (`description`). */
  purpose?: string;
  description?: string;
  instructions?: string;
  multiStep: boolean;
  machine?: string;
  /** What a turn of the intent hands over (the pack's `needs`); `image` makes the card offer an image model. */
  needs?: string;
  /** The route the version declares: its text model, image model and step overrides. Absent means no route of its own. */
  route?: IntentRoute;
}

/**
 * THE INTENTS A VERSION ANSWERS, as cards: the version's own pack when it carries one, else its classification's, each
 * with what the classification's pack says of it and the route the version declares. A route for an intent neither
 * pack names (an image route) is listed too, so every model the version chooses is on a card.
 */
/**
 * THE INTENTS THE VERSION'S PACK DECLARES: its own pack when it carries one, else its classification's. A route the
 * version holds for an intent no pack names is not one of them, so the Intent pack row never lists it.
 */
export function packIntentKeys(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined): string[] {
  return body?.intentPack?.intents?.map((i) => i.key) ?? catalog?.intents?.map((i) => i.key) ?? catalog?.packIntents ?? [];
}

export function intentCards(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined): IntentCard[] {
  const fromCatalog = new Map((catalog?.intents ?? []).map((i) => [i.key, i]));
  const own = body?.intentPack?.intents;
  const keys = packIntentKeys(body, catalog);
  const routes = body?.models?.byIntent ?? {};
  const all = [...keys, ...Object.keys(routes).filter((k) => !keys.includes(k))];
  return all.map((key) => {
    const c = fromCatalog.get(key);
    const description = own?.find((i) => i.key === key)?.description ?? c?.description;
    const purpose = c?.summary ?? description;
    const r = routes[key];
    return {
      key,
      ...(purpose ? { purpose } : {}),
      ...(description ? { description } : {}),
      ...(c?.instructions ? { instructions: c.instructions } : {}),
      multiStep: !!c?.multiStep,
      ...(c?.machine ? { machine: c.machine } : {}),
      ...(c?.needs ? { needs: c.needs } : {}),
      ...(r ? { route: r } : {}),
    };
  });
}

/** The intents of the classification's pack that run a machine. */
export function intentsRunning(catalog: ClassificationCatalog | undefined, machine: string): string[] {
  return (catalog?.intents ?? []).filter((i) => i.machine === machine).map((i) => i.key);
}

/** One platform intent as the Platform intents group reads it: its own route, the `general` route, or the base model. */
export interface PlatformIntentRow { key: string; answers: 'own' | 'general' | 'base' }

/**
 * THE PLATFORM INTENTS GROUP (ADR-064 decision 5): the universal intents and `platform_question`, read from the catalog
 * (which serves the resolver's own `ANSWERS_THROUGH_GENERAL`), each with where its turns are answered in this version.
 */
export function platformIntentRows(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined): PlatformIntentRow[] {
  const routes = body?.models?.byIntent ?? {};
  return (catalog?.platformIntents ?? []).map((p) => ({
    key: p.key,
    answers: routes[p.key] && (routes[p.key].primary || routes[p.key].image) ? 'own' : p.answersThroughGeneral ? 'general' : 'base',
  }));
}
