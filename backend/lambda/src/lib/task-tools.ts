/**
 * In-Lambda task tools (SPEC-TASK-STATE-TRANSITIONS §3, §5). The Converse tool loop registers these
 * only when a task is active; a tool call is the ONLY thing that changes task state, and the runtime
 * authorizes it against the task's graph before it persists. Kept separate from the loop so the
 * dispatch logic is unit-testable without a Bedrock round-trip.
 */
// TASKS GO THROUGH THE STORE SEAM, not the table. Same signatures; the boundary is inside.
import { deliversDocument } from './task-state-machines.js';
import { advanceTaskStateTo } from './task-store.js';
import { type Task, type AdvanceResult, deliveringContract, requiredToolsNotRun } from './task-tracking.js';
// The shape the delivering check reads back. Imported rather than re-declared so the writer and the
// reader cannot drift into two different ideas of what an agreed size is.
import type { LengthTarget as RecordedLengthTarget } from './deliverable-check.js';
import {
  type TaskStateMachine,
  DEFAULT_TASK_STATE_MACHINES,
  ADVANCE_TASK_STATE_TOOL_NAME,
  DELIVER_DOCUMENT_TOOL_NAME,
  authorizeTransition,
  briefNeedsPastConfirm,
  directEdgeRefusal,
  edgeDelivers,
  templateChoiceOf,
  resolveStateTemplate,
  recordedTemplateChoice,
  templateRefKey,
  machineConditions,
  type StepAction,
  type TaskStateDef,
} from './task-state-machines.js';
import { parseBinding, resolveBinding } from './step-bindings.js';
import { decidingValues, insertValue, sourceKindOf, type SourceLookup, type VariableValue } from './variables.js';
import type { CallSiteCapabilities } from './context-source-shapes.js';
import { fillTemplate, isLoadedTemplate, type TurnTemplates, type LoadedTemplate } from './document-template.js';

// Re-exported from where the machines are declared, so a prompt that names this tool and the loop that
// dispatches it read the same constant. Kept exported here because this is where callers expect it.
export { ADVANCE_TASK_STATE_TOOL_NAME, DELIVER_DOCUMENT_TOOL_NAME };

/**
 * WHERE A RECORDED REQUIREMENT CAME FROM. Two answers and no third: the person's own message, or a
 * passage the turn retrieved. There is deliberately no value for a need the model filled in itself,
 * because a requirement nobody supplied is not a requirement, it is a guess presented as an agreement.
 */
export const REQUIREMENT_SOURCES = ['message', 'context'] as const;
export type RequirementSource = (typeof REQUIREMENT_SOURCES)[number];

/** One recorded requirement, with the source it was taken from and the evidence for it. */
export interface CollectedRequirement {
  value: string;
  source: RequirementSource;
  /** A short quote of the person's message (`message`), or the retrieved passage or source id (`context`). */
  evidence: string;
}

/**
 * The active-task context threaded into the Converse loop. Passing it registers the task tools and
 * lets the loop dispatch a tool call to the authorized transition. `transitions` is populated BY the
 * loop with the transitions it applied this turn, so the caller can record them for analytics and
 * compare against the shadow keyword detector — no return-value threading through the fallback paths.
 */
export interface TaskLoopContext {
  task: Task;
  /**
   * THE OTHER OPEN WORK THIS MESSAGE MIGHT BE ABOUT (ADR-024 D7).
   *
   * `task` above is the runtime's PROPOSAL - the best-ranked of the person's open work, which is a
   * fact about the work rather than about the message. When more than one is open the model is told
   * so, and may name another; these are the ids it may name.
   *
   * An allowlist rather than a hint: it is rendered into the tool schema as an enum, so a redirect
   * is constrained to work this person actually holds in this conversation and cannot be steered by
   * anything they typed. Empty or absent means there was nothing to choose between.
   */
  referentCandidateIds?: string[];
  /** THE TURN'S MACHINES, definite (ADR-047). Optional once, which let a consumer read a different
   *  set - the compiled platform defaults - without anything at runtime noticing the substitution. */
  machines: Record<string, TaskStateMachine>;
  messageId?: string;
  /** The task state BEFORE this turn (captured at build), so the shadow keyword detector can be
   *  compared against the same state the model saw even after the tool mutates task.taskState. */
  initialState?: string;
  /**
   * What this turn moved. `taskId` is present only when the model REDIRECTED - it named a different
   * piece of the person's open work (ADR-024 D7) - and absent for the ordinary case where the turn
   * moved the task it was already on.
   *
   * It exists because several readers of this array assume every entry describes the ACTIVE task:
   * the hand-off notice, the delivery check, and the stall counter all key off `event.taskId`. A
   * redirect made those read a transition belonging to a different row, so an advance on one task
   * suppressed the stall count on another and could fire a hand-off notice naming the wrong work.
   */
  transitions?: Array<{ from: string; to: string; taskId?: string }>;
  /** The assistant running this turn, so a task leaving a waiting state is handed back to it. */
  assistantId?: string;
  /**
   * THIS TURN CREATED THE TASK. Read from the task row, never from the text: the router records the
   * opening turn's correlation id on the task it creates (`Task.correlationId`), and the context is built
   * with this turn's id, so equality means this is the turn the task was opened on. A state the machine
   * declares `presented` may not be left on that turn (see `TaskStateDef.presented`).
   */
  openedThisTurn?: boolean;
  /**
   * THE DOCUMENT THIS TURN DECLARED, when it declared one: the `document` argument of an
   * `advance_task_state` that entered or finished from a delivering state, or of `deliver_document`. The
   * delivery gate packages this and only this as the file; the reply text posts as chat. Output-guarded
   * by the loop before it is returned, like the reply.
   */
  declaredDocument?: string;
  /**
   * The guidance for a state, as the turn's prompt would render it, so an advance that lands the model
   * in a new state hands it that state's instructions with the result. Absent, the state's own declared
   * `prompt` and, for a delivering state, the delivering contract are used.
   */
  guidanceFor?: (taskType: string, state: string, details?: Record<string, unknown>) => string;
  /**
   * THE DOCUMENT TEMPLATES THIS TASK'S MACHINE DECLARES, loaded before the turn ran
   * (SPEC-DOCUMENT-TEMPLATES FR5), keyed by the declared reference. A reference that could not be loaded
   * is a named failure here, and a move into the step that needs it is refused with that reason.
   */
  templates?: TurnTemplates;
  /**
   * The template the turn's declared document was written against, set when an advance or a rewrite
   * declares a document for a templated step. The delivery gate checks the document against it and
   * records it (FR6, FR8). `filled`: the platform rendered the document from recorded data (FR9).
   */
  declaredTemplate?: DeclaredTemplate;
  /**
   * Runtime-driven moves this turn has taken on declared step actions' outcomes (FR29), retries of the
   * model call included, so `runStepActions` can hold a turn to `MAX_RUNTIME_MOVES_PER_TURN`.
   */
  runtimeMoves?: number;
  /**
   * WHAT THE TURN'S RESOLVER HOLDS (ADR-060, slice 1d): the classification's sources, the values this turn read by
   * source, and what its call site settled. A step's `when` and `edgeWhen` decide on these (`turnConditionValues`), and
   * an action argument bound to a variable source is inserted from them (`bindActionArgs`). Absent, no condition
   * holds and no variable binding resolves.
   */
  variables?: TurnVariables;
}

/** What a turn's resolver holds: read once by the processor, never on demand (ADR-060 decision 4). */
export interface TurnVariables {
  lookup: SourceLookup;
  values: Readonly<Record<string, VariableValue | undefined>>;
  callSite: CallSiteCapabilities;
}

/**
 * THE DECIDING VALUES A TASK'S MACHINE MAY GATE ON THIS TURN (ADR-060 decision 6): the keys its conditions name, each
 * read through the resolver's second layer at the turn's call site. A move is addressed to the person whose turn asked
 * for it, so a fact about that person may decide it. Plain data, carried to the task service with the move.
 */
