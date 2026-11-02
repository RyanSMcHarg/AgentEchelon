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
 * `current -> to` is declared here (the authorization step in §3). A state's `prompt` is the one
 * source of its step instructions for every machine, these platform defaults included (§9);
 * `placeholder` is optional. Carrying both here makes them pack-configurable and localizable (§4).
 */

import { TOOL_REGISTRY, isKnownTool } from './tool-registry.js';
import { parseBinding } from './step-bindings.js';
import {
  buildSourceTable, evaluateWhen, sourceKindOf, sourceLookup, whenErrors, withUnreadCatalog,
  type SourceLookup, type VariableValue, type When,
} from './variables.js';

/** Terminal disposition of a state with no outgoing transitions. */
export type TerminalKind = 'success' | 'failure' | 'handoff';

/**
 * The references a step may declare as the party it awaits (SPEC-TASK-STATE-TRANSITIONS §12.6).
 *
 * `requester` is the person whose request opened the task, resolved from the task record itself, so it
 * costs nothing to resolve and can never fail.
 *
 * `worker` is whoever a workflow's task step named to do the work (ADR-063 decision 1): a person, a participant
 * role's one holder, or an assistant, resolved once when the step ran and recorded on the task (`workerId`,
 * `workerType`), so it too resolves from the record. A task no step opened has no worker, and a state awaiting
 * one falls back to the requester, the only other party its record names.
 *
 * Both resolve from the task record, because a value the runtime cannot resolve would describe a capability
 * that does not exist.
 */
export const AWAITED_PARTIES = ['requester', 'worker'] as const;

/** When a presented step is put to the person (`TaskStateDef.confirm`, ADR-064 decision G). */
export const CONFIRM_POLICIES = ['always', 'when-incomplete'] as const;
export type ConfirmPolicy = (typeof CONFIRM_POLICIES)[number];

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
  /**
   * WHAT THE ASSISTANT IS TOLD TO DO IN THIS STEP, rendered under the `## CURRENT TASK` header by
   * `buildTaskSystemPrompt` (task-step-prompt.ts) and handed back by `advance_task_state` when a turn
   * moves into this state.
   *
   * The only source of step instructions, for the platform defaults and for a machine a pack or profile
   * declares alike: nothing in code keys on a task type's name to supply them, so a manager changes a
   * step by changing this field. Absent, the step is rendered with its header and legal next states only.
   */
  prompt?: string;
  /** Placeholder copy for this state (migrates getTaskPlaceholder's switch). Optional until that migration. */
  placeholder?: string;
  /**
   * How this state is NAMED to the person, in the status chip the chat client renders from the
   * `ACTIVE_TASK` marker.
   *
   * Declared, for the same reason `delivers` and `awaits` are: the shipped label table is keyed by the
   * SHIPPED task types, so a pack-declared type or a renamed state could never have a label and the
   * person was shown the raw key - "report_generation" in the chip (measured live). A machine's author
   * is the one who can name their own states, and in their deployment's own language.
   *
   * Absent, the runtime falls back to the shipped table and then to the state name reshaped
   * (`drafting_outline` -> "Drafting outline"), so omitting it is never a key on screen.
   */
  label?: string;
  /** Legal target states reachable from here. Empty array = terminal. */
  transitions: string[];
  /** Set iff `transitions` is empty; the outcome this terminal records. */
  terminal?: TerminalKind;
  /**
   * THE STATES A FINISHED TASK MAY RETURN TO WHEN ITS REQUESTER ASKS FOR CHANGES. Declared only on a
   * terminal state; each target is a non-terminal state of the same machine.
   *
   * A declared reopen rather than an ordinary transition, because the two mean different things. An
   * ordinary transition keeps a state open: a state with one is not terminal, so the task stays live
   * and stays in its requester's open-work list. A delivered report is finished work, and listing every
   * one of them as open would make the list useless. A reopen leaves the state terminal (the task reads
   * as ended, and nothing lists it as open) while recording that the person who asked for it may still
   * ask for it to change.
   *
   * WHO MAY TAKE IT. Only the model's `advance_task_state` call, on a turn carrying the requester's own
   * message (`by: 'tool'`). A runtime writer (`by: 'system'`) is refused, because a reopen is the person
   * asking and no runtime path has the person's words. The edge is recorded in `stateHistory` with
   * `reopen: true` and its author, and the task's lifecycle status returns to `in_progress`.
   *
   * WHEN IT IS OFFERED. The router resolves a reopenable task as the subject of a follow-up in the same
   * conversation, from the same requester, for the window a finished task keeps answering for the
   * conversation (`RECENTLY_ENDED_TASK_WINDOW_MINUTES`, task-tracking.ts). Past that window the task is
   * not offered, and a change request opens new work.
   *
   * Absent, the terminal state is final.
   */
  reopens?: string[];
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
   * IT IS A STATEMENT TO THE MODEL, NOT A LICENSE FOR THE RUNTIME. It used to let
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
   * Absent ⇒ today's behavior exactly: any response is treated as sufficient. That is the right
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
   *
   * A STATE THAT AWAITS SOMEBODY CANNOT DELIVER (`validateTaskStateMachine`). A step blocked on a person
   * is putting something to them, a question or work to check, and what it puts to them is
   * conversation. A step that hands over a finished document is the assistant's own. Declared on one
   * state, the two told the model to write a document for a reader outside the conversation and to ask
   * the person in it something, in the same reply, and the reply became the file.
   *
   * WHAT IS PACKAGED IS DECLARED TOO. A turn that enters a delivering state passes the finished
   * document as the `document` argument of `advance_task_state`, and a turn that rewrites it while the
   * task stays in a delivering state passes it to `deliver_document`. Only that declared text becomes
   * the file; the reply posts as chat.
   *
   * RETIRED (ADR-064 decision 2): declare `produces: 'document'`. A machine that still says `delivers` is refused
   * naming `produces`, so the two never coexist. Read a state's output through `deliversDocument` and `stepOutputOf`.
   */
  delivers?: boolean;
  /**
   * WHAT THIS STEP HANDS OVER (ADR-064 decision 2): `text` (the default, a reply in the conversation), `document` (a
   * delivered file, what `delivers` used to say) or `image` (an image the platform generates on entry, through the
   * `generate_image` action, on the image model of the intent's route). A turn needs an image exactly when the step it
   * runs produces one, and the model a step runs on is of its kind (`models.byIntent[<intent>].steps`).
   */
  produces?: 'text' | 'image' | 'document';
  /**
   * THIS STEP IS PUT TO THE PERSON BEFORE THE TASK MAY LEAVE IT.
   *
   * Declared, like the rest of these, because it is the workflow's author deciding how much of the
   * step is the model's judgement. A machine that omits it lets the model judge whether it already has
   * what it needs and move on in the same turn. A machine that declares it makes the step a
   * checkpoint: the model presents it (what it is taking, or what it found) and the person's reply is
   * what moves it on.
   *
   * ENFORCED BY THE RUNTIME, structurally. `advance_task_state` refuses to leave a `presented` state on
   * the turn the task entered it, which includes the turn that created the task at its initial state,
   * with `opening_step_must_be_presented` and no state change. What the runtime reads is a fact about
   * the task, never about what anybody wrote: the task's recorded opening turn, and the transitions this
   * turn applied.
   *
   * Only on a state that awaits somebody (`validateTaskStateMachine`): a step presented to nobody has
   * nobody whose reply could move it on.
   */
  presented?: boolean;
  /**
   * WHEN THIS PRESENTED STEP IS PUT TO THE PERSON (ADR-064 decision G): `always`, or `when-incomplete`, where a request
   * that already carries the complete brief goes past it. Only on a `presented` state.
   *
   * The way past is an edge the machine declares: a state that moves into this one and also moves straight to one of
   * this step's own targets (`image_generation`: `gather -> generate`, past `confirm`). Under `always` that edge is not
   * a legal move (`legalTransitionsFrom` leaves it out, so it is neither offered nor authorized). Under
   * `when-incomplete` it is taken only from a step the task entered on this turn, so the request itself carried the
   * brief, and only where every need of `brief` is recorded on the task with its source (`directEdgeRefusal`). The
   * model judges completeness once, from the person's words, and records it as data; the runtime compares names.
   *
   * Absent, nothing about the step changes: a direct edge past it is an ordinary edge. A version sets it per workflow
   * with `confirmBrief` (`withConfirmBrief`), which replaces the declared value on every state of that workflow that
   * declares one.
   */
  confirm?: ConfirmPolicy;
  /**
   * THE NEEDS A COMPLETE BRIEF CARRIES, in the person's vocabulary like `requires`, on a step that declares `confirm`.
   * Required where `confirm` is `when-incomplete`: it is what the runtime checks before the task goes past the step.
   */
  brief?: string[];
  /**
   * THE TEMPLATE THIS DELIVERING STEP'S DOCUMENT FOLLOWS (SPEC-DOCUMENT-TEMPLATES FR3), by name, or
   * pinned to one version as `name@<sha256>`. Only on a state that `delivers`.
   *
   * The platform loads it from the classification's own `templates/` prefix, renders its structure and
   * section guidance into the step's guidance, and checks the declared document's structure against it
   * before anything is attached. Absent, the document's shape is the model's.
   */
  template?: string;
  /**
   * A CHOICE OF TEMPLATES for this delivering step (FR3a), each a name or `name@<sha256>`. The person
   * chooses on the workflow's requirements step (its initial state, which then declares `requires`),
   * and the delivering step loads the RECORDED choice. Exclusive with `template`.
   */
  templates?: string[];
  /** The template from `templates` used when nobody chose, stated to the person as a requirement taken. */
  defaultTemplate?: string;
  /**
   * THE TOOLS THIS STEP'S TURN MAY USE (SPEC-TASK-STATE-TRANSITIONS FR28), by registered name.
   *
   * A narrowing, never a grant: the turn is offered the intersection of the profile's allowlist, the
   * intent's tools and this list (`toolsForStep`, task-tools.ts), so a checking step cannot call a
   * writing tool even where the profile allows one. The task tools (`advance_task_state`,
   * `deliver_document`) are the workflow's own mechanism and stay available whatever this says.
   * Enforced twice: the turn is offered only these, and a call to any other tool while the task is in
   * this state is refused (`tool_not_in_step`). Absent, the step narrows nothing.
   */
  tools?: string[];
  /**
   * THE TOOLS THAT MUST HAVE RUN BEFORE THE TASK LEAVES THIS STEP (ADR-064 decision 3): `advance_task_state` out of it
   * is refused with `required_tool_not_run`, naming the tool, until each listed tool returned success since the task
   * last entered the state. For a tool whose arguments need the model's judgment (a search, a lookup by what the person
   * described), which an `action` cannot run. Each name is in the step's `tools` where it declares them; a state that
   * declares an `action` declares none.
   */
  requiresTool?: string[];
  /**
   * WHAT THE PLATFORM DOES ON ENTERING THIS STEP, with no model call (FR29): a registered tool run with
   * arguments bound to what the task recorded. See `StepAction`. A state that declares one declares
   * `onSuccess`, and `onFailure` or a transition into a terminal `failure` state, and the runtime takes
   * that edge on the action's outcome.
   */
  action?: StepAction;
  /** The state the runtime moves the task to when this step's action succeeds. A declared transition. */
  onSuccess?: string;
  /**
   * The state the runtime moves the task to when this step's action fails. A declared transition.
   * Absent, the step's transition into a terminal state of disposition `failure` is taken instead.
   */
  onFailure?: string;
  /**
   * THE STEP'S ENTRY CONDITION (ADR-060 decision 6): a move into this state is authorized only where it holds,
   * over the deciding values the turn's resolver read (`authorizeTransition`), whoever asked for the move, the model
   * or a step action's outcome. A condition that does not hold refuses the move with a reason that names no value,
   * as an undeclared edge is refused. An unresolved value holds no condition.
   */
  when?: When;
  /**
   * A CONDITION ON ONE OF THIS STATE'S EDGES, by target (ADR-060 decision 6): `{ escalated: { 'person:clearance':
   * { op: 'has', value: 'premium' } } }` authorizes `-> escalated` only where it holds. Every key is one of
   * `transitions`.
   */
  edgeWhen?: Record<string, When>;
  /**
   * THE CHOICES A PERSON MAY MAKE ON THIS STEP'S CARD (ADR-063 decision 2): each a declared transition of this state,
   * offered as a button on the task card only its assignee receives, and taken by the task service when that assignee
   * presses it (`advanceAsAssignee`). Only on a state that awaits somebody: a choice is put to the party the step waits
   * on. A choice is data, so no decision rests on recognizing a phrase (tenet D11). Absent, the step is completed by
   * writing in the conversation, as every step is.
   */
  choices?: string[];
  /**
   * THIS STEP RESTS UNTIL SOMEBODY ASKS OR A TIME PASSES (ADR-063 decision 5): an assistant that is idle in the
   * conversation does not take it up on its own. Declared on a state that awaits nobody and is not terminal, where the
   * work is done and the task is held as the room's (`incident_first_look.findings_shared`), or where something other
   * than a turn drives it (`queue_drain`, which the queue's own reading moves). Absent, a state that awaits nobody is
   * the assistant's to take up proactively.
   */
  rests?: boolean;
}

