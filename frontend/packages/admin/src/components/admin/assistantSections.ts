/**
 * AN ASSISTANT'S PAGE, READ AS ITS SECTIONS (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * The page is one section at a time, chosen from a menu: Behavioral, Workflows, Processes, Messages, Scope and models, Tools and
 * context, Variables, Versions. Each section owns the draft areas (`draftAreas.ts`) it edits, so the menu's changed mark and the
 * header's count are the draft's own diff, read once. The workflows a section lists are the version's own and the
 * platform's shipped ones (`SHIPPED_EVENT_WORKFLOWS`), and the intents are the version's and its classification's pack
 * (`CatalogIntent`), so nothing here restates what a workflow or an intent is.
 */
import {
  EVENT_WORKFLOW_EVENTS, SHIPPED_EVENT_WORKFLOWS, declaredWorkflowOn, openedWorkflowOf, personJoinedWorkflowOf, welcomeWorkflowOf, subjectChangedWorkflowOf,
  type EventWorkflow,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { CONVERSATION_TYPES } from '../../../../../../backend/lib/config/conversation-types.ts';
import { conflictingWorkflow } from './workflowEdits';
import { draftDiff, type DraftArea } from './draftAreas';
import { catalogIntentOf, refusedPlatformIntents, resolveStoredPack, type StoredIntentPack } from '../../../../../../backend/lambda/src/lib/intent-pack-taxonomy.ts';
import { GENERAL_ROUTE_KEY, answersThroughGeneral, platformRoutesServedOn } from '../../../../../../backend/lambda/src/lib/model-resolver.ts';
import { IMAGE_ROUTE_KEY, imagePrimaryOf, isImageRoute, type ImageRouteSource } from '../../../../../../backend/lambda/src/lib/image-route.ts';
import { DEFAULT_MODEL, type CatalogIntent, type ClassificationCatalog, type IntentRoute, type ProfileDefinitionBody } from '../../services/profileService';

export const SECTIONS = ['behavioral', 'scope', 'workflows', 'processes', 'messages', 'tools', 'settings', 'variables', 'versions', 'infrastructure'] as const;
export type Section = typeof SECTIONS[number];

/** The draft areas each section edits. Versions edits none; Variables is explained, not edited. */
export const SECTION_AREAS: Record<Section, readonly DraftArea[]> = {
  behavioral: ['identity'],
  workflows: ['events'],
  processes: ['processes'],
  messages: ['messages'],
  scope: ['models', 'routing'],
  tools: ['abilities'],
  settings: ['settings'],
  variables: ['variables'],
  versions: [],
  infrastructure: [],
};

/**
 * THE CREATION WIZARD'S STEPS. The first two make the assistant (where it answers and its name, then its starting point
 * and models); the build makes its first draft; then the draft is shaped in the page's own sections, in the page's
 * order, and the last step is the page's draft banner: Discard draft, Validate and Activate, over what the draft sets.
 * Variables is read-only and Versions holds nothing before the first activation, so neither is a step.
 */
export const WIZARD_SECTIONS = ['behavioral', 'scope', 'workflows', 'messages', 'tools', 'settings'] as const satisfies readonly Section[];
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

/**
 * Whether the draft changes a field no section edits (the `other` of `draftDiff`: the intent pack, onboarding, the
 * boundary, a tested instruction), which an import or the CLI can change and which still changes what activates.
 */
export function changesOtherFields(active: Partial<ProfileDefinitionBody> | null, draft: Partial<ProfileDefinitionBody> | null): boolean {
  return !!draft && draftDiff(active, draft).some((d) => d.area === 'other');
}

type Workflows = Record<string, EventWorkflow>;
const isWelcome = (wf: EventWorkflow | undefined) => wf?.on === 'assistant-joined';

/** A version's own workflows of one kind: its welcomes (on `assistant-joined`) or its other event workflows. */
export function ownWorkflows(body: Partial<ProfileDefinitionBody> | null, welcome: boolean): Array<[string, EventWorkflow]> {
  return Object.entries((body?.eventWorkflows ?? {}) as Workflows).filter(([, wf]) => isWelcome(wf) === welcome);
}

/** The platform's shipped workflows of one kind, read-only, which a draft may copy in. */
export function platformWorkflows(welcome: boolean): Array<[string, EventWorkflow]> {
  return Object.entries(SHIPPED_EVENT_WORKFLOWS).filter(([, wf]) => isWelcome(wf) === welcome);
}

/**
 * THE PLATFORM WORKFLOWS THAT RUN BY DEFAULT: the ones the runtime's own selection picks for a version that declares
 * none (`welcomeWorkflowOf`, `openedWorkflowOf`, `personJoinedWorkflowOf`, `declaredWorkflowOn`), in every kind of
 * room. Every other platform workflow runs only once a version copies it in.
 */
export function platformWorkflowsRunByDefault(): Set<string> {
  const names = new Set<string>();
  for (const type of [undefined, ...Object.keys(CONVERSATION_TYPES)]) {
    const welcome = welcomeWorkflowOf(undefined, type);
    if (!welcome.declared) names.add(welcome.name);
    const opened = openedWorkflowOf(undefined, type);
    if (opened) names.add(opened.name);
    // A SUBJECT CHANGE RUNS THE PLATFORM'S `drift` wherever drift is on and the version declares none (WT88).
    const subject = subjectChangedWorkflowOf(undefined, type);
    if (!subject.declared && (!type || CONVERSATION_TYPES[type]?.driftEnabled !== false)) names.add(subject.name);
  }
  const joined = personJoinedWorkflowOf(undefined);
  if (!joined.declared) names.add(joined.name);
  for (const event of EVENT_WORKFLOW_EVENTS) {
    const declared = declaredWorkflowOn(undefined, event);
    if (declared) names.add(declared.name);
  }
  return names;
}

/** One workflow that runs in a kind of room: its name, what starts it, and whether it is the version's own. */
export interface RoomWorkflow { name: string; on: string; own: boolean }

/**
 * THE WORKFLOWS THAT RUN IN EACH KIND OF ROOM, for a version: every conversation type, with what runs there, chosen by the
 * runtime's own selection so the view cannot say other than what happens. A room's welcome, its opening, its subject
 * change and its arrivals are each the one the runtime picks for that type (the version's own, else the platform's where
 * one runs by default); every other event lists the version's workflows that name the type or name none. A workflow is
 * the assistant's, declared for the room types it runs in; this is that same set read from the room's side. With the
 * assistant's classification, only the types a conversation of that classification can be are listed.
 */
export function workflowsByRoomType(own: Readonly<Record<string, EventWorkflow>> | null | undefined, classification?: string | null): Array<{ type: string; workflows: RoomWorkflow[] }> {
  const mine = (own ?? {}) as Record<string, EventWorkflow>;
  const appliesTo = (wf: EventWorkflow, type: string) => !wf.types?.length || wf.types.includes(type);
  const reachable = (type: string) => {
    const allowed = CONVERSATION_TYPES[type]?.classifications;
    return !classification || !allowed?.length || allowed.includes(classification);
  };
  return Object.keys(CONVERSATION_TYPES).filter(reachable).map((type) => {
    const rows: RoomWorkflow[] = [];
    const add = (row: RoomWorkflow) => { if (!rows.some((r) => r.name === row.name)) rows.push(row); };
    const welcome = welcomeWorkflowOf(mine, type);
    add({ name: welcome.name, on: 'assistant-joined', own: welcome.declared });
    const opened = openedWorkflowOf(mine, type);
    if (opened) add({ name: opened.name, on: 'conversation-opened', own: true });
    const joined = personJoinedWorkflowOf(mine);
    add(joined.declared && appliesTo(joined.workflow, type)
      ? { name: joined.name, on: 'person-joined', own: true }
      : { name: 'join-recap', on: 'person-joined', own: false });
    if (CONVERSATION_TYPES[type]?.driftEnabled !== false) {
      const subject = subjectChangedWorkflowOf(mine, type);
      add({ name: subject.name, on: 'subject-changed', own: subject.declared });
    }
    const handled = new Set(['assistant-joined', 'conversation-opened', 'person-joined', 'subject-changed']);
    for (const [name, wf] of Object.entries(mine)) {
      if (wf && !handled.has(wf.on) && appliesTo(wf, type)) add({ name, on: wf.on, own: true });
    }
    return { type, workflows: rows };
  });
}

/** The name a copied workflow takes: its own, or the first `<name>-<n>` the version does not hold. */
export function copyName(own: Readonly<Workflows> | undefined, name: string): string {
  if (!own?.[name]) return name;
  for (let n = 2; ; n += 1) if (!own[`${name}-${n}`]) return `${name}-${n}`;
}

/** The version's workflow a copy of this platform workflow would conflict with (`conflictingWorkflow`), or undefined. */
export function platformCopyConflict(own: Readonly<Workflows> | null | undefined, name: string): string | undefined {
  const wf = SHIPPED_EVENT_WORKFLOWS[name];
  return wf ? conflictingWorkflow(own, wf) : undefined;
}

/**
 * The version's workflows with a platform workflow copied in under a free name, as `workflowsWith` copies one. With
 * `replace`, the version's workflow the copy would conflict with (`platformCopyConflict`) is removed first, so a copied
 * welcome takes the place of the version's untyped welcome rather than standing beside it as a second one.
 */
export function withPlatformCopy(own: Readonly<Workflows> | undefined, name: string, opts: { replace?: boolean } = {}): { name: string; workflows: Workflows; replaced?: string } {
  const conflict = opts.replace ? platformCopyConflict(own, name) : undefined;
  const kept: Workflows = { ...(own ?? {}) };
  if (conflict) delete kept[conflict];
  const at = copyName(kept, name);
  return { name: at, workflows: { ...kept, [at]: JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS[name])) as EventWorkflow }, ...(conflict ? { replaced: conflict } : {}) };
}