export function turnConditionValues(ctx: Pick<TaskLoopContext, 'task' | 'machines' | 'variables'>): Record<string, VariableValue> {
  const whens = machineConditions(ctx.machines[ctx.task.taskType ?? '']);
  if (!whens.length || !ctx.variables) return {};
  const v = ctx.variables;
  return decidingValues(whens, { lookup: v.lookup, values: v.values, site: { callSite: v.callSite, audience: 'addressed' } });
}

/**
 * The text each variable-bound action argument inserts, by source (ADR-060, slice 1d): read through `insertValue`, so
 * a value not settled at the call site, a source not published or a value its type refuses is absent, and the action
 * is refused as unbound rather than run on a gap. An action's argument is addressed to the person whose turn ran it.
 */
export function actionVariableValues(action: StepAction | undefined, variables: TurnVariables | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!action?.args || !variables) return out;
  for (const raw of Object.values(action.args)) {
    if (typeof raw !== 'string' || !sourceKindOf(raw)) continue;
    const text = insertValue(raw, variables.lookup(raw), variables.values[raw], { callSite: variables.callSite, audience: 'addressed', section: 'action' });
    if (text) out[raw] = text;
  }
  return out;
}

/** The template a declared document follows, and how it came to be the one. */
export interface DeclaredTemplate {
  loaded: LoadedTemplate;
  /** The delivering state whose declaration it is. */
  state: string;
  /** The person chose it on the requirements step (FR3a), rather than it being the only one or the default. */
  chosen: boolean;
  /** The platform rendered the document from recorded data, with no model call (FR9). */
  filled?: boolean;
}

/**
 * THE CONTRACT FOR A DECLARED DOCUMENT, carried in the schema of the argument itself.
 *
 * In the schema rather than only in the prompt because the schema is what the model reads at the moment
 * it writes the argument, on every turn, including the turn that enters a delivering state from one
 * that does not deliver. The delivering instructions in the prompt render for the state a turn STARTS
 * in, so a turn that moved into a delivering step mid-loop never saw them; measured live, its reply
 * opened with a greeting and closed with an offer, and the reply was the file.
 */
const DOCUMENT_ARGUMENT_CONTRACT =
  'The complete deliverable, written for a reader outside this conversation. Required when the move '
  + 'hands over a document: into a step that delivers, or finishing from one. Not passed on a move into a '
  + 'step this tool\'s description says writes its own document. Write the document and '
  + 'nothing else: no greeting, no addressing the person, no offers or questions, and nothing about '
  + 'files, attachments or downloads. Anything you want to say to the person goes in your reply, which '
  + 'posts as chat beside the document.';

/**
 * The advance_task_state tool spec (Converse `toolSpec`, JSON Schema input). The description carries
 * the calling contract — call only at the real milestone, and `resolved` only after the user
 * confirms — so a user-gated transition happens naturally on the assistant's next turn (§3).
 */
export const ADVANCE_TASK_STATE_TOOL_SPEC = {
  toolSpec: {
    name: ADVANCE_TASK_STATE_TOOL_NAME,
    description:
      'Move the active task to a new state. Call this when the conversation has actually reached the ' +
      "milestone — e.g. 'diagnosing' only once you have enough symptoms to analyze, 'resolved' only " +
      'after the user confirms the fix worked. If unsure, do not call it; the task stays where it is.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          to_state: { type: 'string', description: 'Target state (must be reachable from the current state).' },
          reason: { type: 'string', description: 'One sentence: what in the conversation justifies this transition.' },
          // THE DOCUMENT IS AN ARGUMENT, NOT THE REPLY. The reply used to become the file whenever the
          // turn declared a delivery, so whatever the model said to the person - a greeting, an offer,
          // "I can't generate a downloadable file" - shipped inside the document. Declared here, the
          // two are separate by construction: this is packaged, the reply is posted as chat.
          document: {
            type: 'string',
            description: DOCUMENT_ARGUMENT_CONTRACT,
          },
        },
        required: ['to_state', 'reason'],
      },
    },
  },
} as const;

/**
 * The tool for an IN-STATE REWRITE: the task already sits in a delivering state and a follow-up ("add a
 * section on churn") re-produces the whole document with no transition to declare. The document is
 * declared the same way an advance declares it, so the gate never has to guess whether a reply is the
 * document. Offered only while the turn's state delivers.
 */
export const DELIVER_DOCUMENT_TOOL_SPEC = {
  toolSpec: {
    name: DELIVER_DOCUMENT_TOOL_NAME,
    description:
      'Hand over the complete deliverable while the task stays at its current step: the document a '
      + 'step that writes its own document produces once the task is there, or a rewrite after the '
      + 'person asks for a change to the document you already delivered. Call it once, with the whole '
      + 'document. Your reply to the person is separate and posts as chat.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          document: { type: 'string', description: DOCUMENT_ARGUMENT_CONTRACT },
        },
        required: ['document'],
      },
    },
  },
} as const;

/** The set of task tool names, so the loop can recognize a task-tool call cheaply. */
export const TASK_TOOL_NAMES = new Set<string>([ADVANCE_TASK_STATE_TOOL_NAME, DELIVER_DOCUMENT_TOOL_NAME]);

/** True if the task type has a machine (i.e. task tools should be registered this turn). */
export function taskHasMachine(
  taskType: string | undefined,
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
  return Boolean(taskType && machines[taskType]);
}

/**
 * The tool specs to register in the Converse loop for an active task. advance_task_state is offered
 * for every machine-backed task; place_item swaps its work-item proposal for propose_item (§5,
 * migrated in a later step). Returns [] when the task type has no machine.
 */