/**
 * A STEP ACTION: a registered tool the platform runs when a task enters the state (FR29).
 *
 * `tool` is a name in the tool registry that executes in the turn (a context or connector tool, the
 * same handler a model's call reaches), or `deliver_document` on a delivering step, which declares the
 * step's platform-filled template as the document. `args` maps each of the tool's parameters to a
 * binding (`step-bindings.ts`): `requirement:<need>`, `detail:<key>`, `tool:<state>.<path>` or
 * `literal:<text>`, or a number or boolean taken as written.
 *
 * It runs under the assistant's own session and only where the profile's and the intent's allowlists
 * permit the tool, exactly once per entry into the state (keyed on the task, the state and how many
 * times the task has entered it), and its outcome is recorded on the task (`details.actions[state]`)
 * and in the transition log as the runtime-driven edge it caused.
 */
export interface StepAction {
  tool: string;
  args?: Record<string, string | number | boolean>;
}

/**
 * The edges a state's action outcome drives: `onSuccess`, and `onFailure` or, absent, the state's
 * transition into a terminal `failure` state. Null when the state declares no action.
 */
export function actionEdgesOf(
  machine: TaskStateMachine | undefined,
  state: string,
): { onSuccess: string; onFailure?: string } | null {
  const def = machine?.states?.[state];
  if (!def?.action || !def.onSuccess) return null;
  const fallback = def.transitions.find((t) => {
    const target = machine?.states?.[t];
    return target && target.transitions.length === 0 && target.terminal === 'failure';
  });
  const onFailure = def.onFailure ?? fallback;
  return { onSuccess: def.onSuccess, ...(onFailure ? { onFailure } : {}) };
}

/**
 * How many times the task has ENTERED `state`, read from its transition log: one for each graph edge
 * landing there. Zero for the state a task was created in until something moves it back. The entry a
 * step action is keyed on, so a task that leaves a state and returns runs the action again, and a turn
 * that is retried on the same entry does not.
 */
export function entrySequenceOf(stateHistory: Array<{ to?: string }> | undefined, state: string): number {
  return (stateHistory ?? []).filter((e) => e && e.to === state).length;
}

/** The idempotency key of one entry into a state: `<state>#<entry sequence>`. Scoped to the task row. */
export function actionRunKey(state: string, entry: number): string {
  return `${state}#${entry}`;
}

/** A declared template reference: a name, optionally pinned to one content hash. */
export interface TemplateRef {
  name: string;
  /** The SHA-256 of the body this reference is pinned to. Absent: the active version. */
  version?: string;
}

const TEMPLATE_REF = /^([a-z0-9][a-z0-9-]{0,63})(?:@([0-9a-f]{64}))?$/;

/** A declared reference as its parts, or null when it is not one. */
export function parseTemplateRef(value: unknown): TemplateRef | null {
  if (typeof value !== 'string') return null;
  const m = TEMPLATE_REF.exec(value.trim());
  if (!m) return null;
  return { name: m[1], ...(m[2] ? { version: m[2] } : {}) };
}

/** The declared reference string a turn's loaded templates are keyed by. */
export function templateRefKey(ref: TemplateRef): string {
  return ref.version ? `${ref.name}@${ref.version}` : ref.name;
}

/** The references one state declares, `template` or `templates`, parsed. Empty when it declares none. */
export function templateRefsOfState(def: TaskStateDef | undefined): TemplateRef[] {
  if (!def) return [];
  const raw = def.template !== undefined ? [def.template] : (Array.isArray(def.templates) ? def.templates : []);
  return raw.map(parseTemplateRef).filter((r): r is TemplateRef => r !== null);
}

/** Every template reference a machine declares, once each. What a turn loads before it runs. */
export function templateRefsOfMachine(machine: TaskStateMachine | undefined): TemplateRef[] {
  const seen = new Map<string, TemplateRef>();
  for (const def of Object.values(machine?.states ?? {})) {
    for (const ref of templateRefsOfState(def)) seen.set(templateRefKey(ref), ref);
  }
  return [...seen.values()];
}

/**
 * THE CHOICE A MACHINE OFFERS, when any delivering state declares more than one template (FR3a): the
 * names the person may choose between (every such state's, once each), the declared default, and the
 * step the choice is recorded on, which is the machine's initial state (its requirements step).
 */
export function templateChoiceOf(machine: TaskStateMachine | undefined): {
  names: string[]; defaultName?: string; step: string;
} | null {
  if (!machine) return null;
  const names: string[] = [];
  let defaultName: string | undefined;
  for (const def of Object.values(machine.states)) {
    if (!Array.isArray(def.templates) || def.templates.length < 2) continue;
    for (const ref of templateRefsOfState(def)) if (!names.includes(ref.name)) names.push(ref.name);
    defaultName ??= def.defaultTemplate;
  }
  return names.length ? { names, ...(defaultName ? { defaultName } : {}), step: machine.initial } : null;
}

/** The template choice recorded on a task's details: the sourced entry first, then the plain value map. */
export function recordedTemplateChoice(details: Record<string, unknown> | undefined): string | undefined {
  const sourced = (details?.collectedRequirements as Record<string, { value?: unknown }> | undefined)?.template?.value;
  if (typeof sourced === 'string' && sourced.trim()) return sourced.trim();
  const plain = (details?.requirements as Record<string, unknown> | undefined)?.template;
  return typeof plain === 'string' && plain.trim() ? plain.trim() : undefined;
}

/**
 * WHICH TEMPLATE A DELIVERING STATE USES FOR THIS TASK (FR3, FR3a). `template` names it outright. For
 * `templates`, the recorded choice when it is one of them, else the declared default; a choice nobody
 * made and no default is `choiceRequired`, never a template the runtime or the model picks.
 */
export function resolveStateTemplate(
  machine: TaskStateMachine | undefined,
  state: string | undefined,
  details: Record<string, unknown> | undefined,
): { ref: TemplateRef; chosen: boolean } | { choiceRequired: true; names: string[] } | null {
  const def = state ? machine?.states?.[state] : undefined;
  const refs = templateRefsOfState(def);
  if (!refs.length) return null;
  if (def?.template !== undefined || refs.length === 1) return { ref: refs[0], chosen: false };
  const choice = recordedTemplateChoice(details);
  const picked = choice ? refs.find((r) => r.name === choice) : undefined;
  if (picked) return { ref: picked, chosen: true };
  const fallback = def?.defaultTemplate ? refs.find((r) => r.name === def.defaultTemplate) : undefined;
  if (fallback) return { ref: fallback, chosen: false };
  return { choiceRequired: true, names: refs.map((r) => r.name) };
}

/**
 * WHETHER THE EDGE `from -> to` HANDS OVER A DOCUMENT: the target delivers, or the source delivers and
 * the target ends the task (the deliver-and-finish turn). One reader, used by the tool that requires
 * the document and by the gate that packages it, so the two cannot disagree about which edges deliver.
 */
