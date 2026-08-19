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

/**
 * The references a step may declare as the party it awaits (SPEC-TASK-STATE-TRANSITIONS §12.6).
 *
 * `requester` is the person whose request opened the task, resolved from the task record itself, so it
 * costs nothing to resolve and can never fail. It is the ONLY reference that ships, because a value the
 * runtime cannot resolve would describe a capability that does not exist.
 */
export const AWAITED_PARTIES = ['requester'] as const;

/** A reference to the party a step awaits. Never a resolved principal id (§12.3). */
export type AwaitedParty = (typeof AWAITED_PARTIES)[number];

/**
 * WHO a step is waiting on, as a REFERENCE resolved when the step needs an owner.
 *
 * An object rather than a bare string so further reference kinds are additive: a future value carries
 * its own subject (`manager-of(requester)`) without changing the field's type again.
 */
export interface AwaitedPartyRef {
  party: AwaitedParty;
}

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
   * WHO this state is blocked on. Present ⇒ the machine cannot go further without that party.
   *
   * THE DECLARED FORM. Declared rather than inferred, for the same reason transitions are: a runtime
   * that guessed from a state's name would be right about `awaiting_result` and wrong about the next
   * machine somebody writes. Entering a state that awaits somebody hands the task to them
   * (`reassignTask`), so it appears in their open-items queue alongside every other assistant's; the
   * task returns to the assistant when the state is left.
   *
   * It is what makes "waiting on you" one concept across workflows rather than a per-feature signal -
   * a duel's clarifying question and a report waiting on scope are the same thing to the person
   * holding them (ADR-024, ADR-029).
   *
   * IT HOLDS A REFERENCE, NEVER A RESOLVED PRINCIPAL (SPEC-TASK-STATE-TRANSITIONS §12.3). A stored
   * principal id is wrong the moment the person it names changes, while a reference resolves afresh on
   * every read and the append-only transition log still answers who actually held the step. Only
   * `requester` ships; it resolves from the task record, so it is free and always resolvable.
   *
   * Read it through `awaitedPartyOf`, never off the field: a reader that keys on one of the two
   * accepted forms silently stops firing for a machine authored in the other.
   */
  awaits?: AwaitedPartyRef;
  /**
   * @deprecated Declare `awaits: { party: 'requester' }` instead. Accepted, and normalized to exactly
   * that by `awaitedPartyOf`, so a machine already stored in a profile version or carried through
   * profile export and import keeps working (SPEC-TASK-STATE-TRANSITIONS §12.6). It cannot express
   * WHICH party a step awaits, which is why the declared form is an object.
   */
  awaitsUser?: boolean;
  /**
   * ONE clear answer from the person completes this step, so the assistant should take it and move on
   * rather than asking again.
   *
   * Opt-in, and deliberately rare. `awaits` says the machine is blocked on a party; it does NOT
   * say that the next thing they type finishes the step. Requirements gathering is the counter-example
   * and it is the common case: `collecting_requirements` has exactly one exit, so a rule of "advance
   * when there is only one way out" would move a report to drafting on the FIRST reply, before the
   * assistant has what it needs. That is a state machine racing ahead of the conversation it is
   * supposed to be following.
   *
   * IT IS A STATEMENT TO THE MODEL, NOT A LICENCE FOR THE RUNTIME. It used to let
   * `applyUserResponseToTask` advance the machine before the model saw the message, and that check is
   * structural - it asks whether the state awaits someone, never what was said. So `confirming` read
   * "actually, make it 45 minutes and put it before the kickoff" and "no, do not add it" as approvals
   * and moved the task to `placed`, a SUCCESS terminal, recording an approval nobody gave and closing
   * the task the correction needed. No structural test separates those replies from a "yes": they are
   * all one reply to a one-exit step, and only their content differs.
   *
   * So the reply always hands the work back to the assistant - which is what fires the next action -
   * and the transition is left to `advance_task_state`, on the turn that has the text and the model.
   * This flag is rendered into that turn's prompt (`buildTaskContextForPrompt`): one clear agreement
   * completes the step, a correction is put back to the person instead, and a decline advances
   * nothing. Set it only where the step IS the answer: a confirmation, an approval, a single choice.
   */
  resolvedByOneResponse?: boolean;
  /**
   * WHAT THIS STEP NEEDS from the person before the workflow can go on.
   *
   * The missing half of `awaits`. That declaration says the machine is blocked on someone; it does not say
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
   * Declared rather than inferred, for the same reason `awaits` is: the attachment gate used to
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

/**
 * THE ONE READER OF "who does this step await". Every consumer goes through it; none reads either
 * field directly.
 *
 * Two forms are accepted and mean the same thing: the declared `awaits: { party: 'requester' }`, and
 * the deprecated `awaitsUser: true` a machine already stored in a profile version or carried through
 * profile export and import may still hold (SPEC-TASK-STATE-TRANSITIONS §12.6). A consumer that keyed
 * on one of them would silently stop firing for a machine authored in the other, and the consumers
 * include the validator that refuses `requires` on a state awaiting nobody - a rule that stops firing
 * is worse than one that never existed, because the machine it was protecting still looks checked.
 *
 * Returns a REFERENCE, not a principal. Resolving it to a person is the caller's, on the record it
 * holds, at the moment the step needs an owner (§12.3).
 *
 * An unrecognised party yields null rather than a guess. Every ingress that can carry one - the
 * per-assistant profile body, the deployment intent pack, an imported manifest - validates the party
 * first (`validateTaskStateMachine`), so a value that reaches here unknown is one no path admits.
 */
