/**
 * A VERSION'S RETIRED `welcome` BECOMES ITS WELCOME WORKFLOWS (W1, `npm run migrate-legacy-welcome`).
 *
 * Before W1 a version carried a `welcome` object beside its event workflows: orientation fields and an opening text,
 * a mode (`structured`, `prompt` or `workflow`) naming how it greets, and per-conversation-type variants that inherited
 * the version's own fields. The welcome is now one special workflow that `WelcomeIntent` starts: the version's
 * `assistant-joined` workflow, selected by the room's conversation type (`welcomeWorkflowOf`), whose opening is a
 * template step (`opening`), a prompt step after it (`prompt`), or steps that greet and then continue. A room an event
 * opens runs the `conversation-opened` workflow whose `types` name it (`openedWorkflowOf`).
 *
 * This module reads the retired shape and nothing else does. `legacyWelcomePlan` is pure: for each kind of room the
 * welcome answered differently in, it writes the workflow that answers the same way.
 *
 *  - a `structured` context becomes a workflow with one opening step carrying its fields, its `template` as `text`;
 *  - a `prompt` context becomes that opening followed by a prompt step naming its template and tools;
 *  - a `workflow` context selects the workflow it names, the version's own or a copy of the platform's, with the
 *    context's type added to its `types` (a variant), and a type a variant takes is removed from every other one;
 *  - the version's own context has no type, so it answers for every room no variant names, and a context that says
 *    exactly what the platform's `welcome` says is not written at all.
 *
 * What a context said that its new workflow cannot say is reported, never dropped silently: the orientation fields beside
 * a workflow welcome, which were read only to open a drift-spawned room, and a name the version does not declare.
 *
 * The version is immutable history, so the script writes a new version through the profile API: a draft cloned from the
 * active version, `welcome: null` and the planned `eventWorkflows` patched onto it, validated and activated. The
 * equivalence test (`a-welcome-is-a-workflow-word-for-word.test.ts`) holds every planned welcome to what the retired one
 * said, word for word.
 */
import type { WelcomeOrientation, WelcomeOpeningStep } from './welcome-orientation.js';
import { CONVERSATION_FIELDS, DEPLOYMENT_FIELDS } from './welcome-orientation.js';
import {
  MAX_VERSION_EVENT_WORKFLOWS, WELCOME_EVENT, workflowFor,
  type EventStepDef, type EventWorkflow,
} from './event-workflow.js';

/** The retired shape a stored version may still carry under `welcome`. Read here alone. */
export interface LegacyWelcome extends WelcomeOrientation {
  template?: string;
  byConversationType?: Record<string, LegacyWelcome>;
  mode?: 'structured' | 'prompt' | 'workflow' | string;
  workflow?: string;
  prompt?: string;
  tools?: string[];
}

/** The keys of the retired shape that say how it greets, rather than what it says. */
const LEGACY_SHAPE_KEYS = ['template', 'byConversationType', 'mode', 'prompt', 'tools', 'workflow'];