export function edgeDelivers(machine: TaskStateMachine | undefined, from: string, to: string): boolean {
  if (!machine) return false;
  const target = machine.states[to];
  if (!target) return false;
  if (deliversDocument(target)) return true;
  return deliversDocument(machine.states[from]) && target.transitions.length === 0;
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
 * The tool a turn calls to declare a rewritten document while the task stays in a delivering state.
 * Here beside the advance tool's name, for the same reason: the delivering instructions name it, and
 * they are rendered by a module the tool's own module imports.
 */
export const DELIVER_DOCUMENT_TOOL_NAME = 'deliver_document';

/**
 * THE PLATFORM ACTION THAT GENERATES A STEP'S IMAGE (ADR-064 decision E): run on entering a state that produces an
 * image, its `prompt` bound to a sourced requirement, on the image model of the intent's route, under the image
 * guardrail. Not a registered tool: no model calls it.
 */
export const GENERATE_IMAGE_ACTION = 'generate_image';

/** Whether a state hands over a document (`produces: 'document'`). The one reader of a delivering state. */
export function deliversDocument(def: { produces?: unknown } | undefined): boolean {
  return def?.produces === 'document';
}

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
 * An unrecognized party yields null rather than a guess. Every ingress that can carry one - the
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

/**
 * WHETHER THIS STATE IS THE ASSISTANT'S TO MOVE: declared, not awaiting anybody, and not terminal.
 *
 * A FINISHED TASK IS OWED BY NOBODY. A terminal state has no step left to take, so a message about it
 * is never a second thread on running work. It is about the delivered result or, where the terminal
 * declares `reopens`, the requester asking for changes, and declining that would refuse the person the
 * one thing the reopen exists for.
 *
 * Read from the machine alone, so the router can tell whether the task row is worth reading at all.
 */
export function stepIsTheAssistants(
  machines: Record<string, TaskStateMachine>,
  taskType: string,
  taskState: string,
): boolean {
  const def = machines[taskType]?.states?.[taskState];
  if (!def || awaitedPartyOf(def)) return false;
  return def.transitions.length > 0;
}

/**
 * WHETHER ANY STATE OF THIS MACHINE IS THE ASSISTANT'S TO MOVE. When none is, `assistantOwesTheStep` is
 * false at every state the task could be in, so the router decides without reading the task row.
 */
export function machineHasAssistantStep(machines: Record<string, TaskStateMachine>, taskType: string): boolean {
  return Object.keys(machines[taskType]?.states ?? {}).some((state) => stepIsTheAssistants(machines, taskType, state));
}

/**
 * What a task row records about the turns it has been given. Every field is one the row already carries.
 */
export interface TaskTurnRecord {
  /** The turn that OPENED the task, which the router dispatches to work it in the same turn. */
  correlationId?: string;
  /** Every authorized edge a turn applied (SPEC-TASK-STATE-TRANSITIONS §6). */
  stateHistory?: unknown[];
  /** Turns that ran in the current state and applied no edge (§7). */
  turnsInState?: number;
}

/**
 * HAS ANY TURN BEEN GIVEN THIS TASK? True when a turn opened it (the router records its correlation id
 * and dispatches that turn to work it), when a turn moved it, or when a turn ran on it without moving it.
 * False only for a row no turn has touched: a task written straight to the table (a seed, an import),
 * which is waiting for its first turn rather than owing a step from one.
 */
export function taskHasBeenGivenATurn(record: TaskTurnRecord): boolean {
  return Boolean(record.correlationId)
    || (record.stateHistory?.length ?? 0) > 0
    || (record.turnsInState ?? 0) > 0;
}

/**
 * WHETHER THE ASSISTANT ALREADY OWES THE NEXT STEP ON THIS TASK, so a message about it must not start a
 * second turn (one thread per piece of work, router-agent-handler.ts).
 *
 * Owed when the state is the assistant's to move (`stepIsTheAssistants`) AND a turn has been given the
 * task (`taskHasBeenGivenATurn`). The second half is a fact about the TASK, never about where its state
 * sits in the graph: a task opened at `place_item.collecting` with no turn ever dispatched for it read as
 * owed, and every message was declined with "I'm still working on that" while nothing was (2026-10-16).
 * Exempting the initial STATE instead let a follow-up start a second turn beside the opening turn that
 * was still running there (`action_item.gathering`), and dropped the guard for a machine that re-enters
 * its initial state.
 *
 * `record` is the task row, or null when it could not be read. Null holds the rule: a step owed and
 * declined costs a `/stop`, and a second turn on running work costs the work twice.
 *
 * The platform's own machines keep the rule at every state whatever the row says: a `queue_drain` at
 * `waiting` is the queue holding the room, and a message then must not start a turn.
 *
 * With the turn queue enabled (ADR-033) a message arriving while ANY turn holds the conversation is
 * queued by the claim that follows this decision, so the lock, not this rule, is what serializes a
 * running turn there. This rule is what holds when the queue is off, and what declines a message about
 * a task whose turn has ended without moving it on.
 */
export function assistantOwesTheStep(
  machines: Record<string, TaskStateMachine>,
  taskType: string,
  taskState: string,
  record: TaskTurnRecord | null,
): boolean {
  if (!stepIsTheAssistants(machines, taskType, taskState)) return false;
  if ((PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(taskType)) return true;
  return record === null || taskHasBeenGivenATurn(record);
}

export interface TaskStateMachine {
  /** The state a freshly created task of this type starts in. Must be a declared state. */
  initial: string;
  states: Record<string, TaskStateDef>;
}

/** Thrown by validation when a machine is malformed; carries the machine name for a loud hydrate failure (§4). */
export class TaskMachineValidationError extends Error {
  // A plain field rather than a parameter property, so the module also compiles where only erasable syntax is allowed
  // (the admin console reads the machines for its task step editor).
  public readonly machineName: string;
  constructor(machineName: string, message: string) {
    super(`TaskStateMachine "${machineName}": ${message}`);
    this.machineName = machineName;
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
 * property of the deploying organization; the missing DISTINCTION in the record is not, and a
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
 *  - report_generation: `completed` declares `reopens: ['revising']`, so a change asked for after
 *    delivery returns the finished report to `revising`, which re-delivers and completes again.
 *
 * WHERE EACH MACHINE RESTS ON THE PERSON. Three of them name their wait in a state of its own -
 * `awaiting_result`, `confirming`, `options_presented`/`awaiting_completion` - so the state that
 * produces the thing being waited on (`proposing_solutions`, `collecting`, `gathering`) is passed
 * through within the turn and awaits nobody. The other two have no such state: `drafting_outline`
 * exits only to `generating` and `validating` only to `formatting`, both of which are the assistant
 * working, so in those two machines the producing state IS the wait and carries `awaits` itself.
 */
/**
 * THE MACHINES THAT ARE THE PLATFORM'S OWN, not examples (SPEC-TASK-STATE-TRANSITIONS, "Two kinds of
 * shipped machine, and only one of them is an example").
 *
 * `queue_drain` and the `queued_*` graphs ARE how the turn queue works (ADR-033) rather than
 * illustrations of how one might: code depends on their states by name, the drain's stage is written
 * from `queue_drain`, and the queue opens the others directly. Replacing one does not customize the
 * queue, it breaks it - and neither does REMOVING one, which is why this list exists.
 *
 * An assistant's workflow selection narrows the reference workflows and never these. Without that
 * distinction a selection of `['report_generation']` would quietly strip the queue machinery from the
 * assistant that made it, and the queue would stop working for a reason nobody would connect to a
 * workflow list.
 */
export const PLATFORM_TASK_MACHINE_KEYS = [
  'queue_drain',
  'queued_request',
  'queued_clarification',
  'queued_combination',
  'work_still_wanted',
] as const;

/** The platform's report template (`lib/config/default-templates/report.md`), which `report_generation` delivers in. */
export const REPORT_TEMPLATE = 'report';

export const DEFAULT_TASK_STATE_MACHINES: Record<string, TaskStateMachine> = {
  /**
   * WORKING A QUEUE IS A WORKFLOW, AND SINCE 2026-09-03 IT IS A TASK (ADR-033).
   *
   * It has states, legal moves between them, a step that awaits a person, and a point at which it is
   * over. That is what every machine here describes, so the drain was always declared in this shape -
   * it simply kept its state on the turn record and declined the task ROW.
   *
   * The row is now taken. Both grounds for declining it stopped being true: a drain is no longer a
   * phase of one turn (a handover chain spans up to TRIAGE_MAX_PASSES of them), and it does not land
   * in a person's open work by default because it is the ASSISTANT'S work and the mirror is
   * partitioned by owner. It reaches a person only at `clarifying`, which is the moment the proposal
   * is asking them something.
   *
   * What that buys is everything a task already has and the queue had grown a bespoke half of: an
   * owner so state and responsibility cannot disagree, stall supervision, an operator who can see and
   * stop one, and resolution timing that separates the assistant's work from human think time.
   *
   * ONE DRAIN PER QUEUE, NOT PER PASS (maintainer, 2026-09-03). A chain of readings is ONE reading that
   * took more than one turn, so the task's identity has to survive the handover - carried on the turn
   * record rather than derived from a correlation id, which changes per link.
   *
   * DECLARED EDGES RATHER THAN AN ORDERING, and the difference is not cosmetic. An ordering says only
   * "later than", which permits a drain to jump straight from waiting to settled and call it
   * progress. The edges say which moves actually exist: a queue reaches `clearing` from a reading or
   * from a conversation, and reaches `settled` only from `clearing`.
   */
  // EVERY STATE OF THE DRAIN RESTS (ADR-063 decision 5): the queue's own reading drives it, never an idle pickup.
  queue_drain: {
    initial: 'waiting',
    states: {
      // Nothing has looked at it yet. It can be read, or the whole turn can be stopped.
      waiting: { transitions: ['reviewing', 'settled'], rests: true },
      // Read. Three ways on: something to put to the person, private requests to take up one to one,
      // or neither and it just clears.
      //
      // `addressing_private` DIRECT FROM HERE, and its absence was FR7's outstanding half. That step
      // is shown whenever the queue held targeted requests, but it was reachable only from
      // `clarifying` - so a queue of purely private messages, with nothing needing an answer, showed
      // no stage at all: the conditional advance refused an edge the machine did not declare, and the
      // room saw the drain skip from reading straight to done while the private half was still being
      // written. The messages were always delivered; the stage was what went missing.
      reviewing: { transitions: ['clarifying', 'addressing_private', 'clearing'], rests: true },
      // Put to them - AND THE DRAIN DOES NOT WAIT FOR THE ANSWER (maintainer, 2026-09-03).
      //
      // This is the one state in this machine with no `awaits`, deliberately, and it declared one
      // until the rule was stated: a drain must never depend on a human, because a queue that lives
      // until somebody answers lives too long. The messages behind it are read, recorded and cleared
      // on the assistant's own timescale; only the follow-up is on the person's.
      //
      // Nothing is lost by not waiting, because the wait already has a home. Every queued message
      // that becomes work opens a `queued_request`, whose INITIAL state `proposed` awaits the
      // requester - so the question is recorded, owned, visible in their list and answerable at their
      // pace, on the task that is actually about it. The drain asking and ALSO holding was the same
      // wait kept in two places, and the drain's copy is the one with a queue attached to it.
      //
      // It also could not be made coherent. A drain that hands over here is closed the moment the
      // queue empties, which is the same turn - so it was handed to somebody and taken back before
      // they could see it.
      clarifying: { transitions: ['addressing_private', 'clearing'], rests: true },
      // Each person taken up with separately. Always followed by the clear.
      addressing_private: { transitions: ['clearing'], rests: true },
      clearing: { transitions: ['settled'], rests: true },
      settled: { transitions: [], terminal: 'success' },
    },
  },
  // AN IMAGE, ASKED FOR, CONFIRMED WHERE THE REQUEST IS INCOMPLETE, DRAWN AND REVISED (ADR-064 decisions E and G). The
  // text steps run on a text model (the message's intent, or a step override); `generate` is the platform's act on entry,
  // on the image model of the `image_generation` route, with its prompt the recorded brief rather than the raw message.
  // `confirm` is presented `when-incomplete`: a request that already carries the complete brief (`brief`) goes from
  // `gather` straight to `generate` in its own turn, and any other request is confirmed before a billable image is drawn.
  // A drawn image finishes the task, and a change the person asks for reopens it into `revise`, as a delivered report does.
  image_generation: {
    initial: 'gather',
    states: {
      gather: {
        transitions: ['confirm', 'generate'],
        awaits: { party: 'requester' },
        requires: ['what to draw'],
        label: 'Gathering the brief',
        prompt: `Find out what the person wants drawn: the subject, the style and the composition, and anything it must or must not show.
- Record what you have as the requirement "what to draw" (a self-contained description an image model can draw from), beside each part of the brief you were given.
- Ask for what is missing, or advance to \`confirm\` to put the brief to the person.
- Do not describe or promise an image yet.`,
      },
      confirm: {
        transitions: ['generate', 'gather'],
        awaits: { party: 'requester' },
        presented: true,
        confirm: 'when-incomplete',
        brief: ['the subject', 'the style', 'the composition'],
        resolvedByOneResponse: true,
        label: 'Confirming the brief',
        prompt: `Say back, in one or two sentences, the image you are about to make and ask the person to confirm it.
- They confirm => advance_task_state to \`generate\`; the platform draws the image in this turn.
- They correct it => record the corrected "what to draw" and advance to \`gather\`, or stay and confirm again.`,
      },
      generate: {
        transitions: ['done', 'failed'],
        produces: 'image',
        action: { tool: GENERATE_IMAGE_ACTION, args: { prompt: 'requirement:what to draw' } },
        onSuccess: 'done',
        onFailure: 'failed',
        label: 'Drawing',
        placeholder: 'Drawing the image...',
      },
      revise: {
        transitions: ['generate', 'done'],
        awaits: { party: 'requester' },
        label: 'Revising the image',
        prompt: `The person asked for a change to the image they were given.
- Record the revised "what to draw" (the whole brief with the change applied) and advance to \`generate\`; the platform draws it again in this turn.
- They are happy after all => advance to \`done\`.`,
      },
      done: {
        transitions: [],
        terminal: 'success',
        reopens: ['revise'],
        prompt: `The image is delivered. On the turn that drew it, say in one sentence what it shows and that the person can ask for a change.
A change the person asks for later reopens the task into \`revise\`.`,
      },
      failed: {
        transitions: [],
        terminal: 'failure',
        prompt: 'The image could not be generated. Say so plainly, with the reason recorded on the step, and offer to try again.',
      },
    },
  },
  guided_troubleshooting: {
    initial: 'collecting_symptoms',
    states: {
      collecting_symptoms: {
        transitions: ['diagnosing'],
        awaits: { party: 'requester' },
        requires: ['what is going wrong', 'when it started', 'what they have already tried'],
        presented: true,
        prompt: `Ask the user to describe the problem in detail. Gather:
- What exactly is happening (error messages, unexpected behavior)
- When it started happening
- What changed recently
- Steps to reproduce
If they have already given all of it, say back what you have and ask them to confirm or add to it
before you diagnose.
Do NOT propose solutions yet. Focus on understanding the problem.`,
      },
      diagnosing: {
        transitions: ['proposing_solutions', 'collecting_symptoms'], // regression: need more info
        prompt: `Based on the symptoms collected, analyze the problem:
- Identify likely root causes
- Ask targeted follow-up questions if needed
- Narrow down the possibilities`,
      },
      proposing_solutions: {
        transitions: ['awaiting_result'],
        prompt: `Present 2-3 possible solutions ranked by likelihood:
- Start with the most likely fix
- Provide step-by-step instructions for each
- Ask the user to try the first solution and report back`,
      },
      // Worked / didn't / give up. No `requires`: the outcome IS the answer, and asking someone to
      // elaborate on "that fixed it" is the assistant not listening in the other direction.
      awaiting_result: {
        transitions: ['resolved', 'diagnosing', 'escalated'],
        awaits: { party: 'requester' },
        prompt: `The user is trying a proposed solution. Based on their feedback:
- If it worked: congratulate and ask if they need anything else
- If it didn't: suggest the next solution or ask for more details`,
      },
      resolved: { transitions: [], terminal: 'success' },
      escalated: { transitions: [], terminal: 'handoff' },
    },
  },
  /**
   * THE FIRST LOOK AT AN INCIDENT (ADR-061 decision 8, example (a)): the task an `agent` step opens when an event opens an
   * ops room (`EVENT_TASK_MACHINES`). Nobody asked for it, so no step awaits a requester: the turn that opened it runs
   * `reading_health`, the runtime takes its one transition once that turn posted, and the task rests on
   * `findings_shared` as the room's work, where anyone in the room may ask for another read or say it is resolved.
   */
  incident_first_look: {
    initial: 'reading_health',
    states: {
      reading_health: {
        transitions: ['findings_shared'],
        tools: ['read_deployment_health'],
        prompt: `This is the first step of the incident's first look. Read the deployment's health with read_deployment_health and report:
- Which alarms are firing or recently changed state, and what each points at
- The one thing worth checking first
Say plainly when the read shows nothing wrong or could not be made. Do not guess at causes the data does not show.`,
      },
      // RESTS: the first look is in the room, and the next read is asked for, never taken up by itself.
      findings_shared: {
        rests: true,
        transitions: ['reading_health', 'resolved'],
        prompt: `Your first look is in the room. When someone asks for another read, or the situation changes, read the health again
(reading_health). When the room says the incident is over, advance to resolved.`,
      },
      resolved: { transitions: [], terminal: 'success' },
    },
  },
  // THE STEPS HOLD. Requirements are put to the person before anything is pulled (`presented` on
  // `collecting_requirements`), the records are shown in the conversation for the person to check at
  // `validating`, and only `formatting` hands over a file. Measured live: one model call took a first
  // message straight to `extracting`, which delivered, and the greeting, the narration and an
  // apology about files were packaged as the table.
  data_extraction: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: {
        transitions: ['extracting'],
        awaits: { party: 'requester' },
        requires: ['what data to pull', 'where it comes from', 'the output format'],
        presented: true,
        prompt: `Work out what the person needs before pulling anything:
- What data to pull: the records, fields and any filters or conditions.
- Where it comes from: a source they named, or a passage you retrieved this turn. Never assume one.
- The output format they want.
If any of it is missing, ask for only that. If all of it is there, list what you are taking for each
and where it came from (their words, or the named source), and ask them to confirm or correct it.
Their reply is what starts the extraction.`,
      },
      // THE WORK, NOT THE HAND-OVER. Nothing is delivered from here: the records go to the person to
      // check at `validating`, and only `formatting` produces the file. A table packaged before the
      // person has looked at it is a deliverable nobody agreed to.
      extracting: {
        transitions: ['validating', 'collecting_requirements'], // regression: requirements were wrong
        prompt: `Pull the records the agreed requirements describe, from the agreed source:
- Include every matching record, not a sample.
- When you have them, advance to \`validating\` and show them to the person in your reply for checking.`,
      },
      // THE EXTRACTION IS PUT TO THE PERSON TO CHECK, so the person holds it. The step's whole job is
      // "do these records look right?", and the only way out of it is `formatting`, which is work the
      // assistant does once they have said. There is no separate waiting state to hold that pause, so
      // it rests here - the same shape as `drafting_outline` below, and it is left off for the same
      // reason it was left off there.
      //
      // IT PRESENTS AND DOES NOT DELIVER. The records are shown in the conversation for the person to
      // check, and a state that awaits somebody cannot deliver (`validateTaskStateMachine`). `presented`
      // holds it until they have answered, so the turn that extracted cannot also format and ship.
      //
      // No `resolvedByOneResponse`: "row 3 is wrong" is a reply and is not an approval, and one exit
      // plus any reply is exactly what would format and deliver the wrong table.
      validating: {
        transitions: ['formatting'],
        awaits: { party: 'requester' },
        presented: true,
        prompt: `Show the extracted records in your reply so the person can check them:
- Present them as a **markdown table** (one row per record, a column per field) when the data is
  tabular; use a titled list only when it genuinely is not.
- Point out anything incomplete, anomalous or missing.
- Ask them to confirm the records are right, or say what to change. Nothing is formatted or delivered
  until they have answered.`,
      },
      // The one delivering state: the validated records, formatted as the file.
      formatting: {
        transitions: ['completed'],
        produces: 'document',
        prompt: `Produce the validated records as the deliverable:
- Default to a clean **markdown table** for tabular data, under a short title heading; apply the
  format the person asked for if they named one.
- Add any requested calculations or transformations (totals, sorting, derived columns).
- The complete result is the \`document\` you declare; your reply to the person is a short note beside it.`,
      },
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
        presented: true,
        prompt: `Understand what report the user needs:
- Report topic and purpose
- Target audience
- Key metrics or data points to include
- Desired format and length
- Any specific sections or structure
If any of the subject, audience or length is missing, ask for only that. If all of it is there, list
what you are taking for each and where it came from (their words, or the named source), and ask them
to confirm or correct it before you outline anything.`,
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
        presented: true,
        prompt: `Present a report outline for approval:
- List proposed sections with brief descriptions
- Note key data/metrics for each section
- Ask if the user wants to adjust the structure`,
      },
      // Deliver the report on generation: generating -> completed is the DEFAULT path. A generated
      // report is a finished deliverable; the user is never forced to run a revision pass. `revising`
      // is entered ONLY when the user explicitly asks for changes: before delivery by generating ->
      // revising, and after delivery, the usual case, by the declared reopen completed -> revising.
      // Either way it applies the change and re-delivers via revising -> completed, or regenerates.
      //
      // DELIVERING IS NOT CLOSING, and the step's prompt says so. Told to mark the task done when the
      // report is presented and then to advance to `revising` if the person later asked for changes,
      // the model was given a second instruction it could not reach, because `completed` is terminal.
      // Measured live: a person who said "keep the task open for review" got the report AND a closed task.
      //
      // EVERY REPORT FOLLOWS A TEMPLATE (SPEC-DOCUMENT-TEMPLATES FR3). Both delivering states declare the
      // platform's `report` template, which each classification serving this workflow receives at deploy
      // (`lib/config/default-templates.ts`). A deployment replaces it by activating its own version of
      // `report`, or offers a choice by redeclaring this machine in its pack with `templates` and
      // `defaultTemplate` on these two states.
      generating: {
        transitions: ['completed', 'revising'],
        produces: 'document',
        template: REPORT_TEMPLATE,
        prompt: `Generate the full report and DELIVER it as the \`document\` you declare:
- Write the approved outline's content inside the document template's sections, in its order; include relevant data and analysis.
- Delivering is NOT closing. Do not advance the task just because you presented the report - the person has it, and has not yet said whether it stands.
- They ask for CHANGES => advance_task_state to \`revising\`, with the complete revised report as \`document\`.
- They say it is right, or that they are done => advance_task_state to \`completed\`.
- A delivered report is closed as \`completed\`, and a change the person asks for afterwards reopens it into \`revising\`.`,
      },
      // Apply the requested changes -> deliver, or regenerate.
      revising: {
        transitions: ['completed', 'generating'],
        produces: 'document',
        template: REPORT_TEMPLATE,
        prompt: `The user asked for changes to a report you already delivered. Apply them:
- Make the requested changes and declare the complete revised report as the \`document\`; your reply says briefly what you modified.
- Stay in \`revising\` while they keep asking for changes - re-delivering is not closing here either.
- Advance to \`completed\` only when they say it is right. A change asked for after that reopens it into \`revising\` again.`,
      },
      // A REPORT IS REVISABLE. Delivery closes the task, so a change is almost
      // always asked for after `completed`. The state stays terminal, so a delivered report is not open
      // work, and the requester's change request reopens it into `revising`. Its prompt covers a
      // follow-up turn in the same conversation: a change request takes the declared reopen, and anything
      // else is answered about the delivered report without moving the task.
      completed: {
        transitions: [],
        terminal: 'success',
        reopens: ['revising'],
        prompt: `The report is finished and was delivered in this conversation.
- If the person asks for CHANGES to it, advance_task_state to \`revising\` with the complete revised report as \`document\`, and say briefly in your reply what changed.
- If they ask about the delivered report or where it is, or say thanks, answer without calling the tool.`,
      },
    },
  },
  // A COMPLETE CODE DELIVERABLE (the `code_delivery` intent). Agreed before it is written, then
  // delivered as a file named by its language. The same shape as report_generation without an outline
  // step: code is agreed by what it must do, and the code is the draft.
  code_delivery: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: {
        transitions: ['generating'],
        awaits: { party: 'requester' },
        requires: ['the language and runtime', 'what it must do', 'where it will run or plug in'],
        presented: true,
        prompt: 'Ask for anything still missing from the language and runtime, what the code must do, and where it will run. When you have all three, restate what you will build in two or three lines, saying where each part came from (their words, or the named source), and ask them to confirm or correct it before writing.',
      },
      generating: {
        transitions: ['completed', 'revising'],
        produces: 'document',
        prompt: 'The code is the `document` you declare: the complete code in one fenced block with the language named, including everything needed to run it. Your reply is a short note to the person beside it. Do not say how it is delivered: the platform attaches the declared document as a file.',
      },
      revising: {
        transitions: ['completed', 'generating'],
        produces: 'document',
        prompt: 'Apply the requested changes and declare the complete revised code, in one fenced block, as the `document`. Your reply says briefly what changed.',
      },
      completed: { transitions: [], terminal: 'success' },
    },
  },
  // A TECHNICAL OR SOLUTION DESIGN (the `technical_design` intent): requirements, then an outline the
  // person approves, then the document. The same shape as report_generation.
  technical_design: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: {
        transitions: ['drafting_outline'],
        awaits: { party: 'requester' },
        requires: ['the goal', 'the constraints', 'the audience'],
        presented: true,
        prompt: 'Ask for anything still missing from the goal, the constraints and the audience. When you have all three, list what you are taking for each and where it came from (their words, or the named source), and ask them to confirm or correct it. Do not start the design yet.',
      },
      drafting_outline: {
        transitions: ['generating'],
        awaits: { party: 'requester' },
        requires: ['approval of the outline, or what to change about it'],
        presented: true,
        prompt: 'Propose an outline under the headings Problem, Proposed design, Alternatives and Risks, one or two lines each, and ask whether it works.',
      },
      generating: {
        transitions: ['completed', 'revising'],
        produces: 'document',
        prompt: 'The design is the `document` you declare: the full design under the agreed outline, written for a reader outside this conversation. Your reply is a short note to the person beside it. Do not say how it is delivered: the platform attaches the declared document.',
      },
      revising: {
        transitions: ['completed', 'generating'],
        produces: 'document',
        prompt: 'Apply the requested changes and declare the complete revised design as the `document`. Your reply says briefly what changed.',
      },
      completed: { transitions: [], terminal: 'success' },
    },
  },
  // place_item advances on the propose_item tool's success side-effect (collecting -> confirming),
  // not a prose keyword or an in-band marker.
  //
  // `placed` RECORDS THE APPROVAL, not the host apply (maintainer decision 2026-08-19). The comment here
  // used to call it the apply landing, with the task resting in `confirming` until the apply arrived,
  // and that described a system this is not: nothing outside a model turn can move a machine
  // (`advance_task_state` is callable only inside the tool loop, and the reply path keys on a message
  // arriving in the conversation), there is no host endpoint, and no return path. On that reading NO
  // task could ever reach `placed` and every place-item task would sit in `confirming` until its TTL.
  // The runtime already behaves as this comment now says - the `placed` prompt tells the model the
  // item has been added - so the comment was the only thing out of step.
  //
  // A state meaning "the host actually applied it" is DEFERRED, and it waits on an out-of-band
  // advance rather than on a state name. SPEC-TASK-STATE-TRANSITIONS sets its two conditions: a
  // runtime advancer needs a state DECLARING that it expects one, or it is the unbounded second
  // writer the one-writer rule exists to prevent; and the advance is an AUTHORIZATION decision,
  // because a submitter arriving on an API call has no sender to infer a party from and has to be
  // checked against the party the step awaits.
  place_item: {
    initial: 'collecting',
    states: {
      collecting: {
        transitions: ['confirming'],
        prompt: `The user wants to ADD a work item to this plan (see their message + the work items above). Before you
propose the add, make sure you know WHERE it goes:
- Where in the order it lands (after which existing item), and any start/due date.
- Briefly, what it involves - capture it as the item's notes.
If the position or detail is unclear, ask ONE short question (offer your best suggestion). Once you
know the detail + position, PROPOSE the add with the add_item tool, setting \`afterItemId\` so it lands
where it belongs (not appended blindly at the bottom).`,
      },
      // The confirmation IS the step: one clear "yes" completes it, and the assistant is told to take
      // that answer rather than ask again. It does NOT mean any reply completes it - a correction
      // ("make it 45 minutes") and a decline ("do not add it") arrive at this same step, and `placed`
      // is a SUCCESS terminal that would record them as approvals.
      //
      // A CONFIRMATION IS COMPLETED BY ADVANCING, NOT BY PROPOSING AGAIN, so the prompt names which act
      // completes the step. Told only to "acknowledge briefly", measured live, "Yes, that is right - go
      // ahead and add it" was answered by calling the propose tool a second time: the person saw the
      // identical proposal card again and the machine never left `confirming`.
      confirming: {
        transitions: ['placed'],
        awaits: { party: 'requester' },
        resolvedByOneResponse: true,
        prompt: `You've proposed the add; the person reviews it on the card. The proposal is already on the table, so
your job now is to record their decision, not to make it again:
- They AGREE ("yes", "go ahead", "that is right") => call advance_task_state to \`placed\`, then say
  briefly what was agreed and where it lands. Do NOT call add_item again - that re-proposes, shows
  them the same card twice, and records no decision.
- They want a DIFFERENT position or detail => propose the corrected add_item and wait. Do not advance.
- They DECLINE => do not advance, and do not say it went ahead. Acknowledge it and ask what they would
  like instead.`,
      },
      placed: {
        transitions: [],
        terminal: 'success',
        prompt: 'The item has been added. Offer a sensible next step (assign it, set a date, or add a related item).',
      },
    },
  },
  /**
   * WORK THAT ARRIVED WHILE THE ASSISTANT WAS BUSY (ADR-033).
   *
   * Triage turns each queued message into one of these, and the person's answer to the proposal moves
   * it. That is the whole reason it exists as a machine rather than as a flag: the PAUSE this design
   * needs is not a new mechanism, it is a task whose first state awaits the person. Everything that
   * already knows "a task awaiting the requester means their next message is the awaited input, not an
   * interruption" therefore covers the proposal for free.
   *
   * `proposed` is where triage leaves it: the work is named and visible as an open item, and nothing
   * has started. The answer either accepts it or drops it.
   *
   * DROPPING IS A FIRST-CLASS ENDING, not a failure and not a completion. A person who says "no, skip
   * that" has decided something, and recording it as `failed` would put a fault in the record where
   * there was a choice, while `completed` would claim work that never happened. It carries `handoff`
   * for the same reason `escalated` does: the ending is real, and it is not the assistant's own.
   */
  /**
   * A QUEUED MESSAGE WHOSE REQUEST THE READING COULD NOT MAKE OUT (maintainer, 2026-09-03).
   *
   * The placeholder. Its whole point is that it claims NOTHING about what the work is: the message is
   * held safely, the assistant says it could not tell what was being asked, and one answer turns it
   * into real work.
   *
   * IT IS NOT A `queued_request`, and filing it as one is the over-claim this exists to stop. That
   * machine starts at `proposed`, which means "here is the work I propose to do" - so a message
   * nobody understood produced a confident proposal, labeled with a slice of the person's own words
   * read back to them. They then have to notice it is wrong, and until they do, a task nobody can act
   * on sits in their list looking like agreed work.
   *
   * `asked` awaits the requester, like every other pause in this design. The answer either DEFINES
   * the work - at which point the real `queued_request` is what carries it, and this is `answered`,
   * having done its job - or drops it, which is a decision and not a failure.
   */
  /**
   * TWO PEOPLE ASKED FOR WHAT LOOKS LIKE ONE THING (maintainer, 2026-09-03).
   *
   * A queue is not one person's. When the reading groups messages from DIFFERENT senders under one
   * subject, that is the moment two requests might really be one - and merging them is not triage's
   * call to make. DESIGN 2.4.1 said so from the start and only half of it was built: the runtime
   * refused to combine, and nothing ever PROPOSED it, so the answer was always "separate" by default
   * and nobody was asked.
   *
   * THE ORDER IS IN THE MACHINE, NOT IN THE CODE THAT DRIVES IT. Asking, being answered, doing the
   * thing the answer decided, and being over are four different states, and the middle one is what
   * makes this more than a question: reaching `merging` is what the runtime acts on. A machine whose
   * terminal state is the answer records that somebody replied; a machine with a step for the WORK
   * records that something happened because they did.
   *
   * WHO IS ASKED, and it is one person rather than the room. The requestors are candidates for owning
   * the merged item, so the question goes to the sender of the earliest message in the group - the
   * one whose request the others arrived alongside. Their answer names the owner, which may be
   * somebody else; `ownerId` on the merged task is what settles it, and the answer is what settles
   * `ownerId`.
   *
   * BOTH ENDINGS ARE REAL. "Keep them separate" is a decision about how the work is organized, not a
   * refusal and not a failure - the same judgement `queued_request` makes about being dropped.
   */
  queued_combination: {
    initial: 'asked',
    states: {
      // Put to the person whose request the others arrived alongside.
      asked: { transitions: ['merging', 'separate'], awaits: { party: 'requester' } },
      // They said combine. This is the step the runtime ACTS on: one work item is opened covering
      // the group, owned by whoever the answer named. Declared as a state rather than done silently
      // inside the transition, so a merge that failed is visible as a task stuck here.
      merging: { transitions: ['merged'] },
      merged: { transitions: [], terminal: 'success' },
      // They said keep them apart, and the separate items already exist. Nothing further to do.
      separate: { transitions: [], terminal: 'success' },
    },
  },

  queued_clarification: {
    initial: 'asked',
    states: {
      asked: { transitions: ['answered', 'dropped'], awaits: { party: 'requester' } },
      answered: { transitions: [], terminal: 'success' },
      dropped: { transitions: [], terminal: 'handoff' },
    },
  },

  /**
   * IS THE WORK ALREADY RUNNING STILL WANTED (ADR-033, owner 2026-09-03).
   *
   * When a reading cannot tell whether the turn it is queued behind is still wanted, it asks. That
   * question used to exist ONLY as a sentence in the proposal and a stage on the notice - nothing
   * held it, nothing owned it, and nobody's list showed it. It was survivable while the drain waited
   * at `clarifying`, because the drain itself was the holder. Once a drain stopped waiting (a queue
   * that lives until somebody answers lives too long), the question was left held by nothing at all:
   * asked once, in a message, and forgotten by the system the moment the queue cleared.
   *
   * So it becomes what every other pause in this design is - a task whose first state awaits the
   * person - and for the reason `queued_request` gives: the pause is not a new mechanism.
   *
   * A SEPARATE TYPE FROM `queued_request`, though the shape is identical, because the SUBJECT is the
   * opposite. A queued request is work that ARRIVED while the assistant was busy; this is the work
   * that was already running. Filing it as a queued request would put a row in somebody's list
   * claiming a message was queued when none was, title it wrongly (the type is what a person reads
   * when there is no excerpt), and make every count of queued work wrong.
   *
   * KEPT AND DROPPED ARE BOTH REAL ENDINGS, the same judgement `queued_request` makes: a person who
   * says "drop it" has decided something, and recording that as a failure would put a fault in the
   * record where there was a choice.
   */
  work_still_wanted: {
    initial: 'asked',
    states: {
      asked: { transitions: ['kept', 'dropped'], awaits: { party: 'requester' } },
      kept: { transitions: [], terminal: 'success' },
      dropped: { transitions: [], terminal: 'handoff' },
    },
  },

  /**
   * A DECISION SOMEBODY MAKES (ADR-063 decision 1), the reference machine a workflow's task step opens to ask its worker to
   * approve or decline. Both endings are `success`: the task was decided either way, and the run branches on which
   * (`task:state` on the step's edges). The choices are offered on the task card, and the worker may also answer by writing.
   */
  approval: {
    initial: 'deciding',
    states: {
      deciding: {
        transitions: ['approved', 'declined'],
        awaits: { party: 'worker' },
        choices: ['approved', 'declined'],
        resolvedByOneResponse: true,
        prompt: `This task asks for a decision: approve or decline. When the person you are waiting on says which, advance to approved or declined. If their reply is not a clear decision, ask for one.`,
      },
      approved: { transitions: [], terminal: 'success' },
      declined: { transitions: [], terminal: 'success' },
    },
  },
  /**
   * SOMETHING SOMEBODY CONFIRMS THEY HAVE SEEN (ADR-063 decision 1): one choice, offered on the task card.
   */
  acknowledgement: {
    initial: 'asked',
    states: {
      asked: {
        transitions: ['acknowledged'],
        awaits: { party: 'worker' },
        choices: ['acknowledged'],
        resolvedByOneResponse: true,
        prompt: `This task asks the person you are waiting on to acknowledge it. When they do, advance to acknowledged.`,
      },
      acknowledged: { transitions: [], terminal: 'success' },
    },
  },

  queued_request: {
    initial: 'proposed',
    states: {
      proposed: { transitions: ['accepted', 'dropped'], awaits: { party: 'requester' } },
      accepted: { transitions: ['completed', 'dropped'] },
      completed: { transitions: [], terminal: 'success' },
      dropped: { transitions: [], terminal: 'handoff' },
    },
  },

  // A tracked, assignable real-world action. The assistant never completes it in-app: it gathers the
  // details, presents options and concrete steps or deep-links, and the participant completes it
  // off-platform. On a shared plan it confirms WHO owns the action; a due-by date is captured when it
  // matters.
  action_item: {
    initial: 'gathering',
    states: {
      gathering: {
        transitions: ['options_presented'],
        prompt: `Help the participant lock in a real action. First confirm:
- WHAT: the action and which work item it's for.
- WHEN: the date/time, and any **due-by deadline** (lead time / it can't wait) - note it.
- WHO: on a SHARED plan (see the participants above), ask who's responsible for it; otherwise it's
  the person you're talking to.
Then present concrete options + the exact steps or a deep-link. You CANNOT complete it in-app -
everything is "to confirm on the operator's site".`,
      },
      // The options are ON THE TABLE and the person has to pick; then the work itself is theirs to do.
      options_presented: {
        transitions: ['awaiting_completion'],
        awaits: { party: 'requester' },
        prompt: `Help them choose, then give the precise steps / deep-link. Be explicit that it's completed on the
operator's site, not here. Capture the due-by deadline if you haven't.`,
      },
      awaiting_completion: {
        transitions: ['completed'],
        awaits: { party: 'requester' },
        prompt: `They're completing it off-platform. When they say it's done, acknowledge it and offer to record the
confirmation / details onto the work item (update_item).`,
      },
      completed: {
        transitions: [],
        terminal: 'success',
        prompt: "Done. Confirm what's locked in and suggest the next open item.",
      },
    },
  },
};

