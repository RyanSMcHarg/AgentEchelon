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
  /**
   * This state is blocked on the PERSON, not on the assistant.
   *
   * Declared rather than inferred, for the same reason transitions are: a runtime that guessed from a
   * state's name would be right about `awaiting_result` and wrong about the next machine somebody
   * writes. Entering a state with this set hands the task to the user who is being waited on
   * (`reassignTask`), so it appears in their open-items queue alongside every other assistant's; the
   * task returns to the assistant when the state is left.
   *
   * It is what makes "waiting on you" one concept across workflows rather than a per-feature signal -
   * a duel's clarifying question and a report waiting on scope are the same thing to the person
   * holding them (ADR-024, ADR-029).
   */
  awaitsUser?: boolean;
  /**
   * ONE answer from the person completes this step, so their reply may advance it without the model
   * being consulted.
   *
   * Opt-in, and deliberately rare. `awaitsUser` says the machine is blocked on a person; it does NOT
   * say that the next thing they type finishes the step. Requirements gathering is the counter-example
   * and it is the common case: `collecting_requirements` has exactly one exit, so a rule of "advance
   * when there is only one way out" would move a report to drafting on the FIRST reply, before the
   * assistant has what it needs. That is a state machine racing ahead of the conversation it is
   * supposed to be following.
   *
   * Without this flag a response still hands the work back to the assistant - so the next action fires
   * either way - and the transition is left to `advance_task_state`, on the turn that has the text and
   * the model. Set it only where the step IS the answer: a confirmation, an approval, a single choice.
   */
  resolvedByOneResponse?: boolean;
  /**
   * WHAT THIS STEP NEEDS from the person before the workflow can go on.
   *
   * The missing half of `awaitsUser`. That flag says the machine is blocked on someone; it does not say
   * what would unblock it, so nothing could tell a complete answer from a partial one - and a step with
   * one exit advanced on whatever arrived first. "Make it about our Q3 numbers" moved a report to
   * drafting with no audience and no format, and the report was written anyway, to nobody, in no
   * particular shape. It reads as an assistant that was not listening.
   *
   * Named in the person's vocabulary, not the schema's, because it is read back to them when something
   * is missing: `'the audience'` is a sentence, `'audienceType'` is a field name.
   *
   * The check it enables is SEMANTIC and belongs to the model, on the turn that has the person's text -
   * `buildTaskContextForPrompt` renders these and the rule that goes with them. Deliberately not
   * enforced structurally: only the answer's content can say whether it named an audience, and a
   * keyword test for that is the sort of thing that passes on "no particular audience".
   *
   * Absent ⇒ today's behaviour exactly: any response is treated as sufficient. That is the right
   * default for a confirmation or a single choice, where the step IS the answer.
   */
  requires?: string[];
  /**
   * A DOCUMENT-PRODUCING workflow hands its file back from this state.
   *
   * Declared rather than inferred, for the same reason `awaitsUser` is: the attachment gate used to
   * key on a hardcoded per-taskType list of default-machine state names, which a per-profile machine
   * (SPEC-CONFIGURABLE-ASSISTANTS 4.5) could never match - a renamed state or a new document-producing
   * task type silently shipped every deliverable as unattached chat text, with only a shadow log line
   * as the trace. The machine is the authority on its own states, so the machine says which of them
   * deliver. Absent everywhere ⇒ the task type is interactive and never attaches a file.
   */
  delivers?: boolean;
}

/**
 * The tool a turn calls to move a machine on.
 *
 * It lives HERE, with the machines, rather than in `task-tools.ts` where it is registered: the name is
 * spoken by whatever grounds a step into a prompt as well as by the loop that dispatches it, and this
 * module is the one both of those can import without a cycle. A second literal copy of it is how a
 * prompt ends up telling a model to call a tool by a name that no longer exists.
 */
export const ADVANCE_TASK_STATE_TOOL_NAME = 'advance_task_state';

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
 *  - report_generation: `generating -> completed` delivers on generation (default); `revising` is a
 *    user-requested rework only, with `revising -> {completed | generating}`.
 *  - place_item: advanced by the propose_item tool's success side-effect (collecting -> confirming).
 *  - action_item: options_presented entered by the model's own tool call.
 */