export function awaitedPartyOf(def: TaskStateDef | undefined | null): AwaitedPartyRef | null {
  if (!def) return null;
  if (def.awaits) {
    return (AWAITED_PARTIES as readonly string[]).includes(def.awaits.party) ? def.awaits : null;
  }
  return def.awaitsUser === true ? { party: 'requester' } : null;
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
 * The platform DEFAULT machines - the five historical task types, migrated verbatim in ordering
 * with the regression and branch edges the array form could not represent. Keeping these as the
 * default makes the migration a no-op for any deployment that does not override machines in its pack.
 *
 * THESE ARE REFERENCE WORKFLOWS, NOT PRODUCTION ONES. They exist to prove the mechanism and to give a
 * deployment something that works on day one. They are deliberately minimal, and a real deployment is
 * expected to replace or extend them rather than adopt them as they stand. The clearest illustration
 * is `guided_troubleshooting.escalated`: it is terminal with disposition `handoff`, and NOTHING routes
 * that anywhere. No person is notified, no queue receives it, no external system is called. The
 * disposition does not even survive to an operator: any terminal state marks the lifecycle
 * `completed`, and a completed task's terminal kind is recorded as `success`, so an escalation reads
 * in the ledger exactly like a resolution. Only the tool's return value carries `handoff`, to the
 * model. The missing DESTINATION is a deliberate boundary, since where an escalation should go is a
 * property of the deploying organisation; the missing DISTINCTION in the record is not, and a
 * deployment relying on this state should expect to fix both.
 *
 * The same caveat applies to the rest: no machine here carries an SLA, a retry policy, an approval
 * with an entitled approver, or an integration with anything outside the conversation. Read them as
 * worked examples of the contract in SPEC-TASK-STATE-TRANSITIONS, not as flows to run a business on.
 *
 * Deltas from the old linear arrays (SPEC-TASK-STATE-TRANSITIONS §5):
 *  - guided_troubleshooting: `diagnosing -> collecting_symptoms` (need more info) and
 *    `awaiting_result -> {resolved | diagnosing | escalated}` (worked / didn't / give up).
 *  - data_extraction: `extracting -> collecting_requirements` regression.
 *  - report_generation: `generating -> completed` delivers on generation (default); `revising` is a
 *    user-requested rework only, with `revising -> {completed | generating}`.
 *  - place_item: advanced by the propose_item tool's success side-effect (collecting -> confirming).
 *  - action_item: options_presented entered by the model's own tool call.
 *
 * WHERE EACH MACHINE RESTS ON THE PERSON. Three of them name their wait in a state of its own -
 * `awaiting_result`, `confirming`, `options_presented`/`awaiting_completion` - so the state that
 * produces the thing being waited on (`proposing_solutions`, `collecting`, `gathering`) is passed
 * through within the turn and awaits nobody. The other two have no such state: `drafting_outline`
 * exits only to `generating` and `validating` only to `formatting`, both of which are the assistant
 * working, so in those two machines the producing state IS the wait and carries `awaits` itself.
 */
export const DEFAULT_TASK_STATE_MACHINES: Record<string, TaskStateMachine> = {
  guided_troubleshooting: {
    initial: 'collecting_symptoms',
    states: {
      collecting_symptoms: {
        transitions: ['diagnosing'],
        awaits: { party: 'requester' },
        requires: ['what is going wrong', 'when it started', 'what they have already tried'],
      },
      diagnosing: { transitions: ['proposing_solutions', 'collecting_symptoms'] }, // regression: need more info
      proposing_solutions: { transitions: ['awaiting_result'] },
      // Worked / didn't / give up. No `requires`: the outcome IS the answer, and asking someone to
      // elaborate on "that fixed it" is the assistant not listening in the other direction.
      awaiting_result: {
        transitions: ['resolved', 'diagnosing', 'escalated'],
        awaits: { party: 'requester' },
      },
      resolved: { transitions: [], terminal: 'success' },
      escalated: { transitions: [], terminal: 'handoff' },
    },
  },
  data_extraction: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: {
        transitions: ['extracting'],
        awaits: { party: 'requester' },
        requires: ['what data to pull', 'where it comes from', 'the output format'],
      },
      extracting: { transitions: ['validating', 'collecting_requirements'], delivers: true }, // regression: requirements were wrong
      // THE EXTRACTION IS PUT TO THE PERSON TO CHECK, so the person holds it. The step's whole job is
      // "do these records look right?", and the only way out of it is `formatting`, which is work the
      // assistant does once they have said. There is no separate waiting state to hold that pause, so
      // it rests here - the same shape as `drafting_outline` below, and it is left off for the same
      // reason it was left off there.
      //
      // No `resolvedByOneResponse`: "row 3 is wrong" is a reply and is not an approval, and one exit
      // plus any reply is exactly what would format and deliver the wrong table.
      validating: { transitions: ['formatting'], awaits: { party: 'requester' }, delivers: true },
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
        awaits: { party: 'requester' },
        requires: ['the subject', 'the audience', 'the length or format'],
      },
      // THE OUTLINE IS PUT TO THE PERSON FOR APPROVAL, so the person holds it. The step ends its turn
      // on a question ("does this structure work, or do you want to change a section?") and the only
      // way out of it is `generating`, which is the assistant writing the report. Nothing else in the
      // machine can hold that pause, unlike `guided_troubleshooting`, where the wait has its own state
      // (`awaiting_result`) one hop on; here the wait IS this state.
      //
      // WHAT ITS ABSENCE COST. Ownership moves at every `awaits` boundary, so with the declaration off the
      // report stayed with the assistant while the person was the one being waited on. The next turn's
      // owner-keyed lookup found nothing held by them, the router reported no live task, and drift
      // suppression - which existed for precisely this turn - never ran. "Can you make it 1-2 pages?",
      // a direct answer to the assistant's own question, was answered with an offer to split the
      // conversation, because a short reply about page count sits far from an ARR summary's embedding.
      //
      // `requires` names the one thing the person still owes, because the step is genuinely blocked on
      // a decision and the list is read back to them when it is missing. It also tells the model that a
      // change request IS the answer to this step - apply it and move on - rather than a new subject.
      //
      // NOT `resolvedByOneResponse`: that would advance to `generating` on whatever arrived, so "how
      // long will this take?" would start writing the report. The reply hands the work back to the
      // assistant either way; the transition is left to `advance_task_state`, on the turn that has the
      // text and the model.
      drafting_outline: {
        transitions: ['generating'],
        awaits: { party: 'requester' },
        requires: ['approval of the outline, or what to change about it'],
      },
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
      // The confirmation IS the step: one clear "yes" completes it, and the assistant is told to take
      // that answer rather than ask again. It does NOT mean any reply completes it - a correction
      // ("make it 45 minutes") and a decline ("do not add it") arrive at this same step, and `placed`
      // is a SUCCESS terminal that would record them as approvals.
      confirming: {
        transitions: ['placed'],
        awaits: { party: 'requester' },
        resolvedByOneResponse: true,
      },
      placed: { transitions: [], terminal: 'success' },
    },
  },
  action_item: {
    initial: 'gathering',
    states: {
      gathering: { transitions: ['options_presented'] },
      // The options are ON THE TABLE and the person has to pick; then the work itself is theirs to do.
      options_presented: { transitions: ['awaiting_completion'], awaits: { party: 'requester' } },
      awaiting_completion: { transitions: ['completed'], awaits: { party: 'requester' } },
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
    // An unresolvable reference is refused HERE, at every ingress a machine can arrive through (the
    // per-assistant profile body, the deployment intent pack, an imported manifest), because a party
    // nothing resolves leaves a step with no owner and no way to say so.
    if (def.awaits && !(AWAITED_PARTIES as readonly string[]).includes(def.awaits.party)) {
      throw new TaskMachineValidationError(
        name,
        `state "${state}" awaits an unknown party "${def.awaits.party}"; declared parties: ${AWAITED_PARTIES.join(', ')}`,
      );
    }
    // `requires` is what the awaited party still owes, so a state waiting on nobody cannot have any.
    // Declared on a state the machine passes through unattended, it would be rendered into the prompt
    // as a list of things to chase nobody was ever asked for.
    //
    // KEYED ON THE NORMALIZER, not on either field. Keyed on `awaitsUser` this rule stopped firing the
    // moment a machine was authored in the declared form, which is the state of affairs it exists to
    // catch: the machine still reads as validated while nothing checks it.
    if (def.requires?.length && !awaitedPartyOf(def)) {
      throw new TaskMachineValidationError(
        name,
        `state "${state}" declares requires but awaits nobody`,
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
