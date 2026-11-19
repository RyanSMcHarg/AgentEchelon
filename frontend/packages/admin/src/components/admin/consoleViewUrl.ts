/**
 * EVERY VIEW OF THE CONSOLE IS A URL.
 *
 * The tab is `?admin=<tab>`; where a view opens something inside a tab (an assistant and its section, a process and one of its
 * runs, an intent's drill level, an experiment's drill, a classifier run, a person's details, the drift view), that position
 * rides on its own key beside it, so a link opens exactly that view, can be sent to someone, and the browser's Back and Forward
 * step through it.
 *
 * What it guarantees:
 *  - ONE KEY PER POSITION, OWNED BY ONE TAB (`VIEW_KEYS_OF_TAB`), so leaving a tab drops what belongs only to it, and a key is
 *    never read by a tab it does not belong to.
 *  - A CHANGE A PERSON MAKES ADDS A HISTORY ENTRY; a change that only follows the address (Back, Forward) adds none, since the
 *    address already says it.
 *  - NOTHING SENSITIVE: a key holds a name, a short id, or a step, never a person's address or an account number.
 */
import { useEffect, useRef } from 'react';

/** The keys each tab's views ride on. A key a tab does not list is dropped when that tab is left. */
export const VIEW_KEYS_OF_TAB: Readonly<Record<string, readonly string[]>> = {
  profiles: ['assistant', 'section', 'workflow', 'task', 'step'],
  processes: ['process', 'processRun'],
  effectiveness: ['intent', 'step', 'delivery', 'taskId'],
  experiments: ['exp', 'expDrill'],
  classifier_gate: ['gateRun'],
  user_management: ['user'],
  conversations: ['conv', 'msg', 'at', 'convView', 'meeting', 'meetingDays'],
  meetings: ['meeting', 'meetingDays'],
};

/** Every key any tab's views ride on. */
export const ALL_VIEW_KEYS: readonly string[] = [...new Set(Object.values(VIEW_KEYS_OF_TAB).flat())];

/** The value one key holds in a URL's query, or null. */
export function viewParam(key: string, search: string = typeof window === 'undefined' ? '' : window.location.search): string | null {
  return new URLSearchParams(search).get(key) || null;
}

/** Whether a URL names a view inside a tab: any key that tab owns. */
export function holdsViewOf(tab: string | null, search: string = window.location.search): boolean {
  const q = new URLSearchParams(search);
  return (VIEW_KEYS_OF_TAB[tab ?? ''] ?? []).some((k) => q.has(k));
}

/** The query with every view key the tab does not own removed, everything else kept. */
export function withOnlyViewsOf(tab: string, search: string): string {
  const q = new URLSearchParams(search);
  const own = VIEW_KEYS_OF_TAB[tab] ?? [];
  for (const k of ALL_VIEW_KEYS) if (!own.includes(k)) q.delete(k);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * SET OR REMOVE VIEW KEYS IN THE ADDRESS. Writes nothing where the address already says it, so following the address never
 * adds an entry. `replace` corrects the current entry instead of adding one. Returns whether it wrote.
 */
export function setViewParams(changes: Record<string, string | null | undefined>, opts: { replace?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  let changed = false;
  for (const [k, v] of Object.entries(changes)) {
    const now = url.searchParams.get(k);
    if (v) { if (now !== v) { url.searchParams.set(k, v); changed = true; } } else if (now !== null) { url.searchParams.delete(k); changed = true; }
  }
  if (!changed) return false;
  try {
    if (opts.replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
  } catch { /* the view stands; only the address does not follow it */ }
  return true;
}

/**
 * A VIEW'S POSITION, KEPT IN THE ADDRESS: each change of `values` is written as one history entry (or a corrected one with
 * `replace`), however many of its keys changed, and Back or Forward hands the address's values to `apply`. The view starts
 * from `viewParam(key)` for each key, so a link opens it there.
 */
export function useUrlViews(values: Record<string, string | null | undefined>, apply: (values: Record<string, string | null>) => void, opts: { replace?: boolean } = {}): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const keys = Object.keys(values).sort();
  const said = JSON.stringify(keys.map((k) => [k, values[k] ?? null]));
  useEffect(() => {
    setViewParams(Object.fromEntries(JSON.parse(said) as Array<[string, string | null]>), { replace: opts.replace });
  }, [said, opts.replace]);
  const keyList = keys.join('|');
  useEffect(() => {
    const onPop = () => applyRef.current(Object.fromEntries(keyList.split('|').map((k) => [k, viewParam(k)])));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [keyList]);
}

/** One key's position, kept in the address (`useUrlViews` with one key). */
export function useUrlView(key: string, value: string | null, apply: (value: string | null) => void, opts: { replace?: boolean } = {}): void {
  useUrlViews({ [key]: value }, (v) => apply(v[key] ?? null), opts);
}

/** Effectiveness's drill, as its levels are: every intent, one intent (and a step), its direct or task replies, one task. */
export type EffectivenessDrillView =
  | { level: 0 }
  | { level: 1; intent: string; step?: string }
  | { level: 2; intent: string; delivery: 'direct' | 'task' }
  | { level: 3; intent: string; taskId: string };

/** The address keys a drill level rides on. */
export function effectivenessDrillParams(d: EffectivenessDrillView): Record<string, string | null> {
  const none = { intent: null, step: null, delivery: null, taskId: null };
  if (d.level === 1) return { ...none, intent: d.intent, step: d.step ?? null };
  if (d.level === 2) return { ...none, intent: d.intent, delivery: d.delivery };
  if (d.level === 3) return { ...none, intent: d.intent, delivery: 'task', taskId: d.taskId };
  return none;
}

/** The drill level an address names: the deepest one its keys hold together, else every intent. */
export function effectivenessDrillFromUrl(search: string = typeof window === 'undefined' ? '' : window.location.search): EffectivenessDrillView {
  const q = new URLSearchParams(search);
  const intent = q.get('intent');
  if (!intent) return { level: 0 };
  const taskId = q.get('taskId');
  const delivery = q.get('delivery');
  if (taskId) return { level: 3, intent, taskId };
  if (delivery === 'direct' || delivery === 'task') return { level: 2, intent, delivery };
  const step = q.get('step');
  return { level: 1, intent, ...(step ? { step } : {}) };
}