/** One intent as its card shows it. */
export interface IntentCard {
  key: string;
  /** What the intent is: the pack's `description`, which the classifier chooses by, else its `summary`. */
  purpose?: string;
  description?: string;
  instructions?: string;
  multiStep: boolean;
  machine?: string;
  /**
   * Whether the version's workflow selection lets this intent open its machine (`workflowSelected`). False means a turn
   * of it opens no workflow, as the router's selection gate decides. Present only with a machine.
   */
  machineSelected?: boolean;
  /** What a turn of the intent hands over (the pack's `needs`); `image` makes the card offer an image model. */
  needs?: string;
  /** The tools a turn of the intent is offered: the pack intent's `tools` within the version's allowlist (`toolsForIntent`). */
  tools?: string[];
  /** The route the version declares: its text model, image model and step overrides. Absent means no route of its own. */
  route?: IntentRoute;
}

/**
 * THE INTENTS THE VERSION SERVES, as the runtime resolves them: the version's own pack through `resolveStoredPack` (so an
 * `extends: 'default'` pack carries the platform intents it inherits, and a partial override keeps every field it does not
 * restate), each with the machine the classification's workflows hold by its key; else its classification's pack, as the
 * catalog serves it. Undefined when neither can be read.
 */
export function servedIntents(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined): CatalogIntent[] | undefined {
  const own = body?.intentPack;
  if (own?.intents) {
    // The machines the version runs: the classification's and the platform's, and the version's own pack's over them.
    const machines = Object.fromEntries([...(catalog?.workflows ?? []).map((w) => w.key), ...Object.keys((own as { machines?: object }).machines ?? {})].map((k) => [k, true]));
    return resolveStoredPack(own as unknown as StoredIntentPack).intents.map((i) => catalogIntentOf(i, machines));
  }
  return catalog?.intents;
}

