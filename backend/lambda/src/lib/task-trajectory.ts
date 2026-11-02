/**
 * HOW A TASK GOT WHERE IT IS, measured against the machine it ran under (SPEC-EVALUATION Appendix C2,
 * proposed FR23).
 *
 * A workflow here is a declared, enforced graph (ADR-047), so the outcome and the path are facts the
 * runtime recorded in `stateHistory`, not a judge's reading of a transcript. This turns that log into a
 * small summary the turn stamps on its analytics record, where the archive keeps it after the task row
 * has aged out on its TTL.
 *
 * THE PATH IS COMPARED WITH THE GRAPH, NOT WITH ONE EXPECTED ROUTE. `shortestEdges` is the fewest
 * declared edges from the machine's initial state to any success terminal, so a task that reaches
 * success by a valid route the author did not anticipate scores as a longer path, never a mismatch.
 *
 * Pure: no I/O, so the unit tests read recorded histories directly.
 */
import type { StateTransition } from './task-tracking.js';
import type { TaskStateMachine, TerminalKind } from './task-state-machines.js';

/**
 * Turns a machine-backed task may sit in one state before it reads as stalled (SPEC-TASK-STATE-TRANSITIONS
 * §7). Env-overridable (`TASK_STALL_TURNS`), default 6, floor 1. The runtime never force-advances on it.
 */
export const TASK_STALL_TURNS = Math.max(1, Number(process.env.TASK_STALL_TURNS) || 6);

export interface TaskTrajectory {
  taskType: string;
  /** Graph edges taken so far, by the model and by the platform. Ownership and ending entries are not edges. */
  edges: number;
  /** Fewest declared edges from the initial state to a success terminal. Absent when none is reachable. */
  shortestEdges?: number;
  /** Edges INTO a state the task had already been in: the work went back. */
  regressions: number;
  /** Edges the platform took (`by: 'system'`): a declared step action, an expiry or an admin action. */
  platformMoves: number;
  /** The task was reopened from a terminal state at least once. */
  reopened?: true;
  /** The terminal kind of the state the task is in, when it is in one. */
  terminal?: TerminalKind;
  /** Consecutive turns in the current state without a move (`turnsInState`). */
  turnsInState: number;
}

/** Every edge the graph declares out of a state: its transitions and its action's outcome edges. */
function edgesOut(machine: TaskStateMachine, state: string): string[] {
  const def = machine.states[state];
  if (!def) return [];
  const out = new Set(def.transitions ?? []);
  if (def.onSuccess) out.add(def.onSuccess);
  if (def.onFailure) out.add(def.onFailure);
  return [...out];
}

/**
 * Fewest edges from the machine's initial state to any state marked `terminal: 'success'`, by
 * breadth-first search over the declared edges. `undefined` when no success terminal is reachable.
 */
export function shortestPathToSuccess(machine: TaskStateMachine): number | undefined {
  const start = machine.initial;
  if (!machine.states[start]) return undefined;
  if (machine.states[start].terminal === 'success') return 0;
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 1; frontier.length; depth++) {
    const next: string[] = [];
    for (const s of frontier) {
      for (const to of edgesOut(machine, s)) {
        if (seen.has(to)) continue;
        if (machine.states[to]?.terminal === 'success') return depth;
        seen.add(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * The trajectory of one task, from its recorded log and the machine the turn resolved for its type.
 * Returns `undefined` for a task with no machine: a lightweight task has no path to measure.
 */
export function trajectoryOf(args: {
  taskType: string | undefined;
  taskState: string | undefined;
  stateHistory: StateTransition[] | undefined;
  turnsInState: number | undefined;
  machines: Record<string, TaskStateMachine>;
}): TaskTrajectory | undefined {
  const machine = args.taskType ? args.machines[args.taskType] : undefined;
  if (!args.taskType || !machine) return undefined;

  const graphEdges = (args.stateHistory ?? []).filter(
    (e) => typeof e.to === 'string' && typeof e.from === 'string' && e.from !== '',
  );
  const visited = new Set<string>([machine.initial]);
  let regressions = 0;
  let platformMoves = 0;
  let reopened = false;
  for (const e of graphEdges) {
    const to = e.to as string;
    visited.add(e.from as string);
    if (visited.has(to)) regressions += 1;
    visited.add(to);
    if (e.by === 'system') platformMoves += 1;
    if (e.reopen) reopened = true;
  }

  const shortestEdges = shortestPathToSuccess(machine);
  const terminal = args.taskState ? machine.states[args.taskState]?.terminal : undefined;
  return {
    taskType: args.taskType,
    edges: graphEdges.length,
    ...(shortestEdges !== undefined ? { shortestEdges } : {}),
    regressions,
    platformMoves,
    ...(reopened ? { reopened: true as const } : {}),
    ...(terminal ? { terminal } : {}),
    turnsInState: Math.max(0, Number(args.turnsInState) || 0),
  };
}
