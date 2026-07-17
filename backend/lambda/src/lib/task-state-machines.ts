/**
 * Task state machines as declared transition graphs (SPEC-TASK-STATE-TRANSITIONS §4).
 *
 * Replaces the linear `Record<string, string[]>` (task-tracking.ts `TASK_STATE_MACHINES`),
 * whose `indexOf(current) + 1` advance could not express a regression edge (a failed fix
 * returning to an earlier state) or an outcome branch (resolved vs escalated). A graph makes
 * those edges first-class and enumerable, which is also what lets analytics COUNT them
 * (e.g. "how often does a proposed fix fail" = count of `awaiting_result -> diagnosing`).
 *
 * A machine is authorized, not inferred: the runtime accepts a transition only if the edge
 * `current -> to` is declared here (the authorization step in §3). Per-state `prompt` and
 * `placeholder` are optional and migrate off the hardcoded processor switches in a later step;
 * carrying them here makes both pack-configurable and localizable (§4).
 */

/** Terminal disposition of a state with no outgoing transitions. */
export type TerminalKind = 'success' | 'failure' | 'handoff';

export interface TaskStateDef {
  /** System-prompt fragment for this state (migrates buildTaskSystemPrompt's switch). Optional until that migration. */
  prompt?: string;
  /** Placeholder copy for this state (migrates getTaskPlaceholder's switch). Optional until that migration. */
  placeholder?: string;
  /** Legal target states reachable from here. Empty array = terminal. */
  transitions: string[];
  /** Set iff `transitions` is empty; the outcome this terminal records. */
  terminal?: TerminalKind;
}

export interface TaskStateMachine {
  /** The state a freshly created task of this type starts in. Must be a declared state. */
  initial: string;
  states: Record<string, TaskStateDef>;
}

/** Thrown by validation when a machine is malformed; carries the machine name for a loud hydrate failure (§4). */
export class TaskMachineValidationError extends Error {
  constructor(
    public readonly machineName: string,
    message: string,
  ) {
    super(`TaskStateMachine "${machineName}": ${message}`);
    this.name = 'TaskMachineValidationError';
  }
}

/**
 * The platform DEFAULT machines — the five historical task types, migrated verbatim in ordering
 * with the regression and branch edges the array form could not represent. Keeping these as the
 * default makes the migration a no-op for any deployment that does not override machines in its pack.
 *
 * Deltas from the old linear arrays (SPEC-TASK-STATE-TRANSITIONS §5):
 *  - guided_troubleshooting: `diagnosing -> collecting_symptoms` (need more info) and
 *    `awaiting_result -> {resolved | diagnosing | escalated}` (worked / didn't / give up).
 *  - data_extraction: `extracting -> collecting_requirements` regression.
 *  - report_generation: `revising -> generating` loop edge.
 *  - place_item: advanced by the propose_item tool's success side-effect (collecting -> confirming).
 *  - action_item: options_presented entered by the model's own tool call.
 */
export const DEFAULT_TASK_STATE_MACHINES: Record<string, TaskStateMachine> = {
  guided_troubleshooting: {
    initial: 'collecting_symptoms',
    states: {
      collecting_symptoms: { transitions: ['diagnosing'] },
      diagnosing: { transitions: ['proposing_solutions', 'collecting_symptoms'] }, // regression: need more info
      proposing_solutions: { transitions: ['awaiting_result'] },
      awaiting_result: { transitions: ['resolved', 'diagnosing', 'escalated'] }, // worked / didn't / give up
      resolved: { transitions: [], terminal: 'success' },
      escalated: { transitions: [], terminal: 'handoff' },
    },
  },
  data_extraction: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: { transitions: ['extracting'] },
      extracting: { transitions: ['validating', 'collecting_requirements'] }, // regression: requirements were wrong
      validating: { transitions: ['formatting'] },
      formatting: { transitions: ['completed'] },
      completed: { transitions: [], terminal: 'success' },
    },
  },
  report_generation: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: { transitions: ['drafting_outline'] },
      drafting_outline: { transitions: ['generating'] },
      generating: { transitions: ['revising'] },
      revising: { transitions: ['generating', 'completed'] }, // loop: another revision pass, or finish
      completed: { transitions: [], terminal: 'success' },
    },
  },
  // place_item advances on the propose_item tool's success side-effect (collecting -> confirming),
  // not a prose keyword or an in-band marker. `placed` (the host apply) is deferred; the task rests
  // in `confirming` under its TTL until the apply lands or a cascade/nudge closes it.
  place_item: {
    initial: 'collecting',
    states: {
      collecting: { transitions: ['confirming'] },
      confirming: { transitions: ['placed'] },
      placed: { transitions: [], terminal: 'success' },
    },
  },
  action_item: {
    initial: 'gathering',
    states: {
      gathering: { transitions: ['options_presented'] },
      options_presented: { transitions: ['awaiting_completion'] },
      awaiting_completion: { transitions: ['completed'] },
      completed: { transitions: [], terminal: 'success' },
    },
  },
};