/** How the retired welcome greeted in one kind of room. */
export interface LegacyContext {
  /** `structured`, `prompt` or `workflow`, as the retired resolver read it. */
  mode: 'structured' | 'prompt' | 'workflow';
  prompt?: string;
  tools?: string[];
  workflow?: string;
  /** The opening step that says what the retired welcome said in this room, or null for the deployment's orientation. */
  opening: WelcomeOpeningStep | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * WHAT THE RETIRED WELCOME DID IN A ROOM OF THIS TYPE, by the rules its resolvers applied: the room type's variant
 * merged over the version's own fields (most specific wins), a variant with no `mode` inheriting the version's, a mode
 * missing what it runs greeting as `structured`, and a welcome written only as other types' variants saying nothing of
 * its own here.
 */
export function legacyContext(welcome: LegacyWelcome | null | undefined, conversationType: string | undefined): LegacyContext {
  const variant = conversationType && isObject(welcome?.byConversationType) ? welcome!.byConversationType![conversationType] : undefined;
  const modeRaw = variant?.mode ?? welcome?.mode ?? 'structured';
  let mode: LegacyContext['mode'] = 'structured';
  let prompt: string | undefined;
  let tools: string[] | undefined;
  let workflow: string | undefined;
  if (modeRaw === 'workflow') {
    workflow = variant?.workflow ?? welcome?.workflow;
    if (workflow) mode = 'workflow';
  } else if (modeRaw === 'prompt') {
    prompt = variant?.prompt ?? welcome?.prompt;
    if (prompt) { mode = 'prompt'; tools = variant?.tools ?? welcome?.tools ?? []; }
  }
  // The fields that applied in this room: the variant over the version's own, else the version's own when it has any.
  let merged: LegacyWelcome | null = null;
  if (welcome) {
    const { byConversationType: _v, ...own } = welcome;
    if (variant) {
      const { byConversationType: _n, ...variantOwn } = variant;
      merged = { ...own, ...variantOwn };
    } else if (Object.keys(own).length) merged = own;
  }
  let opening: WelcomeOpeningStep | null = null;
  if (merged) {
    const step: Record<string, unknown> = {};
    if (typeof merged.template === 'string' && merged.template.trim()) step.text = merged.template;
    for (const [k, v] of Object.entries(merged)) if (!LEGACY_SHAPE_KEYS.includes(k)) step[k] = v;
    opening = step as WelcomeOpeningStep;
  }
  return { mode, ...(prompt ? { prompt } : {}), ...(tools ? { tools } : {}), ...(workflow ? { workflow } : {}), opening };
}

/** A line the migration could not carry, and why. */
export interface RefusedWelcome {
  at: string;
  reason: string;
}

export interface LegacyWelcomePlan {
  /** The version's `eventWorkflows` once its welcome is carried into them. */
  eventWorkflows: Record<string, EventWorkflow>;
  /** Each workflow the welcome was carried into, with the kinds of room it answers for (none: every other room). */
  workflows: Array<{ name: string; from: string; types?: string[] }>;
  refused: RefusedWelcome[];
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether a context says just what the platform's `welcome` says: a structured opening with nothing of its own. */
function isPlatformDefault(c: LegacyContext): boolean {
  return c.mode === 'structured' && Object.keys(openingStepOf(c.opening)).length === 0;
}

/**
 * The opening step with only what the retired welcome's parser kept: a field that is non-blank text, the examples that
 * are non-blank text (at most four, as the parser renders), and no per-conversation field. The parser dropped the rest
 * on every read, so the step says the same and passes the step's own shape check.
 */
function openingStepOf(o: WelcomeOpeningStep | null): WelcomeOpeningStep {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    if ((CONVERSATION_FIELDS as readonly string[]).includes(k)) continue;
    if (k !== 'text' && !(DEPLOYMENT_FIELDS as readonly string[]).includes(k)) continue;
    if (k === 'examples') {
      const kept = Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string' && !!e.trim()).map((e) => e.trim()).slice(0, 4) : [];
      if (kept.length) out.examples = kept;
      continue;
    }
    if (typeof v !== 'string' || !v.trim()) continue;
    out[k] = k === 'text' ? v : v.trim();
  }
  return out as WelcomeOpeningStep;
}

/** A structured or prompt context as a welcome workflow. */
function saidWorkflow(c: LegacyContext, types: string[] | undefined): EventWorkflow {
  const states: Record<string, EventStepDef> = {};
  states.opening = { opening: openingStepOf(c.opening), onSuccess: c.mode === 'prompt' ? 'prompt' : 'done', onFailure: c.mode === 'prompt' ? 'prompt' : 'done' };
  if (c.mode === 'prompt') states.prompt = { prompt: { template: c.prompt!, ...(c.tools?.length ? { tools: [...c.tools] } : {}) }, onSuccess: 'done', onFailure: 'done' };
  states.done = { disposition: 'success' };
  return { on: WELCOME_EVENT, ...(types ? { types } : {}), initial: 'opening', states };
}

/**
 * THE WORKFLOWS A RETIRED `welcome` BECOMES, with the version's own `eventWorkflows`. Pure: no store is read. See the
 * module header for the rules.
 */
export function legacyWelcomePlan(welcome: unknown, own: Record<string, EventWorkflow> | null | undefined): LegacyWelcomePlan {
  const eventWorkflows: Record<string, EventWorkflow> = JSON.parse(JSON.stringify(own ?? {}));
  const workflows: LegacyWelcomePlan['workflows'] = [];
  const refused: RefusedWelcome[] = [];
  if (welcome === undefined || welcome === null) return { eventWorkflows, workflows, refused };
  if (!isObject(welcome)) return { eventWorkflows, workflows, refused: [{ at: 'welcome', reason: 'not an object; nothing to carry' }] };
  const w = welcome as LegacyWelcome;
  const types = Object.keys(isObject(w.byConversationType) ? w.byConversationType : {});
  const base = legacyContext(w, undefined);
  const contexts: Array<{ at: string; type?: string; c: LegacyContext }> = [{ at: 'welcome', c: base }];
  for (const t of types) {
    const c = legacyContext(w, t);
    // A variant that greets exactly as the version's own context does needs no workflow of its own.
    if (!sameJson(c, base)) contexts.push({ at: `welcome.byConversationType.${t}`, type: t, c });
  }

  const usedNames = new Set(Object.keys(eventWorkflows));
  const freeName = (want: string) => {
    let name = want.slice(0, 63);
    for (let n = 2; usedNames.has(name); n++) name = `${want.slice(0, 60)}-${n}`;
    usedNames.add(name);
    return name;
  };
  /** The types each named workflow answers for, by the contexts that named it (`untyped`: the version's own context). */
  const named = new Map<string, { untyped: boolean; types: Set<string>; from: string }>();
  /** The types a variant takes, which no other workflow on its event keeps. */
  const takenTypes = new Map<string, string>();

  for (const { at, type, c } of contexts) {
    if (c.mode === 'workflow') {
      const name = c.workflow!;
      const wf = workflowFor(own, name);
      if (!wf) {
        refused.push({ at: `${at}.workflow`, reason: `names "${name}", which the version does not declare and the platform does not ship; the room greets with its opening instead` });
        if (!isPlatformDefault({ ...c, mode: 'structured' })) {
          const wfName = freeName(type ? `welcome-${type}` : 'welcome');
          eventWorkflows[wfName] = saidWorkflow({ ...c, mode: 'structured' }, type ? [type] : undefined);
          workflows.push({ name: wfName, from: at, ...(type ? { types: [type] } : {}) });
          if (type) takenTypes.set(type, wfName);
        }
        continue;
      }
      if (wf.on !== WELCOME_EVENT && wf.on !== 'conversation-opened') {
        refused.push({ at: `${at}.workflow`, reason: `names "${name}", which runs on ${wf.on}; its event selects it, so it stays as declared` });
        continue;
      }
      if (wf.on === 'conversation-opened' && !type) {
        refused.push({ at: `${at}.workflow`, reason: `names "${name}", which runs on conversation-opened; only a type an event opens selects it, so it stays as declared` });
        continue;
      }
      // A platform workflow is copied in under its own name, since the version now declares every workflow it runs.
      if (!Object.prototype.hasOwnProperty.call(eventWorkflows, name)) {
        eventWorkflows[name] = JSON.parse(JSON.stringify(wf));
        usedNames.add(name);
      }
      const entry = named.get(name) ?? { untyped: false, types: new Set<string>(), from: at };
      if (type) { entry.types.add(type); takenTypes.set(type, name); } else entry.untyped = true;
      named.set(name, entry);
      // THE FIELDS BESIDE A WORKFLOW WELCOME were read only to open a drift-spawned room. Its opening step, where the
      // workflow has one, opens such a room now; otherwise the deployment's orientation does.
      const hasOpening = Object.values(eventWorkflows[name].states).some((d) => d.opening);
      if (!hasOpening && c.opening && Object.keys(openingStepOf(c.opening)).length) {
        refused.push({
          at,
          reason: `carries ${Object.keys(openingStepOf(c.opening)).join(', ')} beside workflow "${name}", which has no opening step; `
            + 'they opened only a drift-spawned room, which the deployment\'s orientation opens now',
        });
      }
      continue;
    }
    if (!type && isPlatformDefault(c)) continue;
    const wfName = freeName(type ? `welcome-${type}` : 'welcome');
    eventWorkflows[wfName] = saidWorkflow(c, type ? [type] : undefined);
    workflows.push({ name: wfName, from: at, ...(type ? { types: [type] } : {}) });
    if (type) takenTypes.set(type, wfName);
  }

  // EACH NAMED WORKFLOW ANSWERS FOR THE ROOMS ITS CONTEXTS NAMED. The version's own context keeps the workflow's declared
  // types (none: every other room); a variant adds its type. A type a variant takes is removed from every other workflow on
  // that event, as the variant answered there before.
  for (const [name, entry] of named) {
    const wf = eventWorkflows[name];
    const declared = wf.types?.length ? [...wf.types] : undefined;
    let next: string[] | undefined;
    if (wf.on === 'conversation-opened') next = [...new Set([...(declared ?? []), ...entry.types])];
    else if (entry.untyped) next = declared;
    else next = [...new Set([...(declared ?? []).filter((t) => entry.types.has(t)), ...entry.types])];
    eventWorkflows[name] = { ...wf, ...(next?.length ? { types: next } : {}) };
    if (!next?.length) delete (eventWorkflows[name] as { types?: string[] }).types;
    workflows.push({ name, from: entry.from, ...(next?.length ? { types: next } : {}) });
  }
  for (const [name, wf] of Object.entries(eventWorkflows)) {
    if (wf.on !== WELCOME_EVENT || !wf.types?.length) continue;
    const kept = wf.types.filter((t) => !takenTypes.has(t) || takenTypes.get(t) === name);
    if (kept.length === wf.types.length) continue;
    if (!kept.length) {
      delete eventWorkflows[name];
      refused.push({ at: `eventWorkflows.${name}`, reason: `ran only in ${wf.types.join(', ')}, where a variant greeted instead; it never ran, so it is not carried` });
      const i = workflows.findIndex((x) => x.name === name);
      if (i >= 0) workflows.splice(i, 1);
    } else {
      eventWorkflows[name] = { ...wf, types: kept };
      const listed = workflows.find((x) => x.name === name);
      if (listed) listed.types = kept;
    }
  }
  if (Object.keys(eventWorkflows).length > MAX_VERSION_EVENT_WORKFLOWS) {
    refused.push({ at: 'eventWorkflows', reason: `the welcome needs ${Object.keys(eventWorkflows).length} workflows, and a version holds at most ${MAX_VERSION_EVENT_WORKFLOWS}; the version is left as it is` });
  }
  return { eventWorkflows, workflows, refused };
}
