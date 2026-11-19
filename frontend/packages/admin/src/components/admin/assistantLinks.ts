/**
 * AN ASSISTANT PAGE'S PERFORMANCE LINKS, AS URLS THE CONSOLE OPENS ON.
 *
 * The assistant page links to Effectiveness (for one version, or one intent) and to Conversations, each narrowed to the
 * assistant. A link is a real URL, so it can be opened in a new tab or sent to someone: the tab is `?admin=`, the
 * assistant and version are the Performance filter set's own keys (`as`, `ver`, read by `filtersFromUrl`), and an intent
 * is `intent`, which opens Effectiveness on that intent, and `step` beside it narrows that intent's step and model breakdown. The console reads all of them on load, and the page's own click
 * applies the same values without a reload.
 */
import { EMPTY_FILTERS, filtersToSearch, type PerformanceFilters } from './PerformanceFilters';

export interface AssistantLink {
  tab: 'effectiveness' | 'conversations';
  /** The assistant's identifier (its profile name). */
  assistant: string;
  /** Effectiveness only: the version the turns were served by. */
  version?: number | string | null;
  /** Effectiveness only: the intent whose detail opens. */
  intent?: string | null;
  /** Effectiveness only, with an intent: the workflow step its step and model breakdown is narrowed to (ADR-064). */
  step?: string | null;
}

/** The URL key the intent rides on. */
export const INTENT_PARAM = 'intent';
/** The URL key the step rides on, beside the intent. */
export const STEP_PARAM = 'step';

/** The filters a link narrows the Performance filter set to: the assistant, and the version when it names one. */
export function linkFilters(link: AssistantLink): PerformanceFilters {
  return {
    ...EMPTY_FILTERS,
    assistant: link.assistant,
    ...(link.tab === 'effectiveness' && link.version != null ? { version: [String(link.version)] } : {}),
  };
}

/** The query string a link opens: the tab, the filter keys, and the intent. Nothing else the URL carried is kept. */
export function linkSearch(link: AssistantLink): string {
  const q = new URLSearchParams(filtersToSearch(linkFilters(link), `?admin=${link.tab}`));
  if (link.tab === 'effectiveness' && link.intent) {
    q.set(INTENT_PARAM, link.intent);
    if (link.step) q.set(STEP_PARAM, link.step);
  }
  return `?${q.toString()}`;
}

/** The intent a URL opens Effectiveness on, or null. */
export function intentFromUrl(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get(INTENT_PARAM) || null;
}

/** The step a URL narrows the intent's breakdown to, or null; a step without an intent narrows nothing. */
export function stepFromUrl(search: string = window.location.search): string | null {
  const q = new URLSearchParams(search);
  return (q.get(INTENT_PARAM) && q.get(STEP_PARAM)) || null;
}

/** The URL with the intent (and its step) set or removed, everything else kept. A removed intent takes its step with it. */
export function withIntentParam(intent: string | null, search: string = window.location.search, step: string | null = null): string {
  const q = new URLSearchParams(search);
  if (intent) q.set(INTENT_PARAM, intent); else q.delete(INTENT_PARAM);
  if (intent && step) q.set(STEP_PARAM, step); else q.delete(STEP_PARAM);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * ONE WORKFLOW, OPENED IN ITS ASSISTANT'S WORKFLOW EDITOR, AS A URL THE CONSOLE OPENS ON.
 *
 * `?admin=profiles&assistant=<assistant>` opens the assistant's page, and `&workflow=<name>` or `&task=<machine>` beside it
 * opens its Workflows section on that workflow. A `workflow` is a name a run records: an event workflow's name, or an
 * intent's key for the intent's workflow; the page reads it as the event workflow the version or the platform names so,
 * and otherwise as the intent. With `&step=<state>` beside it, `workflow` is an intent's key, and the page opens the task
 * machine that intent runs, resolved as the runtime resolves it, with that step selected. A `task` is a task machine's
 * key, which opens that machine's steps. The page opens the
 * draft's editor where there is a draft and the person may edit it, and the active version's read-only view otherwise.
 */
export interface WorkflowEditorLink {
  /** The assistant's identifier (its profile name). */
  assistant: string;
  /** An event workflow's name, or an intent's key. */
  workflow?: string | null;
  /** A task machine's key. */
  task?: string | null;
  /** With `workflow` as an intent's key: the step of the intent's task machine to select. */
  step?: string | null;
}

/** The URL keys the editor link rides on. */
export const ASSISTANT_PARAM = 'assistant';
export const WORKFLOW_PARAM = 'workflow';
export const TASK_PARAM = 'task';
const EDITOR_PARAMS = [ASSISTANT_PARAM, WORKFLOW_PARAM, TASK_PARAM];

/** The query string that opens the editor on one workflow. Nothing else the URL carried is kept. */
export function workflowEditorSearch(link: WorkflowEditorLink): string {
  const q = new URLSearchParams({ admin: 'profiles', [ASSISTANT_PARAM]: link.assistant });
  if (link.task) q.set(TASK_PARAM, link.task);
  else if (link.workflow) {
    q.set(WORKFLOW_PARAM, link.workflow);
    if (link.step) q.set(STEP_PARAM, link.step);
  }
  return `?${q.toString()}`;
}

/** The editor link a URL opens on, or null when it names no assistant. */
export function workflowEditorFromUrl(search: string = window.location.search): WorkflowEditorLink | null {
  const q = new URLSearchParams(search);
  const assistant = q.get(ASSISTANT_PARAM);
  if (!assistant) return null;
  const task = q.get(TASK_PARAM);
  const workflow = q.get(WORKFLOW_PARAM);
  const step = workflow && !task ? q.get(STEP_PARAM) : null;
  return { assistant, ...(task ? { task } : workflow ? { workflow } : {}), ...(step ? { step } : {}) };
}

/** The URL with the editor link's keys removed, everything else kept. Its `step` rides with its `workflow`; Effectiveness's rides with an `intent` and stays. */
export function withoutWorkflowEditorParams(search: string = window.location.search): string {
  const q = new URLSearchParams(search);
  if (q.has(WORKFLOW_PARAM) && !q.has(INTENT_PARAM)) q.delete(STEP_PARAM);
  for (const key of EDITOR_PARAMS) q.delete(key);
  const s = q.toString();
  return s ? `?${s}` : '';
}