/**
 * Validate one machine (§4 hydrate checks). Throws TaskMachineValidationError on the first problem:
 *  - the initial state is declared;
 *  - every transition target is a declared state;
 *  - a state is terminal (terminal set) iff it has no transitions;
 *  - at least one terminal state exists;
 *  - every state is reachable from initial (no orphan states).
 */
export function validateTaskStateMachine(name: string, machine: TaskStateMachine): void {
  const stateNames = Object.keys(machine.states);
  if (stateNames.length === 0) {
    throw new TaskMachineValidationError(name, 'has no states');
  }
  if (!machine.states[machine.initial]) {
    throw new TaskMachineValidationError(name, `initial state "${machine.initial}" is not declared`);
  }

  let terminalCount = 0;
  for (const [state, def] of Object.entries(machine.states)) {
    const isTerminalByEdges = def.transitions.length === 0;
    if (isTerminalByEdges) {
      terminalCount++;
      if (!def.terminal) {
        throw new TaskMachineValidationError(name, `terminal state "${state}" is missing a terminal disposition`);
      }
    } else if (def.terminal) {
      throw new TaskMachineValidationError(name, `state "${state}" has transitions but is marked terminal`);
    }
    for (const target of def.transitions) {
      if (!machine.states[target]) {
        throw new TaskMachineValidationError(name, `state "${state}" transitions to undeclared state "${target}"`);
      }
    }
  }
  if (terminalCount === 0) {
    throw new TaskMachineValidationError(name, 'has no terminal state');
  }

  // Reachability: BFS from initial; every declared state must be visited.
  const seen = new Set<string>([machine.initial]);
  const queue = [machine.initial];
  while (queue.length > 0) {
    const s = queue.shift() as string;
    for (const t of machine.states[s].transitions) {
      if (!seen.has(t)) {
        seen.add(t);
        queue.push(t);
      }
    }
  }
  const unreachable = stateNames.filter((s) => !seen.has(s));
  if (unreachable.length > 0) {
    throw new TaskMachineValidationError(name, `states unreachable from initial: ${unreachable.join(', ')}`);
  }
}

/** Validate every machine in a map (used at pack hydrate). Throws on the first malformed machine. */
export function validateTaskStateMachines(machines: Record<string, TaskStateMachine>): void {
  for (const [name, machine] of Object.entries(machines)) {
    validateTaskStateMachine(name, machine);
  }
}

/** The initial state of a task type, or undefined if the type has no machine. */
export function initialStateFor(
  taskType: string,
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): string | undefined {
  return machines[taskType]?.initial;
}

/** Legal target states from `state` in the machine, or [] if the type/state is unknown. */
export function legalTransitionsFrom(
  taskType: string,
  state: string,
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): string[] {
  return machines[taskType]?.states[state]?.transitions ?? [];
}

/** Whether `state` is a declared state of the task type's machine. */
export function isDeclaredState(
  taskType: string,
  state: string,
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): boolean {
  return Boolean(machines[taskType]?.states[state]);
}

/** Whether the edge `from -> to` is authorized by the task type's machine. */
export function isLegalTransition(
  taskType: string,
  from: string,
  to: string,
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): boolean {
  return legalTransitionsFrom(taskType, from, machines).includes(to);
}

/** The terminal disposition of `state`, or undefined if it is not terminal / unknown. */
export function terminalKindOf(
  taskType: string,
  state: string,
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): TerminalKind | undefined {
  const def = machines[taskType]?.states[state];
  return def && def.transitions.length === 0 ? def.terminal : undefined;
}

/** The authorization decision for a requested transition (SPEC-TASK-STATE-TRANSITIONS §3). */
export type TransitionAuthz =
  | { ok: true; from: string; to: string; terminal?: TerminalKind }
  | { ok: false; error: 'unknown_state' | 'illegal_transition'; from: string; legal: string[] };

/**
 * Authorize (do not persist) a requested `from -> to` transition against the task type's graph —
 * the runtime's authorization step (§3, checks 2 and 3; check 1, "an active task exists", is the
 * caller's). `unknown_state` = `to` is not a declared state of this machine; `illegal_transition`
 * = declared, but the edge is not in the graph, and the legal set is echoed back so the model can
 * self-correct in the same loop iteration.
 */
export function authorizeTransition(
  taskType: string,
  from: string,
  to: string,
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): TransitionAuthz {
  const legal = legalTransitionsFrom(taskType, from, machines);
  if (!isDeclaredState(taskType, to, machines)) {
    return { ok: false, error: 'unknown_state', from, legal };
  }
  if (!legal.includes(to)) {
    return { ok: false, error: 'illegal_transition', from, legal };
  }
  return { ok: true, from, to, terminal: terminalKindOf(taskType, to, machines) };
}