export function taskToolSpecsFor(
  taskType: string | undefined,
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
  currentState?: string,
  /**
   * Every task this message might be about, when there is more than one. Rendered as an ENUM on
   * `task_id`, so the model's choice is constrained to work this person holds - the same reason the
   * reading tool enumerates message ids rather than accepting a name: a selection that drives
   * process downstream has a deterministic set of outcomes.
   */
  referentCandidateIds?: string[],
  /**
   * WHETHER A DELIVERING STEP WRITES ITS OWN DOCUMENT on its own model (ADR-064 decision B, `documentWrittenOnStep`):
   * the move into it is made without the document, and the document is declared there with `deliver_document`.
   * Absent, every move into a delivering step carries its document.
   */
  documentWrittenOnStep?: (state: string) => boolean,
): Array<typeof ADVANCE_TASK_STATE_TOOL_SPEC> {
  if (!taskHasMachine(taskType, machines)) return [];

  // ── THE MODEL MAY NAME WHICH TASK, WHEN THERE IS MORE THAN ONE (ADR-024 D7) ──────────────
  //
  // The runtime picks a provisional task from the person's open work, and that ranking is a fact
  // about the WORK - which is newest, which is in flight - while the question is which work the
  // MESSAGE is about. Only the model has the message. So it may redirect, and this is the door.
  //
  // AN ENUM, not a free string. The value drives a write to a named row, so the set of outcomes is
  // closed and every member is work this person holds in this conversation. A free field would let
  // an id the model composed - or one a person typed into a message - reach a task lookup.
  //
  // OMITTED ENTIRELY when there is nothing to choose between, so an ordinary single-task turn's tool
  // is exactly what it was. An optional field offered on every turn invites a redirect on turns
  // where there is nowhere to redirect to.
  const choices = (referentCandidateIds ?? []).filter((id) => typeof id === 'string' && id);
  const withReferentChoice = <T extends typeof ADVANCE_TASK_STATE_TOOL_SPEC>(spec: T): T => (
    choices.length < 2 ? spec : {
      ...spec,
      toolSpec: {
        ...spec.toolSpec,
        inputSchema: {
          json: {
            ...spec.toolSpec.inputSchema.json,
            properties: {
              ...spec.toolSpec.inputSchema.json.properties,
              task_id: {
                type: 'string',
                enum: choices,
                description:
                  'Which piece of their open work this message is about. Several are open, so name the '
                  + 'one you are moving. Omit it only when you mean the one the turn is already on. If '
                  + 'you cannot tell which they meant, do not call this tool at all - ask them.',
              },
            },
          },
        },
      },
    } as T);
  // THE STEP'S DECLARED NEEDS RIDE IN THE TOOL ITSELF when it has any (SPEC-TASK-STATE-TRANSITIONS
  // §4). Until now the tool was STATE-BLIND: its inputs were `to_state` and a free-text `reason`, and
  // its description said nothing about what the current step needs - so "I have all the data I need"
  // satisfied `reason` completely, and the checklist rendered in the prompt was the only thing asking.
  // A checklist the caller never has to answer is a checklist the caller can skip.
  //
  // AND THE ANSWERS ARE RECORDED, which is the half that makes this more than a nag. `collected`
  // becomes `task.details.requirements`, with each need's source and evidence under
  // `task.details.collectedRequirements`, so what the person actually said - the audience, the length -
  // is agreed ONCE and readable afterwards by every consumer: the delivering check that compares the
  // document against it, the revision branch, and anyone auditing why a document looks the way it
  // does. The alternative is re-deriving the agreement from prose on every read, which makes a
  // contract out of a sentence someone happened to type.
  const machine = machines[taskType as string];
  const def = currentState ? machine?.states?.[currentState] : undefined;
  // A DELIVERING STEP IS OFFERED THE DECLARATION FOR A REWRITE. Without it a follow-up inside the step
  // has no structural way to say "this is the document", and the gate is back to guessing from the
  // reply's shape.
  // WHICH MOVES FROM HERE HAND OVER A DOCUMENT, named in the description, because the `document`
  // argument is required on exactly those and a model cannot see the machine. Read through the same
  // `edgeDelivers` the handler and the delivery gate use. A move into a step that writes its own document
  // (ADR-064 decision B) is named apart: it is made without the document, which that step's model writes.
  const deliveringEdges = currentState && machine
    ? (def?.transitions ?? []).filter((to) => edgeDelivers(machine, currentState, to))
    : [];
  const writtenThere = deliveringEdges.filter((to) => deliversDocument(machine?.states?.[to]) && Boolean(documentWrittenOnStep?.(to)));
  const deliveringMoves = deliveringEdges.filter((to) => !writtenThere.includes(to));
  // THE DECLARATION IS OFFERED where the step delivers, and where a move from it enters a step that writes its own
  // document: the turn moves onto that step's model, which declares the document with it.
  const rewriteTool = deliversDocument(def) || writtenThere.length
    ? [DELIVER_DOCUMENT_TOOL_SPEC as unknown as typeof ADVANCE_TASK_STATE_TOOL_SPEC]
    : [];
  const deliveringNote = (deliveringMoves.length
    ? ` Moving to ${deliveringMoves.map((s) => `"${s}"`).join(' or ')} hands over the finished document: `
      + 'pass it whole in `document`.'
    : '')
    + (writtenThere.length
      ? ` Moving to ${writtenThere.map((s) => `"${s}"`).join(' or ')} starts the step that writes the document, on a `
        + 'model of its own: make the move without `document`. Once the task is there, the document is written and '
        + `passed whole with \`${DELIVER_DOCUMENT_TOOL_NAME}\`.`
      : '');
  // ── A CHOICE OF DOCUMENT FORMAT, WHEN THE WORKFLOW OFFERS ONE (SPEC-DOCUMENT-TEMPLATES FR3a) ─────
  //
  // An ENUM of the declared template names, so what the person picked is a member of a closed set the
  // workflow wrote, never a name the model composed. It carries its source and evidence like every
  // need, and on the requirements step of a choice with no default it is required: the step is not left
  // until somebody chose. Offered on every advance of such a machine, so a revision can record a new one.
  const choice = templateChoiceOf(machine);
  const withTemplateChoice = <T extends typeof ADVANCE_TASK_STATE_TOOL_SPEC>(spec: T): T => {
    if (!choice) return spec;
    const mustChoose = currentState === choice.step && !choice.defaultName;
    const json = spec.toolSpec.inputSchema.json as unknown as { properties: Record<string, unknown>; required: string[] };
    return {
      ...spec,
      toolSpec: {
        ...spec.toolSpec,
        description: `${spec.toolSpec.description} The document comes in a format the person chooses: `
          + `${choice.names.map((n) => `"${n}"`).join(', ')}. Record their choice in \`template\` with where it came from`
          + (choice.defaultName ? `; with no choice, "${choice.defaultName}" is used.` : '; it is required before this step is left.'),
        inputSchema: {
          json: {
            ...json,
            properties: {
              ...json.properties,
              template: {
                type: 'object',
                description: 'The document format the person chose, from the formats this workflow offers.',
                properties: {
                  name: { type: 'string', enum: [...choice.names], description: 'Which format.' },
                  source: {
                    type: 'string',
                    enum: [...REQUIREMENT_SOURCES],
                    description: '`message` when the person said it, `context` when a passage retrieved this turn supplied it.',
                  },
                  evidence: { type: 'string', description: 'A short quote of their words, or the passage or source id.' },
                },
                required: ['name', 'source', 'evidence'],
              },
            },
            required: mustChoose ? [...json.required, 'template'] : json.required,
          },
        },
      },
    } as unknown as T;
  };
  const requires = def?.requires ?? [];
  // THE BRIEF A MOVE FROM HERE CAN CARRY PAST A CONFIRMED STEP (ADR-064 decision G) is recorded at this step, so its
  // needs are members of the same enum, and a model that follows the schema can record the brief the direct edge checks
  // for. They are offered and never required: a request without them takes the confirmed step instead.
  const briefNeeds = currentState
    ? briefNeedsPastConfirm(taskType as string, currentState, machines).filter((n) => !requires.includes(n))
    : [];
  const needs = [...requires, ...briefNeeds];
  if (!needs.length) {
    const plain = deliveringNote
      ? {
        toolSpec: {
          ...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec,
          description: `${ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.description}${deliveringNote}`,
        },
      } as unknown as typeof ADVANCE_TASK_STATE_TOOL_SPEC
      : ADVANCE_TASK_STATE_TOOL_SPEC;
    return [withTemplateChoice(withReferentChoice(plain)), ...rewriteTool];
  }

  const quoted = (names: string[]) => names.map((r) => `"${r}"`).join(', ');
  const needsNote = requires.length
    ? ` This step needs ${quoted(requires)}. Account for `
      + 'each one in `collected` with the value, where it came from, and the evidence: `message` with '
      + 'a short quote of what the person said, or `context` with the retrieved passage or source id '
      + 'it came from. A need with neither is still missing: do not call this tool, ask them for it.'
    : '';
  const briefNote = briefNeeds.length
    ? ` Going straight past the confirmed step also needs its brief, ${quoted(briefNeeds)}: record each one in `
      + '`collected` as an entry of its own, the same way.'
    : '';
  return [withTemplateChoice(withReferentChoice({
    toolSpec: {
      ...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec,
      description: `${ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.description}${needsNote}${briefNote}${deliveringNote}`,
      inputSchema: {
        json: {
          ...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.inputSchema.json,
          properties: {
            ...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.inputSchema.json.properties,
            collected: {
              type: 'array',
              description: `One entry for each of this step's needs (${quoted(needs)}), each with its source.`,
              items: {
                type: 'object',
                properties: {
                  // AN ENUM OF THE STEP'S DECLARED NEEDS, so matching an answer to its need is a
                  // lookup and never a comparison of two pieces of prose.
                  need: { type: 'string', enum: [...needs], description: 'Which need this answers.' },
                  value: { type: 'string', description: 'What is being taken for it.' },
                  // WHERE IT CAME FROM, and there is no third answer. A need the model filled in
                  // itself is a guess presented as an agreement - measured live, an extraction
                  // "confirmed" a data source nobody had named - so the schema has no way to say it.
                  source: {
                    type: 'string',
                    enum: [...REQUIREMENT_SOURCES],
                    description: '`message` when the person said it, `context` when it came from a '
                      + 'passage you retrieved this turn.',
                  },
                  evidence: {
                    type: 'string',
                    description: 'For `message`, a short quote of the person\'s words that supply it. '
                      + 'For `context`, the retrieved passage or the source id it came from.',
                  },
                  // THE MODEL NORMALIZES, BECAUSE THE MODEL IS WHAT UNDERSTANDS THE ANSWER. A person
                  // says "1-2 pages", "a page or two", "keep it short"; turning any of those into a
                  // number is language work, and doing it downstream with a pattern means the runtime
                  // guessing at English it never saw in context. Recorded once here, every later
                  // reader gets a number instead of a sentence to re-interpret.
                  //
                  // Optional on purpose: absent means no size was agreed, which is a real answer to
                  // "the length or format" (a person may only name the format). Nothing is enforced
                  // then - an absent agreement is not a violation, and a guessed one is worse than none.
                  minWords: {
                    type: 'integer',
                    description: 'Only when this requirement fixes a SIZE: the fewest words that '
                      + 'satisfies what the person asked for. A page is roughly 300-900 words '
                      + 'depending on how much of it is tables and lists. Omit if no size was agreed.',
                  },
                  maxWords: {
                    type: 'integer',
                    description: 'Only when this requirement fixes a SIZE: the most words that still '
                      + 'satisfies it. Omit if no size was agreed.',
                  },
                  // SHOWN TO THE PERSON, so it has to be the size and nothing else. The value of the
                  // requirement is a whole answer - at `drafting_outline` it is "approval of the
                  // outline, or what to change about it", so a size can arrive inside "Looks good, but
                  // can you make it 1-2 pages?". Rendering that back produced "Trimming the report to
                  // Looks good, but can you make it 1-2 pages?...". The label is asked for separately
                  // rather than extracted, because extracting it would be a pattern reading English
                  // (tenet D11); absent, the numbers are shown instead.
                  sizeLabel: {
                    type: 'string',
                    description: 'Only with minWords/maxWords: how to NAME that size to the person, in '
                      + 'their own words and nothing else - "1-2 pages", "a short summary". Not a '
                      + 'sentence, and never the whole of what they said.',
                  },
                },
                required: ['need', 'value', 'source', 'evidence'],
              },
            },
          },
          required: requires.length
            ? [...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.inputSchema.json.required, 'collected']
            : ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.inputSchema.json.required,
        },
      },
    },
  } as unknown as typeof ADVANCE_TASK_STATE_TOOL_SPEC)), ...rewriteTool];
}

