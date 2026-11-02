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
    ...(link.tab === 'effectiveness' && link.version != null ? { version: String(link.version) } : {}),
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