/**
 * THE INTENTS THE VERSION'S PACK DECLARES: its own pack when it carries one, else its classification's. A route the
 * version holds for an intent no pack names is not one of them, so the Intent pack row never lists it.
 */
export function packIntentKeys(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined): string[] {
  return servedIntents(body, catalog)?.map((i) => i.key) ?? catalog?.packIntents ?? [];
}

/**
 * WHETHER THE VERSION'S WORKFLOW SELECTION LETS A TASK OF THIS MACHINE OPEN, as the router's gate decides (`mayOpen`): an
 * empty or absent selection opens every one, a platform machine the turn queue runs (`required`) is never removed, and
 * otherwise only a selected machine opens.
 */
export function workflowSelected(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined, machine: string): boolean {
  const selection = body?.workflows;
  if (!selection?.length) return true;
  if (catalog?.workflows?.find((w) => w.key === machine)?.required) return true;
  return selection.includes(machine);
}

/** The tools a turn of an intent is offered: the intent's own list within the version's allowlist, as `toolsForIntent` narrows it. */
function toolsOffered(own: string[] | undefined, allowed: string[] | undefined): string[] | undefined {
  if (!own) return undefined;
  return allowed ? own.filter((t) => allowed.includes(t)) : [...own];
}

/**
 * THE INTENTS A VERSION ANSWERS, as cards: the intents it serves (`servedIntents`), each with what its pack says of it,
 * whether its selection lets it open its machine, and the route the version declares. A route for an intent no pack names
 * (an image route) is listed too, so every model the version chooses is on a card.
 */