/**
 * The `template` tool input as a recorded choice: a declared name, a source from `REQUIREMENT_SOURCES`
 * and non-empty evidence. Structural, like `collectedRequirements`: a closed enum and a present string.
 * `invalid` when an input was given and is not one, so the refusal can say why.
 */
export function templateChoiceInput(
  input: unknown,
  names: string[],
): { name: string; entry: CollectedRequirement } | { invalid: true } | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') return { invalid: true };
  const { name, source, evidence } = input as Record<string, unknown>;
  if (typeof name !== 'string' || !names.includes(name.trim())) return { invalid: true };
  if (typeof source !== 'string' || !(REQUIREMENT_SOURCES as readonly string[]).includes(source)) return { invalid: true };
  if (typeof evidence !== 'string' || !evidence.trim()) return { invalid: true };
  return {
    name: name.trim(),
    entry: { value: name.trim(), source: source as RequirementSource, evidence: evidence.trim().slice(0, 500) },
  };
}

/**
 * THE TEMPLATE A DELIVERING STATE USES FOR THIS TASK, AS LOADED, or the named reason it cannot be used.
 * `none` when the state declares no template. Read through `resolveStateTemplate`, so the choice is the
 * recorded one, else the default, and never one the model or the runtime picks.
 */
export function templateForDelivery(args: {
  machine: TaskStateMachine | undefined;
  state: string;
  details: Record<string, unknown> | undefined;
  templates: TurnTemplates | undefined;
}):
  | { none: true }
  | { ok: true; loaded: LoadedTemplate; chosen: boolean }
  | { ok: false; error: 'template_unavailable' | 'requirement_unsourced'; message: string } {
  const resolvedRef = resolveStateTemplate(args.machine, args.state, args.details);
  if (!resolvedRef) return { none: true };
  if ('choiceRequired' in resolvedRef) {
    return {
      ok: false,
      error: 'requirement_unsourced',
      message: `This document comes in a format the person chooses (${resolvedRef.names.map((n) => `"${n}"`).join(', ')}), `
        + 'and no choice is recorded. Ask them which, and record it in `template`.',
    };
  }
  const loaded = args.templates?.[templateRefKey(resolvedRef.ref)];
  if (!isLoadedTemplate(loaded)) {
    return {
      ok: false,
      error: 'template_unavailable',
      message: `The "${resolvedRef.ref.name}" template this step's document follows could not be loaded`
        + `${loaded ? ` (${loaded.error})` : ''}. Do not deliver the document now; tell the person it cannot be `
        + 'produced in its required format at the moment.',
    };
  }
  return { ok: true, loaded, chosen: resolvedRef.chosen };
}

/** A number, or a numeric string a model sent where an integer was asked for. Anything else is null. */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The `collected` tool input, as the maps recorded on the task.
 *
 * Tolerant of SHAPE because a model supplies it: a non-array, a non-object entry, or a blank need or
 * value is dropped rather than written. `need` is the field the schema asks for; `requirement` is read
 * too, the name the field had before needs carried their source, so an input in the earlier shape still
 * records its values.
 *
 * WHAT IS RECORDED, AND WHAT IS BINDING, ARE TWO DIFFERENT MAPS. `requirements` is every value given,
 * keyed by need, the shape every existing reader of `details.requirements` takes. `sourced` holds only
 * the entries that name a source from `REQUIREMENT_SOURCES` and carry non-empty evidence, and it is what
 * the handler checks a step's `requires` against. The check is structural, a closed enum and a present
 * string, and never a reading of what the evidence says (tenet D11).
 */
export function collectedRequirements(
  input: unknown,
): {
  requirements: Record<string, string>;
  sourced: Record<string, CollectedRequirement>;
  lengthTarget?: RecordedLengthTarget;
} | undefined {
  if (!Array.isArray(input)) return undefined;
  const requirements: Record<string, string> = {};
  const sourced: Record<string, CollectedRequirement> = {};
  let lengthTarget: RecordedLengthTarget | undefined;

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const { need: rawNeed, requirement: legacyName, value, source, evidence, minWords, maxWords, sizeLabel } =
      entry as Record<string, unknown>;
    const requirement = typeof rawNeed === 'string' ? rawNeed : legacyName;
    if (typeof requirement !== 'string' || typeof value !== 'string') continue;
    if (!requirement.trim() || !value.trim()) continue;
    requirements[requirement.trim()] = value.trim();
    if (
      typeof source === 'string' && (REQUIREMENT_SOURCES as readonly string[]).includes(source)
      && typeof evidence === 'string' && evidence.trim()
    ) {
      sourced[requirement.trim()] = {
        value: value.trim(),
        source: source as RequirementSource,
        // Bounded: evidence is a quote or a source id, and it is stored on the task row.
        evidence: evidence.trim().slice(0, 500),
      };
    }

    // A SIZE IS A PAIR OR IT IS NOTHING. One bound alone cannot say what satisfies the person: a
    // minimum with no maximum admits a document ten times what they asked for, and a maximum alone
    // admits an empty one. Half an agreement is not an agreement, so it is discarded rather than
    // half-enforced. Same for a reversed or non-positive pair - a model produced it, and a bound that
    // makes no sense is noise, not data.
    // A NUMBER MAY ARRIVE AS A NUMERIC STRING. `"600"` is an ordinary model output for an integer
    // field, and discarding it silently threw away a real agreement. Coercing a numeric string is
    // arithmetic, not a language judgement: anything that is not a number after coercion is refused.
    const min = toFiniteNumber(minWords);
    const max = toFiniteNumber(maxWords);
    const boundsOffered = minWords !== undefined || maxWords !== undefined;

    if (min !== null && max !== null && min > 0 && max >= min) {
      // The FIRST size wins if a model marks two requirements as sizes: the alternative is picking by
      // a rule nobody declared. One step, one agreed size.
      const label = typeof sizeLabel === 'string' ? sizeLabel.trim() : '';
      lengthTarget ??= {
        minWords: Math.round(min),
        maxWords: Math.round(max),
        // The LABEL, never the whole answer: this is rendered to the person while the document is
        // being corrected. Bounded, because a model asked for a short phrase can still send a
        // paragraph, and a progress line is not the place to find that out.
        source: label && label.length <= 60 ? label : `${Math.round(min)}-${Math.round(max)} words`,
      };
    } else if (boundsOffered) {
      // BOUNDS WERE OFFERED AND REFUSED, which is not the same as no size being agreed - and at
      // delivery the two look identical (`agreed: 'not recorded'`). Said here, where the discard
      // happens, so a malformed pair is findable instead of looking like a person who named no size.
      console.warn('[TaskTools] size bounds discarded as unusable', {
        requirement: requirement.trim(), minWords, maxWords,
      });
    }
  }
  if (!Object.keys(requirements).length) return undefined;
  return { requirements, sourced, ...(lengthTarget ? { lengthTarget } : {}) };
}