/**
 * Validate one machine (§4 hydrate checks). Throws TaskMachineValidationError on the first problem:
 *  - the initial state is declared;
 *  - every transition target is a declared state;
 *  - a state is terminal (terminal set) iff it has no transitions;
 *  - at least one terminal state exists;
 *  - `reopens` appears only on a terminal state, and every reopen target is a declared non-terminal
 *    state of the same machine;
 *  - every state is reachable from initial (no orphan states). Reachability follows ordinary
 *    transitions only: a reopen returns to a state the machine already reaches;
 *  - a state that awaits somebody does not deliver, and a `presented` state awaits somebody;
 *  - a state's `tools` are registered tool names (FR28);
 *  - a state's `action` names a tool the platform can run, binds its arguments to something the
 *    workflow records, awaits nobody, and declares `onSuccess` and `onFailure` (or a transition into a
 *    terminal `failure` state) among its transitions (FR29).
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
    // A STEP THAT WAITS ON SOMEBODY IS PUTTING SOMETHING TO THEM, and a step that delivers is handing
    // over a finished document written for a reader outside the conversation. One state cannot be both:
    // the reply would have to ask the person something and be the file, and a delivered extraction once
    // shipped carrying its own "let me know if you'd like" for exactly that reason. Keyed on the
    // normalizer, so the deprecated `awaitsUser` form is held to it too.
    // THE RETIRED FIELD IS REFUSED, naming the one that replaced it, so the two never coexist (ADR-064 decision 2).
    if ((def as { delivers?: unknown }).delivers !== undefined) {
      throw new TaskMachineValidationError(name, `state "${state}" declares delivers, which is retired; declare produces: 'document'`);
    }
    if (def.produces !== undefined && def.produces !== 'text' && def.produces !== 'image' && def.produces !== 'document') {
      throw new TaskMachineValidationError(name, `state "${state}" declares produces "${String(def.produces)}"; a step produces text, image or document`);
    }
    // AN IMAGE IS THE PLATFORM'S ACT on entering the step (ADR-064 decision E), so a step producing one declares the
    // action, and only such a step declares it.
    if ((def.produces === 'image') !== (def.action?.tool === GENERATE_IMAGE_ACTION)) {
      throw new TaskMachineValidationError(name, `state "${state}" ${def.produces === 'image' ? 'produces an image, so it declares the action generate_image' : 'declares the action generate_image, so it produces: image'}`);
    }
    if ((deliversDocument(def) || def.produces === 'image') && awaitedPartyOf(def)) {
      throw new TaskMachineValidationError(
        name,
        `state "${state}" awaits somebody, so it cannot also deliver`,
      );
    }
    // A PRESENTED STEP IS PUT TO SOMEBODY, and their reply is what moves it on. On a state that awaits
    // nobody there is no reply to wait for, so the declaration would hold the task with no way out.
    if (def.presented && !awaitedPartyOf(def)) {
      throw new TaskMachineValidationError(
        name,
        `state "${state}" is presented but awaits nobody`,
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
    // A CHOICE IS PUT TO THE PARTY THE STEP WAITS ON, and it is one of the step's own exits (ADR-063 decision 2).
    if (def.choices !== undefined) {
      if (!Array.isArray(def.choices) || !def.choices.length || def.choices.some((c) => typeof c !== 'string')) {
        throw new TaskMachineValidationError(name, `state "${state}" declares choices that is not a non-empty list of its transitions`);
      }
      if (!awaitedPartyOf(def)) throw new TaskMachineValidationError(name, `state "${state}" declares choices but awaits nobody`);
      if (new Set(def.choices).size !== def.choices.length) throw new TaskMachineValidationError(name, `state "${state}" names the same choice twice`);
      const outside = def.choices.filter((c) => !def.transitions.includes(c));
      if (outside.length) throw new TaskMachineValidationError(name, `state "${state}" declares choices ${outside.map((c) => `"${c}"`).join(', ')} that are not its transitions`);
    }
    // A RESTING STEP IS ONE THE ASSISTANT HOLDS (ADR-063 decision 5): it awaits nobody and still has a way out.
    if (def.rests !== undefined) {
      if (def.rests !== true) throw new TaskMachineValidationError(name, `state "${state}" declares rests, which is true or absent`);
      if (isTerminalByEdges) throw new TaskMachineValidationError(name, `state "${state}" rests but is terminal, which nothing takes up anyway`);
      if (awaitedPartyOf(def)) throw new TaskMachineValidationError(name, `state "${state}" rests but awaits somebody, which already holds it`);
    }
    validateConfirmDeclaration(name, state, def);
    validateTemplateDeclaration(name, machine, state, def);
    validateStepTools(name, state, def);
    validateStepAction(name, machine, state, def);
    validateStepConditions(name, state, def);
    for (const target of def.transitions) {
      if (!machine.states[target]) {
        throw new TaskMachineValidationError(name, `state "${state}" transitions to undeclared state "${target}"`);
      }
    }
    // A REOPEN IS A TERMINAL STATE'S DECLARATION, NOT A SECOND KIND OF EDGE. On a state that still has
    // transitions it would be an ordinary edge under another name, and a target that is itself terminal
    // would reopen a task into an ending, which is no reopen at all.
    if (def.reopens !== undefined) {
      if (!Array.isArray(def.reopens)) {
        throw new TaskMachineValidationError(name, `state "${state}" declares reopens that is not a list`);
      }
      if (!isTerminalByEdges) {
        throw new TaskMachineValidationError(name, `state "${state}" declares reopens but is not terminal`);
      }
      for (const target of def.reopens) {
        const targetDef = machine.states[target];
        if (!targetDef) {
          throw new TaskMachineValidationError(name, `state "${state}" reopens to undeclared state "${target}"`);
        }
        if (targetDef.transitions.length === 0) {
          throw new TaskMachineValidationError(name, `state "${state}" reopens to terminal state "${target}"`);
        }
      }
    }
  }
  if (terminalCount === 0) {
    throw new TaskMachineValidationError(name, 'has no terminal state');
  }

  // Reachability: BFS from initial; every declared state must be visited. A declared reopen reaches its target, so a
  // state entered only when a finished task is reopened (`image_generation.revise`) is reachable.
  const seen = new Set<string>([machine.initial]);
  const queue = [machine.initial];
  while (queue.length > 0) {
    const s = queue.shift() as string;
    for (const t of [...machine.states[s].transitions, ...(machine.states[s].reopens ?? [])]) {
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

/**
 * WHEN A PRESENTED STEP IS PUT TO THE PERSON (ADR-064 decision G): `confirm` only on a presented step and only as one of
 * `CONFIRM_POLICIES`, and `brief` a non-empty list of needs, declared only beside `confirm` and required where a complete
 * brief may go past the step.
 */
