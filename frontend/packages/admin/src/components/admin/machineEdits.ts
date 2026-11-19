/**
 * THE EDITS THE BUILDER'S TASK-MACHINE MODE MAKES TO AN INTENT'S MACHINE (ADR-066 build step 3, ADR-067 stage 1).
 *
 * A machine is `{ initial, states }` (`TaskStateMachine`), and every change here returns a new machine; nothing mutates.
 * The fields the inspector offers are the ones `TaskStateDef` declares and the runtime runs (SPEC-ADMIN-CONSOLE FR60),
 * and the rules are the runtime's own: `validateTaskStateMachine` is what a deployed machine is held to, so the status
 * line here says what the draft's Validate will say. A machine may loop (a revision returns to an earlier step), which
 * is why these edits never refuse a cycle, unlike an event workflow's.
 *
 * Every reference a state holds to another (its transitions, its card's choices, the requester's moves, a terminal's reopens, an action's
 * outcome edges) is kept in step when a state is renamed or removed, so an edit never leaves a dangling name.
 */
import {
  validateTaskStateMachine, type TaskStateDef, type TaskStateMachine,
} from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';

const KEY_RE = /^[a-z][a-z0-9_]*$/;

/** Whether a name may be a state's key: lower case, a letter first, then letters, digits or underscores. */
export const isStateKey = (key: string): boolean => KEY_RE.test(key);

/** The machine's states in a stable order: the initial state first, then as declared. */
export function orderedStates(m: TaskStateMachine): string[] {
  const keys = Object.keys(m.states);
  return m.states[m.initial] ? [m.initial, ...keys.filter((k) => k !== m.initial)] : keys;
}

/** A fresh key that no state holds: `step`, `step_2`, ... */
function freshKey(m: TaskStateMachine, base = 'step'): string {
  if (!m.states[base]) return base;
  for (let i = 2; ; i++) if (!m.states[`${base}_${i}`]) return `${base}_${i}`;
}

/**
 * Add a state. After `after`, the new state becomes one of its transitions; the new state itself ends the task with a
 * success, so the machine stays valid until the person connects it on.
 */
export function addState(m: TaskStateMachine, opts: { after?: string } = {}): { machine: TaskStateMachine; key: string } {
  const key = freshKey(m);
  const states: Record<string, TaskStateDef> = { ...m.states, [key]: { transitions: [], terminal: 'success' } };
  if (opts.after && states[opts.after]) {
    const from = states[opts.after];
    states[opts.after] = withoutTerminal({ ...from, transitions: [...new Set([...from.transitions, key])] });
  }
  return { machine: { ...m, states }, key };
}

/** A state that now leaves somewhere is no longer an ending: its disposition and reopens go. */
function withoutTerminal(def: TaskStateDef): TaskStateDef {
  if (!def.transitions.length) return def;
  const { terminal: _t, reopens: _r, ...rest } = def;
  return rest;
}

/** Drop a name from every list and edge a state holds. */
function forget(def: TaskStateDef, gone: string): TaskStateDef {
  const next: TaskStateDef = { ...def, transitions: def.transitions.filter((t) => t !== gone) };
  if (def.choices) next.choices = def.choices.filter((c) => c !== gone);
  if (def.requesterMoves) next.requesterMoves = def.requesterMoves.filter((c) => c !== gone);
  if (def.reopens) next.reopens = def.reopens.filter((r) => r !== gone);
  if (next.choices && !next.choices.length) delete next.choices;
  if (next.requesterMoves && !next.requesterMoves.length) delete next.requesterMoves;
  if (next.reopens && !next.reopens.length) delete next.reopens;
  if (def.onSuccess === gone) delete next.onSuccess;
  if (def.onFailure === gone) delete next.onFailure;
  if (def.auto === gone) delete next.auto;
  return next;
}

/**
 * Remove a state and every reference to it. Removing the initial state starts the machine at the next state. A state
 * whose only way on was the removed one is now an ending, and becomes a success, as `disconnectStates` makes it.
 */
export function removeState(m: TaskStateMachine, key: string): TaskStateMachine {
  if (!m.states[key]) return m;
  const states: Record<string, TaskStateDef> = {};
  for (const [k, def] of Object.entries(m.states)) {
    if (k === key) continue;
    const next = forget(def, key);
    if (!next.transitions.length && !next.terminal) next.terminal = 'success';
    states[k] = next;
  }
  const initial = m.initial === key ? (Object.keys(states)[0] ?? '') : m.initial;
  return { initial, states };
}