export function intentCards(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined): IntentCard[] {
  const served = new Map((servedIntents(body, catalog) ?? []).map((i) => [i.key, i]));
  const keys = packIntentKeys(body, catalog);
  const routes = body?.models?.byIntent ?? {};
  const all = [...keys, ...Object.keys(routes).filter((k) => !keys.includes(k))];
  return all.map((key) => {
    const c = served.get(key);
    const description = c?.description || undefined;
    const purpose = description ?? c?.summary;
    const tools = toolsOffered(c?.tools, body?.tools);
    const r = routes[key];
    return {
      key,
      ...(purpose ? { purpose } : {}),
      ...(description ? { description } : {}),
      ...(c?.instructions ? { instructions: c.instructions } : {}),
      multiStep: !!c?.multiStep,
      ...(c?.machine ? { machine: c.machine, machineSelected: workflowSelected(body, catalog, c.machine) } : {}),
      ...(c?.needs ? { needs: c.needs } : {}),
      ...(tools ? { tools } : {}),
      ...(r ? { route: r } : {}),
    };
  });
}

/** The intents the version serves that run a machine (whether or not its selection lets them open it). */
export function intentsRunning(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined, machine: string): string[] {
  return (servedIntents(body, catalog) ?? []).filter((i) => i.machine === machine).map((i) => i.key);
}

/**
 * THE PLATFORM INTENTS THIS VERSION REFUSES (`refusedPlatformIntents`, DESIGN-CAPABILITY-REFUSAL §3): every intent of the
 * platform taxonomy the pack it serves does not declare. With the model classifier, a turn classified as one is declined.
 * Empty when the served pack cannot be read, since nothing can then be said of it.
 */
export function refusedIntentKeys(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined): string[] {
  const served = servedIntents(body, catalog);
  return served ? refusedPlatformIntents({ intents: served }).map((d) => d.key) : [];
}

const concrete = (key: string | undefined): string | undefined => (key && key !== DEFAULT_MODEL ? key : undefined);

/** Whether a route names a text model of its own: a concrete primary that is not an image model (`buildIntentStrategy`). */
export function hasOwnTextModel(route: Partial<IntentRoute> | undefined): boolean {
  return !!concrete(route?.primary) && !isImageRoute(route);
}

/**
 * THE PLATFORM ROUTE THAT SERVES AN INTENT'S TEXT TURNS WHEN THE VERSION NAMES NO TEXT ROUTE AT ALL. The processor then
 * serves the platform routes on the version's base model (`platformRoutesServedOn`), so an intent with one of them is
 * answered on it, and one that answers through `general` on that route. Undefined while the version names any text route
 * of its own (its routes are then the whole strategy), or when no platform route serves the intent.
 */
export function platformRouteServing(
  body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined, key: string,
): { primary: string; fallback?: string; via: 'own' | 'general' } | undefined {
  if (Object.values(body?.models?.byIntent ?? {}).some((r) => hasOwnTextModel(r))) return undefined;
  const base = concrete(body?.models?.default) ?? concrete(body?.modelKey) ?? catalog?.models.default;
  const seeded = platformRoutesServedOn(base);
  if (seeded[key]) return { ...seeded[key], via: 'own' };
  return answersThroughGeneral(key) && seeded[GENERAL_ROUTE_KEY] ? { ...seeded[GENERAL_ROUTE_KEY], via: 'general' } : undefined;
}

/**
 * The image model an intent that needs an image takes when its route names none: the `image_generation` route's
 * (`resolveTurnImageRoute`, `imagePrimaryForIntent`). Undefined for `image_generation` itself, or when that route names none.
 */
export function inheritedImageModel(body: Partial<ProfileDefinitionBody> | null, key: string): string | undefined {
  return key === IMAGE_ROUTE_KEY ? undefined : imagePrimaryOf(body?.models as ImageRouteSource | undefined);
}

/**
 * One platform intent as the Platform intents group reads it: its own route, the platform's route (the version names no
 * text route, so the platform routes serve), the `general` route, or the base model.
 */
export interface PlatformIntentRow { key: string; answers: 'own' | 'platform' | 'general' | 'base' }

/**
 * THE PLATFORM INTENTS GROUP (ADR-064 decision 5): the universal intents and `platform_question`, read from the catalog
 * (which serves the resolver's own `ANSWERS_THROUGH_GENERAL`), each with where its turns are answered in this version. Only
 * a route naming a concrete text model is its own: a `default` or image-only route is left out of the strategy, and the
 * turn answers through `general` or on the base model as if it had none.
 */
export function platformIntentRows(body: Partial<ProfileDefinitionBody> | null, catalog: ClassificationCatalog | undefined): PlatformIntentRow[] {
  const routes = body?.models?.byIntent ?? {};
  return (catalog?.platformIntents ?? []).map((p) => {
    const served = platformRouteServing(body, catalog, p.key);
    const answers: PlatformIntentRow['answers'] = hasOwnTextModel(routes[p.key]) ? 'own'
      : served?.via === 'own' ? 'platform'
        : p.answersThroughGeneral ? 'general' : 'base';
    return { key: p.key, answers };
  });
}