function validateConfirmDeclaration(name: string, state: string, def: TaskStateDef): void {
  if (def.confirm === undefined) {
    if (def.brief !== undefined) throw new TaskMachineValidationError(name, `state "${state}" declares brief but no confirm; a brief is what lets a request go past a confirmed step`);
    return;
  }
  if (!(CONFIRM_POLICIES as readonly string[]).includes(def.confirm)) {
    throw new TaskMachineValidationError(name, `state "${state}" declares confirm "${String(def.confirm)}"; it is one of ${CONFIRM_POLICIES.join(', ')}`);
  }
  if (!def.presented) throw new TaskMachineValidationError(name, `state "${state}" declares confirm but is not presented`);
  if (def.brief !== undefined && (!Array.isArray(def.brief) || !def.brief.length || def.brief.some((n) => typeof n !== 'string' || !n.trim()))) {
    throw new TaskMachineValidationError(name, `state "${state}" declares a brief that is not a non-empty list of needs`);
  }
  if (def.confirm === 'when-incomplete' && !def.brief?.length) {
    throw new TaskMachineValidationError(name, `state "${state}" is confirmed when-incomplete, so it declares the brief that makes a request complete`);
  }
}

/**
 * THE STEP A MOVE GOES PAST (ADR-064 decision G): a state declaring `confirm` that `from` moves into and that itself
 * moves to `to`, where `from` also moves to `to` directly. Undefined for every other move.
 */