/**
 * The guidance an advance hands back for the state it landed in: the turn's own rendering when the loop
 * supplied one, otherwise the state's declared `prompt` and, on a delivering state, the delivering
 * contract. Empty when there is nothing to say.
 */
function guidanceForState(
  taskType: string,
  state: string,
  machines: Record<string, TaskStateMachine>,
  guidanceFor?: (taskType: string, state: string, details?: Record<string, unknown>) => string,
  details?: Record<string, unknown>,
): string {
  if (guidanceFor) {
    try {
      return guidanceFor(taskType, state, details).trim();
    } catch (err) {
      console.warn('[TaskTools] state guidance could not be rendered; using the declared prompt', err);
    }
  }
  const def = machines[taskType]?.states?.[state];
  return [def?.prompt?.trim() ?? '', deliversDocument(def) ? deliveringContract().trim() : '']
    .filter(Boolean).join('\n\n');
}

/**
 * THE ADVANCE RESULTS THAT ARE A REFUSAL BY THE WORKFLOW'S OWN DECLARATIONS, not a failure: a target
 * the machine does not declare, an edge its graph does not hold, and the three declared preconditions
 * below. The payload carries the code again as `refusal`, the structured marker the loop records as
 * `workflow_refusal` (analytics-metadata.ts `toolStepOutcome`), so the tool-error rate counts what
 * failed rather than what the workflow forbade. `persist_failed`, `state_changed` and `no_active_task`
 * are not here: nothing declared refused those, something went wrong.
 */
const WORKFLOW_REFUSALS: ReadonlySet<string> = new Set([
  'unknown_state', 'illegal_transition',
  'opening_step_must_be_presented', 'requirement_unsourced', 'document_required',
  'template_unavailable', 'template_unbound_field',
  'action_unbound_arg', 'tool_not_in_step', 'condition_not_met', 'required_tool_not_run',
  'brief_not_in_request', 'brief_incomplete',
]);

/** A refusal that changes nothing, in the shape the loop reads: the payload the model sees, and the result. */
function refusal(
  error: 'opening_step_must_be_presented' | 'requirement_unsourced' | 'document_required'
    | 'template_unavailable' | 'template_unbound_field' | 'action_unbound_arg' | 'required_tool_not_run'
    | 'brief_not_in_request' | 'brief_incomplete',
  from: string | undefined,
  message: string,
  extra: Record<string, unknown> = {},
): { payload: Record<string, unknown>; result: AdvanceResult } {
  return {
    payload: { ok: false, error, refusal: error, ...(from ? { from } : {}), message, ...extra },
    result: { ok: false, error, ...(from ? { from } : {}) },
  };
}

/**
 * Handle an advance_task_state tool call: authorize + persist via advanceTaskStateTo, then format
 * the JSON the model reads back. On `illegal_transition` / `unknown_state` the legal set is echoed
 * as `legal_transitions` so the model can self-correct in the same loop iteration without any state
 * change (§3). Returns the structured `result` too, so the loop can update its local task state and
 * record the transition for analytics.
 *
 * THREE DECLARATIONS ON THE MACHINE ARE ENFORCED HERE, before anything is written, and each refusal
 * is an error the model reads and recovers from in the same loop:
 *  - `presented` on the current state: it may not be left on the turn it was entered
 *    (`opening_step_must_be_presented`);
 *  - `requires` on the current state: every need is accounted for with a source and evidence
 *    (`requirement_unsourced`);
 *  - a move that hands over a document (`edgeDelivers`): the document is declared in `document`
 *    (`document_required`).
 * Every one is read from the machine the turn resolved for the task's intent, so a workflow that
 * declares the property gets it enforced and one that omits it is left to the model's judgement.
 */
