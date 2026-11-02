/**
 * THE WELCOME, EDITED AS THE WORKFLOW IT IS (W1).
 *
 * An assistant's welcome is its `assistant-joined` workflow, which `WelcomeIntent` starts, and the room's conversation
 * type selects it: the workflow whose `types` name the type, else the one that names none, else the platform's
 * `welcome` (`welcomeWorkflowOf`, `backend/lambda/src/lib/event-workflow.ts`, which the router selects with). Its opening
 * is a template step (`opening`), a prompt step may follow it (`prompt`), and a welcome may greet and then continue
 * with any other step. These helpers read and write the draft's `eventWorkflows` so the Welcome section edits the
 * opening and the prompt turn of the welcome for one kind of room, and every other step is edited under Event workflows.
 */
import { previewMessageTemplate, sampleValue } from './MessageTemplatesEditor';
import { parseTemplate } from '../../../../../../backend/lambda/src/lib/document-template.ts';
import {
  welcomePlan,
  welcomeWorkflowOf,
  type EventStepDef,
  type EventWorkflow,
  type PromptWelcomeStep,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import type { WelcomeOpeningStep } from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';

/** A template a step may name, with the source in use and the family it comes from. */
export interface WelcomePromptOption {
  name: string;
  kind?: 'message' | 'prompt';
  source: string;
  origin: 'assistant' | 'classification' | 'shipped';
}

/** The instructions the model is asked for one prompt source, with each declared field filled by a sample. */
export function promptPreview(source: string): string {
  try {
    const parsed = parseTemplate(source);
    const values = Object.fromEntries(Object.entries(parsed.fields ?? {}).map(([f, b]) => [f, sampleValue(f, String(b))]));
    const r = previewMessageTemplate(source, values);
    if ('error' in r) return r.error;
    return r.sections.prompt ?? r.sections.chat ?? Object.values(r.sections)[0] ?? '';
  } catch (err) {
    return (err as Error).message;
  }
}

export type Workflows = Record<string, EventWorkflow>;

/** The name of the version's own welcome for a kind of room ('' for every room no other welcome names), or undefined. */
export function welcomeNameFor(workflows: Workflows, type: string): string | undefined {
  const on = Object.entries(workflows).filter(([, wf]) => wf?.on === 'assistant-joined');
  const found = type ? on.find(([, wf]) => (wf.types ?? []).includes(type)) : on.find(([, wf]) => !wf.types?.length);
  return found?.[0];
}

/** The kinds of room the version has a welcome of its own for. */
export function welcomeTypes(workflows: Workflows): string[] {
  return [...new Set(Object.values(workflows).filter((wf) => wf?.on === 'assistant-joined').flatMap((wf) => wf.types ?? []))];
}

/** What the version's own welcome for a kind of room says: its opening, its prompt turn, and whether it runs. */
export function welcomeFor(workflows: Workflows, type: string): { name?: string; opening?: WelcomeOpeningStep; prompt?: PromptWelcomeStep; runs: boolean } {
  const name = welcomeNameFor(workflows, type);
  if (!name) return { runs: false };
  const plan = welcomePlan(workflows[name]);
  return { name, ...(plan.opening ? { opening: plan.opening } : {}), ...(plan.prompt ? { prompt: plan.prompt } : {}), runs: plan.runs };
}

/** The welcome that answers in a room of this type, as the router selects it: the version's own or the platform's. */
export const welcomeInRoom = (workflows: Workflows, type: string) => welcomeWorkflowOf(workflows, type || undefined);

const freeName = (workflows: Workflows, want: string): string => {
  let name = want;
  for (let n = 2; workflows[name]; n++) name = `${want}-${n}`;
  return name;
};
const freeStep = (states: Record<string, EventStepDef>, want: string): string => {
  let name = want;
  for (let n = 2; states[name]; n++) name = `${want}-${n}`;
  return name;
};

/** Whether a welcome says just what the platform's does: one opening with no field of its own, then the end. */
function isPlatformDefault(wf: EventWorkflow): boolean {
  const entries = Object.entries(wf.states);
  const opening = wf.states[wf.initial];
  return !wf.types?.length && entries.length === 2 && !!opening?.opening && !Object.keys(opening.opening).length
    && opening.when === undefined && entries.some(([, d]) => d.disposition);
}

/**
 * THE WORKFLOWS WITH ONE KIND OF ROOM'S WELCOME CHANGED: its opening, or its prompt turn (`null` removes it). A room
 * with no welcome of its own gets one: an opening followed by the end, naming the room's type. A welcome with no opening
 * step gets one, first, going where the run went before. The prompt turn follows the opening, and nothing follows it. A
 * welcome for every room that ends up saying just what the platform's says is removed.
 */
export function withWelcome(
  workflows: Workflows,
  type: string,
  change: { opening?: WelcomeOpeningStep; prompt?: PromptWelcomeStep | null },
): Workflows {
  const existing = welcomeNameFor(workflows, type);
  const name = existing ?? freeName(workflows, type ? `welcome-${type}` : 'welcome');
  const wf: EventWorkflow = existing ? JSON.parse(JSON.stringify(workflows[existing])) : {
    on: 'assistant-joined', ...(type ? { types: [type] } : {}), initial: 'opening',
    states: { opening: { opening: {}, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
  };
  let openingKey = Object.keys(wf.states).find((k) => wf.states[k].opening);
  if (!openingKey) {
    openingKey = freeStep(wf.states, 'opening');
    wf.states[openingKey] = { opening: {}, onSuccess: wf.initial, onFailure: wf.initial };
    wf.initial = openingKey;
  }
  const opening = wf.states[openingKey];
  if (change.opening !== undefined) opening.opening = change.opening;
  if (change.prompt !== undefined) {
    const after = [opening.onSuccess, opening.onFailure].find((e): e is string => typeof e === 'string' && !!wf.states[e]?.prompt);
    let end = Object.keys(wf.states).find((k) => wf.states[k].disposition);
    if (!end) { end = freeStep(wf.states, 'done'); wf.states[end] = { disposition: 'success' }; }
    if (change.prompt === null) {
      if (after) {
        delete wf.states[after];
        opening.onSuccess = end;
        opening.onFailure = end;
      }
    } else if (after) {
      wf.states[after] = { ...wf.states[after], prompt: change.prompt };
    } else {
      const key = freeStep(wf.states, 'prompt');
      wf.states[key] = { prompt: change.prompt, onSuccess: end, onFailure: end };
      opening.onSuccess = key;
      opening.onFailure = key;
    }
  }
  const next = { ...workflows, [name]: wf };
  if (isPlatformDefault(wf)) delete next[name];
  return next;
}