export const DEFAULT_TASK_STATE_MACHINES: Record<string, TaskStateMachine> = {
  guided_troubleshooting: {
    initial: 'collecting_symptoms',
    states: {
      collecting_symptoms: {
        transitions: ['diagnosing'],
        awaitsUser: true,
        requires: ['what is going wrong', 'when it started', 'what they have already tried'],
      },
      diagnosing: { transitions: ['proposing_solutions', 'collecting_symptoms'] }, // regression: need more info
      proposing_solutions: { transitions: ['awaiting_result'] },
      // Worked / didn't / give up. No `requires`: the outcome IS the answer, and asking someone to
      // elaborate on "that fixed it" is the assistant not listening in the other direction.
      awaiting_result: { transitions: ['resolved', 'diagnosing', 'escalated'], awaitsUser: true },
      resolved: { transitions: [], terminal: 'success' },
      escalated: { transitions: [], terminal: 'handoff' },
    },
  },
  data_extraction: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: {
        transitions: ['extracting'],
        awaitsUser: true,
        requires: ['what data to pull', 'where it comes from', 'the output format'],
      },
      extracting: { transitions: ['validating', 'collecting_requirements'], delivers: true }, // regression: requirements were wrong
      validating: { transitions: ['formatting'], delivers: true },
      formatting: { transitions: ['completed'], delivers: true },
      completed: { transitions: [], terminal: 'success' },
    },
  },
  report_generation: {
    initial: 'collecting_requirements',
    states: {
      // THE STEP THAT PROVES WHY `requires` EXISTS. One exit, so anything that arrived used to move the
      // report on - and a report drafted with no audience and no format is written to nobody, in no
      // particular shape, from an assistant that looks like it was not listening.
      collecting_requirements: {
        transitions: ['drafting_outline'],
        awaitsUser: true,
        requires: ['the subject', 'the audience', 'the length or format'],
      },
      drafting_outline: { transitions: ['generating'] },
      // Deliver the report on generation: generating -> completed is the DEFAULT path. A generated
      // report is a finished deliverable; the user is never forced to run a revision pass. `revising`
      // is entered ONLY when the user explicitly asks for changes (generating -> revising, then apply
      // and re-deliver via revising -> completed, or regenerate).
      generating: { transitions: ['completed', 'revising'], delivers: true },
      revising: { transitions: ['completed', 'generating'], delivers: true }, // apply the requested changes -> deliver, or regenerate
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
      // The confirmation IS the step: one 'yes' completes it, so the reply may advance it directly.
      confirming: { transitions: ['placed'], awaitsUser: true, resolvedByOneResponse: true },
      placed: { transitions: [], terminal: 'success' },
    },
  },
  action_item: {
    initial: 'gathering',
    states: {
      gathering: { transitions: ['options_presented'] },
      // The options are ON THE TABLE and the person has to pick; then the work itself is theirs to do.
      options_presented: { transitions: ['awaiting_completion'], awaitsUser: true },
      awaiting_completion: { transitions: ['completed'], awaitsUser: true },
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
    // `requires` is what the PERSON still owes, so a state that is not waiting on one cannot have any.
    // Declared on a state the machine passes through unattended, it would be rendered into the prompt
    // as a list of things to chase nobody was ever asked for.
    if (def.requires?.length && !def.awaitsUser) {
      throw new TaskMachineValidationError(
        name,
        `state "${state}" declares requires but does not await the user`,
      );
    }
    // A step that one reply completes cannot also have a checklist standing between it and its exit:
    // the two flags would tell the model to advance on any answer and to withhold it until the list is
    // satisfied, and whichever won would be arbitrary.
    if (def.requires?.length && def.resolvedByOneResponse) {
      throw new TaskMachineValidationError(
        name,
        `state "${state}" is resolvedByOneResponse, so it cannot also declare requires`,
      );
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

/**
 * Project each machine to its ORDERED state-name array (`Record<taskType, string[]>`) — the legacy
 * shape the keyword shadow-detector + the terminal-state check consume. DERIVED from the authoritative
 * machines so the two can never drift (retires the hand-maintained TASK_STATE_MACHINES const). Insertion
 * order of `states` is the declared order, so the last name is the terminal happy-path state.
 */
export function stateNamesOf(
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [type, machine] of Object.entries(machines)) out[type] = Object.keys(machine.states);
  return out;
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