export async function handleAdvanceTaskStateTool(args: {
  task: Task;
  input: Record<string, unknown>;
  machines?: Record<string, TaskStateMachine>;
  messageId?: string;
  /** The assistant running this turn, so a task can be handed back when it stops awaiting the user. */
  assistantId?: string;
  /**
   * The task's CURRENT state was entered on this turn: the turn created the task there, or an advance
   * earlier in this turn moved it there. Structural, from the loop's own record (`TaskLoopContext`).
   */
  stateEnteredThisTurn?: boolean;
  /** A document was already declared this turn (`deliver_document`), so a finishing move needs none. */
  documentAlreadyDeclared?: boolean;
  /**
   * WHETHER A DELIVERING STEP THIS MOVE ENTERS WRITES ITS OWN DOCUMENT on a model other than the one making the move
   * (ADR-064 decision B, `documentWrittenOnStep`). Such a move is accepted without the document, and a document passed
   * with it anyway is not declared: the step's model writes it with `deliver_document`. A platform-filled template is
   * still rendered on the move, since no model writes it.
   */
  documentWrittenOnStep?: (state: string) => boolean;
  /** The turn's rendering of a state's guidance, returned with an advance into that state. */
  guidanceFor?: (taskType: string, state: string, details?: Record<string, unknown>) => string;
  /** The templates the task's machine declares, loaded for this turn (`TaskLoopContext.templates`). */
  templates?: TurnTemplates;
  /** What the turn's resolver holds (`TaskLoopContext.variables`): the machine's conditions decide on it. */
  variables?: TurnVariables;
}): Promise<{
  payload: Record<string, unknown>;
  result: AdvanceResult;
  /** What was written to `task.details`, so the caller can refresh its in-memory task. */
  details?: Record<string, unknown>;
  /** The document this advance declared, when it declared one and the advance was applied. */
  document?: string;
  /** The template that document follows, when the delivering step declares one. */
  template?: DeclaredTemplate;
}> {
  const toState = typeof args.input.to_state === 'string' ? args.input.to_state.trim() : '';
  const reason = typeof args.input.reason === 'string' ? args.input.reason : undefined;
  const machines = args.machines ?? DEFAULT_TASK_STATE_MACHINES;
  const taskType = args.task.taskType ?? '';
  const machine = machines[taskType];
  const from = args.task.taskState;
  const fromDef = from ? machine?.states?.[from] : undefined;

  if (!toState) {
    const result: AdvanceResult = { ok: false, error: 'unknown_state', from: args.task.taskState };
    return {
      payload: { ok: false, error: 'unknown_state', message: 'to_state is required' },
      result,
    };
  }

  // RECORDED ON THE TRANSITION, not on the turn: the values belong to the step the person answered,
  // and `advanceTaskStateTo` merges them into `task.details` so a later step cannot lose an earlier
  // one's answers. Written under `requirements` so the map is addressable rather than spread across
  // details' top level, where a state-specific key could collide with it.
  const collected = collectedRequirements(args.input.collected);
  const document = typeof args.input.document === 'string' ? args.input.document.trim() : '';
  // THE FORMAT THE PERSON CHOSE, when the workflow offers a choice (SPEC-DOCUMENT-TEMPLATES FR3a).
  const choice = templateChoiceOf(machine);
  const chosenTemplate = choice ? templateChoiceInput(args.input.template, choice.names) : undefined;
  const validChoice = chosenTemplate && !('invalid' in chosenTemplate) ? chosenTemplate : undefined;

  // Built once and RETURNED, so the caller can put it back on its in-memory task. A step that
  // collects a requirement and delivers later in the SAME turn would otherwise check the document
  // against a snapshot taken before the tool ran, find no agreement, and enforce nothing on the very
  // turn the agreement was made.
  //
  // `collectedRequirements` holds each need with its source and evidence, so what an agreement rests
  // on is readable afterwards. `requirements` keeps the plain value map every earlier reader takes,
  // and a stored task written before needs carried their source simply has no `collectedRequirements`.
  // A recorded format choice is one more need, under `template`, so a revision keeps it until a new
  // one is recorded.
  const sourced = {
    ...(collected?.sourced ?? {}),
    ...(validChoice ? { template: validChoice.entry } : {}),
  };
  const mergedDetails = collected || validChoice
    ? {
      requirements: {
        ...(args.task.details?.requirements as Record<string, string> ?? {}),
        ...(collected?.requirements ?? {}),
        ...(validChoice ? { template: validChoice.name } : {}),
      },
      ...(Object.keys(sourced).length
        ? {
          collectedRequirements: {
            ...(args.task.details?.collectedRequirements as Record<string, CollectedRequirement> ?? {}),
            ...sourced,
          },
        }
        : {}),
      // The agreed SIZE, stored as the numbers the model resolved it to. A later step that agrees
      // a new size replaces it; one that agrees none leaves the earlier agreement standing, which
      // is what a person would expect from having said it once.
      ...(collected?.lengthTarget ? { lengthTarget: collected.lengthTarget } : {}),
    }
    : undefined;
  // What the task will have recorded once this advance lands: what a delivering step reads its template
  // choice and its platform fill from.
  const detailsAfter: Record<string, unknown> = { ...(args.task.details ?? {}), ...(mergedDetails ?? {}) };
  let effectiveDocument = document;
  let template: DeclaredTemplate | undefined;
  // The move enters a delivering step that writes its own document on its own model (ADR-064 decision B).
  let writtenOnStep = false;

  // ── THE DECLARATIONS ARE CHECKED ONLY ON A MOVE THE GRAPH ALLOWS ─────────────────────────────────
  //
  // An illegal or unknown target is the store's refusal to make, with the legal set echoed back. Asking
  // for a document or a source on a move that cannot happen anyway would send the model off to fix the
  // wrong thing.
  // THE MACHINE'S CONDITIONS DECIDE ON WHAT THE TURN'S RESOLVER READ (ADR-060 decision 6), here and in the store.
  const conditionValues = turnConditionValues({ task: args.task, machines, variables: args.variables });
  const authz = from && machine ? authorizeTransition(taskType, from, toState, machines, { by: 'tool', conditionValues }) : null;
  if (authz?.ok && from) {
    // A PRESENTED STEP IS PUT TO THE PERSON FIRST. Measured live: an extraction's first turn advanced
    // out of requirements on its own say-so, claiming a data source nobody had named, and delivered a
    // table the person never saw the terms of. The step was declared a checkpoint by nothing, so
    // nothing held it.
    if (fromDef?.presented && args.stateEnteredThisTurn) {
      return refusal('opening_step_must_be_presented', from,
        `"${from}" is put to the person before the task leaves it, and it was entered on this turn. `
        + 'Do not advance now. In your reply, present the step: what you are taking for each need and '
        + 'where it came from (their words, or the named source), or what you found, and ask them to '
        + 'confirm or correct it. Their reply is what moves it on.');
    }

    // A MOVE PAST A CONFIRMED STEP CARRIES ITS BRIEF (ADR-064 decision G). Only from a step this turn entered, so the
    // request itself carried the brief, and only where every need of the brief is recorded once this move lands. The
    // model judged completeness from the person's words and recorded it; this compares names, never words (D11).
    if (!authz.reopen) {
      const direct = directEdgeRefusal(machine, from, toState, detailsAfter, { enteredThisTurn: Boolean(args.stateEnteredThisTurn) });
      if (direct?.error === 'brief_not_in_request') {
        return refusal('brief_not_in_request', from,
          `Going straight to "${toState}" skips "${direct.step}", which is only for a request that arrived with the `
          + `complete brief, and "${from}" was entered on an earlier turn. Advance to "${direct.step}" and put the brief `
          + 'to the person.', { step: direct.step });
      }
      if (direct) {
        return refusal('brief_incomplete', from,
          `Going straight to "${toState}" skips "${direct.step}", so every part of the brief is recorded in \`collected\` `
          + `with its source and evidence: ${direct.missing.map((n) => `"${n}"`).join(', ')} ${direct.missing.length === 1 ? 'is' : 'are'} `
          + `not. If the person gave ${direct.missing.length === 1 ? 'it' : 'them'}, record ${direct.missing.length === 1 ? 'it' : 'them'} and call again; `
          + `otherwise ask for what is missing, or advance to "${direct.step}".`, { step: direct.step, missing: direct.missing });
      }
    }

    // A STEP'S REQUIRED TOOLS RAN (ADR-064 decision 3): each returned success since the task last entered the step.
    const notRun = authz.reopen ? [] : requiredToolsNotRun(args.task, from, fromDef?.requiresTool);
    if (notRun.length) {
      return refusal('required_tool_not_run', from,
        '"' + from + '" requires ' + notRun.join(', ') + ' to have run before the task leaves it, and it has not run '
        + 'since the task entered this step. Call it, then advance.', { tool: notRun[0], tools: notRun });
    }

    // A STEP'S NEEDS ARE ACCOUNTED FOR WITH THEIR SOURCE. Only an ordinary move out of the step: a
    // reopen leaves a terminal state, which declares no needs.
    const requires = authz.reopen ? undefined : fromDef?.requires;
    const missing = (requires ?? []).filter((need) => !collected?.sourced[need]);
    // THE FORMAT IS A NEED OF THE REQUIREMENTS STEP when the workflow offers a choice with no default:
    // the step is not left until somebody chose. An input that is not a declared name with a source and
    // evidence is refused wherever it is given, rather than recorded or ignored.
    if (choice && chosenTemplate && 'invalid' in chosenTemplate) {
      missing.push('template');
    } else if (
      choice && !authz.reopen && from === choice.step && !choice.defaultName
      && !validChoice && !recordedTemplateChoice(args.task.details)
    ) {
      missing.push('template');
    }
    if (missing.length) {
      return refusal('requirement_unsourced', from,
        'Every need of this step is accounted for in `collected` with where it came from: `message` '
        + 'with a short quote of what the person said, or `context` with the retrieved passage or '
        + 'source id. A need nobody supplied is still missing - ask the person for it instead of '
        + 'advancing.'
        + (missing.includes('template') && choice
          ? ` The format is recorded in \`template\`: one of ${choice.names.map((n) => `"${n}"`).join(', ')}, with its source and evidence.`
          : ''),
        { missing });
    }

    // A MOVE THAT HANDS OVER A DOCUMENT DECLARES IT. Finishing from a delivering step needs none when
    // the document already went out: declared earlier this turn, or delivered from this step before
    // (`task.deliveries`), which is the person confirming a document they already have.
    if (edgeDelivers(machine, from, toState)) {
      const enteringDelivery = deliversDocument(machine?.states?.[toState]);
      writtenOnStep = enteringDelivery && Boolean(args.documentWrittenOnStep?.(toState));
      const alreadyHandedOver = args.documentAlreadyDeclared
        || (args.task.deliveries ?? []).some((d) => d.fromState === from);
      const handsOver = enteringDelivery || !alreadyHandedOver || Boolean(document);

      // ── THE TEMPLATE THE DELIVERING STEP DECLARES (SPEC-DOCUMENT-TEMPLATES FR3-FR5, FR9) ─────────
      //
      // Resolved from the recorded choice, else the default. A template that could not be loaded
      // refuses the move with its reason rather than delivering a document in no declared shape; a
      // platform-filled one IS the document, rendered here from what the task recorded, with no
      // model call, and a field nothing recorded refuses the delivery rather than shipping a gap.
      if (handsOver) {
        const deliveringState = enteringDelivery ? toState : from;
        const t = templateForDelivery({ machine, state: deliveringState, details: detailsAfter, templates: args.templates });
        if ('ok' in t && !t.ok) {
          return refusal(t.error, from, t.message, t.error === 'requirement_unsourced' ? { missing: ['template'] } : {});
        }
        if ('ok' in t && t.ok) {
          if (t.loaded.template.fill === 'platform') {
            const filled = fillTemplate(t.loaded.template, detailsAfter);
            if (!filled.ok) {
              return refusal('template_unbound_field', from, filled.message, { field: filled.field, binding: filled.binding });
            }
            effectiveDocument = filled.document;
            template = { loaded: t.loaded, state: deliveringState, chosen: t.chosen, filled: true };
          } else if (!writtenOnStep) {
            template = { loaded: t.loaded, state: deliveringState, chosen: t.chosen };
          }
        }
      }

      // THE STEP WRITES ITS OWN DOCUMENT: the move needs none, and one passed with it is not declared, because the
      // step's model writes the document the person receives (ADR-064 decision B).
      if (writtenOnStep && !template?.filled) effectiveDocument = '';

      if (!effectiveDocument && !writtenOnStep && (enteringDelivery || !alreadyHandedOver)) {
        return refusal('document_required', from,
          `Moving to "${toState}" hands over the finished document. Call again with the complete `
          + 'deliverable in `document`, written for a reader outside this conversation: no greeting, '
          + 'no offers or questions, nothing about files. What you say to the person goes in your reply.');
      }
    }

    // A STEP THE PLATFORM RUNS IS ENTERED ONLY WHEN IT CAN RUN (SPEC-TASK-STATE-TRANSITIONS FR29). Its
    // action's arguments bind to what the task will have recorded once this move lands; an argument
    // nothing recorded refuses the move by name, so the model collects it instead of the platform
    // running the tool on a gap.
    const targetAction = authz.reopen ? undefined : machine?.states?.[toState]?.action;
    if (targetAction) {
      const bound = bindActionArgs(targetAction, detailsAfter, args.variables);
      if (!bound.ok) {
        return refusal('action_unbound_arg', from,
          `"${toState}" runs ${targetAction.tool} as soon as the task enters it, and its argument "${bound.arg}" `
          + `(${bound.binding}) has nothing recorded. Collect it from the person, with its source, before moving there.`,
          { arg: bound.arg, binding: bound.binding });
      }
    }
  }

  const result = await advanceTaskStateTo({
    task: args.task,
    toState,
    by: 'tool',
    reason,
    messageId: args.messageId,
    machines,
    conditionValues,
    ...(mergedDetails ? { details: mergedDetails } : {}),
    ...(args.assistantId ? { assistantId: args.assistantId } : {}),
  });

  // ── THE ANSWER SAYS WHETHER THE WORK IS FINISHED, POSITIVELY ────────────────────────────────────
  //
  // `terminal` was present only when the task HAD finished, so "not finished" was an absent key - and
  // a model does not notice an absence. Measured live: a `data_extraction` task took three advances,
  // each one reported to the person as "closed", and the row sat at `formatting` one step short of
  // `completed`. The tool had answered `to: 'formatting'` with no `terminal` every time, which was
  // true and said nothing the model acted on.
  //
  // `finished` is therefore always present, and when it is false the answer names what is still
  // ahead. A turn that reads `finished: false` and writes "closed" is contradicting a field it was
  // handed, which is a different kind of mistake from overlooking one that was not there.
  const nextStates = result.ok && result.to
    ? (machine?.states?.[result.to]?.transitions ?? [])
    : [];
  // ── THE NEW STEP'S INSTRUCTIONS ARRIVE WITH THE MOVE ───────────────────────────────────────────
  //
  // The prompt describes the state the turn STARTED in. A turn that advances mid-loop is then writing
  // for a step whose instructions it never saw, which is how a reply written under requirements-
  // gathering guidance became a delivered document. The result carries the landed state's guidance,
  // and says positively when that state delivers.
  const landedDelivers = result.ok ? deliversDocument(machine?.states?.[result.to]) : false;
  const guidance = result.ok ? guidanceForState(taskType, result.to, machines, args.guidanceFor, detailsAfter) : '';
  const payload: Record<string, unknown> = result.ok
    ? {
      ok: true,
      from: result.from,
      to: result.to,
      finished: Boolean(result.terminal),
      ...(result.terminal ? { terminal: result.terminal } : {}),
      // Said positively, for the reason `finished` is: the finished task is running again.
      ...(result.reopened ? { reopened: true } : {}),
      // Only when there is somewhere left to go: on a terminal state an empty list would read as a
      // dead end the model has to interpret, and `finished: true` has already said it.
      ...(result.terminal || nextStates.length === 0 ? {} : { next_states: nextStates }),
      ...(landedDelivers ? { delivers: true } : {}),
      ...(effectiveDocument ? { document_received: true } : {}),
      // SAID POSITIVELY, for the reason `finished` is: the move carried no document, and the step writes it now.
      ...(writtenOnStep && !effectiveDocument
        ? {
          writes_document: true,
          next: `The task is at "${result.to}" and the move carried no document. Write the complete deliverable now `
            + `and pass it whole with ${DELIVER_DOCUMENT_TOOL_NAME}; the task stays at this step. Then write your reply `
            + 'to the person.',
        }
        : {}),
      ...(template?.filled ? { document_filled_by_platform: true } : {}),
      ...(guidance ? { guidance } : {}),
    }
    : {
        ok: false,
        error: result.error,
        ...(WORKFLOW_REFUSALS.has(result.error) ? { refusal: result.error } : {}),
        ...(result.from ? { from: result.from } : {}),
        ...(result.legal ? { legal_transitions: result.legal } : {}),
        // Said without the value that decided it (ADR-060 decision 6): the move is refused, and where it may go is listed.
        ...(result.error === 'condition_not_met'
          ? { message: `The workflow does not move to "${toState}" in this conversation: a condition on that step does not hold. Move to one of legal_transitions instead.` }
          : {}),
      };
  return {
    payload,
    result,
    ...(mergedDetails ? { details: mergedDetails } : {}),
    ...(result.ok && effectiveDocument ? { document: effectiveDocument } : {}),
    ...(result.ok && template ? { template } : {}),
  };
}