/** Rename a state everywhere it is named. Refused (null) for a key that is taken or not a valid name. */
export function renameState(m: TaskStateMachine, from: string, to: string): TaskStateMachine | null {
  if (from === to) return m;
  if (!m.states[from] || m.states[to] || !isStateKey(to)) return null;
  const swap = (s: string) => (s === from ? to : s);
  const states: Record<string, TaskStateDef> = {};
  for (const [k, def] of Object.entries(m.states)) {
    const next: TaskStateDef = { ...def, transitions: def.transitions.map(swap) };
    if (def.choices) next.choices = def.choices.map(swap);
    if (def.requesterMoves) next.requesterMoves = def.requesterMoves.map(swap);
    if (def.reopens) next.reopens = def.reopens.map(swap);
    if (def.onSuccess) next.onSuccess = swap(def.onSuccess);
    if (def.onFailure) next.onFailure = swap(def.onFailure);
    if (def.auto) next.auto = swap(def.auto);
    states[swap(k)] = next;
  }
  return { initial: swap(m.initial), states };
}

/** Add a transition `from -> to`. A loop back to an earlier state is allowed: a machine may revise. */
export function connectStates(m: TaskStateMachine, from: string, to: string): TaskStateMachine {
  const def = m.states[from];
  if (!def || !m.states[to] || def.transitions.includes(to)) return m;
  return { ...m, states: { ...m.states, [from]: withoutTerminal({ ...def, transitions: [...def.transitions, to] }) } };
}

/**
 * Remove a transition `from -> to`, and the choice or action edge that named it. A state left with no transition is
 * an ending, and becomes a success unless it already said otherwise.
 */
export function disconnectStates(m: TaskStateMachine, from: string, to: string): TaskStateMachine {
  const def = m.states[from];
  if (!def || !def.transitions.includes(to)) return m;
  const next = forget(def, to);
  if (!next.transitions.length && !next.terminal) next.terminal = 'success';
  return { ...m, states: { ...m.states, [from]: next } };
}

/** Start the machine at another state. */
export const startAtState = (m: TaskStateMachine, key: string): TaskStateMachine => (m.states[key] ? { ...m, initial: key } : m);

/** Replace one state's fields, keeping its transitions as they are drawn. */
export function updateState(m: TaskStateMachine, key: string, def: TaskStateDef): TaskStateMachine {
  if (!m.states[key]) return m;
  return { ...m, states: { ...m.states, [key]: def } };
}

/** Set or clear one optional field of a state: an empty list, an empty string or `false` removes it. */
export function withField<K extends keyof TaskStateDef>(def: TaskStateDef, field: K, value: TaskStateDef[K] | undefined): TaskStateDef {
  const next = { ...def };
  const empty = value === undefined || value === false || value === ''
    || (Array.isArray(value) && value.length === 0);
  if (empty) delete next[field];
  else next[field] = value as TaskStateDef[K];
  return next;
}

/**
 * THE RUNTIME'S VERDICT ON THE MACHINE, as the status line shows it: [] when `validateTaskStateMachine` accepts it, else
 * its one reason (it stops at the first problem, as a deployed machine's hydrate does).
 */
export function machineErrors(name: string, m: TaskStateMachine): string[] {
  try {
    validateTaskStateMachine(name, m);
    return [];
  } catch (err) {
    return [(err as Error).message];
  }
}

/**
 * THE ERRORS THAT BELONG TO THIS MACHINE, from the runtime's check and the draft's last Validate: an error naming one of
 * its states (`states['<s>']` on the server, `state "<s>"` in the runtime's own message) belongs to that state, any other
 * naming the machine belongs to the machine, and one naming neither is not this machine's.
 */
export function anchoredMachineErrors(errors: readonly string[], key: string, m: TaskStateMachine): { states: Record<string, string[]>; machine: string[] } {
  const states: Record<string, string[]> = {};
  const machine: string[] = [];
  const named = (e: string) => e.includes(`machines['${key}']`) || e.includes(`machines.${key}`) || e.includes(`"${key}"`);
  for (const e of errors) {
    if (!named(e)) continue;
    const m1 = /states\['([^']+)'\]/.exec(e) ?? /state "([^"]+)"/.exec(e);
    if (m1 && m.states[m1[1]]) (states[m1[1]] ??= []).push(e);
    else machine.push(e);
  }
  return { states, machine };
}

/**
 * THE INTENT PACK WITH ONE MACHINE REPLACED, as the draft is patched: every other field of the pack kept as it is.
 *
 * A version's `intentPack` replaces its classification's whole, so a draft that carries no pack of its own starts from
 * the one it serves: the classification's stored pack when it sets one (`classificationPack`), else the platform's,
 * inherited with `extends: 'default'` and no intent of its own. Either way the taxonomy the assistant answers with is
 * unchanged by editing a machine.
 */
export function packWithMachine(
  pack: { intents?: unknown[]; machines?: Record<string, TaskStateMachine>; extends?: 'default' } | undefined,
  key: string,
  m: TaskStateMachine,
  classificationPack?: { intents: unknown[]; machines?: Record<string, TaskStateMachine>; extends?: 'default' },
): { intents: unknown[]; machines: Record<string, TaskStateMachine>; extends?: 'default' } {
  const base = pack?.intents ? pack : classificationPack ?? { extends: 'default' as const, intents: [] };
  return { ...base, intents: base.intents ?? [], machines: { ...(base.machines ?? {}), [key]: m } };
}