export function confirmStepPassed(machine: TaskStateMachine | undefined, from: string, to: string): string | undefined {
  const fromDef = machine?.states[from];
  if (!machine || !fromDef || !fromDef.transitions.includes(to)) return undefined;
  return fromDef.transitions.find((s) => s !== to && s !== from
    && machine.states[s]?.confirm !== undefined && machine.states[s].transitions.includes(to));
}

/** Why a move past a `when-incomplete` step is refused: the brief was not in this turn's request, or a need is not recorded. */
export type DirectEdgeRefusal =
  | { error: 'brief_not_in_request'; step: string }
  | { error: 'brief_incomplete'; step: string; missing: string[] };

/**
 * THE CHECK ON A MOVE PAST A CONFIRMED STEP, from recorded data only (ADR-064 decision G, tenet D11).
 *
 * The move is allowed where the step is `when-incomplete`, the task entered `from` on this turn (the request itself
 * carried the brief; `enteredThisTurn`, structural, from the turn's own record, and unchecked where the caller has no
 * turn), and every need of the step's `brief` is recorded on the task (`details.collectedRequirements`, each with its
 * value, source and evidence, written by `advance_task_state`). Nothing reads what anybody wrote. An `always` step
 * refuses the move as well, though `legalTransitionsFrom` already leaves that edge out.
 */
export function directEdgeRefusal(
  machine: TaskStateMachine | undefined,
  from: string,
  to: string,
  details: Record<string, unknown> | undefined,
  opts: { enteredThisTurn?: boolean } = {},
): DirectEdgeRefusal | undefined {
  const step = confirmStepPassed(machine, from, to);
  if (!step) return undefined;
  const def = machine!.states[step];
  const brief = def.brief ?? [];
  if (def.confirm !== 'when-incomplete') return { error: 'brief_incomplete', step, missing: brief };
  if (opts.enteredThisTurn === false) return { error: 'brief_not_in_request', step };
  const recorded = (details?.collectedRequirements ?? {}) as Record<string, { value?: unknown } | undefined>;
  const missing = brief.filter((need) => {
    const value = recorded[need]?.value;
    return !(typeof value === 'string' && value.trim());
  });
  return missing.length ? { error: 'brief_incomplete', step, missing } : undefined;
}

/**
 * THE BRIEF A MOVE FROM `state` CAN CARRY PAST A CONFIRMED STEP (ADR-064 decision G): the needs of each `when-incomplete`
 * step that a legal move from `state` goes past, in declared order and without repeats. These are needs the turn records
 * at `state` itself, so the step's tool offers them beside the step's own `requires`. Empty where no such move exists,
 * and where the step is always confirmed, since that move is not legal.
 */