/**
 * WHAT A REPLAYED ADVANCE DECLARES (SPEC-DOCUMENT-TEMPLATES FR6, FR9).
 *
 * A retried model call replays the advances its first attempt already wrote, and the loop answers those
 * from the record without writing again (`invokeBedrock`). The document still rides the replayed call,
 * because the retry is the attempt whose reply is posted, and so does the TEMPLATE the delivering step
 * declares: carried without it, that one delivery would go out unchecked against the template the first
 * attempt was held to. Resolved the way the advance resolved it, from the recorded choice or the default,
 * and a platform-filled template is rendered again from the record rather than taken from the model.
 * Nothing is declared for an edge that hands over no document.
 */
export function declarationForReplayedAdvance(args: {
  machine: TaskStateMachine | undefined;
  from: string;
  to: string;
  details: Record<string, unknown> | undefined;
  templates: TurnTemplates | undefined;
  /** The `document` argument of the replayed call, when it carried one. */
  document?: string;
  /** The step the move entered writes its own document (ADR-064 decision B): only a platform fill is declared. */
  writtenOnStep?: boolean;
}): { document?: string; template?: DeclaredTemplate } {
  const writtenOnStep = Boolean(args.writtenOnStep) && deliversDocument(args.machine?.states?.[args.to]);
  const document = writtenOnStep ? '' : typeof args.document === 'string' ? args.document.trim() : '';
  if (!edgeDelivers(args.machine, args.from, args.to)) return document ? { document } : {};
  const deliveringState = deliversDocument(args.machine?.states?.[args.to]) ? args.to : args.from;
  const t = templateForDelivery({ machine: args.machine, state: deliveringState, details: args.details, templates: args.templates });
  if (!('ok' in t) || !t.ok) return document ? { document } : {};
  if (t.loaded.template.fill === 'platform') {
    const filled = fillTemplate(t.loaded.template, args.details);
    return filled.ok
      ? { document: filled.document, template: { loaded: t.loaded, state: deliveringState, chosen: t.chosen, filled: true } }
      : {};
  }
  return document ? { document, template: { loaded: t.loaded, state: deliveringState, chosen: t.chosen } } : {};
}

