/**
 * AN EVENT WORKFLOW, READ (ADR-061): the event that starts it, the rooms it runs in, its steps in the order a run reaches
 * them, and, for a welcome, the opening a person reads.
 *
 * THE OPENING IS THE ROUTER'S OWN COMPOSITION. `welcomePlan` finds the welcome's opening step, `selectOpening` reads its
 * text and orientation fields, and `composeOpening` renders them, in the same pure modules the router posts a welcome
 * from (`backend/lambda/src/lib/event-workflow.ts`, `welcome-orientation.ts`). The console adds no copy of its own: a
 * field the room fills when the welcome is said (`{{eventSummary}}`, a version's variable) is shown as a marked sample
 * placeholder, never as invented content.
 */
import {
  welcomePlan, type EventEdge, type EventStepDef, type EventWorkflow,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import {
  WELCOME_FIELDS, composeOpening, selectOpening, welcomeTemplateFields, type WelcomeOrientation,
} from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import { kindOf, type Kind } from './workflowEdits';

/** One step as the summary reads it: its name, its kind, and the template, prompt, role or machine it names. */
export interface StepSummary {
  key: string;
  kind: Kind;
  /** The template, prompt or machine the step names. */
  names?: string;
  /** The participant role whose assistant takes an agent step. */
  as?: string;
  /** How a terminal step ends. */
  disposition?: 'success' | 'failure';
}

const targets = (edge: EventEdge | undefined): string[] => (edge === undefined ? [] : typeof edge === 'string' ? [edge] : edge.map((a) => a.to));

/**
 * THE STEPS IN THE ORDER A RUN REACHES THEM: from the first step, breadth first along each step's success, failure and
 * deadline edges (each conditioned edge's alternatives in order), with the ends after every other reached step, and any
 * step nothing reaches last.
 */
export function workflowSteps(wf: EventWorkflow): StepSummary[] {
  const states = wf.states ?? {};
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = states[wf.initial] ? [wf.initial] : [];
  if (queue.length) seen.add(wf.initial);
  while (queue.length) {
    const at = queue.shift()!;
    order.push(at);
    const def = states[at];
    for (const to of [...targets(def.onSuccess), ...targets(def.onFailure), ...targets(def.onDeadline)]) {
      if (states[to] && !seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  const reached = [...order.filter((k) => !states[k].disposition), ...order.filter((k) => states[k].disposition)];
  const unreached = Object.keys(states).filter((k) => !seen.has(k));
  return [...reached, ...unreached].map((key) => summarizeStep(key, states[key]));
}

function summarizeStep(key: string, def: EventStepDef): StepSummary {
  const kind = kindOf(def);
  const names = def.send?.template ?? def.agent?.prompt ?? def.prompt?.template ?? def.task?.machine;
  return {
    key,
    kind,
    ...(names ? { names } : {}),
    ...(def.agent?.as?.role ? { as: def.agent.as.role } : {}),
    ...(def.disposition ? { disposition: def.disposition } : {}),
  };
}

/**
 * WHAT A WELCOME SAYS, read from the one workflow: its opening step, its prompt turn, and whether its steps run. A
 * summary of one workflow reads it here, not through `welcomeFor`, which answers which welcome a kind of room selects.
 */
export function welcomeSays(wf: EventWorkflow): ReturnType<typeof welcomePlan> {
  return welcomePlan(wf);
}

/** The conversation fields a welcome's text may name, which the room fills when the welcome is said. */
const CONVERSATION_FIELD_NAMES = Object.keys(WELCOME_FIELDS).filter((f) => f !== 'role' && f !== 'examples');
/** `{{field}}` in a welcome's text: the grammar every template uses. */
const FIELD = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** A welcome's opening as the console previews it. */
export interface OpeningPreview {
  /**
   * `text`: the welcome's own text; `fields`: the built-in assembly over the orientation fields its opening sets;
   * `deployment`: an opening that sets nothing of its own, which the classification's primary says from the deployment's
   * orientation and any other assistant says as the built-in opening shown; `steps`: a welcome with no opening step, which
   * greets with the message templates its steps send.
   */
  source: 'text' | 'fields' | 'deployment' | 'steps';
  /** The opening, composed by the router's composer. */
  content: string;
  /** The fields filled with a sample placeholder, by name. */
  placeholders: string[];
  /** The prompt template whose turn follows the opening, when the welcome has one. */
  prompt?: string;
}

/**
 * THE OPENING A WELCOME SAYS, composed by `composeOpening`. Each field its text names that the room fills is given a
 * placeholder from `placeholder(name)`, so every line shows; the role is the assistant's own when it is known.
 */
export function previewOpening(
  wf: EventWorkflow,
  placeholder: (field: string) => string,
  role?: string,
): OpeningPreview {
  const plan = welcomeSays(wf);
  const prompt = plan.prompt?.template;
  const extra = prompt ? { prompt } : {};
  // A welcome with no opening step greets with the message templates its steps send, which its steps name.
  if (!plan.opening) return { source: 'steps', content: '', placeholders: [], ...extra };
  const own = selectOpening(plan.opening);
  if (!own) return { source: 'deployment', content: composeOpening(undefined, {}).content, placeholders: [], ...extra };
  if (!own.template) return { source: 'fields', content: composeOpening(undefined, own.orientation ?? {}).content, placeholders: [], ...extra };
  const placeholders: string[] = [];
  const conversation: WelcomeOrientation = {};
  // A field the room fills goes through the composer's own insertion; any other name (a version's variable, `room.*`)
  // is the value the router resolves when the welcome is said, so it is shown as its placeholder in place.
  const template = welcomeTemplateFields(own.template).replace(FIELD, (match, name: string) => {
    if (name === 'examples') return match;
    if (name === 'role' && role) return match;
    if (!placeholders.includes(name)) placeholders.push(name);
    if (CONVERSATION_FIELD_NAMES.includes(name)) {
      (conversation as Record<string, string>)[name] = placeholder(name);
      return match;
    }
    return placeholder(name);
  });
  const content = composeOpening(template, { ...(own.orientation ?? {}), ...conversation }, role ? { role } : {}).content;
  return { source: 'text', content, placeholders, ...extra };
}