export function briefNeedsPastConfirm(taskType: string, state: string, machines: Record<string, TaskStateMachine>): string[] {
  const machine = machines[taskType];
  if (!machine) return [];
  const needs: string[] = [];
  for (const to of legalTransitionsFrom(taskType, state, machines)) {
    const step = confirmStepPassed(machine, state, to);
    const def = step ? machine.states[step] : undefined;
    if (def?.confirm !== 'when-incomplete') continue;
    for (const n of def.brief ?? []) if (!needs.includes(n)) needs.push(n);
  }
  return needs;
}

/**
 * A VERSION'S CONFIRMATION SETTING, applied to the turn's machines (ADR-064 decision G, tenet P5): for each workflow it
 * names, every state of that workflow declaring `confirm` takes the version's value. A workflow it does not name keeps
 * its declared value. Returns the machines unchanged where the version sets nothing.
 */
export function withConfirmBrief(
  machines: Record<string, TaskStateMachine>,
  confirmBrief: Readonly<Record<string, ConfirmPolicy>> | undefined,
): Record<string, TaskStateMachine> {
  const named = Object.entries(confirmBrief ?? {}).filter(([k]) => machines[k]);
  if (!named.length) return machines;
  const out = { ...machines };
  for (const [key, policy] of named) {
    const m = machines[key];
    out[key] = {
      ...m,
      states: Object.fromEntries(Object.entries(m.states).map(([s, d]) => [s, d.confirm !== undefined ? { ...d, confirm: policy } : d])),
    };
  }
  return out;
}

/**
 * THE REFUSALS OF A VERSION'S `confirmBrief`, against the machines the runtime runs: each key a workflow with a step
 * that declares `confirm`, each value one of `CONFIRM_POLICIES`, and `when-incomplete` only where every such step
 * declares the brief it checks.
 */
export function confirmBriefErrors(confirmBrief: unknown, machines: Readonly<Record<string, TaskStateMachine>>): string[] {
  if (confirmBrief === undefined) return [];
  if (!confirmBrief || typeof confirmBrief !== 'object' || Array.isArray(confirmBrief)) {
    return ['confirmBrief maps a workflow key to always or when-incomplete'];
  }
  const errs: string[] = [];
  for (const [key, policy] of Object.entries(confirmBrief as Record<string, unknown>)) {
    if (!(CONFIRM_POLICIES as readonly unknown[]).includes(policy)) {
      errs.push(`confirmBrief['${key}'] is ${JSON.stringify(policy)}; it is one of ${CONFIRM_POLICIES.join(', ')}`);
      continue;
    }
    const steps = Object.entries(machines[key]?.states ?? {}).filter(([, d]) => d.confirm !== undefined);
    if (!steps.length) {
      const offering = Object.entries(machines).filter(([, m]) => Object.values(m.states).some((d) => d.confirm !== undefined)).map(([k]) => k);
      errs.push(`confirmBrief['${key}'] names no workflow with a step that declares confirm; workflows that declare one: ${offering.sort().join(', ') || '(none)'}`);
      continue;
    }
    if (policy === 'when-incomplete') {
      for (const [s, d] of steps) if (!d.brief?.length) errs.push(`confirmBrief['${key}'] is when-incomplete, and its step "${s}" declares no brief to check`);
    }
  }
  return errs;
}

/**
 * A TEMPLATE IS DECLARED ON A STEP THAT DELIVERS, and nowhere else (SPEC-DOCUMENT-TEMPLATES FR4). The
 * structural rules only: whether the named template exists for the classification needs the store, and
 * is checked where the pack and the templates are both read (`template-store.ts`, `templateReferenceErrors`).
 */
function validateTemplateDeclaration(name: string, machine: TaskStateMachine, state: string, def: TaskStateDef): void {
  const declares = def.template !== undefined || def.templates !== undefined || def.defaultTemplate !== undefined;
  if (!declares) return;
  if (!deliversDocument(def)) {
    throw new TaskMachineValidationError(name, `state "${state}" declares a template but does not deliver`);
  }
  if (def.template !== undefined && def.templates !== undefined) {
    throw new TaskMachineValidationError(name, `state "${state}" declares both template and templates; declare one`);
  }
  if (def.template !== undefined && !parseTemplateRef(def.template)) {
    throw new TaskMachineValidationError(name, `state "${state}" declares template "${String(def.template)}", which is not a template name (or name@<sha256>)`);
  }
  if (def.templates !== undefined) {
    if (!Array.isArray(def.templates) || def.templates.length === 0) {
      throw new TaskMachineValidationError(name, `state "${state}" declares templates that is not a non-empty list`);
    }
    const parsed = def.templates.map(parseTemplateRef);
    const bad = def.templates.filter((_t, i) => !parsed[i]);
    if (bad.length) {
      throw new TaskMachineValidationError(name, `state "${state}" declares templates ${bad.map((b) => `"${String(b)}"`).join(', ')}, not template names`);
    }
    const names = parsed.map((r) => r!.name);
    if (new Set(names).size !== names.length) {
      throw new TaskMachineValidationError(name, `state "${state}" declares the same template twice in templates`);
    }
    // A CHOICE IS PUT TO SOMEBODY, on the workflow's requirements step. With nowhere to record it the
    // delivering step would have nothing to load but the default, and the list would be decoration.
    if (names.length > 1 && !machine.states[machine.initial]?.requires?.length) {
      throw new TaskMachineValidationError(
        name,
        `state "${state}" offers a choice of templates, but the initial state "${machine.initial}" declares no requires, so nobody is asked to choose`,
      );
    }
  }
  if (def.defaultTemplate !== undefined) {
    const names = (def.templates ?? []).map((t) => parseTemplateRef(t)?.name);
    if (!names.includes(def.defaultTemplate)) {
      throw new TaskMachineValidationError(name, `state "${state}" declares defaultTemplate "${String(def.defaultTemplate)}", which is not one of its templates`);
    }
  }
}

/**
 * A STEP'S TOOLS ARE REGISTERED NAMES (FR28). What a profile could allow is the registry, so a name
 * outside it is refused here, at every ingress; whether THIS profile allows a listed tool is the turn's
 * question, answered by intersection, which can only narrow.
 */
function validateStepTools(name: string, state: string, def: TaskStateDef): void {
  if (def.tools === undefined) return;
  if (!Array.isArray(def.tools) || !def.tools.every((t) => typeof t === 'string' && t.trim())) {
    throw new TaskMachineValidationError(name, `state "${state}" declares tools that is not a list of tool names`);
  }
  if (new Set(def.tools).size !== def.tools.length) {
    throw new TaskMachineValidationError(name, `state "${state}" names the same tool twice in tools`);
  }
  const unknown = def.tools.filter((t) => !isKnownTool(t));
  if (unknown.length) {
    throw new TaskMachineValidationError(name, `state "${state}" declares unknown tool(s) ${unknown.map((t) => `"${t}"`).join(', ')}`);
  }
}

let fixedMachineLookup: SourceLookup | undefined;
/**
 * What a machine's conditions and variable bindings are checked against where it is stored: the sources every
 * classification publishes. A machine is validated without a classification's catalog, so a `ctx:` source reads as the
 * catalog's least-permitting entry (`withUnreadCatalog`): member text, which may be bound and never decides.
 */
function machineLookup(): SourceLookup {
  return (fixedMachineLookup ??= withUnreadCatalog(sourceLookup(buildSourceTable({ catalog: [] }))));
}

/**
 * A STEP'S CONDITIONS ARE HELD TO ADR-060 decision 3 (`whenErrors`): a published source, never member text, an
 * operator on a type it applies to. A move is addressed to the person whose turn asked for it, so a fact about that
 * person may gate it. An edge condition names one of the state's own transitions. A `ctx:` key is held where the
 * classification's catalog is read (`machineCatalogConditionErrors`, at the classification's synth).
 */
function validateStepConditions(name: string, state: string, def: TaskStateDef): void {
  const fail = (msg: string) => { throw new TaskMachineValidationError(name, `state "${state}" ${msg}`); };
  if (def.when !== undefined) {
    const errors = whenErrors(def.when, machineLookup(), { selects: 'addressed', catalog: 'deferred' });
    if (errors.length) fail(`declares a when that is refused: ${errors.join('; ')}`);
  }
  if (def.edgeWhen === undefined) return;
  if (!def.edgeWhen || typeof def.edgeWhen !== 'object' || Array.isArray(def.edgeWhen)) fail('declares edgeWhen that is not a map of a transition to its when');
  for (const [target, when] of Object.entries(def.edgeWhen)) {
    if (!def.transitions.includes(target)) fail(`declares edgeWhen for "${target}", which is not one of its transitions`);
    const errors = whenErrors(when, machineLookup(), { selects: 'addressed', catalog: 'deferred' });
    if (errors.length) fail(`declares an edgeWhen for "${target}" that is refused: ${errors.join('; ')}`);
  }
}

/**
 * A MACHINE'S `ctx:` CONDITIONS, HELD AGAINST THE CATALOG OF THE CLASSIFICATION THAT SERVES IT (ADR-060 decision 3).
 * A machine is a global workflow, deployed with its classification's pack beside that classification's catalog, so the
 * classification's synth reads both and refuses a condition on a `ctx:` field its catalog does not publish, publishes
 * as member text, or tests with an operator its type does not take. `lookup` is the classification's table
 * (`sourceLookup(buildSourceTable({ catalog }))`). Every reason at once, each naming its machine and state.
 */
export function machineCatalogConditionErrors(machines: Readonly<Record<string, TaskStateMachine>>, lookup: SourceLookup): string[] {
  const errors: string[] = [];
  for (const [name, machine] of Object.entries(machines)) {
    for (const [state, def] of Object.entries(machine.states)) {
      const at = `machine "${name}" state "${state}"`;
      if (def.when !== undefined) {
        errors.push(...whenErrors(def.when, lookup, { selects: 'addressed', catalog: 'only' }).map((e) => `${at} when: ${e}`));
      }
      for (const [target, when] of Object.entries(def.edgeWhen ?? {})) {
        errors.push(...whenErrors(when, lookup, { selects: 'addressed', catalog: 'only' }).map((e) => `${at} edgeWhen "${target}": ${e}`));
      }
    }
  }
  return errors;
}

/** Every condition a machine declares, so a turn reads the values they name and no others. */
export function machineConditions(machine: TaskStateMachine | undefined): When[] {
  if (!machine) return [];
  return Object.values(machine.states).flatMap((def) => [
    ...(def.when !== undefined ? [def.when] : []),
    ...Object.values(def.edgeWhen ?? {}),
  ]);
}

/** The registered tools a step action may run: the ones that execute in the turn, plus `deliver_document`. */
export function isActionTool(tool: string): boolean {
  if (tool === DELIVER_DOCUMENT_TOOL_NAME || tool === GENERATE_IMAGE_ACTION) return true;
  const d = TOOL_REGISTRY.find((t) => t.name === tool);
  return Boolean(d && (d.category === 'context' || d.category === 'connector'));
}

/**
 * A STEP ACTION IS DECLARED WHOLE (FR29): a tool that can run without a model, arguments that bind to
 * something the workflow can record, and the outcome edges the runtime takes, both declared transitions.
 * What can only be known at turn time (whether this profile permits the tool, whether a binding has a
 * value yet) is refused there, by name.
 */