/**
 * A STEP ACTION'S ARGUMENTS, BOUND TO WHAT THE TASK RECORDED (FR29), through the one binding reader the
 * template fill uses. A number or boolean is taken as written. Any argument that resolves to nothing is
 * named, and nothing runs.
 */
export function bindActionArgs(
  action: StepAction,
  details: Record<string, unknown> | undefined,
  /** The turn's resolver, which an argument bound to a variable source is inserted from (`actionVariableValues`). */
  variables?: TurnVariables,
): { ok: true; args: Record<string, string | number | boolean> } | { ok: false; arg: string; binding: string } {
  const args: Record<string, string | number | boolean> = {};
  const held = actionVariableValues(action, variables);
  for (const [param, raw] of Object.entries(action.args ?? {})) {
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      args[param] = raw;
      continue;
    }
    const parsed = parseBinding(raw);
    const value = parsed ? resolveBinding(parsed, details, held) : undefined;
    if (value === undefined) return { ok: false, arg: param, binding: String(raw) };
    args[param] = value;
  }
  return { ok: true, args };
}

/**
 * THE TOOLS A TURN IN THIS STEP MAY USE (SPEC-TASK-STATE-TRANSITIONS FR28): the turn's allowlist (the
 * profile's, already narrowed by the intent's, `toolsForIntent`) narrowed again by the step's declared
 * `tools`. Never a widening: a step naming a tool the turn does not allow does not get it, and `allowed`
 * undefined (an unconfigured profile, which allows every registered tool) becomes the step's own list.
 * The task tools are the workflow's mechanism rather than a capability, so they stay wherever the turn
 * allows them. Undefined in, undefined out when the step declares nothing.
 */
export function toolsForStep(
  allowed: string[] | undefined,
  def: TaskStateDef | undefined,
): string[] | undefined {
  if (!def?.tools) return allowed;
  const step = new Set(def.tools);
  const base = allowed ?? [...def.tools, ...TASK_TOOL_NAMES];
  return base.filter((t) => step.has(t) || TASK_TOOL_NAMES.has(t));
}

/**
 * Whether a tool call is allowed IN THE STATE THE TASK IS IN NOW, which a turn that advanced mid-loop may
 * have moved past the one its tools were offered for. The second layer under `toolsForStep`: a call
 * outside the step's declared tools is refused (`tool_not_in_step`) rather than run.
 */
export function toolAllowedInStep(name: string, def: TaskStateDef | undefined): boolean {
  if (!def?.tools || TASK_TOOL_NAMES.has(name)) return true;
  return def.tools.includes(name);
}

/** The refusal payload for a tool the current step does not declare, in the shape the loop records. */
export function toolNotInStepPayload(name: string, state: string, def: TaskStateDef | undefined): Record<string, unknown> {
  return {
    ok: false,
    error: 'tool_not_in_step',
    refusal: 'tool_not_in_step',
    message: `"${state}" does not use ${name}. This step's tools are: ${(def?.tools ?? []).join(', ') || 'none'}.`,
  };
}

/**
 * Handle a deliver_document call: the task stays where it is and the document is declared for the
 * delivery gate. Refused when the task's current state does not deliver, so the declaration cannot
 * package a document from a step the workflow never said produces one.
 */
export function handleDeliverDocumentTool(args: {
  task: Task;
  input: Record<string, unknown>;
  machines: Record<string, TaskStateMachine>;
  /** The templates the task's machine declares, loaded for this turn. */
  templates?: TurnTemplates;
}): { payload: Record<string, unknown>; document?: string; template?: DeclaredTemplate } {
  const state = args.task.taskState ?? '';
  const machine = args.machines[args.task.taskType ?? ''];
  const def = machine?.states?.[state];
  if (!deliversDocument(def)) {
    return {
      payload: {
        ok: false,
        error: 'not_a_delivering_step',
        // A refusal by the machine's declaration (the state does not deliver), not a failure.
        refusal: 'not_a_delivering_step',
        message: `"${state}" does not hand over a document. If the work is ready to deliver, move the `
          + `task with ${ADVANCE_TASK_STATE_TOOL_NAME} and pass the document there.`,
      },
    };
  }
  // A REWRITE FOLLOWS THE STEP'S TEMPLATE TOO, and a platform-filled one is re-rendered from the record
  // rather than taken from the model (SPEC-DOCUMENT-TEMPLATES FR5, FR9).
  const t = templateForDelivery({ machine, state, details: args.task.details, templates: args.templates });
  if ('ok' in t && !t.ok) {
    return { payload: { ok: false, error: t.error, refusal: t.error, message: t.message } };
  }
  let template: DeclaredTemplate | undefined;
  let document = typeof args.input.document === 'string' ? args.input.document.trim() : '';
  if ('ok' in t && t.ok) {
    if (t.loaded.template.fill === 'platform') {
      const filled = fillTemplate(t.loaded.template, args.task.details);
      if (!filled.ok) {
        return { payload: { ok: false, error: filled.error, refusal: filled.error, message: filled.message, field: filled.field } };
      }
      document = filled.document;
      template = { loaded: t.loaded, state, chosen: t.chosen, filled: true };
    } else {
      template = { loaded: t.loaded, state, chosen: t.chosen };
    }
  }
  if (!document) {
    return {
      payload: { ok: false, error: 'document_required', message: 'Pass the complete deliverable in `document`.' },
    };
  }
  return {
    payload: {
      ok: true,
      document_received: true,
      next: 'The document is declared and is delivered after you answer. Now write your reply to the '
        + 'person: briefly what changed. Do not repeat the document and do not mention files.',
    },
    document,
    ...(template ? { template } : {}),
  };
}

/**
 * Pure decision (SPEC-TASK-STATE-TRANSITIONS §5): does a work-item proposal emitted this turn drive
 * place_item's `collecting -> confirming` transition? The proposal (add_item etc.) IS the structured
 * signal that the task has gathered enough to propose a placement, so the advance couples to the
 * tool's SUCCESS — not to the `<!--proposal:-->` marker or a prose keyword. True only for a place_item
 * task currently in `collecting`.
 */
export function proposalAdvancesPlaceItem(ctx: TaskLoopContext | undefined): boolean {
  return Boolean(ctx && ctx.task.taskType === 'place_item' && ctx.task.taskState === 'collecting');
}

/**
 * Couple place_item's `collecting -> confirming` transition to a work-item proposal (§5). When a
 * proposal is emitted for a place_item task in `collecting`, advance via the SANCTIONED authorized
 * path (advanceTaskStateTo) and, on success, reflect the new state + record the transition on the
 * shared context — the same bookkeeping the in-loop advance_task_state dispatch does. No-op returning
 * null otherwise. The `<!--proposal:-->` marker still renders the widget confirm card; only its role
 * as the transition SIGNAL is retired.
 */
export async function advancePlaceItemOnProposal(
  ctx: TaskLoopContext | undefined,
): Promise<AdvanceResult | null> {
  if (!proposalAdvancesPlaceItem(ctx) || !ctx) return null;
  const result = await advanceTaskStateTo({
    task: ctx.task,
    toState: 'confirming',
    by: 'tool',
    reason: 'work-item proposal emitted',
    messageId: ctx.messageId,
    machines: ctx.machines,
  });
  if (result.ok) {
    ctx.task.taskState = result.to;
    (ctx.transitions ??= []).push({ from: result.from, to: result.to });
  }
  return result;
}