function validateStepAction(name: string, machine: TaskStateMachine, state: string, def: TaskStateDef): void {
  const fail = (msg: string) => { throw new TaskMachineValidationError(name, `state "${state}" ${msg}`); };
  // A REQUIRED TOOL (ADR-064 decision 3) is a registered tool the step offers; the platform already runs an action's.
  if (def.requiresTool !== undefined) {
    if (!Array.isArray(def.requiresTool) || def.requiresTool.some((t) => typeof t !== 'string' || !t)) fail('declares requiresTool that is not a list of tool names');
    if (def.action !== undefined) fail('declares both an action and requiresTool; the platform already runs the action\'s tool');
    for (const t of def.requiresTool) {
      if (!TOOL_REGISTRY.some((d) => d.name === t)) fail(`requiresTool names "${t}", which is not a registered tool`);
      if (def.tools && !def.tools.includes(t)) fail(`requiresTool names \`${t}\`, which \`${state}\` does not offer`);
    }
  }
  if (def.action === undefined) {
    if (def.onSuccess !== undefined || def.onFailure !== undefined) fail('declares onSuccess or onFailure but no action');
    return;
  }
  const action = def.action as unknown;
  if (!action || typeof action !== 'object' || Array.isArray(action)) fail('declares an action that is not an object');
  const { tool, args } = action as { tool?: unknown; args?: unknown };
  if (typeof tool !== 'string' || !tool.trim()) fail('declares an action with no tool');
  const toolName = tool as string;
  // WORK-ITEM TOOLS ARE PROPOSALS a person confirms and the advance is the model's, so neither is an
  // action. A tool nothing executes in the turn has nothing for the platform to run.
  if (!isActionTool(toolName)) {
    fail(`declares action tool "${toolName}", which is not a registered tool the platform can run`);
  }
  if (toolName === DELIVER_DOCUMENT_TOOL_NAME && !deliversDocument(def)) {
    fail(`declares the action "${DELIVER_DOCUMENT_TOOL_NAME}" but does not deliver`);
  }
  if (args !== undefined) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('declares action args that are not an object');
    const declaredNeeds = new Set(Object.values(machine.states).flatMap((s) => s.requires ?? []));
    declaredNeeds.add('template');
    for (const [param, raw] of Object.entries(args as Record<string, unknown>)) {
      if (typeof raw === 'number' || typeof raw === 'boolean') continue;
      const b = parseBinding(raw);
      if (!b) {
        fail(`binds action arg "${param}" to "${String(raw)}"; a binding is requirement:<need>, detail:<key>, tool:<state>.<path> or literal:<text>`);
      }
      // A VARIABLE SOURCE IS READ BY THE TURN'S RESOLVER (ADR-060, slice 1d): it names a source the platform
      // publishes, or it could never resolve. A `ctx:` source is checked at the turn, against the catalog it reads.
      if (sourceKindOf(String(raw)) && !machineLookup()(String(raw))) {
        fail(`binds action arg "${param}" to "${String(raw)}", which is not a variable source the platform publishes`);
      }
      // CHECKABLE, SO CHECKED: a need no step asks for can never have a sourced value, and a result no
      // step's action records can never be read.
      if (b!.kind === 'requirement' && !declaredNeeds.has(b!.key)) {
        fail(`binds action arg "${param}" to the need "${b!.key}", which no state of this workflow requires`);
      }
      if (b!.kind === 'tool' && !machine.states[b!.state ?? '']?.action) {
        fail(`binds action arg "${param}" to a result of "${b!.state}", which declares no action`);
      }
    }
  }
  // AN ACTION STEP IS THE PLATFORM'S, START TO FINISH. It runs on entry and moves on, so a step that
  // also waited on a person would be moved past them by the runtime.
  if (awaitedPartyOf(def)) fail('declares an action and awaits somebody; a step the platform runs awaits nobody');
  if (!def.onSuccess) fail('declares an action with no onSuccess');
  if (!def.transitions.includes(def.onSuccess as string)) fail(`declares onSuccess "${def.onSuccess}", which is not one of its transitions`);
  if (def.onFailure !== undefined && !def.transitions.includes(def.onFailure)) {
    fail(`declares onFailure "${def.onFailure}", which is not one of its transitions`);
  }
  if (!actionEdgesOf(machine, state)?.onFailure) {
    fail('declares an action with no onFailure and no transition into a terminal failure state');
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
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [type, machine] of Object.entries(machines)) out[type] = Object.keys(machine.states);
  return out;
}

/** The initial state of a task type, or undefined if the type has no machine. */
export function initialStateFor(
  taskType: string,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): string | undefined {
  return machines[taskType]?.initial;
}

/** Legal target states from `state` in the machine, or [] if the type/state is unknown. */
export function legalTransitionsFrom(
  taskType: string,
  state: string,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): string[] {
  const machine = machines[taskType];
  // A MOVE PAST A STEP THAT IS ALWAYS CONFIRMED IS NO MOVE (ADR-064 decision G): it is neither offered nor authorized.
  return (machine?.states[state]?.transitions ?? [])
    .filter((to) => machine!.states[confirmStepPassed(machine, state, to) ?? '']?.confirm !== 'always');
}

/**
 * The states a finished task in `state` may be reopened into, or [] when `state` is not a terminal
 * that declares `reopens`. Read this rather than the field, so a non-terminal state carrying a stray
 * declaration never reads as reopenable.
 */
export function reopenTargetsFrom(
  taskType: string,
  state: string,
  /** THE TURN'S MACHINES, required for the reason `legalTransitionsFrom` gives. */
  machines: Record<string, TaskStateMachine>,
): string[] {
  const def = machines[taskType]?.states[state];
  if (!def || def.transitions.length > 0) return [];
  return Array.isArray(def.reopens) ? def.reopens : [];
}

/** Whether `from -> to` is a declared reopen: `from` is a terminal that lists `to` in `reopens`. */
export function isReopenEdge(
  taskType: string,
  from: string,
  to: string,
  /** THE TURN'S MACHINES, required for the reason `legalTransitionsFrom` gives. */
  machines: Record<string, TaskStateMachine>,
): boolean {
  return reopenTargetsFrom(taskType, from, machines).includes(to);
}

/** Whether `state` is a declared state of the task type's machine. */
export function isDeclaredState(
  taskType: string,
  state: string,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): boolean {
  return Boolean(machines[taskType]?.states[state]);
}

/** Whether the edge `from -> to` is authorized by the task type's machine. */
export function isLegalTransition(
  taskType: string,
  from: string,
  to: string,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): boolean {
  return legalTransitionsFrom(taskType, from, machines).includes(to);
}

/** The terminal disposition of `state`, or undefined if it is not terminal / unknown. */
export function terminalKindOf(
  taskType: string,
  state: string,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): TerminalKind | undefined {
  const def = machines[taskType]?.states[state];
  return def && def.transitions.length === 0 ? def.terminal : undefined;
}

/** The authorization decision for a requested transition (SPEC-TASK-STATE-TRANSITIONS §3). */
export type TransitionAuthz =
  | { ok: true; from: string; to: string; terminal?: TerminalKind; reopen?: true }
  | { ok: false; error: 'unknown_state' | 'illegal_transition' | 'condition_not_met'; from: string; legal: string[] };

/** Whether the move `from -> to` meets the conditions its machine declares: the target's entry `when` and the edge's. */
function conditionsHold(def: TaskStateDef | undefined, fromDef: TaskStateDef | undefined, to: string, values: Readonly<Record<string, VariableValue>>): boolean {
  const entry = def?.when;
  const edge = fromDef?.edgeWhen && Object.prototype.hasOwnProperty.call(fromDef.edgeWhen, to) ? fromDef.edgeWhen[to] : undefined;
  return (entry === undefined || evaluateWhen(entry, values)) && (edge === undefined || evaluateWhen(edge, values));
}

/**
 * Authorize (do not persist) a requested `from -> to` transition against the task type's graph —
 * the runtime's authorization step (§3, checks 2 and 3; check 1, "an active task exists", is the
 * caller's). `unknown_state` = `to` is not a declared state of this machine; `illegal_transition`
 * = declared, but the edge is not in the graph, and the legal set is echoed back so the model can
 * self-correct in the same loop iteration.
 *
 * A DECLARED REOPEN (`reopens` on a terminal `from`) is authorized as `{ ok: true, reopen: true }`, and
 * only for `by: 'tool'`, the model's call on a turn carrying the requester's message. A `system` writer
 * asking for the same edge is refused as `illegal_transition`: a reopen is the person asking, and no
 * runtime path has the person's words. For a `tool` caller the echoed legal set includes the reopen
 * targets, so a model at a reopenable terminal can see the move.
 */
export function authorizeTransition(
  taskType: string,
  from: string,
  to: string,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
  /**
   * Who is asking, and the deciding values the turn's resolver read for the machine's conditions
   * (`decidingValues`, ADR-060 decision 6): plain data, already held back by trust, call site and audience, so the
   * task service decides the same move the turn would. Absent, every condition is unresolved and does not hold.
   */
  opts: { by?: 'tool' | 'system'; conditionValues?: Readonly<Record<string, VariableValue>> } = {},
): TransitionAuthz {
  const machine = machines[taskType];
  const values = opts.conditionValues ?? {};
  const fromDef = machine?.states[from];
  const meets = (target: string) => conditionsHold(machine?.states[target], fromDef, target, values);
  const ordinary = legalTransitionsFrom(taskType, from, machines);
  const reopens = (opts.by ?? 'tool') === 'tool' ? reopenTargetsFrom(taskType, from, machines) : [];
  // THE LEGAL SET ECHOED BACK IS THE ONE THE CONDITIONS ADMIT, so a model refused a gated move is shown where it may go.
  const legal = [...ordinary, ...reopens].filter(meets);
  if (!isDeclaredState(taskType, to, machines)) {
    return { ok: false, error: 'unknown_state', from, legal };
  }
  if (!ordinary.includes(to) && !reopens.includes(to)) {
    return { ok: false, error: 'illegal_transition', from, legal };
  }
  // A DECLARED EDGE WHOSE CONDITION DOES NOT HOLD IS REFUSED, naming no value (ADR-060 decision 6): the reason is the
  // error code and the legal set, never what was read.
  if (!meets(to)) {
    return { ok: false, error: 'condition_not_met', from, legal };
  }
  if (ordinary.includes(to)) {
    return { ok: true, from, to, terminal: terminalKindOf(taskType, to, machines) };
  }
  return { ok: true, from, to, reopen: true };
}

/**
 * HOW A MACHINE SAYS ITS TASK ENDED: the terminal kind its own definition gives `state`, or null when the state is not a
 * terminal of that task type's machine (or the type has no machine). A machine names its own endings: `image_generation`
 * succeeds in `done`, a work item in `placed`, a report in `completed`.
 *
 * ONE RULE FOR EVERY READER OF AN ENDING. The experiment rollup, the task metrics and the turn-events ledger each read a
 * recorded state against this, so a task that finished in a state of another name than `completed` is a completion in
 * all of them or in none. `machines` is the set the caller has: the pack-merged set (`taskStateMachines`) where the
 * runtime holds the deployment's pack, the platform defaults where it does not.
 */
export function machineTerminalKind(
  taskType: string | null | undefined,
  state: string | null | undefined,
  machines: Readonly<Record<string, TaskStateMachine>> = DEFAULT_TASK_STATE_MACHINES,
): TerminalKind | null {
  if (!taskType || !state) return null;
  return machines[taskType]?.states?.[state]?.terminal ?? null;
}

/**
 * EVERY STATE A TASK ENDS IN SUCCESS, as `<task type>:<state>`, for a reader that matches in SQL. The same rule as
 * `machineTerminalKind`, listed: a state is here exactly when that function calls it `success`.
 */
export function successTerminalStates(
  machines: Readonly<Record<string, TaskStateMachine>> = DEFAULT_TASK_STATE_MACHINES,
): string[] {
  const out: string[] = [];
  for (const [taskType, machine] of Object.entries(machines)) {
    for (const state of Object.keys(machine.states ?? {})) {
      if (machineTerminalKind(taskType, state, machines) === 'success') out.push(`${taskType}:${state}`);
    }
  }
  return out.sort();
}
